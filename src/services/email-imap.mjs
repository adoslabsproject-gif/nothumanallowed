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

function createImapClient(label, creds, accountId, secureOverride, opts = {}) {
  const port = parseInt(creds.imap_port, 10) || 993;
  // Default heuristic: 993/465 use implicit TLS, anything else uses STARTTLS.
  // `secureOverride` lets the auto-fallback path force the opposite mode.
  const isSecure = typeof secureOverride === 'boolean'
    ? secureOverride
    : (port === 993 || port === 465);
  // TLS hardening configurable per attempt. The `legacy` flag drops the
  // minimum TLS version to v1.0 — required by some old / self-hosted IMAP
  // servers (mail.dimensione-server.it, postfix on legacy CentOS, etc.)
  // that still refuse TLS 1.2+ ClientHello.
  const tlsOpts = {
    rejectUnauthorized: false,
    ...(opts.legacy ? { minVersion: 'TLSv1', maxVersion: 'TLSv1.3' } : {}),
  };
  const clientOpts = {
    host: creds.imap_host,
    port,
    secure: isSecure,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
    clientInfo: { name: 'NHA-Mail', version: '1.0.0' },
    emitLogs: false,
    // Generous timeouts — first sync from a slow server can take a while
    // before it even responds with the greeting. The previous 10s was too
    // tight for ISP-hosted mailservers with throttling on cold connections.
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 120000,
    tls: tlsOpts,
  };
  // `plaintext` strategy: connect cleartext AND skip STARTTLS upgrade. For
  // self-hosted servers that advertise STARTTLS but the upgrade itself is
  // broken (the most common cause of "wrong version number" after a
  // successful TCP connect on port 143).
  if (opts.plaintext) {
    clientOpts.disableAutoIdle = true;
    clientOpts.disableSTARTTLS = true;
  }
  const client = new ImapFlow(clientOpts);
  client.on('error', (err) => {
    console.error(`[email:imap] ${label} error:`, err.message);
    if (accountId) syncClients.delete(accountId);
  });
  return client;
}

// Raw TCP probe that just opens the socket and reads the first ~256 bytes of
// whatever the server sends. No TLS handshake, no IMAP protocol. This is the
// "smoking gun" diagnostic: if the server returns "* OK [CAPABILITY ... STARTTLS ...]"
// we know STARTTLS is the right mode. If it returns binary garbage starting
// with 0x16, that's a TLS handshake → we need implicit TLS. If it returns
// nothing within timeout, the host/port is wrong or firewalled.
export async function probeImapPort(host, port) {
  const net = await import('net');
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 10000 });
    let buf = Buffer.alloc(0);
    const done = (verdict) => {
      try { socket.destroy(); } catch {}
      resolve(verdict);
    };
    socket.on('connect', () => {
      // Some servers wait for client greeting before sending anything; we just
      // wait up to 5 more seconds for the server banner.
      setTimeout(() => {
        if (buf.length === 0) done({ ok: true, banner: '', advice: 'tcp-open-silent', message: `Connessione TCP riuscita ma il server non ha inviato banner entro 5s. Probabilmente è un server che parla TLS implicito — prova porta 993.` });
      }, 5000);
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 200) {
        const first = buf[0];
        const text = buf.toString('utf8').slice(0, 200);
        if (first === 0x16 || first === 0x15 || first === 0x14) {
          done({ ok: true, banner: text.replace(/[^\x20-\x7e]/g, '·').slice(0, 100), advice: 'tls-implicit', message: `Il server risponde con un handshake TLS binario. Modalità corretta: TLS IMPLICITO (secure=true). Probabile porta sbagliata se hai messo 143 — prova 993.` });
        } else if (/^\*\s+OK/i.test(text)) {
          const hasStartTls = /STARTTLS/i.test(text);
          done({ ok: true, banner: text.split('\r\n')[0], advice: hasStartTls ? 'starttls' : 'plaintext', message: hasStartTls ? `Server IMAP in chiaro che annuncia STARTTLS. Modalità corretta: STARTTLS (secure=false, upgrade automatico).` : `Server IMAP in CHIARO senza STARTTLS. ATTENZIONE: nessuna crittografia. Solo per LAN o test — usa "plaintext" se vuoi davvero proseguire.` });
        } else {
          done({ ok: true, banner: text.slice(0, 100), advice: 'unknown', message: `Risposta non riconosciuta dal server: ${text.slice(0, 80)}...` });
        }
      }
    });
    socket.on('error', (err) => done({ ok: false, error: err.message, advice: 'connect-error', message: `Impossibile connettersi: ${err.message}. Verifica host e porta.` }));
    socket.on('timeout', () => done({ ok: false, error: 'timeout', advice: 'firewall', message: `Timeout (10s) — host o porta non raggiungibili. Possibili cause: firewall, host sbagliato, oppure il server è offline.` }));
    socket.on('close', () => {
      if (buf.length > 0) {
        const text = buf.toString('utf8').slice(0, 200);
        done({ ok: true, banner: text.slice(0, 100), advice: 'partial', message: `Risposta parziale dal server: ${text.slice(0, 80)}` });
      }
    });
  });
}

// Match the most common "wrong TLS mode" failure modes from ImapFlow / node
// tls. Errors can surface as cleartext OpenSSL output ("wrong version
// number"), as ImapFlow strings ("Failed to receive greeting"), or as plain
// socket errors when the server closed the connection mid-handshake.
function _looksLikeTlsMismatch(err) {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  return /(greeting|tls|ssl|wrong\s*version|version\s*number|protocol|enotconn|econnreset|epipe|handshake|record_header|tlsany|alert|cert|disconnected|connection\s*closed)/i.test(msg);
}

// Per-account memory of which TLS mode worked last time. This avoids paying
// the fallback cost on every sync once we've discovered the correct mode for
// a given server, and ensures the cached `syncClients` entry stays usable.
const lastGoodSecure = new Map();   // accountId → boolean

// Per-account memory of the FULL working profile, not just secure flag.
// Some servers need legacy TLS — we don't want to re-discover that every sync.
const lastGoodProfile = new Map(); // accountId → { secure, legacy }

export async function getImapClient(accountId, override) {
  const existing = syncClients.get(accountId);
  if (existing?.usable && override === undefined) return existing;
  if (existing) { syncClients.delete(accountId); try { await existing.logout(); } catch {} }

  const creds = getAccountCredentials(accountId);
  if (!creds || !creds.imap_host) throw new Error(`No IMAP credentials for account ${accountId}`);
  const label = `sync:${accountId.slice(0, 8)}`;

  // Build the candidate list — up to 4 strategies, ordered most→least likely:
  //   1. heuristic secure + modern TLS
  //   2. opposite secure + modern TLS
  //   3. heuristic secure + legacy TLS (TLSv1.0+)
  //   4. opposite secure + legacy TLS
  // If a remembered-good profile exists, prepend it so warm syncs are 1 attempt.
  const port = parseInt(creds.imap_port, 10) || 993;
  const heuristicSecure = port === 993 || port === 465;
  let strategies;
  if (typeof override === 'boolean') {
    // Explicit override (used by the outer syncAccount retry): obey it
    // exactly, but still try legacy TLS as a fallback within that mode.
    strategies = [
      { secure: override, legacy: false, plaintext: false, why: 'override-modern' },
      { secure: override, legacy: true,  plaintext: false, why: 'override-legacy' },
    ];
  } else {
    strategies = [
      { secure: heuristicSecure,  legacy: false, plaintext: false, why: 'heuristic-modern' },
      { secure: !heuristicSecure, legacy: false, plaintext: false, why: 'opposite-modern' },
      { secure: heuristicSecure,  legacy: true,  plaintext: false, why: 'heuristic-legacy' },
      { secure: !heuristicSecure, legacy: true,  plaintext: false, why: 'opposite-legacy' },
      // Last-resort plaintext (no encryption): for servers that advertise
      // STARTTLS but the upgrade is broken, OR for explicitly insecure
      // LAN-only servers. Skipped on standard secure ports.
      ...(heuristicSecure ? [] : [{ secure: false, legacy: false, plaintext: true, why: 'plaintext-no-tls' }]),
    ];
    const remembered = lastGoodProfile.get(accountId);
    if (remembered) {
      strategies = [
        { secure: remembered.secure, legacy: !!remembered.legacy, plaintext: !!remembered.plaintext, why: 'remembered' },
        ...strategies.filter(s => !(s.secure === remembered.secure && s.legacy === !!remembered.legacy && !!s.plaintext === !!remembered.plaintext)),
      ];
    }
  }

  const errors = [];
  for (const s of strategies) {
    const client = createImapClient(label, creds, accountId, s.secure, { legacy: s.legacy, plaintext: s.plaintext });
    try {
      await client.connect();
      lastGoodProfile.set(accountId, { secure: s.secure, legacy: s.legacy, plaintext: s.plaintext });
      if (s.why !== 'remembered' && s.why !== 'heuristic-modern') {
        console.warn(`[email:imap] ${label} connected via ${s.why} (secure=${s.secure}, legacy=${s.legacy}, plaintext=${s.plaintext})`);
      }
      syncClients.set(accountId, client);
      return client;
    } catch (err) {
      errors.push(`${s.why}: ${err.message.slice(0, 120)}`);
      try { await client.logout(); } catch {}
      // If the error is clearly NOT TLS-related (e.g. auth failure, DNS),
      // stop trying — more TLS combos won't help.
      if (!_looksLikeTlsMismatch(err) && !/timeout|hang/i.test(err.message)) {
        throw err;
      }
    }
  }
  // Final attempt failed. Run a raw TCP probe so the user can see what the
  // server actually replies (or whether the port is reachable at all), and
  // include that diagnostic in the thrown error.
  let diagnosis = '';
  try {
    const probe = await probeImapPort(creds.imap_host, port);
    diagnosis = `\n\nDIAGNOSI: ${probe.message}${probe.banner ? ` (banner: "${probe.banner}")` : ''}`;
  } catch (probeErr) {
    diagnosis = `\n\nProbe diagnostico fallito: ${probeErr.message}`;
  }
  throw new Error(`IMAP connection failed after ${strategies.length} attempts on ${creds.imap_host}:${port}:\n${errors.join('\n')}${diagnosis}`);
}

// Dry-run connectivity test used by Settings UI (no DB writes, no persistent
// client). Tries up to 4 TLS-mode combinations and returns the first that
// works, along with which one. Errors include the full attempt log so the
// user can paste it back to support if everything failed.
export async function testImapConnection(creds) {
  if (!creds?.imap_host) throw new Error('imap_host required');
  if (!creds?.username || !creds?.password) throw new Error('Username and password required');
  const port = parseInt(creds.imap_port, 10) || 993;
  const heuristicSecure = port === 993 || port === 465;
  const strategies = [
    { secure: heuristicSecure,  legacy: false, plaintext: false, why: 'heuristic-modern' },
    { secure: !heuristicSecure, legacy: false, plaintext: false, why: 'opposite-modern' },
    { secure: heuristicSecure,  legacy: true,  plaintext: false, why: 'heuristic-legacy' },
    { secure: !heuristicSecure, legacy: true,  plaintext: false, why: 'opposite-legacy' },
    ...(heuristicSecure ? [] : [{ secure: false, legacy: false, plaintext: true, why: 'plaintext-no-tls' }]),
  ];
  const errors = [];
  for (const s of strategies) {
    const client = createImapClient('test', creds, null, s.secure, { legacy: s.legacy, plaintext: s.plaintext });
    try {
      await client.connect();
      const list = await client.list();
      try { await client.logout(); } catch {}
      const mode = s.plaintext
        ? 'plaintext (NESSUNA crittografia)'
        : `${s.secure ? 'TLS implicito' : 'STARTTLS'}${s.legacy ? ' (legacy ≥TLSv1.0)' : ''}`;
      return {
        ok: true,
        secure: s.secure,
        legacy: s.legacy,
        plaintext: s.plaintext,
        folderCount: list.length,
        message: `Connesso con modalità: ${mode}`,
      };
    } catch (err) {
      errors.push(`• ${s.why}: ${err.message.slice(0, 160)}`);
      try { await client.logout(); } catch {}
      if (!_looksLikeTlsMismatch(err) && !/timeout|hang/i.test(err.message)) {
        throw err;
      }
    }
  }
  // Probe in fallback so the user gets actionable info.
  let diagnosis = '';
  try {
    const probe = await probeImapPort(creds.imap_host, port);
    diagnosis = `\n\nDIAGNOSI: ${probe.message}${probe.banner ? ` (banner: "${probe.banner}")` : ''}`;
  } catch {}
  throw new Error(`IMAP test failed dopo ${strategies.length} tentativi su ${creds.imap_host}:${port}:\n${errors.join('\n')}${diagnosis}`);
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

// Download EVERY message on the server by default. Previously capped at 200
// to keep first-sync fast, but that surprised users who expected an Outlook-
// style "give me my whole mailbox". The sync still streams messages
// incrementally (headers → bodies) so the UI keeps updating, and never
// modifies the server — only the local SQLite mirror.
const FIRST_SYNC_LIMIT = 0;

export async function syncAccount(accountId, opts = {}) {
  setSyncStatus(accountId, 'syncing', null);
  try {
    // getImapClient does the full 5-strategy TLS discovery internally and
    // remembers the working profile, so the outer retry layer is no longer
    // needed — by the time we get a client back, the connection is good.
    const folders = await listImapFolders(accountId);
    const priority = ['inbox', 'sent'];
    const toSync = [
      ...folders.filter(f => priority.includes(f.folderType)),
      ...folders.filter(f => !priority.includes(f.folderType) && f.folderType !== 'trash'),
    ];

    let totalSynced = 0;
    for (const f of toSync) {
      try {
        const limit = opts.full === false ? 200 : FIRST_SYNC_LIMIT;
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
