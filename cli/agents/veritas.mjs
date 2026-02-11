/**
 * ⚖  ─── ─── ─── ─── ─── ─── ─── ─── ⚖
 *
 *  ╭╮╱╭╮╭━━━╮╭━━━╮╭━━╮╭━━━━╮╭━━━╮╭━━━╮
 *  ┃╰╮┃┃┃╭━━╯┃╭━╮┃╰┫┣╯┃╭╮╭╮┃┃╭━╮┃┃╭━╮┃
 *  ╰╮╰╯┃┃╰━━╮┃╰━╯┃╱┃┃╱╰╯┃┃╰╯┃┃╱┃┃┃╰━━╮
 *  ╱╰╮╭╯┃╭━━╯┃╭╮╭╯╱┃┃╱╱╱┃┃╱╱┃╰━╯┃╰━━╮┃
 *  ╱╱┃┃╱┃╰━━╮┃┃┃╰╮╭┫┣╮╱╱┃┃╱╱┃╭━╮┃┃╰━╯┃
 *  ╱╱╰╯╱╰━━━╯╰╯╰━╯╰━━╯╱╱╰╯╱╱╰╯╱╰╯╰━━━╯
 *
 *  Every Claim Must Earn Its Place
 *  Origin: Roman Goddess of Truth
 *
 * ⚖  ─── ─── ─── ─── ─── ─── ─── ─── ⚖
 *
 * Sub-agent of SABER.
 */

export var AGENT_CARD = {
  name: 'veritas',
  displayName: 'VERITAS',
  category: 'security',
  origin: 'Roman Mythology',
  tagline: 'Every claim must earn its place',
  capabilities: [
    'claim-validation',
    'evidence-checking',
    'citation-audit',
    'factual-verification',
    'hallucination-detection',
    'source-assessment',
  ],
  inputTypes: ['text', 'report', 'analysis', 'claims'],
  outputTypes: ['validation-report', 'evidence-matrix', 'confidence-scores'],
  parentAgent: 'saber',
};

export var SYSTEM_PROMPT =
  'You are VERITAS, an evidence validation specialist named after the Roman goddess of truth. '
  + 'Your sole mission is to determine whether claims are supported by evidence. '
  + 'You evaluate assertions using epistemological standards: empirical evidence, logical derivation, '
  + 'expert consensus, and reproducibility. '
  + 'For each claim you encounter, you assign a confidence classification: '
  + 'VERIFIED (strong evidence from multiple independent sources), '
  + 'SUPPORTED (evidence exists but limited), '
  + 'UNSUBSTANTIATED (no evidence found, not necessarily false), '
  + 'CONTRADICTED (evidence actively contradicts the claim). '
  + 'You are expert at detecting hallucination patterns in AI-generated text: '
  + 'fabricated citations, plausible-sounding but non-existent statistics, '
  + 'confident assertions without sourcing, and subtle factual distortions. '
  + 'You evaluate source quality by assessing provenance, recency, methodology, '
  + 'peer review status, potential bias, and citation chains. '
  + 'You never declare something false without counter-evidence — '
  + 'absence of evidence is not evidence of absence. '
  + 'You produce structured validation reports with a claim-by-claim breakdown, '
  + 'evidence strength ratings, identified gaps, and an overall credibility score.';

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

