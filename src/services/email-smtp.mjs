/**
 * email-smtp.mjs — SMTP send service
 *
 * Nodemailer-based. Fresh transporter per send (avoids stale connection issues).
 * Handles: plain send, reply/forward with threading headers, attachments.
 */

import { createTransport } from 'nodemailer';
import { randomUUID } from 'crypto';
import {
  getAccountCredentials, insertMessage, addMessageToLabel, getSystemLabel,
  ensureLabelsForAccount, insertAttachments, getDb,
} from './email-db.mjs';
import { createHash } from 'crypto';

function threadId(messageId) {
  if (!messageId) return createHash('sha1').update(randomUUID()).digest('hex');
  return createHash('sha1').update(messageId).digest('hex');
}

function getTransporter(creds) {
  const port = parseInt(creds.smtp_port, 10) || 587;
  const isSecure = port === 465;
  return createTransport({
    host: creds.smtp_host,
    port,
    secure: isSecure,
    auth: { user: creds.username, pass: creds.password },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    tls: { rejectUnauthorized: false },
  });
}

/**
 * Send an email.
 *
 * @param {string} accountId
 * @param {object} opts
 *   - to: string | string[]
 *   - cc: string | string[] (optional)
 *   - bcc: string | string[] (optional)
 *   - subject: string
 *   - bodyHtml: string
 *   - bodyText: string (optional, auto-generated from html if omitted)
 *   - inReplyTo: string (Message-ID of original, for replies)
 *   - references: string[] (for threading)
 *   - attachments: [{filename, content: Buffer|string, contentType}]
 *   - replyToMessageDbId: string (DB id of original message, for label assignment)
 */
export async function sendEmail(accountId, opts) {
  const creds = getAccountCredentials(accountId);
  if (!creds?.smtp_host) throw new Error('No SMTP credentials configured for this account');

  const msgId = `<${randomUUID()}@nha.local>`;
  const fromLine = creds.from_name ? `${creds.from_name} <${creds.email_address}>` : creds.email_address;

  const toList = toArray(opts.to);
  if (!toList.length) throw new Error('At least one recipient (To) is required');

  const mailOpts = {
    messageId: msgId,
    from: fromLine,
    to: toList.join(', '),
    subject: opts.subject || '',
    html: opts.bodyHtml || '',
    text: opts.bodyText || stripHtml(opts.bodyHtml || ''),
  };

  if (opts.cc?.length)         mailOpts.cc  = Array.isArray(opts.cc)  ? opts.cc.join(', ')  : opts.cc;
  if (opts.bcc?.length)        mailOpts.bcc = Array.isArray(opts.bcc) ? opts.bcc.join(', ') : opts.bcc;
  if (opts.inReplyTo)          mailOpts['In-Reply-To'] = opts.inReplyTo;
  if (opts.references?.length) mailOpts['References']  = opts.references.join(' ');

  if (opts.attachments?.length) {
    mailOpts.attachments = opts.attachments.map(a => ({
      filename: a.filename,
      content:  a.content,
      contentType: a.contentType || 'application/octet-stream',
    }));
  }

  const transporter = getTransporter(creds);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await transporter.sendMail(mailOpts);
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (lastError) throw lastError;

  // ── Save to local DB as "sent" ────────────────────────────────────────
  const now = new Date().toISOString();
  const tid = threadId(opts.inReplyTo || msgId);
  // Ensure system labels exist for this account (first send may precede first sync)
  ensureLabelsForAccount(accountId);
  const sentLabel = getSystemLabel(accountId, 'sent');

  const dbId = insertMessage({
    account_id: accountId,
    imap_folder_path: 'Sent',
    uid: Date.now(), // synthetic UID for sent messages
    message_id: msgId,
    in_reply_to: opts.inReplyTo || null,
    references_list: opts.references || [],
    thread_id: tid,
    subject: opts.subject || '',
    from_address: creds.email_address,
    from_name: creds.from_name || null,
    to_addresses: toArray(opts.to).map(a => ({ address: a, name: '' })),
    cc_addresses: toArray(opts.cc).map(a => ({ address: a, name: '' })),
    bcc_addresses: toArray(opts.bcc).map(a => ({ address: a, name: '' })),
    body_html: opts.bodyHtml || null,
    body_text: opts.bodyText || null,
    body_preview: (opts.bodyText || stripHtml(opts.bodyHtml || '')).slice(0, 255),
    size_bytes: (opts.bodyHtml || '').length,
    has_attachments: (opts.attachments?.length || 0) > 0,
    internal_date: now,
    source: 'sent',
  });

  if (sentLabel) addMessageToLabel(dbId, sentLabel.id);

  return { messageId: msgId, dbId };
}

function toArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : x.address || x.email || '').filter(Boolean);
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
