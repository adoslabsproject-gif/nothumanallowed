/**
 * Email routes — Google Gmail + IMAP accounts
 */

import fs from 'fs';
import path from 'path';
import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { NHA_DIR } from '../../constants.mjs';
import { getUnreadImportant, getMessage, listMessages, getTodayEmails, sendEmail, createDraft } from '../../services/mail-router.mjs';

export function register(router) {
  // ── Gmail ──────────────────────────────────────────────────────────────

  router.get('/api/emails', async (req, res) => {
    try {
      const config = loadConfig();
      const url = new URL(req.url, 'http://localhost');
      const folder = url.searchParams.get('folder') || 'inbox';
      const limit = parseInt(url.searchParams.get('pageSize') || url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('page') || url.searchParams.get('offset') || '0') * (url.searchParams.get('page') ? limit : 1);
      try {
        // getUnreadImportant returns fully-parsed messages (subject, from, snippet, etc.)
        // For non-inbox folders fall back to raw id+threadId list
        let emails;
        if (folder === 'inbox' || folder === 'INBOX') {
          emails = await getUnreadImportant(config, limit + offset);
        } else {
          const gmailQuery = folder === 'sent' ? 'in:sent' : folder === 'spam' ? 'in:spam' : folder === 'trash' ? 'in:trash' : `in:${folder}`;
          const refs = await listMessages(config, gmailQuery, limit + offset);
          emails = refs; // raw refs — full detail would require N individual getMessage calls
        }
        sendJSON(res, 200, { emails: emails.slice(offset, offset + limit), total: emails.length });
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
      const msg = await getMessage(config, body.id);
      sendJSON(res, 200, { message: msg });
    } catch (e) { sendError(res, 500, e.message); }
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
      const { listMessages } = await import('../../services/email-db.mjs');
      const url = new URL(req.url, 'http://localhost');
      const accountId = url.searchParams.get('accountId');
      const folder = url.searchParams.get('folder') || 'INBOX';
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const search = url.searchParams.get('search') || '';
      // listMessages(accountId, labelId, limit, offset, search)
      const result = listMessages(accountId, null, limit, offset, search);
      sendJSON(res, 200, { messages: result.messages ?? result, total: result.total ?? 0 });
    } catch (e) { sendError(res, 500, e.message); }
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
