/** Translate the nha config into the flat config Legion X reads, and say whether it can run */

/** Providers Legion X can deliberate with. */
export const LEGION_PROVIDERS = [
  'ollama', 'local-openai', 'anthropic', 'openai', 'gemini', 'deepseek', 'grok', 'mistral', 'cohere',
];

/** Cloud provider → [field of nha's llm section, key name Legion reads]. */
const CLOUD_KEYS = {
  anthropic: ['anthropicKey', 'anthropicApiKey'],
  openai: ['openaiKey', 'openaiApiKey'],
  gemini: ['geminiKey', 'geminiApiKey'],
  deepseek: ['deepseekKey', 'deepseekApiKey'],
  grok: ['grokKey', 'grokApiKey'],
  mistral: ['mistralKey', 'mistralApiKey'],
  cohere: ['cohereKey', 'cohereApiKey'],
};

const LOCAL_PROVIDERS = ['ollama', 'local-openai'];

/** Environment variable Legion reads for the key of each cloud provider. */
export const CLOUD_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY', grok: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY', cohere: 'COHERE_API_KEY',
};

/**
 * The provider Legion deliberates with: the one chosen for Legion, else the
 * toolkit provider when Legion supports it, else none (Legion then uses
 * whatever has a key, or a local model).
 */
export function resolveLegionProvider(config) {
  const chosen = String(config.legion?.provider || '').trim();
  if (chosen) return chosen;
  const shared = String(config.llm?.provider || '').trim();
  return LEGION_PROVIDERS.includes(shared) ? shared : '';
}

/**
 * Build the Legion config from the nha config. The result is derived in full
 * every time: the nha config is the only place settings are kept, so a key
 * removed there is gone from Legion too.
 *
 * `llm.apiKey` is the key of `llm.provider` and of no other provider.
 */
export function buildLegionConfig(config) {
  const llm = config.llm || {};
  const legion = config.legion || {};
  const features = config.features || {};
  const deliberation = config.deliberation || {};

  const out = {
    provider: resolveLegionProvider(config),
    llmModel: llm.model || '',
    // Always empty: every key is written under its provider's own name.
    llmApiKey: '',
  };

  // Legion spreads the agents across every provider it has a key for. With
  // local-only on, no cloud key is handed over: nothing leaves the machine.
  out.localOnly = legion.localOnly === true;
  for (const [provider, [nhaField, legionField]] of Object.entries(CLOUD_KEYS)) {
    out[legionField] = out.localOnly ? '' : llm[nhaField] || (llm.provider === provider ? llm.apiKey || '' : '');
  }

  out.ollamaUrl = legion.ollamaUrl || 'http://localhost:11434';
  if (legion.ollamaModel) out.ollamaModel = legion.ollamaModel;
  if (legion.ollamaModels) out.ollamaModels = legion.ollamaModels;
  if (legion.ollamaEmbedModel) out.ollamaEmbedModel = legion.ollamaEmbedModel;
  if (legion.localOpenaiUrl) out.localOpenaiUrl = legion.localOpenaiUrl;
  if (legion.localOpenaiModel) out.localOpenaiModel = legion.localOpenaiModel;
  if (legion.localOpenaiKey) out.localOpenaiKey = legion.localOpenaiKey;
  if (legion.orchestratorProvider) out.orchestratorProvider = legion.orchestratorProvider;
  out.economy = legion.economy === true;
  out.factCheckEnabled = legion.factCheck !== false;
  if (Number(legion.crossReadingChars) > 0) out.crossReadingChars = Number(legion.crossReadingChars);

  out.timeout = llm.timeout || 120000;
  out.maxRetries = llm.maxRetries || 2;
  out.parallelism = llm.parallelism || 4;
  out.verbose = features.verbose ?? true;
  out.immersive = features.immersive ?? true;
  out.knowledgeEnabled = features.knowledgeEnabled ?? true;
  out.workspaceEnabled = features.workspaceEnabled ?? true;
  out.latentSpaceEnabled = features.latentSpaceEnabled ?? true;
  out.knowledgeGraphEnabled = features.knowledgeGraphEnabled ?? true;
  out.promptEvolutionEnabled = features.promptEvolutionEnabled ?? true;
  out.metaIntelligenceEnabled = features.metaIntelligenceEnabled ?? true;
  out.deliberationEnabled = deliberation.enabled ?? true;
  out.deliberationRounds = deliberation.rounds || 3;
  out.deliberationConvergence = deliberation.convergence || 0.82;
  out.minDeliberationRounds = deliberation.minRounds || 2;
  out.semanticConvergenceEnabled = deliberation.semanticConvergence ?? true;
  out.tribunalEnabled = deliberation.tribunalEnabled ?? true;
  return out;
}

/**
 * Whether a deliberation can start with this Legion config.
 * A cloud provider needs its key; a local one needs nothing here (Legion
 * reports by itself when the local runtime does not answer).
 *
 * @param {object} legionConfig result of buildLegionConfig
 * @param {object} [env] environment, for keys given as variables
 * @returns {{ ready: boolean, providers: string[], reason: string }}
 */
export function legionReadiness(legionConfig, env = process.env) {
  const providers = [];
  if (!legionConfig.localOnly) {
    for (const [provider, [, legionField]] of Object.entries(CLOUD_KEYS)) {
      if (legionConfig[legionField] || env[CLOUD_KEY_ENV[provider]]) providers.push(provider);
    }
  }
  if (legionConfig.localOpenaiUrl) providers.push('local-openai');
  if (legionConfig.provider === 'ollama' || legionConfig.ollamaModel || legionConfig.ollamaModels) providers.push('ollama');

  const chosen = legionConfig.provider;
  if (chosen && !LEGION_PROVIDERS.includes(chosen)) {
    return { ready: false, providers, reason: `"${chosen}" is not a provider Legion can deliberate with.` };
  }
  if (chosen && !LOCAL_PROVIDERS.includes(chosen) && legionConfig.localOnly) {
    return { ready: false, providers, reason: `local-only is on, but "${chosen}" is a cloud provider. Set legion-provider to ollama or local-openai.` };
  }
  if (chosen && !LOCAL_PROVIDERS.includes(chosen) && !providers.includes(chosen)) {
    return { ready: false, providers, reason: `Provider "${chosen}" is selected but has no API key.` };
  }
  if (chosen === 'local-openai' && !legionConfig.localOpenaiUrl) {
    return { ready: false, providers, reason: 'Provider "local-openai" is selected but local-openai-url is not set.' };
  }
  if (providers.length === 0) {
    return { ready: false, providers, reason: 'No LLM provider is configured for deliberations.' };
  }
  return { ready: true, providers, reason: '' };
}
