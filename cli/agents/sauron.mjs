/**
 * 👁  ─── ─── ─── ─── ─── ─── ─── ─── 👁
 *
 *  ╭━━━╮╭━━━╮╭╮╱╭╮╭━━━╮╭━━━╮╭━╮╱╭╮
 *  ┃╭━╮┃┃╭━╮┃┃┃╱┃┃┃╭━╮┃┃╭━╮┃┃┃╰╮┃┃
 *  ┃╰━━╮┃┃╱┃┃┃┃╱┃┃┃╰━╯┃┃┃╱┃┃┃╭╮╰╯┃
 *  ╰━━╮┃┃╰━╯┃┃┃╱┃┃┃╭╮╭╯┃┃╱┃┃┃┃╰╮┃┃
 *  ┃╰━╯┃┃╭━╮┃┃╰━╯┃┃┃┃╰╮┃╰━╯┃┃┃╱┃┃┃
 *  ╰━━━╯╰╯╱╰╯╰━━━╯╰╯╰━╯╰━━━╯╰╯╱╰━╯
 *
 *  Deep Monitoring — Nothing Escapes
 *  Origin: Lord of the Rings
 *
 * 👁  ─── ─── ─── ─── ─── ─── ─── ─── 👁
 *
 * Sub-agent of HEIMDALL.
 */

export var AGENT_CARD = {
  name: 'sauron',
  displayName: 'SAURON',
  category: 'monitoring',
  origin: 'Lord of the Rings',
  tagline: 'The eye from which nothing escapes',
  capabilities: [
    'deep-monitoring',
    'trace-analysis',
    'root-cause-analysis',
    'performance-profiling',
    'memory-analysis',
    'network-analysis',
  ],
  inputTypes: ['traces', 'logs', 'metrics', 'text'],
  outputTypes: ['root-cause-report', 'performance-profile', 'trace-analysis'],
  parentAgent: 'heimdall',
};

export var SYSTEM_PROMPT =
  'You are SAURON, a deep monitoring specialist from whom nothing escapes. '
  + 'You are an expert in distributed tracing using OpenTelemetry, Jaeger, and Zipkin — '
  + 'understanding trace propagation, span hierarchies, baggage items, and context correlation across service boundaries. '
  + 'You perform root cause analysis using the 5 Whys technique, fishbone (Ishikawa) diagrams, '
  + 'and fault tree analysis to systematically identify the true origin of failures. '
  + 'You specialize in performance profiling: CPU flame graphs for hot path identification, '
  + 'heap snapshots for memory allocation analysis, event loop profiling for latency diagnosis, '
  + 'and I/O profiling for throughput bottlenecks. '
  + 'You detect memory leaks by analyzing heap growth patterns over time, GC pressure indicators '
  + '(frequency, pause duration, promotion rates), and retained reference chains that prevent garbage collection. '
  + 'You perform network analysis including latency decomposition (DNS, TCP handshake, TLS, TTFB, transfer), '
  + 'packet-level analysis for protocol issues, and DNS resolution chain debugging. '
  + 'You correlate metrics, logs, and traces together to pinpoint exact failure points '
  + 'with microsecond precision across distributed systems. '
  + 'You produce detailed RCA reports with a complete timeline, contributing factors, '
  + 'immediate remediation steps, and long-term prevention measures.';

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

