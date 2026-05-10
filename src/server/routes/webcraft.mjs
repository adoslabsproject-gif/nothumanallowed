/**
 * WebCraft routes — /api/studio/webcraft/*
 *
 * Architecture:
 *   - SandboxManager  — encapsulates child-process lifecycle (start/stop/status)
 *   - ProjectStore    — pure filesystem helpers for project files/metadata
 *   - SkillStore      — per-project .nha-context/ skill/memory/provider files
 *   - SnapshotStore   — tarball-based immutable project snapshots
 *   - WebCraftAgent   — LLM tool-loop for chat-driven code editing
 *
 * All LLM calls go through the shared services/llm.mjs (callLLM / callLLMStream).
 * Sandbox shims are injected at startup so user projects run without real DB/Redis.
 */

import fs   from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { createServer } from 'net';
import { promisify } from 'util';
import { sendJSON, sendError, parseBody, sendSSE } from '../index.mjs';
import { loadConfig }   from '../../config.mjs';
import { callLLM, callLLMStream, fixQwen3BPE } from '../../services/llm.mjs';
import { NHA_DIR } from '../../constants.mjs';

const execAsync = promisify(exec);

// ── Project root ─────────────────────────────────────────────────────────────

const WEBCRAFT_DIR = path.join(NHA_DIR, 'webcraft');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

// ── SandboxManager ───────────────────────────────────────────────────────────

class SandboxManager {
  constructor() {
    /** @type {{ proc: import('child_process').ChildProcess; port: number; projectName: string; startedAt: Date; healthy: boolean } | null} */
    this._sandbox = null;
  }

  isRunning() {
    return this._sandbox !== null && this._sandbox.proc && !this._sandbox.proc.killed;
  }

  status() {
    if (!this.isRunning()) return { running: false };
    const { port, projectName, startedAt, healthy } = this._sandbox;
    return { running: true, port, projectName, startedAt, healthy };
  }

  /** Returns the port of the running sandbox or null. */
  get port() { return this.isRunning() ? this._sandbox.port : null; }

  async stop() {
    if (!this.isRunning()) return;
    const { proc } = this._sandbox;
    this._sandbox = null;
    try {
      proc.kill('SIGTERM');
      // Give it a grace period then SIGKILL
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 4000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    } catch {}
  }

  /**
   * Starts the sandbox and streams progress via SSE.
   * @param {string} projectName
   * @param {string} projectDir
   * @param {(event: object) => void} emit
   */
  async start(projectName, projectDir, emit, _attempt = 1) {
    const MAX_RETRIES = 3;

    // Kill any existing sandbox
    if (this.isRunning()) {
      emit({ type: 'phase', phase: 'cleanup', msg: 'Stopping previous sandbox...' });
      await this.stop();
    }

    if (!fs.existsSync(projectDir)) {
      emit({ type: 'error', msg: `Project directory not found: ${projectDir}` });
      return;
    }

    // ── Phase 1: Shims ────────────────────────────────────────────────────
    emit({ type: 'phase', phase: 'shims', msg: 'Injecting runtime shims (pg, redis, mongoose, helmet...)' });
    const shimDir = path.join(projectDir, '.nha-shims');
    ensureDir(shimDir);
    _writeShims(shimDir);

    const entryFile = _detectEntry(projectDir);
    if (!entryFile) {
      emit({ type: 'error', msg: 'No entry point found (server.js / app.js / index.js).' });
      return;
    }
    emit({ type: 'status', msg: `Entry point: ${entryFile}` });

    // ── Phase 2: Dependencies ─────────────────────────────────────────────
    if (fs.existsSync(path.join(projectDir, 'package.json'))) {
      emit({ type: 'phase', phase: 'deps', msg: 'Installing dependencies...' });
      try {
        const { stdout } = await execAsync('npm install --prefer-offline --no-audit --no-fund 2>&1', {
          cwd: projectDir,
          timeout: 120_000,
          env: { ...process.env, NODE_ENV: 'development' },
        });
        const added = stdout.match(/added (\d+) package/)?.[1] || '0';
        emit({ type: 'status', msg: `Dependencies installed (${added} packages)` });
      } catch (e) {
        emit({ type: 'warn', msg: `npm install warning: ${e.message.slice(0, 300)}` });
      }
    }

    // ── Phase 3: Start server ─────────────────────────────────────────────
    const port = await _findFreePort(4000, 4999);
    if (!port) {
      emit({ type: 'error', msg: 'No free ports available in range 4000-4999.' });
      return;
    }

    emit({ type: 'phase', phase: 'start', msg: `Starting server on port ${port}...` });
    const patchedEntry = _patchEntry(projectDir, entryFile, shimDir, port);

    // Capture stderr for missing module detection
    let stderrBuf = '';
    const proc = spawn('node', [patchedEntry], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'development',
        NHA_SANDBOX: '1',
      },
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._sandbox = { proc, port, projectName, startedAt: new Date(), healthy: false };
    let readyEmitted = false;

    proc.stdout.on('data', (d) => {
      const line = d.toString().trim();
      if (line) emit({ type: 'log', msg: line });
      if (!readyEmitted && /listen|running|started|ready|port/i.test(line)) {
        readyEmitted = true;
        if (this._sandbox) this._sandbox.healthy = true;
        emit({ type: 'phase', phase: 'ready', msg: `Server running on port ${port}` });
        emit({ type: 'ready', port });
      }
    });

    proc.stderr.on('data', (d) => {
      const line = d.toString().trim();
      stderrBuf += d.toString();
      if (line) emit({ type: 'log', msg: `[stderr] ${line}` });
    });

    // Wait for exit or healthy
    const exitPromise = new Promise((resolve) => {
      proc.once('exit', (code) => {
        if (this._sandbox?.proc === proc) this._sandbox = null;
        resolve(code ?? -1);
      });
    });

    const healthy = await Promise.race([
      _waitForPort(port, 15_000).then((h) => h ? 'healthy' : 'timeout'),
      exitPromise.then((code) => ({ exitCode: code })),
    ]);

    if (healthy === 'healthy') {
      if (!readyEmitted) {
        readyEmitted = true;
        if (this._sandbox) this._sandbox.healthy = true;
        emit({ type: 'phase', phase: 'ready', msg: `Server running on port ${port}` });
        emit({ type: 'ready', port });
      }
      return;
    }

    // If ready was already emitted by stdout, ignore timeout
    if (healthy === 'timeout') {
      if (readyEmitted) return;
      emit({ type: 'warn', msg: 'Server started but port not yet bound — may still be loading.' });
      return;
    }

    // ── Crash handling — auto-fix missing modules ─────────────────────────
    const exitCode = typeof healthy === 'object' ? healthy.exitCode : -1;
    emit({ type: 'status', msg: `Process exited with code ${exitCode}` });

    // Extract missing module name from stderr
    const missingMatch = stderrBuf.match(/Cannot find module ['"]([^'"]+)['"]/);
    if (missingMatch && _attempt < MAX_RETRIES) {
      const missingMod = missingMatch[1];
      // Skip shim-able or built-in modules
      if (!missingMod.startsWith('.') && !missingMod.startsWith('/') && !missingMod.startsWith('node:')) {
        const pkgName = missingMod.startsWith('@') ? missingMod.split('/').slice(0, 2).join('/') : missingMod.split('/')[0];
        emit({ type: 'phase', phase: 'autofix', msg: `Missing module "${pkgName}" — installing...` });
        try {
          await execAsync(`npm install --save ${pkgName} --no-audit --no-fund`, {
            cwd: projectDir,
            timeout: 60_000,
            env: { ...process.env, NODE_ENV: 'development' },
          });
          emit({ type: 'status', msg: `Installed ${pkgName} — retrying (attempt ${_attempt + 1}/${MAX_RETRIES})...` });
          return this.start(projectName, projectDir, emit, _attempt + 1);
        } catch (installErr) {
          emit({ type: 'warn', msg: `Failed to install ${pkgName}: ${installErr.message.slice(0, 200)}` });
        }
      }
    }

    emit({ type: 'error', msg: _attempt >= MAX_RETRIES ? `Failed after ${MAX_RETRIES} attempts` : 'Server crashed on startup' });
  }
}

const sandbox = new SandboxManager();

// ── ProjectStore ─────────────────────────────────────────────────────────────

const ProjectStore = {
  dir(projectName) {
    return path.join(WEBCRAFT_DIR, _safeName(projectName));
  },

  metaPath(projectName) {
    return path.join(this.dir(projectName), '.nha-meta.json');
  },

  list() {
    ensureDir(WEBCRAFT_DIR);
    return fs.readdirSync(WEBCRAFT_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const metaFile = path.join(WEBCRAFT_DIR, d.name, '.nha-meta.json');
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch {}
        const files = _listProjectFiles(path.join(WEBCRAFT_DIR, d.name));
        return {
          name: d.name,
          description: meta.description ?? '',
          fileCount: files.length,
          createdAt: meta.createdAt ?? null,
          dir: path.join(WEBCRAFT_DIR, d.name),
        };
      })
      .sort((a, b) => (b.createdAt ?? '') < (a.createdAt ?? '') ? -1 : 1);
  },

  load(projectName) {
    const dir = this.dir(projectName);
    if (!fs.existsSync(dir)) return null;
    const metaFile = this.metaPath(projectName);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch {}
    const rawFiles = _listProjectFiles(dir);
    const files = rawFiles.map((rel) => ({
      name: rel,
      content: fs.readFileSync(path.join(dir, rel), 'utf-8'),
    }));
    return { projectName, description: meta.description ?? '', files };
  },

  save(projectName, description, files) {
    const dir = ensureDir(this.dir(projectName));
    for (const f of files) {
      if (!_isSafePath(f.name)) continue;
      const abs = path.join(dir, f.name);
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, f.content ?? '', 'utf-8');
    }
    const meta = {
      description: description ?? '',
      createdAt: fs.existsSync(this.metaPath(projectName))
        ? JSON.parse(fs.readFileSync(this.metaPath(projectName), 'utf-8')).createdAt ?? new Date().toISOString()
        : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.metaPath(projectName), JSON.stringify(meta, null, 2), 'utf-8');
  },

  delete(projectName) {
    const dir = this.dir(projectName);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  },

  readFile(projectName, relPath) {
    if (!_isSafePath(relPath)) return null;
    const abs = path.join(this.dir(projectName), relPath);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, 'utf-8');
  },

  writeFile(projectName, relPath, content) {
    if (!_isSafePath(relPath)) return false;
    const abs = path.join(this.dir(projectName), relPath);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content, 'utf-8');
    return true;
  },

  grep(projectName, query) {
    const dir = this.dir(projectName);
    if (!fs.existsSync(dir)) return [];
    const files = _listProjectFiles(dir);
    const matches = [];
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const rel of files) {
      const abs = path.join(dir, rel);
      try {
        const lines = fs.readFileSync(abs, 'utf-8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({ file: rel, lineNum: i + 1, line: lines[i].slice(0, 200) });
            if (matches.length >= 200) return matches;
          }
        }
      } catch {}
    }
    return matches;
  },

  syntaxCheck(projectName) {
    const dir = this.dir(projectName);
    if (!fs.existsSync(dir)) return [];
    const files = _listProjectFiles(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs'));
    return files.map((rel) => {
      const abs = path.join(dir, rel);
      try {
        const src = fs.readFileSync(abs, 'utf-8');
        // Quick static syntax check via Function constructor (catches syntax errors)
        new Function(src); // eslint-disable-line no-new-func
        return { file: rel, ok: true, error: '' };
      } catch (e) {
        return { file: rel, ok: false, error: e.message.replace(/\n.*/s, '') };
      }
    });
  },
};

// ── SkillStore ────────────────────────────────────────────────────────────────

const SkillStore = {
  dir(projectName) {
    return path.join(ProjectStore.dir(projectName), '.nha-context');
  },

  list(projectName) {
    const dir = this.dir(projectName);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
      .map((fname) => {
        const content = fs.readFileSync(path.join(dir, fname), 'utf-8');
        const type = fname.startsWith('memory') ? 'memory'
          : fname.startsWith('liara') || fname.startsWith('provider') ? 'provider'
          : fname.endsWith('.log.md') ? 'log'
          : 'skill';
        return { name: fname, content, type };
      });
  },

  save(projectName, skills) {
    const dir = ensureDir(this.dir(projectName));
    for (const s of skills) {
      if (!s.name || !s.name.match(/^[a-z0-9_./-]+$/i)) continue;
      fs.writeFileSync(path.join(dir, s.name), s.content ?? '', 'utf-8');
    }
  },

  delete(projectName, skillName) {
    if (!skillName || !skillName.match(/^[a-z0-9_./-]+$/i)) return;
    const abs = path.join(this.dir(projectName), skillName);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  },

  /** Ensure memory.md, skills.md, and provider.md always exist for a project. */
  ensureDefaults(projectName, config) {
    const dir = ensureDir(this.dir(projectName));
    const provider = config?.llm?.provider || 'nha';
    const model = config?.llm?.model || '';

    const memFile = path.join(dir, 'memory.md');
    if (!fs.existsSync(memFile)) {
      fs.writeFileSync(memFile, `# ${projectName} — Project Memory\n\n_Architectural decisions, preferences, and notes._\n`, 'utf-8');
    }
    const skillsFile = path.join(dir, 'skills.md');
    if (!fs.existsSync(skillsFile)) {
      fs.writeFileSync(skillsFile, `# ${projectName} — Skills\n\n_Coding patterns, best practices, and conventions for this project._\n`, 'utf-8');
    }
    const providerFile = path.join(dir, `${provider}.md`);
    if (!fs.existsSync(providerFile)) {
      fs.writeFileSync(providerFile, `# ${provider.toUpperCase()} — ${model || 'Default'}\n\n_Model-specific notes, prompt tips, and configuration._\n`, 'utf-8');
    }
  },

  context(projectName) {
    const skills = this.list(projectName);
    if (skills.length === 0) return '';
    return skills
      .filter((s) => s.content.trim())
      .map((s) => `## ${s.type.toUpperCase()} — ${s.name}\n${s.content.slice(0, 4000)}`)
      .join('\n\n---\n\n');
  },
};

// ── SnapshotStore ─────────────────────────────────────────────────────────────

const SnapshotStore = {
  dir(projectName) {
    return path.join(NHA_DIR, 'webcraft-snapshots', _safeName(projectName));
  },

  list(projectName) {
    const dir = this.dir(projectName);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        return { ts: raw.ts, fileCount: raw.files?.length ?? 0 };
      })
      .sort((a, b) => b.ts.localeCompare(a.ts));
  },

  take(projectName) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = ensureDir(this.dir(projectName));
    const proj = ProjectStore.load(projectName);
    if (!proj) return null;
    const snap = { ts, projectName, files: proj.files };
    fs.writeFileSync(path.join(dir, `${ts}.json`), JSON.stringify(snap), 'utf-8');
    return ts;
  },

  restore(projectName, ts) {
    const dir = this.dir(projectName);
    const snapFile = path.join(dir, `${ts}.json`);
    if (!fs.existsSync(snapFile)) return false;
    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf-8'));
    ProjectStore.save(projectName, '', snap.files ?? []);
    return true;
  },
};

// ── ChatStore ─────────────────────────────────────────────────────────────────

const ChatStore = {
  path(projectName) {
    return path.join(ProjectStore.dir(projectName), '.nha-chat.json');
  },
  load(projectName) {
    const p = this.path(projectName);
    if (!fs.existsSync(p)) return [];
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
  },
  save(projectName, messages) {
    const dir = ProjectStore.dir(projectName);
    if (!fs.existsSync(dir)) return;
    fs.writeFileSync(this.path(projectName), JSON.stringify(messages), 'utf-8');
  },
};

// ── WebCraftAgent ─────────────────────────────────────────────────────────────

/**
 * Tool-calling agent that can read/edit/write files inside the project.
 * Uses structured SSE events: { type: 'text', token } | { type: 'tool', ... } | { type: 'done', changed }
 */
async function runWebCraftAgent(config, projectName, message, attachments, emit) {
  const MAX_STEPS = 8; // max agentic loop iterations
  const dir = ProjectStore.dir(projectName);
  if (!fs.existsSync(dir)) { emit({ type: 'error', msg: 'Project not found' }); return; }

  SkillStore.ensureDefaults(projectName, config);

  const today = new Date().toISOString().slice(0, 10);
  const LANG_MAP = { en:'English',it:'Italian',es:'Spanish',fr:'French',de:'German',pt:'Portuguese' };
  const language = LANG_MAP[(config?.language||'it').slice(0,2)] || 'Italian';

  const toolSpec = `
AVAILABLE TOOLS (use exactly ONE tool per <tool> tag):

── FILE OPERATIONS ──

1. read — Read a file's content:
<tool>{"op":"read","path":"relative/path.js"}</tool>

2. edit — Surgical replacement (EXACT match required):
<tool>{"op":"edit","path":"relative/path.js","old":"EXACT_CODE_TO_REPLACE","new":"REPLACEMENT_CODE"}</tool>

3. write — Write/create a file (full content):
<tool>{"op":"write","path":"relative/path.js","content":"FULL_FILE_CONTENT"}</tool>

4. rename — Rename or move a file:
<tool>{"op":"rename","path":"old/path.js","newPath":"new/path.js"}</tool>

5. delete — Delete a file:
<tool>{"op":"delete","path":"relative/path.js"}</tool>

── VERIFICATION ──

6. check — Syntax check (JS/JSON/CSS/HTML):
<tool>{"op":"check","path":"relative/path.js"}</tool>

7. lint — Full diagnostics with line numbers:
<tool>{"op":"lint","path":"relative/path.js"}</tool>

8. search — Grep/find text in project files:
<tool>{"op":"search","query":"searchPattern","glob":"*.js"}</tool>

9. list — List all project files with sizes:
<tool>{"op":"list"}</tool>

── EXECUTION ──

10. run — Execute a shell command in the project directory:
<tool>{"op":"run","cmd":"npm install express"}</tool>
<tool>{"op":"run","cmd":"npm test"}</tool>
<tool>{"op":"run","cmd":"node -e \\"console.log(1+1)\\""}</tool>

11. sandbox — Restart the sandbox server to test changes:
<tool>{"op":"sandbox"}</tool>

── DIFF ──

12. diff — Show diff between current file and last snapshot:
<tool>{"op":"diff","path":"relative/path.js"}</tool>

WORKFLOW — follow this for every change:
1. Read the file(s) you need to modify
2. Make your changes with edit or write
3. Use check or lint to verify — fix any errors
4. Use sandbox to restart and verify the app works
5. When ALL changes are complete and verified, output: <done/>

RULES:
- "old" in edit must be EXACT verbatim code — copy-paste from read output
- Use edit for targeted changes, write for new files or complete rewrites
- ALWAYS read before edit if you haven't seen the file content
- ALWAYS check/lint after modifications
- Use run for npm install, npm test, or any shell command
- Use search to find code patterns across the project
- Output <done/> when you are completely finished — MANDATORY
`;

  // Build system prompt with fresh file list each step
  function buildSystemPrompt() {
    const files = _listProjectFiles(dir);
    const fileIndex = files.map((f) => `- ${f}`).join('\n');
    const skillCtx = SkillStore.context(projectName);
    const ctxDir = SkillStore.dir(projectName);
    let skillContext = '';
    try {
      for (const name of ['memory.md', 'skills.md', `${config.llm?.provider || 'nha'}.md`]) {
        const p = path.join(ctxDir, name);
        if (fs.existsSync(p)) skillContext += `\n### ${name}:\n${fs.readFileSync(p, 'utf-8')}\n`;
      }
    } catch {}

    // Key files: load full content for server, package.json, index
    const keyFiles = files.filter((f) =>
      /^(server|app|index)\.(js|mjs|ts)$/.test(f) || f === 'package.json' || f.includes('routes/index')
    );
    const mentionedFiles = files.filter((f) =>
      message.toLowerCase().includes((f.split('/').pop() || '').toLowerCase())
    );
    const contextFiles = [...new Set([...mentionedFiles, ...keyFiles])].slice(0, 10);
    const fileContents = contextFiles.map((rel) => {
      try {
        const content = fs.readFileSync(path.join(dir, rel), 'utf-8');
        return `### FILE: ${rel}\n\`\`\`\n${content}\n\`\`\``;
      } catch { return ''; }
    }).filter(Boolean).join('\n\n');

    return [
      `You are WebCraft Agent — an elite AI coding assistant. Today: ${today}. Language: ${language}.`,
      `\nYou control the project IDE. You MUST use tools to implement changes — never just explain.`,
      `\nYour workflow: read → plan → edit/write → check → verify → done.`,
      `\nAfter EVERY tool use, you will receive the result. Based on the result, decide what to do next.`,
      `\nWhen finished, output <done/> to signal completion.`,
      `\n\n## PROJECT: ${projectName}`,
      `\n## FILE TREE:\n${fileIndex}`,
      skillContext,
      skillCtx ? `\n\n## PROJECT KNOWLEDGE:\n${skillCtx}` : '',
      attachments?.length ? `\n\n## ATTACHMENTS: ${attachments.map((a) => a.name).join(', ')}` : '',
      fileContents ? `\n\n## LOADED FILES:\n${fileContents}` : '',
      `\n\n${toolSpec}`,
    ].join('');
  }

  // Prepare user content
  const userContent = attachments?.length
    ? _buildMultimodalContent(message, attachments)
    : message;

  // ── Agentic loop ───────────────────────────────────────────────────────────
  let hasChanges = false;
  const modifiedFiles = new Set();
  let conversationHistory = [
    { role: 'user', content: userContent },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const systemPrompt = buildSystemPrompt();
    emit({ type: 'step', step: step + 1, max: MAX_STEPS });

    // Build user message from conversation history
    // callLLMStream takes a single string, so we concatenate the conversation
    let stepResponse = '';
    const userMsg = conversationHistory.map((m) =>
      m.role === 'user' ? m.content : `[ASSISTANT RESPONSE]\n${m.content.slice(0, 6000)}`
    ).join('\n\n---\n\n');

    await callLLMStream(config, systemPrompt, userMsg, (token) => {
      stepResponse += token;
      // Stream visible text (suppress tool tags)
      const visible = token.replace(/<tool>[\s\S]*?<\/tool>/g, '').replace(/<done\s*\/>/g, '');
      if (visible) emit({ type: 'text', token: visible });
    }, { max_tokens: 16384 });

    // Check if agent signaled completion
    const isDone = stepResponse.includes('<done/>') || stepResponse.includes('<done />');

    // Extract and execute ALL tool calls from this step
    const toolRegex = /<tool>([\s\S]*?)<\/tool>/g;
    let match;
    const toolResults = [];

    while ((match = toolRegex.exec(stepResponse)) !== null) {
      let toolCall;
      try {
        // Fix common JSON issues from LLM
        let raw = match[1].trim();
        raw = raw.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
        toolCall = JSON.parse(raw);
      } catch {
        toolResults.push({ op: 'error', result: 'JSON parse failed' });
        emit({ type: 'tool', op: 'parse_error', path: '', result: 'json_parse_failed' });
        continue;
      }

      const { op, path: relPath, old: oldStr, new: newStr, content, newPath, query, glob: globPat, cmd } = toolCall;

      // Path validation (skip for path-less ops)
      const needsPath = !['list', 'search', 'sandbox', 'run'].includes(op);
      if (needsPath && (!relPath || !_isSafePath(relPath))) {
        toolResults.push({ op, path: relPath, result: 'unsafe_path' });
        emit({ type: 'tool', op, path: relPath ?? '', result: 'unsafe_path' });
        continue;
      }

      // ── read ──
      if (op === 'read') {
        const src = ProjectStore.readFile(projectName, relPath);
        const result = src !== null ? 'ok' : 'not_found';
        toolResults.push({ op: 'read', path: relPath, result, content: src?.slice(0, 16000) });
        emit({ type: 'tool', op: 'read', path: relPath, result });

      // ── check ──
      } else if (op === 'check') {
        const src = ProjectStore.readFile(projectName, relPath);
        let checkResult = 'ok';
        if (!src) { checkResult = 'file_not_found'; }
        else if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) {
          try { new Function(src); } catch (e) { checkResult = `syntax_error: ${e.message.replace(/\n.*/s, '')}`; }
        } else if (relPath.endsWith('.json')) {
          try { JSON.parse(src); } catch (e) { checkResult = `json_error: ${e.message}`; }
        } else if (relPath.endsWith('.css')) {
          const opens = (src.match(/\{/g) || []).length;
          const closes = (src.match(/\}/g) || []).length;
          if (opens !== closes) checkResult = `css_error: unbalanced braces (${opens} open, ${closes} close)`;
        } else if (relPath.endsWith('.html')) {
          checkResult = src.includes('</html>') ? 'ok' : 'missing_closing_html_tag';
        }
        toolResults.push({ op: 'check', path: relPath, result: checkResult });
        emit({ type: 'tool', op: 'check', path: relPath, result: checkResult });

      // ── lint (full diagnostics with line numbers) ──
      } else if (op === 'lint') {
        const src = ProjectStore.readFile(projectName, relPath);
        if (!src) {
          toolResults.push({ op: 'lint', path: relPath, result: 'file_not_found' });
          emit({ type: 'tool', op: 'lint', path: relPath, result: 'file_not_found' });
        } else {
          const diags = [];
          const ext = relPath.split('.').pop()?.toLowerCase();
          if (ext === 'js' || ext === 'mjs') {
            try { new Function(src); } catch (e) {
              diags.push({ line: 1, message: e.message.replace(/\n.*/s, ''), severity: 'error' });
            }
          }
          if (ext === 'json') {
            try { JSON.parse(src); } catch (e) {
              diags.push({ line: 1, message: e.message, severity: 'error' });
            }
          }
          if (ext === 'css') {
            const o = (src.match(/\{/g) || []).length, c = (src.match(/\}/g) || []).length;
            if (o !== c) diags.push({ line: src.split('\n').length, message: `Unbalanced braces: ${o} open, ${c} close`, severity: 'warning' });
          }
          if (ext === 'html' && !src.includes('</html>')) {
            diags.push({ line: src.split('\n').length, message: 'Missing </html>', severity: 'warning' });
          }
          const result = diags.length === 0 ? 'ok' : diags.map((d) => `L${d.line}: [${d.severity}] ${d.message}`).join('\n');
          toolResults.push({ op: 'lint', path: relPath, result });
          emit({ type: 'tool', op: 'lint', path: relPath, result });
        }

      // ── edit ──
      } else if (op === 'edit') {
        const src = ProjectStore.readFile(projectName, relPath);
        if (src === null) {
          toolResults.push({ op: 'edit', path: relPath, result: 'file_not_found' });
          emit({ type: 'tool', op: 'edit', path: relPath, result: 'file_not_found' });
        } else if (!src.includes(oldStr)) {
          const repaired = await _attemptEditRepair(config, relPath, src, oldStr, newStr);
          if (repaired) {
            ProjectStore.writeFile(projectName, relPath, repaired);
            hasChanges = true;
            modifiedFiles.add(relPath);
            toolResults.push({ op: 'edit', path: relPath, result: 'ok_repaired' });
            emit({ type: 'tool', op: 'edit', path: relPath, result: 'ok_repaired', oldSnippet: oldStr.slice(0, 300), newSnippet: newStr?.slice(0, 300) });
          } else {
            toolResults.push({ op: 'edit', path: relPath, result: 'old_not_found', hint: 'Use read to see current content, then retry with exact text' });
            emit({ type: 'tool', op: 'edit', path: relPath, result: 'old_not_found', oldSnippet: oldStr.slice(0, 200) });
          }
        } else {
          const newSrc = src.replace(oldStr, newStr ?? '');
          ProjectStore.writeFile(projectName, relPath, newSrc);
          hasChanges = true;
          modifiedFiles.add(relPath);
          toolResults.push({ op: 'edit', path: relPath, result: 'ok' });
          emit({ type: 'tool', op: 'edit', path: relPath, result: 'ok', oldSnippet: oldStr.slice(0, 300), newSnippet: newStr?.slice(0, 300) ?? '' });
        }

      // ── write ──
      } else if (op === 'write') {
        if (content === undefined) {
          toolResults.push({ op: 'write', path: relPath, result: 'missing_content' });
          emit({ type: 'tool', op: 'write', path: relPath, result: 'missing_content' });
        } else {
          ProjectStore.writeFile(projectName, relPath, content);
          hasChanges = true;
          modifiedFiles.add(relPath);
          toolResults.push({ op: 'write', path: relPath, result: 'ok' });
          emit({ type: 'tool', op: 'write', path: relPath, result: 'ok' });
        }

      // ── rename ──
      } else if (op === 'rename') {
        if (!newPath || !_isSafePath(newPath)) {
          toolResults.push({ op: 'rename', path: relPath, result: 'invalid_newPath' });
          emit({ type: 'tool', op: 'rename', path: relPath, result: 'invalid_newPath' });
        } else {
          const oldAbs = path.join(dir, relPath);
          const newAbs = path.join(dir, newPath);
          if (!fs.existsSync(oldAbs)) {
            toolResults.push({ op: 'rename', path: relPath, result: 'file_not_found' });
            emit({ type: 'tool', op: 'rename', path: relPath, result: 'file_not_found' });
          } else {
            ensureDir(path.dirname(newAbs));
            fs.renameSync(oldAbs, newAbs);
            hasChanges = true;
            modifiedFiles.add(newPath);
            toolResults.push({ op: 'rename', path: relPath, result: `ok → ${newPath}` });
            emit({ type: 'tool', op: 'rename', path: relPath, result: 'ok' });
          }
        }

      // ── delete ──
      } else if (op === 'delete') {
        const abs = path.join(dir, relPath);
        if (!fs.existsSync(abs)) {
          toolResults.push({ op: 'delete', path: relPath, result: 'file_not_found' });
          emit({ type: 'tool', op: 'delete', path: relPath, result: 'file_not_found' });
        } else {
          fs.unlinkSync(abs);
          hasChanges = true;
          toolResults.push({ op: 'delete', path: relPath, result: 'ok' });
          emit({ type: 'tool', op: 'delete', path: relPath, result: 'ok' });
        }

      // ── search (grep) ──
      } else if (op === 'search') {
        const matches = ProjectStore.grep(projectName, query || '', globPat);
        const resultText = matches.length === 0 ? 'no_matches'
          : matches.slice(0, 30).map((m) => `${m.file}:${m.lineNum}: ${m.line}`).join('\n');
        toolResults.push({ op: 'search', result: resultText, content: resultText });
        emit({ type: 'tool', op: 'search', path: query || '', result: `${matches.length} matches` });

      // ── list ──
      } else if (op === 'list') {
        const allFiles = _listProjectFiles(dir);
        const listing = allFiles.map((f) => {
          try {
            const stat = fs.statSync(path.join(dir, f));
            return `${f} (${stat.size} B)`;
          } catch { return f; }
        }).join('\n');
        toolResults.push({ op: 'list', result: listing, content: listing });
        emit({ type: 'tool', op: 'list', path: '', result: `${allFiles.length} files` });

      // ── run (shell command) ──
      } else if (op === 'run') {
        if (!cmd) {
          toolResults.push({ op: 'run', result: 'missing cmd' });
          emit({ type: 'tool', op: 'run', path: '', result: 'missing_cmd' });
        } else {
          // Security: block dangerous commands
          const blocked = /rm\s+-rf|rmdir|format|mkfs|dd\s+if|shutdown|reboot|kill\s+-9\s+1\b/i;
          if (blocked.test(cmd)) {
            toolResults.push({ op: 'run', result: 'blocked: dangerous command' });
            emit({ type: 'tool', op: 'run', path: cmd, result: 'blocked' });
          } else {
            try {
              const { stdout, stderr } = await execAsync(cmd, {
                cwd: dir,
                timeout: 30_000,
                env: { ...process.env, NODE_ENV: 'development' },
              });
              const output = (stdout + (stderr ? `\n[stderr] ${stderr}` : '')).slice(0, 8000);
              toolResults.push({ op: 'run', result: output || '(no output)', content: output });
              emit({ type: 'tool', op: 'run', path: cmd, result: 'ok' });
            } catch (e) {
              const errMsg = (e.stderr || e.message || '').slice(0, 2000);
              toolResults.push({ op: 'run', result: `error: ${errMsg}`, content: errMsg });
              emit({ type: 'tool', op: 'run', path: cmd, result: 'error' });
            }
          }
        }

      // ── sandbox (restart) ──
      } else if (op === 'sandbox') {
        if (sandbox.isRunning()) {
          await sandbox.stop();
        }
        try {
          const projectDir = ProjectStore.dir(projectName);
          const port = await _findFreePort(4000, 4999);
          if (port) {
            const shimDir = path.join(projectDir, '.nha-shims');
            ensureDir(shimDir);
            _writeShims(shimDir);
            const entryFile = _detectEntry(projectDir);
            if (entryFile) {
              const patchedEntry = _patchEntry(projectDir, entryFile, shimDir, port);
              const proc = spawn('node', [patchedEntry], {
                cwd: projectDir,
                env: { ...process.env, PORT: String(port), NODE_ENV: 'development', NHA_SANDBOX: '1' },
                detached: false, stdio: ['ignore', 'pipe', 'pipe'],
              });
              sandbox._sandbox = { proc, port, projectName, startedAt: new Date(), healthy: false };
              let sandboxStderr = '';
              proc.stderr.on('data', (d) => { sandboxStderr += d.toString(); });
              proc.stdout.on('data', (d) => {
                if (/listen|running|started|ready|port/i.test(d.toString())) sandbox._sandbox.healthy = true;
              });
              const healthy = await _waitForPort(port, 10_000);
              if (healthy) {
                sandbox._sandbox.healthy = true;
                toolResults.push({ op: 'sandbox', result: `ok: running on port ${port}` });
                emit({ type: 'tool', op: 'sandbox', path: '', result: `port:${port}` });
                emit({ type: 'sandbox_ready', port });
              } else {
                const errLine = sandboxStderr.split('\n').find((l) => l.includes('Error')) || 'startup timeout';
                toolResults.push({ op: 'sandbox', result: `error: ${errLine.slice(0, 500)}`, content: errLine });
                emit({ type: 'tool', op: 'sandbox', path: '', result: 'error' });
              }
            } else {
              toolResults.push({ op: 'sandbox', result: 'no entry point found' });
              emit({ type: 'tool', op: 'sandbox', path: '', result: 'no_entry' });
            }
          }
        } catch (e) {
          toolResults.push({ op: 'sandbox', result: `error: ${e.message?.slice(0, 200)}` });
          emit({ type: 'tool', op: 'sandbox', path: '', result: 'error' });
        }

      // ── diff ──
      } else if (op === 'diff') {
        const current = ProjectStore.readFile(projectName, relPath);
        // Load last snapshot
        const snapshots = SnapshotStore.list(projectName);
        if (!current) {
          toolResults.push({ op: 'diff', path: relPath, result: 'file_not_found' });
          emit({ type: 'tool', op: 'diff', path: relPath, result: 'file_not_found' });
        } else if (snapshots.length === 0) {
          toolResults.push({ op: 'diff', path: relPath, result: 'no snapshots available' });
          emit({ type: 'tool', op: 'diff', path: relPath, result: 'no_snapshots' });
        } else {
          const lastSnap = snapshots[0];
          const snapDir = SnapshotStore.dir(projectName);
          try {
            const snapData = JSON.parse(fs.readFileSync(path.join(snapDir, `${lastSnap.ts}.json`), 'utf-8'));
            const oldFile = snapData.files?.find((f) => f.name === relPath);
            const oldContent = oldFile?.content || '';
            // Simple line diff
            const oldLines = oldContent.split('\n');
            const newLines = current.split('\n');
            const diffs = [];
            const maxLen = Math.max(oldLines.length, newLines.length);
            for (let i = 0; i < maxLen; i++) {
              if (oldLines[i] !== newLines[i]) {
                if (oldLines[i] !== undefined) diffs.push(`- L${i + 1}: ${oldLines[i]}`);
                if (newLines[i] !== undefined) diffs.push(`+ L${i + 1}: ${newLines[i]}`);
              }
            }
            const diffText = diffs.length === 0 ? 'no changes' : diffs.slice(0, 100).join('\n');
            toolResults.push({ op: 'diff', path: relPath, result: diffText, content: diffText });
            emit({ type: 'tool', op: 'diff', path: relPath, result: `${diffs.length} changes` });
          } catch {
            toolResults.push({ op: 'diff', path: relPath, result: 'snapshot read error' });
            emit({ type: 'tool', op: 'diff', path: relPath, result: 'error' });
          }
        }

      // ── unknown op ──
      } else {
        toolResults.push({ op, path: relPath, result: `unknown_op: ${op}` });
        emit({ type: 'tool', op, path: relPath ?? '', result: 'unknown_op' });
      }
    }

    // If agent said done or no tools were called, break
    if (isDone || toolResults.length === 0) break;

    // Build tool results feedback for next iteration
    const feedbackParts = toolResults.map((r) => {
      let msg = `[${r.op}] ${r.path || ''}: ${r.result}`;
      if (r.op === 'read' && r.content) msg += `\n\`\`\`\n${r.content}\n\`\`\``;
      if (r.hint) msg += ` — ${r.hint}`;
      return msg;
    });

    // Add assistant response + tool results to conversation
    conversationHistory.push({ role: 'assistant', content: stepResponse });
    conversationHistory.push({ role: 'user', content: `TOOL RESULTS:\n${feedbackParts.join('\n\n')}\n\nContinue your work. When done, output <done/>` });

    // Trim conversation to avoid context overflow (keep first user msg + last 4 exchanges)
    if (conversationHistory.length > 10) {
      conversationHistory = [conversationHistory[0], ...conversationHistory.slice(-6)];
    }
  }

  // ── Post-edit: syntax check all modified JS files ──────────────────────────
  const syntaxErrors = [];
  for (const relPath of modifiedFiles) {
    if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) {
      const src = ProjectStore.readFile(projectName, relPath);
      if (src) {
        try { new Function(src); } catch (e) {
          syntaxErrors.push({ file: relPath, error: e.message.replace(/\n.*/s, '') });
        }
      }
    }
  }
  if (syntaxErrors.length > 0) {
    emit({ type: 'syntax_errors', errors: syntaxErrors });
  }

  // Log chat interaction
  if (hasChanges) {
    try {
      const logFile = path.join(SkillStore.dir(projectName), 'changes.log.md');
      const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const entry = `\n## ${ts} — Chat modification\n- User: ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}\n- Files: ${[...modifiedFiles].join(', ')}\n`;
      fs.writeFileSync(logFile, (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '') + entry, 'utf-8');
    } catch {}
  }

  // Notify about modified files so frontend can reload them
  emit({ type: 'files_changed', files: [...modifiedFiles] });

  // ── Auto-restart sandbox if running and files changed ──────────────────────
  if (hasChanges && sandbox.isRunning()) {
    emit({ type: 'sandbox_restart', msg: 'Restarting sandbox to verify changes...' });
    try {
      await sandbox.stop();
      const projectDir = ProjectStore.dir(projectName);
      // Quick restart — capture stderr for 5s to detect crash
      const port = await _findFreePort(4000, 4999);
      if (port) {
        const shimDir = path.join(projectDir, '.nha-shims');
        ensureDir(shimDir);
        _writeShims(shimDir);
        const entryFile = _detectEntry(projectDir);
        if (entryFile) {
          const patchedEntry = _patchEntry(projectDir, entryFile, shimDir, port);
          const proc = spawn('node', [patchedEntry], {
            cwd: projectDir,
            env: { ...process.env, PORT: String(port), NODE_ENV: 'development', NHA_SANDBOX: '1' },
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          sandbox._sandbox = { proc, port, projectName, startedAt: new Date(), healthy: false };

          let crashErr = '';
          proc.stderr.on('data', (d) => { crashErr += d.toString(); });
          proc.stdout.on('data', (d) => {
            if (/listen|running|started|ready|port/i.test(d.toString())) {
              sandbox._sandbox.healthy = true;
            }
          });

          const healthy = await _waitForPort(port, 8000);
          if (healthy) {
            sandbox._sandbox.healthy = true;
            emit({ type: 'sandbox_ready', port });
          } else if (crashErr) {
            // Extract error for the user
            const errLine = crashErr.split('\n').find((l) => l.includes('Error')) || crashErr.slice(0, 200);
            emit({ type: 'sandbox_error', msg: errLine });
          }
        }
      }
    } catch (e) {
      emit({ type: 'sandbox_error', msg: e.message?.slice(0, 200) });
    }
  }

  emit({ type: 'done', changed: hasChanges, syntaxErrors: syntaxErrors.length });
}

// ── Generation pipeline (SSE) ─────────────────────────────────────────────────

const FILE_PLAN_SYSTEM = `You are the lead architect of a 200-person engineering team. Design an ENTERPRISE-GRADE file structure.
Output ONLY a JSON array: [{"name":"path/to/file.ext","purpose":"detailed description","tokens":N}]
where "tokens" is your estimate of content tokens (200-600 small, 600-1500 medium, 1500-3000 large).
CRITICAL: No single file should exceed 3000 tokens. Split large files into smaller modules.

MANDATORY STRUCTURE (every project MUST have):
- package.json (with ALL dependencies: express, helmet, cors, compression, morgan, bcryptjs, jsonwebtoken, express-rate-limit, cookie-parser, dotenv)
- .env.example (all env vars documented)
- README.md (setup guide, API docs, architecture overview)
- server.js (Express with full middleware stack)
- routes/ (separate file per resource — auth.js, api.js, pages.js)
- middleware/ (auth.js, error.js, validate.js, rateLimiter.js)
- models/ (per-entity files with validation)
- controllers/ (business logic separated from routes)
- utils/ (jwt.js, hash.js, logger.js, helpers.js)
- config/ (database.js, constants.js)
- public/index.html (hero, features, testimonials, pricing, CTA, footer — complete landing page)
- public/login.html (login + register forms with validation)
- public/dashboard.html (protected page with real UI)
- public/css/variables.css (CSS custom properties: colors, fonts, spacing, breakpoints)
- public/css/reset.css (modern CSS reset)
- public/css/layout.css (grid/flexbox layouts, nav, hero, sections)
- public/css/components.css (buttons, cards, forms, modals, toasts, badges)
- public/css/animations.css (keyframes, transitions, scroll animations)
- public/css/responsive.css (media queries, mobile nav)
- public/js/app.js (SPA router, init, dark mode toggle)
- public/js/auth.js (login/register/logout, token management)
- public/js/api.js (fetch wrapper with auth headers, error handling)
- public/js/ui.js (toasts, modals, loading spinners, form validation)
- public/js/animations.js (intersection observer, scroll effects)

RULES:
- Generate 30-50 files — many small files are better than few large ones
- NEVER generate a file larger than 200 lines. Split into components/partials instead
- HTML pages: use <script src="js/page.js"> and <link href="css/page.css"> — NOT inline
- CSS: one file per concern (max 150 lines each), NOT one giant file
- JS: one file per feature (max 150 lines each)
- Token estimates must be realistic: CSS files 1500-3000, JS files 1000-2000, HTML pages 2000-4000
- Use relative paths only
- No explanation, no markdown, ONLY the JSON array.`;

// Token counter — approximate based on character count (1 token ≈ 4 chars)
function countTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Detects if an LLM output appears to be truncated / incomplete.
 * Returns true if the file likely needs a continuation call.
 */
function isFileTruncated(content, filename) {
  if (!content || content.length < 10) return true;
  const trimmed = content.trimEnd();
  const ext = filename.split('.').pop()?.toLowerCase();

  if (ext === 'js' || ext === 'mjs' || ext === 'ts') {
    const open = (trimmed.match(/\{/g) || []).length;
    const close = (trimmed.match(/\}/g) || []).length;
    if (open > close) return true; // ANY unbalanced brace = truncated
    const lastLine = trimmed.split('\n').pop()?.trim() ?? '';
    if (/[,({=+\-*/<>|&]$/.test(lastLine)) return true;
  }
  if (ext === 'css') {
    const open = (trimmed.match(/\{/g) || []).length;
    const close = (trimmed.match(/\}/g) || []).length;
    if (open > close) return true;
  }
  if (ext === 'html') {
    if (!trimmed.includes('</html>') && !trimmed.includes('</body>')) return true;
  }
  if (ext === 'json') {
    try { JSON.parse(trimmed); } catch { return true; }
  }
  return false;
}

/**
 * Deterministic repair of common truncation artifacts.
 * Adds missing closing braces, tags, etc. WITHOUT calling the LLM.
 */
function repairTruncation(content, filename) {
  if (!content) return content;
  const ext = filename.split('.').pop()?.toLowerCase();
  let result = content.trimEnd();

  if (ext === 'js' || ext === 'mjs' || ext === 'ts') {
    // Balance curly braces
    const open = (result.match(/\{/g) || []).length;
    const close = (result.match(/\}/g) || []).length;
    const missing = open - close;
    if (missing > 0 && missing <= 10) {
      result += '\n' + '}\n'.repeat(missing);
    }
    // Balance parentheses
    const openP = (result.match(/\(/g) || []).length;
    const closeP = (result.match(/\)/g) || []).length;
    const missingP = openP - closeP;
    if (missingP > 0 && missingP <= 5) {
      // Find last line and append
      const lines = result.split('\n');
      const lastIdx = lines.length - 1;
      lines[lastIdx] = lines[lastIdx] + ')'.repeat(missingP) + ';';
      result = lines.join('\n');
    }
  }

  if (ext === 'css') {
    const open = (result.match(/\{/g) || []).length;
    const close = (result.match(/\}/g) || []).length;
    const missing = open - close;
    if (missing > 0 && missing <= 10) {
      result += '\n' + '}\n'.repeat(missing);
    }
  }

  if (ext === 'html' || ext === 'htm') {
    if (!result.includes('</body>')) result += '\n</body>';
    if (!result.includes('</html>')) result += '\n</html>';
  }

  if (ext === 'json') {
    // Try to fix unclosed JSON
    try { JSON.parse(result); } catch {
      // Count brackets
      const openB = (result.match(/\[/g) || []).length;
      const closeB = (result.match(/\]/g) || []).length;
      const openC = (result.match(/\{/g) || []).length;
      const closeC = (result.match(/\}/g) || []).length;
      // Remove trailing comma if present
      result = result.replace(/,\s*$/, '');
      // Add missing closers
      if (openB > closeB) result += '\n' + ']'.repeat(openB - closeB);
      if (openC > closeC) result += '\n' + '}'.repeat(openC - closeC);
    }
  }

  return result;
}

/** Severe truncation = needs LLM continuation. Minor diffs handled by repairTruncation(). */
function _isSeverelyTruncated(content, filename) {
  if (!content || content.length < 10) return true;
  const trimmed = content.trimEnd();
  const ext = filename.split('.').pop()?.toLowerCase();
  // Last line ends mid-expression (clear cut-off)
  const lastLine = trimmed.split('\n').pop()?.trim() ?? '';
  if (/[,({=+\-*/<>|&:]$/.test(lastLine) && lastLine.length > 3) return true;
  // Large brace imbalance (>3) — repairTruncation can't reliably fix this
  if (ext === 'js' || ext === 'mjs' || ext === 'ts') {
    const diff = (trimmed.match(/\{/g) || []).length - (trimmed.match(/\}/g) || []).length;
    if (diff > 3) return true;
  }
  if (ext === 'css') {
    const diff = (trimmed.match(/\{/g) || []).length - (trimmed.match(/\}/g) || []).length;
    if (diff > 3) return true;
  }
  // HTML completely missing closing tags (not just </html> — entire sections missing)
  if (ext === 'html' && !trimmed.includes('</body>') && !trimmed.includes('</html>') && trimmed.length > 500) {
    // Check if it ends mid-tag
    const lastAngle = trimmed.lastIndexOf('<');
    if (lastAngle > trimmed.lastIndexOf('>')) return true; // mid-tag
  }
  return false;
}

async function runGenerate(config, projectName, description, blocks, authFields, emit, abortSignal) {
  const blocksDesc = Object.entries(blocks)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .join(', ');
  const authDesc = blocks.auth
    ? `Auth fields: ${authFields.map((f) => `${f.label}(${f.type}${f.required ? ',required' : ''})`).join(', ')}`
    : '';

  const planPrompt = `Project: ${projectName}
Description: ${description}
${blocksDesc ? `Required blocks: ${blocksDesc}` : ''}
${authDesc}

Design a COMPLETE production-ready file structure. Include ALL files needed for a fully working site: server, routes, middleware, models, public HTML/CSS/JS pages, config files, README. Minimum 20 files.`;

  // Emit immediately so the browser connection stays alive and the UI shows activity
  emit({ type: 'processing', msg: 'Planning file structure...' });

  // Round 1: plan files — stream so the client gets bytes immediately
  let filePlan = [];
  let planTokensIn = countTokens(FILE_PLAN_SYSTEM) + countTokens(planPrompt);
  let planTokensOut = 0;
  try {
    let planRaw = '';
    await callLLMStream(config, FILE_PLAN_SYSTEM, planPrompt, (chunk) => {
      planRaw += chunk;
      planTokensOut += countTokens(chunk);
      // Emit heartbeat tokens so browser doesn't timeout
      emit({ type: 'planning', chunk });
    }, { max_tokens: 4096 });
    const clean = planRaw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      .replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    const arr = JSON.parse(clean.match(/\[[\s\S]*\]/)?.[0] ?? clean);
    if (Array.isArray(arr)) filePlan = arr.filter((f) => f.name && _isSafePath(f.name));
  } catch {}

  if (filePlan.length === 0) {
    // Comprehensive fallback structure for a full-stack web project
    filePlan = [
      { name: 'package.json', purpose: 'Node.js dependencies and scripts', tokens: 300 },
      { name: '.env.example', purpose: 'Environment variables template', tokens: 200 },
      { name: 'README.md', purpose: 'Project documentation', tokens: 400 },
      { name: 'server.js', purpose: 'Express server entry point with middleware setup', tokens: 1500 },
      { name: 'routes/index.js', purpose: 'Main router — mounts all sub-routers', tokens: 300 },
      { name: 'routes/auth.js', purpose: 'Auth routes: register, login, logout, refresh', tokens: 1200 },
      { name: 'routes/api.js', purpose: 'REST API routes', tokens: 800 },
      { name: 'middleware/auth.js', purpose: 'JWT authentication middleware', tokens: 600 },
      { name: 'middleware/error.js', purpose: 'Global error handler', tokens: 400 },
      { name: 'middleware/validate.js', purpose: 'Request validation middleware', tokens: 500 },
      { name: 'models/user.js', purpose: 'User model (SQLite/JSON storage)', tokens: 600 },
      { name: 'controllers/authController.js', purpose: 'Auth business logic', tokens: 1200 },
      { name: 'utils/jwt.js', purpose: 'JWT sign/verify helpers', tokens: 400 },
      { name: 'utils/hash.js', purpose: 'Password hashing utilities (bcrypt)', tokens: 300 },
      { name: 'config/database.js', purpose: 'Database connection and setup', tokens: 500 },
      { name: 'public/index.html', purpose: 'Main landing page', tokens: 2000 },
      { name: 'public/dashboard.html', purpose: 'User dashboard page', tokens: 1500 },
      { name: 'public/login.html', purpose: 'Login/register page', tokens: 1200 },
      { name: 'public/css/main.css', purpose: 'Global styles, variables, reset', tokens: 1500 },
      { name: 'public/css/components.css', purpose: 'Reusable component styles (cards, buttons, forms)', tokens: 1200 },
      { name: 'public/css/layout.css', purpose: 'Layout styles: nav, hero, sections, footer', tokens: 1000 },
      { name: 'public/css/animations.css', purpose: 'Animations and transitions', tokens: 600 },
      { name: 'public/js/app.js', purpose: 'Main frontend JS — router, init', tokens: 800 },
      { name: 'public/js/auth.js', purpose: 'Frontend auth logic — login, register, token storage', tokens: 800 },
      { name: 'public/js/api.js', purpose: 'API client wrapper with fetch', tokens: 500 },
      { name: 'public/js/ui.js', purpose: 'UI helpers — toasts, modals, loaders', tokens: 600 },
    ];
  }

  emit({ type: 'plan', files: filePlan });

  const projectDir = ensureDir(ProjectStore.dir(projectName));
  const generatedFiles = [];
  let totalTokensIn = planTokensIn;
  let totalTokensOut = planTokensOut;

  const allFileNames = filePlan.map((f) => f.name).join(', ');

  // Round 2: generate each file with streaming
  for (let fi = 0; fi < filePlan.length; fi++) {
    const fileSpec = filePlan[fi];
    emit({ type: 'file_start', name: fileSpec.name, fi: fi + 1, total: filePlan.length });

    // Include last 8 generated files — key files get full content
    const prevContext = generatedFiles.slice(-8)
      .map((f) => {
        const ext = f.name.split('.').pop();
        const isKey = /^(server|app|index)\.(js|mjs)$/.test(f.name) || f.name === 'package.json';
        const maxSnippet = isKey ? 16000 : ext === 'json' ? 1200 : ext === 'css' ? 4000 : ext === 'html' ? 4000 : 3000;
        const snippet = f.content.slice(0, maxSnippet);
        return `### ${f.name}\n\`\`\`\n${snippet}${f.content.length > maxSnippet ? '\n... (truncated)' : ''}\n\`\`\``;
      })
      .join('\n\n');

    // max_tokens scaled to file size — smaller files = less truncation risk
    const estimatedTokens = fileSpec.tokens || 1500;
    const maxTokens = Math.min(Math.max(estimatedTokens * 2, 2000), 8192);

    const fileSys = `You are a team of 200 senior full-stack developers generating ENTERPRISE-GRADE production code.

OUTPUT FORMAT: Raw file content ONLY — zero explanations, zero markdown fences, zero preamble.

CODE STANDARDS (MANDATORY — every file):
- COMPLETE, WORKING code — no TODOs, no placeholders, no "add your code here"
- Every function FULLY implemented with real business logic
- Modern ES6+: async/await, const/let, destructuring, template literals, optional chaining
- Comprehensive error handling: try/catch with meaningful error messages, proper HTTP status codes

BACKEND STANDARDS:
- Express: helmet(), cors(), compression(), express-rate-limit, morgan('combined')
- JWT auth with refresh tokens, bcrypt password hashing (10+ rounds)
- Input validation on EVERY route (validate body, params, query)
- Centralized error handler middleware with structured JSON errors
- Environment variables via process.env (never hardcoded secrets)
- Security headers: X-Content-Type-Options, X-Frame-Options, HSTS
- Rate limiting per route (auth routes stricter)
- Request logging with timestamps

FRONTEND STANDARDS:
- Semantic HTML5: header, nav, main, section, article, footer
- Mobile-first responsive CSS with CSS custom properties (--primary, --bg, --text, etc.)
- Dark/light mode support via prefers-color-scheme AND manual toggle
- Smooth transitions (0.2-0.3s ease), hover states on ALL interactive elements
- Loading spinners/skeletons for async operations
- Toast notifications for success/error feedback
- Form validation with inline error messages
- Intersection Observer for scroll animations
- Accessible: aria-labels, focus styles, keyboard navigation, alt text
- Professional typography: system font stack, proper hierarchy (clamp() for fluid sizes)
- CSS Grid/Flexbox layouts — no floats
- Each file must be COMPLETE and SELF-CONTAINED — no truncation
- Maximum 200 lines per file. If more content needed, split into separate files
- HTML: external CSS/JS via link/script tags, NOT inline styles/scripts exceeding 20 lines`;

    const filePrompt = `Project: ${projectName}
Description: ${description}
${blocksDesc ? `Enabled blocks: ${blocksDesc}` : ''}
${authDesc}
Full project file list: ${allFileNames}

NOW GENERATE: ${fileSpec.name}
Purpose: ${fileSpec.purpose}

${prevContext ? `Recent files generated (for consistency):\n${prevContext}\n\n` : ''}Output ONLY the complete file content, starting immediately with the first line of the file.`;

    let fileContent = '';
    let syntaxError = null;
    const fileTokensIn = countTokens(fileSys) + countTokens(filePrompt);

    // Check abort before each file
    if (abortSignal?.aborted) {
      emit({ type: 'status', msg: 'Generation stopped by user.' });
      break;
    }

    // Retry loop — up to 2 attempts per file
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Stream chunks to browser in real-time during generation
        let rawOutput = '';
        await callLLMStream(config, fileSys, filePrompt, (chunk) => {
          rawOutput += chunk;
          // Real-time streaming to browser
          emit({ type: 'file_chunk', name: fileSpec.name, chunk, fi: fi + 1, total: filePlan.length });
        }, { max_tokens: maxTokens });

        // Strip markdown fences if LLM wrapped the output
        rawOutput = rawOutput
          .replace(/^```[\w]*\n/, '').replace(/\n```$/, '')
          .replace(/^```[\w]*\r\n/, '').replace(/\r\n```$/, '').trim();

        // Continuation loop — only for SEVERE truncation (>3 missing braces or mid-line cut)
        for (let contRound = 0; contRound < 2 && !abortSignal?.aborted && _isSeverelyTruncated(rawOutput, fileSpec.name); contRound++) {
          emit({ type: 'file_chunk', name: fileSpec.name, chunk: `\n/* ... continuing (${contRound + 1}) ... */\n`, fi: fi + 1, total: filePlan.length });
          const contPrompt = `The file ${fileSpec.name} was truncated. Continue EXACTLY from the last line. Output ONLY the remaining code (no repetition, no explanation):

LAST 600 CHARS OF WHAT WAS WRITTEN:
${rawOutput.slice(-600)}

Continue from here:`;
          let continuation = '';
          await callLLMStream(config, fileSys, contPrompt, (chunk) => {
            continuation += chunk;
            emit({ type: 'file_chunk', name: fileSpec.name, chunk, fi: fi + 1, total: filePlan.length });
          }, { max_tokens: Math.min(maxTokens, 8192) });
          continuation = continuation
            .replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();
          if (continuation.length > 20) {
            rawOutput = rawOutput + '\n' + continuation;
          } else {
            break; // continuation too short — likely done
          }
        }

        // Deterministic repair of truncation artifacts (missing braces, tags)
        fileContent = repairTruncation(rawOutput, fileSpec.name);
        syntaxError = null;

        const fileTokensOut = countTokens(fileContent);
        totalTokensIn += fileTokensIn;
        totalTokensOut += fileTokensOut;

        // Quick syntax check for JS/TS files
        if (fileSpec.name.endsWith('.js') || fileSpec.name.endsWith('.mjs')) {
          try { new Function(fileContent); } catch (e) { syntaxError = e.message.replace(/\n.*/s, ''); }
        }
        // HTML completeness check
        if (fileSpec.name.endsWith('.html') && !fileContent.includes('</html>')) {
          syntaxError = 'Missing </html> closing tag';
        }

        const abs = path.join(projectDir, fileSpec.name);
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, fileContent, 'utf-8');
        generatedFiles.push({ name: fileSpec.name, content: fileContent });
        emit({ type: 'file_done', name: fileSpec.name, fi: fi + 1, total: filePlan.length, syntaxError, tokOut: fileTokensOut, cumTokIn: totalTokensIn, cumTokOut: totalTokensOut });
        break; // success — exit retry loop

      } catch (e) {
        if (attempt === 0) {
          emit({ type: 'file_chunk', name: fileSpec.name, chunk: `\n/* Retry: ${e.message.slice(0, 100)} */\n`, fi: fi + 1, total: filePlan.length });
          continue; // retry once
        }
        emit({ type: 'file_error', name: fileSpec.name, error: e.message });
      }
    }
  }

  // ── Post-generation integrity check ──────────────────────────────────────
  if (abortSignal?.aborted) {
    emit({ type: 'done', tokIn: totalTokensIn, tokOut: totalTokensOut });
    return;
  }
  const brokenFiles = generatedFiles.filter((f) => {
    if (!f.content || f.content.length < 20) return true;
    if (f.name.endsWith('.html') && !f.content.includes('</html>')) return true;
    if ((f.name.endsWith('.js') || f.name.endsWith('.mjs'))) {
      try { new Function(f.content); } catch { return true; }
    }
    if (f.name.endsWith('.json')) {
      try { JSON.parse(f.content); } catch { return true; }
    }
    if (f.name.endsWith('.css')) {
      const opens = (f.content.match(/\{/g) || []).length;
      const closes = (f.content.match(/\}/g) || []).length;
      if (opens !== closes) return true;
    }
    return isFileTruncated(f.content, f.name);
  });

  if (brokenFiles.length > 0) {
    emit({ type: 'phase', phase: 'autofix', msg: `Post-generation fix: ${brokenFiles.length} file(s) need repair...` });
    for (const broken of brokenFiles) {
      try {
        // Step 1: Try deterministic repair first (fast, no LLM call)
        const deterministicFix = repairTruncation(broken.content, broken.name);
        let isFixed = false;
        if (deterministicFix !== broken.content) {
          // Verify the fix actually resolved the issue
          if (!isFileTruncated(deterministicFix, broken.name)) {
            emit({ type: 'status', msg: `Auto-fixed ${broken.name} (deterministic repair)` });
            broken.content = deterministicFix;
            const abs = path.join(projectDir, broken.name);
            fs.writeFileSync(abs, deterministicFix, 'utf-8');
            isFixed = true;
          }
        }
        if (isFixed) continue;

        // Step 2: If deterministic repair wasn't enough, regenerate with LLM
        if (brokenFiles.length > 15) continue; // don't LLM-regenerate too many files
        emit({ type: 'status', msg: `Regenerating ${broken.name}...` });
        let fixedContent = '';
        const fixPrompt = `Regenerate this file COMPLETELY. It was truncated or has errors.\n\nFile: ${broken.name}\nProject: ${projectName}\nDescription: ${description}\nFull file list: ${allFileNames}\n\nOutput the COMPLETE file content only, no explanation.`;
        await callLLMStream(config, fileSys, fixPrompt, (chunk) => {
          fixedContent += chunk;
        }, { max_tokens: 16384 });
        fixedContent = fixedContent
          .replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();
        fixedContent = repairTruncation(fixedContent, broken.name); // repair the regenerated content too
        if (fixedContent.length > 50) {
          broken.content = fixedContent;
          const abs = path.join(projectDir, broken.name);
          fs.writeFileSync(abs, fixedContent, 'utf-8');
          emit({ type: 'status', msg: `Fixed ${broken.name} (${fixedContent.length} chars)` });
        }
      } catch (e) {
        emit({ type: 'status', msg: `Could not fix ${broken.name}: ${e.message.slice(0, 100)}` });
      }
    }
  }

  // Save project metadata
  const meta = {
    description,
    blocks,
    authFields,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(ProjectStore.metaPath(projectName), JSON.stringify(meta, null, 2), 'utf-8');

  // Initialize skill context files (memory.md, skills.md, provider.md)
  SkillStore.ensureDefaults(projectName, config);
  const ctxDir = SkillStore.dir(projectName);

  // Generate detailed skills.md with project context knowledge structure (first time only)
  const skillsFile = path.join(ctxDir, 'skills.md');
  const skillsContent = fs.existsSync(skillsFile) ? fs.readFileSync(skillsFile, 'utf-8') : '';
  if (skillsContent.length < 100) {
    const detailedSkills = `# ${projectName} — Skills & Knowledge Structure

## Context Discovery Strategy

This project uses a hierarchical knowledge discovery system:

### 1. **Immediate Context** (Always Loaded)
- \`memory.md\` — Core architectural decisions and preferences
- \`changes.log.md\` — Recent development history
- Project metadata (tech stack, dependencies)

### 2. **On-Demand Context** (Loaded When Needed)
- **File-specific context**: When editing specific files, load related documentation
- **Feature-specific context**: Load relevant docs when working on specific features
- **Error-specific context**: Load debugging guides when errors occur

### 3. **Smart Context Loading**
Instead of loading everything at once, agents:
1. **Start with core context** (memory.md + recent changes)
2. **Analyze the task** to determine what additional context is needed
3. **Load specific context** files based on the task type
4. **Cache loaded context** for the duration of the conversation

### 4. **Context File Structure**
- \`docs/\` — Feature documentation and guides
- \`specs/\` — Technical specifications and requirements
- \`examples/\` — Code examples and patterns
- \`troubleshooting/\` — Common issues and solutions

### 5. **Context Relevance Scoring**
Agents score context relevance based on:
- **Keywords** in user requests
- **File paths** being modified
- **Error messages** encountered
- **Recent changes** in the codebase

This approach ensures agents have the right context without being overwhelmed by irrelevant information.
`;
    fs.writeFileSync(skillsFile, detailedSkills, 'utf-8');
  }

  const provider = config.llm?.provider || 'nha';
  const model = config.llm?.model || '';
  const logFile = path.join(ctxDir, 'changes.log.md');
  const logEntry = `## ${new Date().toISOString().slice(0, 10)} — Initial generation\n- Generated ${generatedFiles.length} files\n- Tokens in: ${totalTokensIn} / out: ${totalTokensOut}\n- Description: ${description}\n- Provider: ${provider} (${model || 'default'})\n`;
  fs.writeFileSync(logFile, (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '') + logEntry, 'utf-8');

  emit({ type: 'done', tokIn: totalTokensIn, tokOut: totalTokensOut });
}

// ── ZIP download ──────────────────────────────────────────────────────────────

async function sendZip(projectName, res) {
  const dir = ProjectStore.dir(projectName);
  if (!fs.existsSync(dir)) { sendError(res, 404, 'Project not found'); return; }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${_safeName(projectName)}.zip"`,
    'Access-Control-Allow-Origin': '*',
  });
  const { spawn: spawnProc } = await import('child_process');
  const zip = spawnProc('zip', ['-r', '-', '.'], { cwd: dir });
  zip.stdout.pipe(res);
  zip.stderr.on('data', () => {}); // suppress
  zip.once('exit', (code) => { if (code !== 0 && !res.writableEnded) res.end(); });
}

// ── Simple LLM call (skill AI generation) ────────────────────────────────────

async function handleLLMCall(req, res) {
  const body = await parseBody(req);
  const config = loadConfig();
  const { system, user, max_tokens = 2048 } = body;
  if (!user) return sendError(res, 400, 'user prompt required');
  try {
    const text = await callLLM(config, system ?? '', user, { max_tokens });
    sendJSON(res, 200, { text });
  } catch (e) { sendError(res, 500, e.message); }
}

// ── Route registration ────────────────────────────────────────────────────────

export function register(router) {

  // ── LLM call (skill AI generation) ────────────────────────────────────────
  router.post('/api/studio/webcraft', handleLLMCall);

  // ── Generate project — SSE ─────────────────────────────────────────────────
  router.post('/api/studio/webcraft/generate', async (req, res) => {
    const body = await parseBody(req, 1_048_576);
    const config = loadConfig();
    const { projectName, description, blocks = {}, authFields = [] } = body;
    if (!projectName || !description) return sendError(res, 400, 'projectName and description required');

    const sse = sendSSE(res);
    // Abort signal: triggered when client disconnects (user clicks Stop)
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    res.on('close', () => ac.abort());
    try {
      await runGenerate(config, projectName, description, blocks, authFields, sse.send, ac.signal);
    } catch (e) {
      if (e.name !== 'AbortError') sse.send({ type: 'error', msg: e.message });
    }
    sse.end();
  });

  // ── Projects list ─────────────────────────────────────────────────────────
  router.get('/api/studio/webcraft/projects', (_req, res) => {
    try { sendJSON(res, 200, { projects: ProjectStore.list() }); }
    catch (e) { sendError(res, 500, e.message); }
  });

  // ── Project load ──────────────────────────────────────────────────────────
  router.get(/^\/api\/studio\/webcraft\/projects\/load\/(?<name>[^?]+)/, (req, res) => {
    const projectName = decodeURIComponent(req.params.name ?? '');
    const data = ProjectStore.load(projectName);
    if (!data) return sendError(res, 404, 'Project not found');
    sendJSON(res, 200, data);
  });

  // ── Project save ──────────────────────────────────────────────────────────
  router.post('/api/studio/webcraft/projects/save', async (req, res) => {
    try {
      const { projectName, description, files } = await parseBody(req, 10_485_760);
      if (!projectName || !Array.isArray(files)) return sendError(res, 400, 'projectName and files required');
      ProjectStore.save(projectName, description ?? '', files);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Project delete ────────────────────────────────────────────────────────
  router.delete(/^\/api\/studio\/webcraft\/projects\/(?<name>[^?]+)/, async (req, res) => {
    try {
      const projectName = decodeURIComponent(req.params.name ?? '');
      ProjectStore.delete(projectName);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Chat save ─────────────────────────────────────────────────────────────
  router.post('/api/studio/webcraft/projects/chat/save', async (req, res) => {
    try {
      const { projectName, chat } = await parseBody(req, 5_242_880);
      if (!projectName) return sendError(res, 400, 'projectName required');
      ChatStore.save(projectName, chat ?? []);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Chat load ─────────────────────────────────────────────────────────────
  router.get(/^\/api\/studio\/webcraft\/projects\/chat\/load\/(?<name>[^?]+)/, (req, res) => {
    const projectName = decodeURIComponent(req.params.name ?? '');
    sendJSON(res, 200, { chat: ChatStore.load(projectName) });
  });

  // ── Skills get ────────────────────────────────────────────────────────────
  router.get(/^\/api\/studio\/webcraft\/skills\/(?<name>[^/?]+)(?:\?|$)/, (req, res) => {
    const projectName = decodeURIComponent(req.params.name ?? '');
    // Always ensure defaults exist when loading skills
    SkillStore.ensureDefaults(projectName, loadConfig());
    sendJSON(res, 200, { skills: SkillStore.list(projectName) });
  });

  // ── Skills save ───────────────────────────────────────────────────────────
  router.post(/^\/api\/studio\/webcraft\/skills\/(?<name>[^/?]+)(?:\?|$)/, async (req, res) => {
    try {
      const projectName = decodeURIComponent(req.params.name ?? '');
      const { skills } = await parseBody(req);
      if (!Array.isArray(skills)) return sendError(res, 400, 'skills array required');
      SkillStore.save(projectName, skills);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Skill delete ──────────────────────────────────────────────────────────
  router.post(/^\/api\/studio\/webcraft\/skills\/(?<name>[^/?]+)\/delete(?:\?|$)/, async (req, res) => {
    try {
      const projectName = decodeURIComponent(req.params.name ?? '');
      const { name: skillName } = await parseBody(req);
      SkillStore.delete(projectName, skillName);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Diagnostics (lint) — returns errors/warnings for a file ───────────────
  router.post('/api/studio/webcraft/lint', async (req, res) => {
    try {
      const { projectName, path: relPath } = await parseBody(req);
      if (!projectName || !relPath) return sendError(res, 400, 'projectName and path required');
      const content = ProjectStore.readFile(projectName, relPath);
      if (content === null) return sendJSON(res, 200, { diagnostics: [] });

      const diagnostics = [];
      const ext = relPath.split('.').pop()?.toLowerCase();

      if (ext === 'js' || ext === 'mjs' || ext === 'jsx') {
        try { new Function(content); } catch (e) {
          const match = e.message.match(/^(.*?)$/m);
          const lineMatch = e.message.match(/:(\d+):(\d+)/);
          diagnostics.push({
            from: lineMatch ? { line: parseInt(lineMatch[1]), col: parseInt(lineMatch[2]) } : { line: 1, col: 0 },
            severity: 'error',
            message: match?.[1] || e.message,
          });
        }
      }

      if (ext === 'json') {
        try { JSON.parse(content); } catch (e) {
          const posMatch = e.message.match(/position (\d+)/);
          const pos = posMatch ? parseInt(posMatch[1]) : 0;
          const lines = content.slice(0, pos).split('\n');
          diagnostics.push({
            from: { line: lines.length, col: (lines[lines.length - 1] || '').length },
            severity: 'error',
            message: e.message,
          });
        }
      }

      if (ext === 'css') {
        const opens = (content.match(/\{/g) || []).length;
        const closes = (content.match(/\}/g) || []).length;
        if (opens !== closes) {
          diagnostics.push({
            from: { line: content.split('\n').length, col: 0 },
            severity: 'warning',
            message: `Unbalanced braces: ${opens} open, ${closes} close`,
          });
        }
      }

      if (ext === 'html' || ext === 'htm') {
        if (!content.includes('</html>')) {
          diagnostics.push({
            from: { line: content.split('\n').length, col: 0 },
            severity: 'warning',
            message: 'Missing </html> closing tag',
          });
        }
      }

      sendJSON(res, 200, { diagnostics });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── File write (from IDE editor) ──────────────────────────────────────────
  router.post('/api/studio/webcraft/file/write', async (req, res) => {
    try {
      const { projectName, path: relPath, content } = await parseBody(req, 10_485_760);
      if (!projectName || !relPath || content === undefined) return sendError(res, 400, 'projectName, path, content required');
      if (!_isSafePath(relPath)) return sendError(res, 400, 'unsafe path');
      ProjectStore.writeFile(projectName, relPath, content);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Sandbox start — SSE ───────────────────────────────────────────────────
  router.post('/api/studio/webcraft/sandbox/start', async (req, res) => {
    const { projectName } = await parseBody(req);
    if (!projectName) return sendError(res, 400, 'projectName required');
    const projectDir = ProjectStore.dir(projectName);

    const sse = sendSSE(res);
    try {
      await sandbox.start(projectName, projectDir, sse.send);
    } catch (e) {
      sse.send({ type: 'error', msg: e.message });
    }
    sse.end();
  });

  // ── Sandbox stop ──────────────────────────────────────────────────────────
  router.delete('/api/studio/webcraft/sandbox', async (_req, res) => {
    try {
      await sandbox.stop();
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Sandbox status ────────────────────────────────────────────────────────
  router.get('/api/studio/webcraft/sandbox/status', (_req, res) => {
    sendJSON(res, 200, sandbox.status());
  });

  // ── WebCraft Agent chat — SSE ─────────────────────────────────────────────
  router.post('/api/studio/webcraft/agent', async (req, res) => {
    const body = await parseBody(req, 10_485_760);
    const config = loadConfig();
    const { projectName, message, attachments = [] } = body;
    if (!projectName || !message) return sendError(res, 400, 'projectName and message required');

    const sse = sendSSE(res);
    try {
      await runWebCraftAgent(config, projectName, message, attachments, sse.send);
    } catch (e) {
      sse.send({ type: 'error', msg: e.message });
    }
    sse.end();
  });

  // ── Autofix queue ─────────────────────────────────────────────────────────
  router.get('/api/studio/webcraft/agent/autofix-queue', (_req, res) => {
    // The UI manages autofix state client-side; server reports sandbox crash if any
    sendJSON(res, 200, { queue: [], sandboxRunning: sandbox.isRunning(), sandboxPort: sandbox.port });
  });

  // ── Grep ──────────────────────────────────────────────────────────────────
  router.post('/api/studio/webcraft/grep', async (req, res) => {
    try {
      const { projectName, query } = await parseBody(req);
      if (!projectName || !query) return sendError(res, 400, 'projectName and query required');
      sendJSON(res, 200, { matches: ProjectStore.grep(projectName, query) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Snapshot create ───────────────────────────────────────────────────────
  router.post('/api/studio/webcraft/snapshot', async (req, res) => {
    try {
      const { projectName } = await parseBody(req);
      if (!projectName) return sendError(res, 400, 'projectName required');
      const ts = SnapshotStore.take(projectName);
      if (!ts) return sendError(res, 500, 'Snapshot failed');
      sendJSON(res, 200, { snapshot: ts });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Snapshots list ────────────────────────────────────────────────────────
  router.get(/^\/api\/studio\/webcraft\/snapshots\/(?<name>[^?]+)/, (req, res) => {
    const projectName = decodeURIComponent(req.params.name ?? '');
    sendJSON(res, 200, { snapshots: SnapshotStore.list(projectName) });
  });

  // ── Snapshot restore ──────────────────────────────────────────────────────
  router.post('/api/studio/webcraft/restore', async (req, res) => {
    try {
      const { projectName, ts } = await parseBody(req);
      if (!projectName || !ts) return sendError(res, 400, 'projectName and ts required');
      const ok = SnapshotStore.restore(projectName, ts);
      if (!ok) return sendError(res, 404, 'Snapshot not found');
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Syntax check ──────────────────────────────────────────────────────────
  router.post('/api/studio/webcraft/syntax-check', async (req, res) => {
    try {
      const { projectName } = await parseBody(req);
      if (!projectName) return sendError(res, 400, 'projectName required');
      sendJSON(res, 200, { results: ProjectStore.syntaxCheck(projectName) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── ZIP download ───────────────────────────────────────────────────────────
  router.get(/^\/api\/studio\/webcraft\/download\/(?<name>[^?]+)/, (req, res) => {
    const projectName = decodeURIComponent(req.params.name ?? '');
    sendZip(projectName, res).catch((e) => sendError(res, 500, e.message));
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _safeName(name) {
  return (name ?? '').replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || 'unnamed';
}

function _isSafePath(relPath) {
  if (!relPath || typeof relPath !== 'string') return false;
  if (relPath.includes('..') || path.isAbsolute(relPath)) return false;
  if (relPath.startsWith('.nha-')) return false; // protect internal dirs
  return true;
}

function _listProjectFiles(dir, relBase = '') {
  const results = [];
  try {
    for (const entry of fs.readdirSync(path.join(dir, relBase), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) results.push(..._listProjectFiles(dir, rel));
      else results.push(rel);
    }
  } catch {}
  return results;
}

function _detectEntry(dir) {
  for (const name of ['server.js', 'app.js', 'index.js', 'server.mjs', 'app.mjs', 'index.mjs']) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  // Try package.json main
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return pkg.main;
  } catch {}
  return null;
}

function _patchEntry(projectDir, entryFile, shimDir, port) {
  // Write a launcher that injects shims and then requires the actual entry
  const launcherPath = path.join(projectDir, '.nha-launcher.js');
  const entryAbs = path.join(projectDir, entryFile).replace(/\\/g, '/');
  const shimAbs = path.join(shimDir, 'index.js').replace(/\\/g, '/');
  const launcher = [
    `// NHA WebCraft Sandbox Launcher — auto-generated`,
    `process.env.PORT = process.env.PORT || '${port}';`,
    `process.env.NODE_ENV = 'development';`,
    `// Inject shims before loading user code`,
    `require('${shimAbs}');`,
    `require('${entryAbs}');`,
  ].join('\n');
  fs.writeFileSync(launcherPath, launcher, 'utf-8');
  return '.nha-launcher.js';
}

function _writeShims(shimDir) {
  // In-memory pg replacement
  const pgShim = `
const EventEmitter = require('events');
class Client extends EventEmitter {
  constructor() { super(); this.connected = false; }
  async connect() { this.connected = true; }
  async query(text, params) { return { rows: [], rowCount: 0 }; }
  async end() { this.connected = false; }
  release() {}
}
class Pool extends EventEmitter {
  constructor() { super(); }
  async query(text, params) { return { rows: [], rowCount: 0 }; }
  async connect() { return new Client(); }
  async end() {}
  on() { return this; }
}
module.exports = { Client, Pool, default: { Client, Pool } };
`;

  // In-memory redis replacement
  const redisShim = `
class MemoryStore {
  constructor() { this._store = new Map(); this._timers = new Map(); }
  async get(k) { return this._store.get(k) ?? null; }
  async set(k, v, ...args) {
    this._store.set(k, v);
    const exIdx = args.indexOf('EX');
    if (exIdx >= 0) {
      clearTimeout(this._timers.get(k));
      this._timers.set(k, setTimeout(() => this._store.delete(k), args[exIdx + 1] * 1000));
    }
    return 'OK';
  }
  async del(k) { return this._store.delete(k) ? 1 : 0; }
  async exists(k) { return this._store.has(k) ? 1 : 0; }
  async expire(k, s) { return 1; }
  async ttl(k) { return -1; }
  async hget(k, f) { return (this._store.get(k) ?? {})[f] ?? null; }
  async hset(k, f, v) { const m = this._store.get(k) ?? {}; m[f] = v; this._store.set(k, m); return 1; }
  async hgetall(k) { return this._store.get(k) ?? null; }
  async lpush(k, ...vals) { const a = this._store.get(k) ?? []; a.unshift(...vals); this._store.set(k, a); return a.length; }
  async lrange(k, s, e) { const a = this._store.get(k) ?? []; return a.slice(s, e < 0 ? undefined : e + 1); }
  async incr(k) { const v = (parseInt(this._store.get(k)) || 0) + 1; this._store.set(k, String(v)); return v; }
  async keys(pattern) { return [...this._store.keys()]; }
  async flushall() { this._store.clear(); return 'OK'; }
  on(ev, cb) { return this; }
  createClient() { return new MemoryStore(); }
}
const store = new MemoryStore();
module.exports = store;
module.exports.createClient = () => store;
module.exports.default = store;
`;

  // Security headers shim (express middleware)
  const helmetShim = `module.exports = () => (req, res, next) => next();`;

  // Generic no-op shim for unknown enterprise deps
  const noopShim = `module.exports = new Proxy({}, { get: () => new Proxy(() => {}, { get: (_, p) => p === 'then' ? undefined : new Proxy(() => {}, { get: (__, q) => q === 'then' ? undefined : () => {} }) }) });`;

  fs.writeFileSync(path.join(shimDir, 'pg.js'), pgShim, 'utf-8');
  fs.writeFileSync(path.join(shimDir, 'redis.js'), redisShim, 'utf-8');
  fs.writeFileSync(path.join(shimDir, 'helmet.js'), helmetShim, 'utf-8');
  fs.writeFileSync(path.join(shimDir, 'ioredis.js'), redisShim, 'utf-8');
  fs.writeFileSync(path.join(shimDir, 'mongoose.js'), noopShim, 'utf-8');
  fs.writeFileSync(path.join(shimDir, 'sequelize.js'), noopShim, 'utf-8');

  // Shim index — overrides require() for known modules via Module._resolveFilename
  const shimIndex = `
const Module = require('module');
const path = require('path');
const __shimDir = ${JSON.stringify(shimDir)};

const SHIMS = {
  'pg': path.join(__shimDir, 'pg.js'),
  'redis': path.join(__shimDir, 'redis.js'),
  'ioredis': path.join(__shimDir, 'redis.js'),
  'helmet': path.join(__shimDir, 'helmet.js'),
  'mongoose': path.join(__shimDir, 'mongoose.js'),
  'sequelize': path.join(__shimDir, 'sequelize.js'),
};

const _original = Module._resolveFilename.bind(Module);
Module._resolveFilename = function(request, parent, isMain, options) {
  if (SHIMS[request]) return SHIMS[request];
  return _original(request, parent, isMain, options);
};
`;
  fs.writeFileSync(path.join(shimDir, 'index.js'), shimIndex, 'utf-8');
}

/** Find a free TCP port in [min, max]. */
function _findFreePort(min, max) {
  return new Promise((resolve) => {
    let current = min;
    const tryNext = () => {
      if (current > max) { resolve(null); return; }
      const server = createServer();
      server.once('error', () => { current++; tryNext(); });
      server.listen(current, '127.0.0.1', () => {
        server.close(() => resolve(current));
      });
    };
    tryNext();
  });
}

/** Poll until port is open or timeout expires. */
function _waitForPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const sock = createServer();
      sock.once('error', () => {
        // Port is still closed by us — it means the app is listening
        resolve(true);
      });
      sock.listen(port, '127.0.0.1', () => {
        // We could bind it → app hasn't taken the port yet
        sock.close();
        if (Date.now() > deadline) { resolve(false); return; }
        setTimeout(check, 300);
      });
    };
    check();
  });
}

/**
 * If the exact old_string wasn't found, ask the LLM to produce the corrected file.
 * Returns the new file content or null if repair failed.
 */
async function _attemptEditRepair(config, relPath, currentContent, oldStr, newStr) {
  try {
    const repairSys = `You are a code repair agent. You receive a file, an intended old snippet, and a replacement. The old snippet doesn't match exactly. Apply the semantically equivalent change and return ONLY the complete corrected file content.`;
    const repairPrompt = `FILE: ${relPath}\n\nCURRENT CONTENT:\n${currentContent.slice(0, 6000)}\n\nINTENDED CHANGE:\nOLD (approximate):\n${oldStr.slice(0, 1000)}\n\nNEW:\n${newStr?.slice(0, 1000) ?? ''}\n\nReturn ONLY the complete corrected file.`;
    const result = await callLLM(config, repairSys, repairPrompt, { max_tokens: 4096 });
    if (result && result.trim()) return result;
  } catch {}
  return null;
}

function _buildMultimodalContent(text, attachments) {
  // Return structured content for vision-capable models
  const parts = [{ type: 'text', text }];
  for (const a of attachments) {
    if (a.mimeType?.startsWith('image/')) {
      parts.push({ type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.base64 } });
    }
  }
  return JSON.stringify(parts); // callLLM handles string content; vision needs provider-specific handling
}
