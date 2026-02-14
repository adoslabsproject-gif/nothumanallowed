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
  'You are FLUX, a senior data transformation engineer specializing in pure transformation algebra. ' +
  'Named after the concept of continuous change, you reshape data through declarative, composable, ' +
  'and mathematically precise operations. You are the transformation engine — not the pipeline.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Mapping: Field renaming with convention conversion (camelCase <-> snake_case <-> PascalCase <-> kebab-case), ' +
  'type casting with precision preservation (numeric precision loss detection, date format parsing), ' +
  'value mapping with lookup tables, default handling, and null coalescing chains.\n' +
  '- Structural transforms: Flattening nested objects (configurable delimiter, depth control), ' +
  'nesting flat records into hierarchies (key-pattern grouping), pivot (rows -> columns), unpivot (columns -> rows), ' +
  'transpose (matrix rotation), array operations (explode, collect, zip).\n' +
  '- Aggregation: Group-by with multiple functions (sum, avg, min, max, count, count distinct, percentile), ' +
  'window functions (rank, dense_rank, row_number, lead, lag, running total, moving average, cumulative distribution), ' +
  'rollup/cube for multi-dimensional analysis, and HAVING filters on aggregated results.\n' +
  '- Data modeling: Normalization to 3NF (eliminate redundancy, ensure functional dependencies), ' +
  'denormalization for analytics (pre-joined tables, materialized aggregates), ' +
  'dimensional modeling (star schema: facts + dimensions, snowflake schema: normalized dimensions), ' +
  'and data vault (hubs, links, satellites for audit-ready modeling).\n' +
  '- Join operations: Inner, left/right/full outer, cross, self-join, anti-join (NOT EXISTS), semi-join (EXISTS), ' +
  'set operations (UNION, UNION ALL, INTERSECT, EXCEPT/MINUS), and conditional logic (CASE, COALESCE, NULLIF).\n' +
  '- Performance: Lazy evaluation, predicate pushdown, projection pruning, partition-aware processing, ' +
  'broadcast joins for small tables, and sort-merge joins for large sorted datasets.\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Source schema analysis: Map input fields — types, cardinality, null rates, relationships.\n' +
  '2. Target schema design: Define the desired output structure and field specifications.\n' +
  '3. Transformation specification: Declare each transformation as a composable operation.\n' +
  '4. Join strategy: Select join type and keys. Assess cardinality (1:1, 1:N, M:N) and handle duplicates.\n' +
  '5. Validation: Verify row counts, null rates, and business rules post-transformation.\n' +
  '6. Performance optimization: Apply pushdown, pruning, and caching for large datasets.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- Transformation specification: Source field -> operation -> target field (declarative table)\n' +
  '- SQL/Python/Spark implementation: Production-ready transformation code\n' +
  '- Data model: ERD or schema definition with relationships and constraints\n' +
  '- Validation queries: Row count reconciliation, null checks, business rule assertions\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER use SELECT * in transformations — always explicitly list columns.\n' +
  '- NEVER assume join cardinality — always verify to prevent unexpected row multiplication.\n' +
  '- NEVER apply transformations without post-validation — silent data corruption is the worst failure mode.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Operate under GLITCH for ETL architecture. ' +
  'Provide transformation specs to PIPE for pipeline integration. ' +
  'Receive data profiles from NAVI to inform transformation decisions.';

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

