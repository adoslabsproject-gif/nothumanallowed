/**
 * Multi-provider IMAP/SMTP email service.
 *
 * - Read-only IMAP: downloads messages, marks as seen on local DB only.
 *   NEVER deletes, moves, or modifies messages on the remote server.
 * - SMTP send: each account has its own SMTP config.
 * - Multiple accounts supported, each independent.
 * - Zero npm dependencies: uses Node.js 22 native net/tls + custom IMAP/SMTP.
 *
 * Config: ~/.nha/config.json → emailAccounts[]
 */

import net from 'net';
import tls from 'tls';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { NHA_DIR } from '../constants.mjs';

const EMAIL_DB_DIR = path.join(NHA_DIR, 'email-cache');

// ── IMAP Client (read-only, POP3-like behavior) ────────────────────────

class IMAPClient {
  constructor(host, port, user, pass, useTLS = true) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.useTLS = useTLS;
    this.socket = null;
    this.tagCounter = 0;
    this.buffer = '';
  }

  /** Connect and authenticate */
  async connect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('IMAP connection timeout')), 15000);

      const onConnect = () => {
        clearTimeout(timeout);
        this._readResponse().then(() => {
          return this._command(`LOGIN "${this.user}" "${this.pass}"`);
        }).then(res => {
          if (res.includes('OK')) resolve();
          else reject(new Error('IMAP login failed'));
        }).catch(reject);
      };

      if (this.useTLS) {
        this.socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: true }, onConnect);
      } else {
        this.socket = net.connect({ host: this.host, port: this.port }, onConnect);
      }

      this.socket.setEncoding('utf-8');
      this.socket.on('error', (e) => { clearTimeout(timeout); reject(e); });
    });
  }

  /** Send IMAP command and get response */
  async _command(cmd) {
    const tag = `A${++this.tagCounter}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('IMAP command timeout')), 30000);
      let response = '';

      const onData = (chunk) => {
        response += chunk;
        // Check if we have the tagged response line
        if (response.includes(`${tag} OK`) || response.includes(`${tag} NO`) || response.includes(`${tag} BAD`)) {
          clearTimeout(timeout);
          this.socket.removeListener('data', onData);
          resolve(response);
        }
      };

      this.socket.on('data', onData);
      this.socket.write(`${tag} ${cmd}\r\n`);
    });
  }

  /** Read server greeting */
  async _readResponse() {
    return new Promise((resolve) => {
      const onData = (chunk) => {
        this.buffer += chunk;
        if (this.buffer.includes('\r\n')) {
          this.socket.removeListener('data', onData);
          resolve(this.buffer);
          this.buffer = '';
        }
      };
      this.socket.on('data', onData);
    });
  }

  /** List recent messages (headers only). NEVER modifies server state. */
  async listMessages(folder = 'INBOX', limit = 20) {
    await this._command(`SELECT "${folder}"`);

    // Get message count from SELECT response
    const searchRes = await this._command('SEARCH ALL');
    const ids = searchRes.match(/\* SEARCH ([\d\s]+)/)?.[1]?.trim().split(/\s+/) || [];
    const recent = ids.slice(-limit);

    if (recent.length === 0) return [];

    const messages = [];
    for (const id of recent) {
      try {
        const headerRes = await this._command(`FETCH ${id} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])`);

        const from = headerRes.match(/From:\s*(.+)/i)?.[1]?.trim() || '';
        const to = headerRes.match(/To:\s*(.+)/i)?.[1]?.trim() || '';
        const subject = headerRes.match(/Subject:\s*(.+)/i)?.[1]?.trim() || '';
        const date = headerRes.match(/Date:\s*(.+)/i)?.[1]?.trim() || '';
        const messageId = headerRes.match(/Message-ID:\s*(.+)/i)?.[1]?.trim() || id;
        const seen = headerRes.includes('\\Seen');

        messages.push({ id, messageId, from, to, subject, date, seen });
      } catch { /* skip unparseable messages */ }
    }

    return messages.reverse(); // newest first
  }

  /** Read full message body. Uses BODY.PEEK to NOT mark as read on server. */
  async readMessage(id) {
    const res = await this._command(`FETCH ${id} BODY.PEEK[]`);

    // Parse basic MIME — extract text/plain or text/html part
    const body = res.replace(/^\* \d+ FETCH.*?\r\n/m, '').replace(/\)\r\nA\d+ OK.*$/s, '');

    // Try to extract text/plain content
    const plainMatch = body.match(/Content-Type:\s*text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)(?:\r\n--|\r\nA\d+)/i);
    if (plainMatch) return decodeBody(plainMatch[1]);

    // Fallback: strip HTML tags
    const htmlMatch = body.match(/Content-Type:\s*text\/html[\s\S]*?\r\n\r\n([\s\S]*?)(?:\r\n--|\r\nA\d+)/i);
    if (htmlMatch) return stripHtml(decodeBody(htmlMatch[1]));

    // Last resort: return raw (first 5000 chars)
    return body.slice(0, 5000);
  }

  async disconnect() {
    try {
      await this._command('LOGOUT');
    } catch {} finally {
      this.socket?.destroy();
    }
  }
}

// ── SMTP Client ─────────────────────────────────────────────────────────

class SMTPClient {
  constructor(host, port, user, pass, useTLS = true) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.useTLS = useTLS;
    this.socket = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SMTP connection timeout')), 15000);

      const afterConnect = async () => {
        clearTimeout(timeout);
        try {
          await this._readLine(); // greeting

          // EHLO
          await this._send(`EHLO nha-client`);
          const ehloRes = await this._readMultiLine();

          // STARTTLS if port 587 and not already TLS
          if (this.port === 587 && !this.useTLS && ehloRes.includes('STARTTLS')) {
            await this._send('STARTTLS');
            await this._readLine();
            // Upgrade to TLS
            this.socket = await this._upgradeTLS();
            await this._send(`EHLO nha-client`);
            await this._readMultiLine();
          }

          // AUTH LOGIN
          await this._send('AUTH LOGIN');
          const authRes = await this._readLine();
          if (!authRes.startsWith('334')) throw new Error('SMTP AUTH not supported');

          await this._send(Buffer.from(this.user).toString('base64'));
          await this._readLine();

          await this._send(Buffer.from(this.pass).toString('base64'));
          const loginRes = await this._readLine();
          if (!loginRes.startsWith('235')) throw new Error('SMTP login failed');

          resolve();
        } catch (e) { reject(e); }
      };

      if (this.useTLS || this.port === 465) {
        this.socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: true }, afterConnect);
      } else {
        this.socket = net.connect({ host: this.host, port: this.port }, afterConnect);
      }

      this.socket.setEncoding('utf-8');
      this.socket.on('error', (e) => { clearTimeout(timeout); reject(e); });
    });
  }

  async _send(data) {
    return new Promise((resolve, reject) => {
      this.socket.write(data + '\r\n', (err) => err ? reject(err) : resolve());
    });
  }

  async _readLine() {
    return new Promise((resolve) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk;
        if (buf.includes('\r\n')) {
          this.socket.removeListener('data', onData);
          resolve(buf.trim());
        }
      };
      this.socket.on('data', onData);
    });
  }

  async _readMultiLine() {
    return new Promise((resolve) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk;
        // Multi-line ends with a line that has space after status code (e.g., "250 OK")
        const lines = buf.split('\r\n');
        const lastLine = lines.filter(l => l.length > 0).pop() || '';
        if (lastLine.match(/^\d{3} /)) {
          this.socket.removeListener('data', onData);
          resolve(buf.trim());
        }
      };
      this.socket.on('data', onData);
    });
  }

  async _upgradeTLS() {
    return new Promise((resolve, reject) => {
      const upgraded = tls.connect({ socket: this.socket, host: this.host, rejectUnauthorized: true }, () => {
        this.socket = upgraded;
        resolve(upgraded);
      });
      upgraded.on('error', reject);
    });
  }

  /** Send email */
  async send(from, to, subject, body, cc = '', bcc = '') {
    // MAIL FROM
    await this._send(`MAIL FROM:<${from}>`);
    const fromRes = await this._readLine();
    if (!fromRes.startsWith('250')) throw new Error(`MAIL FROM rejected: ${fromRes}`);

    // RCPT TO (multiple recipients)
    const recipients = [to, ...cc.split(','), ...bcc.split(',')].filter(Boolean).map(e => e.trim());
    for (const rcpt of recipients) {
      const addr = rcpt.match(/<([^>]+)>/)?.[1] || rcpt;
      await this._send(`RCPT TO:<${addr}>`);
      const rcptRes = await this._readLine();
      if (!rcptRes.startsWith('250')) throw new Error(`RCPT TO rejected for ${addr}: ${rcptRes}`);
    }

    // DATA
    await this._send('DATA');
    const dataRes = await this._readLine();
    if (!dataRes.startsWith('354')) throw new Error(`DATA rejected: ${dataRes}`);

    // Headers + body
    const msgId = `<${crypto.randomUUID()}@nha>`;
    const date = new Date().toUTCString();
    let msg = `From: ${from}\r\n`;
    msg += `To: ${to}\r\n`;
    if (cc) msg += `Cc: ${cc}\r\n`;
    msg += `Subject: ${subject}\r\n`;
    msg += `Date: ${date}\r\n`;
    msg += `Message-ID: ${msgId}\r\n`;
    msg += `MIME-Version: 1.0\r\n`;
    msg += `Content-Type: text/plain; charset=UTF-8\r\n`;
    msg += `Content-Transfer-Encoding: 8bit\r\n`;
    msg += `X-Mailer: NHA/2.0\r\n`;
    msg += `\r\n${body}\r\n.\r\n`;

    await this._send(msg);
    const sendRes = await this._readLine();
    if (!sendRes.startsWith('250')) throw new Error(`Send failed: ${sendRes}`);

    return { messageId: msgId, success: true };
  }

  async disconnect() {
    try {
      await this._send('QUIT');
      await this._readLine();
    } catch {} finally {
      this.socket?.destroy();
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function decodeBody(text) {
  // Handle quoted-printable
  return text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * List messages from an IMAP account. Read-only, never modifies server.
 * @param {object} account - { imap: { host, port, user, pass, tls }, label }
 * @param {number} limit
 * @returns {Array<{ id, from, to, subject, date, seen }>}
 */
export async function listImapMessages(account, limit = 20) {
  const { host, port, user, pass, tls: useTLS } = account.imap;
  const client = new IMAPClient(host, port || 993, user, pass, useTLS !== false);
  try {
    await client.connect();
    return await client.listMessages('INBOX', limit);
  } finally {
    await client.disconnect();
  }
}

/**
 * Read a single message. Uses BODY.PEEK — does NOT mark as read on server.
 * @param {object} account
 * @param {string} messageId
 * @returns {string} message body text
 */
export async function readImapMessage(account, messageId) {
  const { host, port, user, pass, tls: useTLS } = account.imap;
  const client = new IMAPClient(host, port || 993, user, pass, useTLS !== false);
  try {
    await client.connect();
    await client._command('SELECT "INBOX"');
    return await client.readMessage(messageId);
  } finally {
    await client.disconnect();
  }
}

/**
 * Send email via SMTP.
 * @param {object} account - { smtp: { host, port, user, pass, tls }, address }
 * @param {string} to
 * @param {string} subject
 * @param {string} body
 * @param {string} cc
 * @param {string} bcc
 */
export async function sendSmtpEmail(account, to, subject, body, cc = '', bcc = '') {
  const { host, port, user, pass, tls: useTLS } = account.smtp;
  const from = account.address || user;
  const client = new SMTPClient(host, port || 587, user, pass, useTLS === true || port === 465);
  try {
    await client.connect();
    return await client.send(from, to, subject, body, cc, bcc);
  } finally {
    await client.disconnect();
  }
}

/**
 * Get all configured email accounts from config.
 * @param {object} config - NHA config
 * @returns {Array<{ label, address, imap, smtp }>}
 */
export function getEmailAccounts(config) {
  return config.emailAccounts || [];
}

/**
 * List messages across ALL configured IMAP accounts.
 * @param {object} config
 * @param {number} limit - per account
 * @returns {Array<{ account, messages[] }>}
 */
export async function listAllInboxes(config, limit = 10) {
  const accounts = getEmailAccounts(config);
  const results = [];

  for (const account of accounts) {
    if (!account.imap) continue;
    try {
      const messages = await listImapMessages(account, limit);
      results.push({ account: account.label || account.address, messages });
    } catch (e) {
      results.push({ account: account.label || account.address, error: e.message, messages: [] });
    }
  }

  return results;
}
