/**
 * Chat routes — conversations CRUD + streaming chat with tool execution
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { sendJSON, sendError, parseBody, sendSSE } from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { NHA_DIR, AGENTS_DIR } from '../../constants.mjs';
import {
  createConversation, loadConversation, saveConversation, deleteConversation,
  listConversations, setActiveId, getHistory, addMessages, retryMessage,
  addRetryResponse, editMessage, navigateFork, getForkInfo,
  exportAsMarkdown, exportAsJson, migrateOldHistory,
} from '../../services/conversations.mjs';
import { callLLMStream, callLLM, callLLMVision, parseAgentFile } from '../../services/llm.mjs';
import { buildMemoryContext } from '../../services/memory.mjs';
import { parseActions, executeTool, buildSystemPrompt } from '../../services/tool-executor.mjs';

// Migrate on import (once)
migrateOldHistory();

const UI_PERSONA = `You are NHA Chat, a personal operations assistant inside the NotHumanAllowed web UI. \
You help the user manage their emails, calendar, tasks, GitHub issues, Notion pages, and Slack channels through natural conversation. \
Be concise, helpful, and proactive. When presenting data, format it clearly. \
Never output raw JSON to the user.`;

let _chatSystemPrompt = null;
async function getChatSystemPrompt() {
  if (!_chatSystemPrompt) {
    const config = loadConfig();
    _chatSystemPrompt = await buildSystemPrompt('NHA UI', UI_PERSONA, config);
  }
  return _chatSystemPrompt;
}

async function getImapAccountsContext() {
  try {
    const { listAccounts } = await import('../../services/email-db.mjs');
    const accs = listAccounts();
    if (!accs.length) return '';
    let ctx = '\n\n--- IMAP EMAIL ACCOUNTS (custom, already configured) ---\n';
    ctx += 'Use these accountIds directly in imap_* tools — do NOT call imap_accounts() first.\n';
    for (const a of accs) {
      ctx += `accountId: "${a.id}" | email: ${a.email_address} | name: "${a.display_name}" | status: ${a.sync_status}\n`;
    }
    return ctx;
  } catch { return ''; }
}

const CONV_RE = /^\/api\/conversations\/([a-z0-9-]+)$/;
const CONV_ACTION_RE = /^\/api\/conversations\/([a-z0-9-]+)\/(export|retry|retry-response|navigate|forks|edit)$/;

export function register(router) {

  // ── Conversations CRUD ──────────────────────────────────────────────────

  router.get('/api/conversations', (_req, res) => {
    sendJSON(res, 200, { conversations: listConversations() });
  });

  router.post('/api/conversations', (_req, res) => {
    const conv = createConversation();
    setActiveId(conv.id);
    sendJSON(res, 201, { conversation: conv });
  });

  // Dynamic: GET/DELETE/PATCH /api/conversations/:id
  router.get(CONV_RE, (req, res) => {
    const id = req.url.match(CONV_RE)?.[1];
    const conv = loadConversation(id);
    if (!conv) return sendError(res, 404, 'Conversation not found');
    sendJSON(res, 200, { conversation: conv });
  });

  router.delete(CONV_RE, (req, res) => {
    const id = req.url.match(CONV_RE)?.[1];
    const ok = deleteConversation(id);
    sendJSON(res, ok ? 200 : 404, { ok });
  });

  router.patch(CONV_RE, async (req, res) => {
    const id = req.url.match(CONV_RE)?.[1];
    const body = await parseBody(req);
    const conv = loadConversation(id);
    if (!conv) return sendError(res, 404, 'Not found');
    if (body.title) conv.title = body.title;
    saveConversation(conv);
    sendJSON(res, 200, { conversation: conv });
  });

  // Dynamic: /api/conversations/:id/export|retry|navigate|forks|edit
  router.get(CONV_ACTION_RE, async (req, res) => {
    const m = req.url.match(CONV_ACTION_RE);
    const [, id, action] = m;
    if (action === 'export') {
      const conv = loadConversation(id);
      if (!conv) return sendError(res, 404, 'Not found');
      const url = new URL(req.url, 'http://localhost');
      const fmt = url.searchParams.get('format') || 'md';
      if (fmt === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="nha-chat-${id}.json"` });
        res.end(exportAsJson(conv));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Disposition': `attachment; filename="nha-chat-${id}.md"` });
        res.end(exportAsMarkdown(conv));
      }
      return;
    }
    if (action === 'forks') {
      const conv = loadConversation(id);
      if (!conv) return sendError(res, 404, 'Not found');
      const messages = getHistory(conv);
      const forks = {};
      for (const msg of messages) {
        const info = getForkInfo(conv, msg.id);
        if (info) forks[msg.id] = info;
      }
      return sendJSON(res, 200, { forks });
    }
    sendError(res, 404, 'Not found');
  });

  router.post(CONV_ACTION_RE, async (req, res) => {
    const m = req.url.match(CONV_ACTION_RE);
    const [, id, action] = m;
    const conv = loadConversation(id);
    if (!conv) return sendError(res, 404, 'Not found');
    const body = await parseBody(req);

    if (action === 'retry') {
      const userNodeId = retryMessage(conv, body.assistantNodeId);
      if (!userNodeId) return sendError(res, 400, 'Invalid message');
      return sendJSON(res, 200, { userNodeId, userContent: conv.tree?.[userNodeId]?.content });
    }
    if (action === 'retry-response') {
      const newId = addRetryResponse(conv, body.userNodeId, body.content);
      return sendJSON(res, 200, { nodeId: newId, messages: getHistory(conv) });
    }
    if (action === 'navigate') {
      const ok = navigateFork(conv, body.nodeId, body.direction);
      return sendJSON(res, 200, { ok, messages: getHistory(conv) });
    }
    if (action === 'edit') {
      const ok = editMessage(conv, body.nodeId, body.content);
      return sendJSON(res, 200, { ok, messages: getHistory(conv) });
    }
    sendError(res, 404, 'Not found');
  });

  // ── Streaming Chat ──────────────────────────────────────────────────────

  router.post('/api/chat/stream', async (req, res) => {
    const body = await parseBody(req);
    if (!body.message) return sendError(res, 400, 'message required');

    const config = loadConfig();
    if (!config.llm.provider || (!config.llm.apiKey && config.llm.provider !== 'nha')) {
      config.llm.provider = 'nha';
    }

    const msg = body.message.trim();
    const chatSystemPrompt = await getChatSystemPrompt();

    // @agent inline routing OR body.agent param (from Agents panel)
    let effectiveSystemPrompt = config._chatAgent?.systemPrompt || null;
    let effectiveMsg = msg;

    // Direct systemPrompt override (e.g. Conductor synthesis call)
    if (body.systemPrompt) {
      effectiveSystemPrompt = body.systemPrompt;
    }

    // body.agent takes priority (Agents view sends { agent: 'saber', message: '...' })
    if (body.agent) {
      const agentFile = path.join(AGENTS_DIR, `${body.agent.toLowerCase()}.mjs`);
      if (fs.existsSync(agentFile)) {
        const parsed = parseAgentFile(fs.readFileSync(agentFile, 'utf-8'), body.agent);
        if (parsed.systemPrompt) effectiveSystemPrompt = parsed.systemPrompt;
      }
      // Fallback: use system prompt sent directly by client (from agent card)
      if (!effectiveSystemPrompt && body._agentSystemPrompt) {
        effectiveSystemPrompt = body._agentSystemPrompt;
      }
    } else {
      // @agent inline routing
      const atMatch = msg.match(/^@(\w+)\s+([\s\S]*)/);
      if (atMatch) {
        const agentFile = path.join(AGENTS_DIR, `${atMatch[1].toLowerCase()}.mjs`);
        if (fs.existsSync(agentFile)) {
          const parsed = parseAgentFile(fs.readFileSync(agentFile, 'utf-8'), atMatch[1]);
          if (parsed.systemPrompt) effectiveSystemPrompt = parsed.systemPrompt;
        }
        effectiveMsg = atMatch[2];
      }
    }

    let enrichedPrompt = effectiveSystemPrompt || chatSystemPrompt;
    try { const m = buildMemoryContext('chat', effectiveMsg); if (m) enrichedPrompt = enrichedPrompt + m; } catch {}
    try { const ic = await getImapAccountsContext(); if (ic) enrichedPrompt += ic; } catch {}

    // Inject language instruction — always respects user's lang setting
    const LANG_MAP = { it:'Italian', en:'English', es:'Spanish', fr:'French', de:'German', pt:'Portuguese', nl:'Dutch', pl:'Polish', ru:'Russian', zh:'Chinese', ja:'Japanese', ko:'Korean', ar:'Arabic', hi:'Hindi', tr:'Turkish', sv:'Swedish', da:'Danish', fi:'Finnish', cs:'Czech' };
    const userLang = LANG_MAP[(config?.language || config?.lang || 'en').slice(0,2)] || 'English';
    if (!enrichedPrompt.toLowerCase().includes('respond in') && !enrichedPrompt.toLowerCase().includes('rispondi in')) {
      enrichedPrompt += `\n\nIMPORTANT: Always respond in ${userLang}.`;
    }

    // Rolling context window
    const rawHistory = (body.history || []).map(h => ({
      role: h.role,
      content: (h.content || '').replace(/!\[Screenshot\]\(data:image\/[^)]+\)/g, '[Screenshot taken]'),
    }));
    const RECENT = 6;
    const parts = [];
    if (rawHistory.length > RECENT) {
      const older = rawHistory.slice(0, -RECENT);
      const lines = [];
      for (let i = 0; i < older.length; i += 2) {
        const u = older[i]?.content?.slice(0, 150)?.replace(/\n/g, ' ') || '';
        const a = older[i+1]?.content?.slice(0, 200)?.replace(/\n/g, ' ') || '';
        if (u) lines.push(`- User: "${u.trim()}${u.length >= 150 ? '...' : ''}" → ${a.trim()}${a.length >= 200 ? '...' : ''}`);
      }
      if (lines.length) parts.push(`[CONVERSATION CONTEXT]\n${lines.join('\n')}\n[END CONTEXT]`);
    }
    for (const t of rawHistory.slice(-RECENT)) {
      parts.push(`${t.role === 'user' ? '[User]' : '[Assistant]'} ${t.content.slice(0, 2000)}`);
    }
    parts.push(`[User] ${effectiveMsg}`);
    const userMessage = parts.join('\n\n');

    // Attachments — handle non-streaming
    if (body.imageBase64 || body.pdfBase64 || body.fileContent) {
      return sendJSON(res, 200, { error: 'attachments_use_regular', redirect: '/api/chat' });
    }

    // SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    sse('processing', {});

    let heartbeatInterval = setInterval(() => {
      try { sse('processing', { ts: Date.now() }); } catch {}
    }, 3000);

    try {
      let fullResponse = '';
      fullResponse = await callLLMStream(config, enrichedPrompt, userMessage, (chunk) => {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        sse('token', { content: chunk });
      });

      const { textParts, actions } = parseActions(fullResponse);
      const toolResults = [];

      // Auto-detect intent
      const wantsScreenshot = /screenshot|screen\s*shot|schermo|cattura|foto|immagine/i.test(msg);
      const wantsSearch = /\b(cerca|search|find|look\s*up|ricerca|cercare)\b/i.test(msg);
      if (wantsSearch && !actions.some(a => a.action === 'web_search')) {
        const q = msg.replace(/\b(cerca|search|find|look\s*up|ricerca|cercare|screenshot|screen\s*shot)\b/gi, '').trim();
        if (q.length > 2) actions.push({ action: 'web_search', params: { query: q, screenshot: wantsScreenshot } });
      }
      // domain → browser_open
      for (const a of actions) {
        if (a.action === 'web_search' && /^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(a.params.query?.trim())) {
          a.action = 'browser_open';
          a.params = { url: 'https://' + a.params.query.trim() };
        }
      }
      // Auto-detect email reading intent — force imap_list if LLM didn't emit the tool
      const wantsReadEmail = /\b(leggi|read|mostra|lista|ultime?|recenti?|email|mail|inbox|posta)\b.*\b(email|mail|messag|inbox|posta)\b|\b(email|mail)\b.*\b(leggi|read|mostra|lista|ultime?|recenti?)\b/i.test(msg);
      if (wantsReadEmail && !actions.some(a => a.action?.startsWith('imap_') || a.action === 'list_emails')) {
        try {
          const { listAccounts: _la } = await import('../../services/email-db.mjs');
          const imapAccs = _la();
          if (imapAccs.length > 0) {
            const firstAcc = imapAccs[0];
            const limitMatch = msg.match(/\b(\d+)\b/);
            const limit = limitMatch ? Math.min(parseInt(limitMatch[1]), 20) : 5;
            actions.push({ action: 'imap_list', params: { accountId: firstAcc.id, limit } });
          }
        } catch { /* fallback to LLM response */ }
      }

      for (const { action, params } of actions) {
        if (action === 'web_search' && wantsScreenshot) params.screenshot = true;
        sse('tool', { action, status: 'executing' });
        try {
          const result = await executeTool(action, params, config);

          // ── Screenshot result handling ───────────────────────────────────
          if (result && typeof result === 'object' && result.__screenshot) {
            // Copy file to ~/.nha/screenshots/ so the UI can load it via /api/screenshots/
            let screenshotUrl = null;
            try {
              const ssDir = path.join(os.homedir(), '.nha', 'screenshots');
              if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
              const filename = `screenshot-${Date.now()}.png`;
              const destPath = path.join(ssDir, filename);
              if (result.path && fs.existsSync(result.path)) {
                fs.copyFileSync(result.path, destPath);
                screenshotUrl = `/api/screenshots/${filename}`;
              } else if (result.base64) {
                fs.writeFileSync(destPath, Buffer.from(result.base64, 'base64'));
                screenshotUrl = `/api/screenshots/${filename}`;
              }
            } catch { /* fallback — no image shown */ }

            // Vision analysis — LLM describes what's in the screenshot
            let visionDescription = 'Screenshot captured.';
            if (result.base64) {
              try {
                visionDescription = await callLLMVision(config, 'You are a helpful assistant describing a screenshot.', result.question || 'Describe EXACTLY and ONLY what you see in this screenshot.', { base64: result.base64, mediaType: 'image/png' });
              } catch { /* keep default description */ }
            }

            toolResults.push({ action, result: visionDescription });
            sse('tool', { action, status: 'done', result: visionDescription.slice(0, 500) });
            if (screenshotUrl) sse('screenshot', { url: screenshotUrl });
            continue;
          }

          let resultStr = typeof result === 'object' ? JSON.stringify(result) : String(result);
          if ((action === 'web_search' || action === 'fetch_url') && resultStr.includes('<')) {
            resultStr = resultStr
              .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n').trim().slice(0, 6000);
          }

          // ── Canvas result — emit dedicated SSE event so the UI panel opens ──
          if (resultStr.includes('[CANVAS_RENDER]')) {
            const canvasMarker = resultStr.match(/\[CANVAS_RENDER\]([\s\S]*?)\[\/CANVAS_RENDER\]/);
            if (canvasMarker) {
              sse('canvas', { markers: canvasMarker[0] });
            }
            // Replace the raw HTML blob with a short placeholder so synthesis LLM doesn't see it
            resultStr = 'Canvas rendered successfully in the panel.';
          }

          toolResults.push({ action, result: resultStr });
          sse('tool', { action, status: 'done', result: resultStr.slice(0, 500) });
        } catch (e) {
          toolResults.push({ action, result: `Error: ${e.message}` });
          sse('tool', { action, status: 'error', error: e.message });
        }
      }

      // Synthesis round if tools ran
      if (toolResults.length > 0) {
        // Strip raw JSON from tool results — present as clean prose summaries
        const cleanResult = (_action, raw) => {
          const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
          // If it's already plain text (web_search returns plain text), return as-is
          if (!s.startsWith('{') && !s.startsWith('[')) return s.slice(0, 4000);
          try {
            const obj = JSON.parse(s);
            if (Array.isArray(obj)) {
              // Array of search results — format as numbered list
              return obj.slice(0, 5).map((r, i) => `${i+1}. ${r.title || r.name || ''}\n   ${r.snippet || r.description || r.url || ''}`).join('\n');
            }
            if (obj.results && Array.isArray(obj.results)) {
              return obj.results.slice(0, 5).map((r, i) => `${i+1}. ${r.title || ''}\n   ${r.snippet || r.url || ''}`).join('\n');
            }
            if (obj.content) return String(obj.content).slice(0, 4000);
            if (obj.text)    return String(obj.text).slice(0, 4000);
            if (obj.snippet) return String(obj.snippet).slice(0, 2000);
            if (obj.error)   return `Error: ${obj.error}`;
            // Generic: format key-value pairs as readable text
            return Object.entries(obj).slice(0, 20).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v}`).join('\n');
          } catch {
            return s.slice(0, 4000);
          }
        };
        const toolContext = toolResults.map(t => `[${t.action} result]:\n${cleanResult(t.action, t.result)}`).join('\n\n---\n\n');
        const synthesisPrompt = `${enrichedPrompt}\n\n## DATA FROM TOOLS:\n${toolContext}\n\n## STRICT OUTPUT RULES:\n- Write ONLY plain prose or markdown (headers, bullets, bold)\n- NEVER use \`\`\`json, \`\`\`data, or any fenced code block containing data\n- NEVER output raw JSON, arrays, or objects\n- Format numbers/prices as plain text (e.g. "Bitcoin: $103,000")\n- Be concise and human-readable`;
        const synthesisMsg = `${effectiveMsg}\n\nAnswer using ONLY the data above. Plain text/markdown only — zero JSON, zero code blocks.`;
        sse('tool_synthesis', {});
        fullResponse = '';
        fullResponse = await callLLMStream(config, synthesisPrompt, synthesisMsg, (chunk) => {
          sse('token', { content: chunk });
        });
      }

      // Persist to conversation
      if (body.conversationId) {
        try {
          const conv = loadConversation(body.conversationId);
          if (conv) {
            addMessages(conv, msg, fullResponse);
          }
        } catch {}
      }

      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
      sse('done', { content: fullResponse });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
      sse('error', { message: e.message });
      res.end();
    }
  });

  // POST /api/chat — non-streaming, for attachments (PDF, image, text file)
  router.post('/api/chat', async (req, res) => {
    try {
      const body = await parseBody(req);
      if (!body.message) return sendError(res, 400, 'message required');
      const config = loadConfig();
      const chatSystemPrompt = await getChatSystemPrompt();
      let enrichedPrompt = chatSystemPrompt;
      try { const ic = await getImapAccountsContext(); if (ic) enrichedPrompt += ic; } catch {}
      const LANG_MAP = { it:'Italian', en:'English', es:'Spanish', fr:'French', de:'German', pt:'Portuguese', nl:'Dutch', pl:'Polish', ru:'Russian', zh:'Chinese', ja:'Japanese', ko:'Korean', ar:'Arabic', hi:'Hindi', tr:'Turkish', sv:'Swedish', da:'Danish', fi:'Finnish', cs:'Czech' };
      const userLang = LANG_MAP[(config?.language || config?.lang || 'en').slice(0,2)] || 'English';
      enrichedPrompt += `\n\nIMPORTANT: Always respond in ${userLang}.`;

      let response;

      if (body.pdfBase64) {
        const userMsg = body.message || 'Analyze this PDF document and describe its content.';
        const provider = config?.llm?.provider || 'nha';
        if (provider === 'nha') {
          // Liara Vision non supporta PDF — estrai testo grezzo dal base64 come fallback
          const buf = Buffer.from(body.pdfBase64, 'base64');
          const rawText = buf.toString('latin1').replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s{4,}/g, '\n').slice(0, 20000);
          const fileCtx = `\n\n--- PDF: ${body.pdfName || 'document.pdf'} (testo estratto) ---\n${rawText}\n--- END PDF ---`;
          response = await callLLM(config, enrichedPrompt + fileCtx, userMsg);
        } else {
          // Anthropic/OpenAI/Gemini — vision nativa per PDF
          response = await callLLMVision(config, enrichedPrompt, userMsg, {
            base64: body.pdfBase64,
            mediaType: 'application/pdf',
            fileName: body.pdfName || 'document.pdf',
          });
        }
      } else if (body.imageBase64) {
        // Image — vision call
        const userMsg = body.message || 'Describe what you see in this image.';
        response = await callLLMVision(config, enrichedPrompt, userMsg, {
          base64: body.imageBase64,
          mediaType: body.imageMimeType || 'image/png',
        });
      } else if (body.fileContent) {
        // Text file — inject content into prompt
        const fileCtx = `\n\n--- FILE: ${body.fileName || 'file'} ---\n${String(body.fileContent).slice(0, 40000)}\n--- END FILE ---`;
        response = await callLLM(config, enrichedPrompt + fileCtx, body.message);
      } else {
        response = await callLLM(config, enrichedPrompt, body.message);
      }

      sendJSON(res, 200, { response });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/ask — single-turn non-streaming chat
  router.post('/api/ask', async (req, res) => {
    try {
      const body = await parseBody(req);
      if (!body.message) return sendError(res, 400, 'message required');
      const config = loadConfig();
      const chatSystemPrompt = await getChatSystemPrompt();
      const response = await callLLM(config, chatSystemPrompt, body.message);
      sendJSON(res, 200, { response });
    } catch (e) { sendError(res, 500, e.message); }
  });
}
