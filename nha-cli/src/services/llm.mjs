/**
 * Shared LLM provider service — zero dependencies.
 * Used by both `nha ask` (interactive) and PAO pipeline (batch).
 *
 * Supports: Anthropic, OpenAI, Gemini, DeepSeek, Grok, Mistral, Cohere.
 */

// ── Providers ──────────────────────────────────────────────────────────────

export async function callAnthropic(apiKey, model, systemPrompt, userMessage, stream = false) {
  const body = {
    model: model || 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    stream,
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }
  if (stream) return streamSSE(res, 'anthropic');
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

export async function callOpenAI(apiKey, model, systemPrompt, userMessage, stream = false) {
  const body = {
    model: model || 'gpt-4o',
    max_tokens: 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream,
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }
  if (stream) return streamSSE(res, 'openai');
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

export async function callGemini(apiKey, model, systemPrompt, userMessage, _stream = false) {
  const m = model || 'gemini-2.5-pro-preview-05-06';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig: { maxOutputTokens: 8192 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

export async function callDeepSeek(apiKey, model, systemPrompt, userMessage, stream = false) {
  const body = {
    model: model || 'deepseek-chat',
    max_tokens: 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream,
  };
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${err}`);
  }
  if (stream) return streamSSE(res, 'openai');
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

export async function callGrok(apiKey, model, systemPrompt, userMessage, stream = false) {
  const body = {
    model: model || 'grok-3-latest',
    max_tokens: 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream,
  };
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Grok ${res.status}: ${err}`);
  }
  if (stream) return streamSSE(res, 'openai');
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

export async function callMistral(apiKey, model, systemPrompt, userMessage, stream = false) {
  const body = {
    model: model || 'mistral-large-latest',
    max_tokens: 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream,
  };
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Mistral ${res.status}: ${err}`);
  }
  if (stream) return streamSSE(res, 'openai');
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

export async function callCohere(apiKey, model, systemPrompt, userMessage, _stream = false) {
  const body = {
    model: model || 'command-r-plus',
    max_tokens: 8192,
    preamble: systemPrompt,
    message: userMessage,
  };
  const res = await fetch('https://api.cohere.ai/v1/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cohere ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.text || '';
}

// ── SSE Stream Parser ──────────────────────────────────────────────────────

export async function streamSSE(res, format) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const json = JSON.parse(data);
        let chunk = '';

        if (format === 'anthropic') {
          if (json.type === 'content_block_delta') {
            chunk = json.delta?.text || '';
          }
        } else {
          chunk = json.choices?.[0]?.delta?.content || '';
        }

        if (chunk) {
          process.stdout.write(chunk);
          fullText += chunk;
        }
      } catch {}
    }
  }

  process.stdout.write('\n');
  return fullText;
}

// ── Router ─────────────────────────────────────────────────────────────────

const PROVIDERS = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  gemini: callGemini,
  deepseek: callDeepSeek,
  grok: callGrok,
  mistral: callMistral,
  cohere: callCohere,
};

export function getProviderCall(provider) {
  return PROVIDERS[provider] || null;
}

export function getApiKey(config, provider) {
  const keyMap = {
    anthropic: config.llm.apiKey,
    openai: config.llm.openaiKey || config.llm.apiKey,
    gemini: config.llm.geminiKey || config.llm.apiKey,
    deepseek: config.llm.deepseekKey || config.llm.apiKey,
    grok: config.llm.grokKey || config.llm.apiKey,
    mistral: config.llm.mistralKey || config.llm.apiKey,
    cohere: config.llm.cohereKey || config.llm.apiKey,
  };
  return keyMap[provider] || config.llm.apiKey;
}

/**
 * Call an LLM provider with the given prompt. No streaming.
 * @returns {Promise<string>} The LLM response text.
 */
export async function callLLM(config, systemPrompt, userMessage, opts = {}) {
  const provider = opts.provider || config.llm.provider || 'anthropic';
  const model = opts.model || config.llm.model || null;
  const apiKey = getApiKey(config, provider);
  if (!apiKey) throw new Error(`No API key for ${provider}`);

  const callFn = getProviderCall(provider);
  if (!callFn) throw new Error(`Unknown provider: ${provider}`);

  return callFn(apiKey, model, systemPrompt, userMessage, false);
}

/**
 * Call an agent by name — loads the agent file, calls LLM, returns response.
 * No streaming. Used by PAO pipeline for batch agent calls.
 *
 * Automatically injects relevant episodic memories into the prompt
 * and extracts key facts from the response for future retrieval.
 */
export async function callAgent(config, agentName, userMessage, opts = {}) {
  const { AGENTS_DIR } = await import('../constants.mjs');
  const fs = await import('fs');
  const path = await import('path');

  const agentFile = path.default.join(AGENTS_DIR, `${agentName}.mjs`);
  if (!fs.default.existsSync(agentFile)) throw new Error(`Agent ${agentName} not found`);

  const source = fs.default.readFileSync(agentFile, 'utf-8');
  const { systemPrompt } = parseAgentFile(source, agentName);
  if (!systemPrompt) throw new Error(`Agent ${agentName} has no SYSTEM_PROMPT`);

  // ── Episodic Memory: inject relevant past interactions ──────────────────
  let enrichedSystemPrompt = systemPrompt;
  try {
    const { buildMemoryContext } = await import('./memory.mjs');
    const memoryContext = buildMemoryContext(agentName, userMessage);
    if (memoryContext) {
      enrichedSystemPrompt = systemPrompt + memoryContext;
    }
  } catch { /* memory unavailable — proceed without it */ }

  const response = await callLLM(config, enrichedSystemPrompt, userMessage, opts);

  // ── Episodic Memory: extract key facts from the interaction ─────────────
  try {
    const { extractMemory } = await import('./memory.mjs');
    extractMemory(agentName, userMessage, response);
  } catch { /* memory extraction failed — non-critical */ }

  return response;
}

// ── Agent File Parser (shared) ─────────────────────────────────────────────

export function parseAgentFile(source, agentName) {
  let card = { displayName: agentName.toUpperCase(), category: 'agent', tagline: '' };
  let systemPrompt = '';

  const cardMatch = source.match(/export\s+var\s+AGENT_CARD\s*=\s*(\{[\s\S]*?\});/);
  if (cardMatch) {
    try { card = new Function('return ' + cardMatch[1])(); } catch {}
  }

  const promptMatch = source.match(/export\s+var\s+SYSTEM_PROMPT\s*=\s*([\s\S]*?);(?:\n\nexport|\n\nvar|\n\n\/\/)/);
  if (promptMatch) {
    try { systemPrompt = new Function('return ' + promptMatch[1])(); } catch {}
  }

  if (!systemPrompt) {
    const simpleMatch = source.match(/SYSTEM_PROMPT\s*=\s*'([\s\S]*?)';/);
    if (simpleMatch) systemPrompt = simpleMatch[1];
  }

  return { card, systemPrompt };
}
