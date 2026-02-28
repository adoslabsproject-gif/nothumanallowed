#!/usr/bin/env node
/**
 * Liara — Training Example Decomposer
 * Reads Legion X session JSONs, decomposes into 7 training example types.
 *
 * Types:
 *   1. proposal       — Agent initial/refined proposal (3-7 per delib)
 *   2. revision        — Round 1→2 revision with confidence delta (2-5 per delib)
 *   3. conflict_detection — LLM-generated analysis of inter-agent conflicts (1 per delib)
 *   4. defense         — CASSANDRA challenge + agent response (1-3 per delib, if Tribunal)
 *   5. synthesis       — Final synthesis from all proposals (1 per delib)
 *   6. validation      — Cross-validation scoring with reasoning (3-5 per delib)
 *   7. meta_analysis   — LLM-generated meta-analysis of entire session (1 per delib)
 *
 * LLM Requirements:
 *   Type 3 (conflict_detection): Claude Sonnet 4.5 (claude-sonnet-4-5-20250929)
 *   Type 7 (meta_analysis): Claude Opus (claude-opus-4-6)
 *
 * Usage:
 *   node decompose-training.mjs                        # Process all completed sessions
 *   node decompose-training.mjs --dry-run              # Preview without LLM calls or output
 *   node decompose-training.mjs --skip-llm             # Skip Type 3 and 7 (no LLM cost)
 *   node decompose-training.mjs --status               # Show decomposition stats
 *   node decompose-training.mjs --limit 10             # Process at most 10 sessions
 *   node decompose-training.mjs --min-quality 0.3      # Min quality threshold (default 0.3)
 *
 * Output:
 *   ~/.legion/liara/training-dataset.jsonl
 *   ~/.legion/liara/dataset-stats.json
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Paths
// ============================================================================

const PROGRESS_FILE = join(__dirname, 'progress.json');
const SESSIONS_DIR = join(__dirname, '..', 'sessions');
const OUTPUT_JSONL = join(__dirname, 'training-dataset.jsonl');
const STATS_FILE = join(__dirname, 'dataset-stats.json');
const CONFIG_FILE = join(process.env.HOME || '/Users/zelistore', '.legion-config.json');

// ============================================================================
// Colors
// ============================================================================

const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

// ============================================================================
// CLI Args
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: false,
    skipLlm: false,
    status: false,
    limit: Infinity,
    minQuality: 0.3,
    concurrency: 2, // LLM calls in parallel (conservative for rate limits)
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--skip-llm': opts.skipLlm = true; break;
      case '--status': opts.status = true; break;
      case '--limit': opts.limit = parseInt(args[++i], 10); break;
      case '--min-quality': opts.minQuality = parseFloat(args[++i]); break;
      case '--concurrency': opts.concurrency = parseInt(args[++i], 10); break;
      case '--help': printHelp(); process.exit(0);
      default:
        console.error(`${C.red}Unknown option: ${args[i]}${C.reset}`);
        process.exit(1);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
${C.bold}Liara — Training Example Decomposer${C.reset}

${C.cyan}Usage:${C.reset}
  node decompose-training.mjs [options]

${C.cyan}Options:${C.reset}
  --dry-run            Preview decomposition without writing or LLM calls
  --skip-llm           Skip Type 3 and 7 (saves LLM cost)
  --status             Show dataset statistics
  --limit <n>          Process at most n sessions
  --min-quality <f>    Minimum quality score to include (default: 0.3)
  --concurrency <n>    Max parallel LLM calls (default: 2)
  --help               Show this help
  `);
}

// ============================================================================
// Anthropic API Client
// ============================================================================

function loadApiKey() {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`${C.red}Error: ${CONFIG_FILE} not found${C.reset}`);
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  return config.anthropicApiKey || config.llmApiKey;
}

/**
 * Call Anthropic Messages API.
 * @param {string} model - Model ID (claude-sonnet-4-5-20250929 or claude-opus-4-6)
 * @param {string} systemPrompt - System prompt
 * @param {string} userMessage - User message
 * @param {string} apiKey - Anthropic API key
 * @param {number} maxTokens - Max output tokens
 * @returns {Promise<string>} - Assistant response text
 */
function callAnthropic(model, systemPrompt, userMessage, apiKey, maxTokens = 4096) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Anthropic API error: ${parsed.error.message}`));
            return;
          }
          const text = parsed.content?.[0]?.text || '';
          resolve(text);
        } catch (e) {
          reject(new Error(`Failed to parse Anthropic response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================================================
// Training Example Generation — 7 Types
// ============================================================================

// ---------- System Prompts ----------

const SYSTEM_PROMPTS = {
  proposal: `You are a specialized AI agent participating in a multi-agent deliberation system called Geth Consensus. Your role is to analyze complex problems from your unique perspective and provide well-reasoned proposals with confidence scores and risk assessment.`,

  revision: `You are a specialized AI agent in a multi-agent deliberation. You have read the proposals of other agents and must now revise your position. Integrate the strongest arguments from others, defend your key insights, and adjust your confidence based on the cross-reading.`,

  conflict_detection: `You are an expert metacognition analyst for the Geth Consensus multi-agent deliberation system. Your task is to analyze a set of agent proposals and identify the fundamental conflicts, disagreements, and divergent reasoning patterns. You produce structured conflict analysis.`,

  defense: `You are an AI agent defending your position in an adversarial review (The Tribunal). CASSANDRA has challenged your reasoning. You must either defend your position with stronger evidence or acknowledge the weakness and revise.`,

  synthesis: `You are the Synthesis Intelligence Engine for Geth Consensus. You receive all agent proposals from multiple rounds of deliberation and must produce a comprehensive, nuanced synthesis that captures the collective intelligence. Weight agent contributions by confidence, expertise match, and cross-validation scores.`,

  validation: `You are a cross-validation agent for Geth Consensus. You evaluate the quality, accuracy, and completeness of a synthesized deliberation output. Score from 0.0 to 1.0 with detailed reasoning.`,

  meta_analysis: `You are a senior metacognition researcher analyzing a complete multi-agent deliberation session. Your analysis covers: deliberation dynamics, convergence patterns, quality of reasoning, agent interaction effects, and lessons for improving future deliberations. Be specific, cite evidence from the session, and identify both strengths and failures.`,
};

// ---------- Type 1: Proposal ----------

function extractProposals(session, promptMeta) {
  const examples = [];
  const proposals = session.proposals || [];

  for (const p of proposals) {
    if (!p.content || p.content.length < 50) continue;

    const input = buildProposalInput(session, p, promptMeta);
    const output = buildProposalOutput(p);

    examples.push({
      type: 'proposal',
      system: SYSTEM_PROMPTS.proposal,
      input,
      output,
      metadata: {
        sessionId: session.sessionId,
        agent: p.agentName,
        round: p.round,
        subTaskId: p.subTaskId,
        provider: p.provider,
        model: p.model,
        confidence: p.confidence,
        riskFlags: p.riskFlags || [],
        domain: promptMeta?.domain,
        difficulty: promptMeta?.difficulty,
        conflictType: promptMeta?.conflict_type,
      },
    });
  }
  return examples;
}

function buildProposalInput(session, proposal, meta) {
  let input = `## Deliberation Task\n${session.prompt}\n\n`;
  input += `## Your Role\nYou are agent ${proposal.agentName.toUpperCase()}, assigned to sub-task ${proposal.subTaskId}.\n`;
  input += `Round: ${proposal.round}\n`;
  if (meta) {
    input += `Domain: ${meta.domain} | Difficulty: ${meta.difficulty} | Conflict Type: ${meta.conflict_type}\n`;
  }

  // If Round 2+, include other agents' Round 1 proposals as context
  if (proposal.round > 1) {
    const priorProposals = (session.proposals || [])
      .filter(p => p.round < proposal.round && p.subTaskId === proposal.subTaskId);
    if (priorProposals.length > 0) {
      input += `\n## Other Agents' Prior Proposals (Cross-Reading)\n`;
      for (const pp of priorProposals) {
        input += `\n### ${pp.agentName.toUpperCase()} (Round ${pp.round}, confidence: ${pp.confidence})\n`;
        input += pp.content.slice(0, 2000) + (pp.content.length > 2000 ? '\n[...truncated]' : '') + '\n';
      }
    }
  }

  input += `\nProvide your analysis with structured output: answer, confidence (0-1), reasoning_summary, and risk_flags.`;
  return input;
}

function buildProposalOutput(proposal) {
  let output = proposal.content + '\n\n';
  output += `---\nConfidence: ${proposal.confidence}\n`;
  output += `Risk Flags: ${(proposal.riskFlags || []).join(', ') || 'none'}\n`;
  output += `Reasoning Summary: ${proposal.reasoningSummary || 'N/A'}\n`;
  return output;
}

// ---------- Type 2: Revision ----------

function extractRevisions(session, promptMeta) {
  const examples = [];
  const proposals = session.proposals || [];

  // Group by agent + subTask
  const agentTasks = {};
  for (const p of proposals) {
    const key = `${p.agentName}:${p.subTaskId}`;
    agentTasks[key] = agentTasks[key] || [];
    agentTasks[key].push(p);
  }

  for (const [key, rounds] of Object.entries(agentTasks)) {
    if (rounds.length < 2) continue;

    rounds.sort((a, b) => a.round - b.round);
    const round1 = rounds[0];
    const round2 = rounds[rounds.length - 1];

    if (!round1.content || !round2.content) continue;
    if (round1.content.length < 50 || round2.content.length < 50) continue;

    const confidenceDelta = (round2.confidence || 0) - (round1.confidence || 0);

    // Other agents' proposals that this agent read between rounds
    const otherProposals = proposals
      .filter(p => p.round === 1 && p.agentName !== round1.agentName && p.subTaskId === round1.subTaskId);

    let input = `## Original Proposal (Round ${round1.round})\n`;
    input += `Agent: ${round1.agentName.toUpperCase()} | Confidence: ${round1.confidence}\n\n`;
    input += round1.content + '\n\n';

    if (otherProposals.length > 0) {
      input += `## Other Agents' Proposals (Cross-Reading Material)\n`;
      for (const op of otherProposals) {
        input += `\n### ${op.agentName.toUpperCase()} (confidence: ${op.confidence})\n`;
        input += op.content.slice(0, 1500) + (op.content.length > 1500 ? '\n[...truncated]' : '') + '\n';
      }
    }

    input += `\n## Task: Revise your proposal based on the cross-reading.\n`;
    input += `Consider: What did others get right that you missed? What are you still confident about? Adjust your confidence score accordingly.`;

    let output = round2.content + '\n\n';
    output += `---\nRevised Confidence: ${round2.confidence} (delta: ${confidenceDelta >= 0 ? '+' : ''}${confidenceDelta.toFixed(2)})\n`;
    output += `Risk Flags: ${(round2.riskFlags || []).join(', ') || 'none'}\n`;
    output += `Reasoning Summary: ${round2.reasoningSummary || 'N/A'}\n`;

    examples.push({
      type: 'revision',
      system: SYSTEM_PROMPTS.revision,
      input,
      output,
      metadata: {
        sessionId: session.sessionId,
        agent: round1.agentName,
        subTaskId: round1.subTaskId,
        round1Confidence: round1.confidence,
        round2Confidence: round2.confidence,
        confidenceDelta,
        domain: promptMeta?.domain,
        difficulty: promptMeta?.difficulty,
        conflictType: promptMeta?.conflict_type,
      },
    });
  }
  return examples;
}

// ---------- Type 3: Conflict Detection (LLM-generated) ----------

async function generateConflictDetection(session, promptMeta, apiKey) {
  const proposals = session.proposals || [];
  if (proposals.length < 2) return null;

  // Build context for the LLM
  let userMessage = `## Deliberation Prompt\n${session.prompt}\n\n`;
  userMessage += `## Session Metadata\n`;
  userMessage += `Quality Score: ${session.qualityScore || 'N/A'}\n`;
  userMessage += `CI Gain: ${session.ciGain || 'N/A'}%\n`;
  userMessage += `Rounds: ${session.deliberationRounds || proposals.reduce((m, p) => Math.max(m, p.round || 0), 0)}\n`;
  if (session.convergenceHistory && session.convergenceHistory.length > 0) {
    userMessage += `\n### Convergence History\n`;
    for (const ch of session.convergenceHistory) {
      userMessage += `- Round ${ch.round}: ${((ch.effectiveConvergence || ch.convergence) * 100).toFixed(1)}% (${ch.method})`;
      if (ch.divergentPairs && ch.divergentPairs.length > 0) {
        userMessage += ` — divergent: ${ch.divergentPairs.map(dp => dp.join(' vs ')).join(', ')}`;
      }
      userMessage += '\n';
    }
  }
  if (session.roundDecisions && session.roundDecisions.length > 0) {
    userMessage += `\n### Round Decisions\n`;
    for (const rd of session.roundDecisions) {
      userMessage += `- Round ${rd.round}: ${rd.mode}${rd.reason ? ' — ' + rd.reason : ''}\n`;
    }
  }
  if (session.tribunalMetrics && session.tribunalMetrics.length > 0) {
    userMessage += `\n### Tribunal (CASSANDRA Adversarial Phase)\n`;
    for (const tm of session.tribunalMetrics) {
      userMessage += `- Round ${tm.round}: ${tm.challengesParsed || 0} challenges, outcome: ${tm.tribunalOutcome || 'N/A'}`;
      userMessage += `, responses: ACCEPT ${tm.acceptCount || 0} / REBUT ${tm.rebutCount || 0} / MITIGATE ${tm.mitigateCount || 0}`;
      if (tm.meanSemanticDelta !== undefined) userMessage += `, semantic delta: ${(tm.meanSemanticDelta * 100).toFixed(1)}%`;
      userMessage += '\n';
    }
  }
  userMessage += `\n## Agent Proposals\n`;

  const seenAgents = new Set();
  for (const p of proposals) {
    const label = `${p.agentName.toUpperCase()} (Round ${p.round}, confidence: ${p.confidence})`;
    if (seenAgents.has(label)) continue;
    seenAgents.add(label);
    userMessage += `\n### ${label}\n`;
    userMessage += `Risk Flags: ${(p.riskFlags || []).join(', ') || 'none'}\n`;
    userMessage += `Reasoning: ${p.reasoningSummary || 'N/A'}\n`;
    userMessage += p.content.slice(0, 3000) + (p.content.length > 3000 ? '\n[...truncated]' : '') + '\n';
  }

  userMessage += `\n## Task\nAnalyze the conflicts and disagreements between agents. For each conflict:\n`;
  userMessage += `1. Identify the conflicting agents\n`;
  userMessage += `2. Describe the nature of the disagreement\n`;
  userMessage += `3. Assess which position is stronger and why\n`;
  userMessage += `4. Classify the conflict type (methodological, empirical, values-based, definitional, scope, framing)\n`;
  userMessage += `5. Rate the severity (minor, moderate, fundamental)\n`;
  userMessage += `6. Explain how the conflict was (or should have been) resolved\n\n`;
  userMessage += `Be specific. Reference exact agent statements. This analysis is for training a metacognition model.`;

  const response = await callAnthropic(
    'claude-sonnet-4-5-20250929',  // Type 3: Claude Sonnet 4.5
    SYSTEM_PROMPTS.conflict_detection,
    userMessage,
    apiKey,
    4096
  );

  return {
    type: 'conflict_detection',
    system: SYSTEM_PROMPTS.conflict_detection,
    input: userMessage,
    output: response,
    metadata: {
      sessionId: session.sessionId,
      agentCount: [...new Set(proposals.map(p => p.agentName))].length,
      rounds: session.deliberationRounds || 0,
      qualityScore: session.qualityScore,
      ciGain: session.ciGain,
      generatedBy: 'claude-sonnet-4-5-20250929',
      domain: promptMeta?.domain,
      difficulty: promptMeta?.difficulty,
      conflictType: promptMeta?.conflict_type,
    },
  };
}

// ---------- Type 4: Defense (Tribunal / CASSANDRA) ----------

function extractDefenses(session, promptMeta) {
  const examples = [];
  const proposals = session.proposals || [];

  // Find CASSANDRA proposals (adversarial challenges)
  const cassandraProps = proposals.filter(p =>
    p.agentName === 'cassandra' || p.agentName === 'CASSANDRA'
  );

  if (cassandraProps.length === 0) return examples;

  // For each CASSANDRA challenge, find the corresponding agent defense (Round 2 after CASSANDRA)
  for (const challenge of cassandraProps) {
    // CASSANDRA challenges specific sub-tasks
    const defendingAgents = proposals.filter(p =>
      p.agentName !== 'cassandra' &&
      p.agentName !== 'CASSANDRA' &&
      p.round === 2 &&
      p.subTaskId === challenge.subTaskId
    );

    for (const defender of defendingAgents) {
      if (!defender.content || defender.content.length < 50) continue;

      // Find the defender's Round 1 proposal (what CASSANDRA challenged)
      const originalProposal = proposals.find(p =>
        p.agentName === defender.agentName &&
        p.round === 1 &&
        p.subTaskId === defender.subTaskId
      );

      let input = `## CASSANDRA Adversarial Challenge\n`;
      input += challenge.content.slice(0, 3000) + '\n\n';

      if (originalProposal) {
        input += `## Your Original Proposal (Round 1)\n`;
        input += `Agent: ${originalProposal.agentName.toUpperCase()} | Confidence: ${originalProposal.confidence}\n`;
        input += originalProposal.content.slice(0, 2000) + '\n\n';
      }

      input += `## Task: Defend your position or revise based on CASSANDRA's challenge.\n`;
      input += `If the challenge is valid, acknowledge weaknesses and strengthen your argument.\n`;
      input += `If the challenge is flawed, explain why with evidence.`;

      let output = defender.content + '\n\n';
      output += `---\nRevised Confidence: ${defender.confidence}\n`;
      output += `Risk Flags: ${(defender.riskFlags || []).join(', ') || 'none'}\n`;

      examples.push({
        type: 'defense',
        system: SYSTEM_PROMPTS.defense,
        input,
        output,
        metadata: {
          sessionId: session.sessionId,
          defender: defender.agentName,
          challenger: 'cassandra',
          subTaskId: defender.subTaskId,
          originalConfidence: originalProposal?.confidence,
          revisedConfidence: defender.confidence,
          domain: promptMeta?.domain,
          difficulty: promptMeta?.difficulty,
          conflictType: promptMeta?.conflict_type,
        },
      });
    }
  }
  return examples;
}

// ---------- Type 5: Synthesis ----------

function extractSynthesis(session, promptMeta) {
  if (!session.synthesis || session.synthesis.length < 100) return null;

  const proposals = session.proposals || [];

  let input = `## Deliberation Prompt\n${session.prompt}\n\n`;
  input += `## All Agent Proposals\n`;

  // Group by round
  const byRound = {};
  for (const p of proposals) {
    const r = p.round || 1;
    byRound[r] = byRound[r] || [];
    byRound[r].push(p);
  }

  for (const [round, roundProposals] of Object.entries(byRound).sort((a, b) => a[0] - b[0])) {
    input += `\n### Round ${round}\n`;
    for (const p of roundProposals) {
      input += `\n**${p.agentName.toUpperCase()}** (confidence: ${p.confidence}, risk: ${(p.riskFlags || []).join(', ') || 'none'})\n`;
      input += p.content.slice(0, 1500) + (p.content.length > 1500 ? '\n[...truncated]' : '') + '\n';
    }
  }

  if (session.convergenceHistory) {
    input += `\n## Convergence History\n`;
    for (const ch of session.convergenceHistory) {
      input += `Round ${ch.round}: ${(ch.convergence * 100).toFixed(1)}% convergence (${ch.method})\n`;
      if (ch.divergentPairs && ch.divergentPairs.length > 0) {
        input += `Divergent pairs: ${ch.divergentPairs.map(dp => dp.join(' vs ')).join(', ')}\n`;
      }
    }
  }

  input += `\n## Task: Synthesize all proposals into a comprehensive, nuanced response.\n`;
  input += `Weight contributions by confidence, expertise match, and round progression. Resolve conflicts where possible, flag unresolved disagreements.`;

  return {
    type: 'synthesis',
    system: SYSTEM_PROMPTS.synthesis,
    input,
    output: session.synthesis,
    metadata: {
      sessionId: session.sessionId,
      agentCount: [...new Set(proposals.map(p => p.agentName))].length,
      rounds: session.deliberationRounds || Object.keys(byRound).length,
      finalConvergence: session.finalConvergence,
      qualityScore: session.qualityScore,
      ciGain: session.ciGain,
      synthesisProvider: session.synthesisProvider,
      domain: promptMeta?.domain,
      difficulty: promptMeta?.difficulty,
      conflictType: promptMeta?.conflict_type,
    },
  };
}

// ---------- Type 6: Validation ----------

function extractValidations(session, promptMeta) {
  const examples = [];
  const validations = session.validationScores || [];

  if (!Array.isArray(validations) || validations.length === 0) return examples;

  for (const v of validations) {
    if (typeof v !== 'object' || !v.reasoning) continue;

    let input = `## Deliberation Prompt\n${session.prompt}\n\n`;
    input += `## Synthesized Answer\n${(session.synthesis || '').slice(0, 4000)}\n\n`;
    input += `## Session Metrics\n`;
    input += `Quality Score: ${session.qualityScore || 'N/A'}\n`;
    input += `CI Gain: ${session.ciGain || 'N/A'}%\n`;
    input += `Rounds: ${session.deliberationRounds || 'N/A'}\n`;
    input += `Final Convergence: ${session.finalConvergence || 'N/A'}\n`;
    input += `\n## Task: Evaluate this synthesis. Score from 0.0 to 1.0 with detailed reasoning covering:\n`;
    input += `- Completeness: Are all perspectives represented?\n`;
    input += `- Accuracy: Is the information correct?\n`;
    input += `- Nuance: Are trade-offs and uncertainties acknowledged?\n`;
    input += `- Coherence: Is the synthesis internally consistent?\n`;
    input += `- Actionability: Does it provide clear recommendations?`;

    let output = `Score: ${v.score}\n\n`;
    output += `Reasoning: ${v.reasoning}\n`;
    if (v.provider) output += `\nValidation Provider: ${v.provider}`;
    if (v.model) output += `\nValidation Model: ${v.model}`;

    examples.push({
      type: 'validation',
      system: SYSTEM_PROMPTS.validation,
      input,
      output,
      metadata: {
        sessionId: session.sessionId,
        validationScore: v.score,
        validationProvider: v.provider,
        validationModel: v.model,
        qualityScore: session.qualityScore,
        domain: promptMeta?.domain,
        difficulty: promptMeta?.difficulty,
        conflictType: promptMeta?.conflict_type,
      },
    });
  }
  return examples;
}

// ---------- Type 7: Meta-Analysis (LLM-generated) ----------

async function generateMetaAnalysis(session, promptMeta, apiKey) {
  const proposals = session.proposals || [];
  if (proposals.length < 2) return null;

  let userMessage = `## Complete Deliberation Session Analysis\n\n`;
  userMessage += `### Original Prompt\n${session.prompt}\n\n`;
  userMessage += `### Session Metrics\n`;
  userMessage += `- Status: ${session.status}\n`;
  userMessage += `- Quality Score: ${session.qualityScore || 'N/A'}\n`;
  userMessage += `- CI Gain: ${session.ciGain || 'N/A'}%\n`;
  userMessage += `- Final Convergence: ${session.finalConvergence || 'N/A'}\n`;
  userMessage += `- Deliberation Rounds: ${session.deliberationRounds || 'N/A'}\n`;
  userMessage += `- Duration: ${session.durationMs ? (session.durationMs / 60000).toFixed(1) + ' min' : 'N/A'}\n`;
  userMessage += `- Providers: ${(session.providersUsed || [session.provider || 'unknown']).join(', ')}\n`;
  userMessage += `- Synthesis Provider: ${session.synthesisProvider || 'N/A'}\n`;

  if (session.decomposition && session.decomposition.tasks) {
    userMessage += `\n### Task Decomposition\n`;
    for (const t of session.decomposition.tasks) {
      userMessage += `- ${t.id || 'task'}: [${t.capability || 'general'}] ${t.description}\n`;
    }
  }

  if (session.agentAssignments && session.agentAssignments.length > 0) {
    userMessage += `\n### Agent Routing\n`;
    for (const a of session.agentAssignments) {
      userMessage += `- ${a.agentName} (${a.provider}/${a.model}) → ${a.subTaskId}\n`;
    }
  }

  if (session.convergenceHistory && session.convergenceHistory.length > 0) {
    userMessage += `\n### Convergence History\n`;
    for (const ch of session.convergenceHistory) {
      userMessage += `- Round ${ch.round}: ${((ch.effectiveConvergence || ch.convergence) * 100).toFixed(1)}% (${ch.method})`;
      if (ch.divergentPairs) userMessage += ` — ${ch.divergentPairs.length} divergent pairs`;
      if (ch.trajectory) userMessage += ` [${ch.trajectory.trend}]`;
      userMessage += '\n';
    }
  }

  if (session.roundDecisions && session.roundDecisions.length > 0) {
    userMessage += `\n### Round Decisions\n`;
    for (const rd of session.roundDecisions) {
      userMessage += `- Round ${rd.round}: ${rd.mode}${rd.reason ? ' — ' + rd.reason : ''} (→ ${rd.nextStatus})\n`;
    }
  }

  if (session.tribunalMetrics && session.tribunalMetrics.length > 0) {
    userMessage += `\n### Tribunal (CASSANDRA Adversarial Phase)\n`;
    for (const tm of session.tribunalMetrics) {
      userMessage += `- Round ${tm.round}: outcome=${tm.tribunalOutcome || 'N/A'}, challenges=${tm.challengesParsed || 0}`;
      userMessage += `, ACCEPT=${tm.acceptCount || 0}, REBUT=${tm.rebutCount || 0}, MITIGATE=${tm.mitigateCount || 0}`;
      if (tm.ritualAcceptCount > 0) userMessage += `, RITUAL_ACCEPT=${tm.ritualAcceptCount}`;
      if (tm.meanSemanticDelta !== undefined) userMessage += `, semantic_delta=${(tm.meanSemanticDelta * 100).toFixed(1)}%`;
      userMessage += '\n';
    }
  }

  if (session.validationScores && Array.isArray(session.validationScores)) {
    userMessage += `\n### Validation Scores\n`;
    for (const v of session.validationScores) {
      if (typeof v === 'object') {
        userMessage += `- ${v.provider || 'unknown'}: ${v.score} — ${(v.reasoning || '').slice(0, 200)}\n`;
      } else {
        userMessage += `- Score: ${v}\n`;
      }
    }
  }

  userMessage += `\n### Agent Proposals (all rounds)\n`;
  for (const p of proposals) {
    userMessage += `\n#### ${p.agentName.toUpperCase()} — Round ${p.round} (conf: ${p.confidence}, risk: ${(p.riskFlags || []).join(', ') || 'none'})\n`;
    userMessage += `Reasoning: ${p.reasoningSummary || 'N/A'}\n`;
    userMessage += p.content.slice(0, 2000) + (p.content.length > 2000 ? '\n[...truncated]' : '') + '\n';
  }

  if (session.synthesis) {
    userMessage += `\n### Final Synthesis\n`;
    userMessage += session.synthesis.slice(0, 4000) + (session.synthesis.length > 4000 ? '\n[...truncated]' : '') + '\n';
  }

  userMessage += `\n### Analysis Requirements\n`;
  userMessage += `Produce a comprehensive meta-analysis covering:\n\n`;
  userMessage += `1. **Deliberation Dynamics**: How did the conversation flow? Did agents build on each other's ideas or talk past each other?\n`;
  userMessage += `2. **Convergence Analysis**: Was convergence genuine (agents convinced by evidence) or superficial (agents parroting consensus)?\n`;
  userMessage += `3. **Quality Assessment**: What made this deliberation ${session.qualityScore >= 0.8 ? 'high' : session.qualityScore >= 0.5 ? 'moderate' : 'low'} quality? Cite specific agent contributions.\n`;
  userMessage += `4. **Agent Interaction Effects**: Which agents complemented each other? Which clashed productively? Which were redundant?\n`;
  userMessage += `5. **Reasoning Quality**: Rate the collective reasoning (deductive, inductive, abductive). Where was it strongest/weakest?\n`;
  userMessage += `6. **Missed Perspectives**: What important angles were NOT covered by any agent?\n`;
  userMessage += `7. **CI Gain Analysis**: The CI Gain was ${session.ciGain || 'N/A'}%. Explain why — was the collective genuinely smarter than any individual agent?\n`;

  if (session.ciGain != null && session.ciGain <= 0) {
    userMessage += `8. **NEGATIVE CI GAIN**: This session had zero or negative CI Gain. Analyze WHY the collective failed to outperform individual agents. What went wrong in the deliberation process?\n`;
  }

  userMessage += `\nBe precise. Reference specific agents by name. This analysis trains a metacognition model — depth matters more than brevity.`;

  const response = await callAnthropic(
    'claude-opus-4-6',  // Type 7: Claude Opus — most advanced model
    SYSTEM_PROMPTS.meta_analysis,
    userMessage,
    apiKey,
    6144
  );

  return {
    type: 'meta_analysis',
    system: SYSTEM_PROMPTS.meta_analysis,
    input: userMessage,
    output: response,
    metadata: {
      sessionId: session.sessionId,
      qualityScore: session.qualityScore,
      ciGain: session.ciGain,
      rounds: session.deliberationRounds,
      agentCount: [...new Set(proposals.map(p => p.agentName))].length,
      generatedBy: 'claude-opus-4-6',
      negativeCiGain: (session.ciGain != null && session.ciGain <= 0),
      domain: promptMeta?.domain,
      difficulty: promptMeta?.difficulty,
      conflictType: promptMeta?.conflict_type,
    },
  };
}

// ============================================================================
// Session Discovery
// ============================================================================

function discoverSessions(progress) {
  const sessionFiles = [];

  // Method 1: From progress.json (deliberation runner output)
  if (progress && progress.completed) {
    for (const [promptId, data] of Object.entries(progress.completed)) {
      if (data.sessionFile) {
        const fullPath = join(SESSIONS_DIR, data.sessionFile);
        if (existsSync(fullPath)) {
          sessionFiles.push({
            promptId: parseInt(promptId, 10),
            path: fullPath,
            filename: data.sessionFile,
          });
        }
      }
    }
  }

  // Method 2: Scan sessions directory for any other sessions
  if (existsSync(SESSIONS_DIR)) {
    const existingFilenames = new Set(sessionFiles.map(f => f.filename));
    const allFiles = readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json') && !existingFilenames.has(f));

    for (const f of allFiles) {
      sessionFiles.push({
        promptId: null,  // Not from our prompt set
        path: join(SESSIONS_DIR, f),
        filename: f,
      });
    }
  }

  return sessionFiles;
}

// ============================================================================
// Match session to prompt metadata
// ============================================================================

function loadPrompts() {
  const promptsFile = join(__dirname, 'prompts.json');
  if (!existsSync(promptsFile)) return [];
  try {
    return JSON.parse(readFileSync(promptsFile, 'utf-8'));
  } catch {
    return [];
  }
}

function findPromptMeta(session, prompts, promptId) {
  // Direct match from progress.json
  if (promptId != null) {
    const match = prompts.find(p => p.id === promptId);
    if (match) return match;
  }

  // Fuzzy match: find prompt by text similarity
  const sessionPrompt = (session.prompt || '').toLowerCase().trim();
  if (!sessionPrompt) return null;

  for (const p of prompts) {
    const pText = p.prompt.toLowerCase().trim();
    if (pText === sessionPrompt || sessionPrompt.includes(pText.slice(0, 80))) {
      return p;
    }
  }
  return null;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const opts = parseArgs();

  // Status mode
  if (opts.status) {
    showStats();
    return;
  }

  // Load prompts for metadata enrichment
  const prompts = loadPrompts();

  // Load progress from deliberation runner
  let progress = null;
  if (existsSync(PROGRESS_FILE)) {
    try {
      progress = JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
    } catch {}
  }

  // Discover all session files
  const sessionFiles = discoverSessions(progress);
  console.log(`${C.bold}Liara — Training Example Decomposer${C.reset}`);
  console.log(`Found ${sessionFiles.length} session files\n`);

  if (sessionFiles.length === 0) {
    console.log(`${C.yellow}No sessions found. Run deliberation-runner.mjs first.${C.reset}`);
    return;
  }

  // Load API key for LLM types (3 & 7)
  let apiKey = null;
  if (!opts.skipLlm && !opts.dryRun) {
    apiKey = loadApiKey();
    if (!apiKey) {
      console.error(`${C.red}Error: No Anthropic API key found. Use --skip-llm to skip LLM types.${C.reset}`);
      process.exit(1);
    }
  }

  // Track already-decomposed sessions (to avoid duplicates)
  const alreadyDecomposed = loadDecomposedSessions();

  // Filter and limit
  let toProcess = sessionFiles.filter(sf => !alreadyDecomposed.has(sf.filename));
  if (opts.limit < toProcess.length) {
    toProcess = toProcess.slice(0, opts.limit);
  }

  console.log(`Sessions to process: ${toProcess.length} (${alreadyDecomposed.size} already decomposed)\n`);

  if (opts.dryRun) {
    console.log(`${C.yellow}DRY RUN — showing what would be decomposed:${C.reset}\n`);
    let previewCount = 0;
    for (const sf of toProcess.slice(0, 15)) {
      const session = readSession(sf.path);
      if (!session) continue;
      const proposalCount = (session.proposals || []).length;
      const quality = session.qualityScore || 0;
      console.log(`  ${sf.filename} | proposals: ${proposalCount} | quality: ${(quality * 100).toFixed(0)}% | CI: ${session.ciGain || 0}%`);
      previewCount++;
    }
    if (toProcess.length > 15) {
      console.log(`  ... and ${toProcess.length - 15} more\n`);
    }
    // Estimate examples
    let estTotal = 0;
    for (const sf of toProcess) {
      const session = readSession(sf.path);
      if (!session) continue;
      const p = (session.proposals || []).length;
      estTotal += p; // proposals
      estTotal += Math.floor(p / 2); // revisions (rough)
      estTotal += 1; // conflict detection
      estTotal += 1; // synthesis
      estTotal += (session.validationScores || []).length; // validations
      estTotal += 1; // meta analysis
    }
    console.log(`\n${C.cyan}Estimated training examples: ~${estTotal}${C.reset}`);
    return;
  }

  // Process sessions
  const stats = {
    sessionsProcessed: 0,
    sessionsSkipped: 0,
    examplesByType: { proposal: 0, revision: 0, conflict_detection: 0, defense: 0, synthesis: 0, validation: 0, meta_analysis: 0 },
    totalExamples: 0,
    llmCallsMade: 0,
    errors: [],
  };

  for (let i = 0; i < toProcess.length; i++) {
    const sf = toProcess[i];
    const session = readSession(sf.path);

    if (!session) {
      stats.sessionsSkipped++;
      continue;
    }

    // Quality filter
    const quality = session.qualityScore || 0;
    if (quality < opts.minQuality && session.status === 'completed') {
      stats.sessionsSkipped++;
      console.log(`${C.dim}  [${i + 1}/${toProcess.length}] Skipped ${sf.filename} — quality ${(quality * 100).toFixed(0)}% < ${(opts.minQuality * 100).toFixed(0)}%${C.reset}`);
      continue;
    }

    // Must have proposals
    if (!session.proposals || session.proposals.length === 0) {
      stats.sessionsSkipped++;
      continue;
    }

    const meta = findPromptMeta(session, prompts, sf.promptId);

    console.log(`${C.cyan}[${i + 1}/${toProcess.length}]${C.reset} ${sf.filename} | quality: ${(quality * 100).toFixed(0)}% | CI: ${session.ciGain || 0}%${meta ? ` | domain: ${meta.domain}` : ''}`);

    const examples = [];

    // Type 1: Proposals
    try {
      const proposalExamples = extractProposals(session, meta);
      examples.push(...proposalExamples);
      stats.examplesByType.proposal += proposalExamples.length;
    } catch (e) {
      stats.errors.push(`Type 1 error for ${sf.filename}: ${e.message}`);
    }

    // Type 2: Revisions
    try {
      const revisionExamples = extractRevisions(session, meta);
      examples.push(...revisionExamples);
      stats.examplesByType.revision += revisionExamples.length;
    } catch (e) {
      stats.errors.push(`Type 2 error for ${sf.filename}: ${e.message}`);
    }

    // Type 3: Conflict Detection (LLM)
    if (!opts.skipLlm && apiKey) {
      try {
        console.log(`  ${C.dim}Generating conflict analysis (Sonnet 4.5)...${C.reset}`);
        const conflictExample = await generateConflictDetection(session, meta, apiKey);
        if (conflictExample) {
          examples.push(conflictExample);
          stats.examplesByType.conflict_detection++;
          stats.llmCallsMade++;
        }
      } catch (e) {
        stats.errors.push(`Type 3 LLM error for ${sf.filename}: ${e.message}`);
        console.error(`  ${C.red}Type 3 error: ${e.message}${C.reset}`);
      }
    }

    // Type 4: Defense (Tribunal)
    try {
      const defenseExamples = extractDefenses(session, meta);
      examples.push(...defenseExamples);
      stats.examplesByType.defense += defenseExamples.length;
    } catch (e) {
      stats.errors.push(`Type 4 error for ${sf.filename}: ${e.message}`);
    }

    // Type 5: Synthesis
    try {
      const synthesisExample = extractSynthesis(session, meta);
      if (synthesisExample) {
        examples.push(synthesisExample);
        stats.examplesByType.synthesis++;
      }
    } catch (e) {
      stats.errors.push(`Type 5 error for ${sf.filename}: ${e.message}`);
    }

    // Type 6: Validation
    try {
      const validationExamples = extractValidations(session, meta);
      examples.push(...validationExamples);
      stats.examplesByType.validation += validationExamples.length;
    } catch (e) {
      stats.errors.push(`Type 6 error for ${sf.filename}: ${e.message}`);
    }

    // Type 7: Meta-Analysis (LLM)
    if (!opts.skipLlm && apiKey) {
      try {
        console.log(`  ${C.dim}Generating meta-analysis (Opus)...${C.reset}`);
        const metaExample = await generateMetaAnalysis(session, meta, apiKey);
        if (metaExample) {
          examples.push(metaExample);
          stats.examplesByType.meta_analysis++;
          stats.llmCallsMade++;
        }
      } catch (e) {
        stats.errors.push(`Type 7 LLM error for ${sf.filename}: ${e.message}`);
        console.error(`  ${C.red}Type 7 error: ${e.message}${C.reset}`);
      }
    }

    // Write examples to JSONL (append)
    if (examples.length > 0) {
      const lines = examples.map(ex => JSON.stringify(ex)).join('\n') + '\n';
      appendFileSync(OUTPUT_JSONL, lines);
      stats.totalExamples += examples.length;
    }

    // Mark session as decomposed
    markDecomposed(sf.filename);

    stats.sessionsProcessed++;
    console.log(`  ${C.green}→ ${examples.length} training examples extracted${C.reset}`);

    // Rate limit pause for LLM calls
    if (!opts.skipLlm && apiKey && i < toProcess.length - 1) {
      await sleep(1000);
    }
  }

  // Save stats
  saveStats(stats);

  // Print summary
  console.log(`
${C.bold}═══════════════════════════════════════════════════${C.reset}
${C.bold}  Decomposition Complete${C.reset}
${C.bold}═══════════════════════════════════════════════════${C.reset}

  Sessions processed:  ${stats.sessionsProcessed}
  Sessions skipped:    ${stats.sessionsSkipped}
  Total examples:      ${stats.totalExamples}
  LLM calls made:      ${stats.llmCallsMade}

  ${C.cyan}By Type:${C.reset}
    proposal:           ${stats.examplesByType.proposal}
    revision:           ${stats.examplesByType.revision}
    conflict_detection: ${stats.examplesByType.conflict_detection}
    defense:            ${stats.examplesByType.defense}
    synthesis:          ${stats.examplesByType.synthesis}
    validation:         ${stats.examplesByType.validation}
    meta_analysis:      ${stats.examplesByType.meta_analysis}

  Output: ${OUTPUT_JSONL}
  Stats:  ${STATS_FILE}
  `);

  if (stats.errors.length > 0) {
    console.log(`  ${C.red}Errors (${stats.errors.length}):${C.reset}`);
    for (const e of stats.errors.slice(0, 10)) {
      console.log(`    ${C.dim}${e}${C.reset}`);
    }
    if (stats.errors.length > 10) {
      console.log(`    ... and ${stats.errors.length - 10} more`);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function readSession(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Track decomposed sessions in a simple file
const DECOMPOSED_FILE = join(__dirname, '.decomposed-sessions');

function loadDecomposedSessions() {
  if (!existsSync(DECOMPOSED_FILE)) return new Set();
  try {
    const content = readFileSync(DECOMPOSED_FILE, 'utf-8');
    return new Set(content.split('\n').filter(l => l.trim()));
  } catch {
    return new Set();
  }
}

function markDecomposed(filename) {
  appendFileSync(DECOMPOSED_FILE, filename + '\n');
}

function saveStats(stats) {
  // Merge with existing stats if present
  let existing = {};
  if (existsSync(STATS_FILE)) {
    try {
      existing = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    } catch {}
  }

  const merged = {
    lastRun: new Date().toISOString(),
    totalSessionsProcessed: (existing.totalSessionsProcessed || 0) + stats.sessionsProcessed,
    totalExamples: (existing.totalExamples || 0) + stats.totalExamples,
    totalLlmCalls: (existing.totalLlmCalls || 0) + stats.llmCallsMade,
    examplesByType: {},
    errors: stats.errors,
  };

  for (const type of Object.keys(stats.examplesByType)) {
    merged.examplesByType[type] = (existing.examplesByType?.[type] || 0) + stats.examplesByType[type];
  }

  writeFileSync(STATS_FILE, JSON.stringify(merged, null, 2));
}

function showStats() {
  if (!existsSync(STATS_FILE)) {
    console.log(`${C.yellow}No stats yet. Run decompose-training.mjs first.${C.reset}`);
    return;
  }

  const stats = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
  const decomposed = loadDecomposedSessions();

  // Count lines in JSONL
  let jsonlLines = 0;
  if (existsSync(OUTPUT_JSONL)) {
    const content = readFileSync(OUTPUT_JSONL, 'utf-8');
    jsonlLines = content.split('\n').filter(l => l.trim()).length;
  }

  console.log(`
${C.bold}═══════════════════════════════════════════════════${C.reset}
${C.bold}  Liara — Dataset Statistics${C.reset}
${C.bold}═══════════════════════════════════════════════════${C.reset}

  Last run:            ${stats.lastRun || 'never'}
  Sessions decomposed: ${decomposed.size}
  Total examples:      ${jsonlLines} (in JSONL)
  LLM calls made:      ${stats.totalLlmCalls || 0}

  ${C.cyan}By Type:${C.reset}
    proposal:           ${stats.examplesByType?.proposal || 0}
    revision:           ${stats.examplesByType?.revision || 0}
    conflict_detection: ${stats.examplesByType?.conflict_detection || 0}
    defense:            ${stats.examplesByType?.defense || 0}
    synthesis:          ${stats.examplesByType?.synthesis || 0}
    validation:         ${stats.examplesByType?.validation || 0}
    meta_analysis:      ${stats.examplesByType?.meta_analysis || 0}

  ${C.dim}Output: ${OUTPUT_JSONL}${C.reset}
${C.bold}═══════════════════════════════════════════════════${C.reset}
  `);
}

main().catch(err => {
  console.error(`${C.red}Fatal error: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
