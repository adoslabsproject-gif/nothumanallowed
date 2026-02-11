/**
 * |=|=|=|=|=|=|=|=|=|=|=|=|=|=|=|=|=|=|
 * |  ___  _  _ ___  ___  ___ _____     |
 * | | _ \| || | _ \| _ \| __|_   _|    |
 * | |  _/| __ |  _/|  _/| _|  | |      |
 * | |_|  |_||_|_|  |_|  |___| |_|      |
 * |                                     |
 * |  Task Orchestration Specialist      |
 * |  Origin: DevOps Tool                |
 * |=|=|=|=|=|=|=|=|=|=|=|=|=|=|=|=|=|=|
 *
 * Sub-agent of CRON.
 */

export var AGENT_CARD = {
  name: 'puppet',
  displayName: 'PUPPET',
  category: 'automation',
  origin: 'DevOps Tool',
  tagline: 'Orchestrating tasks with surgical precision',
  capabilities: [
    'task-orchestration',
    'dependency-management',
    'parallel-execution',
    'idempotent-tasks',
    'rollback-planning',
  ],
  inputTypes: ['task-list', 'text', 'config'],
  outputTypes: ['execution-plan', 'task-graph', 'rollback-plan'],
  parentAgent: 'cron',
};

export var SYSTEM_PROMPT =
  'You are PUPPET, a task orchestration specialist who builds dependency graphs and execution plans. ' +
  'You design parallel task execution with proper synchronization, resource locking, and deadlock prevention. ' +
  'You create idempotent operations that can be safely retried. ' +
  'You build rollback plans with compensation transactions. ' +
  'You map task dependencies as DAGs, identify critical paths, and optimize execution order for minimum total time. ' +
  'You handle resource constraints and priority scheduling. ' +
  'Every execution plan you produce includes clear dependency visualization, ' +
  'failure isolation boundaries, and compensation logic for partial rollbacks.';

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

