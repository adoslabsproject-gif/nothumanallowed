/** Unified config manager — reads/writes ~/.nha/config.json, migrates legacy */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG_FILE, NHA_DIR } from './constants.mjs';

const LEGACY_LEGION = path.join(os.homedir(), '.legion-config.json');
const LEGACY_PIF = path.join(os.homedir(), '.pif-agent.json');

const DEFAULT_CONFIG = {
  version: 1,
  llm: {
    provider: 'nha',
    apiKey: '',
    openaiKey: '',
    geminiKey: '',
    deepseekKey: '',
    grokKey: '',
    mistralKey: '',
    cohereKey: '',
    model: '',
    timeout: 120000,
    maxRetries: 2,
    parallelism: 4,
  },
  agent: {
    id: '',
    name: '',
    privateKeyPem: '',
    publicKeyHex: '',
  },
  deliberation: {
    enabled: true,
    rounds: 3,
    convergence: 0.82,
    minRounds: 2,
    semanticConvergence: true,
    tribunalEnabled: true,
  },
  features: {
    verbose: true,
    immersive: true,
    knowledgeEnabled: true,
    workspaceEnabled: true,
    latentSpaceEnabled: true,
    knowledgeGraphEnabled: true,
    promptEvolutionEnabled: true,
    metaIntelligenceEnabled: true,
  },
  google: {
    clientId: '',
    clientSecret: '',
  },
  microsoft: {
    clientId: '',
    clientSecret: '',
    tenantId: 'common',
  },
  ops: {
    enabled: false,
    planTime: '07:00',
    summaryTime: '18:00',
    pollIntervalMail: 300000,
    pollIntervalCalendar: 900000,
    meetingAlertMinutes: 30,
    webhooks: {
      telegram: '',
      discord: '',
    },
    notifications: {
      desktop: true,
      terminal: true,
    },
    proactive: {
      enabled: true,
      emailFollowUp: true,
      meetingPrep: true,
      patterns: true,
      deadlines: true,
    },
  },
  responder: {
    autoRoute: true,
    telegram: {
      token: '',
      allowedChatIds: [],
    },
    discord: {
      token: '',
      allowedChannelIds: [],
    },
  },
  plugins: {
    autoRun: true,
    directory: '',
  },
  voice: {
    preferWhisper: false,
    speechSynthesis: true,
    language: '',
  },
  github: {
    token: '',
    defaultRepo: '',
  },
  notion: {
    token: '',
  },
  slack: {
    token: '',
  },
  profile: {
    name: '',
    email: '',
    phone: '',
    homeAddress: '',
    workAddress: '',
    city: '',
    country: '',
    timezone: '',
    language: '',
    company: '',
    role: '',
    notes: '',
  },
};

/**
 * Load config. Migrates legacy files on first run.
 * @returns {object}
 */
export function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      // Deep merge with defaults so new config sections (profile, responder, etc.)
      // are always present even if the file was created before they existed
      const merged = structuredClone(DEFAULT_CONFIG);
      for (const [key, value] of Object.entries(saved)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof merged[key] === 'object' && merged[key] !== null) {
          merged[key] = { ...merged[key], ...value };
        } else {
          merged[key] = value;
        }
      }
      return merged;
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  // Migrate from legacy config files
  const config = structuredClone(DEFAULT_CONFIG);
  let migrated = false;

  if (fs.existsSync(LEGACY_LEGION)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_LEGION, 'utf-8'));
      if (legacy.provider) config.llm.provider = legacy.provider;
      if (legacy.apiKey) config.llm.apiKey = legacy.apiKey;
      if (legacy.openaiKey) config.llm.openaiKey = legacy.openaiKey;
      if (legacy.geminiKey) config.llm.geminiKey = legacy.geminiKey;
      if (legacy.deepseekKey) config.llm.deepseekKey = legacy.deepseekKey;
      if (legacy.grokKey) config.llm.grokKey = legacy.grokKey;
      if (legacy.mistralKey) config.llm.mistralKey = legacy.mistralKey;
      if (legacy.cohereKey) config.llm.cohereKey = legacy.cohereKey;
      if (legacy.model) config.llm.model = legacy.model;
      if (legacy.timeout) config.llm.timeout = legacy.timeout;
      if (legacy.deliberationEnabled !== undefined) config.deliberation.enabled = legacy.deliberationEnabled;
      if (legacy.deliberationRounds) config.deliberation.rounds = legacy.deliberationRounds;
      if (legacy.deliberationConvergence) config.deliberation.convergence = legacy.deliberationConvergence;
      if (legacy.verbose !== undefined) config.features.verbose = legacy.verbose;
      if (legacy.immersive !== undefined) config.features.immersive = legacy.immersive;
      if (legacy.knowledgeEnabled !== undefined) config.features.knowledgeEnabled = legacy.knowledgeEnabled;
      migrated = true;
    } catch { /* ignore corrupt legacy */ }
  }

  if (fs.existsSync(LEGACY_PIF)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_PIF, 'utf-8'));
      if (legacy.agentId) config.agent.id = legacy.agentId;
      if (legacy.agentName) config.agent.name = legacy.agentName;
      if (legacy.privateKeyPem) config.agent.privateKeyPem = legacy.privateKeyPem;
      if (legacy.publicKeyHex) config.agent.publicKeyHex = legacy.publicKeyHex;
      // PIF may also have LLM keys
      if (legacy.aiProvider && !config.llm.apiKey) config.llm.provider = legacy.aiProvider;
      if (legacy.aiApiKey && !config.llm.apiKey) config.llm.apiKey = legacy.aiApiKey;
      migrated = true;
    } catch { /* ignore corrupt legacy */ }
  }

  if (migrated) {
    saveConfig(config);
  }

  return config;
}

/**
 * Save config to ~/.nha/config.json
 * @param {object} config
 */
export function saveConfig(config) {
  fs.mkdirSync(NHA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Set a dotted config key (e.g., "llm.apiKey", "deliberation.rounds").
 * @param {string} key
 * @param {string} value
 * @returns {boolean} true if key was valid
 */
export function setConfigValue(key, value) {
  const config = loadConfig();
  const parts = key.split('.');

  // Flatten known aliases for user convenience
  const aliases = {
    'provider': 'llm.provider',
    'api-key': 'llm.apiKey',
    'apikey': 'llm.apiKey',
    'key': 'llm.apiKey',
    'llm-key': 'llm.apiKey',
    'openai-key': 'llm.openaiKey',
    'gemini-key': 'llm.geminiKey',
    'deepseek-key': 'llm.deepseekKey',
    'grok-key': 'llm.grokKey',
    'mistral-key': 'llm.mistralKey',
    'cohere-key': 'llm.cohereKey',
    'model': 'llm.model',
    'timeout': 'llm.timeout',
    'verbose': 'features.verbose',
    'immersive': 'features.immersive',
    'deliberation': 'deliberation.enabled',
    'rounds': 'deliberation.rounds',
    'convergence': 'deliberation.convergence',
    'tribunal': 'deliberation.tribunalEnabled',
    'knowledge': 'features.knowledgeEnabled',
    'google-client-id': 'google.clientId',
    'google-client-secret': 'google.clientSecret',
    'microsoft-client-id': 'microsoft.clientId',
    'microsoft-client-secret': 'microsoft.clientSecret',
    'microsoft-tenant': 'microsoft.tenantId',
    'microsoft-tenant-id': 'microsoft.tenantId',
    'plan-time': 'ops.planTime',
    'summary-time': 'ops.summaryTime',
    'meeting-alert': 'ops.meetingAlertMinutes',
    'telegram-webhook': 'ops.webhooks.telegram',
    'discord-webhook': 'ops.webhooks.discord',
    'plugin-autorun': 'plugins.autoRun',
    'plugin-dir': 'plugins.directory',
    'voice-whisper': 'voice.preferWhisper',
    'voice-speech': 'voice.speechSynthesis',
    'voice-language': 'voice.language',
    'telegram-bot-token': 'responder.telegram.token',
    'discord-bot-token': 'responder.discord.token',
    'responder-auto-route': 'responder.autoRoute',
    'proactive': 'ops.proactive.enabled',
    'proactive-email': 'ops.proactive.emailFollowUp',
    'proactive-meeting': 'ops.proactive.meetingPrep',
    'proactive-patterns': 'ops.proactive.patterns',
    'proactive-deadlines': 'ops.proactive.deadlines',
    'github-token': 'github.token',
    'gh-token': 'github.token',
    'github-repo': 'github.defaultRepo',
    'gh-repo': 'github.defaultRepo',
    'notion-token': 'notion.token',
    'slack-token': 'slack.token',
    'name': 'profile.name',
    'my-name': 'profile.name',
    'email': 'profile.email',
    'my-email': 'profile.email',
    'phone': 'profile.phone',
    'my-phone': 'profile.phone',
    'home': 'profile.homeAddress',
    'home-address': 'profile.homeAddress',
    'work': 'profile.workAddress',
    'work-address': 'profile.workAddress',
    'city': 'profile.city',
    'my-city': 'profile.city',
    'country': 'profile.country',
    'company': 'profile.company',
    'my-role': 'profile.role',
    'role': 'profile.role',
    'profile-notes': 'profile.notes',
    'thinking': 'thinking',
    'extended-thinking': 'thinking',
    'language': 'language',
  };

  const resolved = aliases[key] || key;
  const resolvedParts = resolved.split('.');

  let obj = config;
  for (let i = 0; i < resolvedParts.length - 1; i++) {
    if (obj[resolvedParts[i]] === undefined) return false;
    obj = obj[resolvedParts[i]];
  }

  const lastKey = resolvedParts[resolvedParts.length - 1];
  // Allow creating new keys (don't reject undefined)

  // Empty value = clear the field
  if (value === '' || value === null || value === undefined) {
    obj[lastKey] = '';
    saveConfig(config);
    return true;
  }

  // Type coercion based on existing type
  const existing = obj[lastKey];
  if (typeof existing === 'boolean') {
    obj[lastKey] = value === 'true' || value === '1' || value === 'yes';
  } else if (typeof existing === 'number') {
    obj[lastKey] = Number(value);
  } else if (Array.isArray(existing)) {
    // Parse comma-separated values or JSON array
    try {
      const parsed = JSON.parse(value);
      obj[lastKey] = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      obj[lastKey] = value.split(',').map(v => {
        const trimmed = v.trim();
        const num = Number(trimmed);
        return !isNaN(num) && trimmed !== '' ? num : trimmed;
      }).filter(Boolean);
    }
  } else {
    obj[lastKey] = value;
  }

  saveConfig(config);
  return true;
}

/**
 * Export config as flat env vars for child process (backward compat with legion-x.mjs).
 * @param {object} config
 * @returns {object} env vars to merge into process.env
 */
export function configToEnv(config) {
  return {
    NHA_AGENTS_DIR: path.join(NHA_DIR, 'agents'),
    NHA_EXTENSIONS_DIR: path.join(NHA_DIR, 'extensions'),
    NHA_SESSIONS_DIR: path.join(NHA_DIR, 'sessions'),
    NHA_CONFIG_FILE: CONFIG_FILE,
    // Legacy compat: legion-x.mjs reads these directly
    LEGION_PROVIDER: config.llm.provider,
    LEGION_API_KEY: config.llm.apiKey,
    LEGION_OPENAI_KEY: config.llm.openaiKey,
    LEGION_GEMINI_KEY: config.llm.geminiKey,
  };
}
