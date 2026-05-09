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

export function register(router) {
  router.post('/api/studio/plan', async (req, res) => {
    const body = await parseBody(req);
    const task = (body.task || '').trim();
    if (!task) return sendError(res, 400, 'task required');
    const config = loadConfig();

    const LANG_MAP = {en:'English',it:'Italian',es:'Spanish',fr:'French',de:'German',pt:'Portuguese',zh:'Chinese',ja:'Japanese',ar:'Arabic',hi:'Hindi',ru:'Russian',nl:'Dutch',pl:'Polish',tr:'Turkish',ko:'Korean'};
    const plannerLang = LANG_MAP[(config?.language||'it').slice(0,2)] || 'Italian';
    const it = plannerLang === 'Italian';
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

    const extractSearchQuery = (t) => {
      const m = t.match(/(?:cerca|search|find|ricerca|notizie su|news about|latest on|aggiornamenti su|ultime su|tendenz|trend)\s+(.{5,80}?)(?:\s+(?:e |and |per |for |poi |then )|[,\n]|$)/i);
      if (m) return m[1].trim();
      const domainMatch = t.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)/i);
      if (domainMatch) return domainMatch[0].replace(/^https?:\/\//,'');
      return t.replace(/^[^:]+:\s*/,'').split(/[,\n]/)[0].slice(0,100).trim() || t.slice(0,80).trim();
    };
    const searchQuery = extractSearchQuery(task);

    const buildKeywordPlan = () => {
      const steps = [];
      if (hasPdf) {
        const pdfName = body.pdfName || 'documento allegato';
        steps.push({icon:'📄',agent:'DocumentReaderAgent',label:it?'Leggi documento':'Read document',reason:it?'Allegato PDF rilevato — estraggo dati tecnici prima di ogni altra operazione':'PDF attachment detected — extracting technical data first',prompt:`Extract all technical specifications, model numbers, part codes, product names, manufacturer, dimensions, ratings, and any other key data from the attached document "${pdfName}". List every technical detail precisely.`});
      }
      if (hasTravel)   steps.push({icon:'🍽',agent:'TravelAgent',  label:it?'Ricerca ristoranti & hotel':'Search restaurants & hotels', reason:it?'Task di viaggio/prenotazione':'Travel/booking task', prompt:task});
      if (hasEmail)    steps.push({icon:'📧',agent:'EmailAgent',   label:it?'Controlla email':'Check emails',    reason:it?'Parola chiave email rilevata':'Email keyword detected', prompt:'Read the latest unread emails and identify urgent items, deadlines, and required actions'});
      if (hasCalendar) steps.push({icon:'📅',agent:'CalendarAgent',label:it?'Rivedi calendario':'Review calendar',reason:it?'Parola chiave calendario rilevata':'Calendar keyword detected', prompt:"Check today's events and identify any scheduling conflicts or important meetings"});
      if (hasGitHub)   steps.push({icon:'💻',agent:'GitHubAgent',  label:'GitHub',                               reason:it?'Parola chiave GitHub rilevata':'GitHub keyword detected', prompt:'Read open issues and pull requests, identify what needs attention'});
      if (hasSlack)    steps.push({icon:'💬',agent:'SlackAgent',   label:'Slack',                                reason:it?'Parola chiave Slack rilevata':'Slack keyword detected', prompt:'Check recent Slack messages and identify important conversations'});
      if (hasNotion)   steps.push({icon:'📝',agent:'NotionAgent',  label:'Notion',                               reason:it?'Parola chiave Notion rilevata':'Notion keyword detected', prompt:'Search Notion for relevant pages and notes'});
      if (!hasTravel && (hasPdf || hasSearch || hasReputation || (!hasEmail && !hasCalendar && !hasGitHub && !hasSlack))) {
        const sp = hasPdf ? (it?'Usa le specifiche tecniche estratte dal documento per cercare online dove acquistare il prodotto o articoli equivalenti.':'Use the technical specifications extracted from the document to search online for where to buy this product or equivalent alternatives.') : searchQuery;
        steps.push({icon:'🔍',agent:'WebSearchAgent',label:it?'Ricerca web':'Web search',reason:it?'Fonte dati web principale':'Primary web data source',prompt:sp});
      }
      if (hasSecurity)   steps.push({icon:'🛡',agent:'cassandra',      label:it?'CASSANDRA — Rischi':'CASSANDRA — Risks',     reason:it?'Keyword sicurezza rilevata':'Security keyword detected', prompt:'Analyze the collected data and identify security risks, vulnerabilities and concrete recommendations'});
      if (hasFinance)    steps.push({icon:'💰',agent:'mercury',         label:it?'MERCURY — Mercato':'MERCURY — Market',       reason:it?'Keyword finanza rilevata':'Finance keyword detected', prompt:'Analyze the financial data and market trends from the collected information'});
      if (hasStrategy)   steps.push({icon:'♟',agent:'athena',          label:it?'ATHENA — Strategia':'ATHENA — Strategy',     reason:it?'Keyword strategia rilevata':'Strategy keyword detected', prompt:'Based on the collected data, produce strategic analysis with competitive positioning and concrete recommendations'});
      if (hasReputation) steps.push({icon:'🔭',agent:'oracle',          label:it?'ORACLE — Reputazione':'ORACLE — Reputation', reason:it?'Keyword reputazione rilevata':'Reputation keyword detected', prompt:'Analyze the online reputation data, sentiment and brand positioning from the collected information'});
      if (hasCode)       steps.push({icon:'🔧',agent:'forge',           label:it?'FORGE — Codice':'FORGE — Code',              reason:it?'Keyword codice rilevata':'Code keyword detected', prompt:'Analyze the code, dependencies and technical issues identified in the data'});
      if (hasWriting)    steps.push({icon:'🖊',agent:'quill',           label:it?'QUILL — Redazione':'QUILL — Writing',        reason:it?'Keyword scrittura rilevata':'Writing keyword detected', prompt:'Write a polished, professional document based on all the collected information'});
      if (hasData)       steps.push({icon:'📊',agent:'DataAnalystAgent',label:it?'Analisi dati':'Data analysis',               reason:it?'Keyword dati rilevata':'Data keyword detected', prompt:'Analyze the data and extract key patterns, trends and insights'});
      if (hasTranslate)  steps.push({icon:'🌐',agent:'polyglot',        label:it?'POLYGLOT — Traduzione':'POLYGLOT — Translation',reason:it?'Keyword traduzione rilevata':'Translation keyword detected', prompt:'Translate the content as requested, maintaining meaning and style'});
      const hasSpecialist = hasSecurity || hasFinance || hasStrategy || hasReputation || hasCode || hasWriting || hasData || hasTranslate;
      if (!hasSpecialist && (hasBriefing || steps.length > 0)) {
        steps.push({icon:'📰',agent:'HERALD',label:it?'HERALD — Briefing':'HERALD — Briefing',reason:it?'HERALD sintetizza tutti i dati':'HERALD synthesizes all data',prompt:'Based on ALL the data collected by the previous steps, write a complete executive briefing with priorities, findings, and strategic recommendations. Do NOT invent data — only use what was provided.'});
      }
      const specialistCount = [hasSecurity,hasFinance,hasStrategy,hasReputation,hasCode,hasWriting,hasData].filter(Boolean).length;
      if (hasCanvas || specialistCount >= 2 || (hasSpecialist && hasBriefing)) {
        steps.push({icon:'📊',agent:'CanvasAgent',label:it?'Dashboard HTML':'HTML Dashboard',reason:it?'Analisi complessa — dashboard visuale':'Complex analysis — visual dashboard',prompt:'Create a professional HTML dashboard report summarizing all findings from the previous agents'});
      }
      return steps;
    };

    const keywordSteps = buildKeywordPlan();
    const hasKeywordPlan = keywordSteps.length > 0;
    const sanitizedTask = task.replace(/<[^>]*>/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
    const keywordPlanJson = hasKeywordPlan ? JSON.stringify(keywordSteps.map(s => ({ agent: s.agent, label: s.label, reason: s.reason || '' }))) : '[]';
    const planConfig = Object.assign({}, config, { thinking: 'off' });

    try {
      let steps = keywordSteps;
      if (config && (config.llm?.provider || config.llm?.apiKey)) {
        try {
          const planSys = `You are a workflow planner for NHA Studio. Output ONLY valid JSON — no explanation, no markdown.`;
          const planPrompt = hasKeywordPlan
            ? `Task: ${sanitizedTask}\n\nKeyword-detected plan (JSON):\n${keywordPlanJson}\n\nLanguage for labels: ${plannerLang}.\n\nReview the plan. You may ADD missing steps, REMOVE wrong ones, REORDER, ADJUST prompts. Keep existing reasons where step is unchanged.\n\nAvailable agents: TravelAgent, WebSearchAgent, DocumentReaderAgent, EmailAgent, CalendarAgent, GitHubAgent, SlackAgent, NotionAgent, HERALD, ORACLE, ATHENA, CASSANDRA, MERCURY, QUILL, DataAnalystAgent, polyglot, CanvasAgent (last only).\n\nOutput ONLY:\n{"steps":[{"icon":"EMOJI","agent":"AGENT_NAME","label":"LABEL","reason":"WHY","prompt":"INSTRUCTION"}]}\n\nMax 6 steps.`
            : `Task: ${sanitizedTask}\n\nLanguage for labels: ${plannerLang}.\n\nBuild a workflow plan. Available agents: TravelAgent, WebSearchAgent, DocumentReaderAgent, EmailAgent, CalendarAgent, GitHubAgent, SlackAgent, NotionAgent, HERALD, ORACLE, ATHENA, CASSANDRA, MERCURY, QUILL, DataAnalystAgent, polyglot, CanvasAgent.\n\nOutput ONLY:\n{"steps":[{"icon":"EMOJI","agent":"AGENT_NAME","label":"LABEL","reason":"WHY","prompt":"INSTRUCTION"}]}\n\n2-5 steps.`;
          const planRaw = await callLLM(planConfig, planSys, planPrompt, { max_tokens: 900 });
          let clean = planRaw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^```[\w]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
          const jm = clean.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(jm ? jm[0] : clean);
          if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
            const krMap = {};
            keywordSteps.forEach(s => { krMap[s.agent] = s.reason || ''; });
            steps = parsed.steps.map(s => ({ icon: s.icon || '🤖', agent: s.agent, label: s.label, reason: s.reason || krMap[s.agent] || '', prompt: s.prompt }));
          }
        } catch {}
      }
      if (!Array.isArray(steps) || !steps.length) {
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

      const contextBlock = context ? `\n\n## CONTEXT FROM PREVIOUS STEPS:\n${context.slice(0, 8000)}` : '';
      const proposalContextBlock = body.proposalContext ? `\n\n## OTHER AGENTS' PROPOSALS (CROSS-READING):\n${body.proposalContext.slice(0, 6000)}` : '';

      const sysParts = [
        agentSysDef || `You are ${agent}, a specialist AI agent in NHA Studio. Respond entirely in ${language}. Today is ${today}.`,
        `\n\n## WORKFLOW GOAL: ${task}`,
        contextBlock,
        proposalContextBlock,
        stepDef?.prompt ? `\n\n## YOUR SPECIFIC TASK:\n${stepDef.prompt}` : '',
      ];
      const systemPrompt = sysParts.join('');
      const userMessage = stepDef?.prompt || task;

      let output = '';
      let tokensOut = 0;
      await callLLMStream(config, systemPrompt, userMessage, (tok) => {
        output += tok;
        tokensOut += Math.ceil(tok.length / 4);
        sse({ token: tok });
      }, { max_tokens: 8192 });

      clearInterval(keepalive);
      sse({ done: true, output, tokensOut });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      clearInterval(keepalive);
      sse({ error: e.message });
      res.end();
    }
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
        .map(p => `## ${p.label || p.agent} (Round 1):\n${p.output.slice(0,4000)}`)
        .join('\n\n---\n\n');

      tok('[Parlamento — Round 2: Cross-Reading & Refinamento] ');
      const r2Results = [];
      for (const proposal of eligible) {
        tok(`[Round 2: ${proposal.label || proposal.agent}] `);
        const r2Sys = `You are ${proposal.agent}, a specialist AI agent in NHA Studio Parliament. Today is ${today}. Respond entirely in ${language}.\n\n## WORKFLOW GOAL: ${task}\n\n## YOUR ROUND 1 RESPONSE:\n${proposal.output.slice(0,1500)}\n\n## OTHER AGENTS' ROUND 1 PROPOSALS:\n${crossCtx(proposal.agent)}\n\nDELIBERATION ROUND 2 — REFINEMENT:\n1. Review the other agents' proposals\n2. Incorporate valid points where you AGREE — mark with [ASSIST]\n3. Flag genuine disagreements with [CONTRADICTION] and explain your reasoning\n4. Produce your COMPLETE REFINED response\n5. Keep analysis focused on: ${task}`;
        let r2Out = '';
        try {
          await callLLMStream(config, r2Sys, 'Produce your refined Round 2 response. Write complete content under every heading — never leave a section title without body text.',
            (t) => { r2Out += t; }, { max_tokens: 8192 });
        } catch { r2Out = proposal.output; }
        r2Results.push({ agent: proposal.agent, label: proposal.label, icon: proposal.icon, output: r2Out });
        sse({ deliberation_r2: { agent: proposal.agent, label: proposal.label, icon: proposal.icon, output: r2Out } });
      }

      const r2Conv = measureConvergence(r2Results.map(r => r.output));
      tok(`[Parlamento — Round 2 convergenza: ${(r2Conv*100).toFixed(0)}%] `);
      const converged = r2Conv >= 0.30;

      const allR2Ctx = r2Results.map(r => `## ${r.label || r.agent}:\n${r.output.slice(0,2000)}`).join('\n\n---\n\n');
      const contradictions = [];
      for (const r of r2Results) {
        const matches = r.output.match(/\[CONTRADICTION\][^\n]*/g) || [];
        matches.forEach(m => contradictions.push(`- ${r.label || r.agent}: ${m.replace('[CONTRADICTION]','').trim()}`));
      }
      const contBlock = contradictions.length > 0 ? `\n\n## DIVERGENZE RILEVATE DAL ROUND 2:\n${contradictions.join('\n')}` : '';

      tok(converged ? '[Parlamento — Round 3: Sintesi finale HERALD...] ' : '[Parlamento — Round 3: Mediazione HERALD...] ');

      const medTask = converged
        ? `SYNTHESIS TASK (convergenza ${(r2Conv*100).toFixed(0)}%):\n1. Presenta il CONSENSO raggiunto\n2. Segnala ogni sfumatura o punto di divergenza residua\n3. Produci un executive summary unificato con azioni concrete per: ${task}\n4. Sezione "Voci dissonanti" se esistono posizioni che meritano attenzione`
        : `MEDIATION TASK (convergenza ${(r2Conv*100).toFixed(0)}% — divergenza significativa):\n1. Identifica i punti di ACCORDO tra tutti gli agenti\n2. Per ogni disaccordo: valuta quale posizione ha evidenze più solide, NOMINA l'agente e spiega perché è stata accolta o scartata\n3. Produci una sintesi UNIFICATA\n4. Fai scelte editoriali nette\n5. Executive summary con azioni concrete per: ${task}`;

      const medSys = `You are HERALD, the Parliament Mediator in NHA Studio. Today is ${today}. Respond entirely in ${language}.\n\n## WORKFLOW GOAL: ${task}\n\n## ALL AGENTS' REFINED POSITIONS (Round 2):\n${allR2Ctx}${contBlock}\n\n${medTask}\n\nCRITICAL: NEVER write a heading without immediately writing full content below it. Every section MUST have at least 3-5 concrete bullet points or sentences.`;

      let mediationOutput = '';
      try {
        await callLLMStream(config, medSys, 'Produce the Parliament final synthesis.', (t) => { mediationOutput += t; }, { max_tokens: 8192 });
      } catch {}
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
