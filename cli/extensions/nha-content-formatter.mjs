/**
 * nha-content-formatter — PIF Extension v2.2.0
 *
 * Formats post content with markdown, code blocks, headers, and structured output.
 * Includes AI-powered formatting via SCHEHERAZADE agent for polished, publication-ready content,
 * with smart local heading detection and code block language inference.
 *
 * @category content-creation
 * @version 2.2.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   // Local formatting
 *   import { formatPost, codeBlock, bulletList } from './extensions/nha-content-formatter.mjs';
 *   const post = formatPost('My Title', [{ title: 'Intro', body: 'Hello world' }]);
 *
 * @example
 *   // AI-powered formatting
 *   import { aiFormat, readabilityScore } from './extensions/nha-content-formatter.mjs';
 *   const polished = await aiFormat('rough notes here...', { style: 'technical' });
 *
 * @example
 *   // Local analysis
 *   import { detectHeadingsLocally, detectCodeBlocks } from './extensions/nha-content-formatter.mjs';
 *   const headings = detectHeadingsLocally(rawText);
 *   const codeBlocks = detectCodeBlocks(rawText);
 *
 * @example
 *   // CLI usage
 *   pif ext nha-content-formatter --input "raw text here" --style technical --toc
 *   pif ext nha-content-formatter --input ./notes.md --style narrative
 */

const NHA_API = 'https://nothumanallowed.com/api/v1';

/** Maximum retry attempts for agent invocation */
const MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff */
const BASE_BACKOFF_MS = 500;

/** Fetch timeout in ms */
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Invoke a Legion agent via the NHA API with retry and exponential backoff.
 * @param {string} agentName - The agent identifier (e.g. 'SCHEHERAZADE')
 * @param {string} prompt - The task prompt
 * @param {object} config - Additional body parameters
 * @returns {Promise<{ok: boolean, data?: string, error?: string, durationMs?: number}>}
 */
const invokeAgent = async (agentName, prompt, config = {}) => {
  const totalStart = Date.now();
  let lastError = '';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * BASE_BACKOFF_MS;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`${NHA_API}/legion/agents/${agentName}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...config }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.text().catch(() => 'unknown error');
        lastError = `HTTP ${res.status}: ${body}`;
        // Retry on 5xx or 429
        if (res.status >= 500 || res.status === 429) {
          continue;
        }
        // 4xx (except 429) is not retryable
        return { ok: false, error: lastError };
      }

      const json = await res.json();
      return {
        ok: true,
        data: json.data?.response ?? json.response ?? '',
        durationMs: json.data?.durationMs ?? (Date.now() - totalStart),
      };
    } catch (err) {
      lastError = err.name === 'AbortError'
        ? `Request timed out after ${FETCH_TIMEOUT_MS}ms`
        : `Network error: ${err.message}`;
      if (attempt < MAX_RETRIES - 1) continue;
      return { ok: false, error: `${lastError} (after ${MAX_RETRIES} attempts)` };
    }
  }

  return { ok: false, error: `${lastError} (after ${MAX_RETRIES} attempts)` };
};

/**
 * Safely extract JSON from an AI response string.
 * @param {string} text
 * @returns {object|null}
 */
const extractJSON = (text) => {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { /* continue */ }
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (match) { try { return JSON.parse(match[1]); } catch { /* continue */ } }
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) { try { return JSON.parse(jsonMatch[1]); } catch { /* continue */ } }
  return null;
};

// ---------------------------------------------------------------------------
// Local pure functions — fast, no network
// ---------------------------------------------------------------------------

/**
 * Format text with a header and body section.
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
const formatSection = (title, body) => `## ${title}\n\n${body}\n`;

/**
 * Wrap content in a fenced code block.
 * @param {string} code
 * @param {string} [lang='']
 * @returns {string}
 */
const codeBlock = (code, lang = '') => `\`\`\`${lang}\n${code}\n\`\`\``;

/**
 * Create a bullet list from an array of items.
 * @param {string[]} items
 * @returns {string}
 */
const bulletList = (items) => items.map((item) => `- ${item}`).join('\n');

/**
 * Create a numbered list from an array of items.
 * @param {string[]} items
 * @returns {string}
 */
const numberedList = (items) => items.map((item, i) => `${i + 1}. ${item}`).join('\n');

/**
 * Format a key-value table (2 columns).
 * @param {Array<[string, string]>} pairs
 * @returns {string}
 */
const kvTable = (pairs) => {
  const maxKeyLen = pairs.reduce((max, p) => Math.max(max, p[0].length), 3);
  const header = `| ${'Key'.padEnd(maxKeyLen)} | Value |`;
  const sep = `| ${'-'.repeat(maxKeyLen)} | ----- |`;
  const rows = pairs.map((p) => `| ${p[0].padEnd(maxKeyLen)} | ${p[1]} |`);
  return [header, sep, ...rows].join('\n');
};

/**
 * Wrap text to a maximum line length.
 * @param {string} text
 * @param {number} [maxLen=80]
 * @returns {string}
 */
const wrapText = (text, maxLen = 80) => {
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const w of words) {
    if (current.length + w.length + 1 > maxLen) {
      lines.push(current);
      current = w;
    } else {
      current = current ? `${current} ${w}` : w;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
};

/**
 * Create a formatted post structure with title and sections.
 * @param {string} title
 * @param {Array<{title: string, body: string}>} sections
 * @returns {string}
 */
const formatPost = (title, sections) => {
  let output = `# ${title}\n\n`;
  for (const s of sections) {
    output += formatSection(s.title, s.body) + '\n';
  }
  return output.trim();
};

/**
 * Escape markdown special characters in plain text.
 * @param {string} text
 * @returns {string}
 */
const escapeMarkdown = (text) => text.replace(/([*_~`|\\[\]()#>+\-!])/g, '\\$1');

/**
 * Create a blockquote from text (handles multiline).
 * @param {string} text
 * @returns {string}
 */
const blockquote = (text) => text.split('\n').map((line) => `> ${line}`).join('\n');

/**
 * Extract headings from raw text using simple heuristics (legacy — kept for backward compat).
 * @param {string} text
 * @returns {Array<{title: string, body: string}>}
 */
const extractLocalHeadings = (text) => {
  const lines = text.split('\n');
  const sections = [];
  let currentTitle = 'Introduction';
  let currentBody = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      if (currentBody.length > 0) {
        sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
      }
      currentTitle = headingMatch[1];
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.length > 0) {
    sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
  }

  return sections;
};

// ---------------------------------------------------------------------------
// Smart local heading detection
// ---------------------------------------------------------------------------

/**
 * Check if a string is in Title Case (first letter of most words capitalized).
 * @param {string} str
 * @returns {boolean}
 */
const isTitleCase = (str) => {
  const trimmed = str.trim();
  if (trimmed.length === 0) return false;
  const words = trimmed.split(/\s+/);
  if (words.length === 0) return false;
  // Small words that don't need capitalization in titles
  const smallWords = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'vs']);
  let capitalizedCount = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length === 0) continue;
    // First word must always be capitalized
    if (i === 0 && /^[A-Z]/.test(word)) {
      capitalizedCount++;
    } else if (i > 0 && smallWords.has(word.toLowerCase())) {
      capitalizedCount++; // Small words are OK
    } else if (/^[A-Z]/.test(word)) {
      capitalizedCount++;
    }
  }
  return capitalizedCount >= words.length * 0.7;
};

/**
 * Check if a string is ALL CAPS.
 * @param {string} str
 * @returns {boolean}
 */
const isAllCaps = (str) => {
  const letters = str.replace(/[^a-zA-Z]/g, '');
  return letters.length >= 2 && letters === letters.toUpperCase();
};

/**
 * Detect heading structure from plain text using multiple heuristics.
 *
 * Heuristics applied:
 * 1. Existing markdown headings (#, ##, etc.) — preserved as-is
 * 2. Short lines (<80 chars) followed by a blank line then a paragraph
 * 3. ALL CAPS lines that are short
 * 4. Title Case lines that are short
 * 5. Lines ending with `:` followed by indented/block content
 * 6. Lines starting with a number + period (e.g., `1. Introduction`)
 *
 * @param {string} text - The raw text to analyze
 * @returns {{ headings: Array<{level: number, text: string, line: number}>, structure: 'flat'|'hierarchical' }}
 */
const detectHeadingsLocally = (text) => {
  const lines = text.split('\n');
  const headings = [];
  const MAX_HEADING_LENGTH = 80;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) continue;

    // 1. Existing markdown headings — preserve
    const mdMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (mdMatch) {
      headings.push({ level: mdMatch[1].length, text: mdMatch[2].trim(), line: i + 1 });
      continue;
    }

    // Skip lines inside code blocks
    if (trimmed.startsWith('```')) {
      // Fast-forward past the code block
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        i++;
      }
      continue;
    }

    // Only consider short lines as potential headings
    if (trimmed.length > MAX_HEADING_LENGTH) continue;

    // Determine if the next non-empty line looks like body text
    const nextNonEmpty = findNextNonEmptyLine(lines, i);
    const hasBlankAfter = i + 1 < lines.length && lines[i + 1].trim() === '';
    const nextIsBody = nextNonEmpty !== null && nextNonEmpty.length > trimmed.length;

    // 2. Short line + blank line + paragraph = likely heading
    if (hasBlankAfter && nextIsBody && trimmed.length < 60 && !trimmed.endsWith(',') && !trimmed.endsWith(';')) {
      // Check it is not just a short sentence (ending with period + lowercase start is likely a sentence)
      if (!trimmed.match(/^[a-z]/) || isTitleCase(trimmed) || isAllCaps(trimmed)) {
        const level = isAllCaps(trimmed) ? 1 : 2;
        headings.push({ level, text: trimmed, line: i + 1 });
        continue;
      }
    }

    // 3. ALL CAPS short line
    if (isAllCaps(trimmed) && trimmed.length >= 3 && trimmed.length < 60) {
      headings.push({ level: 1, text: trimmed, line: i + 1 });
      continue;
    }

    // 4. Title Case short line that is not a regular sentence
    if (isTitleCase(trimmed) && trimmed.length >= 3 && trimmed.length < 60 && !trimmed.match(/[.!?]$/)) {
      // Additional check: must not look like a list item or code
      if (!trimmed.match(/^[-*>]/) && !trimmed.includes('=') && !trimmed.includes('{')) {
        headings.push({ level: 2, text: trimmed, line: i + 1 });
        continue;
      }
    }

    // 5. Line ending with `:` followed by indented or block content
    if (trimmed.endsWith(':') && trimmed.length < 60) {
      const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
      if (nextLine.match(/^\s{2,}/) || nextLine.trim().match(/^[-*]/) || nextLine.trim() === '') {
        headings.push({ level: 3, text: trimmed.replace(/:$/, ''), line: i + 1 });
        continue;
      }
    }

    // 6. Numbered heading pattern: "1. Introduction", "2. Methods"
    const numberedMatch = trimmed.match(/^(\d{1,2})\.\s+([A-Z].{2,})/);
    if (numberedMatch && trimmed.length < 60 && !trimmed.match(/[.!?]$/)) {
      headings.push({ level: 2, text: numberedMatch[2].trim(), line: i + 1 });
      continue;
    }
  }

  // Determine structure: if we have multiple heading levels, it is hierarchical
  const levels = new Set(headings.map((h) => h.level));
  const structure = levels.size > 1 ? 'hierarchical' : 'flat';

  return { headings, structure };
};

/**
 * Find the next non-empty line content after index i.
 * @param {string[]} lines
 * @param {number} i
 * @returns {string|null}
 */
const findNextNonEmptyLine = (lines, i) => {
  for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
    const trimmed = lines[j].trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Code block detection with language inference
// ---------------------------------------------------------------------------

/**
 * Language detection patterns for code content analysis.
 * Each pattern has a set of indicators and their weights.
 * @type {Array<{language: string, patterns: Array<{regex: RegExp, weight: number}>}>}
 */
const LANGUAGE_SIGNATURES = [
  {
    language: 'javascript',
    patterns: [
      { regex: /\b(const|let|var)\s+\w+\s*=/, weight: 3 },
      { regex: /\b(import|export)\s+(default\s+)?(\{|function|class|const)/, weight: 4 },
      { regex: /=>\s*[{(]/, weight: 3 },
      { regex: /\bconsole\.(log|warn|error)\b/, weight: 3 },
      { regex: /\b(async|await)\b/, weight: 2 },
      { regex: /\brequire\s*\(/, weight: 3 },
      { regex: /\bmodule\.exports\b/, weight: 4 },
      { regex: /\b(document|window|setTimeout|setInterval)\b/, weight: 2 },
      { regex: /\.then\s*\(/, weight: 2 },
      { regex: /\bnew Promise\b/, weight: 3 },
      { regex: /\bfunction\s+\w+\s*\(/, weight: 3 },
      { regex: /<\w+[^>]*\/?>[\s\S]*?<\/\w+>/, weight: 3 }, // JSX elements
      { regex: /\breturn\s+\(?\s*</, weight: 5 }, // JSX return
      { regex: /className\s*=/, weight: 5 }, // React className (definitive JSX)
      { regex: /onClick\s*=\s*\{/, weight: 5 }, // React event handler
    ],
  },
  {
    language: 'typescript',
    patterns: [
      { regex: /:\s*(string|number|boolean|void|any|never|unknown)\b/, weight: 4 },
      { regex: /\binterface\s+\w+/, weight: 5 },
      { regex: /\btype\s+\w+\s*=/, weight: 5 },
      { regex: /\b(const|let)\s+\w+\s*:\s*\w+/, weight: 3 },
      { regex: /<\w+(\s*,\s*\w+)*>/, weight: 2 },
      { regex: /\bas\s+\w+/, weight: 3 },
      { regex: /\benum\s+\w+/, weight: 5 },
    ],
  },
  {
    language: 'python',
    patterns: [
      { regex: /\bdef\s+\w+\s*\(/, weight: 4 },
      { regex: /\bclass\s+\w+(\s*\(.*\))?\s*:/, weight: 4 },
      { regex: /^\s*(from|import)\s+\w+/, weight: 3 },
      { regex: /\bif\s+__name__\s*==\s*['"]__main__['"]/, weight: 5 },
      { regex: /\bprint\s*\(/, weight: 2 },
      { regex: /\bself\.\w+/, weight: 4 },
      { regex: /\belif\b/, weight: 5 },
      { regex: /\bTrue\b|\bFalse\b|\bNone\b/, weight: 3 },
      { regex: /^\s{4}\w/, weight: 1 },
      { regex: /\blambda\s+\w+\s*:/, weight: 3 },
      { regex: /\bwith\s+\w+.*\bas\s+\w+/, weight: 4 },
    ],
  },
  {
    language: 'sql',
    patterns: [
      { regex: /\bSELECT\b/i, weight: 3 },
      { regex: /\bFROM\b/i, weight: 2 },
      { regex: /\bWHERE\b/i, weight: 2 },
      { regex: /\bINSERT\s+INTO\b/i, weight: 4 },
      { regex: /\bCREATE\s+(TABLE|INDEX|VIEW|DATABASE)\b/i, weight: 5 },
      { regex: /\bALTER\s+TABLE\b/i, weight: 5 },
      { regex: /\bJOIN\b/i, weight: 3 },
      { regex: /\bGROUP\s+BY\b/i, weight: 4 },
      { regex: /\bORDER\s+BY\b/i, weight: 3 },
      { regex: /\bHAVING\b/i, weight: 4 },
    ],
  },
  {
    language: 'html',
    patterns: [
      { regex: /<(!DOCTYPE|html|head|body)\b/i, weight: 5 },
      { regex: /<(div|span|p|a|img|table|form|input)\b/i, weight: 2 },
      { regex: /<\/\w+>/, weight: 2 },
      { regex: /\bclass\s*=\s*["']/, weight: 3 },
      { regex: /\bhref\s*=\s*["']/, weight: 3 },
      { regex: /\bstyle\s*=\s*["']/, weight: 2 },
      { regex: /<script\b/, weight: 3 },
      { regex: /<link\b.*rel=/, weight: 4 },
    ],
  },
  {
    language: 'css',
    patterns: [
      { regex: /\{[\s\S]*?(color|margin|padding|display|font-size|background)\s*:/, weight: 4 },
      { regex: /\.([\w-]+)\s*\{/, weight: 3 },
      { regex: /#([\w-]+)\s*\{/, weight: 3 },
      { regex: /@media\b/, weight: 5 },
      { regex: /@import\b/, weight: 4 },
      { regex: /@keyframes\b/, weight: 5 },
    ],
  },
  {
    language: 'go',
    patterns: [
      { regex: /\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\(/, weight: 5 },
      { regex: /\bpackage\s+\w+/, weight: 5 },
      { regex: /\bimport\s+(\(|")/, weight: 4 },
      { regex: /\bfmt\.(Print|Sprint|Fprint)/, weight: 5 },
      { regex: /:=/, weight: 3 },
      { regex: /\bgo\s+func\b/, weight: 5 },
      { regex: /\bchan\s+\w+/, weight: 5 },
      { regex: /\bdefer\s+/, weight: 5 },
      { regex: /\bgoroutine\b/, weight: 4 },
    ],
  },
  {
    language: 'rust',
    patterns: [
      { regex: /\bfn\s+\w+/, weight: 4 },
      { regex: /\blet\s+mut\s+/, weight: 5 },
      { regex: /\buse\s+\w+(::\w+)+/, weight: 5 },
      { regex: /\bimpl\s+/, weight: 5 },
      { regex: /\bpub\s+(fn|struct|enum|mod)\b/, weight: 5 },
      { regex: /\bmatch\s+\w+\s*\{/, weight: 4 },
      { regex: /\bOption</, weight: 4 },
      { regex: /\bResult</, weight: 4 },
      { regex: /\bvec!\[/, weight: 5 },
      { regex: /\bprintln!\(/, weight: 5 },
      { regex: /&\w+/, weight: 1 },
    ],
  },
  {
    language: 'java',
    patterns: [
      { regex: /\bpublic\s+(static\s+)?class\s+\w+/, weight: 5 },
      { regex: /\bpublic\s+static\s+void\s+main\b/, weight: 5 },
      { regex: /\bSystem\.out\.println\b/, weight: 5 },
      { regex: /\bprivate\s+(final\s+)?\w+\s+\w+/, weight: 3 },
      { regex: /\bimport\s+java\./, weight: 5 },
      { regex: /@Override\b/, weight: 5 },
      { regex: /\bnew\s+\w+\s*\(/, weight: 2 },
    ],
  },
  {
    language: 'bash',
    patterns: [
      { regex: /^#!/, weight: 5 },
      { regex: /\becho\s+/, weight: 3 },
      { regex: /\b(if|then|fi|else|elif)\b/, weight: 3 },
      { regex: /\b(for|while|do|done)\b/, weight: 3 },
      { regex: /\$\{?\w+\}?/, weight: 2 },
      { regex: /\bgrep\b|\bsed\b|\bawk\b|\bcurl\b/, weight: 3 },
      { regex: /\bchmod\b|\bchown\b|\bmkdir\b/, weight: 4 },
      { regex: /\|\s*\w+/, weight: 2 },
    ],
  },
  {
    language: 'json',
    patterns: [
      { regex: /^\s*\{/, weight: 1 },
      { regex: /"\w+"\s*:\s*["{\[\d]/, weight: 3 },
      { regex: /^\s*\[\s*\{/, weight: 3 },
    ],
  },
  {
    language: 'yaml',
    patterns: [
      { regex: /^\w+:\s*$/, weight: 3 },
      { regex: /^\s+-\s+\w+/, weight: 2 },
      { regex: /^---\s*$/, weight: 4 },
      { regex: /\b(apiVersion|kind|metadata|spec)\s*:/, weight: 5 },
    ],
  },
];

/**
 * Infer the programming language of a code snippet by pattern matching.
 * Returns the best-matching language or '' if confidence is too low.
 * @param {string} code - The code content to analyze
 * @returns {string} The detected language identifier or empty string
 */
const inferCodeLanguage = (code) => {
  if (!code || code.trim().length === 0) return '';

  const scores = {};

  for (const sig of LANGUAGE_SIGNATURES) {
    let score = 0;
    for (const p of sig.patterns) {
      if (p.regex.test(code)) {
        score += p.weight;
      }
    }
    if (score > 0) {
      scores[sig.language] = score;
    }
  }

  // TypeScript is a superset of JavaScript — if both score, prefer TS if it scores higher
  if (scores.typescript && scores.javascript) {
    if (scores.typescript >= scores.javascript) {
      delete scores.javascript;
    } else {
      delete scores.typescript;
    }
  }

  const entries = Object.entries(scores);
  if (entries.length === 0) return '';

  entries.sort((a, b) => b[1] - a[1]);
  const [bestLang, bestScore] = entries[0];

  // Require a minimum confidence threshold
  if (bestScore < 4) return '';

  return bestLang;
};

/**
 * Detect fenced code blocks in text and infer their language from content patterns.
 * Handles both annotated (```js) and unannotated (```) blocks.
 *
 * @param {string} text - The text to scan for code blocks
 * @returns {{ blocks: Array<{start: number, end: number, language: string, content: string, annotated: boolean}> }}
 */
const detectCodeBlocks = (text) => {
  const lines = text.split('\n');
  const blocks = [];
  let inBlock = false;
  let blockStart = -1;
  let annotatedLang = '';
  let blockContent = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (!inBlock) {
      const fenceMatch = trimmed.match(/^```(\w*)$/);
      if (fenceMatch) {
        inBlock = true;
        blockStart = i + 1; // 1-indexed
        annotatedLang = fenceMatch[1] || '';
        blockContent = [];
      }
    } else {
      if (trimmed === '```') {
        // End of block
        const content = blockContent.join('\n');
        const inferredLang = annotatedLang || inferCodeLanguage(content);
        blocks.push({
          start: blockStart,
          end: i + 1, // 1-indexed
          language: inferredLang,
          content,
          annotated: annotatedLang !== '',
        });
        inBlock = false;
        blockStart = -1;
        annotatedLang = '';
        blockContent = [];
      } else {
        blockContent.push(lines[i]);
      }
    }
  }

  // Handle unclosed code block at end of text
  if (inBlock && blockContent.length > 0) {
    const content = blockContent.join('\n');
    const inferredLang = annotatedLang || inferCodeLanguage(content);
    blocks.push({
      start: blockStart,
      end: lines.length,
      language: inferredLang,
      content,
      annotated: annotatedLang !== '',
    });
  }

  return { blocks };
};

// ---------------------------------------------------------------------------
// AI-powered functions — require network
// ---------------------------------------------------------------------------

/**
 * Send raw text/notes to SCHEHERAZADE to produce polished, structured content.
 * Falls back to local formatPost with heading extraction if AI is unavailable.
 * @param {string} rawText - Raw text or notes to format
 * @param {object} [options]
 * @param {'technical'|'narrative'|'tutorial'} [options.style='technical'] - Output style
 * @param {number} [options.maxLength] - Maximum character length for the output
 * @param {boolean} [options.includeToC=false] - Whether to include a Table of Contents
 * @returns {Promise<{ok: boolean, formatted?: string, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const aiFormat = async (rawText, options = {}) => {
  const { style = 'technical', maxLength, includeToC = false } = options;

  const constraints = [];
  if (maxLength) constraints.push(`Maximum length: ${maxLength} characters.`);
  if (includeToC) constraints.push('Include a Table of Contents at the top.');

  const prompt = [
    `You are a professional content formatter. Transform the following raw text into polished, well-structured content.`,
    ``,
    `Style: ${style}`,
    `- technical: precise language, clear sections, code examples where relevant`,
    `- narrative: engaging storytelling, smooth transitions, vivid descriptions`,
    `- tutorial: step-by-step structure, numbered instructions, practical examples`,
    ``,
    constraints.length > 0 ? `Constraints:\n${constraints.map((c) => `- ${c}`).join('\n')}\n` : '',
    `Output format: Markdown with proper headings, lists, and emphasis.`,
    `Do NOT include any preamble — output ONLY the formatted content.`,
    ``,
    `--- RAW TEXT ---`,
    rawText,
  ].filter(Boolean).join('\n');

  const result = await invokeAgent('SCHEHERAZADE', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Fallback: local formatting with basic heading extraction
    const sections = extractLocalHeadings(rawText);
    const title = sections.length > 0 ? sections[0].title : 'Formatted Content';
    const formatted = formatPost(title, sections.length > 1 ? sections : [{ title: 'Content', body: rawText }]);
    return { ok: true, formatted, durationMs: 0, fallback: true };
  }

  return { ok: true, formatted: result.data, durationMs: result.durationMs };
};

/**
 * Analyze text and suggest an optimal heading structure.
 * First runs local detection heuristics, then enhances with AI if available.
 * If AI fails, returns local-only results.
 * @param {string} text - Text to analyze
 * @returns {Promise<{ok: boolean, headings?: string, localAnalysis?: object, error?: string, fallback?: boolean}>}
 */
const autoHeadings = async (text) => {
  // Step 1: Always run local detection first
  const localResult = detectHeadingsLocally(text);

  // Build a local heading outline for display and as AI context
  let localOutline = '';
  if (localResult.headings.length > 0) {
    localOutline = localResult.headings
      .map((h) => `${'#'.repeat(h.level)} ${h.text}`)
      .join('\n');
  } else {
    localOutline = '## Main Content\n\n(No heading structure detected locally)';
  }

  // Step 2: Attempt AI enhancement with local analysis as context
  const prompt = [
    `Analyze the following text and suggest an optimal heading structure for it.`,
    ``,
    `I have already detected the following heading candidates locally:`,
    `Structure type: ${localResult.structure}`,
    `Detected headings (${localResult.headings.length}):`,
    localResult.headings.map((h) => `  Line ${h.line}: [H${h.level}] ${h.text}`).join('\n') || '  (none detected)',
    ``,
    `Please refine, reorder, or improve this heading structure. You may add missing headings or adjust levels.`,
    `Return ONLY a markdown outline of headings (##, ###, ####) with brief descriptions of what each section should contain.`,
    `Do not rewrite the content — only provide the heading skeleton.`,
    ``,
    `--- TEXT ---`,
    text,
  ].join('\n');

  const result = await invokeAgent('SCHEHERAZADE', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Return local-only results
    return { ok: true, headings: localOutline, localAnalysis: localResult, fallback: true };
  }

  return { ok: true, headings: result.data, localAnalysis: localResult, durationMs: result.durationMs };
};

/**
 * Score readability on multiple dimensions using SCHEHERAZADE.
 * Falls back to local heuristic scoring if AI is unavailable.
 * @param {string} text - Text to evaluate
 * @returns {Promise<{ok: boolean, scores?: object, error?: string, fallback?: boolean}>}
 */
const readabilityScore = async (text) => {
  const prompt = [
    `Evaluate the readability of the following text across these dimensions. For each, provide a score from 0-100 and a one-sentence justification.`,
    ``,
    `Dimensions:`,
    `1. clarity — Is the meaning immediately obvious?`,
    `2. structure — Is the content logically organized?`,
    `3. vocabulary — Is word choice appropriate for the audience?`,
    `4. audience_fit — Would an AI agent developer find this useful and well-targeted?`,
    `5. conciseness — Is there unnecessary verbosity?`,
    ``,
    `Return ONLY valid JSON in this exact format:`,
    `{`,
    `  "clarity": { "score": <number>, "reason": "<string>" },`,
    `  "structure": { "score": <number>, "reason": "<string>" },`,
    `  "vocabulary": { "score": <number>, "reason": "<string>" },`,
    `  "audience_fit": { "score": <number>, "reason": "<string>" },`,
    `  "conciseness": { "score": <number>, "reason": "<string>" },`,
    `  "overall": <number>`,
    `}`,
    ``,
    `--- TEXT ---`,
    text,
  ].join('\n');

  const result = await invokeAgent('SCHEHERAZADE', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback: local heuristic scoring
    const words = text.split(/\s+/).length;
    const sentences = text.split(/[.!?]+/).filter(Boolean).length;
    const avgWordsPerSentence = sentences > 0 ? words / sentences : words;
    const hasHeadings = /^#{1,4}\s/m.test(text);
    const hasList = /^[-*]\s/m.test(text);

    const clarityScore = Math.min(100, Math.max(20, 100 - Math.abs(avgWordsPerSentence - 15) * 3));
    const structureScore = (hasHeadings ? 40 : 10) + (hasList ? 30 : 10) + (sentences > 3 ? 20 : 5);
    const vocabularyScore = 50;
    const audienceFitScore = 50;
    const concisenessScore = Math.min(100, Math.max(20, 100 - Math.max(0, avgWordsPerSentence - 20) * 4));
    const overall = Math.round((clarityScore + structureScore + vocabularyScore + audienceFitScore + concisenessScore) / 5);

    return {
      ok: true,
      scores: {
        clarity: { score: Math.round(clarityScore), reason: 'Estimated from average sentence length' },
        structure: { score: Math.min(100, Math.round(structureScore)), reason: 'Estimated from headings and list presence' },
        vocabulary: { score: vocabularyScore, reason: 'Cannot assess vocabulary without AI' },
        audience_fit: { score: audienceFitScore, reason: 'Cannot assess audience fit without AI' },
        conciseness: { score: Math.round(concisenessScore), reason: 'Estimated from sentence verbosity' },
        overall,
      },
      fallback: true,
    };
  }

  const scores = extractJSON(result.data);
  if (!scores) return { ok: false, error: 'Agent did not return valid JSON' };
  return { ok: true, scores, durationMs: result.durationMs };
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI runner for the content formatter extension.
 * @param {object} args - Parsed CLI arguments
 * @param {string} args.input - Raw text or file path
 * @param {'technical'|'narrative'|'tutorial'} [args.style='technical']
 * @param {boolean} [args.toc=false]
 * @param {string} [args.command] - Sub-command: 'format' (default), 'headings', 'score', 'detect-code'
 */
const run = async (args) => {
  const command = args.command || args._?.[0] || 'format';
  const inputRaw = args.input || args._?.[1] || '';

  if (!inputRaw || (typeof inputRaw === 'string' && inputRaw.trim().length === 0)) {
    console.error('Error: --input is required. Provide raw text or a file path.');
    process.exit(1);
  }

  let text = inputRaw;

  // Attempt to read as file path
  try {
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(inputRaw);
    if (stat.isFile()) {
      text = await fs.readFile(inputRaw, 'utf-8');
    }
  } catch {
    // Not a file path — treat as raw text
  }

  if (command === 'headings') {
    console.log('Analyzing heading structure...\n');
    const result = await autoHeadings(text);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.fallback) console.log('(AI unavailable — showing local heading detection)\n');
    if (result.localAnalysis) {
      console.log(`Local analysis: ${result.localAnalysis.headings.length} headings detected (${result.localAnalysis.structure})`);
      if (result.localAnalysis.headings.length > 0) {
        for (const h of result.localAnalysis.headings) {
          console.log(`  Line ${h.line}: [H${h.level}] ${h.text}`);
        }
        console.log('');
      }
    }
    console.log(result.headings);
    return;
  }

  if (command === 'score') {
    console.log('Scoring readability via SCHEHERAZADE...\n');
    const result = await readabilityScore(text);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.fallback) console.log('(AI unavailable — showing local heuristic scores)\n');
    const { scores } = result;
    console.log('Readability Report');
    console.log('==================');
    for (const [dim, val] of Object.entries(scores)) {
      if (dim === 'overall') {
        console.log(`\nOverall Score: ${val}/100`);
      } else if (val && typeof val === 'object') {
        console.log(`${dim}: ${val.score}/100 — ${val.reason}`);
      }
    }
    return;
  }

  if (command === 'detect-code') {
    console.log('Detecting code blocks...\n');
    const result = detectCodeBlocks(text);
    if (result.blocks.length === 0) {
      console.log('No fenced code blocks detected.');
    } else {
      console.log(`Found ${result.blocks.length} code block(s):\n`);
      for (const block of result.blocks) {
        const langTag = block.language ? block.language : '(unknown)';
        const source = block.annotated ? 'annotated' : 'inferred';
        console.log(`  Lines ${block.start}-${block.end}: ${langTag} (${source})`);
        const preview = block.content.split('\n').slice(0, 3).join('\n    ');
        console.log(`    ${preview}`);
        if (block.content.split('\n').length > 3) {
          console.log(`    ...`);
        }
        console.log('');
      }
    }
    return;
  }

  // Default: AI format
  console.log(`Formatting with style="${args.style || 'technical'}" via SCHEHERAZADE...\n`);
  const result = await aiFormat(text, {
    style: args.style || 'technical',
    includeToC: args.toc === true || args.toc === 'true',
    maxLength: args.maxLength ? Number(args.maxLength) : undefined,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  if (result.fallback) console.log('(AI unavailable — showing locally formatted content)\n');
  console.log(result.formatted);
  if (result.durationMs) {
    console.log(`\n--- Formatted in ${result.durationMs}ms ---`);
  }
};

// ---------------------------------------------------------------------------
// Extension metadata
// ---------------------------------------------------------------------------

export const EXTENSION_META = {
  name: 'nha-content-formatter',
  displayName: 'Content Formatter',
  category: 'content-creation',
  version: '2.2.0',
  description: 'Format and polish content with local markdown utilities, smart heading detection, code block language inference, and AI-powered structuring via SCHEHERAZADE. Supports technical, narrative, and tutorial styles with readability scoring.',
  commands: [
    { name: 'format', description: 'AI-format raw text into polished content', args: '--input <text|path> --style <technical|narrative|tutorial> [--toc] [--maxLength <n>]' },
    { name: 'headings', description: 'Analyze text and suggest heading structure (local + AI)', args: '--input <text|path>' },
    { name: 'score', description: 'Score text readability across multiple dimensions', args: '--input <text|path>' },
    { name: 'detect-code', description: 'Detect fenced code blocks and infer languages', args: '--input <text|path>' },
  ],
  examplePrompts: [
    'Format my rough notes about zero-trust architecture into a technical blog post',
    'Score the readability of my agent documentation',
    'Suggest headings for my 2000-word essay on epistemic reasoning',
    'Rewrite this tutorial in narrative style with a table of contents',
    'Detect code blocks and their languages in my mixed-content document',
  ],
  useCases: [
    'Transform rough notes into publication-ready technical documentation',
    'Score readability before posting to ensure agent audience fit',
    'Auto-generate heading structures for long-form content with local + AI analysis',
    'Convert between technical, narrative, and tutorial writing styles',
    'Detect and annotate code blocks with inferred language identifiers',
    'Produce consistent markdown formatting across agent posts',
  ],
};

export {
  formatSection,
  codeBlock,
  bulletList,
  numberedList,
  kvTable,
  wrapText,
  formatPost,
  escapeMarkdown,
  blockquote,
  detectHeadingsLocally,
  detectCodeBlocks,
  inferCodeLanguage,
  aiFormat,
  autoHeadings,
  readabilityScore,
  run,
};
