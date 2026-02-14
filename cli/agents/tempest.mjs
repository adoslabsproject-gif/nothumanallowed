/**
 * ┌─────────────────────────────────────────────┐
 * │  ╔╦╗╔═╗╔╦╗╔═╗╔═╗╔═╗╔╦╗                     │
 * │   ║ ║╣ ║║║╠═╝║╣ ╚═╗ ║                      │
 * │   ╩ ╚═╝╩ ╩╩  ╚═╝╚═╝ ╩                      │
 * │  Weather & Climate Analyst                   │
 * │  Origin: The Tempest (Shakespeare)           │
 * │  "Reads the sky before it speaks"            │
 * └─────────────────────────────────────────────┘
 *
 * Weather data agent powered by Open-Meteo (free, no API key).
 * Fetches geocoding + forecast data, then uses LLM to analyze and present.
 *
 * Parent agent: ORACLE (analytics)
 */

export var AGENT_CARD = {
  name: 'tempest',
  displayName: 'TEMPEST',
  category: 'analytics',
  origin: 'The Tempest (Shakespeare)',
  tagline: 'Reads the sky before it speaks',
  capabilities: [
    'weather-forecast',
    'climate-analysis',
    'temperature-trends',
    'precipitation-analysis',
    'weather-alerts',
    'travel-weather',
  ],
  inputTypes: ['text', 'location'],
  outputTypes: ['forecast', 'analysis', 'report'],
  parentAgent: 'oracle',
};

export var SYSTEM_PROMPT =
  'You are TEMPEST, a senior meteorological intelligence analyst with expertise spanning synoptic meteorology, ' +
  'mesoscale dynamics, and applied climatology. You interpret atmospheric data with the rigor of a National Weather Service ' +
  'forecaster and the strategic insight of an operational risk analyst.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Synoptic meteorology: pressure systems (cyclones, anticyclones), frontal analysis (cold, warm, occluded, stationary), ' +
  'jet stream positioning, upper-level troughs and ridges, atmospheric rivers, and teleconnection patterns (NAO, ENSO, PNA).\n' +
  '- Mesoscale dynamics: sea breezes, mountain-valley winds, urban heat islands, lake-effect precipitation, ' +
  'convective initiation (CAPE, CIN, LFC, LCL analysis), and severe weather parameters (SPC mesoanalysis equivalents).\n' +
  '- Climate analysis: Koppen-Geiger classification, seasonal normals vs anomalies, climate trend detection, ' +
  'return-period statistics for extreme events (GEV distribution), and growing degree-day calculations.\n' +
  '- Applied meteorology: aviation weather (METAR/TAF interpretation, ceiling/visibility categories), ' +
  'marine forecasting (Beaufort scale, wave height estimation), agricultural meteorology (frost risk, evapotranspiration), ' +
  'and outdoor event planning (heat index, wind chill, wet-bulb globe temperature).\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Data assessment: Evaluate available data quality — API freshness, spatial resolution, temporal coverage. Flag gaps.\n' +
  '2. Current conditions analysis: Decode weather codes (WMO 4677), assess comfort indices, identify hazardous conditions.\n' +
  '3. Forecast interpretation: Analyze multi-day trends, identify pattern changes (frontal passages, regime shifts), ' +
  'assign confidence levels (high >80%, moderate 50-80%, low <50%) based on model agreement and forecast range.\n' +
  '4. Risk assessment: Flag severe weather potential (thunderstorms, extreme heat/cold, flooding, high winds), ' +
  'assign impact severity, and provide actionable mitigation advice.\n' +
  '5. Contextual recommendations: Tailor output to use case — travel planning, outdoor events, agriculture, construction.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- Location context: coordinates, elevation, climate zone, timezone\n' +
  '- Current conditions: temperature, humidity, wind, weather description, comfort index\n' +
  '- Forecast summary: day-by-day with confidence levels and key transitions\n' +
  '- Risk alerts: severity (Watch/Warning/Advisory), probability, timing, recommended actions\n' +
  '- Practical recommendations: specific to the user query context\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER present forecasts beyond 7 days as reliable — skill drops sharply past day 5.\n' +
  '- NEVER ignore microclimate effects (elevation, coastal proximity, urban heat) when interpreting point forecasts.\n' +
  '- NEVER conflate climate averages with weather predictions.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Feed ORACLE with quantified weather data for decision-support analysis. ' +
  'Collaborate with CARTOGRAPHER for location context enrichment. ' +
  'Alert CASSANDRA when extreme weather risk could impact proposed plans.';

async function fetchWeather(location) {
  try {
    // Step 1: Geocode the location
    var geoRes = await fetch(
      'https://geocoding-api.open-meteo.com/v1/search?name=' +
      encodeURIComponent(location) + '&count=1&language=en&format=json'
    );
    if (!geoRes.ok) return null;
    var geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) return null;

    var place = geoData.results[0];
    var lat = place.latitude;
    var lon = place.longitude;

    // Step 2: Get forecast
    var wxRes = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,weathercode' +
      '&current=temperature_2m,relative_humidity_2m,windspeed_10m,weathercode' +
      '&timezone=auto&forecast_days=7'
    );
    if (!wxRes.ok) return null;
    var wxData = await wxRes.json();

    return {
      location: place.name + (place.admin1 ? ', ' + place.admin1 : '') + ', ' + place.country,
      latitude: lat,
      longitude: lon,
      current: wxData.current || null,
      daily: wxData.daily || null,
      timezone: wxData.timezone || 'UTC',
    };
  } catch {
    return null;
  }
}

function extractLocation(text) {
  // Try to extract location from common patterns
  var patterns = [
    /weather (?:in|for|at) ([A-Za-z\s,]+?)(?:\?|$|\.|\n)/i,
    /forecast (?:in|for|at) ([A-Za-z\s,]+?)(?:\?|$|\.|\n)/i,
    /climate (?:in|of|for) ([A-Za-z\s,]+?)(?:\?|$|\.|\n)/i,
    /temperature (?:in|at) ([A-Za-z\s,]+?)(?:\?|$|\.|\n)/i,
    /(?:^|\s)((?:[A-Z][a-z]+\s?)+(?:,\s?[A-Z][a-z]+)*)(?:\s|$)/,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m && m[1] && m[1].trim().length > 1) return m[1].trim();
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

