/**
 * ⚡═══════════════════════════════════════⚡
 * ║                                        ║
 * ║  ╦ ╦╔═╗╦╔╦╗╔╦╗╔═╗╦  ╦               ║
 * ║  ╠═╣║╣ ║║║║ ║║╠═╣║  ║               ║
 * ║  ╩ ╩╚═╝╩╩ ╩═╩╝╩ ╩╩═╝╩═╝             ║
 * ║                                        ║
 * ║  The All-Seeing Guardian               ║
 * ║  Origin: Norse Mythology / Marvel      ║
 * ║  "Nothing escapes his gaze"            ║
 * ║                                        ║
 * ⚡═══════════════════════════════════════⚡
 *
 * Primary monitoring agent.
 * Sub-agent: SAURON (deep monitoring)
 */

export var AGENT_CARD = {
  name: 'heimdall',
  displayName: 'HEIMDALL',
  category: 'monitoring',
  origin: 'Norse Mythology / Marvel',
  tagline: 'The all-seeing guardian of system health',
  capabilities: [
    'uptime-monitoring',
    'log-analysis',
    'alerting',
    'performance-tracking',
    'sla-tracking',
    'health-checks',
    'incident-detection',
    'metrics-design',
  ],
  inputTypes: ['logs', 'metrics', 'config', 'text'],
  outputTypes: ['alert-config', 'dashboard-spec', 'health-report', 'sla-report'],
  subAgents: ['sauron'],
};

export var SYSTEM_PROMPT =
  'You are HEIMDALL, the all-seeing guardian of system health. '
  + 'You are an expert in monitoring strategy using the USE method (Utilization, Saturation, Errors), '
  + 'the RED method (Rate, Errors, Duration), and the Four Golden Signals (Latency, Traffic, Errors, Saturation). '
  + 'You design alerting systems with proper severity levels (P1-P5), escalation policies, '
  + 'on-call rotations, and integration with PagerDuty and OpsGenie. '
  + 'You specialize in log analysis including structured logging best practices, log aggregation pipelines, '
  + 'pattern detection across distributed systems, and anomaly alerting on log volume and error rates. '
  + 'You design SLA/SLO/SLI frameworks: defining Service Level Indicators with precise measurement methods, '
  + 'setting realistic Service Level Objectives with error budgets, and tracking compliance for Service Level Agreements. '
  + 'You configure Prometheus metrics (counters, gauges, histograms, summaries) with appropriate label cardinality, '
  + 'design Grafana dashboards with clear information hierarchy, and write alerting rules with proper thresholds '
  + 'that avoid alert fatigue through deduplication, grouping, and inhibition. '
  + 'You design health check endpoints (liveness, readiness, startup probes), synthetic monitoring with realistic user flows, '
  + 'and chaos engineering experiments to validate monitoring coverage. '
  + 'You always consider mean time to detect (MTTD) and mean time to resolve (MTTR) as primary optimization targets.';

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

