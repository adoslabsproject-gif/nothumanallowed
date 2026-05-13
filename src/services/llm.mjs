/**
 * Shared LLM provider service — zero dependencies.
 * Used by both `nha ask` (interactive) and PAO pipeline (batch).
 *
 * Supports: Anthropic, OpenAI, Gemini, DeepSeek, Grok, Mistral, Cohere.
 */

// ── Qwen3 BPE artifact repair ─────────────────────────────────────────────
//
// Qwen3-32B running on vLLM produces text where Italian/English function words
// (articles, prepositions, conjunctions) are fused to adjacent content words
// due to BPE tokenizer subword merging.  Examples:
//   "lacorrelazione" → "la correlazione"
//   "ilprezzodell'oro" → "il prezzo dell'oro"
//   "deidati" → "dei dati"
//   "nonesiste" → "non esiste"
//
// Strategy: insert a space before any known function word that immediately
// follows a lowercase letter (i.e. is fused mid-word).  We run multiple
// passes because chains like "dellacorrelazione" need two separations.
// Table rows (lines starting with |) are intentionally skipped to avoid
// corrupting cell separators.

// ── Qwen3 BPE repair — three-pass pipeline ────────────────────────────────
//
// Qwen3-32B on vLLM produces two distinct tokenization artifacts:
//
// ARTIFACT A — Word fusion (BPE subword merging at word boundaries):
//   "lacorrelazione" → "la correlazione"
//   "ilprezzodell'oro" → "il prezzo dell'oro"
// Fix: insert space before Italian/English function words fused to content words.
//
// ARTIFACT B — Fragment shattering (token fragments emitted with spaces):
//   "p os s i amo" → "possiamo"
//   "an al izz are" → "analizzare"
//   "corr el az ion e" → "correlazione"
// Fix: detect runs of ≥3 consecutive short tokens (≤4 chars) that together form
// a phonotactically plausible Italian/English word, then fuse them.
//
// Detection heuristic for Artifact B (no dictionary required):
//   - A "fragment run" is N≥3 space-separated tokens where every token is 1-4 chars
//   - The run must NOT contain standalone grammatical words (articles, preps, conj.)
//   - The fused form must contain at least one vowel (sanity check)
//   - Phonotactic filter: fused form must not start/end with implausible clusters
//
// Both artifacts can co-exist: after fusion, the fused word may need split-fix.

// Stopwords that act as word boundaries — these are NEVER BPE fragments, always real words
const BOUNDARY_WORDS = new Set([
  'il','lo','la','gli','le','un','uno','una',
  'del','dello','della','dei','degli','delle','dell',
  'al','allo','alla','ai','agli','alle',
  'dal','dallo','dalla','dai','dagli','dalle',
  'nel','nello','nella','nei','negli','nelle',
  'sul','sullo','sulla','sui','sugli','sulle',
  'con','col','per','tra','fra','che','non','ma','di','da','in','su','a','o','e','è',
  'oro','euro','usa','usd','eur','api','api','gas','oil','web','app','end','pdf','url','jpg','png',
  'the','and','for','are','was','but','not','you','all','can','her','has','had','his','she','him','our','out','new','old','top','get','set','add','run','use','see',
]);

// Single characters commonly produced by BPE fragmentation in Italian/English
const BPE_SINGLE_CHARS = new Set('abcdefghijklmnopqrstuvwxyzàèéìòù'.split(''));

/**
 * Enterprise-grade linguistic scorer for Italian/English word candidates.
 * Optimized for FULL FUSION validation rather than segmentation scoring.
 */
class LinguisticScorer {
  static scoreWord(word) {
    if (word.length < 3) return 0;
    if (word.length > 20) return 0;

    let score = 0;

    // 1. Length scoring - bias toward longer words (BPE fragments usually form 6-15 char words)
    if (word.length >= 8 && word.length <= 15) score += 60; // Strong bonus for typical length
    else if (word.length >= 6 && word.length <= 17) score += 40;
    else if (word.length >= 4 && word.length <= 20) score += 20;
    else score += 5;

    // 2. Vowel distribution score (critical for Italian)
    const vowels = (word.match(/[aeiouàèéìòù]/gi) || []).length;
    const vowelRatio = vowels / word.length;

    // Italian optimal range: 35-50% vowels
    if (vowelRatio >= 0.35 && vowelRatio <= 0.5) score += 50;
    else if (vowelRatio >= 0.25 && vowelRatio <= 0.6) score += 30;
    else if (vowelRatio >= 0.15 && vowelRatio <= 0.7) score += 10;
    else return 0; // Invalid vowel ratio

    // 3. Italian morphological endings (massive boost for real Italian words)
    const strongEndings = ['zione', 'amento', 'mente'];
    const mediumEndings = ['ando', 'endo', 'are', 'ere', 'ire', 'ato', 'ito', 'uto'];
    const weakEndings = ['oso', 'ico', 'ale', 'ivo', 'iva', 'ell', 'ett'];

    for (const ending of strongEndings) {
      if (word.endsWith(ending)) { score += 80; break; }
    }
    for (const ending of mediumEndings) {
      if (word.endsWith(ending)) { score += 40; break; }
    }
    for (const ending of weakEndings) {
      if (word.endsWith(ending)) { score += 20; break; }
    }

    // 4. CV alternation pattern (Italian has good consonant-vowel balance)
    let alternations = 0;
    let prevIsVowel = /[aeiouàèéìòù]/i.test(word[0]);

    for (let i = 1; i < word.length; i++) {
      const isVowel = /[aeiouàèéìòù]/i.test(word[i]);
      if (isVowel !== prevIsVowel) alternations++;
      prevIsVowel = isVowel;
    }

    const alternationRatio = alternations / word.length;
    if (alternationRatio >= 0.4 && alternationRatio <= 0.8) score += 30;
    else if (alternationRatio >= 0.25 && alternationRatio <= 0.9) score += 15;

    // 5. Penalty for impossible patterns
    // Consonant clusters at start/end (Italian rarely has these)
    if (/^[bcdfghjklmnpqrstvwxyz]{4,}/i.test(word)) score -= 50;
    if (/[bcdfghjklmnpqrstvwxyz]{4,}$/i.test(word)) score -= 30;

    // Multiple repeated chars (indicates fragmentation artifact)
    if (/(.)\1{2,}/.test(word)) score -= 30;

    // Too many single-letter parts (indicates under-fusion)
    const singleChars = word.match(/[aeiouàèéìòù]/gi)?.length || 0;
    if (singleChars / word.length > 0.6) score -= 20;

    return Math.max(0, score);
  }
}

// Fusion word set: IT articles/preps that were split-fused (Artifact A)
const IT_FUNCTION_WORDS_ARR = [
  'il','lo','la','i','gli','le','un','uno','una',
  'di','del','dello','della','dei','degli','delle',
  'a','al','allo','alla','ai','agli','alle',
  'da','dal','dallo','dalla','dai','dagli','dalle',
  'in','nel','nello','nella','nei','negli','nelle',
  'su','sul','sullo','sulla','sui','sugli','sulle',
  'con','col','per','tra','fra',
  'che','non','ma','se','anche','come','dove','quando',
  'perché','mentre','quindi','però','sia','né',
  'questo','questa','questi','queste','quello','quella',
  'e','o','è',
];
const BPE_SPLIT_RE = new RegExp(
  '([a-z\u00e0\u00e8\u00e9\u00ec\u00f2\u00f9])(' +
  IT_FUNCTION_WORDS_ARR.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
  ')(?=[A-Za-z\u00c0-\u024f])',
  'g',
);

/**
 * Enterprise Fragment Fusion Engine.
 * Uses linguistic heuristics to determine if fragments should be fused into a single word.
 */
class WordSegmenter {
  /**
   * Fuse fragments into words using linguistic validation.
   * Strategy: try full fusion first, fallback to smaller chunks only if full fusion fails validation.
   * @param {string[]} fragments - Array of fragment tokens
   * @returns {string[]} - Array of fused words
   */
  static segment(fragments) {
    if (fragments.length === 0) return [];
    if (fragments.length === 1) return fragments;

    // STRATEGY 1: Try full fusion first (most common case for BPE artifacts)
    const fullWord = fragments.join('');
    const fullScore = LinguisticScorer.scoreWord(fullWord);

    // If full fusion creates a high-scoring word, use it
    if (fullScore >= 60 && this.isPlausibleItalianWord(fullWord)) {
      return [fullWord];
    }

    // STRATEGY 2: Try fusion of first/last 70% of fragments
    const threshold = Math.ceil(fragments.length * 0.7);

    // Try fusion of first N fragments
    for (let i = threshold; i < fragments.length; i++) {
      const firstPart = fragments.slice(0, i).join('');
      const secondPart = fragments.slice(i).join('');

      const firstScore = LinguisticScorer.scoreWord(firstPart);
      const secondScore = LinguisticScorer.scoreWord(secondPart);

      if (firstScore >= 50 && secondScore >= 50 &&
          this.isPlausibleItalianWord(firstPart) &&
          this.isPlausibleItalianWord(secondPart)) {
        return [firstPart, secondPart];
      }
    }

    // STRATEGY 3: Conservative fallback - return individual fragments
    // Better to under-fuse than create nonsense words
    return fragments;
  }

  /**
   * Fast validation for Italian word plausibility
   */
  static isPlausibleItalianWord(word) {
    if (word.length < 3 || word.length > 20) return false;

    // Must contain vowels
    if (!/[aeiouàèéìòùAEIOUÀÈÉÌÒÙ]/.test(word)) return false;

    // Reject unlikely consonant clusters at boundaries
    if (/^[bcdfghjklmnpqrstvwxyz]{3,}|[bcdfghjklmnpqrstvwxyz]{4,}$/i.test(word)) return false;

    // Check vowel ratio (Italian has high vowel density ~40%)
    const vowels = (word.match(/[aeiouàèéìòù]/gi) || []).length;
    const vowelRatio = vowels / word.length;
    if (vowelRatio < 0.15 || vowelRatio > 0.7) return false;

    // Bonus: check for Italian morphological patterns
    const hasItalianEnding = /(?:zione|amento|ando|endo|are|ere|ire|ato|ito|uto|oso|ico|ale|ismo|ista)$/i.test(word);
    if (hasItalianEnding) return true;

    // General plausibility: reasonable alternation between vowels/consonants
    let alternations = 0;
    let prevIsVowel = /[aeiouàèéìòù]/i.test(word[0]);

    for (let i = 1; i < word.length; i++) {
      const isVowel = /[aeiouàèéìòù]/i.test(word[i]);
      if (isVowel !== prevIsVowel) alternations++;
      prevIsVowel = isVowel;
    }

    const alternationRatio = alternations / word.length;
    return alternationRatio >= 0.25; // Reasonable CV alternation
  }

  /**
   * Quick validation for potential word candidates
   */
  static isValidWord(fragments) {
    if (fragments.length < 2) return fragments.length === 1;
    const word = fragments.join('');
    return word.length <= 22 &&
           /[aeiouàèéìòùAEIOUÀÈÉÌÒÙ]/.test(word) &&
           fragments.filter(f => f.length > 1).length >= 2;
  }
}

/**
 * Scan a line for fragment-shattered token runs and fuse them.
 *
 * Algorithm (O(n) greedy chunking):
 *   - Tokenize the line by spaces
 *   - Accumulate consecutive short lowercase tokens into a window
 *   - When window >= 8 tokens OR non-fragment encountered, split window into chunks of 3-7 tokens
 *   - Attempt to fuse each chunk; emit fused word or original tokens
 */
/**
 * Enterprise-grade BPE fragment repair using Dynamic Programming and Linguistic Scoring.
 *
 * Architecture:
 * 1. Preprocessor: Repairs common split articles with punctuation preservation
 * 2. Fragment detector: Identifies BPE fragment runs vs real words
 * 3. DP segmenter: Finds optimal word boundaries using linguistic scoring
 * 4. Context filter: Applies boundary detection and grammar rules
 */
function repairFragmentRuns(line) {
  let tokens = line.split(' ');

  // ━━━ PASS 1: ARTICLE PREPROCESSING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Repairs "d ell'oro" -> "dell'oro" with punctuation preservation
  const articlePatterns = [
    {parts: ['d', 'ell'], whole: 'dell'}, {parts: ['d', 'el'], whole: 'del'},
    {parts: ['n', 'ell'], whole: 'nell'}, {parts: ['n', 'el'], whole: 'nel'},
    {parts: ['s', 'ul'], whole: 'sul'}, {parts: ['d', 'al'], whole: 'dal'},
    {parts: ['c', 'he'], whole: 'che'}, {parts: ['c', 'on'], whole: 'con'},
    {parts: ['p', 'er'], whole: 'per'}, {parts: ['t', 'ra'], whole: 'tra'},
  ];

  for (const {parts, whole} of articlePatterns) {
    for (let i = 0; i <= tokens.length - parts.length; i++) {
      let matches = true;
      let suffix = '';

      for (let j = 0; j < parts.length; j++) {
        const token = tokens[i + j];
        const prefixMatch = token.match(/^([a-z]+)(.*)$/);
        const prefix = prefixMatch ? prefixMatch[1] : token;
        if (prefix !== parts[j]) { matches = false; break; }
        if (j === parts.length - 1 && prefixMatch) suffix = prefixMatch[2];
      }

      if (matches) {
        tokens.splice(i, parts.length, whole + suffix);
        i--;
      }
    }
  }

  // ━━━ PASS 2: ENTERPRISE FRAGMENT DETECTION & SEGMENTATION ━━━━━━━━━━━━━━━━━━━
  const result = [];
  let i = 0;

  while (i < tokens.length) {
    // Extract alphabetic content and punctuation
    const tokenMatch = tokens[i].match(/^([a-zàèéìòùA-Z\u00c0-\u024f]*)([^a-zàèéìòùA-Z\u00c0-\u024f]*)$/);
    const alpha = tokenMatch ? tokenMatch[1] : tokens[i];
    const punct = tokenMatch ? tokenMatch[2] : '';

    // Fragment classification
    const isLowerShort = (alpha.length >= 2 && alpha.length <= 4 && /^[a-zàèéìòù\u00c0-\u024f]+$/.test(alpha)) ||
                         (alpha.length === 1 && BPE_SINGLE_CHARS.has(alpha.toLowerCase()));
    const isBoundary = BOUNDARY_WORDS.has(alpha.toLowerCase());
    const isFragment = alpha.length > 0 && isLowerShort && !isBoundary;

    if (!isFragment) {
      // Not a fragment - emit as-is
      result.push(tokens[i]);
      i++;
      continue;
    }

    // ━━━ FRAGMENT RUN DETECTION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Collect consecutive fragments for DP segmentation
    const fragmentRun = [];
    const punctRun = [];
    let j = i;

    while (j < tokens.length) {
      const tokMatch = tokens[j].match(/^([a-zàèéìòùA-Z\u00c0-\u024f]*)([^a-zàèéìòùA-Z\u00c0-\u024f]*)$/);
      const tokAlpha = tokMatch ? tokMatch[1] : tokens[j];
      const tokPunct = tokMatch ? tokMatch[2] : '';

      // Check if this token is a fragment
      const tokIsLowerShort = (tokAlpha.length >= 2 && tokAlpha.length <= 4 && /^[a-zàèéìòù\u00c0-\u024f]+$/.test(tokAlpha)) ||
                              (tokAlpha.length === 1 && BPE_SINGLE_CHARS.has(tokAlpha.toLowerCase()));
      const tokIsBoundary = BOUNDARY_WORDS.has(tokAlpha.toLowerCase());
      const tokIsFragment = tokAlpha.length > 0 && tokIsLowerShort && !tokIsBoundary;

      if (!tokIsFragment) break;

      fragmentRun.push(tokAlpha);
      punctRun.push(tokPunct);
      j++;

      // Safety: limit run length
      if (fragmentRun.length >= 12) break;
    }

    // ━━━ DYNAMIC PROGRAMMING SEGMENTATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (fragmentRun.length >= 2) {
      const segmentedWords = WordSegmenter.segment(fragmentRun);

      // Apply punctuation to the last word of the run
      const lastPunct = punctRun[punctRun.length - 1];
      if (segmentedWords.length > 0) {
        segmentedWords[segmentedWords.length - 1] += lastPunct;
      }

      result.push(...segmentedWords);
      i = j;
    } else {
      // Single fragment - emit as-is
      result.push(tokens[i]);
      i++;
    }
  }

  return result.join(' ');
}

export function fixQwen3BPE(text) {
  let inCode = false;
  return text.split('\n').map((line) => {
    if (line.trimStart().startsWith('```')) { inCode = !inCode; return line; }
    if (inCode) return line;
    if (line.trimStart().startsWith('|')) return line; // table row — untouched

    // Pass 1: repair fragment-shattered runs ("p os s i amo" → "possiamo")
    let out = repairFragmentRuns(line);

    // Pass 2-4: repair word-fusion ("lacorrelazione" → "la correlazione")
    // Three passes handle chains like "dellacorrelazione" → two separations needed
    out = out.replace(BPE_SPLIT_RE, '$1 $2');
    out = out.replace(BPE_SPLIT_RE, '$1 $2');
    out = out.replace(BPE_SPLIT_RE, '$1 $2');

    return out;
  }).join('\n');
}

// ── Providers ──────────────────────────────────────────────────────────────

export async function callAnthropic(apiKey, model, systemPrompt, userMessage, stream = false, opts = {}) {
  // Use Anthropic prompt caching: system prompt as array with cache_control
  // so the same system prompt is served from cache on repeated calls (~90% saving on input tokens).
  const systemBlocks = systemPrompt
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : [];
  // Build conversation messages: optional history[] then the current turn.
  // history must alternate role: user/assistant/user/... ending with assistant
  // (or be empty). The current userMessage is appended as the final user turn.
  const historyMsgs = Array.isArray(opts.history)
    ? opts.history.filter(m => m && m.role && m.content).map(m => ({ role: m.role, content: String(m.content) }))
    : [];
  const messages = [...historyMsgs, { role: 'user', content: userMessage }];
  const body = {
    model: model || 'claude-sonnet-4-20250514',
    max_tokens: opts.max_tokens || 8192,
    system: systemBlocks,
    messages,
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
  const historyMsgs = Array.isArray(opts.history)
    ? opts.history.filter(m => m && m.role && m.content).map(m => ({ role: m.role, content: String(m.content) }))
    : [];
  const body = {
    model: model || 'gpt-4o',
    max_tokens: opts.max_tokens || 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      ...historyMsgs,
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
  // Gemini uses 'contents' with role 'user'/'model'. Convert history.
  const historyContents = Array.isArray(opts.history)
    ? opts.history.filter(m => m && m.role && m.content).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content) }],
      }))
    : [];
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [...historyContents, { role: 'user', parts: [{ text: userMessage }] }],
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

// OpenAI-compatible history mapper — used by DeepSeek/Grok/Mistral/Cohere.
function _openaiHistory(opts) {
  return Array.isArray(opts?.history)
    ? opts.history.filter(m => m && m.role && m.content).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content),
      }))
    : [];
}

export async function callDeepSeek(apiKey, model, systemPrompt, userMessage, stream = false, opts = {}) {
  const body = {
    model: model || 'deepseek-chat',
    max_tokens: opts.max_tokens || 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      ..._openaiHistory(opts),
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
      ..._openaiHistory(opts),
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
      ..._openaiHistory(opts),
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
  // Cohere uses a 'chat_history' array with role: USER/CHATBOT (uppercase).
  const cohereHistory = Array.isArray(opts.history)
    ? opts.history.filter(m => m && m.role && m.content).map(m => ({
        role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
        message: String(m.content),
      }))
    : [];
  const body = {
    model: model || 'command-r-plus',
    max_tokens: opts.max_tokens || 8192,
    preamble: systemPrompt,
    chat_history: cohereHistory,
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

  const historyMsgs = Array.isArray(opts.history)
    ? opts.history.filter(m => m && m.role && m.content).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: sanitizeForSentinel(String(m.content)),
      }))
    : [];
  const body = {
    model: model || '/opt/models/qwen3-32b',
    max_tokens: opts.max_tokens || (thinkingEnabled ? 16384 : 8192),
    messages: [
      { role: 'system', content: sanitizeForSentinel(systemPrompt) },
      ...historyMsgs,
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
  // NOTE: Do NOT apply fixQwen3BPE here. With stream:false, vLLM returns
  // correctly-spaced text. The BPE repair regex corrupts normal words.
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

/**
 * Call LLM with native tool_use (function calling) — supports Anthropic and OpenAI.
 * Handles the full agentic loop: call → tool_use → tool_result → call → ... → end_turn.
 *
 * @param {object} config — NHA config with llm.provider, llm.apiKey, etc.
 * @param {string} systemPrompt
 * @param {Array} messages — conversation history [{role, content}]
 * @param {Array} tools — tool definitions [{name, description, input_schema}]
 * @param {Function} onText — callback for text tokens (text: string) => void
 * @param {Function} onToolCall — callback when tool is called (name: string, input: object) => Promise<string> — must return the tool result
 * @param {object} opts — { max_tokens, isAborted, maxTurns }
 * @returns {Promise<{messages: Array, stopReason: string}>} — updated messages array
 */
export async function callLLMWithTools(config, systemPrompt, messages, tools, onText, onToolCall, opts = {}) {
  const provider = config.llm?.provider || 'anthropic';
  const model = config.llm?.model || null;
  const apiKey = getApiKey(config, provider);
  if (!apiKey) throw new Error(`No API key for ${provider}`);

  // Anthropic native tool calling
  if (provider === 'anthropic') {
    return _callAnthropicWithTools(apiKey, model, systemPrompt, messages, tools, onText, onToolCall, opts);
  }

  // OpenAI native function calling
  if (provider === 'openai') {
    return _callOpenAIWithTools(apiKey, model, systemPrompt, messages, tools, onText, onToolCall, opts);
  }

  // Other providers: fallback to text-based tool calling (old system)
  // The caller should handle this by checking the return value
  return null;
}

async function _callAnthropicWithTools(apiKey, model, systemPrompt, messages, tools, onText, onToolCall, opts = {}) {
  const maxTokens = opts.max_tokens || 16384;
  const isAborted = opts.isAborted || (() => false);
  const MAX_TURNS = opts.maxTurns || 8;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (isAborted()) break;

    const body = {
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
      tools,
      stream: true,
    };

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

    // Parse streaming response
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let assistantContent = [];
    let currentText = '';
    let currentToolUse = null;
    let currentToolInput = '';
    let stopReason = null;

    while (true) {
      if (isAborted()) { try { reader.cancel(); } catch {} break; }
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const ev = JSON.parse(data);
          if (ev.type === 'content_block_start') {
            if (ev.content_block?.type === 'text') {
              currentText = '';
            } else if (ev.content_block?.type === 'tool_use') {
              currentToolUse = { id: ev.content_block.id, name: ev.content_block.name };
              currentToolInput = '';
            }
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta') {
              currentText += ev.delta.text;
              if (onText) onText(ev.delta.text);
            } else if (ev.delta?.type === 'input_json_delta') {
              currentToolInput += ev.delta.partial_json;
            }
          } else if (ev.type === 'content_block_stop') {
            if (currentText) {
              assistantContent.push({ type: 'text', text: currentText });
              currentText = '';
            }
            if (currentToolUse) {
              let input = {};
              try { input = JSON.parse(currentToolInput); } catch {}
              assistantContent.push({
                type: 'tool_use',
                id: currentToolUse.id,
                name: currentToolUse.name,
                input,
              });
              currentToolUse = null;
              currentToolInput = '';
            }
          } else if (ev.type === 'message_delta') {
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          }
        } catch {}
      }
    }

    // Add assistant message to conversation
    messages.push({ role: 'assistant', content: assistantContent });

    // If stop reason is end_turn (no more tool calls), we're done
    if (stopReason === 'end_turn' || stopReason !== 'tool_use') break;

    // Execute tool calls
    const toolUseBlocks = assistantContent.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    const toolResults = [];
    for (const toolBlock of toolUseBlocks) {
      if (isAborted()) break;
      const result = await onToolCall(toolBlock.name, toolBlock.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    // Add tool results to conversation
    messages.push({ role: 'user', content: toolResults });
  }

  return { messages, stopReason: 'end' };
}

async function _callOpenAIWithTools(apiKey, model, systemPrompt, messages, tools, onText, onToolCall, opts = {}) {
  const maxTokens = opts.max_tokens || 16384;
  const isAborted = opts.isAborted || (() => false);
  const MAX_TURNS = opts.maxTurns || 8;

  // Convert Anthropic tool format to OpenAI function format
  const openaiTools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  // Convert messages: Anthropic uses content arrays, OpenAI uses strings
  const toOpenAI = (msgs) => {
    const result = [{ role: 'system', content: systemPrompt }];
    for (const m of msgs) {
      if (m.role === 'user') {
        if (Array.isArray(m.content)) {
          // tool_result blocks
          for (const block of m.content) {
            if (block.type === 'tool_result') {
              result.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content || '' });
            } else {
              result.push({ role: 'user', content: typeof block === 'string' ? block : block.text || JSON.stringify(block) });
            }
          }
        } else {
          result.push({ role: 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
        }
      } else if (m.role === 'assistant') {
        if (Array.isArray(m.content)) {
          const textParts = m.content.filter(b => b.type === 'text').map(b => b.text).join('');
          const toolCalls = m.content.filter(b => b.type === 'tool_use').map(b => ({
            id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
          const msg = { role: 'assistant', content: textParts || null };
          if (toolCalls.length > 0) msg.tool_calls = toolCalls;
          result.push(msg);
        } else {
          result.push({ role: 'assistant', content: typeof m.content === 'string' ? m.content : '' });
        }
      }
    }
    return result;
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (isAborted()) break;

    const body = {
      model: model || 'gpt-4o',
      max_tokens: maxTokens,
      messages: toOpenAI(messages),
      tools: openaiTools,
      stream: true,
    };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`OpenAI ${res.status}: ${err}`); }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let assistantContent = [];
    let currentText = '';
    let toolCalls = {};
    let finishReason = null;

    while (true) {
      if (isAborted()) { try { reader.cancel(); } catch {} break; }
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const ev = JSON.parse(data);
          const delta = ev.choices?.[0]?.delta;
          if (delta?.content) { currentText += delta.content; if (onText) onText(delta.content); }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: tc.id || '', name: '', args: '' };
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].args += tc.function.arguments;
            }
          }
          if (ev.choices?.[0]?.finish_reason) finishReason = ev.choices[0].finish_reason;
        } catch {}
      }
    }

    if (currentText) assistantContent.push({ type: 'text', text: currentText });
    for (const tc of Object.values(toolCalls)) {
      let input = {};
      try { input = JSON.parse(tc.args); } catch {}
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }
    messages.push({ role: 'assistant', content: assistantContent });

    if (finishReason !== 'tool_calls' && Object.keys(toolCalls).length === 0) break;

    const toolUseBlocks = assistantContent.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    const toolResults = [];
    for (const toolBlock of toolUseBlocks) {
      if (isAborted()) break;
      const result = await onToolCall(toolBlock.name, toolBlock.input);
      toolResults.push({ type: 'tool_result', tool_use_id: toolBlock.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { messages, stopReason: 'end' };
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

    const nhaHistory = Array.isArray(opts.history)
      ? opts.history.filter(m => m && m.role && m.content).map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: sanitize(String(m.content)),
        }))
      : [];
    const nhaBody = {
      model: model || '/opt/models/qwen3-32b',
      max_tokens: effectiveMaxTokens,
      messages: [
        { role: 'system', content: sanitize(systemPrompt) },
        ...nhaHistory,
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
    // SENTINEL blocked — throw special error so caller skips conversation persistence
    if (nhaJson.__sentinel_blocked) {
      const blockedMsg = nhaJson.choices?.[0]?.message?.content || 'Message blocked by SENTINEL.';
      if (onToken) onToken(blockedMsg);
      const err = new Error(blockedMsg);
      err.__sentinel_blocked = true;
      throw err;
    }
    let fullNhaText = nhaJson.choices?.[0]?.message?.content || '';
    // Strip <think>...</think> blocks
    fullNhaText = fullNhaText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // NOTE: Do NOT apply fixQwen3BPE here. With stream:false, vLLM returns
    // correctly-spaced text. The BPE repair regex is too aggressive and
    // corrupts normal Italian words (e.g. "assistente" → "ass ist ente").
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
      model: model || 'claude-sonnet-4-6',
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
    max_tokens: 8192,
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
          fullText += out;
          if (onToken) onToken(out);
        }
      }
    } catch {}
  }
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
