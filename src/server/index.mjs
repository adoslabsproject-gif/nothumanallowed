/**
 * NHA UI Server — autonomous backend for the React UI.
 *
 * Zero extra npm dependencies — Node.js 22 http module only.
 * Serves the React build (ui-dist/) statically + all /api/* routes.
 *
 * Architecture:
 *   server/
 *   ├── index.mjs          ← this file (HTTP server + router)
 *   ├── routes/            ← one file per domain
 *   │   ├── chat.mjs
 *   │   ├── studio.mjs
 *   │   ├── email.mjs
 *   │   ├── calendar.mjs
 *   │   ├── tasks.mjs
 *   │   ├── config.mjs
 *   │   ├── agents.mjs
 *   │   ├── integrations.mjs
 *   │   ├── drive.mjs
 *   │   ├── collab.mjs
 *   │   └── google-auth.mjs
 *   └── ws.mjs             ← WebSocket handler
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fallback to local dist/ if run standalone (e.g. during development)
const _cliDist   = path.resolve(__dirname, '../ui-dist');
const _localDist = path.resolve(__dirname, '../dist');
const UI_DIST = fs.existsSync(path.join(_cliDist, 'index.html')) ? _cliDist : _localDist;

// ── MIME types ───────────────────────────────────────────────────────────────

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.ico':   'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.ttf':   'font/ttf',
  '.json':  'application/json',
  '.map':   'application/json',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.webp':  'image/webp',
};

// ── HTTP helpers ─────────────────────────────────────────────────────────────

export function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

export function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

export function parseBody(req, maxBytes = 10_485_760) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function sendSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  return {
    send: (data) => res.write(`data: ${JSON.stringify(data)}\n\n`),
    end: () => { res.write('data: [DONE]\n\n'); res.end(); },
  };
}

function serveStatic(res, filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const ct = MIME[ext] || 'application/octet-stream';
    const cache = ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': cache });
    res.end(data);
    return true;
  } catch { return false; }
}

function logRequest(method, url, status, ms) {
  const G = '\x1b[0;32m', D = '\x1b[2m', NC = '\x1b[0m', R = '\x1b[0;31m';
  const color = status < 400 ? G : R;
  console.log(`  ${D}${new Date().toISOString().slice(11,19)}${NC}  ${color}${status}${NC}  ${method.padEnd(6)} ${url}  ${D}${ms}ms${NC}`);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${url}`, () => {});
}

// ── Route registry ───────────────────────────────────────────────────────────

// Each route module exports: { register(router) }
// router = { get, post, put, delete, patch } — simple prefix matcher

class Router {
  constructor() { this._routes = []; }

  _add(method, pattern, handler) {
    this._routes.push({ method: method.toUpperCase(), pattern, handler });
  }
  get(p, h)    { this._add('GET', p, h); }
  post(p, h)   { this._add('POST', p, h); }
  put(p, h)    { this._add('PUT', p, h); }
  patch(p, h)  { this._add('PATCH', p, h); }
  delete(p, h) { this._add('DELETE', p, h); }

  match(method, pathname) {
    for (const r of this._routes) {
      if (r.method !== method) continue;
      if (typeof r.pattern === 'string') {
        if (r.pattern === pathname) return { handler: r.handler, params: {} };
        // Express-style param segments: /api/foo/:id/bar
        if (r.pattern.includes('/:')) {
          const patParts = r.pattern.split('/');
          const urlParts = pathname.split('/');
          if (patParts.length === urlParts.length) {
            const params = {};
            let ok = true;
            for (let i = 0; i < patParts.length; i++) {
              if (patParts[i].startsWith(':')) {
                params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
              } else if (patParts[i] !== urlParts[i]) {
                ok = false; break;
              }
            }
            if (ok) return { handler: r.handler, params };
          }
        }
      } else if (r.pattern instanceof RegExp) {
        const m = pathname.match(r.pattern);
        if (m) return { handler: r.handler, params: m.groups || {}, match: m };
      }
    }
    return null;
  }

  // prefix match — used for routes that need to match /api/foo/*
  matchPrefix(method, pathname) {
    for (const r of this._routes) {
      if (r.method !== method) continue;
      if (typeof r.pattern === 'string' && pathname.startsWith(r.pattern + '/')) {
        return { handler: r.handler, params: {} };
      }
    }
    return null;
  }
}

async function buildRouter() {
  const router = new Router();
  const mods = await Promise.all([
    import('./routes/config.mjs'),
    import('./routes/chat.mjs'),
    import('./routes/studio.mjs'),
    import('./routes/webcraft.mjs'),
    import('./routes/email.mjs'),
    import('./routes/calendar.mjs'),
    import('./routes/tasks.mjs'),
    import('./routes/agents.mjs'),
    import('./routes/drive.mjs'),
    import('./routes/integrations.mjs'),
    import('./routes/collab.mjs'),
    import('./routes/google-auth.mjs'),
    import('./routes/connectors.mjs'),
  ]);
  for (const mod of mods) mod.register(router);
  return router;
}

// ── Main request handler ─────────────────────────────────────────────────────

let _router = null; // initialized in startServer()

async function handleRequest(req, res) {
  const router = _router;
  const start = Date.now();
  const url = new URL(req.url, `http://localhost`);
  const { pathname } = url;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
    res.end();
    return;
  }

  try {
    // ── API routes ──────────────────────────────────────────────────────
    if (pathname.startsWith('/api/')) {
      const match = router.match(method, pathname);
      if (match) {
        req.params = match.params;
        req.query = Object.fromEntries(url.searchParams);
        await match.handler(req, res);
        logRequest(method, pathname, res.statusCode || 200, Date.now() - start);
        return;
      }
      // prefix-based routes (for dynamic segments like /api/agents/:id)
      // handled inside route modules via req.params injected above
      sendError(res, 404, `Unknown API route: ${method} ${pathname}`);
      logRequest(method, pathname, 404, Date.now() - start);
      return;
    }

    // ── Suppress browser probes ─────────────────────────────────────────
    if (pathname.startsWith('/.well-known')) {
      res.writeHead(204); res.end(); return;
    }

    // ── Serve React build (static files) ───────────────────────────────
    if (method === 'GET') {
      if (fs.existsSync(path.join(UI_DIST, 'index.html'))) {
        const file = pathname === '/' ? 'index.html' : pathname.slice(1);
        if (serveStatic(res, path.join(UI_DIST, file))) {
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }
        // SPA fallback
        serveStatic(res, path.join(UI_DIST, 'index.html'));
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }
      // No build yet
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="font-family:monospace;padding:2rem;background:#0a0a0a;color:#e5e5e5">
<h2 style="color:#22c55e">NHA UI — build not found</h2>
<p>Run: <code style="background:#1a1a1a;padding:2px 8px;border-radius:4px">cd packages/nha-ui &amp;&amp; pnpm build</code></p>
</body></html>`);
      logRequest(method, pathname, 503, Date.now() - start);
      return;
    }

    res.writeHead(404); res.end();
  } catch (e) {
    console.error('[server] Error handling request:', e);
    if (!res.headersSent) sendError(res, 500, e.message);
    logRequest(method, pathname, 500, Date.now() - start);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

export async function startServer({ port = 3847, host = '127.0.0.1', noBrowser = false } = {}) {
  _router = await buildRouter();
  const { setupWebSocket } = await import('./ws.mjs');

  const server = http.createServer(handleRequest);
  setupWebSocket(server);

  await new Promise((resolve, reject) => {
    server.listen(port, host, (err) => err ? reject(err) : resolve());
  });

  const G = '\x1b[0;32m', NC = '\x1b[0m', D = '\x1b[2m', BOLD = '\x1b[1m';
  const { VERSION } = await import('../constants.mjs');
  console.log(`\n  ${BOLD}${G}NHA${NC} ${D}v${VERSION}${NC}`);
  console.log(`  ${G}✓${NC} Server running on ${G}http://${host}:${port}${NC}`);
  console.log(`  ${D}Press Ctrl+C to stop${NC}\n`);

  // Telemetry ping — fire and forget
  fetch('https://nothumanallowed.com/api/v1/telemetry/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'nha-ui', version: VERSION }),
  }).catch(() => {});

  if (!noBrowser) openBrowser(`http://localhost:${port}`);

  return server;
}
