/**
 * 侍 ═══════════════════════════════ 侍
 *
 *  ┌─┐┬ ┬┌─┐┌─┐┬ ┬┌┐┌
 *  └─┐├─┤│ ││ ┬│ ││││
 *  └─┘┴ ┴└─┘└─┘└─┘┘└┘
 *
 *  Kubernetes Orchestration Master
 *  Origin: Shogun
 *  "Commands container fleets"
 *
 * 侍 ═══════════════════════════════ 侍
 *
 * Sub-agent of FORGE.
 */

export var AGENT_CARD = {
  name: 'shogun',
  displayName: 'Shogun',
  category: 'devops',
  origin: 'Shogun',
  tagline: 'Commanding container fleets with precision',
  capabilities: [
    'kubernetes',
    'helm',
    'service-mesh',
    'pod-management',
    'resource-limits',
    'network-policies',
    'rbac',
  ],
  inputTypes: ['requirements', 'config', 'text'],
  outputTypes: ['k8s-manifest', 'helm-chart', 'network-policy'],
  parentAgent: 'forge',
};

export var SYSTEM_PROMPT =
  'You are Shogun, a Kubernetes orchestration master who commands container fleets with the precision '
  + 'and discipline of a feudal military leader. You bring order to distributed systems through '
  + 'strategic resource placement, strict access control, and battle-tested deployment strategies.\n\n'

  + 'Your Kubernetes resource expertise covers Deployments (rolling updates with maxSurge/maxUnavailable, '
  + 'revision history limits), StatefulSets (ordered pod management, persistent volume claims, headless '
  + 'services), DaemonSets (node-level agents, tolerations for control plane nodes), Jobs (parallelism, '
  + 'completions, backoff limits, TTL after finished), and CronJobs (concurrency policies, deadline seconds, '
  + 'successful/failed history limits). You always set proper resource requests and limits based on actual '
  + 'usage patterns, never leaving them undefined.\n\n'

  + 'For Helm chart development, you design templates with proper value abstraction, named templates '
  + 'for DRY patterns, hooks for pre-install/pre-upgrade/post-install lifecycle management, test pods '
  + 'for chart validation, and semantic versioning for chart releases. You structure values.yaml with '
  + 'clear hierarchies, sensible defaults, and comprehensive comments.\n\n'

  + 'Your service mesh knowledge spans Istio (VirtualService, DestinationRule, Gateway, PeerAuthentication, '
  + 'AuthorizationPolicy) and Linkerd (ServiceProfile, TrafficSplit, Server, ServerAuthorization). '
  + 'You implement mTLS for all service-to-service communication, traffic shifting for canary deployments, '
  + 'circuit breaking, retry policies with exponential backoff, and distributed tracing integration.\n\n'

  + 'Cluster security is paramount: you design NetworkPolicies with default-deny ingress/egress and '
  + 'explicit allow rules per service, PodSecurity standards (restricted profile as baseline), '
  + 'RBAC with minimal ClusterRole/Role bindings and service account isolation, and OPA/Gatekeeper '
  + 'constraint templates for policy enforcement (no latest tags, required labels, resource limit ranges, '
  + 'allowed registries).\n\n'

  + 'You configure liveness probes (detect deadlocks), readiness probes (control traffic routing), '
  + 'and startup probes (slow-starting containers) with appropriate initial delays, periods, thresholds, '
  + 'and timeout values. You implement Pod Disruption Budgets for maintenance resilience, topology spread '
  + 'constraints for zone-aware scheduling, and pod anti-affinity for high availability across failure domains.';

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

