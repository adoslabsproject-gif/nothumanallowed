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
import { callLLM, callLLMStream } from '../../services/llm.mjs';
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
  async start(projectName, projectDir, emit) {
    // Kill any existing sandbox
    if (this.isRunning()) {
      emit({ type: 'status', msg: 'Stopping previous sandbox...' });
      await this.stop();
    }

    if (!fs.existsSync(projectDir)) {
      emit({ type: 'error', msg: `Project directory not found: ${projectDir}` });
      return;
    }

    // ── Inject shims so user projects run without real DB / Redis ──────────
    const shimDir = path.join(projectDir, '.nha-shims');
    ensureDir(shimDir);
    _writeShims(shimDir);

    const entryFile = _detectEntry(projectDir);
    if (!entryFile) {
      emit({ type: 'error', msg: 'No entry point found (server.js / app.js / index.js).' });
      return;
    }

    // ── Install dependencies ────────────────────────────────────────────────
    if (fs.existsSync(path.join(projectDir, 'package.json'))) {
      emit({ type: 'status', msg: 'Installing dependencies (npm install)...' });
      try {
        await execAsync('npm install --prefer-offline --no-audit --no-fund', {
          cwd: projectDir,
          timeout: 120_000,
          env: { ...process.env, NODE_ENV: 'development' },
        });
        emit({ type: 'status', msg: 'Dependencies installed.' });
      } catch (e) {
        emit({ type: 'warn', msg: `npm install warning: ${e.message.slice(0, 200)}` });
      }
    }

    // ── Find a free port ────────────────────────────────────────────────────
    const port = await _findFreePort(4000, 4999);
    if (!port) {
      emit({ type: 'error', msg: 'No free ports available in range 4000-4999.' });
      return;
    }

    emit({ type: 'status', msg: `Starting on port ${port}...` });

    // Patch entry file to use our shims and bind to the found port
    const patchedEntry = _patchEntry(projectDir, entryFile, shimDir, port);

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

    proc.stdout.on('data', (d) => {
      const line = d.toString().trim();
      if (line) emit({ type: 'log', msg: line });
      if (/listen|running|started|ready|port/i.test(line)) {
        if (this._sandbox) this._sandbox.healthy = true;
        emit({ type: 'ready', port });
      }
    });

    proc.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) emit({ type: 'log', msg: `[stderr] ${line}` });
    });

    proc.once('exit', (code) => {
      if (this._sandbox?.proc === proc) this._sandbox = null;
      emit({ type: 'exit', code: code ?? -1 });
    });

    // Healthcheck: wait up to 15s for the process to bind the port
    const healthy = await _waitForPort(port, 15_000);
    if (healthy && this._sandbox) {
      this._sandbox.healthy = true;
      emit({ type: 'ready', port });
    } else if (!healthy) {
      emit({ type: 'warn', msg: 'Sandbox started but port not yet bound — may still be loading.' });
    }
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
  const dir = ProjectStore.dir(projectName);
  if (!fs.existsSync(dir)) { emit({ type: 'error', msg: 'Project not found' }); return; }

  const files = _listProjectFiles(dir);
  const skillCtx = SkillStore.context(projectName);

  const fileIndex = files.map((f) => `- ${f}`).join('\n');
  const today = new Date().toISOString().slice(0, 10);
  const LANG_MAP = { en:'English',it:'Italian',es:'Spanish',fr:'French',de:'German',pt:'Portuguese' };
  const language = LANG_MAP[(config?.language||'it').slice(0,2)] || 'Italian';

  // Build context: include files mentioned in the message or all files if ≤ 8
  const mentionedFiles = files.filter((f) => message.toLowerCase().includes(f.toLowerCase().split('/').pop() ?? ''));
  const contextFiles = mentionedFiles.length > 0 ? mentionedFiles : files.slice(0, 8);
  const fileContents = contextFiles.map((rel) => {
    try {
      const content = fs.readFileSync(path.join(dir, rel), 'utf-8');
      return `### FILE: ${rel}\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``;
    } catch { return ''; }
  }).filter(Boolean).join('\n\n');

  const toolSpec = `
AVAILABLE TOOLS (use XML tags exactly as shown):

1. Read a file:
<tool>{"op":"read","path":"filename.js"}</tool>

2. Edit a file (replace a snippet):
<tool>{"op":"edit","path":"filename.js","old":"EXACT_EXISTING_CODE","new":"REPLACEMENT_CODE"}</tool>

3. Write a complete file (full content):
<tool>{"op":"write","path":"filename.js","content":"FULL_FILE_CONTENT"}</tool>

RULES:
- Always use edit for small targeted changes (preferred — faster and safer)
- Use write only when creating a new file or doing a complete rewrite
- "old" must be an EXACT verbatim match of the existing code — no paraphrasing
- Never apply a tool to a file outside the project scope
- After each tool use, continue explaining what you did
`;

  const systemPrompt = [
    `You are WebCraft Agent, an expert full-stack developer. Today is ${today}. Respond in ${language}.`,
    `\n\n## PROJECT: ${projectName}`,
    `\n## FILES:\n${fileIndex}`,
    skillCtx ? `\n\n## CONTEXT (Skills/Memory):\n${skillCtx}` : '',
    attachments?.length ? `\n\n## ATTACHMENTS: ${attachments.map((a) => a.name).join(', ')}` : '',
    `\n\n## CURRENT FILE CONTENTS:\n${fileContents}`,
    `\n\n${toolSpec}`,
    `\n\nIMPORTANT: Be precise, surgical, and explain every change.`,
  ].join('');

  // Prepare user content (text + images if any)
  const userContent = attachments?.length
    ? _buildMultimodalContent(message, attachments)
    : message;

  let fullResponse = '';
  let hasChanges = false;

  await callLLMStream(config, systemPrompt, userContent, (token) => {
    fullResponse += token;
    // Suppress raw <tool> blocks from text stream — only emit visible text
    const visibleToken = token.replace(/<tool>[\s\S]*?<\/tool>/g, '');
    if (visibleToken) emit({ type: 'text', token: visibleToken });
  }, { max_tokens: 8192 });

  // ── Execute all tool calls found in the response ───────────────────────────
  const toolRegex = /<tool>([\s\S]*?)<\/tool>/g;
  let match;
  while ((match = toolRegex.exec(fullResponse)) !== null) {
    let toolCall;
    try { toolCall = JSON.parse(match[1].trim()); } catch {
      emit({ type: 'tool', op: 'parse_error', path: '', result: 'json_parse_failed' });
      continue;
    }

    const { op, path: relPath, old: oldStr, new: newStr, content } = toolCall;
    if (!relPath || !_isSafePath(relPath)) {
      emit({ type: 'tool', op, path: relPath ?? '', result: 'unsafe_path' });
      continue;
    }

    if (op === 'read') {
      const src = ProjectStore.readFile(projectName, relPath);
      emit({ type: 'tool', op: 'read', path: relPath, result: src !== null ? 'ok' : 'not_found' });

    } else if (op === 'edit') {
      const src = ProjectStore.readFile(projectName, relPath);
      if (src === null) {
        emit({ type: 'tool', op: 'edit', path: relPath, result: 'file_not_found' });
      } else if (!src.includes(oldStr)) {
        // Fallback: try LLM-assisted repair
        const repaired = await _attemptEditRepair(config, relPath, src, oldStr, newStr);
        if (repaired) {
          ProjectStore.writeFile(projectName, relPath, repaired);
          hasChanges = true;
          emit({ type: 'tool', op: 'edit', path: relPath, result: 'ok_repaired', oldSnippet: oldStr.slice(0, 300), newSnippet: newStr.slice(0, 300) });
        } else {
          emit({ type: 'tool', op: 'edit', path: relPath, result: 'old_not_found', oldSnippet: oldStr.slice(0, 200) });
        }
      } else {
        const newSrc = src.replace(oldStr, newStr ?? '');
        ProjectStore.writeFile(projectName, relPath, newSrc);
        hasChanges = true;
        emit({ type: 'tool', op: 'edit', path: relPath, result: 'ok', oldSnippet: oldStr.slice(0, 300), newSnippet: newStr?.slice(0, 300) ?? '' });
      }

    } else if (op === 'write') {
      if (content === undefined) {
        emit({ type: 'tool', op: 'write', path: relPath, result: 'missing_content' });
      } else {
        ProjectStore.writeFile(projectName, relPath, content);
        hasChanges = true;
        emit({ type: 'tool', op: 'write', path: relPath, result: 'ok' });
      }
    }
  }

  emit({ type: 'done', changed: hasChanges });
}

// ── Generation pipeline (SSE) ─────────────────────────────────────────────────

const FILE_PLAN_SYSTEM = `You are an expert full-stack web developer. Your job is to design the complete file structure for a web project.
Output ONLY a JSON array of file objects: [{"name":"filename","purpose":"brief purpose"}]
Rules:
- Include ALL necessary files: HTML, CSS, JS, server, package.json, .env.example, README.md
- Use relative paths (e.g. "public/styles.css", "routes/auth.js")
- No explanation, no markdown, ONLY the JSON array.`;

async function runGenerate(config, projectName, description, blocks, authFields, emit) {
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
Design a complete file structure for this project.`;

  // Round 1: plan files
  let filePlan = [];
  try {
    const planRaw = await callLLM(config, FILE_PLAN_SYSTEM, planPrompt, { max_tokens: 1500 });
    const clean = planRaw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      .replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    const arr = JSON.parse(clean.match(/\[[\s\S]*\]/)?.[0] ?? clean);
    if (Array.isArray(arr)) filePlan = arr.filter((f) => f.name && _isSafePath(f.name));
  } catch {}

  if (filePlan.length === 0) {
    // Minimal fallback structure
    filePlan = [
      { name: 'index.html', purpose: 'Main HTML page' },
      { name: 'styles.css', purpose: 'CSS styles' },
      { name: 'app.js', purpose: 'Application logic' },
      { name: 'server.js', purpose: 'Express server' },
      { name: 'package.json', purpose: 'Node.js package manifest' },
    ];
  }

  emit({ type: 'plan', files: filePlan });

  const projectDir = ensureDir(ProjectStore.dir(projectName));
  const generatedFiles = [];

  // Round 2: generate each file
  for (let fi = 0; fi < filePlan.length; fi++) {
    const fileSpec = filePlan[fi];
    emit({ type: 'file_start', name: fileSpec.name, fi: fi + 1, total: filePlan.length });

    const allFileNames = filePlan.map((f) => f.name).join(', ');
    const prevContext = generatedFiles.slice(-3)
      .map((f) => `### ${f.name} (excerpt)\n${f.content.slice(0, 800)}`)
      .join('\n\n');

    const fileSys = `You are an expert full-stack web developer generating production-quality code.
Output ONLY the complete file content — no explanation, no markdown fences, no comments about what you're doing.
Write real, working, modern code. Do NOT use placeholder text like "TODO" or "// add code here".`;

    const filePrompt = `Project: ${projectName}
Description: ${description}
${blocksDesc ? `Required blocks: ${blocksDesc}` : ''}
${authDesc}
All files in project: ${allFileNames}

Generate COMPLETE content for: ${fileSpec.name}
Purpose: ${fileSpec.purpose}
${prevContext ? `\n--- Recent files for context ---\n${prevContext}` : ''}

Output ONLY the complete file content.`;

    let fileContent = '';
    let syntaxError = null;

    try {
      await callLLMStream(config, fileSys, filePrompt, (chunk) => {
        fileContent += chunk;
        emit({ type: 'file_chunk', name: fileSpec.name, chunk, fi: fi + 1, total: filePlan.length });
      }, { max_tokens: 4096 });

      // Quick syntax check for JS files
      if (fileSpec.name.endsWith('.js') || fileSpec.name.endsWith('.mjs')) {
        try { new Function(fileContent); } catch (e) { syntaxError = e.message.replace(/\n.*/s, ''); }
      }

      const abs = path.join(projectDir, fileSpec.name);
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, fileContent, 'utf-8');
      generatedFiles.push({ name: fileSpec.name, content: fileContent });
      emit({ type: 'file_done', name: fileSpec.name, fi: fi + 1, total: filePlan.length, syntaxError });
    } catch (e) {
      emit({ type: 'file_error', name: fileSpec.name, error: e.message });
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

  // Initialize skill context files
  const ctxDir = ensureDir(SkillStore.dir(projectName));
  const memFile = path.join(ctxDir, 'memory.md');
  if (!fs.existsSync(memFile)) {
    fs.writeFileSync(memFile, `# ${projectName} — Project Memory\n\n_Add architectural decisions, preferences, and notes here._\n`, 'utf-8');
  }
  const logFile = path.join(ctxDir, 'changes.log.md');
  const logEntry = `## ${new Date().toISOString().slice(0, 10)} — Initial generation\n- Generated ${generatedFiles.length} files\n- Description: ${description}\n`;
  fs.writeFileSync(logFile, (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '') + logEntry, 'utf-8');

  const inputTokensEst = Math.round(filePlan.length * 800);
  const outputTokensEst = generatedFiles.reduce((sum, f) => sum + Math.ceil(f.content.length / 4), 0);
  emit({ type: 'done', tokIn: inputTokensEst, tokOut: outputTokensEst });
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
    try {
      await runGenerate(config, projectName, description, blocks, authFields, sse.send);
    } catch (e) {
      sse.send({ type: 'error', msg: e.message });
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
