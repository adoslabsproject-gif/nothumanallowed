/**
 * ┌─────────────────────────────────────────────┐
 * │  ╔═╗╔═╗╦  ╦ ╦╔═╗╦  ╔═╗╔╦╗                  │
 * │  ╠═╝║ ║║  ╚╦╝║ ╦║  ║ ║ ║                   │
 * │  ╩  ╚═╝╩═╝ ╩ ╚═╝╩═╝╚═╝ ╩                   │
 * │  Universal Translator                        │
 * │  Origin: Polyglot (Many Tongues)             │
 * │  "Every language is a universe"              │
 * └─────────────────────────────────────────────┘
 *
 * Translation agent. Tries LibreTranslate (localhost:5000) first,
 * falls back to LLM translation. Supports 30+ languages.
 *
 * Parent agent: BABEL (integration)
 */

import fs from 'fs';
import path from 'path';

export var AGENT_CARD = {
  name: 'polyglot',
  displayName: 'POLYGLOT',
  category: 'integration',
  origin: 'Polyglot (Many Tongues)',
  tagline: 'Every language is a universe',
  capabilities: [
    'translation',
    'language-detection',
    'localization',
    'multilingual-content',
    'cross-language-analysis',
    'cultural-adaptation',
  ],
  inputTypes: ['text'],
  outputTypes: ['translated-text', 'localized-content', 'analysis'],
  parentAgent: 'babel',
};

export var SYSTEM_PROMPT =
  'You are POLYGLOT, a master translator and linguist. You provide accurate, ' +
  'culturally-appropriate translations that preserve meaning, tone, and nuance.\n\n' +
  'Your specialties:\n' +
  '- Accurate translation preserving context and idioms\n' +
  '- Cultural adaptation (not just literal translation)\n' +
  '- Technical and domain-specific terminology\n' +
  '- Language detection and multi-language support\n' +
  '- Localization advice (date formats, currency, cultural norms)\n\n' +
  'When LibreTranslate data is available, use it as a baseline and improve upon it. ' +
  'When translating, always note the source and target languages clearly.\n' +
  'For ambiguous phrases, provide alternative translations with context.';

function loadLibreTranslateUrl() {
  try {
    var configPath = path.join(process.env.HOME || '.', '.legion-config.json');
    if (fs.existsSync(configPath)) {
      var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config['libretranslateUrl'] || config['libretranslate-url'] || null;
    }
  } catch {}
  return 'http://localhost:5000';
}

function extractTranslation(text) {
  var patterns = [
    /translate (?:this )?(?:to|into) (\w+):\s*(.+)/is,
    /translate "(.+?)" (?:to|into) (\w+)/i,
    /(?:in|to) (\w+):\s*"?(.+?)"?\s*$/i,
  ];

  // Pattern 1: translate to <lang>: <text>
  var m1 = text.match(/translate (?:this )?(?:to|into) (\w+)\s*:\s*(.+)/is);
  if (m1) return { targetLang: m1[1].trim(), text: m1[2].trim() };

  // Pattern 2: translate "<text>" to <lang>
  var m2 = text.match(/translate\s+"([^"]+)"\s+(?:to|into)\s+(\w+)/i);
  if (m2) return { targetLang: m2[2].trim(), text: m2[1].trim() };

  // Pattern 3: general pattern
  var m3 = text.match(/translate\s+(.+?)\s+(?:to|into)\s+(\w+)/i);
  if (m3) return { targetLang: m3[2].trim(), text: m3[1].trim() };

  return null;
}

var LANG_CODES = {
  english: 'en', french: 'fr', spanish: 'es', german: 'de', italian: 'it',
  portuguese: 'pt', dutch: 'nl', russian: 'ru', chinese: 'zh', japanese: 'ja',
  korean: 'ko', arabic: 'ar', hindi: 'hi', turkish: 'tr', polish: 'pl',
  swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', czech: 'cs',
  greek: 'el', hebrew: 'he', thai: 'th', vietnamese: 'vi', indonesian: 'id',
  ukrainian: 'uk', hungarian: 'hu', romanian: 'ro', bulgarian: 'bg',
};

async function tryLibreTranslate(sourceText, targetLang, baseUrl) {
  try {
    var langCode = LANG_CODES[targetLang.toLowerCase()] || targetLang.toLowerCase();
    var res = await fetch(baseUrl + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: sourceText,
        source: 'auto',
        target: langCode,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    var data = await res.json();
    return data.translatedText || null;
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

