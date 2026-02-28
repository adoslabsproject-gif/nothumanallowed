#!/usr/bin/env node
/**
 * Liara — Session Reconciler
 *
 * Scans ALL session files in ~/.legion/sessions/ and reconciles them
 * into progress.json. Sessions that match a domain prompt AND pass
 * the quality gate are added to progress.completed.
 *
 * This handles:
 * - Sessions from manual runs (before the runner existed)
 * - Sessions from runner instances that crashed before saving progress
 * - Sessions from ANY domain, not just the currently running one
 *
 * Usage:
 *   node reconcile.mjs              # Reconcile and update progress.json
 *   node reconcile.mjs --dry-run    # Preview without writing
 *   node reconcile.mjs --stats      # Show current stats only
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPTS_DIR = join(__dirname, 'prompts');
const PROGRESS_FILE = join(__dirname, 'progress.json');
const SESSIONS_DIR = join(__dirname, '..', 'sessions');

// ============================================================================
// Quality Gate — IDENTICAL to deliberation-runner.mjs
// ============================================================================

const MIN_TRAINING_QUALITY = 0.80;
const VALID_AGENTS = new Set([
  'ade', 'athena', 'atlas', 'babel', 'cartographer', 'cassandra', 'conductor',
  'cron', 'echo', 'edi', 'epicure', 'flux', 'forge', 'glitch', 'heimdall',
  'herald', 'hermes', 'jarvis', 'link', 'logos', 'macro', 'mercury', 'murasaki',
  'muse', 'navi', 'oracle', 'pipe', 'polyglot', 'prometheus', 'quill', 'saber',
  'sauron', 'scheherazade', 'shell', 'shogun', 'tempest', 'veritas', 'zero',
]);
const ERROR_PATTERNS = [/API error/i, /credit balance/i, /service unavailable/i, /fetch failed/i, /ECONNREFUSED/i, /rate limit exceeded/i, /quota exceeded/i];

function applyQualityGate(sessionData) {
  const quality = sessionData.qualityScore || 0;
  const proposals = sessionData.proposals || [];
  const uniqueAgents = [...new Set(proposals.map(p => p.agentName).filter(a => a && a !== 'CASSANDRA'))];
  const errorProposals = proposals.filter(p => {
    const c = p.content || '';
    return ERROR_PATTERNS.some(pat => pat.test(c)) || c.length < 50;
  });
  const synthLen = (sessionData.synthesis || '').length;

  const reasons = [];
  if (quality < MIN_TRAINING_QUALITY) reasons.push(`Q=${(quality * 100).toFixed(0)}%<80%`);
  // NOTE: We do NOT check missing providers for reconciliation — manual runs may only use one provider
  // The runner's strict 5-provider check was for NEW runs; old sessions are valuable regardless
  const hallucinatedAgents = uniqueAgents.filter(a => !VALID_AGENTS.has(a.toLowerCase()));
  if (hallucinatedAgents.length > 0) reasons.push(`fake:${hallucinatedAgents.join(',')}`);
  if (errorProposals.length > 0) reasons.push(`${errorProposals.length} API errors`);
  if (uniqueAgents.length < 4) reasons.push(`agents=${uniqueAgents.length}<4`);
  if (synthLen < 200) reasons.push(`synth=${synthLen}ch<200`);

  return {
    passed: reasons.length === 0,
    reasons,
    quality,
  };
}

// ============================================================================
// Prompt Matching — Match session prompt text to domain prompt files
// ============================================================================

/**
 * Load all prompts from all domain files.
 * Returns Map<normalizedPromptText, { domain, index, promptObj }>
 */
function loadAllPrompts() {
  const promptMap = new Map();

  if (!existsSync(PROMPTS_DIR)) {
    console.error('Error: prompts/ directory not found');
    process.exit(1);
  }

  const domainFiles = readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.json')).sort();

  for (const file of domainFiles) {
    const filePath = join(PROMPTS_DIR, file);
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    const domain = data.domain || file.replace(/\.json$/, '');
    const prompts = data.prompts || [];

    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const normalizedText = normalizePromptText(p.prompt);
      const id = `${domain}_${i + 1}`;

      // Store with the normalized prompt as key
      // If duplicate text across domains, first wins (shouldn't happen)
      if (!promptMap.has(normalizedText)) {
        promptMap.set(normalizedText, { domain, index: i + 1, id, promptObj: p });
      }
    }
  }

  return { promptMap, domainFiles };
}

/**
 * Normalize prompt text for matching.
 * Session prompts may have [QUESTION] prefix, [DELIBERATION FRAMEWORK] section,
 * [STRUCTURAL TENSION] section, and [difficulty:X] suffix added by buildLiaraPrompt().
 * We need to extract the core prompt text for matching.
 */
function normalizePromptText(text) {
  return text
    .trim()
    .replace(/\s+/g, ' ')           // collapse whitespace
    .replace(/['']/g, "'")           // normalize quotes
    .toLowerCase();
}

/**
 * Extract the core prompt from a session's prompt field.
 * The session prompt may contain the enriched version with
 * [QUESTION], [DELIBERATION FRAMEWORK], [STRUCTURAL TENSION], [difficulty:X].
 */
function extractCorePrompt(sessionPrompt) {
  if (!sessionPrompt) return '';

  let core = sessionPrompt;

  // If it starts with [QUESTION], extract just the question part
  const questionMatch = core.match(/\[QUESTION\]\s*([\s\S]*?)(?:\[DELIBERATION FRAMEWORK|$)/);
  if (questionMatch) {
    core = questionMatch[1].trim();
  }

  // Remove [difficulty:X] suffix
  core = core.replace(/\[difficulty:\w+\]\s*$/, '').trim();

  return core;
}

/**
 * Match a session prompt to a domain prompt.
 * Returns the matching prompt entry or null.
 */
function matchSessionToPrompt(sessionPrompt, promptMap) {
  if (!sessionPrompt) return null;

  const corePrompt = extractCorePrompt(sessionPrompt);
  if (!corePrompt || corePrompt.length < 20) return null;

  // Strategy 1: exact match on normalized text
  const normalized = normalizePromptText(corePrompt);
  if (promptMap.has(normalized)) {
    return promptMap.get(normalized);
  }

  // Strategy 2: substring match — session prompt contains the domain prompt (or vice versa)
  // Use first 100 chars as fingerprint to avoid O(n²) full comparison
  const fingerprint = normalized.substring(0, 100);

  for (const [key, value] of promptMap) {
    const keyFingerprint = key.substring(0, 100);

    // Check if first 100 chars match
    if (keyFingerprint === fingerprint) {
      return value;
    }

    // Check if one contains the other (for prompts that were slightly modified)
    if (key.length > 50 && normalized.length > 50) {
      // Compare first 80 chars (enough to be unique)
      if (key.substring(0, 80) === normalized.substring(0, 80)) {
        return value;
      }
    }
  }

  return null;
}

// ============================================================================
// Main
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const statsOnly = args.includes('--stats');

  // Load all domain prompts
  const { promptMap, domainFiles } = loadAllPrompts();
  const totalDomainPrompts = promptMap.size;
  console.log(`Loaded ${totalDomainPrompts} prompts from ${domainFiles.length} domain files\n`);

  // Load current progress
  let progress;
  if (existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
  } else {
    progress = {
      version: 1,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      completed: {},
      failed: {},
      skipped: {},
      stats: { totalRuns: 0, totalDurationMs: 0, avgQuality: 0, avgCiGain: 0, providerDistribution: {} },
    };
  }

  const trackedFiles = new Set(Object.values(progress.completed).map(e => e.sessionFile));
  const trackedIds = new Set(Object.keys(progress.completed));

  // Stats mode
  if (statsOnly) {
    showStats(progress, promptMap, domainFiles);
    return;
  }

  // Scan all sessions
  if (!existsSync(SESSIONS_DIR)) {
    console.error('Error: sessions directory not found');
    process.exit(1);
  }

  const sessionFiles = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).sort();
  console.log(`Found ${sessionFiles.length} session files in ${SESSIONS_DIR}`);
  console.log(`Currently tracked: ${trackedIds.size} completed, ${Object.keys(progress.failed).length} failed\n`);

  let added = 0;
  let skippedNoMatch = 0;
  let skippedQuality = 0;
  let skippedAlreadyTracked = 0;
  let skippedDuplicate = 0;
  const newEntries = [];

  for (const file of sessionFiles) {
    // Already tracked?
    if (trackedFiles.has(file)) {
      skippedAlreadyTracked++;
      continue;
    }

    const filePath = join(SESSIONS_DIR, file);
    let sessionData;
    try {
      sessionData = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      console.log(`  SKIP ${file}: corrupt JSON`);
      continue;
    }

    // Only completed sessions
    if (sessionData.status !== 'completed') {
      continue;
    }

    // Match to domain prompt
    const match = matchSessionToPrompt(sessionData.prompt, promptMap);
    if (!match) {
      skippedNoMatch++;
      continue;
    }

    const promptId = match.id;

    // Already have a completed entry for this prompt ID?
    if (trackedIds.has(promptId)) {
      // This prompt was already completed (possibly by the runner with a different session file)
      // Keep the existing entry — don't overwrite
      skippedDuplicate++;
      continue;
    }

    // Apply quality gate
    const gate = applyQualityGate(sessionData);
    if (!gate.passed) {
      skippedQuality++;
      if (!dryRun) {
        console.log(`  REJECT ${file} → ${promptId}: ${gate.reasons.join(', ')}`);
      }
      continue;
    }

    // Extract metadata
    const delib = sessionData.deliberation || {};
    const entry = {
      sessionFile: file,
      quality: sessionData.qualityScore || 0,
      ciGain: sessionData.ciGain || 0,
      rounds: sessionData.deliberationRounds || 0,
      duration: sessionData.durationMs || 0,
      provider: sessionData.provider || 'unknown',
      proposalCount: (sessionData.proposals || []).length,
      completedAt: sessionData.completedAt || new Date().toISOString(),
      liaraModeActive: !!delib.liaraMode,
      convergenceFinal: delib.convergence || 0,
      convergenceHistory: delib.convergenceHistory || [],
      minorityAgentKept: !!delib.minorityActivated,
      liaraThreshold: delib.liaraThreshold || null,
      naturalR1Convergence: delib.naturalR1Convergence || null,
      perspectivesInjected: 0, // Can't recover this from old sessions
      reconciledAt: new Date().toISOString(), // Mark as reconciled
    };

    newEntries.push({ promptId, entry, file, domain: match.domain });
    trackedIds.add(promptId); // Prevent duplicates within this run
    added++;
  }

  // Report
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Reconciliation Results`);
  console.log(`${'═'.repeat(60)}\n`);
  console.log(`  Already tracked:    ${skippedAlreadyTracked}`);
  console.log(`  No prompt match:    ${skippedNoMatch}`);
  console.log(`  Quality rejected:   ${skippedQuality}`);
  console.log(`  Duplicate prompt:   ${skippedDuplicate}`);
  console.log(`  NEW to add:         ${added}`);

  if (added > 0) {
    console.log(`\n  New entries:`);
    const byDomain = {};
    for (const e of newEntries) {
      byDomain[e.domain] = (byDomain[e.domain] || 0) + 1;
      console.log(`    ✓ ${e.promptId} ← ${e.file} (Q=${(e.entry.quality * 100).toFixed(0)}%)`);
    }
    console.log(`\n  By domain:`);
    for (const [domain, count] of Object.entries(byDomain).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${domain}: +${count}`);
    }
  }

  if (dryRun) {
    console.log(`\n  DRY RUN — no changes written`);
  } else if (added > 0) {
    // Backup
    if (existsSync(PROGRESS_FILE)) {
      writeFileSync(PROGRESS_FILE + '.pre-reconcile-bak', readFileSync(PROGRESS_FILE, 'utf-8'));
    }

    // Add entries
    for (const e of newEntries) {
      progress.completed[e.promptId] = e.entry;
    }

    // Remove from failed if now completed
    for (const e of newEntries) {
      delete progress.failed[e.promptId];
    }

    // Update stats
    const completed = Object.values(progress.completed);
    progress.stats.totalRuns = completed.length;
    progress.stats.totalDurationMs = completed.reduce((s, c) => s + (c.duration || 0), 0);
    progress.stats.avgQuality = completed.reduce((s, c) => s + (c.quality || 0), 0) / completed.length;
    progress.stats.avgCiGain = completed.reduce((s, c) => s + (c.ciGain || 0), 0) / completed.length;
    const provDist = {};
    for (const c of completed) {
      if (c.provider) provDist[c.provider] = (provDist[c.provider] || 0) + 1;
    }
    progress.stats.providerDistribution = provDist;

    progress.lastUpdated = new Date().toISOString();

    // Atomic write
    const tmpFile = PROGRESS_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(progress, null, 2));
    renameSync(tmpFile, PROGRESS_FILE);
    writeFileSync(PROGRESS_FILE + '.bak', JSON.stringify(progress, null, 2));

    console.log(`\n  ✓ progress.json updated: ${Object.keys(progress.completed).length} total completed`);
  } else {
    console.log(`\n  No new entries to add — progress.json unchanged`);
  }

  // Final stats
  showStats(progress, promptMap, domainFiles);
}

function showStats(progress, promptMap, domainFiles) {
  const completed = Object.keys(progress.completed);
  const totalCompleted = completed.length;

  // Domain breakdown
  const byDomain = {};
  const domainSizes = {};

  // Count prompts per domain
  for (const [, value] of promptMap) {
    domainSizes[value.domain] = (domainSizes[value.domain] || 0) + 1;
  }

  for (const id of completed) {
    const domain = id.replace(/_\d+$/, '');
    byDomain[domain] = (byDomain[domain] || 0) + 1;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Overall Progress — Liara Deliberation Dataset`);
  console.log(`${'═'.repeat(60)}\n`);

  const totalTarget = Object.values(domainSizes).reduce((s, n) => s + n, 0);
  const pct = totalTarget > 0 ? ((totalCompleted / totalTarget) * 100).toFixed(1) : '0.0';
  console.log(`  Total: ${totalCompleted} / ${totalTarget} (${pct}%)`);

  if (totalCompleted > 0) {
    const avgQ = (progress.stats.avgQuality * 100).toFixed(1);
    const avgCI = progress.stats.avgCiGain?.toFixed(1) || '0.0';
    console.log(`  Avg Quality: ${avgQ}%`);
    console.log(`  Avg CI Gain: +${avgCI}%`);
  }

  // Domain table
  const allDomains = [...new Set([...Object.keys(domainSizes), ...Object.keys(byDomain)])].sort();
  const domainsWithProgress = allDomains.filter(d => byDomain[d] > 0);
  const domainsEmpty = allDomains.filter(d => !byDomain[d]);

  if (domainsWithProgress.length > 0) {
    console.log(`\n  Domains with progress (${domainsWithProgress.length}):`);
    for (const d of domainsWithProgress) {
      const done = byDomain[d] || 0;
      const total = domainSizes[d] || 40;
      const bar = done >= total ? '✓ DONE' : `${done}/${total}`;
      console.log(`    ${d.padEnd(30)} ${bar}`);
    }
  }

  if (domainsEmpty.length > 0) {
    console.log(`\n  Domains not started (${domainsEmpty.length}):`);
    const perLine = 4;
    for (let i = 0; i < domainsEmpty.length; i += perLine) {
      const chunk = domainsEmpty.slice(i, i + perLine).map(d => d.padEnd(25));
      console.log(`    ${chunk.join(' ')}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}\n`);
}

main();
