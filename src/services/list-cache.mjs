/**
 * Last-list cache — shared between tool-executor and message-responder.
 *
 * Whenever a list-tool runs (gmail_list, task_list, drive_list, etc.) the
 * structured items are stored here keyed by chatId. The anaphoric resolver
 * in message-responder reads from here to map "cancellalo / aprilo / il
 * primo / l'ultimo" to the correct item ID.
 *
 * Persisted to ~/.nha/list-cache.json so it survives daemon restarts.
 */

import fs from 'fs';
import path from 'path';
import { NHA_DIR } from '../constants.mjs';

const CACHE_FILE = path.join(NHA_DIR, 'list-cache.json');
const MAX_ITEMS_PER_LIST = 50;       // cap per list to avoid prompt explosion

let _inMemory = null;

function _load() {
  if (_inMemory) return _inMemory;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      _inMemory = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    } else {
      _inMemory = {};
    }
  } catch { _inMemory = {}; }
  return _inMemory;
}

function _save() {
  try {
    if (!fs.existsSync(NHA_DIR)) fs.mkdirSync(NHA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_inMemory, null, 2));
  } catch {}
}

/**
 * Store the most recently shown items of a given kind for a given chat.
 * @param {string} chatId   — caller identity ('chat:abc', telegramChatId, '__last_list__')
 * @param {string} kind     — 'calendar' | 'email' | 'task' | 'contact' | 'drive' | 'note' | 'reminder' | 'gtask' | 'notion' | 'slack' | 'github' | any
 * @param {Array<object>} items — structured items, each must have an id field
 */
export function rememberList(chatId, kind, items) {
  if (!kind || !Array.isArray(items)) return;
  const cache = _load();
  const key = chatId || '__last_list__';
  cache[key] = cache[key] || {};
  const capped = items.slice(0, MAX_ITEMS_PER_LIST);
  cache[key][`lastList_${kind}`] = capped;
  cache[key][`lastList_${kind}_at`] = Date.now();
  cache[key].lastListKind = kind;
  cache[key].lastListAt = Date.now();
  _save();
}

/**
 * Retrieve items by kind for a chatId. Falls back to the freshest list of
 * that kind across ALL chats if the specific one is empty.
 */
export function getList(chatId, kind) {
  const cache = _load();
  const direct = cache[chatId || '__last_list__']?.[`lastList_${kind}`];
  if (Array.isArray(direct) && direct.length > 0) return direct;
  // Fallback: best-most-recent across chats.
  let best = null, bestAt = 0;
  for (const v of Object.values(cache)) {
    const items = v?.[`lastList_${kind}`];
    const at = v?.[`lastList_${kind}_at`] || 0;
    if (Array.isArray(items) && items.length > 0 && at > bestAt) {
      best = items; bestAt = at;
    }
  }
  return best || [];
}

/**
 * What kind was last listed (any chat). Used when the user issues an
 * anaphoric command without specifying kind.
 */
export function getLastListKind(chatId) {
  const cache = _load();
  if (chatId && cache[chatId]?.lastListKind) return cache[chatId].lastListKind;
  let bestKind = null, bestAt = 0;
  for (const v of Object.values(cache)) {
    if (v?.lastListKind && (v.lastListAt || 0) > bestAt) {
      bestKind = v.lastListKind; bestAt = v.lastListAt;
    }
  }
  return bestKind;
}
