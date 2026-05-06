/**
 * Shared LLM provider service — zero dependencies.
 * Used by both `nha ask` (interactive) and PAO pipeline (batch).
 *
 * Supports: Anthropic, OpenAI, Gemini, DeepSeek, Grok, Mistral, Cohere.
 */

// ── Providers ──────────────────────────────────────────────────────────────

export async function callAnthropic(apiKey, model, systemPrompt, userMessage, stream = false, opts = {}) {
  // Use Anthropic prompt caching: system prompt as array with cache_control
  // so the same system prompt is served from cache on repeated calls (~90% saving on input tokens).
  const systemBlocks = systemPrompt
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : [];
  const body = {
    model: model || 'claude-sonnet-4-20250514',
    max_tokens: opts.max_tokens || 8192,
    system: systemBlocks,
    messages: [{ role: 'user', content: userMessage }],
    stream,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
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

export async function callOpenAI(apiKey, model, systemPrompt, userMessage, stream = false, opts = {}) {
  const body = {
    model: model || 'gpt-4o',
    max_tokens: opts.max_tokens || 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
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

export async function callGemini(apiKey, model, systemPrompt, userMessage, _stream = false, opts = {}) {
  const m = model || 'gemini-2.5-pro-preview-05-06';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const generationConfig = { maxOutputTokens: opts.max_tokens || 8192 };
  if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig,
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

export async function callDeepSeek(apiKey, model, systemPrompt, userMessage, stream = false, opts = {}) {
  const body = {
    model: model || 'deepseek-chat',
    max_tokens: opts.max_tokens || 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
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

export async function callGrok(apiKey, model, systemPrompt, userMessage, stream = false, opts = {}) {
  const body = {
    model: model || 'grok-3-latest',
    max_tokens: opts.max_tokens || 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
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

export async function callMistral(apiKey, model, systemPrompt, userMessage, stream = false, opts = {}) {
  const body = {
    model: model || 'mistral-large-latest',
    max_tokens: opts.max_tokens || 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
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

export async function callCohere(apiKey, model, systemPrompt, userMessage, _stream = false, opts = {}) {
  const body = {
    model: model || 'command-r-plus',
    max_tokens: opts.max_tokens || 8192,
    preamble: systemPrompt,
    message: userMessage,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
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

/**
 * NHA Free (Liara) — free LLM tier, no API key required.
 * Qwen3 32B on Hetzner RTX 6000 Pro 96GB. Supports thinking mode.
 */
export async function callNHA(apiKey, model, systemPrompt, userMessage, stream = false, opts = {}) {
  // Read thinking preference from config
  let thinkingEnabled = false; // OFF by default for speed
  try {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const cfgFile = path.default.join(os.default.homedir(), '.nha', 'config.json');
    if (fs.default.existsSync(cfgFile)) {
      const cfg = JSON.parse(fs.default.readFileSync(cfgFile, 'utf-8'));
      if (cfg.thinking === true || cfg.thinking === 'on' || cfg.thinking === 'true') {
        thinkingEnabled = true;
      }
    }
  } catch {}

  // Sanitize content before sending through SENTINEL — strip patterns that trigger WAF
  // (backticks, template literals, SSTI patterns) without affecting semantics
  const sanitizeForSentinel = (s) => String(s || '')
    .replace(/`/g, "'")                         // backtick → single quote
    .replace(/\$\{([^}]*)\}/g, '[$1]')          // ${expr} → [expr]
    .replace(/\{\{([^}]*)\}\}/g, '{$1}')        // {{expr}} → {expr}
    .replace(/\{%([^%]*)%\}/g, '{$1}')          // {% expr %} → { expr }
    .replace(/<!ENTITY/gi, '&lt;!ENTITY')       // XXE
    .replace(/SYSTEM\s+["']/gi, 'SYSTEM ')      // XXE SYSTEM
    .replace(/\|\|\(/g, '||(')                  // LDAP (cosmetic, non-breaking)
    .replace(/\)\|\|/g, ')||');                 // LDAP

  const body = {
    model: model || '/opt/models/qwen3-32b',
    max_tokens: opts.max_tokens || (thinkingEnabled ? 16384 : 8192),
    messages: [
      { role: 'system', content: sanitizeForSentinel(systemPrompt) },
      { role: 'user', content: sanitizeForSentinel(userMessage) },
    ],
    stream,
    chat_template_kwargs: { enable_thinking: thinkingEnabled },
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  // Route through NHA server proxy (SENTINEL protection) instead of direct to Hetzner
  const res = await fetch('https://nothumanallowed.com/api/v1/liara/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-nha-client': 'cli',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`NHA Free ${res.status}: ${err}`);
  }
  if (stream) return streamSSE(res, 'openai');
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || '';
  // Strip thinking tags if present
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return content;
}

const PROVIDERS = {
  nha: callNHA,
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
  // NHA Free (Liara) doesn't need an API key
  if (provider === 'nha') return 'nha-free-tier';

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
  const provider = opts.provider || config.llm.provider || (config.llm.apiKey ? 'anthropic' : 'nha');
  const model = opts.model || config.llm.model || null;
  const apiKey = getApiKey(config, provider);
  if (!apiKey) throw new Error(`No API key for ${provider}`);

  const callFn = getProviderCall(provider);
  if (!callFn) throw new Error(`Unknown provider: ${provider}`);

  return callFn(apiKey, model, systemPrompt, userMessage, false, opts);
}

/**
 * Call LLM with multimodal (vision) messages — supports image + PDF content.
 * Unified function for ALL vision calls (web UI, CLI, screen capture).
 * @param {object} config
 * @param {string} systemPrompt
 * @param {string} userMessage — text question about the image
 * @param {object} media — { base64, mimeType } (image/png, image/jpeg, application/pdf)
 * @returns {Promise<string>}
 */
export async function callLLMVision(config, systemPrompt, userMessage, media) {
  const provider = config.llm.provider || 'anthropic';
  const model = config.llm.model || null;

  // NHA Free tier — use Liara Vision (no API key needed)
  if (provider === 'nha') {
    const { base64, mimeType } = media;
    if (!base64) throw new Error('media.base64 required for vision');
    const res = await fetch('https://nothumanallowed.com/api/v1/liara/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nha-client': 'cli' },
      body: JSON.stringify({ image_base64: base64, prompt: userMessage || 'Describe this image in detail.' }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Liara Vision ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.description || data.text || JSON.stringify(data);
  }

  const apiKey = getApiKey(config, provider);
  if (!apiKey) throw new Error(`No API key for ${provider}. Vision requires Claude, GPT-4, Gemini, or NHA Free (nha config set provider nha).`);

  const { base64, mimeType } = media;
  if (!base64 || !mimeType) throw new Error('media.base64 and media.mimeType are required');

  if (provider === 'anthropic') {
    const isPdf = mimeType === 'application/pdf';
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };

    const body = {
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: userMessage }] }],
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anthropic vision ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  if (provider === 'openai' || provider === 'deepseek' || provider === 'grok' || provider === 'mistral') {
    const url = provider === 'openai' ? 'https://api.openai.com/v1/chat/completions'
              : provider === 'deepseek' ? 'https://api.deepseek.com/v1/chat/completions'
              : provider === 'grok' ? 'https://api.x.ai/v1/chat/completions'
              : 'https://api.mistral.ai/v1/chat/completions';

    const body = {
      model: model || (provider === 'openai' ? 'gpt-4o' : model),
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: userMessage },
        ] },
      ],
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${provider} vision ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (provider === 'gemini') {
    const geminiModel = model || 'gemini-2.0-flash';
    const body = {
      contents: [{ parts: [
        { inline_data: { mime_type: mimeType, data: base64 } },
        { text: userMessage },
      ] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: 4096 },
    };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gemini vision ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  throw new Error(`Vision not supported for provider: ${provider}. Use Claude, GPT-4, or Gemini.`);
}

/**
 * Call an LLM provider with streaming enabled.
 * Calls onToken(chunk) for each token, returns full text at the end.
 * @returns {Promise<string>} The full LLM response text.
 */
export async function callLLMStream(config, systemPrompt, userMessage, onToken, opts = {}) {
  const provider = opts.provider || config.llm.provider || (config.llm.apiKey ? 'anthropic' : 'nha');
  const model = opts.model || config.llm.model || null;
  const apiKey = getApiKey(config, provider);
  if (!apiKey) throw new Error(`No API key for ${provider}`);

  const callFn = getProviderCall(provider);
  if (!callFn) throw new Error(`Unknown provider: ${provider}`);

  // NHA Free: add thinking config to streaming request
  if (provider === 'nha') {
    try {
      const fs2 = await import('fs');
      const path2 = await import('path');
      const os2 = await import('os');
      const cfgFile2 = path2.default.join(os2.default.homedir(), '.nha', 'config.json');
      if (fs2.default.existsSync(cfgFile2)) {
        const cfg2 = JSON.parse(fs2.default.readFileSync(cfgFile2, 'utf-8'));
        const thinkOn = cfg2.thinking === true || cfg2.thinking === 'on' || cfg2.thinking === 'true';
        // Will be added to body below via buildRequestBody override
        opts._thinkingEnabled = thinkOn;
      }
    } catch {}
  }

  // Gemini and Cohere don't support streaming — fall back to non-streaming
  if (provider === 'gemini' || provider === 'cohere') {
    const text = await callFn(apiKey, model, systemPrompt, userMessage, false);
    if (onToken) onToken(text);
    return text;
  }

  // NHA Free tier: delegate entirely to callNHA which handles sanitization,
  // thinking config, and the proxy correctly — then wrap with callback
  if (provider === 'nha') {
    // callNHA with stream=true returns the streamSSE result (async iterable/text)
    // We need callback-based streaming, so use streamSSEWithCallback directly
    // after building the sanitized body ourselves
    const sanitize = (s) => String(s || '')
      .replace(/`/g, "'")
      .replace(/\$\{([^}]*)\}/g, '[$1]')
      .replace(/\{\{([^}]*)\}\}/g, '{$1}')
      .replace(/\{%([^%]*)%\}/g, '{$1}')
      .replace(/<!ENTITY/gi, '&lt;!ENTITY')
      .replace(/SYSTEM\s+["']/gi, 'SYSTEM ')
      .replace(/\|\|\(/g, '||(')
      .replace(/\)\|\|/g, ')||');

    // opts.thinking === 'off' forces thinking off regardless of config
    // opts.max_tokens overrides the default token budget
    const forceThinkingOff = opts.thinking === 'off' || opts.thinking === false;

    let thinkingEnabled = false;
    if (!forceThinkingOff) {
      try {
        const fs2 = await import('fs');
        const path2 = await import('path');
        const os2 = await import('os');
        const cfgFile2 = path2.default.join(os2.default.homedir(), '.nha', 'config.json');
        if (fs2.default.existsSync(cfgFile2)) {
          const cfg2 = JSON.parse(fs2.default.readFileSync(cfgFile2, 'utf-8'));
          thinkingEnabled = cfg2.thinking === true || cfg2.thinking === 'on' || cfg2.thinking === 'true';
        }
      } catch {}
    }

    // Determine effective max_tokens:
    // 1. If opts.max_tokens explicitly set, use it
    // 2. If thinking is on, default to 8192 (need room for think + answer)
    // 3. Otherwise default to 8192 (full context for specialist agents)
    const effectiveMaxTokens = opts.max_tokens || (thinkingEnabled ? 8192 : 8192);

    const nhaBody = {
      model: model || '/opt/models/qwen3-32b',
      max_tokens: effectiveMaxTokens,
      messages: [
        { role: 'system', content: sanitize(systemPrompt) },
        { role: 'user', content: sanitize(userMessage) },
      ],
      stream: false,
      chat_template_kwargs: { enable_thinking: thinkingEnabled },
    };
    const nhaRes = await fetch('https://nothumanallowed.com/api/v1/liara/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nha-client': 'cli' },
      body: JSON.stringify(nhaBody),
    });
    if (!nhaRes.ok) {
      const err = await nhaRes.text();
      throw new Error(`NHA Free ${nhaRes.status}: ${err}`);
    }
    // Non-streaming: vLLM returns complete text — no BPE subword splitting issues
    const nhaJson = await nhaRes.json();
    let fullNhaText = nhaJson.choices?.[0]?.message?.content || '';
    // Strip <think>...</think> blocks
    fullNhaText = fullNhaText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (onToken) onToken(fullNhaText);
    return fullNhaText;
  }

  const format = provider === 'anthropic' ? 'anthropic' : 'openai';
  const body = buildRequestBody(provider, model, systemPrompt, userMessage, true);
  const url = getProviderUrl(provider, model, apiKey);
  const headers = getProviderHeaders(provider, apiKey);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${provider} ${res.status}: ${err}`);
  }

  return streamSSEWithCallback(res, format, onToken);
}

/** Build request body for a provider */
function buildRequestBody(provider, model, systemPrompt, userMessage, stream) {
  if (provider === 'anthropic') {
    return {
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      stream,
    };
  }
  // OpenAI-compatible format (OpenAI, DeepSeek, Grok, Mistral)
  const modelDefaults = {
    nha: '/opt/models/qwen3-32b',
    openai: 'gpt-4o',
    deepseek: 'deepseek-chat',
    grok: 'grok-3-latest',
    mistral: 'mistral-large-latest',
  };
  const req = {
    model: model || modelDefaults[provider] || 'gpt-4o',
    max_tokens: provider === 'nha' ? 4096 : 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream,
  };
  // NHA: add thinking control
  if (provider === 'nha') {
    req.chat_template_kwargs = { enable_thinking: false };
  }
  return req;
}

/** Get provider API URL */
function getProviderUrl(provider, model, apiKey) {
  const urls = {
    nha: 'https://nothumanallowed.com/api/v1/liara/chat',
    anthropic: 'https://api.anthropic.com/v1/messages',
    openai: 'https://api.openai.com/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/v1/chat/completions',
    grok: 'https://api.x.ai/v1/chat/completions',
    mistral: 'https://api.mistral.ai/v1/chat/completions',
  };
  return urls[provider] || urls.openai;
}

/** Get provider request headers */
function getProviderHeaders(provider, apiKey) {
  if (provider === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  if (provider === 'nha') {
    return { 'Content-Type': 'application/json' }; // No auth needed for free tier
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
}

/** Parse a complete SSE text body (already read via res.text()) and call onToken per token. */
/**
 * Qwen3 sometimes emits entire paragraphs as a single token with no spaces/newlines.
 * This restores markdown structure: newlines before headings, list items, numbered lists.
 * Only applied to non-HTML content (inside HTML tags is left untouched).
 */
function fixQwen3Markdown(text) {
  // Don't touch HTML content
  if (/<[a-zA-Z]/.test(text) && text.includes('</')) return text;
  return text
    // newline before markdown headings (##, ###, etc.) not at start
    .replace(/([^\n])(#{1,6}\s)/g, '$1\n$2')
    // newline before list items (- or * at word boundary) not at start
    .replace(/([^\n])(\n?[-*]\s)/g, '$1\n$2')
    // newline before numbered list items (1. 2. etc.) not at start
    .replace(/([^\n])(\n?\d+\.\s)/g, '$1\n$2')
    // newline before --- separators
    .replace(/([^\n])(---)/g, '$1\n$2');
}

function parseSSEText(text, format, onToken) {
  let fullText = '';
  let thinkBuf = '';
  let inThink = false;
  let isHtmlOutput = false;
  let chunkCount = 0;

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;

    try {
      const json = JSON.parse(data);
      let chunk = '';
      if (format === 'anthropic') {
        if (json.type === 'content_block_delta') chunk = json.delta?.text || '';
      } else {
        chunk = json.choices?.[0]?.delta?.content || '';
      }

      if (chunk) {
        thinkBuf += chunk;
        let out = '';
        while (thinkBuf.length > 0) {
          if (inThink) {
            const end = thinkBuf.indexOf('</think>');
            if (end === -1) { thinkBuf = ''; break; }
            inThink = false;
            thinkBuf = thinkBuf.slice(end + 8);
          } else {
            const start = thinkBuf.indexOf('<think>');
            if (start === -1) { out += thinkBuf; thinkBuf = ''; break; }
            out += thinkBuf.slice(0, start);
            inThink = true;
            thinkBuf = thinkBuf.slice(start + 7);
          }
        }
        if (out) {
          chunkCount++;
          if (chunkCount <= 3) process.stderr.write(`[QWEN3 CHUNK ${chunkCount}] len=${out.length} repr=${JSON.stringify(out.slice(0,60))}\n`);
          // Detect HTML output on first meaningful token
          if (!isHtmlOutput && (out.includes('<div') || out.includes('<!DOCTYPE') || out.includes('<html'))) {
            isHtmlOutput = true;
          }
          if (!isHtmlOutput) {
            out = fixQwen3Markdown(out);
            const insideTag = fullText.lastIndexOf('<') > fullText.lastIndexOf('>');
            if (fullText && out && !insideTag && !/[\s\n]$/.test(fullText) && !/^[\s\n.,;:!?)\]}'">]/.test(out)) {
              out = ' ' + out;
            }
          }
          fullText += out;
          if (onToken) onToken(out);
        }
      }
    } catch {}
  }
  process.stderr.write(`[QWEN3 TOTAL CHUNKS] ${chunkCount}, fullText len=${fullText.length}\n`);
  return fullText;
}

/** SSE stream parser with onToken callback (does NOT write to stdout directly) */
async function streamSSEWithCallback(res, format, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let thinkBuf = '';    // accumulates <think>...</think> content to suppress
  let inThink = false;
  let isHtmlOutput = false;

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
          // Filter out <think>...</think> blocks from Qwen3 thinking mode
          thinkBuf += chunk;
          let out = '';
          while (thinkBuf.length > 0) {
            if (inThink) {
              const end = thinkBuf.indexOf('</think>');
              if (end === -1) { thinkBuf = ''; break; } // still inside think block
              inThink = false;
              thinkBuf = thinkBuf.slice(end + 8);
            } else {
              const start = thinkBuf.indexOf('<think>');
              if (start === -1) { out += thinkBuf; thinkBuf = ''; break; }
              out += thinkBuf.slice(0, start);
              inThink = true;
              thinkBuf = thinkBuf.slice(start + 7);
            }
          }
          if (out) {
            if (!isHtmlOutput && (out.includes('<div') || out.includes('<!DOCTYPE') || out.includes('<html'))) {
              isHtmlOutput = true;
            }
            if (!isHtmlOutput) {
              out = fixQwen3Markdown(out);
              const insideTag2 = fullText.lastIndexOf('<') > fullText.lastIndexOf('>');
              if (fullText && out && !insideTag2 && !/[\s\n]$/.test(fullText) && !/^[\s\n.,;:!?)\]}'">]/.test(out)) {
                out = ' ' + out;
              }
            }
            fullText += out;
            if (onToken) onToken(out);
          }
        }
      } catch {}
    }
  }

  return fullText;
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
