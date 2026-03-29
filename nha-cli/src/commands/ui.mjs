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
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config.mjs';
import { detectMailProvider, hasMailProvider, getProviderStatus } from '../services/mail-router.mjs';
import { callLLM, callAgent, parseAgentFile } from '../services/llm.mjs';
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
import { getHTML } from '../services/web-ui.mjs';
import { loadChatHistory, saveChatHistory, extractMemory, buildMemoryContext } from '../services/memory.mjs';
import { info, ok, fail, warn, C, G, D, NC, BOLD } from '../ui.mjs';
import {
  parseActions,
  executeTool,
  formatTime as fmtTime,
  buildSystemPrompt,
} from '../services/tool-executor.mjs';

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3847;

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
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
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
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
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

      // GET /api/status
      if (method === 'GET' && pathname === '/api/status') {
        sendJSON(res, 200, {
          connected: true,
          version: VERSION,
          provider: config.llm.provider,
          hasApiKey: !!config.llm.apiKey,
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
          hasApiKey: !!config.llm?.apiKey,
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

      // GET /api/emails?filter=unread|all (default: all inbox)
      if (method === 'GET' && pathname === '/api/emails') {
        try {
          const filter = url.searchParams.get('filter');
          let emails;
          if (filter === 'unread') {
            emails = await getUnreadImportant(config, 20);
          } else {
            // Show all recent inbox emails (read + unread)
            const gm = await import('../services/google-gmail.mjs');
            const msgRefs = await gm.listMessages(config, 'in:inbox', 30);
            emails = [];
            for (const ref of msgRefs.slice(0, 30)) {
              try {
                const msg = await gm.getMessage(config, ref.id);
                emails.push(msg);
              } catch { /* skip */ }
            }
          }
          sendJSON(res, 200, { emails });
        } catch (e) {
          sendJSON(res, 200, { emails: [], error: e.message });
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

        if (!config.llm.apiKey) {
          sendJSON(res, 200, { response: 'No API key configured. Run: nha config set key YOUR_KEY', error: 'no_api_key' });
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        // Build message with history (merge persisted + request history)
        const requestHistory = body.history || [];
        const parts = [];
        for (const turn of requestHistory) {
          const prefix = turn.role === 'user' ? '[User]' : '[Assistant]';
          parts.push(`${prefix} ${turn.content}`);
        }
        parts.push(`[User] ${body.message}`);
        const userMessage = parts.join('\n\n');

        // Inject episodic memory context into the system prompt
        let enrichedSystemPrompt = chatSystemPrompt;
        try {
          const memCtx = buildMemoryContext('chat', body.message);
          if (memCtx) enrichedSystemPrompt = chatSystemPrompt + memCtx;
        } catch { /* memory unavailable */ }

        try {
          const response = await callLLM(config, enrichedSystemPrompt, userMessage);
          const { textParts, actions } = parseActions(response);
          const textResponse = textParts.join('\n\n');

          // Execute ALL tool actions and collect results
          const toolResults = [];
          for (const { action, params } of actions) {
            try {
              const result = await executeTool(action, params, config);
              toolResults.push({ action, result: typeof result === 'object' ? JSON.stringify(result) : String(result) });
            } catch (e) {
              toolResults.push({ action, result: `Error: ${e.message}` });
            }
          }

          let fullResponse;
          if (toolResults.length > 0) {
            // Second LLM call with real tool results — forces the LLM to use actual data
            const toolContext = toolResults.map(t => `[${t.action} result]: ${t.result}`).join('\n\n');
            const followUp = `The user asked: "${body.message}"\n\nI executed these tools and got REAL results:\n\n${toolContext}\n\nNow respond to the user based ONLY on the REAL data above. Do NOT invent or fabricate any information. Present the actual results clearly.`;
            try {
              fullResponse = await callLLM(config, enrichedSystemPrompt, followUp);
            } catch {
              // Fallback: show raw results
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

      // GET /api/agents
      if (method === 'GET' && pathname === '/api/agents') {
        sendJSON(res, 200, { agents: agentCards });
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

        if (!config.llm.apiKey) {
          sendJSON(res, 200, { response: null, error: 'No API key configured.' });
          logRequest(method, pathname, 200, Date.now() - start);
          return;
        }

        if (!AGENTS.includes(body.agent)) {
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

  // ── WebSocket via ws package (compatible with Node.js 20-24+) ──────
  let wss = null;
  try {
    const { WebSocketServer } = await import('ws');
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      ws.on('error', () => {});
    });
  } catch {
    // ws package not available — WS disabled, everything else works
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
