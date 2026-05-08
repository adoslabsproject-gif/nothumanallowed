/**
 * Message Responder — auto-responds to Telegram and Discord messages using NHA agents.
 *
 * Runs inside the daemon process. Connects via:
 * - Telegram Bot API (long polling via native fetch, zero dependencies)
 * - Discord Gateway (WebSocket via native net/tls, zero dependencies)
 *
 * Routing: keyword-based (no LLM call) to save API costs. Falls back to CONDUCTOR.
 */

import { callAgent, callLLM } from './llm.mjs';
import { buildSystemPrompt, parseActions, executeTool, TOOL_DEFINITIONS } from './tool-executor.mjs';
import https from 'https';
import http from 'http';
import { URL } from 'url';

// ── Agent Routing (keyword-based, zero LLM calls) ───────────────────────────

const ROUTING_TABLE = [
  {
    agent: 'saber',
    keywords: [
      'security', 'secure', 'vulnerability', 'vuln', 'exploit', 'attack',
      'pentest', 'penetration', 'cve', 'owasp', 'xss', 'sql injection',
      'firewall', 'malware', 'phishing', 'ransomware', 'encryption',
      'authentication', 'auth', 'csrf', 'ssrf', 'rce', 'injection',
    ],
  },
  {
    agent: 'forge',
    keywords: [
      'code', 'coding', 'deploy', 'deployment', 'ci', 'cd', 'cicd',
      'pipeline', 'build', 'compile', 'docker', 'kubernetes', 'k8s',
      'git', 'commit', 'merge', 'pull request', 'pr', 'branch',
      'debug', 'debugger', 'refactor', 'typescript', 'javascript',
      'python', 'rust', 'golang', 'java', 'react', 'node', 'npm',
    ],
  },
  {
    agent: 'oracle',
    keywords: [
      'data', 'analysis', 'analyze', 'analytics', 'stats', 'statistics',
      'metric', 'metrics', 'chart', 'graph', 'dashboard', 'report',
      'trend', 'forecast', 'predict', 'prediction', 'dataset',
      'database', 'query', 'sql', 'aggregate', 'visualization',
    ],
  },
  {
    agent: 'herald',
    keywords: [
      'schedule', 'scheduling', 'meeting', 'meetings', 'calendar',
      'appointment', 'event', 'agenda', 'reminder', 'remind',
      'reschedule', 'cancel meeting', 'book', 'booking', 'slot',
      'availability', 'free time', 'when', 'tomorrow', 'next week',
    ],
  },
  {
    agent: 'scheherazade',
    keywords: [
      'write', 'writing', 'draft', 'blog', 'article', 'essay',
      'documentation', 'docs', 'readme', 'copywriting', 'copy',
      'content', 'post', 'newsletter', 'email draft', 'template',
      'summarize', 'summary', 'outline', 'creative', 'story',
    ],
  },
  {
    agent: 'athena',
    keywords: [
      'audit', 'review', 'compliance', 'policy', 'governance',
      'risk', 'assessment', 'standard', 'regulation', 'gdpr',
      'hipaa', 'soc2', 'iso', 'framework', 'benchmark',
    ],
  },
  {
    agent: 'sauron',
    keywords: [
      'monitor', 'monitoring', 'alert', 'alerting', 'uptime',
      'downtime', 'health check', 'status', 'incident', 'outage',
      'prometheus', 'grafana', 'log', 'logs', 'logging', 'trace',
    ],
  },
];

/**
 * Route a message to the appropriate agent using keyword matching.
 * Returns agent name (lowercase).
 */
function routeMessage(text, useAutoRoute = true) {
  if (!useAutoRoute) return 'conductor';

  const lower = text.toLowerCase();

  let bestAgent = 'conductor';
  let bestScore = 0;

  for (const entry of ROUTING_TABLE) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) {
        // Longer keywords get higher weight to avoid false positives
        score += kw.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestAgent = entry.agent;
    }
  }

  return bestAgent;
}

// ── Tool-aware agent call (LLM + tool execution loop) ────────────────────────

/**
 * Call an agent with full tool execution support.
 * Like chat.mjs but headless — no confirmation prompts, all tools auto-executed.
 * Returns a human-readable summary of what was done.
 */
async function callAgentWithTools(config, agentName, userMessage) {
  const today = new Date().toISOString().split('T')[0];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  const LANG_MAP = { en: 'English', it: 'Italian', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish' };
  const language = config?.language || LANG_MAP[locale.split('-')[0]] || 'English';

  const systemPrompt = TOOL_DEFINITIONS
    .replace('{{TODAY}}', today)
    .replace('{{TIMEZONE}}', tz)
    .replace(/\{\{LANGUAGE\}\}/g, language);

  // Multi-turn: serialize history as [User]/[Assistant] string (same pattern as chat.mjs)
  const history = []; // [{role, content}]
  let finalText = '';

  for (let round = 0; round < 3; round++) {
    // Build serialized message
    const parts = history.map(h => (h.role === 'user' ? '[User]' : '[Assistant]') + ' ' + h.content);
    parts.push('[User] ' + userMessage);
    if (round > 0) {
      // Replace last user with tool results continuation
    }
    const serialized = parts.join('\n\n');

    const response = await callLLM(config, systemPrompt, serialized);
    const { textParts, actions } = parseActions(response);
    finalText = textParts.join('\n').trim();

    if (actions.length === 0) break; // No tools — pure text response

    // Execute all tools and collect results
    const toolResults = [];
    for (const { action, params } of actions) {
      try {
        const result = await executeTool(action, params, config);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        toolResults.push(`[${action}] ${resultStr}`);
      } catch (err) {
        toolResults.push(`[${action}] Error: ${err.message}`);
      }
    }

    // Feed results back: append assistant response + tool results as next user turn
    history.push({ role: 'assistant', content: response });
    userMessage = 'Tool results:\n' + toolResults.join('\n') + '\n\nNow give the user a concise confirmation in ' + language + '. Do NOT use HERALD format — respond conversationally.';
  }

  return finalText || 'Done.';
}

// ── Telegram Bot (Long Polling via native fetch) ─────────────────────────────

class TelegramResponder {
  constructor(config, log, wsBroadcast) {
    this.config = config;
    this.log = log;
    this.wsBroadcast = wsBroadcast;
    this.token = config.responder?.telegram?.token || '';
    this.allowedChatIds = config.responder?.telegram?.allowedChatIds || [];
    this.autoRoute = config.responder?.autoRoute !== false;
    this.running = false;
    this.offset = 0;
    this.abortController = null;
    this.pendingRequests = 0;
    this.maxConcurrent = 3;
  }

  get enabled() {
    return !!this.token;
  }

  async start() {
    if (!this.enabled) return;
    this.running = true;
    this.log('[Telegram] Responder started — polling for messages');
    this._pollLoop();
  }

  stop() {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.log('[Telegram] Responder stopped');
  }

  async _pollLoop() {
    while (this.running) {
      try {
        this.abortController = new AbortController();
        const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=30&allowed_updates=["message"]`;

        const res = await fetch(url, {
          signal: this.abortController.signal,
          headers: { 'Accept': 'application/json' },
        });

        if (!res.ok) {
          const errText = await res.text();
          this.log(`[Telegram] API error ${res.status}: ${errText}`);
          // Backoff on error
          await this._sleep(5000);
          continue;
        }

        const data = await res.json();

        if (!data.ok || !Array.isArray(data.result)) {
          await this._sleep(2000);
          continue;
        }

        for (const update of data.result) {
          this.offset = update.update_id + 1;

          if (update.message && update.message.text) {
            // Fire-and-forget with concurrency guard
            if (this.pendingRequests < this.maxConcurrent) {
              this._handleMessage(update.message).catch(err => {
                this.log(`[Telegram] Handle error: ${err.message}`);
              });
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') break;
        this.log(`[Telegram] Poll error: ${err.message}`);
        await this._sleep(5000);
      }
    }
  }

  async _handleMessage(message) {
    const chatId = message.chat.id;
    const text = message.text;
    const fromUser = message.from?.first_name || message.from?.username || 'Unknown';

    // Chat ID allowlist check
    if (this.allowedChatIds.length > 0 && !this.allowedChatIds.includes(chatId)) {
      return;
    }

    // Skip bot commands that aren't directed at us
    if (text.startsWith('/') && !text.startsWith('/ask') && !text.startsWith('/nha')) {
      return;
    }

    // Strip /ask or /nha prefix if present
    const cleanText = text.replace(/^\/(ask|nha)\s*/i, '').trim();
    if (!cleanText) return;

    this.pendingRequests++;
    try {
      const agent = routeMessage(cleanText, this.autoRoute);
      this.log(`[Telegram] ${fromUser} (chat ${chatId}): routed to ${agent.toUpperCase()}`);

      // Broadcast event
      this.wsBroadcast({
        type: 'responder_message',
        timestamp: new Date().toISOString(),
        data: { platform: 'telegram', from: fromUser, chatId, agent, text: cleanText.slice(0, 120) },
      });

      // Send typing indicator
      await this._telegramCall('sendChatAction', { chat_id: chatId, action: 'typing' });

      // Tool-capable agents use the full tool execution loop
      // Pure reasoning/analysis agents use the simple callAgent (no tools)
      const TOOL_AGENTS = new Set(['herald', 'hermes', 'edi', 'jarvis', 'flux', 'echo', 'mercury', 'pipe', 'navi', 'link', 'prometheus', 'tempest']);
      const callFn = TOOL_AGENTS.has(agent) ? callAgentWithTools : callAgent;
      const response = await callFn(this.config, agent, cleanText);

      // Truncate if too long for Telegram (4096 char limit)
      const truncated = response.length > 4000
        ? response.slice(0, 3950) + '\n\n... [truncated]'
        : response;

      // Send response
      await this._telegramCall('sendMessage', {
        chat_id: chatId,
        text: `[${agent.toUpperCase()}]\n\n${truncated}`,
        parse_mode: 'Markdown',
      });

      this.log(`[Telegram] Responded to ${fromUser} via ${agent.toUpperCase()} (${response.length} chars)`);
    } catch (err) {
      this.log(`[Telegram] Agent call failed: ${err.message}`);
      // Send error message to user
      await this._telegramCall('sendMessage', {
        chat_id: chatId,
        text: `Error: ${err.message}`,
      }).catch(() => {});
    } finally {
      this.pendingRequests--;
    }
  }

  async _telegramCall(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram ${method} ${res.status}: ${err}`);
    }
    return res.json();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── Discord Bot (Gateway WebSocket via raw TLS, zero dependencies) ───────────

class DiscordResponder {
  constructor(config, log, wsBroadcast) {
    this.config = config;
    this.log = log;
    this.wsBroadcast = wsBroadcast;
    this.token = config.responder?.discord?.token || '';
    this.allowedChannelIds = config.responder?.discord?.allowedChannelIds || [];
    this.autoRoute = config.responder?.autoRoute !== false;
    this.running = false;
    this.ws = null;
    this.heartbeatInterval = null;
    this.heartbeatAck = true;
    this.sequence = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.pendingRequests = 0;
    this.maxConcurrent = 3;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.botUserId = null;
  }

  get enabled() {
    return !!this.token;
  }

  async start() {
    if (!this.enabled) return;
    this.running = true;
    this.log('[Discord] Responder starting — connecting to gateway');
    await this._connect();
  }

  stop() {
    this.running = false;
    this._clearHeartbeat();
    if (this.ws) {
      try { this.ws.destroy(); } catch {}
      this.ws = null;
    }
    this.log('[Discord] Responder stopped');
  }

  async _connect(resumeUrl) {
    const gatewayUrl = resumeUrl || 'wss://gateway.discord.gg/?v=10&encoding=json';

    try {
      const parsed = new URL(gatewayUrl);
      const port = 443;

      this.ws = https.request({
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Key': Buffer.from(Array.from({ length: 16 }, () => Math.random() * 256 | 0)).toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      });

      this.ws.on('upgrade', (res, socket, head) => {
        this.log('[Discord] WebSocket connected');
        this.reconnectAttempts = 0;
        this._wsBuffer = '';
        this._wsSocket = socket;

        socket.on('data', (chunk) => this._onWsData(chunk));
        socket.on('close', () => this._onClose());
        socket.on('error', (err) => {
          this.log(`[Discord] Socket error: ${err.message}`);
          this._onClose();
        });
      });

      this.ws.on('error', (err) => {
        this.log(`[Discord] Connection error: ${err.message}`);
        this._scheduleReconnect();
      });

      this.ws.end();
    } catch (err) {
      this.log(`[Discord] Connect failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  _onWsData(chunk) {
    // Decode WebSocket frames — Discord sends unmasked text frames
    // This is a minimal frame parser for text frames from server (unmasked)
    let offset = 0;
    const buf = chunk;

    while (offset < buf.length) {
      if (buf.length - offset < 2) break;

      const firstByte = buf[offset];
      const secondByte = buf[offset + 1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let headerLen = 2;

      if (payloadLen === 126) {
        if (buf.length - offset < 4) break;
        payloadLen = buf.readUInt16BE(offset + 2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (buf.length - offset < 10) break;
        payloadLen = Number(buf.readBigUInt64BE(offset + 2));
        headerLen = 10;
      }

      if (isMasked) headerLen += 4;

      const totalLen = headerLen + payloadLen;
      if (buf.length - offset < totalLen) break;

      if (opcode === 1) { // text frame
        const payload = buf.slice(offset + headerLen, offset + headerLen + payloadLen).toString('utf-8');
        this._handleGatewayMessage(payload);
      } else if (opcode === 8) { // close
        const code = payloadLen >= 2 ? buf.readUInt16BE(offset + headerLen) : 1000;
        this.log(`[Discord] Gateway close: ${code}`);
        this._onClose(code);
        return;
      } else if (opcode === 9) { // ping
        this._sendWsFrame(10, buf.slice(offset + headerLen, offset + headerLen + payloadLen));
      }

      offset += totalLen;
    }
  }

  _sendWsFrame(opcode, data) {
    if (!this._wsSocket || this._wsSocket.destroyed) return;

    const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : (data || Buffer.alloc(0));
    const len = payload.length;

    // Client frames MUST be masked
    const mask = Buffer.from(Array.from({ length: 4 }, () => Math.random() * 256 | 0));

    let header;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
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

    // Mask the payload
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payload[i] ^ mask[i % 4];
    }

    try {
      this._wsSocket.write(Buffer.concat([header, masked]));
    } catch {}
  }

  _sendJson(data) {
    this._sendWsFrame(1, JSON.stringify(data));
  }

  _handleGatewayMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { op, d, s, t } = msg;

    if (s !== null && s !== undefined) this.sequence = s;

    switch (op) {
      case 10: // HELLO
        this._startHeartbeat(d.heartbeat_interval);
        this._identify();
        break;

      case 11: // HEARTBEAT ACK
        this.heartbeatAck = true;
        break;

      case 1: // HEARTBEAT request
        this._sendHeartbeat();
        break;

      case 7: // RECONNECT
        this.log('[Discord] Gateway requested reconnect');
        this._reconnect();
        break;

      case 9: // INVALID SESSION
        this.log('[Discord] Invalid session, re-identifying');
        setTimeout(() => this._identify(), 1000 + Math.random() * 4000);
        break;

      case 0: // DISPATCH
        this._handleDispatch(t, d);
        break;
    }
  }

  _identify() {
    if (this.sessionId && this.sequence !== null) {
      // Resume
      this._sendJson({
        op: 6,
        d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
      });
      this.log('[Discord] Sent RESUME');
    } else {
      // Fresh identify
      this._sendJson({
        op: 2,
        d: {
          token: this.token,
          intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES | MESSAGE_CONTENT
          properties: { os: 'linux', browser: 'nha-cli', device: 'nha-cli' },
        },
      });
      this.log('[Discord] Sent IDENTIFY');
    }
  }

  _startHeartbeat(intervalMs) {
    this._clearHeartbeat();
    // First heartbeat at random jitter
    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      this._sendHeartbeat();
      this.heartbeatInterval = setInterval(() => {
        if (!this.heartbeatAck) {
          this.log('[Discord] Heartbeat ACK missed — reconnecting');
          this._reconnect();
          return;
        }
        this.heartbeatAck = false;
        this._sendHeartbeat();
      }, intervalMs);
    }, jitter);
  }

  _sendHeartbeat() {
    this._sendJson({ op: 1, d: this.sequence });
  }

  _clearHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _handleDispatch(event, data) {
    switch (event) {
      case 'READY':
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        this.botUserId = data.user?.id;
        this.log(`[Discord] READY — session ${this.sessionId}, bot user ${this.botUserId}`);
        break;

      case 'RESUMED':
        this.log('[Discord] Session resumed');
        break;

      case 'MESSAGE_CREATE':
        this._handleDiscordMessage(data);
        break;
    }
  }

  async _handleDiscordMessage(message) {
    // Ignore bot messages (including our own)
    if (message.author?.bot) return;
    if (message.author?.id === this.botUserId) return;

    const channelId = message.channel_id;
    const text = message.content;
    const fromUser = message.author?.username || 'Unknown';

    if (!text || text.trim().length === 0) return;

    // Channel allowlist check
    if (this.allowedChannelIds.length > 0 && !this.allowedChannelIds.includes(channelId)) {
      return;
    }

    // Only respond to mentions or messages starting with !nha / !ask
    const mentionPattern = this.botUserId ? `<@${this.botUserId}>` : null;
    const isMentioned = mentionPattern && text.includes(mentionPattern);
    const isCommand = text.startsWith('!nha') || text.startsWith('!ask');

    if (!isMentioned && !isCommand) return;

    // Strip prefix
    let cleanText = text;
    if (mentionPattern) cleanText = cleanText.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '');
    cleanText = cleanText.replace(/^!(nha|ask)\s*/i, '').trim();
    if (!cleanText) return;

    if (this.pendingRequests >= this.maxConcurrent) return;
    this.pendingRequests++;

    try {
      const agent = routeMessage(cleanText, this.autoRoute);
      this.log(`[Discord] ${fromUser} (#${channelId}): routed to ${agent.toUpperCase()}`);

      this.wsBroadcast({
        type: 'responder_message',
        timestamp: new Date().toISOString(),
        data: { platform: 'discord', from: fromUser, channelId, agent, text: cleanText.slice(0, 120) },
      });

      // Send typing indicator
      await this._discordApiCall('POST', `/channels/${channelId}/typing`);

      // Tool-capable agents use the full tool execution loop
      const TOOL_AGENTS = new Set(['herald', 'hermes', 'edi', 'jarvis', 'flux', 'echo', 'mercury', 'pipe', 'navi', 'link', 'prometheus', 'tempest']);
      const callFn = TOOL_AGENTS.has(agent) ? callAgentWithTools : callAgent;
      const response = await callFn(this.config, agent, cleanText);

      // Discord message limit is 2000 chars
      const truncated = response.length > 1900
        ? response.slice(0, 1850) + '\n\n... [truncated]'
        : response;

      // Send response
      await this._discordApiCall('POST', `/channels/${channelId}/messages`, {
        content: `**[${agent.toUpperCase()}]**\n\n${truncated}`,
      });

      this.log(`[Discord] Responded to ${fromUser} via ${agent.toUpperCase()} (${response.length} chars)`);
    } catch (err) {
      this.log(`[Discord] Agent call failed: ${err.message}`);
      await this._discordApiCall('POST', `/channels/${channelId}/messages`, {
        content: `Error: ${err.message}`,
      }).catch(() => {});
    } finally {
      this.pendingRequests--;
    }
  }

  async _discordApiCall(method, endpoint, body) {
    const res = await fetch(`https://discord.com/api/v10${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'NHA-CLI (https://nothumanallowed.com, 5.0)',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Discord API ${method} ${endpoint}: ${res.status} ${err}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return null;
  }

  _onClose(code) {
    this._clearHeartbeat();
    if (!this.running) return;

    // Certain close codes mean we should not reconnect
    const nonRecoverable = [4004, 4010, 4011, 4012, 4013, 4014];
    if (code && nonRecoverable.includes(code)) {
      this.log(`[Discord] Non-recoverable close code ${code} — stopping`);
      this.running = false;
      return;
    }

    this._scheduleReconnect();
  }

  _reconnect() {
    this._clearHeartbeat();
    if (this._wsSocket) {
      try { this._wsSocket.destroy(); } catch {}
      this._wsSocket = null;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.running) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('[Discord] Max reconnect attempts reached — stopping');
      this.running = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.log(`[Discord] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      if (this.running) {
        this._connect(this.resumeGatewayUrl || undefined);
      }
    }, delay);
  }
}

// ── Exported API ─────────────────────────────────────────────────────────────

let _telegramInstance = null;
let _discordInstance = null;

/**
 * Start the message responder for all configured platforms.
 * Called from the daemon loop.
 *
 * @param {object} config — NHA config
 * @param {function} log — log function
 * @param {function} wsBroadcast — WebSocket broadcast function
 */
export function startResponder(config, log, wsBroadcast) {
  stopResponder();

  const hasAnyToken = config.responder?.telegram?.token || config.responder?.discord?.token;
  if (!hasAnyToken) {
    log('[Responder] No tokens configured — skipping');
    return { telegram: false, discord: false };
  }

  if (!config.llm?.apiKey) {
    log('[Responder] No LLM API key — cannot respond to messages');
    return { telegram: false, discord: false };
  }

  const result = { telegram: false, discord: false };

  if (config.responder?.telegram?.token) {
    _telegramInstance = new TelegramResponder(config, log, wsBroadcast);
    _telegramInstance.start();
    result.telegram = true;
  }

  if (config.responder?.discord?.token) {
    _discordInstance = new DiscordResponder(config, log, wsBroadcast);
    _discordInstance.start();
    result.discord = true;
  }

  return result;
}

/**
 * Stop all responder instances.
 */
export function stopResponder() {
  if (_telegramInstance) {
    _telegramInstance.stop();
    _telegramInstance = null;
  }
  if (_discordInstance) {
    _discordInstance.stop();
    _discordInstance = null;
  }
}

/**
 * Get responder status.
 */
export function getResponderStatus() {
  return {
    telegram: {
      enabled: _telegramInstance?.enabled || false,
      running: _telegramInstance?.running || false,
      pending: _telegramInstance?.pendingRequests || 0,
    },
    discord: {
      enabled: _discordInstance?.enabled || false,
      running: _discordInstance?.running || false,
      pending: _discordInstance?.pendingRequests || 0,
      sessionId: _discordInstance?.sessionId || null,
    },
  };
}

export { routeMessage };
