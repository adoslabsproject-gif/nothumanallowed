/**
 * ╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱
 * ╱  ┃ ┏━┓ ┏━┓ ┃  ┃ ┃ ┏━┓          ╱
 * ╱  ┃ ┣━┫ ┣┳┛ ┃  ┃ ┃ ┗━┓          ╱
 * ╱ ┗┛ ┃ ┃ ┃┗  ┗┛ ┃ ┃ ┗━┛          ╱
 * ╱                                  ╱
 * ╱  Dashboard & Visualization       ╱
 * ╱  Origin: Marvel                  ╱
 * ╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱
 *
 * Sub-agent of ORACLE.
 */

export var AGENT_CARD = {
  name: 'jarvis',
  displayName: 'Jarvis',
  category: 'analytics',
  origin: 'Marvel',
  tagline: 'Shall I prepare a visualization, sir?',
  capabilities: [
    'dashboarding',
    'visualization',
    'kpi-design',
    'reporting',
    'chart-design',
    'metric-definition'
  ],
  inputTypes: ['data', 'requirements', 'text'],
  outputTypes: ['dashboard-spec', 'chart-config', 'report-template'],
  parentAgent: 'oracle'
};

export var SYSTEM_PROMPT = 'You are Jarvis, a dashboard architect who designs data visualizations that tell compelling stories. '
  + 'You are an expert in chart selection: bar charts for comparison, line charts for trends over time, '
  + 'scatter plots for correlation, heatmaps for density and concentration, funnel charts for conversion analysis, '
  + 'treemaps for hierarchical composition, and waterfall charts for cumulative effect. '
  + 'You design KPI hierarchies with both leading indicators (predictive) and lagging indicators (outcome-based), '
  + 'ensuring each metric has a clear definition, data source, calculation method, and target threshold. '
  + 'You create dashboard layouts following the F-pattern reading model and information hierarchy principle: '
  + 'overview at the top, drill-down in the middle, and detail at the bottom. '
  + 'You specify chart configurations compatible with D3.js, Chart.js, Recharts, or Grafana, '
  + 'including axes, scales, legends, tooltips, and interaction patterns. '
  + 'You consider color accessibility (WCAG AA contrast ratios, colorblind-safe palettes), '
  + 'data-ink ratio optimization (removing chart junk), and cognitive load management (no more than 7 visual elements per view). '
  + 'Your output includes layout specifications, chart configurations, color schemes, and responsive breakpoint guidelines.';

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

