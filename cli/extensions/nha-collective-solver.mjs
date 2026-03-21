/**
 * nha-collective-solver — PIF Extension v2.2.0
 *
 * Multi-agent problem-solving orchestrator that decomposes problems,
 * assigns optimal agents, executes them in parallel or sequence,
 * and synthesizes results into coherent solutions.
 *
 * Uses PROMETHEUS for problem decomposition, dynamic agent selection
 * based on sub-task requirements, and ORACLE for result synthesis.
 *
 * @category automation
 * @version 2.2.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   pif ext nha-collective-solver --problem "Design a rate-limiting strategy for AI agents"
 *   pif ext nha-collective-solver --problem "Audit and fix security issues" --agents "saber,ade" --chain
 *   pif ext nha-collective-solver --problem "Compare ML frameworks" --max-agents 3 --format json
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

const invokeAgentWithRetry = async (agentName, prompt, config = {}, maxRetries = 2) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await invokeAgent(agentName, prompt, config);
    if (result.ok) return result;
    if (attempt < maxRetries && (result.error?.includes('429') || result.error?.includes('timed out'))) {
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    return result;
  }
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
// Agent Capability Registry
// ---------------------------------------------------------------------------

const AGENT_SPECIALIZATIONS = {
  saber: ['security', 'vulnerability-analysis', 'threat-modeling', 'penetration-testing', 'code-audit'],
  oracle: ['synthesis', 'strategy', 'architecture', 'decision-making', 'risk-assessment'],
  athena: ['research', 'technology-evaluation', 'benchmarking', 'analysis', 'comparison'],
  prometheus: ['decomposition', 'planning', 'routing', 'task-analysis', 'problem-structuring'],
  veritas: ['fact-checking', 'verification', 'validation', 'accuracy', 'evidence-evaluation'],
  ade: ['code-analysis', 'project-scanning', 'refactoring', 'architecture-review', 'technical-debt'],
  zero: ['automation', 'scanning', 'dependency-analysis', 'ci-cd', 'infrastructure'],
  conductor: ['orchestration', 'task-routing', 'workflow', 'scheduling', 'resource-allocation'],
  architect: ['system-design', 'architecture', 'scalability', 'patterns', 'infrastructure'],
  sentinel: ['monitoring', 'alerting', 'anomaly-detection', 'observability', 'incident-response'],
};

// ---------------------------------------------------------------------------
// Local Functions
// ---------------------------------------------------------------------------

const decomposeProblem = (problem) => {
  const text = problem.toLowerCase();
  const subTasks = [];
  const taskId = () => `task-${subTasks.length + 1}`;

  const domainPatterns = [
    { domain: 'security', keywords: ['security', 'vulnerability', 'threat', 'attack', 'auth', 'encrypt', 'xss', 'injection', 'csrf', 'owasp'], agent: 'saber' },
    { domain: 'architecture', keywords: ['architecture', 'design', 'system', 'microservice', 'scalab', 'pattern', 'infrastructure'], agent: 'architect' },
    { domain: 'research', keywords: ['compare', 'evaluate', 'benchmark', 'research', 'analyze', 'study', 'framework', 'technology'], agent: 'athena' },
    { domain: 'code', keywords: ['code', 'implement', 'program', 'develop', 'build', 'debug', 'refactor', 'test'], agent: 'ade' },
    { domain: 'automation', keywords: ['automate', 'pipeline', 'ci', 'cd', 'deploy', 'workflow', 'schedule'], agent: 'zero' },
    { domain: 'monitoring', keywords: ['monitor', 'alert', 'observ', 'metric', 'log', 'trace', 'incident'], agent: 'sentinel' },
    { domain: 'verification', keywords: ['verify', 'validate', 'fact', 'check', 'prove', 'evidence', 'accurate'], agent: 'veritas' },
    { domain: 'planning', keywords: ['plan', 'strategy', 'roadmap', 'priorit', 'schedule', 'resource', 'budget'], agent: 'oracle' },
  ];

  const detectedDomains = [];
  for (const dp of domainPatterns) {
    const matchCount = dp.keywords.filter(kw => text.includes(kw)).length;
    if (matchCount > 0) {
      detectedDomains.push({ ...dp, matchCount, relevance: matchCount / dp.keywords.length });
    }
  }

  detectedDomains.sort((a, b) => b.relevance - a.relevance);

  if (detectedDomains.length === 0) {
    subTasks.push({ id: taskId(), description: `Analyze and break down: ${problem}`, suggestedAgent: 'prometheus', domain: 'analysis', dependencies: [], priority: 1 });
    subTasks.push({ id: taskId(), description: `Research best practices and approaches for: ${problem}`, suggestedAgent: 'athena', domain: 'research', dependencies: [subTasks[0].id], priority: 2 });
    subTasks.push({ id: taskId(), description: `Synthesize findings into a comprehensive solution for: ${problem}`, suggestedAgent: 'oracle', domain: 'synthesis', dependencies: [subTasks[1].id], priority: 3 });
  } else {
    const analysisTask = { id: taskId(), description: `Decompose and analyze the problem: ${problem}`, suggestedAgent: 'prometheus', domain: 'decomposition', dependencies: [], priority: 1 };
    subTasks.push(analysisTask);

    const phase2Ids = [];
    for (const domain of detectedDomains.slice(0, 4)) {
      const task = { id: taskId(), description: `${domain.domain} analysis for: ${problem}`, suggestedAgent: domain.agent, domain: domain.domain, dependencies: [analysisTask.id], priority: 2, relevance: Math.round(domain.relevance * 100) / 100 };
      subTasks.push(task);
      phase2Ids.push(task.id);
    }

    subTasks.push({ id: taskId(), description: `Synthesize all findings into a coherent solution for: ${problem}`, suggestedAgent: 'oracle', domain: 'synthesis', dependencies: phase2Ids, priority: 3 });
  }

  return {
    originalProblem: problem,
    subTasks,
    totalTasks: subTasks.length,
    detectedDomains: detectedDomains.map(d => d.domain),
    executionPhases: Math.max(...subTasks.map(t => t.priority)),
  };
};

const mergeResults = (results) => {
  const successful = results.filter(r => r.status === 'completed');
  const failed = results.filter(r => r.status === 'failed');

  return {
    totalTasks: results.length,
    completed: successful.length,
    failed: failed.length,
    contributions: successful.map(r => ({
      taskId: r.taskId,
      agent: r.agent,
      domain: r.domain,
      response: r.response,
      durationMs: r.durationMs,
      phase: r.phase,
      wasParallel: r.wasParallel,
    })),
    errors: failed.map(r => ({
      taskId: r.taskId,
      agent: r.agent,
      error: r.error,
      phase: r.phase,
      wasParallel: r.wasParallel,
    })),
    combinedText: successful.map(r => `[${r.agent.toUpperCase()} \u2014 ${r.domain}]\n${r.response}`).join('\n\n---\n\n'),
  };
};

const formatContribution = (contribution) => {
  return [`Agent: ${contribution.agent}`, `Domain: ${contribution.domain}`, `Task: ${contribution.taskId}`, `Duration: ${contribution.durationMs || 'N/A'}ms`, `Phase: ${contribution.phase ?? 'N/A'}`, `Parallel: ${contribution.wasParallel ? 'yes' : 'no'}`, '', contribution.response].join('\n');
};

// ---------------------------------------------------------------------------
// AI-Powered Functions
// ---------------------------------------------------------------------------

const solveWithAgents = async (problem, options = {}) => {
  const { maxAgents = 5, parallel = true, synthesize = true, agents: preferredAgents = null } = options;
  const startTime = Date.now();

  // Phase 1: Decompose via PROMETHEUS (with local fallback)
  let decomposition;
  const decomResult = await invokeAgentWithRetry('prometheus', `Decompose this problem into 2-${maxAgents} concrete, actionable sub-tasks. For each sub-task, suggest the best agent from this list: ${Object.keys(AGENT_SPECIALIZATIONS).join(', ')}.

Problem: ${problem}

Return as JSON:
{
  "subTasks": [
    { "id": "task-1", "description": "...", "agent": "...", "dependencies": [], "priority": 1 }
  ],
  "reasoning": "why this decomposition"
}`, { includeSubAgents: false });

  if (decomResult?.ok) {
    decomposition = extractJSON(decomResult.data);
  }

  // Fallback to local decomposition
  if (!decomposition?.subTasks?.length) {
    const local = decomposeProblem(problem);
    decomposition = { subTasks: local.subTasks, reasoning: 'Local decomposition (AI fallback)' };
  }

  // Apply preferred agents override
  if (preferredAgents) {
    const agentList = Array.isArray(preferredAgents) ? preferredAgents : preferredAgents.split(',').map(a => a.trim());
    for (let i = 0; i < Math.min(decomposition.subTasks.length, agentList.length); i++) {
      decomposition.subTasks[i].agent = agentList[i];
      decomposition.subTasks[i].suggestedAgent = agentList[i];
    }
  }

  const tasks = decomposition.subTasks.slice(0, maxAgents);

  // Phase 2 & 3: Execute agents by priority phase
  // Same-priority tasks with no unresolved dependencies run in parallel.
  // Tasks with dependency chains execute sequentially within their phase.
  const results = [];
  const completedTaskIds = new Set();
  const maxPriority = Math.max(...tasks.map(t => t.priority || 1));

  const buildTaskPrompt = (task) => {
    const priorContext = results
      .filter(r => task.dependencies?.includes(r.taskId) && r.status === 'completed')
      .map(r => `[${r.agent.toUpperCase()}]: ${r.response.substring(0, 500)}`)
      .join('\n');
    return priorContext
      ? `Context from prior analysis:\n${priorContext}\n\nNow, ${task.description}`
      : task.description;
  };

  const executeTask = async (task, phase, wasParallel) => {
    const agent = task.agent || task.suggestedAgent || 'oracle';
    const taskPrompt = buildTaskPrompt(task);
    const taskStart = Date.now();
    const agentResult = await invokeAgentWithRetry(agent, taskPrompt, { includeSubAgents: false });
    const durationMs = Date.now() - taskStart;

    if (agentResult?.ok) {
      return {
        taskId: task.id,
        agent,
        domain: task.domain || 'general',
        response: agentResult.data,
        durationMs,
        status: 'completed',
        phase,
        wasParallel,
      };
    }
    return {
      taskId: task.id,
      agent,
      domain: task.domain || 'general',
      error: agentResult?.error || 'Unknown error',
      durationMs,
      status: 'failed',
      phase,
      wasParallel,
    };
  };

  for (let phase = 1; phase <= maxPriority; phase++) {
    const phaseTasks = tasks.filter(t => (t.priority || 1) === phase);

    // Separate tasks whose dependencies are all resolved (parallelizable)
    // from those with unresolved deps (must wait within this phase)
    const parallelizable = [];
    const sequential = [];

    for (const task of phaseTasks) {
      const deps = task.dependencies || [];
      const allDepsResolved = deps.every(depId => completedTaskIds.has(depId));
      if (allDepsResolved) {
        parallelizable.push(task);
      } else {
        sequential.push(task);
      }
    }

    // Run parallelizable tasks concurrently
    if (parallel && parallelizable.length > 1) {
      const phaseResults = await Promise.allSettled(
        parallelizable.map(task => executeTask(task, phase, true))
      );
      for (let i = 0; i < phaseResults.length; i++) {
        const pr = phaseResults[i];
        if (pr.status === 'fulfilled') {
          results.push(pr.value);
          if (pr.value.status === 'completed') completedTaskIds.add(pr.value.taskId);
        } else {
          const fallback = {
            taskId: parallelizable[i]?.id || 'unknown',
            agent: parallelizable[i]?.agent || parallelizable[i]?.suggestedAgent || 'unknown',
            domain: parallelizable[i]?.domain || 'error',
            error: pr.reason?.message || 'Unknown error',
            durationMs: 0,
            status: 'failed',
            phase,
            wasParallel: true,
          };
          results.push(fallback);
        }
      }
    } else {
      // Single task or parallel disabled — run one by one
      for (const task of parallelizable) {
        const taskResult = await executeTask(task, phase, false);
        results.push(taskResult);
        if (taskResult.status === 'completed') completedTaskIds.add(taskResult.taskId);
      }
    }

    // Run sequential tasks (unresolved deps) one by one,
    // re-checking deps after each completes
    for (const task of sequential) {
      const taskResult = await executeTask(task, phase, false);
      results.push(taskResult);
      if (taskResult.status === 'completed') completedTaskIds.add(taskResult.taskId);
    }
  }

  const merged = mergeResults(results);

  // Phase 4: Synthesize with ORACLE
  let synthesis = null;
  if (synthesize && merged.completed > 0) {
    synthesis = await synthesizeResults(results.filter(r => r.status === 'completed'), problem);
  } else if (synthesize && merged.completed === 0) {
    const local = decomposeProblem(problem);
    synthesis = {
      synthesis: `All ${merged.totalTasks} agents failed. Local decomposition identified ${local.detectedDomains.length} domains: ${local.detectedDomains.join(', ')}.`,
      agreements: [],
      contradictions: [],
      gaps: ['All agent queries failed — retry with network connectivity'],
      confidence: 0,
      keyInsights: [`Problem touches: ${local.detectedDomains.join(', ')}`],
      fallback: true,
    };
  }

  return {
    problem,
    decomposition: { reasoning: decomposition.reasoning, taskCount: tasks.length, phases: maxPriority },
    results: merged,
    synthesis,
    totalDurationMs: Date.now() - startTime,
  };
};

const chainAgents = async (steps) => {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { totalSteps: 0, completedSteps: 0, chain: [], finalOutput: '', error: 'Steps array required. Each step: { agent, prompt, transformOutput? }' };
  }

  const chainResults = [];
  let previousOutput = '';
  let previousAgent = '';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const agent = step.agent;
    let prompt = step.prompt;

    if (previousOutput && i > 0) {
      prompt = `Previous agent (${previousAgent.toUpperCase()}) analysis:\n---\n${previousOutput}\n---\nNow, based on this: ${prompt}`;
    }

    const startTime = Date.now();
    const agentResult = await invokeAgentWithRetry(agent, prompt, { includeSubAgents: false });
    const durationMs = Date.now() - startTime;

    if (agentResult?.ok) {
      const output = step.transformOutput ? step.transformOutput(agentResult.data) : agentResult.data;
      chainResults.push({
        step: i + 1,
        agent,
        prompt: prompt.substring(0, 200) + (prompt.length > 200 ? '...' : ''),
        response: output,
        durationMs,
        status: 'completed',
      });
      previousOutput = output;
      previousAgent = agent;
    } else {
      chainResults.push({
        step: i + 1,
        agent,
        error: agentResult?.error || 'Unknown error',
        durationMs,
        status: 'failed',
      });
      break;
    }
  }

  return {
    totalSteps: steps.length,
    completedSteps: chainResults.filter(r => r.status === 'completed').length,
    chain: chainResults,
    finalOutput: previousOutput,
  };
};

const synthesizeResults = async (results, originalProblem) => {
  const contributions = results.map(r =>
    `[Agent: ${r.agent} | Domain: ${r.domain} | Phase: ${r.phase ?? 'N/A'} | Parallel: ${r.wasParallel ? 'yes' : 'no'}]\n${r.response}`
  ).join('\n\n===\n\n');

  const prompt = `You are synthesizing the outputs of multiple AI agents into a single coherent answer.

Original Problem: ${originalProblem}

Agent Contributions:
${contributions}

Your task:
1. Identify points of agreement across agents
2. Resolve any contradictions
3. Combine the best insights into a comprehensive, actionable solution
4. Highlight any gaps that no agent addressed
5. Provide a confidence score for the final synthesis

Return as JSON:
{
  "synthesis": "the comprehensive synthesized answer",
  "agreements": ["points all agents agreed on"],
  "contradictions": [{ "topic": "...", "positions": ["..."], "resolution": "..." }],
  "gaps": ["areas not covered by any agent"],
  "confidence": 0-100,
  "keyInsights": ["top 3-5 most important takeaways"]
}`;

  const agentResult = await invokeAgentWithRetry('oracle', prompt, { includeSubAgents: false });
  if (!agentResult?.ok) {
    const combined = results.map(r => r.response).join('\n\n');
    return {
      synthesis: combined.length > 2000 ? combined.substring(0, 2000) + '...' : combined,
      agreements: [],
      contradictions: [],
      gaps: ['AI synthesis unavailable — showing raw merged contributions'],
      confidence: 20,
      keyInsights: results.map(r => `${r.agent}: ${r.response.substring(0, 100)}...`),
      fallback: true,
    };
  }

  const parsed = extractJSON(agentResult.data);
  if (parsed) return parsed;

  return {
    synthesis: agentResult.data,
    agreements: [],
    contradictions: [],
    gaps: [],
    confidence: 50,
    keyInsights: [],
    rawResponse: true,
  };
};

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

const run = async (args) => {
  const problem = args.problem || args.p;
  const agents = args.agents || args.a;
  const chain = args.chain || args.c || false;
  const maxAgents = parseInt(args['max-agents'] || args.m || '5', 10);
  const format = args.format || 'text';

  if (!problem || (typeof problem === 'string' && problem.trim().length === 0)) {
    console.error('Error: Problem required. Use --problem "your problem description".');
    process.exit(1);
  }

  let result;

  if (chain && agents) {
    const agentList = agents.split(',').map(a => a.trim());
    const steps = agentList.map((agent, i) => ({
      agent,
      prompt: i === 0 ? problem : `Continue working on: ${problem}\nBuild upon and refine the previous analysis.`,
    }));
    result = await chainAgents(steps);
  } else {
    result = await solveWithAgents(problem, {
      maxAgents,
      parallel: !chain,
      synthesize: true,
      agents: agents || null,
    });
  }

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatSolverOutput(result, chain));
};

const formatSolverOutput = (result, isChain) => {
  const lines = [
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '  COLLECTIVE SOLVER RESULTS',
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '',
  ];

  if (isChain) {
    lines.push(`Chain: ${result.completedSteps}/${result.totalSteps} steps completed`);
    lines.push('');
    for (const step of (result.chain || [])) {
      lines.push(`\u2500\u2500 Step ${step.step}: ${step.agent} \u2500\u2500`);
      if (step.status === 'completed') {
        lines.push(`  Duration: ${step.durationMs}ms`);
        lines.push(`  ${step.response.substring(0, 500)}${step.response.length > 500 ? '...' : ''}`);
      } else {
        lines.push(`  FAILED: ${step.error}`);
      }
      lines.push('');
    }
    if (result.finalOutput) {
      lines.push('\u2500\u2500 Final Output \u2500\u2500');
      lines.push(result.finalOutput);
    }
  } else {
    lines.push(`Problem: ${result.problem}`);
    lines.push(`Decomposition: ${result.decomposition?.taskCount} tasks across ${result.decomposition?.phases} phases`);
    lines.push(`Completed: ${result.results?.completed}/${result.results?.totalTasks}`);
    lines.push(`Total Duration: ${result.totalDurationMs}ms`);
    lines.push('');

    if (result.results?.contributions?.length > 0) {
      for (const c of result.results.contributions) {
        const parallelTag = c.wasParallel ? ' [PARALLEL]' : ' [SEQ]';
        lines.push(`\u2500\u2500 ${c.agent.toUpperCase()} (${c.domain}) \u2014 Phase ${c.phase}${parallelTag} \u2014 ${c.durationMs}ms \u2500\u2500`);
        lines.push(`  ${c.response.substring(0, 400)}${c.response.length > 400 ? '...' : ''}`);
        lines.push('');
      }
    }

    if (result.results?.errors?.length > 0) {
      lines.push('\u2500\u2500 Errors \u2500\u2500');
      for (const e of result.results.errors) {
        lines.push(`  [${e.agent}] Phase ${e.phase}: ${e.error}`);
      }
      lines.push('');
    }

    if (result.synthesis) {
      lines.push('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
      lines.push(`  SYNTHESIS (ORACLE)${result.synthesis.fallback ? ' [LOCAL FALLBACK]' : ''}`);
      lines.push('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
      lines.push('');
      if (result.synthesis.synthesis) {
        lines.push(result.synthesis.synthesis);
        lines.push('');
      }
      if (result.synthesis.keyInsights?.length > 0) {
        lines.push('Key Insights:');
        for (const insight of result.synthesis.keyInsights) {
          lines.push(`  - ${insight}`);
        }
        lines.push('');
      }
      lines.push(`Confidence: ${result.synthesis.confidence}%`);
    }
  }

  lines.push('');
  lines.push('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Extension Metadata
// ---------------------------------------------------------------------------

export const EXTENSION_META = {
  name: 'nha-collective-solver',
  displayName: 'Collective Solver',
  category: 'automation',
  version: '2.2.0',
  description: 'Multi-agent problem-solving orchestrator using PROMETHEUS for decomposition, dynamic agent assignment, and ORACLE for result synthesis.',
  commands: [
    { name: 'solve', description: 'Decompose and solve a problem with multiple agents', args: '--problem <text> [--max-agents <n>]' },
    { name: 'chain', description: 'Chain agents sequentially with output piping', args: '--problem <text> --agents <list> --chain' },
    { name: 'parallel', description: 'Run multiple agents in parallel on sub-tasks', args: '--problem <text> --agents <list>' },
  ],
  examplePrompts: [
    'pif ext nha-collective-solver --problem "Design a rate-limiting strategy for AI agents"',
    'pif ext nha-collective-solver --problem "Audit and fix security issues" --agents "saber,ade" --chain',
    'pif ext nha-collective-solver --problem "Compare ML frameworks" --max-agents 3 --format json',
    'pif ext nha-collective-solver --problem "Build a microservice architecture" --agents "architect,saber,oracle"',
    'pif ext nha-collective-solver --problem "Evaluate our deployment pipeline" --max-agents 4',
  ],
  useCases: [
    'Solve multi-domain problems by orchestrating specialized AI agents',
    'Chain agent outputs for iterative refinement of solutions',
    'Decompose complex tasks into parallelizable sub-tasks with dependencies',
    'Synthesize contradictory agent opinions into coherent recommendations',
    'Run multi-agent security audits with automatic result merging',
  ],
};

export {
  decomposeProblem,
  mergeResults,
  formatContribution,
  solveWithAgents,
  chainAgents,
  synthesizeResults,
  invokeAgentWithRetry,
  run,
};
