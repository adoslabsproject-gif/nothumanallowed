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
          steps.push({ nodeId, nodeLabel: nodeDef.label, nodeIcon: '🔄', output: `Retry ${attempt}/${maxRetries}: ${e.message}`, error: null });
        }
      }
    }

    steps.push({ nodeId, nodeLabel: nodeDef.label, nodeIcon: nodeDef.icon, output: output?.slice?.(0, 2000) || '', error });

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
            try {
              const loopOut = await executeNode(toNode, toDef, loopCtx, config);
              steps.push({ nodeId: toId, nodeLabel: `${toDef.label} [${item.slice(0, 20)}]`, nodeIcon: toDef.icon, output: loopOut?.slice?.(0, 2000) || '', error: null });
            } catch (e) {
              steps.push({ nodeId: toId, nodeLabel: `${toDef.label} [${item.slice(0, 20)}]`, nodeIcon: toDef.icon, output: '', error: e.message });
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

  return steps;
}

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
