/**
 * Update checker and updater.
 *
 * Legion X and the agents ship inside the npm package: they are updated by
 * updating the package, never downloaded on their own. Only PIF still comes
 * from the website.
 */

import fs from 'fs';
import {
  BASE_URL, VERSIONS_FILE, LAST_UPDATE_CHECK, PIF_FILE, VERSION,
} from './constants.mjs';
import { download } from './downloader.mjs';
import { bundledLegionVersion, syncBundledAgents } from './legion-bundle.mjs';
import { info, ok, warn } from './ui.mjs';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Non-blocking check if updates are available (called at startup).
 * Only checks once per 24h. Returns update info or null.
 */
export async function checkForUpdates() {
  try {
    if (fs.existsSync(LAST_UPDATE_CHECK)) {
      const lastCheck = parseInt(fs.readFileSync(LAST_UPDATE_CHECK, 'utf-8'), 10);
      if (Date.now() - lastCheck < CHECK_INTERVAL_MS) return null;
    }

    const res = await fetch(`${BASE_URL}/versions.json`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'nha-cli/1.0.0' },
    });
    if (!res.ok) return null;

    const remote = await res.json();
    fs.writeFileSync(LAST_UPDATE_CHECK, String(Date.now()));

    // Compare with cached versions
    let local = {};
    if (fs.existsSync(VERSIONS_FILE)) {
      try { local = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf-8')); } catch {}
    }

    const updates = [];
    if (remote['pif']?.latest && remote['pif'].latest !== local['pif']?.latest) {
      updates.push({ name: 'PIF', from: local['pif']?.latest ?? '?', to: remote['pif'].latest });
    }

    return updates.length > 0 ? updates : null;
  } catch {
    return null;
  }
}

/**
 * Check if a newer version of the npm package is available.
 * Non-blocking, returns { current, latest, updateAvailable } or null.
 */
export async function checkNpmVersion() {
  try {
    const res = await fetch('https://registry.npmjs.org/nothumanallowed/latest', {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const latest = data.version;
    if (!latest) return null;

    const current = VERSION;
    const updateAvailable = compareSemver(latest, current) > 0;
    return { current, latest, updateAvailable };
  } catch {
    return null;
  }
}

/**
 * Simple semver comparison: returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Detect whether the current `nha` binary is reachable from multiple PATH
 * locations. This is the classic "I ran npm install -g but nothing changed"
 * trap on macOS where a system-wide /usr/local/bin/nha shadows a user-space
 * ~/.npm-global/bin/nha (or vice versa).
 */
async function detectDuplicateInstall() {
  try {
    const { execSync } = await import('child_process');
    const out = execSync('which -a nha 2>/dev/null', { encoding: 'utf-8' });
    const paths = out.split('\n').map(s => s.trim()).filter(Boolean);
    return paths.length > 1 ? paths : null;
  } catch { return null; }
}

/**
 * Run `npm install -g nothumanallowed@latest` from inside the CLI itself.
 * Uses --prefer-online to defeat npm's metadata cache, which is the usual
 * culprit when the user already ran "npm install -g nothumanallowed" but got
 * an older version because the manifest in cache was stale.
 */
async function npmSelfInstall(targetVersion) {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    info(`Installing nothumanallowed@${targetVersion} via npm (this may take 10-30s)...`);
    const args = [
      'install', '-g', `nothumanallowed@${targetVersion}`,
      '--registry=https://registry.npmjs.org/',
      '--prefer-online',
      '--no-fund',
      '--no-audit',
    ];
    const child = spawn('npm', args, { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', (err) => {
      warn(`npm spawn failed: ${err.message}`);
      resolve(false);
    });
  });
}

/**
 * Full update: self-upgrade the npm package (which carries Legion X and the agents) and refresh PIF.
 */
export async function runUpdate() {
  info('Checking for updates...');

  // ── npm package self-update ────────────────────────────────────────────
  // Done FIRST so the freshly installed version applies on the next invocation.
  // We bypass npm's metadata cache (--prefer-online) because that's the
  // single most common reason "I just installed and it's still old".
  let npmUpdated = false;
  const npmCheck = await checkNpmVersion();
  if (npmCheck?.updateAvailable) {
    info(`npm package: ${npmCheck.current} → ${npmCheck.latest}`);
    // Clean the local manifest cache first — defeats the stale-cache trap.
    try {
      const { execSync } = await import('child_process');
      execSync('npm cache clean --force', { stdio: 'pipe' });
    } catch { /* non-fatal */ }

    const ok2 = await npmSelfInstall(npmCheck.latest);
    if (ok2) {
      ok(`npm package upgraded to ${npmCheck.latest}`);
      npmUpdated = true;

      // Detect duplicate global installs — common on macOS.
      const dups = await detectDuplicateInstall();
      if (dups && dups.length > 1) {
        warn('Multiple nha installations detected on PATH:');
        for (const p of dups) console.log(`    ${p}`);
        warn('Only the FIRST in PATH is what your shell will run. If the version still');
        warn('appears unchanged, remove the older one (e.g. `sudo rm /usr/local/bin/nha`)');
        warn('or reorder your PATH so the newer install is found first.');
      }
    } else {
      warn('npm install failed. Run manually:');
      console.log(`    npm cache clean --force && npm install -g nothumanallowed@${npmCheck.latest} --prefer-online`);
    }
  } else if (npmCheck) {
    ok(`npm package nothumanallowed@${npmCheck.current} (up to date)`);
  }

  let updated = npmUpdated;

  // ── Legion X + agents: part of the package ─────────────────────────────
  // A freshly installed package brings its own Legion and agents; they are
  // put in place the next time `nha` starts. Here the agents of the running
  // version are restored if any went missing.
  ok(`Legion X v${bundledLegionVersion()} (bundled with nothumanallowed@${VERSION})`);
  const agents = syncBundledAgents();
  if (agents.copied > 0) { ok(`${agents.copied} agents restored from the package`); updated = true; }

  // ── PIF (downloaded from website, not npm) ─────────────────────────────
  // 45s timeout — VMs / slow connections can take that long for the manifest.
  let remote = null;
  try {
    const res = await fetch(`${BASE_URL}/versions.json`, {
      signal: AbortSignal.timeout(45000),
      headers: { 'User-Agent': `nha-cli/${VERSION}` },
    });
    if (res.ok) remote = await res.json();
  } catch { /* reported below */ }

  if (!remote) {
    warn('Could not reach nothumanallowed.com: PIF not checked. Nothing else depends on it.');
  } else {
    let local = {};
    if (fs.existsSync(VERSIONS_FILE)) {
      try { local = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf-8')); } catch {}
    }
    const pifCurrent = local['pif']?.latest ?? '?';
    const pifLatest = remote['pif']?.latest ?? '?';
    if (pifCurrent !== pifLatest || !fs.existsSync(PIF_FILE)) {
      info(`PIF: ${pifCurrent} → ${pifLatest}`);
      const success = await download(`${BASE_URL}/pif.mjs`, PIF_FILE, { timeout: 90_000, retries: 4 });
      if (success) { ok(`PIF updated to v${pifLatest}`); updated = true; }
    } else {
      ok(`PIF v${pifCurrent} (up to date)`);
    }
    await download(`${BASE_URL}/versions.json`, VERSIONS_FILE);
    fs.writeFileSync(LAST_UPDATE_CHECK, String(Date.now()));
  }

  if (updated) {
    console.log('');
    ok('Update complete!');
  } else {
    console.log('');
    ok('Everything is up to date.');
  }
}
