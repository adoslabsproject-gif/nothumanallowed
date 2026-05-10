/**
 * Email routes — Google Gmail + IMAP accounts
 */

import fs from 'fs';
import path from 'path';
import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { NHA_DIR } from '../../constants.mjs';
import { getUnreadImportant, getMessage, listMessages, getTodayEmails, sendEmail, createDraft } from '../../services/mail-router.mjs';

/**
 * Persist a single Gmail API message to the local SQLite DB.
 * Non-blocking — errors are caught and logged, never thrown to the caller.
 */
async function persistGmailMessageToDb(config, msg) {
  if (!msg || !msg.id) return;

  const { SQLITE_AVAILABLE, getDb, ensureGoogleAccount, upsertFolder } = await import('../../services/email-db.mjs');
  if (!SQLITE_AVAILABLE) return;

  const db = getDb();

  // Determine the user's email from config
  let accountEmail = 'gmail@account';
  try {
    accountEmail = config.google?.email || config.email || accountEmail;
  } catch {}
  // Fallback: extract from 'to' field
  if (accountEmail === 'gmail@account' && msg.to) {
    const match = msg.to.match(/<(.+?)>$/);
    accountEmail = match ? match[1] : msg.to;
  }

  // Ensure Google account exists
  const googleAccount = ensureGoogleAccount({
    id: 'google',
    display_name: 'Gmail',
    email_address: accountEmail,
    imap_host: 'gmail.googleapis.com',
    imap_port: 993,
    is_active: 1
  });
  if (!googleAccount) return;

  // Determine folder from labels
  let folderKey = 'INBOX';
  if (msg.labels && Array.isArray(msg.labels)) {
    if (msg.labels.includes('SENT')) folderKey = 'SENT';
    else if (msg.labels.includes('DRAFT')) folderKey = 'DRAFTS';
    else if (msg.labels.includes('SPAM')) folderKey = 'SPAM';
    else if (msg.labels.includes('TRASH')) folderKey = 'TRASH';
  }

  const folderMap = {
    'INBOX': { name: 'Inbox', type: 'inbox' },
    'SENT': { name: 'Sent', type: 'sent' },
    'DRAFTS': { name: 'Drafts', type: 'drafts' },
    'SPAM': { name: 'Spam', type: 'spam' },
    'TRASH': { name: 'Trash', type: 'trash' },
  };
  const folderInfo = folderMap[folderKey] || { name: 'Inbox', type: 'inbox' };
  const folderId = upsertFolder(googleAccount.id, folderKey, folderInfo.name, folderInfo.type, 1, 0);
  if (!folderId) return;

  // Extract email/name from "Name <email>" format
  const fromEmail = msg.from ? (msg.from.match(/<(.+?)>$/)?.[1] || msg.from) : '';
  const fromName = msg.from ? (msg.from.match(/^(.+?)\s*<.+>$/)?.[1]?.replace(/['"]/g, '') || '') : '';

  // Insert or replace message
  db.prepare(`
    INSERT OR REPLACE INTO email_messages
      (id, account_id, folder_id, imap_folder_path, uid, message_id, thread_id,
       subject, from_address, from_name, to_addresses, body_text, body_html, body_preview,
       internal_date, has_attachments, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    msg.id, googleAccount.id, folderId, folderKey,
    Date.now() + (Math.random() * 1000 | 0),
    msg.id, msg.threadId || msg.id,
    msg.subject || '(no subject)',
    fromEmail, fromName,
    msg.to || '',
    msg.body || '', msg.bodyHtml || '',
    msg.snippet || '',
    new Date(msg.date || Date.now()).toISOString(),
    (msg.attachments && msg.attachments.length > 0) ? 1 : 0,
    'gmail_api'
  );

  // Persist read/starred state
  db.prepare(`
    INSERT OR REPLACE INTO email_message_state (message_id, is_read, is_starred)
    VALUES (?, ?, ?)
  `).run(msg.id, msg.isUnread ? 0 : 1, msg.isImportant ? 1 : 0);
}

export function register(router) {
  // ── Gmail DB-first routes ──────────────────────────────────────────────

  // GET /api/gmail/messages — reads from local SQLite DB (fast, offline)
  router.get('/api/gmail/messages', async (req, res) => {
    try {
      const { SQLITE_AVAILABLE, listMessages } = await import('../../services/email-db.mjs');
      if (!SQLITE_AVAILABLE) return sendJSON(res, 200, { messages: [], total: 0, dbUnavailable: true });

      const url = new URL(req.url, 'http://localhost');
      const folder = url.searchParams.get('folder') || 'INBOX';
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const search = url.searchParams.get('search') || '';

      const result = listMessages('google', null, limit, offset, search, folder);
      sendJSON(res, 200, { messages: result.messages ?? [], total: result.total ?? 0, source: 'db' });
    } catch (e) { sendJSON(res, 200, { messages: [], total: 0, error: e.message }); }
  });

  // POST /api/gmail/sync — fetches from Gmail API and saves to local DB
  router.post('/api/gmail/sync', async (req, res) => {
    try {
      const body = await parseBody(req);
      const config = loadConfig();

      if (!config.google?.clientId && !config.google?.tokens?.access_token) {
        return sendJSON(res, 200, { synced: 0, authRequired: true });
      }

      const folder = (body.folder || 'INBOX').toUpperCase();
      const limit = body.limit || 50;

      const { getAllEmails } = await import('../../services/google-gmail.mjs');
      const emails = await getAllEmails(config, folder, limit);

      // getAllEmails already calls cacheMessages internally which saves to SQLite DB
      // Also persist via persistGmailMessageToDb for body_html
      for (const msg of emails) {
        await persistGmailMessageToDb(config, msg).catch(() => {});
      }

      sendJSON(res, 200, { synced: emails.length, folder });
    } catch (e) {
      sendJSON(res, 200, { synced: 0, error: e.message });
    }
  });

  // GET /api/gmail/message — read single message from DB, fallback to Gmail API
  router.get('/api/gmail/message', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) return sendError(res, 400, 'id required');

      // Try DB first
      const { getMessage: dbGetMessage } = await import('../../services/email-db.mjs');
      const dbMsg = dbGetMessage(id);
      if (dbMsg && (dbMsg.body_text || dbMsg.body_html)) {
        return sendJSON(res, 200, { message: dbMsg, source: 'db' });
      }

      // Fallback to Gmail API
      const config = loadConfig();
      const msg = await getMessage(config, id);
      if (msg) {
        persistGmailMessageToDb(config, msg).catch(() => {});
        return sendJSON(res, 200, {
          message: {
            id: msg.id,
            subject: msg.subject,
            from_address: msg.from ? (msg.from.match(/<(.+?)>$/)?.[1] || msg.from) : '',
            from_name: msg.from ? (msg.from.match(/^(.+?)\s*<.+>$/)?.[1]?.replace(/['"]/g, '') || '') : '',
            to_addresses: msg.to || '',
            internal_date: msg.date || '',
            body_text: msg.body || '',
            body_html: msg.bodyHtml || '',
            body_preview: msg.snippet || '',
          },
          source: 'gmail_api',
        });
      }
      sendJSON(res, 200, { message: null });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Gmail legacy ──────────────────────────────────────────────────────

  router.get('/api/emails', async (req, res) => {
    try {
      const config = loadConfig();

      // ENTERPRISE OAUTH CHECK: Validate Google configuration upfront
      if (!config.google?.clientId && !config.google?.tokens?.access_token) {
        return sendJSON(res, 200, {
          emails: [],
          total: 0,
          authRequired: true,
          message: 'Google OAuth not configured. Click to setup authentication.',
          setupInstructions: [
            'Go to Google Cloud Console',
            'Create OAuth 2.0 Client ID',
            'Enable Gmail API and Calendar API',
            'Run: nha google auth'
          ]
        });
      }

      const url = new URL(req.url, 'http://localhost');
      const folder = url.searchParams.get('folder') || 'inbox';
      const searchQuery = url.searchParams.get('search') || '';
      const limit = parseInt(url.searchParams.get('pageSize') || url.searchParams.get('limit') || '200');
      const offset = parseInt(url.searchParams.get('page') || url.searchParams.get('offset') || '0') * (url.searchParams.get('page') ? limit : 1);
      try {
        const gmailFolder = folder.toUpperCase() === 'INBOX' ? 'INBOX'
          : folder.toUpperCase() === 'SENT' ? 'SENT'
          : folder.toUpperCase() === 'DRAFTS' ? 'DRAFTS'
          : folder.toUpperCase() === 'SPAM' ? 'SPAM'
          : folder.toUpperCase() === 'TRASH' ? 'TRASH'
          : folder.toUpperCase() === 'STARRED' ? 'STARRED'
          : folder.toUpperCase() === 'IMPORTANT' ? 'IMPORTANT'
          : folder;

        // DB-first: if we have cached emails for this folder and no search, serve from DB instantly
        if (!searchQuery) {
          try {
            const { SQLITE_AVAILABLE, listMessages: dbList } = await import('../../services/email-db.mjs');
            if (SQLITE_AVAILABLE) {
              const dbResult = dbList('google', null, limit, offset, '', gmailFolder);
              if (dbResult.messages && dbResult.messages.length > 0) {
                const dbEmails = dbResult.messages.map(m => ({
                  id: m.id,
                  from: m.from_name ? `${m.from_name} <${m.from_address}>` : (m.from_address || ''),
                  subject: m.subject || '(no subject)',
                  date: m.internal_date,
                  snippet: m.body_preview || '',
                  isUnread: !m.is_read,
                  isStarred: !!m.is_starred,
                }));
                sendJSON(res, 200, { emails: dbEmails, total: dbResult.total, source: 'db' });

                // Background refresh from Gmail API (non-blocking, updates DB for next load)
                setImmediate(async () => {
                  try {
                    const { getAllEmails } = await import('../../services/google-gmail.mjs');
                    const fresh = await getAllEmails(config, gmailFolder, limit + offset);
                    for (const msg of fresh) { persistGmailMessageToDb(config, msg).catch(() => {}); }
                  } catch {}
                });
                return;
              }
            }
          } catch { /* DB not available — proceed to Gmail API */ }
        }

        // No cached data or search query — fetch from Gmail API
        const { getAllEmails } = await import('../../services/google-gmail.mjs');
        const emails = await getAllEmails(config, gmailFolder, limit + offset, searchQuery);
        sendJSON(res, 200, { emails: emails.slice(offset, offset + limit), total: emails.length });

        // Persist fetched emails to local SQLite DB (fire-and-forget)
        setImmediate(() => {
          for (const msg of emails) {
            persistGmailMessageToDb(config, msg).catch(() => {});
          }
        });
      } catch (providerErr) {
        if (providerErr.message?.includes('No mail provider') || providerErr.message?.includes('token')) {
          try {
            const { listAccounts, listMessages: imapList } = await import('../../services/email-db.mjs');
            const accounts = listAccounts();
            if (accounts.length === 0) {
              return sendJSON(res, 200, { emails: [], total: 0, authRequired: true });
            }
            const acc = accounts.find(a => a.is_active !== 0) || accounts[0];
            const result = imapList(acc.id, null, limit, typeof offset === 'number' ? offset : 0, '');
            const msgs = (result.messages ?? []).map(m => ({
              id: m.id,
              from: m.from_name ? `${m.from_name} <${m.from_address}>` : (m.from_address || ''),
              subject: m.subject || '(no subject)',
              date: m.internal_date,
              snippet: m.body_preview || '',
              isUnread: !m.is_read,
              isStarred: !!m.is_starred,
            }));
            return sendJSON(res, 200, { emails: msgs, total: result.total ?? msgs.length, source: 'imap' });
          } catch {
            return sendJSON(res, 200, { emails: [], total: 0, authRequired: true });
          }
        }
        throw providerErr;
      }
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/email/read', async (req, res) => {
    try {
      const body = await parseBody(req);
      const config = loadConfig();
      const msgId = body.messageId || body.id;

      if (!msgId) return sendError(res, 400, 'messageId required');

      try {
        const msg = await getMessage(config, msgId);
        console.log('[EMAIL READ SUCCESS] Gmail API returned:', JSON.stringify(msg, null, 2).slice(0, 500));

        // Persist to local SQLite DB for offline/local-first access
        persistGmailMessageToDb(config, msg).catch(e =>
          console.warn('[EMAIL READ] Failed to persist to DB:', e.message)
        );

        sendJSON(res, 200, { message: msg });
      } catch (providerErr) {
        // Gmail API failed — fall back to local IMAP DB
        try {
          const { getMessage: imapGetMessage } = await import('../../services/email-db.mjs');
          const imapMsg = imapGetMessage(msgId);
          if (imapMsg) {
            return sendJSON(res, 200, {
              message: {
                id: imapMsg.id,
                from: imapMsg.from_name ? `${imapMsg.from_name} <${imapMsg.from_address}>` : (imapMsg.from_address || ''),
                to: imapMsg.to_address || '',
                subject: imapMsg.subject || '(no subject)',
                date: imapMsg.internal_date || '',
                snippet: imapMsg.body_preview || '',
                body: imapMsg.body_text || imapMsg.body_html || '',
                bodyHtml: imapMsg.body_html || '',
                labels: (imapMsg.labels || []).map(l => l.name || l),
                isUnread: !imapMsg.is_read,
                isStarred: !!imapMsg.is_starred,
                attachments: (imapMsg.attachments || []).map(a => ({
                  filename: a.filename,
                  mimeType: a.content_type,
                  size: a.size_bytes,
                })),
                source: 'imap',
              },
            });
          }
        } catch { /* IMAP fallback also failed */ }

        // If both failed, return clear error
        const msg = providerErr.message || '';
        console.error('[EMAIL READ] Gmail failed:', msg);
        if (msg.includes('Not authenticated') || msg.includes('token') || msg.includes('client ID')) {
          return sendJSON(res, 401, { error: msg, authRequired: true });
        }
        throw providerErr;
      }
    } catch (e) {
      console.error('[EMAIL READ FATAL]', e.message);
      sendError(res, 500, e.message);
    }
  });

  router.post('/api/email/send', async (req, res) => {
    try {
      const body = await parseBody(req);
      const config = loadConfig();
      await sendEmail(config, body);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/email/mark-read', async (req, res) => {
    try {
      const body = await parseBody(req);
      const config = loadConfig();
      const { markAsRead } = await import('../../services/google-gmail.mjs');
      await markAsRead(config, body.messageId);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/email/mark-all-read', async (req, res) => {
    try {
      const config = loadConfig();
      const { markAllAsRead } = await import('../../services/google-gmail.mjs');
      const result = await markAllAsRead(config);
      sendJSON(res, 200, { ok: true, count: result?.count ?? 0 });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── IMAP accounts ──────────────────────────────────────────────────────

  router.get('/api/imap/accounts', async (_req, res) => {
    try {
      const { listAccounts } = await import('../../services/email-db.mjs');
      sendJSON(res, 200, { accounts: listAccounts() });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/accounts', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { createAccount } = await import('../../services/email-db.mjs');
      const account = createAccount(body);
      sendJSON(res, 201, { account });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/accounts/update', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { updateAccount } = await import('../../services/email-db.mjs');
      updateAccount(body.id, body);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/accounts/delete', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { deleteAccount } = await import('../../services/email-db.mjs');
      deleteAccount(body.id);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/imap/sync  (body: { accountId, force })
  router.post('/api/imap/sync', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { syncAccount } = await import('../../services/email-imap.mjs');
      const result = await syncAccount(body.accountId, { force: body.force });
      sendJSON(res, 200, result ?? { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/imap/sync/:accountId  (UI calls this format)
  const IMAP_SYNC_RE = /^\/api\/imap\/sync\/(.+)$/;
  router.post(IMAP_SYNC_RE, async (req, res) => {
    try {
      const accountId = req.url.match(IMAP_SYNC_RE)?.[1];
      const body = await parseBody(req).catch(() => ({}));
      const { syncAccount } = await import('../../services/email-imap.mjs');
      const result = await syncAccount(accountId, { force: body.force });
      sendJSON(res, 200, result ?? { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/imap/messages', async (req, res) => {
    try {
      const emailDb = await import('../../services/email-db.mjs');
      if (!emailDb.SQLITE_AVAILABLE) {
        return sendJSON(res, 200, { messages: [], total: 0, error: 'SQLite not available' });
      }
      const url = new URL(req.url, 'http://localhost');
      const accountId = url.searchParams.get('accountId');
      if (!accountId) return sendJSON(res, 200, { messages: [], total: 0 });
      const labelId = url.searchParams.get('labelId') || null;
      const folder = url.searchParams.get('folder') || null;
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const search = url.searchParams.get('search') || '';
      const result = emailDb.listMessages(accountId, labelId, limit, offset, search, folder);
      sendJSON(res, 200, { messages: result.messages ?? result, total: result.total ?? 0 });
    } catch (e) {
      console.error('[/api/imap/messages] Error:', e.message);
      sendJSON(res, 200, { messages: [], total: 0, error: e.message });
    }
  });

  router.get('/api/imap/message', async (req, res) => {
    try {
      const { getMessage } = await import('../../services/email-db.mjs');
      const url = new URL(req.url, 'http://localhost');
      const id = url.searchParams.get('id');
      sendJSON(res, 200, { message: getMessage(id) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/imap/thread', async (req, res) => {
    try {
      const { getThread } = await import('../../services/email-db.mjs');
      const url = new URL(req.url, 'http://localhost');
      const threadId = url.searchParams.get('threadId');
      const accountId = url.searchParams.get('accountId');
      sendJSON(res, 200, { messages: getThread(threadId, accountId) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/send', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { sendImapEmail } = await import('../../services/email-smtp.mjs');
      await sendImapEmail(body);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/mark-read', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { markRead } = await import('../../services/email-db.mjs');
      markRead(body.messageId || body.id, true);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/mark-starred', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { markStarred } = await import('../../services/email-db.mjs');
      markStarred(body.messageId || body.id, body.starred !== false);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/trash', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { softDelete } = await import('../../services/email-db.mjs');
      softDelete(body.messageId || body.id);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/imap/labels', async (req, res) => {
    try {
      const { listLabels } = await import('../../services/email-db.mjs');
      const url = new URL(req.url, 'http://localhost');
      sendJSON(res, 200, { labels: listLabels(url.searchParams.get('accountId')) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/labels/create', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { createLabel } = await import('../../services/email-db.mjs');
      sendJSON(res, 201, { label: createLabel(body.accountId, body.name, body.color, body.parentId) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/labels/assign', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { addMessageToLabel } = await import('../../services/email-db.mjs');
      addMessageToLabel(body.messageId, body.labelId);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/imap/unread-count', async (req, res) => {
    try {
      const { listAccounts, getDb } = await import('../../services/email-db.mjs');
      const url = new URL(req.url, 'http://localhost');
      const filterAccountId = url.searchParams.get('accountId');
      const accounts = filterAccountId ? [{ id: filterAccountId }] : listAccounts();
      const db = getDb();
      let total = 0;
      for (const acc of accounts) {
        const row = db.prepare(`
          SELECT COUNT(*) as n FROM email_messages m
          JOIN email_message_labels eml ON eml.message_id = m.id
          JOIN email_labels l ON l.id = eml.label_id
          LEFT JOIN email_message_state s ON s.message_id = m.id
          WHERE m.account_id = ? AND l.system_type = 'inbox'
            AND COALESCE(s.is_read, 0) = 0
            AND m.permanently_deleted = 0
        `).get(acc.id);
        total += row?.n || 0;
      }
      sendJSON(res, 200, { unread: total, count: total });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/mark-all-read', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { markAllRead } = await import('../../services/email-db.mjs');
      markAllRead(body.accountId, body.labelId || body.folder);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/imap/attachment', async (req, res) => {
    try {
      const { getDb } = await import('../../services/email-db.mjs');
      const url = new URL(req.url, 'http://localhost');
      const messageId = url.searchParams.get('messageId');
      const attachmentId = url.searchParams.get('attachmentId');
      const db = getDb();
      const att = db.prepare('SELECT * FROM attachments WHERE id=? AND message_id=?').get(attachmentId, messageId);
      if (!att) return sendError(res, 404, 'Attachment not found');
      res.writeHead(200, { 'Content-Type': att.content_type || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${att.filename || 'attachment'}"` });
      res.end(Buffer.from(att.data || '', 'base64'));
    } catch (e) { sendError(res, 500, e.message); }
  });

  // Blocked senders + rules + signatures + drafts (abbreviated — full parity)
  router.get('/api/imap/blocked', async (req, res) => {
    try {
      const { listBlockedSenders } = await import('../../services/email-db.mjs');
      const url = new URL(req.url, 'http://localhost');
      sendJSON(res, 200, { blocked: listBlockedSenders(url.searchParams.get('accountId')) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/blocked/add', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { addBlockedSender } = await import('../../services/email-db.mjs');
      addBlockedSender(body.accountId, body.email);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/imap/signatures', async (req, res) => {
    try {
      const { listSignatures } = await import('../../services/email-db.mjs');
      const url = new URL(req.url, 'http://localhost');
      sendJSON(res, 200, { signatures: listSignatures(url.searchParams.get('accountId')) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/signatures/create', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { createSignature } = await import('../../services/email-db.mjs');
      sendJSON(res, 201, { signature: createSignature(body.accountId, body.name, body.content, body.isDefault) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/imap/drafts', async (req, res) => {
    try {
      const { listDrafts } = await import('../../services/email-db.mjs');
      const url = new URL(req.url, 'http://localhost');
      sendJSON(res, 200, { drafts: listDrafts(url.searchParams.get('accountId')) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/drafts/save', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { saveDraft } = await import('../../services/email-db.mjs');
      sendJSON(res, 200, { draft: saveDraft(body) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/drafts/delete', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { deleteDraft } = await import('../../services/email-db.mjs');
      deleteDraft(body.id);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/labels/update', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { updateLabel } = await import('../../services/email-db.mjs');
      if (!body.id) return sendError(res, 400, 'id required');
      updateLabel(body.id, body);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/labels/delete', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { deleteLabel } = await import('../../services/email-db.mjs');
      if (!body.id) return sendError(res, 400, 'id required');
      deleteLabel(body.id);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/blocked/remove', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { unblockSender } = await import('../../services/email-db.mjs');
      if (!body.id) return sendError(res, 400, 'id required');
      unblockSender(body.id);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/imap/rules', async (req, res) => {
    try {
      const { listArchivingRules } = await import('../../services/email-db.mjs');
      const url = new URL(req.url, 'http://localhost');
      const accountId = url.searchParams.get('accountId');
      if (!accountId) return sendError(res, 400, 'accountId required');
      sendJSON(res, 200, { rules: listArchivingRules(accountId) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/rules/create', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { createArchivingRule } = await import('../../services/email-db.mjs');
      if (!body.accountId || !body.matchType || !body.matchValue) return sendError(res, 400, 'accountId, matchType, matchValue required');
      const id = createArchivingRule(body.accountId, body.matchType, body.matchValue, body.targetLabelId);
      sendJSON(res, 200, { ok: true, id });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/rules/delete', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { deleteArchivingRule } = await import('../../services/email-db.mjs');
      if (!body.id) return sendError(res, 400, 'id required');
      deleteArchivingRule(body.id);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/imap/signatures/delete', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { deleteSignature } = await import('../../services/email-db.mjs');
      if (!body.id) return sendError(res, 400, 'id required');
      deleteSignature(body.id);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });
}
