/** First-run provisioner — creates ~/.nha/ and installs the agents shipped with the package */

import fs from 'fs';
import {
  NHA_DIR, CORE_DIR, AGENTS_DIR, EXTENSIONS_DIR, SESSIONS_DIR, MEMORY_DIR,
  BASE_URL, LEGION_FILE, PIF_FILE, VERSIONS_FILE,
} from './constants.mjs';
import { download } from './downloader.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { bundledLegionVersion, syncBundledAgents } from './legion-bundle.mjs';
import { banner, info, ok, fail, warn } from './ui.mjs';

/**
 * Check if bootstrap is needed (agents not installed yet).
 */
export function needsBootstrap() {
  if (!fs.existsSync(LEGION_FILE) || !fs.existsSync(AGENTS_DIR)) return true;
  // Also check that at least one agent file exists (dir may be empty after failed install)
  try {
    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.mjs'));
    if (files.length === 0) return true;
  } catch { return true; }
  return false;
}

/**
 * Run full bootstrap: create dirs, install the bundled agents.
 * Legion X and the agents come from the package itself, so this works offline.
 * Only PIF (the client of the NHA platform) is still fetched, and its absence
 * stops nothing else.
 */
export async function bootstrap() {
  banner();
  info('First run detected — setting up NHA...\n');

  // ── Create directory structure ───────────────────────────────────────────
  for (const dir of [NHA_DIR, CORE_DIR, AGENTS_DIR, EXTENSIONS_DIR, SESSIONS_DIR, MEMORY_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  ok('Created ~/.nha/ directory structure');

  // ── Legion X and the agents, from the package ────────────────────────────
  if (!fs.existsSync(LEGION_FILE)) {
    fail('Legion X is missing from this installation. Reinstall: npm install -g nothumanallowed');
    process.exit(1);
  }
  ok(`Legion X v${bundledLegionVersion()} ready`);

  const agents = syncBundledAgents();
  if (agents.missing.length > 0) {
    fail(`${agents.missing.length} agents are missing from this installation (${agents.missing.join(', ')}). Reinstall: npm install -g nothumanallowed`);
    process.exit(1);
  }
  ok(`${agents.copied} agents installed in ~/.nha/agents`);

  // ── PIF, the client of the NHA platform (optional) ───────────────────────
  const versionsOk = await download(`${BASE_URL}/versions.json`, VERSIONS_FILE);
  const pifOk = versionsOk && await download(`${BASE_URL}/pif.mjs`, PIF_FILE, { timeout: 60_000 });
  if (pifOk) {
    ok('PIF installed');
  } else {
    warn('PIF could not be downloaded: the "nha pif" and "nha mcp" commands stay unavailable. Everything else works.');
  }

  // ── Initialize config (migrates legacy if present) ───────────────────────
  const config = loadConfig();
  saveConfig(config);

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log('');
  ok('NHA is ready!\n');

  if (!config.llm.apiKey) {
    console.log(`  ${'\x1b[1;33m'}Next step:${'\x1b[0m'} choose where your models run:\n`);
    console.log(`  ${'\x1b[1;36m'}Option 1 — Your own API key:${'\x1b[0m'}`);
    console.log(`    nha config set provider anthropic`);
    console.log(`    nha config set key sk-ant-api03-YOUR_KEY_HERE`);
    console.log(`    ${'\x1b[2m'}Supported: anthropic, openai, gemini, deepseek, grok, mistral, cohere${'\x1b[0m'}\n`);
    console.log(`  ${'\x1b[1;32m'}Option 2 — A local model, no key (deliberations with "nha run"):${'\x1b[0m'}`);
    console.log(`    nha config set legion-provider ollama`);
    console.log(`    nha config set ollama-model qwen2.5:7b`);
    console.log(`    ${'\x1b[2m'}Any model served by Ollama, or any OpenAI-compatible endpoint (local-openai-url).${'\x1b[0m'}\n`);
  }

  return true;
}
