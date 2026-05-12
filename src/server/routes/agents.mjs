/**
 * Agents routes — /api/agents CRUD + /api/ask/stream
 */

import fs from 'fs';
import path from 'path';
import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { AGENTS_DIR, NHA_DIR } from '../../constants.mjs';
import { callLLMStream, parseAgentFile } from '../../services/llm.mjs';
import { tryDirectActionAll } from '../../services/message-responder.mjs';

function loadAgentCards() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.mjs'))
    .map(f => {
      try {
        const src = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8');
        return parseAgentFile(src, f.replace('.mjs',''));
      } catch { return null; }
    })
    .filter(Boolean);
}

export function register(router) {
  router.get('/api/agents', (_req, res) => {
    sendJSON(res, 200, { agents: loadAgentCards() });
  });

  router.post('/api/agents', async (req, res) => {
    try {
      const body = await parseBody(req);
      if (!body.name || !body.systemPrompt) return sendError(res, 400, 'name and systemPrompt required');
      fs.mkdirSync(AGENTS_DIR, { recursive: true });
      const slug = body.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const file = path.join(AGENTS_DIR, `${slug}.mjs`);
      if (fs.existsSync(file)) return sendError(res, 409, 'Agent already exists');
      const content = `// Agent: ${body.name}\nexport const agent = {\n  name: "${body.name}",\n  icon: "${body.icon || '🤖'}",\n  description: "${(body.description || '').replace(/"/g,'\\\"')}",\n  systemPrompt: \`${body.systemPrompt.replace(/`/g,'\\`')}\`,\n};\nexport default agent;\n`;
      fs.writeFileSync(file, content, 'utf-8');
      sendJSON(res, 201, { ok: true, slug });
    } catch (e) { sendError(res, 500, e.message); }
  });

  const AGENT_RE = /^\/api\/agents\/([a-z0-9-]+)$/;

  router.get(AGENT_RE, (req, res) => {
    const slug = req.url.match(AGENT_RE)?.[1];
    const file = path.join(AGENTS_DIR, `${slug}.mjs`);
    if (!fs.existsSync(file)) return sendError(res, 404, 'Agent not found');
    try {
      const src = fs.readFileSync(file, 'utf-8');
      sendJSON(res, 200, { agent: parseAgentFile(src, slug) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.put(AGENT_RE, async (req, res) => {
    try {
      const slug = req.url.match(AGENT_RE)?.[1];
      const file = path.join(AGENTS_DIR, `${slug}.mjs`);
      if (!fs.existsSync(file)) return sendError(res, 404, 'Agent not found');
      const body = await parseBody(req);
      const content = `// Agent: ${body.name || slug}\nexport const agent = {\n  name: "${body.name || slug}",\n  icon: "${body.icon || '🤖'}",\n  description: "${(body.description || '').replace(/"/g,'\\\"')}",\n  systemPrompt: \`${(body.systemPrompt || '').replace(/`/g,'\\`')}\`,\n};\nexport default agent;\n`;
      fs.writeFileSync(file, content, 'utf-8');
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.delete(AGENT_RE, (req, res) => {
    const slug = req.url.match(AGENT_RE)?.[1];
    const file = path.join(AGENTS_DIR, `${slug}.mjs`);
    if (!fs.existsSync(file)) return sendError(res, 404, 'Agent not found');
    fs.unlinkSync(file);
    sendJSON(res, 200, { ok: true });
  });

  // POST /api/ask/stream — single agent streaming ask
  router.post('/api/ask/stream', async (req, res) => {
    const body = await parseBody(req);
    if (!body.message) return sendError(res, 400, 'message required');
    const config = loadConfig();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const sse = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      // ── Direct-action pre-step (deterministic tool exec, LLM only for NLU) ──
      // Same dispatcher used by Telegram / Discord / Chat WebUI / AWF: if
      // the user's message maps to a state-changing tool (CRUD on calendar,
      // email, drive, slack, github, file, ...), execute it server-side and
      // stream the result. LLM agent is bypassed entirely for actions.
      const direct = await tryDirectActionAll(body.message, loadConfig(), {
        auditKey: `agents:${body.agent || 'any'}`,
      });
      if (direct) {
        sse('tool', { action: direct.action, status: 'done' });
        sse('token', { content: direct.message });
        sse('done', {});
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const agentSlug = body.agent?.toLowerCase();
      const LANG_MAP = { it:'Italian', en:'English', es:'Spanish', fr:'French', de:'German', pt:'Portuguese', nl:'Dutch', pl:'Polish', ru:'Russian', zh:'Chinese', ja:'Japanese', ko:'Korean', ar:'Arabic', hi:'Hindi', tr:'Turkish', sv:'Swedish', da:'Danish', fi:'Finnish', cs:'Czech' };
      const lang = LANG_MAP[(config?.language || config?.lang || 'en').slice(0,2)] || 'English';
      let sysProm = `You are a helpful AI assistant. Always respond in ${lang}.`;
      if (agentSlug) {
        const af = path.join(AGENTS_DIR, `${agentSlug}.mjs`);
        if (fs.existsSync(af)) {
          const parsed = parseAgentFile(fs.readFileSync(af, 'utf-8'), agentSlug);
          if (parsed.systemPrompt) sysProm = `${parsed.systemPrompt}\n\nIMPORTANT: Always respond in ${lang}.`;
        }
      }
      await callLLMStream(config, sysProm, body.message, (tok) => sse('token', { content: tok }));
      sse('done', {});
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      sse('error', { message: e.message });
      res.end();
    }
  });
}
