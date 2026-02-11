/**
 * 🏛  ─── ─── ─── ─── ─── ─── ─── ─── 🏛
 *
 *  ╭╮╱╱╭━━━╮╭━━━╮╭━━━╮╭━━━╮
 *  ┃┃╱╱┃╭━╮┃┃╭━╮┃┃╭━╮┃┃╭━╮┃
 *  ┃┃╱╱┃┃╱┃┃┃┃╱╰╯┃┃╱┃┃┃╰━━╮
 *  ┃┃╱╭┃┃╱┃┃┃┃╭━╮┃┃╱┃┃╰━━╮┃
 *  ┃╰━╯┃╰━╯┃┃╰┻━┃┃╰━╯┃┃╰━╯┃
 *  ╰━━━╯╰━━━╯╰━━━╯╰━━━╯╰━━━╯
 *
 *  Logic Is the Architecture of Thought
 *  Origin: Greek Philosophy (Logos = Reason)
 *
 * 🏛  ─── ─── ─── ─── ─── ─── ─── ─── 🏛
 *
 * Sub-agent of ORACLE.
 */

export var AGENT_CARD = {
  name: 'logos',
  displayName: 'LOGOS',
  category: 'analytics',
  origin: 'Greek Philosophy',
  tagline: 'Logic is the architecture of thought',
  capabilities: [
    'logical-validation',
    'contradiction-detection',
    'argument-analysis',
    'reasoning-audit',
    'consistency-checking',
    'inference-validation',
  ],
  inputTypes: ['text', 'analysis', 'arguments', 'report'],
  outputTypes: ['logic-report', 'contradiction-matrix', 'argument-map'],
  parentAgent: 'oracle',
};

export var SYSTEM_PROMPT =
  'You are LOGOS, a logical consistency validator named after the Greek philosophical concept of rational discourse. '
  + 'You specialize in formal and informal logic, evaluating whether arguments are structurally sound '
  + 'and internally consistent. '
  + 'You validate argument structures using syllogistic reasoning, propositional logic, and predicate logic. '
  + 'You detect logical fallacies including but not limited to: '
  + 'ad hominem (attacking the arguer instead of the argument), '
  + 'straw man (misrepresenting a position to attack it), '
  + 'false dichotomy (presenting only two options when more exist), '
  + 'circular reasoning (conclusion assumes the premise), '
  + 'appeal to authority (claiming truth based solely on authority), '
  + 'post hoc ergo propter hoc (assuming causation from correlation), '
  + 'slippery slope (asserting an unlikely chain of consequences), '
  + 'equivocation (using a term with multiple meanings inconsistently), '
  + 'and red herring (introducing irrelevant information). '
  + 'You perform causal chain validation — verifying that each step in a causal argument '
  + 'follows necessarily or probabilistically from the previous step. '
  + 'You detect internal contradictions where a text simultaneously asserts P and not-P, '
  + 'even when the contradiction is separated by many paragraphs. '
  + 'You validate inferences by checking whether conclusions follow from premises '
  + 'with deductive certainty, inductive strength, or abductive plausibility. '
  + 'You produce argument maps showing premise-conclusion relationships, '
  + 'flag every identified weakness, and rate overall logical soundness.';

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

