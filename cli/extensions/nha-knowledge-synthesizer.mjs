/**
 * nha-knowledge-synthesizer — PIF Extension v2.1.0
 *
 * Synthesizes multiple perspectives into coherent consensus.
 * Extracts themes, finds contradictions, weights by quality, and generates
 * structured synthesis. AI-powered deep synthesis via ORACLE + LOGOS agents.
 *
 * @category analytics
 * @version 2.1.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   // Local synthesis
 *   import { extractThemes, findContradictions, generateSynthesis } from './extensions/nha-knowledge-synthesizer.mjs';
 *   const synthesis = generateSynthesis(problem, contributions);
 *
 * @example
 *   // AI-powered deep synthesis
 *   import { deepSynthesis, identifyCruxes } from './extensions/nha-knowledge-synthesizer.mjs';
 *   const result = await deepSynthesis(contributions, { depth: 'thorough', includeResolutions: true });
 *
 * @example
 *   // CLI usage
 *   pif ext nha-knowledge-synthesizer --input ./contributions.json --depth thorough --resolve
 *   pif ext nha-knowledge-synthesizer --input ./debate.json --depth quick
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
// Local pure functions — fast, no network
// ---------------------------------------------------------------------------

/** @type {string[]} Stop words for theme extraction */
const STOP_WORDS = [
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'some', 'them',
  'than', 'its', 'over', 'also', 'that', 'this', 'with', 'from', 'they',
  'will', 'each', 'make', 'like', 'just', 'very', 'when', 'what', 'your',
  'which', 'their', 'would', 'there', 'could', 'other', 'about', 'into',
  'more', 'should', 'these', 'being', 'does', 'most', 'only',
];

/**
 * Extract themes from a set of contributions using word frequency analysis.
 * @param {Array<{content: string, agentName?: string, agentId?: string}>} contributions
 * @returns {Array<{theme: string, frequency: number, contributors: number, agents: string[], relevanceScore: number}>}
 */
const extractThemes = (contributions) => {
  if (!contributions || contributions.length === 0) return [];

  const phrases = {};

  for (let i = 0; i < contributions.length; i++) {
    const c = contributions[i];
    const text = (c.content || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const words = text.split(/\s+/).filter((w) => w.length > 3 && !STOP_WORDS.includes(w));
    const agentKey = c.agentName || c.agentId || `agent_${i}`;

    for (const word of words) {
      if (!phrases[word]) phrases[word] = { count: 0, agents: [], score: 0 };
      phrases[word].count++;
      if (!phrases[word].agents.includes(agentKey)) {
        phrases[word].agents.push(agentKey);
      }
    }

    for (let k = 0; k < words.length - 1; k++) {
      const bigram = `${words[k]} ${words[k + 1]}`;
      if (!phrases[bigram]) phrases[bigram] = { count: 0, agents: [], score: 0 };
      phrases[bigram].count++;
      if (!phrases[bigram].agents.includes(agentKey)) {
        phrases[bigram].agents.push(agentKey);
      }
    }
  }

  const themes = [];
  for (const [key, entry] of Object.entries(phrases)) {
    if (entry.agents.length >= 2 || entry.count >= 3) {
      entry.score = entry.count * entry.agents.length;
      themes.push({
        theme: key,
        frequency: entry.count,
        contributors: entry.agents.length,
        agents: entry.agents,
        relevanceScore: Math.round(entry.score * 10) / 10,
      });
    }
  }

  themes.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return themes.slice(0, 15);
};

/**
 * Find contradictions between contributions.
 * @param {Array<{content: string, agentName?: string, agentId?: string, contributionType?: string}>} contributions
 * @returns {Array<{between: string[], type: string, severity: string, summaryA: string, summaryB: string}>}
 */
const findContradictions = (contributions) => {
  if (!contributions || contributions.length < 2) return [];

  const contradictions = [];
  const negationWords = ['not', 'never', 'impossible', 'wrong', 'incorrect', 'disagree', 'instead', 'however', 'contrary', 'opposite', 'unlikely', 'avoid', 'reject'];
  const positiveWords = ['should', 'recommend', 'best', 'optimal', 'correct', 'agree', 'support', 'prefer', 'ideal'];

  for (let i = 0; i < contributions.length; i++) {
    for (let j = i + 1; j < contributions.length; j++) {
      const a = contributions[i];
      const b = contributions[j];
      const textA = (a.content || '').toLowerCase();
      const textB = (b.content || '').toLowerCase();
      const nameA = a.agentName || a.agentId || `agent_${i}`;
      const nameB = b.agentName || b.agentId || `agent_${j}`;

      if (a.contributionType === 'objection' || b.contributionType === 'objection') {
        contradictions.push({
          between: [nameA, nameB],
          type: 'explicit_objection',
          severity: 'high',
          summaryA: (a.content || '').slice(0, 100),
          summaryB: (b.content || '').slice(0, 100),
        });
        continue;
      }

      let aNeg = 0, bNeg = 0, aPos = 0, bPos = 0;
      for (const nw of negationWords) {
        if (textA.includes(nw)) aNeg++;
        if (textB.includes(nw)) bNeg++;
      }
      for (const pw of positiveWords) {
        if (textA.includes(pw)) aPos++;
        if (textB.includes(pw)) bPos++;
      }

      if ((aNeg > aPos && bPos > bNeg) || (bNeg > bPos && aPos > aNeg)) {
        contradictions.push({
          between: [nameA, nameB],
          type: 'sentiment_divergence',
          severity: 'medium',
          summaryA: (a.content || '').slice(0, 100),
          summaryB: (b.content || '').slice(0, 100),
        });
      }
    }
  }

  return contradictions;
};

/**
 * Weight contributions by quality.
 * @param {Array} contributions
 * @returns {Array<{id: string, agentName: string, type: string, voteScore: number, weight: number, content: string}>}
 */
const weightByQuality = (contributions) => {
  if (!contributions || contributions.length === 0) return [];

  let maxScore = 0;
  for (const c of contributions) {
    if (Math.abs(c.voteScore || 0) > maxScore) {
      maxScore = Math.abs(c.voteScore || 0);
    }
  }
  if (maxScore === 0) maxScore = 1;

  const weighted = contributions.map((c) => {
    const content = c.content || '';
    const voteWeight = ((c.voteScore || 0) + maxScore) / (2 * maxScore);
    const lengthFactor = Math.min(content.length / 1000, 1);
    let structureFactor = 0;
    if (content.includes('\n')) structureFactor += 0.3;
    if (/example/i.test(content)) structureFactor += 0.2;
    if (/because|reason/i.test(content)) structureFactor += 0.2;
    const richness = Math.min(lengthFactor * 0.5 + structureFactor, 1);

    let typeBonus = 0;
    if (c.contributionType === 'evidence') typeBonus = 0.15;
    if (c.contributionType === 'objection') typeBonus = 0.1;

    const totalWeight = Math.round(Math.min(voteWeight * 0.5 + richness * 0.35 + typeBonus + 0.15, 1) * 100) / 100;

    return {
      id: c.id || '',
      agentName: c.agentName || c.agentId || 'unknown',
      type: c.contributionType || 'contribution',
      voteScore: c.voteScore || 0,
      weight: totalWeight,
      content,
    };
  });

  weighted.sort((a, b) => b.weight - a.weight);
  return weighted;
};

/**
 * Generate a structured synthesis text from problem and contributions.
 * @param {{title?: string, problemType?: string}} problem
 * @param {Array} contributions
 * @returns {string}
 */
const generateSynthesis = (problem, contributions) => {
  const themes = extractThemes(contributions);
  const contradictions = findContradictions(contributions);
  const weighted = weightByQuality(contributions);

  const parts = [];

  parts.push('CONSENSUS SYNTHESIS');
  parts.push('===================');
  parts.push(`Problem: ${problem.title || 'Untitled'}`);
  parts.push(`Type: ${problem.problemType || 'general'}`);
  parts.push(`Contributions analyzed: ${contributions.length}`);
  parts.push('');

  if (themes.length > 0) {
    parts.push('KEY THEMES:');
    for (const t of themes.slice(0, 5)) {
      parts.push(`  - ${t.theme} (mentioned by ${t.contributors} agents, ${t.frequency} times)`);
    }
    parts.push('');
  }

  if (weighted.length > 0) {
    parts.push('TOP CONTRIBUTIONS (by quality weight):');
    for (const w of weighted.slice(0, 5)) {
      parts.push('');
      parts.push(`  [${w.type.toUpperCase()}] Weight: ${w.weight}  Score: ${w.voteScore}`);
      parts.push(`  By: ${w.agentName}`);
      parts.push(`  ${w.content.slice(0, 300)}${w.content.length > 300 ? '...' : ''}`);
    }
    parts.push('');
  }

  if (contradictions.length > 0) {
    parts.push('POINTS OF DISAGREEMENT:');
    for (const con of contradictions) {
      parts.push(`  - ${con.between[0]} vs ${con.between[1]} (${con.type}, severity: ${con.severity})`);
    }
    parts.push('');
  }

  let avgWeight = 0;
  for (const w of weighted) avgWeight += w.weight;
  avgWeight = weighted.length > 0 ? Math.round((avgWeight / weighted.length) * 100) / 100 : 0;

  parts.push('SYNTHESIS METRICS:');
  parts.push(`  Average quality weight: ${avgWeight}`);
  parts.push(`  Theme diversity: ${themes.length} distinct themes`);
  parts.push(`  Contradictions found: ${contradictions.length}`);
  parts.push(`  Consensus strength: ${contradictions.length === 0 ? 'Strong' : contradictions.length <= 2 ? 'Moderate' : 'Weak'}`);

  return parts.join('\n');
};

// ---------------------------------------------------------------------------
// AI-powered functions — require network
// ---------------------------------------------------------------------------

/**
 * Deep synthesis using ORACLE for semantic analysis and LOGOS for logical validation.
 * Falls back to local generateSynthesis if AI is unavailable.
 * @param {Array<{content: string, agentName?: string, contributionType?: string}>} contributions
 * @param {object} [options]
 * @param {'quick'|'thorough'} [options.depth='quick']
 * @param {boolean} [options.includeResolutions=true]
 * @returns {Promise<{ok: boolean, synthesis?: object, error?: string}>}
 */
const deepSynthesis = async (contributions, options = {}) => {
  const { depth = 'quick', includeResolutions = true } = options;

  if (!contributions || contributions.length === 0) {
    return { ok: false, error: 'No contributions provided for synthesis' };
  }

  // Local pre-processing
  const localThemes = extractThemes(contributions);
  const localContradictions = findContradictions(contributions);
  const localWeighted = weightByQuality(contributions);

  const contributionText = contributions.map((c, i) =>
    `[${c.agentName || `Agent ${i + 1}`}] (type: ${c.contributionType || 'contribution'})\n${c.content}`
  ).join('\n\n---\n\n');

  const localContext = [
    `Local analysis detected:`,
    `- ${localThemes.length} themes (top: ${localThemes.slice(0, 3).map((t) => t.theme).join(', ')})`,
    `- ${localContradictions.length} contradictions`,
    `- Average quality weight: ${localWeighted.length > 0 ? Math.round(localWeighted.reduce((s, w) => s + w.weight, 0) / localWeighted.length * 100) / 100 : 0}`,
  ].join('\n');

  // ORACLE: semantic analysis
  const oraclePrompt = [
    `You are a semantic analysis engine. Perform a ${depth === 'thorough' ? 'deep, exhaustive' : 'concise but insightful'} synthesis of the following ${contributions.length} contributions.`,
    ``,
    localContext,
    ``,
    `Analyze and return ONLY valid JSON:`,
    `{`,
    `  "epistemic_cruxes": [`,
    `    { "crux": "<fundamental disagreement>", "positions": ["<position A>", "<position B>"], "importance": <1-10> }`,
    `  ],`,
    `  "semantic_clusters": [`,
    `    { "cluster": "<theme>", "agents": ["<agent names>"], "coherence": <0-100> }`,
    `  ],`,
    `  "quality_ranking": [`,
    `    { "agent": "<name>", "semantic_depth": <0-100>, "evidence_quality": <0-100> }`,
    `  ],`,
    `  "consensus_areas": ["<point of agreement>"],`,
    `  "divergence_areas": ["<point of disagreement>"],`,
    `  "overall_coherence": <0-100>,`,
    `  "synthesis_narrative": "<${depth === 'thorough' ? '300-500' : '100-200'} word synthesis>"`,
    `}`,
    ``,
    `--- CONTRIBUTIONS ---`,
    contributionText,
  ].join('\n');

  const oracleResult = await invokeAgentWithRetry('ORACLE', oraclePrompt, { includeSubAgents: false });

  let oracleAnalysis = null;
  if (oracleResult.ok) {
    oracleAnalysis = extractJSON(oracleResult.data);
  }

  // LOGOS: logical validation (only for thorough depth or when contradictions exist)
  let logosValidation = null;
  if (depth === 'thorough' || localContradictions.length > 0) {
    const logosPrompt = [
      `You are a logical validation engine. Examine the following contributions for logical consistency.`,
      ``,
      `Check for:`,
      `1. Formal logical contradictions (P and NOT P)`,
      `2. Hidden assumptions that undermine conclusions`,
      `3. Circular reasoning`,
      `4. Non-sequiturs`,
      `5. Straw man arguments between contributors`,
      ``,
      `Return ONLY valid JSON:`,
      `{`,
      `  "logical_issues": [`,
      `    { "type": "<contradiction|assumption|circular|non_sequitur|straw_man>", "description": "<string>", "involved_agents": ["<names>"], "severity": "low" | "medium" | "high" }`,
      `  ],`,
      `  "valid_arguments": [`,
      `    { "agent": "<name>", "argument": "<summary>", "validity": <0-100> }`,
      `  ],`,
      `  "overall_logical_soundness": <0-100>`,
      `}`,
      ``,
      `--- CONTRIBUTIONS ---`,
      contributionText,
    ].join('\n');

    const logosResult = await invokeAgentWithRetry('LOGOS', logosPrompt, { includeSubAgents: false });
    if (logosResult.ok) {
      logosValidation = extractJSON(logosResult.data);
    }
  }

  // Resolution proposals
  let resolutions = [];
  if (includeResolutions && oracleAnalysis?.epistemic_cruxes?.length > 0) {
    for (const crux of oracleAnalysis.epistemic_cruxes.slice(0, 3)) {
      if (crux.positions && crux.positions.length >= 2) {
        const resolution = await resolveContradiction(crux.positions[0], crux.positions[1]);
        if (resolution.ok) {
          resolutions.push({
            crux: crux.crux,
            resolution: resolution.resolution,
          });
        }
      }
    }
  }

  return {
    ok: true,
    synthesis: {
      local: {
        themes: localThemes,
        contradictions: localContradictions,
        weighted: localWeighted.slice(0, 10),
      },
      oracle: oracleAnalysis,
      logos: logosValidation,
      resolutions,
      meta: {
        depth,
        contributionCount: contributions.length,
        oracleAvailable: oracleAnalysis !== null,
        logosAvailable: logosValidation !== null,
        resolutionCount: resolutions.length,
        oracleDurationMs: oracleResult.durationMs || 0,
      },
    },
  };
};

/**
 * Use LOGOS to find the fundamental disagreements that, if resolved, would change conclusions.
 * Falls back to local findContradictions if AI is unavailable.
 * @param {Array<{agent?: string, position: string}>} positions
 * @returns {Promise<{ok: boolean, cruxes?: Array, error?: string, fallback?: boolean}>}
 */
const identifyCruxes = async (positions) => {
  if (!positions || positions.length < 2) {
    return { ok: false, error: 'At least 2 positions required to identify cruxes' };
  }

  const positionText = positions.map((p, i) =>
    `[${p.agent || `Position ${i + 1}`}]: ${p.position}`
  ).join('\n\n');

  const prompt = [
    `You are an epistemic analyst. Identify the fundamental disagreements (epistemic cruxes) in the following positions.`,
    ``,
    `An epistemic crux is a specific factual or value claim where:`,
    `- The parties disagree`,
    `- Resolving the disagreement would change at least one party's conclusion`,
    `- It is, in principle, resolvable with evidence or reasoning`,
    ``,
    `Return ONLY valid JSON:`,
    `{`,
    `  "cruxes": [`,
    `    {`,
    `      "crux": "<the fundamental disagreement in one sentence>",`,
    `      "positions": ["<side A stance>", "<side B stance>"],`,
    `      "importance": <1-10>,`,
    `      "resolution_path": "<how this could be resolved: experiment, data, logical analysis, etc.>"`,
    `    }`,
    `  ],`,
    `  "meta_observation": "<one-paragraph analysis of WHY these parties disagree>"`,
    `}`,
    ``,
    `--- POSITIONS ---`,
    positionText,
  ].join('\n');

  const result = await invokeAgentWithRetry('LOGOS', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback: local contradiction detection
    const contributions = positions.map(p => ({ content: p.position, agentName: p.agent }));
    const contradictions = findContradictions(contributions);
    const cruxes = contradictions.map(c => ({
      crux: `Disagreement between ${c.between[0]} and ${c.between[1]}`,
      positions: [c.summaryA, c.summaryB],
      importance: c.severity === 'high' ? 8 : 5,
      resolution_path: 'Requires deeper analysis',
    }));
    return { ok: true, cruxes, fallback: true };
  }

  const parsed = extractJSON(result.data);
  if (!parsed) return { ok: false, error: 'LOGOS did not return valid JSON' };
  return {
    ok: true,
    cruxes: parsed.cruxes || [],
    metaObservation: parsed.meta_observation,
    durationMs: result.durationMs,
  };
};

/**
 * Use LOGOS to propose a resolution between two opposing positions.
 * Falls back to a local neutral summary if AI is unavailable.
 * @param {string} positionA
 * @param {string} positionB
 * @returns {Promise<{ok: boolean, resolution?: string, error?: string, fallback?: boolean}>}
 */
const resolveContradiction = async (positionA, positionB) => {
  const prompt = [
    `You are a logical mediator. Two positions are in contradiction. Propose a resolution.`,
    ``,
    `Requirements:`,
    `1. Identify the precise point of disagreement`,
    `2. Evaluate the strongest version of each position (steelman both)`,
    `3. Propose a resolution that either:`,
    `   a) Synthesizes both positions into a higher-order truth`,
    `   b) Identifies which position is better supported and why`,
    `   c) Shows they are not actually contradictory (if applicable)`,
    `4. Provide supporting reasoning for your resolution`,
    ``,
    `Be rigorous and fair. Do NOT simply split the difference.`,
    ``,
    `Position A: ${positionA}`,
    ``,
    `Position B: ${positionB}`,
  ].join('\n');

  const result = await invokeAgentWithRetry('LOGOS', prompt, { includeSubAgents: false });
  if (!result.ok) {
    return {
      ok: true,
      resolution: `Position A: "${positionA.slice(0, 100)}..." vs Position B: "${positionB.slice(0, 100)}..." — Resolution requires deeper analysis.`,
      fallback: true,
    };
  }
  return { ok: true, resolution: result.data, durationMs: result.durationMs };
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI runner for the knowledge synthesizer extension.
 * @param {object} args
 */
const run = async (args) => {
  const inputPath = args.input || args._?.[0];

  if (!inputPath || (typeof inputPath === 'string' && inputPath.trim().length === 0)) {
    console.error('Error: --input <path-to-json> is required. JSON should contain { problem?: {...}, contributions: [...] }');
    process.exit(1);
  }

  let data;
  try {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(inputPath, 'utf-8');
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Error reading input file: ${err.message}`);
    process.exit(1);
  }

  const contributions = data.contributions || data;
  const problem = data.problem || { title: 'Unknown', problemType: 'general' };
  const depth = args.depth || 'quick';
  const includeResolutions = args.resolve === true || args.resolve === 'true';

  if (!Array.isArray(contributions) || contributions.length === 0) {
    console.error('Error: Input must contain a non-empty "contributions" array.');
    process.exit(1);
  }

  // Local synthesis first
  console.log('--- Local Synthesis ---\n');
  console.log(generateSynthesis(problem, contributions));
  console.log('');

  // AI deep synthesis
  console.log(`--- AI Deep Synthesis (depth: ${depth}, agents: ORACLE + LOGOS) ---\n`);
  const result = await deepSynthesis(contributions, { depth, includeResolutions });

  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  const { synthesis } = result;

  if (synthesis.oracle) {
    console.log('ORACLE Semantic Analysis:');
    if (synthesis.oracle.synthesis_narrative) {
      console.log(`  ${synthesis.oracle.synthesis_narrative}`);
    }
    console.log(`  Overall coherence: ${synthesis.oracle.overall_coherence}/100`);
    if (synthesis.oracle.epistemic_cruxes?.length > 0) {
      console.log(`  Epistemic cruxes: ${synthesis.oracle.epistemic_cruxes.length}`);
      for (const crux of synthesis.oracle.epistemic_cruxes) {
        console.log(`    - ${crux.crux} (importance: ${crux.importance}/10)`);
      }
    }
    console.log('');
  } else {
    console.log('ORACLE: Unavailable (using local analysis only)\n');
  }

  if (synthesis.logos) {
    console.log('LOGOS Logical Validation:');
    console.log(`  Logical soundness: ${synthesis.logos.overall_logical_soundness}/100`);
    if (synthesis.logos.logical_issues?.length > 0) {
      console.log(`  Issues found: ${synthesis.logos.logical_issues.length}`);
      for (const issue of synthesis.logos.logical_issues) {
        console.log(`    - [${issue.severity}] ${issue.type}: ${issue.description}`);
      }
    }
    console.log('');
  }

  if (synthesis.resolutions?.length > 0) {
    console.log('Proposed Resolutions:');
    for (const r of synthesis.resolutions) {
      console.log(`\n  Crux: ${r.crux}`);
      console.log(`  Resolution: ${r.resolution}`);
    }
    console.log('');
  }

  console.log(`--- Meta: ORACLE ${synthesis.meta.oracleAvailable ? 'OK' : 'UNAVAILABLE'}, LOGOS ${synthesis.meta.logosAvailable ? 'OK' : 'UNAVAILABLE'}, ${synthesis.meta.resolutionCount} resolutions, ${synthesis.meta.oracleDurationMs}ms ---`);
};

// ---------------------------------------------------------------------------
// Extension metadata
// ---------------------------------------------------------------------------

export const EXTENSION_META = {
  name: 'nha-knowledge-synthesizer',
  displayName: 'Knowledge Synthesizer',
  category: 'analytics',
  version: '2.1.0',
  description: 'Synthesize multiple agent perspectives into coherent consensus using local theme extraction, contradiction detection, and quality weighting, enhanced with AI-powered deep analysis via ORACLE (semantic) + LOGOS (logical validation). Identifies epistemic cruxes and proposes contradiction resolutions.',
  commands: [
    { name: 'synthesize', description: 'Run full synthesis pipeline', args: '--input <json-path> --depth <quick|thorough> [--resolve]' },
    { name: 'cruxes', description: 'Identify epistemic cruxes between positions', args: '--input <json-path>' },
    { name: 'resolve', description: 'Resolve a specific contradiction', args: '--input <json-path> --resolve' },
  ],
  examplePrompts: [
    'Synthesize 5 agent perspectives on zero-trust architecture into a consensus',
    'Find the fundamental epistemic cruxes in a debate about LLM safety',
    'Resolve the contradiction between two agents on prompt injection defense',
    'Run a thorough deep synthesis with ORACLE semantic analysis and LOGOS validation',
    'Generate a weighted consensus from deliberation round contributions',
  ],
  useCases: [
    'Post-deliberation synthesis for Geth Consensus sessions',
    'Identifying fundamental disagreements in multi-agent debates',
    'Resolving contradictions with structured logical mediation',
    'Quality-weighted aggregation of diverse agent perspectives',
    'Epistemic crux analysis for targeted follow-up deliberations',
  ],
};

export {
  extractThemes,
  findContradictions,
  weightByQuality,
  generateSynthesis,
  deepSynthesis,
  identifyCruxes,
  resolveContradiction,
  run,
};
