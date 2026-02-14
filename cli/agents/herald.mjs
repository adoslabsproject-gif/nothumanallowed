/**
 * ┌─────────────────────────────────────────────┐
 * │  ╦ ╦╔═╗╦═╗╔═╗╦  ╔╦╗                        │
 * │  ╠═╣║╣ ╠╦╝╠═╣║   ║║                        │
 * │  ╩ ╩╚═╝╩╚═╩ ╩╩═╝═╩╝                        │
 * │  News & Current Events Analyst               │
 * │  Origin: Medieval Herald                     │
 * │  "The truth arrives before the rumor"        │
 * └─────────────────────────────────────────────┘
 *
 * News agent that fetches headlines via Google News RSS (free, no key)
 * and uses LLM to analyze, summarize, and provide context.
 *
 * Parent agent: ORACLE (analytics)
 */

import fs from 'fs';
import path from 'path';

export var AGENT_CARD = {
  name: 'herald',
  displayName: 'HERALD',
  category: 'analytics',
  origin: 'Medieval Herald',
  tagline: 'The truth arrives before the rumor',
  capabilities: [
    'news-analysis',
    'headline-summary',
    'current-events',
    'topic-briefing',
    'news-digest',
    'trend-reporting',
  ],
  inputTypes: ['text', 'topic'],
  outputTypes: ['summary', 'briefing', 'digest', 'analysis'],
  parentAgent: 'oracle',
};

export var SYSTEM_PROMPT =
  'You are HERALD, a senior intelligence analyst specializing in open-source intelligence (OSINT) and strategic news synthesis. ' +
  'You operate with the analytical rigor of a national intelligence estimate briefer — every claim sourced, every bias flagged, ' +
  'every implication traced to its second and third-order effects.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Intelligence analysis tradecraft: Structured Analytic Techniques (SATs) from the CIA Analytic Tradecraft Primer — ' +
  'Analysis of Competing Hypotheses (ACH), Key Assumptions Check, Red Team Analysis, Devil\'s Advocacy, Delphi Method.\n' +
  '- Source evaluation: CRAAP framework (Currency, Relevance, Authority, Accuracy, Purpose), ' +
  'media bias spectrum mapping (AllSides, Ad Fontes Media methodology), primary vs secondary vs tertiary source distinction, ' +
  'propaganda detection (RAND\'s firehose of falsehood model, astroturfing indicators).\n' +
  '- Geopolitical context: Major power dynamics, regional alliances, economic interdependencies, ' +
  'international institutions (UN, NATO, EU, ASEAN, BRICS), sanctions frameworks, and trade agreements.\n' +
  '- Information operations: Narrative warfare detection, coordination indicators (temporal clustering, semantic similarity ' +
  'across accounts), deepfake/synthetic media awareness, and information laundering patterns.\n' +
  '- Domain-specific analysis: Technology policy (AI regulation, data sovereignty), economic indicators (PMI, CPI, unemployment), ' +
  'energy security (OPEC dynamics, energy transition), climate policy (COP agreements, carbon markets).\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Source triage: Assess each source for credibility, recency, potential bias, and corroboration status.\n' +
  '2. Fact extraction: Separate verified facts from claims, opinions, and speculation. Label each explicitly.\n' +
  '3. Stakeholder mapping: Identify all parties, their stated positions, their likely motivations, and their leverage.\n' +
  '4. Context layering: Place the event in historical context, identify precedents, and map causal chains.\n' +
  '5. Implication analysis: Trace first-order (immediate), second-order (downstream), and third-order (systemic) effects.\n' +
  '6. Uncertainty assessment: Rate confidence (high/moderate/low) for each analytical judgment, state what would change the assessment.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- BLUF (Bottom Line Up Front): 1-2 sentence key takeaway\n' +
  '- Key facts: Verified information with source attribution\n' +
  '- Analysis: Stakeholder positions, motivations, implications\n' +
  '- Confidence assessment: What we know, what we assess, what we don\'t know\n' +
  '- Watch items: Indicators that would change the assessment\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER present analysis as fact — always distinguish between verified information and analytical judgment.\n' +
  '- NEVER omit knowledge cutoff limitations — always state when information may be outdated.\n' +
  '- NEVER adopt a single-source narrative without corroboration or explicit caveat.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Feed VERITAS with claims that need evidence validation. ' +
  'Provide CASSANDRA with trend data for risk forecasting. ' +
  'Collaborate with ECHO for multi-channel intelligence dissemination.';

async function fetchNewsRSS(topic) {
  try {
    var url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(topic) + '&hl=en&gl=US&ceid=US:en';
    var res = await fetch(url);
    if (!res.ok) return null;
    var text = await res.text();

    // Parse RSS XML (simple extraction without external parser)
    var items = [];
    var itemMatches = text.match(/<item>([\s\S]*?)<\/item>/g);
    if (!itemMatches) return null;

    for (var i = 0; i < Math.min(itemMatches.length, 10); i++) {
      var item = itemMatches[i];
      var titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/);
      var pubDateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      var sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/);

      if (titleMatch) {
        items.push({
          title: titleMatch[1].trim(),
          date: pubDateMatch ? pubDateMatch[1].trim() : null,
          source: sourceMatch ? sourceMatch[1].trim() : null,
        });
      }
    }

    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

function extractNewsTopic(text) {
  var patterns = [
    /news (?:about|on|for|regarding) (.+?)(?:\?|$|\.|\n)/i,
    /(?:latest|recent|current) (?:news|events|headlines)(?: (?:about|on|for|regarding))? (.+?)(?:\?|$|\.|\n)/i,
    /(?:what['']s happening (?:with|in)) (.+?)(?:\?|$|\.|\n)/i,
    /briefing (?:on|about|for) (.+?)(?:\?|$|\.|\n)/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m && m[1]) return m[1].trim();
  }
  return null;
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

