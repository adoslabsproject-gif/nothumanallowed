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
import { buildSystemPrompt, parseActions, executeTool, TOOL_DEFINITIONS, LIARA_TOOL_DEFINITIONS, DESTRUCTIVE_ACTIONS } from './tool-executor.mjs';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { VERSION } from '../constants.mjs';

// ── Global audit log helpers (Fix 4 v16.0.12) ──
// Append-only JSONL at ~/.nha/audit-log.jsonl, shared across every channel
// (telegram, discord, chat web, AWF agents). Lets the user ask "what have you
// done today?" from any surface and get a consistent answer.
const _GLOBAL_AUDIT_FILE = path.join(os.homedir(), '.nha', 'audit-log.jsonl');
const _AUDIT_MAX_LINES = 10000;          // rotate at 10k lines (~1MB JSONL)
const _AUDIT_ARCHIVE_PREFIX = 'audit-log-';

function _rotateAuditIfNeeded() {
  try {
    if (!fs.existsSync(_GLOBAL_AUDIT_FILE)) return;
    const stat = fs.statSync(_GLOBAL_AUDIT_FILE);
    // Quick check: skip the line count unless file is bigger than ~1.5MB
    if (stat.size < 1_500_000) return;
    const text = fs.readFileSync(_GLOBAL_AUDIT_FILE, 'utf-8');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length <= _AUDIT_MAX_LINES) return;
    // Archive older half, keep most recent _AUDIT_MAX_LINES.
    const tail = lines.slice(-_AUDIT_MAX_LINES);
    const archived = lines.slice(0, lines.length - _AUDIT_MAX_LINES);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveFile = path.join(path.dirname(_GLOBAL_AUDIT_FILE), `${_AUDIT_ARCHIVE_PREFIX}${ts}.jsonl`);
    fs.writeFileSync(archiveFile, archived.join('\n') + '\n');
    fs.writeFileSync(_GLOBAL_AUDIT_FILE, tail.join('\n') + '\n');
  } catch {}
}

function _appendGlobalAudit(entry) {
  try {
    fs.mkdirSync(path.dirname(_GLOBAL_AUDIT_FILE), { recursive: true });
    fs.appendFileSync(_GLOBAL_AUDIT_FILE, JSON.stringify(entry) + '\n');
    // Rotate occasionally (cheap stat-check; full scan only if size > 1.5MB).
    if (Math.random() < 0.01) _rotateAuditIfNeeded();
  } catch {}
}

function _readGlobalAudit(limitTail = 100) {
  try {
    if (!fs.existsSync(_GLOBAL_AUDIT_FILE)) return [];
    const text = fs.readFileSync(_GLOBAL_AUDIT_FILE, 'utf-8');
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-limitTail)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Query the audit log with filters. Exported for the HTTP /api/audit/query
 * endpoint. Supports filtering by tool, channel, since timestamp.
 */
export function queryAuditLog({ tool, channel, since, limit = 100 } = {}) {
  const all = _readGlobalAudit(10000);
  return all.filter(e => {
    if (tool && e.tool !== tool) return false;
    if (channel && e.channel !== channel) return false;
    if (since && e.ts < since) return false;
    return true;
  }).slice(-limit);
}

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
      // Calendar action verbs IT/EN — without these, "cancella appuntamento"
      // falls through to CONDUCTOR which has no calendar context.
      'cancella', 'cancellare', 'cancellalo', 'cancellali',
      'elimina', 'eliminare', 'eliminalo', 'eliminali',
      'rimuovi', 'rimuovere',
      'sposta', 'spostare', 'sposto',
      'modifica', 'modificare', 'modificalo',
      'correggi', 'correggere',
      'rinomina', 'rinominare',
      'delete', 'remove', 'move', 'update', 'rename', 'reschedule',
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

const IT_WORDS = new Set(['il','lo','la','le','gli','un','una','che','di','da','in','con','su','per','tra','fra','non','ma','se','come','dove','quando','chi','cosa','ho','hai','ha','sono','sei','siamo','avere','essere','fare','dire','andare','mi','ti','ci','si','vi','li','le','gli','mio','tuo','suo','nostro','vostro','loro','questo','quello','questi','quelli','anche','già','ancora','sempre','mai','oggi','domani','ieri','adesso','ora','poi','dopo','prima','qui','qua','lì','là','più','meno','molto','poco','bene','male','sì','no','grazie','prego','ciao','buongiorno','buonasera','appuntamenti','appuntamento','calendario','riunione','meteo','temperatura','email','posta','notizie','del','dello','della','degli','delle','nel','nello','nella','negli','nelle','dal','dallo','dalla','dagli','dalle','sul','sullo','sulla','sugli','sulle','col','coi','quello','quella','quelli','quelle','cancella','cancellare','elimina','eliminare','crea','creare','sposta','spostare','aggiungi','aggiungere','modifica','modificare','ricerca','trovami','trovare','mostra','mostrami','dimmi','rispondimi','aiutami','puoi','voglio','vorrei','devo','posso','giorno','giorni','mese','mesi','anno','anni','settimana','settimane','ore','minuto','minuti','mattina','pomeriggio','sera','notte','veterinario','medico','dentista','dottore','riunioni','scadenza','scadenze',
  // Apostrophe-truncated forms produced when we strip apostrophes during tokenization (`dell'email` → tokens `dell`, `email`).
  'dell','all','nell','sull','dall','un','nell','quell',
  // High-frequency content words missing from the original list — common in IMAP / calendar / order use cases.
  'leggi','leggere','dammi','dammelo','dammela','ricevuto','ricevuta','ricevute','allegato','allegati','allegata','alle','articolo','articoli','ordine','ordini','consegna','consegne','fattura','fatture','preventivo','preventivi','offerta','offerte','richiesta','richieste','documento','documenti','prezzo','prezzi','totale','spedizione','cliente','clienti','fornitore','fornitori','data','date','codice','codici']);
const ES_WORDS = new Set(['el','la','los','las','un','una','que','de','en','con','por','para','pero','como','donde','cuando','quien','qué','tengo','tienes','tiene','somos','soy','eres','hacer','decir','ir','me','te','se','nos','este','ese','estos','esos','también','ya','todavía','siempre','nunca','hoy','mañana','ayer','aquí','allí','más','menos','muy','bien','mal','sí','no','gracias','hola','buenos']);
const FR_WORDS = new Set(['le','la','les','un','une','des','que','de','en','avec','pour','par','mais','comme','où','quand','qui','je','tu','il','elle','nous','vous','ils','elles','avoir','être','faire','dire','aller','me','te','se','ce','cet','cette','ces','aussi','déjà','toujours','jamais','aujourd','demain','hier','ici','là','plus','moins','très','bien','mal','oui','non','merci','bonjour','bonsoir']);
const DE_WORDS = new Set(['der','die','das','ein','eine','und','oder','aber','nicht','mit','für','von','zu','an','auf','ist','sind','hat','haben','sein','werden','ich','du','er','sie','es','wir','ihr','mich','dich','sich','uns','euch','diesem','diesen','dieser','dieses','auch','schon','noch','immer','nie','heute','morgen','gestern','hier','dort','mehr','weniger','sehr','gut','schlecht','ja','nein','danke','hallo']);
const PT_WORDS = new Set(['o','a','os','as','um','uma','que','de','em','com','por','para','mas','como','onde','quando','quem','eu','tu','ele','ela','nós','vós','eles','elas','ter','ser','fazer','dizer','ir','me','te','se','nos','este','esse','isso','aquele','também','já','ainda','sempre','nunca','hoje','amanhã','ontem','aqui','lá','mais','menos','muito','bem','mal','sim','não','obrigado','olá']);

export function detectLanguage(text) {
  if (!text || text.length < 6) return null;
  const raw = text.toLowerCase();
  // Bonus signals — language-distinctive patterns that survive even when the
  // message is dominated by codes, identifiers, or proper nouns (which is the
  // common case for "leggi l'allegato dell'email NCSARMEMAIL.08/05"-style
  // queries). Each pattern adds to its language's score.
  const bonus = { it: 0, es: 0, fr: 0, de: 0, pt: 0, en: 0 };
  // IT-distinctive: articulated prepositions with apostrophe — these forms
  // exist in Italian but NOT in French (French uses `du / au / aux`, not `dell' / all'`).
  if (/\b(dell'|nell'|sull'|dall'|all'|un'[aeiou]|com'è|dov'è|qual'è)\w/.test(raw)) bonus.it += 3;
  if (/\b(c'è|c'era|d'accordo|po'\s|più\s|però\s|perché\s|cioè\s)/.test(raw)) bonus.it += 2;
  if (/[àèéìòù]/.test(raw) && !/\bj'|qu'/.test(raw)) bonus.it += 1;
  // FR-distinctive: pronoun apostrophes that don't exist in Italian.
  if (/\b(j'ai|n'est|n'a\s|c'est|qu'il|qu'elle|qu'on|n'ont)/.test(raw)) bonus.fr += 4;
  if (/\b(qu'|j'|n'|s')\w/.test(raw)) bonus.fr += 2;
  if (/\b(ñ|ll\w+)\b/.test(raw)) bonus.es += 1;
  if (/[äöüß]/.test(raw)) bonus.de += 2;
  if (/\b(ção|ões|nh)\w*/.test(raw)) bonus.pt += 1;

  const words = raw.replace(/[^a-zàáâãäèéêëìíîïòóôõöùúûüýñçàèìòù\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  if (words.length < 2 && Object.values(bonus).every(b => b === 0)) return null;

  let it = bonus.it, es = bonus.es, fr = bonus.fr, de = bonus.de, pt = bonus.pt, en = bonus.en;
  for (const w of words) {
    if (IT_WORDS.has(w)) it++;
    if (ES_WORDS.has(w)) es++;
    if (FR_WORDS.has(w)) fr++;
    if (DE_WORDS.has(w)) de++;
    if (PT_WORDS.has(w)) pt++;
    if (['the','a','an','is','are','was','were','have','has','do','does','i','you','he','she','we','they','and','or','but','not','with','for','from','to','in','on','at','this','that','these','those','can','will','would','could','should','what','where','when','who','how'].includes(w)) en++;
  }

  const max = Math.max(it, es, fr, de, pt, en);
  if (max === 0) return null;
  // Threshold lowered for short or code-heavy messages — bonus signals are
  // strong enough on their own. Still require a clear winner: if two
  // languages tie, return null (caller falls back to setting).
  const threshold = Math.max(2, Math.min(words.length * 0.12, 4));
  if (max < threshold) return null;
  const tieCount = [it, es, fr, de, pt, en].filter(s => s === max).length;
  if (tieCount > 1) return null;

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
    // ONLY truly fresh-topic verbs go here. Action verbs that operate on a
    // referenced item ("cancella X", "elimina Y", "sposta Z") are NOT fresh
    // requests — they continue the previous turn. Previously `delete` and
    // `cancel` were here and broke sticky-mode for Italian users (because
    // `cancel` is a substring of `cancella`).
    const NEW_REQUEST_KEYWORDS = ['calendario','appuntamento','email','posta','meteo','tempo',
      'crea','aggiungi','cerca','trova','mostra','mandami','dimmi','quanto','quando','dove',
      'create','add','find','search','show','send','weather','mail','event'];
    // Use word-boundary matching to avoid false positives (e.g. "cancel" inside "cancella")
    const hasNewKeyword = NEW_REQUEST_KEYWORDS.some(k => {
      const re = new RegExp(`\\b${k}\\b`, 'i');
      return re.test(lower);
    });
    if (!hasNewKeyword) return true;
  }

  return false;
}

// Detect if the last agent response indicates a completed action (context should reset after)
function isCompletedAction(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Specific high-confidence signals
  const DONE_SIGNALS = ['cancellato con successo','eliminato con successo','evento eliminato',
    'evento cancellato','deleted successfully','removed successfully','email inviata','email sent',
    'draft created','bozza creata','aggiornato con successo','updated successfully',
    'task completato','task done','creato con successo','created successfully',
    'spostato con successo','moved successfully'];
  if (DONE_SIGNALS.some(s => lower.includes(s))) return true;
  // Broader patterns (v16.0.21 guardrail): "è stato X", "l'ho fatto", "ho cancellato".
  // These catch HERALD-style narrations like "L'appuntamento è stato spostato al 19 maggio".
  const BROAD = /\b(è\s+(stat[ao]|stat[ei])\s+(cancellat[ao]i?|eliminat[ao]i?|rimoss[ao]i?|spostat[ao]i?|modificat[ao]i?|aggiornat[ao]i?|creat[ao]i?|inviat[ao]i?|inoltrat[ao]i?|archiviat[ao]i?|completat[ao]i?|rinominat[ao]i?|condivis[ao]i?|segnat[ao]i?))/i;
  if (BROAD.test(text)) return true;
  const HO = /\b(ho\s+(cancellato|eliminato|rimosso|spostato|modificato|aggiornato|creato|inviato|inoltrato|archiviato|completato|rinominato|condiviso|segnato|fissato|prenotato|programmato|cambiato|risolto))/i;
  if (HO.test(text)) return true;
  const EN = /\b(i\s+(have|just)\s+(deleted|removed|moved|created|updated|sent|forwarded|archived|completed|renamed|shared|marked))/i;
  if (EN.test(text)) return true;
  return false;
}

// Tool whitelist for "actually mutated state". If the agent claims a
// completed mutation but NONE of these were called, we treat it as fake.
const _MUTATION_TOOLS = new Set([
  'calendar_create', 'calendar_update', 'calendar_delete', 'calendar_move',
  'gmail_send', 'gmail_reply', 'gmail_forward', 'gmail_delete', 'gmail_archive',
  'gmail_label', 'gmail_mark_read', 'gmail_mark_unread', 'gmail_draft',
  'task_add', 'task_done', 'task_delete', 'task_edit',
  'note_add', 'note_delete',
  'reminder_create', 'reminder_cancel',
  'contact_create', 'contact_update', 'contact_delete',
  'drive_upload', 'drive_update', 'drive_delete', 'drive_rename', 'drive_move', 'drive_share',
  'gtask_complete', 'gtask_update', 'gtask_delete',
  'slack_send', 'notion_update', 'github_create_issue', 'github_close_issue',
  'imap_send', 'imap_reply', 'imap_delete',
]);
function _toolResultLineIsMutation(line) {
  if (typeof line !== 'string') return false;
  const m = line.match(/^\[([\w_]+)\]\s+(.*)$/);
  if (!m) return false;
  const [, name, rest] = m;
  if (!_MUTATION_TOOLS.has(name)) return false;
  if (/Error:|^Error\b/i.test(rest)) return false; // failed → didn't actually mutate
  return true;
}

async function callAgentWithTools(config, agentName, userMessage, languageOverride, preHistory, chatId) {
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
  // Track EVERY tool call across ALL rounds. The final post-response
  // guardrail uses this to detect "claimed action without actual tool call".
  const _allToolResults = [];

  for (let round = 0; round < 5; round++) {
    const parts = history.map(h => (h.role === 'user' ? '[User]' : '[Assistant]') + ' ' + h.content);
    parts.push('[User] ' + userMessage);
    const serialized = parts.join('\n\n');

    const response = await callLLM(config, systemPrompt, serialized);
    const { textParts, actions } = parseActions(response);

    if (actions.length === 0) {
      finalText = textParts.join('\n').trim();

      // ── HALLUCINATED SUCCESS DETECTION ────────────────────────────────
      // The model sometimes writes "X è stato cancellato/creato/inviato con
      // successo" WITHOUT actually emitting a tool block — pure hallucination.
      // If that happens and we're early in the round budget, force ONE retry
      // with an explicit instruction to emit the tool JSON. If it still
      // refuses, replace the fake success with a warning so the user knows
      // the action did NOT actually happen.
      const claimsSuccess = isCompletedAction(finalText);
      const hasReferenceToTool = /\b(eventid|event id|id evento)\b/i.test(finalText);
      const looksFakeSuccess = claimsSuccess || (hasReferenceToTool && round === 0);
      if (looksFakeSuccess && round < 1) {
        // Push the bad response as history so the model sees what it just did,
        // then ask it to actually emit the tool.
        history.push({ role: 'assistant', content: response });
        userMessage =
          `STOP. Hai dichiarato che un'azione è stata completata ma NON hai emesso nessun blocco tool JSON. ` +
          `Senza il blocco tool, NESSUNA azione viene eseguita davvero. ` +
          `Ora emetti il blocco JSON corretto (\`\`\`json ... \`\`\`) per l'azione richiesta dall'utente, usando i parametri corretti. ` +
          `Se ti serve un eventId, chiama prima calendar_find o calendar_date. Non scrivere altro testo finché non hai eseguito davvero il tool.`;
        continue; // restart the loop with the corrective user message
      }
      if (looksFakeSuccess && round >= 1) {
        // Second attempt also lied — refuse to forward the fake success.
        finalText =
          `Non sono riuscito a eseguire l'azione automaticamente (il modello ha dichiarato un successo senza eseguire il tool). ` +
          `Riprova riformulando la richiesta, oppure dimmi esattamente cosa vuoi che faccia.`;
      }

      break;
    }

    // Execute all tools — use the remembering variant so list-tools auto-
    // populate the anaphoric cache (lastList_*). Critical for "Si spostalo"
    // pattern: HERALD calls calendar_find inside the loop, the result must
    // land in lastCalendarEvents so the next turn's anaphoric dispatcher
    // can resolve "spostalo" deterministically.
    const { executeToolAndRemember: _exec } = await import('./tool-executor.mjs');
    const toolResults = [];
    let authError = null;
    for (const { action, params } of actions) {
      try {
        const result = await _exec(action, params, config, chatId);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const line = `[${action}] ${resultStr}`;
        toolResults.push(line);
        _allToolResults.push(line);
      } catch (err) {
        // Detect Google/Microsoft OAuth token expiry — give user a clear fix instruction
        const msg = err.message || '';
        const isAuthErr = /invalid.?credentials|token.*expired|unauthorized|401|invalid_grant|auth.*failed|authentication.*failed/i.test(msg);
        if (isAuthErr) {
          authError = action.startsWith('gmail') || action.startsWith('imap') || action.startsWith('calendar') || action.startsWith('contact') || action.startsWith('drive') || action.startsWith('gtask')
            ? 'google' : 'microsoft';
        }
        const errLine = `[${action}] Error: ${err.message}`;
        toolResults.push(errLine);
        _allToolResults.push(errLine);
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
    // LANGUAGE enforcement up FRONT — putting it last allows Liara to ignore it.
    // Repeat the instruction at the top so the model commits to it before reading
    // the tool results, then again at the bottom for reinforcement.
    userMessage =
      `RISPOSTA OBBLIGATORIA IN ${language.toUpperCase()}. Tutta la frase deve essere in ${language}, niente inglese, niente lingue miste.\n\n` +
      `Tool results:\n${toolResults.join('\n')}\n\n` +
      `Now give the user a short, clear confirmation. Be direct — no preamble, no HERALD format. ` +
      `If an action was completed, say so clearly. REMEMBER: reply ONLY in ${language}.`;
  }

  // ── POST-RESPONSE ANTI-HALLUCINATION GUARDRAIL (v16.0.21) ─────────────
  // If the agent claims a completed mutation ("ho cancellato", "è stato
  // spostato", "I have deleted") BUT no mutation tool was actually called
  // across any of the 5 rounds — REPLACE the lie with an honest error.
  // The user sees the truth: "Non sono riuscito a eseguire l'azione".
  if (finalText) {
    const claimsAction = isCompletedAction(finalText);
    if (claimsAction) {
      const didMutate = _allToolResults.some(_toolResultLineIsMutation);
      if (!didMutate) {
        try { console.warn(`[GUARDRAIL] Mutation claim without tool call. Tools used: [${_allToolResults.map(l => l.match(/^\[([\w_]+)\]/)?.[1]).filter(Boolean).join(', ')}]. Replacing fake response: "${finalText.slice(0, 160)}"`); } catch {}
        finalText = language === 'Italian'
          ? `⚠️ Attenzione: avevo dichiarato di aver eseguito un'azione, ma in realtà non ho chiamato nessun tool di modifica. NON è stato fatto nulla.\n\nPer favore ripeti la richiesta in modo specifico — es. "sposta l'appuntamento Tagliando macchina al 19 maggio alle 17:30" — così che io possa eseguire il comando esatto.`
          : `⚠️ Warning: I claimed an action was completed but did not actually call any modification tool. NOTHING was changed.\n\nPlease restate your request precisely — e.g. "move the Car Service appointment to May 19 at 17:30" — so I can run the exact tool call.`;
      }
    }
  }

  // Defensive language post-check: small models sometimes drop back to English
  // even when instructed otherwise (especially after tool execution, where the
  // English tool-result text biases the continuation). If the final reply is
  // in a clearly different language than expected, translate it.
  if (finalText && language && !looksLikeLanguage(finalText, language)) {
    try {
      const translatePrompt =
        `Traduci il seguente messaggio in ${language}. Mantieni lo stesso significato, lo stesso tono, la stessa lunghezza. Restituisci SOLO la traduzione, senza preamboli o note.\n\nMessaggio:\n${finalText}`;
      const translated = await callLLM(config,
        `You are a precise translator. Translate the given text into ${language}. Output ONLY the translation, no commentary.`,
        translatePrompt,
        { max_tokens: 800 },
      );
      const cleaned = (translated || '').trim();
      if (cleaned && cleaned.length > 0) finalText = cleaned;
    } catch { /* keep the original if translation fails */ }
  }

  return { text: finalText || 'Fatto.', history };
}

/**
 * Detect if a text is in the expected language. Used as a defensive check
 * after the LLM produces the final tool-confirmation reply — small models
 * sometimes drop back to English even when instructed otherwise.
 * Returns true if the language seems right, false if a strong mismatch.
 */
function looksLikeLanguage(text, expectedLanguage) {
  if (!text || !expectedLanguage) return true;
  const detected = detectLanguage(text);
  if (!detected) return true; // not enough signal, give benefit of the doubt
  return detected === expectedLanguage;
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

// Persistent storage for per-chat conversational state. Without this, every
// process restart (npm self-update, crash, "nha ops stop && start") loses the
// sticky-agent + turn history, and the user's next "Procedi" / "Si" routes
// to a random agent because the planner has no thread to anchor on.
const TELEGRAM_CTX_FILE = path.join(os.homedir(), '.nha', 'telegram-context.json');
const TELEGRAM_CTX_MAX_AGE_MS = 30 * 60 * 1000; // 30 min — older than that, discard

function loadTelegramContext() {
  try {
    if (!fs.existsSync(TELEGRAM_CTX_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(TELEGRAM_CTX_FILE, 'utf-8'));
    const now = Date.now();
    const fresh = {};
    for (const [chatId, ctx] of Object.entries(raw)) {
      if (ctx && typeof ctx.ts === 'number' && (now - ctx.ts) < TELEGRAM_CTX_MAX_AGE_MS) {
        fresh[chatId] = ctx;
      }
    }
    return fresh;
  } catch { return {}; }
}

function saveTelegramContext(byChatId) {
  try {
    const dir = path.dirname(TELEGRAM_CTX_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write — temp file + rename so a crash during write doesn't leave
    // half-written JSON that breaks the next boot.
    const tmp = TELEGRAM_CTX_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(byChatId, null, 2));
    fs.renameSync(tmp, TELEGRAM_CTX_FILE);
  } catch { /* non-fatal */ }
}

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
    // Per-chat sticky agent — restored from disk so self-restarts and npm
    // updates don't break in-flight conversations.
    this._lastContextByChatId = loadTelegramContext();
    this._lastAgentByChatId = {};
    for (const [chatId, ctx] of Object.entries(this._lastContextByChatId)) {
      if (ctx && ctx.agent) this._lastAgentByChatId[chatId] = ctx.agent;
    }
    const restoredCount = Object.keys(this._lastContextByChatId).length;
    if (restoredCount > 0) {
      this.log(`[Telegram] Restored conversational context for ${restoredCount} chat(s) from disk`);
    }
    this._saveCtxTimer = null;
  }

  _persistContext() {
    // Synchronous write — guarantees the context is on disk even if the
    // process exits immediately after (npm self-update, SIGTERM, crash).
    // The file is tiny (< 10 KB typical), so this stays sub-millisecond.
    saveTelegramContext(this._lastContextByChatId);
  }

  /**
   * Language-agnostic intent classifier (15.1.38).
   *
   * Previous versions hard-coded confirmation/reaction keywords for Italian
   * and English. That couldn't scale — every new language ("schedule it"
   * in Spanish, German, Japanese, Polish, Turkish, ...) would need a new
   * keyword list. Now we delegate to a tiny LLM call: 16 tokens output,
   * works in any human language the model knows.
   *
   * Fast path: if the keyword matcher already returned a confident verdict,
   * skip the LLM. Only ambiguous cases (short messages, no obvious keyword)
   * pay the ~50ms LLM cost.
   *
   * @returns 'continuation' | 'new_request' | 'unknown'
   */
  async _classifyIntent(text, lastCtx) {
    if (!lastCtx) return 'new_request';
    const hasKey = !!(this.config.llm?.apiKey || this.config.llm?.openaiKey || this.config.llm?.geminiKey || (this.config.llm?.provider === 'nha'));
    if (!hasKey) return 'unknown';
    try {
      const prev = (lastCtx.agentReply || '').slice(0, 600);
      const sys = 'You are a binary intent classifier for a chat assistant. Reply with EXACTLY one word: "continuation" or "new_request". Use "continuation" when the user is confirming, denying, reacting to, or refining the assistant\'s previous message (in any language). Use "new_request" when the user is starting an unrelated topic. Do not output anything else.';
      const usr = `Assistant just said:\n"${prev}"\n\nUser now writes:\n"${text}"\n\nClassify the user\'s message: continuation or new_request?`;
      const ans = await callLLM(this.config, sys, usr, { max_tokens: 8 });
      const v = String(ans || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
      if (v === 'continuation' || v.startsWith('cont')) return 'continuation';
      if (v === 'new_request' || v.startsWith('new')) return 'new_request';
      return 'unknown';
    } catch { return 'unknown'; }
  }

  /**
   * Route a fresh message to the best agent.
   *
   * Tier 1 — keyword table (fast, no LLM cost). Falls through to CONDUCTOR
   * when nothing matches.
   *
   * Tier 2 — if Tier 1 returned the fallback CONDUCTOR AND the user has an
   * LLM key configured, ask the LLM to pick the right agent given the
   * conversation history. This rescues paraphrased queries like
   * "mostrami quanto vale ora il metallo prezioso giallo" (no keyword match)
   * which v13 used to route correctly because of a similar LLM router.
   */
  async _routeFreshMessage(text, lastCtx) {
    const keywordAgent = routeMessage(text, this.autoRoute);
    if (keywordAgent !== 'conductor') return keywordAgent;
    // Tier 2 fallback
    const hasKey = !!(this.config.llm?.apiKey || this.config.llm?.openaiKey || this.config.llm?.geminiKey || this.config.llm?.deepseekKey || (this.config.llm?.provider === 'nha'));
    if (!hasKey) return keywordAgent;
    try {
      const AGENTS = ['herald', 'mercury', 'athena', 'oracle', 'forge', 'scheherazade', 'saber', 'sauron', 'conductor'];
      const tail = (lastCtx?.conversationLog || []).slice(-6)
        .map(t => `${t.role === 'user' ? 'User' : 'Bot'}: ${String(t.content).slice(0, 200)}`)
        .join('\n');
      const sys = 'You are a routing classifier. Reply with EXACTLY one lowercase agent name from this list and nothing else: ' + AGENTS.join(', ') + '. herald=calendar/email/weather/news, mercury=finance/markets/crypto, athena=audit/compliance, oracle=data/analytics, forge=code/architecture, scheherazade=writing/content, saber=security, sauron=monitoring, conductor=anything else.';
      const usr = `Recent conversation (most recent last):\n${tail || '(none)'}\n\nUser message: "${text}"\n\nWhich agent? Reply with ONLY the lowercase agent name.`;
      const ans = await callLLM(this.config, sys, usr, { max_tokens: 16 });
      const picked = String(ans || '').trim().toLowerCase().split(/\s+/)[0];
      if (AGENTS.includes(picked)) return picked;
    } catch { /* LLM unavailable, keep keyword fallback */ }
    return keywordAgent;
  }

  get enabled() {
    return !!this.token;
  }

  async start() {
    if (!this.enabled) return;
    this.running = true;
    // Explicit version log at boot so the user can verify what's running.
    // Critical when chasing "bot still mentes" — answers "are you on v16.0.21?".
    this.log(`[Telegram] Responder started — VERSION ${VERSION} — polling for messages`);
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

  /**
   * Send a Telegram message that may exceed the 4096-char API limit.
   * Splits on paragraph/line boundaries when possible, never on a multi-byte
   * sequence. Sends in order with a small delay to avoid rate-limit 429.
   * Returns the array of message IDs sent.
   */
  async _sendMessageSafe(chatId, text, extraOpts = {}) {
    const TG_MAX = 4000; // safety margin from 4096 to account for emoji weight
    const str = String(text == null ? '' : text);
    if (str.length <= TG_MAX) {
      return [await this._telegramCall('sendMessage', { chat_id: chatId, text: str, ...extraOpts })];
    }
    // Split intelligently: try paragraph breaks, then lines, then hard slice.
    const chunks = [];
    let remaining = str;
    while (remaining.length > TG_MAX) {
      let cutAt = remaining.lastIndexOf('\n\n', TG_MAX);
      if (cutAt < TG_MAX / 2) cutAt = remaining.lastIndexOf('\n', TG_MAX);
      if (cutAt < TG_MAX / 2) cutAt = remaining.lastIndexOf(' ', TG_MAX);
      if (cutAt < TG_MAX / 2) cutAt = TG_MAX;
      chunks.push(remaining.slice(0, cutAt).trim());
      remaining = remaining.slice(cutAt).trim();
    }
    if (remaining) chunks.push(remaining);
    const ids = [];
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${chunks[i]}` : chunks[i];
      try {
        ids.push(await this._telegramCall('sendMessage', { chat_id: chatId, text: part, ...extraOpts }));
      } catch (e) {
        this.log(`[Telegram] sendMessage chunk ${i + 1}/${chunks.length} failed: ${e.message}`);
      }
      await this._sleep(180); // avoid 429 rate limit
    }
    return ids;
  }

  async _scheduleUpdateCheck() {
    await this._checkAndNotifyUpdate();
    await this._checkLocalUpdateAndRestart();
    // Then every 24h for the npm registry check + every 5 min for local install check
    this._updateCheckTimer = setInterval(() => this._checkAndNotifyUpdate(), 24 * 60 * 60 * 1000);
    setInterval(() => this._checkLocalUpdateAndRestart(), 5 * 60 * 1000);
  }

  /**
   * Detect that a NEW version of nha-cli has been installed on disk while
   * this process is still running the OLD code in memory. When detected,
   * exit cleanly so PM2 / launchd / the dispatcher respawns us on the
   * latest code. Without this, the user runs `npm i -g nothumanallowed@latest`
   * but the Telegram bot keeps mentes-ing with the old logic forever.
   */
  async _checkLocalUpdateAndRestart() {
    try {
      const fileURL = await import('url');
      const here = fileURL.fileURLToPath(import.meta.url);
      // ../../package.json relative to this file (services/message-responder.mjs)
      const pkgPath = path.join(path.dirname(here), '..', '..', 'package.json');
      if (!fs.existsSync(pkgPath)) return;
      const onDisk = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
      if (!onDisk || onDisk === VERSION) return;
      this.log(`[Telegram] Detected new install: running v${VERSION}, on-disk v${onDisk}. Restarting to pick up new code…`);
      // Notify any active chat that we're restarting (best-effort, fire and forget)
      try {
        const chatIds = getAllTelegramChatIds();
        for (const chatId of chatIds.slice(0, 3)) {
          this._telegramCall('sendMessage', { chat_id: parseInt(chatId, 10), text: `🔄 Aggiornamento NHA v${VERSION} → v${onDisk} in corso. Torno tra 2 secondi.` }).catch(() => {});
        }
      } catch {}
      // Give the message a moment to flush, then exit. PM2 / dispatcher restarts us.
      setTimeout(() => process.exit(0), 800);
    } catch (e) {
      this.log(`[Telegram] Local update check failed: ${e.message}`);
    }
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
        `Aggiorna con UN SOLO comando (copia e incolla tutto):\n` +
        `npm cache clean --force && npm install -g nothumanallowed@latest --prefer-online && nha ops stop && nha ops start\n\n` +
        `Importante: usa esattamente "--prefer-online" (NON "--pref-online") e tieni tutti i "&&" tra i comandi.`;

      this.log(`[Telegram] Broadcasting update notification v${latest} to ${chatIds.length} users`);

      for (const chatId of chatIds) {
        try {
          await this._sendMessageSafe(parseInt(chatId, 10), msg);
        } catch {
          // User blocked bot or chat no longer exists — ignore
        }
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

    throw new Error('servizio di trascrizione vocale momentaneamente non disponibile (NHA proxy irraggiungibile)');
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

    let rawText = message.text || message.caption || '';
    let isVoice = false;

    // ── Image / photo handler (vision via Liara or fallback provider) ──────
    // Telegram sends `message.photo` as an array of size variants — we pick
    // the largest. For documents (e.g. screenshots sent as files), we accept
    // any mime starting with image/.
    const photo = Array.isArray(message.photo) && message.photo.length
      ? message.photo[message.photo.length - 1]
      : null;
    const isImageDoc = message.document && /^image\//.test(message.document.mime_type || '');
    if (photo || isImageDoc) {
      try {
        await this._telegramCall('sendChatAction', { chat_id: chatId, action: 'typing' });
        const fileId = photo ? photo.file_id : message.document.file_id;
        const fileInfo = await this._telegramCall('getFile', { file_id: fileId });
        const filePath = fileInfo?.result?.file_path;
        if (!filePath) throw new Error('Telegram file_path missing');
        const fileUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
        const fileRes = await fetch(fileUrl);
        if (!fileRes.ok) throw new Error(`Telegram file fetch ${fileRes.status}`);
        const buf = Buffer.from(await fileRes.arrayBuffer());
        const base64 = buf.toString('base64');
        // Infer mediaType from file_path extension.
        const ext = (filePath.split('.').pop() || 'jpg').toLowerCase();
        const mediaType = ext === 'png' ? 'image/png'
                        : ext === 'gif' ? 'image/gif'
                        : ext === 'webp' ? 'image/webp'
                        : 'image/jpeg';
        const userPrompt = rawText.trim()
          || 'Describe this image in detail. If it contains text, transcribe it exactly. Reply in Italian.';
        const langInstruction = detectLanguage(userPrompt) || (rawText ? null : null);
        const sysPrompt = `You are a helpful visual assistant. ${langInstruction === 'English' ? 'Reply in English.' : 'Rispondi in italiano.'} Be specific and accurate. If asked to extract text, transcribe it verbatim. If asked to identify objects, list them clearly.`;
        const { callLLMVision } = await import('./llm.mjs');
        const description = await callLLMVision(this.config, sysPrompt, userPrompt, { base64, mediaType });
        const truncated = description.length > 4000 ? description.slice(0, 3950) + '\n\n... [truncated]' : description;
        // Audit
        this._recordAudit(chatId, {
          tool: 'vision_describe',
          success: true,
          summary: `Image (${Math.round(buf.length / 1024)} KB) — "${(userPrompt).slice(0, 60)}"`,
        });
        const personaName = this.config.responder?.telegram?.botName || this.config.responder?.botName || '';
        const personaMode = this.config.responder?.telegram?.personaMode || (personaName ? 'persona' : 'agent');
        const prefix = personaMode === 'persona-only' && personaName ? ''
                     : personaName ? `[${personaName}]\n\n`
                     : `[HERALD]\n\n`;
        await this._sendMessageSafe(chatId, prefix + description);
        this.log(`[Telegram] Image vision response to ${fromUser} (${buf.length} bytes, ${description.length} chars)`);
      } catch (err) {
        this.log(`[Telegram] Vision failed: ${err.message}`);
        await this._sendMessageSafe(chatId, `Non riesco ad analizzare l'immagine: ${err.message}`).catch(() => {});
      }
      return;
    }

    // Handle voice notes — transcribe with Whisper (Groq or OpenAI)
    if (message.voice || message.audio) {
      const fileId = (message.voice || message.audio).file_id;
      isVoice = true;
      try {
        await this._telegramCall('sendChatAction', { chat_id: chatId, action: 'typing' });
        rawText = await this._transcribeVoice(fileId);
        if (!rawText.trim()) {
          await this._sendMessageSafe(chatId, 'Non ho capito il vocale. Riprova.');
          return;
        }
        this.log(`[Telegram] Voice transcribed for ${fromUser}: "${rawText.slice(0, 80)}"`);
      } catch (err) {
        this.log(`[Telegram] Voice transcription failed: ${err.message}`);
        await this._sendMessageSafe(chatId, `Non riesco a trascrivere il vocale (${err.message}).\n\nPer abilitare la trascrizione vocale gratuita, dal computer esegui:\nnha config set groqKey TUA_CHIAVE_GROQ\n\nLa chiave si ottiene gratis su https://console.groq.com/keys`);
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
      await this._sendMessageSafe(chatId, `🎤 "${cleanText}"`).catch(() => {});
    }

    this.pendingRequests++;
    try {
      const lastCtx = this._lastContextByChatId[chatId];
      const stickyAge = lastCtx ? (Date.now() - lastCtx.ts) : Infinity;
      const withinStickyWindow = stickyAge < 5 * 60 * 1000; // 5 min

      // Determine if this message is a continuation of the previous turn
      // (confirmation, reaction, short reply) vs a new independent request.
      //
      // Two-stage detection:
      //   1. Fast keyword path (IT + EN) — handles the obvious cases (~80%) with zero cost.
      //   2. LLM classifier fallback — for ambiguous cases in any language
      //      ("agéndalo", "termin verschieben", "schedule it",
      //       "ya", "tamam", "harika", ...). Costs ~50 ms and 8 output tokens
      //      but is language-agnostic by design.
      let isContinuation = withinStickyWindow && isContinuationMessage(cleanText, lastCtx);
      if (withinStickyWindow && !isContinuation && lastCtx) {
        // Only invoke the LLM if keyword fast-path didn't flag continuation
        // AND the message is short enough to plausibly be a reaction (≤ 12 words).
        const wordCount = cleanText.trim().split(/\s+/).length;
        if (wordCount <= 12) {
          const verdict = await this._classifyIntent(cleanText, lastCtx);
          if (verdict === 'continuation') {
            isContinuation = true;
            this.log(`[Telegram] ${fromUser}: LLM classifier overrode keyword → continuation`);
          }
        }
      }

      // If last response was a completed action, don't carry history forward —
      // the next message is a fresh request even if it looks like a reaction
      const lastWasCompleted = lastCtx && isCompletedAction(lastCtx.agentReply);

      let agent;
      let enrichedMessage = cleanText;
      let preHistory = null;

      // ── Always inject multi-turn rolling history (15.1.36) ─────────────
      // Even when the new message isn't a "continuation" of the very last
      // turn, the user may still be referring to something earlier in the
      // conversation ("come ti avevo detto ieri", "ricorda che..."). Pass
      // the full conversation log to the agent as preHistory.
      const rollingLog = (lastCtx && Array.isArray(lastCtx.conversationLog) && lastCtx.conversationLog.length > 0)
        ? lastCtx.conversationLog
            .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
            .map(t => ({ role: t.role, content: t.content }))
        : null;

      if (isContinuation && !lastWasCompleted) {
        // Continue with same agent and inject full history for context
        agent = lastCtx.agent;
        // Prefer the rolling multi-turn log if available; fall back to the
        // legacy single-turn `history` for older saved contexts.
        if (rollingLog && rollingLog.length > 0) {
          preHistory = rollingLog;
        } else if (lastCtx.history && lastCtx.history.length > 0) {
          preHistory = lastCtx.history;
        }

        // ── Pending-action force execution ──────────────────────────────
        // The classic failure: assistant proposes "Cercherò X, poi eliminerò,
        // poi mostrerò la lista — Procedo?" → user says "Si" → model replies
        // "Procedo. Cosa vuoi?" (amnesia). Liara/Qwen3 don't always pick up
        // that a short confirmation = execute the proposed plan.
        // Fix: if the previous assistant reply asks for confirmation AND the
        // user message is a short confirmation, REWRITE the user message into
        // an explicit "execute now" instruction with the original plan inline.
        const lowerReply = (lastCtx.agentReply || '').toLowerCase();
        const proposedAction = /procedo\??|confermi\??|conferma\??|posso (?:procedere|farlo|cancellarlo|eliminarlo|crearlo|inserirlo|aggiungere|inviarlo|spostarlo)|vuoi che (?:lo )?(?:cancelli|elimini|crei|inserisca|invii|sposti|modifichi|aggiunga)|shall i|should i|do you want me/.test(lowerReply);
        const shortConfirm = /^(s[ìi]\.?|ok\.?|okay\.?|yes\.?|yep\.?|sure\.?|certo\.?|procedi\.?|fallo\.?|vai\.?|go\.?|do it\.?|conferma\.?|certo che s[ìi]\.?|fallo pure\.?)$/i.test(cleanText.trim());

        if (proposedAction && shortConfirm) {
          // ── Server-side deterministic execution (15.1.43) ───────────────
          // The previous "prompt-engineering" force retry kept failing when
          // the LLM declared success without emitting the tool block. For
          // the most common confirmed actions (DELETE, MOVE), we now bypass
          // the LLM entirely: parse the proposal, resolve the eventId via
          // calendar_date / calendar_find, then call calendar_delete /
          // calendar_move directly. The user gets a guaranteed real result.
          this._lastDirectAuditChatId = chatId;
          const directResult = await this._tryDirectAction(lastCtx.agentReply || '', this.config);
          if (directResult) {
            this.log(`[Telegram] ${fromUser}: direct-action ${directResult.action} → ${directResult.success ? 'OK' : 'FAIL'}`);
            const personaName = this.config.responder?.telegram?.botName || this.config.responder?.botName || '';
            const personaMode = this.config.responder?.telegram?.personaMode || (personaName ? 'persona' : 'agent');
            let reply;
            if (personaMode === 'persona-only' && personaName) {
              reply = directResult.message;
            } else if (personaMode === 'persona+role' && personaName) {
              reply = `[${personaName} · herald]\n\n${directResult.message}`;
            } else if (personaMode === 'persona' && personaName) {
              reply = `[${personaName}]\n\n${directResult.message}`;
            } else {
              reply = `[HERALD]\n\n${directResult.message}`;
            }
            await this._sendMessageSafe(chatId, reply);

            // Update rolling memory + reset pending action (so a follow-up
            // "Si" doesn't try to delete a second time).
            const MAX = 20;
            const prevLog = (lastCtx && Array.isArray(lastCtx.conversationLog)) ? lastCtx.conversationLog : [];
            this._lastContextByChatId[chatId] = {
              agent: 'herald',
              userMsg: cleanText,
              agentReply: directResult.message,
              history: null,
              conversationLog: [...prevLog,
                { role: 'user',      content: cleanText,           ts: Date.now() },
                { role: 'assistant', content: directResult.message, ts: Date.now() },
              ].slice(-MAX * 2),
              ts: Date.now(),
            };
            this._lastAgentByChatId[chatId] = 'herald';
            this._persistContext();
            return;
          }

          // Extract the SPECIFIC action the assistant proposed (create/delete/
          // update/move/send/...), so we can inject an explicit tool name in
          // the instruction. Without this, Liara may pick a random tool —
          // e.g. user confirms a CREATE proposal and the model fires DELETE
          // with a hallucinated eventId.
          const r = lowerReply;
          let actionHint = '';
          let toolHint = '';
          if (/fissat[oa]|inserir[oe]|cre(a|er)[oa]|aggiunger[oeò]|prenota|registr[oa]|mett[oa] (?:in calendario|nel calendario)/.test(r)) {
            actionHint = 'CREARE un nuovo appuntamento';
            toolHint = 'calendar_create con i parametri ESATTI (summary, start, end) che hai descritto nel turno precedente';
          } else if (/cancell|eliminar[eo]|rimuover/.test(r)) {
            actionHint = 'CANCELLARE un appuntamento esistente';
            toolHint = 'PRIMA calendar_find/calendar_date per ottenere l\'eventId REALE, POI calendar_delete con quell\'eventId. Mai inventare ID';
          } else if (/spostar|riprogrammar|cambiar[eo] (?:l\')?orario|cambiar[eo] (?:la )?data/.test(r)) {
            actionHint = 'SPOSTARE un appuntamento';
            toolHint = 'PRIMA calendar_find per ottenere eventId, POI calendar_move(eventId, newStart, newEnd)';
          } else if (/modificar|correggere|rinominar|cambiar[eo] (?:il )?titolo/.test(r)) {
            actionHint = 'MODIFICARE un appuntamento';
            toolHint = 'PRIMA calendar_find per eventId, POI calendar_update(eventId, ...) con SOLO i campi da cambiare';
          } else if (/inviar|spedir|mandar (?:l\'|la )?email|send (?:the )?email/.test(r)) {
            actionHint = 'INVIARE un\'email';
            toolHint = 'gmail_send (o gmail_reply se è una risposta) con destinatario, oggetto e corpo già concordati';
          } else if (/aggiunger[eo] (?:un )?task|creare (?:un )?task|inserir[eo] (?:il )?task/.test(r)) {
            actionHint = 'CREARE un task';
            toolHint = 'task_add con la descrizione concordata';
          } else {
            actionHint = 'l\'azione che hai proposto';
            toolHint = 'il tool corrispondente all\'azione (calendar_create se hai detto "fisso"; calendar_delete se "cancello"; gmail_send se "invio"; ecc.). NON inventare eventId — usa SOLO ID reali ricevuti da tool precedenti';
          }

          enrichedMessage =
            `[CONFERMA UTENTE — Esegui SUBITO l'azione che hai proposto]\n\n` +
            `Tuo turno precedente (proposta):\n"${(lastCtx.agentReply || '').slice(0, 800)}"\n\n` +
            `Risposta utente: "${cleanText.trim()}"\n\n` +
            `AZIONE DA ESEGUIRE: ${actionHint}\n` +
            `TOOL DA USARE: ${toolHint}\n\n` +
            `ISTRUZIONI OBBLIGATORIE:\n` +
            `1. Emetti SUBITO il blocco JSON \`\`\`json {"action":"...","params":{...}} \`\`\` per ESATTAMENTE l'azione qui sopra.\n` +
            `2. Usa i parametri (data, ora, titolo, destinatario, eccetera) che HAI GIÀ menzionato nel tuo turno precedente. NON chiedere di nuovo.\n` +
            `3. Se l'azione è CREATE/SEND/ADD: emetti SOLO quel tool. NIENTE find/delete/update preliminare — quei tool servono per modificare cose esistenti, non per creare di nuove.\n` +
            `4. Se l'azione è DELETE/UPDATE/MOVE: emetti PRIMA calendar_find o calendar_date per trovare l'eventId REALE (lungo, alfanumerico Google). MAI usare placeholder come "A1B2C3D4E5F6G7H8I9J0", "abc123", "ABC123".\n` +
            `5. NON chiedere "cosa vuoi". NON dire "Procedo." senza eseguire. SOLO il blocco JSON e una breve conferma in italiano dopo l'esecuzione.`;
          this.log(`[Telegram] ${fromUser}: pending-action force → ${actionHint}`);
        }

        this.log(`[Telegram] ${fromUser}: continuation → ${agent.toUpperCase()} (ctx ${Math.round(stickyAge/1000)}s ago, history=${preHistory ? preHistory.length : 0})`);
      } else {
        // ── Direct fresh calendar action (no LLM, deterministic) ────────────
        // Catches DELETE / LIST requests sent as a fresh message (no prior
        // proposal). The model used to hallucinate "I cancelled it" without
        // touching the API, OR invent the event list when asked for "all
        // appointments of May". By running the calendar tool server-side, the
        // user always sees REAL data — never fabricated.
        this._lastDirectAuditChatId = chatId;

        // ── UNIVERSAL ANAPHORIC PRE-STEP (v16.0.17) ──
        // Same logic as tryDirectActionAll on the chat web: intercept
        // anaphoric commands ("cancellalo", "il primo", "si") BEFORE the
        // per-domain handlers, since the calendar regex doesn't catch
        // pronouns and the LLM otherwise hallucinates.
        let directFresh = null;
        try {
          const anaphor = this._detectAnaphoricAction(cleanText);
          if (anaphor) {
            const resolved = this._resolveAnaphoric(null, cleanText);
            if (resolved?.item) {
              directFresh = await this._executeAnaphoricVerb(anaphor, resolved.kind, resolved.item, cleanText, this.config);
            } else {
              this.log(`[Telegram] anaphoric verb=${anaphor} but no item to resolve`);
            }
          }
        } catch (e) {
          this.log(`[Telegram] anaphoric dispatcher error: ${e.message}`);
        }

        // Run the per-domain direct-action dispatcher. First match wins; falls
        // through to LLM if no handler claims the message.
        // Fast-path specialised handlers (regex-driven, lower latency for the
        // common cases), then the universal dispatcher that covers ALL 50+
        // mutation tools via a single LLM-NLU+deterministic-execute pass.
        if (!directFresh) {
          directFresh =
            await this._tryDirectFreshCalendarAction(cleanText, this.config) ||
            await this._tryDirectFreshEmailAction(cleanText, this.config) ||
            await this._tryDirectFreshTaskAction(cleanText, this.config) ||
            await this._tryDirectFreshNoteAction(cleanText, this.config) ||
            await this._tryDirectFreshReminderAction(cleanText, this.config) ||
            await this._tryDirectFreshSlackAction(cleanText, this.config) ||
            await this._tryDirectFreshUniversalAction(cleanText, this.config);
        }
        if (directFresh) {
          this.log(`[Telegram] ${fromUser}: direct-fresh ${directFresh.action} → ${directFresh.success ? 'OK' : 'FAIL'}`);
          const personaName = this.config.responder?.telegram?.botName || this.config.responder?.botName || '';
          const personaMode = this.config.responder?.telegram?.personaMode || (personaName ? 'persona' : 'agent');
          let reply;
          if (personaMode === 'persona-only' && personaName) {
            reply = directFresh.message;
          } else if (personaMode === 'persona+role' && personaName) {
            reply = `[${personaName} · herald]\n\n${directFresh.message}`;
          } else if (personaMode === 'persona' && personaName) {
            reply = `[${personaName}]\n\n${directFresh.message}`;
          } else {
            reply = `[HERALD]\n\n${directFresh.message}`;
          }
          await this._sendMessageSafe(chatId, reply);
          const MAX = 20;
          const prevLog = (lastCtx && Array.isArray(lastCtx.conversationLog)) ? lastCtx.conversationLog : [];
          this._lastContextByChatId[chatId] = {
            agent: 'herald',
            userMsg: cleanText,
            agentReply: directFresh.message,
            history: null,
            conversationLog: [...prevLog,
              { role: 'user',      content: cleanText,             ts: Date.now() },
              { role: 'assistant', content: directFresh.message,   ts: Date.now() },
            ].slice(-MAX * 2),
            ts: Date.now(),
          };
          this._lastAgentByChatId[chatId] = 'herald';
          this._persistContext();
          return;
        }

        // Fresh request — route normally, but STILL pass the rolling log so
        // the model has the conversation context even when the new message
        // is on a fresh topic (e.g. user starts a new task but the previous
        // session is still relevant for memory: names, preferences, etc.).
        agent = await this._routeFreshMessage(cleanText, lastCtx);
        if (rollingLog && rollingLog.length > 0) preHistory = rollingLog;
        this.log(`[Telegram] ${fromUser}: new request → ${agent.toUpperCase()}${isVoice ? ' [voice]' : ''}${lastWasCompleted ? ' [prev completed]' : ''} (rolling history=${preHistory ? preHistory.length : 0})`);
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

      // Inject cross-agent action audit log into the enriched message so any
      // agent invoked for this chat is aware of what other agents already did
      // (calendar deletes, email sends, task creations, etc.). Without this,
      // HERALD would forget a deletion executed via direct-action 2 turns ago.
      const auditNote = this._renderAuditForPrompt(chatId);
      if (auditNote) enrichedMessage = auditNote + enrichedMessage;

      // ── User memory (Fix 3+D v16.0.13) — cross-channel persistent context.
      // Same memory file that's used by the chat web UI. The user can
      // `nha memory add "I prefer concise answers"` once and EVERY channel
      // honors it.
      try {
        const { buildMemoryPrefix, autoLearnFromTurn } = await import('./user-memory.mjs');
        const memPrefix = buildMemoryPrefix();
        if (memPrefix) enrichedMessage = memPrefix + enrichedMessage;
        // Auto-learn — fire and forget, doesn't block the response.
        autoLearnFromTurn(cleanText, this.config).catch(() => null);
      } catch {}

      if (TOOL_AGENTS.has(agent)) {
        const result = await callAgentWithTools(this.config, agent, enrichedMessage, detectedLang, preHistory, chatId);
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

      // ── Multi-turn rolling memory (15.1.36) ────────────────────────────
      // v13 worked well partially because every chat retained a real
      // conversation history. The v14 refactor reduced this to 1 turn —
      // hence "Telegram doesn't understand me anymore". We now keep the
      // last MAX_CONVERSATION_TURNS turns per chat, persisted to disk.
      const MAX_CONVERSATION_TURNS = 20; // user+assistant pairs
      const prevLog = (lastCtx && Array.isArray(lastCtx.conversationLog)) ? lastCtx.conversationLog : [];
      const conversationLog = [
        ...prevLog,
        { role: 'user',      content: cleanText,    ts: Date.now() },
        { role: 'assistant', content: responseText, ts: Date.now() },
      ].slice(-MAX_CONVERSATION_TURNS * 2);

      this._lastContextByChatId[chatId] = {
        agent,
        userMsg: cleanText,
        agentReply: responseText,
        history: isCompletedAction(responseText) ? null : responseHistory, // single-turn (legacy)
        conversationLog,                                                   // multi-turn (new)
        ts: Date.now(),
      };
      this._lastAgentByChatId[chatId] = agent;
      // Persist to disk so the context survives npm self-update / crashes.
      // Without this, a restart between "HERALD proposes" and user's "Procedi"
      // routes the confirmation to a random agent (FORGE in the reported bug).
      this._persistContext();

      // Bot persona name — user can configure a custom name (e.g. "Agata")
      // so the bot speaks with a single consistent identity instead of
      // leaking the internal multi-agent routing (HERALD/ATHENA/MERCURY).
      // Mode determines the format:
      //   - 'persona-only'  → just the body, no prefix (most natural)
      //   - 'persona'       → "[BotName] body"
      //   - 'persona+role'  → "[BotName · role] body" — keeps specialization hint
      //   - 'agent'         → "[AGENT_NAME] body" — legacy / debugging mode
      const personaName = this.config.responder?.telegram?.botName || this.config.responder?.botName || '';
      const personaMode = this.config.responder?.telegram?.personaMode || (personaName ? 'persona' : 'agent');
      const agentLabel = String(agent || '').toUpperCase();
      let prefixedText;
      if (personaMode === 'persona-only' && personaName) {
        prefixedText = truncated;
      } else if (personaMode === 'persona+role' && personaName) {
        prefixedText = `[${personaName} · ${agentLabel.toLowerCase()}]\n\n${truncated}`;
      } else if (personaMode === 'persona' && personaName) {
        prefixedText = `[${personaName}]\n\n${truncated}`;
      } else {
        prefixedText = `[${agentLabel}]\n\n${truncated}`;
      }

      await this._sendMessageSafe(chatId, prefixedText);

      this.log(`[Telegram] Responded to ${fromUser} via ${agentLabel}${personaName ? ` (as "${personaName}")` : ''} (${responseText.length} chars)${isCompletedAction(responseText) ? ' [action completed — context reset]' : ''}`);
    } catch (err) {
      this.log(`[Telegram] Agent call failed: ${err.message}`);
      // Send error message to user
      await this._sendMessageSafe(chatId, `Error: ${err.message}`).catch(() => {});
    } finally {
      this.pendingRequests--;
    }
  }

  // ── Direct server-side execution of a confirmed pending action ────────
  // Returns { action, success, message } when it could resolve and execute
  // the action without involving the LLM. Returns null when the proposal
  // can't be reduced to deterministic parameters (e.g. ambiguous title,
  // multiple candidate events, unsupported action shape) — caller then
  // falls back to the prompt-engineering path.
  //
  // Currently supports: calendar_delete. (calendar_move/update can extend
  // the same pattern once the proposal language stabilizes.)
  async _tryDirectAction(proposalText, config) {
    if (!proposalText || typeof proposalText !== 'string') return null;
    const lower = proposalText.toLowerCase();

    // Only handle DELETE for now — the riskiest "fake success" case.
    const isDelete = /\b(cancell|eliminar[eo]|rimuover|delete|cancel)\b/.test(lower);
    if (!isDelete) return null;

    // Refuse if multiple distinct actions are proposed (chained plan).
    if (/(\bpoi\b|\binoltre\b|\bdopo\b|\bquindi\b).*(invier[oò]|crear[oò]|spostar[oò]|modificare[oò]|aggiunger[oò])/i.test(proposalText)) {
      return null;
    }

    const extracted = this._extractCalendarProposal(proposalText);
    if (!extracted.date && !extracted.title) return null;

    const { executeTool } = await import('./tool-executor.mjs');

    // Candidates: events on the proposed date, or matching the title.
    let candidates = [];
    try {
      if (extracted.date) {
        const result = await executeTool('calendar_date', { date: extracted.date }, config);
        candidates = this._parseEventsFromToolOutput(result);
      }
      if (candidates.length === 0 && extracted.title) {
        const result = await executeTool('calendar_find', { query: extracted.title, daysAhead: 60 }, config);
        candidates = this._parseEventsFromToolOutput(result);
      }
    } catch (err) {
      this.log(`[Telegram] direct-action lookup failed: ${err.message}`);
      return null;
    }

    if (candidates.length === 0) return null;

    // Match by title tokens (case-insensitive, accent-insensitive).
    const norm = (s) => String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/).filter(t => t.length > 2);

    let match = null;
    if (extracted.title) {
      const titleTokens = norm(extracted.title);
      const scored = candidates.map(c => {
        const summaryTokens = new Set(norm(c.summary));
        const score = titleTokens.filter(t => summaryTokens.has(t)).length;
        return { c, score };
      }).sort((a, b) => b.score - a.score);
      const top = scored[0];
      if (top && top.score >= Math.max(1, Math.ceil(titleTokens.length * 0.5))) {
        // Reject if a tied second-best also matches as well — ambiguous.
        if (scored.length === 1 || scored[1].score < top.score) match = top.c;
      }
    }

    // Fallback: if the date narrowed the day to a single event, that's
    // unambiguously the event the user meant.
    if (!match && candidates.length === 1 && extracted.date) match = candidates[0];

    // Time hint as final tiebreaker.
    if (!match && extracted.time) {
      const exactTime = candidates.filter(c => (c.time || '').startsWith(extracted.time));
      if (exactTime.length === 1) match = exactTime[0];
    }

    if (!match || !match.eventId) return null;

    try {
      const delResult = await executeTool('calendar_delete', { eventId: match.eventId }, config);
      const ok = typeof delResult === 'string' && !/error|failed|could not|invalid|placeholder/i.test(delResult);
      const summary = match.summary || extracted.title || 'l\'appuntamento';
      const dateStr = extracted.date || (match.date || '');
      const message = ok
        ? `Fatto. Ho cancellato "${summary}"${dateStr ? ` del ${this._formatDateIT(dateStr)}` : ''}${match.time ? ` alle ${match.time}` : ''}.`
        : `Non sono riuscito a cancellare l'evento: ${delResult}`;
      if (this._lastDirectAuditChatId) {
        this._recordAudit(this._lastDirectAuditChatId, {
          tool: 'calendar_delete',
          success: ok,
          summary: `${summary}${dateStr ? ` del ${this._formatDateIT(dateStr)}` : ''}${match.time ? ` alle ${match.time}` : ''} (eventId ${match.eventId.slice(0, 16)}…)`,
        });
      }
      return { action: 'calendar_delete', success: ok, message };
    } catch (err) {
      return { action: 'calendar_delete', success: false, message: `Errore nella cancellazione: ${err.message}` };
    }
  }

  // Extract { title, date (YYYY-MM-DD), time (HH:MM) } from a free-form
  // Italian/English proposal sentence. Best-effort; returns empty fields
  // when nothing parseable was found.
  _extractCalendarProposal(text) {
    const out = { title: '', date: '', time: '' };

    // Title: prefer quoted text ("..." or «...»).
    const q = text.match(/["«""]([^"«»""\n]{2,80})["»""]/);
    if (q) out.title = q[1].trim();

    // Time: HH:MM (24h) or "alle 18" / "ore 18"
    const tm = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (tm) out.time = `${tm[1].padStart(2, '0')}:${tm[2]}`;
    else {
      const hourOnly = text.match(/\b(?:alle|ore|at)\s+(\d{1,2})(?!\d)\b/i);
      if (hourOnly) out.time = `${hourOnly[1].padStart(2, '0')}:00`;
    }

    // Date: italian "15 maggio [2026]", numeric "15/05[/2026]", ISO 2026-05-15
    const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (iso) {
      out.date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    } else {
      const numeric = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](20\d{2}))?\b/);
      if (numeric) {
        const yr = numeric[3] || String(new Date().getFullYear());
        out.date = `${yr}-${numeric[2].padStart(2, '0')}-${numeric[1].padStart(2, '0')}`;
      } else {
        const MONTHS_IT = {
          gennaio:'01', febbraio:'02', marzo:'03', aprile:'04', maggio:'05', giugno:'06',
          luglio:'07', agosto:'08', settembre:'09', ottobre:'10', novembre:'11', dicembre:'12',
        };
        const MONTHS_EN = {
          january:'01', february:'02', march:'03', april:'04', may:'05', june:'06',
          july:'07', august:'08', september:'09', october:'10', november:'11', december:'12',
          jan:'01', feb:'02', mar:'03', apr:'04', jun:'06', jul:'07', aug:'08', sep:'09',
          sept:'09', oct:'10', nov:'11', dec:'12',
        };
        const all = { ...MONTHS_IT, ...MONTHS_EN };
        const monthRe = new RegExp(`\\b(\\d{1,2})\\s+(${Object.keys(all).join('|')})(?:\\s+(20\\d{2}))?\\b`, 'i');
        const monthM = text.match(monthRe);
        if (monthM) {
          const yr = monthM[3] || String(new Date().getFullYear());
          out.date = `${yr}-${all[monthM[2].toLowerCase()]}-${monthM[1].padStart(2, '0')}`;
        }
      }
    }

    return out;
  }

  // Parse calendar_date / calendar_find tool output. The executor returns
  // a human-readable string with each event on its own line plus the
  // eventId in parentheses. We extract structured records.
  // ── Generic LIST→REMEMBER + ANAPHORIC RESOLUTION (v16.0.16) ────────────
  // Same pattern as the calendar fix, applied uniformly to every list-tool:
  // email, task, contact, drive, note, reminder, gtask, notion.
  // Why: a single regex parser can never handle every tool's ID format.
  // The cleanest path is to call the low-level API directly and persist
  // structured items, then resolve anaphoric references generically.
  // Open allowlist of kinds — no hardcoded restriction. Any new tool can
  // call _rememberItems(<any-kind-string>, items) without changing this file.
  _propForKind(kind) { return `lastList_${kind}`; }

  _rememberItems(kind, items, extra = {}) {
    if (!kind || !Array.isArray(items)) return;
    const chatId = this._lastDirectAuditChatId || '__last_list__';
    const prop = this._propForKind(kind);
    const prev = this._lastContextByChatId[chatId] || {};
    this._lastContextByChatId[chatId] = {
      ...prev,
      [prop]: items,
      [`${prop}At`]: Date.now(),
      lastListKind: kind,
      lastListAt: Date.now(),
      ...extra,
    };
    this.log(`[direct] ${kind} LIST stored: chatId=${chatId} count=${items.length}`);
    try { saveTelegramContext(this._lastContextByChatId); } catch {}
  }

  /**
   * Resolve an anaphoric reference ("cancellalo", "il primo", "l'ultimo",
   * "il numero 2") against the most recently listed items of a given kind.
   * If kind is omitted, falls back to lastListKind (the most recently listed
   * type — calendar after calendar_today, email after gmail_list, etc).
   * Cross-key fallback included.
   */
  _resolveAnaphoric(kind, userMessage) {
    const chatId = this._lastDirectAuditChatId;
    // Use the shared list-cache module as source of truth — it's populated
    // by executeToolAndRemember from every channel.
    let items = [];
    try {
      const cacheFile = path.join(os.homedir(), '.nha', 'list-cache.json');
      let cache = {};
      if (fs.existsSync(cacheFile)) {
        try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch { cache = {}; }
      }
      if (!kind) {
        // Auto-pick the freshest list across any chat.
        const direct = chatId && cache[chatId];
        if (direct?.lastListKind) kind = direct.lastListKind;
        else {
          let bestKind = null, bestAt = 0;
          for (const v of Object.values(cache)) {
            if (v?.lastListKind && (v.lastListAt || 0) > bestAt) { bestKind = v.lastListKind; bestAt = v.lastListAt; }
          }
          kind = bestKind;
        }
      }
      if (!kind) return null;
      const prop = `lastList_${kind}`;
      items = (chatId && cache[chatId]?.[prop]) || [];
      if (items.length === 0) {
        let bestArr = null, bestAt = 0;
        for (const v of Object.values(cache)) {
          if (Array.isArray(v?.[prop]) && v[prop].length > 0 && (v[`${prop}_at`] || 0) > bestAt) {
            bestArr = v[prop]; bestAt = v[`${prop}_at`] || 0;
          }
        }
        if (bestArr) items = bestArr;
      }
    } catch {}
    if (items.length === 0) return null;
    const low = (userMessage || '').toLowerCase();
    const ordinalMap = { primo: 0, prima: 0, secondo: 1, seconda: 1, terzo: 2, terza: 2, quarto: 3, quinto: 4, first: 0, second: 1, third: 2 };
    for (const [word, idx] of Object.entries(ordinalMap)) {
      if (new RegExp(`\\b${word}\\b`).test(low) && items[idx]) return { item: items[idx], kind };
    }
    if (/\b(ultim[oa]|last)\b/.test(low)) return { item: items[items.length - 1], kind };
    const numMatch = low.match(/\b(?:numero|number|n\.?|#)\s*(\d+)\b/);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (items[idx]) return { item: items[idx], kind };
    }
    if (items.length === 1) return { item: items[0], kind };
    return null;
  }

  /**
   * Detect a generic anaphoric verb. Covers 15 verbs in IT+EN.
   * Order matters: more-specific patterns come BEFORE generic delete/edit
   * (e.g. "spostalo" must NOT be classified as delete because of '...alo').
   * Returns the verb string or null.
   */
  _detectAnaphoricAction(userMessage) {
    const t = (userMessage || '').trim();
    if (!t) return null;

    // YES/CONFIRM — short standalone tokens
    if (/^\s*(s[ìi]\b|si\s|sì\s|ok\b|okay\b|certo\b|certamente\b|d'?accordo\b|fai\b|fallo|procedi|esegui|conferm[oa]|yes\b|yep\b|confirm\b|do\s*it|go\s*ahead)/i.test(t)) return 'confirm';

    // MOVE/RESCHEDULE — order: BEFORE delete, else "sposta" can be confused
    if (/\b(spost[ao]l?[oaie]?|sposta|rimand|rinvi[ao]|riprogramm|posticip|sposta?lo|sposta?la|move|reschedul|postpone)\w*/i.test(t)) return 'move';

    // RENAME
    if (/\b(rinomin|rename|chiamalo|chiamala)\w*/i.test(t)) return 'rename';

    // MARK READ / UNREAD (must come before generic "open/leggi")
    if (/\b(segna(?:lo|la|li|le)?\s+come\s+(non\s+letto|unread)|mark\s+unread)\b/i.test(t)) return 'mark_unread';
    if (/\b(segna(?:lo|la|li|le)?\s+come\s+letto|mark\s+(?:as\s+)?read|gi[àa]\s+letto|letto\s+gi[àa])\b/i.test(t)) return 'mark_read';

    // ARCHIVE
    if (/\b(archivi)\w*/i.test(t)) return 'archive';

    // LABEL / TAG
    if (/\b(etichett|categoriz|tag\s|aggiungi\s+(?:label|etichetta)|label\b)\w*/i.test(t)) return 'label';

    // FORWARD
    if (/\b(inoltra|inoltralo|inoltrala|forward|gira(?:lo|la)?)\w*/i.test(t)) return 'forward';

    // SHARE
    if (/\b(condivid|condividilo|condividila|share|invia\s+link)\w*/i.test(t)) return 'share';

    // PRIORITY change
    if (/\b(prioriti?z|priority|priorit[àa])\w*/i.test(t)) return 'priority';

    // SNOOZE
    if (/\b(snooze|rimanda\s+notifica|posticipa\s+(?:notifica|reminder|promemoria))\w*/i.test(t)) return 'snooze';

    // UNDO
    if (/\b(annulla|undo|disfa|disfa\s+l'?ultima)\w*/i.test(t)) return 'undo';

    // EDIT/MODIFY — generic. Must come AFTER specific edits (rename/label/priority).
    if (/\b(modifi|aggiorn|cambi(?!a\s+canale)|edit|update)\w*/i.test(t)) return 'edit';

    // DELETE — generic
    if (/(cancell|elimin|rimuov|delete|remove)\w*\s*[!.?]?$/i.test(t)) return 'delete';

    // COMPLETE / DONE
    if (/(complet|don[ei]\b|spunt|finit|fatt)\w*\s*[!.?]?$/i.test(t)) return 'complete';

    // REPLY
    if (/(rispond|reply|risp\b)\w*\s*[!.?]?$/i.test(t)) return 'reply';

    // OPEN / VIEW / READ
    if (/(apri|open|leggi|read|mostra|view|visualizz)\w*\s*[!.?]?$/i.test(t)) return 'open';

    return null;
  }

  /**
   * Extract structured parameters for a given verb against a target item.
   * Uses cheap regex first, then a tiny LLM NLU call when needed.
   * Returns {} for verbs that don't need params (delete, complete, archive...).
   */
  async _extractParamsForVerb(verb, kind, userText, config) {
    const text = String(userText || '');
    // ── No-param verbs ────────────────────────────────────────────────────
    if (['delete', 'complete', 'archive', 'mark_read', 'mark_unread', 'share', 'open', 'snooze', 'undo', 'confirm'].includes(verb)) {
      return {};
    }

    // ── PRIORITY: regex extract high/medium/low ──────────────────────────
    if (verb === 'priority') {
      if (/\b(alta|high|urgent[ei]?|importante)\b/i.test(text)) return { priority: 'high' };
      if (/\b(media|medium|normale)\b/i.test(text)) return { priority: 'medium' };
      if (/\b(bassa|low|secondaria|non\s+urgente)\b/i.test(text)) return { priority: 'low' };
      return {};
    }

    // ── LABEL: extract quoted or bare label after the keyword ─────────────
    if (verb === 'label') {
      const m = text.match(/(?:etichett[ao]|tag(?:ga)?(?:lo|la)?|label)\s+(?:come\s+|with\s+|as\s+)?["']?([\w\-#/]+)["']?/i);
      if (m) return { label: m[1] };
      return {};
    }

    // ── FORWARD: extract recipient email ─────────────────────────────────
    if (verb === 'forward') {
      const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      if (m) return { to: m[0] };
      return {};
    }

    // ── RENAME: extract new name (quoted or after "in/a") ─────────────────
    if (verb === 'rename') {
      const m1 = text.match(/(?:rinomina(?:lo|la)?|rename(?:\s+it)?|chiamal[oa])\s+(?:in\s+|a\s+|to\s+|as\s+)?["']([^"']+)["']/i);
      if (m1) return { newName: m1[1] };
      const m2 = text.match(/(?:rinomina(?:lo|la)?|rename(?:\s+it)?|chiamal[oa])\s+(?:in\s+|a\s+|to\s+|as\s+)?([\w\-./]+\.\w{2,5})/i);
      if (m2) return { newName: m2[1] };
      const m3 = text.match(/(?:rinomina(?:lo|la)?|rename(?:\s+it)?|chiamal[oa])\s+(?:in\s+|a\s+|to\s+|as\s+)([^\n!.?]{3,80})/i);
      if (m3) return { newName: m3[1].trim() };
      return {};
    }

    // ── MOVE: needs newStart/newEnd — use existing _nluExtractCalendarMove ──
    if (verb === 'move' && kind === 'calendar') {
      try {
        const parsed = await this._nluExtractCalendarMove(text, config);
        if (parsed) return { newStart: parsed.newStart, newEnd: parsed.newEnd };
      } catch {}
      return {};
    }

    // ── EDIT: free-form. Tiny LLM extractor returning a partial object ────
    if (verb === 'edit') {
      try {
        const sys =
          'You are a parameter extractor for an EDIT command. Given the user instruction and ' +
          `the entity kind (${kind}), return STRICT JSON with the fields to update. ` +
          'Fields by kind: ' +
          'calendar={summary?,start?,end?,location?,description?}; ' +
          'email={subject?,body?}; ' +
          'task={description?,priority?,due?}; ' +
          'contact={name?,email?,phone?}; ' +
          'drive={name?}; note={title?,body?}; ' +
          'reminder={message?,when?}; gtask={title?,due?}. ' +
          'ONLY include fields the user explicitly mentioned. No extra prose.';
        const raw = await callLLM(config, sys, text, { max_tokens: 200, temperature: 0.1 });
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
      } catch {}
      return {};
    }

    // ── REPLY: body extraction — let downstream handler ask user if missing ──
    if (verb === 'reply') {
      const m = text.match(/(?:rispond[ie](?:gli)?|reply)\s+(?:con\s+|with\s+)?["']([^"']+)["']/i);
      if (m) return { body: m[1] };
      return {};
    }

    return {};
  }

  /**
   * Execute an anaphoric verb (delete/complete/reply/open/confirm) against
   * an item resolved by _resolveAnaphoric. The (verb, kind) pair maps to a
   * concrete tool call. Unknown combinations return null (fall through to
   * the LLM). All executions persist to the global audit log.
   */
  async _executeAnaphoricVerb(verb, kind, item, userText, config) {
    const { executeTool } = await import('./tool-executor.mjs');
    const chatId = this._lastDirectAuditChatId;
    const auditAndReturn = (toolName, success, message, summary) => {
      if (chatId) this._recordAudit(chatId, { tool: toolName, success, summary });
      return { action: toolName, success, message };
    };
    const safe = async (toolName, args, okMsg, summary) => {
      try { await executeTool(toolName, args, config); return auditAndReturn(toolName, true, okMsg, summary); }
      catch (e) { return auditAndReturn(toolName, false, `Errore: ${e.message}`, ''); }
    };
    const id = item.eventId || item.messageId || item.fileId || item.taskId || item.id;
    const label = item.subject || item.summary || item.name || item.title || item.description || item.message || String(id);
    const params = await this._extractParamsForVerb(verb, kind, userText, config);

    // confirm = treat as the pending action (default: delete) when there's
    // a single recently-listed item.
    const effective = verb === 'confirm' ? 'delete' : verb;

    // ── MOVE/RESCHEDULE ──────────────────────────────────────────────────
    if (effective === 'move') {
      if (kind === 'calendar' && id && params.newStart) {
        return await safe('calendar_move',
          { eventId: id, newStart: params.newStart, newEnd: params.newEnd || this._addMinutesIso(params.newStart, 60) },
          `Spostato "${label}" a ${this._formatDateIT(params.newStart.slice(0, 10))} alle ${params.newStart.slice(11, 16)}.`, label);
      }
      if (kind === 'drive' && id && params.newName) {
        return await safe('drive_move', { fileId: id, folderId: params.newName }, `Spostato "${label}".`, label);
      }
      if (!params.newStart) {
        return { action: 'move_pending', success: false, message: `A quando vuoi spostare "${label}"? Es. "venerdì 23 maggio alle 15".` };
      }
    }

    // ── RENAME ────────────────────────────────────────────────────────────
    if (effective === 'rename' && params.newName) {
      if (kind === 'drive' && id) return await safe('drive_rename', { fileId: id, newName: params.newName }, `Rinominato "${label}" → "${params.newName}".`, params.newName);
      if (kind === 'note' && id) return await safe('note_update', { id, title: params.newName }, `Rinominata la nota "${label}" → "${params.newName}".`, params.newName);
      if (kind === 'contact' && id) return await safe('contact_update', { id, name: params.newName }, `Rinominato il contatto "${label}" → "${params.newName}".`, params.newName);
      if (kind === 'task' && id) return await safe('task_edit', { id, description: params.newName }, `Rinominato il task → "${params.newName}".`, params.newName);
    }
    if (effective === 'rename' && !params.newName) {
      return { action: 'rename_pending', success: false, message: `Come vuoi rinominare "${label}"?` };
    }

    // ── EDIT (free-form fields) ──────────────────────────────────────────
    if (effective === 'edit' && Object.keys(params).length > 0 && id) {
      if (kind === 'calendar') return await safe('calendar_update', { eventId: id, ...params }, `Aggiornato "${label}".`, label);
      if (kind === 'email')    return await safe('gmail_draft_update', { messageId: id, ...params }, `Aggiornata la bozza email.`, label);
      if (kind === 'task')     return await safe('task_edit', { id, ...params }, `Aggiornato il task "${label}".`, label);
      if (kind === 'contact')  return await safe('contact_update', { id, ...params }, `Aggiornato il contatto "${label}".`, label);
      if (kind === 'note')     return await safe('note_update', { id, ...params }, `Aggiornata la nota "${label}".`, label);
      if (kind === 'reminder') return await safe('reminder_update', { id, ...params }, `Aggiornato il promemoria.`, label);
      if (kind === 'gtask')    return await safe('gtask_edit', { id, ...params }, `Aggiornato il task Google.`, label);
      if (kind === 'drive' && params.name) return await safe('drive_rename', { fileId: id, newName: params.name }, `Rinominato il file → "${params.name}".`, params.name);
    }
    if (effective === 'edit' && Object.keys(params).length === 0) {
      return { action: 'edit_pending', success: false, message: `Cosa vuoi modificare di "${label}"? (es. titolo, orario, descrizione, priorità)` };
    }

    // ── MARK READ/UNREAD (email) ─────────────────────────────────────────
    if (effective === 'mark_read' && kind === 'email' && id) {
      return await safe('gmail_mark_read', { messageId: id }, `Segnata come letta: "${label}".`, label);
    }
    if (effective === 'mark_unread' && kind === 'email' && id) {
      return await safe('gmail_mark_unread', { messageId: id }, `Segnata come NON letta: "${label}".`, label);
    }

    // ── ARCHIVE ──────────────────────────────────────────────────────────
    if (effective === 'archive') {
      if (kind === 'email' && id) return await safe('gmail_archive', { messageId: id }, `Archiviata email "${label}".`, label);
      if (kind === 'task'  && id) return await safe('task_archive', { id }, `Archiviato task "${label}".`, label);
    }

    // ── LABEL/TAG ────────────────────────────────────────────────────────
    if (effective === 'label' && params.label) {
      if (kind === 'email' && id) return await safe('gmail_label', { messageId: id, label: params.label }, `Aggiunta etichetta "${params.label}" a "${label}".`, params.label);
      if (kind === 'task'  && id) return await safe('task_tag', { id, tag: params.label }, `Aggiunto tag "${params.label}" al task.`, params.label);
    }
    if (effective === 'label' && !params.label) {
      return { action: 'label_pending', success: false, message: `Quale etichetta vuoi applicare a "${label}"?` };
    }

    // ── FORWARD (email) ──────────────────────────────────────────────────
    if (effective === 'forward' && kind === 'email' && id) {
      if (!params.to) return { action: 'forward_pending', success: false, message: `A chi vuoi inoltrare "${label}"?` };
      return await safe('gmail_forward', { messageId: id, to: params.to }, `Inoltrata "${label}" a ${params.to}.`, params.to);
    }

    // ── SHARE (drive, calendar) ──────────────────────────────────────────
    if (effective === 'share') {
      if (kind === 'drive' && id) return await safe('drive_share', { fileId: id }, `Condiviso "${label}" (link copiato).`, label);
    }

    // ── PRIORITY change (task) ───────────────────────────────────────────
    if (effective === 'priority' && params.priority) {
      if (kind === 'task' && id)  return await safe('task_edit', { id, priority: params.priority }, `Priorità di "${label}" → ${params.priority}.`, params.priority);
      if (kind === 'gtask' && id) return await safe('gtask_edit', { id, priority: params.priority }, `Priorità task Google → ${params.priority}.`, params.priority);
    }

    // ── SNOOZE (reminder) ───────────────────────────────────────────────
    if (effective === 'snooze' && kind === 'reminder' && id) {
      return await safe('reminder_snooze', { id, minutes: 30 }, `Posticipato di 30 minuti il promemoria "${label}".`, label);
    }

    // ── DELETE family ─────────────────────────────────────────────────────
    if (effective === 'delete') {
      if (kind === 'calendar' && item.eventId) {
        try { await executeTool('calendar_delete', { eventId: item.eventId }, config); return auditAndReturn('calendar_delete', true, `Ho cancellato "${item.summary}".`, item.summary); }
        catch (e) { return auditAndReturn('calendar_delete', false, `Errore: ${e.message}`, ''); }
      }
      if (kind === 'email' && (item.messageId || item.id)) {
        try { await executeTool('gmail_delete', { messageId: item.messageId || item.id }, config); return auditAndReturn('gmail_delete', true, `Ho eliminato l'email "${item.subject || item.summary}".`, item.subject || ''); }
        catch (e) { return auditAndReturn('gmail_delete', false, `Errore: ${e.message}`, ''); }
      }
      if (kind === 'task' && item.id) {
        try { await executeTool('task_delete', { id: item.id }, config); return auditAndReturn('task_delete', true, `Ho eliminato il task "${item.description || item.summary}".`, ''); }
        catch (e) { return auditAndReturn('task_delete', false, `Errore: ${e.message}`, ''); }
      }
      if (kind === 'contact' && item.id) {
        try { await executeTool('contact_delete', { id: item.id }, config); return auditAndReturn('contact_delete', true, `Ho eliminato il contatto "${item.name || item.summary}".`, ''); }
        catch (e) { return auditAndReturn('contact_delete', false, `Errore: ${e.message}`, ''); }
      }
      if (kind === 'drive' && (item.fileId || item.id)) {
        try { await executeTool('drive_delete', { fileId: item.fileId || item.id }, config); return auditAndReturn('drive_delete', true, `Ho eliminato il file "${item.name || item.summary}".`, ''); }
        catch (e) { return auditAndReturn('drive_delete', false, `Errore: ${e.message}`, ''); }
      }
      if (kind === 'note' && item.id) {
        try { await executeTool('note_delete', { id: item.id }, config); return auditAndReturn('note_delete', true, `Ho eliminato la nota "${item.title || item.summary}".`, ''); }
        catch (e) { return auditAndReturn('note_delete', false, `Errore: ${e.message}`, ''); }
      }
      if (kind === 'reminder' && item.id) {
        try { await executeTool('reminder_cancel', { id: item.id }, config); return auditAndReturn('reminder_cancel', true, `Ho cancellato il promemoria "${item.message || item.summary}".`, ''); }
        catch (e) { return auditAndReturn('reminder_cancel', false, `Errore: ${e.message}`, ''); }
      }
      if (kind === 'gtask' && (item.id || item.taskId)) {
        try { await executeTool('gtask_delete', { id: item.id || item.taskId }, config); return auditAndReturn('gtask_delete', true, `Ho eliminato il task Google "${item.title || item.summary}".`, ''); }
        catch (e) { return auditAndReturn('gtask_delete', false, `Errore: ${e.message}`, ''); }
      }
    }

    // ── COMPLETE family (tasks) ──────────────────────────────────────────
    if (effective === 'complete') {
      if (kind === 'task' && item.id) {
        try { await executeTool('task_done', { id: item.id }, config); return auditAndReturn('task_done', true, `Ho completato il task "${item.description || item.summary}".`, ''); }
        catch (e) { return auditAndReturn('task_done', false, `Errore: ${e.message}`, ''); }
      }
      if (kind === 'gtask' && (item.id || item.taskId)) {
        try { await executeTool('gtask_complete', { id: item.id || item.taskId }, config); return auditAndReturn('gtask_complete', true, `Ho completato il task Google "${item.title || item.summary}".`, ''); }
        catch (e) { return auditAndReturn('gtask_complete', false, `Errore: ${e.message}`, ''); }
      }
    }

    // ── OPEN/READ family ─────────────────────────────────────────────────
    if (effective === 'open') {
      if (kind === 'email' && (item.messageId || item.id)) {
        try { const out = await executeTool('gmail_read', { messageId: item.messageId || item.id }, config); return { action: 'gmail_read', success: true, message: String(out) }; }
        catch (e) { return { action: 'gmail_read', success: false, message: `Errore: ${e.message}` }; }
      }
      if (kind === 'drive' && (item.fileId || item.id)) {
        try { const out = await executeTool('drive_read', { fileId: item.fileId || item.id }, config); return { action: 'drive_read', success: true, message: String(out) }; }
        catch (e) { return { action: 'drive_read', success: false, message: `Errore: ${e.message}` }; }
      }
      if (kind === 'note' && item.id) {
        try { const out = await executeTool('note_read', { id: item.id }, config); return { action: 'note_read', success: true, message: String(out) }; }
        catch (e) { return { action: 'note_read', success: false, message: `Errore: ${e.message}` }; }
      }
    }

    // ── REPLY family (email only) ────────────────────────────────────────
    if (effective === 'reply' && kind === 'email' && (item.messageId || item.id)) {
      // We don't know the reply body yet — return a prompt so the LLM can
      // ask the user. Tag the message so the next turn knows context.
      return {
        action: 'gmail_reply_pending', success: true,
        message: `Sto per rispondere a "${item.subject || item.from}". Scrivi il testo della risposta e procedo.`,
      };
    }

    // Unknown verb+kind combination → fall back to the regular handlers.
    return null;
  }

  /**
   * Map a list-tool invocation to the (timeMin, timeMax) range that listEvents
   * would query. Used as a fallback when the textual tool output doesn't
   * include event IDs (calendar_month, calendar_today, etc).
   */
  _computeRangeForListTool(toolName, args) {
    const now = new Date();
    if (toolName === 'calendar_today') {
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { from, to: new Date(from.getTime() + 86400000) };
    }
    if (toolName === 'calendar_tomorrow') {
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return { from, to: new Date(from.getTime() + 86400000) };
    }
    if (toolName === 'calendar_week') {
      // Respect optional startDate (e.g. for "settimana prossima").
      let from;
      if (args?.startDate && /^\d{4}-\d{2}-\d{2}$/.test(args.startDate)) {
        const [yy, mm, dd] = args.startDate.split('-').map(n => parseInt(n, 10));
        from = new Date(yy, mm - 1, dd);
      } else {
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      }
      return { from, to: new Date(from.getTime() + 7 * 86400000) };
    }
    if (toolName === 'calendar_month') {
      let y = now.getFullYear(), m = now.getMonth();
      if (args?.month && /^\d{4}-\d{2}$/.test(args.month)) {
        const [yy, mm] = args.month.split('-');
        y = parseInt(yy, 10);
        m = parseInt(mm, 10) - 1;
      }
      return { from: new Date(y, m, 1), to: new Date(y, m + 1, 1) };
    }
    if (toolName === 'calendar_date' && args?.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
      const [yy, mm, dd] = args.date.split('-').map(n => parseInt(n, 10));
      const from = new Date(yy, mm - 1, dd);
      return { from, to: new Date(from.getTime() + 86400000) };
    }
    if (toolName === 'calendar_upcoming') {
      const hours = parseInt(args?.hours || '48', 10);
      return { from: now, to: new Date(now.getTime() + hours * 3600000) };
    }
    return null;
  }

  _parseEventsFromToolOutput(toolResult) {
    const text = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || '');
    const lines = text.split(/\r?\n/);
    const events = [];
    for (const line of lines) {
      // Look for the eventId pattern: parenthesised long alphanumeric.
      const idMatch = line.match(/\(([a-z0-9_\-]{8,})\)/i);
      if (!idMatch) continue;
      const eventId = idMatch[1];
      // Strip the (id) and any leading bullets/dashes/times for the summary.
      const cleaned = line.replace(/\([a-z0-9_\-]{8,}\)/i, '').trim();
      const timeM = cleaned.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
      const time = timeM ? `${timeM[1].padStart(2, '0')}:${timeM[2]}` : '';
      // Heuristic summary: text after the time, before any " - " or " · ".
      let summary = cleaned;
      if (timeM) summary = cleaned.slice(cleaned.indexOf(timeM[0]) + timeM[0].length);
      summary = summary.replace(/^[\s\-–·•\.]+/, '').replace(/[\s\-–·•\.]+$/, '').trim();
      if (!summary) summary = cleaned.replace(/^[\s\-–·•\.\d:]+/, '').trim();
      events.push({ eventId, summary, time, date: '' });
    }
    return events;
  }

  // ── Action audit log (cross-agent memory of REAL executions) ─────────────
  // Every direct-action OR LLM-mediated tool call that mutates external state
  // (calendar, email, tasks, contacts, files, github, slack…) is appended
  // here. The log is per chatId, persisted to disk, capped at 50 entries.
  //
  // When ANY agent is invoked for this chat, the recent audit entries are
  // prepended to the user message as "AZIONI RECENTI ESEGUITE". Result: a
  // user who deleted a calendar event via HERALD and then asks JARVIS about
  // it ten minutes later — JARVIS sees the deletion in the audit log and
  // can answer factually. No more "have I done that?" amnesia.
  _recordAudit(chatId, entry) {
    const ctx = this._lastContextByChatId[chatId] || (this._lastContextByChatId[chatId] = {});
    if (!Array.isArray(ctx.auditLog)) ctx.auditLog = [];
    const enriched = { ts: Date.now(), channel: chatId, ...entry };
    ctx.auditLog.push(enriched);
    if (ctx.auditLog.length > 50) ctx.auditLog = ctx.auditLog.slice(-50);
    this._persistContext();
    // ── Global audit log (Fix 4 v16.0.12) ──
    // Append-only JSONL at ~/.nha/audit-log.jsonl shared across every channel
    // (telegram / discord / chat web / AWF agent). Lets the user ask
    // "what have you done today?" from any surface and get the same answer.
    try {
      _appendGlobalAudit(enriched);
    } catch {}
  }

  _renderAuditForPrompt(chatId, maxEntries = 10) {
    // Pull from BOTH the per-channel context AND the global log so the model
    // sees actions made via a different channel too.
    const ctx = this._lastContextByChatId[chatId];
    const local = ctx?.auditLog || [];
    let globalEntries = [];
    try { globalEntries = _readGlobalAudit(100); } catch {}
    // Merge + de-dupe by (ts, tool, summary), keep most recent.
    const seen = new Set();
    const merged = [...local, ...globalEntries].sort((a, b) => a.ts - b.ts).filter(e => {
      const k = `${e.ts}|${e.tool}|${e.summary || ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (merged.length === 0) return '';
    const recent = merged.slice(-maxEntries);
    const lines = recent.map(e => {
      const time = new Date(e.ts).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const status = e.success === false ? '✗ FALLITA' : '✓ OK';
      const chan = e.channel && e.channel !== chatId ? ` [via ${String(e.channel).slice(0, 20)}]` : '';
      return `- ${time} · ${e.tool} · ${status} · ${e.summary || ''}${chan}`;
    });
    return `\n\n[AZIONI RECENTI ESEGUITE — fonte di verità sui fatti già accaduti su QUALSIASI canale (Chat, Telegram, Discord, AWF)]\n${lines.join('\n')}\n[FINE AZIONI RECENTI]\n`;
  }

  _formatDateIT(isoDate) {
    const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return isoDate;
    const months = ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
    return `${parseInt(m[3], 10)} ${months[parseInt(m[2], 10) - 1]} ${m[1]}`;
  }

  /** Add N minutes to an ISO datetime string. Returns ISO. */
  _addMinutesIso(isoStart, minutes) {
    try {
      const d = new Date(isoStart);
      d.setMinutes(d.getMinutes() + minutes);
      return d.toISOString();
    } catch { return isoStart; }
  }

  /**
   * NLU only — extract structured calendar-create params from a natural
   * language message using a tiny LLM call. We pin output to strict JSON and
   * accept the result only if the title + start datetime are present.
   * The LLM NEVER executes anything — it only parses.
   */
  async _nluExtractCalendarCreate(userMessage, config) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const sysPrompt =
      `You extract calendar event parameters from natural language.\n` +
      `Today is ${todayIso}. Output ONLY a JSON object with these keys:\n` +
      `  - title (string, the event subject, NOT including verbs like "fissa"/"crea")\n` +
      `  - start (string, ISO datetime "YYYY-MM-DDTHH:MM:00" in local time)\n` +
      `  - end   (string, ISO datetime same format; if duration unknown, leave null and default 60 min will be applied)\n` +
      `  - description (string, optional notes)\n` +
      `Rules: if a field is missing, use null. If the user says "domani" → ${this._addDaysIso(todayIso, 1).slice(0, 10)}. ` +
      `If "lunedì/martedì/..." resolve to the next occurrence. If no time is given default to 09:00. ` +
      `Output ONLY the JSON, no prose.`;
    try {
      const raw = await callLLM(config, sysPrompt, userMessage, { temperature: 0, maxTokens: 200 });
      const json = this._extractJsonObject(raw);
      if (!json) return null;
      if (!json.title || !json.start) return null;
      // Sanity: start must look like an ISO datetime.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(json.start)) return null;
      return json;
    } catch { return null; }
  }

  async _nluExtractCalendarMove(userMessage, config) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const sysPrompt =
      `You extract reschedule-event parameters from natural language.\n` +
      `Today is ${todayIso}. Output ONLY a JSON object:\n` +
      `  - title (string, the event to find and move)\n` +
      `  - oldDate (string, original date if mentioned, format "YYYY-MM-DD"; else null)\n` +
      `  - newStart (string, NEW datetime "YYYY-MM-DDTHH:MM:00")\n` +
      `  - newEnd (string, optional, same format)\n` +
      `If "domani" → ${this._addDaysIso(todayIso, 1).slice(0, 10)}. Output JSON only.`;
    try {
      const raw = await callLLM(config, sysPrompt, userMessage, { temperature: 0, maxTokens: 200 });
      const json = this._extractJsonObject(raw);
      if (!json) return null;
      if (!json.newStart) return null;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(json.newStart)) return null;
      return json;
    } catch { return null; }
  }

  /** Robust JSON object extractor — strips fences, finds the first balanced {...}. */
  _extractJsonObject(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    if (start < 0) return null;
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true; continue; }
      if (c === '"' && !esc) inStr = !inStr;
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  }

  _addDaysIso(isoDate, days) {
    const d = new Date(isoDate + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  // ── Direct fresh EMAIL action (LLM only for NLU, executor server-side) ──
  // Detects "manda email a X riguardo Y" style requests, extracts recipient
  // + subject + body via a tiny LLM call, then sends via gmail_send tool.
  async _tryDirectFreshEmailAction(userMessage, config) {
    if (!userMessage || typeof userMessage !== 'string') return null;
    const lower = userMessage.toLowerCase();
    const isEmailSend = /\b(manda|mand[oa]|invi[oa]|spedis(ci|co)|scriv[io]|send|email\s+to|mail\s+to)\s+(?:un'?\s+)?(email|mail|messaggio|messag|e-?mail)\s+/i.test(lower)
                     || /\b(invi[oa]r[ea]|mand[ao]|spedire)\s+un'?\s*e[- ]?mail\b/i.test(lower);
    if (!isEmailSend) return null;

    const parsed = await this._nluExtractEmailSend(userMessage, config);
    if (!parsed || !parsed.to || !parsed.body) return null;

    const { executeTool } = await import('./tool-executor.mjs');
    try {
      const result = await executeTool('gmail_send', {
        to: parsed.to,
        subject: parsed.subject || '(no subject)',
        body: parsed.body,
      }, config);
      const ok = typeof result === 'string' && /sent|inviat|✅|message-?id/i.test(result);
      const message = ok
        ? `Fatto. Email inviata a ${parsed.to}${parsed.subject ? ` con oggetto "${parsed.subject}"` : ''}.`
        : `Non sono riuscito a inviare l'email: ${result}`;
      if (this._lastDirectAuditChatId) {
        this._recordAudit(this._lastDirectAuditChatId, {
          tool: 'gmail_send',
          success: ok,
          summary: `→ ${parsed.to}${parsed.subject ? ` · "${parsed.subject}"` : ''}`,
        });
      }
      return { action: 'gmail_send', success: ok, message };
    } catch (e) {
      return { action: 'gmail_send', success: false, message: `Errore nell'invio: ${e.message}` };
    }
  }

  async _nluExtractEmailSend(userMessage, config) {
    const sysPrompt =
      `You extract email-send parameters from natural language. Output ONLY a JSON object:\n` +
      `  - to (string, recipient email or name if email unknown)\n` +
      `  - subject (string, the email subject; if missing, infer a 2-6 word summary)\n` +
      `  - body (string, the email body in the same language as the user)\n` +
      `Rules: if any field is genuinely missing AND impossible to infer, use null. ` +
      `Keep body short and natural. Output JSON only, no markdown.`;
    try {
      const raw = await callLLM(config, sysPrompt, userMessage, { temperature: 0, maxTokens: 400 });
      const json = this._extractJsonObject(raw);
      if (!json || !json.to || !json.body) return null;
      return json;
    } catch { return null; }
  }

  // ── Direct fresh TASK action (add / complete) ──────────────────────────
  async _tryDirectFreshTaskAction(userMessage, config) {
    if (!userMessage || typeof userMessage !== 'string') return null;
    const lower = userMessage.toLowerCase();
    const isTaskAdd = /\b(aggiung|cre[oai]|fiss|segn|metti|add|create)\w*\s+.*\b(task|attivit[àa]|cosa\s+da\s+fare|todo|to[- ]?do|promemoria\s+da\s+fare)/i.test(lower);
    const isTaskDone = /\b(complet|fatt[oa]|done|fini[stct]|chiud|spunt|tick|mark\s+as\s+done)\w*\s+.*\b(task|attivit[àa]|todo|to[- ]?do)/i.test(lower);
    const { executeTool } = await import('./tool-executor.mjs');
    if (isTaskAdd) {
      const parsed = await this._nluExtractTaskAdd(userMessage, config);
      if (!parsed?.title) return null;
      try {
        const r = await executeTool('task_add', { title: parsed.title, due: parsed.due || null, priority: parsed.priority || 'medium' }, config);
        const ok = typeof r === 'string' && !/error/i.test(r);
        if (this._lastDirectAuditChatId) this._recordAudit(this._lastDirectAuditChatId, { tool: 'task_add', success: ok, summary: `"${parsed.title}"${parsed.due ? ` (entro ${parsed.due})` : ''}` });
        return { action: 'task_add', success: ok, message: ok ? `Fatto. Ho aggiunto il task "${parsed.title}"${parsed.due ? ` con scadenza ${parsed.due}` : ''}.` : `Errore: ${r}` };
      } catch (e) { return { action: 'task_add', success: false, message: `Errore: ${e.message}` }; }
    }
    if (isTaskDone) {
      const parsed = await this._nluExtractTaskRef(userMessage, config);
      if (!parsed?.title) return null;
      try {
        const r = await executeTool('task_complete', { title: parsed.title }, config);
        const ok = typeof r === 'string' && !/error|not found/i.test(r);
        if (this._lastDirectAuditChatId) this._recordAudit(this._lastDirectAuditChatId, { tool: 'task_complete', success: ok, summary: `"${parsed.title}"` });
        return { action: 'task_complete', success: ok, message: ok ? `Fatto. Task "${parsed.title}" segnato come completato.` : `Errore: ${r}` };
      } catch (e) { return { action: 'task_complete', success: false, message: `Errore: ${e.message}` }; }
    }
    return null;
  }

  // ── Direct fresh NOTE add ───────────────────────────────────────────────
  async _tryDirectFreshNoteAction(userMessage, config) {
    if (!userMessage || typeof userMessage !== 'string') return null;
    const lower = userMessage.toLowerCase();
    const isNoteAdd = /\b(crea|nuov[oa]|aggiung|salv|prend|scriv|appunt|new|add|save)\w*\s+(?:una\s+)?\b(nota|note|appunt)/i.test(lower);
    if (!isNoteAdd) return null;
    const parsed = await this._nluExtractNoteAdd(userMessage, config);
    if (!parsed?.title) return null;
    const { executeTool } = await import('./tool-executor.mjs');
    try {
      const r = await executeTool('note_add', { title: parsed.title, content: parsed.content || '' }, config);
      const ok = typeof r === 'string' && !/error/i.test(r);
      if (this._lastDirectAuditChatId) this._recordAudit(this._lastDirectAuditChatId, { tool: 'note_add', success: ok, summary: `"${parsed.title}"` });
      return { action: 'note_add', success: ok, message: ok ? `Fatto. Nota "${parsed.title}" salvata.` : `Errore: ${r}` };
    } catch (e) { return { action: 'note_add', success: false, message: `Errore: ${e.message}` }; }
  }

  // ── Direct fresh REMINDER create ────────────────────────────────────────
  async _tryDirectFreshReminderAction(userMessage, config) {
    if (!userMessage || typeof userMessage !== 'string') return null;
    const lower = userMessage.toLowerCase();
    const isReminder = /\b(ricordami|reminder|promemoria|ricord[aoo]|notificami|avvisami|remind)\b/i.test(lower);
    if (!isReminder) return null;
    const parsed = await this._nluExtractReminder(userMessage, config);
    if (!parsed?.message || !parsed?.when) return null;
    const { executeTool } = await import('./tool-executor.mjs');
    try {
      const r = await executeTool('reminder_create', { message: parsed.message, when: parsed.when }, config);
      const ok = typeof r === 'string' && !/error/i.test(r);
      if (this._lastDirectAuditChatId) this._recordAudit(this._lastDirectAuditChatId, { tool: 'reminder_create', success: ok, summary: `"${parsed.message}" @ ${parsed.when}` });
      return { action: 'reminder_create', success: ok, message: ok ? `Fatto. Promemoria impostato: "${parsed.message}" per ${parsed.when}.` : `Errore: ${r}` };
    } catch (e) { return { action: 'reminder_create', success: false, message: `Errore: ${e.message}` }; }
  }

  // ── Direct fresh SLACK send ─────────────────────────────────────────────
  async _tryDirectFreshSlackAction(userMessage, config) {
    if (!userMessage || typeof userMessage !== 'string') return null;
    const lower = userMessage.toLowerCase();
    const isSlackSend = /\b(manda|invi[ao]|posta|scriv[io]|send|post)\s+.*\b(slack|canale|channel|#)/i.test(lower)
                     || /\bsu\s+slack\b/i.test(lower);
    if (!isSlackSend) return null;
    const parsed = await this._nluExtractSlackSend(userMessage, config);
    if (!parsed?.channel || !parsed?.text) return null;
    const { executeTool } = await import('./tool-executor.mjs');
    try {
      const r = await executeTool('slack_send', { channel: parsed.channel, text: parsed.text }, config);
      const ok = typeof r === 'string' && !/error|not found/i.test(r);
      if (this._lastDirectAuditChatId) this._recordAudit(this._lastDirectAuditChatId, { tool: 'slack_send', success: ok, summary: `→ ${parsed.channel}: "${parsed.text.slice(0, 60)}"` });
      return { action: 'slack_send', success: ok, message: ok ? `Fatto. Messaggio inviato a ${parsed.channel}.` : `Errore: ${r}` };
    } catch (e) { return { action: 'slack_send', success: false, message: `Errore: ${e.message}` }; }
  }

  // ── NLU extractors (LLM-driven JSON parsing only, never tool execution) ──
  async _nluExtractTaskAdd(userMessage, config) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const sys = `Today is ${todayIso}. Extract task params from the message. Output ONLY JSON:\n` +
      `  - title (string, the task description)\n` +
      `  - due (string, "YYYY-MM-DD" if mentioned, else null)\n` +
      `  - priority ("low" | "medium" | "high" | null)`;
    try { return this._extractJsonObject(await callLLM(config, sys, userMessage, { temperature: 0, maxTokens: 200 })); } catch { return null; }
  }
  async _nluExtractTaskRef(userMessage, config) {
    const sys = `Extract which task to mark completed. Output ONLY JSON:\n  - title (string)`;
    try { return this._extractJsonObject(await callLLM(config, sys, userMessage, { temperature: 0, maxTokens: 150 })); } catch { return null; }
  }
  async _nluExtractNoteAdd(userMessage, config) {
    const sys = `Extract a new-note request. Output ONLY JSON:\n  - title (string)\n  - content (string, can be empty)`;
    try { return this._extractJsonObject(await callLLM(config, sys, userMessage, { temperature: 0, maxTokens: 400 })); } catch { return null; }
  }
  async _nluExtractReminder(userMessage, config) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const sys = `Today is ${todayIso}. Extract reminder params. Output ONLY JSON:\n` +
      `  - message (string, what to remind)\n  - when (string, ISO datetime "YYYY-MM-DDTHH:MM:00")`;
    try { return this._extractJsonObject(await callLLM(config, sys, userMessage, { temperature: 0, maxTokens: 200 })); } catch { return null; }
  }
  async _nluExtractSlackSend(userMessage, config) {
    const sys = `Extract Slack-send params. Output ONLY JSON:\n` +
      `  - channel (string, with "#" prefix for channels or "@user" for DMs)\n  - text (string, message body)`;
    try { return this._extractJsonObject(await callLLM(config, sys, userMessage, { temperature: 0, maxTokens: 300 })); } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════
  // UNIVERSAL DIRECT-ACTION DISPATCHER
  // ════════════════════════════════════════════════════════════════════════
  // Covers ALL 22 mutation tools in `DESTRUCTIVE_ACTIONS` (gmail, imap,
  // calendar, contacts, tasks, slack, github, file, drive, notify).
  // The LLM is used ONLY to (a) decide if the message maps to a tool and
  // (b) extract the params as JSON. Tool execution is then deterministic
  // server-side. No tool block is parsed from natural language by the
  // model — the model can never "say done" without us actually doing it.
  async _tryDirectFreshUniversalAction(userMessage, config) {
    if (!userMessage || typeof userMessage !== 'string' || userMessage.length < 3) return null;

    const todayIso = new Date().toISOString().slice(0, 10);
    const sys =
      `You are a tool-routing classifier. Given a user message in any language, decide whether it ` +
      `requests a state-changing action that maps to ONE of these tools, and extract the params.\n\n` +
      `ALLOWED TOOLS (you MUST pick one of these OR return null):\n` +
      // Calendar
      `- calendar_create(summary, start, end, description?)    — start/end ISO "YYYY-MM-DDTHH:MM:00"\n` +
      `- calendar_move(eventId? OR title, newStart, newEnd?)   — if no eventId, title is used to find it\n` +
      `- calendar_update(eventId? OR title, summary?, start?, end?, description?)\n` +
      `- calendar_delete(eventId? OR title, date?)\n` +
      // Email Gmail
      `- gmail_send(to, subject, body)                         — primary email account\n` +
      `- gmail_reply(messageId? OR threadHint, body)\n` +
      `- gmail_delete(messageId? OR query)\n` +
      `- gmail_mark_read(messageId, isRead?)\n` +
      `- gmail_mark_starred(messageId, starred?)\n` +
      `- gmail_archive(messageId)\n` +
      // Email IMAP
      `- imap_send(accountId?, to, subject, body)              — custom IMAP account\n` +
      `- imap_reply(accountId?, messageId, body)\n` +
      `- imap_trash(messageId)\n` +
      `- imap_mark_read(messageId, isRead?)\n` +
      `- imap_draft(accountId?, to, subject, body)\n` +
      // Contacts
      `- contact_add(name, email?, phone?, company?, address?)\n` +
      `- contact_update(query, email?, phone?, company?, address?)\n` +
      `- contact_delete(query)\n` +
      // Tasks
      `- task_add(title, priority?, due?)\n` +
      `- task_done(title)\n` +
      `- task_delete(title)\n` +
      // Google Tasks
      `- gtask_add(title, notes?, due?)\n` +
      `- gtask_complete(title)\n` +
      // Notes
      `- note_add(title, content?)\n` +
      // Reminders
      `- notify_remind(message, when)                          — when = ISO datetime\n` +
      `- reminder_create(message, when)\n` +
      // Slack
      `- slack_send(channel, text, threadTs?)                  — channel "#name"\n` +
      `- slack_dm(user, text)                                  — user = name, id, or email\n` +
      `- slack_react(channel, ts, emoji)\n` +
      `- slack_mark_read(channel, ts)\n` +
      // Notion
      `- notion_page(title, content)                           — create a new Notion page\n` +
      // GitHub
      `- github_create_issue(repo, title, body?, labels?)      — repo "owner/name"\n` +
      // File system (local to user)
      `- file_write(path, content)\n` +
      `- file_move(from, to)\n` +
      `- file_delete(path)\n` +
      `- file_mkdir(path)\n` +
      // Google Drive
      `- drive_upload(name, content, mimeType?)                — Google Drive\n` +
      `- drive_update(fileId, content)\n` +
      `- drive_delete(fileId? OR name)\n` +
      `- drive_move(fileId, newParentFolderId? OR newName?)\n` +
      `- drive_share(fileId, email, role?)                     — role = "reader"|"writer"|"commenter"\n` +
      // Birthdays
      `- birthday_add(name, date)                              — date "YYYY-MM-DD" or "MM-DD"\n` +
      `- birthday_delete(name)\n` +
      // Alexandria E2E
      `- alexandria_send(channel, message)\n` +
      // Cron
      `- cron_create(name, schedule, command)                  — schedule = cron expression\n` +
      `- cron_delete(name)\n\n` +
      `Today is ${todayIso}. Relative dates: "domani" = ${this._addDaysIso(todayIso, 1).slice(0, 10)}, ` +
      `"dopodomani" = ${this._addDaysIso(todayIso, 2).slice(0, 10)}, "lunedì/martedì/..." resolve to next occurrence.\n\n` +
      `OUTPUT FORMAT (strict JSON, no markdown, no prose, no fences):\n` +
      `{"tool": "tool_name" | null, "params": { ... }}\n\n` +
      `If the message is a READ/LIST/QUERY operation (e.g. "mostra…", "che ho oggi", "leggi email", "trova"), ` +
      `OR is conversational chat (greetings, questions, opinions) OR is ambiguous → return {"tool": null}.\n` +
      `If a required param is genuinely missing AND not inferable → return {"tool": null}.\n` +
      `Never invent emails, eventIds, or recipient addresses.`;

    let raw;
    try {
      raw = await callLLM(config, sys, userMessage, { temperature: 0, maxTokens: 400 });
    } catch (e) {
      this.log(`[direct-universal] LLM call failed: ${e.message}`);
      return null;
    }
    const parsed = this._extractJsonObject(raw);
    if (!parsed || !parsed.tool || !DESTRUCTIVE_ACTIONS.has(parsed.tool)) return null;
    if (!parsed.params || typeof parsed.params !== 'object') return null;

    // Per-tool param normalization (matches the executor's accepted shapes).
    const params = { ...parsed.params };
    if (parsed.tool === 'calendar_create' && !params.summary) params.summary = params.title || params.name || params.subject;
    if (parsed.tool === 'calendar_create' && params.start && !params.end) params.end = this._addMinutesIso(params.start, 60);

    try {
      const result = await executeTool(parsed.tool, params, config);
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      const ok = !/error|failed|not\s+found|invalid|does\s+not\s+exist|placeholder/i.test(resultStr);

      if (this._lastDirectAuditChatId) {
        this._recordAudit(this._lastDirectAuditChatId, {
          tool: parsed.tool,
          success: ok,
          summary: this._summarizeParamsForAudit(parsed.tool, params),
        });
      }
      const message = ok
        ? this._formatActionResultIT(parsed.tool, params, resultStr)
        : `Non sono riuscito a eseguire ${parsed.tool}: ${resultStr.slice(0, 240)}`;
      return { action: parsed.tool, success: ok, message };
    } catch (e) {
      return { action: parsed.tool, success: false, message: `Errore durante ${parsed.tool}: ${e.message}` };
    }
  }

  /** Natural-language Italian summary for the audit log entry. */
  _summarizeParamsForAudit(tool, params) {
    if (tool.startsWith('calendar_')) {
      const t = params.summary || params.title || '';
      const s = params.start ? this._formatDateIT(String(params.start).slice(0, 10)) + ` ${String(params.start).slice(11, 16)}` : '';
      return `"${t}"${s ? ` · ${s}` : ''}`;
    }
    if (tool === 'gmail_send' || tool === 'imap_send') return `→ ${params.to || '?'} · "${(params.subject || '').slice(0, 60)}"`;
    if (tool === 'gmail_reply' || tool === 'imap_reply') return `reply → ${params.to || params.messageId || '?'}`;
    if (tool === 'slack_send') return `→ ${params.channel || '?'} · "${(params.text || '').slice(0, 60)}"`;
    if (tool === 'notify_remind') return `"${params.message || ''}" @ ${params.when || '?'}`;
    if (tool === 'github_create_issue') return `${params.repo || '?'}: "${params.title || ''}"`;
    if (tool === 'file_write') return `${params.path || '?'} (${(params.content || '').length} chars)`;
    if (tool === 'drive_upload') return `${params.name || '?'} (${(params.content || '').length} chars)`;
    if (tool === 'task_done' || tool === 'task_delete' || tool === 'contact_delete') return `"${params.title || params.name || '?'}"`;
    return JSON.stringify(params).slice(0, 80);
  }

  /** Italian-language natural response for a successful action. */
  _formatActionResultIT(tool, params, result) {
    switch (tool) {
      case 'calendar_create': {
        const t = params.summary || params.title || 'evento';
        const when = params.start ? `${this._formatDateIT(String(params.start).slice(0, 10))} alle ${String(params.start).slice(11, 16)}` : '';
        return `Fatto. Ho creato l'appuntamento "${t}"${when ? ` il ${when}` : ''}.`;
      }
      case 'calendar_move':   return `Fatto. Appuntamento spostato.`;
      case 'calendar_update': return `Fatto. Appuntamento aggiornato.`;
      case 'calendar_delete': return `Fatto. Appuntamento cancellato.`;
      case 'gmail_send':
      case 'imap_send':       return `Fatto. Email inviata a ${params.to}.`;
      case 'gmail_reply':
      case 'imap_reply':      return `Fatto. Risposta inviata.`;
      case 'gmail_delete':    return `Fatto. Email eliminata.`;
      case 'imap_trash':      return `Fatto. Email spostata nel cestino.`;
      case 'contact_delete':  return `Fatto. Contatto "${params.name || ''}" cancellato.`;
      case 'task_done':       return `Fatto. Task "${params.title || ''}" completato.`;
      case 'task_delete':     return `Fatto. Task "${params.title || ''}" cancellato.`;
      case 'task_clear':      return `Fatto. Task list pulita.`;
      case 'notify_remind':   return `Promemoria impostato: "${params.message || ''}" per ${params.when || ''}.`;
      case 'slack_send':      return `Fatto. Messaggio inviato a ${params.channel || ''}.`;
      case 'github_create_issue': return `Issue creata su ${params.repo}: "${params.title}".`;
      case 'file_write':      return `Fatto. File ${params.path} scritto (${(params.content || '').length} caratteri).`;
      case 'drive_upload':    return `Fatto. "${params.name}" caricato su Google Drive.`;
      case 'drive_update':    return `Fatto. File Drive aggiornato.`;
      case 'drive_delete':    return `Fatto. File Drive eliminato.`;
      default: return `Fatto. ${result.slice(0, 200)}`;
    }
  }

  // ── Direct fresh calendar action (no LLM) ─────────────────────────────────
  // Detects DELETE / LIST_MONTH / LIST_WEEK / LIST_DAY / LIST_TODAY /
  // LIST_TOMORROW intents from a fresh user message and runs the proper tool
  // server-side. Returns { action, success, message } or null.
  //
  // Motivation: the model previously hallucinated "I cancelled it" with an
  // invented event ID, OR invented an entire list of fake appointments when
  // asked "give me May's appointments". Running the real tool removes the
  // hallucination surface entirely.
  async _tryDirectFreshCalendarAction(userMessage, config) {
    if (!userMessage || typeof userMessage !== 'string') return null;
    const lower = userMessage.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const chatId = this._lastDirectAuditChatId;
    const { executeTool: _executeToolPre } = await import('./tool-executor.mjs');

    // ─── PAGINATION: "mostra i prossimi / vai avanti / i restanti" ─────────
    // Deterministic next-page fetch from the cached lastCalendarEvents instead
    // of letting the LLM hallucinate "the remaining events" (Giovanni
    // Santaniello's bug: NHA inventing fake events when asked for page 2).
    const isPaginationRequest = /\b(mostra(?:mi)?\s+(?:i\s+)?(?:prossimi|altri|restanti|seguenti)|vai\s+avanti|continua\s+(?:l[ai']\s+)?(?:lista|elenco)|i\s+(?:prossimi|altri|restanti|seguenti)\s+\d*|gli\s+altri|dammi\s+(?:i\s+)?(?:prossimi|restanti|altri)|next\s+page|next\s+\d+|show\s+more|continue\b)/i.test(userMessage);
    if (isPaginationRequest) {
      // Pull from list-cache (works across all kinds) — calendar first.
      try {
        const cacheFile = path.join(os.homedir(), '.nha', 'list-cache.json');
        if (fs.existsSync(cacheFile)) {
          const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
          // Find the most recent calendar list across all chats
          let allItems = []; let shown = 0; let foundChatKey = null;
          for (const [k, v] of Object.entries(cache)) {
            if (Array.isArray(v?.lastList_calendar) && v.lastList_calendar.length > 0) {
              if (!foundChatKey || (v.lastList_calendar_at || 0) > (cache[foundChatKey]?.lastList_calendar_at || 0)) {
                foundChatKey = k;
                allItems = v.lastList_calendar;
                shown = v.lastList_calendar_shownCount || 0;
              }
            }
          }
          if (allItems.length > 0 && shown < allItems.length) {
            // Page size from regex capture or default 8
            const numMatch = userMessage.match(/\b(\d+)\b/);
            const pageSize = numMatch ? Math.min(parseInt(numMatch[1], 10), 20) : 8;
            const nextSlice = allItems.slice(shown, shown + pageSize);
            const lines = [`📅 Eventi ${shown + 1}-${shown + nextSlice.length} di ${allItems.length}:`];
            const byDay = new Map();
            for (const e of nextSlice) {
              const day = e.date || (e.start || '').slice(0, 10) || 'misc';
              if (!byDay.has(day)) byDay.set(day, []);
              byDay.get(day).push(e);
            }
            for (const [day, evs] of [...byDay.entries()].sort()) {
              const d = day !== 'misc' ? new Date(day + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
              if (d) lines.push(`\n${d}:`);
              for (const e of evs) lines.push(`  ${e.time || '—'} — ${e.summary}`);
            }
            const newShown = shown + nextSlice.length;
            const remaining = allItems.length - newShown;
            if (remaining > 0) lines.push(`\n... ${remaining} eventi rimanenti. Scrivi "mostra i prossimi" per continuare.`);
            else lines.push(`\n✓ Fine elenco.`);
            // Update shownCount in cache
            cache[foundChatKey].lastList_calendar_shownCount = newShown;
            fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
            this.log(`[direct] PAGINATION calendar: shown ${shown}→${newShown} of ${allItems.length}`);
            return { action: 'calendar_page', success: true, message: lines.join('\n') };
          }
          if (allItems.length > 0 && shown >= allItems.length) {
            return { action: 'calendar_page', success: true, message: '✓ Hai già visto tutti gli eventi. Scrivi "appuntamenti di oggi/settimana/maggio" per una nuova ricerca.' };
          }
        }
      } catch (e) { this.log(`[direct] pagination failed: ${e.message}`); }
      // Fall through if no cached list
    }

    // ─── ANAPHORIC delete + CONFIRMATION yes ────────────────────────────────
    // If the previous turn ran a LIST/LAST-SHOWN and the user now says
    // "cancellalo / eliminalo / quello / si / conferma / fallo", resolve the
    // referent from this._lastContextByChatId[chatId].lastCalendarEvents.
    // Wider regex: matches "cancellalo", "cancellali", "cancellatelo!",
    // "eliminali tutti", with any trailing punctuation.
    const isAnaphoric = /(cancell|elimin|rimuov)\w*\s*[!.?]?$/i.test(userMessage.trim())
      && !this._extractCalendarProposal(userMessage).date
      && !this._extractCalendarProposal(userMessage).title;
    const isYesConfirm = /^\s*(s[ìi]\b|si\s|sì\s|ok\b|okay\b|certo\b|certamente\b|d'?accordo\b|fai|fallo|procedi|esegui|conferm[oa]|yes\b|yep\b|confirm\b|do\s*it|go\s*ahead)/i.test(userMessage.trim());
    if (isAnaphoric || isYesConfirm) {
      // Look up the event list across multiple keys, in order of preference:
      //   1. exact chatId (if the caller passed one)
      //   2. any context key whose lastCalendarListAt is the most recent
      // This fixes a class of bugs where the chat UI generates a fresh
      // conversationId between turns, breaking the strict key lookup.
      let ctx = chatId ? (this._lastContextByChatId[chatId] || {}) : {};
      if (!ctx.lastCalendarEvents || ctx.lastCalendarEvents.length === 0) {
        // Fallback: scan every stored context for the most recent calendar list.
        let bestKey = null, bestAt = 0;
        for (const [k, v] of Object.entries(this._lastContextByChatId)) {
          if (Array.isArray(v?.lastCalendarEvents) && v.lastCalendarEvents.length > 0
              && (v.lastCalendarListAt || 0) > bestAt) {
            bestKey = k;
            bestAt = v.lastCalendarListAt || 0;
          }
        }
        if (bestKey) {
          this.log(`[direct] anaphoric fallback: chatId=${chatId} empty, using bestKey=${bestKey} (${Date.now() - bestAt}ms ago)`);
          ctx = this._lastContextByChatId[bestKey];
        }
      } else {
        this.log(`[direct] anaphoric hit: chatId=${chatId} eventsCount=${ctx.lastCalendarEvents.length}`);
      }
      const pendingEvents = ctx.lastCalendarEvents || ctx.pendingDeleteEvents || [];
      // Strict: only auto-execute if the previous turn LIST/proposal had a
      // single deletable event, or if pendingDelete is explicitly set.
      const eligible = ctx.pendingDeleteEvents && ctx.pendingDeleteEvents.length > 0
        ? ctx.pendingDeleteEvents
        : (pendingEvents.length === 1 ? pendingEvents : null);
      if (!eligible) {
        this.log(`[direct] anaphoric SKIP: ${isAnaphoric ? 'anaphoric' : 'yes-confirm'} matched but no eligible event. ctx keys: ${Object.keys(this._lastContextByChatId).join(',')}`);
      }
      if (eligible && eligible.length > 0) {
        let ok = 0, ko = 0;
        const failed = [];
        for (const ev of eligible) {
          if (!ev.eventId) { ko++; failed.push(ev.summary || '(no id)'); continue; }
          try {
            await _executeToolPre('calendar_delete', { eventId: ev.eventId }, config);
            ok++;
          } catch (e) {
            ko++;
            failed.push(`${ev.summary || ev.eventId} (${e.message?.slice(0, 60) || 'err'})`);
          }
        }
        // Clear the pending state so we don't double-delete on next yes.
        delete this._lastContextByChatId[chatId].pendingDeleteEvents;
        delete this._lastContextByChatId[chatId].lastCalendarEvents;
        try { saveTelegramContext(this._lastContextByChatId); } catch {}

        const subject = eligible.length === 1 ? `"${eligible[0].summary}"` : `${eligible.length} appuntamenti`;
        const lines = [`Ho cancellato ${subject}.`];
        if (ko > 0) lines.push(`Non sono riuscito a cancellarne ${ko}: ${failed.slice(0, 3).join(', ')}`);
        this._recordAudit(chatId, { tool: 'calendar_delete', success: ok > 0, summary: `cancellati ${ok}` });
        return { action: 'calendar_delete', success: ok > 0, message: lines.join('\n') };
      }
      // No eligible referent — fall through; the LLM will ask for clarification.
    }


    const MONTHS_IT = { gennaio:1, febbraio:2, marzo:3, aprile:4, maggio:5, giugno:6, luglio:7, agosto:8, settembre:9, ottobre:10, novembre:11, dicembre:12 };
    const MONTHS_EN = { january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11, december:12, jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
    const MONTH_MAP = { ...MONTHS_IT, ...MONTHS_EN };

    const isDelete = /\b(elimin|cancell|rimuov|cancel\b|delete\b|remove\b)\w*/.test(lower);
    const isList   = /\b(lista|elenco|mostra|mostrami|fammi vedere|fai vedere|tutti|dammi|dimmi|cosa\s+ho|che\s+impegni|impegni|appuntamenti|eventi|meeting|agenda|calendario)\b/.test(lower);
    // Verify intent — user is challenging or asking us to re-check a previous
    // calendar claim. Triggered by complaint phrases ("non vedo più", "sei
    // sicuro?", "hai sbagliato", "inaffidabile", "in realtà") combined with
    // a date or title reference. We answer FACTUALLY by re-querying the
    // calendar — never by apologizing in the abstract.
    const isVerify = /\b(non\s+(vedo|c'è|esiste)|c'è\s+(ancora|sempre)|è\s+ancora|stai\s+sbagliand|hai\s+sbagliat|in\s+realt[àa]|sei\s+sicur|davvero|inaffidabil|controlla|verifica|conferma\b|guarda)\b/.test(lower);
    // CREATE event intent — action verb + event noun. Robust enough to catch
    // "fissami un appuntamento dal dentista venerdì alle 10", "crea evento
    // ortocheratologia 18 maggio 10-11", "segna riunione con Marco lunedì 14:30".
    const isCreate = /\b(fiss|cre[oai]|aggiung|inserisc|programm|segn|prenoti?|impost|metti|registr|set\s+up|create|add|schedule|book)\w*\s+/.test(lower)
                  && /\b(appuntament|evento|event\b|meeting|riunion|incontro|chiamat|call\b|webinar|memo|reminder|promemoria|task|impegn)/i.test(lower);
    // MOVE intent — reschedule/postpone an existing event.
    const isMove = /\b(spost[ao]|rimand|rinvi|riprogramm|move|reschedule|postpone|cambia\s+(?:data|ora|orari))\w*/.test(lower)
                && /\b(appuntament|evento|event\b|meeting|riunion|incontro|chiamat|call\b)/i.test(lower);

    const { executeTool } = await import('./tool-executor.mjs');

    // ─── VERIFY intent ─────────────────────────────────────────────────────
    // User is challenging a prior action ("non c'è più", "sei sicuro?",
    // "hai sbagliato", "inaffidabile", "in realtà l'hai cancellato"). The
    // only honest reply is a factual re-check, NOT a vague apology. We
    // re-query the calendar and report exactly what's there.
    if (isVerify) {
      const extracted = this._extractCalendarProposal(userMessage);
      if (extracted.date || extracted.title) {
        let events = [];
        try {
          const { listEvents } = await import('./google-calendar.mjs');
          if (extracted.date) {
            const [yy, mm, dd] = extracted.date.split('-').map(n => parseInt(n, 10));
            const from = new Date(yy, mm - 1, dd);
            const to = new Date(from.getTime() + 86400000);
            const evs = await listEvents(config, 'primary', from, to);
            events = (evs || []).map(e => ({
              eventId: e.id, summary: e.summary || '', time: (e.start || '').slice(11, 16),
            }));
          } else if (extracted.title) {
            const from = new Date();
            const to = new Date(from.getTime() + 60 * 86400000);
            const evs = await listEvents(config, 'primary', from, to);
            events = (evs || []).map(e => ({
              eventId: e.id, summary: e.summary || '', time: (e.start || '').slice(11, 16),
            }));
          }
        } catch (e) {
          return { action: 'calendar_verify', success: false, message: `Errore durante la verifica: ${e.message}` };
        }

        const dateStr = extracted.date ? this._formatDateIT(extracted.date) : null;
        // Filter by title match if both date and title are present, to be precise.
        let matching = events;
        if (extracted.title && events.length > 0) {
          const norm = (s) => String(s || '').toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/).filter(t => t.length > 2);
          const titleTokens = norm(extracted.title);
          matching = events.filter(c => {
            const summaryTokens = new Set(norm(c.summary));
            const score = titleTokens.filter(t => summaryTokens.has(t)).length;
            return score >= Math.max(1, Math.ceil(titleTokens.length * 0.5));
          });
        }

        if (matching.length === 0) {
          // Event genuinely absent — confirm fact, no apology.
          const subject = extracted.title ? `"${extracted.title}"` : 'l\'appuntamento';
          const when = dateStr ? ` del ${dateStr}` : '';
          return {
            action: 'calendar_verify', success: true,
            message: `Confermato: ${subject}${when} NON è presente nel calendario. Risulta cancellato.`,
          };
        }
        // Event(s) still present.
        const list = matching.slice(0, 5).map((c, i) => `${i + 1}. ${c.time || '—'} ${c.summary}`).join('\n');
        return {
          action: 'calendar_verify', success: true,
          message: `Ho riverificato il calendario${dateStr ? ` per ${dateStr}` : ''}:\n\n${list}\n\nQuesti appuntamenti risultano ancora presenti.`,
        };
      }
      // No date/title to verify — fall through to LIST/DELETE detection.
    }

    // ─── CREATE intent ─────────────────────────────────────────────────────
    // We use a tiny LLM call ONLY to extract structured params from natural
    // language (NLU). Tool execution stays deterministic server-side. This
    // is the enterprise pattern: LLM for understanding + rendering, NEVER
    // for state-changing actions.
    if (isCreate && !isDelete && !isVerify) {
      const parsed = await this._nluExtractCalendarCreate(userMessage, config);
      if (parsed && parsed.title && parsed.start) {
        try {
          const result = await executeTool('calendar_create', {
            summary: parsed.title,
            start: parsed.start,
            end: parsed.end || this._addMinutesIso(parsed.start, 60),
            description: parsed.description || '',
          }, config);
          const ok = typeof result === 'string' && /created|event\s+"|eventId/i.test(result);
          const startLabel = `${this._formatDateIT(parsed.start.slice(0, 10))} alle ${parsed.start.slice(11, 16)}`;
          const message = ok
            ? `Fatto. Ho creato l'appuntamento "${parsed.title}" il ${startLabel}.`
            : `Non sono riuscito a creare l'appuntamento: ${result}`;
          if (this._lastDirectAuditChatId) {
            this._recordAudit(this._lastDirectAuditChatId, {
              tool: 'calendar_create',
              success: ok,
              summary: `"${parsed.title}" il ${startLabel}`,
            });
          }
          return { action: 'calendar_create', success: ok, message };
        } catch (e) {
          return { action: 'calendar_create', success: false, message: `Errore durante la creazione: ${e.message}` };
        }
      }
      // Couldn't extract title/date with confidence → let the LLM ask the user.
      // Fall through.
    }

    // ─── MOVE intent ───────────────────────────────────────────────────────
    if (isMove && !isDelete && !isVerify && !isCreate) {
      const parsed = await this._nluExtractCalendarMove(userMessage, config);
      if (parsed && (parsed.title || parsed.oldDate) && parsed.newStart) {
        // Find the source event — use listEvents directly (parser fails
        // because calendar_date/find don't expose eventIds in their text).
        let candidates = [];
        try {
          const { listEvents } = await import('./google-calendar.mjs');
          if (parsed.oldDate) {
            const [yy, mm, dd] = parsed.oldDate.split('-').map(n => parseInt(n, 10));
            const from = new Date(yy, mm - 1, dd);
            const to = new Date(from.getTime() + 86400000);
            const evs = await listEvents(config, 'primary', from, to);
            candidates = (evs || []).map(e => ({ eventId: e.id, summary: e.summary || '' }));
          }
          if (candidates.length === 0 && parsed.title) {
            // Broad search across next 60 days
            const from = new Date();
            const to = new Date(from.getTime() + 60 * 86400000);
            const evs = await listEvents(config, 'primary', from, to);
            candidates = (evs || [])
              .filter(e => String(e.summary || '').toLowerCase().includes(parsed.title.toLowerCase()))
              .map(e => ({ eventId: e.id, summary: e.summary || '' }));
          }
        } catch (e) {
          return { action: 'calendar_move', success: false, message: `Errore nella ricerca dell'evento: ${e.message}` };
        }
        // Match by title token overlap, same heuristic as DELETE.
        const norm = (s) => String(s || '').toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/).filter(t => t.length > 2);
        let match = null;
        if (parsed.title) {
          const titleTokens = norm(parsed.title);
          const scored = candidates.map(c => {
            const summaryTokens = new Set(norm(c.summary));
            const score = titleTokens.filter(t => summaryTokens.has(t)).length;
            return { c, score };
          }).sort((a, b) => b.score - a.score);
          const top = scored[0];
          if (top && top.score >= Math.max(1, Math.ceil(titleTokens.length * 0.5))) match = top.c;
        }
        if (!match && candidates.length === 1) match = candidates[0];
        if (!match || !match.eventId) {
          return { action: 'calendar_move', success: false,
            message: `Non ho trovato l'appuntamento "${parsed.title || ''}" da spostare. Verifica titolo o data originale.` };
        }
        try {
          const result = await executeTool('calendar_move', {
            eventId: match.eventId,
            newStart: parsed.newStart,
            newEnd: parsed.newEnd || this._addMinutesIso(parsed.newStart, 60),
          }, config);
          const ok = typeof result === 'string' && /rescheduled|moved|spostat/i.test(result);
          const newLabel = `${this._formatDateIT(parsed.newStart.slice(0, 10))} alle ${parsed.newStart.slice(11, 16)}`;
          const message = ok
            ? `Fatto. Ho spostato "${match.summary}" al ${newLabel}.`
            : `Non sono riuscito a spostare l'appuntamento: ${result}`;
          if (this._lastDirectAuditChatId) {
            this._recordAudit(this._lastDirectAuditChatId, {
              tool: 'calendar_move',
              success: ok,
              summary: `"${match.summary}" → ${newLabel} (eventId ${match.eventId.slice(0, 16)}…)`,
            });
          }
          return { action: 'calendar_move', success: ok, message };
        } catch (e) {
          return { action: 'calendar_move', success: false, message: `Errore nello spostamento: ${e.message}` };
        }
      }
    }

    // ─── LIST intents ──────────────────────────────────────────────────────
    if (isList && !isDelete && !isVerify && !isCreate && !isMove) {
      // Helper that runs the tool, parses the events and remembers them for
      // anaphoric resolution in the NEXT turn ("cancellalo", "spostali tutti").
      const runListAndRemember = async (toolName, args, actionKey) => {
        try {
          const out = await executeTool(toolName, args, config);
          // Reset pagination state for this kind: a NEW list starts fresh.
          try {
            const cacheFile = path.join(os.homedir(), '.nha', 'list-cache.json');
            if (fs.existsSync(cacheFile)) {
              const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
              const persistKey = chatId || '__last_list__';
              if (cache[persistKey]) delete cache[persistKey].lastList_calendar_shownCount;
              fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
            }
          } catch {}
          // Parse from text first (cheap, works when tools include event IDs).
          let events = this._parseEventsFromToolOutput(String(out));
          // Fallback: tools like calendar_month don't print event IDs in their
          // pretty-printed output, so we MUST call listEvents() directly to
          // get structured objects with real Google Calendar event IDs.
          // Without this, anaphoric "cancellalo" can never resolve.
          if (events.length === 0) {
            try {
              const { listEvents } = await import('./google-calendar.mjs');
              const range = this._computeRangeForListTool(toolName, args);
              if (range) {
                const evs = await listEvents(config, 'primary', range.from, range.to);
                events = (evs || []).map(e => ({
                  eventId: e.id,
                  summary: e.summary || '(senza titolo)',
                  time: (e.start || '').slice(11, 16),
                  date: (e.start || '').slice(0, 10),
                }));
                this.log(`[direct] LIST structured fallback: ${events.length} events via listEvents(${range.from.toISOString().slice(0,10)}..${range.to.toISOString().slice(0,10)})`);
              }
            } catch (e) { this.log(`[direct] LIST structured fallback failed: ${e.message}`); }
          }
          // Even without chatId, save to a global fallback bucket so the
          // anaphoric resolution can still find it.
          const persistKey = chatId || '__last_list__';
          const prev = this._lastContextByChatId[persistKey] || {};
          this._lastContextByChatId[persistKey] = {
            ...prev,
            lastCalendarEvents: events,
            lastCalendarListAt: Date.now(),
            lastCalendarSource: { tool: toolName, args },
          };
          this.log(`[direct] LIST stored: chatId=${persistKey} eventsCount=${events.length} tool=${toolName}`);
          try { saveTelegramContext(this._lastContextByChatId); } catch (e) { this.log(`[direct] persist FAILED: ${e.message}`); }

          // ── PAGINATION CAP (Giovanni's bug, v16.0.23) ──
          // Telegram limits messages to 4096 chars. If the list has many events,
          // show first 8 with footer "scrivi 'mostra i prossimi' per continuare"
          // and persist shownCount in list-cache so pagination is deterministic.
          const PAGE_SIZE = 8;
          if (events.length > PAGE_SIZE) {
            const firstPage = events.slice(0, PAGE_SIZE);
            const lines = [`📅 ${firstPage.length} eventi (di ${events.length} totali):`];
            const byDay = new Map();
            for (const e of firstPage) {
              const day = e.date || (e.start || '').slice(0, 10) || 'misc';
              if (!byDay.has(day)) byDay.set(day, []);
              byDay.get(day).push(e);
            }
            for (const [day, evs] of [...byDay.entries()].sort()) {
              const d = day !== 'misc' ? new Date(day + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
              if (d) lines.push(`\n${d}:`);
              for (const e of evs) lines.push(`  ${e.time || '—'} — ${e.summary}`);
            }
            lines.push(`\n... ${events.length - PAGE_SIZE} eventi rimanenti. Scrivi "mostra i prossimi" per continuare.`);
            // Mark shownCount in list-cache so the pagination handler picks up from here.
            try {
              const cacheFile = path.join(os.homedir(), '.nha', 'list-cache.json');
              const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) : {};
              cache[persistKey] = cache[persistKey] || {};
              cache[persistKey].lastList_calendar_shownCount = PAGE_SIZE;
              fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
            } catch {}
            return { action: actionKey, success: true, message: lines.join('\n') };
          }
          return { action: actionKey, success: true, message: String(out) };
        } catch (e) { return { action: actionKey, success: false, message: `Errore: ${e.message}` }; }
      };

      if (/\b(oggi|today)\b/.test(lower))
        return await runListAndRemember('calendar_today', {}, 'calendar_today');
      if (/\b(domani|tomorrow)\b/.test(lower))
        return await runListAndRemember('calendar_tomorrow', {}, 'calendar_tomorrow');
      // "settimana prossima / next week / settimana che viene" → calendar_week
      // starting next Monday. Without this offset, calendar_week always shows
      // the CURRENT week, which is wrong for "settimana prossima" and lets
      // the LLM hallucinate a fake list of upcoming events.
      if (/\b(settimana\s+(prossima|che\s+viene|seguente)|next\s+week|prossima\s+settimana)\b/.test(lower)) {
        const today = new Date();
        const dayOfWeek = today.getDay(); // 0=sun..6=sat
        const daysUntilMonday = ((1 - dayOfWeek + 7) % 7) || 7;
        const nextMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysUntilMonday);
        const startDate = nextMonday.toISOString().slice(0, 10);
        return await runListAndRemember('calendar_week', { startDate }, 'calendar_week_next');
      }
      if (/\b(settimana\s+scorsa|last\s+week|scorsa\s+settimana)\b/.test(lower)) {
        const today = new Date();
        const dayOfWeek = today.getDay();
        const daysToLastMonday = (dayOfWeek === 0 ? 6 : dayOfWeek - 1) + 7;
        const lastMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysToLastMonday);
        const startDate = lastMonday.toISOString().slice(0, 10);
        return await runListAndRemember('calendar_week', { startDate }, 'calendar_week_last');
      }
      if (/\b(settimana|week|questa\s+settimana|this\s+week)\b/.test(lower))
        return await runListAndRemember('calendar_week', {}, 'calendar_week');
      const monthMatch = lower.match(new RegExp(`\\b(${Object.keys(MONTH_MAP).join('|')})(?:\\s+(20\\d{2}))?\\b`));
      if (monthMatch) {
        const monthNum = MONTH_MAP[monthMatch[1]];
        const yearNum = parseInt(monthMatch[2] || String(new Date().getFullYear()), 10);
        const monthStr = `${yearNum}-${String(monthNum).padStart(2, '0')}`;
        return await runListAndRemember('calendar_month', { month: monthStr }, 'calendar_month');
      }
      const dateExtracted = this._extractCalendarProposal(userMessage);
      if (dateExtracted.date)
        return await runListAndRemember('calendar_date', { date: dateExtracted.date }, 'calendar_date');
      if (/\b(prossim|next|upcoming|in\s+arrivo)/.test(lower))
        return await runListAndRemember('calendar_upcoming', { hours: 48 }, 'calendar_upcoming');
      // Fall through — let the LLM handle ambiguous list requests.
    }

    // ─── DELETE intents ────────────────────────────────────────────────────
    // Reuse the same proposal extractor — it works on raw user text too,
    // because it just looks for title quotes / dates / times.
    if (isDelete) {
      // ─── BULK DELETE: "cancella TUTTI gli appuntamenti di MAGGIO"
      // Trigger when isDelete + "tutti/all/everything" + (month name | week | "oggi" | "domani"
      // | specific date). Iterate over the list and delete each one. Honest
      // reporting: tell the user how many were deleted vs failed.
      const isBulk = /\b(tutti|tutte|all|every(thing)?|in\s+tot)\b/.test(lower);
      const monthMatch = lower.match(new RegExp(`\\b(${Object.keys(MONTH_MAP).join('|')})(?:\\s+(20\\d{2}))?\\b`));
      const isOggi   = /\b(oggi|today)\b/.test(lower);
      const isDomani = /\b(domani|tomorrow)\b/.test(lower);
      const isWeek   = /\b(questa\s+settimana|della\s+settimana|this\s+week|della\s+week)\b/.test(lower);
      if (isBulk && (monthMatch || isOggi || isDomani || isWeek)) {
        // 1. Fetch the events in that timeframe via the right list tool.
        let listing = '';
        let scopeLabel = '';
        try {
          if (monthMatch) {
            const monthNum = MONTH_MAP[monthMatch[1]];
            const yearNum = parseInt(monthMatch[2] || String(new Date().getFullYear()), 10);
            const monthStr = `${yearNum}-${String(monthNum).padStart(2, '0')}`;
            listing = String(await executeTool('calendar_month', { month: monthStr }, config));
            scopeLabel = `di ${monthMatch[1]} ${yearNum}`;
          } else if (isOggi) {
            listing = String(await executeTool('calendar_today', {}, config));
            scopeLabel = 'di oggi';
          } else if (isDomani) {
            listing = String(await executeTool('calendar_tomorrow', {}, config));
            scopeLabel = 'di domani';
          } else if (isWeek) {
            listing = String(await executeTool('calendar_week', {}, config));
            scopeLabel = 'di questa settimana';
          }
        } catch (e) {
          return { action: 'calendar_delete_bulk', success: false, message: `Errore nel recupero degli appuntamenti: ${e.message}` };
        }
        const events = this._parseEventsFromToolOutput(listing);
        if (!events || events.length === 0) {
          return { action: 'calendar_delete_bulk', success: true,
            message: `Nessun appuntamento ${scopeLabel} da cancellare. Calendario già vuoto in quell'intervallo.` };
        }
        // 2. Delete each event with a real tool call. Track failures.
        let ok = 0, ko = 0;
        const failed = [];
        for (const ev of events) {
          if (!ev.eventId) { ko++; failed.push(ev.summary || '(no title)'); continue; }
          try {
            await executeTool('calendar_delete', { eventId: ev.eventId }, config);
            ok++;
          } catch (e) {
            ko++;
            failed.push(`${ev.summary || ev.eventId} (${e.message?.slice(0, 60) || 'err'})`);
          }
        }
        // 3. Honest, factual summary.
        const lines = [`Ho cancellato ${ok} appuntament${ok === 1 ? 'o' : 'i'} ${scopeLabel}.`];
        if (ko > 0) {
          lines.push(`Non sono riuscito a cancellarne ${ko}: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`);
        }
        if (this._lastDirectAuditChatId) {
          this._recordAudit(this._lastDirectAuditChatId, {
            tool: 'calendar_delete_bulk',
            success: ok > 0,
            summary: `${ok} cancellati ${scopeLabel}, ${ko} falliti`,
          });
        }
        return { action: 'calendar_delete_bulk', success: ok > 0, message: lines.join('\n') };
      }

      const extracted = this._extractCalendarProposal(userMessage);
      if (!extracted.date && !extracted.title) return null;

      let candidates = [];
      try {
        const { listEvents } = await import('./google-calendar.mjs');
        if (extracted.date) {
          const [yy, mm, dd] = extracted.date.split('-').map(n => parseInt(n, 10));
          const from = new Date(yy, mm - 1, dd);
          const to = new Date(from.getTime() + 86400000);
          const evs = await listEvents(config, 'primary', from, to);
          candidates = (evs || []).map(e => ({
            eventId: e.id, summary: e.summary || '', time: (e.start || '').slice(11, 16),
          }));
        }
        if (candidates.length === 0 && extracted.title) {
          const from = new Date();
          const to = new Date(from.getTime() + 60 * 86400000);
          const evs = await listEvents(config, 'primary', from, to);
          candidates = (evs || [])
            .filter(e => String(e.summary || '').toLowerCase().includes(extracted.title.toLowerCase()))
            .map(e => ({ eventId: e.id, summary: e.summary || '', time: (e.start || '').slice(11, 16) }));
        }
      } catch (err) {
        this.log(`[Telegram] direct-fresh delete lookup failed: ${err.message}`);
        return null;
      }
      if (candidates.length === 0) {
        // No event found → return a verifiable message instead of letting
        // the LLM make one up. The user sees the truth: nothing matched.
        const dateStr = extracted.date ? ` del ${this._formatDateIT(extracted.date)}` : '';
        const titleStr = extracted.title ? ` con titolo "${extracted.title}"` : '';
        return { action: 'calendar_delete', success: false, message: `Non ho trovato nessun appuntamento${titleStr}${dateStr}. Verifica la data o il titolo — non posso cancellare ciò che non esiste.` };
      }

      // Token-match against extracted title; fall back to single-of-the-day.
      const norm = (s) => String(s || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/).filter(t => t.length > 2);
      let match = null;
      if (extracted.title) {
        const titleTokens = norm(extracted.title);
        const scored = candidates.map(c => {
          const summaryTokens = new Set(norm(c.summary));
          const score = titleTokens.filter(t => summaryTokens.has(t)).length;
          return { c, score };
        }).sort((a, b) => b.score - a.score);
        const top = scored[0];
        if (top && top.score >= Math.max(1, Math.ceil(titleTokens.length * 0.5))) {
          if (scored.length === 1 || scored[1].score < top.score) match = top.c;
        }
      }
      if (!match && candidates.length === 1 && extracted.date) match = candidates[0];
      if (!match && extracted.time) {
        const exactTime = candidates.filter(c => (c.time || '').startsWith(extracted.time));
        if (exactTime.length === 1) match = exactTime[0];
      }
      if (!match || !match.eventId) {
        // Ambiguous → list options, don't guess.
        const opts = candidates.slice(0, 5).map((c, i) => `${i + 1}. ${c.time || '—'} ${c.summary}`).join('\n');
        return { action: 'calendar_delete', success: false, message: `Ho trovato più appuntamenti che corrispondono. Quale vuoi cancellare?\n\n${opts}\n\nRispondi con titolo + ora precisa.` };
      }

      try {
        const delResult = await executeTool('calendar_delete', { eventId: match.eventId }, config);
        const ok = typeof delResult === 'string' && !/error|failed|could not|invalid|placeholder|does not exist/i.test(delResult);
        const summary = match.summary || extracted.title || 'l\'appuntamento';
        const dateStr = extracted.date || '';
        const message = ok
          ? `Fatto. Ho cancellato "${summary}"${dateStr ? ` del ${this._formatDateIT(dateStr)}` : ''}${match.time ? ` alle ${match.time}` : ''}.`
          : `Non sono riuscito a cancellare l'evento: ${delResult}`;
        // Audit log — every agent in this chat will see this entry on their
        // next invocation, so no one forgets the deletion happened.
        if (this._lastDirectAuditChatId) {
          this._recordAudit(this._lastDirectAuditChatId, {
            tool: 'calendar_delete',
            success: ok,
            summary: `${summary}${dateStr ? ` del ${this._formatDateIT(dateStr)}` : ''}${match.time ? ` alle ${match.time}` : ''} (eventId ${match.eventId.slice(0, 16)}…)`,
          });
        }
        return { action: 'calendar_delete', success: ok, message };
      } catch (e) {
        return { action: 'calendar_delete', success: false, message: `Errore nella cancellazione: ${e.message}` };
      }
    }

    return null;
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

// ── Shared direct-action dispatcher (Telegram / Discord / Chat WebUI / Voice) ─
// A reusable, instance-less handler. Internally piggybacks on a singleton
// TelegramResponder built with a dummy config — we only use it as a host for
// the `_tryDirectFresh*` methods. The audit log is keyed by the caller's
// own `auditKey` (chatId for Telegram, channelId for Discord, conversationId
// for Chat WebUI), so each platform keeps its own action history without
// crossing wires.
let _sharedDirectHandler = null;
function _getDirectHandler() {
  if (!_sharedDirectHandler) {
    _sharedDirectHandler = new TelegramResponder(
      { responder: { telegram: { token: '__noop__' } } },
      () => {},
      () => {},
    );
    // Ensure the in-memory store exists.
    _sharedDirectHandler._lastContextByChatId = _sharedDirectHandler._lastContextByChatId || {};
  }
  return _sharedDirectHandler;
}

/**
 * Try every direct-action handler in order (fast-path → universal). Returns
 * `{action, success, message}` on hit, `null` if nothing claimed the message.
 *
 * @param {string} text       — the raw user message in any language
 * @param {object} config     — loaded nha config (used by tools + LLM NLU)
 * @param {object} [opts]
 *   @param {string} [opts.auditKey]   — stable key for action audit (chatId, channelId, conversationId…)
 *   @param {(line:string)=>void} [opts.log] — optional logger
 */
export async function tryDirectActionAll(text, config, opts = {}) {
  const h = _getDirectHandler();
  if (opts.auditKey) h._lastDirectAuditChatId = opts.auditKey;
  if (opts.log) h.log = opts.log;

  // ── UNIVERSAL ANAPHORIC DISPATCHER (v16.0.16) ──
  // Intercept anaphoric / yes-confirm commands BEFORE any sub-handler. Resolves
  // the referent from the most recent list (any kind) and executes the right
  // tool deterministically. Stops the LLM from running fake-actions.
  const anaphor = h._detectAnaphoricAction ? h._detectAnaphoricAction(text) : null;
  if (anaphor) {
    const resolved = h._resolveAnaphoric ? h._resolveAnaphoric(null, text) : null;
    if (resolved && resolved.item) {
      try {
        const result = await h._executeAnaphoricVerb(anaphor, resolved.kind, resolved.item, text, config);
        if (result) return result;
      } catch (e) {
        h.log && h.log(`[direct] anaphoric universal dispatcher error: ${e.message}`);
      }
    } else {
      h.log && h.log(`[direct] anaphoric verb=${anaphor} but no item to resolve`);
    }
  }

  return await h._tryDirectFreshCalendarAction(text, config)
      || await h._tryDirectFreshEmailAction(text, config)
      || await h._tryDirectFreshTaskAction(text, config)
      || await h._tryDirectFreshNoteAction(text, config)
      || await h._tryDirectFreshReminderAction(text, config)
      || await h._tryDirectFreshSlackAction(text, config)
      || await h._tryDirectFreshUniversalAction(text, config);
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
      // Try the deterministic direct-action dispatcher BEFORE routing to an
      // LLM agent. Same architecture used by Telegram: LLM only for NLU,
      // tool execution always server-side, audit log per channel.
      const directFresh = await tryDirectActionAll(cleanText, this.config, {
        auditKey: `discord:${channelId}`,
        log: this.log,
      });
      if (directFresh) {
        await this._discordApiCall('POST', `/channels/${channelId}/messages`, {
          content: directFresh.message,
        });
        this.log(`[Discord] direct-action ${directFresh.action} → ${directFresh.success ? 'OK' : 'FAIL'}`);
        return;
      }

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
      // Cross-channel user memory + audit log + auto-learn (v16.0.13)
      let discordMsg = cleanText;
      try {
        const { buildMemoryPrefix, autoLearnFromTurn } = await import('./user-memory.mjs');
        const memPrefix = buildMemoryPrefix();
        if (memPrefix) discordMsg = memPrefix + discordMsg;
        autoLearnFromTurn(cleanText, this.config).catch(() => null);
      } catch {}
      try {
        const auditNote = _readGlobalAudit(15);
        if (auditNote.length > 0) {
          const lines = auditNote.slice(-10).map(e => {
            const t = new Date(e.ts).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
            const st = e.success === false ? '✗' : '✓';
            return `- ${t} · ${e.tool} ${st} · ${e.summary || ''}`;
          }).join('\n');
          discordMsg = `[AZIONI RECENTI da altri canali]\n${lines}\n[FINE]\n\n${discordMsg}`;
        }
      } catch {}
      const response = await callFn(this.config, agent, discordMsg);

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
    return { telegram: false, discord: false, reason: 'no_token' };
  }

  // Liara (provider 'nha') is the default free tier — it does NOT require an
  // API key. Only refuse to start if the user explicitly picked a paid
  // provider (anthropic, openai, gemini, ...) and forgot to set the key.
  // Previously we rejected ALL providers including Liara, leaving the user
  // stuck on "configured (daemon restart needed)" with no actionable hint.
  const provider = (config.llm?.provider || 'nha').toLowerCase();
  const PAID_PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'deepseek', 'grok', 'mistral', 'cohere']);
  if (PAID_PROVIDERS.has(provider) && !config.llm?.apiKey) {
    log(`[Responder] Provider "${provider}" requires an API key — cannot respond. Run: nha config set provider nha   (to switch to free Liara)   OR   nha config set ${provider}-key YOUR_KEY`);
    return { telegram: false, discord: false, reason: `missing_key:${provider}` };
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
