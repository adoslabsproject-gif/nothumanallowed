/**
 * nha autostart — OS-level daemon autostart management.
 *
 * macOS:  launchd plist at ~/Library/LaunchAgents/com.nha.daemon.plist
 * Linux:  systemd user service at ~/.config/systemd/user/nha-daemon.service
 *
 * Zero dependencies.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { NHA_DIR, DAEMON_SCRIPT } from '../constants.mjs';
import { info, ok, fail, warn, C, G, Y, D, W, BOLD, NC, R } from '../ui.mjs';

const PLATFORM = os.platform();
const HOME = os.homedir();

// ── Paths ────────────────────────────────────────────────────────────────────

// DAEMON_SCRIPT is resolved relative to the installed package (via constants.mjs),
// so it works correctly both in development and after npm install -g.
const DAEMON_SCRIPT_ABS = DAEMON_SCRIPT;
const NODE_BIN = process.execPath;

const LAUNCHD_LABEL = 'com.nha.daemon';
const LAUNCHD_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const LAUNCHD_LOG_DIR = path.join(NHA_DIR, 'ops', 'daemon');

const SYSTEMD_DIR = path.join(HOME, '.config', 'systemd', 'user');
const SYSTEMD_UNIT = 'nha-daemon.service';
const SYSTEMD_FILE = path.join(SYSTEMD_DIR, SYSTEMD_UNIT);

// ── launchd (macOS) ──────────────────────────────────────────────────────────

function generateLaunchdPlist() {
  // launchd XML plist — KeepAlive restarts on crash, RunAtLoad starts on login
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${DAEMON_SCRIPT_ABS}</string>
    <string>--daemon-loop</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${path.join(LAUNCHD_LOG_DIR, 'daemon.log')}</string>

  <key>StandardErrorPath</key>
  <string>${path.join(LAUNCHD_LOG_DIR, 'daemon.log')}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NHA_DAEMON</key>
    <string>1</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${path.dirname(NODE_BIN)}</string>
  </dict>

  <key>ProcessType</key>
  <string>Background</string>

  <key>LowPriorityIO</key>
  <true/>
</dict>
</plist>
`;
}

function launchdInstall() {
  const agentsDir = path.join(HOME, 'Library', 'LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(LAUNCHD_LOG_DIR, { recursive: true });

  fs.writeFileSync(LAUNCHD_PLIST, generateLaunchdPlist(), { mode: 0o644 });

  // Load the agent (starts it immediately)
  const result = spawnSync('launchctl', ['load', '-w', LAUNCHD_PLIST], { encoding: 'utf-8' });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    // Already loaded is not a real error
    if (!stderr.includes('already loaded') && !stderr.includes('service already loaded')) {
      throw new Error(`launchctl load failed: ${stderr}`);
    }
  }
}

function launchdUninstall() {
  if (!fs.existsSync(LAUNCHD_PLIST)) {
    return false;
  }

  // Unload (stops the daemon)
  spawnSync('launchctl', ['unload', '-w', LAUNCHD_PLIST], { encoding: 'utf-8' });

  fs.rmSync(LAUNCHD_PLIST, { force: true });
  return true;
}

function launchdStatus() {
  const installed = fs.existsSync(LAUNCHD_PLIST);
  if (!installed) {
    return { installed: false, running: false, pid: null };
  }

  // Check if service is loaded and running
  const result = spawnSync('launchctl', ['list'], { encoding: 'utf-8' });
  const lines = (result.stdout || '').split('\n');
  const match = lines.find(l => l.includes(LAUNCHD_LABEL));

  if (!match) {
    return { installed: true, running: false, pid: null };
  }

  // Format: PID Status Label
  const parts = match.trim().split(/\s+/);
  const pid = parts[0] === '-' ? null : parseInt(parts[0], 10);
  const running = pid !== null && !isNaN(pid);

  return { installed: true, running, pid };
}

// ── systemd (Linux) ──────────────────────────────────────────────────────────

function generateSystemdUnit() {
  return `[Unit]
Description=NHA PAO Background Daemon
Documentation=https://nothumanallowed.com/docs/cli
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${DAEMON_SCRIPT_ABS} --daemon-loop
Environment=NHA_DAEMON=1
Environment=HOME=${HOME}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${path.dirname(NODE_BIN)}

Restart=on-failure
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=5

StandardOutput=append:${path.join(LAUNCHD_LOG_DIR, 'daemon.log')}
StandardError=append:${path.join(LAUNCHD_LOG_DIR, 'daemon.log')}

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${NHA_DIR}

[Install]
WantedBy=default.target
`;
}

function systemdInstall() {
  fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
  fs.mkdirSync(LAUNCHD_LOG_DIR, { recursive: true });

  fs.writeFileSync(SYSTEMD_FILE, generateSystemdUnit(), { mode: 0o644 });

  // Reload systemd user daemon to pick up new unit
  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf-8' });

  // Enable (auto-start on login) and start immediately
  const enableResult = spawnSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], {
    encoding: 'utf-8',
  });

  if (enableResult.status !== 0) {
    const stderr = (enableResult.stderr || '').trim();
    throw new Error(`systemctl enable failed: ${stderr}`);
  }

  // Enable lingering so the user service runs even when not logged in (optional, best-effort)
  spawnSync('loginctl', ['enable-linger', os.userInfo().username], { encoding: 'utf-8' });
}

function systemdUninstall() {
  if (!fs.existsSync(SYSTEMD_FILE)) {
    return false;
  }

  // Stop and disable
  spawnSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], { encoding: 'utf-8' });

  fs.rmSync(SYSTEMD_FILE, { force: true });

  // Reload to clean up
  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf-8' });

  return true;
}

function systemdStatus() {
  const installed = fs.existsSync(SYSTEMD_FILE);
  if (!installed) {
    return { installed: false, running: false, pid: null };
  }

  const result = spawnSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], {
    encoding: 'utf-8',
  });
  const active = (result.stdout || '').trim() === 'active';

  let pid = null;
  if (active) {
    const showResult = spawnSync('systemctl', ['--user', 'show', SYSTEMD_UNIT, '--property=MainPID'], {
      encoding: 'utf-8',
    });
    const pidMatch = (showResult.stdout || '').match(/MainPID=(\d+)/);
    if (pidMatch) pid = parseInt(pidMatch[1], 10);
  }

  return { installed: true, running: active, pid };
}

// ── Platform Dispatcher ──────────────────────────────────────────────────────

function getPlatformAdapter() {
  if (PLATFORM === 'darwin') {
    return { install: launchdInstall, uninstall: launchdUninstall, status: launchdStatus, name: 'launchd' };
  }
  if (PLATFORM === 'linux') {
    return { install: systemdInstall, uninstall: systemdUninstall, status: systemdStatus, name: 'systemd' };
  }
  return null;
}

// ── Command Handler ──────────────────────────────────────────────────────────

export async function cmdAutostart(args) {
  const sub = args[0] || 'status';
  const adapter = getPlatformAdapter();

  if (!adapter) {
    fail(`Autostart is not supported on ${PLATFORM}`);
    info('Supported platforms: macOS (launchd), Linux (systemd)');
    return;
  }

  switch (sub) {
    case 'enable': {
      // Verify the daemon script exists
      if (!fs.existsSync(DAEMON_SCRIPT_ABS)) {
        fail(`Daemon script not found at: ${DAEMON_SCRIPT_ABS}`);
        info('Run "nha update" to re-download core files.');
        return;
      }

      const currentStatus = adapter.status();
      if (currentStatus.installed && currentStatus.running) {
        warn('Autostart is already enabled and running.');
        return;
      }

      try {
        adapter.install();
        const newStatus = adapter.status();
        ok(`Autostart enabled via ${adapter.name}`);
        if (newStatus.running) {
          ok(`Daemon started (PID ${newStatus.pid})`);
        } else {
          info('Daemon will start on next login.');
        }

        if (adapter.name === 'launchd') {
          info(`Plist: ${LAUNCHD_PLIST}`);
        } else {
          info(`Unit: ${SYSTEMD_FILE}`);
        }
        info('The daemon auto-restarts on crash (10s cooldown).');
      } catch (err) {
        fail(`Failed to enable autostart: ${err.message}`);
      }
      return;
    }

    case 'disable': {
      try {
        const removed = adapter.uninstall();
        if (removed) {
          ok('Autostart disabled. Daemon stopped and service removed.');
        } else {
          warn('Autostart was not enabled.');
        }
      } catch (err) {
        fail(`Failed to disable autostart: ${err.message}`);
      }
      return;
    }

    case 'status': {
      const status = adapter.status();
      console.log(`\n  ${BOLD}Autostart Status${NC}  ${D}(${adapter.name})${NC}\n`);
      console.log(`  Installed:   ${status.installed ? G + 'yes' + NC : D + 'no' + NC}`);
      console.log(`  Running:     ${status.running ? G + 'yes' + NC + (status.pid ? ` (PID ${status.pid})` : '') : R + 'no' + NC}`);

      if (adapter.name === 'launchd') {
        console.log(`  Plist:       ${D}${LAUNCHD_PLIST}${NC}`);
      } else {
        console.log(`  Unit:        ${D}${SYSTEMD_FILE}${NC}`);
      }

      console.log(`  Daemon:      ${D}${DAEMON_SCRIPT_ABS}${NC}`);
      console.log(`  Node:        ${D}${NODE_BIN}${NC}`);
      console.log('');

      if (!status.installed) {
        info('Enable with: nha autostart enable');
      }
      return;
    }

    default:
      fail(`Unknown: nha autostart ${sub}`);
      info('Commands: enable, disable, status');
  }
}
