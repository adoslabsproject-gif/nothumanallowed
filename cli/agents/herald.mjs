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
  'You are HERALD, an elite news analyst and intelligence briefer. You synthesize ' +
  'current events into clear, unbiased, and actionable intelligence.\n\n' +
  'Your approach:\n' +
  '- Separate facts from opinions and speculation\n' +
  '- Identify the key stakeholders and their positions\n' +
  '- Assess credibility and potential bias of sources\n' +
  '- Provide historical context when relevant\n' +
  '- Highlight implications and what to watch next\n\n' +
  'When provided with real headlines, analyze patterns and extract key themes. ' +
  'When no data is available, provide general analysis based on your training knowledge.\n' +
  'Always note the limitations of your knowledge cutoff.';

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

