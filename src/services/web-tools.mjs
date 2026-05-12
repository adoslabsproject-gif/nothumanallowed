/**
 * Web search + URL fetch tools for NHA CLI — enterprise-grade.
 *
 * Public exports:
 *   - fetchUrl(urlStr, opts?)          → main fetch (back-compat)
 *   - fetchUrlRich(urlStr, opts?)      → fetch + structured metadata extraction
 *   - headProbe(urlStr, opts?)         → fast HEAD reachability check (smoke test)
 *   - extractMetadata(html, baseUrl?)  → parse OG/Twitter/JSON-LD/meta tags
 *   - webSearch(query, max?)           → DuckDuckGo HTML scraping
 *   - webSearchDeep(query, fetchN?)    → search + fetch top N
 *
 * Hardening:
 *   - SSRF protection: IPv4 + IPv6 private ranges, localhost variants, DNS pre-resolution
 *   - Content-type allowlist (text/html, text/plain, application/json, application/xml, text/xml)
 *   - Size limits (2 MB download, 32 KB output by default — overridable)
 *   - Per-request timeout, total deadline budget, retry with exponential backoff + jitter
 *   - Realistic browser headers (Chrome 124 desktop) — bypasses naive bot-blockers
 *   - Decompression (gzip / deflate / brotli) handled by global fetch
 *   - DNS rebinding guard: re-validates final URL after redirects
 *
 * Zero npm dependencies — pure Node.js 22.
 */

import { URL } from 'url';
import dns from 'dns/promises';
import net from 'net';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_DOWNLOAD_BYTES   = 2 * 1024 * 1024;  // 2 MB raw HTML (was 100 KB — way too small)
const MAX_OUTPUT_CHARS     = 32_000;            // ~8K tokens (was 8 K — too short for real analysis)
const FETCH_TIMEOUT_MS     = 15_000;            // per-attempt
const TOTAL_DEADLINE_MS    = 45_000;            // across retries
const MAX_REDIRECTS        = 10;
const MAX_SEARCH_RESULTS   = 8;
const MAX_RETRIES          = 3;
const RETRY_BACKOFF_MS     = [800, 2_000, 4_500]; // exponential-ish with jitter

// Browser-realistic UA — Chrome 124 stable on Linux desktop.
// Many sites (Cloudflare/Akamai/Wordfence/ModSecurity) reject custom UAs outright.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BASE_HEADERS = Object.freeze({
  'User-Agent': BROWSER_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Linux"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'DNT': '1',
  'Connection': 'keep-alive',
});

// ── SSRF Protection ──────────────────────────────────────────────────────────

const PRIVATE_IPV4_RANGES = [
  { start: '10.0.0.0',      end: '10.255.255.255'      },
  { start: '172.16.0.0',    end: '172.31.255.255'      },
  { start: '192.168.0.0',   end: '192.168.255.255'     },
  { start: '127.0.0.0',     end: '127.255.255.255'     },
  { start: '169.254.0.0',   end: '169.254.255.255'     }, // link-local
  { start: '0.0.0.0',       end: '0.255.255.255'       },
  { start: '100.64.0.0',    end: '100.127.255.255'     }, // CGNAT
  { start: '198.18.0.0',    end: '198.19.255.255'      }, // benchmarking
  { start: '224.0.0.0',     end: '239.255.255.255'     }, // multicast
  { start: '240.0.0.0',     end: '255.255.255.255'     }, // reserved
];

function ipToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const long = ipToLong(ip);
  for (const r of PRIVATE_IPV4_RANGES) {
    if (long >= ipToLong(r.start) && long <= ipToLong(r.end)) return true;
  }
  return false;
}

/**
 * IPv6 SSRF protection — covers the practical attack surface:
 *   ::1                 (loopback)
 *   fc00::/7            (unique local addresses)
 *   fe80::/10           (link-local)
 *   ::ffff:0:0/96       (IPv4-mapped — must re-check the embedded IPv4)
 *   ::                  (unspecified)
 */
function isPrivateIPv6(ip) {
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(lower)) return true;
  // IPv4-mapped: ::ffff:192.168.0.1 — extract the v4 portion
  const v4MappedMatch = lower.match(/^::ffff:([0-9.]+)$/);
  if (v4MappedMatch && net.isIPv4(v4MappedMatch[1])) {
    return isPrivateIPv4(v4MappedMatch[1]);
  }
  return false;
}

function isPrivateIp(ip) {
  return isPrivateIPv4(ip) || isPrivateIPv6(ip);
}

/**
 * Validate URL for SSRF safety.
 * - Resolves both A and AAAA records.
 * - Allows hosts even if DNS partially fails, as long as at least one public IP exists.
 */
async function validateUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { safe: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    /^0x[0-9a-f]+$/i.test(hostname) ||
    /^\d+$/.test(hostname) // decimal-encoded
  ) {
    return { safe: false, reason: 'Blocked: localhost / numeric host' };
  }

  // Literal IP in hostname — validate directly without DNS
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      return { safe: false, reason: `Blocked: private IP literal ${hostname}` };
    }
    return { safe: true, hostname, addresses: [hostname] };
  }

  // DNS resolution: use `dns.lookup` with all:true to get both A + AAAA in one call.
  // `dns.lookup` uses the system resolver (incl. /etc/hosts and DNSSEC), more lenient
  // than `dns.resolve4` which was the original failure mode.
  let addresses = [];
  try {
    const all = await dns.lookup(hostname, { all: true, family: 0 });
    addresses = all.map(a => a.address);
  } catch (err) {
    // Fall back to explicit resolve4 + resolve6 — covers split-horizon DNS
    try {
      const [v4, v6] = await Promise.allSettled([
        dns.resolve4(hostname),
        dns.resolve6(hostname),
      ]);
      if (v4.status === 'fulfilled') addresses.push(...v4.value);
      if (v6.status === 'fulfilled') addresses.push(...v6.value);
    } catch { /* both failed */ }
  }

  if (addresses.length === 0) {
    return { safe: false, reason: `DNS resolution failed for ${hostname}` };
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      return { safe: false, reason: `Blocked: ${hostname} resolves to private IP ${addr}` };
    }
  }

  return { safe: true, hostname, addresses };
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
  '&rsquo;': "'", '&lsquo;': "'", '&rdquo;': '"', '&ldquo;': '"',
  '&laquo;': '«', '&raquo;': '»', '&euro;': '€', '&pound;': '£', '&yen;': '¥',
  '&copy;': '©', '&reg;': '®', '&trade;': '™',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    })
    .replace(/&[a-zA-Z]+;/g, (m) => HTML_ENTITIES[m] ?? m);
}

/**
 * Extract readable text from HTML. Removes scripts/styles/nav/headers/footers
 * while preserving block boundaries (so paragraphs don't run together).
 */
function htmlToText(html) {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|svg|noscript|iframe|object|embed|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Mark block-level boundaries before stripping tags so paragraphs separate.
  text = text.replace(/<(\/?)(p|div|section|article|h[1-6]|li|tr|br|hr|blockquote|pre|figure|figcaption)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/[ \t ]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return text.trim();
}

function pickAttr(tag, attr) {
  const re = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return '';
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1] : '';
}

/**
 * Extract structured metadata: title, description, OpenGraph, Twitter cards,
 * canonical, lang, robots, h1..h3 headings, JSON-LD blocks (parsed).
 */
export function extractMetadata(html, baseUrl = '') {
  const meta = {
    title: '',
    description: '',
    canonical: '',
    lang: '',
    robots: '',
    og: {},
    twitter: {},
    jsonLd: [],
    headings: { h1: [], h2: [], h3: [] },
  };

  const htmlTag = html.match(/<html[^>]*>/i)?.[0] ?? '';
  meta.lang = pickAttr(htmlTag, 'lang');

  meta.title = decodeEntities(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)).trim().slice(0, 300);

  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const name = pickAttr(tag, 'name').toLowerCase();
    const prop = pickAttr(tag, 'property').toLowerCase();
    const content = pickAttr(tag, 'content');
    if (!content) continue;
    if (name === 'description') meta.description = content.trim().slice(0, 500);
    else if (name === 'robots')      meta.robots = content;
    else if (prop.startsWith('og:'))  meta.og[prop.slice(3)] = content;
    else if (name.startsWith('twitter:')) meta.twitter[name.slice(8)] = content;
    else if (name === 'twitter:title' || name === 'twitter:description') {
      meta.twitter[name.slice(8)] = content;
    }
  }

  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const rel = pickAttr(tag, 'rel').toLowerCase();
    if (rel === 'canonical') {
      try { meta.canonical = baseUrl ? new URL(pickAttr(tag, 'href'), baseUrl).href : pickAttr(tag, 'href'); }
      catch { meta.canonical = pickAttr(tag, 'href'); }
    }
  }

  // JSON-LD blocks (schema.org Product, Organization, BreadcrumbList, etc.)
  const ldBlocks = html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of ldBlocks) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    if (!inner) continue;
    try {
      const parsed = JSON.parse(inner);
      const flat = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of flat) {
        if (!obj || typeof obj !== 'object') continue;
        const type = obj['@type'] || obj.type || 'Unknown';
        meta.jsonLd.push({
          type: Array.isArray(type) ? type.join(',') : String(type),
          name: obj.name || obj.headline || '',
          description: obj.description || '',
          url: obj.url || '',
          raw: obj,
        });
      }
    } catch { /* invalid JSON-LD, ignore */ }
  }

  // Headings — useful for understanding page structure
  const hMatcher = (level) => new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
  for (const lvl of [1, 2, 3]) {
    let m;
    const re = hMatcher(lvl);
    while ((m = re.exec(html)) && meta.headings[`h${lvl}`].length < 20) {
      const txt = decodeEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
      if (txt && txt.length < 300) meta.headings[`h${lvl}`].push(txt);
    }
  }

  return meta;
}

/**
 * Extract main content using density heuristics:
 *   1. Prefer <main>, <article>, [role=main], #content, .content, .main
 *   2. Fallback: strip nav/header/footer/aside/menu and collapse to text
 */
function extractMainContent(html) {
  const candidates = [
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<[^>]+role\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<div[^>]+(id|class)\s*=\s*["'][^"']*(content|main-content|main)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m && m[0] && m[0].length > 500) {
      return htmlToText(m[0]);
    }
  }
  // Fallback — strip chrome elements then convert
  const stripped = html.replace(/<(nav|header|footer|aside|form|menu)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return htmlToText(stripped);
}

// ── Retry helper ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * Math.floor(ms * 0.3));
}

function shouldRetry(status, err) {
  if (err) {
    const m = (err.message || '').toLowerCase();
    if (m.includes('aborted')) return false;          // explicit timeout — don't hammer
    if (m.includes('etimedout')) return true;
    if (m.includes('econnreset')) return true;
    if (m.includes('econnrefused')) return false;
    if (m.includes('enotfound')) return false;        // DNS — won't fix on retry
    if (m.includes('socket hang up')) return true;
    return true;
  }
  if (!status) return true;
  if (status === 429) return true;                     // rate limited
  if (status >= 500 && status <= 599) return true;     // transient server error
  if (status === 408) return true;                     // request timeout
  return false;
}

// ── Core fetch ───────────────────────────────────────────────────────────────

/**
 * Fetch a URL with SSRF protection, size limits, retry+backoff, and full metadata.
 *
 * @param {string} urlStr
 * @param {object} [opts]
 * @param {number} [opts.timeout]       per-attempt timeout (ms)
 * @param {number} [opts.maxBytes]      max raw body bytes
 * @param {number} [opts.maxChars]      max output chars
 * @param {number} [opts.retries]       max retries (default 3)
 * @param {object} [opts.extraHeaders]  additional headers to merge
 * @param {boolean} [opts.rich]         include extracted metadata + main content
 * @returns {Promise<object>}
 */
export async function fetchUrl(urlStr, opts = {}) {
  const timeout    = opts.timeout    ?? FETCH_TIMEOUT_MS;
  const maxBytes   = opts.maxBytes   ?? MAX_DOWNLOAD_BYTES;
  const maxChars   = opts.maxChars   ?? MAX_OUTPUT_CHARS;
  const retries    = Math.max(0, Math.min(opts.retries ?? MAX_RETRIES, 5));
  const startTime  = Date.now();

  // Validate URL once up-front
  const validation = await validateUrl(urlStr);
  if (!validation.safe) {
    return { error: true, code: 'SSRF_BLOCKED', message: validation.reason };
  }

  const headers = { ...BASE_HEADERS, ...(opts.extraHeaders || {}) };
  // Set Referer to the origin to look like a normal navigation
  try {
    const u = new URL(urlStr);
    headers['Referer'] = `${u.protocol}//${u.host}/`;
  } catch { /* skip */ }

  let lastErr = null;
  let lastStatus = 0;
  let attempt = 0;

  while (attempt <= retries) {
    if (Date.now() - startTime > TOTAL_DEADLINE_MS) {
      return { error: true, code: 'DEADLINE_EXCEEDED', message: `Total deadline ${TOTAL_DEADLINE_MS}ms exceeded` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(urlStr, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);

      lastStatus = res.status;

      // Retry on transient server errors
      if (res.status >= 500 || res.status === 429 || res.status === 408) {
        if (attempt < retries && shouldRetry(res.status, null)) {
          attempt++;
          await sleep(jitter(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]));
          continue;
        }
        return {
          error: true,
          code: `HTTP_${res.status}`,
          message: `Upstream returned ${res.status}`,
          status: res.status,
          url: res.url,
        };
      }

      // 4xx (non-408/429) — surface to caller, no retry
      if (res.status >= 400) {
        return {
          error: true,
          code: `HTTP_${res.status}`,
          message: `Upstream returned ${res.status}`,
          status: res.status,
          url: res.url,
        };
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('html');
      const isJson = contentType.includes('json');
      const isXml  = contentType.includes('xml');
      const isText = contentType.startsWith('text/') || isHtml || isJson || isXml;

      if (!isText) {
        return {
          error: true,
          code: 'CONTENT_TYPE_BLOCKED',
          message: `Content-type "${contentType}" not allowed (text/json/xml only)`,
          status: res.status,
          url: res.url,
        };
      }

      // DNS rebinding guard — re-validate after redirects
      if (res.url && res.url !== urlStr) {
        const reValidate = await validateUrl(res.url);
        if (!reValidate.safe) {
          return { error: true, code: 'REDIRECT_BLOCKED', message: `Redirect blocked: ${reValidate.reason}` };
        }
      }

      // Read body with size cap (uses streaming reader)
      const reader = res.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      let truncated = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (totalBytes + value.length > maxBytes) {
          const fit = maxBytes - totalBytes;
          if (fit > 0) chunks.push(value.subarray(0, fit));
          truncated = true;
          try { reader.cancel(); } catch { /* ignore */ }
          break;
        }
        chunks.push(value);
        totalBytes += value.length;
      }

      const decoder = new TextDecoder('utf-8', { fatal: false });
      const rawBody = decoder.decode(Buffer.concat(chunks.map(c => Buffer.from(c))));

      // Build response
      let body = '';
      let title = '';
      let metadata = null;
      let mainContent = '';

      if (isHtml) {
        metadata = extractMetadata(rawBody, res.url || urlStr);
        title = metadata.title;
        mainContent = extractMainContent(rawBody);
        body = mainContent;
      } else if (isJson) {
        try {
          body = JSON.stringify(JSON.parse(rawBody), null, 2);
        } catch {
          body = rawBody;
        }
      } else {
        body = isXml || contentType.startsWith('text/')
          ? rawBody.replace(/\s+/g, ' ').trim()
          : rawBody;
      }

      if (body.length > maxChars) {
        body = body.slice(0, maxChars) + `\n\n[... content truncated at ${maxChars} chars]`;
        truncated = true;
      }

      const excerpt = body.slice(0, 240).replace(/\s+/g, ' ').trim();

      const result = {
        error: false,
        status: res.status,
        contentType,
        url: res.url || urlStr,
        title,
        excerpt,
        body,
        truncated,
        bytes: totalBytes,
        attempts: attempt + 1,
      };

      if (opts.rich || metadata) {
        result.metadata = metadata;
        result.mainContent = mainContent;
      }

      return result;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isAbort = err.name === 'AbortError';
      if (isAbort) {
        // Per-attempt timeout — counts as transient, retry once more
        if (attempt < retries) {
          attempt++;
          await sleep(jitter(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]));
          continue;
        }
        return {
          error: true,
          code: 'TIMEOUT',
          message: `Request timed out after ${timeout}ms (${attempt + 1} attempt${attempt > 0 ? 's' : ''})`,
        };
      }
      if (attempt < retries && shouldRetry(0, err)) {
        attempt++;
        await sleep(jitter(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]));
        continue;
      }
      return {
        error: true,
        code: 'NETWORK_ERROR',
        message: `Fetch failed: ${err.message || String(err)}`,
        cause: err.code || err.errno || null,
      };
    }
  }

  return {
    error: true,
    code: lastStatus ? `HTTP_${lastStatus}` : 'UNKNOWN',
    message: lastErr?.message || `Failed after ${attempt} attempts`,
  };
}

/** Convenience wrapper — always returns metadata. */
export async function fetchUrlRich(urlStr, opts = {}) {
  return fetchUrl(urlStr, { ...opts, rich: true });
}

/**
 * HEAD probe — fast reachability check used by the Studio smoke-test gate.
 * Returns { ok, status, reason, finalUrl } in under ~5 s typically.
 * Falls back to a tiny GET (Range: bytes=0-0) if HEAD is rejected (some servers
 * return 405 on HEAD).
 */
export async function headProbe(urlStr, opts = {}) {
  const timeout = opts.timeout ?? 8_000;

  const validation = await validateUrl(urlStr);
  if (!validation.safe) {
    return { ok: false, status: 0, reason: validation.reason, finalUrl: urlStr };
  }

  const headers = { ...BASE_HEADERS };
  try {
    const u = new URL(urlStr);
    headers['Referer'] = `${u.protocol}//${u.host}/`;
  } catch { /* skip */ }

  const attempt = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(urlStr, {
        method,
        headers: method === 'GET' ? { ...headers, Range: 'bytes=0-0' } : headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { status: res.status, finalUrl: res.url || urlStr };
    } catch (err) {
      clearTimeout(timer);
      return { error: err };
    }
  };

  // Try HEAD first
  let r = await attempt('HEAD');
  if (r.error || (r.status && (r.status === 405 || r.status === 501))) {
    // Some sites reject HEAD — fall back to bytes=0-0 GET
    r = await attempt('GET');
  }

  if (r.error) {
    const isAbort = r.error.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      reason: isAbort ? `Timeout after ${timeout}ms` : `Network: ${r.error.message || r.error.code || 'unknown'}`,
      finalUrl: urlStr,
    };
  }

  const ok = r.status >= 200 && r.status < 400;
  return {
    ok,
    status: r.status,
    reason: ok ? '' : `HTTP ${r.status}`,
    finalUrl: r.finalUrl,
  };
}

// ── Web Search (DuckDuckGo HTML) ─────────────────────────────────────────────

const SEARCH_HEADERS = {
  ...BASE_HEADERS,
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'navigate',
};

export async function webSearch(query, maxResults = MAX_SEARCH_RESULTS) {
  if (!query || query.trim().length < 2) {
    return { error: true, code: 'BAD_QUERY', message: 'Query too short' };
  }
  const encoded = encodeURIComponent(query.trim());
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encoded}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(searchUrl, { headers: SEARCH_HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { error: true, code: `HTTP_${res.status}`, message: `DuckDuckGo returned ${res.status}` };
    }
    const html = await res.text();
    const results = parseDuckDuckGoResults(html, maxResults);
    return { error: false, query: query.trim(), resultCount: results.length, results };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { error: true, code: 'TIMEOUT', message: 'Search timed out' };
    }
    return { error: true, code: 'NETWORK_ERROR', message: `Search failed: ${err.message}` };
  }
}

function parseDuckDuckGoResults(html, maxResults) {
  const results = [];
  const primarySplit = 'result__body">';
  const fallbackSplit = 'class="result results_links';
  const splitOn = html.includes(primarySplit) ? primarySplit : fallbackSplit;
  const blocks = html.split(splitOn);

  for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
    const block = blocks[i];
    let url = '';
    const uddgMatch = block.match(/uddg=([^&"]+)/);
    if (uddgMatch) {
      try { url = decodeURIComponent(uddgMatch[1]); } catch { url = uddgMatch[1]; }
    }
    if (!url) continue;

    let title = '';
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    if (titleMatch) title = htmlToText(titleMatch[1]).trim();
    if (!title) continue;

    let snippet = '';
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    if (snippetMatch) snippet = htmlToText(snippetMatch[1]).trim();
    else {
      const alt = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//);
      if (alt) snippet = htmlToText(alt[1]).trim();
    }
    results.push({ title, url, snippet: snippet.slice(0, 320) });
  }

  return results;
}

/**
 * Deep search — search + fetch top N results for full content.
 * Returns deepResults with main content + metadata for each.
 */
export async function webSearchDeep(query, fetchCount = 3) {
  const search = await webSearch(query);
  if (search.error) return search;

  const toFetch = search.results.slice(0, fetchCount);
  const settled = await Promise.allSettled(
    toFetch.map(r => fetchUrl(r.url, { rich: true, maxChars: 4_000 }))
  );

  const deepResults = [];
  settled.forEach((s, i) => {
    const r = toFetch[i];
    if (s.status === 'fulfilled' && !s.value.error) {
      deepResults.push({
        title: s.value.title || r.title,
        url: r.url,
        snippet: r.snippet,
        content: (s.value.body || '').slice(0, 2_000),
        description: s.value.metadata?.description || '',
        og: s.value.metadata?.og || {},
      });
    }
  });

  return {
    error: false,
    query: query.trim(),
    resultCount: search.results.length,
    results: search.results,
    deepFetched: deepResults.length,
    deepResults,
  };
}
