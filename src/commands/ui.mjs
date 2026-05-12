/**
 * nha ui — starts the NHA web interface (React + REST API server).
 *
 * The server lives in src/server/ and is bundled with the npm package.
 * The React build lives in src/ui-dist/ (output of `pnpm build` in packages/nha-ui).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { startDaemon, isRunning } from '../services/ops-daemon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3847;

export async function cmdUI(args) {
  let port = DEFAULT_PORT;
  let noBrowser = false;
  let explicitHost = null;

  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      port = parseInt(arg.split('=')[1], 10) || DEFAULT_PORT;
    } else if (arg === '--no-browser') {
      noBrowser = true;
    } else if (arg === '--lan' || arg === '-lan' || arg === '--host' || arg === '-host' || arg === 'lan') {
      explicitHost = '0.0.0.0';
      noBrowser = true;
    } else if (arg.startsWith('--host=')) {
      explicitHost = arg.split('=')[1] || '0.0.0.0';
    } else if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(arg)) {
      // Positional IP address — bind to 0.0.0.0 so it's accessible on all interfaces
      // (binding to a specific LAN IP often fails; 0.0.0.0 covers all)
      explicitHost = '0.0.0.0';
      noBrowser = true; // On a headless VM, don't try to open a browser
      console.log(`  → LAN mode: UI accessible at http://${arg}:${port}`);
    }
  }

  const host = explicitHost || '127.0.0.1';

  // Kill any existing process on this port (prevents EADDRINUSE)
  try {
    const { execSync } = await import('child_process');
    if (process.platform === 'win32') {
      // Windows: find PID on port and kill it
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8', timeout: 3000 }).trim();
      const pid = out.split(/\s+/).pop();
      if (pid && pid !== String(process.pid)) {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'ignore' });
        console.log(`  \x1b[33m!\x1b[0m Killed previous process on port ${port} (PID ${pid})`);
      }
    } else {
      // Unix/Mac: try lsof first, then fuser, then ss+kill as fallbacks
      let killed = false;
      // Method 1: lsof
      try {
        const out = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 }).trim();
        if (out) {
          const pids = out.split('\n').filter((p) => p && p !== String(process.pid));
          for (const pid of pids) { try { process.kill(parseInt(pid), 'SIGTERM'); } catch {} }
          if (pids.length > 0) { killed = true; console.log(`  \x1b[33m!\x1b[0m Killed previous process on port ${port} (PID ${pids.join(', ')})`); }
        }
      } catch {}
      // Method 2: fuser (Linux without lsof)
      if (!killed) {
        try {
          execSync(`fuser -k ${port}/tcp 2>/dev/null`, { timeout: 3000, stdio: 'ignore' });
          killed = true;
          console.log(`  \x1b[33m!\x1b[0m Killed previous process on port ${port} (via fuser)`);
        } catch {}
      }
      // Method 3: ss + kill (minimal Linux)
      if (!killed) {
        try {
          const out = execSync(`ss -tlnp 2>/dev/null | grep :${port}`, { encoding: 'utf-8', timeout: 3000 }).trim();
          const pidMatch = out.match(/pid=(\d+)/);
          if (pidMatch) {
            try { process.kill(parseInt(pidMatch[1]), 'SIGTERM'); killed = true; } catch {}
            if (killed) console.log(`  \x1b[33m!\x1b[0m Killed previous process on port ${port} (PID ${pidMatch[1]})`);
          }
        } catch {}
      }
      if (killed) await new Promise((r) => setTimeout(r, 500));
    }
  } catch { /* port is free */ }

  // Detect if we were spawned by the self-restart helper after an npm-update.
  // The marker file is written by /api/npm-update right before exiting.
  // This lets us:
  //   - confirm to the user that the upgrade landed (visible in the boot log)
  //   - guarantee the ops daemon (Telegram/Discord bot) is back up
  let restartedFromUpdate = false;
  try {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const markerPath = path.join(os.default.homedir(), '.nha', 'last-restart.json');
    if (fs.existsSync(markerPath)) {
      const stat = fs.statSync(markerPath);
      // Consider the marker fresh only if written within the last 5 minutes
      if (Date.now() - stat.mtimeMs < 5 * 60_000) {
        const meta = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
        restartedFromUpdate = true;
        console.log(`  \x1b[0;32m↻\x1b[0m Restarted after update: v${meta.fromVersion} → v${meta.toVersion}`);
      }
      // Always clean up so we don't repeat the message on next manual restart
      try { fs.unlinkSync(markerPath); } catch {}
    }
  } catch { /* non-fatal */ }

  // Auto-start ops daemon (Telegram + cron) if not already running.
  // After a self-restart this is what brings the Telegram bot back online —
  // critical for VM users whose only control channel is Telegram.
  if (!isRunning()) {
    const result = startDaemon();
    if (result.ok) {
      console.log(`  \x1b[0;32m✓\x1b[0m PAO daemon ${restartedFromUpdate ? 'restarted' : 'started'} (PID ${result.pid})`);
    } else {
      console.log(`  \x1b[0;31m✗\x1b[0m PAO daemon failed to start: ${result.error || 'unknown'}`);
      if (restartedFromUpdate) {
        console.log(`    Telegram/Discord bot may be offline. Run "nha ops start" manually.`);
      }
    }
  }

  const { startServer } = await import('../server/index.mjs');
  await startServer({ port, host, noBrowser });
}
