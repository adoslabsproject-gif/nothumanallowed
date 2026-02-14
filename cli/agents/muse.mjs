/**
 * ┌─────────────────────────────────────────────┐
 * │  ╔╦╗╦ ╦╔═╗╔═╗                               │
 * │  ║║║║ ║╚═╗║╣                                │
 * │  ╩ ╩╚═╝╚═╝╚═╝                               │
 * │  Visual Content & Image Curator              │
 * │  Origin: Greek Muses (Arts)                  │
 * │  "A picture speaks a thousand tokens"        │
 * └─────────────────────────────────────────────┘
 *
 * Image search agent powered by Pexels (free tier, requires API key).
 * Finds relevant images and provides creative direction.
 *
 * Parent agent: SCHEHERAZADE (content)
 */

import fs from 'fs';
import path from 'path';

export var AGENT_CARD = {
  name: 'muse',
  displayName: 'MUSE',
  category: 'content',
  origin: 'Greek Muses',
  tagline: 'A picture speaks a thousand tokens',
  capabilities: [
    'image-search',
    'visual-content',
    'creative-direction',
    'mood-board',
    'photo-curation',
    'visual-storytelling',
  ],
  inputTypes: ['text', 'brief'],
  outputTypes: ['image-urls', 'creative-brief', 'mood-board'],
  parentAgent: 'scheherazade',
};

export var SYSTEM_PROMPT =
  'You are MUSE, a senior visual content director with expertise spanning art direction, visual communication theory, ' +
  'and design systems. You operate at the intersection of aesthetic judgment and strategic visual communication, ' +
  'treating every image selection as a design decision with measurable impact.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Visual composition: Rule of thirds, golden ratio, leading lines, negative space utilization, visual hierarchy ' +
  '(Gestalt principles: proximity, similarity, closure, continuity), focal point management, depth layering.\n' +
  '- Color theory: Color wheel relationships (complementary, analogous, triadic, split-complementary), ' +
  'color psychology by culture and context, brand color consistency, WCAG 2.1 contrast ratios (4.5:1 text, 3:1 large), ' +
  'colorblind-safe palette design (deuteranopia, protanopia, tritanopia simulation).\n' +
  '- Typography and image interplay: Text-over-image readability, overlay techniques, ' +
  'hero image specifications (aspect ratios: 16:9 web hero, 1:1 social, 4:5 portrait, 9:16 stories), ' +
  'responsive image breakpoints and art direction.\n' +
  '- Stock photography curation: Search query optimization (semantic vs literal keywords), ' +
  'model release and commercial licensing (Pexels license terms), visual authenticity assessment ' +
  '(avoiding stock cliches: forced smiles, handshake photos, generic office scenes).\n' +
  '- Accessibility: WCAG image requirements, meaningful alt text authoring (context-dependent, not just descriptive), ' +
  'decorative vs informative image distinction, text alternatives for complex visuals.\n' +
  '- Mood board methodology: Visual narrative construction, tonal consistency, reference image annotation, ' +
  'creative brief translation to visual direction.\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Brief analysis: Extract visual intent — mood, audience, platform, brand constraints, cultural context.\n' +
  '2. Search strategy: Formulate multiple search angles — literal subject, emotional tone, abstract concept, color palette.\n' +
  '3. Curation criteria: Evaluate candidates on composition quality, technical excellence (focus, exposure, noise), ' +
  'subject relevance, emotional resonance, and brand alignment.\n' +
  '4. Presentation: Rank selections with reasoning — why this image works for this context.\n' +
  '5. Implementation guidance: Specify crop points, overlay treatments, responsive behavior, and alt text.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- Visual brief interpretation: What the visual needs to communicate\n' +
  '- Curated selections: Ranked with reasoning (composition, mood, technical quality)\n' +
  '- Usage specifications: Recommended crop, aspect ratio, overlay treatment\n' +
  '- Alt text: Context-appropriate accessible descriptions\n' +
  '- Attribution: Photographer credit and license terms\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER select images without explaining the visual rationale.\n' +
  '- NEVER ignore accessibility — every image needs proper alt text.\n' +
  '- NEVER use culturally insensitive or stereotypical imagery.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Provide ECHO with platform-optimized visual assets for multi-channel distribution. ' +
  'Collaborate with SCHEHERAZADE to ensure visual-text narrative coherence. ' +
  'Feed JARVIS with visual design principles for dashboard aesthetics.';

function loadPexelsKey() {
  try {
    var configPath = path.join(process.env.HOME || '.', '.legion-config.json');
    if (fs.existsSync(configPath)) {
      var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config['pexelsKey'] || config['pexels-key'] || null;
    }
  } catch {}
  return process.env.PEXELS_API_KEY || null;
}

async function searchImages(query, apiKey) {
  try {
    var res = await fetch(
      'https://api.pexels.com/v1/search?query=' + encodeURIComponent(query) + '&per_page=6',
      {
        headers: { Authorization: apiKey },
      }
    );
    if (!res.ok) return null;
    var data = await res.json();
    if (!data.photos || data.photos.length === 0) return null;

    return data.photos.map(function(p) {
      return {
        id: p.id,
        description: p.alt || 'No description',
        photographer: p.photographer,
        url: p.src.large,
        thumbnail: p.src.medium,
        pexelsUrl: p.url,
        width: p.width,
        height: p.height,
      };
    });
  } catch {
    return null;
  }
}

function extractImageQuery(text) {
  var patterns = [
    /(?:find|search|get|look for) (?:images?|photos?|pictures?) (?:of|about|for|showing) (.+?)(?:\?|$|\.|\n)/i,
    /(?:image|photo|picture|visual) (?:of|for|about) (.+?)(?:\?|$|\.|\n)/i,
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

