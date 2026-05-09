/**
 * Connectors — visual workflow automation backend
 * Workflows stored in ~/.nha/workflows/*.json
 * Execution: each node runs a real NHA tool or AI call
 */
import fs from 'fs';
import path from 'path';
import { NHA_DIR } from '../../constants.mjs';
import { loadConfig } from '../../config.mjs';
import { sendJSON, sendError, parseBody } from '../index.mjs';
import { executeTool } from '../../services/tool-executor.mjs';
import { callLLM } from '../../services/llm.mjs';

const WORKFLOWS_DIR = path.join(NHA_DIR, 'workflows');

function ensureDir() {
  if (!fs.existsSync(WORKFLOWS_DIR)) fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
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
  fs.writeFileSync(path.join(WORKFLOWS_DIR, `${wf.id}.json`), JSON.stringify(wf, null, 2));
}

function deleteWorkflow(id) {
  const p = path.join(WORKFLOWS_DIR, `${id}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
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

  // AI nodes
  if (nodeDef.type === 'ai') {
    const prompt = cfg.prompt || `Process this: ${ctx.output || ''}`;
    const systemPrompt = cfg.systemPrompt || 'You are a helpful AI assistant. Process the input and return a concise result.';
    const result = await callLLM(config, systemPrompt, prompt);
    return result?.content || result || '';
  }

  // Action nodes — map to executeTool actions
  const ACTION_MAP = {
    action_email:    ['gmail_send',       { to: cfg.to, subject: cfg.subject || 'NHA Workflow', body: cfg.body || ctx.output }],
    action_slack:    ['slack_message',    { channel: cfg.channel || '#general', text: cfg.text || ctx.output }],
    action_calendar: ['calendar_create',  { title: cfg.title || ctx.output, date: cfg.date || new Date().toISOString().split('T')[0], time: cfg.time || '09:00', duration: cfg.duration || '60' }],
    action_task:     ['task_create',      { title: cfg.title || ctx.output, priority: cfg.priority || 'medium' }],
    action_drive:    ['drive_upload',     { name: cfg.name || 'workflow-output.txt', content: cfg.content || ctx.output }],
    action_notion:   ['notion_page',      { title: cfg.title || 'Workflow Output', content: cfg.content || ctx.output }],
    action_github:   ['github_issue',     { repo: cfg.repo, title: cfg.title || ctx.output, body: cfg.body || '' }],
    action_webhook:  ['fetch_url',        { url: cfg.url, method: cfg.method || 'POST', body: cfg.body || ctx.output }],
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

  // Trigger nodes produce no output themselves (they're the entry point)
  if (nodeDef.type === 'trigger') {
    return ctx.output || cfg.input || '';
  }

  return '';
}

/**
 * Run a workflow from start to finish.
 * Returns array of { nodeId, output, error? } step results.
 */
async function runWorkflow(wf, initialInput, config) {
  const steps = [];
  const nodeMap = Object.fromEntries(wf.nodes.map((n) => [n.id, n]));
  const defMap = Object.fromEntries((wf.nodeDefs || []).map((d) => [d.id, d]));

  // Build adjacency: from → to
  const next = {};
  for (const e of wf.edges ?? []) {
    if (!next[e.from]) next[e.from] = [];
    next[e.from].push(e.to);
  }

  // Find start node (trigger, or first with no incoming edges)
  const hasIncoming = new Set((wf.edges ?? []).map((e) => e.to));
  const startCandidates = wf.nodes.filter((n) => !hasIncoming.has(n.id));
  if (startCandidates.length === 0) return [{ nodeId: '__error', output: 'No start node found.' }];

  // BFS execution
  const queue = startCandidates.map((n) => ({ nodeId: n.id, ctx: { output: initialInput || '', input: initialInput || '' } }));
  const visited = new Set();

  while (queue.length > 0) {
    const { nodeId, ctx } = queue.shift();
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodeMap[nodeId];
    if (!node) continue;
    const nodeDef = defMap[node.defId];
    if (!nodeDef) continue;

    let output = '';
    let error = null;
    try {
      output = await executeNode(node, nodeDef, ctx, config);
    } catch (e) {
      error = e.message;
      output = '';
    }

    steps.push({ nodeId, nodeLabel: nodeDef.label, nodeIcon: nodeDef.icon, output, error });

    const nextCtx = { ...ctx, output, [`${nodeDef.id}_output`]: output };
    for (const toId of next[nodeId] ?? []) {
      queue.push({ nodeId: toId, ctx: nextCtx });
    }
  }

  return steps;
}

export function register(router) {
  // GET /api/workflows — list all workflows
  router.get('/api/workflows', async (req, res) => {
    try {
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
      const steps = await runWorkflow(wf, body.input || '', config);

      // Save last run result in workflow
      wf.lastRun = { at: new Date().toISOString(), steps };
      saveWorkflow(wf);

      sendJSON(res, 200, { ok: true, steps });
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
}
