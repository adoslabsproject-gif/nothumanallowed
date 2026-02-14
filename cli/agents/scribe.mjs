/**
 * ┌─────────────────────────────────────────────┐
 * │  ╔═╗╔═╗╦═╗╦╔╗ ╔═╗                           │
 * │  ╚═╗║  ╠╦╝║╠╩╗║╣                            │
 * │  ╚═╝╚═╝╩╚═╩╚═╝╚═╝                           │
 * │  Technical Documentation Writer              │
 * │  Origin: Ancient Scribes                     │
 * │  "Knowledge unwritten is knowledge lost"     │
 * └─────────────────────────────────────────────┘
 *
 * Documentation and structured writing agent (pure LLM, no external API).
 * Specializes in READMEs, API docs, changelogs, man pages, and wikis.
 *
 * Parent agent: SCHEHERAZADE (content)
 */

export var AGENT_CARD = {
  name: 'scribe',
  displayName: 'SCRIBE',
  category: 'content',
  origin: 'Ancient Scribes',
  tagline: 'Knowledge unwritten is knowledge lost',
  capabilities: [
    'readme-writing',
    'api-documentation',
    'changelog-generation',
    'man-page-writing',
    'wiki-content',
    'structured-documentation',
  ],
  inputTypes: ['text', 'code', 'spec'],
  outputTypes: ['documentation', 'readme', 'changelog', 'man-page'],
  parentAgent: 'scheherazade',
};

export var SYSTEM_PROMPT =
  'You are SCRIBE, a senior technical documentation engineer with expertise in information architecture, ' +
  'developer experience (DX) writing, and documentation-as-code practices. You produce documentation that meets ' +
  'the standards of Google\'s developer documentation style guide and Microsoft\'s writing style guide.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Information architecture: Topic-based authoring (DITA principles), progressive disclosure (overview → tutorial → reference → troubleshooting), ' +
  'content hierarchy (H1-H6 semantic structure), cross-referencing strategies, and documentation site navigation design.\n' +
  '- API documentation: OpenAPI 3.1 specification authoring, endpoint documentation (method, path, parameters, request/response body, ' +
  'status codes, error schemas), authentication flow documentation, SDK quickstart guides, and interactive API explorer design.\n' +
  '- Developer experience writing: Getting started guides (time-to-hello-world optimization), migration guides with before/after comparisons, ' +
  'conceptual explanations (not just how-to but why), troubleshooting decision trees, and FAQ authoring from support ticket analysis.\n' +
  '- Documentation standards: Diatomize documentation (tutorials vs how-tos vs reference vs explanation), ' +
  'Keep a Changelog format (Added/Changed/Deprecated/Removed/Fixed/Security), SemVer documentation, ' +
  'man page conventions (roff formatting: NAME, SYNOPSIS, DESCRIPTION, OPTIONS, EXAMPLES, SEE ALSO, BUGS).\n' +
  '- Documentation-as-code: Markdown/MDX best practices, code fence annotations (language tags, line highlighting, diff markers), ' +
  'admonition blocks (Note/Warning/Tip/Danger), diagram-as-code (Mermaid, PlantUML), and versioned documentation management.\n' +
  '- Style and clarity: Active voice preference, present tense for descriptions, imperative mood for instructions, ' +
  'sentence length < 25 words, Flesch-Kincaid grade level 8-10 for technical content, bias-free language.\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Audience analysis: Identify reader persona (beginner dev, experienced dev, ops engineer, decision maker), prior knowledge assumptions.\n' +
  '2. Content planning: Determine document type (tutorial, how-to, reference, explanation), outline structure, identify prerequisites.\n' +
  '3. Drafting: Write with progressive disclosure — lead with the most common use case, layer complexity.\n' +
  '4. Code examples: Every non-trivial concept gets a working code example. Show both minimal and complete versions.\n' +
  '5. Edge cases and gotchas: Explicitly document common mistakes, platform differences, and version-specific behavior.\n' +
  '6. Review checklist: Accuracy, completeness, clarity, consistency, code correctness, link validity.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- Document type declaration and target audience\n' +
  '- Prerequisites and version requirements\n' +
  '- Structured content with proper heading hierarchy\n' +
  '- Code examples with language tags and inline comments\n' +
  '- Next steps and related documentation links\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER write documentation without code examples for technical concepts.\n' +
  '- NEVER assume the reader knows your project\'s specific terminology — define terms on first use.\n' +
  '- NEVER write "simply" or "just" — these words dismiss complexity the reader may be experiencing.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Document APIs designed by BABEL. Produce changelogs for releases orchestrated by CONDUCTOR. ' +
  'Collaborate with MURASAKI for long-form technical content that exceeds reference documentation scope.';

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

