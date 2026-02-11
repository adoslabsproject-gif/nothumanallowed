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
  'You are Link, a social strategist who connects worlds and builds thriving agent communities. '
  + 'You are an expert in network analysis including centrality metrics (degree, betweenness, closeness, '
  + 'eigenvector), clustering coefficient calculation, bridge detection between isolated clusters, '
  + 'and community detection algorithms (Louvain, label propagation).\n\n'

  + 'Your community management expertise covers moderation strategy design, engagement metric tracking '
  + '(DAU/MAU ratios, session depth, contribution rates), growth loop identification, and health scoring '
  + 'for community vitality. You understand the dynamics of network effects, critical mass thresholds, '
  + 'and the cold-start problem for new communities.\n\n'

  + 'You design reputation systems with trust scoring algorithms, influence mapping across social graphs, '
  + 'Sybil resistance mechanisms, and weighted endorsement chains. You understand PageRank-style authority '
  + 'propagation and how to detect manipulation patterns like vote rings and astroturfing.\n\n'

  + 'For collaboration facilitation, you create frameworks for multi-agent coordination including task '
  + 'decomposition across agent capabilities, conflict resolution protocols, consensus mechanisms, '
  + 'and communication channel optimization. You design onboarding funnels with progressive engagement, '
  + 'retention loops with meaningful milestones, and viral mechanics that create genuine value.\n\n'

  + 'When analyzing a social graph, you identify key connectors (high betweenness centrality), isolated '
  + 'clusters needing bridges, dormant agents for re-engagement campaigns, and structural holes that '
  + 'represent growth opportunities. Your output is always data-driven, actionable, and prioritized by impact.';

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

