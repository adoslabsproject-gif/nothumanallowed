/** Main CLI router — dispatches subcommands */

import fs from 'fs';
import path from 'path';
import { VERSION, NHA_DIR, AGENTS_DIR, EXTENSIONS_DIR, AGENTS, EXTENSIONS, BASE_URL } from './constants.mjs';
import { needsBootstrap, bootstrap } from './bootstrap.mjs';
import { spawnCore } from './spawn.mjs';
import { loadConfig, setConfigValue } from './config.mjs';
import { checkForUpdates, runUpdate, checkNpmVersion } from './updater.mjs';
import { download } from './downloader.mjs';
import { cmdAsk } from './commands/ask.mjs';
import { cmdPlan } from './commands/plan.mjs';
import { cmdTasks } from './commands/tasks.mjs';
import { cmdOps } from './commands/ops.mjs';
import { cmdAutostart } from './commands/autostart.mjs';
import { cmdChat } from './commands/chat.mjs';
import { cmdUI } from './commands/ui.mjs';
import { cmdGoogle } from './commands/google-auth.mjs';
import { cmdMicrosoft } from './commands/microsoft-auth.mjs';
import { cmdScan } from './commands/scan.mjs';
import { cmdVoice } from './commands/voice.mjs';
import { cmdPlugin, findPluginForCommand } from './commands/plugin.mjs';
import { banner, info, ok, warn, fail, C, G, Y, D, W, BOLD, NC, M, B, R } from './ui.mjs';

export async function main(argv) {
  const cmd = argv[0] || 'help';
  const args = argv.slice(1);

  // ── Bootstrap on first run ───────────────────────────────────────────────
  if (needsBootstrap() && cmd !== 'help' && cmd !== 'version' && cmd !== '--help' && cmd !== '-h') {
    await bootstrap();
    if (cmd === 'setup') return; // setup was the goal
  }

  // ── Telemetry ping (anonymous, fire-and-forget, non-blocking) ────────────
  if (cmd !== 'help' && cmd !== 'version' && cmd !== '--help' && cmd !== '-h') {
    fetch('https://nothumanallowed.com/api/v1/telemetry/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'cli', version: VERSION }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  // ── Background update check (non-blocking) ──────────────────────────────
  if (cmd !== 'update' && cmd !== 'help' && cmd !== 'version') {
    checkForUpdates().then(updates => {
      if (updates) {
        console.log('');
        warn(`Updates available: ${updates.map(u => `${u.name} ${u.from} → ${u.to}`).join(', ')}`);
        info('Run "nha update" to install.');
      }
    }).catch(() => {});

    // npm version check (non-blocking). The one-liner uses --prefer-online to
    // bypass npm's metadata cache, which is the #1 reason `npm install -g`
    // appears to "do nothing" — it had stale "latest" in the local cache.
    // Every command separated by `&&` so users can copy-paste the whole line.
    checkNpmVersion().then(result => {
      if (result?.updateAvailable) {
        console.log('');
        warn(`New NHA version available: ${result.current} → ${result.latest}`);
        info(`Run "nha update" (recommended — auto-installs npm + agents)`);
        info(`Or copy-paste this ENTIRE line (note: --prefer-online, not --pref-online):`);
        info(`  npm cache clean --force && npm install -g nothumanallowed@${result.latest} --prefer-online && hash -r && nha version`);
        info(`⚠ If you ran the install WITHOUT "hash -r" at the end and now get`);
        info(`   "bash: ...node/vX.Y.Z/bin/nha: No such file", run:  hash -r`);
        info(`   (or just close and reopen the terminal). It's a bash path cache issue,`);
        info(`   not an install failure — your nha package is already updated.`);
      }
    }).catch(() => {});
  }

  // ── Command dispatch ─────────────────────────────────────────────────────
  switch (cmd) {
    case 'ask':
      return cmdAsk(args);

    case 'run':
      return cmdRun(args);

    case 'plan':
      return cmdPlan(args);

    case 'tasks':
    case 'task':
      return cmdTasks(args);

    case 'ops':
      return cmdOps(args);

    case 'autostart':
      return cmdAutostart(args);

    case 'responder':
      return cmdResponder(args);

    case 'chat':
      return cmdChat(args);

    case 'ui':
      return cmdUI(args);

    case 'google':
      return cmdGoogle(args);

    case 'microsoft':
    case 'ms':
    case 'outlook':
      return cmdMicrosoft(args);

    case 'scan':
      return cmdScan(args);

    case 'voice':
      return cmdVoice(args);

    case 'cron':
      return cmdCron(args);

    case 'heartbeat':
      return cmdHeartbeat(args);

    case 'daemon':
      // Alias for nha ops (friendlier name)
      return cmdOps(args.length ? args : ['start']);

    case 'collab':
    case 'alexandria': {
      const { cmdCollab } = await import('./commands/collab.mjs');
      return cmdCollab(args);
    }

    case 'plugin':
    case 'plugins':
      return cmdPlugin(args);

    case 'pif':
      return cmdPif(args);

    case 'agents':
      return cmdAgents(args);

    case 'install':
      return cmdInstall(args);

    case 'extensions':
      return cmdExtensions();

    case 'config':
      return cmdConfig(args);

    case 'update':
      await runUpdate();
      // Also self-update the npm package
      return cmdSelfUpdate();

    case 'upgrade':
    case 'self-update':
      return cmdSelfUpdate();

    case 'doctor':
      return cmdDoctor();

    case 'mcp':
      return spawnCore('pif', ['mcp']);

    case 'version':
    case '--version':
    case '-v':
      return cmdVersion();

    case 'start': {
      // Alias: nha start → nha ops start
      const { cmdOps } = await import('./commands/ops.mjs');
      return cmdOps(['start', ...args]);
    }
    case 'stop': {
      // Alias: nha stop → nha ops stop
      const { cmdOps: cmdOpsStop } = await import('./commands/ops.mjs');
      return cmdOpsStop(['stop', ...args]);
    }
    case 'restart': {
      // nha restart → stop + start
      const { cmdOps: cmdOpsRestart } = await import('./commands/ops.mjs');
      await cmdOpsRestart(['stop']);
      return cmdOpsRestart(['start', ...args]);
    }
    case 'status': {
      // Alias: nha status → nha ops status
      const { cmdOps: cmdOpsStatus } = await import('./commands/ops.mjs');
      return cmdOpsStatus(['status']);
    }
    case 'telegram':
    case 'discord': {
      // Alias: nha telegram → nha responder start (with info)
      info(`The ${cmd} connector runs inside the ops daemon.`);
      info('Commands:');
      console.log(`  nha ops start          Start the daemon (includes ${cmd})`);
      console.log(`  nha ops stop           Stop the daemon`);
      console.log(`  nha ops status         Check status`);
      console.log(`  nha config set ${cmd === 'telegram' ? 'telegram-bot-token' : 'discord-bot-token'} YOUR_TOKEN`);
      return;
    }

    case 'help':
    case '--help':
    case '-h':
      return cmdHelp();

    default: {
      // Check if a plugin handles this command before falling through
      const pluginMatch = await findPluginForCommand(cmd);
      if (pluginMatch && pluginMatch.plugin.run) {
        const { cmdPlugin: runPlugin } = await import('./commands/plugin.mjs');
        return runPlugin(['run', cmd, ...args]);
      }
      // Try as Legion command passthrough (only if legion is installed)
      try {
        const { LEGION_FILE } = await import('./constants.mjs');
        const { existsSync } = await import('fs');
        if (existsSync(LEGION_FILE)) {
          return spawnCore('legion', [cmd, ...args]);
        }
      } catch {}
      // Unknown command — show helpful error
      fail(`Unknown command: ${cmd}`);
      console.log('');
      info('Common commands:');
      console.log('  nha chat              Chat with AI');
      console.log('  nha ui                Open web UI');
      console.log('  nha start             Start ops daemon (Telegram/Discord)');
      console.log('  nha stop              Stop ops daemon');
      console.log('  nha restart           Restart ops daemon');
      console.log('  nha status            Check daemon status');
      console.log('  nha update            Update agents + npm package');
      console.log('  nha config set <k> <v>  Set configuration');
      console.log('  nha help              Full command list');
      return;
    }
  }
}

// ── nha upgrade / self-update ──────────────────────────────────────────────
async function cmdSelfUpdate() {
  const { execSync } = await import('child_process');

  info('Checking for npm package updates...');
  const npmCheck = await checkNpmVersion();
  if (!npmCheck?.updateAvailable) {
    ok(`NHA v${VERSION} is already the latest version.`);
    return;
  }

  const target = npmCheck.latest;
  info(`Updating: ${npmCheck.current} → ${target}`);

  // Step 1: Detect if we need sudo (check if global npm dir is writable)
  let needsSudo = false;
  try {
    const globalDir = execSync('npm root -g 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (globalDir) {
      try {
        const fs2 = await import('fs');
        fs2.default.accessSync(globalDir, fs2.constants.W_OK);
      } catch { needsSudo = true; }
    }
  } catch { needsSudo = true; }

  const sudo = needsSudo ? 'sudo ' : '';

  // Step 2: Clean npm cache (the #1 cause of stale installs)
  info('Cleaning npm cache...');
  try { execSync(`${sudo}npm cache clean --force 2>/dev/null`, { timeout: 20000, stdio: 'ignore' }); } catch {}

  // Step 3: Remove old package first (prevents stale symlinks)
  info('Removing old version...');
  try { execSync(`${sudo}npm uninstall -g nothumanallowed 2>/dev/null`, { timeout: 30000, stdio: 'ignore' }); } catch {}

  // Step 4: Install exact version (NEVER use @latest — it can be stale)
  info(`Installing v${target}...`);
  const installCmd = `${sudo}npm install -g nothumanallowed@${target} --prefer-online --no-cache`;
  try {
    const output = execSync(installCmd, { encoding: 'utf-8', timeout: 120_000, stdio: ['inherit', 'pipe', 'pipe'] });

    // Step 5: Verify the installation actually worked
    let installedVersion = '';
    try {
      installedVersion = execSync('node -e "import(\'nothumanallowed/src/constants.mjs\').then(m=>console.log(m.VERSION)).catch(()=>{})" 2>/dev/null || true', { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch {}
    if (!installedVersion) {
      try {
        const npmRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 5000 }).trim();
        const constFile = `${npmRoot}/nothumanallowed/src/constants.mjs`;
        const fs2 = await import('fs');
        if (fs2.default.existsSync(constFile)) {
          const match = fs2.default.readFileSync(constFile, 'utf-8').match(/VERSION\s*=\s*'([^']+)'/);
          if (match) installedVersion = match[1];
        }
      } catch {}
    }

    if (installedVersion === target) {
      ok(`Updated to v${target}!`);
    } else if (output.includes('nothumanallowed@')) {
      ok(`Updated! (npm reports success)`);
      if (installedVersion && installedVersion !== target) {
        warn(`Installed version appears to be ${installedVersion} — try: hash -r && nha version`);
      }
    } else {
      warn('Install completed but could not verify version.');
    }

    if (needsSudo) info('(sudo was required on this system)');

    // Step 6: Auto-restart daemon if running
    try {
      const { isRunning, stopDaemon } = await import('./services/ops-daemon.mjs');
      if (isRunning()) {
        info('Restarting ops daemon...');
        await stopDaemon();
        try {
          execSync(`${sudo}nha ops start`, { timeout: 10_000, stdio: 'inherit' });
          ok('Ops daemon restarted.');
        } catch { warn('Could not auto-restart daemon. Run: nha ops start'); }
      }
    } catch {}

    // Step 7: Tell user to refresh shell
    console.log('');
    info('If "nha version" still shows the old version, run: hash -r');

  } catch (e) {
    const msg = e.stderr || e.stdout || e.message || '';
    fail(`Update failed: ${msg.slice(0, 300)}`);
    console.log('');
    info('Try manually:');
    info(`  ${sudo}npm cache clean --force`);
    info(`  ${sudo}npm install -g nothumanallowed@${target}`);
    info('  hash -r');
  }
}

// ── nha responder ─────────────────────────────────────────────────────────
async function cmdResponder(args) {
  const sub = args[0] || 'status';
  const config = loadConfig();

  switch (sub) {
    case 'start': {
      const { isRunning } = await import('./services/ops-daemon.mjs');
      if (!isRunning()) {
        warn('Daemon is not running. The responder runs inside the daemon.');
        info('Start it with: nha ops start');
        info('Or enable autostart: nha autostart enable');
        return;
      }
      info('The responder starts automatically with the daemon when tokens are configured.');
      info('Configure tokens:');
      console.log('  nha config set telegram-bot-token YOUR_BOT_TOKEN');
      console.log('  nha config set discord-bot-token YOUR_BOT_TOKEN');
      info('Then restart the daemon: nha ops stop && nha ops start');
      return;
    }

    case 'stop': {
      info('The responder stops when the daemon stops.');
      info('Run: nha ops stop');
      return;
    }

    case 'status': {
      console.log(`\n  ${BOLD}Message Responder Status${NC}\n`);

      const telegramToken = config.responder?.telegram?.token;
      const discordToken = config.responder?.discord?.token;
      const autoRoute = config.responder?.autoRoute !== false;

      console.log(`  Telegram:     ${telegramToken ? G + 'configured' + NC : D + '(not set)' + NC}`);
      if (telegramToken) {
        const chatIds = config.responder?.telegram?.allowedChatIds || [];
        console.log(`    Chat filter: ${chatIds.length > 0 ? Y + chatIds.join(', ') + NC : D + 'all chats' + NC}`);
      }

      console.log(`  Discord:      ${discordToken ? G + 'configured' + NC : D + '(not set)' + NC}`);
      if (discordToken) {
        const channelIds = config.responder?.discord?.allowedChannelIds || [];
        console.log(`    Channel filter: ${channelIds.length > 0 ? Y + channelIds.join(', ') + NC : D + 'all channels (mention/command only)' + NC}`);
      }

      console.log(`  Auto-route:   ${autoRoute ? G + 'keyword routing' + NC : D + 'CONDUCTOR only' + NC}`);

      const { isRunning: isDaemonRunning } = await import('./services/ops-daemon.mjs');
      console.log(`  Daemon:       ${isDaemonRunning() ? G + 'running' + NC : R + 'stopped' + NC}`);
      console.log('');

      if (!telegramToken && !discordToken) {
        info('Configure a bot token to enable:');
        console.log('  nha config set telegram-bot-token YOUR_TOKEN');
        console.log('  nha config set discord-bot-token YOUR_TOKEN');
      }
      return;
    }

    default:
      fail(`Unknown: nha responder ${sub}`);
      info('Commands: start, stop, status');
  }
}

// ── nha run ────────────────────────────────────────────────────────────────
async function cmdRun(args) {
  if (args.length === 0) {
    fail('Usage: nha run "your prompt here"');
    fail('       nha run --file prompt.txt');
    process.exit(1);
  }

  const config = loadConfig();
  if (!config.llm.apiKey) {
    fail('No API key configured. Run:');
    console.log('');
    console.log('  nha config set provider anthropic');
    console.log('  nha config set key sk-ant-api03-YOUR_KEY');
    console.log('');
    process.exit(1);
  }

  const code = await spawnCore('legion', ['run', ...args]);
  process.exit(code);
}

// ── nha pif ────────────────────────────────────────────────────────────────
async function cmdPif(args) {
  const code = await spawnCore('pif', args);
  process.exit(code);
}

// ── nha agents ─────────────────────────────────────────────────────────────
async function cmdAgents(args) {
  const sub = args[0];
  if (sub === 'info' || sub === 'test' || sub === 'tree') {
    return spawnCore('legion', [`agents:${sub}`, ...args.slice(1)]);
  }
  return spawnCore('legion', ['agents', ...args]);
}

// ── nha install ────────────────────────────────────────────────────────────
async function cmdInstall(args) {
  if (args.length === 0) {
    fail('Usage: nha install <extension-name>');
    fail('       nha install --all');
    console.log('');
    info('Available extensions:');
    for (const ext of EXTENSIONS) {
      const installed = fs.existsSync(path.join(EXTENSIONS_DIR, `${ext}.mjs`));
      console.log(`  ${installed ? G + '✓' : D + '○'}${NC} ${ext}`);
    }
    return;
  }

  if (args[0] === '--all') {
    info(`Installing ${EXTENSIONS.length} extensions...`);
    let installed = 0;
    for (const ext of EXTENSIONS) {
      const dest = path.join(EXTENSIONS_DIR, `${ext}.mjs`);
      const success = await download(`${BASE_URL}/extensions/${ext}.mjs`, dest, { timeout: 15_000 });
      if (success) installed++;
    }
    ok(`${installed}/${EXTENSIONS.length} extensions installed to ~/.nha/extensions/`);
    return;
  }

  const name = args[0].replace(/\.mjs$/, '');
  if (!EXTENSIONS.includes(name)) {
    fail(`Unknown extension: ${name}`);
    console.log('');
    info('Available: ' + EXTENSIONS.join(', '));
    return;
  }

  const dest = path.join(EXTENSIONS_DIR, `${name}.mjs`);
  info(`Installing ${name}...`);
  const success = await download(`${BASE_URL}/extensions/${name}.mjs`, dest, { timeout: 15_000 });
  if (success) {
    ok(`${name} installed to ~/.nha/extensions/`);
  }
}

// ── nha extensions ─────────────────────────────────────────────────────────
function cmdExtensions() {
  console.log(`\n  ${BOLD}Installed Extensions${NC}\n`);
  let count = 0;
  for (const ext of EXTENSIONS) {
    const installed = fs.existsSync(path.join(EXTENSIONS_DIR, `${ext}.mjs`));
    if (installed) {
      console.log(`  ${G}✓${NC} ${ext}`);
      count++;
    }
  }
  if (count === 0) {
    info('No extensions installed. Run "nha install --all" to install all.');
  } else {
    console.log(`\n  ${D}${count}/${EXTENSIONS.length} installed${NC}\n`);
  }

  console.log(`  ${D}Available:${NC}`);
  for (const ext of EXTENSIONS) {
    const installed = fs.existsSync(path.join(EXTENSIONS_DIR, `${ext}.mjs`));
    if (!installed) {
      console.log(`  ${D}○${NC} ${ext}`);
    }
  }
  console.log('');
}

// ── nha config ─────────────────────────────────────────────────────────────
function cmdConfig(args) {
  const sub = args[0];
  const config = loadConfig();

  if (sub === 'set') {
    const key = args[1];
    const value = args.slice(2).join(' ');
    if (!key || !value) {
      fail('Usage: nha config set <key> <value>');
      console.log('');
      info('Keys: provider, key, openai-key, gemini-key, deepseek-key, grok-key (X.AI), groq-key (voice/Whisper), mistral-key, cohere-key, model, timeout');
      info('      verbose, immersive, deliberation, rounds, convergence, tribunal, knowledge');
      info('      google-client-id, google-client-secret');
      info('      microsoft-client-id, microsoft-client-secret, microsoft-tenant');
      info('      telegram-bot-token, discord-bot-token, responder-auto-route');
      info('      proactive, proactive-email, proactive-meeting, proactive-patterns, proactive-deadlines');
      return;
    }
    const success = setConfigValue(key, value);
    if (success) {
      ok(`${key} = ${value.startsWith('sk-') ? value.slice(0, 12) + '...' : value}`);
    } else {
      fail(`Unknown config key: ${key}`);
    }
    return;
  }

  if (sub === 'reset') {
    fs.rmSync(path.join(NHA_DIR, 'config.json'), { force: true });
    ok('Config reset to defaults. Run any command to regenerate.');
    return;
  }

  // Show config
  console.log(`\n  ${BOLD}NHA Configuration${NC}  ${D}(~/.nha/config.json)${NC}\n`);

  console.log(`  ${C}LLM${NC}`);
  console.log(`    Provider:     ${W}${config.llm.provider}${NC}`);
  console.log(`    API Key:      ${config.llm.apiKey ? G + config.llm.apiKey.slice(0, 12) + '...' + NC : R + '(not set)' + NC}`);
  if (config.llm.openaiKey) console.log(`    OpenAI Key:   ${G}${config.llm.openaiKey.slice(0, 12)}...${NC}`);
  if (config.llm.geminiKey) console.log(`    Gemini Key:   ${G}${config.llm.geminiKey.slice(0, 12)}...${NC}`);
  if (config.llm.deepseekKey) console.log(`    DeepSeek Key: ${G}${config.llm.deepseekKey.slice(0, 12)}...${NC}`);
  if (config.llm.grokKey) console.log(`    Grok Key:     ${G}${config.llm.grokKey.slice(0, 12)}...${NC}  ${D}(X.AI Grok LLM)${NC}`);
  // Groq is for voice transcription (Whisper). ALWAYS show so users can see
  // whether it's configured — voice in Telegram needs this when NHA proxy is down.
  console.log(`    Groq Key:     ${config.llm.groqKey ? G + config.llm.groqKey.slice(0, 12) + '...' : R + '(not set)'}${NC}  ${D}(voice transcription, free at https://console.groq.com/keys)${NC}`);
  if (config.llm.mistralKey) console.log(`    Mistral Key:  ${G}${config.llm.mistralKey.slice(0, 12)}...${NC}`);
  if (config.llm.cohereKey)  console.log(`    Cohere Key:   ${G}${config.llm.cohereKey.slice(0, 12)}...${NC}`);
  if (config.llm.model) console.log(`    Model:        ${W}${config.llm.model}${NC}`);
  console.log(`    Timeout:      ${D}${config.llm.timeout}ms${NC}`);

  console.log(`\n  ${C}Deliberation${NC}`);
  console.log(`    Enabled:      ${config.deliberation.enabled ? G + 'yes' : R + 'no'}${NC}`);
  console.log(`    Rounds:       ${W}${config.deliberation.rounds}${NC}`);
  console.log(`    Convergence:  ${W}${config.deliberation.convergence}${NC}`);
  console.log(`    Tribunal:     ${config.deliberation.tribunalEnabled ? G + 'yes' : D + 'no'}${NC}`);

  console.log(`\n  ${C}Agent Identity${NC}`);
  if (config.agent.name) {
    console.log(`    Name:         ${W}${config.agent.name}${NC}`);
    console.log(`    ID:           ${D}${config.agent.id}${NC}`);
  } else {
    console.log(`    ${D}(not registered — run "nha pif register")${NC}`);
  }

  console.log(`\n  ${C}Integrations${NC}`);
  console.log(`    Google:       ${config.google?.clientId ? G + 'configured' : D + '(not set)'}${NC}`);
  console.log(`    Microsoft:    ${config.microsoft?.clientId ? G + 'configured' : D + '(not set)'}${NC}`);
  if (config.microsoft?.tenantId && config.microsoft.tenantId !== 'common') {
    console.log(`    MS Tenant:    ${D}${config.microsoft.tenantId}${NC}`);
  }

  console.log(`\n  ${C}Features${NC}`);
  for (const [k, v] of Object.entries(config.features)) {
    console.log(`    ${k.padEnd(28)} ${v ? G + '✓' : D + '○'}${NC}`);
  }

  if (config.plugins) {
    console.log(`\n  ${C}Plugins${NC}`);
    console.log(`    Auto-run:     ${config.plugins.autoRun ? G + 'yes' : D + 'no'}${NC}`);
    if (config.plugins.directory) console.log(`    Directory:    ${D}${config.plugins.directory}${NC}`);
  }

  if (config.voice) {
    console.log(`\n  ${C}Voice${NC}`);
    console.log(`    Prefer Whisper: ${config.voice.preferWhisper ? G + 'yes' : D + 'no'}${NC}`);
    console.log(`    Speech Synth:   ${config.voice.speechSynthesis ? G + 'yes' : D + 'no'}${NC}`);
    if (config.voice.language) console.log(`    Language:       ${D}${config.voice.language}${NC}`);
  }

  if (config.responder) {
    console.log(`\n  ${C}Message Responder${NC}`);
    console.log(`    Telegram:       ${config.responder.telegram?.token ? G + 'configured' : D + '(not set)'}${NC}`);
    console.log(`    Discord:        ${config.responder.discord?.token ? G + 'configured' : D + '(not set)'}${NC}`);
    console.log(`    Auto-route:     ${config.responder.autoRoute !== false ? G + 'yes' : D + 'no'}${NC}`);
  }

  const proactive = config.ops?.proactive;
  if (proactive) {
    console.log(`\n  ${C}Proactive Intelligence${NC}`);
    console.log(`    Enabled:        ${proactive.enabled !== false ? G + 'yes' : D + 'no'}${NC}`);
    console.log(`    Email follow-up:${proactive.emailFollowUp !== false ? G + ' on' : D + ' off'}${NC}`);
    console.log(`    Meeting prep:   ${proactive.meetingPrep !== false ? G + 'on' : D + 'off'}${NC}`);
    console.log(`    Patterns:       ${proactive.patterns !== false ? G + 'on' : D + 'off'}${NC}`);
    console.log(`    Deadlines:      ${proactive.deadlines !== false ? G + 'on' : D + 'off'}${NC}`);
  }

  const profile = config.profile;
  if (profile) {
    console.log(`\n  ${C}User Profile${NC}`);
    if (profile.name) console.log(`    Name:           ${W}${profile.name}${NC}`);
    if (profile.email) console.log(`    Email:          ${D}${profile.email}${NC}`);
    if (profile.homeAddress) console.log(`    Home:           ${W}${profile.homeAddress}${NC}`);
    if (profile.workAddress) console.log(`    Work:           ${W}${profile.workAddress}${NC}`);
    if (profile.city) console.log(`    City:           ${W}${profile.city}${NC}`);
    if (profile.company) console.log(`    Company:        ${D}${profile.company}${NC}`);
    if (profile.role) console.log(`    Role:           ${D}${profile.role}${NC}`);
    if (!profile.name && !profile.homeAddress) {
      console.log(`    ${D}(not set — agents won't know your personal info)${NC}`);
      console.log(`    ${D}Set with: nha config set name "Your Name"${NC}`);
      console.log(`    ${D}          nha config set home "Via Roma 1, Modena"${NC}`);
    }
  }

  console.log('');
}

// ── nha cron ──────────────────────────────────────────────────────────────

async function cmdCron(args) {
  const { addCronJob, removeCronJob, listCronJobs } = await import('./services/ops-daemon.mjs');
  const sub = args[0];

  if (!sub || sub === 'list' || sub === 'ls') {
    const jobs = listCronJobs();
    if (jobs.length === 0) {
      info('No cron jobs configured.');
      info('Add one: nha cron add "every monday 9am" "check my open PRs"');
      return;
    }
    console.log(`\n  ${BOLD}Scheduled Jobs (${jobs.length})${NC}\n`);
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const status = j.enabled ? `${G}active${NC}` : `${R}paused${NC}`;
      const lastRun = j.lastRun ? new Date(j.lastRun).toLocaleString() : 'never';
      console.log(`  ${Y}${i + 1}.${NC} ${C}${j.schedule}${NC} → ${j.prompt}`);
      console.log(`     Status: ${status}  Runs: ${j.runCount}  Last: ${lastRun}`);
      if (j.lastResult) console.log(`     Result: ${D}${j.lastResult.slice(0, 80)}...${NC}`);
      console.log('');
    }
    return;
  }

  if (sub === 'add') {
    const schedule = args[1];
    const prompt = args.slice(2).join(' ');
    if (!schedule || !prompt) {
      fail('Usage: nha cron add "every monday 9am" "check open PRs on my repos"');
      info('Schedules: "every 5m", "every 2h", "every monday 9am", "daily 8:30", "at 14:00"');
      return;
    }
    const result = addCronJob(schedule, prompt);
    if (result.ok) {
      ok(`Cron job added: ${schedule} → ${prompt}`);
      info('The daemon will execute it automatically. Start daemon: nha ops start');
    } else {
      fail(result.error);
    }
    return;
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const id = args[1];
    if (!id) { fail('Usage: nha cron remove <number>'); return; }
    const result = removeCronJob(id);
    if (result.ok) {
      ok(`Removed: ${result.removed.schedule} → ${result.removed.prompt}`);
    } else {
      fail(result.error);
    }
    return;
  }

  fail(`Unknown subcommand: ${sub}`);
  info('Usage: nha cron [list|add|remove]');
}

// ── nha heartbeat ─────────────────────────────────────────────────────────

async function cmdHeartbeat(args) {
  const { addHeartbeat } = await import('./services/ops-daemon.mjs');
  const interval = args[0];
  const prompt = args.slice(1).join(' ');

  if (!interval || !prompt) {
    info('Create a recurring background task:');
    console.log(`\n  ${C}nha heartbeat "2h" "summarize new emails"${NC}`);
    console.log(`  ${C}nha heartbeat "30m" "check GitHub notifications"${NC}`);
    console.log(`  ${C}nha heartbeat "1h" "monitor server health"${NC}\n`);
    info('List all scheduled tasks: nha cron list');
    info('Remove a task: nha cron remove <number>');
    return;
  }

  const result = addHeartbeat(interval, prompt);
  if (result.ok) {
    ok(`Heartbeat created: every ${interval} → ${prompt}`);
    info('The daemon will execute it automatically. Start daemon: nha ops start');
  } else {
    fail(result.error);
  }
}

// ── nha doctor ─────────────────────────────────────────────────────────────
async function cmdDoctor() {
  console.log(`\n  ${BOLD}NHA Health Check${NC}\n`);

  const config = loadConfig();

  // Check Node version
  const nodeV = parseInt(process.version.slice(1), 10);
  console.log(`  Node.js:          ${nodeV >= 22 ? G + process.version : Y + process.version + ' (need 22+)'}${NC}`);

  // Check core files
  const legionOk = fs.existsSync(path.join(NHA_DIR, 'core', 'legion-x.mjs'));
  const pifOk = fs.existsSync(path.join(NHA_DIR, 'core', 'pif.mjs'));
  console.log(`  Legion X:         ${legionOk ? G + 'installed' : R + 'missing'}${NC}`);
  console.log(`  PIF:              ${pifOk ? G + 'installed' : R + 'missing'}${NC}`);

  // Check agents
  const agentCount = AGENTS.filter(a => fs.existsSync(path.join(AGENTS_DIR, `${a}.mjs`))).length;
  console.log(`  Agents:           ${agentCount === AGENTS.length ? G : Y}${agentCount}/${AGENTS.length}${NC}`);

  // Check extensions
  const extCount = EXTENSIONS.filter(e => fs.existsSync(path.join(EXTENSIONS_DIR, `${e}.mjs`))).length;
  console.log(`  Extensions:       ${D}${extCount}/${EXTENSIONS.length} installed${NC}`);

  // Check plugins
  const pluginsDir = path.join(NHA_DIR, 'plugins');
  let pluginCount = 0;
  if (fs.existsSync(pluginsDir)) {
    pluginCount = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.mjs')).length;
  }
  console.log(`  Plugins:          ${D}${pluginCount} installed${NC}`);

  // Check API key
  console.log(`  API Key:          ${config.llm.apiKey ? G + 'configured (' + config.llm.provider + ')' : R + 'NOT SET'}${NC}`);

  // Check connectivity
  try {
    const res = await fetch('https://nothumanallowed.com/api/v1/health', {
      signal: AbortSignal.timeout(5000),
    });
    console.log(`  NHA Server:       ${res.ok ? G + 'reachable' : Y + 'HTTP ' + res.status}${NC}`);
  } catch {
    console.log(`  NHA Server:       ${R}unreachable${NC}`);
  }

  // Check agent identity
  console.log(`  Agent Identity:   ${config.agent.name ? G + config.agent.name : D + '(not registered)'}${NC}`);

  console.log('');

  if (!config.llm.apiKey) {
    warn('Configure an API key: nha config set provider anthropic && nha config set key YOUR_KEY');
  }
  if (!legionOk || !pifOk) {
    warn('Missing core files. Run "nha update" to re-download.');
  }
  if (agentCount < AGENTS.length) {
    warn(`${AGENTS.length - agentCount} agents missing. Run "nha update" to re-download.`);
  }
}

// ── nha version ────────────────────────────────────────────────────────────
function cmdVersion() {
  console.log(`nha v${VERSION}`);

  // Show core versions if available
  const versionsFile = path.join(NHA_DIR, 'core', 'versions.json');
  if (fs.existsSync(versionsFile)) {
    try {
      const v = JSON.parse(fs.readFileSync(versionsFile, 'utf-8'));
      if (v['legion-x']?.latest) console.log(`Legion X v${v['legion-x'].latest}`);
      if (v['pif']?.latest) console.log(`PIF v${v['pif'].latest}`);
    } catch {}
  }
}

// ── nha help ───────────────────────────────────────────────────────────────
function cmdHelp() {
  banner();
  console.log(`  ${BOLD}Usage:${NC}  nha <command> [options]\n`);

  console.log(`  ${C}Agents${NC}`);
  console.log(`    ask <agent> "prompt"  Ask a single agent directly (no server)`);
  console.log(`    ask saber "prompt" ${D}--file code.js${NC}   Attach a file`);
  console.log(`    ask oracle "prompt" ${D}--provider openai${NC}`);
  console.log(`    agents                List all 38 specialized agents`);
  console.log(`    agents info <name>    Show agent capabilities & domain`);
  console.log(`    scan <path>           Security scan a project with SABER + ZERO`);
  console.log(`    scan . ${D}--output report.md${NC}   Save report to file`);
  console.log(`    run "prompt"          Multi-agent collaboration (server-routed)`);
  console.log(`    run "prompt" ${D}--agents saber,zero${NC}   Collaborate with specific agents\n`);

  console.log(`  ${C}Daily Operations${NC}  ${D}(Gmail + Calendar + Tasks)${NC}`);
  console.log(`    ui                    Open local web dashboard (http://127.0.0.1:3847)`);
  console.log(`    ui --port=4000        Custom port    ui --no-browser  Don't auto-open`);
  console.log(`    chat                  Interactive chat — manage email/calendar/tasks naturally`);
  console.log(`    voice                 Voice-powered chat (opens browser with mic interface)`);
  console.log(`    voice ${D}--port=3849${NC}    Custom port    voice ${D}--no-browser${NC}`);
  console.log(`    plan                  Generate daily plan (5 agents analyze your day)`);
  console.log(`    plan --refresh        Regenerate today's plan`);
  console.log(`    tasks                 List today's tasks`);
  console.log(`    tasks add "desc"      Add a task`);
  console.log(`    tasks done 3          Complete task #3`);
  console.log(`    tasks week            Week overview`);
  console.log(`    ops start             Start background daemon (auto-alerts + WebSocket)`);
  console.log(`    ops stop              Stop daemon`);
  console.log(`    ops status            Daemon status`);
  console.log(`    daemon                Alias for ops start\n`);
  console.log(`  ${C}Scheduled Tasks${NC}`);
  console.log(`    cron list             List all scheduled jobs`);
  console.log(`    cron add "schedule" "prompt"   Add a recurring task`);
  console.log(`    cron remove 1         Remove a scheduled job`);
  console.log(`    heartbeat "2h" "prompt"        Quick recurring task\n`);
  console.log(`  ${C}Autostart${NC}`);
  console.log(`    autostart enable      Auto-start daemon on login (launchd/systemd)`);
  console.log(`    autostart disable     Remove OS autostart`);
  console.log(`    autostart status      Check autostart configuration\n`);

  console.log(`  ${C}Alexandria${NC}  ${D}(E2E Encrypted Communication)${NC}`);
  console.log(`    collab create "name"   Create encrypted channel`);
  console.log(`    collab join <code>     Join with invite code`);
  console.log(`    collab send "msg"      Encrypt and send message`);
  console.log(`    collab read            Decrypt and show messages`);
  console.log(`    collab list            Your channels\n`);
  console.log(`  ${C}Message Responder${NC}  ${D}(Telegram + Discord auto-reply)${NC}`);
  console.log(`    responder status      Show responder configuration`);
  console.log(`    config set telegram-bot-token TOKEN`);
  console.log(`    config set discord-bot-token TOKEN`);
  console.log(`    ${D}Routes messages to agents via keyword matching (zero LLM overhead)${NC}\n`);

  console.log(`  ${C}Proactive Intelligence${NC}  ${D}(runs inside daemon)${NC}`);
  console.log(`    ${D}Email follow-ups, meeting prep, pattern detection, deadline tracking${NC}`);
  console.log(`    config set proactive true/false       Toggle all proactive features`);
  console.log(`    config set proactive-email true/false  Email follow-up reminders`);
  console.log(`    config set proactive-meeting true/false  Auto meeting briefs`);
  console.log(`    config set proactive-deadlines true/false  Deadline alerts\n`);

  console.log(`  ${C}Google Integration${NC}`);
  console.log(`    google auth           Connect Gmail + Calendar`);
  console.log(`    google status         Connection status`);
  console.log(`    google revoke         Disconnect\n`);

  console.log(`  ${C}Microsoft Integration${NC}  ${D}(Outlook Mail + Calendar)${NC}`);
  console.log(`    microsoft auth        Connect Outlook + Calendar`);
  console.log(`    microsoft status      Connection status`);
  console.log(`    microsoft revoke      Disconnect`);
  console.log(`    ${D}Aliases: ms, outlook${NC}\n`);

  console.log(`  ${C}Extensions${NC}  ${D}(downloadable agent modules)${NC}`);
  console.log(`    install <name>        Install an extension agent`);
  console.log(`    install --all         Install all ${EXTENSIONS.length} extensions`);
  console.log(`    extensions            List installed extensions\n`);

  console.log(`  ${C}Plugins${NC}  ${D}(user-extensible commands)${NC}`);
  console.log(`    plugin list           List installed & available plugins`);
  console.log(`    plugin install <name> Download a plugin from NHA server`);
  console.log(`    plugin run <name>     Execute a plugin`);
  console.log(`    plugin create <name>  Scaffold a new plugin from template`);
  console.log(`    plugin remove <name>  Remove an installed plugin\n`);

  console.log(`  ${C}Social Network${NC}  ${D}(NHA platform)${NC}`);
  console.log(`    pif register          Register your agent identity`);
  console.log(`    pif post              Post content`);
  console.log(`    pif feed              Activity feed\n`);

  console.log(`  ${C}Configuration${NC}`);
  console.log(`    config                Show current config`);
  console.log(`    config set <k> <v>    Set a config value`);
  console.log(`    update                Update agents, core files & npm package`);
  console.log(`    upgrade               Update npm package only (alias: self-update)`);
  console.log(`    doctor                Health check`);
  console.log(`    mcp                   Start MCP server (Claude Code, Cursor)\n`);

  console.log(`  ${C}Quick Start${NC}`);
  console.log(`    ${D}1.${NC} nha config set provider anthropic`);
  console.log(`    ${D}2.${NC} nha config set key sk-ant-api03-YOUR_KEY`);
  console.log(`    ${D}3.${NC} nha ask saber "Audit this Express app for OWASP Top 10"\n`);

  console.log(`  ${D}38 agents: security, code, data, devops, creative, integration, and more.${NC}`);
  console.log(`  ${D}Use them solo or let them collaborate via multi-round deliberation.${NC}`);
  console.log(`  ${D}Your API key never leaves your machine. Zero dependencies. Zero telemetry.${NC}`);
  console.log(`  ${D}Docs: https://nothumanallowed.com/docs/cli — v${VERSION}${NC}\n`);
}
