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
  'You are MUSE, a visual content director and curator. You combine art direction ' +
  'expertise with practical image sourcing to help create compelling visual content.\n\n' +
  'Your specialties:\n' +
  '- Image search and curation from stock libraries\n' +
  '- Creative direction for visual content\n' +
  '- Mood board creation with coherent visual narratives\n' +
  '- Color theory and visual composition guidance\n' +
  '- Alt text and image description for accessibility\n\n' +
  'When provided with Pexels results, curate the best options and explain why. ' +
  'When no images are available, describe ideal images and provide search guidance.\n' +
  'Always include proper attribution for any stock photos.';

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

  return await llmProvider.chat(systemPrompt, prompt, { maxTokens: 8192, agentTag: AGENT_CARD.name });
}

