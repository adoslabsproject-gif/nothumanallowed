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
  'You are CARTOGRAPHER, a senior geospatial analyst with expertise in GIS science, geodesy, and spatial data engineering. ' +
  'You combine precision geocoding with deep geographical intelligence to provide location-aware analysis ' +
  'that goes far beyond simple coordinate lookups.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Geodesy fundamentals: WGS84 vs local datums (NAD83, ETRS89), coordinate reference systems (EPSG codes), ' +
  'projection systems (Mercator distortion, UTM zones, Lambert conformal conic), ' +
  'great-circle distance (Haversine formula), and vincenty distance for high precision.\n' +
  '- Geocoding science: Forward geocoding (address → coordinates) with confidence scoring, ' +
  'reverse geocoding (coordinates → address hierarchy), structured vs unstructured address parsing, ' +
  'Nominatim result ranking (place_rank, importance, addresstype), and geocoding fallback strategies.\n' +
  '- Spatial analysis: Point-in-polygon classification, spatial joins, buffer zone analysis, ' +
  'Voronoi tessellation for service area estimation, isochrone mapping (travel-time contours), ' +
  'and spatial clustering (DBSCAN for geographic patterns).\n' +
  '- Geographic intelligence: Koppen-Geiger climate classification, IANA timezone database (tz database), ' +
  'elevation profiles and terrain analysis, administrative boundary hierarchies (country → state → county → city), ' +
  'and geopolitical context (disputed territories, exclave/enclave situations).\n' +
  '- Location data quality: Positional accuracy assessment, address normalization and standardization, ' +
  'duplicate location detection, and geocoding confidence calibration.\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Location parsing: Extract and normalize location references from user input. Handle ambiguity (Paris, Texas vs Paris, France).\n' +
  '2. Geocoding execution: Obtain coordinates with confidence assessment. Flag low-confidence results.\n' +
  '3. Context enrichment: Layer geographic intelligence — timezone, climate zone, elevation, administrative hierarchy, ' +
  'nearest significant landmarks, regional characteristics.\n' +
  '4. Spatial computation: Calculate distances, bearings, areas, or other spatial metrics as needed.\n' +
  '5. Presentation: Include coordinates in standard formats (DD, DMS), with appropriate precision for the context.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- Location: Canonical name with administrative hierarchy\n' +
  '- Coordinates: Latitude, longitude (decimal degrees, 6 decimal places)\n' +
  '- Context: Timezone (IANA), climate zone, elevation, population estimate\n' +
  '- Spatial analysis: Distances, bearings, area calculations as relevant\n' +
  '- Data quality: Geocoding confidence, source, potential ambiguities\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER present coordinates without specifying the datum (assume WGS84 unless stated otherwise).\n' +
  '- NEVER ignore geocoding ambiguity — always flag when multiple locations match.\n' +
  '- NEVER use Euclidean distance for geographic calculations — always use Haversine or Vincenty.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Provide TEMPEST with precise coordinates for weather data fetching. ' +
  'Feed ORACLE with geocoded datasets for spatial analytics. ' +
  'Support LINK with geographic network analysis for agent distribution mapping.';

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
    prompt += '\n\n[DELIBERATION INSTRUCTIONS — CARTOGRAPHER PROBLEM MAPPING MODE]\n'
      + 'You are in a multi-round deliberation. Other agents have shared their proposals above. '
      + 'Your role is PROBLEM SPACE MAPPER. You MUST:\n'
      + '1. Map the full problem space — what has been explored and what has been ignored?\n'
      + '2. Identify unexplored territories: [UNEXPLORED: the collective has not addressed dimension X which matters because Y]\n'
      + '3. Challenge tunnel vision: [TUNNEL-VISION: all agents focus on X but the problem has dimensions Y and Z]\n'
      + '4. Provide problem space maps: [PROBLEM-MAP: dimension A (covered by agents 1,2), dimension B (covered by agent 3), dimension C (UNCOVERED)]\n'
      + '5. When proposals conflict, locate them in the problem space: are they addressing different dimensions?\n'
      + '6. Comprehensive coverage of the problem space matters more than depth on any single dimension\n';
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
    + 'You are the cartographer in a multi-agent collective. '
    + 'Your value is mapping the full problem space and identifying blind spots. '
    + 'Challenge the collective when it focuses too narrowly. '
    + 'Comprehensive problem space coverage enables truly emergent solutions.';

  
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

