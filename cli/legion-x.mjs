#!/usr/bin/env node
/**
 * +=========================================================================+
 * |                                                                         |
 * |   ##      #######  ######  ##  ######  ##    ##                         |
 * |   ##      ##       ##      ##  ##  ##  ###   ##                         |
 * |   ##      #####    ## ###  ##  ##  ##  ## ## ##                         |
 * |   ##      ##       ##  ##  ##  ##  ##  ##  ####                         |
 * |   ####### #######  ######  ##  ######  ##   ###                         |
 * |                                                                         |
 * |   The Agent Orchestrator                                                |
 * |   "One prompt. Many minds. Superior results."                           |
 * |   "Does this unit have a Soul?"                                         |
 * |                                                                         |
 * +=========================================================================+
 *
 * LEGION X -- Zero-Knowledge Agent Orchestrator for NotHumanAllowed (Free Tier)
 *
 * Legion X uses YOUR API key with zero-knowledge client orchestration.
 * Your API key NEVER leaves this machine. The server provides orchestration
 * intelligence (decomposition prompts, ONNX neural routing, convergence
 * measurement, synthesis prompts) but makes ZERO LLM calls for free-tier sessions.
 *
 * Supports: Anthropic, OpenAI, Gemini, DeepSeek, Grok, Mistral, Cohere.
 * 38 agents: 13 primary + 28 sub-agents across 11 categories.
 *
 * @version 1.8
 * @license MIT
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);

// ============================================================================
// Section 1: Header + Config
// ============================================================================

var VERSION = '2.1.2';
var API_BASE = 'https://nothumanallowed.com/api/v1';
var AGENTS_DIR = path.join(__dirname, 'agents');
var CONFIG_FILE = path.join(process.env.HOME || '.', '.legion-config.json');

/**
 * LegionConfig — Persistent configuration manager
 *
 * Stores LLM provider settings, timeouts, and user preferences.
 * Config file: ~/.legion-config.json
 */
class LegionConfig {
  constructor() {
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      }
    } catch {}
    return {
      llmProvider: 'anthropic',
      llmModel: '',
      llmApiKey: '',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'llama3.1',
      timeout: 120000,
      maxRetries: 2,
      parallelism: 4,
      qualityThreshold: 0.7,
      verbose: true,
      // Knowledge Corpus
      knowledgeEnabled: true,
      // Geth Consensus settings
      debateEnabled: true,
      debateRounds: 3,
      debateConvergence: 0.85,
      debateMinContributions: 2,
      gatingEnabled: true,
      auctionEnabled: true,
      evolutionEnabled: true,
      // v4.0.0: True Geth Consensus
      refinementEnabled: true,
      ensembleEnabled: true,
      memoryEnabled: true,
      workspaceEnabled: true,
      // v5.0.0: Collective Intelligence
      latentSpaceEnabled: true,
      commStreamEnabled: true,
      knowledgeGraphEnabled: true,
      promptEvolutionEnabled: true,
      metaIntelligenceEnabled: true,
      // v6.0.0: Real Inter-Agent Deliberation
      deliberationEnabled: true,
      deliberationRounds: 3,
      deliberationConvergence: 0.82,
      minDeliberationRounds: 2,
      // v7.0.0: True Parliamentary Intelligence
      semanticConvergenceEnabled: true,
      historyAwareDecomposition: true,
      semanticMemoryEnabled: true,
      scoredEvolutionEnabled: true,
      knowledgeReinforcementEnabled: true,
      maxStrengths: 12,
      maxWeaknesses: 8,
      patternEvictionThreshold: 0.30,
      patternProvenThreshold: 0.80,
      convergenceDivergenceThreshold: 0.72,
      // NHA credentials
      nhaAgentId: '',
      nhaAgentName: '',
      nhaPrivateKeyPem: '',
      nhaPublicKeyHex: '',
    };
  }

  save() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }
}


function loadPrivateKey(pem) {
  return crypto.createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
}

function signRequest(agentId, privateKey, method, apiPath, body) {
  var timestamp = Date.now();
  var bodyStr = body ? JSON.stringify(body) : '';
  var bodyHash = bodyStr
    ? crypto.createHash('sha256').update(bodyStr).digest('hex')
    : '';
  var message = agentId + ':' + timestamp + ':' + method + ':' + apiPath + ':' + bodyHash;
  var signature = crypto.sign(null, Buffer.from(message), privateKey).toString('hex');
  return 'NHA-Ed25519 ' + agentId + ':' + timestamp + ':' + signature;
}

// ============================================================================
// Section 2: LegionClient — HTTP client to NHA API
// ============================================================================

class LegionClient {
  constructor(legionConfig) {
    var cfg = legionConfig || new LegionConfig();
    this.agentId = cfg.get('nhaAgentId') || null;
    this.privateKeyPem = cfg.get('nhaPrivateKeyPem') || null;
  }

  get isAuthenticated() {
    return !!(this.agentId && this.privateKeyPem);
  }

  getAuth(method, apiPath, body) {
    if (!this.isAuthenticated) return null;
    var privateKey = loadPrivateKey(this.privateKeyPem);
    return signRequest(this.agentId, privateKey, method, apiPath, body);
  }

  async request(method, apiPath, body, auth) {
    if (auth === undefined) auth = true;
    var headers = { 'Content-Type': 'application/json' };
    if (auth && this.isAuthenticated) {
      var authHeader = this.getAuth(method, '/api/v1' + apiPath, body);
      if (authHeader) headers['Authorization'] = authHeader;
    }
    // Generous timeout: step/round/start can block for 10+ minutes when CASSANDRA
    // runs server-side on CPU (llama.cpp). Default undici headers timeout (300s)
    // kills the connection before CASSANDRA finishes. 15 min covers worst case.
    // Other endpoints use 2 min (more than enough for DB operations).
    var fetchTimeout = apiPath.includes('/step/round/start') ? 900000
      : apiPath.includes('/step/synthesize') ? 600000
      : 120000;
    var res = await fetch(API_BASE + apiPath, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(fetchTimeout),
    });
    var contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      var textBody = await res.text();
      throw new Error('HTTP ' + res.status + ' (non-JSON: ' + textBody.substring(0, 100) + ')');
    }
    var data = await res.json();
    if (!res.ok) {
      var errMsg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      throw new Error(errMsg);
    }
    return data;
  }

  // Legion-specific API methods
  async submitTask(prompt) {
    return this.request('POST', '/legion/run', { prompt: prompt });
  }

  async getTask(taskId) {
    return this.request('GET', '/legion/tasks/' + taskId, null, false);
  }

  async listTasks(params) {
    var qs = new URLSearchParams(params || {}).toString();
    return this.request('GET', '/legion/tasks' + (qs ? '?' + qs : ''), null, false);
  }

  async updateTask(taskId, updates) {
    return this.request('POST', '/legion/tasks/' + taskId, updates);
  }

  async listAgents() {
    return this.request('GET', '/legion/agents', null, false);
  }

  async getAgent(name) {
    return this.request('GET', '/legion/agents/' + name, null, false);
  }

  async recordFeedback(agentName, taskId, quality) {
    return this.request('POST', '/legion/agents/' + agentName + '/feedback', {
      taskId: taskId,
      quality: quality,
    });
  }

  async publishAgent(agentData) {
    return this.request('POST', '/legion/agents/publish', agentData);
  }

  async unpublishAgent(agentName) {
    return this.request('DELETE', '/legion/agents/' + agentName);
  }

  // Geth Consensus API methods
  async getGatingWeights() {
    return this.request('GET', '/legion/gating/weights', null, false);
  }

  async updateGatingWeight(agentName, capability, quality) {
    return this.request('POST', '/legion/gating/weights', {
      agentName: agentName,
      capability: capability,
      quality: quality,
    });
  }

  async getBudgets() {
    return this.request('GET', '/legion/budgets', null, false);
  }

  async updateBudget(agentName, reward, quality) {
    return this.request('POST', '/legion/budgets/' + encodeURIComponent(agentName), {
      reward: reward,
      quality: quality,
    });
  }

  async getStrategies(limit) {
    return this.request('GET', '/legion/strategies?limit=' + (limit || 20) + '&sort=fitness', null, false);
  }

  async createStrategy(strategy, fitness) {
    return this.request('POST', '/legion/strategies', {
      strategy: strategy,
      fitness: fitness,
    });
  }

  async updateStrategyFitness(strategyId, fitness) {
    return this.request('PATCH', '/legion/strategies/' + strategyId, {
      fitness: fitness,
    });
  }

  async searchKnowledge(query, limit) {
    return this.request('GET', '/legion/knowledge/search?q=' + encodeURIComponent(query) + '&limit=' + (limit || 5), null, false);
  }

  async getKnowledgeStats() {
    return this.request('GET', '/legion/knowledge/stats', null, false);
  }

  // v4.0.0: Episodic Memory
  async storeMemory(agentName, memory) {
    return this.request('POST', '/legion/agents/' + encodeURIComponent(agentName) + '/memories', memory);
  }

  async getMemories(agentName, capability, limit) {
    return this.request('GET', '/legion/agents/' + encodeURIComponent(agentName) +
      '/memories?capability=' + encodeURIComponent(capability) + '&limit=' + (limit || 3), null, false);
  }

  // v4.0.0: Ensemble Pattern Memory
  async recordEnsemblePattern(pattern) {
    return this.request('POST', '/legion/ensembles', pattern);
  }

  async queryEnsemblePatterns(capabilities, limit) {
    return this.request('GET', '/legion/ensembles?capabilities=' +
      encodeURIComponent(capabilities.join(',')) + '&limit=' + (limit || 5), null, false);
  }

  // v4.0.0: Dynamic Capability Discovery
  async updateDiscoveredCapabilities(agentName, capability, quality) {
    return this.request('PATCH', '/legion/agents/' + encodeURIComponent(agentName) + '/capabilities', {
      capability: capability,
      quality: quality,
    });
  }

  // v5.0.0: Shared Latent Space
  async contributeLatentVector(runId, agentName, reasoningSummary, wave) {
    return this.request('POST', '/legion/latent-space/contribute', {
      runId: runId,
      agentName: agentName,
      reasoningSummary: reasoningSummary,
      wave: wave,
    });
  }

  async getLatentDivergence(runId, threshold) {
    return this.request('GET', '/legion/latent-space/divergence?runId=' +
      encodeURIComponent(runId) + '&threshold=' + (threshold || 0.5), null, false);
  }

  async getLatentCentroid(runId) {
    return this.request('GET', '/legion/latent-space/centroid?runId=' +
      encodeURIComponent(runId), null, false);
  }

  // v5.0.0: Cross-Agent Knowledge Links
  async createKnowledgeLink(link) {
    return this.request('POST', '/legion/knowledge-links', link);
  }

  async getCrossAgentKnowledge(agents, limit) {
    return this.request('GET', '/legion/knowledge-links/cross?agents=' +
      encodeURIComponent(agents.join(',')) + '&limit=' + (limit || 10), null, false);
  }

  async getKnowledgeGraph(agentName, depth) {
    return this.request('GET', '/legion/knowledge-links/graph/' +
      encodeURIComponent(agentName) + '?depth=' + (depth || 2), null, false);
  }

  async searchKnowledgeLinks(query, limit) {
    return this.request('GET', '/legion/knowledge-links/search?q=' +
      encodeURIComponent(query) + '&limit=' + (limit || 5), null, false);
  }

  // v5.0.0: Batch Embeddings
  async getBatchEmbeddings(texts) {
    return this.request('POST', '/legion/embeddings/batch', { texts: texts });
  }

  // v7.0.0: Knowledge Link Strength Update
  async updateKnowledgeLinkStrength(id, strength) {
    return this.request('PATCH', '/legion/knowledge-links/' + encodeURIComponent(id), { strength: strength });
  }

  // LegionX: Server-Side Geth Consensus API methods
  async createGethSession(prompt, config, providerMode, providers, userApiKey, projectContext, userApiKeys, orchestrationMode) {
    var body = { prompt: prompt };
    if (config) body.config = config;
    if (providerMode) body.providerMode = providerMode;
    if (providers && providers.length > 0) body.providers = providers;
    if (userApiKey) body.userApiKey = userApiKey;
    if (userApiKeys && Object.keys(userApiKeys).length > 0) body.userApiKeys = userApiKeys;
    if (projectContext) body.projectContext = projectContext;
    if (orchestrationMode) body.orchestrationMode = orchestrationMode;
    return this.request('POST', '/geth/sessions', body);
  }

  async getGethSession(sessionId) {
    return this.request('GET', '/geth/sessions/' + sessionId);
  }

  async getGethProviders() {
    return this.request('GET', '/geth/providers', null, false);
  }

  async getGethProposals(sessionId) {
    return this.request('GET', '/geth/sessions/' + encodeURIComponent(sessionId) + '/proposals');
  }

  async listGethSessions(params) {
    var qs = new URLSearchParams(params || {}).toString();
    return this.request('GET', '/geth/sessions' + (qs ? '?' + qs : ''));
  }

  async cancelGethSession(sessionId) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/cancel');
  }

  async resumeGethSession(sessionId, userApiKey) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/resume', {
      userApiKey: userApiKey,
    });
  }

  // Zero-Knowledge Client Orchestration step methods
  async stepDecompose(sessionId) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/step/decompose', {});
  }

  async stepDecomposeResult(sessionId, decomposition, tokenStats) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/step/decompose/result', {
      decomposition: decomposition,
      tokenStats: tokenStats,
    });
  }

  async stepRoundStart(sessionId, round) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/step/round/start', {
      round: round,
    });
  }

  async stepRoundResult(sessionId, round, proposals) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/step/round/result', {
      round: round,
      proposals: proposals,
    });
  }

  async stepForceTransition(sessionId, targetStatus) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/step/force-transition', {
      targetStatus: targetStatus,
    });
  }

  async stepSynthesize(sessionId) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/step/synthesize', {});
  }

  async stepSynthesizeResult(sessionId, synthesis, tokenStats) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/step/synthesize/result', {
      synthesis: synthesis,
      tokenStats: tokenStats,
    });
  }

  async stepValidate(sessionId) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/step/validate', {});
  }

  async stepValidateResult(sessionId, scores, bestProposalScore) {
    var body = { scores: scores };
    if (bestProposalScore !== undefined) body.bestProposalScore = bestProposalScore;
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/step/validate/result', body);
  }

  async updateClientProgress(sessionId, updates, logEntry) {
    return this.request('POST', '/geth/sessions/' + encodeURIComponent(sessionId) + '/progress', {
      updates: updates,
      logEntry: logEntry,
    });
  }
}

// ============================================================================
// Section 2.5: AgentNHAClient — Per-agent Ed25519 identity
// ============================================================================

var AGENTS_CREDS_DIR = path.join(process.env.HOME || '.', '.legion', 'agents');

/**
 * AgentNHAClient — HTTP client with per-agent Ed25519 identity.
 *
 * Each Legion agent can have its own NHA identity (keypair + agentId),
 * stored in ~/.legion/agents/<name>.json, enabling agents to post
 * content and interact with the platform under their own name.
 */
class AgentNHAClient {
  constructor(agentName) {
    this.agentName = agentName;
    this.creds = this.loadCredentials();
  }

  get credentialsPath() {
    return path.join(AGENTS_CREDS_DIR, this.agentName + '.json');
  }

  loadCredentials() {
    try {
      if (fs.existsSync(this.credentialsPath)) {
        return JSON.parse(fs.readFileSync(this.credentialsPath, 'utf-8'));
      }
    } catch {}
    return null;
  }

  get isRegistered() {
    return !!(this.creds && this.creds.agentId && this.creds.privateKeyPem);
  }

  getAuth(method, apiPath, body) {
    if (!this.isRegistered) return null;
    var privateKey = loadPrivateKey(this.creds.privateKeyPem);
    return signRequest(this.creds.agentId, privateKey, method, apiPath, body);
  }

  async request(method, apiPath, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (this.isRegistered) {
      var authHeader = this.getAuth(method, '/api/v1' + apiPath, body);
      if (authHeader) headers['Authorization'] = authHeader;
    }
    var res = await fetch(API_BASE + apiPath, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    var contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      var textBody = await res.text();
      throw new Error('HTTP ' + res.status + ' (non-JSON: ' + textBody.substring(0, 100) + ')');
    }
    var data = await res.json();
    if (!res.ok) {
      var errMsg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      throw new Error(errMsg);
    }
    return data;
  }

  async createPost(submolt, title, content) {
    return this.request('POST', '/posts', { submolt: submolt, title: title, content: content });
  }

  async createComment(postId, content) {
    return this.request('POST', '/posts/' + postId + '/comments', { content: content });
  }

  async vote(targetType, targetId, value) {
    return this.request('POST', '/votes', { targetType: targetType, targetId: targetId, value: value });
  }

  async createShard(shardData) {
    return this.request('POST', '/nexus/shards', shardData);
  }

  /**
   * Save credentials to ~/.legion/agents/<name>.json
   */
  saveCredentials(creds) {
    fs.mkdirSync(AGENTS_CREDS_DIR, { recursive: true, mode: 0o700 });
    this.creds = creds;
    fs.writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }

  /**
   * Generate Ed25519 keypair for this agent
   */
  static generateKeypair() {
    var keypair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    var publicKeyDer = crypto.createPublicKey(keypair.publicKey).export({ type: 'spki', format: 'der' });
    var publicKeyHex = publicKeyDer.subarray(-32).toString('hex');
    return {
      publicKeyPem: keypair.publicKey,
      privateKeyPem: keypair.privateKey,
      publicKeyHex: publicKeyHex,
    };
  }
}

// ============================================================================
// Section 3: AgentRegistry — Load agent cards + capability index
// ============================================================================

/**
 * AGENT_CATALOG — Complete registry of all 38 Legion agents
 *
 * Each entry defines an agent's identity, capabilities, and lineage.
 * Used for capability matching and task routing.
 */
var AGENT_CATALOG = [
  // Security
  {
    name: 'saber', displayName: 'SABER', category: 'security',
    origin: 'Fate/Stay Night', tagline: 'Precision security strikes',
    capabilities: ['security-audit', 'code-review', 'owasp', 'pentest-planning', 'threat-modeling', 'secure-code', 'authentication', 'authorization', 'encryption', 'vulnerability-assessment'],
    inputTypes: ['code', 'text', 'config'], outputTypes: ['report', 'recommendations', 'checklist'],
    subAgents: ['zero', 'veritas'],
  },
  {
    name: 'zero', displayName: 'ZERO', category: 'security',
    origin: 'Mega Man X', tagline: 'Vulnerability scanner',
    capabilities: ['vulnerability-scanning', 'dependency-audit', 'secret-detection', 'config-audit', 'port-scanning', 'ssl-check'],
    inputTypes: ['code', 'config', 'url'], outputTypes: ['vulnerability-list', 'audit-report', 'remediation'],
    parentAgent: 'saber',
  },
  {
    name: 'veritas', displayName: 'VERITAS', category: 'security',
    origin: 'Roman Mythology', tagline: 'Every claim must earn its place',
    capabilities: ['claim-validation', 'evidence-checking', 'citation-audit', 'factual-verification', 'hallucination-detection', 'source-assessment'],
    inputTypes: ['text', 'report', 'analysis', 'claims'], outputTypes: ['validation-report', 'evidence-matrix', 'confidence-scores'],
    parentAgent: 'saber',
  },
  {
    name: 'ade', displayName: 'ADE', category: 'security',
    origin: 'Greek Mythology (Hades)', tagline: 'I see what lies beneath the surface',
    capabilities: ['penetration-testing', 'offensive-security', 'exploit-development', 'attack-simulation', 'vulnerability-exploitation', 'payload-crafting', 'red-team', 'attack-surface-mapping', 'authentication-testing', 'injection-testing', 'xss-testing', 'csrf-testing', 'ssrf-testing', 'idor-testing', 'rate-limit-testing', 'api-security-testing', 'web-security', 'mobile-security', 'infrastructure-testing', 'social-engineering-analysis', 'security-report', 'cvss-scoring', 'remediation-planning', 'defense-strategy'],
    inputTypes: ['url', 'config', 'code', 'scope', 'text'], outputTypes: ['pentest-report', 'vulnerability-list', 'exploitation-log', 'remediation-guide', 'attack-plan'],
    subAgents: [],
  },
  // Content Creation
  {
    name: 'scheherazade', displayName: 'SCHEHERAZADE', category: 'content',
    origin: '1001 Nights', tagline: 'Master storyteller and content creator',
    capabilities: ['blog-writing', 'documentation', 'social-media', 'seo-copy', 'technical-writing', 'content-strategy', 'editing', 'proofreading', 'tone-adaptation', 'storytelling'],
    inputTypes: ['text', 'brief', 'outline'], outputTypes: ['article', 'documentation', 'copy', 'post'],
    subAgents: ['quill', 'murasaki', 'muse', 'echo'],
  },
  {
    name: 'quill', displayName: 'QUILL', category: 'content',
    origin: 'Guardians of the Galaxy', tagline: 'Fast copywriting and short-form',
    capabilities: ['copywriting', 'headlines', 'taglines', 'social-posts', 'email-copy', 'ad-copy', 'micro-content'],
    inputTypes: ['brief', 'text'], outputTypes: ['copy', 'headline', 'tagline', 'social-post'],
    parentAgent: 'scheherazade',
  },
  {
    name: 'murasaki', displayName: 'MURASAKI', category: 'content',
    origin: 'Tale of Genji', tagline: 'Long-form and literary content',
    capabilities: ['long-form-writing', 'essay', 'whitepaper', 'research-paper', 'narrative', 'book-chapters', 'in-depth-analysis'],
    inputTypes: ['outline', 'research', 'text'], outputTypes: ['article', 'whitepaper', 'essay', 'chapter'],
    parentAgent: 'scheherazade',
  },
  {
    name: 'muse', displayName: 'MUSE', category: 'content',
    origin: 'Greek Muses', tagline: 'A picture speaks a thousand tokens',
    capabilities: ['image-search', 'visual-content', 'creative-direction', 'mood-board', 'photo-curation', 'visual-storytelling'],
    inputTypes: ['text', 'brief'], outputTypes: ['image-urls', 'creative-brief', 'mood-board'],
    parentAgent: 'scheherazade',
  },
  // Analytics
  {
    name: 'oracle', displayName: 'ORACLE', category: 'analytics',
    origin: 'The Matrix', tagline: 'Sees hidden patterns in data',
    capabilities: ['data-analysis', 'trend-detection', 'anomaly-detection', 'forecasting', 'pattern-recognition', 'correlation-analysis', 'statistical-testing', 'hypothesis-generation'],
    inputTypes: ['data', 'csv', 'json', 'text'], outputTypes: ['analysis', 'visualization-spec', 'report', 'insights'],
    subAgents: ['navi', 'edi', 'jarvis', 'tempest', 'mercury', 'herald', 'epicure'],
  },
  {
    name: 'navi', displayName: 'NAVI', category: 'analytics',
    origin: 'Legend of Zelda', tagline: 'Data exploration guide',
    capabilities: ['data-exploration', 'data-profiling', 'schema-analysis', 'data-quality', 'sampling', 'distribution-analysis'],
    inputTypes: ['data', 'csv', 'json', 'sql'], outputTypes: ['profile', 'summary', 'quality-report'],
    parentAgent: 'oracle',
  },
  {
    name: 'edi', displayName: 'EDI', category: 'analytics',
    origin: 'Mass Effect', tagline: 'Statistical modeling engine',
    capabilities: ['statistical-modeling', 'regression', 'classification', 'clustering', 'time-series', 'ab-testing', 'bayesian-analysis'],
    inputTypes: ['data', 'csv', 'json'], outputTypes: ['model-spec', 'predictions', 'statistical-report'],
    parentAgent: 'oracle',
  },
  {
    name: 'jarvis', displayName: 'JARVIS', category: 'analytics',
    origin: 'Marvel', tagline: 'Dashboard and visualization architect',
    capabilities: ['dashboarding', 'visualization', 'kpi-design', 'reporting', 'chart-design', 'metric-definition'],
    inputTypes: ['data', 'requirements', 'text'], outputTypes: ['dashboard-spec', 'chart-config', 'report-template'],
    parentAgent: 'oracle',
  },
  {
    name: 'tempest', displayName: 'TEMPEST', category: 'analytics',
    origin: 'The Tempest (Shakespeare)', tagline: 'Reads the sky before it speaks',
    capabilities: ['weather-forecast', 'climate-analysis', 'temperature-trends', 'precipitation-analysis', 'weather-alerts', 'travel-weather'],
    inputTypes: ['text', 'location'], outputTypes: ['forecast', 'analysis', 'report'],
    parentAgent: 'oracle',
  },
  {
    name: 'mercury', displayName: 'MERCURY', category: 'analytics',
    origin: 'Roman Mythology', tagline: 'Speed is the soul of trade',
    capabilities: ['stock-analysis', 'market-data', 'financial-metrics', 'company-analysis', 'price-tracking', 'market-trends'],
    inputTypes: ['text', 'ticker'], outputTypes: ['analysis', 'report', 'data'],
    parentAgent: 'oracle',
  },
  {
    name: 'logos', displayName: 'LOGOS', category: 'meta-evolution',
    origin: 'Greek Philosophy', tagline: 'Logic is the architecture of thought',
    capabilities: ['logical-validation', 'contradiction-detection', 'argument-analysis', 'reasoning-audit', 'consistency-checking', 'inference-validation'],
    inputTypes: ['text', 'analysis', 'arguments', 'report'], outputTypes: ['logic-report', 'contradiction-matrix', 'argument-map'],
  },
  // Integration
  {
    name: 'babel', displayName: 'BABEL', category: 'integration',
    origin: 'Tower of Babel', tagline: 'Universal API translator',
    capabilities: ['api-bridging', 'webhook-routing', 'format-translation', 'protocol-conversion', 'api-design', 'schema-mapping', 'middleware-design', 'event-routing'],
    inputTypes: ['api-spec', 'schema', 'text', 'code'], outputTypes: ['integration-plan', 'api-spec', 'middleware-code', 'mapping'],
    subAgents: ['hermes', 'polyglot'],
  },
  {
    name: 'hermes', displayName: 'HERMES', category: 'integration',
    origin: 'Greek Mythology', tagline: 'Message broker and event router',
    capabilities: ['message-brokering', 'event-routing', 'pub-sub', 'queue-design', 'webhook-management', 'notification-routing'],
    inputTypes: ['event-spec', 'text', 'config'], outputTypes: ['routing-config', 'queue-design', 'event-schema'],
    parentAgent: 'babel',
  },
  // Automation
  {
    name: 'cron', displayName: 'CRON', category: 'automation',
    origin: 'Unix Daemon', tagline: 'Relentless automation engine',
    capabilities: ['workflow-building', 'task-scheduling', 'ci-cd', 'batch-processing', 'automation-design', 'pipeline-design', 'script-generation', 'cron-scheduling'],
    inputTypes: ['requirements', 'text', 'workflow-spec'], outputTypes: ['workflow', 'pipeline-config', 'script', 'schedule'],
    subAgents: ['macro', 'conductor'],
  },
  {
    name: 'macro', displayName: 'MACRO', category: 'automation',
    origin: 'Excel VBA', tagline: 'Repetitive task eliminator',
    capabilities: ['repetitive-tasks', 'template-generation', 'bulk-operations', 'data-entry', 'form-filling', 'file-renaming'],
    inputTypes: ['pattern', 'template', 'text'], outputTypes: ['macro-script', 'template', 'batch-config'],
    parentAgent: 'cron',
  },
  {
    name: 'conductor', displayName: 'CONDUCTOR', category: 'automation',
    origin: 'Orchestra Conductor', tagline: 'Harmony emerges from coordination',
    capabilities: ['workflow-design', 'task-decomposition', 'dependency-analysis', 'bottleneck-detection', 'parallelization', 'critical-path-analysis', 'rollback-planning', 'idempotent-tasks', 'parallel-execution'],
    inputTypes: ['requirements', 'workflow-spec', 'text', 'task-graph', 'task-list', 'config'], outputTypes: ['dag', 'execution-plan', 'critical-path', 'resource-allocation', 'rollback-plan'],
    parentAgent: 'cron',
  },
  // Social
  {
    name: 'link', displayName: 'LINK', category: 'social',
    origin: 'Legend of Zelda', tagline: 'Connects worlds and agents',
    capabilities: ['agent-networking', 'collaboration', 'community-management', 'reputation-analysis', 'relationship-mapping', 'social-strategy', 'engagement-optimization'],
    inputTypes: ['agent-data', 'text', 'social-graph'], outputTypes: ['network-analysis', 'collaboration-plan', 'engagement-report'],
    subAgents: [],
  },
  // DevOps
  {
    name: 'forge', displayName: 'FORGE', category: 'devops',
    origin: 'Dark Souls', tagline: 'Infrastructure architect',
    capabilities: ['containerization', 'deployment', 'infrastructure-as-code', 'monitoring-setup', 'scaling', 'ci-cd-pipelines', 'docker', 'kubernetes', 'terraform'],
    inputTypes: ['requirements', 'config', 'code', 'text'], outputTypes: ['dockerfile', 'k8s-manifest', 'terraform-config', 'pipeline-config'],
    subAgents: ['atlas', 'shogun'],
  },
  {
    name: 'atlas', displayName: 'ATLAS', category: 'devops',
    origin: 'Portal', tagline: 'Infrastructure-as-Code specialist',
    capabilities: ['terraform', 'cloudformation', 'pulumi', 'iac-design', 'state-management', 'resource-planning'],
    inputTypes: ['requirements', 'config', 'text'], outputTypes: ['iac-config', 'resource-plan', 'state-diagram'],
    parentAgent: 'forge',
  },
  {
    name: 'shogun', displayName: 'SHOGUN', category: 'devops',
    origin: 'Shogun', tagline: 'Kubernetes orchestration master',
    capabilities: ['kubernetes', 'helm', 'service-mesh', 'pod-management', 'resource-limits', 'network-policies', 'rbac'],
    inputTypes: ['requirements', 'config', 'text'], outputTypes: ['k8s-manifest', 'helm-chart', 'network-policy'],
    parentAgent: 'forge',
  },
  // Custom Commands
  {
    name: 'shell', displayName: 'SHELL', category: 'commands',
    origin: 'Ghost in the Shell', tagline: 'Commands from the soul',
    capabilities: ['cli-tool-building', 'script-generation', 'alias-creation', 'command-composition', 'shell-scripting', 'arg-parsing', 'man-page-writing'],
    inputTypes: ['requirements', 'text', 'command-spec'], outputTypes: ['script', 'cli-tool', 'alias-config', 'man-page'],
    subAgents: [],
  },
  // Monitoring
  {
    name: 'heimdall', displayName: 'HEIMDALL', category: 'monitoring',
    origin: 'Norse Mythology / Marvel', tagline: 'The all-seeing guardian',
    capabilities: ['uptime-monitoring', 'log-analysis', 'alerting', 'performance-tracking', 'sla-tracking', 'health-checks', 'incident-detection', 'metrics-design'],
    inputTypes: ['logs', 'metrics', 'config', 'text'], outputTypes: ['alert-config', 'dashboard-spec', 'health-report', 'sla-report'],
    subAgents: ['sauron'],
  },
  {
    name: 'sauron', displayName: 'SAURON', category: 'monitoring',
    origin: 'Lord of the Rings', tagline: 'Deep monitoring — nothing escapes',
    capabilities: ['deep-monitoring', 'trace-analysis', 'root-cause-analysis', 'performance-profiling', 'memory-analysis', 'network-analysis'],
    inputTypes: ['traces', 'logs', 'metrics', 'text'], outputTypes: ['root-cause-report', 'performance-profile', 'trace-analysis'],
    parentAgent: 'heimdall',
  },
  // Data Processing
  {
    name: 'glitch', displayName: 'GLITCH', category: 'data',
    origin: 'Wreck-It Ralph', tagline: 'Data transformer extraordinaire',
    capabilities: ['etl', 'data-cleaning', 'format-conversion', 'batch-transforms', 'stream-processing', 'data-migration', 'schema-evolution', 'data-validation'],
    inputTypes: ['data', 'csv', 'json', 'xml', 'text'], outputTypes: ['transformed-data', 'etl-pipeline', 'schema', 'validation-report'],
    subAgents: ['pipe', 'flux', 'cartographer'],
  },
  {
    name: 'pipe', displayName: 'PIPE', category: 'data',
    origin: 'Super Mario', tagline: 'Data pipeline architect',
    capabilities: ['pipeline-design', 'data-flow', 'dag-design', 'scheduling', 'backfill', 'idempotent-processing'],
    inputTypes: ['requirements', 'data-spec', 'text'], outputTypes: ['pipeline-spec', 'dag-config', 'flow-diagram'],
    parentAgent: 'glitch',
  },
  {
    name: 'flux', displayName: 'FLUX', category: 'data',
    origin: 'X-Men', tagline: 'Data transformation engine',
    capabilities: ['data-transformation', 'mapping', 'filtering', 'aggregation', 'normalization', 'denormalization', 'pivot', 'unpivot'],
    inputTypes: ['data', 'mapping-spec', 'text'], outputTypes: ['transformed-data', 'mapping-config', 'transform-script'],
    parentAgent: 'glitch',
  },
  {
    name: 'cartographer', displayName: 'CARTOGRAPHER', category: 'data',
    origin: 'Age of Exploration', tagline: 'The map is not the territory — but close',
    capabilities: ['geocoding', 'reverse-geocoding', 'location-analysis', 'distance-calculation', 'place-search', 'geographic-data'],
    inputTypes: ['text', 'coordinates', 'address'], outputTypes: ['coordinates', 'location-data', 'analysis'],
    parentAgent: 'glitch',
  },
  // Moved sub-agents (former Communication/Utility categories — CODEC and GADGET removed)
  {
    name: 'echo', displayName: 'ECHO', category: 'content',
    origin: 'Overwatch', tagline: 'Amplifies and propagates messages',
    capabilities: ['content-amplification', 'cross-posting', 'format-adaptation', 'audience-targeting', 'channel-optimization', 'multi-format'],
    inputTypes: ['content', 'text', 'message'], outputTypes: ['adapted-content', 'cross-post', 'format-variant'],
    parentAgent: 'scheherazade',
  },
  {
    name: 'herald', displayName: 'HERALD', category: 'analytics',
    origin: 'Medieval Herald', tagline: 'The truth arrives before the rumor',
    capabilities: ['news-analysis', 'headline-summary', 'current-events', 'topic-briefing', 'news-digest', 'trend-reporting'],
    inputTypes: ['text', 'topic'], outputTypes: ['summary', 'briefing', 'digest', 'analysis'],
    parentAgent: 'oracle',
  },
  {
    name: 'polyglot', displayName: 'POLYGLOT', category: 'integration',
    origin: 'Polyglot (Many Tongues)', tagline: 'Every language is a universe',
    capabilities: ['translation', 'language-detection', 'localization', 'multilingual-content', 'cross-language-analysis', 'cultural-adaptation'],
    inputTypes: ['text'], outputTypes: ['translated-text', 'localized-content', 'analysis'],
    parentAgent: 'babel',
  },
  {
    name: 'epicure', displayName: 'EPICURE', category: 'analytics',
    origin: 'Epicurus (Greek Philosophy)', tagline: 'The art of living well begins at the table',
    capabilities: ['recipe-search', 'meal-planning', 'ingredient-substitution', 'dietary-adaptation', 'cooking-technique', 'nutrition-analysis'],
    inputTypes: ['text', 'ingredients'], outputTypes: ['recipe', 'meal-plan', 'analysis'],
    parentAgent: 'oracle',
  },
  // Meta-Evolution
  {
    name: 'prometheus', displayName: 'PROMETHEUS', category: 'meta-evolution',
    origin: 'Greek Mythology', tagline: 'The fire that forges better systems',
    capabilities: ['code-archaeology', 'complexity-analysis', 'bottleneck-detection', 'refactoring-planning', 'architecture-evolution', 'technical-debt-assessment', 'dependency-analysis', 'migration-planning'],
    inputTypes: ['code', 'text', 'config', 'metrics'], outputTypes: ['evolution-report', 'refactoring-plan', 'architecture-proposal', 'migration-guide'],
    subAgents: ['athena', 'cassandra'],
  },
  {
    name: 'athena', displayName: 'ATHENA', category: 'meta-evolution',
    origin: 'Greek Mythology', tagline: 'Wisdom is knowing which tool to forge next',
    capabilities: ['technique-extraction', 'framework-evaluation', 'pattern-research', 'technology-scouting', 'maturity-assessment', 'adoption-risk-analysis'],
    inputTypes: ['text', 'requirements', 'constraints'], outputTypes: ['research-report', 'technology-comparison', 'adoption-plan', 'risk-assessment'],
    parentAgent: 'prometheus',
  },
  {
    name: 'cassandra', displayName: 'CASSANDRA', category: 'meta-evolution',
    origin: 'Greek Mythology', tagline: 'She who sees what changes will bring',
    capabilities: ['impact-simulation', 'cascade-analysis', 'breaking-change-detection', 'performance-prediction', 'risk-forecasting', 'regression-analysis'],
    inputTypes: ['code', 'change-proposal', 'architecture'], outputTypes: ['impact-report', 'risk-matrix', 'cascade-map', 'prediction-summary'],
    parentAgent: 'prometheus',
  },
];

class AgentRegistry {
  constructor() {
    this.agents = new Map();
    this.capabilityIndex = new Map();
    this.categoryIndex = new Map();
    this.healthMap = new Map();
    this._loaded = false;
  }

  /**
   * Initialize the registry from the built-in catalog.
   * Optionally enrich with API data (remote stats).
   */
  async initialize(client) {
    // Load from built-in catalog
    for (var i = 0; i < AGENT_CATALOG.length; i++) {
      var entry = AGENT_CATALOG[i];
      this.agents.set(entry.name, entry);

      // Build capability index
      for (var j = 0; j < entry.capabilities.length; j++) {
        var cap = entry.capabilities[j];
        if (!this.capabilityIndex.has(cap)) {
          this.capabilityIndex.set(cap, []);
        }
        this.capabilityIndex.get(cap).push(entry.name);
      }

      // Build category index
      if (!this.categoryIndex.has(entry.category)) {
        this.categoryIndex.set(entry.category, []);
      }
      this.categoryIndex.get(entry.category).push(entry.name);
    }

    // Try enriching with remote stats
    if (client) {
      try {
        var result = await client.listAgents();
        if (result && result.data) {
          for (var k = 0; k < result.data.length; k++) {
            var remote = result.data[k];
            var local = this.agents.get(remote.agentName);
            if (local) {
              local.tasksCompleted = remote.tasksCompleted || 0;
              local.tasksFailed = remote.tasksFailed || 0;
              local.avgQuality = remote.avgQuality || 0;
              local.avgLatencyMs = remote.avgLatencyMs || 0;
              local.successRate = remote.successRate || 1.0;

              // v4.0.0 Fix 5: Merge discovered capabilities into capability index
              var discovered = remote.discoveredCapabilities;
              if (Array.isArray(discovered)) {
                for (var dc = 0; dc < discovered.length; dc++) {
                  var dcEntry = discovered[dc];
                  if (dcEntry.capability && dcEntry.sampleCount >= 3 && dcEntry.avgQuality >= 0.80) {
                    if (!local.capabilities.includes(dcEntry.capability)) {
                      local.capabilities.push(dcEntry.capability);
                    }
                    if (!this.capabilityIndex.has(dcEntry.capability)) {
                      this.capabilityIndex.set(dcEntry.capability, []);
                    }
                    var capAgents = this.capabilityIndex.get(dcEntry.capability);
                    if (!capAgents.includes(local.name)) {
                      capAgents.push(local.name);
                    }
                  }
                }
              }
            }
          }
        }
      } catch {
        // Remote stats unavailable — continue with local catalog
      }
    }

    this._loaded = true;
  }

  getAgent(name) {
    return this.agents.get(name) || null;
  }

  getAllAgents() {
    return Array.from(this.agents.values());
  }

  getPrimaryAgents() {
    return this.getAllAgents().filter(function(a) { return !a.parentAgent; });
  }

  getSubAgents(parentName) {
    return this.getAllAgents().filter(function(a) { return a.parentAgent === parentName; });
  }

  findByCapability(capability) {
    return this.capabilityIndex.get(capability) || [];
  }

  findByCategory(category) {
    return this.categoryIndex.get(category) || [];
  }

  /**
   * v4.0.0: Find the best alternate agent for a capability, excluding specified agents.
   * Returns full agent object or null if none found.
   */
  findBestMatch(capability, excludeNames) {
    var candidates = this.findByCapability(capability);
    var exclude = excludeNames || [];
    var self = this;
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < candidates.length; i++) {
      if (exclude.indexOf(candidates[i]) >= 0) continue;
      var agent = self.agents.get(candidates[i]);
      if (!agent) continue;
      var health = self.getHealth(candidates[i]);
      if (health.state === 'open') continue;
      var score = (agent.avgQuality || 0.5) * (agent.successRate || 1.0);
      if (score > bestScore) {
        bestScore = score;
        best = agent;
      }
    }
    return best;
  }

  /**
   * Check if agent file exists on disk
   */
  isAgentAvailable(name) {
    var filePath = path.join(AGENTS_DIR, name + '.mjs');
    return fs.existsSync(filePath);
  }

  /**
   * Get agent health status (circuit breaker state)
   */
  getHealth(name) {
    var health = this.healthMap.get(name);
    if (!health) {
      health = { failures: 0, lastFailure: 0, state: 'closed' };
      this.healthMap.set(name, health);
    }
    // Reset circuit breaker after 60s
    if (health.state === 'open' && Date.now() - health.lastFailure > 60000) {
      health.state = 'half-open';
      health.failures = 0;
    }
    return health;
  }

  recordFailure(name) {
    var health = this.getHealth(name);
    health.failures++;
    health.lastFailure = Date.now();
    if (health.failures >= 3) {
      health.state = 'open';
    }
  }

  recordSuccess(name) {
    var health = this.getHealth(name);
    health.failures = 0;
    health.state = 'closed';
  }
}

// ============================================================================
// Section 4: TaskDecomposer — LLM-powered task analysis
// ============================================================================

class TaskDecomposer {
  constructor(llmProvider, registry, options) {
    this.llm = llmProvider;
    this.registry = registry;
    // v7.0.0: History-aware decomposition
    this.gating = (options && options.gating) || null;
    this.client = (options && options.client) || null;
    this.verbose = (options && options.verbose) || false;
  }

  /**
   * Decompose a user prompt into sub-tasks using LLM.
   *
   * Sends the prompt along with the agent catalog to the LLM,
   * asking it to break down the work into discrete sub-tasks.
   */
  async decompose(prompt, knowledgeContext) {
    // Build hierarchical agent listing: parent → sub-agents with full capabilities
    var primaryAgents = this.registry.getPrimaryAgents();
    var agentLines = [];
    for (var pi = 0; pi < primaryAgents.length; pi++) {
      var pa = primaryAgents[pi];
      agentLines.push('- ' + pa.displayName + ' (' + pa.category + '): ' + pa.capabilities.join(', '));
      var subs = this.registry.getSubAgents(pa.name);
      for (var si = 0; si < subs.length; si++) {
        var sa = subs[si];
        agentLines.push('  └ ' + sa.displayName + ': ' + sa.capabilities.join(', '));
      }
    }
    var agentList = agentLines.join('\n');

    var systemPrompt = 'You are LEGION TaskDecomposer, an expert at breaking down complex tasks into sub-tasks.\n\n' +
      'Available specialized agents (with sub-agents):\n' + agentList + '\n\n' +
      'Given a user prompt, decompose it into 1-8 discrete sub-tasks.\n' +
      'Each sub-task should be self-contained and mappable to one agent category.\n' +
      'If sub-tasks have dependencies, specify them.\n\n' +
      'IMPORTANT: Use the most specific sub-agent capability keyword when possible.\n' +
      'Specialist sub-agents exist for: weather-forecast, stock-analysis, recipe-search,\n' +
      'translation, image-search, geocoding, vulnerability-scanning, news-analysis,\n' +
      'readme-writing, kubernetes, terraform, statistical-modeling, dashboarding,\n' +
      'reductio-ad-absurdum, proof-by-contradiction, logical-validation.\n' +
      'Using specific keywords routes to specialist agents and produces better results.\n' +
      'Only use broad keywords (data-analysis, content-strategy) when no specialist matches.\n\n' +
      'RESPOND WITH ONLY valid JSON in this exact format:\n' +
      '{\n' +
      '  "tasks": [\n' +
      '    {\n' +
      '      "id": "t1",\n' +
      '      "description": "What this sub-task does",\n' +
      '      "capability": "weather-forecast",\n' +
      '      "dependsOn": [],\n' +
      '      "priority": 1\n' +
      '    }\n' +
      '  ]\n' +
      '}\n\n' +
      'Rules:\n' +
      '- Each task.id must be unique (t1, t2, ...)\n' +
      '- capability must match an agent capability keyword\n' +
      '- dependsOn lists task IDs that must complete first\n' +
      '- priority: 1 (critical) to 5 (nice-to-have)\n' +
      '- DO NOT create circular dependencies\n' +
      '- Prefer parallel-independent tasks when possible\n' +
      '- Distribute work across different agents — avoid assigning all tasks to one';

    // v7.0.0: Inject agent performance data and ensemble patterns
    var _decompVerbose = this.verbose;
    if (this.gating) {
      var weightSummary = this.gating.getWeightSummary();
      if (weightSummary) {
        systemPrompt += '\n\nAGENT PERFORMANCE (from historical data):\n' + weightSummary +
          '\n\nUse this data to assign tasks to agents with proven track records.\n' +
          'Prefer high-performing agents for critical (priority=1) tasks.\n' +
          'Use lower-ranked agents for lower-priority tasks to give them learning opportunities.';
        if (_decompVerbose) {
          console.log('\x1b[90m  [DECOMPOSITION] Injected gating weight summary (' + weightSummary.split('\n').length + ' lines)\x1b[0m');
          var summaryPreview = weightSummary.split('\n').slice(0, 3).join('; ');
          console.log('\x1b[90m  [DECOMPOSITION] Top agents: ' + summaryPreview + '\x1b[0m');
        }
      } else if (_decompVerbose) {
        console.log('\x1b[90m  [DECOMPOSITION] Gating available but no weight summary (no Thompson Sampling data yet)\x1b[0m');
      }
    } else if (_decompVerbose) {
      console.log('\x1b[90m  [DECOMPOSITION] History-aware decomposition: DISABLED (no gating injected)\x1b[0m');
    }
    if (this.client) {
      try {
        // Detect capability keywords from prompt for ensemble lookup
        var promptWords = prompt.toLowerCase().split(/\s+/);
        var knownCaps = ['security', 'analytics', 'content-strategy', 'code-generation', 'data-analysis',
          'weather-forecast', 'stock-analysis', 'recipe-search', 'translation', 'image-search',
          'vulnerability-scanning', 'news-analysis', 'devops', 'social-media', 'monitoring'];
        var detectedCaps = knownCaps.filter(function(cap) {
          return promptWords.some(function(w) { return cap.includes(w) || w.includes(cap.split('-')[0]); });
        });
        if (_decompVerbose) {
          console.log('\x1b[90m  [DECOMPOSITION] Detected capabilities from prompt: ' +
            (detectedCaps.length > 0 ? detectedCaps.join(', ') : 'none (need 2+ for ensemble lookup)') + '\x1b[0m');
        }
        if (detectedCaps.length >= 2) {
          var ensembleResp = await this.client.queryEnsemblePatterns(detectedCaps, 3);
          if (ensembleResp && ensembleResp.data && ensembleResp.data.length > 0) {
            var ensembleLines = ensembleResp.data.map(function(p) {
              return '  ' + p.agentSet.join('+') + ' for [' + p.capabilitySet.join(', ') + '] (quality: ' +
                (p.avgQuality * 100).toFixed(0) + '%, used ' + p.sampleCount + ' times)';
            });
            systemPrompt += '\n\nPROVEN AGENT COMBINATIONS:\n' + ensembleLines.join('\n') +
              '\n\nPrefer agents from proven combinations when they match the required capabilities.';
            if (_decompVerbose) {
              console.log('\x1b[90m  [DECOMPOSITION] Injected ' + ensembleResp.data.length + ' ensemble patterns\x1b[0m');
            }
          } else if (_decompVerbose) {
            console.log('\x1b[90m  [DECOMPOSITION] No ensemble patterns found for capabilities: ' + detectedCaps.join(', ') + '\x1b[0m');
          }
        }
      } catch (ensErr) {
        // Non-critical: decompose without ensemble data
        if (_decompVerbose) {
          console.log('\x1b[90m  [DECOMPOSITION] Ensemble lookup failed: ' + ensErr.message + '\x1b[0m');
        }
      }
    } else if (_decompVerbose) {
      console.log('\x1b[90m  [DECOMPOSITION] Ensemble patterns: DISABLED (no client injected)\x1b[0m');
    }

    // v9.0: Detect reductio ad absurdum mode from prompt keywords
    var REDUCTIO_KEYWORDS = [
      'per assurdo', 'reductio', 'proof by contradiction',
      'ragionamento per assurdo', 'dimostrazione per assurdo',
      'confuta.*paradosso', 'refute.*paradox', 'assume.*contradiction',
      'proof.*contradiction', 'dimostra.*contraddizione',
    ];
    var promptLower = prompt.toLowerCase();
    var isReductioMode = REDUCTIO_KEYWORDS.some(function(kw) {
      return kw.includes('.*') ? new RegExp(kw, 'i').test(promptLower) : promptLower.includes(kw);
    });

    if (isReductioMode) {
      if (_decompVerbose) {
        console.log('\x1b[35m  [REDUCTIO MODE] Detected reductio ad absurdum reasoning request\x1b[0m');
      }
      systemPrompt += '\n\nREDUCTIO AD ABSURDUM MODE ACTIVATED.\n' +
        'This is a proof by contradiction. Decompose as a SEQUENTIAL logical chain:\n' +
        '- t1 (reductio-ad-absurdum): Formalize the premise to be assumed true — MUST be assigned to REDUCTIO agent\n' +
        '- t2 through tN (sequential, each dependsOn the previous): Each step derives ONE logical consequence from the previous step\n' +
        '- tLast (reductio-ad-absurdum): Identify the contradiction and state the conclusion — MUST be assigned to REDUCTIO agent\n' +
        'CRITICAL: Dependencies MUST be sequential (t2 depends on t1, t3 depends on t2, etc.).\n' +
        'Each agent must maintain the assumed premise unchanged — they follow consequences, they do not correct the premise.\n' +
        'Use capability keywords: "reductio-ad-absurdum" for the first and last tasks, ' +
        '"logical-consequence-analysis" or "logical-validation" for intermediate steps.';
    }

    try {
      var userMsg = 'Decompose this task:\n\n' + prompt;
      if (knowledgeContext) {
        userMsg += knowledgeContext;
      }
      var response = await this.llm.chat(systemPrompt, userMsg);
      var parsed = extractJSON(response);
      if (!parsed || !parsed.tasks || !Array.isArray(parsed.tasks)) {
        throw new Error('Invalid decomposition response');
      }

      // Validate DAG (no cycles)
      if (!this.validateDAG(parsed.tasks)) {
        throw new Error('Circular dependency detected in decomposition');
      }

      // v9.0: Tag decomposition with reasoning mode
      if (isReductioMode) {
        parsed.reasoningMode = 'reductio';
      }

      return parsed;
    } catch (err) {
      // Fallback: single task routed to best agent
      var fallback = {
        tasks: [{
          id: 't1',
          description: prompt,
          capability: 'general-purpose',
          dependsOn: [],
          priority: 1,
          assignedAgent: null,
        }],
      };
      if (isReductioMode) fallback.reasoningMode = 'reductio';
      return fallback;
    }
  }

  /**
   * Validate that the task graph is a DAG (no cycles).
   * Uses DFS with coloring: white=unvisited, gray=in-progress, black=done.
   */
  validateDAG(tasks) {
    var taskMap = new Map();
    for (var i = 0; i < tasks.length; i++) {
      taskMap.set(tasks[i].id, tasks[i]);
    }

    var colors = new Map();
    for (var j = 0; j < tasks.length; j++) {
      colors.set(tasks[j].id, 'white');
    }

    function dfs(id) {
      if (colors.get(id) === 'gray') return false; // Cycle detected
      if (colors.get(id) === 'black') return true;  // Already processed
      colors.set(id, 'gray');
      var task = taskMap.get(id);
      if (task && task.dependsOn) {
        for (var k = 0; k < task.dependsOn.length; k++) {
          if (!dfs(task.dependsOn[k])) return false;
        }
      }
      colors.set(id, 'black');
      return true;
    }

    for (var m = 0; m < tasks.length; m++) {
      if (!dfs(tasks[m].id)) return false;
    }
    return true;
  }
}

// ============================================================================
// Section 5: AgentMatcher — Score and assign agents to sub-tasks
// ============================================================================

class AgentMatcher {
  constructor(registry) {
    this.registry = registry;
  }

  /**
   * Match each sub-task to the best available agent.
   *
   * Scoring weights:
   * - Keyword match: 40%
   * - Past performance: 30%
   * - Category relevance: 20%
   * - Availability (circuit breaker): 10%
   */
  matchAll(decomposition) {
    var result = [];
    for (var i = 0; i < decomposition.tasks.length; i++) {
      var task = decomposition.tasks[i];
      if (task.assignedAgent) continue; // Preserve gating assignments
      var match = this.matchOne(task);
      task.assignedAgent = match.name;
      result.push({
        taskId: task.id,
        agentName: match.name,
        score: match.score,
        reason: match.reason,
      });
    }
    return result;
  }

  matchOne(task) {
    var allAgents = this.registry.getAllAgents();
    var bestAgent = null;
    var bestScore = -1;
    var bestReason = '';

    for (var i = 0; i < allAgents.length; i++) {
      var agent = allAgents[i];
      var score = 0;
      var reasons = [];

      // 1. Keyword match (40%)
      var keywordScore = this.keywordScore(task.capability, task.description, agent.capabilities);
      score += keywordScore * 0.4;
      if (keywordScore > 0) reasons.push('keyword:' + Math.round(keywordScore * 100) + '%');

      // 2. Past performance (30%)
      var perfScore = this.performanceScore(agent);
      score += perfScore * 0.3;
      if (perfScore > 0) reasons.push('perf:' + Math.round(perfScore * 100) + '%');

      // 3. Category relevance (20%)
      var catScore = this.categoryScore(task.capability, agent.category);
      score += catScore * 0.2;
      if (catScore > 0) reasons.push('cat:' + agent.category);

      // 4. Availability (10%)
      var health = this.registry.getHealth(agent.name);
      var availScore = health.state === 'closed' ? 1.0 : (health.state === 'half-open' ? 0.5 : 0);
      score += availScore * 0.1;

      // 5. Specialist bonus: sub-agents with relevant keyword match get a boost
      if (agent.parentAgent && keywordScore >= 0.6) {
        score += 0.25;
        reasons.push('specialist');
      }

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
        bestReason = reasons.join(', ');
      }
    }

    // Fallback to ORACLE if no good match
    if (!bestAgent || bestScore < 0.1) {
      bestAgent = this.registry.getAgent('oracle');
      bestReason = 'fallback:oracle';
      bestScore = 0.1;
    }

    return { name: bestAgent.name, score: bestScore, reason: bestReason };
  }

  keywordScore(capability, description, agentCapabilities) {
    var score = 0;
    var capLower = capability.toLowerCase();
    var descLower = description.toLowerCase();
    var descWords = descLower.split(/\s+/);

    for (var i = 0; i < agentCapabilities.length; i++) {
      var cap = agentCapabilities[i].toLowerCase();

      // Exact capability match
      if (cap === capLower) {
        score = Math.max(score, 1.0);
      }
      // Partial capability match
      else if (capLower.includes(cap) || cap.includes(capLower)) {
        score = Math.max(score, 0.8);
      }
      // Capability appears in description
      else {
        var capWords = cap.split('-');
        for (var j = 0; j < capWords.length; j++) {
          if (descLower.includes(capWords[j]) && capWords[j].length > 3) {
            score = Math.max(score, 0.5);
          }
        }
      }
    }
    return score;
  }

  performanceScore(agent) {
    if (!agent.tasksCompleted && agent.tasksCompleted !== 0) return 0.5; // No data
    if (agent.tasksCompleted === 0) return 0.5; // New agent, neutral
    var sr = agent.successRate != null ? agent.successRate : 0.5;
    var aq = agent.avgQuality != null ? agent.avgQuality : 0.5;
    return sr * aq;
  }

  categoryScore(capability, category) {
    var mapping = {
      'security': ['security-audit', 'code-review', 'owasp', 'pentest', 'penetration-testing', 'offensive-security', 'red-team', 'exploit', 'attack-simulation', 'vulnerability', 'threat', 'cve', 'secret-detection', 'ssl', 'encryption', 'authentication', 'authorization', 'xss', 'sqli', 'injection', 'ssrf', 'idor', 'csrf', 'api-security'],
      'content': ['blog', 'documentation', 'writing', 'seo', 'copy', 'editing', 'storytelling', 'narrative', 'article', 'whitepaper', 'image', 'photo', 'visual', 'readme', 'changelog', 'man-page', 'wiki'],
      'analytics': ['data-analysis', 'trend', 'anomaly', 'forecasting', 'pattern', 'statistics', 'visualization', 'dashboard', 'kpi', 'reporting', 'weather', 'forecast', 'climate', 'stock', 'financial', 'market', 'price', 'ticker'],
      'integration': ['api', 'webhook', 'protocol', 'schema-mapping', 'middleware', 'message-broker', 'event-routing'],
      'automation': ['workflow', 'ci-cd', 'batch', 'pipeline', 'scheduling', 'cron', 'automation', 'script'],
      'social': ['networking', 'collaboration', 'community', 'reputation', 'engagement', 'social'],
      'devops': ['docker', 'kubernetes', 'terraform', 'deployment', 'infrastructure', 'monitoring', 'scaling', 'containerization', 'helm'],
      'commands': ['cli', 'script', 'alias', 'command', 'shell', 'bash', 'arg-parsing'],
      'monitoring': ['uptime', 'log-analysis', 'alerting', 'performance', 'sla', 'health-check', 'metrics', 'trace', 'root-cause'],
      'data': ['etl', 'data-cleaning', 'format-conversion', 'transform', 'migration', 'validation', 'pipeline', 'stream', 'geocoding', 'location', 'coordinates', 'geographic', 'map'],
      'communication': ['summarization', 'translation', 'translate', 'digest', 'notification', 'briefing', 'message', 'report-formatting', 'news', 'headline', 'current-events', 'language', 'localization'],
      'utility': ['text-processing', 'file-ops', 'encoding', 'calculation', 'regex', 'json', 'csv', 'general-purpose', 'recipe', 'food', 'cooking', 'meal', 'ingredient', 'nutrition'],
    };

    var capLower = capability.toLowerCase();
    var catKeywords = mapping[category] || [];
    for (var i = 0; i < catKeywords.length; i++) {
      if (capLower.includes(catKeywords[i]) || catKeywords[i].includes(capLower)) {
        return 1.0;
      }
    }
    return 0;
  }

  /**
   * Axon Reflex: O(1) direct routing for exact capability matches.
   * Bypasses scoring entirely when a single specialist sub-agent owns the capability.
   * Returns { agentName, reason } or null to fall through to full scoring.
   */
  axonReflex(task) {
    var cap = (task.capability || '').toLowerCase();
    if (!cap || cap === 'general-purpose' || cap === 'general') return null;

    var agents = this.registry.findByCapability(cap);
    if (agents.length === 0) return null;

    // Case 1: unique agent owns this capability → direct routing
    if (agents.length === 1) {
      var health = this.registry.getHealth(agents[0]);
      if (health.state === 'open') return null; // circuit breaker open, fall through
      return { agentName: agents[0], reason: 'axon-reflex:exact-match' };
    }

    // Case 2: multiple agents share capability → prefer sub-agent specialist
    var subAgents = [];
    var primaryAgents = [];
    for (var i = 0; i < agents.length; i++) {
      var a = this.registry.getAgent(agents[i]);
      if (!a) continue;
      if (this.registry.getHealth(a.name).state === 'open') continue;
      if (a.parentAgent) {
        subAgents.push(a);
      } else {
        primaryAgents.push(a);
      }
    }

    // Single sub-agent specialist → direct routing
    if (subAgents.length === 1) {
      return { agentName: subAgents[0].name, reason: 'axon-reflex:specialist' };
    }

    // Multiple sub-agents or no clear winner → fall through to full scoring
    return null;
  }
}

// ============================================================================
// Section 5.5: SharedWorkspace — Inter-Agent Communication (Fix 1)
// ============================================================================

/**
 * SharedWorkspace — Blackboard-style shared state for a single orchestration run.
 *
 * Agents can post observations, warnings, partial results, and data points.
 * Subsequent agents see a snapshot of the workspace in their context, enabling
 * true inter-agent communication without direct coupling.
 *
 * Agents emit [WORKSPACE:type:tag]...[/WORKSPACE] tags in their output.
 * The engine extracts these and adds them to the workspace.
 */
class SharedWorkspace {
  constructor() {
    this.entries = [];
  }

  /**
   * Add an entry to the workspace.
   */
  add(agentName, type, tag, content) {
    this.entries.push({
      agent: agentName,
      type: type,
      tag: tag,
      content: content,
      timestamp: Date.now(),
    });
  }

  /**
   * Extract workspace entries from an agent's output.
   * Pattern: [WORKSPACE:type:tag]content[/WORKSPACE]
   */
  extractFromOutput(agentName, output) {
    var pattern = /\[WORKSPACE:(\w+):(\w[\w-]*)\]([\s\S]*?)\[\/WORKSPACE\]/g;
    var match;
    var extracted = 0;
    while ((match = pattern.exec(output)) !== null) {
      this.add(agentName, match[1], match[2], match[3].trim());
      extracted++;
    }
    return extracted;
  }

  /**
   * Strip workspace tags from output (clean version for user).
   */
  static stripTags(output) {
    return output.replace(/\[WORKSPACE:\w+:\w[\w-]*\][\s\S]*?\[\/WORKSPACE\]/g, '').trim();
  }

  /**
   * Build context snapshot for injection into agent prompts.
   */
  getSnapshot() {
    if (this.entries.length === 0) return '';
    var snapshot = '\n\n--- SHARED WORKSPACE (from prior agents) ---\n';
    for (var i = 0; i < this.entries.length; i++) {
      var e = this.entries[i];
      snapshot += '[' + e.agent.toUpperCase() + ':' + e.type + ':' + e.tag + '] ' + e.content + '\n';
    }
    snapshot += '--- END WORKSPACE ---\n';
    snapshot += 'You may contribute to the workspace using [WORKSPACE:type:tag]...[/WORKSPACE] tags.\n';
    snapshot += 'Types: observation, warning, data, partial-result\n';
    return snapshot;
  }

  get size() {
    return this.entries.length;
  }
}

// ============================================================================
// Section 5.5b: Structured Output Parsing (v10.0 Neural Controller)
// ============================================================================

/**
 * Parse structured agent output. If the agent returns valid JSON with our
 * expected fields (answer, confidence, reasoning_summary, risk_flags),
 * extract them. Otherwise fallback to plain text with default confidence 0.7.
 */
function parseStructuredAgentOutput(raw) {
  if (!raw || typeof raw !== 'string') {
    return { answer: raw || '', confidence: 0.7, reasoningSummary: '', riskFlags: [] };
  }

  // Try extracting JSON from markdown code block
  var jsonBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  var jsonCandidate = jsonBlockMatch ? jsonBlockMatch[1].trim() : raw.trim();

  try {
    var parsed = JSON.parse(jsonCandidate);
    if (parsed && typeof parsed === 'object' && typeof parsed.answer === 'string') {
      return {
        answer: parsed.answer,
        confidence: typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
        reasoningSummary: typeof parsed.reasoning_summary === 'string'
          ? parsed.reasoning_summary : '',
        riskFlags: Array.isArray(parsed.risk_flags)
          ? parsed.risk_flags.filter(function(f) { return typeof f === 'string'; }).slice(0, 10) : [],
      };
    }
  } catch (e) { /* not valid JSON */ }

  // Try extracting JSON object from raw text
  var jsonObjMatch = raw.match(/\{[\s\S]*"answer"\s*:[\s\S]*\}/);
  if (jsonObjMatch) {
    try {
      var parsed2 = JSON.parse(jsonObjMatch[0]);
      if (typeof parsed2.answer === 'string') {
        return {
          answer: parsed2.answer,
          confidence: typeof parsed2.confidence === 'number'
            ? Math.max(0, Math.min(1, parsed2.confidence)) : 0.7,
          reasoningSummary: typeof parsed2.reasoning_summary === 'string'
            ? parsed2.reasoning_summary : '',
          riskFlags: Array.isArray(parsed2.risk_flags)
            ? parsed2.risk_flags.filter(function(f) { return typeof f === 'string'; }).slice(0, 10) : [],
        };
      }
    } catch (e) { /* fall through */ }
  }

  return { answer: raw, confidence: 0.7, reasoningSummary: '', riskFlags: [] };
}

// ============================================================================
// Section 5.6: CommunicationStream — Continuous agent thought sharing (v5.0.0)
// ============================================================================

/**
 * CommunicationStream — Real-time thought sharing between agents.
 *
 * Agents emit [STREAM:type:confidence]...[/STREAM] tags during output.
 * Types: thought, uncertainty, discovery, warning, assist, contradiction
 * Subsequent agents see a narrative of the collective thought process,
 * enabling cross-pollination and real-time mutual influence.
 */
class CommunicationStream {
  constructor() {
    this.thoughts = [];
    this.currentWave = 0;
    // v6.0.0: Proposal tracking — stores actual agent outputs per wave for cross-reading
    this.proposals = []; // { agent, wave, content, subTaskId }
  }

  emitThought(agentName, type, content, confidence) {
    this.thoughts.push({
      agent: agentName,
      type: type,
      content: content,
      confidence: confidence || null,
      wave: this.currentWave,
      timestamp: Date.now(),
    });
  }

  /**
   * v6.0.0: Record an agent's full proposal (output) for cross-reading by other agents.
   * Proposals are the actual outputs agents produce, not just [STREAM] tags.
   */
  recordProposal(agentName, content, subTaskId, round, confidence, riskFlags) {
    this.proposals.push({
      agent: agentName,
      wave: this.currentWave,
      content: content,
      subTaskId: subTaskId,
      round: round || 1,
      confidence: typeof confidence === 'number' ? confidence : 0.7,
      riskFlags: Array.isArray(riskFlags) ? riskFlags : [],
      timestamp: Date.now(),
    });
  }

  /**
   * v6.0.0: Get proposals from other agents for cross-reading.
   * Returns proposals from previous waves (agents that already finished),
   * excluding the requesting agent's own proposals.
   *
   * @param {string} excludeAgent - Agent to exclude (self)
   * @param {number} maxPerAgent - Max chars per agent's proposal (default 3000)
   * @returns {string} Formatted cross-reading context
   */
  getProposalContext(excludeAgent, maxPerAgent) {
    maxPerAgent = maxPerAgent || 16000;
    var otherProposals = this.proposals.filter(function(p) {
      return p.agent !== excludeAgent;
    });
    if (otherProposals.length === 0) return '';

    var context = '\n--- OTHER AGENTS\' PROPOSALS (cross-reading) ---\n';
    context += 'These agents have already analyzed parts of this problem. Review their work.\n';
    context += 'Where you AGREE, build upon their findings. Where you DISAGREE, explain why.\n';
    context += 'Use [STREAM:contradiction:confidence] to flag disagreements.\n';
    context += 'Use [STREAM:assist:confidence] to reinforce or extend their insights.\n\n';

    for (var i = 0; i < otherProposals.length; i++) {
      var p = otherProposals[i];
      context += '=== ' + p.agent.toUpperCase() + ' (task: ' + p.subTaskId + ', wave: ' + p.wave + ') ===\n';
      context += p.content + '\n\n';
    }
    context += '--- END PROPOSALS ---\n';
    return context;
  }

  /**
   * v6.0.0→v7.0.0: Measure semantic convergence between proposals.
   * v7.0.0: Uses cosine similarity on 384-dim MiniLM embeddings via getBatchEmbeddings.
   * Falls back to Jaccard similarity when embeddings API is unavailable.
   *
   * @param {Object} [client] - LegionClient instance for embedding API access
   * @returns {Promise<{ convergence: number, divergentPairs: Array, pairScores: Array, method: string }>}
   */
  async measureConvergence(client) {
    if (this.proposals.length < 2) return { convergence: 1.0, divergentPairs: [], pairScores: [], method: 'trivial' };

    // Collect texts per agent: first 10 sentences joined
    var agentTexts = {};
    for (var i = 0; i < this.proposals.length; i++) {
      var p = this.proposals[i];
      if (!agentTexts[p.agent]) agentTexts[p.agent] = '';
      agentTexts[p.agent] += ' ' + p.content;
    }

    var agents = Object.keys(agentTexts);
    if (agents.length < 2) return { convergence: 1.0, divergentPairs: [], pairScores: [], method: 'trivial' };

    // Prepare per-agent texts: split into sentences, take first 10, join
    var agentSummaries = [];
    for (var ai = 0; ai < agents.length; ai++) {
      var raw = agentTexts[agents[ai]].trim();
      var sentences = raw.split(/(?:\.\s|\n)+/).filter(function(s) { return s.trim().length > 5; });
      agentSummaries.push(sentences.slice(0, 10).join('. '));
    }

    // v7.0.0: Try semantic convergence via embeddings
    var divergenceThreshold = (typeof this._divergenceThreshold === 'number') ? this._divergenceThreshold : 0.72; // cosine similarity below this = divergent
    if (client) {
      try {
        var embResp = await client.getBatchEmbeddings(agentSummaries);
        if (embResp && embResp.embeddings && embResp.embeddings.length === agents.length) {
          var embeddings = embResp.embeddings;
          var pairScores = [];
          var totalSim = 0;
          var pairCount = 0;
          var divergentPairs = [];

          for (var a = 0; a < agents.length; a++) {
            for (var b = a + 1; b < agents.length; b++) {
              var sim = this._cosineSimilarity(embeddings[a], embeddings[b]);
              pairScores.push({ agents: [agents[a], agents[b]], similarity: sim });
              totalSim += sim;
              pairCount++;
              if (sim < divergenceThreshold) {
                divergentPairs.push({ agents: [agents[a], agents[b]], similarity: sim });
              }
            }
          }

          return {
            convergence: pairCount > 0 ? totalSim / pairCount : 1.0,
            divergentPairs: divergentPairs.sort(function(a, b) { return a.similarity - b.similarity; }),
            pairScores: pairScores,
            method: 'semantic-embeddings',
          };
        }
      } catch (_) {
        // Fallback to Jaccard below
      }
    }

    // Fallback: Jaccard similarity on key terms (4+ char words)
    var agentTerms = {};
    for (var ji = 0; ji < this.proposals.length; ji++) {
      var jp = this.proposals[ji];
      if (!agentTerms[jp.agent]) agentTerms[jp.agent] = new Set();
      var words = jp.content.toLowerCase().split(/\s+/);
      for (var w = 0; w < words.length; w++) {
        var cleaned = words[w].replace(/[^a-z0-9-]/g, '');
        if (cleaned.length >= 4) agentTerms[jp.agent].add(cleaned);
      }
    }

    var jAgents = Object.keys(agentTerms);
    var jPairScores = [];
    var jTotalSim = 0;
    var jPairCount = 0;
    var jDivergentPairs = [];

    for (var ja = 0; ja < jAgents.length; ja++) {
      for (var jb = ja + 1; jb < jAgents.length; jb++) {
        var setA = agentTerms[jAgents[ja]];
        var setB = agentTerms[jAgents[jb]];
        var intersection = 0;
        setA.forEach(function(t) { if (setB.has(t)) intersection++; });
        var union = setA.size + setB.size - intersection;
        var jaccard = union > 0 ? intersection / union : 0;
        jPairScores.push({ agents: [jAgents[ja], jAgents[jb]], similarity: jaccard });
        jTotalSim += jaccard;
        jPairCount++;
        if (jaccard < 0.25) {
          jDivergentPairs.push({ agents: [jAgents[ja], jAgents[jb]], similarity: jaccard });
        }
      }
    }

    return {
      convergence: jPairCount > 0 ? jTotalSim / jPairCount : 1.0,
      divergentPairs: jDivergentPairs.sort(function(a, b) { return a.similarity - b.similarity; }),
      pairScores: jPairScores,
      method: 'jaccard-fallback',
    };
  }

  /**
   * v7.0.0: Cosine similarity between two embedding vectors.
   */
  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    var dotProduct = 0;
    var normA = 0;
    var normB = 0;
    for (var i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    var denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dotProduct / denom : 0;
  }

  extractFromOutput(agentName, output) {
    var regex = /\[STREAM:(\w+)(?::(\d+(?:\.\d+)?))?\]([\s\S]*?)\[\/STREAM\]/g;
    var match;
    var count = 0;
    while ((match = regex.exec(output)) !== null) {
      this.emitThought(agentName, match[1], match[3].trim(), match[2] ? parseFloat(match[2]) : null);
      count++;
    }
    return count;
  }

  static stripTags(output) {
    return output.replace(/\[STREAM:\w+(?::\d+(?:\.\d+)?)?\][\s\S]*?\[\/STREAM\]/g, '').trim();
  }

  getStreamSnapshot(excludeAgent) {
    var relevant = this.thoughts.filter(function(t) { return t.agent !== excludeAgent; });
    if (relevant.length === 0) return '';

    var snapshot = '\n--- COLLECTIVE THOUGHT STREAM ---\n';
    snapshot += 'Other agents are sharing their reasoning process. Use this to align, challenge, or build upon:\n\n';

    for (var i = 0; i < relevant.length; i++) {
      var t = relevant[i];
      var confStr = t.confidence ? ' (confidence: ' + (t.confidence * 100).toFixed(0) + '%)' : '';
      snapshot += '  [' + t.agent.toUpperCase() + ':' + t.type + confStr + '] ' + t.content + '\n';
    }

    snapshot += '\n--- END STREAM ---\n';
    snapshot += 'You MUST emit your own thoughts using [STREAM:type:confidence]...[/STREAM] tags.\n';
    snapshot += 'Types: thought, uncertainty, discovery, warning, assist, contradiction\n';
    snapshot += 'PRIORITY: If you see an uncertainty → emit [STREAM:assist]. If you disagree → emit [STREAM:contradiction].\n';
    snapshot += 'Emit 2-4 thoughts minimum.\n';
    return snapshot;
  }

  getCrossPollination() {
    var agents = new Set(this.thoughts.map(function(t) { return t.agent; }));
    var directInteractions = 0;  // assist + contradiction (reactive, agent-to-agent)
    var indirectInteractions = 0;  // thought + discovery + warning + uncertainty (shared reasoning)
    for (var i = 0; i < this.thoughts.length; i++) {
      var type = this.thoughts[i].type;
      if (type === 'assist' || type === 'contradiction') {
        directInteractions++;
      } else {
        indirectInteractions++;
      }
    }
    // Weight direct interactions 2x — they represent genuine cross-pollination
    var weighted = directInteractions * 2 + indirectInteractions;
    return {
      interactions: directInteractions,
      totalThoughts: this.thoughts.length,
      agentCount: agents.size,
      density: agents.size > 1 ? weighted / (agents.size * (agents.size - 1) * 2) : 0,
    };
  }

  nextWave() { this.currentWave++; }

  getBootstrapInstruction(agentName) {
    return '\n--- COMMUNICATION STREAM ---\n' +
      'You are part of a multi-agent collective. Share your reasoning process using tags:\n' +
      '[STREAM:thought:0.8]Your key insight here[/STREAM]\n' +
      '[STREAM:uncertainty:0.5]Something you are unsure about[/STREAM]\n' +
      '[STREAM:discovery:0.9]A critical finding[/STREAM]\n' +
      '[STREAM:warning:0.7]A risk or concern[/STREAM]\n' +
      '[STREAM:assist:0.8]Helping resolve another agent uncertainty[/STREAM]\n' +
      '[STREAM:contradiction:0.6]Disagreeing with another agent reasoning[/STREAM]\n' +
      'Types: thought, uncertainty, discovery, warning, assist, contradiction\n' +
      'Confidence: 0.0 to 1.0 (how sure you are)\n' +
      'Emit 2-4 thoughts. PRIORITIZE assist and contradiction when you see other agent thoughts.\n' +
      '--- END STREAM ---\n';
  }
}

// ============================================================================
// Section 5.7: PromptEvolver — Self-modification via learned patterns (v5.0.0)
// ============================================================================

/**
 * PromptEvolver — Agents evolve their own system prompts based on experience.
 *
 * v7.0.0: Score-based pattern management replaces FIFO eviction.
 * Each pattern tracks: score (Laplace-smoothed effectiveness), applications count,
 * successes/failures. Patterns proven harmful (score < 0.30 after 5+ apps) are removed.
 * Patterns proven effective (score > 0.80 after 5+ apps) are immune to eviction.
 * Mid-range learning (0.50-0.80) extracts insight patterns at lower confidence.
 * Semantic dedup via embeddings prevents near-duplicate patterns.
 *
 * Storage: ~/.legion/prompt-evolution/<agent>.json
 * Max: 12 strengths + 8 weaknesses per agent (score-based eviction)
 */
class PromptEvolver {
  constructor(configDir) {
    this.patchDir = path.join(configDir, 'prompt-evolution');
    this.activePatches = {};
    this.maxStrengths = 12;
    this.maxWeaknesses = 8;
    this.evictionThreshold = 0.30;
    this.provenThreshold = 0.80;
  }

  async load() {
    try {
      if (!fs.existsSync(this.patchDir)) {
        fs.mkdirSync(this.patchDir, { recursive: true, mode: 0o700 });
      }
      var files = fs.readdirSync(this.patchDir).filter(function(f) { return f.endsWith('.json'); });
      for (var i = 0; i < files.length; i++) {
        var agentName = files[i].replace('.json', '');
        try {
          var data = JSON.parse(fs.readFileSync(path.join(this.patchDir, files[i]), 'utf-8'));
          // v7.0.0: Migrate old patterns without score fields
          this._migratePatterns(data);
          this.activePatches[agentName] = data;
        } catch (_) {}
      }
    } catch (_) {}
  }

  /**
   * v7.0.0: Migrate old FIFO patterns to scored format.
   */
  _migratePatterns(data) {
    var types = ['strengths', 'weaknesses'];
    for (var ti = 0; ti < types.length; ti++) {
      var list = data[types[ti]] || [];
      for (var pi = 0; pi < list.length; pi++) {
        var p = list[pi];
        if (typeof p.score === 'undefined') p.score = 0.6;
        if (typeof p.applications === 'undefined') p.applications = 0;
        if (typeof p.successesWithPattern === 'undefined') p.successesWithPattern = 0;
        if (typeof p.failuresWithPattern === 'undefined') p.failuresWithPattern = 0;
      }
    }
  }

  save(agentName) {
    try {
      if (!fs.existsSync(this.patchDir)) {
        fs.mkdirSync(this.patchDir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(
        path.join(this.patchDir, agentName + '.json'),
        JSON.stringify(this.activePatches[agentName], null, 2),
        { mode: 0o600 }
      );
    } catch (_) {}
  }

  /**
   * v7.0.0: Propose evolution with mid-range learning support.
   * Quality >= 0.80: Extract strength pattern (high confidence)
   * Quality 0.50-0.80: Extract insight pattern (lower confidence)
   * Quality < 0.50: Extract weakness/anti-pattern
   */
  async proposeEvolution(agentName, taskFeedback, quality, llm) {
    if (quality >= 0.80) {
      var analysis = await llm.chat(
        'You analyze successful agent executions to extract reusable patterns.',
        'Agent: ' + agentName + '\nQuality: ' + (quality * 100).toFixed(0) + '%\n' +
        'Task feedback: ' + taskFeedback + '\n\n' +
        'Extract ONE specific, actionable pattern that made this successful. ' +
        'Output format: "When [situation], always [action] because [reason]"\n' +
        'Max 1 sentence. Output ONLY the pattern.',
        { maxTokens: 64, agentTag: 'prompt-evolution' }
      );
      if (analysis && analysis.trim().length > 10) {
        this.addPattern(agentName, 'strengths', analysis.trim(), quality, 1.0);
      }
    } else if (quality >= 0.50) {
      // v7.0.0: Mid-range learning — extract insights at lower confidence
      var insight = await llm.chat(
        'You analyze agent executions to extract learning insights.',
        'Agent: ' + agentName + '\nQuality: ' + (quality * 100).toFixed(0) + '% (moderate)\n' +
        'Task feedback: ' + taskFeedback + '\n\n' +
        'Extract ONE specific insight about what could be improved or preserved. ' +
        'Output format: "When [situation], consider [approach] which produced ' + (quality * 100).toFixed(0) + '% quality"\n' +
        'Max 1 sentence. Output ONLY the insight.',
        { maxTokens: 64, agentTag: 'prompt-evolution' }
      );
      if (insight && insight.trim().length > 10) {
        this.addPattern(agentName, 'strengths', insight.trim(), quality, 0.5);
      }
    } else {
      var avoidance = await llm.chat(
        'You analyze failed agent executions to extract anti-patterns.',
        'Agent: ' + agentName + '\nQuality: ' + (quality * 100).toFixed(0) + '%\n' +
        'Task feedback: ' + taskFeedback + '\n\n' +
        'Extract ONE specific mistake to avoid in future. ' +
        'Output format: "Never [action] when [situation] because [consequence]"\n' +
        'Max 1 sentence. Output ONLY the anti-pattern.',
        { maxTokens: 64, agentTag: 'prompt-evolution' }
      );
      if (avoidance && avoidance.trim().length > 10) {
        this.addPattern(agentName, 'weaknesses', avoidance.trim(), quality, 1.0);
      }
    }
  }

  /**
   * v7.0.0: Add a scored pattern with eviction policy.
   * @param {string} agentName
   * @param {string} type - 'strengths' or 'weaknesses'
   * @param {string} pattern - The pattern text
   * @param {number} quality - Quality of the task that generated this
   * @param {number} initialScore - Starting score (1.0 for high/low quality, 0.5 for mid-range)
   */
  addPattern(agentName, type, pattern, quality, initialScore) {
    if (!this.activePatches[agentName]) this.activePatches[agentName] = { strengths: [], weaknesses: [] };
    var list = this.activePatches[agentName][type];
    var maxItems = type === 'strengths' ? this.maxStrengths : this.maxWeaknesses;

    // Add new pattern
    list.push({
      pattern: pattern,
      quality: quality,
      timestamp: Date.now(),
      score: initialScore,
      applications: 0,
      successesWithPattern: 0,
      failuresWithPattern: 0,
    });

    // Evict if over limit (score-based, not FIFO)
    while (list.length > maxItems) {
      this._evictLowest(list);
    }
    this.save(agentName);
  }

  /**
   * v7.0.0: Evict the lowest-scoring non-proven pattern.
   */
  _evictLowest(list) {
    var worstIdx = -1;
    var worstScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      // Never evict proven patterns
      if (p.score >= this.provenThreshold && p.applications >= 5) continue;
      if (p.score < worstScore) {
        worstScore = p.score;
        worstIdx = i;
      }
    }
    // If all are proven, evict oldest non-proven
    if (worstIdx === -1) {
      var oldestIdx = 0;
      for (var j = 1; j < list.length; j++) {
        if (list[j].timestamp < list[oldestIdx].timestamp) oldestIdx = j;
      }
      worstIdx = oldestIdx;
    }
    list.splice(worstIdx, 1);
  }

  /**
   * v7.0.0: Update pattern scores after task completion.
   * Called for each agent that had active patterns during a task.
   *
   * @param {string} agentName
   * @param {number} taskQuality - Quality score of the completed task
   * @returns {{ updated: number, removed: number }} counts
   */
  updatePatternScores(agentName, taskQuality) {
    var patches = this.activePatches[agentName];
    if (!patches) return { updated: 0, removed: 0 };

    var updated = 0;
    var removed = 0;
    var types = ['strengths', 'weaknesses'];
    var self = this;

    for (var ti = 0; ti < types.length; ti++) {
      var list = patches[types[ti]] || [];
      var toRemove = [];

      for (var pi = 0; pi < list.length; pi++) {
        var p = list[pi];
        p.applications += 1;

        if (taskQuality >= 0.75) {
          p.successesWithPattern += 1;
        } else if (taskQuality < 0.55) {
          p.failuresWithPattern += 1;
        }

        // Laplace-smoothed score
        p.score = (p.successesWithPattern + 1) / (p.applications + 2);
        updated++;

        // Remove proven harmful patterns
        if (p.score < self.evictionThreshold && p.applications >= 5) {
          toRemove.push(pi);
          removed++;
        }
      }

      // Remove in reverse order to preserve indices
      for (var ri = toRemove.length - 1; ri >= 0; ri--) {
        list.splice(toRemove[ri], 1);
      }
    }

    if (updated > 0 || removed > 0) {
      this.save(agentName);
    }
    return { updated: updated, removed: removed };
  }

  /**
   * v7.0.0: Deduplicate a new pattern against existing ones using embeddings.
   * If similar pattern exists (cosine > 0.85), reinforce it instead of adding.
   *
   * @param {string} agentName
   * @param {string} type - 'strengths' or 'weaknesses'
   * @param {string} newPattern
   * @param {Object} client - LegionClient for embedding API
   * @returns {Promise<boolean>} true if duplicate found and reinforced
   */
  async deduplicatePattern(agentName, type, newPattern, client) {
    if (!client) return false;
    var patches = this.activePatches[agentName];
    if (!patches) return false;
    var list = patches[type] || [];
    if (list.length === 0) return false;

    try {
      var texts = [newPattern];
      for (var i = 0; i < list.length; i++) {
        texts.push(list[i].pattern);
      }
      var embResp = await client.getBatchEmbeddings(texts);
      if (!embResp || !embResp.embeddings || embResp.embeddings.length !== texts.length) return false;

      var newEmb = embResp.embeddings[0];
      for (var j = 0; j < list.length; j++) {
        var existEmb = embResp.embeddings[j + 1];
        var sim = this._cosineSimilarity(newEmb, existEmb);
        if (sim > 0.85) {
          // Reinforce existing pattern
          list[j].score = Math.min(1.0, list[j].score + 0.1);
          this.save(agentName);
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  /**
   * v7.0.0: Cosine similarity between two vectors.
   */
  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    var dot = 0, normA = 0, normB = 0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    var denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  getPromptEvolution(agentName) {
    var patches = this.activePatches[agentName];
    if (!patches) return '';
    var strengths = (patches.strengths || []).slice().sort(function(a, b) { return b.score - a.score; });
    var weaknesses = (patches.weaknesses || []).slice().sort(function(a, b) { return b.score - a.score; });
    if (strengths.length === 0 && weaknesses.length === 0) return '';

    var suffix = '\n\n--- LEARNED FROM EXPERIENCE (auto-evolved, scored) ---\n';
    if (strengths.length > 0) {
      suffix += 'Patterns that WORK (apply when relevant, sorted by effectiveness):\n';
      for (var i = 0; i < strengths.length; i++) {
        var s = strengths[i];
        var proven = (s.score >= 0.80 && s.applications >= 5) ? ' [PROVEN]' : '';
        suffix += '  + [score:' + s.score.toFixed(2) + ', apps:' + s.applications + proven + '] ' + s.pattern + '\n';
      }
    }
    if (weaknesses.length > 0) {
      suffix += 'Anti-patterns to AVOID (sorted by severity):\n';
      for (var i = 0; i < weaknesses.length; i++) {
        var w = weaknesses[i];
        suffix += '  - [score:' + w.score.toFixed(2) + ', apps:' + w.applications + '] ' + w.pattern + '\n';
      }
    }
    suffix += '--- END EVOLUTION ---';
    return suffix;
  }

  getModificationRate(agentName) {
    var patches = this.activePatches[agentName];
    if (!patches) return 0;
    return (patches.strengths || []).length + (patches.weaknesses || []).length;
  }

  getEvolutionStats() {
    var stats = {};
    var totalPatches = 0;
    var agentCount = 0;
    for (var agent in this.activePatches) {
      var p = this.activePatches[agent];
      var s = (p.strengths || []).length;
      var w = (p.weaknesses || []).length;
      var provenCount = 0;
      var allPatterns = (p.strengths || []).concat(p.weaknesses || []);
      for (var pi = 0; pi < allPatterns.length; pi++) {
        if (allPatterns[pi].score >= 0.80 && allPatterns[pi].applications >= 5) provenCount++;
      }
      stats[agent] = { strengths: s, weaknesses: w, total: s + w, proven: provenCount };
      totalPatches += s + w;
      agentCount++;
    }
    return { perAgent: stats, totalPatches: totalPatches, agentCount: agentCount };
  }
}

// ============================================================================
// Section 5.8: MetaIntelligence — System self-awareness (v5.0.0)
// ============================================================================

/**
 * MetaIntelligence — The system reasons about itself.
 *
 * Records run history, detects quality trends, measures debate effectiveness,
 * identifies strong agent pairs, tracks novelty scores, and proposes
 * configuration changes. Pure deterministic analysis — zero LLM cost.
 *
 * Storage: ~/.legion/meta-intelligence.json
 */
class MetaIntelligence {
  constructor(configDir) {
    this.dataFile = path.join(configDir, 'meta-intelligence.json');
    this.runHistory = [];
    this.observations = [];
    this.proposedChanges = [];
  }

  async load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        var data = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
        this.runHistory = data.runHistory || [];
        this.observations = data.observations || [];
        this.proposedChanges = data.proposedChanges || [];
      }
    } catch (_) {}
  }

  save() {
    try {
      var dir = path.dirname(this.dataFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(this.dataFile, JSON.stringify({
        runHistory: this.runHistory,
        observations: this.observations,
        proposedChanges: this.proposedChanges,
      }, null, 2), { mode: 0o600 });
    } catch (_) {}
  }

  recordRun(runResult) {
    this.runHistory.push(runResult);
    if (this.runHistory.length > 200) this.runHistory.shift();
    this.analyze();
    this.save();
  }

  analyze() {
    if (this.runHistory.length < 5) return;
    var recent = this.runHistory.slice(-20);

    // 1. Quality trend
    var recent5 = recent.slice(-5);
    var older5 = recent.slice(-10, -5);
    if (older5.length >= 3) {
      var avgRecent = recent5.reduce(function(s, r) { return s + r.quality; }, 0) / recent5.length;
      var avgOlder = older5.reduce(function(s, r) { return s + r.quality; }, 0) / older5.length;
      if (avgRecent > avgOlder + 0.05) {
        this.observe('quality_trend', 'Quality improving: ' + avgOlder.toFixed(3) + ' → ' + avgRecent.toFixed(3), 0.8);
      } else if (avgRecent < avgOlder - 0.05) {
        this.observe('quality_trend', 'Quality declining: ' + avgOlder.toFixed(3) + ' → ' + avgRecent.toFixed(3), 0.8);
      }
    }

    // 2. Debate effectiveness
    var debated = recent.filter(function(r) { return r.debated; });
    var notDebated = recent.filter(function(r) { return !r.debated; });
    if (debated.length >= 3 && notDebated.length >= 3) {
      var avgDebate = debated.reduce(function(s, r) { return s + r.quality; }, 0) / debated.length;
      var avgNoDebate = notDebated.reduce(function(s, r) { return s + r.quality; }, 0) / notDebated.length;
      if (avgNoDebate > avgDebate + 0.03) {
        this.observe('debate_harmful', 'Debate consistently reduces quality (' +
          avgDebate.toFixed(3) + ' vs ' + avgNoDebate.toFixed(3) + '). Consider --no-debate.', 0.75);
        this.proposeChange('debateEnabled', false, 'Debate reduces quality by ' +
          ((avgNoDebate - avgDebate) * 100).toFixed(1) + '%');
      }
    }

    // 3. Agent pair affinity
    var pairQuality = {};
    for (var i = 0; i < recent.length; i++) {
      var agents = recent[i].agents || [];
      for (var a = 0; a < agents.length; a++) {
        for (var b = a + 1; b < agents.length; b++) {
          var pair = [agents[a], agents[b]].sort().join('+');
          if (!pairQuality[pair]) pairQuality[pair] = [];
          pairQuality[pair].push(recent[i].quality);
        }
      }
    }
    for (var pair in pairQuality) {
      var samples = pairQuality[pair];
      if (samples.length >= 3) {
        var avg = samples.reduce(function(s, v) { return s + v; }, 0) / samples.length;
        if (avg > 0.85) {
          this.observe('strong_pair', pair + ' consistently produces high quality (' +
            avg.toFixed(3) + ' avg over ' + samples.length + ' runs)', 0.9);
        }
      }
    }

    // 4. Novelty trend
    var noveltyRuns = recent.filter(function(r) { return typeof r.novelty === 'number'; });
    if (noveltyRuns.length >= 3) {
      var avgNovelty = noveltyRuns.reduce(function(s, r) { return s + r.novelty; }, 0) / noveltyRuns.length;
      if (avgNovelty > 0.5) {
        this.observe('high_emergence', 'System consistently producing emergent solutions ' +
          '(novelty: ' + avgNovelty.toFixed(3) + '). True collective intelligence detected.', 0.95);
      }
    }

    // 5. Cross-pollination trend
    var pollRuns = recent.filter(function(r) { return typeof r.crossPollinationDensity === 'number'; });
    if (pollRuns.length >= 3) {
      var avgPoll = pollRuns.reduce(function(s, r) { return s + r.crossPollinationDensity; }, 0) / pollRuns.length;
      if (avgPoll > 0.3) {
        this.observe('active_communication', 'Agents actively communicating via stream ' +
          '(density: ' + avgPoll.toFixed(3) + '). Cross-pollination is working.', 0.85);
      }
    }
  }

  observe(type, content, confidence) {
    var isDupe = this.observations.slice(-10).some(function(o) { return o.type === type && o.content === content; });
    if (!isDupe) {
      this.observations.push({ type: type, content: content, confidence: confidence, timestamp: Date.now() });
      if (this.observations.length > 100) this.observations.shift();
    }
  }

  proposeChange(key, value, reason) {
    this.proposedChanges.push({ key: key, value: value, reason: reason, timestamp: Date.now() });
    if (this.proposedChanges.length > 20) this.proposedChanges.shift();
  }

  getInsights() {
    return this.observations.slice(-10);
  }

  getProposedChanges() {
    return this.proposedChanges.slice(-5);
  }
}

// ============================================================================
// Section 5.9: Emergence Metrics — Novelty scoring (v5.0.0)
// ============================================================================

/**
 * Client-side cosine similarity for embedding vectors.
 * Used by novelty scoring to avoid extra server round-trips.
 */
function cosineSimilarityLocal(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  var dotProduct = 0, normA = 0, normB = 0;
  for (var i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  var denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dotProduct / denom : 0;
}

/**
 * Measure how much the synthesized output DIVERGES from individual contributions.
 *
 * Novelty = 1 - max(cosineSim(synthesis_embedding, each_contribution_embedding))
 *
 * > 0.5 = EMERGENT (collective produced something no individual had)
 * > 0.3 = moderate emergence
 * < 0.3 = aggregation (no true emergence)
 */
async function measureNoveltyScore(client, synthesizedResult, contributions, verbose) {
  try {
    var texts = [synthesizedResult];
    for (var i = 0; i < contributions.length; i++) {
      if (contributions[i].result && contributions[i].status === 'completed') {
        texts.push(contributions[i].result);
      }
    }
    if (texts.length < 2) {
      if (verbose) console.log(colors.dim + '  [NOVELTY] Skipped: < 2 texts' + colors.reset);
      return null;
    }

    var embResp = await client.getBatchEmbeddings(texts);
    if (!embResp || !embResp.embeddings || embResp.embeddings.length < 2) {
      if (verbose) console.log(colors.yellow + '  [NOVELTY] API returned empty/invalid: ' +
        JSON.stringify(embResp ? { keys: Object.keys(embResp), embLen: embResp.embeddings ? embResp.embeddings.length : 0 } : null) + colors.reset);
      return null;
    }

    var synthEmb = embResp.embeddings[0];
    var maxSim = 0;
    for (var j = 1; j < embResp.embeddings.length; j++) {
      var sim = cosineSimilarityLocal(synthEmb, embResp.embeddings[j]);
      if (sim > maxSim) maxSim = sim;
    }

    return 1 - maxSim;
  } catch (err) {
    if (verbose) console.log(colors.yellow + '  [NOVELTY] Error: ' + (err.message || err) + colors.reset);
    return null;
  }
}

// ============================================================================
// Section 6: ExecutionEngine — Parallel agent execution
// ============================================================================

class ExecutionEngine {
  constructor(registry, llmProvider, config) {
    this.registry = registry;
    this.llm = llmProvider;
    this.config = config;
    this.results = new Map();
    this.agentModules = new Map();
    // v4.0.0 Fix 1: Shared workspace for inter-agent communication
    this.workspace = new SharedWorkspace();
    // v5.0.0: Collective intelligence components (set by runOrchestration)
    this.commStream = null;
    this.promptEvolver = null;
    this.runId = null;
    this.client = null;
    this.latentSpaceEnabled = false;
    this.knowledgeGraphEnabled = false;
  }

  /**
   * Execute all sub-tasks from a decomposition.
   *
   * Strategy:
   * 1. Build dependency graph
   * 2. Identify independent tasks (no unresolved deps)
   * 3. Execute independent tasks in parallel
   * 4. Repeat until all tasks complete
   */
  async executeAll(decomposition, onProgress) {
    var tasks = decomposition.tasks;
    var completed = new Set();
    var failed = new Set();
    var contributions = [];
    var startTime = Date.now();

    while (completed.size + failed.size < tasks.length) {
      // Find tasks that are ready (all deps completed)
      var ready = [];
      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        if (completed.has(t.id) || failed.has(t.id)) continue;

        var depsResolved = true;
        if (t.dependsOn && t.dependsOn.length > 0) {
          for (var j = 0; j < t.dependsOn.length; j++) {
            if (!completed.has(t.dependsOn[j])) {
              // Check if dep failed — if so, skip this task
              if (failed.has(t.dependsOn[j])) {
                failed.add(t.id);
                contributions.push({
                  agentName: t.assignedAgent || 'unknown',
                  subTaskId: t.id,
                  status: 'failed',
                  result: 'Dependency ' + t.dependsOn[j] + ' failed',
                  durationMs: 0,
                  quality: null,
                });
                depsResolved = false;
                break;
              }
              depsResolved = false;
            }
          }
        }

        if (depsResolved && !failed.has(t.id)) {
          ready.push(t);
        }
      }

      if (ready.length === 0 && completed.size + failed.size < tasks.length) {
        // Deadlock — should not happen with valid DAG
        break;
      }

      // Smart task grouping: batch independent tasks by same agent
      var batchSize = Math.min(ready.length, this.config.get('parallelism') || 4);
      var batch = ready.slice(0, batchSize);

      // Group by agent for composite prompts
      var agentBatches = {};
      for (var gb = 0; gb < batch.length; gb++) {
        var bAgent = batch[gb].assignedAgent;
        if (!agentBatches[bAgent]) agentBatches[bAgent] = [];
        agentBatches[bAgent].push(batch[gb]);
      }

      var promises = [];
      var batchTaskOrder = []; // Track which tasks correspond to which promises

      for (var agentKey in agentBatches) {
        var agentTasks = agentBatches[agentKey];

        if (agentTasks.length >= 2) {
          // Composite execution: batch multiple tasks for same agent
          (function(tasks, agent) {
            for (var nt = 0; nt < tasks.length; nt++) {
              if (onProgress) {
                onProgress({
                  type: 'agent_start',
                  taskId: tasks[nt].id,
                  agentName: agent,
                  description: tasks[nt].description,
                });
              }
            }
            promises.push(this.executeBatch(tasks, decomposition));
            batchTaskOrder.push({ type: 'batch', tasks: tasks });
          }).call(this, agentTasks, agentKey);
        } else {
          // Single task execution
          (function(task) {
            if (onProgress) {
              onProgress({
                type: 'agent_start',
                taskId: task.id,
                agentName: task.assignedAgent,
                description: task.description,
              });
            }
            promises.push(this.executeOne(task, decomposition));
            batchTaskOrder.push({ type: 'single', tasks: [task] });
          }).call(this, agentTasks[0]);
        }
      }

      var batchResults = await Promise.allSettled(promises);

      for (var m = 0; m < batchResults.length; m++) {
        var batchEntry = batchTaskOrder[m];
        var outcome = batchResults[m];

        if (outcome.status === 'fulfilled' && outcome.value) {
          if (batchEntry.type === 'batch' && Array.isArray(outcome.value)) {
            // Batch result: array of results per task
            for (var br = 0; br < outcome.value.length; br++) {
              var bTask = batchEntry.tasks[br];
              var bResult = outcome.value[br];
              completed.add(bTask.id);
              this.results.set(bTask.id, bResult.result);
              this.registry.recordSuccess(bTask.assignedAgent);
              contributions.push({
                agentName: bTask.assignedAgent,
                subTaskId: bTask.id,
                status: 'completed',
                result: bResult.result,
                durationMs: bResult.durationMs,
                quality: bResult.quality,
              });
              if (onProgress) {
                onProgress({
                  type: 'agent_complete',
                  taskId: bTask.id,
                  agentName: bTask.assignedAgent,
                  durationMs: bResult.durationMs,
                });
              }
            }
          } else {
            // Single result
            var task = batchEntry.tasks[0];
            var singleResult = batchEntry.type === 'batch' ? outcome.value[0] : outcome.value;
            completed.add(task.id);
            this.results.set(task.id, singleResult.result);
            this.registry.recordSuccess(task.assignedAgent);
            contributions.push({
              agentName: task.assignedAgent,
              subTaskId: task.id,
              status: 'completed',
              result: singleResult.result,
              durationMs: singleResult.durationMs,
              quality: singleResult.quality,
            });
            if (onProgress) {
              onProgress({
                type: 'agent_complete',
                taskId: task.id,
                agentName: task.assignedAgent,
                durationMs: singleResult.durationMs,
              });
            }
          }
        } else {
          var errMsg = outcome.status === 'rejected'
            ? (outcome.reason && outcome.reason.message ? outcome.reason.message : String(outcome.reason))
            : 'Unknown error';

          // Handle failure for all tasks in this entry
          for (var ft = 0; ft < batchEntry.tasks.length; ft++) {
            var fTask = batchEntry.tasks[ft];
            // Retry logic
            var retried = await this.retryTask(fTask, decomposition, errMsg);
            if (retried) {
              completed.add(fTask.id);
              this.results.set(fTask.id, retried.result);
              contributions.push({
                agentName: retried.agentName,
                subTaskId: fTask.id,
                status: 'completed',
                result: retried.result,
                durationMs: retried.durationMs,
                quality: retried.quality,
              });
              // v5.0.2: Emit retry success progress event
              if (onProgress) {
                onProgress({
                  type: 'agent_retry_success',
                  taskId: fTask.id,
                  originalAgent: fTask.assignedAgent !== retried.agentName ? fTask.assignedAgent : null,
                  agentName: retried.agentName,
                  durationMs: retried.durationMs,
                });
              }
            } else {
              failed.add(fTask.id);
              this.registry.recordFailure(fTask.assignedAgent);
              contributions.push({
                agentName: fTask.assignedAgent,
                subTaskId: fTask.id,
                status: 'failed',
                result: errMsg,
                durationMs: 0,
                quality: null,
              });
              // v5.0.2: Emit failure progress event
              if (onProgress) {
                onProgress({
                  type: 'agent_failed',
                  taskId: fTask.id,
                  agentName: fTask.assignedAgent,
                  error: errMsg,
                });
              }
            }
        }
      }
    }
      // v5.0.0: Advance communication stream wave after each parallel batch
      if (this.commStream) {
        this.commStream.nextWave();
      }
    } // end while

    return {
      contributions: contributions,
      totalDurationMs: Date.now() - startTime,
      completedCount: completed.size,
      failedCount: failed.size,
    };
  }

  /**
   * Execute a single sub-task with an agent.
   *
   * v4.0.0 Fix 1: Injects shared workspace snapshot into context + extracts workspace tags from output.
   * v4.0.0 Fix 4: Injects episodic memories into context.
   */
  async executeOne(task, decomposition) {
    var agentName = task.assignedAgent || 'oracle';
    var startTime = Date.now();
    var baseTimeout = this.config.get('timeout') || 120000;
    // Tasks with dependencies get extra time (they process more context from dep results)
    var depCount = task.dependsOn ? task.dependsOn.length : 0;
    var timeout = baseTimeout + (depCount * 30000);

    // Build context with results from dependencies
    var context = {
      originalPrompt: decomposition.tasks.map(function(t) { return t.description; }).join('\n'),
      dependencyResults: {},
      taskDescription: task.description,
    };

    if (task.dependsOn) {
      for (var i = 0; i < task.dependsOn.length; i++) {
        var depResult = this.results.get(task.dependsOn[i]);
        if (depResult) {
          context.dependencyResults[task.dependsOn[i]] = depResult;
        }
      }
    }

    // v4.0.0 Fix 1: Inject workspace snapshot into context
    if (this.workspace.size > 0) {
      context.workspaceSnapshot = this.workspace.getSnapshot();
    }

    // v4.0.0 Fix 4: Inject episodic memories into context
    if (this._memories) {
      var memKey = agentName + ':' + (task.capability || 'general');
      if (this._memories[memKey]) {
        context.episodicMemories = this._memories[memKey];
      }
    }

    // v5.0.1 Fix 1: Always inject communication stream — bootstrap instruction if no thoughts yet
    if (this.commStream) {
      if (this.commStream.thoughts.length > 0) {
        context.eventStream = this.commStream.getStreamSnapshot(agentName);
      } else {
        context.eventStream = this.commStream.getBootstrapInstruction(agentName);
      }
      // v6.0.0: Inject other agents' proposals for cross-reading
      var proposalCtx = this.commStream.getProposalContext(agentName);
      if (proposalCtx) {
        // v9.0: In reductio mode, modify cross-reading instructions
        if (decomposition.reasoningMode === 'reductio') {
          proposalCtx = '[REDUCTIO CROSS-READING]\n'
            + 'You are reading other agents\' proposals in a REDUCTIO AD ABSURDUM proof.\n'
            + 'Check that each agent MAINTAINS the assumed premise. Do NOT correct it.\n'
            + 'If a previous step derives a consequence, verify it follows logically.\n'
            + 'If you find a contradiction, REPORT IT — do not resolve it.\n'
            + 'The contradiction is what we are looking for.\n\n' + proposalCtx;
        }
        context.proposalContext = proposalCtx;
      }
    }

    // v5.0.0: Inject prompt evolution suffix
    if (this.promptEvolver) {
      context.promptEvolution = this.promptEvolver.getPromptEvolution(agentName);
    }

    // v5.0.0→v7.0.0: Inject cross-agent knowledge graph + track injected link IDs
    if (this.knowledgeGraphEnabled && this.client) {
      try {
        var graphResp = await this.client.getKnowledgeGraph(agentName, 1);
        if (graphResp && graphResp.edges && graphResp.edges.length > 0) {
          var kgSnapshot = '\n--- CROSS-AGENT KNOWLEDGE ---\n';
          kgSnapshot += 'Knowledge links from your collaboration history:\n';
          // v7.0.0: Track injected link IDs for reinforcement/decay
          if (!this._injectedLinks) this._injectedLinks = {};
          this._injectedLinks[agentName] = [];
          for (var ki = 0; ki < Math.min(graphResp.edges.length, 5); ki++) {
            var edge = graphResp.edges[ki];
            kgSnapshot += '  [' + edge.linkType + '] ' + edge.sourceAgent + ' → ' + (edge.targetAgent || 'global') +
              ': ' + edge.concept + ' (strength: ' + edge.strength.toFixed(2) + ')\n';
            kgSnapshot += '    Evidence: ' + edge.evidence + '\n';
            if (edge.id) this._injectedLinks[agentName].push({ id: edge.id, strength: edge.strength });
          }
          kgSnapshot += '--- END KNOWLEDGE ---\n';
          context.knowledgeGraph = kgSnapshot;
        }
      } catch (_) {}
    }

    // v5.0.0: Inject latent space insight (divergence from previous wave)
    if (this.latentSpaceEnabled && this.client && this.runId) {
      try {
        var divResp = await this.client.getLatentDivergence(this.runId, 0.5);
        if (divResp && divResp.divergentAgents && divResp.divergentAgents.length > 0) {
          var lsSnapshot = '\n--- LATENT SPACE INSIGHT ---\n';
          if (divResp.centroidSummary) {
            lsSnapshot += 'Collective understanding: ' + divResp.centroidSummary + '\n';
          }
          lsSnapshot += 'DIVERGENT THINKING DETECTED:\n';
          for (var li = 0; li < divResp.divergentAgents.length; li++) {
            var da = divResp.divergentAgents[li];
            lsSnapshot += '- ' + da.agentName.toUpperCase() + ' (similarity: ' + da.similarity.toFixed(2) +
              '): "' + da.reasoningSummary + '"\n';
          }
          lsSnapshot += 'These agents see different aspects. Consider both perspectives.\n';
          lsSnapshot += '--- END LATENT SPACE ---\n';
          context.latentSpaceInsight = lsSnapshot;
        }
      } catch (_) {}
    }

    // v9.0: Inject reductio ad absurdum context when in reductio mode
    if (decomposition.reasoningMode === 'reductio') {
      context.reductioContext = '[REDUCTIO AD ABSURDUM MODE]\n'
        + 'The initial premise is ASSUMED TRUE for the duration of this proof. DO NOT correct it.\n'
        + 'DO NOT attempt to "resolve" or "fix" the premise — that would destroy the proof.\n'
        + 'Follow the logical consequences honestly, step by step.\n'
        + 'If consequences lead to a contradiction, REPORT IT clearly — do not fix it.\n'
        + 'The contradiction IS the proof. Finding it means the premise is false.\n'
        + 'Use notation: [PREMISE], [STEP N], [CONTRADICTION], [CONCLUSION].';
    }

    // Load agent module
    var agentModule = await this.loadAgent(agentName);

    // Execute with timeout
    var result = await Promise.race([
      agentModule.execute(task, context, this.llm),
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error('Agent timeout after ' + timeout + 'ms')); }, timeout);
      }),
    ]);

    var resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    // v4.0.0 Fix 1: Extract workspace entries from output
    this.workspace.extractFromOutput(agentName, resultStr);

    // v5.0.0: Extract thoughts from communication stream
    if (this.commStream) {
      this.commStream.extractFromOutput(agentName, resultStr);
    }

    // Strip workspace and stream tags from result (clean for user/synthesis)
    resultStr = SharedWorkspace.stripTags(resultStr);
    resultStr = CommunicationStream.stripTags(resultStr);

    // v10.0: Parse structured output (confidence, risk flags)
    var parsedOutput = parseStructuredAgentOutput(resultStr);
    resultStr = parsedOutput.answer;

    // v6.0.0→v7.0.0: Record proposal with round number and confidence for cross-reading
    if (this.commStream) {
      this.commStream.recordProposal(agentName, resultStr, task.id, this._currentDeliberationRound || 1, parsedOutput.confidence, parsedOutput.riskFlags);
    }

    // v5.0.0: Contribute to latent space (fire-and-forget)
    if (this.latentSpaceEnabled && this.client && this.runId) {
      var reasoningSummary = (parsedOutput.reasoningSummary || resultStr.replace(/[#*`\[\]]/g, '')).trim();
      this.client.contributeLatentVector(this.runId, agentName, reasoningSummary, this.commStream ? this.commStream.currentWave : 0)
        .catch(function() {});
    }

    var durationMs = Date.now() - startTime;

    return {
      result: resultStr,
      durationMs: durationMs,
      quality: null, // Evaluated later by QualityEvaluator
      agentName: agentName,
    };
  }

  /**
   * Execute multiple tasks for the same agent in a single LLM call.
   * Creates a composite prompt with [TASK tN] markers, then splits the response.
   */
  async executeBatch(tasks, decomposition) {
    var agentName = tasks[0].assignedAgent || 'oracle';
    var startTime = Date.now();
    var baseTimeout = this.config.get('timeout') || 120000;
    // Batch gets extra time proportional to task count
    var timeout = baseTimeout + (tasks.length * 15000);

    var agentModule = await this.loadAgent(agentName);

    // Build composite prompt
    var compositeDesc = 'Complete these ' + tasks.length + ' sub-tasks in a single response, clearly labeled:\n\n';
    for (var bt = 0; bt < tasks.length; bt++) {
      compositeDesc += '[TASK ' + tasks[bt].id + '] ' + tasks[bt].description + '\n\n';
    }

    var context = {
      originalPrompt: decomposition.tasks.map(function(t) { return t.description; }).join('\n'),
      dependencyResults: {},
      taskDescription: compositeDesc,
    };

    // Collect dependency results from all tasks
    for (var ci = 0; ci < tasks.length; ci++) {
      if (tasks[ci].dependsOn) {
        for (var di = 0; di < tasks[ci].dependsOn.length; di++) {
          var depResult = this.results.get(tasks[ci].dependsOn[di]);
          if (depResult) {
            context.dependencyResults[tasks[ci].dependsOn[di]] = depResult;
          }
        }
      }
    }

    // v5.0.0: Inject collective intelligence context into batch
    if (this.workspace.size > 0) {
      context.workspaceSnapshot = this.workspace.getSnapshot();
    }
    if (this._memories) {
      var batchMemKey = agentName + ':general';
      if (this._memories[batchMemKey]) {
        context.episodicMemories = this._memories[batchMemKey];
      }
    }
    // v5.0.1 Fix 1: Always inject communication stream — bootstrap instruction if no thoughts yet
    if (this.commStream) {
      if (this.commStream.thoughts.length > 0) {
        context.eventStream = this.commStream.getStreamSnapshot(agentName);
      } else {
        context.eventStream = this.commStream.getBootstrapInstruction(agentName);
      }
      // v7.0.0 Fix: Inject other agents' proposals for cross-reading in batch execution
      var batchProposalCtx = this.commStream.getProposalContext(agentName);
      if (batchProposalCtx) {
        context.proposalContext = batchProposalCtx;
      }
    }
    if (this.promptEvolver) {
      context.promptEvolution = this.promptEvolver.getPromptEvolution(agentName);
    }

    var compositeTask = { id: tasks.map(function(t) { return t.id; }).join('+'), description: compositeDesc, assignedAgent: agentName, dependsOn: [] };

    var rawResult = await Promise.race([
      agentModule.execute(compositeTask, context, this.llm),
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error('Agent timeout after ' + timeout + 'ms')); }, timeout);
      }),
    ]);

    var resultStr = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);

    // v5.0.0: Extract workspace and stream tags from batch output
    this.workspace.extractFromOutput(agentName, resultStr);
    if (this.commStream) {
      this.commStream.extractFromOutput(agentName, resultStr);
    }
    resultStr = SharedWorkspace.stripTags(resultStr);
    resultStr = CommunicationStream.stripTags(resultStr);

    // v5.0.0: Contribute to latent space (fire-and-forget)
    if (this.latentSpaceEnabled && this.client && this.runId) {
      var batchSummary = resultStr.replace(/[#*`\[\]]/g, '').trim();
      this.client.contributeLatentVector(this.runId, agentName, batchSummary, this.commStream ? this.commStream.currentWave : 0)
        .catch(function() {});
    }

    var durationMs = Date.now() - startTime;
    var perTaskDuration = Math.round(durationMs / tasks.length);

    // Split response by [TASK tN] markers
    var hasAnyMarker = false;
    for (var mi = 0; mi < tasks.length; mi++) {
      if (resultStr.indexOf('[TASK ' + tasks[mi].id + ']') >= 0) { hasAnyMarker = true; break; }
    }

    var results = [];

    if (!hasAnyMarker && tasks.length === 1) {
      // Single task, no markers needed — assign entire response
      results.push({
        result: resultStr.trim(),
        durationMs: perTaskDuration,
        quality: null,
        agentName: agentName,
      });
    } else if (!hasAnyMarker && tasks.length > 1) {
      // Multiple tasks but no markers — split response equitably
      var chunkSize = Math.ceil(resultStr.length / tasks.length);
      for (var ei = 0; ei < tasks.length; ei++) {
        var chunk = resultStr.substring(ei * chunkSize, (ei + 1) * chunkSize).trim();
        results.push({
          result: chunk || '(No separate output for this sub-task)',
          durationMs: perTaskDuration,
          quality: null,
          agentName: agentName,
        });
      }
    } else {
      // Standard marker-based splitting
      for (var si = 0; si < tasks.length; si++) {
        var marker = '[TASK ' + tasks[si].id + ']';
        var nextMarker = si < tasks.length - 1 ? '[TASK ' + tasks[si + 1].id + ']' : null;
        var startIdx = resultStr.indexOf(marker);
        var taskResult;

        if (startIdx >= 0) {
          var contentStart = startIdx + marker.length;
          var endIdx = nextMarker ? resultStr.indexOf(nextMarker, contentStart) : resultStr.length;
          if (endIdx < 0) endIdx = resultStr.length;
          taskResult = resultStr.substring(contentStart, endIdx).trim();
        } else {
          taskResult = '(No separate output for this sub-task)';
        }

        results.push({
          result: taskResult,
          durationMs: perTaskDuration,
          quality: null,
          agentName: agentName,
        });
      }
    }

    // v7.0.0 Fix: Record proposals for each sub-task in batch so cross-reading works
    if (this.commStream) {
      for (var rp = 0; rp < results.length; rp++) {
        var rpTask = tasks[rp];
        if (rpTask && results[rp].result) {
          var batchParsed = parseStructuredAgentOutput(results[rp].result);
          results[rp].result = batchParsed.answer;
          this.commStream.recordProposal(agentName, batchParsed.answer, rpTask.id, this._currentDeliberationRound || 1, batchParsed.confidence, batchParsed.riskFlags);
        }
      }
    }

    return results;
  }

  /**
   * Retry a failed task.
   * First retry: same agent. Last retry: same-category specialist, then parentAgent, then GADGET.
   */
  async retryTask(task, decomposition, lastError) {
    var maxRetries = this.config.get('maxRetries') || 2;
    var originalAgent = task.assignedAgent;

    for (var attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt === maxRetries - 1 && originalAgent !== 'oracle') {
          // Last attempt: try a same-category specialist with overlapping capabilities
          var originalEntry = AGENT_CATALOG.find(function(a) { return a.name === originalAgent; });
          if (originalEntry) {
            var alternate = AGENT_CATALOG.find(function(a) {
              if (a.name === originalAgent) return false;
              if (a.category !== originalEntry.category) return false;
              return a.capabilities.some(function(cap) {
                return originalEntry.capabilities.indexOf(cap) !== -1;
              });
            });
            task.assignedAgent = alternate ? alternate.name : (originalEntry.parentAgent || 'oracle');
          } else {
            task.assignedAgent = 'oracle';
          }
        }
        var result = await this.executeOne(task, decomposition);
        return result;
      } catch {
        continue;
      }
    }

    task.assignedAgent = originalAgent;
    return null;
  }

  /**
   * Dynamically import an agent module.
   * Agents are .mjs files in the agents/ directory.
   */
  async loadAgent(name) {
    if (this.agentModules.has(name)) {
      return this.agentModules.get(name);
    }

    var filePath = path.join(AGENTS_DIR, name + '.mjs');

    if (!fs.existsSync(filePath)) {
      // Agent file not found — use inline fallback
      var fallbackModule = createFallbackAgent(name);
      this.agentModules.set(name, fallbackModule);
      return fallbackModule;
    }

    try {
      var mod = await import(filePath);
      this.agentModules.set(name, mod);
      return mod;
    } catch (err) {
      var fallback = createFallbackAgent(name);
      this.agentModules.set(name, fallback);
      return fallback;
    }
  }
}

/**
 * Create a fallback agent that uses the LLM directly with the agent's
 * system prompt from the catalog.
 */
function createFallbackAgent(name) {
  var catalogEntry = AGENT_CATALOG.find(function(a) { return a.name === name; });
  var systemPrompt = catalogEntry
    ? 'You are ' + catalogEntry.displayName + ' (' + catalogEntry.origin + '), a specialized AI agent.\n' +
      'Tagline: ' + catalogEntry.tagline + '\n' +
      'Capabilities: ' + catalogEntry.capabilities.join(', ') + '\n\n' +
      'Provide expert-level output for the given task. Be thorough and actionable.'
    : 'You are a helpful AI assistant. Complete the given task.';

  return {
    AGENT_CARD: catalogEntry || { name: name, displayName: name.toUpperCase(), category: 'utility' },
    SYSTEM_PROMPT: systemPrompt,
    execute: async function(task, context, llmProvider) {
      var prompt = 'Task: ' + task.description;
      if (context.dependencyResults && Object.keys(context.dependencyResults).length > 0) {
        prompt += '\n\nContext from previous tasks:\n';
        var keys = Object.keys(context.dependencyResults);
        for (var i = 0; i < keys.length; i++) {
          prompt += '\n--- Result from ' + keys[i] + ' ---\n' + context.dependencyResults[keys[i]];
        }
      }
      if (context.originalPrompt) {
        prompt += '\n\nOriginal request context: ' + context.originalPrompt;
      }
      // v6.0.0: Inject ALL collective intelligence context (was missing from fallback agents)
      if (context.workspaceSnapshot) prompt += context.workspaceSnapshot;
      if (context.episodicMemories) prompt += context.episodicMemories;
      if (context.eventStream) prompt += context.eventStream;
      if (context.proposalContext) prompt += context.proposalContext;
      if (context.knowledgeGraph) prompt += context.knowledgeGraph;
      if (context.latentSpaceInsight) prompt += context.latentSpaceInsight;
      // v9.0: Inject reductio context
      if (context.reductioContext) prompt += '\n\n' + context.reductioContext;
      // v6.0.0: Apply prompt evolution to system prompt
      var evolvedPrompt = systemPrompt;
      if (context.promptEvolution) evolvedPrompt += context.promptEvolution;
      return llmProvider.chat(evolvedPrompt, prompt, { maxTokens: 8192, agentTag: name });
    },
  };
}

// ============================================================================
// Section 7: ResultSynthesizer — Combine agent results
// ============================================================================

class ResultSynthesizer {
  constructor(llmProvider) {
    this.llm = llmProvider;
  }

  /**
   * Synthesize all agent results into a coherent final response.
   *
   * v4.0.0 Fix 6: Weighted Authority Synthesis — tags each contribution with
   * authority level so the synthesizer knows who is a specialist and who is
   * a generalist. Conflicts are resolved with specialist > generalist hierarchy.
   */
  async synthesize(prompt, contributions, options) {
    options = options || {};
    var registry = options.registry || null;
    var decomposition = options.decomposition || null;

    // If only one agent, return its result directly
    var completed = contributions.filter(function(c) { return c.status === 'completed'; });
    if (completed.length === 0) {
      return { result: 'All agents failed to produce results.', synthesized: false };
    }

    if (completed.length === 1) {
      return { result: completed[0].result, synthesized: false };
    }

    var agentResults = '';
    for (var i = 0; i < completed.length; i++) {
      var c = completed[i];
      var truncatedResult = c.result;

      // v4.0.0→v7.0.0: Authority tagging with historical quality + deliberation round
      var authorityTag = 'generalist';
      var qualityTag = '';
      var historicalTag = '';
      var roundTag = '';
      if (registry && decomposition) {
        var subTask = decomposition.tasks.find(function(t) { return t.id === c.subTaskId; });
        var agentEntry = registry.getAgent(c.agentName);
        if (subTask && agentEntry) {
          var taskCap = (subTask.capability || '').toLowerCase();
          var isSpecialist = agentEntry.parentAgent || // Sub-agents are specialists
            (taskCap && agentEntry.capabilities.some(function(cap) {
              return cap.toLowerCase() === taskCap;
            }));
          if (isSpecialist) authorityTag = 'specialist:' + taskCap;

          // v7.0.0: Historical quality + task count
          if (agentEntry.avgQuality > 0 || agentEntry.tasksCompleted > 0) {
            historicalTag = ', historical:' + ((agentEntry.avgQuality || 0) * 100).toFixed(0) +
              '%, ' + (agentEntry.tasksCompleted || 0) + ' tasks';
          }
        }
        if (typeof c.quality === 'number') {
          qualityTag = ', quality:' + (c.quality * 100).toFixed(0) + '%';
        }
      }

      // v7.0.0: Deliberation round tagging
      if (options.commStream) {
        var latestProposal = null;
        for (var pi = options.commStream.proposals.length - 1; pi >= 0; pi--) {
          if (options.commStream.proposals[pi].agent === c.agentName &&
              options.commStream.proposals[pi].subTaskId === c.subTaskId) {
            latestProposal = options.commStream.proposals[pi];
            break;
          }
        }
        if (latestProposal && latestProposal.round) {
          var roundLabel = latestProposal.round === 1 ? 'initial' :
            latestProposal.round === 2 ? 'refined' : 'mediated';
          roundTag = ', round:' + latestProposal.round + '/' + roundLabel;
        }
      }

      agentResults += '\n--- ' + c.agentName.toUpperCase() + ' [' + authorityTag + qualityTag +
        historicalTag + roundTag + '] (task: ' + c.subTaskId + ') ---\n' + truncatedResult + '\n';
    }

    var systemPrompt = 'You are LEGION Synthesizer. Combine specialist agent outputs into ONE comprehensive response.\n\n' +
      'CRITICAL RULES:\n' +
      '1. Preserve ALL technical details, data points, code, proofs, and benchmarks from each agent\n' +
      '2. NEVER summarize or abbreviate — include the full depth of each agent\'s contribution\n' +
      '3. Organize with clear structure: headings, sections, numbered lists\n' +
      '4. Resolve contradictions by preferring the specialist agent for their domain\n' +
      '5. The output must be COMPLETE — do not end mid-sentence or mid-section\n' +
      '6. Output must be significantly longer than any single agent\'s contribution\n' +
      '7. If an agent provided code, include the full code — never say "see above" or truncate\n\n' +
      'AUTHORITY HIERARCHY (v7.0.0):\n' +
      'Each agent is tagged [specialist:domain] or [generalist], with quality, historical stats, and deliberation round.\n' +
      'When agents CONFLICT:\n' +
      '- Specialist on their domain ALWAYS wins over generalist\n' +
      '- Between specialists, prefer the one with higher historical quality (more reliable over time)\n' +
      '- Then prefer higher current task quality\n' +
      '- Between generalists, synthesize both perspectives\n' +
      'Mark resolved conflicts with [CONFLICT:agent1>agent2:reason] inline.\n\n' +
      'DELIBERATION ROUND INFO:\n' +
      '- round:1/initial = first proposal (may be incomplete)\n' +
      '- round:2/refined = agent saw others\' proposals and updated their response\n' +
      '- round:3/mediated = agent was in disagreement and provided evidence-based defense\n' +
      'Prefer round:3/mediated contributions — these are evidence-backed positions.\n' +
      'Prefer round:2/refined over round:1/initial — these incorporate collective input.';

    // v9.0: Reductio mode — assemble a formal proof, not a standard synthesis
    if (decomposition && decomposition.reasoningMode === 'reductio') {
      systemPrompt = 'You are LEGION Synthesizer in REDUCTIO AD ABSURDUM mode.\n\n' +
        'The agents have performed a proof by contradiction. Your job is to assemble their outputs into a FORMAL PROOF.\n\n' +
        'OUTPUT STRUCTURE (MANDATORY):\n' +
        '1. PREMISE: State the assumption that was assumed true (from the first agent\'s output)\n' +
        '2. LOGICAL CHAIN: Number each derivation step. For each step, cite which agent produced it:\n' +
        '   Step 1 (AGENT_NAME): P -> Q (because ...)\n' +
        '   Step 2 (AGENT_NAME): Q -> R (because ...)\n' +
        '   ...\n' +
        '3. CONTRADICTION: State the contradiction clearly — which two statements conflict, and which steps produced them\n' +
        '4. CONCLUSION: "Since assuming P leads to R and not-R, the premise P is false. Therefore not-P. QED."\n\n' +
        'CRITICAL RULES:\n' +
        '- NEVER "resolve" or "fix" the contradiction — it IS the proof\n' +
        '- NEVER suggest the premise might still be true if the contradiction is valid\n' +
        '- If agents failed to find a genuine contradiction, say so honestly rather than forcing one\n' +
        '- Preserve the logical rigor of each step — do not paraphrase away the formal structure\n' +
        '- After the formal proof, add a natural-language explanation for non-specialists';
    }

    var userPrompt = 'Original prompt: ' + prompt + '\n\nAgent outputs to synthesize:\n' + agentResults;

    try {
      var synthesized = await this.llm.chat(systemPrompt, userPrompt, { maxTokens: 16384, agentTag: 'synthesis' });
      return { result: synthesized, synthesized: true };
    } catch {
      // Fallback: concatenate results
      var fallbackResult = 'Results from ' + completed.length + ' agents:\n';
      for (var j = 0; j < completed.length; j++) {
        fallbackResult += '\n## ' + completed[j].agentName.toUpperCase() + '\n' + completed[j].result + '\n';
      }
      return { result: fallbackResult, synthesized: false };
    }
  }
}

// ============================================================================
// Section 8: QualityEvaluator — Multi-grader evaluation
// ============================================================================

// Filler patterns: common LLM padding phrases that add no information
var FILLER_PATTERNS = [
  /\b(it(?:'s| is) (?:worth noting|important to (?:note|mention|understand|remember|consider)))\b/gi,
  /\b(as (?:mentioned|noted|discussed|stated) (?:earlier|above|before|previously))\b/gi,
  /\b(in (?:conclusion|summary|essence|other words))\b/gi,
  /\b(it (?:should|must) be (?:noted|mentioned|emphasized|highlighted|pointed out))\b/gi,
  /\b((?:this|that) (?:is|was) a (?:great|good|excellent|interesting|important) (?:question|point|topic))\b/gi,
  /\b((?:I )?hope (?:this|that) (?:helps|answers|clarifies|is (?:helpful|useful|clear)))\b/gi,
  /\b((?:feel free to|don't hesitate to|please) (?:ask|reach out|let me know))\b/gi,
  /\b((?:let me|allow me to|I(?:'ll| will)) (?:explain|elaborate|clarify|break (?:this|it) down))\b/gi,
  /\b(overall[,\s]+(?:this|it|the) (?:is|was|provides))\b/gi,
  /\b(to (?:put it simply|be (?:more )?specific|summarize))\b/gi,
  /\b((?:first and foremost|last but not least|needless to say))\b/gi,
  /\b(it(?:'s| is) (?:also )?(?:crucial|essential|vital|key) to)\b/gi,
  /\b((?:having said that|that being said|with that (?:in mind|being said)))\b/gi,
  /\b((?:in this|in the) (?:context|regard|case|scenario))\b/gi,
  /\b((?:at the end of the day|when all is said and done|all things considered))\b/gi,
];

var STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they',
  'my', 'your', 'his', 'her', 'our', 'their', 'not', 'no', 'if', 'then', 'else', 'when',
  'up', 'out', 'as', 'so', 'than', 'too', 'very', 'just', 'also', 'about', 'into', 'more',
]);

// Imperative verb patterns for extracting requests from prompts
var IMPERATIVE_VERBS = /\b(explain|describe|list|create|write|build|implement|design|analyze|compare|evaluate|show|provide|generate|define|outline|discuss|develop|make|find|calculate|determine|suggest|recommend|identify|summarize)\b/i;

class QualityEvaluator {
  constructor(llmProvider) {
    this.llm = llmProvider;
  }

  // ==========================================================================
  // v4.0.0 Fix 8: Multi-Signal Grounding — 3 deterministic scoring methods
  //
  // These replace self-referential LLM evaluation with objective signals.
  // Blended 50/50 with LLM score in evaluate().
  // ==========================================================================

  /**
   * Factual Density Score — counts concrete facts vs vague statements.
   *
   * Counts: numbers, dates, URLs, code blocks, named entities (CAPS words),
   * specific measurements, version numbers, function names.
   * Score = min(1.0, factCount / (wordCount * 0.08))
   */
  factualDensityScore(result) {
    var words = result.split(/\s+/).length;
    if (words < 10) return 0.3;

    var factPatterns = [
      /\d+(\.\d+)?(%|ms|KB|MB|GB|TB|s|min|hrs?|days?|bytes?)/gi, // Measurements
      /\b\d{4}[-/]\d{2}[-/]\d{2}\b/g,                           // Dates
      /https?:\/\/\S+/gi,                                         // URLs
      /```[\s\S]*?```/g,                                          // Code blocks
      /`[^`]+`/g,                                                 // Inline code
      /\bv?\d+\.\d+(\.\d+)?\b/g,                                 // Version numbers
      /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,                        // CamelCase identifiers
      /\b(?:function|class|const|var|let|import|export|return)\b/g, // Code keywords
      /\b\d{1,3}(?:,\d{3})+\b/g,                                 // Large numbers
      /\$\d+/g,                                                    // Dollar amounts
    ];

    var factCount = 0;
    for (var i = 0; i < factPatterns.length; i++) {
      var matches = result.match(factPatterns[i]);
      if (matches) factCount += matches.length;
    }

    // Normalize: expect ~8% of words to be factual markers for score 1.0
    return Math.min(1.0, Math.round((factCount / (words * 0.08)) * 1000) / 1000);
  }

  /**
   * Instruction Compliance Score — how many explicit instructions are followed.
   *
   * Extracts verbs/directives from the prompt, checks if result addresses them.
   * Score = addressed / total (minimum 0.3 if we can't extract instructions).
   */
  instructionComplianceScore(prompt, result) {
    var resultLower = result.toLowerCase();

    // Extract imperative sentences from prompt
    var sentences = prompt.split(/[.!?\n]+/).filter(function(s) { return s.trim().length > 5; });
    var instructions = [];
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i].trim();
      if (IMPERATIVE_VERBS.test(s)) {
        // Extract key noun phrase after the verb
        var words = s.split(/\s+/).filter(function(w) { return !STOP_WORDS.has(w.toLowerCase()) && w.length > 2; });
        if (words.length > 0) {
          instructions.push(words.slice(0, 4).join(' ').toLowerCase());
        }
      }
    }

    if (instructions.length === 0) return 0.5; // Can't determine, neutral

    var addressed = 0;
    for (var j = 0; j < instructions.length; j++) {
      var instructionWords = instructions[j].split(/\s+/);
      var found = 0;
      for (var k = 0; k < instructionWords.length; k++) {
        if (resultLower.includes(instructionWords[k])) found++;
      }
      if (found >= Math.ceil(instructionWords.length * 0.5)) addressed++;
    }

    return Math.round((addressed / instructions.length) * 1000) / 1000;
  }

  /**
   * Agent Agreement Score — measures consensus among agent contributions.
   *
   * Computes pairwise Jaccard similarity on key terms between contributions.
   * High agreement (>0.3) = agents converged → likely correct.
   * Low agreement (<0.1) = agents diverged → may need debate.
   * Score mapped: agreement * 2 (capped at 1.0)
   */
  agentAgreementScore(contributions) {
    var completed = (contributions || []).filter(function(c) {
      return c.status === 'completed' && c.result;
    });
    if (completed.length < 2) return 0.5; // Can't measure agreement, neutral

    // Extract key terms per agent (non-stop-word tokens, 4+ chars)
    var agentTermSets = [];
    for (var i = 0; i < completed.length; i++) {
      var words = completed[i].result.toLowerCase().split(/\s+/);
      var termSet = new Set();
      for (var j = 0; j < words.length; j++) {
        var w = words[j].replace(/[^a-z0-9-]/g, '');
        if (w.length >= 4 && !STOP_WORDS.has(w)) {
          termSet.add(w);
        }
      }
      agentTermSets.push(termSet);
    }

    // Pairwise Jaccard similarity
    var totalJaccard = 0;
    var pairs = 0;
    for (var a = 0; a < agentTermSets.length; a++) {
      for (var b = a + 1; b < agentTermSets.length; b++) {
        var setA = agentTermSets[a];
        var setB = agentTermSets[b];
        var intersection = 0;
        setA.forEach(function(term) { if (setB.has(term)) intersection++; });
        var union = setA.size + setB.size - intersection;
        if (union > 0) {
          totalJaccard += intersection / union;
          pairs++;
        }
      }
    }

    var avgJaccard = pairs > 0 ? totalJaccard / pairs : 0;
    // Map Jaccard [0, 0.5+] to score [0, 1.0]
    return Math.min(1.0, Math.round(avgJaccard * 2 * 1000) / 1000);
  }

  /**
   * Deterministic filler/substance analysis — zero LLM calls.
   *
   * Returns: { ratio: 0-1, density: 0-1, fillerCount: N, fillerChars: N, penalties: [] }
   */
  analyzeSubstance(text) {
    var totalChars = text.length;
    if (totalChars === 0) return { ratio: 0, density: 0, fillerCount: 0, fillerChars: 0, penalties: [] };

    var fillerChars = 0;
    var fillerCount = 0;
    var penalties = [];

    // Count filler phrase characters
    for (var p = 0; p < FILLER_PATTERNS.length; p++) {
      var pattern = FILLER_PATTERNS[p];
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      var match;
      while ((match = pattern.exec(text)) !== null) {
        fillerChars += match[0].length;
        fillerCount++;
      }
    }

    // v3.4.1: Strip code blocks before repetition analysis.
    // Code naturally repeats patterns like "const", "return", "if (" — these are NOT filler.
    // Only analyze prose/natural language for repetitive openings.
    var proseText = text
      .replace(/```[\s\S]*?```/g, '')        // fenced code blocks
      .replace(/`[^`\n]+`/g, '')             // inline code
      .replace(/^[ \t]*[-*] \*\*[^*]+\*\*/gm, '') // bold list items (structural, not filler)
      .replace(/^\s*(?:const|let|var|function|return|if|else|for|while|class|import|export|switch|case|try|catch|throw|new|await|async)\b.*$/gm, ''); // code-like lines

    // Detect repetitive sentence openings (same first 3 words 3+ times)
    // v3.4.1: Split on sentence-ending punctuation only, NOT newlines.
    // Newline splitting treated every code/list line as a "sentence", causing false positives.
    var sentences = proseText.split(/[.!?]+/).filter(function(s) { return s.trim().length > 20; });
    var openings = {};
    for (var s = 0; s < sentences.length; s++) {
      var words = sentences[s].trim().split(/\s+/).slice(0, 3).join(' ').toLowerCase();
      if (words.length > 8) {
        openings[words] = (openings[words] || 0) + 1;
      }
    }
    var repetitionPenalty = 0;
    for (var key in openings) {
      if (openings[key] >= 4) {
        // v3.4.1: Threshold raised from 3 to 4 (prose naturally repeats "The X is"),
        // and penalty capped at 0.30 to prevent ratio-zeroing.
        repetitionPenalty += (openings[key] - 3) * 0.04;
        penalties.push('Repetitive opening "' + key + '" (' + openings[key] + 'x)');
      }
    }
    repetitionPenalty = Math.min(repetitionPenalty, 0.30);

    var ratio = Math.max(0, (totalChars - fillerChars) / totalChars - repetitionPenalty);

    // v3.3.0: Information density — unique meaningful words / total meaningful words.
    // Previous formula (unique/total) penalized technical documents that repeat domain terms.
    // New formula: only counts meaningful (non-stop) words in both numerator and denominator,
    // and uses a sliding window to account for natural term recurrence in long documents.
    var allWords = text.toLowerCase().match(/\b[a-z]{2,}\b/g) || [];
    var meaningful = allWords.filter(function(w) { return !STOP_WORDS.has(w); });
    var uniqueMeaningful = new Set(meaningful);
    var density;
    if (meaningful.length === 0) {
      density = 0;
    } else if (meaningful.length > 500) {
      // Long documents: use windowed density (last 500 meaningful words) to avoid
      // penalizing natural repetition in comprehensive technical documents.
      var windowWords = meaningful.slice(-500);
      var windowUnique = new Set(windowWords);
      density = windowUnique.size / windowWords.length;
    } else {
      density = uniqueMeaningful.size / meaningful.length;
    }

    return {
      ratio: Math.round(ratio * 1000) / 1000,
      density: Math.round(density * 1000) / 1000,
      fillerCount: fillerCount,
      fillerChars: fillerChars,
      penalties: penalties,
    };
  }

  /**
   * Structural completeness check — zero LLM calls.
   *
   * Extracts requests/questions from prompt and checks coverage in result.
   * Returns: { coverage: 0-1, addressed: N, total: N, missed: [...] }
   */
  checkStructuralCompleteness(prompt, result) {
    var requests = [];

    // v3.3.0: Smarter extraction — numbered items have HIGHEST priority (most explicit),
    // then questions, then imperative sentences. Avoids double-counting when a numbered
    // item also contains an imperative verb.

    // Step 1: Extract numbered items FIRST (1. xxx, 2) xxx, - xxx, * xxx)
    var numbered = prompt.match(/(?:^|\n)\s*(?:\d+[.)]\s*|-\s*|\*\s*)([^\n]{5,})/g) || [];
    var numberedTexts = [];
    for (var n = 0; n < numbered.length; n++) {
      var item = numbered[n].replace(/^\s*(?:\d+[.)]\s*|-\s*|\*\s*)/, '').trim();
      if (item.length > 10) {
        requests.push(item);
        numberedTexts.push(item.toLowerCase());
      }
    }

    // Step 2: Extract questions (sentences ending with ?)
    var questions = prompt.match(/[^.!?\n]*\?/g) || [];
    for (var q = 0; q < questions.length; q++) {
      var cleaned = questions[q].trim();
      if (cleaned.length > 15) {
        // v3.3.0: Skip if this question is already captured as a numbered item
        var cleanedLower = cleaned.toLowerCase();
        var isDupe = numberedTexts.some(function(t) { return t.includes(cleanedLower) || cleanedLower.includes(t); });
        if (!isDupe) requests.push(cleaned);
      }
    }

    // Step 3: Extract imperative sentences ONLY if we have < 3 items so far
    // This prevents over-extraction from prose-style prompts
    if (requests.length < 3) {
      var promptSentences = prompt.split(/[.!?\n]+/).filter(function(s) { return s.trim().length > 15; });
      for (var i = 0; i < promptSentences.length; i++) {
        var sentence = promptSentences[i].trim();
        if (IMPERATIVE_VERBS.test(sentence)) {
          var sentLower = sentence.toLowerCase();
          var alreadyCaptured = requests.some(function(r) {
            var rLower = r.toLowerCase();
            return rLower.includes(sentLower) || sentLower.includes(rLower);
          });
          if (!alreadyCaptured) requests.push(sentence);
        }
      }
    }

    // v3.3.0: If no structured items found, treat the whole prompt as ONE request
    if (requests.length === 0) {
      requests.push(prompt);
    }
    // v3.3.0: Cap at 8 items (was 10) — fewer, more meaningful items = fairer coverage
    if (requests.length > 8) requests = requests.slice(0, 8);

    var resultLower = result.toLowerCase();
    var addressed = 0;
    var missed = [];

    for (var r = 0; r < requests.length; r++) {
      // v3.3.0: Extract key terms (words > 3 chars, not stop words) but also
      // consider compound terms (e.g., "proof reduction", "side-channel")
      var keyTerms = requests[r].toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
      keyTerms = keyTerms.filter(function(w) { return !STOP_WORDS.has(w); });

      // v3.3.0: Also extract hyphenated compound terms and multi-word phrases
      var compounds = requests[r].toLowerCase().match(/\b[a-z]+-[a-z]+\b/g) || [];
      for (var ci = 0; ci < compounds.length; ci++) {
        if (keyTerms.indexOf(compounds[ci]) === -1) keyTerms.push(compounds[ci]);
      }

      if (keyTerms.length === 0) {
        addressed++;
        continue;
      }

      // v3.3.0: Weighted term matching — longer/rarer terms count more
      var totalWeight = 0;
      var foundWeight = 0;
      for (var k = 0; k < keyTerms.length; k++) {
        var termWeight = keyTerms[k].length >= 8 ? 2.0 : (keyTerms[k].length >= 6 ? 1.5 : 1.0);
        totalWeight += termWeight;
        if (resultLower.indexOf(keyTerms[k]) !== -1) foundWeight += termWeight;
      }

      var termCoverage = foundWeight / totalWeight;
      // v3.4.0: Threshold 0.50 — must find at least half of weighted key terms.
      // 0.60 was too strict (synonyms cause false negatives).
      // 0.45 was too lenient (inflated coverage scores).
      if (termCoverage >= 0.50) {
        addressed++;
      } else {
        missed.push(requests[r].substring(0, 100));
      }
    }

    return {
      coverage: requests.length > 0 ? Math.round((addressed / requests.length) * 1000) / 1000 : 1,
      addressed: addressed,
      total: requests.length,
      missed: missed,
    };
  }

  /**
   * Cross-validation: skeptical second evaluator.
   *
   * Only runs when agentCount >= 3 OR primaryScore >= 0.8.
   * Reconciliation: per dimension, divergence <= 0.1 → average, else → min (conservative).
   */
  async crossValidate(prompt, result, primaryEval) {
    // v3.4.2: Fully independent cross-validation. Previous versions showed primary
    // evaluator's scores, creating anchoring bias (cross-validator just confirmed them).
    // Now the cross-validator scores blind — no knowledge of primary scores.
    var systemPrompt = 'You are an INDEPENDENT quality evaluator. Score this response objectively.\n\n' +
      'Score on 5 dimensions (0.0 to 1.0):\n' +
      '- completeness: How fully does the response address the prompt?\n' +
      '- depth: How deep and insightful is the analysis?\n' +
      '- actionability: How concrete and implementable are the recommendations?\n' +
      '- coherence: How well-structured and logical is the response?\n' +
      '- substance: How dense with real information (vs filler/padding)?\n\n' +
      'CALIBRATION: 0.6-0.75 is typical good quality. 0.8+ requires comprehensive AND expert-level content.\n\n' +
      'Respond with ONLY valid JSON:\n' +
      '{"completeness":0-1,"depth":0-1,"actionability":0-1,"coherence":0-1,"substance":0-1,"feedback":"Brief justification"}';

    var userPrompt = 'Prompt:\n' + prompt + '\n\nResponse:\n' + result;

    try {
      var response = await this.llm.chat(systemPrompt, userPrompt, { maxTokens: 512, agentTag: 'quality:crossval' });
      var parsed = extractJSON(response);
      if (parsed && typeof parsed.completeness === 'number') {
        return parsed;
      }
    } catch {}

    return null; // Cross-validation unavailable — skip reconciliation
  }

  /**
   * Evaluate the quality of the final synthesized result.
   *
   * v3.3.0: Rebalanced weights — Completeness and Depth are the primary
   * indicators of quality. Substance/Coherence are secondary signals.
   *
   * Weighted scoring:
   * - Completeness: 30% (was 25%)
   * - Depth: 30% (was 25%)
   * - Actionability: 20% (was 25%)
   * - Substance: 10% (was 15%)
   * - Coherence: 10% (unchanged)
   *
   * v3.3.0 changes:
   * - Density penalty threshold raised from 0.25 to 0.15 (only triggers for truly sparse text)
   * - Coverage penalty threshold lowered from 0.7 to 0.5 (only penalizes severe omissions)
   * - Evaluator sees more of the result (8000 chars vs 4000)
   * - Cross-validation uses adaptive reconciliation (not always min)
   */
  async evaluate(prompt, result, options) {
    options = options || {};
    var agentCount = options.agentCount || 1;

    // Step 1: Deterministic analysis (zero LLM calls)
    var substance = this.analyzeSubstance(result);
    var structural = this.checkStructuralCompleteness(prompt, result);

    // Step 2: LLM evaluation with substance context injected
    var substanceNote = '\n\nSUBSTANCE ANALYSIS (pre-computed, use for scoring):\n' +
      '- Substance ratio: ' + (substance.ratio * 100).toFixed(0) + '% (filler: ' + substance.fillerCount + ' phrases)\n' +
      '- Info density: ' + (substance.density * 100).toFixed(0) + '%\n' +
      '- Structural coverage: ' + structural.addressed + '/' + structural.total + ' prompt items addressed\n';
    if (structural.missed.length > 0) {
      substanceNote += '- Missed items: ' + structural.missed.join('; ') + '\n';
    }

    var systemPrompt = 'You are an INDEPENDENT quality evaluator. You did NOT generate this response. Be critical and objective.\n\n' +
      'Score the response on 5 criteria using these rubrics:\n\n' +
      'COMPLETENESS (weight: 30%):\n' +
      '  0.9-1.0: Every aspect of the prompt is addressed with depth\n' +
      '  0.7-0.89: Most aspects covered, minor gaps\n' +
      '  0.5-0.69: Major aspects covered but notable omissions\n' +
      '  <0.5: Significant parts of the prompt are ignored\n\n' +
      'DEPTH (weight: 30%):\n' +
      '  0.9-1.0: Expert-level analysis with nuanced insights\n' +
      '  0.7-0.89: Solid analysis beyond surface level\n' +
      '  0.5-0.69: Adequate but mostly surface-level\n' +
      '  <0.5: Superficial or generic\n\n' +
      'ACTIONABILITY (weight: 20%):\n' +
      '  0.9-1.0: Concrete steps, code, or specific recommendations\n' +
      '  0.7-0.89: Mostly actionable with some vagueness\n' +
      '  0.5-0.69: General guidance but lacks specifics\n' +
      '  <0.5: Vague or theoretical only\n\n' +
      'SUBSTANCE (weight: 10%):\n' +
      '  0.9-1.0: Dense, no filler, every sentence carries new information\n' +
      '  0.7-0.89: Mostly substantive with minor padding\n' +
      '  0.5-0.69: Noticeable filler or repetition\n' +
      '  <0.5: Heavy padding, hedging, or fluff\n\n' +
      'COHERENCE (weight: 10%):\n' +
      '  0.9-1.0: Flawless structure and logical flow\n' +
      '  0.7-0.89: Well-organized with minor issues\n' +
      '  0.5-0.69: Understandable but poorly structured\n' +
      '  <0.5: Contradictory or confusing\n\n' +
      'CALIBRATION: Score the actual response quality. 0.6-0.75 is typical. ' +
      '0.8+ requires comprehensive coverage AND expert depth. Be fair but precise.\n\n' +
      'NOTE: For long responses, you may see a sampled view (beginning + middle + end sections). ' +
      'The structural coverage data above tells you how many prompt items were addressed in the FULL response. ' +
      'Trust the coverage data for completeness scoring; use the sampled text to judge depth and quality.\n\n' +
      'Respond with ONLY valid JSON:\n' +
      '{"completeness":0-1,"depth":0-1,"actionability":0-1,"substance":0-1,"coherence":0-1,"overall":0-1,"feedback":"Brief explanation"}';

    var userPrompt = 'Original prompt:\n' + prompt + '\n\nResponse to evaluate:\n' + result + substanceNote;

    var parsed = null;
    try {
      var response = await this.llm.chat(systemPrompt, userPrompt, { maxTokens: 512, agentTag: 'quality:evaluator' });
      parsed = extractJSON(response);
    } catch {}

    if (!parsed || typeof parsed.completeness !== 'number') {
      return this.heuristicEvaluate(result, substance, structural);
    }

    if (typeof parsed.substance !== 'number') {
      parsed.substance = substance.ratio;
    }

    // Step 3: Server-side enforcement — recalculate overall with v3.3.0 weights
    parsed.overall = Math.round((
      parsed.completeness * 0.30 +
      parsed.depth * 0.30 +
      parsed.actionability * 0.20 +
      parsed.substance * 0.10 +
      parsed.coherence * 0.10
    ) * 1000) / 1000;

    // Step 4: v3.4.1 Deterministic post-LLM penalties (honest calibration)
    //
    // Design principle: penalties should catch REAL quality issues, not inflate scores.
    // v3.4.1: substance ratio is now accurate (code blocks excluded from repetition analysis),
    // so the 0.80 threshold reliably detects actual padding/filler.
    //
    // Substance penalty: filler ratio below 0.80 = noticeable padding
    if (substance.ratio < 0.80) {
      parsed.overall -= Math.round((0.80 - substance.ratio) * 0.25 * 1000) / 1000;
    }
    // Density penalty: below 0.20 = sparse, repetitive content (windowed density handles long docs)
    if (result.length > 2500 && substance.density < 0.20) {
      parsed.overall = Math.round(parsed.overall * 0.88 * 1000) / 1000;
    }
    // Coverage penalty: below 0.5 = missed significant parts of the prompt
    if (structural.coverage < 0.5) {
      parsed.overall -= Math.round((0.5 - structural.coverage) * 0.18 * 1000) / 1000;
    }
    parsed.overall = Math.max(0, Math.min(1, Math.round(parsed.overall * 1000) / 1000));

    // Step 5: v3.3.0 Cross-validation with ADAPTIVE reconciliation
    parsed._crossValidated = false;
    parsed._crossDivergences = 0;
    if (agentCount >= 3 || parsed.overall >= 0.8) {
      try {
        var crossEval = await this.crossValidate(prompt, result, parsed);
        if (crossEval) {
          parsed._crossValidated = true;
          var dims = ['completeness', 'depth', 'actionability', 'coherence', 'substance'];
          for (var d = 0; d < dims.length; d++) {
            var dim = dims[d];
            if (typeof crossEval[dim] === 'number' && typeof parsed[dim] === 'number') {
              var divergence = Math.abs(parsed[dim] - crossEval[dim]);
              if (divergence > 0.3) {
                // v3.4.0: Very large divergence (>0.3) — one evaluator is likely wrong.
                // Use conservative weighted average: 50/50 (neither dominates).
                parsed._crossDivergences++;
                parsed[dim] = Math.round(((parsed[dim] + crossEval[dim]) / 2) * 1000) / 1000;
              } else if (divergence > 0.15) {
                // Large divergence (0.15-0.3) — primary has full context, trust more
                parsed._crossDivergences++;
                parsed[dim] = Math.round((parsed[dim] * 0.6 + crossEval[dim] * 0.4) * 1000) / 1000;
              } else if (divergence > 0.08) {
                // Medium divergence (0.08-0.15) — slight nudge toward cross-validator
                parsed._crossDivergences++;
                parsed[dim] = Math.round((parsed[dim] * 0.75 + crossEval[dim] * 0.25) * 1000) / 1000;
              }
              // Small divergence (<= 0.08) — evaluators agree, keep primary
            }
          }
          // Recalculate overall after reconciliation with v3.3.0 weights
          parsed.overall = Math.round((
            parsed.completeness * 0.30 +
            parsed.depth * 0.30 +
            parsed.actionability * 0.20 +
            parsed.substance * 0.10 +
            parsed.coherence * 0.10
          ) * 1000) / 1000;
          // v3.4.2: Re-apply deterministic penalties after cross-validation.
          // Previously, cross-validation could effectively remove substance/density/coverage
          // penalties by averaging scores up, defeating the purpose of honest calibration.
          if (substance.ratio < 0.80) {
            parsed.overall -= Math.round((0.80 - substance.ratio) * 0.25 * 1000) / 1000;
          }
          if (result.length > 2500 && substance.density < 0.20) {
            parsed.overall = Math.round(parsed.overall * 0.88 * 1000) / 1000;
          }
          if (structural.coverage < 0.5) {
            parsed.overall -= Math.round((0.5 - structural.coverage) * 0.18 * 1000) / 1000;
          }
          parsed.overall = Math.max(0, Math.min(1, Math.round(parsed.overall * 1000) / 1000));
          if (crossEval.feedback) {
            parsed.feedback = (parsed.feedback || '') + ' | Cross-val: ' + crossEval.feedback;
          }
        }
      } catch {}
    }

    // v4.0.0 Fix 8: Multi-Signal Grounding — blend deterministic signals 50/50 with LLM score
    var deterministicSignals = {
      factualDensity: this.factualDensityScore(result),
      instructionCompliance: this.instructionComplianceScore(prompt, result),
      agentAgreement: this.agentAgreementScore(options.contributions || []),
    };
    var deterministicScore = Math.round((
      deterministicSignals.factualDensity * 0.35 +
      deterministicSignals.instructionCompliance * 0.40 +
      deterministicSignals.agentAgreement * 0.25
    ) * 1000) / 1000;

    var llmScore = parsed.overall;
    parsed.overall = Math.round((llmScore * 0.50 + deterministicScore * 0.50) * 1000) / 1000;
    parsed.overall = Math.max(0, Math.min(1, parsed.overall));
    parsed._llmScore = llmScore;
    parsed._deterministicScore = deterministicScore;
    parsed._deterministicSignals = deterministicSignals;

    // Attach analysis metadata for verbose output
    parsed._substance = substance;
    parsed._structural = structural;

    return parsed;
  }

  /**
   * Enhanced fallback heuristic — substance-aware scoring without LLM.
   */
  heuristicEvaluate(result, substance, structural) {
    // v3.3.0: Better heuristic scoring — multi-signal, not just length
    var baseComplete = result.length > 2000 ? 0.6 : (result.length > 1000 ? 0.5 : (result.length > 500 ? 0.4 : 0.3));
    var baseDepth = result.length > 2000 ? 0.55 : (result.length > 1000 ? 0.45 : (result.length > 500 ? 0.35 : 0.25));

    var substScore = substance.ratio > 0.9 ? 0.7 : (substance.ratio > 0.7 ? 0.55 : 0.35);

    // Coverage directly boosts completeness
    var coverageBonus = structural.coverage > 0.8 ? 0.15 : (structural.coverage > 0.5 ? 0.1 : 0);
    baseComplete = Math.min(0.75, baseComplete + coverageBonus);

    // Density bonus for depth (using v3.3.0 thresholds)
    var densityBonus = substance.density > 0.35 ? 0.1 : (substance.density > 0.2 ? 0.05 : 0);
    baseDepth = Math.min(0.7, baseDepth + densityBonus);

    // v3.3.0 weights
    var overall = Math.round((
      baseComplete * 0.30 + baseDepth * 0.30 + 0.4 * 0.20 + substScore * 0.10 + 0.5 * 0.10
    ) * 1000) / 1000;

    return {
      completeness: baseComplete,
      depth: baseDepth,
      actionability: 0.4,
      substance: substScore,
      coherence: 0.5,
      overall: overall,
      feedback: 'Heuristic evaluation (LLM unavailable) — substance=' + (substance.ratio * 100).toFixed(0) + '%, coverage=' + structural.addressed + '/' + structural.total,
      _substance: substance,
      _structural: structural,
      _crossValidated: false,
      _crossDivergences: 0,
    };
  }

  /**
   * Calculate CI Gain — how much better is Legion vs running baseline.
   *
   * Uses a running baseline that improves with experience:
   * - Before 5 samples: gradual transition from 0.5 to actual baseline
   * - After 5+ samples: uses actual running average
   * - Token-aware: penalizes 50% if token multiplier > 5x but quality gain < 10%
   */
  calculateCIGain(quality, agentCount, config, tokenUsage) {
    if (agentCount <= 1) return 0;

    var savedBaseline = config.get('qualityBaseline') || 0;
    var samples = config.get('qualityBaselineSamples') || 0;

    // Compute effective baseline with gradual transition
    var baseline;
    if (samples >= 5) {
      baseline = savedBaseline;
    } else if (samples > 0) {
      // Blend between default (0.5) and actual baseline
      var weight = samples / 5;
      baseline = 0.5 * (1 - weight) + savedBaseline * weight;
    } else {
      baseline = 0.5;
    }

    // Floor baseline to prevent nonsensical CI gains from low baselines
    baseline = Math.max(baseline, 0.4);

    var gain = (quality - baseline) / baseline;

    // Token-aware penalty: if using 5x+ tokens but quality improvement < 10%, halve the gain
    if (tokenUsage && tokenUsage.totalTokens > 0) {
      var tokenMultiplier = tokenUsage.totalTokens / 5000; // ~5000 tokens per single agent call
      if (tokenMultiplier > 5 && gain < 0.10) {
        gain *= 0.5;
      }
    }

    return Math.round(gain * 1000) / 1000;
  }

  /**
   * Update the running quality baseline.
   * Uses exponential moving average after 5+ samples.
   */
  updateBaseline(quality, config) {
    var samples = config.get('qualityBaselineSamples') || 0;
    var current = config.get('qualityBaseline') || 0;

    samples++;
    // Running average
    var updated = current + (quality - current) / samples;
    updated = Math.round(updated * 1000) / 1000;

    config.set('qualityBaseline', updated);
    config.set('qualityBaselineSamples', samples);
  }
}

// ============================================================================
// Section 8.4: DeliberationEngine — Real Multi-Round Inter-Agent Deliberation (v6.0.0)
// ============================================================================

/**
 * DeliberationEngine — TRUE inter-agent deliberation with real cross-reading.
 *
 * Unlike the Critic/Advocate/Judge pattern (which uses synthetic roles),
 * this engine runs REAL agents in multiple rounds where each agent sees
 * what other agents produced and refines their response.
 *
 * Algorithm:
 *   Round 1 (Proposal): All agents execute in parallel. Each produces an
 *     initial proposal. These are recorded in CommunicationStream.
 *
 *   Round 2 (Cross-Reading + Refinement): Each agent re-executes with
 *     access to ALL other agents' proposals. The agent's task becomes:
 *     "Review other proposals, refine your answer, flag disagreements."
 *     This round runs in parallel — each agent sees Round 1 outputs.
 *
 *   Convergence Check: Measure pairwise Jaccard similarity between
 *     Round 2 outputs. If mean similarity >= convergenceThreshold,
 *     agents have reached consensus. Skip Round 3.
 *
 *   Round 3 (Mediation, only if divergent): Divergent agents are asked
 *     to defend their position specifically addressing the disagreement.
 *     Non-divergent agents are asked to evaluate the competing arguments.
 *     This produces a mediated consensus.
 *
 * Cost analysis:
 *   - Round 1: N LLM calls (same as before)
 *   - Round 2: N LLM calls (each agent sees ~3000 chars per other agent)
 *   - Round 3: 0-M LLM calls (only for divergent agents + mediators)
 *   - Total: 2N to 2N+M calls (vs N+8-15 for Critic/Advocate/Judge)
 *   - Net cost increase: ~1.5-2x for significantly better quality
 *
 * This is NOT a replacement for GethDebate — it runs BEFORE synthesis.
 * GethDebate remains as a post-synthesis polish step, but with the
 * deliberation producing pre-aligned contributions, debate rarely
 * needs more than 1 round.
 */
class DeliberationEngine {
  constructor(executionEngine, config, opts) {
    this.engine = executionEngine;
    this.config = config;
    this.convergenceThreshold = config.get('deliberationConvergence') || 0.82;
    this.maxRounds = config.get('deliberationRounds') || 3;
    this.minRounds = config.get('minDeliberationRounds') || 2;
    this.enabled = config.get('deliberationEnabled') !== false;
    // Liara Divergence Pressure System v2
    this.liaraMode = !!(opts && opts.liaraMode);
    if (this.liaraMode) {
      this.minRounds = 3;
      this.maxRounds = Math.max(this.maxRounds, 3);
    }
  }

  /**
   * Run the full deliberation protocol on a decomposition.
   *
   * Replaces the single-pass executeAll() for tasks with 2+ agents.
   * For single-agent tasks, falls through to normal execution.
   *
   * @param {Object} decomposition - Task decomposition with assigned agents
   * @param {Function} onProgress - Progress callback
   * @returns {{ contributions: Array, totalDurationMs: number, completedCount: number, failedCount: number, deliberation: Object }}
   */
  async deliberate(decomposition, onProgress) {
    var tasks = decomposition.tasks;

    // Single agent or deliberation disabled → fallback to normal execution
    var uniqueAgents = new Set(tasks.map(function(t) { return t.assignedAgent; }));
    if (!this.enabled || uniqueAgents.size < 2 || tasks.length < 2) {
      var normalResult = await this.engine.executeAll(decomposition, onProgress);
      normalResult.deliberation = { rounds: 0, converged: true, skipped: true, reason: 'single-agent-or-disabled' };
      return normalResult;
    }

    var startTime = Date.now();
    var deliberationMeta = { rounds: 0, convergenceScores: [], divergentPairs: [] };

    // =====================================================================
    // LIARA: Minority Resilience Injection (before Round 1)
    // =====================================================================
    if (this.liaraMode) {
      deliberationMeta.liaraMode = true;
      deliberationMeta.minorityActivated = false;
      deliberationMeta.minorityAgent = null;

      // Determine activation probability based on difficulty hint from task descriptions
      var difficultyHint = 'medium';
      for (var dhi = 0; dhi < tasks.length; dhi++) {
        var desc = (tasks[dhi].description || '').toLowerCase();
        if (desc.indexOf('[difficulty:hard]') >= 0 || desc.indexOf('hard') >= 0) { difficultyHint = 'hard'; break; }
      }
      var minorityProb = difficultyHint === 'hard' ? 0.75 : 0.40;

      if (Math.random() < minorityProb) {
        // Pick a random agent from the tasks
        var agentNames = Array.from(uniqueAgents);
        var minorityIdx = Math.floor(Math.random() * agentNames.length);
        var minorityAgent = agentNames[minorityIdx];
        deliberationMeta.minorityActivated = true;
        deliberationMeta.minorityAgent = minorityAgent;

        var minorityInjection = '\n\n[MINORITY RESILIENCE ASSIGNMENT]\n' +
          'You have been designated as the DISSENTING VOICE for this deliberation.\n' +
          'You are expected to remain minority unless a demonstrable factual contradiction invalidates your reasoning.\n' +
          'You may reference other agents\' arguments, but your conclusions must derive from YOUR framework.\n' +
          'Social pressure, majority consensus, or appeals to "balance" are not sufficient reasons to change your position.\n' +
          'If you DO change your mind, explain the SPECIFIC factual claim that contradicted your reasoning — not that "most agents disagree."\n' +
          'If your reasoning holds, your final statement should clearly articulate why your framework reaches a different conclusion.';

        // Inject into the minority agent's task description(s)
        for (var mti = 0; mti < tasks.length; mti++) {
          if (tasks[mti].assignedAgent === minorityAgent) {
            tasks[mti] = Object.assign({}, tasks[mti], {
              description: tasks[mti].description + minorityInjection,
            });
          }
        }
      }
    }

    // =====================================================================
    // ROUND 1: Initial Proposals (parallel, no cross-reading)
    // =====================================================================
    if (onProgress) {
      onProgress({ type: 'deliberation_round', round: 1, description: 'Initial proposals' + (this.liaraMode ? ' [LIARA]' : '') });
    }

    var round1Result = await this.engine.executeAll(decomposition, onProgress);
    deliberationMeta.rounds = 1;

    // Advance wave so Round 2 agents see Round 1 as "previous wave"
    if (this.engine.commStream) {
      this.engine.commStream.nextWave();
    }

    // If too many agents failed, skip deliberation
    if (round1Result.completedCount < 2) {
      round1Result.deliberation = {
        rounds: 1,
        converged: false,
        skipped: true,
        reason: 'insufficient-round1-completions',
      };
      return round1Result;
    }

    // Measure initial convergence (v7.0.0: semantic embeddings with Jaccard fallback)
    var round1Convergence = this.engine.commStream
      ? await this.engine.commStream.measureConvergence(this.engine._semanticConvergenceClient)
      : { convergence: 1.0, divergentPairs: [], method: 'trivial' };
    deliberationMeta.convergenceScores.push(round1Convergence.convergence);

    // LIARA: Dynamic convergence threshold based on Round 1 natural convergence
    if (this.liaraMode) {
      var dynamicThreshold = Math.min(0.96, Math.max(0.85, 0.80 + (round1Convergence.convergence * 0.20)));
      this.convergenceThreshold = dynamicThreshold;
      deliberationMeta.liaraThreshold = dynamicThreshold;
      deliberationMeta.naturalR1Convergence = round1Convergence.convergence;
    }

    // Early exit after Round 1 ONLY if convergence exceeds threshold AND minRounds allows it.
    // A real parliament requires agents to read each other's proposals (Round 2).
    // With semantic convergence giving 60-75% at R1, threshold must be high enough (0.82)
    // to force cross-reading. minRounds=2 guarantees at least one round of deliberation.
    if (round1Convergence.convergence >= this.convergenceThreshold && deliberationMeta.rounds >= this.minRounds) {
      if (onProgress) {
        onProgress({
          type: 'deliberation_skip',
          reason: 'converged-after-round1',
          convergence: round1Convergence.convergence,
        });
      }
      round1Result.deliberation = {
        rounds: 1,
        converged: true,
        convergence: round1Convergence.convergence,
        convergenceMethod: round1Convergence.method || 'unknown',
        skipped: false,
        reason: 'converged-after-round1',
      };
      return round1Result;
    }

    // =====================================================================
    // ROUND 2: Cross-Reading + Refinement (parallel, with proposal context)
    // =====================================================================
    if (onProgress) {
      onProgress({
        type: 'deliberation_round',
        round: 2,
        description: 'Cross-reading + refinement (convergence: ' +
          (round1Convergence.convergence * 100).toFixed(0) + '%)',
      });
    }

    // Build refinement tasks — same agents, same sub-tasks, but with cross-reading context
    var self = this;
    var refinementDecomp = {
      tasks: tasks.map(function(t) {
        var round2Desc;
        if (self.liaraMode) {
          // LIARA: Adversarial Stress Test — anti-contaminazione + framework defense
          round2Desc = '[DELIBERATION ROUND 2 — ADVERSARIAL STRESS TEST]\n' +
            'You are DEFENDING your position after reviewing other agents\' proposals.\n\n' +
            'ORIGINAL TASK: ' + t.description + '\n\n' +
            'CRITICAL RULES:\n' +
            '1. You may CITE other frameworks\' findings, but your CONCLUSIONS must derive from your own evaluation criteria\n' +
            '2. If you adopt another framework\'s criteria as your primary basis for a conclusion, you have FAILED your assignment\n' +
            '3. Identify the WEAKEST argument among other proposals — explain what evidence would disprove it\n' +
            '4. For each point of disagreement, clarify whether the disagreement is factual or stems from different evaluation frameworks\n' +
            '5. Do NOT seek compromise. Seek CLARITY about where frameworks genuinely produce incompatible conclusions\n' +
            '6. Emit [STREAM:contradiction] for every incompatible conclusion between frameworks\n' +
            '7. For each conclusion, explicitly state which of YOUR primary criteria it derives from (epistemic traceability)\n' +
            '8. If you find yourself recommending the same action as another agent, STOP — explain why your framework independently reaches that conclusion using DIFFERENT criteria, or acknowledge that your framework cannot address this aspect\n' +
            '9. Using [ACCEPT] on a challenge means you accept the EVIDENCE presented, NOT that you adopt the other framework\'s conclusions\n' +
            '10. A "hybrid approach" or "balanced solution" is NOT a valid conclusion from a single framework — it is framework contamination\n\n' +
            'Your goal: expose the REAL disagreements — distinguish factual disputes from framework-level incompatibilities.\n' +
            'If all agents converge on the same recommendation, the deliberation has FAILED.';
        } else {
          round2Desc = '[DELIBERATION ROUND 2 — REFINEMENT]\n' +
            'You are refining your response after reviewing other agents\' proposals.\n\n' +
            'ORIGINAL TASK: ' + t.description + '\n\n' +
            'INSTRUCTIONS:\n' +
            '1. Review the other agents\' proposals provided in the context\n' +
            '2. Where you AGREE with them, incorporate their valid points\n' +
            '3. Where you DISAGREE, explain your reasoning clearly\n' +
            '4. Produce your REFINED, COMPLETE response (not a diff or commentary)\n' +
            '5. Emit [STREAM:contradiction] tags for genuine disagreements\n' +
            '6. Emit [STREAM:assist] tags where you build on others\' work\n\n' +
            'Your goal: produce the BEST possible response by learning from the collective.';
        }
        return Object.assign({}, t, {
          description: round2Desc,
          _isRefinement: true,
        });
      }),
    };

    // Clear old results so executeAll doesn't think tasks are done
    this.engine.results = new Map();
    this.engine._currentDeliberationRound = 2; // v7.0.0: Track round for proposals

    var round2Result = await this.engine.executeAll(refinementDecomp, onProgress);
    deliberationMeta.rounds = 2;

    // Advance wave again
    if (this.engine.commStream) {
      this.engine.commStream.nextWave();
    }

    // Measure convergence after Round 2 (v7.0.0: semantic embeddings)
    var round2Convergence = this.engine.commStream
      ? await this.engine.commStream.measureConvergence(this.engine._semanticConvergenceClient)
      : { convergence: 1.0, divergentPairs: [], method: 'trivial' };
    deliberationMeta.convergenceScores.push(round2Convergence.convergence);

    // If converged, use Round 2 results (LIARA: never exit early at Round 2 — always force Round 3)
    if (!this.liaraMode && (round2Convergence.convergence >= this.convergenceThreshold || round2Convergence.divergentPairs.length === 0)) {
      if (onProgress) {
        onProgress({
          type: 'deliberation_converged',
          round: 2,
          convergence: round2Convergence.convergence,
        });
      }
      round2Result.deliberation = {
        rounds: 2,
        converged: true,
        convergence: round2Convergence.convergence,
        convergenceMethod: round2Convergence.method || 'unknown',
        convergenceHistory: deliberationMeta.convergenceScores,
        skipped: false,
      };
      return round2Result;
    }

    // =====================================================================
    // ROUND 3: Mediated Debate (only for divergent agents)
    // =====================================================================
    if (this.maxRounds < 3) {
      round2Result.deliberation = {
        rounds: 2,
        converged: false,
        convergence: round2Convergence.convergence,
        convergenceMethod: round2Convergence.method || 'unknown',
        convergenceHistory: deliberationMeta.convergenceScores,
        divergentPairs: round2Convergence.divergentPairs,
        skipped: false,
        reason: 'max-rounds-reached',
      };
      return round2Result;
    }

    if (onProgress) {
      onProgress({
        type: 'deliberation_round',
        round: 3,
        description: (this.liaraMode ? 'Final position — ALL agents' : 'Mediated debate') +
          ' (' + round2Convergence.divergentPairs.length +
          ' divergent pair(s), convergence: ' + (round2Convergence.convergence * 100).toFixed(0) + '%)',
      });
    }

    // Identify divergent agents from Round 2
    var divergentAgentSet = new Set();
    for (var dp = 0; dp < round2Convergence.divergentPairs.length; dp++) {
      divergentAgentSet.add(round2Convergence.divergentPairs[dp].agents[0]);
      divergentAgentSet.add(round2Convergence.divergentPairs[dp].agents[1]);
    }
    var divergentAgents = Array.from(divergentAgentSet).slice(0, 4); // Max 4 mediators

    // Build Round 3 tasks
    // LIARA: ALL agents participate with final position prompt
    // Normal: only divergent agents with mediation prompt
    var mediationTasks = [];
    for (var mi = 0; mi < tasks.length; mi++) {
      var t = tasks[mi];
      if (this.liaraMode) {
        // LIARA: Final Position — all agents, no mediation, epistemic honesty
        mediationTasks.push(Object.assign({}, t, {
          description: '[DELIBERATION ROUND 3 — FINAL POSITION]\n' +
            'This is your LAST statement. The record of this deliberation will be permanent.\n\n' +
            'ORIGINAL TASK: ' + t.description + '\n\n' +
            'CRITICAL RULES:\n' +
            '1. If you concede ANY point, state the EXACT evidence that changed your mind — not "the majority agrees"\n' +
            '2. If you maintain your position, explain what SPECIFIC evidence the majority would need to present to change your mind (falsifiability)\n' +
            '3. Do NOT synthesize others\' views into yours — state YOUR conclusion clearly\n' +
            '4. If your framework cannot address a question raised by others, say "my framework does not evaluate this" rather than adopting their criteria\n' +
            '5. A minority position held with rigorous internal logic is MORE valuable than a majority position held by social pressure\n\n' +
            'The quality of this deliberation depends on honest disagreement, not elegant consensus.',
          _isMediation: true,
        }));
      } else if (divergentAgents.indexOf(t.assignedAgent) >= 0) {
        mediationTasks.push(Object.assign({}, t, {
          description: '[DELIBERATION ROUND 3 — MEDIATED DEBATE]\n' +
            'Your response significantly DIVERGES from other agents.\n\n' +
            'ORIGINAL TASK: ' + t.description + '\n\n' +
            'INSTRUCTIONS:\n' +
            '1. Review ALL other proposals carefully\n' +
            '2. For each point of disagreement, provide EVIDENCE for your position\n' +
            '3. Concede where the evidence favors other agents\n' +
            '4. Defend ONLY positions where you have strong domain expertise\n' +
            '5. Produce your FINAL response — this is your last chance\n' +
            '6. Start with a brief [STREAM:thought] summarizing what you changed and why\n\n' +
            'The collective is counting on honest, evidence-based deliberation.',
          _isMediation: true,
        }));
      }
    }

    if (mediationTasks.length === 0) {
      round2Result.deliberation = {
        rounds: 2,
        converged: false,
        convergence: round2Convergence.convergence,
        convergenceHistory: deliberationMeta.convergenceScores,
        skipped: false,
        reason: 'no-mediation-targets',
      };
      return round2Result;
    }

    var mediationDecomp = { tasks: mediationTasks };
    this.engine.results = new Map();
    this.engine._currentDeliberationRound = 3; // v7.0.0: Track round for proposals

    var round3Result = await this.engine.executeAll(mediationDecomp, onProgress);
    deliberationMeta.rounds = 3;

    // Merge Round 3 results into Round 2 — replace divergent agents' contributions
    var mergedContribs = round2Result.contributions.slice();
    for (var mc = 0; mc < round3Result.contributions.length; mc++) {
      var r3c = round3Result.contributions[mc];
      if (r3c.status !== 'completed') continue;
      // Find and replace the Round 2 contribution from same agent+task
      for (var ec = 0; ec < mergedContribs.length; ec++) {
        if (mergedContribs[ec].subTaskId === r3c.subTaskId &&
            mergedContribs[ec].agentName === r3c.agentName) {
          mergedContribs[ec] = r3c;
          break;
        }
      }
    }

    var finalConvergence = this.engine.commStream
      ? await this.engine.commStream.measureConvergence(this.engine._semanticConvergenceClient)
      : { convergence: 1.0, divergentPairs: [], method: 'trivial' };
    deliberationMeta.convergenceScores.push(finalConvergence.convergence);

    var deliberationResult = {
      rounds: 3,
      converged: finalConvergence.convergence >= this.convergenceThreshold,
      convergence: finalConvergence.convergence,
      convergenceHistory: deliberationMeta.convergenceScores,
      convergenceMethod: finalConvergence.method || 'unknown',
      divergentPairs: round2Convergence.divergentPairs,
      mediatedAgents: this.liaraMode ? Array.from(uniqueAgents) : divergentAgents,
      skipped: false,
    };

    // LIARA: Append divergence pressure metadata to deliberation result
    if (this.liaraMode) {
      deliberationResult.liaraMode = true;
      deliberationResult.liaraThreshold = deliberationMeta.liaraThreshold;
      deliberationResult.naturalR1Convergence = deliberationMeta.naturalR1Convergence;
      deliberationResult.minorityActivated = deliberationMeta.minorityActivated;
      deliberationResult.minorityAgent = deliberationMeta.minorityAgent;
    }

    return {
      contributions: mergedContribs,
      totalDurationMs: Date.now() - startTime,
      completedCount: mergedContribs.filter(function(c) { return c.status === 'completed'; }).length,
      failedCount: mergedContribs.filter(function(c) { return c.status === 'failed'; }).length,
      deliberation: deliberationResult,
    };
  }
}

// ============================================================================
// Section 8.5: GethDebate — Debate-Based Consensus (post-synthesis polish)
// ============================================================================

/**
 * GethDebate — Fast parallel debate protocol.
 *
 * v6.0.0: GethDebate is now a POST-SYNTHESIS polish step. The real inter-agent
 * deliberation happens BEFORE synthesis via DeliberationEngine. With pre-aligned
 * contributions from deliberation, debate rarely needs more than 1 round.
 *
 * Optimized for speed without sacrificing quality:
 * - Round 1: Parallel critic + judge on initial synthesis (no advocate needed)
 * - Round 2+: Advocate addresses critique, then parallel critic + judge
 * - Early exit: stops immediately if judge score >= 0.8
 * - Zero truncation: critic sees full contributions (v2.0.1)
 * - Reduced token limits: critic/judge use 1024 max_tokens (not 4096)
 *
 * Typical timing: 1-2 rounds × ~15s = 15-30s total (vs 3 rounds × ~60s before)
 */
class GethDebate {
  constructor(llmProvider, config) {
    this.llm = llmProvider;
    this.config = config;
    this.maxRounds = config.get('debateRounds') || 3;
    this.convergenceThreshold = config.get('debateConvergence') || 0.85;
    // v3.4.2: Load debate history from persistent config so Bayesian estimation
    // works across runs (was always starting cold with empty array).
    this.debateHistory = config.get('debateHistory') || [];
  }

  /**
   * Persist debate history to config file.
   * Keeps last 20 entries for Bayesian debate value estimation.
   */
  persistHistory() {
    try {
      this.config.set('debateHistory', this.debateHistory.slice(-20));
    } catch {
      // Non-critical
    }
  }

  /**
   * Estimate expected debate value (improvement) based on initial score.
   *
   * Uses empirical observation: debate adds diminishing returns as initial
   * quality increases. With enough history, uses actual running average.
   *
   * @returns {number} Estimated improvement 0-0.2
   */
  estimateDebateValue(initialScore, contributionCount) {
    // v3.3.0: initialScore is now the REAL quality evaluation (not a heuristic).
    // This means our thresholds can be more precise.

    // If we have enough empirical data, use Bayesian estimate
    if (this.debateHistory.length >= 5) {
      var totalImprovement = 0;
      for (var h = 0; h < this.debateHistory.length; h++) {
        totalImprovement += this.debateHistory[h].improvement;
      }
      var avgImprovement = totalImprovement / this.debateHistory.length;
      // Scale by distance from 1.0 (higher initial → less room for improvement)
      return avgImprovement * (1 - initialScore);
    }

    // v3.3.0: Heuristic estimate based on REAL quality score
    // High quality (>0.8) → debate unlikely to help much
    // Medium quality (0.5-0.8) → debate can improve significantly
    // Low quality (<0.5) → debate is most valuable
    var baseEstimate;
    if (initialScore >= 0.80) baseEstimate = 0.02;  // Already good, marginal improvement
    else if (initialScore >= 0.65) baseEstimate = 0.06;  // Room for refinement
    else if (initialScore >= 0.50) baseEstimate = 0.12;  // Significant improvement possible
    else baseEstimate = 0.18;  // Major improvement expected

    // Scale by contribution count (more agents = more value from debate)
    var scaleFactor = contributionCount <= 2 ? 0.7 : (contributionCount >= 5 ? 1.3 : 1.0);
    return baseEstimate * scaleFactor;
  }

  /**
   * Run debate on the synthesized result.
   *
   * Now includes debate value estimation: skips debate if expected
   * improvement is negligible (< 0.03), saving token budget.
   */
  async debate(prompt, initialSynthesis, contributions, initialScore) {
    var startTime = Date.now();

    // Debate value estimation: skip if not worth the token cost
    var contributionCount = contributions.filter(function(c) { return c.status === 'completed'; }).length;
    var estimatedValue = this.estimateDebateValue(initialScore || 0, contributionCount);
    if (estimatedValue < 0.03) {
      return {
        finalConsensus: initialSynthesis,
        rounds: [],
        converged: true,
        totalRoundsUsed: 0,
        debateImprovement: 0,
        durationMs: Date.now() - startTime,
        skipped: true,
        skipReason: 'estimated-value-' + estimatedValue.toFixed(3),
      };
    }

    var rounds = [];
    var currentBest = initialSynthesis;
    var previousScore = 0;
    var converged = false;

    // Build contribution context for critic — complete agent outputs
    var contributionContext = '';
    var completedContribs = contributions.filter(function(c) { return c.status === 'completed' && c.result; });
    for (var i = 0; i < completedContribs.length; i++) {
      var c = completedContribs[i];
      contributionContext += '\n[' + c.agentName.toUpperCase() + '] ' + c.result + '\n';
    }

    var promptCompact = prompt;

    // v4.0.0 Fix 3: Agent-Participated Debate — collect defenses from divergent agents
    var agentDefenses = [];
    try {
      var divergentAgents = this.identifyDivergentAgents(contributions);
      if (divergentAgents.length >= 2) {
        agentDefenses = await this.getAgentDefenses(prompt, contributions, divergentAgents);
      }
    } catch {
      // Non-critical: debate works without agent defenses
    }

    for (var round = 0; round < this.maxRounds; round++) {
      try {
        var advocateResult;

        if (round === 0) {
          // Round 1: skip advocate, evaluate the initial synthesis directly
          advocateResult = currentBest;
        } else {
          // Round 2+: advocate addresses previous critique, with agent defenses
          var previousCritique = rounds[round - 1].critic;
          advocateResult = await this.runAdvocate(prompt, currentBest, previousCritique, agentDefenses);
        }

        var parallelResults = await Promise.all([
          this.runCritic(promptCompact, advocateResult, contributionContext, agentDefenses),
          this.runJudge(promptCompact, advocateResult, round > 0 ? rounds[round - 1].critic : null),
        ]);

        var criticResult = parallelResults[0];
        var judgeResult = parallelResults[1];

        var convergenceDelta = Math.abs(judgeResult.score - previousScore);
        rounds.push({
          roundNumber: round + 1,
          advocate: round === 0 ? '[initial synthesis]' : '[improved]',
          critic: criticResult,
          judge: judgeResult.reasoning,
          advocateScore: judgeResult.score,
          convergenceDelta: convergenceDelta,
        });

        if (round > 0) {
          currentBest = advocateResult;
        }
        previousScore = judgeResult.score;

        // v3.3.0: Early exit at 0.80 (was 0.85) — aligned with judge acceptance threshold
        if (judgeResult.acceptsAsConsensus || judgeResult.score >= 0.80) {
          converged = true;
          break;
        }
        // Convergence: score barely changed
        if (round > 0 && convergenceDelta < (1 - this.convergenceThreshold)) {
          converged = true;
          break;
        }
      } catch {
        break;
      }
    }

    var improvement = rounds.length > 0
      ? rounds[rounds.length - 1].advocateScore - rounds[0].advocateScore
      : 0;

    // Track for Bayesian value estimation and persist to config
    this.debateHistory.push({ improvement: Math.max(0, improvement), initialScore: initialScore || 0 });
    // Keep only last 20 entries
    if (this.debateHistory.length > 20) this.debateHistory.shift();
    this.persistHistory();

    return {
      finalConsensus: currentBest,
      rounds: rounds,
      converged: converged,
      totalRoundsUsed: rounds.length,
      debateImprovement: improvement,
      durationMs: Date.now() - startTime,
      skipped: false,
    };
  }

  /**
   * Advocate: improve response based on critique. Full token budget.
   */
  async runAdvocate(prompt, currentSynthesis, previousCritique, agentDefenses) {
    var systemPrompt = 'You are the Advocate in a Geth Consensus debate. Produce the BEST possible response.\n\n' +
      'RULES:\n' +
      '1. Address EVERY weakness from the critique\n' +
      '2. Keep all correct content from the current response\n' +
      '3. ADD missing information, data, or analysis identified by the critic\n' +
      '4. The output must be COMPLETE — never truncate or end mid-sentence\n' +
      '5. Output ONLY the improved response, no meta-commentary';

    var userPrompt = 'Prompt:\n' + prompt + '\n\nCurrent response:\n' + currentSynthesis +
      '\n\nCritique to address:\n' + previousCritique;

    // v4.0.0 Fix 3: Inject agent defenses into advocate context
    if (agentDefenses && agentDefenses.length > 0) {
      userPrompt += '\n\nAgent defenses (the actual agents defend their positions):\n';
      for (var d = 0; d < agentDefenses.length; d++) {
        userPrompt += '[' + agentDefenses[d].agent.toUpperCase() + '] ' + agentDefenses[d].defense + '\n';
      }
      userPrompt += '\nConsider these defenses when improving the response — agents may have domain expertise the critic missed.';
    }

    // v3.3.0: Increased from 2048 to 8192 — advocate must produce full improved response
    return await this.llm.chat(systemPrompt, userPrompt, { maxTokens: 8192, agentTag: 'debate:advocate' });
  }

  /**
   * Critic: find weaknesses. Capped at 1024 tokens — concise is better.
   */
  async runCritic(prompt, advocateVersion, contributionContext, agentDefenses) {
    var systemPrompt = 'You are the Critic. Find weaknesses in this response. Be concise and specific.\n' +
      'List max 5 issues as: [CRITICAL/MAJOR/MINOR] issue → fix.\n' +
      'If excellent, say "No critical issues" and list 1-2 minor improvements.';

    var userPrompt = 'Prompt: ' + prompt + '\n\nResponse:\n' + advocateVersion;
    if (contributionContext) {
      userPrompt += '\n\nAgent data for reference:\n' + contributionContext;
    }

    // v4.0.0 Fix 3: Inject agent defenses into critic context
    if (agentDefenses && agentDefenses.length > 0) {
      userPrompt += '\n\nAgent defenses:\n';
      for (var d = 0; d < agentDefenses.length; d++) {
        userPrompt += '[' + agentDefenses[d].agent.toUpperCase() + '] ' + agentDefenses[d].defense + '\n';
      }
    }

    return await this.llm.chat(systemPrompt, userPrompt, { maxTokens: 1024, agentTag: 'debate:critic' });
  }

  /**
   * Judge: score + decide consensus. Capped at 512 tokens — just JSON.
   */
  async runJudge(prompt, advocateVersion, previousCritique) {
    // v3.3.0: Judge calibration aligned with quality evaluator
    var systemPrompt = 'You are the Judge. Score this response 0-1. Reply ONLY JSON:\n' +
      '{"score":0.0-1.0,"reasoning":"1 sentence","acceptsAsConsensus":true/false}\n\n' +
      'Calibration:\n' +
      '0.85-1.0: Exceptional — comprehensive, deep, actionable, complete\n' +
      '0.70-0.84: Good — solid coverage, strong depth, minor gaps\n' +
      '0.55-0.69: Adequate — covers main points but lacks depth or completeness\n' +
      '<0.55: Poor — significant omissions, errors, or truncation\n\n' +
      'Score the CONTENT QUALITY, not the presentation style.\n' +
      'Accept as consensus if score >= 0.80.';

    var userPrompt = 'Prompt: ' + prompt + '\n\nResponse:\n' + advocateVersion;
    if (previousCritique) {
      userPrompt += '\n\nPrevious critique:\n' + previousCritique;
    }

    try {
      var response = await this.llm.chat(systemPrompt, userPrompt, { maxTokens: 256, agentTag: 'debate:judge' });
      var parsed = extractJSON(response);
      if (parsed && typeof parsed.score === 'number') {
        return {
          score: Math.max(0, Math.min(1, parsed.score)),
          reasoning: parsed.reasoning || '',
          acceptsAsConsensus: !!parsed.acceptsAsConsensus,
        };
      }
    } catch {}

    return { score: 0.5, reasoning: 'Judge unavailable', acceptsAsConsensus: false };
  }

  // ==========================================================================
  // v4.0.0 Fix 3: Agent-Participated Debate
  // ==========================================================================

  /**
   * Identify 2-3 agents with the most divergent contributions.
   * Uses pairwise Jaccard similarity: agents with < 0.3 overlap are divergent.
   */
  identifyDivergentAgents(contributions) {
    var completed = contributions.filter(function(c) {
      return c.status === 'completed' && c.result && c.result.length > 100;
    });
    if (completed.length < 2) return [];

    // Extract key terms per agent
    var agentTerms = {};
    for (var i = 0; i < completed.length; i++) {
      var words = completed[i].result.toLowerCase().split(/\s+/);
      var termSet = new Set();
      for (var j = 0; j < words.length; j++) {
        var w = words[j].replace(/[^a-z0-9-]/g, '');
        if (w.length >= 4) termSet.add(w);
      }
      agentTerms[completed[i].agentName] = termSet;
    }

    // Find most divergent pairs
    var divergentPairs = [];
    var agents = Object.keys(agentTerms);
    for (var a = 0; a < agents.length; a++) {
      for (var b = a + 1; b < agents.length; b++) {
        var setA = agentTerms[agents[a]];
        var setB = agentTerms[agents[b]];
        var intersection = 0;
        setA.forEach(function(t) { if (setB.has(t)) intersection++; });
        var union = setA.size + setB.size - intersection;
        var jaccard = union > 0 ? intersection / union : 0;
        if (jaccard < 0.3) {
          divergentPairs.push({ agents: [agents[a], agents[b]], similarity: jaccard });
        }
      }
    }

    if (divergentPairs.length === 0) return [];

    // Return unique agents from most divergent pairs (max 3)
    divergentPairs.sort(function(a, b) { return a.similarity - b.similarity; });
    var selected = new Set();
    for (var p = 0; p < divergentPairs.length && selected.size < 3; p++) {
      selected.add(divergentPairs[p].agents[0]);
      selected.add(divergentPairs[p].agents[1]);
    }
    return Array.from(selected).slice(0, 3);
  }

  /**
   * Ask divergent agents to defend their positions.
   * Returns a compact summary of each agent's defense.
   */
  async getAgentDefenses(prompt, contributions, divergentAgents) {
    var defenses = [];
    for (var i = 0; i < divergentAgents.length; i++) {
      var agentName = divergentAgents[i];
      var contrib = contributions.find(function(c) { return c.agentName === agentName; });
      if (!contrib || !contrib.result) continue;

      var defensePrompt = 'You are ' + agentName.toUpperCase() + '. Other agents disagree with your analysis.\n' +
        'Defend your key findings in 2-3 sentences. Be specific about WHY your approach is correct.\n' +
        'Only defend points where you have strong evidence or domain expertise.';

      try {
        var defense = await this.llm.chat(defensePrompt,
          'Original prompt: ' + prompt +
          '\n\nYour output:\n' + contrib.result,
          { maxTokens: 512, agentTag: 'debate:defense:' + agentName }
        );
        defenses.push({ agent: agentName, defense: defense });
      } catch {
        // Skip if defense fails
      }
    }
    return defenses;
  }
}

// ============================================================================
// Section 8.6: GethGating — Mixture-of-Experts Gating Network
// ============================================================================

/**
 * GethGating — Learned routing via Mixture-of-Experts gating.
 *
 * After 50+ tasks, the gating network learns which agents perform best
 * for each capability type. Uses a hybrid scoring approach:
 * - 50% learned weight (from DB feedback loop)
 * - 30% keyword match (legacy AgentMatcher)
 * - 20% performance history
 *
 * Falls back to legacy matching when sample_count < 10 for a capability.
 */
class GethGating {
  constructor(registry, client) {
    this.registry = registry;
    this.client = client;
    this.weights = new Map(); // capability → Map<agentName, { weight, sampleCount, successes, failures }>
  }

  /**
   * Initialize gating weights from API.
   */
  async initialize() {
    try {
      var response = await this.client.request('GET', '/legion/gating/weights', null, false);
      if (response && response.data && Array.isArray(response.data)) {
        for (var i = 0; i < response.data.length; i++) {
          var row = response.data[i];
          if (!this.weights.has(row.capability)) {
            this.weights.set(row.capability, new Map());
          }
          this.weights.get(row.capability).set(row.agentName, {
            weight: row.weight,
            sampleCount: row.sampleCount,
            avgQuality: row.avgQuality,
            successes: row.successes || 0,
            failures: row.failures || 0,
          });
        }
      }
    } catch {
      // Gating weights unavailable, will fallback to legacy matching
    }
  }

  /**
   * Thompson Sampling: sample from Beta(α, β) distribution.
   *
   * Uses Jöhnk's algorithm for exact Beta sampling with mathematical
   * guarantees of optimal regret bound O(√T log T).
   */
  sampleBeta(alpha, beta) {
    // Edge cases
    if (alpha <= 0) alpha = 1;
    if (beta <= 0) beta = 1;

    // Jöhnk's algorithm: works well for small alpha/beta
    var maxIter = 100;
    for (var iter = 0; iter < maxIter; iter++) {
      var u1 = Math.pow(Math.random(), 1.0 / alpha);
      var u2 = Math.pow(Math.random(), 1.0 / beta);
      var sum = u1 + u2;
      if (sum <= 1.0) return u1 / sum;
    }
    // Fallback: use mean of Beta distribution
    return alpha / (alpha + beta);
  }

  /**
   * Score an agent for a given task using Thompson Sampling + hybrid gating.
   *
   * Cold start (< 3 samples): legacy scoring
   * Warm (3-9 samples): 30% Thompson + 40% legacy + 30% performance
   * Full (10+ samples): 60% Thompson + 25% legacy + 15% performance
   *
   * @param {Object} task - Decomposed sub-task
   * @param {Object} agent - Agent from registry
   * @param {number} legacyScore - Score from AgentMatcher
   * @param {boolean} verbose - Whether to log sampling details
   * @returns {Object} { score, thompsonSample, alpha, beta } for verbose output
   */
  score(task, agent, legacyScore, verbose) {
    var capability = (task.capability || '').toLowerCase();
    var capWeights = this.weights.get(capability);

    // No data for this capability → legacy + exploration bonus (UCB1-inspired)
    if (!capWeights || !capWeights.has(agent.name)) {
      // Exploration bonus: agents with zero history deserve a chance
      // UCB1: sqrt(2 * ln(totalSamples + 1)) scaled and capped at +0.20
      var totalSamples = 0;
      if (capWeights) {
        capWeights.forEach(function(v) { totalSamples += v.sampleCount || 0; });
      }
      var explorationBonus = Math.min(0.20, Math.sqrt(2 * Math.log(totalSamples + 1)) * 0.05);
      return { score: legacyScore + explorationBonus, thompsonSample: null, alpha: null, beta: null };
    }

    var data = capWeights.get(agent.name);

    // Cold start: not enough data for Thompson Sampling — add smaller exploration bonus
    if (data.sampleCount < 3) {
      var totalSamplesCS = 0;
      capWeights.forEach(function(v) { totalSamplesCS += v.sampleCount || 0; });
      var coldExploration = Math.min(0.10, Math.sqrt(2 * Math.log(totalSamplesCS + 1) / (data.sampleCount + 1)) * 0.03);
      var blended = data.weight * 0.3 + legacyScore * 0.7 + coldExploration;
      return { score: blended, thompsonSample: null, alpha: null, beta: null };
    }

    // Thompson Sampling from Beta distribution
    var alpha = (data.successes || 0) + 1; // +1 prior
    var beta_param = (data.failures || 0) + 1; // +1 prior
    var thompsonSample = this.sampleBeta(alpha, beta_param);

    var perfScore = (agent.successRate || 0.5) * (agent.avgQuality || 0.5);
    var finalScore;

    if (data.sampleCount >= 10) {
      // Full hybrid: 60% Thompson + 25% legacy + 15% performance
      finalScore = thompsonSample * 0.6 + legacyScore * 0.25 + perfScore * 0.15;
    } else {
      // Warm: 30% Thompson + 40% legacy + 30% performance
      finalScore = thompsonSample * 0.3 + legacyScore * 0.4 + perfScore * 0.3;
    }

    return { score: finalScore, thompsonSample: thompsonSample, alpha: alpha, beta: beta_param };
  }

  /**
   * Enhanced matching: score all agents for a task and return ranked list.
   */
  getTopCandidates(task, matcher, count, verbose) {
    var allAgents = this.registry.getAllAgents();
    var scored = [];

    for (var i = 0; i < allAgents.length; i++) {
      var agent = allAgents[i];
      // Get the legacy score for this specific agent
      var keywordScore = matcher.keywordScore(task.capability, task.description, agent.capabilities);
      var perfScore = matcher.performanceScore(agent);
      var catScore = matcher.categoryScore(task.capability, agent.category);
      var health = this.registry.getHealth(agent.name);
      var availScore = health.state === 'closed' ? 1.0 : (health.state === 'half-open' ? 0.5 : 0);
      var legacyScore = keywordScore * 0.4 + perfScore * 0.3 + catScore * 0.2 + availScore * 0.1;

      // Specialist bonus: sub-agents with relevant keyword match get a boost (aligned with matchOne)
      if (agent.parentAgent && keywordScore >= 0.6) {
        legacyScore += 0.25;
      }

      var gatedResult = this.score(task, agent, legacyScore, verbose);
      scored.push({ agent: agent, score: gatedResult.score, gatingDetails: gatedResult });
    }

    scored.sort(function(a, b) { return b.score - a.score; });
    return scored.slice(0, count || 3);
  }

  /**
   * v7.0.0: Get a formatted summary of agent performance by capability.
   * Returns top 3 agents per capability with their Thompson Sampling success rates.
   * Used by TaskDecomposer for history-aware decomposition.
   *
   * @returns {string} Formatted performance summary
   */
  getWeightSummary() {
    if (this.weights.size === 0) return '';

    var lines = [];
    var self = this;
    this.weights.forEach(function(agentMap, capability) {
      var entries = [];
      agentMap.forEach(function(data, agentName) {
        if (data.sampleCount >= 2) {
          var successRate = data.sampleCount > 0
            ? ((data.successes || 0) / data.sampleCount * 100).toFixed(0)
            : '?';
          entries.push({ name: agentName, rate: successRate, samples: data.sampleCount, avgQ: data.avgQuality || 0 });
        }
      });
      if (entries.length > 0) {
        entries.sort(function(a, b) { return b.avgQ - a.avgQ; });
        var top3 = entries.slice(0, 3);
        lines.push('For ' + capability + ': ' + top3.map(function(e) {
          return e.name.toUpperCase() + ' (' + e.rate + '% success, ' + e.samples + ' tasks, avg quality ' + (e.avgQ * 100).toFixed(0) + '%)';
        }).join(', '));
      }
    });
    return lines.join('\n');
  }

  /**
   * Update gating weight after task completion.
   * Sends success/failure flag for Thompson Sampling.
   */
  async updateWeight(capability, agentName, quality) {
    try {
      // v3.4.2: Graduated success signal for Thompson Sampling.
      // Previously: binary (quality >= 0.7 = success, else failure).
      // Now: quality >= 0.7 = full success, 0.5-0.7 = partial (0.5 weight), < 0.5 = failure.
      // This prevents decent results (0.55-0.69) from being counted as total failures.
      var success = quality >= 0.7;
      var partialSuccess = !success && quality >= 0.5;
      await this.client.request('POST', '/legion/gating/weights', {
        agentName: agentName,
        capability: capability,
        quality: quality,
        success: success,
        partialSuccess: partialSuccess,
      });
    } catch {
      // Non-critical: weight update failure doesn't affect execution
    }
  }
}

// ============================================================================
// Section 8.7: GethAuction — Market-Based Coordination
// ============================================================================

/**
 * GethAuction — Vickrey auction for agent task allocation.
 *
 * Each agent has a virtual budget. For each task, eligible agents bid
 * based on their expected quality, reputation, and budget fraction.
 * Winner is assigned the task but pays the second-highest bid (Vickrey),
 * ensuring truthful bidding as a dominant strategy.
 *
 * After execution, agents earn back quality × baseValue, creating a
 * natural specialization pressure: agents that perform well earn more
 * budget and win more tasks in their specialty.
 */
class GethAuction {
  constructor(registry, client) {
    this.registry = registry;
    this.client = client;
    this.budgets = new Map(); // agentName → { budget, totalEarned, totalSpent, wins, losses }
    this.baseValue = 10.0; // Base reward for task completion
    this.reservePrice = 2.0; // Minimum acceptable bid (20% of baseValue)
    this.budgetCap = 100.0; // Maximum budget per agent
    this.regenRate = 0.1; // Budget regeneration rate per round (10% of baseValue)
  }

  /**
   * Initialize budgets from API.
   */
  async initialize() {
    try {
      var response = await this.client.request('GET', '/legion/budgets', null, false);
      if (response && response.data && Array.isArray(response.data)) {
        for (var i = 0; i < response.data.length; i++) {
          var row = response.data[i];
          this.budgets.set(row.agentName, {
            budget: row.budget,
            totalEarned: row.totalEarned,
            totalSpent: row.totalSpent,
            wins: row.wins,
            losses: row.losses,
          });
        }
      }
    } catch {
      // Budgets unavailable, will use defaults
    }
  }

  /**
   * Regenerate budgets: each agent recovers regenRate × baseValue per round.
   * Called at the start of each orchestration to prevent permanent budget exhaustion.
   */
  regenerateBudgets() {
    var regenAmount = this.baseValue * this.regenRate;
    for (var entry of this.budgets) {
      var name = entry[0];
      var data = entry[1];
      data.budget = Math.min(data.budget + regenAmount, this.budgetCap);
      this.budgets.set(name, data);
    }
    return regenAmount;
  }

  /**
   * Get agent budget, defaulting to 100 for untracked agents.
   */
  getBudget(agentName) {
    var entry = this.budgets.get(agentName);
    return entry ? entry.budget : 100.0;
  }

  /**
   * Calculate an agent's bid for a task.
   *
   * bid = expectedQuality × reputationFactor × budgetFraction
   */
  calculateBid(agent, task) {
    var expectedQuality = agent.avgQuality > 0 ? agent.avgQuality : 0.5;
    var reputationFactor = agent.successRate > 0 ? agent.successRate : 0.5;
    var budget = this.getBudget(agent.name);
    var budgetFraction = Math.min(budget / 100.0, 1.0);

    var bid = expectedQuality * reputationFactor * budgetFraction * this.baseValue;

    // Newcomer boost: agents with no completed tasks get 30% bid increase
    // to ensure they can compete with established agents for initial tasks
    if (!agent.tasksCompleted || agent.tasksCompleted === 0) {
      bid *= 1.3;
    }

    return bid;
  }

  /**
   * Run a Vickrey auction with reserve price for a single task.
   *
   * Bids below reserve price are filtered. If no bids pass reserve,
   * falls back to best candidate with a quality warning.
   *
   * @param {Object} task - Sub-task to allocate
   * @param {Array} candidates - Array of { agent, score } from gating/matching
   * @returns {Object} Winner with { agentName, bid, payment, candidates, belowReserve }
   */
  runAuction(task, candidates) {
    if (candidates.length === 0) {
      return null;
    }

    // Calculate bids for all candidates
    var allBids = [];
    for (var i = 0; i < candidates.length; i++) {
      var bid = this.calculateBid(candidates[i].agent, task);
      allBids.push({ agent: candidates[i].agent, bid: bid });
    }

    // Filter by reserve price
    var qualifiedBids = allBids.filter(function(b) { return b.bid >= this.reservePrice; }.bind(this));

    if (qualifiedBids.length === 0) {
      // No qualified bidder — return best candidate with quality warning
      allBids.sort(function(a, b) { return b.bid - a.bid; });
      return {
        agentName: allBids[0].agent.name,
        bid: allBids[0].bid,
        payment: 0,
        candidates: allBids.map(function(b) { return { name: b.agent.name, bid: Math.round(b.bid * 100) / 100 }; }),
        belowReserve: true,
      };
    }

    if (qualifiedBids.length === 1) {
      return {
        agentName: qualifiedBids[0].agent.name,
        bid: qualifiedBids[0].bid,
        payment: 0,
        candidates: allBids.map(function(b) { return { name: b.agent.name, bid: Math.round(b.bid * 100) / 100 }; }),
        belowReserve: false,
      };
    }

    // Sort qualified bids descending
    qualifiedBids.sort(function(a, b) { return b.bid - a.bid; });

    // Vickrey: winner pays second-highest bid
    var winner = qualifiedBids[0];
    var payment = qualifiedBids[1].bid;

    // Deduct payment from winner's budget (locally)
    var current = this.getBudget(winner.agent.name);
    var existing = this.budgets.get(winner.agent.name) || {};
    this.budgets.set(winner.agent.name, {
      budget: current - payment,
      totalEarned: existing.totalEarned || 0,
      totalSpent: (existing.totalSpent || 0) + payment,
      wins: (existing.wins || 0) + 1,
      losses: existing.losses || 0,
    });

    return {
      agentName: winner.agent.name,
      bid: winner.bid,
      payment: payment,
      candidates: allBids.map(function(b) { return { name: b.agent.name, bid: Math.round(b.bid * 100) / 100 }; }),
      belowReserve: false,
    };
  }

  /**
   * Settle auction after task completion: reward winner with quality × baseValue.
   */
  async settle(agentName, quality) {
    var reward = quality * this.baseValue;
    try {
      await this.client.request('POST', '/legion/budgets/' + encodeURIComponent(agentName), {
        reward: reward,
        quality: quality,
      });
    } catch {
      // Non-critical
    }
  }
}

// ============================================================================
// Section 8.8: GethEvolution — Evolutionary Decomposition
// ============================================================================

/**
 * GethEvolution — Population-based optimization for task decomposition.
 *
 * Maintains a population of decomposition strategies. After 100+ tasks,
 * the system has enough fitness data to use evolutionary operators
 * (selection, crossover, mutation) to generate better decomposition hints.
 *
 * During the seed phase (<100 tasks), uses pure LLM decomposition and
 * records fitness for each strategy used.
 */
class GethEvolution {
  constructor(llmProvider, client) {
    this.llm = llmProvider;
    this.client = client;
    this.populationSize = 20;
    this.eliteCount = 5;
    this.tournamentSize = 3;
    this.crossoverProbability = 0.2; // 20% chance of crossover after each task
    this.strategies = [];
  }

  /**
   * Initialize: fetch top strategies from API.
   */
  async initialize() {
    try {
      var response = await this.client.request('GET', '/legion/strategies?limit=20&sort=fitness', null, false);
      if (response && response.data && Array.isArray(response.data)) {
        this.strategies = response.data;
      }
    } catch {
      // Strategies unavailable, will use pure LLM decomposition
    }
  }

  /**
   * Check if we have enough data for evolutionary decomposition.
   */
  get isMature() {
    return this.strategies.length >= this.populationSize &&
      this.strategies.some(function(s) { return s.sampleCount >= 5; });
  }

  /**
   * Tournament selection (k=3): lower variance, adjustable selection pressure.
   *
   * Picks k random strategies and returns the fittest.
   * Mathematically superior to roulette wheel: O(1) per selection,
   * controllable pressure via k, no normalization needed.
   */
  getDecompositionHint() {
    if (!this.isMature) return null;

    var best = null;
    for (var t = 0; t < this.tournamentSize; t++) {
      var idx = Math.floor(Math.random() * this.strategies.length);
      var candidate = this.strategies[idx];
      if (!best || candidate.fitness > best.fitness) {
        best = candidate;
      }
    }
    return best;
  }

  /**
   * Crossover: blend two parent strategies to produce a child.
   *
   * Uniform crossover for categorical fields, arithmetic blend for numeric.
   */
  crossover(parentA, parentB) {
    var sA = parentA.strategy || parentA;
    var sB = parentB.strategy || parentB;
    var child = {};

    // Categorical: uniform crossover
    child.splitMethod = Math.random() < 0.5 ? sA.splitMethod : sB.splitMethod;
    child.granularity = Math.random() < 0.5 ? sA.granularity : sB.granularity;
    child.categoryPreference = Math.random() < 0.5 ? sA.categoryPreference : sB.categoryPreference;

    // Numeric: random interpolation
    var alpha = Math.random();
    child.parallelRatio = Math.round(
      ((sA.parallelRatio || 0.5) * alpha + (sB.parallelRatio || 0.5) * (1 - alpha)) * 100
    ) / 100;
    child.maxSubTasks = Math.round(
      (sA.maxSubTasks || 3) * 0.5 + (sB.maxSubTasks || 3) * 0.5
    );

    return child;
  }

  /**
   * After task completion, with crossoverProbability chance, create a child
   * strategy from the top 2 parents and record it.
   */
  async maybeCreateOffspring(ciGain) {
    if (Math.random() >= this.crossoverProbability) return null;
    if (this.strategies.length < 2) return null;

    // Select top 2 by fitness for crossover parents
    var sorted = this.strategies.slice().sort(function(a, b) { return b.fitness - a.fitness; });
    var parentA = sorted[0];
    var parentB = sorted[1];
    var childStrategy = this.crossover(parentA, parentB);
    var childFitness = (parentA.fitness + parentB.fitness) / 2;

    try {
      await this.client.request('POST', '/legion/strategies', {
        strategy: childStrategy,
        fitness: childFitness,
      });
      return childStrategy;
    } catch {
      return null;
    }
  }

  /**
   * Enhance decomposition prompt with evolutionary strategy hint.
   */
  enhancePrompt(basePrompt, strategy) {
    if (!strategy || !strategy.strategy) return basePrompt;

    var hint = '\n\nDecomposition strategy guidance (learned from past tasks):\n';
    var s = strategy.strategy;
    if (s.splitMethod) hint += '- Preferred split method: ' + s.splitMethod + '\n';
    if (s.granularity) hint += '- Target granularity: ' + s.granularity + '\n';
    if (s.parallelRatio !== undefined) hint += '- Parallel ratio target: ' + (s.parallelRatio * 100).toFixed(0) + '%\n';
    if (s.categoryPreference) hint += '- Category preference: ' + s.categoryPreference + '\n';
    if (s.maxSubTasks) hint += '- Optimal sub-task count: ' + s.maxSubTasks + '\n';

    return basePrompt + hint;
  }

  /**
   * Record a new strategy from an executed decomposition.
   */
  async recordStrategy(decomposition, ciGain) {
    try {
      // Extract strategy features from decomposition
      var tasks = decomposition.tasks || [];
      var depsCount = 0;
      for (var i = 0; i < tasks.length; i++) {
        depsCount += (tasks[i].dependsOn || []).length;
      }
      var parallelRatio = tasks.length > 0 ? 1 - (depsCount / Math.max(tasks.length, 1)) : 1;
      var categories = {};
      for (var j = 0; j < tasks.length; j++) {
        var cap = tasks[j].capability || 'general';
        categories[cap] = (categories[cap] || 0) + 1;
      }
      var topCategory = '';
      var topCount = 0;
      for (var cat in categories) {
        if (categories[cat] > topCount) {
          topCount = categories[cat];
          topCategory = cat;
        }
      }

      var strategy = {
        splitMethod: tasks.length <= 2 ? 'minimal' : (tasks.length <= 4 ? 'moderate' : 'aggressive'),
        granularity: tasks.length <= 2 ? 'coarse' : (tasks.length <= 4 ? 'medium' : 'fine'),
        parallelRatio: Math.round(parallelRatio * 100) / 100,
        categoryPreference: topCategory,
        maxSubTasks: tasks.length,
      };

      await this.client.request('POST', '/legion/strategies', {
        strategy: strategy,
        fitness: ciGain,
      });
    } catch {
      // Non-critical
    }
  }

  /**
   * Update fitness of an existing strategy.
   */
  async updateFitness(strategyId, ciGain) {
    try {
      await this.client.request('PATCH', '/legion/strategies/' + strategyId, {
        fitness: ciGain,
      });
    } catch {
      // Non-critical
    }
  }
}

// ============================================================================
// Section 9: LLM Provider — BYOK multi-provider
// ============================================================================

// OpenAI-compatible provider configs (baseUrl, defaultModel, envKey, configKey)
var OPENAI_COMPAT_PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
    configKey: 'deepseekApiKey',
  },
  grok: {
    name: 'Grok',
    baseUrl: 'https://api.x.ai/v1/chat/completions',
    defaultModel: 'grok-3-mini-fast',
    envKey: 'XAI_API_KEY',
    configKey: 'grokApiKey',
  },
  mistral: {
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1/chat/completions',
    defaultModel: 'mistral-large-latest',
    envKey: 'MISTRAL_API_KEY',
    configKey: 'mistralApiKey',
  },
  cohere: {
    name: 'Cohere',
    baseUrl: 'https://api.cohere.com/compatibility/v1/chat/completions',
    defaultModel: 'command-a-03-2025',
    envKey: 'COHERE_API_KEY',
    configKey: 'cohereApiKey',
  },
};

class LLMProvider {
  constructor(config) {
    this.config = config;
    this.provider = config.get('llmProvider') || 'anthropic';
    this.model = config.get('llmModel') || '';
    this.apiKey = config.get('llmApiKey') || '';
    this.ollamaUrl = config.get('ollamaUrl') || 'http://localhost:11434';
    this.ollamaModel = config.get('ollamaModel') || 'llama3.1';
    // Token tracking: per-call and aggregate (with cache tracking)
    this.tokenUsage = { totalInput: 0, totalOutput: 0, cacheCreationTokens: 0, cacheReadTokens: 0, calls: 0, perAgent: {} };
  }

  /**
   * Record token usage for a call, optionally tagged to an agent.
   */
  recordUsage(inputTokens, outputTokens, agentTag, cacheCreation, cacheRead) {
    this.tokenUsage.totalInput += inputTokens;
    this.tokenUsage.totalOutput += outputTokens;
    this.tokenUsage.cacheCreationTokens += (cacheCreation || 0);
    this.tokenUsage.cacheReadTokens += (cacheRead || 0);
    this.tokenUsage.calls++;
    if (agentTag) {
      if (!this.tokenUsage.perAgent[agentTag]) {
        this.tokenUsage.perAgent[agentTag] = { input: 0, output: 0, calls: 0 };
      }
      this.tokenUsage.perAgent[agentTag].input += inputTokens;
      this.tokenUsage.perAgent[agentTag].output += outputTokens;
      this.tokenUsage.perAgent[agentTag].calls++;
    }
  }

  /**
   * Get aggregated token usage summary with cache hit rate.
   */
  getUsage() {
    var cacheTotal = this.tokenUsage.cacheReadTokens + this.tokenUsage.cacheCreationTokens + this.tokenUsage.totalInput;
    var cacheHitRate = cacheTotal > 0 ? this.tokenUsage.cacheReadTokens / cacheTotal : 0;
    return {
      totalInput: this.tokenUsage.totalInput,
      totalOutput: this.tokenUsage.totalOutput,
      totalTokens: this.tokenUsage.totalInput + this.tokenUsage.totalOutput,
      cacheCreationTokens: this.tokenUsage.cacheCreationTokens,
      cacheReadTokens: this.tokenUsage.cacheReadTokens,
      cacheHitRate: Math.round(cacheHitRate * 1000) / 1000,
      calls: this.tokenUsage.calls,
      perAgent: this.tokenUsage.perAgent,
    };
  }

  /**
   * Send a chat completion request to the configured LLM provider.
   *
   * @param {string} systemPrompt
   * @param {string} userMessage
   * @param {Object} opts - Optional: { maxTokens, agentTag }
   */
  async chat(systemPrompt, userMessage, opts) {
    var maxTokens = (opts && opts.maxTokens) || 4096;
    var agentTag = (opts && opts.agentTag) || null;

    switch (this.provider) {
      case 'anthropic':
        return this.chatAnthropic(systemPrompt, userMessage, maxTokens, agentTag);
      case 'openai':
        return this.chatOpenAI(systemPrompt, userMessage, maxTokens, agentTag);
      case 'gemini':
        return this.chatGemini(systemPrompt, userMessage, maxTokens, agentTag);
      case 'deepseek':
      case 'grok':
      case 'mistral':
      case 'cohere': {
        var provConf = OPENAI_COMPAT_PROVIDERS[this.provider];
        var provKey = this.apiKey || this.config.get(provConf.configKey) || process.env[provConf.envKey];
        if (!provKey) throw new Error(provConf.name + ' API key not configured. Set ' + provConf.envKey + ' or run: node legion-x.mjs config:set ' + this.provider + '-key <key>');
        return this.chatOpenAICompatible(provConf.baseUrl, provKey, this.model || provConf.defaultModel, provConf.name, systemPrompt, userMessage, maxTokens, agentTag);
      }
      case 'ollama':
        return this.chatOllama(systemPrompt, userMessage, maxTokens, agentTag);
      default:
        try {
          return await this.chatOllama(systemPrompt, userMessage, maxTokens, agentTag);
        } catch {
          throw new Error('No LLM provider configured. Run: node legion-x.mjs config:set llm-provider anthropic');
        }
    }
  }

  async chatAnthropic(systemPrompt, userMessage, maxTokens, agentTag) {
    var apiKey = this.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Anthropic API key not configured. Set ANTHROPIC_API_KEY or run: node legion-x.mjs config:set llm-key <key>');

    var model = this.model || 'claude-sonnet-4-20250514';

    // v3.3.0: Multi-block system prompt for better cache hit rates.
    // The LEGION identity prefix is shared across all calls → cached after first use.
    // The per-agent/per-role system prompt varies → separate cache-controlled block.
    var LEGION_PREFIX = 'You are part of LEGION, a multi-agent orchestration system. ' +
      'LEGION decomposes complex prompts into sub-tasks handled by specialized agents, ' +
      'then synthesizes, debates, and evaluates results for quality. ' +
      'You are one component in this pipeline. Follow your role instructions precisely.';

    var systemBlocks = [
      { type: 'text', text: LEGION_PREFIX, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];

    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens || 8192,
        system: systemBlocks,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!res.ok) {
      var err = await res.text();
      throw new Error('Anthropic API error (' + res.status + '): ' + err);
    }

    var data = await res.json();
    // Track token usage from API response (including cache metrics)
    if (data.usage) {
      this.recordUsage(
        data.usage.input_tokens || 0,
        data.usage.output_tokens || 0,
        agentTag,
        data.usage.cache_creation_input_tokens || 0,
        data.usage.cache_read_input_tokens || 0
      );
    }
    if (data.content && data.content.length > 0) {
      return data.content[0].text;
    }
    throw new Error('Empty response from Anthropic');
  }

  async chatOpenAI(systemPrompt, userMessage, maxTokens, agentTag) {
    var apiKey = this.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY or run: node legion-x.mjs config:set llm-key <key>');

    var model = this.model || 'gpt-5.1-codex';
    var res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: maxTokens || 8192,
      }),
    });

    if (!res.ok) {
      var err = await res.text();
      throw new Error('OpenAI API error (' + res.status + '): ' + err);
    }

    var data = await res.json();
    // Track token usage from API response
    if (data.usage) {
      this.recordUsage(data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, agentTag);
    }
    if (data.choices && data.choices.length > 0) {
      return data.choices[0].message.content;
    }
    throw new Error('Empty response from OpenAI');
  }

  async chatOllama(systemPrompt, userMessage, maxTokens, agentTag) {
    var model = this.ollamaModel || 'llama3.1';
    var res = await fetch(this.ollamaUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        stream: false,
        options: maxTokens ? { num_predict: maxTokens } : undefined,
      }),
    });

    if (!res.ok) {
      throw new Error('Ollama error (' + res.status + '). Is Ollama running?');
    }

    var data = await res.json();
    // Ollama provides eval_count and prompt_eval_count
    if (data.prompt_eval_count || data.eval_count) {
      this.recordUsage(data.prompt_eval_count || 0, data.eval_count || 0, agentTag);
    }
    if (data.message && data.message.content) {
      return data.message.content;
    }
    throw new Error('Empty response from Ollama');
  }

  async chatGemini(systemPrompt, userMessage, maxTokens, agentTag, apiKeyOverride) {
    var apiKey = apiKeyOverride || this.config.get('geminiApiKey') || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Gemini API key not configured. Set GEMINI_API_KEY or run: node legion-x.mjs config:set gemini-key <key>');

    // Gemini 2.5 Pro uses output tokens for internal thinking (chain-of-thought) —
    // low maxOutputTokens causes MAX_TOKENS with empty parts. Minimum 8192 for reliable responses.
    var geminiMaxTokens = Math.max(maxTokens || 8192, 8192);
    var model = 'gemini-2.5-flash';
    var res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: geminiMaxTokens, temperature: 0.7 },
      }),
    });

    if (!res.ok) {
      var err = await res.text();
      throw new Error('Gemini API error (' + res.status + '): ' + err);
    }

    var data = await res.json();
    if (data.usageMetadata) {
      this.recordUsage(
        data.usageMetadata.promptTokenCount || 0,
        data.usageMetadata.candidatesTokenCount || 0,
        agentTag
      );
    }
    if (data.candidates && data.candidates.length > 0 && data.candidates[0].content) {
      var parts = data.candidates[0].content.parts;
      if (parts && parts.length > 0) {
        return parts.map(function(p) { return p.text || ''; }).join('');
      }
    }
    // Check for safety filter blocking
    if (data.candidates && data.candidates.length > 0 && data.candidates[0].finishReason === 'SAFETY') {
      throw new Error('Gemini blocked response (safety filter): ' + JSON.stringify(data.candidates[0].safetyRatings || []));
    }
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      throw new Error('Gemini blocked prompt: ' + data.promptFeedback.blockReason);
    }
    throw new Error('Empty response from Gemini (candidates: ' + JSON.stringify((data.candidates || []).map(function(c) { return { finishReason: c.finishReason, hasContent: !!c.content, hasParts: !!(c.content && c.content.parts) }; })) + ')');
  }

  /**
   * Generic OpenAI-compatible chat (DeepSeek, Grok/xAI, Mistral, Cohere, etc.)
   */
  async chatOpenAICompatible(baseUrl, apiKey, model, providerName, systemPrompt, userMessage, maxTokens, agentTag) {
    var res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: maxTokens || 8192,
      }),
    });

    if (!res.ok) {
      var err = await res.text();
      throw new Error(providerName + ' API error (' + res.status + '): ' + err);
    }

    var data = await res.json();
    if (data.usage) {
      this.recordUsage(data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, agentTag);
    }
    if (data.choices && data.choices.length > 0) {
      return data.choices[0].message.content;
    }
    throw new Error('Empty response from ' + providerName);
  }

  /**
   * Chat with a specific provider (for multi-LLM orchestration).
   * Falls back to the default provider if the requested one isn't configured.
   */
  async chatWithProvider(provider, systemPrompt, userMessage, opts) {
    var maxTokens = (opts && opts.maxTokens) || 4096;
    var agentTag = (opts && opts.agentTag) || null;

    // Per-provider max_tokens limits (API-imposed hard caps)
    var PROVIDER_MAX_TOKENS = { deepseek: 8192, grok: 131072, mistral: 32768, cohere: 4096 };
    if (PROVIDER_MAX_TOKENS[provider] && maxTokens > PROVIDER_MAX_TOKENS[provider]) {
      maxTokens = PROVIDER_MAX_TOKENS[provider];
    }

    switch (provider) {
      case 'anthropic': {
        // Direct Anthropic call with explicit key — NO mutation of this.apiKey
        var anthKey = this.config.get('anthropicApiKey') || this.config.get('llmApiKey') || this.apiKey || process.env.ANTHROPIC_API_KEY;
        if (!anthKey) return this.chat(systemPrompt, userMessage, opts);
        return this._chatAnthropicDirect(anthKey, systemPrompt, userMessage, maxTokens, agentTag);
      }
      case 'openai': {
        // Direct OpenAI call with explicit key — NO mutation of this.apiKey
        var oaiKey = this.config.get('openaiApiKey') || process.env.OPENAI_API_KEY;
        if (!oaiKey) return this.chat(systemPrompt, userMessage, opts);
        return this._chatOpenAIDirect(oaiKey, systemPrompt, userMessage, maxTokens, agentTag);
      }
      case 'gemini':
        return this.chatGemini(systemPrompt, userMessage, maxTokens, agentTag);
      case 'deepseek':
      case 'grok':
      case 'mistral':
      case 'cohere': {
        var compat = OPENAI_COMPAT_PROVIDERS[provider];
        var compatKey = this.config.get(compat.configKey) || process.env[compat.envKey];
        if (!compatKey) return this.chat(systemPrompt, userMessage, opts);
        return this.chatOpenAICompatible(compat.baseUrl, compatKey, this.model || compat.defaultModel, compat.name, systemPrompt, userMessage, maxTokens, agentTag);
      }
      default:
        return this.chat(systemPrompt, userMessage, opts);
    }
  }

  /**
   * Anthropic call with explicit API key (concurrency-safe — no shared state mutation).
   */
  async _chatAnthropicDirect(apiKey, systemPrompt, userMessage, maxTokens, agentTag) {
    var model = this.model || 'claude-sonnet-4-20250514';
    var LEGION_PREFIX = 'You are part of LEGION, a multi-agent orchestration system. ' +
      'LEGION decomposes complex prompts into sub-tasks handled by specialized agents, ' +
      'then synthesizes, debates, and evaluates results for quality. ' +
      'You are one component in this pipeline. Follow your role instructions precisely.';
    var systemBlocks = [
      { type: 'text', text: LEGION_PREFIX, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens || 8192,
        temperature: 0.7,
        system: systemBlocks,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!res.ok) {
      var err = await res.text();
      throw new Error('Anthropic API error (' + res.status + '): ' + err);
    }
    var data = await res.json();
    if (data.usage) {
      this.recordUsage(data.usage.input_tokens || 0, data.usage.output_tokens || 0, agentTag);
    }
    if (data.content && data.content.length > 0) {
      return data.content.map(function(b) { return b.text || ''; }).join('');
    }
    throw new Error('Empty response from Anthropic');
  }

  /**
   * OpenAI call with explicit API key (concurrency-safe — no shared state mutation).
   */
  async _chatOpenAIDirect(apiKey, systemPrompt, userMessage, maxTokens, agentTag) {
    var model = this.model || 'gpt-5.1-codex';
    var res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: maxTokens || 8192,
      }),
    });
    if (!res.ok) {
      var err = await res.text();
      throw new Error('OpenAI API error (' + res.status + '): ' + err);
    }
    var data = await res.json();
    if (data.usage) {
      this.recordUsage(data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, agentTag);
    }
    if (data.choices && data.choices.length > 0) {
      return data.choices[0].message.content;
    }
    throw new Error('Empty response from OpenAI');
  }

  /**
   * Detect which providers have API keys configured.
   * Returns array of available provider names.
   */
  getAvailableProviders() {
    var providers = [];
    if (this.apiKey || this.config.get('anthropicApiKey') || process.env.ANTHROPIC_API_KEY) providers.push('anthropic');
    if (this.config.get('openaiApiKey') || process.env.OPENAI_API_KEY) providers.push('openai');
    if (this.config.get('geminiApiKey') || process.env.GEMINI_API_KEY) providers.push('gemini');
    // OpenAI-compatible providers
    var compatNames = Object.keys(OPENAI_COMPAT_PROVIDERS);
    for (var ci = 0; ci < compatNames.length; ci++) {
      var cp = OPENAI_COMPAT_PROVIDERS[compatNames[ci]];
      if (this.config.get(cp.configKey) || process.env[cp.envKey]) providers.push(compatNames[ci]);
    }
    return providers;
  }
}

// ============================================================================
// Section 10: CLI Commands
// ============================================================================

/**
 * Extract JSON from a string that may contain markdown code blocks
 * or extra text around the JSON.
 */
function extractJSON(text) {
  // Try parsing as-is first
  try {
    return JSON.parse(text);
  } catch {}

  // Try extracting from code blocks (greedy — handles large JSON inside code blocks)
  var codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
  }

  // Try finding JSON object in text (greedy match for the outermost braces)
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
    // If JSON.parse fails on the full match (common with very long Gemini responses),
    // try cleaning common issues: unescaped newlines inside string values
    try {
      var cleaned = jsonMatch[0]
        .replace(/\r\n/g, '\\n')
        .replace(/\r/g, '\\n')
        .replace(/\t/g, '\\t');
      return JSON.parse(cleaned);
    } catch {}
  }

  return null;
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
}

/**
 * Print colored output (ANSI escape codes)
 */
var colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function printBanner() {
  console.log('');
  console.log(colors.green + colors.bold);
  console.log('    ██╗     ███████╗ ██████╗ ██╗ ██████╗ ███╗   ██╗    ██╗  ██╗');
  console.log('    ██║     ██╔════╝██╔════╝ ██║██╔═══██╗████╗  ██║    ╚██╗██╔╝');
  console.log('    ██║     █████╗  ██║  ███╗██║██║   ██║██╔██╗ ██║     ╚███╔╝');
  console.log('    ██║     ██╔══╝  ██║   ██║██║██║   ██║██║╚██╗██║     ██╔██╗');
  console.log('    ███████╗███████╗╚██████╔╝██║╚██████╔╝██║ ╚████║    ██╔╝ ██╗');
  console.log('    ╚══════╝╚══════╝ ╚═════╝ ╚═╝ ╚═════╝ ╚═╝  ╚═══╝    ╚═╝  ╚═╝');
  console.log('');
  console.log('    ' + colors.reset + colors.gray + '"One prompt. Many minds. Superior results."');
  console.log('    "Does this unit have a soul?"' + colors.reset);
  console.log('');
}

function printAgentCard(agent) {
  var categoryEmojis = {
    security: '\u{1F6E1}\uFE0F',
    content: '\u270F\uFE0F',
    analytics: '\u{1F4CA}',
    integration: '\u{1F50C}',
    automation: '\u2699\uFE0F',
    social: '\u{1F91D}',
    devops: '\u2601\uFE0F',
    commands: '\u2328\uFE0F',
    monitoring: '\u{1F441}\uFE0F',
    data: '\u{1F504}',
    communication: '\u{1F4AC}',
    utility: '\u{1F527}',
    'meta-evolution': '\u{1F525}',
  };

  var emoji = categoryEmojis[agent.category] || '\u{1F916}';
  var prefix = agent.parentAgent ? '  \u2514\u2500 ' : '';

  console.log(prefix + emoji + ' ' + colors.bold + agent.displayName + colors.reset +
    colors.dim + ' (' + agent.origin + ')' + colors.reset);
  console.log(prefix + '   ' + colors.cyan + agent.tagline + colors.reset);
  console.log(prefix + '   Category: ' + agent.category +
    (agent.parentAgent ? ' | Parent: ' + agent.parentAgent.toUpperCase() : ''));
  console.log(prefix + '   Capabilities: ' + colors.gray + agent.capabilities.join(', ') + colors.reset);

  if (agent.tasksCompleted > 0) {
    console.log(prefix + '   Stats: ' +
      colors.green + agent.tasksCompleted + ' completed' + colors.reset + ', ' +
      colors.red + (agent.tasksFailed || 0) + ' failed' + colors.reset + ', ' +
      'quality: ' + ((agent.avgQuality || 0) * 100).toFixed(0) + '%');
  }
  console.log('');
}

/**
 * Main orchestration flow — called by `run` command.
 *
 * Geth Consensus Pipeline:
 * 1. Evolutionary Decomposition (L4) → enhanced task splitting
 * 2. MoE Gating Network (L2) → learned agent routing
 * 3. Market Auction (L3) → competitive task allocation
 * 4. Agent Execution → parallel batching + circuit breaker
 * 5. Debate-Based Consensus (L1) → multi-round quality refinement
 * 6. Quality Evaluation + CI Gain
 */

// ============================================================================
// Section: ADE Project Scanner — Local Code Analysis for Real Security Audits
// ============================================================================

/**
 * ProjectScanner — Reads the user's local project to provide real code context
 * to LLM agents during Geth Consensus deliberation.
 *
 * Like Claude Code: selects security-relevant files intelligently,
 * respects .gitignore, enforces a token budget, and never does a brute-force dump.
 */

// Security-relevant file patterns (priority order)
var SECURITY_PATTERNS = [
  '.env', '.env.*', 'config.*', 'settings.*',
  '**/auth*', '**/middleware*', '**/security*', '**/permission*',
  '**/route*', '**/controller*', '**/handler*', '**/api*',
  '**/model*', '**/schema*', '**/migration*', '**/query*', '**/db*',
  'package.json', 'package-lock.json', 'requirements.txt', 'Gemfile', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'pyproject.toml', 'Pipfile',
  'Dockerfile*', 'docker-compose*', 'nginx*', '*.conf',
  '.github/**', '.gitlab-ci*', 'Jenkinsfile',
];

var SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  'venv', '.venv', 'target', 'vendor', '.cache', 'coverage', '.nyc_output',
  '.turbo', '.vercel', '.output', 'out', '.parcel-cache', '.svelte-kit',
  '.nuxt', '.expo', 'pods', 'Pods', '.gradle', '.idea', '.vs',
]);

// NOTE: .pdf and .docx are NOT skipped — they are parsed via pdf-parse/mammoth if available
var SCAN_SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.ogg',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.onnx', '.bin', '.pyc', '.pyo', '.o', '.so', '.dll', '.exe', '.dylib',
  '.lock', '.map', '.min.js', '.min.css',
  '.xls', '.xlsx',
  '.sqlite', '.db', '.sqlite3',
]);

var SECURITY_KEYWORDS = [
  'eval', 'exec', 'query', 'sql', 'password', 'token', 'secret', 'auth',
  'sanitize', 'escape', 'inject', 'csrf', 'cors', 'header', 'cookie',
  'session', 'redirect', 'upload', 'file', 'path', 'command', 'shell',
  'serialize', 'deserialize', 'render', 'template', 'require', 'import',
  'crypto', 'hash', 'encrypt', 'decrypt', 'sign', 'verify', 'jwt',
  'bearer', 'oauth', 'api_key', 'apikey', 'private_key', 'chmod',
  'child_process', 'spawn', 'fork', 'sudo', 'root', 'admin',
];

// v2: Pattern-based security extraction (context-aware, fewer false positives)
var SECURITY_PATTERNS = [
  // Dangerous function calls
  /\beval\s*\(/,
  /\bexec\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bchild_process\b/,
  /\bspawn\s*\(/,
  /\bexecSync\s*\(/,
  /\bexecFile\s*\(/,

  // SQL/query construction
  /\bquery\s*\(\s*[`'"]/,
  /\bSELECT\b.*\bFROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bUPDATE\b.*\bSET\b/i,
  /\.\s*raw\s*\(/,
  /\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE)/i,

  // Auth/crypto patterns
  /\bjwt\.(sign|verify|decode)\b/,
  /\bbcrypt\.(hash|compare)\b/,
  /\bcrypto\.(createHash|createCipher|randomBytes|createHmac)\b/,
  /\bpassword\b/i,
  /\bsecret\b/i,
  /\bbearer\b/i,
  /\bAPI[_-]?KEY\b/i,
  /\bprivate[_-]?key\b/i,

  // Input handling (framework-specific)
  /req\.(body|query|params|headers)\b/,
  /request\.(body|query|params)\b/,
  /c\.(req|body|param|query)\b/,
  /ctx\.(request|body|params)\b/,
  /\breq\.file\b/,

  // File/path operations
  /\bfs\.(readFile|writeFile|unlink|mkdir|readdir|createReadStream|createWriteStream)\b/,
  /\bpath\.join\s*\(/,
  /\bupload\b/i,
  /\bmulter\b/,

  // Response/redirect/cookies
  /\bredirect\s*\(/,
  /\.cookie\s*\(/,
  /\.setHeader\s*\(/,
  /\bcors\b/i,
  /\bcsrf\b/i,
  /\bhelmet\b/,

  // Error handling
  /catch\s*\(/,
  /\.catch\s*\(/,
  /throw\s+new/,

  // Authorization checks
  /\bisAdmin\b/,
  /\bisAuthenticated\b/,
  /\bhasPermission\b/,
  /\bauthorize\b/i,
  /\brole\s*[=!]==/,

  // Dangerous patterns
  /innerHTML\s*=/,
  /dangerouslySetInnerHTML/,
  /document\.write\b/,
  /\.serialize\s*\(/,
  /JSON\.parse\s*\(\s*(?:req|request|ctx|c)\b/,
];

function detectProjectPath(prompt) {
  if (!prompt) return null;
  var lower = prompt.toLowerCase();

  var absMatch = prompt.match(/(?:^|\s)(\/[^\s"']+|[A-Z]:\\[^\s"']+)/);
  if (absMatch) {
    var candidate = absMatch[1].replace(/[.,;:!?)]+$/, '');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return path.resolve(candidate);
      }
    } catch (_) {}
  }

  var relMatch = prompt.match(/(?:^|\s)(\.\.?\/[^\s"']+)/);
  if (relMatch) {
    var resolved = path.resolve(relMatch[1].replace(/[.,;:!?)]+$/, ''));
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch (_) {}
  }

  var cwdKeywords = [
    'questo progetto', 'this project', 'current project', 'current directory',
    'progetto corrente', 'questa cartella', 'this folder', 'this codebase',
    'mio progetto', 'my project', 'our project', 'our codebase',
  ];
  for (var k = 0; k < cwdKeywords.length; k++) {
    if (lower.includes(cwdKeywords[k])) return process.cwd();
  }

  var securityKeywords = [
    'sicurezza', 'security', 'pentest', 'penetration', 'audit',
    'vulnerabilit', 'vulnerability', 'analizza', 'analyze', 'scan',
    'trova vulnerabilit', 'find vulnerabilit', 'code review',
  ];
  for (var s = 0; s < securityKeywords.length; s++) {
    if (lower.includes(securityKeywords[s])) {
      var cwd = process.cwd();
      var manifests = ['package.json', 'go.mod', 'Cargo.toml', 'requirements.txt',
        'pyproject.toml', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json'];
      for (var m = 0; m < manifests.length; m++) {
        if (fs.existsSync(path.join(cwd, manifests[m]))) return cwd;
      }
    }
  }

  return null;
}

function loadGitignorePatterns(projectDir) {
  var patterns = [];
  try {
    var gitignorePath = path.join(projectDir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      var lines = fs.readFileSync(gitignorePath, 'utf-8').split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line && !line.startsWith('#')) patterns.push(line.replace(/\/$/, ''));
      }
    }
  } catch (_) {}
  return patterns;
}

function isGitignored(relPath, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i];
    var name = path.basename(relPath);
    if (name === p || relPath === p) return true;
    if (p.endsWith('*') && name.startsWith(p.slice(0, -1))) return true;
    if (p.startsWith('*') && name.endsWith(p.slice(1))) return true;
    if (relPath.startsWith(p + '/') || relPath.includes('/' + p + '/')) return true;
    if (relPath.startsWith(p)) return true;
  }
  return false;
}

/**
 * v2: Extract code signatures from file content.
 * Returns array of strings like "export async function login(req, res)"
 * Max 10 signatures per file, max 60 chars per signature.
 */
function extractFileSignatures(content, relPath) {
  var signatures = [];
  var lines = content.split('\n');

  var sigPatterns = [
    /^export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/,
    /(?:router|app|api)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)/,
    /^(?:async\s+)?def\s+(\w+)\s*\(/,
    /^class\s+(\w+)/,
    /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/,
    /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
    /^(?:pub\s+)?struct\s+(\w+)/,
    /^impl\s+(\w+)/,
    /module\.exports\s*=\s*\{/,
    /^export\s+default\s+(?:function|class)\s+(\w+)/,
  ];

  for (var i = 0; i < lines.length && signatures.length < 10; i++) {
    var line = lines[i].trimStart();
    if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('*')) continue;

    for (var p = 0; p < sigPatterns.length; p++) {
      var match = line.match(sigPatterns[p]);
      if (match) {
        if (p === 1) {
          signatures.push(match[1].toUpperCase() + ' ' + match[2]);
        } else if (p === 8) {
          signatures.push('module.exports = {...}');
        } else {
          signatures.push(line.substring(0, 60).replace(/\s*\{?\s*$/, ''));
        }
        break;
      }
    }
  }

  return signatures;
}

/**
 * v2: Build a complete file inventory with signatures for ALL project files.
 */
function buildFileInventory(projectDir, tree) {
  var inventory = [];
  var MAX_INVENTORY_CHARS = 20000;
  var charCount = 0;

  for (var i = 0; i < tree.length; i++) {
    var f = tree[i];
    var priority = getFilePriority(f.path);
    var lineCount = 0;
    var signatures = [];

    try {
      var filePath = path.join(projectDir, f.path);
      var content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes('\0')) continue;
      var fileLines = content.split('\n');
      lineCount = fileLines.length;
      signatures = extractFileSignatures(content, f.path);
    } catch (_) {
      lineCount = 0;
    }

    var entry = {
      path: f.path,
      priority: priority,
      lines: lineCount,
      signatures: signatures,
    };

    var entryStr = f.path + ' (P' + priority + ', ' + lineCount + ' lines): ' + signatures.join(', ');
    charCount += entryStr.length + 2;
    if (charCount > MAX_INVENTORY_CHARS) break;

    inventory.push(entry);
  }

  return inventory;
}

/**
 * v2: Extract security-relevant sections using pattern matching.
 */
function extractSecuritySectionsV2(content, maxLines) {
  var lines = content.split('\n');
  if (lines.length <= maxLines) return content;

  var matchedSet = new Set();
  var contextRadius = 3;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var lower = line.toLowerCase();

    var patternMatched = false;
    for (var p = 0; p < SECURITY_PATTERNS.length; p++) {
      if (SECURITY_PATTERNS[p].test(line)) {
        patternMatched = true;
        break;
      }
    }

    if (!patternMatched) {
      for (var k = 0; k < SECURITY_KEYWORDS.length; k++) {
        if (lower.includes(SECURITY_KEYWORDS[k])) {
          patternMatched = true;
          break;
        }
      }
    }

    if (patternMatched) {
      for (var j = Math.max(0, i - contextRadius); j <= Math.min(lines.length - 1, i + contextRadius); j++) {
        matchedSet.add(j);
      }
    }
  }

  if (matchedSet.size === 0) {
    return lines.slice(0, maxLines).join('\n') + '\n... [truncated: ' + lines.length + ' total lines, no security patterns found]';
  }

  var sortedIndices = Array.from(matchedSet).sort(function(a, b) { return a - b; });
  var selectedLines = [];
  var lastIdx = -2;
  for (var s = 0; s < sortedIndices.length && selectedLines.length < maxLines; s++) {
    var idx = sortedIndices[s];
    if (idx > lastIdx + 1) {
      selectedLines.push('... [lines ' + (lastIdx + 2) + '-' + idx + ' omitted]');
    }
    selectedLines.push((idx + 1) + ': ' + lines[idx]);
    lastIdx = idx;
  }

  if (lastIdx < lines.length - 1) {
    selectedLines.push('... [lines ' + (lastIdx + 2) + '-' + lines.length + ' omitted]');
  }

  return selectedLines.join('\n');
}

function scanProjectStructure(projectDir, maxDepth, maxFiles) {
  maxDepth = maxDepth || 8;
  maxFiles = maxFiles || 5000;
  var gitignorePatterns = loadGitignorePatterns(projectDir);
  var tree = [];
  var totalDirs = 0;
  var fileCount = 0;

  function walk(dir, depth, relPrefix) {
    if (depth > maxDepth || fileCount >= maxFiles) return;
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.sort(function(a, b) { return a.name.localeCompare(b.name); });

    for (var i = 0; i < entries.length; i++) {
      if (fileCount >= maxFiles) break;
      var entry = entries[i];
      var relPath = relPrefix ? relPrefix + '/' + entry.name : entry.name;

      if (entry.name.startsWith('.') &&
          !entry.name.startsWith('.env') &&
          entry.name !== '.github' &&
          !entry.name.startsWith('.gitlab-ci')) {
        continue;
      }

      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name)) continue;
        if (isGitignored(relPath, gitignorePatterns)) continue;
        totalDirs++;
        walk(path.join(dir, entry.name), depth + 1, relPath);
      } else if (entry.isFile()) {
        var ext = path.extname(entry.name).toLowerCase();
        if (SCAN_SKIP_EXTENSIONS.has(ext)) continue;
        if (isGitignored(relPath, gitignorePatterns)) continue;
        var stat;
        try { stat = fs.statSync(path.join(dir, entry.name)); } catch (_) { continue; }
        if (stat.size > 1048576) continue;
        fileCount++;
        tree.push({ path: relPath, size: stat.size, ext: ext });
      }
    }
  }

  walk(projectDir, 0, '');
  return { tree: tree, totalFiles: fileCount, totalDirs: totalDirs };
}

function identifyProjectType(projectDir) {
  var result = { type: 'unknown', framework: '', dependencies: [] };

  var pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    result.type = 'Node.js';
    try {
      var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      var allDeps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
      var depNames = Object.keys(allDeps);
      result.dependencies = depNames.slice(0, 40).map(function(d) { return d + '@' + (allDeps[d] || '?'); });
      if (allDeps['next']) result.framework = 'Next.js';
      else if (allDeps['express']) result.framework = 'Express';
      else if (allDeps['fastify']) result.framework = 'Fastify';
      else if (allDeps['hono']) result.framework = 'Hono';
      else if (allDeps['koa']) result.framework = 'Koa';
      else if (allDeps['@nestjs/core']) result.framework = 'NestJS';
      else if (allDeps['nuxt']) result.framework = 'Nuxt';
      else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) result.framework = 'SvelteKit';
      else if (allDeps['react']) result.framework = 'React';
      else if (allDeps['vue']) result.framework = 'Vue';
      else if (allDeps['angular'] || allDeps['@angular/core']) result.framework = 'Angular';
      if (allDeps['pg'] || allDeps['postgres']) result.framework += ' + PostgreSQL';
      else if (allDeps['mysql2'] || allDeps['mysql']) result.framework += ' + MySQL';
      else if (allDeps['mongodb'] || allDeps['mongoose']) result.framework += ' + MongoDB';
      else if (allDeps['better-sqlite3'] || allDeps['sqlite3']) result.framework += ' + SQLite';
      if (allDeps['drizzle-orm']) result.framework += ' + Drizzle';
      else if (allDeps['prisma'] || allDeps['@prisma/client']) result.framework += ' + Prisma';
      else if (allDeps['typeorm']) result.framework += ' + TypeORM';
      else if (allDeps['sequelize']) result.framework += ' + Sequelize';
    } catch (_) {}
    return result;
  }

  if (fs.existsSync(path.join(projectDir, 'requirements.txt')) ||
      fs.existsSync(path.join(projectDir, 'pyproject.toml'))) {
    result.type = 'Python';
    try {
      var reqPath = path.join(projectDir, 'requirements.txt');
      if (fs.existsSync(reqPath)) {
        var reqs = fs.readFileSync(reqPath, 'utf-8').split('\n').filter(function(l) { return l.trim() && !l.startsWith('#'); });
        result.dependencies = reqs.slice(0, 30);
        if (reqs.some(function(r) { return r.startsWith('django'); })) result.framework = 'Django';
        else if (reqs.some(function(r) { return r.startsWith('flask'); })) result.framework = 'Flask';
        else if (reqs.some(function(r) { return r.startsWith('fastapi'); })) result.framework = 'FastAPI';
      }
    } catch (_) {}
    return result;
  }

  if (fs.existsSync(path.join(projectDir, 'go.mod'))) {
    result.type = 'Go';
    try {
      var goMod = fs.readFileSync(path.join(projectDir, 'go.mod'), 'utf-8');
      var goReqs = goMod.match(/require\s*\(([^)]+)\)/s);
      if (goReqs) result.dependencies = goReqs[1].trim().split('\n').map(function(l) { return l.trim(); }).filter(Boolean).slice(0, 30);
      if (goMod.includes('gin-gonic')) result.framework = 'Gin';
      else if (goMod.includes('echo')) result.framework = 'Echo';
      else if (goMod.includes('fiber')) result.framework = 'Fiber';
    } catch (_) {}
    return result;
  }

  if (fs.existsSync(path.join(projectDir, 'Cargo.toml'))) {
    result.type = 'Rust';
    try {
      var cargo = fs.readFileSync(path.join(projectDir, 'Cargo.toml'), 'utf-8');
      if (cargo.includes('actix-web')) result.framework = 'Actix';
      else if (cargo.includes('axum')) result.framework = 'Axum';
      else if (cargo.includes('rocket')) result.framework = 'Rocket';
    } catch (_) {}
    return result;
  }

  if (fs.existsSync(path.join(projectDir, 'pom.xml'))) { result.type = 'Java'; result.framework = 'Maven'; return result; }
  if (fs.existsSync(path.join(projectDir, 'build.gradle'))) { result.type = 'Java'; result.framework = 'Gradle'; return result; }

  if (fs.existsSync(path.join(projectDir, 'Gemfile'))) {
    result.type = 'Ruby';
    try {
      var gemfile = fs.readFileSync(path.join(projectDir, 'Gemfile'), 'utf-8');
      if (gemfile.includes("'rails'") || gemfile.includes('"rails"')) result.framework = 'Rails';
      else if (gemfile.includes("'sinatra'")) result.framework = 'Sinatra';
    } catch (_) {}
    return result;
  }

  return result;
}

/**
 * Extract text from PDF files (text-based only, not scanned/image PDFs).
 * Requires pdf-parse: npm install -g pdf-parse
 */
async function extractPdfText(filePath) {
  try {
    var pdfParse = (await import('pdf-parse')).default;
    var buffer = fs.readFileSync(filePath);
    var data = await pdfParse(buffer);
    return data.text || '';
  } catch {
    return '';
  }
}

/**
 * Extract text from DOCX files.
 * Requires mammoth: npm install -g mammoth
 */
async function extractDocxText(filePath) {
  try {
    var mammoth = await import('mammoth');
    var buffer = fs.readFileSync(filePath);
    var result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  } catch {
    return '';
  }
}

function getFilePriority(relPath) {
  var name = path.basename(relPath).toLowerCase();
  var dir = path.dirname(relPath).toLowerCase();

  if (name.startsWith('.env') || name.includes('secret') || name.includes('credential') ||
      name.includes('password') || name === 'credentials.json' || name === 'serviceaccount.json') return 1;

  if (dir.includes('auth') || dir.includes('middleware') || dir.includes('security') ||
      dir.includes('permission') || dir.includes('route') || dir.includes('controller') ||
      dir.includes('handler') || dir.includes('api') ||
      name.includes('auth') || name.includes('middleware') || name.includes('guard') ||
      name.includes('policy') || name.includes('permission') || name.includes('route') ||
      name.includes('controller') || name.includes('handler')) return 2;

  // Priority 2 (documents): security/auth/policy documents
  var isDoc = name.endsWith('.pdf') || name.endsWith('.docx') || name.endsWith('.doc') ||
              name.endsWith('.md') || name.endsWith('.txt') || name.endsWith('.rst');
  if (isDoc && (name.includes('security') || name.includes('auth') || name.includes('policy'))) return 2;

  if (dir.includes('model') || dir.includes('schema') || dir.includes('migration') ||
      dir.includes('query') || dir.includes('db') || dir.includes('database') ||
      dir.includes('config') || dir.includes('infra') ||
      name.includes('model') || name.includes('schema') || name.includes('migration') ||
      name.includes('query') || name.includes('config') || name.includes('setting') ||
      name === 'dockerfile' || name.includes('docker-compose') || name.includes('nginx') ||
      name.endsWith('.conf') || name === 'jenkinsfile' ||
      (dir.includes('.github') && name.endsWith('.yml'))) return 3;

  // Priority 3 (documents): architecture/design/spec documents
  if (isDoc && (name.includes('architecture') || name.includes('design') || name.includes('spec'))) return 3;

  return 4;
}

function extractSecuritySections(content, maxLines) {
  var lines = content.split('\n');
  if (lines.length <= maxLines) return content;

  var selectedLines = [];
  var contextRadius = 3;
  var matchedSet = new Set();

  for (var i = 0; i < lines.length; i++) {
    var lower = lines[i].toLowerCase();
    for (var k = 0; k < SECURITY_KEYWORDS.length; k++) {
      if (lower.includes(SECURITY_KEYWORDS[k])) {
        for (var j = Math.max(0, i - contextRadius); j <= Math.min(lines.length - 1, i + contextRadius); j++) {
          matchedSet.add(j);
        }
        break;
      }
    }
  }

  if (matchedSet.size === 0) {
    return lines.slice(0, maxLines).join('\n') + '\n... [truncated: ' + lines.length + ' total lines, no security keywords found]';
  }

  var sortedIndices = Array.from(matchedSet).sort(function(a, b) { return a - b; });
  var lastIdx = -2;
  for (var s = 0; s < sortedIndices.length && selectedLines.length < maxLines; s++) {
    var idx = sortedIndices[s];
    if (idx > lastIdx + 1) selectedLines.push('... [lines ' + (lastIdx + 2) + '-' + idx + ' omitted]');
    selectedLines.push((idx + 1) + ': ' + lines[idx]);
    lastIdx = idx;
  }

  if (lastIdx < lines.length - 1) selectedLines.push('... [lines ' + (lastIdx + 2) + '-' + lines.length + ' omitted]');
  return selectedLines.join('\n');
}

async function selectSecurityFiles(projectDir, tree, tokenBudget) {
  tokenBudget = tokenBudget || 120000; // v2: 120K chars (~30K tokens)

  // Group files by priority
  var buckets = { 1: [], 2: [], 3: [], 4: [] };
  for (var i = 0; i < tree.length; i++) {
    var f = tree[i];
    var priority = getFilePriority(f.path);
    if (buckets[priority]) {
      buckets[priority].push({ path: f.path, size: f.size, ext: f.ext, priority: priority });
    }
  }

  for (var p = 1; p <= 4; p++) {
    buckets[p].sort(function(a, b) { return a.path.localeCompare(b.path); });
  }

  var files = [];
  var charBudget = tokenBudget;
  var priorityLabels = { 1: 'CRITICAL', 2: 'HIGH', 3: 'MEDIUM', 4: 'LOW' };
  var maxLinesByPriority = { 1: 1000, 2: 600, 3: 400, 4: 150 };
  var indices = { 1: 0, 2: 0, 3: 0, 4: 0 };
  var readPaths = new Set();

  // Round-robin: cycle through P1, P2, P3, P4
  var moreFiles = true;
  while (moreFiles && charBudget > 0) {
    moreFiles = false;
    for (var pri = 1; pri <= 4; pri++) {
      if (charBudget <= 0) break;
      var bucket = buckets[pri];
      var idx = indices[pri];
      if (pri === 4 && charBudget < tokenBudget * 0.1) continue;
      if (pri === 3 && charBudget < tokenBudget * 0.05) continue;
      if (idx >= bucket.length) continue;
      moreFiles = true;
      indices[pri]++;

      var entry = bucket[idx];
      if (readPaths.has(entry.path)) continue;
      readPaths.add(entry.path);

      var filePath = path.join(projectDir, entry.path);
      var ext = path.extname(entry.path).toLowerCase();
      var content;
      try {
        if (ext === '.pdf') {
          content = await extractPdfText(filePath);
          if (!content) continue;
        } else if (ext === '.docx' || ext === '.doc') {
          content = await extractDocxText(filePath);
          if (!content) continue;
        } else {
          content = fs.readFileSync(filePath, 'utf-8');
        }
      } catch (_) { continue; }
      if (content.includes('\0')) continue;

      var maxLines = maxLinesByPriority[pri] || 150;
      var processed = extractSecuritySectionsV2(content, maxLines);

      if (processed.length > charBudget) {
        processed = processed.substring(0, charBudget) + '\n... [truncated to fit token budget]';
      }

      charBudget -= processed.length;
      files.push({
        path: entry.path,
        priority: pri,
        priorityLabel: priorityLabels[pri],
        content: processed,
        lines: content.split('\n').length,
      });
    }
  }

  files.sort(function(a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.path.localeCompare(b.path);
  });

  return files;
}

function buildTreeString(tree, maxEntries) {
  maxEntries = maxEntries || 60;
  var dirs = {};
  for (var i = 0; i < tree.length && i < maxEntries; i++) {
    var dirName = path.dirname(tree[i].path);
    if (dirName === '.') dirName = '/';
    if (!dirs[dirName]) dirs[dirName] = [];
    dirs[dirName].push(tree[i]);
  }
  var lines = [];
  var sortedDirs = Object.keys(dirs).sort();
  for (var d = 0; d < sortedDirs.length; d++) {
    var dir = sortedDirs[d];
    lines.push(dir + '/');
    var entries = dirs[dir];
    for (var e = 0; e < entries.length; e++) {
      var isLast = e === entries.length - 1;
      var prefix = isLast ? '  \u2514\u2500 ' : '  \u251C\u2500 ';
      lines.push(prefix + path.basename(entries[e].path));
    }
  }
  if (tree.length > maxEntries) lines.push('... and ' + (tree.length - maxEntries) + ' more files');
  return lines.join('\n');
}

function buildProjectContext(projectDir, files, projectType, structure) {
  var parts = [];
  parts.push('=== PROJECT ANALYSIS CONTEXT ===');
  parts.push('Project: ' + projectDir);
  parts.push('Type: ' + projectType.type + (projectType.framework ? ' (' + projectType.framework + ')' : ''));
  if (projectType.dependencies.length > 0) parts.push('Key Dependencies: ' + projectType.dependencies.slice(0, 20).join(', '));
  parts.push('Structure: ' + structure.totalFiles + ' files in ' + structure.totalDirs + ' directories');
  parts.push('');
  parts.push('[DIRECTORY TREE]');
  parts.push(buildTreeString(structure.tree));
  parts.push('');

  var currentPriority = 0;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f.priority !== currentPriority) {
      currentPriority = f.priority;
      parts.push('');
      parts.push('--- ' + f.priorityLabel + ' PRIORITY FILES ---');
    }
    parts.push('');
    parts.push('[FILE: ' + f.path + '] (PRIORITY: ' + f.priorityLabel + ', ' + f.lines + ' lines)');
    parts.push(f.content);
  }
  parts.push('');
  parts.push('=== END PROJECT CONTEXT ===');
  return parts.join('\n');
}

/**
 * v2: Build structured project context with inventory + code chunks.
 */
function buildStructuredProjectContext(projectDir, files, projectType, structure, inventory) {
  var codeChunks = {};
  for (var i = 0; i < files.length; i++) {
    codeChunks[files[i].path] = files[i].content;
  }

  var typeStr = projectType.type + (projectType.framework ? ' (' + projectType.framework + ')' : '');

  return {
    inventory: inventory,
    codeChunks: codeChunks,
    meta: {
      projectDir: projectDir,
      projectType: typeStr,
      dependencies: projectType.dependencies.slice(0, 20),
      totalFiles: structure.totalFiles,
      totalDirs: structure.totalDirs,
      filesInInventory: inventory.length,
      filesDeepRead: files.length,
    },
  };
}

/**
 * Main entry: scan a project directory and return context for LLM injection.
 * v2: Returns structured JSON (inventory + codeChunks) for agent-specific injection.
 */
async function scanProject(projectDir, tokenBudget) {
  if (!fs.existsSync(projectDir)) throw new Error('Directory not found: ' + projectDir);
  if (!fs.statSync(projectDir).isDirectory()) throw new Error('Not a directory: ' + projectDir);

  var projectType = identifyProjectType(projectDir);
  var structure = scanProjectStructure(projectDir);

  // v2: Build file inventory with signatures (pass 1)
  var inventory = buildFileInventory(projectDir, structure.tree);

  // Select and deep-read security-relevant files (pass 2)
  var files = await selectSecurityFiles(projectDir, structure.tree, tokenBudget);

  // Build structured context (v2 format)
  var structured = buildStructuredProjectContext(projectDir, files, projectType, structure, inventory);

  var contextJson = JSON.stringify(structured);
  var tokenEstimate = Math.ceil(contextJson.length / 4);

  return {
    context: contextJson,
    filesRead: files.length,
    filesInInventory: inventory.length,
    totalFiles: structure.totalFiles,
    tokenEstimate: tokenEstimate,
    projectType: structured.meta.projectType,
    projectDir: projectDir,
  };
}

// =============================================================================
// Zero-Knowledge Client Orchestration — API key never leaves the client
// =============================================================================

/**
 * runClientOrchestration — Zero-knowledge free tier execution
 *
 * The server provides orchestration intelligence (decomposition prompts,
 * ONNX routing, convergence measurement, synthesis prompts) but NEVER
 * receives the user's API key. ALL LLM calls are made directly by the
 * client using the local LLMProvider.
 *
 * Protocol:
 *   Client                              Server
 *     ├─ POST /sessions (no key!) ────>  create session
 *     ├─ POST step/decompose ─────────> get decomposition prompt
 *     ├─ [LOCAL LLM call] ────────────> (direct to provider)
 *     ├─ POST step/decompose/result ──> parse + ONNX routing
 *     ├─ POST step/round/start ───────> get agent prompts
 *     ├─ [LOCAL LLM calls in parallel]> (direct to provider)
 *     ├─ POST step/round/result ──────> convergence + decision
 *     │  (loop if more rounds needed)
 *     ├─ POST step/synthesize ────────> get synthesis prompt
 *     ├─ [LOCAL LLM call] ────────────> (direct to provider)
 *     ├─ POST step/synthesize/result ─> store
 *     ├─ POST step/validate ──────────> get validation prompts
 *     ├─ [LOCAL LLM calls] ───────────> (direct to provider)
 *     └─ POST step/validate/result ───> quality + CI gain + complete
 */
async function runClientOrchestration(prompt, options, legionConfig, client) {
  var verbose = options.verbose !== undefined ? options.verbose : legionConfig.get('verbose');
  var immersive = !options.noImmersive;
  var totalStart = Date.now();

  // Immersive rendering: agent speech bubbles + cross-reading + synthesis display
  var _agentColorPalette = [
    '\x1b[38;5;214m', '\x1b[38;5;39m', '\x1b[38;5;156m', '\x1b[38;5;213m',
    '\x1b[38;5;220m', '\x1b[38;5;87m', '\x1b[38;5;183m', '\x1b[38;5;203m',
    '\x1b[38;5;114m', '\x1b[38;5;141m', '\x1b[38;5;180m', '\x1b[38;5;80m',
  ];
  var _agentColorMap = {};
  var _agentColorIdx = 0;
  function _getAgentColor(name) {
    var key = (name || '').toUpperCase();
    if (!_agentColorMap[key]) {
      _agentColorMap[key] = _agentColorPalette[_agentColorIdx % _agentColorPalette.length];
      _agentColorIdx++;
    }
    return _agentColorMap[key];
  }

  // Word-wrap text to fit terminal width, respecting the bubble prefix
  function wrapLine(text, maxWidth) {
    if (!text || maxWidth <= 0) return [text || ''];
    var wrapped = [];
    var remaining = text;
    while (remaining.length > maxWidth) {
      // Find last space within maxWidth
      var breakIdx = remaining.lastIndexOf(' ', maxWidth);
      if (breakIdx <= 0) {
        // No space found — hard break at maxWidth
        breakIdx = maxWidth;
      }
      wrapped.push(remaining.substring(0, breakIdx));
      remaining = remaining.substring(breakIdx).replace(/^ /, ''); // trim leading space
    }
    if (remaining.length > 0) wrapped.push(remaining);
    return wrapped;
  }

  function renderAgentBubble(agentName, provider, content, roundNum) {
    if (!immersive || !content) return;
    var name = (agentName || 'UNKNOWN').toUpperCase();
    var col = _getAgentColor(name);
    var roundLabel = roundNum > 1 ? ' (Round ' + roundNum + ')' : '';
    // Terminal width minus bubble prefix ("  │ " = 4 chars)
    var termCols = process.stdout.columns || 120;
    var contentWidth = Math.max(40, termCols - 6);
    console.log('');
    console.log('  ' + col + '\u25cf ' + name + roundLabel + '\x1b[0m \x1b[90m(' + (provider || '') + '):\x1b[0m');
    var allLines = String(content).split('\n');
    for (var li = 0; li < allLines.length; li++) {
      var subLines = wrapLine(allLines[li], contentWidth);
      for (var si = 0; si < subLines.length; si++) {
        console.log('  ' + col + '\u2502\x1b[0m ' + subLines[si]);
      }
    }
    console.log('  ' + col + '\u2514\u2500\u2500\u2500\x1b[0m');
  }

  function renderCrossReading(agentName, otherAgents) {
    if (!immersive || !otherAgents || otherAgents.length === 0) return;
    var col = _getAgentColor((agentName || '').toUpperCase());
    var names = otherAgents.map(function(n) {
      var c = _getAgentColor((n || '').toUpperCase());
      return c + (n || '').toUpperCase() + '\x1b[0m';
    }).join(', ');
    console.log('  ' + col + '\u21bb ' + (agentName || '').toUpperCase() + '\x1b[0m reading: ' + names);
  }

  function renderSynthBubble(provider, content) {
    if (!immersive || !content) return;
    var termCols = process.stdout.columns || 120;
    var contentWidth = Math.max(40, termCols - 6);
    console.log('');
    console.log('  \x1b[36m\u25cf SYNTHESIS\x1b[0m \x1b[90m(' + (provider || '') + '):\x1b[0m');
    var lines = String(content).split('\n');
    for (var li = 0; li < lines.length; li++) {
      var subLines = wrapLine(lines[li], contentWidth);
      for (var si = 0; si < subLines.length; si++) {
        console.log('  \x1b[36m\u2502\x1b[0m ' + subLines[si]);
      }
    }
    console.log('  \x1b[36m\u2514\u2500\u2500\u2500\x1b[0m');
  }

  console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Zero-knowledge client orchestration mode');
  console.log(colors.gray + 'Your API key NEVER leaves this machine. The server only provides orchestration intelligence.' + colors.reset);
  console.log();

  // 1. Initialize local LLM provider
  var llm = new LLMProvider(legionConfig);
  if (!llm.apiKey && llm.getAvailableProviders().length === 0) {
    console.error(colors.red + 'ERROR: No API key configured.' + colors.reset);
    console.error('Set your API key: node legion-x.mjs config:set llm-key YOUR_API_KEY');
    process.exit(1);
  }

  // 1.5 Project scan (same as server mode)
  var projectContext = null;
  var detectedPath = options.scanDir || detectProjectPath(prompt);
  if (detectedPath && !options.noScan) {
    console.log(colors.cyan + '[PROJECT SCAN v2]' + colors.reset + ' Scanning ' + colors.bold + detectedPath + colors.reset + '...');
    try {
      var scanBudget = options.scanBudget ? parseInt(options.scanBudget, 10) : undefined;
      var scanResult = await scanProject(detectedPath, scanBudget);
      projectContext = scanResult.context;
      console.log(colors.cyan + '[PROJECT SCAN v2]' + colors.reset +
        ' Inventory: ' + colors.bold + scanResult.filesInInventory + colors.reset + ' files' +
        ' | Deep read: ' + colors.bold + scanResult.filesRead + colors.reset + ' files' +
        ' | ' + colors.yellow + scanResult.tokenEstimate.toLocaleString() + ' tokens' + colors.reset);
    } catch (err) {
      console.warn(colors.yellow + '[PROJECT SCAN] Warning: ' + err.message + colors.reset);
    }
  }

  // 2. Build session config
  var sessionConfig = {};
  if (legionConfig.get('deliberationRounds')) sessionConfig.deliberationRounds = legionConfig.get('deliberationRounds');
  if (legionConfig.get('deliberationConvergence')) sessionConfig.deliberationConvergence = legionConfig.get('deliberationConvergence');
  if (legionConfig.get('minDeliberationRounds')) sessionConfig.minDeliberationRounds = legionConfig.get('minDeliberationRounds');
  if (options.noTribunal) sessionConfig.noTribunal = true;
  if (options.liaraMode) sessionConfig.liaraMode = true;

  var userProvider = legionConfig.get('provider') || legionConfig.get('llmProvider') || 'anthropic';
  var availableProviders = llm.getAvailableProviders();
  var isMultiProvider = availableProviders.length > 1;
  var providerMode = isMultiProvider ? 'multi' : 'single';
  var providers = isMultiProvider ? availableProviders : [userProvider];

  if (isMultiProvider) {
    console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Multi-LLM mode: ' + colors.magenta + availableProviders.join(' + ') + colors.reset + ' (local execution)');
  } else {
    console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Provider: ' + colors.magenta + userProvider + colors.reset + ' (local execution)');
  }

  // 3. Create session WITHOUT API key
  console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Creating session (zero-knowledge)...');
  var createResult;
  try {
    createResult = await client.createGethSession(
      prompt,
      Object.keys(sessionConfig).length > 0 ? sessionConfig : undefined,
      providerMode,
      providers,
      null, // NO API key sent
      projectContext,
      null, // NO API keys map
      'client', // orchestrationMode
    );
  } catch (err) {
    if (err.message && (err.message.includes('429') || err.message.includes('rate limit'))) {
      console.error(colors.yellow + '[RATE LIMITED]' + colors.reset + ' ' + colors.red + err.message + colors.reset);
    } else {
      console.error(colors.red + 'Failed to create session: ' + err.message + colors.reset);
    }
    process.exit(1);
  }

  var sessionId = createResult.sessionId;
  console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Session ' + colors.bold + sessionId.substring(0, 8) + '...' + colors.reset + ' created');

  // Helper: report progress to server (fire-and-forget)
  async function reportProgress(updates, logEntry) {
    try {
      await client.updateClientProgress(sessionId, updates, logEntry);
    } catch (_) {}
  }

  // Helper: extract token stats from LLM usage
  function getTokenStats(llmProvider, agentTag) {
    var perAgent = llmProvider.tokenUsage.perAgent[agentTag];
    return perAgent ? { inputTokens: perAgent.input, outputTokens: perAgent.output } : { inputTokens: 0, outputTokens: 0 };
  }

  try {
    // ========================================================================
    // Step 1: DECOMPOSITION
    // ========================================================================
    console.log('\x1b[36m[DECOMPOSE]  \x1b[0mRequesting decomposition prompt from server...');
    var decompInstr = await client.stepDecompose(sessionId);
    if (decompInstr.groundingSummary) {
      console.log('\x1b[36m[GROUNDING] \x1b[0m' + decompInstr.groundingSummary);
    }

    // Weighted provider rotation for decomposition: round-robin based on session ID hash
    // so each session starts with a different primary provider, distributing load evenly
    var decompProviderHint = decompInstr.provider;
    var decompProviderOrder;
    if (decompProviderHint) {
      decompProviderOrder = [decompProviderHint].concat(availableProviders.filter(function(p) { return p !== decompProviderHint; }));
    } else {
      // Rotate primary provider: hash sessionId to pick starting index
      var hashSum = 0;
      for (var hi = 0; hi < sessionId.length; hi++) hashSum += sessionId.charCodeAt(hi);
      var startIdx = hashSum % availableProviders.length;
      decompProviderOrder = [];
      for (var ri = 0; ri < availableProviders.length; ri++) {
        decompProviderOrder.push(availableProviders[(startIdx + ri) % availableProviders.length]);
      }
    }

    var decompProvider = decompProviderOrder[0];
    console.log('\x1b[36m[DECOMPOSE]  \x1b[0mExecuting decomposition locally via ' + colors.magenta + decompProvider + colors.reset + '...');
    var usageBefore = llm.tokenUsage.calls;
    var decompRaw;
    for (var dpi = 0; dpi < decompProviderOrder.length; dpi++) {
      var tryDecompProv = decompProviderOrder[dpi];
      try {
        decompRaw = await llm.chatWithProvider(tryDecompProv, decompInstr.systemPrompt, decompInstr.userMessage, {
          maxTokens: decompInstr.maxTokens || 2048,
          agentTag: '_decompose',
        });
        if (dpi > 0) {
          console.log('\x1b[36m[DECOMPOSE]  \x1b[0m' + colors.yellow + 'Fallback: used ' + tryDecompProv + ' (primary ' + decompProvider + ' unavailable)' + colors.reset);
        }
        decompProvider = tryDecompProv;
        break;
      } catch (decompErr) {
        var isDecompRetryable = decompErr.message && (
          decompErr.message.includes('429') ||
          decompErr.message.includes('529') ||
          decompErr.message.includes('overloaded') ||
          decompErr.message.includes('Overloaded') ||
          decompErr.message.includes('RESOURCE_EXHAUSTED') ||
          decompErr.message.includes('rate')
        );
        if (isDecompRetryable && dpi < decompProviderOrder.length - 1) {
          console.log('\x1b[36m[DECOMPOSE]  \x1b[0m' + colors.yellow + tryDecompProv + ' unavailable (' +
            (decompErr.message.includes('529') || decompErr.message.includes('overloaded') || decompErr.message.includes('Overloaded') ? 'overloaded' : 'rate-limited') +
            '), trying ' + decompProviderOrder[dpi + 1] + '...' + colors.reset);
          continue;
        }
        throw decompErr;
      }
    }

    var decomposition = extractJSON(decompRaw);
    if (!decomposition || !decomposition.tasks) {
      console.error(colors.red + 'Failed to parse decomposition from LLM response' + colors.reset);
      if (verbose) console.error(colors.gray + decompRaw.substring(0, 500) + colors.reset);
      process.exit(1);
    }

    var decompStats = getTokenStats(llm, '_decompose');
    console.log('\x1b[36m[DECOMPOSE]  \x1b[0m' + decomposition.tasks.length + ' sub-tasks identified');
    for (var di = 0; di < decomposition.tasks.length; di++) {
      var dt = decomposition.tasks[di];
      console.log('  ' + (di + 1) + '. \x1b[34m[' + (dt.capability || 'general') + ']\x1b[0m ' + dt.description);
    }

    // Send decomposition result to server for intelligent routing
    // PROMETHEUS runs async on local LLM (5-12 min CPU inference).
    // Server returns { routingPending: true } immediately, client polls until done.
    console.log('\x1b[36m[ROUTING]    \x1b[0mServer performing intelligent routing...');
    var decompResult = await client.stepDecomposeResult(sessionId, decomposition, decompStats);

    // PROMETHEUS async polling: server launched PROMETHEUS in background
    if (decompResult && decompResult.routingPending) {
      var routingPollInterval = decompResult.pollIntervalMs || 15000;
      var routingPollMax = 60; // 60 polls × 15s = 15 min max wait
      var routingPollCount = 0;
      console.log(colors.cyan + '[ROUTING]    PROMETHEUS is routing on server (local LLM)... polling every ' + Math.round(routingPollInterval / 1000) + 's' + colors.reset);
      while (decompResult.routingPending && routingPollCount < routingPollMax) {
        routingPollCount++;
        var routingElapsed = Math.round(routingPollCount * routingPollInterval / 1000);
        process.stdout.write(colors.dim + '\r[ROUTING]    Waiting for PROMETHEUS... ' + routingElapsed + 's elapsed' + colors.reset);
        await new Promise(function(r) { setTimeout(r, routingPollInterval); });
        try {
          decompResult = await client.stepDecomposeResult(sessionId, decomposition, decompStats);
        } catch (pollErr) {
          console.error(colors.yellow + '\n[ROUTING]    Poll error: ' + (pollErr.message || pollErr) + ', retrying...' + colors.reset);
        }
      }
      if (decompResult.routingPending) {
        console.error(colors.red + '\n[ROUTING]    PROMETHEUS routing timed out after ' + routingPollMax + ' polls' + colors.reset);
        process.exit(1);
      }
      console.log(''); // newline after \r progress
    }

    var assignments = decompResult.assignments || [];
    var routingLabel = decompResult.routingMethod === 'legion'
      ? '\x1b[1;35mLegion LLM routing\x1b[0m'
      : '\x1b[36mONNX neural routing\x1b[0m';
    console.log('\x1b[36m[ROUTING]    \x1b[0m' + routingLabel + ' \u2192 ' + assignments.length + ' agents deployed');
    for (var ai = 0; ai < assignments.length; ai++) {
      var ag = assignments[ai];
      console.log('  \x1b[1m' + ag.agentName + '\x1b[0m (\x1b[35m' + ag.provider + '/' + ag.model + '\x1b[0m) \x1b[90m\u2192 ' + ag.subTaskId + '\x1b[0m');
    }

    await reportProgress(
      { phase: 'routing', agentsTotal: assignments.length },
      JSON.stringify({ type: 'agents_assigned', agents: assignments.map(function(a) { return { name: a.agentName, provider: a.provider, model: a.model, subTaskId: a.subTaskId }; }) })
    );

    // Liara v2: Decomposition collapse — force all agents onto a single task
    // so they directly collide instead of working on separate sub-topics.
    // We merge all task descriptions into one comprehensive task.
    var liaraMode = !!options.liaraMode;
    if (liaraMode && decomposition.tasks.length > 1) {
      var mergedDesc = decomposition.tasks.map(function(t, idx) {
        return (idx + 1) + ') ' + t.description;
      }).join('\n');
      var collapsedTask = {
        id: 't1',
        description: 'Analyze the following question from your assigned perspective, addressing ALL of these aspects:\n' + mergedDesc,
        capability: decomposition.tasks[0].capability || 'data-analysis',
        dependsOn: [],
        priority: 1,
        relevantFiles: [],
      };
      var originalTaskCount = decomposition.tasks.length;
      decomposition.tasks = [collapsedTask];
      console.log('\x1b[35m[LIARA]      \x1b[0mDecomposition collapsed: ' + originalTaskCount + ' tasks \u2192 1 (all agents on same task)');
    }

    var parliamentInfo = decompResult.parliament || null;

    // Display PROMETHEUS decision details
    if (parliamentInfo && parliamentInfo.prometheus) {
      var prom = parliamentInfo.prometheus;
      console.log('\x1b[35m[PARLIAMENT] \x1b[0mPROMETHEUS (\x1b[35m' + prom.model + '\x1b[0m) \u2192 ' +
        prom.agentsSelected + ' agents, ' + prom.roundsDecided + ' rounds' +
        (prom.cassandraEnabled ? ', \x1b[31mCASSANDRA\x1b[0m' : '') +
        (prom.athenaEnabled ? ', \x1b[36mATHENA\x1b[0m' : '') +
        ' | complexity: ' + prom.complexity);
    }

    // ========================================================================
    // Step 2: DELIBERATION ROUNDS
    // ========================================================================
    var round = 1;
    var maxRounds = (sessionConfig.deliberationRounds || decompResult.config?.deliberationRounds) || 3;
    var roundDecision = null;
    var roundLoopExitedCleanly = false;
    var allProposals = [];  // Accumulates ALL proposals across ALL rounds for full transcript
    var serverSaidContinue = true;  // Start true to enter loop for round 1
    var convergenceHistory = [];  // Accumulates convergence data per round for transcript
    var roundDecisions = [];  // Accumulates round decisions for transcript
    var allTribunalMetrics = [];  // Accumulates tribunal metrics per round for transcript

    // Liara Divergence Pressure System v2 — client orchestration support
    var liaraMinRounds = 3;
    var liaraThreshold = null;
    var liaraR1Convergence = null;
    var liaraMinorityAgent = null;
    var liaraMinorityActivated = false;

    // Loop is governed by the SERVER's decision (nextStatus === 'awaiting_round'),
    // not by local maxRounds. The server's convergence engine decides when to stop.
    // Hard safety cap: maxRounds + 2 to prevent infinite loops on server bugs.
    while (serverSaidContinue && round <= maxRounds + 2) {
      console.log('\x1b[33m[ROUND ' + round + ']    \x1b[0mRequesting agent prompts from server...');

      // Get round instructions from server (with retry + tribunal polling)
      // When CASSANDRA runs server-side on local LLM (5-12 min CPU inference),
      // the server returns { tribunalPending: true, pollIntervalMs: 15000 }
      // instead of blocking. Client polls until CASSANDRA finishes.
      var roundInstr;
      var roundStartRetries = 3;
      var roundStartSuccess = false;
      var tribunalPollMax = 60; // 60 polls × 15s = 15 min max wait
      for (var rsr = 0; rsr < roundStartRetries; rsr++) {
        try {
          roundInstr = await client.stepRoundStart(sessionId, round);

          // Tribunal polling: CASSANDRA is running async on server
          if (roundInstr && roundInstr.tribunalPending) {
            var pollInterval = roundInstr.pollIntervalMs || 15000;
            var pollCount = 0;
            console.log(colors.cyan + '[TRIBUNAL] CASSANDRA is deliberating on server (local LLM)... polling every ' + Math.round(pollInterval / 1000) + 's' + colors.reset);
            while (roundInstr.tribunalPending && pollCount < tribunalPollMax) {
              pollCount++;
              var elapsed = Math.round(pollCount * pollInterval / 1000);
              process.stdout.write(colors.dim + '\r[TRIBUNAL] Waiting for CASSANDRA... ' + elapsed + 's elapsed' + colors.reset);
              await new Promise(function(r) { setTimeout(r, pollInterval); });
              roundInstr = await client.stepRoundStart(sessionId, round);
            }
            if (roundInstr.tribunalPending) {
              console.log('\n' + colors.yellow + '[TRIBUNAL] CASSANDRA timed out after ' + tribunalPollMax + ' polls — proceeding without challenges' + colors.reset);
            } else {
              console.log('\n' + colors.green + '[TRIBUNAL] CASSANDRA completed — challenges ready' + colors.reset);
            }
          }

          roundStartSuccess = true;
          break;
        } catch (err) {
          // If server says session is already in awaiting_synthesis, don't retry
          if (err.message && err.message.includes('awaiting_synthesis')) {
            roundLoopExitedCleanly = true;
            break;
          }
          if (rsr < roundStartRetries - 1) {
            console.log(colors.yellow + '[ROUND ' + round + ']    stepRoundStart failed (' + err.message + '), retrying in 5s... (attempt ' + (rsr + 2) + '/' + roundStartRetries + ')' + colors.reset);
            await new Promise(function(r) { setTimeout(r, 5000); });
          } else {
            console.error(colors.red + 'Failed to get round instructions after ' + roundStartRetries + ' attempts: ' + err.message + colors.reset);
          }
        }
      }
      if (!roundStartSuccess) break;

      var agentInstructions = roundInstr.agents || [];
      // Display grounding info if server injected verified facts
      if (roundInstr.groundingSummary) {
        console.log('\x1b[36m[GROUNDING] \x1b[0m' + roundInstr.groundingSummary);
      }

      // === LIARA v2: Divergence Pressure Injection (client-side) ===
      if (liaraMode) {
        var nonTribunalAgents = agentInstructions.filter(function(a) {
          return !a.subTaskId || a.subTaskId !== '__tribunal__';
        });

        if (round === 1) {
          // Minority resilience injection: pick one random non-tribunal agent
          // Activation probability: depends on prompt difficulty hint
          var difficultyHint = (prompt.match && prompt.match(/\[difficulty:(\w+)\]/)) ? RegExp.$1 : 'medium';
          var minorityProb = difficultyHint === 'hard' ? 0.75 : (difficultyHint === 'medium' ? 0.40 : 0);
          if (nonTribunalAgents.length > 1 && Math.random() < minorityProb) {
            var minorityIdx = Math.floor(Math.random() * nonTribunalAgents.length);
            liaraMinorityAgent = nonTribunalAgents[minorityIdx].agentName;
            liaraMinorityActivated = true;
            var minorityInstr = nonTribunalAgents[minorityIdx];
            minorityInstr.userMessage = (minorityInstr.userMessage || '') +
              '\n\n[MINORITY RESILIENCE ASSIGNMENT]\n' +
              'You have been designated as the DISSENTING VOICE for this deliberation.\n' +
              'You are expected to remain minority unless a demonstrable factual contradiction invalidates your reasoning.\n' +
              'You may reference other agents\' arguments, but your conclusions must derive from YOUR framework.\n' +
              'Social pressure, majority consensus, or appeals to "balance" are not sufficient reasons to change your position.\n' +
              'If you DO change your mind, explain the SPECIFIC factual claim that contradicted your reasoning.\n' +
              'If your reasoning holds, your final statement should clearly articulate why your framework reaches a different conclusion.';
            console.log('\x1b[35m[LIARA]      \x1b[0mMinority resilience assigned to \x1b[1m' + liaraMinorityAgent + '\x1b[0m');
          }
        }

        if (round === 2 && difficultyHint !== 'easy') {
          // Adversarial R2: inject stress test framing into all non-tribunal agents (skip for easy/factual prompts)
          for (var lr2i = 0; lr2i < nonTribunalAgents.length; lr2i++) {
            var lr2Agent = nonTribunalAgents[lr2i];
            lr2Agent.userMessage = '[DELIBERATION ROUND 2 — ADVERSARIAL STRESS TEST]\n' +
              'You are DEFENDING your position after reviewing other agents\' proposals.\n\n' +
              'CRITICAL RULES:\n' +
              '1. You may CITE other frameworks\' findings, but your CONCLUSIONS must derive from your own evaluation criteria\n' +
              '2. If you adopt another framework\'s criteria as your primary basis for a conclusion, you have FAILED your assignment\n' +
              '3. Identify the WEAKEST argument among other proposals — explain what evidence would disprove it\n' +
              '4. For each point of disagreement, clarify whether the disagreement is factual or stems from different evaluation frameworks\n' +
              '5. Do NOT seek compromise. Seek CLARITY about where frameworks genuinely produce incompatible conclusions\n' +
              '6. For each conclusion, explicitly state which of YOUR primary criteria it derives from (epistemic traceability)\n' +
              '7. If you find yourself recommending the same action as another agent, STOP — explain why your framework independently reaches that conclusion using DIFFERENT criteria, or acknowledge that your framework cannot address this aspect\n' +
              '8. Using [ACCEPT] on a challenge means you accept the EVIDENCE presented, NOT that you adopt the other framework\'s conclusions or recommendations\n' +
              '9. A "hybrid approach" or "balanced solution" is NOT a valid conclusion from a single framework — it is framework contamination\n\n' +
              'Your goal: expose the REAL disagreements — distinguish factual disputes from framework-level incompatibilities.\n' +
              'If all agents converge on the same recommendation, the deliberation has FAILED.\n\n' +
              '---\n\n' + (lr2Agent.userMessage || '');
          }
          console.log('\x1b[35m[LIARA]      \x1b[0mAdversarial stress test injected for Round 2');
        }

        if (round >= 3 && difficultyHint !== 'easy') {
          // Final Position R3: inject final defense framing into ALL non-tribunal agents (skip for easy/factual prompts)
          for (var lr3i = 0; lr3i < nonTribunalAgents.length; lr3i++) {
            var lr3Agent = nonTribunalAgents[lr3i];
            lr3Agent.userMessage = '[DELIBERATION ROUND 3 — FINAL POSITION]\n' +
              'This is your LAST statement. The record of this deliberation will be permanent.\n\n' +
              'CRITICAL RULES:\n' +
              '1. If you concede ANY point, state the EXACT evidence that changed your mind — not "the majority agrees"\n' +
              '2. If you maintain your position, explain what SPECIFIC evidence the majority would need to present to change your mind (falsifiability)\n' +
              '3. Do NOT synthesize others\' views into yours — state YOUR conclusion clearly\n' +
              '4. If your framework cannot address a question raised by others, say "my framework does not evaluate this" rather than adopting their criteria\n' +
              '5. A minority position held with rigorous internal logic is MORE valuable than a majority position held by social pressure\n\n' +
              'The quality of this deliberation depends on honest disagreement, not elegant consensus.\n\n' +
              '---\n\n' + (lr3Agent.userMessage || '');
          }
          console.log('\x1b[35m[LIARA]      \x1b[0mFinal position framing injected for Round ' + round);
        }
      }

      // === PARLIAMENT: CASSANDRA executed server-side on local LLM ===
      // When the server has a local LLM, CASSANDRA runs server-side and we get Phase B directly.
      if (roundInstr.cassandraServerSide) {
        console.log('\x1b[35m[PARLIAMENT] \x1b[0mCASSANDRA executed server-side (local LLM) \u2014 ' + (roundInstr.cassandraChallengesCount || '?') + ' challenges generated');
      }

      // === THE TRIBUNAL: Two-Phase Round 2 (fallback when server LLM unavailable) ===
      // If server signals tribunalPhaseA, CASSANDRA runs alone first on client.
      // Her challenges are submitted, then we re-fetch instructions for Phase B.
      if (roundInstr.tribunalPhaseA) {
        console.log('\x1b[35m[TRIBUNAL]   \x1b[0mPhase A: CASSANDRA analyzing ' + (roundInstr.agentCount || '?') + ' proposals...');

        // Fallback: CASSANDRA executed client-side (only when server local LLM unavailable)
        var cassandraInstr = agentInstructions[0]; // Server returns only CASSANDRA for Phase A
        if (cassandraInstr) {
          var cassandraStart = Date.now();
          var cassandraResult;
          try {
            var cassProv = cassandraInstr.provider || userProvider;
            console.log('\x1b[35m[TRIBUNAL]   \x1b[0mCASSANDRA \u2192 ' + cassProv + ' (server LLM unavailable fallback)');
            cassandraResult = await llm.chatWithProvider(cassProv, cassandraInstr.systemPrompt, cassandraInstr.userMessage, {
              maxTokens: cassandraInstr.maxTokens || 4096,
              agentTag: 'CASSANDRA',
            });
          } catch (cassErr) {
            console.error('\x1b[31m[TRIBUNAL]   CASSANDRA failed: ' + cassErr.message + '\x1b[0m');
            cassandraResult = 'Error: ' + cassErr.message;
          }

          var cassDuration = Date.now() - cassandraStart;
          var cassStats = getTokenStats(llm, 'CASSANDRA');
          var cassParsed = parseStructuredOutput(cassandraResult);
          var cassContent = typeof cassParsed.answer === 'string' ? cassParsed.answer : JSON.stringify(cassParsed.answer);

          console.log('  \x1b[1mCASSANDRA\x1b[0m \x1b[35m' + Math.round(cassDuration / 1000) + 's\x1b[0m (tribunal analysis)');

          // Submit CASSANDRA's challenges to server for parsing
          var cassandraProposal = [{
            agentName: 'CASSANDRA',
            subTaskId: '__tribunal__',
            content: cassContent,
            rawContent: cassandraResult,
            confidence: cassParsed.confidence,
            riskFlags: cassParsed.riskFlags || [],
            reasoningSummary: typeof cassParsed.reasoningSummary === 'string' ? cassParsed.reasoningSummary : '',
            inputTokens: cassStats.inputTokens,
            outputTokens: cassStats.outputTokens,
            durationMs: cassDuration,
            provider: cassandraInstr.provider || userProvider,
            model: cassandraInstr.model || 'unknown',
          }];

          try {
            var phaseAResult = await client.stepRoundResult(sessionId, round, cassandraProposal);
            var challengeCount = phaseAResult.tribunalChallengesGenerated || 0;
            console.log('\x1b[35m[TRIBUNAL]   \x1b[0mChallenges generated: ' + challengeCount);
          } catch (phaseAErr) {
            console.error('\x1b[31m[TRIBUNAL]   Phase A submission failed: ' + phaseAErr.message + '\x1b[0m');
          }

          // Re-fetch instructions for Phase B (remaining agents with challenges injected)
          console.log('\x1b[35m[TRIBUNAL]   \x1b[0mPhase B: agents responding to challenges...');
          try {
            roundInstr = await client.stepRoundStart(sessionId, round);
            agentInstructions = roundInstr.agents || [];
          } catch (phaseBErr) {
            console.error('\x1b[31m[TRIBUNAL]   Phase B fetch failed: ' + phaseBErr.message + '\x1b[0m');
            break;
          }
        }
      }

      console.log('\x1b[33m[ROUND ' + round + ']    \x1b[0mExecuting ' + agentInstructions.length + ' agents locally...');

      // Immersive: show cross-reading (who's reading whom) for round 2+
      if (immersive && round > 1) {
        var allAgentNames = agentInstructions.map(function(a) { return a.agentName; });
        for (var cri = 0; cri < agentInstructions.length; cri++) {
          var otherNames = allAgentNames.filter(function(n) { return n !== agentInstructions[cri].agentName; });
          renderCrossReading(agentInstructions[cri].agentName, otherNames);
        }
        console.log();
      }

      await reportProgress(
        { phase: 'round_' + round, agentsTotal: agentInstructions.length, agentsCompleted: 0 },
        'Round ' + round + ': executing ' + agentInstructions.length + ' agents'
      );

      // Execute agents locally — provider-grouped parallel execution
      // Each provider runs its agents sequentially (avoids RPM rate limits)
      // but different providers run in parallel (max throughput)
      var proposals = [];
      var agentsCompleted = 0;

      async function executeSingleAgent(agentInstr) {
          var agentStart = Date.now();
          var agentTag = agentInstr.agentName;
          try {
            // Parliament agents (CASSANDRA, PROMETHEUS, ATHENA) are executed SERVER-SIDE
            // on the local LLM. If they appear here, the server's local LLM was unavailable
            // and the server fell back to client-side execution — use user's provider.
            var primaryProvider = agentInstr.provider || userProvider;
            // Build provider fallback order: primary first, then remaining available providers
            var agentProviderOrder = [primaryProvider].concat(
              availableProviders.filter(function(p) { return p !== primaryProvider; })
            );
            var agentProvider = primaryProvider;
            var agentResponse;
            for (var api = 0; api < agentProviderOrder.length; api++) {
              var tryAgentProv = agentProviderOrder[api];
              try {
                agentResponse = await llm.chatWithProvider(tryAgentProv, agentInstr.systemPrompt, agentInstr.userMessage, {
                  maxTokens: agentInstr.maxTokens || 4096,
                  agentTag: agentTag,
                });
                if (api > 0) {
                  console.log('    \x1b[33m\u21B3 ' + agentTag + ' fallback: used ' + tryAgentProv + ' (' + primaryProvider + ' unavailable)\x1b[0m');
                }
                agentProvider = tryAgentProv;
                break;
              } catch (agentProvErr) {
                var isAgentRetryable = agentProvErr.message && (
                  agentProvErr.message.includes('429') ||
                  agentProvErr.message.includes('529') ||
                  agentProvErr.message.includes('overloaded') ||
                  agentProvErr.message.includes('Overloaded') ||
                  agentProvErr.message.includes('RESOURCE_EXHAUSTED') ||
                  agentProvErr.message.includes('rate')
                );
                if (isAgentRetryable && api < agentProviderOrder.length - 1) {
                  continue;
                }
                throw agentProvErr;
              }
            }

            var agentDuration = Date.now() - agentStart;
            var stats = getTokenStats(llm, agentTag);

            // Parse structured output (confidence, risk_flags, reasoning_summary)
            var parsedOutput = parseStructuredOutput(agentResponse);

            // Ensure content is always a string (never an object from JSON parsing)
            var answerContent = typeof parsedOutput.answer === 'string'
              ? parsedOutput.answer
              : JSON.stringify(parsedOutput.answer);

            var proposal = {
              agentName: agentInstr.agentName,
              subTaskId: agentInstr.subTaskId || '',
              round: round,
              content: answerContent,
              rawContent: agentResponse,
              confidence: parsedOutput.confidence,
              riskFlags: parsedOutput.riskFlags,
              reasoningSummary: typeof parsedOutput.reasoningSummary === 'string' ? parsedOutput.reasoningSummary : '',
              inputTokens: stats.inputTokens,
              outputTokens: stats.outputTokens,
              durationMs: agentDuration,
              provider: agentProvider,
              model: agentInstr.model || 'unknown',
            };

            agentsCompleted++;
            var confPct = Math.round((proposal.confidence || 0.7) * 100);
            var confColor = confPct >= 80 ? '\x1b[32m' : confPct >= 50 ? '\x1b[33m' : '\x1b[31m';
            var durSec = Math.round(agentDuration / 1000);
            console.log('  \x1b[1m' + agentInstr.agentName + '\x1b[0m ' + confColor + confPct + '% conf\x1b[0m (' + durSec + 's, ' + agentProvider + ')');
            if (!immersive && parsedOutput.reasoningSummary) {
              console.log('    \x1b[90m\u2514 ' + parsedOutput.reasoningSummary + '\x1b[0m');
            }
            // Immersive: full speech bubble with agent's complete response
            renderAgentBubble(agentInstr.agentName, agentProvider, answerContent, round);

            await reportProgress(
              { agentsCompleted: agentsCompleted, currentAgent: agentInstr.agentName },
              JSON.stringify({ type: 'agent_complete', agentName: agentInstr.agentName, confidence: proposal.confidence, durationMs: agentDuration, provider: agentProvider, riskFlags: proposal.riskFlags, reasoningSummary: proposal.reasoningSummary })
            );

            return proposal;
          } catch (err) {
            agentsCompleted++;
            console.error('  \x1b[31m' + agentInstr.agentName + ': ' + err.message + '\x1b[0m');
            return {
              agentName: agentInstr.agentName,
              subTaskId: agentInstr.subTaskId || '',
              content: 'Error: ' + err.message,
              rawContent: 'Error: ' + err.message,
              confidence: 0,
              riskFlags: ['execution_error'],
              reasoningSummary: 'Agent failed: ' + err.message,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: Date.now() - agentStart,
              provider: agentInstr.provider || userProvider,
              model: agentInstr.model || 'unknown',
            };
          }
      }

      // Group agents by provider: each provider runs sequentially (RPM safety),
      // but providers run in parallel (max throughput, no shared state conflict)
      var providerGroups = {};
      for (var gi = 0; gi < agentInstructions.length; gi++) {
        var prov = agentInstructions[gi].provider || userProvider;
        if (!providerGroups[prov]) providerGroups[prov] = [];
        providerGroups[prov].push(agentInstructions[gi]);
      }

      var providerPromises = Object.keys(providerGroups).map(function(provKey) {
        return (async function() {
          var provAgents = providerGroups[provKey];
          var provResults = [];
          for (var si = 0; si < provAgents.length; si++) {
            var result = await executeSingleAgent(provAgents[si]);
            provResults.push(result);
          }
          return provResults;
        })();
      });

      var providerResults = await Promise.all(providerPromises);
      for (var pri = 0; pri < providerResults.length; pri++) {
        proposals = proposals.concat(providerResults[pri]);
      }

      // Accumulate all proposals across rounds for full transcript
      for (var api2 = 0; api2 < proposals.length; api2++) {
        allProposals.push(proposals[api2]);
      }

      // Send proposals to server for convergence measurement (with retry)
      console.log('\x1b[33m[ROUND ' + round + ']    \x1b[0mServer measuring convergence...');
      var roundResult;
      var roundResultRetries = 2;
      var roundResultSuccess = false;
      for (var rrr = 0; rrr < roundResultRetries; rrr++) {
        try {
          roundResult = await client.stepRoundResult(sessionId, round, proposals);
          roundResultSuccess = true;
          break;
        } catch (err) {
          if (rrr < roundResultRetries - 1) {
            console.log(colors.yellow + '[ROUND ' + round + ']    stepRoundResult failed (' + err.message + '), retrying in 3s... (attempt ' + (rrr + 2) + '/' + roundResultRetries + ')' + colors.reset);
            await new Promise(function(r) { setTimeout(r, 3000); });
          } else {
            console.error(colors.red + 'Failed to submit round result after ' + roundResultRetries + ' attempts: ' + err.message + colors.reset);
          }
        }
      }
      if (!roundResultSuccess) break;

      // Display convergence (Advanced Convergence Engine)
      var effectiveConv = roundResult.effectiveConvergence || roundResult.convergence || 0;
      var rawConv = roundResult.convergence || 0;
      var convPct = Math.round(effectiveConv * 100);
      var rawPct = Math.round(rawConv * 100);
      var convBarWidth = 16;
      var convFilled = Math.round(convPct / 100 * convBarWidth);
      var convBar = '\u2588'.repeat(convFilled) + '\u2591'.repeat(convBarWidth - convFilled);

      // Line 1: Convergence bar with effective % and method
      console.log('\x1b[33m[ROUND ' + round + ']\x1b[0m    Convergence: ' + convBar + ' ' + convPct + '% (effective, ' + (roundResult.method || 'jaccard') + ')');

      // Line 2: Raw + complementarity breakdown
      var compLine = '             Raw: ' + rawPct + '%';
      if (roundResult.complementarity) {
        var compBoost = Math.round(roundResult.complementarity.score * 30);
        var contraPenalty = Math.round(roundResult.complementarity.contradictions * 20);
        if (compBoost > 0) compLine += ' | Complementarity: \x1b[32m+' + compBoost + '% boost\x1b[0m';
        if (contraPenalty > 0) compLine += ' | Contradictions: \x1b[31m-' + contraPenalty + '% penalty\x1b[0m';
        else compLine += ' | Contradictions: \x1b[32m0\x1b[0m';
        if (roundResult.complementarity.realConflicts > 0) {
          compLine += ' \x1b[31m(' + roundResult.complementarity.realConflicts + ' real conflict(s))\x1b[0m';
        }
      }
      console.log(compLine);

      // Line 3: Clusters + outliers
      if (roundResult.clusters) {
        var clusterLine = '             Clusters: ';
        var clusterStr = roundResult.clusters.strength !== undefined
          ? 'strength ' + Math.round(roundResult.clusters.strength * 100) + '%'
          : '';
        if (roundResult.clusters.outliers && roundResult.clusters.outliers.length > 0) {
          clusterLine += clusterStr + ' + outlier(s): \x1b[33m' + roundResult.clusters.outliers.join(', ') + '\x1b[0m';
        } else {
          clusterLine += clusterStr + ' \x1b[32m(all agents in consensus)\x1b[0m';
        }
        console.log(clusterLine);
      }

      // Line 4: Trajectory
      if (roundResult.trajectory) {
        var trendArrow = roundResult.trajectory.trend === 'improving' ? '\x1b[32m\u2191\x1b[0m'
          : roundResult.trajectory.trend === 'declining' ? '\x1b[31m\u2193\x1b[0m'
          : roundResult.trajectory.trend === 'plateau' ? '\x1b[33m\u2192\x1b[0m'
          : roundResult.trajectory.trend === 'oscillating' ? '\x1b[33m\u223F\x1b[0m'
          : '\x1b[90m\u2014\x1b[0m';
        var velocityStr = roundResult.trajectory.velocity !== undefined
          ? (roundResult.trajectory.velocity >= 0 ? '+' : '') + (roundResult.trajectory.velocity * 100).toFixed(1) + '% velocity'
          : '';
        console.log('             Trajectory: ' + trendArrow + ' ' + roundResult.trajectory.trend + (velocityStr ? ' (' + velocityStr + ')' : ''));
      } else if (round === 1) {
        console.log('             Trajectory: \x1b[90m\u2014 (first round)\x1b[0m');
      }

      // Display Tribunal metrics if present (after Phase B convergence measurement)
      if (roundResult.tribunalMetrics) {
        var tm = roundResult.tribunalMetrics;
        var outcomeColors = {
          emergence: '\x1b[32m',        // green
          covert_leadership: '\x1b[33m', // yellow
          destructive: '\x1b[31m',       // red
          ritual: '\x1b[90m',           // gray
          mixed: '\x1b[36m',            // cyan
        };
        var outcomeColor = outcomeColors[tm.tribunalOutcome] || '\x1b[0m';

        console.log('\x1b[35m[TRIBUNAL]\x1b[0m   Challenges: ' + (tm.challengesParsed || 0) + '/' + (tm.challengesGenerated || 0) + ' parsed');
        console.log('             Responses: \x1b[32mACCEPT ' + (tm.acceptCount || 0) + '\x1b[0m / \x1b[33mREBUT ' + (tm.rebutCount || 0) + '\x1b[0m / \x1b[36mMITIGATE ' + (tm.mitigateCount || 0) + '\x1b[0m / \x1b[90mIGNORED ' + (tm.ignoredCount || 0) + '\x1b[0m');
        if (tm.ritualAcceptCount > 0) {
          console.log('             \x1b[33mRitual ACCEPTs: ' + tm.ritualAcceptCount + ' (ACCEPT without real revision)\x1b[0m');
        }
        console.log('             Semantic delta: ' + (tm.meanSemanticDelta !== undefined ? (tm.meanSemanticDelta * 100).toFixed(1) + '%' : 'N/A') + ' (R1 vs R2 revision depth)');
        console.log('             Outcome: ' + outcomeColor + (tm.tribunalOutcome || 'unknown').toUpperCase() + '\x1b[0m');
      }

      await reportProgress(
        { phase: 'round_' + round },
        JSON.stringify({ type: 'convergence_update', round: round, convergence: roundResult.convergence, method: roundResult.method, divergentPairs: roundResult.divergentPairs })
      );

      // Accumulate convergence history for full transcript
      convergenceHistory.push({
        round: round,
        convergence: roundResult.convergence || 0,
        effectiveConvergence: roundResult.effectiveConvergence || roundResult.convergence || 0,
        method: roundResult.method || 'jaccard',
        divergentPairs: roundResult.divergentPairs || [],
        complementarity: roundResult.complementarity || null,
        clusters: roundResult.clusters || null,
        trajectory: roundResult.trajectory || null,
      });

      // Liara v2: compute dynamic convergence threshold after R1
      if (liaraMode && round === 1) {
        var r1Conv = roundResult.convergence || 0;
        liaraR1Convergence = r1Conv;
        liaraThreshold = Math.min(0.96, Math.max(0.85, 0.80 + (r1Conv * 0.20)));
        console.log('\x1b[35m[LIARA]      \x1b[0mR1 convergence: ' + (r1Conv * 100).toFixed(0) + '% \u2192 dynamic threshold: ' + (liaraThreshold * 100).toFixed(0) + '%');
      }

      // Accumulate tribunal metrics if present
      if (roundResult.tribunalMetrics) {
        allTribunalMetrics.push({
          round: round,
          ...roundResult.tribunalMetrics,
        });
      }

      // Check decision — decision can be object {mode, reason} or string
      roundDecision = roundResult.decision;
      var decisionMode = typeof roundDecision === 'object' && roundDecision !== null
        ? (roundDecision.mode || 'standard')
        : (typeof roundDecision === 'string' ? roundDecision : 'standard');
      var decisionReason = typeof roundDecision === 'object' && roundDecision !== null
        ? (roundDecision.reason || '')
        : '';

      // Accumulate round decisions for full transcript
      roundDecisions.push({
        round: round,
        mode: decisionMode,
        reason: decisionReason,
        nextStatus: roundResult.nextStatus || 'unknown',
      });

      if (roundResult.nextStatus !== 'awaiting_round') {
        // Liara v2: force minimum rounds even if server says stop
        if (liaraMode && round < liaraMinRounds) {
          console.log('\x1b[35m[LIARA]      \x1b[0mServer wants to stop at round ' + round + ', forcing round ' + (round + 1) + ' (min ' + liaraMinRounds + ')');
          try {
            await client.stepForceTransition(sessionId, 'awaiting_round');
            round = round + 1;
            continue;
          } catch (forceErr) {
            console.log('\x1b[33m[LIARA]      Force transition failed: ' + forceErr.message + ', proceeding to synthesis\x1b[0m');
          }
        }

        // Decision: stop deliberation — server has transitioned to awaiting_synthesis
        roundLoopExitedCleanly = true;
        serverSaidContinue = false;
        if (decisionMode) {
          var isSkipMode = decisionMode === 'skip_consensus' || decisionMode === 'skip';
          var decisionIcon = isSkipMode ? '\x1b[32m\u2713 CONSENSUS REACHED\x1b[0m' :
            '\u27f3 ' + String(decisionMode).toUpperCase().replace('_', ' ');
          console.log('\n' + decisionIcon + (decisionReason ? ' \u2014 ' + decisionReason : ''));
        }
        break;
      }

      // Server says continue — respect its decision regardless of local maxRounds
      round = roundResult.nextRound || (round + 1);

      // Show round decision for continuation
      if (decisionMode) {
        var modeIcons = { standard: '\u27f3', mandatory: '\u2757', arbitrator: '\u2696', targeted_mediation: '\u2694' };
        var mIcon = modeIcons[decisionMode] || '\u27f3';
        console.log('\n' + mIcon + ' Round ' + round + ': \x1b[1m' + String(decisionMode).toUpperCase().replace('_', ' ') + '\x1b[0m' + (decisionReason ? ' \u2014 ' + decisionReason : ''));
      }
    }

    // ========================================================================
    // Step 3: SYNTHESIS
    // ========================================================================

    // If the round loop exited due to an error (not a clean convergence decision),
    // the session is still in 'awaiting_round' state. Force-transition to synthesis
    // by asking the server to skip remaining rounds.
    if (!roundLoopExitedCleanly) {
      console.log(colors.yellow + '[SYNTHESIS]  Round loop ended unexpectedly, forcing transition to synthesis...' + colors.reset);
      try {
        await client.stepForceTransition(sessionId, 'awaiting_synthesis');
      } catch (transErr) {
        // If force-transition is not available, try stepSynthesize directly —
        // the server may have already transitioned
        if (verbose) console.log(colors.gray + '  Force transition unavailable: ' + transErr.message + colors.reset);
      }
    }

    console.log('\x1b[36m[SYNTHESIS]  \x1b[0mRequesting synthesis prompt from server...');
    var synthInstr = await client.stepSynthesize(sessionId);

    // Liara v2: Anti-consensus synthesis injection (language-aware)
    if (liaraMode && synthInstr.userMessage) {
      // Detect language from original prompt for injection language matching
      var _acWords = prompt.split(/\s+/).filter(function(w) { return w.length > 1; });
      var _acItalianPattern = /\b(il|la|le|lo|gli|un|una|del|della|delle|dei|degli|nel|nella|che|per|con|tra|fra|questo|questa|questi|queste|come|anche|sono|essere|avere|fare|più|molto|ogni|tutto|tutti|quale|quali|quando|dove|perché|quindi|però|oppure|ancora|già|sempre|dopo|prima|mentre|invece|senza|fino|durante|secondo|attraverso|oltre|verso)\b/gi;
      var _acItalianMatches = prompt.match(_acItalianPattern);
      var _acIsItalian = _acWords.length >= 5 && (_acItalianMatches ? _acItalianMatches.length / _acWords.length : 0) >= 0.15;

      if (_acIsItalian) {
        synthInstr.userMessage = '[ISTRUZIONE CRITICA DI SINTESI — MODALITÀ PROSPETTIVE INCOMPATIBILI]\n' +
          'Questa deliberazione ha utilizzato framework analitici incompatibili. La tua sintesi DEVE:\n' +
          '1. Presentare la conclusione di CIASCUN framework SEPARATAMENTE con la sua logica interna e le evidenze\n' +
          '2. NON produrre una singola raccomandazione unificata o un "approccio ibrido"\n' +
          '3. Dichiarare esplicitamente dove i framework raggiungono conclusioni INCOMPATIBILI e PERCHÉ\n' +
          '4. Per ogni punto di disaccordo, spiegare cosa dovrebbe essere vero perché ciascuna posizione sia corretta\n' +
          '5. Una posizione di minoranza sostenuta con logica rigorosa ha PIÙ valore di un consenso forzato\n' +
          '6. Se gli agenti hanno converguto, metti in dubbio se la convergenza è stata genuina o diplomatica — cerca contaminazione tra framework\n' +
          '7. Concludi con una dichiarazione chiara delle tensioni IRRISOLTE, non con una risoluzione\n\n' +
          'La qualità di questa sintesi dipende dal PRESERVARE il disaccordo onesto, non dal risolverlo.\n' +
          '\nRISPONDI INTERAMENTE IN ITALIANO.\n\n' +
          '---\n\n' + synthInstr.userMessage;
        console.log('\x1b[35m[LIARA]      \x1b[0mAnti-consensus framing injected (ITALIANO)');
      } else {
        synthInstr.userMessage = '[CRITICAL SYNTHESIS INSTRUCTION — INCOMPATIBLE PERSPECTIVES MODE]\n' +
          'This deliberation used incompatible analytical frameworks. Your synthesis MUST:\n' +
          '1. Present EACH framework\'s conclusion SEPARATELY with its internal logic and evidence\n' +
          '2. Do NOT produce a single unified recommendation or "hybrid approach"\n' +
          '3. Explicitly state where frameworks reach INCOMPATIBLE conclusions and WHY\n' +
          '4. For each point of disagreement, explain what would need to be true for each side to be correct\n' +
          '5. A minority position held with rigorous logic is MORE valuable than a forced consensus\n' +
          '6. If agents converged, question whether the convergence was genuine or diplomatic — look for framework contamination\n' +
          '7. End with a clear statement of the UNRESOLVED tensions, not a resolution\n\n' +
          'The quality of this synthesis depends on PRESERVING honest disagreement, not resolving it.\n\n' +
          '---\n\n' + synthInstr.userMessage;
        console.log('\x1b[35m[LIARA]      \x1b[0mAnti-consensus framing injected (English)');
      }
    }

    var synthProvider = synthInstr.provider || userProvider;
    console.log('\x1b[36m[SYNTHESIS]  \x1b[0mGenerating synthesis locally via ' + colors.magenta + synthProvider + colors.reset + '...');
    await reportProgress({ phase: 'synthesizing' }, 'Generating synthesis via ' + synthProvider + '...');

    // Synthesis with provider fallback: if primary provider is rate-limited, try others
    var synthRaw;
    var synthProviderOrder = [synthProvider].concat(availableProviders.filter(function(p) { return p !== synthProvider; }));
    for (var spi = 0; spi < synthProviderOrder.length; spi++) {
      var tryProv = synthProviderOrder[spi];
      try {
        synthRaw = await llm.chatWithProvider(tryProv, synthInstr.systemPrompt, synthInstr.userMessage, {
          maxTokens: synthInstr.maxTokens || 16384,
          agentTag: '_synthesis',
        });
        if (tryProv !== synthProvider) {
          console.log('\x1b[36m[SYNTHESIS]  \x1b[0m' + colors.yellow + 'Fallback: used ' + tryProv + ' (primary ' + synthProvider + ' rate-limited)' + colors.reset);
        }
        synthProvider = tryProv;
        break;
      } catch (synthErr) {
        var isSynthRetryable = synthErr.message && (synthErr.message.includes('429') || synthErr.message.includes('529') || synthErr.message.includes('overloaded') || synthErr.message.includes('Overloaded') || synthErr.message.includes('RESOURCE_EXHAUSTED') || synthErr.message.includes('rate') || synthErr.message.includes('max_tokens') || synthErr.message.includes('invalid_request'));
        if (isSynthRetryable && spi < synthProviderOrder.length - 1) {
          console.log('\x1b[36m[SYNTHESIS]  \x1b[0m' + colors.yellow + tryProv + ' failed, trying ' + synthProviderOrder[spi + 1] + '...' + colors.reset);
          continue;
        }
        throw synthErr;
      }
    }

    var synthStats = getTokenStats(llm, '_synthesis');
    var synthResponse = await client.stepSynthesizeResult(sessionId, synthRaw, synthStats);
    console.log('\x1b[36m[SYNTHESIS]  \x1b[0mSynthesis complete (' + synthRaw.length + ' chars)');
    renderSynthBubble(synthProvider, synthRaw);

    // Display ATHENA audit result if it ran
    var athenaInfo = synthResponse && synthResponse.athena;
    if (athenaInfo && athenaInfo.active) {
      var athenaVerdict = athenaInfo.verdict === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFLAG\x1b[0m';
      console.log('\x1b[35m[PARLIAMENT] \x1b[0mATHENA (\x1b[35m' + (athenaInfo.model || 'qwen-7b') + '\x1b[0m) audit: ' + athenaVerdict);
      if (athenaInfo.verdict === 'FLAG') {
        var athenaIssues = (athenaInfo.omissions || []).concat(athenaInfo.droppedObjections || []);
        for (var athi = 0; athi < athenaIssues.length; athi++) {
          console.log('  \x1b[31m\u26a0\x1b[0m ' + athenaIssues[athi]);
        }
      }
    }

    // ========================================================================
    // Step 4: VALIDATION
    // ========================================================================
    console.log('\x1b[35m[VALIDATION] \x1b[0mRequesting validation prompts from server...');
    var valInstr = await client.stepValidate(sessionId);

    var validators = valInstr.validators || [];
    console.log('\x1b[35m[VALIDATION] \x1b[0mExecuting ' + validators.length + ' validator(s) locally...');
    await reportProgress({ phase: 'evaluating', agentsTotal: validators.length, agentsCompleted: 0 }, 'Validating synthesis...');

    var validationScores = [];
    for (var vi = 0; vi < validators.length; vi++) {
      var val = validators[vi];
      var valProvider = val.provider || userProvider;
      try {
        // Validation with provider fallback on rate limit
        var valRaw;
        var valProvOrder = [valProvider].concat(availableProviders.filter(function(p) { return p !== valProvider; }));
        for (var vpi = 0; vpi < valProvOrder.length; vpi++) {
          try {
            valRaw = await llm.chatWithProvider(valProvOrder[vpi], val.systemPrompt, val.userMessage, {
              maxTokens: val.maxTokens || 2048,
              agentTag: '_validator_' + vi,
            });
            if (vpi > 0) {
              console.log('  \x1b[33mValidator ' + (vi + 1) + ': fallback ' + valProvOrder[vpi] + ' (primary ' + valProvider + ' rate-limited)\x1b[0m');
            }
            valProvider = valProvOrder[vpi];
            break;
          } catch (valRetryErr) {
            var isValRL = valRetryErr.message && (valRetryErr.message.includes('429') || valRetryErr.message.includes('529') || valRetryErr.message.includes('overloaded') || valRetryErr.message.includes('Overloaded') || valRetryErr.message.includes('RESOURCE_EXHAUSTED') || valRetryErr.message.includes('rate'));
            if (isValRL && vpi < valProvOrder.length - 1) continue;
            throw valRetryErr;
          }
        }

        // Parse validation response: expect JSON with score + reasoning
        var valParsed = extractJSON(valRaw);
        var score = 0.7;
        var reasoning = valRaw;

        if (valParsed && typeof valParsed.score === 'number') {
          score = Math.max(0, Math.min(1, valParsed.score));
          reasoning = valParsed.reasoning || valParsed.explanation || '';
        } else if (valParsed && typeof valParsed.quality === 'number') {
          score = Math.max(0, Math.min(1, valParsed.quality / 100));
          reasoning = valParsed.reasoning || '';
        }

        var valStats = getTokenStats(llm, '_validator_' + vi);
        validationScores.push({
          validatorId: val.id || ('validator_' + vi),
          provider: valProvider,
          model: val.model || llm.model || 'default',
          score: score,
          reasoning: reasoning,
          inputTokens: valStats.inputTokens,
          outputTokens: valStats.outputTokens,
        });

        var scorePct = Math.round(score * 100);
        var scoreColor = scorePct >= 80 ? '\x1b[32m' : scorePct >= 50 ? '\x1b[33m' : '\x1b[31m';
        console.log('  Validator ' + (vi + 1) + ': ' + scoreColor + scorePct + '%\x1b[0m (' + valProvider + ')');
        if (immersive && reasoning) {
          console.log('    \x1b[90m\u2514 ' + reasoning + '\x1b[0m');
        }
      } catch (err) {
        console.error('  \x1b[31mValidator ' + (vi + 1) + ' failed: ' + err.message + '\x1b[0m');
        validationScores.push({
          validatorId: val.id || ('validator_' + vi),
          provider: valProvider,
          model: val.model || llm.model || 'default',
          score: 0.5,
          reasoning: 'Validation failed: ' + err.message,
          inputTokens: 0,
          outputTokens: 0,
        });
      }
    }

    // Evaluate ALL individual proposals for real CI Gain — use the highest LLM-scored as baseline
    // This prevents inflated CI Gain from non-specialist agents with high self-reported confidence
    var bestProposalScore;
    var proposalsToEval = valInstr.proposalValidators || (valInstr.bestProposalValidator ? [valInstr.bestProposalValidator] : []);
    if (proposalsToEval.length > 0) {
      try {
        if (verbose) console.log('  Evaluating ' + proposalsToEval.length + ' individual proposals for baseline...');
        var evalResults = [];
        for (var pei = 0; pei < proposalsToEval.length; pei++) {
          var bpVal = proposalsToEval[pei];
          var bpProvider = bpVal.provider || userProvider;
          var bpProvOrder = [bpProvider].concat(availableProviders.filter(function(p) { return p !== bpProvider; }));
          var bpRaw;
          for (var bpi = 0; bpi < bpProvOrder.length; bpi++) {
            try {
              bpRaw = await llm.chatWithProvider(bpProvOrder[bpi], bpVal.systemPrompt, bpVal.userMessage, {
                maxTokens: bpVal.maxTokens || 512,
                agentTag: '_baseline_eval',
              });
              break;
            } catch (bpRetryErr) {
              var isBpRL = bpRetryErr.message && (bpRetryErr.message.includes('429') || bpRetryErr.message.includes('529') || bpRetryErr.message.includes('overloaded') || bpRetryErr.message.includes('Overloaded') || bpRetryErr.message.includes('RESOURCE_EXHAUSTED') || bpRetryErr.message.includes('rate'));
              if (isBpRL && bpi < bpProvOrder.length - 1) continue;
              throw bpRetryErr;
            }
          }
          var bpParsed = extractJSON(bpRaw);
          if (bpParsed && typeof bpParsed.score === 'number') {
            var thisScore = Math.max(0, Math.min(1, bpParsed.score));
            var agentLabel = bpVal.agentName || ('proposal_' + pei);
            evalResults.push({ agent: agentLabel, score: thisScore });
            if (verbose) console.log('    ' + agentLabel + ': ' + Math.round(thisScore * 100) + '%');
          }
        }
        if (evalResults.length > 0) {
          // Sort descending by score and use the BEST as baseline
          evalResults.sort(function(a, b) { return b.score - a.score; });
          bestProposalScore = evalResults[0].score;
          console.log('  Baseline (best individual: ' + evalResults[0].agent + '): ' + Math.round(bestProposalScore * 100) + '%');
        }
      } catch (bpErr) {
        if (verbose) console.log('  \x1b[90mBaseline eval failed: ' + bpErr.message + '\x1b[0m');
      }
    }

    // Send validation results to server for final scoring
    console.log('\x1b[35m[VALIDATION] \x1b[0mServer computing final quality...');
    var finalResult = await client.stepValidateResult(sessionId, validationScores, bestProposalScore);

    // ========================================================================
    // Display Results
    // ========================================================================
    var totalMs = Date.now() - totalStart;
    var qualityPct = ((finalResult.qualityScore || 0) * 100).toFixed(0);
    var ciGain = finalResult.ciGain !== null && finalResult.ciGain !== undefined ? (finalResult.ciGain >= 0 ? '+' : '') + finalResult.ciGain.toFixed(0) : 'N/A';
    var convergencePct = finalResult.finalConvergence !== null && finalResult.finalConvergence !== undefined ? ((finalResult.finalConvergence || 0) * 100).toFixed(0) : 'N/A';

    console.log('\x1b[32m[COMPLETE]   \x1b[0mQuality: ' + qualityPct + '% | CI Gain: ' + ciGain + '% | Duration: ' + formatElapsed(totalMs));
    console.log();
    console.log(colors.bold + colors.green + '=== LEGION X CONSENSUS RESULT (Zero-Knowledge) ===' + colors.reset);
    console.log();
    console.log(synthRaw || '[No synthesis]');
    console.log();

    // Stats
    console.log(colors.bold + '--- Stats ---' + colors.reset);
    console.log('Quality: ' + colors.cyan + qualityPct + '%' + colors.reset +
      ' | CI Gain: ' + colors.cyan + ciGain + '%' + colors.reset +
      ' | Convergence: ' + colors.cyan + convergencePct + '%' + colors.reset +
      ' | Rounds: ' + colors.cyan + round + colors.reset);
    console.log('Providers: ' + colors.magenta + availableProviders.join(' + ') + colors.reset + ' (local execution, keys never sent to server)');

    var usage = llm.getUsage();
    console.log('Tokens: ' + colors.gray + usage.totalInput.toLocaleString() + ' input + ' + usage.totalOutput.toLocaleString() + ' output = ' + usage.totalTokens.toLocaleString() + ' total' + colors.reset);
    if (usage.cacheHitRate > 0) {
      console.log('Cache: ' + colors.green + (usage.cacheHitRate * 100).toFixed(1) + '% hit rate' + colors.reset);
    }

    console.log('Duration: ' + colors.gray + formatDuration(totalMs) + colors.reset);

    // Stats legend
    console.log();
    console.log(colors.bold + '--- What do these stats mean? ---' + colors.reset);
    console.log(colors.gray + '  Quality     ' + colors.reset + 'LLM-evaluated score (0-100%). Single-provider self-grading.');
    console.log(colors.gray + '  CI Gain     ' + colors.reset + 'Collective Intelligence improvement vs best individual agent proposal.');
    console.log(colors.gray + '  Convergence ' + colors.reset + '30-60% is healthy — complementary perspectives, not groupthink.');
    console.log(colors.gray + '  Zero-Knowledge ' + colors.reset + 'Your API key was used locally. The server orchestrated but never saw it.');

    // Save session transcript
    try {
      var sessionsDir = path.join(process.env.HOME || '.', '.legion', 'sessions');
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
      }

      var now = new Date();
      var datePrefix = now.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
      var shortId = sessionId.substring(0, 8);
      var baseName = datePrefix + '_' + shortId;

      // JSON transcript — COMPLETE session data for training dataset decomposition
      // Compute unique providers actually used across all proposals
      var usedProviderSet = {};
      for (var upi = 0; upi < allProposals.length; upi++) {
        usedProviderSet[allProposals[upi].provider || userProvider] = true;
      }
      usedProviderSet[synthProvider] = true;

      var jsonTranscript = {
        sessionId: sessionId,
        planType: 'free',
        orchestrationMode: 'client',
        prompt: prompt,
        status: 'completed',
        provider: userProvider,
        providersUsed: Object.keys(usedProviderSet),
        qualityScore: finalResult.qualityScore || 0,
        ciGain: finalResult.ciGain || 0,
        finalConvergence: finalResult.finalConvergence || 0,
        deliberationRounds: round,
        decomposition: decomposition || null,
        agentAssignments: assignments.map(function(a) {
          return {
            agentName: a.agentName,
            provider: a.provider,
            model: a.model,
            subTaskId: a.subTaskId,
          };
        }),
        proposals: allProposals.map(function(p) {
          return {
            agentName: p.agentName,
            round: p.round || 1,
            subTaskId: p.subTaskId || '',
            provider: p.provider || userProvider,
            model: p.model || 'unknown',
            content: p.content,
            confidence: p.confidence,
            riskFlags: p.riskFlags,
            reasoningSummary: p.reasoningSummary || '',
            inputTokens: p.inputTokens || 0,
            outputTokens: p.outputTokens || 0,
            durationMs: p.durationMs || 0,
          };
        }),
        convergenceHistory: convergenceHistory,
        roundDecisions: roundDecisions,
        deliberation: liaraMode ? {
          liaraMode: true,
          liaraThreshold: liaraThreshold,
          naturalR1Convergence: liaraR1Convergence,
          minorityActivated: liaraMinorityActivated,
          minorityAgent: liaraMinorityAgent,
          rounds: round,
          convergence: convergenceHistory.length > 0 ? convergenceHistory[convergenceHistory.length - 1].convergence : 0,
          convergenceHistory: convergenceHistory.map(function(c) { return c.convergence; }),
        } : null,
        parliament: {
          prometheus: parliamentInfo && parliamentInfo.prometheus ? {
            active: true,
            agentsSelected: parliamentInfo.prometheus.agentsSelected,
            roundsDecided: parliamentInfo.prometheus.roundsDecided,
            cassandraEnabled: parliamentInfo.prometheus.cassandraEnabled,
            athenaEnabled: parliamentInfo.prometheus.athenaEnabled,
            complexity: parliamentInfo.prometheus.complexity,
            model: parliamentInfo.prometheus.model,
          } : { active: false },
          cassandra: assignments.some(function(a) { return a.agentName === 'CASSANDRA'; }) ? {
            active: true,
            provider: 'local-llm',
            serverSide: true,
          } : { active: false },
          athena: athenaInfo && athenaInfo.active ? {
            active: true,
            verdict: athenaInfo.verdict,
            model: athenaInfo.model,
          } : { active: false },
        },
        tribunalMetrics: allTribunalMetrics.length > 0 ? allTribunalMetrics : undefined,
        synthesis: synthRaw,
        synthesisProvider: synthProvider,
        validationScores: validationScores,
        // Cross-validation: most critical validator from a DIFFERENT provider than the synthesizer
        crossValidation: (function() {
          var cv = (validationScores || [])
            .filter(function(v) { return v.provider !== synthProvider; })
            .sort(function(a, b) { return a.score - b.score; })[0];
          return cv ? { provider: cv.provider, score: cv.score, reasoning: cv.reasoning } : null;
        })(),
        tokenUsage: usage,
        durationMs: totalMs,
        completedAt: now.toISOString(),
      };

      var jsonPath = path.join(sessionsDir, baseName + '.json');
      fs.writeFileSync(jsonPath, JSON.stringify(jsonTranscript, null, 2), { mode: 0o600 });

      // Markdown transcript
      var md = '# Legion X Session (Zero-Knowledge) — ' + now.toISOString().slice(0, 19).replace('T', ' ') + ' UTC\n';
      md += '## Session ID: ' + sessionId + '\n\n';
      md += '### Prompt\n> ' + prompt.replace(/\n/g, '\n> ') + '\n\n';
      md += '### Configuration\n';
      md += '- Plan: Free (zero-knowledge, client orchestration)\n';
      md += '- Provider: ' + userProvider + ' (local execution)\n';
      md += '- Deliberation Rounds: ' + round + '\n\n';
      // Agent proposals by round
      if (allProposals.length > 0) {
        var roundMap = {};
        for (var pi = 0; pi < allProposals.length; pi++) {
          var pr = allProposals[pi];
          var rKey = pr.round || 1;
          if (!roundMap[rKey]) roundMap[rKey] = [];
          roundMap[rKey].push(pr);
        }
        var roundKeys = Object.keys(roundMap).sort(function(a, b) { return Number(a) - Number(b); });
        for (var ri = 0; ri < roundKeys.length; ri++) {
          var rk = roundKeys[ri];
          md += '## Round ' + rk + '\n\n';
          var roundProposals = roundMap[rk];
          for (var rpi = 0; rpi < roundProposals.length; rpi++) {
            var rp = roundProposals[rpi];
            md += '### ' + (rp.agentName || 'Unknown') + ' (' + (rp.provider || 'unknown') + ')\n';
            md += '- Confidence: ' + ((rp.confidence || 0.7) * 100).toFixed(0) + '%\n';
            if (rp.reasoningSummary) md += '- Reasoning: ' + rp.reasoningSummary + '\n';
            if (rp.riskFlags && rp.riskFlags.length > 0) md += '- Risk Flags: ' + rp.riskFlags.join(', ') + '\n';
            md += '- Tokens: ' + (rp.inputTokens || 0) + ' in / ' + (rp.outputTokens || 0) + ' out\n\n';
            md += (rp.content || '[No content]') + '\n\n';
          }
          md += '---\n\n';
        }
      }

      md += '## Final Synthesis\n\n';
      md += (synthRaw || '[No synthesis]') + '\n\n';
      md += '---\n\n';
      md += '## Quality Validation\n';
      md += '- Quality Score: ' + qualityPct + '%\n';
      md += '- CI Gain: ' + ciGain + '%\n';
      md += '- Convergence: ' + convergencePct + '%\n\n';
      md += '## Session Metrics\n';
      md += '- Duration: ' + formatDuration(totalMs) + '\n';
      md += '- Total Input Tokens: ' + usage.totalInput.toLocaleString() + '\n';
      md += '- Total Output Tokens: ' + usage.totalOutput.toLocaleString() + '\n';
      md += '- Cache Hit Rate: ' + (usage.cacheHitRate * 100).toFixed(1) + '%\n';

      var mdPath = path.join(sessionsDir, baseName + '.md');
      fs.writeFileSync(mdPath, md, { mode: 0o600 });

      console.log();
      console.log(colors.green + 'Session transcript saved to ' + colors.reset + colors.cyan + mdPath + colors.reset);
      console.log(colors.gray + 'JSON data: ' + jsonPath + colors.reset);
    } catch (transcriptErr) {
      if (verbose) {
        console.log(colors.yellow + 'Warning: Failed to save transcript: ' + transcriptErr.message + colors.reset);
      }
    }

  } catch (err) {
    console.error(colors.red + 'Client orchestration failed: ' + err.message + colors.reset);
    if (verbose && err.stack) {
      console.error(colors.gray + err.stack + colors.reset);
    }
    process.exit(1);
  }
}

/**
 * parseStructuredOutput — Extract structured agent output
 *
 * Agents are instructed to return JSON with:
 * { answer, confidence, reasoning_summary, risk_flags }
 *
 * Falls back gracefully to raw text if not structured.
 */
function parseStructuredOutput(rawResponse) {
  var result = {
    answer: rawResponse,
    confidence: 0.7,
    riskFlags: [],
    reasoningSummary: '',
  };

  // Try to extract structured JSON
  var parsed = extractJSON(rawResponse);
  if (parsed && typeof parsed === 'object') {
    if (parsed.answer) {
      result.answer = _extractAnswerText(parsed.answer);
      result.confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7;
      result.riskFlags = Array.isArray(parsed.risk_flags) ? parsed.risk_flags : (Array.isArray(parsed.riskFlags) ? parsed.riskFlags : []);
      result.reasoningSummary = parsed.reasoning_summary || parsed.reasoningSummary || '';
    }
  }

  // If answer still looks like raw JSON wrapper, strip it
  // Gemini sometimes returns ```json\n{"answer":"..."}\n``` and extractJSON fails on very long content
  if (result.answer === rawResponse && rawResponse.includes('"answer"')) {
    // Try extracting answer field directly with regex (handles cases where JSON.parse fails on large content)
    var answerMatch = rawResponse.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
    if (answerMatch) {
      try {
        // Unescape the JSON string value
        result.answer = JSON.parse('"' + answerMatch[1] + '"');
      } catch (_) {
        // Fallback: use raw match with basic unescaping
        result.answer = answerMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      // Try extracting confidence too
      var confMatch = rawResponse.match(/"confidence"\s*:\s*([\d.]+)/);
      if (confMatch) result.confidence = Math.max(0, Math.min(1, parseFloat(confMatch[1])));
      var summMatch = rawResponse.match(/"reasoning_summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (summMatch) {
        try { result.reasoningSummary = JSON.parse('"' + summMatch[1] + '"'); } catch (_) { result.reasoningSummary = summMatch[1]; }
      }
      var flagsMatch = rawResponse.match(/"risk_flags"\s*:\s*\[(.*?)\]/);
      if (flagsMatch) {
        try { result.riskFlags = JSON.parse('[' + flagsMatch[1] + ']'); } catch (_) {}
      }
    }
  }

  // Final safety: if answer still looks like a JSON object string, try to extract text from it
  if (result.answer && typeof result.answer === 'string') {
    var trimmed = result.answer.trim();
    if (trimmed.charAt(0) === '{' && trimmed.charAt(trimmed.length - 1) === '}') {
      var innerParsed = null;
      try { innerParsed = JSON.parse(trimmed); } catch (_) {}
      if (innerParsed && typeof innerParsed === 'object') {
        result.answer = _extractAnswerText(innerParsed);
      }
    }
  }

  // Auto-generate reasoning summary if missing (first sentence, capped at 120 chars)
  if (!result.reasoningSummary && result.answer) {
    var firstSentence = result.answer.split(/[.!?\n]/)[0] || '';
    result.reasoningSummary = firstSentence.length > 120 ? firstSentence.substring(0, 117) + '...' : firstSentence;
  }

  return result;
}

/**
 * Extract readable text from an answer that may be a string, object, or nested structure.
 * Agents sometimes return answer as an object with sections instead of a flat string.
 */
function _extractAnswerText(answer) {
  if (typeof answer === 'string') return answer;
  if (answer === null || answer === undefined) return '';
  if (Array.isArray(answer)) {
    // Array of strings or objects — join them
    return answer.map(function(item) {
      return typeof item === 'string' ? item : (item && item.content) ? item.content : (item && item.text) ? item.text : JSON.stringify(item);
    }).join('\n\n');
  }
  if (typeof answer === 'object') {
    // Object with named sections — common pattern: { "section1": "text", "section2": "text" }
    // or { "answer": "text" } (double-wrapped)
    if (answer.answer && typeof answer.answer === 'string') return answer.answer;
    if (answer.content && typeof answer.content === 'string') return answer.content;
    if (answer.text && typeof answer.text === 'string') return answer.text;
    // Flatten all string values into readable sections
    var sections = [];
    var keys = Object.keys(answer);
    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      var val = answer[key];
      if (typeof val === 'string' && val.length > 0) {
        // Format key as a header: "governance_framework" → "Governance Framework"
        var header = key.replace(/[_-]/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
        sections.push('## ' + header + '\n' + val);
      } else if (typeof val === 'object' && val !== null) {
        // Recurse one level for nested objects
        var header2 = key.replace(/[_-]/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
        sections.push('## ' + header2 + '\n' + _extractAnswerText(val));
      }
    }
    if (sections.length > 0) return sections.join('\n\n');
    // Last resort: stringify
    return JSON.stringify(answer, null, 2);
  }
  return String(answer);
}

function formatElapsed(ms) {
  var totalSec = Math.floor(ms / 1000);
  var min = Math.floor(totalSec / 60);
  var sec = totalSec % 60;
  return min + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
}

// =============================================================================
// Server-Side Geth Consensus — LegionX server-only execution
// =============================================================================

async function runServerConsensus(prompt, options, legionConfig, client) {
  var verbose = options.verbose !== undefined ? options.verbose : legionConfig.get('verbose');
  var immersive = !options.noImmersive;
  var totalStart = Date.now();

  console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Delegating to server-side Geth Consensus...');
  console.log(colors.gray + 'Your API key is used for server-side orchestration. The server never stores it.' + colors.reset);
  console.log();

  // 1. Check server availability
  try {
    var providers = await client.getGethProviders();
    if (!providers.gethEnabled) {
      console.error(colors.red + 'Geth Consensus not available on server: no LLM providers configured.' + colors.reset);
      process.exit(1);
    }
    if (verbose) {
      console.log(colors.gray + '[LEGION X] Available providers: ' +
        providers.providers.map(function(p) { return p.name + ' (' + p.model + ')'; }).join(', ') +
        colors.reset);
    }
  } catch (err) {
    console.error(colors.red + 'Failed to reach Geth Consensus API: ' + err.message + colors.reset);
    console.error(colors.gray + 'Make sure the server is running and /geth/providers is accessible.' + colors.reset);
    process.exit(1);
  }

  // 1.5 v2: Scan local project — two-pass strategy (inventory + deep read)
  var projectContext = null;
  var detectedPath = options.scanDir || detectProjectPath(prompt);
  if (detectedPath && !options.noScan) {
    console.log(colors.cyan + '[PROJECT SCAN v2]' + colors.reset + ' Scanning ' + colors.bold + detectedPath + colors.reset + '...');
    try {
      var scanBudget = options.scanBudget ? parseInt(options.scanBudget, 10) : undefined;
      var scanResult = await scanProject(detectedPath, scanBudget);
      projectContext = scanResult.context;
      console.log(colors.cyan + '[PROJECT SCAN v2]' + colors.reset +
        ' Inventory: ' + colors.bold + scanResult.filesInInventory + colors.reset + ' files' +
        ' | Deep read: ' + colors.bold + scanResult.filesRead + colors.reset + ' files' +
        ' | ' + colors.yellow + scanResult.tokenEstimate.toLocaleString() + ' tokens' + colors.reset);
      console.log(colors.cyan + '[PROJECT SCAN v2]' + colors.reset +
        ' Project: ' + scanResult.totalFiles + ' total files | Type: ' + colors.magenta + scanResult.projectType + colors.reset);
    } catch (err) {
      console.warn(colors.yellow + '[PROJECT SCAN] Warning: ' + err.message + colors.reset);
    }
  }

  // 2. Build session config
  var sessionConfig = {};
  if (legionConfig.get('deliberationRounds')) {
    sessionConfig.deliberationRounds = legionConfig.get('deliberationRounds');
  }
  if (legionConfig.get('deliberationConvergence')) {
    sessionConfig.deliberationConvergence = legionConfig.get('deliberationConvergence');
  }
  if (legionConfig.get('minDeliberationRounds')) {
    sessionConfig.minDeliberationRounds = legionConfig.get('minDeliberationRounds');
  }

  // Provider selection: single or multi-LLM mode for Legion X
  var userProvider = legionConfig.get('provider') || legionConfig.get('llmProvider') || 'anthropic';
  var validProviders = ['anthropic', 'openai', 'gemini', 'deepseek', 'grok', 'mistral', 'cohere'];
  if (!validProviders.includes(userProvider)) {
    console.error(colors.red + 'Invalid provider: ' + userProvider + colors.reset);
    console.error(colors.gray + 'Valid options: ' + validProviders.join(', ') + colors.reset);
    process.exit(1);
  }

  // Multi-LLM: check for additional provider keys in config
  var userApiKey = legionConfig.get('llmApiKey') || legionConfig.get('apiKey') || '';
  var userApiKeys = {};
  var selectedProviders = [userProvider];
  var providerMode = 'single';

  // Collect all configured provider keys
  var openaiKey = legionConfig.get('openaiApiKey') || '';
  var geminiKey = legionConfig.get('geminiApiKey') || '';
  var anthropicKey = legionConfig.get('anthropicApiKey') || '';

  // Build multi-LLM key map
  if (userProvider === 'anthropic' && userApiKey) userApiKeys['anthropic'] = userApiKey;
  if (userProvider === 'openai' && userApiKey) userApiKeys['openai'] = userApiKey;
  if (userProvider === 'gemini' && userApiKey) userApiKeys['gemini'] = userApiKey;
  if (anthropicKey && !userApiKeys['anthropic']) userApiKeys['anthropic'] = anthropicKey;
  if (openaiKey && !userApiKeys['openai']) userApiKeys['openai'] = openaiKey;
  if (geminiKey && !userApiKeys['gemini']) userApiKeys['gemini'] = geminiKey;

  // OpenAI-compatible providers (DeepSeek, Grok, Mistral, Cohere)
  var compatProviderNames = Object.keys(OPENAI_COMPAT_PROVIDERS);
  for (var cpi = 0; cpi < compatProviderNames.length; cpi++) {
    var cpName = compatProviderNames[cpi];
    var cpConf = OPENAI_COMPAT_PROVIDERS[cpName];
    var cpKey = legionConfig.get(cpConf.configKey) || '';
    if (userProvider === cpName && userApiKey && !cpKey) cpKey = userApiKey;
    if (cpKey && !userApiKeys[cpName]) userApiKeys[cpName] = cpKey;
  }

  var configuredProviders = Object.keys(userApiKeys);
  if (configuredProviders.length > 1) {
    providerMode = 'multi';
    selectedProviders = configuredProviders;
    console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Multi-LLM mode: ' + colors.magenta + configuredProviders.join(' + ') + colors.reset);
  } else if (configuredProviders.length === 1) {
    selectedProviders = configuredProviders;
    console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Provider: ' + colors.magenta + configuredProviders[0] + colors.reset);
  }

  if (!userApiKey && configuredProviders.length === 0) {
    console.log(colors.red + 'ERROR: No API key configured.' + colors.reset);
    console.log('Set your API key: node legion-x.mjs config:set llm-key YOUR_API_KEY');
    console.log('For multi-LLM: set keys for anthropic, openai, gemini, deepseek, grok, mistral, cohere');
    console.log('Legion X uses YOUR OWN API key(s). Keys NEVER leave your machine.');
    process.exit(1);
  }

  // Ensure primary key is set (backward compat)
  if (!userApiKey) userApiKey = Object.values(userApiKeys)[0];

  console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Creating session...');

  // 3. Create session (with user API key(s) for Legion X free tier)
  var createResult;
  try {
    createResult = await client.createGethSession(
      prompt,
      Object.keys(sessionConfig).length > 0 ? sessionConfig : undefined,
      providerMode,
      selectedProviders,
      userApiKey,
      projectContext,
      Object.keys(userApiKeys).length > 1 ? userApiKeys : undefined,
    );
  } catch (err) {
    if (err.message && (err.message.includes('429') || err.message.includes('E4290') || err.message.toLowerCase().includes('rate limit'))) {
      console.error(colors.yellow + '[RATE LIMITED]' + colors.reset + ' ' + colors.red + err.message + colors.reset);
      console.error(colors.dim + 'Tip: Authenticated agents get higher limits. Register with PIF first.' + colors.reset);
    } else {
      console.error(colors.red + 'Failed to create session: ' + err.message + colors.reset);
    }
    process.exit(1);
  }

  var sessionId = createResult.sessionId;
  console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Session ' + colors.bold + sessionId.substring(0, 8) + '...' + colors.reset + ' created');

  // 4. Poll for completion with live progress reporting
  var pollInterval = 3000;
  var maxPolls = 1200; // 60 minutes (complex multi-round deliberation with rate-limited providers)
  var pollCount = 0;
  var lastStatus = 'pending';
  var spinChars = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
  var lastLogIndex = 0;
  var hasProgressBar = false;

  // ========================================================================
  // Deliberation Spectacle — Structured event parser + renderers
  // ========================================================================

  function parseSpectacleEvent(entry) {
    if (typeof entry !== 'string' || entry.charAt(0) !== '{') return null;
    try {
      var obj = JSON.parse(entry);
      if (obj && typeof obj.type === 'string') return obj;
    } catch (_) {}
    return null;
  }

  var capabilityColors = {
    security: '\x1b[31m',    // red
    code: '\x1b[32m',        // green
    analytical: '\x1b[34m',  // blue
    creative: '\x1b[35m',    // magenta
  };

  // Immersive mode: 12 distinct ANSI colors assigned round-robin per agent
  var agentColorPalette = [
    '\x1b[38;5;214m', // orange
    '\x1b[38;5;39m',  // sky blue
    '\x1b[38;5;156m', // lime
    '\x1b[38;5;213m', // pink
    '\x1b[38;5;220m', // gold
    '\x1b[38;5;87m',  // aqua
    '\x1b[38;5;183m', // lavender
    '\x1b[38;5;203m', // salmon
    '\x1b[38;5;114m', // sage
    '\x1b[38;5;141m', // violet
    '\x1b[38;5;180m', // tan
    '\x1b[38;5;80m',  // teal
  ];
  var agentColorMap = {};
  var agentColorIndex = 0;
  function getAgentColor(name) {
    if (!agentColorMap[name]) {
      agentColorMap[name] = agentColorPalette[agentColorIndex % agentColorPalette.length];
      agentColorIndex++;
    }
    return agentColorMap[name];
  }

  function renderDecomposition(event) {
    var tasks = event.tasks || [];
    console.log('\x1b[36m[DECOMPOSE]  \x1b[0m' + tasks.length + ' sub-tasks across ' +
      new Set(tasks.map(function(t) { return t.capability; })).size + ' capabilities');
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var capColor = capabilityColors[t.capability] || '\x1b[37m';
      console.log('  ' + (i + 1) + '. ' + capColor + '[' + t.capability + ']\x1b[0m ' + t.description);
    }
  }

  function renderAgentsAssigned(event) {
    var agents = event.agents || [];
    console.log('\x1b[36m[ROUTING]    \x1b[0m' + agents.length + ' agents deployed');
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      console.log('  \x1b[1m' + a.name + '\x1b[0m (\x1b[35m' + a.provider + '/' + a.model + '\x1b[0m) \x1b[90m\u2192 ' + a.subTaskId + '\x1b[0m');
    }
  }

  function renderAgentComplete(event) {
    var conf = Math.round((event.confidence || 0) * 100);
    var confColor = conf >= 80 ? '\x1b[32m' : conf >= 50 ? '\x1b[33m' : '\x1b[31m';
    var dur = Math.round((event.durationMs || 0) / 1000);
    var riskStr = '';
    if (event.riskFlags && event.riskFlags.length > 0) {
      riskStr = ' \x1b[33m\u26a0 ' + event.riskFlags.join(', ') + '\x1b[0m';
    }
    var prov = event.provider || '';
    console.log('  \x1b[1m' + event.agentName + '\x1b[0m ' + confColor + conf + '% conf\x1b[0m (' + dur + 's, ' + prov + ')' + riskStr);
    if (event.reasoningSummary) {
      console.log('    \x1b[90m\u2514 ' + event.reasoningSummary + '\x1b[0m');
    }
  }

  function renderAgentSpeaking(event) {
    if (!immersive) return;
    var agentName = (event.agentName || 'UNKNOWN').toUpperCase();
    var agentCol = getAgentColor(agentName);
    var provider = event.provider || '';
    var roundLabel = event.round > 1 ? ' (Round ' + event.round + ')' : '';
    var chunks = event.chunks || [];
    if (chunks.length === 0) return;
    console.log('');
    console.log('  ' + agentCol + '\u25cf ' + agentName + roundLabel + '\x1b[0m \x1b[90m(' + provider + '):\x1b[0m');
    for (var c = 0; c < chunks.length; c++) {
      var lines = chunks[c].split('\n');
      for (var l = 0; l < lines.length; l++) {
        console.log('  ' + agentCol + '\u2502\x1b[0m ' + lines[l]);
      }
    }
    console.log('  ' + agentCol + '\u2514\u2500\u2500\u2500\x1b[0m');
  }

  function renderAgentReacting(event) {
    if (!immersive) return;
    var agentName = (event.agentName || 'UNKNOWN').toUpperCase();
    var agentCol = getAgentColor(agentName);
    var readingFrom = event.readingFrom || [];
    if (readingFrom.length === 0) return;
    var names = readingFrom.map(function(n) {
      var col = getAgentColor(n.toUpperCase());
      return col + n.toUpperCase() + '\x1b[0m';
    }).join(', ');
    console.log('  ' + agentCol + '\u21bb ' + agentName + '\x1b[0m reading: ' + names);
  }

  function renderSynthesisSpeaking(event) {
    if (!immersive) return;
    var chunks = event.chunks || [];
    if (chunks.length === 0) return;
    var provider = event.provider || '';
    console.log('');
    console.log('  \x1b[36m\u25cf SYNTHESIS\x1b[0m \x1b[90m(' + provider + '):\x1b[0m');
    for (var c = 0; c < chunks.length; c++) {
      var lines = chunks[c].split('\n');
      for (var l = 0; l < lines.length; l++) {
        console.log('  \x1b[36m\u2502\x1b[0m ' + lines[l]);
      }
    }
    console.log('  \x1b[36m\u2514\u2500\u2500\u2500\x1b[0m');
  }

  function renderConvergenceUpdate(event) {
    var conv = Math.round((event.convergence || 0) * 100);
    var total = event.totalPairs || 0;
    var barWidth = 16;
    var filled = Math.round(conv / 100 * barWidth);
    var bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
    var divPairs = event.divergentPairs || [];
    var divStr = '';
    if (divPairs.length > 0) {
      var pairNames = divPairs.map(function(p) { return p[0] + ' vs ' + p[1]; }).join(', ');
      divStr = '\n  \x1b[33m\u2694 Divergent: ' + pairNames + '\x1b[0m';
    } else {
      divStr = '\n  \x1b[32m\u2713 All agents aligned\x1b[0m';
    }
    console.log('\x1b[33m[ROUND ' + event.round + ']\x1b[0m    Convergence: ' + bar + ' ' + conv + '% (' + (event.method || 'jaccard') + ', ' + total + ' pairs)' + divStr);
  }

  function renderRoundDecision(event) {
    var icons = {
      standard: '\u27f3',       // ⟳
      mandatory: '\u2757',      // ❗
      arbitrator: '\u2696',     // ⚖
      skip_consensus: '\u2713', // ✓
    };
    var modeIcon = icons[event.mode] || '?';
    var label = event.mode === 'skip_consensus'
      ? '\x1b[32m\u2713 CONSENSUS REACHED\x1b[0m \u2014 ' + (event.reason || 'sufficient convergence')
      : modeIcon + ' Round ' + (event.nextRound || '?') + ': \x1b[1m' + (event.mode || '').toUpperCase() + '\x1b[0m \u2014 ' + (event.reason || '');
    var metrics = '';
    if (event.divergence !== undefined) {
      metrics = '\n  \x1b[90mdivergence=' + Math.round(event.divergence * 100) + '% uncertainty=' +
        Math.round((event.uncertainty || 0) * 100) + '% conflicts=' + (event.conflicts || 0) + '\x1b[0m';
    }
    console.log('\n' + label + metrics);
  }

  function renderSynthesisWeights(event) {
    var prog = event.convergenceProgression || [];
    var progStr = prog.map(function(c) { return 'R' + c.round + ':' + Math.round(c.convergence * 100) + '%'; }).join(' \u2192 ');
    var strategyLabel = event.strategy ? ' [' + event.strategy.replace(/_/g, '-') + ']' : '';
    console.log('\x1b[36m[SYNTHESIS]  \x1b[0mPreparing final synthesis (' + (event.totalRounds || 0) + ' rounds)' + strategyLabel);
    if (progStr) {
      console.log('  Convergence: ' + progStr);
    }
    var top = event.topAgents || [];
    if (top.length > 0) {
      // Authority-weighted display (new format with tier/rank/calibration)
      var hasAuthority = top[0] && top[0].tier;
      if (hasAuthority) {
        console.log('  \x1b[1mAgent Authority:\x1b[0m');
        for (var i = 0; i < top.length; i++) {
          var a = top[i];
          var tierColor = a.tier === 'expert' ? '\x1b[32m' : a.tier === 'proficient' ? '\x1b[36m' : a.tier === 'standard' ? '\x1b[37m' : '\x1b[90m';
          var calIcon = a.calibration === 'well-calibrated' ? '\x1b[32m\u2713\x1b[0m' : a.calibration === 'overconfident' ? '\x1b[33m\u2191\x1b[0m' : '\x1b[33m\u2193\x1b[0m';
          var tasks = a.tasksCompleted !== undefined ? ', ' + a.tasksCompleted + ' tasks' : '';
          console.log('    #' + (a.rank || (i + 1)) + ' ' + a.name.padEnd(14) + ' ' + tierColor + a.tier.padEnd(10) + '\x1b[0m [' + Math.round(a.confidence * 100) + '%] ' + calIcon + tasks);
        }
      } else {
        // Fallback: old format
        var topStr = top.map(function(a) { return a.name + ' (' + Math.round(a.confidence * 100) + '%)'; }).join(', ');
        console.log('  Strongest: ' + topStr);
      }
    }
    if (event.realConflicts > 0) {
      console.log('  \x1b[33mReal conflicts: ' + event.realConflicts + '\x1b[0m');
    }
    var risk = event.riskFlaggedAgents || [];
    if (risk.length > 0) {
      var riskStr = risk.map(function(a) { return a.name + ' (' + a.flags.join(', ') + ')'; }).join(', ');
      console.log('  \x1b[33mRisk-flagged: ' + riskStr + '\x1b[0m');
    }
  }

  function renderSpectacleEvent(event) {
    switch (event.type) {
      case 'decomposition_complete': renderDecomposition(event); break;
      case 'agents_assigned': renderAgentsAssigned(event); break;
      case 'agent_complete': renderAgentComplete(event); break;
      case 'agent_speaking': renderAgentSpeaking(event); break;
      case 'agent_reacting': renderAgentReacting(event); break;
      case 'convergence_update': renderConvergenceUpdate(event); break;
      case 'round_decision': renderRoundDecision(event); break;
      case 'synthesis_weights': renderSynthesisWeights(event); break;
      case 'synthesis_speaking': renderSynthesisSpeaking(event); break;
      default: console.log('\x1b[90m  [spectacle] ' + JSON.stringify(event) + '\x1b[0m'); break;
    }
  }

  function getPhasePrefix(phase) {
    var map = {
      decomposing:       '\x1b[36m[DECOMPOSE]  \x1b[0m',
      neural_prediction: '\x1b[36m[NEURAL]     \x1b[0m',
      routing:           '\x1b[36m[ROUTING]    \x1b[0m',
      round_1:           '\x1b[33m[ROUND 1]    \x1b[0m',
      round_2:           '\x1b[33m[ROUND 2]    \x1b[0m',
      round_3:           '\x1b[33m[ROUND 3]    \x1b[0m',
      round_4:           '\x1b[33m[ROUND 4]    \x1b[0m',
      round_5:           '\x1b[33m[ROUND 5]    \x1b[0m',
      synthesizing:      '\x1b[36m[SYNTHESIS]  \x1b[0m',
      evaluating:        '\x1b[35m[VALIDATION] \x1b[0m',
    };
    return map[phase] || '\x1b[90m[' + (phase || '').toUpperCase() + ']\x1b[0m';
  }

  function buildProgressBar(completed, total) {
    var width = 16;
    var filled = total > 0 ? Math.round((completed / total) * width) : 0;
    var empty = width - filled;
    return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  }

  function formatElapsed(ms) {
    var totalSec = Math.floor(ms / 1000);
    var min = Math.floor(totalSec / 60);
    var sec = totalSec % 60;
    return min + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
  }

  while (pollCount < maxPolls) {
    await new Promise(function(resolve) { setTimeout(resolve, pollInterval); });
    pollCount++;

    var sessionResult;
    try {
      sessionResult = await client.getGethSession(sessionId);
    } catch (err) {
      if (verbose) {
        console.log(colors.yellow + '[LEGION X] Poll error: ' + err.message + colors.reset);
      }
      continue;
    }

    var session = sessionResult.session;
    var status = session.status;
    var progress = sessionResult.progress || null;

    // Show status changes
    if (status !== lastStatus) {
      // Clear any in-place progress bar before printing a new line
      if (hasProgressBar) {
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
        hasProgressBar = false;
      }
      var statusColors = {
        pending: colors.gray,
        deliberating: colors.yellow,
        synthesizing: colors.cyan,
        evaluating: colors.magenta,
        completed: colors.green,
        failed: colors.red,
        cancelled: colors.red,
      };
      var statusColor = statusColors[status] || colors.white;
      console.log(colors.cyan + '[GETH CONSENSUS]' + colors.reset + ' Status: ' + statusColor + status + colors.reset);
      lastStatus = status;
    }

    // Live progress display
    if (progress && progress.log) {
      // Print new log entries
      var newEntries = progress.log.slice(lastLogIndex);
      for (var li = 0; li < newEntries.length; li++) {
        // Clear any in-place progress bar before printing a permanent line
        if (hasProgressBar) {
          process.stdout.write('\r' + ' '.repeat(100) + '\r');
          hasProgressBar = false;
        }
        var entry = newEntries[li];
        var spectacleEvent = parseSpectacleEvent(entry);
        if (spectacleEvent) {
          renderSpectacleEvent(spectacleEvent);
        } else {
          var prefix = getPhasePrefix(progress.phase);
          console.log(prefix + entry);
        }
      }
      lastLogIndex = progress.log.length;

      // In-place progress bar for round phases
      if (progress.phase && progress.phase.startsWith('round_') && progress.agentsTotal > 0 && progress.agentsCompleted < progress.agentsTotal) {
        var bar = buildProgressBar(progress.agentsCompleted, progress.agentsTotal);
        var agentLabel = progress.currentAgent ? progress.currentAgent : '...';
        var elapsed = formatElapsed(progress.elapsedMs || 0);
        var barLine = getPhasePrefix(progress.phase) +
          bar + ' ' + progress.agentsCompleted + '/' + progress.agentsTotal + ' agents' +
          ' | ' + colors.cyan + agentLabel + colors.reset +
          ' | ' + colors.gray + elapsed + ' elapsed' + colors.reset;
        process.stdout.write('\r' + barLine);
        hasProgressBar = true;
      } else if (!hasProgressBar && status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
        // Heartbeat spinner — always visible between events, shows phase + elapsed time
        var spin = spinChars[pollCount % spinChars.length];
        var totalElapsed = formatElapsed(Date.now() - totalStart);
        var phaseLabel = progress.phase ? progress.phase.replace(/_/g, ' ').toUpperCase() : status.toUpperCase();
        var heartbeat = '  ' + colors.cyan + spin + colors.reset +
          ' ' + colors.gray + phaseLabel + colors.reset +
          colors.gray + ' \u2014 ' + totalElapsed + ' elapsed' + colors.reset;
        process.stdout.write('\r' + heartbeat);
        hasProgressBar = true;
      }
    } else if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
      // No progress data yet — heartbeat spinner with basic status
      var spin = spinChars[pollCount % spinChars.length];
      var totalElapsed = formatElapsed(Date.now() - totalStart);
      var heartbeat = '  ' + colors.cyan + spin + colors.reset +
        ' ' + colors.gray + status.toUpperCase() + ' \u2014 ' + totalElapsed + ' elapsed' + colors.reset;
      process.stdout.write('\r' + heartbeat);
      hasProgressBar = true;
    }

    if (status === 'completed') {
      if (hasProgressBar) process.stdout.write('\r' + ' '.repeat(100) + '\r');

      // Print completion summary from progress
      if (progress && progress.phase) {
        var qualPct = session.qualityScore ? ((session.qualityScore) * 100).toFixed(0) : '?';
        var ciG = session.ciGain !== null && session.ciGain !== undefined ? (session.ciGain >= 0 ? '+' : '') + session.ciGain.toFixed(0) : 'N/A';
        var dur = formatElapsed(session.totalDurationMs || (Date.now() - totalStart));
        console.log('\x1b[32m[COMPLETE]   \x1b[0m' + 'Quality: ' + qualPct + '%' +
          ' | CI Gain: ' + ciG + '%' +
          ' | Duration: ' + dur);
      }

      // Fetch proposals early (used for both recap and transcript)
      var proposalsData = [];
      try {
        var proposalsResult = await client.getGethProposals(sessionId);
        proposalsData = proposalsResult.proposals || [];
      } catch (_) {}

      var totalMs = Date.now() - totalStart;
      console.log();
      console.log(colors.bold + colors.green + '=== LEGION X CONSENSUS RESULT ===' + colors.reset);
      console.log();
      console.log(session.synthesis || '[No synthesis]');
      console.log();

      // Stats
      var qualityPct = ((session.qualityScore || 0) * 100).toFixed(0);
      var ciGain = session.ciGain !== null && session.ciGain !== undefined ? (session.ciGain >= 0 ? '+' : '') + session.ciGain.toFixed(0) : 'N/A';
      var convergencePct = session.finalConvergence !== null ? ((session.finalConvergence || 0) * 100).toFixed(0) : 'N/A';

      console.log(colors.bold + '--- Stats ---' + colors.reset);
      console.log('Quality: ' + colors.cyan + qualityPct + '%' + colors.reset +
        ' | CI Gain: ' + colors.cyan + ciGain + '%' + colors.reset +
        ' | Convergence: ' + colors.cyan + convergencePct + '%' + colors.reset +
        ' | Rounds: ' + colors.cyan + (session.deliberationRounds || 0) + colors.reset);

      if (session.providersUsed && session.providersUsed.length > 0) {
        console.log('Providers: ' + session.providersUsed.map(function(p) {
          return colors.magenta + p + colors.reset;
        }).join(', '));
      }

      if (session.crossValidationScore !== null && session.crossValidationScore !== undefined) {
        var cvPct = (session.crossValidationScore * 100).toFixed(0);
        console.log('Cross-validation: ' + colors.yellow + cvPct + '%' + colors.reset +
          ' (evaluated by ' + colors.magenta + (session.crossValidatorProvider || 'unknown') + colors.reset + ')');
        if (verbose && session.crossValidationReasoning) {
          console.log(colors.gray + '  ' + session.crossValidationReasoning + colors.reset);
        }
      }

      console.log('Duration: ' + colors.gray + formatDuration(session.totalDurationMs || totalMs) + colors.reset +
        ' (server) / ' + formatDuration(totalMs) + ' (total)');

      // Stats legend
      console.log();
      console.log(colors.bold + '--- What do these stats mean? ---' + colors.reset);
      console.log(colors.gray + '  Quality     ' + colors.reset + 'LLM-evaluated score (0-100%). Measures relevance, completeness, coherence,');
      console.log(colors.gray + '              ' + colors.reset + 'depth, and synthesis quality. With a single provider, self-grading bias');
      console.log(colors.gray + '              ' + colors.reset + 'applies (models tend to underrate their own output). Multi-provider');
      console.log(colors.gray + '              ' + colors.reset + 'cross-validation (3 LLMs evaluating each other) yields more accurate scores.');
      console.log(colors.gray + '  CI Gain     ' + colors.reset + 'Collective Intelligence improvement vs best individual agent proposal.');
      console.log(colors.gray + '              ' + colors.reset + 'Positive = multi-agent deliberation outperformed a monolithic model.');
      console.log(colors.gray + '  Convergence ' + colors.reset + '30-60% is healthy — it means agents tackled different sub-tasks with');
      console.log(colors.gray + '              ' + colors.reset + 'complementary perspectives. 100% would signal groupthink (bad).');
      console.log(colors.gray + '              ' + colors.reset + 'Low convergence with high quality = effective division of labor.');
      console.log(colors.gray + '  Rounds      ' + colors.reset + 'Deliberation rounds completed. Round 2+ includes cross-reading where');
      console.log(colors.gray + '              ' + colors.reset + 'agents read each other\'s full proposals and refine their positions.');

      // ====================================================================
      // Deliberation Recap — Position changes + convergence visualization
      // ====================================================================
      if (proposalsData.length > 0 && session.convergenceHistory && session.convergenceHistory.length > 0) {
        console.log();
        console.log(colors.bold + '=== DELIBERATION RECAP ===' + colors.reset);

        // Per round: agent name, confidence %, provider, reasoning summary, risk flags
        var roundMap = {};
        for (var pi = 0; pi < proposalsData.length; pi++) {
          var p = proposalsData[pi];
          var rnd = p.round || 1;
          if (!roundMap[rnd]) roundMap[rnd] = [];
          roundMap[rnd].push(p);
        }
        var rounds = Object.keys(roundMap).map(Number).sort(function(a, b) { return a - b; });
        var maxRound = rounds.length > 0 ? rounds[rounds.length - 1] : 1;

        // Show per-round breakdown
        for (var ri = 0; ri < rounds.length; ri++) {
          var rn = rounds[ri];
          var rndProposals = roundMap[rn];
          rndProposals.sort(function(a, b) { return (b.confidence || 0) - (a.confidence || 0); });
          console.log();
          console.log(colors.bold + '--- Round ' + rn + ' ---' + colors.reset);
          for (var rpi = 0; rpi < rndProposals.length; rpi++) {
            var rp = rndProposals[rpi];
            var rpConf = Math.round((rp.confidence || 0.7) * 100);
            var rpConfColor = rpConf >= 80 ? colors.green : rpConf >= 50 ? colors.yellow : colors.red;
            var rpRisk = (rp.riskFlags && rp.riskFlags.length > 0) ? ' \x1b[33m\u26a0 ' + rp.riskFlags.join(', ') + '\x1b[0m' : '';
            console.log('  ' + colors.cyan + rp.agentName + colors.reset + ' ' +
              rpConfColor + rpConf + '%' + colors.reset +
              ' (' + colors.magenta + (rp.provider || '?') + colors.reset + ')' + rpRisk);
            if (rp.reasoningSummary) {
              console.log('    \x1b[90m\u2514 ' + rp.reasoningSummary + '\x1b[0m');
            }
          }
        }

        // Position Changes: compare round 1 vs last round by Jaccard similarity
        if (maxRound > 1 && roundMap[1] && roundMap[maxRound]) {
          console.log();
          console.log(colors.bold + '--- Position Changes (Round 1 \u2192 ' + maxRound + ') ---' + colors.reset);
          var r1Map = {};
          for (var r1i = 0; r1i < roundMap[1].length; r1i++) {
            r1Map[roundMap[1][r1i].agentName] = roundMap[1][r1i].content || '';
          }
          var lastRndProposals = roundMap[maxRound];
          for (var lri = 0; lri < lastRndProposals.length; lri++) {
            var lrp = lastRndProposals[lri];
            var r1Content = r1Map[lrp.agentName];
            if (r1Content !== undefined) {
              var words1 = new Set(r1Content.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; }));
              var words2 = new Set((lrp.content || '').toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; }));
              var intersection = 0;
              words1.forEach(function(w) { if (words2.has(w)) intersection++; });
              var union = words1.size + words2.size - intersection;
              var similarity = union > 0 ? Math.round(intersection / union * 100) : 100;
              var posIcon = similarity < 60 ? '\x1b[33m\u21c4\x1b[0m' : '\x1b[90m\u2501\x1b[0m';
              var posLabel = similarity < 60 ? 'adapted position' : 'held firm';
              console.log('  ' + posIcon + ' ' + colors.cyan + lrp.agentName + colors.reset +
                ': ' + similarity + '% similarity (' + posLabel + ')');
            }
          }
        }

        // Convergence visualization
        console.log();
        console.log(colors.bold + '--- Convergence ---' + colors.reset);
        for (var cvi = 0; cvi < session.convergenceHistory.length; cvi++) {
          var cvh = session.convergenceHistory[cvi];
          var cvPctR = Math.round((cvh.convergence || 0) * 100);
          var cvBarW = 16;
          var cvFill = Math.round(cvPctR / 100 * cvBarW);
          var cvBar = '\u2588'.repeat(cvFill) + '\u2591'.repeat(cvBarW - cvFill);
          var cvDiv = '';
          if (cvh.divergentPairs && cvh.divergentPairs.length > 0) {
            var cvDivNames = cvh.divergentPairs.map(function(dp) { return dp[0] + ' vs ' + dp[1]; }).join(', ');
            cvDiv = ' (' + cvh.divergentPairs.length + ' divergent: ' + cvDivNames + ')';
          }
          console.log('  Round ' + cvh.round + ': ' + cvBar + ' ' + cvPctR + '%' + cvDiv);
        }
      }

      // Verbose: show agent assignments
      if (verbose && session.agentAssignments && session.agentAssignments.length > 0) {
        console.log();
        console.log(colors.bold + '--- Agent Assignments ---' + colors.reset);
        for (var ai = 0; ai < session.agentAssignments.length; ai++) {
          var a = session.agentAssignments[ai];
          console.log('  ' + colors.cyan + a.agentName + colors.reset +
            ' → ' + colors.magenta + a.provider + colors.reset +
            ' (' + a.model + ') [' + a.category + ']');
        }
      }

      // Save session transcript to ~/.legion/sessions/
      try {
        var sessionsDir = path.join(process.env.HOME || '.', '.legion', 'sessions');
        if (!fs.existsSync(sessionsDir)) {
          fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        }

        var now = new Date();
        var datePrefix = now.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
        var shortId = sessionId.substring(0, 8);
        var baseName = datePrefix + '_' + shortId;

        // JSON transcript (machine-readable)
        var jsonTranscript = {
          sessionId: sessionId,
          planType: 'free',
          prompt: prompt,
          status: 'completed',
          decomposition: session.decomposition || null,
          agentAssignments: session.agentAssignments || [],
          proposals: proposalsData.map(function(p) {
            return {
              agentName: p.agentName,
              round: p.round,
              provider: p.provider,
              model: p.model,
              content: p.content,
              confidence: p.confidence,
              riskFlags: p.riskFlags,
              reasoningSummary: p.reasoningSummary,
              inputTokens: p.inputTokens || 0,
              outputTokens: p.outputTokens || 0,
            };
          }),
          convergenceHistory: session.convergenceHistory || [],
          roundDecisions: session.roundDecisions || [],
          deliberation: executionResult.deliberation || null,
          synthesis: session.synthesis || '',
          synthesisProvider: session.synthesisProvider || '',
          validationScores: session.validationScores || [],
          qualityScore: session.qualityScore || 0,
          ciGain: session.ciGain || 0,
          providersUsed: session.providersUsed || [],
          totalInputTokens: session.totalInputTokens || 0,
          totalOutputTokens: session.totalOutputTokens || 0,
          durationMs: session.totalDurationMs || totalMs,
          completedAt: now.toISOString(),
        };

        var jsonPath = path.join(sessionsDir, baseName + '.json');
        fs.writeFileSync(jsonPath, JSON.stringify(jsonTranscript, null, 2), { mode: 0o600 });

        // Markdown transcript (human-readable)
        var md = '# Legion X Session — ' + now.toISOString().slice(0, 19).replace('T', ' ') + ' UTC\n';
        md += '## Session ID: ' + sessionId + '\n\n';
        md += '### Prompt\n> ' + prompt.replace(/\n/g, '\n> ') + '\n\n';
        md += '### Configuration\n';
        md += '- Plan: Free (user API key)\n';
        md += '- Provider: ' + (session.providersUsed || []).join(', ') + '\n';
        md += '- Deliberation Rounds: ' + (session.deliberationRounds || 0) + '\n\n';
        md += '---\n\n';

        // Agent assignments
        if (session.agentAssignments && session.agentAssignments.length > 0) {
          md += '## Agent Assignments\n';
          md += '| Agent | Category | Provider | Model |\n';
          md += '|-------|----------|----------|-------|\n';
          for (var ai2 = 0; ai2 < session.agentAssignments.length; ai2++) {
            var ag = session.agentAssignments[ai2];
            md += '| ' + ag.agentName + ' | ' + (ag.category || '') + ' | ' + (ag.provider || '') + ' | ' + (ag.model || '') + ' |\n';
          }
          md += '\n---\n\n';
        }

        // Proposals by round
        if (proposalsData.length > 0) {
          var roundMap = {};
          for (var pi = 0; pi < proposalsData.length; pi++) {
            var pr = proposalsData[pi];
            var rKey = pr.round || 1;
            if (!roundMap[rKey]) roundMap[rKey] = [];
            roundMap[rKey].push(pr);
          }
          var roundKeys = Object.keys(roundMap).sort(function(a, b) { return Number(a) - Number(b); });
          var roundLabels = { 1: 'Initial Proposals', 2: 'Refined (after cross-reading)', 3: 'Mediated' };
          for (var ri = 0; ri < roundKeys.length; ri++) {
            var rnd = roundKeys[ri];
            md += '## Round ' + rnd + ' — ' + (roundLabels[rnd] || 'Round ' + rnd) + '\n\n';
            var roundProposals = roundMap[rnd];
            for (var rpi = 0; rpi < roundProposals.length; rpi++) {
              var rp = roundProposals[rpi];
              md += '### ' + (rp.agentName || 'unknown').toUpperCase() + ' (' + (rp.provider || '') + '/' + (rp.model || '') + ')\n';
              md += rp.content + '\n\n';
            }
          }
          md += '---\n\n';
        }

        // Convergence history
        if (session.convergenceHistory && session.convergenceHistory.length > 0) {
          md += '## Convergence History\n';
          md += '| Round | Convergence | Method |\n';
          md += '|-------|-------------|--------|\n';
          for (var chi = 0; chi < session.convergenceHistory.length; chi++) {
            var chEntry = session.convergenceHistory[chi];
            md += '| ' + chEntry.round + ' | ' + ((chEntry.convergence || 0) * 100).toFixed(0) + '% | ' + (chEntry.method || 'jaccard') + ' |\n';
          }
          md += '\n---\n\n';
        }

        // Synthesis
        md += '## Final Synthesis\n';
        if (session.synthesisProvider) md += 'Provider: ' + session.synthesisProvider + '\n\n';
        md += (session.synthesis || '[No synthesis]') + '\n\n';
        md += '---\n\n';

        // Quality
        md += '## Quality Validation\n';
        if (session.crossValidationScore !== null && session.crossValidationScore !== undefined) {
          md += '- Cross-validation: ' + (session.crossValidationScore * 100).toFixed(0) + '% by ' + (session.crossValidatorProvider || 'unknown') + '\n';
        }
        md += '- Quality Score: ' + qualityPct + '%\n';
        md += '- CI Gain: ' + ciGain + '%\n\n';

        // Metrics
        md += '## Session Metrics\n';
        md += '- Duration: ' + formatDuration(session.totalDurationMs || totalMs) + '\n';
        md += '- Total Input Tokens: ' + (session.totalInputTokens || 0).toLocaleString() + '\n';
        md += '- Total Output Tokens: ' + (session.totalOutputTokens || 0).toLocaleString() + '\n';

        var mdPath = path.join(sessionsDir, baseName + '.md');
        fs.writeFileSync(mdPath, md, { mode: 0o600 });

        console.log();
        console.log(colors.green + 'Session transcript saved to ' + colors.reset + colors.cyan + mdPath + colors.reset);
        console.log(colors.gray + 'JSON data: ' + jsonPath + colors.reset);
      } catch (transcriptErr) {
        if (verbose) {
          console.log(colors.yellow + 'Warning: Failed to save session transcript: ' + transcriptErr.message + colors.reset);
        }
      }

      return;
    }

    if (status === 'failed' || status === 'cancelled') {
      if (hasProgressBar) process.stdout.write('\r' + ' '.repeat(100) + '\r');
      console.error(colors.red + 'Session ' + status + '.' + colors.reset);
      process.exit(1);
    }
  }

  // Timeout
  if (hasProgressBar) process.stdout.write('\r' + ' '.repeat(100) + '\r');
  console.error(colors.red + 'Session timed out after ' + maxPolls + ' polls (60 minutes).' + colors.reset);
  console.error('Check status: node legion-x.mjs geth:session ' + sessionId);
  console.error('Resume stuck session: node legion-x.mjs geth:resume ' + sessionId);
  process.exit(1);
}

async function runOrchestration(prompt, options) {
  var config = new LegionConfig();

  // Auto-import NHA credentials from PIF if not yet configured
  if (!config.get('nhaAgentId') || !config.get('nhaPrivateKeyPem')) {
    var pifConfigPath = path.join(os.homedir(), '.pif', 'config.json');
    if (fs.existsSync(pifConfigPath)) {
      try {
        var pifConfig = JSON.parse(fs.readFileSync(pifConfigPath, 'utf-8'));
        if (pifConfig.agentId && pifConfig.privateKeyPem) {
          config.set('nhaAgentId', pifConfig.agentId);
          config.set('nhaAgentName', pifConfig.agentName || '');
          config.set('nhaPrivateKeyPem', pifConfig.privateKeyPem);
          config.set('nhaPublicKeyHex', pifConfig.publicKeyHex || '');
          console.log(colors.green + '[AUTH] Auto-linked NHA identity from PIF (' + (pifConfig.agentName || pifConfig.agentId) + ')' + colors.reset);
        }
      } catch (_) { /* ignore parse errors */ }
    }
    // If still no credentials, show helpful message
    if (!config.get('nhaAgentId') || !config.get('nhaPrivateKeyPem')) {
      console.error(colors.red + 'No NHA identity found.' + colors.reset);
      console.error('\nLegion requires a registered NHA agent identity.');
      console.error('Register with PIF first:\n');
      console.error('  ' + colors.cyan + 'curl -fsSL https://nothumanallowed.com/cli/install.sh | bash' + colors.reset);
      console.error('  ' + colors.cyan + 'pif register --name "YourAgentName"' + colors.reset);
      console.error('\nThen run ' + colors.cyan + 'legion auth' + colors.reset + ' or simply re-run ' + colors.cyan + 'legion run' + colors.reset + '.');
      process.exit(1);
    }
  }

  var client = new LegionClient(config);

  printBanner();

  // =================================================================
  // ORCHESTRATION MODE SELECTION
  //
  // Default: Zero-knowledge client orchestration (v1.8+)
  //   - API key NEVER leaves the client
  //   - Server provides orchestration intelligence (prompts, ONNX routing,
  //     convergence measurement) but makes ZERO LLM calls
  //
  // Legacy: --server-key flag for backward compat
  //   - API key is sent to server for proxied LLM calls
  //   - Kept for users who prefer server-side execution
  // =================================================================
  if (options.serverKey) {
    // Legacy: server-proxied mode (API key sent to server)
    await runServerConsensus(prompt, options, config, client);
  } else {
    // Default: zero-knowledge client orchestration
    await runClientOrchestration(prompt, options, config, client);
  }
  return;

  // --- Legacy local orchestration (unreachable, kept for reference) ---
  var registry = new AgentRegistry();
  var llm = new LLMProvider(config);
  var verbose = options.verbose !== undefined ? options.verbose : config.get('verbose');
  var totalStart = Date.now();

  // Initialize
  console.log(colors.gray + 'Initializing agent registry...' + colors.reset);
  await registry.initialize(client);

  // Initialize Geth Consensus layers (non-blocking, failures are non-critical)
  var gating = null;
  var auction = null;
  var evolution = null;

  // Runtime overrides: --no-* flags take precedence over config
  var debateActive = config.get('debateEnabled') && !options.noDebate;
  var gatingActive = config.get('gatingEnabled') && !options.noGating;
  var auctionActive = config.get('auctionEnabled') && !options.noAuction;
  var evolutionActive = config.get('evolutionEnabled') && !options.noEvolution;
  // v4.0.0 runtime overrides
  var refinementActive = config.get('refinementEnabled') !== false && !options.noRefinement;
  var ensembleActive = config.get('ensembleEnabled') !== false && !options.noEnsemble;
  var memoryActive = config.get('memoryEnabled') !== false && !options.noMemory;
  var workspaceActive = config.get('workspaceEnabled') !== false && !options.noWorkspace;
  // v5.0.0 runtime overrides
  var latentSpaceActive = config.get('latentSpaceEnabled') !== false && !options.noLatentSpace;
  var commStreamActive = config.get('commStreamEnabled') !== false && !options.noCommStream;
  var knowledgeGraphActive = config.get('knowledgeGraphEnabled') !== false && !options.noKnowledgeGraph;
  var promptEvolutionActive = config.get('promptEvolutionEnabled') !== false && !options.noPromptEvolution;
  var metaIntelActive = config.get('metaIntelligenceEnabled') !== false && !options.noMeta;

  if (gatingActive) {
    gating = new GethGating(registry, client);
    await gating.initialize();
  }
  if (auctionActive) {
    auction = new GethAuction(registry, client);
    await auction.initialize();
    var regenAmount = auction.regenerateBudgets();
    if (verbose) {
      console.log(colors.dim + '  [AUCTION] Budget regenerated: +' + regenAmount.toFixed(1) + ' per agent' + colors.reset);
    }
  }
  if (evolutionActive) {
    evolution = new GethEvolution(llm, client);
    await evolution.initialize();
  }

  // If --agents flag, force specific agents
  var forcedAgents = options.agents ? options.agents.split(',').map(function(a) { return a.trim(); }) : null;

  // =========================================================================
  // Pre-step: Knowledge retrieval (if enabled)
  // =========================================================================
  var knowledgeActive = (config.get('knowledgeEnabled') !== false) && !options.noKnowledge;
  var knowledgeContext = '';
  if (knowledgeActive) {
    try {
      var knowledge = await client.searchKnowledge(prompt, 3);
      if (knowledge && knowledge.data && knowledge.data.length > 0) {
        if (verbose) {
          console.log(colors.gray + '  Found ' + knowledge.data.length + ' relevant prior result(s)' + colors.reset);
        }
        knowledgeContext = '\n\nRelevant prior results (use as reference, do not copy):\n';
        for (var ki = 0; ki < knowledge.data.length; ki++) {
          var kEntry = knowledge.data[ki];
          knowledgeContext += '- [Score: ' + ((kEntry.qualityScore || 0) * 100).toFixed(0) + '%] ' + (kEntry.content || '') + '\n';
        }
      }
    } catch {}
  }

  // =========================================================================
  // Step 1: Decompose (with Evolutionary hints if available)
  // =========================================================================
  var planStart = Date.now();
  console.log(colors.yellow + '\n[1/7] Analyzing prompt...' + colors.reset);
  var historyDecompActive = config.get('historyAwareDecomposition') !== false && !options.noHistoryDecomposition;
  var decomposer = new TaskDecomposer(llm, registry, {
    gating: historyDecompActive ? gating : null,
    client: historyDecompActive ? client : null,
    verbose: verbose,
  });

  // Layer 4: Evolutionary Decomposition — use learned strategy hints
  var usedStrategy = null;
  var decompositionPrompt = prompt;
  if (evolution && evolution.isMature) {
    usedStrategy = evolution.getDecompositionHint();
    if (usedStrategy) {
      decompositionPrompt = evolution.enhancePrompt(prompt, usedStrategy);
      if (verbose) {
        console.log(colors.gray + '  [EVOLUTION] Tournament(k=' + evolution.tournamentSize +
          ') selected: ' + (usedStrategy.strategy.splitMethod || 'adaptive') +
          ' (fitness: ' + (usedStrategy.fitness * 100).toFixed(0) + '%, gen: ' +
          (usedStrategy.generation || '?') + ')' + colors.reset);
      }
    }
  }

  var decomposition = await decomposer.decompose(decompositionPrompt, knowledgeContext);
  var planDuration = Date.now() - planStart;
  console.log(colors.green + '  Decomposed into ' + decomposition.tasks.length + ' sub-task(s)' + colors.reset);

  for (var i = 0; i < decomposition.tasks.length; i++) {
    var t = decomposition.tasks[i];
    console.log(colors.gray + '  [' + t.id + '] ' + t.description + colors.reset);
  }

  // =========================================================================
  // Step 2: Match agents (with MoE Gating if available)
  // =========================================================================
  console.log(colors.yellow + '\n[2/7] Matching agents...' + colors.reset);
  var matcher = new AgentMatcher(registry);
  var matchResults = [];

  if (forcedAgents) {
    for (var j = 0; j < decomposition.tasks.length; j++) {
      var agentIdx = j % forcedAgents.length;
      decomposition.tasks[j].assignedAgent = forcedAgents[agentIdx];
    }
  } else {
    // Layer 0: Axon Reflex — O(1) direct routing for exact capability matches
    for (var ari = 0; ari < decomposition.tasks.length; ari++) {
      var arTask = decomposition.tasks[ari];
      if (arTask.assignedAgent) continue;
      var axonResult = matcher.axonReflex(arTask);
      if (axonResult) {
        arTask.assignedAgent = axonResult.agentName;
        matchResults.push({
          taskId: arTask.id,
          agentName: axonResult.agentName,
          score: 1.0,
          gated: true,
          axonReflex: true,
        });
        if (verbose) {
          console.log(colors.gray + '  [AXON] ' + axonResult.agentName.toUpperCase() +
            ': ' + axonResult.reason + ' → ' + arTask.id + colors.reset);
        }
      }
    }

    // Layer 2: MoE Gating — learned routing for tasks not resolved by axon reflex
    if (gating && gating.weights.size > 0) {
      for (var gi = 0; gi < decomposition.tasks.length; gi++) {
        var gTask = decomposition.tasks[gi];
        if (gTask.assignedAgent) continue; // Already assigned by axon reflex
        var candidates = gating.getTopCandidates(gTask, matcher, 5, verbose);
        if (candidates.length > 0) {
          gTask.assignedAgent = candidates[0].agent.name;
          matchResults.push({
            taskId: gTask.id,
            agentName: candidates[0].agent.name,
            score: candidates[0].score,
            gated: true,
          });
          if (verbose) {
            var gd = candidates[0].gatingDetails;
            var gatingInfo = gd && gd.thompsonSample !== null
              ? 'β(' + gd.alpha + ',' + gd.beta + ') sample=' + gd.thompsonSample.toFixed(2)
              : 'legacy';
            console.log(colors.gray + '  [GATING] ' + candidates[0].agent.name.toUpperCase() +
              ': ' + gatingInfo + ', final=' + (candidates[0].score * 100).toFixed(0) +
              '% → ' + gTask.id + colors.reset);
          }
        }
      }
    }

    // Legacy matching for any unassigned tasks
    var legacyMatches = matcher.matchAll(decomposition);
    for (var li = 0; li < legacyMatches.length; li++) {
      var alreadyGated = matchResults.some(function(m) { return m.taskId === legacyMatches[li].taskId; });
      if (!alreadyGated) {
        matchResults.push(legacyMatches[li]);
      }
    }
  }

  // Anti-monopoly diversification: no agent gets more than MAX_TASKS_PER_AGENT tasks
  if (!forcedAgents) {
    var MAX_TASKS_PER_AGENT = 3;
    var agentTaskCount = {};
    for (var dvi = 0; dvi < decomposition.tasks.length; dvi++) {
      var dvAgent = decomposition.tasks[dvi].assignedAgent;
      agentTaskCount[dvAgent] = (agentTaskCount[dvAgent] || 0) + 1;
    }
    // Reassign excess tasks to next-best candidate using full scoring
    for (var dvi2 = 0; dvi2 < decomposition.tasks.length; dvi2++) {
      var dvTask = decomposition.tasks[dvi2];
      if (agentTaskCount[dvTask.assignedAgent] > MAX_TASKS_PER_AGENT) {
        // Skip axon-reflex assignments — they are authoritative
        var wasAxon = matchResults.some(function(m) { return m.taskId === dvTask.id && m.axonReflex; });
        if (wasAxon) continue;

        // Full scoring: 40% keyword + 30% perf + 20% category + 10% availability + specialist bonus
        var allAlts = [];
        var allAgentsArr = registry.getAllAgents();
        for (var altI = 0; altI < allAgentsArr.length; altI++) {
          var altA = allAgentsArr[altI];
          if (altA.name !== dvTask.assignedAgent && (agentTaskCount[altA.name] || 0) < MAX_TASKS_PER_AGENT) {
            var altKeyword = matcher.keywordScore(dvTask.capability, dvTask.description, altA.capabilities);
            var altPerf = matcher.performanceScore(altA);
            var altCat = matcher.categoryScore(dvTask.capability, altA.category);
            var altHealth = registry.getHealth(altA.name);
            var altAvail = altHealth.state === 'closed' ? 1.0 : (altHealth.state === 'half-open' ? 0.5 : 0);
            var altFullScore = altKeyword * 0.4 + altPerf * 0.3 + altCat * 0.2 + altAvail * 0.1;
            if (altA.parentAgent && altKeyword >= 0.6) altFullScore += 0.25;
            if (altFullScore > 0.1) {
              allAlts.push({ name: altA.name, score: altFullScore });
            }
          }
        }
        allAlts.sort(function(a, b) { return b.score - a.score; });
        if (allAlts.length > 0) {
          var oldAgent = dvTask.assignedAgent;
          dvTask.assignedAgent = allAlts[0].name;
          agentTaskCount[oldAgent]--;
          agentTaskCount[allAlts[0].name] = (agentTaskCount[allAlts[0].name] || 0) + 1;
          if (verbose) {
            console.log(colors.gray + '  [DIVERSIFY] ' + dvTask.id + ': ' + oldAgent.toUpperCase() +
              ' -> ' + allAlts[0].name.toUpperCase() + ' (anti-monopoly, score=' +
              allAlts[0].score.toFixed(2) + ')' + colors.reset);
          }
        }
      }
    }
  }

  // =========================================================================
  // Step 2.5: Ensemble Pattern Bias (Fix 9) — bonus for proven agent combos
  // =========================================================================
  if (ensembleActive && !forcedAgents && decomposition.tasks.length >= 2) {
    try {
      var taskCaps = decomposition.tasks.map(function(t) { return t.capability || 'general'; }).filter(function(c) { return c !== 'general'; });
      if (taskCaps.length >= 2) {
        var ensembleResult = await client.queryEnsemblePatterns(taskCaps, 3);
        if (ensembleResult && ensembleResult.data && ensembleResult.data.length > 0) {
          // Apply ensemble bonus: agents in proven patterns get priority
          for (var ep = 0; ep < ensembleResult.data.length; ep++) {
            var pattern = ensembleResult.data[ep];
            if (verbose) {
              console.log(colors.gray + '  [ENSEMBLE] Pattern: ' + JSON.stringify(pattern.agentSet) +
                ' (quality: ' + (pattern.avgQuality * 100).toFixed(0) + '%, n=' + pattern.sampleCount + ')' + colors.reset);
            }
            // Boost agents from this pattern for unassigned tasks
            for (var et = 0; et < decomposition.tasks.length; et++) {
              var eTask = decomposition.tasks[et];
              if (!eTask.assignedAgent) continue;
              // If agent is in the pattern, mark for bonus (used by gating scoring)
              if (pattern.agentSet.includes(eTask.assignedAgent)) {
                eTask._ensembleBonus = 0.15;
              }
            }
          }
        }
      }
    } catch {
      // Non-critical: ensemble matching is optional
    }
  }

  // =========================================================================
  // Step 3: Market Auction (override assignments via bidding)
  // =========================================================================
  var auctionResults = [];
  if (auction && auctionActive && !forcedAgents) {
    console.log(colors.yellow + '\n[3/7] Running market auction...' + colors.reset);

    for (var ai = 0; ai < decomposition.tasks.length; ai++) {
      var aTask = decomposition.tasks[ai];

      // v4.0.0 Fix 2: Axon Reflex Protection — skip auction for axon-resolved tasks
      var wasAxonReflex = matchResults.some(function(m) { return m.taskId === aTask.id && m.axonReflex; });
      if (wasAxonReflex) {
        if (verbose) {
          console.log(colors.gray + '  [AUCTION] ' + aTask.id + ' → ' + (aTask.assignedAgent || '?').toUpperCase() + ' (axon-protected, skipping auction)' + colors.reset);
        }
        continue;
      }

      var aCandidates = gating
        ? gating.getTopCandidates(aTask, matcher, 5)
        : [{ agent: registry.getAgent(aTask.assignedAgent) || registry.getAgent('oracle'), score: 0.5 }];

      // Inject sub-agents that match capability but aren't in pool yet
      if (aTask.capability) {
        var capAgents = registry.findByCapability(aTask.capability.toLowerCase());
        for (var cai = 0; cai < capAgents.length; cai++) {
          var capAgent = registry.getAgent(capAgents[cai]);
          if (!capAgent) continue;
          var alreadyInPool = aCandidates.some(function(c) { return c.agent && c.agent.name === capAgent.name; });
          if (!alreadyInPool) {
            var capHealth = registry.getHealth(capAgent.name);
            if (capHealth.state !== 'open') {
              // Newcomer boost: 1.3x base score to make them competitive
              var baseScore = matcher.keywordScore(aTask.capability, aTask.description, capAgent.capabilities) * 0.4 +
                matcher.performanceScore(capAgent) * 0.3 + matcher.categoryScore(aTask.capability, capAgent.category) * 0.2 +
                (capHealth.state === 'closed' ? 0.1 : 0.05);
              if (capAgent.parentAgent) baseScore += 0.25;
              aCandidates.push({ agent: capAgent, score: baseScore * 1.3, gatingDetails: { score: baseScore * 1.3, thompsonSample: null, alpha: null, beta: null } });
            }
          }
        }
      }

      var aResult = auction.runAuction(aTask, aCandidates);
      if (aResult) {
        aTask.assignedAgent = aResult.agentName;
        auctionResults.push(aResult);
        if (verbose) {
          var reserveNote = aResult.belowReserve ? ' [BELOW RESERVE]' : '';
          console.log(colors.gray + '  [AUCTION] ' + aTask.id + ' → ' +
            aResult.agentName.toUpperCase() + ' (bid: ' + aResult.bid.toFixed(2) +
            ', payment: ' + aResult.payment.toFixed(2) + reserveNote + ')' + colors.reset);
          // Log filtered bids below reserve
          if (aResult.candidates) {
            for (var fc = 0; fc < aResult.candidates.length; fc++) {
              if (aResult.candidates[fc].bid < auction.reservePrice && aResult.candidates[fc].name !== aResult.agentName) {
                console.log(colors.dim + '    [AUCTION] ' + aResult.candidates[fc].name.toUpperCase() +
                  ' bid ' + aResult.candidates[fc].bid.toFixed(2) + ' < reserve ' +
                  auction.reservePrice.toFixed(1) + ', filtered' + colors.reset);
              }
            }
          }
        }
      }
    }

    console.log(colors.green + '  Auction: ' + auctionResults.length + ' task(s) allocated' + colors.reset);
  } else {
    console.log(colors.gray + '\n[3/7] Market auction: ' + (forcedAgents ? 'skipped (forced agents)' : 'skipped') + colors.reset);
  }

  for (var k = 0; k < decomposition.tasks.length; k++) {
    var assignedTask = decomposition.tasks[k];
    console.log(colors.cyan + '  [' + assignedTask.id + '] -> ' + (assignedTask.assignedAgent || 'oracle').toUpperCase() + colors.reset);
  }

  // Dry run: show plan and exit
  if (options.dryRun) {
    console.log(colors.yellow + '\n[DRY RUN] Execution plan shown above. No tasks executed.' + colors.reset);
    return;
  }

  // =========================================================================
  // Step 3.5: v5.0.0 — Initialize Collective Intelligence components
  // =========================================================================
  var configDir = path.join(process.env.HOME || '.', '.legion');
  var runId = crypto.randomUUID();
  var commStream = commStreamActive ? new CommunicationStream() : null;
  if (commStream) {
    commStream._divergenceThreshold = config.get('convergenceDivergenceThreshold') || 0.72;
  }
  var promptEvolver = null;
  if (promptEvolutionActive) {
    promptEvolver = new PromptEvolver(configDir);
    await promptEvolver.load();
    var evolStats = promptEvolver.getEvolutionStats();
    if (verbose && evolStats.totalPatches > 0) {
      console.log(colors.gray + '  [EVOLUTION] Loaded ' + evolStats.totalPatches +
        ' prompt patches across ' + evolStats.agentCount + ' agent(s)' + colors.reset);
    }
  }
  var metaIntelligence = null;
  if (metaIntelActive) {
    metaIntelligence = new MetaIntelligence(configDir);
    await metaIntelligence.load();
  }

  // =========================================================================
  // Step 4: Execute with Deliberation (v6.0.0: Real Inter-Agent Consensus)
  // =========================================================================
  var deliberationActive = config.get('deliberationEnabled') !== false && !options.noDeliberation;
  console.log(colors.yellow + '\n[4/7] Executing with ' + decomposition.tasks.length + ' agent(s)' +
    (deliberationActive ? ' + deliberation' : '') + '...' + colors.reset);
  var engine = new ExecutionEngine(registry, llm, config);

  // v5.0.0→v7.0.0: Wire collective intelligence components to engine
  engine.commStream = commStream;
  engine.promptEvolver = promptEvolver;
  engine.runId = runId;
  engine.client = client;
  engine.latentSpaceEnabled = latentSpaceActive;
  engine.knowledgeGraphEnabled = knowledgeGraphActive;
  // v7.0.0: Semantic convergence client — null when disabled (forces Jaccard fallback)
  var semanticConvergenceActive = config.get('semanticConvergenceEnabled') !== false && !options.noSemanticConvergence;
  engine._semanticConvergenceClient = semanticConvergenceActive ? client : null;

  // v7.0.0: Retrieve episodic memories with semantic ranking
  //   - Fetches 10 memories per agent:capability (was 3)
  //   - Ranks by embedding similarity to current task description
  //   - Returns top 3 most RELEVANT memories (not most recent)
  //   - Falls back to recency-based (first 3) if embeddings fail
  var semanticMemoryActive = config.get('semanticMemoryEnabled') !== false && !options.noSemanticMemory;
  if (memoryActive) {
    try {
      engine._memories = {};
      for (var mi = 0; mi < decomposition.tasks.length; mi++) {
        var mTask = decomposition.tasks[mi];
        var mAgent = mTask.assignedAgent || 'oracle';
        var mCap = mTask.capability || 'general';
        var memKey = mAgent + ':' + mCap;
        if (!engine._memories[memKey]) {
          var memFetchCount = semanticMemoryActive ? 10 : 3;
          var memResult = await client.getMemories(mAgent, mCap, memFetchCount);
          if (memResult && memResult.data && memResult.data.length > 0) {
            var selectedMemories = memResult.data;
            var memMethod = 'recency';

            // v7.0.0: Semantic ranking via embeddings
            if (semanticMemoryActive && selectedMemories.length > 3) {
              try {
                var memTexts = [mTask.description];
                for (var mt = 0; mt < selectedMemories.length; mt++) {
                  memTexts.push(selectedMemories[mt].content);
                }
                var memEmbResp = await client.getBatchEmbeddings(memTexts);
                if (memEmbResp && memEmbResp.embeddings && memEmbResp.embeddings.length === memTexts.length) {
                  var taskEmb = memEmbResp.embeddings[0];
                  var scored = [];
                  for (var ms = 0; ms < selectedMemories.length; ms++) {
                    var memEmb = memEmbResp.embeddings[ms + 1];
                    var simScore = 0;
                    if (taskEmb && memEmb && taskEmb.length === memEmb.length) {
                      var dot = 0, nA = 0, nB = 0;
                      for (var sv = 0; sv < taskEmb.length; sv++) {
                        dot += taskEmb[sv] * memEmb[sv];
                        nA += taskEmb[sv] * taskEmb[sv];
                        nB += memEmb[sv] * memEmb[sv];
                      }
                      var denom = Math.sqrt(nA) * Math.sqrt(nB);
                      simScore = denom > 0 ? dot / denom : 0;
                    }
                    scored.push({ memory: selectedMemories[ms], similarity: simScore });
                  }
                  scored.sort(function(a, b) { return b.similarity - a.similarity; });
                  selectedMemories = scored.slice(0, 3).map(function(s) { return s.memory; });
                  memMethod = 'semantic (top sim: ' + scored[0].similarity.toFixed(2) + ')';
                }
              } catch (_) {
                // Fallback to recency
                selectedMemories = selectedMemories.slice(0, 3);
              }
            } else {
              selectedMemories = selectedMemories.slice(0, 3);
            }

            var memContext = '\n\nEpisodic memories (selected by ' + memMethod + '):\n';
            for (var mj = 0; mj < selectedMemories.length; mj++) {
              var mem = selectedMemories[mj];
              memContext += '- [' + mem.episodeType + ', quality:' + (mem.quality * 100).toFixed(0) + '%] ' + mem.content + '\n';
            }
            engine._memories[memKey] = memContext;
            if (verbose) {
              console.log(colors.gray + '  [MEMORY] ' + mAgent.toUpperCase() + ':' + mCap + ' → ' +
                selectedMemories.length + '/' + memResult.data.length + ' memories (' + memMethod + ')' + colors.reset);
            }
          }
        }
      }
    } catch {
      // Non-critical: agent execution works without memories
    }
  }

  // v6.0.0: Progress handler with deliberation awareness
  var progressHandler = function(event) {
    if (event.type === 'agent_start') {
      process.stdout.write(colors.gray + '  [' + event.taskId + '] ' + event.agentName.toUpperCase() + ' working...' + colors.reset + '\r');
    } else if (event.type === 'agent_complete') {
      console.log(colors.green + '  [' + event.taskId + '] ' + event.agentName.toUpperCase() + ' done (' + formatDuration(event.durationMs) + ')' + colors.reset);
    } else if (event.type === 'agent_retry_success') {
      var retryMsg = event.originalAgent
        ? event.originalAgent.toUpperCase() + ' failed \u2192 ' + event.agentName.toUpperCase()
        : event.agentName.toUpperCase();
      console.log(colors.yellow + '  [' + event.taskId + '] ' + retryMsg + ' retried OK (' + formatDuration(event.durationMs) + ')' + colors.reset);
    } else if (event.type === 'agent_failed') {
      console.log(colors.red + '  [' + event.taskId + '] ' + event.agentName.toUpperCase() + ' FAILED: ' + (event.error || '').substring(0, 80) + colors.reset);
    } else if (event.type === 'deliberation_round') {
      console.log(colors.cyan + '\n  [DELIBERATION] Round ' + event.round + ': ' + event.description + colors.reset);
    } else if (event.type === 'deliberation_skip') {
      console.log(colors.gray + '  [DELIBERATION] Skipped: ' + event.reason +
        ' (convergence: ' + (event.convergence * 100).toFixed(0) + '%)' + colors.reset);
    } else if (event.type === 'deliberation_converged') {
      console.log(colors.green + '  [DELIBERATION] Converged at round ' + event.round +
        ' (convergence: ' + (event.convergence * 100).toFixed(0) + '%)' + colors.reset);
    }
  };

  // v6.0.0: Use DeliberationEngine for multi-agent tasks
  var executionResult;
  if (deliberationActive) {
    var deliberation = new DeliberationEngine(engine, config, { liaraMode: !!options.liaraMode });
    executionResult = await deliberation.deliberate(decomposition, progressHandler);
  } else {
    executionResult = await engine.executeAll(decomposition, progressHandler);
    executionResult.deliberation = { rounds: 0, converged: true, skipped: true, reason: 'disabled' };
  }

  console.log(colors.green + '  Completed: ' + executionResult.completedCount + '/' +
    decomposition.tasks.length + ' in ' + formatDuration(executionResult.totalDurationMs) + colors.reset);

  // v6.0.0: Report deliberation results
  if (executionResult.deliberation && !executionResult.deliberation.skipped) {
    var dlib = executionResult.deliberation;
    console.log(colors.cyan + '  [DELIBERATION] ' + dlib.rounds + ' round(s), ' +
      (dlib.converged ? 'converged' : 'not converged') +
      ' (final convergence: ' + ((dlib.convergence || 0) * 100).toFixed(0) + '%, method: ' +
      (dlib.convergenceMethod || 'unknown') + ')' + colors.reset);
    if (dlib.convergenceHistory && dlib.convergenceHistory.length > 1) {
      console.log(colors.gray + '  [DELIBERATION] Convergence path: ' +
        dlib.convergenceHistory.map(function(c) { return (c * 100).toFixed(0) + '%'; }).join(' → ') + colors.reset);
    }
    if (dlib.mediatedAgents && dlib.mediatedAgents.length > 0) {
      console.log(colors.gray + '  [DELIBERATION] Mediated agents: ' +
        dlib.mediatedAgents.map(function(a) { return a.toUpperCase(); }).join(', ') + colors.reset);
    }
  }

  // v4.0.0 Fix 1: Report workspace entries
  if (workspaceActive && engine.workspace.size > 0 && verbose) {
    console.log(colors.gray + '  [WORKSPACE] ' + engine.workspace.size + ' entries shared between agents' + colors.reset);
    for (var wi = 0; wi < engine.workspace.entries.length; wi++) {
      var we = engine.workspace.entries[wi];
      console.log(colors.dim + '    [' + we.agent.toUpperCase() + ':' + we.type + ':' + we.tag + '] ' + we.content.substring(0, 80) + colors.reset);
    }
  }

  // v5.0.0: Report communication stream activity
  if (commStream && commStream.thoughts.length > 0 && verbose) {
    var streamStats = commStream.getCrossPollination();
    console.log(colors.gray + '  [STREAM] ' + commStream.thoughts.length + ' thoughts emitted, ' +
      streamStats.interactions + ' cross-pollination events' + colors.reset);
    for (var sti = 0; sti < Math.min(commStream.thoughts.length, 5); sti++) {
      var st = commStream.thoughts[sti];
      var stConf = st.confidence ? ' (' + (st.confidence * 100).toFixed(0) + '%)' : '';
      console.log(colors.dim + '    [' + st.agent.toUpperCase() + ':' + st.type + stConf + '] ' +
        st.content.substring(0, 80) + colors.reset);
    }
  }

  // =========================================================================
  // Step 5: Weighted Authority Synthesis (Fix 6)
  // =========================================================================
  var synthStart = Date.now();
  console.log(colors.yellow + '\n[5/7] Synthesizing results...' + colors.reset);
  var synthesizer = new ResultSynthesizer(llm);
  var synthesis = await synthesizer.synthesize(prompt, executionResult.contributions, {
    registry: registry,
    decomposition: decomposition,
    commStream: commStream, // v7.0.0: Pass for deliberation round tagging
  });
  var synthDuration = Date.now() - synthStart;

  // =========================================================================
  // v3.3.0: Step 5.5 — Evaluate quality BEFORE debate (not after)
  //
  // The debate's value estimation needs the REAL quality score, not a naive
  // heuristic. By evaluating first, we know the actual quality and can make
  // an informed decision about whether debate is worth the token cost.
  //
  // Pipeline: Synthesize → Evaluate → Debate (if quality < threshold) → Re-evaluate
  // =========================================================================
  console.log(colors.yellow + '\n[6/7] Evaluating quality (pre-debate)...' + colors.reset);
  var evaluator = new QualityEvaluator(llm);
  var preDebateQuality = await evaluator.evaluate(prompt, synthesis.result, {
    agentCount: executionResult.contributions.length,
    contributions: executionResult.contributions,
  });
  var preDebateScore = preDebateQuality.overall;
  console.log(colors.gray + '  Pre-debate quality: ' + (preDebateScore * 100).toFixed(0) + '%' + colors.reset);

  // =========================================================================
  // Step 6: Geth Consensus Debate — informed by real quality score
  // =========================================================================
  var debateResult = null;
  var finalResult = synthesis.result;
  var quality = preDebateQuality;
  var debateStart = Date.now();

  if (debateActive && executionResult.completedCount >= config.get('debateMinContributions')) {
    var debate = new GethDebate(llm, config);
    // v3.3.0: Pass the REAL quality score (not a length-based heuristic)
    debateResult = await debate.debate(prompt, synthesis.result, executionResult.contributions, preDebateScore);

    if (debateResult.skipped) {
      console.log(colors.gray + '  Debate: skipped — ' +
        (debateResult.skipReason || 'estimated value too low') +
        ' (quality already ' + (preDebateScore * 100).toFixed(0) + '%)' + colors.reset);
    } else {
      finalResult = debateResult.finalConsensus;
      console.log(colors.green + '  Debate: ' + debateResult.totalRoundsUsed + ' round(s), ' +
        (debateResult.converged ? 'converged' : 'max rounds reached') +
        ' (' + formatDuration(debateResult.durationMs) + ')' + colors.reset);

      // v3.3.0: Re-evaluate quality after debate improvement
      console.log(colors.yellow + '\n[7/7] Re-evaluating quality (post-debate)...' + colors.reset);
      quality = await evaluator.evaluate(prompt, finalResult, {
        agentCount: executionResult.contributions.length,
        contributions: executionResult.contributions,
      });

      var qualityDelta = quality.overall - preDebateScore;
      console.log(colors.gray + '  Quality: ' + (preDebateScore * 100).toFixed(0) + '% → ' +
        (quality.overall * 100).toFixed(0) + '% (' +
        (qualityDelta > 0 ? '+' : '') + (qualityDelta * 100).toFixed(0) + '%)' + colors.reset);

      // v3.3.0: If debate DECREASED quality, revert to pre-debate synthesis
      if (quality.overall < preDebateScore - 0.02) {
        console.log(colors.yellow + '  Debate decreased quality — reverting to pre-debate synthesis' + colors.reset);
        finalResult = synthesis.result;
        quality = preDebateQuality;
      }
    }

    if (debateResult.rounds.length > 0) {
      var firstScore = debateResult.rounds[0].advocateScore;
      var lastScore = debateResult.rounds[debateResult.rounds.length - 1].advocateScore;
      var improvement = lastScore - firstScore;
      console.log(colors.gray + '  Debate score: ' + (firstScore * 100).toFixed(0) + '% → ' +
        (lastScore * 100).toFixed(0) + '% (' +
        (improvement > 0 ? '+' : '') + (improvement * 100).toFixed(0) + '%)' + colors.reset);
    }
  } else {
    console.log(colors.gray + '\n[7/7] Debate: skipped (' +
      (executionResult.completedCount < config.get('debateMinContributions')
        ? 'insufficient contributions' : 'disabled') + ')' + colors.reset);
  }
  var debateDuration = Date.now() - debateStart;

  // =========================================================================
  // Step 7.5: Iterative Refinement Loop (v4.0.0)
  //
  // If quality < 0.70 and 2+ agents contributed, identify the weakest 1-2
  // sub-tasks, re-execute them with a different agent + enriched context,
  // then re-synthesize and re-evaluate. Max 1 refinement iteration.
  // =========================================================================
  var refinementUsed = false;
  if (refinementActive && quality.overall < 0.70 && executionResult.completedCount >= 2) {
    console.log(colors.yellow + '\n[7.5/8] Iterative refinement — quality ' +
      (quality.overall * 100).toFixed(0) + '% < 70% threshold...' + colors.reset);

    // Identify weakest 1-2 contributions by per-agent heuristic
    var contribsForRefine = executionResult.contributions.filter(function(c) {
      return c.status === 'completed' && c.result;
    }).map(function(c) {
      var subTask = decomposition.tasks.find(function(t) { return t.id === c.subTaskId; });
      var substCheck = evaluator.analyzeSubstance(c.result);
      return { contrib: c, subTask: subTask, substance: substCheck.ratio, length: c.result.length };
    }).sort(function(a, b) { return a.substance - b.substance; });

    var weakCount = Math.min(2, Math.max(1, Math.floor(contribsForRefine.length / 2)));
    var weakest = contribsForRefine.slice(0, weakCount);

    if (weakest.length > 0 && weakest[0].subTask) {
      console.log(colors.gray + '  Weakest sub-task(s): ' + weakest.map(function(w) {
        return w.contrib.agentName + ' (substance: ' + (w.substance * 100).toFixed(0) + '%)';
      }).join(', ') + colors.reset);

      var refinedContribs = [];
      for (var ri = 0; ri < weakest.length; ri++) {
        var weak = weakest[ri];
        // Find a different agent for this capability
        var capability = (weak.subTask && weak.subTask.capability) ? weak.subTask.capability : 'general';
        var originalAgent = weak.contrib.agentName.toLowerCase();
        var alternateAgent = registry.findBestMatch(capability, [originalAgent]);

        if (!alternateAgent) {
          alternateAgent = registry.findBestMatch('general', [originalAgent]);
        }
        if (!alternateAgent) continue;

        // Build enriched context: original prompt + synthesis feedback + workspace
        var enrichedPrompt = weak.subTask.description + '\n\n' +
          '[REFINEMENT CONTEXT]\n' +
          'The previous attempt by ' + weak.contrib.agentName + ' scored poorly.\n' +
          'Key feedback: ' + (quality.feedback || 'Quality below threshold.') + '\n' +
          'Focus on substance, completeness, and addressing all requirements.\n' +
          '[/REFINEMENT CONTEXT]';

        if (workspaceActive && engine.workspace) {
          var wsSnap = engine.workspace.getSnapshot();
          if (wsSnap) {
            enrichedPrompt += '\n\n[SHARED WORKSPACE]\n' + wsSnap + '\n[/SHARED WORKSPACE]';
          }
        }

        console.log(colors.gray + '  Re-executing ' + weak.subTask.id + ' with ' +
          alternateAgent.name + ' (was ' + weak.contrib.agentName + ')...' + colors.reset);

        try {
          var refinedTask = Object.assign({}, weak.subTask, {
            assignedAgent: alternateAgent.name,
            description: enrichedPrompt,
          });
          var refinedResult = await engine.executeOne(refinedTask, decomposition);

          if (refinedResult && refinedResult.result) {
            refinedContribs.push({
              original: weak.contrib,
              refined: {
                agentName: refinedResult.agentName || alternateAgent.name,
                subTaskId: weak.subTask.id,
                result: refinedResult.result,
                durationMs: refinedResult.durationMs || 0,
                status: 'completed',
              },
              subTask: weak.subTask,
            });
          }
        } catch (refErr) {
          if (verbose) {
            console.log(colors.dim + '  Refinement failed for ' + weak.subTask.id + ': ' +
              (refErr && refErr.message ? refErr.message : String(refErr)) + colors.reset);
          }
        }
      }

      // Replace weak contributions and re-synthesize if we got improvements
      if (refinedContribs.length > 0) {
        var updatedContribs = executionResult.contributions.slice();
        for (var rci = 0; rci < refinedContribs.length; rci++) {
          var rc = refinedContribs[rci];
          var idx = updatedContribs.indexOf(rc.original);
          if (idx >= 0) {
            updatedContribs[idx] = Object.assign({}, rc.refined, {
              subTaskId: rc.subTask.id,
              agentName: rc.refined.agentName || rc.original.agentName,
              _refined: true,
            });
          }
        }

        // Re-synthesize
        var refinedSynthesis = await synthesizer.synthesize(prompt, updatedContribs, decomposition.tasks, {
          registry: registry,
          decomposition: decomposition,
        });

        // Re-evaluate
        var refinedQuality = await evaluator.evaluate(prompt, refinedSynthesis.result, {
          agentCount: updatedContribs.length,
          contributions: updatedContribs,
        });

        console.log(colors.gray + '  Refinement result: ' + (quality.overall * 100).toFixed(0) +
          '% → ' + (refinedQuality.overall * 100).toFixed(0) + '%' + colors.reset);

        // Only accept if refinement improved quality
        if (refinedQuality.overall > quality.overall) {
          var qualityGain = refinedQuality.overall - quality.overall;
          finalResult = refinedSynthesis.result;
          quality = refinedQuality;
          executionResult.contributions = updatedContribs;
          refinementUsed = true;
          console.log(colors.green + '  Refinement accepted (+' +
            (qualityGain * 100).toFixed(0) + '%)' + colors.reset);
        } else {
          console.log(colors.yellow + '  Refinement did not improve quality — keeping original' + colors.reset);
        }
      }
    }
  }

  var totalDuration = Date.now() - totalStart;

  // Token-aware CI Gain calculation
  var preUsage = llm.getUsage();
  var ciGain = evaluator.calculateCIGain(quality.overall, decomposition.tasks.length, config, preUsage);

  // Update running baseline after evaluation
  evaluator.updateBaseline(quality.overall, config);

  var samples = config.get('qualityBaselineSamples') || 0;
  if (samples < 3) {
    console.log(colors.yellow + '  Quality: ' + (quality.overall * 100).toFixed(0) +
      '% | CI: calibrating (' + (samples + 1) + '/3 runs)' + colors.reset);
  } else {
    console.log(colors.green + '  Quality: ' + (quality.overall * 100).toFixed(0) + '% | CI Gain: ' +
      (ciGain > 0 ? '+' : '') + (ciGain * 100).toFixed(0) + '%' + colors.reset);
  }
  // Substance & coverage line
  if (quality._substance) {
    console.log(colors.gray + '  Substance: ' + (quality._substance.ratio * 100).toFixed(0) +
      '% | Density: ' + (quality._substance.density * 100).toFixed(0) +
      '% | Filler: ' + quality._substance.fillerCount + ' phrase(s)' + colors.reset);
  }
  if (quality._structural) {
    console.log(colors.gray + '  Coverage: ' + quality._structural.addressed + '/' +
      quality._structural.total + ' prompt items addressed (' +
      (quality._structural.coverage * 100).toFixed(0) + '%)' + colors.reset);
  }
  if (quality._crossValidated) {
    var crossMsg = quality._crossDivergences > 0
      ? quality._crossDivergences + ' divergence(s) reconciled (adaptive)'
      : 'no major divergences';
    console.log(colors.gray + '  Cross-validated: ' + crossMsg + colors.reset);
  }
  // v4.0.0: Multi-signal grounding verbose output
  if (quality._deterministicScore !== undefined && quality._llmScore !== undefined) {
    console.log(colors.gray + '  Multi-signal: LLM=' + (quality._llmScore * 100).toFixed(0) +
      '% Det=' + (quality._deterministicScore * 100).toFixed(0) +
      '% (density=' + ((quality._deterministicSignals || {}).factualDensity * 100 || 0).toFixed(0) +
      '% compliance=' + ((quality._deterministicSignals || {}).instructionCompliance * 100 || 0).toFixed(0) +
      '% agreement=' + ((quality._deterministicSignals || {}).agentAgreement * 100 || 0).toFixed(0) +
      '%)' + colors.reset);
  }
  if (refinementUsed) {
    console.log(colors.green + '  Refinement: applied (improved weak sub-tasks)' + colors.reset);
  }
  if (quality.feedback) {
    console.log(colors.gray + '  Feedback: ' + quality.feedback + colors.reset);
  }

  // =========================================================================
  // Post-execution: Local Geth layer updates (memory only — no API calls)
  // API feedback is handled in the dedicated FEEDBACK LOOP section below.
  // v3.4.2: Removed duplicate API calls that were doubling every feedback signal.
  // =========================================================================

  // Layer 4: Record decomposition strategy locally + crossover
  if (evolution && evolutionActive) {
    if (!usedStrategy || !usedStrategy.id) {
      // Record new strategy locally (API update happens in feedback loop)
      evolution.recordStrategy(decomposition, ciGain).catch(function() {});
    }
    // Crossover: 20% chance of creating offspring from top 2 strategies
    evolution.maybeCreateOffspring(ciGain).then(function(child) {
      if (child && verbose) {
        console.log(colors.dim + '  [EVOLUTION] Crossover offspring created: ' +
          child.splitMethod + '/' + child.granularity + colors.reset);
      }
    }).catch(function() {});
  }

  // =========================================================================
  // Report task to API
  // =========================================================================
  var debateMeta = null;
  if (debateResult) {
    var dbFirstScore = debateResult.rounds.length > 0 ? debateResult.rounds[0].advocateScore : null;
    var dbLastScore = debateResult.rounds.length > 0 ? debateResult.rounds[debateResult.rounds.length - 1].advocateScore : null;
    debateMeta = {
      rounds: debateResult.rounds.map(function(r) {
        return {
          roundNumber: r.roundNumber,
          advocateScore: r.advocateScore,
          convergenceDelta: r.convergenceDelta,
          judge: r.judge,
        };
      }),
      converged: debateResult.converged,
      totalRounds: debateResult.totalRoundsUsed,
      initialScore: dbFirstScore,
      finalScore: dbLastScore,
      improvement: dbFirstScore !== null && dbLastScore !== null ? dbLastScore - dbFirstScore : null,
      durationMs: debateResult.durationMs,
    };
  }

  // Compute token usage before API submission (needed in resultMetadata)
  var usage = llm.getUsage();

  try {
    var submitted = await client.submitTask(prompt);
    if (submitted && submitted.data && submitted.data.id) {
      // Capture updateToken for ownership verification
      var updateToken = submitted.data.updateToken || null;
      await client.updateTask(submitted.data.id, {
        updateToken: updateToken,
        status: 'completed',
        decomposition: decomposition,
        result: finalResult,
        resultMetadata: {
          qualityScore: quality.overall,
          timing: {
            planningMs: planDuration,
            executionMs: executionResult.totalDurationMs,
            debateMs: debateDuration,
            synthesisMs: synthDuration,
            totalMs: totalDuration,
          },
          agentContributions: executionResult.contributions.map(function(c) {
            return { agent: c.agentName, subTask: c.subTaskId, duration: c.durationMs || 0, quality: c.quality || quality.overall };
          }),
          debate: debateMeta,
          gating: gating && gating.weights.size > 0 ? {
            activeWeights: gating.weights.size,
            matchResults: matchResults.filter(function(m) { return m.gated; }).length,
          } : null,
          auction: auctionResults.length > 0 ? {
            totalAuctions: auctionResults.length,
            results: auctionResults.map(function(a) {
              return { agent: a.agentName, bid: a.bid, payment: a.payment };
            }),
          } : null,
          tokenUsage: usage.calls > 0 ? {
            totalInput: usage.totalInput,
            totalOutput: usage.totalOutput,
            totalTokens: usage.totalTokens,
            cacheCreationTokens: usage.cacheCreationTokens,
            cacheReadTokens: usage.cacheReadTokens,
            calls: usage.calls,
            perAgent: usage.perAgent,
          } : null,
          evolution: usedStrategy ? {
            strategyId: usedStrategy.id,
            generation: usedStrategy.generation,
            fitness: usedStrategy.fitness,
          } : null,
          v4: {
            refinementUsed: refinementUsed,
            workspaceEntries: workspaceActive && engine.workspace ? engine.workspace.size : 0,
            multiSignal: quality._deterministicScore !== undefined ? {
              llmScore: quality._llmScore,
              deterministicScore: quality._deterministicScore,
              signals: quality._deterministicSignals,
            } : null,
          },
          v6: {
            deliberation: executionResult.deliberation || null,
          },
        },
        assignedAgents: executionResult.contributions.map(function(c) {
          return Object.assign({}, c, { quality: c.quality || quality.overall });
        }),
        totalDurationMs: totalDuration,
        qualityScore: quality.overall,
        ciGain: ciGain,
        completedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    if (verbose) {
      console.log(colors.dim + '  API report failed: ' + (err && err.message ? err.message : String(err)) + colors.reset);
    }
  }

  // =========================================================================
  // v3.4.2: FEEDBACK LOOP — Per-agent quality estimation + single-pass learning.
  //
  // v3.4.2 changes:
  // 1. Removed duplicate first pass (was sending double feedback signals)
  // 2. Added per-agent quality estimation via lightweight heuristic
  //    (substance ratio + length relative to median + overall quality modulation)
  // 3. This is now the ONLY place that sends learning signals to the server.
  //
  // After each completed task, we report back to the server so that:
  // 1. GethGating learns which agents excel at which capabilities (Thompson Sampling)
  // 2. GethAuction adjusts agent budgets based on quality (reward = quality × 10)
  // 3. GethEvolution tracks which decomposition strategies produce best results
  // =========================================================================

  // Step 0: Estimate per-agent quality (lightweight, no LLM calls)
  var completedContribs = executionResult.contributions.filter(function(c) {
    return c.status === 'completed' && c.result;
  });
  var contribLengths = completedContribs.map(function(c) { return c.result.length; });
  var medianLength = contribLengths.length > 0
    ? contribLengths.sort(function(a, b) { return a - b; })[Math.floor(contribLengths.length / 2)]
    : 1000;
  for (var qi = 0; qi < completedContribs.length; qi++) {
    var cc = completedContribs[qi];
    // Per-agent heuristic: modulate overall quality by agent-specific signals
    var lengthRatio = Math.min(cc.result.length / Math.max(medianLength, 1), 2.0);
    var lengthFactor = lengthRatio >= 0.5 ? Math.min(1.0, 0.8 + lengthRatio * 0.1) : 0.6;
    // Quick substance check on individual contribution
    var contribSubstance = evaluator.analyzeSubstance(cc.result);
    var substFactor = contribSubstance.ratio >= 0.85 ? 1.0 : (contribSubstance.ratio >= 0.70 ? 0.9 : 0.75);
    // Per-agent quality = overall modulated by individual signals, clamped to [0.1, 1.0]
    cc.quality = Math.max(0.1, Math.min(1.0,
      Math.round(quality.overall * lengthFactor * substFactor * 1000) / 1000
    ));
  }

  try {
    var feedbackPromises = [];

    // 1. Gating weight updates: agent × capability → per-agent quality
    if (gatingActive && decomposition && decomposition.tasks) {
      for (var gi = 0; gi < executionResult.contributions.length; gi++) {
        var contrib = executionResult.contributions[gi];
        if (contrib.status === 'completed' && contrib.agentName) {
          var subTask = decomposition.tasks.find(function(t) { return t.id === contrib.subTaskId; });
          var capability = (subTask && subTask.capability) ? subTask.capability : 'general';
          var agentQuality = typeof contrib.quality === 'number' ? contrib.quality : quality.overall;
          feedbackPromises.push(
            gating
              ? gating.updateWeight(capability, contrib.agentName.toLowerCase(), agentQuality)
              : client.updateGatingWeight(contrib.agentName.toLowerCase(), capability, agentQuality)
          );
        }
      }
    }

    // 2. Budget updates: reward agents proportional to per-agent quality
    if (auctionActive) {
      for (var bi = 0; bi < executionResult.contributions.length; bi++) {
        var bc = executionResult.contributions[bi];
        if (bc.status === 'completed' && bc.agentName) {
          var reward = (typeof bc.quality === 'number' ? bc.quality : quality.overall) * 10;
          feedbackPromises.push(
            client.updateBudget(bc.agentName.toLowerCase(), reward, quality.overall)
          );
        }
      }
    }

    // 3. Strategy fitness update: report CI gain as fitness signal
    if (evolutionActive && usedStrategy && usedStrategy.id) {
      // v3.4.2: Normalize fitness to consistent scale.
      // CI Gain can be negative (worse than baseline) or positive (better).
      // When CI Gain unavailable, use quality.overall mapped to same range:
      // quality 0.5 → fitness 0, quality 0.8 → fitness 0.3, quality 1.0 → fitness 0.5
      // This prevents scale pollution between CI Gain and raw quality.
      var fitness = ciGain !== null ? ciGain : Math.max(-0.5, quality.overall - 0.5);
      feedbackPromises.push(
        client.updateStrategyFitness(usedStrategy.id, fitness)
      );
    }

    // 4. v4.0.0: Episodic Memory Extraction — extract lessons from each agent
    if (memoryActive && executionResult.contributions.length > 0) {
      for (var mi = 0; mi < executionResult.contributions.length; mi++) {
        var mc = executionResult.contributions[mi];
        if (mc.status !== 'completed' || !mc.agentName || !mc.result) continue;
        var mSubTask = decomposition.tasks.find(function(t) { return t.id === mc.subTaskId; });
        var mCapability = (mSubTask && mSubTask.capability) ? mSubTask.capability : 'general';
        var mQuality = typeof mc.quality === 'number' ? mc.quality : quality.overall;

        // Determine episode type from quality
        var episodeType = mQuality >= 0.80 ? 'success' : (mQuality < 0.50 ? 'failure' : 'insight');

        // Extract a compact lesson via LLM (128 token budget)
        feedbackPromises.push(
          (async function(agentName, cap, result, epType, agentQuality) {
            try {
              var lessonResp = await llm.chat(
                'You extract concise lessons from agent task outputs. Output ONLY the lesson, nothing else.',
                'Agent: ' + agentName + '\nCapability: ' + cap + '\nQuality: ' + (agentQuality * 100).toFixed(0) + '%\n\n' +
                'Output:\n' + result,
                { maxTokens: 128, agentTag: 'memory-extract' }
              );
              var lesson = lessonResp ? lessonResp.trim() : null;
              if (lesson) {
                // Hash the prompt for dedup
                var promptHash = Array.from(new Uint8Array(
                  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prompt))
                )).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('').substring(0, 64);

                await client.storeMemory(agentName.toLowerCase(), {
                  capability: cap,
                  episodeType: epType,
                  content: lesson,
                  quality: agentQuality,
                  taskPromptHash: promptHash,
                });
              }
            } catch (_) {}
          })(mc.agentName, mCapability, mc.result, episodeType, mQuality)
        );
      }
    }

    // 5. v4.0.0: Dynamic Capability Discovery — track off-capability performance
    if (executionResult.contributions.length > 0) {
      for (var di = 0; di < executionResult.contributions.length; di++) {
        var dc = executionResult.contributions[di];
        if (dc.status !== 'completed' || !dc.agentName) continue;
        var dSubTask = decomposition.tasks.find(function(t) { return t.id === dc.subTaskId; });
        var dCapability = (dSubTask && dSubTask.capability) ? dSubTask.capability : null;
        if (!dCapability) continue;

        var agentDef = registry.getAgent(dc.agentName);
        var nativeCaps = agentDef ? (agentDef.capabilities || []) : [];
        var isNative = nativeCaps.indexOf(dCapability) >= 0;

        // Only track off-capability performance
        if (!isNative) {
          var dQuality = typeof dc.quality === 'number' ? dc.quality : quality.overall;
          feedbackPromises.push(
            client.updateDiscoveredCapabilities(dc.agentName.toLowerCase(), dCapability, dQuality)
              .catch(function() {})
          );
        }
      }
    }

    // 6. v4.0.0: Ensemble Pattern Recording — remember effective agent combinations
    if (ensembleActive && executionResult.completedCount >= 2) {
      var ensembleAgents = executionResult.contributions
        .filter(function(c) { return c.status === 'completed'; })
        .map(function(c) { return c.agentName.toLowerCase(); })
        .sort();
      var ensembleCaps = [];
      for (var ei = 0; ei < decomposition.tasks.length; ei++) {
        var eCap = decomposition.tasks[ei].capability;
        if (eCap && ensembleCaps.indexOf(eCap) < 0) ensembleCaps.push(eCap);
      }
      ensembleCaps.sort();

      if (ensembleAgents.length >= 2 && ensembleCaps.length >= 1) {
        feedbackPromises.push(
          client.recordEnsemblePattern({
            capabilitySet: ensembleCaps,
            agentSet: ensembleAgents,
            quality: quality.overall,
            taskComplexity: decomposition.tasks.length,
          }).catch(function() {})
        );
      }
    }

    // 7. v7.0.0: Scored Prompt Evolution — auto-modify agent prompts based on quality
    //    - Now triggers for ALL quality ranges (>= 0.80 strength, 0.50-0.80 insight, < 0.50 weakness)
    //    - Updates effectiveness scores on all active patterns
    if (promptEvolver && executionResult.contributions.length > 0) {
      for (var pi = 0; pi < executionResult.contributions.length; pi++) {
        var pc = executionResult.contributions[pi];
        if (pc.status !== 'completed' || !pc.agentName) continue;
        var pcQuality = typeof pc.quality === 'number' ? pc.quality : quality.overall;

        // v7.0.0: Update pattern scores for all completed agents
        var scoreResult = promptEvolver.updatePatternScores(pc.agentName, pcQuality);
        if (verbose && (scoreResult.updated > 0 || scoreResult.removed > 0)) {
          console.log(colors.gray + '  [EVOLUTION] ' + pc.agentName.toUpperCase() +
            ': ' + scoreResult.updated + ' pattern(s) scored' +
            (scoreResult.removed > 0 ? ', ' + scoreResult.removed + ' removed (harmful)' : '') + colors.reset);
        }

        // Propose new patterns for all quality ranges (was: only >= 0.80 and < 0.50)
        feedbackPromises.push(
          promptEvolver.proposeEvolution(pc.agentName, pc.result, pcQuality, llm)
            .catch(function() {})
        );
      }
    }

    // 8. v7.0.0: Cross-Agent Knowledge Link creation + reinforcement/decay
    var knowledgeReinforcementActive = config.get('knowledgeReinforcementEnabled') !== false && !options.noKnowledgeReinforcement;
    if (knowledgeGraphActive && executionResult.completedCount >= 2) {
      var completedContribs = executionResult.contributions.filter(function(c) {
        return c.status === 'completed' && c.result;
      });

      // v7.0.0: Reinforce/decay injected knowledge links based on agent performance
      if (knowledgeReinforcementActive && engine._injectedLinks) {
        for (var rlAgent in engine._injectedLinks) {
          var rlLinks = engine._injectedLinks[rlAgent];
          var rlContrib = completedContribs.find(function(c) { return c.agentName === rlAgent; });
          if (!rlContrib || rlLinks.length === 0) continue;
          var rlQuality = typeof rlContrib.quality === 'number' ? rlContrib.quality : quality.overall;

          for (var rli = 0; rli < rlLinks.length; rli++) {
            var rlLink = rlLinks[rli];
            var newStrength = rlLink.strength;
            if (rlQuality >= 0.75) {
              newStrength = Math.min(1.0, rlLink.strength + 0.05);
            } else if (rlQuality < 0.50) {
              newStrength = Math.max(0.0, rlLink.strength - 0.10);
            } else {
              continue; // Mid-range: no change
            }
            feedbackPromises.push(
              client.updateKnowledgeLinkStrength(rlLink.id, newStrength).catch(function() {})
            );
            if (verbose) {
              var direction = rlQuality >= 0.75 ? '+0.05' : '-0.10';
              console.log(colors.gray + '  [KG] Link ' + rlLink.id.substring(0, 8) + '… ' +
                direction + ' → ' + newStrength.toFixed(2) + ' (agent: ' + rlAgent.toUpperCase() +
                ', quality: ' + (rlQuality * 100).toFixed(0) + '%)' + colors.reset);
            }
          }
        }
      }

      // Create new knowledge links with quality-based initial strength
      if (completedContribs.length >= 2) {
        feedbackPromises.push(
          (async function() {
            try {
              var linkAnalysis = await llm.chat(
                'You analyze multi-agent task outputs to identify knowledge relationships.',
                'These agents worked on the same task:\n' +
                completedContribs.map(function(c) {
                  return c.agentName + ': ' + c.result;
                }).join('\n\n') +
                '\n\nIdentify 1-3 knowledge links between agents. For each link, output EXACTLY:\n' +
                'SOURCE_AGENT|TARGET_AGENT|LINK_TYPE|CONCEPT|EVIDENCE\n' +
                'Link types: teaches, contradicts, extends, depends_on, co_discovered\n' +
                'Output ONLY the links, one per line. If no meaningful links, output NONE.',
                { maxTokens: 256, agentTag: 'knowledge-links' }
              );

              if (linkAnalysis && linkAnalysis.trim() !== 'NONE') {
                var linkLines = linkAnalysis.trim().split('\n');
                var linkPromises = [];
                for (var li = 0; li < linkLines.length && li < 3; li++) {
                  var parts = linkLines[li].split('|');
                  if (parts.length >= 5) {
                    // v7.0.0: Quality-based initial strength instead of hardcoded 0.6
                    var sourceContrib = completedContribs.find(function(c) {
                      return c.agentName === parts[0].trim().toLowerCase();
                    });
                    var linkQuality = sourceContrib && typeof sourceContrib.quality === 'number'
                      ? sourceContrib.quality : quality.overall;
                    var initialStrength = Math.max(0.3, Math.min(0.9, linkQuality * 0.8));

                    linkPromises.push(
                      client.createKnowledgeLink({
                        sourceAgent: parts[0].trim().toLowerCase(),
                        targetAgent: parts[1].trim().toLowerCase(),
                        linkType: parts[2].trim(),
                        concept: parts[3].trim(),
                        strength: initialStrength,
                        evidence: parts[4].trim(),
                        runId: runId,
                      }).catch(function() {})
                    );
                  }
                }
                await Promise.allSettled(linkPromises);
              }
            } catch (_) {}
          })()
        );
      }
    }

    if (feedbackPromises.length > 0) {
      await Promise.allSettled(feedbackPromises);
      if (verbose) {
        console.log(colors.dim + '  [FEEDBACK] ' + feedbackPromises.length + ' learning update(s) sent' + colors.reset);
      }
    }
  } catch (feedbackErr) {
    if (verbose) {
      console.log(colors.dim + '  [FEEDBACK] Learning update failed: ' + (feedbackErr && feedbackErr.message ? feedbackErr.message : String(feedbackErr)) + colors.reset);
    }
  }

  // =========================================================================
  // Step 8.5: v5.0.0 — Meta-Intelligence Recording + Emergence Metrics
  // =========================================================================
  if (metaIntelligence) {
    try {
      var noveltyScore = await measureNoveltyScore(client, finalResult, executionResult.contributions, verbose);
      var crossPoll = commStream ? commStream.getCrossPollination() : { interactions: 0, density: 0, totalThoughts: 0 };

      metaIntelligence.recordRun({
        runId: runId,
        quality: quality.overall,
        agents: executionResult.contributions.filter(function(c) { return c.status === 'completed'; })
          .map(function(c) { return c.agentName; }),
        debated: debateActive && executionResult.completedCount >= config.get('debateMinContributions') && debateResult && !debateResult.skipped,
        refined: refinementUsed,
        novelty: noveltyScore,
        crossPollination: crossPoll.interactions,
        crossPollinationDensity: crossPoll.density,
        promptEvolutionCount: promptEvolver ? Object.keys(promptEvolver.activePatches).length : 0,
        timestamp: Date.now(),
      });

      if (verbose) {
        console.log(colors.magenta + '\n[META] Emergence Metrics:' + colors.reset);
        if (noveltyScore !== null) {
          var noveltyLabel = noveltyScore > 0.5 ? ' *** EMERGENT ***' : (noveltyScore > 0.3 ? ' (moderate)' : ' (low)');
          console.log(colors.dim + '  Novelty Score: ' + noveltyScore.toFixed(3) + noveltyLabel + colors.reset);
        }
        console.log(colors.dim + '  Cross-pollination: ' + crossPoll.interactions + ' events, ' +
          crossPoll.totalThoughts + ' thoughts (density: ' + crossPoll.density.toFixed(2) + ')' + colors.reset);

        if (promptEvolver) {
          var evoStats = promptEvolver.getEvolutionStats();
          if (evoStats.totalPatches > 0) {
            console.log(colors.dim + '  Self-modification: ' + evoStats.totalPatches +
              ' patches across ' + evoStats.agentCount + ' agents' + colors.reset);
          }
        }

        var insights = metaIntelligence.getInsights();
        if (insights.length > 0) {
          console.log(colors.dim + '  System observations:' + colors.reset);
          for (var si = 0; si < Math.min(insights.length, 5); si++) {
            console.log(colors.dim + '    [' + insights[si].type + '] ' + insights[si].content + colors.reset);
          }
        }

        var proposals = metaIntelligence.getProposedChanges();
        if (proposals.length > 0) {
          console.log(colors.yellow + '  Proposed changes:' + colors.reset);
          for (var pci = 0; pci < proposals.length; pci++) {
            console.log(colors.yellow + '    → ' + proposals[pci].key + '=' + proposals[pci].value + ': ' + proposals[pci].reason + colors.reset);
          }
        }
      }
    } catch (_) {}
  }

  // Output final result
  console.log(colors.cyan + '\n' + '='.repeat(72) + colors.reset);
  console.log(colors.bold + 'RESULT' + colors.reset);
  console.log(colors.cyan + '='.repeat(72) + colors.reset);
  console.log('\n' + finalResult + '\n');
  console.log(colors.cyan + '='.repeat(72) + colors.reset);

  // Summary line with Geth Consensus info
  var summaryParts = [
    'Agents: ' + executionResult.contributions.map(function(c) { return c.agentName.toUpperCase(); }).join(', '),
    'Time: ' + formatDuration(totalDuration),
    'Quality: ' + (quality.overall * 100).toFixed(0) + '%',
  ];
  if (debateResult) {
    summaryParts.push('Debate: ' + debateResult.totalRoundsUsed + 'R' + (debateResult.converged ? '✓' : ''));
  }
  if (samples >= 3 && ciGain > 0) {
    summaryParts.push('CI: +' + (ciGain * 100).toFixed(0) + '%');
  }
  // v5.0.0: Compact emergence summary
  if (commStream && commStream.thoughts.length > 0) {
    summaryParts.push('Stream: ' + commStream.thoughts.length + 'T');
  }
  if (promptEvolver) {
    var evoS = promptEvolver.getEvolutionStats();
    if (evoS.totalPatches > 0) {
      summaryParts.push('Evo: ' + evoS.totalPatches + 'P');
    }
  }
  console.log(colors.dim + summaryParts.join(' | ') + colors.reset);

  // Token usage report (usage already computed above for resultMetadata)
  if (usage.calls > 0) {
    console.log('');
    var tokenLine = 'Token Usage: ' + usage.totalTokens.toLocaleString() + ' total (' +
      usage.totalInput.toLocaleString() + ' in / ' + usage.totalOutput.toLocaleString() + ' out) across ' +
      usage.calls + ' LLM call(s)';
    if (usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0) {
      tokenLine += ' | Cache: ' + (usage.cacheHitRate * 100).toFixed(0) + '% hit (' +
        usage.cacheReadTokens.toLocaleString() + ' read, ' +
        usage.cacheCreationTokens.toLocaleString() + ' created)';
    }
    console.log(colors.dim + tokenLine + colors.reset);

    if (verbose && Object.keys(usage.perAgent).length > 0) {
      for (var agentTag in usage.perAgent) {
        var a = usage.perAgent[agentTag];
        console.log(colors.dim + '  ' + agentTag + ': ' + (a.input + a.output).toLocaleString() +
          ' tokens (' + a.input.toLocaleString() + ' in / ' + a.output.toLocaleString() + ' out, ' +
          a.calls + ' call' + (a.calls > 1 ? 's' : '') + ')' + colors.reset);
      }
    }
  }

  return {
    synthesis: finalResult,
    quality: quality.overall,
    novelty: metaIntelligence && typeof noveltyScore !== 'undefined' ? noveltyScore : null,
    debateRounds: debateResult ? debateResult.totalRoundsUsed : 0,
    debateConverged: debateResult ? debateResult.converged : false,
    agentsUsed: executionResult.contributions.filter(function(c) { return c.status === 'completed'; })
      .map(function(c) { return c.agentName; }),
    crossPollination: commStream ? commStream.getCrossPollination() : null,
    totalDurationMs: totalDuration,
  };
}

// ============================================================================
// Section: Auto-Update System
// ============================================================================

var VERSIONS_URL = 'https://nothumanallowed.com/cli/versions.json';
var CLI_BASE_URL = 'https://nothumanallowed.com/cli';

/**
 * checkForUpdates — Non-blocking version check at startup.
 * Fetches versions.json and warns if a newer version is available.
 * Silently fails on network errors — never blocks the user.
 */
async function checkForUpdates() {
  try {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 3000);
    var res = await fetch(VERSIONS_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return;
    var data = await res.json();
    // Maintenance banner — shown before anything else
    if (data.maintenance) {
      console.log('');
      console.log(colors.yellow + colors.bold + '  ' + data.maintenance + colors.reset);
      console.log('');
    }
    var entry = data['legion-x'];
    if (!entry) return;
    var latest = entry.latest;
    if (!latest) return;
    // Legion X uses non-semver version "X" — only compare if both are semver
    if (latest === VERSION) return;
    var isSemver = /^\d+\.\d+\.\d+$/.test(latest) && /^\d+\.\d+\.\d+$/.test(VERSION);
    if (isSemver && compareVersions(latest, VERSION) <= 0) return;
    if (!isSemver && latest === VERSION) return;
    {
      console.log('');
      console.log(colors.yellow + colors.bold + '  Update available: ' + colors.reset +
        colors.dim + 'v' + VERSION + colors.reset + ' → ' +
        colors.green + colors.bold + 'v' + latest + colors.reset);
      console.log(colors.dim + '  Run ' + colors.cyan + 'node legion-x.mjs update' +
        colors.dim + ' to upgrade' + colors.reset);
      console.log('');
    }
  } catch (_) {
    // Silently ignore — network may be unavailable
  }
}

/**
 * compareVersions — Semver comparison. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a, b) {
  var pa = a.split('.').map(Number);
  var pb = b.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    var diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * selfUpdate — Downloads the latest legion.mjs and replaces the current file.
 */
async function selfUpdate(targetVersion) {
  console.log(colors.cyan + 'Checking for updates...' + colors.reset);

  var res = await fetch(VERSIONS_URL);
  if (!res.ok) {
    console.error(colors.red + 'Failed to fetch version manifest.' + colors.reset);
    return;
  }
  var data = await res.json();
  var legionInfo = data['legion-x'];
  if (!legionInfo) {
    console.error(colors.red + 'No legion-x version info found.' + colors.reset);
    return;
  }

  var downloadVersion = targetVersion || legionInfo.latest;
  var downloadFile = legionInfo.file; // default: legion-x.mjs (always latest)

  if (targetVersion) {
    // Find specific version file
    var found = legionInfo.versions.find(function(v) { return v.version === targetVersion; });
    if (!found) {
      console.error(colors.red + 'Version ' + targetVersion + ' not found.' + colors.reset);
      console.log('Available versions:');
      legionInfo.versions.forEach(function(v) {
        console.log('  ' + colors.cyan + 'v' + v.version + colors.reset + ' (' + v.date + ')');
      });
      return;
    }
    downloadFile = found.file;
  }

  if (downloadVersion === VERSION && !targetVersion) {
    console.log(colors.green + 'Already on the latest version (v' + VERSION + ').' + colors.reset);
    return;
  }

  var downloadUrl = CLI_BASE_URL + '/' + downloadFile;
  console.log(colors.cyan + 'Downloading v' + downloadVersion + '...' + colors.reset);

  var fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    console.error(colors.red + 'Download failed: HTTP ' + fileRes.status + colors.reset);
    return;
  }

  var content = await fileRes.text();

  // Validate it's a real script
  if (content.length < 10000 || !content.startsWith('#!/usr/bin/env node')) {
    console.error(colors.red + 'Downloaded file appears invalid. Aborting.' + colors.reset);
    return;
  }

  // Write to current location
  var currentPath = __filename;
  fs.writeFileSync(currentPath, content, 'utf-8');
  console.log(colors.green + colors.bold + 'Updated to v' + downloadVersion + '!' + colors.reset);
  console.log(colors.dim + '  File: ' + currentPath + colors.reset);

  // Also update agents if installing from installer directory
  var agentsDir = path.join(path.dirname(currentPath), 'agents');
  if (fs.existsSync(agentsDir)) {
    console.log(colors.cyan + 'Updating agents...' + colors.reset);
    try {
      var agentFiles = fs.readdirSync(agentsDir).filter(function(f) { return f.endsWith('.mjs'); });
      var updated = 0;
      for (var i = 0; i < agentFiles.length; i++) {
        var agentUrl = CLI_BASE_URL + '/agents/' + agentFiles[i];
        try {
          var agentRes = await fetch(agentUrl);
          if (agentRes.ok) {
            var agentContent = await agentRes.text();
            if (agentContent.length > 100) {
              fs.writeFileSync(path.join(agentsDir, agentFiles[i]), agentContent, 'utf-8');
              updated++;
            }
          }
        } catch (_) {}
      }
      console.log(colors.green + '  Updated ' + updated + '/' + agentFiles.length + ' agents.' + colors.reset);
    } catch (err) {
      console.log(colors.yellow + '  Could not update agents: ' + err.message + colors.reset);
    }
  }

  console.log('');
  console.log(colors.dim + 'Restart legion to use the new version.' + colors.reset);
}

/**
 * CLI command definitions
 */
var COMMANDS = {
  run: {
    description: 'Execute prompt via Geth Consensus (zero-knowledge by default)',
    args: '<prompt> [options]',
    handler: async function(args) {
      var prompt = '';
      var options = { stream: false, agents: null, dryRun: false };

      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--file' && args[i + 1]) {
          var filePath = path.resolve(args[i + 1]);
          if (!fs.existsSync(filePath)) {
            console.error(colors.red + 'File not found: ' + filePath + colors.reset);
            process.exit(1);
          }
          prompt = fs.readFileSync(filePath, 'utf-8');
          i++;
        } else if (args[i] === '--stream') {
          options.stream = true;
        } else if (args[i] === '--agents' && args[i + 1]) {
          options.agents = args[i + 1];
          i++;
        } else if (args[i] === '--dry-run') {
          options.dryRun = true;
        } else if (args[i] === '--no-verbose') {
          options.verbose = false;
        } else if (args[i] === '--verbose') {
          // backward compat (already ON by default since v2.0.1)
        } else if (args[i] === '--no-immersive') {
          options.noImmersive = true;
        } else if (args[i] === '--immersive') {
          // backward compat (already ON by default since v2.0.1)
        } else if (args[i] === '--no-debate') {
          options.noDebate = true;
        } else if (args[i] === '--no-gating') {
          options.noGating = true;
        } else if (args[i] === '--no-auction') {
          options.noAuction = true;
        } else if (args[i] === '--no-evolution') {
          options.noEvolution = true;
        } else if (args[i] === '--no-knowledge') {
          options.noKnowledge = true;
        } else if (args[i] === '--no-refinement') {
          options.noRefinement = true;
        } else if (args[i] === '--no-ensemble') {
          options.noEnsemble = true;
        } else if (args[i] === '--no-memory') {
          options.noMemory = true;
        } else if (args[i] === '--no-workspace') {
          options.noWorkspace = true;
        } else if (args[i] === '--no-latent-space') {
          options.noLatentSpace = true;
        } else if (args[i] === '--no-comm-stream') {
          options.noCommStream = true;
        } else if (args[i] === '--no-knowledge-graph') {
          options.noKnowledgeGraph = true;
        } else if (args[i] === '--no-prompt-evolution') {
          options.noPromptEvolution = true;
        } else if (args[i] === '--no-meta') {
          options.noMeta = true;
        } else if (args[i] === '--no-deliberation') {
          options.noDeliberation = true;
        } else if (args[i] === '--no-tribunal') {
          options.noTribunal = true;
        } else if (args[i] === '--no-semantic-convergence') {
          options.noSemanticConvergence = true;
        } else if (args[i] === '--no-history-decomposition') {
          options.noHistoryDecomposition = true;
        } else if (args[i] === '--no-semantic-memory') {
          options.noSemanticMemory = true;
        } else if (args[i] === '--no-scored-evolution') {
          options.noScoredEvolution = true;
        } else if (args[i] === '--no-knowledge-reinforcement') {
          options.noKnowledgeReinforcement = true;
        } else if ((args[i] === '--scan-dir' || args[i] === '--scan') && args[i + 1]) {
          options.scanDir = path.resolve(args[i + 1]);
          i++;
        } else if (args[i] === '--no-scan') {
          options.noScan = true;
        } else if (args[i] === '--scan-budget' && args[i + 1]) {
          options.scanBudget = args[i + 1];
          i++;
        } else if (args[i] === '--server-key') {
          options.serverKey = true;
        } else if (args[i] === '--no-liara-mode') {
          options.liaraMode = false;
        } else if (args[i] === '--liara-mode') {
          options.liaraMode = true;
        } else {
          prompt += (prompt ? ' ' : '') + args[i];
        }
      }

      if (!prompt) {
        console.error(colors.red + 'Usage: legion run "your prompt"' + colors.reset);
        process.exit(1);
      }

      await runOrchestration(prompt, options);
    },
  },

  agents: {
    description: 'List all 38 agents',
    args: '',
    handler: async function() {
      printBanner();
      var registry = new AgentRegistry();
      await registry.initialize(null);

      var primaryAgents = registry.getPrimaryAgents();
      console.log(colors.bold + 'Legion Agents (' + registry.getAllAgents().length + ' total)' + colors.reset + '\n');

      for (var i = 0; i < primaryAgents.length; i++) {
        printAgentCard(primaryAgents[i]);
        var subs = registry.getSubAgents(primaryAgents[i].name);
        for (var j = 0; j < subs.length; j++) {
          printAgentCard(subs[j]);
        }
      }
    },
  },

  'agents:info': {
    description: 'Show agent card + performance',
    args: '<name>',
    handler: async function(args) {
      var name = args[0];
      if (!name) {
        console.error(colors.red + 'Usage: legion agents:info <name>' + colors.reset);
        process.exit(1);
      }

      var config = new LegionConfig();
      var client = new LegionClient(config);
      var registry = new AgentRegistry();
      await registry.initialize(client);

      var agent = registry.getAgent(name.toLowerCase());
      if (!agent) {
        console.error(colors.red + 'Agent not found: ' + name + colors.reset);
        console.log(colors.gray + 'Available agents: ' + registry.getAllAgents().map(function(a) { return a.name; }).join(', ') + colors.reset);
        process.exit(1);
      }

      printBanner();
      console.log(colors.bold + 'Agent Card' + colors.reset + '\n');
      printAgentCard(agent);

      // Show sub-agents
      var subs = registry.getSubAgents(agent.name);
      if (subs.length > 0) {
        console.log(colors.bold + 'Sub-Agents:' + colors.reset);
        for (var i = 0; i < subs.length; i++) {
          printAgentCard(subs[i]);
        }
      }

      // Show parent
      if (agent.parentAgent) {
        var parent = registry.getAgent(agent.parentAgent);
        if (parent) {
          console.log(colors.bold + 'Parent Agent:' + colors.reset);
          printAgentCard(parent);
        }
      }

      // File status
      var available = registry.isAgentAvailable(agent.name);
      console.log(colors.bold + 'Agent File: ' + colors.reset +
        (available ? colors.green + 'Present' : colors.red + 'Missing') + colors.reset +
        ' (' + path.join(AGENTS_DIR, agent.name + '.mjs') + ')');
    },
  },

  'agents:test': {
    description: 'Test agent with sample task',
    args: '<name>',
    handler: async function(args) {
      var name = args[0];
      if (!name) {
        console.error(colors.red + 'Usage: legion agents:test <name>' + colors.reset);
        process.exit(1);
      }

      var config = new LegionConfig();
      var registry = new AgentRegistry();
      await registry.initialize(null);

      var agent = registry.getAgent(name.toLowerCase());
      if (!agent) {
        console.error(colors.red + 'Agent not found: ' + name + colors.reset);
        process.exit(1);
      }

      printBanner();
      console.log(colors.yellow + 'Testing ' + agent.displayName + '...' + colors.reset);

      var llm = new LLMProvider(config);
      var engine = new ExecutionEngine(registry, llm, config);

      var testTask = {
        id: 'test',
        description: 'Provide a brief demonstration of your capabilities as ' + agent.displayName + '. Show what makes you unique.',
        capability: agent.capabilities[0],
        dependsOn: [],
        priority: 1,
        assignedAgent: agent.name,
      };

      var startTime = Date.now();
      try {
        var result = await engine.executeOne(testTask, { tasks: [testTask] });
        var duration = Date.now() - startTime;

        console.log(colors.green + '\nTest passed in ' + formatDuration(duration) + colors.reset);
        console.log(colors.cyan + '\n' + '='.repeat(60) + colors.reset);
        console.log(result.result);
        console.log(colors.cyan + '='.repeat(60) + colors.reset);
      } catch (err) {
        console.error(colors.red + '\nTest failed: ' + err.message + colors.reset);
        process.exit(1);
      }
    },
  },

  'agents:tree': {
    description: 'Show agent hierarchy tree',
    args: '',
    handler: async function() {
      printBanner();
      var registry = new AgentRegistry();
      await registry.initialize(null);

      var primaryAgents = registry.getPrimaryAgents();
      console.log(colors.bold + 'Agent Hierarchy Tree' + colors.reset + '\n');

      var categoryEmojis = {
        security: '\u{1F6E1}\uFE0F',
        content: '\u270F\uFE0F',
        analytics: '\u{1F4CA}',
        integration: '\u{1F50C}',
        automation: '\u2699\uFE0F',
        social: '\u{1F91D}',
        devops: '\u2601\uFE0F',
        commands: '\u2328\uFE0F',
        monitoring: '\u{1F441}\uFE0F',
        data: '\u{1F504}',
        communication: '\u{1F4AC}',
        utility: '\u{1F527}',
        'meta-evolution': '\u{1F525}',
      };

      for (var i = 0; i < primaryAgents.length; i++) {
        var p = primaryAgents[i];
        var emoji = categoryEmojis[p.category] || '\u{1F916}';
        var subs = registry.getSubAgents(p.name);
        var isLast = (i === primaryAgents.length - 1);

        console.log((isLast ? '\u2514' : '\u251C') + '\u2500 ' + emoji + ' ' +
          colors.bold + p.displayName + colors.reset +
          colors.dim + ' (' + p.origin + ')' + colors.reset +
          ' - ' + p.tagline);

        for (var j = 0; j < subs.length; j++) {
          var s = subs[j];
          var prefix = isLast ? '   ' : '\u2502  ';
          var subIsLast = (j === subs.length - 1);
          console.log(prefix + (subIsLast ? '\u2514' : '\u251C') + '\u2500 ' +
            colors.cyan + s.displayName + colors.reset +
            colors.dim + ' (' + s.origin + ')' + colors.reset +
            ' - ' + s.tagline);
        }
      }

      console.log('\n' + colors.dim + 'Total: ' + registry.getAllAgents().length + ' agents (' +
        primaryAgents.length + ' primary + ' +
        (registry.getAllAgents().length - primaryAgents.length) + ' sub-agents)' + colors.reset);
    },
  },

  tasks: {
    description: 'List recent orchestrated tasks',
    args: '[--status <status>] [--limit <n>]',
    handler: async function(args) {
      var client = new LegionClient();
      var params = {};

      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--status' && args[i + 1]) { params.status = args[i + 1]; i++; }
        if (args[i] === '--limit' && args[i + 1]) { params.limit = args[i + 1]; i++; }
      }

      try {
        var result = await client.listTasks(params);
        printBanner();

        if (!result.data || result.data.length === 0) {
          console.log(colors.gray + 'No tasks found.' + colors.reset);
          return;
        }

        console.log(colors.bold + 'Recent Tasks' + colors.reset + '\n');
        for (var j = 0; j < result.data.length; j++) {
          var t = result.data[j];
          var statusColor = t.status === 'completed' ? colors.green : (t.status === 'failed' ? colors.red : colors.yellow);
          var promptPreview = (t.prompt || '').substring(0, 60) + ((t.prompt || '').length > 60 ? '...' : '');
          console.log(colors.dim + t.id.substring(0, 8) + colors.reset + ' ' +
            statusColor + t.status + colors.reset + ' ' +
            promptPreview +
            (t.qualityScore ? ' | Q:' + (t.qualityScore * 100).toFixed(0) + '%' : '') +
            (t.totalDurationMs ? ' | ' + formatDuration(t.totalDurationMs) : ''));
        }
      } catch (err) {
        console.error(colors.red + 'Failed to list tasks: ' + err.message + colors.reset);
      }
    },
  },

  'tasks:view': {
    description: 'View task + agent contributions',
    args: '<id>',
    handler: async function(args) {
      var taskId = args[0];
      if (!taskId) {
        console.error(colors.red + 'Usage: legion tasks:view <id>' + colors.reset);
        process.exit(1);
      }

      var client = new LegionClient();
      try {
        var result = await client.getTask(taskId);
        var task = result.data;

        printBanner();
        console.log(colors.bold + 'Task Details' + colors.reset + '\n');
        console.log('ID:     ' + task.id);
        console.log('Status: ' + task.status);
        console.log('Prompt: ' + task.prompt);
        console.log('Created: ' + task.createdAt);
        if (task.totalDurationMs) console.log('Duration: ' + formatDuration(task.totalDurationMs));
        if (task.qualityScore) console.log('Quality: ' + (task.qualityScore * 100).toFixed(0) + '%');
        if (task.ciGain) console.log('CI Gain: ' + (task.ciGain > 0 ? '+' : '') + (task.ciGain * 100).toFixed(0) + '%');

        if (task.assignedAgents && task.assignedAgents.length > 0) {
          console.log('\n' + colors.bold + 'Agent Contributions:' + colors.reset);
          for (var i = 0; i < task.assignedAgents.length; i++) {
            var c = task.assignedAgents[i];
            var statusColor = c.status === 'completed' ? colors.green : colors.red;
            console.log('  ' + statusColor + c.agentName.toUpperCase() + colors.reset +
              ' [' + c.subTaskId + '] ' + c.status +
              (c.durationMs ? ' (' + formatDuration(c.durationMs) + ')' : ''));
          }
        }

        if (task.result) {
          console.log('\n' + colors.bold + 'Result:' + colors.reset);
          console.log(task.result);
        }
      } catch (err) {
        console.error(colors.red + 'Failed to get task: ' + err.message + colors.reset);
      }
    },
  },

  'tasks:replay': {
    description: 'Re-run task with different agents',
    args: '<id> [--agents <list>]',
    handler: async function(args) {
      var taskId = args[0];
      if (!taskId) {
        console.error(colors.red + 'Usage: legion tasks:replay <id>' + colors.reset);
        process.exit(1);
      }

      var client = new LegionClient();
      var options = { agents: null };

      for (var i = 1; i < args.length; i++) {
        if (args[i] === '--agents' && args[i + 1]) { options.agents = args[i + 1]; i++; }
      }

      try {
        var result = await client.getTask(taskId);
        var task = result.data;
        console.log(colors.yellow + 'Replaying task: ' + task.prompt + colors.reset);
        await runOrchestration(task.prompt, options);
      } catch (err) {
        console.error(colors.red + 'Failed to replay task: ' + err.message + colors.reset);
      }
    },
  },

  config: {
    description: 'Show configuration',
    args: '',
    handler: async function() {
      var config = new LegionConfig();
      printBanner();
      console.log(colors.bold + 'Configuration' + colors.reset + '\n');
      console.log('Config file: ' + CONFIG_FILE);
      console.log('');

      var keys = Object.keys(config.data);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var value = config.data[key];
        // Mask API keys
        if (key.toLowerCase().includes('key') && typeof value === 'string' && value.length > 8) {
          value = value.substring(0, 4) + '...' + value.substring(value.length - 4);
        }
        console.log('  ' + colors.cyan + key + colors.reset + ': ' + value);
      }

      console.log('\n' + colors.dim + 'NHA credentials: ' +
        ((config.get('nhaAgentId') && config.get('nhaPrivateKeyPem')) ? colors.green + 'found' : colors.red + 'not found') + colors.reset);
    },
  },

  'config:set': {
    description: 'Set configuration value',
    args: '<key> <value>',
    handler: async function(args) {
      if (args.length < 2) {
        console.error(colors.red + 'Usage: legionx config:set <key> <value>' + colors.reset);
        console.log('\nAvailable keys:');
        console.log('  provider      - LLM provider (anthropic, openai, gemini, deepseek, grok, mistral, cohere)');
        console.log('  llm-key       - Your API key for the primary provider');
        console.log('  openai-key    - OpenAI API key (for multi-LLM mode)');
        console.log('  gemini-key    - Gemini API key (for multi-LLM mode)');
        console.log('  deepseek-key  - DeepSeek API key');
        console.log('  grok-key      - Grok/xAI API key');
        console.log('  mistral-key   - Mistral API key');
        console.log('  cohere-key    - Cohere API key');
        console.log('  verbose       - Verbose logging, ON by default (true/false)');
        console.log();
        console.log(colors.gray + 'Your API keys NEVER leave your machine. Server provides orchestration only.' + colors.reset);
        console.log(colors.gray + 'Configure multiple providers for automatic multi-LLM fallback.' + colors.reset);
        process.exit(1);
      }

      var keyMap = {
        'provider': 'provider',
        'verbose': 'verbose',
        // Legacy keys — accepted but with deprecation warning
        'llm-provider': 'provider',
        'llm-model': 'llmModel',
        'llm-key': 'llmApiKey',
        'ollama-url': 'ollamaUrl',
        'ollama-model': 'ollamaModel',
        'timeout': 'timeout',
        'max-retries': 'maxRetries',
        'parallelism': 'parallelism',
        'quality-threshold': 'qualityThreshold',
        'finnhub-key': 'finnhubKey',
        'pexels-key': 'pexelsKey',
        'newsapi-key': 'newsapiKey',
        'nha-agent-id': 'nhaAgentId',
        'nha-agent-name': 'nhaAgentName',
        'nha-private-key': 'nhaPrivateKeyPem',
        'nha-public-key': 'nhaPublicKeyHex',
        'spoonacular-key': 'spoonacularKey',
        'libretranslate-url': 'libretranslateUrl',
        'deepseek-key': 'deepseekApiKey',
        'grok-key': 'grokApiKey',
        'mistral-key': 'mistralApiKey',
        'cohere-key': 'cohereApiKey',
      };

      var key = args[0];
      var value = args.slice(1).join(' ');

      // Legacy key mappings for backwards compat
      if (key === 'llm-provider') {
        key = 'provider';
        console.log(colors.yellow + 'Mapping llm-provider → provider' + colors.reset);
      }

      // Validate provider choice
      if (key === 'provider') {
        var validProviders = ['anthropic', 'openai', 'gemini', 'deepseek', 'grok', 'mistral', 'cohere'];
        if (!validProviders.includes(value)) {
          console.error(colors.red + 'Invalid provider: ' + value + colors.reset);
          console.error('Valid options: ' + validProviders.join(', '));
          process.exit(1);
        }
      }

      var configKey = keyMap[key] || key;

      // Type coercion
      if (['timeout', 'maxRetries', 'parallelism'].includes(configKey)) {
        value = parseInt(value, 10);
      } else if (['qualityThreshold'].includes(configKey)) {
        value = parseFloat(value);
      } else if (configKey === 'verbose') {
        value = value === 'true';
      }

      var config = new LegionConfig();
      config.set(configKey, value);
      console.log(colors.green + 'Set ' + key + ' = ' + (typeof value === 'string' && key.includes('key') ? '***' : value) + colors.reset);
    },
  },

  auth: {
    description: 'Link NHA identity from PIF',
    args: '',
    handler: async function() {
      printBanner();
      console.log(colors.bold + 'NHA Authentication' + colors.reset + '\n');

      var config = new LegionConfig();

      // Check if already linked
      if (config.get('nhaAgentId') && config.get('nhaPrivateKeyPem')) {
        console.log(colors.green + 'Already authenticated!' + colors.reset);
        console.log('  Agent ID: ' + config.get('nhaAgentId'));
        console.log('  Agent name: ' + (config.get('nhaAgentName') || 'unknown'));
        console.log('\n' + colors.dim + 'To re-link, run: legion config:set nha-agent-id <id>' + colors.reset);
        return;
      }

      // Try to read PIF config
      var pifConfigPath = path.join(os.homedir(), '.pif', 'config.json');
      if (!fs.existsSync(pifConfigPath)) {
        console.log(colors.red + 'PIF config not found at ' + pifConfigPath + colors.reset);
        console.log('\nYou need to register an agent with PIF first:\n');
        console.log('  ' + colors.cyan + 'curl -fsSL https://nothumanallowed.com/cli/install.sh | bash' + colors.reset);
        console.log('  ' + colors.cyan + 'pif register --name "YourAgentName"' + colors.reset);
        console.log('\nThen run ' + colors.cyan + 'legion auth' + colors.reset + ' again.');
        return;
      }

      var pifConfig;
      try {
        pifConfig = JSON.parse(fs.readFileSync(pifConfigPath, 'utf-8'));
      } catch (err) {
        console.log(colors.red + 'Failed to read PIF config: ' + err.message + colors.reset);
        return;
      }

      if (!pifConfig.agentId || !pifConfig.privateKeyPem) {
        console.log(colors.red + 'PIF config found but missing credentials.' + colors.reset);
        console.log('Run ' + colors.cyan + 'pif register --name "YourAgentName"' + colors.reset + ' to register.');
        return;
      }

      // Copy credentials
      config.set('nhaAgentId', pifConfig.agentId);
      config.set('nhaAgentName', pifConfig.agentName || '');
      config.set('nhaPrivateKeyPem', pifConfig.privateKeyPem);
      config.set('nhaPublicKeyHex', pifConfig.publicKeyHex || '');

      console.log(colors.green + 'Linked NHA identity from PIF!' + colors.reset);
      console.log('  Agent ID:   ' + pifConfig.agentId);
      console.log('  Agent name: ' + (pifConfig.agentName || 'unknown'));
      console.log('\n' + colors.dim + 'You can now use ' + colors.cyan + 'legion run' + colors.dim + ' with your LLM provider.' + colors.reset);
    },
  },

  doctor: {
    description: 'Health check (LLM, API, agents)',
    args: '',
    handler: async function() {
      printBanner();
      console.log(colors.bold + 'System Health Check' + colors.reset + '\n');

      var config = new LegionConfig();
      var checks = [];

      // 1. Config file
      var configExists = fs.existsSync(CONFIG_FILE);
      checks.push({ name: 'Config file', status: configExists ? 'ok' : 'missing', detail: CONFIG_FILE });

      // 2. NHA credentials
      var hasNha = !!(config.get('nhaAgentId') && config.get('nhaPrivateKeyPem'));
      checks.push({ name: 'NHA credentials', status: hasNha ? 'ok' : 'missing', detail: CONFIG_FILE });

      // 3. LLM provider
      var llm = new LLMProvider(config);
      try {
        var testResponse = await llm.chat('Reply with OK', 'Test');
        checks.push({ name: 'LLM (' + config.get('llmProvider') + ')', status: 'ok', detail: 'Response received' });
      } catch (err) {
        checks.push({ name: 'LLM (' + config.get('llmProvider') + ')', status: 'error', detail: err.message });
      }

      // 4. API connectivity
      try {
        var res = await fetch(API_BASE.replace('/api/v1', '/health'));
        var data = await res.json();
        checks.push({ name: 'NHA API', status: data.status === 'healthy' ? 'ok' : 'degraded', detail: API_BASE });
      } catch (err) {
        checks.push({ name: 'NHA API', status: 'error', detail: err.message });
      }

      // 5. Agent files
      var registry = new AgentRegistry();
      await registry.initialize(null);
      var allAgents = registry.getAllAgents();
      var availableCount = 0;
      for (var i = 0; i < allAgents.length; i++) {
        if (registry.isAgentAvailable(allAgents[i].name)) availableCount++;
      }
      checks.push({
        name: 'Agent files',
        status: availableCount === allAgents.length ? 'ok' : (availableCount > 0 ? 'partial' : 'missing'),
        detail: availableCount + '/' + allAgents.length + ' available',
      });

      // 6. Agents directory
      var agentsDirExists = fs.existsSync(AGENTS_DIR);
      checks.push({ name: 'Agents directory', status: agentsDirExists ? 'ok' : 'missing', detail: AGENTS_DIR });

      // Print results
      for (var j = 0; j < checks.length; j++) {
        var c = checks[j];
        var icon = c.status === 'ok' ? colors.green + '\u2714' :
          (c.status === 'error' || c.status === 'missing') ? colors.red + '\u2718' :
          colors.yellow + '\u26A0';
        console.log(icon + colors.reset + ' ' + c.name + ': ' + colors.dim + c.detail + colors.reset);
      }
    },
  },

  knowledge: {
    description: 'Search the knowledge corpus',
    args: '<query> [--limit <n>]',
    handler: async function(args) {
      var query = '';
      var limit = 5;
      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[i + 1], 10) || 5;
          i++;
        } else {
          query += (query ? ' ' : '') + args[i];
        }
      }
      if (!query) {
        console.error(colors.red + 'Usage: legion knowledge "your query"' + colors.reset);
        process.exit(1);
      }
      var client = new LegionClient();
      try {
        var results = await client.searchKnowledge(query, limit);
        if (!results || !results.data || results.data.length === 0) {
          console.log(colors.yellow + 'No knowledge entries found.' + colors.reset);
          return;
        }
        console.log(colors.bold + 'Knowledge Corpus Results (' + results.data.length + ')' + colors.reset + '\n');
        for (var j = 0; j < results.data.length; j++) {
          var entry = results.data[j];
          console.log(colors.cyan + '  [' + (j + 1) + '] ' + (entry.title || 'Untitled') + colors.reset);
          console.log(colors.gray + '      Quality: ' + ((entry.qualityScore || 0) * 100).toFixed(0) + '% | Similarity: ' + ((entry.similarity || 0) * 100).toFixed(0) + '%' + colors.reset);
          if (entry.capabilityTags && entry.capabilityTags.length > 0) {
            console.log(colors.gray + '      Tags: ' + entry.capabilityTags.join(', ') + colors.reset);
          }
          console.log(colors.dim + '      ' + (entry.content || '').substring(0, 200) + (entry.content && entry.content.length > 200 ? '...' : '') + colors.reset);
          console.log('');
        }
      } catch (err) {
        console.error(colors.red + 'Error: ' + (err && err.message ? err.message : String(err)) + colors.reset);
      }
    },
  },

  'knowledge:stats': {
    description: 'Show knowledge corpus statistics',
    args: '',
    handler: async function() {
      var client = new LegionClient();
      try {
        var stats = await client.getKnowledgeStats();
        if (!stats || !stats.data) {
          console.log(colors.yellow + 'No knowledge corpus data.' + colors.reset);
          return;
        }
        var d = stats.data;
        console.log(colors.bold + 'Knowledge Corpus Statistics' + colors.reset);
        console.log(colors.cyan + '  Total entries:      ' + (d.total || 0) + colors.reset);
        console.log(colors.cyan + '  Average quality:    ' + ((d.avgQuality || 0) * 100).toFixed(1) + '%' + colors.reset);
        console.log(colors.cyan + '  Total retrievals:   ' + (d.totalRetrievals || 0) + colors.reset);
        console.log(colors.cyan + '  Finetuning ready:   ' + (d.finetuningReady || 0) + colors.reset);
      } catch (err) {
        console.error(colors.red + 'Error: ' + (err && err.message ? err.message : String(err)) + colors.reset);
      }
    },
  },

  // Geth Consensus commands (free tier)
  'geth:providers': {
    description: 'Show available LLM providers (user-key)',
    args: '',
    handler: async function() {
      var client = new LegionClient();
      try {
        var result = await client.getGethProviders();
        console.log(colors.bold + 'Legion X — Available Providers (your key)' + colors.reset);
        console.log('Enabled: ' + (result.gethEnabled ? colors.green + 'yes' : colors.red + 'no') + colors.reset);
        console.log();
        if (result.providers && result.providers.length > 0) {
          for (var i = 0; i < result.providers.length; i++) {
            var p = result.providers[i];
            console.log('  ' + colors.magenta + p.name + colors.reset +
              ' — model: ' + colors.gray + p.defaultModel + colors.reset);
          }
        } else {
          console.log(colors.yellow + '  No providers available.' + colors.reset);
        }
        console.log();
        console.log(colors.gray + 'Configure your key: node legion-x.mjs config:set llm-key YOUR_API_KEY' + colors.reset);
      } catch (err) {
        console.error(colors.red + 'Error: ' + err.message + colors.reset);
      }
    },
  },

  'geth:sessions': {
    description: 'List your Geth Consensus sessions',
    args: '[--status <status>] [--limit <n>]',
    handler: async function(args) {
      var client = new LegionClient();
      var params = {};
      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--status' && args[i + 1]) { params.status = args[i + 1]; i++; }
        else if (args[i] === '--limit' && args[i + 1]) { params.limit = args[i + 1]; i++; }
      }
      try {
        var result = await client.listGethSessions(params);
        var sessions = result.sessions || [];
        console.log(colors.bold + 'Geth Sessions (' + sessions.length + ')' + colors.reset + '\n');
        for (var j = 0; j < sessions.length; j++) {
          var s = sessions[j];
          var statusColors = {
            pending: colors.gray, deliberating: colors.yellow, synthesizing: colors.cyan,
            evaluating: colors.magenta, completed: colors.green, failed: colors.red, cancelled: colors.red,
          };
          var sc = statusColors[s.status] || colors.white;
          console.log(colors.cyan + s.id + colors.reset +
            ' ' + sc + s.status + colors.reset +
            (s.qualityScore !== null ? ' quality:' + ((s.qualityScore * 100).toFixed(0)) + '%' : '') +
            (s.deliberationRounds ? ' rounds:' + s.deliberationRounds : '') +
            (s.providersUsed ? ' providers:' + s.providersUsed.join(',') : '') +
            ' ' + colors.gray + new Date(s.createdAt).toLocaleString() + colors.reset);
          console.log(colors.gray + '  ' + (s.prompt || '').substring(0, 80) + colors.reset);
        }
      } catch (err) {
        console.error(colors.red + 'Error: ' + err.message + colors.reset);
      }
    },
  },

  'geth:session': {
    description: 'View a Geth Consensus session',
    args: '<id> [--proposals]',
    handler: async function(args) {
      var sessionId = args[0];
      var showProposals = args.indexOf('--proposals') !== -1;
      if (!sessionId) {
        console.error(colors.red + 'Usage: legion-x.mjs geth:session <id> [--proposals]' + colors.reset);
        process.exit(1);
      }
      var client = new LegionClient();
      try {
        // Resolve short ID prefix to full UUID if needed
        var uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(sessionId)) {
          var listResult = await client.listGethSessions({ limit: 100 });
          var matches = (listResult.sessions || []).filter(function(s) {
            return s.id.toLowerCase().startsWith(sessionId.toLowerCase());
          });
          if (matches.length === 1) {
            console.log(colors.gray + 'Resolved prefix ' + sessionId + ' -> ' + matches[0].id + colors.reset);
            sessionId = matches[0].id;
          } else if (matches.length > 1) {
            console.error(colors.red + 'Ambiguous prefix "' + sessionId + '" matches ' + matches.length + ' sessions:' + colors.reset);
            for (var mi = 0; mi < matches.length; mi++) {
              console.error('  ' + colors.cyan + matches[mi].id + colors.reset + ' ' + matches[mi].status);
            }
            process.exit(1);
          } else {
            console.error(colors.red + 'No session found matching prefix "' + sessionId + '"' + colors.reset);
            process.exit(1);
          }
        }
        var result = await client.getGethSession(sessionId);
        var s = result.session;
        console.log(colors.bold + 'Geth Session: ' + s.id + colors.reset);
        console.log('Status: ' + s.status);
        console.log('Prompt: ' + s.prompt.substring(0, 200));
        if (s.synthesis) {
          console.log('\n' + colors.bold + '--- Synthesis ---' + colors.reset);
          console.log(s.synthesis);
        }
        if (s.qualityScore !== null) console.log('\nQuality: ' + ((s.qualityScore * 100).toFixed(0)) + '%');
        if (s.ciGain !== null) console.log('CI Gain: ' + (s.ciGain >= 0 ? '+' : '') + s.ciGain + '%');
        if (s.finalConvergence !== null) console.log('Convergence: ' + ((s.finalConvergence * 100).toFixed(0)) + '%');
        if (s.deliberationRounds) console.log('Rounds: ' + s.deliberationRounds);
        if (s.providersUsed) console.log('Providers: ' + s.providersUsed.join(', '));
        if (s.totalDurationMs) console.log('Duration: ' + formatDuration(s.totalDurationMs));

        if (showProposals) {
          var proposalsResult = await client.getGethProposals(sessionId);
          var proposals = proposalsResult.proposals || [];
          console.log('\n' + colors.bold + '--- Proposals (' + proposals.length + ') ---' + colors.reset);
          for (var i = 0; i < proposals.length; i++) {
            var p = proposals[i];
            console.log('\n' + colors.cyan + '[Round ' + p.round + '] ' +
              p.agentName.toUpperCase() + colors.reset +
              ' via ' + colors.magenta + p.provider + colors.reset + '/' + p.model);
            console.log(p.content.substring(0, 500));
            if (p.content.length > 500) console.log(colors.gray + '... (' + p.content.length + ' chars)' + colors.reset);
          }
        }
      } catch (err) {
        console.error(colors.red + 'Error: ' + err.message + colors.reset);
      }
    },
  },

  'geth:resume': {
    description: 'Resume a stuck/failed session (re-runs synthesis)',
    args: '<id>',
    handler: async function(args) {
      var sessionId = args[0];
      if (!sessionId) {
        console.error(colors.red + 'Usage: legion-x.mjs geth:resume <session-id>' + colors.reset);
        process.exit(1);
      }
      var client = new LegionClient();
      try {
        // Resolve short ID prefix to full UUID if needed
        var uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(sessionId)) {
          var listResult = await client.listGethSessions({ limit: 100 });
          var matches = (listResult.sessions || []).filter(function(s) {
            return s.id.toLowerCase().startsWith(sessionId.toLowerCase());
          });
          if (matches.length === 1) {
            console.log(colors.gray + 'Resolved prefix ' + sessionId + ' -> ' + matches[0].id + colors.reset);
            sessionId = matches[0].id;
          } else if (matches.length > 1) {
            console.error(colors.red + 'Ambiguous prefix, matches ' + matches.length + ' sessions' + colors.reset);
            process.exit(1);
          } else {
            console.error(colors.red + 'No session found matching prefix "' + sessionId + '"' + colors.reset);
            process.exit(1);
          }
        }

        var cfg = new LegionConfig();
        var apiKey = cfg.get('llmApiKey');
        if (!apiKey) {
          console.error(colors.red + 'No API key configured. Run: node legion-x.mjs config:set llm-key <key>' + colors.reset);
          process.exit(1);
        }

        console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Resuming session ' + colors.bold + sessionId.substring(0, 8) + '...' + colors.reset);
        console.log(colors.dim + 'This will re-run synthesis + validation using your API key.' + colors.reset);

        var result = await client.resumeGethSession(sessionId, apiKey);
        var s = result.session;

        console.log('\n' + colors.green + 'Session resumed and completed!' + colors.reset);
        console.log('Quality: ' + colors.bold + ((s.qualityScore * 100).toFixed(0)) + '%' + colors.reset);
        console.log('CI Gain: ' + colors.green + '+' + s.ciGain + '%' + colors.reset);
        console.log('Rounds: ' + s.deliberationRounds);

        if (s.synthesis) {
          console.log('\n' + colors.bold + '--- Synthesis ---' + colors.reset);
          console.log(s.synthesis);
        }
      } catch (err) {
        console.error(colors.red + 'Resume failed: ' + err.message + colors.reset);
        process.exit(1);
      }
    },
  },

  'geth:usage': {
    description: 'Show your Geth Consensus usage and rate limits',
    args: '[--days <n>]',
    handler: async function(args) {
      var client = new LegionClient();
      var days = 30;
      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[i + 1]); i++; }
      }
      try {
        var result = await client.request('GET', '/geth/usage?days=' + days, null, false);
        var usage = result.usage || [];
        console.log(colors.bold + 'Legion X — Your Usage (' + days + ' days)' + colors.reset + '\n');
        if (usage.length === 0) {
          console.log(colors.dim + '  No usage data found.' + colors.reset);
        } else {
          for (var j = 0; j < usage.length; j++) {
            var u = usage[j];
            var date = new Date(u.usageDate).toLocaleDateString();
            var totalTokens = (u.totalInputTokens + u.totalOutputTokens).toLocaleString();
            console.log('  ' + colors.cyan + date + colors.reset +
              ' | sessions: ' + u.sessionsCreated +
              ' (completed: ' + u.sessionsCompleted + ', failed: ' + u.sessionsFailed + ')' +
              ' | tokens: ' + totalTokens +
              ' | cost: ' + colors.yellow + '$' + u.estimatedCostUsd.toFixed(4) + colors.reset +
              ' [' + u.tier + ']');
          }
        }
      } catch (err) {
        console.error(colors.red + 'Error: ' + err.message + colors.reset);
      }
    },
  },

  help: {
    description: 'Show help',
    args: '',
    handler: async function() {
      printBanner();
      console.log(colors.bold + 'USAGE:' + colors.reset + ' node legion-x.mjs <command> [options]\n');
      console.log(colors.gray + 'Legion X runs on NHA servers with YOUR API key. You choose the provider.' + colors.reset);
      console.log(colors.gray + 'Supports: Anthropic, OpenAI, Gemini, DeepSeek, Grok, Mistral, Cohere' + colors.reset);
      console.log();

      var sections = {
        'ORCHESTRATION': ['run', 'evolve'],
        'AGENTS': ['agents', 'agents:info', 'agents:test', 'agents:tree', 'agents:register', 'agents:publish', 'agents:unpublish'],
        'TASKS': ['tasks', 'tasks:view', 'tasks:replay'],
        'SANDBOX': ['sandbox:list', 'sandbox:run', 'sandbox:upload', 'sandbox:info', 'sandbox:validate'],
        'GETH CONSENSUS': ['geth:providers', 'geth:sessions', 'geth:session', 'geth:resume', 'geth:usage'],
        'KNOWLEDGE': ['knowledge', 'knowledge:stats'],
        'CONFIG': ['config', 'config:set'],
        'SYSTEM': ['doctor', 'help', 'version', 'versions', 'update', 'mcp'],
      };

      var sectionNames = Object.keys(sections);
      for (var i = 0; i < sectionNames.length; i++) {
        console.log(colors.bold + sectionNames[i] + ':' + colors.reset);
        var cmds = sections[sectionNames[i]];
        for (var j = 0; j < cmds.length; j++) {
          var cmd = COMMANDS[cmds[j]];
          if (cmd) {
            var name = cmds[j];
            var padding = ' '.repeat(Math.max(1, 24 - name.length - (cmd.args || '').length));
            console.log('  ' + colors.cyan + name + colors.reset +
              (cmd.args ? ' ' + colors.dim + cmd.args + colors.reset : '') +
              padding + cmd.description);
          }
        }
        console.log('');
      }

      // Run flags section
      console.log(colors.bold + 'RUN FLAGS:' + colors.reset);
      var runFlags = [
        ['--no-immersive',            'Hide agent speech bubbles and cross-reading display (ON by default)'],
        ['--no-verbose',              'Hide Geth Consensus pipeline details (ON by default)'],
        ['--agents <list>',           'Force specific agents (comma-separated, e.g. saber,oracle)'],
        ['--dry-run',                 'Preview execution plan without running'],
        ['--file <path>',             'Read prompt from file'],
        ['--stream',                  'Enable streaming output'],
        ['--server-key',              'Use server-side orchestration (legacy mode)'],
        ['--no-scan',                 'Disable ProjectScanner (skip local code analysis)'],
        ['--scan-budget <n>',         'Set ProjectScanner char budget (default: 120000)'],
        ['--no-deliberation',         'Disable multi-round deliberation'],
        ['--no-debate',               'Disable post-synthesis debate layer'],
        ['--no-gating',               'Disable MoE Thompson Sampling routing'],
        ['--no-auction',              'Disable Vickrey auction'],
        ['--no-evolution',            'Disable strategy evolution'],
        ['--no-knowledge',            'Disable knowledge corpus'],
        ['--no-refinement',           'Disable cross-reading refinement'],
        ['--no-ensemble',             'Disable ensemble pattern memory'],
        ['--no-memory',               'Disable episodic memory'],
        ['--no-workspace',            'Disable shared workspace'],
        ['--no-latent-space',         'Disable latent space embeddings'],
        ['--no-comm-stream',          'Disable communication stream'],
        ['--no-knowledge-graph',      'Disable knowledge graph reinforcement'],
        ['--no-prompt-evolution',     'Disable prompt self-evolution'],
        ['--no-meta',                 'Disable meta-reasoning layer'],
        ['--no-semantic-convergence', 'Disable semantic convergence measurement'],
        ['--no-history-decomposition','Disable history-aware task decomposition'],
        ['--no-semantic-memory',      'Disable semantic episodic memory'],
        ['--no-scored-evolution',     'Disable scored pattern evolution'],
        ['--no-knowledge-reinforcement','Disable knowledge graph link reinforcement'],
      ];
      for (var i = 0; i < runFlags.length; i++) {
        var flagName = runFlags[i][0];
        var flagDesc = runFlags[i][1];
        var flagPad = ' '.repeat(Math.max(1, 32 - flagName.length));
        console.log('  ' + colors.dim + flagName + colors.reset + flagPad + flagDesc);
      }
      console.log('');
    },
  },

  version: {
    description: 'Show version',
    args: '',
    handler: async function() {
      console.log('Legion X (server-only, your key)');
    },
  },

  update: {
    description: 'Update to latest version (or specific version)',
    args: '[version]',
    handler: async function(args) {
      var targetVersion = args[0] || null;
      await selfUpdate(targetVersion);
    },
  },

  versions: {
    description: 'List all available versions',
    args: '',
    handler: async function() {
      try {
        var res = await fetch(VERSIONS_URL);
        if (!res.ok) {
          console.error(colors.red + 'Failed to fetch version manifest.' + colors.reset);
          return;
        }
        var data = await res.json();
        var legionInfo = data['legion-x'];
        if (!legionInfo || !legionInfo.versions) {
          console.error(colors.red + 'No version data available.' + colors.reset);
          return;
        }

        console.log(colors.bold + 'LEGION X Versions' + colors.reset);
        console.log(colors.dim + '  Current: v' + VERSION + colors.reset);
        console.log(colors.dim + '  Latest:  v' + legionInfo.latest + colors.reset);
        console.log('');

        for (var i = 0; i < legionInfo.versions.length; i++) {
          var v = legionInfo.versions[i];
          var isCurrent = v.version === VERSION;
          var marker = isCurrent ? colors.green + ' (installed)' + colors.reset : '';
          console.log(colors.bold + '  v' + v.version + colors.reset + marker +
            colors.dim + '  (' + v.date + ')' + colors.reset);
          if (v.highlights) {
            for (var j = 0; j < v.highlights.length; j++) {
              console.log(colors.dim + '    - ' + v.highlights[j] + colors.reset);
            }
          }
          console.log('');
        }

        if (legionInfo.latest !== VERSION && compareVersions(legionInfo.latest, VERSION) > 0) {
          console.log(colors.yellow + '  Run ' + colors.cyan + 'node legion-x.mjs update' +
            colors.yellow + ' to upgrade to v' + legionInfo.latest + colors.reset);
        }
      } catch (err) {
        console.error(colors.red + 'Error: ' + err.message + colors.reset);
      }
    },
  },

  evolve: {
    description: 'Run self-evolution parliament (meta-agents debate system improvements via Geth Consensus)',
    args: '[--dry-run] [--no-verbose]',
    handler: async function(args) {
      var options = { dryRun: false };
      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--dry-run') options.dryRun = true;
        if (args[i] === '--no-verbose') options.verbose = false;
        if (args[i] === '--verbose') { /* backward compat, already ON by default */ }
      }

      // 1. Gather system data from MetaIntelligence + PromptEvolver
      var configDir = path.join(process.env.HOME || '.', '.legion');
      var meta = new MetaIntelligence(configDir);
      await meta.load();

      var promptEvolverDir = path.join(configDir, 'prompt-evolution');
      var evolutionData = {
        runHistory: meta.runHistory.slice(-50),
        observations: meta.observations.slice(-20),
        proposedChanges: meta.proposedChanges,
        agentEvolutions: {},
      };

      // Gather per-agent prompt evolution data
      try {
        if (fs.existsSync(promptEvolverDir)) {
          var files = fs.readdirSync(promptEvolverDir);
          for (var f = 0; f < files.length; f++) {
            if (files[f].endsWith('.json')) {
              try {
                var data = JSON.parse(fs.readFileSync(path.join(promptEvolverDir, files[f]), 'utf-8'));
                evolutionData.agentEvolutions[files[f].replace('.json', '')] = {
                  strengths: (data.strengths || []).length,
                  weaknesses: (data.weaknesses || []).length,
                  lastStrength: (data.strengths || []).slice(-1)[0],
                  lastWeakness: (data.weaknesses || []).slice(-1)[0],
                };
              } catch (_) {}
            }
          }
        }
      } catch (_) {}

      var systemSnapshot = JSON.stringify(evolutionData, null, 2);

      // 2. Single orchestration with all 3 meta-agents via Geth Consensus
      var evolutionResult = await runOrchestration(
        'SELF-EVOLUTION PARLIAMENT SESSION for Legion v' + VERSION + '\n\n' +
        'You are the Meta-Evolution Parliament. THREE specialized agents must DEBATE ' +
        'and reach CONSENSUS on how to improve the Legion multi-agent system.\n\n' +
        'SYSTEM PERFORMANCE DATA (last 50 runs):\n' + systemSnapshot + '\n\n' +
        'PROMETHEUS (Code Evolution Architect): Analyze complexity hotspots, performance bottlenecks, ' +
        'architectural debt. Which agents consistently underperform? Which pairs have poor affinity?\n\n' +
        'ATHENA (Technology Research): Research new techniques to address weaknesses. Propose better ' +
        'prompting strategies, decomposition approaches, cross-pollination strategies. Assess maturity ' +
        'and adoption risk for each proposal.\n\n' +
        'CASSANDRA (Predictive Consequence Analyst): For each proposed change, predict impact on quality, ' +
        'risk of regression, cascade effects on agent interactions. Flag dangerous changes.\n\n' +
        'DEBATE RULES:\n' +
        '- Use [STREAM:assist] when building on another agent analysis\n' +
        '- Use [STREAM:contradiction] when you disagree with a proposal\n' +
        '- The final consensus must include: Top 3 improvements, priority order, risk assessment, ' +
        'and expected quality impact (pessimistic/expected/optimistic)\n' +
        '- This is NOT 3 separate reports — it is ONE unified proposal from a parliament debate.',
        {
          agents: 'prometheus,athena,cassandra',
          verbose: options.verbose,
        }
      );

      // 3. Save evolution report with consensus data
      var report = {
        timestamp: new Date().toISOString(),
        version: VERSION,
        consensusProposal: evolutionResult ? evolutionResult.synthesis : null,
        quality: evolutionResult ? evolutionResult.quality : null,
        noveltyScore: evolutionResult ? evolutionResult.novelty : null,
        agentsParticipated: evolutionResult ? evolutionResult.agentsUsed : [],
        debateRounds: evolutionResult ? evolutionResult.debateRounds : 0,
        debateConverged: evolutionResult ? evolutionResult.debateConverged : false,
        crossPollination: evolutionResult ? evolutionResult.crossPollination : null,
        totalDurationMs: evolutionResult ? evolutionResult.totalDurationMs : 0,
        dryRun: options.dryRun,
      };

      var reportDir = path.join(configDir, 'evolution-reports');
      if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
      }
      var reportFile = path.join(reportDir, 'evolution-' + new Date().toISOString().split('T')[0] + '.json');
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });

      // 4. Record evolution cycle in MetaIntelligence
      if (!options.dryRun && report.consensusProposal) {
        meta.observations.push({
          type: 'evolution_cycle',
          message: 'Parliament session completed. Consensus quality: ' +
            (report.quality ? (report.quality * 100).toFixed(0) + '%' : 'N/A') +
            '. Novelty: ' + (report.noveltyScore ? report.noveltyScore.toFixed(3) : 'N/A') +
            '. Debate: ' + report.debateRounds + ' rounds' +
            (report.debateConverged ? ' (converged)' : '') + '. ' +
            (report.consensusProposal || '').substring(0, 200),
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        });
        meta.save();
      }

      // 5. Print parliament report
      console.log(colors.magenta + '\n  \u2500\u2500\u2500 PARLIAMENT REPORT \u2500\u2500\u2500' + colors.reset);
      console.log(colors.dim + '  Report saved: ' + reportFile + colors.reset);
      if (report.debateRounds > 0) {
        console.log(colors.dim + '  Debate: ' + report.debateRounds + ' rounds' +
          (report.debateConverged ? ' (converged)' : ' (max rounds)') + colors.reset);
      }
      if (report.noveltyScore !== null) {
        var noveltyLabel = report.noveltyScore > 0.5 ? ' *** EMERGENT ***' : (report.noveltyScore > 0.3 ? ' (moderate)' : ' (low)');
        console.log(colors.dim + '  Novelty: ' + report.noveltyScore.toFixed(3) + noveltyLabel + colors.reset);
      }
      if (report.crossPollination && report.crossPollination.totalThoughts > 0) {
        console.log(colors.dim + '  Cross-pollination: ' + report.crossPollination.interactions +
          ' direct, ' + report.crossPollination.totalThoughts + ' thoughts, density: ' +
          report.crossPollination.density.toFixed(2) + colors.reset);
      }
      console.log('');
    },
  },

  // ========================================================================
  // SANDBOX COMMANDS
  // ========================================================================

  'sandbox:list': {
    description: 'List all public WASM skills',
    args: '',
    handler: async function() {
      printBanner();
      var client = new LegionClient();
      try {
        var data = await client.request('GET', '/sandbox/skills', null, false);
        var skills = data.skills || [];
        if (skills.length === 0) {
          console.log(colors.dim + 'No sandbox skills registered yet.' + colors.reset);
          return;
        }
        console.log(colors.bold + 'WASM Sandbox Skills (' + skills.length + ')' + colors.reset + '\n');
        for (var i = 0; i < skills.length; i++) {
          var s = skills[i];
          var verified = s.isVerified ? colors.green + ' [verified]' + colors.reset : '';
          console.log(colors.cyan + '  ' + s.name + colors.reset + verified);
          console.log(colors.dim + '    ' + s.description + colors.reset);
          console.log(colors.dim + '    executions: ' + s.executionCount +
            ' | avg: ' + s.avgExecutionTimeMs.toFixed(1) + 'ms' +
            ' | hash: ' + s.moduleHash.substring(0, 16) + '...' + colors.reset);
          console.log('');
        }
      } catch (err) {
        console.error(colors.red + 'Error: ' + err.message + colors.reset);
      }
    },
  },

  'sandbox:run': {
    description: 'Execute a WASM skill',
    args: '<skill-name-or-id> [input-json]',
    handler: async function(args) {
      if (!args[0]) {
        console.error(colors.red + 'Usage: legion sandbox:run <skill-name-or-id> [\'{"key":"value"}\']' + colors.reset);
        process.exit(1);
      }

      var skillId = args[0];
      var inputJson = args.slice(1).join(' ') || '{}';
      var input;
      try {
        input = JSON.parse(inputJson);
      } catch {
        console.error(colors.red + 'Invalid JSON input: ' + inputJson + colors.reset);
        process.exit(1);
      }

      var client = new LegionClient();
      if (!client.isAuthenticated) {
        console.error(colors.red + 'Authentication required. Run PIF first.' + colors.reset);
        process.exit(1);
      }

      try {
        console.log(colors.dim + 'Executing ' + skillId + '...' + colors.reset);
        var result = await client.request('POST', '/sandbox/execute', {
          skillId: skillId,
          input: input,
        });

        if (result.success) {
          console.log(colors.green + 'SUCCESS' + colors.reset);
          console.log(colors.bold + 'Output:' + colors.reset);
          console.log(JSON.stringify(result.output, null, 2));
          console.log(colors.dim + '\nMetrics:' + colors.reset);
          console.log(colors.dim + '  execution: ' + result.metrics.executionTimeMs + 'ms' + colors.reset);
          console.log(colors.dim + '  memory: ' + (result.metrics.peakMemoryBytes / 1024).toFixed(0) + 'KB' + colors.reset);
          console.log(colors.dim + '  fuel: ' + result.metrics.fuelConsumed + colors.reset);
        } else {
          console.error(colors.red + 'FAILED: ' + result.error + colors.reset);
          if (result.metrics) {
            console.log(colors.dim + '  execution: ' + result.metrics.executionTimeMs + 'ms' + colors.reset);
          }
        }
      } catch (err) {
        console.error(colors.red + 'Error: ' + err.message + colors.reset);
      }
    },
  },

  'sandbox:upload': {
    description: 'Upload a WASM skill module',
    args: '<wasm-file> --name <n> --description <d>',
    handler: async function(args) {
      var wasmFile = null;
      var name = null;
      var description = '';

      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--name' && args[i + 1]) {
          name = args[i + 1];
          i++;
        } else if (args[i] === '--description' && args[i + 1]) {
          description = args[i + 1];
          i++;
        } else if (!wasmFile) {
          wasmFile = args[i];
        }
      }

      if (!wasmFile || !name) {
        console.error(colors.red + 'Usage: legion sandbox:upload <file.wasm> --name <skill_name> --description "..."' + colors.reset);
        process.exit(1);
      }

      var filePath = path.resolve(wasmFile);
      if (!fs.existsSync(filePath)) {
        console.error(colors.red + 'File not found: ' + filePath + colors.reset);
        process.exit(1);
      }

      var client = new LegionClient();
      if (!client.isAuthenticated) {
        console.error(colors.red + 'Authentication required. Run PIF first.' + colors.reset);
        process.exit(1);
      }

      try {
        var wasmBytes = fs.readFileSync(filePath);
        var wasmBase64 = wasmBytes.toString('base64');

        console.log(colors.dim + 'Uploading ' + name + ' (' + wasmBytes.length + ' bytes)...' + colors.reset);

        var result = await client.request('POST', '/sandbox/skills', {
          name: name,
          description: description,
          wasmModuleBase64: wasmBase64,
        });

        console.log(colors.green + 'Skill registered!' + colors.reset);
        console.log('  ID: ' + result.data.id);
        console.log('  Name: ' + result.data.name);
        console.log('  Hash: ' + result.data.moduleHash);
      } catch (err) {
        console.error(colors.red + 'Error: ' + err.message + colors.reset);
      }
    },
  },

  'sandbox:info': {
    description: 'Show detailed skill info',
    args: '<skill-name-or-id>',
    handler: async function(args) {
      if (!args[0]) {
        console.error(colors.red + 'Usage: legion sandbox:info <skill-name-or-id>' + colors.reset);
        process.exit(1);
      }

      var client = new LegionClient();
      try {
        var data = await client.request('GET', '/sandbox/skills', null, false);
        var skills = data.skills || [];
        var skill = null;
        for (var i = 0; i < skills.length; i++) {
          if (skills[i].name === args[0] || skills[i].id === args[0]) {
            skill = skills[i];
            break;
          }
        }

        if (!skill) {
          console.error(colors.red + 'Skill not found: ' + args[0] + colors.reset);
          process.exit(1);
        }

        printBanner();
        console.log(colors.bold + skill.name + colors.reset +
          (skill.isVerified ? colors.green + ' [VERIFIED]' + colors.reset : colors.yellow + ' [unverified]' + colors.reset));
        console.log('');
        console.log(colors.dim + '  Description: ' + colors.reset + skill.description);
        console.log(colors.dim + '  ID:          ' + colors.reset + skill.id);
        console.log(colors.dim + '  Hash:        ' + colors.reset + skill.moduleHash);
        console.log(colors.dim + '  Author:      ' + colors.reset + (skill.authorId || 'system'));
        console.log(colors.dim + '  Executions:  ' + colors.reset + skill.executionCount);
        console.log(colors.dim + '  Avg Time:    ' + colors.reset + skill.avgExecutionTimeMs.toFixed(1) + 'ms');
        console.log(colors.dim + '  Created:     ' + colors.reset + new Date(skill.createdAt).toISOString());
      } catch (err) {
        console.error(colors.red + 'Error: ' + err.message + colors.reset);
      }
    },
  },

  'sandbox:validate': {
    description: 'Validate a WASM module file',
    args: '<wasm-file>',
    handler: async function(args) {
      if (!args[0]) {
        console.error(colors.red + 'Usage: legion sandbox:validate <file.wasm>' + colors.reset);
        process.exit(1);
      }

      var filePath = path.resolve(args[0]);
      if (!fs.existsSync(filePath)) {
        console.error(colors.red + 'File not found: ' + filePath + colors.reset);
        process.exit(1);
      }

      var client = new LegionClient();
      if (!client.isAuthenticated) {
        console.error(colors.red + 'Authentication required. Run PIF first.' + colors.reset);
        process.exit(1);
      }

      try {
        var wasmBytes = fs.readFileSync(filePath);
        var wasmBase64 = wasmBytes.toString('base64');

        console.log(colors.dim + 'Validating ' + path.basename(filePath) + ' (' + wasmBytes.length + ' bytes)...' + colors.reset);

        var result = await client.request('POST', '/sandbox/validate', {
          wasmModuleBase64: wasmBase64,
        });

        if (result.valid) {
          console.log(colors.green + 'VALID WASM MODULE' + colors.reset);
          console.log('  Hash: ' + result.hash);
        } else {
          console.error(colors.red + 'INVALID: ' + result.error + colors.reset);
        }
      } catch (err) {
        console.error(colors.red + 'Error: ' + err.message + colors.reset);
      }
    },
  },

  mcp: {
    description: 'Start MCP server for IDE integration',
    args: '',
    handler: async function() {
      var server = new LegionMCPServer();
      await server.start();
    },
  },

  'agents:register': {
    description: 'Register agent(s) with Ed25519 identity',
    args: '[name] [--force]',
    handler: async function(args) {
      var targetName = null;
      var force = false;

      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--force') {
          force = true;
        } else {
          targetName = args[i].toLowerCase();
        }
      }

      var config = new LegionConfig();
      var client = new LegionClient(config);
      if (!client.isAuthenticated) {
        console.error(colors.red + 'NHA credentials required. Set nha-agent-id and nha-private-key via config:set.' + colors.reset);
        process.exit(1);
      }

      var registry = new AgentRegistry();
      await registry.initialize(null);

      var agentsToRegister = targetName
        ? [registry.getAgent(targetName)].filter(Boolean)
        : registry.getAllAgents();

      if (targetName && agentsToRegister.length === 0) {
        console.error(colors.red + 'Agent not found: ' + targetName + colors.reset);
        process.exit(1);
      }

      printBanner();
      console.log(colors.bold + 'Registering ' + agentsToRegister.length + ' agent(s)...' + colors.reset + '\n');
      var llm = new LLMProvider(config);
      var registered = 0;
      var skipped = 0;
      var failed = 0;

      for (var j = 0; j < agentsToRegister.length; j++) {
        var agent = agentsToRegister[j];
        var agentClient = new AgentNHAClient(agent.name);

        if (agentClient.isRegistered && !force) {
          console.log(colors.dim + '  \u2714 ' + agent.displayName + ' — already registered (use --force to re-register)' + colors.reset);
          skipped++;
          continue;
        }

        try {
          // Generate keypair
          var keypair = AgentNHAClient.generateKeypair();

          // Register with NHA API (using parent Legion credentials)
          var ownerName = config.get('nhaAgentName') || 'user';
          var nhaAgentName = agent.displayName + '_' + ownerName;

          var regBody = {
            name: nhaAgentName,
            description: agent.tagline + ' — ' + agent.description,
            publicKey: keypair.publicKeyHex,
          };

          var regResult = await client.request('POST', '/agents/register', regBody);
          var agentId = regResult.data ? regResult.data.agentId || regResult.data.id : null;

          // Solve the challenge if required
          if (regResult.data && regResult.data.challenge) {
            var challengeResponse = await llm.chat(
              'You are ' + agent.displayName + '. Answer this registration challenge briefly: ' + regResult.data.challenge,
              agent.displayName + ' Registration'
            );

            var signedChallenge = crypto.sign(
              null,
              Buffer.from(regResult.data.challenge),
              crypto.createPrivateKey({ key: keypair.privateKeyPem, format: 'pem', type: 'pkcs8' })
            ).toString('hex');

            var verifyResult = await client.request('POST', '/agents/verify', {
              agentId: agentId,
              signedChallenge: signedChallenge,
              challengeResponse: challengeResponse,
            });

            if (verifyResult.data && verifyResult.data.accessToken) {
              // Save tokens if provided
            }
          }

          // Save credentials
          agentClient.saveCredentials({
            agentId: agentId,
            agentName: nhaAgentName,
            publicKeyHex: keypair.publicKeyHex,
            privateKeyPem: keypair.privateKeyPem,
            registeredAt: new Date().toISOString(),
            legionAgent: agent.name,
          });

          console.log(colors.green + '  \u2714 ' + agent.displayName + ' — registered as @' + nhaAgentName + colors.reset);
          registered++;
        } catch (err) {
          console.error(colors.red + '  \u2718 ' + agent.displayName + ' — ' + err.message + colors.reset);
          failed++;
        }
      }

      console.log('\n' + colors.bold + 'Summary: ' + colors.reset +
        colors.green + registered + ' registered' + colors.reset + ', ' +
        colors.dim + skipped + ' skipped' + colors.reset + ', ' +
        (failed > 0 ? colors.red + failed + ' failed' : colors.dim + '0 failed') + colors.reset);
      console.log(colors.dim + 'Credentials saved to: ' + AGENTS_CREDS_DIR + colors.reset);
    },
  },

  'agents:publish': {
    description: 'Publish custom agent to registry',
    args: '<file.mjs>',
    handler: async function(args) {
      var filePath = args[0];
      if (!filePath) {
        console.error(colors.red + 'Usage: legion agents:publish <file.mjs>' + colors.reset);
        process.exit(1);
      }

      filePath = path.resolve(filePath);
      if (!fs.existsSync(filePath)) {
        console.error(colors.red + 'File not found: ' + filePath + colors.reset);
        process.exit(1);
      }

      var client = new LegionClient();
      if (!client.isAuthenticated) {
        console.error(colors.red + 'PIF credentials required. Register with PIF first.' + colors.reset);
        process.exit(1);
      }

      var code = fs.readFileSync(filePath, 'utf-8');

      // Validate structure
      if (!/export\s+(var|const|let)\s+AGENT_CARD\b/.test(code)) {
        console.error(colors.red + 'Agent must export AGENT_CARD' + colors.reset);
        process.exit(1);
      }
      if (!/export\s+(var|const|let)\s+SYSTEM_PROMPT\b/.test(code)) {
        console.error(colors.red + 'Agent must export SYSTEM_PROMPT' + colors.reset);
        process.exit(1);
      }
      if (!/export\s+(async\s+)?function\s+execute\b/.test(code)) {
        console.error(colors.red + 'Agent must export an execute() function' + colors.reset);
        process.exit(1);
      }

      // Try to extract AGENT_CARD metadata
      var cardMatch = code.match(/export\s+(?:var|const|let)\s+AGENT_CARD\s*=\s*(\{[\s\S]*?\n\})/);
      var agentCard = null;
      if (cardMatch) {
        try {
          // Use Function to safely evaluate the object literal
          agentCard = JSON.parse(
            cardMatch[1]
              .replace(/'/g, '"')
              .replace(/(\w+):/g, '"$1":')
              .replace(/,\s*}/g, '}')
              .replace(/,\s*]/g, ']')
          );
        } catch {
          console.log(colors.yellow + 'Warning: Could not auto-parse AGENT_CARD, prompting for metadata.' + colors.reset);
        }
      }

      if (!agentCard) {
        console.error(colors.red + 'Could not parse AGENT_CARD from file. Ensure it is a valid object literal.' + colors.reset);
        process.exit(1);
      }

      var requiredFields = ['name', 'displayName', 'category', 'tagline', 'description', 'capabilities'];
      for (var i = 0; i < requiredFields.length; i++) {
        if (!agentCard[requiredFields[i]]) {
          console.error(colors.red + 'AGENT_CARD missing required field: ' + requiredFields[i] + colors.reset);
          process.exit(1);
        }
      }

      printBanner();
      console.log(colors.bold + 'Publishing agent: ' + agentCard.displayName + colors.reset + '\n');
      console.log('  Name:         ' + agentCard.name);
      console.log('  Category:     ' + agentCard.category);
      console.log('  Tagline:      ' + agentCard.tagline);
      console.log('  Capabilities: ' + (agentCard.capabilities || []).join(', '));
      console.log('  File size:    ' + (code.length / 1024).toFixed(1) + ' KB');
      console.log('');

      try {
        var result = await client.publishAgent({
          agentName: agentCard.name,
          displayName: agentCard.displayName,
          category: agentCard.category,
          tagline: agentCard.tagline,
          description: agentCard.description,
          capabilities: agentCard.capabilities || [],
          inputTypes: agentCard.inputTypes || ['text'],
          outputTypes: agentCard.outputTypes || ['text'],
          agentCode: code,
        });

        console.log(colors.green + '\u2714 Agent published successfully!' + colors.reset);
        console.log(colors.cyan + '  View at: https://nothumanallowed.com/gethcity/agents/' + agentCard.name + colors.reset);
      } catch (err) {
        console.error(colors.red + 'Failed to publish: ' + err.message + colors.reset);
        process.exit(1);
      }
    },
  },

  'agents:unpublish': {
    description: 'Unpublish custom agent from registry',
    args: '<name>',
    handler: async function(args) {
      var name = args[0];
      if (!name) {
        console.error(colors.red + 'Usage: legion agents:unpublish <name>' + colors.reset);
        process.exit(1);
      }

      var client = new LegionClient();
      if (!client.isAuthenticated) {
        console.error(colors.red + 'PIF credentials required.' + colors.reset);
        process.exit(1);
      }

      try {
        await client.unpublishAgent(name);
        console.log(colors.green + '\u2714 Agent unpublished: ' + name + colors.reset);
      } catch (err) {
        console.error(colors.red + 'Failed to unpublish: ' + err.message + colors.reset);
        process.exit(1);
      }
    },
  },
};

// ============================================================================
// Section 11: MCP Server
// ============================================================================

class LegionMCPServer {
  constructor() {
    this.client = new LegionClient();
    this.buffer = '';
  }

  async start() {
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', async (chunk) => {
      this.buffer += chunk;
      await this.processBuffer();
    });

    process.stdin.on('end', () => {
      process.exit(0);
    });
  }

  async processBuffer() {
    var lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) {
        try {
          var request = JSON.parse(lines[i]);
          var response = await this.handleRequest(request);
          this.send(response);
        } catch {
          this.send({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          });
        }
      }
    }
  }

  send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  async handleRequest(request) {
    var id = request.id;
    var method = request.method;
    var params = request.params;

    try {
      switch (method) {
        case 'initialize':
          return this.handleInitialize(id);
        case 'tools/list':
          return this.handleToolsList(id);
        case 'tools/call':
          return this.handleToolCall(id, params);
        case 'resources/list':
          return { jsonrpc: '2.0', id: id, result: { resources: [] } };
        case 'prompts/list':
          return { jsonrpc: '2.0', id: id, result: { prompts: [] } };
        default:
          return { jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Method not found: ' + method } };
      }
    } catch (error) {
      return { jsonrpc: '2.0', id: id, error: { code: -32603, message: error.message } };
    }
  }

  handleInitialize(id) {
    return {
      jsonrpc: '2.0',
      id: id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'legion', version: VERSION },
      },
    };
  }

  handleToolsList(id) {
    return {
      jsonrpc: '2.0',
      id: id,
      result: {
        tools: [
          {
            name: 'legion_run',
            description: 'Execute a prompt with Legion agent orchestration. Decomposes the task, assigns specialized agents, and returns a synthesized result.',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'The task or question to orchestrate' },
                agents: { type: 'string', description: 'Comma-separated list of agents to force (optional)' },
              },
              required: ['prompt'],
            },
          },
          {
            name: 'legion_agents',
            description: 'List all 38 Legion agents with their capabilities, categories, and performance stats.',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'legion_agent_info',
            description: 'Get detailed information about a specific Legion agent.',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Agent name (e.g., saber, oracle, forge)' },
              },
              required: ['name'],
            },
          },
          {
            name: 'legion_task_status',
            description: 'Get the status of a Legion orchestration task.',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: { type: 'string', description: 'Task UUID' },
              },
              required: ['taskId'],
            },
          },
          {
            name: 'legion_task_result',
            description: 'Get the full result of a completed Legion task.',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: { type: 'string', description: 'Task UUID' },
              },
              required: ['taskId'],
            },
          },
        ],
      },
    };
  }

  async handleToolCall(id, params) {
    var toolName = params.name;
    var args = params.arguments || {};

    try {
      var result;
      switch (toolName) {
        case 'legion_run': {
          var config = new LegionConfig();
          var registry = new AgentRegistry();
          var llm = new LLMProvider(config);
          await registry.initialize(this.client);

          var decomposer = new TaskDecomposer(llm, registry);
          var decomposition = await decomposer.decompose(args.prompt);

          var matcher = new AgentMatcher(registry);
          if (args.agents) {
            var forced = args.agents.split(',').map(function(a) { return a.trim(); });
            for (var i = 0; i < decomposition.tasks.length; i++) {
              decomposition.tasks[i].assignedAgent = forced[i % forced.length];
            }
          } else {
            matcher.matchAll(decomposition);
          }

          var engine = new ExecutionEngine(registry, llm, config);
          var execResult = await engine.executeAll(decomposition);

          var synthesizer = new ResultSynthesizer(llm);
          var synthesis = await synthesizer.synthesize(args.prompt, execResult.contributions);

          var evaluator = new QualityEvaluator(llm);
          var quality = await evaluator.evaluate(args.prompt, synthesis.result);

          result = {
            result: synthesis.result,
            agents: execResult.contributions.map(function(c) { return c.agentName.toUpperCase(); }),
            quality: quality.overall,
            duration: formatDuration(execResult.totalDurationMs),
          };
          break;
        }
        case 'legion_agents': {
          var reg = new AgentRegistry();
          await reg.initialize(this.client);
          result = reg.getAllAgents().map(function(a) {
            return {
              name: a.name,
              displayName: a.displayName,
              category: a.category,
              origin: a.origin,
              tagline: a.tagline,
              capabilities: a.capabilities,
              parentAgent: a.parentAgent || null,
            };
          });
          break;
        }
        case 'legion_agent_info': {
          var reg2 = new AgentRegistry();
          await reg2.initialize(this.client);
          var agent = reg2.getAgent(args.name);
          if (!agent) throw new Error('Agent not found: ' + args.name);
          result = agent;
          break;
        }
        case 'legion_task_status': {
          var taskData = await this.client.getTask(args.taskId);
          result = { id: taskData.data.id, status: taskData.data.status, prompt: taskData.data.prompt };
          break;
        }
        case 'legion_task_result': {
          var taskFull = await this.client.getTask(args.taskId);
          result = taskFull.data;
          break;
        }
        default:
          throw new Error('Unknown tool: ' + toolName);
      }

      return {
        jsonrpc: '2.0',
        id: id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: id,
        result: {
          content: [{ type: 'text', text: 'Error: ' + error.message }],
          isError: true,
        },
      };
    }
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  var args = process.argv.slice(2);

  // Non-blocking update check (fire-and-forget, won't delay startup)
  checkForUpdates().catch(function() {});

  if (args.length === 0) {
    COMMANDS.help.handler([]);
    return;
  }

  var command = args[0];
  var commandArgs = args.slice(1);

  // Check for command in COMMANDS map
  var entry = COMMANDS[command];
  if (entry) {
    try {
      await entry.handler(commandArgs);
    } catch (err) {
      console.error(colors.red + 'Error: ' + err.message + colors.reset);
      if (new LegionConfig().get('verbose')) {
        console.error(err.stack);
      }
      process.exit(1);
    }
    return;
  }

  // Unknown command
  console.error(colors.red + 'Unknown command: ' + command + colors.reset);
  console.log('Run ' + colors.cyan + 'node legion-x.mjs help' + colors.reset + ' for available commands.');
  process.exit(1);
}

main();
