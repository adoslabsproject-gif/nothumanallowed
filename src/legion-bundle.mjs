/** Legion X as shipped in the package: its version, and the agents copied to ~/.nha/agents */

import fs from 'fs';
import path from 'path';
import {
  AGENTS, AGENTS_DIR, AGENTS_STAMP_FILE, BUNDLED_AGENTS_DIR, LEGION_FILE, VERSION,
} from './constants.mjs';

/**
 * Version of the bundled Legion X, read from the file itself so it cannot
 * drift from what actually runs.
 * @returns {string} the version, or 'unknown' when the file cannot be read
 */
export function bundledLegionVersion(legionFile = LEGION_FILE) {
  try {
    const head = fs.readFileSync(legionFile, 'utf-8').slice(0, 20_000);
    const match = head.match(/^var VERSION = '([^']+)';/m);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Copy the bundled agents into the user's agents directory.
 *
 * Runs when the package version changed since the last copy, or when an agent
 * file is missing. A copy is skipped otherwise, so the check costs one small
 * read per command.
 *
 * @param {object} [options] overrides, used by the tests
 * @returns {{ copied: number, missing: string[], reason: 'fresh'|'version'|'incomplete'|'up-to-date' }}
 */
export function syncBundledAgents(options = {}) {
  const sourceDir = options.sourceDir || BUNDLED_AGENTS_DIR;
  const targetDir = options.targetDir || AGENTS_DIR;
  const stampFile = options.stampFile || AGENTS_STAMP_FILE;
  const version = options.version || VERSION;
  const names = options.agents || AGENTS;

  let stamp = '';
  try { stamp = fs.readFileSync(stampFile, 'utf-8').trim(); } catch { /* no stamp yet */ }

  const absent = names.filter((name) => !fs.existsSync(path.join(targetDir, `${name}.mjs`)));
  let reason = 'up-to-date';
  if (!stamp) reason = 'fresh';
  else if (stamp !== version) reason = 'version';
  else if (absent.length > 0) reason = 'incomplete';
  if (reason === 'up-to-date') return { copied: 0, missing: [], reason };

  fs.mkdirSync(targetDir, { recursive: true });
  const toCopy = reason === 'incomplete' ? absent : names;
  const missing = [];
  let copied = 0;
  for (const name of toCopy) {
    const source = path.join(sourceDir, `${name}.mjs`);
    if (!fs.existsSync(source)) { missing.push(name); continue; }
    fs.copyFileSync(source, path.join(targetDir, `${name}.mjs`));
    copied++;
  }
  // The stamp is written only for a complete copy: a partial one is retried.
  if (missing.length === 0) fs.writeFileSync(stampFile, version + '\n', 'utf-8');
  return { copied, missing, reason };
}
