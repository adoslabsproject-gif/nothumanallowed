/**
 * WebSocket handler — broadcasts daemon events + interactive terminal.
 * Uses the `ws` package already bundled in nha-cli.
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { NHA_DIR } from '../constants.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(
  path.resolve(__dirname, '../../node_modules/ws/index.js')
);

let wss = null;
let wssTerminal = null;

export function setupWebSocket(server) {
  // ── Main WS — daemon events + version ──
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws) => {
    const { VERSION } = await import('../constants.mjs');
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
    ws.send(JSON.stringify({ type: 'version', version: VERSION }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        broadcast({ type: 'echo', payload: msg });
      } catch {}
    });

    ws.on('error', () => {});
  });

  // ── Terminal WS — interactive shell ──
  wssTerminal = new WebSocketServer({ server, path: '/ws/terminal' });

  wssTerminal.on('connection', (ws, req) => {
    // Parse project from query: /api/terminal?cwd=ProjectName
    const url = new URL(req.url || '', 'http://localhost');
    const cwdParam = url.searchParams.get('cwd') || '';
    let cwd;
    if (cwdParam && !cwdParam.includes('/') && !cwdParam.includes('\\')) {
      // Project name → resolve to webcraft dir
      cwd = path.join(NHA_DIR, 'webcraft', cwdParam);
    } else if (cwdParam) {
      cwd = cwdParam;
    } else {
      cwd = path.join(NHA_DIR, 'webcraft');
    }
    // Security: ensure cwd is under NHA_DIR or home
    const home = os.homedir();
    if (!cwd.startsWith(NHA_DIR) && !cwd.startsWith(home)) cwd = home;
    if (!fs.existsSync(cwd)) cwd = home;

    const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
    const shellArgs = process.platform === 'win32' ? [] : ['-i']; // interactive

    const proc = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Shell stdout → WS
    proc.stdout.on('data', (data) => {
      if (ws.readyState === 1) ws.send(data);
    });

    // Shell stderr → WS
    proc.stderr.on('data', (data) => {
      if (ws.readyState === 1) ws.send(data);
    });

    // WS → Shell stdin
    ws.on('message', (data) => {
      if (proc.stdin.writable) proc.stdin.write(data);
    });

    // Cleanup
    proc.on('exit', () => {
      if (ws.readyState === 1) ws.send('\r\n[shell exited]\r\n');
      ws.close();
    });

    ws.on('close', () => {
      try { proc.kill(); } catch {}
    });

    ws.on('error', () => {
      try { proc.kill(); } catch {}
    });

    // Welcome message
    ws.send(`\x1b[32mNHA Terminal\x1b[0m — ${cwd}\r\n`);
  });
}

export function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}
