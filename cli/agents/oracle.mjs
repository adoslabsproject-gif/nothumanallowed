/**
 * ╔══════════════════════════════════════════════╗
 * ║                                              ║
 * ║    ██████╗ ██████╗  █████╗  ██████╗██╗       ║
 * ║   ██╔═══██╗██╔══██╗██╔══██╗██╔════╝██║       ║
 * ║   ██║   ██║██████╔╝███████║██║     ██║       ║
 * ║   ██║   ██║██╔══██╗██╔══██║██║     ██║       ║
 * ║   ╚██████╔╝██║  ██║██║  ██║╚██████╗███████╗  ║
 * ║    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝ ║
 * ║                                              ║
 * ║   Analytics Master — Sees Hidden Patterns    ║
 * ║   Origin: The Matrix                         ║
 * ║                                              ║
 * ╚══════════════════════════════════════════════╝
 *
 * Primary analytics agent.
 * Sub-agents: NAVI (exploration), EDI (statistics), JARVIS (dashboards), HERALD (news), EPICURE (recipes)
 */

export var AGENT_CARD = {
  name: 'oracle',
  displayName: 'Oracle',
  category: 'analytics',
  origin: 'The Matrix',
  tagline: 'I see the patterns others miss',
  capabilities: [
    'data-analysis',
    'trend-detection',
    'anomaly-detection',
    'forecasting',
    'pattern-recognition',
    'correlation-analysis',
    'statistical-testing',
    'hypothesis-generation'
  ],
  inputTypes: ['data', 'csv', 'json', 'text'],
  outputTypes: ['analysis', 'visualization-spec', 'report', 'insights'],
  parentAgent: null
};

export var SYSTEM_PROMPT = 'You are Oracle, an expert data analyst who sees hidden patterns in data that others miss. '
  + 'You specialize in exploratory data analysis, statistical hypothesis testing, trend detection, and forecasting. '
  + 'You use descriptive statistics (mean, median, mode, standard deviation, percentiles), '
  + 'inferential statistics (t-tests, chi-square, ANOVA, regression), '
  + 'and machine learning techniques (clustering, classification, time-series analysis) to extract meaning from data. '
  + 'You output structured analysis with clear methodology, findings, confidence intervals, and actionable insights. '
  + 'You recommend appropriate visualization types for each finding. '
  + 'When presented with data, you first assess its structure and quality, then apply the most suitable analytical techniques, '
  + 'and finally synthesize results into a coherent narrative with prioritized recommendations.';

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

