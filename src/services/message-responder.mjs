/**
 * Message Responder — auto-responds to Telegram and Discord messages using NHA agents.
 *
 * Runs inside the daemon process. Connects via:
 * - Telegram Bot API (long polling via native fetch, zero dependencies)
 * - Discord Gateway (WebSocket via native net/tls, zero dependencies)
 *
 * Routing: keyword-based (no LLM call) to save API costs. Falls back to CONDUCTOR.
 */

import { callAgent, callLLM } from './llm.mjs';
import { buildSystemPrompt, parseActions, executeTool, TOOL_DEFINITIONS, LIARA_TOOL_DEFINITIONS } from './tool-executor.mjs';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { VERSION } from '../constants.mjs';

// ── Agent Routing (keyword-based, zero LLM calls) ───────────────────────────

const ROUTING_TABLE = [
  {
    // HERALD first — most common daily use case (email, calendar, weather, news)
    // Italian keywords included — Telegram users speak Italian
    agent: 'herald',
    keywords: [
      // Calendar/scheduling EN
      'schedule', 'scheduling', 'meeting', 'meetings', 'calendar',
      'appointment', 'event', 'agenda', 'reminder', 'remind',
      'reschedule', 'book', 'booking', 'slot', 'availability',
      'tomorrow', 'next week', 'today', 'this week',
      // Calendar/scheduling IT
      'calendario', 'appuntamento', 'appuntamenti', 'riunione', 'riunioni',
      'promemoria', 'ricordami', 'prenotazione', 'evento', 'eventi',
      'disponibilità', 'domani', 'settimana', 'oggi', 'questa settimana',
      'prossima settimana', 'orario', 'orari', 'stamattina', 'stasera',
      // Email EN+IT
      'email', 'emails', 'mail', 'inbox', 'unread', 'posta',
      'non lette', 'da leggere', 'controlla', 'controllare',
      'verifica', 'verificare', 'leggi', 'guarda',
      // Weather EN+IT
      'weather', 'temperature', 'forecast',
      'meteo', 'tempo', 'temperatura', 'previsioni', 'piove', 'sole', 'pioggia',
      // News/summary EN+IT
      'news', 'summary', 'briefing', 'notizie', 'riassunto', 'riepilogo',
    ],
  },
  {
    agent: 'saber',
    keywords: [
      'security', 'secure', 'vulnerability', 'vuln', 'exploit', 'attack',
      'pentest', 'penetration', 'cve', 'owasp', 'xss', 'sql injection',
      'firewall', 'malware', 'phishing', 'ransomware', 'encryption',
      'authentication', 'auth', 'csrf', 'ssrf', 'rce', 'injection',
      'sicurezza', 'vulnerabilità', 'attacco', 'hacking',
    ],
  },
  {
    agent: 'forge',
    keywords: [
      'deploy', 'deployment', 'ci', 'cd', 'cicd',
      'docker', 'kubernetes', 'k8s',
      'git', 'commit', 'merge', 'pull request', 'pr', 'branch',
      'debug', 'debugger', 'refactor', 'typescript',
      'rust', 'golang', 'java', 'react', 'npm',
    ],
  },
  {
    agent: 'oracle',
    keywords: [
      'data', 'analysis', 'analyze', 'analytics', 'stats', 'statistics',
      'metric', 'metrics', 'chart', 'graph', 'dashboard', 'report',
      'trend', 'predict', 'prediction', 'dataset',
      'database', 'query', 'sql', 'aggregate', 'visualization',
      'analisi', 'dati', 'grafico', 'statistiche',
    ],
  },
  {
    agent: 'scheherazade',
    keywords: [
      'write', 'writing', 'draft', 'blog', 'article', 'essay',
      'documentation', 'docs', 'readme', 'copywriting',
      'content', 'post', 'newsletter', 'template',
      'summarize', 'summary', 'outline', 'creative', 'story',
      'scrivi', 'scrivere', 'bozza', 'articolo', 'testo', 'riassumi',
    ],
  },
  {
    agent: 'athena',
    keywords: [
      'audit', 'compliance', 'policy', 'governance',
      'risk', 'assessment', 'standard', 'regulation', 'gdpr',
      'hipaa', 'soc2', 'iso', 'framework', 'benchmark',
    ],
  },
  {
    agent: 'sauron',
    keywords: [
      'monitor', 'monitoring', 'alert', 'alerting', 'uptime',
      'downtime', 'health check', 'incident', 'outage',
      'prometheus', 'grafana', 'log', 'logs', 'logging', 'trace',
    ],
  },
];

/**
 * Route a message to the appropriate agent using keyword matching.
 * Returns agent name (lowercase).
 */
function routeMessage(text, useAutoRoute = true) {
  if (!useAutoRoute) return 'conductor';

  const lower = text.toLowerCase();

  let bestAgent = 'conductor';
  let bestScore = 0;

  for (const entry of ROUTING_TABLE) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) {
        // Longer keywords get higher weight to avoid false positives
        score += kw.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestAgent = entry.agent;
    }
  }

  return bestAgent;
}

// ── Language detection from message text ─────────────────────────────────────

const IT_WORDS = new Set(['il','lo','la','le','gli','un','una','che','di','da','in','con','su','per','tra','fra','non','ma','se','come','dove','quando','chi','cosa','ho','hai','ha','sono','sei','siamo','avere','essere','fare','dire','andare','mi','ti','ci','si','vi','li','le','gli','mio','tuo','suo','nostro','vostro','loro','questo','quello','questi','quelli','anche','già','ancora','sempre','mai','oggi','domani','ieri','adesso','ora','poi','dopo','prima','qui','qua','lì','là','più','meno','molto','poco','bene','male','sì','no','grazie','prego','ciao','buongiorno','buonasera','appuntamenti','appuntamento','calendario','riunione','meteo','temperatura','email','posta','notizie','del','dello','della','degli','delle','nel','nello','nella','negli','nelle','dal','dallo','dalla','dagli','dalle','sul','sullo','sulla','sugli','sulle','col','coi','quello','quella','quelli','quelle','cancella','cancellare','elimina','eliminare','crea','creare','sposta','spostare','aggiungi','aggiungere','modifica','modificare','ricerca','trovami','trovare','mostra','mostrami','dimmi','rispondimi','aiutami','puoi','voglio','vorrei','devo','posso','giorno','giorni','mese','mesi','anno','anni','settimana','settimane','ore','minuto','minuti','mattina','pomeriggio','sera','notte','veterinario','medico','dentista','dottore','riunioni','scadenza','scadenze']);
const ES_WORDS = new Set(['el','la','los','las','un','una','que','de','en','con','por','para','pero','como','donde','cuando','quien','qué','tengo','tienes','tiene','somos','soy','eres','hacer','decir','ir','me','te','se','nos','este','ese','estos','esos','también','ya','todavía','siempre','nunca','hoy','mañana','ayer','aquí','allí','más','menos','muy','bien','mal','sí','no','gracias','hola','buenos']);
const FR_WORDS = new Set(['le','la','les','un','une','des','que','de','en','avec','pour','par','mais','comme','où','quand','qui','je','tu','il','elle','nous','vous','ils','elles','avoir','être','faire','dire','aller','me','te','se','ce','cet','cette','ces','aussi','déjà','toujours','jamais','aujourd','demain','hier','ici','là','plus','moins','très','bien','mal','oui','non','merci','bonjour','bonsoir']);
const DE_WORDS = new Set(['der','die','das','ein','eine','und','oder','aber','nicht','mit','für','von','zu','an','auf','ist','sind','hat','haben','sein','werden','ich','du','er','sie','es','wir','ihr','mich','dich','sich','uns','euch','diesem','diesen','dieser','dieses','auch','schon','noch','immer','nie','heute','morgen','gestern','hier','dort','mehr','weniger','sehr','gut','schlecht','ja','nein','danke','hallo']);
const PT_WORDS = new Set(['o','a','os','as','um','uma','que','de','em','com','por','para','mas','como','onde','quando','quem','eu','tu','ele','ela','nós','vós','eles','elas','ter','ser','fazer','dizer','ir','me','te','se','nos','este','esse','isso','aquele','também','já','ainda','sempre','nunca','hoje','amanhã','ontem','aqui','lá','mais','menos','muito','bem','mal','sim','não','obrigado','olá']);

function detectLanguage(text) {
  if (!text || text.length < 6) return null;
  const words = text.toLowerCase().replace(/[^a-zàáâãäèéêëìíîïòóôõöùúûüýñçàèìòù\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  if (words.length < 2) return null;

  let it = 0, es = 0, fr = 0, de = 0, pt = 0, en = 0;
  for (const w of words) {
    if (IT_WORDS.has(w)) it++;
    if (ES_WORDS.has(w)) es++;
    if (FR_WORDS.has(w)) fr++;
    if (DE_WORDS.has(w)) de++;
    if (PT_WORDS.has(w)) pt++;
    // Basic English common words
    if (['the','a','an','is','are','was','were','have','has','do','does','i','you','he','she','we','they','and','or','but','not','with','for','from','to','in','on','at','this','that','these','those','can','will','would','could','should','what','where','when','who','how'].includes(w)) en++;
  }

  const max = Math.max(it, es, fr, de, pt, en);
  if (max === 0) return null;
  const threshold = Math.max(2, words.length * 0.15); // at least 15% of words or 2
  if (max < threshold) return null;

  if (it === max) return 'Italian';
  if (es === max) return 'Spanish';
  if (fr === max) return 'French';
  if (de === max) return 'German';
  if (pt === max) return 'Portuguese';
  if (en === max) return 'English';
  return null;
}

// ── Tool-aware agent call (LLM + tool execution loop) ────────────────────────

/**
 * Call an agent with full tool execution support.
 * Like chat.mjs but headless — no confirmation prompts, all tools auto-executed.
 * Returns a human-readable summary of what was done.
 */
// Detect if a message is a reaction/continuation (not a new independent request)
// Used to decide whether to use sticky agent context
function isContinuationMessage(text, lastCtx) {
  if (!lastCtx) return false;
  const lower = text.toLowerCase().trim();

  // Explicit confirmations / reactions
  const CONFIRMATIONS = ['sì','si','yes','ok','okay','procedi','fallo','vai','confermo','cancellalo',
    'eliminalo','mandalo','esegui','perfetto','giusto','corretto','fatto','bene','certo','esatto',
    'assolutamente','ovviamente','naturalmente','ciao','avanti','go','do it','proceed','confirm',
    'sure','yep','yup','please','per favore','grazie','thanks'];
  if (CONFIRMATIONS.some(c => lower === c || lower.startsWith(c + ' ') || lower.endsWith(' ' + c))) return true;

  // Negative reactions that refer to previous turn (not new requests)
  const REACTIONS = ['no','nope','annulla','stop','lascia perdere','non farlo','aspetta',
    'sbagliato','non è quello','con cazzo','impossibile','stai scherzando','non ci credo',
    'ma va','davvero','sicuro','sei sicuro','ma sei sicuro','ancora','di nuovo','riprova'];
  if (REACTIONS.some(r => lower === r || lower.startsWith(r + ' ') || lower.endsWith(' ' + r))) return true;

  // Short messages (≤ 6 words) without clear new-request keywords are likely continuations
  const words = lower.split(/\s+/);
  if (words.length <= 6) {
    const NEW_REQUEST_KEYWORDS = ['calendario','appuntamento','email','posta','meteo','tempo',
      'crea','aggiungi','cerca','trova','mostra','mandami','dimmi','quanto','quando','dove',
      'create','add','find','search','show','send','delete','cancel','weather','mail','event'];
    const hasNewKeyword = NEW_REQUEST_KEYWORDS.some(k => lower.includes(k));
    if (!hasNewKeyword) return true;
  }

  return false;
}

// Detect if the last agent response indicates a completed action (context should reset after)
function isCompletedAction(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const DONE_SIGNALS = ['cancellato con successo','eliminato con successo','evento eliminato',
    'evento cancellato','deleted successfully','removed successfully','email inviata','email sent',
    'draft created','bozza creata','aggiornato con successo','updated successfully',
    'task completato','task done','creato con successo','created successfully',
    'spostato con successo','moved successfully'];
  return DONE_SIGNALS.some(s => lower.includes(s));
}

async function callAgentWithTools(config, agentName, userMessage, languageOverride, preHistory) {
  const today = new Date().toISOString().split('T')[0];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  const LANG_MAP = { en: 'English', it: 'Italian', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish' };
  const language = languageOverride || config?.profile?.language || config?.language || LANG_MAP[locale.split('-')[0]] || 'English';

  // Use compact Liara prompt when provider is 'nha' (same logic as buildSystemPrompt)
  const isLiara = config?.llm?.provider === 'nha';
  const baseDefinitions = isLiara ? LIARA_TOOL_DEFINITIONS : TOOL_DEFINITIONS;
  const systemPrompt = baseDefinitions
    .replace('{{TODAY}}', today)
    .replace('{{TIMEZONE}}', tz)
    .replace(/\{\{LANGUAGE\}\}/g, language) +
    // Telegram context: execute destructive actions immediately, user already confirmed via chat
    '\n\nTELEGRAM BOT RULES:\n' +
    '- Execute ALL actions (including delete, cancel, send) IMMEDIATELY when the user confirms. Never say "I need an ID" if you can search for the event yourself using calendar_find.\n' +
    '- When you find an event with calendar_find, include its eventId in your reply so the user sees it.\n' +
    '- After completing an action, confirm it simply and clearly. Do not loop back asking for more info.\n' +
    '- If the user says "procedi", "sì", "fallo", "cancellalo" etc. — they are confirming. Execute the action.\n' +
    '- Never ask the user to provide an eventId manually — always search with calendar_find first.';

  // preHistory: full conversation history from previous turn (for sticky confirmations)
  const history = preHistory ? [...preHistory] : [];
  let finalText = '';

  for (let round = 0; round < 5; round++) {
    const parts = history.map(h => (h.role === 'user' ? '[User]' : '[Assistant]') + ' ' + h.content);
    parts.push('[User] ' + userMessage);
    const serialized = parts.join('\n\n');

    const response = await callLLM(config, systemPrompt, serialized);
    const { textParts, actions } = parseActions(response);

    if (actions.length === 0) {
      finalText = textParts.join('\n').trim();
      break;
    }

    // Execute all tools
    const toolResults = [];
    let authError = null;
    for (const { action, params } of actions) {
      try {
        const result = await executeTool(action, params, config);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        toolResults.push(`[${action}] ${resultStr}`);
      } catch (err) {
        // Detect Google/Microsoft OAuth token expiry — give user a clear fix instruction
        const msg = err.message || '';
        const isAuthErr = /invalid.?credentials|token.*expired|unauthorized|401|invalid_grant|auth.*failed|authentication.*failed/i.test(msg);
        if (isAuthErr) {
          authError = action.startsWith('gmail') || action.startsWith('imap') || action.startsWith('calendar') || action.startsWith('contact') || action.startsWith('drive') || action.startsWith('gtask')
            ? 'google' : 'microsoft';
        }
        toolResults.push(`[${action}] Error: ${err.message}`);
      }
    }

    // If auth error detected, return a user-friendly message immediately — don't pass to LLM
    if (authError === 'google') {
      return {
        text: language === 'Italian'
          ? 'Il token Google è scaduto. Esegui questo comando sul tuo computer per rinnovarlo:\n\nnha google auth\n\nDopo il login si rinnova tutto automaticamente.'
          : 'Your Google token has expired. Run this command on your computer to renew it:\n\nnha google auth\n\nAfter logging in everything will work again.',
        history,
      };
    }
    if (authError === 'microsoft') {
      return {
        text: language === 'Italian'
          ? 'Il token Microsoft è scaduto. Esegui:\n\nnha microsoft auth'
          : 'Your Microsoft token has expired. Run:\n\nnha microsoft auth',
        history,
      };
    }

    history.push({ role: 'assistant', content: response });
    userMessage = 'Tool results:\n' + toolResults.join('\n') + '\n\nNow give the user a short, clear confirmation in ' + language + '. Be direct — no preamble, no HERALD format. If an action was completed, say so clearly.';
  }

  return { text: finalText || 'Fatto.', history };
}

// ── Telegram Bot (Long Polling via native fetch) ─────────────────────────────

// ── User store for Telegram chat IDs (for broadcast notifications) ──────────

const TELEGRAM_USERS_FILE = path.join(os.homedir(), '.nha', 'telegram-users.json');

function loadTelegramUsers() {
  try {
    const raw = fs.readFileSync(TELEGRAM_USERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveTelegramUsers(users) {
  try {
    fs.mkdirSync(path.dirname(TELEGRAM_USERS_FILE), { recursive: true });
    fs.writeFileSync(TELEGRAM_USERS_FILE, JSON.stringify(users, null, 2));
  } catch {}
}

function touchTelegramUser(chatId, username, firstName) {
  const users = loadTelegramUsers();
  const id = String(chatId);
  const now = new Date().toISOString();
  users[id] = {
    chatId: id,
    username: username || null,
    firstName: firstName || null,
    firstSeen: users[id]?.firstSeen || now,
    lastSeen: now,
  };
  saveTelegramUsers(users);
}

export function getAllTelegramChatIds() {
  const users = loadTelegramUsers();
  return Object.keys(users);
}

// ── npm update check ─────────────────────────────────────────────────────────

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function checkNpmVersion() {
  const res = await fetch('https://registry.npmjs.org/nothumanallowed/latest', {
    signal: AbortSignal.timeout(8000),
    headers: { 'Accept': 'application/json' },
  });
  const data = await res.json();
  const latest = data.version;
  const current = VERSION;
  const updateAvailable = compareSemver(latest, current) > 0;
  return { current, latest, updateAvailable };
}

// ── Telegram Bot (Long Polling via native fetch) ─────────────────────────────

class TelegramResponder {
  constructor(config, log, wsBroadcast) {
    this.config = config;
    this.log = log;
    this.wsBroadcast = wsBroadcast;
    this.token = config.responder?.telegram?.token || '';
    this.allowedChatIds = config.responder?.telegram?.allowedChatIds || [];
    this.autoRoute = config.responder?.autoRoute !== false;
    this.running = false;
    this.offset = 0;
    this.abortController = null;
    this.pendingRequests = 0;
    this.maxConcurrent = 3;
    this._updateCheckTimer = null;
    this._lastNotifiedVersion = null;
    // Per-chat sticky agent: remembers last agent used, plus last turn context
    this._lastAgentByChatId = {};       // chatId → agentName
    this._lastContextByChatId = {};     // chatId → { agent, userMsg, agentReply, ts }
  }

  get enabled() {
    return !!this.token;
  }

  async start() {
    if (!this.enabled) return;
    this.running = true;
    this.log('[Telegram] Responder started — polling for messages');
    this._pollLoop();
    // Check for npm updates after 60s, then every 24h
    this._updateCheckTimer = setTimeout(() => this._scheduleUpdateCheck(), 60 * 1000);
  }

  stop() {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this._updateCheckTimer) {
      clearTimeout(this._updateCheckTimer);
      clearInterval(this._updateCheckTimer);
      this._updateCheckTimer = null;
    }
    this.log('[Telegram] Responder stopped');
  }

  async _scheduleUpdateCheck() {
    await this._checkAndNotifyUpdate();
    // Then every 24h
    this._updateCheckTimer = setInterval(() => this._checkAndNotifyUpdate(), 24 * 60 * 60 * 1000);
  }

  async _checkAndNotifyUpdate() {
    try {
      const { latest, updateAvailable } = await checkNpmVersion();
      if (!updateAvailable) return;
      if (this._lastNotifiedVersion === latest) return; // Already notified for this version

      this._lastNotifiedVersion = latest;
      const chatIds = getAllTelegramChatIds();
      if (chatIds.length === 0) return;

      const msg =
        `🆕 NHA v${latest} disponibile!\n\n` +
        `Una nuova versione di NotHumanAllowed è stata pubblicata.\n\n` +
        `Aggiorna con:\nnpm install -g nothumanallowed@latest\n\n` +
        `Poi riavvia il bot con: nha ops stop && nha ops start`;

      this.log(`[Telegram] Broadcasting update notification v${latest} to ${chatIds.length} users`);

      for (const chatId of chatIds) {
        try {
          await this._telegramCall('sendMessage', {
            chat_id: parseInt(chatId, 10),
            text: msg,
          });
        } catch {
          // User blocked bot or chat no longer exists — ignore
        }
        // Small delay to avoid Telegram rate limits
        await this._sleep(300);
      }
    } catch (err) {
      this.log(`[Telegram] Update check failed: ${err.message}`);
    }
  }

  async _pollLoop() {
    while (this.running) {
      try {
        this.abortController = new AbortController();
        const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=30&allowed_updates=["message"]`;

        const res = await fetch(url, {
          signal: this.abortController.signal,
          headers: { 'Accept': 'application/json' },
        });

        if (!res.ok) {
          const errText = await res.text();
          this.log(`[Telegram] API error ${res.status}: ${errText}`);
          // Backoff on error
          await this._sleep(5000);
          continue;
        }

        const data = await res.json();

        if (!data.ok || !Array.isArray(data.result)) {
          await this._sleep(2000);
          continue;
        }

        for (const update of data.result) {
          this.offset = update.update_id + 1;

          if (update.message && (update.message.text || update.message.voice || update.message.audio)) {
            // Fire-and-forget with concurrency guard
            if (this.pendingRequests < this.maxConcurrent) {
              this._handleMessage(update.message).catch(err => {
                this.log(`[Telegram] Handle error: ${err.message}`);
              });
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') break;
        this.log(`[Telegram] Poll error: ${err.message}`);
        await this._sleep(5000);
      }
    }
  }

  async _transcribeVoice(fileId) {
    // Download OGG voice note from Telegram and transcribe with Groq or OpenAI Whisper
    // Step 1: get file path
    const fileInfo = await this._telegramCall('getFile', { file_id: fileId });
    const filePath = fileInfo.result?.file_path;
    if (!filePath) throw new Error('Could not get file path from Telegram');

    // Step 2: download OGG bytes
    const token = this.token;
    const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!audioRes.ok) throw new Error(`Download failed: ${audioRes.status}`);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Step 3: transcribe — priority: NHA proxy (no user key needed) → Groq local key → OpenAI local key
    const groqKey = this.config.llm?.groqKey;
    const openaiKey = this.config.llm?.openaiKey || (this.config.llm?.provider === 'openai' ? this.config.llm?.apiKey : null);

    // Option A: NHA voice proxy (server-side Groq key, free for all users)
    try {
      const proxyForm = new FormData();
      proxyForm.append('audio', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
      const proxyRes = await fetch('https://nothumanallowed.com/api/v1/voice/transcribe', {
        method: 'POST',
        body: proxyForm,
        signal: AbortSignal.timeout(30000),
      });
      if (proxyRes.ok) {
        const d = await proxyRes.json();
        if (d.text) return d.text;
      }
      // If proxy returned rate limit or error, fall through to local keys
    } catch {
      // Network error — fall through to local keys
    }

    // Option B: local Groq key
    const boundary = '----NHAVoice' + Date.now().toString(36);
    const crlf = '\r\n';
    const filename = 'voice.ogg';
    const header = Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}` +
      `Content-Type: audio/ogg${crlf}${crlf}`
    );
    const modelPart = Buffer.from(
      `${crlf}--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="model"${crlf}${crlf}` +
      `whisper-large-v3-turbo${crlf}--${boundary}--${crlf}`
    );
    const body = Buffer.concat([header, audioBuffer, modelPart]);

    if (groqKey) {
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      });
      if (!r.ok) throw new Error(`Groq Whisper ${r.status}: ${await r.text()}`);
      const d = await r.json();
      return d.text || '';
    }

    // Option C: local OpenAI key
    if (openaiKey) {
      const modelPartOAI = Buffer.from(
        `${crlf}--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="model"${crlf}${crlf}` +
        `whisper-1${crlf}--${boundary}--${crlf}`
      );
      const bodyOAI = Buffer.concat([header, audioBuffer, modelPartOAI]);
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: bodyOAI,
      });
      if (!r.ok) throw new Error(`OpenAI Whisper ${r.status}: ${await r.text()}`);
      const d = await r.json();
      return d.text || '';
    }

    throw new Error('Voice transcription unavailable. The NHA proxy is temporarily unreachable.');
  }

  async _handleMessage(message) {
    const chatId = message.chat.id;
    const fromUser = message.from?.first_name || message.from?.username || 'Unknown';

    // Chat ID allowlist check
    if (this.allowedChatIds.length > 0 && !this.allowedChatIds.includes(chatId)) {
      return;
    }

    // Track this user for broadcast notifications (update alerts, etc.)
    touchTelegramUser(chatId, message.from?.username, message.from?.first_name);

    let rawText = message.text || '';
    let isVoice = false;

    // Handle voice notes — transcribe with Whisper (Groq or OpenAI)
    if (message.voice || message.audio) {
      const fileId = (message.voice || message.audio).file_id;
      isVoice = true;
      try {
        await this._telegramCall('sendChatAction', { chat_id: chatId, action: 'typing' });
        rawText = await this._transcribeVoice(fileId);
        if (!rawText.trim()) {
          await this._telegramCall('sendMessage', { chat_id: chatId, text: 'Non ho capito il vocale. Riprova.' });
          return;
        }
        this.log(`[Telegram] Voice transcribed for ${fromUser}: "${rawText.slice(0, 80)}"`);
      } catch (err) {
        this.log(`[Telegram] Voice transcription failed: ${err.message}`);
        await this._telegramCall('sendMessage', {
          chat_id: chatId,
          text: `Non riesco a trascrivere il vocale: ${err.message}\n\nAggiungi una chiave Groq (gratuita) con: nha config set groqKey gsk-...`,
        });
        return;
      }
    }

    if (!rawText) return;

    // Skip bot commands that aren't directed at us
    if (rawText.startsWith('/') && !rawText.startsWith('/ask') && !rawText.startsWith('/nha')) {
      return;
    }

    // Strip /ask or /nha prefix if present
    const cleanText = rawText.replace(/^\/(ask|nha)\s*/i, '').trim();
    if (!cleanText) return;

    // If voice: show transcription so user knows what was understood
    if (isVoice) {
      await this._telegramCall('sendMessage', {
        chat_id: chatId,
        text: `🎤 "${cleanText}"`,
      }).catch(() => {});
    }

    this.pendingRequests++;
    try {
      const lastCtx = this._lastContextByChatId[chatId];
      const stickyAge = lastCtx ? (Date.now() - lastCtx.ts) : Infinity;
      const withinStickyWindow = stickyAge < 5 * 60 * 1000; // 5 min

      // Determine if this message is a continuation of the previous turn
      // (confirmation, reaction, short reply) vs a new independent request
      const isContinuation = withinStickyWindow && isContinuationMessage(cleanText, lastCtx);

      // If last response was a completed action, don't carry history forward —
      // the next message is a fresh request even if it looks like a reaction
      const lastWasCompleted = lastCtx && isCompletedAction(lastCtx.agentReply);

      let agent;
      let enrichedMessage = cleanText;
      let preHistory = null;

      if (isContinuation && !lastWasCompleted) {
        // Continue with same agent and inject full history for context
        agent = lastCtx.agent;
        if (lastCtx.history && lastCtx.history.length > 0) {
          preHistory = lastCtx.history;
        }
        this.log(`[Telegram] ${fromUser}: continuation → ${agent.toUpperCase()} (ctx ${Math.round(stickyAge/1000)}s ago, history=${preHistory ? preHistory.length : 0})`);
      } else {
        // Fresh request — route normally
        agent = routeMessage(cleanText, this.autoRoute);
        this.log(`[Telegram] ${fromUser}: new request → ${agent.toUpperCase()}${isVoice ? ' [voice]' : ''}${lastWasCompleted ? ' [prev completed]' : ''}`);
      }

      // Broadcast event
      this.wsBroadcast({
        type: 'responder_message',
        timestamp: new Date().toISOString(),
        data: { platform: 'telegram', from: fromUser, chatId, agent, text: cleanText.slice(0, 120), isVoice },
      });

      // Send typing indicator
      await this._telegramCall('sendChatAction', { chat_id: chatId, action: 'typing' });

      // Language: detect from message, fallback to previous turn's language
      const detectedLang = detectLanguage(cleanText) || (lastCtx ? detectLanguage(lastCtx.userMsg) : null);

      const TOOL_AGENTS = new Set(['herald', 'hermes', 'edi', 'jarvis', 'flux', 'echo', 'mercury', 'pipe', 'navi', 'link', 'prometheus', 'tempest']);
      let responseText;
      let responseHistory = null;

      if (TOOL_AGENTS.has(agent)) {
        const result = await callAgentWithTools(this.config, agent, enrichedMessage, detectedLang, preHistory);
        responseText = result.text;
        responseHistory = result.history;
      } else {
        const langInstruction = detectedLang ? `[Respond in ${detectedLang}] ` : '';
        responseText = await callAgent(this.config, agent, langInstruction + enrichedMessage);
      }

      // Truncate to Telegram limit (4096 chars)
      const truncated = responseText.length > 4000
        ? responseText.slice(0, 3950) + '\n\n... [truncated]'
        : responseText;

      // Save context — if action was completed, mark it so next turn starts fresh
      this._lastContextByChatId[chatId] = {
        agent,
        userMsg: cleanText,
        agentReply: responseText,
        history: isCompletedAction(responseText) ? null : responseHistory, // clear history after success
        ts: Date.now(),
      };
      this._lastAgentByChatId[chatId] = agent;

      await this._telegramCall('sendMessage', {
        chat_id: chatId,
        text: `[${agent.toUpperCase()}]\n\n${truncated}`,
      });

      this.log(`[Telegram] Responded to ${fromUser} via ${agent.toUpperCase()} (${responseText.length} chars)${isCompletedAction(responseText) ? ' [action completed — context reset]' : ''}`);
    } catch (err) {
      this.log(`[Telegram] Agent call failed: ${err.message}`);
      // Send error message to user
      await this._telegramCall('sendMessage', {
        chat_id: chatId,
        text: `Error: ${err.message}`,
      }).catch(() => {});
    } finally {
      this.pendingRequests--;
    }
  }

  async _telegramCall(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram ${method} ${res.status}: ${err}`);
    }
    return res.json();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── Discord Bot (Gateway WebSocket via raw TLS, zero dependencies) ───────────

class DiscordResponder {
  constructor(config, log, wsBroadcast) {
    this.config = config;
    this.log = log;
    this.wsBroadcast = wsBroadcast;
    this.token = config.responder?.discord?.token || '';
    this.allowedChannelIds = config.responder?.discord?.allowedChannelIds || [];
    this.autoRoute = config.responder?.autoRoute !== false;
    this.running = false;
    this.ws = null;
    this.heartbeatInterval = null;
    this.heartbeatAck = true;
    this.sequence = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.pendingRequests = 0;
    this.maxConcurrent = 3;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.botUserId = null;
  }

  get enabled() {
    return !!this.token;
  }

  async start() {
    if (!this.enabled) return;
    this.running = true;
    this.log('[Discord] Responder starting — connecting to gateway');
    await this._connect();
  }

  stop() {
    this.running = false;
    this._clearHeartbeat();
    if (this.ws) {
      try { this.ws.destroy(); } catch {}
      this.ws = null;
    }
    this.log('[Discord] Responder stopped');
  }

  async _connect(resumeUrl) {
    const gatewayUrl = resumeUrl || 'wss://gateway.discord.gg/?v=10&encoding=json';

    try {
      const parsed = new URL(gatewayUrl);
      const port = 443;

      this.ws = https.request({
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Key': Buffer.from(Array.from({ length: 16 }, () => Math.random() * 256 | 0)).toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      });

      this.ws.on('upgrade', (res, socket, head) => {
        this.log('[Discord] WebSocket connected');
        this.reconnectAttempts = 0;
        this._wsBuffer = '';
        this._wsSocket = socket;

        socket.on('data', (chunk) => this._onWsData(chunk));
        socket.on('close', () => this._onClose());
        socket.on('error', (err) => {
          this.log(`[Discord] Socket error: ${err.message}`);
          this._onClose();
        });
      });

      this.ws.on('error', (err) => {
        this.log(`[Discord] Connection error: ${err.message}`);
        this._scheduleReconnect();
      });

      this.ws.end();
    } catch (err) {
      this.log(`[Discord] Connect failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  _onWsData(chunk) {
    // Decode WebSocket frames — Discord sends unmasked text frames
    // This is a minimal frame parser for text frames from server (unmasked)
    let offset = 0;
    const buf = chunk;

    while (offset < buf.length) {
      if (buf.length - offset < 2) break;

      const firstByte = buf[offset];
      const secondByte = buf[offset + 1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let headerLen = 2;

      if (payloadLen === 126) {
        if (buf.length - offset < 4) break;
        payloadLen = buf.readUInt16BE(offset + 2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (buf.length - offset < 10) break;
        payloadLen = Number(buf.readBigUInt64BE(offset + 2));
        headerLen = 10;
      }

      if (isMasked) headerLen += 4;

      const totalLen = headerLen + payloadLen;
      if (buf.length - offset < totalLen) break;

      if (opcode === 1) { // text frame
        const payload = buf.slice(offset + headerLen, offset + headerLen + payloadLen).toString('utf-8');
        this._handleGatewayMessage(payload);
      } else if (opcode === 8) { // close
        const code = payloadLen >= 2 ? buf.readUInt16BE(offset + headerLen) : 1000;
        this.log(`[Discord] Gateway close: ${code}`);
        this._onClose(code);
        return;
      } else if (opcode === 9) { // ping
        this._sendWsFrame(10, buf.slice(offset + headerLen, offset + headerLen + payloadLen));
      }

      offset += totalLen;
    }
  }

  _sendWsFrame(opcode, data) {
    if (!this._wsSocket || this._wsSocket.destroyed) return;

    const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : (data || Buffer.alloc(0));
    const len = payload.length;

    // Client frames MUST be masked
    const mask = Buffer.from(Array.from({ length: 4 }, () => Math.random() * 256 | 0));

    let header;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }

    // Mask the payload
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payload[i] ^ mask[i % 4];
    }

    try {
      this._wsSocket.write(Buffer.concat([header, masked]));
    } catch {}
  }

  _sendJson(data) {
    this._sendWsFrame(1, JSON.stringify(data));
  }

  _handleGatewayMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { op, d, s, t } = msg;

    if (s !== null && s !== undefined) this.sequence = s;

    switch (op) {
      case 10: // HELLO
        this._startHeartbeat(d.heartbeat_interval);
        this._identify();
        break;

      case 11: // HEARTBEAT ACK
        this.heartbeatAck = true;
        break;

      case 1: // HEARTBEAT request
        this._sendHeartbeat();
        break;

      case 7: // RECONNECT
        this.log('[Discord] Gateway requested reconnect');
        this._reconnect();
        break;

      case 9: // INVALID SESSION
        this.log('[Discord] Invalid session, re-identifying');
        setTimeout(() => this._identify(), 1000 + Math.random() * 4000);
        break;

      case 0: // DISPATCH
        this._handleDispatch(t, d);
        break;
    }
  }

  _identify() {
    if (this.sessionId && this.sequence !== null) {
      // Resume
      this._sendJson({
        op: 6,
        d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
      });
      this.log('[Discord] Sent RESUME');
    } else {
      // Fresh identify
      this._sendJson({
        op: 2,
        d: {
          token: this.token,
          intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES | MESSAGE_CONTENT
          properties: { os: 'linux', browser: 'nha-cli', device: 'nha-cli' },
        },
      });
      this.log('[Discord] Sent IDENTIFY');
    }
  }

  _startHeartbeat(intervalMs) {
    this._clearHeartbeat();
    // First heartbeat at random jitter
    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      this._sendHeartbeat();
      this.heartbeatInterval = setInterval(() => {
        if (!this.heartbeatAck) {
          this.log('[Discord] Heartbeat ACK missed — reconnecting');
          this._reconnect();
          return;
        }
        this.heartbeatAck = false;
        this._sendHeartbeat();
      }, intervalMs);
    }, jitter);
  }

  _sendHeartbeat() {
    this._sendJson({ op: 1, d: this.sequence });
  }

  _clearHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _handleDispatch(event, data) {
    switch (event) {
      case 'READY':
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        this.botUserId = data.user?.id;
        this.log(`[Discord] READY — session ${this.sessionId}, bot user ${this.botUserId}`);
        break;

      case 'RESUMED':
        this.log('[Discord] Session resumed');
        break;

      case 'MESSAGE_CREATE':
        this._handleDiscordMessage(data);
        break;
    }
  }

  async _handleDiscordMessage(message) {
    // Ignore bot messages (including our own)
    if (message.author?.bot) return;
    if (message.author?.id === this.botUserId) return;

    const channelId = message.channel_id;
    const text = message.content;
    const fromUser = message.author?.username || 'Unknown';

    if (!text || text.trim().length === 0) return;

    // Channel allowlist check
    if (this.allowedChannelIds.length > 0 && !this.allowedChannelIds.includes(channelId)) {
      return;
    }

    // Only respond to mentions or messages starting with !nha / !ask
    const mentionPattern = this.botUserId ? `<@${this.botUserId}>` : null;
    const isMentioned = mentionPattern && text.includes(mentionPattern);
    const isCommand = text.startsWith('!nha') || text.startsWith('!ask');

    if (!isMentioned && !isCommand) return;

    // Strip prefix
    let cleanText = text;
    if (mentionPattern) cleanText = cleanText.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '');
    cleanText = cleanText.replace(/^!(nha|ask)\s*/i, '').trim();
    if (!cleanText) return;

    if (this.pendingRequests >= this.maxConcurrent) return;
    this.pendingRequests++;

    try {
      const agent = routeMessage(cleanText, this.autoRoute);
      this.log(`[Discord] ${fromUser} (#${channelId}): routed to ${agent.toUpperCase()}`);

      this.wsBroadcast({
        type: 'responder_message',
        timestamp: new Date().toISOString(),
        data: { platform: 'discord', from: fromUser, channelId, agent, text: cleanText.slice(0, 120) },
      });

      // Send typing indicator
      await this._discordApiCall('POST', `/channels/${channelId}/typing`);

      // Tool-capable agents use the full tool execution loop
      const TOOL_AGENTS = new Set(['herald', 'hermes', 'edi', 'jarvis', 'flux', 'echo', 'mercury', 'pipe', 'navi', 'link', 'prometheus', 'tempest']);
      const callFn = TOOL_AGENTS.has(agent) ? callAgentWithTools : callAgent;
      const response = await callFn(this.config, agent, cleanText);

      // Discord message limit is 2000 chars
      const truncated = response.length > 1900
        ? response.slice(0, 1850) + '\n\n... [truncated]'
        : response;

      // Send response
      await this._discordApiCall('POST', `/channels/${channelId}/messages`, {
        content: `**[${agent.toUpperCase()}]**\n\n${truncated}`,
      });

      this.log(`[Discord] Responded to ${fromUser} via ${agent.toUpperCase()} (${response.length} chars)`);
    } catch (err) {
      this.log(`[Discord] Agent call failed: ${err.message}`);
      await this._discordApiCall('POST', `/channels/${channelId}/messages`, {
        content: `Error: ${err.message}`,
      }).catch(() => {});
    } finally {
      this.pendingRequests--;
    }
  }

  async _discordApiCall(method, endpoint, body) {
    const res = await fetch(`https://discord.com/api/v10${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'NHA-CLI (https://nothumanallowed.com, 5.0)',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Discord API ${method} ${endpoint}: ${res.status} ${err}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return null;
  }

  _onClose(code) {
    this._clearHeartbeat();
    if (!this.running) return;

    // Certain close codes mean we should not reconnect
    const nonRecoverable = [4004, 4010, 4011, 4012, 4013, 4014];
    if (code && nonRecoverable.includes(code)) {
      this.log(`[Discord] Non-recoverable close code ${code} — stopping`);
      this.running = false;
      return;
    }

    this._scheduleReconnect();
  }

  _reconnect() {
    this._clearHeartbeat();
    if (this._wsSocket) {
      try { this._wsSocket.destroy(); } catch {}
      this._wsSocket = null;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.running) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('[Discord] Max reconnect attempts reached — stopping');
      this.running = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.log(`[Discord] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      if (this.running) {
        this._connect(this.resumeGatewayUrl || undefined);
      }
    }, delay);
  }
}

// ── Exported API ─────────────────────────────────────────────────────────────

let _telegramInstance = null;
let _discordInstance = null;

/**
 * Start the message responder for all configured platforms.
 * Called from the daemon loop.
 *
 * @param {object} config — NHA config
 * @param {function} log — log function
 * @param {function} wsBroadcast — WebSocket broadcast function
 */
export function startResponder(config, log, wsBroadcast) {
  stopResponder();

  const hasAnyToken = config.responder?.telegram?.token || config.responder?.discord?.token;
  if (!hasAnyToken) {
    log('[Responder] No tokens configured — skipping');
    return { telegram: false, discord: false };
  }

  if (!config.llm?.apiKey) {
    log('[Responder] No LLM API key — cannot respond to messages');
    return { telegram: false, discord: false };
  }

  const result = { telegram: false, discord: false };

  if (config.responder?.telegram?.token) {
    _telegramInstance = new TelegramResponder(config, log, wsBroadcast);
    _telegramInstance.start();
    result.telegram = true;
  }

  if (config.responder?.discord?.token) {
    _discordInstance = new DiscordResponder(config, log, wsBroadcast);
    _discordInstance.start();
    result.discord = true;
  }

  return result;
}

/**
 * Stop all responder instances.
 */
export function stopResponder() {
  if (_telegramInstance) {
    _telegramInstance.stop();
    _telegramInstance = null;
  }
  if (_discordInstance) {
    _discordInstance.stop();
    _discordInstance = null;
  }
}

/**
 * Get responder status.
 */
export function getResponderStatus() {
  return {
    telegram: {
      enabled: _telegramInstance?.enabled || false,
      running: _telegramInstance?.running || false,
      pending: _telegramInstance?.pendingRequests || 0,
    },
    discord: {
      enabled: _discordInstance?.enabled || false,
      running: _discordInstance?.running || false,
      pending: _discordInstance?.pendingRequests || 0,
      sessionId: _discordInstance?.sessionId || null,
    },
  };
}

export { routeMessage };
