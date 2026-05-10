/**
 * email-imap.mjs — IMAP sync service (READ-ONLY)
 *
 * ⛔ IMAP IS STRICTLY READ-ONLY.
 * This service NEVER writes to the IMAP server:
 * - No setFlags() — read/starred state is in SQLite only
 * - No moveMessage() — label moves are in SQLite only
 * - No DELETE — emails are never deleted from the server
 *
 * Handles: connection pool, incremental sync, IDLE push, folder listing.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createHash } from 'crypto';
import {
  getAccountCredentials, setSyncStatus, upsertFolder, getFolder,
  updateFolderUid, insertMessage, insertAttachments, addMessageToLabel,
  getSystemLabel, isSenderBlocked, applyArchivingRules, messageExists,
  updateLabelCounts, getDb, contentHash,
} from './email-db.mjs';

// ── FOLDER TYPE MAPPING ────────────────────────────────────────────────────

const SPECIAL_USE_MAP = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts',
  '\\Junk': 'spam', '\\Trash': 'trash',
};

const FOLDER_NAME_MAP = {
  'inbox': 'inbox', 'sent': 'sent', 'sent messages': 'sent', 'sent items': 'sent',
  'posta inviata': 'sent', 'inviati': 'sent', 'drafts': 'drafts', 'bozze': 'drafts',
  'draft': 'drafts', 'spam': 'spam', 'junk': 'spam', 'junk e-mail': 'spam',
  'posta indesiderata': 'spam', 'trash': 'trash', 'cestino': 'trash',
  'deleted': 'trash', 'deleted messages': 'trash', 'deleted items': 'trash',
};

// ── CONNECTION POOL ────────────────────────────────────────────────────────

const syncClients = new Map();   // accountId → ImapFlow (sync)
const idleClients = new Map();   // accountId → ImapFlow (IDLE)
const idleTimers = new Map();
const heartbeatTimers = new Map();
const lastIdleEvents = new Map();
const reconnectAttempts = new Map();

const IDLE_RESTART_MS = 25 * 60 * 1000;         // 25 min
const IDLE_HEARTBEAT_WATCHDOG_MS = 12 * 60 * 1000; // 12 min
const RECONNECT_DELAYS = [5000, 15000, 30000, 60000, 120000, 300000];

const idleHandlers = new Set();
export function onIdleNotification(handler) {
  idleHandlers.add(handler);
  return () => idleHandlers.delete(handler);
}
function notifyIdle(accountId, folder) {
  for (const h of idleHandlers) { try { h(accountId, folder); } catch {} }
}

function createImapClient(label, creds, accountId) {
  const port = parseInt(creds.imap_port, 10) || 993;
  const isSecure = port === 993 || port === 465;
  const client = new ImapFlow({
    host: creds.imap_host,
    port,
    secure: isSecure,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
    clientInfo: { name: 'NHA-Mail', version: '1.0.0' },
    emitLogs: false,
    tls: { rejectUnauthorized: false }, // always set — safe for self-signed certs too
  });
  client.on('error', (err) => {
    console.error(`[email:imap] ${label} error:`, err.message);
    if (accountId) syncClients.delete(accountId);
  });
  return client;
}

export async function getImapClient(accountId) {
  const existing = syncClients.get(accountId);
  if (existing?.usable) return existing;
  if (existing) { syncClients.delete(accountId); try { await existing.logout(); } catch {} }

  const creds = getAccountCredentials(accountId);
  if (!creds || !creds.imap_host) throw new Error(`No IMAP credentials for account ${accountId}`);
  const client = createImapClient(`sync:${accountId.slice(0, 8)}`, creds, accountId);
  await client.connect();
  syncClients.set(accountId, client);
  return client;
}

export async function closeImapClient(accountId) {
  const c = syncClients.get(accountId);
  if (c) { try { await c.logout(); } catch {}; syncClients.delete(accountId); }
}

// ── FOLDER LISTING ─────────────────────────────────────────────────────────

export async function listImapFolders(accountId) {
  const client = await getImapClient(accountId);
  const tree = await client.listTree();
  const all = [];

  function walk(items) {
    if (!items) return;
    for (const item of items) {
      const name = item.name ?? '';
      const path = item.path ?? '';
      let folderType = 'custom';
      if (item.specialUse) folderType = SPECIAL_USE_MAP[item.specialUse] ?? 'custom';
      if (folderType === 'custom') folderType = FOLDER_NAME_MAP[name.toLowerCase()] ?? 'custom';
      if (path === 'INBOX') folderType = 'inbox';
      if (!item.flags?.has('\\Noselect')) {
        all.push({ path, name, folderType, hasSpecialUse: !!item.specialUse });
      }
      if (item.folders?.length) walk(item.folders);
    }
  }

  if (tree.path === 'INBOX' || !tree.path) {
    all.push({ path: 'INBOX', name: 'Inbox', folderType: 'inbox', hasSpecialUse: true });
  }
  if (tree.folders?.length) walk(tree.folders);

  // Dedup: keep one winner per system type
  const winners = new Map();
  for (const f of all) {
    if (f.folderType === 'custom') continue;
    const ex = winners.get(f.folderType);
    if (!ex || (f.hasSpecialUse && !ex.hasSpecialUse) || (!f.path.includes('.') && ex.path.includes('.'))) {
      winners.set(f.folderType, f);
    }
  }
  return all.map(f => f.folderType === 'custom' ? f : (winners.get(f.folderType) === f ? f : { ...f, folderType: 'custom' }));
}

// ── INCREMENTAL SYNC ───────────────────────────────────────────────────────

function threadId(messageId, inReplyTo, references, fromAddress, date, subject) {
  const root = (references && references[0]) || inReplyTo || messageId;
  if (root) return createHash('sha1').update(root).digest('hex');
  return createHash('sha1').update(`${fromAddress}|${date}|${subject}`).digest('hex');
}

function stripQuotedReplies(text) {
  if (!text) return text;
  return text.split('\n').filter(l => !l.startsWith('>')).join('\n').trim();
}

export async function syncFolder(accountId, folderPath, fullResync, limitMessages = 0, folderType = null) {
  const client = await getImapClient(accountId);
  const db = getDb();
  const folderMeta = getFolder(accountId, folderPath);
  // Use passed folderType or existing metadata (fixes first-sync creating folders as 'custom')
  const resolvedFolderType = folderType || resolvedFolderType;

  // Open mailbox to get uidValidity BEFORE getMailboxLock
  const lock = await client.getMailboxLock(folderPath);

  try {
    const mailbox = client.mailbox;
    const currentUidValidity = Number(mailbox?.uidValidity ?? 0);
    const totalMessages = Number(mailbox?.exists ?? 0);
    const storedUidValidity = folderMeta?.uid_validity ?? null;
    const isFirstSync = storedUidValidity === null || fullResync;
    const lastUid = isFirstSync ? 0 : (folderMeta?.last_uid ?? 0);
    const needsResync = fullResync || (storedUidValidity !== null && storedUidValidity !== currentUidValidity);

    if (needsResync && folderMeta) {
      db.prepare('DELETE FROM email_message_labels WHERE message_id IN (SELECT id FROM email_messages WHERE account_id = ? AND imap_folder_path = ?)').run(accountId, folderPath);
      db.prepare('DELETE FROM email_messages WHERE account_id = ? AND imap_folder_path = ?').run(accountId, folderPath);
    }

    const inboxLabel = getSystemLabel(accountId, 'inbox');
    const sentLabel = getSystemLabel(accountId, 'sent');

    let newLastUid = lastUid;
    let synced = 0;

    // On first sync: fetch only the most recent N messages by sequence number
    // On incremental sync: fetch new UIDs since last known
    let range;
    if (isFirstSync && limitMessages > 0 && totalMessages > limitMessages) {
      const seqStart = totalMessages - limitMessages + 1;
      range = `${seqStart}:*`;
    } else if (lastUid > 0) {
      range = `${lastUid + 1}:*`;
    } else {
      range = '1:*';
    }

    // Phase 1: fetch headers only (fast — no body download)
    const headerMap = new Map(); // uid → parsed header data
    for await (const msg of client.fetch(range, {
      uid: true, flags: true, envelope: true, internalDate: true, size: true,
      bodyStructure: true,
    }, { uid: true })) {
      if (msg.uid <= lastUid) continue;
      newLastUid = Math.max(newLastUid, msg.uid);

      const env = msg.envelope ?? {};
      const fromAddr = env.from?.[0]?.address ?? null;
      const fromName = env.from?.[0]?.name ?? null;

      if (fromAddr && isSenderBlocked(accountId, fromAddr)) { synced++; continue; }
      if (messageExists(accountId, folderPath, msg.uid)) { synced++; continue; }

      headerMap.set(msg.uid, {
        env, fromAddr, fromName,
        internalDate: (msg.internalDate || new Date()).toISOString(),
        size: msg.size || 0,
        flags: msg.flags,
        bodyStructure: msg.bodyStructure,
      });
    }

    // Phase 2: for each new message, fetch body (individually, with error isolation)
    const uidsToFetch = [...headerMap.keys()];
    for (const uid of uidsToFetch) {
      const hdr = headerMap.get(uid);
      const env = hdr.env;
      const fromAddr = hdr.fromAddr;
      const fromName = hdr.fromName;

      let bodyText = null, bodyHtml = null, bodyPreview = '', attachments = [];
      let inReplyTo = null, references = [], msgId = null;

      try {
        const dl = await client.download(String(uid), undefined, { uid: true });
        if (dl) {
          const chunks = [];
          let totalSize = 0;
          for await (const chunk of dl.content) {
            totalSize += chunk.length;
            if (totalSize > 10 * 1024 * 1024) break; // 10MB cap per message
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const raw = Buffer.concat(chunks);
          const parsed = await simpleParser(raw, { skipHtmlToText: false });
          msgId = parsed.messageId || null;
          inReplyTo = typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo
            : (Array.isArray(parsed.inReplyTo) ? parsed.inReplyTo[0] : null);
          references = Array.isArray(parsed.references) ? parsed.references.slice(0, 20)
            : (parsed.references ? [parsed.references] : []);
          bodyText = (typeof parsed.text === 'string' ? parsed.text : null)?.replace(/\x00/g, '') || null;
          bodyHtml = (typeof parsed.html === 'string' ? parsed.html : null)?.replace(/\x00/g, '') || null;
          bodyPreview = (bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 255);

          if (parsed.attachments) {
            for (const att of parsed.attachments) {
              attachments.push({
                filename: att.filename || null,
                content_type: att.contentType || 'application/octet-stream',
                size_bytes: att.size || 0,
                part_id: att.partId || '',
                content_id: att.contentId || null,
                content: (att.size || 0) < 5 * 1024 * 1024 ? att.content : null,
              });
            }
          }
        }
      } catch (err) {
        console.warn(`[email:imap] Failed to fetch body uid=${uid}:`, err.message);
        // Continue with headers-only for this message
      }

      const toAddresses = (env.to || []).map(a => ({ address: a.address, name: a.name }));
      const ccAddresses = (env.cc || []).map(a => ({ address: a.address, name: a.name }));
      const bccAddresses = (env.bcc || []).map(a => ({ address: a.address, name: a.name }));
      const subject = env.subject || '';
      const tid = threadId(msgId, inReplyTo, references, fromAddr, hdr.internalDate, subject);
      const hash = contentHash(msgId || '', fromAddr || '', hdr.internalDate);

      const folderRec = upsertFolder(accountId, folderPath, folderPath,
        resolvedFolderType, currentUidValidity, newLastUid);

      const msgDbId = insertMessage({
        account_id: accountId,
        folder_id: folderRec,
        imap_folder_path: folderPath,
        uid,
        message_id: msgId,
        in_reply_to: inReplyTo,
        references_list: references,
        thread_id: tid,
        subject,
        from_address: fromAddr,
        from_name: fromName,
        to_addresses: toAddresses,
        cc_addresses: ccAddresses,
        bcc_addresses: bccAddresses,
        body_text: bodyText,
        body_html: bodyHtml,
        body_preview: bodyPreview,
        body_reply_only: stripQuotedReplies(bodyText),
        size_bytes: hdr.size,
        has_attachments: attachments.length > 0,
        content_hash: hash,
        internal_date: hdr.internalDate,
        imap_seen: hdr.flags?.has('\\Seen') ?? false,
        source: 'imap',
      });

      if (attachments.length > 0) insertAttachments(msgDbId, attachments);

      const archived = applyArchivingRules(accountId, msgDbId, fromAddr, subject);
      if (!archived) {
        const isSentFolder = folderPath.toLowerCase().includes('sent') || folderPath.toLowerCase().includes('inviati');
        const targetLabel = isSentFolder ? sentLabel : inboxLabel;
        if (targetLabel) addMessageToLabel(msgDbId, targetLabel.id);
      }

      synced++;
    }

    upsertFolder(accountId, folderPath, folderPath,
      resolvedFolderType, currentUidValidity, newLastUid);

    updateLabelCounts(accountId);
    return { synced, lastUid: newLastUid, total: totalMessages };
  } finally {
    lock.release();
  }
}

// First sync: cap to last 200 messages per folder to avoid blocking for minutes
const FIRST_SYNC_LIMIT = 200;

export async function syncAccount(accountId, opts = {}) {
  setSyncStatus(accountId, 'syncing', null);
  try {
    const folders = await listImapFolders(accountId);
    const priority = ['inbox', 'sent'];
    const toSync = [
      ...folders.filter(f => priority.includes(f.folderType)),
      ...folders.filter(f => !priority.includes(f.folderType) && f.folderType !== 'trash'),
    ];

    let totalSynced = 0;
    for (const f of toSync) {
      try {
        const limit = opts.full ? 0 : FIRST_SYNC_LIMIT;
        const result = await syncFolder(accountId, f.path, false, limit, f.folderType);
        totalSynced += result.synced;
        console.log(`[email:sync] ${f.path}: ${result.synced} new messages (total on server: ${result.total})`);
      } catch (err) {
        console.warn(`[email:imap] Sync folder ${f.path} failed:`, err.message);
      }
    }
    setSyncStatus(accountId, 'idle', null);
    return { synced: totalSynced };
  } catch (err) {
    setSyncStatus(accountId, 'error', err.message);
    throw err;
  }
}

// ── IDLE (push notifications for new messages) ─────────────────────────────

export async function startIdle(accountId) {
  await connectIdle(accountId);
}

async function connectIdle(accountId) {
  const creds = getAccountCredentials(accountId);
  if (!creds?.imap_host) return;

  try {
    const existing = idleClients.get(accountId);
    if (existing) { try { await existing.logout(); } catch {} }

    const client = createImapClient(`idle:${accountId.slice(0, 8)}`, creds);
    await client.connect();
    idleClients.set(accountId, client);
    reconnectAttempts.set(accountId, 0);
    lastIdleEvents.set(accountId, Date.now());

    runIdleLoop(accountId).catch(() => scheduleReconnect(accountId));
  } catch (err) {
    console.error(`[email:idle] Connect failed for ${accountId.slice(0, 8)}:`, err.message);
    scheduleReconnect(accountId);
  }
}

async function runIdleLoop(accountId) {
  const client = idleClients.get(accountId);
  if (!client?.usable) return;
  const lock = await client.getMailboxLock('INBOX');
  try {
    client.on('exists', (data) => {
      lastIdleEvents.set(accountId, Date.now());
      if (data.count > data.prevCount) notifyIdle(accountId, data.path);
    });

    const restart = async () => {
      clearTimeout(idleTimers.get(accountId));
      clearTimeout(heartbeatTimers.get(accountId));
      const c = idleClients.get(accountId);
      if (!c?.usable) { scheduleReconnect(accountId); return; }
      lastIdleEvents.set(accountId, Date.now());
      heartbeatTimers.set(accountId, setTimeout(() => {
        if (Date.now() - (lastIdleEvents.get(accountId) ?? 0) > IDLE_HEARTBEAT_WATCHDOG_MS) {
          scheduleReconnect(accountId);
        }
      }, IDLE_HEARTBEAT_WATCHDOG_MS));
      idleTimers.set(accountId, setTimeout(async () => {
        try { await restart(); } catch { scheduleReconnect(accountId); }
      }, IDLE_RESTART_MS));
      await c.idle();
    };
    await restart();
  } finally {
    lock.release();
  }
}

function scheduleReconnect(accountId) {
  clearTimeout(idleTimers.get(accountId));
  clearTimeout(heartbeatTimers.get(accountId));
  idleTimers.delete(accountId); heartbeatTimers.delete(accountId);
  const attempt = reconnectAttempts.get(accountId) ?? 0;
  const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempts.set(accountId, attempt + 1);
  setTimeout(() => connectIdle(accountId).catch(() => scheduleReconnect(accountId)), delay);
}

export async function stopIdle(accountId) {
  clearTimeout(idleTimers.get(accountId));
  clearTimeout(heartbeatTimers.get(accountId));
  idleTimers.delete(accountId); heartbeatTimers.delete(accountId);
  const c = idleClients.get(accountId);
  if (c) { try { await c.logout(); } catch {}; idleClients.delete(accountId); }
}

export async function stopAllIdle() {
  for (const id of [...idleClients.keys()]) await stopIdle(id);
}

// ── ATTACHMENT FETCH ───────────────────────────────────────────────────────

export async function fetchAttachmentContent(accountId, folderPath, uid, partId) {
  const client = await getImapClient(accountId);
  const lock = await client.getMailboxLock(folderPath);
  try {
    const dl = await client.download(String(uid), partId, { uid: true });
    if (!dl) return null;
    const chunks = [];
    for await (const chunk of dl.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return { buffer: Buffer.concat(chunks), contentType: dl.meta?.contentType };
  } finally {
    lock.release();
  }
}
