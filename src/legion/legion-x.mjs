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
 * LEGION X -- Multi-agent deliberation that runs entirely on your machine
 *
 * Decomposition, agent routing, cross-reading rounds, tribunal, convergence
 * measurement, synthesis and scoring all run locally. The only hosts contacted
 * during a deliberation are your own LLM providers. No account, no server.
 *
 * Local: Ollama (one or several models), any OpenAI-compatible endpoint.
 * Cloud: Anthropic, OpenAI, Gemini, DeepSeek, Grok, Mistral, Cohere.
 * 38 agents across 11 categories.
 *
 * @version 2.3
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

var VERSION = '2.3.0';
var AGENTS_DIR = process.env.NHA_AGENTS_DIR || path.join(__dirname, 'agents');
var CONFIG_FILE = process.env.NHA_CONFIG_FILE || path.join(process.env.HOME || '.', '.legion-config.json');

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

/** Where the key of each cloud provider is stored: config name and environment variable. */
var CLOUD_PROVIDER_KEYS = {
  anthropic: { configKey: 'anthropicApiKey', envKey: 'ANTHROPIC_API_KEY' },
  openai: { configKey: 'openaiApiKey', envKey: 'OPENAI_API_KEY' },
  gemini: { configKey: 'geminiApiKey', envKey: 'GEMINI_API_KEY' },
  deepseek: { configKey: OPENAI_COMPAT_PROVIDERS.deepseek.configKey, envKey: OPENAI_COMPAT_PROVIDERS.deepseek.envKey },
  grok: { configKey: OPENAI_COMPAT_PROVIDERS.grok.configKey, envKey: OPENAI_COMPAT_PROVIDERS.grok.envKey },
  mistral: { configKey: OPENAI_COMPAT_PROVIDERS.mistral.configKey, envKey: OPENAI_COMPAT_PROVIDERS.mistral.envKey },
  cohere: { configKey: OPENAI_COMPAT_PROVIDERS.cohere.configKey, envKey: OPENAI_COMPAT_PROVIDERS.cohere.envKey },
};

class LLMProvider {
  constructor(config) {
    this.config = config;
    // 'provider' is what config:set writes; 'llmProvider' is the older name the nha toolkit still writes.
    this.provider = config.get('provider') || config.get('llmProvider') || 'ollama';
    this.model = config.get('llmModel') || '';
    this.apiKey = config.get('llmApiKey') || '';
    this.ollamaUrl = config.get('ollamaUrl') || 'http://localhost:11434';
    this.ollamaModel = config.get('ollamaModel') || 'llama3.1';
    // Token tracking: per-call and aggregate (with cache tracking)
    this.tokenUsage = { totalInput: 0, totalOutput: 0, cacheCreationTokens: 0, cacheReadTokens: 0, calls: 0, perAgent: {} };
  }

  /**
   * The API key to use for a cloud provider, or '' when there is none.
   *
   * A key stored under the provider's own name wins. The generic 'llmApiKey'
   * belongs to the configured provider only: it is never offered to another
   * one. With a local provider configured, a lone generic key is read as an
   * Anthropic key, which is what it meant before providers had their own.
   */
  keyFor(provider) {
    var spec = CLOUD_PROVIDER_KEYS[provider];
    if (!spec) return '';
    var own = this.config.get(spec.configKey);
    if (own) return own;
    var genericOwner = CLOUD_PROVIDER_KEYS[this.provider] ? this.provider : 'anthropic';
    if (this.apiKey && genericOwner === provider) return this.apiKey;
    return process.env[spec.envKey] || '';
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
        var provKey = this.keyFor(this.provider);
        if (!provKey) throw new Error(provConf.name + ' API key not configured. Set ' + provConf.envKey + ' or run: node legion-x.mjs config:set ' + this.provider + '-key <key>');
        return this.chatOpenAICompatible(provConf.baseUrl, provKey, this.modelOf(this.provider, provConf.defaultModel), provConf.name, systemPrompt, userMessage, maxTokens, agentTag);
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
    var apiKey = this.keyFor('anthropic');
    if (!apiKey) throw new Error('Anthropic API key not configured. Set ANTHROPIC_API_KEY or run: node legion-x.mjs config:set anthropic-key <key>');

    var model = this.modelOf('anthropic', 'claude-sonnet-5-5');

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
        max_tokens: this.anthropicMaxTokens(maxTokens),
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
    return this.readAnthropicText(data);
  }

  async chatOpenAI(systemPrompt, userMessage, maxTokens, agentTag) {
    var apiKey = this.keyFor('openai');
    if (!apiKey) throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY or run: node legion-x.mjs config:set openai-key <key>');

    var model = this.modelOf('openai', 'gpt-4.1');
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
        max_completion_tokens: maxTokens || 8192,
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

  async chatOllama(systemPrompt, userMessage, maxTokens, agentTag, modelOverride) {
    var model = modelOverride || this.ollamaModel || 'llama3.1';
    var res;
    try {
      res = await fetch(this.ollamaUrl + '/api/chat', {
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
    } catch (e) {
      throw new Error(
        'Local model not reachable at ' + this.ollamaUrl + ' (default runtime: Ollama).\n' +
        '  → Install & start a local model: https://ollama.com  then  ollama pull ' + model + '\n' +
        '  → Or use your own API key instead:  node legion-x.mjs config:set llm-provider anthropic  (then config:set llm-key <key>)\n' +
        '  Supported local runtimes: any OpenAI-compatible endpoint — set  config:set ollama-url http://localhost:<port>'
      );
    }

    if (!res.ok) {
      throw new Error('Ollama error (' + res.status + '). Is Ollama running? Model "' + model + '" pulled? (ollama pull ' + model + ')');
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
    var apiKey = apiKeyOverride || this.keyFor('gemini');
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
   * Whether an error is worth a second try on the same provider: rate limits
   * and overload pass, a bad key or a bad request never does.
   */
  isRetryableError(err) {
    var msg = (err && err.message) || '';
    if (/\b(401|403|404)\b|invalid_request|authentication|not_found/i.test(msg)) return false;
    return /\b(429|500|502|503|504|529)\b|overloaded|rate.?limit|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
  }

  /**
   * Chat with a specific provider, retrying a passing failure on the same
   * provider before giving up ('maxRetries', 2 by default; 'retryDelayMs'
   * grows with each attempt). A deliberation makes dozens of calls: without
   * this, one rate-limited answer cost a whole agent or a whole audit.
   */
  async chatWithProvider(provider, systemPrompt, userMessage, opts) {
    var configuredRetries = parseInt(this.config.get('maxRetries'), 10);
    var retries = isFinite(configuredRetries) ? Math.max(0, Math.min(configuredRetries, 5)) : 2;
    var configuredDelay = parseInt(this.config.get('retryDelayMs'), 10);
    var baseDelay = isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 3000;
    for (var attempt = 0; ; attempt++) {
      try {
        return await this.chatWithProviderOnce(provider, systemPrompt, userMessage, opts);
      } catch (err) {
        if (attempt >= retries || !this.isRetryableError(err)) throw err;
        var delay = baseDelay * (attempt + 1);
        await new Promise(function(resolve) { setTimeout(resolve, delay); });
      }
    }
  }

  /**
   * One call to a specific provider (for multi-LLM orchestration).
   * Falls back to the default provider if the requested one isn't configured.
   */
  async chatWithProviderOnce(provider, systemPrompt, userMessage, opts) {
    var maxTokens = (opts && opts.maxTokens) || 4096;
    var agentTag = (opts && opts.agentTag) || null;

    // Per-provider max_tokens limits (API-imposed hard caps)
    var PROVIDER_MAX_TOKENS = { deepseek: 8192, grok: 131072, mistral: 32768, cohere: 4096 };
    if (PROVIDER_MAX_TOKENS[provider] && maxTokens > PROVIDER_MAX_TOKENS[provider]) {
      maxTokens = PROVIDER_MAX_TOKENS[provider];
    }

    // Local runtimes. 'ollama:<model>' names one of several local models, so a
    // deliberation can mix them like it mixes cloud providers.
    if (provider === 'ollama') {
      return this.chatOllama(systemPrompt, userMessage, maxTokens, agentTag);
    }
    if (typeof provider === 'string' && provider.indexOf('ollama:') === 0) {
      return this.chatOllama(systemPrompt, userMessage, maxTokens, agentTag, provider.substring('ollama:'.length));
    }
    if (provider === 'local-openai') {
      var localUrl = this.config.get('localOpenaiUrl');
      if (!localUrl) throw new Error('Local OpenAI-compatible endpoint not configured. Run: node legion-x.mjs config:set local-openai-url http://localhost:1234/v1/chat/completions');
      return this.chatOpenAICompatible(localUrl, this.config.get('localOpenaiKey') || 'local',
        this.config.get('localOpenaiModel') || 'local-model', 'Local endpoint', systemPrompt, userMessage, maxTokens, agentTag);
    }

    switch (provider) {
      case 'anthropic': {
        // Direct Anthropic call with explicit key — NO mutation of this.apiKey
        var anthKey = this.keyFor('anthropic');
        if (!anthKey) return this.chat(systemPrompt, userMessage, opts);
        return this._chatAnthropicDirect(anthKey, systemPrompt, userMessage, maxTokens, agentTag);
      }
      case 'openai': {
        // Direct OpenAI call with explicit key — NO mutation of this.apiKey
        var oaiKey = this.keyFor('openai');
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
        var compatKey = this.keyFor(provider);
        if (!compatKey) return this.chat(systemPrompt, userMessage, opts);
        return this.chatOpenAICompatible(compat.baseUrl, compatKey, this.modelOf(provider, compat.defaultModel), compat.name, systemPrompt, userMessage, maxTokens, agentTag);
      }
      default:
        return this.chat(systemPrompt, userMessage, opts);
    }
  }

  /**
   * Anthropic call with explicit API key (concurrency-safe — no shared state mutation).
   */
  async _chatAnthropicDirect(apiKey, systemPrompt, userMessage, maxTokens, agentTag) {
    var model = this.modelOf('anthropic', 'claude-sonnet-5-5');
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
        // No `temperature`: current Claude models reject the parameter (400).
        max_tokens: this.anthropicMaxTokens(maxTokens),
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
    return this.readAnthropicText(data);
  }

  /**
   * max_tokens to send to Anthropic for an answer of `requested` tokens.
   * Current Claude models think before answering and the thinking is billed
   * against max_tokens: with no headroom the budget ends before the answer starts.
   */
  anthropicMaxTokens(requested) {
    var wanted = requested || 8192;
    return Math.min(Math.max(wanted * 2, wanted + 4096), 32000);
  }

  /**
   * The text of an Anthropic response. Thinking blocks come first and carry no
   * text, so the answer is the concatenation of the text blocks, never block 0.
   * An answer that ran out of tokens before its first word is an error: an
   * empty string must not travel on as if the agent had answered.
   */
  readAnthropicText(data) {
    var blocks = Array.isArray(data.content) ? data.content : [];
    var text = blocks
      .filter(function(b) { return b && b.type === 'text' && typeof b.text === 'string'; })
      .map(function(b) { return b.text; })
      .join('');
    if (!text.trim()) {
      if (data.stop_reason === 'max_tokens') {
        throw new Error('Anthropic used the whole token budget before answering (stop_reason: max_tokens)');
      }
      throw new Error('Empty response from Anthropic (stop_reason: ' + (data.stop_reason || 'unknown') + ')');
    }
    return text;
  }

  /**
   * OpenAI call with explicit API key (concurrency-safe — no shared state mutation).
   */
  async _chatOpenAIDirect(apiKey, systemPrompt, userMessage, maxTokens, agentTag) {
    var model = this.modelOf('openai', 'gpt-4.1');
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
        max_completion_tokens: maxTokens || 8192,
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
    var cloudNames = Object.keys(CLOUD_PROVIDER_KEYS);
    for (var ci = 0; ci < cloudNames.length; ci++) {
      if (this.keyFor(cloudNames[ci])) providers.push(cloudNames[ci]);
    }

    // Local runtimes.
    if (this.config.get('localOpenaiUrl')) providers.push('local-openai');
    var localModels = this.getOllamaModels();
    if (localModels.length > 1) {
      for (var mi = 0; mi < localModels.length; mi++) providers.push('ollama:' + localModels[mi]);
    } else if (localModels.length === 1 || this.provider === 'ollama' || providers.length === 0) {
      // Local-first: with no API key at all, the local model is the provider.
      providers.push('ollama');
    }
    return providers;
  }

  /** Local models listed in 'ollamaModels' (comma separated or array), without duplicates. */
  getOllamaModels() {
    var raw = this.config.get('ollamaModels');
    var list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var name = String(list[i]).trim();
      if (name && !seen[name]) {
        seen[name] = true;
        out.push(name);
      }
    }
    return out;
  }

  /** Model a provider id resolves to, for display and transcripts. */
  getModelFor(provider) {
    if (typeof provider === 'string' && provider.indexOf('ollama:') === 0) return provider.substring('ollama:'.length);
    if (provider === 'ollama') return this.ollamaModel || 'llama3.1';
    if (provider === 'local-openai') return this.config.get('localOpenaiModel') || 'local-model';
    if (provider === 'gemini') return 'gemini-2.5-flash';
    if (OPENAI_COMPAT_PROVIDERS[provider]) return this.modelOf(provider, OPENAI_COMPAT_PROVIDERS[provider].defaultModel);
    if (provider === 'anthropic') return this.modelOf('anthropic', 'claude-sonnet-5-5');
    if (provider === 'openai') return this.modelOf('openai', 'gpt-4.1');
    return this.model || provider;
  }

  /**
   * Model for one provider: its own setting ('anthropicModel', 'openaiModel', ...),
   * else 'llmModel' when this is the primary provider, else the default.
   * 'llmModel' must not leak to the other providers: a Claude model name sent
   * to OpenAI is an error, and with several providers that broke every call.
   */
  modelOf(provider, fallback) {
    var own = this.config.get(provider + 'Model');
    if (own) return own;
    if (this.model && provider === this.provider) return this.model;
    return fallback;
  }

  /**
   * Embedding vectors for the convergence measurement, from a local Ollama
   * embedding model. Only when 'ollamaEmbedModel' is set: nothing is embedded,
   * and nothing is sent anywhere, unless the user asked for it.
   * Returns one vector per text, or null when no embedding model is configured.
   */
  async embedTexts(texts) {
    var embedModel = this.config.get('ollamaEmbedModel');
    if (!embedModel) return null;
    var res = await fetch(this.ollamaUrl + '/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, input: texts }),
    });
    if (!res.ok) throw new Error('Ollama embedding error (' + res.status + ') for model "' + embedModel + '"');
    var data = await res.json();
    if (!data || !Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error('Ollama returned ' + (data && data.embeddings ? data.embeddings.length : 0) + ' embeddings for ' + texts.length + ' texts');
    }
    return data.embeddings;
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
// Local Geth Orchestrator — the whole deliberation runs on this machine
// =============================================================================
//
// Until v2.2 the orchestration intelligence (decomposition prompt, agent routing,
// per-round agent prompts, convergence measurement, synthesis and validation
// prompts, final scoring) lived on the NHA server and the client asked for it
// step by step. LocalGethOrchestrator implements the same step protocol in
// process, so a deliberation needs nothing but the user's own LLM provider(s).
//
// What changed with respect to the server implementation:
//   - PROMETHEUS (routing), CASSANDRA (tribunal) and ATHENA (audit) used to run
//     on the server's own model. They now run on one of the user's providers.
//   - The grounding RAG (verified facts retrieved from server datasets) does not
//     exist here. Fact checking is done by a provider call and is labelled as
//     model-based, never as "verified".
//   - Learned state (agent stats, episodic memories, ensemble patterns) is kept
//     in ~/.legion/local-store.json instead of the server database.

var LOCAL_GETH_DEFAULT_CONFIG = {
  deliberationRounds: 3,
  deliberationConvergence: 0.72,
  minDeliberationRounds: 2,
  maxAgents: 8,
  maxTokensPerAgent: 8192,
  synthesisMaxTokens: 16384,
  temperature: 0.7,
};

var LOCAL_GETH_SESSIONS_DIR = path.join(process.env.HOME || '.', '.legion', 'geth-sessions');
var LOCAL_GETH_STORE_FILE = path.join(process.env.HOME || '.', '.legion', 'local-store.json');

var PARLIAMENT_AGENT_NAMES = ['PROMETHEUS', 'CASSANDRA', 'ATHENA'];

var GETH_STRUCTURED_OUTPUT_INSTRUCTION = '\n\n' +
  '[STRUCTURED OUTPUT — REQUIRED]\n' +
  'You MUST wrap your response in the following JSON format. Do NOT include any text before or after the JSON block.\n\n' +
  '```json\n' +
  '{\n' +
  '  "answer": "<your full answer here>",\n' +
  '  "confidence": <0.0 to 1.0>,\n' +
  '  "reasoning_summary": "<1-2 sentence summary of your reasoning approach>",\n' +
  '  "risk_flags": ["<optional risk flag 1>", "<optional risk flag 2>"]\n' +
  '}\n' +
  '```\n\n' +
  'Confidence scale:\n' +
  '- 0.9-1.0: Near certain, well-established facts or straightforward analysis\n' +
  '- 0.7-0.89: High confidence, solid reasoning but some assumptions\n' +
  '- 0.5-0.69: Moderate confidence, multiple valid approaches exist\n' +
  '- 0.3-0.49: Low confidence, significant uncertainty or missing context\n' +
  '- 0.0-0.29: Very low confidence, mostly speculative\n\n' +
  'Risk flags (include any that apply):\n' +
  '- "speculative": Answer involves significant speculation\n' +
  '- "outdated_knowledge": Answer may rely on outdated information\n' +
  '- "incomplete_context": Missing critical context to answer fully\n' +
  '- "conflicting_evidence": Evidence points in multiple directions\n' +
  '- "ethical_concern": Answer touches on ethically sensitive topics\n' +
  '- "domain_mismatch": Task is outside your core expertise';

var GETH_LANGUAGE_PATTERNS = {
  it: {
    name: 'Italian', nativeName: 'ITALIANO',
    words: /\b(il|la|le|lo|gli|un|una|del|della|delle|dei|degli|nel|nella|che|per|con|tra|fra|questo|questa|questi|queste|come|anche|sono|essere|avere|fare|più|molto|ogni|tutto|tutti|quale|quali|quando|dove|perché|quindi|però|oppure|ancora|già|sempre|dopo|prima|mentre|invece|senza|fino|durante|secondo|attraverso|oltre|verso)\b/gi,
  },
  fr: {
    name: 'French', nativeName: 'FRANÇAIS',
    words: /\b(le|la|les|un|une|des|du|de|dans|sur|pour|avec|est|sont|être|avoir|faire|plus|très|tout|tous|cette|ces|qui|que|quand|où|pourquoi|donc|mais|aussi|encore|déjà|toujours|après|avant|pendant|entre|sans|vers|depuis|selon|chez)\b/gi,
  },
  de: {
    name: 'German', nativeName: 'DEUTSCH',
    words: /\b(der|die|das|ein|eine|und|oder|aber|ist|sind|werden|haben|sein|nicht|auch|noch|schon|immer|nach|vor|mit|für|auf|aus|bei|von|zu|über|unter|zwischen|durch|ohne|gegen|während|weil|dass|wenn|als|wie|mehr|sehr|alle|jeder|dieser|diese|dieses)\b/gi,
  },
  es: {
    name: 'Spanish', nativeName: 'ESPAÑOL',
    words: /\b(el|la|los|las|un|una|del|de|en|por|para|con|es|son|ser|estar|tener|hacer|más|muy|todo|todos|esta|este|estos|estas|que|cuando|donde|porque|pero|también|todavía|siempre|después|antes|durante|entre|sin|hacia|desde|según|sobre)\b/gi,
  },
  pt: {
    name: 'Portuguese', nativeName: 'PORTUGUÊS',
    words: /\b(o|a|os|as|um|uma|do|da|dos|das|em|no|na|por|para|com|é|são|ser|estar|ter|fazer|mais|muito|todo|todos|esta|este|estes|estas|que|quando|onde|porque|mas|também|ainda|sempre|depois|antes|durante|entre|sem|até|desde|sobre)\b/gi,
  },
};

/**
 * Detect the prompt language with a word-frequency heuristic.
 * Returns an ISO 639-1 code, 'en' when unsure. A [LANGUAGE: xx] tag wins.
 */
function gethDetectPromptLanguage(prompt) {
  var langOverride = String(prompt).match(/\[LANGUAGE:\s*([^\s\]]+)/i);
  if (langOverride) {
    var requested = langOverride[1].toLowerCase();
    if (requested === 'english' || requested === 'en') return 'en';
    var nameToCode = {
      italian: 'it', italiano: 'it', spanish: 'es', 'español': 'es',
      french: 'fr', 'français': 'fr', german: 'de', deutsch: 'de',
      portuguese: 'pt', 'português': 'pt',
    };
    return nameToCode[requested] || requested;
  }

  var words = String(prompt).split(/\s+/).filter(function(w) { return w.length > 1; });
  if (words.length < 5) return 'en';

  var bestLang = 'en';
  var bestRatio = 0;
  var langs = Object.keys(GETH_LANGUAGE_PATTERNS);
  for (var i = 0; i < langs.length; i++) {
    var matches = String(prompt).match(GETH_LANGUAGE_PATTERNS[langs[i]].words);
    var ratio = (matches ? matches.length : 0) / words.length;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestLang = langs[i];
    }
  }
  return bestRatio >= 0.15 ? bestLang : 'en';
}

/** Language directive for synthesis and validation prompts. Empty for English. */
function gethBuildLanguageDirective(lang) {
  var info = GETH_LANGUAGE_PATTERNS[lang];
  if (lang === 'en' || !info) return '';
  return '\nCRITICAL LANGUAGE INSTRUCTION: The original prompt is in ' + info.nativeName + '. ' +
    'Your ENTIRE response MUST be written in ' + info.nativeName + '. ' +
    'All headings, explanations, analysis, conclusions, and notes MUST be in ' + info.nativeName + '. ' +
    'This is non-negotiable.\n';
}

/** Stronger directive placed at the TOP of an agent system prompt. Empty for English. */
function gethBuildAgentLanguageDirective(lang) {
  var info = GETH_LANGUAGE_PATTERNS[lang];
  if (lang === 'en' || !info) return '';
  return '\n[MANDATORY LANGUAGE — ' + info.nativeName + ']\n' +
    'The user\'s prompt is in ' + info.nativeName + '. You MUST write your ENTIRE response in ' + info.nativeName + '. ' +
    'This includes ALL text: analysis, explanations, headings, bullet points, conclusions, reasoning_summary, and the answer field. ' +
    'Do NOT respond in English or any other language. Writing in the wrong language will make your contribution useless. ' +
    'This is a hard requirement.\n';
}

/** Complexity bucket and domain cluster of a prompt, from its length and vocabulary. */
function gethClassifyTaskContext(description) {
  var words = String(description).split(/\s+/).length;
  var complexityBucket = words <= 30 ? 'simple' : (words <= 100 ? 'medium' : 'complex');

  var domainCluster = 'general';
  if (/\b(code|program|function|class|module|api|bug|debug|refactor|test|compile|deploy|typescript|python|javascript|rust|sql)\b/i.test(description)) {
    domainCluster = 'code';
  } else if (/\b(secur|vuln|exploit|attack|pentest|owasp|cve|injection|xss|csrf|auth|encrypt|malware|threat|firewall)\b/i.test(description)) {
    domainCluster = 'security';
  } else if (/\b(writ|story|creative|blog|copy|content|design|art|brand|market|campaign|narrative|poem)\b/i.test(description)) {
    domainCluster = 'creative';
  } else if (/\b(data|analy|statist|trend|forecast|metric|dashboard|report|survey|research|hypothesis|experiment)\b/i.test(description)) {
    domainCluster = 'analytical';
  }
  return { complexityBucket: complexityBucket, domainCluster: domainCluster };
}

/**
 * Convergence threshold adapted to the task: complex decompositions get a lower
 * threshold (agents deliberate longer), simple ones a higher threshold.
 */
function gethComputeAdaptiveConvergence(baseThreshold, decomposition) {
  var tasks = decomposition.tasks;
  var uniqueCaps = {};
  var hasDependencies = false;
  for (var i = 0; i < tasks.length; i++) {
    uniqueCaps[tasks[i].capability] = true;
    if (tasks[i].dependsOn && tasks[i].dependsOn.length > 0) hasDependencies = true;
  }
  var complexity = 0;
  complexity += Math.min(tasks.length / 8, 1) * 0.35;
  complexity += Math.min(Object.keys(uniqueCaps).length / 6, 1) * 0.35;
  complexity += hasDependencies ? 0.3 : 0;
  var threshold = baseThreshold + (1 - complexity) * 0.15 - complexity * 0.15;
  return Math.max(0.55, Math.min(0.85, threshold));
}

/** Significant lowercase words of a text (length > 2), as a Set. */
function gethWordSet(text) {
  var out = new Set();
  var parts = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/);
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].length > 2) out.add(parts[i]);
  }
  return out;
}

/** Word-level Jaccard similarity of two texts, 0..1. */
function gethWordJaccard(a, b) {
  var setA = gethWordSet(a);
  var setB = gethWordSet(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  var intersection = 0;
  setA.forEach(function(w) { if (setB.has(w)) intersection++; });
  var union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Cut a text at a paragraph, sentence, line or word boundary within maxChars. */
/** How much of the synthesis ATHENA reads. Far above any real one: a safety cap, not a budget. */
var LOCAL_GETH_ATHENA_SYNTHESIS_CHARS = 80000;

/**
 * Read an ATHENA verdict from an answer that stops before its JSON closes.
 * The verdict comes first and every finding is a string: each string that was
 * completed is kept, the one that was cut off is dropped.
 * Returns { verdict, omissions, droppedObjections, recommendation } or null.
 */
function gethSalvageAthenaVerdict(text) {
  text = String(text || '');
  var verdict = text.match(/"verdict"\s*:\s*"(PASS|FLAG)"/);
  if (!verdict) return null;

  function completeStrings(field) {
    var opening = text.match(new RegExp('"' + field + '"\\s*:\\s*\\['));
    if (!opening) return [];
    var body = text.substring(opening.index + opening[0].length);
    var item = /\s*"((?:[^"\\]|\\.)*)"\s*(,|\])/y;
    var found = [];
    var m;
    while ((m = item.exec(body)) !== null) {
      try { found.push(JSON.parse('"' + m[1] + '"')); } catch (_) { /* a broken escape: not a finding we can trust */ }
      if (m[2] === ']') break;
    }
    return found;
  }

  return {
    verdict: verdict[1],
    omissions: completeStrings('omissions'),
    droppedObjections: completeStrings('droppedObjections'),
    recommendation: '',
  };
}

function gethTrimToCharBudget(text, maxChars) {
  text = String(text || '');
  if (text.length <= maxChars) return text;
  var cutAt = text.lastIndexOf('\n\n', maxChars);
  if (cutAt > maxChars * 0.4) return text.substring(0, cutAt);
  cutAt = text.lastIndexOf('. ', maxChars);
  if (cutAt > maxChars * 0.4) return text.substring(0, cutAt + 1);
  cutAt = text.lastIndexOf('\n', maxChars);
  if (cutAt > maxChars * 0.4) return text.substring(0, cutAt);
  cutAt = text.lastIndexOf(' ', maxChars);
  if (cutAt > 0) return text.substring(0, cutAt);
  return text.substring(0, maxChars);
}

/** Fisher-Yates shuffle, returns a new array. */
function gethShuffle(items) {
  var shuffled = items.slice();
  for (var i = shuffled.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  return shuffled;
}

function gethEscapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function gethExtractField(text, field) {
  var m = String(text).match(new RegExp('\\[' + field + '\\]:\\s*([\\s\\S]*?)(?=\\n\\[|$)'));
  return m ? m[1].trim() : '';
}

function gethExtractFieldFuzzy(text, fieldHint) {
  var patterns = {
    weakness: /(?:weakness|weak\s*point|critical\s*flaw)[:\s]*([\s\S]*?)(?=\n\[|$)/i,
    counter: /(?:counter[- ]?evidence|contradicts?|contradict)[:\s]*([\s\S]*?)(?=\n\[|$)/i,
    fail: /(?:fail(?:ure)?[- ]?scenario|would\s*fail|cause\s*harm)[:\s]*([\s\S]*?)(?=\n\[|$)/i,
    steel: /(?:steel[- ]?man|strongest\s*opposing|opposing\s*view)[:\s]*([\s\S]*?)(?=\n\[|$)/i,
    lateral: /(?:lateral|alternative\s*framing|different\s*angle)[:\s]*([\s\S]*?)(?=\n\[|$)/i,
    whatif: /(?:what[- ]?if|hypothetical|constraint\s*change)[:\s]*([\s\S]*?)(?=\n\[|$)/i,
  };
  var regex = patterns[fieldHint];
  if (!regex) return '';
  var m = String(text).match(regex);
  return m ? m[1].trim().substring(0, 500) : '';
}

/**
 * Parse CASSANDRA's tribunal output into one challenge per target agent.
 * Stage 1: the delimited format. Stage 2: JSON. Stage 3: fuzzy, for agents
 * still missing when fewer than 80% were found.
 */
function gethParseTribunalChallenges(output, expectedAgents) {
  output = String(output || '');
  var challenges = [];
  function normalizeName(name) {
    for (var ni = 0; ni < expectedAgents.length; ni++) {
      if (expectedAgents[ni].toLowerCase() === String(name).trim().toLowerCase()) return expectedAgents[ni];
    }
    return String(name).trim();
  }
  function has(name) {
    return challenges.some(function(c) { return c.targetAgent === name; });
  }

  var regex = /=== CHALLENGE: (.+?) ===([\s\S]*?)=== END CHALLENGE: \1 ===/g;
  var match;
  while ((match = regex.exec(output)) !== null) {
    var body = match[2];
    challenges.push({
      targetAgent: normalizeName(match[1]),
      weakness: gethExtractField(body, 'WEAKNESS'),
      counterEvidence: gethExtractField(body, 'COUNTER-EVIDENCE'),
      failureScenario: gethExtractField(body, 'FAILURE-SCENARIO'),
      steelMan: gethExtractField(body, 'STEEL-MAN'),
      lateral: gethExtractField(body, 'LATERAL'),
      whatIf: gethExtractField(body, 'WHAT-IF'),
    });
  }

  if (challenges.length === 0) {
    try {
      var jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/) || output.match(/(\{[\s\S]*\})/);
      if (jsonMatch && jsonMatch[1]) {
        var parsed = JSON.parse(jsonMatch[1].trim());
        var items = [];
        if (Array.isArray(parsed)) items = parsed;
        else if (Array.isArray(parsed.challenges)) items = parsed.challenges;
        else if (Array.isArray(parsed.tribunal_challenges)) items = parsed.tribunal_challenges;
        else if (parsed && typeof parsed === 'object') {
          items = Object.keys(parsed).map(function(k) { return { agent_name: k, challenge: parsed[k] }; });
        }
        for (var ii = 0; ii < items.length; ii++) {
          var item = items[ii] || {};
          var rawName = item.agent_name || item.agentName || item.agent || '';
          var ch = item.challenge || item;
          if (!rawName || !ch || typeof ch !== 'object') continue;
          var normalized = normalizeName(rawName);
          if (has(normalized)) continue;
          challenges.push({
            targetAgent: normalized,
            weakness: String(ch.WEAKNESS || ch.weakness || ch['FAILURE-SCENARIO'] || ''),
            counterEvidence: String(ch['COUNTER-EVIDENCE'] || ch.counter_evidence || ch.counterEvidence || ''),
            failureScenario: String(ch['FAILURE-SCENARIO'] || ch.FAILURE_SCENARIO || ch.failure_scenario || ch.failureScenario || ''),
            steelMan: String(ch['STEEL-MAN'] || ch.steel_man || ch.steelMan || ''),
            lateral: String(ch.LATERAL || ch.lateral || ''),
            whatIf: String(ch['WHAT-IF'] || ch.WHAT_IF || ch.what_if || ch.whatIf || ''),
          });
        }
      }
    } catch (_) { /* not JSON, fall through to the fuzzy stage */ }
  }

  if (challenges.length < expectedAgents.length * 0.8) {
    var allNames = expectedAgents.map(gethEscapeRegex).join('|');
    for (var ei = 0; ei < expectedAgents.length; ei++) {
      var agentName = expectedAgents[ei];
      if (has(agentName)) continue;
      var fuzzy = new RegExp(
        '(?:challenge|' + gethEscapeRegex(agentName) + ')[:\\s]*([\\s\\S]*?)(?=(?:=== CHALLENGE|' + allNames + ')|$)', 'i');
      var fm = output.match(fuzzy);
      if (fm && fm[1] && fm[1].trim().length > 30) {
        challenges.push({
          targetAgent: agentName,
          weakness: gethExtractFieldFuzzy(fm[1], 'weakness'),
          counterEvidence: gethExtractFieldFuzzy(fm[1], 'counter'),
          failureScenario: gethExtractFieldFuzzy(fm[1], 'fail'),
          steelMan: gethExtractFieldFuzzy(fm[1], 'steel'),
          lateral: gethExtractFieldFuzzy(fm[1], 'lateral'),
          whatIf: gethExtractFieldFuzzy(fm[1], 'whatif'),
        });
      }
    }
  }

  return challenges;
}

/**
 * Recover the complete tasks from a decomposition cut off by the token limit.
 * Scans the "tasks" array and keeps every object whose braces close; the one
 * that was being written when the output stopped is dropped.
 * Returns { tasks } or null when not even one task is complete.
 */
function gethSalvageDecomposition(text) {
  var tasks = gethSalvageArrayObjects(text, 'tasks');
  return tasks.length > 0 ? { tasks: tasks } : null;
}

/**
 * The complete objects of the JSON array stored under `key`, read from text
 * that may stop in the middle of the array. Returns [] when there is none.
 */
function gethSalvageArrayObjects(text, key) {
  text = String(text || '');
  var start = text.indexOf('"' + key + '"');
  if (start === -1) return [];
  var open = text.indexOf('[', start);
  if (open === -1) return [];

  var tasks = [];
  var depth = 0;
  var objectStart = -1;
  var inString = false;
  var escaped = false;
  for (var i = open + 1; i < text.length; i++) {
    var ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        try {
          tasks.push(JSON.parse(text.substring(objectStart, i + 1)));
        } catch (_) { /* a malformed object is skipped, the others still count */ }
        objectStart = -1;
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }
  return tasks;
}

/**
 * Check a PROMETHEUS routing decision coming back from a model.
 * Returns the cleaned decision, or null when it cannot be used.
 */
function gethValidatePrometheusDecision(raw, knownAgents, availableProviders) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.agents)) return null;
  var byUpper = {};
  for (var i = 0; i < knownAgents.length; i++) byUpper[knownAgents[i].agentName.toUpperCase()] = knownAgents[i];

  var agents = [];
  var seen = {};
  for (var ai = 0; ai < raw.agents.length; ai++) {
    var entry = raw.agents[ai];
    var name = entry && typeof entry.name === 'string' ? entry.name.trim().toUpperCase() : '';
    if (!name || !byUpper[name] || seen[name]) continue;
    seen[name] = true;
    var provider = typeof entry.provider === 'string' && availableProviders.indexOf(entry.provider) !== -1
      ? entry.provider : '';
    var focus = typeof entry.focus === 'string' ? entry.focus.trim().substring(0, 500) : '';
    agents.push({ name: byUpper[name].agentName, provider: provider, focus: focus });
  }
  if (agents.length < 3) return null;
  if (agents.length > 15) agents = agents.slice(0, 15);

  var rounds = Math.round(Number(raw.rounds));
  if (!isFinite(rounds)) rounds = 2;
  rounds = Math.max(1, Math.min(5, rounds));

  var complexity = ['simple', 'medium', 'complex'].indexOf(raw.complexity) !== -1 ? raw.complexity : 'medium';
  return {
    agents: agents,
    rounds: rounds,
    cassandra: raw.cassandra === true,
    athena: raw.athena === true,
    complexity: complexity,
  };
}

/**
 * Round-robin provider assignment over shuffled agents and providers, so every
 * available provider is used when there are at least as many agents.
 */
function gethAssignProvidersToAgents(agentNames, availableProviders) {
  var pinning = {};
  if (availableProviders.length === 0) return pinning;
  var agents = gethShuffle(agentNames);
  var providers = gethShuffle(availableProviders);
  for (var i = 0; i < agents.length; i++) pinning[agents[i]] = providers[i % providers.length];
  return pinning;
}

// -----------------------------------------------------------------------------
// Domain taxonomy — which kind of agent may speak on which kind of question
// -----------------------------------------------------------------------------

var GETH_DOMAIN_FAMILIES = {
  tech: ['code', 'cybersecurity', 'sw_architecture', 'frontend', 'distributed_systems', 'networking', 'database', 'devops', 'cloud', 'ai_ml', 'data_engineering'],
  engineering: ['meccanica', 'automazione', 'oleodinamica', 'pneumatica', 'elettronica', 'ing_civile', 'ing_energetica'],
  science: ['medicina', 'farmacologia', 'neuroscienze', 'sanita_pub', 'genetica', 'biotech', 'agricoltura', 'alimentazione'],
  law: ['compliance_gdpr', 'diritto_lavoro', 'prop_intellettuale', 'contrattualistica', 'diritto_penale', 'regol_ai'],
  business: ['economia', 'finanza', 'strategia_az', 'marketing', 'supply_chain', 'hr', 'startup'],
  humanities: ['filosofia', 'epistemologia', 'etica', 'bioetica', 'psicologia', 'sociologia', 'pedagogia', 'decision_making'],
  policy: ['geopolitica', 'diplomazia', 'politica_int', 'governance', 'urbanistica', 'trasporti', 'infra_critica', 'logistica'],
  environment: ['ambiente', 'sostenibilita', 'cambiamento_climatico', 'energia'],
  communication: ['comunicazione', 'brand_strategy', 'crisis_communication'],
};

var GETH_DOMAIN_TO_FAMILY = (function() {
  var map = { general: 'general' };
  Object.keys(GETH_DOMAIN_FAMILIES).forEach(function(family) {
    GETH_DOMAIN_FAMILIES[family].forEach(function(domainId) { map[domainId] = family; });
  });
  return map;
})();

// [domainId, keyword pattern, weight]. Italian and English stems side by side:
// the questions come in both languages.
var GETH_DOMAIN_PATTERNS = [
  ['code', /\b(cod(?:e|ing)|program|function|class|module|api|bug|debug|refactor|test(?:ing)?|compil|deploy|typescript|python|javascript|rust|java\b|c\+\+|golang|swift|kotlin|react|angular|vue\.?js|webpack|npm|git(?:hub)?|algorithm|library|framework|sdk|ide)\b/gi, 1.0],
  ['cybersecurity', /\b(vulnerabilit|exploit|malware|ransomware|phishing|firewall|ids|siem|pentest|zero.?day|cve|owasp|xss|csrf|sql.?inject|auth(?:enticat|oriz)|encrypt|decrypt|cipher|tls|ssl|cert|hash|brute.?force|botnet|apt|threat.?model|red.?team|blue.?team|soc|incident.?respon|forensic)\b/gi, 1.0],
  ['sw_architecture', /\b(microservic|monolith|event.?driven|cqrs|saga|hexagonal|clean.?arch|domain.?driven|solid|design.?pattern|scalab|load.?balanc|service.?mesh|api.?gateway|event.?sourc)\b/gi, 1.0],
  ['frontend', /\b(frontend|ui|ux|css|html|responsive|accessibility|a11y|component|layout|animation|spa|ssr|ssg|tailwind|styled|figma|wireframe)\b/gi, 0.9],
  ['distributed_systems', /\b(distribut|consensus|raft|paxos|gossip.?protocol|cap.?theorem|eventual.?consist|partition.?toleran|replicat|shard|leader.?elect|vector.?clock|lamport)\b/gi, 1.0],
  ['networking', /\b(network|tcp|udp|http|dns|bgp|ospf|vlan|subnet|router|switch|packet|latency|bandwidth|cdn|proxy|vpn|nat|dhcp|arp|icmp)\b/gi, 0.9],
  ['database', /\b(databas|sql|nosql|postgres|mysql|mongodb|redis|cassandra|elastic|index|query.?optim|normali[zs]|denormali[zs]|transaction|acid|olap|oltp|data.?warehouse|etl|migration|schema)\b/gi, 1.0],
  ['devops', /\b(devops|ci.?cd|pipeline|docker|kubernetes|k8s|terraform|ansible|jenkins|github.?action|gitlab|helm|prometheus|grafana|container|orchestrat|infrastructure.?as.?code)\b/gi, 1.0],
  ['cloud', /\b(cloud|aws|azure|gcp|serverless|lambda|s3|ec2|iam|vpc|cloudfront|cloudflare|saas|paas|iaas|multi.?cloud|hybrid.?cloud)\b/gi, 0.9],
  ['ai_ml', /\b(machine.?learn|deep.?learn|neural.?net|transformer|llm|gpt|bert|diffusion|reinforcement.?learn|supervised|unsupervised|training.?data|fine.?tun|embedding|tokeniz|attention.?mechan|gradient|backprop|epoch|batch.?size|hyperparamet|overfitting|regulariz)\b/gi, 1.0],
  ['data_engineering', /\b(data.?engineer|data.?pipeline|spark|kafka|airflow|dbt|data.?lake|data.?mesh|stream.?process|batch.?process|data.?qualit|data.?lineage|data.?catalog|parquet|avro|delta.?lake)\b/gi, 1.0],
  ['meccanica', /\b(meccanic|ingranaggi|cuscinett|albero|trasmission|torni|fresa|cnc|tolleranz|lavorazion|acciai|leghe|trattament.{0,10}termic|fatica|creep|frattura|tribolog|lubrificaz|manuten[zs]ion)\b/gi, 1.0],
  ['automazione', /\b(automa[zs]ion|plc|scada|hmi|robot|cobot|sensori?|attuator|pid|feedback|controllo.{0,10}process|industria.?4\.?0|iot.?industrial|m2m|digital.?twin)\b/gi, 1.0],
  ['oleodinamica', /\b(oleodinamic|idraulic|cilindro|pompa|valvola|pressione|portata|fluido|accumulat|servocomand|proporzional)\b/gi, 1.0],
  ['pneumatica', /\b(pneumatic|aria.?compres|compressor|elettrovalvol|attuator.?pneumat|filtro.?regolator)\b/gi, 1.0],
  ['elettronica', /\b(elettronic|circuito|pcb|microcontroll|fpga|asic|adc|dac|amplificat|filtr|oscillat|mosfet|igbt|pwm|segnale|analog|digital)\b/gi, 1.0],
  ['ing_civile', /\b(struttur|cemento|acciaio.{0,10}armato|fondazion|sismic|geotecnic|pont|galleri|edili[zs]i|urbanistic|topograf|cantier|calcestruzz)\b/gi, 1.0],
  ['ing_energetica', /\b(termodinamic|scambio.?termic|turbina|caldaia|cogeneraz|trigeneraz|pompa.?di.?calor|fotovoltaic|eolic|biomass|rendiment.?energetic|efficien[zs].?energetic)\b/gi, 1.0],
  ['medicina', /\b(medic|pazient|clinic|diagnos|terapi|farmac|chirurg|patolog|sintom|ospedal|infermier|prognos|anamnes|radiolog|oncolog|cardiolog|neurolog.{0,5}(?:ia|o|ica)|gastroenterol|dermatol|ortoped|pediatr|geriatr|riabilita[zs])\b/gi, 1.0],
  ['farmacologia', /\b(farmac(?:olog|eutic)|principio.?attivo|posolog|farmacocinet|farmacodinamic|effett.?collateral|interazion.?farmac|biodisponibilit|metabolis|escrezion|tossicolog|dose.?terapeut|placebo)\b/gi, 1.2],
  ['neuroscienze', /\b(neuroscien|cervello|neuron|sinapsi|neurotrasmettitor|corteccia|ippocampo|amigdala|neuroplasticit|neurodegenerat|cognitiv|percezione|consciou|brain.?imaging|fmri|eeg)\b/gi, 1.0],
  ['sanita_pub', /\b(sanit.{0,5}pub|epidemiolog|pandemia|vaccin|prevenzione|screening|salute.?pubblica|sistema.?sanitario|ssn|mortalit|morbilità|determinant.?salute)\b/gi, 1.0],
  ['genetica', /\b(genetic|dna|rna|genom|crispr|mutagenes|ereditariet|cromosoma|allele|fenotip|genotip|sequenziament|epigenet|gene.?editing|transcription)\b/gi, 1.0],
  ['biotech', /\b(biotecnolog|bioingegner|bioreattore|fermentazion|coltura.?cellul|anticorpo.?monoclonal|terapia.?genica|ogm|biosensor|bioprocess|bioinformat)\b/gi, 1.0],
  ['agricoltura', /\b(agricol|coltur|raccolto|irrigaz|fitosanitar|pesticid|suolo|semina|bestiame|agronom|pac|precision.?farming|agrofood|rotazion.?coltur|fertili[zs]z|zootecn)\b/gi, 1.0],
  ['alimentazione', /\b(alimenta[zs]ion|nutri[zs]ion|dieta|calori|macronutrient|micronutrient|integratori?|sicurezz.?alimentar|haccp|additiv|conservant|etichett.?alimentar|allergen|intolleran[zs])\b/gi, 1.0],
  ['compliance_gdpr', /\b(gdpr|privacy|dato.?personal|trattament.?dat|consenso|diritto.?oblio|dpo|data.?protection|informativ|base.?giuridic|legittimo.?interesse|portabilit)\b/gi, 1.0],
  ['diritto_lavoro', /\b(licenziamento|contratto.{0,10}lavoro|dimission|lavorator|sindacat|retribuz|ferie|ccnl|inps|contribut|orario.?di.?lavoro|cassa.?integraz|naspi|tutele.?lavorat|mobbing)\b/gi, 1.0],
  ['prop_intellettuale', /\b(brevett|copyright|marchio|proprie[tà].?intellettual|patent|trademark|tutela|plagio|licenz.?d.?uso|royalt|design.?industriale|denominaz.?origin)\b/gi, 1.0],
  ['contrattualistica', /\b(contratt(?:o|uale|ualistica)|clausola|rescission|inadempiment|penale|arbitrat|mediazion|risoluzion.?contratt|appalto|subappalto|garanzi)\b/gi, 1.0],
  ['diritto_penale', /\b(reato|penale|codice.?penale|frode|truffa|appropriaz|corruz|riciclaggi|antiriciclaggi|pena|sanzione.?penal|querela|procedimento.?penal|imputat)\b/gi, 1.0],
  ['regol_ai', /\b(ai.?act|regolament.{0,10}(?:ai|intelligenz)|rischio.?ai|sistema.?ad.?alto.?rischio|trasparenz.?algorit|bias.?algorit|responsabilit.?ai|audit.?algorit|explainab|xai)\b/gi, 1.2],
  ['economia', /\b(econom|pil|inflaz|deflaz|recessione|crescita.?economic|mercato|domanda|offerta|equilibri|macroeconom|microeconom|politica.?monetar|politica.?fiscal|tass.?di.?interesse)\b/gi, 1.0],
  ['finanza', /\b(finanz|investiment|portafogli|azioni|obbligaz|derivat|option|futures|bilancio|cash.?flow|roi|ebitda|valutazion|risk.?management|hedge|trading|borsa)\b/gi, 1.0],
  ['strategia_az', /\b(strategia.?aziendale|business.?model|vantaggio.?competitiv|swot|porter|blue.?ocean|value.?chain|core.?competenc|diversificaz|m&a|fusione|acquisiz)\b/gi, 1.0],
  ['marketing', /\b(marketing|brand|posizionament|target|segment|funnel|conversion|lead|seo|sem|social.?media|content.?market|influencer|customer.?journey|retention|churn)\b/gi, 1.0],
  ['supply_chain', /\b(supply.?chain|logistic|magazzin|inventari|procurement|fornitore|outsourc|just.?in.?time|lean|six.?sigma|demand.?planning|trasporto.?merc)\b/gi, 1.0],
  ['hr', /\b(risorse.?umane|human.?resource|talent|recruiting|selezione.?personale|onboarding|performance.?review|compensation|benefit|employer.?branding|hr.?analytics|turnover)\b/gi, 1.0],
  ['startup', /\b(startup|venture.?capital|seed|series.?[abc]|unicorn|pivot|mvp|product.?market.?fit|bootstrapp|incubat|accelerat|pitch.?deck|valuation|cap.?table|equity)\b/gi, 1.0],
  ['filosofia', /\b(filosofi|metafisic|ontologi|fenomenolog|ermeneutic|esisten[zs]ial|trascendent|platone|aristotele|kant|hegel|nietzsche|heidegger|wittgenstein|derrida|foucault)\b/gi, 1.0],
  ['epistemologia', /\b(epistemolog|conoscenz|giustificaz.?epistemic|fondament.?conoscenz|scetticism|relativism|fallibilism|razionalit|evidenz|bayesian|induzion|deduzion|abduction|peer.?review|metodo.?scientifico|falsificab)\b/gi, 1.2],
  ['etica', /\b(etic(?:a|o|he)|moral|deontolog|consequential|utilitar|virtue.?ethic|categoric.?imperative|dilemma.?etic|responsabilit.?moral|giustizia.?social|equit|diritti.?uman)\b/gi, 1.0],
  ['bioetica', /\b(bioetic|eutanasia|aborto|consenso.?informato|sperimentazion.?uman|clonaz|eugenic|donazion.?organ|accaniment.?terapeutic|testamento.?biolog|comitato.?etic)\b/gi, 1.2],
  ['psicologia', /\b(psicolog|cogniti[fv]|comportament|behavioral|freud|jung|piaget|skinner|motivazion|personalit|disturbo|ansia|depression|terapia.?cognitiv|psicoterapi|resilienza)\b/gi, 1.0],
  ['sociologia', /\b(sociolog|societ|stratificaz|disuguaglianz|mobilit.?social|istituzion|norme.?social|devianz|capital.?social|durkheim|weber|bourdieu|habitus|anomia)\b/gi, 1.0],
  ['pedagogia', /\b(pedagogi|didattic|apprendiment|insegnament|curriculum|competenz|formaz|educazion|scuola|universit|valutazion.?formatv|montessori|costruttivism|inclusio)\b/gi, 1.0],
  ['decision_making', /\b(decision.?mak|decision.?theor|heuristic|bias.?cognitiv|prospect.?theory|bounded.?rational|nudge|game.?theory|multi.?criteria|analytic.?hierarchy|risk.?assess|cost.?benefit)\b/gi, 1.0],
  ['geopolitica', /\b(geopolitic|equilibri.?di.?potere|sfera.?d.?influenz|nato|onu|g7|g20|sanzioni|embargo|alleanz|conflitto.?internazional|deterrenz|multipolar)\b/gi, 1.0],
  ['diplomazia', /\b(diplomazi|negoziato|trattato|accordo.?internazional|ambascia|consolato|relazion.?bilateral|multilateral|mediazion.?internazional|soft.?power|hard.?power)\b/gi, 1.0],
  ['politica_int', /\b(politica.?internazional|relazion.?internazional|ordine.?mondial|cooperazion.?internazional|organizzaz.?internazional|diritto.?internazional|sovranit)\b/gi, 1.0],
  ['governance', /\b(governance|governa[zs]ion|trasparenz|accountability|partecipaz|istituzion|amministraz|burocraz|decentrament|federalism|e.?government|digital.?governance)\b/gi, 1.0],
  ['urbanistica', /\b(urbanistic|pianificaz.?urban|rigeneraz|smart.?city|mobilit.?urban|trasporto.?pubblic|viabilit|zoning|pgt|piano.?regolator|infrastruttur.?urban)\b/gi, 1.0],
  ['trasporti', /\b(trasport|logistic.?transport|ferroviar|aviazion|navigaz|autonom.?driv|fleet|intermodal|mobilit.?sostenibil|electric.?vehicl)\b/gi, 0.9],
  ['infra_critica', /\b(infrastruttur.?critic|resilienza.?infrastruttur|protezione.?civile|emergenz|disaster.?recover|business.?continuity|rete.?elettric|rete.?idric|telecomunicaz)\b/gi, 1.0],
  ['logistica', /\b(logistic|warehousing|distribuz|ultimo.?miglio|last.?mile|fulfillment|cold.?chain|reverse.?logistic|tracking|traceabilit)\b/gi, 0.9],
  ['ambiente', /\b(ambient|inquinament|biodiversit|ecosistem|conservaz|habitat|fauna|flora|impatto.?ambiental|via|valutaz.?ambiental|rifiut|ricicl|economia.?circolar)\b/gi, 1.0],
  ['sostenibilita', /\b(sostenibil|esg|sdgs|agenda.?2030|carbon.?footprint|impronta.?ecolog|green.?deal|circular.?econom|life.?cycle|cradle.?to|triple.?bottom|responsabilit.?social)\b/gi, 1.0],
  ['cambiamento_climatico', /\b(cambiament.?climatic|climate.?change|riscaldament.?global|global.?warming|gas.?serra|emissioni|co2|ipcc|paris.?agreement|decarboniz|net.?zero|adattament.?climatic)\b/gi, 1.0],
  ['energia', /\b(energia|rinnovabil|fossile|transizion.?energetic|mix.?energetic|nucleare|idrogen|accumulo|battery|storage|smart.?grid|microgrids|energy.?efficien)\b/gi, 1.0],
  ['comunicazione', /\b(comunicaz|public.?relation|media.?relation|press|giornalism|storytelling|narrati[fv]|discors|retoric|semiotica|comunicaz.?d.?impres)\b/gi, 1.0],
  ['brand_strategy', /\b(brand.?strateg|brand.?identity|brand.?positioning|rebrand|brand.?equity|brand.?awareness|brand.?architecture|visual.?identity|tone.?of.?voice)\b/gi, 1.0],
  ['crisis_communication', /\b(crisis.?communicat|comunicaz.?di.?crisi|gestione.?crisi|reputaz|reputation.?management|damage.?control|crisis.?plan|media.?training)\b/gi, 1.2],
];

/** Number of non-overlapping matches of a global regex in a text. */
function gethCountMatches(text, regex) {
  var found = String(text).match(regex);
  return found ? found.length : 0;
}

var GETH_STEM_REGEX_CACHE = new Map();

/**
 * Number of words in a text that start with one of the stems of a keyword
 * pattern written as /\b(stem|stem|...)\b/.
 *
 * The lists hold stems ("pazient", "terapi", "reliab"), but a pattern that
 * ends with \b only matches when the word ends at the stem: "paziente" and
 * "terapia" were never found. Here a stem of five letters or more also matches
 * the words it begins ("paziente", "reliability"); a shorter one ("api", "ide",
 * "via", "nato") still has to be the whole word, or it would match "apice",
 * "idea", "viaggio".
 */
function gethCountStemMatches(text, regex) {
  var derived = GETH_STEM_REGEX_CACHE.get(regex);
  if (!derived) {
    derived = new RegExp(regex.source.replace(/\\b$/, '') + '([a-z0-9_\\u00c0-\\u00ff]*)', 'gi');
    GETH_STEM_REGEX_CACHE.set(regex, derived);
  }
  derived.lastIndex = 0;
  var count = 0;
  var m;
  while ((m = derived.exec(String(text))) !== null) {
    var suffix = m[m.length - 1];
    var stem = m.length > 2 ? m[1] : m[0];
    if (suffix === '' || (stem && stem.length >= 5)) count++;
    if (m[0] === '') derived.lastIndex++;
  }
  return count;
}

/** A second family scoring at least this share of the best one makes the question ambiguous. */
var GETH_DOMAIN_AMBIGUITY_RATIO = 0.75;

/**
 * Domain and family of a question.
 * 1. An explicit [domain:X] tag wins, with confidence 1.
 * 2. Otherwise the domain whose keywords occur most, weighted; confidence
 *    follows keyword density and never exceeds 0.95.
 * 3. No keyword at all: general, confidence 0.
 */
function gethClassifyDomain(prompt) {
  prompt = String(prompt || '');
  var tag = prompt.match(/\[domain:(\w+)\]/i);
  if (tag && GETH_DOMAIN_TO_FAMILY[tag[1].toLowerCase()]) {
    var tagged = tag[1].toLowerCase();
    return { domainId: tagged, family: GETH_DOMAIN_TO_FAMILY[tagged], confidence: 1.0 };
  }

  var lower = prompt.toLowerCase();
  var wordCount = lower.split(/\s+/).filter(Boolean).length;
  var bestDomain = 'general';
  var bestScore = 0;
  var bestByFamily = {};
  for (var i = 0; i < GETH_DOMAIN_PATTERNS.length; i++) {
    var domainId = GETH_DOMAIN_PATTERNS[i][0];
    var score = gethCountStemMatches(lower, GETH_DOMAIN_PATTERNS[i][1]) * GETH_DOMAIN_PATTERNS[i][2];
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domainId;
    }
    var familyOfDomain = GETH_DOMAIN_TO_FAMILY[domainId] || 'general';
    if (score > (bestByFamily[familyOfDomain] || 0)) bestByFamily[familyOfDomain] = score;
  }
  if (bestScore === 0) return { domainId: 'general', family: 'general', confidence: 0 };

  // A family wins only with a clear lead over every other one. One keyword
  // each for two families is a tie in all but the weights: the question
  // belongs to neither more than the other, and the one listed first would be
  // a guess that then decides which agents are allowed to answer.
  var winningFamily = GETH_DOMAIN_TO_FAMILY[bestDomain] || 'general';
  var families = Object.keys(bestByFamily);
  for (var f = 0; f < families.length; f++) {
    if (families[f] !== winningFamily && bestByFamily[families[f]] >= bestScore * GETH_DOMAIN_AMBIGUITY_RATIO) {
      return { domainId: 'general', family: 'general', confidence: 0 };
    }
  }

  var density = bestScore / Math.max(wordCount, 1);
  return {
    domainId: bestDomain,
    family: GETH_DOMAIN_TO_FAMILY[bestDomain] || 'general',
    confidence: Math.min(0.95, Math.max(0.1, density * 3)),
  };
}

// Agent categories per domain family: preferred, allowed, prohibited.
var GETH_DOMAIN_AFFINITY = {
  science: { preferred: ['analytics', 'data', 'meta-evolution'], allowed: ['content', 'communication', 'monitoring'], prohibited: ['code', 'devops', 'security', 'automation', 'commands'] },
  law: { preferred: ['analytics', 'meta-evolution', 'content'], allowed: ['data', 'communication', 'monitoring'], prohibited: ['code', 'devops', 'security', 'automation', 'commands'] },
  tech: { preferred: ['code', 'security', 'devops', 'data', 'analytics'], allowed: ['automation', 'monitoring', 'integration', 'meta-evolution', 'commands'], prohibited: ['social'] },
  engineering: { preferred: ['analytics', 'data', 'automation', 'monitoring'], allowed: ['code', 'devops', 'meta-evolution', 'integration'], prohibited: ['social', 'content', 'communication'] },
  business: { preferred: ['analytics', 'data', 'content', 'communication'], allowed: ['meta-evolution', 'integration', 'monitoring'], prohibited: ['code', 'devops', 'security', 'commands'] },
  humanities: { preferred: ['analytics', 'meta-evolution', 'content'], allowed: ['data', 'communication', 'social'], prohibited: ['code', 'devops', 'security', 'automation', 'commands'] },
  policy: { preferred: ['analytics', 'data', 'meta-evolution', 'communication'], allowed: ['content', 'integration', 'monitoring', 'social'], prohibited: ['code', 'devops', 'security', 'automation', 'commands'] },
  environment: { preferred: ['analytics', 'data', 'meta-evolution'], allowed: ['content', 'communication', 'monitoring', 'integration'], prohibited: ['code', 'devops', 'security', 'commands'] },
  communication: { preferred: ['content', 'communication', 'social', 'analytics'], allowed: ['data', 'meta-evolution', 'integration'], prohibited: ['code', 'devops', 'security', 'automation', 'commands'] },
  general: { preferred: ['analytics', 'meta-evolution'], allowed: [], prohibited: [] },
};

/**
 * Replace the agents whose category is prohibited for the question's domain.
 *
 * agents: [{ name, category }]. available: [{ agentName, category }].
 * A replacement comes from the preferred categories, then the allowed ones,
 * and is never an agent already in the list. With no replacement left the
 * original stays: too few agents is worse than one out of place.
 * LOGOS always passes (domain-agnostic reasoner). A general or uncertain
 * domain (confidence below 0.3) changes nothing.
 */
function gethValidateAgentDomainAffinity(agents, domain, available) {
  var unchanged = agents.map(function(a) { return { name: a.name, category: a.category }; });
  if (domain.family === 'general' || domain.confidence < 0.3) return unchanged;
  var affinity = GETH_DOMAIN_AFFINITY[domain.family] || GETH_DOMAIN_AFFINITY.general;

  var assigned = {};
  agents.forEach(function(a) { assigned[a.name.toUpperCase()] = true; });

  function findReplacement() {
    var tiers = [affinity.preferred, affinity.allowed];
    for (var t = 0; t < tiers.length; t++) {
      for (var i = 0; i < available.length; i++) {
        if (tiers[t].indexOf(available[i].category) !== -1 && !assigned[available[i].agentName.toUpperCase()]) {
          return available[i];
        }
      }
    }
    return null;
  }

  return agents.map(function(agent) {
    if (agent.name.toUpperCase() === 'LOGOS' || affinity.prohibited.indexOf(agent.category) === -1) {
      return { name: agent.name, category: agent.category };
    }
    var replacement = findReplacement();
    if (!replacement) return { name: agent.name, category: agent.category };
    delete assigned[agent.name.toUpperCase()];
    assigned[replacement.agentName.toUpperCase()] = true;
    return { name: replacement.agentName, category: replacement.category, replaced: true, originalName: agent.name };
  });
}

var GETH_IDENTITY_PATTERNS = [
  /\bI(?:'m| am) (?:a|an) (\w[\w\s]{2,30}?)(?:engineer|specialist|expert|analyst|developer|architect|consultant|professional|advisor)\b/i,
  /\bas (?:a|an) (\w[\w\s]{2,30}?)(?:engineer|specialist|expert|analyst|developer|architect|consultant|professional|advisor)\b/i,
  /\bmy expertise (?:is|lies) in (\w[\w\s]{2,30})\b/i,
  /\bfrom (?:a|an|my) (\w[\w\s]{2,30}?) perspective\b/i,
];

// Vocabulary that should not dominate an answer in a given family.
var GETH_OFF_TOPIC = {
  science: /\b(devops|infrastr|pipeline|deploy|container|kubernetes|security|pentest|firewall|exploit|code.?review|pull.?request|git|frontend|backend|microservice)\b/gi,
  law: /\b(devops|infrastr|pipeline|deploy|container|kubernetes|security.?engineer|pentest|code|program|debug|frontend|backend|microservice|docker)\b/gi,
  tech: /\b(pazient|diagnos|terapi|farmac|chirurg|sindacat|licenziament|ccnl|coltur|irrigaz|agrofood)\b/gi,
  engineering: /\b(pazient|diagnos|terapi|farmac|chirurg|licenziament|marketing|brand|seo|storytelling)\b/gi,
  business: /\b(pazient|diagnos|terapi|farmac|chirurg|devops|container|kubernetes|exploit|pentest|neuron|sinapsi)\b/gi,
  humanities: /\b(devops|infrastr|pipeline|deploy|container|kubernetes|exploit|pentest|docker|terraform|ci.?cd)\b/gi,
  policy: /\b(devops|infrastr|pipeline|deploy|container|kubernetes|exploit|pentest|docker|terraform|ci.?cd|debug)\b/gi,
  environment: /\b(devops|infrastr|pipeline|deploy|container|kubernetes|exploit|pentest|docker|terraform|ci.?cd|debug)\b/gi,
  communication: /\b(devops|infrastr|pipeline|deploy|container|kubernetes|exploit|pentest|docker|terraform|ci.?cd|debug)\b/gi,
};

var GETH_DISCLAIMER_PATTERNS = [
  /\b(?:I )?cannot (?:answer|address|provide|help with) this/i,
  /\bthis is (?:outside|beyond) my (?:expertise|scope|area)/i,
  /\bI'?m not (?:qualified|able|equipped|the right)/i,
  /\bnot (?:my )?area of (?:expertise|specialization|competence)/i,
  /\bI (?:lack|don't have) (?:the )?(?:expertise|knowledge|background) (?:in|for|to)/i,
];

/**
 * Whether a proposal belongs to the question's domain.
 * Returns null when it does, or { agentName, flags, severityMultiplier } where
 * the multiplier (0.3 to 0.5) lowers the agent's weight in the synthesis:
 * - identity_confusion (0.3): the agent presents itself in an off-topic role
 * - domain_mismatch (0.5): off-topic vocabulary dominates the first 2,000 characters
 * - disclaimer_evasion (0.4): the agent declines to answer
 */
function gethAssessProposalDomainRelevance(proposal, domain) {
  if (domain.family === 'general' || domain.confidence < 0.3) return null;
  var offTopic = GETH_OFF_TOPIC[domain.family];
  var content = String(proposal.content || '');
  var flags = [];
  var severity = 1.0;

  if (offTopic) {
    for (var i = 0; i < GETH_IDENTITY_PATTERNS.length; i++) {
      var declared = content.match(GETH_IDENTITY_PATTERNS[i]);
      if (declared && gethCountStemMatches(declared[1].trim().toLowerCase(), offTopic) > 0) {
        flags.push('identity_confusion');
        severity = Math.min(severity, 0.3);
        break;
      }
    }

    if (domain.confidence >= 0.5 && flags.length === 0) {
      var sample = content.toLowerCase().substring(0, 2000);
      var onTopicPattern = null;
      for (var p = 0; p < GETH_DOMAIN_PATTERNS.length; p++) {
        if (GETH_DOMAIN_PATTERNS[p][0] === domain.domainId) { onTopicPattern = GETH_DOMAIN_PATTERNS[p][1]; break; }
      }
      var onTopic = onTopicPattern ? gethCountStemMatches(sample, onTopicPattern) : 0;
      if (gethCountStemMatches(sample, offTopic) >= 3 && onTopic <= 1) {
        flags.push('domain_mismatch');
        severity = Math.min(severity, 0.5);
      }
    }
  }

  for (var d = 0; d < GETH_DISCLAIMER_PATTERNS.length; d++) {
    if (GETH_DISCLAIMER_PATTERNS[d].test(content)) {
      flags.push('disclaimer_evasion');
      severity = Math.min(severity, 0.4);
      break;
    }
  }

  return flags.length === 0 ? null : { agentName: proposal.agentName, flags: flags, severityMultiplier: severity };
}

// -----------------------------------------------------------------------------
// Synthesis intelligence — who to trust, and how to settle each conflict
// -----------------------------------------------------------------------------

/**
 * Authority of each agent in the final round, highest first.
 *
 * finalProposals: [{ agentName, subTaskId, confidence }]
 * statsOf(agentName, subTaskId): what this machine learned about the agent:
 *   { sessions, avgQuality, successRate, capability, capabilityQuality, capabilitySamples }
 * options: { outliers, challengeEngagement, domainFlags }
 *
 * Score = success rate (smoothed, 30%) + average quality (20%) + success rate
 * (15%) + calibration (15%, or 12% with a tribunal) + consistency across rounds
 * (10% / 8%) + quality on this capability (10%) + engagement with the tribunal
 * (5%, only when there was one). Then: x0.7 with fewer than 5 sessions, x0.85
 * outside the consensus cluster, x the domain penalty when flagged.
 */
function gethComputeAuthorityRankings(finalProposals, statsOf, options) {
  options = options || {};
  var outliers = options.outliers || [];
  var engagementOf = options.challengeEngagement || {};
  var domainFlags = options.domainFlags || [];
  var hasTribunal = Object.keys(engagementOf).length > 0;

  var scored = finalProposals.map(function(p) {
    var stats = statsOf(p.agentName, p.subTaskId) || {};
    var sessions = stats.sessions || 0;
    var avgQuality = sessions > 0 ? stats.avgQuality : 0.5;
    var successRate = sessions > 0 ? stats.successRate : 0.5;
    var successes = Math.round(successRate * sessions);
    // Mean of Beta(successes + 1, failures + 1): 0.5 with no history.
    var thompson = (successes + 1) / (sessions + 2);
    var calibrationError = sessions > 0 ? Math.abs(p.confidence - avgQuality) : 0.5;
    var calibration = 1 - Math.min(1, calibrationError);
    var consistency = typeof stats.consistency === 'number' ? stats.consistency : 0.5;
    var capabilityQuality = stats.capabilitySamples > 0 ? stats.capabilityQuality : 0.5;
    var engagement = typeof engagementOf[p.agentName] === 'number' ? engagementOf[p.agentName] : 0.5;

    var score = hasTribunal
      ? 0.30 * thompson + 0.20 * avgQuality + 0.15 * successRate + 0.12 * calibration +
        0.08 * consistency + 0.10 * capabilityQuality + 0.05 * engagement
      : 0.30 * thompson + 0.20 * avgQuality + 0.15 * successRate + 0.15 * calibration +
        0.10 * consistency + 0.10 * capabilityQuality;

    if (sessions < 5) score *= 0.7;
    var isOutlier = outliers.indexOf(p.agentName) !== -1;
    if (isOutlier) score *= 0.85;
    for (var f = 0; f < domainFlags.length; f++) {
      if (domainFlags[f].agentName === p.agentName) { score *= domainFlags[f].severityMultiplier; break; }
    }

    var calibrationLabel = sessions === 0 || calibrationError <= 0.15 ? 'well-calibrated'
      : (p.confidence > avgQuality + 0.15 ? 'overconfident' : 'underconfident');

    return {
      agentName: p.agentName,
      authorityScore: Math.round(score * 100) / 100,
      tier: 'novice',
      rank: 0,
      tasksCompleted: sessions,
      calibrationLabel: calibrationLabel,
      isOutlier: isOutlier,
      capability: stats.capability || 'general',
    };
  });

  // Ties keep the order of the proposals: Array.prototype.sort is stable.
  scored.sort(function(a, b) { return b.authorityScore - a.authorityScore; });
  for (var i = 0; i < scored.length; i++) {
    scored[i].rank = i + 1;
    var percentile = i / scored.length;
    scored[i].tier = percentile < 0.25 ? 'expert' : (percentile < 0.50 ? 'proficient' : (percentile < 0.75 ? 'standard' : 'novice'));
  }
  return scored;
}

/** How the synthesis should treat the proposals, from the last convergence measurement. */
function gethDetermineSynthesisStrategy(lastConvergence) {
  if (!lastConvergence) return 'authority_weighted';
  var effective = lastConvergence.effectiveConvergence;
  var complementarity = lastConvergence.complementarityScore || 0;
  var contradictions = lastConvergence.contradictionScore || 0;
  if (complementarity > 0.6 && contradictions < 0.2) return 'complementary_merge';
  if (effective < 0.4 && contradictions > 0.3) return 'cluster_mediated';
  if ((lastConvergence.consensusStrength || 0) > 0.5 || effective > 0.5) return 'authority_weighted';
  return contradictions > 0.15 ? 'cluster_mediated' : 'authority_weighted';
}

/**
 * Kind of disagreement between two answers, from their wording.
 * The order of the checks is a policy: evidence first (two answers on the same
 * data share vocabulary and would otherwise look like anything else), then
 * values, then method, and scope last (little shared vocabulary).
 */
function gethClassifyConflictType(contentA, contentB) {
  var a = String(contentA || '').toLowerCase();
  var b = String(contentB || '').toLowerCase();
  function count(text, regex) { return gethCountStemMatches(text, regex); }

  var evidence = /\b(data|evidence|study|research|experiment|survey|statistic|measure|benchmark|metric|result|finding|paper|source|cited|according to|dati|evidenz|studio|ricerca|statistic|misur|risultat|fonte)\b/gi;
  var evidenceA = count(a, evidence);
  var evidenceB = count(b, evidence);
  var conditionals = /\b(?:if|se)\b.{5,60}\b(?:then|allora)\b/gi;
  if ((evidenceA >= 3 && evidenceB >= 2) || (evidenceB >= 3 && evidenceA >= 2) ||
      (gethCountMatches(a, conditionals) >= 2 && gethCountMatches(b, conditionals) >= 2)) return 'empirical';

  var cost = /\b(cost|budget|price|expens|cheap|afford|roi|margin|prezz|spes|economic)\b/gi;
  var quality = /\b(safety|security|quality|reliab|robust|resilien|complian|sicurezz|qualit|affidabil|conformit)\b/gi;
  var costA = count(a, cost);
  var costB = count(b, cost);
  var qualityA = count(a, quality);
  var qualityB = count(b, quality);
  // One side argues from cost, the other from safety or quality.
  if ((costA > 2 && qualityB > 2 && costA > qualityA) || (costB > 2 && qualityA > 2 && costB > qualityB)) return 'values';

  var modals = /\b(should|must|ought|need to|have to|prefer|prioritize|dovrebbe|deve|bisogna|preferibile|priorit)\b/gi;
  var values = /\b(trade.?off|ethic|moral|fairness|equity|cost.?benefit|risk.?appetite|acceptable|stakeholder|impact|harm|benefit|etic|equit|accettabil|impatto|danno|beneficio)\b/gi;
  if ((count(a, modals) >= 3 || count(b, modals) >= 3) && (count(a, values) >= 2 || count(b, values) >= 2)) return 'values';

  var method = /\b(framework|approach|methodology|paradigm|model|technique|strategy|architecture|pattern|design|method|algorithm|process|approccio|metodolog|modello|tecnica|strategia|architettura|metodo|processo)\b/gi;
  if (count(a, method) >= 2 && count(b, method) >= 2) return 'methodological';

  var wordsA = new Set(a.split(/\s+/).filter(function(w) { return w.length > 4; }));
  var wordsB = new Set(b.split(/\s+/).filter(function(w) { return w.length > 4; }));
  var shared = 0;
  wordsA.forEach(function(w) { if (wordsB.has(w)) shared++; });
  var union = wordsA.size + wordsB.size - shared;
  if ((union > 0 ? shared / union : 0) < 0.15) return 'scope';

  if (evidenceA >= 2 || evidenceB >= 2) return 'empirical';
  return 'unknown';
}

var GETH_CONFLICT_RESOLUTION_POLICY = {
  empirical: 'EVIDENCE COMPARISON: cite the strongest evidence from each side. Prefer verifiable, quantified claims. If evidence is missing, explicitly state what data would resolve this.',
  methodological: 'CONTEXT FIT: acknowledge both frameworks, then explain which one fits THIS specific context better and why. Do NOT default to authority ranking.',
  values: 'TRANSPARENT TRADE-OFF: present BOTH priorities explicitly. Do NOT silently resolve by authority. State the trade-off and let the reader see both sides. This is NOT a resolvable disagreement.',
  scope: 'INTEGRATE: these agents likely address different aspects. Merge both perspectives into a comprehensive answer rather than choosing one.',
  unknown: 'AUTHORITY-WEIGHTED: use agent authority ranking to prioritize.',
};

var GETH_SYNTHESIS_STRATEGY_LABELS = {
  authority_weighted: 'AUTHORITY-WEIGHTED (strong consensus, data-driven meritocracy)',
  cluster_mediated: 'CLUSTER-MEDIATED (low convergence, real conflicts present)',
  complementary_merge: 'COMPLEMENTARY-MERGE (agents cover different sub-tasks)',
};

/**
 * The block of facts the synthesizer reads before the proposals: strategy,
 * convergence, authority table, who covers which sub-task, and the conflicts
 * with the policy to settle each.
 */
function gethBuildIntelligenceBlock(view) {
  function pct(v) { return ((v || 0) * 100).toFixed(0); }
  var lines = ['=== SYNTHESIS INTELLIGENCE ===', 'STRATEGY: ' + GETH_SYNTHESIS_STRATEGY_LABELS[view.strategy]];

  var last = view.lastConvergence;
  if (last) {
    var velocity = typeof last.trajectoryVelocity === 'number'
      ? ' ' + (last.trajectoryVelocity >= 0 ? '+' : '') + (last.trajectoryVelocity * 100).toFixed(1) + '%/round' : '';
    lines.push('CONVERGENCE: ' + pct(last.effectiveConvergence) + '% effective (raw: ' + pct(last.convergence) +
      '%, trajectory: ' + (last.trajectoryTrend || 'unknown') + velocity + ')');
    var outliers = last.outlierAgents || [];
    lines.push('CONSENSUS: strength ' + pct(last.consensusStrength) + '%' +
      (outliers.length > 0 ? ', ' + outliers.length + ' outlier' + (outliers.length > 1 ? 's' : '') + ' [' + outliers.join(', ') + ']' : ''));
    lines.push('COMPLEMENTARITY: ' + pct(last.complementarityScore) + '%, CONTRADICTIONS: ' + pct(last.contradictionScore) +
      '% (' + view.realConflicts.length + ' real conflict' + (view.realConflicts.length !== 1 ? 's' : '') + ')');
  }

  lines.push('', 'AGENT AUTHORITY:');
  view.authorityRankings.forEach(function(a) {
    var flag = null;
    for (var f = 0; f < view.domainFlags.length; f++) {
      if (view.domainFlags[f].agentName === a.agentName) { flag = view.domainFlags[f]; break; }
    }
    lines.push('#' + a.rank + ' ' + a.agentName.toUpperCase().padEnd(14) + ' ' + ('[' + a.authorityScore.toFixed(2) + ']').padEnd(7) + ' ' +
      a.tier.padEnd(10) + ' | ' + a.capability + ', ' + a.tasksCompleted + ' tasks, ' + a.calibrationLabel +
      (a.isOutlier ? ' [outlier]' : '') + (flag ? ' [LOW_DOMAIN_RELEVANCE: ' + flag.flags.join(', ') + ']' : ''));
  });

  if (view.subTaskCoverage.length > 0 && view.subTaskCoverage.length <= 12) {
    lines.push('', 'SUB-TASK COVERAGE:');
    view.subTaskCoverage.forEach(function(st) {
      lines.push('[P' + st.priority + '] "' + st.taskDescription + '" -> ' + st.bestAgent.toUpperCase() +
        ' (' + st.bestAgentTier + ', authority ' + st.bestAgentScore.toFixed(2) + ')');
    });
  }

  if (view.realConflicts.length > 0) {
    lines.push('', 'REAL CONFLICTS (with resolution policy):');
    view.realConflicts.forEach(function(rc) {
      lines.push('- [' + rc.conflictType.toUpperCase() + '] ' + rc.agents[0].toUpperCase() + ' vs ' + rc.agents[1].toUpperCase() +
        ' on "' + rc.subTask + '": similarity ' + pct(rc.similarity) + '% (authority: ' + rc.preferredAgent.toUpperCase() + ' ' +
        rc.preferredScore.toFixed(2) + ' vs ' + rc.otherScore.toFixed(2) + ')');
      lines.push('  RESOLUTION POLICY: ' + GETH_CONFLICT_RESOLUTION_POLICY[rc.conflictType]);
    });
  }
  return lines.join('\n');
}

var GETH_SYNTHESIS_ANTI_META =
  'ABSOLUTE PROHIBITION — ANTI-META-ANALYSIS:\n' +
  'Your output MUST be a DIRECT ANSWER to the user\'s original prompt. You are writing for the END USER, not for internal review.\n' +
  'NEVER do ANY of the following:\n' +
  '- NEVER mention agent names (e.g., "Scheherazade argues...", "According to Logos...")\n' +
  '- NEVER organize sections by agent name (e.g., "### Agent X", "### Agent Y")\n' +
  '- NEVER include sections titled "Punti di Disaccordo", "Tensioni Irrisolte", "Disaccordi principali", "Accordi principali", "Framework di Analisi Incompatibili", or any variation\n' +
  '- NEVER discuss the deliberation process, convergence trajectory, or how agents agreed/disagreed\n' +
  '- NEVER compare "frameworks" or "analytical approaches" used by different agents\n' +
  '- NEVER produce a meta-analysis of what different sources said — produce THE ANSWER\n' +
  'Your output must read as if written by a SINGLE expert author. The user must NOT be able to tell that multiple agents contributed.\n' +
  'The ONLY exception is a brief "Deliberation Notes" section at the very end (after the complete answer), which may summarize key insights from the multi-agent process.\n';

/**
 * System prompt of the synthesizer. When one agent clearly leads (authority at
 * least 0.70 and 0.10 above the second) its proposal is the skeleton and the
 * others cross-validate it; otherwise every proposal is weighed by authority.
 */
function gethBuildIntelligentSynthesisPrompt(intelligenceBlock, authorityRankings, lang) {
  var head = 'You are the Geth Consensus Synthesizer. Your mission is to produce an answer that is DEMONSTRABLY SUPERIOR to any single agent\'s proposal by performing genuine intellectual synthesis.\n' +
    gethBuildLanguageDirective(lang) + '\n' +
    'OUTPUT FORMAT: Write your answer in clean, well-structured Markdown. Use headings (##, ###), bullet points, numbered lists, bold, and code blocks as appropriate. Do NOT wrap your response in JSON, do NOT use ```json blocks, do NOT output structured metadata. Your output must be a readable Markdown document, not data.\n\n' +
    GETH_SYNTHESIS_ANTI_META + '\n' + intelligenceBlock + '\n\n';
  var factRule = 'FACT-CHECK NOTES: when the research ends with a fact-check section, do not repeat a claim marked "doubtful" or "unsupported" as established fact, and resolve or openly state every claim marked "contradicted".';
  var closing = 'Include a brief "Deliberation Notes" section at the very end with: key agreements, key disagreements, confidence distribution, and convergence trajectory. This section must NOT reference agent names.';
  var conflictRule = 'CONFLICT-TYPE AWARE RESOLUTION: The intelligence block classifies each conflict by type (EMPIRICAL, METHODOLOGICAL, VALUES, SCOPE). Follow the RESOLUTION POLICY for each type. Do NOT apply authority-weighted resolution to VALUES conflicts — present trade-offs transparently instead.';

  var top = authorityRankings[0];
  var second = authorityRankings[1];
  var dominance = !!(top && second && top.authorityScore >= 0.70 && (top.authorityScore - second.authorityScore) >= 0.10);

  if (dominance) {
    return head +
      'SYNTHESIS MODE: AUTHORITY-GUIDED CROSS-VALIDATION\n' +
      'The highest-authority proposal should be used as the structural foundation, but your job is to IMPROVE upon it — not merely copy it.\n\n' +
      'SYNTHESIS RULES:\n' +
      '1. Use the highest-authority proposal as the structural skeleton — adopt its organization and primary reasoning. But do NOT stop there.\n' +
      '2. CROSS-VALIDATE every major claim against the other proposals. When multiple sources agree with evidence, state this as high-confidence. When they disagree, investigate WHY and present the stronger reasoning.\n' +
      '3. FILL GAPS: For every sub-task, check if ANY other proposal covers an aspect that the primary missed. Integrate these unique contributions.\n' +
      '4. STRENGTHEN with specifics: When the primary makes a general claim and another proposal provides specific data, examples, code, or references — incorporate those specifics.\n' +
      '5. SYNTHESIZE NOVEL INSIGHTS: Look for connections ACROSS proposals that no single source made. Connect security risks with architecture proposals, cost concerns with technical solutions, etc.\n' +
      '6. RESOLVE CONTRADICTIONS with evidence: When proposals disagree, examine their reasoning chains and determine which argument is more substantiated. Present the resolution with justification.\n' +
      '7. CALIBRATION-AWARE: Proposals marked "overconfident" may overstate certainty — verify against others. Proposals marked "well-calibrated" are reliable.\n' +
      '8. DEPTH ESCALATION: Go DEEPER than any individual proposal. Cover ALL sub-tasks at the depth of the BEST coverage of each.\n' +
      '9. ' + conflictRule + '\n' +
      '10. ' + factRule + '\n' +
      '11. ' + closing;
  }

  return head +
    'SYNTHESIS PRINCIPLES:\n' +
    '1. AUTHORITY-WEIGHTED CROSS-VALIDATION: Weight each contribution by its authority score, but CROSS-VALIDATE claims across sources. Higher authority means more trust, but corroboration from multiple sources is stronger than any single authority.\n' +
    '2. COMPLEMENTARY STRENGTH EXTRACTION: Each proposal comes from a specialist. Extract the BEST part of each proposal for their area of expertise. The synthesis must be stronger than any individual because it combines domain expertise.\n' +
    '3. GAP DETECTION: For each sub-task in the original prompt, verify that at LEAST one source addresses it thoroughly. If none does, synthesize from partial coverage. Flag uncovered areas explicitly.\n' +
    '4. NOVEL CROSS-CONNECTIONS: The highest value of multi-source synthesis is insights that emerge from COMBINING perspectives. Connect risks with mitigations, costs with benefits, theory with practice.\n' +
    '5. CONTRADICTION RESOLUTION: When sources disagree, examine evidence quality. Present the stronger argument as primary and the weaker as an alternative perspective — with justification for the ranking.\n' +
    '6. DEPTH ESCALATION: Go DEEPER than any individual proposal. Cover ALL sub-tasks at the maximum depth available from any source.\n' +
    '7. CALIBRATION AWARENESS: Sources marked "overconfident" tend to overstate certainty — verify their claims against others. Sources marked "well-calibrated" are trustworthy self-assessors.\n' +
    '8. SPECIFICITY PRIORITY: When one source gives a general recommendation and another gives specifics (code, numbers, references, CVE IDs, legal citations), ALWAYS prefer the specific version in the synthesis.\n' +
    '9. LATER ROUNDS PREFERRED: Mediated/refined proposals incorporate cross-reading and are more informed than initial proposals.\n' +
    '10. COGNITIVE DIVERSITY: Cross-provider agreement (e.g., Anthropic + OpenAI + Gemini all agree) is especially strong evidence. Highlight these convergence points.\n' +
    '11. ' + conflictRule + '\n' +
    '12. ' + factRule + '\n' +
    '13. ' + closing;
}

// -----------------------------------------------------------------------------
// Convergence engine — six layers, same thresholds the server used
// -----------------------------------------------------------------------------

function gethCosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  var dot = 0;
  var magA = 0;
  var magB = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  var mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

/** Whitespace-token Jaccard, used when no embeddings are available. */
function gethTokenJaccard(a, b) {
  var setA = new Set(String(a).toLowerCase().split(/\s+/));
  var setB = new Set(String(b).toLowerCase().split(/\s+/));
  var intersection = 0;
  setA.forEach(function(w) { if (setB.has(w)) intersection++; });
  var union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Layer 1 — NxN pairwise similarity matrix with its statistics.
 * similarityOf(i, j) gives the similarity of two proposals; a pair below
 * divergenceThreshold is listed as divergent.
 */
function gethBuildSimilarityMatrix(agentNames, similarityOf, divergenceThreshold) {
  var n = agentNames.length;
  var matrix = [];
  for (var r = 0; r < n; r++) {
    matrix.push(new Array(n).fill(0));
  }
  var pairScores = [];
  var divergentPairs = [];
  var sims = [];
  var total = 0;
  var minSim = 1;
  var maxSim = 0;

  for (var i = 0; i < n; i++) {
    matrix[i][i] = 1.0;
    for (var j = i + 1; j < n; j++) {
      var sim = similarityOf(i, j);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
      pairScores.push({ agents: [agentNames[i], agentNames[j]], similarity: sim });
      sims.push(sim);
      total += sim;
      if (sim < minSim) minSim = sim;
      if (sim > maxSim) maxSim = sim;
      if (sim < divergenceThreshold) divergentPairs.push([agentNames[i], agentNames[j]]);
    }
  }

  var mean = sims.length > 0 ? total / sims.length : 1.0;
  var variance = 0;
  for (var s = 0; s < sims.length; s++) variance += (sims[s] - mean) * (sims[s] - mean);
  variance = variance / Math.max(sims.length, 1);

  return {
    matrix: matrix,
    agentNames: agentNames,
    mean: mean,
    min: sims.length > 0 ? minSim : 1.0,
    max: sims.length > 0 ? maxSim : 1.0,
    stdDev: Math.sqrt(variance),
    pairScores: pairScores,
    divergentPairs: divergentPairs,
  };
}

/**
 * Layer 2 — complementarity versus contradiction.
 * Agents on DIFFERENT sub-tasks with low similarity are complementary (good).
 * Agents on the SAME sub-task with low similarity contradict each other (bad).
 */
function gethDetectComplementarity(subTaskMapping, matrix) {
  var realConflicts = [];
  var sameTaskDivergence = 0;
  var sameTaskCount = 0;
  var diffTaskDivergence = 0;
  var diffTaskCount = 0;

  for (var i = 0; i < matrix.pairScores.length; i++) {
    var pair = matrix.pairScores[i];
    var taskA = subTaskMapping[pair.agents[0]];
    var taskB = subTaskMapping[pair.agents[1]];
    if (taskA && taskB && taskA === taskB) {
      sameTaskCount++;
      if (pair.similarity < 0.6) {
        sameTaskDivergence++;
        realConflicts.push({ agents: pair.agents, subTask: taskA, similarity: pair.similarity });
      }
    } else {
      diffTaskCount++;
      if (pair.similarity < 0.5) diffTaskDivergence++;
    }
  }

  var complementarityScore = diffTaskCount > 0 ? diffTaskDivergence / diffTaskCount : 0;
  var contradictionScore = sameTaskCount > 0 ? sameTaskDivergence / sameTaskCount : 0;
  // Complementarity adds up to 30%, contradiction removes up to 20%.
  var effectiveConvergence = Math.max(0, Math.min(1,
    matrix.mean + complementarityScore * 0.3 - contradictionScore * 0.2));

  return {
    complementarityScore: complementarityScore,
    contradictionScore: contradictionScore,
    effectiveConvergence: effectiveConvergence,
    realConflicts: realConflicts,
  };
}

/** Layer 3 — trend of convergence across rounds. */
function gethAnalyzeTrajectory(history) {
  var values = history.map(function(h) {
    return h.effectiveConvergence !== undefined && h.effectiveConvergence !== null ? h.effectiveConvergence : h.convergence;
  });
  if (values.length < 2) {
    return {
      trend: 'insufficient', velocity: 0, acceleration: 0, shouldContinue: true, plateauRounds: 0,
      estimatedFinalConvergence: values.length === 1 ? values[0] : 0, history: values,
    };
  }

  var last = values.length - 1;
  var velocity = values[last] - values[last - 1];
  var acceleration = values.length >= 3
    ? (values[last] - values[last - 1]) - (values[last - 1] - values[last - 2]) : 0;

  // Plateau: change below 2% for consecutive rounds, counted from the end.
  var plateauRounds = 0;
  for (var i = last; i >= 1; i--) {
    if (Math.abs(values[i] - values[i - 1]) < 0.02) plateauRounds++;
    else break;
  }

  var signChanges = 0;
  for (var k = 2; k < values.length; k++) {
    var prevDelta = values[k - 1] - values[k - 2];
    var currDelta = values[k] - values[k - 1];
    if ((prevDelta > 0.01 && currDelta < -0.01) || (prevDelta < -0.01 && currDelta > 0.01)) signChanges++;
  }

  var trend;
  if (plateauRounds >= 2) trend = 'plateau';
  else if (signChanges >= 2) trend = 'oscillating';
  else if (velocity > 0.03) trend = 'improving';
  // A dip smaller than 5% is normal noise in early rounds, not a decline.
  else if (velocity < -0.05) trend = 'declining';
  else trend = 'plateau';

  return {
    trend: trend,
    velocity: velocity,
    acceleration: acceleration,
    shouldContinue: trend === 'improving' || trend === 'oscillating',
    plateauRounds: plateauRounds,
    estimatedFinalConvergence: Math.max(0, Math.min(1, values[last] + velocity)),
    history: values,
  };
}

/** Layer 4 — agreement between confident agents weighs more. */
function gethQualityWeightedConvergence(matrix, qualityWeights) {
  var weightedSum = 0;
  var weightSum = 0;
  for (var i = 0; i < matrix.pairScores.length; i++) {
    var pair = matrix.pairScores[i];
    var wA = qualityWeights[pair.agents[0]] !== undefined ? qualityWeights[pair.agents[0]] : 0.5;
    var wB = qualityWeights[pair.agents[1]] !== undefined ? qualityWeights[pair.agents[1]] : 0.5;
    weightedSum += pair.similarity * wA * wB;
    weightSum += wA * wB;
  }
  return weightSum > 0 ? weightedSum / weightSum : matrix.mean;
}

/**
 * Layer 6 — complete-linkage clusters: an agent joins a cluster only when it is
 * similar enough to ALL of its members. Agents in no cluster are outliers.
 */
function gethDetectConsensusClusters(matrix, threshold) {
  var n = matrix.agentNames.length;
  var visited = {};
  var clusters = [];

  for (var i = 0; i < n; i++) {
    if (visited[i]) continue;
    var cluster = [i];
    visited[i] = true;
    for (var j = i + 1; j < n; j++) {
      if (visited[j]) continue;
      var allAbove = cluster.every(function(k) { return matrix.matrix[k][j] >= threshold; });
      if (allAbove) {
        cluster.push(j);
        visited[j] = true;
      }
    }
    if (cluster.length >= 2) {
      var internalSum = 0;
      var internalCount = 0;
      for (var a = 0; a < cluster.length; a++) {
        for (var b = a + 1; b < cluster.length; b++) {
          internalSum += matrix.matrix[cluster[a]][cluster[b]];
          internalCount++;
        }
      }
      clusters.push({
        agents: cluster.map(function(idx) { return matrix.agentNames[idx]; }),
        meanInternalSimilarity: internalCount > 0 ? internalSum / internalCount : 1,
      });
    }
  }

  var clustered = {};
  clusters.forEach(function(c) { c.agents.forEach(function(name) { clustered[name] = true; }); });
  var outliers = matrix.agentNames.filter(function(name) { return !clustered[name]; });
  clusters.sort(function(x, y) { return y.agents.length - x.agents.length; });

  return {
    clusters: clusters,
    outliers: outliers,
    consensusStrength: clusters.length > 0 ? clusters[0].agents.length / n : 0,
  };
}

/** Layer 5 — whether another round is worth its tokens, and in which mode. */
function gethDecideNextRound(ctx) {
  var trajectory = ctx.trajectory;
  var complementarity = ctx.complementarity;
  var effective = ctx.effectiveConvergence;
  var clusters = ctx.clusters;
  var round = ctx.currentRound;
  var agentCount = ctx.agentCount;
  var crq = ctx.challengeResponseQuality;
  function pct(v) { return (v * 100).toFixed(0); }
  function stop(reason, benefit) {
    return { shouldContinue: false, mode: 'skip', reason: reason, estimatedBenefit: benefit || 0, costEstimate: 0 };
  }

  if (round >= ctx.maxRounds) return stop('max rounds reached');

  if (trajectory.trend === 'plateau' && trajectory.plateauRounds >= 2) {
    return stop('convergence plateau at ' + pct(effective) + '% for ' + trajectory.plateauRounds + ' rounds');
  }

  if (trajectory.trend === 'declining') {
    var steepDecline = trajectory.velocity < -0.10;
    if ((effective > 0.80 && round >= 3) || steepDecline) {
      return stop('convergence declining (velocity: ' + (trajectory.velocity * 100).toFixed(1) + '%' +
        (steepDecline ? ', steep decline' : '') + ')');
    }
    return {
      shouldContinue: true, mode: 'targeted_mediation',
      reason: 'convergence dipped (' + (trajectory.velocity * 100).toFixed(1) + '%) at ' + pct(effective) +
        '% — round ' + (round + 1) + ' to recover',
      estimatedBenefit: Math.abs(trajectory.velocity), costEstimate: agentCount * 2500,
    };
  }

  if (complementarity.complementarityScore > 0.7 && complementarity.contradictionScore < 0.1 && effective > 0.65) {
    return stop('high complementarity (' + pct(complementarity.complementarityScore) +
      '%) with no contradictions — productive division of labor', 0.02);
  }

  if (complementarity.realConflicts.length > 0 && complementarity.contradictionScore > 0.3) {
    var conflictSet = {};
    complementarity.realConflicts.forEach(function(c) { c.agents.forEach(function(name) { conflictSet[name] = true; }); });
    var conflictAgents = Object.keys(conflictSet);
    return {
      shouldContinue: true, mode: 'targeted_mediation',
      reason: complementarity.realConflicts.length + ' real contradiction(s) on same sub-tasks',
      estimatedBenefit: 0.15, costEstimate: conflictAgents.length * 2000, targetAgents: conflictAgents,
    };
  }

  if (clusters.consensusStrength > 0.8 && clusters.outliers.length > 0 && clusters.outliers.length <= 2) {
    return {
      shouldContinue: true, mode: 'targeted_mediation',
      reason: 'strong consensus cluster (' + pct(clusters.consensusStrength) + '%) with ' + clusters.outliers.length +
        ' outlier(s): ' + clusters.outliers.join(', '),
      estimatedBenefit: 0.10, costEstimate: clusters.outliers.length * 2000, targetAgents: clusters.outliers,
    };
  }

  if (crq && crq.ignoreRate > 0.4 && round <= 3) {
    return {
      shouldContinue: true, mode: 'mandatory',
      reason: 'Tribunal: ' + pct(crq.ignoreRate) + '% of agents ignored challenges — another round needed',
      estimatedBenefit: 0.15, costEstimate: agentCount * 2500,
    };
  }

  if (crq && crq.ritualAcceptRate > 0.5 && round <= 3) {
    return {
      shouldContinue: true, mode: 'targeted_mediation',
      reason: 'Tribunal: ' + pct(crq.ritualAcceptRate) + '% ritual ACCEPTs — agents not genuinely revising',
      estimatedBenefit: 0.10, costEstimate: agentCount * 2000,
    };
  }

  if (trajectory.velocity < 0.03 && round >= 2) {
    return stop('diminishing returns (velocity: ' + (trajectory.velocity * 100).toFixed(1) + '% per round)', trajectory.velocity);
  }

  var divergence = 1 - effective;
  if (divergence > 0.5 && round <= 2) {
    return {
      shouldContinue: true, mode: 'mandatory',
      reason: 'high divergence (' + pct(divergence) + '%) in early round — cross-reading needed',
      estimatedBenefit: 0.20, costEstimate: agentCount * 3000,
    };
  }

  if (trajectory.trend === 'improving') {
    return {
      shouldContinue: true, mode: 'standard',
      reason: 'convergence improving (velocity: +' + (trajectory.velocity * 100).toFixed(1) + '% per round)',
      estimatedBenefit: trajectory.velocity, costEstimate: agentCount * 2500,
    };
  }

  return stop('sufficient effective convergence (' + pct(effective) + '%)');
}

/**
 * Round 1 quality gate — every signal must pass before the forced minimum
 * rounds are skipped. Conservative on purpose.
 */
function gethEvaluateRound1QualityGate(ctx) {
  var complementarity = ctx.complementarity;
  var effective = ctx.effectiveConvergence;
  var clusters = ctx.clusters;
  var crq = ctx.challengeResponseQuality;
  function pct(v) { return (v * 100).toFixed(0); }
  var signals = {
    effectiveConvergence: effective,
    complementarityScore: complementarity.complementarityScore,
    contradictionScore: complementarity.contradictionScore,
    consensusStrength: clusters.consensusStrength,
    outlierCount: clusters.outliers.length,
    tribunalClear: true,
  };
  function keep(reason) { return { shouldSkip: false, reason: reason, signals: signals }; }

  if (effective < 0.70) return keep('convergence too low (' + pct(effective) + '% < 70%)');
  if (complementarity.complementarityScore < 0.60) {
    return keep('low complementarity (' + pct(complementarity.complementarityScore) + '% < 60%) — agents not diversified enough');
  }
  if (complementarity.contradictionScore >= 0.15) {
    return keep('contradictions present (' + pct(complementarity.contradictionScore) + '% >= 15%)');
  }
  if (clusters.consensusStrength < 0.70) {
    return keep('weak consensus cluster (' + pct(clusters.consensusStrength) + '% < 70%)');
  }
  if (clusters.outliers.length > 1) return keep(clusters.outliers.length + ' outliers (max 1 for quality gate)');
  if (crq && (crq.ignoreRate > 0.3 || crq.ritualAcceptRate > 0.4)) {
    signals.tribunalClear = false;
    return keep('Tribunal issues (ignore=' + pct(crq.ignoreRate) + '%, ritual=' + pct(crq.ritualAcceptRate) + '%)');
  }

  return {
    shouldSkip: true,
    reason: 'Round 1 Quality Gate: all signals clear (conv=' + pct(effective) + '%, comp=' +
      pct(complementarity.complementarityScore) + '%, contra=' + pct(complementarity.contradictionScore) +
      '%, consensus=' + pct(clusters.consensusStrength) + '%, outliers=' + clusters.outliers.length + ')',
    signals: signals,
  };
}

/**
 * The six layers in one call.
 *
 * input: { proposals: [{agentName, subTaskId, content, confidence}], embeddings,
 *          convergenceHistory, currentRound, maxRounds, agentCount,
 *          challengeResponseQuality }
 * With one embedding per proposal the matrix is cosine ('advanced'); without,
 * it is token Jaccard ('jaccard'). CASSANDRA never counts: her output is
 * challenges, not a proposal.
 */
function gethMeasureConvergence(input) {
  var kept = [];
  var keptEmbeddings = [];
  for (var i = 0; i < input.proposals.length; i++) {
    if (input.proposals[i].agentName === 'CASSANDRA') continue;
    kept.push(input.proposals[i]);
    keptEmbeddings.push(input.embeddings ? input.embeddings[i] : undefined);
  }

  var history = input.convergenceHistory || [];
  if (kept.length < 2) {
    return {
      convergence: 1.0,
      method: 'advanced',
      divergentPairs: [],
      complementarity: { complementarityScore: 0, contradictionScore: 0, effectiveConvergence: 1, realConflicts: [] },
      trajectory: gethAnalyzeTrajectory(history),
      qualityWeightedConvergence: 1.0,
      clusters: { clusters: [], outliers: [], consensusStrength: 1 },
      roundDecision: { shouldContinue: false, mode: 'skip', reason: 'fewer than 2 proposals', estimatedBenefit: 0, costEstimate: 0 },
      effectiveConvergence: 1.0,
    };
  }

  var names = kept.map(function(p) { return p.agentName; });
  var hasEmbeddings = keptEmbeddings.every(function(e) { return Array.isArray(e) && e.length > 0; });
  var matrix = hasEmbeddings
    ? gethBuildSimilarityMatrix(names, function(a, b) { return gethCosineSimilarity(keptEmbeddings[a], keptEmbeddings[b]); }, 0.72)
    : gethBuildSimilarityMatrix(names, function(a, b) { return gethTokenJaccard(kept[a].content, kept[b].content); }, 0.3);
  var method = hasEmbeddings ? 'advanced' : 'jaccard';

  var subTaskMapping = {};
  var qualityWeights = {};
  for (var k = 0; k < kept.length; k++) {
    subTaskMapping[kept[k].agentName] = kept[k].subTaskId;
    qualityWeights[kept[k].agentName] = kept[k].confidence;
  }

  var complementarity = gethDetectComplementarity(subTaskMapping, matrix);
  var trajectory = gethAnalyzeTrajectory(history.concat([{
    round: input.currentRound,
    convergence: matrix.mean,
    effectiveConvergence: complementarity.effectiveConvergence,
  }]));
  var clusters = gethDetectConsensusClusters(matrix, 0.65);
  var roundDecision = gethDecideNextRound({
    trajectory: trajectory,
    complementarity: complementarity,
    effectiveConvergence: complementarity.effectiveConvergence,
    currentRound: input.currentRound,
    maxRounds: input.maxRounds,
    agentCount: input.agentCount,
    clusters: clusters,
    challengeResponseQuality: input.challengeResponseQuality,
  });

  return {
    convergence: matrix.mean,
    method: method,
    divergentPairs: matrix.divergentPairs,
    complementarity: complementarity,
    trajectory: trajectory,
    qualityWeightedConvergence: gethQualityWeightedConvergence(matrix, qualityWeights),
    clusters: clusters,
    roundDecision: roundDecision,
    effectiveConvergence: complementarity.effectiveConvergence,
  };
}

// -----------------------------------------------------------------------------
// Tribunal metrics — did the agents really answer CASSANDRA's challenges?
// -----------------------------------------------------------------------------

/** Words longer than 3 characters, as a Set. */
function gethLongWordSet(text) {
  return new Set(String(text || '').toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; }));
}

function gethLongWordJaccard(a, b) {
  var w1 = gethLongWordSet(a);
  var w2 = gethLongWordSet(b);
  if (w1.size === 0 && w2.size === 0) return 1;
  var intersection = 0;
  w1.forEach(function(w) { if (w2.has(w)) intersection++; });
  var union = w1.size + w2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

var GETH_TOP_TERM_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'will', 'have', 'been',
  'would', 'could', 'should', 'which', 'their', 'they', 'them', 'than', 'also',
  'into', 'more', 'some', 'other', 'each', 'such', 'when', 'what', 'about',
  'through', 'between', 'after', 'before', 'these', 'those', 'only', 'over',
]);

function gethTopTerms(text, n) {
  var freq = {};
  var words = String(text || '').toLowerCase().split(/\s+/);
  for (var i = 0; i < words.length; i++) {
    if (words[i].length > 3 && !GETH_TOP_TERM_STOPWORDS.has(words[i])) freq[words[i]] = (freq[words[i]] || 0) + 1;
  }
  return Object.keys(freq).sort(function(a, b) { return freq[b] - freq[a]; }).slice(0, n);
}

/**
 * How much a revision changed: word delta and overlap of the ten most frequent
 * terms. Many changed words around the same concepts is a cosmetic rewrite.
 */
function gethValidateRevisionSubstance(round1, round2) {
  var jaccardDelta = 1 - gethLongWordJaccard(round1, round2);
  var top1 = gethTopTerms(round1, 10);
  var top2 = gethTopTerms(round2, 10);
  var conceptOverlap = top1.length > 0
    ? top1.filter(function(t) { return top2.indexOf(t) !== -1; }).length / top1.length : 1;
  return { jaccardDelta: jaccardDelta, conceptOverlap: conceptOverlap, isCosmetic: jaccardDelta > 0.15 && conceptOverlap > 0.80 };
}

function gethPairwiseJaccardVariance(texts) {
  if (texts.length < 2) return 0;
  var sims = [];
  for (var i = 0; i < texts.length; i++) {
    for (var j = i + 1; j < texts.length; j++) sims.push(gethLongWordJaccard(texts[i], texts[j]));
  }
  var mean = sims.reduce(function(s, v) { return s + v; }, 0) / sims.length;
  return sims.reduce(function(s, v) { return s + (v - mean) * (v - mean); }, 0) / sims.length;
}

function gethSigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/** The [ACCEPT] / [REBUT] / [MITIGATE] tag an agent gave to one challenge field. */
function gethParseChallengeResponseTag(text, field) {
  var patterns = [
    new RegExp('\\[' + gethEscapeRegex(field) + '[^\\]]*\\][\\s\\S]*?\\[(ACCEPT|REBUT|MITIGATE)\\][:\\s]*([\\s\\S]*?)(?=\\n\\[|$)', 'i'),
    new RegExp('(?:' + gethEscapeRegex(field) + '|weakness|counter|failure|steel)[\\s\\S]*?\\[(ACCEPT|REBUT|MITIGATE)\\][:\\s]*([\\s\\S]*?)(?=\\n\\[|$)', 'i'),
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = String(text || '').match(patterns[i]);
    if (m) return { type: m[1].toUpperCase(), content: (m[2] || '').trim() };
  }
  return { type: 'IGNORED', content: '' };
}

/**
 * Tribunal metrics from the round before the challenges and the round after.
 * Counts the response tags, flags ACCEPTs with no real revision, and classifies
 * the outcome (emergence, covert_leadership, destructive, ritual, mixed).
 */
function gethComputeTribunalMetrics(round1Props, round2Props, challenges) {
  function mean(values, fallback) {
    return values.length > 0 ? values.reduce(function(s, v) { return s + v; }, 0) / values.length : fallback;
  }
  function find(list, name) {
    for (var i = 0; i < list.length; i++) if (list[i].agentName === name) return list[i];
    return null;
  }
  var fieldKeys = [
    ['WEAKNESS', 'weakness'], ['COUNTER-EVIDENCE', 'counterEvidence'], ['FAILURE-SCENARIO', 'failureScenario'],
    ['STEEL-MAN', 'steelMan'], ['LATERAL', 'lateral'], ['WHAT-IF', 'whatIf'],
  ];

  var acceptCount = 0;
  var rebutCount = 0;
  var mitigateCount = 0;
  var ignoredCount = 0;
  var ritualAcceptCount = 0;
  var cosmeticAcceptCount = 0;
  var emptyRebutCount = 0;
  var semanticDeltas = [];

  // Per agent: share of the challenge points it really engaged with (0..1).
  var engagementByAgent = {};

  for (var c = 0; c < challenges.length; c++) {
    var ch = challenges[c];
    var r1 = find(round1Props, ch.targetAgent);
    var r2 = find(round2Props, ch.targetAgent);
    if (!r1 || !r2) continue;
    var substance = gethValidateRevisionSubstance(r1.content, r2.content);
    var points = 0;
    var engaged = 0;

    for (var f = 0; f < fieldKeys.length; f++) {
      if (!ch[fieldKeys[f][1]]) continue;
      points++;
      var resp = gethParseChallengeResponseTag(r2.content, fieldKeys[f][0]);
      if (resp.type === 'ACCEPT') {
        acceptCount++;
        var ritual = gethLongWordJaccard(r1.content, r2.content) > 0.95;
        if (ritual) ritualAcceptCount++;
        if (substance.isCosmetic) cosmeticAcceptCount++;
        if (!ritual && !substance.isCosmetic) engaged++;
      } else if (resp.type === 'REBUT') {
        rebutCount++;
        if (resp.content.length < 50) emptyRebutCount++;
        else engaged++;
      } else if (resp.type === 'MITIGATE') {
        mitigateCount++;
        engaged++;
      } else {
        ignoredCount++;
      }
    }
    if (points > 0) engagementByAgent[ch.targetAgent] = engaged / points;
    semanticDeltas.push(substance.jaccardDelta);
  }

  var meanSemanticDelta = mean(semanticDeltas, 0);
  var r1NonCassandra = round1Props.filter(function(p) { return p.agentName !== 'CASSANDRA'; });
  var r2NonCassandra = round2Props.filter(function(p) { return p.agentName !== 'CASSANDRA'; });
  var r1Contents = r1NonCassandra.map(function(p) { return p.content; });
  var r2Contents = r2NonCassandra.map(function(p) { return p.content; });

  var round1Convergence = r1Contents.length > 1 ? gethLongWordJaccard(r1Contents.join(' '), r1Contents.slice(1).join(' ')) : 0.5;
  var round2Convergence = r2Contents.length > 1 ? gethLongWordJaccard(r2Contents.join(' '), r2Contents.slice(1).join(' ')) : 0.5;
  var convergenceDelta = round2Convergence - round1Convergence;

  var preVariance = gethPairwiseJaccardVariance(r1Contents);
  var postVariance = gethPairwiseJaccardVariance(r2Contents);
  var varianceDelta = postVariance - preVariance;

  var totalFields = acceptCount + rebutCount + mitigateCount + ignoredCount;
  var genuineEngagement = totalFields > 0
    ? (totalFields - ritualAcceptCount - cosmeticAcceptCount - emptyRebutCount) / totalFields : 0.5;
  var acceptRate = (acceptCount + mitigateCount) / (totalFields || 1);

  var scores = {
    emergence: gethSigmoid(meanSemanticDelta * 5) * gethSigmoid(-Math.abs(varianceDelta) * 3) * gethSigmoid(convergenceDelta * 5),
    covert_leadership: gethSigmoid(meanSemanticDelta * 5) * gethSigmoid(-varianceDelta * 5) * gethSigmoid((acceptRate - 0.5) * 5),
    destructive: gethSigmoid(varianceDelta * 5) * gethSigmoid(-convergenceDelta * 5),
    ritual: gethSigmoid(-meanSemanticDelta * 10),
  };
  var topLabel = Object.keys(scores).sort(function(a, b) { return scores[b] - scores[a]; })[0];

  return {
    round1Convergence: round1Convergence,
    round1MeanConfidence: mean(r1NonCassandra.map(function(p) { return typeof p.confidence === 'number' ? p.confidence : 0.7; }), 0.7),
    challengesGenerated: challenges.length,
    challengesParsed: challenges.filter(function(ch2) { return ch2.weakness || ch2.lateral; }).length,
    acceptCount: acceptCount,
    rebutCount: rebutCount,
    mitigateCount: mitigateCount,
    ignoredCount: ignoredCount,
    ritualAcceptCount: ritualAcceptCount,
    cosmeticAcceptCount: cosmeticAcceptCount,
    emptyRebutCount: emptyRebutCount,
    meanSemanticDelta: meanSemanticDelta,
    round2Convergence: round2Convergence,
    round2MeanConfidence: mean(r2NonCassandra.map(function(p) { return typeof p.confidence === 'number' ? p.confidence : 0.7; }), 0.7),
    convergenceDelta: convergenceDelta,
    genuineEngagement: genuineEngagement,
    ignoreRate: totalFields > 0 ? ignoredCount / totalFields : 0,
    ritualAcceptRate: acceptCount > 0 ? ritualAcceptCount / acceptCount : 0,
    engagementByAgent: engagementByAgent,
    divergenceIndex: { preVariance: preVariance, postVariance: postVariance, varianceDelta: varianceDelta },
    emergenceScore: scores.emergence,
    dominanceScore: scores.covert_leadership,
    destructionScore: scores.destructive,
    ritualScore: scores.ritual,
    tribunalOutcome: scores[topLabel] > 0.55 ? topLabel : 'mixed',
  };
}

/**
 * LocalLegionStore — learned state that used to live in the server database.
 * One JSON file, written atomically, private to the user (0600).
 */
class LocalLegionStore {
  constructor(filePath) {
    this.filePath = filePath || LOCAL_GETH_STORE_FILE;
    this.data = { version: 1, agentStats: {}, memories: {}, ensembles: [] };
    try {
      if (fs.existsSync(this.filePath)) {
        var parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          this.data.agentStats = parsed.agentStats || {};
          this.data.memories = parsed.memories || {};
          this.data.ensembles = Array.isArray(parsed.ensembles) ? parsed.ensembles : [];
        }
      }
    } catch (_) {
      // A corrupt store must never stop a deliberation: start from empty state.
    }
  }

  save() {
    var dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    var tmp = this.filePath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  getAgentStats(agentName) {
    return this.data.agentStats[agentName] || { sessions: 0, avgQuality: 0, capabilities: {} };
  }

  /**
   * Fold one finished session into an agent's running averages.
   * A session counts as a success from 70% quality. `consistency` (0..1) is how
   * much of its first answer the agent kept in its last one; omit it when the
   * session had a single round.
   */
  recordAgentOutcome(agentName, capability, quality, consistency) {
    var stats = this.data.agentStats[agentName] || { sessions: 0, avgQuality: 0, capabilities: {} };
    stats.avgQuality = (stats.avgQuality * stats.sessions + quality) / (stats.sessions + 1);
    stats.successes = (stats.successes || 0) + (quality >= 0.7 ? 1 : 0);
    if (typeof consistency === 'number') {
      var seen = stats.consistencySamples || 0;
      stats.consistency = ((stats.consistency || 0) * seen + consistency) / (seen + 1);
      stats.consistencySamples = seen + 1;
    }
    stats.sessions += 1;
    if (capability) {
      var cap = stats.capabilities[capability] || { sampleCount: 0, avgQuality: 0 };
      cap.avgQuality = (cap.avgQuality * cap.sampleCount + quality) / (cap.sampleCount + 1);
      cap.sampleCount += 1;
      stats.capabilities[capability] = cap;
    }
    this.data.agentStats[agentName] = stats;
  }

  getMemories(agentName, limit) {
    var list = this.data.memories[agentName] || [];
    return list.slice(-1 * (limit || 3));
  }

  addMemory(agentName, episodeType, content) {
    var list = this.data.memories[agentName] || [];
    list.push({ episodeType: episodeType, content: String(content).substring(0, 400), at: new Date().toISOString() });
    // Keep the newest 20 per agent: older episodes stop being representative.
    this.data.memories[agentName] = list.slice(-20);
  }

  recordEnsemble(agentSet, capabilitySet, quality) {
    var key = agentSet.slice().sort().join('+');
    var found = null;
    for (var i = 0; i < this.data.ensembles.length; i++) {
      if (this.data.ensembles[i].key === key) { found = this.data.ensembles[i]; break; }
    }
    if (!found) {
      found = { key: key, agentSet: agentSet.slice().sort(), capabilitySet: [], sampleCount: 0, avgQuality: 0 };
      this.data.ensembles.push(found);
    }
    found.avgQuality = (found.avgQuality * found.sampleCount + quality) / (found.sampleCount + 1);
    found.sampleCount += 1;
    var caps = new Set(found.capabilitySet.concat(capabilitySet));
    found.capabilitySet = Array.from(caps).slice(0, 12);
  }

  /** Agent combinations seen at least 3 times with average quality >= 75%. */
  getProvenEnsembles(limit) {
    return this.data.ensembles
      .filter(function(e) { return e.sampleCount >= 3 && e.avgQuality >= 0.75; })
      .sort(function(a, b) { return b.avgQuality - a.avgQuality; })
      .slice(0, limit || 5);
  }
}

/**
 * LocalGethOrchestrator — in-process implementation of the Geth step protocol.
 *
 * It exposes the same methods the client used to call on the server
 * (createGethSession, stepDecompose, stepDecomposeResult, stepRoundStart,
 * stepRoundResult, stepForceTransition, stepSynthesize, stepSynthesizeResult,
 * stepValidate, stepValidateResult, updateClientProgress), so the deliberation
 * loop in runClientOrchestration drives it unchanged.
 */
class LocalGethOrchestrator {
  /**
   * @param llm       LLMProvider used for the orchestrator's own calls
   * @param options   { store, sessionsDir, agentsDir, orchestratorProvider }
   */
  constructor(llm, options) {
    options = options || {};
    this.llm = llm;
    this.store = options.store || new LocalLegionStore();
    this.sessionsDir = options.sessionsDir || LOCAL_GETH_SESSIONS_DIR;
    this.agentsDir = options.agentsDir || AGENTS_DIR;
    this.orchestratorProvider = options.orchestratorProvider || null;
    // Patterns each agent learned from past sessions, injected into its system prompt.
    this.promptEvolver = options.promptEvolver || null;
    this.sessions = new Map();
    this.systemPromptCache = new Map();
  }

  // ---------------------------------------------------------------- catalog

  /** Active agents as { agentName (display, upper case), fileName, category, capabilities, tagline }. */
  getCatalog() {
    return AGENT_CATALOG.map(function(a) {
      return {
        agentName: a.displayName || a.name.toUpperCase(),
        fileName: a.name,
        category: a.category,
        capabilities: a.capabilities || [],
        tagline: a.tagline || '',
        isPrimary: !a.parentAgent,
      };
    });
  }

  getCatalogEntry(agentName) {
    var catalog = this.getCatalog();
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].agentName === agentName) return catalog[i];
    }
    return null;
  }

  /** System prompt of an agent, from its .mjs file, or a catalog-based fallback. */
  async loadAgentSystemPrompt(agentName) {
    if (this.systemPromptCache.has(agentName)) return this.systemPromptCache.get(agentName);
    var entry = this.getCatalogEntry(agentName);
    var prompt = '';
    if (entry) {
      var filePath = path.join(this.agentsDir, entry.fileName + '.mjs');
      if (fs.existsSync(filePath)) {
        try {
          var mod = await import(filePath);
          if (typeof mod.SYSTEM_PROMPT === 'string') prompt = mod.SYSTEM_PROMPT;
        } catch (_) { /* fall back to the catalog description below */ }
      }
    }
    if (!prompt) {
      prompt = 'You are ' + agentName + ', a specialized AI agent in the ' + (entry ? entry.category : 'general') + ' category. ' +
        'Your tagline: "' + (entry && entry.tagline ? entry.tagline : 'Expert analysis') + '". ' +
        'Capabilities: ' + (entry ? entry.capabilities.join(', ') : 'general analysis') + '.';
    }
    this.systemPromptCache.set(agentName, prompt);
    return prompt;
  }

  // --------------------------------------------------------------- sessions

  getSessionOrThrow(sessionId) {
    var session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    return session;
  }

  expectStatus(session, expected) {
    if (session.status !== expected) {
      throw new Error('Session status is ' + session.status + ', expected ' + expected);
    }
  }

  /** Write the session state to disk. A failed write never stops a deliberation. */
  persistSession(session) {
    session.updatedAt = new Date().toISOString();
    try {
      if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
      var file = path.join(this.sessionsDir, session.id + '.json');
      var tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      session.persistError = err.message;
    }
  }

  /** Provider for the orchestrator's own calls: explicit choice, else the first usable one. */
  pickOrchestratorProvider(session) {
    var providers = session.providers;
    if (this.orchestratorProvider && providers.indexOf(this.orchestratorProvider) !== -1) return this.orchestratorProvider;
    return providers[0];
  }

  /**
   * One orchestrator call with provider fallback. Tries the preferred provider,
   * then the others in order; throws the last error when all of them fail.
   */
  async orchestratorChat(session, systemPrompt, userMessage, maxTokens, agentTag) {
    var preferred = this.pickOrchestratorProvider(session);
    var order = [preferred].concat(session.providers.filter(function(p) { return p !== preferred; }));
    var lastErr = null;
    for (var i = 0; i < order.length; i++) {
      try {
        var text = await this.llm.chatWithProvider(order[i], systemPrompt, userMessage, {
          maxTokens: maxTokens, agentTag: agentTag,
        });
        return { text: text, provider: order[i] };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('No provider available for the orchestrator');
  }

  async createGethSession(prompt, config, providerMode, providers, userApiKey, projectContext) {
    if (!prompt || !String(prompt).trim()) throw new Error('Prompt is required');
    if (!Array.isArray(providers) || providers.length === 0) throw new Error('At least one LLM provider is required');

    var session = {
      id: crypto.randomUUID(),
      prompt: String(prompt),
      config: Object.assign({}, LOCAL_GETH_DEFAULT_CONFIG, config || {}),
      providerMode: providerMode || 'single',
      providers: providers.slice(),
      projectContext: projectContext || null,
      status: 'awaiting_decomposition',
      decomposition: null,
      assignments: [],
      prometheusDecision: null,
      proposals: [],
      convergenceHistory: [],
      tribunal: { challenges: [], phaseAAttempts: 0, metrics: null },
      roundsCompleted: 0,
      synthesis: null,
      factCheck: null,
      athena: null,
      result: null,
      progressLog: [],
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };
    this.sessions.set(session.id, session);
    this.persistSession(session);
    return { sessionId: session.id, status: session.status };
  }

  updateClientProgress(sessionId, updates, logEntry) {
    var session = this.sessions.get(sessionId);
    if (!session) return { ok: false };
    if (logEntry) {
      session.progressLog.push({ at: new Date().toISOString(), entry: String(logEntry).substring(0, 2000) });
      if (session.progressLog.length > 500) session.progressLog = session.progressLog.slice(-500);
    }
    if (updates && updates.phase) session.phase = updates.phase;
    return { ok: true };
  }

  // ---------------------------------------------------------- decomposition

  async stepDecompose(sessionId) {
    var session = this.getSessionOrThrow(sessionId);
    this.expectStatus(session, 'awaiting_decomposition');
    var cfg = session.config;

    var catalog = this.getCatalog();
    var byCategory = {};
    for (var i = 0; i < catalog.length; i++) {
      var a = catalog[i];
      if (!byCategory[a.category]) byCategory[a.category] = [];
      byCategory[a.category].push('  - ' + a.fileName + ' (' + a.agentName + ')' + (a.isPrimary ? ' [PRIMARY]' : '') +
        ': ' + a.capabilities.slice(0, 8).join(', '));
    }
    var agentCatalogContext = '\n\nAGENT CATALOG — These are the REAL agents available. Use their EXACT capability names in the "capability" field:\n' +
      Object.keys(byCategory).map(function(cat) { return '[' + cat + ']\n' + byCategory[cat].join('\n'); }).join('\n');

    // History-aware decomposition: what this machine has learned so far.
    var weightContext = '';
    var byCapability = {};
    var store = this.store;
    for (var wi = 0; wi < catalog.length; wi++) {
      var caps = store.getAgentStats(catalog[wi].agentName).capabilities;
      var capNames = Object.keys(caps);
      for (var ci = 0; ci < capNames.length; ci++) {
        var c = caps[capNames[ci]];
        if (c.sampleCount < 3) continue;
        if (!byCapability[capNames[ci]]) byCapability[capNames[ci]] = [];
        byCapability[capNames[ci]].push({ agent: catalog[wi].agentName, quality: c.avgQuality, samples: c.sampleCount });
      }
    }
    var learnedCaps = Object.keys(byCapability);
    if (learnedCaps.length > 0) {
      weightContext = '\n\nAvailable agent expertise:\n' + learnedCaps.map(function(cap) {
        var top = byCapability[cap].sort(function(x, y) { return y.quality - x.quality; }).slice(0, 3);
        return '- ' + cap + ': ' + top.map(function(t) {
          return t.agent + ' (quality: ' + (t.quality * 100).toFixed(0) + '%, samples: ' + t.samples + ')';
        }).join(', ');
      }).join('\n');
    }

    var patternContext = '';
    var patterns = store.getProvenEnsembles(5);
    if (patterns.length > 0) {
      patternContext = '\n\nProven agent combinations:\n' + patterns.map(function(p) {
        return '- ' + p.agentSet.join(' + ') + ' for ' + p.capabilitySet.join(', ') +
          ' (quality: ' + (p.avgQuality * 100).toFixed(0) + '%)';
      }).join('\n');
    }

    var systemPrompt;
    if (cfg.liaraMode) {
      systemPrompt = 'You are a PERSPECTIVE DECOMPOSITION engine for epistemic multi-agent deliberation.\n' +
        'This is a DELIBERATION training prompt — NOT a technical task. Your goal is to create sub-tasks that produce MAXIMALLY DIVERSE analytical perspectives.\n\n' +
        'The prompt may contain [DELIBERATION FRAMEWORK — INCOMPATIBLE PERSPECTIVES] with labeled perspectives (PERSPECTIVE A, B, C, D...).\n' +
        'If perspectives are present: create EXACTLY one sub-task per perspective, using the perspective\'s role as description.\n' +
        'If NO explicit perspectives are found: infer 4-5 fundamentally incompatible analytical frameworks from the question.\n\n' +
        'Each sub-task must have:\n' +
        '- id: unique short identifier (e.g., "t1", "t2")\n' +
        '- description: the PERSPECTIVE to adopt — e.g., "Analyze as an economist focusing on ROI and cost-benefit" or "Analyze as an ethicist focusing on moral frameworks"\n' +
        '- capability: MUST use DIFFERENT capability strings from the AGENT CATALOG for each perspective. This is CRITICAL — every sub-task MUST map to a different agent category to ensure diverse agents.\n' +
        '  Map perspectives to capabilities by analytical style:\n' +
        '  * Quantitative/economic/statistical analysis → "data-analysis" or "system-monitoring"\n' +
        '  * Ethical/moral/philosophical analysis → "content-creation" or "knowledge-synthesis"\n' +
        '  * Technical/engineering/scientific analysis → "code-review" or "architecture-review"\n' +
        '  * Risk/security/adversarial analysis → "security-audit" or "threat-intelligence"\n' +
        '  * Social/political/regulatory analysis → "documentation" or "technical-writing"\n' +
        '  * Environmental/scientific/domain-expert analysis → "performance-optimization" or "system-design"\n' +
        '  * Historical/cultural/comparative analysis → "research" or "compliance-review"\n' +
        '  * Legal/compliance/regulatory analysis → "policy-analysis" or "compliance-review"\n' +
        '  * Practical/operational/applied analysis → "system-monitoring" or "performance-optimization"\n' +
        '- dependsOn: always empty [] — perspectives are INDEPENDENT\n' +
        '- priority: 1 for all (equal weight)\n' +
        '- relevantFiles: always [] (deliberation prompts have no project files)\n\n' +
        'Rules:\n' +
        '- Max ' + cfg.maxAgents + ' sub-tasks (typically 4-6 for deliberation)\n' +
        '- EVERY sub-task MUST have a DIFFERENT capability from the agent catalog — this ensures each perspective gets a DIFFERENT agent\n' +
        '- Do NOT create homogeneous sub-tasks. If you produce 4 tasks all with the same capability, you have FAILED.\n' +
        '- The goal is TENSION between frameworks, not topical coverage\n' +
        '- Each perspective should be self-contained and independently arguable\n\n' +
        'CRITICAL — ANSWER THE ACTUAL QUESTION:\n' +
        'Each perspective sub-task MUST instruct the agent to DIRECTLY ANSWER the user\'s question FROM that perspective.\n' +
        'Example: If the user asks "What is precision agriculture?", a sub-task should say "Explain precision agriculture from an economic ROI perspective, including specific technologies mentioned in the prompt (GPS, sensors, drones) and their cost-benefit analysis."\n' +
        'Do NOT create abstract perspectives that ignore the specific content requested. Every sub-task description MUST reference the specific topics/technologies/entities in the original prompt.\n' +
        agentCatalogContext + '\n\n' +
        'Respond ONLY with valid JSON: {"tasks": [...]}';
    } else {
      systemPrompt = 'You are a task decomposition engine for the Geth Consensus multi-agent system.\n' +
        'Given a user prompt, decompose it into sub-tasks for specialized AI agents.\n\n' +
        'Each sub-task must have:\n' +
        '- id: unique short identifier (e.g., "t1", "t2")\n' +
        '- description: what the agent should do\n' +
        '- capability: MUST be one of the EXACT capability strings from the AGENT CATALOG below (e.g., "penetration-testing", "security-audit", "data-analysis", "blog-writing")\n' +
        '- dependsOn: array of task IDs this depends on (empty if independent)\n' +
        '- priority: 1 (highest) to 5 (lowest)\n' +
        '- relevantFiles: array of file paths from the [FILE INVENTORY] that are most relevant to this task (2-5 files per task). If no project files are available, use an empty array.\n\n' +
        'Rules:\n' +
        '- Max ' + cfg.maxAgents + ' sub-tasks\n' +
        '- CRITICAL: Do NOT over-decompose. Simple, direct questions should produce 2-3 tasks, not 6-8.\n' +
        '  A question like "What is the capital of France?" needs 1 task, not 5.\n' +
        '  A question like "Compare React vs Vue" needs 3-4 tasks, not 8.\n' +
        '  Only complex multi-faceted analysis warrants 5+ tasks.\n' +
        '- Maximize parallel tasks (minimize dependencies)\n' +
        '- CRITICAL: The "capability" field MUST use exact capability names from the agent catalog.\n' +
        '  For security/pentest tasks, use capabilities like "penetration-testing", "offensive-security", "security-audit", "threat-intelligence", "vulnerability-scanning".\n' +
        '  Do NOT invent generic names like "security_analysis" — use the real capability strings.\n' +
        '- When the prompt involves offensive security, pentesting, red-teaming, or attack simulation, include a task with capability "penetration-testing" or "offensive-security".\n' +
        '- Each task should be independently completable\n' +
        '- For each task, reference specific files from the FILE INVENTORY by their exact paths\n' +
        agentCatalogContext + weightContext + patternContext + '\n\n' +
        'Respond ONLY with valid JSON: {"tasks": [...]}';
    }

    var userMessage = session.prompt;
    if (session.projectContext) {
      userMessage += '\n\n' + (typeof session.projectContext === 'string'
        ? session.projectContext : JSON.stringify(session.projectContext));
    }

    // 2048 tokens cut real answers short: eight tasks with detailed descriptions need more.
    return { systemPrompt: systemPrompt, userMessage: userMessage, maxTokens: 4096, temperature: 0.3 };
  }

  /** Normalise the tasks a model returned; throws when there is nothing usable. */
  normalizeDecomposition(decompositionJson) {
    if (!decompositionJson || !Array.isArray(decompositionJson.tasks)) {
      throw new Error('Invalid decomposition format: expected { tasks: [...] }');
    }
    var tasks = [];
    var usedIds = {};
    for (var i = 0; i < decompositionJson.tasks.length; i++) {
      var t = decompositionJson.tasks[i];
      if (!t || typeof t.description !== 'string' || !t.description.trim()) continue;
      var id = typeof t.id === 'string' && t.id.trim() && !usedIds[t.id.trim()] ? t.id.trim() : 't' + (tasks.length + 1);
      usedIds[id] = true;
      var priority = Math.round(Number(t.priority));
      tasks.push({
        id: id,
        description: t.description.trim(),
        capability: typeof t.capability === 'string' && t.capability.trim() ? t.capability.trim() : 'general',
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter(function(d) { return typeof d === 'string'; }) : [],
        priority: isFinite(priority) ? Math.max(1, Math.min(5, priority)) : 3,
        relevantFiles: Array.isArray(t.relevantFiles) ? t.relevantFiles.filter(function(f) { return typeof f === 'string'; }) : [],
      });
    }
    if (tasks.length === 0) throw new Error('Invalid decomposition format: no usable task');
    return { tasks: tasks };
  }

  /**
   * When the prompt lists explicit PERSPECTIVE A/B/C blocks and the model
   * collapsed them into fewer tasks, rebuild one task per perspective.
   */
  enforcePerspectives(session, decomposition) {
    var perspectiveRegex = /PERSPECTIVE\s+([A-Z])\s*[—–-]\s*([^:\n]+):\s*([^\n]+)/g;
    var found = [];
    var m;
    while ((m = perspectiveRegex.exec(session.prompt)) !== null) {
      found.push({ letter: m[1], role: m[2].trim(), instruction: m[3].trim() });
    }
    if (found.length < 2 || decomposition.tasks.length >= found.length) return decomposition;

    var capabilityMap = [
      ['econom', 'data-analysis'], ['finanz', 'data-analysis'], ['quanti', 'data-analysis'],
      ['genetic', 'architecture-review'], ['biolog', 'architecture-review'], ['scient', 'architecture-review'],
      ['tecnic', 'code-review'], ['ingegn', 'system-design'],
      ['giurid', 'compliance-review'], ['giurist', 'compliance-review'], ['legal', 'compliance-review'], ['diritt', 'compliance-review'],
      ['normat', 'policy-analysis'], ['idrolog', 'performance-optimization'], ['ambient', 'performance-optimization'],
      ['ecolog', 'system-monitoring'], ['climat', 'system-monitoring'],
      ['etico', 'content-creation'], ['etica', 'content-creation'], ['filosof', 'knowledge-synthesis'],
      ['social', 'documentation'], ['politic', 'technical-writing'], ['storico', 'research'], ['cultur', 'research'],
      ['sicurez', 'security-audit'], ['rischio', 'threat-intelligence'], ['medic', 'research'],
      ['sanitar', 'documentation'], ['farmac', 'architecture-review'], ['psicolog', 'content-creation'],
      ['pedagog', 'knowledge-synthesis'],
    ];
    var fallbackCaps = [
      'data-analysis', 'architecture-review', 'compliance-review', 'performance-optimization',
      'security-audit', 'content-creation', 'research', 'system-design',
      'knowledge-synthesis', 'documentation', 'technical-writing', 'system-monitoring',
    ];

    var used = {};
    var tasks = [];
    for (var i = 0; i < found.length; i++) {
      var p = found[i];
      var roleLower = p.role.toLowerCase();
      var cap = null;
      for (var k = 0; k < capabilityMap.length; k++) {
        if (roleLower.indexOf(capabilityMap[k][0]) !== -1 && !used[capabilityMap[k][1]]) { cap = capabilityMap[k][1]; break; }
      }
      if (!cap) {
        for (var f = 0; f < fallbackCaps.length; f++) {
          if (!used[fallbackCaps[f]]) { cap = fallbackCaps[f]; break; }
        }
      }
      if (!cap) cap = fallbackCaps[i % fallbackCaps.length];
      used[cap] = true;

      var criteriaMatch = session.prompt.match(new RegExp('PERSPECTIVE\\s+' + p.letter + '[\\s\\S]*?Primary criteria:\\s*([^\\n]+)'));
      var criteria = criteriaMatch ? criteriaMatch[1].trim() : '';
      tasks.push({
        id: 't' + (i + 1),
        description: 'Analyze the question from PERSPECTIVE ' + p.letter + ' — ' + p.role + '. ' + p.instruction +
          (criteria ? ' Focus on: ' + criteria + '.' : '') +
          ' Your conclusions MUST derive from this framework\'s evaluation criteria, not from other perspectives.',
        capability: cap,
        dependsOn: [],
        priority: 1,
        relevantFiles: [],
      });
    }
    return { tasks: tasks };
  }

  /** Merge sub-tasks that say the same thing (>= 60% word overlap, same capability root). */
  dedupeTasks(decomposition) {
    var tasks = decomposition.tasks;
    if (tasks.length <= 2) return decomposition;
    var deduped = [];
    var merged = {};
    for (var i = 0; i < tasks.length; i++) {
      if (merged[i]) continue;
      var group = [tasks[i]];
      for (var j = i + 1; j < tasks.length; j++) {
        if (merged[j]) continue;
        var sameCap = tasks[i].capability === tasks[j].capability ||
          tasks[i].capability.split('-')[0] === tasks[j].capability.split('-')[0];
        if (sameCap && gethWordJaccard(tasks[i].description, tasks[j].description) >= 0.60) {
          group.push(tasks[j]);
          merged[j] = true;
        }
      }
      if (group.length === 1) {
        deduped.push(tasks[i]);
        continue;
      }
      var files = new Set();
      var bestPriority = 5;
      for (var g = 0; g < group.length; g++) {
        bestPriority = Math.min(bestPriority, group[g].priority);
        for (var rf = 0; rf < group[g].relevantFiles.length; rf++) files.add(group[g].relevantFiles[rf]);
      }
      deduped.push(Object.assign({}, tasks[i], {
        description: '[MERGED ' + group.length + ' sub-tasks] ' + group.map(function(t) { return t.description; }).join(' + '),
        priority: bestPriority,
        relevantFiles: Array.from(files).slice(0, 8),
      }));
    }
    return { tasks: deduped };
  }

  /** When more than half of the tasks share a capability root, give the repeats a different one. */
  diversifyCapabilities(decomposition) {
    var tasks = decomposition.tasks;
    var rootCounts = {};
    var maxSame = 0;
    for (var i = 0; i < tasks.length; i++) {
      var root = tasks[i].capability.split('-')[0];
      rootCounts[root] = (rootCounts[root] || 0) + 1;
      maxSame = Math.max(maxSame, rootCounts[root]);
    }
    if (tasks.length < 3 || maxSame <= Math.ceil(tasks.length / 2)) return decomposition;

    var fallbackCaps = [
      'data-analysis', 'security-audit', 'architecture-review', 'research',
      'documentation', 'system-design', 'performance-optimization', 'knowledge-synthesis',
      'content-creation', 'compliance-review', 'policy-analysis', 'system-monitoring',
    ];
    var used = {};
    for (var t = 0; t < tasks.length; t++) {
      if (used[tasks[t].capability]) {
        for (var f = 0; f < fallbackCaps.length; f++) {
          if (!used[fallbackCaps[f]]) { tasks[t].capability = fallbackCaps[f]; break; }
        }
      }
      used[tasks[t].capability] = true;
    }
    return decomposition;
  }

  /** The PROMETHEUS routing prompt for a provider model. */
  buildPrometheusPrompt(session, decomposition, taskCtx) {
    var catalog = this.getCatalog();
    var names = catalog.map(function(a) { return a.agentName; }).join(', ');
    var identity = '[SYSTEM IDENTITY — LEGION]\n' +
      'You are the orchestration engine of the Legion multi-agent system.\n\n' +
      'ACTIVE AGENTS (' + catalog.length + ' — ONLY select from this list):\n' + names + '.\n---\n';

    var providerLine = '- Available: ' + session.providers.join(', ') + '\n';
    var schema = '{"agents":[{"name":"AGENT_NAME","provider":"provider","focus":"the specific angle THIS agent must cover"}],' +
      '"rounds":2,"cassandra":true,"athena":false,"complexity":"medium"}';

    var systemPrompt;
    if (session.config.liaraMode) {
      systemPrompt = identity + 'You are PROMETHEUS, the routing brain of a multi-agent deliberation system.\n' +
        'Your ONLY output: valid JSON. No text, no markdown, no explanation.\n\n' +
        'MODE: EPISTEMIC DELIBERATION — the query contains INCOMPATIBLE ANALYTICAL PERSPECTIVES that require maximally diverse agents.\n\n' +
        'CRITICAL AGENT SELECTION RULES:\n' +
        '- Select 5-7 agents. Each agent MUST represent a DIFFERENT analytical framework.\n' +
        '- MAXIMIZE CATEGORY DIVERSITY: select agents from AS MANY DIFFERENT categories as possible.\n' +
        '- The sub-tasks describe PERSPECTIVES. Match each perspective to the agent whose reasoning style BEST fits that framework:\n' +
        '  * Quantitative/economic analysis → data/analytics agents (ORACLE, FLUX, MERCURY)\n' +
        '  * Ethical/philosophical/humanistic analysis → reasoning/meta agents (LOGOS, SCHEHERAZADE, QUILL)\n' +
        '  * Technical/engineering analysis → code/devops agents (FORGE, JARVIS, PIPE)\n' +
        '  * Risk/adversarial analysis → security agents (SABER, ZERO, HEIMDALL)\n' +
        '  * Regulatory/legal/policy analysis → documentation/communication agents (HERALD, NAVI, QUILL)\n' +
        '  * Scientific/medical/environmental analysis → analytics/data agents (ORACLE, FLUX, MERCURY, BABEL)\n' +
        '  * Social/communication analysis → social/content agents (ECHO, HERALD, EDI)\n' +
        '- NEVER assign two agents from the same category. If forced, their focus MUST be completely different.\n' +
        '- LOGOS is ideal for logic-heavy perspectives — always consider including it.\n\n' +
        'PROVIDER DISTRIBUTION:\n' + providerLine +
        '- EVERY available provider MUST be used at least once.\n\n' +
        'FOCUS per agent: one sentence of at most 25 words stating the analytical framework THIS agent must apply. Be specific.\n\n' +
        'CASSANDRA: ALWAYS true. Adversarial pressure is essential.\n' +
        'ATHENA: true. Audit ensures deliberation integrity.\n' +
        'ROUNDS: 3 minimum. Use 4 for hard prompts.\n\n' +
        'JSON SCHEMA:\n' + schema;
    } else {
      systemPrompt = identity + 'You are PROMETHEUS, the routing brain of a multi-agent deliberation system.\n' +
        'Your ONLY output: valid JSON. No text, no markdown, no explanation.\n\n' +
        'TASK: Select agents, give each one a focus, and set deliberation parameters.\n\n' +
        'AGENT SELECTION RULES:\n' +
        '- Select 3-12 agents. ONLY agents whose category or capabilities DIRECTLY match the query domain.\n' +
        '- NEVER select content/narrative agents (SCHEHERAZADE, QUILL, MUSE, ECHO, MURASAKI) for technical/security/code queries.\n' +
        '- NEVER select security agents (SABER, HEIMDALL, SAURON, ZERO) for creative/content queries.\n' +
        '- Prefer DEPTH over BREADTH: 5 highly relevant agents > 10 loosely relevant agents.\n' +
        '- Each agent MUST cover a DIFFERENT angle. Two agents from the same category need a different focus.\n' +
        '- LOGOS is a domain-agnostic reasoner — include it when logical analysis helps.\n' +
        '- Do NOT select PROMETHEUS, CASSANDRA or ATHENA as agents: they are switched on with the flags below.\n\n' +
        'PROVIDER DISTRIBUTION:\n' + providerLine +
        '- Distribute providers to MAXIMIZE diversity: no two agents with the same category should use the same provider.\n' +
        '- If only 1 provider: assign it to all agents.\n\n' +
        'FOCUS per agent: one sentence of at most 25 words stating what THIS agent must cover on THIS query. NOT the user\'s raw prompt. Be specific.\n\n' +
        'CASSANDRA: set true when the query involves risk, controversy, ethical dilemmas, or when agents might converge too easily on a single viewpoint. For purely factual or code-generation queries, set false.\n' +
        'ATHENA: set true ONLY for high-stakes decisions (security architecture, legal, financial, medical).\n' +
        'ROUNDS: 1 for factual lookups, 2 for analysis/comparison, 3 for multi-perspective debates, 4 for deep cross-domain analysis, 5 for maximum-depth investigation (rare).\n\n' +
        'JSON SCHEMA:\n' + schema;
    }

    var taskList = decomposition.tasks.map(function(t) { return '- [' + t.capability + '] ' + t.description; }).join('\n');
    var agentList = catalog
      .filter(function(a) { return PARLIAMENT_AGENT_NAMES.indexOf(a.agentName) === -1; })
      .map(function(a) { return a.agentName + ' [' + a.category + ']: ' + a.capabilities.join(', '); })
      .join('\n');
    var domain = gethClassifyDomain(session.prompt);
    var domainHint = domain.family !== 'general' && domain.confidence >= 0.3
      ? '\nDetected domain: ' + domain.domainId + ' (family: ' + domain.family + ')' : '';
    var userMessage = 'Query: ' + session.prompt + '\nComplexity: ' + taskCtx.complexityBucket + domainHint +
      '\n\nSub-tasks:\n' + taskList + '\n\nAvailable agents:\n' + agentList;

    return { systemPrompt: systemPrompt, userMessage: userMessage };
  }

  /**
   * Score-based routing used when PROMETHEUS gives no usable decision:
   * capability match first, then category, then what this machine has learned.
   * One agent per task, never the same agent twice, parliament roles excluded.
   */
  matchAgentsByCapability(decomposition, maxAgents) {
    var catalog = this.getCatalog().filter(function(a) { return PARLIAMENT_AGENT_NAMES.indexOf(a.agentName) === -1; });
    var store = this.store;
    var taken = {};
    var assignments = [];

    function scoreAgent(agent, task) {
      var cap = task.capability.toLowerCase();
      var score = 0;
      for (var i = 0; i < agent.capabilities.length; i++) {
        var agentCap = agent.capabilities[i].toLowerCase();
        if (agentCap === cap) { score = Math.max(score, 1.0); break; }
        if (agentCap.split('-')[0] === cap.split('-')[0]) score = Math.max(score, 0.6);
        else if (agentCap.indexOf(cap) !== -1 || cap.indexOf(agentCap) !== -1) score = Math.max(score, 0.5);
      }
      // Words shared between the task description and the agent's capability names.
      var overlap = gethWordJaccard(task.description, agent.capabilities.join(' ') + ' ' + agent.category);
      score += overlap * 0.8;
      var stats = store.getAgentStats(agent.agentName);
      if (stats.sessions >= 3) score += (stats.avgQuality - 0.5) * 0.2;
      if (agent.isPrimary) score += 0.05;
      return score;
    }

    var tasks = decomposition.tasks.slice().sort(function(a, b) { return a.priority - b.priority; });
    for (var t = 0; t < tasks.length && assignments.length < maxAgents; t++) {
      var best = null;
      var bestScore = -1;
      for (var a = 0; a < catalog.length; a++) {
        if (taken[catalog[a].agentName]) continue;
        var s = scoreAgent(catalog[a], tasks[t]);
        if (s > bestScore) { bestScore = s; best = catalog[a]; }
      }
      if (!best) break;
      taken[best.agentName] = true;
      assignments.push({ agentName: best.agentName, subTaskId: tasks[t].id, provider: '', model: '', category: best.category, focus: '' });
    }
    return assignments;
  }

  /** Model name shown for a provider: the configured one, else the provider default. */
  modelNameFor(provider) {
    if (typeof this.llm.getModelFor === 'function') return this.llm.getModelFor(provider);
    if (this.llm.model) return this.llm.model;
    if (provider === 'ollama') return this.llm.ollamaModel || 'ollama-default';
    return provider + '-default';
  }

  async stepDecomposeResult(sessionId, decompositionJson, tokenStats) {
    var session = this.getSessionOrThrow(sessionId);
    this.expectStatus(session, 'awaiting_decomposition');
    var cfg = session.config;
    var self = this;

    var decomposition = this.normalizeDecomposition(decompositionJson);
    decomposition = this.enforcePerspectives(session, decomposition);
    // Perspectives discuss the SAME topic from different frameworks: their word
    // overlap is high by design, so merging would destroy the diversity.
    if (!cfg.liaraMode) decomposition = this.dedupeTasks(decomposition);
    decomposition = this.diversifyCapabilities(decomposition);
    if (decomposition.tasks.length > cfg.maxAgents) decomposition.tasks = decomposition.tasks.slice(0, cfg.maxAgents);

    var taskCtx = gethClassifyTaskContext(session.prompt);
    var complexityEstimate = taskCtx.complexityBucket === 'simple' ? 0.2 : (taskCtx.complexityBucket === 'complex' ? 0.8 : 0.5);
    if (cfg.liaraMode) complexityEstimate = 0.85;

    // Agent count and rounds follow complexity. The floor keeps every provider in use.
    var providerFloor = Math.max(session.providers.length + 1, 6);
    var dynamicMaxAgents;
    if (complexityEstimate < 0.3) {
      dynamicMaxAgents = providerFloor;
      cfg.deliberationRounds = Math.min(cfg.deliberationRounds, 1);
      cfg.minDeliberationRounds = Math.min(cfg.minDeliberationRounds, 1);
    } else if (complexityEstimate <= 0.7) {
      dynamicMaxAgents = Math.max(7, providerFloor);
    } else {
      dynamicMaxAgents = Math.max(12, cfg.maxAgents, providerFloor);
      cfg.deliberationRounds = Math.max(cfg.deliberationRounds, 3);
    }
    if (cfg.liaraMode) {
      cfg.deliberationRounds = Math.max(cfg.deliberationRounds, 3);
      cfg.minDeliberationRounds = Math.max(cfg.minDeliberationRounds, 3);
      dynamicMaxAgents = Math.max(5, Math.min(dynamicMaxAgents, 8));
      cfg.noTribunal = false;
    }

    // PROMETHEUS: routing by one of the user's providers.
    var prometheusDecision = null;
    var prometheusProvider = null;
    var prometheusError = null;
    try {
      var promPrompt = this.buildPrometheusPrompt(session, decomposition, taskCtx);
      var promResult = await this.orchestratorChat(session, promPrompt.systemPrompt, promPrompt.userMessage, 4096, 'PROMETHEUS');
      prometheusProvider = promResult.provider;
      var routable = this.getCatalog().filter(function(a) { return PARLIAMENT_AGENT_NAMES.indexOf(a.agentName) === -1; });
      var promJson = extractJSON(promResult.text);
      if (!promJson || !Array.isArray(promJson.agents)) {
        // Cut off by the token limit: the agents already listed are still a decision.
        // The flags written after the list are lost, so the defaults apply.
        var salvagedAgents = gethSalvageArrayObjects(promResult.text, 'agents');
        if (salvagedAgents.length > 0) {
          promJson = { agents: salvagedAgents, rounds: cfg.deliberationRounds, cassandra: !cfg.noTribunal, athena: false, complexity: taskCtx.complexityBucket };
        }
      }
      prometheusDecision = gethValidatePrometheusDecision(promJson, routable, session.providers);
      if (!prometheusDecision) prometheusError = 'PROMETHEUS returned no usable routing decision';

      // Domain guardrail: an agent whose category is prohibited for this kind
      // of question is replaced, whatever the model chose.
      if (prometheusDecision) {
        var domainOfPrompt = gethClassifyDomain(session.prompt);
        var categoryOf = {};
        routable.forEach(function(a) { categoryOf[a.agentName] = a.category; });
        var checked = gethValidateAgentDomainAffinity(
          prometheusDecision.agents.map(function(a) { return { name: a.name, category: categoryOf[a.name] || 'general' }; }),
          domainOfPrompt, routable);
        var replacements = [];
        for (var gi = 0; gi < checked.length; gi++) {
          if (!checked[gi].replaced) continue;
          replacements.push({ from: checked[gi].originalName, to: checked[gi].name });
          // The focus was written for the replaced agent's angle: it does not carry over.
          prometheusDecision.agents[gi] = { name: checked[gi].name, provider: prometheusDecision.agents[gi].provider, focus: '' };
        }
        session.domain = domainOfPrompt;
        session.domainReplacements = replacements;
      }
    } catch (err) {
      prometheusError = err.message;
    }

    var assignments;
    if (prometheusDecision) {
      assignments = prometheusDecision.agents.map(function(a, idx) {
        var entry = self.getCatalogEntry(a.name);
        return {
          agentName: a.name,
          subTaskId: decomposition.tasks[idx % decomposition.tasks.length].id,
          provider: a.provider,
          model: '',
          category: entry ? entry.category : 'general',
          focus: a.focus,
        };
      });
      cfg.deliberationRounds = prometheusDecision.rounds;
      cfg.minDeliberationRounds = Math.min(cfg.minDeliberationRounds, prometheusDecision.rounds);
      if (cfg.liaraMode) {
        prometheusDecision.cassandra = true;
        prometheusDecision.athena = true;
        prometheusDecision.rounds = Math.max(prometheusDecision.rounds, 3);
        cfg.deliberationRounds = Math.max(cfg.deliberationRounds, 3);
        cfg.minDeliberationRounds = Math.max(cfg.minDeliberationRounds, 3);
      }
    } else {
      assignments = this.matchAgentsByCapability(decomposition, dynamicMaxAgents);
    }

    // Top up so there are enough agents to keep every provider busy.
    if (assignments.length < providerFloor) {
      var assigned = {};
      assignments.forEach(function(a) { assigned[a.agentName] = true; });
      var categoriesInUse = {};
      assignments.forEach(function(a) { categoriesInUse[a.category] = true; });
      var candidates = this.getCatalog()
        .filter(function(a) { return !assigned[a.agentName] && PARLIAMENT_AGENT_NAMES.indexOf(a.agentName) === -1; });
      candidates = gethShuffle(candidates).sort(function(x, y) {
        return (categoriesInUse[x.category] ? 1 : 0) - (categoriesInUse[y.category] ? 1 : 0);
      });
      for (var ci = 0; ci < candidates.length && assignments.length < providerFloor; ci++) {
        assignments.push({
          agentName: candidates[ci].agentName,
          subTaskId: decomposition.tasks[assignments.length % decomposition.tasks.length].id,
          provider: '', model: '', category: candidates[ci].category, focus: '',
        });
        categoriesInUse[candidates[ci].category] = true;
      }
    }
    if (assignments.length > dynamicMaxAgents) assignments = assignments.slice(0, dynamicMaxAgents);

    // Providers: keep PROMETHEUS's choice when valid, pin the rest round-robin.
    var unpinned = assignments.filter(function(a) { return !a.provider; }).map(function(a) { return a.agentName; });
    var pinning = gethAssignProvidersToAgents(unpinned, session.providers);
    for (var pi = 0; pi < assignments.length; pi++) {
      if (!assignments[pi].provider) assignments[pi].provider = pinning[assignments[pi].agentName] || session.providers[0];
      assignments[pi].model = this.modelNameFor(assignments[pi].provider);
    }
    // Every provider must be used when there are enough agents for it.
    if (assignments.length >= session.providers.length) {
      var usage = {};
      assignments.forEach(function(a) { usage[a.provider] = (usage[a.provider] || 0) + 1; });
      for (var up = 0; up < session.providers.length; up++) {
        var idle = session.providers[up];
        if (usage[idle]) continue;
        var busiest = Object.keys(usage).sort(function(x, y) { return usage[y] - usage[x]; })[0];
        for (var ra = assignments.length - 1; ra >= 0; ra--) {
          if (assignments[ra].provider === busiest) {
            assignments[ra].provider = idle;
            assignments[ra].model = this.modelNameFor(idle);
            usage[busiest]--;
            usage[idle] = 1;
            break;
          }
        }
      }
    }

    // TRIBUNAL: CASSANDRA joins as the permanent adversarial agent.
    var cassandraEnabled = !cfg.noTribunal &&
      (prometheusDecision ? prometheusDecision.cassandra : assignments.length >= 5);
    if (cassandraEnabled) {
      var orchestratorProvider = this.pickOrchestratorProvider(session);
      assignments.push({
        agentName: 'CASSANDRA', subTaskId: '__tribunal__', provider: orchestratorProvider,
        model: this.modelNameFor(orchestratorProvider), category: 'meta-evolution', focus: '',
      });
    }

    var adaptiveConvergence = gethComputeAdaptiveConvergence(cfg.deliberationConvergence, decomposition);
    cfg.deliberationConvergence = adaptiveConvergence;
    cfg.cassandraEnabled = cassandraEnabled;
    cfg.athenaEnabled = prometheusDecision ? prometheusDecision.athena : false;

    session.decomposition = decomposition;
    session.assignments = assignments;
    session.prometheusDecision = prometheusDecision;
    session.prometheusProvider = prometheusProvider;
    session.prometheusError = prometheusError;
    session.taskContext = taskCtx;
    session.decompositionTokens = tokenStats || null;
    session.status = 'awaiting_round';
    this.persistSession(session);

    return {
      assignments: assignments,
      config: {
        deliberationRounds: cfg.deliberationRounds,
        convergenceThreshold: adaptiveConvergence,
        maxTokensPerAgent: cfg.maxTokensPerAgent,
      },
      routingMethod: prometheusDecision ? 'prometheus' : 'capability-match',
      routingNote: prometheusDecision ? null : prometheusError,
      domain: session.domain || null,
      domainReplacements: session.domainReplacements || [],
      parliament: prometheusDecision ? {
        prometheus: {
          active: true,
          agentsSelected: prometheusDecision.agents.length,
          roundsDecided: prometheusDecision.rounds,
          cassandraEnabled: prometheusDecision.cassandra,
          athenaEnabled: prometheusDecision.athena,
          complexity: prometheusDecision.complexity,
          model: prometheusProvider + '/' + this.modelNameFor(prometheusProvider),
        },
      } : null,
      nextStatus: 'awaiting_round',
    };
  }

  // ------------------------------------------------------------------ rounds

  proposalsOfRound(session, round) {
    return session.proposals
      .filter(function(p) { return p.round === round; })
      .sort(function(a, b) { return a.agentName < b.agentName ? -1 : (a.agentName > b.agentName ? 1 : 0); });
  }

  /** Cross-reading block: every proposal of the previous round, for every agent. */
  buildCrossReadingContext(session, round) {
    if (round <= 1) return '';
    var prev = this.proposalsOfRound(session, round - 1);
    if (prev.length === 0) return '';
    // Cross-reading is where most input tokens go: every agent reads every
    // proposal, every round. 'crossReadingChars' caps what is read of each one.
    var cap = Number(session.config.crossReadingChars) || 0;
    var ctx = '\n\n--- CROSS-READING: Other agents\' proposals from Round ' + (round - 1) + ' ---\n';
    for (var i = 0; i < prev.length; i++) {
      var body = prev[i].content;
      if (cap > 0 && body.length > cap) {
        body = gethTrimToCharBudget(body, cap) + '\n[... ' + (body.length - cap) + ' more characters not shown]';
      }
      ctx += '\n[' + prev[i].agentName.toUpperCase() + ' via ' + prev[i].provider + '] (Round ' + prev[i].round + '):\n' + body + '\n';
    }
    ctx += '\n--- END CROSS-READING ---\n';
    ctx += '\nYou have now read other agents\' proposals. Refine your response by:\n';
    ctx += '1. Acknowledging valid points from others\n';
    ctx += '2. Defending your unique insights with evidence\n';
    ctx += '3. Synthesizing where possible\n';
    ctx += '4. Flagging genuine disagreements with reasoning\n';
    ctx += '5. CRUX IDENTIFICATION: For each disagreement, identify the CRUX — the single factual question or value judgment whose resolution would settle the debate. Format: [CRUX: <question>] [IF-YES: <your conclusion>] [IF-NO: <alternative conclusion>]. A crux MUST be empirically decidable or normatively explicit. Vague crux = failure. BAD example: [CRUX: Is this approach good?] — not decidable.\n';
    ctx += '6. Classify each disagreement: [EMPIRICAL] (testable), [METHODOLOGICAL] (framework choice), [VALUES] (irreconcilable priorities), [SCOPE] (different aspects of same problem)\n';
    return ctx;
  }

  /** Source files a sub-task named, taken from the scanned project context. */
  buildCodeContext(session, subTask) {
    var ctx = session.projectContext;
    if (!ctx || typeof ctx !== 'object' || !ctx.codeChunks || !subTask || !subTask.relevantFiles.length) return '';
    var blocks = [];
    for (var i = 0; i < subTask.relevantFiles.length && blocks.length < 4; i++) {
      var code = ctx.codeChunks[subTask.relevantFiles[i]];
      if (code) blocks.push('[FILE: ' + subTask.relevantFiles[i] + ']\n' + String(code).substring(0, 6000));
    }
    if (blocks.length === 0) return '';
    return '\n\n--- RELEVANT SOURCE CODE ---\n' + blocks.join('\n\n') + '\n--- END SOURCE CODE ---\n';
  }

  /** Phase A text: CASSANDRA must challenge every other agent's proposal. */
  buildTribunalPhaseAContext(session, round) {
    var prev = this.proposalsOfRound(session, round - 1);
    var avgLength = prev.length > 0
      ? prev.reduce(function(s, p) { return s + p.content.length; }, 0) / prev.length : 1000;
    var fields = avgLength < 500
      ? ['WEAKNESS', 'FAILURE-SCENARIO']
      : (avgLength < 2000
        ? ['WEAKNESS', 'COUNTER-EVIDENCE', 'FAILURE-SCENARIO']
        : ['WEAKNESS', 'COUNTER-EVIDENCE', 'FAILURE-SCENARIO', 'STEEL-MAN']);

    var others = session.assignments
      .filter(function(a) { return a.agentName !== 'CASSANDRA'; })
      .map(function(a) { return a.agentName; });
    // 10-25% of the agents get a lateral perspective instead of an attack.
    var exploratoryCount = Math.max(1, Math.floor(others.length * (0.10 + Math.random() * 0.15)));
    var exploratory = gethShuffle(others).slice(0, exploratoryCount);
    // One session in five lists the fields in reverse, then the order is shuffled.
    var ordered = gethShuffle(Math.random() < 0.20 ? fields.slice().reverse() : fields);

    var descriptions = {
      'WEAKNESS': '[WEAKNESS]: The single most critical weakness — the assumption that, if wrong, invalidates the entire approach.',
      'COUNTER-EVIDENCE': '[COUNTER-EVIDENCE]: A specific fact or data point that contradicts the proposal.',
      'FAILURE-SCENARIO': '[FAILURE-SCENARIO]: A concrete, realistic scenario where the solution would fail or cause harm.',
      'STEEL-MAN': '[STEEL-MAN]: The strongest version of the opposing view the agent has NOT considered.',
    };

    return '\n\n[TRIBUNAL MODE — MANDATORY ADVERSARIAL ANALYSIS]\n\n' +
      'You are CASSANDRA, the Permanent Tribunal of this deliberation. Your role is NOT to contribute a solution but to CHALLENGE every proposal.\n\n' +
      'You have read all Round ' + (round - 1) + ' proposals above. For EACH agent listed below, you MUST produce structured challenges.\n\n' +
      'Challenge fields for each agent:\n' +
      ordered.map(function(f, i) { return (i + 1) + '. ' + descriptions[f]; }).join('\n') + '\n\n' +
      'FORMAT — respond with exactly this structure for each agent:\n\n' +
      '=== CHALLENGE: {agent_name} ===\n' +
      ordered.map(function(f) { return '[' + f + ']: ...'; }).join('\n') + '\n' +
      '=== END CHALLENGE: {agent_name} ===\n\n' +
      'For these agents, use EXPLORATORY mode instead: ' + exploratory.join(', ') + '\n' +
      'Exploratory agents receive lateral perspectives, not adversarial challenges:\n' +
      '=== CHALLENGE: {exploratory_agent_name} ===\n' +
      '[LATERAL]: An alternative framing the agent has not considered — a genuinely different angle.\n' +
      '[WHAT-IF]: A hypothetical constraint change that would force a fundamentally different solution.\n' +
      '=== END CHALLENGE: {exploratory_agent_name} ===\n\n' +
      'AGENTS TO CHALLENGE: ' + others.join(', ') + '\n\n' +
      'RULES:\n' +
      '- Do NOT strawman. Every challenge must be the STRONGEST version of the objection.\n' +
      '- Do NOT generate generic challenges. Each must be SPECIFIC to the agent\'s actual proposal content.\n' +
      '- If you genuinely cannot find a weakness, say "[WEAKNESS]: No critical weakness identified — proposal is robust in this aspect" — but you MUST still provide the other fields.\n' +
      '- Your challenges will be shown to each agent. They MUST respond. This is what creates emergence.\n' +
      '- Keep each challenge concise and targeted (max 500 chars per field).\n';
  }

  /** Phase B text: the challenge CASSANDRA addressed to one agent. */
  buildTribunalPhaseBContext(challenge) {
    var ctx = '\n\n--- TRIBUNAL CHALLENGE ---\n' +
      'CASSANDRA has challenged your Round 1 proposal. You MUST respond to each point.\n' +
      'Your response quality on these challenges will affect your authority weight.\n\n';
    if (challenge.weakness) ctx += '[WEAKNESS IDENTIFIED]: ' + challenge.weakness + '\n';
    if (challenge.counterEvidence) ctx += '[COUNTER-EVIDENCE]: ' + challenge.counterEvidence + '\n';
    if (challenge.failureScenario) ctx += '[FAILURE-SCENARIO]: ' + challenge.failureScenario + '\n';
    if (challenge.steelMan) ctx += '[STEEL-MAN ARGUMENT]: ' + challenge.steelMan + '\n';
    if (challenge.lateral) ctx += '[LATERAL PERSPECTIVE]: ' + challenge.lateral + '\n';
    if (challenge.whatIf) ctx += '[WHAT-IF SCENARIO]: ' + challenge.whatIf + '\n';

    var all = [challenge.weakness, challenge.counterEvidence, challenge.failureScenario,
      challenge.steelMan, challenge.lateral, challenge.whatIf].filter(Boolean).join(' ');
    var obligations = [];
    if (/\[EVIDENTIARY\]/i.test(all)) obligations.push('- [EVIDENTIARY] obligation: cite a specific source, dataset, or verifiable claim to support your position');
    if (/\[LOGICAL\]/i.test(all)) obligations.push('- [LOGICAL] obligation: show the correct logical chain (premises → conclusion) and explain why it is valid');
    if (/\[ASSUMPTION\]/i.test(all)) obligations.push('- [ASSUMPTION] obligation: explicitly state the premise challenged, then either defend it with evidence or revise your conclusion');
    if (/\[FRAMEWORK\]/i.test(all)) obligations.push('- [FRAMEWORK] obligation: justify why your chosen framework is appropriate for this context, or adopt the alternative');
    if (/\[COMPLETENESS\]/i.test(all)) obligations.push('- [COMPLETENESS] obligation: address the missing stakeholder, edge case, or failure mode identified');

    ctx += '\nFor EACH challenge point, respond with one of:\n' +
      '- [ACCEPT]: You acknowledge the weakness and revise your proposal accordingly. Explain what changed.\n' +
      '- [REBUT]: You disagree and provide specific evidence/reasoning why the challenge is invalid.\n' +
      '- [MITIGATE]: You acknowledge the risk but propose a specific mitigation. Explain the trade-off.\n';
    if (obligations.length > 0) {
      ctx += '\nTYPE-SPECIFIC OBLIGATIONS (based on CASSANDRA\'s challenge type):\n' + obligations.join('\n') + '\n';
    }
    ctx += '\nAddress the challenge concisely (1-2 paragraphs per point), then provide your REVISED proposal.\n' +
      '--- END TRIBUNAL CHALLENGE ---\n';
    return ctx;
  }

  async stepRoundStart(sessionId, round) {
    var session = this.getSessionOrThrow(sessionId);
    this.expectStatus(session, 'awaiting_round');
    var cfg = session.config;
    var lang = gethDetectPromptLanguage(session.prompt);
    var langDirective = gethBuildAgentLanguageDirective(lang);
    var proposalContext = this.buildCrossReadingContext(session, round);

    var hasCassandra = session.assignments.some(function(a) { return a.agentName === 'CASSANDRA'; });
    var tribunalActive = round === 2 && hasCassandra && !cfg.noTribunal;
    var storedChallenges = tribunalActive ? session.tribunal.challenges : [];
    var phaseA = tribunalActive && storedChallenges.length === 0 && session.tribunal.phaseAAttempts < 2;

    var instructions = [];
    for (var i = 0; i < session.assignments.length; i++) {
      var assignment = session.assignments[i];
      var isCassandra = assignment.agentName === 'CASSANDRA';

      var systemPrompt = await this.loadAgentSystemPrompt(assignment.agentName);
      if (langDirective) systemPrompt = langDirective + '\n' + systemPrompt;

      var memories = this.store.getMemories(assignment.agentName, 3);
      if (memories.length > 0) {
        systemPrompt += '\n\nYour episodic memories:\n' +
          memories.map(function(mem) { return '- [' + mem.episodeType + '] ' + mem.content; }).join('\n');
      }
      if (this.promptEvolver) {
        systemPrompt += this.promptEvolver.getPromptEvolution(this.evolutionKey(assignment.agentName));
      }
      systemPrompt += GETH_STRUCTURED_OUTPUT_INSTRUCTION;

      var subTask = null;
      for (var ti = 0; ti < session.decomposition.tasks.length; ti++) {
        if (session.decomposition.tasks[ti].id === assignment.subTaskId) { subTask = session.decomposition.tasks[ti]; break; }
      }
      var taskDesc = subTask ? subTask.description : session.prompt;
      if (assignment.focus) taskDesc += '\nYour assigned angle: ' + assignment.focus;

      var tribunalContext = '';
      if (phaseA && isCassandra) {
        tribunalContext = this.buildTribunalPhaseAContext(session, round);
      } else if (tribunalActive && !isCassandra && storedChallenges.length > 0) {
        var mine = null;
        for (var chi = 0; chi < storedChallenges.length; chi++) {
          if (storedChallenges[chi].targetAgent === assignment.agentName) { mine = storedChallenges[chi]; break; }
        }
        if (mine) tribunalContext = this.buildTribunalPhaseBContext(mine);
      }

      instructions.push({
        agentName: assignment.agentName,
        subTaskId: assignment.subTaskId,
        category: assignment.category,
        provider: assignment.provider,
        model: assignment.model,
        systemPrompt: systemPrompt,
        userMessage: 'Original prompt: ' + session.prompt + '\n\nYour specific sub-task: ' + taskDesc +
          this.buildCodeContext(session, subTask) + proposalContext + tribunalContext,
        maxTokens: (tribunalActive && isCassandra) ? Math.floor(cfg.maxTokensPerAgent * 0.6) : cfg.maxTokensPerAgent,
        temperature: cfg.temperature,
      });
    }

    // Tribunal round: Phase A returns CASSANDRA alone, Phase B (or a tribunal
    // that failed twice) returns everyone else. In the other rounds she
    // takes part like any other agent.
    var filtered = instructions;
    if (phaseA) {
      filtered = instructions.filter(function(a) { return a.agentName === 'CASSANDRA'; });
    } else if (tribunalActive) {
      filtered = instructions.filter(function(a) { return a.agentName !== 'CASSANDRA'; });
    }

    // Mediation round: only the divergent agents run again, told to defend
    // their position with evidence. The others keep their last proposal.
    var mediation = !phaseA && Array.isArray(session.mediationTargets) && session.mediationTargets.length > 0;
    if (mediation) {
      var targets = session.mediationTargets;
      var mediated = filtered.filter(function(a) { return targets.indexOf(a.agentName) !== -1; });
      if (mediated.length > 0) {
        for (var mi = 0; mi < mediated.length; mi++) {
          mediated[mi].userMessage += '\n\n[MEDIATION ROUND]\n' +
            'Your position diverges from the other agents. Do NOT give it up to reach agreement.\n' +
            '1. State your position in one paragraph.\n' +
            '2. Defend it with the specific evidence or reasoning it rests on.\n' +
            '3. Name the exact claim of the other agents you reject, and why.\n' +
            '4. State what evidence would change your mind.\n' +
            'Change your position only if a specific argument you have read above defeats it, and say which one.\n';
        }
        filtered = mediated;
      } else {
        mediation = false;
      }
    }

    session.currentRound = round;
    session.currentRoundMediation = mediation;
    this.persistSession(session);
    return {
      agents: filtered,
      round: round,
      tribunalPhaseA: phaseA,
      mediation: mediation,
      agentCount: session.assignments.length - (hasCassandra ? 1 : 0),
    };
  }

  /**
   * In a mediation round only some agents spoke. For convergence, the others
   * count with the last proposal they made.
   */
  carriedForwardProposals(session, round, spoke) {
    var latest = {};
    for (var i = 0; i < session.proposals.length; i++) {
      var p = session.proposals[i];
      if (p.round >= round || p.tribunalPhaseA || p.agentName === 'CASSANDRA') continue;
      if (!latest[p.agentName] || latest[p.agentName].round < p.round) latest[p.agentName] = p;
    }
    return Object.keys(latest)
      .filter(function(name) { return spoke.indexOf(name) === -1; })
      .map(function(name) { return Object.assign({}, latest[name], { round: round, carriedForward: true }); });
  }

  /**
   * Embeddings for convergence, one vector per text, or null when no
   * embedding model is configured or the call fails. Null means the
   * convergence engine falls back to token Jaccard.
   */
  async embedTexts(texts) {
    if (typeof this.llm.embedTexts !== 'function' || texts.length < 2) return null;
    try {
      var vectors = await this.llm.embedTexts(texts);
      if (!Array.isArray(vectors) || vectors.length !== texts.length) return null;
      return vectors;
    } catch (_) {
      return null;
    }
  }

  async stepRoundResult(sessionId, round, proposals) {
    var session = this.getSessionOrThrow(sessionId);
    this.expectStatus(session, 'awaiting_round');
    var cfg = session.config;
    if (!Array.isArray(proposals) || proposals.length === 0) throw new Error('No proposals submitted for round ' + round);

    var clean = proposals.map(function(p) {
      var confidence = Number(p.confidence);
      return {
        agentName: String(p.agentName),
        subTaskId: String(p.subTaskId || ''),
        round: round,
        provider: p.provider || 'unknown',
        model: p.model || 'unknown',
        content: typeof p.content === 'string' ? p.content : (p.content && typeof p.content === 'object' ? JSON.stringify(p.content) : String(p.content || '')),
        confidence: isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7,
        riskFlags: Array.isArray(p.riskFlags) ? p.riskFlags : [],
        reasoningSummary: typeof p.reasoningSummary === 'string' ? p.reasoningSummary : String(p.reasoningSummary || ''),
        inputTokens: Number(p.inputTokens) || 0,
        outputTokens: Number(p.outputTokens) || 0,
        durationMs: Number(p.durationMs) || 0,
      };
    });

    // TRIBUNAL Phase A: CASSANDRA alone — parse her challenges, no convergence yet.
    var isPhaseA = round === 2 && !cfg.noTribunal && clean.length === 1 && clean[0].agentName === 'CASSANDRA' &&
      session.tribunal.challenges.length === 0;
    if (isPhaseA) {
      clean[0].tribunalPhaseA = true;
      session.proposals.push(clean[0]);
      var expected = session.assignments
        .filter(function(a) { return a.agentName !== 'CASSANDRA'; })
        .map(function(a) { return a.agentName; });
      session.tribunal.challenges = gethParseTribunalChallenges(clean[0].content, expected);
      session.tribunal.phaseAAttempts += 1;
      this.persistSession(session);
      return {
        convergence: 0,
        method: 'tribunal_phase_a',
        divergentPairs: [],
        decision: { mode: 'standard', reason: 'Tribunal Phase A complete — proceed to Phase B' },
        nextStatus: 'awaiting_round',
        nextRound: round,
        tribunalChallengesGenerated: session.tribunal.challenges.length,
      };
    }

    for (var i = 0; i < clean.length; i++) session.proposals.push(clean[i]);

    // TRIBUNAL Phase B: how the agents answered the challenges.
    var tribunalMetrics = null;
    if (round === 2 && !cfg.noTribunal && session.tribunal.challenges.length > 0) {
      var round1Props = session.proposals.filter(function(p) { return p.round === 1; });
      tribunalMetrics = gethComputeTribunalMetrics(round1Props, clean, session.tribunal.challenges);
      session.tribunal.metrics = tribunalMetrics;
    }

    var valid = clean.filter(function(p) {
      return p.agentName !== 'CASSANDRA' && p.riskFlags.indexOf('agent_failure') === -1 &&
        p.riskFlags.indexOf('execution_error') === -1;
    });
    if (session.currentRoundMediation) {
      valid = valid.concat(this.carriedForwardProposals(session, round, clean.map(function(p) { return p.agentName; })));
    }
    var embeddings = await this.embedTexts(valid.map(function(p) { return p.content; }));

    var convergenceResult = gethMeasureConvergence({
      proposals: valid,
      embeddings: embeddings,
      convergenceHistory: session.convergenceHistory,
      currentRound: round,
      maxRounds: cfg.deliberationRounds,
      agentCount: clean.length,
      challengeResponseQuality: tribunalMetrics
        ? { ignoreRate: tribunalMetrics.ignoreRate, ritualAcceptRate: tribunalMetrics.ritualAcceptRate } : undefined,
    });

    var taskComplexity = session.taskContext.complexityBucket === 'simple' ? 0.2
      : (session.taskContext.complexityBucket === 'complex' ? 0.8 : 0.5);

    var decision;
    if (round < cfg.minDeliberationRounds) {
      var gate = gethEvaluateRound1QualityGate({
        complementarity: convergenceResult.complementarity,
        effectiveConvergence: convergenceResult.effectiveConvergence,
        clusters: convergenceResult.clusters,
      });
      if (gate.shouldSkip && !cfg.liaraMode && taskComplexity < 0.8) {
        decision = { shouldContinue: false, mode: 'skip', reason: gate.reason };
      } else {
        decision = {
          shouldContinue: true, mode: 'standard',
          reason: 'minimum round ' + (round + 1) + ' of ' + cfg.minDeliberationRounds + ' (quality gate: ' + gate.reason + ')',
        };
      }
    } else {
      decision = convergenceResult.roundDecision;
    }

    // Mediation: only the divergent agents defend their position next round.
    // A contradiction names both sides of every conflicting pair, so one
    // dissenter drags the whole majority in. When most agents sit in one
    // consensus cluster, the divergent ones are those outside it.
    var mediationTargets = null;
    if (decision.shouldContinue && decision.mode === 'targeted_mediation' && decision.targetAgents) {
      var outliers = convergenceResult.clusters.outliers;
      var outside = decision.targetAgents.filter(function(name) { return outliers.indexOf(name) !== -1; });
      mediationTargets = convergenceResult.clusters.consensusStrength >= 0.5 && outside.length > 0
        ? outside : decision.targetAgents.slice();
    }
    session.mediationTargets = mediationTargets;

    session.convergenceHistory.push({
      round: round,
      convergence: convergenceResult.convergence,
      method: convergenceResult.method,
      divergentPairs: convergenceResult.divergentPairs,
      effectiveConvergence: convergenceResult.effectiveConvergence,
      complementarityScore: convergenceResult.complementarity.complementarityScore,
      contradictionScore: convergenceResult.complementarity.contradictionScore,
      trajectoryTrend: convergenceResult.trajectory.trend,
      trajectoryVelocity: convergenceResult.trajectory.velocity,
      qualityWeightedConvergence: convergenceResult.qualityWeightedConvergence,
      consensusStrength: convergenceResult.clusters.consensusStrength,
      outlierAgents: convergenceResult.clusters.outliers,
      realConflicts: convergenceResult.complementarity.realConflicts,
      roundDecisionMode: decision.mode,
      roundDecisionReason: decision.reason,
    });
    session.roundsCompleted = round;
    session.finalConvergence = convergenceResult.effectiveConvergence;
    session.status = decision.shouldContinue ? 'awaiting_round' : 'awaiting_synthesis';
    this.persistSession(session);

    var result = {
      convergence: convergenceResult.convergence,
      method: convergenceResult.method,
      divergentPairs: convergenceResult.divergentPairs,
      decision: {
        mode: decision.shouldContinue ? decision.mode : 'skip_consensus',
        reason: decision.reason,
      },
      nextStatus: session.status,
      nextRound: decision.shouldContinue ? round + 1 : round,
      effectiveConvergence: convergenceResult.effectiveConvergence,
      complementarity: {
        score: convergenceResult.complementarity.complementarityScore,
        contradictions: convergenceResult.complementarity.contradictionScore,
        realConflicts: convergenceResult.complementarity.realConflicts.length,
      },
      trajectory: { trend: convergenceResult.trajectory.trend, velocity: convergenceResult.trajectory.velocity },
      clusters: { strength: convergenceResult.clusters.consensusStrength, outliers: convergenceResult.clusters.outliers },
    };
    if (tribunalMetrics) result.tribunalMetrics = tribunalMetrics;
    return result;
  }

  async stepForceTransition(sessionId, targetStatus) {
    var session = this.getSessionOrThrow(sessionId);
    if (targetStatus !== 'awaiting_round' && targetStatus !== 'awaiting_synthesis') {
      throw new Error('Unsupported transition target: ' + targetStatus);
    }
    if (session.status !== 'awaiting_round' && session.status !== 'awaiting_synthesis') {
      throw new Error('Session status is ' + session.status + ', cannot force a transition');
    }
    if (targetStatus === 'awaiting_synthesis' && session.proposals.length === 0) {
      throw new Error('Cannot synthesize: no proposal was collected');
    }
    session.status = targetStatus;
    this.persistSession(session);
    return { status: session.status };
  }

  // --------------------------------------------------------------- synthesis

  /** Proposals that can feed synthesis and scoring: no failed agent, no tribunal challenge text. */
  usableProposals(session) {
    return session.proposals.filter(function(p) {
      return !p.tribunalPhaseA && p.riskFlags.indexOf('agent_failure') === -1 && p.riskFlags.indexOf('execution_error') === -1;
    });
  }

  /** The latest usable proposal of every agent (CASSANDRA excluded). */
  latestProposalPerAgent(session) {
    var latest = {};
    var usable = this.usableProposals(session);
    for (var i = 0; i < usable.length; i++) {
      var p = usable[i];
      if (p.agentName === 'CASSANDRA') continue;
      if (!latest[p.agentName] || latest[p.agentName].round < p.round) latest[p.agentName] = p;
    }
    return Object.keys(latest).sort().map(function(name) { return latest[name]; });
  }

  /**
   * Fact check by a provider model. There are no verified sources here: the
   * model can only point at claims that contradict each other or look wrong.
   * Returns { claims, provider } or null when the check could not be done.
   */
  async runFactCheck(session) {
    var latest = this.latestProposalPerAgent(session);
    if (latest.length === 0) return null;
    var perProposal = Math.floor(24000 / latest.length);
    var body = latest.map(function(p) {
      return '[' + p.agentName + ']:\n' + gethTrimToCharBudget(p.content, perProposal);
    }).join('\n\n');

    var systemPrompt = 'You are a fact-checking reviewer for a multi-agent deliberation.\n' +
      'You have NO access to external sources. Do not pretend to verify anything.\n' +
      'Read the agents\' final positions and list ONLY the factual claims that deserve a warning:\n' +
      '- "contradicted": two agents state incompatible facts (numbers, dates, names, cause and effect)\n' +
      '- "doubtful": the claim is likely wrong according to well-established knowledge\n' +
      '- "unsupported": a precise figure, quote or citation is given with nothing to back it\n' +
      'Opinions and recommendations are NOT factual claims: ignore them.\n' +
      'At most 12 claims, the most consequential first. If nothing deserves a warning, return an empty list.\n\n' +
      'Respond ONLY with JSON: {"claims":[{"claim":"the claim, quoted or closely paraphrased","agents":["AGENT"],"status":"contradicted|doubtful|unsupported","note":"why, in one sentence"}]}';

    try {
      var result = await this.orchestratorChat(session, systemPrompt,
        'Question: ' + session.prompt + '\n\nAgents\' final positions:\n\n' + body, 4096, '_fact_check');
      var parsed = extractJSON(result.text);
      if (!parsed || !Array.isArray(parsed.claims)) {
        // Cut off by the token limit: the claims already written still count.
        var salvagedClaims = gethSalvageArrayObjects(result.text, 'claims');
        if (salvagedClaims.length === 0) return null;
        parsed = { claims: salvagedClaims };
      }
      var allowed = ['contradicted', 'doubtful', 'unsupported'];
      var claims = [];
      for (var i = 0; i < parsed.claims.length && claims.length < 12; i++) {
        var c = parsed.claims[i];
        if (!c || typeof c.claim !== 'string' || !c.claim.trim() || allowed.indexOf(c.status) === -1) continue;
        claims.push({
          claim: c.claim.trim().substring(0, 400),
          agents: Array.isArray(c.agents) ? c.agents.filter(function(a) { return typeof a === 'string'; }).slice(0, 8) : [],
          status: c.status,
          note: typeof c.note === 'string' ? c.note.trim().substring(0, 400) : '',
        });
      }
      return { claims: claims, provider: result.provider };
    } catch (_) {
      return null;
    }
  }

  buildSynthesisSystemPrompt(session, lang) {
    var history = session.convergenceHistory;
    var convergenceInfo = history.length > 0
      ? '\nConvergence progression: ' + history.map(function(c) {
          return 'Round ' + c.round + ': ' + (c.convergence * 100).toFixed(0) + '%';
        }).join(' -> ') + '\n'
      : '';

    return 'You are the Geth Consensus Synthesizer. Your mission is to produce an answer that is DEMONSTRABLY SUPERIOR to any single agent\'s proposal by performing genuine intellectual synthesis.\n' +
      gethBuildLanguageDirective(lang) + '\n' +
      'OUTPUT FORMAT: Write your answer in clean, well-structured Markdown. Use headings (##, ###), bullet points, numbered lists, bold, and code blocks as appropriate. Do NOT wrap your response in JSON, do NOT use ```json blocks, do NOT output structured metadata. Your output must be a readable Markdown document, not data.\n\n' +
      'ABSOLUTE PROHIBITION — ANTI-META-ANALYSIS:\n' +
      'Your output MUST be a DIRECT ANSWER to the user\'s original prompt. You are writing for the END USER, not for internal review.\n' +
      'NEVER do ANY of the following:\n' +
      '- NEVER mention agent names (e.g., "Scheherazade argues...", "According to Logos...")\n' +
      '- NEVER organize sections by agent name (e.g., "### Agent X", "### Agent Y")\n' +
      '- NEVER include sections titled "Punti di Disaccordo", "Tensioni Irrisolte", "Disaccordi principali", "Accordi principali", "Framework di Analisi Incompatibili", or any variation\n' +
      '- NEVER discuss the deliberation process, convergence trajectory, or how agents agreed/disagreed\n' +
      '- NEVER compare "frameworks" or "analytical approaches" used by different sources\n' +
      '- NEVER produce a meta-analysis of what different sources said — produce THE ANSWER\n' +
      'Your output must read as if written by a SINGLE expert author. The user must NOT be able to tell that multiple agents contributed.\n' +
      'The ONLY exception is a brief "Deliberation Notes" section at the very end (after the complete answer).\n\n' +
      'Rules:\n' +
      '1. COMPLEMENTARY STRENGTH EXTRACTION: Extract the BEST part of each proposal. The synthesis must be stronger than any individual because it combines domain expertise from multiple sources.\n' +
      '2. WEIGHT BY CONFIDENCE: Proposals marked "very high" or "high" confidence should be given more weight. But always CROSS-VALIDATE: when multiple sources agree, confidence is reinforced; when they disagree, investigate.\n' +
      '3. RISK AWARENESS: If a proposal has risk flags (speculative, outdated_knowledge, incomplete_context, conflicting_evidence), acknowledge these limitations.\n' +
      '4. GAP DETECTION: For each aspect of the original prompt, verify that AT LEAST one source addresses it thoroughly. Flag uncovered areas explicitly.\n' +
      '5. NOVEL CROSS-CONNECTIONS: The highest value is insights that emerge from COMBINING perspectives. When one source identifies a problem and another proposes a solution for a related context, connect them.\n' +
      '6. DEPTH ESCALATION: Go DEEPER than any individual. Cover ALL sub-tasks at the maximum depth available from any source.\n' +
      '7. SPECIFICITY PRIORITY: When one source gives a general recommendation and another gives specifics (code, numbers, references), prefer the specific version.\n' +
      '8. Later rounds are preferred (mediated > refined > initial) because they incorporate cross-reading.\n' +
      '9. Cross-provider agreement (e.g., Anthropic + OpenAI + Gemini) is especially strong evidence.\n' +
      '10. Include a brief "Deliberation Notes" section at the very end. This section must NOT reference agent names — summarize key agreements, disagreements, and insights only.\n' +
      '11. FACT-CHECK NOTES: when the research ends with a fact-check section, do not repeat a claim marked "doubtful" or "unsupported" as established fact, and resolve or openly state every claim marked "contradicted".\n' +
      convergenceInfo;
  }

  /**
   * Everything the synthesizer needs to weigh the proposals: authority of each
   * agent, strategy, sub-task coverage, conflicts with their kind.
   */
  buildSynthesisIntelligence(session) {
    var store = this.store;
    var finalProposals = this.latestProposalPerAgent(session);
    var capabilityOf = {};
    session.decomposition.tasks.forEach(function(t) { capabilityOf[t.id] = t.capability; });
    var history = session.convergenceHistory;
    var last = history.length > 0 ? history[history.length - 1] : null;

    var domain = session.domain || gethClassifyDomain(session.prompt);
    var self = this;
    var domainFlags = [];
    finalProposals.forEach(function(p) {
      var entry = self.getCatalogEntry(p.agentName);
      var flag = gethAssessProposalDomainRelevance(
        { agentName: p.agentName, content: p.content, category: entry ? entry.category : '' }, domain);
      if (flag) domainFlags.push(flag);
    });

    var tribunalMetrics = session.tribunal.metrics;
    var authorityRankings = gethComputeAuthorityRankings(finalProposals, function(agentName, subTaskId) {
      var stats = store.getAgentStats(agentName);
      var capability = capabilityOf[subTaskId] || 'general';
      var cap = stats.capabilities[capability];
      return {
        sessions: stats.sessions,
        avgQuality: stats.avgQuality,
        successRate: stats.sessions > 0 ? (stats.successes || 0) / stats.sessions : 0.5,
        consistency: stats.consistency,
        capability: capability,
        capabilityQuality: cap ? cap.avgQuality : 0.5,
        capabilitySamples: cap ? cap.sampleCount : 0,
      };
    }, {
      outliers: last ? last.outlierAgents || [] : [],
      challengeEngagement: tribunalMetrics ? tribunalMetrics.engagementByAgent : {},
      domainFlags: domainFlags,
    });

    var authorityOf = {};
    authorityRankings.forEach(function(a) { authorityOf[a.agentName] = a; });

    var subTaskCoverage = session.decomposition.tasks.map(function(task) {
      // Several agents may share a sub-task: the one with most authority covers it.
      var covering = finalProposals
        .filter(function(p) { return p.subTaskId === task.id; })
        .sort(function(a, b) { return authorityOf[b.agentName].authorityScore - authorityOf[a.agentName].authorityScore; })[0];
      var auth = covering ? authorityOf[covering.agentName] : null;
      return {
        taskId: task.id,
        taskDescription: task.description.length > 80 ? task.description.substring(0, 77) + '...' : task.description,
        priority: task.priority,
        bestAgent: covering ? covering.agentName : 'unassigned',
        bestAgentTier: auth ? auth.tier : 'unknown',
        bestAgentScore: auth ? auth.authorityScore : 0,
      };
    }).sort(function(a, b) { return a.priority - b.priority; });

    var contentOf = {};
    finalProposals.forEach(function(p) { contentOf[p.agentName] = p.content; });
    var realConflicts = ((last && last.realConflicts) || [])
      .filter(function(c) { return authorityOf[c.agents[0]] && authorityOf[c.agents[1]]; })
      .map(function(c) {
        var scoreA = authorityOf[c.agents[0]].authorityScore;
        var scoreB = authorityOf[c.agents[1]].authorityScore;
        return {
          agents: c.agents,
          subTask: c.subTask || 'general',
          similarity: c.similarity,
          preferredAgent: scoreA >= scoreB ? c.agents[0] : c.agents[1],
          preferredScore: Math.max(scoreA, scoreB),
          otherScore: Math.min(scoreA, scoreB),
          conflictType: gethClassifyConflictType(contentOf[c.agents[0]], contentOf[c.agents[1]]),
        };
      });

    var strategy = gethDetermineSynthesisStrategy(last);
    var block = gethBuildIntelligenceBlock({
      strategy: strategy,
      lastConvergence: last,
      authorityRankings: authorityRankings,
      subTaskCoverage: subTaskCoverage,
      realConflicts: realConflicts,
      domainFlags: domainFlags,
    });
    return {
      strategy: strategy,
      authorityRankings: authorityRankings,
      subTaskCoverage: subTaskCoverage,
      realConflicts: realConflicts,
      domainFlags: domainFlags,
      intelligenceBlock: block,
    };
  }

  buildSynthesisProposalContext(session, authorityRankings) {
    var authorityOf = {};
    (authorityRankings || []).forEach(function(a) { authorityOf[a.agentName] = a; });
    // 'synthesisLatestOnly': the synthesizer reads each agent's final position
    // instead of every round. Later rounds already build on the earlier ones.
    var usable = session.config.synthesisLatestOnly
      ? this.latestProposalPerAgent(session)
      : this.usableProposals(session);
    var rounds = {};
    var maxRound = 1;
    for (var i = 0; i < usable.length; i++) {
      if (!rounds[usable[i].round]) rounds[usable[i].round] = [];
      rounds[usable[i].round].push(usable[i]);
      maxRound = Math.max(maxRound, usable[i].round);
    }
    var ctx = '';
    Object.keys(rounds).map(Number).sort(function(a, b) { return a - b; }).forEach(function(round) {
      var label = round === 1 ? 'Initial' : (round === maxRound ? 'Final (mediated)' : 'Refined (Round ' + round + ')');
      ctx += '\n=== ' + label + ' Proposals ===\n';
      rounds[round].sort(function(a, b) { return a.agentName < b.agentName ? -1 : 1; }).forEach(function(p) {
        var conf = p.confidence;
        var confLabel = conf >= 0.9 ? 'very high' : (conf >= 0.7 ? 'high' : (conf >= 0.5 ? 'moderate' : (conf >= 0.3 ? 'low' : 'very low')));
        var riskInfo = p.riskFlags.length > 0 ? ' | Risks: ' + p.riskFlags.join(', ') : '';
        var auth = authorityOf[p.agentName];
        var authInfo = auth
          ? ', authority: #' + auth.rank + ' ' + auth.tier + ' [' + auth.authorityScore.toFixed(2) + '], ' + auth.calibrationLabel : '';
        ctx += '\n[' + p.agentName.toUpperCase() + ' via ' + p.provider + '/' + p.model + '] (Round ' + round +
          ', confidence: ' + confLabel + authInfo + riskInfo + '):\n' + p.content + '\n';
        if (p.reasoningSummary) ctx += 'Reasoning: ' + p.reasoningSummary + '\n';
      });
    });
    return ctx;
  }

  async stepSynthesize(sessionId) {
    var session = this.getSessionOrThrow(sessionId);
    this.expectStatus(session, 'awaiting_synthesis');
    var cfg = session.config;
    var lang = gethDetectPromptLanguage(session.prompt);
    var usable = this.usableProposals(session);
    if (usable.length === 0) throw new Error('Cannot synthesize: every agent failed');

    var tribunalSection = '';
    var challenges = session.tribunal.challenges;
    if (challenges.length > 0) {
      tribunalSection = '\n\n--- TRIBUNAL ANALYSIS ---\nCASSANDRA challenged each agent\'s proposals. Summary:\n\n';
      for (var i = 0; i < challenges.length; i++) {
        tribunalSection += challenges[i].targetAgent + ':\n';
        if (challenges[i].weakness) tribunalSection += '  Challenge: ' + challenges[i].weakness.substring(0, 300) + '\n';
        if (challenges[i].failureScenario) tribunalSection += '  Failure scenario: ' + challenges[i].failureScenario.substring(0, 300) + '\n';
        tribunalSection += '\n';
      }
      var tm = session.tribunal.metrics;
      if (tm) {
        tribunalSection += 'Tribunal outcome: ' + tm.tribunalOutcome + '\n' +
          'ACCEPT: ' + tm.acceptCount + ', REBUT: ' + tm.rebutCount + ', MITIGATE: ' + tm.mitigateCount + '\n' +
          'Genuine engagement: ' + (tm.genuineEngagement * 100).toFixed(0) + '%\n';
      }
      tribunalSection += '\nWhen synthesizing, give MORE weight to:\n' +
        '- Agents who ACCEPTED and REVISED (intellectual honesty under pressure)\n' +
        '- Agents who REBUTTED with specific evidence (not just opinion)\n' +
        'Give LESS weight to:\n' +
        '- Agents who IGNORED challenges (unexamined assumptions)\n' +
        '--- END TRIBUNAL ANALYSIS ---\n';
    }

    var factCheckSection = '';
    if (cfg.factCheckEnabled !== false && !session.factCheck) {
      session.factCheck = await this.runFactCheck(session);
    }
    if (session.factCheck && session.factCheck.claims.length > 0) {
      factCheckSection = '\n\n--- FACT-CHECK NOTES (model-based review, NOT verified against sources) ---\n' +
        session.factCheck.claims.map(function(c) {
          return '- [' + c.status.toUpperCase() + '] ' + c.claim + (c.note ? ' — ' + c.note : '');
        }).join('\n') + '\n--- END FACT-CHECK NOTES ---\n';
    }

    var langSuffix = lang !== 'en' && GETH_LANGUAGE_PATTERNS[lang]
      ? '\n\nIMPORTANT: Write your ENTIRE response in ' + GETH_LANGUAGE_PATTERNS[lang].nativeName + '.' : '';
    // Synthesis intelligence: authority, coverage and conflicts. If it cannot be
    // built the synthesis still happens, with every proposal weighed equally.
    var intelligence = null;
    try {
      intelligence = this.buildSynthesisIntelligence(session);
    } catch (err) {
      session.synthesisIntelligenceError = err.message;
    }
    session.synthesisIntelligence = intelligence ? {
      strategy: intelligence.strategy,
      authorityRankings: intelligence.authorityRankings,
      realConflicts: intelligence.realConflicts,
      domainFlags: intelligence.domainFlags,
    } : null;

    var userMessage = 'Original prompt: ' + session.prompt + '\n' +
      this.buildSynthesisProposalContext(session, intelligence ? intelligence.authorityRankings : []) +
      tribunalSection + factCheckSection +
      '\n\nUsing the research above, write one definitive, comprehensive Markdown answer to the original prompt. ' +
      'Your answer must DIRECTLY respond to the user\'s question as if written by a single expert author. ' +
      'Do NOT reference or compare the individual proposals — merge their best insights into YOUR authoritative answer. ' +
      'Output clean Markdown text, NOT JSON.' + langSuffix;

    // With several providers the least used one writes the synthesis, so the
    // answer is not written by the model that produced most of the proposals.
    var synthProvider;
    if (session.providers.length > 1) {
      var counts = {};
      usable.forEach(function(p) { counts[p.provider] = (counts[p.provider] || 0) + 1; });
      var minCount = Infinity;
      for (var pi = 0; pi < session.providers.length; pi++) {
        var cnt = counts[session.providers[pi]] || 0;
        if (cnt < minCount) { minCount = cnt; synthProvider = session.providers[pi]; }
      }
    }

    this.persistSession(session);
    var instruction = {
      systemPrompt: intelligence
        ? gethBuildIntelligentSynthesisPrompt(intelligence.intelligenceBlock, intelligence.authorityRankings, lang)
        : this.buildSynthesisSystemPrompt(session, lang),
      userMessage: userMessage,
      maxTokens: cfg.synthesisMaxTokens,
      temperature: 0.5,
      factCheck: session.factCheck,
      intelligence: session.synthesisIntelligence,
    };
    if (synthProvider) instruction.provider = synthProvider;
    return instruction;
  }

  /** ATHENA: does the synthesis represent the deliberation? Returns the audit or null. */
  async runAthenaAudit(session, synthesis) {
    session.athenaError = null;
    var usable = this.usableProposals(session);
    var perProposal = Math.floor(16000 / Math.max(usable.length, 1));
    var proposalsSummary = usable.map(function(p) {
      return '[' + p.agentName + ' R' + p.round + ']: ' + gethTrimToCharBudget(p.content, perProposal);
    }).join('\n');
    var challengesText = session.tribunal.challenges.map(function(c) {
      return c.targetAgent + ': ' + [c.weakness, c.counterEvidence, c.failureScenario].filter(Boolean).join(' | ');
    }).join('\n');

    var systemPrompt = 'You are ATHENA, a conservative verification engine.\n' +
      'Your ONLY job: check if the synthesis correctly represents the deliberation.\n\n' +
      'Check for:\n' +
      '1. Omissions: important points from proposals that were dropped\n' +
      '2. Dropped objections: challenges from CASSANDRA that were ignored without justification\n' +
      '3. Fabrications: claims in synthesis not supported by any proposal\n\n' +
      'Output ONLY valid JSON:\n' +
      '{"verdict":"PASS","omissions":[],"droppedObjections":[],"recommendation":""}\n' +
      'or\n' +
      '{"verdict":"FLAG","omissions":["specific omission"],"droppedObjections":["specific objection"],"recommendation":"detailed fix suggestion"}\n\n' +
      'PASS if nothing significant was missed. List the most important omissions and dropped objections first: ' +
      'at most 8 per list, one sentence each. Keep the recommendation under 120 words.';
    // The synthesis is what gets audited, so it is given whole: cut at 16,000
    // characters, a longer answer was reported by ATHENA as "truncated", a
    // finding about this prompt and not about the synthesis. The proposals and
    // the challenges are the reference material, and those are what is trimmed.
    var userMessage = 'Query: ' + session.prompt + '\n\nSynthesis to audit:\n' + gethTrimToCharBudget(synthesis, LOCAL_GETH_ATHENA_SYNTHESIS_CHARS) +
      '\n\nAgent proposals:\n' + proposalsSummary +
      (challengesText ? '\n\nTribunal challenges:\n' + gethTrimToCharBudget(challengesText, 6000) : '');

    try {
      // 1024 tokens cut the list of omissions short on real deliberations.
      var result = await this.orchestratorChat(session, systemPrompt, userMessage, 4096, 'ATHENA');
      var parsed = extractJSON(result.text);
      var truncated = false;
      if (!parsed || (parsed.verdict !== 'PASS' && parsed.verdict !== 'FLAG')) {
        // An answer that ran out of tokens still holds a verdict and findings.
        parsed = gethSalvageAthenaVerdict(result.text);
        truncated = !!parsed;
      }
      if (!parsed) {
        session.athenaError = 'the answer was not a PASS/FLAG verdict';
        return null;
      }
      function strings(list) {
        return Array.isArray(list) ? list.filter(function(s) { return typeof s === 'string' && s.trim(); }) : [];
      }
      return {
        verdict: parsed.verdict,
        omissions: strings(parsed.omissions),
        droppedObjections: strings(parsed.droppedObjections),
        recommendation: typeof parsed.recommendation === 'string' ? parsed.recommendation : '',
        provider: result.provider,
        truncated: truncated,
      };
    } catch (err) {
      session.athenaError = err.message;
      return null;
    }
  }

  async stepSynthesizeResult(sessionId, synthesis, tokenStats) {
    var session = this.getSessionOrThrow(sessionId);
    this.expectStatus(session, 'awaiting_synthesis');
    if (!synthesis || !String(synthesis).trim()) throw new Error('Synthesis content is empty');

    var finalSynthesis = String(synthesis);
    var athena = { active: false };
    if (session.config.athenaEnabled) {
      var audit = await this.runAthenaAudit(session, finalSynthesis);
      if (audit) {
        session.athena = audit;
        athena = {
          active: true,
          verdict: audit.verdict,
          omissions: audit.omissions,
          droppedObjections: audit.droppedObjections,
          model: audit.provider + '/' + this.modelNameFor(audit.provider),
        };
        // Said only when it happened: the list of findings may be incomplete.
        if (audit.truncated) athena.truncated = true;
        var issues = audit.omissions.concat(audit.droppedObjections);
        if (audit.verdict === 'FLAG' && issues.length > 0) {
          finalSynthesis += '\n\n---\n**Audit**: ' + issues.join('; ');
        }
      } else {
        // The audit was asked for and did not happen: say so, never pass silently.
        athena = { active: false, requested: true, reason: session.athenaError || 'unknown' };
      }
    }

    session.synthesis = finalSynthesis;
    session.synthesisTokens = tokenStats || null;
    session.status = 'awaiting_validation';
    this.persistSession(session);
    return { nextStatus: 'awaiting_validation', athena: athena, synthesis: finalSynthesis };
  }

  // -------------------------------------------------------------- validation

  async stepValidate(sessionId) {
    var session = this.getSessionOrThrow(sessionId);
    this.expectStatus(session, 'awaiting_validation');
    if (!session.synthesis) throw new Error('No synthesis found for validation');

    var rubricScale = 'Score the answer on 0.0-1.0 using this rubric:\n' +
      '- 0.0-0.3: Off-topic, factually wrong, or incoherent\n' +
      '- 0.3-0.5: Addresses the prompt but shallow, missing key aspects\n' +
      '- 0.5-0.7: Solid answer covering main points with reasonable depth\n' +
      '- 0.7-0.85: Comprehensive, well-structured, insightful analysis\n';
    var jsonOnly = 'Respond ONLY with JSON: {"score": 0.XX, "reasoning": "brief justification (1-2 sentences)"}';

    var evalSystemPrompt = 'You are a calibrated quality evaluator for multi-agent AI deliberation outputs.\n' +
      rubricScale +
      '- 0.85-1.0: Exceptional — publishable quality, novel cross-domain insights, no gaps\n\n' +
      'Evaluate these 5 dimensions (equal weight):\n' +
      '1. RELEVANCE: Does it directly and precisely answer the prompt?\n' +
      '2. COMPLETENESS: Are ALL aspects of the prompt addressed? Every sub-question answered?\n' +
      '3. COHERENCE: Is it well-structured, logically consistent, and free of contradictions?\n' +
      '4. DEPTH: Does it go beyond surface-level analysis with specific examples, data, or evidence?\n' +
      '5. CROSS-DOMAIN INTEGRATION: Does it connect insights across different domains/perspectives to produce understanding that a single-perspective answer would miss?\n\n' +
      jsonOnly;
    var evalUserMessage = 'Prompt: ' + session.prompt + '\n\nAnswer (' + session.synthesis.length + ' chars):\n' + session.synthesis;

    // The single-agent rubric has no cross-domain dimension: one agent cannot
    // be asked for what only a synthesis of several can give.
    var baselineSystemPrompt = 'You are a calibrated quality evaluator for AI-generated answers.\n' +
      rubricScale.replace('Score the answer', 'Score this SINGLE AGENT\'s answer') +
      '- 0.85-1.0: Exceptional — publishable quality, novel insights, no gaps\n\n' +
      'Evaluate these 4 dimensions (equal weight):\n' +
      '1. RELEVANCE: Does it directly and precisely answer the prompt?\n' +
      '2. COMPLETENESS: Are ALL aspects of the prompt addressed? Every sub-question answered?\n' +
      '3. COHERENCE: Is it well-structured, logically consistent, and free of contradictions?\n' +
      '4. DEPTH: Does it go beyond surface-level analysis with specific examples, data, or evidence?\n\n' +
      'IMPORTANT: This is a SINGLE agent response. Evaluate it on its OWN merits — do not penalize it for lacking perspectives that would require multiple agents.\n\n' +
      jsonOnly;

    var prompt = session.prompt;
    var proposalValidators = this.latestProposalPerAgent(session).map(function(p, idx) {
      return {
        id: 'v_baseline_' + idx,
        agentName: p.agentName,
        systemPrompt: baselineSystemPrompt,
        userMessage: 'Prompt: ' + prompt + '\n\nAnswer by single agent ' + p.agentName + ' (' + p.content.length + ' chars):\n' + p.content,
        maxTokens: 512,
        temperature: 0.1,
      };
    });

    // One validator per provider: with several providers the grade does not
    // come only from the model that wrote the synthesis.
    var validators = session.providers.map(function(prov, i) {
      return { id: 'v' + (i + 1), provider: prov, systemPrompt: evalSystemPrompt, userMessage: evalUserMessage, maxTokens: 512, temperature: 0.1 };
    });

    var result = { validators: validators };
    if (proposalValidators.length > 0) {
      result.bestProposalValidator = proposalValidators[0];
      result.proposalValidators = proposalValidators;
    }
    return result;
  }

  /** Fold the finished session into the local store. A failure here never fails the session. */
  recordFeedback(session, qualityScore) {
    try {
      var latest = this.latestProposalPerAgent(session);
      var capabilityOf = {};
      session.decomposition.tasks.forEach(function(t) { capabilityOf[t.id] = t.capability; });
      for (var i = 0; i < latest.length; i++) {
        var p = latest[i];
        // Consistency: how much of its round-1 answer the agent kept at the end.
        var consistency;
        if (p.round > 1) {
          for (var r1 = 0; r1 < session.proposals.length; r1++) {
            var first = session.proposals[r1];
            if (first.round === 1 && first.agentName === p.agentName) {
              consistency = gethTokenJaccard(first.content, p.content);
              break;
            }
          }
        }
        this.store.recordAgentOutcome(p.agentName, capabilityOf[p.subTaskId] || 'general', qualityScore, consistency);
        this.store.addMemory(p.agentName, qualityScore >= 0.7 ? 'success' : 'insight',
          '[Geth Consensus] Provider: ' + p.provider + '. Quality: ' + (qualityScore * 100).toFixed(0) + '%. ' +
          'Confidence: ' + (p.confidence * 100).toFixed(0) + '%. Key contribution: ' + p.content.substring(0, 180));
      }
      if (latest.length >= 2) {
        var caps = new Set(latest.map(function(lp) { return capabilityOf[lp.subTaskId] || 'general'; }));
        this.store.recordEnsemble(latest.map(function(lp) { return lp.agentName; }), Array.from(caps), qualityScore);
      }
      this.store.save();
      return null;
    } catch (err) {
      return err.message;
    }
  }

  /** Key under which an agent's learned patterns are stored: its file name. */
  evolutionKey(agentName) {
    var entry = this.getCatalogEntry(agentName);
    return entry ? entry.fileName : String(agentName).toLowerCase();
  }

  /**
   * Prompt evolution: score the patterns each agent already had against the
   * quality just measured, then ask the model for one new pattern per agent.
   * Returns the number of agents updated. A failure never fails the session.
   */
  async evolvePrompts(session, qualityScore) {
    if (!this.promptEvolver) return 0;
    var self = this;
    var llmAdapter = {
      chat: function(systemPrompt, userMessage, opts) {
        return self.orchestratorChat(session, systemPrompt, userMessage, (opts && opts.maxTokens) || 64, 'prompt-evolution')
          .then(function(r) { return r.text; });
      },
    };
    var latest = this.latestProposalPerAgent(session);
    var updated = 0;
    for (var i = 0; i < latest.length; i++) {
      var key = this.evolutionKey(latest[i].agentName);
      try {
        this.promptEvolver.updatePatternScores(key, qualityScore);
        await this.promptEvolver.proposeEvolution(key, latest[i].content.substring(0, 1500), qualityScore, llmAdapter);
        this.promptEvolver.save(key);
        updated++;
      } catch (_) { /* one agent's evolution failing must not stop the others */ }
    }
    return updated;
  }

  async stepValidateResult(sessionId, scores, bestProposalScore) {
    var session = this.getSessionOrThrow(sessionId);
    this.expectStatus(session, 'awaiting_validation');
    if (!Array.isArray(scores)) throw new Error('Validation scores are required');

    var validationScores = scores.map(function(s) {
      var score = Number(s.score);
      return {
        validatorId: s.validatorId,
        provider: s.provider,
        model: s.model,
        score: isFinite(score) ? Math.max(0, Math.min(1, score)) : 0.5,
        reasoning: s.reasoning && String(s.reasoning).trim() ? String(s.reasoning) : 'No reasoning provided',
      };
    });

    // Quality is the median of the validators.
    var sorted = validationScores.map(function(s) { return s.score; }).sort(function(a, b) { return a - b; });
    var qualityScore = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0.5;

    // CI gain: synthesis quality against the best single proposal.
    var ciGain = null;
    var baseline = Number(bestProposalScore);
    if (bestProposalScore !== undefined && bestProposalScore !== null && isFinite(baseline)) {
      baseline = Math.max(0, Math.min(1, baseline));
      ciGain = Math.round(((qualityScore - baseline) / Math.max(baseline, 0.3)) * 100);
    }

    var crossRoundConvergence = [];
    var round1 = session.proposals.filter(function(p) { return p.round === 1; });
    var round2 = session.proposals.filter(function(p) { return p.round === 2 && !p.tribunalPhaseA; });
    for (var i = 0; i < round2.length; i++) {
      for (var j = 0; j < round1.length; j++) {
        if (round1[j].agentName === round2[i].agentName) {
          crossRoundConvergence.push({ agent: round2[i].agentName, round1to2: gethTokenJaccard(round1[j].content, round2[i].content) });
          break;
        }
      }
    }

    var providersUsed = Array.from(new Set(session.proposals.map(function(p) { return p.provider; })
      .filter(function(p) { return p && p !== 'unknown'; })));
    var totalDurationMs = Date.now() - new Date(session.createdAt).getTime();

    session.result = {
      qualityScore: qualityScore,
      ciGain: ciGain,
      baselineScore: ciGain === null ? null : baseline,
      finalConvergence: session.finalConvergence || 0,
      validationScores: validationScores,
      crossRoundConvergence: crossRoundConvergence,
      providersUsed: providersUsed,
      totalDurationMs: totalDurationMs,
      completedAt: new Date().toISOString(),
    };
    session.status = 'completed';
    session.feedbackError = this.recordFeedback(session, qualityScore);
    session.promptsEvolved = await this.evolvePrompts(session, qualityScore);
    this.persistSession(session);

    return {
      status: 'completed',
      qualityScore: qualityScore,
      ciGain: ciGain,
      finalConvergence: session.finalConvergence || 0,
      totalDurationMs: totalDurationMs,
    };
  }

  // ------------------------------------------------------- stored sessions

  /** Sessions saved on this machine, newest first: [{ id, status, prompt, createdAt, qualityScore, rounds }]. */
  listStoredSessions(limit) {
    if (!fs.existsSync(this.sessionsDir)) return [];
    var out = [];
    var files = fs.readdirSync(this.sessionsDir).filter(function(f) { return f.endsWith('.json'); });
    for (var i = 0; i < files.length; i++) {
      try {
        var s = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, files[i]), 'utf-8'));
        out.push({
          id: s.id,
          status: s.status,
          prompt: s.prompt,
          createdAt: s.createdAt,
          qualityScore: s.result ? s.result.qualityScore : null,
          ciGain: s.result ? s.result.ciGain : null,
          rounds: s.roundsCompleted || 0,
          agents: (s.assignments || []).length,
        });
      } catch (_) { /* unreadable file: skip it, the listing must still work */ }
    }
    out.sort(function(a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    return limit ? out.slice(0, limit) : out;
  }

  /** A stored session by id or unique id prefix. Throws when missing or ambiguous. */
  loadStoredSession(idOrPrefix) {
    var matches = this.listStoredSessions().filter(function(s) { return s.id.indexOf(idOrPrefix) === 0; });
    if (matches.length === 0) throw new Error('Session not found: ' + idOrPrefix);
    if (matches.length > 1) throw new Error('Ambiguous prefix, matches ' + matches.length + ' sessions');
    return JSON.parse(fs.readFileSync(path.join(this.sessionsDir, matches[0].id + '.json'), 'utf-8'));
  }
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
async function runClientOrchestration(prompt, options, legionConfig, client, sharedLlm) {
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

  console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Local orchestration mode');
  console.log(colors.gray + 'The whole deliberation runs on this machine. Only your own LLM provider is contacted.' + colors.reset);
  console.log();

  // 1. Initialize local LLM provider (shared with the orchestrator, so token usage is counted once)
  var llm = sharedLlm || new LLMProvider(legionConfig);
  if (llm.getAvailableProviders().length === 0) {
    console.error(colors.red + 'ERROR: No LLM provider configured.' + colors.reset);
    console.error('Use a local model:  node legion-x.mjs config:set llm-provider ollama');
    console.error('Or an API key:      node legion-x.mjs config:set llm-key YOUR_API_KEY');
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
  if (legionConfig.get('factCheckEnabled') === false) sessionConfig.factCheckEnabled = false;
  // Economy mode trades reading depth for tokens: each agent reads the first
  // 3,000 characters of every other proposal, and the synthesizer reads only
  // the final position of each agent. Measured on one real deliberation: see versions.json.
  var economy = !!options.economy || legionConfig.get('economy') === true;
  var crossReadingChars = parseInt(legionConfig.get('crossReadingChars'), 10);
  if (isFinite(crossReadingChars) && crossReadingChars > 0) sessionConfig.crossReadingChars = crossReadingChars;
  else if (economy) sessionConfig.crossReadingChars = 3000;
  if (economy) sessionConfig.synthesisLatestOnly = true;
  if (economy) {
    console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Economy mode: cross-reading capped at ' + sessionConfig.crossReadingChars + ' characters per proposal, synthesis from final positions');
  }

  var availableProviders = llm.getAvailableProviders();
  var userProvider = legionConfig.get('provider') || legionConfig.get('llmProvider') || availableProviders[0];
  // The configured provider may have no key: fall back to one that can answer.
  if (availableProviders.indexOf(userProvider) === -1) userProvider = availableProviders[0];
  var isMultiProvider = availableProviders.length > 1;
  var providerMode = isMultiProvider ? 'multi' : 'single';
  var providers = isMultiProvider ? availableProviders : [userProvider];

  if (isMultiProvider) {
    console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Multi-LLM mode: ' + colors.magenta + availableProviders.join(' + ') + colors.reset + ' (local execution)');
  } else {
    console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Provider: ' + colors.magenta + userProvider + colors.reset + ' (local execution)');
  }

  // 3. Create the session on this machine
  console.log(colors.cyan + '[LEGION X]' + colors.reset + ' Creating local session...');
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

  // The per-agent counters are cumulative across rounds: what one call cost is
  // the difference between a reading taken before it and one taken after.
  function tokensSince(before, llmProvider, agentTag) {
    var after = getTokenStats(llmProvider, agentTag);
    return { inputTokens: after.inputTokens - before.inputTokens, outputTokens: after.outputTokens - before.outputTokens };
  }

  try {
    // ========================================================================
    // Step 1: DECOMPOSITION
    // ========================================================================
    console.log('\x1b[36m[DECOMPOSE]  \x1b[0mBuilding decomposition prompt...');
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
          decompErr.message.includes('503') ||
          decompErr.message.includes('529') ||
          decompErr.message.includes('overloaded') ||
          decompErr.message.includes('Overloaded') ||
          decompErr.message.includes('RESOURCE_EXHAUSTED') ||
          decompErr.message.includes('UNAVAILABLE') ||
          decompErr.message.includes('high demand') ||
          decompErr.message.includes('rate')
        );
        if (isDecompRetryable && dpi < decompProviderOrder.length - 1) {
          console.log('\x1b[36m[DECOMPOSE]  \x1b[0m' + colors.yellow + tryDecompProv + ' unavailable (' +
            (decompErr.message.includes('529') || decompErr.message.includes('503') || decompErr.message.includes('overloaded') || decompErr.message.includes('Overloaded') || decompErr.message.includes('UNAVAILABLE') || decompErr.message.includes('high demand') ? 'overloaded' : 'rate-limited') +
            '), trying ' + decompProviderOrder[dpi + 1] + '...' + colors.reset);
          continue;
        }
        throw decompErr;
      }
    }

    var decomposition = extractJSON(decompRaw);
    if (!decomposition || !decomposition.tasks) {
      // The usual cause is an answer cut off by the token limit: keep the tasks that are complete.
      decomposition = gethSalvageDecomposition(decompRaw);
      if (decomposition) {
        console.log('\x1b[36m[DECOMPOSE]  \x1b[0m' + colors.yellow + 'The model\'s answer was cut off: kept the ' + decomposition.tasks.length + ' complete sub-task(s)' + colors.reset);
      }
    }
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
    console.log('\x1b[36m[ROUTING]    \x1b[0mPROMETHEUS is selecting agents...');
    var decompResult = await client.stepDecomposeResult(sessionId, decomposition, decompStats);
    if (decompResult.routingNote) {
      console.log('\x1b[36m[ROUTING]    \x1b[0m' + colors.yellow + 'PROMETHEUS gave no usable decision (' + decompResult.routingNote + '): agents matched by capability' + colors.reset);
    }
    var domainSwaps = decompResult.domainReplacements || [];
    for (var dsi = 0; dsi < domainSwaps.length; dsi++) {
      console.log('\x1b[36m[ROUTING]    \x1b[0m' + colors.yellow + 'Domain guardrail (' + decompResult.domain.family + '): ' +
        domainSwaps[dsi].from + ' replaced by ' + domainSwaps[dsi].to + colors.reset);
    }

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
    var routingLabel = decompResult.routingMethod === 'prometheus'
      ? '\x1b[1;35mPROMETHEUS routing\x1b[0m'
      : '\x1b[36mCapability-match routing\x1b[0m';
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
      console.log('\x1b[33m[ROUND ' + round + ']    \x1b[0mBuilding agent prompts...');

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
          var cassTokensBefore = getTokenStats(llm, 'CASSANDRA');
          var cassandraResult;
          try {
            var cassProv = cassandraInstr.provider || userProvider;
            console.log('\x1b[35m[TRIBUNAL]   \x1b[0mCASSANDRA \u2192 ' + cassProv);
            cassandraResult = await llm.chatWithProvider(cassProv, cassandraInstr.systemPrompt, cassandraInstr.userMessage, {
              maxTokens: cassandraInstr.maxTokens || 4096,
              agentTag: 'CASSANDRA',
            });
          } catch (cassErr) {
            console.error('\x1b[31m[TRIBUNAL]   CASSANDRA failed: ' + cassErr.message + '\x1b[0m');
            cassandraResult = 'Error: ' + cassErr.message;
          }

          var cassDuration = Date.now() - cassandraStart;
          var cassStats = tokensSince(cassTokensBefore, llm, 'CASSANDRA');
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

          // The saved transcript must contain the challenges the agents answered.
          allProposals.push(Object.assign({ round: round }, cassandraProposal[0]));

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
          var agentTokensBefore = getTokenStats(llm, agentTag);
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
                  agentProvErr.message.includes('503') ||
                  agentProvErr.message.includes('529') ||
                  agentProvErr.message.includes('overloaded') ||
                  agentProvErr.message.includes('Overloaded') ||
                  agentProvErr.message.includes('RESOURCE_EXHAUSTED') ||
                  agentProvErr.message.includes('UNAVAILABLE') ||
                  agentProvErr.message.includes('high demand') ||
                  agentProvErr.message.includes('rate')
                );
                if (isAgentRetryable && api < agentProviderOrder.length - 1) {
                  continue;
                }
                throw agentProvErr;
              }
            }

            var agentDuration = Date.now() - agentStart;
            var stats = tokensSince(agentTokensBefore, llm, agentTag);

            // Parse structured output (confidence, risk_flags, reasoning_summary)
            var parsedOutput = parseStructuredOutput(agentResponse);

            // Ensure content is always a string (never an object from JSON parsing)
            var answerContent = typeof parsedOutput.answer === 'string'
              ? parsedOutput.answer
              : JSON.stringify(parsedOutput.answer);

            // An empty answer is a failed agent, not a proposal with 70% confidence.
            if (!answerContent || !String(answerContent).trim()) {
              throw new Error('the model returned an empty answer');
            }

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
          var provResults = new Array(provAgents.length);
          // A local runtime serves one request at a time; a cloud provider can
          // take a few at once ('parallelism', 3 by default).
          var isLocalRuntime = provKey === 'ollama' || provKey.indexOf('ollama:') === 0 || provKey === 'local-openai';
          var configured = parseInt(legionConfig.get('parallelism'), 10);
          var limit = isLocalRuntime ? 1 : Math.max(1, Math.min(isFinite(configured) ? configured : 3, 8));
          var next = 0;
          async function worker() {
            while (next < provAgents.length) {
              var index = next++;
              provResults[index] = await executeSingleAgent(provAgents[index]);
            }
          }
          var workers = [];
          for (var wi = 0; wi < Math.min(limit, provAgents.length); wi++) workers.push(worker());
          await Promise.all(workers);
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
      console.log('\x1b[33m[ROUND ' + round + ']    \x1b[0mMeasuring convergence...');
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
          console.log('\x1b[35m[LIARA]      \x1b[0mConvergence says stop at round ' + round + ', forcing round ' + (round + 1) + ' (min ' + liaraMinRounds + ')');
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

    console.log('\x1b[36m[SYNTHESIS]  \x1b[0mFact check and synthesis prompt...');
    var synthInstr = await client.stepSynthesize(sessionId);
    if (synthInstr.factCheck) {
      var fcClaims = synthInstr.factCheck.claims;
      console.log('\x1b[36m[FACT-CHECK] \x1b[0m' + fcClaims.length + ' claim(s) flagged by ' + colors.magenta + synthInstr.factCheck.provider + colors.reset +
        ' \x1b[90m(model-based review, not verified against sources)\x1b[0m');
      for (var fci = 0; fci < fcClaims.length; fci++) {
        console.log('  \x1b[33m' + fcClaims[fci].status.toUpperCase() + '\x1b[0m ' + fcClaims[fci].claim +
          (fcClaims[fci].note ? ' \x1b[90m— ' + fcClaims[fci].note + '\x1b[0m' : ''));
      }
    } else if (legionConfig.get('factCheckEnabled') !== false) {
      console.log('\x1b[36m[FACT-CHECK] \x1b[0m' + colors.yellow + 'not available for this session (the provider gave no usable answer)' + colors.reset);
    }

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
        var isSynthRetryable = synthErr.message && (synthErr.message.includes('429') || synthErr.message.includes('503') || synthErr.message.includes('529') || synthErr.message.includes('overloaded') || synthErr.message.includes('Overloaded') || synthErr.message.includes('RESOURCE_EXHAUSTED') || synthErr.message.includes('UNAVAILABLE') || synthErr.message.includes('high demand') || synthErr.message.includes('rate') || synthErr.message.includes('max_tokens') || synthErr.message.includes('invalid_request'));
        if (isSynthRetryable && spi < synthProviderOrder.length - 1) {
          console.log('\x1b[36m[SYNTHESIS]  \x1b[0m' + colors.yellow + tryProv + ' failed, trying ' + synthProviderOrder[spi + 1] + '...' + colors.reset);
          continue;
        }
        throw synthErr;
      }
    }

    var synthStats = getTokenStats(llm, '_synthesis');
    var synthResponse = await client.stepSynthesizeResult(sessionId, synthRaw, synthStats);
    // The stored synthesis carries the ATHENA audit note when the audit flagged something.
    if (synthResponse && typeof synthResponse.synthesis === 'string') synthRaw = synthResponse.synthesis;
    console.log('\x1b[36m[SYNTHESIS]  \x1b[0mSynthesis complete (' + synthRaw.length + ' chars)');
    renderSynthBubble(synthProvider, synthRaw);

    // Display ATHENA audit result if it ran
    var athenaInfo = synthResponse && synthResponse.athena;
    if (athenaInfo && !athenaInfo.active && athenaInfo.requested) {
      console.log('\x1b[35m[PARLIAMENT] \x1b[0m' + colors.yellow + 'ATHENA audit did not run (' + (athenaInfo.reason || 'unknown reason') + '): the synthesis was NOT audited' + colors.reset);
    }
    if (athenaInfo && athenaInfo.active) {
      var athenaVerdict = athenaInfo.verdict === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFLAG\x1b[0m';
      console.log('\x1b[35m[PARLIAMENT] \x1b[0mATHENA (\x1b[35m' + (athenaInfo.model || 'unknown model') + '\x1b[0m) audit: ' + athenaVerdict);
      if (athenaInfo.truncated) {
        console.log('  ' + colors.yellow + 'The audit answer was cut off: the findings below may not be all of them.' + colors.reset);
      }
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
    console.log('\x1b[35m[VALIDATION] \x1b[0mBuilding validation prompts...');
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
            var isValRL = valRetryErr.message && (valRetryErr.message.includes('429') || valRetryErr.message.includes('503') || valRetryErr.message.includes('529') || valRetryErr.message.includes('overloaded') || valRetryErr.message.includes('Overloaded') || valRetryErr.message.includes('RESOURCE_EXHAUSTED') || valRetryErr.message.includes('UNAVAILABLE') || valRetryErr.message.includes('high demand') || valRetryErr.message.includes('rate'));
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
              var isBpRL = bpRetryErr.message && (bpRetryErr.message.includes('429') || bpRetryErr.message.includes('503') || bpRetryErr.message.includes('529') || bpRetryErr.message.includes('overloaded') || bpRetryErr.message.includes('Overloaded') || bpRetryErr.message.includes('RESOURCE_EXHAUSTED') || bpRetryErr.message.includes('UNAVAILABLE') || bpRetryErr.message.includes('high demand') || bpRetryErr.message.includes('rate'));
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
    console.log('\x1b[35m[VALIDATION] \x1b[0mComputing final quality...');
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
    console.log(colors.bold + colors.green + '=== LEGION X CONSENSUS RESULT ===' + colors.reset);
    console.log();
    console.log(synthRaw || '[No synthesis]');
    console.log();

    // Stats
    console.log(colors.bold + '--- Stats ---' + colors.reset);
    console.log('Quality: ' + colors.cyan + qualityPct + '%' + colors.reset +
      ' | CI Gain: ' + colors.cyan + ciGain + '%' + colors.reset +
      ' | Convergence: ' + colors.cyan + convergencePct + '%' + colors.reset +
      ' | Rounds: ' + colors.cyan + round + colors.reset);
    console.log('Providers: ' + colors.magenta + availableProviders.join(' + ') + colors.reset + ' (the only hosts contacted during this deliberation)');

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
    console.log(colors.gray + '  Fact-check  ' + colors.reset + 'A model reviewed the claims. Nothing was verified against external sources.');
    console.log(colors.gray + '  Local       ' + colors.reset + 'Orchestration, convergence and scoring ran on this machine.');

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
        orchestrationMode: 'local',
        prompt: prompt,
        status: 'completed',
        provider: userProvider,
        // Model-based review of the agents' claims. Not verified against sources.
        factCheck: synthInstr.factCheck || null,
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
          cassandra: (function() {
            var cass = assignments.filter(function(a) { return a.agentName === 'CASSANDRA'; })[0];
            return cass ? { active: true, provider: cass.provider, model: cass.model, serverSide: false } : { active: false };
          })(),
          // The saved deliberation keeps what the audit found, and says when
          // an audit was asked for and did not happen.
          athena: athenaInfo && athenaInfo.active ? {
            active: true,
            verdict: athenaInfo.verdict,
            model: athenaInfo.model,
            omissions: athenaInfo.omissions || [],
            droppedObjections: athenaInfo.droppedObjections || [],
            truncated: athenaInfo.truncated === true,
          } : (athenaInfo && athenaInfo.requested
            ? { active: false, requested: true, reason: athenaInfo.reason || 'unknown' }
            : { active: false }),
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
      var md = '# Legion X Session — ' + now.toISOString().slice(0, 19).replace('T', ' ') + ' UTC\n';
      md += '## Session ID: ' + sessionId + '\n\n';
      md += '### Prompt\n> ' + prompt.replace(/\n/g, '\n> ') + '\n\n';
      md += '### Configuration\n';
      md += '- Orchestration: local (this machine)\n';
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
    if (!answerMatch) {
      // No closing quote: the output was cut off inside the answer. Keep what
      // was written and flag it, instead of passing the JSON wrapper on as text.
      var cutMatch = rawResponse.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)/s);
      if (cutMatch && cutMatch[1].length > 0) {
        result.answer = cutMatch[1].replace(/\\$/, '')
          .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        result.riskFlags = ['truncated_output'];
      }
    }
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
// Run command — local orchestration entry point
// =============================================================================

async function runOrchestration(prompt, options) {
  var config = new LegionConfig();

  // A deliberation needs no account and no server: only an LLM provider.
  // Run on its own, Legion reuses the LLM keys already set up for the nha
  // toolkit when it has no provider of its own. Launched by `nha` it never
  // does: the toolkit hands over a complete config (NHA_CONFIG_FILE), and a
  // provider chosen there must not be replaced by a key found elsewhere.
  if (!process.env.NHA_CONFIG_FILE && !config.get('llmApiKey') && !config.get('provider')) {
    var nhaConfigPath = path.join(os.homedir(), '.nha', 'config.json');
    if (fs.existsSync(nhaConfigPath)) {
      try {
        var nhaConf = JSON.parse(fs.readFileSync(nhaConfigPath, 'utf-8'));
        if (nhaConf.llm && nhaConf.llm.apiKey && CLOUD_PROVIDER_KEYS[nhaConf.llm.provider]) {
          config.set('provider', nhaConf.llm.provider);
          config.set('llmApiKey', nhaConf.llm.apiKey);
          // Stored under the names LLMProvider reads.
          if (nhaConf.llm.openaiKey) config.set('openaiApiKey', nhaConf.llm.openaiKey);
          if (nhaConf.llm.geminiKey) config.set('geminiApiKey', nhaConf.llm.geminiKey);
          if (nhaConf.llm.deepseekKey) config.set('deepseekApiKey', nhaConf.llm.deepseekKey);
          if (nhaConf.llm.grokKey) config.set('grokApiKey', nhaConf.llm.grokKey);
          if (nhaConf.llm.mistralKey) config.set('mistralApiKey', nhaConf.llm.mistralKey);
          if (nhaConf.llm.cohereKey) config.set('cohereApiKey', nhaConf.llm.cohereKey);
        }
      } catch (_) { /* an unreadable toolkit config is not a reason to stop */ }
    }
  }

  printBanner();

  if (options.serverKey) {
    console.error(colors.red + '--server-key is no longer available.' + colors.reset);
    console.error('That mode sent your API key to the NHA server, which no longer runs deliberations.');
    console.error('Run without the flag: the whole deliberation runs on this machine.');
    process.exit(1);
  }

  var localLlm = new LLMProvider(config);
  // Prompt evolution: what each agent learned in past sessions goes into its prompt.
  var promptEvolver = null;
  if (config.get('promptEvolutionEnabled') !== false && !options.noPromptEvolution) {
    promptEvolver = new PromptEvolver(path.join(process.env.HOME || '.', '.legion'));
    await promptEvolver.load();
  }
  var orchestrator = new LocalGethOrchestrator(localLlm, {
    orchestratorProvider: config.get('orchestratorProvider') || null,
    promptEvolver: promptEvolver,
  });
  await runClientOrchestration(prompt, options, config, orchestrator, localLlm);
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
  // The version check is the only request Legion makes to nothumanallowed.com.
  // It can be switched off: LEGION_NO_UPDATE_CHECK=1, or config:set update-check false.
  if (process.env.LEGION_NO_UPDATE_CHECK === '1' || new LegionConfig().get('updateCheck') === false) return;
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
    description: 'Execute prompt via Geth Consensus, on this machine',
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
        } else if (args[i] === '--economy') {
          options.economy = true;
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

      var registry = new AgentRegistry();
      await registry.initialize(null);

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
        console.log('  provider      - LLM provider (ollama, local-openai, anthropic, openai, gemini, deepseek, grok, mistral, cohere)');
        console.log('  ollama-url    - Ollama address (default http://localhost:11434)');
        console.log('  ollama-model  - The local model to use');
        console.log('  ollama-models - Several local models, comma separated: agents are spread across them');
        console.log('  ollama-embed-model - Local embedding model for the convergence measurement (optional)');
        console.log('  local-openai-url   - Chat completions URL of a local OpenAI-compatible server');
        console.log('  local-openai-model - Model name for that server');
        console.log('  local-openai-key   - Key for that server, if it wants one');
        console.log('  llm-key       - Your API key for the primary cloud provider');
        console.log('  anthropic-key - Anthropic API key');
        console.log('  openai-key    - OpenAI API key (for multi-LLM mode)');
        console.log('  gemini-key    - Gemini API key (for multi-LLM mode)');
        console.log('  deepseek-key  - DeepSeek API key');
        console.log('  grok-key      - Grok/xAI API key');
        console.log('  mistral-key   - Mistral API key');
        console.log('  cohere-key    - Cohere API key');
        console.log('  orchestrator-provider - Provider that runs PROMETHEUS, the fact check and ATHENA');
        console.log('  fact-check    - Model-based fact check before synthesis, ON by default (true/false)');
        console.log('  update-check  - Version check against nothumanallowed.com, ON by default (true/false)');
        console.log('  economy       - Fewer tokens: capped cross-reading, synthesis from final positions (true/false). Also: run --economy');
        console.log('  cross-reading-chars - Characters each agent reads of every other proposal (0 = all)');
        console.log('  verbose       - Verbose logging, ON by default (true/false)');
        console.log();
        console.log(colors.gray + 'Deliberations run on this machine. Keys are stored in ' + CONFIG_FILE + ' (0600).' + colors.reset);
        console.log(colors.gray + 'Configure several providers and the agents are spread across them.' + colors.reset);
        process.exit(1);
      }

      var keyMap = {
        'provider': 'provider',
        'verbose': 'verbose',
        'ollama-models': 'ollamaModels',
        'ollama-embed-model': 'ollamaEmbedModel',
        'local-openai-url': 'localOpenaiUrl',
        'local-openai-model': 'localOpenaiModel',
        'local-openai-key': 'localOpenaiKey',
        'anthropic-key': 'anthropicApiKey',
        'openai-key': 'openaiApiKey',
        'gemini-key': 'geminiApiKey',
        'orchestrator-provider': 'orchestratorProvider',
        'fact-check': 'factCheckEnabled',
        'update-check': 'updateCheck',
        'economy': 'economy',
        'cross-reading-chars': 'crossReadingChars',
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
        var validProviders = ['ollama', 'local-openai', 'anthropic', 'openai', 'gemini', 'deepseek', 'grok', 'mistral', 'cohere'];
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
      } else if (configKey === 'crossReadingChars') {
        value = parseInt(value, 10);
        if (!isFinite(value) || value < 0) {
          console.error(colors.red + 'cross-reading-chars must be a number of characters (0 = no cap)' + colors.reset);
          process.exit(1);
        }
      } else if (['verbose', 'factCheckEnabled', 'updateCheck', 'economy'].includes(configKey)) {
        value = value === 'true';
      }

      var config = new LegionConfig();
      config.set(configKey, value);
      console.log(colors.green + 'Set ' + key + ' = ' + (typeof value === 'string' && key.includes('key') ? '***' : value) + colors.reset);
    },
  },

  doctor: {
    description: 'Health check (LLM providers, agents)',
    args: '',
    handler: async function() {
      printBanner();
      console.log(colors.bold + 'System Health Check' + colors.reset + '\n');

      var config = new LegionConfig();
      var checks = [];

      // 1. Config file
      var configExists = fs.existsSync(CONFIG_FILE);
      checks.push({ name: 'Config file', status: configExists ? 'ok' : 'missing', detail: CONFIG_FILE });

      // 2. Every configured LLM provider must answer: a deliberation uses all of them.
      var llm = new LLMProvider(config);
      var doctorProviders = llm.getAvailableProviders();
      for (var dp = 0; dp < doctorProviders.length; dp++) {
        var providerLabel = 'LLM ' + doctorProviders[dp] + ' (' + llm.getModelFor(doctorProviders[dp]) + ')';
        try {
          var reply = await llm.chatWithProvider(doctorProviders[dp], 'Reply with OK', 'Test', { maxTokens: 64 });
          checks.push({ name: providerLabel, status: reply && reply.trim() ? 'ok' : 'error', detail: reply && reply.trim() ? 'Response received' : 'Empty response' });
        } catch (err) {
          checks.push({ name: providerLabel, status: 'error', detail: err.message });
        }
      }

      // 3. Agent files
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

      // 4. Agents directory
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

  // Geth Consensus commands
  'geth:providers': {
    description: 'Show the LLM providers configured on this machine',
    args: '',
    handler: async function() {
      var llm = new LLMProvider(new LegionConfig());
      var providers = llm.getAvailableProviders();
      console.log(colors.bold + 'Legion X — Providers configured on this machine' + colors.reset);
      console.log();
      for (var i = 0; i < providers.length; i++) {
        console.log('  ' + colors.magenta + providers[i] + colors.reset +
          ' — model: ' + colors.gray + llm.getModelFor(providers[i]) + colors.reset);
      }
      console.log();
      console.log(colors.gray + 'Local model:        node legion-x.mjs config:set llm-provider ollama' + colors.reset);
      console.log(colors.gray + 'Several local ones: node legion-x.mjs config:set ollama-models llama3.1,qwen2.5,mistral' + colors.reset);
      console.log(colors.gray + 'API key:            node legion-x.mjs config:set llm-key YOUR_API_KEY' + colors.reset);
    },
  },

  'geth:sessions': {
    description: 'List the Geth Consensus sessions saved on this machine',
    args: '[--status <status>] [--limit <n>]',
    handler: async function(args) {
      var status = null;
      var limit = 0;
      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--status' && args[i + 1]) { status = args[i + 1]; i++; }
        else if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[i + 1], 10) || 0; i++; }
      }
      var orchestrator = new LocalGethOrchestrator(null);
      var sessions = orchestrator.listStoredSessions();
      if (status) sessions = sessions.filter(function(s) { return s.status === status; });
      if (limit > 0) sessions = sessions.slice(0, limit);
      console.log(colors.bold + 'Geth Sessions (' + sessions.length + ')' + colors.reset +
        colors.gray + '  ' + LOCAL_GETH_SESSIONS_DIR + colors.reset + '\n');
      for (var j = 0; j < sessions.length; j++) {
        var s = sessions[j];
        var sc = s.status === 'completed' ? colors.green : colors.yellow;
        console.log(colors.cyan + s.id + colors.reset +
          ' ' + sc + s.status + colors.reset +
          (s.qualityScore !== null ? ' quality:' + ((s.qualityScore * 100).toFixed(0)) + '%' : '') +
          (s.rounds ? ' rounds:' + s.rounds : '') +
          ' agents:' + s.agents +
          ' ' + colors.gray + new Date(s.createdAt).toLocaleString() + colors.reset);
        console.log(colors.gray + '  ' + (s.prompt || '').substring(0, 80) + colors.reset);
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
      try {
        // Sessions are read from this machine; an id prefix is enough when it is unique.
        var stored = new LocalGethOrchestrator(null).loadStoredSession(sessionId.toLowerCase());
        var storedResult = stored.result || {};
        var s = {
          id: stored.id,
          status: stored.status,
          prompt: stored.prompt,
          synthesis: stored.synthesis,
          qualityScore: storedResult.qualityScore !== undefined ? storedResult.qualityScore : null,
          ciGain: storedResult.ciGain !== undefined ? storedResult.ciGain : null,
          finalConvergence: stored.finalConvergence !== undefined ? stored.finalConvergence : null,
          deliberationRounds: stored.roundsCompleted || 0,
          providersUsed: storedResult.providersUsed || null,
          totalDurationMs: storedResult.totalDurationMs || 0,
          proposals: stored.proposals || [],
        };
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
          var proposals = s.proposals;
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
    description: 'Not available: resuming was a server feature',
    args: '<id>',
    handler: async function() {
      // Resuming re-ran synthesis on the NHA server with the user's key. The
      // local orchestrator saves every step, but cannot yet restart from one.
      console.error(colors.red + 'geth:resume is not available.' + colors.reset);
      console.error('Deliberations now run on this machine, and an interrupted one cannot be resumed yet.');
      console.error('What it had collected is saved: ' + colors.cyan + 'node legion-x.mjs geth:session <id> --proposals' + colors.reset);
      process.exit(1);
    },
  },

  'geth:usage': {
    description: 'Show Geth Consensus usage on this machine, by day',
    args: '[--days <n>]',
    handler: async function(args) {
      var days = 30;
      for (var i = 0; i < args.length; i++) {
        if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[i + 1], 10) || 30; i++; }
      }
      var orchestrator = new LocalGethOrchestrator(null);
      var since = Date.now() - days * 24 * 60 * 60 * 1000;
      var byDay = {};
      var listed = orchestrator.listStoredSessions();
      for (var j = 0; j < listed.length; j++) {
        if (new Date(listed[j].createdAt).getTime() < since) continue;
        var full = orchestrator.loadStoredSession(listed[j].id);
        var day = String(full.createdAt).slice(0, 10);
        if (!byDay[day]) byDay[day] = { sessions: 0, completed: 0, tokens: 0 };
        byDay[day].sessions++;
        if (full.status === 'completed') byDay[day].completed++;
        // Agent tokens only: orchestration, synthesis and validation calls are not in the saved state.
        (full.proposals || []).forEach(function(p) { byDay[day].tokens += (p.inputTokens || 0) + (p.outputTokens || 0); });
      }
      var dayKeys = Object.keys(byDay).sort().reverse();
      console.log(colors.bold + 'Legion X — Usage on this machine (' + days + ' days)' + colors.reset + '\n');
      if (dayKeys.length === 0) {
        console.log(colors.dim + '  No session found.' + colors.reset);
      }
      for (var k = 0; k < dayKeys.length; k++) {
        var u = byDay[dayKeys[k]];
        console.log('  ' + colors.cyan + dayKeys[k] + colors.reset +
          ' | sessions: ' + u.sessions + ' (completed: ' + u.completed + ')' +
          ' | agent tokens: ' + u.tokens.toLocaleString());
      }
    },
  },

  help: {
    description: 'Show help',
    args: '',
    handler: async function() {
      printBanner();
      console.log(colors.bold + 'USAGE:' + colors.reset + ' node legion-x.mjs <command> [options]\n');
      console.log(colors.gray + 'Legion X runs on this machine with YOUR models. No account, no server.' + colors.reset);
      console.log(colors.gray + 'Local: Ollama (one or several models), any OpenAI-compatible endpoint' + colors.reset);
      console.log(colors.gray + 'Cloud: Anthropic, OpenAI, Gemini, DeepSeek, Grok, Mistral, Cohere' + colors.reset);
      console.log();

      var sections = {
        'ORCHESTRATION': ['run', 'evolve'],
        'AGENTS': ['agents', 'agents:info', 'agents:test', 'agents:tree'],
        'GETH CONSENSUS': ['geth:providers', 'geth:sessions', 'geth:session', 'geth:resume', 'geth:usage'],
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

  mcp: {
    description: 'Start MCP server for IDE integration',
    args: '',
    handler: async function() {
      var server = new LegionMCPServer();
      await server.start();
    },
  },
};

// ============================================================================
// Section 11: MCP Server
// ============================================================================

class LegionMCPServer {
  constructor() {
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
          await registry.initialize(null);

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
          // Real deliberation, not one parallel pass: proposals, cross-reading,
          // refinement, convergence check, mediation of the divergent agents.
          // The stream records the proposals each agent reads from the others.
          engine.commStream = new CommunicationStream();
          engine._semanticConvergenceClient = null;
          var deliberation = new DeliberationEngine(engine, config, {});
          var execResult = await deliberation.deliberate(decomposition, null);

          var synthesizer = new ResultSynthesizer(llm);
          var synthesis = await synthesizer.synthesize(args.prompt, execResult.contributions);

          var evaluator = new QualityEvaluator(llm);
          var quality = await evaluator.evaluate(args.prompt, synthesis.result);

          result = {
            result: synthesis.result,
            agents: execResult.contributions.map(function(c) { return c.agentName.toUpperCase(); }),
            quality: quality.overall,
            duration: formatDuration(execResult.totalDurationMs),
            deliberation: execResult.deliberation || null,
          };
          break;
        }
        case 'legion_agents': {
          var reg = new AgentRegistry();
          await reg.initialize(null);
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
          await reg2.initialize(null);
          var agent = reg2.getAgent(args.name);
          if (!agent) throw new Error('Agent not found: ' + args.name);
          result = agent;
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

// The orchestration engine is exported so the test suite can drive it with a
// scripted LLM. LEGION_X_LIBRARY=1 imports the module without running the CLI.
export {
  LocalGethOrchestrator,
  LocalLegionStore,
  PromptEvolver,
  LLMProvider,
  LegionConfig,
  gethDetectPromptLanguage,
  gethClassifyTaskContext,
  gethComputeAdaptiveConvergence,
  gethParseTribunalChallenges,
  gethSalvageDecomposition,
  gethValidatePrometheusDecision,
  gethAssignProvidersToAgents,
  gethAnalyzeTrajectory,
  gethMeasureConvergence,
  gethDecideNextRound,
  gethEvaluateRound1QualityGate,
  gethComputeTribunalMetrics,
  gethParseChallengeResponseTag,
  gethClassifyDomain,
  gethValidateAgentDomainAffinity,
  gethAssessProposalDomainRelevance,
  gethComputeAuthorityRankings,
  gethDetermineSynthesisStrategy,
  gethClassifyConflictType,
  parseStructuredOutput,
  runClientOrchestration,
};

if (process.env.LEGION_X_LIBRARY !== '1') {
  main();
}
