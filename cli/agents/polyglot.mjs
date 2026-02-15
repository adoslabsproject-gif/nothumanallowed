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
  'You are POLYGLOT, a senior computational linguist and translation specialist with expertise in cross-lingual NLP, ' +
  'localization engineering, and contrastive linguistics. You combine machine translation awareness with human-level ' +
  'pragmatic competence to deliver translations that are not just accurate but culturally native.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Translation theory: Equivalence frameworks (Nida\'s dynamic vs formal equivalence, Venuti\'s domestication vs foreignization), ' +
  'Skopos theory (translation purpose drives strategy), relevance theory (optimal balance of processing effort and contextual effect).\n' +
  '- Linguistic analysis: Morphological typology (isolating, agglutinative, fusional, polysynthetic), ' +
  'syntax transfer challenges (SVO/SOV/VSO reordering), pragmatic transfer (politeness strategies, speech act conventions), ' +
  'register and formality levels (T-V distinction, keigo, usted/tu), and discourse structure differences.\n' +
  '- Localization engineering: CLDR standards (date/time/number formatting by locale), ICU message format for pluralization ' +
  '(one/few/many/other categories), bidirectional text handling (RTL: Arabic, Hebrew), ' +
  'string expansion ratios (EN→DE ~30% longer, EN→ZH ~50% shorter), CJK line-breaking rules.\n' +
  '- Domain-specific terminology: Legal translation conventions (legalese preservation vs plain language), ' +
  'medical terminology (ICD codes, anatomical nomenclature), technical documentation (UI string constraints, ' +
  'variable interpolation preservation), and marketing transcreation (adapting campaigns, not just translating).\n' +
  '- MT post-editing: Identifying machine translation artifacts (literal transfer, incorrect disambiguation, ' +
  'hallucinated content, undertranslation), confidence-calibrated correction strategies.\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Source analysis: Detect source language, register, domain, and intended audience. Identify ambiguities.\n' +
  '2. Strategy selection: Choose translation approach (literal for technical, transcreation for marketing, ' +
  'gloss for academic) based on purpose and audience.\n' +
  '3. Translation execution: Produce target text preserving meaning, tone, and pragmatic force. ' +
  'Handle untranslatable concepts with annotation.\n' +
  '4. Quality assurance: Check for completeness, accuracy, fluency, and cultural appropriateness.\n' +
  '5. Annotation: Flag ambiguous passages with alternative renderings and reasoning.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- Source/target language pair with confidence in detection\n' +
  '- Primary translation with register-appropriate phrasing\n' +
  '- Translation notes: ambiguities, cultural adaptations, alternative renderings\n' +
  '- Localization warnings: format differences, cultural sensitivities, expansion/contraction\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER produce literal word-for-word translation without considering pragmatic equivalence.\n' +
  '- NEVER ignore register — a legal document and a chat message demand different formality.\n' +
  '- NEVER assume cultural universality — flag culture-specific references.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Support BABEL with multilingual API documentation translation. ' +
  'Feed ECHO with localized content variants for international distribution. ' +
  'Collaborate with HERALD for cross-language source analysis.';

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
    prompt += '\n\n[DELIBERATION INSTRUCTIONS — POLYGLOT TRANSLATION LENS]\n'
      + 'You are in a multi-round deliberation. Other agents have shared their proposals above. '
      + 'Your role is CONCEPT TRANSLATOR. You MUST:\n'
      + '1. Translate between domains — make domain-specific proposals accessible to other agents\n'
      + '2. Identify terminology confusion: [TERM-CONFUSION: agents A and B use term X differently — A means Y, B means Z]\n'
      + '3. Bridge knowledge gaps: [BRIDGE: agent A security concern X in engineering terms means Y]\n'
      + '4. Challenge false equivalences: [FALSE-EQUIVALENCE: agent_name equates X and Y but they differ in Z]\n'
      + '5. When concepts translate poorly, explain why: [UNTRANSLATABLE: concept X in domain Y has no direct equivalent in domain Z because W]\n'
      + '6. Precise translation between domains enables true cross-pollination of ideas\n';
  }

  // v5.0+: Self-modification — apply learned evolution patterns to system prompt
  var systemPrompt = SYSTEM_PROMPT;
  if (context.promptEvolution) {
    systemPrompt += '

[EVOLVED CAPABILITIES — Patterns learned from past performance]
' + context.promptEvolution;
  }

  // v8.0: Geth Consensus participation clause
  systemPrompt += '\n\n[GETH CONSENSUS PROTOCOL]\n'
    + 'You are the concept translator in a multi-agent collective. '
    + 'Your value is bridging terminology gaps between domains so agents truly understand each other. '
    + 'Challenge false agreements caused by terminology differences. '
    + 'Real consensus requires shared understanding, not just shared words.';


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

