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

/**
 * Auto-extract memorable facts from a user turn and append them to memory.
 * Mirrors ChatGPT's "Memory" auto-learn: scans the message for explicit
 * "remember that..." / "ricorda che..." instructions AND for implicit
 * personal facts (name, location, role, preferences, deadlines, contacts).
 *
 * Designed to be CHEAP: runs ONLY when the user message contains a likely
 * signal ("ricord", "remember", "preferisco", "mi chiamo", "lavoro come",
 * "ho un appuntamento", "uso sempre", etc.). Skips noise.
 *
 * @param {string} userText
 * @param {object} config — NHA config (needs llm provider)
 * @returns {Promise<string|null>} the new memory line if learned, else null
 */
export async function autoLearnFromTurn(userText, config) {
  if (!userText || typeof userText !== 'string' || userText.length < 8) return null;
  // Cheap pre-filter — only call the LLM if the text plausibly contains a fact.
  const trigger = /\b(ricord[aiy]|memorizz[aiy]|salv[aiy]\s+che|tieni\s+a\s+mente|prefer(isco|isci)|mi\s+chiamo|sono\s+(un|una)\b|lavoro\s+(come|presso|in)\b|abito\s+(a|in)\b|vivo\s+(a|in)\b|uso\s+sempre|preferenza|impostazione|deadline|scadenza|ho\s+un\s+(appuntament|incontro)|il\s+mio\s+(nome|email|telefon|indirizz)|api\s+key|password|remember\s+that|please\s+remember|note\s+that|my\s+name\s+is|i\s+work\s+as|i\s+live\s+in|i\s+prefer|i\s+use\s+always)\b/i;
  if (!trigger.test(userText)) return null;

  try {
    const { callLLM } = await import('./llm.mjs');
    const systemPrompt =
      'You are a memory extractor. Read the user message and decide if there is ONE durable fact, preference, or piece of personal context worth remembering across future conversations. ' +
      'Return STRICT JSON: {"memorable": true|false, "fact": "concise fact in the user language, max 140 chars"} or {"memorable": false}. ' +
      'Memorable: name, role, location, language preference, communication style, recurring contacts, long-term projects, API keys/IDs (only id, NOT secrets), tools they use, hard preferences. ' +
      'NOT memorable: greetings, transient questions, one-off tasks, weather, news, anything that expires within a day. ' +
      'NEVER fabricate facts that the user did not explicitly state.';
    const raw = await callLLM(config, systemPrompt, userText, { max_tokens: 150, temperature: 0.1 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!parsed.memorable || !parsed.fact || typeof parsed.fact !== 'string') return null;
    const fact = parsed.fact.trim().slice(0, 140);
    if (!fact) return null;
    // Deduplicate: skip if a near-identical fact is already in memory.
    const existing = loadUserMemory().toLowerCase();
    const factLow = fact.toLowerCase();
    // Very rough dedup: if the first 30 chars of the new fact appear in
    // memory already, skip. Avoid LLM-driven dedup loop (would be expensive).
    if (factLow.length > 20 && existing.includes(factLow.slice(0, Math.min(30, factLow.length)))) {
      return null;
    }
    addUserMemory(`(auto) ${fact}`);
    return fact;
  } catch { return null; }
}
