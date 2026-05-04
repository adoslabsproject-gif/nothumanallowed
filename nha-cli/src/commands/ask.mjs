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
    fail('       nha ask oracle "Analyze this CSV" --file data.csv');
    fail('       nha ask forge "What\'s in this?" --image screenshot.png');
    console.log('');
    info('Available agents: ' + AGENTS.join(', '));
    info('Custom agents in ~/.nha/agents/ are also available.');
    info('Create one: nha agent:create myagent "Expert in X" "You are..."');
    process.exit(1);
  }

  const agentFile = path.join(AGENTS_DIR, `${agentName}.mjs`);
  if (!fs.existsSync(agentFile)) {
    fail(`Agent "${agentName}" not found in ~/.nha/agents/`);
    info('Available: ' + AGENTS.join(', '));
    info('Create custom: nha agent:create <name> <tagline> <system-prompt>');
    process.exit(1);
  }

  let promptParts = [];
  let provider = null;
  let model = null;
  let stream = true;
  let attachFile = null;
  let attachImage = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1]) { provider = args[++i]; continue; }
    if (args[i] === '--model' && args[i + 1]) { model = args[++i]; continue; }
    if (args[i] === '--no-stream') { stream = false; continue; }
    if (args[i] === '--file' && args[i + 1]) { attachFile = args[++i]; continue; }
    if (args[i] === '--image' && args[i + 1]) { attachImage = args[++i]; continue; }
    promptParts.push(args[i]);
  }

  let userMessage = promptParts.join(' ');

  if (attachFile) {
    const filePath = path.resolve(attachFile);
    if (!fs.existsSync(filePath)) { fail(`File not found: ${attachFile}`); process.exit(1); }
    const content = fs.readFileSync(filePath, 'utf-8');
    const maxChars = 100_000;
    const truncated = content.length > maxChars ? content.slice(0, maxChars) + '\n\n[... truncated ...]' : content;
    info(`Attached: ${path.basename(filePath)} (${Math.round(content.length / 1024)} KB)`);
    userMessage = (userMessage || 'Analyze this file') + `\n\n--- Attached file: ${path.basename(filePath)} ---\n${truncated}`;
  }

  if (!userMessage && !attachImage) {
    fail('No prompt provided.');
    fail('Usage: nha ask saber "your question here"');
    process.exit(1);
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

  const startTime = Date.now();

  try {
    // Image attachment — use vision API
    if (attachImage) {
      const imagePath = path.resolve(attachImage);
      if (!fs.existsSync(imagePath)) { fail(`Image not found: ${attachImage}`); process.exit(1); }
      const imageBuffer = fs.readFileSync(imagePath);
      const base64 = imageBuffer.toString('base64');
      const ext = path.extname(imagePath).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
      const mimeType = mimeMap[ext] || 'image/jpeg';
      info(`Attached image: ${path.basename(imagePath)} (${Math.round(base64.length * 3 / 4 / 1024)} KB)`);

      const imagePrompt = userMessage || 'Describe this image in detail. Extract any text, data, or important information.';
      let response = '';

      if (provider === 'nha') {
        // NHA Free tier — Liara Vision
        const res = await fetch('https://nothumanallowed.com/api/v1/liara/vision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: base64, prompt: imagePrompt }),
        });
        if (!res.ok) throw new Error(`Liara Vision ${res.status}`);
        const data = await res.json();
        response = data.description || data.text || JSON.stringify(data);
      } else if (provider === 'anthropic') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: model || 'claude-sonnet-4-20250514', max_tokens: 8192, system: systemPrompt,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
              { type: 'text', text: imagePrompt },
            ]}],
          }),
        });
        if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        response = data.content?.[0]?.text || '';
      } else if (provider === 'openai') {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: model || 'gpt-4o-mini', max_tokens: 8192,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: [
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
                { type: 'text', text: imagePrompt },
              ]},
            ],
          }),
        });
        if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        response = data.choices?.[0]?.message?.content || '';
      } else if (provider === 'gemini') {
        const m = model || 'gemini-2.0-flash';
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [
              { inline_data: { mime_type: mimeType, data: base64 } },
              { text: imagePrompt },
            ]}],
            generationConfig: { maxOutputTokens: 8192 },
          }),
        });
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        response = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } else {
        fail(`Vision not supported for "${provider}". Use anthropic, openai, or gemini.`);
        process.exit(1);
      }

      console.log(response);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n  ${D}${elapsed}s | ${provider}${model ? ' / ' + model : ''} | ${card?.displayName || agentName}${NC}\n`);
      return;
    }

    // Text / file — standard LLM call
    const callFn = getProviderCall(provider);
    if (!callFn) {
      fail(`Unknown provider: ${provider}`);
      info('Supported: anthropic, openai, gemini, deepseek, grok, mistral, cohere');
      process.exit(1);
    }

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

/**
 * nha agent:create <name> <tagline> <system-prompt>
 * Creates a custom agent file in ~/.nha/agents/
 */
/**
 * nha agent:list — Show all available agents (built-in + custom)
 */
export async function cmdAgentList() {
  info('Built-in agents:');
  for (const name of AGENTS) {
    const agentFile = path.join(AGENTS_DIR, `${name}.mjs`);
    if (fs.existsSync(agentFile)) {
      const source = fs.readFileSync(agentFile, 'utf-8');
      const { card } = parseAgentFile(source, name);
      console.log(`  ${C}${name.padEnd(16)}${NC} ${D}${card?.tagline || card?.category || ''}${NC}`);
    } else {
      console.log(`  ${D}${name.padEnd(16)} (not downloaded)${NC}`);
    }
  }

  // Custom agents
  if (fs.existsSync(AGENTS_DIR)) {
    const custom = fs.readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith('.mjs'))
      .map(f => f.replace('.mjs', ''))
      .filter(n => !AGENTS.includes(n));
    if (custom.length > 0) {
      console.log(`\n${Y}Custom agents:${NC}`);
      for (const name of custom) {
        const source = fs.readFileSync(path.join(AGENTS_DIR, `${name}.mjs`), 'utf-8');
        const { card } = parseAgentFile(source, name);
        console.log(`  ${Y}${name.padEnd(16)}${NC} ${D}${card?.tagline || ''}${NC}`);
      }
    }
  }
  console.log(`\n  ${D}Invoke: nha ask <agent> "prompt"${NC}`);
  console.log(`  ${D}Create: nha agent:create <name> "<tagline>" "<system prompt>"${NC}`);
  console.log(`  ${D}Delete: nha agent:delete <name>${NC}\n`);
}

/**
 * nha agent:delete <name> — Delete a custom agent
 */
export async function cmdAgentDelete(args) {
  const name = (args[0] || '').toLowerCase();
  if (!name) {
    fail('Usage: nha agent:delete <agent-name>');
    process.exit(1);
  }
  if (AGENTS.includes(name)) {
    fail(`"${name}" is a built-in agent and cannot be deleted.`);
    process.exit(1);
  }
  const agentFile = path.join(AGENTS_DIR, `${name}.mjs`);
  if (!fs.existsSync(agentFile)) {
    fail(`Agent "${name}" not found.`);
    process.exit(1);
  }
  fs.unlinkSync(agentFile);
  ok(`Agent "${name}" deleted.`);
}

export async function cmdAgentCreate(args) {
  const name = (args[0] || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const tagline = args[1] || '';
  const sysPrompt = args.slice(2).join(' ') || '';

  if (!name || !tagline || !sysPrompt) {
    fail('Usage: nha agent:create <name> "<tagline>" "<system prompt>"');
    console.log('');
    info('Example:');
    info('  nha agent:create reviewer "Code review expert" "You are a senior code reviewer..."');
    console.log('');
    info('The agent will be available as: nha ask reviewer "review this code"');
    process.exit(1);
  }

  const agentFile = path.join(AGENTS_DIR, `${name}.mjs`);
  if (fs.existsSync(agentFile)) {
    fail(`Agent "${name}" already exists at ${agentFile}`);
    process.exit(1);
  }

  const content = `// NHA Custom Agent: ${name}
// Created: ${new Date().toISOString()}

export const CARD = {
  name: '${name}',
  displayName: '${name.toUpperCase()}',
  category: 'custom',
  tagline: '${tagline.replace(/'/g, "\\'")}',
};

export const SYSTEM_PROMPT = \`${sysPrompt.replace(/`/g, '\\`')}\`;
`;

  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }

  fs.writeFileSync(agentFile, content, 'utf-8');
  ok(`Agent "${name}" created at ${agentFile}`);
  info(`Invoke it: nha ask ${name} "your question"`);
  info(`With file: nha ask ${name} "analyze" --file report.csv`);
  info(`With image: nha ask ${name} "what is this?" --image photo.jpg`);
}
