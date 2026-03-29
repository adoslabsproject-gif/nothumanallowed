/**
 * nha ask <agent> "prompt" — Direct single-agent call. No server. No session.
 * Loads the agent's system prompt from ~/.nha/agents/<name>.mjs,
 * calls the user's configured LLM provider, streams the response.
 *
 * Zero network calls except to the LLM provider.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config.mjs';
import { AGENTS_DIR, AGENTS } from '../constants.mjs';
import { getProviderCall, getApiKey, parseAgentFile } from '../services/llm.mjs';
import { fail, info, ok, C, G, Y, D, W, BOLD, NC, M } from '../ui.mjs';

export async function cmdAsk(args) {
  const agentName = args[0];
  if (!agentName || agentName.startsWith('-')) {
    fail('Usage: nha ask <agent> "your question"');
    fail('       nha ask saber "Audit this Express app for OWASP Top 10"');
    fail('       nha ask oracle "Analyze this CSV for trends" --file data.csv');
    console.log('');
    info('Available agents: ' + AGENTS.join(', '));
    process.exit(1);
  }

  const agentFile = path.join(AGENTS_DIR, `${agentName}.mjs`);
  if (!fs.existsSync(agentFile)) {
    fail(`Agent "${agentName}" not found in ~/.nha/agents/`);
    info('Available: ' + AGENTS.join(', '));
    process.exit(1);
  }

  let promptParts = [];
  let provider = null;
  let model = null;
  let stream = true;
  let attachFile = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1]) { provider = args[++i]; continue; }
    if (args[i] === '--model' && args[i + 1]) { model = args[++i]; continue; }
    if (args[i] === '--no-stream') { stream = false; continue; }
    if (args[i] === '--file' && args[i + 1]) { attachFile = args[++i]; continue; }
    promptParts.push(args[i]);
  }

  let userMessage = promptParts.join(' ');
  if (!userMessage) {
    fail('No prompt provided.');
    fail('Usage: nha ask saber "your question here"');
    process.exit(1);
  }

  if (attachFile) {
    const filePath = path.resolve(attachFile);
    if (!fs.existsSync(filePath)) {
      fail(`File not found: ${attachFile}`);
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const maxChars = 100_000;
    const truncated = content.length > maxChars ? content.slice(0, maxChars) + '\n\n[... truncated ...]' : content;
    userMessage += `\n\n--- Attached file: ${path.basename(filePath)} ---\n${truncated}`;
  }

  const config = loadConfig();
  provider = provider || config.llm.provider || 'anthropic';
  model = model || config.llm.model || null;
  const apiKey = getApiKey(config, provider);

  if (!apiKey) {
    fail(`No API key for ${provider}. Run: nha config set key YOUR_KEY`);
    process.exit(1);
  }

  const agentSource = fs.readFileSync(agentFile, 'utf-8');
  const { card, systemPrompt } = parseAgentFile(agentSource, agentName);

  if (!systemPrompt) {
    fail(`Agent "${agentName}" has no SYSTEM_PROMPT in its file.`);
    process.exit(1);
  }

  console.log(`\n  ${BOLD}${card?.displayName || agentName.toUpperCase()}${NC} ${D}(${card?.tagline || card?.category || 'agent'})${NC}`);
  console.log(`  ${D}Provider: ${provider}${model ? ' / ' + model : ''} | Direct call — no server${NC}\n`);

  const callFn = getProviderCall(provider);
  if (!callFn) {
    fail(`Unknown provider: ${provider}`);
    info('Supported: anthropic, openai, gemini, deepseek, grok, mistral, cohere');
    process.exit(1);
  }

  const startTime = Date.now();

  try {
    const useStream = stream && (provider === 'anthropic' || provider === 'openai' || provider === 'deepseek' || provider === 'grok' || provider === 'mistral');
    const result = await callFn(apiKey, model, systemPrompt, userMessage, useStream);

    if (!useStream && result) {
      console.log(result);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  ${D}${elapsed}s | ${provider}${model ? ' / ' + model : ''} | ${card?.displayName || agentName}${NC}\n`);
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
}
