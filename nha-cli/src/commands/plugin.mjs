/**
 * nha plugin — Plugin system for user-extensible commands.
 *
 * Plugins are .mjs files stored in ~/.nha/plugins/. Each exports a
 * PLUGIN_CARD object and a run() function. The plugin system gives plugins
 * access to NHA services (LLM, Gmail, Calendar, Tasks, notifications)
 * through a context object.
 *
 * Subcommands:
 *   nha plugin list               — List installed + available plugins
 *   nha plugin install <name>     — Download plugin from NHA server
 *   nha plugin run <name> [args]  — Execute a plugin
 *   nha plugin create <name>      — Scaffold a new plugin from template
 *   nha plugin remove <name>      — Remove an installed plugin
 *   nha plugin info <name>        — Show plugin details
 *
 * Zero npm dependencies — Node.js 22 native only.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadConfig } from '../config.mjs';
import { callLLM, callAgent } from '../services/llm.mjs';
import { NHA_DIR, PLUGINS_DIR, BASE_URL, VERSION } from '../constants.mjs';
import { download } from '../downloader.mjs';
import { info, ok, warn, fail, C, G, Y, D, W, BOLD, NC, R } from '../ui.mjs';

// ── Constants ──────────────────────────────────────────────────────────────

const PLUGINS_REGISTRY_URL = `${BASE_URL}/plugins/registry.json`;
const LOCAL_REGISTRY_FILE = path.join(PLUGINS_DIR, '.registry.json');

// ── Plugin Loader ──────────────────────────────────────────────────────────

/**
 * Load a plugin by name from the plugins directory.
 * Returns { card, run } or null if not found.
 */
export async function loadPlugin(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '');
  const pluginFile = path.join(PLUGINS_DIR, `${sanitized}.mjs`);

  if (!fs.existsSync(pluginFile)) return null;

  try {
    const { pathToFileURL } = await import('url');
    const mod = await import(pathToFileURL(pluginFile).href);
    return {
      card: mod.PLUGIN_CARD || { name: sanitized, version: '0.0.0', description: '', commands: [] },
      run: typeof mod.run === 'function' ? mod.run : null,
      filePath: pluginFile,
    };
  } catch (err) {
    fail(`Failed to load plugin "${sanitized}": ${err.message}`);
    return null;
  }
}

/**
 * Load all installed plugins. Returns an array of { card, run, filePath }.
 */
export async function loadAllPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];

  const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.mjs'));
  const plugins = [];

  for (const file of files) {
    const name = file.replace(/\.mjs$/, '');
    const plugin = await loadPlugin(name);
    if (plugin) plugins.push(plugin);
  }

  return plugins;
}

/**
 * Check if any installed plugin handles the given command name.
 * Returns { plugin, command } or null.
 */
export async function findPluginForCommand(commandName) {
  const plugins = await loadAllPlugins();

  for (const plugin of plugins) {
    const commands = plugin.card.commands || [];
    if (commands.includes(commandName) || plugin.card.name === commandName) {
      return { plugin, command: commandName };
    }
  }

  return null;
}

/**
 * Build the context object passed to plugin run() functions.
 * Gives plugins access to all NHA services.
 */
async function buildPluginContext(config) {
  const gmail = await import('../services/google-gmail.mjs').catch(() => null);
  const calendar = await import('../services/google-calendar.mjs').catch(() => null);
  const taskStore = await import('../services/task-store.mjs').catch(() => null);
  const notifier = await import('../services/notification.mjs').catch(() => null);

  return {
    config,
    version: VERSION,
    pluginsDir: PLUGINS_DIR,
    nhaDir: NHA_DIR,

    // LLM
    callLLM: (systemPrompt, userMessage, opts) => callLLM(config, systemPrompt, userMessage, opts),
    callAgent: (agentName, userMessage, opts) => callAgent(config, agentName, userMessage, opts),

    // Gmail
    gmail: gmail ? {
      listMessages: (query, max) => gmail.listMessages(config, query, max),
      getMessage: (id) => gmail.getMessage(config, id),
      getUnreadImportant: (max) => gmail.getUnreadImportant(config, max),
      sendEmail: (to, subject, body, opts) => gmail.sendEmail(config, to, subject, body, opts),
      createDraft: (to, subject, body) => gmail.createDraft(config, to, subject, body),
    } : null,

    // Calendar
    calendar: calendar ? {
      getTodayEvents: () => calendar.getTodayEvents(config),
      getUpcomingEvents: (hours) => calendar.getUpcomingEvents(config, hours),
      getEventsForDate: (date) => calendar.getEventsForDate(config, date),
      createEvent: (data) => calendar.createEvent(config, data),
      updateEvent: (calId, eventId, data) => calendar.updateEvent(config, calId, eventId, data),
    } : null,

    // Tasks
    tasks: taskStore ? {
      getTasks: () => taskStore.getTasks(),
      addTask: (data) => taskStore.addTask(data),
      completeTask: (id) => taskStore.completeTask(id),
      moveTask: (id, from, to) => taskStore.moveTask(id, from, to),
      getDayStats: () => taskStore.getDayStats(),
    } : null,

    // Notifications
    notify: notifier ? (title, message) => notifier.notify(title, message, config) : null,

    // Filesystem helpers (sandboxed to plugins dir)
    fs: {
      readFile: (name) => fs.readFileSync(path.join(PLUGINS_DIR, name), 'utf-8'),
      writeFile: (name, content) => fs.writeFileSync(path.join(PLUGINS_DIR, name), content, 'utf-8'),
      exists: (name) => fs.existsSync(path.join(PLUGINS_DIR, name)),
    },

    // Fetch (for plugins that need HTTP)
    fetch: globalThis.fetch,
  };
}

// ── SHA-256 Integrity Verification ───────────────────────────────────────────

/**
 * Compute SHA-256 hash of a file.
 * @param {string} filePath
 * @returns {string} hex hash
 */
function computeSHA256(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Verify a plugin file against its registry SHA-256 hash.
 * @param {string} filePath — path to the downloaded plugin
 * @param {string} expectedHash — SHA-256 hex from registry
 * @returns {boolean}
 */
function verifyIntegrity(filePath, expectedHash) {
  if (!expectedHash) return false;
  const actual = computeSHA256(filePath);
  return actual === expectedHash;
}

// ── Registry (available plugins from server) ────────────────────────────────

/**
 * Fetch the plugin registry from the server.
 * Registry format: { plugins: [{ name, version, description, sha256, size, author }] }
 * The sha256 field is the hex hash of the .mjs file — verified on install.
 */
async function fetchRegistry() {
  try {
    const res = await fetch(PLUGINS_REGISTRY_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    const plugins = Array.isArray(data.plugins) ? data.plugins : [];

    // Cache registry locally for offline reference
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    fs.writeFileSync(LOCAL_REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf-8');

    return plugins;
  } catch {
    // Fallback to local cached registry
    try {
      if (fs.existsSync(LOCAL_REGISTRY_FILE)) {
        const data = JSON.parse(fs.readFileSync(LOCAL_REGISTRY_FILE, 'utf-8'));
        return Array.isArray(data.plugins) ? data.plugins : [];
      }
    } catch {}
    return [];
  }
}

/**
 * Get the registry entry for a plugin by name.
 */
async function getRegistryEntry(name) {
  const registry = await fetchRegistry();
  return registry.find(p => p.name === name) || null;
}

// ── Plugin Template ─────────────────────────────────────────────────────────

function generateTemplate(name) {
  const camelName = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  return `/**
 * NHA Plugin: ${name}
 *
 * This plugin was scaffolded by "nha plugin create ${name}".
 * Edit the PLUGIN_CARD and run() function to add your functionality.
 *
 * Usage:
 *   nha plugin run ${name}
 *   nha plugin run ${name} --help
 */

export const PLUGIN_CARD = {
  name: '${name}',
  version: '1.0.0',
  description: 'Describe what this plugin does',
  author: '',
  commands: ['${name}'],
};

/**
 * Main entry point for the plugin.
 *
 * @param {string[]} args - Command-line arguments passed after the plugin name
 * @param {object} context - NHA services context
 * @param {function} context.callLLM - Call any LLM provider: callLLM(systemPrompt, userMessage, opts?)
 * @param {function} context.callAgent - Call a named agent: callAgent('saber', 'Audit this code')
 * @param {object|null} context.gmail - Gmail service (listMessages, getMessage, sendEmail, createDraft)
 * @param {object|null} context.calendar - Calendar service (getTodayEvents, getUpcomingEvents, createEvent)
 * @param {object|null} context.tasks - Tasks service (getTasks, addTask, completeTask, moveTask)
 * @param {function|null} context.notify - Send a desktop notification: notify(title, message)
 * @param {object} context.config - NHA config object
 * @param {function} context.fetch - Global fetch for HTTP requests
 * @param {object} context.fs - Sandboxed fs: readFile(name), writeFile(name, content), exists(name)
 * @returns {Promise<string>} Result to display to the user
 */
export async function run(args, context) {
  if (args.includes('--help')) {
    return [
      'Usage: nha plugin run ${name} [options]',
      '',
      'Options:',
      '  --help    Show this help message',
      '',
      'Description:',
      '  ' + PLUGIN_CARD.description,
    ].join('\\n');
  }

  // Example: call an agent
  // const analysis = await context.callAgent('saber', 'Analyze this for security issues');

  // Example: call LLM directly
  // const response = await context.callLLM('You are a helpful assistant.', 'Hello!');

  // Example: list tasks
  // if (context.tasks) {
  //   const tasks = context.tasks.getTasks();
  //   return 'Your tasks: ' + tasks.map(t => t.description).join(', ');
  // }

  return 'Plugin ${name} executed successfully. Edit ~/.nha/plugins/${name}.mjs to add your logic.';
}
`;
}

// ── Subcommand Handlers ─────────────────────────────────────────────────────

async function cmdList() {
  console.log(`\n  ${BOLD}NHA Plugins${NC}\n`);

  // Installed plugins
  const installed = await loadAllPlugins();

  if (installed.length > 0) {
    console.log(`  ${C}Installed${NC}  ${D}(~/.nha/plugins/)${NC}\n`);
    for (const p of installed) {
      const card = p.card;
      console.log(`  ${G}*${NC} ${W}${card.name}${NC} ${D}v${card.version}${NC}`);
      if (card.description) console.log(`    ${D}${card.description}${NC}`);
      if (card.commands && card.commands.length > 0) {
        console.log(`    ${D}Commands: ${card.commands.join(', ')}${NC}`);
      }
    }
  } else {
    console.log(`  ${D}No plugins installed.${NC}`);
  }

  // Available from server
  console.log('');
  info('Checking server for available plugins...');
  const registry = await fetchRegistry();

  if (registry.length > 0) {
    console.log(`\n  ${C}Available from Server${NC}\n`);
    const installedNames = new Set(installed.map(p => p.card.name));
    for (const p of registry) {
      const status = installedNames.has(p.name) ? `${G}installed${NC}` : `${D}available${NC}`;
      console.log(`  ${D}*${NC} ${W}${p.name}${NC} ${D}v${p.version}${NC} — ${status}`);
      if (p.description) console.log(`    ${D}${p.description}${NC}`);
    }
  } else {
    console.log(`\n  ${D}No plugins available from server (or server unreachable).${NC}`);
    console.log(`  ${D}Create your own: nha plugin create my-plugin${NC}`);
  }

  console.log('');
}

async function cmdInstall(name) {
  if (!name) {
    fail('Usage: nha plugin install <name>');
    return;
  }

  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '').replace(/\.mjs$/, '');
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  // Step 1: Check registry for SHA-256 hash
  info(`Checking registry for "${sanitized}"...`);
  const entry = await getRegistryEntry(sanitized);

  if (!entry) {
    fail(`Plugin "${sanitized}" not found in registry.`);
    info('Available plugins: nha plugin list');
    info(`Or create your own: nha plugin create ${sanitized}`);
    return;
  }

  if (!entry.sha256) {
    fail(`Plugin "${sanitized}" has no integrity hash in registry. Aborting for security.`);
    return;
  }

  // Step 2: Download the plugin
  const dest = path.join(PLUGINS_DIR, `${sanitized}.mjs`);
  const url = `${BASE_URL}/plugins/${sanitized}.mjs`;

  info(`Downloading "${sanitized}" v${entry.version || '?'}...`);
  const success = await download(url, dest, { timeout: 15000 });

  if (!success) {
    fail(`Could not download plugin "${sanitized}".`);
    return;
  }

  // Step 3: Verify SHA-256 integrity
  info('Verifying SHA-256 integrity...');
  const isValid = verifyIntegrity(dest, entry.sha256);

  if (!isValid) {
    // CRITICAL: hash mismatch — file may be tampered
    fs.rmSync(dest, { force: true });
    fail(`INTEGRITY CHECK FAILED for "${sanitized}"!`);
    fail(`Expected SHA-256: ${entry.sha256}`);
    fail(`Got SHA-256:      ${computeSHA256(dest)}`);
    fail('The downloaded file does not match the registry hash. File deleted for safety.');
    fail('This could indicate a compromised server or man-in-the-middle attack.');
    return;
  }

  ok(`SHA-256 verified: ${entry.sha256.slice(0, 16)}...`);

  // Step 4: Load and validate the plugin
  const plugin = await loadPlugin(sanitized);
  if (plugin && plugin.run) {
    ok(`Plugin "${sanitized}" v${entry.version || plugin.card.version} installed.`);
    if (plugin.card.description) info(plugin.card.description);
    if (plugin.card.commands?.length > 0) info(`Commands: ${plugin.card.commands.join(', ')}`);
  } else if (plugin) {
    warn(`Plugin "${sanitized}" installed but has no run() function.`);
  } else {
    warn(`Plugin "${sanitized}" downloaded but could not be loaded.`);
  }
}

async function cmdRun(name, args) {
  if (!name) {
    fail('Usage: nha plugin run <name> [args...]');
    return;
  }

  const plugin = await loadPlugin(name);
  if (!plugin) {
    fail(`Plugin "${name}" not found. Install it first: nha plugin install ${name}`);
    return;
  }

  if (!plugin.run) {
    fail(`Plugin "${name}" has no run() function.`);
    return;
  }

  const config = loadConfig();
  const context = await buildPluginContext(config);

  info(`Running plugin "${name}" v${plugin.card.version}...`);
  console.log('');

  try {
    const result = await plugin.run(args, context);
    if (result) {
      console.log(result);
    }
    console.log('');
    ok(`Plugin "${name}" completed.`);
  } catch (err) {
    fail(`Plugin "${name}" error: ${err.message}`);
    if (err.stack) {
      console.log(`  ${D}${err.stack.split('\n').slice(1, 4).join('\n  ')}${NC}`);
    }
  }
}

async function cmdCreate(name) {
  if (!name) {
    fail('Usage: nha plugin create <name>');
    return;
  }

  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitized) {
    fail('Invalid plugin name. Use only letters, numbers, hyphens, underscores.');
    return;
  }

  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  const dest = path.join(PLUGINS_DIR, `${sanitized}.mjs`);
  if (fs.existsSync(dest)) {
    fail(`Plugin "${sanitized}" already exists at ${dest}`);
    info('Edit it directly or remove it first: nha plugin remove ' + sanitized);
    return;
  }

  const template = generateTemplate(sanitized);
  fs.writeFileSync(dest, template, 'utf-8');

  ok(`Plugin "${sanitized}" created at ~/.nha/plugins/${sanitized}.mjs`);
  console.log('');
  info('Edit the file to add your logic:');
  console.log(`  ${D}${dest}${NC}`);
  console.log('');
  info('Then run it:');
  console.log(`  ${D}nha plugin run ${sanitized}${NC}`);
  console.log('');
}

async function cmdRemove(name) {
  if (!name) {
    fail('Usage: nha plugin remove <name>');
    return;
  }

  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '').replace(/\.mjs$/, '');
  const dest = path.join(PLUGINS_DIR, `${sanitized}.mjs`);

  if (!fs.existsSync(dest)) {
    fail(`Plugin "${sanitized}" not found.`);
    return;
  }

  fs.rmSync(dest, { force: true });
  ok(`Plugin "${sanitized}" removed.`);
}

async function cmdInfo(name) {
  if (!name) {
    fail('Usage: nha plugin info <name>');
    return;
  }

  const plugin = await loadPlugin(name);
  if (!plugin) {
    fail(`Plugin "${name}" not found.`);
    return;
  }

  const card = plugin.card;
  console.log(`\n  ${BOLD}${W}${card.name}${NC}  ${D}v${card.version}${NC}\n`);
  if (card.description) console.log(`  ${card.description}\n`);
  if (card.author) console.log(`  ${D}Author:${NC}   ${card.author}`);
  if (card.commands && card.commands.length > 0) console.log(`  ${D}Commands:${NC} ${card.commands.join(', ')}`);
  console.log(`  ${D}File:${NC}     ${plugin.filePath}`);
  console.log(`  ${D}Has run():${NC} ${plugin.run ? G + 'yes' : R + 'no'}${NC}`);
  console.log('');
}

// ── Main Command Router ─────────────────────────────────────────────────────

export async function cmdPlugin(args) {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'list':
    case 'ls':
    case undefined:
      return cmdList();

    case 'install':
    case 'add':
      return cmdInstall(rest[0]);

    case 'run':
    case 'exec':
      return cmdRun(rest[0], rest.slice(1));

    case 'create':
    case 'new':
    case 'init':
      return cmdCreate(rest[0]);

    case 'remove':
    case 'rm':
    case 'uninstall':
      return cmdRemove(rest[0]);

    case 'info':
    case 'show':
      return cmdInfo(rest[0]);

    default:
      // If the subcommand matches a plugin name, run it directly
      const plugin = await loadPlugin(sub);
      if (plugin && plugin.run) {
        return cmdRun(sub, rest);
      }

      fail(`Unknown plugin subcommand: ${sub}`);
      console.log('');
      info('Usage:');
      console.log(`  ${D}nha plugin list${NC}              List installed & available plugins`);
      console.log(`  ${D}nha plugin install <name>${NC}    Download a plugin from NHA server`);
      console.log(`  ${D}nha plugin run <name> [args]${NC} Execute a plugin`);
      console.log(`  ${D}nha plugin create <name>${NC}     Scaffold a new plugin`);
      console.log(`  ${D}nha plugin remove <name>${NC}     Remove an installed plugin`);
      console.log(`  ${D}nha plugin info <name>${NC}       Show plugin details`);
      console.log('');
  }
}
