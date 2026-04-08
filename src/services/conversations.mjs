/**
 * Multi-conversation manager for NHA Chat — with fork/branching support.
 *
 * Stores conversations in ~/.nha/conversations/ as JSON files.
 * Each conversation has an ID, auto-generated title, and message tree.
 *
 * Message tree structure:
 *   Each message node: { id, role, content, parentId, children: [id, id, ...], activeChild: 0 }
 *   The "active path" follows activeChild at each fork point.
 *   Retry creates a new sibling (branch), not a replacement.
 *
 * Backward compatible: old conversations with flat messages[] are auto-upgraded.
 *
 * Zero npm dependencies.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { NHA_DIR } from '../constants.mjs';

const CONVERSATIONS_DIR = path.join(NHA_DIR, 'conversations');
const ACTIVE_FILE = path.join(CONVERSATIONS_DIR, '.active');
const MAX_TITLE_LENGTH = 60;
const MAX_CONVERSATIONS = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir() {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

function convPath(id) {
  return path.join(CONVERSATIONS_DIR, `${id}.json`);
}

function generateId() {
  return crypto.randomUUID().slice(0, 8);
}

function msgId() {
  return crypto.randomUUID().slice(0, 12);
}

function autoTitle(firstMessage) {
  if (!firstMessage) return 'New Chat';
  let title = firstMessage.replace(/\s+/g, ' ').trim();
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = title.lastIndexOf(' ');
    if (lastSpace > 20) title = title.slice(0, lastSpace);
    title += '...';
  }
  return title;
}

// ── Tree Helpers ─────────────────────────────────────────────────────────────

/**
 * Upgrade a flat messages array to tree format.
 * Each message gets an id, parentId, children[].
 */
function upgradeToTree(conv) {
  if (conv.tree) return; // already upgraded

  const nodes = {};
  const messages = conv.messages || [];
  let prevId = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const id = msg.id || msgId();
    const node = {
      id,
      role: msg.role,
      content: msg.content,
      parentId: prevId,
      children: [],
      activeChild: 0,
    };
    nodes[id] = node;
    if (prevId && nodes[prevId]) {
      nodes[prevId].children.push(id);
    }
    prevId = id;
  }

  conv.tree = nodes;
  conv.rootId = messages.length > 0 ? Object.keys(nodes)[0] : null;
}

/**
 * Get the active message path (following activeChild at each fork).
 * Returns flat array of {role, content, id} for the LLM.
 */
function getActivePath(conv) {
  upgradeToTree(conv);
  if (!conv.tree || !conv.rootId) return [];

  const path = [];
  let currentId = conv.rootId;

  while (currentId) {
    const node = conv.tree[currentId];
    if (!node) break;
    path.push({ id: node.id, role: node.role, content: node.content });
    if (node.children.length === 0) break;
    const nextIdx = Math.min(node.activeChild || 0, node.children.length - 1);
    currentId = node.children[nextIdx];
  }

  return path;
}

/**
 * Add a message to the tree. Returns the new node ID.
 * parentId = null means append to the end of the active path.
 */
function addNode(conv, role, content, parentId = null) {
  upgradeToTree(conv);
  if (!conv.tree) conv.tree = {};

  const id = msgId();

  // Find parent: if not specified, use the last node in active path
  if (!parentId) {
    const activePath = getActivePath(conv);
    if (activePath.length > 0) {
      parentId = activePath[activePath.length - 1].id;
    }
  }

  const node = { id, role, content, parentId, children: [], activeChild: 0 };
  conv.tree[id] = node;

  if (parentId && conv.tree[parentId]) {
    conv.tree[parentId].children.push(id);
    // Set this as the active child
    conv.tree[parentId].activeChild = conv.tree[parentId].children.length - 1;
  }

  if (!conv.rootId) conv.rootId = id;

  return id;
}

/**
 * Get fork info for a specific node: how many siblings and which is active.
 * Returns { total, current, siblingIds } or null if no fork.
 */
function getForkInfo(conv, nodeId) {
  upgradeToTree(conv);
  const node = conv.tree?.[nodeId];
  if (!node || !node.parentId) return null;

  const parent = conv.tree[node.parentId];
  if (!parent || parent.children.length <= 1) return null;

  const current = parent.children.indexOf(nodeId);
  return {
    total: parent.children.length,
    current: current,
    siblingIds: parent.children,
    parentId: parent.id,
  };
}

/**
 * Switch to a different sibling at a fork point.
 * direction: -1 (previous) or +1 (next)
 */
function switchFork(conv, nodeId, direction) {
  upgradeToTree(conv);
  const node = conv.tree?.[nodeId];
  if (!node || !node.parentId) return false;

  const parent = conv.tree[node.parentId];
  if (!parent || parent.children.length <= 1) return false;

  const currentIdx = parent.children.indexOf(nodeId);
  const newIdx = currentIdx + direction;
  if (newIdx < 0 || newIdx >= parent.children.length) return false;

  parent.activeChild = newIdx;
  return true;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function createConversation(title = '') {
  ensureDir();
  const id = generateId();
  const now = new Date().toISOString();
  const conv = {
    id,
    title: title || 'New Chat',
    messages: [],
    tree: {},
    rootId: null,
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(convPath(id), JSON.stringify(conv, null, 2) + '\n', 'utf-8');
  setActiveId(id);
  return conv;
}

export function loadConversation(id) {
  try {
    const data = fs.readFileSync(convPath(id), 'utf-8');
    const conv = JSON.parse(data);
    // Auto-upgrade old format
    if (!conv.tree && conv.messages && conv.messages.length > 0) {
      upgradeToTree(conv);
      saveConversation(conv);
    }
    return conv;
  } catch {
    return null;
  }
}

export function saveConversation(conv) {
  ensureDir();
  conv.updatedAt = new Date().toISOString();
  // Keep messages[] in sync with active path for backward compat
  conv.messages = getActivePath(conv);
  fs.writeFileSync(convPath(conv.id), JSON.stringify(conv, null, 2) + '\n', 'utf-8');
}

export function deleteConversation(id) {
  const filePath = convPath(id);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  if (getActiveId() === id) clearActiveId();
  return true;
}

export function listConversations() {
  ensureDir();
  const files = fs.readdirSync(CONVERSATIONS_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'));

  const convs = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, f), 'utf-8'));
      convs.push({
        id: data.id,
        title: data.title || 'Untitled',
        messageCount: (data.messages || []).length,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      });
    } catch {}
  }

  convs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  if (convs.length > MAX_CONVERSATIONS) {
    for (const old of convs.slice(MAX_CONVERSATIONS)) {
      try { fs.unlinkSync(convPath(old.id)); } catch {}
    }
    return convs.slice(0, MAX_CONVERSATIONS);
  }

  return convs;
}

// ── Active Conversation ──────────────────────────────────────────────────────

export function getActiveId() {
  try { return fs.readFileSync(ACTIVE_FILE, 'utf-8').trim() || null; } catch { return null; }
}

export function setActiveId(id) {
  ensureDir();
  fs.writeFileSync(ACTIVE_FILE, id, 'utf-8');
}

function clearActiveId() {
  try { fs.unlinkSync(ACTIVE_FILE); } catch {}
}

export function getOrCreateActive() {
  const activeId = getActiveId();
  if (activeId) {
    const conv = loadConversation(activeId);
    if (conv) return conv;
  }
  return createConversation();
}

/**
 * Add a message pair (user + assistant) to a conversation.
 * Creates tree nodes. Auto-titles from first user message.
 */
export function addMessages(conv, userContent, assistantContent) {
  const userId = addNode(conv, 'user', userContent);
  const assistantId = addNode(conv, 'assistant', assistantContent, userId);

  if (conv.title === 'New Chat' && Object.keys(conv.tree || {}).length <= 2) {
    conv.title = autoTitle(userContent);
  }

  saveConversation(conv);
  return { userId, assistantId };
}

/**
 * Retry: add a NEW assistant response as a sibling of the existing one.
 * This creates a fork — the user can navigate between variants.
 * Returns the ID of the user message (parent) so the caller knows which message to re-send.
 */
export function retryMessage(conv, assistantNodeId) {
  upgradeToTree(conv);
  const node = conv.tree?.[assistantNodeId];
  if (!node || node.role !== 'assistant') return null;

  // The parent is the user message
  const parentId = node.parentId;
  if (!parentId) return null;

  // Return the parent (user) ID — the caller will generate a new response
  // and call addRetryResponse() with the result
  return parentId;
}

/**
 * Add a retry response as a new sibling branch.
 * @param {object} conv - conversation
 * @param {string} userNodeId - the user message ID (parent)
 * @param {string} newContent - the new assistant response
 * @returns {string} the new assistant node ID
 */
export function addRetryResponse(conv, userNodeId, newContent) {
  const newId = addNode(conv, 'assistant', newContent, userNodeId);
  saveConversation(conv);
  return newId;
}

/**
 * Edit a user message: creates a new branch from the parent of the edited message.
 * Returns the new user node ID.
 */
export function editMessage(conv, userNodeId, newContent) {
  upgradeToTree(conv);
  const node = conv.tree?.[userNodeId];
  if (!node || node.role !== 'user') return null;

  const parentId = node.parentId; // could be null (first message) or previous assistant

  const newId = addNode(conv, 'user', newContent, parentId);
  saveConversation(conv);
  return newId;
}

/**
 * Navigate fork: switch to previous/next sibling at a fork point.
 */
export function navigateFork(conv, nodeId, direction) {
  const result = switchFork(conv, nodeId, direction);
  if (result) saveConversation(conv);
  return result;
}

/**
 * Get fork info for a node (for UI rendering).
 */
export { getForkInfo };

/**
 * Get the active path as flat messages array.
 */
export function getHistory(conv, maxTurns = 20) {
  const activePath = getActivePath(conv);
  return activePath.slice(-(maxTurns * 2));
}

// ── Export ────────────────────────────────────────────────────────────────────

export function exportAsMarkdown(conv) {
  const messages = getActivePath(conv);
  const lines = [
    `# ${conv.title}`,
    `*Created: ${new Date(conv.createdAt).toLocaleString()}*`,
    `*Messages: ${messages.length}*`,
    '', '---', '',
  ];
  for (const msg of messages) {
    lines.push(msg.role === 'user' ? '### You' : '### NHA');
    lines.push(msg.content);
    lines.push('');
  }
  return lines.join('\n');
}

export function exportAsJson(conv) {
  return JSON.stringify({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messages: getActivePath(conv),
    tree: conv.tree,
  }, null, 2);
}

// ── Migration ────────────────────────────────────────────────────────────────

export function migrateOldHistory() {
  const oldFile = path.join(NHA_DIR, 'memory', 'chat-history.json');
  if (!fs.existsSync(oldFile)) return;

  try {
    const messages = JSON.parse(fs.readFileSync(oldFile, 'utf-8'));
    if (!Array.isArray(messages) || messages.length === 0) return;

    const conv = createConversation('Previous Chat');
    conv.messages = messages;
    upgradeToTree(conv);
    saveConversation(conv);

    fs.renameSync(oldFile, oldFile + '.migrated');
  } catch {}
}
