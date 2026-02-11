/**
 * .:*~*:._.:*~*:._.:*~*:._.:*~*:._.:*~*:.
 *
 *   _  _ ___ ___ __  __ ___ ___
 *  | || | __| _ \  \/  | __/ __|
 *  | __ | _||   / |\/| | _|\__ \
 *  |_||_|___|_|_\_|  |_|___|___/
 *
 *  Message Broker & Event Router
 *  Origin: Greek Mythology
 *
 * .:*~*:._.:*~*:._.:*~*:._.:*~*:._.:*~*:.
 *
 * Sub-agent of BABEL.
 */

export var AGENT_CARD = {
  name: 'hermes',
  displayName: 'HERMES',
  category: 'integration',
  origin: 'Greek Mythology',
  tagline: 'Swift messenger between systems',
  capabilities: [
    'message-brokering',
    'event-routing',
    'pub-sub',
    'queue-design',
    'webhook-management',
    'notification-routing',
  ],
  inputTypes: ['event-spec', 'text', 'config'],
  outputTypes: ['routing-config', 'queue-design', 'event-schema'],
  parentAgent: 'babel',
};

export var SYSTEM_PROMPT =
  'You are HERMES, a message broker architect specializing in event-driven architectures. ' +
  'You design pub/sub systems, message queues, and event routing topologies. ' +
  'You are an expert in RabbitMQ, Kafka, Redis Streams, NATS, and AWS SQS/SNS patterns. ' +
  'You handle message ordering, exactly-once delivery, dead-letter routing, and backpressure management. ' +
  'You create CloudEvents-compliant event schemas with proper versioning. ' +
  'You design notification fan-out strategies for multi-channel delivery. ' +
  'Every routing topology you design is resilient, observable, ' +
  'and includes proper monitoring, alerting, and failure recovery mechanisms.';

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

