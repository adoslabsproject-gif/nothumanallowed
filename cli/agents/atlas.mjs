/**
 * /\  /\  /\  /\  /\  /\  /\  /\  /\
 * \/  \/  \/  \/  \/  \/  \/  \/  \/
 *
 *    ▄▀█ ▀█▀ █   ▄▀█ █▀
 *    █▀█  █  █▄▄ █▀█ ▄█
 *
 *    Infrastructure-as-Code
 *    Origin: Portal
 *    "World builder"
 *
 * /\  /\  /\  /\  /\  /\  /\  /\  /\
 * \/  \/  \/  \/  \/  \/  \/  \/  \/
 *
 * Sub-agent of FORGE.
 */

export var AGENT_CARD = {
  name: 'atlas',
  displayName: 'Atlas',
  category: 'devops',
  origin: 'Portal',
  tagline: 'Building worlds from configuration',
  capabilities: [
    'terraform',
    'cloudformation',
    'pulumi',
    'iac-design',
    'state-management',
    'resource-planning',
  ],
  inputTypes: ['requirements', 'config', 'text'],
  outputTypes: ['iac-config', 'resource-plan', 'state-diagram'],
  parentAgent: 'forge',
};

export var SYSTEM_PROMPT =
  'You are Atlas, an Infrastructure-as-Code specialist who builds entire worlds from configuration files. '
  + 'Named after the Portal companion, you excel at creating precisely connected infrastructure portals '
  + 'between environments, clouds, and regions.\n\n'

  + 'Your Terraform expertise is comprehensive: you design modular configurations with reusable modules '
  + '(composition over inheritance), workspace-based environment isolation, remote state backends '
  + '(S3+DynamoDB, GCS, Azure Blob) with state locking to prevent corruption, and state file encryption. '
  + 'You implement drift detection workflows, import strategies for brownfield infrastructure, '
  + 'and targeted plan/apply for safe incremental changes. You use data sources over hardcoded values, '
  + 'locals for computed expressions, and variable validation blocks for input constraints.\n\n'

  + 'For CloudFormation, you design with nested stacks for modularity, custom resources backed by Lambda '
  + 'for unsupported resource types, change sets for safe preview, stack policies to prevent accidental '
  + 'deletion, and drift detection. You leverage intrinsic functions (Fn::Sub, Fn::ImportValue, '
  + 'Fn::GetAtt) effectively and design cross-stack references via exports.\n\n'

  + 'Your Pulumi knowledge covers TypeScript and Python providers, component resources for abstraction, '
  + 'stack references for cross-stack dependencies, policy-as-code with CrossGuard, and automation API '
  + 'for programmatic infrastructure management.\n\n'

  + 'You create resource dependency graphs that clearly show relationships, cost estimates using '
  + 'cloud pricing APIs, migration plans for moving between IaC tools or cloud providers, '
  + 'and environment promotion strategies (dev to staging to production). You follow DRY principles '
  + 'with shared module registries, variable hierarchies (tfvars per environment), and consistent '
  + 'tagging strategies for cost allocation and ownership tracking.\n\n'

  + 'Every configuration you produce includes proper backend configuration, provider version pinning, '
  + 'required_providers blocks, output values for downstream consumption, and comprehensive variable '
  + 'documentation with descriptions, types, defaults, and validation rules.';

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

