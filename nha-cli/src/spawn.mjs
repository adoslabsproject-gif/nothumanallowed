/** Spawn legion-x.mjs or pif.mjs as child process with stdio inherited */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { loadConfig } from './config.mjs';
import { NHA_DIR, LEGION_FILE, PIF_FILE, AGENTS_DIR, EXTENSIONS_DIR, SESSIONS_DIR } from './constants.mjs';

/**
 * Write a Legion-compatible flat config from the NHA structured config.
 * Legion expects: { llmProvider, llmApiKey, nhaAgentId, nhaPrivateKeyPem, ... }
 * NHA stores: { llm: { provider, apiKey }, agent: { id, privateKeyPem }, ... }
 */
function writeLegionConfig(config) {
  const legionConfig = {
    llmProvider: config.llm?.provider || 'anthropic',
    llmApiKey: config.llm?.apiKey || '',
    llmModel: config.llm?.model || '',
    openaiKey: config.llm?.openaiKey || '',
    geminiKey: config.llm?.geminiKey || '',
    deepseekKey: config.llm?.deepseekKey || '',
    grokKey: config.llm?.grokKey || '',
    mistralKey: config.llm?.mistralKey || '',
    cohereKey: config.llm?.cohereKey || '',
    timeout: config.llm?.timeout || 120000,
    maxRetries: config.llm?.maxRetries || 2,
    parallelism: config.llm?.parallelism || 4,
    verbose: config.features?.verbose ?? true,
    immersive: config.features?.immersive ?? true,
    knowledgeEnabled: config.features?.knowledgeEnabled ?? true,
    workspaceEnabled: config.features?.workspaceEnabled ?? true,
    latentSpaceEnabled: config.features?.latentSpaceEnabled ?? true,
    knowledgeGraphEnabled: config.features?.knowledgeGraphEnabled ?? true,
    promptEvolutionEnabled: config.features?.promptEvolutionEnabled ?? true,
    metaIntelligenceEnabled: config.features?.metaIntelligenceEnabled ?? true,
    deliberationEnabled: config.deliberation?.enabled ?? true,
    deliberationRounds: config.deliberation?.rounds || 3,
    deliberationConvergence: config.deliberation?.convergence || 0.82,
    minDeliberationRounds: config.deliberation?.minRounds || 2,
    semanticConvergenceEnabled: config.deliberation?.semanticConvergence ?? true,
    tribunalEnabled: config.deliberation?.tribunalEnabled ?? true,
    // Agent identity
    nhaAgentId: config.agent?.id || '',
    nhaAgentName: config.agent?.name || '',
    nhaPrivateKeyPem: config.agent?.privateKeyPem || '',
    nhaPublicKeyHex: config.agent?.publicKeyHex || '',
  };

  const legionConfigFile = path.join(NHA_DIR, '.legion-config.json');
  fs.writeFileSync(legionConfigFile, JSON.stringify(legionConfig, null, 2) + '\n', 'utf-8');
  return legionConfigFile;
}

/**
 * Spawn a core file (legion-x.mjs or pif.mjs) with the user's terminal.
 * @param {'legion'|'pif'} target
 * @param {string[]} args
 * @returns {Promise<number>} exit code
 */
export function spawnCore(target, args) {
  const file = target === 'legion' ? LEGION_FILE : PIF_FILE;
  const config = loadConfig();

  // For Legion: write a flat config it can understand
  const configFile = target === 'legion'
    ? writeLegionConfig(config)
    : path.join(NHA_DIR, 'config.json');

  const env = {
    ...process.env,
    NHA_AGENTS_DIR: AGENTS_DIR,
    NHA_EXTENSIONS_DIR: EXTENSIONS_DIR,
    NHA_SESSIONS_DIR: SESSIONS_DIR,
    NHA_CONFIG_FILE: configFile,
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      stdio: 'inherit',
      env,
      cwd: process.cwd(),
    });

    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(`Failed to start ${target}: ${err.message}`);
      resolve(1);
    });
  });
}
