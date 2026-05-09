/**
 * email-db.mjs — SQLite local email store (~/.nha/email.db)
 *
 * IMAP is READ-ONLY: this DB is the source of truth for all organization.
 * Labels, read/unread state, stars — everything lives here.
 * Nothing is ever written back to the IMAP server.
 */

import { createHash, randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const NHA_DIR = join(os.homedir(), '.nha');
const DB_PATH = join(NHA_DIR, 'email.db');

let _db = null;

// Lazy-load better-sqlite3 so NHA works on platforms where it can't be compiled (Android/Termux)
let _Database = null;
try {
  const mod = await import('better-sqlite3');
  _Database = mod.default || mod;
} catch {
  // better-sqlite3 not available (e.g. Android/Termux without build tools)
  // IMAP email features will be disabled; all other NHA features work normally
}

export const SQLITE_AVAILABLE = !!_Database;

export function getDb() {
  if (!_Database) throw new Error('Email features are not available on this platform. better-sqlite3 requires native compilation (not supported on Android/Termux). All other NHA features work normally.');
  if (_db && _db.open) return _db;
  mkdirSync(NHA_DIR, { recursive: true });
  _db = new _Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('cache_size = -8000');
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    -- ── ACCOUNTS ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_accounts (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL DEFAULT 'imap', -- 'imap' | 'google'
      email_address TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL,
      from_name     TEXT,
      -- IMAP config
      imap_host     TEXT,
      imap_port     INTEGER DEFAULT 993,
      smtp_host     TEXT,
      smtp_port     INTEGER DEFAULT 587,
      username      TEXT,
      encrypted_password TEXT,  -- AES-256-GCM: iv:authTag:ciphertext (hex)
      -- Sync state
      sync_status   TEXT NOT NULL DEFAULT 'idle',
      last_sync_at  TEXT,
      last_sync_error TEXT,
      -- Display
      sort_order    INTEGER NOT NULL DEFAULT 0,
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── FOLDERS (IMAP sync metadata only) ─────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_folders (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      path         TEXT NOT NULL,
      name         TEXT NOT NULL,
      folder_type  TEXT NOT NULL DEFAULT 'custom',
      uid_validity INTEGER,
      last_uid     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, path)
    );

    -- ── LABELS (Gmail-style tag model) ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_labels (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      color       TEXT,         -- hex '#FF5733'
      icon        TEXT,
      path        TEXT,         -- materialized: 'clienti/rossi'
      parent_id   TEXT,
      system_type TEXT,         -- 'inbox'|'sent'|'drafts'|'starred'|'spam'|'trash'|'archived'|NULL
      is_system   INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      total_count  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, name)
    );

    -- ── MESSAGES ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_messages (
      id                TEXT PRIMARY KEY,
      account_id        TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      folder_id         TEXT REFERENCES email_folders(id) ON DELETE SET NULL,
      imap_folder_path  TEXT NOT NULL,
      uid               INTEGER NOT NULL,
      message_id        TEXT,
      in_reply_to       TEXT,
      references_list   TEXT,  -- JSON array
      thread_id         TEXT,
      subject           TEXT NOT NULL DEFAULT '',
      from_address      TEXT,
      from_name         TEXT,
      to_addresses      TEXT,  -- JSON array [{address, name}]
      cc_addresses      TEXT,  -- JSON array
      bcc_addresses     TEXT,  -- JSON array
      body_text         TEXT,
      body_html         TEXT,
      body_preview      TEXT,
      body_reply_only   TEXT,
      size_bytes        INTEGER NOT NULL DEFAULT 0,
      has_attachments   INTEGER NOT NULL DEFAULT 0,
      content_hash      TEXT,
      internal_date     TEXT NOT NULL,
      permanently_deleted INTEGER NOT NULL DEFAULT 0,
      source            TEXT NOT NULL DEFAULT 'imap',  -- 'imap'|'sent'
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, imap_folder_path, uid)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_account     ON email_messages(account_id, internal_date DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_thread      ON email_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_messages_message_id  ON email_messages(message_id);

    -- ── ATTACHMENTS ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_attachments (
      id           TEXT PRIMARY KEY,
      message_id   TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
      filename     TEXT,
      content_type TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      part_id      TEXT,
      content_id   TEXT,
      content_blob BLOB,  -- cached for files < 5MB
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── MESSAGE ↔ LABEL JUNCTION ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_message_labels (
      message_id TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
      label_id   TEXT NOT NULL REFERENCES email_labels(id)   ON DELETE CASCADE,
      added_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, label_id)
    );

    CREATE INDEX IF NOT EXISTS idx_msg_labels_label ON email_message_labels(label_id);

    -- ── PER-MESSAGE USER STATE ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_message_state (
      message_id  TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
      is_read     INTEGER NOT NULL DEFAULT 0,
      is_starred  INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id)
    );

    -- ── BLOCKED SENDERS ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_blocked_senders (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      email       TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, email)
    );

    -- ── ARCHIVING RULES ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_archiving_rules (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      match_type  TEXT NOT NULL DEFAULT 'sender',  -- 'sender'|'domain'|'subject'
      match_value TEXT NOT NULL,
      target_label_id TEXT REFERENCES email_labels(id) ON DELETE SET NULL,
      priority    INTEGER NOT NULL DEFAULT 0,
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── SIGNATURES ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_signatures (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      content    TEXT NOT NULL,  -- HTML
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── DRAFTS ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_drafts (
      id              TEXT PRIMARY KEY,
      account_id      TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      reply_to_id     TEXT REFERENCES email_messages(id) ON DELETE SET NULL,
      reply_type      TEXT,  -- 'reply'|'reply_all'|'forward'
      subject         TEXT NOT NULL DEFAULT '',
      to_addresses    TEXT,  -- JSON array
      cc_addresses    TEXT,
      bcc_addresses   TEXT,
      body_html       TEXT,
      body_text       TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed system labels for any accounts that don't have them yet
  seedSystemLabels(db);
}

const SYSTEM_LABELS = [
  { system_type: 'inbox',    name: 'Inbox',    icon: 'inbox',  color: null, sort_order: 0 },
  { system_type: 'sent',     name: 'Sent',     icon: 'send',   color: null, sort_order: 1 },
  { system_type: 'drafts',   name: 'Drafts',   icon: 'file',   color: null, sort_order: 2 },
  { system_type: 'starred',  name: 'Starred',  icon: 'star',   color: '#F59E0B', sort_order: 3 },
  { system_type: 'archived', name: 'Archived', icon: 'archive',color: null, sort_order: 4 },
  { system_type: 'spam',     name: 'Spam',     icon: 'shield', color: '#F97316', sort_order: 5 },
  { system_type: 'trash',    name: 'Trash',    icon: 'trash',  color: null, sort_order: 6 },
];

function seedSystemLabels(db) {
  const accounts = db.prepare('SELECT id FROM email_accounts').all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO email_labels (id, account_id, name, system_type, is_system, color, icon, sort_order, path)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
  `);
  for (const acc of accounts) {
    for (const lbl of SYSTEM_LABELS) {
      insert.run(randomUUID(), acc.id, lbl.name, lbl.system_type, lbl.color, lbl.icon, lbl.sort_order, lbl.system_type);
    }
  }
}

// ── ENCRYPTION (AES-256-GCM for passwords stored at rest) ─────────────────

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ENC_KEY_HEX = process.env.NHA_EMAIL_ENC_KEY || null;

function deriveKey() {
  if (ENC_KEY_HEX && ENC_KEY_HEX.length === 64) {
    return Buffer.from(ENC_KEY_HEX, 'hex');
  }
  // Fallback: derive from machine-id (less secure but works offline)
  const seed = `nha-email-${os.hostname()}-${os.userInfo().username}`;
  return createHash('sha256').update(seed).digest();
}

export function encryptPassword(plaintext) {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptPassword(encrypted) {
  try {
    const key = deriveKey();
    const parts = encrypted.split(':');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const enc = Buffer.from(parts[2], 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── ACCOUNT CRUD ───────────────────────────────────────────────────────────

export function listAccounts() {
  const db = getDb();
  return db.prepare('SELECT id, type, email_address, display_name, from_name, imap_host, imap_port, smtp_host, smtp_port, username, sync_status, last_sync_at, sort_order, is_active FROM email_accounts ORDER BY sort_order, created_at').all();
}

export function getAccount(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id);
}

export function getAccountCredentials(id) {
  const db = getDb();
  const acc = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id);
  if (!acc) return null;
  const password = acc.encrypted_password ? decryptPassword(acc.encrypted_password) : null;
  return { ...acc, password };
}

export function createAccount(data) {
  const db = getDb();
  const id = randomUUID();
  const encPwd = data.password ? encryptPassword(data.password) : null;
  db.prepare(`
    INSERT INTO email_accounts (id, type, email_address, display_name, from_name, imap_host, imap_port, smtp_host, smtp_port, username, encrypted_password, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.type || 'imap', data.email_address, data.display_name || data.email_address,
    data.from_name || null, data.imap_host || null, data.imap_port || 993,
    data.smtp_host || null, data.smtp_port || 587,
    data.username || data.email_address, encPwd,
    data.sort_order || 0);
  // Seed system labels for new account
  seedSystemLabels(db);
  return id;
}

export function updateAccount(id, data) {
  const db = getDb();
  const fields = [];
  const vals = [];
  if (data.display_name !== undefined) { fields.push('display_name = ?'); vals.push(data.display_name); }
  if (data.from_name !== undefined)    { fields.push('from_name = ?'); vals.push(data.from_name); }
  if (data.imap_host !== undefined)    { fields.push('imap_host = ?'); vals.push(data.imap_host); }
  if (data.imap_port !== undefined)    { fields.push('imap_port = ?'); vals.push(data.imap_port); }
  if (data.smtp_host !== undefined)    { fields.push('smtp_host = ?'); vals.push(data.smtp_host); }
  if (data.smtp_port !== undefined)    { fields.push('smtp_port = ?'); vals.push(data.smtp_port); }
  if (data.username !== undefined)     { fields.push('username = ?'); vals.push(data.username); }
  if (data.password !== undefined)     { fields.push('encrypted_password = ?'); vals.push(encryptPassword(data.password)); }
  if (data.is_active !== undefined)    { fields.push('is_active = ?'); vals.push(data.is_active ? 1 : 0); }
  if (!fields.length) return;
  fields.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE email_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteAccount(id) {
  const db = getDb();
  db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id);
}

export function setSyncStatus(accountId, status, error) {
  const db = getDb();
  db.prepare(`UPDATE email_accounts SET sync_status = ?, last_sync_at = datetime('now'), last_sync_error = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, error || null, accountId);
}

// ── FOLDER CRUD ────────────────────────────────────────────────────────────

export function upsertFolder(accountId, path, name, folderType, uidValidity, lastUid) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM email_folders WHERE account_id = ? AND path = ?').get(accountId, path);
  if (existing) {
    db.prepare(`UPDATE email_folders SET name = ?, folder_type = ?, uid_validity = ?, last_uid = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, folderType, uidValidity, lastUid, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO email_folders (id, account_id, path, name, folder_type, uid_validity, last_uid) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, accountId, path, name, folderType, uidValidity, lastUid);
  return id;
}

export function getFolder(accountId, path) {
  return getDb().prepare('SELECT * FROM email_folders WHERE account_id = ? AND path = ?').get(accountId, path);
}

export function listFolders(accountId) {
  return getDb().prepare('SELECT * FROM email_folders WHERE account_id = ? ORDER BY folder_type, path').all(accountId);
}

export function updateFolderUid(folderId, uidValidity, lastUid) {
  getDb().prepare(`UPDATE email_folders SET uid_validity = ?, last_uid = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(uidValidity, lastUid, folderId);
}

// ── LABEL CRUD ─────────────────────────────────────────────────────────────

export function listLabels(accountId) {
  return getDb().prepare('SELECT * FROM email_labels WHERE account_id = ? ORDER BY is_system DESC, sort_order, name').all(accountId);
}

export function getSystemLabel(accountId, systemType) {
  return getDb().prepare('SELECT * FROM email_labels WHERE account_id = ? AND system_type = ?').get(accountId, systemType);
}

/** Idempotent — seeds any missing system labels for a single account. */
export function ensureLabelsForAccount(accountId) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO email_labels (id, account_id, name, system_type, is_system, color, icon, sort_order, path)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
  `);
  for (const lbl of SYSTEM_LABELS) {
    insert.run(randomUUID(), accountId, lbl.name, lbl.system_type, lbl.color, lbl.icon, lbl.sort_order, lbl.system_type);
  }
}

export function createLabel(accountId, name, color, parentId) {
  const db = getDb();
  const id = randomUUID();
  const parent = parentId ? db.prepare('SELECT path, name FROM email_labels WHERE id = ?').get(parentId) : null;
  const path = parent ? `${parent.path || parent.name}/${name}` : name;
  db.prepare(`INSERT INTO email_labels (id, account_id, name, color, parent_id, path, is_system, sort_order) VALUES (?, ?, ?, ?, ?, ?, 0, 99)`)
    .run(id, accountId, name, color || null, parentId || null, path);
  return id;
}

export function updateLabel(id, data) {
  const db = getDb();
  const fields = [];
  const vals = [];
  if (data.name !== undefined)  { fields.push('name = ?'); vals.push(data.name); }
  if (data.color !== undefined) { fields.push('color = ?'); vals.push(data.color); }
  if (!fields.length) return;
  vals.push(id);
  db.prepare(`UPDATE email_labels SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteLabel(id) {
  getDb().prepare('DELETE FROM email_labels WHERE id = ? AND is_system = 0').run(id);
}

const UPDATE_LABEL_SQL = `
  UPDATE email_labels SET
    total_count = (SELECT COUNT(*) FROM email_message_labels eml
      JOIN email_messages m ON m.id = eml.message_id
      WHERE eml.label_id = ? AND m.permanently_deleted = 0),
    unread_count = (SELECT COUNT(*) FROM email_message_labels eml
      JOIN email_messages m ON m.id = eml.message_id
      LEFT JOIN email_message_state s ON s.message_id = m.id
      WHERE eml.label_id = ? AND m.permanently_deleted = 0 AND (s.is_read IS NULL OR s.is_read = 0))
  WHERE id = ?
`;

// Called from email-imap.mjs after a folder sync — updates all labels for the account
export function updateLabelCounts(accountId) {
  const db = getDb();
  const labels = db.prepare('SELECT id FROM email_labels WHERE account_id = ?').all(accountId);
  const stmt = db.prepare(UPDATE_LABEL_SQL);
  for (const lbl of labels) {
    stmt.run(lbl.id, lbl.id, lbl.id);
  }
}

// Called internally after adding/removing a single message from a label
function updateSingleLabelCount(db, labelId) {
  db.prepare(UPDATE_LABEL_SQL).run(labelId, labelId, labelId);
}

// ── MESSAGE CRUD ───────────────────────────────────────────────────────────

export function contentHash(messageId, fromAddress, dateStr) {
  return createHash('sha256').update(`${messageId}|${fromAddress}|${dateStr}`).digest('hex');
}

export function messageExists(accountId, folderPath, uid) {
  return !!getDb().prepare('SELECT id FROM email_messages WHERE account_id = ? AND imap_folder_path = ? AND uid = ?').get(accountId, folderPath, uid);
}

export function insertMessage(data) {
  const db = getDb();
  const id = data.id || randomUUID();
  db.prepare(`
    INSERT OR IGNORE INTO email_messages
      (id, account_id, folder_id, imap_folder_path, uid, message_id, in_reply_to, references_list,
       thread_id, subject, from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
       body_text, body_html, body_preview, body_reply_only, size_bytes, has_attachments,
       content_hash, internal_date, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, data.account_id, data.folder_id || null, data.imap_folder_path, data.uid,
    data.message_id || null, data.in_reply_to || null,
    data.references_list ? JSON.stringify(data.references_list) : null,
    data.thread_id || null, data.subject || '',
    data.from_address || null, data.from_name || null,
    data.to_addresses ? JSON.stringify(data.to_addresses) : null,
    data.cc_addresses ? JSON.stringify(data.cc_addresses) : null,
    data.bcc_addresses ? JSON.stringify(data.bcc_addresses) : null,
    data.body_text || null, data.body_html || null, data.body_preview || null,
    data.body_reply_only || null, data.size_bytes || 0,
    data.has_attachments ? 1 : 0, data.content_hash || null,
    data.internal_date, data.source || 'imap'
  );
  // Init read state from IMAP \Seen flag
  const isRead = data.imap_seen ? 1 : 0;
  db.prepare('INSERT OR IGNORE INTO email_message_state (message_id, is_read, is_starred) VALUES (?, ?, 0)').run(id, isRead);
  return id;
}

export function insertAttachments(messageId, attachments) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO email_attachments (id, message_id, filename, content_type, size_bytes, part_id, content_id, content_blob)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const att of attachments) {
    insert.run(randomUUID(), messageId, att.filename || null, att.content_type || 'application/octet-stream',
      att.size_bytes || 0, att.part_id || null, att.content_id || null,
      att.content ? att.content : null);
  }
}

export function addMessageToLabel(messageId, labelId) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO email_message_labels (message_id, label_id) VALUES (?, ?)').run(messageId, labelId);
  updateSingleLabelCount(db, labelId);
}

export function removeMessageFromLabel(messageId, labelId) {
  const db = getDb();
  db.prepare('DELETE FROM email_message_labels WHERE message_id = ? AND label_id = ?').run(messageId, labelId);
  updateSingleLabelCount(db, labelId);
}

export function getMessageLabels(messageId) {
  return getDb().prepare('SELECT l.* FROM email_labels l JOIN email_message_labels j ON j.label_id = l.id WHERE j.message_id = ?').all(messageId);
}

// ── MESSAGE QUERIES ────────────────────────────────────────────────────────

export function listMessages(accountId, labelId, limit, offset, search) {
  const db = getDb();
  let where = 'm.account_id = ? AND m.permanently_deleted = 0';
  const params = [accountId];

  if (labelId) {
    // Also include messages saved with matching imap_folder_path in case label link was missing
    const lbl = db.prepare('SELECT system_type FROM email_labels WHERE id = ?').get(labelId);
    const folderFallback = lbl?.system_type ? lbl.system_type.charAt(0).toUpperCase() + lbl.system_type.slice(1) : null;
    if (folderFallback) {
      where += ' AND (EXISTS (SELECT 1 FROM email_message_labels j WHERE j.message_id = m.id AND j.label_id = ?) OR m.imap_folder_path = ?)';
      params.push(labelId, folderFallback);
    } else {
      where += ' AND EXISTS (SELECT 1 FROM email_message_labels j WHERE j.message_id = m.id AND j.label_id = ?)';
      params.push(labelId);
    }
  }
  if (search) {
    where += ' AND (m.subject LIKE ? OR m.from_address LIKE ? OR m.from_name LIKE ? OR m.body_preview LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  params.push(limit || 50, offset || 0);

  const rows = db.prepare(`
    SELECT m.id, m.subject, m.from_address, m.from_name, m.internal_date,
           m.body_preview, m.has_attachments, m.thread_id,
           COALESCE(s.is_read, 0) as is_read,
           COALESCE(s.is_starred, 0) as is_starred
    FROM email_messages m
    LEFT JOIN email_message_state s ON s.message_id = m.id
    WHERE ${where}
    ORDER BY m.internal_date DESC
    LIMIT ? OFFSET ?
  `).all(...params);

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM email_messages m WHERE ${where.replace('LIMIT ? OFFSET ?', '')}`).get(...params.slice(0, -2));

  return { messages: rows, total: total?.cnt || 0 };
}

export function getMessage(id) {
  const db = getDb();
  const msg = db.prepare(`
    SELECT m.*, COALESCE(s.is_read, 0) as is_read, COALESCE(s.is_starred, 0) as is_starred
    FROM email_messages m
    LEFT JOIN email_message_state s ON s.message_id = m.id
    WHERE m.id = ? AND m.permanently_deleted = 0
  `).get(id);
  if (!msg) return null;
  const attachments = db.prepare('SELECT id, filename, content_type, size_bytes, part_id, content_id FROM email_attachments WHERE message_id = ?').all(id);
  const labels = getMessageLabels(id);
  return { ...msg, attachments, labels };
}

export function getThread(threadId, accountId) {
  const db = getDb();
  return db.prepare(`
    SELECT m.*, COALESCE(s.is_read, 0) as is_read, COALESCE(s.is_starred, 0) as is_starred
    FROM email_messages m
    LEFT JOIN email_message_state s ON s.message_id = m.id
    WHERE m.thread_id = ? AND m.account_id = ? AND m.permanently_deleted = 0
    ORDER BY m.internal_date ASC
  `).all(threadId, accountId);
}

// ── STATE MUTATIONS (local only — never touches IMAP) ─────────────────────

export function markRead(messageId, isRead) {
  const db = getDb();
  db.prepare(`INSERT INTO email_message_state (message_id, is_read, is_starred) VALUES (?, ?, 0)
    ON CONFLICT(message_id) DO UPDATE SET is_read = excluded.is_read, updated_at = datetime('now')`)
    .run(messageId, isRead ? 1 : 0);
  // Refresh label unread counts for this message's account
  const msg = db.prepare('SELECT account_id FROM email_messages WHERE id = ?').get(messageId);
  if (msg?.account_id) updateLabelCounts(msg.account_id);
}

export function markStarred(messageId, isStarred) {
  getDb().prepare(`INSERT INTO email_message_state (message_id, is_read, is_starred) VALUES (?, 0, ?)
    ON CONFLICT(message_id) DO UPDATE SET is_starred = excluded.is_starred, updated_at = datetime('now')`)
    .run(messageId, isStarred ? 1 : 0);
}

export function softDelete(messageId) {
  // Moves to trash label, never deletes from IMAP
  const db = getDb();
  db.prepare("UPDATE email_messages SET permanently_deleted = 0 WHERE id = ?").run(messageId);
  // Remove all non-trash labels
  const msg = db.prepare('SELECT account_id FROM email_messages WHERE id = ?').get(messageId);
  if (!msg) return;
  const trash = getSystemLabel(msg.account_id, 'trash');
  if (trash) {
    db.prepare('DELETE FROM email_message_labels WHERE message_id = ?').run(messageId);
    addMessageToLabel(messageId, trash.id);
  }
}

export function markAllRead(accountId, labelId) {
  const db = getDb();
  let msgIds;
  if (labelId) {
    msgIds = db.prepare(`SELECT m.id FROM email_messages m JOIN email_message_labels j ON j.message_id = m.id WHERE m.account_id = ? AND j.label_id = ? AND m.permanently_deleted = 0`).all(accountId, labelId).map(r => r.id);
  } else {
    msgIds = db.prepare('SELECT id FROM email_messages WHERE account_id = ? AND permanently_deleted = 0').all(accountId).map(r => r.id);
  }
  const stmt = db.prepare(`INSERT INTO email_message_state (message_id, is_read, is_starred) VALUES (?, 1, 0)
    ON CONFLICT(message_id) DO UPDATE SET is_read = 1, updated_at = datetime('now')`);
  const tx = db.transaction((ids) => {
    for (const id of ids) stmt.run(id);
  });
  tx(msgIds);
  return msgIds.length;
}

// ── BLOCKED SENDERS ────────────────────────────────────────────────────────

export function blockSender(accountId, email) {
  const db = getDb();
  const id = randomUUID();
  db.prepare('INSERT OR IGNORE INTO email_blocked_senders (id, account_id, email) VALUES (?, ?, ?)').run(id, accountId, email.toLowerCase());
}

export function unblockSender(id) {
  getDb().prepare('DELETE FROM email_blocked_senders WHERE id = ?').run(id);
}

export function listBlockedSenders(accountId) {
  return getDb().prepare('SELECT * FROM email_blocked_senders WHERE account_id = ? ORDER BY created_at DESC').all(accountId);
}

export function isSenderBlocked(accountId, email) {
  return !!getDb().prepare('SELECT id FROM email_blocked_senders WHERE account_id = ? AND email = ?').get(accountId, email.toLowerCase());
}

// ── ARCHIVING RULES ────────────────────────────────────────────────────────

export function listArchivingRules(accountId) {
  return getDb().prepare('SELECT r.*, l.name as label_name, l.color as label_color FROM email_archiving_rules r LEFT JOIN email_labels l ON l.id = r.target_label_id WHERE r.account_id = ? ORDER BY r.priority').all(accountId);
}

export function createArchivingRule(accountId, matchType, matchValue, targetLabelId) {
  const id = randomUUID();
  getDb().prepare('INSERT INTO email_archiving_rules (id, account_id, match_type, match_value, target_label_id) VALUES (?, ?, ?, ?, ?)').run(id, accountId, matchType, matchValue, targetLabelId || null);
  return id;
}

export function deleteArchivingRule(id) {
  getDb().prepare('DELETE FROM email_archiving_rules WHERE id = ?').run(id);
}

export function applyArchivingRules(accountId, messageId, fromAddress, subject) {
  const db = getDb();
  const rules = db.prepare('SELECT * FROM email_archiving_rules WHERE account_id = ? AND is_active = 1 ORDER BY priority').all(accountId);
  const inboxLabel = getSystemLabel(accountId, 'inbox');
  for (const rule of rules) {
    let match = false;
    if (rule.match_type === 'sender') match = fromAddress?.toLowerCase() === rule.match_value.toLowerCase();
    else if (rule.match_type === 'domain') match = fromAddress?.toLowerCase().endsWith('@' + rule.match_value.toLowerCase());
    else if (rule.match_type === 'subject') match = subject?.toLowerCase().includes(rule.match_value.toLowerCase());
    if (match && rule.target_label_id) {
      // Remove inbox, add target (first rule wins)
      if (inboxLabel) db.prepare('DELETE FROM email_message_labels WHERE message_id = ? AND label_id = ?').run(messageId, inboxLabel.id);
      addMessageToLabel(messageId, rule.target_label_id);
      return true;
    }
  }
  return false;
}

// ── SIGNATURES ─────────────────────────────────────────────────────────────

export function listSignatures(accountId) {
  return getDb().prepare('SELECT * FROM email_signatures WHERE account_id = ? ORDER BY is_default DESC, created_at').all(accountId);
}

export function createSignature(accountId, name, content, isDefault) {
  const db = getDb();
  const id = randomUUID();
  if (isDefault) db.prepare('UPDATE email_signatures SET is_default = 0 WHERE account_id = ?').run(accountId);
  db.prepare('INSERT INTO email_signatures (id, account_id, name, content, is_default) VALUES (?, ?, ?, ?, ?)').run(id, accountId, name, content, isDefault ? 1 : 0);
  return id;
}

export function deleteSignature(id) {
  getDb().prepare('DELETE FROM email_signatures WHERE id = ?').run(id);
}

// ── DRAFTS ─────────────────────────────────────────────────────────────────

export function saveDraft(accountId, data) {
  const db = getDb();
  const id = data.id || randomUUID();
  if (data.id) {
    db.prepare(`UPDATE email_drafts SET subject=?, to_addresses=?, cc_addresses=?, bcc_addresses=?, body_html=?, body_text=?, updated_at=datetime('now') WHERE id=?`)
      .run(data.subject||'', JSON.stringify(data.to||[]), JSON.stringify(data.cc||[]), JSON.stringify(data.bcc||[]), data.body_html||'', data.body_text||'', id);
  } else {
    db.prepare(`INSERT INTO email_drafts (id, account_id, reply_to_id, reply_type, subject, to_addresses, cc_addresses, bcc_addresses, body_html, body_text) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, accountId, data.reply_to_id||null, data.reply_type||null, data.subject||'', JSON.stringify(data.to||[]), JSON.stringify(data.cc||[]), JSON.stringify(data.bcc||[]), data.body_html||'', data.body_text||'');
  }
  return id;
}

export function getDraft(id) {
  return getDb().prepare('SELECT * FROM email_drafts WHERE id = ?').get(id);
}

export function listDrafts(accountId) {
  return getDb().prepare("SELECT * FROM email_drafts WHERE account_id = ? ORDER BY updated_at DESC").all(accountId);
}

export function deleteDraft(id) {
  getDb().prepare('DELETE FROM email_drafts WHERE id = ?').run(id);
}
