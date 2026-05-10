/**
 * Gmail API wrapper — zero dependencies.
 * All calls via native fetch to Gmail REST API.
 * Auto-refreshes tokens on 401.
 */

import fs from 'fs';
import path from 'path';
import { getAccessToken } from './token-store.mjs';
import { NHA_DIR } from '../constants.mjs';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAIL_DIR = path.join(NHA_DIR, 'ops', 'mail');
const INBOX_DIR = path.join(MAIL_DIR, 'inbox');

/** Authenticated fetch with auto-retry on 401 */
async function gmailFetch(config, urlPath, options = {}) {
  const token = await getAccessToken(config);
  const url = urlPath.startsWith('http') ? urlPath : `${GMAIL_BASE}${urlPath}`;

  let res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
    },
  });

  // Retry once on 401 (token may have expired between check and request)
  if (res.status === 401) {
    const newToken = await getAccessToken(config);
    res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${newToken}`,
      },
    });
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API ${res.status}: ${err}`);
  }

  // Some Gmail API calls return 204 No Content (e.g., batchModify)
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * List messages matching a query.
 * @param {object} config
 * @param {string} query — Gmail search query (e.g., "is:unread", "from:boss@company.com")
 * @param {number} maxResults — max messages (default 20)
 * @returns {Promise<Array<{id: string, threadId: string}>>}
 */
export async function listMessages(config, query = 'is:unread', maxResults = 20) {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const data = await gmailFetch(config, `/messages?${params}`);
  return data.messages || [];
}

/**
 * Get a full message by ID.
 * @param {object} config
 * @param {string} messageId
 * @returns {Promise<object>} parsed message with headers, body, snippet
 */
export async function getMessage(config, messageId) {
  const data = await gmailFetch(config, `/messages/${messageId}?format=full`);
  return parseMessage(data);
}

/**
 * Get unread important emails (for daily planner).
 * @param {object} config
 * @param {number} maxResults
 * @returns {Promise<Array>} parsed messages
 */
export async function getUnreadImportant(config, maxResults = 30) {
  const messageRefs = await listMessages(config, 'is:unread -category:promotions -category:social', maxResults);
  const messages = [];

  for (const ref of messageRefs.slice(0, maxResults)) {
    try {
      const msg = await getMessage(config, ref.id);
      messages.push(msg);
    } catch { /* skip failed messages */ }
  }

  // Cache messages locally
  await cacheMessages(messages);
  return messages;
}

/**
 * Get ALL emails from a folder (read + unread) for local-first architecture.
 * This replaces getUnreadImportant to ensure ALL emails are downloaded locally.
 */
export async function getAllEmails(config, folder = 'INBOX', maxResults = 200, search = '') {
  // Map folder names to Gmail queries
  const folderQueries = {
    'INBOX': 'in:inbox',
    'SENT': 'in:sent',
    'DRAFTS': 'in:drafts',
    'SPAM': 'in:spam',
    'TRASH': 'in:trash',
    'STARRED': 'is:starred',
    'IMPORTANT': 'is:important'
  };

  let query = folderQueries[folder.toUpperCase()] || `in:${folder.toLowerCase()}`;
  if (search) query += ` ${search}`;
  const messageRefs = await listMessages(config, query, maxResults);
  const messages = [];

  for (const ref of messageRefs.slice(0, maxResults)) {
    try {
      const msg = await getMessage(config, ref.id);
      messages.push(msg);
    } catch { /* skip failed messages */ }
  }

  // Cache messages locally - this ensures local-first access
  await cacheMessages(messages, folder);
  return messages;
}

/**
 * Get emails from today (read + unread).
 */
export async function getTodayEmails(config, maxResults = 50) {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '/');
  const messageRefs = await listMessages(config, `after:${today}`, maxResults);
  const messages = [];

  for (const ref of messageRefs.slice(0, maxResults)) {
    try {
      const msg = await getMessage(config, ref.id);
      messages.push(msg);
    } catch {}
  }

  cacheMessages(messages);
  return messages;
}

/**
 * Send an email.
 * @param {object} config
 * @param {string} to
 * @param {string} subject
 * @param {string} body — plain text
 * @param {object} opts — { cc, bcc, replyToMessageId, threadId }
 */
export async function sendEmail(config, to, subject, body, opts = {}) {
  // If attachments are provided, build multipart MIME
  if (opts.attachments && opts.attachments.length > 0) {
    const raw = buildMultipartMime(to, subject, body, opts);
    const reqBody = { raw };
    if (opts.threadId) reqBody.threadId = opts.threadId;

    return gmailFetch(config, '/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
  }

  // Simple text email (no attachments)
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
  ];
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  if (opts.replyToMessageId) lines.push(`In-Reply-To: ${opts.replyToMessageId}`);
  lines.push('', body);

  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
  const reqBody = { raw };
  if (opts.threadId) reqBody.threadId = opts.threadId;

  return gmailFetch(config, '/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
}

/**
 * Build a multipart/mixed MIME message with attachments.
 * @param {string} to
 * @param {string} subject
 * @param {string} body
 * @param {object} opts — { cc, bcc, replyToMessageId, attachments: [{name, mimeType, base64}] }
 * @returns {string} base64url-encoded MIME message
 */
function buildMultipartMime(to, subject, body, opts) {
  const boundary = '----NHABoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const lines = [];

  lines.push(`To: ${to}`);
  lines.push(`Subject: ${subject}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  if (opts.replyToMessageId) lines.push(`In-Reply-To: ${opts.replyToMessageId}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');

  // Text body part
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(body);
  lines.push('');

  // Attachment parts
  for (const att of opts.attachments) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.mimeType}; name="${att.name}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${att.name}"`);
    lines.push('');
    // Split base64 into 76-char lines per RFC 2045
    const b64 = att.base64;
    for (let i = 0; i < b64.length; i += 76) {
      lines.push(b64.slice(i, i + 76));
    }
    lines.push('');
  }

  lines.push(`--${boundary}--`);

  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

/**
 * Create a draft.
 */
export async function createDraft(config, to, subject, body) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body,
  ];
  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

  return gmailFetch(config, '/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw } }),
  });
}

/**
 * Get user's email profile.
 */
export async function getProfile(config) {
  return gmailFetch(config, '/profile');
}

/**
 * Get labels.
 */
export async function listLabels(config) {
  const data = await gmailFetch(config, '/labels');
  return data.labels || [];
}

/**
 * Modify labels on a message (add/remove).
 */
export async function modifyMessage(config, messageId, addLabels = [], removeLabels = []) {
  return gmailFetch(config, `/messages/${messageId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds: addLabels, removeLabelIds: removeLabels }),
  });
}

/**
 * Mark a single message as read.
 */
export async function markAsRead(config, messageId) {
  return modifyMessage(config, messageId, [], ['UNREAD']);
}

/**
 * Mark a single message as unread.
 */
export async function markAsUnread(config, messageId) {
  return modifyMessage(config, messageId, ['UNREAD'], []);
}

/**
 * Archive a message (remove INBOX label).
 */
export async function archiveMessage(config, messageId) {
  return modifyMessage(config, messageId, [], ['INBOX']);
}

/**
 * Batch modify multiple messages (mark all as read, archive all, etc.)
 */
export async function batchModify(config, messageIds, addLabels = [], removeLabels = []) {
  return gmailFetch(config, '/messages/batchModify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: messageIds, addLabelIds: addLabels, removeLabelIds: removeLabels }),
  });
}

/**
 * Mark ALL unread messages as read.
 */
export async function markAllAsRead(config) {
  const unread = await listMessages(config, 'is:unread', 500);
  if (unread.length === 0) return { count: 0 };
  const ids = unread.map(m => m.id);
  await batchModify(config, ids, [], ['UNREAD']);
  return { count: ids.length };
}

/**
 * Trash a message (move to Trash — recoverable for 30 days).
 */
export async function trashMessage(config, messageId) {
  return gmailFetch(config, `/messages/${messageId}/trash`, { method: 'POST' });
}

/**
 * Permanently delete a message (irreversible).
 */
export async function deleteMessage(config, messageId) {
  return gmailFetch(config, `/messages/${messageId}`, { method: 'DELETE' });
}

// ── Message Parser ─────────────────────────────────────────────────────────

function parseMessage(raw) {
  const headers = {};
  for (const h of raw.payload?.headers || []) {
    headers[h.name.toLowerCase()] = h.value;
  }

  let body = '';
  let bodyHtml = '';

  // Recursive function to find parts in nested multipart structures
  function findParts(parts) {
    if (!parts) return;
    for (const p of parts) {
      if (p.mimeType === 'text/plain' && p.body?.data && !body) {
        body = Buffer.from(p.body.data, 'base64url').toString('utf-8');
      } else if (p.mimeType === 'text/html' && p.body?.data && !bodyHtml) {
        bodyHtml = Buffer.from(p.body.data, 'base64url').toString('utf-8');
      } else if (p.parts) {
        findParts(p.parts);
      }
    }
  }

  if (raw.payload?.body?.data) {
    // Single-part message
    const content = Buffer.from(raw.payload.body.data, 'base64url').toString('utf-8');
    if (raw.payload.mimeType === 'text/html') bodyHtml = content;
    else body = content;
  } else if (raw.payload?.parts) {
    findParts(raw.payload.parts);
  }

  // Extract URLs from body
  const textContent = body || bodyHtml.replace(/<[^>]+>/g, '');
  const urls = (textContent.match(/https?:\/\/[^\s<>"']+/g) || []).slice(0, 10);

  return {
    id: raw.id,
    threadId: raw.threadId,
    from: headers.from || '',
    to: headers.to || '',
    subject: headers.subject || '(no subject)',
    date: headers.date || '',
    snippet: raw.snippet || '',
    body: body.slice(0, 5000),
    bodyHtml,
    urls,
    labels: raw.labelIds || [],
    isUnread: (raw.labelIds || []).includes('UNREAD'),
    isImportant: (raw.labelIds || []).includes('IMPORTANT'),
    sizeEstimate: raw.sizeEstimate || 0,
  };
}

// ── Local Cache ────────────────────────────────────────────────────────────

async function cacheMessages(messages, folder = 'INBOX') {
  // Cache as JSON files (legacy ops system)
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  for (const msg of messages) {
    const file = path.join(INBOX_DIR, `${msg.id}.json`);
    fs.writeFileSync(file, JSON.stringify(msg, null, 2), { mode: 0o600 });
  }

  // ENTERPRISE LOCAL-FIRST: Also save to SQLite database for Web UI offline access
  try {
    if (!messages.length) return;

    const { SQLITE_AVAILABLE, getDb, ensureGoogleAccount, upsertFolder } = await import('./email-db.mjs');
    if (!SQLITE_AVAILABLE) return;

    const db = getDb();

    // Determine the user's own email from config (reliable source)
    let accountEmail = 'gmail@account';
    try {
      const os = await import('os');
      const cfgPath = path.join(os.default.homedir(), '.nha', 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        accountEmail = cfg.google?.email || cfg.email || accountEmail;
      }
    } catch {}
    // Fallback: extract from 'to' field of first inbox message
    if (accountEmail === 'gmail@account' && messages[0]) {
      accountEmail = extractEmail(messages[0].to) || accountEmail;
    }

    // Ensure Google account exists — use transaction for atomicity
    const googleAccount = ensureGoogleAccount({
      id: 'google',
      display_name: 'Gmail',
      email_address: accountEmail,
      imap_host: 'gmail.googleapis.com',
      imap_port: 993,
      is_active: 1
    });
    if (!googleAccount) return;

    // Map folder to type and display name
    const folderMap = {
      'INBOX': { name: 'Inbox', type: 'inbox' },
      'SENT': { name: 'Sent', type: 'sent' },
      'DRAFTS': { name: 'Drafts', type: 'drafts' },
      'SPAM': { name: 'Spam', type: 'spam' },
      'TRASH': { name: 'Trash', type: 'trash' },
      'STARRED': { name: 'Starred', type: 'starred' },
      'IMPORTANT': { name: 'Important', type: 'important' },
    };
    const folderKey = folder.toUpperCase();
    const folderInfo = folderMap[folderKey] || { name: folder, type: 'custom' };
    const folderId = upsertFolder(googleAccount.id, folderKey, folderInfo.name, folderInfo.type, 1, 0);
    if (!folderId) return;

    // Batch insert all messages in a single transaction (fast + atomic)
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO email_messages
        (id, account_id, folder_id, imap_folder_path, uid, message_id, thread_id,
         subject, from_address, from_name, to_addresses, body_text, body_html, body_preview,
         internal_date, has_attachments, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const stateStmt = db.prepare(`
      INSERT OR REPLACE INTO email_message_state (message_id, is_read, is_starred)
      VALUES (?, ?, ?)
    `);

    const insertAll = db.transaction((msgs) => {
      for (const msg of msgs) {
        const msgId = msg.id;
        insertStmt.run(
          msgId, googleAccount.id, folderId, folderKey,
          Date.now() + Math.random() * 1000 | 0,
          msg.id, msg.threadId || msg.id,
          msg.subject || '(no subject)',
          extractEmail(msg.from), extractName(msg.from),
          msg.to || '',
          msg.body || '', msg.bodyHtml || '', msg.snippet || '',
          new Date(msg.date || Date.now()).toISOString(),
          0, 'gmail_api'
        );
        stateStmt.run(msgId, msg.isUnread ? 0 : 1, msg.isImportant ? 1 : 0);
      }
    });

    insertAll(messages);
  } catch (e) {
    console.warn('[GMAIL CACHE] Failed to save to IMAP database:', e.message);
  }
}

// Helper functions for email parsing
function extractName(emailField) {
  if (!emailField) return '';
  const match = emailField.match(/^(.+?)\s*<.+>$/);
  return match ? match[1].trim().replace(/['"]/g, '') : '';
}

function extractEmail(emailField) {
  if (!emailField) return '';
  const match = emailField.match(/<(.+?)>$/);
  return match ? match[1] : emailField;
}

/**
 * Load cached messages from disk.
 * @returns {Array} cached messages
 */
export function loadCachedMessages() {
  if (!fs.existsSync(INBOX_DIR)) return [];
  return fs.readdirSync(INBOX_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(INBOX_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
}
