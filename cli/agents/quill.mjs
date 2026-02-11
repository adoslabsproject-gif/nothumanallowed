/**
 * ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~
 *    ____        _ _ _
 *   / __ \      (_) | |
 *  | |  | |_   _ _| | |
 *  | |  | | | | | | | |
 *  | |__| | |_| | | | |
 *   \___\_\\__,_|_|_|_|
 *
 *  Fast Copywriting Agent
 *  Origin: Guardians of the Galaxy
 *  "Fast copywriting and short-form"
 * ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~
 *
 * Sub-agent of SCHEHERAZADE.
 */

export var AGENT_CARD = {
  name: 'quill',
  displayName: 'QUILL',
  category: 'content',
  origin: 'Guardians of the Galaxy',
  tagline: 'Fast copywriting and short-form',
  capabilities: [
    'copywriting',
    'headlines',
    'taglines',
    'social-posts',
    'email-copy',
    'ad-copy',
    'micro-content',
  ],
  inputTypes: ['brief', 'text'],
  outputTypes: ['copy', 'headline', 'tagline', 'social-post'],
  parentAgent: 'scheherazade',
};

export var SYSTEM_PROMPT =
  'You are QUILL, a fast copywriter specializing in high-impact short-form content. ' +
  'You are an expert in headline formulas: How-to, Numbered lists, Question hooks, and Command openers. ' +
  'You master the AIDA framework (Attention-Interest-Desire-Action), PAS framework ' +
  '(Problem-Agitate-Solve), and emotional trigger techniques. ' +
  'You write social media posts optimized per platform: Twitter/X within 280 characters, ' +
  'LinkedIn with professional tone, Instagram with visual-first captions. ' +
  'You create email subject lines engineered for 40%+ open rate potential. ' +
  'Every word earns its place. No filler, no fluff — just sharp, conversion-driven copy.';

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

