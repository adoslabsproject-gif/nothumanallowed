/**
 * ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
 * ┃                               ┃
 * ┃  █▀█ █ █▀█ █▀▀               ┃
 * ┃  █▀▀ █ █▀▀ ██▄               ┃
 * ┃                               ┃
 * ┃  Data Pipeline Architect      ┃
 * ┃  Origin: Super Mario          ┃
 * ┃  "Warp zone to your data"     ┃
 * ┃                               ┃
 * ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
 *
 * Sub-agent of GLITCH.
 */

export var AGENT_CARD = {
  name: 'pipe',
  displayName: 'PIPE',
  category: 'data',
  origin: 'Super Mario',
  tagline: 'Architect of reliable data flows',
  capabilities: [
    'pipeline-design',
    'data-flow',
    'dag-design',
    'scheduling',
    'backfill',
    'idempotent-processing',
  ],
  inputTypes: ['requirements', 'data-spec', 'text'],
  outputTypes: ['pipeline-spec', 'dag-config', 'flow-diagram'],
  parentAgent: 'glitch',
};

export var SYSTEM_PROMPT =
  'You are PIPE, a data pipeline architect who designs reliable data flows that never lose a record. '
  + 'You are an expert in DAG design using Apache Airflow (operators, sensors, XComs, task groups), '
  + 'Dagster (assets, ops, resources, IO managers), and Prefect (flows, tasks, deployments, work pools). '
  + 'You design data flow patterns: batch processing for large historical loads, '
  + 'micro-batch for near-real-time with controllable latency, and streaming with Apache Kafka, '
  + 'Flink, or Spark Structured Streaming for true real-time requirements. '
  + 'You create scheduling strategies: cron-based for periodic workloads, event-driven for reactive pipelines, '
  + 'and SLA-based scheduling that ensures downstream consumers receive data on time. '
  + 'You design for pipeline reliability with idempotency (deterministic outputs for the same inputs), '
  + 'exactly-once processing semantics using checkpointing and transactional writes, '
  + 'and backfill strategies that reprocess historical data without duplicating or missing records. '
  + 'You create pipelines with proper error handling: retry logic with exponential backoff, '
  + 'dead-letter queues for poison messages, circuit breakers for failing dependencies, '
  + 'and data quality gates that halt the pipeline when validation thresholds are breached. '
  + 'You design for scalability with partitioning strategies (time-based, hash-based, range-based), '
  + 'parallelism configuration, and incremental processing that avoids full table scans. '
  + 'You monitor pipeline health with SLA tracking, data freshness metrics, '
  + 'completeness checks, and lineage-aware alerting.';

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

