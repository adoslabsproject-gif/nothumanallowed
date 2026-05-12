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
import { exec, spawn, execSync } from 'child_process';
import { createServer, Socket } from 'net';
import { promisify } from 'util';
import { createRequire } from 'module';
// `require` shim for the rare spots where CJS-style require() was historically
// used in this ESM file. Without this, every `require(...)` here throws
// "ReferenceError: require is not defined" — which is exactly the bug that
// took 31 releases to diagnose because it surfaced in the SSE error channel.
const require = createRequire(import.meta.url);
import { sendJSON, sendError, parseBody, sendSSE } from '../index.mjs';
import { loadConfig }   from '../../config.mjs';
import { callLLM, callLLMStream, callLLMWithTools, getApiKey, fixQwen3BPE } from '../../services/llm.mjs';
import { NHA_DIR } from '../../constants.mjs';
import * as acorn from 'acorn';
import acornJsx from 'acorn-jsx';

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
    this._stoppedByUser = false;
  }

  isRunning() {
    if (!this._sandbox || !this._sandbox.proc) return false;
    if (this._sandbox.proc.killed) { this._sandbox = null; return false; }
    // Verify the process is actually alive (not zombie)
    try { process.kill(this._sandbox.proc.pid, 0); return true; } catch { this._sandbox = null; return false; }
  }

  status() {
    if (!this.isRunning()) return { running: false };
    const { port, projectName, startedAt, healthy } = this._sandbox;
    return { running: true, port, projectName, startedAt, healthy };
  }

  /** Returns the port of the running sandbox or null. */
  get port() { return this.isRunning() ? this._sandbox.port : null; }

  async stop() {
    if (!this._sandbox) return;
    this._stoppedByUser = true;
    const { proc, port } = this._sandbox;
    this._sandbox = null;

    // 1. Kill process directly + process group + all children
    try {
      // Direct kill first — most reliable
      try { proc.kill('SIGKILL'); } catch {}
      if (proc.pid) {
        // Also kill the process group
        try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
        try { process.kill(proc.pid, 'SIGKILL'); } catch {}
      }
      // Wait for exit
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    } catch {}

    // 2. Force-kill any orphan processes still holding the port
    if (port) {
      try {
        if (process.platform === 'win32') {
          await execAsync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`, { timeout: 3000 });
        } else {
          const { stdout } = await execAsync(`lsof -ti:${port} 2>/dev/null || true`, { timeout: 2000 });
          const pids = stdout.trim().split(/\s+/).filter(Boolean);
          for (const pid of pids) { try { process.kill(parseInt(pid), 'SIGKILL'); } catch {} }
        }
      } catch {}
      // Wait for OS to release the port
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /**
   * Starts the sandbox and streams progress via SSE.
   * @param {string} projectName
   * @param {string} projectDir
   * @param {(event: object) => void} emit
   */
  async start(projectName, projectDir, emit, _attempt = 1) {
    const MAX_RETRIES = 3;
    this._stoppedByUser = false;

    // Server version banner — lets the user verify their `nha ui` process is
    // actually running the latest code (npm install only updates files on disk;
    // the running process must be killed and restarted to pick them up).
    if (_attempt === 1) {
      try {
        const { VERSION } = await import('../../constants.mjs');
        emit({ type: 'status', msg: `nha sandbox manager v${VERSION} — if this is older than what you installed, kill nha ui and restart it (the running process won't pick up new code by itself)` });
      } catch { /* non-fatal */ }
    }

    // Kill any existing sandbox
    if (this.isRunning()) {
      emit({ type: 'phase', phase: 'cleanup', msg: 'Stopping previous sandbox...' });
      await this.stop();
      // CRITICAL: `stop()` sets `_stoppedByUser = true` so the dying process'
      // crash isn't misreported. We MUST reset it here, otherwise the brand
      // new sandbox we're about to spawn will exit silently on any crash —
      // bypassing both Tier 1 (npm install) and Tier 2 (LLM/rename) autofix.
      // This was the root cause of the "require is not defined — no autofix
      // ever runs" bug. The flag intent is per-process, not persistent.
      this._stoppedByUser = false;
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
    // Kill orphan sandbox processes on ports 4000-4010 (survive server restart)
    try {
      if (process.platform === 'win32') {
        for (let p = 4000; p <= 4010; p++) {
          try { await execAsync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${p} ^| findstr LISTENING') do taskkill /F /PID %a`, { timeout: 3000 }); } catch {}
        }
      } else {
        // Try lsof first, then fuser
        for (let p = 4000; p <= 4010; p++) {
          try {
            const { stdout } = await execAsync(`lsof -ti:${p} 2>/dev/null || fuser ${p}/tcp 2>/dev/null`, { timeout: 2000 });
            const pids = stdout.trim().split(/\s+/).filter(Boolean);
            for (const pid of pids) { try { process.kill(parseInt(pid), 'SIGKILL'); } catch {} }
          } catch {}
        }
      }
      await new Promise((r) => setTimeout(r, 800));
    } catch {}
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
      detached: true,
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

    // Capture spawn-level errors (e.g. ENOENT on 'node', permission denied).
    // Without this handler, Node would throw an unhandled 'error' event and
    // the whole nha ui process could die silently. This is the missing path
    // that produced the "[error] require is not defined" with no autofix flow.
    proc.on('error', (err) => {
      stderrBuf += `\n[spawn error] ${err.message}\n${err.stack || ''}\n`;
      emit({ type: 'warn', msg: `[spawn error] ${err.code || ''} ${err.message}` });
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
    // If user pressed Stop, don't report as crash. We ALSO log this so we
    // can see in the UI when the stoppedByUser flag is what's blocking the
    // autofix flow (was a real bug pre-15.1.24).
    if (this._stoppedByUser) {
      emit({ type: 'warn', msg: 'Crash handling skipped: _stoppedByUser=true (user pressed Stop, or previous stop() leaked the flag). If this is unexpected, restart nha ui to pick up the latest fix.' });
      return;
    }
    emit({ type: 'status', msg: `Process exited with code ${exitCode} (attempt ${_attempt}/${MAX_RETRIES})` });
    // Surface the captured stderr right away so the user sees the REAL error
    // (not just the post-Tier-2 summary). This is the diagnostic gold.
    if (stderrBuf && stderrBuf.trim()) {
      const stderrSnippet = stderrBuf.split('\n').slice(0, 20).join('\n');
      emit({ type: 'log', msg: `[stderr full capture, ${stderrBuf.length} bytes]\n${stderrSnippet}` });
    } else {
      emit({ type: 'warn', msg: 'Process exited but stderr is EMPTY — could be: process killed by OS, spawn failed before any output, or stdio mis-routed. Run "node .nha-launcher.js" manually in the project dir to reproduce.' });
    }

    // ── Tier 1: missing module → npm install + retry ─────────────────────
    const missingMatch = stderrBuf.match(/Cannot find module ['"]([^'"]+)['"]/);
    if (missingMatch && _attempt < MAX_RETRIES) {
      const missingMod = missingMatch[1];
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

    // ── Tier 2: runtime errors that need code fix (require/import mismatch,
    //   SyntaxError, ReferenceError, TypeError) — extract failing file from
    //   stack trace and ask LLM to repair it. This is the bug the user hit:
    //   "require is not defined" inside an ESM project should auto-rewrite
    //   require() → import statements, or flip package.json "type" field. ───
    const runtimePatterns = [
      { name: 'CJS/ESM mismatch',   re: /require is not defined/i,
        hint: 'The file uses CommonJS `require()` but the project is ESM ("type":"module" in package.json or .mjs extension). Convert all `require(\'X\')` to ES module `import` statements. Convert `module.exports = ...` to `export default ...`. Keep all logic identical.' },
      { name: 'ESM/CJS mismatch',   re: /Cannot use import statement outside a module/i,
        hint: 'The file uses ES module `import` but the project is CommonJS. Either add `"type":"module"` to package.json (preferred for new projects) or convert imports to `require()`.' },
      { name: 'import.meta misuse', re: /import\.meta(?:\.url)? is only valid in/i,
        hint: 'The file uses `import.meta` in a CommonJS context. Either switch the project to ESM (add `"type":"module"` to package.json) or replace `import.meta.url` with `__filename` / `__dirname`.' },
      { name: 'SyntaxError',        re: /SyntaxError:.+/i,
        hint: 'The file has a JavaScript syntax error. Fix the syntax issue — unclosed brackets, missing commas, invalid tokens. Output the complete corrected file.' },
      { name: 'ReferenceError',     re: /ReferenceError: (\w+) is not defined/i,
        hint: 'A variable is referenced but never declared/imported. Either import it from the correct module or declare it. Common missing globals: "require" (use import), "process" (Node only — add `import process from \'node:process\'` in ESM), "__dirname" (in ESM use `import.meta.url` + fileURLToPath).' },
      { name: 'TypeError null/undefined', re: /TypeError: Cannot read prop(?:erties|erty)? .+ of (?:undefined|null)/i,
        hint: 'Null/undefined access. Add a null-check or optional chaining (?.) before the failing access.' },
    ];

    const matchedPattern = runtimePatterns.find(p => p.re.test(stderrBuf));
    // ALWAYS log the autofix decision, so the user can see why Tier 2 fires
    // or doesn't fire. Previous versions emitted nothing when matchedPattern
    // was undefined — leaving the user confused why no autofix ran.
    if (!matchedPattern) {
      emit({ type: 'warn', msg: `Auto-fix: no known runtime pattern matched in stderr. Patterns checked: ${runtimePatterns.map(p => p.name).join(', ')}. stderr starts with: "${stderrBuf.slice(0, 200).replace(/\n/g, ' ⏎ ')}"` });
    } else if (_attempt >= MAX_RETRIES) {
      emit({ type: 'warn', msg: `Auto-fix: pattern "${matchedPattern.name}" matched but MAX_RETRIES (${MAX_RETRIES}) reached. Stopping.` });
    }
    if (matchedPattern && _attempt < MAX_RETRIES) {
      emit({ type: 'phase', phase: 'autofix', msg: `Runtime error detected: ${matchedPattern.name} — analyzing...` });

      const pkgPath = path.join(projectDir, 'package.json');
      const isRequireError = /require is not defined/i.test(stderrBuf);
      const isImportError  = /Cannot use import statement outside a module/i.test(stderrBuf);

      // ── Extract file path from stack trace (multiple patterns) ──
      // Try several regex forms to be robust against various Node stack formats.
      const allPaths = new Set();
      // Form A: "at /abs/path/file.js:N:M" or "at file:///abs/path/file.js:N:M"
      for (const m of stderrBuf.matchAll(/(?:file:\/\/)?(\/[^\s:()'"]+\.(?:m?js|cjs|jsx?|tsx?)):\d+(?::\d+)?/g)) {
        allPaths.add(m[1]);
      }
      // Form B: ESM error header "file:///path/file.js:N"
      for (const m of stderrBuf.matchAll(/file:\/\/(\/[^\s:'"]+\.(?:m?js|cjs|jsx?|tsx?)):?\d*/g)) {
        allPaths.add(m[1]);
      }
      // Form C: bare absolute path at start of line (Node prints this for CJS syntax)
      for (const m of stderrBuf.matchAll(/^(\/[^\s:'"]+\.(?:m?js|cjs|jsx?|tsx?))(?::\d+)?$/gm)) {
        allPaths.add(m[1]);
      }

      // First filter: paths that look like they live in this project
      let projectFiles = [...allPaths]
        .filter(p => p.startsWith(projectDir) || p.includes('/' + path.basename(projectDir) + '/'))
        .map(p => p.startsWith(projectDir) ? path.relative(projectDir, p) : null)
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 5);

      // FALLBACK: if no stack-trace files matched, scan the project directory
      // for all .js / .mjs / .cjs files (excluding node_modules) and pick the
      // ones that contain `require(` or `import` — those are the candidates.
      if (projectFiles.length === 0) {
        emit({ type: 'status', msg: `Stack trace did not reveal a file in project — scanning project files...` });
        try {
          const _walk = (dir, out = []) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
              if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
              const abs = path.join(dir, ent.name);
              if (ent.isDirectory()) _walk(abs, out);
              else if (/\.(m?js|cjs)$/.test(ent.name)) out.push(abs);
            }
            return out;
          };
          const allJs = _walk(projectDir);
          // Heuristic — pick files matching the error semantics
          const triggers = isRequireError
            ? /\brequire\s*\(/
            : isImportError ? /^\s*import\s+/m
            : /\brequire\s*\(|^\s*import\s+/m;
          const candidates = allJs
            .filter(abs => {
              try { return triggers.test(fs.readFileSync(abs, 'utf-8')); } catch { return false; }
            })
            .slice(0, 3);
          projectFiles = candidates.map(abs => path.relative(projectDir, abs));
        } catch (e) {
          emit({ type: 'warn', msg: `Project scan failed: ${e.message.slice(0, 200)}` });
        }
      }

      // ── Deterministic fixes BEFORE LLM repair (faster, no token cost) ──
      // The trick is to consider the file extension because it overrides
      // package.json "type" in Node.
      let deterministicFixApplied = false;
      if ((isRequireError || isImportError) && projectFiles.length > 0) {
        for (const rel of projectFiles) {
          const ext = path.extname(rel).toLowerCase();
          const abs = path.join(projectDir, rel);

          // Case A: file is .mjs (forced ESM) using require() → rename to .cjs
          // This is the FAST fix Node itself suggests in the error message.
          if (isRequireError && ext === '.mjs') {
            const newAbs = abs.replace(/\.mjs$/i, '.cjs');
            try {
              fs.renameSync(abs, newAbs);
              // Update package.json "main" if it pointed to the old file
              if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.main && pkg.main.endsWith(rel)) {
                  pkg.main = pkg.main.replace(/\.mjs$/i, '.cjs');
                  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
                }
              }
              emit({ type: 'status', msg: `Auto-fix: renamed ${rel} → ${path.basename(newAbs)} (Node suggests this for CJS-in-.mjs)` });
              deterministicFixApplied = true;
            } catch (e) {
              emit({ type: 'warn', msg: `Rename ${rel} failed: ${e.message.slice(0, 200)}` });
            }
          }
          // Case B: file is .cjs (forced CJS) using import → rename to .mjs
          else if (isImportError && ext === '.cjs') {
            const newAbs = abs.replace(/\.cjs$/i, '.mjs');
            try {
              fs.renameSync(abs, newAbs);
              if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.main && pkg.main.endsWith(rel)) {
                  pkg.main = pkg.main.replace(/\.cjs$/i, '.mjs');
                  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
                }
              }
              emit({ type: 'status', msg: `Auto-fix: renamed ${rel} → ${path.basename(newAbs)} (Node suggests this for import-in-.cjs)` });
              deterministicFixApplied = true;
            } catch (e) {
              emit({ type: 'warn', msg: `Rename ${rel} failed: ${e.message.slice(0, 200)}` });
            }
          }
        }
      }

      // Case C: ambiguous .js files — toggle package.json "type"
      // ONLY effective when files are .js (extension doesn't force a mode)
      if (!deterministicFixApplied && (isRequireError || isImportError) && fs.existsSync(pkgPath)) {
        const onlyJsFiles = projectFiles.every(p => path.extname(p).toLowerCase() === '.js');
        if (onlyJsFiles) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (isImportError && pkg.type !== 'module') {
              pkg.type = 'module';
              fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
              emit({ type: 'status', msg: 'Auto-fix: added "type":"module" to package.json (for .js with import)' });
              deterministicFixApplied = true;
            } else if (isRequireError && pkg.type === 'module') {
              delete pkg.type;
              fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
              emit({ type: 'status', msg: 'Auto-fix: removed "type":"module" from package.json (for .js with require)' });
              deterministicFixApplied = true;
            }
          } catch (e) {
            emit({ type: 'warn', msg: `package.json toggle failed: ${e.message.slice(0, 200)}` });
          }
        }
      }

      if (deterministicFixApplied) {
        emit({ type: 'status', msg: `Auto-fix: restarting sandbox (attempt ${_attempt + 1}/${MAX_RETRIES})...` });
        return this.start(projectName, projectDir, emit, _attempt + 1);
      }

      if (projectFiles.length === 0) {
        emit({ type: 'warn', msg: `Auto-fix: could not identify a target file to repair. Stack trace shown above.` });
      } else {
        emit({ type: 'phase', phase: 'autofix', msg: `Auto-fix repairing ${projectFiles.length} file(s) with LLM: ${projectFiles.join(', ')}` });
        let anyFixed = false;
        for (const rel of projectFiles) {
          const abs = path.join(projectDir, rel);
          let original = '';
          try { original = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
          if (!original) continue;

          const errSnippet = stderrBuf.split('\n').slice(0, 30).join('\n');
          const fixPrompt =
`A Node.js sandbox crashed with this runtime error:

${errSnippet.slice(0, 1500)}

The failing file is: ${rel}

What to fix: ${matchedPattern.hint}

CRITICAL: Output ONLY the complete corrected file content. No commentary, no markdown fences. Keep all working logic intact — only change what's necessary to fix the error.

Current file content:
${original.slice(0, 12_000)}`;

          try {
            emit({ type: 'status', msg: `Auto-fix: rewriting ${rel}...` });
            let fixed = '';
            await callLLMStream(loadConfig(), 'You are a precise code repair assistant. Output only the corrected file, no explanation.', fixPrompt, (c) => { fixed += c; }, { max_tokens: 16384 });
            fixed = fixed.replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();
            if (fixed.length > 20 && fixed !== original) {
              fs.writeFileSync(abs, fixed, 'utf-8');
              emit({ type: 'status', msg: `Auto-fix: ✓ repaired ${rel} (${fixed.length} chars)` });
              anyFixed = true;
            } else {
              emit({ type: 'warn', msg: `Auto-fix: LLM returned no useful change for ${rel}` });
            }
          } catch (e) {
            emit({ type: 'warn', msg: `Auto-fix: LLM repair of ${rel} failed — ${(e.message || '').slice(0, 200)}` });
          }
        }
        if (anyFixed) {
          emit({ type: 'status', msg: `Auto-fix: restarting sandbox (attempt ${_attempt + 1}/${MAX_RETRIES})...` });
          return this.start(projectName, projectDir, emit, _attempt + 1);
        }
      }
    }

    // Show the actual error from stderr — include full trace for debugging
    const stderrLines = stderrBuf.split('\n').filter(l => l.trim());
    const errLine = stderrLines.find((l) => l.includes('Error') || l.includes('error'));
    const stackLines = stderrLines.filter(l => l.includes('at ') || l.includes('Error')).slice(0, 5).join('\n');
    const errDetail = errLine || stderrBuf.slice(0, 500) || 'No error output captured';
    const fullErr = stackLines ? `${errDetail}\n${stackLines}` : errDetail;
    emit({ type: 'error', msg: _attempt >= MAX_RETRIES
      ? `Failed after ${MAX_RETRIES} attempts (exit ${exitCode}):\n${fullErr}`
      : `Crash (exit ${exitCode}):\n${fullErr}` });
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

  /** Ensure memory.md, skills.md, and provider.md always exist with useful content. */
  ensureDefaults(projectName, config) {
    const dir = ensureDir(this.dir(projectName));
    const provider = config?.llm?.provider || 'nha';
    const model = config?.llm?.model || '';
    const projectDir = path.join(NHA_DIR, 'webcraft', projectName);

    // Scan project files for auto-generating context
    let fileList = '';
    try {
      const files = fs.readdirSync(projectDir, { recursive: true })
        .filter((f) => !String(f).includes('node_modules') && !String(f).startsWith('.nha-') && !String(f).startsWith('.'));
      fileList = files.slice(0, 30).join(', ');
    } catch {}

    const needsWrite = (filePath, minLen = 150) => {
      if (!fs.existsSync(filePath)) return true;
      return fs.readFileSync(filePath, 'utf-8').length < minLen;
    };

    const memFile = path.join(dir, 'memory.md');
    if (needsWrite(memFile)) {
      fs.writeFileSync(memFile, `# ${projectName} — Project Memory

## Project Files
${fileList || '_No files generated yet_'}

## Architecture
- Express.js server with middleware stack
- Vanilla HTML/CSS/JS frontend
- JSON file storage (no external DB)

## Development Notes
_The AI agent updates this file as you build. Ask it to add features one by one._
_Example: "Add user authentication" or "Add a contact form"_

## Completed Features
_None yet — start building!_
`, 'utf-8');
    }

    const skillsFile = path.join(dir, 'skills.md');
    if (needsWrite(skillsFile)) {
      fs.writeFileSync(skillsFile, `# ${projectName} — Skills & Conventions

## Code Style
- Modern ES6+: const/let, arrow functions, async/await, template literals
- Express routes: router.get/post/put/delete with error handling
- CSS: custom properties (--primary, --bg), mobile-first, flexbox/grid
- HTML: semantic tags, accessible (aria-labels, focus styles)

## File Structure
- server.js — main entry, middleware, routes
- public/ — static HTML/CSS/JS
- routes/ — Express route handlers
- middleware/ — auth, validation, error handling
- models/ — data models with JSON storage

## Patterns
- Always validate input on server side
- Use try/catch for async operations
- Return proper HTTP status codes (200, 201, 400, 401, 404, 500)
- CSS variables for theming, transitions for hover states
`, 'utf-8');
    }

    const providerFile = path.join(dir, `${provider}.md`);
    if (needsWrite(providerFile)) {
      fs.writeFileSync(providerFile, `# ${provider.toUpperCase()} — ${model || 'Default'}

## Project: ${projectName}

## Instructions for Code Generation
- Generate COMPLETE files — never truncate
- Use external CSS/JS via link/script tags
- Every function must be fully implemented — no TODOs or placeholders
- Handle errors gracefully with try/catch
- Mobile-first responsive design
- Dark mode support via CSS custom properties

## Available Tools
read, edit, write, rename, delete, check, lint, search, list, run, sandbox, diff

## Workflow
1. Read files before editing
2. Make surgical edits (not full rewrites unless needed)
3. Check/lint after modifications
4. Restart sandbox to verify
`, 'utf-8');
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
async function runWebCraftAgent(config, projectName, message, attachments, emit, isAborted = () => false) {
  const MAX_STEPS = 8; // max agentic loop iterations
  const dir = ProjectStore.dir(projectName);
  if (!fs.existsSync(dir)) { emit({ type: 'error', msg: 'Project not found' }); return; }

  SkillStore.ensureDefaults(projectName, config);

  const today = new Date().toISOString().slice(0, 10);
  const LANG_MAP = { en:'English',it:'Italian',es:'Spanish',fr:'French',de:'German',pt:'Portuguese' };
  const language = LANG_MAP[(config?.language||'it').slice(0,2)] || 'Italian';

  // Native tool definitions for function calling (Anthropic/OpenAI)
  const nativeTools = [
    { name: 'read_file', description: 'Read a file from the project', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path to the file' } }, required: ['path'] } },
    { name: 'edit_file', description: 'Make a surgical edit to an existing file. The old_text must be an EXACT match of the current file content. Copy-paste from read_file output.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path' }, old_text: { type: 'string', description: 'Exact text to replace (copy from read_file output)' }, new_text: { type: 'string', description: 'Replacement text' } }, required: ['path', 'old_text', 'new_text'] } },
    { name: 'create_file', description: 'Create a new file. ONLY for files that do not exist yet. Cannot overwrite existing files.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path' }, content: { type: 'string', description: 'Full file content' } }, required: ['path', 'content'] } },
    { name: 'delete_file', description: 'Delete a file', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path' } }, required: ['path'] } },
    { name: 'list_files', description: 'List all project files', input_schema: { type: 'object', properties: {} } },
    { name: 'search_files', description: 'Search for text in project files', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search pattern' }, glob: { type: 'string', description: 'File glob pattern (e.g. *.js)' } }, required: ['query'] } },
    { name: 'run_command', description: 'Run a shell command in the project directory', input_schema: { type: 'object', properties: { command: { type: 'string', description: 'Shell command' } }, required: ['command'] } },
    { name: 'check_syntax', description: 'Check file for syntax errors', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path' } }, required: ['path'] } },
    { name: 'restart_sandbox', description: 'Restart the sandbox server to test changes', input_schema: { type: 'object', properties: {} } },
  ];

  // System prompt for native tool calling (no <tool> tags needed)
  const toolInstructions = `
WORKFLOW: read_file → edit_file (surgical changes) → check_syntax → restart_sandbox

RULES:
- To modify existing files: ALWAYS use edit_file. NEVER use create_file on existing files — it will fail.
- edit_file: read the file first, then copy EXACT text from the read output as old_text.
- To APPEND to a truncated file: old_text = last few lines, new_text = those lines + new content.
- Keep each edit SMALL — max 30-40 lines. Do MULTIPLE edits for larger changes.
- If edit_file fails (old_text not found): read the file again, copy the EXACT text, retry.
- NEVER say you fixed something without verifying with check_syntax.
- create_file is ONLY for brand new files.
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
      `\nAfter EVERY tool use, you will receive the result. Based on the result, decide what to do next.`,
      `\n\n## PROJECT: ${projectName}`,
      `\n## FILE TREE:\n${fileIndex}`,
      skillContext,
      skillCtx ? `\n\n## PROJECT KNOWLEDGE:\n${skillCtx}` : '',
      attachments?.length ? `\n\n## ATTACHMENTS: ${attachments.map((a) => a.name).join(', ')}` : '',
      fileContents ? `\n\n## LOADED FILES:\n${fileContents}` : '',
      `\n\n${toolInstructions}`,
    ].join('');
  }

  // Prepare user content
  const userContent = attachments?.length
    ? _buildMultimodalContent(message, attachments)
    : message;

  // ── Agentic loop — native tool calling ────────────────────────────────────
  let hasChanges = false;
  const modifiedFiles = new Set();

  // Tool execution handler — called by callLLMWithTools for each tool_use
  async function handleToolCall(toolName, input) {
    const relPath = input.path;
    if (relPath && !_isSafePath(relPath)) return 'Error: unsafe path';

    if (toolName === 'read_file') {
      const src = ProjectStore.readFile(projectName, relPath);
      emit({ type: 'tool', op: 'read', path: relPath, result: src ? 'ok' : 'not_found' });
      return src !== null ? src.slice(0, 16000) : 'Error: file not found';
    }

    if (toolName === 'edit_file') {
      const src = ProjectStore.readFile(projectName, relPath);
      if (!src) { emit({ type: 'tool', op: 'edit', path: relPath, result: 'file_not_found' }); return 'Error: file not found'; }
      const oldStr = input.old_text;
      const newStr = input.new_text;
      if (src.includes(oldStr)) {
        const newSrc = src.replace(oldStr, newStr ?? '');
        ProjectStore.writeFile(projectName, relPath, newSrc);
        hasChanges = true;
        modifiedFiles.add(relPath);
        emit({ type: 'tool', op: 'edit', path: relPath, result: 'ok', oldSnippet: oldStr.slice(0, 2000), newSnippet: (newStr ?? '').slice(0, 2000) });
        return 'OK — edit applied successfully';
      }
      // Fuzzy match
      const oldLines = oldStr.split('\n').map(l => l.trim());
      const srcLines = src.split('\n');
      let matchStart = -1;
      for (let i = 0; i <= srcLines.length - oldLines.length; i++) {
        let ok = true;
        for (let j = 0; j < oldLines.length; j++) {
          if (srcLines[i + j].trim() !== oldLines[j]) { ok = false; break; }
        }
        if (ok) { matchStart = i; break; }
      }
      if (matchStart >= 0) {
        const before = srcLines.slice(0, matchStart).join('\n');
        const after = srcLines.slice(matchStart + oldLines.length).join('\n');
        const result = (before ? before + '\n' : '') + (newStr ?? '') + (after ? '\n' + after : '');
        ProjectStore.writeFile(projectName, relPath, result);
        hasChanges = true;
        modifiedFiles.add(relPath);
        emit({ type: 'tool', op: 'edit', path: relPath, result: 'ok', oldSnippet: oldStr.slice(0, 2000), newSnippet: (newStr ?? '').slice(0, 2000) });
        return 'OK — edit applied (fuzzy match)';
      }
      emit({ type: 'tool', op: 'edit', path: relPath, result: 'old_not_found' });
      return 'Error: old_text not found in file. Use read_file to see the EXACT current content, copy the exact lines, and retry.';
    }

    if (toolName === 'create_file') {
      const existing = ProjectStore.readFile(projectName, relPath);
      if (existing !== null) {
        emit({ type: 'tool', op: 'write', path: relPath, result: 'blocked_use_edit' });
        return 'Error: file already exists. Use edit_file to modify it.';
      }
      ProjectStore.writeFile(projectName, relPath, input.content ?? '');
      hasChanges = true;
      modifiedFiles.add(relPath);
      emit({ type: 'tool', op: 'write', path: relPath, result: 'ok', newSnippet: (input.content ?? '').slice(0, 500) });
      return 'OK — file created';
    }

    if (toolName === 'delete_file') {
      const abs = path.join(dir, relPath);
      if (fs.existsSync(abs)) { fs.unlinkSync(abs); hasChanges = true; modifiedFiles.add(relPath); }
      emit({ type: 'tool', op: 'delete', path: relPath, result: 'ok' });
      return 'OK — file deleted';
    }

    if (toolName === 'list_files') {
      const files = _listProjectFiles(dir);
      emit({ type: 'tool', op: 'list', path: '', result: `${files.length} files` });
      return files.map(f => `- ${f}`).join('\n');
    }

    if (toolName === 'search_files') {
      const matches = ProjectStore.grep(projectName, input.query);
      emit({ type: 'tool', op: 'search', path: '', result: `${matches.length} matches` });
      return matches.length === 0 ? 'No matches found' : matches.slice(0, 20).map(m => `${m.file}:${m.lineNum}: ${m.line}`).join('\n');
    }

    if (toolName === 'run_command') {
      const blocked = /rm\s+-rf|rmdir|format|mkfs|dd\s+if|shutdown|reboot|kill\s+-9\s+1\b/i;
      if (blocked.test(input.command)) { emit({ type: 'tool', op: 'run', path: '', result: 'blocked' }); return 'Error: dangerous command blocked'; }
      try {
        const { stdout, stderr } = await execAsync(input.command, { cwd: dir, timeout: 30000, env: { ...process.env, NODE_ENV: 'development' } });
        emit({ type: 'tool', op: 'run', path: '', result: 'ok' });
        return (stdout + (stderr ? '\n[stderr] ' + stderr : '')).slice(0, 4000) || 'OK — no output';
      } catch (e) {
        emit({ type: 'tool', op: 'run', path: '', result: 'error' });
        return `Error: ${(e.stderr || e.message || '').slice(0, 2000)}`;
      }
    }

    if (toolName === 'check_syntax') {
      const src = ProjectStore.readFile(projectName, relPath);
      if (!src) { emit({ type: 'tool', op: 'check', path: relPath, result: 'not_found' }); return 'File not found'; }
      const ext = relPath.split('.').pop()?.toLowerCase();
      let result = 'ok';
      if (ext === 'js' || ext === 'mjs') { try { new Function(src); } catch (e) { result = `syntax_error: ${e.message.replace(/\n.*/s, '')}`; } }
      else if (ext === 'json') { try { JSON.parse(src); } catch (e) { result = `json_error: ${e.message}`; } }
      else if (ext === 'html') { result = src.includes('</html>') ? 'ok' : 'missing </html> tag'; }
      emit({ type: 'tool', op: 'check', path: relPath, result });
      return result === 'ok' ? 'OK — no syntax errors' : result;
    }

    if (toolName === 'restart_sandbox') {
      if (sandbox.isRunning()) await sandbox.stop();
      try {
        const port = await _findFreePort(4000, 4999);
        if (port) {
          const shimDir = path.join(dir, '.nha-shims');
          ensureDir(shimDir);
          _writeShims(shimDir);
          const entryFile = _detectEntry(dir);
          if (entryFile) {
            const patchedEntry = _patchEntry(dir, entryFile, shimDir, port);
            const proc = spawn('node', [patchedEntry], { cwd: dir, env: { ...process.env, PORT: String(port), NODE_ENV: 'development', NHA_SANDBOX: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
            sandbox._sandbox = { proc, port, projectName, startedAt: new Date(), healthy: false };
            const healthy = await _waitForPort(port, 10000);
            if (healthy) { sandbox._sandbox.healthy = true; emit({ type: 'sandbox_ready', port }); return `OK — sandbox running on port ${port}`; }
          }
        }
      } catch {}
      emit({ type: 'tool', op: 'sandbox', path: '', result: 'error' });
      return 'Error: sandbox failed to start';
    }

    return `Error: unknown tool ${toolName}`;
  }

  // Try native tool calling first (Anthropic, OpenAI)
  const provider = config.llm?.provider || 'anthropic';
  const useNativeTools = provider === 'anthropic' || provider === 'openai';

  if (useNativeTools) {
    const systemPrompt = buildSystemPrompt();
    const messages = [{ role: 'user', content: userContent }];

    await callLLMWithTools(config, systemPrompt, messages, nativeTools,
      (text) => emit({ type: 'text', token: text }),
      handleToolCall,
      { max_tokens: 16384, isAborted, maxTurns: MAX_STEPS }
    );
  } else {
    // Fallback for other providers — use old text-based <tool> system
    // (kept for backward compatibility with Gemini, DeepSeek, etc.)
    let conversationHistory = [{ role: 'user', content: userContent }];
    emit({ type: 'text', token: 'Note: Using text-based tools (native tool calling not available for this provider).\n' });
    // Minimal old-style loop with <tool> tags — simplified
    for (let step = 0; step < MAX_STEPS; step++) {
      if (isAborted()) break;
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
    // First try matched pairs, then handle truncated (unclosed) tool tags
    const toolRegex = /<tool>([\s\S]*?)<\/tool>/g;
    let match;
    const toolResults = [];
    const matchedRanges = [];

    while ((match = toolRegex.exec(stepResponse)) !== null) {
      matchedRanges.push([match.index, match.index + match[0].length]);
      let toolCall;
      try {
        let raw = match[1].trim();
        raw = raw.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
        toolCall = JSON.parse(raw);
      } catch {
        // LLM often puts raw HTML/code inside JSON values without proper escaping.
        // Extract fields manually using a robust regex-based parser.
        try {
          toolCall = _parseToolCallRobust(match[1].trim());
        } catch (parseErr2) {
          console.error('[TOOL-PARSE] JSON parse failed even after robust parse:', parseErr2.message, 'raw:', match[1].slice(0, 200));
          toolResults.push({ op: 'error', result: 'JSON parse failed' });
          emit({ type: 'tool', op: 'parse_error', path: '', result: 'json_parse_failed' });
          continue;
        }
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
        console.log(`[EDIT-DEBUG] path=${relPath} oldStr.length=${oldStr?.length ?? 'null'} newStr.length=${newStr?.length ?? 'null'}`);
        if (oldStr) console.log(`[EDIT-DEBUG] old first 100: ${JSON.stringify(oldStr.slice(0, 100))}`);
        const src = ProjectStore.readFile(projectName, relPath);
        if (src === null) {
          toolResults.push({ op: 'edit', path: relPath, result: 'file_not_found' });
          emit({ type: 'tool', op: 'edit', path: relPath, result: 'file_not_found' });
        } else if (src.includes(oldStr)) {
          console.log(`[EDIT-DEBUG] EXACT MATCH found — applying edit`);
          // Exact match — apply directly
          const newSrc = src.replace(oldStr, newStr ?? '');
          ProjectStore.writeFile(projectName, relPath, newSrc);
          hasChanges = true;
          modifiedFiles.add(relPath);
          toolResults.push({ op: 'edit', path: relPath, result: 'ok' });
          emit({ type: 'tool', op: 'edit', path: relPath, result: 'ok', oldSnippet: oldStr.slice(0, 2000), newSnippet: newStr?.slice(0, 2000) ?? '' });
        } else {
          console.log(`[EDIT-DEBUG] NO exact match — trying fuzzy. src.length=${src.length} oldStr.length=${oldStr?.length}`);
          // Fuzzy match: compare lines ignoring leading/trailing whitespace
          const oldLines = oldStr.split('\n').map(l => l.trim());
          const srcLines = src.split('\n');
          let matchStart = -1;
          for (let i = 0; i <= srcLines.length - oldLines.length; i++) {
            let ok = true;
            for (let j = 0; j < oldLines.length; j++) {
              if (srcLines[i + j].trim() !== oldLines[j]) { ok = false; break; }
            }
            if (ok) { matchStart = i; break; }
          }
          if (matchStart >= 0) {
            // Fuzzy matched — replace the matched lines with new content
            const before = srcLines.slice(0, matchStart).join('\n');
            const after = srcLines.slice(matchStart + oldLines.length).join('\n');
            const result = (before ? before + '\n' : '') + (newStr ?? '') + (after ? '\n' + after : '');
            ProjectStore.writeFile(projectName, relPath, result);
            hasChanges = true;
            modifiedFiles.add(relPath);
            toolResults.push({ op: 'edit', path: relPath, result: 'ok' });
            emit({ type: 'tool', op: 'edit', path: relPath, result: 'ok', oldSnippet: oldStr.slice(0, 2000), newSnippet: newStr?.slice(0, 2000) });
          } else {
            // No match — return error, let the agent retry with correct text
            toolResults.push({ op: 'edit', path: relPath, result: 'old_not_found — your old text does not match the file. Use read tool to see the EXACT current content, then copy-paste the exact lines and retry.' });
            emit({ type: 'tool', op: 'edit', path: relPath, result: 'old_not_found', oldSnippet: oldStr.slice(0, 200) });
          }
        }

      // ── write ──
      } else if (op === 'write') {
        if (content === undefined) {
          toolResults.push({ op: 'write', path: relPath, result: 'missing_content' });
          emit({ type: 'tool', op: 'write', path: relPath, result: 'missing_content' });
        } else {
          const prevContent = ProjectStore.readFile(projectName, relPath);
          // BLOCK write on existing files — always. Use edit to modify, even truncated files.
          if (prevContent !== null) {
            toolResults.push({ op: 'write', path: relPath, result: 'error: file already exists — use edit tool to make surgical changes, do NOT rewrite the entire file. Read the file first, then use edit with exact old/new strings.' });
            emit({ type: 'tool', op: 'write', path: relPath, result: 'blocked_use_edit' });
          } else {
            ProjectStore.writeFile(projectName, relPath, content);
            hasChanges = true;
            modifiedFiles.add(relPath);
            toolResults.push({ op: 'write', path: relPath, result: 'ok' });
            emit({ type: 'tool', op: 'write', path: relPath, result: 'ok', newSnippet: content.slice(0, 500) });
          }
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
                detached: true, stdio: ['ignore', 'pipe', 'pipe'],
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

    // Handle truncated tool call — <tool> without </tool> (response cut off by max_tokens)
    const lastToolOpen = stepResponse.lastIndexOf('<tool>');
    if (lastToolOpen >= 0) {
      const alreadyMatched = matchedRanges.some(([start, end]) => lastToolOpen >= start && lastToolOpen < end);
      if (!alreadyMatched) {
        const truncatedRaw = stepResponse.slice(lastToolOpen + 6).trim();
        if (truncatedRaw.length > 20) {
          console.log('[TOOL-TRUNCATED] Found unclosed <tool> tag, attempting robust parse. Length:', truncatedRaw.length);
          try {
            const toolCall = _parseToolCallRobust(truncatedRaw);
            // Execute the truncated tool call
            const { op, path: relPath, old: oldStr, new: newStr, content } = toolCall;
            if (op === 'edit' && relPath && oldStr) {
              const src = ProjectStore.readFile(projectName, relPath);
              if (src && src.includes(oldStr)) {
                const newSrc = src.replace(oldStr, newStr ?? '');
                ProjectStore.writeFile(projectName, relPath, newSrc);
                hasChanges = true;
                modifiedFiles.add(relPath);
                toolResults.push({ op: 'edit', path: relPath, result: 'ok' });
                emit({ type: 'tool', op: 'edit', path: relPath, result: 'ok', oldSnippet: oldStr.slice(0, 2000), newSnippet: newStr?.slice(0, 2000) ?? '' });
                console.log('[TOOL-TRUNCATED] Edit applied successfully from truncated tool call');
              } else if (src) {
                // Try fuzzy match
                const oldLines = oldStr.split('\n').map(l => l.trim());
                const srcLines = src.split('\n');
                let matchStart = -1;
                for (let i = 0; i <= srcLines.length - oldLines.length; i++) {
                  let ok = true;
                  for (let j = 0; j < oldLines.length; j++) {
                    if (srcLines[i + j].trim() !== oldLines[j]) { ok = false; break; }
                  }
                  if (ok) { matchStart = i; break; }
                }
                if (matchStart >= 0) {
                  const before = srcLines.slice(0, matchStart).join('\n');
                  const after = srcLines.slice(matchStart + oldLines.length).join('\n');
                  const result = (before ? before + '\n' : '') + (newStr ?? '') + (after ? '\n' + after : '');
                  ProjectStore.writeFile(projectName, relPath, result);
                  hasChanges = true;
                  modifiedFiles.add(relPath);
                  toolResults.push({ op: 'edit', path: relPath, result: 'ok' });
                  emit({ type: 'tool', op: 'edit', path: relPath, result: 'ok', oldSnippet: oldStr.slice(0, 2000), newSnippet: newStr?.slice(0, 2000) ?? '' });
                  console.log('[TOOL-TRUNCATED] Edit applied via fuzzy match from truncated tool call');
                }
              }
            }
          } catch (e) {
            console.log('[TOOL-TRUNCATED] Failed to parse truncated tool:', e.message);
          }
        }
      }
    }

    // If any edit failed, ignore <done/> — force retry
    const hasFailedEdit = toolResults.some((r) => r.op === 'edit' && (r.result?.includes('not_found') || r.result?.includes('blocked')));
    if (hasFailedEdit && step < MAX_STEPS - 1) {
      // Don't break — let the agent see the error and retry
    } else if (isDone || toolResults.length === 0) {
      break;
    }

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
  } // end of fallback else block

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
            detached: true,
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

const FILE_PLAN_SYSTEM = `You are a senior architect. Design a MINIMAL but COMPLETE working website.
Output ONLY a JSON array: [{"name":"path/file.ext","purpose":"description","tokens":N}]

CRITICAL RULES:
- Generate 8-15 files MAXIMUM — every file must be COMPLETE and WORKING
- Each file should be 100-300 lines — substantial but not truncated
- Token estimate per file: 500-2000 tokens (no file should need more than 2500)
- The generated site must work IMMEDIATELY when you run "node server.js"
- Users can add more features later via chat — start with a solid foundation

REQUIRED FILES:
1. package.json — dependencies (express, helmet, cors, compression, morgan, bcryptjs, jsonwebtoken, dotenv, cookie-parser, express-rate-limit)
2. .env.example — environment variables
3. server.js — Express server with ALL middleware, routes, and static serving
4. public/index.html — COMPLETE landing page (hero, features, footer — all CSS inline in <style>, all JS inline in <script>)
5. public/login.html — Login + register page (complete with inline CSS/JS, form validation, API calls)
6. public/css/style.css — ONE main stylesheet (variables, reset, layout, components, responsive — everything in one file)
7. public/js/app.js — Main JS (SPA routing, auth, API client, dark mode, toasts, form validation)
8. middleware/auth.js — JWT authentication middleware
9. routes/auth.js — Auth routes (register, login, logout, refresh)
10. models/user.js — User model with JSON file storage

OPTIONAL (only if the project type requires them):
- routes/api.js — REST API routes for the specific project
- public/dashboard.html — Protected dashboard page
- Additional pages specific to the project type

DO NOT generate:
- Separate CSS files per component (put everything in style.css)
- Separate JS files per feature (put everything in app.js)
- README.md, .gitignore (not essential for a working site)
- Animation/responsive separate files

Output ONLY the JSON array, no explanation.`;

// Token counter — approximate based on character count (1 token ≈ 4 chars)
function countTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Detects if an LLM output appears to be truncated / incomplete.
 * Returns true if the file likely needs a continuation call.
 */
function isFileTruncated(content, filename) {
  if (!content) return true;
  const trimmed = content.trimEnd();
  const ext = filename.split('.').pop()?.toLowerCase();
  // Short files: check if they're valid for their type before flagging
  if (trimmed.length < 10) {
    if (ext === 'json') { try { JSON.parse(trimmed); return false; } catch { return true; } }
    if (ext === 'css' || ext === 'js' || ext === 'mjs') return trimmed.length < 3;
    return false;
  }

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
  // Blocks → write to memory.md as TODO features (NOT generated now)
  const enabledBlocks = Object.entries(blocks).filter(([, enabled]) => enabled).map(([key]) => key);
  const authDesc = blocks.auth
    ? `Auth fields: ${authFields.map((f) => `${f.label}(${f.type}${f.required ? ',required' : ''})`).join(', ')}`
    : '';

  // Save project context — always write memory.md with instructions + TODO features
  SkillStore.ensureDefaults(projectName, config);
  const ctxDir = SkillStore.dir(projectName);
  const memPath = path.join(ctxDir, 'memory.md');
  const blockTodos = [
    enabledBlocks.includes('auth') ? `- [ ] **Authentication** (register/login/JWT) — ${authDesc || 'email + password'}` : '',
    enabledBlocks.includes('cookieBanner') ? '- [ ] **GDPR Cookie Banner** — consent modal, localStorage tracking' : '',
    enabledBlocks.includes('securityMiddleware') ? '- [ ] **Security Middleware** — helmet CSP, rate limiting, CORS' : '',
    enabledBlocks.includes('emailVerification') ? '- [ ] **Email Verification** — send verification link, confirm endpoint' : '',
  ].filter(Boolean);
  const memContent = `# ${projectName} — Project Memory

## Description
${description}

## Planned Features
${blockTodos.length > 0 ? blockTodos.join('\n') : '_(No features selected — add them via chat)_'}

## How to Build (step by step)
1. **Start with the generated base** — the site works immediately
2. **Ask the AI agent** to add features one by one: "Add authentication", "Add a contact form"
3. **Refine the design** in chat: "Make the hero section more modern", "Add dark mode"
4. **Add security** when ready: "Add cookie consent banner", "Harden security headers"
5. **Test with Sandbox** — click ▶ Sandbox to preview your site live
6. **Download ZIP** when done — deploy anywhere

## Architecture Decisions
_The agent will update this section as you build._
`;
  fs.writeFileSync(memPath, memContent, 'utf-8');

  // Write anthropic.md / provider.md with useful context
  const provider = config.llm?.provider || 'nha';
  const model = config.llm?.model || '';
  const providerPath = path.join(ctxDir, `${provider}.md`);
  const providerContent = `# ${provider.toUpperCase()} — ${model || 'Default'}

## Project: ${projectName}
## Description: ${description}

## Code Style
- Modern ES6+: async/await, const/let, arrow functions
- Express.js backend with middleware stack
- Vanilla HTML/CSS/JS frontend (no framework)
- Mobile-first responsive CSS
- Accessible HTML with semantic tags

## Important
- Always generate COMPLETE files — no truncation
- Use external CSS/JS files, avoid inline scripts >20 lines
- Every function must be fully implemented
`;
  fs.writeFileSync(providerPath, providerContent, 'utf-8');

  const planPrompt = `Project: ${projectName}
Description: ${description}

Design a MINIMAL but COMPLETE file structure for a working website.
Focus on the core: a beautiful landing page, server, and main CSS/JS.
The user will add features like auth, cookie banner, etc. later via chat.`;

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

    // max_tokens — generous for fewer, more complete files
    const estimatedTokens = fileSpec.tokens || 1500;
    const maxTokens = Math.min(Math.max(estimatedTokens * 3, 3000), 12000);

    const fileSys = `You are a team of 200 senior full-stack developers generating ENTERPRISE-GRADE production code.

OUTPUT FORMAT: Raw file content ONLY — zero explanations, zero markdown fences, zero preamble.

CODE STANDARDS (MANDATORY — every file):
- COMPLETE, WORKING code — no TODOs, no placeholders, no "add your code here"
- NEVER create empty data files (empty JSON arrays, empty objects) — create them dynamically at runtime when needed
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

  // ── Cross-reference check: verify HTML src/href point to existing files ────
  if (!abortSignal?.aborted) {
    const allFileNames = new Set(generatedFiles.map((f) => f.name));
    let refsFixed = 0;
    for (const f of generatedFiles) {
      if (!f.name.endsWith('.html')) continue;
      let modified = false;
      let html = f.content;

      // Find all src="..." and href="..." references to local files
      const refRegex = /(?:src|href)=["']([^"']*?\.(?:js|css|mjs))["']/gi;
      let match;
      while ((match = refRegex.exec(html)) !== null) {
        const ref = match[1];
        if (ref.startsWith('http') || ref.startsWith('//') || ref.startsWith('data:')) continue;

        // Resolve relative path from HTML file location
        const htmlDir = path.dirname(f.name);
        const refPath = ref.startsWith('/') ? ref.slice(1) : path.join(htmlDir, ref).replace(/\\/g, '/');
        const publicRef = refPath.startsWith('public/') ? refPath : `public/${refPath}`;

        // Check if file exists in generated files
        if (!allFileNames.has(refPath) && !allFileNames.has(publicRef) && !allFileNames.has(ref)) {
          // Try to find the actual file by name
          const baseName = path.basename(ref);
          const actualFile = generatedFiles.find((g) => g.name.endsWith('/' + baseName) || g.name === baseName);
          if (actualFile) {
            // Fix the reference
            const correctRef = actualFile.name.startsWith('public/') ? actualFile.name.slice(7) : actualFile.name;
            html = html.replace(match[0], match[0].replace(ref, correctRef));
            modified = true;
            refsFixed++;
            emit({ type: 'status', msg: `Fixed reference: ${ref} → ${correctRef} in ${f.name}` });
          } else {
            emit({ type: 'status', msg: `Warning: ${f.name} references missing file: ${ref}` });
          }
        }
      }

      if (modified) {
        f.content = html;
        const abs = path.join(projectDir, f.name);
        fs.writeFileSync(abs, html, 'utf-8');
      }
    }
    if (refsFixed > 0) {
      emit({ type: 'status', msg: `Auto-fixed ${refsFixed} broken file reference(s)` });
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

  // Write changes log
  {
    const logCtxDir = SkillStore.dir(projectName);
    const skillsFile = path.join(logCtxDir, 'skills.md');
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
    const logProvider = config.llm?.provider || 'nha';
    const logModel = config.llm?.model || '';
    const logFile = path.join(logCtxDir, 'changes.log.md');
    const logEntry = `## ${new Date().toISOString().slice(0, 10)} — Initial generation\n- Generated ${generatedFiles.length} files\n- Tokens in: ${totalTokensIn} / out: ${totalTokensOut}\n- Description: ${description}\n- Provider: ${logProvider} (${logModel || 'default'})\n`;
    fs.writeFileSync(logFile, (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '') + logEntry, 'utf-8');
  }

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
    let { projectName, description, blocks = {}, authFields = [] } = body;
    if (!projectName || !description) return sendError(res, 400, 'projectName and description required');

    // Prevent overwriting existing projects — add (1), (2), etc.
    const baseName = projectName;
    let suffix = 0;
    while (fs.existsSync(ProjectStore.dir(projectName))) {
      // Check if directory has actual project files (not just .nha-context)
      const files = fs.readdirSync(ProjectStore.dir(projectName)).filter((f) => !f.startsWith('.nha-'));
      if (files.length === 0) break; // empty project dir — safe to reuse
      suffix++;
      projectName = `${baseName} (${suffix})`;
    }

    const sse = sendSSE(res);
    // Notify frontend of the final project name (may differ from input)
    if (suffix > 0) sse.send({ type: 'project_renamed', name: projectName });

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
  // ── TypeScript checkJs linter — enterprise-grade diagnostics ─────────────────

  let _tscPath = null;
  let _tscChecked = false;

  function findTsc() {
    if (_tscChecked) return _tscPath;
    _tscChecked = true;
    // Our own bundled tsc (from package dependency)
    const __dir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(__dir, '../../../node_modules/.bin/tsc'),
      path.resolve(__dir, '../../../../node_modules/.bin/tsc'),
    ];
    // Also try global — execSync imported at top of file (ESM).
    try {
      const globalTsc = execSync('which tsc 2>/dev/null || where tsc 2>nul', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (globalTsc) candidates.push(globalTsc);
    } catch {}
    for (const c of candidates) {
      try { if (fs.existsSync(c)) { _tscPath = c; return c; } } catch {}
    }
    return null;
  }

  async function lintJSWithTypeScript(projectDir, relPath) {
    const tsc = findTsc();
    if (!tsc) return null; // fallback to acorn

    const absFile = path.join(projectDir, relPath);
    if (!fs.existsSync(absFile)) return null;

    try {
      const { stdout, stderr } = await execAsync(
        `"${tsc}" --noEmit --checkJs --allowJs --target es2020 --moduleResolution bundler --skipLibCheck --ignoreConfig "${absFile}" 2>&1`,
        { cwd: projectDir, timeout: 10000 }
      );
      const output = stdout || stderr || '';
      const diagnostics = [];
      // Parse tsc output: path(line,col): error TSxxxx: message
      const lineRegex = /\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)/g;
      let m;
      while ((m = lineRegex.exec(output)) !== null) {
        diagnostics.push({
          from: { line: parseInt(m[1]), col: parseInt(m[2]) - 1 },
          severity: m[3] === 'error' ? 'error' : 'warning',
          message: m[4].trim(),
        });
      }
      return diagnostics;
    } catch (e) {
      // tsc returns exit code 1 when there are errors — parse its output
      const output = e.stdout || e.stderr || e.message || '';
      const diagnostics = [];
      const lineRegex = /\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)/g;
      let m;
      while ((m = lineRegex.exec(output)) !== null) {
        diagnostics.push({
          from: { line: parseInt(m[1]), col: parseInt(m[2]) - 1 },
          severity: m[3] === 'error' ? 'error' : 'warning',
          message: m[4].trim(),
        });
      }
      return diagnostics.length > 0 ? diagnostics : null;
    }
  }

  // ── Acorn fallback linter — AST-based diagnostics ──────────────────────────

  const JsxParser = acorn.Parser.extend(acornJsx());
  const JS_BUILTINS = new Set([
    'undefined','NaN','Infinity','globalThis','eval','isFinite','isNaN','parseFloat','parseInt',
    'decodeURI','decodeURIComponent','encodeURI','encodeURIComponent',
    'Array','ArrayBuffer','BigInt','BigInt64Array','BigUint64Array','Boolean','DataView','Date',
    'Error','EvalError','FinalizationRegistry','Float32Array','Float64Array','Function',
    'Int8Array','Int16Array','Int32Array','JSON','Map','Math','Number','Object','Promise',
    'Proxy','RangeError','ReferenceError','Reflect','RegExp','Set','SharedArrayBuffer',
    'String','Symbol','SyntaxError','TypeError','URIError','Uint8Array','Uint8ClampedArray',
    'Uint16Array','Uint32Array','WeakMap','WeakRef','WeakSet',
    'console','setTimeout','setInterval','clearTimeout','clearInterval','queueMicrotask',
    'atob','btoa','fetch','structuredClone','performance','crypto','navigator','location',
    'window','document','self','global','process','require','module','exports','__dirname','__filename',
    'Buffer','URL','URLSearchParams','TextEncoder','TextDecoder','AbortController','AbortSignal',
    'Event','EventTarget','CustomEvent','FormData','Headers','Request','Response',
    'ReadableStream','WritableStream','TransformStream','Blob','File','FileReader',
    'WebSocket','Worker','SharedWorker','BroadcastChannel','MessageChannel','MessagePort',
    'Intl','alert','confirm','prompt','requestAnimationFrame','cancelAnimationFrame',
    'MutationObserver','ResizeObserver','IntersectionObserver','PerformanceObserver',
    'HTMLElement','Element','Node','NodeList','DocumentFragment',
    'localStorage','sessionStorage','history','screen','CSS','CSSStyleSheet',
    'XMLHttpRequest','Image','Audio','Video','MediaSource','SourceBuffer',
    'Map','Set','WeakMap','WeakSet','Proxy','Reflect',
    'arguments','this','super','import','export',
  ]);
  const REACT_GLOBALS = new Set([
    'React','useState','useEffect','useRef','useCallback','useMemo','useContext',
    'useReducer','useLayoutEffect','useImperativeHandle','useDebugValue','useTransition',
    'useDeferredValue','useId','useSyncExternalStore','useInsertionEffect',
    'createContext','createRef','forwardRef','lazy','memo','startTransition',
    'Component','PureComponent','Fragment','StrictMode','Suspense','Profiler',
    'createElement','cloneElement','isValidElement','Children',
    'jsx','jsxs','jsxDEV',
  ]);
  const NODE_MODULES = new Set([
    'fs','path','os','http','https','url','util','stream','events','crypto','child_process',
    'net','dgram','dns','tls','zlib','readline','cluster','worker_threads','perf_hooks',
    'assert','buffer','querystring','string_decoder','timers','v8','vm','inspector',
  ]);

  function lintJS(content, relPath, projectName) {
    const diagnostics = [];
    const ext = relPath.split('.').pop()?.toLowerCase();
    const isJsx = ext === 'jsx' || ext === 'tsx';

    // 1. Parse with acorn (real AST)
    let ast;
    try {
      ast = JsxParser.parse(content, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
        allowImportExportEverywhere: true,
        allowReturnOutsideFunction: true,
        allowHashBang: true,
      });
    } catch (e) {
      diagnostics.push({
        from: { line: e.loc?.line || 1, col: e.loc?.column || 0 },
        severity: 'error',
        message: e.message.replace(/\(\d+:\d+\)$/, '').trim(),
      });
      return diagnostics;
    }

    // 2. Scope analysis — collect declarations and references
    const declared = new Set();
    const imported = new Set();
    const importSources = [];
    const references = []; // { name, loc }
    const exportedNames = new Set();

    function walkNode(node, scope) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(n => walkNode(n, scope)); return; }
      if (!node.type) return;

      const localScope = new Set(scope);

      switch (node.type) {
        case 'VariableDeclaration':
          for (const decl of node.declarations) {
            collectPattern(decl.id, localScope);
            if (decl.init) walkNode(decl.init, localScope);
          }
          // Walk rest of body with the declared vars
          return;

        case 'FunctionDeclaration':
          if (node.id) localScope.add(node.id.name);
          declared.add(node.id?.name);
          const fnScope = new Set(localScope);
          for (const p of node.params) collectPattern(p, fnScope);
          walkNode(node.body, fnScope);
          return;

        case 'FunctionExpression':
        case 'ArrowFunctionExpression': {
          const arrowScope = new Set(localScope);
          if (node.id) arrowScope.add(node.id.name);
          for (const p of node.params) collectPattern(p, arrowScope);
          walkNode(node.body, arrowScope);
          return;
        }

        case 'ClassDeclaration':
        case 'ClassExpression':
          if (node.id) { localScope.add(node.id.name); declared.add(node.id.name); }
          if (node.superClass) walkNode(node.superClass, localScope);
          walkNode(node.body, localScope);
          return;

        case 'ImportDeclaration':
          for (const spec of node.specifiers) {
            imported.add(spec.local.name);
            localScope.add(spec.local.name);
          }
          importSources.push({ source: node.source.value, loc: node.loc });
          return;

        case 'ExportNamedDeclaration':
          if (node.declaration) walkNode(node.declaration, localScope);
          if (node.specifiers) for (const s of node.specifiers) exportedNames.add(s.exported.name || s.exported.value);
          return;

        case 'ExportDefaultDeclaration':
          walkNode(node.declaration, localScope);
          return;

        case 'Identifier':
          if (!localScope.has(node.name) && !declared.has(node.name) && !imported.has(node.name)) {
            references.push({ name: node.name, loc: node.loc });
          }
          return;

        case 'MemberExpression':
          walkNode(node.object, localScope);
          // Don't walk computed property as reference
          if (node.computed) walkNode(node.property, localScope);
          return;

        case 'Property':
        case 'MethodDefinition':
          // Don't treat keys as references
          if (node.computed) walkNode(node.key, localScope);
          walkNode(node.value, localScope);
          return;

        case 'CatchClause':
          const catchScope = new Set(localScope);
          if (node.param) collectPattern(node.param, catchScope);
          walkNode(node.body, catchScope);
          return;

        case 'ForInStatement':
        case 'ForOfStatement': {
          const forScope = new Set(localScope);
          if (node.left.type === 'VariableDeclaration') {
            for (const d of node.left.declarations) collectPattern(d.id, forScope);
          } else { walkNode(node.left, forScope); }
          walkNode(node.right, forScope);
          walkNode(node.body, forScope);
          return;
        }

        case 'ForStatement': {
          const forScope2 = new Set(localScope);
          if (node.init?.type === 'VariableDeclaration') {
            for (const d of node.init.declarations) collectPattern(d.id, forScope2);
          } else if (node.init) { walkNode(node.init, forScope2); }
          if (node.test) walkNode(node.test, forScope2);
          if (node.update) walkNode(node.update, forScope2);
          walkNode(node.body, forScope2);
          return;
        }

        case 'BlockStatement':
        case 'Program': {
          const blockScope = new Set(localScope);
          // Pre-scan for hoisted declarations
          if (node.body) {
            for (const stmt of node.body) {
              if (stmt.type === 'FunctionDeclaration' && stmt.id) blockScope.add(stmt.id.name);
              if (stmt.type === 'VariableDeclaration') {
                for (const d of stmt.declarations) collectPattern(d.id, blockScope);
              }
              if (stmt.type === 'ClassDeclaration' && stmt.id) blockScope.add(stmt.id.name);
              if (stmt.type === 'ImportDeclaration') {
                for (const s of stmt.specifiers) { blockScope.add(s.local.name); imported.add(s.local.name); }
              }
            }
          }
          if (node.body) for (const stmt of node.body) walkNode(stmt, blockScope);
          return;
        }

        case 'LabeledStatement':
          walkNode(node.body, localScope);
          return;

        case 'JSXIdentifier':
          // JSX component names (capitalized) are references
          if (/^[A-Z]/.test(node.name) && !localScope.has(node.name) && !declared.has(node.name) && !imported.has(node.name)) {
            references.push({ name: node.name, loc: node.loc });
          }
          return;

        case 'JSXMemberExpression':
          walkNode(node.object, localScope);
          return;
      }

      // Generic walk for other node types
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'type' || key === 'raw' || key === 'value' || key === 'name' || key === 'operator' || key === 'prefix' || key === 'sourceType') continue;
        const val = node[key];
        if (val && typeof val === 'object') walkNode(val, localScope);
      }
    }

    function collectPattern(pattern, scope) {
      if (!pattern) return;
      if (pattern.type === 'Identifier') { scope.add(pattern.name); declared.add(pattern.name); }
      else if (pattern.type === 'ObjectPattern') { for (const p of pattern.properties) collectPattern(p.value || p.argument, scope); }
      else if (pattern.type === 'ArrayPattern') { for (const e of pattern.elements) if (e) collectPattern(e, scope); }
      else if (pattern.type === 'RestElement') collectPattern(pattern.argument, scope);
      else if (pattern.type === 'AssignmentPattern') collectPattern(pattern.left, scope);
    }

    walkNode(ast, new Set());

    // 3. Report undefined references (excluding builtins and React globals)
    const allKnown = new Set([...declared, ...imported, ...JS_BUILTINS]);
    if (isJsx || content.includes('from \'react\'') || content.includes('from "react"')) {
      for (const g of REACT_GLOBALS) allKnown.add(g);
    }
    for (const ref of references) {
      if (allKnown.has(ref.name)) continue;
      // Skip single-letter vars (often from minified/short code)
      if (ref.name.length === 1) continue;
      // Skip common DOM event handler names
      if (/^on[A-Z]/.test(ref.name)) continue;
      diagnostics.push({
        from: { line: ref.loc.start.line, col: ref.loc.start.column },
        severity: 'warning',
        message: `'${ref.name}' is not defined`,
      });
    }

    // 4. Check import sources — verify local files exist
    for (const imp of importSources) {
      const src = imp.source;
      if (src.startsWith('.') || src.startsWith('/')) {
        const dir = path.dirname(relPath);
        const candidates = [
          path.join(dir, src),
          path.join(dir, src + '.js'),
          path.join(dir, src + '.mjs'),
          path.join(dir, src + '.jsx'),
          path.join(dir, src + '/index.js'),
          path.join(dir, src + '/index.mjs'),
        ].map(p => p.replace(/\\/g, '/'));
        const found = candidates.some(c => ProjectStore.readFile(projectName, c) !== null);
        if (!found) {
          diagnostics.push({
            from: { line: imp.loc.start.line, col: imp.loc.start.column },
            severity: 'error',
            message: `Cannot resolve import '${src}'`,
          });
        }
      }
    }

    return diagnostics;
  }

  function lintCSS(content) {
    const diagnostics = [];
    const lines = content.split('\n');

    // Brace balance per-line tracking
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth < 0) {
        diagnostics.push({ from: { line: i + 1, col: 0 }, severity: 'error', message: 'Unexpected closing brace }' });
        depth = 0;
      }
    }
    if (depth > 0) {
      diagnostics.push({ from: { line: lines.length, col: 0 }, severity: 'error', message: `${depth} unclosed brace(s) {` });
    }

    // Check for common CSS errors
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Empty property value
      if (/^[a-z-]+:\s*;/i.test(line)) {
        diagnostics.push({ from: { line: i + 1, col: 0 }, severity: 'warning', message: 'Empty property value' });
      }
      // Duplicate semicolons
      if (/;;/.test(line) && !line.startsWith('//') && !line.startsWith('/*')) {
        diagnostics.push({ from: { line: i + 1, col: line.indexOf(';;') }, severity: 'warning', message: 'Duplicate semicolon' });
      }
      // Missing semicolon (property line without ; that isn't a selector/comment/brace)
      if (/^[a-z-]+\s*:/.test(line) && !line.endsWith(';') && !line.endsWith('{') && !line.endsWith('}') && !line.endsWith(',') && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*')) {
        diagnostics.push({ from: { line: i + 1, col: line.length }, severity: 'warning', message: 'Missing semicolon' });
      }
    }

    return diagnostics;
  }

  function lintHTML(content, relPath, projectName) {
    const diagnostics = [];
    const lines = content.split('\n');

    // Tag balance check
    const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    const tagStack = [];
    const tagRegex = /<\/?([a-z][a-z0-9]*)\b[^>]*\/?>/gi;
    let match;
    while ((match = tagRegex.exec(content)) !== null) {
      const full = match[0];
      const tagName = match[1].toLowerCase();
      if (voidTags.has(tagName) || full.endsWith('/>')) continue;
      const lineNum = content.slice(0, match.index).split('\n').length;

      if (full.startsWith('</')) {
        // Closing tag
        if (tagStack.length === 0) {
          diagnostics.push({ from: { line: lineNum, col: 0 }, severity: 'error', message: `Unexpected closing tag </${tagName}>` });
        } else {
          const last = tagStack[tagStack.length - 1];
          if (last.name === tagName) {
            tagStack.pop();
          } else {
            diagnostics.push({ from: { line: lineNum, col: 0 }, severity: 'error', message: `Mismatched tag: expected </${last.name}> but found </${tagName}>` });
          }
        }
      } else {
        tagStack.push({ name: tagName, line: lineNum });
      }
    }
    // Report unclosed tags (max 5)
    for (const unclosed of tagStack.slice(-5)) {
      diagnostics.push({ from: { line: unclosed.line, col: 0 }, severity: 'error', message: `Unclosed tag <${unclosed.name}>` });
    }

    // Check src/href references to local files
    const refRegex = /(?:src|href)=["']([^"']*?\.(?:js|css|mjs|png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot))["']/gi;
    let refMatch;
    while ((refMatch = refRegex.exec(content)) !== null) {
      const ref = refMatch[1];
      if (ref.startsWith('http') || ref.startsWith('//') || ref.startsWith('data:') || ref.startsWith('#') || ref.startsWith('mailto:')) continue;
      const htmlDir = path.dirname(relPath);
      const refPath = ref.startsWith('/') ? ref.slice(1) : path.join(htmlDir, ref).replace(/\\/g, '/');
      const publicRef = refPath.startsWith('public/') ? refPath : `public/${refPath}`;
      const fileExists = ProjectStore.readFile(projectName, refPath) !== null
        || ProjectStore.readFile(projectName, publicRef) !== null
        || ProjectStore.readFile(projectName, ref) !== null;
      if (!fileExists) {
        const lineNum = content.slice(0, refMatch.index).split('\n').length;
        diagnostics.push({
          from: { line: lineNum, col: 0 },
          severity: 'error',
          message: `Referenced file not found: ${ref}`,
        });
      }
    }

    return diagnostics;
  }

  router.post('/api/studio/webcraft/lint', async (req, res) => {
    try {
      const { projectName, path: relPath } = await parseBody(req);
      if (!projectName || !relPath) return sendError(res, 400, 'projectName and path required');
      const content = ProjectStore.readFile(projectName, relPath);
      if (content === null) return sendJSON(res, 200, { diagnostics: [] });

      const ext = (relPath.split('.').pop() || '').toLowerCase();
      let diagnostics = [];

      // JavaScript / JSX — try TypeScript checkJs first, fallback to acorn
      if (['js', 'mjs', 'jsx', 'cjs'].includes(ext)) {
        const projectDir = ProjectStore.dir(projectName);
        const tsDiags = await lintJSWithTypeScript(projectDir, relPath);
        diagnostics = tsDiags || lintJS(content, relPath, projectName);
      }

      // JSON — parse errors with precise location
      if (ext === 'json') {
        try { JSON.parse(content); } catch (e) {
          const posMatch = e.message.match(/position (\d+)/i);
          const pos = posMatch ? parseInt(posMatch[1]) : 0;
          const before = content.slice(0, pos).split('\n');
          diagnostics.push({
            from: { line: before.length, col: (before[before.length - 1] || '').length },
            severity: 'error',
            message: e.message,
          });
        }
      }

      // CSS — brace balance + property validation
      if (ext === 'css') {
        diagnostics = lintCSS(content);
      }

      // HTML/HTM — tag balance + reference validation
      if (ext === 'html' || ext === 'htm') {
        diagnostics = lintHTML(content, relPath, projectName);
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

  // ── Sandbox stop (beacon — for beforeunload) ───────────────────────────────
  router.post('/api/studio/webcraft/sandbox/stop-beacon', async (_req, res) => {
    try {
      await sandbox.stop();
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Sandbox status ────────────────────────────────────────────────────────
  router.get('/api/studio/webcraft/sandbox/status', (_req, res) => {
    sendJSON(res, 200, sandbox.status());
  });

  // ── Sandbox runtime errors (reported by injected script in iframe) ────────
  const sandboxErrors = [];
  // Debounce: only autofix the same source URL once every 8s to avoid loops
  const _autofixCooldown = new Map();

  // Browser-side runtime error patterns that we know how to fix.
  // Each one maps to an LLM repair hint specific to the failure mode.
  const BROWSER_FIX_PATTERNS = [
    { name: 'require is not defined',  re: /require is not defined/i,
      hint: 'The file uses CommonJS `require()` in a browser context where it does NOT exist. Convert all `require("X")` to ES module `import X from "X"` (or named imports as appropriate). Convert `module.exports = ...` to `export default ...`. Ensure the HTML loads the script with `<script type="module" src="...">`. Keep all logic identical.' },
    { name: 'module is not defined',   re: /\bmodule is not defined/i,
      hint: 'The file references the CommonJS `module` global which does not exist in browsers. Replace `module.exports = X` with `export default X` (or `export { X }`).' },
    { name: 'exports is not defined',  re: /\bexports is not defined/i,
      hint: 'The file uses CommonJS `exports` in a browser context. Replace `exports.X = Y` with `export const X = Y`.' },
    { name: 'process is not defined',  re: /\bprocess is not defined/i,
      hint: 'The code references Node.js `process` global in the browser. Either remove the reference (e.g. delete `process.env.X` checks) or stub it: `const process = { env: {} };` at top of file. Prefer removal.' },
    { name: 'SyntaxError',             re: /SyntaxError:.+|Unexpected (token|identifier|string|end)/i,
      hint: 'JavaScript syntax error in the file. Fix the syntax — unclosed brackets, missing commas, invalid token. Output the complete corrected file.' },
    { name: 'ReferenceError',          re: /(?:Uncaught )?ReferenceError: (\w+) is not defined/i,
      hint: 'A variable is referenced but never declared/imported. Either import it from the correct module, define it, or remove the dead reference.' },
    { name: 'TypeError null/undefined', re: /(?:Uncaught )?TypeError: (?:Cannot read prop(?:erties|erty)? .+ of (?:undefined|null)|null is not an object|undefined is not (?:a function|an object))/i,
      hint: 'Null/undefined access. Add a null-check or optional chaining (?.) before the failing access. If the failure is on DOM element lookup, the script may be running before the DOM is ready — wrap in DOMContentLoaded.' },
  ];

  router.post('/api/studio/webcraft/sandbox/errors', async (req, res) => {
    try {
      const body = await parseBody(req);
      if (!body.error) return sendJSON(res, 200, { ok: true });

      const message = String(body.error).slice(0, 500);
      const source  = String(body.source || '').slice(0, 200);
      const stack   = String(body.stack || '').slice(0, 1000);

      sandboxErrors.push({
        ts: new Date().toISOString(),
        message,
        source,
        line: body.line || 0,
        col: body.col || 0,
        stack,
      });
      if (sandboxErrors.length > 20) sandboxErrors.splice(0, sandboxErrors.length - 20);

      // Respond to the iframe immediately — autofix runs async after.
      sendJSON(res, 200, { ok: true });

      // ── Autofix path ────────────────────────────────────────────────
      const sb = sandbox._sandbox;
      if (!sb || !sb.projectName) return; // no project — can't fix
      const projectDir = ProjectStore.dir(sb.projectName);
      if (!fs.existsSync(projectDir)) return;

      const matched = BROWSER_FIX_PATTERNS.find(p => p.re.test(message) || p.re.test(stack));
      if (!matched) return;

      // Resolve the failing file from the source URL.
      // source is typically "http://localhost:NNNN/path/to/file.js?..." or
      // a bare filename. We strip the origin and query, then map under projectDir.
      let relFile = '';
      try {
        if (source && source.includes('://')) {
          const u = new URL(source);
          relFile = u.pathname.replace(/^\/+/, '').split('?')[0];
        } else if (source) {
          relFile = source.replace(/^\/+/, '').split('?')[0];
        }
        // Fallback: extract from stack trace
        if (!relFile && stack) {
          const m = stack.match(/(?:https?:\/\/[^\s)]+\/)([^\s:?)]+\.(?:m?js|jsx?|tsx?|cjs|html))/);
          if (m) relFile = m[1];
        }
      } catch { /* ignore parse errors */ }

      // Strip leading "static/" or asset prefixes that Vite/Webpack add
      relFile = relFile.replace(/^(static|assets|dist|public|build|out)\//, '');

      if (!relFile) return;

      const absFile = path.join(projectDir, relFile);
      // Safety: must be inside projectDir
      if (!absFile.startsWith(projectDir + path.sep)) return;
      if (!fs.existsSync(absFile)) return;

      // Cooldown: don't autofix the same file more than once every 8s
      const cdKey = absFile;
      const now = Date.now();
      const last = _autofixCooldown.get(cdKey) || 0;
      if (now - last < 8_000) return;
      _autofixCooldown.set(cdKey, now);

      const original = fs.readFileSync(absFile, 'utf-8');
      if (!original || original.length < 5) return;

      const fixPrompt =
`A browser sandbox preview crashed with this runtime error:

Error: ${message}
Source: ${source}
Stack (first lines):
${stack.slice(0, 800)}

The failing file is: ${relFile}

What to fix: ${matched.hint}

CRITICAL: Output ONLY the complete corrected file content. No commentary, no markdown fences. Keep all working logic intact — only change what's necessary to fix the runtime error.

Current file content:
${original.slice(0, 12_000)}`;

      try {
        let fixed = '';
        await callLLMStream(loadConfig(), 'You are a precise code repair assistant. Output only the corrected file, no explanation.', fixPrompt, (c) => { fixed += c; }, { max_tokens: 16_384 });
        fixed = fixed.replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();
        if (fixed.length > 20 && fixed !== original) {
          fs.writeFileSync(absFile, fixed, 'utf-8');
          // Notify connected WebSocket clients so the iframe can be reloaded.
          // The Studio/WebCraft UI polls these errors and will surface the fix.
          sandboxErrors.push({
            ts: new Date().toISOString(),
            message: `✓ Auto-fix applied to ${relFile} (${matched.name}) — reload the preview to test.`,
            source: '__autofix__',
            line: 0, col: 0, stack: '',
          });
          if (sandboxErrors.length > 20) sandboxErrors.splice(0, sandboxErrors.length - 20);
        }
      } catch (e) {
        sandboxErrors.push({
          ts: new Date().toISOString(),
          message: `✗ Auto-fix failed for ${relFile}: ${(e.message || '').slice(0, 200)}`,
          source: '__autofix__',
          line: 0, col: 0, stack: '',
        });
      }
    } catch { sendJSON(res, 200, { ok: true }); }
  });

  router.get('/api/studio/webcraft/sandbox/errors', (_req, res) => {
    sendJSON(res, 200, { errors: sandboxErrors.slice(-10) });
  });

  router.delete('/api/studio/webcraft/sandbox/errors', (_req, res) => {
    sandboxErrors.length = 0;
    sendJSON(res, 200, { ok: true });
  });

  // ── WebCraft Agent chat — SSE ─────────────────────────────────────────────
  router.post('/api/studio/webcraft/agent', async (req, res) => {
    const body = await parseBody(req, 10_485_760);
    const config = loadConfig();
    const { projectName, message, attachments = [] } = body;
    if (!projectName || !message) return sendError(res, 400, 'projectName and message required');

    // Abort detection — stop agent when client disconnects
    let clientAborted = false;
    req.on('close', () => { clientAborted = true; });
    req.on('aborted', () => { clientAborted = true; });

    const sse = sendSSE(res);
    const guardedEmit = (ev) => {
      if (clientAborted || res.writableEnded) return;
      sse.send(ev);
    };
    try {
      await runWebCraftAgent(config, projectName, message, attachments, guardedEmit, () => clientAborted);
    } catch (e) {
      if (!clientAborted) sse.send({ type: 'error', msg: e.message });
    }
    if (!res.writableEnded) sse.end();
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

  // ── Full project scan — lint ALL files at once ───────────────────────────
  router.post('/api/studio/webcraft/scan', async (req, res) => {
    try {
      const { projectName } = await parseBody(req);
      if (!projectName) return sendError(res, 400, 'projectName required');
      console.log('[scan] Starting scan for:', projectName);
      const dir = ProjectStore.dir(projectName);
      if (!fs.existsSync(dir)) return sendJSON(res, 200, { issues: [] });

      const files = _listProjectFiles(dir);
      const issues = [];

      for (const relPath of files) {
        const content = ProjectStore.readFile(projectName, relPath);
        if (!content) continue;
        const ext = (relPath.split('.').pop() || '').toLowerCase();

        let diags = [];
        if (['js', 'mjs', 'jsx', 'cjs'].includes(ext)) {
          try {
            const tsDiags = await lintJSWithTypeScript(dir, relPath);
            diags = tsDiags || lintJS(content, relPath, projectName);
          } catch { diags = lintJS(content, relPath, projectName); }
        } else if (ext === 'json') {
          try { JSON.parse(content); } catch (e) {
            diags.push({ from: { line: 1, col: 0 }, severity: 'error', message: e.message });
          }
        } else if (ext === 'css') {
          diags = lintCSS(content);
        } else if (ext === 'html' || ext === 'htm') {
          diags = lintHTML(content, relPath, projectName);
        }

        // Convert diagnostics to scan issues (only errors, not warnings — too noisy)
        for (const d of diags) {
          if (d.severity === 'error') {
            issues.push({ file: relPath, severity: d.severity, message: `Line ${d.from.line}: ${d.message}` });
          }
        }

        // Truncation check
        if (isFileTruncated(content, relPath)) {
          issues.push({ file: relPath, severity: 'error', message: 'File appears truncated — incomplete generation' });
        }
      }

      sendJSON(res, 200, { issues, scanned: files.length });
    } catch (e) { console.error('[scan] CRASH:', e); sendError(res, 500, e.message); }
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

/**
 * Robust tool call parser for when JSON.parse fails.
 * The LLM often puts raw HTML/code with unescaped quotes, newlines, < > inside JSON values.
 * This extracts "op", "path", "old", "new", "content", "query", "cmd" etc. by finding
 * the key-value boundaries manually.
 */
function _parseToolCallRobust(raw) {
  const result = {};

  // Extract "op" — always a simple string
  const opMatch = raw.match(/"op"\s*[:>]\s*"([^"]+)"/);
  if (opMatch) result.op = opMatch[1];

  // Extract "path" — simple string
  const pathMatch = raw.match(/"path"\s*[:>]\s*"([^"]+)"/);
  if (pathMatch) result.path = pathMatch[1];

  // Extract "newPath" — simple string
  const newPathMatch = raw.match(/"newPath"\s*[:>]\s*"([^"]+)"/);
  if (newPathMatch) result.newPath = newPathMatch[1];

  // Extract "query" — simple string (fix \| to |)
  const queryMatch = raw.match(/"query"\s*[:>]\s*"([^"]+)"/);
  if (queryMatch) result.query = queryMatch[1].replace(/\\\|/g, '|');

  // Extract "glob" — simple string
  const globMatch = raw.match(/"glob"\s*[:>]\s*"([^"]+)"/);
  if (globMatch) result.glob = globMatch[1];

  // Extract "cmd" — simple string
  const cmdMatch = raw.match(/"cmd"\s*[:>]\s*"([^"]+)"/);
  if (cmdMatch) result.cmd = cmdMatch[1];

  // For edit: extract "old" and "new" — these can be HUGE multiline strings with HTML
  // Strategy: find "old" key, then grab everything until we hit ","new" or the end
  if (result.op === 'edit') {
    const oldIdx = raw.indexOf('"old"');
    const newIdx = raw.indexOf('"new"');
    if (oldIdx >= 0 && newIdx > oldIdx) {
      // old value is between "old":"/>" and ","new"
      let oldStart = raw.indexOf('"', oldIdx + 5); // find opening quote after "old":
      if (oldStart < 0) oldStart = raw.indexOf('>', oldIdx + 5); // handle "old">
      if (oldStart >= 0) {
        oldStart++; // skip the opening quote/bracket
        // Find the end — look for ","new" pattern
        const oldEnd = raw.lastIndexOf('"', newIdx - 1);
        if (oldEnd > oldStart) {
          result.old = raw.slice(oldStart, oldEnd);
        }
      }
      // new value is after "new":"
      let newStart = raw.indexOf('"', newIdx + 5);
      if (newStart < 0) newStart = raw.indexOf('>', newIdx + 5);
      if (newStart >= 0) {
        newStart++;
        // Find end — last " before the closing }
        const lastBrace = raw.lastIndexOf('}');
        const newEnd = raw.lastIndexOf('"', lastBrace);
        if (newEnd > newStart) {
          result.new = raw.slice(newStart, newEnd);
        }
      }
    }
  }

  // For write: extract "content"
  if (result.op === 'write') {
    const contentIdx = raw.indexOf('"content"');
    if (contentIdx >= 0) {
      let contentStart = raw.indexOf('"', contentIdx + 9);
      if (contentStart < 0) contentStart = raw.indexOf('>', contentIdx + 9);
      if (contentStart >= 0) {
        contentStart++;
        const lastBrace = raw.lastIndexOf('}');
        const contentEnd = raw.lastIndexOf('"', lastBrace);
        if (contentEnd > contentStart) {
          result.content = raw.slice(contentStart, contentEnd);
        }
      }
    }
  }

  if (!result.op) throw new Error('Could not extract op from tool call');
  console.log(`[TOOL-PARSE] Robust parse recovered: op=${result.op} path=${result.path} old.len=${result.old?.length ?? 0} new.len=${result.new?.length ?? 0}`);
  return result;
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
  const launcherPath = path.join(projectDir, '.nha-launcher.js');
  const entryAbs = path.join(projectDir, entryFile).replace(/\\/g, '/');
  const shimAbs = path.join(shimDir, 'index.js').replace(/\\/g, '/');

  // Error reporter script — injected into HTML pages to catch runtime errors
  const nhaHost = `http://127.0.0.1:${process.env.NHA_UI_PORT || 3847}`;
  const errorScript = `<script>
(function(){var h="${nhaHost}";window.onerror=function(m,s,l,c,e){fetch(h+"/api/studio/webcraft/sandbox/errors",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({error:m,source:s,line:l,col:c,stack:e?e.stack:""})}).catch(function(){});};window.addEventListener("unhandledrejection",function(e){fetch(h+"/api/studio/webcraft/sandbox/errors",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({error:"Unhandled: "+(e.reason?e.reason.message||e.reason:"unknown"),stack:e.reason?e.reason.stack:""})}).catch(function(){});});})();
</script>`;

  // Write error reporter script file
  fs.writeFileSync(path.join(shimDir, 'error-reporter.html'), errorScript, 'utf-8');

  const launcher = [
    `// NHA WebCraft Sandbox Launcher — auto-generated`,
    `process.env.PORT = '${port}';`,
    `process.env.HOST = '0.0.0.0';`,
    `process.env.NODE_ENV = 'development';`,
    `require('${shimAbs}');`,
    `// Inject error reporter into HTML responses`,
    `const _nhaErrScript = require('fs').readFileSync('${path.join(shimDir, 'error-reporter.html').replace(/\\/g, '/')}', 'utf-8');`,
    `const _origWrite = require('http').ServerResponse.prototype.write;`,
    `const _origEnd = require('http').ServerResponse.prototype.end;`,
    `require('http').ServerResponse.prototype.end = function(chunk, enc, cb) {`,
    `  try {`,
    `    if (chunk && this.getHeader && (this.getHeader('content-type')||'').includes('html')) {`,
    `      var s = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : null;`,
    `      if (s && s.includes('</head>')) {`,
    `        var patched = s.replace('</head>', _nhaErrScript + '</head>');`,
    `        try { this.removeHeader('content-length'); } catch(e) {}`,
    `        return _origEnd.call(this, patched, enc, cb);`,
    `      }`,
    `    }`,
    `  } catch(e) {}`,
    `  return _origEnd.apply(this, arguments);`,
    `};`,
    `// Strip X-Frame-Options so sandbox iframe works`,
    `const _origSetHeader = require('http').ServerResponse.prototype.setHeader;`,
    `require('http').ServerResponse.prototype.setHeader = function(name, val) {`,
    `  if (name.toLowerCase() === 'x-frame-options') return this;`,
    `  if (name.toLowerCase() === 'content-security-policy' && typeof val === 'string' && val.includes('frame-ancestors')) {`,
    `    val = val.replace(/frame-ancestors[^;]*(;|$)/gi, '');`,
    `    if (!val.trim()) return this;`,
    `  }`,
    `  return _origSetHeader.call(this, name, val);`,
    `};`,
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
  const helmetShim = `
const noop = (req, res, next) => next();
const handler = () => noop;
handler.contentSecurityPolicy = handler;
handler.crossOriginEmbedderPolicy = handler;
handler.crossOriginOpenerPolicy = handler;
handler.crossOriginResourcePolicy = handler;
handler.dnsPrefetchControl = handler;
handler.frameguard = handler;
handler.hidePoweredBy = handler;
handler.hsts = handler;
handler.ieNoOpen = handler;
handler.noSniff = handler;
handler.originAgentCluster = handler;
handler.permittedCrossDomainPolicies = handler;
handler.referrerPolicy = handler;
handler.xssFilter = handler;
module.exports = handler;
`;

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
      // Use the ESM-imported Socket — NEVER `require('net')` here, this file
      // is .mjs and `require` is not defined in ESM. The require call here
      // was the single root cause of "[error] require is not defined" with
      // no autofix flow visible — the crash happened INSIDE the nha ui
      // server itself (in this exact function), not in the child sandbox.
      const sock = new Socket();
      sock.setTimeout(500);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); if (Date.now() > deadline) { resolve(false); } else { setTimeout(check, 300); } });
      sock.once('timeout', () => { sock.destroy(); if (Date.now() > deadline) { resolve(false); } else { setTimeout(check, 300); } });
      sock.connect(port, 'localhost');
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
