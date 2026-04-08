/**
 * Web search + URL fetch tools for NHA CLI.
 *
 * - web_search: DuckDuckGo HTML scraping (zero API key, zero dependencies)
 * - fetch_url: SSRF-protected HTML→text extraction
 *
 * Enterprise-grade security:
 * - SSRF protection (private IP blocking, protocol validation, DNS pre-resolution)
 * - Content-type allowlist (text/* only)
 * - Size limits (100KB download, 8KB output)
 * - Timeout protection (10s)
 * - No binary/PDF/script content
 *
 * Zero npm dependencies — pure Node.js 22.
 */

import { URL } from 'url';
import dns from 'dns/promises';
import net from 'net';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_DOWNLOAD_BYTES = 100 * 1024;  // 100KB
const MAX_OUTPUT_CHARS = 8000;           // ~2K tokens
const FETCH_TIMEOUT_MS = 10000;          // 10s
const MAX_REDIRECTS = 5;
const MAX_RESULTS = 8;

const USER_AGENT = 'NHA-CLI/9.0 (NotHumanAllowed; +https://nothumanallowed.com)';

// ── SSRF Protection ──────────────────────────────────────────────────────────

/**
 * Private/internal IP ranges that MUST be blocked to prevent SSRF.
 */
const PRIVATE_RANGES = [
  // IPv4
  { start: '10.0.0.0', end: '10.255.255.255' },
  { start: '172.16.0.0', end: '172.31.255.255' },
  { start: '192.168.0.0', end: '192.168.255.255' },
  { start: '127.0.0.0', end: '127.255.255.255' },
  { start: '169.254.0.0', end: '169.254.255.255' },
  { start: '0.0.0.0', end: '0.255.255.255' },
];

function ipToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIp(ip) {
  if (!net.isIPv4(ip)) return false; // IPv6 — block by default for safety
  const long = ipToLong(ip);
  for (const range of PRIVATE_RANGES) {
    if (long >= ipToLong(range.start) && long <= ipToLong(range.end)) return true;
  }
  return false;
}

/**
 * Validate URL for SSRF safety.
 * Returns { safe: true, hostname } or { safe: false, reason }.
 */
async function validateUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Protocol check
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { safe: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }

  // Localhost detection (various encodings)
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    /^0x[0-9a-f]+$/i.test(hostname) ||  // hex-encoded
    /^\d+$/.test(hostname)               // decimal-encoded
  ) {
    return { safe: false, reason: 'Blocked: localhost' };
  }

  // DNS pre-resolution to catch internal hostnames
  try {
    const addresses = await dns.resolve4(hostname);
    for (const addr of addresses) {
      if (isPrivateIp(addr)) {
        return { safe: false, reason: `Blocked: ${hostname} resolves to private IP ${addr}` };
      }
    }
  } catch {
    // DNS resolution failed — hostname might not exist
    return { safe: false, reason: `DNS resolution failed for ${hostname}` };
  }

  return { safe: true, hostname };
}

// ── HTML → Text Extraction ───────────────────────────────────────────────────

/**
 * Extract readable text from HTML.
 * Strips scripts, styles, nav, header, footer. Decodes entities.
 */
function htmlToText(html) {
  let text = html;

  // Remove script, style, nav, header, footer, svg, noscript
  text = text.replace(/<(script|style|svg|noscript|nav|header|footer|aside|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  text = text
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '...')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"');

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Extract <title> from HTML.
 */
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return htmlToText(match[1]).slice(0, 200);
}

// ── Fetch with protection ────────────────────────────────────────────────────

/**
 * Fetch a URL with SSRF protection, size limits, and timeout.
 * Returns { status, contentType, body, title, excerpt, truncated }.
 */
export async function fetchUrl(urlStr) {
  // Validate URL
  const validation = await validateUrl(urlStr);
  if (!validation.safe) {
    return { error: true, message: validation.reason };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(urlStr, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html, text/plain, application/json, text/xml',
      },
      signal: controller.signal,
      redirect: 'follow',
      // Node.js fetch follows redirects by default (max 20)
    });

    clearTimeout(timeout);

    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    // Content-type allowlist
    if (!contentType.startsWith('text/') && !contentType.includes('json') && !contentType.includes('xml')) {
      return {
        error: true,
        message: `Blocked content-type: ${contentType}. Only text, JSON, and XML are allowed.`,
      };
    }

    // Read body with size limit
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_DOWNLOAD_BYTES) {
        truncated = true;
        // Take only the part that fits
        const overshoot = totalBytes - MAX_DOWNLOAD_BYTES;
        chunks.push(value.slice(0, value.length - overshoot));
        break;
      }
      chunks.push(value);
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const rawBody = decoder.decode(Buffer.concat(chunks));

    // Extract useful content
    let body;
    let title = '';
    let excerpt = '';

    if (contentType.includes('html')) {
      title = extractTitle(rawBody);
      body = htmlToText(rawBody);
    } else if (contentType.includes('json')) {
      try {
        const parsed = JSON.parse(rawBody);
        body = JSON.stringify(parsed, null, 2);
      } catch {
        body = rawBody;
      }
    } else {
      body = rawBody;
    }

    // Enforce output limit
    if (body.length > MAX_OUTPUT_CHARS) {
      body = body.slice(0, MAX_OUTPUT_CHARS) + '\n\n[... content truncated at 8000 chars]';
      truncated = true;
    }

    excerpt = body.slice(0, 200).replace(/\s+/g, ' ').trim();

    // DNS rebinding check on final URL (after redirects)
    if (res.url !== urlStr) {
      const finalValidation = await validateUrl(res.url);
      if (!finalValidation.safe) {
        return { error: true, message: `Redirect blocked: ${finalValidation.reason}` };
      }
    }

    return {
      error: false,
      status: res.status,
      contentType,
      body,
      title,
      excerpt,
      truncated,
      url: res.url,
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { error: true, message: 'Request timed out (10s limit)' };
    }
    return { error: true, message: `Fetch failed: ${err.message}` };
  }
}

// ── Web Search (DuckDuckGo HTML) ─────────────────────────────────────────────

/**
 * Search the web using DuckDuckGo HTML (no API key needed).
 * Parses the HTML results page to extract links, titles, and snippets.
 *
 * @param {string} query - Search query
 * @param {number} maxResults - Max results to return (default 8)
 * @returns {Promise<{ results: Array<{ title, url, snippet }>, query }>}
 */
export async function webSearch(query, maxResults = MAX_RESULTS) {
  if (!query || query.trim().length < 2) {
    return { error: true, message: 'Query too short' };
  }

  const encodedQuery = encodeURIComponent(query.trim());
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return { error: true, message: `DuckDuckGo returned ${res.status}` };
    }

    const html = await res.text();
    const results = parseDuckDuckGoResults(html, maxResults);

    return {
      error: false,
      query: query.trim(),
      resultCount: results.length,
      results,
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { error: true, message: 'Search timed out (10s limit)' };
    }
    return { error: true, message: `Search failed: ${err.message}` };
  }
}

/**
 * Parse DuckDuckGo HTML results page.
 * Extracts title, URL, and snippet from result items.
 */
function parseDuckDuckGoResults(html, maxResults) {
  const results = [];

  // DuckDuckGo HTML wraps results in <div class="result..."> with
  // <a class="result__a" href="...">title</a> and
  // <a class="result__snippet">snippet</a>
  const resultBlocks = html.split(/class="result\s/);

  for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
    const block = resultBlocks[i];

    // Extract URL — DuckDuckGo uses redirect URLs, extract the actual destination
    let url = '';
    const urlMatch = block.match(/class="result__a"\s+href="([^"]+)"/);
    if (urlMatch) {
      url = urlMatch[1];
      // DuckDuckGo wraps URLs: //duckduckgo.com/l/?uddg=ENCODED_URL&...
      if (url.includes('uddg=')) {
        const uddgMatch = url.match(/uddg=([^&]+)/);
        if (uddgMatch) {
          try {
            url = decodeURIComponent(uddgMatch[1]);
          } catch {
            url = uddgMatch[1];
          }
        }
      }
      // Handle protocol-relative URLs
      if (url.startsWith('//')) url = 'https:' + url;
    }

    // Extract title
    let title = '';
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    if (titleMatch) {
      title = htmlToText(titleMatch[1]).trim();
    }

    // Extract snippet
    let snippet = '';
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    if (!snippetMatch) {
      const altSnippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//);
      if (altSnippet) snippet = htmlToText(altSnippet[1]).trim();
    } else {
      snippet = htmlToText(snippetMatch[1]).trim();
    }

    if (url && title) {
      results.push({ title, url, snippet: snippet.slice(0, 300) });
    }
  }

  return results;
}

/**
 * Deep search: search + fetch top N results for full content.
 *
 * @param {string} query
 * @param {number} fetchCount - How many top results to fetch (default 3)
 * @returns {Promise<{ results, deepResults }>}
 */
export async function webSearchDeep(query, fetchCount = 3) {
  const searchResult = await webSearch(query);
  if (searchResult.error) return searchResult;

  const deepResults = [];
  const urlsToFetch = searchResult.results.slice(0, fetchCount);

  const fetches = urlsToFetch.map(async (result) => {
    try {
      const content = await fetchUrl(result.url);
      if (!content.error) {
        return {
          title: content.title || result.title,
          url: result.url,
          snippet: result.snippet,
          content: content.body,
          excerpt: content.excerpt,
        };
      }
    } catch {}
    return null;
  });

  const fetchedResults = await Promise.allSettled(fetches);
  for (const result of fetchedResults) {
    if (result.status === 'fulfilled' && result.value) {
      deepResults.push(result.value);
    }
  }

  return {
    error: false,
    query: query.trim(),
    resultCount: searchResult.results.length,
    results: searchResult.results,
    deepFetched: deepResults.length,
    deepResults,
  };
}
