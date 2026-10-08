/** Spawn legion-x.mjs or pif.mjs as child process with stdio inherited */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { loadConfig } from './config.mjs';
import { buildLegionConfig, CLOUD_KEY_ENV } from './legion-config.mjs';
import {
  NHA_DIR, LEGION_FILE, LEGION_CONFIG_FILE, PIF_FILE, AGENTS_DIR, EXTENSIONS_DIR, SESSIONS_DIR,
} from './constants.mjs';

/**
 * Write the flat config Legion X reads, derived in full from the nha config.
 * The file holds API keys: it is readable by its owner only.
 */
function writeLegionConfig(config) {
  const legionConfig = buildLegionConfig(config);
  fs.mkdirSync(NHA_DIR, { recursive: true });
  fs.writeFileSync(LEGION_CONFIG_FILE, JSON.stringify(legionConfig, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // The mode above applies to a new file only: an existing one is tightened here.
  fs.chmodSync(LEGION_CONFIG_FILE, 0o600);
  return legionConfig;
}

/**
 * Spawn a core file (legion-x.mjs or pif.mjs) with the user's terminal.
 * @param {'legion'|'pif'} target
 * @param {string[]} args
 * @returns {Promise<number>} exit code
 */
export function spawnCore(target, args) {
  const file = target === 'legion' ? LEGION_FILE : PIF_FILE;
  const config = loadConfig();

  // For Legion: write a flat config it can understand
  const legionConfig = target === 'legion' ? writeLegionConfig(config) : null;
  const configFile = legionConfig ? LEGION_CONFIG_FILE : path.join(NHA_DIR, 'config.json');

  const env = {
    ...process.env,
    NHA_AGENTS_DIR: AGENTS_DIR,
    NHA_EXTENSIONS_DIR: EXTENSIONS_DIR,
    NHA_SESSIONS_DIR: SESSIONS_DIR,
    NHA_CONFIG_FILE: configFile,
    // Legion ships with this package and is updated with it: it has no
    // version of its own to look up.
    LEGION_NO_UPDATE_CHECK: '1',
  };

  // Local-only: a cloud key exported in the shell must not reach Legion either.
  if (legionConfig?.localOnly) {
    for (const name of Object.values(CLOUD_KEY_ENV)) delete env[name];
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      stdio: 'inherit',
      env,
      cwd: process.cwd(),
    });

    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(`Failed to start ${target}: ${err.message}`);
      resolve(1);
    });
  });
}
