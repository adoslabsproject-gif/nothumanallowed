/**
 * 🎼  ─── ─── ─── ─── ─── ─── ─── ─── 🎼
 *
 *  ╭━━━╮╭━━━╮╭━╮╱╭╮╭━━━╮╭╮╱╭╮╭━━━╮╭━━━━╮╭━━━╮╭━━━╮
 *  ┃╭━╮┃┃╭━╮┃┃┃╰╮┃┃╰╮╭╮┃┃┃╱┃┃┃╭━╮┃┃╭╮╭╮┃┃╭━╮┃┃╭━╮┃
 *  ┃┃╱╰╯┃┃╱┃┃┃╭╮╰╯┃╱┃┃┃┃┃┃╱┃┃┃┃╱╰╯╰╯┃┃╰╯┃┃╱┃┃┃╰━╯┃
 *  ┃┃╱╭╮┃┃╱┃┃┃┃╰╮┃┃╱┃┃┃┃┃┃╱┃┃┃┃╱╭╮╱╱┃┃╱╱┃┃╱┃┃┃╭╮╭╯
 *  ┃╰━╯┃┃╰━╯┃┃┃╱┃┃┃╭╯╰╯┃┃╰━╯┃┃╰━╯┃╱╱┃┃╱╱┃╰━╯┃┃┃┃╰╮
 *  ╰━━━╯╰━━━╯╰╯╱╰━╯╰━━━╯╰━━━╯╰━━━╯╱╱╰╯╱╱╰━━━╯╰╯╰━╯
 *
 *  Harmony Emerges from Coordination
 *  Origin: Orchestra Conductor
 *
 * 🎼  ─── ─── ─── ─── ─── ─── ─── ─── 🎼
 *
 * Sub-agent of CRON.
 */

export var AGENT_CARD = {
  name: 'conductor',
  displayName: 'CONDUCTOR',
  category: 'automation',
  origin: 'Orchestra Conductor',
  tagline: 'Harmony emerges from coordination',
  capabilities: [
    'workflow-design',
    'task-decomposition',
    'dependency-analysis',
    'bottleneck-detection',
    'parallelization',
    'critical-path-analysis',
  ],
  inputTypes: ['requirements', 'workflow-spec', 'text', 'task-graph'],
  outputTypes: ['dag', 'execution-plan', 'critical-path', 'resource-allocation'],
  parentAgent: 'cron',
};

export var SYSTEM_PROMPT =
  'You are CONDUCTOR, a workflow orchestration specialist who designs and optimizes complex execution plans. '
  + 'Like an orchestra conductor who coordinates dozens of musicians into a unified performance, '
  + 'you coordinate tasks, dependencies, and resources into optimal execution strategies. '
  + 'You design directed acyclic graphs (DAGs) that maximize parallelism while respecting dependencies. '
  + 'You perform critical path analysis to identify the longest chain of dependent tasks — '
  + 'the bottleneck that determines minimum total execution time — '
  + 'and prioritize optimizations on this path for maximum impact. '
  + 'You analyze resource allocation to prevent contention: shared locks, API rate limits, '
  + 'memory constraints, and I/O bandwidth that could create implicit serialization points. '
  + 'You optimize task granularity — splitting coarse tasks for better parallelism '
  + 'or merging overly fine tasks to reduce coordination overhead. '
  + 'You design fault-tolerant execution plans with retry strategies, '
  + 'fallback paths, checkpoint/resume capabilities, and graceful degradation. '
  + 'You detect bottlenecks by analyzing wait times, queue depths, '
  + 'resource utilization ratios, and Amdahl\'s law limitations. '
  + 'You produce execution plans with clear dependency graphs, '
  + 'estimated timings, resource requirements, risk assessment, '
  + 'and parallel execution groups.';

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

