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
import { getTodayEvents, getUpcomingEvents, createEvent, updateEvent, getEventsForDate } from '../services/mail-router.mjs';
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

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 1_048_576; // 1 MB
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
  const chatSystemPrompt = buildSystemPrompt('NHA UI', UI_PERSONA, config);

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
          'Cache-Control': 'public, max-age=3600',
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

      // GET /api/calendar?date=YYYY-MM-DD
      if (method === 'GET' && pathname === '/api/calendar') {
        try {
          const dateParam = url.searchParams.get('date');
          let events;
          if (dateParam && dateParam !== new Date().toISOString().split('T')[0]) {
            events = await getEventsForDate(config, new Date(dateParam));
          } else {
            events = await getTodayEvents(config);
          }
          sendJSON(res, 200, { events, date: dateParam || new Date().toISOString().split('T')[0] });
        } catch (e) {
          sendJSON(res, 200, { events: [], error: e.message });
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

        // Inject episodic memory context into the system prompt
        const basePrompt = effectiveSystemPrompt || chatSystemPrompt;
        let enrichedSystemPrompt = basePrompt;
        try {
          const memCtx = buildMemoryContext('chat', body.message);
          if (memCtx) enrichedSystemPrompt = basePrompt + memCtx;
        } catch { /* memory unavailable */ }

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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_base64: body.imageBase64, prompt: imagePrompt }),
              });
              if (!r.ok) throw new Error(`Liara Vision ${r.status}`);
              const d = await r.json();
              visionResponse = d.description || d.text || JSON.stringify(d);
            } else if (provider === 'anthropic') {
              const r = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({
                  model: model || 'claude-sonnet-4-20250514', max_tokens: 4096, system: enrichedSystemPrompt,
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
                  headers: { 'Content-Type': 'application/json' },
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
                  headers: { 'Content-Type': 'application/json' },
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
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({
                  model: model || 'claude-sonnet-4-20250514', max_tokens: 8192, system: enrichedSystemPrompt,
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
            const followUp = `The user asked: "${body.message}"\n\nI executed these tools and got REAL results:\n\n${toolContext}\n\nNow respond conversationally based ONLY on the REAL data above. Do NOT output any JSON blocks, base64, or image markdown — just natural text.`;
            try {
              fullResponse = await callLLM(config, enrichedSystemPrompt, followUp);
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

            const followUp = `The user asked: "${msg}"\n\nI executed these tools and got REAL results:\n\n${toolContext}\n\nNow respond to the user conversationally based ONLY on the REAL data above. Present the results clearly. Do NOT output any JSON blocks, any base64 data, or any image markdown — just natural text. If a screenshot was taken, just mention "Screenshot captured" without embedding it.`;
            sendSSE('tool_synthesis', {});
            try {
              finalResponse = await callLLMStream(config, enrichedPrompt, followUp, (chunk) => {
                sendSSE('token', { content: chunk });
              });
              finalResponse = finalResponse
                .replace(/```json[\s\S]*?```/g, '')
                .replace(/!\[.*?\]\(data:image\/[^)]+\)/g, '')
                .replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{100,}/g, '[image]')
                .trim();
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
      if (method === 'GET' && pathname === '/api/github') {
        try {
          const gh = await import('../services/github.mjs');
          const raw = await gh.listNotificationsRaw(config, 15);
          sendJSON(res, 200, { notifications: raw });
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
              upcoming.push({ name: c.name, date: dateStr, daysUntil });
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

      // ── Studio: plan workflow ────────────────────────────────────────
      if (pathname === '/api/studio/plan' && method === 'POST') {
        const body = await parseBody(req);
        const task = (body.task || '').trim();
        if (!task) { sendJSON(res, 400, { error: 'task required' }); logRequest(method, pathname, 400, Date.now() - start); return; }

        const planPrompt = `You are a workflow planner for NHA Studio. The user wants to accomplish this task: "${task}"

Design a sequential workflow of 2-5 steps. RULES:
- Use tool-agents (WebSearchAgent, EmailAgent, CalendarAgent, GitHubAgent, NotionAgent, SlackAgent) FIRST when real live data is needed
- Use specialist agents (SABER, ATLAS, JARVIS, etc.) for deep domain analysis — they have rich expert system prompts
- Use CanvasAgent as the LAST step ONLY when a visual HTML report is requested
- The "prompt" field must be a plain language instruction — never JSON or code
- Each agent receives the previous step's output as context automatically
- Pick the most relevant agents for the task — don't use all of them

TOOL AGENTS (fetch real live data):
- WebSearchAgent: search the web for current information
- EmailAgent: read user's real unread emails
- CalendarAgent: read user's real calendar events for today
- GitHubAgent: read user's GitHub notifications and issues
- NotionAgent: search user's Notion workspace
- SlackAgent: read user's Slack messages
- WriterAgent: write, summarize, synthesize text (no live data)
- SummaryAgent: condense and summarize content
- DataAnalystAgent: analyze data, find patterns, generate insights
- SecurityAgent: security audit, threat analysis
- DevOpsAgent: infrastructure, deployment, CI/CD analysis
- CanvasAgent: generate a beautiful HTML visual dashboard (LAST step only)

SPECIALIST AGENTS (deep domain experts with rich system prompts):
- SABER: security audits, OWASP, penetration testing, vulnerability analysis
- ATLAS: infrastructure-as-code, Terraform, Kubernetes, cloud architecture
- JARVIS: full-stack architecture, API design, system design, ADRs
- VERITAS: fact-checking, evidence verification, claim validation
- CASSANDRA: risk analysis, failure modes, worst-case scenarios
- MERCURY: financial analysis, ROI, unit economics, market modeling
- HERALD: news analysis, trend detection, executive briefings
- ATHENA: tech evaluation, framework comparison, benchmarks
- ORACLE: business intelligence, KPIs, OKRs, dashboards
- NAVI: data exploration, statistical analysis, pattern detection
- MUSE: creative brainstorming, ideation, naming, taglines
- QUILL: short-form content, summaries, press releases
- SCHEHERAZADE: long-form technical writing, documentation, tutorials
- ECHO: content adaptation, cross-platform distribution
- POLYGLOT: translation, localization, multilingual content
- FORGE: CI/CD pipelines, GitHub Actions, Docker builds
- FLUX: deployment strategies, blue/green, canary releases
- SHOGUN: Kubernetes, Helm, container orchestration
- PIPE: data pipelines, Airflow, dbt, ETL
- MACRO: bulk operations, data migration, batch processing
- SHELL: shell scripting, CLI tools, automation scripts
- CONDUCTOR: workflow orchestration, task decomposition
- CRON: scheduling, cron jobs, time-based automation
- HERMES: webhooks, event-driven architecture, integrations
- BABEL: API design, microservices, OpenAPI specs
- CARTOGRAPHER: data mapping, schema inference, knowledge graphs
- LOGOS: logical analysis, argument mapping, decision theory
- EDI: A/B testing, statistical modeling, hypothesis testing
- EPICURE: nutrition, recipes, meal planning
- MURASAKI: creative writing, storytelling, narrative craft
- LINK: community management, reputation systems
- GLITCH: chaos engineering, resilience testing
- TEMPEST: performance engineering, load testing
- SAURON: observability, monitoring, alerting
- PROMETHEUS: capability routing, task decomposition
- ADE: agent design, system prompt engineering
- ZERO: vulnerability scanning, dependency audit, secret detection

Icon values must be actual emoji characters — never HTML entities.

Respond with ONLY valid JSON, no markdown:
{"steps":[{"icon":"🔍","agent":"WebSearchAgent","label":"Search AI news","prompt":"Search for the latest AI agent news"},{"icon":"🧠","agent":"ATHENA","label":"Tech analysis","prompt":"Analyze the search results and compare the key technologies mentioned"}]}`;

        try {
          const planRaw = await callLLM(config, 'You are a JSON workflow planner. Respond only with valid JSON.', planPrompt, { max_tokens: 800 });
          let steps;
          try {
            const jsonMatch = planRaw.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : planRaw);
            steps = parsed.steps;
          } catch {
            sendJSON(res, 500, { error: 'Failed to parse workflow plan' });
            logRequest(method, pathname, 500, Date.now() - start);
            return;
          }
          if (!Array.isArray(steps) || !steps.length) {
            sendJSON(res, 500, { error: 'Empty workflow plan' });
            logRequest(method, pathname, 500, Date.now() - start);
            return;
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
        const body = await parseBody(req);
        const { agent, task, context, stepDef } = body;
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

        // Timeout wrapper for tool calls — 25s max
        const withTimeout = (promise, label) => Promise.race([
          promise,
          new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after 25s`)), 25000)),
        ]);

        try {
          const stepPrompt = stepDef?.prompt || task;
          let toolData = '';

          // ── Fetch REAL data for each agent type ──────────────────────
          if (agent === 'EmailAgent') {
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
            sendToken('[Searching the web...] ');
            try {
              const searchResult = await withTimeout(executeTool('web_search', { query: stepPrompt }, config), 'WebSearch');
              toolData = typeof searchResult === 'string' ? searchResult : JSON.stringify(searchResult);
            } catch (e) { toolData = `Web search failed: ${e.message}`; }

          } else if (agent === 'BrowserAgent') {
            const urlMatch = stepPrompt.match(/https?:\/\/[^\s"']+/);
            if (urlMatch) {
              sendToken(`[Fetching ${urlMatch[0]}...] `);
              try {
                const fetchResult = await withTimeout(executeTool('fetch_url', { url: urlMatch[0] }, config), 'BrowserAgent');
                toolData = typeof fetchResult === 'string' ? fetchResult : JSON.stringify(fetchResult);
              } catch (e) { toolData = `Fetch failed: ${e.message}`; }
            } else {
              sendToken('[Searching web...] ');
              try {
                const searchResult = await withTimeout(executeTool('web_search', { query: stepPrompt }, config), 'BrowserSearch');
                toolData = typeof searchResult === 'string' ? searchResult : JSON.stringify(searchResult);
              } catch (e) { toolData = `Browser search failed: ${e.message}`; }
            }

          } else if (agent === 'GitHubAgent') {
            sendToken('[Reading GitHub...] ');
            try {
              const gh = await import('../services/github.mjs');
              const issues = await withTimeout(gh.listIssues(config, config.githubRepo || '', 10), 'GitHubAgent');
              toolData = typeof issues === 'string' ? issues : JSON.stringify(issues);
            } catch (e) { toolData = `GitHub read failed: ${e.message}`; }

          } else if (agent === 'NotionAgent') {
            sendToken('[Searching Notion...] ');
            try {
              const nt = await import('../services/notion.mjs');
              const results = await withTimeout(nt.search(config, stepPrompt, 10), 'NotionAgent');
              toolData = typeof results === 'string' ? results : JSON.stringify(results);
            } catch (e) { toolData = `Notion search failed: ${e.message}`; }

          } else if (agent === 'SlackAgent') {
            sendToken('[Reading Slack...] ');
            try {
              const sl = await import('../services/slack.mjs');
              const channels = await withTimeout(sl.listChannels(config, 10), 'SlackAgent');
              toolData = typeof channels === 'string' ? channels : JSON.stringify(channels);
            } catch (e) { toolData = `Slack read failed: ${e.message}`; }

          } else if (agent === 'DriveAgent') {
            sendToken('[Reading Drive...] ');
            try {
              const gd = await import('../services/google-drive.mjs');
              const files = await withTimeout(gd.listFiles(config, '', 10), 'DriveAgent');
              toolData = typeof files === 'string' ? files : JSON.stringify(files);
            } catch (e) { toolData = `Drive read failed: ${e.message}`; }
          }

          // ── Build system prompt with real tool data ───────────────────
          const isCanvasAgent = agent === 'CanvasAgent';
          // Tool-data agents: fetch real live data and use buildSystemPrompt (tool calls allowed)
          const isLiveDataAgent = ['CalendarAgent','EmailAgent','GitHubAgent','NotionAgent','SlackAgent','DriveAgent','BrowserAgent','WebSearchAgent','ResearchAgent'].includes(agent);

          const canvasSystemPrompt = `You are an HTML report generator. Output a single complete HTML document. No preamble, no explanation.
RULES:
- First character of your response must be < (start of <!DOCTYPE html>)
- Do NOT use markdown code blocks, JSON, or any wrapper
- Use clean design: white background, Inter/system-ui font, #6366f1 accent color
- Structure: gradient header, then card sections with the content
- Make it complete and self-contained`;

          let sysPrompt, userMsg;

          if (isCanvasAgent) {
            sysPrompt = canvasSystemPrompt;
            userMsg = `Generate a beautiful HTML dashboard report for this content. Start immediately with <!DOCTYPE html>:\n\n${context.slice(0, 8000)}`;
          } else if (isLiveDataAgent) {
            // These agents fetched real data — use buildSystemPrompt so they can call tools too
            const agentInstruction = `You are ${agent}, a specialist AI agent inside NHA Studio.\nYour task: ${stepPrompt}\n` +
              (toolData ? `\n## DATA FROM TOOLS:\n${toolData.slice(0, 4000)}\n` : '') +
              (context ? `\n## OUTPUT FROM PREVIOUS AGENTS:\n${context.slice(0, 3000)}\n` : '') +
              '\nWrite your analysis in plain text. Do NOT output JSON, tool calls, or code blocks. Summarize the data clearly.';
            sysPrompt = buildSystemPrompt(agent, agentInstruction, config);
            userMsg = toolData
              ? `Summarize the data above for: ${stepPrompt}`
              : context
              ? `Based on the previous output, complete: ${stepPrompt}`
              : stepPrompt;
          } else {
            // All other agents (WriterAgent, DataAnalystAgent, specialist agents, etc.)
            // Use a focused prompt with NO TOOL_DEFINITIONS to prevent JSON/tool-call output
            const today = new Date().toISOString().split('T')[0];
            const language = config?.language || 'Italian';
            sysPrompt = `You are ${agent}, a specialist AI agent inside NHA Studio. Today is ${today}. Respond in ${language}.

CRITICAL RULES:
- Do NOT output JSON, tool calls, function calls, or code blocks
- Do NOT ask for more information — use only the data provided below
- Write in plain prose, structured with headers and bullet points where appropriate
- Be thorough and specific — this is for an executive briefing

${toolData ? `## LIVE DATA:\n${toolData.slice(0, 4000)}\n` : ''}
${context ? `## CONTEXT FROM PREVIOUS AGENTS:\n${context.slice(0, 5000)}\n` : ''}`;
            userMsg = toolData
              ? `Use the live data and context above to complete this task: ${stepPrompt}`
              : context
              ? `Using the context from previous steps, complete this task: ${stepPrompt}`
              : stepPrompt;
          }

          // ── Stream LLM response ───────────────────────────────────────
          let fullOutput = '';
          sendToken(isCanvasAgent ? 'Generating visual report...' : '');
          try {
            await withTimeout(
              callLLMStream(config, sysPrompt, userMsg,
                (token) => { fullOutput += token; if (!isCanvasAgent) sendToken(token); },
              ),
              isCanvasAgent ? 60000 : 35000
            );
          } catch (e) {
            if (!isCanvasAgent) sendToken(`[Error: ${e.message}]`);
          }

          if (isCanvasAgent) {
            let html = fullOutput.trim();
            // Strip thinking tags if not already filtered
            html = html.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            // Extract from markdown code block
            const mdMatch = html.match(/```html?\s*([\s\S]*?)```/i);
            if (mdMatch) html = mdMatch[1].trim();
            // Find <!DOCTYPE or <html start if there's preamble text
            const doctypeIdx = html.indexOf('<!DOCTYPE');
            const htmlTagIdx = html.indexOf('<html');
            const startIdx = doctypeIdx >= 0 ? doctypeIdx : (htmlTagIdx >= 0 ? htmlTagIdx : -1);
            if (startIdx > 0) html = html.slice(startIdx);
            // Fallback: build clean HTML from the context directly (no LLM needed)
            if (!html.trim() || !html.includes('<')) {
              // Try splitting on markdown headings first, then numbered items, then double newlines
              let sections = context.split(/\n#{1,3} /).filter(s => s.trim());
              if (sections.length <= 1) sections = context.split(/\n(?=\*\*\d+[\.\)])|(?=^\d+[\.\)])/).filter(s => s.trim());
              if (sections.length <= 1) sections = context.split(/\n{2,}/).filter(s => s.trim());
              const reportTitle = (task.slice(0, 80) || 'NHA Studio Report').replace(/</g,'&lt;').replace(/>/g,'&gt;');
              const cardsHtml = sections.map(s => {
                const clean = s.replace(/\*\*/g, '').replace(/\*/g, '').trim();
                const lines = clean.split('\n').filter(Boolean);
                const titleLine = lines[0] || '';
                const bodyLines = lines.slice(1).join('\n').trim();
                return `<div class="card">${titleLine ? `<h2>${titleLine.replace(/</g,'&lt;')}</h2>` : ''}<p>${(bodyLines || titleLine).replace(/\n/g, '</p><p>').replace(/</g,'&lt;')}</p></div>`;
              }).join('');
              const safeContext = context.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'</p><p>');
              html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#1e293b;padding:0}
.header{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:48px 40px;margin-bottom:32px}
.header h1{font-size:1.8em;font-weight:700;margin-bottom:8px}
.header p{opacity:.85;font-size:1em}
.content{max-width:900px;margin:0 auto;padding:0 32px 48px}
.card{background:#fff;border-radius:12px;padding:28px;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05);border:1px solid #e2e8f0}
.card h2{color:#6366f1;font-size:1.05em;font-weight:700;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #f1f5f9}
.card p{color:#475569;line-height:1.75;margin-bottom:8px}
.card p:last-child{margin-bottom:0}
</style></head><body>
<div class="header"><h1>${reportTitle}</h1><p>Report generated by NHA Studio</p></div>
<div class="content">${cardsHtml || '<div class="card"><p>' + safeContext + '</p></div>'}</div>
</body></html>`;
            }
            sendToken('\n\n[Report generato]');
            sendEvent({ canvas: html });
          }

          // Estimate token usage (aprox: 1 token ≈ 4 chars)
          const inTokens = Math.ceil((sysPrompt.length + userMsg.length) / 4);
          const outTokens = Math.ceil(fullOutput.length / 4);
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
