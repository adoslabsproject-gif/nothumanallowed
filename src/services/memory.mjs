/**
 * Per-agent episodic memory with TF-IDF keyword retrieval.
 *
 * Zero dependencies — pure local keyword matching.
 * Each agent gets its own memory file at ~/.nha/memory/<agent-name>.json
 *
 * Memory entries are created AFTER each agent interaction by extracting
 * key facts from the response using heuristic rules (no LLM calls).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MEMORY_DIR } from '../constants.mjs';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_ENTRIES_PER_AGENT = 100;
const MAX_CHAT_HISTORY_TURNS = 200;
const MAX_MEMORY_CONTEXT_CHARS = 500;
const CHAT_HISTORY_FILE = path.join(MEMORY_DIR, 'chat-history.json');
const GLOBAL_PREFS_FILE = path.join(MEMORY_DIR, '_global-preferences.json');

/** Stopwords excluded from keyword extraction and TF-IDF scoring. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'under', 'and',
  'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
  'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'same', 'than', 'too', 'very', 'just', 'because',
  'if', 'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'this',
  'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their',
  'also', 'about', 'up', 'out', 'then', 'here', 'there', 'now', 'one',
  'two', 'like', 'over', 'well', 'even', 'back', 'much', 'get', 'go',
  'make', 'think', 'know', 'take', 'see', 'come', 'look', 'use', 'find',
  'give', 'tell', 'say', 'said', 'want', 'way', 'thing', 'things', 'let',
  'still', 'try', 'ask', 'work', 'call', 'first', 'last', 'long', 'great',
  'little', 'own', 'old', 'right', 'big', 'high', 'different', 'small',
  'large', 'next', 'early', 'young', 'important', 'public', 'bad', 'new',
  'good', 'sure', 'yes', 'no', 'dont', 'dont', 'ive', 'its', 'thats',
  'really', 'using', 'used', 'based', 'note', 'please', 'help', 'thanks',
]);

// ── Agent-specific extraction patterns ───────────────────────────────────────

const AGENT_PATTERNS = {
  saber: {
    keywords: ['vulnerability', 'cve', 'exploit', 'injection', 'xss', 'csrf',
      'sqli', 'rce', 'ssrf', 'auth', 'bypass', 'privilege', 'escalation',
      'misconfiguration', 'exposure', 'leak', 'breach', 'scan', 'pentest',
      'hardening', 'firewall', 'tls', 'certificate', 'encryption', 'hash',
      'secret', 'token', 'owasp', 'severity', 'critical', 'high', 'medium',
      'low', 'patch', 'remediation', 'mitigation'],
    importanceBoost: 1,
  },
  oracle: {
    keywords: ['metric', 'pattern', 'trend', 'analysis', 'data', 'insight',
      'correlation', 'regression', 'anomaly', 'outlier', 'forecast',
      'prediction', 'accuracy', 'precision', 'recall', 'f1', 'score',
      'performance', 'latency', 'throughput', 'error-rate', 'uptime',
      'degradation', 'improvement', 'baseline', 'benchmark'],
    importanceBoost: 0,
  },
  herald: {
    keywords: ['colleague', 'team', 'meeting', 'standup', 'retro', 'sprint',
      'communication', 'email', 'slack', 'mention', 'feedback', 'review',
      'decision', 'action-item', 'follow-up', 'deadline', 'blocker',
      'dependency', 'stakeholder', 'manager', 'report'],
    importanceBoost: 0,
  },
  conductor: {
    keywords: ['workflow', 'pipeline', 'task', 'automation', 'schedule',
      'cron', 'trigger', 'step', 'stage', 'deployment', 'build', 'test',
      'ci', 'cd', 'release', 'rollback', 'retry', 'timeout', 'parallel',
      'sequential', 'dependency', 'orchestration', 'completion', 'failure'],
    importanceBoost: 0,
  },
};

// ── Universal extraction patterns ────────────────────────────────────────────

/** Patterns that indicate a user preference or correction. */
const PREFERENCE_PATTERNS = [
  /(?:i\s+prefer|i\s+like|i\s+want|i\s+always|i\s+never|i\s+usually|my\s+preference|please\s+always|please\s+never|don'?t\s+(?:ever|always))\s+(.{10,120})/gi,
  /(?:remember\s+that|keep\s+in\s+mind|note\s+that|fyi|for\s+future\s+reference)\s+(.{10,150})/gi,
  /(?:actually|no,?\s+i\s+meant|correction:|i\s+meant|that'?s\s+wrong|not\s+(?:that|what))\s+(.{10,120})/gi,
];

/** Patterns that indicate a factual finding worth remembering. */
const FINDING_PATTERNS = [
  /(?:found|discovered|detected|identified|noticed|observed)\s+(.{15,200})/gi,
  /(?:the\s+(?:issue|problem|bug|error|cause|root\s+cause|solution|fix)\s+(?:is|was))\s+(.{10,200})/gi,
  /(?:recommend(?:ation)?|suggest(?:ion)?|advise|should)\s*:?\s+(.{15,200})/gi,
  /(?:result|conclusion|summary|finding)\s*:?\s+(.{15,200})/gi,
];

// ── File I/O ─────────────────────────────────────────────────────────────────

function ensureMemoryDir() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function getAgentMemoryPath(agentName) {
  const sanitized = agentName.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  return path.join(MEMORY_DIR, `${sanitized}.json`);
}

function readMemoryFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* corrupt file — start fresh */ }
  return [];
}

function writeMemoryFile(filePath, entries) {
  ensureMemoryDir();
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

// ── Text Processing (TF-IDF) ────────────────────────────────────────────────

/**
 * Tokenize text into lowercase alphanumeric terms, remove stopwords.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Compute term frequency map for a token array.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function termFrequency(tokens) {
  const tf = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  // Normalize by total tokens
  const total = tokens.length || 1;
  for (const [k, v] of tf) {
    tf.set(k, v / total);
  }
  return tf;
}

/**
 * Compute inverse document frequency for a term across a corpus of entries.
 * @param {string} term
 * @param {Array<{keywords: string[]}>} corpus
 * @returns {number}
 */
function inverseDocFreq(term, corpus) {
  if (corpus.length === 0) return 1;
  let count = 0;
  for (const doc of corpus) {
    if (doc.keywords && doc.keywords.includes(term)) count++;
  }
  // Smooth IDF: log(N / (1 + df)) + 1
  return Math.log(corpus.length / (1 + count)) + 1;
}

/**
 * Score a memory entry against a query using TF-IDF keyword overlap.
 * Higher = more relevant.
 *
 * @param {object} entry — memory entry with { keywords, summary, context }
 * @param {string[]} queryTokens — tokenized query
 * @param {Array<object>} corpus — all entries for IDF computation
 * @returns {number}
 */
function scoreEntry(entry, queryTokens, corpus) {
  if (!entry.keywords || entry.keywords.length === 0) return 0;

  const queryTf = termFrequency(queryTokens);
  let score = 0;

  for (const [term, tf] of queryTf) {
    if (entry.keywords.includes(term)) {
      const idf = inverseDocFreq(term, corpus);
      score += tf * idf;
    }
  }

  // Bonus for importance (slight boost for high-importance memories)
  score *= 1 + (entry.importance - 3) * 0.1;

  // Recency bonus: memories from last 24h get a small boost
  const ageHours = (Date.now() - new Date(entry.timestamp).getTime()) / 3600000;
  if (ageHours < 24) score *= 1.15;
  else if (ageHours < 168) score *= 1.05; // last 7 days

  return score;
}

// ── Keyword Extraction ───────────────────────────────────────────────────────

/**
 * Extract the top-N most distinctive keywords from text.
 * Uses term frequency ranking — no external embedding needed.
 *
 * @param {string} text
 * @param {number} maxKeywords
 * @returns {string[]}
 */
function extractKeywords(text, maxKeywords = 15) {
  const tokens = tokenize(text);
  const freq = new Map();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }

  // Sort by frequency descending, then alphabetically for stability
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxKeywords)
    .map(([term]) => term);
}

// ── Heuristic Memory Extraction ──────────────────────────────────────────────

/**
 * Extract a concise summary from the agent's response using heuristics.
 * Returns the first meaningful sentence or pattern match.
 *
 * @param {string} response
 * @returns {string}
 */
function extractSummary(response) {
  if (!response) return '';

  // Try to find a key finding or recommendation
  for (const pattern of FINDING_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(response);
    if (match && match[1]) {
      return match[1].trim().slice(0, 200);
    }
  }

  // Fallback: first non-trivial sentence (>30 chars, not a greeting)
  const sentences = response
    .replace(/```[\s\S]*?```/g, '') // strip code blocks
    .replace(/\n+/g, '. ')
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 30 && !/^(hi|hello|hey|sure|ok|great|thanks)/i.test(s));

  if (sentences.length > 0) {
    return sentences[0].slice(0, 200);
  }

  // Last resort: first 200 chars
  return response.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Determine importance (1-5) based on content analysis.
 *
 * @param {string} agentName
 * @param {string} userQuery
 * @param {string} agentResponse
 * @returns {number}
 */
function computeImportance(agentName, userQuery, agentResponse) {
  const combined = (userQuery + ' ' + agentResponse).toLowerCase();
  let importance = 3; // default: medium

  // Check for agent-specific high-value keywords
  const agentConfig = AGENT_PATTERNS[agentName];
  if (agentConfig) {
    let domainHits = 0;
    for (const kw of agentConfig.keywords) {
      if (combined.includes(kw)) domainHits++;
    }
    if (domainHits >= 5) importance += 1;
    if (domainHits >= 10) importance += 1;
    importance += agentConfig.importanceBoost;
  }

  // User corrections/preferences are always high importance
  for (const pattern of PREFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(userQuery)) {
      importance = Math.max(importance, 4);
      break;
    }
  }

  // Errors/vulnerabilities are high importance
  if (/critical|severe|urgent|emergency|breach|exploit|vulnerab/i.test(combined)) {
    importance = Math.max(importance, 4);
  }

  // Clamp to [1, 5]
  return Math.max(1, Math.min(5, importance));
}

/**
 * Detect if the user query contains a preference or correction.
 * @param {string} query
 * @returns {string|null} — the preference text, or null
 */
function detectPreference(query) {
  for (const pattern of PREFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(query);
    if (match && match[1]) {
      return match[1].trim().slice(0, 150);
    }
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Save a new memory entry for an agent.
 *
 * @param {string} agentName
 * @param {{summary: string, keywords: string[], context: string, importance: number}} entry
 * @returns {object} — the saved entry (with id and timestamp added)
 */
export function saveMemory(agentName, entry) {
  const filePath = getAgentMemoryPath(agentName);
  const entries = readMemoryFile(filePath);

  const record = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    summary: entry.summary || '',
    keywords: entry.keywords || [],
    context: entry.context || '',
    importance: Math.max(1, Math.min(5, entry.importance || 3)),
  };

  entries.push(record);
  writeMemoryFile(filePath, entries);

  // Auto-prune if over limit
  if (entries.length > MAX_ENTRIES_PER_AGENT) {
    pruneMemories(agentName);
  }

  return record;
}

/**
 * Retrieve the most relevant memories for a query, ranked by TF-IDF score.
 *
 * @param {string} agentName
 * @param {string} query
 * @param {number} limit — max results (default 5)
 * @returns {object[]} — ranked memory entries
 */
export function getRelevantMemories(agentName, query, limit = 5) {
  const filePath = getAgentMemoryPath(agentName);
  const entries = readMemoryFile(filePath);
  if (entries.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    // No meaningful query tokens — return most recent high-importance entries
    return entries
      .filter(e => e.importance >= 3)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  // Score all entries
  const scored = entries.map(entry => ({
    entry,
    score: scoreEntry(entry, queryTokens, entries),
  }));

  // Filter zero-score entries, sort by score descending
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.entry);
}

/**
 * Get all memories for an agent, sorted by timestamp (newest first).
 *
 * @param {string} agentName
 * @returns {object[]}
 */
export function getAllMemories(agentName) {
  const filePath = getAgentMemoryPath(agentName);
  return readMemoryFile(filePath)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Prune memories: keep at most MAX_ENTRIES_PER_AGENT.
 * Strategy: remove oldest entries with importance <= 2 first,
 * then oldest importance 3, preserving importance 4-5 as long as possible.
 *
 * @param {string} agentName
 * @returns {number} — number of entries removed
 */
export function pruneMemories(agentName) {
  const filePath = getAgentMemoryPath(agentName);
  const entries = readMemoryFile(filePath);

  if (entries.length <= MAX_ENTRIES_PER_AGENT) return 0;

  const before = entries.length;

  // Sort: high importance first, then recent first
  entries.sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  // Keep only the top MAX_ENTRIES_PER_AGENT
  const pruned = entries.slice(0, MAX_ENTRIES_PER_AGENT);

  // Re-sort by timestamp for storage
  pruned.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  writeMemoryFile(filePath, pruned);
  return before - pruned.length;
}

/**
 * Auto-extract key facts from an agent interaction and save as a memory.
 * Uses heuristic patterns — zero LLM calls.
 *
 * @param {string} agentName
 * @param {string} userQuery
 * @param {string} agentResponse
 * @returns {object|null} — the saved entry, or null if nothing worth remembering
 */
export function extractMemory(agentName, userQuery, agentResponse) {
  if (!agentResponse || agentResponse.length < 50) return null;

  const summary = extractSummary(agentResponse);
  if (!summary || summary.length < 20) return null;

  const combined = userQuery + ' ' + agentResponse;
  const keywords = extractKeywords(combined);
  if (keywords.length < 3) return null;

  const importance = computeImportance(agentName, userQuery, agentResponse);

  // Build concise context: what was asked + key finding
  const querySnippet = userQuery.slice(0, 100);
  const context = `Q: ${querySnippet} | A: ${summary}`;

  const entry = saveMemory(agentName, {
    summary,
    keywords,
    context,
    importance,
  });

  // Check for user preferences to save globally
  const preference = detectPreference(userQuery);
  if (preference) {
    saveGlobalPreference(agentName, preference);
  }

  return entry;
}

/**
 * Build a concise memory context string to inject into an agent's prompt.
 * Capped at MAX_MEMORY_CONTEXT_CHARS.
 *
 * @param {string} agentName
 * @param {string} query
 * @returns {string} — memory context block, or empty string if no relevant memories
 */
export function buildMemoryContext(agentName, query) {
  const memories = getRelevantMemories(agentName, query, 5);
  const globalCtx = getGlobalContext();

  if (memories.length === 0 && !globalCtx) return '';

  const parts = [];

  if (globalCtx) {
    parts.push(`[User prefs] ${globalCtx}`);
  }

  for (const mem of memories) {
    const age = formatAge(mem.timestamp);
    parts.push(`[${age}] ${mem.summary}`);
  }

  let context = parts.join(' | ');

  // Enforce character limit
  if (context.length > MAX_MEMORY_CONTEXT_CHARS) {
    context = context.slice(0, MAX_MEMORY_CONTEXT_CHARS - 3) + '...';
  }

  return `\n\n[EPISODIC MEMORY — relevant past interactions]\n${context}`;
}

// ── Global Preferences ───────────────────────────────────────────────────────

/**
 * Save a user preference detected across any agent interaction.
 *
 * @param {string} sourceAgent
 * @param {string} preference
 */
function saveGlobalPreference(sourceAgent, preference) {
  ensureMemoryDir();
  let prefs = [];
  try {
    if (fs.existsSync(GLOBAL_PREFS_FILE)) {
      prefs = JSON.parse(fs.readFileSync(GLOBAL_PREFS_FILE, 'utf-8'));
    }
  } catch { prefs = []; }

  // Deduplicate: skip if a very similar preference already exists
  const normalized = preference.toLowerCase().replace(/\s+/g, ' ');
  for (const existing of prefs) {
    const existingNorm = existing.text.toLowerCase().replace(/\s+/g, ' ');
    if (existingNorm === normalized) return;
    // Jaccard similarity on tokens — skip if >70% overlap
    const a = new Set(tokenize(normalized));
    const b = new Set(tokenize(existingNorm));
    const intersection = [...a].filter(x => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    if (union > 0 && intersection / union > 0.7) return;
  }

  prefs.push({
    text: preference,
    source: sourceAgent,
    timestamp: new Date().toISOString(),
  });

  // Cap at 50 preferences
  if (prefs.length > 50) {
    prefs = prefs.slice(-50);
  }

  fs.writeFileSync(GLOBAL_PREFS_FILE, JSON.stringify(prefs, null, 2) + '\n', 'utf-8');
}

/**
 * Get a cross-agent summary of user preferences.
 * Returns a concise string (max 200 chars) of the most recent preferences.
 *
 * @returns {string} — preferences summary, or empty string
 */
export function getGlobalContext() {
  try {
    if (!fs.existsSync(GLOBAL_PREFS_FILE)) return '';
    const prefs = JSON.parse(fs.readFileSync(GLOBAL_PREFS_FILE, 'utf-8'));
    if (!prefs || prefs.length === 0) return '';

    // Take the 5 most recent preferences
    const recent = prefs.slice(-5);
    const summary = recent.map(p => p.text).join('; ');
    return summary.length > 200 ? summary.slice(0, 197) + '...' : summary;
  } catch {
    return '';
  }
}

// ── Chat History Persistence ─────────────────────────────────────────────────

/**
 * Load persisted chat history (last N turns).
 *
 * @returns {Array<{role: string, content: string}>}
 */
export function loadChatHistory() {
  try {
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
      if (Array.isArray(data)) return data.slice(-MAX_CHAT_HISTORY_TURNS * 2);
    }
  } catch { /* corrupt — start fresh */ }
  return [];
}

/**
 * Persist chat history to disk.
 * Keeps only the last MAX_CHAT_HISTORY_TURNS pairs.
 *
 * @param {Array<{role: string, content: string}>} history
 */
export function saveChatHistory(history) {
  ensureMemoryDir();
  const trimmed = history.slice(-MAX_CHAT_HISTORY_TURNS * 2);
  fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(trimmed, null, 2) + '\n', 'utf-8');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a timestamp into a human-readable age string.
 * @param {string} isoTimestamp
 * @returns {string}
 */
function formatAge(isoTimestamp) {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
