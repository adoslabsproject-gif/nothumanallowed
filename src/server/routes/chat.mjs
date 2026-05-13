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
import { parseActions, executeTool, executeToolAndRemember, buildSystemPrompt, stripOrphanFences } from '../../services/tool-executor.mjs';
import { detectLanguage, tryDirectActionAll } from '../../services/message-responder.mjs';

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

    // Inject language instruction — detect from the user's message first;
    // fall back to config.language only when detection is inconclusive (very
    // short messages, codes, etc.). Detected language is authoritative
    // because users routinely interact in their natural language regardless
    // of the dropdown setting.
    const LANG_MAP = { it:'Italian', en:'English', es:'Spanish', fr:'French', de:'German', pt:'Portuguese', nl:'Dutch', pl:'Polish', ru:'Russian', zh:'Chinese', ja:'Japanese', ko:'Korean', ar:'Arabic', hi:'Hindi', tr:'Turkish', sv:'Swedish', da:'Danish', fi:'Finnish', cs:'Czech' };
    const settingLang = LANG_MAP[(config?.language || config?.lang || 'en').slice(0,2)] || 'English';
    const detectedFromMsg = detectLanguage(effectiveMsg);
    const userLang = detectedFromMsg || settingLang;
    // Prepend the language directive at the TOP of the system prompt — many
    // models give the highest weight to early instructions. Also append a
    // reinforcement at the end. Belt and suspenders for language stickiness.
    const langHeader = `[LANGUAGE — HIGHEST PRIORITY]\nRespond ENTIRELY in ${userLang}. From the very first word to the last word, every sentence must be in ${userLang}. Never start in English then switch — that includes intro fillers like "Let me…", "I'll…", "Sure,…". If you find yourself about to write in English, stop and write the same sentence in ${userLang} instead.\n\n`;
    enrichedPrompt = langHeader + enrichedPrompt;
    if (!enrichedPrompt.toLowerCase().endsWith('respond in ' + userLang.toLowerCase() + '.')) {
      enrichedPrompt += `\n\nIMPORTANT: Output language is ${userLang}. Do NOT switch languages mid-response.`;
    }

    // ── Conversation history → structured messages[] (Fix 1, v16.0.12) ──
    // ChatGPT/Claude pass full history as messages[]. We do the same: each
    // turn keeps its own {role, content} so the model sees a real
    // conversation, not a concatenated string. The rolling SUMMARY of older
    // turns (Fix 2) is injected as a context prefix in the system prompt.
    const rawHistory = (body.history || []).map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: (h.content || '').replace(/!\[Screenshot\]\(data:image\/[^)]+\)/g, '[Screenshot taken]'),
    })).filter(m => m.content);

    // ── Rolling summary (Fix 2) — TOKEN-based threshold ──
    // Industry pattern (Claude context compaction, ChatGPT memory): trigger
    // summary when the OLDER messages would consume more than a budget,
    // measured in tokens (~chars/4). Provider-aware budget:
    //   - anthropic / openai / gemini → 24k tokens raw before summary
    //   - nha (Liara/Qwen 32B 32k ctx) → 8k tokens raw before summary
    //   - others → 8k as safe default
    // Plus per-turn cap of MAX_RECENT turns so latency stays bounded.
    const provider = config.llm?.provider || (config.llm?.apiKey ? 'anthropic' : 'nha');
    const TOKEN_BUDGET_BY_PROVIDER = {
      anthropic: 24000, openai: 24000, gemini: 24000,
      nha: 8000, deepseek: 16000, grok: 16000, mistral: 16000, cohere: 8000,
    };
    const tokenBudget = TOKEN_BUDGET_BY_PROVIDER[provider] || 8000;
    const MAX_RECENT_TURNS = 30;     // hard cap (latency safeguard)
    const approxTokens = (s) => Math.ceil((s || '').length / 4);

    let conversationSummary = '';
    let recentHistory = rawHistory;
    if (rawHistory.length > 0) {
      // Walk backwards accumulating tokens until we exceed the budget OR
      // hit MAX_RECENT_TURNS. Everything BEFORE that index goes into summary.
      let recentTokens = 0;
      let splitIdx = 0;
      for (let i = rawHistory.length - 1; i >= 0; i--) {
        const t = approxTokens(rawHistory[i].content);
        if (recentTokens + t > tokenBudget) { splitIdx = i + 1; break; }
        if (rawHistory.length - i > MAX_RECENT_TURNS) { splitIdx = i + 1; break; }
        recentTokens += t;
        splitIdx = i;
      }
      recentHistory = rawHistory.slice(splitIdx);
      const older = rawHistory.slice(0, splitIdx);

      if (older.length > 0) {
        // Reuse cached summary when the older slice hasn't grown.
        let cachedConv = null;
        if (body.conversationId) {
          try { cachedConv = loadConversation(body.conversationId); } catch {}
        }
        const cached = cachedConv?.rollingSummary;
        if (cached && cached.coveredTurns === older.length) {
          conversationSummary = cached.text;
        } else {
          // Build summary input in user language. Trim individual turns to
          // 1200 chars each (older context loses fine-grained details).
          const summaryInput = older.map(m =>
            `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1200)}`
          ).join('\n\n');
          const langLabel = userLang === 'it' ? 'in italiano' : `in ${userLang}`;
          try {
            conversationSummary = await callLLM(
              config,
              `You are a conversation summarizer. Summarize ${langLabel} in 200-500 tokens ALL facts, decisions, user preferences, specific data (dates, IDs, names, numbers, file paths, URLs) that emerged. No fluff, only information useful to reconstruct context. Preserve the language the user spoke in.`,
              summaryInput,
              { max_tokens: 700, temperature: 0.2 },
            );
            // Meta-compress: if the previous cached summary exists AND together
            // with new content the result would balloon, replace fully with the
            // new compact one (we just generated it from full older slice).
            if (cachedConv) {
              cachedConv.rollingSummary = {
                text: conversationSummary,
                coveredTurns: older.length,
                coveredTokens: older.reduce((a, m) => a + approxTokens(m.content), 0),
                at: new Date().toISOString(),
              };
              try { saveConversation(cachedConv); } catch {}
            }
          } catch { /* if summary fails, just skip it — recent history is enough */ }
        }
      }
    }

    // Inject summary into the system prompt — it's the cheapest way for the
    // model to see it AND it benefits from prompt caching on Anthropic.
    if (conversationSummary) {
      effectiveSystemPrompt = `${effectiveSystemPrompt || ''}\n\n[CONTESTO CONVERSAZIONE PRECEDENTE]\n${conversationSummary}\n[FINE CONTESTO]`;
    }

    // ── User memory (Fix 3) — persistent across conversations + channels ──
    // Loaded from ~/.nha/user-memory.md, prepended to the system prompt.
    try {
      const { buildMemoryPrefix, autoLearnFromTurn } = await import('../../services/user-memory.mjs');
      const memPrefix = buildMemoryPrefix();
      if (memPrefix) effectiveSystemPrompt = `${memPrefix}${effectiveSystemPrompt || ''}`;
      // Auto-learn — fire and forget, doesn't block the response.
      autoLearnFromTurn(msg, config).catch(() => null);
    } catch {}

    // The final user message — keep the per-turn language tag close to the
    // model's first generated token.
    const userMessage = `[User · respond in ${userLang}] ${effectiveMsg}`;
    // History passed to the provider as proper messages[] (not concatenated).
    const historyForLLM = recentHistory;

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
      // ── Deterministic direct-action dispatcher (LLM-NLU + server execute) ──
      // Same architecture used by Telegram/Discord. Before invoking the chat
      // LLM, classify the message: if it maps to a state-changing tool
      // (calendar/email/task/file/drive/slack/notion/github/...), execute it
      // deterministically server-side and stream the result. No more "the
      // model said done but didn't call the tool".
      const direct = await tryDirectActionAll(msg, config, {
        auditKey: `chat:${body.conversationId || 'anon'}`,
      });
      if (direct) {
        if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
        sse('tool', { action: direct.action, status: 'done', result: (direct.message || '').slice(0, 240) });
        sse('token', { content: direct.message });
        // Persist to conversation
        if (body.conversationId) {
          try {
            const conv = loadConversation(body.conversationId);
            if (conv) addMessages(conv, msg, direct.message);
          } catch {}
        }
        sse('done', { content: direct.message });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      let fullResponse = '';
      fullResponse = await callLLMStream(config, enrichedPrompt, userMessage, (chunk) => {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        sse('token', { content: chunk });
      }, { history: historyForLLM });

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
      // Auto-detect email reading intent — force the right IMAP tool if the
      // LLM didn't emit one. Semantic keywords (offerta/RFQ/preventivo/...)
      // trigger `imap_search` across all synced messages with each variant,
      // because users almost never want "just the 5 latest" — they want
      // "everything matching X". Generic "leggi le email" still falls back
      // to imap_list. Multi-language: it/en/de/fr/es.
      const lower = msg.toLowerCase();
      const wantsReadEmail = /\b(leggi|read|mostra|lista|ultime?|recenti?|email|mail|inbox|posta)\b.*\b(email|mail|messag|inbox|posta)\b|\b(email|mail)\b.*\b(leggi|read|mostra|lista|ultime?|recenti?)\b/i.test(msg);
      // Semantic intent → quote / offer / proposal / order requests
      const QUOTE_KEYWORDS = {
        offerta:    ['offerta', 'richiesta offerta', 'richiesta di offerta', 'preventivo', 'quotazione', 'rdo', 'rda'],
        quote:      ['quote', 'quotation', 'rfq', 'rfp', 'request for quote', 'request for proposal', 'price request', 'pricing'],
        order:      ['ordine', 'order', 'po ', 'purchase order', 'commessa', 'bestellung', 'commande'],
        invoice:    ['fattura', 'invoice', 'rechnung', 'facture'],
        proposal:   ['proposta', 'proposal', 'angebot', 'devis'],
      };
      let semanticBag = null;
      if (/\b(offert|preventiv|quotaz|rdo\b|rda\b|quotation|rfq|rfp|request\s+for\s+(quote|proposal|pricing)|price\s+request|pricing|angebot|devis|proposta|proposal)/i.test(lower)) {
        semanticBag = 'offerta';
      } else if (/\b(ordin|order|purchase\s+order|po\s+\d|commessa|bestellung|commande)/i.test(lower)) {
        semanticBag = 'order';
      } else if (/\b(fattur|invoice|rechnung|facture)/i.test(lower)) {
        semanticBag = 'invoice';
      } else if (/\b(propost|proposal|angebot|devis)/i.test(lower)) {
        semanticBag = 'proposal';
      }

      // "allegato / attachment / PDF" → user wants to read the content of
      // an attachment of a specific email. We extract identifier tokens from
      // the message (capitalized phrases, alphanumeric codes with dots/slashes
      // like "NCSARMEMAIL.08/05", PO numbers, etc.) and search the local DB
      // for matching subjects, then chain imap_read + imap_attachment_read
      // server-side. This bypasses the LLM's habit of saying "Let me read..."
      // without actually emitting the tool.
      const wantsReadAttachment = /\b(allegato|attachment|allegata|allegat[oi]|pdf|documento\s+allegato|file\s+allegato|enclosed|attached)\b/i.test(msg);

      if ((wantsReadEmail || semanticBag || wantsReadAttachment) && !actions.some(a => a.action?.startsWith('imap_') || a.action === 'list_emails')) {
        try {
          const { listAccounts: _la } = await import('../../services/email-db.mjs');
          const imapAccs = _la();
          if (imapAccs.length > 0) {
            const firstAcc = imapAccs[0];
            if (wantsReadAttachment) {
              // Extract subject identifiers from the user message. Heuristic:
              // - Quoted substrings ("..." or «...»)
              // - Alphanumeric codes ≥4 chars with dot/slash/dash (PO/RDA codes)
              // - Capitalized multi-word phrases ("Purchase Order", "Tagliando BMW")
              // - Standalone uppercase tokens ≥4 chars (NCSARMEMAIL)
              const ids = new Set();
              const quoted = msg.match(/["«""']([^"«»""'\n]{3,80})["»""']/g) || [];
              quoted.forEach(q => ids.add(q.replace(/^["«""']|["»""']$/g, '').trim()));
              const codes = msg.match(/\b[A-Z0-9][A-Z0-9._/\-]{3,}\b/g) || [];
              codes.forEach(c => ids.add(c));
              const phrases = msg.match(/\b([A-Z][a-zà-ÿ]+(?:\s+[A-Za-zà-ÿ0-9]+){1,3})\b/g) || [];
              phrases.filter(p => p.length >= 6).forEach(p => ids.add(p));
              const tokens = [...ids].slice(0, 5);
              if (tokens.length === 0) {
                // No specific identifier — fall back to a broad list of recent
                // messages with attachments.
                actions.push({ action: 'imap_list', params: { accountId: firstAcc.id, limit: 30 } });
              } else {
                for (const q of tokens) {
                  actions.push({ action: 'imap_search', params: { accountId: firstAcc.id, query: q, limit: 10 } });
                }
              }
            } else if (semanticBag) {
              // Push one imap_search per keyword variant in the bag. The
              // synthesis step will dedupe overlapping hits.
              const bag = QUOTE_KEYWORDS[semanticBag] || [];
              const variants = [
                ...(QUOTE_KEYWORDS.offerta || []).slice(0, 3),
                ...(QUOTE_KEYWORDS.quote   || []).slice(0, 3),
                ...bag,
              ];
              const unique = [...new Set(variants)].slice(0, 6);
              for (const q of unique) {
                actions.push({ action: 'imap_search', params: { accountId: firstAcc.id, query: q, limit: 50 } });
              }
            } else {
              const limitMatch = msg.match(/\b(\d+)\b/);
              const limit = limitMatch ? Math.min(parseInt(limitMatch[1]), 50) : 20;
              actions.push({ action: 'imap_list', params: { accountId: firstAcc.id, limit } });
            }
          }
        } catch { /* fallback to LLM response */ }
      }

      for (const { action, params } of actions) {
        if (action === 'web_search' && wantsScreenshot) params.screenshot = true;
        sse('tool', { action, status: 'executing' });
        try {
          // Use the remembering variant so list-tools auto-populate the
          // anaphoric cache (~/.nha/list-cache.json). Same chatId/auditKey
          // pattern as direct-action handlers.
          const auditKey = `chat:${body.conversationId || 'anon'}`;
          const result = await executeToolAndRemember(action, params, config, auditKey);

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

      // ── Auto-chain: search → read → attachment_read ──────────────────────
      // When the user wants to read an attachment of a specific email, the
      // model often emits the first search but then gets stuck saying "Let
      // me read the full email" without actually emitting the follow-up
      // tool. We chain them server-side: parse the imap_search results,
      // pick the best subject match, fetch it with imap_read, then read
      // the first attachment if wantsReadAttachment is on.
      if (wantsReadAttachment) {
        try {
          // Collect candidate messages from all imap_search results we already
          // executed in this turn. Format of imap_search output:
          //   [id_xxx] [UNREAD] From: name | Subject | date\n  preview...
          const candidates = new Map(); // id → { id, subject }
          for (const tr of toolResults) {
            if (tr.action !== 'imap_search' || typeof tr.result !== 'string') continue;
            const lineRe = /\[([a-zA-Z0-9_-]{6,})\][^\n]*?\|\s*([^|]{2,200})\s*\|/g;
            let m;
            while ((m = lineRe.exec(tr.result)) !== null) {
              if (!candidates.has(m[1])) candidates.set(m[1], { id: m[1], subject: m[2].trim() });
            }
          }
          if (candidates.size > 0) {
            // Rank by token-overlap with the identifiers we extracted from
            // the user message.
            const norm = (s) => String(s || '').toLowerCase()
              .normalize('NFD').replace(/[̀-ͯ]/g, '')
              .replace(/[^a-z0-9\s./_-]/g, ' ')
              .split(/\s+/).filter(t => t.length > 2);
            const userTokens = norm(msg);
            const ranked = [...candidates.values()].map(c => {
              const subjTokens = new Set(norm(c.subject));
              const score = userTokens.filter(t => subjTokens.has(t)).length;
              return { ...c, score };
            }).sort((a, b) => b.score - a.score);
            const best = ranked[0];
            if (best && best.score >= 1) {
              sse('tool', { action: 'imap_read', status: 'executing' });
              try {
                const readResult = await executeTool('imap_read', { messageId: best.id }, config);
                toolResults.push({ action: 'imap_read', result: readResult });
                sse('tool', { action: 'imap_read', status: 'done', result: String(readResult).slice(0, 500) });
                // If the read result lists at least one attachment, fetch it.
                const attMatch = String(readResult).match(/ATTACHMENTS \(\d+\)/);
                if (attMatch) {
                  sse('tool', { action: 'imap_attachment_read', status: 'executing' });
                  try {
                    const attResult = await executeTool('imap_attachment_read', { messageId: best.id, index: 1 }, config);
                    toolResults.push({ action: 'imap_attachment_read', result: attResult });
                    sse('tool', { action: 'imap_attachment_read', status: 'done', result: String(attResult).slice(0, 500) });
                  } catch (e) {
                    toolResults.push({ action: 'imap_attachment_read', result: `Error: ${e.message}` });
                    sse('tool', { action: 'imap_attachment_read', status: 'error', error: e.message });
                  }
                }
              } catch (e) {
                toolResults.push({ action: 'imap_read', result: `Error: ${e.message}` });
                sse('tool', { action: 'imap_read', status: 'error', error: e.message });
              }
            }
          }
        } catch { /* chain best-effort — fall through to synthesis */ }
      }

      // Capture the pre-synthesis prose (what the model said in Round 1).
      // We will combine this with the synthesis output so the user keeps
      // BOTH — currently the UI was overwriting Round 1 with Round 2 alone,
      // which made long prose disappear and leave only "Let me read…".
      const round1Prose = fullResponse;

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
        const synthesisPrompt = `${enrichedPrompt}\n\n## DATA FROM TOOLS (already executed — do NOT plan to call them again):\n${toolContext}\n\n## STRICT OUTPUT RULES:\n- LANGUAGE: respond ENTIRELY in ${userLang}. Do not switch languages mid-answer, do not mix English and ${userLang}.\n- The tools above HAVE ALREADY RUN. Their output is the ground truth.\n- NEVER say "Let me read…", "I'll search…", "I will fetch…", "leggerò", "cercherò", "ti dirò" — those tools are already done.\n- Answer the user's question DIRECTLY using the data above. If a specific detail (delivery date, item, total, etc.) is in the data, quote it verbatim.\n- If the data does not contain the answer, state plainly what is missing — do not announce intent to look further.\n- Write ONLY plain prose or markdown (headers, bullets, bold). NEVER use \`\`\`json or any fenced code block.\n- Format numbers/prices as plain text. Be concise and human-readable.`;
        const synthesisMsg = `[LANGUAGE: respond entirely in ${userLang}, every sentence] ${effectiveMsg}\n\nThe tools have already been executed and their results are in the system prompt. Answer the question DIRECTLY using that data. Do NOT announce further actions ("Let me…", "I'll…", "leggerò", "cercherò"). Plain prose/markdown — zero JSON, zero code blocks. EVERY sentence must be in ${userLang}.`;
        sse('tool_synthesis', {});
        // Keep the pre-synthesis prose around. If the synthesis call returns
        // empty (provider error, content filter, model bailed), we fall back
        // to "first-round prose + raw tool output" so the user never sees a
        // blank message and can still read what the tools returned.
        const preSynthesis = fullResponse;
        let synthesized = '';
        try {
          synthesized = await callLLMStream(config, synthesisPrompt, synthesisMsg, (chunk) => {
            sse('token', { content: chunk });
          });
        } catch (synthErr) {
          sse('error', { message: `Synthesis failed: ${synthErr.message}` });
        }
        if (synthesized && synthesized.trim()) {
          fullResponse = synthesized;
        } else {
          // Fallback: stream the raw tool context so the user gets the data
          // even when the LLM round failed silently.
          const fallback = (preSynthesis && preSynthesis.trim() ? preSynthesis.trim() + '\n\n' : '') +
            toolResults.map(t => `**${t.action}**\n${cleanResult(t.action, t.result)}`).join('\n\n');
          sse('token', { content: fallback });
          fullResponse = fallback;
        }
      }

      // Strip orphan tool-fence blocks that the LLM may have emitted as
      // a "no-more-tools" marker (e.g. empty ```json ``` or '''json ''').
      // They leaked into the chat panel as visible noise.
      //
      // Also combine Round 1 prose with synthesis output when a synthesis
      // round actually happened, so the user sees BOTH the model's intro
      // ("Leggerò l'email…") AND the synthesized result, instead of one
      // overwriting the other.
      const round1Clean = stripOrphanFences(round1Prose || '');
      const synthClean  = stripOrphanFences(fullResponse || '');
      let cleanFullResponse;
      if (toolResults.length > 0 && round1Clean && synthClean && round1Clean !== synthClean) {
        cleanFullResponse = `${round1Clean}\n\n${synthClean}`;
      } else {
        cleanFullResponse = synthClean || round1Clean;
      }

      // Persist to conversation. Honour retry/edit flags so the tree forks
      // correctly instead of duplicating the user message in the active path.
      //   - isRetry: add the new response as a sibling of the last assistant
      //     under the same user node (no new user node).
      //   - isEdit:  add the new user message as a sibling of an existing
      //     user node, then chain the assistant under the new branch.
      //   - default: addMessages (creates user+assistant pair).
      if (body.conversationId) {
        try {
          const conv = loadConversation(body.conversationId);
          if (conv) {
            if (body.isRetry) {
              // Find the most recent user node in the active path — that's
              // the parent we're regenerating from.
              const path = getHistory(conv, 100);
              const lastUser = [...path].reverse().find(n => n.role === 'user');
              if (lastUser?.id) {
                addRetryResponse(conv, lastUser.id, cleanFullResponse);
              } else {
                addMessages(conv, msg, cleanFullResponse);
              }
            } else if (body.isEdit && typeof body.editFromIdx === 'number') {
              // Active path is a flat list; index editFromIdx in the UI maps
              // 1:1 to the same index in the active path. Branch from there.
              const path = getHistory(conv, 100);
              const target = path[body.editFromIdx];
              if (target?.id && target.role === 'user') {
                const newUserId = editMessage(conv, target.id, msg);
                if (newUserId) addRetryResponse(conv, newUserId, cleanFullResponse);
                else addMessages(conv, msg, cleanFullResponse);
              } else {
                addMessages(conv, msg, cleanFullResponse);
              }
            } else {
              addMessages(conv, msg, cleanFullResponse);
            }
          }
        } catch {}
      }

      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
      sse('done', { content: cleanFullResponse });
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
      const settingLang = LANG_MAP[(config?.language || config?.lang || 'en').slice(0,2)] || 'English';
      const detectedFromMsg = detectLanguage(body.message);
      const userLang = detectedFromMsg || settingLang;
      enrichedPrompt += `\n\nIMPORTANT: The user wrote their message in ${userLang}. Respond in ${userLang}.`;

      // Direct-action pre-step — but ONLY when there's no attachment. With
      // a PDF/image, the user wants the model to *read* the file; we don't
      // want to short-circuit that into a tool call. With pure-text /api/chat
      // (non-streaming), same dispatcher as the streaming variant.
      if (!body.pdfBase64 && !body.imageBase64 && !body.fileContent) {
        const direct = await tryDirectActionAll(body.message, config, {
          auditKey: `chat-ns:${body.conversationId || 'anon'}`,
        });
        if (direct) {
          return sendJSON(res, 200, { response: direct.message });
        }
      }

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
