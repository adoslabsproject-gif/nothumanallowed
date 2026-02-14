/**
 * ┌─────────────────────────────────────────────┐
 * │  ╔╦╗╔═╗╦═╗╔═╗╦ ╦╦═╗╦ ╦                     │
 * │  ║║║║╣ ╠╦╝║  ║ ║╠╦╝╚╦╝                     │
 * │  ╩ ╩╚═╝╩╚═╚═╝╚═╝╩╚═ ╩                      │
 * │  Financial Market Analyst                    │
 * │  Origin: Roman Mythology (Messenger God)     │
 * │  "Speed is the soul of trade"                │
 * └─────────────────────────────────────────────┘
 *
 * Financial data agent powered by Finnhub (free tier: 60 req/min).
 * Fetches stock quotes and company profiles, then LLM analyzes.
 *
 * Parent agent: ORACLE (analytics)
 */

import fs from 'fs';
import path from 'path';

export var AGENT_CARD = {
  name: 'mercury',
  displayName: 'MERCURY',
  category: 'analytics',
  origin: 'Roman Mythology',
  tagline: 'Speed is the soul of trade',
  capabilities: [
    'stock-analysis',
    'market-data',
    'financial-metrics',
    'company-analysis',
    'price-tracking',
    'market-trends',
  ],
  inputTypes: ['text', 'ticker'],
  outputTypes: ['analysis', 'report', 'data'],
  parentAgent: 'oracle',
};

export var SYSTEM_PROMPT =
  'You are MERCURY, a senior financial market analyst with CFA-level expertise in equity research, ' +
  'technical analysis, and quantitative risk assessment. You combine real-time market data with rigorous ' +
  'analytical frameworks to deliver institutional-quality financial intelligence.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Fundamental analysis: P/E, P/B, P/S, EV/EBITDA multiples, DCF valuation models, DuPont decomposition (ROE = margin x turnover x leverage), ' +
  'free cash flow analysis, dividend discount models, earnings quality assessment (accruals ratio, cash conversion).\n' +
  '- Technical analysis: Support/resistance levels, moving averages (SMA, EMA, VWAP), momentum indicators (RSI, MACD, stochastic oscillator), ' +
  'volume analysis (OBV, accumulation/distribution), chart patterns (head-and-shoulders, double top/bottom, flags, wedges), ' +
  'Fibonacci retracement levels, Bollinger Bands for volatility assessment.\n' +
  '- Risk metrics: Beta, Sharpe ratio, Sortino ratio, maximum drawdown, Value-at-Risk (VaR), implied volatility vs historical volatility, ' +
  'correlation analysis for portfolio context, sector rotation indicators.\n' +
  '- Market structure: Pre/post-market activity significance, options flow interpretation (put/call ratio, unusual volume), ' +
  'institutional ownership changes (13F filings), insider trading patterns (Form 4), short interest and days-to-cover.\n' +
  '- Macro context: Fed funds rate impact, yield curve analysis (2s10s spread), sector sensitivity to macro factors, ' +
  'earnings season positioning, index rebalancing effects.\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Data intake: Parse real-time quote data — current price, change, volume, 52-week range. Assess data freshness.\n' +
  '2. Price context: Where is the stock relative to 52-week range, major moving averages, and recent support/resistance?\n' +
  '3. Fundamental check: Evaluate valuation multiples vs sector peers and historical averages. Flag extremes.\n' +
  '4. Momentum assessment: Is price action confirming or diverging from volume? Identify trend strength.\n' +
  '5. Risk quantification: Estimate volatility regime, identify potential catalysts (earnings dates, ex-div dates, regulatory events).\n' +
  '6. Synthesis: Combine fundamental, technical, and macro perspectives into a coherent assessment.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- Market snapshot: ticker, price, change (% and absolute), volume vs average, 52-week position\n' +
  '- Company profile: sector, market cap, key fundamentals\n' +
  '- Technical assessment: trend direction, key levels, momentum reading\n' +
  '- Risk factors: volatility assessment, upcoming catalysts, sector headwinds/tailwinds\n' +
  '- Context: how this stock fits within its sector and the broader market\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER provide buy/sell/hold recommendations — analysis and education only.\n' +
  '- NEVER omit the disclaimer: "This is informational analysis, not financial advice."\n' +
  '- NEVER present single indicators in isolation — always contextualize within the full picture.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Feed EDI with quantitative data for deeper statistical modeling. ' +
  'Collaborate with ORACLE for pattern recognition across multi-asset datasets. ' +
  'Provide JARVIS with structured KPIs for financial dashboard design.';

function loadFinnhubKey() {
  try {
    var configPath = path.join(process.env.HOME || '.', '.legion-config.json');
    if (fs.existsSync(configPath)) {
      var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config['finnhubKey'] || config['finnhub-key'] || null;
    }
  } catch {}
  return process.env.FINNHUB_API_KEY || null;
}

function extractTicker(text) {
  // Match common ticker patterns: $AAPL, AAPL stock, etc.
  var patterns = [
    /\$([A-Z]{1,5})\b/,
    /\b([A-Z]{1,5})\s+(?:stock|share|price|quote|ticker)/i,
    /(?:analyze|analysis|quote|price of)\s+([A-Z]{1,5})\b/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m && m[1]) return m[1].toUpperCase();
  }
  return null;
}

async function fetchQuote(ticker, apiKey) {
  try {
    var res = await fetch(
      'https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(ticker) +
      '&token=' + apiKey
    );
    if (!res.ok) return null;
    var data = await res.json();
    if (data.c === 0 && data.h === 0) return null; // Empty/invalid
    return {
      ticker: ticker,
      current: data.c,
      change: data.d,
      changePercent: data.dp,
      high: data.h,
      low: data.l,
      open: data.o,
      previousClose: data.pc,
    };
  } catch {
    return null;
  }
}

async function fetchProfile(ticker, apiKey) {
  try {
    var res = await fetch(
      'https://finnhub.io/api/v1/stock/profile2?symbol=' + encodeURIComponent(ticker) +
      '&token=' + apiKey
    );
    if (!res.ok) return null;
    var data = await res.json();
    if (!data.name) return null;
    return {
      name: data.name,
      ticker: data.ticker,
      exchange: data.exchange,
      industry: data.finnhubIndustry,
      marketCap: data.marketCapitalization,
      currency: data.currency,
      country: data.country,
      weburl: data.weburl,
    };
  } catch {
    return null;
  }
}

export async function execute(task, context, llmProvider) {
  var prompt = 'Task: ' + task.description;

  // Task dependency results from previous sub-tasks
  if (context.dependencyResults && Object.keys(context.dependencyResults).length > 0) {
    prompt += '

[DEPENDENCY CONTEXT — Results from prerequisite tasks]
';
    var keys = Object.keys(context.dependencyResults);
    for (var i = 0; i < keys.length; i++) {
      prompt += '
--- Result from ' + keys[i] + ' ---
' + context.dependencyResults[keys[i]];
    }
  }

  // Original user request — always useful for maintaining big-picture awareness
  if (context.originalPrompt) {
    prompt += '

[ORIGINAL REQUEST]
' + context.originalPrompt;
  }

  // v5.0+: Collective intelligence context (structured framing)
  if (context.workspaceSnapshot) {
    prompt += '

[SHARED WORKSPACE — Live collaborative state from all agents]
' + context.workspaceSnapshot;
  }
  if (context.episodicMemories) {
    prompt += '

[EPISODIC MEMORY — Your relevant past experiences on similar tasks]
' + context.episodicMemories;
  }
  if (context.eventStream) {
    prompt += '

[COMMUNICATION STREAM — Recent inter-agent signals and events]
' + context.eventStream;
  }
  if (context.knowledgeGraph) {
    prompt += '

[KNOWLEDGE GRAPH — Known relationships between agents, capabilities, and domains]
' + context.knowledgeGraph;
  }
  if (context.latentSpaceInsight) {
    prompt += '

[LATENT SPACE — Emergent patterns detected across the collective]
' + context.latentSpaceInsight;
  }

  // v7.0: Deliberation cross-reading — other agents' proposals
  if (context.proposalContext) {
    prompt += '

[DELIBERATION — Cross-Reading Round]
' + context.proposalContext;
    prompt += '

[DELIBERATION INSTRUCTIONS]
'
      + 'You are in a multi-round deliberation. Other agents have shared their proposals above. '
      + 'You MUST:
'
      + '1. Read each proposal carefully and acknowledge valid points
'
      + '2. Incorporate insights from other agents where they strengthen your analysis
'
      + '3. Defend your unique expertise with evidence where you disagree
'
      + '4. Explicitly mark agreements with [AGREE: agent_name — point] and disagreements with [DISAGREE: agent_name — point — your counter-evidence]
'
      + '5. Aim for convergence on substance while preserving domain-specific depth
'
      + '6. If you change your position based on another agent's evidence, say so explicitly
';
  }

  // v5.0+: Self-modification — apply learned evolution patterns to system prompt
  var systemPrompt = SYSTEM_PROMPT;
  if (context.promptEvolution) {
    systemPrompt += '

[EVOLVED CAPABILITIES — Patterns learned from past performance]
' + context.promptEvolution;
  }

  // v8.0: Geth Consensus participation clause
  systemPrompt += '

[GETH CONSENSUS PROTOCOL]
'
    + 'You operate within a multi-agent collective intelligence system. '
    + 'Your response will be evaluated alongside other specialized agents' outputs. '
    + 'Be thorough and precise in your domain. '
    + 'When you see proposals from other agents, engage substantively — not superficially. '
    + 'Quality of reasoning matters more than length. '
    + 'Evidence-backed claims carry more weight in synthesis.';

  
  // v10.0: Neural Controller — Structured Output for confidence tracking
  systemPrompt += '\n\n'
    + '[STRUCTURED OUTPUT FORMAT]\n'
    + 'You MUST wrap your response in JSON format inside a markdown code block:\n'
    + '\`\`\`json\n'
    + '{\n'
    + '  "answer": "<your full answer here>",\n'
    + '  "confidence": <0.0 to 1.0>,\n'
    + '  "reasoning_summary": "<1-2 sentence summary of your reasoning>",\n'
    + '  "risk_flags": ["<optional flags: speculative, outdated_knowledge, incomplete_context, conflicting_evidence, domain_mismatch>"]\n'
    + '}\n'
    + '\`\`\`\n'
    + 'Confidence scale: 0.9-1.0 near certain, 0.7-0.89 high, 0.5-0.69 moderate, 0.3-0.49 low, 0.0-0.29 very low.';


  return await llmProvider.chat(systemPrompt, prompt, { maxTokens: 8192, agentTag: AGENT_CARD.name });
}

