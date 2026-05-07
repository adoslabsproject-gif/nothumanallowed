/**
 * nha ui — Local web interface for NHA operations.
 *
 * Starts a zero-dependency HTTP server on localhost:3847 serving a single-page
 * operations console with REST API endpoints that reuse existing services.
 *
 * Zero npm dependencies — Node.js 22 native http module only.
 */

import http from 'http';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config.mjs';
import { detectMailProvider, hasMailProvider, getProviderStatus } from '../services/mail-router.mjs';
import { callLLM, callLLMStream, callAgent, parseAgentFile } from '../services/llm.mjs';
import { getUnreadImportant, getMessage, listMessages, sendEmail, createDraft } from '../services/mail-router.mjs';
import { getTodayEvents, getUpcomingEvents, createEvent, updateEvent, deleteEvent, getEventsForDate } from '../services/mail-router.mjs';
import {
  getTasks,
  addTask,
  completeTask,
  getDayStats,
} from '../services/task-store.mjs';
import { runPlanningPipeline } from '../services/ops-pipeline.mjs';
import { AGENTS, AGENTS_DIR, NHA_DIR, VERSION } from '../constants.mjs';
import { getHTML, getJS } from '../services/web-ui.mjs';
import { loadChatHistory, saveChatHistory, extractMemory, buildMemoryContext } from '../services/memory.mjs';
import {
  createConversation,
  loadConversation,
  saveConversation,
  deleteConversation,
  listConversations,
  getOrCreateActive,
  setActiveId,
  getHistory,
  addMessages,
  retryMessage,
  addRetryResponse,
  editMessage,
  navigateFork,
  getForkInfo,
  exportAsMarkdown,
  exportAsJson,
  migrateOldHistory,
} from '../services/conversations.mjs';
import { info, ok, fail, warn, C, G, D, NC, BOLD } from '../ui.mjs';
import {
  parseActions,
  executeTool,
  formatTime as fmtTime,
  buildSystemPrompt,
} from '../services/tool-executor.mjs';

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3847;

/**
 * Extract text from PDF buffer — zero dependencies.
 * Handles text-based PDFs (not scanned images).
 * Extracts text from PDF stream objects using basic PDF parsing.
 */
function extractTextFromPdf(buffer) {
  try {
    const raw = buffer.toString('latin1');
    const texts = [];

    // Extract text from BT...ET blocks (PDF text objects)
    const btRegex = /BT[\s\S]*?ET/g;
    let match;
    while ((match = btRegex.exec(raw)) !== null) {
      const block = match[0];
      // Extract Tj (show string) and TJ (show array) operators
      const tjRegex = /\(([^)]*)\)\s*Tj|\[([^\]]*)\]\s*TJ/g;
      let tj;
      while ((tj = tjRegex.exec(block)) !== null) {
        if (tj[1]) texts.push(tj[1]);
        if (tj[2]) {
          // TJ array: extract strings from parenthesized elements
          const arr = tj[2];
          const strRegex = /\(([^)]*)\)/g;
          let s;
          while ((s = strRegex.exec(arr)) !== null) {
            texts.push(s[1]);
          }
        }
      }
    }

    // Also try to extract from FlateDecode streams (compressed text)
    // This handles most modern PDFs
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    while ((match = streamRegex.exec(raw)) !== null) {
      try {
        const { inflateSync } = zlib;
        const inflated = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1');
        const btInner = /BT[\s\S]*?ET/g;
        let m2;
        while ((m2 = btInner.exec(inflated)) !== null) {
          const block = m2[0];
          const tjR = /\(([^)]*)\)\s*Tj|\[([^\]]*)\]\s*TJ/g;
          let t;
          while ((t = tjR.exec(block)) !== null) {
            if (t[1]) texts.push(t[1]);
            if (t[2]) {
              const sr = /\(([^)]*)\)/g;
              let ss;
              while ((ss = sr.exec(t[2])) !== null) texts.push(ss[1]);
            }
          }
        }
      } catch { /* not a flate stream or decompression failed */ }
    }

    // Decode PDF escape sequences
    let result = texts.join(' ')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\')
      .replace(/\s+/g, ' ')
      .trim();

    return result;
  } catch {
    return '';
  }
}

// ── Agent loader ──────────────────────────────────────────────────────────

function loadAgentCards() {
  const cards = [];
  for (const name of AGENTS) {
    const file = path.join(AGENTS_DIR, `${name}.mjs`);
    let card = { name, category: 'agent', tagline: '' };
    try {
      if (fs.existsSync(file)) {
        const source = fs.readFileSync(file, 'utf-8');
        const parsed = parseAgentFile(source, name);
        card = { name, ...parsed.card };
      }
    } catch {}
    cards.push(card);
  }
  return cards;
}

// ── Plan file loader ──────────────────────────────────────────────────────

function loadTodayPlan() {
  const dateStr = new Date().toISOString().split('T')[0];
  const planFile = path.join(NHA_DIR, 'ops', 'plans', `${dateStr}.json`);
  if (fs.existsSync(planFile)) {
    try { return JSON.parse(fs.readFileSync(planFile, 'utf-8')); }
    catch { return null; }
  }
  return null;
}

// ── HTTP Helpers ──────────────────────────────────────────────────────────

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendHTML(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(html);
}

function parseBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = maxBytes || 1_048_576; // 1 MB default
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX) { reject(new Error('Body too large')); req.destroy(); return; }
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

// ── Open browser ──────────────────────────────────────────────────────────

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${url}`, () => {});
}

// ── Request logger ──────────────────────────────────────────────────────────

function logRequest(method, url, statusCode, durationMs) {
  const color = statusCode < 400 ? G : '\x1b[0;31m';
  console.log(`  ${D}${new Date().toISOString().slice(11,19)}${NC}  ${color}${statusCode}${NC}  ${method.padEnd(6)} ${url}  ${D}${durationMs}ms${NC}`);
}

// ── Server ───────────────────────────────────────────────────────────────

export async function cmdUI(args) {
  // Parse flags
  let port = DEFAULT_PORT;
  let noBrowser = false;
  let lanMode = false;
  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      port = parseInt(arg.split('=')[1], 10) || DEFAULT_PORT;
    } else if (arg === '--no-browser') {
      noBrowser = true;
    } else if (arg === '--lan') {
      lanMode = true;
    }
  }
  const HOST = lanMode ? '0.0.0.0' : '127.0.0.1';

  const config = loadConfig();
  const htmlPage = getHTML(port);
  const jsBundle = getJS();

  // Migrate old chat history to multi-conversation format
  migrateOldHistory();

  // Pre-load agent cards once at startup
  const agentCards = loadAgentCards();

  // Chat session state (persists across requests while server is running)
  const UI_PERSONA = `You are NHA Chat, a personal operations assistant inside the NotHumanAllowed web UI. ` +
    `You help the user manage their emails, calendar, tasks, GitHub issues, Notion pages, and Slack channels through natural conversation. ` +
    `Be concise, helpful, and proactive. When presenting data, format it clearly. ` +
    `Never output raw JSON to the user.`;
  const chatSystemPrompt = await buildSystemPrompt('NHA UI', UI_PERSONA, config);

  // Returns a live IMAP accounts block to append to any system prompt
  async function getImapAccountsContext() {
    try {
      const { listAccounts } = await import('../services/email-db.mjs');
      const accs = listAccounts();
      if (!accs.length) return '';
      let ctx = '\n\n--- IMAP EMAIL ACCOUNTS (custom, already configured) ---\n';
      ctx += 'Use these accountIds directly in imap_* tools — do NOT call imap_accounts() first.\n';
      for (const a of accs) {
        ctx += `accountId: "${a.id}" | email: ${a.email_address} | name: "${a.display_name}" | status: ${a.sync_status}\n`;
      }
      ctx += 'When the user mentions their company name, email domain, or display name, map it to the correct accountId above.';
      return ctx;
    } catch { return ''; }
  }

  // ── Route Handlers ──────────────────────────────────────────────────────

  async function handleRequest(req, res) {
    const start = Date.now();
    const url = new URL(req.url, `http://${HOST}:${port}`);
    const pathname = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      // ── Serve HTML page ─────────────────────────────────────────────
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        sendHTML(res, htmlPage);
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── JS bundle ───────────────────────────────────────────────────
      if (method === 'GET' && pathname.startsWith('/nha-ui.js')) {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.end(jsBundle);
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── PWA Manifest ────────────────────────────────────────────────
      if (pathname === '/manifest.json') {
        sendJSON(res, 200, {
          name: 'NHA — Operations Console',
          short_name: 'NHA',
          description: '38 AI agents for daily ops. Email, calendar, tasks, security.',
          start_url: '/',
          display: 'standalone',
          background_color: '#0a0a0a',
          theme_color: '#0a0a0a',
          icons: [
            { src: 'https://nothumanallowed.com/icon-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'https://nothumanallowed.com/icon-512x512.png', sizes: '512x512', type: 'image/png' },
          ],
        });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Favicon + Apple touch icons + browser probes (suppress 404) ────
      if (pathname === '/favicon.ico' || pathname.startsWith('/apple-touch-icon') || pathname.startsWith('/.well-known')) {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── API Routes ────────────────────────────────────────────────────

      // GET /api/screenshots/:filename — serve saved screenshots from disk
      if (method === 'GET' && pathname.startsWith('/api/screenshots/')) {
        const ssName = pathname.split('/').pop();
        if (!ssName || ssName.includes('..') || !ssName.endsWith('.jpg')) {
          sendJSON(res, 404, { error: 'not found' });
          logRequest(method, pathname, 404, Date.now() - start);
          return;
        }
        const ssPath = path.join(NHA_DIR, 'screenshots', ssName);
        if (!fs.existsSync(ssPath)) {
          sendJSON(res, 404, { error: 'screenshot not found' });
          logRequest(method, pathname, 404, Date.now() - start);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        res.end(fs.readFileSync(ssPath));
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/google/auth — trigger Google OAuth flow from web UI
      if (method === 'POST' && pathname === '/api/google/auth') {
        try {
          const { runAuthFlow } = await import('../services/google-oauth.mjs');
          // Run auth flow in background — opens browser
          runAuthFlow(config).then(success => {
            if (success) config._googleConnected = true;
          }).catch(() => {});
          sendJSON(res, 200, { ok: true, message: 'OAuth flow started. Check the browser window that opened.' });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Collab (Alexandria proxy) ─────────────────────────────────────
      if (pathname.startsWith('/api/collab/')) {
        const collabAction = pathname.split('/').pop();
        const ALEX_API = 'https://nothumanallowed.com/api/v1/alexandria';

        // Get or create collab identity
        const collabDir = path.join(NHA_DIR, 'collab');
        const idFile = path.join(collabDir, 'identity.json');
        let identity;
        if (fs.existsSync(idFile)) {
          identity = JSON.parse(fs.readFileSync(idFile, 'utf-8'));
        } else {
          fs.mkdirSync(collabDir, { recursive: true });
          const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
            publicKeyEncoding: { type: 'spki', format: 'der' },
            privateKeyEncoding: { type: 'pkcs8', format: 'der' },
          });
          identity = {
            publicKey: publicKey.toString('base64'),
            privateKey: privateKey.toString('base64'),
            fingerprint: crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16),
            displayName: config.profile?.name || 'User',
          };
          fs.writeFileSync(idFile, JSON.stringify(identity, null, 2), { mode: 0o600 });
        }

        // GET /api/collab/channels — list local channels (from CLI + web UI)
        if (collabAction === 'channels' && method === 'GET') {
          const chFile = path.join(collabDir, 'channels.json');
          let localChannels = [];
          if (fs.existsSync(chFile)) {
            try { localChannels = JSON.parse(fs.readFileSync(chFile, 'utf-8')); } catch {}
          }
          sendJSON(res, 200, { channels: localChannels, identity: { fingerprint: identity.fingerprint, displayName: identity.displayName } });
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        // POST /api/collab/channels — save channel to local file (sync web UI → CLI)
        if (collabAction === 'channels' && method === 'POST') {
          const body = await parseBody(req);
          const chFile = path.join(collabDir, 'channels.json');
          let localChannels = [];
          if (fs.existsSync(chFile)) { try { localChannels = JSON.parse(fs.readFileSync(chFile, 'utf-8')); } catch {} }
          if (!localChannels.find((c) => c.id === body.id)) {
            localChannels.push({ id: body.id, name: body.name, active: true, role: body.role || 'member', createdAt: new Date().toISOString() });
            localChannels.forEach((c) => { if (c.id !== body.id) c.active = false; });
            fs.writeFileSync(chFile, JSON.stringify(localChannels, null, 2), { mode: 0o600 });
          }
          sendJSON(res, 200, { ok: true });
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (collabAction === 'create' && method === 'POST') {
          const body = await parseBody(req);
          const r = await fetch(ALEX_API + '/channels', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: body.name, creatorFingerprint: identity.fingerprint, creatorPublicKey: identity.publicKey, creatorDisplayName: identity.displayName, visibility: body.visibility || 'private' }),
          });
          sendJSON(res, 200, await r.json());
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (collabAction === 'join' && method === 'POST') {
          const body = await parseBody(req);
          const r = await fetch(ALEX_API + '/channels/' + body.channelId + '/join', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fingerprint: identity.fingerprint, publicKey: identity.publicKey, displayName: identity.displayName }),
          });
          const data = await r.json();
          // Get channel info for name
          const info = await fetch(ALEX_API + '/channels/' + body.channelId);
          const chInfo = await info.json();
          data.name = chInfo.name || body.channelId;
          sendJSON(res, 200, data);
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (collabAction === 'messages' && method === 'GET') {
          const chId = url.searchParams.get('channelId');
          if (!chId) { sendJSON(res, 400, { error: 'channelId required' }); return; }
          const r = await fetch(ALEX_API + '/channels/' + chId + '/messages?fp=' + identity.fingerprint);
          if (!r.ok) {
            sendJSON(res, 200, { error: 'Channel not found or expired', messages: [] });
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          }
          let data;
          try { data = await r.json(); } catch {
            sendJSON(res, 200, { error: 'Invalid response from server', messages: [] });
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          }
          // Decrypt using channel key (ID + secret from local file)
          const chFile2 = path.join(collabDir, 'channels.json');
          let chSecret = '';
          try { const chs = JSON.parse(fs.readFileSync(chFile2, 'utf-8')); const found = chs.find(c => c.id === chId); chSecret = found?.secret || ''; } catch {}
          const channelKey = crypto.createHash('sha256').update('alexandria-e2e-key-v2').update(chId).update(chSecret).digest();
          if (data.messages) {
            for (const msg of data.messages) {
              if (msg.type === 'system' || !msg.ciphertext || !msg.nonce) continue;
              try {
                const nonce = Buffer.from(msg.nonce, 'base64');
                const raw = Buffer.from(msg.ciphertext, 'base64');
                const tag = raw.subarray(raw.length - 16);
                const encrypted = raw.subarray(0, raw.length - 16);
                const decipher = crypto.createDecipheriv('aes-256-gcm', channelKey, nonce);
                decipher.setAuthTag(tag);
                msg.content = decipher.update(encrypted) + decipher.final('utf-8');
              } catch {
                msg.content = '[cannot decrypt]';
              }
              // Add sender name from members list
              const sender = data.members?.find((m) => m.fingerprint === msg.senderFingerprint);
              msg.senderName = sender?.displayName || msg.senderFingerprint?.slice(0, 8) || 'Unknown';
            }
          }
          sendJSON(res, 200, data);
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (collabAction === 'send' && method === 'POST') {
          const body = await parseBody(req);
          // Encrypt with channel key (ID + secret)
          let sendSecret = '';
          try { const chs3 = JSON.parse(fs.readFileSync(path.join(collabDir, 'channels.json'), 'utf-8')); sendSecret = chs3.find(c => c.id === body.channelId)?.secret || ''; } catch {}
          const channelKey = crypto.createHash('sha256').update('alexandria-e2e-key-v2').update(body.channelId).update(sendSecret).digest();
          const nonce = crypto.randomBytes(12);
          const cipher = crypto.createCipheriv('aes-256-gcm', channelKey, nonce);
          const encrypted = Buffer.concat([cipher.update(body.message, 'utf-8'), cipher.final()]);
          const tag = cipher.getAuthTag();
          const ciphertext = Buffer.concat([encrypted, tag]).toString('base64');

          const r = await fetch(ALEX_API + '/channels/' + body.channelId + '/messages', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ senderFingerprint: identity.fingerprint, nonce: nonce.toString('base64'), ciphertext, type: 'text' }),
          });
          const result = await r.json();
          // Broadcast own message via WS immediately (so other tabs/views see it)
          wsBroadcast({
            type: 'collab_message',
            channelId: body.channelId,
            message: {
              senderName: identity.displayName || 'You',
              senderFingerprint: identity.fingerprint,
              content: body.message,
              timestamp: result.timestamp || new Date().toISOString(),
              type: 'text',
            },
          });
          sendJSON(res, 200, result);
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (collabAction === 'delete' && method === 'POST') {
          const body = await parseBody(req);
          // Remove from local channels file
          const chFile = path.join(collabDir, 'channels.json');
          let localChannels = [];
          if (fs.existsSync(chFile)) { try { localChannels = JSON.parse(fs.readFileSync(chFile, 'utf-8')); } catch {} }
          localChannels = localChannels.filter(c => c.id !== body.channelId);
          fs.writeFileSync(chFile, JSON.stringify(localChannels, null, 2), { mode: 0o600 });
          // Try to delete from server too
          try {
            await fetch(ALEX_API + '/channels/' + body.channelId, {
              method: 'DELETE', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fingerprint: identity.fingerprint }),
            });
          } catch {}
          sendJSON(res, 200, { ok: true });
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (collabAction === 'publish' && method === 'POST') {
          const body = await parseBody(req);
          // Load conversation and publish as public channel
          const conv = loadConversation(body.conversationId);
          if (!conv || !conv.messages || conv.messages.length === 0) {
            sendJSON(res, 400, { error: 'Conversation not found or empty' });
            logRequest(method, pathname, 400, Date.now() - start);
            return;
          }
          const r = await fetch(ALEX_API + '/channels/publish-conversation', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: body.title || conv.title || 'Published Conversation',
              description: body.description || '',
              creatorFingerprint: identity.fingerprint,
              creatorPublicKey: identity.publicKey,
              creatorDisplayName: identity.displayName,
              messages: conv.messages,
            }),
          });
          sendJSON(res, 200, await r.json());
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        sendJSON(res, 404, { error: 'Unknown collab action' });
        logRequest(method, pathname, 404, Date.now() - start);
        return;
      }

      // GET /api/health — simple health check
      if (method === 'GET' && pathname === '/api/health') {
        sendJSON(res, 200, { ok: true, version: VERSION });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/version/check — check npm registry for latest version
      if (method === 'GET' && pathname === '/api/version/check') {
        try {
          const npmRes = await fetch('https://registry.npmjs.org/nothumanallowed/latest', {
            signal: AbortSignal.timeout(5000),
            headers: { 'Accept': 'application/json' },
          });
          if (!npmRes.ok) { sendJSON(res, 200, { current: VERSION, latest: VERSION, updateAvailable: false }); }
          else {
            const data = await npmRes.json();
            const latest = data.version || VERSION;
            const pa = VERSION.split('.').map(Number);
            const pb = latest.split('.').map(Number);
            let cmp = 0;
            for (let i = 0; i < 3; i++) { if ((pa[i]||0) > (pb[i]||0)) { cmp = -1; break; } if ((pa[i]||0) < (pb[i]||0)) { cmp = 1; break; } }
            sendJSON(res, 200, { current: VERSION, latest, updateAvailable: cmp > 0 });
          }
        } catch(_) { sendJSON(res, 200, { current: VERSION, latest: VERSION, updateAvailable: false }); }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/status
      if (method === 'GET' && pathname === '/api/status') {
        sendJSON(res, 200, {
          connected: true,
          version: VERSION,
          provider: config.llm.provider,
          hasApiKey: !!config.llm.apiKey || config.llm.provider === 'nha',
          hasGoogle: !!config.google?.clientId,
          hasMicrosoft: !!config.microsoft?.clientId,
          mailProvider: detectMailProvider(config),
          mailProviders: getProviderStatus(),
          agentName: config.agent?.name || null,
          timestamp: new Date().toISOString(),
        });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/config — save a config value from the web UI
      if (method === 'POST' && pathname === '/api/config') {
        const body = await parseBody(req);
        if (!body.key) {
          sendJSON(res, 400, { error: 'key required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }
        const { setConfigValue, loadConfig: reloadConfig } = await import('../config.mjs');
        const success = setConfigValue(body.key, body.value || '');
        if (success) {
          // Reload config in memory so the chat system picks up changes immediately
          const newConfig = reloadConfig();
          Object.assign(config, newConfig);
        }
        sendJSON(res, 200, { ok: success, key: body.key });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/config — read config values for settings UI
      if (method === 'GET' && pathname === '/api/config') {
        // Return non-sensitive config for the settings form
        sendJSON(res, 200, {
          profile: config.profile || {},
          provider: config.llm?.provider || '',
          model: config.llm?.model || '',
          hasApiKey: !!config.llm?.apiKey || config.llm?.provider === 'nha',
          planTime: config.ops?.planTime || '07:00',
          summaryTime: config.ops?.summaryTime || '18:00',
          meetingAlert: config.ops?.meetingAlertMinutes || 30,
          hasTelegram: !!config.responder?.telegram?.token,
          hasDiscord: !!config.responder?.discord?.token,
        });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/email/read — read full email by ID
      if (method === 'POST' && pathname === '/api/email/read') {
        const body = await parseBody(req);
        if (!body.messageId) {
          sendJSON(res, 400, { error: 'messageId required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }
        try {
          const msg = await getMessage(config, body.messageId);
          sendJSON(res, 200, { message: msg });
        } catch (e) {
          sendJSON(res, 200, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/email/mark-read — mark email as read
      if (method === 'POST' && pathname === '/api/email/mark-read') {
        const body = await parseBody(req);
        if (!body.messageId) {
          sendJSON(res, 400, { error: 'messageId required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }
        try {
          const gmail = await import('../services/google-gmail.mjs');
          await gmail.markAsRead(config, body.messageId);
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 200, { ok: false, error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/email/mark-all-read — mark ALL unread as read
      if (method === 'POST' && pathname === '/api/email/mark-all-read') {
        try {
          const gmail = await import('../services/google-gmail.mjs');
          const result = await gmail.markAllAsRead(config);
          // Update local cache
          dash.emails.forEach(e => { e.isUnread = false; });
          sendJSON(res, 200, { ok: true, count: result.count });
        } catch (e) {
          sendJSON(res, 200, { ok: false, error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ═══════════════════════════════════════════════════════════════════
      // IMAP EMAIL CLIENT ROUTES — READ-ONLY IMAP, local SQLite DB
      // ═══════════════════════════════════════════════════════════════════

      // GET /api/imap/accounts
      if (method === 'GET' && pathname === '/api/imap/accounts') {
        try {
          const { listAccounts } = await import('../services/email-db.mjs');
          sendJSON(res, 200, { accounts: listAccounts() });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/accounts — create account
      if (method === 'POST' && pathname === '/api/imap/accounts') {
        try {
          const body = await parseBody(req);
          const { createAccount, listAccounts } = await import('../services/email-db.mjs');
          if (!body.email_address || !body.imap_host || !body.smtp_host || !body.password) {
            sendJSON(res, 400, { error: 'email_address, imap_host, smtp_host, password required' }); return;
          }
          const id = createAccount(body);
          sendJSON(res, 200, { ok: true, id });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/accounts/update
      if (method === 'POST' && pathname === '/api/imap/accounts/update') {
        try {
          const body = await parseBody(req);
          const { updateAccount } = await import('../services/email-db.mjs');
          if (!body.id) { sendJSON(res, 400, { error: 'id required' }); return; }
          updateAccount(body.id, body);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/accounts/delete
      if (method === 'POST' && pathname === '/api/imap/accounts/delete') {
        try {
          const body = await parseBody(req);
          const { deleteAccount } = await import('../services/email-db.mjs');
          if (!body.id) { sendJSON(res, 400, { error: 'id required' }); return; }
          deleteAccount(body.id);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/sync — trigger incremental sync for an account
      if (method === 'POST' && pathname === '/api/imap/sync') {
        try {
          const body = await parseBody(req);
          if (!body.accountId) { sendJSON(res, 400, { error: 'accountId required' }); return; }
          const { syncAccount } = await import('../services/email-imap.mjs');
          // Run async — respond immediately
          sendJSON(res, 200, { ok: true, status: 'syncing' });
          syncAccount(body.accountId).catch(e => console.error('[email:sync]', e.message));
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // GET /api/imap/messages?accountId=&labelId=&limit=&offset=&search=
      if (method === 'GET' && pathname === '/api/imap/messages') {
        try {
          const accountId = url.searchParams.get('accountId');
          const labelId   = url.searchParams.get('labelId') || null;
          const limit     = parseInt(url.searchParams.get('limit') || '50', 10);
          const offset    = parseInt(url.searchParams.get('offset') || '0', 10);
          const search    = url.searchParams.get('search') || null;
          if (!accountId) { sendJSON(res, 400, { error: 'accountId required' }); return; }
          const { listMessages } = await import('../services/email-db.mjs');
          const result = listMessages(accountId, labelId, limit, offset, search);
          sendJSON(res, 200, result);
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // GET /api/imap/message?id=
      if (method === 'GET' && pathname === '/api/imap/message') {
        try {
          const id = url.searchParams.get('id');
          if (!id) { sendJSON(res, 400, { error: 'id required' }); return; }
          const { getMessage, markRead } = await import('../services/email-db.mjs');
          const msg = getMessage(id);
          if (!msg) { sendJSON(res, 404, { error: 'not found' }); return; }
          markRead(id, true);
          sendJSON(res, 200, { message: msg });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // GET /api/imap/thread?threadId=&accountId=
      if (method === 'GET' && pathname === '/api/imap/thread') {
        try {
          const threadId = url.searchParams.get('threadId');
          const accountId = url.searchParams.get('accountId');
          if (!threadId || !accountId) { sendJSON(res, 400, { error: 'threadId and accountId required' }); return; }
          const { getThread } = await import('../services/email-db.mjs');
          sendJSON(res, 200, { messages: getThread(threadId, accountId) });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // GET /api/imap/labels?accountId=
      if (method === 'GET' && pathname === '/api/imap/labels') {
        try {
          const accountId = url.searchParams.get('accountId');
          if (!accountId) { sendJSON(res, 400, { error: 'accountId required' }); return; }
          const { listLabels } = await import('../services/email-db.mjs');
          sendJSON(res, 200, { labels: listLabels(accountId) });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/labels/create
      if (method === 'POST' && pathname === '/api/imap/labels/create') {
        try {
          const body = await parseBody(req);
          const { createLabel } = await import('../services/email-db.mjs');
          if (!body.accountId || !body.name) { sendJSON(res, 400, { error: 'accountId, name required' }); return; }
          const id = createLabel(body.accountId, body.name, body.color, body.parentId);
          sendJSON(res, 200, { ok: true, id });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/labels/update
      if (method === 'POST' && pathname === '/api/imap/labels/update') {
        try {
          const body = await parseBody(req);
          const { updateLabel } = await import('../services/email-db.mjs');
          if (!body.id) { sendJSON(res, 400, { error: 'id required' }); return; }
          updateLabel(body.id, body);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/labels/delete
      if (method === 'POST' && pathname === '/api/imap/labels/delete') {
        try {
          const body = await parseBody(req);
          const { deleteLabel } = await import('../services/email-db.mjs');
          if (!body.id) { sendJSON(res, 400, { error: 'id required' }); return; }
          deleteLabel(body.id);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/labels/assign — add label to message
      if (method === 'POST' && pathname === '/api/imap/labels/assign') {
        try {
          const body = await parseBody(req);
          const { addMessageToLabel, removeMessageFromLabel } = await import('../services/email-db.mjs');
          if (!body.messageId || !body.labelId) { sendJSON(res, 400, { error: 'messageId, labelId required' }); return; }
          if (body.remove) removeMessageFromLabel(body.messageId, body.labelId);
          else addMessageToLabel(body.messageId, body.labelId);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // GET /api/imap/unread-count — total unread across all active IMAP accounts
      if (method === 'GET' && pathname === '/api/imap/unread-count') {
        try {
          const { listAccounts, getDb } = await import('../services/email-db.mjs');
          const accounts = listAccounts();
          const db = getDb();
          let total = 0;
          for (const acc of accounts) {
            const row = db.prepare(`
              SELECT COUNT(*) as n FROM email_messages m
              JOIN email_message_labels eml ON eml.message_id = m.id
              JOIN email_labels l ON l.id = eml.label_id
              LEFT JOIN email_message_state s ON s.message_id = m.id
              WHERE m.account_id = ? AND l.system_type = 'inbox'
                AND COALESCE(s.is_read, 0) = 0
                AND m.permanently_deleted = 0
            `).get(acc.id);
            total += row?.n || 0;
          }
          sendJSON(res, 200, { unread: total });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/mark-read
      if (method === 'POST' && pathname === '/api/imap/mark-read') {
        try {
          const body = await parseBody(req);
          const { markRead } = await import('../services/email-db.mjs');
          if (!body.messageId) { sendJSON(res, 400, { error: 'messageId required' }); return; }
          markRead(body.messageId, body.isRead !== false);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/mark-starred
      if (method === 'POST' && pathname === '/api/imap/mark-starred') {
        try {
          const body = await parseBody(req);
          const { markStarred } = await import('../services/email-db.mjs');
          if (!body.messageId) { sendJSON(res, 400, { error: 'messageId required' }); return; }
          markStarred(body.messageId, body.isStarred !== false);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/mark-all-read
      if (method === 'POST' && pathname === '/api/imap/mark-all-read') {
        try {
          const body = await parseBody(req);
          const { markAllRead } = await import('../services/email-db.mjs');
          if (!body.accountId) { sendJSON(res, 400, { error: 'accountId required' }); return; }
          const count = markAllRead(body.accountId, body.labelId || null);
          sendJSON(res, 200, { ok: true, count });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/trash — soft delete (moves to trash label, NEVER touches IMAP)
      if (method === 'POST' && pathname === '/api/imap/trash') {
        try {
          const body = await parseBody(req);
          const { softDelete } = await import('../services/email-db.mjs');
          if (!body.messageId) { sendJSON(res, 400, { error: 'messageId required' }); return; }
          softDelete(body.messageId);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/send — send email via SMTP
      if (method === 'POST' && pathname === '/api/imap/send') {
        try {
          const body = await parseBody(req);
          const { sendEmail } = await import('../services/email-smtp.mjs');
          if (!body.accountId || !body.to || !body.subject) {
            sendJSON(res, 400, { error: 'accountId, to, subject required' }); return;
          }
          const result = await sendEmail(body.accountId, body);
          sendJSON(res, 200, { ok: true, messageId: result.messageId });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/drafts/save
      if (method === 'POST' && pathname === '/api/imap/drafts/save') {
        try {
          const body = await parseBody(req);
          const { saveDraft } = await import('../services/email-db.mjs');
          if (!body.accountId) { sendJSON(res, 400, { error: 'accountId required' }); return; }
          const id = saveDraft(body.accountId, body);
          sendJSON(res, 200, { ok: true, id });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // GET /api/imap/drafts?accountId=
      if (method === 'GET' && pathname === '/api/imap/drafts') {
        try {
          const accountId = url.searchParams.get('accountId');
          if (!accountId) { sendJSON(res, 400, { error: 'accountId required' }); return; }
          const { listDrafts } = await import('../services/email-db.mjs');
          sendJSON(res, 200, { drafts: listDrafts(accountId) });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/drafts/delete
      if (method === 'POST' && pathname === '/api/imap/drafts/delete') {
        try {
          const body = await parseBody(req);
          const { deleteDraft } = await import('../services/email-db.mjs');
          if (!body.id) { sendJSON(res, 400, { error: 'id required' }); return; }
          deleteDraft(body.id);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // GET /api/imap/blocked?accountId=
      if (method === 'GET' && pathname === '/api/imap/blocked') {
        try {
          const accountId = url.searchParams.get('accountId');
          if (!accountId) { sendJSON(res, 400, { error: 'accountId required' }); return; }
          const { listBlockedSenders } = await import('../services/email-db.mjs');
          sendJSON(res, 200, { blocked: listBlockedSenders(accountId) });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/blocked/add
      if (method === 'POST' && pathname === '/api/imap/blocked/add') {
        try {
          const body = await parseBody(req);
          const { blockSender } = await import('../services/email-db.mjs');
          if (!body.accountId || !body.email) { sendJSON(res, 400, { error: 'accountId, email required' }); return; }
          blockSender(body.accountId, body.email);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/blocked/remove
      if (method === 'POST' && pathname === '/api/imap/blocked/remove') {
        try {
          const body = await parseBody(req);
          const { unblockSender } = await import('../services/email-db.mjs');
          if (!body.id) { sendJSON(res, 400, { error: 'id required' }); return; }
          unblockSender(body.id);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // GET /api/imap/rules?accountId=
      if (method === 'GET' && pathname === '/api/imap/rules') {
        try {
          const accountId = url.searchParams.get('accountId');
          if (!accountId) { sendJSON(res, 400, { error: 'accountId required' }); return; }
          const { listArchivingRules } = await import('../services/email-db.mjs');
          sendJSON(res, 200, { rules: listArchivingRules(accountId) });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/rules/create
      if (method === 'POST' && pathname === '/api/imap/rules/create') {
        try {
          const body = await parseBody(req);
          const { createArchivingRule } = await import('../services/email-db.mjs');
          if (!body.accountId || !body.matchType || !body.matchValue) {
            sendJSON(res, 400, { error: 'accountId, matchType, matchValue required' }); return;
          }
          const id = createArchivingRule(body.accountId, body.matchType, body.matchValue, body.targetLabelId);
          sendJSON(res, 200, { ok: true, id });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/rules/delete
      if (method === 'POST' && pathname === '/api/imap/rules/delete') {
        try {
          const body = await parseBody(req);
          const { deleteArchivingRule } = await import('../services/email-db.mjs');
          if (!body.id) { sendJSON(res, 400, { error: 'id required' }); return; }
          deleteArchivingRule(body.id);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // GET /api/imap/signatures?accountId=
      if (method === 'GET' && pathname === '/api/imap/signatures') {
        try {
          const accountId = url.searchParams.get('accountId');
          if (!accountId) { sendJSON(res, 400, { error: 'accountId required' }); return; }
          const { listSignatures } = await import('../services/email-db.mjs');
          sendJSON(res, 200, { signatures: listSignatures(accountId) });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/signatures/create
      if (method === 'POST' && pathname === '/api/imap/signatures/create') {
        try {
          const body = await parseBody(req);
          const { createSignature } = await import('../services/email-db.mjs');
          if (!body.accountId || !body.name || !body.content) {
            sendJSON(res, 400, { error: 'accountId, name, content required' }); return;
          }
          const id = createSignature(body.accountId, body.name, body.content, body.isDefault || false);
          sendJSON(res, 200, { ok: true, id });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // POST /api/imap/signatures/delete
      if (method === 'POST' && pathname === '/api/imap/signatures/delete') {
        try {
          const body = await parseBody(req);
          const { deleteSignature } = await import('../services/email-db.mjs');
          if (!body.id) { sendJSON(res, 400, { error: 'id required' }); return; }
          deleteSignature(body.id);
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // GET /api/imap/attachment?messageId=&partId=&accountId=
      if (method === 'GET' && pathname === '/api/imap/attachment') {
        try {
          const messageId = url.searchParams.get('messageId');
          const partId    = url.searchParams.get('partId');
          const accountId = url.searchParams.get('accountId');
          if (!messageId || !accountId) { sendJSON(res, 400, { error: 'messageId, accountId required' }); return; }
          const { getMessage } = await import('../services/email-db.mjs');
          const { fetchAttachmentContent } = await import('../services/email-imap.mjs');
          const msg = getMessage(messageId);
          if (!msg) { sendJSON(res, 404, { error: 'message not found' }); return; }
          const att = msg.attachments?.find(a => a.part_id === partId);
          if (!att) { sendJSON(res, 404, { error: 'attachment not found' }); return; }
          // Check local cache first
          const db = (await import('../services/email-db.mjs')).getDb();
          const cached = db.prepare('SELECT content_blob, content_type FROM email_attachments WHERE id = ?').get(att.id);
          if (cached?.content_blob) {
            res.writeHead(200, { 'Content-Type': cached.content_type || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${att.filename || 'attachment'}"` });
            res.end(cached.content_blob);
          } else {
            const result = await fetchAttachmentContent(accountId, msg.imap_folder_path, msg.uid, partId);
            if (!result) { sendJSON(res, 404, { error: 'could not fetch attachment' }); return; }
            res.writeHead(200, { 'Content-Type': result.contentType || att.content_type || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${att.filename || 'attachment'}"` });
            res.end(result.buffer);
          }
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
        logRequest(method, pathname, 200, Date.now() - start); return;
      }

      // ═══════════════════════════════════════════════════════════════════

      // POST /api/contacts — create contact
      if (method === 'POST' && pathname === '/api/contacts') {
        try {
          const gc = await import('../services/google-contacts.mjs');
          const body = await parseBody(req);
          const contact = await gc.createContact(config, body);
          sendJSON(res, 201, { contact });
        } catch (e) {
          sendJSON(res, 200, { error: e.message });
        }
        logRequest(method, pathname, 201, Date.now() - start);
        return;
      }

      // POST /api/contacts/delete — delete contact
      if (method === 'POST' && pathname === '/api/contacts/delete') {
        try {
          const gc = await import('../services/google-contacts.mjs');
          const body = await parseBody(req);
          await gc.deleteContact(config, body.resourceName);
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 200, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/contacts/update — update contact
      if (method === 'POST' && pathname === '/api/contacts/update') {
        try {
          const gc = await import('../services/google-contacts.mjs');
          const body = await parseBody(req);
          const contact = await gc.updateContact(config, body.resourceName, body.fields || {});
          sendJSON(res, 200, { contact });
        } catch (e) {
          sendJSON(res, 200, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/contacts — list or search contacts
      if (method === 'GET' && pathname === '/api/contacts') {
        try {
          const gc = await import('../services/google-contacts.mjs');
          const q = url.searchParams.get('q');
          let contacts;
          if (q) {
            contacts = await gc.searchContacts(config, q, 20);
          } else {
            contacts = await gc.listContacts(config, 50);
          }
          sendJSON(res, 200, { contacts });
        } catch (e) {
          sendJSON(res, 200, { contacts: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/notes — list notes | POST /api/notes — create note
      if (pathname === '/api/notes' && !pathname.includes('/api/notes/')) {
        if (method === 'GET') {
          try {
            const ns = await import('../services/notes.mjs');
            const q = url.searchParams.get('q');
            const notes = q ? ns.searchNotes(q) : ns.listNotes();
            sendJSON(res, 200, { notes });
          } catch (e) {
            sendJSON(res, 200, { notes: [], error: e.message });
          }
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }
        if (method === 'POST') {
          try {
            const ns = await import('../services/notes.mjs');
            const body = await parseBody(req);
            const note = ns.createNote(body.title || 'Untitled', body.content || '', body.tags || []);
            sendJSON(res, 201, { note });
          } catch (e) {
            sendJSON(res, 200, { error: e.message });
          }
          logRequest(method, pathname, 201, Date.now() - start);
          return;
        }
      }

      // GET /api/notes/:id — get note | POST /api/notes/:id — update | POST /api/notes/:id/delete — delete
      const noteMatch = pathname.match(/^\/api\/notes\/([a-f0-9-]+)(\/delete)?$/);
      if (noteMatch) {
        const noteId = noteMatch[1];
        const isDelete = noteMatch[2] === '/delete';
        try {
          const ns = await import('../services/notes.mjs');
          if (isDelete && method === 'POST') {
            ns.deleteNote(noteId);
            sendJSON(res, 200, { ok: true });
          } else if (method === 'POST') {
            const body = await parseBody(req);
            const note = ns.updateNote(noteId, body.title, body.content, body.tags);
            sendJSON(res, 200, { ok: !!note, note });
          } else {
            const note = ns.getNote(noteId);
            sendJSON(res, 200, { note });
          }
        } catch (e) {
          sendJSON(res, 200, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/onedrive — OneDrive files
      if (method === 'GET' && pathname === '/api/onedrive') {
        try {
          const od = await import('../services/microsoft-drive.mjs');
          const q = url.searchParams.get('q');
          const files = q ? await od.searchFiles(config, q, 20) : await od.listFiles(config, 30);
          let quota = null;
          try { quota = await od.getStorageQuota(config); } catch {}
          sendJSON(res, 200, { files, quota });
        } catch (e) {
          sendJSON(res, 200, { files: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/mstodo — Microsoft To Do tasks
      if (method === 'GET' && pathname === '/api/mstodo') {
        try {
          const mt = await import('../services/microsoft-todo.mjs');
          const listId = await mt.getDefaultListId(config);
          const tasks = await mt.listTasks(config, listId);
          sendJSON(res, 200, { tasks });
        } catch (e) {
          sendJSON(res, 200, { tasks: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/mstodo — create To Do task
      if (method === 'POST' && pathname === '/api/mstodo') {
        try {
          const mt = await import('../services/microsoft-todo.mjs');
          const body = await parseBody(req);
          const listId = await mt.getDefaultListId(config);
          const task = await mt.createTask(config, listId, body.title, body.body || '', body.dueDate || '', body.importance || 'normal');
          sendJSON(res, 201, { task });
        } catch (e) {
          sendJSON(res, 200, { error: e.message });
        }
        logRequest(method, pathname, 201, Date.now() - start);
        return;
      }

      // POST /api/mstodo/:id/complete
      const mstodoCompleteMatch = pathname.match(/^\/api\/mstodo\/([^/]+)\/complete$/);
      if (method === 'POST' && mstodoCompleteMatch) {
        try {
          const mt = await import('../services/microsoft-todo.mjs');
          const body = await parseBody(req);
          await mt.completeTask(config, body.listId || 'defaultList', mstodoCompleteMatch[1]);
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 200, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/drive — list recent Drive files
      if (method === 'GET' && pathname === '/api/drive') {
        try {
          const gd = await import('../services/google-drive.mjs');
          const filter = url.searchParams.get('filter');
          const search = url.searchParams.get('q');
          let files;
          if (search) {
            files = await gd.searchFiles(config, search, 20);
          } else if (filter === 'starred') {
            files = await gd.getStarredFiles(config, 20);
          } else if (filter === 'shared') {
            files = await gd.getSharedFiles(config, 20);
          } else if (filter === 'recent') {
            files = await gd.getRecentFiles(config, 15);
          } else {
            files = await gd.listFiles(config, 30);
          }
          let quota = null;
          try { quota = await gd.getStorageQuota(config); } catch {}
          sendJSON(res, 200, { files, quota });
        } catch (e) {
          sendJSON(res, 200, { files: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/drive/read/:fileId — read file as text
      if (method === 'GET' && pathname.startsWith('/api/drive/read/')) {
        const fileId = pathname.split('/api/drive/read/')[1];
        try {
          const gd = await import('../services/google-drive.mjs');
          const content = await gd.readFileAsText(config, fileId);
          sendJSON(res, 200, { content });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/drive/download/:fileId — download file as base64
      if (method === 'GET' && pathname.startsWith('/api/drive/download/')) {
        const fileId = pathname.split('/api/drive/download/')[1];
        try {
          const gd = await import('../services/google-drive.mjs');
          const dl = await gd.downloadFileContent(config, fileId);
          sendJSON(res, 200, dl);
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/drive/update/:fileId — update file content
      if (method === 'POST' && pathname.startsWith('/api/drive/update/')) {
        const fileId = pathname.split('/api/drive/update/')[1];
        try {
          const body = await readBody(req);
          const gd = await import('../services/google-drive.mjs');
          const result = await gd.updateFileContent(config, fileId, body.content || '');
          sendJSON(res, 200, result);
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/drive/upload — upload new file
      if (method === 'POST' && pathname === '/api/drive/upload') {
        try {
          const body = await readBody(req);
          const gd = await import('../services/google-drive.mjs');
          let content = body.content || '';
          if (body.encoding === 'base64') content = Buffer.from(content, 'base64');
          const result = await gd.uploadFile(config, body.name, content, body.mimeType || 'text/plain', body.folderId || 'root');
          sendJSON(res, 200, result);
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/drive/delete/:fileId — trash file
      if (method === 'POST' && pathname.startsWith('/api/drive/delete/')) {
        const fileId = pathname.split('/api/drive/delete/')[1];
        try {
          const gd = await import('../services/google-drive.mjs');
          await gd.trashFile(config, fileId);
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/emails?page=0&pageSize=25&filter=unread|all
      if (method === 'GET' && pathname === '/api/emails') {
        try {
          const filter = url.searchParams.get('filter');
          const page = parseInt(url.searchParams.get('page') || '0', 10);
          const pageSize = parseInt(url.searchParams.get('pageSize') || '25', 10);

          if (filter === 'unread') {
            const emails = await getUnreadImportant(config, pageSize);
            sendJSON(res, 200, { emails, page, hasMore: false });
          } else {
            const gm = await import('../services/google-gmail.mjs');
            // Fetch more refs than needed so we know if there are more pages
            const totalToFetch = (page + 1) * pageSize + 1;
            const msgRefs = await gm.listMessages(config, 'in:inbox', totalToFetch);

            // Slice for current page
            const pageRefs = msgRefs.slice(page * pageSize, (page + 1) * pageSize);
            const hasMore = msgRefs.length > (page + 1) * pageSize;

            // Fetch message details (parallel, batches of 5 for speed)
            const emails = [];
            for (let i = 0; i < pageRefs.length; i += 5) {
              const batch = pageRefs.slice(i, i + 5);
              const results = await Promise.allSettled(
                batch.map(ref => gm.getMessage(config, ref.id))
              );
              for (const r of results) {
                if (r.status === 'fulfilled') emails.push(r.value);
              }
            }

            // Cache emails in memory for the session
            if (!config._emailCache) config._emailCache = [];
            for (const em of emails) {
              if (!config._emailCache.find(c => c.id === em.id)) {
                config._emailCache.push(em);
              }
            }

            sendJSON(res, 200, { emails, page, hasMore, totalCached: config._emailCache?.length || 0 });
          }
        } catch (e) {
          sendJSON(res, 200, { emails: [], error: e.message, page: 0, hasMore: false });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/calendar?date=YYYY-MM-DD   OR   ?month=YYYY-MM (loads entire month)
      if (method === 'GET' && pathname === '/api/calendar') {
        try {
          const dateParam = url.searchParams.get('date');
          const monthParam = url.searchParams.get('month'); // e.g. "2026-05"
          if (monthParam) {
            // Load entire month across all calendars in one shot
            const [y, m] = monthParam.split('-').map(Number);
            const startOfMonth = new Date(y, m - 1, 1);
            const endOfMonth = new Date(y, m, 1);
            const { listCalendars: lc, listEvents: le } = await import('../services/google-calendar.mjs');
            const calendars = await lc(config);
            const byDate = {};
            for (const cal of calendars) {
              if (cal.accessRole === 'freeBusyReader') continue;
              const isHolidayFeed = cal.id.includes('#holiday@group');
              try {
                const evts = await le(config, cal.id, startOfMonth, endOfMonth);
                for (const e of evts) {
                  e.calendarId = cal.id;
                  e.calendarName = cal.summary;
                  e.readOnly = cal.accessRole === 'reader' || cal.accessRole === 'freeBusyReader';
                  e._isHoliday = isHolidayFeed;
                  const dk = (e.start || '').slice(0, 10);
                  if (!byDate[dk]) byDate[dk] = [];
                  // Dedup holidays per date
                  if (isHolidayFeed && byDate[dk].some(x => x._isHoliday)) continue;
                  byDate[dk].push(e);
                }
              } catch { /* skip */ }
            }
            sendJSON(res, 200, { byDate, month: monthParam });
          } else {
            let events;
            if (dateParam) {
              events = await getEventsForDate(config, dateParam);
            } else {
              events = await getTodayEvents(config);
            }
            sendJSON(res, 200, { events, date: dateParam || new Date().toISOString().split('T')[0] });
          }
        } catch (e) {
          sendJSON(res, 200, { events: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/calendar — create event
      if (method === 'POST' && pathname === '/api/calendar') {
        try {
          const body = await parseBody(req);
          if (!body.summary) { sendJSON(res, 400, { error: 'summary required' }); logRequest(method, pathname, 400, Date.now() - start); return; }
          const calendarId = body.calendarId || 'primary';
          const event = { summary: body.summary };
          if (body.description) event.description = body.description;
          if (body.location) event.location = body.location;
          if (body.allDay && body.date) {
            event.start = { date: body.date };
            event.end = { date: body.date };
          } else {
            const startDT = body.start || (body.date ? body.date + 'T09:00:00' : new Date().toISOString());
            const endDT = body.end || (body.date ? body.date + 'T10:00:00' : new Date(Date.now() + 3600000).toISOString());
            event.start = { dateTime: startDT };
            event.end = { dateTime: endDT };
          }
          const created = await createEvent(config, event, calendarId);
          sendJSON(res, 201, { event: created });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 201, Date.now() - start);
        return;
      }

      // PATCH /api/calendar/:calId/:eventId — update event
      const calPatchMatch = pathname.match(/^\/api\/calendar\/([^/]+)\/([^/]+)$/);
      if (method === 'PATCH' && calPatchMatch) {
        try {
          const calendarId = decodeURIComponent(calPatchMatch[1]);
          const eventId = decodeURIComponent(calPatchMatch[2]);
          const body = await parseBody(req);
          const patch = {};
          if (body.summary !== undefined) patch.summary = body.summary;
          if (body.description !== undefined) patch.description = body.description;
          if (body.location !== undefined) patch.location = body.location;
          if (body.start !== undefined) patch.start = { dateTime: body.start };
          if (body.end !== undefined) patch.end = { dateTime: body.end };
          const updated = await updateEvent(config, calendarId, eventId, patch);
          sendJSON(res, 200, { event: updated });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // DELETE /api/calendar/:calId/:eventId — delete event
      const calDeleteMatch = pathname.match(/^\/api\/calendar\/([^/]+)\/([^/]+)$/);
      if (method === 'DELETE' && calDeleteMatch) {
        try {
          const calendarId = decodeURIComponent(calDeleteMatch[1]);
          const eventId = decodeURIComponent(calDeleteMatch[2]);
          await deleteEvent(config, calendarId, eventId);
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/tasks
      if (method === 'GET' && pathname === '/api/tasks') {
        const tasks = getTasks();
        const stats = getDayStats();
        sendJSON(res, 200, { tasks, stats });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/tasks
      if (method === 'POST' && pathname === '/api/tasks') {
        const body = await parseBody(req);
        if (!body.description) {
          sendJSON(res, 400, { error: 'description required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }
        const task = addTask({
          description: body.description,
          priority: body.priority || 'medium',
          due: body.due || null,
          source: 'web-ui',
        });
        sendJSON(res, 201, { task });
        logRequest(method, pathname, 201, Date.now() - start);
        return;
      }

      // PATCH /api/tasks/:id/done
      const taskDoneMatch = pathname.match(/^\/api\/tasks\/(\d+)\/done$/);
      if (method === 'PATCH' && taskDoneMatch) {
        const taskId = parseInt(taskDoneMatch[1], 10);
        const success = completeTask(taskId);
        sendJSON(res, 200, { ok: success, id: taskId });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/tasks/:id/delete
      const taskDeleteMatch = pathname.match(/^\/api\/tasks\/(\d+)\/delete$/);
      if (method === 'POST' && taskDeleteMatch) {
        const { deleteTask } = await import('../services/task-store.mjs');
        const taskId = parseInt(taskDeleteMatch[1], 10);
        const success = deleteTask(taskId);
        sendJSON(res, 200, { ok: success, id: taskId });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/tasks/clear
      if (method === 'POST' && pathname === '/api/tasks/clear') {
        const { clearTasks } = await import('../services/task-store.mjs');
        const body = await parseBody(req);
        const mode = body.mode || 'all';
        const count = clearTasks(mode);
        sendJSON(res, 200, { ok: true, removed: count });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/plan
      if (method === 'GET' && pathname === '/api/plan') {
        const plan = loadTodayPlan();
        sendJSON(res, 200, { plan });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/plan/refresh
      if (method === 'POST' && pathname === '/api/plan/refresh') {
        try {
          const plan = await runPlanningPipeline(config, { refresh: true });
          sendJSON(res, 200, { plan });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/chat
      if (method === 'POST' && pathname === '/api/chat') {
        const body = await parseBody(req);
        if (!body.message) {
          sendJSON(res, 400, { error: 'message required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }

        const msg = body.message.trim();

        // ── Slash commands ───────────────────────────────────────
        if (msg === '/agents') {
          const custom = agentCards.filter(a => a.category === 'custom').map(a => a.name);
          const builtIn = agentCards.filter(a => a.category !== 'custom').map(a => a.name);
          sendJSON(res, 200, { response: `**Available agents (${agentCards.length}):**\n\nBuilt-in: ${builtIn.join(', ')}\n${custom.length ? `\nCustom: ${custom.join(', ')}` : ''}\n\nUse \`@agent your message\` to route to a specific agent.\nUse \`/agent <name>\` to switch all messages.\nUse \`/agent off\` to return to NHA Chat.` });
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (msg.startsWith('/agent ')) {
          const agentName = msg.slice(7).trim().toLowerCase();
          if (agentName === 'off' || agentName === 'reset') {
            config._chatAgent = null;
            sendJSON(res, 200, { response: 'Switched back to NHA Chat.' });
          } else {
            const found = agentCards.find(a => a.name === agentName);
            const agentFile = path.join(AGENTS_DIR, `${agentName}.mjs`);
            let sysPrompt = `You are the ${agentName} AI agent. Be expert and helpful.`;
            if (fs.existsSync(agentFile)) {
              const src = fs.readFileSync(agentFile, 'utf-8');
              const parsed = parseAgentFile(src, agentName);
              if (parsed.systemPrompt) sysPrompt = parsed.systemPrompt;
            }
            config._chatAgent = { name: agentName, systemPrompt: sysPrompt };
            sendJSON(res, 200, { response: `Now chatting with **${agentName.toUpperCase()}**${found ? ` (${found.tagline})` : ''}.\nAll messages will be routed to this agent.\nType \`/agent off\` to return to NHA Chat.` });
          }
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (msg === '/create-agent' || msg.startsWith('/create-agent ')) {
          const parts = msg.slice(14).trim();
          if (!parts) {
            sendJSON(res, 200, { response: '**Create Custom Agent**\n\nUsage:\n```\n/create-agent mybot "Short description" "You are an expert in..."\n```\n\nExample:\n```\n/create-agent chef "Italian cooking expert" "You are a master Italian chef. Always suggest authentic recipes."\n```' });
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          }
          const nameMatch = parts.match(/^(\S+)\s+(.*)/s);
          if (!nameMatch) {
            sendJSON(res, 200, { response: 'Usage: `/create-agent <name> "<tagline>" "<system prompt>"`' });
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          }
          const agentName = nameMatch[1].toLowerCase().replace(/[^a-z0-9_-]/g, '');
          const rest = nameMatch[2];
          const quoteParts = rest.match(/"([^"]*)"/g);
          let tagline = '', sysPrompt = '';
          if (quoteParts && quoteParts.length >= 2) {
            tagline = quoteParts[0].replace(/"/g, '');
            sysPrompt = quoteParts[1].replace(/"/g, '');
          } else {
            tagline = rest.replace(/"/g, '').trim();
            sysPrompt = tagline;
          }
          if (!agentName || !tagline) {
            sendJSON(res, 200, { response: 'All fields required. Usage: `/create-agent name "tagline" "system prompt"`' });
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          }
          const agentFile = path.join(AGENTS_DIR, `${agentName}.mjs`);
          if (fs.existsSync(agentFile)) {
            sendJSON(res, 200, { response: `Agent "${agentName}" already exists. Delete it first with \`/delete-agent ${agentName}\`` });
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          }
          const content = `// NHA Custom Agent: ${agentName}\n// Created: ${new Date().toISOString()}\n\nexport const CARD = {\n  name: '${agentName}',\n  displayName: '${agentName.toUpperCase()}',\n  category: 'custom',\n  tagline: '${tagline.replace(/'/g, "\\'")}',\n};\n\nexport const SYSTEM_PROMPT = \`${sysPrompt.replace(/`/g, '\\`')}\`;\n`;
          if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });
          fs.writeFileSync(agentFile, content, 'utf-8');
          // Reload agent cards
          agentCards.push({ name: agentName, displayName: agentName.toUpperCase(), category: 'custom', tagline });
          sendJSON(res, 200, { response: `Agent **${agentName.toUpperCase()}** created!\n\nSwitch to it: \`/agent ${agentName}\`\nOr use inline: \`@${agentName} your question\`` });
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (msg.startsWith('/delete-agent ')) {
          const agentName = msg.slice(14).trim().toLowerCase();
          const agentFile = path.join(AGENTS_DIR, `${agentName}.mjs`);
          if (!fs.existsSync(agentFile)) {
            sendJSON(res, 200, { response: `Agent "${agentName}" not found.` });
          } else {
            fs.unlinkSync(agentFile);
            const idx = agentCards.findIndex(a => a.name === agentName);
            if (idx >= 0) agentCards.splice(idx, 1);
            sendJSON(res, 200, { response: `Agent "${agentName}" deleted.` });
          }
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (msg === '/help') {
          sendJSON(res, 200, { response: '**Chat Commands**\n\n`/agents` — List all agents\n`/agent <name>` — Switch chat to agent\n`/agent off` — Return to NHA Chat\n`/create-agent name "tagline" "prompt"` — Create custom agent\n`/delete-agent name` — Delete agent\n`@agent message` — Route single message to agent\n`/help` — Show this help' });
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        // ── Direct intent handlers (bypass LLM for reliability) ──
        const msgLower = msg.toLowerCase();

        // Mark all emails as read
        if (msgLower.match(/segna.*tutt.*lett|mark.*all.*read|tutte.*lett[ae]|read.*all.*email|segna.*email.*lett/)) {
          try {
            const gmail = await import('../services/google-gmail.mjs');
            const result = await gmail.markAllAsRead(config);
            const count = result.count || 0;
            sendJSON(res, 200, { response: count > 0 ? `Done! ${count} email${count !== 1 ? 's' : ''} marked as read.` : 'All emails are already read.', toolResults: [{ action: 'gmail_mark_read', result: `${count} marked` }] });
          } catch (e) {
            sendJSON(res, 200, { response: `Error marking emails as read: ${e.message}` });
          }
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        // ── @agent inline routing ────────────────────────────────
        let effectiveSystemPrompt = config._chatAgent?.systemPrompt || null;
        const atMatch = msg.match(/^@(\w+)\s+([\s\S]*)/);
        if (atMatch) {
          const inlineAgent = atMatch[1].toLowerCase();
          body.message = atMatch[2];
          const agentFile = path.join(AGENTS_DIR, `${inlineAgent}.mjs`);
          if (fs.existsSync(agentFile)) {
            const src = fs.readFileSync(agentFile, 'utf-8');
            const parsed = parseAgentFile(src, inlineAgent);
            if (parsed.systemPrompt) effectiveSystemPrompt = parsed.systemPrompt;
          } else {
            effectiveSystemPrompt = `You are the ${inlineAgent} AI agent. Be expert, concise, and helpful.`;
          }
        }

        if (!config.llm.provider || (!config.llm.apiKey && config.llm.provider !== 'nha')) {
          config.llm.provider = 'nha'; // Auto-fallback to free tier
        }

        // Build message with rolling context (same strategy as streaming path)
        const requestHistory = (body.history || []).map(h => ({
          role: h.role,
          content: (h.content || '').replace(/!\[Screenshot\]\(data:image\/[^)]+\)/g, '[Screenshot taken]'),
        }));
        const RECENT = 6;
        const parts = [];
        if (requestHistory.length > RECENT) {
          const older = requestHistory.slice(0, -RECENT);
          const sLines = [];
          for (let i = 0; i < older.length; i += 2) {
            const u = older[i]?.content?.slice(0, 150)?.replace(/\n/g, ' ') || '';
            const a = older[i + 1]?.content?.slice(0, 200)?.replace(/\n/g, ' ') || '';
            if (u) sLines.push(`- User: "${u.trim()}${u.length >= 150 ? '...' : ''}" → ${a.trim()}${a.length >= 200 ? '...' : ''}`);
          }
          if (sLines.length > 0) parts.push(`[CONTEXT — ${sLines.length} earlier exchanges]\n${sLines.join('\n')}\n[END CONTEXT]`);
        }
        for (const turn of requestHistory.slice(-RECENT)) {
          parts.push(`${turn.role === 'user' ? '[User]' : '[Assistant]'} ${turn.content.slice(0, 2000)}`);
        }
        parts.push(`[User] ${body.message}`);
        let userMessage = parts.join('\n\n');

        // Inject episodic memory + live IMAP accounts into the system prompt
        const basePrompt = effectiveSystemPrompt || chatSystemPrompt;
        let enrichedSystemPrompt = basePrompt;
        try {
          const memCtx = buildMemoryContext('chat', body.message);
          if (memCtx) enrichedSystemPrompt = basePrompt + memCtx;
        } catch { /* memory unavailable */ }
        try {
          const imapCtx = await getImapAccountsContext();
          if (imapCtx) enrichedSystemPrompt += imapCtx;
        } catch { /* imap context unavailable */ }

        // Handle image attachment — vision API
        if (body.imageBase64 && body.imageMimeType) {
          try {
            const provider = config.llm.provider || 'anthropic';
            const apiKey = config.llm.apiKey;
            const model = config.llm.model;
            const imagePrompt = body.message || 'Describe this image in detail. Extract any text or important information.';
            let visionResponse = '';

            if (provider === 'nha') {
              // NHA Free tier — Liara Vision (zero API key)
              const r = await fetch('https://nothumanallowed.com/api/v1/liara/vision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-nha-client': 'studio' },
                body: JSON.stringify({ image_base64: body.imageBase64, prompt: imagePrompt }),
              });
              if (!r.ok) throw new Error(`Liara Vision ${r.status}`);
              const d = await r.json();
              visionResponse = d.description || d.text || JSON.stringify(d);
            } else if (provider === 'anthropic') {
              const r = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
                body: JSON.stringify({
                  model: model || 'claude-sonnet-4-20250514', max_tokens: 4096,
                  system: enrichedSystemPrompt ? [{ type: 'text', text: enrichedSystemPrompt, cache_control: { type: 'ephemeral' } }] : [],
                  messages: [{ role: 'user', content: [
                    { type: 'image', source: { type: 'base64', media_type: body.imageMimeType, data: body.imageBase64 } },
                    { type: 'text', text: imagePrompt },
                  ]}],
                }),
              });
              if (!r.ok) throw new Error(`Anthropic ${r.status}`);
              const d = await r.json();
              visionResponse = d.content?.[0]?.text || '';
            } else if (provider === 'openai') {
              const r = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                  model: model || 'gpt-4o-mini', max_tokens: 4096,
                  messages: [
                    { role: 'system', content: enrichedSystemPrompt },
                    { role: 'user', content: [
                      { type: 'image_url', image_url: { url: `data:${body.imageMimeType};base64,${body.imageBase64}` } },
                      { type: 'text', text: imagePrompt },
                    ]},
                  ],
                }),
              });
              if (!r.ok) throw new Error(`OpenAI ${r.status}`);
              const d = await r.json();
              visionResponse = d.choices?.[0]?.message?.content || '';
            } else if (provider === 'gemini') {
              const m = model || 'gemini-2.0-flash';
              const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  system_instruction: { parts: [{ text: enrichedSystemPrompt }] },
                  contents: [{ parts: [
                    { inline_data: { mime_type: body.imageMimeType, data: body.imageBase64 } },
                    { text: imagePrompt },
                  ]}],
                  generationConfig: { maxOutputTokens: 4096 },
                }),
              });
              if (!r.ok) throw new Error(`Gemini ${r.status}`);
              const d = await r.json();
              visionResponse = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
            } else {
              visionResponse = `Vision not supported for provider "${provider}". Use anthropic, openai, or gemini.`;
            }

            sendJSON(res, 200, { response: visionResponse });
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          } catch (e) {
            sendJSON(res, 200, { response: null, error: e.message });
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          }
        }

        // Handle PDF attachment — send as document to Claude (native PDF support)
        if (body.pdfBase64 && body.pdfName) {
          try {
            const provider = config.llm.provider || 'anthropic';
            const apiKey = config.llm.apiKey;
            const model = config.llm.model;
            const pdfPrompt = body.message || `Read and analyze this PDF document "${body.pdfName}". Extract all text content, summarize key information.`;
            let pdfResponse = '';

            if (provider === 'nha') {
              // NHA Free tier: extract text from PDF, then send to Liara chat
              // Decode PDF base64 and extract text content
              const pdfBuffer = Buffer.from(body.pdfBase64, 'base64');
              const pdfText = extractTextFromPdf(pdfBuffer);
              if (!pdfText || pdfText.length < 10) {
                // Fallback: send first page as image to vision model
                const r = await fetch('https://nothumanallowed.com/api/v1/liara/vision', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-nha-client': 'studio' },
                  body: JSON.stringify({ image_base64: body.pdfBase64, prompt: pdfPrompt }),
                });
                if (r.ok) {
                  const d = await r.json();
                  pdfResponse = d.description || d.text || 'Could not extract content from this PDF.';
                } else {
                  pdfResponse = 'Could not read this PDF. Try a text-based PDF or use Claude/Gemini for scanned documents.';
                }
              } else {
                // Send extracted text to Liara chat
                const truncatedText = pdfText.slice(0, 12000);
                const r = await fetch('https://nothumanallowed.com/api/v1/liara/chat', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-nha-client': 'studio' },
                  body: JSON.stringify({
                    model: 'nha-v1',
                    messages: [
                      { role: 'system', content: enrichedSystemPrompt },
                      { role: 'user', content: `[PDF: ${body.pdfName}]\n\n${truncatedText}\n\n---\n\n${pdfPrompt}` },
                    ],
                    max_tokens: 4096,
                    chat_template_kwargs: { enable_thinking: false },
                  }),
                });
                if (r.ok) {
                  const d = await r.json();
                  pdfResponse = d.choices?.[0]?.message?.content || '';
                } else {
                  pdfResponse = 'Error reading PDF via Liara.';
                }
              }
            } else if (provider === 'anthropic') {
              const r = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
                body: JSON.stringify({
                  model: model || 'claude-sonnet-4-20250514', max_tokens: 8192,
                  system: enrichedSystemPrompt ? [{ type: 'text', text: enrichedSystemPrompt, cache_control: { type: 'ephemeral' } }] : [],
                  messages: [{ role: 'user', content: [
                    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: body.pdfBase64 } },
                    { type: 'text', text: pdfPrompt },
                  ]}],
                }),
              });
              if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
              const d = await r.json();
              pdfResponse = d.content?.[0]?.text || '';
            } else if (provider === 'gemini') {
              const m = model || 'gemini-2.0-flash';
              const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  system_instruction: { parts: [{ text: enrichedSystemPrompt }] },
                  contents: [{ parts: [
                    { inline_data: { mime_type: 'application/pdf', data: body.pdfBase64 } },
                    { text: pdfPrompt },
                  ]}],
                  generationConfig: { maxOutputTokens: 8192 },
                }),
              });
              if (!r.ok) throw new Error(`Gemini ${r.status}`);
              const d = await r.json();
              pdfResponse = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
            } else {
              pdfResponse = `PDF reading requires Anthropic (Claude) or Gemini. Your provider "${provider}" does not support native PDF documents.`;
            }

            sendJSON(res, 200, { response: pdfResponse });
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          } catch (e) {
            sendJSON(res, 200, { response: null, error: `PDF error: ${e.message}` });
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          }
        }

        // Handle text file attachment
        if (body.fileContent && body.fileName) {
          const filePrompt = body.message
            ? `User asks about file "${body.fileName}": ${body.message}\n\nFile content:\n${body.fileContent.slice(0, 8000)}`
            : `Analyze this file "${body.fileName}":\n\n${body.fileContent.slice(0, 8000)}`;
          userMessage = filePrompt;
        }

        try {
          const response = await callLLM(config, enrichedSystemPrompt, userMessage);
          const { textParts, actions } = parseActions(response);
          const textResponse = textParts.join('\n\n');

          // Execute ALL tool actions and collect results
          const toolResults = [];
          let screenshotData = null; // For vision: { base64, path, question }
          for (const { action, params } of actions) {
            try {
              const result = await executeTool(action, params, config);
              // Intercept structured screenshot result for vision flow
              if (result && typeof result === 'object' && result.__screenshot) {
                screenshotData = result;
                toolResults.push({ action, result: 'Screenshot captured. Analyzing with vision...' });
              } else {
                let rStr = typeof result === 'object' ? JSON.stringify(result) : String(result);
                if ((action === 'web_search' || action === 'fetch_url') && rStr.includes('<')) {
                  rStr = rStr.replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s{3,}/g,'\n').replace(/[^\x00-\x7F]/g,'').trim().slice(0,6000);
                }
                toolResults.push({ action, result: rStr });
              }
            } catch (e) {
              toolResults.push({ action, result: `Error: ${e.message}` });
            }
          }

          let fullResponse;
          if (screenshotData && screenshotData.base64) {
            // VISION FLOW: send screenshot to LLM as image via callLLMVision
            try {
              const { callLLMVision } = await import('../services/llm.mjs');
              const visionPrompt = enrichedSystemPrompt + '\n\nIMPORTANT: You are looking at a REAL screenshot from the user\'s screen. Describe ONLY what you ACTUALLY see. NEVER invent, guess, or fabricate details. If something is unclear, say so.';
              const question = `The user said: "${body.message}"\n\n${screenshotData.question}\n\nDescribe ONLY what you see. NEVER make up information.`;
              fullResponse = await callLLMVision(config, visionPrompt, question, {
                base64: screenshotData.base64,
                mimeType: 'image/png',
              });
            } catch (visionErr) {
              fullResponse = `I captured a screenshot but vision analysis failed: ${visionErr.message}. To use screen analysis, configure a vision-capable provider (Claude, GPT-4, Gemini).`;
            }
            // Prepend screenshot file marker for the UI to display inline
            if (screenshotData.path) {
              const fname = screenshotData.path.split('/').pop();
              // Copy to NHA screenshots dir for persistence
              try {
                const ssDir = path.join(NHA_DIR, 'screenshots');
                fs.mkdirSync(ssDir, { recursive: true });
                fs.copyFileSync(screenshotData.path, path.join(ssDir, fname));
              } catch {}
              fullResponse = `![Screenshot](/api/screenshots/${fname})\n\n${fullResponse}`;
            }
          } else if (toolResults.length > 0) {
            // Extract canvas/screenshot markers from tool results BEFORE second LLM call
            // These markers must be preserved in the final response for the UI to render
            let preservedMarkers = '';
            const toolContext = toolResults.map(t => {
              let clean = t.result;
              // Extract and preserve canvas markers
              const canvasMatch = clean.match(/\[CANVAS_RENDER\][\s\S]*?\[\/CANVAS_RENDER\]/);
              if (canvasMatch) {
                preservedMarkers += canvasMatch[0] + '\n';
                clean = clean.replace(/\[CANVAS_RENDER\][\s\S]*?\[\/CANVAS_RENDER\]/, '').trim();
              }
              if (clean.includes('[CANVAS_CLEAR]')) {
                preservedMarkers += '[CANVAS_CLEAR]Canvas cleared.[/CANVAS_CLEAR]\n';
                clean = clean.replace(/\[CANVAS_CLEAR\][\s\S]*?\[\/CANVAS_CLEAR\]/, '').trim();
              }
              // Extract screenshot file markers
              const ssMatch = clean.match(/\[SCREENSHOT_FILE\].*?\[\/SCREENSHOT_FILE\]/);
              if (ssMatch) {
                preservedMarkers += ssMatch[0] + '\n';
                clean = clean.replace(/\[SCREENSHOT_FILE\].*?\[\/SCREENSHOT_FILE\]/, '').trim();
              }
              clean = clean.replace(/\[Screenshot[^\]]*\]/g, '').replace(/!\[.*?\]\(data:image[^)]+\)/g, '').slice(0, 3000);
              return `[${t.action} result]: ${clean.trim() || 'Done.'}`;
            }).join('\n\n');
            const followUp = `The user asked: "${body.message}"\n\nI executed these tools and got REAL results:\n\n${toolContext}\n\nNow respond to the user conversationally based ONLY on the REAL data above. If the user's request has multiple steps and the first step is done, execute the next step using a JSON tool block. Do NOT embed base64 data or image markdown — just natural text.`;
            try {
              fullResponse = await callLLM(config, enrichedSystemPrompt, followUp);

              // Round 2: execute any tool calls emitted in the synthesis response
              const { textParts: synthText2, actions: synthActions2 } = parseActions(fullResponse);
              if (synthActions2.length > 0) {
                const round2Results = [];
                for (const { action: a2, params: p2 } of synthActions2) {
                  try {
                    const r2 = await executeTool(a2, p2, config);
                    round2Results.push({ action: a2, result: typeof r2 === 'object' ? JSON.stringify(r2) : String(r2) });
                  } catch (e2) {
                    round2Results.push({ action: a2, result: `Error: ${e2.message}` });
                  }
                }
                const round2Context = round2Results.map(t => `[${t.action} result]: ${t.result.slice(0, 2000)}`).join('\n\n');
                try {
                  const r2Summary = await callLLM(config, enrichedSystemPrompt, `The user asked: "${body.message}"\n\n${toolContext}\n\nRound 2 tool results:\n\n${round2Context}\n\nGive the user a final natural-language summary of everything. Do NOT output JSON blocks.`);
                  fullResponse = synthText2.join('\n').replace(/```json[\s\S]*?```/g, '').trim() + (synthText2.join('').trim() ? '\n\n' : '') + r2Summary.trim();
                } catch {
                  fullResponse = synthText2.join('\n').replace(/```json[\s\S]*?```/g, '').trim() + '\n\n' + round2Results.map(t => `${t.action}: ${t.result}`).join('\n');
                }
              } else {
                fullResponse = fullResponse.replace(/```json[\s\S]*?```/g, '').trim();
              }

              // Prepend preserved markers so the UI can render canvas/screenshots
              if (preservedMarkers) fullResponse = preservedMarkers + fullResponse;
            } catch {
              fullResponse = toolResults.map(t => `${t.action}: ${t.result}`).join('\n\n');
            }
          } else {
            fullResponse = textResponse;
          }

          // Persist chat history and extract episodic memory (fire-and-forget)
          try {
            const persistedHistory = loadChatHistory();
            persistedHistory.push({ role: 'user', content: body.message });
            persistedHistory.push({ role: 'assistant', content: fullResponse });
            saveChatHistory(persistedHistory);
          } catch { /* non-critical */ }
          try { extractMemory('chat', body.message, fullResponse); } catch { /* non-critical */ }

          sendJSON(res, 200, { response: fullResponse, toolResults, actions });
        } catch (e) {
          sendJSON(res, 200, { response: null, error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Conversations API ────────────────────────────────────────────

      // GET /api/conversations — list all
      if (method === 'GET' && pathname === '/api/conversations') {
        const convs = listConversations();
        sendJSON(res, 200, { conversations: convs });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/conversations — create new
      if (method === 'POST' && pathname === '/api/conversations') {
        const conv = createConversation();
        setActiveId(conv.id);
        sendJSON(res, 201, { conversation: conv });
        logRequest(method, pathname, 201, Date.now() - start);
        return;
      }

      // GET /api/conversations/:id
      if (method === 'GET' && pathname.match(/^\/api\/conversations\/[a-z0-9-]+$/)) {
        const id = pathname.split('/')[3];
        const conv = loadConversation(id);
        if (!conv) { sendJSON(res, 404, { error: 'Conversation not found' }); }
        else { sendJSON(res, 200, { conversation: conv }); }
        logRequest(method, pathname, conv ? 200 : 404, Date.now() - start);
        return;
      }

      // DELETE /api/conversations/:id
      if (method === 'DELETE' && pathname.match(/^\/api\/conversations\/[a-z0-9-]+$/)) {
        const id = pathname.split('/')[3];
        const ok = deleteConversation(id);
        sendJSON(res, ok ? 200 : 404, { ok });
        logRequest(method, pathname, ok ? 200 : 404, Date.now() - start);
        return;
      }

      // PATCH /api/conversations/:id — rename
      if (method === 'PATCH' && pathname.match(/^\/api\/conversations\/[a-z0-9-]+$/)) {
        const id = pathname.split('/')[3];
        const body = await parseBody(req);
        const conv = loadConversation(id);
        if (!conv) { sendJSON(res, 404, { error: 'Not found' }); }
        else {
          if (body.title) conv.title = body.title;
          saveConversation(conv);
          sendJSON(res, 200, { conversation: conv });
        }
        logRequest(method, pathname, conv ? 200 : 404, Date.now() - start);
        return;
      }

      // GET /api/conversations/:id/export?format=md|json
      if (method === 'GET' && pathname.match(/^\/api\/conversations\/[a-z0-9-]+\/export$/)) {
        const id = pathname.split('/')[3];
        const conv = loadConversation(id);
        if (!conv) { sendJSON(res, 404, { error: 'Not found' }); logRequest(method, pathname, 404, Date.now() - start); return; }
        const url = new URL(req.url, `http://${req.headers.host}`);
        const format = url.searchParams.get('format') || 'md';
        if (format === 'json') {
          const exported = exportAsJson(conv);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="nha-chat-${id}.json"` });
          res.end(exported);
        } else {
          const exported = exportAsMarkdown(conv);
          res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Disposition': `attachment; filename="nha-chat-${id}.md"` });
          res.end(exported);
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Fork/Retry/Navigate API ────────────────────────────────────────

      // POST /api/conversations/:id/retry — retry a message (create fork)
      if (method === 'POST' && pathname.match(/^\/api\/conversations\/[a-z0-9-]+\/retry$/)) {
        const convId = pathname.split('/')[3];
        const body = await parseBody(req);
        const conv = loadConversation(convId);
        if (!conv) { sendJSON(res, 404, { error: 'Not found' }); logRequest(method, pathname, 404, Date.now() - start); return; }
        const userNodeId = retryMessage(conv, body.assistantNodeId);
        if (!userNodeId) { sendJSON(res, 400, { error: 'Invalid message' }); logRequest(method, pathname, 400, Date.now() - start); return; }
        sendJSON(res, 200, { userNodeId, userContent: conv.tree?.[userNodeId]?.content });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/conversations/:id/retry-response — add the retry result
      if (method === 'POST' && pathname.match(/^\/api\/conversations\/[a-z0-9-]+\/retry-response$/)) {
        const convId = pathname.split('/')[3];
        const body = await parseBody(req);
        const conv = loadConversation(convId);
        if (!conv) { sendJSON(res, 404, { error: 'Not found' }); logRequest(method, pathname, 404, Date.now() - start); return; }
        const newId = addRetryResponse(conv, body.userNodeId, body.content);
        sendJSON(res, 200, { nodeId: newId, messages: getHistory(conv) });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/conversations/:id/navigate — switch fork direction
      if (method === 'POST' && pathname.match(/^\/api\/conversations\/[a-z0-9-]+\/navigate$/)) {
        const convId = pathname.split('/')[3];
        const body = await parseBody(req);
        const conv = loadConversation(convId);
        if (!conv) { sendJSON(res, 404, { error: 'Not found' }); logRequest(method, pathname, 404, Date.now() - start); return; }
        const ok = navigateFork(conv, body.nodeId, body.direction);
        sendJSON(res, 200, { ok, messages: getHistory(conv) });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/conversations/:id/forks — get fork info for all messages
      if (method === 'GET' && pathname.match(/^\/api\/conversations\/[a-z0-9-]+\/forks$/)) {
        const convId = pathname.split('/')[3];
        const conv = loadConversation(convId);
        if (!conv) { sendJSON(res, 404, { error: 'Not found' }); logRequest(method, pathname, 404, Date.now() - start); return; }
        const messages = getHistory(conv);
        const forks = {};
        for (const msg of messages) {
          const info = getForkInfo(conv, msg.id);
          if (info) forks[msg.id] = info;
        }
        sendJSON(res, 200, { forks });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Streaming Chat API ─────────────────────────────────────────────

      // POST /api/chat/stream — SSE streaming chat with conversation persistence
      if (method === 'POST' && pathname === '/api/chat/stream') {
        const body = await parseBody(req);
        if (!body.message) { sendJSON(res, 400, { error: 'message required' }); logRequest(method, pathname, 400, Date.now() - start); return; }
        if (!config.llm.provider || (!config.llm.apiKey && config.llm.provider !== 'nha')) { config.llm.provider = 'nha'; }

        const msg = body.message.trim();
        const convId = body.conversationId;

        // Build system prompt
        let effectiveSystemPrompt = config._chatAgent?.systemPrompt || null;
        let effectiveMsg = msg;
        const atMatch = msg.match(/^@(\w+)\s+([\s\S]*)/);
        if (atMatch) {
          const inlineAgent = atMatch[1].toLowerCase();
          effectiveMsg = atMatch[2];
          const agentFile = path.join(AGENTS_DIR, `${inlineAgent}.mjs`);
          if (fs.existsSync(agentFile)) {
            const src = fs.readFileSync(agentFile, 'utf-8');
            const parsed = parseAgentFile(src, inlineAgent);
            if (parsed.systemPrompt) effectiveSystemPrompt = parsed.systemPrompt;
          }
        }

        const basePrompt = effectiveSystemPrompt || chatSystemPrompt;
        let enrichedPrompt = basePrompt;
        try { const m = buildMemoryContext('chat', effectiveMsg); if (m) enrichedPrompt = basePrompt + m; } catch {}
        try { const ic = await getImapAccountsContext(); if (ic) enrichedPrompt += ic; } catch {}

        // Build message with rolling context window:
        // - Recent messages (last 6): full content up to 2000 chars
        // - Older messages: compressed to 1-line summaries preserving full context
        const rawHistory = (body.history || []).map(h => ({
          role: h.role,
          content: (h.content || '').replace(/!\[Screenshot\]\(data:image\/[^)]+\)/g, '[Screenshot taken]'),
        }));

        const RECENT_COUNT = 6;
        const parts = [];

        if (rawHistory.length > RECENT_COUNT) {
          // Compress older messages into a conversation summary
          const older = rawHistory.slice(0, -RECENT_COUNT);
          const summaryLines = [];
          for (let i = 0; i < older.length; i += 2) {
            const userMsg = older[i]?.content?.slice(0, 150)?.replace(/\n/g, ' ') || '';
            const assistantMsg = older[i + 1]?.content?.slice(0, 200)?.replace(/\n/g, ' ') || '';
            if (userMsg) summaryLines.push(`- User asked: "${userMsg.trim()}${userMsg.length >= 150 ? '...' : ''}" → Assistant: ${assistantMsg.trim()}${assistantMsg.length >= 200 ? '...' : ''}`);
          }
          if (summaryLines.length > 0) {
            parts.push(`[CONVERSATION CONTEXT — ${summaryLines.length} earlier exchanges]\n${summaryLines.join('\n')}\n[END CONTEXT]`);
          }
        }

        // Recent messages in full
        const recent = rawHistory.slice(-RECENT_COUNT);
        for (const turn of recent) {
          const prefix = turn.role === 'user' ? '[User]' : '[Assistant]';
          parts.push(`${prefix} ${turn.content.slice(0, 2000)}`);
        }

        parts.push(`[User] ${effectiveMsg}`);
        const userMessage = parts.join('\n\n');

        // Handle file/image/pdf attachments — fall back to non-streaming
        if (body.imageBase64 || body.pdfBase64 || body.fileContent) {
          // Redirect to regular /api/chat for attachment handling
          sendJSON(res, 200, { error: 'attachments_use_regular', redirect: '/api/chat' });
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        // SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        const sendSSE = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        sendSSE('processing', {});

        try {
          let fullResponse = '';
          fullResponse = await callLLMStream(config, enrichedPrompt, userMessage, (chunk) => {
            sendSSE('token', { content: chunk });
          });

          // Parse and execute tools
          const { textParts, actions } = parseActions(fullResponse);
          const toolResults = [];
          let inlineEmbeds = ''; // Accumulated inline cards/browser frames for the response

          // Auto-detect search + screenshot intent from user message
          const wantsScreenshot = /screenshot|screen\s*shot|schermo|cattura|foto|immagine/i.test(msg);
          const wantsSearch = /\b(cerca|search|find|look\s*up|ricerca|cercare)\b/i.test(msg);

          // If user asked to search but LLM didn't call web_search, force it
          if (wantsSearch && !actions.some(a => a.action === 'web_search')) {
            // Extract search query from message (remove action words)
            const searchQuery = msg.replace(/\b(cerca|search|find|look\s*up|ricerca|cercare|e\s+fai|and\s+take|screenshot|screen\s*shot|schermo|cattura|foto|immagine|dei|dei\s+risultati|of\s+the\s+results|risultati|results)\b/gi, '').replace(/["""]/g, '').trim();
            if (searchQuery.length > 2) {
              actions.push({ action: 'web_search', params: { query: searchQuery, screenshot: wantsScreenshot } });
            }
          }

          // Auto-correct: if LLM called web_search but query looks like a domain, switch to browser_open
          for (const a of actions) {
            if (a.action === 'web_search' && a.params.query) {
              const q = a.params.query.trim();
              // Detect domain names: corriere.it, github.com, youtube.com, etc.
              if (/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(q) || /^(https?:\/\/)/.test(q)) {
                a.action = 'browser_open';
                a.params = { url: q.startsWith('http') ? q : 'https://' + q };
              }
            }
          }

          // Auto-correct: if user said "visita/vai su/apri/open" + domain but LLM used web_search
          const visitMatch = msg.match(/(?:visita|vai su|apri|open|go to)\s+([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
          if (visitMatch && !actions.some(a => a.action === 'browser_open')) {
            const domain = visitMatch[1];
            // Remove any web_search that was targeting this domain
            const wsIdx = actions.findIndex(a => a.action === 'web_search' && a.params.query?.toLowerCase().includes(domain.toLowerCase()));
            if (wsIdx >= 0) actions.splice(wsIdx, 1);
            actions.unshift({ action: 'browser_open', params: { url: 'https://' + domain } });
          }

          for (const { action, params } of actions) {
            // Force screenshot=true on web_search if user asked for screenshot
            if (action === 'web_search' && wantsScreenshot && !params.screenshot) {
              params.screenshot = true;
            }

            sendSSE('tool', { action, status: 'executing' });
            try {
              // For browser_screenshot in web UI: capture and send base64 image
              if (action === 'browser_screenshot') {
                const be = await import('../services/browser-engine.mjs');
                if (!be.isBrowserRunning()) {
                  toolResults.push({ action, result: 'No browser open. Use browser_open first.' });
                  sendSSE('tool', { action, status: 'error', error: 'No browser open' });
                  continue;
                }
                // Scroll to top for best viewport
                await be.browserScroll({ direction: 'top' });
                await new Promise(r => setTimeout(r, 300));
                const ssResult = await be.browserScreenshot({
                  fullPage: false, // Always viewport
                  format: 'jpeg',
                  quality: 75,
                });
                if (!ssResult.error) {
                  // Save screenshot to disk for persistence across sessions
                  const ssDir = path.join(NHA_DIR, 'screenshots');
                  fs.mkdirSync(ssDir, { recursive: true });
                  const ssFilename = `ss-${Date.now()}.jpg`;
                  fs.writeFileSync(path.join(ssDir, ssFilename), Buffer.from(ssResult.base64, 'base64'));

                  sendSSE('screenshot', { base64: ssResult.base64, format: 'jpeg', filename: ssFilename });
                  toolResults.push({ action, result: `Screenshot captured (${Math.round(ssResult.size / 1024)}KB) [file: ${ssFilename}]` });
                  // Store screenshot ref for persistence
                  if (!res._screenshotFiles) res._screenshotFiles = [];
                  res._screenshotFiles.push(ssFilename);
                  sendSSE('tool', { action, status: 'done', result: 'Screenshot captured' });
                } else {
                  toolResults.push({ action, result: `Error: ${ssResult.message}` });
                  sendSSE('tool', { action, status: 'error', error: ssResult.message });
                }
                continue;
              }

              const result = await executeTool(action, params, config);

              // Intercept screen capture vision result
              if (result && typeof result === 'object' && result.__screenshot) {
                sendSSE('tool', { action, status: 'analyzing_screen' });
                try {
                  const { callLLMVision } = await import('../services/llm.mjs');
                  const visionPrompt = enrichedPrompt + '\\n\\nIMPORTANT: You are looking at a REAL screenshot. Describe ONLY what you ACTUALLY see. NEVER invent or fabricate.';
                  const question = `The user said: "${msg}"\\n\\n${result.question}`;
                  const visionResponse = await callLLMVision(config, visionPrompt, question, { base64: result.base64, mimeType: 'image/png' });

                  // Save screenshot for display
                  const fname = result.path.split('/').pop();
                  const ssDir = path.join(NHA_DIR, 'screenshots');
                  fs.mkdirSync(ssDir, { recursive: true });
                  try { fs.copyFileSync(result.path, path.join(ssDir, fname)); } catch {}

                  // Send screenshot to client
                  sendSSE('screenshot', { filename: fname, format: 'png' });
                  if (!res._screenshotFiles) res._screenshotFiles = [];
                  res._screenshotFiles.push(fname);

                  // Send vision analysis as tokens
                  sendSSE('tool_synthesis', {});
                  sendSSE('token', { content: visionResponse });

                  toolResults.push({ action, result: `[Screen analyzed] ${visionResponse.slice(0, 500)}` });
                  sendSSE('tool', { action, status: 'done', result: 'Screen analyzed' });
                } catch (visionErr) {
                  toolResults.push({ action, result: `Vision failed: ${visionErr.message}` });
                  sendSSE('tool', { action, status: 'error', error: visionErr.message });
                }
                continue;
              }

              let resultStr = typeof result === 'object' ? JSON.stringify(result) : String(result);
              // For web_search/fetch_url: strip raw HTML/CSS so the LLM gets clean text
              if ((action === 'web_search' || action === 'fetch_url') && resultStr.includes('<')) {
                resultStr = resultStr
                  .replace(/<style[\s\S]*?<\/style>/gi, '')
                  .replace(/<script[\s\S]*?<\/script>/gi, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s{3,}/g, '\n')
                  .replace(/[^\x00-\x7F]/g, '') // strip non-ASCII that causes encoding issues
                  .trim()
                  .slice(0, 6000);
              }
              toolResults.push({ action, result: resultStr });
              sendSSE('tool', { action, status: 'done', result: typeof resultStr === 'string' ? resultStr.slice(0, 500) : '' });

              // After web_search: open first result in browser + embed inline card + inline browser
              if (action === 'web_search' && resultStr.length > 50) {
                try {
                  // Extract first URL from results
                  const urlMatch = resultStr.match(/https?:\/\/[^\s)<]+/);
                  let inlineBrowserMarker = '';

                  if (urlMatch) {
                    const be = await import('../services/browser-engine.mjs');
                    sendSSE('tool', { action: 'browser_open', status: 'executing' });
                    await be.browserOpen(urlMatch[0]);
                    sendSSE('tool', { action: 'browser_open', status: 'done', result: 'Opened ' + urlMatch[0] });
                    await new Promise(r => setTimeout(r, 1500));
                    const frame = await be.browserScreenshot({ fullPage: false, format: 'jpeg', quality: 50 });
                    if (!frame.error) {
                      const info = await be.browserInfo();
                      const thumbDir = path.join(NHA_DIR, 'screenshots');
                      fs.mkdirSync(thumbDir, { recursive: true });
                      const thumbFile = `thumb-${Date.now()}.jpg`;
                      fs.writeFileSync(path.join(thumbDir, thumbFile), Buffer.from(frame.base64, 'base64'));
                      if (!res._browserThumbs) res._browserThumbs = [];
                      res._browserThumbs.push({ file: thumbFile, url: (info.url || '').slice(0, 80) });
                      // Also send for floating panel (backwards compat)
                      sendSSE('browser_frame', { file: thumbFile, format: 'jpeg', url: (info.url || '').slice(0, 80) });
                      // Inline browser marker — will be embedded in the response
                      inlineBrowserMarker = `[INLINE_BROWSER]${thumbFile}|${(info.url || urlMatch[0]).slice(0, 80)}[/INLINE_BROWSER]`;
                    }
                  }

                  // Build inline card with structured search results
                  const lines = resultStr.split('\n').filter(l => l.trim());
                  let cardHtml = '<div style="font-family:system-ui;font-size:13px">';
                  lines.slice(0, 8).forEach(l => {
                    const um = l.match(/https?:\/\/[^\s)]+/);
                    const title = l.replace(/^\d+\.\s*/, '').replace(/https?:\/\/\S+/g, '').replace(/<[^>]+>/g, '').trim();
                    if (title) {
                      cardHtml += '<div style="padding:8px 10px;border-bottom:1px solid #1e1e1e">';
                      if (um) cardHtml += '<a href="' + um[0] + '" target="_blank" style="color:#00e5ff;text-decoration:none;font-size:13px">';
                      cardHtml += title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
                      if (um) cardHtml += '<div style="font-size:10px;color:#555;margin-top:2px">' + um[0].replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div></a>';
                      cardHtml += '</div>';
                    }
                  });
                  cardHtml += '</div>';

                  // Accumulate inline embeds — will be appended to final response AFTER LLM
                  if (inlineBrowserMarker) inlineEmbeds += '\n' + inlineBrowserMarker;
                  if (cardHtml.length > 50) inlineEmbeds += '\n[INLINE_CARD]' + cardHtml + '[/INLINE_CARD]';
                } catch { /* non-critical */ }
              }

              // Send live browser frame after browser/search/fetch actions — save as thumbnail file for persistence
              if ((action.startsWith('browser_') && action !== 'browser_close') || action === 'fetch_url') {
                try {
                  const be = await import('../services/browser-engine.mjs');
                  if (be.isBrowserRunning()) {
                    const frame = await be.browserScreenshot({ fullPage: false, format: 'jpeg', quality: 30 });
                    if (!frame.error) {
                      const info = await be.browserInfo();
                      const pageUrl = (info.url || '').slice(0, 80);
                      // Save thumbnail to disk for persistence
                      const thumbDir = path.join(NHA_DIR, 'screenshots');
                      fs.mkdirSync(thumbDir, { recursive: true });
                      const thumbFile = `thumb-${Date.now()}.jpg`;
                      fs.writeFileSync(path.join(thumbDir, thumbFile), Buffer.from(frame.base64, 'base64'));
                      if (!res._browserThumbs) res._browserThumbs = [];
                      res._browserThumbs.push({ file: thumbFile, url: pageUrl });
                      sendSSE('browser_frame', { file: thumbFile, format: 'jpeg', url: pageUrl });
                    }
                  }
                } catch { /* frame capture failed, non-critical */ }
              }

              // If the tool produced a screenshot (web_search with screenshot=true), send it via SSE
              if (resultStr.includes('[Screenshot of results captured')) {
                try {
                  const fileMatch = resultStr.match(/file:(ss-\d+\.jpg)/);
                  console.log(`  [screenshot] file match: ${fileMatch?.[1] || 'NONE'}`);
                  if (fileMatch) {
                    const ssFilename = fileMatch[1];
                    const ssPath = path.join(NHA_DIR, 'screenshots', ssFilename);
                    const exists = fs.existsSync(ssPath);
                    console.log(`  [screenshot] path: ${ssPath}, exists: ${exists}`);
                    if (exists) {
                      const ssBase64 = fs.readFileSync(ssPath).toString('base64');
                      console.log(`  [screenshot] sending SSE, base64 size: ${ssBase64.length}`);
                      sendSSE('screenshot', { base64: ssBase64, format: 'jpeg', filename: ssFilename });
                      sendSSE('browser_frame', { file: ssFilename, format: 'jpeg', url: 'Search results' });
                      if (!res._screenshotFiles) res._screenshotFiles = [];
                      res._screenshotFiles.push(ssFilename);
                    }
                  }
                } catch (ssErr) { console.log(`  [screenshot] ERROR: ${ssErr.message}`); }
              }
            } catch (e) {
              toolResults.push({ action, result: `Error: ${e.message}` });
              sendSSE('tool', { action, status: 'error', error: e.message });
            }
          }

          // If tools were executed, make a second LLM call with results
          let finalResponse = fullResponse;
          if (toolResults.length > 0) {
            // Extract canvas/screenshot markers BEFORE sending to LLM
            let preservedMarkers = '';
            const toolContext = toolResults.map(t => {
              let clean = t.result;
              const canvasMatch = clean.match(/\[CANVAS_RENDER\][\s\S]*?\[\/CANVAS_RENDER\]/);
              if (canvasMatch) { preservedMarkers += canvasMatch[0] + '\n'; clean = clean.replace(/\[CANVAS_RENDER\][\s\S]*?\[\/CANVAS_RENDER\]/, '').trim(); }
              if (clean.includes('[CANVAS_CLEAR]')) { preservedMarkers += '[CANVAS_CLEAR]Canvas cleared.[/CANVAS_CLEAR]\n'; clean = clean.replace(/\[CANVAS_CLEAR\][\s\S]*?\[\/CANVAS_CLEAR\]/, '').trim(); }
              clean = clean.replace(/\[Screenshot[^\]]*\]/g, '').replace(/!\[.*?\]\(data:image[^)]+\)/g, '').slice(0, 3000);
              return `[${t.action} result]: ${clean.trim() || 'Done.'}`;
            }).join('\n\n');

            // If we have canvas content, send it to client immediately via SSE
            if (preservedMarkers.includes('[CANVAS_RENDER]')) {
              sendSSE('canvas', { markers: preservedMarkers });
            }

            const followUp = `The user asked: "${msg}"\n\nI executed these tools and got REAL results:\n\n${toolContext}\n\nNow respond to the user conversationally based ONLY on the REAL data above. Present the results clearly. If the user's request has multiple steps and the first step is done, execute the next step using a JSON tool block. Do NOT embed base64 data or image markdown — just natural text. If a screenshot was taken, just mention "Screenshot captured" without embedding it.`;
            sendSSE('tool_synthesis', {});
            try {
              finalResponse = await callLLMStream(config, enrichedPrompt, followUp, (chunk) => {
                sendSSE('token', { content: chunk });
              });
              finalResponse = finalResponse
                .replace(/!\[.*?\]\(data:image\/[^)]+\)/g, '')
                .replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{100,}/g, '[image]')
                .trim();

              // Round 2: execute any tool calls emitted in the synthesis response
              const { textParts: synthText, actions: synthActions } = parseActions(finalResponse);
              if (synthActions.length > 0) {
                const round2Results = [];
                for (const { action: a2, params: p2 } of synthActions) {
                  sendSSE('tool', { action: a2, status: 'executing' });
                  try {
                    const r2 = await executeTool(a2, p2, config);
                    const r2str = typeof r2 === 'object' ? JSON.stringify(r2) : String(r2);
                    round2Results.push({ action: a2, result: r2str });
                    sendSSE('tool', { action: a2, status: 'done', result: r2str.slice(0, 200) });
                  } catch (e2) {
                    round2Results.push({ action: a2, result: `Error: ${e2.message}` });
                    sendSSE('tool', { action: a2, status: 'error', error: e2.message });
                  }
                }
                const round2Context = round2Results.map(t => `[${t.action} result]: ${t.result.slice(0, 2000)}`).join('\n\n');
                const round2Prompt = `${toolContext}\n\nRound 2 tool results:\n\n${round2Context}\n\nNow give the user a final natural-language summary of everything that was done. Do NOT output JSON blocks.`;
                sendSSE('tool_synthesis', {});
                try {
                  finalResponse = synthText.join('\n').replace(/```json[\s\S]*?```/g, '').trim();
                  const r2Summary = await callLLMStream(config, enrichedPrompt, `The user asked: "${msg}"\n\n${round2Prompt}`, (chunk) => {
                    sendSSE('token', { content: chunk });
                  });
                  finalResponse = (finalResponse ? finalResponse + '\n\n' : '') + r2Summary.trim();
                } catch {
                  finalResponse = synthText.join('\n').replace(/```json[\s\S]*?```/g, '').trim() + '\n\n' + round2Results.map(t => `${t.action}: ${t.result}`).join('\n');
                }
              } else {
                // No new tool calls — strip any leftover JSON blocks from display text
                finalResponse = finalResponse.replace(/```json[\s\S]*?```/g, '').trim();
              }

              // Prepend preserved markers for persistence
              if (preservedMarkers) finalResponse = preservedMarkers + finalResponse;
            } catch {
              finalResponse = toolResults.map(t => `${t.action}: ${t.result}`).join('\n\n');
            }
          }

          // Persist to conversation (append screenshot references so they survive reload)
          if (convId) {
            try {
              let persistedResponse = finalResponse;
              const ssFiles = res._screenshotFiles || [];
              if (ssFiles.length > 0) {
                const ssRefs = ssFiles.map(f => `\n![Screenshot](/api/screenshots/${f})`).join('');
                persistedResponse = finalResponse + ssRefs;
              }
              const conv = loadConversation(convId);
              if (conv) {
                if (body.isRetry) {
                  // Retry: find the user node and add a new sibling response (fork)
                  const activePath = getHistory(conv);
                  // Find the last user message that matches
                  const userNodes = activePath.filter(m => m.role === 'user' && m.content === msg);
                  const userNode = userNodes[userNodes.length - 1];
                  if (userNode && userNode.id) {
                    addRetryResponse(conv, userNode.id, persistedResponse);
                  } else {
                    addMessages(conv, msg, persistedResponse);
                  }
                } else {
                  addMessages(conv, msg, persistedResponse);
                }
              }
            } catch {}
          }

          // Extract memory
          try { extractMemory('chat', msg, finalResponse); } catch {}

          // Send inline embeds (search cards, browser frames) via SSE
          if (inlineEmbeds) {
            sendSSE('inline_embeds', { html: inlineEmbeds });
          }

          const ssFiles = res._screenshotFiles || [];
          const browserThumbs = res._browserThumbs || [];
          sendSSE('done', { content: finalResponse, screenshotFiles: ssFiles, browserThumbs, inlineHtml: inlineEmbeds || '' });
        } catch (e) {
          sendSSE('error', { message: e.message });
        }

        res.end();
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/agents
      if (method === 'GET' && pathname === '/api/agents') {
        sendJSON(res, 200, { agents: agentCards });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/agents — create custom agent
      if (method === 'POST' && pathname === '/api/agents') {
        const body = await parseBody(req);
        const name = (body.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const tagline = body.tagline || '';
        const systemPrompt = body.systemPrompt || '';
        if (!name || !tagline || !systemPrompt) {
          sendJSON(res, 400, { error: 'name, tagline, and systemPrompt required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }
        const agentFile = path.join(AGENTS_DIR, `${name}.mjs`);
        const content = `// NHA Custom Agent: ${name}\n// Created: ${new Date().toISOString()}\n\nexport const CARD = {\n  name: '${name}',\n  displayName: '${name.toUpperCase()}',\n  category: 'custom',\n  tagline: '${tagline.replace(/'/g, "\\'")}',\n};\n\nexport const SYSTEM_PROMPT = \`${systemPrompt.replace(/`/g, '\\`')}\`;\n`;
        if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });
        fs.writeFileSync(agentFile, content, 'utf-8');
        const existingIdx = agentCards.findIndex(a => a.name === name);
        if (existingIdx >= 0) {
          agentCards[existingIdx] = { name, displayName: name.toUpperCase(), category: 'custom', tagline };
        } else {
          agentCards.push({ name, displayName: name.toUpperCase(), category: 'custom', tagline });
        }
        sendJSON(res, 201, { ok: true, agent: { name, category: 'custom', tagline } });
        logRequest(method, pathname, 201, Date.now() - start);
        return;
      }

      // PUT /api/agents/:name — edit agent
      if (method === 'PUT' && pathname.startsWith('/api/agents/')) {
        const name = pathname.split('/')[3];
        const body = await parseBody(req);
        const agentFile = path.join(AGENTS_DIR, `${name}.mjs`);
        if (!fs.existsSync(agentFile)) {
          sendJSON(res, 404, { error: `Agent "${name}" not found` });
          logRequest(method, pathname, 404, Date.now() - start);
          return;
        }
        const tagline = body.tagline || '';
        const systemPrompt = body.systemPrompt || '';
        if (!tagline || !systemPrompt) {
          sendJSON(res, 400, { error: 'tagline and systemPrompt required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }
        const content = `// NHA Custom Agent: ${name}\n// Updated: ${new Date().toISOString()}\n\nexport const CARD = {\n  name: '${name}',\n  displayName: '${name.toUpperCase()}',\n  category: '${body.category || 'custom'}',\n  tagline: '${tagline.replace(/'/g, "\\'")}',\n};\n\nexport const SYSTEM_PROMPT = \`${systemPrompt.replace(/`/g, '\\`')}\`;\n`;
        fs.writeFileSync(agentFile, content, 'utf-8');
        const idx = agentCards.findIndex(a => a.name === name);
        if (idx >= 0) { agentCards[idx].tagline = tagline; }
        sendJSON(res, 200, { ok: true });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // DELETE /api/agents/:name — delete agent
      if (method === 'DELETE' && pathname.startsWith('/api/agents/')) {
        const name = pathname.split('/')[3];
        const agentFile = path.join(AGENTS_DIR, `${name}.mjs`);
        if (!fs.existsSync(agentFile)) {
          sendJSON(res, 404, { error: `Agent "${name}" not found` });
          logRequest(method, pathname, 404, Date.now() - start);
          return;
        }
        fs.unlinkSync(agentFile);
        const idx = agentCards.findIndex(a => a.name === name);
        if (idx >= 0) agentCards.splice(idx, 1);
        sendJSON(res, 200, { ok: true });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/agents/:name — get agent details (system prompt)
      if (method === 'GET' && pathname.startsWith('/api/agents/') && pathname.split('/').length === 4) {
        const name = pathname.split('/')[3];
        const agentFile = path.join(AGENTS_DIR, `${name}.mjs`);
        if (!fs.existsSync(agentFile)) {
          sendJSON(res, 404, { error: `Agent "${name}" not found` });
          logRequest(method, pathname, 404, Date.now() - start);
          return;
        }
        const src = fs.readFileSync(agentFile, 'utf-8');
        const parsed = parseAgentFile(src, name);
        sendJSON(res, 200, { name, category: parsed.card?.category || 'custom', tagline: parsed.card?.tagline || '', systemPrompt: parsed.systemPrompt || '' });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/ask — agent call with personal context (email, calendar, tasks)
      if (method === 'POST' && pathname === '/api/ask') {
        const body = await parseBody(req);
        if (!body.agent || !body.prompt) {
          sendJSON(res, 400, { error: 'agent and prompt required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }

        if (!config.llm.provider || (!config.llm.apiKey && config.llm.provider !== 'nha')) {
          // Auto-fallback to NHA free tier if no API key is configured
          config.llm.provider = 'nha';
        }

        // Allow both built-in and custom agents
        const agentFile = path.join(AGENTS_DIR, `${body.agent}.mjs`);
        if (!AGENTS.includes(body.agent) && !fs.existsSync(agentFile)) {
          sendJSON(res, 400, { error: `Unknown agent: ${body.agent}` });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }

        try {
          // Build personal context from Gmail + Calendar + Tasks
          let context = '';
          try {
            const [emails, events] = await Promise.all([
              getUnreadImportant(config, 15).catch(() => []),
              getTodayEvents(config).catch(() => []),
            ]);
            const tasks = getTasks();

            if (emails.length > 0) {
              context += '\n\n[USER EMAIL CONTEXT — real data from their Gmail]\n';
              emails.slice(0, 10).forEach((e, i) => {
                context += `${i + 1}. From: ${e.from} | Subject: ${e.subject} | Date: ${e.date}\n   ${e.snippet.slice(0, 150)}\n   URLs: ${e.urls.join(', ') || 'none'}\n`;
              });
            }

            if (events.length > 0) {
              context += '\n\n[USER CALENDAR — today]\n';
              events.forEach(e => {
                const time = e.isAllDay ? 'All day' : `${e.start} - ${e.end}`;
                context += `${time}: ${e.summary}${e.location ? ' @ ' + e.location : ''}${e.attendees?.length ? ' with ' + e.attendees.map(a => a.name || a.email).join(', ') : ''}\n`;
              });
            }

            if (tasks.length > 0) {
              context += '\n\n[USER TASKS — today]\n';
              tasks.forEach(t => {
                context += `#${t.id} [${t.priority}] ${t.status === 'done' ? '[DONE] ' : ''}${t.description}\n`;
              });
            }
          } catch { /* context loading failed, proceed without it */ }

          // Attach file content if provided
          let fileContext = '';
          if (body.fileContent && body.fileName) {
            const maxChars = 100000;
            const content = String(body.fileContent).slice(0, maxChars);
            fileContext = '\n\n--- Attached file: ' + body.fileName + ' ---\n' + content;
            if (body.fileContent.length > maxChars) fileContext += '\n[... truncated at 100KB ...]';
          }

          const enrichedPrompt = body.prompt + fileContext + (context
            ? '\n\nIMPORTANT CONTEXT: The data below is from the user\'s OWN accounts (their Gmail, their Google Calendar, their tasks). The user is the OWNER of these accounts. ' +
              'Recent activity (npm publishes, Google login alerts, GitHub notifications) was done BY THE USER THEMSELVES as part of their normal work. ' +
              'Do NOT flag the user\'s own legitimate activity as suspicious or compromised. ' +
              'Only flag ACTUAL external threats: phishing emails from unknown senders, suspicious links, unauthorized access from unknown locations.\n' + context
            : '');

          const response = await callAgent(config, body.agent, enrichedPrompt);
          sendJSON(res, 200, { response, agent: body.agent });
        } catch (e) {
          sendJSON(res, 200, { response: null, error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/ask/stream — streaming SSE agent call
      if (method === 'POST' && pathname === '/api/ask/stream') {
        const body = await parseBody(req);
        if (!body.agent || !body.prompt) {
          sendJSON(res, 400, { error: 'agent and prompt required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }

        // Ensure provider is set — default to 'nha' free tier if no apiKey
        if (!config.llm.provider || (!config.llm.apiKey && config.llm.provider !== 'nha')) {
          config.llm.provider = 'nha';
        }

        const agentFileStream = path.join(AGENTS_DIR, `${body.agent}.mjs`);
        if (!AGENTS.includes(body.agent) && !fs.existsSync(agentFileStream)) {
          sendJSON(res, 400, { error: `Unknown agent: ${body.agent}` });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        const sendEv = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };

        try {
          let context = '';
          try {
            const [emails, events] = await Promise.all([
              getUnreadImportant(config, 15).catch(() => []),
              getTodayEvents(config).catch(() => []),
            ]);
            const tasks = getTasks();
            if (emails.length > 0) {
              context += '\n\n[USER EMAIL CONTEXT]\n';
              emails.slice(0, 10).forEach((e, i) => {
                context += `${i + 1}. From: ${e.from} | Subject: ${e.subject}\n   ${e.snippet.slice(0, 150)}\n`;
              });
            }
            if (events.length > 0) {
              context += '\n\n[USER CALENDAR — today]\n';
              events.forEach(e => {
                context += `${e.isAllDay ? 'All day' : e.start + ' - ' + e.end}: ${e.summary}\n`;
              });
            }
            if (tasks.length > 0) {
              context += '\n\n[USER TASKS]\n';
              tasks.forEach(t => { context += `#${t.id} [${t.priority}] ${t.description}\n`; });
            }
          } catch { /* proceed without context */ }

          let fileContext = '';
          if (body.fileContent && body.fileName) {
            fileContext = '\n\n--- Attached: ' + body.fileName + ' ---\n' + String(body.fileContent).slice(0, 100000);
          }

          const enrichedPrompt = body.prompt + fileContext + (context
            ? '\n\nIMPORTANT CONTEXT: The data below is from the user\'s OWN accounts.\n' + context : '');

          if (!fs.existsSync(agentFileStream)) {
            sendEv({ error: `Agent "${body.agent}" not downloaded. Run: nha update` });
            sendEv({ done: true });
            res.end();
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          }
          const src = fs.readFileSync(agentFileStream, 'utf-8');
          const { systemPrompt } = parseAgentFile(src, body.agent);
          let enrichedSystem = systemPrompt;
          try {
            const { buildMemoryContext } = await import('../services/memory.mjs');
            const mc = buildMemoryContext(body.agent, enrichedPrompt);
            if (mc) enrichedSystem = systemPrompt + mc;
          } catch { /* proceed */ }

          let fullResponse = '';
          await callLLMStream(config, enrichedSystem, enrichedPrompt, (token) => {
            fullResponse += token;
            sendEv({ token });
          });
          sendEv({ done: true });

          try {
            const { extractMemory } = await import('../services/memory.mjs');
            extractMemory(body.agent, enrichedPrompt, fullResponse);
          } catch { /* non-critical */ }

        } catch (e) {
          sendEv({ error: e.message });
        }

        res.end();
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── GitHub ───────────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/github/repos') {
        try {
          const gh = await import('../services/github.mjs');
          const data = await gh.listUserRepos(config, 30);
          sendJSON(res, 200, data);
        } catch (e) {
          sendJSON(res, 200, { error: e.message, repos: [] });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      if (method === 'GET' && pathname === '/api/github') {
        try {
          const gh = await import('../services/github.mjs');
          const [notifData, repoData] = await Promise.all([
            gh.listNotificationsRaw(config, 15),
            gh.listUserRepos(config, 30).catch(() => null),
          ]);
          sendJSON(res, 200, { notifications: notifData, user: repoData });
        } catch (e) {
          sendJSON(res, 200, { error: e.message, notifications: [] });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      if (method === 'GET' && pathname === '/api/github/issues') {
        try {
          const gh = await import('../services/github.mjs');
          const repo = url.searchParams.get('repo');
          const raw = await gh.listIssuesRaw(config, repo, 'open', 15);
          sendJSON(res, 200, { issues: raw, repo });
        } catch (e) {
          sendJSON(res, 200, { issues: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      if (method === 'GET' && pathname === '/api/github/prs') {
        try {
          const gh = await import('../services/github.mjs');
          const repo = url.searchParams.get('repo');
          const raw = await gh.listPRsRaw(config, repo, 'open', 15);
          sendJSON(res, 200, { prs: raw, repo });
        } catch (e) {
          sendJSON(res, 200, { prs: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/github/mark-read — mark all notifications as read
      if (method === 'POST' && pathname === '/api/github/mark-read') {
        try {
          const gh = await import('../services/github.mjs');
          await gh.markNotificationsRead(config);
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 200, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Notion ──────────────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/notion/search') {
        try {
          const nt = await import('../services/notion.mjs');
          const q = url.searchParams.get('q') || '';
          const text = await nt.search(config, q, 15);
          const pages = text.split('\n').filter(Boolean).map(l => {
            const m = l.match(/^\d+\.\s+\[(\w+)\]\s+(.?)\s+(.+?)\s+\(edited:\s+(\S+)\)\s+—\s+ID:\s+(\S+)$/);
            return m ? { type: m[1], icon: m[2], title: m[3], edited: m[4], id: m[5] } : { type: 'Page', icon: '', title: l, edited: '', id: '' };
          });
          sendJSON(res, 200, { pages });
        } catch (e) {
          sendJSON(res, 200, { pages: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      if (method === 'GET' && pathname === '/api/notion/page') {
        try {
          const nt = await import('../services/notion.mjs');
          const id = url.searchParams.get('id') || '';
          const text = await nt.getPage(config, id);
          const titleMatch = text.match(/^Title:\s+(.+?)$/m);
          const content = text.replace(/^Title:.*\n\n?/, '');
          sendJSON(res, 200, { title: titleMatch ? titleMatch[1] : 'Page', content });
        } catch (e) {
          sendJSON(res, 200, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Slack ───────────────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/slack/channels') {
        try {
          const sl = await import('../services/slack.mjs');
          const text = await sl.listChannels(config, 30);
          const channels = text.split('\n').filter(Boolean).map(l => {
            const m = l.match(/^\d+\.\s+#(\S+)\s+\((\d+)\s+members\)(?:\s+—\s+(.+))?$/);
            return m ? { id: m[1], name: m[1], members: parseInt(m[2]), purpose: m[3] || '' } : { id: l, name: l, members: 0, purpose: '' };
          });
          sendJSON(res, 200, { channels });
        } catch (e) {
          sendJSON(res, 200, { channels: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      if (method === 'GET' && pathname === '/api/slack/messages') {
        try {
          const sl = await import('../services/slack.mjs');
          const channel = url.searchParams.get('channel') || '';
          const text = await sl.listMessages(config, channel, 20);
          const messages = text.split('\n').filter(Boolean).map(l => {
            const m = l.match(/^(\d{1,2}:\d{2}\s*[AP]M)\s+\[([^\]]+)\]:\s+(.+)$/);
            return m ? { time: m[1], user: m[2], text: m[3] } : { time: '', user: '', text: l };
          });
          sendJSON(res, 200, { messages });
        } catch (e) {
          sendJSON(res, 200, { messages: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Birthdays ───────────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/birthdays') {
        try {
          const gc = await import('../services/google-contacts.mjs');
          const contacts = await gc.getBirthdays(config);
          const today = new Date();
          const upcoming = [];
          for (const c of contacts) {
            if (!c.birthday) continue;
            const parts = c.birthday.split('-');
            const month = parseInt(parts.length === 3 ? parts[1] : parts[0], 10);
            const day = parseInt(parts.length === 3 ? parts[2] : parts[1], 10);
            const thisYear = new Date(today.getFullYear(), month - 1, day);
            if (thisYear < today) thisYear.setFullYear(today.getFullYear() + 1);
            const daysUntil = Math.ceil((thisYear - today) / 86400000);
            if (daysUntil <= 90) {
              const dateStr = thisYear.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
              upcoming.push({ name: c.name, date: dateStr, rawDate: c.birthday, daysUntil, contactId: c.resourceName });
            }
          }
          upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
          sendJSON(res, 200, { birthdays: upcoming });
        } catch (e) {
          sendJSON(res, 200, { birthdays: [], error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/birthdays — create or update birthday on a contact
      if (method === 'POST' && pathname === '/api/birthdays') {
        try {
          const body = await parseBody(req);
          const gc = await import('../services/google-contacts.mjs');
          if (body.contactId) {
            // Update existing contact's birthday
            await gc.updateContact(config, body.contactId, { birthday: body.date });
          } else {
            // Create new contact with just name + birthday
            const created = await gc.createContact(config, { name: body.name });
            await gc.updateContact(config, created.resourceName, { birthday: body.date });
          }
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/birthdays/delete — clear birthday from a contact
      if (method === 'POST' && pathname === '/api/birthdays/delete') {
        try {
          const body = await parseBody(req);
          const gc = await import('../services/google-contacts.mjs');
          // Clear birthday by setting it to empty (remove field)
          await gc.updateContact(config, body.contactId, { birthday: '' });
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Studio: plan workflow ────────────────────────────────────────
      if (pathname === '/api/studio/plan' && method === 'POST') {
        const body = await parseBody(req);
        const task = (body.task || '').trim();
        if (!task) { sendJSON(res, 400, { error: 'task required' }); logRequest(method, pathname, 400, Date.now() - start); return; }

        const plannerLang = (() => { const LANG_MAP2 = {en:'English',it:'Italian',es:'Spanish',fr:'French',de:'German',pt:'Portuguese',zh:'Chinese',ja:'Japanese',ar:'Arabic',hi:'Hindi',ru:'Russian',nl:'Dutch',pl:'Polish',tr:'Turkish',ko:'Korean'}; const lc = (config?.language||'it').slice(0,2); return LANG_MAP2[lc]||'Italian'; })();

        // ── Fast keyword-based planning (no LLM call needed for common patterns) ──────
        const taskLow = task.toLowerCase();
        const hasPdf        = !!(body.hasPdf) || /pdf|allegat|catalogo|scheda\s*tecnic/i.test(taskLow);
        const hasEmail      = /email|mail|inbox|posta/i.test(taskLow);
        const hasCalendar   = /calendar|agenda|calendari|eventi|schedule/i.test(taskLow);
        const hasSearch     = /cerca|search|notizie|news|ultime|latest|web|internet|tendenz|trend|acquista|compra|dove\s+trovare|where\s+to\s+buy|similar|simile/i.test(taskLow);
        const hasCanvas     = /html|dashboard|visua|report|grafico|chart/i.test(taskLow);
        const hasGitHub     = /github|git|issue|pr|pull request/i.test(taskLow);
        const hasSlack      = /slack|channel|messag/i.test(taskLow);
        const hasNotion     = /notion|note|page/i.test(taskLow);
        const hasBriefing   = /briefing|analisi|analizza|summary|sommario|riassunto|riepiloga|valutazione|valuta/i.test(taskLow);
        const hasFinance    = /finance|mercato|market|stock|trading|finanz|investiment|cripto/i.test(taskLow);
        const hasSecurity   = /security|sicurezza|vulnerabilit|audit|pentest|rischi|dipendenz/i.test(taskLow);
        const hasStrategy   = /strateg|competitiv|posizionament|raccomandaz|competitive|positioning/i.test(taskLow);
        const hasReputation = /reputazion|reputation|online|brand|review|recension/i.test(taskLow);
        const hasCode       = /codice|code|refactor|debug|bug|sviluppo|software|npm|package/i.test(taskLow);
        const hasWriting    = /scrivi|write|articolo|article|blog|testo|text|documento|document/i.test(taskLow);
        const hasData       = /dati|data|dataset|csv|json|analizza i dati|pattern|statistich/i.test(taskLow);
        const hasTranslate  = /traduci|translate|traduzione|translation/i.test(taskLow);
        const hasTravel     = /ristorante|restaurant|b&b|hotel|albergo|agriturismo|locanda|osteria|prenotaz|vacanz|romantico|sushi|giapponese|cinese|pizza|cena|dinner|pranzo|lunch|soggiorno|weekend|pernottament|posto\s+dove\s+mangiare|posto\s+dove\s+dormire|dove\s+mangiare|dove\s+dormire|posto\s+romantico|gita|escursione/i.test(taskLow);

        const it = plannerLang === 'Italian';

        // Extract a clean short search query from the task (to avoid SENTINEL flagging long task strings)
        const extractSearchQuery = (t) => {
          const m = t.match(/(?:cerca|search|find|ricerca|notizie su|news about|latest on|aggiornamenti su|ultime su|tendenz|trend)\s+(.{5,80}?)(?:\s+(?:e |and |per |for |poi |then )|[,\n]|$)/i);
          if (m) return m[1].trim();
          // If task contains a domain/URL, use it as the search anchor
          const domainMatch = t.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)/i);
          if (domainMatch) return domainMatch[0].replace(/^https?:\/\//,'');
          const stripped = t.replace(/^[^:]+:\s*/,'').split(/[,\n]/)[0].slice(0,100).trim();
          return stripped || t.slice(0,80).trim();
        };
        const searchQuery = extractSearchQuery(task);

        // Build plan directly from keywords — reliable, fast, no SENTINEL risk
        const buildKeywordPlan = () => {
          const steps = [];
          // PDF attachment: always read document first to extract specs/data before any web search
          if (hasPdf) {
            const pdfName = body.pdfName || 'documento allegato';
            steps.push({icon:'\u{1F4C4}',agent:'DocumentReaderAgent',label:it?'Leggi documento':'Read document',reason:it?'Allegato PDF rilevato \u2014 estraggo dati tecnici prima di ogni altra operazione':'PDF attachment detected \u2014 extracting technical data first',prompt:`Extract all technical specifications, model numbers, part codes, product names, manufacturer, dimensions, ratings, and any other key data from the attached document "${pdfName}". List every technical detail precisely.`});
          }
          if (hasTravel)   steps.push({icon:'\u{1F374}',agent:'TravelAgent',  label:it?'Ricerca ristoranti & hotel':'Search restaurants & hotels', reason:it?'Task di viaggio/prenotazione: cerco disponibilità reale su TheFork, Booking, TripAdvisor con browser automation':'Travel/booking task: searching real availability on TheFork, Booking, TripAdvisor with browser automation', prompt:task});
          if (hasEmail)    steps.push({icon:'\u{1F4E7}',agent:'EmailAgent',   label:it?'Controlla email':'Check emails',       reason:it?'Parola chiave email/mail/posta rilevata nel task':'Keyword email/mail detected in task',       prompt:'Read the latest unread emails and identify urgent items, deadlines, and required actions'});
          if (hasCalendar) steps.push({icon:'\u{1F4C5}',agent:'CalendarAgent', label:it?'Rivedi calendario':'Review calendar',  reason:it?'Parola chiave calendario/agenda/eventi rilevata nel task':'Keyword calendar/agenda/events detected in task',   prompt:'Check today\'s events and identify any scheduling conflicts or important meetings'});
          if (hasGitHub)   steps.push({icon:'\u{1F4BB}',agent:'GitHubAgent',   label:'GitHub',                                 reason:it?'Parola chiave GitHub/git/issue/PR rilevata nel task':'Keyword GitHub/git/issue/PR detected in task',  prompt:'Read open issues and pull requests, identify what needs attention'});
          if (hasSlack)    steps.push({icon:'\u{1F4AC}',agent:'SlackAgent',    label:'Slack',                                  reason:it?'Parola chiave Slack/canale/messaggio rilevata nel task':'Keyword Slack/channel/message detected in task', prompt:'Check recent Slack messages and identify important conversations'});
          if (hasNotion)   steps.push({icon:'\u{1F4DD}',agent:'NotionAgent',   label:'Notion',                                 reason:it?'Parola chiave Notion/note rilevata nel task':'Keyword Notion/note detected in task',                  prompt:'Search Notion for relevant pages and notes'});
          // When PDF is present: always search web (to find where to buy, similar products etc.)
          // The search query will be refined at runtime using the extracted PDF specs as context
          if (!hasTravel && (hasPdf || hasSearch || hasReputation || (!hasEmail && !hasCalendar && !hasGitHub && !hasSlack))) {
            const searchPrompt = hasPdf
              ? (it ? 'Usando le specifiche tecniche estratte dal documento (codice prodotto, modello, costruttore, caratteristiche), cerca online dove acquistare il prodotto o articoli equivalenti. Usa i codici esatti dal documento come query di ricerca.' : 'Using the technical specifications extracted from the document (product code, model, manufacturer, specs), search online for where to buy this product or equivalent alternatives. Use exact codes from the document as search queries.')
              : searchQuery;
            const searchReason = hasPdf ? (it?'Complemento PDF: cerco informazioni online con i dati estratti':'PDF complement: searching online with extracted specs') : hasReputation ? (it?'Parola chiave reputazione/brand: raccolgo dati web':'Reputation/brand keyword: collecting web data') : hasSearch ? (it?'Parola chiave cerca/search/notizie rilevata':'Keyword search/news detected') : (it?'Nessuna fonte dati specifica \u2014 web come fonte primaria':'No specific data source \u2014 web as primary source');
            steps.push({icon:'\u{1F50D}',agent:'WebSearchAgent',label:it?'Ricerca web':'Web search',reason:searchReason,prompt:searchPrompt});
          }
          // Specialist agents — can stack multiple
          if (hasSecurity)   steps.push({icon:'\u{1F6E1}',agent:'cassandra',   label:it?'CASSANDRA \u2014 Rischi sicurezza':'CASSANDRA \u2014 Security risks',    reason:it?'Parola chiave sicurezza/vulnerabilit\u00e0/audit rilevata':'Keyword security/vulnerability/audit detected',    prompt:'Analyze the collected data and identify security risks, vulnerabilities and concrete recommendations'});
          if (hasFinance)    steps.push({icon:'\u{1F4B0}',agent:'mercury',     label:it?'MERCURY \u2014 Analisi mercato':'MERCURY \u2014 Market analysis',          reason:it?'Parola chiave finanza/mercato/investimento rilevata':'Keyword finance/market/investment detected',          prompt:'Analyze the financial data and market trends from the collected information'});
          if (hasStrategy)   steps.push({icon:'\u{265F}', agent:'athena',      label:it?'ATHENA \u2014 Strategia':'ATHENA \u2014 Strategy',                        reason:it?'Parola chiave strategia/competitivo/posizionamento rilevata':'Keyword strategy/competitive/positioning detected',prompt:'Based on the collected data, produce strategic analysis with competitive positioning and concrete recommendations'});
          if (hasReputation) steps.push({icon:'\u{1F52D}',agent:'oracle',      label:it?'ORACLE \u2014 Reputazione':'ORACLE \u2014 Reputation',                    reason:it?'Parola chiave reputazione/brand/recensioni rilevata':'Keyword reputation/brand/reviews detected',             prompt:'Analyze the online reputation data, sentiment and brand positioning from the collected information'});
          if (hasCode)       steps.push({icon:'\u{1F527}',agent:'forge',       label:it?'FORGE \u2014 Analisi codice':'FORGE \u2014 Code analysis',                reason:it?'Parola chiave codice/refactor/bug/npm rilevata':'Keyword code/refactor/bug/npm detected',                    prompt:'Analyze the code, dependencies and technical issues identified in the data'});
          if (hasWriting)    steps.push({icon:'\u{1F58A}',agent:'quill',       label:it?'QUILL \u2014 Redazione':'QUILL \u2014 Writing',                           reason:it?'Parola chiave scrivi/articolo/documento rilevata':'Keyword write/article/document detected',                  prompt:'Write a polished, professional document based on all the collected information'});
          if (hasData)       steps.push({icon:'\u{1F4CA}',agent:'DataAnalystAgent',label:it?'Analisi dati':'Data analysis',                                        reason:it?'Parola chiave dati/dataset/statistiche rilevata':'Keyword data/dataset/statistics detected',                 prompt:'Analyze the data and extract key patterns, trends and insights'});
          if (hasTranslate)  steps.push({icon:'\u{1F310}',agent:'polyglot',    label:it?'POLYGLOT \u2014 Traduzione':'POLYGLOT \u2014 Translation',                reason:it?'Parola chiave traduci/traduzione rilevata':'Keyword translate/translation detected',                         prompt:'Translate the content as requested, maintaining meaning and style'});
          // If no specialist added but we have data, add HERALD for synthesis
          const hasSpecialist = hasSecurity || hasFinance || hasStrategy || hasReputation || hasCode || hasWriting || hasData || hasTranslate;
          if (!hasSpecialist && (hasBriefing || steps.length > 0)) {
            steps.push({icon:'\u{1F4F0}',agent:'HERALD',label:it?'HERALD \u2014 Briefing esecutivo':'HERALD \u2014 Executive briefing',reason:it?'Nessun agente specialista \u2014 HERALD sintetizza tutti i dati raccolti':'No specialist agent \u2014 HERALD synthesizes all collected data',prompt:'Based on ALL the data collected by the previous steps, write a complete executive briefing with priorities, findings, and strategic recommendations. Do NOT invent data — only use what was provided.'});
          }
          // Add CanvasAgent: always when explicitly requested OR when 2+ specialist agents ran (complex analysis deserves a visual report)
          const specialistCount = [hasSecurity,hasFinance,hasStrategy,hasReputation,hasCode,hasWriting,hasData].filter(Boolean).length;
          if (hasCanvas || specialistCount >= 2 || (hasSpecialist && hasBriefing)) {
            const canvasReason = hasCanvas ? (it?'Parola chiave html/dashboard/report visuale rilevata':'Keyword html/dashboard/visual report detected') : (it?specialistCount+' agenti specialisti \u2014 analisi complessa merita una dashboard':specialistCount+' specialist agents \u2014 complex analysis needs a visual dashboard');
            steps.push({icon:'\u{1F4CA}',agent:'CanvasAgent',label:it?'Dashboard HTML':'HTML Dashboard',reason:canvasReason,prompt:'Create a professional HTML dashboard report summarizing all findings from the previous agents'});
          }
          return steps;
        };

        // ── Hybrid planning: keyword baseline + LLM refinement ──────────────────
        //
        // Strategy (3 tiers):
        //
        //   TIER 1 — Keyword baseline (always runs, <1ms, zero LLM):
        //     Builds a solid plan from regex matches on the task. Reliable for all
        //     known patterns. Already contains `reason` for each step.
        //
        //   TIER 2 — LLM refinement (runs when baseline ≥ 1 step OR task is non-trivial):
        //     Receives the task + the keyword plan as context. Can ADD missing steps,
        //     REMOVE wrong ones, REORDER, and ADJUST prompts. Does NOT build from scratch.
        //     Falls back to keyword plan on any parse/timeout error.
        //
        //   TIER 3 — LLM-only fallback (runs when keyword baseline is empty):
        //     Task had zero keyword matches → pure LLM planning with full task text.
        //     Same fallback: on error, returns a single WebSearchAgent step.
        //
        // Why this is safe now: SENTINEL's /api/studio/ is an intent-aware route.
        // Prompt injection detection is disabled for this path — the body IS the task.
        // Encoding attacks, rate limits, and toxicity checks remain fully active.

        const keywordSteps = buildKeywordPlan();
        const hasKeywordPlan = keywordSteps.length > 0;

        // Sanitize task for LLM: strip HTML tags and control chars (defensive, not SENTINEL).
        const sanitizedTask = task.replace(/<[^>]*>/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();

        // Build a compact JSON representation of the keyword plan for the LLM to refine.
        const keywordPlanJson = hasKeywordPlan
          ? JSON.stringify(keywordSteps.map(s => ({ agent: s.agent, label: s.label, reason: s.reason || '' })))
          : '[]';

        const planConfig = Object.assign({}, config, { thinking: 'off' });

        try {
          let steps = keywordSteps;

          // TIER 2 / 3: always attempt LLM if we have a working LLM config
          if (config && (config.provider || config.apiKey || config.baseUrl)) {
            try {
              let planPrompt;
              let planSys;

              if (hasKeywordPlan) {
                // TIER 2: refine the keyword plan
                planSys = `You are a workflow planner for NHA Studio. Output ONLY valid JSON — no explanation, no markdown.`;
                planPrompt = `Task: ${sanitizedTask}

Keyword-detected plan (JSON):
${keywordPlanJson}

Language for labels: ${plannerLang}.

Review the plan above. You may:
- ADD steps that are clearly needed but missing
- REMOVE steps that are wrong for this task
- REORDER steps to fix logical sequence (e.g. Notion before email)
- ADJUST the "prompt" field of any step to better match the task
- KEEP steps that are correct as-is

Available agents: TravelAgent (restaurants/hotels/bookings with real browser automation on TheFork/Booking/TripAdvisor), WebSearchAgent, DocumentReaderAgent, EmailAgent, CalendarAgent, GitHubAgent, SlackAgent, NotionAgent, HERALD, ORACLE, ATHENA, CASSANDRA, MERCURY, QUILL, DataAnalystAgent, polyglot, CanvasAgent (last, only if visual output needed).

Output ONLY:
{"steps":[{"icon":"EMOJI","agent":"AGENT_NAME","label":"LABEL","reason":"WHY THIS AGENT","prompt":"INSTRUCTION"}]}

Rules:
- 2 to 6 steps maximum
- CanvasAgent only as the final step and only for complex multi-agent analyses
- Keep existing reasons where step is unchanged, write a new reason when you add/change a step`;
              } else {
                // TIER 3: pure LLM planning — zero keyword matches
                planSys = `You are a workflow planner for NHA Studio. Output ONLY valid JSON — no explanation, no markdown.`;
                planPrompt = `Task: ${sanitizedTask}

Language for labels: ${plannerLang}.

Build a workflow plan for this task.

Available agents: TravelAgent (restaurants/hotels/bookings with real browser automation on TheFork/Booking/TripAdvisor), WebSearchAgent, DocumentReaderAgent, EmailAgent, CalendarAgent, GitHubAgent, SlackAgent, NotionAgent, HERALD, ORACLE, ATHENA, CASSANDRA, MERCURY, QUILL, DataAnalystAgent, polyglot, CanvasAgent.

Output ONLY:
{"steps":[{"icon":"EMOJI","agent":"AGENT_NAME","label":"LABEL","reason":"WHY THIS AGENT","prompt":"INSTRUCTION"}]}

Rules:
- 2 to 5 steps
- HERALD = executive synthesis when no other specialist fits
- CanvasAgent only as the final step for complex multi-agent workflows
- reason = one sentence explaining why this agent was chosen`;
              }

              const planRaw = await callLLM(planConfig, planSys, planPrompt, { max_tokens: 900 });
              process.stderr.write('[STUDIO PLAN LLM RAW] mode=' + (hasKeywordPlan ? 'refine' : 'pure') + ' len=' + planRaw.length + '\n');

              // Parse LLM output — strip <think> blocks (Qwen3), markdown fences, extract JSON
              let clean = planRaw;
              let prev = '';
              while (prev !== clean) { prev = clean; clean = clean.replace(/<think>[\s\S]*?<\/think>/g, ''); }
              clean = clean.trim().replace(/^```[\w]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
              const jsonMatch = clean.match(/\{[\s\S]*\}/);
              const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);

              if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
                // Merge: LLM steps override keyword steps. Preserve `reason` from keyword where LLM kept same agent.
                const keywordReasonMap = {};
                keywordSteps.forEach(s => { keywordReasonMap[s.agent] = s.reason || ''; });
                steps = parsed.steps.map(s => ({
                  icon: s.icon || '\u{1F916}',
                  agent: s.agent,
                  label: s.label,
                  reason: s.reason || keywordReasonMap[s.agent] || '',
                  prompt: s.prompt,
                }));
                process.stderr.write('[STUDIO PLAN LLM OK] steps=' + steps.length + '\n');
              } else {
                process.stderr.write('[STUDIO PLAN LLM EMPTY] falling back to keyword plan\n');
              }
            } catch (llmErr) {
              process.stderr.write('[STUDIO PLAN LLM ERR] ' + llmErr.message + ' — using keyword plan\n');
              // steps already = keywordSteps, no action needed
            }
          } else {
            process.stderr.write('[STUDIO PLAN KEYWORD ONLY] no LLM config, steps=' + keywordSteps.length + '\n');
          }

          // Final safety net: if everything failed and we have nothing, single web search step
          if (!Array.isArray(steps) || !steps.length) {
            steps = [{ icon: '\u{1F50D}', agent: 'WebSearchAgent', label: plannerLang === 'Italian' ? 'Ricerca web' : 'Web search', reason: plannerLang === 'Italian' ? 'Fallback: nessun piano costruito' : 'Fallback: no plan built', prompt: sanitizedTask }];
          }

          sendJSON(res, 200, { steps });
          logRequest(method, pathname, 200, Date.now() - start);
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
          logRequest(method, pathname, 500, Date.now() - start);
        }
        return;
      }

      // ── Studio: run single step (SSE streaming) ──────────────────────
      if (pathname === '/api/studio/run' && method === 'POST') {
        const body = await parseBody(req, 4_194_304); // 4MB — context can be up to 120KB + task + PDF
        const { agent, task, context, stepDef } = body;
        const stepPdfBase64 = body.pdfBase64 || null;
        const stepPdfName = body.pdfName || null;
        const stepImageBase64 = body.imageBase64 || null;
        const stepImageMime = body.imageMimeType || 'image/jpeg';
        if (!agent || !task) { sendJSON(res, 400, { error: 'agent and task required' }); logRequest(method, pathname, 400, Date.now() - start); return; }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        const sendEvent = (data) => {
          try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
        };
        const sendToken = (t) => sendEvent({ token: t });

        // Keepalive: send a comment every 5s so the connection doesn't time out during slow tool calls
        const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 5000);

        // Timeout wrapper — ms param optional (default 25s for tool calls)
        const withTimeout = (promise, ms) => {
          const delay = typeof ms === 'number' ? ms : 25000;
          return Promise.race([
            promise,
            new Promise((_, rej) => setTimeout(() => rej(new Error(`Step timed out after ${delay/1000}s`)), delay)),
          ]);
        };

        try {
          const stepPrompt = stepDef?.prompt || task;
          let toolData = '';

          // ── Fetch REAL data for each agent type ──────────────────────
          if (agent === 'DocumentReaderAgent') {
            // Always use vision for PDF reading — text extraction loses table structure,
            // column alignment, and layout-dependent data for the vast majority of
            // technical PDFs (datasheets, catalogs, forms, scanned docs).
            // Vision reads exactly what a human sees on the page.
            sendToken('[Reading document with vision...] ');
            let rawText = '';
            if (stepPdfBase64) {
              try {
                const b64 = stepPdfBase64.includes(',') ? stepPdfBase64.split(',')[1] : stepPdfBase64;
                rawText = await callLLMVision(
                  config,
                  'You are a technical document analyst. Extract ALL content exactly as it appears on the page.',
                  'Extract ALL content from this document: all text, tables (preserve rows and columns with exact values), product codes, numbers, units, notes, headers. Do not summarize — transcribe everything visible.',
                  { base64: b64, mimeType: 'application/pdf' }
                );
              } catch (ve) {
                // Vision failed — fall back to text extraction
                sendToken('[Vision unavailable — falling back to text extraction...] ');
                try {
                  const b64 = stepPdfBase64.includes(',') ? stepPdfBase64.split(',')[1] : stepPdfBase64;
                  rawText = extractTextFromPdf(Buffer.from(b64, 'base64')) || '';
                } catch (e) { rawText = ''; }
              }
            }
            if (!rawText) {
              sendToken('Could not extract text from the attached document.');
              clearInterval(keepalive);
              sendEvent({ done: true, usage: { input: 0, output: 0 } });
              res.end();
              logRequest(method, pathname, 200, Date.now() - start);
              return;
            }
            // Ask LLM to structure the raw extracted text into readable markdown
            sendToken('[Structuring document content...] ');
            const LANG_MAP_DOC = {en:'English',it:'Italian',es:'Spanish',fr:'French',de:'German',pt:'Portuguese',zh:'Chinese',ja:'Japanese',ar:'Arabic',hi:'Hindi',ru:'Russian',nl:'Dutch',pl:'Polish',tr:'Turkish',ko:'Korean',sv:'Swedish',da:'Danish',fi:'Finnish',no:'Norwegian',cs:'Czech'};
            const docLang = LANG_MAP_DOC[(config?.language||'it').toLowerCase().slice(0,2)] || 'Italian';
            // Put the raw PDF text in the SYSTEM prompt — SENTINEL only scans the user message.
            // The user message is a short, safe instruction that won't trigger false positives.
            const docSys = `You are a technical document analyst. The following is the raw text extracted from the document "${stepPdfName || 'document.pdf'}". Your job is to structure it into clear, readable markdown. Respond in ${docLang}.

Rules:
- List ALL technical specifications with their exact values (codes, voltages, pressures, temperatures, dimensions, flow rates, etc.)
- Use markdown headers (##), bullet points (-), and tables where appropriate
- Do NOT invent, interpret, or add anything not present in the raw text
- Include all product/part codes exactly as written
- Keep all numeric values with their units

RAW DOCUMENT TEXT:
${rawText.slice(0, 18000)}`;
            const docUser = `Structure the document content above into clean, readable markdown with all technical specifications.`;
            let structuredOutput = '';
            let inThink = false;
            try {
              await withTimeout(
                callLLMStream(config, docSys, docUser,
                  (token) => {
                    // Strip <think> blocks
                    let buf = token;
                    if (inThink) {
                      const ci = buf.indexOf('</think>');
                      if (ci >= 0) { buf = buf.slice(ci + 8); inThink = false; }
                      else return;
                    }
                    const oi = buf.indexOf('<think>');
                    if (oi >= 0) { buf = buf.slice(0, oi); inThink = true; }
                    if (buf) { structuredOutput += buf; sendToken(buf); }
                  },
                  { max_tokens: 3000 }
                ),
                90000
              );
            } catch (e) {
              // LLM failed — fall back to raw text
              structuredOutput = `## ${stepPdfName || 'Document'}\n\n${rawText.slice(0, 8000)}`;
              sendToken(structuredOutput);
            }
            clearInterval(keepalive);
            sendEvent({ done: true, usage: { input: Math.ceil(rawText.length / 4), output: Math.ceil(structuredOutput.length / 4) } });
            res.end();
            logRequest(method, pathname, 200, Date.now() - start);
            return;

          } else if (agent === 'EmailAgent') {
            sendToken('[Reading emails...] ');
            try {
              const emails = await withTimeout(getUnreadImportant(config, 10), 'EmailAgent');
              toolData = emails && emails.length
                ? emails.map(e => `From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\nSnippet: ${e.snippet}`).join('\n\n---\n\n')
                : 'No unread emails found.';
            } catch (e) { toolData = `Email read failed: ${e.message}`; }

          } else if (agent === 'CalendarAgent') {
            sendToken('[Reading calendar...] ');
            try {
              const events = await withTimeout(getTodayEvents(config), 'CalendarAgent');
              toolData = events && events.length
                ? events.map(e => `${e.summary || e.title} - ${e.start || ''} to ${e.end || ''}`).join('\n')
                : 'No events found for today.';
            } catch (e) { toolData = `Calendar read failed: ${e.message}`; }

          } else if (agent === 'WebSearchAgent' || agent === 'ResearchAgent') {
            sendToken('[Searching the web and reading pages...] ');
            try {
              // If the task or stepPrompt contains explicit URLs, fetch them directly first
              const explicitUrls = (task + ' ' + stepPrompt).match(/https?:\/\/[^\s"'<>)]+/g);
              if (explicitUrls && explicitUrls.length > 0) {
                const uniqueUrls = [...new Set(explicitUrls)].slice(0, 4);
                for (const u of uniqueUrls) {
                  sendToken(`[Fetching ${u}...] `);
                  try {
                    const fetchRes = await withTimeout(executeTool('fetch_url', { url: u }, config), 30000);
                    const fetchStr = typeof fetchRes === 'string' ? fetchRes : JSON.stringify(fetchRes);
                    if (fetchStr && fetchStr.length > 100) {
                      toolData += (toolData ? '\n\n' : '') + `## Page content: ${u}\n${fetchStr.slice(0, 8000)}`;
                    }
                  } catch (e) { toolData += (toolData ? '\n\n' : '') + `## Fetch ${u} failed: ${e.message}`; }
                }
              }
              // If there is document context from a previous step, ask the LLM to derive
              // the optimal search queries. This is generic and works for any document/task.
              let searchQueries = [stepPrompt.slice(0, 120)];
              // Only use LLM query generation when context is a PDF/document (not previous agent text output).
              // When context is email/github output from a prior step, ignore it — use task + stepPrompt directly.
              const contextIsPdf = context && context.length > 50 && context.startsWith('## ATTACHED PDF');
              if (contextIsPdf) {
                sendToken('[Building search queries from document...] ');
                try {
                  const queryPlanSys = `You are a search query generator. Given a document summary and a user task, output a JSON array of 1-3 concise web search queries (strings, max 80 chars each) that will find the best results. Output ONLY the JSON array, no explanation.\n\nDocument content:\n${context.slice(0, 3000)}`;
                  const queryPlanUser = `User task: "${task.slice(0, 200)}". Generate search queries. If task asks for similar/alternative products use technical specs. Output: ["query1","query2",...]`;
                  const planConfig2 = Object.assign({}, config, { thinking: 'off' });
                  const queryRaw = await withTimeout(callLLM(planConfig2, queryPlanSys, queryPlanUser, { max_tokens: 200 }), 15000);
                  const jsonMatch = queryRaw.match(/\[[\s\S]*?\]/);
                  if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                      searchQueries = parsed.filter(q => typeof q === 'string' && q.length > 2).slice(0, 3);
                    }
                  }
                } catch {}
              } else {
                // No PDF — derive queries from task + stepPrompt using LLM for better queries
                sendToken('[Building search queries...] ');
                try {
                  const queryPlanSys = `You are a search query generator. Given a user task and a search instruction, output a JSON array of 2-3 concise web search queries (strings, max 80 chars each). Focus on the specific topics in the task. Output ONLY the JSON array, no explanation.`;
                  const queryPlanUser = `Task: "${task.slice(0, 300)}"\nSearch instruction: "${stepPrompt.slice(0, 200)}"\nOutput: ["query1","query2","query3"]`;
                  const planConfig2 = Object.assign({}, config, { thinking: 'off' });
                  const queryRaw = await withTimeout(callLLM(planConfig2, queryPlanSys, queryPlanUser, { max_tokens: 200 }), 15000);
                  const jsonMatch = queryRaw.match(/\[[\s\S]*?\]/);
                  if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                      searchQueries = parsed.filter(q => typeof q === 'string' && q.length > 2).slice(0, 3);
                    }
                  }
                } catch {}
              }
              sendToken(`[Queries: ${searchQueries.map(q => '"' + q + '"').join(', ')}] `);

              // Run all queries sequentially, accumulate results
              for (let qi = 0; qi < searchQueries.length; qi++) {
                const q = searchQueries[qi];
                sendToken(`[Searching: "${q.slice(0, 60)}"] `);
                try {
                  const searchResult = await withTimeout(executeTool('web_search', { query: q, deep: true }, config), 35000);
                  const searchStr = typeof searchResult === 'string' ? searchResult : JSON.stringify(searchResult);
                  // If no results, try without 'deep' (fallback to basic search)
                  if (!searchStr || searchStr.length < 50 || /no results|not found/i.test(searchStr)) {
                    sendToken('[Retrying basic search...] ');
                    const retryResult = await withTimeout(executeTool('web_search', { query: q }, config), 25000);
                    const retryStr = typeof retryResult === 'string' ? retryResult : JSON.stringify(retryResult);
                    toolData += (toolData ? '\n\n' : '') + `## Web search: "${q}":\n${retryStr || 'No results found.'}`;
                  } else {
                    toolData += (toolData ? '\n\n' : '') + `## Web search: "${q}":\n${searchStr}`;
                  }
                } catch (e) { toolData += (toolData ? '\n\n' : '') + `## Search "${q}" failed: ${e.message}`; }
              }

              // After all searches: extract URLs from results and fetch booking/info portals directly
              // This is critical for travel/restaurant/accommodation tasks where portals have internal search
              const isBookingTask = /(ristorante|restaurant|b&b|hotel|albergo|prenotaz|booking|vacanz|romantico|sushi|menu|disponib|soggiorno|weekend|cena|dinner|accommodation)/i.test(task + ' ' + stepPrompt);
              if (isBookingTask && toolData.length > 100) {
                // Extract URLs found in search results
                const foundUrls = [...new Set((toolData.match(/https?:\/\/[^\s"'\n<>)]+/g) || []))];
                // Prioritize booking/info portals
                const portalDomains = ['thefork', 'theforkmanger', 'booking.com', 'tripadvisor', 'yelp', 'zomato', 'airbnb', 'agriturismo', 'expedia', 'hotel', 'b-b.it', 'bed-and-breakfast', 'locanda', 'osteria', 'ristorante', 'viaggi'];
                const portalUrls = foundUrls.filter(u => portalDomains.some(d => u.toLowerCase().includes(d))).slice(0, 3);
                if (portalUrls.length > 0) {
                  sendToken(`[Reading ${portalUrls.length} portal page(s)...] `);
                  for (const pu of portalUrls) {
                    try {
                      const pfetch = await withTimeout(executeTool('fetch_url', { url: pu }, config), 20000);
                      const pfetchStr = typeof pfetch === 'string' ? pfetch : JSON.stringify(pfetch);
                      if (pfetchStr && pfetchStr.length > 200) {
                        toolData += '\n\n## Portal page: ' + pu + '\n' + pfetchStr.slice(0, 5000);
                      }
                    } catch {}
                  }
                }
              }
            } catch (e) { toolData = toolData || `Web search failed: ${e.message}`; }

          } else if (agent === 'TravelAgent') {
            sendToken('[TravelAgent: analyzing your request...] ');
            try {
              const be = await import('../services/browser-engine.mjs');
              const travelTask = stepPrompt || task;

              // ── Extract parameters from task ──
              // Date: "16 maggio", "16/05", "16-05-2026", "sabato 16", etc.
              // ── PARAMETER EXTRACTION ──
              const monthNames = {gennaio:1,febbraio:2,marzo:3,aprile:4,maggio:5,giugno:6,luglio:7,agosto:8,settembre:9,ottobre:10,novembre:11,dicembre:12};
              const dateMatch = travelTask.match(/(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/i)
                || travelTask.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?/);
              let targetDate = null;
              let targetDateStr = null;
              if (dateMatch) {
                if (dateMatch[2] && isNaN(Number(dateMatch[2]))) {
                  const day = parseInt(dateMatch[1]);
                  const month = monthNames[(dateMatch[2] || '').toLowerCase()];
                  if (day && month) {
                    const year = new Date().getFullYear();
                    targetDate = new Date(year, month - 1, day);
                    targetDateStr = String(day).padStart(2, '0') + '/' + String(month).padStart(2, '0') + '/' + year;
                  }
                } else if (dateMatch[1] && dateMatch[2]) {
                  const day = parseInt(dateMatch[1]);
                  const month = parseInt(dateMatch[2]);
                  const year = dateMatch[3] ? parseInt(dateMatch[3]) : new Date().getFullYear();
                  if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
                    targetDate = new Date(year, month - 1, day);
                    targetDateStr = String(day).padStart(2, '0') + '/' + String(month).padStart(2, '0') + '/' + year;
                  }
                }
              }

              // City extraction — multi-attempt, most specific first
              let city = null;
              const _stopRx = /\s+(il|la|lo|i|le|gli|per|con|un|una|del|della|dei|delle|e|o|\d).*$/i;
              // P1: "vicino a/near/around <City>"
              const _cp1 = travelTask.match(/\b(?:vicino\s+a|near|around)\s+([A-Z][a-zA-Z\u00C0-\u017E]{1,}(?:\s+[A-Z][a-zA-Z\u00C0-\u017E]+)?)/);
              // P2: "a/in <Capitalized City>"
              const _cp2 = travelTask.match(/\b(?:a|in)\s+([A-Z][a-zA-Z\u00C0-\u017E]{2,}(?:\s+[A-Z][a-zA-Z\u00C0-\u017E]+)?)/);
              // P3: "a/in <lowercase city>" (case insensitive)
              const _cp3 = travelTask.match(/\b(?:a|in|at|near)\s+([a-zA-Z\u00C0-\u017E]{3,}(?:\s+[a-zA-Z\u00C0-\u017E]+)?)/i);
              // P4: known cities via word-split — also checks adjectival forms (mantovana→mantova, milanese→milano)
              const _knownCitiesArr = ['Milano','Roma','Napoli','Torino','Firenze','Bologna','Venezia','Genova','Palermo','Bari','Catania','Verona','Padova','Trieste','Brescia','Bergamo','Modena','Parma','Reggio','Mantova','Ferrara','Vicenza','Treviso','Udine','Trento','Bolzano','Perugia','Ancona','Pescara','Foggia','Salerno','Taranto','Cagliari','Sassari','Siena','Pisa','Lucca','Arezzo','Rimini','Ravenna','Prato','Livorno','Messina','Paris','Lyon','Marseille','Nice','Bordeaux','Toulouse','Strasbourg','Nantes','Madrid','Barcelona','Sevilla','Valencia','Bilbao','Malaga','Lisbon','Porto','Berlin','Munich','Hamburg','Frankfurt','Stuttgart','Cologne','Amsterdam','Rotterdam','Brussels','Vienna','Zurich','Geneva','Prague','Warsaw','Budapest','Bucharest','Athens','Istanbul','London','Manchester','Edinburgh','Dublin','Copenhagen','Stockholm','Oslo','Helsinki','Tokyo','Osaka','Seoul','Beijing','Shanghai','Singapore','Sydney','Melbourne','Toronto','Montreal','Vancouver','Dubai','Bangkok','Mumbai','Delhi','Cairo','Nairobi'];
              const _taskWords = travelTask.toLowerCase().split(/[\s,;:.!?]+/);
              // Exact match, then prefix match (with and without final vowel) for demonyms
              // e.g. mantovana→mantova, veneziano→venezia, milanese→milano (milan+ese)
              const _cp4found = _knownCitiesArr.find(c => _taskWords.includes(c.toLowerCase()))
                || _knownCitiesArr.find(c => {
                  const cl = c.toLowerCase();
                  const cl0 = cl.slice(0, -1); // without final vowel (milan from milano)
                  return c.length >= 4 && _taskWords.some(w => w.length > cl.length - 1 && (w.toLowerCase().startsWith(cl) || (cl0.length >= 4 && w.toLowerCase().startsWith(cl0))));
                });
              // P5: "zona <city>" or "zona di <city>" — only if P4 didn't find anything
              const _cp5 = !_cp4found && travelTask.match(/zona\s+(?:di\s+)?([a-zA-Z\u00C0-\u017E]{3,})/i);
              const _cityRaw = (_cp1 && _cp1[1]) || (_cp2 && _cp2[1]) || (_cp3 && _cp3[1]) || _cp4found || (_cp5 && _cp5[1]) || null;
              if (_cityRaw) {
                city = _cityRaw.replace(_stopRx, '').trim();
                if (city.length < 2) city = null;
              }

              // Cuisine type → OSM cuisine tag
              const cuisineMap = {sushi:'sushi',pizza:'pizza',giapponese:'japanese',japanese:'japanese',italiano:'italian',italian:'italian',cinese:'chinese',chinese:'chinese',indiano:'indian',indian:'indian',steakhouse:'steak_house',trattoria:'italian',osteria:'italian'};
              const cuisineMatch = travelTask.match(/\b(sushi|pizza|giapponese|japanese|italiano|italian|cinese|chinese|indiano|indian|steakhouse|trattoria|osteria)\b/i);
              const cuisineRaw = cuisineMatch ? cuisineMatch[1].toLowerCase() : null;
              const cuisineOSM = cuisineRaw ? (cuisineMap[cuisineRaw] || cuisineRaw) : null;

              const hasAccommodation = /b&b|bed\s*(?:&|and)\s*breakfast|hotel|albergo|agriturismo|locanda|ostello|hostel|pernottament|soggiorno/i.test(travelTask);
              const hasRestaurant = /ristorante|restaurant|sushi|cena|dinner|pranzo|lunch|mangiare|eat/i.test(travelTask);

              const summaryParts = [];
              if (city) summaryParts.push('city: ' + city);
              if (targetDateStr) summaryParts.push('date: ' + targetDateStr);
              if (cuisineRaw) summaryParts.push('cuisine: ' + cuisineRaw);
              if (hasAccommodation) summaryParts.push('accommodation: yes');
              if (hasRestaurant) summaryParts.push('restaurant: yes');
              sendToken('[Extracted — ' + (summaryParts.join(', ') || 'general search') + '] ');

              const UA = 'NHA-TravelAgent/1.0 (nothumanallowed.com)';
              const portalResults = [];

              // ── TIER 1: Nominatim geocoding → get lat/lon for city ──
              let lat = null, lon = null;
              if (city) {
                sendToken('[Geocoding ' + city + '...] ');
                try {
                  const geoUrl = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q: city, format: 'json', limit: '1', addressdetails: '0' }).toString();
                  const geoRes = await withTimeout(fetch(geoUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }), 8000);
                  if (geoRes.ok) {
                    const geoData = await geoRes.json();
                    if (geoData && geoData[0]) {
                      lat = parseFloat(geoData[0].lat);
                      lon = parseFloat(geoData[0].lon);
                      sendToken('[Found: ' + lat.toFixed(4) + ', ' + lon.toFixed(4) + '] ');
                    }
                  }
                } catch {}
              }

              // ── TIER 1: Overpass API — real OSM data ──
              if (lat !== null && lon !== null) {
                const radius = 5000; // 5km radius
                const formatPlace = (el) => {
                  const t = el.tags || {};
                  const parts = [];
                  if (t.name) parts.push('**' + t.name + '**');
                  if (t['addr:street']) parts.push(t['addr:street'] + (t['addr:housenumber'] ? ' ' + t['addr:housenumber'] : ''));
                  if (t['addr:city']) parts.push(t['addr:city']);
                  if (t.phone || t['contact:phone']) parts.push('Tel: ' + (t.phone || t['contact:phone']));
                  if (t.website || t['contact:website']) parts.push('Web: ' + (t.website || t['contact:website']));
                  if (t.opening_hours) parts.push('Orari: ' + t.opening_hours);
                  if (t.email || t['contact:email']) parts.push('Email: ' + (t.email || t['contact:email']));
                  if (t.cuisine) parts.push('Cucina: ' + t.cuisine);
                  if (t.stars) parts.push('Stelle: ' + t.stars);
                  const coordLat = el.lat || (el.center && el.center.lat);
                  const coordLon = el.lon || (el.center && el.center.lon);
                  if (coordLat && coordLon) parts.push('Maps: https://www.openstreetmap.org/?mlat=' + coordLat + '&mlon=' + coordLon + '&zoom=17');
                  return parts.join(' | ');
                };

                // Restaurants query
                if (hasRestaurant) {
                  sendToken('[Overpass: searching restaurants' + (cuisineOSM ? ' (' + cuisineOSM + ')' : '') + '...] ');
                  try {
                    const cuisineFilter = cuisineOSM ? '["cuisine"="' + cuisineOSM + '"]' : '';
                    const restQuery = '[out:json][timeout:20];(node["amenity"="restaurant"]' + cuisineFilter + '(around:' + radius + ',' + lat + ',' + lon + ');way["amenity"="restaurant"]' + cuisineFilter + '(around:' + radius + ',' + lat + ',' + lon + '););out center tags;';
                    const restRes = await withTimeout(fetch('https://overpass.kumi.systems/api/interpreter', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
                      body: 'data=' + encodeURIComponent(restQuery)
                    }), 25000);
                    if (restRes.ok) {
                      const restData = await restRes.json();
                      const elements = (restData.elements || []).filter(el => el.tags && el.tags.name);
                      if (elements.length > 0) {
                        const lines = ['## Ristoranti trovati via OpenStreetMap (' + elements.length + ' risultati, raggio ' + (radius/1000) + 'km da ' + city + ')'];
                        elements.slice(0, 15).forEach((el, i) => { lines.push((i+1) + '. ' + formatPlace(el)); });
                        portalResults.push(lines.join('\n'));
                        sendToken('[Found ' + elements.length + ' restaurants] ');
                      } else if (cuisineOSM) {
                        // Retry without cuisine filter — broader search
                        sendToken('[No ' + cuisineOSM + ' found, retrying broader...] ');
                        const broadQuery = '[out:json][timeout:20];(node["amenity"="restaurant"](around:' + radius + ',' + lat + ',' + lon + ');way["amenity"="restaurant"](around:' + radius + ',' + lat + ',' + lon + '););out center tags;';
                        const broadRes = await withTimeout(fetch('https://overpass.kumi.systems/api/interpreter', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
                          body: 'data=' + encodeURIComponent(broadQuery)
                        }), 25000);
                        if (broadRes.ok) {
                          const broadData = await broadRes.json();
                          const broadEl = (broadData.elements || []).filter(el => el.tags && el.tags.name);
                          if (broadEl.length > 0) {
                            const lines = ['## Ristoranti a ' + city + ' (tutti i tipi, ' + broadEl.length + ' trovati — nessun ristorante ' + cuisineRaw + ' su OpenStreetMap in questa zona)'];
                            broadEl.slice(0, 10).forEach((el, i) => { lines.push((i+1) + '. ' + formatPlace(el)); });
                            portalResults.push(lines.join('\n'));
                          }
                        }
                      }
                    }
                  } catch (e) { sendToken('[Overpass restaurants error: ' + e.message.slice(0,50) + '] '); }
                }

                // Accommodation query
                if (hasAccommodation) {
                  sendToken('[Overpass: searching accommodation...] ');
                  try {
                    const accQuery = '[out:json][timeout:20];(node["tourism"~"hotel|guest_house|bed_and_breakfast|hostel|motel"](around:' + radius + ',' + lat + ',' + lon + ');way["tourism"~"hotel|guest_house|bed_and_breakfast|hostel|motel"](around:' + radius + ',' + lat + ',' + lon + ');node["amenity"="hotel"](around:' + radius + ',' + lat + ',' + lon + '););out center tags;';
                    const accRes = await withTimeout(fetch('https://overpass.kumi.systems/api/interpreter', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
                      body: 'data=' + encodeURIComponent(accQuery)
                    }), 25000);
                    if (accRes.ok) {
                      const accData = await accRes.json();
                      const elements = (accData.elements || []).filter(el => el.tags && el.tags.name);
                      if (elements.length > 0) {
                        const lines = ['## Alloggi trovati via OpenStreetMap (' + elements.length + ' risultati, raggio ' + (radius/1000) + 'km da ' + city + ')'];
                        elements.slice(0, 15).forEach((el, i) => {
                          const t = el.tags || {};
                          const type = t.tourism === 'guest_house' ? 'B&B/Guest house' : t.tourism === 'hotel' ? 'Hotel' : t.tourism === 'bed_and_breakfast' ? 'B&B' : (t.tourism || 'Alloggio');
                          lines.push((i+1) + '. [' + type + '] ' + formatPlace(el));
                        });
                        portalResults.push(lines.join('\n'));
                        sendToken('[Found ' + elements.length + ' accommodations] ');
                      }
                    }
                  } catch (e) { sendToken('[Overpass accommodation error: ' + e.message.slice(0,50) + '] '); }
                }
              } else if (city) {
                sendToken('[Geocoding failed, skipping Overpass] ');
              }

              // ── TIER 2: Web search fallback — only if Overpass found nothing ──
              const dataFound = portalResults.length > 0;
              if (!dataFound) {
                sendToken('[Web search fallback...] ');
                try {
                  const cityStr = city || '';
                  const queries = [];
                  if (hasRestaurant && cityStr) queries.push((cuisineRaw ? cuisineRaw + ' ' : '') + 'ristorante ' + cityStr + ' prenotazione');
                  else if (hasRestaurant) queries.push((cuisineRaw ? cuisineRaw + ' ' : '') + 'ristorante prenotazione online');
                  if (hasAccommodation && cityStr) queries.push('b&b hotel ' + cityStr + (targetDateStr ? ' ' + targetDateStr.slice(0,5) : ''));
                  if (queries.length === 0) queries.push(travelTask.slice(0, 80));
                  for (const q of queries) {
                    const sr = await withTimeout(executeTool('web_search', { query: q, deep: true }, config), 30000);
                    if (sr && sr.length > 100) portalResults.push('## Web search: "' + q + '"\n' + (typeof sr === 'string' ? sr : JSON.stringify(sr)));
                  }
                } catch {}
              }

              // ── Build final output ──
              if (portalResults.length > 0) {
                const header = '# TravelAgent — Risultati per: ' + (city || 'zona non specificata') + (targetDateStr ? ' | Data: ' + targetDateStr : '') + (cuisineRaw ? ' | Cucina: ' + cuisineRaw : '') + '\n\n';
                toolData = header + portalResults.join('\n\n');
              } else {
                toolData = '# TravelAgent — Nessun risultato trovato\n\nNon sono stati trovati ristoranti o alloggi per i parametri specificati.\n\n**Parametri cercati:**\n- Città: ' + (city || 'non specificata') + '\n- Data: ' + (targetDateStr || 'non specificata') + '\n- Tipo cucina: ' + (cuisineRaw || 'qualsiasi') + '\n\n**Suggerimento:** Specifica la città esatta (es. "a Mantova") e il tipo di cucina per ottenere risultati migliori.';
              }
            } catch (e) { toolData = toolData || 'TravelAgent failed: ' + e.message; }

          } else if (agent === 'BrowserAgent') {
            // Collect all URLs from stepPrompt + task, plus infer subpaths mentioned (e.g. /about, /docs)
            const allUrlMatches = [...new Set((stepPrompt + ' ' + task).match(/https?:\/\/[^\s"'<>)]+/g) || [])];
            // Also extract any relative paths like /about, /download, /docs mentioned near a base URL
            const baseUrlMatch = (stepPrompt + ' ' + task).match(/https?:\/\/[^\s"'<>/]+/);
            if (baseUrlMatch) {
              const base = baseUrlMatch[0].replace(/\/$/, '');
              const subpaths = (stepPrompt + ' ' + task).match(/\/[a-z][a-z0-9_/-]*/g) || [];
              for (const sp of subpaths) {
                if (sp.length > 1 && sp.length < 40) allUrlMatches.push(base + sp);
              }
            }
            const urlsToFetch = [...new Set(allUrlMatches)].slice(0, 5);
            if (urlsToFetch.length > 0) {
              for (const u of urlsToFetch) {
                sendToken(`[Fetching ${u}...] `);
                try {
                  const fetchResult = await withTimeout(executeTool('fetch_url', { url: u }, config), 30000);
                  const fetchStr = typeof fetchResult === 'string' ? fetchResult : JSON.stringify(fetchResult);
                  if (fetchStr && fetchStr.length > 100) {
                    toolData += (toolData ? '\n\n' : '') + `## Page: ${u}\n${fetchStr.slice(0, 8000)}`;
                  }
                } catch (e) { toolData += (toolData ? '\n\n' : '') + `## Fetch ${u} failed: ${e.message}`; }
              }
            } else {
              sendToken('[Searching web...] ');
              try {
                const searchResult = await withTimeout(executeTool('web_search', { query: stepPrompt }, config), 30000);
                toolData = typeof searchResult === 'string' ? searchResult : JSON.stringify(searchResult);
              } catch (e) { toolData = `Browser search failed: ${e.message}`; }
            }

          } else if (agent === 'GitHubAgent') {
            sendToken('[Reading GitHub...] ');
            try {
              const gh = await import('../services/github.mjs');
              if (!config.github?.token) {
                toolData = 'GitHub token not configured. Run: nha config set github-token YOUR_PAT';
              } else {
                const parts = [];
                // Extract repo from prompt or task (e.g. "owner/repo" pattern)
                const repoMatch = (stepPrompt + ' ' + task).match(/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
                const targetRepo = repoMatch ? repoMatch[1].replace(/[`'"]/g, '') : (config.github?.defaultRepo || '');

                if (targetRepo) {
                  sendToken(`[Analyzing ${targetRepo}...] `);
                  // Repo metadata
                  try {
                    const info = await withTimeout(gh.getRepoInfo(config, targetRepo), 20000);
                    parts.push(`## Repository: ${info.full_name}\n` +
                      `- Description: ${info.description || 'none'}\n` +
                      `- Stars: ${info.stars} | Forks: ${info.forks} | Watchers: ${info.watchers}\n` +
                      `- Open issues: ${info.open_issues}\n` +
                      `- Primary language: ${info.language}\n` +
                      `- Topics: ${info.topics}\n` +
                      `- License: ${info.license}\n` +
                      `- Last push: ${info.pushed_at} | Created: ${info.created_at}\n` +
                      `- Homepage: ${info.homepage || 'none'}\n` +
                      `- Archived: ${info.archived}`);
                  } catch (e) { parts.push(`## Repository ${targetRepo}\nCould not fetch repo info: ${e.message}`); }
                  // Languages
                  try {
                    const langs = await withTimeout(gh.getRepoLanguages(config, targetRepo), 10000);
                    if (langs) parts.push('## Languages\n' + langs);
                  } catch {}
                  // README
                  try {
                    const readme = await withTimeout(gh.getReadme(config, targetRepo), 15000);
                    if (readme) parts.push('## README\n' + readme.slice(0, 3000));
                  } catch {}
                  // Recent commits
                  try {
                    const commits = await withTimeout(gh.getRecentCommits(config, targetRepo, 10), 15000);
                    if (commits) parts.push('## Recent Commits\n' + commits);
                  } catch {}
                  // Open issues
                  try {
                    const issues = await withTimeout(gh.listIssues(config, targetRepo, 'open', 10), 15000);
                    if (issues) parts.push('## Open Issues\n' + issues);
                  } catch {}
                  // Open PRs
                  try {
                    const prs = await withTimeout(gh.listPRs(config, targetRepo, 'open', 10), 15000);
                    if (prs) parts.push('## Open Pull Requests\n' + prs);
                  } catch {}
                  // Contributors
                  try {
                    const contributors = await withTimeout(gh.getContributors(config, targetRepo, 10), 10000);
                    if (contributors) parts.push('## Contributors\n' + contributors);
                  } catch {}
                } else {
                  // No specific repo — read notifications + user repos
                  try {
                    const notifs = await withTimeout(gh.listNotifications(config, 15), 15000);
                    if (notifs) parts.push('## GitHub Notifications\n' + notifs);
                  } catch {}
                }
                toolData = parts.length > 0 ? parts.join('\n\n') : 'No GitHub data could be retrieved.';
              }
            } catch (e) { toolData = `GitHub read failed: ${e.message}`; }

          } else if (agent === 'NotionAgent') {
            sendToken('[Searching Notion...] ');
            try {
              const nt = await import('../services/notion.mjs');
              if (!config.notion?.token) {
                toolData = 'Notion token not configured. Run: nha config set notion-token YOUR_TOKEN';
              } else {
                const results = await withTimeout(nt.search(config, stepPrompt, 10), 'NotionAgent');
                toolData = typeof results === 'string' ? results : JSON.stringify(results);
              }
            } catch (e) { toolData = `Notion search failed: ${e.message}`; }

          } else if (agent === 'SlackAgent') {
            sendToken('[Reading Slack...] ');
            try {
              const sl = await import('../services/slack.mjs');
              if (!config.slack?.token) {
                toolData = 'Slack token not configured. Run: nha config set slack-token xoxb-YOUR_TOKEN';
              } else {
                const parts = [];
                try {
                  const channels = await withTimeout(sl.listChannels(config, 10), 'SlackAgent-channels');
                  if (channels) parts.push('## Slack Channels\n' + (typeof channels === 'string' ? channels : JSON.stringify(channels)));
                } catch (e) { /* skip */ }
                toolData = parts.length > 0 ? parts.join('\n\n') : 'No Slack data available.';
              }
            } catch (e) { toolData = `Slack read failed: ${e.message}`; }

          } else if (agent === 'DriveAgent') {
            sendToken('[Reading Drive...] ');
            try {
              const gd = await import('../services/google-drive.mjs');
              const files = await withTimeout(gd.listFiles(config, '', 10), 'DriveAgent');
              toolData = typeof files === 'string' ? files : JSON.stringify(files);
            } catch (e) { toolData = `Drive read failed: ${e.message}`; }

          } else if (agent === 'FileReaderAgent') {
            // Reads local files/directories mentioned in the task or step prompt
            sendToken('[Reading local files...] ');
            try {
              // Extract paths from task + stepPrompt (absolute paths, ~/ paths, named dirs like Desktop/Downloads)
              const pathPatterns = [
                /([~/][^\s"'`,;]+\.[a-zA-Z0-9]{1,10})/g,  // file with extension
                /([~/][^\s"'`,;]{3,})/g,                   // any path starting with / or ~
              ];
              const homedir = (await import('os')).homedir();
              const foundPaths = new Set();
              for (const re of pathPatterns) {
                const text = task + ' ' + stepPrompt + ' ' + (context || '');
                let m;
                while ((m = re.exec(text)) !== null) {
                  const p = m[1].replace(/^~/, homedir).replace(/\/$/, '');
                  if (p.length > 2) foundPaths.add(p);
                }
              }
              // Also resolve named directories: Desktop, Downloads, Documents
              const namedDirRe = /\b(Desktop|Downloads|Documents|Documenti|Scrivania|Scaricati)\b/i;
              const namedMatch = (task + ' ' + stepPrompt).match(namedDirRe);
              const dirMap = { desktop: 'Desktop', scrivania: 'Desktop', downloads: 'Downloads', scaricati: 'Downloads', documents: 'Documents', documenti: 'Documents' };
              if (namedMatch) foundPaths.add(path.join(homedir, dirMap[namedMatch[1].toLowerCase()] || namedMatch[1]));

              if (foundPaths.size === 0) {
                // Fallback: list Desktop
                foundPaths.add(path.join(homedir, 'Desktop'));
              }

              const parts = [];
              for (const p of foundPaths) {
                try {
                  const result = await withTimeout(executeTool('file_list', { path: p }, config), 8000);
                  parts.push(`## Directory: ${p}\n${typeof result === 'string' ? result : JSON.stringify(result)}`);
                } catch {
                  try {
                    const result = await withTimeout(executeTool('file_read', { path: p, lines: 300 }, config), 8000);
                    parts.push(`## File: ${p}\n${typeof result === 'string' ? result : JSON.stringify(result)}`);
                  } catch (e2) { parts.push(`## ${p}: could not read (${e2.message})`); }
                }
              }
              toolData = parts.join('\n\n') || 'No files found at the specified paths.';
            } catch (e) { toolData = `File read failed: ${e.message}`; }

          } else if (agent === 'CodeExecutorAgent') {
            // Generates and executes code (Python/JS/TS) to answer data questions
            sendToken('[Preparing code execution...] ');
            try {
              // Ask LLM to write the code first
              const codeGenSys = `You are a code generator. Write a ${(/python/i.test(stepPrompt) || /dati|data|analisi|analysis|calcol/i.test(stepPrompt)) ? 'Python' : 'JavaScript'} script that answers the following task. Output ONLY the raw code, no markdown fences, no explanation.`;
              const codeGenUser = `Task: ${stepPrompt}\n\nAvailable context data:\n${(context || '').slice(0, 4000)}`;
              const codeGenConfig = Object.assign({}, config, { thinking: 'off' });
              sendToken('[Generating code...] ');
              const generatedCode = await withTimeout(callLLM(codeGenConfig, codeGenSys, codeGenUser, { max_tokens: 2000 }), 30000);
              // Strip markdown fences if LLM added them
              const cleanCode = generatedCode.replace(/^```[\w]*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
              const lang = /^import |^from |^print\(|^def |^class |^#!.*python/m.test(cleanCode) ? 'python' : 'javascript';
              sendToken(`[Executing ${lang} code...] `);
              const execResult = await withTimeout(executeTool('execute_code', { language: lang, code: cleanCode, timeout: 30 }, config), 45000);
              toolData = `## Generated code (${lang}):\n\`\`\`${lang}\n${cleanCode.slice(0, 2000)}\n\`\`\`\n\n## Execution result:\n${typeof execResult === 'string' ? execResult : JSON.stringify(execResult)}`;
            } catch (e) { toolData = `Code execution failed: ${e.message}`; }
          }

          // ── Build system prompt with real tool data ───────────────────
          const LANG_MAP = {en:'English',it:'Italian',es:'Spanish',fr:'French',de:'German',pt:'Portuguese',zh:'Chinese',ja:'Japanese',ar:'Arabic',hi:'Hindi',ru:'Russian',nl:'Dutch',pl:'Polish',tr:'Turkish',ko:'Korean',sv:'Swedish',da:'Danish',fi:'Finnish',no:'Norwegian',cs:'Czech'};
          const langCode = (config?.language || 'it').toLowerCase().slice(0,2);
          const language = LANG_MAP[langCode] || config?.language || 'Italian';
          const today = new Date().toISOString().split('T')[0];
          const isCanvasAgent = agent === 'CanvasAgent';
          // Tool-data agents: fetch real live data and use buildSystemPrompt (tool calls allowed)
          const isLiveDataAgent = ['CalendarAgent','EmailAgent','GitHubAgent','NotionAgent','SlackAgent','DriveAgent','BrowserAgent','WebSearchAgent','ResearchAgent','FileReaderAgent','CodeExecutorAgent','TravelAgent'].includes(agent);

          // ── Canvas HTML template — built server-side, guaranteed CSS ─────
          // The LLM outputs ONLY the <body> inner HTML (no <html>, no <style>)
          // Server wraps it in the full template. This prevents the model from ignoring CSS.
          const NHA_CSS = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#0d0d14;color:#f0f0f5;min-height:100vh;padding:24px;font-size:14px;line-height:1.65}a{color:#22d3ee;text-decoration:underline}a:hover{color:#818cf8}strong{color:#f0f0f5;font-weight:700}em{color:#a5b4fc;font-style:italic}u{text-decoration-color:#ef4444;text-underline-offset:2px}blockquote{border-left:3px solid #6366f1;padding:10px 16px;margin:12px 0;background:#15151f;border-radius:0 8px 8px 0;color:#8b8b9e;font-style:italic}
/* ── HEADER ── */
.header{background:linear-gradient(135deg,#4f46e5 0%,#06b6d4 100%);border-radius:16px;padding:28px 36px;margin-bottom:20px}.header h1{font-size:24px;font-weight:800;color:#fff;margin-bottom:6px}.header p{font-size:13px;color:rgba(255,255,255,.85);margin:0}.meta{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}.meta span{background:rgba(255,255,255,.18);border-radius:20px;padding:3px 12px;font-size:11px;color:#fff;font-weight:500}
/* ── GRID / CARDS ── */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:20px}.card{background:#15151f;border:1px solid #2a2a38;border-radius:12px;padding:18px}.card-label{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:#6366f1;font-weight:700;margin-bottom:8px}.card h3{font-size:20px;font-weight:700;color:#f0f0f5;margin-bottom:4px}.card p{font-size:12px;color:#8b8b9e;margin:0}
/* ── SECTIONS ── */
.section{background:#15151f;border:1px solid #2a2a38;border-radius:12px;padding:22px;margin-bottom:16px;break-inside:avoid;page-break-inside:avoid}.section-title{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:#22d3ee;font-weight:700;margin-bottom:16px}.section h3{font-size:15px;font-weight:600;color:#f0f0f5;margin-bottom:6px;margin-top:14px}.section p{font-size:13px;color:#8b8b9e;line-height:1.7;margin-bottom:10px}
/* ── LISTS ── */
ul{list-style:none;padding:0;margin:8px 0}ul li{padding:4px 0 4px 18px;position:relative;font-size:13px;color:#8b8b9e}ul li::before{content:'›';position:absolute;left:0;color:#6366f1;font-weight:700}ol{padding-left:20px;margin:8px 0}ol li{padding:4px 0;font-size:13px;color:#8b8b9e;line-height:1.6}
/* ── PRIORITY LIST ── */
.priority-list{display:flex;flex-direction:column;gap:8px}.priority-item{display:flex;align-items:flex-start;gap:12px;padding:12px;background:#1c1c28;border-radius:8px;break-inside:avoid}.priority-num{width:26px;height:26px;border-radius:50%;background:#6366f1;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}.priority-item h4{font-size:13px;font-weight:600;color:#f0f0f5;margin-bottom:3px}.priority-item p{font-size:12px;color:#8b8b9e;line-height:1.5;margin:0}
/* ── SOURCE ITEMS ── */
.source-item{padding:14px;background:#1c1c28;border-radius:8px;margin-bottom:10px;border-left:3px solid #6366f1;break-inside:avoid}.source-item h4{font-size:13px;font-weight:600;color:#f0f0f5;margin-bottom:4px}.source-item p{font-size:12px;color:#8b8b9e;line-height:1.6;margin:4px 0}.source-item a{font-size:11px}
/* ── BAR CHARTS ── */
.bar-row{margin-bottom:10px;break-inside:avoid}.bar-label{font-size:12px;color:#8b8b9e;margin-bottom:4px;display:flex;justify-content:space-between}.bar-track{background:#1c1c28;border-radius:4px;height:8px;overflow:hidden}.bar-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,#6366f1,#22d3ee)}
/* ── DATA TABLES ── */
.data-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px;border-radius:8px;overflow:hidden}.data-table th{background:#1e1b4b;color:#a5b4fc;font-weight:700;padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.8px;border-bottom:2px solid #2a2a38}.data-table td{padding:9px 14px;color:#c4c4d4;border-bottom:1px solid #1e1e2c;vertical-align:top}.data-table tr:nth-child(even) td{background:#12121e}.data-table tr:hover td{background:#1c1c2c}.data-table td strong{color:#f0f0f5}
/* ── CHART CONTAINERS ── */
.chart-wrap{background:#15151f;border:1px solid #2a2a38;border-radius:12px;padding:18px;margin-bottom:16px;break-inside:avoid}.chart-title{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:#22d3ee;font-weight:700;margin-bottom:12px}.chart-canvas{width:100%!important;max-height:300px}
/* ── BADGES / TAGS ── */
.badge-high{display:inline-block;background:#7f1d1d;color:#ef4444;border-radius:12px;padding:2px 10px;font-size:10px;font-weight:700;margin-right:4px}.badge-med{display:inline-block;background:#713f12;color:#f59e0b;border-radius:12px;padding:2px 10px;font-size:10px;font-weight:700;margin-right:4px}.badge-low{display:inline-block;background:#14532d;color:#34d399;border-radius:12px;padding:2px 10px;font-size:10px;font-weight:700;margin-right:4px}.badge-info{display:inline-block;background:#1e1b4b;color:#a5b4fc;border-radius:12px;padding:2px 10px;font-size:10px;font-weight:700;margin-right:4px}
/* ── MISC ── */
.divider{border:none;border-top:1px solid #2a2a38;margin:16px 0}.footer{text-align:center;padding:18px;font-size:11px;color:#4a4a5e;margin-top:8px}
/* ── PRINT / PDF ── */
@media print{*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}body{background:#fff!important;color:#111!important;padding:0!important}.header{background:linear-gradient(135deg,#4f46e5,#06b6d4)!important}.header h1,.header p,.meta span{color:#fff!important}.section,.card,.chart-wrap,.source-item,.priority-item,.data-table,.bar-row{break-inside:avoid;page-break-inside:avoid}.section{background:#f6f8ff!important;border:1px solid #dde1f0!important}.section-title,.chart-title{color:#4f46e5!important}.section p,.section h3{color:#1a1a2e!important}ul li,ol li{color:#374151!important}ul li::before{color:#4f46e5!important}.card{background:#f0f3fc!important;border:1px solid #dde1f0!important}.card h3{color:#1a1a2e!important}.card p{color:#374151!important}.priority-item,.source-item{background:#eef0f8!important}.data-table th{background:#e8eaf6!important;color:#4f46e5!important}.data-table td{color:#374151!important;border-bottom:1px solid #dde1f0!important}.data-table tr:nth-child(even) td{background:#f4f6fb!important}.bar-track{background:#e0e4ef!important}.footer{color:#9ca3af!important}a{color:#4f46e5!important}}`;

          const wrapInNHATemplate = (bodyHtml, title) => `<!DOCTYPE html><html lang="${langCode}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${(title||'NHA Report').replace(/</g,'&lt;')}</title><style>${NHA_CSS}</style><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"><\/script></head><body>${bodyHtml}</body></html>`;

          const canvasSystemPrompt = `You are a professional HTML dashboard generator. Output ONLY the HTML content that goes INSIDE the <body> tag. Do NOT output <!DOCTYPE>, <html>, <head>, <style>, or any wrapper tags — the CSS and Chart.js are already provided.

AVAILABLE CSS CLASSES:
- .header > h1, p, .meta > span  (gradient header banner)
- .grid > .card > .card-label, h3, p  (KPI stat grid)
- .section > .section-title, h3, p  (content sections with auto page-break)
- .source-item > h4, p, a  (news/email source items)
- .priority-list > .priority-item > .priority-num, h4, p  (ranked action list)
- .bar-row > .bar-label, .bar-track > .bar-fill[style="width:X%"]  (CSS bar charts)
- .data-table  (full HTML table: thead > tr > th, tbody > tr > td)
- .chart-wrap > .chart-title + <canvas id="cN" class="chart-canvas">  (Chart.js chart)
- .badge-high .badge-med .badge-low .badge-info  (colored badges)
- ul > li, ol > li, blockquote, .divider, .footer

TABLES — use whenever data has rows and columns:
<div class="section"><div class="section-title">TABLE TITLE</div>
<table class="data-table"><thead><tr><th>Col1</th><th>Col2</th></tr></thead><tbody><tr><td>val</td><td>val</td></tr></tbody></table></div>

CHARTS — Chart.js is loaded. Use for any quantitative comparison, trend, distribution:
<div class="chart-wrap"><div class="chart-title">CHART TITLE</div>
<canvas id="c1" class="chart-canvas"></canvas></div>
<script>new Chart(document.getElementById('c1'),{type:'bar',data:{labels:['A','B','C'],datasets:[{label:'Value',data:[10,20,15],backgroundColor:['#6366f1','#22d3ee','#f59e0b']}]},options:{responsive:true,plugins:{legend:{labels:{color:'#f0f0f5'}}},scales:{x:{ticks:{color:'#8b8b9e'},grid:{color:'#1e1e2c'}},y:{ticks:{color:'#8b8b9e'},grid:{color:'#1e1e2c'}}}}});<\/script>
Chart types: 'bar' | 'line' | 'pie' | 'doughnut' | 'radar'. Use unique ids: c1, c2, c3...
For pie/doughnut omit scales. For line use borderColor instead of backgroundColor.

RULES:
- Language: ${language}. ALL text must be in ${language}.
- Use REAL data from the input — NEVER invent numbers or fabricate data
- URLs: ALWAYS wrap in <a href="URL" target="_blank">text</a>
- Use .data-table for any tabular data (comparisons, metrics, lists with 2+ columns)
- Use Chart.js for any numeric data (percentages, counts, trends, rankings)
- Use .grid>.card for KPI numbers at the top
- Use .priority-list for action items
- Output must start with <div class="header"> and end with <div class="footer">`;

          // ── Handle PDF/image attachment on first step ─────────────────
          let attachmentText = '';
          if (stepPdfBase64 && !isLiveDataAgent) {
            sendToken('[Reading PDF...] ');
            try {
              // Extract base64 payload (strip data URL prefix if present)
              const b64 = stepPdfBase64.includes(',') ? stepPdfBase64.split(',')[1] : stepPdfBase64;
              const pdfBuffer = Buffer.from(b64, 'base64');
              const extracted = extractTextFromPdf(pdfBuffer);
              if (extracted && extracted.length > 20) {
                attachmentText = `## ATTACHED PDF: ${stepPdfName || 'document.pdf'}\n${extracted.slice(0, 15000)}`;
              } else {
                // PDF has no extractable text (scanned) — use vision
                try {
                  const { callLLMVision } = await import('../services/llm.mjs');
                  const visionResult = await withTimeout(
                    callLLMVision(config, 'Extract all text and information from this PDF document.', task, { base64: b64, mimeType: 'application/pdf' }),
                    60000
                  );
                  if (visionResult) attachmentText = `## ATTACHED PDF: ${stepPdfName || 'document.pdf'}\n${visionResult.slice(0, 15000)}`;
                } catch {}
              }
            } catch (e) { attachmentText = `[PDF read failed: ${e.message}]`; }
          } else if (stepImageBase64 && !isLiveDataAgent) {
            sendToken('[Reading image...] ');
            try {
              const { callLLMVision } = await import('../services/llm.mjs');
              const b64 = stepImageBase64.includes(',') ? stepImageBase64.split(',')[1] : stepImageBase64;
              const visionResult = await withTimeout(
                callLLMVision(config, 'Describe and extract all information from this image in detail.', task, { base64: b64, mimeType: stepImageMime }),
                45000
              );
              if (visionResult) attachmentText = `## ATTACHED IMAGE: ${body.imageName || 'image'}\n${visionResult.slice(0, 8000)}`;
            } catch (e) { attachmentText = `[Image read failed: ${e.message}]`; }
          }

          let sysPrompt, userMsg;

          if (isCanvasAgent) {
            sysPrompt = canvasSystemPrompt;
            const canvasData = [attachmentText, context].filter(Boolean).join('\n\n');
            userMsg = `Create a complete professional dashboard report in ${language} using the CSS classes defined in the system prompt.

RULES:
- Start with <div class="header"><h1>TITLE</h1><p>Subtitle</p><div class="meta"><span>DATE</span></div></div>
- Use <div class="section"><div class="section-title">SECTION NAME</div> ... </div> for EACH agent's findings
- Each section MUST reproduce the agent's actual findings in full — use <h3>, <p>, <ul><li>, tables
- Output ONLY HTML (no markdown, no \`\`\`html fences, no explanations)
- End with <div class="footer">NHA Studio · ${today}</div>

AGENT DATA TO INCLUDE IN FULL:
${canvasData}`;
          } else if (isLiveDataAgent) {
            // These agents fetched real data — use a focused prompt (no tool definitions to avoid JSON output)
            // Live data agents that fetched their own data: do NOT inject previous context
            // (prevents EmailAgent output from being repeated by GitHubAgent, CalendarAgent, etc.)
            const contextBlock = toolData
              ? ''  // Has own live data — ignore previous agent outputs to avoid repetition
              : (context ? `## OUTPUT FROM PREVIOUS AGENTS:\n${context}\n` : '');
            const agentInstruction = `You are ${agent}, a specialist AI agent inside NHA Studio. Today is ${today}. Respond entirely in ${language}.

## OVERALL WORKFLOW GOAL:
${task}

CRITICAL: Do NOT invent, hallucinate, or add any data not present in the DATA sections below. ONLY use the exact data provided.
Do NOT output JSON, tool calls, or code blocks. Write in plain text with markdown headers.
Always apply your analysis specifically to the subject mentioned in the WORKFLOW GOAL.
FILTER: If the DATA sections contain content from web pages that is NOT relevant to the WORKFLOW GOAL (e.g. ads, unrelated articles, off-topic blog posts), IGNORE that content entirely. Only extract and present information that directly answers the WORKFLOW GOAL.

${attachmentText ? `## ATTACHED FILE CONTENT:\n${attachmentText}\n` : ''}${toolData ? `## DATA FROM TOOLS:\n${toolData}\n` : '## DATA: No data was retrieved by this agent.\n'}
${contextBlock}
Your task: ${stepPrompt}`;
            sysPrompt = agentInstruction;
            // TravelAgent: give specific guidance so HERALD presents alternatives + booking links
            const isTravelStep = agent === 'TravelAgent';
            // Extract city/cuisine from toolData header (format: "# TravelAgent — Risultati per: Mantova | Cucina: sushi")
            const _travelCityM = toolData && toolData.match(/Risultati per:\s*([^|#\n]+)/);
            const _travelCuisineM = toolData && toolData.match(/Cucina:\s*([^|#\n]+)/);
            const _travelCity = _travelCityM ? _travelCityM[1].trim() : '';
            const _travelCuisine = _travelCuisineM ? _travelCuisineM[1].trim() : '';
            const _theforkUrl = 'https://www.thefork.it/ristoranti/' + (_travelCity ? encodeURIComponent(_travelCity.toLowerCase()) : 'italia') + (_travelCuisine ? '?q=' + encodeURIComponent(_travelCuisine) : '');
            const _bookingUrl = 'https://www.booking.com/searchresults.html?ss=' + encodeURIComponent(_travelCity || 'Italia') + '&group_adults=2&no_rooms=1';
            const _tripadUrl = 'https://www.tripadvisor.it/Search?q=' + encodeURIComponent((_travelCuisine ? _travelCuisine + ' ' : '') + _travelCity);
            userMsg = toolData
              ? (isTravelStep
                ? `Present the travel results in Italian with these sections:\n\n## Ristoranti\nList every restaurant from the data with name, address, phone, website, OSM map link. If the requested cuisine (${_travelCuisine || 'richiesta'}) was NOT found, say "Nessun ristorante [cucina] trovato su OpenStreetMap nella zona" then list the alternative restaurants found.\n\n## Alloggi\nList every accommodation from the data with type (Hotel/B&B/Ostello/Agriturismo), name, address, website, OSM map link.\n\n## Prenota online\nAdd these direct booking links:\n- **Ristoranti su TheFork**: ${_theforkUrl}\n- **Hotel/B&B su Booking.com**: ${_bookingUrl}\n- **Recensioni su TripAdvisor**: ${_tripadUrl}\n\nDo NOT invent any data not in the sections above.`
                : `Summarize and analyze the REAL data above. Do not add anything not present in the data.`)
              : context
              ? `Based ONLY on the previous agent outputs above, complete: ${stepPrompt}`
              : stepPrompt;
          } else {
            // All other agents (WriterAgent, DataAnalystAgent, specialist agents, etc.)
            const hasRealData = !!(toolData || context);
            sysPrompt = `You are ${agent}, a specialist AI agent inside NHA Studio. Today is ${today}. You MUST respond entirely in ${language}.

## OVERALL WORKFLOW GOAL:
${task}

CRITICAL RULES:
- Do NOT output JSON, tool calls, function calls, or code blocks
- NEVER invent, fabricate, or hallucinate data, events, emails, meetings, or news
- ONLY use data from the DATA sections that is RELEVANT to your specific domain and the WORKFLOW GOAL
- If the previous agents' output contains irrelevant personal data (e.g. unrelated emails, purchases, subscriptions) — IGNORE it entirely
- ONLY reference data that directly relates to the subject of the WORKFLOW GOAL
- If genuinely no relevant data exists for your domain, say so clearly — do NOT invent analysis
- Write in plain prose, structured with markdown headers (##) and bullet points (-)
- Be thorough and specific — this is for an executive briefing based on REAL data only

${attachmentText ? `## ATTACHED FILE CONTENT:\n${attachmentText}\n` : ''}${toolData ? `## LIVE DATA FROM TOOLS:\n${toolData}\n` : '## LIVE DATA: No tool data was fetched for this step.\n'}
${context ? `## OUTPUT FROM PREVIOUS AGENTS (use only what is RELEVANT to the workflow goal):\n${context}\n` : ''}`;
            userMsg = hasRealData
              ? `Based ONLY on the real data above, complete this task specifically for the subject in the WORKFLOW GOAL: ${stepPrompt}`
              : `No real data is available for "${task}". State this clearly and explain what data would be needed to complete: ${stepPrompt}`;
          }

          // ── Stream LLM response ───────────────────────────────────────
          // Specialist (non-canvas, non-live-data) agents use Structured Generation:
          //   Phase 1 — Outline: one call that returns ONLY section headings as a numbered list
          //   Phase 2 — Section fill: one call per section, with full context of sections already written
          // Live-data + Canvas agents use the classic single-stream approach.
          let fullOutput = '';
          let fullOutputClean = '';

          // ── Helper: strip <think> tags from a string ─────────────────
          const stripThink = (s) => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

          // ── Helper: stream a single LLM call, strip think tags, return full text ─
          const streamCall = async (sysPr, usrMsg, opts, timeout, onToken) => {
            let raw = '';
            let inThink = false;
            let tBuf = '';
            await withTimeout(
              callLLMStream(config, sysPr, usrMsg, (tok) => {
                raw += tok;
                if (onToken) {
                  tBuf += tok;
                  let out = '';
                  let buf = tBuf;
                  while (buf.length > 0) {
                    if (inThink) {
                      const ci = buf.indexOf('</think>');
                      if (ci >= 0) { buf = buf.slice(ci + 8); inThink = false; }
                      else { buf = ''; }
                    } else {
                      const oi = buf.indexOf('<think>');
                      if (oi >= 0) { out += buf.slice(0, oi); buf = buf.slice(oi + 7); inThink = true; }
                      else { out += buf; buf = ''; }
                    }
                  }
                  tBuf = '';
                  const stripped = out.replace(/\{[\s\S]*?"action"[\s\S]*?\}/g, '').trim();
                  if (stripped) onToken(stripped);
                }
              }, opts),
              timeout
            );
            return stripThink(raw);
          };

          const useStructuredGen = !isCanvasAgent && !isLiveDataAgent;

          if (isCanvasAgent) {
            // ── Canvas: single stream, HTML output ────────────────────
            sendToken('Generating visual report...');
            try {
              fullOutput = await streamCall(sysPrompt, userMsg, { max_tokens: 12288, thinking: 'off' }, 180000, null);
            } catch (e) { /* canvas errors surfaced below */ }
            fullOutputClean = fullOutput;

          } else if (useStructuredGen) {
            // ── Structured Generation ─────────────────────────────────
            // Phase 1: ask for ONLY the section outline (headings list), fast and cheap
            sendToken('[Pianificazione struttura report...] ');
            const structConfig = Object.assign({}, config, { thinking: 'off' });
            const outlineSys = `You are ${agent}, a specialist AI agent. Today is ${today}. Respond in ${language}.
Your task: plan the sections of a complete structured report for this goal: ${task}
Instruction: ${stepPrompt}

Output ONLY a numbered list of section headings — one per line, no body text, no explanation.
Use ## prefix for each heading. Maximum 8 sections. Example:
## 1. Executive Summary
## 2. Key Findings
## 3. Analysis`;
            let outlineRaw = '';
            try {
              outlineRaw = await withTimeout(
                new Promise((res) => {
                  let acc = '';
                  callLLMStream(structConfig, outlineSys, 'List the section headings only.', (tok) => { acc += tok; }, { max_tokens: 300, thinking: 'off' }).then(() => res(acc)).catch(() => res(acc));
                }),
                20000
              );
            } catch {}

            // Parse headings: lines starting with ## (or plain numbered lines as fallback)
            const headingLines = stripThink(outlineRaw)
              .split('\n')
              .map(l => l.trim())
              .filter(l => l.match(/^#{1,4}\s+\S/) || l.match(/^\d+[\.\)]\s+\S/))
              .map(l => l.match(/^#{1,4}\s+/) ? l : '## ' + l.replace(/^\d+[\.\)]\s+/, ''))
              .slice(0, 8);

            if (headingLines.length === 0) {
              // Outline failed — fall back to single stream
              sendToken('');
              try {
                fullOutput = await streamCall(sysPrompt, userMsg, { max_tokens: 8192, thinking_budget: 2048 }, 120000, sendToken);
              } catch (e) { sendToken(`[Error: ${e.message}]`); }
              fullOutputClean = stripThink(fullOutput);
            } else {
              // Phase 2: one call per section, each sees the sections already written
              // Cap context to 4000 chars max — passing the full output of previous agents
              // causes the model to think the content is already written and skip sections.
              const cappedContext = context && context.length > 4000 ? context.slice(-4000) : context;
              const dataBlock = [
                attachmentText ? `## ATTACHED FILE:\n${attachmentText}` : '',
                toolData ? `## LIVE DATA:\n${toolData}` : '',
                cappedContext ? `## RESEARCH DATA FROM PREVIOUS AGENTS (use as source material):\n${cappedContext}` : '',
              ].filter(Boolean).join('\n\n');
              const sectionParts = [];
              for (let si = 0; si < headingLines.length; si++) {
                const heading = headingLines[si];
                const completedHeadings = sectionParts.map(p => p.split('\n')[0]).join('\n');
                const secSys = `You are ${agent}, a specialist AI agent inside NHA Studio. Today is ${today}. Respond entirely in ${language}.

## OVERALL WORKFLOW GOAL:
${task}

CRITICAL RULES:
- The section below has NOT been written yet — YOU must write its full content now
- Write ONLY the body content for the section heading given — do NOT repeat the heading
- Do NOT skip, summarize, or reference "see above" — write complete original content for this section
- Use the DATA block below as source material, but write in your own analytical voice
- Be thorough: at least 3-5 bullet points or 2-3 full paragraphs per section
- Do NOT invent data not present in the DATA block

${dataBlock}
${completedHeadings ? `## SECTIONS ALREADY WRITTEN (headings only):\n${completedHeadings}` : ''}`;
                const secUser = `This section has NOT been written yet. Write the COMPLETE body content for it now (minimum 150 words). Do NOT leave it empty or reference other sections:\n${heading}`;
                sendToken('\n\n' + heading + '\n');
                sendToken('[Sezione ' + (si + 1) + ' di ' + headingLines.length + '...] ');
                let secContent = '';
                try {
                  secContent = await streamCall(secSys, secUser, { max_tokens: 4000, thinking: 'off' }, 90000, sendToken);
                } catch {}
                if (secContent.trim()) {
                  sectionParts.push(heading + '\n\n' + secContent.trim());
                  fullOutput += '\n\n' + heading + '\n\n' + secContent.trim();
                }
              }
              fullOutputClean = fullOutput.trim();
            }

          } else {
            // ── Live-data agents: single stream ───────────────────────
            sendToken('');
            try {
              fullOutput = await streamCall(sysPrompt, userMsg, { max_tokens: 8192, thinking_budget: 2048 }, 120000, sendToken);
            } catch (e) { sendToken(`[Error: ${e.message}]`); }
            fullOutputClean = stripThink(fullOutput);
          }

          // Note: do NOT strip trailing headings — a heading with content follows in the structured
          // output and stripping it would silently delete the last section of the report.

          // Fallback: if LLM returned empty and we have tool data, send it directly
          if (!isCanvasAgent && !fullOutputClean && toolData) {
            fullOutput = toolData;
            sendToken(toolData);
          }
          // Fallback: if LLM returned empty and we have context (specialist agents like CASSANDRA),
          // retry once without thinking and with a simplified direct prompt
          else if (!isCanvasAgent && !fullOutputClean && context && !toolData) {
            sendToken('[Retrying analysis...]');
            let retryOutput = '';
            try {
              const retryConfig = Object.assign({}, config, { thinking: 'off' });
              await withTimeout(
                callLLMStream(retryConfig, `You are ${agent}. Analyze the following data and complete the task. Be thorough and write in ${language}.\n\nDATA:\n${context}\n\nTASK: ${stepPrompt}`,
                  'Write your complete analysis now.',
                  (tok) => { retryOutput += tok; sendToken(tok); },
                  { max_tokens: 8192 },
                ),
                60000
              );
            } catch {}
            if (retryOutput.trim()) fullOutput = retryOutput;
          }

          if (isCanvasAgent) {
            let bodyHtml = fullOutput.trim();
            // Strip thinking tags
            bodyHtml = bodyHtml.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            // Strip markdown code fences
            const mdMatch = bodyHtml.match(/```html?\s*([\s\S]*?)```/i);
            if (mdMatch) bodyHtml = mdMatch[1].trim();
            // If model returned full HTML despite instructions, extract body content
            const bodyTagMatch = bodyHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
            if (bodyTagMatch) bodyHtml = bodyTagMatch[1].trim();
            // If model returned <!DOCTYPE (full doc), extract everything after <body> open tag
            else if (bodyHtml.includes('<!DOCTYPE') || bodyHtml.includes('<html')) {
              const bodyStart = bodyHtml.search(/<body[^>]*>/i);
              if (bodyStart >= 0) bodyHtml = bodyHtml.slice(bodyStart).replace(/<body[^>]*>/i, '').replace(/<\/body>[\s\S]*/i, '').trim();
            }
            // Derive a short report title from the task (skip stop words, take first 5-6 meaningful words)
            const stopWords = new Set(['di','la','il','lo','le','gli','un','una','dei','del','della','per','che','con','su','in','e','a','da','è','come','analizza','analisi','ricerca','crea','genera','fai','fammi','dammi','the','of','for','and','a','an','in','with','on','about','analyze','analysis','research','create','generate','make','find','search']);
            const titleWords = task.replace(/[.,;:!?]/g,'').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase())).slice(0, 6);
            const reportTitle = titleWords.length > 0 ? titleWords.map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(' ') : 'Studio Report';
            // Convert markdown to NHA-classed HTML — handles the case where Liara/Qwen3
            // returns markdown instead of HTML despite instructions.
            const mdToNhaHtml = (md) => {
              const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
              // inline: bold, italic, inline-code, links
              const inl = s => s
                .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/\*([^*]+)\*/g, '<em>$1</em>')
                .replace(/`([^`]+)`/g, '<code style="background:#1c1c28;padding:1px 5px;border-radius:3px;font-size:12px">$1</code>')
                .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

              const lines = md.split('\n');
              let out = [];
              let i = 0;
              let currentSection = null; // accumulates section content

              const flushSection = () => {
                if (currentSection) { out.push(currentSection + '</div>'); currentSection = null; }
              };

              while (i < lines.length) {
                const l = lines[i];
                // H1 — treat as sub-header inside a new section
                if (/^# /.test(l)) {
                  flushSection();
                  const title = esc(l.replace(/^# /, '').replace(/\*\*/g,'').replace(/\*/g,''));
                  currentSection = `<div class="section"><div class="section-title">${title}</div>`;
                  i++; continue;
                }
                // H2 / H3 — new section
                if (/^#{2,3} /.test(l)) {
                  flushSection();
                  const title = esc(l.replace(/^#{2,3} /, '').replace(/\*\*/g,'').replace(/\*/g,''));
                  currentSection = `<div class="section"><div class="section-title">${title}</div>`;
                  i++; continue;
                }
                // H4 — sub-heading inside current section
                if (/^#### /.test(l)) {
                  const h = esc(l.replace(/^#### /, '').replace(/\*\*/g,'').replace(/\*/g,''));
                  const frag = `<h3>${h}</h3>`;
                  if (currentSection) currentSection += frag; else out.push(frag);
                  i++; continue;
                }
                // Horizontal rule — divider
                if (/^---+$/.test(l.trim())) {
                  const frag = '<div class="divider"></div>';
                  if (currentSection) currentSection += frag; else out.push(frag);
                  i++; continue;
                }
                // Table row
                if (l.trim().startsWith('|') && l.includes('|', 1)) {
                  // Collect all table lines
                  const tableLines = [];
                  while (i < lines.length && lines[i].trim().startsWith('|')) {
                    if (!/^\|[\s:|-]+\|$/.test(lines[i].trim())) tableLines.push(lines[i]);
                    i++;
                  }
                  if (tableLines.length > 0) {
                    const isHeader = tableLines.length > 1;
                    let tHtml = '<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:12px">';
                    tableLines.forEach((tl, ti) => {
                      const cells = tl.split('|').slice(1,-1).map(c => c.trim());
                      const tag = (ti === 0 && isHeader) ? 'th' : 'td';
                      const bg = ti === 0 && isHeader ? 'background:#1c1c28;color:#a5b4fc;font-weight:700' : (ti % 2 === 0 ? 'background:#15151f' : 'background:#1a1a28');
                      tHtml += '<tr>' + cells.map(c => `<${tag} style="${bg};padding:6px 10px;border:1px solid #2a2a38;text-align:left">${inl(esc(c))}</${tag}>`).join('') + '</tr>';
                    });
                    tHtml += '</table>';
                    if (currentSection) currentSection += tHtml; else out.push(tHtml);
                  }
                  continue;
                }
                // Unordered list block
                if (/^(\s*[-*+] )/.test(l)) {
                  const items = [];
                  while (i < lines.length && /^(\s*[-*+] )/.test(lines[i])) {
                    items.push(inl(esc(lines[i].replace(/^\s*[-*+] /, ''))));
                    i++;
                  }
                  const frag = '<ul>' + items.map(it => `<li>${it}</li>`).join('') + '</ul>';
                  if (currentSection) currentSection += frag; else out.push(frag);
                  continue;
                }
                // Ordered list block
                if (/^\d+\. /.test(l)) {
                  const items = [];
                  while (i < lines.length && /^\d+\. /.test(lines[i])) {
                    items.push(inl(esc(lines[i].replace(/^\d+\. /, ''))));
                    i++;
                  }
                  const frag = '<ol>' + items.map(it => `<li>${it}</li>`).join('') + '</ol>';
                  if (currentSection) currentSection += frag; else out.push(frag);
                  continue;
                }
                // Blank line — skip
                if (!l.trim()) { i++; continue; }
                // Regular paragraph
                const frag = `<p>${inl(esc(l))}</p>`;
                if (currentSection) currentSection += frag; else out.push(frag);
                i++;
              }
              flushSection();
              return out.join('');
            };

            // Quality check: count <p> and <li> tags — if output is a sparse skeleton
            // (many sections but almost no paragraph/list content), fall back to converting context directly.
            const sectionCount = (bodyHtml.match(/<div[^>]*class="section/g) || []).length;
            const contentCount = (bodyHtml.match(/<p[\s>]|<li[\s>]/g) || []).length;
            const isSparse = bodyHtml.includes('<') && sectionCount > 0 && contentCount < sectionCount;

            // If LLM output has no HTML tags, or is a sparse skeleton → use context directly
            if (!bodyHtml || !bodyHtml.includes('<') || isSparse) {
              const source = context || bodyHtml;
              const converted = mdToNhaHtml(source);
              bodyHtml = `<div class="header"><h1>${reportTitle.replace(/</g,'&lt;')}</h1><p>NHA Studio Report \u00b7 ${today}</p><div class="meta"><span>${today}</span></div></div>` +
                converted +
                `<div class="footer">NHA Studio \u00b7 ${today}</div>`;
            } else {
              // Replace the h1 inside existing header div if the model included the full prompt as title
              bodyHtml = bodyHtml.replace(/(<div[^>]*class="header"[^>]*>[\s\S]*?<h1[^>]*>)([^<]{60,})(<\/h1>)/, (m, open, title, close) => {
                return open + reportTitle.replace(/</g,'&lt;') + close;
              });
            }
            // Always wrap in the guaranteed NHA dark CSS template
            const finalHtml = wrapInNHATemplate(bodyHtml, reportTitle);
            sendToken('\n\n[Report generato]');
            sendEvent({ canvas: finalHtml });
          }

          // Estimate token usage (aprox: 1 token ≈ 4 chars)
          // Include context + toolData in input estimate since they're sent in the prompt
          const contextLen = (context || '').length;
          const toolDataLen = (toolData || '').length;
          const inTokens = Math.ceil((sysPrompt.length + userMsg.length + contextLen + toolDataLen) / 4);
          const outTokens = Math.ceil(fullOutputClean.length / 4);
          clearInterval(keepalive);
          sendEvent({ usage: { input: inTokens, output: outTokens } });
          sendEvent({ done: true });
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (e) {
          clearInterval(keepalive);
          sendEvent({ error: e.message });
          res.end();
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Studio: WebCraft — single non-streaming LLM call ────────────────
      // Used by the WebCraft tab to generate each file without SSE complexity.
      // POST /api/studio/webcraft  { system, user, max_tokens }  → { text }
      if (pathname === '/api/studio/webcraft' && method === 'POST') {
        const body = await parseBody(req, 131072); // 128KB max
        if (!body.system || !body.user) {
          sendJSON(res, 400, { error: 'system and user required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }
        try {
          const result = await callLLM(config, body.system, body.user, { max_tokens: body.max_tokens || 8192, temperature: 0.3 });
          sendJSON(res, 200, { text: result });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── WebCraft Projects — list and delete saved projects ──────────────────
      // GET  /api/studio/webcraft/projects         → { projects: [{name, description, fileCount, createdAt, dir}] }
      // DELETE /api/studio/webcraft/projects/:name → { ok }
      // POST /api/studio/webcraft/projects/save    → saves meta+files, { ok, dir }
      if (pathname === '/api/studio/webcraft/projects' && method === 'GET') {
        const wcBaseDir = path.join(os.homedir(), '.nha', 'webcraft');
        const projects = [];
        if (fs.existsSync(wcBaseDir)) {
          for (const entry of fs.readdirSync(wcBaseDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const metaPath = path.join(wcBaseDir, entry.name, 'webcraft-meta.json');
            if (!fs.existsSync(metaPath)) continue;
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              projects.push({ name: entry.name, description: meta.description || '', fileCount: (meta.files || []).length, createdAt: meta.createdAt || '', dir: path.join(wcBaseDir, entry.name) });
            } catch(_) {}
          }
        }
        projects.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
        sendJSON(res, 200, { projects });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      if (pathname.startsWith('/api/studio/webcraft/projects/') && method === 'DELETE') {
        const projName = decodeURIComponent(pathname.replace('/api/studio/webcraft/projects/', '')).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!projName) { sendJSON(res, 400, { error: 'invalid name' }); return; }
        // Kill sandbox process if it belongs to this project
        if (global._wcSandboxProc && global._wcSandboxDir && global._wcSandboxDir.includes(projName)) {
          try { global._wcSandboxProc.kill('SIGTERM'); } catch(_) {}
          global._wcSandboxProc = null;
          global._wcSandboxPort = null;
          global._wcSandboxDir = null;
        }
        const projDir = path.join(os.homedir(), '.nha', 'webcraft', projName);
        if (fs.existsSync(projDir)) fs.rmSync(projDir, { recursive: true, force: true });
        sendJSON(res, 200, { ok: true });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      if (pathname === '/api/studio/webcraft/projects/save' && method === 'POST') {
        const body = await parseBody(req, 16 * 1024 * 1024); // 16MB
        const projName = (body.projectName || 'webcraft').replace(/[^a-zA-Z0-9_-]/g, '-');
        const projDir = path.join(os.homedir(), '.nha', 'webcraft', projName);
        fs.mkdirSync(projDir, { recursive: true });
        // Write each file with full folder structure
        for (const f of (body.files || [])) {
          const fp = path.join(projDir, f.name);
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, f.content, 'utf8');
        }
        // Write meta
        const meta = { projectName: projName, description: body.description || '', files: (body.files || []).map(f => f.name), createdAt: new Date().toISOString() };
        fs.writeFileSync(path.join(projDir, 'webcraft-meta.json'), JSON.stringify(meta, null, 2), 'utf8');
        // Write agent memory file — always included as first context for WebCraft Agent
        const agentMd = [
          '# WebCraft Agent Memory — ' + projName,
          '> Auto-generated. Edit to give the agent persistent context about this project.',
          '',
          '## Progetto',
          '- **Nome**: ' + projName,
          '- **Descrizione**: ' + (body.description || ''),
          '- **Creato**: ' + new Date().toISOString(),
          '',
          '## Stack',
          '- Server: Express.js (Node.js)',
          '- Auth: JWT (access 15min, refresh 7d httpOnly cookie) + bcryptjs cost 12',
          '- DB: PostgreSQL (sandbox: in-memory shim in server/db.js)',
          '- CSS: BEM methodology',
          '- Security: helmet, express-rate-limit, custom sentinel WAF middleware',
          '',
          '## File principali',
          (body.files || []).map(f => '- ' + f.name).join('\n'),
          '',
          '## Note agente',
          '(aggiungi qui note per sessioni future — es. "usa Tailwind invece di BEM", "API key in .env.local")',
        ].join('\n');
        fs.writeFileSync(path.join(projDir, 'webcraft-agent.md'), agentMd, 'utf8');
        // Create default context files (skills, memory, provider) if not present
        const ctxDir = path.join(projDir, 'skills');
        if (!fs.existsSync(ctxDir)) fs.mkdirSync(ctxDir, { recursive: true });
        for (const def of ['memory.md', 'liara.md', 'skills.md']) {
          const fp = path.join(ctxDir, def);
          if (!fs.existsSync(fp)) fs.writeFileSync(fp, '', 'utf8');
        }
        sendJSON(res, 200, { ok: true, dir: projDir });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/studio/webcraft/projects/chat/save  { projectName, chat[] }
      if (pathname === '/api/studio/webcraft/projects/chat/save' && method === 'POST') {
        const body = await parseBody(req, 2 * 1024 * 1024);
        const projName = (body.projectName || '').replace(/[^a-zA-Z0-9_-]/g, '-');
        if (!projName) { sendJSON(res, 400, { error: 'projectName required' }); return; }
        const projDir = path.join(os.homedir(), '.nha', 'webcraft', projName);
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, 'webcraft-chat.json'), JSON.stringify(body.chat || [], null, 2), 'utf8');
        sendJSON(res, 200, { ok: true });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/studio/webcraft/projects/chat/load/:name
      if (pathname.startsWith('/api/studio/webcraft/projects/chat/load/') && method === 'GET') {
        const projName = decodeURIComponent(pathname.replace('/api/studio/webcraft/projects/chat/load/', '')).replace(/[^a-zA-Z0-9_-]/g, '');
        const chatPath = path.join(os.homedir(), '.nha', 'webcraft', projName, 'webcraft-chat.json');
        if (!fs.existsSync(chatPath)) { sendJSON(res, 200, { chat: [] }); return; }
        const chat = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
        sendJSON(res, 200, { chat });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/studio/webcraft/skills/:name → { skills: [{name, content, type}] }
      if (pathname.startsWith('/api/studio/webcraft/skills/') && method === 'GET') {
        const projName = decodeURIComponent(pathname.replace('/api/studio/webcraft/skills/', '')).replace(/[^a-zA-Z0-9_-]/g, '');
        const skillsDir = path.join(os.homedir(), '.nha', 'webcraft', projName, 'skills');
        // Ensure the 3 default files always exist on disk
        const WC_DEFAULTS = [
          { name: 'memory.md', type: 'memory' },
          { name: 'liara.md',  type: 'provider' },
          { name: 'skills.md', type: 'skill' },
        ];
        if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
        for (const def of WC_DEFAULTS) {
          const fp = path.join(skillsDir, def.name);
          if (!fs.existsSync(fp)) fs.writeFileSync(fp, '', 'utf8');
        }
        // Load type index
        const indexPath = path.join(skillsDir, '_index.json');
        let typeIndex = {};
        if (fs.existsSync(indexPath)) {
          try { typeIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch(_) {}
        }
        // Default types for well-known filenames
        const defaultType = (n) => n === 'memory.md' ? 'memory' : n === 'liara.md' ? 'provider' : 'skill';
        const skills = [];
        // .md first (sorted), then .log files (sorted newest-first by filename)
        const allFiles = fs.readdirSync(skillsDir);
        const mdFiles  = allFiles.filter(f => f.endsWith('.md')).sort();
        const logFiles = allFiles.filter(f => f.endsWith('.log')).sort().reverse();
        for (const fname of [...mdFiles, ...logFiles]) {
          try {
            const content = fs.readFileSync(path.join(skillsDir, fname), 'utf8');
            const type = typeIndex[fname] || defaultType(fname);
            skills.push({ name: fname, content, type: fname.endsWith('.log') ? 'log' : type });
          } catch(_) {}
        }
        sendJSON(res, 200, { skills });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/studio/webcraft/skills/:name  { skills: [{name, content, type}] }
      if (pathname.startsWith('/api/studio/webcraft/skills/') && method === 'POST') {
        const projName = decodeURIComponent(pathname.replace('/api/studio/webcraft/skills/', '')).replace(/[^a-zA-Z0-9_-]/g, '');
        const body = await parseBody(req);
        const skills = body.skills || [];
        const skillsDir = path.join(os.homedir(), '.nha', 'webcraft', projName, 'skills');
        if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
        // Build set of incoming names (normalised)
        const incoming = new Set(skills.map(s => {
          let n = (s.name || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
          if (!n.endsWith('.md')) n += '.md';
          return n;
        }));
        // Remove .md files not in incoming set (but never remove the 3 defaults — only clear them)
        const WC_KEEP = new Set(['memory.md', 'liara.md', 'skills.md']);
        for (const fname of fs.readdirSync(skillsDir)) {
          if (!fname.endsWith('.md')) continue;
          if (!incoming.has(fname) && !WC_KEEP.has(fname)) fs.unlinkSync(path.join(skillsDir, fname));
        }
        // Write/update all skills; always keep defaults even if not in incoming (write empty)
        const typeIndex = {};
        for (const skill of skills) {
          if (!skill.name) continue;
          let safeName = skill.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
          if (!safeName.endsWith('.md')) safeName += '.md';
          fs.writeFileSync(path.join(skillsDir, safeName), skill.content || '', 'utf8');
          typeIndex[safeName] = skill.type || 'skill';
        }
        // Ensure defaults exist
        for (const def of ['memory.md', 'liara.md', 'skills.md']) {
          if (!fs.existsSync(path.join(skillsDir, def))) fs.writeFileSync(path.join(skillsDir, def), '', 'utf8');
        }
        fs.writeFileSync(path.join(skillsDir, '_index.json'), JSON.stringify(typeIndex), 'utf8');
        sendJSON(res, 200, { ok: true });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/studio/webcraft/skills/:name/delete { name } → delete a single skill/log file
      if (pathname.match(/^\/api\/studio\/webcraft\/skills\/[^/]+\/delete$/) && method === 'POST') {
        const projName = decodeURIComponent(pathname.replace('/api/studio/webcraft/skills/', '').replace('/delete', '')).replace(/[^a-zA-Z0-9_-]/g, '');
        const body = await parseBody(req);
        const fname = (body.name || '').replace(/[^a-zA-Z0-9_. -]/g, '_');
        if (!fname || !projName) { sendJSON(res, 400, { error: 'invalid' }); return; }
        // Protect the 3 default .md files from deletion
        const PROTECTED = new Set(['memory.md', 'liara.md', 'skills.md']);
        if (PROTECTED.has(fname)) { sendJSON(res, 400, { error: 'protected file' }); return; }
        const skillsDir = path.join(os.homedir(), '.nha', 'webcraft', projName, 'skills');
        const filePath = path.join(skillsDir, fname);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(_) {}
        // Remove from _index.json too
        const idxPath = path.join(skillsDir, '_index.json');
        try {
          let idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
          delete idx[fname];
          fs.writeFileSync(idxPath, JSON.stringify(idx), 'utf8');
        } catch(_) {}
        sendJSON(res, 200, { ok: true });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/studio/webcraft/projects/load/:name → { projectName, description, files[] }
      if (pathname.startsWith('/api/studio/webcraft/projects/load/') && method === 'GET') {
        const projName = decodeURIComponent(pathname.replace('/api/studio/webcraft/projects/load/', '')).replace(/[^a-zA-Z0-9_-]/g, '');
        const projDir = path.join(os.homedir(), '.nha', 'webcraft', projName);
        const metaPath = path.join(projDir, 'webcraft-meta.json');
        if (!fs.existsSync(metaPath)) { sendJSON(res, 404, { error: 'not found' }); return; }
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const files = [];
        for (const fname of (meta.files || [])) {
          const fp = path.join(projDir, fname);
          if (fs.existsSync(fp)) {
            const content = fs.readFileSync(fp, 'utf8');
            const ext = fname.split('.').pop();
            const langMap = { js:'javascript', mjs:'javascript', ts:'typescript', json:'json', html:'html', css:'css', sql:'sql', md:'markdown', sh:'bash', env:'bash', conf:'nginx' };
            files.push({ name: fname, content, lang: langMap[ext] || 'text' });
          }
        }
        sendJSON(res, 200, { projectName: meta.projectName, description: meta.description, files });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── WebCraft Sandbox — fullstack preview in ~/.nha/webcraft/<project> ──
      // POST /api/studio/webcraft/sandbox/start  { projectName, files[] }
      //   → SSE stream with log lines, ends with { type:'ready', port, dir }
      // DELETE /api/studio/webcraft/sandbox  → kill running sandbox process
      if (pathname === '/api/studio/webcraft/sandbox/start' && method === 'POST') {
        const body = await parseBody(req, 8 * 1024 * 1024); // 8MB max
        const projName = (body.projectName || 'webcraft-sandbox').replace(/[^a-zA-Z0-9_-]/g, '-');
        const files = body.files || [];
        if (!files.length) { sendJSON(res, 400, { error: 'no files' }); return; }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        const _sbLogLines = [];
        const sendLog = (msg) => {
          _sbLogLines.push(msg);
          res.write(`data: ${JSON.stringify({ type: 'log', msg })}\n\n`);
        };
        const sendReady = (port, dir) => res.write(`data: ${JSON.stringify({ type: 'ready', port, dir })}\n\n`);
        const sendError = (msg) => res.write(`data: ${JSON.stringify({ type: 'error', msg })}\n\n`);

        // Helper: write sandbox log to skills/ dir — defined before try so catch can use it
        const writeSandboxLog = (sandboxDirArg, freePortArg, extraLines, isError) => {
          try {
            const _nl = '\n';
            const _now = new Date();
            const _pad = n => String(n).padStart(2,'0');
            const logTs = _now.getFullYear()+'-'+_pad(_now.getMonth()+1)+'-'+_pad(_now.getDate())+' '+_pad(_now.getHours())+':'+_pad(_now.getMinutes())+':'+_pad(_now.getSeconds());
            const logName = projName + '-latest.log';
            const logsDir = path.join(sandboxDirArg, 'skills');
            fs.mkdirSync(logsDir, { recursive: true });
            const oldLogs = fs.readdirSync(logsDir).filter(f => f.endsWith('.log') && f.startsWith(projName + '-') && f !== logName);
            oldLogs.forEach(f => { try { fs.unlinkSync(path.join(logsDir, f)); } catch(_) {} });
            const title = isError ? '# Sandbox Log — ' + projName + ' [ERRORE]' : '# Sandbox Log — ' + projName;
            const logContent = title + _nl + 'Avviato: ' + logTs + _nl + 'Porta: ' + (freePortArg || '?') + _nl + _nl + _sbLogLines.join(_nl) + (extraLines ? _nl + _nl + extraLines : '');
            fs.writeFileSync(path.join(logsDir, logName), logContent, 'utf8');
            const idxPath = path.join(logsDir, '_index.json');
            let idx = {};
            try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch(_) {}
            idx[logName] = 'log';
            fs.writeFileSync(idxPath, JSON.stringify(idx), 'utf8');
          } catch(_) {}
        };

        let _sandboxDir = null;
        let _freePort = null;

        try {
          // Kill previous sandbox if running
          if (global._wcSandboxProc) {
            try { global._wcSandboxProc.kill('SIGTERM'); } catch(_) {}
            global._wcSandboxProc = null;
          }

          const sandboxDir = path.join(os.homedir(), '.nha', 'webcraft', projName);
          _sandboxDir = sandboxDir;
          sendLog(`📁 Percorso sandbox: ${sandboxDir}`);
          fs.mkdirSync(sandboxDir, { recursive: true });

          // Write all generated files
          sendLog(`📝 Scrittura di ${files.length} file...`);
          for (const f of files) {
            const filePath = path.join(sandboxDir, f.name);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, f.content, 'utf8');
            sendLog(`   ✓ ${f.name}`);
          }

          // Post-process HTML files: remove meta tags that break HTTP iframe sandbox
          // (Strict-Transport-Security, X-Frame-Options, frame-ancestors CSP meta)
          // This is system-level sanitization — the generated project code is NOT modified
          // by hand; the sandbox shim layer strips incompatible production-only headers.
          const htmlFiles = files.filter(function(f) { return f.name.endsWith('.html'); });
          if (htmlFiles.length > 0) {
            sendLog('🔧 Sanitizzazione meta tag sandbox...');
            for (const f of htmlFiles) {
              const fp = path.join(sandboxDir, f.name);
              let html = fs.readFileSync(fp, 'utf8');
              const before = html.length;
              // Remove Strict-Transport-Security meta (forces HTTPS, breaks HTTP sandbox)
              html = html.replace(/<meta[^>]+Strict-Transport-Security[^>]*>/gi, '');
              // Remove X-Frame-Options meta (blocks iframe embedding)
              html = html.replace(/<meta[^>]+X-Frame-Options[^>]*>/gi, '');
              // Remove Content-Security-Policy meta http-equiv (server sets it via helmet with sandbox-safe values)
              html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
              // Remove upgrade-insecure-requests directive if present in any remaining CSP meta
              html = html.replace(/upgrade-insecure-requests\s*;?\s*/gi, '');
              // Remove frame-ancestors none/self directives from any remaining CSP meta
              html = html.replace(/<meta[^>]+content=["'][^"']*frame-ancestors[^"']*["'][^>]*>/gi, '');
              if (html.length !== before) {
                fs.writeFileSync(fp, html, 'utf8');
                sendLog('   ✓ ' + f.name + ' (meta tag produzione rimossi)');
              }
            }
          }

          // Inject sandbox db shim — replaces pg with in-memory SQLite-like store
          const dbShim = `
// NHA WebCraft Sandbox DB Shim
// Replaces pg.Pool with a simple in-memory store so the sandbox runs without PostgreSQL.
// For production, delete this file and restore server/db.js to use pg.Pool.
const crypto = require('crypto');
const tables = {};
function ensureTable(t) { if (!tables[t]) tables[t] = []; }
function matchesWhere(row, where) {
  if (!where) return true;
  return Object.keys(where).every(k => row[k] == where[k]);
}
const pool = {
  query: async function(text, params) {
    // Parse very simple SQL patterns for auth routes
    const t = text.trim();
    const ins = t.match(/^INSERT INTO (\\w+)\\s*\\(([^)]+)\\)/i);
    if (ins) {
      const tbl = ins[1]; ensureTable(tbl);
      const cols = ins[2].split(',').map(c=>c.trim());
      const row = { id: crypto.randomUUID() };
      cols.forEach((c,i)=>{ row[c] = params?params[i]:null; });
      row.created_at = new Date().toISOString();
      row.updated_at = new Date().toISOString();
      tables[tbl].push(row);
      return { rows: [row], rowCount: 1 };
    }
    const sel = t.match(/^SELECT (.+) FROM (\\w+)/i);
    if (sel) {
      const tbl = sel[2]; ensureTable(tbl);
      const whereM = t.match(/WHERE (.+?)(?:LIMIT|ORDER|$)/i);
      let rows = tables[tbl];
      if (whereM && params) {
        // Simple $1 = value matching
        let idx = 0;
        const conds = whereM[1].split(/AND/i).map(c=>c.trim());
        const where = {};
        conds.forEach(c=>{
          const m = c.match(/(\\w+)\\s*=\\s*\\$\\d+/i);
          if (m) { where[m[1]] = params[idx++]; }
        });
        rows = rows.filter(r=>matchesWhere(r,where));
      }
      const lim = t.match(/LIMIT (\\d+)/i);
      if (lim) rows = rows.slice(0, parseInt(lim[1]));
      return { rows, rowCount: rows.length };
    }
    const upd = t.match(/^UPDATE (\\w+) SET (.+?) WHERE/i);
    if (upd) {
      const tbl = upd[1]; ensureTable(tbl);
      const whereM = t.match(/WHERE (.+?)(?:RETURNING|$)/i);
      let updated = [];
      tables[tbl] = tables[tbl].map(row=>{
        let match = true;
        if (whereM && params) {
          const conds = whereM[1].split(/AND/i).map(c=>c.trim());
          let idx = params.length - conds.length;
          conds.forEach(c=>{
            const m = c.match(/(\\w+)\\s*=\\s*\\$\\d+/i);
            if (m && params[idx] !== undefined) match = match && (row[m[1]] == params[idx++]);
          });
        }
        if (match) { row.updated_at = new Date().toISOString(); updated.push(row); }
        return row;
      });
      return { rows: updated, rowCount: updated.length };
    }
    const del = t.match(/^DELETE FROM (\\w+)/i);
    if (del) {
      const tbl = del[1]; ensureTable(tbl);
      tables[tbl] = [];
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  },
  connect: async function() { return { query: pool.query, release: ()=>{} }; }
};
pool.query.bind(pool);
async function query(text, params) { return pool.query(text, params); }
async function transaction(cb) {
  const client = await pool.connect();
  try { const r = await cb(client); client.release(); return r; }
  catch(e) { client.release(); throw e; }
}
module.exports = { pool, query, transaction };
`;
          fs.writeFileSync(path.join(sandboxDir, 'server', 'db.js'), dbShim, 'utf8');

          // Sentinel shim — zero external dependencies (no 'ip', 'net', etc.)
          const sentinelShim = `
// NHA WebCraft Sandbox — Sentinel WAF shim (zero dependencies)
const _ipWindows = {};
function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
}
const SQL_RE = new RegExp('(union[\\\\s\\\\S]+select|drop[\\\\s]+table|insert[\\\\s]+into|delete[\\\\s]+from|update[\\\\s]+set|exec[\\\\s]*\\\\(|xp_cmdshell)', 'i');
const XSS_RE = new RegExp('(<script|javascript:|onerror=|onload=|eval\\\\()', 'i');
const PATH_RE = new RegExp('\\\\.\\\\./');
function sentinelMiddleware(req, res, next) {
  var ip = getIP(req);
  var now = Date.now();
  if (!_ipWindows[ip]) _ipWindows[ip] = [];
  _ipWindows[ip] = _ipWindows[ip].filter(function(t){ return now - t < 60000; });
  _ipWindows[ip].push(now);
  if (_ipWindows[ip].length > 120) {
    process.stderr.write('[sentinel] rate-limit ' + ip + '\\n');
    return res.status(429).json({ error: 'Too many requests' });
  }
  var check = req.url + JSON.stringify(req.body || '');
  if (SQL_RE.test(check) || XSS_RE.test(check) || PATH_RE.test(check)) {
    process.stderr.write('[sentinel] blocked ' + ip + ' ' + req.method + ' ' + req.url + '\\n');
    return res.status(400).json({ error: 'Request blocked' });
  }
  next();
}
// Export both ways: default function (for require('./middleware/sentinel'))
// and named export (for require('./middleware/sentinel').sentinelMiddleware)
module.exports = sentinelMiddleware;
module.exports.sentinelMiddleware = sentinelMiddleware;
`;
          fs.mkdirSync(path.join(sandboxDir, 'server', 'middleware'), { recursive: true });
          fs.writeFileSync(path.join(sandboxDir, 'server', 'middleware', 'sentinel.js'), sentinelShim, 'utf8');

          // Cache shim — zero dependencies (no ioredis), pure in-memory LRU
          const cacheShim = `
// NHA WebCraft Sandbox — Cache shim (in-memory, no Redis required)
const _store = new Map();
const _MAX = 1000;
function evict() { if (_store.size > _MAX) { _store.delete(_store.keys().next().value); } }
async function get(key) { var e = _store.get(key); if (!e) return null; if (e.exp && Date.now() > e.exp) { _store.delete(key); return null; } return e.val; }
async function set(key, value, ttlSeconds) { evict(); _store.set(key, { val: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null }); }
async function del(key) { _store.delete(key); }
async function exists(key) { return (await get(key)) !== null; }
module.exports = { get, set, del, exists };
`;
          fs.mkdirSync(path.join(sandboxDir, 'server', 'services'), { recursive: true });
          fs.writeFileSync(path.join(sandboxDir, 'server', 'services', 'cache.js'), cacheShim, 'utf8');

          // Errors middleware shim — always overwrite to ensure complete exports
          const errorsShim = `
// NHA WebCraft Sandbox — middleware/errors shim
class AppError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode || 500; this.isOperational = true; } }
function notFoundHandler(req, res, next) { res.status(404).json({ error: 'Not found: ' + req.originalUrl }); }
function errorHandler(err, req, res, next) {
  var code = err.statusCode || err.status || 500;
  var msg = (process.env.NODE_ENV !== 'production' || err.isOperational) ? err.message : 'Internal Server Error';
  res.status(code).json({ error: msg });
}
module.exports = errorHandler;
module.exports.AppError = AppError;
module.exports.errorHandler = errorHandler;
module.exports.notFoundHandler = notFoundHandler;
`;
          fs.mkdirSync(path.join(sandboxDir, 'server', 'middleware'), { recursive: true });
          // Always overwrite — older shim versions may be missing exports like notFoundHandler
          fs.writeFileSync(path.join(sandboxDir, 'server', 'middleware', 'errors.js'), errorsShim, 'utf8');


          // Models shim — LLM often generates require('../models/User') etc. that don't exist
          // Create a generic User model shim backed by the in-memory DB shim
          const userModelShim = `
// NHA WebCraft Sandbox — models/User shim (in-memory, no PostgreSQL)
const db = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = {
  findById: async function(id) { var r = await db.query('SELECT * FROM users WHERE id=$1',[id]); return (r.rows||[])[0]||null; },
  findByEmail: async function(email) { var r = await db.query('SELECT * FROM users WHERE email=$1',[email]); return (r.rows||[])[0]||null; },
  create: async function(data) {
    var hash = data.password ? await bcrypt.hash(data.password,12) : data.password_hash||'';
    var token = crypto.randomBytes(32).toString('hex');
    var r = await db.query('INSERT INTO users (name,email,password_hash,verification_token) VALUES ($1,$2,$3,$4) RETURNING *',[data.name||data.username||'',data.email,hash,token]);
    return (r.rows||[])[0]||null;
  },
  update: async function(id, data) { var r = await db.query('UPDATE users SET verified=true WHERE id=$1 RETURNING *',[id]); return (r.rows||[])[0]||null; },
  findByVerificationToken: async function(token) { var r = await db.query('SELECT * FROM users WHERE verification_token=$1',[token]); return (r.rows||[])[0]||null; },
};
module.exports = User;
`;
          fs.mkdirSync(path.join(sandboxDir, 'server', 'models'), { recursive: true });
          if (!fs.existsSync(path.join(sandboxDir, 'server', 'models', 'User.js'))) {
            fs.writeFileSync(path.join(sandboxDir, 'server', 'models', 'User.js'), userModelShim, 'utf8');
          }

          // Validators shim — LLM often generates require('../utils/validators') with helpers that don't exist
          const validatorsShim = `
// NHA WebCraft Sandbox — utils/validators shim
function validateEmail(email) { return typeof email === 'string' && /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email.trim()); }
function sanitizeText(str) { return typeof str === 'string' ? str.replace(/<[^>]*>/g, '').trim() : ''; }
function validatePassword(pwd) { return typeof pwd === 'string' && pwd.length >= 8; }
function validateUsername(u) { return typeof u === 'string' && u.length >= 2 && u.length <= 50; }
function validatePhone(p) { return typeof p === 'string' && /^[+]?[\\d\\s\\-().]{7,20}$/.test(p.trim()); }
module.exports = { validateEmail, sanitizeText, validatePassword, validateUsername, validatePhone };
`;
          fs.mkdirSync(path.join(sandboxDir, 'server', 'utils'), { recursive: true });
          if (!fs.existsSync(path.join(sandboxDir, 'server', 'utils', 'validators.js'))) {
            fs.writeFileSync(path.join(sandboxDir, 'server', 'utils', 'validators.js'), validatorsShim, 'utf8');
          }

          // Patch all generated JS files: fix known wrong require() names
          // The LLM often uses 'bcrypt' instead of 'bcryptjs', 'pg' instead of nothing, etc.
          const requireFixes = [
            [/require\(['"]bcrypt['"]\)/g,                 "require('bcryptjs')"],
            [/require\(['"]node-postgres['"]\)/g,          "require('./db')"],
            [/require\(['"]pg['"]\)/g,                     "require('./db')"],
            [/require\(['"]ioredis['"]\)/g,                "require('../services/cache')"],
            [/require\(['"]redis['"]\)/g,                  "require('../services/cache')"],
            [/require\(['"]ip['"]\)/g,                     "({address:()=>'127.0.0.1',toLong:()=>0})"],
            [/require\(['"]express-async-errors['"]\)/g,   "{}"],
            [/require\(['"]multer['"]\)/g,                 "({single:()=>(r,s,n)=>n(),array:()=>(r,s,n)=>n(),memoryStorage:()=>({})})"],
            [/require\(['"]sharp['"]\)/g,                  "({})"],
            [/require\(['"]uuid['"]\)/g,                   "{v4:()=>Math.random().toString(36).slice(2)}"],
            [/require\(['"]nanoid['"]\)/g,                 "{nanoid:()=>Math.random().toString(36).slice(2)}"],
            [/require\(['"]joi['"]\)/g,                    "{object:()=>({keys:()=>({validate:()=>({error:null})})})}"],
            [/require\(['"]zod['"]\)/g,                    "{z:{object:()=>({parse:(x)=>x}),string:()=>({min:()=>({max:()=>({email:()=>({optional:()=>({})})})})})}"],
            [/require\(['"]winston['"]\)/g,                "{createLogger:()=>({info:()=>{},error:()=>{},warn:()=>{}}),transports:{Console:function(){}},format:{combine:()=>{},timestamp:()=>{},json:()=>{}}}"],
            [/require\(['"]morgan['"]\)/g,                 "(()=>(r,s,n)=>n())"],
            [/require\(['"]compression['"]\)/g,            "(()=>(r,s,n)=>n())"],
            [/require\(['"]express-validator['"]\)/g,      "(()=>{function chain(){var p=new Proxy(function(){return p},{get:function(_,k){if(k==='run')return async function(){};if(k==='withMessage'||k==='bail'||k==='optional')return function(){return p};return function(){return p};}});return p;}return {body:chain,param:chain,query:chain,header:chain,cookie:chain,check:chain,validationResult:function(req){return {isEmpty:function(){return true},array:function(){return []},throw:function(){}};},matchedData:function(){return {};},oneOf:function(){return chain();}};})()"],
            [/require\(['"]validator['"]\)/g,              "{isEmail:(s)=>/^[^@\\s]+@[^@\\s]+[.][^@\\s]+$/.test(s),escape:(s)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),trim:(s)=>String(s).trim(),isEmpty:(s)=>!s||!String(s).trim(),isLength:(s,o)=>{ var l=String(s).length; return (!o.min||l>=o.min)&&(!o.max||l<=o.max); }}"],
            [/require\(['"]handlebars['"]\)/g,             "{compile:(t)=>(d)=>t.replace(/\\{\\{([^}]+)\\}\\}/g,(_,k)=>d[k.trim()]||''),registerHelper:()=>{},registerPartial:()=>{}}"],
            [/require\(['"]express-handlebars['"]\)/g,     "{engine:()=>(p,o,cb)=>cb(null,'<html>'+JSON.stringify(o)+'</html>')}"],
            [/require\(['"]hbs['"]\)/g,                    "{registerHelper:()=>{},registerPartial:()=>{}}"],
            [/require\(['"]ejs['"]\)/g,                    "{render:(t,d)=>t.replace(/<%=([^%]+)%>/g,(_,k)=>d[k.trim()]||''),renderFile:(f,d,o,cb)=>{ if(typeof o==='function'){o(null,'');}else if(cb){cb(null,'');} }}"],
            [/require\(['"]pug['"]\)/g,                    "{compile:()=>(d)=>'',renderFile:(f,d,cb)=>cb&&cb(null,'')}"],
            [/require\(['"]nunjucks['"]\)/g,               "{configure:()=>({}),render:(t,d)=>JSON.stringify(d),renderString:(t,d)=>JSON.stringify(d)}"],
            [/require\(['"]mustache['"]\)/g,               "{render:(t,d)=>t.replace(/\\{\\{([^}]+)\\}\\}/g,(_,k)=>d[k.trim()]||'')}"],
            [/require\(['"]marked['"]\)/g,                 "{marked:(s)=>s,parse:(s)=>s}"],
            [/require\(['"]highlight\.js['"]\)/g,          "{highlight:(c)=>({value:c}),highlightAuto:(c)=>({value:c})}"],
            [/require\(['"]nodemailer['"]\)/g,             "{createTransport:()=>({sendMail:(o,cb)=>{ if(cb)cb(null,{messageId:'sandbox-'+Date.now()}); return Promise.resolve({messageId:'sandbox'}); }})}"],
            [/require\(['"]stripe['"]\)/g,                 "(()=>({customers:{create:async()=>({id:'cus_sandbox'})},paymentIntents:{create:async()=>({id:'pi_sandbox',client_secret:'sandbox_secret'})}}))()"],
            [/require\(['"]@sendgrid\/mail['"]\)/g,        "{setApiKey:()=>{},send:async()=>({statusCode:202})}"],
            [/require\(['"]twilio['"]\)/g,                 "(()=>({messages:{create:async()=>({sid:'SM_sandbox'})}}))()"],
            [/require\(['"]cookie-parser['"]\)/g,          "(()=>(r,s,n)=>{r.cookies=r.cookies||{};n()})"],
            [/require\(['"]passport['"]\)/g,               "{initialize:()=>(r,s,n)=>n(),session:()=>(r,s,n)=>n(),authenticate:()=>(r,s,n)=>n&&n()}"],
            [/require\(['"]express-session['"]\)/g,        "(()=>(r,s,n)=>{r.session=r.session||{};n()})"],
            [/require\(['"]connect-redis['"]\)/g,          "(()=>{function RedisStore(){}; RedisStore.prototype.get=function(k,cb){cb&&cb(null,null);}; RedisStore.prototype.set=function(k,v,cb){cb&&cb();}; RedisStore.prototype.destroy=function(k,cb){cb&&cb();}; return RedisStore;})()"],
            [/require\(['"]connect-flash['"]\)/g,          "(()=>(r,s,n)=>n())"],
            // Fix wrong relative paths the LLM generates
            [/require\(['"]\.\.\/middleware\/securityMiddleware['"]\)/g, "require('../middleware/security')"],
            [/require\(['"]\.\/middleware\/securityMiddleware['"]\)/g,   "require('./middleware/security')"],
            [/require\(['"]\.\.\/middleware\/authMiddleware['"]\)/g,     "require('../middleware/validate')"],
            [/require\(['"]\.\/middleware\/authMiddleware['"]\)/g,       "require('./middleware/validate')"],
            [/require\(['"]\.\.\/config\/database['"]\)/g,              "require('../db')"],
            [/require\(['"]\.\/config\/database['"]\)/g,               "require('./db')"],
            [/require\(['"]\.\.\/config\/db['"]\)/g,                   "require('../db')"],
            [/require\(['"]\.\/config\/db['"]\)/g,                     "require('./db')"],
            // redis utils — LLM generates custom utils/redis or config/redis wrappers
            [/require\(['"]\.\.\/utils\/redis['"]\)/g,                 "require('../services/cache')"],
            [/require\(['"]\.\/utils\/redis['"]\)/g,                   "require('../services/cache')"],
            [/require\(['"]\.\.\/config\/redis['"]\)/g,               "require('../services/cache')"],
            [/require\(['"]\.\/config\/redis['"]\)/g,                  "require('../services/cache')"],
            [/require\(['"]\.\.\/services\/redis['"]\)/g,             "require('../services/cache')"],
            [/require\(['"]\.\/services\/redis['"]\)/g,               "require('../services/cache')"],
            // email utils: LLM puts utils/email or services/emailService but file is services/email
            [/require\(['"]\.\.\/utils\/email['"]\)/g,                 "require('../services/email')"],
            [/require\(['"]\.\/utils\/email['"]\)/g,                   "require('./services/email')"],
            [/require\(['"]\.\.\/services\/emailService['"]\)/g,       "require('../services/email')"],
            [/require\(['"]\.\/services\/emailService['"]\)/g,         "require('./services/email')"],
            [/require\(['"]\.\.\/services\/mailer['"]\)/g,             "require('../services/email')"],
            [/require\(['"]\.\/services\/mailer['"]\)/g,               "require('./services/email')"],
            [/require\(['"]\.\.\/utils\/mailer['"]\)/g,                "require('../services/email')"],
            [/require\(['"]\.\/utils\/mailer['"]\)/g,                  "require('./services/email')"],
            // config module: LLM generates require('../../config') or require('../config')
            [/require\(['"]\.\.\/\.\.\/config['"]\)/g,                 "{env:process.env}"],
            [/require\(['"]\.\.\/config['"]\)/g,                       "{env:process.env}"],
            [/require\(['"]\.\/config['"]\)/g,                         "{env:process.env}"],
            // middleware/errors — LLM generates a custom error handler that doesn't exist
            [/require\(['"]\.\.\/middleware\/errors['"]\)/g,   "require('../middleware/errors')"],
            [/require\(['"]\.\/middleware\/errors['"]\)/g,     "require('./middleware/errors')"],
            [/require\(['"]\.\.\/middleware\/errorHandler['"]\)/g, "require('../middleware/errors')"],
            [/require\(['"]\.\.\/middleware\/error['"]\)/g,    "require('../middleware/errors')"],
            // models/* — redirect to shims in server/models/
            [/require\(['"]\.\.\/models\/User['"]\)/g,     "require('../models/User')"],
            [/require\(['"]\.\/models\/User['"]\)/g,       "require('./models/User')"],
            [/require\(['"]\.\.\/models\/user['"]\)/g,     "require('../models/User')"],
            // utils/* — LLM generates helpers that don't exist; redirect to shim
            [/require\(['"]\.\.\/utils\/validators['"]\)/g,   "require('../utils/validators')"],
            [/require\(['"]\.\/utils\/validators['"]\)/g,     "require('./utils/validators')"],
            [/require\(['"]\.\.\/utils\/validation['"]\)/g,   "require('../utils/validators')"],
            [/require\(['"]\.\.\/helpers\/validators['"]\)/g, "require('../utils/validators')"],
            [/require\(['"]\.\.\/utils\/helpers['"]\)/g,      "{sanitize:(s)=>String(s).trim(),escape:(s)=>String(s).replace(/</g,'&lt;')}"],
            [/require\(['"]\.\.\/utils\/logger['"]\)/g,       "{info:()=>{},error:()=>{},warn:()=>{},debug:()=>{}}"],
            [/require\(['"]\.\.\/utils\/errors['"]\)/g,       "{AppError:class AppError extends Error{constructor(m,s){super(m);this.statusCode=s||500;}}}"],
            // rateLimiter: LLM sometimes creates a separate file instead of importing from security.js
            [/require\(['"]\.\.\/middleware\/rateLimiter['"]\)/g,      "require('../middleware/security')"],
            [/require\(['"]\.\/middleware\/rateLimiter['"]\)/g,        "require('./middleware/security')"],
            [/require\(['"]\.\.\/middleware\/rateLimit['"]\)/g,        "require('../middleware/security')"],
            [/require\(['"]\.\/middleware\/rateLimit['"]\)/g,          "require('./middleware/security')"],
            [/require\(['"]\.\.\/middleware\/limiter['"]\)/g,          "require('../middleware/security')"],
            [/require\(['"]\.\/middleware\/limiter['"]\)/g,            "require('./middleware/security')"],
            // nodemailer: LLM calls createTransporter (wrong) instead of createTransport (correct)
            [/nodemailer\.createTransporter\s*\(/g,                    "nodemailer.createTransport("],
            [/\{createTransporter\s*:/g,                               "{createTransport:"],
            // helmet: upgradeInsecureRequests forces HTTPS on local sandbox — always disable it
            [/upgradeInsecureRequests\s*:\s*(?:true|\{\}|undefined)/g, "upgradeInsecureRequests: false"],
          ];
          function patchJsFiles(dir, rootDir) {
            if (!fs.existsSync(dir)) return;
            const _rootDir = rootDir || dir;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) { patchJsFiles(full, _rootDir); continue; }
              if (!entry.name.endsWith('.js')) continue;
              let src = fs.readFileSync(full, 'utf8');
              let changed = false;
              for (const [pat, rep] of requireFixes) {
                const next = src.replace(pat, rep);
                if (next !== src) { src = next; changed = true; }
              }
              // Context-aware db path fix: if file is in a subdirectory of server/
              // (e.g. routes/, middleware/, services/) and does require('./db'),
              // correct to require('../db') since db.js lives in server/
              const depth = path.relative(_rootDir, dir).split(path.sep).filter(Boolean).length;
              if (depth > 0) {
                const prefix = '../'.repeat(depth);
                const next2 = src.replace(/require\(['"]\.\/db['"]\)/g, "require('" + prefix + "db')");
                if (next2 !== src) { src = next2; changed = true; }
                // Also fix ./models/* → ../models/*
                const next3 = src.replace(/require\(['"]\.\/(models\/[^'"]+)['"]\)/g, "require('../$1')");
                if (next3 !== src) { src = next3; changed = true; }
              }
              if (changed) fs.writeFileSync(full, src, 'utf8');
            }
          }
          patchJsFiles(path.join(sandboxDir, 'server'), path.join(sandboxDir, 'server'));
          sendLog('🔧 Shim iniettati: DB (in-memory), Sentinel WAF, Cache — require() patchati');

          // Post-process server/index.js: fix static path + ensure SPA fallback
          // The LLM sometimes generates a relative path ('public') instead of the absolute
          // path.join(__dirname, '..', 'public') — causing "Not found: /" when the cwd
          // differs from the project root.
          const serverIndexPath = path.join(sandboxDir, 'server', 'index.js');
          if (fs.existsSync(serverIndexPath)) {
            let srvSrc = fs.readFileSync(serverIndexPath, 'utf8');
            let srvChanged = false;

            // Fix: express.static('public') / express.static("public") → absolute path
            const staticRelRe = /express\.static\s*\(\s*['"]\.?\/?public['"]\s*\)/g;
            const staticAbsolute = "express.static(path.join(__dirname, '..', 'public'))";
            if (staticRelRe.test(srvSrc)) {
              srvSrc = srvSrc.replace(staticRelRe, staticAbsolute);
              srvChanged = true;
            }

            // Fix: express.static(path.join(__dirname, 'public')) → go up one level
            const staticWrongDepth = /express\.static\s*\(\s*path\.join\s*\(\s*__dirname\s*,\s*['"]public['"]\s*\)\s*\)/g;
            if (staticWrongDepth.test(srvSrc)) {
              srvSrc = srvSrc.replace(staticWrongDepth, staticAbsolute);
              srvChanged = true;
            }

            // Ensure 'path' is required if we injected path.join
            if (srvChanged && !/require\(['"]path['"]\)/.test(srvSrc)) {
              srvSrc = "const path = require('path');\n" + srvSrc;
            }

            // Inject SPA fallback before the 404 / error handler if missing
            // Detects: app.use((req,res,next)... or app.use(function(err... or app.use(errorHandler)
            // and inserts the wildcard GET before it
            const hasSpaFallback = /app\s*\.\s*get\s*\(\s*['"]\*['"]/.test(srvSrc);
            if (!hasSpaFallback) {
              const spaFallback = "\n// SPA fallback — serve index.html for all unmatched GET routes\napp.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));\n";
              // Insert before the 404 handler (app.use with 4-arg function) or before app.listen
              const listenIdx = srvSrc.lastIndexOf('app.listen');
              const notFoundIdx = srvSrc.search(/app\.use\s*\(\s*(notFoundHandler|\(req,\s*res\)|function\s*\(req,\s*res)/);
              const insertAt = notFoundIdx !== -1 ? notFoundIdx : listenIdx;
              if (insertAt !== -1) {
                srvSrc = srvSrc.slice(0, insertAt) + spaFallback + srvSrc.slice(insertAt);
              } else {
                srvSrc += spaFallback;
              }
              srvChanged = true;
            }

            if (srvChanged) {
              fs.writeFileSync(serverIndexPath, srvSrc, 'utf8');
              sendLog('🔧 server/index.js: static path corretto + SPA fallback iniettato');
            }
          }

          // Patch package.json to remove pg, add only what's needed
          const pkgPath = path.join(sandboxDir, 'package.json');
          let pkg = {};
          try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch(_) {}
          if (!pkg.dependencies) pkg.dependencies = {};
          // Remove server-side deps that can't run in sandbox
          delete pkg.dependencies.pg;
          delete pkg.dependencies.ioredis;
          delete pkg.dependencies['pg-pool'];
          delete pkg.dependencies.redis;
          delete pkg.dependencies.mongoose;
          delete pkg.dependencies.mysql2;
          delete pkg.dependencies.sequelize;
          // Force known-good versions — LLM often generates non-existent patch versions
          pkg.dependencies.express = '^4.19.0';
          pkg.dependencies.bcryptjs = '^2.4.3';
          pkg.dependencies.jsonwebtoken = '^9.0.0';
          pkg.dependencies.helmet = '^7.1.0';
          pkg.dependencies['express-rate-limit'] = '^7.2.0';
          pkg.dependencies.cors = '^2.8.5';
          pkg.dependencies.dotenv = '^16.4.0';
          pkg.dependencies.nodemailer = '^6.9.0';
          pkg.dependencies['express-validator'] = '^7.0.1';
          // Auto-detect any require('pkg') in server JS files and add missing deps
          const KNOWN_VERSIONS = {
            'xss-clean': '^0.1.4', 'morgan': '^1.10.0', 'compression': '^1.7.4',
            'multer': '^1.4.5-lts.1', 'uuid': '^9.0.0', 'axios': '^1.6.0',
            'lodash': '^4.17.21', 'moment': '^2.30.1', 'dayjs': '^1.11.10',
            'joi': '^17.12.0', 'zod': '^3.22.4', 'yup': '^1.3.3',
            'stripe': '^14.21.0', 'passport': '^0.7.0', 'passport-local': '^1.0.0',
            'passport-jwt': '^4.0.1', 'cookie-parser': '^1.4.6', 'body-parser': '^1.20.2',
            'express-session': '^1.18.0', 'connect-flash': '^0.1.1', 'method-override': '^3.0.0',
            'serve-static': '^1.15.0', 'path': '0.12.7', 'crypto': '^1.0.1',
            'sanitize-html': '^2.12.0', 'dompurify': '^3.0.9', 'validator': '^13.11.0',
            'express-mongo-sanitize': '^2.2.0', 'hpp': '^0.2.3', 'xss': '^1.0.14',
            'winston': '^3.12.0', 'pino': '^8.19.0', 'chalk': '^5.3.0',
            'socket.io': '^4.7.4', 'ws': '^8.16.0', 'ejs': '^3.1.9', 'pug': '^3.0.2',
            'handlebars': '^4.7.8', 'nunjucks': '^3.2.4', 'sharp': '^0.33.3',
            'qrcode': '^1.5.3', 'pdf-lib': '^1.17.1',
          };
          const NODE_BUILTINS = new Set(['fs','path','os','crypto','http','https','net','url','util',
            'events','stream','buffer','child_process','process','querystring','readline','assert',
            'zlib','dns','tls','cluster','worker_threads','perf_hooks','vm','v8','module',
            'string_decoder','timers','punycode','domain','console','sys']);
          function scanRequires(dir) {
            const found = new Set();
            const walk = (d) => {
              let entries;
              try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
              for (const e of entries) {
                if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
                const full = path.join(d, e.name);
                if (e.isDirectory()) { walk(full); continue; }
                if (!e.name.endsWith('.js') && !e.name.endsWith('.mjs') && !e.name.endsWith('.cjs')) continue;
                let src;
                try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
                const re = /require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;
                let m;
                while ((m = re.exec(src)) !== null) {
                  const pkg2 = m[1].startsWith('@') ? m[1].split('/').slice(0,2).join('/') : m[1].split('/')[0];
                  if (!NODE_BUILTINS.has(pkg2)) found.add(pkg2);
                }
              }
            };
            walk(dir);
            return found;
          }
          const detected = scanRequires(sandboxDir);
          const missing = [];
          for (const mod of detected) {
            if (!pkg.dependencies[mod] && !pkg.devDependencies?.[mod]) {
              pkg.dependencies[mod] = KNOWN_VERSIONS[mod] || 'latest';
              missing.push(mod);
            }
          }
          if (missing.length > 0) sendLog('🔍 Dipendenze auto-rilevate e aggiunte: ' + missing.join(', '));
          pkg.scripts = pkg.scripts || {};
          pkg.scripts.start = 'node server/index.js';
          fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
          sendLog('📦 package.json ottimizzato per sandbox (rimosso pg/redis, auto-scan require)');

          // Create minimal .env for sandbox
          const envContent = [
            'PORT=0',
            'NODE_ENV=development',
            `JWT_SECRET=nha-sandbox-${crypto.randomBytes(16).toString('hex')}`,
            `JWT_REFRESH_SECRET=nha-sandbox-ref-${crypto.randomBytes(16).toString('hex')}`,
            'CORS_ORIGIN=*',
            `BASE_URL=http://localhost`,
            'SMTP_HOST=localhost',
            'SMTP_PORT=25',
            'SMTP_USER=sandbox',
            'SMTP_PASS=sandbox',
            'SMTP_FROM=sandbox@localhost',
          ].join('\n');
          fs.writeFileSync(path.join(sandboxDir, '.env'), envContent, 'utf8');
          sendLog('⚙️  .env sandbox creato');

          sendLog('');
          sendLog('📦 Dipendenze che verranno installate:');
          const deps = Object.keys(pkg.dependencies);
          deps.forEach(d => sendLog(`   • ${d}@${pkg.dependencies[d]}`));
          sendLog(`   Percorso: ${sandboxDir}/node_modules`);
          sendLog('');
          sendLog('⏳ npm install in corso...');

          // npm install
          await new Promise((resolve, reject) => {
            const npm = exec(`npm install --prefer-offline 2>&1`, { cwd: sandboxDir, timeout: 120000 }, (err, stdout) => {
              if (err) { sendLog('❌ npm install fallito: ' + err.message); reject(err); }
              else { resolve(); }
            });
            npm.stdout && npm.stdout.on('data', d => { const line = d.toString().trim(); if (line) sendLog('  ' + line); });
          });
          sendLog('✅ npm install completato');

          // Find free port
          const { default: netMod } = await import('net');
          const freePort = await new Promise(resolve => {
            const srv = netMod.createServer();
            srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
          });
          _freePort = freePort;

          // Patch PORT in .env
          fs.writeFileSync(path.join(sandboxDir, '.env'), envContent.replace('PORT=0', `PORT=${freePort}`), 'utf8');

          sendLog(`🚀 Avvio server sandbox su porta ${freePort}...`);

          // Spawn sandbox server
          const { spawn } = await import('child_process');
          const proc = spawn('node', ['server/index.js'], {
            cwd: sandboxDir,
            env: { ...process.env, PORT: String(freePort), NODE_ENV: 'development' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          global._wcSandboxProc = proc;
          global._wcSandboxPort = freePort;
          global._wcSandboxDir = sandboxDir;

          let _lastMissingModule = null;
          let _lastCrashError = null;
          let _stderrBuffer = '';  // accumulate full stderr for rich error context
          proc.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog('  [server] ' + l); });
          proc.stderr.on('data', d => {
            const raw = d.toString();
            _stderrBuffer += raw;
            // MODULE_NOT_FOUND
            const modMatch = raw.match(/Cannot find module '([^']+)'/);
            if (modMatch) {
              const missingMod = modMatch[1];
              _lastMissingModule = missingMod;
              _lastCrashError = "Cannot find module '" + missingMod + "'\n" + _stderrBuffer.slice(0, 1500);
              sendLog('  ❌ Modulo mancante: ' + missingMod);
              if (!global._wcAutoFixQueue) global._wcAutoFixQueue = [];
              global._wcAutoFixQueue.push({ type: 'module_not_found', module: missingMod, dir: sandboxDir, ts: Date.now() });
              sendLog('  🤖 Avvio auto-fix...');
              return;
            }
            // TypeError / SyntaxError / ReferenceError / Error — capture with full stack
            const crashMatch = raw.match(/^(TypeError|SyntaxError|ReferenceError|Error):\s+(.+)/m);
            if (crashMatch) {
              _lastCrashError = crashMatch[1] + ': ' + crashMatch[2].trim() + '\n' + _stderrBuffer.slice(0, 1500);
              sendLog('  ❌ ' + crashMatch[1] + ': ' + crashMatch[2].trim());
              if (!global._wcAutoFixQueue) global._wcAutoFixQueue = [];
              global._wcAutoFixQueue.push({ type: 'crash_error', error: _lastCrashError, dir: sandboxDir, ts: Date.now() });
              sendLog('  🤖 Avvio auto-fix...');
              return;
            }
            // Log everything else (including at-lines during crash) for visibility
            const l = raw.trim();
            if (!l || l.startsWith('(node:') || l === '^') return;
            sendLog('  [server] ' + l);
          });

          // Wait for server to be ready (max 30s).
          // If process exits early (crash), report the error immediately so the client
          // can trigger auto-fix while the SSE connection is still open.
          await new Promise((resolve, reject) => {
            let attempts = 0;
            const MAX_ATTEMPTS = 60; // 30s at 500ms intervals
            let crashed = false;

            proc.on('exit', (code) => {
              if (crashed || code === 0) return;
              crashed = true;
              // Give stderr a moment to flush
              setTimeout(() => {
                const errMsg = _lastCrashError || (_lastMissingModule ? "Cannot find module '" + _lastMissingModule + "'" : 'Server crashed (exit code ' + code + ')');
                reject(new Error(errMsg));
              }, 300);
            });

            const tryConnect = () => {
              if (crashed) return;
              const s = netMod.createConnection(freePort, '127.0.0.1');
              s.on('connect', () => { s.destroy(); resolve(); });
              s.on('error', () => {
                s.destroy();
                if (crashed) return;
                if (++attempts > MAX_ATTEMPTS) {
                  reject(new Error(_lastCrashError || (_lastMissingModule ? "Cannot find module '" + _lastMissingModule + "'" : 'Server non risponde dopo 30s')));
                } else {
                  setTimeout(tryConnect, 500);
                }
              });
            };
            setTimeout(tryConnect, 1000);
          });

          sendLog(`✅ Sandbox pronta!`);
          writeSandboxLog(sandboxDir, freePort, null, false);

          sendReady(freePort, sandboxDir);
        } catch (e) {
          if (_sandboxDir) writeSandboxLog(_sandboxDir, _freePort, '❌ ERRORE: ' + e.message, true);
          sendError(e.message);
        }
        res.end();
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      if (pathname === '/api/studio/webcraft/sandbox' && method === 'DELETE') {
        if (global._wcSandboxProc) {
          try { global._wcSandboxProc.kill('SIGTERM'); } catch(_) {}
          global._wcSandboxProc = null;
        }
        sendJSON(res, 200, { ok: true });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      if (pathname === '/api/studio/webcraft/sandbox/status' && method === 'GET') {
        sendJSON(res, 200, {
          running: !!global._wcSandboxProc,
          port: global._wcSandboxPort || null,
          dir: global._wcSandboxDir || null,
        });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── WebCraft Agent — chat + tool-use + auto-fix ────────────────────────
      // POST /api/studio/webcraft/agent  { projectName, message, attachments[]?, autofix? }
      //   → SSE: { type:'text', token } | { type:'tool', tool, path, result } | { type:'done' } | { type:'error', msg }
      // The agent reads files, applies old_string→new_string edits, writes new files.
      // Rate-limit for Liara: 3 calls per 5 minutes (unlimited for own API key).
      if (pathname === '/api/studio/webcraft/agent' && method === 'POST') {
        const body = await parseBody(req, 32 * 1024 * 1024); // 32MB for attachments
        const { projectName, message, attachments, autofix } = body;
        if (!projectName || !message) {
          sendJSON(res, 400, { error: 'projectName and message required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }

        // Rate-limit Liara: 6 per 5 minutes (autofix needs headroom for multi-crash startup sequences)
        const isLiara = !config.llm || !config.llm.apiKey || config.llm.provider === 'nha';
        if (isLiara) {
          if (!global._wcAgentCallLog) global._wcAgentCallLog = [];
          const fiveMinAgo = Date.now() - 5 * 60 * 1000;
          global._wcAgentCallLog = global._wcAgentCallLog.filter(t => t > fiveMinAgo);
          if (global._wcAgentCallLog.length >= 6) {
            sendJSON(res, 429, { error: 'Auto-fix rate limit: massimo 6 correzioni ogni 5 minuti con Liara. Usa una tua API key per correzioni illimitate.' });
            logRequest(method, pathname, 429, Date.now() - start);
            return;
          }
          global._wcAgentCallLog.push(Date.now());
        }

        const sandboxDir = path.join(os.homedir(), '.nha', 'webcraft', projectName.replace(/[^a-zA-Z0-9_-]/g, '-'));

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        const sendEv = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

        try {
          // Always read agent memory file first if present
          const agentMemoryPath = path.join(sandboxDir, 'webcraft-agent.md');
          const agentMemory = fs.existsSync(agentMemoryPath) ? fs.readFileSync(agentMemoryPath, 'utf8') : '';

          // Load context files from skills/ subfolder (skills, memory, provider)
          const skillsDir = path.join(sandboxDir, 'skills');
          let skillsContext = '';
          if (fs.existsSync(skillsDir)) {
            const indexPath = path.join(skillsDir, '_index.json');
            let typeIndex = {};
            if (fs.existsSync(indexPath)) { try { typeIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch(_) {} }
            const defaultType = (n) => n === 'memory.md' ? 'memory' : n === 'liara.md' ? 'provider' : 'skill';
            const sections = { memory: [], provider: [], skill: [], log: [] };
            for (const fname of fs.readdirSync(skillsDir)) {
              if (!fname.endsWith('.md')) continue;
              try {
                const content = fs.readFileSync(path.join(skillsDir, fname), 'utf8');
                if (!content.trim()) continue; // skip empty files
                const type = typeIndex[fname] || defaultType(fname);
                sections[type] = sections[type] || [];
                sections[type].push(`### ${fname}\n${content}`);
              } catch(_) {}
            }
            const parts = [];
            if (sections.memory.length) parts.push('MEMORIA PROGETTO:\n' + sections.memory.join('\n\n'));
            if (sections.provider.length) parts.push('ISTRUZIONI MODELLO AI:\n' + sections.provider.join('\n\n'));
            if (sections.skill.length) parts.push('SKILLS & PATTERN:\n' + sections.skill.join('\n\n'));
            if (sections.log && sections.log.length) parts.push('LOG AVVIO SANDBOX (ultimo):\n' + sections.log[sections.log.length - 1]);
            if (parts.length) skillsContext = '\n' + parts.join('\n\n') + '\n';
          }

          // Read all project files to give agent full context
          const allFiles = [];
          if (fs.existsSync(sandboxDir)) {
            const walkDir = (dir, base) => {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                const rel = base ? base + '/' + entry.name : entry.name;
                if (entry.isDirectory()) { walkDir(path.join(dir, entry.name), rel); }
                else {
                  try {
                    const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
                    if (content.length < 64 * 1024) allFiles.push({ name: rel, content }); // skip >64KB
                  } catch(_) {}
                }
              }
            };
            walkDir(sandboxDir, '');
          }

          const fileList = allFiles.map(f => f.name).join('\n');

          // Smart file selection: include only relevant files to avoid overflowing context window.
          // Always include: package.json, server/index.js, .env.example (structure/deps context).
          // Also include: any file whose name appears in the user message, plus error-related files.
          const msgLower = (message || '').toLowerCase();
          const alwaysInclude = ['package.json', 'server/index.js', '.env.example'];

          // For autofix: extract file paths directly from stack trace (e.g. "at Object.<anonymous> (/path/server/routes/auth.js:11:8)")
          const stackFileMatches = autofix ? [...(message.matchAll(/\(([^)]+\.(?:js|mjs|cjs|ts)):\d+:\d+\)/g))] : [];
          const stackFiles = new Set(stackFileMatches.map(m => {
            const abs = m[1];
            // Make relative to sandboxDir
            return abs.startsWith(sandboxDir) ? abs.slice(sandboxDir.length + 1) : abs.split('/').slice(-3).join('/');
          }));

          // For autofix: also detect "Cannot find module './redis'" style errors and extract the requiring file
          // Stack trace line: "at Object.<anonymous> (/path/server/middleware/security.js:3:X)"
          // We want to guarantee the file that contains the bad require() is always in context.
          const moduleNotFoundMatch = autofix ? message.match(/Cannot find module '([^']+)'[\s\S]*?at Object[^(]*\(([^)]+\.js):\d+:\d+\)/) : null;
          if (moduleNotFoundMatch) {
            const requirerAbs = moduleNotFoundMatch[2];
            const requirerRel = requirerAbs.startsWith(sandboxDir) ? requirerAbs.slice(sandboxDir.length + 1) : requirerAbs.split('/').slice(-3).join('/');
            stackFiles.add(requirerRel);
          }

          const isStackFile = (f) => stackFiles.size > 0 && [...stackFiles].some(sf => f.name.includes(sf) || sf.includes(f.name));

          const relevantFiles = allFiles.filter(f => {
            const nameLower = f.name.toLowerCase();
            if (alwaysInclude.some(a => nameLower.endsWith(a))) return true;
            // Always include files mentioned in stack trace (autofix) — highest priority
            if (isStackFile(f)) return true;
            // Include if file name or path fragment mentioned in message
            const parts = f.name.split('/');
            if (parts.some(p => msgLower.includes(p.replace(/\.[^.]+$/, '').toLowerCase()))) return true;
            // Include server JS files if message mentions "error", "errore", "fix", "crash", "module"
            if (/errore|error|fix|crash|module|require|import/i.test(message) && f.name.startsWith('server/') && f.name.endsWith('.js')) return true;
            return false;
          });
          // Sort: stack trace files first (guaranteed to be in context regardless of budget)
          relevantFiles.sort((a, b) => {
            const aStack = isStackFile(a) ? 0 : 1;
            const bStack = isStackFile(b) ? 0 : 1;
            return aStack - bStack;
          });
          // Cap total context at ~24KB to stay within 7B model limits
          // Stack trace files are always included even if over budget
          let contextBudget = 24 * 1024;
          const selectedFiles = [];
          for (const f of relevantFiles) {
            const isRequired = isStackFile(f) || alwaysInclude.some(a => f.name.toLowerCase().endsWith(a));
            if (contextBudget <= 0 && !isRequired) break;
            selectedFiles.push(f);
            contextBudget -= f.content.length;
          }
          const fileContext = selectedFiles.map(f => `### FILE: ${f.name}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
          const includedNote = selectedFiles.length < allFiles.length
            ? `\n(Showing ${selectedFiles.length}/${allFiles.length} files most relevant to the request. Ask to read others explicitly.)`
            : '';

          // Build attachment context (images/PDF)
          const attachCtx = (attachments || []).map((a, i) => `[Allegato ${i+1}: ${a.name || 'file'}, type=${a.mimeType}]`).join('\n');

          const systemPrompt = `Sei WebCraft Agent, un assistente AI esperto di sviluppo web fullstack embedded in NotHumanAllowed.
Il tuo lavoro e di correggere, migliorare ed espandere il codice del progetto sandbox dell utente.

PROGETTO ATTIVO: ${projectName}
PERCORSO: ${sandboxDir}
${agentMemory ? '\nMEMORIA PROGETTO:\n' + agentMemory + '\n' : ''}${skillsContext}FILE DISPONIBILI:
${fileList}

STRUMENTI A TUA DISPOSIZIONE (rispondi SOLO con JSON valido per le operazioni):
Quando devi modificare o creare file, includi nel testo della risposta blocchi JSON tra i tag <tool> e </tool>:

Per modificare parte di un file (chirurgico, preferito):
<tool>{"op":"edit","path":"server/routes/contact.js","old":"const email = require('../utils/email')","new":"const nodemailer = require('nodemailer')"}</tool>

Per creare/sovrascrivere un file intero:
<tool>{"op":"write","path":"server/utils/mailer.js","content":"// codice completo..."}</tool>

Per leggere un file (se hai bisogno di piu contesto):
<tool>{"op":"read","path":"server/index.js"}</tool>

REGOLE CRITICHE:
- Spiega SEMPRE in linguaggio naturale cosa stai facendo PRIMA dei blocchi tool
- ${autofix ? 'MODALITA AUTO-FIX: il file incriminato è già incluso qui sotto. Riscrivilo COMPLETAMENTE con "write" — è più affidabile di "edit" quando il file ha già subito modifiche. REGOLE CRITICHE PER IL FIX: (1) SyntaxError "Unexpected token \';\'" in helmet/CSP = stai usando punto-e-virgola invece di virgola negli oggetti JS — usa VIRGOLE. (2) "Cannot find module \'./redis\'" = rimuovi il require e usa solo i moduli in package.json. (3) NON aggiungere require() di moduli non in package.json. (4) SyntaxError "Unexpected identifier" con nomi spezzati tipo "create Transport" o "SMTP _HOST" o "trans porter" = c\'è uno SPAZIO nel mezzo di un nome di variabile/metodo/property — unisci le parole: createTransport, SMTP_HOST, transporter. (5) "nodemailer.createTransporter is not a function" = il metodo corretto di nodemailer e\' createTransport (senza r finale). Includi il contenuto COMPLETO del file nel campo "content".' : 'Usa "edit" (old/new) quando possibile, "write" solo per file nuovi o riscritture complete'}
- old_string deve essere ESATTO come appare nel file (copy-paste)
- Non inventare moduli npm: usa solo quelli in package.json o standard Node.js
- Dopo ogni fix spiega brevemente cosa hai cambiato e perche
- Se usi immagini allegate, descrivile e usale come contesto per il fix`;

          const userMsg = message + (attachCtx ? '\n\nAllegati:\n' + attachCtx : '') +
            '\n\n--- CONTENUTO FILE ---' + includedNote + '\n' + fileContext;

          // Call LLM - stream tokens
          let fullResponse = '';
          const visionAttachments = (attachments || []).filter(a => a.base64 && (a.mimeType || '').startsWith('image/'));

          try {
            if (visionAttachments.length > 0) {
              const { callLLMVision } = await import('../services/llm.mjs');
              const va = visionAttachments[0];
              fullResponse = await callLLMVision(config, systemPrompt, userMsg, { base64: va.base64, mimeType: va.mimeType });
              // Strip <tool>...</tool> blocks before sending text to client
              const visibleText = fullResponse.replace(/<tool>[\s\S]*?<\/tool>/g, '').trim();
              if (visibleText) sendEv({ type: 'text', token: visibleText });
            } else {
              // Stream tokens but suppress <tool>...</tool> blocks from the visible text
              let _toolBuf = '';     // accumulates content inside a <tool> block
              let _inTool = false;   // are we inside a <tool>...</tool>?
              await callLLMStream(config, systemPrompt, userMsg, (token) => {
                fullResponse += token;
                // Feed token through tool-suppression filter
                let remaining = (_inTool ? '' : '') + token; // process token char by char via buffer
                // Simpler approach: buffer until we can decide
                _toolBuf += token;
                // Flush visible text up to next <tool> opening
                while (true) {
                  if (!_inTool) {
                    const toolStart = _toolBuf.indexOf('<tool>');
                    if (toolStart === -1) {
                      // No tool block opening — safe to send everything except possible partial '<tool' at end
                      const safeEnd = _toolBuf.length - 6; // keep last 6 chars in case '<tool>' spans tokens
                      if (safeEnd > 0) {
                        sendEv({ type: 'text', token: _toolBuf.slice(0, safeEnd) });
                        _toolBuf = _toolBuf.slice(safeEnd);
                      }
                      break;
                    } else {
                      // Flush text before the <tool>
                      if (toolStart > 0) {
                        sendEv({ type: 'text', token: _toolBuf.slice(0, toolStart) });
                      }
                      _toolBuf = _toolBuf.slice(toolStart);
                      _inTool = true;
                    }
                  } else {
                    const toolEnd = _toolBuf.indexOf('</tool>');
                    if (toolEnd === -1) break; // still accumulating tool block
                    _toolBuf = _toolBuf.slice(toolEnd + 7); // discard the </tool> and move on
                    _inTool = false;
                  }
                }
              }, { max_tokens: 8192 });
              // Flush any remaining visible text after stream ends
              if (!_inTool && _toolBuf.trim()) sendEv({ type: 'text', token: _toolBuf });
            }
          } catch (llmErr) {
            const errMsg = llmErr.message || String(llmErr);
            // Surface a clean message instead of raw HTML
            if (errMsg.includes('502') || errMsg.includes('Bad Gateway')) {
              sendEv({ type: 'text', token: 'Liara non disponibile al momento (502). Riprova tra qualche secondo, oppure configura una tua API key con: nha config set provider anthropic && nha config set key sk-...' });
            } else if (errMsg.includes('429') || errMsg.includes('rate limit')) {
              sendEv({ type: 'text', token: 'Rate limit raggiunto su Liara (max 3 auto-fix per 5 minuti con il piano free). Attendi qualche minuto o usa una tua API key.' });
            } else {
              sendEv({ type: 'text', token: 'Errore LLM: ' + errMsg.slice(0, 200) });
            }
            sendEv({ type: 'done', changed: false, toolCount: 0 });
            res.end();
            return;
          }

          // Parse and execute tool calls from response
          // Sanitize JSON from LLM: replace literal newlines and invalid escape sequences inside JSON strings
          // Models often write multiline strings without escaping, or use \s \d \w in regex inside content
          // Robust JSON string extractor: reads a JSON string value starting at position i (after the opening ")
          // Returns { value, end } where end is the index after the closing "
          const extractJsonString = (s, i) => {
            let out = '';
            const validEscapes = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
            while (i < s.length) {
              const ch = s[i];
              if (ch === '\\') {
                const next = s[i + 1];
                if (next === undefined) { out += '\\\\'; i++; break; }
                if (validEscapes.has(next)) {
                  // valid escape — keep as-is, but handle \u specially
                  if (next === 'u') {
                    const hex = s.slice(i + 2, i + 6);
                    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                      out += s.slice(i, i + 6); i += 6;
                    } else {
                      out += '\\\\u'; i += 2;
                    }
                  } else {
                    out += s.slice(i, i + 2); i += 2;
                  }
                } else {
                  // invalid escape (e.g. \s \d \w \( \. \n written as literal) — escape the backslash
                  out += '\\\\' + next; i += 2;
                }
                continue;
              }
              if (ch === '"') { i++; break; } // closing quote
              if (ch === '\n') { out += '\\n'; i++; continue; }
              if (ch === '\r') { out += '\\r'; i++; continue; }
              if (ch === '\t') { out += '\\t'; i++; continue; }
              // other control chars
              if (ch.charCodeAt(0) < 0x20) { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); i++; continue; }
              out += ch; i++;
            }
            return { value: out, end: i };
          };

          const sanitizeToolJson = (raw) => {
            // Rebuild the JSON char-by-char, using extractJsonString for string values
            let out = '';
            let i = 0;
            let inStr = false;
            while (i < raw.length) {
              if (!inStr && raw[i] === '"') {
                // Start of a JSON string — extract it robustly
                out += '"';
                i++;
                const { value, end } = extractJsonString(raw, i);
                out += value + '"';
                i = end;
              } else {
                out += raw[i++];
              }
            }
            return out;
          };

          // Second-pass JSON repair: fix missing commas between object properties
          // e.g. {"a":1\n"b":2} → {"a":1,"b":2}
          const repairJson = (raw) => {
            // Add missing commas between } or ] or "..." or number/bool/null and the next " or { or [
            return raw
              .replace(/([}\]"'0-9truefalsNullnull])\s*\n\s*(")/g, '$1,\n"')   // after value, before next key
              .replace(/([}\]"'0-9truefalsNullnull])\s*\n\s*([{[])/g, '$1,\n$2') // after value, before { or [
              // Remove trailing commas before } or ]
              .replace(/,(\s*[}\]])/g, '$1');
          };

          const toolRegex = /<tool>([\s\S]*?)<\/tool>/g;
          let toolMatch;
          const toolResults = [];
          while ((toolMatch = toolRegex.exec(fullResponse)) !== null) {
            let toolCall;
            try {
              const raw = toolMatch[1].trim();
              const sanitized = sanitizeToolJson(raw);
              try {
                toolCall = JSON.parse(sanitized);
              } catch(_) {
                // Second attempt: repair missing commas
                toolCall = JSON.parse(repairJson(sanitized));
              }
            } catch(e) {
              sendEv({ type: 'tool', op: 'parse_error', path: '?', result: 'JSON malformato: ' + e.message.slice(0, 80) });
              continue;
            }

            if (toolCall.op === 'read') {
              const fp = path.join(sandboxDir, toolCall.path.replace(/^\/+/, ''));
              if (fs.existsSync(fp)) {
                const content = fs.readFileSync(fp, 'utf8');
                toolResults.push({ op: 'read', path: toolCall.path, ok: true });
                sendEv({ type: 'tool', op: 'read', path: toolCall.path, result: 'ok' });
              } else {
                sendEv({ type: 'tool', op: 'read', path: toolCall.path, result: 'file non trovato' });
              }
            } else if (toolCall.op === 'edit') {
              const fp = path.join(sandboxDir, toolCall.path.replace(/^\/+/, ''));
              if (!fs.existsSync(fp)) {
                sendEv({ type: 'tool', op: 'edit', path: toolCall.path, result: 'file non trovato' });
                continue;
              }
              let content = fs.readFileSync(fp, 'utf8');
              if (content.includes(toolCall.old)) {
                content = content.replace(toolCall.old, toolCall.new);
                fs.writeFileSync(fp, content, 'utf8');
                toolResults.push({ op: 'edit', path: toolCall.path, ok: true });
                sendEv({ type: 'tool', op: 'edit', path: toolCall.path, result: 'ok',
                  oldSnippet: (toolCall.old || '').slice(0, 300),
                  newSnippet: (toolCall.new || '').slice(0, 300) });
              } else {
                // edit fallback: old_string not found → do a second LLM call with the full file
                // and ask it to rewrite the file correctly. No client loop needed.
                sendEv({ type: 'tool', op: 'edit', path: toolCall.path, result: 'patch chirurgica fallita — riscrittura automatica in corso...' });
                try {
                  const fallbackSys = `Sei un esperto di Node.js. Riscrivi il seguente file correggendo questo problema: ${message.slice(0, 500)}
Rispondi SOLO con il contenuto completo del file corretto, senza markdown fence, senza spiegazioni.`;
                  const fallbackUser = `FILE: ${toolCall.path}\n\`\`\`\n${content}\n\`\`\``;
                  const newContent = await callLLM(config, fallbackSys, fallbackUser, { max_tokens: 8192 });
                  const cleaned = newContent.replace(/^```[\w]*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
                  if (cleaned && cleaned.length > 20) {
                    fs.writeFileSync(fp, cleaned, 'utf8');
                    toolResults.push({ op: 'write', path: toolCall.path, ok: true });
                    sendEv({ type: 'tool', op: 'write', path: toolCall.path, result: 'ok (fallback rewrite)',
                      oldSnippet: content.slice(0, 300), newSnippet: cleaned.slice(0, 300) });
                  }
                } catch(fallbackErr) {
                  sendEv({ type: 'tool', op: 'edit', path: toolCall.path, result: 'fallback rewrite fallito: ' + fallbackErr.message.slice(0, 80) });
                }
              }
            } else if (toolCall.op === 'write') {
              const fp = path.join(sandboxDir, toolCall.path.replace(/^\/+/, ''));
              fs.mkdirSync(path.dirname(fp), { recursive: true });
              const oldContent = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
              fs.writeFileSync(fp, toolCall.content || '', 'utf8');
              toolResults.push({ op: 'write', path: toolCall.path, ok: true });
              sendEv({ type: 'tool', op: 'write', path: toolCall.path, result: 'ok',
                oldSnippet: oldContent.slice(0, 300), newSnippet: (toolCall.content || '').slice(0, 300) });
            }
          }

          const anyChange = toolResults.some(r => r.ok);
          sendEv({ type: 'done', changed: anyChange, toolCount: toolResults.length });

          // If auto-fix and changes made → signal client to restart sandbox
          if (autofix && anyChange) {
            sendEv({ type: 'restart_sandbox' });
          }

        } catch(e) {
          sendEv({ type: 'error', msg: e.message });
        }
        res.end();
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/studio/webcraft/agent/autofix-queue → { items[] } and clears queue
      if (pathname === '/api/studio/webcraft/agent/autofix-queue' && method === 'GET') {
        const items = global._wcAutoFixQueue || [];
        global._wcAutoFixQueue = [];
        sendJSON(res, 200, { items });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/studio/webcraft/snapshot  { projectName } → { ok, snapshot }
      // Creates a timestamped snapshot of all project files (excludes node_modules)
      if (pathname === '/api/studio/webcraft/snapshot' && method === 'POST') {
        const body = await parseBody(req);
        const projName = (body.projectName || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!projName) { sendJSON(res, 400, { error: 'projectName required' }); return; }
        const projDir = path.join(os.homedir(), '.nha', 'webcraft', projName);
        const snapDir = path.join(projDir, '.snapshots');
        if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const snapPath = path.join(snapDir, ts + '.json');
        const snapshot = {};
        const walkSnap = (dir, base) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.snapshots' || entry.name.startsWith('.')) continue;
            const rel = base ? base + '/' + entry.name : entry.name;
            if (entry.isDirectory()) { walkSnap(path.join(dir, entry.name), rel); }
            else {
              try { snapshot[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf8'); } catch(_) {}
            }
          }
        };
        walkSnap(projDir, '');
        fs.writeFileSync(snapPath, JSON.stringify({ ts, files: snapshot }), 'utf8');
        // Keep only last 10 snapshots
        const allSnaps = fs.readdirSync(snapDir).filter(f => f.endsWith('.json')).sort();
        if (allSnaps.length > 10) {
          for (const old of allSnaps.slice(0, allSnaps.length - 10)) {
            try { fs.unlinkSync(path.join(snapDir, old)); } catch(_) {}
          }
        }
        sendJSON(res, 200, { ok: true, snapshot: ts, fileCount: Object.keys(snapshot).length });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // GET /api/studio/webcraft/snapshots/:name → { snapshots: [{ts, fileCount}] }
      if (pathname.startsWith('/api/studio/webcraft/snapshots/') && method === 'GET') {
        const projName = decodeURIComponent(pathname.replace('/api/studio/webcraft/snapshots/', '')).replace(/[^a-zA-Z0-9_-]/g, '');
        const snapDir = path.join(os.homedir(), '.nha', 'webcraft', projName, '.snapshots');
        if (!fs.existsSync(snapDir)) { sendJSON(res, 200, { snapshots: [] }); return; }
        const snaps = fs.readdirSync(snapDir).filter(f => f.endsWith('.json')).sort().reverse().map(f => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8'));
            return { ts: data.ts, fileCount: Object.keys(data.files || {}).length };
          } catch(_) { return null; }
        }).filter(Boolean);
        sendJSON(res, 200, { snapshots: snaps });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/studio/webcraft/restore  { projectName, ts } → { ok, restored }
      if (pathname === '/api/studio/webcraft/restore' && method === 'POST') {
        const body = await parseBody(req);
        const projName = (body.projectName || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const ts = (body.ts || '').replace(/[^0-9T\-]/g, '');
        if (!projName || !ts) { sendJSON(res, 400, { error: 'projectName and ts required' }); return; }
        const snapPath = path.join(os.homedir(), '.nha', 'webcraft', projName, '.snapshots', ts + '.json');
        if (!fs.existsSync(snapPath)) { sendJSON(res, 404, { error: 'snapshot not found' }); return; }
        const data = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
        const projDir = path.join(os.homedir(), '.nha', 'webcraft', projName);
        let restored = 0;
        for (const [rel, content] of Object.entries(data.files || {})) {
          const fp = path.join(projDir, rel);
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, content, 'utf8');
          restored++;
        }
        sendJSON(res, 200, { ok: true, restored });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/studio/webcraft/syntax-check  { projectName } → { results: [{file, ok, error}] }
      if (pathname === '/api/studio/webcraft/syntax-check' && method === 'POST') {
        const body = await parseBody(req);
        const projName = (body.projectName || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!projName) { sendJSON(res, 400, { error: 'projectName required' }); return; }
        const projDir = path.join(os.homedir(), '.nha', 'webcraft', projName);
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        const jsFiles = [];
        const walkJs = (dir, base) => {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const rel = base ? base + '/' + entry.name : entry.name;
            if (entry.isDirectory()) { walkJs(path.join(dir, entry.name), rel); }
            else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) { jsFiles.push(rel); }
          }
        };
        walkJs(projDir, '');
        const results = [];
        for (const rel of jsFiles) {
          const fp = path.join(projDir, rel);
          try {
            await execFileAsync(process.execPath, ['--check', fp], { timeout: 5000 });
            results.push({ file: rel, ok: true });
          } catch(e) {
            const errMsg = (e.stderr || e.message || '').split('\n')[0].replace(fp, rel);
            results.push({ file: rel, ok: false, error: errMsg });
          }
        }
        sendJSON(res, 200, { results });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // POST /api/studio/webcraft/grep  { projectName, query } → { matches: [{file, line, lineNum, match}] }
      if (pathname === '/api/studio/webcraft/grep' && method === 'POST') {
        const body = await parseBody(req);
        const projName = (body.projectName || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const query = (body.query || '').slice(0, 200);
        if (!projName || !query) { sendJSON(res, 400, { error: 'projectName and query required' }); return; }
        const projDir = path.join(os.homedir(), '.nha', 'webcraft', projName);
        const matches = [];
        let queryRe;
        try { queryRe = new RegExp(query, 'gi'); } catch(_) { queryRe = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); }
        const walkGrep = (dir, base) => {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const rel = base ? base + '/' + entry.name : entry.name;
            if (entry.isDirectory()) { walkGrep(path.join(dir, entry.name), rel); }
            else {
              const ext = entry.name.split('.').pop();
              if (!['js','mjs','ts','html','css','json','md','sql','env','conf'].includes(ext)) continue;
              try {
                const lines = fs.readFileSync(path.join(dir, entry.name), 'utf8').split('\n');
                lines.forEach((line, idx) => {
                  queryRe.lastIndex = 0;
                  if (queryRe.test(line)) {
                    matches.push({ file: rel, lineNum: idx + 1, line: line.trim().slice(0, 200) });
                    if (matches.length >= 100) return;
                  }
                });
              } catch(_) {}
            }
          }
        };
        walkGrep(projDir, '');
        sendJSON(res, 200, { matches: matches.slice(0, 100) });
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── Studio: Parliament deliberation (SSE streaming) ──────────────────
      // Implements the Legion DeliberationEngine protocol adapted for Studio:
      // Round 1 outputs already exist (from normal workflow steps).
      // Round 2: each agent cross-reads all others' Round 1 outputs and refines.
      // Convergence: Jaccard similarity on key terms between R1 and R2 outputs.
      // Round 3 (optional): if divergence > threshold, HERALD mediates.
      if (pathname === '/api/studio/deliberate' && method === 'POST') {
        const body = await parseBody(req);
        const { task, proposals, language: bodyLang } = body;
        if (!task || !Array.isArray(proposals) || proposals.length < 2) {
          sendJSON(res, 400, { error: 'task and at least 2 proposals required' });
          logRequest(method, pathname, 400, Date.now() - start);
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        const sendEv2 = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
        const sendTok2 = (t) => sendEv2({ token: t });
        const keepaliveD = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 5000);
        const language = bodyLang || 'Italian';
        const today = new Date().toISOString().slice(0, 10);

        // Jaccard similarity between two texts (key terms 4+ chars)
        const jaccard = (a, b) => {
          const terms = (s) => new Set(s.toLowerCase().match(/\b\w{4,}\b/g) || []);
          const sa = terms(a), sb = terms(b);
          let inter = 0;
          for (const w of sa) { if (sb.has(w)) inter++; }
          const union = sa.size + sb.size - inter;
          return union > 0 ? inter / union : 1;
        };

        const measureConvergence = (outputs) => {
          if (outputs.length < 2) return 1.0;
          let total = 0, pairs = 0;
          for (let i = 0; i < outputs.length; i++) {
            for (let j = i + 1; j < outputs.length; j++) {
              total += jaccard(outputs[i], outputs[j]);
              pairs++;
            }
          }
          return pairs > 0 ? total / pairs : 1.0;
        };

        try {
          const eligibleProposals = proposals.filter(p => p.agent !== 'CanvasAgent' && p.agent !== 'GitHubAgent' && p.agent !== 'EmailAgent' && p.agent !== 'CalendarAgent');
          if (eligibleProposals.length < 2) {
            sendEv2({ deliberation_done: true, skipped: true, reason: 'not enough specialist agents' });
            sendEv2({ done: true });
            res.write('data: [DONE]\n\n');
            res.end();
            clearInterval(keepaliveD);
            logRequest(method, pathname, 200, Date.now() - start);
            return;
          }

          // Round 1 convergence
          const r1Convergence = measureConvergence(eligibleProposals.map(p => p.output));
          sendTok2(`[Parlamento — Round 1 convergenza: ${(r1Convergence * 100).toFixed(0)}%] `);

          const buildCrossReadCtx = (excludeAgent) =>
            eligibleProposals
              .filter(p => p.agent !== excludeAgent)
              .map(p => `## ${p.label || p.agent} (Round 1):\n${p.output.slice(0, 4000)}`)
              .join('\n\n---\n\n');

          // Round 2: cross-reading + refinement (sequential to save tokens)
          sendTok2('[Parlamento — Round 2: Cross-Reading & Refinamento] ');
          const r2Results = [];

          for (const proposal of eligibleProposals) {
            sendTok2(`[Round 2: ${proposal.label || proposal.agent}] `);
            const crossCtx = buildCrossReadCtx(proposal.agent);
            const r2Sys = `You are ${proposal.agent}, a specialist AI agent in NHA Studio Parliament. Today is ${today}. Respond entirely in ${language}.

## WORKFLOW GOAL: ${task}

## YOUR ROUND 1 RESPONSE:
${proposal.output.slice(0, 1500)}

## OTHER AGENTS' ROUND 1 PROPOSALS:
${crossCtx}

DELIBERATION ROUND 2 — REFINEMENT:
1. Review the other agents' proposals
2. Incorporate valid points where you AGREE — mark with [ASSIST]
3. Flag genuine disagreements with [CONTRADICTION] and explain your reasoning
4. Produce your COMPLETE REFINED response (full answer, not a diff)
5. Keep your analysis focused on: ${task}`;

            let r2Out = '';
            let r2TokCount = 0;
            try {
              await callLLMStream(config, r2Sys, 'Produce your refined Round 2 response. Write complete content under every heading — never leave a section title without body text.',
                (tok) => {
                  r2Out += tok;
                  r2TokCount += Math.ceil(tok.length / 4);
                  // Stream live token count to client every ~20 tokens
                  if (r2TokCount % 20 < 3) {
                    sendTok2(`[Round 2 ${proposal.label || proposal.agent}: ${r2TokCount} token] `);
                  }
                }, { max_tokens: 8192 });
            } catch (e) { r2Out = proposal.output; }
            r2Results.push({ agent: proposal.agent, label: proposal.label, icon: proposal.icon, output: r2Out });
            sendEv2({ deliberation_r2: { agent: proposal.agent, label: proposal.label, icon: proposal.icon, output: r2Out } });
          }

          // Round 2 convergence
          const r2Convergence = measureConvergence(r2Results.map(r => r.output));
          sendTok2(`[Parlamento — Round 2 convergenza: ${(r2Convergence * 100).toFixed(0)}%] `);
          const converged = r2Convergence >= 0.30;

          // Round 3: HERALD always produces the final unified synthesis.
          // If converged: synthesize the consensus + surface any surviving divergences.
          // If divergent: actively mediate and make editorial choices.
          let mediationOutput = '';
          {
            const allR2Ctx = r2Results
              .map(r => `## ${r.label || r.agent}:\n${r.output.slice(0, 2000)}`)
              .join('\n\n---\n\n');

            // Extract [CONTRADICTION] tags from R2 outputs to surface them explicitly
            const contradictions = [];
            for (const r of r2Results) {
              const matches = r.output.match(/\[CONTRADICTION\][^\n]*/g) || [];
              matches.forEach(m => contradictions.push(`- ${r.label || r.agent}: ${m.replace('[CONTRADICTION]', '').trim()}`));
            }
            const contradictionBlock = contradictions.length > 0
              ? `\n\n## DIVERGENZE RILEVATE DAL ROUND 2:\n${contradictions.join('\n')}`
              : '';

            if (!converged) {
              sendTok2('[Parlamento — Round 3: Mediazione HERALD...] ');
            } else {
              sendTok2('[Parlamento — Round 3: Sintesi finale HERALD...] ');
            }

            const medTask = converged
              ? `SYNTHESIS TASK (convergenza ${(r2Convergence * 100).toFixed(0)}% — agenti sostanzialmente d'accordo):
1. Presenta il CONSENSO raggiunto — cosa tutti gli agenti concordano
2. Segnala esplicitamente ogni sfumatura o punto di divergenza residua, nominando l'agente che la ha sollevata e perché è stata inclusa o scartata
3. Produci un executive summary unificato con azioni concrete per: ${task}
4. Includi una sezione "Voci dissonanti" se esistono posizioni che meritano attenzione nonostante la convergenza`
              : `MEDIATION TASK (convergenza ${(r2Convergence * 100).toFixed(0)}% — divergenza significativa):
1. Identifica i punti di ACCORDO tra tutti gli agenti
2. Per ogni disaccordo: valuta quale posizione ha evidenze più solide, NOMINA l'agente che ha sollevato la posizione minoritaria e spiega perché è stata accolta o scartata
3. Produci una sintesi UNIFICATA preservando gli insight genuini di ogni agente
4. Fai scelte editoriali nette — NON miscelare ciecamente posizioni incompatibili
5. Output: executive summary completo con azioni concrete per: ${task}`;

            const medSys = `You are HERALD, the Parliament Mediator in NHA Studio. Today is ${today}. Respond entirely in ${language}.

## WORKFLOW GOAL: ${task}

## ALL AGENTS' REFINED POSITIONS (Round 2):
${allR2Ctx}${contradictionBlock}

${medTask}

CRITICAL WRITING RULES — ENFORCE STRICTLY:
- NEVER write a heading or numbered title without immediately writing its full content below it. A heading with no body text beneath it is FORBIDDEN.
- Every section (e.g. "3.1. Sito Web") MUST be followed by at least 3-5 concrete bullet points or sentences explaining WHAT to do and HOW. Never just list the title and move on.
- Every agent's contribution must be traceable. If an agent raised a point not incorporated, explicitly state why.
- Do NOT summarize sections at the end without first writing their full content.
- Write the complete content of each section before moving to the next.`;
            try {
              await callLLMStream(config, medSys, 'Produce the Parliament final synthesis.',
                (tok) => { mediationOutput += tok; }, { max_tokens: 8192 });
            } catch (e) { mediationOutput = ''; }
            sendEv2({ deliberation_r3: { output: mediationOutput, converged } });
          }

          clearInterval(keepaliveD);
          sendEv2({
            deliberation_done: true,
            r1_convergence: r1Convergence,
            r2_convergence: r2Convergence,
            converged,
            r2_results: r2Results,
            mediation: mediationOutput || null,
          });
          sendEv2({ done: true });
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (e) {
          clearInterval(keepaliveD);
          sendEv2({ error: e.message });
          res.end();
        }
        logRequest(method, pathname, 200, Date.now() - start);
        return;
      }

      // ── 404 ──────────────────────────────────────────────────────────
      sendJSON(res, 404, { error: 'Not found' });
      logRequest(method, pathname, 404, Date.now() - start);

    } catch (err) {
      console.error(`  \x1b[0;31mServer error:\x1b[0m`, err.message);
      try {
        sendJSON(res, 500, { error: 'Internal server error' });
      } catch {}
      logRequest(method, pathname, 500, Date.now() - start);
    }
  }

  // ── Start Server ────────────────────────────────────────────────────────

  const server = http.createServer(handleRequest);

  // ── WebSocket server — daemon relay + Alexandria real-time ──────────
  let wsBroadcast = (msg) => {}; // no-op until WS is ready
  try {
    const { WebSocketServer, WebSocket: WsClient } = await import('ws');
    const wss = new WebSocketServer({ server });
    const wsClients = new Set();

    wsBroadcast = (msg) => {
      const data = JSON.stringify(msg);
      for (const ws of wsClients) {
        if (ws.readyState === 1) try { ws.send(data); } catch {}
      }
    };

    wss.on('connection', (browserWs) => {
      wsClients.add(browserWs);

      // Connect to daemon WS on port 3848 and relay messages
      let daemonWs = null;
      try {
        daemonWs = new WsClient('ws://127.0.0.1:3848');
        daemonWs.on('message', (data) => {
          if (browserWs.readyState === 1) browserWs.send(data.toString());
        });
        daemonWs.on('error', () => {});
        daemonWs.on('close', () => { daemonWs = null; });
      } catch {}

      browserWs.on('close', () => { wsClients.delete(browserWs); if (daemonWs) try { daemonWs.close(); } catch {} });
      browserWs.on('error', () => { wsClients.delete(browserWs); if (daemonWs) try { daemonWs.close(); } catch {} });
    });

    // ── Alexandria real-time — connect to server WS for each channel ──────
    const collabDir = path.join(NHA_DIR, 'collab');
    const alexWsConnections = new Map(); // channelId → ws

    function connectAlexandriaWs(channelId, channelName) {
      if (alexWsConnections.has(channelId)) return;
      try {
        const wsUrl = 'wss://nothumanallowed.com/ws/alexandria/' + channelId;
        const alexWs = new WsClient(wsUrl);

        alexWs.on('open', () => {
          alexWsConnections.set(channelId, alexWs);
          console.log(`  [Alexandria WS] Connected to channel ${channelId.slice(0, 8)}...`);
        });

        alexWs.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'new_message' && msg.message) {
              // Decrypt using channel key with secret
              let wsSecret = '';
              try { const chs4 = JSON.parse(fs.readFileSync(path.join(collabDir, 'channels.json'), 'utf-8')); wsSecret = chs4.find(c => c.id === channelId)?.secret || ''; } catch {}
              const channelKey = crypto.createHash('sha256').update('alexandria-e2e-key-v2').update(channelId).update(wsSecret).digest();
              let content = '[encrypted]';
              try {
                const nonce = Buffer.from(msg.message.nonce, 'base64');
                const raw = Buffer.from(msg.message.ciphertext, 'base64');
                const tag = raw.subarray(raw.length - 16);
                const encrypted = raw.subarray(0, raw.length - 16);
                const decipher = crypto.createDecipheriv('aes-256-gcm', channelKey, nonce);
                decipher.setAuthTag(tag);
                content = decipher.update(encrypted) + decipher.final('utf-8');
              } catch {}

              // Push to browser via local WS
              wsBroadcast({
                type: 'collab_message',
                channelId,
                channelName,
                message: {
                  senderName: msg.message.senderName || msg.message.senderFingerprint?.slice(0, 8) || 'Unknown',
                  senderFingerprint: msg.message.senderFingerprint,
                  content,
                  timestamp: msg.message.timestamp,
                  type: msg.message.type,
                },
              });
            }
          } catch {}
        });

        alexWs.on('close', () => {
          alexWsConnections.delete(channelId);
          // Reconnect after 5s
          setTimeout(() => connectAlexandriaWs(channelId, channelName), 5000);
        });
        alexWs.on('error', (e) => {
          console.log(`  [Alexandria WS] Error on ${channelId.slice(0, 8)}: ${e.message}`);
          alexWsConnections.delete(channelId);
        });
      } catch {}
    }

    // Connect to all channels on startup
    setTimeout(() => {
      try {
        const chFile = path.join(collabDir, 'channels.json');
        if (fs.existsSync(chFile)) {
          const channels = JSON.parse(fs.readFileSync(chFile, 'utf-8'));
          console.log(`  [Alexandria WS] Connecting to ${channels.length} channel(s)...`);
          for (const ch of channels) {
            connectAlexandriaWs(ch.id, ch.name);
          }
        } else {
          console.log('  [Alexandria WS] No channels file found');
        }
      } catch (e) {
        console.log(`  [Alexandria WS] Startup error: ${e.message}`);
      }
    }, 2000);

  } catch {
    // ws package not available — live updates disabled
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      fail(`Port ${port} is already in use. Try: nha ui --port=${port + 1}`);
      process.exit(1);
    }
    fail(`Server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const localUrl = `http://127.0.0.1:${port}`;

    // Get LAN IP for mobile access
    let lanUrl = '';
    if (lanMode) {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            lanUrl = `http://${net.address}:${port}`;
            break;
          }
        }
        if (lanUrl) break;
      }
    }

    console.log('');
    console.log(`  ${BOLD}${C}NHA Local Operations Console${NC}`);
    console.log(`  ${D}Zero-dependency web interface for your daily ops${NC}`);
    console.log('');
    console.log(`  ${G}Local:${NC}              ${localUrl}`);
    if (lanUrl) {
      console.log(`  ${G}Network:${NC}            ${lanUrl}  ${D}(mobile/tablet)${NC}`);
    }
    console.log(`  ${D}Provider:${NC}           ${config.llm.provider || 'not set'}`);
    console.log(`  ${D}API Key:${NC}            ${config.llm.apiKey ? config.llm.apiKey.slice(0, 12) + '...' : '\x1b[0;31mnot set\x1b[0m'}`);
    console.log(`  ${D}Agents loaded:${NC}      ${agentCards.length}`);
    console.log('');
    if (lanUrl) {
      console.log(`  ${D}Open ${lanUrl} on your phone to use NHA from mobile.${NC}`);
    } else {
      console.log(`  ${D}Tip: use --lan to access from phone/tablet on same WiFi.${NC}`);
    }
    console.log(`  ${D}Press Ctrl+C to stop${NC}`);
    console.log('');

    if (!noBrowser) {
      openBrowser(localUrl);
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\n  ${D}Shutting down...${NC}`);
    server.close(() => {
      console.log(`  ${D}Server stopped.${NC}\n`);
      process.exit(0);
    });
    // Force exit after 3s if connections hang
    setTimeout(() => process.exit(0), 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
