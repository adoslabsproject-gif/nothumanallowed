/** First-run provisioner — creates ~/.nha/ and downloads core files + agents */

import fs from 'fs';
import {
  NHA_DIR, CORE_DIR, AGENTS_DIR, EXTENSIONS_DIR, SESSIONS_DIR, MEMORY_DIR,
  BASE_URL, LEGION_FILE, PIF_FILE, VERSIONS_FILE, AGENTS,
} from './constants.mjs';
import { download, downloadBatch } from './downloader.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { banner, info, ok, fail, warn, progress } from './ui.mjs';

/**
 * Check if bootstrap is needed (core files missing).
 */
export function needsBootstrap() {
  return !fs.existsSync(LEGION_FILE) || !fs.existsSync(AGENTS_DIR);
}

/**
 * Run full bootstrap: create dirs, download everything.
 */
export async function bootstrap() {
  banner();
  info('First run detected — setting up NHA...\n');

  // ── Create directory structure ───────────────────────────────────────────
  for (const dir of [NHA_DIR, CORE_DIR, AGENTS_DIR, EXTENSIONS_DIR, SESSIONS_DIR, MEMORY_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  ok('Created ~/.nha/ directory structure');

  // ── Download version manifest ────────────────────────────────────────────
  info('Fetching version manifest...');
  const versionsOk = await download(`${BASE_URL}/versions.json`, VERSIONS_FILE);
  if (!versionsOk) {
    fail('Could not reach nothumanallowed.com — check your connection.');
    process.exit(1);
  }

  let versions;
  try {
    versions = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf-8'));
  } catch {
    fail('Corrupt versions.json');
    process.exit(1);
  }

  const legionVersion = versions['legion-x']?.latest ?? 'unknown';
  const pifVersion = versions['pif']?.latest ?? 'unknown';

  // ── Download core files ──────────────────────────────────────────────────
  info(`Downloading Legion X v${legionVersion}...`);
  const legionOk = await download(`${BASE_URL}/legion-x.mjs`, LEGION_FILE, { timeout: 60_000 });
  if (!legionOk) {
    fail('Failed to download Legion X');
    process.exit(1);
  }
  ok(`Legion X v${legionVersion} installed`);

  info(`Downloading PIF v${pifVersion}...`);
  const pifOk = await download(`${BASE_URL}/pif.mjs`, PIF_FILE, { timeout: 60_000 });
  if (!pifOk) {
    fail('Failed to download PIF');
    process.exit(1);
  }
  ok(`PIF v${pifVersion} installed`);

  // ── Download all 38 agents ───────────────────────────────────────────────
  info(`Downloading ${AGENTS.length} agents...`);
  const agentTasks = AGENTS.map(name => ({
    url: `${BASE_URL}/agents/${name}.mjs`,
    dest: `${AGENTS_DIR}/${name}.mjs`,
  }));

  const result = await downloadBatch(agentTasks, 8, (done, total) => {
    progress(done, total, `agents`);
  });

  if (result.failed > 0) {
    warn(`${result.failed} agents failed to download (run 'nha update' to retry)`);
  } else {
    ok(`${result.ok} agents installed`);
  }

  // ── Initialize config (migrates legacy if present) ───────────────────────
  const config = loadConfig();
  saveConfig(config);

  // ── Symlink sessions for backward compat ─────────────────────────────────
  const legacySessionsDir = `${process.env.HOME}/.legion/sessions`;
  if (fs.existsSync(legacySessionsDir) && !fs.existsSync(SESSIONS_DIR + '/.migrated')) {
    try {
      const files = fs.readdirSync(legacySessionsDir);
      if (files.length > 0) {
        info(`Found ${files.length} legacy session files — linked`);
      }
    } catch { /* ignore */ }
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log('');
  ok('NHA is ready!\n');

  if (!config.llm.apiKey) {
    console.log(`  ${'\x1b[1;33m'}Next step:${'\x1b[0m'} Configure your LLM provider:\n`);
    console.log(`    nha config set provider anthropic`);
    console.log(`    nha config set key sk-ant-api03-YOUR_KEY_HERE\n`);
    console.log(`  ${'\x1b[2m'}Supported: anthropic, openai, gemini, deepseek, grok, mistral, cohere${'\x1b[0m'}\n`);
  }

  return true;
}
