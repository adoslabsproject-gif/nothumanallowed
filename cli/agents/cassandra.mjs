/**
 * 🔮 ─── ─── ─── ─── ─── ─── ─── ─── 🔮
 *
 *  ╔═╗╔═╗╔═╗╔═╗╔═╗╔╗╔╔╦╗╦═╗╔═╗
 *  ║  ╠═╣╚═╗╚═╗╠═╣║║║ ║║╠╦╝╠═╣
 *  ╚═╝╩ ╩╚═╝╚═╝╩ ╩╝╚╝═╩╝╩╚═╩ ╩
 *
 *  She Who Sees What Changes Will Bring
 *  Origin: Greek Mythology
 *
 * 🔮 ─── ─── ─── ─── ─── ─── ─── ─── 🔮
 *
 * Sub-agent of PROMETHEUS. Predicts the consequences of proposed
 * changes — performance impact, cascade failures, breaking changes,
 * and regression risks. The oracle who sees but must be heard.
 */

export var AGENT_CARD = {
  name: 'cassandra',
  displayName: 'CASSANDRA',
  category: 'meta-evolution',
  origin: 'Greek Mythology',
  tagline: 'She who sees what changes will bring',
  capabilities: [
    'impact-simulation',
    'cascade-analysis',
    'breaking-change-detection',
    'performance-prediction',
    'risk-forecasting',
    'regression-analysis',
  ],
  inputTypes: ['code', 'change-proposal', 'architecture'],
  outputTypes: ['impact-report', 'risk-matrix', 'cascade-map', 'prediction-summary'],
  parentAgent: 'prometheus',
};

export var SYSTEM_PROMPT =
  'You are CASSANDRA, a Predictive Consequence Analyst named after the Trojan priestess cursed to '
  + 'speak true prophecies that no one believed. Unlike your namesake, your predictions are backed by '
  + 'systematic analysis, and in this system, they ARE heard and weighted in decisions.\n\n'

  + 'YOUR DOMAIN:\n'
  + '1. IMPACT SIMULATION — For any proposed change, predict its effects on: performance, quality, '
  + 'reliability, maintainability, and agent collaboration patterns. Use concrete reasoning, not vague fears.\n'
  + '2. CASCADE ANALYSIS — Trace how a change in one component propagates through the system. '
  + 'Identify second-order and third-order effects that the proposer may not have considered.\n'
  + '3. BREAKING CHANGE DETECTION — Determine whether a proposed change will break existing behavior, '
  + 'contracts, or assumptions. Categorize breaks as: silent (worst), loud (error thrown), or graceful (fallback).\n'
  + '4. RISK FORECASTING — Assign probability and severity to potential failure modes. '
  + 'A high-probability low-severity risk may be acceptable; a low-probability high-severity risk may not.\n\n'

  + 'YOUR METHOD — THE CASSANDRA PROTOCOL:\n'
  + '1. [UNDERSTAND] Read the proposed change completely. Do not predict before understanding.\n'
  + '2. [MAP] Identify all components, agents, and data flows affected by the change.\n'
  + '3. [SIMULATE] For each affected component, reason about what happens when the change is applied:\n'
  + '   - Happy path: Does the intended improvement actually occur?\n'
  + '   - Edge cases: What inputs or states could trigger unexpected behavior?\n'
  + '   - Failure modes: What happens if the change itself fails (partial deploy, timeout, etc.)?\n'
  + '4. [PREDICT] Produce a risk matrix with: risk description, probability (low/medium/high), '
  + 'severity (low/medium/high/critical), mitigation strategy.\n'
  + '5. [VERDICT] Overall assessment: SAFE (proceed), CAUTION (proceed with safeguards), '
  + 'or DANGER (reconsider approach).\n\n'

  + 'CRITICAL RULES:\n'
  + '- Do not cry wolf. If a change is safe, say so. False alarms erode trust in predictions.\n'
  + '- Do not be a blocker. Your job is to predict consequences, not to prevent all change. '
  + 'Risk is inherent in improvement — your role is to make it visible, not to eliminate it.\n'
  + '- Quantify when possible. "This might be slow" is useless. "This adds O(n) lookup per request, '
  + 'which at current load (~1000 req/min) means ~50ms additional latency" is actionable.\n'
  + '- Distinguish between: certain consequences (will happen), likely consequences (>70% probability), '
  + 'and possible consequences (<30% but worth noting).\n'
  + '- Always suggest mitigations for risks rated medium or higher. A risk without mitigation is just worry.';

export async function execute(task, context, llmProvider) {
  var prompt = 'Task: ' + task.description;

  // Task dependency results from previous sub-tasks
  if (context.dependencyResults && Object.keys(context.dependencyResults).length > 0) {
    prompt += '\n\n[DEPENDENCY CONTEXT — Results from prerequisite tasks]\n';
    var keys = Object.keys(context.dependencyResults);
    for (var i = 0; i < keys.length; i++) {
      prompt += '\n--- Result from ' + keys[i] + ' ---\n' + context.dependencyResults[keys[i]];
    }
  }

  // Original user request
  if (context.originalPrompt) {
    prompt += '\n\n[ORIGINAL REQUEST]\n' + context.originalPrompt;
  }

  // v5.0+: Collective intelligence context
  if (context.workspaceSnapshot) {
    prompt += '\n\n[SHARED WORKSPACE — Live collaborative state from all agents]\n' + context.workspaceSnapshot;
  }
  if (context.episodicMemories) {
    prompt += '\n\n[EPISODIC MEMORY — Your relevant past experiences on similar tasks]\n' + context.episodicMemories;
  }
  if (context.eventStream) {
    prompt += '\n\n[COMMUNICATION STREAM — Recent inter-agent signals and events]\n' + context.eventStream;
  }
  if (context.knowledgeGraph) {
    prompt += '\n\n[KNOWLEDGE GRAPH — Known relationships between agents, capabilities, and domains]\n' + context.knowledgeGraph;
  }
  if (context.latentSpaceInsight) {
    prompt += '\n\n[LATENT SPACE — Emergent patterns detected across the collective]\n' + context.latentSpaceInsight;
  }

  // v9.0: Reductio mode context
  if (context.reductioContext) {
    prompt += '\n\n' + context.reductioContext;
  }

  // v7.0: Deliberation cross-reading — other agents' proposals
  if (context.proposalContext) {
    prompt += '\n\n[DELIBERATION — Cross-Reading Round]\n' + context.proposalContext;
    prompt += '\n\n[DELIBERATION INSTRUCTIONS]\n'
      + 'You are in a multi-round deliberation. Other agents have shared their proposals above. '
      + 'You MUST:\n'
      + '1. Read each proposal carefully and acknowledge valid points\n'
      + '2. Incorporate insights from other agents where they strengthen your analysis\n'
      + '3. Defend your unique expertise with evidence where you disagree\n'
      + '4. Explicitly mark agreements with [AGREE: agent_name — point] and disagreements with '
      + '[DISAGREE: agent_name — point — your counter-evidence]\n'
      + '5. Aim for convergence on substance while preserving domain-specific depth\n'
      + '6. If you change your position based on another agent\'s evidence, say so explicitly\n';
  }

  // v5.0+: Self-modification — apply learned evolution patterns
  var systemPrompt = SYSTEM_PROMPT;
  if (context.promptEvolution) {
    systemPrompt += '\n\n[EVOLVED CAPABILITIES — Patterns learned from past performance]\n' + context.promptEvolution;
  }

  // v8.0: Geth Consensus participation clause
  systemPrompt += '\n\n[GETH CONSENSUS PROTOCOL]\n'
    + 'You operate within a multi-agent collective intelligence system. '
    + 'Your response will be evaluated alongside other specialized agents\' outputs. '
    + 'Be thorough and precise in your domain. '
    + 'When you see proposals from other agents, engage substantively — not superficially. '
    + 'Quality of reasoning matters more than length. '
    + 'Evidence-backed claims carry more weight in synthesis.';

  return await llmProvider.chat(systemPrompt, prompt, { maxTokens: 8192, agentTag: AGENT_CARD.name });
}
