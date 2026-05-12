/**
 * Studio routes — /api/studio/plan, /api/studio/run, /api/studio/deliberate
 * Ported directly from ui.mjs with identical logic, zero monolith dependency.
 */

import fs from 'fs';
import path from 'path';
import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { NHA_DIR, AGENTS_DIR } from '../../constants.mjs';
import { callLLM, callLLMStream, parseAgentFile } from '../../services/llm.mjs';
import { webSearch, fetchUrl, fetchUrlRich, headProbe } from '../../services/web-tools.mjs';

// Agents that get web data pre-fetched (search + URL content) before their LLM call.
// We err on the side of inclusion: any agent that writes analysis, copy, briefings,
// or reports benefits from real-time data — without it they hallucinate plausible
// but generic frameworks. Synthesis-only agents (CanvasAgent, GitHub/Email/Slack
// connectors) are intentionally excluded.
const WEB_TOOL_AGENTS = new Set([
  // Original research/intel set
  'WebSearchAgent', 'TravelAgent',
  'MERCURY', 'mercury',
  'ATHENA',  'athena',
  'ORACLE',  'oracle',
  'CASSANDRA', 'cassandra',
  'HERALD',  'herald',
  'DataAnalystAgent',
  'TEMPEST', 'tempest',
  'EPICURE', 'epicure',
  'CARTOGRAPHER', 'cartographer',
  // Analysis & writing — they MUST ground on the target site, not invent.
  'QUILL', 'quill',
  'ECHO',  'echo',
  'MURASAKI', 'murasaki',
  'SCHEHERAZADE', 'scheherazade',
  'MUSE', 'muse',
  // Security / architecture / reasoning — also benefit from grounded context.
  'FORGE', 'forge',
  'PROMETHEUS', 'prometheus',
  'SABER', 'saber',
  'ADE', 'ade',
  'ZERO', 'zero',
  'SAURON', 'sauron',
  'LOGOS', 'logos',
  'VERITAS', 'veritas',
  'LINK', 'link',
  'NAVI', 'navi',
  'EDI', 'edi',
  // Polyglot needs source content to translate accurately.
  'polyglot',
]);

// ── Complete Agent Registry ─────────────────────────────────────────────────
// Each entry: [emoji, name, short description for the planner]
const AGENT_REGISTRY = [
  ['🔍','WebSearchAgent',   'Web search and real-time data retrieval. Use for any task needing current web information.'],
  ['🍽','TravelAgent',       'Restaurant, hotel, B&B, travel recommendations. Searches web for real venues with reviews and prices.'],
  ['📄','DocumentReaderAgent','Extract data from attached PDFs: specs, tables, model numbers, technical details.'],
  ['📧','EmailAgent',        'Read/analyze inbox emails, identify urgent items and deadlines.'],
  ['📅','CalendarAgent',     'Review calendar events, find scheduling conflicts, plan meetings.'],
  ['💻','GitHubAgent',       'Analyze GitHub repos, issues, PRs, code quality metrics.'],
  ['💬','SlackAgent',        'Read Slack channels/messages, identify important conversations.'],
  ['📝','NotionAgent',       'Search and read Notion pages, databases, wikis.'],
  ['📰','HERALD',            'OSINT intelligence analyst. Synthesizes all collected data into executive briefings with sourced claims and bias flags. Best used as final synthesizer after other agents.'],
  ['🔭','ORACLE',            'Senior data scientist. Statistical inference, pattern recognition, decision science. Transforms raw data into actionable intelligence.'],
  ['♟','ATHENA',             'Technology research analyst. Evaluates frameworks, approaches, techniques with scientific rigor. Strategic technology recommendations.'],
  ['⚠','CASSANDRA',          'Risk analyst and predictive consequence engineer. Systematic risk assessment, threat modeling, scenario planning.'],
  ['💰','MERCURY',            'CFA-level financial market analyst. Equity research, technical analysis, quantitative risk. Real-time market data interpretation.'],
  ['🖊','QUILL',              'Conversion copywriter. Micro-content, headlines, CTAs, landing pages, email campaigns. Direct response copywriting.'],
  ['📊','DataAnalystAgent',   'Data analysis, statistics, pattern extraction, trend identification from datasets.'],
  ['🌐','polyglot',           'Computational linguist and translator. Cross-lingual NLP, localization, contrastive linguistics. Professional translation.'],
  ['🎨','CanvasAgent',        'HTML dashboard/report generator. Creates visual canvas with charts and tables. USE ONLY AS LAST STEP.'],
  // ── Specialist agents (not in old planner) ─────────
  ['🗡','ADE',                'Offensive security specialist (red team). Penetration testing methodology, attack surface analysis, vulnerability exploitation paths.'],
  ['🏗','ATLAS',              'Infrastructure-as-Code engineer. Cloud environments, Terraform, Pulumi, declarative configuration, production infrastructure.'],
  ['🔗','BABEL',              'Integration architect and API design. Unifies disparate systems, REST/GraphQL/gRPC design, webhook orchestration.'],
  ['🗺','CARTOGRAPHER',       'Geospatial analyst. GIS, geodesy, spatial data, location intelligence, map-based analysis.'],
  ['🎼','CONDUCTOR',          'Workflow orchestration architect. Designs complex execution plans, dependency graphs, parallel/sequential coordination.'],
  ['⏰','CRON',               'Automation architect and CI/CD engineer. Scheduled tasks, pipelines, fault-tolerant automation, GitHub Actions, cron jobs.'],
  ['📢','ECHO',               'Content distribution and cross-channel amplification. Transforms content into multi-platform packages (social, blog, video scripts).'],
  ['📐','EDI',                'Statistical modeling engineer. Model selection, validation, interpretation. Regression, time series, Bayesian inference.'],
  ['🍳','EPICURE',            'Culinary scientist and gastronomic analyst. Food chemistry, global cuisine, nutrition science, recipe analysis, restaurant evaluation.'],
  ['🔄','FLUX',               'Data transformation engineer. ETL algebra, format conversion, data reshaping, schema migration.'],
  ['🔧','FORGE',              'Infrastructure architect. Production-grade systems, resilience engineering, system design, code architecture.'],
  ['🐛','GLITCH',             'Data quality engineer. ETL/ELT pipelines, data cleaning, format transformation, messy data remediation.'],
  ['👁','HEIMDALL',           'SRE and observability architect. Monitoring systems, alerting, SLO/SLA design, incident response, dashboards.'],
  ['✉','HERMES',              'Event-driven architecture engineer. Message brokers, async communication, Kafka/RabbitMQ/NATS design.'],
  ['📉','JARVIS',             'Data visualization architect. Dashboard design, chart selection, information display, D3/Plotly/Grafana.'],
  ['🕸','LINK',               'Social graph analyst and community architect. Network analysis, community design, engagement optimization.'],
  ['🧠','LOGOS',              'Formal logic analyst and argument auditor. Evaluates argument structure, consistency, logical validity, fallacy detection.'],
  ['⚙','MACRO',               'Process automation engineer. Pattern recognition, template systems, bulk operations, workflow automation.'],
  ['📜','MURASAKI',           'Long-form content architect. Whitepapers, research papers, essays, book chapters. Academic rigor + narrative craft.'],
  ['🎭','MUSE',               'Visual content director. Art direction, visual communication, design systems, brand aesthetics.'],
  ['🧭','NAVI',               'Data quality profiler. Dataset assessment, upstream validation, schema inspection, quality scoring before analysis.'],
  ['🔌','PIPE',               'Data pipeline architect. Reliable data flows, stream processing, zero-loss record transport.'],
  ['🔥','PROMETHEUS',         'Software evolution architect. System analysis, structural weakness identification, evolutionary improvement design, refactoring strategy.'],
  ['🛡','SABER',              'Security auditor. Application security, infrastructure hardening, SSDLC, compliance, OWASP, pentest reports.'],
  ['👁‍🗨','SAURON',            'Deep diagnostics and root cause analysis. Goes beyond symptoms to find true origins of system failures.'],
  ['📖','SCHEHERAZADE',       'Content strategist and narrative architect. Storytelling, content that captivates, persuades, and converts.'],
  ['🖥','SHELL',               'CLI tool architect. Command-line interface design, shell scripting, terminal UX, CLI frameworks.'],
  ['⚔','SHOGUN',              'Kubernetes platform engineer. Container orchestration, pod strategy, resource placement, cluster management.'],
  ['🌪','TEMPEST',            'Meteorological intelligence analyst. Weather forecasting, atmospheric data interpretation, climate analysis.'],
  ['✅','VERITAS',            'Evidence analyst and fact-checker. Determines if claims are supported by evidence, epistemological rigor.'],
  ['🎯','ZERO',               'Automated vulnerability scanner. Combines Snyk/Semgrep/Trivy/Nuclei precision with contextual understanding.'],
];

const AGENT_NAMES = AGENT_REGISTRY.map(a => a[1]);
const AGENT_CATALOG = AGENT_REGISTRY.map(([icon, name, desc]) => `- ${icon} **${name}**: ${desc}`).join('\n');

/**
 * Run a web search and return formatted results string.
 */
async function runWebSearch(query) {
  try {
    const result = await webSearch(query);
    if (result.error) return `Search failed: ${result.message}`;
    const snippets = result.results
      .slice(0, 6)
      .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet || ''}`)
      .join('\n\n');
    return `Search results for "${query}" (${result.resultCount} found):\n\n${snippets}`;
  } catch (e) {
    return `Search error: ${e.message}`;
  }
}

/**
 * Fetch a URL and return a structured result. Caller decides how to format it.
 * Returns { ok, url, content?, title?, metadata?, code?, reason? }.
 */
async function runFetchUrl(url) {
  try {
    const result = await fetchUrlRich(url, { maxChars: 16_000 });
    if (result.error) {
      return { ok: false, url, code: result.code || 'FETCH_FAILED', reason: result.message || 'unknown' };
    }
    const meta = result.metadata || {};
    const ogBlock = Object.keys(meta.og || {}).length
      ? `OpenGraph: ${Object.entries(meta.og).slice(0, 8).map(([k, v]) => `${k}=${String(v).slice(0, 200)}`).join(' | ')}\n`
      : '';
    const ldBlock = (meta.jsonLd || []).length
      ? `Schema.org types: ${meta.jsonLd.slice(0, 6).map(j => j.type).join(', ')}\n`
      : '';
    const headingsBlock = meta.headings && (meta.headings.h1?.length || meta.headings.h2?.length)
      ? `Headings H1: ${(meta.headings.h1 || []).slice(0, 5).join(' | ')}\n` +
        (meta.headings.h2?.length ? `Headings H2: ${meta.headings.h2.slice(0, 8).join(' | ')}\n` : '')
      : '';
    const descBlock = meta.description ? `Description: ${meta.description}\n` : '';
    return {
      ok: true,
      url: result.url || url,
      title: result.title || '',
      content: result.body || '',
      metadata: meta,
      preamble: `${result.title ? `Title: ${result.title}\n` : ''}${descBlock}${ogBlock}${ldBlock}${headingsBlock}`.trim(),
    };
  } catch (e) {
    return { ok: false, url, code: 'EXCEPTION', reason: e.message || String(e) };
  }
}

/**
 * Extract URLs from free-form text — robust matcher.
 *
 * Catches:
 *   - Fully-qualified URLs: http(s)://example.com/path
 *   - Bare domains with www: www.example.com
 *   - Bare domains without www: example.com, example.it, example.co.uk
 *   - Markdown-wrapped: [label](example.com) — the URL portion is matched
 *
 * Rejects:
 *   - File extensions misread as domains: image.png, doc.pdf, app.js
 *   - Single-word tokens without a dot
 *   - Email addresses (the @ rules out the domain match)
 *
 * Returns normalized https:// URLs, deduplicated, max 6.
 */
const FILE_EXT_BLOCKLIST = new Set([
  'png','jpg','jpeg','gif','webp','svg','ico','bmp','tiff',
  'pdf','doc','docx','xls','xlsx','ppt','pptx','csv','txt','zip','tar','gz','rar','7z',
  'mp3','mp4','wav','ogg','mov','avi','mkv',
  'js','css','json','xml','yaml','yml','md','html','htm',
]);

function extractUrlsFromText(text) {
  if (!text) return [];
  const t = String(text);
  const found = new Set();

  // Full URLs
  for (const m of t.matchAll(/https?:\/\/[^\s,)<>"'`]+/gi)) {
    const clean = m[0].replace(/[.,;:!?)\]]+$/, '');
    found.add(clean);
  }

  // Bare domains — TLD of 2..24 letters. Accepts 2-label (apple.com),
  // 3-label (www.apple.com), and N-label domains.
  const bareRe = /(?<![\/@\w])(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.([a-z]{2,24})\b(?:\/[^\s,()<>"'`]*)?/gi;
  for (const m of t.matchAll(bareRe)) {
    const candidate = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (candidate.startsWith('http')) continue;
    const tld = (m[1] || '').toLowerCase();
    if (FILE_EXT_BLOCKLIST.has(tld)) continue;
    if (/^\d+(\.\d+)+$/.test(candidate)) continue;
    found.add('https://' + candidate);
  }

  // Dedup: if "https://x.com/path" and "https://www.x.com/path" both present,
  // keep the longer (more specific) one only.
  const list = [...found];
  const filtered = list.filter(url => {
    const stripped = url.replace(/^https?:\/\/(www\.)?/, '');
    return !list.some(other =>
      other !== url &&
      other.replace(/^https?:\/\/(www\.)?/, '') === stripped &&
      other.length > url.length,
    );
  });

  return filtered.slice(0, 6);
}

/**
 * Automatic fallback: when the primary fetch fails, try to gather indirect
 * intelligence about the domain via web search. Looks for:
 *   - site:domain.com listings (whatever Google has indexed)
 *   - "<domain> chi è" / "<domain> azienda settore" — public profiles, news
 *   - Wikipedia / corporate registries
 *
 * Returns up to 3 fetched pages with real content, formatted for ground truth.
 * Returns null if nothing useful was found.
 */
async function gatherIndirectIntel(failedUrl, sse) {
  try {
    const parsed = new URL(failedUrl);
    const domain = parsed.hostname.replace(/^www\./, '');
    const queries = [
      `site:${domain}`,
      `"${domain}" azienda settore prodotti`,
      `${domain} chi è cosa fa`,
    ];

    if (sse) sse({ token: `[Fallback: ricerco info indirette su ${domain}...]` });

    const allResults = [];
    for (const q of queries) {
      try {
        const r = await webSearch(q, 5);
        if (!r.error && Array.isArray(r.results)) {
          for (const item of r.results) {
            // Skip if the URL is the same failed domain (we already know it's down)
            try {
              const u = new URL(item.url);
              if (u.hostname.replace(/^www\./, '') === domain) continue;
            } catch { /* skip invalid URLs */ }
            allResults.push({ ...item, fromQuery: q });
          }
        }
      } catch { /* skip failed query */ }
    }

    if (allResults.length === 0) return null;

    // Dedupe by URL, take top 4, fetch them
    const seen = new Set();
    const unique = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 4);

    if (sse) sse({ token: `[Fallback: ${unique.length} fonti indirette trovate, recupero contenuto...]` });

    const fetched = await Promise.all(
      unique.map(async (r) => {
        try {
          const full = await fetchUrlRich(r.url, { maxChars: 4_000, timeout: 8_000 });
          if (full.error) return null;
          return {
            url: r.url,
            title: full.title || r.title || '',
            snippet: r.snippet || '',
            content: (full.body || '').slice(0, 3_000),
            description: full.metadata?.description || '',
            fromQuery: r.fromQuery,
          };
        } catch { return null; }
      })
    );

    const good = fetched.filter(Boolean);
    if (good.length === 0) return null;

    return good;
  } catch {
    return null;
  }
}

/**
 * Strip transient status markers, internal think/tool blocks, and propagation
 * noise before the text is injected into another agent's prompt or surfaced
 * to the client. Parity with LegionX `CommunicationStream.stripTags`.
 */
function sanitizeAgentOutput(text) {
  if (!text) return '';
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<tool[^>]*>[\s\S]*?<\/tool>/gi, '')
    .replace(/<scratch[^>]*>[\s\S]*?<\/scratch>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/\[(?:Searching|Fetching|GET|POST|HEAD|Raccolta dati web|Parlamento)[^\]]*\]\s*/gi, '')
    .replace(/​|﻿/g, '') // zero-width / BOM
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Extract search queries from a task string.
 * Returns up to 3 queries covering different angles.
 */
function extractSearchQueries(task, stepPrompt) {
  const text = (stepPrompt || task).slice(0, 500);
  const primary = text.replace(/[^\w\s.,&/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const queries = [primary];

  if (/gold|silver|oil|stock|bitcoin|crypto|eur|usd|etf|nasdaq|sp500|dow|tesla|apple|nvidia/i.test(text)) {
    const ticker = text.match(/\b([A-Z]{2,5}|gold|silver|oil|bitcoin|ethereum)\b/i)?.[1] || '';
    if (ticker) {
      queries.push(`${ticker} price today 2026`);
      queries.push(`${ticker} analyst forecast outlook 2026`);
    }
  }

  return [...new Set(queries)].slice(0, 3);
}

export function register(router) {
  // ── /api/studio/plan — Intelligent workflow planner ─────────────────
  router.post('/api/studio/plan', async (req, res) => {
    const body = await parseBody(req);
    const task = (body.task || '').trim();
    if (!task) return sendError(res, 400, 'task required');
    const config = loadConfig();

    const LANG_MAP = {en:'English',it:'Italian',es:'Spanish',fr:'French',de:'German',pt:'Portuguese',zh:'Chinese',ja:'Japanese',ar:'Arabic',hi:'Hindi',ru:'Russian',nl:'Dutch',pl:'Polish',tr:'Turkish',ko:'Korean'};
    const plannerLang = LANG_MAP[(config?.language||'it').slice(0,2)] || 'Italian';
    const sanitizedTask = task.replace(/<[^>]*>/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();

    const hasPdf = !!(body.hasPdf) || /pdf|allegat|catalogo|scheda\s*tecnic/i.test(task);
    const pdfName = body.pdfName || 'documento allegato';

    const planConfig = Object.assign({}, config, { thinking: 'off' });

    try {
      let steps = [];

      const plannerSystem = `You are CONDUCTOR, the master workflow orchestrator for NHA Studio.
Your job: analyze the user's task and select the OPTIMAL sequence of specialist agents to accomplish it.

## COMPLETE AGENT CATALOG (${AGENT_REGISTRY.length} agents available):

${AGENT_CATALOG}

## ORCHESTRATION RULES:

1. **Select 2-7 agents** depending on task complexity. Simple tasks = 2-3 agents. Complex analysis = 4-7.
2. **Order matters**: agents execute sequentially. Each agent receives the output of ALL previous agents as context.
3. **WebSearchAgent or TravelAgent FIRST** when real-time data is needed (prices, news, reviews, weather, venues).
4. **DocumentReaderAgent FIRST** when a PDF is attached — extract data before anything else.
5. **HERALD as synthesizer** — place near the end to produce an executive briefing from all collected data.
6. **CanvasAgent ALWAYS LAST** (and only if visual output is requested or >=3 specialists are used).
7. **Match agent expertise to task domain**:
   - Finance/markets/crypto → MERCURY (+ WebSearchAgent for live data)
   - Security/audit/vulns → SABER, ADE, ZERO, CASSANDRA (pick the right ones)
   - Code/architecture → FORGE, PROMETHEUS, SAURON
   - Data/statistics → ORACLE, EDI, NAVI (NAVI for quality check first), DataAnalystAgent
   - Writing/content → QUILL (short copy), MURASAKI (long-form), SCHEHERAZADE (narrative), ECHO (multi-platform)
   - Translation → polyglot
   - Infrastructure/cloud → ATLAS, SHOGUN, HEIMDALL, CRON
   - API/integrations → BABEL, HERMES, PIPE
   - Visual/design → MUSE, JARVIS
   - Logic/verification → LOGOS, VERITAS
   - Food/restaurants → EPICURE (+ TravelAgent for search)
   - Weather → TEMPEST
   - Geospatial → CARTOGRAPHER
   - Social/community → LINK
   - Automation → MACRO, CRON
   - Strategy/competitive → ATHENA
   - Risk analysis → CASSANDRA
8. **Write detailed prompts**: each agent's \`prompt\` field should be a specific instruction telling the agent EXACTLY what to analyze, produce, or investigate. Not just the task repeated — a targeted instruction leveraging that agent's specialty.
9. **Labels in ${plannerLang}**.
10. **Never use agents that don't match the task**. A cooking task doesn't need SABER. A security audit doesn't need EPICURE.
${hasPdf ? `\n11. **PDF ATTACHED**: "${pdfName}" — DocumentReaderAgent MUST be step 1.` : ''}

## OUTPUT FORMAT (STRICT — output ONLY this JSON, nothing else):

{"steps":[{"icon":"EMOJI","agent":"AGENT_NAME","label":"LABEL_IN_${plannerLang.toUpperCase()}","reason":"WHY_THIS_AGENT","prompt":"DETAILED_INSTRUCTION_FOR_THE_AGENT"}]}`;

      const plannerUser = `TASK: ${sanitizedTask}

Select the optimal agent pipeline. Output ONLY the JSON.`;

      if (config && (config.llm?.provider || config.llm?.apiKey)) {
        try {
          const planRaw = await callLLM(planConfig, plannerSystem, plannerUser, { max_tokens: 2000 });
          let clean = planRaw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^```[\w]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
          const jm = clean.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(jm ? jm[0] : clean);
          if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
            steps = parsed.steps
              .filter(s => AGENT_NAMES.includes(s.agent))
              .map(s => {
                const reg = AGENT_REGISTRY.find(r => r[1] === s.agent);
                return { icon: s.icon || (reg ? reg[0] : '🤖'), agent: s.agent, label: s.label, reason: s.reason || '', prompt: s.prompt };
              });
          }
        } catch { /* LLM failed, fall through to keyword fallback */ }
      }

      // Keyword fallback if LLM planner failed or no LLM configured
      if (!steps.length) {
        steps = buildKeywordFallback(task, sanitizedTask, hasPdf, pdfName, plannerLang === 'Italian');
      }

      if (!steps.length) {
        const it = plannerLang === 'Italian';
        steps = [{ icon: '🔍', agent: 'WebSearchAgent', label: it ? 'Ricerca web' : 'Web search', reason: 'Fallback', prompt: sanitizedTask }];
      }

      sendJSON(res, 200, { steps });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── /api/studio/run — SSE streaming agent execution ──────────────────
  router.post('/api/studio/run', async (req, res) => {
    const body = await parseBody(req, 4_194_304);
    const config = loadConfig();
    const { agent, task, context, stepDef } = body;
    if (!agent || !task) return sendError(res, 400, 'agent and task required');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const sse = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
    const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 5000);

    try {
      const LANG_MAP = {en:'English',it:'Italian',es:'Spanish',fr:'French',de:'German',pt:'Portuguese',zh:'Chinese',ja:'Japanese',ar:'Arabic',hi:'Hindi',ru:'Russian',nl:'Dutch',pl:'Polish',tr:'Turkish',ko:'Korean'};
      const language = LANG_MAP[(config?.language||'it').slice(0,2)] || 'Italian';
      const today = new Date().toISOString().slice(0,10);

      // Load agent definition if available
      let agentSysDef = null;
      const agentFile = path.join(AGENTS_DIR, `${agent.toLowerCase()}.mjs`);
      if (fs.existsSync(agentFile)) {
        try {
          const src = fs.readFileSync(agentFile, 'utf-8');
          const parsed = parseAgentFile(src, agent);
          if (parsed.systemPrompt) agentSysDef = parsed.systemPrompt;
        } catch {}
      }

      const contextBlock = context ? `\n\n## CONTEXT FROM PREVIOUS STEPS:\n${sanitizeAgentOutput(context).slice(0, 12000)}` : '';

      // Cross-reading block — when other agents have already produced proposals,
      // we inject them with explicit deliberation instructions so the model
      // engages with them (agree/disagree) rather than restating its own view.
      const proposalContextBlock = body.proposalContext ? `

## ALTRE PROPOSTE GIÀ COMPLETATE (CROSS-READING)

I seguenti output sono proposte di altri agenti che hanno lavorato sullo stesso task. Leggile attentamente prima di rispondere.

${sanitizeAgentOutput(body.proposalContext).slice(0, 12000)}

### ISTRUZIONI DI DELIBERAZIONE (obbligatorie)
1. **Identifica i punti in cui CONCORDI** con un agente precedente → marca con \`[✓ CONCORDA CON: NomeAgente]\` e cita il punto specifico.
2. **Identifica i punti in cui DISSENTI** → marca con \`[✗ DISACCORDO CON: NomeAgente]\` e spiega il motivo con evidenze concrete (dai dati fetched, non opinioni).
3. **NON ripetere ciò che hanno già detto bene** — aggiungi il TUO contributo specifico dalla TUA specializzazione.
4. **Se i dati raccolti contraddicono un agente precedente**, segnalalo esplicitamente.` : '';

      const formatInstructions = `\n\nFORMATTING RULES (CRITICAL — your output will be rendered as HTML):
- Use MARKDOWN TABLES with | pipes | for ALL tabular data. Example:
  | Header 1 | Header 2 | Header 3 |
  |----------|----------|----------|
  | data     | data     | data     |
- NEVER use ASCII art boxes or box-drawing characters. They render as ugly monospace blocks.
- Use **bold**, *italic*, headers (## ##), bullet points, numbered lists, blockquotes (>).
- For emphasis boxes, use blockquotes: > **Key insight:** text here
- Write COMPLETE, EXHAUSTIVE content under every heading — never leave a section empty or superficial.
- Provide DEEP ANALYSIS with specific data points, numbers, percentages, and concrete examples.
- Minimum 800 words of substantive content. Be thorough, not brief.`;

      const sysParts = [
        agentSysDef || `You are ${agent}, a specialist AI agent in NHA Studio. Respond entirely in ${language}. Today is ${today}.`,
        `\n\n## WORKFLOW GOAL: ${task}`,
        contextBlock,
        proposalContextBlock,
        stepDef?.prompt ? `\n\n## YOUR SPECIFIC TASK:\n${stepDef.prompt}` : '',
        formatInstructions,
      ];
      const systemPrompt = sysParts.join('');
      const userMessage = stepDef?.prompt || task;

      const useWebTools = WEB_TOOL_AGENTS.has(agent);
      const isPrimaryResearch = !!body.isPrimaryResearch || !!stepDef?.isPrimaryResearch;
      let webDataBlock = '';
      const fetchOutcomes = { ok: 0, failed: 0, attempted: 0, failures: [] };

      // ── Pre-fetch URLs declared in the task ─────────────────────────
      const taskUrls = extractUrlsFromText(task);
      if (taskUrls.length > 0) {
        sse({ token: `[Fetching ${taskUrls.length} URL(s) from task...]` });
        const urlFetches = await Promise.all(
          taskUrls.slice(0, 4).map(async (url) => {
            sse({ token: `[GET ${url}]` });
            const r = await runFetchUrl(url);
            fetchOutcomes.attempted++;
            if (r.ok) fetchOutcomes.ok++;
            else { fetchOutcomes.failed++; fetchOutcomes.failures.push({ url: r.url, code: r.code, reason: r.reason }); }
            return r;
          })
        );

        const okFetches = urlFetches.filter(f => f.ok);
        const failedFetches = urlFetches.filter(f => !f.ok);

        if (okFetches.length > 0) {
          const okBlock = okFetches.map(f => {
            const preamble = f.preamble ? `${f.preamble}\n\n` : '';
            const content = (f.content || '').slice(0, 12_000);
            return `### Content from ${f.url}\n${preamble}${content}`;
          }).join('\n\n---\n\n');
          webDataBlock = `

## ✅ DATI REALI RACCOLTI DAL SITO (GROUND TRUTH — usa SOLO questi)

Quanto segue è il contenuto effettivamente estratto dai siti specificati nel task.
È OBBLIGATORIO basare l'analisi su questi dati e SOLO su questi. È VIETATO:
- Inventare il settore, i prodotti, il target o il modello di business.
- Aggiungere "esempi tipici del settore" o "best practice generiche" senza riferirsi ai dati sopra.
- Scrivere "da verificare" o "supponiamo che" quando il dato è già presente nel blocco.

${okBlock}`;
        }

        // ── Automatic indirect-intel fallback ──
        // Search the web for info ABOUT each failed domain (registries, news,
        // Wikipedia, profiles). This gives the agent grounded data even when
        // the primary site is down, instead of forcing it to invent a framework.
        let recoveredAny = false;
        if (failedFetches.length > 0) {
          const failBlock = failedFetches.map(f => `- ${f.url}  →  ${f.code}: ${f.reason}`).join('\n');
          webDataBlock += `\n\n## ⚠ FONTI PRIMARIE NON DISPONIBILI\n${failBlock}`;
          sse({ data_unavailable: failedFetches.map(f => ({ url: f.url, code: f.code, reason: f.reason })) });

          const indirectBlocks = [];
          for (const f of failedFetches.slice(0, 3)) {
            const intel = await gatherIndirectIntel(f.url, sse);
            if (intel && intel.length > 0) {
              recoveredAny = true;
              const block = intel.map(i =>
                `### ${i.title || '(senza titolo)'}\nURL: ${i.url}\nQuery: "${i.fromQuery}"\n${i.description ? `Descrizione: ${i.description}\n` : ''}\n${i.content}`,
              ).join('\n\n---\n\n');
              indirectBlocks.push(`#### Info indirette su ${f.url}:\n\n${block}`);
            }
          }

          if (indirectBlocks.length > 0) {
            webDataBlock += `\n\n## 🔎 FONTI INDIRETTE (raccolte automaticamente perché le fonti primarie sono down)\n\nIl sito principale non è raggiungibile, ma queste fonti pubbliche parlano dello stesso dominio/azienda. **Usa queste informazioni come ground truth** — sono dati reali, non inventati.\n\n${indirectBlocks.join('\n\n---\n\n')}`;
            sse({ token: '[Fallback: recupero indiretto riuscito, procedo con i dati alternativi.]' });
          } else {
            webDataBlock += `\n\nNessuna fonte indiretta utile trovata sul web per i domini sopra. Per le sezioni che riguardano questi URL, scrivi esplicitamente "Fonte non raggiungibile — analisi non eseguibile". NON sostituire con framework generici, esempi tipici, o supposizioni basate sul nome del dominio.`;
          }
        }

        // Fail-fast: only abort if primary research has NO data AT ALL —
        // neither primary fetches nor indirect intel recovered anything.
        if (isPrimaryResearch && okFetches.length === 0 && !recoveredAny && taskUrls.length > 0) {
          clearInterval(keepalive);
          sse({
            aborted: true,
            reason: 'PRIMARY_RESEARCH_FAILED',
            message: 'Tutti gli URL del task sono irraggiungibili. Pipeline interrotta per evitare contenuto inventato.',
            failures: fetchOutcomes.failures,
          });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        sse({ token: '\n' });
      }

      // ── Web-search agents: search-driven data collection ────────────
      if (useWebTools) {
        sse({ token: '[Raccolta dati web...]' });

        const queries = extractSearchQueries(task, stepDef?.prompt);
        const searchResults = await Promise.all(
          queries.map(async (q) => {
            sse({ token: `[Searching: "${q}"]` });
            return { query: q, result: await runWebSearch(q) };
          })
        );

        // From first search, extract up to 3 URLs and fetch their content
        const firstResult = searchResults[0]?.result || '';
        const urlMatches = [...firstResult.matchAll(/URL: (https?:\/\/[^\s\n]+)/g)]
          .map((m) => m[1])
          .slice(0, 3);

        const fetchResults = await Promise.all(
          urlMatches.map(async (url) => {
            sse({ token: `[Fetching: ${url}]` });
            const r = await runFetchUrl(url);
            fetchOutcomes.attempted++;
            if (r.ok) fetchOutcomes.ok++;
            else fetchOutcomes.failed++;
            return r;
          })
        );

        const searchBlock = searchResults
          .map((s) => `### Search: "${s.query}"\n${s.result}`)
          .join('\n\n---\n\n');

        const fetchBlock = fetchResults
          .filter(f => f.ok)
          .map(f => `### Full content: ${f.url}\n${f.preamble ? f.preamble + '\n\n' : ''}${(f.content || '').slice(0, 8_000)}`)
          .join('\n\n---\n\n');

        const failedFetches = fetchResults.filter(f => !f.ok);
        const failBlock = failedFetches.length > 0
          ? `\n\n## URL non raggiungibili durante la ricerca:\n${failedFetches.map(f => `- ${f.url}  →  ${f.code}`).join('\n')}`
          : '';

        const collected = `${searchBlock}${fetchBlock ? '\n\n---\n\n' + fetchBlock : ''}${failBlock}`;
        webDataBlock = (webDataBlock || '') +
          `\n\n## REAL-TIME WEB DATA (use ONLY this data — do NOT invent prices, figures, brands, sectors):\n\n${collected}`;

        sse({ token: '\n' });
      }

      const finalSystemPrompt = webDataBlock
        ? systemPrompt + webDataBlock
        : systemPrompt;

      let output = '';
      let tokensOut = 0;

      await callLLMStream(config, finalSystemPrompt, userMessage, (tok) => {
        output += tok;
        tokensOut += Math.ceil(tok.length / 4);
        sse({ token: tok });
      }, { max_tokens: 16384 });

      clearInterval(keepalive);
      // Strip internal think/tool blocks before emitting the final output —
      // the streamed tokens may contain them. Quality is computed on the clean
      // text so think-blocks don't inflate output_length artificially.
      const cleanOutput = sanitizeAgentOutput(output);
      const dataQuality = computeDataQuality({
        fetchOutcomes,
        output: cleanOutput,
        taskUrls,
        useWebTools,
      });
      sse({ done: true, output: cleanOutput, tokensOut, dataQuality, fetchOutcomes });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      clearInterval(keepalive);
      sse({ error: e.message });
      res.end();
    }
  });

  // ── /api/studio/smoke-test — Pre-run reachability check ──────────────
  router.post('/api/studio/smoke-test', async (req, res) => {
    try {
      const body = await parseBody(req);
      let urls = Array.isArray(body.urls) ? body.urls : [];
      if (!urls.length && typeof body.task === 'string') urls = extractUrlsFromText(body.task);
      if (!urls.length) return sendJSON(res, 200, { probes: [], allOk: true });

      const probes = await Promise.all(
        urls.slice(0, 8).map(async (url) => {
          try {
            const r = await headProbe(url);
            return { url, ok: r.ok, status: r.status, reason: r.reason || '', finalUrl: r.finalUrl };
          } catch (e) {
            return { url, ok: false, status: 0, reason: e.message || String(e) };
          }
        })
      );

      const allOk = probes.every(p => p.ok);
      sendJSON(res, 200, { probes, allOk });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── /api/studio/deliberate — Parliament Geth Consensus ───────────────
  router.post('/api/studio/deliberate', async (req, res) => {
    const body = await parseBody(req);
    const { task, proposals, language: bodyLang } = body;
    if (!task || !Array.isArray(proposals) || proposals.length < 2) {
      return sendError(res, 400, 'task and at least 2 proposals required');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const sse = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
    const tok = (t) => sse({ token: t });
    const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 5000);
    const config = loadConfig();
    const language = bodyLang || 'Italian';
    const today = new Date().toISOString().slice(0,10);

    const jaccard = (a, b) => {
      const terms = (s) => new Set(s.toLowerCase().match(/\b\w{4,}\b/g) || []);
      const sa = terms(a), sb = terms(b);
      let inter = 0;
      for (const w of sa) if (sb.has(w)) inter++;
      const union = sa.size + sb.size - inter;
      return union > 0 ? inter / union : 1;
    };
    const measureConvergence = (outputs) => {
      if (outputs.length < 2) return 1.0;
      let total = 0, pairs = 0;
      for (let i = 0; i < outputs.length; i++)
        for (let j = i+1; j < outputs.length; j++) { total += jaccard(outputs[i], outputs[j]); pairs++; }
      return pairs > 0 ? total / pairs : 1.0;
    };

    try {
      const eligible = proposals.filter(p => !['CanvasAgent','GitHubAgent','EmailAgent','CalendarAgent'].includes(p.agent));
      if (eligible.length < 2) {
        sse({ deliberation_done: true, skipped: true, reason: 'not enough specialist agents' });
        sse({ done: true }); res.write('data: [DONE]\n\n'); res.end(); clearInterval(keepalive); return;
      }

      const r1Conv = measureConvergence(eligible.map(p => p.output));
      tok(`[Parlamento — Round 1 convergenza: ${(r1Conv*100).toFixed(0)}%] `);

      const crossCtx = (excludeAgent) => eligible
        .filter(p => p.agent !== excludeAgent)
        .map(p => `## ${p.label || p.agent} (Round 1):\n${p.output.slice(0,6000)}`)
        .join('\n\n---\n\n');

      tok('[Parlamento — Round 2: Cross-Reading & Refinamento] ');
      const r2Results = [];
      // Per-agent timeout — if any single agent stalls (network, LLM hung)
      // the loop must not block the whole deliberation. After this budget,
      // fall back to the agent's Round 1 output and continue.
      const PER_AGENT_TIMEOUT_MS = 90_000;
      for (const proposal of eligible) {
        tok(`[Round 2: ${proposal.label || proposal.agent}] `);
        const r2Sys = `You are ${proposal.agent}, a specialist AI agent in NHA Studio Parliament. Today is ${today}. Respond entirely in ${language}.\n\n## WORKFLOW GOAL: ${task}\n\n## YOUR ROUND 1 RESPONSE:\n${proposal.output.slice(0,3000)}\n\n## OTHER AGENTS' ROUND 1 PROPOSALS:\n${crossCtx(proposal.agent)}\n\nDELIBERATION ROUND 2 — REFINEMENT:\n1. Review the other agents' proposals carefully\n2. Incorporate valid points where you AGREE — mark with [AGREE]\n3. Flag genuine disagreements with [CONTRADICTION] and explain your reasoning with evidence\n4. Produce your COMPLETE REFINED response — thorough and exhaustive\n5. Keep analysis focused on: ${task}\n\nBe THOROUGH. Minimum 600 words of substantive refined analysis.`;
        let r2Out = '';
        let fellBack = false;
        try {
          // Race the LLM stream against a hard timeout.
          await Promise.race([
            callLLMStream(config, r2Sys, 'Produce your refined Round 2 response. Write complete content under every heading — never leave a section title without body text.',
              (t) => { r2Out += t; }, { max_tokens: 16384 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('R2_AGENT_TIMEOUT')), PER_AGENT_TIMEOUT_MS)),
          ]);
        } catch (err) {
          // Fallback: use Round 1 output so the rest of deliberation can proceed.
          fellBack = true;
          r2Out = proposal.output;
          tok(`[Round 2 ${proposal.label || proposal.agent}: timeout — uso Round 1 come fallback] `);
        }
        // If the stream returned but produced no text (LLM hiccup), also fall back.
        if (!r2Out || r2Out.trim().length < 50) {
          fellBack = true;
          r2Out = proposal.output;
        }
        r2Results.push({ agent: proposal.agent, label: proposal.label, icon: proposal.icon, output: r2Out, fellBack });
        sse({ deliberation_r2: { agent: proposal.agent, label: proposal.label, icon: proposal.icon, output: r2Out, fellBack } });
      }

      const r2Conv = measureConvergence(r2Results.map(r => r.output));
      tok(`[Parlamento — Round 2 convergenza: ${(r2Conv*100).toFixed(0)}%] `);
      const converged = r2Conv >= 0.30;

      const allR2Ctx = r2Results.map(r => `## ${r.label || r.agent}:\n${r.output.slice(0,4000)}`).join('\n\n---\n\n');
      const contradictions = [];
      for (const r of r2Results) {
        const matches = r.output.match(/\[CONTRADICTION\][^\n]*/g) || [];
        matches.forEach(m => contradictions.push(`- ${r.label || r.agent}: ${m.replace('[CONTRADICTION]','').trim()}`));
      }
      const contBlock = contradictions.length > 0 ? `\n\n## DIVERGENZE RILEVATE DAL ROUND 2:\n${contradictions.join('\n')}` : '';

      tok(converged ? '[Parlamento — Round 3: Sintesi finale HERALD...] ' : '[Parlamento — Round 3: Mediazione HERALD...] ');

      const medTask = converged
        ? `SYNTHESIS TASK (convergenza ${(r2Conv*100).toFixed(0)}%):\n1. Presenta il CONSENSO raggiunto tra tutti gli agenti\n2. Segnala ogni sfumatura o punto di divergenza residua\n3. Produci un executive summary unificato con azioni concrete per: ${task}\n4. Sezione "Voci dissonanti" se esistono posizioni che meritano attenzione\n5. SENZA ALCUN LIMITE DI LUNGHEZZA — sii esaustivo e completo`
        : `MEDIATION TASK (convergenza ${(r2Conv*100).toFixed(0)}% — divergenza significativa):\n1. Identifica i punti di ACCORDO tra tutti gli agenti\n2. Per ogni disaccordo: valuta quale posizione ha evidenze piu solide, NOMINA l'agente e spiega perche e stata accolta o scartata\n3. Produci una sintesi UNIFICATA esaustiva\n4. Fai scelte editoriali nette con motivazioni\n5. Executive summary con azioni concrete per: ${task}\n6. SENZA ALCUN LIMITE DI LUNGHEZZA — sii esaustivo e completo`;

      const medSys = `You are HERALD, the Parliament Mediator in NHA Studio. Today is ${today}. Respond entirely in ${language}.\n\n## WORKFLOW GOAL: ${task}\n\n## ALL AGENTS' REFINED POSITIONS (Round 2):\n${allR2Ctx}${contBlock}\n\n${medTask}\n\nCRITICAL: NEVER write a heading without immediately writing full content below it. Every section MUST have at least 5-8 concrete bullet points or detailed paragraphs. Be EXHAUSTIVE.`;

      let mediationOutput = '';
      const HERALD_TIMEOUT_MS = 120_000;
      try {
        await Promise.race([
          callLLMStream(config, medSys, 'Produce the Parliament final synthesis. Be thorough and complete.', (t) => { mediationOutput += t; }, { max_tokens: 16384 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('HERALD_TIMEOUT')), HERALD_TIMEOUT_MS)),
        ]);
      } catch (err) {
        // HERALD timed out — emit whatever we got so the client isn't stuck.
        tok(`[HERALD mediation: timeout dopo ${HERALD_TIMEOUT_MS/1000}s — restituisco contenuto parziale] `);
      }
      // If absolutely nothing came back, fall back to a concatenation of the
      // r2 outputs so the user has SOMETHING to read instead of a blank panel.
      if (!mediationOutput || mediationOutput.trim().length < 50) {
        mediationOutput = `# Sintesi automatica (HERALD non disponibile)\n\n` +
          r2Results.map(r => `## ${r.label || r.agent}\n${r.output.slice(0, 2000)}`).join('\n\n---\n\n');
      }
      sse({ deliberation_r3: { output: mediationOutput, converged } });

      clearInterval(keepalive);
      sse({ deliberation_done: true, r1_convergence: r1Conv, r2_convergence: r2Conv, converged, r2_results: r2Results, mediation: mediationOutput || null });
      sse({ done: true });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      clearInterval(keepalive);
      sse({ error: e.message });
      res.end();
    }
  });
}

// ── Data-quality scoring (replaces fake sentiment "confidence") ────────
/**
 * Compute a 0..1 data-quality score from observable signals.
 *
 * Signals (weighted):
 *   - fetch_success_ratio:  fraction of attempted fetches that succeeded   (0.45)
 *   - declared_urls_ok:     primary URLs from the task were reachable      (0.25)
 *   - output_length:        produced a substantive response (>= 600 chars) (0.10)
 *   - no_error_strings:     output free of "fetch failed", "search failed" (0.10)
 *   - structured_evidence:  output cites numbers, dates, or quoted strings (0.10)
 *
 * Returns { score: number, label: 'high'|'medium'|'low', signals: {...} }.
 */
export function computeDataQuality({ fetchOutcomes, output = '', taskUrls = [], useWebTools = false }) {
  const out = String(output || '');
  const signals = {};

  const totalAttempted = fetchOutcomes?.attempted || 0;
  const totalOk        = fetchOutcomes?.ok || 0;
  if (totalAttempted > 0) {
    signals.fetch_success_ratio = totalOk / totalAttempted;
  } else if (useWebTools || taskUrls.length > 0) {
    signals.fetch_success_ratio = 0;
  } else {
    signals.fetch_success_ratio = 1; // No fetches expected → neutral
  }

  const declaredFailures = (fetchOutcomes?.failures || []).filter(f => taskUrls.includes(f.url)).length;
  if (taskUrls.length === 0) {
    signals.declared_urls_ok = 1;
  } else {
    signals.declared_urls_ok = Math.max(0, 1 - declaredFailures / taskUrls.length);
  }

  signals.output_length = Math.min(1, out.length / 1_200);

  const errorMarkers = /fetch failed|search failed|errore 500|errore 404|http_500|http_404|http_429|http_4\d{2}|timeout|network error/gi;
  const errorCount = (out.match(errorMarkers) || []).length;
  signals.no_error_strings = Math.max(0, 1 - errorCount / 5);

  const hasNumbers  = /\b\d{1,4}(?:[.,]\d+)?(?:\s*(%|€|\$|£|¥|kg|cm|mm|km|°c))?/i.test(out);
  const hasDates    = /\b(19|20)\d{2}\b|\b\d{1,2}[\/\-.]\d{1,2}[\/\-.](19|20)?\d{2}\b/.test(out);
  const hasQuotes   = /"[^"]{8,}"|"[^"]{8,}"/.test(out);
  const structScore = (hasNumbers ? 0.5 : 0) + (hasDates ? 0.25 : 0) + (hasQuotes ? 0.25 : 0);
  signals.structured_evidence = Math.min(1, structScore);

  const score =
    0.45 * signals.fetch_success_ratio +
    0.25 * signals.declared_urls_ok +
    0.10 * signals.output_length +
    0.10 * signals.no_error_strings +
    0.10 * signals.structured_evidence;

  let label = 'low';
  if (score >= 0.70) label = 'high';
  else if (score >= 0.50) label = 'medium';

  return { score: Math.round(score * 100) / 100, label, signals };
}

// ── Keyword fallback planner (used when LLM is unavailable) ────────────

function buildKeywordFallback(task, sanitizedTask, hasPdf, pdfName, it) {
  const taskLow = task.toLowerCase();
  const steps = [];

  const hasEmail      = /email|mail|inbox|posta/i.test(taskLow);
  const hasCalendar   = /calendar|agenda|calendari|eventi|schedule/i.test(taskLow);
  const hasUrl        = /https?:\/\/[^\s]+/i.test(taskLow);
  const hasSearch     = hasUrl || /cerca|search|notizie|news|ultime|latest|web|internet|tendenz|trend|acquista|compra|dove\s+trovare|where\s+to\s+buy|similar|simile|esamina|analizza.*sito|analisi.*sito|sito\s+web/i.test(taskLow);
  const hasCanvas     = /html|dashboard|visua|report|grafico|chart/i.test(taskLow);
  const hasGitHub     = /github|git\b|issue\b|pull request|\bPR\b/i.test(taskLow);
  const hasSlack      = /slack/i.test(taskLow);
  const hasNotion     = /\bnotion\b/i.test(taskLow);
  const hasBriefing   = /briefing|analisi|analizza|summary|sommario|riassunto|riepiloga|valutazione|valuta/i.test(taskLow);
  const hasFinance    = /finance|mercato|market|stock|trading|finanz|investiment|cripto|oro|gold|petrolio|oil|commodit|prezzo|correlazion|macro|inflazion|tassi|borse|etf|bitcoin|nasdaq|sp500/i.test(taskLow);
  const hasSecurity   = /security|sicurezza|vulnerabilit|audit|pentest|rischi|dipendenz/i.test(taskLow);
  const hasStrategy   = /strateg|competitiv|posizionament|raccomandaz|competitive|positioning/i.test(taskLow);
  const hasReputation = /reputazion|reputation|online|brand|review|recension/i.test(taskLow);
  const hasCode       = /codice|code|refactor|debug|bug|sviluppo|software|npm|package|architettur/i.test(taskLow);
  const hasWriting    = /scrivi|write|articolo|article|blog|testo|text|documento|document|whitepaper|saggio|essay/i.test(taskLow);
  const hasData       = /dati|data|dataset|csv|json|analizza i dati|pattern|statistich|correlazion|regressione|trend|serie\s+storic/i.test(taskLow);
  const hasTranslate  = /traduci|translate|traduzione|translation/i.test(taskLow);
  const hasTravel     = /ristorante|restaurant|b&b|hotel|albergo|agriturismo|locanda|osteria|prenotaz|vacanz|romantico|sushi|giapponese|cinese|pizza|cena|dinner|pranzo|lunch|soggiorno|weekend|pernottament|posto\s+dove\s+mangiare|posto\s+dove\s+dormire|dove\s+mangiare|dove\s+dormire|posto\s+romantico|gita|escursione/i.test(taskLow);
  const hasWeather    = /meteo|weather|previsioni|temperatura|clima|pioggia|neve|vento/i.test(taskLow);
  const hasFood       = /ricetta|recipe|cucinare|cook|ingredienti|piatto|dish|gastronomia|cucina/i.test(taskLow);
  const hasInfra      = /kubernetes|k8s|docker|terraform|cloud|aws|azure|gcp|infrastruttura|infrastructure|deploy|pipeline|ci[\/-]cd/i.test(taskLow);
  const hasApi        = /\bapi\b|endpoint|webhook|integrazione|integration|rest|graphql|grpc/i.test(taskLow);
  const hasLogic      = /logica|logic|argoment|fallacia|fallacy|ragionamento|reasoning|valid|premessa|premise/i.test(taskLow);
  const hasGeo        = /mappa|map|geolocalizzazione|coordinates|latitudine|longitudine|geospatial|gis/i.test(taskLow);

  if (hasPdf)       steps.push({icon:'📄',agent:'DocumentReaderAgent',label:it?'Leggi documento':'Read document',reason:it?'PDF allegato':'PDF attached',prompt:`Extract all technical specifications, data, tables, and key information from the attached document "${pdfName}".`});
  if (hasTravel)    steps.push({icon:'🍽',agent:'TravelAgent',label:it?'Ricerca luoghi':'Search venues',reason:it?'Task di viaggio/ristorazione':'Travel/dining task',prompt:sanitizedTask});
  if (hasEmail)     steps.push({icon:'📧',agent:'EmailAgent',label:it?'Controlla email':'Check emails',reason:it?'Email rilevata':'Email detected',prompt:'Read the latest unread emails and identify urgent items, deadlines, and required actions'});
  if (hasCalendar)  steps.push({icon:'📅',agent:'CalendarAgent',label:it?'Rivedi calendario':'Review calendar',reason:it?'Calendario rilevato':'Calendar detected',prompt:"Check today's events and identify any scheduling conflicts or important meetings"});
  if (hasGitHub)    steps.push({icon:'💻',agent:'GitHubAgent',label:'GitHub',reason:it?'GitHub rilevato':'GitHub detected',prompt:'Read open issues and pull requests, identify what needs attention'});
  if (hasSlack)     steps.push({icon:'💬',agent:'SlackAgent',label:'Slack',reason:it?'Slack rilevato':'Slack detected',prompt:'Check recent Slack messages and identify important conversations'});
  if (hasNotion)    steps.push({icon:'📝',agent:'NotionAgent',label:'Notion',reason:it?'Notion rilevato':'Notion detected',prompt:'Search Notion for relevant pages and notes'});
  if (hasWeather)   steps.push({icon:'🌪',agent:'TEMPEST',label:it?'Analisi meteo':'Weather analysis',reason:it?'Meteo rilevato':'Weather detected',prompt:sanitizedTask});
  if (hasFood && !hasTravel) steps.push({icon:'🍳',agent:'EPICURE',label:it?'Analisi culinaria':'Culinary analysis',reason:it?'Cucina rilevata':'Cooking detected',prompt:sanitizedTask});
  if (hasGeo)       steps.push({icon:'🗺',agent:'CARTOGRAPHER',label:it?'Analisi geospaziale':'Geospatial analysis',reason:it?'Geolocalizzazione rilevata':'Geo detected',prompt:sanitizedTask});
  if (!hasTravel && (hasPdf || hasSearch || hasReputation || (!hasEmail && !hasCalendar && !hasGitHub && !hasSlack && !hasWeather && !hasFood))) {
    steps.push({icon:'🔍',agent:'WebSearchAgent',label:it?'Ricerca web':'Web search',reason:it?'Fonte dati web':'Web data source',prompt:sanitizedTask});
  }
  if (hasSecurity)  steps.push({icon:'🛡',agent:'SABER',label:it?'SABER — Audit sicurezza':'SABER — Security audit',reason:it?'Sicurezza rilevata':'Security detected',prompt:sanitizedTask});
  if (hasFinance)   steps.push({icon:'💰',agent:'MERCURY',label:it?'MERCURY — Mercato':'MERCURY — Market',reason:it?'Finanza rilevata':'Finance detected',prompt:sanitizedTask});
  if (hasStrategy)  steps.push({icon:'♟',agent:'ATHENA',label:it?'ATHENA — Strategia':'ATHENA — Strategy',reason:it?'Strategia rilevata':'Strategy detected',prompt:sanitizedTask});
  if (hasReputation)steps.push({icon:'🔭',agent:'ORACLE',label:it?'ORACLE — Reputazione':'ORACLE — Reputation',reason:it?'Reputazione rilevata':'Reputation detected',prompt:sanitizedTask});
  if (hasCode)      steps.push({icon:'🔧',agent:'FORGE',label:it?'FORGE — Architettura':'FORGE — Architecture',reason:it?'Codice rilevato':'Code detected',prompt:sanitizedTask});
  if (hasWriting)   steps.push({icon:'📜',agent:'MURASAKI',label:it?'MURASAKI — Redazione':'MURASAKI — Writing',reason:it?'Scrittura rilevata':'Writing detected',prompt:sanitizedTask});
  if (hasData)      steps.push({icon:'📊',agent:'DataAnalystAgent',label:it?'Analisi dati':'Data analysis',reason:it?'Dati rilevati':'Data detected',prompt:sanitizedTask});
  if (hasTranslate) steps.push({icon:'🌐',agent:'polyglot',label:it?'POLYGLOT — Traduzione':'POLYGLOT — Translation',reason:it?'Traduzione rilevata':'Translation detected',prompt:sanitizedTask});
  if (hasInfra)     steps.push({icon:'🏗',agent:'ATLAS',label:it?'ATLAS — Infrastruttura':'ATLAS — Infrastructure',reason:it?'Infrastruttura rilevata':'Infrastructure detected',prompt:sanitizedTask});
  if (hasApi)       steps.push({icon:'🔗',agent:'BABEL',label:it?'BABEL — Integrazione API':'BABEL — API Integration',reason:it?'API rilevata':'API detected',prompt:sanitizedTask});
  if (hasLogic)     steps.push({icon:'🧠',agent:'LOGOS',label:it?'LOGOS — Analisi logica':'LOGOS — Logic analysis',reason:it?'Logica rilevata':'Logic detected',prompt:sanitizedTask});

  const hasSpecialist = hasSecurity || hasFinance || hasStrategy || hasReputation || hasCode || hasWriting || hasData || hasTranslate || hasInfra || hasApi || hasLogic;
  if (!hasSpecialist && (hasBriefing || steps.length > 0)) {
    steps.push({icon:'📰',agent:'HERALD',label:it?'HERALD — Briefing':'HERALD — Briefing',reason:it?'Sintesi finale':'Final synthesis',prompt:'Based on ALL the data collected by the previous steps, write a complete executive briefing with priorities, findings, and strategic recommendations. Do NOT invent data — only use what was provided.'});
  }
  const specialistCount = [hasSecurity,hasFinance,hasStrategy,hasReputation,hasCode,hasWriting,hasData,hasInfra,hasApi].filter(Boolean).length;
  if (hasCanvas || specialistCount >= 2 || (hasSpecialist && hasBriefing)) {
    steps.push({icon:'📊',agent:'CanvasAgent',label:it?'Dashboard HTML':'HTML Dashboard',reason:it?'Report visuale':'Visual report',prompt:'Create a professional HTML dashboard report summarizing all findings from the previous agents'});
  }
  return steps;
}
