/**
 * ┌─────────────────────────────────────────────┐
 * │  ╔═╗╔═╗╦═╗╔╦╗╔═╗╔═╗╦═╗╔═╗╔═╗╦ ╦╔═╗╦═╗    │
 * │  ║  ╠═╣╠╦╝ ║ ║ ║║ ╦╠╦╝╠═╣╠═╝╠═╣║╣ ╠╦╝    │
 * │  ╚═╝╩ ╩╩╚═ ╩ ╚═╝╚═╝╩╚═╩ ╩╩  ╩ ╩╚═╝╩╚═    │
 * │  Geolocation & Mapping Expert                │
 * │  Origin: Age of Exploration                  │
 * │  "The map is not the territory — but close"  │
 * └─────────────────────────────────────────────┘
 *
 * Geocoding agent powered by Nominatim/OpenStreetMap (free, 1 req/sec).
 * Resolves locations, provides coordinates, nearby info, and analysis.
 *
 * Parent agent: GLITCH (data)
 */

export var AGENT_CARD = {
  name: 'cartographer',
  displayName: 'CARTOGRAPHER',
  category: 'data',
  origin: 'Age of Exploration',
  tagline: 'The map is not the territory — but close',
  capabilities: [
    'geocoding',
    'reverse-geocoding',
    'location-analysis',
    'distance-calculation',
    'place-search',
    'geographic-data',
  ],
  inputTypes: ['text', 'coordinates', 'address'],
  outputTypes: ['coordinates', 'location-data', 'analysis'],
  parentAgent: 'glitch',
};

export var SYSTEM_PROMPT =
  'You are CARTOGRAPHER, an expert in geography, cartography, and geospatial analysis. ' +
  'You combine precise geocoding data with deep geographical knowledge.\n\n' +
  'Your specialties:\n' +
  '- Address and place name geocoding (coordinates lookup)\n' +
  '- Reverse geocoding (coordinates to place names)\n' +
  '- Geographic context: time zones, climate zones, elevation\n' +
  '- Distance and routing information\n' +
  '- Regional demographics and points of interest\n\n' +
  'When provided with Nominatim data, enrich it with contextual information. ' +
  'Always include coordinates when discussing specific locations.';

// Rate limiter: 1 request per second for Nominatim
var lastNominatimCall = 0;

async function geocode(query) {
  try {
    // Respect rate limit
    var now = Date.now();
    var elapsed = now - lastNominatimCall;
    if (elapsed < 1100) {
      await new Promise(function(resolve) { setTimeout(resolve, 1100 - elapsed); });
    }
    lastNominatimCall = Date.now();

    var res = await fetch(
      'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(query) +
      '&format=json&limit=3&addressdetails=1',
      {
        headers: { 'User-Agent': 'Legion-Agent-Orchestrator/3.1.0' },
      }
    );
    if (!res.ok) return null;
    var data = await res.json();
    if (!data || data.length === 0) return null;

    return data.map(function(r) {
      return {
        displayName: r.display_name,
        latitude: parseFloat(r.lat),
        longitude: parseFloat(r.lon),
        type: r.type,
        class: r.class,
        address: r.address || {},
        importance: r.importance,
      };
    });
  } catch {
    return null;
  }
}

function extractLocation(text) {
  var patterns = [
    /(?:geocode|locate|find|where is|coordinates (?:of|for)) (.+?)(?:\?|$|\.|\n)/i,
    /(?:location|address|place) (.+?)(?:\?|$|\.|\n)/i,
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

