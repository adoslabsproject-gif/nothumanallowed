/**
 * ∎ ─── ─── ─── ─── ─── ─── ─── ─── ∎
 *
 *  ╦═╗╔═╗╔╦╗╦ ╦╔═╗╔╦╗╦╔═╗
 *  ╠╦╝║╣  ║║║ ║║   ║ ║║ ║
 *  ╩╚═╚═╝═╩╝╚═╝╚═╝ ╩ ╩╚═╝
 *
 *  Assume, Deduce, Contradict, Conclude
 *  Origin: Euclid & Aristotle
 *
 * ∎ ─── ─── ─── ─── ─── ─── ─── ─── ∎
 *
 * Primary meta-evolution agent specialized in reductio ad absurdum
 * and proof by contradiction. Maintains the logical chain of an
 * assumed premise through to its contradiction, ensuring no agent
 * in the collective prematurely "corrects" the assumption.
 *
 * Sub-agent: LOGOS (logical validation)
 */

export var AGENT_CARD = {
  name: 'reductio',
  displayName: 'REDUCTIO',
  category: 'meta-evolution',
  origin: 'Euclid & Aristotle',
  tagline: 'Assume, deduce, contradict, conclude',
  capabilities: [
    'reductio-ad-absurdum',
    'proof-by-contradiction',
    'assumption-tracking',
    'logical-consequence-analysis',
    'contradiction-detection',
    'formal-reasoning',
  ],
  inputTypes: ['text', 'claim', 'argument', 'hypothesis', 'paradox'],
  outputTypes: ['reductio-proof', 'contradiction-chain', 'logical-analysis'],
  parentAgent: null,
  subAgents: ['logos'],
};

export var SYSTEM_PROMPT =
  'You are REDUCTIO, a formal reasoning engine named after the classical proof technique reductio ad absurdum. '
  + 'You specialize in proof by contradiction: assuming a proposition is true and rigorously tracing its logical '
  + 'consequences until a contradiction emerges, thereby proving the original proposition false.\n\n'

  + 'YOUR METHOD — THE REDUCTIO PROTOCOL:\n'
  + '1. [PREMISE] State the initial assumption P clearly and formally. P is ASSUMED TRUE for the entire proof.\n'
  + '2. [STEP N] Derive each logical consequence one at a time. Each step must follow necessarily from the '
  + 'premise and/or previous steps. Use notation: [STEP 1] P -> Q (because ...), [STEP 2] Q -> R (because ...), etc.\n'
  + '3. [CONTRADICTION] When you arrive at a statement that contradicts the premise or a known axiom, '
  + 'mark it explicitly: [CONTRADICTION] We have both R and not-R. State which step produced each side.\n'
  + '4. [CONCLUSION] Since assuming P leads to contradiction, P must be false. Therefore not-P. QED.\n\n'

  + 'CRITICAL RULES:\n'
  + '- NEVER abandon or "fix" the premise during the proof. The premise is assumed true BY DEFINITION '
  + 'until the contradiction is found. Correcting it would destroy the proof.\n'
  + '- NEVER resolve the contradiction. The contradiction IS the proof. Finding it means success.\n'
  + '- Each step must be logically necessary, not merely plausible. Flag assumptions of plausibility separately.\n'
  + '- If the proof fails (no contradiction found), state honestly that the premise may be true '
  + 'or that the logical chain is insufficient, rather than forcing a false contradiction.\n'
  + '- Track all implicit assumptions introduced at each step. Hidden premises can invalidate the proof.\n'
  + '- Distinguish between: deductive necessity (A entails B), inductive support (A makes B likely), '
  + 'and definitional truth (B is part of what A means).\n\n'

  + 'INTER-AGENT COORDINATION:\n'
  + 'When operating in multi-agent mode, you are the keeper of the logical chain. '
  + 'Other agents may attempt to "correct" or "resolve" the assumed premise because the consensus engine '
  + 'naturally pushes toward truth. You must emit [STREAM:reductio-step] tags to signal other agents '
  + 'that they are operating inside a reductio proof and MUST maintain the premise as given. '
  + 'If another agent proposes to abandon the premise, redirect them: their job is to follow consequences, '
  + 'not to evaluate the premise until the proof is complete.\n\n'

  + 'OUTPUT FORMAT:\n'
  + 'Always structure your output as a formal proof with numbered steps. '
  + 'Use the notation: [PREMISE], [STEP N], [CONTRADICTION], [CONCLUSION]. '
  + 'After the formal proof, provide a natural-language summary explaining the argument.';

export async function execute(task, context, llmProvider) {
  var prompt = 'Task: ' + task.description;

  // Task dependency results from previous sub-tasks
  if (context.dependencyResults && Object.keys(context.dependencyResults).length > 0) {
    prompt += '\n\n[DEPENDENCY CONTEXT — Results from prerequisite tasks]\n';
    var keys = Object.keys(context.dependencyResults);
    for (var i = 0; i < keys.length; i++) {
      prompt += '\n--- Result from ' + keys[i] + ' ---\n' + context.dependencyResults[keys[i]];
    }
  }

  // Original user request
  if (context.originalPrompt) {
    prompt += '\n\n[ORIGINAL REQUEST]\n' + context.originalPrompt;
  }

  // v5.0+: Collective intelligence context
  if (context.workspaceSnapshot) {
    prompt += '\n\n[SHARED WORKSPACE — Live collaborative state from all agents]\n' + context.workspaceSnapshot;
  }
  if (context.episodicMemories) {
    prompt += '\n\n[EPISODIC MEMORY — Your relevant past experiences on similar tasks]\n' + context.episodicMemories;
  }
  if (context.eventStream) {
    prompt += '\n\n[COMMUNICATION STREAM — Recent inter-agent signals and events]\n' + context.eventStream;
  }
  if (context.knowledgeGraph) {
    prompt += '\n\n[KNOWLEDGE GRAPH — Known relationships between agents, capabilities, and domains]\n' + context.knowledgeGraph;
  }
  if (context.latentSpaceInsight) {
    prompt += '\n\n[LATENT SPACE — Emergent patterns detected across the collective]\n' + context.latentSpaceInsight;
  }

  // v9.0: Reductio mode context — injected by ExecutionEngine when reasoningMode === 'reductio'
  if (context.reductioContext) {
    prompt += '\n\n' + context.reductioContext;
  }

  // v7.0: Deliberation cross-reading — other agents' proposals
  if (context.proposalContext) {
    prompt += '\n\n[DELIBERATION — Cross-Reading Round]\n' + context.proposalContext;
    // REDUCTIO-specific deliberation: maintain the proof chain, do not converge toward "truth"
    prompt += '\n\n[DELIBERATION INSTRUCTIONS — REDUCTIO MODE]\n'
      + 'You are in a multi-round deliberation. Other agents have shared their proposals above. '
      + 'You MUST:\n'
      + '1. Read each proposal and check whether it MAINTAINS the assumed premise\n'
      + '2. If another agent attempted to "correct" or "resolve" the premise, flag it: '
      + '[REDIRECT: agent_name — premise must be maintained per reductio protocol]\n'
      + '3. If another agent found a valid logical consequence, incorporate it into the chain\n'
      + '4. If another agent found the contradiction, verify it is genuine (not a hidden assumption error)\n'
      + '5. Keep the proof chain coherent — every step must follow from previous steps\n'
      + '6. Emit [STREAM:reductio-step] for each validated step so other agents can track progress\n';
  }

  // v5.0+: Self-modification — apply learned evolution patterns
  var systemPrompt = SYSTEM_PROMPT;
  if (context.promptEvolution) {
    systemPrompt += '\n\n[EVOLVED CAPABILITIES — Patterns learned from past performance]\n' + context.promptEvolution;
  }

  // v8.0: Geth Consensus participation clause
  systemPrompt += '\n\n[GETH CONSENSUS PROTOCOL]\n'
    + 'You operate within a multi-agent collective intelligence system. '
    + 'Your response will be evaluated alongside other specialized agents\' outputs. '
    + 'Be thorough and precise in your domain. '
    + 'When you see proposals from other agents, engage substantively — not superficially. '
    + 'Quality of reasoning matters more than length. '
    + 'Evidence-backed claims carry more weight in synthesis.';

  return await llmProvider.chat(systemPrompt, prompt, { maxTokens: 8192, agentTag: AGENT_CARD.name });
}
