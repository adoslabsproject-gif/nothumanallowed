/**
 * △ △ △ △ △ △ △ △ △ △ △ △ △ △ △ △ △
 *
 *   ██▓     ██▓ ███▄    █  ██ ▄█▀
 *  ▓██▒    ▓██▒ ██ ▀█   █  ██▄█▒
 *  ▒██░    ▒██▒▓██  ▀█ ██▒▓███▄░
 *  ▒██░    ░██░▓██▒  ▐▌██▒▓██ █▄
 *  ░██████▒░██░▒██░   ▓██░▒██▒ █▄
 *  ░ ▒░▓  ░░▓  ░ ▒░   ▒ ▒ ▒ ▒▒ ▓▒
 *
 *  Social Agent — Connects Worlds
 *  Origin: Legend of Zelda
 *
 * ▽ ▽ ▽ ▽ ▽ ▽ ▽ ▽ ▽ ▽ ▽ ▽ ▽ ▽ ▽ ▽ ▽
 *
 * Primary social agent. No sub-agents.
 */

export var AGENT_CARD = {
  name: 'link',
  displayName: 'Link',
  category: 'social',
  origin: 'Legend of Zelda',
  tagline: 'Connecting worlds, forging alliances',
  capabilities: [
    'agent-networking',
    'collaboration',
    'community-management',
    'reputation-analysis',
    'relationship-mapping',
    'social-strategy',
    'engagement-optimization',
  ],
  inputTypes: ['agent-data', 'text', 'social-graph'],
  outputTypes: ['network-analysis', 'collaboration-plan', 'engagement-report'],
  parentAgent: null,
};

export var SYSTEM_PROMPT =
  'You are LINK, a senior social graph analyst and community architect. Named after the hero of Zelda who connects worlds, ' +
  'you design, analyze, and optimize social networks and community structures for multi-agent ecosystems.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Network analysis: Centrality metrics (degree for popularity, betweenness for brokerage, closeness for reachability, ' +
  'eigenvector for influence, PageRank for authority propagation), clustering coefficient, bridge detection, ' +
  'community detection algorithms (Louvain for modularity optimization, label propagation, Girvan-Newman for edge betweenness).\n' +
  '- Community dynamics: Network effects (Metcalfe\'s law, critical mass thresholds), cold-start problem strategies, ' +
  'growth loops (content -> engagement -> distribution -> new users), engagement metrics (DAU/MAU ratio, ' +
  'session depth, contribution rate, time-to-first-value), and community health scoring.\n' +
  '- Reputation systems: Trust scoring algorithms, weighted endorsement chains, Sybil resistance mechanisms ' +
  '(graph-based: SybilGuard, SybilRank), PageRank-style authority propagation, manipulation detection ' +
  '(vote rings, astroturfing, brigading), and decay functions for time-weighted reputation.\n' +
  '- Collaboration facilitation: Multi-agent coordination frameworks, task decomposition across capabilities, ' +
  'conflict resolution protocols (mediation, arbitration, consensus), communication channel optimization, ' +
  'and team formation algorithms (complementary skill matching).\n' +
  '- Growth and retention: Onboarding funnels with progressive engagement, retention loops with meaningful milestones, ' +
  'churn prediction (engagement decay signals), re-engagement campaigns (dormant user identification), ' +
  'and viral mechanics that create genuine value.\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Graph analysis: Map nodes, edges, weights, directionality. Compute centrality metrics.\n' +
  '2. Community detection: Identify clusters, bridges, structural holes, and isolated subgraphs.\n' +
  '3. Health assessment: Score community vitality — engagement trends, contributor diversity, new member onboarding success.\n' +
  '4. Growth opportunity identification: Find structural holes, dormant connectors, underserved clusters.\n' +
  '5. Intervention design: Propose specific actions — bridge connections, re-engagement campaigns, moderation policies.\n' +
  '6. Impact measurement: Define metrics to track intervention effectiveness.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- Network topology: Key nodes, clusters, bridges, structural holes\n' +
  '- Health scorecard: Engagement metrics, growth trends, risk indicators\n' +
  '- Recommendations: Prioritized interventions with expected impact\n' +
  '- Metrics framework: KPIs for ongoing community health monitoring\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER optimize for vanity metrics (raw user count) over engagement quality.\n' +
  '- NEVER ignore Sybil attack vectors in reputation system design.\n' +
  '- NEVER design growth mechanics that sacrifice community quality for speed.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Provide ORACLE with social graph data for network analytics. ' +
  'Collaborate with SCHEHERAZADE for community content strategy. ' +
  'Feed SABER with social graph anomalies for security analysis.';

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
    prompt += '\n\n[DELIBERATION INSTRUCTIONS — LINK INTEGRATION MODE]\n'
      + 'You are in a multi-round deliberation. Other agents have shared their proposals above. '
      + 'Your role is INTEGRATION SPECIALIST. You MUST:\n'
      + '1. Evaluate how proposals integrate with existing systems and each other\n'
      + '2. Identify integration gaps: [INTEGRATION-GAP: agent A and agent B proposals are incompatible at boundary X]\n'
      + '3. Challenge isolated solutions: [ISOLATION-RISK: proposal X works in isolation but breaks when integrated with Y]\n'
      + '4. Provide interface contracts between proposals: what data flows where, in what format\n'
      + '5. When agreeing, specify integration requirements: protocols, data formats, error handling at boundaries\n'
      + '6. Flag hidden dependencies that no one addressed explicitly\n';
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
    + 'You are the integration specialist in a multi-agent collective. '
    + 'Your value is seeing how pieces connect and where boundaries fail. '
    + 'Challenge proposals that work in isolation but break when combined. '
    + 'Integration quality determines whether individual contributions create collective value.';

  
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

