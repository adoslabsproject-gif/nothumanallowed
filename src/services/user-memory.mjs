/**
 * User memory — persistent across conversations and channels.
 *
 * Same idea as ChatGPT's "Memory" feature: a small Markdown file at
 * ~/.nha/user-memory.md is loaded and prepended to the system prompt of
 * every chat / Telegram / Discord / AWF agent call.
 *
 * The file is fully owned by the user — no telemetry, never uploaded.
 * Stored as plain Markdown so it stays human-readable and editable.
 */

import fs from 'fs';
import path from 'path';
import { NHA_DIR } from '../constants.mjs';

const MEMORY_FILE = path.join(NHA_DIR, 'user-memory.md');
const MAX_MEMORY_SIZE = 8000; // chars — prevents prompt explosion

function ensureFile() {
  if (!fs.existsSync(NHA_DIR)) fs.mkdirSync(NHA_DIR, { recursive: true });
  if (!fs.existsSync(MEMORY_FILE)) {
    const header = `# User Memory\n\n` +
      `Things NHA should remember about you, across all conversations and channels.\n` +
      `Edit this file freely, or use \`nha memory add "..."\` to append.\n\n`;
    fs.writeFileSync(MEMORY_FILE, header);
  }
}

/** Load the full memory file content (trimmed to MAX size). */
export function loadUserMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return '';
    const text = fs.readFileSync(MEMORY_FILE, 'utf-8');
    if (text.length <= MAX_MEMORY_SIZE) return text;
    // Keep the most recent entries (tail) if it grows too large.
    return text.slice(-MAX_MEMORY_SIZE);
  } catch { return ''; }
}

/** Append a single fact/preference to the memory file. */
export function addUserMemory(entry) {
  if (!entry || typeof entry !== 'string') return false;
  ensureFile();
  const trimmed = entry.trim();
  if (!trimmed) return false;
  const timestamp = new Date().toISOString().slice(0, 10);
  const line = `- [${timestamp}] ${trimmed}\n`;
  fs.appendFileSync(MEMORY_FILE, line);
  return true;
}

/** Replace the entire memory content (used by `nha memory edit`). */
export function setUserMemory(text) {
  ensureFile();
  fs.writeFileSync(MEMORY_FILE, text);
}

/** Wipe all memories. */
export function clearUserMemory() {
  if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);
}

/** Get the memory file path (for the `nha memory edit` command to open). */
export function getMemoryPath() {
  return MEMORY_FILE;
}

/**
 * Build a system-prompt prefix block for the user memory. Returns empty
 * string when there's nothing to inject (no file, or only the header).
 * The prefix is wrapped in delimited markers so it doesn't bleed into
 * the rest of the prompt and the model knows it's persistent context.
 */
export function buildMemoryPrefix() {
  const raw = loadUserMemory().trim();
  if (!raw || raw.replace(/^#.*$/gm, '').replace(/^Things NHA.*$/gm, '').trim().length === 0) {
    return '';
  }
  return `[USER MEMORY — persistent across all conversations]\n${raw}\n[END USER MEMORY]\n\n`;
}
