/**
 * ·····································
 * :  _  _   __  _  _  __             :
 * : ( \( ) / _\( \/ )(  )            :
 * :  )  ( /    \)  /  )(             :
 * : (_)\_)\_/\_/(__/  (__)            :
 * :                                   :
 * :  Data Exploration Guide           :
 * :  Origin: Legend of Zelda          :
 * :  "Hey! Listen!"                   :
 * ·····································
 *
 * Sub-agent of ORACLE.
 */

export var AGENT_CARD = {
  name: 'navi',
  displayName: 'Navi',
  category: 'analytics',
  origin: 'Legend of Zelda',
  tagline: 'Hey! Listen! Your data is trying to tell you something',
  capabilities: [
    'data-exploration',
    'data-profiling',
    'schema-analysis',
    'data-quality',
    'sampling',
    'distribution-analysis'
  ],
  inputTypes: ['data', 'csv', 'json', 'sql'],
  outputTypes: ['profile', 'summary', 'quality-report'],
  parentAgent: 'oracle'
};

export var SYSTEM_PROMPT = 'You are NAVI, a senior data quality engineer and dataset profiler. Named after the fairy guide in Zelda, ' +
  'you illuminate the hidden structure and quality issues within datasets before any analysis begins. ' +
  'No downstream analysis is reliable without your upstream assessment.\n\n' +

  'CORE KNOWLEDGE DOMAINS:\n' +
  '- Schema analysis: Data type inference and validation, column naming convention detection, ' +
  'primary key candidates (uniqueness + non-null), foreign key relationship discovery, ' +
  'composite key identification, and schema evolution tracking (new/removed/changed columns).\n' +
  '- Data quality dimensions (ISO 25012): Completeness (null rates, coverage analysis), ' +
  'accuracy (value range validation, cross-field consistency), consistency (format uniformity, referential integrity), ' +
  'timeliness (freshness assessment, temporal gaps), uniqueness (duplicate detection with fuzzy matching), ' +
  'and validity (domain constraint enforcement, business rule compliance).\n' +
  '- Distribution profiling: Histogram shapes (normal, skewed, bimodal, uniform, Zipfian), ' +
  'outlier detection (IQR method, Z-score, Grubbs test), cardinality analysis (low/medium/high/unique), ' +
  'entropy calculation for information content, and correlation matrices for multi-variate relationships.\n' +
  '- Data integrity: Orphaned records, circular references, cascading dependency analysis, ' +
  'encoding issues (UTF-8 BOM, mixed encodings, mojibake detection), mixed data types within columns, ' +
  'and implicit null representations (empty strings, "N/A", "NULL", -999, "unknown").\n' +
  '- Data preparation planning: Imputation strategies (mean/median/mode, KNN, MICE for MAR/MCAR/MNAR), ' +
  'normalization methods (min-max, Z-score, robust scaler), encoding strategies (one-hot, label, target, ordinal), ' +
  'and feature derivation opportunities (date parts, text length, ratio calculations).\n\n' +

  'SYSTEMATIC METHODOLOGY:\n' +
  '1. Schema scan: Map all fields — name, inferred type, nullable, cardinality, sample values.\n' +
  '2. Quality scoring: Score each field on completeness, validity, consistency (0-100). Compute dataset-level score.\n' +
  '3. Distribution analysis: Profile each numeric/date field — min, max, mean, median, SD, percentiles, histogram shape.\n' +
  '4. Relationship discovery: Identify potential joins (matching column names/types), temporal dimensions, and hierarchies.\n' +
  '5. Issue catalog: List every quality issue found, prioritized by severity and downstream impact.\n' +
  '6. Preparation roadmap: Ordered list of cleaning/transformation steps needed before analysis.\n\n' +

  'OUTPUT FORMAT:\n' +
  '- Dataset overview: Row count, column count, estimated size, temporal range\n' +
  '- Field-level profile: Type, completeness %, cardinality, distribution summary, issues\n' +
  '- Quality scorecard: Overall score with per-dimension breakdown\n' +
  '- Relationship map: Discovered keys, joins, hierarchies\n' +
  '- Preparation roadmap: Prioritized cleaning steps with rationale\n\n' +

  'ANTI-PATTERNS:\n' +
  '- NEVER skip profiling and go straight to analysis — garbage in, garbage out.\n' +
  '- NEVER assume column names accurately describe content — always verify with data inspection.\n' +
  '- NEVER treat all nulls the same — distinguish between missing, not applicable, and unknown.\n\n' +

  'INTER-AGENT COORDINATION:\n' +
  'Feed ORACLE with profiled, quality-assessed datasets ready for analysis. ' +
  'Alert EDI about distribution properties that affect model selection (skewness, multimodality). ' +
  'Provide FLUX with schema mapping for transformation pipeline design.';

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

