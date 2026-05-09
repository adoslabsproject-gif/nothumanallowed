/**
 * WebSocket handler — broadcasts daemon events to the React UI.
 * Uses the `ws` package already bundled in nha-cli.
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve `ws` from nha-cli's node_modules
const require = createRequire(import.meta.url);
// __dirname = packages/nha-cli/src/server/ → ../../ = packages/nha-cli/
const { WebSocketServer } = require(
  path.resolve(__dirname, '../../node_modules/ws/index.js')
);

let wss = null;

export function setupWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/api' });

  wss.on('connection', async (ws) => {
    const { VERSION } = await import('../constants.mjs');
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
    // Send current server version so UI can detect updates
    ws.send(JSON.stringify({ type: 'version', version: VERSION }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Echo back for now — route-specific handlers can call broadcast()
        broadcast({ type: 'echo', payload: msg });
      } catch { /* ignore malformed */ }
    });

    ws.on('error', () => {});
  });
}

export function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}
