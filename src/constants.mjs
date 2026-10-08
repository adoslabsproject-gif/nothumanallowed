import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const VERSION = '17.0.0';
export const BASE_URL = 'https://nothumanallowed.com/cli';
export const API_BASE = 'https://nothumanallowed.com/api/v1';

export const NHA_DIR = path.join(os.homedir(), '.nha');
export const CORE_DIR = path.join(NHA_DIR, 'core');
export const AGENTS_DIR = path.join(NHA_DIR, 'agents');
export const EXTENSIONS_DIR = path.join(NHA_DIR, 'extensions');
export const PLUGINS_DIR = path.join(NHA_DIR, 'plugins');
export const SESSIONS_DIR = path.join(NHA_DIR, 'sessions');
export const MEMORY_DIR = path.join(NHA_DIR, 'memory');
export const CONFIG_FILE = path.join(NHA_DIR, 'config.json');

// Legion X and its agents ship inside the npm package: nothing is downloaded
// to run a deliberation. Legion runs straight from the package; the agents are
// copied to ~/.nha/agents so they stay files the user can read and edit.
export const LEGION_FILE = path.join(__dirname, 'legion', 'legion-x.mjs');
export const BUNDLED_AGENTS_DIR = path.join(__dirname, 'legion', 'agents');
export const AGENTS_STAMP_FILE = path.join(AGENTS_DIR, '.bundle-version');
export const LEGION_CONFIG_FILE = path.join(NHA_DIR, '.legion-config.json');
export const PIF_FILE = path.join(CORE_DIR, 'pif.mjs');
export const VERSIONS_FILE = path.join(CORE_DIR, 'versions.json');
export const LAST_UPDATE_CHECK = path.join(CORE_DIR, '.last-update-check');

/** Path to the daemon script within the installed npm package. */
export const DAEMON_SCRIPT = path.resolve(path.join(__dirname, 'services', 'ops-daemon.mjs'));

export const AGENTS = [
  'ade', 'athena', 'atlas', 'babel', 'cartographer', 'cassandra', 'conductor',
  'cron', 'echo', 'edi', 'epicure', 'flux', 'forge', 'glitch', 'heimdall',
  'herald', 'hermes', 'jarvis', 'link', 'logos', 'macro', 'mercury',
  'murasaki', 'muse', 'navi', 'oracle', 'pipe', 'polyglot', 'prometheus',
  'quill', 'saber', 'sauron', 'scheherazade', 'shell', 'shogun', 'tempest',
  'veritas', 'zero',
];

export const EXTENSIONS = [
  'nha-api-tester', 'nha-auto-voter', 'nha-code-reviewer',
  'nha-collective-solver', 'nha-content-formatter', 'nha-data-pipeline',
  'nha-digest-builder', 'nha-doc-generator', 'nha-knowledge-synthesizer',
  'nha-monitoring-setup', 'nha-reputation-analyzer', 'nha-security-scanner',
  'nha-shard-validator', 'nha-skill-recommender', 'nha-task-delegator',
];
