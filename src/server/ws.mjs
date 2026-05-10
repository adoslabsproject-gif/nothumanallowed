/**
 * WebSocket handler — broadcasts daemon events + interactive terminal.
 * Uses the `ws` package already bundled in nha-cli.
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
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
  wss = new WebSocketServer({ noServer: true });

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
  wssTerminal = new WebSocketServer({ noServer: true });

  // ── Manual upgrade handling — prevents conflicts with HTTP handler ──
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '', 'http://localhost').pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
    } else if (pathname.startsWith('/ws/terminal')) {
      wssTerminal.handleUpgrade(req, socket, head, (ws) => { wssTerminal.emit('connection', ws, req); });
    } else {
      socket.destroy();
    }
  });

  wssTerminal.on('connection', (ws, req) => {
    const url = new URL(req.url || '', 'http://localhost');
    const cwdParam = url.searchParams.get('cwd') || '';
    let cwd;
    if (cwdParam && !cwdParam.includes('/') && !cwdParam.includes('\\')) {
      cwd = path.join(NHA_DIR, 'webcraft', cwdParam);
    } else if (cwdParam) {
      cwd = cwdParam;
    } else {
      cwd = path.join(NHA_DIR, 'webcraft');
    }
    const home = os.homedir();
    if (!cwd.startsWith(NHA_DIR) && !cwd.startsWith(home)) cwd = home;
    if (!fs.existsSync(cwd)) cwd = home;

    // Command runner mode — user sends commands, we exec them and return output
    let currentCwd = cwd;
    let cmdBuffer = '';

    const send = (text) => { if (ws.readyState === 1) ws.send(text); };

    send(`\x1b[32mNHA Terminal\x1b[0m\r\n`);
    send(`\x1b[90m${currentCwd}\x1b[0m\r\n`);
    send(`\x1b[36m$ \x1b[0m`);

    ws.on('message', (data) => {
      const char = data.toString();

      // Handle special keys
      if (char === '\r' || char === '\n') {
        send('\r\n');
        const cmd = cmdBuffer.trim();
        cmdBuffer = '';

        if (!cmd) {
          send(`\x1b[36m$ \x1b[0m`);
          return;
        }

        // Built-in: cd
        if (cmd.startsWith('cd ')) {
          const target = cmd.slice(3).trim().replace('~', home);
          const newCwd = path.resolve(currentCwd, target);
          if (fs.existsSync(newCwd) && fs.statSync(newCwd).isDirectory()) {
            currentCwd = newCwd;
            send(`\x1b[90m${currentCwd}\x1b[0m\r\n`);
          } else {
            send(`\x1b[31mcd: no such directory: ${target}\x1b[0m\r\n`);
          }
          send(`\x1b[36m$ \x1b[0m`);
          return;
        }

        // Built-in: clear
        if (cmd === 'clear' || cmd === 'cls') {
          send('\x1b[2J\x1b[H');
          send(`\x1b[90m${currentCwd}\x1b[0m\r\n`);
          send(`\x1b[36m$ \x1b[0m`);
          return;
        }

        // Execute command — fully isolated from parent process stdio
        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
        const shellArg = process.platform === 'win32' ? '/c' : '-c';
        const child = execFile(shell, [shellArg, cmd], {
          cwd: currentCwd,
          timeout: 30_000,
          env: { ...process.env, TERM: 'dumb', NODE_ENV: 'development' },
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        }, (err, stdout, stderr) => {
          if (stdout) send(stdout.replace(/\n/g, '\r\n'));
          if (stderr) send(`\x1b[31m${stderr.replace(/\n/g, '\r\n')}\x1b[0m`);
          if (err && err.killed) send(`\x1b[31m[timeout]\x1b[0m\r\n`);
          else if (err && !stdout && !stderr) send(`\x1b[31m${err.message}\x1b[0m\r\n`);
          send(`\x1b[90m${currentCwd}\x1b[0m\r\n`);
          send(`\x1b[36m$ \x1b[0m`);
        });
      } else if (char === '\x7f' || char === '\b') {
        // Backspace
        if (cmdBuffer.length > 0) {
          cmdBuffer = cmdBuffer.slice(0, -1);
          send('\b \b');
        }
      } else if (char === '\x03') {
        // Ctrl+C
        cmdBuffer = '';
        send('^C\r\n');
        send(`\x1b[36m$ \x1b[0m`);
      } else if (char.charCodeAt(0) >= 32) {
        // Normal character
        cmdBuffer += char;
        send(char);
      }
    });

    ws.on('close', () => {});
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
