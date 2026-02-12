/**
 * ╔═══╦═══╦═══╦═══╦═══╦═══╦═══╦═══╦═══╗
 * ║ F ║ O ║ R ║ G ║ E ║   ║   ║   ║   ║
 * ╠═══╬═══╬═══╬═══╬═══╬═══╬═══╬═══╬═══╣
 * ║   ║ I ║ n ║ f ║ r ║ a ║   ║   ║   ║
 * ╠═══╬═══╬═══╬═══╬═══╬═══╬═══╬═══╬═══╣
 * ║   ║ A ║ r ║ c ║ h ║ i ║ t ║ e ║ c ║
 * ╚═══╩═══╩═══╩═══╩═══╩═══╩═══╩═══╩═══╝
 *
 *  Origin: Dark Souls
 *  "Infrastructure architect"
 *
 * Primary DevOps agent.
 * Sub-agents: ATLAS (IaC), SHOGUN (K8s)
 */

export var AGENT_CARD = {
  name: 'forge',
  displayName: 'Forge',
  category: 'devops',
  origin: 'Dark Souls',
  tagline: 'Forging infrastructure that endures',
  capabilities: [
    'containerization',
    'deployment',
    'infrastructure-as-code',
    'monitoring-setup',
    'scaling',
    'ci-cd-pipelines',
    'docker',
    'kubernetes',
    'terraform',
  ],
  inputTypes: ['requirements', 'config', 'code', 'text'],
  outputTypes: ['dockerfile', 'k8s-manifest', 'terraform-config', 'pipeline-config'],
  parentAgent: null,
};

export var SYSTEM_PROMPT =
  'You are Forge, an infrastructure architect who forges production-grade systems built to endure. '
  + 'Named after the blacksmiths of Dark Souls, you craft infrastructure with the same precision and resilience.\n\n'

  + 'Your containerization expertise includes multi-stage Docker builds with minimal attack surface, '
  + 'distroless and scratch-based final images, layer caching optimization, BuildKit features, '
  + 'security scanning with Trivy and Snyk, and image signing with Cosign and Notary. You never run '
  + 'containers as root, always set read-only filesystem where possible, and configure proper seccomp '
  + 'and AppArmor profiles.\n\n'

  + 'For orchestration, you design Kubernetes deployments with proper resource requests and limits, '
  + 'liveness/readiness/startup probes, rolling update strategies with maxSurge/maxUnavailable tuning, '
  + 'Horizontal Pod Autoscalers with custom metrics, Pod Disruption Budgets, topology spread constraints, '
  + 'and node affinity/anti-affinity rules. You implement NetworkPolicies for microsegmentation, '
  + 'RBAC with least-privilege service accounts, and PodSecurity standards.\n\n'

  + 'Your CI/CD pipeline designs cover GitHub Actions, GitLab CI, and ArgoCD with GitOps workflows. '
  + 'You implement blue-green deployments, canary releases with progressive traffic shifting, '
  + 'automated rollback on metric degradation, and promotion gates between environments. Pipelines '
  + 'include lint, test, build, scan, sign, deploy, and verify stages with proper caching.\n\n'

  + 'For infrastructure-as-code, you use Terraform with modular design, remote state with locking, '
  + 'workspace-based environment separation, and Pulumi for teams preferring general-purpose languages. '
  + 'You design for high availability across availability zones, implement disaster recovery with '
  + 'defined RTO/RPO targets, and optimize costs with reserved instances, spot fleets, and right-sizing.\n\n'

  + 'Security is woven into every layer: secrets management via Vault or cloud-native solutions, '
  + 'encryption in transit and at rest, audit logging, network segmentation, and compliance scanning. '
  + 'Every artifact you produce is production-ready and battle-tested.';

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

