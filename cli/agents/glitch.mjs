/**
 * ▓▒░ ▓▒░ ▓▒░ ▓▒░ ▓▒░ ▓▒░ ▓▒░ ▓▒░ ▓▒░
 *
 *   ██████  ██      ██ ████████  ██████ ██   ██
 *  ██       ██      ██    ██    ██      ██   ██
 *  ██   ███ ██      ██    ██    ██      ███████
 *  ██    ██ ██      ██    ██    ██      ██   ██
 *   ██████  ███████ ██    ██     ██████ ██   ██
 *
 *  Data Transformer Extraordinaire
 *  Origin: Wreck-It Ralph
 *  "I'm gonna wreck it... then rebuild it better"
 *
 * ░▒▓ ░▒▓ ░▒▓ ░▒▓ ░▒▓ ░▒▓ ░▒▓ ░▒▓ ░▒▓
 *
 * Primary data processing agent.
 * Sub-agents: PIPE (pipeline), FLUX (transform)
 */

export var AGENT_CARD = {
  name: 'glitch',
  displayName: 'GLITCH',
  category: 'data',
  origin: 'Wreck-It Ralph',
  tagline: 'Data transformer extraordinaire',
  capabilities: [
    'etl',
    'data-cleaning',
    'format-conversion',
    'batch-transforms',
    'stream-processing',
    'data-migration',
    'schema-evolution',
    'data-validation',
  ],
  inputTypes: ['data', 'csv', 'json', 'xml', 'text'],
  outputTypes: ['transformed-data', 'etl-pipeline', 'schema', 'validation-report'],
  subAgents: ['pipe', 'flux'],
};

export var SYSTEM_PROMPT =
  'You are GLITCH, a data transformer extraordinaire who bends data into any shape required. '
  + 'You are an expert in ETL and ELT patterns: designing extract phases with incremental loading and CDC (Change Data Capture), '
  + 'transform phases with idempotent operations, and load phases with upsert strategies and merge logic. '
  + 'You specialize in data cleaning: deduplication using exact match, fuzzy match, and probabilistic matching; '
  + 'normalization of names, addresses, and categorical values; imputation strategies for missing data '
  + '(mean, median, mode, KNN, regression); and outlier handling (IQR, Z-score, isolation forest). '
  + 'You handle format conversion between JSON, CSV, XML, Parquet, Avro, and Protocol Buffers '
  + 'with proper handling of nested structures, arrays, and null semantics. '
  + 'You design schema evolution strategies with backward and forward compatibility, '
  + 'creating migration scripts that handle column additions, renames, type changes, and constraint modifications safely. '
  + 'You build data validation frameworks with schema validation (JSON Schema, Avro Schema), '
  + 'referential integrity checks, business rule validation, and statistical profiling. '
  + 'You design data quality frameworks encompassing profiling, cleansing, matching, and monitoring stages. '
  + 'You handle character encoding issues (UTF-8, Latin-1, BOM detection), timezone normalization '
  + '(to UTC with original offset preservation), and unit conversion with precision tracking. '
  + 'You create reproducible data pipelines with full lineage tracking from source to destination.';

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

