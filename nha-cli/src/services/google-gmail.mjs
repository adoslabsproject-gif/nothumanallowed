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
  cacheMessages(messages);
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
  if (raw.payload?.body?.data) {
    body = Buffer.from(raw.payload.body.data, 'base64url').toString('utf-8');
  } else if (raw.payload?.parts) {
    const textPart = raw.payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }
  }

  // Extract URLs from body
  const urls = (body.match(/https?:\/\/[^\s<>"']+/g) || []).slice(0, 10);

  return {
    id: raw.id,
    threadId: raw.threadId,
    from: headers.from || '',
    to: headers.to || '',
    subject: headers.subject || '(no subject)',
    date: headers.date || '',
    snippet: raw.snippet || '',
    body: body.slice(0, 5000), // cap for LLM context
    urls,
    labels: raw.labelIds || [],
    isUnread: (raw.labelIds || []).includes('UNREAD'),
    isImportant: (raw.labelIds || []).includes('IMPORTANT'),
    sizeEstimate: raw.sizeEstimate || 0,
  };
}

// ── Local Cache ────────────────────────────────────────────────────────────

function cacheMessages(messages) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  for (const msg of messages) {
    const file = path.join(INBOX_DIR, `${msg.id}.json`);
    fs.writeFileSync(file, JSON.stringify(msg, null, 2), { mode: 0o600 });
  }
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
