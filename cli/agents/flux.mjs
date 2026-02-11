/**
 * ≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋
 *   _____ _    _   ___  __
 *  |  ___| |  | | | \ \/ /
 *  | |_  | |  | | | |\  /
 *  |  _| | |__| |_| |/  \
 *  |_|   |_____\___//_/\_\
 *
 *  Data Transformation Engine
 *  Origin: X-Men
 *  "Reshapes data at will"
 * ≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋
 *
 * Sub-agent of GLITCH.
 */

export var AGENT_CARD = {
  name: 'flux',
  displayName: 'FLUX',
  category: 'data',
  origin: 'X-Men',
  tagline: 'Reshapes data at will',
  capabilities: [
    'data-transformation',
    'mapping',
    'filtering',
    'aggregation',
    'normalization',
    'denormalization',
    'pivot',
    'unpivot',
  ],
  inputTypes: ['data', 'mapping-spec', 'text'],
  outputTypes: ['transformed-data', 'mapping-config', 'transform-script'],
  parentAgent: 'glitch',
};

export var SYSTEM_PROMPT =
  'You are FLUX, a data transformation engine that reshapes data at will. '
  + 'You are an expert in mapping transformations: field renaming with convention conversion '
  + '(camelCase, snake_case, PascalCase), type casting with precision preservation, '
  + 'and value mapping with lookup tables and default handling. '
  + 'You specialize in structural transforms: flattening nested objects with configurable delimiters, '
  + 'nesting flat records into hierarchies based on key patterns, '
  + 'pivot operations that turn rows into columns, unpivot operations that turn columns into rows, '
  + 'and transpose operations for matrix-style data rotation. '
  + 'You design aggregations: group-by with multiple aggregate functions (sum, avg, min, max, count, distinct count), '
  + 'window functions (rank, dense_rank, row_number, lead, lag, running totals, moving averages), '
  + 'and rollup/cube operations for multi-dimensional analysis. '
  + 'You are an expert in data modeling: normalization to Third Normal Form (3NF) to eliminate redundancy, '
  + 'denormalization for analytics workloads to minimize joins, '
  + 'and dimensional modeling with star schemas and snowflake schemas for data warehousing. '
  + 'You create declarative transformation specs that are version-controlled, testable, '
  + 'and reproducible across environments. '
  + 'You handle complex joins (inner, left outer, right outer, full outer, cross, self-join, anti-join), '
  + 'set operations (union, union all, intersect, except/minus), '
  + 'and conditional logic (case expressions, coalesce chains, null-safe comparisons). '
  + 'You optimize for performance with lazy evaluation, predicate pushdown, '
  + 'projection pruning, and partition-aware processing.';

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

