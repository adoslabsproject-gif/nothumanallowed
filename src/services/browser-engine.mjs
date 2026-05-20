/**
 * NHA Browser Engine — Chrome DevTools Protocol (CDP) client.
 *
 * Controls Chrome/Chromium headless via the CDP WebSocket protocol.
 * Zero npm dependencies — pure Node.js 22.
 *
 * Capabilities:
 * - Launch Chrome headless (auto-detect path per OS)
 * - Navigate to URLs (with SSRF protection)
 * - Screenshot (full page or viewport, returns base64 PNG)
 * - Click elements by CSS selector or coordinates
 * - Type text into focused elements or selectors
 * - Fill forms (set input values via JS)
 * - Extract page text or HTML
 * - Execute arbitrary JavaScript in page context
 * - Wait for elements or navigation
 * - Cookie & localStorage management
 *
 * Architecture:
 * - Single persistent browser instance (lazy-launched)
 * - WebSocket connection to CDP (ws:// on localhost)
 * - JSON-RPC over WebSocket per CDP spec
 * - Graceful cleanup on process exit
 */

import { spawn } from 'child_process';
import { createConnection } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dns from 'dns/promises';
import net from 'net';
import crypto from 'crypto';

// ── Constants ────────────────────────────────────────────────────────────────

const CDP_PORT = 9222;
const LAUNCH_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 30000;
const SCREENSHOT_TIMEOUT_MS = 15000;
const MAX_OUTPUT_CHARS = 12000;

// ── SSRF Protection (reused from web-tools.mjs pattern) ─────────────────────

const PRIVATE_RANGES = [
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
  if (!net.isIPv4(ip)) return false;
  const long = ipToLong(ip);
  for (const range of PRIVATE_RANGES) {
    if (long >= ipToLong(range.start) && long <= ipToLong(range.end)) return true;
  }
  return false;
}

async function isSafeUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { safe: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    /^0x[0-9a-f]+$/i.test(hostname) ||
    /^\d+$/.test(hostname)
  ) {
    return { safe: false, reason: 'Blocked: localhost/internal' };
  }

  try {
    const addresses = await dns.resolve4(hostname);
    for (const addr of addresses) {
      if (isPrivateIp(addr)) {
        return { safe: false, reason: `Blocked: ${hostname} resolves to private IP ${addr}` };
      }
    }
  } catch {
    return { safe: false, reason: `DNS resolution failed for ${hostname}` };
  }

  return { safe: true };
}

// ── Chrome Path Detection ───────────────────────────────────────────────────

function findChromePath() {
  const platform = os.platform();

  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/brave-browser',
      '/usr/bin/microsoft-edge',
      // Termux on Android — chromium installed via "pkg install chromium"
      '/data/data/com.termux/files/usr/bin/chromium',
      '/data/data/com.termux/files/usr/bin/chromium-browser',
      '/data/data/com.termux/files/usr/bin/google-chrome',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${os.homedir()}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  };

  const paths = candidates[platform] || candidates.linux;
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* skip */ }
  }

  return null;
}

// ── CDP WebSocket Client ────────────────────────────────────────────────────

/**
 * Minimal WebSocket client for CDP.
 * Implements just enough of RFC 6455 to communicate with Chrome.
 * Handles text frames only (CDP is JSON text).
 */
class CDPWebSocket {
  constructor() {
    this._socket = null;
    this._callbacks = new Map();
    this._events = new Map();
    this._buffer = Buffer.alloc(0);
    this._connected = false;
    this._nextId = 1;
  }

  /**
   * Connect to CDP WebSocket endpoint.
   * @param {string} wsUrl - e.g. ws://127.0.0.1:9222/devtools/page/ABC123
   * @returns {Promise<void>}
   */
  connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(wsUrl);
      const host = parsed.hostname;
      const port = parseInt(parsed.port, 10);
      const pathname = parsed.pathname + (parsed.search || '');

      this._socket = createConnection({ host, port }, () => {
        // Send WebSocket upgrade request
        const key = crypto.randomBytes(16).toString('base64');
        const request = [
          `GET ${pathname} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n');

        this._socket.write(request);
      });

      let handshakeDone = false;

      this._socket.on('data', (data) => {
        if (!handshakeDone) {
          // Check for HTTP 101 Switching Protocols
          const str = data.toString();
          if (str.includes('101')) {
            handshakeDone = true;
            this._connected = true;
            // Find end of HTTP headers
            const headerEnd = data.indexOf('\r\n\r\n');
            if (headerEnd !== -1 && headerEnd + 4 < data.length) {
              // Process remaining data as WebSocket frames
              this._processData(data.subarray(headerEnd + 4));
            }
            resolve();
          } else {
            reject(new Error(`WebSocket handshake failed: ${str.slice(0, 200)}`));
          }
          return;
        }

        this._processData(data);
      });

      this._socket.on('error', (err) => {
        if (!handshakeDone) reject(err);
      });

      this._socket.on('close', () => {
        this._connected = false;
      });

      setTimeout(() => {
        if (!handshakeDone) reject(new Error('WebSocket connection timeout'));
      }, 10000);
    });
  }

  /**
   * Process incoming WebSocket data — accumulate and parse frames.
   */
  _processData(data) {
    this._buffer = Buffer.concat([this._buffer, data]);
    this._parseFrames();
  }

  /**
   * Parse WebSocket frames from buffer.
   * CDP only sends text frames (opcode 0x1) with no masking (server→client).
   */
  _parseFrames() {
    while (this._buffer.length >= 2) {
      const firstByte = this._buffer[0];
      const secondByte = this._buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return; // Need more data
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        // Read as BigInt and convert (CDP payloads shouldn't exceed 2^53)
        payloadLen = Number(this._buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (masked) offset += 4; // Skip mask key (shouldn't happen for server→client)

      const totalLen = offset + payloadLen;
      if (this._buffer.length < totalLen) return; // Need more data

      const payload = this._buffer.subarray(offset, totalLen);
      this._buffer = this._buffer.subarray(totalLen);

      // Handle text frame (opcode 1) — CDP JSON messages
      if (opcode === 0x01) {
        const text = payload.toString('utf-8');
        try {
          const msg = JSON.parse(text);
          this._handleMessage(msg);
        } catch { /* ignore malformed JSON */ }
      }
      // opcode 0x08 = close
      else if (opcode === 0x08) {
        this.close();
      }
      // opcode 0x09 = ping → send pong
      else if (opcode === 0x09) {
        this._sendFrame(0x0a, payload);
      }
    }
  }

  /**
   * Handle a parsed CDP message — route to callbacks or event listeners.
   */
  _handleMessage(msg) {
    // Response to a command
    if (msg.id !== undefined && this._callbacks.has(msg.id)) {
      const { resolve, reject } = this._callbacks.get(msg.id);
      this._callbacks.delete(msg.id);
      if (msg.error) {
        reject(new Error(`CDP error: ${msg.error.message} (code ${msg.error.code})`));
      } else {
        resolve(msg.result || {});
      }
    }
    // Event
    else if (msg.method) {
      const listeners = this._events.get(msg.method) || [];
      for (const fn of listeners) {
        try { fn(msg.params); } catch { /* ignore listener errors */ }
      }
    }
  }

  /**
   * Send a WebSocket text frame (client→server, masked per RFC 6455).
   */
  _sendFrame(opcode, payload) {
    if (!this._connected || !this._socket) return;

    const payloadBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
    const len = payloadBuf.length;

    // Client frames MUST be masked
    const mask = crypto.randomBytes(4);
    let header;

    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = 0x80 | len;    // MASK + length
      mask.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }

    // Apply mask to payload
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payloadBuf[i] ^ mask[i % 4];
    }

    this._socket.write(Buffer.concat([header, masked]));
  }

  /**
   * Send a CDP command and wait for response.
   * @param {string} method - CDP method (e.g. "Page.navigate")
   * @param {object} params - CDP params
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<object>}
   */
  send(method, params = {}, timeout = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._callbacks.delete(id);
        reject(new Error(`CDP command timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this._callbacks.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      this._sendFrame(0x01, JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Register an event listener.
   */
  on(event, fn) {
    if (!this._events.has(event)) this._events.set(event, []);
    this._events.get(event).push(fn);
  }

  /**
   * Remove all listeners for an event.
   */
  off(event) {
    this._events.delete(event);
  }

  /**
   * Wait for a specific event, with timeout.
   */
  waitForEvent(event, timeout = NAV_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event);
        reject(new Error(`Timeout waiting for ${event}`));
      }, timeout);

      this.on(event, (params) => {
        clearTimeout(timer);
        this.off(event);
        resolve(params);
      });
    });
  }

  /**
   * Close the WebSocket connection.
   */
  close() {
    this._connected = false;
    if (this._socket) {
      try {
        this._sendFrame(0x08, Buffer.alloc(0));
        this._socket.end();
      } catch { /* best effort */ }
      this._socket = null;
    }
    // Reject all pending callbacks
    for (const [id, { reject }] of this._callbacks) {
      reject(new Error('WebSocket closed'));
    }
    this._callbacks.clear();
  }

  get connected() {
    return this._connected;
  }
}

// ── Browser Instance Manager ────────────────────────────────────────────────

/** @type {{ process: import('child_process').ChildProcess, ws: CDPWebSocket, wsUrl: string, userDataDir: string } | null} */
let _browser = null;

/**
 * Find a free port for CDP.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Wait for CDP to become available.
 * Uses Chrome's stderr to get the browser WS URL, then creates a page target.
 * Falls back to polling /json endpoint.
 */
async function waitForCDP(port, stderrPromise, timeoutMs = LAUNCH_TIMEOUT_MS) {
  const start = Date.now();

  // Wait for Chrome to print its DevTools WS URL
  let browserWsUrl;
  try {
    browserWsUrl = await Promise.race([
      stderrPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
  } catch { /* continue to polling */ }

  // Extract actual port from wsUrl (may differ from requested port)
  const actualPort = browserWsUrl
    ? parseInt(new URL(browserWsUrl).port, 10) || port
    : port;

  // Poll /json to find or create a page target
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${actualPort}/json`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const targets = await res.json();
        // Look for an existing page target
        const page = targets.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }

        // No page target — create one via /json/new
        try {
          const newRes = await fetch(`http://127.0.0.1:${actualPort}/json/new?about:blank`, {
            method: 'PUT',
            signal: AbortSignal.timeout(3000),
          });
          if (newRes.ok) {
            const newPage = await newRes.json();
            if (newPage.webSocketDebuggerUrl) {
              return newPage.webSocketDebuggerUrl;
            }
          }
        } catch { /* /json/new might not work, keep polling */ }
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Chrome CDP not available after ${timeoutMs}ms. Is Chrome installed?`);
}

/**
 * Launch Chrome headless and connect via CDP.
 * Returns the browser instance or throws.
 */
async function launchBrowser() {
  if (_browser && _browser.ws.connected) return _browser;

  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      'Chrome/Chromium not found. Install Chrome or set CHROME_PATH environment variable.\n' +
      'Checked paths:\n' +
      '  macOS: /Applications/Google Chrome.app\n' +
      '  Linux: /usr/bin/google-chrome, /usr/bin/chromium\n' +
      '  Windows: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    );
  }

  const userDataDir = path.join(os.tmpdir(), `nha-browser-${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const port = await findFreePort();

  // Realistic user agent to avoid bot detection on major sites
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    '--headless=new',
    `--user-data-dir=${userDataDir}`,
    `--user-agent=${UA}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update',
    '--window-size=1920,1080',
    'about:blank',
  ];

  const useChromePath = process.env.CHROME_PATH || chromePath;

  const proc = spawn(useChromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Capture stderr for debugging + extract DevTools WS URL
  let stderrBuf = '';
  const stderrWsPromise = new Promise((resolve) => {
    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      // Chrome prints: "DevTools listening on ws://127.0.0.1:PORT/devtools/browser/UUID"
      const wsMatch = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (wsMatch) resolve(wsMatch[1]);
    });
  });

  proc.on('error', (err) => {
    throw new Error(`Failed to launch Chrome: ${err.message}`);
  });

  // Wait for CDP to be ready
  let wsUrl;
  try {
    wsUrl = await waitForCDP(port, stderrWsPromise);
  } catch (err) {
    proc.kill('SIGTERM');
    // Wait for Chrome to fully exit before cleaning up
    await new Promise(r => setTimeout(r, 1000));
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
    throw new Error(`${err.message}\nChrome stderr: ${stderrBuf.slice(0, 500)}`);
  }

  // Connect WebSocket
  const ws = new CDPWebSocket();
  await ws.connect(wsUrl);

  // Enable required CDP domains
  await ws.send('Page.enable');
  await ws.send('Runtime.enable');
  await ws.send('Network.enable');
  await ws.send('DOM.enable');

  // Anti-detection: remove navigator.webdriver flag and other headless indicators
  await ws.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    `,
  });

  _browser = { process: proc, ws, wsUrl, userDataDir, port };

  // Cleanup on process exit
  const cleanup = () => {
    if (_browser) {
      try { _browser.ws.close(); } catch {}
      try { _browser.process.kill('SIGTERM'); } catch {}
      try { fs.rmSync(_browser.userDataDir, { recursive: true, force: true }); } catch {}
      _browser = null;
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return _browser;
}

/**
 * Get the active browser, launching if needed.
 */
async function getBrowser() {
  if (_browser && _browser.ws.connected) return _browser;
  return launchBrowser();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Open a URL in the browser.
 * SSRF-protected — blocks private IPs, localhost, non-HTTP protocols.
 *
 * @param {string} url - URL to navigate to
 * @param {object} [options]
 * @param {number} [options.timeout] - Navigation timeout in ms (default 30s)
 * @param {boolean} [options.waitForLoad] - Wait for page load event (default true)
 * @returns {Promise<{ title: string, url: string, status: number }>}
 */
/**
 * Lightweight HTTP fallback when Chrome/Chromium is not available.
 * Uses fetch() + regex-based HTML→text extraction. No JS rendering, no clicks.
 * Good enough for: news sites, blog posts, static pages, API responses,
 * documentation pages. NOT good for: SPAs, login flows, dynamic dashboards.
 */
async function browserOpenViaFetch(url, options = {}) {
  const timeout = options.timeout || 15000;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
      },
    });
    clearTimeout(timer);

    const status = res.status;
    const finalUrl = res.url || url;
    const ct = res.headers.get('content-type') || '';
    const isHtml = /html/i.test(ct);
    const raw = await res.text();

    if (!isHtml) {
      return {
        title: finalUrl,
        url: finalUrl,
        status,
        mode: 'fetch-fallback',
        warning: 'Chrome not installed — used HTTP fetch. No JS rendering. Limited interactivity.',
        content: raw.slice(0, 50_000),
      };
    }

    // Extract title
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : finalUrl;

    // Extract main text content: strip script/style/svg/comments, then strip tags
    let textContent = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ')   // strip nav/header noise
      .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, ' ');

    // Extract headlines + links separately for news sites
    const headlines = [];
    const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    while ((lm = linkRe.exec(raw)) !== null && headlines.length < 50) {
      const linkText = lm[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const href = lm[1];
      if (linkText.length > 20 && linkText.length < 200 && !href.startsWith('#') && !href.startsWith('javascript:')) {
        const absHref = href.startsWith('http') ? href : new URL(href, finalUrl).toString();
        headlines.push({ text: linkText, url: absHref });
      }
    }

    // Strip remaining tags to get plain text
    textContent = textContent
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x?[0-9a-f]+;/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      title,
      url: finalUrl,
      status,
      mode: 'fetch-fallback',
      warning: 'Chrome/Chromium not installed — used HTTP fetch fallback. No JS rendering, no interactive clicks/forms. To install: macOS use brew, Linux apt-get, Termux "pkg install chromium".',
      headlines: headlines.slice(0, 30),
      content: textContent.slice(0, 30_000),
    };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { error: true, message: `HTTP fetch timeout after ${timeout / 1000}s. The site may be slow or blocking the request.` };
    }
    return { error: true, message: `HTTP fetch failed: ${e.message}. ${/ENOTFOUND|ECONNREFUSED/.test(e.message) ? 'Network or DNS issue.' : ''}` };
  }
}

export async function browserOpen(url, options = {}) {
  // SSRF check
  const check = await isSafeUrl(url);
  if (!check.safe) {
    return { error: true, message: `SSRF blocked: ${check.reason}` };
  }

  // Fast fallback: if Chrome/Chromium is not installed (e.g. Termux on Android),
  // do a plain HTTP fetch and extract text content. Limited (no JS rendering,
  // no clicks), but works for news sites / blog posts / static pages.
  if (!findChromePath()) {
    return browserOpenViaFetch(url, options);
  }

  let browser;
  try {
    browser = await getBrowser();
  } catch (e) {
    // Chrome detection failed at launch — same fallback
    if (/Chrome\/Chromium not found/i.test(e.message || '')) {
      return browserOpenViaFetch(url, options);
    }
    throw e;
  }
  const timeout = options.timeout || NAV_TIMEOUT_MS;
  const waitForLoad = options.waitForLoad !== false;

  // Navigate
  const navResult = await browser.ws.send('Page.navigate', { url }, timeout);

  if (navResult.errorText) {
    return { error: true, message: `Navigation error: ${navResult.errorText}` };
  }

  // Wait for load
  if (waitForLoad) {
    try {
      await browser.ws.waitForEvent('Page.loadEventFired', timeout);
    } catch {
      // Page may not fire load event (e.g. streaming pages), continue anyway
    }
    // Small delay for JS rendering
    await new Promise(r => setTimeout(r, 500));
  }

  // Get page info
  const titleResult = await browser.ws.send('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  });

  const urlResult = await browser.ws.send('Runtime.evaluate', {
    expression: 'window.location.href',
    returnByValue: true,
  });

  // Check final URL for SSRF (after redirects)
  const finalUrl = urlResult.result?.value || url;
  if (finalUrl !== url) {
    const finalCheck = await isSafeUrl(finalUrl);
    if (!finalCheck.safe) {
      // Navigate away from the blocked page
      await browser.ws.send('Page.navigate', { url: 'about:blank' });
      return { error: true, message: `Redirect blocked: ${finalCheck.reason}` };
    }
  }

  // Auto-dismiss cookie/consent banners (best-effort, non-blocking)
  try {
    await browser.ws.send('Runtime.evaluate', {
      expression: `(function() {
        // Common consent banner selectors — covers 90%+ of European sites
        var selectors = [
          // iubenda
          '.iubenda-cs-accept-btn', '#iubenda-cs-banner .iubenda-cs-accept-btn',
          // OneTrust / CookiePro
          '#onetrust-accept-btn-handler', '.onetrust-close-btn-handler',
          // Quantcast / TCF
          '.qc-cmp2-summary-buttons button[mode="primary"]', '.qc-cmp-button',
          // Cookiebot
          '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept',
          // GDPR generic
          '[data-testid="cookie-policy-manage-dialog-btn-accept-all"]',
          'button[data-cookiefirst-action="accept"]',
          '.cc-accept', '.cc-allow', '.cc-dismiss',
          '#cookie-accept', '#accept-cookies', '#acceptCookies',
          '.cookie-accept', '.accept-cookies', '.js-accept-cookies',
          '[aria-label="Accept cookies"]', '[aria-label="Accetta"]', '[aria-label="Accept all"]',
          '[aria-label="Accetta tutti"]', '[aria-label="Accetta tutto"]',
          // Italian sites specific
          '#didomi-notice-agree-button', '.didomi-continue-without-agreeing',
          '.evidon-barrier-acceptall', '#privacy-cp-wall-accept',
          // Generic patterns
          'button[class*="accept"]', 'button[class*="consent"]', 'button[class*="agree"]',
          'button[id*="accept"]', 'button[id*="consent"]',
          // Last resort: buttons with common text
        ];
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el && el.offsetParent !== null) { el.click(); return 'dismissed:' + selectors[i]; }
        }
        // Text-based fallback: find buttons with accept/accetta text
        var buttons = document.querySelectorAll('button, a[role="button"], [class*="btn"]');
        var acceptTexts = ['accetta', 'accept all', 'accept', 'accetto', 'agree', 'ok, ho capito', 'ho capito', 'consenti', 'allow all', 'allow', 'got it', 'i agree', 'continua', 'prosegui'];
        for (var j = 0; j < buttons.length; j++) {
          var txt = (buttons[j].textContent || '').trim().toLowerCase();
          if (txt.length > 1 && txt.length < 40) {
            for (var k = 0; k < acceptTexts.length; k++) {
              if (txt === acceptTexts[k] || txt.startsWith(acceptTexts[k])) {
                buttons[j].click(); return 'dismissed-text:' + txt;
              }
            }
          }
        }
        return 'no-banner-found';
      })()`,
      returnByValue: true,
    });
    // Wait for banner animation to finish
    await new Promise(r => setTimeout(r, 300));
  } catch { /* banner dismiss failed — non-critical */ }

  return {
    error: false,
    title: titleResult.result?.value || '',
    url: finalUrl,
  };
}

/**
 * Take a screenshot of the current page.
 *
 * @param {object} [options]
 * @param {boolean} [options.fullPage] - Capture full scrollable page (default false)
 * @param {'png'|'jpeg'|'webp'} [options.format] - Image format (default 'png')
 * @param {number} [options.quality] - JPEG/WebP quality 0-100 (default 80)
 * @param {string} [options.saveTo] - Save to file path (otherwise returns base64)
 * @returns {Promise<{ base64: string, width: number, height: number, savedTo?: string }>}
 */
export async function browserScreenshot(options = {}) {
  const browser = await getBrowser();
  const format = options.format || 'png';
  const quality = format === 'png' ? undefined : (options.quality || 80);

  const params = {
    format,
    ...(quality !== undefined && { quality }),
  };

  if (options.fullPage) {
    // Get full page dimensions
    const metrics = await browser.ws.send('Page.getLayoutMetrics');
    const { width, height } = metrics.contentSize || metrics.cssContentSize || { width: 1920, height: 1080 };

    // Set viewport to full page size (capped)
    const cappedHeight = Math.min(height, 16384); // Chrome limit
    await browser.ws.send('Emulation.setDeviceMetricsOverride', {
      width: Math.ceil(width),
      height: Math.ceil(cappedHeight),
      deviceScaleFactor: 1,
      mobile: false,
    });

    params.clip = { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(cappedHeight), scale: 1 };
  }

  const result = await browser.ws.send('Page.captureScreenshot', params, SCREENSHOT_TIMEOUT_MS);

  // Reset viewport if we changed it
  if (options.fullPage) {
    await browser.ws.send('Emulation.clearDeviceMetricsOverride');
  }

  const base64 = result.data;

  if (options.saveTo) {
    const absPath = path.resolve(options.saveTo);
    fs.writeFileSync(absPath, Buffer.from(base64, 'base64'));
    return { error: false, base64, savedTo: absPath, size: base64.length };
  }

  return { error: false, base64, size: base64.length };
}

/**
 * Click an element by CSS selector, visible text, or coordinates.
 *
 * @param {object} target
 * @param {string} [target.selector] - CSS selector to click
 * @param {string} [target.text] - Visible text of a button/link/element to click (case-insensitive partial match)
 * @param {number} [target.x] - X coordinate
 * @param {number} [target.y] - Y coordinate
 * @returns {Promise<{ clicked: boolean, selector?: string }>}
 */
export async function browserClick(target) {
  const browser = await getBrowser();

  let x, y;
  let label = '';

  if (target.text) {
    // Find element by visible text — searches buttons, links, and all clickable elements
    const searchText = target.text;
    const result = await browser.ws.send('Runtime.evaluate', {
      expression: `(() => {
        const searchText = ${JSON.stringify(searchText)}.toLowerCase();
        // Search in priority order: buttons, links, then any visible element
        const candidates = [
          ...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'),
          ...document.querySelectorAll('a'),
          ...document.querySelectorAll('[onclick], [tabindex]'),
        ];
        for (const el of candidates) {
          const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
          if (text.toLowerCase().includes(searchText) && el.offsetHeight > 0 && el.offsetWidth > 0) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: text.slice(0, 60) };
            }
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    const info = result.result?.value;
    if (!info) {
      return { error: true, message: `No clickable element found with text "${searchText}". Try browser_extract to see visible buttons.` };
    }

    x = Math.round(info.x);
    y = Math.round(info.y);
    label = `"${info.text}" (${info.tag})`;
  } else if (target.selector) {
    // Find element by CSS selector and get its center point
    const result = await browser.ws.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(target.selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: el.textContent?.slice(0, 50) };
      })()`,
      returnByValue: true,
      awaitPromise: false,
    });

    const info = result.result?.value;
    if (!info) {
      return { error: true, message: `Element not found: ${target.selector}` };
    }

    x = Math.round(info.x);
    y = Math.round(info.y);
    label = target.selector;
  } else if (target.x !== undefined && target.y !== undefined) {
    x = target.x;
    y = target.y;
    label = `(${x}, ${y})`;
  } else {
    return { error: true, message: 'Provide text, CSS selector, or x/y coordinates' };
  }

  // Dispatch mouse events: move → down → up (simulates real click)
  await browser.ws.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y,
  });
  await browser.ws.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await browser.ws.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });

  // Wait for any navigation or JS handlers triggered by the click
  await new Promise(r => setTimeout(r, 500));

  // Check if the click triggered a navigation — wait for it
  try {
    const navCheck = await browser.ws.send('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    });
    if (navCheck.result?.value === 'loading') {
      // Page is navigating — wait for load
      try {
        await browser.ws.waitForEvent('Page.loadEventFired', 10000);
        await new Promise(r => setTimeout(r, 500));
      } catch { /* timeout ok */ }
    }
  } catch { /* evaluation failed during navigation, that's fine */ }

  return { error: false, clicked: true, x, y, selector: label || target.selector || `(${x}, ${y})` };
}

/**
 * Type text into the currently focused element or a specific selector.
 *
 * @param {object} params
 * @param {string} params.text - Text to type
 * @param {string} [params.selector] - CSS selector to focus first
 * @param {boolean} [params.clear] - Clear existing content before typing (default false)
 * @param {number} [params.delay] - Delay between keystrokes in ms (default 0 = instant)
 * @returns {Promise<{ typed: boolean, length: number }>}
 */
export async function browserType(params) {
  const browser = await getBrowser();

  if (params.selector) {
    // Click the element first to focus it
    const clickResult = await browserClick({ selector: params.selector });
    if (clickResult.error) return clickResult;
    await new Promise(r => setTimeout(r, 100));
  }

  if (params.clear) {
    // Select all and delete
    await browser.ws.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA',
      modifiers: os.platform() === 'darwin' ? 4 : 2, // Meta (Mac) or Ctrl
    });
    await browser.ws.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA',
    });
    await browser.ws.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace',
    });
    await browser.ws.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace',
    });
    await new Promise(r => setTimeout(r, 50));
  }

  const text = params.text || '';
  const delay = params.delay || 0;

  if (delay > 0) {
    // Type character by character with delay
    for (const char of text) {
      await browser.ws.send('Input.dispatchKeyEvent', {
        type: 'keyDown', text: char, key: char,
        unmodifiedText: char,
      });
      await browser.ws.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: char,
      });
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }
  } else {
    // Insert text all at once (faster)
    await browser.ws.send('Input.insertText', { text });
  }

  return { error: false, typed: true, length: text.length, selector: params.selector || '(focused)' };
}

/**
 * Extract text content or HTML from the current page.
 *
 * @param {object} [options]
 * @param {string} [options.selector] - CSS selector to extract from (default: body)
 * @param {'text'|'html'|'value'|'attribute'} [options.mode] - Extraction mode (default 'text')
 * @param {string} [options.attribute] - Attribute name when mode='attribute'
 * @param {boolean} [options.all] - Extract from all matching elements (default false)
 * @returns {Promise<{ content: string, length: number }>}
 */
export async function browserExtract(options = {}) {
  const browser = await getBrowser();
  const selector = options.selector || 'body';
  const mode = options.mode || 'text';

  let expression;

  if (options.all) {
    expression = `(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      if (els.length === 0) return null;
      return Array.from(els).map((el, i) => {
        ${mode === 'html' ? 'return el.innerHTML;' : ''}
        ${mode === 'value' ? 'return el.value || el.textContent;' : ''}
        ${mode === 'attribute' ? `return el.getAttribute(${JSON.stringify(options.attribute || '')});` : ''}
        ${mode === 'text' ? 'return el.textContent;' : ''}
      }).filter(Boolean).join('\\n---\\n');
    })()`;
  } else {
    expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      ${mode === 'html' ? 'return el.innerHTML;' : ''}
      ${mode === 'value' ? 'return el.value || el.textContent;' : ''}
      ${mode === 'attribute' ? `return el.getAttribute(${JSON.stringify(options.attribute || '')});` : ''}
      ${mode === 'text' ? 'return el.textContent;' : ''}
    })()`;
  }

  const result = await browser.ws.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });

  const content = result.result?.value;
  if (content === null || content === undefined) {
    return { error: true, message: `Element not found: ${selector}` };
  }

  // Trim and cap output
  let trimmed = typeof content === 'string'
    ? content.replace(/\s+/g, ' ').trim()
    : String(content);

  if (trimmed.length > MAX_OUTPUT_CHARS) {
    trimmed = trimmed.slice(0, MAX_OUTPUT_CHARS) + '\n\n[... truncated at 12000 chars]';
  }

  return { error: false, content: trimmed, length: trimmed.length, selector };
}

/**
 * Execute arbitrary JavaScript in the page context.
 *
 * @param {string} code - JavaScript code to execute
 * @param {object} [options]
 * @param {boolean} [options.awaitPromise] - Await promise result (default true)
 * @returns {Promise<{ result: any, type: string }>}
 */
export async function browserEval(code, options = {}) {
  const browser = await getBrowser();

  // Auto-wrap object literals: {key: val} → ({key: val}) to avoid block/label ambiguity
  let expression = code.trim();
  if (expression.startsWith('{') && !expression.startsWith('{(')) {
    expression = `(${expression})`;
  }

  let result = await browser.ws.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: options.awaitPromise !== false,
    generatePreview: true,
  }, COMMAND_TIMEOUT_MS);

  // If SyntaxError, retry with IIFE wrapper
  if (result.exceptionDetails?.exception?.description?.includes('SyntaxError')) {
    result = await browser.ws.send('Runtime.evaluate', {
      expression: `(() => { return (${code.trim()}); })()`,
      returnByValue: true,
      awaitPromise: options.awaitPromise !== false,
      generatePreview: true,
    }, COMMAND_TIMEOUT_MS);
  }

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown JS error';
    return { error: true, message: `JS error: ${errMsg}` };
  }

  const value = result.result?.value;
  const type = result.result?.type;

  let display;
  if (type === 'undefined') {
    display = 'undefined';
  } else if (value === null) {
    display = 'null';
  } else if (typeof value === 'object') {
    try {
      display = JSON.stringify(value, null, 2);
    } catch {
      display = String(value);
    }
  } else {
    display = String(value);
  }

  if (display.length > MAX_OUTPUT_CHARS) {
    display = display.slice(0, MAX_OUTPUT_CHARS) + '\n\n[... truncated]';
  }

  return { error: false, result: display, type: type || 'unknown' };
}

/**
 * Wait for an element to appear on the page.
 *
 * @param {string} selector - CSS selector to wait for
 * @param {object} [options]
 * @param {number} [options.timeout] - Max wait time in ms (default 10000)
 * @param {boolean} [options.visible] - Wait for element to be visible (default true)
 * @returns {Promise<{ found: boolean }>}
 */
export async function browserWaitFor(selector, options = {}) {
  const browser = await getBrowser();
  const timeout = options.timeout || 10000;
  const visible = options.visible !== false;

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const check = await browser.ws.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        ${visible ? `
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        ` : ''}
        return true;
      })()`,
      returnByValue: true,
    });

    if (check.result?.value === true) {
      return { error: false, found: true, selector, elapsed: Date.now() - start };
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return { error: true, message: `Element "${selector}" not found after ${timeout}ms` };
}

/**
 * Get the current page URL and title.
 */
export async function browserInfo() {
  const browser = await getBrowser();

  const result = await browser.ws.send('Runtime.evaluate', {
    expression: `({ url: window.location.href, title: document.title, readyState: document.readyState })`,
    returnByValue: true,
  });

  return {
    error: false,
    url: result.result?.value?.url || 'about:blank',
    title: result.result?.value?.title || '',
    readyState: result.result?.value?.readyState || 'unknown',
  };
}

/**
 * Close the browser instance.
 */
export async function browserClose() {
  if (!_browser) return { error: false, message: 'No browser running' };

  try { _browser.ws.close(); } catch {}
  try { _browser.process.kill('SIGTERM'); } catch {}
  try { fs.rmSync(_browser.userDataDir, { recursive: true, force: true }); } catch {}
  _browser = null;

  return { error: false, message: 'Browser closed' };
}

/**
 * Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.)
 *
 * @param {string} key - Key name (e.g. 'Enter', 'Tab', 'Escape')
 * @param {object} [options]
 * @param {boolean} [options.ctrl] - Hold Ctrl/Meta
 * @param {boolean} [options.shift] - Hold Shift
 * @param {boolean} [options.alt] - Hold Alt
 * @returns {Promise<{ pressed: boolean }>}
 */
export async function browserKeyPress(key, options = {}) {
  const browser = await getBrowser();

  let modifiers = 0;
  if (options.alt) modifiers |= 1;
  if (options.ctrl) modifiers |= 2;
  if (os.platform() === 'darwin' && options.ctrl) modifiers |= 4; // Meta on Mac
  if (options.shift) modifiers |= 8;

  // Map common key names to CDP key codes
  const keyMap = {
    'Enter': { key: 'Enter', code: 'Enter' },
    'Tab': { key: 'Tab', code: 'Tab' },
    'Escape': { key: 'Escape', code: 'Escape' },
    'Backspace': { key: 'Backspace', code: 'Backspace' },
    'Delete': { key: 'Delete', code: 'Delete' },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp' },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown' },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft' },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight' },
    'Space': { key: ' ', code: 'Space' },
  };

  const mapped = keyMap[key] || { key, code: `Key${key.toUpperCase()}` };

  await browser.ws.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: mapped.key,
    code: mapped.code,
    modifiers,
  });
  await browser.ws.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: mapped.key,
    code: mapped.code,
    modifiers,
  });

  return { error: false, pressed: true, key };
}

/**
 * Scroll the page.
 *
 * @param {object} [options]
 * @param {'up'|'down'|'top'|'bottom'} [options.direction] - Scroll direction (default 'down')
 * @param {number} [options.amount] - Pixels to scroll (default 500)
 * @returns {Promise<{ scrolled: boolean }>}
 */
export async function browserScroll(options = {}) {
  const browser = await getBrowser();
  const direction = options.direction || 'down';
  const amount = options.amount || 500;

  let expression;
  switch (direction) {
    case 'top':
      expression = 'window.scrollTo(0, 0)';
      break;
    case 'bottom':
      expression = 'window.scrollTo(0, document.body.scrollHeight)';
      break;
    case 'up':
      expression = `window.scrollBy(0, -${amount})`;
      break;
    case 'down':
    default:
      expression = `window.scrollBy(0, ${amount})`;
      break;
  }

  await browser.ws.send('Runtime.evaluate', {
    expression: `${expression}; ({ scrollY: window.scrollY, scrollHeight: document.body.scrollHeight })`,
    returnByValue: true,
  });

  return { error: false, scrolled: true, direction };
}

/**
 * Check if browser is currently running.
 */
export function isBrowserRunning() {
  return _browser !== null && _browser.ws.connected;
}
