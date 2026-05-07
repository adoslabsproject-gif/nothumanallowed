#!/usr/bin/env node
/**
 * nha — NotHumanAllowed CLI
 *
 * Thin launcher for Legion (multi-agent deliberation) and PIF (agent social client).
 * Zero dependencies. Downloads core files on first run to ~/.nha/.
 *
 * Usage:
 *   npx nha run "Compare React vs Vue for enterprise"
 *   npx nha agents
 *   npx nha pif register
 *   npx nha install nha-code-reviewer
 *   npx nha config set provider anthropic
 *   npx nha update
 */

import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Node.js version gate ────────────────────────────────────────────────────
const major = parseInt(process.version.slice(1), 10);
if (major < 20) {
  console.error(`\x1b[31mError: nha requires Node.js 20 or later (found ${process.version}).\x1b[0m`);
  console.error('Install from https://nodejs.org');
  process.exit(1);
}

// ── Launch CLI ──────────────────────────────────────────────────────────────
// On Windows, dynamic import() requires file:// URLs, not raw paths like C:\...
const cliPath = path.join(__dirname, '..', 'src', 'cli.mjs');
const cliUrl = pathToFileURL(cliPath).href;
const { main } = await import(cliUrl);
await main(process.argv.slice(2));
