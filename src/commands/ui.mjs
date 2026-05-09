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
  let lanMode = false;

  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      port = parseInt(arg.split('=')[1], 10) || DEFAULT_PORT;
    } else if (arg === '--no-browser') {
      noBrowser = true;
    } else if (arg === '--lan' || arg === '--host' || arg === '--host=0.0.0.0') {
      lanMode = true;
    }
  }

  const host = lanMode ? '0.0.0.0' : '127.0.0.1';

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
