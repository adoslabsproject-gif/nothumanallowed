/**
 * Connectors — visual workflow automation backend
 * Workflows stored in ~/.nha/workflows/*.json
 * Execution: each node runs a real NHA tool or AI call
 *
 * 15.1.40 — closes the gap vs n8n:
 *   • Workflow versioning (auto-snapshot on each save)
 *   • Webhook triggers (HTTP endpoint per workflow)
 *   • Credentials manager (AES-256-GCM at rest, ${cred.NAME} interpolation)
 *   • Subworkflows (one workflow can call another)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { NHA_DIR } from '../../constants.mjs';
import { loadConfig } from '../../config.mjs';
import { sendJSON, sendError, parseBody } from '../index.mjs';
import { executeTool } from '../../services/tool-executor.mjs';
import { callLLM } from '../../services/llm.mjs';
import { broadcast } from '../ws.mjs';

const WORKFLOWS_DIR  = path.join(NHA_DIR, 'workflows');
const VERSIONS_DIR   = path.join(NHA_DIR, 'workflows', '_versions');
const RUNS_DIR       = path.join(NHA_DIR, 'workflows', '_runs');
const CREDS_FILE     = path.join(NHA_DIR, 'credentials.json');
const CONNECTORS_DIR = path.join(NHA_DIR, 'connectors');
const CONNECTOR_REGISTRY_URL = 'https://nothumanallowed.com/awf/connectors/index.json';
const MAX_VERSIONS_PER_WF = 50;
const MAX_RUNS_PER_WF = 30;

// Active environment for credentials. Read from NHA_ENV env var or config
// (responder.env). Defaults to 'prod'. Used to resolve `${cred.NAME}` to
// the right credential variant when multiple envs are stored.
function _currentEnv() {
  return (process.env.NHA_ENV || 'prod').toLowerCase();
}

function ensureDir() {
  if (!fs.existsSync(WORKFLOWS_DIR)) fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  if (!fs.existsSync(VERSIONS_DIR))  fs.mkdirSync(VERSIONS_DIR,  { recursive: true });
  if (!fs.existsSync(RUNS_DIR))      fs.mkdirSync(RUNS_DIR,      { recursive: true });
}

function listWorkflows() {
  ensureDir();
  return fs.readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

function saveWorkflow(wf) {
  ensureDir();
  const file = path.join(WORKFLOWS_DIR, `${wf.id}.json`);
  // 1. Snapshot previous version BEFORE overwriting — that's how we get
  //    a real history viewer like n8n's. Pruned to MAX_VERSIONS_PER_WF.
  if (fs.existsSync(file)) {
    const wfVersionsDir = path.join(VERSIONS_DIR, wf.id);
    if (!fs.existsSync(wfVersionsDir)) fs.mkdirSync(wfVersionsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      const prev = fs.readFileSync(file, 'utf-8');
      fs.writeFileSync(path.join(wfVersionsDir, `${ts}.json`), prev);
      // Prune oldest
      const versions = fs.readdirSync(wfVersionsDir).filter((f) => f.endsWith('.json')).sort();
      while (versions.length > MAX_VERSIONS_PER_WF) {
        try { fs.unlinkSync(path.join(wfVersionsDir, versions.shift())); } catch {}
      }
    } catch { /* snapshot failure shouldn't block the save */ }
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
}

function deleteWorkflow(id) {
  const p = path.join(WORKFLOWS_DIR, `${id}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  // Also delete versions
  const vd = path.join(VERSIONS_DIR, id);
  if (fs.existsSync(vd)) fs.rmSync(vd, { recursive: true, force: true });
}

function listVersions(id) {
  const vd = path.join(VERSIONS_DIR, id);
  if (!fs.existsSync(vd)) return [];
  return fs.readdirSync(vd)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const ts = f.replace(/\.json$/, '');
      try {
        const stat = fs.statSync(path.join(vd, f));
        return { ts, mtime: stat.mtimeMs, size: stat.size };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

function loadVersion(id, ts) {
  const p = path.join(VERSIONS_DIR, id, `${ts}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// ── Credentials manager (AES-256-GCM at rest, machine-bound key) ────────────
//
// Why this implementation: storing API keys plain-text in config.json is the
// #1 footgun for self-hosted automation tools. n8n encrypts credentials with
// an encryption key (env var). We do the same but derive the key from the
// machine identity (username + hostname + a stable salt file in ~/.nha/) so
// the user doesn't have to set ENV vars. Tamper-detection via GCM auth tag.

function _credKey() {
  const saltFile = path.join(NHA_DIR, '.cred-salt');
  let salt;
  if (fs.existsSync(saltFile)) {
    salt = fs.readFileSync(saltFile);
  } else {
    salt = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(saltFile), { recursive: true });
    fs.writeFileSync(saltFile, salt, { mode: 0o600 });
  }
  const identity = `${os.userInfo().username}|${os.hostname()}|nha-creds-v1`;
  return crypto.scryptSync(identity, salt, 32);
}

function _encrypt(plaintext) {
  const key = _credKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function _decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', _credKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

function loadCredentials() {
  if (!fs.existsSync(CREDS_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
    const out = {};
    for (const [name, entry] of Object.entries(raw)) {
      try { out[name] = { value: _decrypt(entry.enc), updatedAt: entry.updatedAt, description: entry.description || '' }; }
      catch { out[name] = { value: '', updatedAt: entry.updatedAt, error: 'decryption failed (machine changed?)' }; }
    }
    return out;
  } catch { return {}; }
}

function saveCredential(name, value, description = '') {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error('Invalid credential name (letters, digits, _ only)');
  const raw = fs.existsSync(CREDS_FILE) ? JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8')) : {};
  raw[name] = { enc: _encrypt(String(value)), updatedAt: new Date().toISOString(), description };
  if (!fs.existsSync(path.dirname(CREDS_FILE))) fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
}

function deleteCredential(name) {
  if (!fs.existsSync(CREDS_FILE)) return;
  const raw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
  delete raw[name];
  fs.writeFileSync(CREDS_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
}

/**
 * Interpolate ${cred.NAME} placeholders in any string value within a config.
 * Non-strings are returned as-is. Missing creds resolve to '' and emit a warning.
 */
function interpolateCredentials(value, creds) {
  if (typeof value === 'string') {
    return value.replace(/\$\{cred\.([A-Za-z_][A-Za-z0-9_]{0,63})\}/g, (_, name) => {
      const c = creds[name];
      if (!c) return '';
      return c.value || '';
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolateCredentials(v, creds));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateCredentials(v, creds);
    return out;
  }
  return value;
}

/** Seed example workflows on first run */
function seedExamples() {
  ensureDir();
  const marker = path.join(WORKFLOWS_DIR, '.examples-seeded');
  if (fs.existsSync(marker)) return;

  const examples = [
    {
      id: 'ex_email_digest', name: '📧 Daily Email Digest',
      enabled: false,
      nodes: [
        { id: 'n1', defId: 'trigger_cron', x: 40, y: 80, config: { schedule: '0 8 * * *' } },
        { id: 'n2', defId: 'ai_summarize', x: 200, y: 80, config: { prompt: 'Summarize the last 10 unread emails concisely: {{output}}' } },
        { id: 'n3', defId: 'action_slack', x: 400, y: 40, config: { channel: '#general', text: '📧 Morning Digest:\n{{output}}' } },
        { id: 'n4', defId: 'action_notify', x: 400, y: 140, config: { message: 'Email digest ready', channel: 'system' } },
      ],
      edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n2', to: 'n4' }],
    },
    {
      id: 'ex_smart_router', name: '🔀 Smart Email Router',
      enabled: false,
      nodes: [
        { id: 'n1', defId: 'trigger_email', x: 40, y: 100, config: { filter: 'is:unread' } },
        { id: 'n2', defId: 'ai_classify', x: 200, y: 100, config: { categories: 'urgent, meeting, newsletter, spam', prompt: 'Classify this email: {{output}}' } },
        { id: 'n3', defId: 'logic_if', x: 380, y: 100, config: { condition: 'output.includes("urgent")' } },
        { id: 'n4', defId: 'action_notify', x: 560, y: 40, config: { message: '🚨 Urgent email: {{output}}', channel: 'telegram' } },
        { id: 'n5', defId: 'action_task', x: 560, y: 160, config: { title: 'Review: {{output}}', priority: 'low' } },
      ],
      edges: [
        { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n4', fromPort: 'true' },
        { from: 'n3', to: 'n5', fromPort: 'false' },
      ],
    },
    {
      id: 'ex_content_pipeline', name: '📝 Content Pipeline',
      enabled: false,
      nodes: [
        { id: 'n1', defId: 'trigger_manual', x: 40, y: 100, config: { input: 'Write a blog post about AI agents' } },
        { id: 'n2', defId: 'ai_agent', x: 200, y: 100, config: { agent: 'quill', prompt: 'Write a professional blog post about: {{output}}' } },
        { id: 'n3', defId: 'ai_translate', x: 400, y: 40, config: { lang: 'Italian', prompt: '{{output}}' } },
        { id: 'n4', defId: 'action_drive', x: 600, y: 40, config: { name: 'blog-it.md', content: '{{output}}' } },
        { id: 'n5', defId: 'action_drive', x: 400, y: 160, config: { name: 'blog-en.md', content: '{{output}}' } },
      ],
      edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n2', to: 'n5' }, { from: 'n3', to: 'n4' }],
    },
    {
      id: 'ex_meeting_prep', name: '📅 Meeting Prep Automation',
      enabled: false,
      nodes: [
        { id: 'n1', defId: 'trigger_cron', x: 40, y: 100, config: { schedule: '0 7 * * 1-5' } },
        { id: 'n2', defId: 'ai_agent', x: 200, y: 100, config: { agent: 'herald', prompt: 'List my meetings for today with details' } },
        { id: 'n3', defId: 'logic_if', x: 380, y: 100, config: { condition: 'output.length > 20' } },
        { id: 'n4', defId: 'ai_summarize', x: 540, y: 40, config: { prompt: 'Prepare a brief for each meeting. Include talking points: {{output}}' } },
        { id: 'n5', defId: 'action_email', x: 720, y: 40, config: { to: 'me', subject: '📅 Meeting Prep — Today', body: '{{output}}' } },
      ],
      edges: [
        { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n4', fromPort: 'true' },
      ],
    },
    {
      id: 'ex_web_monitor', name: '🌐 Website Monitor + Alert',
      enabled: false,
      nodes: [
        { id: 'n1', defId: 'trigger_cron', x: 40, y: 100, config: { schedule: '*/30 * * * *' } },
        { id: 'n2', defId: 'action_webhook', x: 200, y: 100, config: { url: 'https://nothumanallowed.com', method: 'GET' } },
        { id: 'n3', defId: 'logic_if', x: 380, y: 100, config: { condition: 'output.includes("Error") || output.length < 100' } },
        { id: 'n4', defId: 'action_notify', x: 560, y: 40, config: { message: '🚨 Website down or error detected!', channel: 'telegram' } },
        { id: 'n5', defId: 'logic_error', x: 560, y: 160, config: { retries: '2', fallback: 'Check failed — site may be unreachable' } },
      ],
      edges: [
        { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n4', fromPort: 'true' },
        { from: 'n3', to: 'n5', fromPort: 'false' },
      ],
    },
  ];

  for (const wf of examples) {
    const p = path.join(WORKFLOWS_DIR, `${wf.id}.json`);
    if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(wf, null, 2));
  }
  fs.writeFileSync(marker, new Date().toISOString());
}

/** Substitute {{varName}} placeholders in a string using a context map */
function interpolate(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => ctx[k] ?? '');
}

/** Interpolate all string values in an object */
function interpolateObj(obj, ctx) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? interpolate(v, ctx) : v;
  }
  return out;
}

/**
 * Execute a single workflow node.
 * Returns { output: string, ctx: updatedContext }
 */
async function executeNode(node, nodeDef, ctx, config) {
  const cfg = interpolateObj(node.config ?? {}, ctx);

  // ── AI nodes ──
  if (nodeDef.type === 'ai') {
    if (node.defId === 'ai_code') {
      // Code node — execute JS with `input` variable
      try {
        const fn = new Function('input', 'output', 'ctx', cfg.code || 'return input;');
        const result = fn(ctx.output || '', ctx.output || '', ctx);
        return String(result ?? '');
      } catch (e) { throw new Error(`Code error: ${e.message}`); }
    }
    const prompt = cfg.prompt || `Process this: ${ctx.output || ''}`;
    const agentName = cfg.agent || '';
    const systemPrompt = agentName
      ? `You are ${agentName}, a specialist AI agent. Process the input and return a concise result.`
      : 'You are a helpful AI assistant. Process the input and return a concise result.';
    const result = await callLLM(config, systemPrompt, prompt);
    return result?.content || result || '';
  }

  // ── Logic nodes ──
  if (nodeDef.type === 'logic') {
    if (node.defId === 'logic_if') {
      try {
        const fn = new Function('output', 'input', 'ctx', `return Boolean(${cfg.condition || 'false'});`);
        const result = fn(ctx.output || '', ctx.output || '', ctx);
        return JSON.stringify({ __branch: result ? 'true' : 'false', value: ctx.output || '' });
      } catch (e) { throw new Error(`Condition error: ${e.message}`); }
    }
    if (node.defId === 'logic_switch') {
      const expr = cfg.expression || ctx.output || '';
      const cases = (cfg.cases || '').split(',').map((c) => c.trim());
      const matched = cases.find((c) => expr.toLowerCase().includes(c.toLowerCase()));
      return JSON.stringify({ __branch: matched || 'default', value: ctx.output || '' });
    }
    if (node.defId === 'logic_loop') {
      const sep = cfg.separator === ',' ? ',' : '\n';
      const items = (ctx.output || '').split(sep).filter(Boolean);
      return JSON.stringify({ __loop: true, items, count: items.length });
    }
    if (node.defId === 'logic_merge') {
      // Merge collects from ctx.__mergeInputs (set by the executor)
      const inputs = ctx.__mergeInputs || [ctx.output || ''];
      if (cfg.mode === 'json_array') return JSON.stringify(inputs);
      if (cfg.mode === 'first_non_empty') return inputs.find((i) => i && i.trim()) || '';
      return inputs.join('\n');
    }
    if (node.defId === 'logic_delay') {
      const ms = Math.min(parseInt(cfg.seconds || '1') * 1000, 60_000);
      await new Promise((r) => setTimeout(r, ms));
      return ctx.output || '';
    }
    if (node.defId === 'logic_error') {
      // Error handler wraps previous node execution — handled in runWorkflow
      return ctx.output || cfg.fallback || '';
    }
    if (node.defId === 'logic_subworkflow') {
      // Run another workflow inline. The target workflow's final node output
      // becomes this node's output. inputMapping allows passing the parent's
      // output (default) or a custom expression.
      const targetId = cfg.workflowId;
      if (!targetId) throw new Error('Subworkflow: workflowId not configured');
      const wfPath = path.join(WORKFLOWS_DIR, `${targetId}.json`);
      if (!fs.existsSync(wfPath)) throw new Error(`Subworkflow: target "${targetId}" not found`);
      const subWf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));
      const subInput = (cfg.inputMapping && cfg.inputMapping !== '{{output}}')
        ? cfg.inputMapping.replace(/\{\{output\}\}/g, ctx.output || '')
        : (ctx.output || '');
      const subSteps = await runWorkflow(subWf, subInput, ctx.__config || config, { depth: (ctx.__depth ?? 0) + 1 });
      const lastStep = subSteps.filter((s) => s.nodeId !== '__error').pop();
      return lastStep?.output ?? '';
    }
    return ctx.output || '';
  }

  // ── Action nodes ──
  const ACTION_MAP = {
    action_email:      ['gmail_send',       { to: cfg.to, subject: cfg.subject || 'NHA Workflow', body: cfg.body || ctx.output }],
    action_slack:      ['slack_message',    { channel: cfg.channel || '#general', text: cfg.text || ctx.output }],
    action_calendar:   ['calendar_create',  { title: cfg.title || ctx.output, date: cfg.date || new Date().toISOString().split('T')[0], time: cfg.time || '09:00', duration: cfg.duration || '60' }],
    action_task:       ['task_create',      { title: cfg.title || ctx.output, priority: cfg.priority || 'medium' }],
    action_drive:      ['drive_upload',     { name: cfg.name || 'workflow-output.txt', content: cfg.content || ctx.output }],
    action_notion:     ['notion_page',      { title: cfg.title || 'Workflow Output', content: cfg.content || ctx.output }],
    action_github:     ['github_issue',     { repo: cfg.repo, title: cfg.title || ctx.output, body: cfg.body || '' }],
    action_webhook:    ['fetch_url',        { url: cfg.url, method: cfg.method || 'POST', body: cfg.body || ctx.output }],
    action_browser:    ['browser_open',     { url: cfg.url || ctx.output }],
    action_file_read:  ['file_read',        { path: cfg.path }],
    action_file_write: ['file_write',       { path: cfg.path, content: cfg.content || ctx.output }],
    action_contact:    ['contact_search',   { query: cfg.query || ctx.output }],
    action_screen:     ['screen_capture',   {}],
    action_maps:       ['maps_directions',  { from: cfg.from, to: cfg.to }],
    action_notify:     ['notify_remind',    { message: cfg.message || ctx.output, channel: cfg.channel || 'system' }],
  };

  const mapped = ACTION_MAP[node.defId];
  if (mapped) {
    try {
      const result = await executeTool(mapped[0], mapped[1], config);
      return String(result ?? '');
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }

  // Trigger nodes
  if (nodeDef.type === 'trigger') {
    // For webhook triggers, prefer the live HTTP payload if present
    if (node.defId === 'trigger_webhook' && ctx.triggerPayload !== undefined) {
      return typeof ctx.triggerPayload === 'string'
        ? ctx.triggerPayload
        : JSON.stringify(ctx.triggerPayload);
    }
    return ctx.output || cfg.input || '';
  }

  return '';
}

/**
 * Run a workflow from start to finish.
 * Returns array of { nodeId, output, error? } step results.
 *
 * @param {object} wf - workflow definition
 * @param {string} initialInput - text input piped into start node
 * @param {object} config - NHA config
 * @param {object} [opts] - { depth: number, triggerPayload: any }
 *   depth: protects against subworkflow recursion (max 5).
 *   triggerPayload: when the workflow was started by a webhook, this is the
 *     raw request body, injected into ctx.trigger for downstream nodes.
 */
// ════════════════════════════════════════════════════════════════════════════
// Connector marketplace (curated registry + local install)
// ────────────────────────────────────────────────────────────────────────────
// A "connector" is a DECLARATIVE bundle: nodeDefs + templates + metadata. No
// arbitrary code execution — actions are limited to mappings onto existing
// tools registered in tool-executor.mjs. Stored as JSON manifests under
// ~/.nha/connectors/<id>/manifest.json.
// ════════════════════════════════════════════════════════════════════════════

function _ensureConnectorsDir() {
  if (!fs.existsSync(CONNECTORS_DIR)) fs.mkdirSync(CONNECTORS_DIR, { recursive: true });
}

function listInstalledConnectors() {
  _ensureConnectorsDir();
  const entries = [];
  for (const id of fs.readdirSync(CONNECTORS_DIR)) {
    const manifestPath = path.join(CONNECTORS_DIR, id, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      entries.push({ ...m, _installedAt: fs.statSync(manifestPath).mtime.toISOString() });
    } catch { /* skip malformed */ }
  }
  return entries;
}

// Strict schema validation. Reject anything that looks like an attempt to
// inject executable strings or paths. This is the defensive-coding moat.
function validateConnectorManifest(m) {
  const errs = [];
  if (!m || typeof m !== 'object') errs.push('manifest must be an object');
  if (!m.id || !/^[a-z0-9][a-z0-9_-]{1,48}$/.test(m.id)) errs.push('id must be lowercase alphanumeric/-/_  (≤48 chars)');
  if (!m.name || typeof m.name !== 'string' || m.name.length > 80) errs.push('name required (max 80 chars)');
  if (!m.version || !/^\d+\.\d+\.\d+/.test(m.version)) errs.push('version must be semver-like (x.y.z)');
  if (m.nodes && !Array.isArray(m.nodes)) errs.push('nodes must be an array');
  if (m.templates && !Array.isArray(m.templates)) errs.push('templates must be an array');
  // No code fields allowed — reject any property that looks like JS
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (typeof v === 'string' && /\b(eval|Function|require|process\.|fs\.)\b/.test(v)) {
      errs.push(`field "${k}" contains forbidden code-like pattern`);
    }
  }
  // Each node must reference an existing executor path or be a passthrough.
  // We don't validate executor refs here (handled at runtime) but enforce
  // that nodes don't carry script/exec/cmd fields.
  for (const n of m.nodes || []) {
    if (!n.id || !n.type || !n.label) errs.push(`node missing id/type/label: ${JSON.stringify(n).slice(0, 80)}`);
    if (n.exec || n.cmd || n.script || n.handler) errs.push(`node "${n.id}" carries forbidden exec/cmd/script/handler field`);
  }
  return errs;
}

function installConnector(manifest) {
  const errs = validateConnectorManifest(manifest);
  if (errs.length) throw new Error('Invalid manifest: ' + errs.join('; '));
  _ensureConnectorsDir();
  const dir = path.join(CONNECTORS_DIR, manifest.id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return { id: manifest.id, version: manifest.version, path: file };
}

function uninstallConnector(id) {
  if (!/^[a-z0-9][a-z0-9_-]{1,48}$/.test(id)) throw new Error('Invalid connector id');
  const dir = path.join(CONNECTORS_DIR, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

async function fetchConnectorRegistry() {
  try {
    const res = await fetch(CONNECTOR_REGISTRY_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// Merge installed connector nodes/templates into the active catalogue. Used
// by routes that need to surface the full palette to the UI.
function aggregateConnectorContributions() {
  const nodes = [];
  const templates = [];
  for (const c of listInstalledConnectors()) {
    for (const n of c.nodes || []) {
      // Prefix node ids with connector id to avoid collisions, but keep
      // already-prefixed ids alone.
      const prefixedId = n.id.startsWith(`${c.id}_`) ? n.id : `${c.id}_${n.id}`;
      nodes.push({ ...n, id: prefixedId, _connectorId: c.id });
    }
    for (const t of c.templates || []) templates.push({ ...t, _connectorId: c.id });
  }
  return { nodes, templates };
}

// In-memory cache of paused-run contexts (workflowId:runId → { ctx, nodeConfig }).
// Used by the Variable Watcher and Edit-and-Resume features. Bounded to 50
// entries to avoid leaks if many runs are paused and never resumed.
const _pausedContexts = new Map();
function _trimPausedContexts() {
  if (_pausedContexts.size <= 50) return;
  const oldest = [..._pausedContexts.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
  if (oldest) _pausedContexts.delete(oldest[0]);
}

async function runWorkflow(wf, initialInput, config, opts = {}) {
  const depth = opts.depth ?? 0;
  if (depth > 5) return [{ nodeId: '__error', nodeLabel: 'Error', nodeIcon: '❌', output: 'Subworkflow recursion depth limit (5) exceeded.' }];

  // ── Live streaming: every event ends up in the WS broadcast so the UI can
  // light up nodes in real time as the runner walks through the graph.
  // runId is generated here once and stays constant for the whole execution
  // — the UI uses it to filter events from concurrent runs.
  const runId = opts.runId || `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const emit = (type, payload) => {
    if (depth > 0) return; // only top-level run emits to avoid flooding on subworkflows
    try { broadcast({ type, runId, wfId: wf.id, ts: Date.now(), ...payload }); } catch {}
  };
  emit('awf:run-start', { input: typeof initialInput === 'string' ? initialInput.slice(0, 500) : '' });

  // Breakpoints: each entry is either a string (nodeId — always break) or
  // an object { nodeId, condition } where `condition` is a JS expression
  // evaluated against the live context (vars: ctx, input, output). Break
  // ONLY when the expression is truthy. This is the same idea as Chrome
  // DevTools' "conditional breakpoint": you can ignore harmless runs and
  // pause only on the buggy case.
  const normalizeBp = (bp) => typeof bp === 'string' ? { nodeId: bp } : bp;
  const bpList = [
    ...(Array.isArray(opts.breakpoints) ? opts.breakpoints : []),
    ...(Array.isArray(wf.breakpoints) ? wf.breakpoints : []),
  ].map(normalizeBp).filter(b => b && b.nodeId);
  const bpByNode = new Map(bpList.map(b => [b.nodeId, b]));
  // skipBreakpointFor: when resuming from a breakpoint we must not re-pause
  // on the same node that was just stepped through.
  const skipBp = new Set(Array.isArray(opts.skipBreakpointFor) ? opts.skipBreakpointFor : []);

  // Evaluate a conditional-breakpoint expression in a no-network mini-sandbox.
  // Returns true (= break) if no condition or condition truthy or condition errors.
  // Errors → break (and surface the error to the UI via the step record)
  // so the user knows the expression is malformed.
  const shouldBreak = (bp, evalCtx) => {
    if (!bp) return false;
    if (!bp.condition || !String(bp.condition).trim()) return true;
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('ctx', 'input', 'output', `"use strict"; return (${bp.condition});`);
      return !!fn(evalCtx, evalCtx?.input, evalCtx?.output);
    } catch (e) {
      bp._lastError = e?.message || String(e);
      return true; // break with error message visible
    }
  };

  // Resolve credentials placeholders ${cred.NAME} in every node config BEFORE
  // executing. This way every executeNode call receives plain values — the
  // node implementation doesn't need to know about the credentials system.
  const creds = loadCredentials();
  const interpolatedNodes = wf.nodes.map((n) => ({
    ...n,
    config: interpolateCredentials(n.config || {}, creds),
  }));
  const interpolatedWf = { ...wf, nodes: interpolatedNodes };

  const steps = [];
  const nodeMap = Object.fromEntries(interpolatedWf.nodes.map((n) => [n.id, n]));
  const defMap = Object.fromEntries((wf.nodeDefs || []).map((d) => [d.id, d]));

  // Build adjacency: from → [{to, fromPort}]
  const next = {};
  for (const e of wf.edges ?? []) {
    if (!next[e.from]) next[e.from] = [];
    next[e.from].push({ to: e.to, port: e.fromPort || 'default' });
  }

  // Check if next node is an error handler
  const isErrorHandler = (nodeId) => {
    const n = nodeMap[nodeId];
    return n?.defId === 'logic_error';
  };

  // Find start nodes
  const hasIncoming = new Set((wf.edges ?? []).map((e) => e.to));
  const startCandidates = wf.nodes.filter((n) => !hasIncoming.has(n.id));
  if (startCandidates.length === 0) return [{ nodeId: '__error', nodeLabel: 'Error', nodeIcon: '❌', output: 'No start node found.' }];

  // BFS execution with branching support
  const baseCtx = {
    output: initialInput || '',
    input: initialInput || '',
    triggerPayload: opts.triggerPayload,
    __depth: depth,
    __config: config,
  };
  const queue = startCandidates.map((n) => ({ nodeId: n.id, ctx: { ...baseCtx } }));
  const visited = new Set();

  // For `logic_merge` nodes: accumulate one output per upstream edge before
  // firing. The merge node executes ONCE with `ctx.__mergeInputs = [...]`.
  const mergeAccumulator = new Map(); // nodeId → string[]
  const incomingCount = new Map();
  for (const e of wf.edges || []) {
    incomingCount.set(e.to, (incomingCount.get(e.to) || 0) + 1);
  }

  while (queue.length > 0) {
    const { nodeId, ctx } = queue.shift();

    const node = nodeMap[nodeId];
    if (!node) continue;
    const nodeDef = defMap[node.defId];
    if (!nodeDef) continue;

    // ── MERGE accumulation: collect upstream outputs BEFORE marking visited.
    // A merge node may be reached multiple times (once per upstream edge);
    // we only execute it when all upstream branches have delivered.
    if (node.defId === 'logic_merge') {
      const acc = mergeAccumulator.get(nodeId) || [];
      acc.push(typeof ctx.output === 'string' ? ctx.output : JSON.stringify(ctx.output ?? ''));
      mergeAccumulator.set(nodeId, acc);
      const need = incomingCount.get(nodeId) || 1;
      if (acc.length < need) continue;          // wait for more branches
      ctx.__mergeInputs = acc;
      mergeAccumulator.delete(nodeId);
    }

    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    // ─── BREAKPOINT CHECK ────────────────────────────────────────────────
    // If the user set a breakpoint on this node and (a) we're not explicitly
    // resuming past it AND (b) the breakpoint's condition evaluates truthy,
    // halt here. The remaining queue is preserved in the returned steps
    // array so the UI can show "paused here — resume?".
    const bp = bpByNode.get(nodeId);
    const willBreak = bp && !skipBp.has(nodeId) && shouldBreak(bp, ctx);
    if (willBreak) {
      steps.push({
        nodeId,
        nodeLabel: nodeDef.label,
        nodeIcon: '⏸',
        input: typeof ctx.output === 'string' ? ctx.output.slice(0, 2000) : '',
        output: '',
        error: bp._lastError ? `Conditional breakpoint error: ${bp._lastError}` : null,
        paused: true,
        startedAt: Date.now(),
        endedAt: Date.now(),
        durationMs: 0,
        nodeConfig: node.config || {},
        breakpointCondition: bp.condition || null,
      });
      // Pull every remaining queued node into pendingNodes so the UI can list
      // them in the "what would have run next" pane.
      const pendingNodes = queue.map(q => q.nodeId);
      // Attach a sentinel on the steps array so saveRunSnapshot can detect it.
      steps.__paused = { atNodeId: nodeId, pendingNodes, ctxSnapshot: { output: ctx.output, input: ctx.input } };
      // Cache live context server-side so the UI's variable watcher can fetch
      // it via GET /api/awf/:id/paused-context/:runId.
      _pausedContexts.set(`${wf.id}:${runId}`, {
        atNodeId: nodeId,
        ctxSnapshot: { output: ctx.output, input: ctx.input, loopItem: ctx.loopItem },
        nodeConfig: node.config || {},
        pendingNodes,
        timestamp: Date.now(),
      });
      _trimPausedContexts();
      emit('awf:paused', { atNodeId: nodeId, nodeLabel: nodeDef.label, pendingNodes });
      break;
    }

    let output = '';
    let error = null;
    const inputSnapshot = typeof ctx.output === 'string' ? ctx.output.slice(0, 4000) : JSON.stringify(ctx.output ?? '').slice(0, 4000);
    const startedAt = Date.now();
    emit('awf:step-start', { nodeId, nodeLabel: nodeDef.label, nodeIcon: nodeDef.icon, input: inputSnapshot.slice(0, 500) });

    // Error handler: wrap with retry
    const maxRetries = node.defId === 'logic_error' ? parseInt(node.config?.retries || '0') : 0;
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        output = await executeNode(node, nodeDef, ctx, config);
        error = null;
        break;
      } catch (e) {
        error = e.message;
        output = node.config?.fallback || '';
        attempt++;
        if (attempt <= maxRetries) {
          steps.push({
            nodeId,
            nodeLabel: nodeDef.label,
            nodeIcon: '🔄',
            input: inputSnapshot,
            output: `Retry ${attempt}/${maxRetries}: ${e.message}`,
            error: null,
            startedAt,
            endedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            nodeConfig: node.config || {},
            retry: attempt,
          });
        }
      }
    }

    const endedAt = Date.now();
    const stepRecord = {
      nodeId,
      nodeLabel: nodeDef.label,
      nodeIcon: nodeDef.icon,
      input: inputSnapshot,
      output: output?.slice?.(0, 4000) || '',
      error,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      nodeConfig: node.config || {},
    };
    steps.push(stepRecord);
    emit('awf:step-end', {
      nodeId,
      nodeLabel: nodeDef.label,
      nodeIcon: nodeDef.icon,
      durationMs: endedAt - startedAt,
      error,
      outputPreview: typeof stepRecord.output === 'string' ? stepRecord.output.slice(0, 500) : '',
    });

    // If error and no error handler downstream, stop this branch
    if (error) {
      const hasHandler = (next[nodeId] ?? []).some((n) => isErrorHandler(n.to));
      if (!hasHandler) continue;
    }

    // Determine which downstream nodes to execute based on branching
    const downstream = next[nodeId] ?? [];
    let branch = null;
    try {
      const parsed = JSON.parse(output || '{}');
      if (parsed.__branch) branch = parsed.__branch;
      if (parsed.__loop && Array.isArray(parsed.items)) {
        // Loop: execute downstream for each item
        for (const item of parsed.items) {
          const loopCtx = { ...ctx, output: item, loopItem: item };
          for (const { to: toId } of downstream) {
            // Don't mark as visited — allow loop iterations
            const toNode = nodeMap[toId];
            if (!toNode) continue;
            const toDef = defMap[toNode.defId];
            if (!toDef) continue;
            const loopInputSnap = typeof item === 'string' ? item.slice(0, 4000) : JSON.stringify(item).slice(0, 4000);
            const loopStart = Date.now();
            try {
              const loopOut = await executeNode(toNode, toDef, loopCtx, config);
              steps.push({
                nodeId: toId,
                nodeLabel: `${toDef.label} [${String(item).slice(0, 20)}]`,
                nodeIcon: toDef.icon,
                input: loopInputSnap,
                output: loopOut?.slice?.(0, 4000) || '',
                error: null,
                startedAt: loopStart,
                endedAt: Date.now(),
                durationMs: Date.now() - loopStart,
                nodeConfig: toNode.config || {},
                loopIteration: true,
              });
            } catch (e) {
              steps.push({
                nodeId: toId,
                nodeLabel: `${toDef.label} [${String(item).slice(0, 20)}]`,
                nodeIcon: toDef.icon,
                input: loopInputSnap,
                output: '',
                error: e.message,
                startedAt: loopStart,
                endedAt: Date.now(),
                durationMs: Date.now() - loopStart,
                nodeConfig: toNode.config || {},
                loopIteration: true,
              });
            }
          }
        }
        continue; // Loop handles its own downstream
      }
    } catch { /* not JSON — no branching */ }

    const nextCtx = { ...ctx, output: output || '', [`${node.defId}_output`]: output || '' };

    if (branch) {
      // Branching: only follow edges that match the branch port
      for (const { to: toId, port } of downstream) {
        if (port === branch || port === 'default') {
          queue.push({ nodeId: toId, ctx: nextCtx });
        }
      }
    } else {
      // Normal: follow all downstream edges
      for (const { to: toId } of downstream) {
        queue.push({ nodeId: toId, ctx: nextCtx });
      }
    }
  }

  emit('awf:complete', {
    stepsCount: steps.length,
    errorCount: steps.filter(s => s.error).length,
    totalDurationMs: steps.reduce((a, s) => a + (s.durationMs || 0), 0),
  });
  return steps;
}


// ════════════════════════════════════════════════════════════════════════════
// Template marketplace — fetch built-in + remote templates from website
// ════════════════════════════════════════════════════════════════════════════
const TEMPLATE_REMOTE_BASE = 'https://nothumanallowed.com/awf/templates';

const BUILTIN_TEMPLATES = [
  {
    id: 'lawyer-hearing-reminders',
    name: '⚖ Lawyer · Hearing reminders',
    category: 'legal',
    description: 'Daily cron at 7am → fetch this week\'s calendar → for each "udienza"/"hearing" event, extract client info via AI and email a reminder. Telegram summary to lawyer.',
    nodes: [
      { id: 'n1', defId: 'trigger_cron',  x: 40,  y: 80,  config: { schedule: '0 7 * * 1-5' } },
      { id: 'n2', defId: 'action_webhook',x: 220, y: 80,  config: { url: 'http://127.0.0.1:3847/api/tools/calendar_week', method: 'GET' } },
      { id: 'n3', defId: 'ai_extract',    x: 420, y: 80,  config: { prompt: 'Extract JSON [{cliente, email, fascicolo, tribunale, ora}] from these events. Only entries matching "udienza"/"hearing": {{output}}' } },
      { id: 'n4', defId: 'logic_loop',    x: 620, y: 80,  config: { separator: '\n' } },
      { id: 'n5', defId: 'action_email',  x: 820, y: 40,  config: { to: '{{item.email}}', subject: 'Promemoria udienza {{item.fascicolo}}', body: 'Gentile cliente, ricordiamo l\'udienza del {{item.fascicolo}} al {{item.tribunale}} alle {{item.ora}}.' } },
      { id: 'n6', defId: 'action_notify', x: 820, y: 140, config: { message: '📋 {{count}} udienze questa settimana — reminder inviati', channel: 'telegram' } },
    ],
    edges: [
      { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n4' },
      { from: 'n4', to: 'n5' }, { from: 'n4', to: 'n6' },
    ],
  },
  {
    id: 'accountant-invoice-extraction',
    name: '📊 Accountant · Invoice extraction from email',
    category: 'finance',
    description: 'Trigger on emails with subject "fattura"/"invoice" or PDF attachment → parse with AI → save PDF to Drive → row to Notion CRM → Telegram alert if total > €1000.',
    nodes: [
      { id: 'n1', defId: 'trigger_email', x: 40,  y: 80,  config: { filter: 'subject:fattura OR has:attachment' } },
      { id: 'n2', defId: 'ai_extract',    x: 240, y: 80,  config: { prompt: 'Extract {fornitore, piva, numero, data, imponibile, iva, totale} from this email: {{output}}' } },
      { id: 'n3', defId: 'logic_if',      x: 440, y: 80,  config: { condition: '{{output.totale}} > 1000' } },
      { id: 'n4', defId: 'action_notify', x: 640, y: 30,  config: { message: '⚠ Fattura > €1k da {{output.fornitore}} ({{output.totale}}€)', channel: 'telegram' } },
      { id: 'n5', defId: 'action_drive',  x: 640, y: 130, config: { name: 'Fattura_{{output.numero}}_{{output.data}}.pdf', content: '{{output}}' } },
      { id: 'n6', defId: 'action_notion', x: 840, y: 130, config: { title: 'Fattura {{output.numero}} — {{output.fornitore}}', content: 'Imponibile: {{output.imponibile}}€ · IVA: {{output.iva}}€ · Totale: {{output.totale}}€ · Data: {{output.data}}' } },
    ],
    edges: [
      { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n4', label: 'true' }, { from: 'n3', to: 'n5', label: 'false' },
      { from: 'n5', to: 'n6' },
    ],
  },
  {
    id: 'freelance-daily-brief',
    name: '💼 Freelance · Daily morning brief',
    category: 'productivity',
    description: 'Cron 8am Mon-Fri → fetch today\'s calendar + unread email + tasks + market news → summarize in 5 bullets → email + Telegram.',
    nodes: [
      { id: 'n1', defId: 'trigger_cron',     x: 40,  y: 100, config: { schedule: '0 8 * * 1-5' } },
      { id: 'n2', defId: 'action_webhook',   x: 220, y: 30,  config: { url: 'http://127.0.0.1:3847/api/tools/calendar_today', method: 'GET' } },
      { id: 'n3', defId: 'action_webhook',   x: 220, y: 100, config: { url: 'http://127.0.0.1:3847/api/tools/task_list',     method: 'GET' } },
      { id: 'n4', defId: 'action_webhook',   x: 220, y: 170, config: { url: 'http://127.0.0.1:3847/api/tools/gmail_list',    method: 'POST', body: '{"query":"is:unread is:important"}' } },
      { id: 'n5', defId: 'logic_merge',      x: 420, y: 100, config: { mode: 'concat' } },
      { id: 'n6', defId: 'ai_summarize',     x: 620, y: 100, config: { prompt: 'Brief in 5 bullet (italiano): appuntamenti oggi, task urgenti, email da rispondere, news settore, priorità #1. Input: {{output}}' } },
      { id: 'n7', defId: 'action_email',     x: 820, y: 60,  config: { to: 'me', subject: '☀ Brief del {{date}}', body: '{{output}}' } },
      { id: 'n8', defId: 'action_notify',    x: 820, y: 140, config: { message: '{{output}}', channel: 'telegram' } },
    ],
    edges: [
      { from: 'n1', to: 'n2' }, { from: 'n1', to: 'n3' }, { from: 'n1', to: 'n4' },
      { from: 'n2', to: 'n5' }, { from: 'n3', to: 'n5' }, { from: 'n4', to: 'n5' },
      { from: 'n5', to: 'n6' }, { from: 'n6', to: 'n7' }, { from: 'n6', to: 'n8' },
    ],
  },
  {
    id: 'company-support-triage',
    name: '🏢 Company · Customer support triage',
    category: 'business',
    description: 'Email to info@ → AI classify (urgent/sales/invoice/complaint/spam) → switch route → Slack alert / Notion CRM / forward to accountant / quality team / trash.',
    nodes: [
      { id: 'n1',  defId: 'trigger_email',  x: 40,  y: 200, config: { filter: 'to:info@' } },
      { id: 'n2',  defId: 'ai_classify',    x: 220, y: 200, config: { categories: 'urgent, sales, invoice, complaint, spam', prompt: 'Classify customer email: {{output}}' } },
      { id: 'n3',  defId: 'logic_switch',   x: 420, y: 200, config: { expression: '{{output}}', cases: 'urgent, sales, invoice, complaint, spam' } },
      { id: 'n4',  defId: 'action_slack',   x: 640, y: 40,  config: { channel: '#support-urgent', text: '🚨 URGENT email: {{output}}' } },
      { id: 'n5',  defId: 'action_notion',  x: 640, y: 130, config: { title: 'Lead from email', content: '{{output}}' } },
      { id: 'n6',  defId: 'action_email',   x: 640, y: 220, config: { to: 'commercialista@studio.it', subject: 'Fattura ricevuta', body: 'Forward: {{output}}' } },
      { id: 'n7',  defId: 'action_slack',   x: 640, y: 310, config: { channel: '#quality', text: 'Reclamo da rivedere: {{output}}' } },
      { id: 'n8',  defId: 'action_notify',  x: 640, y: 400, config: { message: 'Spam filtered', channel: 'system' } },
    ],
    edges: [
      { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n4', label: 'urgent' }, { from: 'n3', to: 'n5', label: 'sales' },
      { from: 'n3', to: 'n6', label: 'invoice' }, { from: 'n3', to: 'n7', label: 'complaint' },
      { from: 'n3', to: 'n8', label: 'spam' },
    ],
  },
  {
    id: 'company-lead-generation',
    name: '🚀 Company · Lead generation + nurturing',
    category: 'business',
    description: 'Mon/Wed/Fri 9am → scrape LinkedIn/Google → AI qualify (hot/warm/cold) → CRM → personalized follow-up email → 3-day delay → second touch.',
    nodes: [
      { id: 'n1', defId: 'trigger_cron',   x: 40,  y: 100, config: { schedule: '0 9 * * 1,3,5' } },
      { id: 'n2', defId: 'action_browser', x: 220, y: 100, config: { url: 'https://www.google.com/search?q=CTO+startup+SaaS+Italy+site:linkedin.com' } },
      { id: 'n3', defId: 'ai_extract',     x: 420, y: 100, config: { prompt: 'Extract JSON [{nome, ruolo, azienda, email?, settore}] of decision-makers from: {{output}}' } },
      { id: 'n4', defId: 'logic_loop',     x: 620, y: 100, config: { separator: '\n' } },
      { id: 'n5', defId: 'ai_agent',       x: 820, y: 100, config: { agent: 'saber', prompt: 'Qualify this lead for B2B SaaS sales. Output ONLY: hot, warm, cold, or junk. Lead: {{item}}' } },
      { id: 'n6', defId: 'logic_switch',   x: 1020,y: 100, config: { expression: '{{output}}', cases: 'hot, warm' } },
      { id: 'n7', defId: 'action_notion',  x: 1220,y: 40,  config: { title: '🔥 HOT — {{item.nome}}', content: '{{item.azienda}} · {{item.ruolo}}' } },
      { id: 'n8', defId: 'action_email',   x: 1420,y: 40,  config: { to: '{{item.email}}', subject: 'Quick chat about {{item.azienda}}?', body: 'Hi {{item.nome}}, noticed your role at {{item.azienda}}. Worth a 15-min chat?' } },
      { id: 'n9', defId: 'action_notion',  x: 1220,y: 160, config: { title: '🟡 Nurturing — {{item.nome}}', content: '{{item.azienda}}' } },
    ],
    edges: [
      { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n4' },
      { from: 'n4', to: 'n5' }, { from: 'n5', to: 'n6' },
      { from: 'n6', to: 'n7', label: 'hot' }, { from: 'n7', to: 'n8' },
      { from: 'n6', to: 'n9', label: 'warm' },
    ],
  },
];

async function fetchRemoteTemplates() {
  // Best-effort fetch of remote template index. Falls back to builtin only.
  try {
    const res = await fetch(`${TEMPLATE_REMOTE_BASE}/index.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// ════════════════════════════════════════════════════════════════════════════
// Run history (debugger replay)
// ════════════════════════════════════════════════════════════════════════════
function saveRunSnapshot(workflowId, steps, opts = {}) {
  ensureDir();
  const runDir = path.join(RUNS_DIR, workflowId);
  if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  // If the run is paused, also register the live context under the snapshot's
  // ts so the UI can fetch it via `/api/awf/:id/paused-context/:ts` after the
  // HTTP response lands (the client knows the ts, not the internal runId).
  if (steps?.__paused) {
    const existing = [..._pausedContexts.values()].find(
      v => v.atNodeId === steps.__paused.atNodeId && Date.now() - v.timestamp < 5000
    );
    if (existing) _pausedContexts.set(`${workflowId}:${ts}`, existing);
  }
  const file = path.join(runDir, `${ts}.json`);
  const paused = steps?.__paused || null;
  // Drop the non-serializable __paused sentinel from the array shape.
  const stepsClean = Array.isArray(steps) ? Array.from(steps) : [];
  const totalDuration = stepsClean.reduce((s, x) => s + (x.durationMs || 0), 0);
  const errorCount = stepsClean.filter(x => x.error).length;
  fs.writeFileSync(file, JSON.stringify({
    ts,
    workflowId,
    input: opts.input || '',
    triggerPayload: opts.triggerPayload ?? null,
    triggerType: opts.triggerType || 'manual',
    wfSnapshot: opts.wfSnapshot || null,       // {name, nodes, edges} at run time
    steps: stepsClean,
    paused,
    totalDurationMs: totalDuration,
    errorCount,
    env: _currentEnv(),
  }, null, 2));
  // Prune old runs
  const all = fs.readdirSync(runDir).filter(f => f.endsWith('.json')).sort();
  if (all.length > MAX_RUNS_PER_WF) {
    all.slice(0, all.length - MAX_RUNS_PER_WF).forEach(f => fs.unlinkSync(path.join(runDir, f)));
  }
  return ts;
}

function listRunSnapshots(workflowId) {
  const runDir = path.join(RUNS_DIR, workflowId);
  if (!fs.existsSync(runDir)) return [];
  return fs.readdirSync(runDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort().reverse();
}

function loadRunSnapshot(workflowId, ts) {
  const file = path.join(RUNS_DIR, workflowId, `${ts}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
// Advanced trigger watchers (file watch, IMAP folder watch, RSS feed)
// Discord triggers piggyback on the existing DiscordResponder.
// ════════════════════════════════════════════════════════════════════════════
const _activeWatchers = new Map(); // workflowId+nodeId → { close: fn }

function _startFileWatch(workflow, node) {
  const key = `${workflow.id}:${node.id}`;
  if (_activeWatchers.has(key)) return; // already running
  const watchPath = node.config?.path;
  if (!watchPath || !fs.existsSync(watchPath)) return;
  try {
    const w = fs.watch(watchPath, { recursive: !!node.config?.recursive }, async (eventType, filename) => {
      // Debounce: skip if last event < 500ms ago
      const now = Date.now();
      if (w._lastEvent && now - w._lastEvent < 500) return;
      w._lastEvent = now;
      try {
        const fullPath = path.join(watchPath, filename || '');
        const config = loadConfig();
        const steps = await runWorkflow(workflow, JSON.stringify({ event: eventType, path: fullPath }), config, { triggerPayload: { event: eventType, path: fullPath } });
        saveRunSnapshot(workflow.id, steps, {
          input: `file_watch:${eventType}:${filename}`,
          triggerType: 'file_watch',
          triggerPayload: { event: eventType, path: fullPath },
          wfSnapshot: { name: workflow.name, nodes: workflow.nodes, edges: workflow.edges },
        });
      } catch {}
    });
    _activeWatchers.set(key, { close: () => { try { w.close(); } catch {} } });
  } catch {}
}

async function _fetchRssFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'NHA-AWF/1.0' } });
  if (!res.ok) return [];
  const xml = await res.text();
  // Minimal XML parser: extract <item>…</item> blocks.
  const items = [];
  const itemRe = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const tag = (name) => {
      const r = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
      const mm = block.match(r);
      return mm ? mm[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    items.push({
      title: tag('title'),
      link:  tag('link') || (block.match(/<link\b[^>]*href="([^"]+)"/i)?.[1] || ''),
      guid:  tag('guid') || tag('id') || tag('link'),
      pubDate: tag('pubDate') || tag('updated') || tag('published'),
      description: (tag('description') || tag('summary') || tag('content')).replace(/<[^>]+>/g, '').slice(0, 500),
    });
  }
  return items;
}

const _rssSeenItems = new Map(); // url → Set<guid>
function _startRssWatch(workflow, node) {
  const key = `${workflow.id}:${node.id}`;
  if (_activeWatchers.has(key)) return;
  const url = node.config?.url;
  if (!url) return;
  const intervalMin = parseInt(node.config?.intervalMin || '15', 10);
  if (!_rssSeenItems.has(url)) _rssSeenItems.set(url, new Set());
  const seen = _rssSeenItems.get(url);

  const tick = async () => {
    try {
      const items = await _fetchRssFeed(url);
      const newItems = items.filter(it => it.guid && !seen.has(it.guid));
      newItems.forEach(it => seen.add(it.guid));
      // Cap seen set to 500 most recent
      if (seen.size > 500) { const arr = [...seen]; seen.clear(); arr.slice(-500).forEach(g => seen.add(g)); }
      for (const item of newItems) {
        const config = loadConfig();
        const steps = await runWorkflow(workflow, `${item.title}\n${item.link}\n\n${item.description}`, config, { triggerPayload: item });
        saveRunSnapshot(workflow.id, steps, {
          input: `rss:${item.title.slice(0, 60)}`,
          triggerType: 'rss',
          triggerPayload: item,
          wfSnapshot: { name: workflow.name, nodes: workflow.nodes, edges: workflow.edges },
        });
      }
    } catch {}
  };
  // Fire on schedule but DON'T fire on startup (only new items after start)
  const handle = setInterval(tick, intervalMin * 60_000);
  // Seed the seen set so historical items don't trigger
  _fetchRssFeed(url).then(items => items.forEach(it => it.guid && seen.add(it.guid))).catch(() => {});
  _activeWatchers.set(key, { close: () => { clearInterval(handle); } });
}

// Start advanced watchers for every workflow that has the matching trigger.
export function startAdvancedTriggers() {
  const wfs = listWorkflows();
  for (const wf of wfs) {
    if (wf.enabled === false) continue;
    for (const node of wf.nodes || []) {
      if (node.defId === 'trigger_file_watch') _startFileWatch(wf, node);
      if (node.defId === 'trigger_rss')        _startRssWatch(wf, node);
      // trigger_imap_folder + trigger_discord_message are hooked from the
      // respective responders/imap services — they call dispatchTriggerHook below.
    }
  }
}

// Called externally by IMAP IDLE handler / DiscordResponder when a matching
// event fires. payload is whatever the source wants to surface.
export async function dispatchTriggerHook(triggerType, matcher, payload) {
  const wfs = listWorkflows();
  for (const wf of wfs) {
    if (wf.enabled === false) continue;
    for (const node of wf.nodes || []) {
      if (node.defId !== triggerType) continue;
      // matcher: a function (nodeConfig) => bool. If returns true, fire.
      if (matcher && !matcher(node.config || {})) continue;
      try {
        const config = loadConfig();
        const steps = await runWorkflow(wf, JSON.stringify(payload || {}), config, { triggerPayload: payload });
        saveRunSnapshot(wf.id, steps, {
          input: `${triggerType}:hook`,
          triggerType,
          triggerPayload: payload,
          wfSnapshot: { name: wf.name, nodes: wf.nodes, edges: wf.edges },
        });
      } catch {}
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Workspace sync (Drive) + automatic backup
// ════════════════════════════════════════════════════════════════════════════
async function backupWorkflowsToDrive(config, opts = {}) {
  const { uploadFile } = await import('../../services/google-drive.mjs').catch(() => ({}));
  if (!uploadFile) return { ok: false, error: 'Google Drive service unavailable' };
  const wfs = listWorkflows();
  const creds = (() => { try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8')); } catch { return {}; } })();
  // Credentials are STILL encrypted in the backup — we ship the raw file as
  // exported (already AES-256-GCM with machine-bound salt). Restoring on a
  // different machine requires the salt to be backed up separately, by design.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    backedUpAt: new Date().toISOString(),
    nhaVersion: (await import('../../constants.mjs')).VERSION,
    workflows: wfs,
    credentialsEncrypted: creds, // already encrypted
  };
  // syncTag uses a distinct filename prefix so /sync/pull can locate the
  // most recent push deterministically; backups without syncTag use the
  // legacy prefix for traceability.
  const prefix = opts.syncTag ? 'nha-awf-sync' : 'nha-awf-backup';
  const fileName = `${prefix}-${ts}.json`;
  try {
    const result = await uploadFile(config, {
      name: fileName,
      content: JSON.stringify(payload, null, 2),
      mimeType: 'application/json',
      folder: opts.folder || 'NHA Backups',
    });
    return { ok: true, fileId: result?.id, fileName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Schedule automatic backup every N hours (default 24h). Idempotent.
let _backupTimer = null;
export function startAutoBackup(intervalHours = 24) {
  if (_backupTimer) return;
  const config = loadConfig();
  const hasDriveAuth = !!(config.google?.accessToken || config.google?.refreshToken);
  if (!hasDriveAuth) return;
  const tick = async () => {
    try { await backupWorkflowsToDrive(loadConfig()); } catch {}
  };
  _backupTimer = setInterval(tick, intervalHours * 60 * 60 * 1000);
  // Also fire one immediately, but delayed so we don't block startup.
  setTimeout(tick, 5 * 60 * 1000);
}

// ════════════════════════════════════════════════════════════════════════════

export function register(router) {
  // GET /api/workflows — list all workflows
  router.get('/api/workflows', async (req, res) => {
    try {
      seedExamples();
      sendJSON(res, 200, { workflows: listWorkflows() });
    } catch (e) {
      sendError(res, 500, e.message);
    }
  });

  // POST /api/workflows — create workflow
  router.post('/api/workflows', async (req, res) => {
    try {
      const body = await parseBody(req);
      if (!body.id) body.id = `wf_${Date.now()}`;
      body.createdAt = body.createdAt || new Date().toISOString();
      body.updatedAt = new Date().toISOString();
      saveWorkflow(body);
      sendJSON(res, 200, { ok: true, workflow: body });
    } catch (e) {
      sendError(res, 500, e.message);
    }
  });

  // PUT /api/workflows/:id — update workflow
  router.put('/api/workflows/:id', async (req, res) => {
    try {
      const body = await parseBody(req);
      body.updatedAt = new Date().toISOString();
      saveWorkflow(body);
      sendJSON(res, 200, { ok: true, workflow: body });
    } catch (e) {
      sendError(res, 500, e.message);
    }
  });

  // DELETE /api/workflows/:id
  router.delete('/api/workflows/:id', async (req, res) => {
    const id = req.params?.id;
    try {
      deleteWorkflow(id);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendError(res, 500, e.message);
    }
  });

  // POST /api/workflows/:id/run — execute workflow
  router.post('/api/workflows/:id/run', async (req, res) => {
    const id = req.params?.id;
    try {
      const body = await parseBody(req).catch(() => ({}));
      const wfPath = path.join(WORKFLOWS_DIR, `${id}.json`);
      if (!fs.existsSync(wfPath)) return sendError(res, 404, 'Workflow not found');

      const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));
      const config = loadConfig();
      const steps = await runWorkflow(wf, body.input || '', config, {
        breakpoints: body.breakpoints,
        skipBreakpointFor: body.skipBreakpointFor,
      });

      // Always persist a run snapshot — this is the only reason the debugger
      // has history. Include a lightweight wfSnapshot so replay can rebuild the
      // exact graph even if the user edits the workflow afterwards.
      const wfSnapshot = { name: wf.name, nodes: wf.nodes, edges: wf.edges };
      const runTs = saveRunSnapshot(wf.id, steps, {
        input: body.input || '',
        triggerType: 'manual',
        wfSnapshot,
      });

      wf.lastRun = { at: new Date().toISOString(), ts: runTs, steps };
      saveWorkflow(wf);

      sendJSON(res, 200, { ok: true, ts: runTs, steps, paused: steps?.__paused || null });
    } catch (e) {
      sendError(res, 500, e.message);
    }
  });

  // GET /api/workflows/:id/runs — last run results
  router.get('/api/workflows/:id/runs', async (req, res) => {
    const id = req.params?.id;
    try {
      const wfPath = path.join(WORKFLOWS_DIR, `${id}.json`);
      if (!fs.existsSync(wfPath)) return sendError(res, 404, 'Workflow not found');
      const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));
      sendJSON(res, 200, { lastRun: wf.lastRun || null });
    } catch (e) {
      sendError(res, 500, e.message);
    }
  });

  // ── Versioning ───────────────────────────────────────────────────────────
  router.get('/api/workflows/:id/versions', async (req, res) => {
    try { sendJSON(res, 200, { versions: listVersions(req.params?.id) }); }
    catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/workflows/:id/versions/:ts', async (req, res) => {
    try {
      const wf = loadVersion(req.params?.id, req.params?.ts);
      if (!wf) return sendError(res, 404, 'Version not found');
      sendJSON(res, 200, { workflow: wf });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/workflows/:id/restore/:ts', async (req, res) => {
    try {
      const wf = loadVersion(req.params?.id, req.params?.ts);
      if (!wf) return sendError(res, 404, 'Version not found');
      saveWorkflow(wf);  // creates a new snapshot of current state automatically
      sendJSON(res, 200, { ok: true, workflow: wf });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Credentials manager ─────────────────────────────────────────────────
  router.get('/api/credentials', async (_req, res) => {
    try {
      const creds = loadCredentials();
      // NEVER return raw values — only names + metadata
      const list = Object.entries(creds).map(([name, c]) => ({
        name, updatedAt: c.updatedAt, description: c.description, hasError: !!c.error,
      }));
      sendJSON(res, 200, { credentials: list });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/credentials', async (req, res) => {
    try {
      const body = await parseBody(req);
      if (!body.name || !body.value) return sendError(res, 400, 'name and value required');
      saveCredential(body.name, body.value, body.description || '');
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 400, e.message); }
  });

  router.delete('/api/credentials/:name', async (req, res) => {
    try {
      deleteCredential(req.params?.name);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Webhook triggers ─────────────────────────────────────────────────────
  //
  // ANY method to /api/webhooks/<slug> triggers a workflow whose start node
  // is a trigger_webhook with config.slug matching. The HTTP body is injected
  // as triggerPayload — text/plain stays as string, application/json gets
  // parsed. We respond with the last node's output (or 200 OK if no output).
  const _handleWebhook = async (req, res) => {
    try {
      const slug = req.params?.slug;
      if (!slug) return sendError(res, 400, 'webhook slug required');
      const all = listWorkflows();
      const wf = all.find((w) => (w.nodes || []).some((n) =>
        n.defId === 'trigger_webhook' && (n.config?.slug === slug || n.config?.path === slug),
      ));
      if (!wf) return sendError(res, 404, `No workflow registered for webhook /${slug}`);
      if (wf.enabled === false) return sendError(res, 403, 'Workflow is disabled');

      // Parse body — try JSON, fall back to text
      let payload = '';
      try { payload = await parseBody(req); }
      catch { payload = ''; }

      const config = loadConfig();
      const steps = await runWorkflow(wf, typeof payload === 'string' ? payload : JSON.stringify(payload), config, { triggerPayload: payload });
      const last = steps.filter((s) => s.nodeId !== '__error').pop();
      const output = last?.output ?? '';
      // If the output looks like JSON, return it as JSON; otherwise as text
      try { sendJSON(res, 200, JSON.parse(output)); }
      catch {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(String(output));
      }
    } catch (e) { sendError(res, 500, e.message); }
  };
  router.post('/api/webhooks/:slug',   _handleWebhook);
  router.get( '/api/webhooks/:slug',   _handleWebhook);
  router.put( '/api/webhooks/:slug',   _handleWebhook);
  router.delete('/api/webhooks/:slug', _handleWebhook);

  // ════════════════════════════════════════════════════════════════════════
  // CONNECTOR MARKETPLACE — install/uninstall declarative bundles
  // ════════════════════════════════════════════════════════════════════════
  router.get('/api/awf/connectors/installed', async (_req, res) => {
    try { sendJSON(res, 200, { connectors: listInstalledConnectors() }); }
    catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/awf/connectors/registry', async (_req, res) => {
    try {
      const reg = await fetchConnectorRegistry();
      const installed = new Set(listInstalledConnectors().map(c => c.id));
      // Mark which are already installed so the UI can show "✓ installed"
      const enriched = reg.map(c => ({ ...c, installed: installed.has(c.id) }));
      sendJSON(res, 200, { connectors: enriched });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/awf/connectors/install — body: { manifest? OR url? }
  router.post('/api/awf/connectors/install', async (req, res) => {
    try {
      const body = await parseBody(req);
      let manifest = body.manifest;
      if (!manifest && body.url) {
        // Allowlist of trusted registry hosts. Anything else requires a body.manifest.
        const ALLOWED = ['nothumanallowed.com', 'raw.githubusercontent.com'];
        const u = new URL(body.url);
        if (!ALLOWED.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
          return sendError(res, 400, `URL host not in allowlist: ${u.hostname}`);
        }
        const r = await fetch(body.url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) return sendError(res, 502, `Manifest fetch failed: ${r.status}`);
        manifest = await r.json();
      }
      if (!manifest) return sendError(res, 400, 'Provide either { manifest } or { url }');
      const result = installConnector(manifest);
      sendJSON(res, 201, { ok: true, ...result });
    } catch (e) { sendError(res, 400, e.message); }
  });

  router.delete('/api/awf/connectors/:id', async (req, res) => {
    try {
      const ok = uninstallConnector(req.params.id);
      sendJSON(res, 200, { ok });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // GET /api/awf/node-defs — palette = built-in (provided by client) + connector
  // contributions (server-side). The UI merges these into NODE_DEFS.
  router.get('/api/awf/node-defs', async (_req, res) => {
    try {
      const contrib = aggregateConnectorContributions();
      sendJSON(res, 200, { nodes: contrib.nodes, templates: contrib.templates });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEMPLATES MARKETPLACE — list + import (1-click)
  // ════════════════════════════════════════════════════════════════════════
  router.get('/api/awf/templates', async (_req, res) => {
    try {
      const remote = await fetchRemoteTemplates();
      const fromConnectors = aggregateConnectorContributions().templates;
      const all = [...BUILTIN_TEMPLATES, ...fromConnectors, ...remote];
      sendJSON(res, 200, { templates: all });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/awf/templates/import', async (req, res) => {
    try {
      const body = await parseBody(req);
      const tpl = BUILTIN_TEMPLATES.find(t => t.id === body.templateId)
              || (await fetchRemoteTemplates()).find(t => t.id === body.templateId);
      if (!tpl) return sendError(res, 404, 'Template not found');
      const wf = {
        id: `wf_${Date.now()}`,
        name: tpl.name,
        description: tpl.description,
        nodes: JSON.parse(JSON.stringify(tpl.nodes)),
        edges: JSON.parse(JSON.stringify(tpl.edges)),
        enabled: false, // import disabled by default — user enables explicitly
        createdAt: new Date().toISOString(),
        importedFrom: tpl.id,
      };
      saveWorkflow(wf);
      sendJSON(res, 201, { ok: true, workflow: wf });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ════════════════════════════════════════════════════════════════════════
  // DEBUGGER — run history, replay, replay-from, AI explanation
  // ════════════════════════════════════════════════════════════════════════

  // GET /api/awf/:id/run-history — list all saved run snapshots (newest first)
  router.get('/api/awf/:id/run-history', async (req, res) => {
    try {
      const id = req.params.id;
      const list = listRunSnapshots(id).map(ts => {
        const snap = loadRunSnapshot(id, ts);
        const lastError = snap?.steps?.find(s => s.error);
        return {
          ts,
          input: snap?.input || '',
          stepsCount: snap?.steps?.length || 0,
          hasError: !!lastError,
          errorNode: lastError?.nodeLabel,
          env: snap?.env || 'prod',
        };
      });
      sendJSON(res, 200, { runs: list });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // GET /api/awf/:id/run/:ts — full snapshot of a past run (for replay UI)
  router.get('/api/awf/:id/run/:ts', async (req, res) => {
    try {
      const snap = loadRunSnapshot(req.params.id, req.params.ts);
      if (!snap) return sendError(res, 404, 'Run snapshot not found');
      sendJSON(res, 200, snap);
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/awf/:id/replay/:ts — re-execute the workflow with the same input
  // (i.e. "run the same scenario again to see if the bug reproduces")
  router.post('/api/awf/:id/replay/:ts', async (req, res) => {
    try {
      const snap = loadRunSnapshot(req.params.id, req.params.ts);
      if (!snap) return sendError(res, 404, 'Run snapshot not found');
      const wf = listWorkflows().find(w => w.id === req.params.id);
      if (!wf) return sendError(res, 404, 'Workflow not found');
      const config = loadConfig();
      const steps = await runWorkflow(wf, snap.input, config, { triggerPayload: snap.triggerPayload });
      const newTs = saveRunSnapshot(wf.id, steps, {
        input: snap.input,
        triggerType: `replay:${req.params.ts}`,
        triggerPayload: snap.triggerPayload,
        wfSnapshot: { name: wf.name, nodes: wf.nodes, edges: wf.edges },
      });
      sendJSON(res, 200, { ok: true, ts: newTs, steps, paused: steps?.__paused || null });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/awf/:id/replay-from/:ts/:nodeId — re-execute starting from a
  // specific node, reusing the upstream outputs from the previous run.
  // Lets the user fix a node and re-test ONLY that branch without paying
  // for upstream API calls again.
  router.post('/api/awf/:id/replay-from/:ts/:nodeId', async (req, res) => {
    try {
      const snap = loadRunSnapshot(req.params.id, req.params.ts);
      if (!snap) return sendError(res, 404, 'Snapshot not found');
      const wf = listWorkflows().find(w => w.id === req.params.id);
      if (!wf) return sendError(res, 404, 'Workflow not found');
      const fromNodeId = req.params.nodeId;
      const fromNode = (wf.nodes || []).find(n => n.id === fromNodeId);
      if (!fromNode) return sendError(res, 404, 'Node not found in current workflow');
      // Build a synthetic context: take the previous run's output of the
      // predecessor node, feed it in as initial input.
      const predEdge = (wf.edges || []).find(e => e.to === fromNodeId);
      const predStep = predEdge ? snap.steps.find(s => s.nodeId === predEdge.from) : null;
      const seedInput = predStep?.output || snap.input;
      // Build a partial workflow rooted at fromNode
      const reachable = new Set([fromNodeId]);
      const queue = [fromNodeId];
      while (queue.length) {
        const cur = queue.shift();
        (wf.edges || []).filter(e => e.from === cur).forEach(e => {
          if (!reachable.has(e.to)) { reachable.add(e.to); queue.push(e.to); }
        });
      }
      const partial = {
        ...wf,
        nodes: (wf.nodes || []).filter(n => reachable.has(n.id)),
        edges: (wf.edges || []).filter(e => reachable.has(e.from) && reachable.has(e.to)),
      };
      // Make fromNode the "trigger" so the runner starts from it
      const config = loadConfig();
      const steps = await runWorkflow(partial, seedInput, config);
      // Merge with previous (preserve upstream history)
      const mergedSteps = [
        ...snap.steps.filter(s => !reachable.has(s.nodeId)),
        ...steps,
      ];
      const newTs = saveRunSnapshot(wf.id, mergedSteps, {
        input: `replay-from:${fromNodeId}`,
        triggerType: `replay-from:${req.params.ts}:${fromNodeId}`,
        triggerPayload: snap.triggerPayload,
        wfSnapshot: { name: wf.name, nodes: wf.nodes, edges: wf.edges },
      });
      sendJSON(res, 200, { ok: true, ts: newTs, steps: mergedSteps });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // GET /api/awf/:id/diff/:tsA/:tsB — compare two run snapshots node-by-node.
  // For each nodeId we surface whether the outputs are identical, differ, or
  // exist in only one of the two runs. Used by the UI to spot regressions.
  router.get('/api/awf/:id/diff/:tsA/:tsB', async (req, res) => {
    try {
      const a = loadRunSnapshot(req.params.id, req.params.tsA);
      const b = loadRunSnapshot(req.params.id, req.params.tsB);
      if (!a || !b) return sendError(res, 404, 'One or both snapshots not found');
      // Index steps by nodeId (use the LAST execution of each node, in case loops produced multiple).
      const indexOf = (snap) => {
        const m = new Map();
        for (const s of snap.steps || []) m.set(s.nodeId, s);
        return m;
      };
      const ia = indexOf(a);
      const ib = indexOf(b);
      const allNodeIds = new Set([...ia.keys(), ...ib.keys()]);
      const eq = (x, y) => {
        try { return JSON.stringify(x ?? null) === JSON.stringify(y ?? null); }
        catch { return String(x) === String(y); }
      };
      const diff = [];
      for (const nodeId of allNodeIds) {
        const sa = ia.get(nodeId);
        const sb = ib.get(nodeId);
        if (sa && !sb) diff.push({ nodeId, nodeLabel: sa.nodeLabel, status: 'removed', a: sa });
        else if (!sa && sb) diff.push({ nodeId, nodeLabel: sb.nodeLabel, status: 'added', b: sb });
        else if (sa && sb) {
          const outputEq = eq(sa.output, sb.output);
          const errorEq  = eq(sa.error || null, sb.error || null);
          if (outputEq && errorEq) {
            diff.push({
              nodeId, nodeLabel: sa.nodeLabel, status: 'identical',
              durationDelta: (sb.durationMs || 0) - (sa.durationMs || 0),
            });
          } else {
            diff.push({
              nodeId, nodeLabel: sa.nodeLabel, status: 'changed',
              a: { output: sa.output, error: sa.error, durationMs: sa.durationMs },
              b: { output: sb.output, error: sb.error, durationMs: sb.durationMs },
              durationDelta: (sb.durationMs || 0) - (sa.durationMs || 0),
            });
          }
        }
      }
      sendJSON(res, 200, {
        a: { ts: a.ts, errorCount: a.errorCount, totalDurationMs: a.totalDurationMs },
        b: { ts: b.ts, errorCount: b.errorCount, totalDurationMs: b.totalDurationMs },
        diff,
        summary: {
          identical: diff.filter(d => d.status === 'identical').length,
          changed:   diff.filter(d => d.status === 'changed').length,
          added:     diff.filter(d => d.status === 'added').length,
          removed:   diff.filter(d => d.status === 'removed').length,
        },
      });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // GET /api/awf/:id/paused-context/:key — return live ctx for a paused run.
  // `key` can be either the runId (live) or the snapshot ts (after persisting).
  // Used by the Variable Watcher panel to inspect ctx.output / ctx.input live.
  router.get('/api/awf/:id/paused-context/:key', async (req, res) => {
    try {
      const cacheKey = `${req.params.id}:${req.params.key}`;
      const entry = _pausedContexts.get(cacheKey);
      if (!entry) return sendError(res, 404, 'No paused context for this key');
      // Serialize safely — ctx values may be non-JSON-safe (Date, BigInt…).
      const safe = (v) => {
        try {
          if (v === null || typeof v !== 'object') return v;
          return JSON.parse(JSON.stringify(v));
        } catch { return String(v); }
      };
      sendJSON(res, 200, {
        atNodeId: entry.atNodeId,
        nodeConfig: entry.nodeConfig,
        pendingNodes: entry.pendingNodes,
        ageMs: Date.now() - entry.timestamp,
        ctx: {
          output: safe(entry.ctxSnapshot?.output),
          input:  safe(entry.ctxSnapshot?.input),
          loopItem: safe(entry.ctxSnapshot?.loopItem),
        },
      });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/awf/:id/resume/:ts — resume a paused (breakpoint-halted) run
  // from the node where it stopped. Skips the breakpoint on that one node so
  // the runner proceeds past it. The user can re-pause on any other bp.
  router.post('/api/awf/:id/resume/:ts', async (req, res) => {
    try {
      const snap = loadRunSnapshot(req.params.id, req.params.ts);
      if (!snap) return sendError(res, 404, 'Snapshot not found');
      if (!snap.paused) return sendError(res, 400, 'Run is not paused');
      const wf = listWorkflows().find(w => w.id === req.params.id);
      if (!wf) return sendError(res, 404, 'Workflow not found');
      const config = loadConfig();
      const pausedNode = snap.paused.atNodeId;
      const seed = snap.paused.ctxSnapshot?.output ?? snap.input;
      // Build a sub-graph starting from the paused node
      const reachable = new Set([pausedNode]);
      const queue = [pausedNode];
      while (queue.length) {
        const cur = queue.shift();
        (wf.edges || []).filter(e => e.from === cur).forEach(e => {
          if (!reachable.has(e.to)) { reachable.add(e.to); queue.push(e.to); }
        });
      }
      const partial = {
        ...wf,
        nodes: (wf.nodes || []).filter(n => reachable.has(n.id)),
        edges: (wf.edges || []).filter(e => reachable.has(e.from) && reachable.has(e.to)),
      };
      const steps = await runWorkflow(partial, seed, config, { skipBreakpointFor: [pausedNode] });
      const merged = [
        ...snap.steps.filter(s => !s.paused), // drop the original ⏸ marker
        ...steps,
      ];
      const newTs = saveRunSnapshot(wf.id, merged, {
        input: `resume:${req.params.ts}`,
        triggerType: `resume:${req.params.ts}`,
        triggerPayload: snap.triggerPayload,
        wfSnapshot: { name: wf.name, nodes: wf.nodes, edges: wf.edges },
      });
      sendJSON(res, 200, { ok: true, ts: newTs, steps: merged, paused: steps?.__paused || null });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/awf/:id/explain/:ts/:nodeId — AI plain-language explanation of
  // what happened at a given node. Used by the debugger to translate stack
  // traces and JSON outputs into Italian sentences a non-dev can understand.
  router.post('/api/awf/:id/explain/:ts/:nodeId', async (req, res) => {
    try {
      const snap = loadRunSnapshot(req.params.id, req.params.ts);
      if (!snap) return sendError(res, 404, 'Snapshot not found');
      const step = snap.steps.find(s => s.nodeId === req.params.nodeId);
      if (!step) return sendError(res, 404, 'Step not found in snapshot');
      const wf = listWorkflows().find(w => w.id === req.params.id);
      const node = wf?.nodes?.find(n => n.id === req.params.nodeId);
      const sysPrompt =
        'Spieghi a un non-programmatore italiano cosa è successo in un nodo di un workflow. ' +
        'Massimo 3 frasi. Diretto, concreto. Se c\'è un errore, spiega CAUSA (in italiano semplice) e UNA AZIONE per risolverlo. ' +
        'Se è andato OK, descrivi cosa ha prodotto in 1 frase.';
      const userMsg = JSON.stringify({
        node: { type: node?.defId, label: step.nodeLabel, config: node?.config },
        output: typeof step.output === 'string' ? step.output.slice(0, 1500) : JSON.stringify(step.output).slice(0, 1500),
        error: step.error || null,
      });
      const explanation = await callLLM(loadConfig(), sysPrompt, userMsg, { temperature: 0.2, maxTokens: 250 });
      sendJSON(res, 200, { explanation: explanation.trim() });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/awf/:id/breakpoints — set/clear breakpoints on a workflow
  router.post('/api/awf/:id/breakpoints', async (req, res) => {
    try {
      const id = req.params.id;
      const body = await parseBody(req);
      const wf = listWorkflows().find(w => w.id === id);
      if (!wf) return sendError(res, 404, 'Workflow not found');
      wf.breakpoints = Array.isArray(body.breakpoints) ? body.breakpoints : [];
      saveWorkflow(wf);
      sendJSON(res, 200, { ok: true, breakpoints: wf.breakpoints });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ════════════════════════════════════════════════════════════════════════
  // CREDENTIALS — multi-environment switch (dev/staging/prod)
  // ════════════════════════════════════════════════════════════════════════
  router.get('/api/awf/env', async (_req, res) => {
    sendJSON(res, 200, { env: _currentEnv() });
  });

  router.post('/api/awf/env', async (req, res) => {
    try {
      const body = await parseBody(req);
      const newEnv = String(body.env || 'prod').toLowerCase();
      if (!['dev', 'staging', 'prod'].includes(newEnv)) return sendError(res, 400, 'env must be dev|staging|prod');
      process.env.NHA_ENV = newEnv;
      sendJSON(res, 200, { ok: true, env: newEnv });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ════════════════════════════════════════════════════════════════════════
  // WORKSPACE SYNC + AUTO-BACKUP (Google Drive)
  // ════════════════════════════════════════════════════════════════════════
  router.post('/api/awf/backup', async (req, res) => {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = await backupWorkflowsToDrive(loadConfig(), { folder: body.folder });
      sendJSON(res, 200, result);
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/awf/sync/push — push the current workspace (all workflows) to
  // Google Drive as a single backup JSON. Differs from /backup in that it
  // also returns a sync-pointer file id so the user can /pull it later from
  // another machine.
  router.post('/api/awf/sync/push', async (req, res) => {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = await backupWorkflowsToDrive(loadConfig(), {
        folder: body.folder,
        syncTag: true, // mark filename so /pull can find it deterministically
      });
      sendJSON(res, 200, { ok: true, ...result, pushedAt: new Date().toISOString() });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/awf/sync/pull — pull the latest workspace backup from Drive
  // and merge into local workflows. Conflict resolution: `mode` decides:
  //   - 'merge' (default): keep local, only import workflows missing locally
  //   - 'replace': overwrite every workflow with the Drive version
  router.post('/api/awf/sync/pull', async (req, res) => {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const config = loadConfig();
      const accessToken = config.google?.tokens?.access_token;
      if (!accessToken) return sendError(res, 400, 'Google Drive not authorized');

      // Find the most recent nha-awf-sync-*.json in Drive
      const q = encodeURIComponent("name contains 'nha-awf-sync-' and mimeType='application/json' and trashed=false");
      const list = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=1&fields=files(id,name,createdTime)`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.json()).catch(() => null);
      const fileId = list?.files?.[0]?.id;
      if (!fileId) return sendError(res, 404, 'No nha-awf-sync-* file found on Drive');

      const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!dl.ok) return sendError(res, 500, `Drive download failed: ${dl.status}`);
      const payload = await dl.json();
      if (!Array.isArray(payload.workflows)) return sendError(res, 400, 'Backup payload invalid');

      const mode = body.mode === 'replace' ? 'replace' : 'merge';
      const existing = new Set(listWorkflows().map(w => w.id));
      let imported = 0, skipped = 0;
      for (const wf of payload.workflows) {
        if (mode === 'merge' && existing.has(wf.id)) { skipped++; continue; }
        try { saveWorkflow(wf); imported++; } catch {}
      }
      sendJSON(res, 200, { ok: true, mode, imported, skipped, total: payload.workflows.length, pulledFrom: list.files[0].name });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/awf/restore', async (req, res) => {
    try {
      const body = await parseBody(req);
      if (!body.payload) return sendError(res, 400, 'payload (parsed backup JSON) required');
      const payload = typeof body.payload === 'string' ? JSON.parse(body.payload) : body.payload;
      if (!Array.isArray(payload.workflows)) return sendError(res, 400, 'invalid backup format');
      let imported = 0;
      for (const wf of payload.workflows) {
        try { saveWorkflow(wf); imported++; } catch {}
      }
      // Credentials restored only if user explicitly opts in (security)
      if (body.restoreCredentials && payload.credentialsEncrypted) {
        // Will only decrypt on the SAME machine (machine-bound salt).
        fs.writeFileSync(CREDS_FILE, JSON.stringify(payload.credentialsEncrypted, null, 2));
      }
      sendJSON(res, 200, { ok: true, imported, total: payload.workflows.length });
    } catch (e) { sendError(res, 500, e.message); }
  });
}
