/**
 * Outlook Mail API wrapper via Microsoft Graph — zero dependencies.
 * All calls via native fetch to Microsoft Graph REST API.
 * Auto-refreshes tokens on 401.
 *
 * Output format matches google-gmail.mjs parsed shape for unified consumption.
 */

import fs from 'fs';
import path from 'path';
import { getMicrosoftAccessToken } from './microsoft-oauth.mjs';
import { NHA_DIR } from '../constants.mjs';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me';
const MAIL_DIR = path.join(NHA_DIR, 'ops', 'mail');
const INBOX_DIR = path.join(MAIL_DIR, 'inbox');

/** Authenticated fetch with auto-retry on 401 */
async function graphFetch(config, urlPath, options = {}) {
  const token = await getMicrosoftAccessToken(config);
  const url = urlPath.startsWith('http') ? urlPath : `${GRAPH_BASE}${urlPath}`;

  let res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
    },
  });

  // Retry once on 401 (token may have expired between check and request)
  if (res.status === 401) {
    const newToken = await getMicrosoftAccessToken(config);
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
    throw new Error(`Microsoft Graph API ${res.status}: ${err}`);
  }

  return res.json();
}

/**
 * List messages matching a query.
 * @param {object} config
 * @param {string} query — Microsoft Graph $search or $filter compatible string.
 *   Supports natural language search (e.g., "from:boss@company.com subject:report").
 * @param {number} maxResults — max messages (default 20)
 * @returns {Promise<Array<object>>} parsed messages
 */
export async function listMessages(config, query = '', maxResults = 20) {
  const params = new URLSearchParams({
    '$top': String(maxResults),
    '$orderby': 'receivedDateTime desc',
    '$select': 'id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,body,isRead,importance,flag,webLink,hasAttachments',
  });

  // Microsoft Graph $search uses KQL (Keyword Query Language)
  if (query) {
    params.set('$search', `"${query}"`);
  }

  const data = await graphFetch(config, `/messages?${params}`);
  return (data.value || []).map(parseMessage);
}

/**
 * Get a full message by ID.
 * @param {object} config
 * @param {string} messageId
 * @returns {Promise<object>} parsed message
 */
export async function getMessage(config, messageId) {
  const data = await graphFetch(config, `/messages/${messageId}`);
  return parseMessage(data);
}

/**
 * Get unread important emails (for daily planner).
 * @param {object} config
 * @param {number} maxResults
 * @returns {Promise<Array>} parsed messages
 */
export async function getUnreadImportant(config, maxResults = 30) {
  const params = new URLSearchParams({
    '$top': String(maxResults),
    '$orderby': 'receivedDateTime desc',
    '$filter': 'isRead eq false',
    '$select': 'id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,body,isRead,importance,flag,webLink,hasAttachments',
  });

  const data = await graphFetch(config, `/messages?${params}`);
  const messages = (data.value || []).map(parseMessage);

  // Cache messages locally
  cacheMessages(messages);
  return messages;
}

/**
 * Get emails from today (read + unread).
 */
export async function getTodayEmails(config, maxResults = 50) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  const params = new URLSearchParams({
    '$top': String(maxResults),
    '$orderby': 'receivedDateTime desc',
    '$filter': `receivedDateTime ge ${todayISO}`,
    '$select': 'id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,body,isRead,importance,flag,webLink,hasAttachments',
  });

  const data = await graphFetch(config, `/messages?${params}`);
  const messages = (data.value || []).map(parseMessage);

  cacheMessages(messages);
  return messages;
}

/**
 * Send an email via Microsoft Graph.
 * @param {object} config
 * @param {string} to — recipient email
 * @param {string} subject
 * @param {string} body — plain text body
 * @param {object} opts — { cc, bcc, replyToMessageId, threadId }
 */
export async function sendEmail(config, to, subject, body, opts = {}) {
  if (opts.replyToMessageId) {
    // Reply to existing message
    const replyBody = {
      message: {
        toRecipients: [{ emailAddress: { address: to } }],
      },
      comment: body,
    };
    return graphFetch(config, `/messages/${opts.replyToMessageId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(replyBody),
    });
  }

  const message = {
    message: {
      subject,
      body: {
        contentType: 'Text',
        content: body,
      },
      toRecipients: to.split(',').map(addr => ({
        emailAddress: { address: addr.trim() },
      })),
    },
    saveToSentItems: true,
  };

  if (opts.cc) {
    message.message.ccRecipients = opts.cc.split(',').map(addr => ({
      emailAddress: { address: addr.trim() },
    }));
  }

  if (opts.bcc) {
    message.message.bccRecipients = opts.bcc.split(',').map(addr => ({
      emailAddress: { address: addr.trim() },
    }));
  }

  return graphFetch(config, '/sendMail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
}

/**
 * Create a draft email.
 */
export async function createDraft(config, to, subject, body) {
  const draft = {
    subject,
    body: {
      contentType: 'Text',
      content: body,
    },
    toRecipients: to.split(',').map(addr => ({
      emailAddress: { address: addr.trim() },
    })),
  };

  return graphFetch(config, '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
}

/**
 * Get user's email profile.
 */
export async function getProfile(config) {
  const data = await graphFetch(config, '');
  return {
    emailAddress: data.mail || data.userPrincipalName || '',
    displayName: data.displayName || '',
    id: data.id || '',
  };
}

// ── Message Parser ─────────────────────────────────────────────────────────

/**
 * Parse Microsoft Graph message to unified format matching Gmail parser output.
 */
function parseMessage(raw) {
  const from = raw.from?.emailAddress
    ? `${raw.from.emailAddress.name || ''} <${raw.from.emailAddress.address}>`
    : '';

  const to = (raw.toRecipients || [])
    .map(r => `${r.emailAddress?.name || ''} <${r.emailAddress?.address}>`)
    .join(', ');

  // Extract plain text body (Graph returns HTML by default)
  let body = '';
  if (raw.body?.content) {
    if (raw.body.contentType === 'text') {
      body = raw.body.content;
    } else {
      // Strip HTML tags for plain text representation
      body = raw.body.content
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // Extract URLs from body
  const urls = (body.match(/https?:\/\/[^\s<>"']+/g) || []).slice(0, 10);

  // Map Microsoft importance to labels
  const labels = [];
  if (!raw.isRead) labels.push('UNREAD');
  if (raw.importance === 'high') labels.push('IMPORTANT');
  if (raw.flag?.flagStatus === 'flagged') labels.push('FLAGGED');

  return {
    id: raw.id,
    threadId: raw.conversationId || raw.id,
    from,
    to,
    subject: raw.subject || '(no subject)',
    date: raw.receivedDateTime || '',
    snippet: (raw.bodyPreview || '').slice(0, 200),
    body: body.slice(0, 5000), // cap for LLM context
    urls,
    labels,
    isUnread: !raw.isRead,
    isImportant: raw.importance === 'high',
    sizeEstimate: 0, // Graph API doesn't expose this directly
    provider: 'microsoft',
  };
}

// ── Local Cache ────────────────────────────────────────────────────────────

function cacheMessages(messages) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  for (const msg of messages) {
    const safeId = msg.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
    const file = path.join(INBOX_DIR, `ms_${safeId}.json`);
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
    .filter(f => f.startsWith('ms_') && f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(INBOX_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
}
