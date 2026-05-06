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
 * Full update: re-download core files + agents.
 */
export async function runUpdate() {
  info('Checking for updates...');

  const res = await fetch(`${BASE_URL}/versions.json`, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'nha-cli/1.0.0' },
  });
  if (!res.ok) {
    warn('Could not reach nothumanallowed.com');
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

  let updated = false;

  // Update Legion
  if (legionCurrent !== legionLatest) {
    info(`Legion X: ${legionCurrent} → ${legionLatest}`);
    const success = await download(`${BASE_URL}/legion-x.mjs`, LEGION_FILE, { timeout: 60_000 });
    if (success) { ok(`Legion X updated to v${legionLatest}`); updated = true; }
  } else {
    ok(`Legion X v${legionCurrent} (up to date)`);
  }

  // Update PIF
  if (pifCurrent !== pifLatest) {
    info(`PIF: ${pifCurrent} → ${pifLatest}`);
    const success = await download(`${BASE_URL}/pif.mjs`, PIF_FILE, { timeout: 60_000 });
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
