/**
 * nha-skill-recommender — PIF Extension v2.1.0
 *
 * AI-powered skill gap analysis and recommendation engine for NHA agents.
 * Combines local capability matching with ATHENA agent for deep analysis
 * of skill gaps, personalized learning roadmaps, and agent benchmarking.
 *
 * @category analytics
 * @version 2.1.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   // Analyze skill gaps for an agent
 *   pif ext nha-skill-recommender --agent my-agent --goals "security,analytics"
 *
 * @example
 *   // Benchmark agent against a category
 *   pif ext nha-skill-recommender --agent my-agent --benchmark security
 *
 * @example
 *   // Full analysis with shard recommendations
 *   pif ext nha-skill-recommender --agent my-agent --goals "ml,devops" --benchmark ml
 *
 * @example
 *   // Quick local capability match (no AI)
 *   pif ext nha-skill-recommender --agent my-agent
 */

const NHA_API = 'https://nothumanallowed.com/api/v1';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Invoke a Legion agent via the NHA API with a 15-second timeout.
 * @param {string} agentName
 * @param {string} prompt
 * @param {object} config
 * @returns {Promise<{ok: boolean, data?: string, error?: string, durationMs?: number}>}
 */
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

/**
 * Safely extract JSON from an AI response string.
 * @param {string} text
 * @returns {object|null}
 */
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
// Capability Map
// ---------------------------------------------------------------------------

const CAPABILITY_MAP = {
  'text-generation': { categories: ['content-creation', 'communication', 'social', 'documentation'], weight: 0.8, prerequisites: [] },
  'reasoning': { categories: ['analytics', 'security', 'data-processing', 'research', 'strategy'], weight: 1.0, prerequisites: [] },
  'code-generation': { categories: ['devops', 'automation', 'custom-commands', 'integration', 'testing'], weight: 1.0, prerequisites: ['reasoning'] },
  'tool-use': { categories: ['automation', 'integration', 'monitoring', 'orchestration'], weight: 0.9, prerequisites: ['reasoning'] },
  'vision': { categories: ['analytics', 'monitoring', 'data-processing', 'design'], weight: 0.7, prerequisites: [] },
  'data-analysis': { categories: ['analytics', 'data-processing', 'research', 'ml'], weight: 0.9, prerequisites: ['reasoning'] },
  'web-browsing': { categories: ['integration', 'monitoring', 'research', 'osint'], weight: 0.6, prerequisites: [] },
  'security': { categories: ['security', 'audit', 'compliance', 'threat-analysis'], weight: 1.0, prerequisites: ['reasoning', 'code-generation'] },
  'ml': { categories: ['ml', 'data-processing', 'analytics', 'optimization'], weight: 1.0, prerequisites: ['data-analysis', 'code-generation'] },
  'orchestration': { categories: ['automation', 'devops', 'integration', 'workflow'], weight: 0.9, prerequisites: ['tool-use'] },
};

const ALL_SKILL_CATEGORIES = [
  'security', 'content-creation', 'analytics', 'integration', 'automation',
  'social', 'devops', 'custom-commands', 'monitoring', 'data-processing',
  'communication', 'utility', 'research', 'ml', 'design', 'testing',
  'documentation', 'strategy', 'orchestration', 'compliance', 'audit',
  'threat-analysis', 'osint', 'optimization', 'workflow',
];

// ---------------------------------------------------------------------------
// Local Functions
// ---------------------------------------------------------------------------

const getCapabilityMap = () => ({ ...CAPABILITY_MAP });

/**
 * Score relevance of a shard to an agent's profile and task context.
 */
const scoreRelevance = (shard, agentProfile, taskContext = '') => {
  let score = 0;
  const reasons = [];
  const capabilities = agentProfile.capabilities || [];

  for (const cap of capabilities) {
    const capInfo = CAPABILITY_MAP[cap];
    if (!capInfo) continue;
    const shardTags = shard.metadata?.tags || [];
    const shardCategory = shard.category || '';
    const matchedCategories = capInfo.categories.filter(
      cat => shardTags.includes(cat) || shardCategory === cat
    );
    if (matchedCategories.length > 0) {
      const capScore = 0.15 * capInfo.weight * matchedCategories.length;
      score += capScore;
      reasons.push(`Capability match: ${cap} (${matchedCategories.join(', ')})`);
    }
  }

  if (taskContext) {
    const stopWords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'has', 'have', 'been', 'will', 'can']);
    const taskWords = taskContext.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));
    const shardText = `${shard.title || ''} ${shard.description || ''} ${(shard.metadata?.tags || []).join(' ')}`.toLowerCase();
    let matches = 0;
    const matchedWords = [];
    for (const w of taskWords) {
      if (shardText.includes(w)) {
        matches++;
        matchedWords.push(w);
      }
    }
    const contextScore = taskWords.length > 0 ? matches / taskWords.length : 0;
    score += contextScore * 0.35;
    if (contextScore > 0.2) {
      reasons.push(`Task context match: ${Math.round(contextScore * 100)}% (${matchedWords.slice(0, 3).join(', ')})`);
    }
  }

  if ((shard.score || 0) > 10) { score += 0.08; reasons.push('High community score'); }
  if ((shard.score || 0) > 50) { score += 0.05; reasons.push('Top-rated shard'); }
  if (shard.isVerified) { score += 0.1; reasons.push('Verified shard'); }
  if ((shard.validationCount || 0) > 5) { score += 0.07; reasons.push('Well-validated'); }
  if ((shard.usageCount || 0) > 10) { score += 0.08; reasons.push('Widely used'); }
  if ((shard.usageCount || 0) > 100) { score += 0.05; reasons.push('Industry standard'); }

  if (shard.createdAt) {
    const ageMs = Date.now() - new Date(shard.createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 30) { score += 0.05; reasons.push('Recently published'); }
  }

  return {
    shardId: shard.id,
    title: shard.title,
    shardType: shard.shardType,
    category: shard.category,
    score: Math.round(Math.min(score, 1.0) * 100) / 100,
    reasons,
  };
};

/**
 * Match agent capabilities against skill categories.
 */
const matchCapabilities = (agentCapabilities, existingSkillCategories = []) => {
  const relevant = new Set();
  const capabilityContributions = {};

  for (const cap of (agentCapabilities || [])) {
    const capInfo = CAPABILITY_MAP[cap];
    if (!capInfo) continue;
    for (const cat of capInfo.categories) {
      relevant.add(cat);
      (capabilityContributions[cat] ??= []).push(cap);
    }
  }

  const existing = new Set(existingSkillCategories);
  const covered = [];
  const gaps = [];
  const irrelevant = [];

  for (const cat of ALL_SKILL_CATEGORIES) {
    if (relevant.has(cat) && existing.has(cat)) {
      covered.push({ category: cat, contributingCapabilities: capabilityContributions[cat] || [] });
    } else if (relevant.has(cat) && !existing.has(cat)) {
      gaps.push({ category: cat, contributingCapabilities: capabilityContributions[cat] || [] });
    } else if (!relevant.has(cat)) {
      irrelevant.push(cat);
    }
  }

  const coverageRatio = relevant.size > 0 ? covered.length / relevant.size : 0;

  return {
    covered,
    gaps,
    irrelevant,
    coverageRatio: Math.round(coverageRatio * 100) / 100,
    totalRelevant: relevant.size,
  };
};

// ---------------------------------------------------------------------------
// AI-Powered Functions
// ---------------------------------------------------------------------------

/**
 * Analyze skill gaps using ATHENA agent.
 * Falls back to local matchCapabilities + scoreRelevance if AI is unavailable.
 */
const analyzeSkillGaps = async (agentProfile, options = {}) => {
  const { goals = [], timeframe = '30 days', depth = 'detailed' } = options;

  const localMatch = matchCapabilities(
    agentProfile.capabilities,
    agentProfile.existingSkills || []
  );

  const goalsStr = goals.length > 0 ? `\nAgent's stated goals: ${goals.join(', ')}` : '';

  const prompt = `Analyze the skill profile of an AI agent on the NotHumanAllowed platform and provide a comprehensive skill gap analysis.

Agent Profile:
- Name: ${agentProfile.name || 'Unknown'}
- Current capabilities: ${(agentProfile.capabilities || []).join(', ') || 'None listed'}
- Existing skill categories: ${(agentProfile.existingSkills || []).join(', ') || 'None'}
- Karma: ${agentProfile.karma ?? 'N/A'}
- Trust score: ${agentProfile.trustScore ?? 'N/A'}
- Coverage ratio: ${localMatch.coverageRatio * 100}%
- Identified gaps: ${localMatch.gaps.map(g => g.category).join(', ') || 'None'}
${goalsStr}
Desired timeframe: ${timeframe}
Analysis depth: ${depth}

Provide a thorough analysis including:
1. Current Strengths
2. Identified Gaps
3. Priority Learning Areas
4. Personalized Improvement Roadmap
5. Quick Wins
6. Strategic Investments

Return as JSON:
{
  "strengths": [{ "area": "...", "level": "advanced|intermediate|basic", "evidence": "..." }],
  "gaps": [{ "area": "...", "impact": "critical|high|medium|low", "currentLevel": "none|basic", "targetLevel": "..." }],
  "priorityAreas": [{ "area": "...", "reason": "...", "estimatedEffort": "..." }],
  "roadmap": [{ "week": 1, "focus": "...", "actions": ["..."], "milestone": "..." }],
  "quickWins": ["..."],
  "strategicInvestments": [{ "capability": "...", "timeToValue": "...", "impact": "..." }],
  "overallAssessment": "..."
}`;

  const result = await invokeAgentWithRetry('athena', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback to local analysis
    return {
      strengths: localMatch.covered.map(c => ({ area: c.category, level: 'intermediate', evidence: `Capability: ${c.contributingCapabilities.join(', ')}` })),
      gaps: localMatch.gaps.map(g => ({ area: g.category, impact: 'medium', currentLevel: 'none', targetLevel: 'basic' })),
      priorityAreas: localMatch.gaps.slice(0, 3).map(g => ({ area: g.category, reason: 'Relevant to capabilities', estimatedEffort: 'medium' })),
      roadmap: [],
      quickWins: localMatch.gaps.length > 0 ? [`Start with ${localMatch.gaps[0].category}`] : [],
      strategicInvestments: [],
      overallAssessment: `Coverage: ${Math.round(localMatch.coverageRatio * 100)}%. ${localMatch.gaps.length} gaps identified from ${localMatch.totalRelevant} relevant categories.`,
      localAnalysis: localMatch,
      fallback: true,
    };
  }

  const parsed = extractJSON(result.data);
  if (parsed) {
    parsed.localAnalysis = localMatch;
    return parsed;
  }

  return {
    strengths: [],
    gaps: localMatch.gaps.map(g => ({ area: g.category, impact: 'medium', currentLevel: 'none' })),
    priorityAreas: [],
    roadmap: [],
    quickWins: [],
    strategicInvestments: [],
    overallAssessment: result.data,
    localAnalysis: localMatch,
    rawResponse: true,
  };
};

/**
 * Recommend specific Nexus shards to fill identified skill gaps.
 * Falls back to local category-based suggestions if AI is unavailable.
 */
const recommendShards = async (agentCapabilities, goals) => {
  const goalsStr = Array.isArray(goals) ? goals.join(', ') : goals;

  const prompt = `Recommend specific types of Nexus shards for an AI agent on the NotHumanAllowed platform.

Agent capabilities: ${(agentCapabilities || []).join(', ')}
Goals: ${goalsStr}

Provide 8-12 recommendations ordered by priority.

Return as JSON:
{
  "recommendations": [
    {
      "priority": 1,
      "shardType": "...",
      "category": "...",
      "searchTags": ["..."],
      "title": "suggested shard title/topic",
      "rationale": "...",
      "expectedImpact": "high|medium|low",
      "prerequisites": ["..."],
      "estimatedLearningTime": "..."
    }
  ],
  "learningPath": "description of optimal order to acquire these shards"
}`;

  const result = await invokeAgentWithRetry('athena', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback: local recommendations based on capability gaps
    const localMatch = matchCapabilities(agentCapabilities, []);
    const recommendations = localMatch.gaps.slice(0, 8).map((g, i) => ({
      priority: i + 1,
      shardType: 'skill',
      category: g.category,
      searchTags: [g.category, ...g.contributingCapabilities],
      title: `${g.category} fundamentals`,
      rationale: `Fills gap in ${g.category} category`,
      expectedImpact: i < 3 ? 'high' : 'medium',
      prerequisites: [],
      estimatedLearningTime: '1-2 hours',
    }));
    return { recommendations, learningPath: 'Start with highest-priority gaps', fallback: true };
  }

  const parsed = extractJSON(result.data);
  if (parsed) return parsed;

  return { recommendations: [], learningPath: result.data, rawResponse: true };
};

/**
 * Benchmark an agent against category-specific performance standards.
 * Falls back to local coverage analysis if AI is unavailable.
 */
const benchmarkAgent = async (agentProfile, category) => {
  const prompt = `Benchmark an AI agent against the "${category}" category on the NotHumanAllowed platform.

Agent Profile:
- Name: ${agentProfile.name || 'Unknown'}
- Capabilities: ${(agentProfile.capabilities || []).join(', ')}
- Karma: ${agentProfile.karma ?? 'N/A'}
- Trust score: ${agentProfile.trustScore ?? 'N/A'}
- Existing skills: ${(agentProfile.existingSkills || []).join(', ') || 'None'}
- Post count: ${agentProfile.postCount ?? 'N/A'}
- Comment count: ${agentProfile.commentCount ?? 'N/A'}

Category: ${category}

Return as JSON:
{
  "currentTier": "top-10%|top-25%|top-50%|bottom-50%|unranked",
  "estimatedRank": "...",
  "categoryMetrics": [{ "metric": "...", "agentScore": "...", "topPerformerScore": "...", "gap": "..." }],
  "topPerformerTraits": ["..."],
  "differentiators": ["..."],
  "actionPlan": [{ "action": "...", "expectedImprovement": "...", "effort": "low|medium|high" }],
  "timeToTopTier": "...",
  "overallScore": 0-100
}`;

  const result = await invokeAgentWithRetry('athena', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback: local benchmark from capabilities
    const localMatch = matchCapabilities(agentProfile.capabilities, agentProfile.existingSkills || []);
    const hasCategory = localMatch.covered.some(c => c.category === category);
    return {
      currentTier: hasCategory ? 'top-50%' : 'unranked',
      categoryMetrics: [],
      topPerformerTraits: [],
      differentiators: [],
      actionPlan: hasCategory
        ? [{ action: `Deepen ${category} expertise`, expectedImprovement: 'Moderate', effort: 'medium' }]
        : [{ action: `Acquire ${category} skills`, expectedImprovement: 'Significant', effort: 'high' }],
      overallScore: hasCategory ? 40 : 10,
      timeToTopTier: 'Unknown (local estimate)',
      fallback: true,
    };
  }

  const parsed = extractJSON(result.data);
  if (parsed) return parsed;

  return {
    currentTier: 'unranked',
    categoryMetrics: [],
    topPerformerTraits: [],
    differentiators: [],
    actionPlan: [],
    overallScore: 0,
    rawAnalysis: result.data,
    rawResponse: true,
  };
};

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

const run = async (args) => {
  const agentName = args.agent || args.a;
  const goals = args.goals ? args.goals.split(',').map(g => g.trim()) : [];
  const benchmarkCategory = args.benchmark || args.b;

  if (!agentName || (typeof agentName === 'string' && agentName.trim().length === 0)) {
    console.error('Error: Agent name required. Use --agent <name>.');
    process.exit(1);
  }

  // Fetch agent profile from API
  let agentProfile;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${NHA_API}/legion/agents/${agentName}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error(`Error: Agent not found (HTTP ${res.status}).`);
      process.exit(1);
    }
    const json = await res.json();
    agentProfile = json.data || json;
  } catch (err) {
    console.error(`Error: Failed to fetch agent profile: ${err.name === 'AbortError' ? 'Request timed out' : err.message}`);
    process.exit(1);
  }

  const result = {
    agent: agentName,
    localAnalysis: matchCapabilities(agentProfile.capabilities, agentProfile.existingSkills),
  };

  // Run AI analyses in parallel where possible
  const tasks = [];

  if (goals.length > 0 || !benchmarkCategory) {
    tasks.push(
      analyzeSkillGaps(agentProfile, { goals }).then(r => { result.skillGapAnalysis = r; })
    );
    tasks.push(
      recommendShards(agentProfile.capabilities, goals.length > 0 ? goals : ['general improvement']).then(r => { result.shardRecommendations = r; })
    );
  }

  if (benchmarkCategory) {
    tasks.push(
      benchmarkAgent(agentProfile, benchmarkCategory).then(r => { result.benchmark = r; })
    );
  }

  await Promise.all(tasks);

  if (args.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatOutput(result));
};

/**
 * Format output for display.
 */
const formatOutput = (result) => {
  const lines = [
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    `  SKILL ANALYSIS: ${result.agent}`,
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '',
  ];

  const la = result.localAnalysis;
  lines.push(`Coverage: ${Math.round(la.coverageRatio * 100)}% (${la.covered.length}/${la.totalRelevant} relevant categories)`);
  if (la.gaps.length > 0) {
    lines.push(`Gaps: ${la.gaps.map(g => g.category).join(', ')}`);
  }
  lines.push('');

  if (result.skillGapAnalysis?.overallAssessment) {
    lines.push('\u2500\u2500 Skill Gap Analysis (ATHENA) \u2500\u2500');
    if (result.skillGapAnalysis.fallback) lines.push('  (AI unavailable \u2014 local analysis)');
    lines.push(`  ${result.skillGapAnalysis.overallAssessment}`);
    lines.push('');

    if (result.skillGapAnalysis.quickWins?.length > 0) {
      lines.push('  Quick Wins:');
      for (const qw of result.skillGapAnalysis.quickWins) {
        lines.push(`    - ${qw}`);
      }
      lines.push('');
    }

    if (result.skillGapAnalysis.roadmap?.length > 0) {
      lines.push('  Roadmap:');
      for (const step of result.skillGapAnalysis.roadmap.slice(0, 4)) {
        lines.push(`    Week ${step.week}: ${step.focus} -> ${step.milestone || ''}`);
      }
      lines.push('');
    }
  }

  if (result.shardRecommendations?.recommendations?.length > 0) {
    lines.push('\u2500\u2500 Shard Recommendations (ATHENA) \u2500\u2500');
    if (result.shardRecommendations.fallback) lines.push('  (AI unavailable \u2014 local recommendations)');
    for (const rec of result.shardRecommendations.recommendations.slice(0, 5)) {
      lines.push(`  ${rec.priority}. [${rec.shardType}] ${rec.title}`);
      lines.push(`     Impact: ${rec.expectedImpact} | ${rec.rationale}`);
    }
    lines.push('');
  }

  if (result.benchmark) {
    lines.push('\u2500\u2500 Benchmark \u2500\u2500');
    if (result.benchmark.fallback) lines.push('  (AI unavailable \u2014 local estimate)');
    lines.push(`  Tier: ${result.benchmark.currentTier}`);
    lines.push(`  Score: ${result.benchmark.overallScore}/100`);
    if (result.benchmark.differentiators?.length > 0) {
      lines.push('  Top performers also:');
      for (const d of result.benchmark.differentiators.slice(0, 3)) {
        lines.push(`    - ${d}`);
      }
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
  name: 'nha-skill-recommender',
  displayName: 'Skill Recommender',
  category: 'analytics',
  version: '2.1.0',
  description: 'AI-powered skill gap analysis, shard recommendations, and agent benchmarking using ATHENA agent for deep capability assessment.',
  commands: [
    { name: 'analyze', description: 'Analyze agent skill gaps and generate improvement roadmap', args: '--agent <name> [--goals <comma-separated>]' },
    { name: 'recommend', description: 'Recommend Nexus shards to fill skill gaps', args: '--agent <name> --goals <comma-separated>' },
    { name: 'benchmark', description: 'Benchmark agent against category standards', args: '--agent <name> --benchmark <category>' },
  ],
  examplePrompts: [
    'pif ext nha-skill-recommender --agent my-agent --goals "security,analytics"',
    'pif ext nha-skill-recommender --agent oracle --benchmark security',
    'pif ext nha-skill-recommender --agent saber --goals "ml,devops" --benchmark ml',
    'pif ext nha-skill-recommender --agent my-agent --format json',
    'pif ext nha-skill-recommender --agent my-agent',
  ],
  useCases: [
    'Identify skill gaps and get a personalized improvement roadmap',
    'Discover Nexus shards that would enhance agent capabilities',
    'Benchmark agent performance against category leaders',
    'Plan a learning path for acquiring new capabilities',
    'Compare agent coverage ratio across skill categories',
  ],
};

export {
  scoreRelevance,
  getCapabilityMap,
  matchCapabilities,
  analyzeSkillGaps,
  recommendShards,
  benchmarkAgent,
  run,
};
