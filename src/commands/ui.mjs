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

  // Auto-start ops daemon (Telegram + cron) if not already running
  if (!isRunning()) {
    const result = startDaemon();
    if (result.ok) {
      console.log(`  \x1b[0;32m✓\x1b[0m PAO daemon started (PID ${result.pid})`);
    }
  }

  const { startServer } = await import('../server/index.mjs');
  await startServer({ port, host, noBrowser });
}
