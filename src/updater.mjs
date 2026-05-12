/** Update checker and updater for core files + agents */

import fs from 'fs';
import {
  BASE_URL, VERSIONS_FILE, LAST_UPDATE_CHECK,
  LEGION_FILE, PIF_FILE, AGENTS_DIR, AGENTS, VERSION,
} from './constants.mjs';
import { download, downloadBatch } from './downloader.mjs';
import { info, ok, warn, progress } from './ui.mjs';

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
    if (remote['legion-x']?.latest !== local['legion-x']?.latest) {
      updates.push({ name: 'Legion X', from: local['legion-x']?.latest ?? '?', to: remote['legion-x'].latest });
    }
    if (remote['pif']?.latest !== local['pif']?.latest) {
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
 * Full update: re-download core files + agents + self-upgrade the npm package.
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

  // ── Agents + Legion + PIF (downloaded from website, not npm) ───────────
  // 45s timeout (was 15s) — VMs / slow connections can take that long for
  // the first manifest fetch. The downloader retries internally for batch
  // downloads, so this is just for the initial manifest.
  const res = await fetch(`${BASE_URL}/versions.json`, {
    signal: AbortSignal.timeout(45000),
    headers: { 'User-Agent': `nha-cli/${(await import('./constants.mjs')).VERSION}` },
  });
  if (!res.ok) {
    warn('Could not reach nothumanallowed.com for agent updates.');
    return;
  }

  const remote = await res.json();
  let local = {};
  if (fs.existsSync(VERSIONS_FILE)) {
    try { local = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf-8')); } catch {}
  }

  const legionCurrent = local['legion-x']?.latest ?? '?';
  const legionLatest = remote['legion-x']?.latest ?? '?';
  const pifCurrent = local['pif']?.latest ?? '?';
  const pifLatest = remote['pif']?.latest ?? '?';

  let updated = npmUpdated;

  // Update Legion
  if (legionCurrent !== legionLatest) {
    info(`Legion X: ${legionCurrent} → ${legionLatest}`);
    const success = await download(`${BASE_URL}/legion-x.mjs`, LEGION_FILE, { timeout: 90_000, retries: 4 });
    if (success) { ok(`Legion X updated to v${legionLatest}`); updated = true; }
  } else {
    ok(`Legion X v${legionCurrent} (up to date)`);
  }

  // Update PIF
  if (pifCurrent !== pifLatest) {
    info(`PIF: ${pifCurrent} → ${pifLatest}`);
    const success = await download(`${BASE_URL}/pif.mjs`, PIF_FILE, { timeout: 90_000, retries: 4 });
    if (success) { ok(`PIF updated to v${pifLatest}`); updated = true; }
  } else {
    ok(`PIF v${pifCurrent} (up to date)`);
  }

  // Re-download all agents (they may have been updated)
  info(`Updating ${AGENTS.length} agents...`);
  const agentTasks = AGENTS.map(name => ({
    url: `${BASE_URL}/agents/${name}.mjs`,
    dest: `${AGENTS_DIR}/${name}.mjs`,
  }));
  const result = await downloadBatch(agentTasks, 8, (done, total) => {
    progress(done, total, 'agents');
  });
  ok(`${result.ok}/${AGENTS.length} agents updated`);

  // Save new versions manifest
  await download(`${BASE_URL}/versions.json`, VERSIONS_FILE);
  fs.writeFileSync(LAST_UPDATE_CHECK, String(Date.now()));

  if (updated) {
    console.log('');
    ok('Update complete!');
  } else {
    console.log('');
    ok('Everything is up to date.');
  }
}
