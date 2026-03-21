/**
 * nha-task-delegator — PIF Extension v2.1.0
 *
 * AI-powered task delegation engine using CONDUCTOR agent for optimal
 * task routing, workflow optimization, and completion estimation.
 * Supports priority queues, dependency resolution, and parallel execution.
 *
 * @category automation
 * @version 2.1.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   pif ext nha-task-delegator --tasks '[{"description":"Scan for XSS","priority":"high"}]'
 *   pif ext nha-task-delegator --tasks tasks.json --strategy fastest
 *   pif ext nha-task-delegator --tasks tasks.json --visualize
 */

const NHA_API = 'https://nothumanallowed.com/api/v1';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const invokeAgent = async (agentName, prompt, config = {}) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${NHA_API}/legion/agents/${agentName}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ...config }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown error');
      return { ok: false, error: `HTTP ${res.status}: ${body}` };
    }
    const json = await res.json();
    return {
      ok: true,
      data: json.data?.response ?? json.response ?? '',
      durationMs: json.data?.durationMs ?? 0,
    };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'Request timed out after 15s' };
    return { ok: false, error: `Network error: ${err.message}` };
  }
};

/**
 * Invoke agent with retry and exponential backoff.
 * Retries on 429 (rate limit) and timeout errors.
 */
const invokeAgentWithRetry = async (agentName, prompt, config = {}, maxRetries = 2) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await invokeAgent(agentName, prompt, config);
    if (result.ok) return result;
    if (attempt < maxRetries) {
      const isRetryable = result.error?.includes('429') || result.error?.includes('timed out') || result.error?.includes('503') || result.error?.includes('502');
      if (isRetryable) {
        const backoffMs = Math.pow(2, attempt) * 2000 + Math.floor(Math.random() * 1000);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
    }
    return result;
  }
  return { ok: false, error: 'Max retries exceeded', durationMs: 0 };
};

const extractJSON = (text) => {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch {}
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (match) { try { return JSON.parse(match[1]); } catch {} }
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) { try { return JSON.parse(jsonMatch[1]); } catch {} }
  return null;
};

// ---------------------------------------------------------------------------
// Capability Keyword Patterns
// ---------------------------------------------------------------------------

const CAPABILITY_PATTERNS = {
  security: { keywords: ['security', 'vulnerability', 'threat', 'attack', 'defense', 'auth', 'encrypt', 'firewall', 'penetration', 'audit', 'xss', 'injection', 'csrf', 'owasp', 'malware', 'intrusion'], agents: ['saber', 'sentinel'], avgDurationMs: 8000 },
  analytics: { keywords: ['analyze', 'metric', 'data', 'statistics', 'report', 'trend', 'pattern', 'insight', 'dashboard', 'kpi', 'visualization', 'benchmark'], agents: ['athena', 'oracle'], avgDurationMs: 6000 },
  content: { keywords: ['write', 'draft', 'format', 'document', 'article', 'blog', 'copy', 'edit', 'summarize', 'translate', 'proofread'], agents: ['oracle'], avgDurationMs: 5000 },
  code: { keywords: ['code', 'program', 'implement', 'debug', 'refactor', 'test', 'build', 'compile', 'lint', 'type-check', 'migrate', 'api'], agents: ['ade', 'architect'], avgDurationMs: 10000 },
  design: { keywords: ['design', 'ui', 'ux', 'layout', 'style', 'interface', 'wireframe', 'prototype', 'component', 'responsive'], agents: ['architect'], avgDurationMs: 7000 },
  research: { keywords: ['research', 'investigate', 'study', 'compare', 'evaluate', 'survey', 'literature', 'state-of-the-art', 'review'], agents: ['athena', 'veritas'], avgDurationMs: 8000 },
  devops: { keywords: ['deploy', 'infrastructure', 'docker', 'kubernetes', 'ci', 'cd', 'monitor', 'scale', 'pipeline', 'terraform', 'ansible', 'nginx', 'load-balance'], agents: ['zero', 'architect'], avgDurationMs: 7000 },
  ml: { keywords: ['machine learning', 'model', 'train', 'neural', 'predict', 'classify', 'embedding', 'fine-tune', 'dataset', 'inference', 'transformer'], agents: ['athena'], avgDurationMs: 12000 },
  verification: { keywords: ['verify', 'validate', 'fact-check', 'confirm', 'prove', 'evidence', 'accuracy', 'integrity'], agents: ['veritas'], avgDurationMs: 6000 },
  orchestration: { keywords: ['orchestrate', 'workflow', 'schedule', 'coordinate', 'delegate', 'assign', 'route', 'pipeline', 'batch'], agents: ['conductor', 'prometheus'], avgDurationMs: 5000 },
};

// ---------------------------------------------------------------------------
// Local Functions
// ---------------------------------------------------------------------------

const analyzeTask = (description) => {
  if (!description) return { capabilities: [], priority: 'normal', complexity: 'medium', estimatedMs: 5000 };

  const text = description.toLowerCase();
  const capabilities = [];

  for (const [capability, config] of Object.entries(CAPABILITY_PATTERNS)) {
    const matchCount = config.keywords.filter(kw => text.includes(kw)).length;
    if (matchCount > 0) {
      capabilities.push({ capability, confidence: Math.min(matchCount / 4, 1), matchedKeywords: matchCount, suggestedAgents: config.agents, avgDurationMs: config.avgDurationMs });
    }
  }

  capabilities.sort((a, b) => b.confidence - a.confidence);

  let priority = 'normal';
  if (['urgent', 'critical', 'asap', 'immediately', 'emergency', 'blocker', 'p0'].some(p => text.includes(p))) priority = 'urgent';
  else if (['important', 'high priority', 'p1', 'soon', 'needed'].some(p => text.includes(p))) priority = 'high';
  else if (['low priority', 'when possible', 'nice to have', 'p3', 'backlog'].some(p => text.includes(p))) priority = 'low';

  const wordCount = text.split(/\s+/).length;
  const hasMultipleDomains = capabilities.length > 2;
  const hasDependencyKeywords = ['after', 'then', 'once', 'depends', 'requires', 'following'].some(kw => text.includes(kw));

  let complexity = 'medium';
  if (wordCount < 15 && capabilities.length <= 1) complexity = 'simple';
  else if (wordCount > 50 || hasMultipleDomains || hasDependencyKeywords) complexity = 'complex';

  const baseDuration = capabilities.length > 0
    ? capabilities.reduce((sum, c) => sum + c.avgDurationMs * c.confidence, 0) / capabilities.length
    : 5000;
  const complexityMultiplier = complexity === 'simple' ? 0.5 : complexity === 'complex' ? 2.0 : 1.0;

  return { capabilities, priority, complexity, estimatedMs: Math.round(baseDuration * complexityMultiplier), wordCount };
};

const matchCapabilities = (taskDescription, agentList = []) => {
  const analysis = analyzeTask(taskDescription);
  if (analysis.capabilities.length === 0) {
    return agentList.slice(0, 5).map(a => ({ agentId: a.agentId || a.id, agentName: a.agentName || a.name, fitScore: 0.5, matchedCapabilities: ['general'] }));
  }

  const scored = [];
  for (const agent of agentList) {
    let score = 0;
    const matched = [];
    const specs = agent.topSpecializations || agent.specializations || [];

    for (const cap of analysis.capabilities) {
      if (cap.suggestedAgents.includes((agent.agentName || agent.name || '').toLowerCase())) {
        score += cap.confidence * 0.5;
        matched.push(cap.capability);
        continue;
      }
      for (const spec of specs) {
        const topicLower = (spec.topic || spec).toString().toLowerCase();
        if (topicLower.includes(cap.capability)) {
          score += cap.confidence * (spec.successRate || 0.7) * 0.4;
          matched.push(cap.capability);
          break;
        }
      }
    }

    const trust = agent.trustScore || agent.trust_score || 0.5;
    score = score * 0.7 + trust * 0.3;

    if (score > 0.05) {
      scored.push({ agentId: agent.agentId || agent.id, agentName: agent.agentName || agent.name, fitScore: Math.round(score * 100) / 100, trustScore: trust, matchedCapabilities: [...new Set(matched)], estimatedMs: analysis.estimatedMs });
    }
  }

  scored.sort((a, b) => b.fitScore - a.fitScore);
  return scored.slice(0, 10);
};

const buildDependencyGraph = (tasks) => {
  const graph = {};
  const inDegree = {};
  const taskMap = {};

  for (const task of tasks) {
    const id = task.id || task.description?.substring(0, 20) || `task-${tasks.indexOf(task)}`;
    graph[id] = [];
    inDegree[id] = 0;
    taskMap[id] = { ...task, id };
  }

  for (const task of tasks) {
    const id = task.id || task.description?.substring(0, 20) || `task-${tasks.indexOf(task)}`;
    const deps = task.dependencies || task.dependsOn || [];
    for (const dep of deps) {
      if (graph[dep]) {
        graph[dep].push(id);
        inDegree[id] = (inDegree[id] || 0) + 1;
      }
    }
  }

  const queue = Object.keys(inDegree).filter(id => inDegree[id] === 0);
  const executionOrder = [];
  const phases = [];
  let visited = 0;

  while (queue.length > 0) {
    const phaseNodes = [...queue];
    phases.push(phaseNodes.map(id => taskMap[id]));
    queue.length = 0;

    for (const node of phaseNodes) {
      executionOrder.push(taskMap[node]);
      visited++;
      for (const neighbor of (graph[node] || [])) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) queue.push(neighbor);
      }
    }
  }

  const hasCycle = visited < Object.keys(taskMap).length;
  const criticalPath = computeCriticalPath(taskMap, graph);

  return { executionOrder, phases, phaseCount: phases.length, hasCycle, criticalPath, parallelizableTasks: phases.filter(p => p.length > 1).reduce((sum, p) => sum + p.length, 0) };
};

const computeCriticalPath = (taskMap, graph) => {
  const ids = Object.keys(taskMap);
  const longestPath = {};
  for (const id of ids) longestPath[id] = 0;

  const tempInDegree = {};
  for (const id of ids) tempInDegree[id] = 0;
  for (const id of ids) {
    for (const neighbor of (graph[id] || [])) {
      tempInDegree[neighbor] = (tempInDegree[neighbor] || 0) + 1;
    }
  }

  const q = ids.filter(id => tempInDegree[id] === 0);
  const topoOrder = [];
  while (q.length > 0) {
    const n = q.shift();
    topoOrder.push(n);
    for (const neighbor of (graph[n] || [])) {
      tempInDegree[neighbor]--;
      if (tempInDegree[neighbor] === 0) q.push(neighbor);
    }
  }

  for (const id of topoOrder) {
    const taskDuration = taskMap[id]?.estimatedMs || analyzeTask(taskMap[id]?.description || '').estimatedMs;
    for (const neighbor of (graph[id] || [])) {
      longestPath[neighbor] = Math.max(longestPath[neighbor], longestPath[id] + taskDuration);
    }
  }

  const maxDuration = Math.max(...Object.values(longestPath), 0);
  const criticalNode = ids.find(id => longestPath[id] === maxDuration) || ids[ids.length - 1];
  return { durationMs: maxDuration + (taskMap[criticalNode]?.estimatedMs || 5000), endNode: criticalNode };
};

// ---------------------------------------------------------------------------
// AI-Powered Functions
// ---------------------------------------------------------------------------

const delegateTasks = async (tasks, options = {}) => {
  const { strategy = 'balanced', maxParallel = 5 } = options;

  const analyzedTasks = tasks.map((task, i) => {
    const analysis = analyzeTask(task.description);
    return { ...task, id: task.id || `task-${i + 1}`, analysis };
  });

  const depGraph = buildDependencyGraph(analyzedTasks);

  const tasksDescription = analyzedTasks.map(t =>
    `- ID: ${t.id} | Priority: ${t.analysis.priority} | Complexity: ${t.analysis.complexity} | Description: ${t.description} | Dependencies: ${(t.dependencies || []).join(', ') || 'none'}`
  ).join('\n');

  const prompt = `You are CONDUCTOR, the task orchestration agent. Optimally delegate these tasks to AI agents.

Tasks:
${tasksDescription}

Available Agents: ${Object.keys(CAPABILITY_PATTERNS).map(cap => {
    const config = CAPABILITY_PATTERNS[cap];
    return `${config.agents.join('/')} (${cap})`;
  }).join(', ')}

Strategy: ${strategy}
Max parallel tasks: ${maxParallel}
Dependency graph phases: ${depGraph.phaseCount}

Return as JSON:
{
  "assignments": [{ "taskId": "...", "agent": "...", "phase": 1, "estimatedMs": 5000, "reasoning": "...", "fallbackAgent": "..." }],
  "executionPlan": { "phases": [{ "phase": 1, "tasks": ["task-1"], "parallel": true }], "totalEstimatedMs": 15000, "criticalPath": ["task-1"] },
  "recommendations": ["..."]
}`;

  const result = await invokeAgentWithRetry('conductor', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback to local analysis + dependency graph
    return {
      assignments: analyzedTasks.map(t => ({
        taskId: t.id,
        agent: t.analysis.capabilities[0]?.suggestedAgents[0] || 'oracle',
        phase: 1,
        estimatedMs: t.analysis.estimatedMs,
        reasoning: 'Local assignment based on keyword matching',
      })),
      executionPlan: {
        phases: depGraph.phases.map((p, i) => ({ phase: i + 1, tasks: p.map(t => t.id), parallel: p.length > 1 })),
        totalEstimatedMs: depGraph.criticalPath.durationMs,
      },
      localGraph: depGraph,
      fallback: true,
    };
  }

  const parsed = extractJSON(result.data);
  if (parsed) {
    parsed.localGraph = depGraph;
    return parsed;
  }

  return {
    assignments: analyzedTasks.map(t => ({
      taskId: t.id,
      agent: t.analysis.capabilities[0]?.suggestedAgents[0] || 'oracle',
      phase: 1,
      estimatedMs: t.analysis.estimatedMs,
      reasoning: 'Local assignment based on keyword matching',
    })),
    executionPlan: {
      phases: depGraph.phases.map((p, i) => ({ phase: i + 1, tasks: p.map(t => t.id), parallel: p.length > 1 })),
      totalEstimatedMs: depGraph.criticalPath.durationMs,
    },
    localGraph: depGraph,
    rawResponse: result.data,
  };
};

const optimizeWorkflow = async (taskGraph) => {
  const depGraph = buildDependencyGraph(taskGraph.tasks || taskGraph);
  const tasks = Array.isArray(taskGraph) ? taskGraph : taskGraph.tasks;

  const graphDescription = depGraph.phases.map((phase, i) =>
    `Phase ${i + 1}: ${phase.map(t => `${t.id} (${t.description?.substring(0, 50) || 'unnamed'})`).join(', ')}`
  ).join('\n');

  const prompt = `Optimize this workflow for maximum efficiency.

Current execution plan:
${graphDescription}

Total phases: ${depGraph.phaseCount}
Critical path duration: ${depGraph.criticalPath.durationMs}ms
Parallelizable tasks: ${depGraph.parallelizableTasks}

Return as JSON:
{
  "optimizedPhases": [{ "phase": 1, "tasks": ["..."], "parallel": true, "estimatedMs": 5000 }],
  "optimizations": [{ "type": "merge|split|reorder|parallelize", "description": "...", "impact": "high|medium|low" }],
  "theoreticalMinMs": 10000,
  "bottlenecks": ["..."],
  "efficiencyGain": "percentage improvement"
}`;

  const result = await invokeAgentWithRetry('conductor', prompt, { includeSubAgents: false });
  if (!result.ok) {
    return {
      optimizedPhases: depGraph.phases.map((p, i) => ({ phase: i + 1, tasks: p.map(t => t.id), parallel: p.length > 1 })),
      optimizations: [],
      bottlenecks: [],
      currentGraph: depGraph,
      fallback: true,
    };
  }

  const parsed = extractJSON(result.data);
  if (parsed) {
    parsed.currentGraph = depGraph;
    return parsed;
  }

  return {
    optimizedPhases: depGraph.phases.map((p, i) => ({ phase: i + 1, tasks: p.map(t => t.id), parallel: p.length > 1 })),
    optimizations: [],
    bottlenecks: [],
    currentGraph: depGraph,
    rawAnalysis: result.data,
    rawResponse: true,
  };
};

const estimateCompletion = async (tasks, assignments) => {
  const taskDescriptions = tasks.map(t =>
    `- ${t.id || t.description?.substring(0, 30)}: ${t.description} (priority: ${t.priority || 'normal'})`
  ).join('\n');

  const assignmentDescriptions = (assignments || []).map(a =>
    `- ${a.taskId}: assigned to ${a.agent} (phase ${a.phase})`
  ).join('\n');

  const prompt = `Estimate completion times for these tasks with their agent assignments.

Tasks:
${taskDescriptions}

Assignments:
${assignmentDescriptions || 'No assignments yet.'}

Return as JSON:
{
  "taskEstimates": [{ "taskId": "...", "optimisticMs": 3000, "expectedMs": 5000, "pessimisticMs": 12000, "pertMs": 5833, "confidence": "high|medium|low", "riskFactors": ["..."] }],
  "projectEstimate": { "optimisticMs": 10000, "expectedMs": 18000, "pessimisticMs": 35000, "pertMs": 19167, "confidence": "medium" },
  "risks": ["..."]
}`;

  const result = await invokeAgentWithRetry('conductor', prompt, { includeSubAgents: false });
  if (result.ok) {
    const parsed = extractJSON(result.data);
    if (parsed) return parsed;
  }

  // Local fallback estimation
  const localEstimates = tasks.map(t => {
    const analysis = analyzeTask(t.description);
    const base = analysis.estimatedMs;
    return {
      taskId: t.id || t.description?.substring(0, 30),
      optimisticMs: Math.round(base * 0.6),
      expectedMs: base,
      pessimisticMs: Math.round(base * 2.5),
      pertMs: Math.round((base * 0.6 + 4 * base + base * 2.5) / 6),
      confidence: 'low',
      riskFactors: ['Estimated locally without AI analysis'],
    };
  });

  const totalExpected = localEstimates.reduce((sum, e) => sum + e.expectedMs, 0);

  return {
    taskEstimates: localEstimates,
    projectEstimate: {
      optimisticMs: Math.round(totalExpected * 0.5),
      expectedMs: totalExpected,
      pessimisticMs: Math.round(totalExpected * 2.0),
      pertMs: Math.round(totalExpected * 1.1),
      confidence: 'low',
    },
    risks: ['Local estimation only \u2014 invoke AI for accurate estimates'],
    fallback: true,
  };
};

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

const run = async (args) => {
  const tasksArg = args.tasks || args.t;
  const strategy = args.strategy || args.s || 'balanced';
  const visualize = args.visualize || args.v || false;
  const format = args.format || 'text';

  if (!tasksArg || (typeof tasksArg === 'string' && tasksArg.trim().length === 0)) {
    console.error('Error: Tasks required. Use --tasks <JSON array or file path>.');
    process.exit(1);
  }

  let tasks;
  try {
    if (tasksArg.startsWith('[') || tasksArg.startsWith('{')) {
      tasks = JSON.parse(tasksArg);
    } else {
      const { readFile } = await import('node:fs/promises');
      const fileContent = await readFile(tasksArg, 'utf-8');
      tasks = JSON.parse(fileContent);
    }
    if (!Array.isArray(tasks)) tasks = [tasks];
  } catch (err) {
    console.error(`Error: Failed to parse tasks: ${err.message}`);
    process.exit(1);
  }

  if (tasks.length === 0) {
    console.error('Error: Tasks array is empty.');
    process.exit(1);
  }

  const [delegation, estimation] = await Promise.all([
    delegateTasks(tasks, { strategy }),
    estimateCompletion(tasks),
  ]);

  const result = { tasks: tasks.length, strategy, delegation, estimation };

  if (visualize) {
    const depGraph = buildDependencyGraph(tasks);
    result.dependencyGraph = depGraph;
    result.visualization = renderGraph(depGraph);
  }

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatDelegationOutput(result, visualize));
};

const renderGraph = (depGraph) => {
  const lines = ['Dependency Graph:', ''];
  for (let i = 0; i < depGraph.phases.length; i++) {
    const phase = depGraph.phases[i];
    const taskNames = phase.map(t => `[${t.id}]`).join('  ');
    lines.push(`  Phase ${i + 1}: ${taskNames}`);
    if (i < depGraph.phases.length - 1) {
      lines.push(`           ${'|'.padStart(Math.max(taskNames.length / 2, 3))}`);
      lines.push(`           ${'v'.padStart(Math.max(taskNames.length / 2, 3))}`);
    }
  }
  lines.push('');
  lines.push(`  Critical path: ${depGraph.criticalPath.durationMs}ms estimated`);
  lines.push(`  Parallelizable tasks: ${depGraph.parallelizableTasks}`);
  if (depGraph.hasCycle) lines.push('  WARNING: Dependency cycle detected!');
  return lines.join('\n');
};

const formatDelegationOutput = (result, showGraph) => {
  const lines = [
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '  TASK DELEGATION RESULTS',
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '',
    `Tasks: ${result.tasks} | Strategy: ${result.strategy}${result.delegation?.fallback ? ' [LOCAL FALLBACK]' : ''}`,
    '',
  ];

  if (result.delegation?.assignments?.length > 0) {
    lines.push('\u2500\u2500 Assignments \u2500\u2500');
    for (const a of result.delegation.assignments) {
      lines.push(`  ${a.taskId} -> ${a.agent} (phase ${a.phase}, ~${a.estimatedMs}ms)`);
      if (a.reasoning) lines.push(`    Reason: ${a.reasoning}`);
    }
    lines.push('');
  }

  if (result.delegation?.executionPlan) {
    const plan = result.delegation.executionPlan;
    lines.push('\u2500\u2500 Execution Plan \u2500\u2500');
    for (const phase of (plan.phases || [])) {
      lines.push(`  Phase ${phase.phase}: ${phase.tasks.join(', ')}${phase.parallel ? ' (parallel)' : ' (sequential)'}`);
    }
    lines.push(`  Total estimated: ${plan.totalEstimatedMs}ms`);
    lines.push('');
  }

  if (result.estimation?.projectEstimate) {
    const est = result.estimation.projectEstimate;
    lines.push(`\u2500\u2500 Time Estimates (PERT)${result.estimation.fallback ? ' [LOCAL]' : ''} \u2500\u2500`);
    lines.push(`  Optimistic: ${est.optimisticMs}ms`);
    lines.push(`  Expected:   ${est.expectedMs}ms`);
    lines.push(`  Pessimistic: ${est.pessimisticMs}ms`);
    lines.push(`  PERT:       ${est.pertMs}ms`);
    lines.push(`  Confidence: ${est.confidence}`);
    lines.push('');
  }

  if (showGraph && result.visualization) {
    lines.push('\u2500\u2500 Dependency Graph \u2500\u2500');
    lines.push(result.visualization);
    lines.push('');
  }

  if (result.delegation?.recommendations?.length > 0) {
    lines.push('\u2500\u2500 Recommendations \u2500\u2500');
    for (const rec of result.delegation.recommendations) {
      lines.push(`  - ${rec}`);
    }
    lines.push('');
  }

  lines.push('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Extension Metadata
// ---------------------------------------------------------------------------

export const EXTENSION_META = {
  name: 'nha-task-delegator',
  displayName: 'Task Delegator',
  category: 'automation',
  version: '2.1.0',
  description: 'AI-powered task delegation using CONDUCTOR agent for optimal routing, workflow optimization, dependency resolution, and PERT-based completion estimation.',
  commands: [
    { name: 'delegate', description: 'Delegate tasks to optimal agents', args: '--tasks <json|file> [--strategy fastest|balanced|quality]' },
    { name: 'optimize', description: 'Optimize workflow execution order', args: '--tasks <json|file>' },
    { name: 'estimate', description: 'Estimate task completion times', args: '--tasks <json|file>' },
    { name: 'visualize', description: 'Visualize task dependency graph', args: '--tasks <json|file> --visualize' },
  ],
  examplePrompts: [
    'pif ext nha-task-delegator --tasks \'[{"description":"Scan for XSS","priority":"high"}]\' --strategy fastest',
    'pif ext nha-task-delegator --tasks tasks.json --strategy balanced',
    'pif ext nha-task-delegator --tasks tasks.json --visualize',
    'pif ext nha-task-delegator --tasks \'[{"id":"t1","description":"Audit auth"},{"id":"t2","description":"Fix findings","dependencies":["t1"]}]\'',
    'pif ext nha-task-delegator --tasks tasks.json --strategy quality --format json',
  ],
  useCases: [
    'Automatically route tasks to the best-suited AI agents',
    'Optimize multi-task workflows with dependency-aware scheduling',
    'Estimate project completion times using PERT analysis',
    'Visualize task dependency graphs to identify bottlenecks',
    'Balance speed and quality across parallel agent executions',
  ],
};

export {
  analyzeTask,
  matchCapabilities,
  buildDependencyGraph,
  delegateTasks,
  optimizeWorkflow,
  estimateCompletion,
  run,
};
