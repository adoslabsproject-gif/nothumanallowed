#!/usr/bin/env node
/**
 * Liara — Deliberation Runner
 * Runs Legion X in an auto-loop for 2000 prompts, tracking progress,
 * handling failures, and supporting resume.
 *
 * Usage:
 *   node ~/.legion/liara/deliberation-runner.mjs                  # Run all remaining
 *   node ~/.legion/liara/deliberation-runner.mjs --batch-size 50  # Run 50 then stop
 *   node ~/.legion/liara/deliberation-runner.mjs --dry-run        # Preview without executing
 *   node ~/.legion/liara/deliberation-runner.mjs --status         # Show progress
 *   node ~/.legion/liara/deliberation-runner.mjs --retry-failed   # Retry all failed prompts
 *   node ~/.legion/liara/deliberation-runner.mjs --provider openai # Force provider
 *   node ~/.legion/liara/deliberation-runner.mjs --rotate-providers # Cycle through providers
 *   node ~/.legion/liara/deliberation-runner.mjs --file agricoltura.json --batch-size 1  # Single file, 1 deliberation
 *   node ~/.legion/liara/deliberation-runner.mjs --file filosofia.json   # All prompts from one domain file
 *
 * Files:
 *   Input:    ~/.legion/liara/prompts.json (default) or --file for individual domain files
 *   Progress: ~/.legion/liara/progress.json
 *   Log:      ~/.legion/liara/runner.log
 *   Sessions: ~/.legion/sessions/*.json (created by Legion X)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync, unlinkSync, statSync, renameSync, openSync, closeSync, ftruncateSync, writeSync, readSync, fsyncSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Paths
// ============================================================================

const PROMPTS_FILE = join(__dirname, 'prompts.json');
const PROMPTS_DIR = join(__dirname, 'prompts');
const PROGRESS_FILE = join(__dirname, 'progress.json');
const LOG_FILE = join(__dirname, 'runner.log');
const LEGION_CLI = join(__dirname, '..', 'legion-x.mjs');
const SESSIONS_DIR = join(__dirname, '..', 'sessions');

// ============================================================================
// Colors (ANSI)
// ============================================================================

const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

// ============================================================================
// Liara Divergence Pressure System v2 — Prompt Builder
// ============================================================================

/**
 * Build an enriched prompt with forced perspectives and anti-contamination framing.
 * For prompts with `forced_perspectives`, injects the deliberation framework.
 * For prompts without (easy/factual), returns the raw prompt text unchanged.
 *
 * @param {Object} promptObj - Prompt object from domain file
 * @returns {string} The enriched prompt text ready for Legion X
 */
// Language enforcement tag — all deliberation output MUST be in English
// regardless of the prompt language. This ensures:
// 1. Consistent tokenization (English is 30-40% more token-efficient)
// 2. Maximum model capability (analytical reasoning is strongest in English)
// 3. Cross-provider consistency (Grok/DeepSeek degrade significantly in Italian)
// 4. Clean training data for Liara LoRA (no mixed IT/EN contamination)
const LANGUAGE_TAG = '\n[LANGUAGE: English — You MUST respond entirely in English regardless of the question language. All analysis, reasoning, proposals, and conclusions must be in English. Do NOT mix languages.]\n';

function buildLiaraPrompt(promptObj) {
  const perspectives = promptObj.forced_perspectives;

  // No forced perspectives → pass prompt with difficulty hint only
  if (!perspectives || perspectives.length === 0) {
    let raw = promptObj.prompt;
    if (promptObj.difficulty) {
      raw += '\n[difficulty:' + promptObj.difficulty + ']\n';
    }
    raw += LANGUAGE_TAG;
    return raw;
  }

  let enriched = '[QUESTION]\n' + promptObj.prompt + '\n\n';

  enriched += '[DELIBERATION FRAMEWORK — INCOMPATIBLE PERSPECTIVES]\n';
  enriched += 'This question requires analysis from fundamentally incompatible frameworks.\n';
  enriched += 'Each agent MUST adopt ONE perspective. Your conclusions must derive from your framework\'s evaluation criteria.\n';
  enriched += 'You may CITE other frameworks\' findings, but you may NOT adopt another framework\'s criteria as your primary basis for conclusions.\n\n';

  for (let i = 0; i < perspectives.length; i++) {
    const p = perspectives[i];
    const letter = String.fromCharCode(65 + i); // A, B, C, D...
    enriched += `PERSPECTIVE ${letter} — ${p.role}: ${p.instruction}\n`;
    if (p.evaluation_criteria && p.evaluation_criteria.length > 0) {
      enriched += `  Primary criteria: ${p.evaluation_criteria.join(', ')}\n`;
    }
    if (p.non_primary_criteria && p.non_primary_criteria.length > 0) {
      enriched += `  You may cite but not base conclusions on: ${p.non_primary_criteria.join(', ')}\n`;
    }
    enriched += '\n';
  }

  if (promptObj.structural_conflict) {
    enriched += '[STRUCTURAL TENSION]\n';
    enriched += promptObj.structural_conflict + '\n\n';
    enriched += 'This conflict has no clean resolution. The goal is NOT consensus — it is rigorous exploration of each position\'s internal logic and its limitations when confronted with other frameworks.\n';
  }

  // Difficulty hint for liara-mode minority resilience probability
  if (promptObj.difficulty) {
    enriched += '\n[difficulty:' + promptObj.difficulty + ']\n';
  }

  enriched += LANGUAGE_TAG;

  return enriched;
}

// ============================================================================
// Provider rotation
// ============================================================================

const PROVIDERS = ['anthropic', 'openai', 'gemini', 'grok', 'deepseek'];

// ============================================================================
// Provider health detection — stop the loop if a provider is dead
// ============================================================================

/**
 * Fatal error patterns that indicate a provider is DOWN and won't recover.
 * These are NOT transient — retrying will just burn money.
 */
const FATAL_PROVIDER_PATTERNS = [
  // Credit / billing exhaustion
  { pattern: /credit balance/i, reason: 'credit balance exhausted' },
  { pattern: /insufficient.{0,20}(funds|credits|balance)/i, reason: 'insufficient funds' },
  { pattern: /billing.*(?:issue|error|limit)/i, reason: 'billing issue' },
  { pattern: /payment.*required/i, reason: 'payment required' },
  { pattern: /quota.*exceeded/i, reason: 'quota exceeded' },
  { pattern: /usage.*limit.*(?:reached|exceeded)/i, reason: 'usage limit reached' },
  // Auth failures (key revoked, expired, invalid)
  { pattern: /(?:invalid|expired|revoked).*api.?key/i, reason: 'API key invalid/expired' },
  { pattern: /(?:401|403).*(?:unauthorized|forbidden)/i, reason: 'authentication failure' },
  { pattern: /api.?key.*(?:invalid|expired|revoked)/i, reason: 'API key invalid/expired' },
  // Account-level blocks
  { pattern: /account.*(?:suspended|disabled|blocked|deactivated)/i, reason: 'account suspended' },
  { pattern: /access.*(?:denied|revoked|terminated)/i, reason: 'access denied' },
];

/**
 * Scan text for fatal provider errors.
 * Returns { fatal: boolean, provider: string|null, reason: string|null }
 */
function detectFatalProviderError(text) {
  if (!text || text.length === 0) return { fatal: false, provider: null, reason: null };

  for (const { pattern, reason } of FATAL_PROVIDER_PATTERNS) {
    if (pattern.test(text)) {
      // Try to identify which provider
      const providerMatch = text.match(/(?:anthropic|openai|gemini|google|grok|deepseek|claude|gpt)/i);
      const provider = providerMatch ? providerMatch[0].toLowerCase() : 'unknown';
      return { fatal: true, provider, reason };
    }
  }
  return { fatal: false, provider: null, reason: null };
}

/**
 * Check session proposals + stdout/stderr for fatal provider errors.
 * Returns array of { provider, reason } for each detected failure.
 */
function checkProviderHealth(sessionData, stdout, stderr) {
  const failures = [];
  const seen = new Set();

  // Check proposals for API error content — ONLY short proposals (<500 chars)
  // Long proposals are genuine deliberation text and may contain phrases like
  // "insufficient funds for infrastructure" when discussing budgets/economics.
  // Real API errors passed as proposal content are always short error messages.
  if (sessionData && sessionData.proposals) {
    for (const p of sessionData.proposals) {
      const content = p.content || '';
      if (content.length > 500) continue; // genuine deliberation, skip
      const check = detectFatalProviderError(content);
      if (check.fatal) {
        const key = `${check.provider}:${check.reason}`;
        if (!seen.has(key)) {
          seen.add(key);
          failures.push({
            provider: p.provider || check.provider,
            reason: check.reason,
            source: `proposal by ${p.agentName || 'unknown'} (R${p.round || '?'})`,
          });
        }
      }
    }
  }

  // Check validation scores for API error reasoning
  if (sessionData && sessionData.validationScores) {
    for (const v of sessionData.validationScores) {
      const reasoning = v.reasoning || '';
      const check = detectFatalProviderError(reasoning);
      if (check.fatal) {
        const key = `${check.provider}:${check.reason}`;
        if (!seen.has(key)) {
          seen.add(key);
          failures.push({ provider: check.provider, reason: check.reason, source: 'validation' });
        }
      }
    }
  }

  // Check stdout/stderr from the Legion X process
  for (const text of [stdout, stderr]) {
    if (!text) continue;
    const check = detectFatalProviderError(text);
    if (check.fatal) {
      const key = `${check.provider}:${check.reason}`;
      if (!seen.has(key)) {
        seen.add(key);
        failures.push({ provider: check.provider, reason: check.reason, source: 'process output' });
      }
    }
  }

  return failures;
}

// ============================================================================
// Parse CLI args
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    batchSize: Infinity,
    dryRun: false,
    status: false,
    retryFailed: false,
    provider: null,        // Force specific provider
    rotateProviders: false, // Cycle through providers for diversity
    cooldownMs: 15000,      // 15s between runs (avoid SENTINEL rate-detection)
    maxRetries: 3,          // Retries per failed prompt
    skipCompleted: true,    // Skip already completed prompts
    file: null,             // Single domain file from prompts/ dir
    difficulty: null,       // Filter by difficulty (easy, medium, hard)
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--batch-size':
        opts.batchSize = parseInt(args[++i], 10);
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--status':
        opts.status = true;
        break;
      case '--retry-failed':
        opts.retryFailed = true;
        break;
      case '--provider':
        opts.provider = args[++i];
        break;
      case '--rotate-providers':
        opts.rotateProviders = true;
        break;
      case '--cooldown':
        opts.cooldownMs = parseInt(args[++i], 10) * 1000;
        break;
      case '--max-retries':
        opts.maxRetries = parseInt(args[++i], 10);
        break;
      case '--file':
        opts.file = args[++i];
        break;
      case '--difficulty':
        opts.difficulty = args[++i];
        break;
      case '--help':
        printHelp();
        process.exit(0);
      default:
        console.error(`${C.red}Unknown option: ${args[i]}${C.reset}`);
        process.exit(1);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
${C.bold}Liara — Deliberation Runner${C.reset}

${C.cyan}Usage:${C.reset}
  node deliberation-runner.mjs [options]

${C.cyan}Options:${C.reset}
  --batch-size <n>     Run at most n deliberations then stop (default: all)
  --dry-run            Preview what would run without executing
  --status             Show progress statistics and exit
  --retry-failed       Retry all failed prompts
  --provider <name>    Force a specific LLM provider (anthropic, openai, etc.)
  --rotate-providers   Cycle through providers for dataset diversity
  --cooldown <sec>     Seconds between runs (default: 15)
  --max-retries <n>    Max retries per failed prompt (default: 3)
  --file <name.json>   Load prompts from a single domain file in prompts/ dir
  --difficulty <level>  Filter by difficulty (easy, medium, hard)
  --help               Show this help

${C.cyan}Examples:${C.reset}
  node deliberation-runner.mjs --file agricoltura.json --batch-size 1
  node deliberation-runner.mjs --file filosofia.json --difficulty hard
  node deliberation-runner.mjs --file cybersecurity.json --dry-run

${C.cyan}Resume:${C.reset}
  Ctrl+C to gracefully stop. Re-run the same command to resume.
  Progress is saved after each deliberation in progress.json.
  `);
}

// ============================================================================
// Progress management
// ============================================================================

/**
 * Progress structure:
 * {
 *   version: 1,
 *   startedAt: ISO string,
 *   lastUpdated: ISO string,
 *   completed: { [promptId]: { sessionFile, quality, ciGain, rounds, duration, provider, completedAt } },
 *   failed: { [promptId]: { error, attempts, lastAttempt } },
 *   skipped: { [promptId]: { reason } },
 *   stats: { totalRuns, totalDurationMs, avgQuality, avgCiGain, providerDistribution }
 * }
 */

/**
 * Load progress with auto-recovery.
 * If progress.json is corrupt or missing entries that exist as session files,
 * rebuild from disk. Also loads from .bak if primary is corrupt.
 */
function loadProgress() {
  let data = null;

  // Try primary file
  if (existsSync(PROGRESS_FILE)) {
    try {
      data = JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
    } catch {
      console.error(`${C.yellow}Warning: Corrupt progress.json, trying backup...${C.reset}`);
    }
  }

  // Try backup if primary failed
  if (!data && existsSync(PROGRESS_FILE + '.bak')) {
    try {
      data = JSON.parse(readFileSync(PROGRESS_FILE + '.bak', 'utf-8'));
      console.error(`${C.yellow}Recovered from progress.json.bak${C.reset}`);
    } catch {
      console.error(`${C.yellow}Backup also corrupt.${C.reset}`);
    }
  }

  // Start fresh if nothing worked
  if (!data || typeof data !== 'object') {
    data = {
      version: 1,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      completed: {},
      failed: {},
      skipped: {},
      stats: {
        totalRuns: 0,
        totalDurationMs: 0,
        avgQuality: 0,
        avgCiGain: 0,
        providerDistribution: {},
      },
    };
  }

  // Ensure required fields exist
  if (!data.completed) data.completed = {};
  if (!data.failed) data.failed = {};
  if (!data.skipped) data.skipped = {};
  if (!data.stats) data.stats = { totalRuns: 0, totalDurationMs: 0, avgQuality: 0, avgCiGain: 0, providerDistribution: {} };

  // ── Auto-recovery: verify that every completed entry still has a valid session file ──
  let removedOrphan = 0;
  for (const [id, entry] of Object.entries(data.completed)) {
    const filePath = join(SESSIONS_DIR, entry.sessionFile);
    if (!existsSync(filePath)) {
      delete data.completed[id];
      removedOrphan++;
    }
  }
  if (removedOrphan > 0) {
    console.error(`${C.yellow}Auto-recovery: removed ${removedOrphan} entries with missing session files${C.reset}`);
  }

  return data;
}

/**
 * Save progress with CONCURRENT-SAFE read-merge-write pattern.
 *
 * Multiple runner instances (one per domain) can run in parallel.
 * Each instance only ADDS entries — never removes entries from other domains.
 *
 * Protocol:
 * 1. Acquire a spinlock (.progress.json.write-lock)
 * 2. Read latest progress from disk (fresh, not cached)
 * 3. Merge our in-memory entries into the disk version (additive only)
 * 4. Write merged result atomically (temp + rename)
 * 5. Release spinlock
 */
function saveProgress(progress) {
  const WRITE_LOCK = PROGRESS_FILE + '.write-lock';
  const MAX_SPIN_MS = 5000;
  const SPIN_INTERVAL_MS = 50;

  // ── Spinlock acquire ──
  const spinStart = Date.now();
  while (existsSync(WRITE_LOCK)) {
    // Check if lock is stale (>30s)
    try {
      const lockAge = Date.now() - statSync(WRITE_LOCK).mtimeMs;
      if (lockAge > 30000) {
        try { unlinkSync(WRITE_LOCK); } catch {}
        break;
      }
    } catch { break; }

    if (Date.now() - spinStart > MAX_SPIN_MS) {
      logError('Write lock timeout after 5s — forcing write');
      try { unlinkSync(WRITE_LOCK); } catch {}
      break;
    }
    // Busy wait (Node.js has no sleep, but deliberation runs take minutes, so this is fine)
    const waitUntil = Date.now() + SPIN_INTERVAL_MS;
    while (Date.now() < waitUntil) { /* spin */ }
  }

  // Create lock
  try {
    writeFileSync(WRITE_LOCK, JSON.stringify({ pid: process.pid, time: Date.now() }));
  } catch {}

  try {
    // ── Read latest from disk ──
    let diskData = null;
    if (existsSync(PROGRESS_FILE)) {
      try {
        diskData = JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
      } catch {
        // Try backup
        if (existsSync(PROGRESS_FILE + '.bak')) {
          try {
            diskData = JSON.parse(readFileSync(PROGRESS_FILE + '.bak', 'utf-8'));
          } catch {}
        }
      }
    }

    // ── Merge: our in-memory data INTO disk data (additive) ──
    if (diskData && typeof diskData === 'object') {
      if (!diskData.completed) diskData.completed = {};
      if (!diskData.failed) diskData.failed = {};
      if (!diskData.skipped) diskData.skipped = {};

      // Add all our completed entries (ours win on conflict — we have fresher data for our domain)
      for (const [id, entry] of Object.entries(progress.completed)) {
        diskData.completed[id] = entry;
      }

      // Merge failed: our entries for our domain win, keep disk entries for other domains
      for (const [id, entry] of Object.entries(progress.failed)) {
        diskData.failed[id] = entry;
      }

      // Remove from failed if now completed (by us or by disk)
      for (const id of Object.keys(diskData.failed)) {
        if (diskData.completed[id]) {
          delete diskData.failed[id];
        }
      }

      // Update our in-memory state to match the merged result
      progress.completed = diskData.completed;
      progress.failed = diskData.failed;
    }

    // ── Recompute stats from merged data ──
    const allCompleted = Object.values(progress.completed);
    if (allCompleted.length > 0) {
      progress.stats = {
        totalRuns: allCompleted.length,
        totalDurationMs: allCompleted.reduce((s, c) => s + (c.duration || 0), 0),
        avgQuality: allCompleted.reduce((s, c) => s + (c.quality || 0), 0) / allCompleted.length,
        avgCiGain: allCompleted.reduce((s, c) => s + (c.ciGain || 0), 0) / allCompleted.length,
        providerDistribution: {},
      };
      for (const c of allCompleted) {
        if (c.provider) {
          progress.stats.providerDistribution[c.provider] = (progress.stats.providerDistribution[c.provider] || 0) + 1;
        }
      }
    }

    progress.lastUpdated = new Date().toISOString();

    // ── Backup current file before overwriting ──
    if (existsSync(PROGRESS_FILE)) {
      try {
        const current = readFileSync(PROGRESS_FILE, 'utf-8');
        writeFileSync(PROGRESS_FILE + '.bak', current);
      } catch {}
    }

    // ── Atomic write: temp + rename ──
    const tmpFile = PROGRESS_FILE + '.tmp.' + process.pid;
    const json = JSON.stringify(progress, null, 2);
    writeFileSync(tmpFile, json);
    renameSync(tmpFile, PROGRESS_FILE);
  } finally {
    // ── Release spinlock ──
    try { unlinkSync(WRITE_LOCK); } catch {}
  }
}

// ============================================================================
// Logging
// ============================================================================

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

function logError(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const line = `[${ts}] ERROR: ${msg}`;
  console.error(`${C.red}${line}${C.reset}`);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// ============================================================================
// Session file detection
// ============================================================================

/**
 * Find the session JSON created by Legion X after a run.
 * Strategy: find .json files in sessions dir modified after `startTime`.
 * Uses file mtime (reliable) instead of filename parsing (timezone-dependent).
 */
function findNewSessionFile(startTime) {
  if (!existsSync(SESSIONS_DIR)) return null;

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const filePath = join(SESSIONS_DIR, f);
      const mtime = statSync(filePath).mtimeMs;
      return { name: f, path: filePath, time: mtime };
    })
    .filter(f => f.time >= startTime)
    .sort((a, b) => b.time - a.time);

  return files.length > 0 ? files[0] : null;
}

function readSessionData(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ============================================================================
// Run a single deliberation
// ============================================================================

// Track active child process so SIGINT handler can protect it
let activeChild = null;

function runLegionX(prompt, provider) {
  return new Promise((resolve, reject) => {
    // Write prompt to temp file to avoid CLI argument length/escaping issues
    const promptFile = join(tmpdir(), `liara-prompt-${Date.now()}.txt`);
    writeFileSync(promptFile, prompt, 'utf-8');

    const args = [
      LEGION_CLI,
      'run',
      '--file', promptFile,
      '--no-scan',
      '--liara-mode',
    ];

    // Spawn in detached process group so Ctrl+C does NOT kill Legion X
    const child = spawn('node', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: dirname(LEGION_CLI),
      detached: true,
    });

    activeChild = child;

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      activeChild = null;
      try { unlinkSync(promptFile); } catch {}
      resolve({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      activeChild = null;
      try { unlinkSync(promptFile); } catch {}
      reject(err);
    });
  });
}

/**
 * Temporarily switch provider in legion-config.json.
 * Returns a restore function.
 */
function switchProvider(provider) {
  const configPath = join(process.env.HOME || '/Users/zelistore', '.legion-config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const originalProvider = config.llmProvider;

  if (provider && provider !== originalProvider) {
    config.llmProvider = provider;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  return () => {
    if (provider && provider !== originalProvider) {
      config.llmProvider = originalProvider;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  };
}

// ============================================================================
// Status display
// ============================================================================

function showStatus(prompts, progress, currentDomain) {
  const total = prompts.length;
  // Filter completed/failed by current domain (prompts have IDs like "ai_ml_1", "agricoltura_5")
  const domainCompletedIds = currentDomain
    ? Object.keys(progress.completed).filter(id => id.startsWith(currentDomain + '_'))
    : Object.keys(progress.completed);
  const domainFailedIds = currentDomain
    ? Object.keys(progress.failed).filter(id => id.startsWith(currentDomain + '_'))
    : Object.keys(progress.failed);
  const completedCount = domainCompletedIds.length;
  const failedCount = domainFailedIds.length;
  const remaining = Math.max(0, total - completedCount);
  const pct = ((completedCount / total) * 100).toFixed(1);

  console.log(`
${C.bold}═══════════════════════════════════════════════════${C.reset}
${C.bold}  Liara — Deliberation Progress${C.reset}
${C.bold}═══════════════════════════════════════════════════${C.reset}

  ${C.green}Completed:${C.reset}  ${completedCount} / ${total} (${pct}%)
  ${C.red}Failed:${C.reset}     ${failedCount}
  ${C.cyan}Remaining:${C.reset}  ${remaining}
  `);

  if (completedCount > 0) {
    // Compute domain-specific stats from completed entries
    let domainTotalDuration = 0;
    let domainTotalQuality = 0;
    let domainTotalCiGain = 0;
    for (const id of domainCompletedIds) {
      const entry = progress.completed[id];
      domainTotalDuration += entry.duration || 0;
      domainTotalQuality += entry.quality || 0;
      domainTotalCiGain += entry.ciGain || 0;
    }
    const avgDuration = (domainTotalDuration / completedCount / 60000).toFixed(1);
    const avgQuality = ((domainTotalQuality / completedCount) * 100).toFixed(1);
    const avgCiGain = (domainTotalCiGain / completedCount).toFixed(1);
    const eta = ((remaining * domainTotalDuration / completedCount) / 3600000).toFixed(1);

    console.log(`  ${C.dim}Avg duration:${C.reset}  ${avgDuration} min/deliberation`);
    console.log(`  ${C.dim}Avg quality:${C.reset}   ${avgQuality}%`);
    console.log(`  ${C.dim}Avg CI Gain:${C.reset}   +${avgCiGain}%`);
    console.log(`  ${C.dim}ETA:${C.reset}           ~${eta} hours (${remaining} remaining)`);
    console.log(`  ${C.dim}Total time:${C.reset}    ${(domainTotalDuration / 3600000).toFixed(1)} hours`);
  }

  if (Object.keys(progress.stats.providerDistribution).length > 0) {
    console.log(`\n  ${C.dim}Provider distribution:${C.reset}`);
    for (const [prov, count] of Object.entries(progress.stats.providerDistribution)) {
      const provPct = ((count / completedCount) * 100).toFixed(1);
      console.log(`    ${prov}: ${count} (${provPct}%)`);
    }
  }

  // Domain coverage
  const domainCoverage = {};
  for (const [id, data] of Object.entries(progress.completed)) {
    const prompt = prompts.find(p => String(p.id) === String(id));
    if (prompt) {
      domainCoverage[prompt.domain] = (domainCoverage[prompt.domain] || 0) + 1;
    }
  }
  const domainsCompleted = Object.keys(domainCoverage).length;
  const totalDomains = [...new Set(prompts.map(p => p.domain))].length;
  console.log(`\n  ${C.dim}Domain coverage:${C.reset} ${domainsCompleted} / ${totalDomains} domains`);

  // Difficulty breakdown
  const diffBreakdown = {};
  for (const [id] of Object.entries(progress.completed)) {
    const prompt = prompts.find(p => String(p.id) === String(id));
    if (prompt) {
      diffBreakdown[prompt.difficulty] = (diffBreakdown[prompt.difficulty] || 0) + 1;
    }
  }
  if (Object.keys(diffBreakdown).length > 0) {
    console.log(`\n  ${C.dim}Difficulty breakdown:${C.reset}`);
    for (const diff of ['easy', 'medium', 'hard', 'extreme']) {
      const count = diffBreakdown[diff] || 0;
      const target = prompts.filter(p => p.difficulty === diff).length;
      console.log(`    ${diff}: ${count} / ${target}`);
    }
  }

  if (failedCount > 0) {
    console.log(`\n  ${C.red}Failed prompts:${C.reset}`);
    const failedIds = Object.keys(progress.failed).slice(0, 10);
    for (const id of failedIds) {
      const f = progress.failed[id];
      const prompt = prompts.find(p => String(p.id) === String(id));
      console.log(`    #${id} [${prompt?.domain}] — ${f.error} (${f.attempts} attempts)`);
    }
    if (failedCount > 10) {
      console.log(`    ... and ${failedCount - 10} more`);
    }
  }

  console.log(`
${C.bold}═══════════════════════════════════════════════════${C.reset}
  `);
}

// ============================================================================
// Progress bar
// ============================================================================

function progressBar(current, total, width = 30) {
  const pct = current / total;
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${current}/${total} (${(pct * 100).toFixed(1)}%)`;
}

// ============================================================================
// Main loop
// ============================================================================

/**
 * Load prompts from a single domain file in prompts/ dir.
 * Converts from domain file format to runner format (same shape as prompts.json entries).
 */
function loadDomainFile(filename) {
  const filePath = join(PROMPTS_DIR, filename);
  if (!existsSync(filePath)) {
    // Try with .json extension
    const withExt = filePath.endsWith('.json') ? filePath : filePath + '.json';
    if (!existsSync(withExt)) {
      console.error(`${C.red}Error: File not found: ${filePath}${C.reset}`);
      console.error(`${C.dim}Available files:${C.reset}`);
      const available = readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.json')).sort();
      for (const f of available) {
        console.error(`  ${f}`);
      }
      process.exit(1);
    }
    return loadDomainFileFromPath(withExt);
  }
  return loadDomainFileFromPath(filePath);
}

function loadDomainFileFromPath(filePath) {
  const data = JSON.parse(readFileSync(filePath, 'utf-8'));
  const domain = data.domain || filePath.replace(/\.json$/, '').split('/').pop();
  const prompts = data.prompts || [];

  return prompts.map((p, i) => ({
    id: `${domain}_${i + 1}`,
    prompt: p.prompt,
    domain,
    difficulty: p.difficulty || 'medium',
    conflict_type: Array.isArray(p.conflict_type) ? p.conflict_type[0] : (p.conflict_type || 'unknown'),
    structural_conflict: p.structural_conflict || '',
    tags: p.tags || [],
    // Liara v2: forced perspectives + minority resilience
    forced_perspectives: p.forced_perspectives || null,
    minority_resilience: p.minority_resilience || null,
  }));
}

async function main() {
  const opts = parseArgs();

  // Load prompts — from single file or master prompts.json
  let prompts;
  let currentDomain = null; // Track active domain for filtered counting

  if (opts.file) {
    prompts = loadDomainFile(opts.file);
    currentDomain = prompts[0]?.domain || opts.file.replace(/\.json$/, '');
    log(`Loaded ${prompts.length} prompts from ${C.cyan}${opts.file}${C.reset} (domain: ${currentDomain})`);
  } else {
    if (!existsSync(PROMPTS_FILE)) {
      console.error(`${C.red}Error: prompts.json not found. Run prompt-generator.mjs first.${C.reset}`);
      console.error(`${C.dim}Or use --file <name.json> to run from a single domain file.${C.reset}`);
      process.exit(1);
    }
    prompts = JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8'));
  }

  // Filter by difficulty if specified
  if (opts.difficulty) {
    const before = prompts.length;
    prompts = prompts.filter(p => p.difficulty === opts.difficulty);
    log(`Filtered by difficulty=${opts.difficulty}: ${before} -> ${prompts.length} prompts`);
  }

  const progress = loadProgress();

  // Status mode
  if (opts.status) {
    showStatus(prompts, progress, currentDomain);
    process.exit(0);
  }

  // ── Per-domain lock: allows multiple domains to run in parallel ──
  // Each domain gets its own lock file. Running the SAME domain twice is blocked.
  const lockDomain = currentDomain || 'global';
  const LOCK_FILE = PROGRESS_FILE + `.lock.${lockDomain}`;
  if (existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      const lockAge = Date.now() - new Date(lockData.startedAt).getTime();
      const lockPid = lockData.pid;
      // Stale lock: older than 2 hours (deliberation takes max ~10 min)
      if (lockAge > 2 * 60 * 60 * 1000) {
        log(`${C.yellow}Stale lock file detected (${(lockAge / 3600000).toFixed(1)}h old, pid ${lockPid}). Removing.${C.reset}`);
        unlinkSync(LOCK_FILE);
      } else {
        // Check if the locking process is still alive
        let processAlive = false;
        try { process.kill(lockPid, 0); processAlive = true; } catch { /* process dead */ }
        if (processAlive) {
          console.error(`${C.red}Another runner for domain "${lockDomain}" is active (pid ${lockPid}, started ${lockData.startedAt}).${C.reset}`);
          console.error(`${C.red}Run a DIFFERENT domain, or kill the other runner first.${C.reset}`);
          process.exit(1);
        } else {
          log(`${C.yellow}Removing orphaned lock (pid ${lockPid} no longer running).${C.reset}`);
          unlinkSync(LOCK_FILE);
        }
      }
    } catch {
      // Corrupt lock file, remove it
      try { unlinkSync(LOCK_FILE); } catch {}
    }
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, domain: lockDomain, startedAt: new Date().toISOString() }));
  // Clean up lock on exit (normal or crash)
  const _removeLock = () => { try { unlinkSync(LOCK_FILE); } catch {} };
  process.on('exit', _removeLock);
  process.on('uncaughtException', (err) => { _removeLock(); throw err; });

  // Build queue of prompts to run
  let queue = [];

  if (opts.retryFailed) {
    // Retry mode: only run failed prompts
    const failedIds = Object.keys(progress.failed);
    queue = prompts.filter(p => failedIds.includes(String(p.id)));
    log(`Retry mode: ${queue.length} failed prompts to retry`);
    // Clear failed entries so they can be retried
    for (const id of failedIds) {
      delete progress.failed[id];
    }
    saveProgress(progress);
  } else {
    // Normal mode: run all non-completed prompts
    const completedIds = new Set(Object.keys(progress.completed));
    queue = prompts.filter(p => !completedIds.has(String(p.id)));
  }

  // Apply batch size
  if (opts.batchSize < queue.length) {
    queue = queue.slice(0, opts.batchSize);
  }

  if (queue.length === 0) {
    console.log(`${C.green}All prompts completed! Nothing to do.${C.reset}`);
    showStatus(prompts, progress, currentDomain);
    process.exit(0);
  }

  // Dry run mode
  if (opts.dryRun) {
    console.log(`${C.yellow}DRY RUN — ${queue.length} deliberations would be executed:${C.reset}\n`);
    for (let i = 0; i < Math.min(queue.length, 20); i++) {
      const p = queue[i];
      console.log(`  #${p.id} [${p.domain}/${p.conflict_type}/${p.difficulty}]`);
      console.log(`  ${C.dim}${p.prompt.slice(0, 100)}...${C.reset}\n`);
    }
    if (queue.length > 20) {
      console.log(`  ... and ${queue.length - 20} more\n`);
    }
    process.exit(0);
  }

  // Verify Legion X CLI exists
  if (!existsSync(LEGION_CLI)) {
    console.error(`${C.red}Error: Legion X CLI not found at ${LEGION_CLI}${C.reset}`);
    process.exit(1);
  }

  // Provider rotation state
  let providerIndex = 0;

  // Graceful shutdown — Ctrl+C or provider failure stops AFTER current deliberation finishes
  // CRITICAL: Do NOT kill the running Legion X process
  let stopping = false;
  let stoppingReason = '';  // 'user' or 'provider_failure'
  process.on('SIGINT', () => {
    if (stopping) {
      // Second Ctrl+C: force kill everything
      if (activeChild) {
        try { process.kill(-activeChild.pid, 'SIGKILL'); } catch {}
      }
      log('Force stop — exiting immediately');
      process.exit(1);
    }
    stopping = true;
    stoppingReason = 'user';
    if (activeChild) {
      log('Graceful stop requested (Ctrl+C) — waiting for current deliberation to finish...');
      log('The deliberation is still running. It will complete and save the session file.');
      log('Press Ctrl+C again to FORCE KILL (session will be lost).');
    } else {
      log('Graceful stop requested (Ctrl+C)');
    }
  });

  // Print header — count only current domain's completed entries
  const domainPrefix = currentDomain ? currentDomain + '_' : '';
  const completedSoFar = currentDomain
    ? Object.keys(progress.completed).filter(id => id.startsWith(domainPrefix)).length
    : Object.keys(progress.completed).length;
  const totalPrompts = prompts.length;
  console.log(`
${C.bold}═══════════════════════════════════════════════════${C.reset}
${C.bold}  Liara — Deliberation Runner${C.reset}
${C.bold}═══════════════════════════════════════════════════${C.reset}

  Total prompts:  ${totalPrompts}
  Completed:      ${completedSoFar}
  Queue:          ${queue.length}
  Batch size:     ${opts.batchSize === Infinity ? 'all' : opts.batchSize}
  Provider:       ${opts.rotateProviders ? 'rotating' : (opts.provider || 'config default')}
  Cooldown:       ${opts.cooldownMs / 1000}s
  Max retries:    ${opts.maxRetries}
${C.bold}═══════════════════════════════════════════════════${C.reset}
  `);

  log(`Starting deliberation run: ${queue.length} prompts in queue`);

  // Main loop
  let batchCompleted = 0;
  let batchFailed = 0;

  for (let i = 0; i < queue.length; i++) {
    if (stopping) break;

    const prompt = queue[i];
    const promptId = String(prompt.id);
    const runIndex = completedSoFar + batchCompleted + 1;

    // Select provider
    let provider = opts.provider;
    if (opts.rotateProviders) {
      provider = PROVIDERS[providerIndex % PROVIDERS.length];
      providerIndex++;
    }

    // Display progress
    const bar = progressBar(runIndex - 1, totalPrompts);
    console.log(`\n${C.cyan}${bar}${C.reset}`);
    log(`[${runIndex}/${totalPrompts}] Domain: ${prompt.domain} | Conflict: ${prompt.conflict_type} | Difficulty: ${prompt.difficulty}${provider ? ` | Provider: ${provider}` : ''}`);
    log(`  Prompt: ${prompt.prompt}`);

    // Run with retries
    let success = false;
    let attempts = 0;
    let lastError = '';

    while (attempts < opts.maxRetries + 1 && !stopping) {
      attempts++;

      if (attempts > 1) {
        // Exponential backoff: 10s, 30s, 90s, 270s...
        const backoffMs = Math.min(10000 * Math.pow(3, attempts - 2), 300000);
        log(`  Retry ${attempts - 1}/${opts.maxRetries} (backoff ${(backoffMs / 1000).toFixed(0)}s)...`);
        await sleep(backoffMs);
      }

      const runStartTime = Date.now();
      const restoreProvider = switchProvider(provider);

      try {
        const enrichedPrompt = buildLiaraPrompt(prompt);
        const result = await runLegionX(enrichedPrompt, provider);
        restoreProvider();

        if (result.code === 0) {
          // Success — find the session file
          const sessionFile = findNewSessionFile(runStartTime);

          if (sessionFile) {
            const sessionData = readSessionData(sessionFile.path);

            if (sessionData && sessionData.status === 'completed') {
              const duration = sessionData.durationMs || (Date.now() - runStartTime);
              const quality = sessionData.qualityScore || 0;
              const ciGain = sessionData.ciGain || 0;
              const rounds = sessionData.deliberationRounds || 0;
              const usedProvider = sessionData.provider || provider || 'unknown';
              const proposalCount = (sessionData.proposals || []).length;

              // Extract deliberation metadata (standard + liara)
              const delib = sessionData.deliberation || {};
              const convergenceHistory = delib.convergenceHistory || [];
              const convergenceFinal = delib.convergence || 0;
              const liaraModeActive = !!delib.liaraMode;
              const minorityAgentKept = !!delib.minorityActivated;
              const liaraThreshold = delib.liaraThreshold || null;
              const naturalR1Convergence = delib.naturalR1Convergence || null;
              const perspectivesInjected = prompt.forced_perspectives ? prompt.forced_perspectives.length : 0;

              // ── Quality Gate: Liara training requirements ──
              // Provider policy:
              //   - MANDATORY: anthropic, grok, deepseek — must always be present
              //   - OPTIONAL: gemini, openai — accepted if missing but quality is above threshold
              //   - MINIMUM: 4 out of 5 providers — 3 or fewer always rejected
              //   - IDEAL: all 5 — the system targets 5-provider sessions
              const MIN_TRAINING_QUALITY = 0.80;
              const MANDATORY_PROVIDERS = ['anthropic', 'deepseek', 'grok'];
              const OPTIONAL_PROVIDERS = ['gemini', 'openai'];
              const ALL_PROVIDERS = [...MANDATORY_PROVIDERS, ...OPTIONAL_PROVIDERS];
              const VALID_AGENTS = new Set([
                'ade', 'athena', 'atlas', 'babel', 'cartographer', 'cassandra', 'conductor',
                'cron', 'echo', 'edi', 'epicure', 'flux', 'forge', 'glitch', 'heimdall',
                'herald', 'hermes', 'jarvis', 'link', 'logos', 'macro', 'mercury', 'murasaki',
                'muse', 'navi', 'oracle', 'pipe', 'polyglot', 'prometheus', 'quill', 'saber',
                'sauron', 'scheherazade', 'shell', 'shogun', 'tempest', 'veritas', 'zero',
              ]);
              const ERROR_PATTERNS = [/API error/i, /credit balance/i, /service unavailable/i, /fetch failed/i, /ECONNREFUSED/i, /rate limit exceeded/i, /quota exceeded/i];

              const proposals = sessionData.proposals || [];
              const uniqueAgents = [...new Set(proposals.map(p => p.agentName).filter(a => a && a !== 'CASSANDRA'))];
              const uniqueProviders = [...new Set(proposals.map(p => p.provider).filter(p => p && p !== 'legion'))];
              const missingMandatory = MANDATORY_PROVIDERS.filter(rp => !uniqueProviders.includes(rp));
              const missingOptional = OPTIONAL_PROVIDERS.filter(rp => !uniqueProviders.includes(rp));
              const totalProviders = uniqueProviders.length;
              const hallucinatedAgents = uniqueAgents.filter(a => !VALID_AGENTS.has(a.toLowerCase()));
              const errorProposals = proposals.filter(p => {
                const c = p.content || '';
                return ERROR_PATTERNS.some(pat => pat.test(c)) || c.length < 50;
              });
              const synthLen = (sessionData.synthesis || '').length;

              // ── Deliberation completeness check ──
              // If the session claims ≥2 rounds but only has Round 1 proposals,
              // the deliberation is truncated (e.g., CASSANDRA timeout killed Round 2).
              // These sessions lack cross-reading and Tribunal — bad training data.
              const roundsWithProposals = new Set(proposals.map(p => p.round || 1));
              const claimedRounds = rounds;
              const deliberationTruncated = claimedRounds >= 2 && roundsWithProposals.size < 2;

              // Provider gate: mandatory must be present, minimum 4 total
              const providerGateFailed = missingMandatory.length > 0 || totalProviders < 4;

              // API error tolerance: if quality passes the training threshold (≥80%),
              // tolerate up to 2 errored proposals. The quality score already accounts for
              // the degraded agent pool — if 5 independent validators still rate it ≥80%,
              // the deliberation is genuinely good training data regardless of a 503 error.
              // Hard-reject only when errors are excessive (3+) or quality is below threshold.
              const errorCount = errorProposals.length;
              const errorsAreTolerable = errorCount <= 2 && quality >= MIN_TRAINING_QUALITY;

              const gateFailure = quality < MIN_TRAINING_QUALITY
                || providerGateFailed
                || hallucinatedAgents.length > 0
                || (errorCount > 0 && !errorsAreTolerable)
                || uniqueAgents.length < 4
                || synthLen < 200
                || deliberationTruncated;

              if (gateFailure) {
                const reasons = [];
                if (deliberationTruncated) reasons.push(`TRUNCATED:R2-missing(only-R${[...roundsWithProposals].join(',')})`);
                if (quality < MIN_TRAINING_QUALITY) reasons.push(`Q=${(quality * 100).toFixed(0)}%<80%`);
                if (missingMandatory.length > 0) reasons.push(`missing-mandatory:${missingMandatory.join(',')}`);
                if (totalProviders < 4) reasons.push(`providers=${totalProviders}<4`);
                if (missingOptional.length > 0 && !providerGateFailed) reasons.push(`missing-optional:${missingOptional.join(',')} (accepted)`);
                if (hallucinatedAgents.length > 0) reasons.push(`fake:${hallucinatedAgents.join(',')}`);
                if (errorProposals.length > 0) reasons.push(`${errorProposals.length} API errors`);
                if (uniqueAgents.length < 4) reasons.push(`agents=${uniqueAgents.length}<4`);
                if (synthLen < 200) reasons.push(`synth=${synthLen}ch<200`);

                // Move truncated deliberations to quarantine for manual review
                if (deliberationTruncated) {
                  const quarantineDir = join(SESSIONS_DIR, 'quarantine');
                  try {
                    const { mkdirSync } = await import('fs');
                    mkdirSync(quarantineDir, { recursive: true });
                  } catch {}
                  for (const ext of ['.json', '.md']) {
                    const src = join(SESSIONS_DIR, sessionFile.name.replace(/\.json$/, ext));
                    const dst = join(quarantineDir, sessionFile.name.replace(/\.json$/, ext));
                    try { renameSync(src, dst); } catch {}
                  }
                  log(`  ${C.red}⚠ QUARANTINED${C.reset} → sessions/quarantine/${sessionFile.name} (Round 2+ missing — no cross-reading/Tribunal)`);
                }

                progress.failed[promptId] = {
                  reason: `Below training threshold: ${reasons.join(', ')}`,
                  sessionFile: sessionFile.name,
                  lastAttempt: new Date().toISOString(),
                  attempts: (progress.failed[promptId]?.attempts || 0) + 1,
                };

                saveProgress(progress);

                const durationMin = (duration / 60000).toFixed(1);
                log(`  ${C.yellow}⚠ Below threshold${C.reset} | Quality: ${(quality * 100).toFixed(0)}% | Agents: ${uniqueAgents.length} | Providers: ${uniqueProviders.length} | ${reasons.join(', ')} | Duration: ${durationMin}m`);
                log(`  ${C.yellow}  Session saved but NOT counted as completed. Will retry.${C.reset}`);
                lastError = `Quality gate: ${reasons.join(', ')}`;
                // Don't break — retry this prompt
                continue;
              }

              progress.completed[promptId] = {
                sessionFile: sessionFile.name,
                quality,
                ciGain,
                rounds,
                duration,
                provider: usedProvider,
                proposalCount,
                completedAt: new Date().toISOString(),
                // Liara v2: divergence metrics
                liaraModeActive,
                convergenceFinal,
                convergenceHistory,
                minorityAgentKept,
                liaraThreshold,
                naturalR1Convergence,
                perspectivesInjected,
              };

              // Remove from failed if it was there
              delete progress.failed[promptId];

              saveProgress(progress);

              batchCompleted++;
              const durationMin = (duration / 60000).toFixed(1);
              const liaraTag = liaraModeActive ? ` | ${C.cyan}LIARA${C.reset} thr=${(liaraThreshold * 100).toFixed(0)}%` : '';
              const errNote = errorsAreTolerable && errorCount > 0 ? ` | ${C.yellow}${errorCount} errors tolerated (Q≥85%)${C.reset}` : '';
              log(`  ${C.green}✓ Completed${C.reset} | Quality: ${(quality * 100).toFixed(0)}% | CI Gain: +${ciGain}% | Rounds: ${rounds} | Conv: ${(convergenceFinal * 100).toFixed(0)}% | Proposals: ${proposalCount} | Duration: ${durationMin}m | Provider: ${usedProvider}${liaraTag}${errNote}`);

              // ── Provider health check ──
              const healthFailures = checkProviderHealth(sessionData, result.stdout, result.stderr);
              if (healthFailures.length > 0) {
                stopping = true;
                stoppingReason = 'provider_failure';
                log(`\n${C.red}${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`);
                log(`${C.red}${C.bold}║  PROVIDER FAILURE DETECTED — STOPPING RUNNER     ║${C.reset}`);
                log(`${C.red}${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`);
                for (const f of healthFailures) {
                  log(`${C.red}  ✗ ${f.provider}: ${f.reason} (detected in ${f.source})${C.reset}`);
                }
                log(`${C.yellow}  The current session was saved. Fix the issue and restart the runner.${C.reset}`);
              }

              success = true;
              break;
            } else {
              lastError = `Session status: ${sessionData?.status || 'unknown'}`;
              logError(`Session not completed: ${lastError}`);

              // Check if the incomplete session has provider failures
              const incompleteHealthCheck = checkProviderHealth(sessionData, result.stdout, result.stderr);
              if (incompleteHealthCheck.length > 0) {
                stopping = true;
                stoppingReason = 'provider_failure';
                log(`\n${C.red}${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`);
                log(`${C.red}${C.bold}║  PROVIDER FAILURE DETECTED — STOPPING RUNNER     ║${C.reset}`);
                log(`${C.red}${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`);
                for (const f of incompleteHealthCheck) {
                  log(`${C.red}  ✗ ${f.provider}: ${f.reason} (detected in ${f.source})${C.reset}`);
                }
                log(`${C.yellow}  Fix the issue and restart the runner.${C.reset}`);
                break;
              }
            }
          } else {
            lastError = 'No session file found after run';
            logError(lastError);
          }
        } else {
          lastError = `Exit code ${result.code}`;
          if (result.stderr) {
            const stderrShort = result.stderr.split('\n').filter(l => l.trim()).slice(-3).join(' | ');
            lastError += `: ${stderrShort.slice(0, 200)}`;
          }
          logError(`Legion X failed: ${lastError}`);

          // Provider health check on failure — stop if provider is dead
          const failureHealthCheck = checkProviderHealth(null, result.stdout, result.stderr);
          if (failureHealthCheck.length > 0) {
            stopping = true;
            stoppingReason = 'provider_failure';
            log(`\n${C.red}${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`);
            log(`${C.red}${C.bold}║  PROVIDER FAILURE DETECTED — STOPPING RUNNER     ║${C.reset}`);
            log(`${C.red}${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`);
            for (const f of failureHealthCheck) {
              log(`${C.red}  ✗ ${f.provider}: ${f.reason} (detected in ${f.source})${C.reset}`);
            }
            log(`${C.yellow}  Fix the issue and restart the runner.${C.reset}`);
            break;
          }

          // Security block detection — long backoff, no point retrying fast
          if (lastError.includes('blocked by security') || lastError.includes('Request blocked')) {
            log(`  ${C.yellow}⚠ Security block detected — waiting 120s before retry${C.reset}`);
            await sleep(120000);
          }
        }
      } catch (err) {
        restoreProvider();
        lastError = err.message;
        logError(`Exception: ${lastError}`);
      }
    }

    if (!success && !stopping) {
      batchFailed++;
      progress.failed[promptId] = {
        error: lastError,
        attempts,
        lastAttempt: new Date().toISOString(),
      };
      saveProgress(progress);
      log(`  ${C.red}✗ Failed after ${attempts} attempts${C.reset}`);
    }

    // Cooldown between runs
    if (i < queue.length - 1 && !stopping) {
      await sleep(opts.cooldownMs);
    }
  }

  // Final summary
  saveProgress(progress);

  console.log(`
${C.bold}═══════════════════════════════════════════════════${C.reset}
${C.bold}  Batch Complete${C.reset}
${C.bold}═══════════════════════════════════════════════════${C.reset}

  ${C.green}Completed:${C.reset}  ${batchCompleted}
  ${C.red}Failed:${C.reset}     ${batchFailed}
  ${stopping && stoppingReason === 'provider_failure' ? `${C.red}Stopped:${C.reset}    Provider failure detected — fix credits/keys and restart` : ''}${stopping && stoppingReason === 'user' ? `${C.yellow}Stopped:${C.reset}    Gracefully stopped by user` : ''}
  `);

  showStatus(prompts, progress, currentDomain);

  if (stopping && stoppingReason === 'provider_failure') {
    log(`STOPPED (provider failure) after ${batchCompleted} completions, ${batchFailed} failures`);
  } else if (stopping) {
    log(`Stopped (user) after ${batchCompleted} completions, ${batchFailed} failures`);
  } else {
    log(`Batch finished: ${batchCompleted} completions, ${batchFailed} failures`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error(`${C.red}Fatal error: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
