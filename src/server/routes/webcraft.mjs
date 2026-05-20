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

    // ── Phase 0: Pre-flight repair ───────────────────────────────────────
    // Before anything else, check that package.json on disk is valid JSON.
    // If a previous LLM generation wrote a corrupt file (e.g. an HTTP error
    // response leaked as content), Node's package_json_reader would crash
    // with SyntaxError before we even get to load shims. Repair in place.
    const pkgPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkgRaw = fs.readFileSync(pkgPath, 'utf-8');
      let needsRepair = false;
      let reason = '';
      if (_looksLikeLLMError(pkgRaw)) {
        needsRepair = true;
        reason = 'content looks like an LLM API error response (Access denied / Rate limit / HTML block page)';
      } else {
        try { JSON.parse(pkgRaw); }
        catch (e) { needsRepair = true; reason = `invalid JSON: ${e.message}`; }
      }
      if (needsRepair) {
        emit({ type: 'warn', msg: `package.json corrupt (${reason}) — auto-repairing with minimal fallback so the sandbox can boot.` });
        const projectName = path.basename(projectDir);
        fs.writeFileSync(pkgPath, _fallbackPackageJson(projectName), 'utf-8');
        emit({ type: 'status', msg: `package.json repaired. Original corrupt content backed up to package.json.corrupt-${Date.now()}` });
        try {
          fs.writeFileSync(pkgPath + '.corrupt-' + Date.now(), pkgRaw, 'utf-8');
        } catch {}
      }
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

    // Pre-flight: validate ALL .js/.mjs/.cjs/.jsx files in the project with
    // acorn. If any are corrupted (partial stream / HTTP error leaked as code),
    // quarantine them with a minimal stub. This catches LLM stream interruptions
    // in route handlers (routes/auth.js, routes/billing.js, etc.) — not just
    // the entry file.
    const repaired = [];
    const codeExts = new Set(['.js', '.mjs', '.cjs', '.jsx']);
    const scanSkip = new Set(['node_modules', '.git', '.nha-shims', 'dist', 'build', '.next', 'coverage']);
    const projectBase = path.basename(projectDir);
    const stack = [projectDir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (scanSkip.has(ent.name) || ent.name.startsWith('.')) continue;
        const abs = path.join(cur, ent.name);
        if (ent.isDirectory()) { stack.push(abs); continue; }
        if (!codeExts.has(path.extname(ent.name))) continue;
        try {
          const content = fs.readFileSync(abs, 'utf-8');
          const relName = path.relative(projectDir, abs);
          const sanitized = _sanitizeGeneratedFile(relName, content, projectBase);
          if (sanitized !== content) {
            fs.writeFileSync(abs + '.corrupt-' + Date.now(), content, 'utf-8');
            fs.writeFileSync(abs, sanitized, 'utf-8');
            repaired.push(relName);
          }
        } catch {}
      }
    }
    if (repaired.length > 0) {
      emit({ type: 'warn', msg: `Pre-flight repair: ${repaired.length} file${repaired.length === 1 ? '' : 's'} quarantined (corrupted content) → ${repaired.join(', ')}. Re-generate from chat to restore them.` });
    }

    // Pre-flight: create missing data dirs/files referenced by code.
    // LLMs frequently generate `fs.writeFile('data/users.json', ...)` without
    // creating data/ first → ENOENT crash on boot. Scan code for these
    // references and seed empty placeholders BEFORE the sandbox starts.
    try {
      const dataFiles = _detectMissingDataFiles(projectDir);
      if (dataFiles.length > 0) {
        emit({ type: 'status', msg: `Pre-flight: seeded ${dataFiles.length} data file${dataFiles.length === 1 ? '' : 's'} → ${dataFiles.slice(0, 5).join(', ')}${dataFiles.length > 5 ? '...' : ''}` });
      }
    } catch {}

    // Pre-flight: auto-extend CSS until 100% coverage (or LLM stops making
    // progress). Target = 100%; max 5 passes as safety; early-exit if two
    // consecutive passes don't reduce missing count (LLM stuck) or LLM fails.
    // Goal: ZERO uncovered selectors when the LLM is capable of producing them.
    try {
      const projectName = path.basename(projectDir);
      const cfg = loadConfig();
      const maxPasses = 5;
      let totalCovered = 0;
      let prevMissing = Infinity;
      let stuckPasses = 0;
      for (let pass = 1; pass <= maxPasses; pass++) {
        const styleResult = await _autoExtendStylesIfNeeded(projectName, cfg, emit, { minCoverage: 1.0 });
        if (!styleResult.extended) {
          if (styleResult.reason === 'coverage acceptable') break;  // already 100%
          // LLM failed or skipped — stop loop
          break;
        }
        const newlyCovered = (styleResult.missingBefore || 0) - (styleResult.missingAfter || 0);
        totalCovered += newlyCovered;
        const missingNow = styleResult.missingAfter || 0;
        emit({ type: 'status', msg: `Pass ${pass}/${maxPasses}: ${styleResult.file} extended — ${newlyCovered} new selectors covered (${missingNow} still missing, ${((styleResult.coverageAfter || 0) * 100).toFixed(0)}% coverage).` });
        if (missingNow === 0) {
          emit({ type: 'status', msg: `100% CSS coverage reached after ${pass} pass${pass === 1 ? '' : 'es'}. Total ${totalCovered} selectors covered.` });
          break;
        }
        if (missingNow >= prevMissing) {
          stuckPasses++;
          if (stuckPasses >= 2) {
            emit({ type: 'warn', msg: `LLM stopped making progress on extension (${missingNow} selectors still missing — likely pseudo-classes or JS-state classes the model can't infer). Stopping at ${((styleResult.coverageAfter || 0) * 100).toFixed(0)}%.` });
            break;
          }
        } else {
          stuckPasses = 0;
        }
        prevMissing = missingNow;
      }
    } catch (e) {
      emit({ type: 'warn', msg: `Auto-extend styles failed: ${(e.message || e).slice(0, 200)}` });
    }

    // Pre-flight: complete missing CSS/JS assets via sibling fill + LLM gen.
    // Replaces the previous "empty placeholder" strategy with real content
    // when available. LLM calls capped at 8 files per boot to keep latency
    // bounded; anything beyond falls back to stub (logged).
    try {
      const projectName = path.basename(projectDir);
      const cfg = loadConfig();
      const completionReport = await _completeMissingAssets(projectName, cfg, emit);
      const total = completionReport.siblingFills.length + completionReport.llmFills.length + completionReport.stubFallbacks.length;
      if (total > 0) {
        emit({ type: 'status', msg: `Pre-flight asset completion: ${completionReport.siblingFills.length} from siblings, ${completionReport.llmFills.length} via LLM, ${completionReport.stubFallbacks.length} as stubs.` });
      }
    } catch (e) {
      emit({ type: 'warn', msg: `Asset completion failed: ${(e.message || e).slice(0, 200)}` });
    }

    // Pre-flight: repair unsafe err.X / error.X access in route handlers.
    // LLMs write `res.send(err.stack)` without null-checking err → 500 on
    // every request when error middleware signature is wrong (3 args not 4).
    try {
      const errRepaired = _repairUnsafeErrAccess(projectDir);
      if (errRepaired.length > 0) {
        const fileList = errRepaired.slice(0, 5).map(r => `${r.file} (${r.edits} fixes)`).join(', ');
        emit({ type: 'status', msg: `Pre-flight: null-checked ${errRepaired.reduce((s, r) => s + r.edits, 0)} unsafe err/error accesses in ${errRepaired.length} file${errRepaired.length === 1 ? '' : 's'} → ${fileList}${errRepaired.length > 5 ? '...' : ''}` });
      }
    } catch {}

    // ── Phase 2: Dependencies (pre-scan + batch install) ──────────────────
    // Pre-scan the project source files for require()/import statements and
    // diff against package.json + node_modules. Install everything missing in
    // ONE batch BEFORE spawning the sandbox, so the Tier 1 retry-on-crash
    // becomes a fallback, not the main code path.
    if (fs.existsSync(path.join(projectDir, 'package.json'))) {
      const scanned = _scanProjectImports(projectDir);
      const declared = _declaredDeps(projectDir);
      const installed = _installedDeps(projectDir);
      const missing = [...scanned].filter(m => !declared.has(m) && !installed.has(m) && !_SHIMMED_MODULES.has(m));

      if (missing.length > 0) {
        emit({ type: 'phase', phase: 'deps-prescan', msg: `Pre-scan: ${missing.length} missing module${missing.length === 1 ? '' : 's'} → ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '...' : ''}` });
      }

      emit({ type: 'phase', phase: 'deps', msg: 'Installing dependencies...' });
      const installCmd = missing.length > 0
        ? `npm install --save --prefer-offline --no-audit --no-fund ${missing.map(m => JSON.stringify(m)).join(' ')} 2>&1`
        : 'npm install --prefer-offline --no-audit --no-fund 2>&1';
      try {
        const { stdout } = await execAsync(installCmd, {
          cwd: projectDir,
          timeout: 180_000,
          env: { ...process.env, NODE_ENV: 'development' },
        });
        const added = stdout.match(/added (\d+) package/)?.[1] || '0';
        emit({ type: 'status', msg: `Dependencies installed (${added} packages${missing.length ? `, batch: ${missing.join(', ')}` : ''})` });
      } catch (e) {
        const diag = _classifyInstallError(e);
        emit({ type: 'warn', msg: `npm install failed — reason: ${diag.reason}. ${diag.hint}` });
        if (diag.offlineFallback) {
          emit({ type: 'status', msg: 'Activating NHA_OFFLINE_SHIM=1 fallback for missing modules.' });
          this._offlineShim = true;
        }
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
    const childEnv = {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      NHA_SANDBOX: '1',
    };
    if (this._offlineShim) childEnv.NHA_OFFLINE_SHIM = '1';
    const proc = spawn('node', [patchedEntry], {
      cwd: projectDir,
      env: childEnv,
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
      // ── HTTP probe: actually fetch GET / and report what came back ─────
      // Tells the user IMMEDIATELY if the sandbox bound the port but serves
      // a 404 / empty body / wrong content-type. Otherwise they see "ready"
      // but the iframe is black/blank and can't tell why.
      try {
        const probeRes = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(5000),
          redirect: 'manual',
        }).catch(e => ({ _err: e.message }));
        if (probeRes._err) {
          emit({ type: 'warn', msg: `Probe GET /: ${probeRes._err}. The port is bound but the app doesn't respond on / — check your route handlers.` });
        } else {
          const ct = probeRes.headers.get('content-type') || '(none)';
          const status = probeRes.status;
          const body = await probeRes.text().catch(() => '');
          const len = body.length;
          const isHtml = /text\/html/i.test(ct);
          const isJson = /application\/json/i.test(ct);
          const preview = body.slice(0, 200).replace(/\s+/g, ' ').trim();
          emit({ type: 'log', msg: `[probe] GET / → ${status} (${ct}, ${len} bytes)` });
          if (status >= 400) {
            // Show the actual error body so the user knows WHAT went wrong,
            // not just the status code. 500s from Express handlers often
            // include the stack trace or error message in the body.
            const bodyPreview = body.slice(0, 800).trim();
            emit({ type: 'error', msg: `Probe: GET / returned ${status}. Response body:\n${bodyPreview}` });
            if (status === 500) {
              emit({ type: 'warn', msg: `500 Internal Server Error usually means the route handler threw. Common causes: missing await on async function, JSON.parse on empty file, undefined variable, DB connection failure. Check stderr logs above for the actual stack trace.` });
            } else if (status === 404) {
              emit({ type: 'warn', msg: `404 means no route matches "/". Add app.get('/', ...) returning HTML, or app.use(express.static('public')) if you have an index.html in public/.` });
            }
          } else if (len === 0) {
            emit({ type: 'warn', msg: `Probe: GET / returned empty body (${status}). The route exists but sends no response — check that you call res.send() / res.json() / res.end().` });
          } else if (isHtml && !/<\w+/.test(body)) {
            emit({ type: 'warn', msg: `Probe: GET / claims text/html but has no HTML tags. Preview: "${preview}". Likely a plain text leaked into the response.` });
          } else if (isJson) {
            emit({ type: 'status', msg: `Probe: GET / returns JSON. Browser preview will show raw JSON, not a rendered page. Consider serving an index.html with app.use(express.static('public')) or add a / route returning HTML.` });
          } else if (isHtml) {
            emit({ type: 'status', msg: `Probe: GET / returns HTML (${len} bytes). Iframe preview should render fine.` });
          } else {
            emit({ type: 'log', msg: `[probe] body preview: ${preview}` });
          }
        }
      } catch (e) {
        emit({ type: 'log', msg: `[probe] failed: ${e.message}` });
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

    // ── Tier 1: missing module → batch install all missing + retry ───────
    // The pre-scan in Phase 2 catches most cases. Tier 1 here is the safety
    // net for files generated AFTER pre-scan (e.g. user added a require()
    // during chat) or for transitive crashes that surface only at runtime.
    const rawMissing = [...stderrBuf.matchAll(/Cannot find module ['"]([^'"]+)['"]/g)]
      .map(m => m[1])
      .filter(m => !m.startsWith('.') && !m.startsWith('/') && !m.startsWith('node:'))
      .map(m => m.startsWith('@') ? m.split('/').slice(0, 2).join('/') : m.split('/')[0])
      // Drop Node.js built-ins — they're in the runtime, can't be installed
      .filter(m => !_NODE_BUILTINS.has(m));
    // Resolve LLM hallucinated aliases (jwt → jsonwebtoken, bcrypt → bcryptjs)
    const missingModules = rawMissing.map(m => _PACKAGE_ALIASES.get(m) || m);
    // Detect aliases — if the shim already covers the resolved name, no install needed
    const aliasedFromShim = rawMissing.filter(m => {
      const real = _PACKAGE_ALIASES.get(m);
      return real && _SHIMMED_MODULES.has(real);
    });
    if (aliasedFromShim.length > 0) {
      emit({ type: 'warn', msg: `LLM hallucinated package names: ${aliasedFromShim.join(', ')} — the runtime shim already aliases these. If you still see this crash, the shim wasn't re-generated. Restart "nha ui".` });
    }
    const uniqueMissing = [...new Set(missingModules)].filter(m => !_SHIMMED_MODULES.has(m));
    if (uniqueMissing.length > 0 && _attempt < MAX_RETRIES) {
      emit({ type: 'phase', phase: 'autofix', msg: `Missing module${uniqueMissing.length === 1 ? '' : 's'}: ${uniqueMissing.join(', ')} — batch installing...` });
      try {
        await execAsync(`npm install --save --no-audit --no-fund ${uniqueMissing.map(m => JSON.stringify(m)).join(' ')}`, {
          cwd: projectDir,
          timeout: 120_000,
          env: { ...process.env, NODE_ENV: 'development' },
        });
        emit({ type: 'status', msg: `Installed ${uniqueMissing.join(', ')} — retrying (attempt ${_attempt + 1}/${MAX_RETRIES})...` });
        return this.start(projectName, projectDir, emit, _attempt + 1);
      } catch (installErr) {
        const diag = _classifyInstallError(installErr);
        emit({ type: 'warn', msg: `Batch install failed — reason: ${diag.reason}. ${diag.hint}` });
        if (diag.offlineFallback) {
          emit({ type: 'status', msg: `Activating NHA_OFFLINE_SHIM=1 fallback — retrying with offline shim...` });
          this._offlineShim = true;
          return this.start(projectName, projectDir, emit, _attempt + 1);
        }
      }
    }

    // ── Tier 1b: ENOENT on file write → create missing path + retry ──────
    // Deterministic. LLM SaaS code often writes to data/users.json without
    // mkdir -p data/ first → ENOENT. We detect, create the dir + empty
    // placeholder JSON, and retry. Zero LLM call needed.
    const enoentMatch = stderrBuf.match(/ENOENT[^']*open\s+['"]([^'"]+)['"]/);
    if (enoentMatch && _attempt < MAX_RETRIES) {
      const missingPath = enoentMatch[1];
      // Only auto-create if path is inside the project
      const projectAbs = path.resolve(projectDir);
      const missingAbs = path.resolve(missingPath);
      if (missingAbs.startsWith(projectAbs)) {
        emit({ type: 'phase', phase: 'autofix', msg: `ENOENT on ${missingPath} — creating directory + empty placeholder...` });
        try {
          ensureDir(path.dirname(missingAbs));
          if (!fs.existsSync(missingAbs)) {
            const ext = path.extname(missingAbs).toLowerCase();
            let stub = '';
            if (ext === '.json') stub = /users|posts|items|list|todos|comments|orders|products/i.test(missingPath) ? '[]' : '{}';
            else if (ext === '.sqlite' || ext === '.db') { /* skip binary */ }
            else stub = '';
            if (ext !== '.sqlite' && ext !== '.db') fs.writeFileSync(missingAbs, stub, 'utf-8');
          }
          emit({ type: 'status', msg: `Created ${missingPath} — retrying (attempt ${_attempt + 1}/${MAX_RETRIES})...` });
          return this.start(projectName, projectDir, emit, _attempt + 1);
        } catch (e) {
          emit({ type: 'warn', msg: `Failed to create ${missingPath}: ${e.message.slice(0, 200)}` });
        }
      }
    } else if (missingModules.length > 0 && uniqueMissing.length === 0) {
      // All missing modules are shimmable in THIS version of the CLI. If we
      // reached this branch, the user has an OLDER CLI installed that doesn't
      // know about these shims yet. Surface this loudly with the exact upgrade
      // command — DON'T leave the user staring at a generic crash.
      emit({ type: 'error', msg:
        `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚠ IL TUO NHA È OBSOLETO — questo crash è già fixato nell'ultima versione.\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Moduli mancanti che la nuova versione gestisce automaticamente:\n` +
        `  → ${missingModules.join(', ')}\n\n` +
        `Aggiorna NHA (3 comandi):\n` +
        `  1. npm install -g nothumanallowed@latest\n` +
        `  2. pkill -f "nha-launcher" ; pkill -f "node.*nha"\n` +
        `  3. nha ui\n\n` +
        `Verifica versione dopo: nha --version (deve essere >= 16.0.25)\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      });
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

            // VALIDATION: prevent rollback hell. Reject the LLM output if:
            //   1. Empty / too short (< 20 chars or < 30% of original)
            //   2. Identical to original (no fix attempted)
            //   3. Looks like LLM error response leaked
            //   4. Syntax-checkable file (.js/.mjs) that doesn't parse — would be worse than original
            const tooShort = fixed.length < 20 || fixed.length < original.length * 0.3;
            const isErrorLeak = _looksLikeLLMError(fixed);
            let syntaxBroken = false;
            if (!tooShort && !isErrorLeak && (rel.endsWith('.js') || rel.endsWith('.mjs') || rel.endsWith('.cjs'))) {
              try { new Function(fixed); } catch (synErr) {
                // Try with sourceType:module via acorn before declaring broken
                try { acorn.parse(fixed, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true }); }
                catch { syntaxBroken = true; }
              }
            }
            if (tooShort || isErrorLeak || syntaxBroken || fixed === original) {
              // Backup the LLM attempt for debugging, but DON'T overwrite the file
              try { fs.writeFileSync(abs + '.llm-rejected-' + Date.now(), fixed, 'utf-8'); } catch {}
              const reason = tooShort ? `output too short (${fixed.length} vs ${original.length} chars)`
                            : isErrorLeak ? 'output looks like an LLM/provider error response'
                            : syntaxBroken ? 'output has worse syntax errors than input'
                            : 'no change';
              emit({ type: 'warn', msg: `Auto-fix REJECTED for ${rel}: ${reason}. Original file preserved.` });
            } else {
              // Backup original before overwriting
              try { fs.writeFileSync(abs + '.before-autofix-' + Date.now(), original, 'utf-8'); } catch {}
              fs.writeFileSync(abs, fixed, 'utf-8');
              emit({ type: 'status', msg: `Auto-fix: ✓ repaired ${rel} (${original.length} → ${fixed.length} chars)` });
              anyFixed = true;
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
      const sanitized = _sanitizeGeneratedFile(f.name, f.content ?? '', projectName);
      fs.writeFileSync(abs, sanitized, 'utf-8');
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
      // Include the actual file content in the error response so the LLM can
      // produce a correct old_text on retry without needing a separate read_file.
      return `Error: old_text not found in file.\n\nCURRENT CONTENT OF ${relPath}:\n\`\`\`\n${src.slice(0, 16000)}\n\`\`\`\n\nPick the EXACT lines you want to replace from above, copy them as old_text, and retry edit_file.`;
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

  // Try native tool calling first. Providers that support OpenAI-style native
  // tool_use: Anthropic, OpenAI, and OpenRouter (which proxies to Claude/GPT/etc.
  // with the same OpenAI-compatible schema).
  const provider = config.llm?.provider || 'anthropic';
  const useNativeTools = provider === 'anthropic' || provider === 'openai' || provider === 'openrouter';

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
    // (kept for backward compatibility with Gemini, DeepSeek, Liara, etc.)
    let conversationHistory = [{ role: 'user', content: userContent }];
    emit({ type: 'text', token: 'Note: Using text-based tools (native tool calling not available for this provider).\n' });
    // Inject text-based tool-format instructions into the user message so the
    // LLM emits calls in a format the parser recognizes. The parser now ALSO
    // accepts OpenAI/Anthropic-style nude JSON, but the wrapper form is more
    // robust against truncation.
    const textBasedFormat = `
TOOL CALL FORMAT (CRITICAL):
You MUST emit tool calls using THIS exact format (one per line, on its own line):

<tool>{"op": "read", "path": "public/index.html"}</tool>
<tool>{"op": "edit", "path": "public/index.html", "old": "exact old text", "new": "new text"}</tool>
<tool>{"op": "write", "path": "public/css/main.css", "content": "body { ... }"}</tool>
<tool>{"op": "check", "path": "server.js"}</tool>

Valid ops: read, edit, write, delete, list, search, run, check, sandbox

DO NOT write things like {"tool": "read_file", "args": {...}} — that format is for
OpenAI-native providers, not for you. Use <tool>{"op": "read", "path": "..."}</tool>.

After ALL fixes are done, emit <done/> on its own line.
`;
    conversationHistory[0].content = (typeof conversationHistory[0].content === 'string' ? conversationHistory[0].content : userContent) + '\n\n' + textBasedFormat;
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

    // Extract and execute ALL tool calls from this step.
    // Accept THREE wire formats (LLM providers vary wildly):
    //   1. NHA native:    <tool>{"op":"read","path":"..."}</tool>
    //   2. OpenAI-style:  {"tool":"read_file","args":{"file_path":"..."}}
    //   3. Anthropic-style: <tool>{"name":"read_file","input":{"path":"..."}}</tool>
    // Normalize all three into the internal {op, path, ...} shape before dispatch.
    const toolCalls = _extractAllToolCalls(stepResponse);
    const toolResults = [];
    const matchedRanges = toolCalls.matchedRanges;

    for (const rawCall of toolCalls.calls) {
      let toolCall;
      try {
        toolCall = _normalizeToolCall(rawCall);
      } catch (parseErr) {
        console.error('[TOOL-PARSE] failed:', parseErr.message, 'raw:', JSON.stringify(rawCall).slice(0, 200));
        toolResults.push({ op: 'error', result: 'parse_failed' });
        emit({ type: 'tool', op: 'parse_error', path: '', result: 'parse_failed' });
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
            // No match — auto-read the file and INCLUDE its content in the
            // feedback. Without this, the LLM at the next step is blind and
            // can't correct the old_text. Critical fix for text-based mode
            // where the LLM doesn't see tool results between calls.
            const fileContentForRetry = src.slice(0, 16000);
            toolResults.push({
              op: 'edit',
              path: relPath,
              result: 'old_not_found',
              hint: 'Your old_text did NOT match the file. The CURRENT file content is included below — copy the EXACT lines you want to replace and retry edit with that exact text as old.',
              content: fileContentForRetry,
            });
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

    // Build tool results feedback for next iteration.
    // CRITICAL: when edit fails with old_not_found, include the CURRENT
    // file content so the LLM can produce a correct old_text on retry.
    // Without this, text-based mode loops forever on the same wrong old_text.
    const feedbackParts = toolResults.map((r) => {
      let msg = `[${r.op}] ${r.path || ''}: ${r.result}`;
      if (r.hint) msg += `\n  HINT: ${r.hint}`;
      if (r.content) {
        msg += `\n\nCURRENT CONTENT OF ${r.path}:\n\`\`\`\n${r.content}\n\`\`\`\n\nTo fix: pick the exact lines you want to replace from above, use them as "old", and retry the edit.`;
      }
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
    // ROBUST lint endpoint — NEVER returns 500. If any linter crashes,
    // returns 200 with empty diagnostics + the error logged. A failed lint
    // must not break the IDE streaming flow.
    try {
      const { projectName, path: relPath } = await parseBody(req);
      if (!projectName || !relPath) return sendError(res, 400, 'projectName and path required');
      let content;
      try { content = ProjectStore.readFile(projectName, relPath); }
      catch { content = null; }
      if (content === null || content === undefined) return sendJSON(res, 200, { diagnostics: [] });

      const ext = (relPath.split('.').pop() || '').toLowerCase();
      let diagnostics = [];

      // Each linter wrapped individually — a crash in one doesn't kill the others
      if (['js', 'mjs', 'jsx', 'cjs'].includes(ext)) {
        try {
          const projectDir = ProjectStore.dir(projectName);
          const tsDiags = await lintJSWithTypeScript(projectDir, relPath).catch(() => null);
          diagnostics = tsDiags || lintJS(content, relPath, projectName) || [];
        } catch (e) {
          console.error('[lint] JS linter crashed for', relPath, ':', e.message);
          diagnostics = [];
        }
      } else if (ext === 'json') {
        try {
          JSON.parse(content);
        } catch (e) {
          try {
            const posMatch = e.message.match(/position (\d+)/i);
            const pos = posMatch ? parseInt(posMatch[1]) : 0;
            const before = content.slice(0, pos).split('\n');
            diagnostics.push({
              from: { line: before.length, col: (before[before.length - 1] || '').length },
              severity: 'error',
              message: e.message,
            });
          } catch {}
        }
      } else if (ext === 'css') {
        try { diagnostics = lintCSS(content) || []; }
        catch (e) { console.error('[lint] CSS linter crashed:', e.message); diagnostics = []; }
      } else if (ext === 'html' || ext === 'htm') {
        try { diagnostics = lintHTML(content, relPath, projectName) || []; }
        catch (e) { console.error('[lint] HTML linter crashed:', e.message); diagnostics = []; }
      }

      sendJSON(res, 200, { diagnostics });
    } catch (e) {
      // Even the outer catch returns 200 — lint failures must not break the IDE
      console.error('[lint] outer error:', e.message);
      sendJSON(res, 200, { diagnostics: [], error: e.message });
    }
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

  // ── Auto-extend CSS when coverage is below threshold ──────────────────────
  router.post('/api/studio/webcraft/extend-styles', async (req, res) => {
    try {
      const { projectName, minCoverage } = await parseBody(req);
      if (!projectName) return sendError(res, 400, 'projectName required');
      const config = loadConfig();
      const result = await _autoExtendStylesIfNeeded(projectName, config, null, { minCoverage: minCoverage ?? 0.6 });
      sendJSON(res, 200, result);
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Smart asset completion (sibling fill + LLM generation) ────────────────
  // For missing CSS/JS referenced in HTML: first try copying from sibling
  // files with real content (deterministic, instant), then LLM-generate
  // anything still missing. Falls back to stub only when both fail.
  router.post('/api/studio/webcraft/complete', async (req, res) => {
    try {
      const { projectName } = await parseBody(req);
      if (!projectName) return sendError(res, 400, 'projectName required');
      const config = loadConfig();
      const report = await _completeMissingAssets(projectName, config, null);
      sendJSON(res, 200, report);
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Deterministic auto-repair (zero LLM, pure code) ────────────────────────
  // Handles the common bug classes that the LLM gets wrong:
  //   1. Mismatched/unclosed HTML tags  → balance via tag stack
  //   2. Referenced files not found     → create empty placeholders
  // No tool calling, no streaming, no LLM. Synchronous fixes.
  router.post('/api/studio/webcraft/auto-repair', async (req, res) => {
    try {
      const { projectName } = await parseBody(req);
      if (!projectName) return sendError(res, 400, 'projectName required');
      const result = autoRepairProject(projectName);
      sendJSON(res, 200, result);
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

/**
 * Robust tool call parser for when JSON.parse fails.
 * The LLM often puts raw HTML/code with unescaped quotes, newlines, < > inside JSON values.
 * This extracts "op", "path", "old", "new", "content", "query", "cmd" etc. by finding
 * the key-value boundaries manually.
 */
// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC AUTO-REPAIR
// Fixes common bug classes (mismatched HTML tags, missing CSS/JS files) using
// pure code — NO LLM call. The LLM-based "Fix" button is fragile when the
// provider doesn't support native tool calling; this deterministic pass runs
// first and resolves 80% of common project errors instantly.
// ─────────────────────────────────────────────────────────────────────────────

const _HTML_VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/**
 * Balance HTML tags in `html` by tracking open/close via a pushdown stack.
 * Returns { fixed, balanced, edits } where:
 *   - fixed: the corrected HTML string
 *   - balanced: true if tags were already balanced or fixable, false if too broken
 *   - edits: list of human-readable changes (for logging)
 */
export function _balanceHtmlTags(html) {
  const edits = [];
  // Strip comments and scripts/styles to avoid false matches in their content
  const placeholders = [];
  let work = html
    .replace(/<!--[\s\S]*?-->/g, (m) => { placeholders.push(m); return `__NHA_PH_${placeholders.length - 1}__`; })
    .replace(/<(script|style)([^>]*)>([\s\S]*?)<\/\1>/gi, (m) => { placeholders.push(m); return `__NHA_PH_${placeholders.length - 1}__`; });

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/g;
  const stack = [];
  let outStr = '';
  let lastIdx = 0;
  let match;

  while ((match = tagRe.exec(work)) !== null) {
    const tag = match[0];
    const name = match[1].toLowerCase();
    const isClose = tag.startsWith('</');
    const isSelfClose = tag.endsWith('/>') || _HTML_VOID.has(name);

    outStr += work.slice(lastIdx, match.index);

    if (isClose) {
      // Find matching open in stack
      let depth = stack.length - 1;
      let foundAt = -1;
      while (depth >= 0) {
        if (stack[depth].name === name) { foundAt = depth; break; }
        depth--;
      }
      if (foundAt === -1) {
        // Stray close — drop it
        edits.push(`Removed stray </${name}>`);
        // Skip writing this tag
        lastIdx = match.index + tag.length;
        continue;
      }
      // Auto-close anything above the match
      while (stack.length - 1 > foundAt) {
        const top = stack.pop();
        outStr += `</${top.name}>`;
        edits.push(`Auto-closed <${top.name}> before </${name}>`);
      }
      stack.pop();
      outStr += tag;
    } else if (isSelfClose) {
      outStr += tag;
    } else {
      stack.push({ name, idx: match.index });
      outStr += tag;
    }
    lastIdx = match.index + tag.length;
  }
  outStr += work.slice(lastIdx);

  // Close any remaining open tags at the very end
  while (stack.length > 0) {
    const top = stack.pop();
    // Insert closing tags before </body> or </html> if present, else at end
    const bodyClose = outStr.lastIndexOf('</body>');
    const htmlClose = outStr.lastIndexOf('</html>');
    let insertAt = outStr.length;
    if (bodyClose !== -1 && top.name !== 'body' && top.name !== 'html') insertAt = bodyClose;
    else if (htmlClose !== -1 && top.name !== 'html') insertAt = htmlClose;
    outStr = outStr.slice(0, insertAt) + `</${top.name}>` + outStr.slice(insertAt);
    edits.push(`Auto-closed <${top.name}> at end of document`);
  }

  // Restore placeholders
  const fixed = outStr.replace(/__NHA_PH_(\d+)__/g, (_, i) => placeholders[+i] || '');
  return { fixed, balanced: true, edits };
}

/**
 * Extract <link href="..."> and <script src="..."> + <img src="..."> targets
 * from HTML. Returns relative paths that point inside the project.
 */
function _extractHtmlAssetRefs(html) {
  const refs = [];
  const linkRe = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) refs.push({ kind: 'css', href: m[1] });
  while ((m = scriptRe.exec(html)) !== null) refs.push({ kind: 'js', href: m[1] });
  return refs;
}

function _normalizeAssetPath(href, htmlRelPath) {
  // Strip query/hash
  let p = href.replace(/[?#].*$/, '');
  // Skip external (http://, https://, //, data:)
  if (/^(?:https?:)?\/\//.test(p) || p.startsWith('data:') || p.startsWith('//')) return null;
  // Absolute paths starting with / are project-root-relative
  if (p.startsWith('/')) return p.slice(1);
  // Relative paths — resolve against the HTML file's directory
  const htmlDir = path.dirname(htmlRelPath);
  return path.posix.normalize(path.posix.join(htmlDir, p));
}

function _placeholderContent(kind, refPath) {
  if (kind === 'css') {
    return `/* nha-webcraft: auto-created placeholder for ${refPath}\n   The HTML referenced this file but it didn't exist. This is a\n   minimal stub to keep the sandbox bootable. Add real styles via chat. */\n\n/* base reset */\n* { box-sizing: border-box; }\nbody { margin: 0; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }\n`;
  }
  if (kind === 'js') {
    return `// nha-webcraft: auto-created placeholder for ${refPath}\n// The HTML referenced this file but it didn't exist. This is a\n// minimal stub to keep the sandbox bootable. Add real logic via chat.\nconsole.log('[${refPath}] placeholder loaded');\n`;
  }
  return '';
}

/**
 * Scan all .js/.mjs/.ts files for filesystem paths referenced in string
 * literals (typically used for file-based storage by LLM-generated SaaS code:
 * fs.writeFile('data/users.json', ...), fs.readFile('db/posts.json'), etc).
 * Creates missing directories + empty JSON placeholders so the app can boot
 * instead of crashing with ENOENT on first write.
 */
/**
 * Auto-repair unsafe `err.X` and similar null-deref patterns in route handlers.
 * The most common LLM-generated bug: error middleware that does `res.send(err.stack)`
 * but `err` is undefined because the middleware signature is wrong (only 3 args
 * instead of 4). Result: 500 on EVERY request including static files.
 *
 * Pattern fixed:
 *   err.stack       → (err && err.stack)          if not already null-checked
 *   err.message     → (err && err.message)        same
 *   error.stack     → (error && error.stack)      same
 *   error.message   → (error && error.message)    same
 *
 * Skips matches already guarded (`err && err.stack`, `err?.stack`, `err?.message`).
 */
export function _repairUnsafeErrAccess(projectDir) {
  const repaired = [];
  const exts = new Set(['.js', '.mjs', '.cjs']);
  const skipDirs = new Set(['node_modules', '.git', '.nha-shims', 'dist', 'build', '.next', 'public']);
  // Match `IDENT.PROP` where PROP is stack|message and IDENT is err|error|e.
  // Negative lookbehind: skip if preceded by `&&`, `||`, `?.`, `(`, `:`, `,`.
  // Use a global regex and inspect context manually.
  const targetIdents = ['err', 'error', 'e'];
  const targetProps = ['stack', 'message', 'code', 'statusCode', 'name'];

  const stack = [projectDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (skipDirs.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) { stack.push(abs); continue; }
      if (!exts.has(path.extname(ent.name))) continue;
      let content;
      try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }

      let changed = content;
      const edits = [];

      for (const ident of targetIdents) {
        for (const prop of targetProps) {
          // Match unsafe access: `ident.prop` not preceded by `&&`, `?`, `||`
          // Use a simpler regex + manual filter for surrounding context
          const re = new RegExp(`\\b${ident}\\.${prop}\\b`, 'g');
          changed = changed.replace(re, (match, offset, str) => {
            // Check context preceding this match
            const before = str.slice(Math.max(0, offset - 40), offset);
            // Already guarded patterns — skip
            if (/&&\s*$/.test(before)) return match;
            if (/\?\.$/.test(before.slice(-2))) return match;
            if (/\?\s*$/.test(before)) return match;
            if (/\|\|\s*$/.test(before)) return match;
            // Inside object literal key (e.g., `{ stack: err.stack }`) is harmless
            // when it's the value. We still wrap because the assignment crashes too.
            // Inside a string literal — skip
            const lineStart = str.lastIndexOf('\n', offset) + 1;
            const lineUpTo = str.slice(lineStart, offset);
            const singleQuotes = (lineUpTo.match(/(?<!\\)'/g) || []).length;
            const doubleQuotes = (lineUpTo.match(/(?<!\\)"/g) || []).length;
            const backticks = (lineUpTo.match(/(?<!\\)`/g) || []).length;
            if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0) return match;
            // Inside a comment — skip
            if (/\/\/[^\n]*$/.test(lineUpTo)) return match;
            // Already inside an existing parens guard like `(err && err.stack)` — skip
            const wider = str.slice(Math.max(0, offset - 60), offset);
            if (new RegExp(`\\b${ident}\\s*&&\\s*$`).test(wider)) return match;
            // Wrap in null-check
            edits.push(`${ident}.${prop} → (${ident} && ${ident}.${prop})`);
            return `(${ident} && ${ident}.${prop})`;
          });
        }
      }

      if (changed !== content && edits.length > 0) {
        try {
          fs.writeFileSync(abs + '.before-err-repair-' + Date.now(), content, 'utf-8');
          fs.writeFileSync(abs, changed, 'utf-8');
          const rel = path.relative(projectDir, abs).replace(/\\/g, '/');
          repaired.push({ file: rel, edits: edits.length, samples: edits.slice(0, 3) });
        } catch {}
      }
    }
  }
  return repaired;
}

export function _detectMissingDataFiles(projectDir) {
  const created = [];
  const exts = new Set(['.js', '.mjs', '.cjs', '.ts']);
  const skipDirs = new Set(['node_modules', '.git', '.nha-shims', 'dist', 'build', '.next', 'public']);
  // Match string literals that look like project-relative storage paths:
  //   "data/users.json", './db/posts.json', "uploads/", "logs/app.log"
  // Skip absolute paths, URLs, node_modules/, dotfiles.
  const re = /['"`](?:\.\/)?((?:data|db|storage|uploads|logs|tmp|cache|sessions)\/[A-Za-z0-9_\-./]+)['"`]/g;
  const stack = [projectDir];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (skipDirs.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) { stack.push(abs); continue; }
      if (!exts.has(path.extname(ent.name))) continue;
      let content;
      try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(content)) !== null) {
        const rel = m[1].replace(/\\/g, '/');
        if (seen.has(rel)) continue;
        seen.add(rel);
        const fullPath = path.join(projectDir, rel);
        try {
          ensureDir(path.dirname(fullPath));
          // Only create file if it looks like a file (has extension) and doesn't exist
          if (path.extname(rel) && !fs.existsSync(fullPath)) {
            const ext = path.extname(rel).toLowerCase();
            let stub = '';
            if (ext === '.json') stub = rel.includes('users') || rel.includes('posts') || rel.includes('items') || rel.includes('list') ? '[]' : '{}';
            else if (ext === '.txt' || ext === '.log') stub = '';
            else if (ext === '.sqlite' || ext === '.db') continue; // skip binary
            else stub = '';
            fs.writeFileSync(fullPath, stub, 'utf-8');
            created.push(rel);
          }
        } catch {}
      }
    }
  }
  return created;
}

// Names that imply specific functionality — sibling fill is forbidden because
// the file MUST have specific content, not a generic copy of style.css.
// LLM generation is preferred for these.
const _SEMANTIC_FILE_NAMES = new Set([
  'animations', 'animation', 'transitions', 'transition',
  'theme', 'themes', 'dark', 'light',
  'charts', 'chart', 'graphs', 'graph', 'plot',
  'auth', 'authentication', 'login', 'signup', 'register',
  'dashboard', 'admin', 'profile',
  'portfolio', 'gallery', 'projects',
  'reset', 'normalize', 'print',
  'mobile', 'responsive', 'desktop',
]);

function _hasSemanticName(filePath) {
  const base = path.basename(filePath).replace(/\.[^.]+$/, '').toLowerCase();
  return _SEMANTIC_FILE_NAMES.has(base);
}

/**
 * Score how similar two filenames are. Returns 0..1.
 * "main.css" vs "style.css" → some score based on prefix/suffix shared chars.
 */
function _fileSimilarity(a, b) {
  const aBase = a.replace(/\.[^.]+$/, '').toLowerCase();
  const bBase = b.replace(/\.[^.]+$/, '').toLowerCase();
  if (aBase === bBase) return 1;
  // Common CSS naming variants get a boost
  const cssAliases = ['main', 'style', 'styles', 'app', 'index', 'global'];
  const jsAliases = ['main', 'app', 'index', 'script', 'scripts', 'bundle'];
  const aliases = a.endsWith('.css') ? cssAliases : a.endsWith('.js') ? jsAliases : [];
  if (aliases.includes(aBase) && aliases.includes(bBase)) return 0.8;
  // Simple Levenshtein-ish: count common chars at start/end
  let prefix = 0;
  while (prefix < aBase.length && prefix < bBase.length && aBase[prefix] === bBase[prefix]) prefix++;
  let suffix = 0;
  while (suffix < aBase.length - prefix && suffix < bBase.length - prefix && aBase[aBase.length - 1 - suffix] === bBase[bBase.length - 1 - suffix]) suffix++;
  return (prefix + suffix) / Math.max(aBase.length, bBase.length);
}

/**
 * Find a sibling file with real content that could fill in for a missing asset.
 * E.g. missing `public/css/main.css` but `public/css/style.css` exists with
 * 8459 bytes — that's almost certainly what the LLM meant.
 */
function _findSiblingFile(projectDir, missingRel, exclude) {
  // Refuse sibling fill for semantic file names — they need real content
  // matching the name's intent, not a copy of style.css.
  if (_hasSemanticName(missingRel)) return null;
  const missingAbs = path.join(projectDir, missingRel);
  const dir = path.dirname(missingAbs);
  const ext = path.extname(missingRel).toLowerCase();
  if (!fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const excludeSet = exclude instanceof Set ? exclude : new Set();
  const candidates = [];
  for (const name of entries) {
    if (path.extname(name).toLowerCase() !== ext) continue;
    if (name === path.basename(missingRel)) continue;
    const abs = path.join(dir, name);
    // Skip files we just filled in this session (avoid filling A from B
    // when B was itself just filled from C — produces semantic duplicates)
    const relFromProject = path.relative(projectDir, abs).replace(/\\/g, '/');
    if (excludeSet.has(relFromProject)) continue;
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile() || stat.size < 200) continue;
    // Skip nha-generated placeholders (small + commented)
    try {
      const head = fs.readFileSync(abs, 'utf-8').slice(0, 200);
      if (/nha-webcraft:.*auto-created placeholder/i.test(head)) continue;
      // Skip files with semantic names — they have specific purpose
      if (_hasSemanticName(name)) continue;
    } catch { continue; }
    const sim = _fileSimilarity(path.basename(missingRel), name);
    candidates.push({ name, abs, size: stat.size, similarity: sim });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.similarity * b.size) - (a.similarity * a.size));
  return candidates[0];
}

/**
 * Build a focused LLM prompt to generate a single missing file. Includes the
 * HTML that references it (for context) and other files in the project as
 * style reference. Returns the prompt strings; caller invokes callLLM.
 */
function _buildCompletionPrompt(projectDir, missingRel, referencedFrom) {
  const ext = path.extname(missingRel).toLowerCase();
  const kind = ext === '.css' ? 'CSS stylesheet' : ext === '.js' ? 'JavaScript file' : 'asset file';
  let htmlSnippet = '';
  try {
    if (referencedFrom) {
      const html = fs.readFileSync(path.join(projectDir, referencedFrom), 'utf-8');
      htmlSnippet = html.slice(0, 4000);
    }
  } catch {}
  // Find sibling files of same kind for style reference
  const siblings = [];
  try {
    const dir = path.dirname(path.join(projectDir, missingRel));
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir).slice(0, 5)) {
        if (path.extname(name).toLowerCase() !== ext) continue;
        const abs = path.join(dir, name);
        try {
          const content = fs.readFileSync(abs, 'utf-8');
          if (/nha-webcraft:.*placeholder/i.test(content.slice(0, 200))) continue;
          siblings.push({ name, preview: content.slice(0, 1500) });
        } catch {}
      }
    }
  } catch {}
  const siblingCtx = siblings.length
    ? '\n\nOther ' + kind + ' files in the project (for style/convention reference):\n' +
      siblings.map(s => '### ' + s.name + '\n' + s.preview).join('\n\n')
    : '';
  const sys = 'You are an expert frontend developer. Generate the complete contents of a single file. Output ONLY the file content — no markdown fences, no explanations, no preamble. The output will be written directly to disk.';
  const user = 'Generate the full contents of `' + missingRel + '` for a web project.\n\n' +
    (htmlSnippet ? 'The file is referenced by `' + referencedFrom + '`:\n```\n' + htmlSnippet + '\n```' : '') +
    siblingCtx +
    '\n\nProduce production-quality ' + kind + ' that is coherent with the rest of the project.';
  return { sys, user };
}

/**
 * Complete missing assets in a project: first try sibling fill (deterministic),
 * then fall back to LLM generation. Returns a report of what was filled and how.
 */
export async function _completeMissingAssets(projectName, config, emit) {
  const dir = ProjectStore.dir(projectName);
  if (!fs.existsSync(dir)) throw new Error('project not found');
  const report = { siblingFills: [], llmFills: [], stillMissing: [], stubFallbacks: [] };

  // Discover every HTML asset reference and whether the target exists
  const htmlFiles = [];
  const stack = [dir];
  const skipDirs = new Set(['node_modules', '.git', '.nha-shims', 'dist', 'build', '.next']);
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (skipDirs.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) { stack.push(abs); continue; }
      const ext = path.extname(ent.name).toLowerCase();
      if (ext === '.html' || ext === '.htm') htmlFiles.push(abs);
    }
  }

  const missingByPath = new Map();
  for (const htmlAbs of htmlFiles) {
    let html;
    try { html = fs.readFileSync(htmlAbs, 'utf-8'); } catch { continue; }
    const htmlRel = path.relative(dir, htmlAbs).replace(/\\/g, '/');
    const refs = _extractHtmlAssetRefs(html);
    for (const ref of refs) {
      const target = _normalizeAssetPath(ref.href, htmlRel);
      if (!target) continue;
      const targetAbs = path.join(dir, target);
      // Treat existing-but-placeholder as missing
      let isPlaceholder = false;
      if (fs.existsSync(targetAbs)) {
        try {
          const head = fs.readFileSync(targetAbs, 'utf-8').slice(0, 200);
          isPlaceholder = /nha-webcraft:.*placeholder/i.test(head);
        } catch {}
        if (!isPlaceholder) continue;
      }
      if (!missingByPath.has(target)) {
        missingByPath.set(target, { kind: ref.kind, referencedFrom: htmlRel, isPlaceholder });
      }
    }
  }

  if (missingByPath.size === 0) {
    return report;
  }

  if (emit) emit({ type: 'status', msg: 'Completing ' + missingByPath.size + ' missing/placeholder asset' + (missingByPath.size === 1 ? '' : 's') + '...' });

  // Phase 1: HTML reference rewrite (NO file duplication).
  // When `main.css` is referenced but missing AND `style.css` exists in the
  // same dir with real content, the correct fix is NOT to copy style.css
  // into main.css (creates a duplicate with mismatched semantic name) but
  // to REWRITE the HTML <link href="main.css"> → <link href="style.css">.
  // This preserves the LLM's actual file structure.
  report.htmlRewrites = report.htmlRewrites || [];
  const referencedFromMap = new Map();  // htmlPath → list of {oldHref, newHref}
  const stillMissing = [];
  for (const [target, info] of missingByPath) {
    const sibling = _findSiblingFile(dir, target, new Set());
    if (sibling) {
      // Don't copy. Rewrite the HTML reference to point to the real file.
      const newRef = path.posix.relative(
        path.dirname(info.referencedFrom),
        path.relative(dir, sibling.abs).replace(/\\/g, '/')
      ) || path.basename(sibling.name);
      const htmlRewrite = { from: info.referencedFrom, oldHref: target, newHref: newRef, sibling: sibling.name };
      if (!referencedFromMap.has(info.referencedFrom)) referencedFromMap.set(info.referencedFrom, []);
      referencedFromMap.get(info.referencedFrom).push(htmlRewrite);
      report.htmlRewrites.push(htmlRewrite);
      if (emit) emit({ type: 'status', msg: `HTML rewrite: ${info.referencedFrom} → ${target} now points to ${sibling.name} (${sibling.size} bytes, real content)` });
      continue;
    }
    stillMissing.push({ target, ...info });
  }

  // Apply HTML rewrites (one pass per file)
  for (const [htmlRel, rewrites] of referencedFromMap) {
    try {
      const htmlAbs = path.join(dir, htmlRel);
      let html = fs.readFileSync(htmlAbs, 'utf-8');
      for (const r of rewrites) {
        // Rewrite both `href="X"` and `src="X"` for the old asset path.
        // Handle both relative ('css/main.css') and absolute ('/css/main.css').
        const oldBase = path.basename(r.oldHref);
        const re = new RegExp(`(href|src)=(["'])([^"']*${oldBase.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')})\\2`, 'g');
        html = html.replace(re, (_m, attr, q) => `${attr}=${q}${r.newHref}${q}`);
      }
      fs.writeFileSync(htmlAbs, html, 'utf-8');
    } catch (e) {
      if (emit) emit({ type: 'warn', msg: `Failed to rewrite ${htmlRel}: ${e.message}` });
    }
  }

  // Phase 2: LLM completion for remaining (one call per file, max 8 files)
  const maxLLM = 8;
  for (const m of stillMissing.slice(0, maxLLM)) {
    try {
      const { sys, user } = _buildCompletionPrompt(dir, m.target, m.referencedFrom);
      if (emit) emit({ type: 'status', msg: 'LLM-completing: ' + m.target + ' (referenced by ' + m.referencedFrom + ')' });
      let body = '';
      await callLLMStream(config, sys, user, (chunk) => { body += chunk; }, { max_tokens: 4096 });
      // Strip markdown fences if LLM leaked them
      body = body.replace(/^```[a-zA-Z]*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
      // Reject LLM error responses leaked as content
      if (_looksLikeLLMError(body) || body.length < 50) {
        report.stillMissing.push(m.target);
        // Fallback to stub placeholder
        const targetAbs = path.join(dir, m.target);
        ensureDir(path.dirname(targetAbs));
        fs.writeFileSync(targetAbs, _placeholderContent(m.kind, m.target), 'utf-8');
        report.stubFallbacks.push(m.target);
        continue;
      }
      const targetAbs = path.join(dir, m.target);
      ensureDir(path.dirname(targetAbs));
      fs.writeFileSync(targetAbs, body, 'utf-8');
      report.llmFills.push({ target: m.target, length: body.length });
    } catch (e) {
      report.stillMissing.push(m.target);
      if (emit) emit({ type: 'warn', msg: 'LLM completion failed for ' + m.target + ': ' + (e.message || e).slice(0, 100) });
    }
  }

  // Phase 3: anything beyond the LLM cap → stub
  for (const m of stillMissing.slice(maxLLM)) {
    try {
      const targetAbs = path.join(dir, m.target);
      ensureDir(path.dirname(targetAbs));
      fs.writeFileSync(targetAbs, _placeholderContent(m.kind, m.target), 'utf-8');
      report.stubFallbacks.push(m.target);
    } catch {}
  }

  return report;
}

/**
 * Analyze CSS coverage for an HTML project. Returns the percentage of HTML
 * classes/ids that have at least one matching CSS rule.
 *
 * Returns {
 *   coverage: 0..1,
 *   htmlSelectors: ['.cta', '.hero', '#main', ...],  // all unique selectors in HTML
 *   cssSelectors: Set of selectors that have CSS rules
 *   missing: ['.testimonial', '.pricing-card', ...]  // HTML selectors with no CSS
 *   tagCount: number of HTML elements found
 *   cssRuleCount: number of rules in all CSS files
 *   imgCount: number of <img> tags
 *   hasImgRule: boolean — does any CSS rule target `img` with max-width?
 * }
 */
export function _analyzeCssCoverage(projectDir) {
  const result = {
    coverage: 1,
    htmlSelectors: [],
    cssSelectors: new Set(),
    missing: [],
    tagCount: 0,
    cssRuleCount: 0,
    imgCount: 0,
    hasImgRule: false,
    cssFiles: [],
    htmlFiles: [],
  };

  // Gather all HTML and CSS files
  const stack = [projectDir];
  const skipDirs = new Set(['node_modules', '.git', '.nha-shims', 'dist', 'build', '.next']);
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (skipDirs.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) { stack.push(abs); continue; }
      const ext = path.extname(ent.name).toLowerCase();
      if (ext === '.html' || ext === '.htm') result.htmlFiles.push(abs);
      else if (ext === '.css') result.cssFiles.push(abs);
    }
  }

  if (result.htmlFiles.length === 0) return result;

  // Extract HTML classes/ids
  const htmlSelectorSet = new Set();
  for (const htmlAbs of result.htmlFiles) {
    let html;
    try { html = fs.readFileSync(htmlAbs, 'utf-8'); } catch { continue; }
    // Count tags
    const tagMatches = html.match(/<[a-zA-Z][a-zA-Z0-9-]*/g) || [];
    result.tagCount += tagMatches.length;
    // Count img tags specifically
    result.imgCount += (html.match(/<img\b/gi) || []).length;
    // Extract classes
    const classRe = /\bclass\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = classRe.exec(html)) !== null) {
      for (const cls of m[1].split(/\s+/)) {
        if (cls.trim()) htmlSelectorSet.add('.' + cls.trim());
      }
    }
    // Extract IDs
    const idRe = /\bid\s*=\s*["']([^"']+)["']/g;
    while ((m = idRe.exec(html)) !== null) {
      if (m[1].trim()) htmlSelectorSet.add('#' + m[1].trim());
    }
  }
  result.htmlSelectors = [...htmlSelectorSet];

  if (result.htmlSelectors.length === 0) {
    result.coverage = 1;
    return result;
  }

  // Extract CSS selectors (simple: split on { and look at preceding token)
  for (const cssAbs of result.cssFiles) {
    let css;
    try { css = fs.readFileSync(cssAbs, 'utf-8'); } catch { continue; }
    // Strip comments
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // Find rule blocks: anything before { ... }
    const ruleRe = /([^{}]+)\{[^{}]*\}/g;
    let m;
    while ((m = ruleRe.exec(css)) !== null) {
      result.cssRuleCount++;
      const selectorList = m[1].trim();
      if (selectorList.startsWith('@')) continue; // @media, @keyframes etc.
      // Split combined selectors (.a, .b, .c) and extract bare class/id tokens
      for (const sel of selectorList.split(',')) {
        const trimmed = sel.trim();
        // Find all .classname and #id tokens in this selector
        const classM = trimmed.match(/\.[\w-]+/g) || [];
        const idM = trimmed.match(/#[\w-]+/g) || [];
        for (const t of [...classM, ...idM]) result.cssSelectors.add(t);
        // Track if any rule targets `img`
        if (/(^|[\s,>+~])img(\s*[.{#:]|\s*$)/.test(trimmed)) {
          if (css.slice(m.index, m.index + m[0].length).match(/max-width|object-fit/)) {
            result.hasImgRule = true;
          }
        }
      }
    }
  }

  // Compute coverage
  for (const sel of result.htmlSelectors) {
    if (!result.cssSelectors.has(sel)) result.missing.push(sel);
  }
  result.coverage = (result.htmlSelectors.length - result.missing.length) / result.htmlSelectors.length;

  return result;
}

/**
 * Auto-extend CSS by calling LLM when coverage is below threshold or layout
 * is clearly broken (e.g. <img> tags with no max-width rule). No user prompt;
 * triggers automatically in pre-flight.
 */
export async function _autoExtendStylesIfNeeded(projectName, config, emit, opts) {
  opts = opts || {};
  const minCoverage = opts.minCoverage ?? 0.6;
  const dir = ProjectStore.dir(projectName);
  if (!fs.existsSync(dir)) return { extended: false, reason: 'project not found' };

  const analysis = _analyzeCssCoverage(dir);
  if (analysis.htmlSelectors.length === 0) return { extended: false, reason: 'no HTML selectors' };

  const needsExtend =
    analysis.coverage < minCoverage ||
    (analysis.imgCount >= 2 && !analysis.hasImgRule) ||
    (analysis.tagCount > 50 && analysis.cssRuleCount < 20);

  if (!needsExtend) {
    return {
      extended: false,
      reason: 'coverage acceptable',
      coverage: analysis.coverage,
      missing: analysis.missing.length,
    };
  }

  // Find the primary CSS file to extend (largest non-placeholder)
  const cssCandidates = [];
  for (const cssAbs of analysis.cssFiles) {
    try {
      const content = fs.readFileSync(cssAbs, 'utf-8');
      if (/nha-webcraft:.*placeholder/i.test(content.slice(0, 200))) continue;
      cssCandidates.push({ abs: cssAbs, size: content.length, content });
    } catch {}
  }
  cssCandidates.sort((a, b) => b.size - a.size);
  if (cssCandidates.length === 0) return { extended: false, reason: 'no real CSS files to extend' };

  const target = cssCandidates[0];
  const targetRel = path.relative(dir, target.abs).replace(/\\/g, '/');

  // Build prompt with HTML samples + current CSS + missing selectors
  let htmlSample = '';
  for (const htmlAbs of analysis.htmlFiles.slice(0, 3)) {
    try {
      const c = fs.readFileSync(htmlAbs, 'utf-8');
      htmlSample += `### ${path.relative(dir, htmlAbs)}\n${c.slice(0, 3500)}\n\n`;
    } catch {}
  }

  // APPEND mode (16.0.57): output ONLY the new rules — server appends to
  // existing file. Prevents monotonic regression (LLM truncating + losing
  // existing rules) and dramatically reduces output token cost.
  const sys = `You are an expert frontend designer. Generate ONLY new CSS rules to ADD to an existing stylesheet.

CRITICAL RULES:
- Output ONLY the new CSS rules — do NOT repeat any existing rules.
- Do NOT output markdown fences, explanations, or comments about what you're doing.
- The output will be APPENDED to an existing CSS file. Do not include @import, @charset, or any preamble.
- Generate at least one rule for EVERY listed missing selector.

DESIGN REQUIREMENTS:
- WCAG AA contrast: text-on-bg ratio >= 4.5:1. NO washed-out pastels for text.
- Vibrant accent colors (HSL S >= 60%, L 35-65%).
- Match the existing CSS's design language (look at the colors/spacing in the existing rules).
- Include responsive breakpoints (768px, 480px) where layout matters.
- Hover/focus/transition states for interactive elements.`;
  // Pick a sample of missing selectors that fits in token budget. We cap at
  // 200 to keep one pass reasonable; remaining are picked up by next pass.
  const passSelectors = analysis.missing.slice(0, 200);
  const user =
    `Existing CSS file: \`${targetRel}\` (${target.size} bytes, ${analysis.cssRuleCount} rules).\n\n` +
    `Sample of existing rules (for design-language reference — DO NOT repeat in output):\n\`\`\`css\n${target.content.slice(0, 3000)}\n\`\`\`\n\n` +
    `HTML context (snippet, for layout reference):\n${htmlSample.slice(0, 2500)}\n\n` +
    `Generate NEW CSS rules that cover these ${passSelectors.length} currently-uncovered selectors (out of ${analysis.missing.length} total):\n${passSelectors.join(', ')}\n\n` +
    `Output ONLY the new rules. Required additions if not already in existing CSS:\n` +
    `- img { max-width: 100%; height: auto; object-fit: cover; display: block; }\n` +
    `- footer { padding: 32px 16px; background: ...; color: ...; } (or similar — with visible contrast)\n` +
    `- Responsive @media queries at 768px and 480px for grid/flex sections.\n` +
    `Begin your output directly with the first CSS rule. No preamble.`;

  const provider = config?.llm?.provider || 'unknown';
  const model = config?.llm?.model || config?.llm?.[provider]?.model || 'default';
  if (emit) emit({ type: 'status', msg: `CSS coverage ${(analysis.coverage * 100).toFixed(0)}% (${analysis.missing.length} selectors missing). Auto-extending ${targetRel} via ${provider}:${model} (timeout 60s)...` });

  // Smart timeout: timeout ONLY if no bytes received for N seconds (provider
  // stuck/dead), NOT if total elapsed exceeds N (the LLM might be legitimately
  // streaming a large CSS file at 250 b/s for 90+ seconds). Absolute hard cap
  // at 300s to prevent runaway.
  let body = '';
  let lastChunkAt = Date.now();
  const startedAt = Date.now();
  const noProgressTimeoutMs = 30_000;  // no bytes for 30s → timeout
  const absoluteTimeoutMs = 300_000;   // 5min absolute cap
  let earlyWarningEmitted = false;
  let timedOut = false;
  let aborted = false;
  const abortController = new AbortController();

  // Track byte velocity for an informative heartbeat: show b/s instead of
  // misleading "0s since last chunk" (which is almost always 0 when streaming).
  let prevBytes = 0;
  let prevHeartbeatAt = startedAt;
  const heartbeatInterval = setInterval(() => {
    if (!emit) return;
    const now = Date.now();
    const elapsed = ((now - startedAt) / 1000).toFixed(0);
    const bytesPerSec = Math.round((body.length - prevBytes) / Math.max(1, (now - prevHeartbeatAt) / 1000));
    prevBytes = body.length;
    prevHeartbeatAt = now;
    emit({ type: 'status', msg: `LLM extend: ${elapsed}s elapsed, ${body.length} bytes received (${bytesPerSec} b/s)` });
    if (!earlyWarningEmitted && body.length === 0 && now - startedAt > 15_000) {
      earlyWarningEmitted = true;
      emit({ type: 'warn', msg: `Provider ${provider} hasn't sent any data in 15s. If this is Liara, the free tier may be under load — try switching to Anthropic/OpenAI in Settings.` });
    }
    // No-progress timeout: only if STUCK (zero chunks for 30s)
    if (now - lastChunkAt > noProgressTimeoutMs && body.length > 0) {
      timedOut = true;
      aborted = true;
      abortController.abort();
    }
    // Absolute timeout
    if (now - startedAt > absoluteTimeoutMs) {
      timedOut = true;
      aborted = true;
      abortController.abort();
    }
  }, 5_000);

  try {
    await callLLMStream(config, sys, user, (chunk) => {
      if (aborted) return;
      body += chunk;
      lastChunkAt = Date.now();
    }, { max_tokens: 4096, signal: abortController.signal });
  } catch (e) {
    clearInterval(heartbeatInterval);
    const errMsg = timedOut
      ? `no chunks received for ${(noProgressTimeoutMs / 1000)}s — provider ${provider} appears stuck (received ${body.length} bytes before stalling)`
      : (e.message || String(e)).slice(0, 200);
    if (emit) {
      emit({ type: 'warn', msg: `CSS extend failed: ${errMsg}` });
      if (timedOut && body.length > 0) {
        emit({ type: 'warn', msg: `Got ${body.length} bytes of partial CSS but provider stalled. Keeping current file unchanged. Try again or switch provider.` });
      }
    }
    return { extended: false, reason: 'llm_failed', error: errMsg, partialBytes: body.length };
  }
  clearInterval(heartbeatInterval);

  // Strip markdown fences from the appended rules (LLM sometimes adds them)
  body = body.replace(/^```[a-zA-Z]*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  if (_looksLikeLLMError(body) || body.length < 200) {
    if (emit) emit({ type: 'warn', msg: `CSS extend produced suspicious output (${body.length} bytes of new rules) — keeping original.` });
    return { extended: false, reason: 'output_too_short_or_error' };
  }

  // APPEND mode (16.0.57): keep ALL existing rules intact, add new ones at end.
  // Prevents monotonic regression where pass N replaces pass N-1's work with
  // a smaller file. Combined content = original + delimiter comment + new rules.
  const combined = target.content
    + '\n\n/* === nha-webcraft: auto-extended rules (' + new Date().toISOString() + ') === */\n'
    + body
    + '\n';

  try {
    fs.writeFileSync(target.abs + '.before-extend-' + Date.now(), target.content, 'utf-8');
    fs.writeFileSync(target.abs, combined, 'utf-8');
  } catch (e) {
    return { extended: false, reason: 'write_failed', error: e.message };
  }

  // Re-analyze to confirm improvement. APPEND mode guarantees coverage
  // monotonically increases (or stays equal), never decreases.
  const after = _analyzeCssCoverage(dir);
  if (after.missing.length >= analysis.missing.length) {
    // No progress despite append — LLM produced rules that don't match selectors.
    // Roll back so the file doesn't bloat with useless rules.
    try { fs.writeFileSync(target.abs, target.content, 'utf-8'); } catch {}
    if (emit) emit({ type: 'warn', msg: `CSS extend rolled back: ${body.length} bytes of new rules added but no selectors covered (model output didn't match needed selectors).` });
    return { extended: false, reason: 'no_coverage_gain', missingBefore: analysis.missing.length, missingAfter: after.missing.length };
  }

  if (emit) emit({ type: 'status', msg: `CSS extended: ${targetRel} ${target.size} → ${combined.length} bytes (appended ${body.length} bytes). Coverage ${(analysis.coverage * 100).toFixed(0)}% → ${(after.coverage * 100).toFixed(0)}%, ${analysis.missing.length} → ${after.missing.length} selectors missing.` });

  return {
    extended: true,
    file: targetRel,
    sizeBefore: target.size,
    sizeAfter: combined.length,
    appendedBytes: body.length,
    coverageBefore: analysis.coverage,
    coverageAfter: after.coverage,
    missingBefore: analysis.missing.length,
    missingAfter: after.missing.length,
  };
}

export function autoRepairProject(projectName) {
  const dir = ProjectStore.dir(projectName);
  if (!fs.existsSync(dir)) throw new Error('project not found');

  const repairs = [];
  const filesRepaired = new Set();
  const filesCreated = [];

  // Phase 0: create missing data files referenced by code (data/X.json, etc)
  const dataCreated = _detectMissingDataFiles(dir);
  for (const f of dataCreated) {
    filesCreated.push(f);
    repairs.push({ file: f, kind: 'missing-data-file', source: 'code-reference' });
  }

  // Phase 0.5: null-check unsafe err.X access in route handlers
  const errFixed = _repairUnsafeErrAccess(dir);
  for (const r of errFixed) {
    filesRepaired.add(r.file);
    repairs.push({ file: r.file, kind: 'unsafe-err-access', edits: r.edits });
  }

  // Walk every HTML file in the project
  const stack = [dir];
  const skipDirs = new Set(['node_modules', '.git', '.nha-shims', 'dist', 'build', '.next']);
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (skipDirs.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) { stack.push(abs); continue; }
      const ext = path.extname(ent.name).toLowerCase();
      if (ext !== '.html' && ext !== '.htm') continue;

      const rel = path.relative(dir, abs).replace(/\\/g, '/');
      let html;
      try { html = fs.readFileSync(abs, 'utf-8'); } catch { continue; }

      // Phase A: balance tags
      const { fixed, edits } = _balanceHtmlTags(html);
      if (fixed !== html && edits.length > 0) {
        fs.writeFileSync(abs, fixed, 'utf-8');
        filesRepaired.add(rel);
        repairs.push({ file: rel, kind: 'html-balance', edits });
      }

      // Phase B: create missing referenced assets
      const refs = _extractHtmlAssetRefs(fixed);
      for (const ref of refs) {
        const target = _normalizeAssetPath(ref.href, rel);
        if (!target) continue;
        const targetAbs = path.join(dir, target);
        if (fs.existsSync(targetAbs)) continue;
        // Don't create node_modules / external dirs
        if (target.startsWith('node_modules/') || target.includes('..')) continue;
        try {
          ensureDir(path.dirname(targetAbs));
          fs.writeFileSync(targetAbs, _placeholderContent(ref.kind, ref.href), 'utf-8');
          filesCreated.push(target);
          repairs.push({ file: target, kind: 'missing-asset', source: rel, ref: ref.href });
        } catch {}
      }
    }
  }

  return {
    ok: true,
    filesRepaired: [...filesRepaired],
    filesCreated,
    repairs,
    summary: `${filesRepaired.size} HTML balanced, ${filesCreated.length} placeholder files created`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

// Map native tool names → internal NHA "op" codes. Both directions: the LLM
// might emit either based on which provider's docs it was trained on.
const _TOOL_NAME_TO_OP = new Map([
  ['read_file', 'read'], ['read', 'read'],
  ['edit_file', 'edit'], ['edit', 'edit'],
  ['create_file', 'write'], ['write', 'write'], ['write_file', 'write'],
  ['delete_file', 'delete'], ['delete', 'delete'],
  ['list_files', 'list'], ['list', 'list'],
  ['search_files', 'search'], ['search', 'search'],
  ['run_command', 'run'], ['run', 'run'], ['shell', 'run'],
  ['check_syntax', 'check'], ['check', 'check'],
  ['restart_sandbox', 'sandbox'], ['sandbox', 'sandbox'],
]);

// Map common param-name variants used across LLM providers.
const _PARAM_ALIASES = {
  path: ['path', 'file_path', 'filepath', 'filename', 'file'],
  old: ['old', 'old_text', 'old_string', 'oldText'],
  new: ['new', 'new_text', 'new_string', 'newText', 'replacement'],
  content: ['content', 'text', 'body', 'file_content'],
  query: ['query', 'pattern', 'search', 'q'],
  glob: ['glob', 'pattern', 'file_pattern'],
  cmd: ['cmd', 'command', 'shell_command'],
};

function _pickParam(obj, kind) {
  for (const alt of _PARAM_ALIASES[kind] || [kind]) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, alt) && obj[alt] !== undefined) {
      return obj[alt];
    }
  }
  return undefined;
}

/**
 * Extract every tool-call-like JSON blob from an LLM response. Handles:
 *   - <tool>{...}</tool>                — NHA native wrapper
 *   - {"tool": "...", "args": {...}}    — OpenAI-style nude JSON
 *   - {"name": "...", "input": {...}}   — Anthropic-style nude JSON
 *   - ```json\n{...}\n```               — markdown-fenced JSON blocks
 *
 * Returns { calls: [raw objects], matchedRanges: [[start,end], ...] } so the
 * caller can blank out the consumed regions from the visible text stream.
 */
export function _extractAllToolCalls(text) {
  const calls = [];
  const matchedRanges = [];

  // Pass 1: <tool>...</tool> wrappers
  const wrapRe = /<tool>([\s\S]*?)<\/tool>/g;
  let m;
  while ((m = wrapRe.exec(text)) !== null) {
    matchedRanges.push([m.index, m.index + m[0].length]);
    try {
      let raw = m[1].trim().replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      calls.push(JSON.parse(raw));
    } catch {
      try { calls.push(_parseToolCallRobust(m[1].trim())); } catch {}
    }
  }

  // Pass 2: markdown-fenced JSON blocks ```json {...} ```
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  while ((m = fenceRe.exec(text)) !== null) {
    // Skip if already inside a <tool> match
    if (matchedRanges.some(([s, e]) => m.index >= s && m.index < e)) continue;
    const body = m[1].trim();
    if (!/^\s*\{/.test(body)) continue;
    try {
      const parsed = JSON.parse(body.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
      if (_looksLikeToolCall(parsed)) {
        calls.push(parsed);
        matchedRanges.push([m.index, m.index + m[0].length]);
      }
    } catch {}
  }

  // Pass 3: bare JSON objects with balanced braces — scan top-level.
  // Find every '{' candidate not already consumed, then walk forward to find
  // the matching '}' while respecting nested braces AND string literals.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    if (matchedRanges.some(([s, e]) => i >= s && i < e)) continue;
    // Must be at line start or after whitespace (avoid inline {expr}/object literals in code)
    let prev = i - 1;
    while (prev >= 0 && (text[prev] === ' ' || text[prev] === '\t')) prev--;
    if (prev >= 0 && text[prev] !== '\n') continue;

    const end = _findMatchingBrace(text, i);
    if (end < 0) continue;
    const candidate = text.slice(i, end + 1);
    try {
      const parsed = JSON.parse(candidate.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
      if (_looksLikeToolCall(parsed)) {
        calls.push(parsed);
        matchedRanges.push([i, end + 1]);
        i = end;
      }
    } catch {}
  }

  return { calls, matchedRanges };
}

// Walk forward from openIdx (which must be '{') to find the matching '}'.
// Respects nested braces, string literals (single & double quote), and escapes.
// Returns -1 if no match found (unclosed).
function _findMatchingBrace(text, openIdx) {
  let depth = 0;
  let inStr = false;
  let strCh = '';
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function _looksLikeToolCall(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (
    'op' in obj ||
    'tool' in obj ||
    'name' in obj && ('input' in obj || 'arguments' in obj || 'args' in obj) ||
    'function_call' in obj
  );
}

/**
 * Normalize a parsed tool-call object to NHA's internal shape:
 *   { op, path, old, new, content, newPath, query, glob, cmd }
 *
 * Accepts:
 *   - {op, path, ...}                             — already normalized
 *   - {tool, args: {file_path, old_text, ...}}    — OpenAI-style
 *   - {name, input: {...}} / {name, arguments}    — Anthropic-style
 */
export function _normalizeToolCall(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not an object');

  // Already in NHA native shape
  if ('op' in raw && typeof raw.op === 'string') {
    return raw;
  }

  // Extract tool name from various wire formats
  const toolName = raw.tool || raw.name || raw.function_call?.name;
  if (!toolName) throw new Error('no tool/op/name field');

  const op = _TOOL_NAME_TO_OP.get(toolName);
  if (!op) throw new Error(`unknown tool name: ${toolName}`);

  // Extract args payload (OpenAI uses "args", Anthropic uses "input" or "arguments")
  let args = raw.args || raw.input || raw.arguments || raw.parameters || {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }

  return {
    op,
    path: _pickParam(args, 'path'),
    old: _pickParam(args, 'old'),
    new: _pickParam(args, 'new'),
    content: _pickParam(args, 'content'),
    query: _pickParam(args, 'query'),
    glob: _pickParam(args, 'glob'),
    cmd: _pickParam(args, 'cmd'),
    newPath: args.newPath || args.new_path,
  };
}

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
    `// Force-bind to NHA's assigned port even when the app hardcodes a port`,
    `// like 3000/5000/8080. Monkey-patch http.Server.prototype.listen so the`,
    `// FIRST positional numeric arg is replaced with our port. This prevents`,
    `// "Connessione negata" when the iframe targets ${port} but the app picked`,
    `// a different port internally.`,
    `(function(){`,
    `  const http = require('http');`,
    `  const NHA_PORT = ${port};`,
    `  const _origListen = http.Server.prototype.listen;`,
    `  let _bound = false;`,
    `  http.Server.prototype.listen = function(...args) {`,
    `    if (_bound) return _origListen.apply(this, args);`,
    `    if (typeof args[0] === 'object' && args[0] !== null && 'port' in args[0]) {`,
    `      const requested = args[0].port;`,
    `      if (requested !== NHA_PORT && requested !== 0) {`,
    `        console.log('[nha-launcher] app requested port ' + requested + ', forcing to NHA_PORT=' + NHA_PORT);`,
    `        args[0] = Object.assign({}, args[0], { port: NHA_PORT, host: '0.0.0.0' });`,
    `      }`,
    `    } else if (typeof args[0] === 'number' || typeof args[0] === 'string') {`,
    `      const requested = parseInt(args[0]);`,
    `      if (!isNaN(requested) && requested !== NHA_PORT && requested !== 0) {`,
    `        console.log('[nha-launcher] app requested port ' + requested + ', forcing to NHA_PORT=' + NHA_PORT);`,
    `        args[0] = NHA_PORT;`,
    `        // If second positional was host, replace with 0.0.0.0; otherwise insert`,
    `        if (typeof args[1] === 'string') args[1] = '0.0.0.0';`,
    `        else if (typeof args[1] === 'function') args.splice(1, 0, '0.0.0.0');`,
    `      }`,
    `    }`,
    `    _bound = true;`,
    `    return _origListen.apply(this, args);`,
    `  };`,
    `})();`,
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
    `// Monkey-patch Express to neutralize next(falsy) — common LLM bug where`,
    `// middleware calls next(err) with err === undefined for EVERY request,`,
    `// causing 500 on all routes including static files. Express treats any`,
    `// truthy first arg as an error; if it's falsy (null/undefined/0/''),`,
    `// it's semantically equivalent to next() per Express docs. We rewrite.`,
    `(function() {`,
    `  const Module = require('module');`,
    `  const _origLoad = Module._load;`,
    `  function wrapMiddleware(fn) {`,
    `    if (typeof fn !== 'function' || fn.length !== 3) return fn;`,
    `    const wrapped = function(req, res, next) {`,
    `      const safeNext = function(err) {`,
    `        if (err === undefined || err === null || err === false || err === 0) return next();`,
    `        return next(err);`,
    `      };`,
    `      try { return fn.call(this, req, res, safeNext); }`,
    `      catch (e) { return next(e); }`,
    `    };`,
    `    wrapped._nhaWrapped = true;`,
    `    return wrapped;`,
    `  }`,
    `  function patchExpressApp(express) {`,
    `    if (!express || express._nhaPatched) return express;`,
    `    try {`,
    `      // express() returns an app; patch app.use to wrap middleware`,
    `      const _origExpress = express;`,
    `      const factory = function(...args) {`,
    `        const app = _origExpress.apply(this, args);`,
    `        if (app && typeof app.use === 'function' && !app._nhaUseWrapped) {`,
    `          const _origUse = app.use;`,
    `          app.use = function(...uArgs) {`,
    `            const mapped = uArgs.map(a => (typeof a === 'function' && a.length === 3 && !a._nhaWrapped) ? wrapMiddleware(a) : a);`,
    `            return _origUse.apply(this, mapped);`,
    `          };`,
    `          app._nhaUseWrapped = true;`,
    `        }`,
    `        return app;`,
    `      };`,
    `      // Preserve static props: Router, json(), urlencoded(), etc.`,
    `      Object.assign(factory, _origExpress);`,
    `      factory._nhaPatched = true;`,
    `      return factory;`,
    `    } catch { return express; }`,
    `  }`,
    `  Module._load = function(name, parent, isMain) {`,
    `    const result = _origLoad.call(this, name, parent, isMain);`,
    `    if (name === 'express') return patchExpressApp(result);`,
    `    return result;`,
    `  };`,
    `})();`,
    `// Strip headers that break sandbox iframe preview:`,
    `//  - X-Frame-Options: blocks iframe embedding entirely`,
    `//  - X-Content-Type-Options: nosniff: when LLM references /js/*.js files`,
    `//    that don't exist, Express serves 404 HTML — but nosniff blocks the`,
    `//    browser from executing them as scripts, leaving a blank page.`,
    `//  - CSP frame-ancestors: same blocking effect as X-Frame-Options`,
    `const _origSetHeader = require('http').ServerResponse.prototype.setHeader;`,
    `require('http').ServerResponse.prototype.setHeader = function(name, val) {`,
    `  const lower = name.toLowerCase();`,
    `  if (lower === 'x-frame-options') return this;`,
    `  if (lower === 'x-content-type-options') return this;`,
    `  if (lower === 'content-security-policy' && typeof val === 'string' && val.includes('frame-ancestors')) {`,
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

// Detect LLM API error responses that leaked into the file content. When the
// LLM endpoint returns 4xx/5xx with a plaintext body (Cloudflare block, rate
// limit, "Access temporarily denied"), the response often ends up saved as
// file content. Those strings are short, don't start with valid syntax for
// the file type, and contain specific marker phrases.
const _LLM_ERROR_MARKERS = [
  // "Access denied" / "Access temporarily denied"
  /^\s*Access (temporarily )?denied/i,
  // "Service Temporarily Unavailable", "Server Temporarily Unavailable",
  // "Temporarily Unavailable" — common nginx/cloudflare/CDN 503 responses
  /^\s*(Service |Server )?Temporarily Unavailable/i,
  /^\s*Service Unavailable/i,
  /^\s*Rate ?limit(ed)?/i,
  /^\s*Internal Server Error/i,
  /^\s*Too Many Requests/i,
  /^\s*Bad Gateway/i,
  /^\s*Gateway Timeout/i,
  /^\s*Request Timeout/i,
  /^\s*Not Found/i,
  /^\s*Forbidden\b/i,
  /^\s*Unauthorized\b/i,
  /^\s*<!DOCTYPE html.*Cloudflare/is,
  /^\s*<html.*<title>.*(Access|Forbidden|Error|Unavailable|Cloudflare)/is,
  /^\s*\{?\s*"error"\s*:\s*"(rate.?limit|quota|unauthorized|temporarily)"/i,
  /^\s*error code:\s*\d{3,4}/i,
  // Standalone HTTP status phrase at the start of a code file is suspicious
  /^\s*(HTTP\/[\d.]+\s+)?[45]\d{2}\s+/,
  // NHA/Liara backend retry-wrapper errors leaked as file content:
  //   "/* Retry: NHA Free 502: {"error":"Failed to reach Liara",...}"
  //   "Retry: NHA 503", "// NHA Free Error 429"
  /^\s*(?:\/\*\s*|\/\/\s*)?Retry:?\s*NHA(\s+Free)?(\s+\d{3})?/i,
  /^\s*(?:\/\*\s*|\/\/\s*)?Failed to reach (Liara|NHA|OpenAI|Anthropic|Gemini|provider)/i,
  /^\s*\{?\s*"error"\s*:\s*"Failed to reach/i,
  // Plain "fetch failed", "ECONNRESET" etc. as first line of a code file
  /^\s*(?:\/\*\s*|\/\/\s*)?(?:fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b/i,
];

function _looksLikeLLMError(content) {
  if (typeof content !== 'string') return false;
  const head = content.slice(0, 500);
  return _LLM_ERROR_MARKERS.some(re => re.test(head));
}

// Minimal package.json template — used when the LLM-generated one is corrupted.
function _fallbackPackageJson(projectName) {
  return JSON.stringify({
    name: String(projectName || 'nha-project').toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    version: '1.0.0',
    description: 'NHA-generated project (package.json auto-repaired)',
    main: 'index.js',
    type: 'commonjs',
    scripts: { start: 'node index.js' },
    dependencies: {},
  }, null, 2);
}

// Sanitize content before writing to disk. Rejects LLM error responses,
// repairs corrupt JSON manifests, validates JS/TS with acorn, and falls back
// to a safe placeholder when content is unsalvageable. This is the LAST line
// of defense between the LLM API and the user's filesystem.
function _sanitizeGeneratedFile(name, content, projectName) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const isJson = ext === 'json' || name.endsWith('package.json');
  const isPkg = name === 'package.json' || name.endsWith('/package.json');
  const isCode = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext);

  // Layer A: detect HTTP error responses leaked as file content
  if (_looksLikeLLMError(content)) {
    if (isPkg) return _fallbackPackageJson(projectName);
    if (isCode) {
      return `// nha-webcraft: this file's content from the LLM looked like an HTTP error response\n// (status leaked into stream — likely '${_extractLLMErrorHint(content)}').\n// File quarantined to keep the sandbox bootable. Re-generate from chat.\nmodule.exports = {};\n`;
    }
    return '<!-- nha-webcraft: LLM error response detected, content discarded. Re-generate from chat. -->';
  }

  // Layer B: validate JSON files
  if (isJson) {
    try { JSON.parse(content); }
    catch {
      if (isPkg) return _fallbackPackageJson(projectName);
      try {
        const repaired = content
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
        JSON.parse(repaired);
        return repaired;
      } catch {
        return '{}';
      }
    }
  }

  // Layer C: validate JS/JSX/TS files with acorn — catches partial streams
  // that ended mid-token, leftover HTML/error text mixed with code, etc.
  if (isCode && content && content.trim()) {
    try {
      const parser = ext === 'jsx' || ext === 'tsx' ? acorn.Parser.extend(acornJsx()) : acorn;
      parser.parse(content, {
        ecmaVersion: 'latest',
        sourceType: ['mjs'].includes(ext) ? 'module' : (/\bimport\s+|\bexport\s+/.test(content) ? 'module' : 'script'),
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowHashBang: true,
      });
    } catch (parseErr) {
      // Only quarantine if the error is at the VERY START of the file —
      // this signals "the whole file is junk" (HTTP error / partial stream)
      // rather than a normal bug at line 50 that user can fix.
      const lineMatch = parseErr.message.match(/\((\d+):(\d+)\)/);
      const startsAtTop = !lineMatch || parseInt(lineMatch[1]) <= 2;
      if (startsAtTop && content.length < 5000) {
        return `// nha-webcraft: this file failed to parse near the start (${parseErr.message}).\n// Likely a partial/corrupted stream from the LLM. Quarantined to keep sandbox bootable.\n// Re-generate from chat.\nmodule.exports = {};\n`;
      }
      // Otherwise let it through — it's a real code bug, the user will see it
    }
  }

  return content;
}

function _extractLLMErrorHint(content) {
  const head = content.slice(0, 200).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return head.slice(0, 80) + (head.length > 80 ? '...' : '');
}

// Authoritative list of modules covered by our offline-safe shims.
// Used by both the pre-scan (to skip them from npm install) and the Tier 1
// retry (to detect "missing module" stderr that's already covered by a shim).
export const _SHIMMED_MODULES = new Set([
  'pg', 'redis', 'ioredis', 'helmet', 'mongoose', 'sequelize',
  'dotenv', 'cors', 'morgan', 'body-parser', 'cookie-parser',
  'compression', 'express-rate-limit', 'jsonwebtoken', 'bcryptjs', 'bcrypt',
  'uuid', 'lodash', 'debug', 'chalk', 'multer', 'axios', 'express',
  'marked', 'markdown-it',
]);

/** Read declared dependencies from package.json (deps + devDeps + peer). */
function _declaredDeps(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]);
  } catch { return new Set(); }
}

/** List top-level node_modules entries already on disk. */
function _installedDeps(projectDir) {
  const nm = path.join(projectDir, 'node_modules');
  if (!fs.existsSync(nm)) return new Set();
  try {
    const out = new Set();
    for (const entry of fs.readdirSync(nm)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) {
        const scopedDir = path.join(nm, entry);
        try {
          for (const sub of fs.readdirSync(scopedDir)) out.add(`${entry}/${sub}`);
        } catch {}
      } else {
        out.add(entry);
      }
    }
    return out;
  } catch { return new Set(); }
}

// Node.js built-in modules — these are part of the runtime, not npm packages.
// `require('fs')` always works without installation. The pre-scan MUST exclude
// these or it tries to `npm install fs` which is meaningless (or worse, picks
// up a malicious typosquat). Authoritative list from Node 22 LTS docs.
export const _NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
  'inspector/promises', 'module', 'net', 'os', 'path', 'path/posix',
  'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'readline/promises', 'repl', 'stream', 'stream/consumers', 'stream/promises',
  'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls',
  'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

// Common LLM hallucinations → real package name. The LLM sometimes invents
// shorter aliases for popular packages. We map them transparently so the
// generated code "just works" without npm install of fake packages.
export const _PACKAGE_ALIASES = new Map([
  ['jwt', 'jsonwebtoken'],
  ['bcrypt', 'bcryptjs'],
  ['mongo', 'mongoose'],
  ['postgres', 'pg'],
  ['postgresql', 'pg'],
  ['mysql', 'mysql2'],
  ['env', 'dotenv'],
  ['util-lodash', 'lodash'],
  ['express-cors', 'cors'],
  ['express-helmet', 'helmet'],
  ['express-body-parser', 'body-parser'],
]);

/** Walk project files and extract all bare-import module names. */
export function _scanProjectImports(projectDir, maxFiles = 500, maxBytes = 200_000) {
  const found = new Set();
  const exts = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
  const skipDirs = new Set(['node_modules', '.git', '.nha-shims', 'dist', 'build', '.next', 'coverage']);
  const reRequire = /\brequire\s*\(\s*['"]([^'".][^'"]*)['"]\s*\)/g;
  const reImport = /\bimport\s+(?:[^'"]*\s+from\s+)?['"]([^'".][^'"]*)['"]/g;
  const reImportSide = /\bimport\s*\(\s*['"]([^'".][^'"]*)['"]\s*\)/g;
  const stack = [projectDir];
  let scanned = 0;

  while (stack.length && scanned < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!exts.has(path.extname(entry.name))) continue;
      let content;
      try {
        const stat = fs.statSync(full);
        if (stat.size > maxBytes) continue;
        content = fs.readFileSync(full, 'utf-8');
      } catch { continue; }
      scanned++;
      for (const re of [reRequire, reImport, reImportSide]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(content)) !== null) {
          const spec = m[1];
          // Filter 1: node:fs, node:path etc.
          if (spec.startsWith('node:')) continue;
          // Get the bare package name (handle @scope/name and subpaths)
          const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          if (!pkg) continue;
          // Filter 2: skip Node built-ins (fs, path, crypto, http, etc.)
          if (_NODE_BUILTINS.has(pkg)) continue;
          // Filter 3: resolve LLM-hallucinated aliases to real packages
          const real = _PACKAGE_ALIASES.get(pkg) || pkg;
          found.add(real);
        }
      }
    }
  }
  return found;
}

/** Classify npm install errors into actionable categories. */
export function _classifyInstallError(err) {
  const msg = String(err?.message || err?.stderr || err?.stdout || err || '').toLowerCase();
  if (/enotfound|etimedout|econnrefused|econnreset|network/.test(msg)) {
    return { reason: 'offline (npm registry unreachable)', offlineFallback: true,
      hint: 'Check VM network bridge/NAT, DNS, or corporate proxy (HTTP_PROXY/HTTPS_PROXY). Activating shim fallback.' };
  }
  // Distinguish "true E404" (package doesn't exist) from "offline cache miss"
  // (--prefer-offline can produce 404-looking errors when registry is unreachable).
  // True E404 also mentions "not in registry"; cache miss mentions "not in cache" or "ENETUNREACH".
  if (/not in.*(cache|local)|ENETUNREACH|prefer.?offline.*not.*found/i.test(msg)) {
    return { reason: 'offline cache miss (registry not reached, package not cached)', offlineFallback: true,
      hint: 'npm --prefer-offline could not find the package in local cache and registry is unreachable. Activating shim fallback.' };
  }
  if (/e404|"npm error code e404"|notarget|404 not found|not found in the npm registry|package.*does not exist/i.test(msg)) {
    return { reason: 'package does not exist on npm', offlineFallback: false,
      hint: 'The package name from the LLM-generated code is likely a hallucination, or you are offline. Tier 2 LLM-rewrite will rename it, or shim layer will take over if available.' };
  }
  if (/eacces|eperm|permission denied/.test(msg)) {
    return { reason: 'permissions denied', offlineFallback: false,
      hint: 'Run `sudo chown -R $USER ~/.nha` or move the project out of a root-owned directory.' };
  }
  if (/engine|unsupported.*node|requires node/.test(msg)) {
    return { reason: 'Node version mismatch', offlineFallback: false,
      hint: 'The package requires a different Node version. Check `node --version` and consider using nvm.' };
  }
  if (/eintegrity|sha-?(?:1|512) integrity|tarball/.test(msg)) {
    return { reason: 'package integrity failure', offlineFallback: false,
      hint: 'Try `rm -rf node_modules package-lock.json && npm install` to clear the cache.' };
  }
  return { reason: 'unknown', offlineFallback: false,
    hint: (err?.message || '').slice(0, 200) };
}

export function _writeShims(shimDir) {
  // ── Functional offline-safe shims for the 14 most common npm dependencies.
  // These are NOT no-ops: they implement enough of the real API to keep code
  // generated by the LLM running even when npm install is unavailable (VMs
  // without network, corporate proxies, CI cache misses, etc.).
  //
  // Categories:
  //   • Storage stubs:    pg, redis, ioredis, mongoose, sequelize
  //   • Security stubs:   helmet, jsonwebtoken, bcryptjs
  //   • Express middlew:  cors, morgan, body-parser, cookie-parser,
  //                       compression, express-rate-limit, multer
  //   • Utility stubs:    dotenv, uuid, lodash, debug, chalk, axios
  //
  // Every shim exports both CJS `module.exports` AND `.default` so it works
  // under both `require('x')` and `import x from 'x'` interop.

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

  // dotenv — actually parses .env files and sets process.env
  const dotenvShim = `
const fs = require('fs');
const path = require('path');
function parse(src) {
  const out = {};
  const s = src.toString();
  const re = /^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*?)\\s*$/;
  for (const raw of s.split(/\\r?\\n/)) {
    if (!raw || raw.trim().startsWith('#')) continue;
    const m = raw.match(re);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}
function config(opts) {
  opts = opts || {};
  try {
    const p = opts.path || path.join(process.cwd(), '.env');
    if (!fs.existsSync(p)) return { parsed: {} };
    const parsed = parse(fs.readFileSync(p, 'utf-8'));
    for (const k of Object.keys(parsed)) {
      if (opts.override || !(k in process.env)) process.env[k] = parsed[k];
    }
    return { parsed };
  } catch (e) { return { error: e }; }
}
module.exports = { config, parse };
module.exports.default = module.exports;
`;

  // cors — full Express middleware factory
  const corsShim = `
function cors(opts) {
  opts = opts || {};
  const origin = opts.origin === undefined ? '*' : opts.origin;
  const methods = opts.methods || 'GET,HEAD,PUT,PATCH,POST,DELETE';
  const credentials = opts.credentials === true;
  const allowedHeaders = opts.allowedHeaders || 'Content-Type,Authorization';
  return function (req, res, next) {
    const o = typeof origin === 'function' ? origin(req) : origin;
    res.setHeader('Access-Control-Allow-Origin', Array.isArray(o) ? o.join(',') : o);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
    if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    next();
  };
}
module.exports = cors;
module.exports.default = cors;
`;

  // morgan — minimal request logger
  const morganShim = `
function morgan(format) {
  return function (req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      console.log(\`[\${new Date().toISOString()}] \${req.method} \${req.url} \${res.statusCode} \${ms}ms\`);
    });
    next();
  };
}
morgan.token = () => morgan;
morgan.format = () => morgan;
module.exports = morgan;
module.exports.default = morgan;
`;

  // body-parser — JSON + urlencoded
  const bodyParserShim = `
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); return reject(new Error('Payload too large')); }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function jsonMw(opts) {
  const limit = (opts && opts.limit) ? 1024 * 1024 * 10 : 1024 * 1024;
  return async function (req, res, next) {
    if (!/json/i.test(req.headers['content-type'] || '')) return next();
    try { const raw = await readBody(req, limit); req.body = raw ? JSON.parse(raw) : {}; next(); }
    catch (e) { res.statusCode = 400; res.end('Invalid JSON'); }
  };
}
function urlencodedMw(opts) {
  return async function (req, res, next) {
    if (!/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) return next();
    try {
      const raw = await readBody(req, 1024 * 1024);
      const body = {};
      for (const pair of raw.split('&')) {
        const [k, v] = pair.split('=').map(decodeURIComponent);
        if (k) body[k] = v || '';
      }
      req.body = body;
      next();
    } catch (e) { res.statusCode = 400; res.end('Invalid form data'); }
  };
}
const bp = { json: jsonMw, urlencoded: urlencodedMw, raw: () => (req, res, next) => next(), text: () => (req, res, next) => next() };
module.exports = bp;
module.exports.default = bp;
`;

  // cookie-parser
  const cookieParserShim = `
function parse(str) {
  const out = {};
  if (!str) return out;
  for (const pair of str.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}
function cookieParser() {
  return function (req, res, next) { req.cookies = parse(req.headers.cookie || ''); next(); };
}
module.exports = cookieParser;
module.exports.default = cookieParser;
`;

  // compression — pass-through (no-op middleware, real compression needs zlib)
  const compressionShim = `
function compression() { return function (req, res, next) { next(); }; }
module.exports = compression;
module.exports.default = compression;
`;

  // express-rate-limit — in-memory bucket
  const rateLimitShim = `
function rateLimit(opts) {
  opts = opts || {};
  const max = opts.max || 100;
  const windowMs = opts.windowMs || 60_000;
  const store = new Map();
  return function (req, res, next) {
    const key = (req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anon') + ':' + (req.path || req.url || '/');
    const now = Date.now();
    const rec = store.get(key) || { count: 0, reset: now + windowMs };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
    rec.count++;
    store.set(key, rec);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - rec.count)));
    if (rec.count > max) { res.statusCode = 429; return res.end('Too many requests'); }
    next();
  };
}
module.exports = rateLimit;
module.exports.default = rateLimit;
`;

  // jsonwebtoken — HS256 sign/verify (sandbox-grade, NOT for production secrets)
  const jwtShim = `
const crypto = require('crypto');
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Buffer.from(s, 'base64'); }
function sign(payload, secret, opts) {
  opts = opts || {};
  const header = { alg: 'HS256', typ: 'JWT' };
  const p = Object.assign({}, payload);
  if (opts.expiresIn) {
    const sec = typeof opts.expiresIn === 'string' ? parseInt(opts.expiresIn) * (opts.expiresIn.endsWith('h') ? 3600 : opts.expiresIn.endsWith('d') ? 86400 : opts.expiresIn.endsWith('m') ? 60 : 1) : opts.expiresIn;
    p.exp = Math.floor(Date.now() / 1000) + sec;
  }
  const h = b64url(JSON.stringify(header));
  const b = b64url(JSON.stringify(p));
  const sig = b64url(crypto.createHmac('sha256', String(secret)).update(h + '.' + b).digest());
  return h + '.' + b + '.' + sig;
}
function verify(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('jwt malformed');
  const [h, b, s] = parts;
  const expected = b64url(crypto.createHmac('sha256', String(secret)).update(h + '.' + b).digest());
  if (expected !== s) throw new Error('invalid signature');
  const payload = JSON.parse(b64urlDecode(b).toString('utf-8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('jwt expired');
  return payload;
}
function decode(token) { try { return JSON.parse(b64urlDecode(String(token).split('.')[1]).toString('utf-8')); } catch { return null; } }
module.exports = { sign, verify, decode };
module.exports.default = module.exports;
`;

  // bcryptjs — pbkdf2-based, NOT real bcrypt (sandbox-grade)
  const bcryptShim = `
const crypto = require('crypto');
function hashSync(pwd, rounds) {
  const salt = crypto.randomBytes(16);
  const iter = Math.pow(2, Math.min(rounds || 10, 14));
  const hash = crypto.pbkdf2Sync(String(pwd), salt, iter, 32, 'sha256');
  return '$nha$' + iter + '$' + salt.toString('base64') + '$' + hash.toString('base64');
}
function compareSync(pwd, stored) {
  const m = String(stored).match(/^\\$nha\\$(\\d+)\\$([^$]+)\\$(.+)$/);
  if (!m) return false;
  const iter = parseInt(m[1]);
  const salt = Buffer.from(m[2], 'base64');
  const expected = Buffer.from(m[3], 'base64');
  const actual = crypto.pbkdf2Sync(String(pwd), salt, iter, 32, 'sha256');
  return crypto.timingSafeEqual(expected, actual);
}
async function hash(pwd, rounds) { return hashSync(pwd, rounds); }
async function compare(pwd, stored) { return compareSync(pwd, stored); }
function genSaltSync() { return 10; }
async function genSalt() { return 10; }
module.exports = { hash, hashSync, compare, compareSync, genSalt, genSaltSync };
module.exports.default = module.exports;
`;

  // uuid — v4 only
  const uuidShim = `
const crypto = require('crypto');
function v4() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
function v1() { return v4(); }
function validate(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s)); }
module.exports = { v1, v4, validate };
module.exports.default = module.exports;
`;

  // lodash — minimal subset (the 95th-percentile-used functions)
  const lodashShim = `
const _ = {};
_.isArray = Array.isArray;
_.isObject = (x) => x !== null && typeof x === 'object';
_.isString = (x) => typeof x === 'string';
_.isNumber = (x) => typeof x === 'number' && !isNaN(x);
_.isFunction = (x) => typeof x === 'function';
_.isEmpty = (x) => x == null || (Array.isArray(x) && x.length === 0) || (typeof x === 'object' && Object.keys(x).length === 0) || (typeof x === 'string' && x.length === 0);
_.get = (obj, path, def) => {
  const keys = Array.isArray(path) ? path : String(path).split('.');
  let cur = obj;
  for (const k of keys) { if (cur == null) return def; cur = cur[k]; }
  return cur === undefined ? def : cur;
};
_.set = (obj, path, val) => {
  const keys = Array.isArray(path) ? path : String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) { if (cur[keys[i]] == null) cur[keys[i]] = {}; cur = cur[keys[i]]; }
  cur[keys[keys.length - 1]] = val;
  return obj;
};
_.cloneDeep = (x) => JSON.parse(JSON.stringify(x));
_.merge = (target, ...sources) => Object.assign(target, ...sources);
_.pick = (obj, keys) => keys.reduce((o, k) => (k in obj ? (o[k] = obj[k], o) : o), {});
_.omit = (obj, keys) => Object.keys(obj).reduce((o, k) => (!keys.includes(k) ? (o[k] = obj[k], o) : o), {});
_.uniq = (arr) => [...new Set(arr)];
_.uniqBy = (arr, fn) => { const seen = new Set(); return arr.filter(x => { const k = typeof fn === 'function' ? fn(x) : x[fn]; if (seen.has(k)) return false; seen.add(k); return true; }); };
_.chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
_.flatten = (arr) => arr.flat();
_.flattenDeep = (arr) => arr.flat(Infinity);
_.groupBy = (arr, fn) => arr.reduce((o, x) => { const k = typeof fn === 'function' ? fn(x) : x[fn]; (o[k] = o[k] || []).push(x); return o; }, {});
_.sortBy = (arr, fn) => [...arr].sort((a, b) => { const av = typeof fn === 'function' ? fn(a) : a[fn]; const bv = typeof fn === 'function' ? fn(b) : b[fn]; return av < bv ? -1 : av > bv ? 1 : 0; });
_.keyBy = (arr, fn) => arr.reduce((o, x) => { o[typeof fn === 'function' ? fn(x) : x[fn]] = x; return o; }, {});
_.debounce = (fn, wait) => { let t; return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); }; };
_.throttle = (fn, wait) => { let last = 0; return function (...args) { const now = Date.now(); if (now - last >= wait) { last = now; fn.apply(this, args); } }; };
_.range = (start, end, step) => { if (end === undefined) { end = start; start = 0; } step = step || 1; const out = []; for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(i); return out; };
_.sum = (arr) => arr.reduce((a, b) => a + b, 0);
_.mean = (arr) => arr.length ? _.sum(arr) / arr.length : 0;
_.max = (arr) => arr.length ? Math.max(...arr) : undefined;
_.min = (arr) => arr.length ? Math.min(...arr) : undefined;
_.capitalize = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase();
_.camelCase = (s) => String(s).replace(/[-_\\s]+(.)?/g, (_m, c) => c ? c.toUpperCase() : '');
_.kebabCase = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[\\s_]+/g, '-').toLowerCase();
_.snakeCase = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\\s-]+/g, '_').toLowerCase();
module.exports = _;
module.exports.default = _;
`;

  // debug — namespace-aware logger
  const debugShim = `
const enabled = (process.env.DEBUG || '').split(',').filter(Boolean);
function isEnabled(ns) { return enabled.some(p => p === '*' || ns === p || (p.endsWith('*') && ns.startsWith(p.slice(0, -1)))); }
function debug(namespace) {
  const fn = function (...args) { if (isEnabled(namespace)) console.error('[' + namespace + ']', ...args); };
  fn.namespace = namespace;
  fn.enabled = isEnabled(namespace);
  fn.extend = (ns) => debug(namespace + ':' + ns);
  return fn;
}
debug.enable = (ns) => { enabled.push(...ns.split(',')); };
debug.disable = () => { enabled.length = 0; };
module.exports = debug;
module.exports.default = debug;
`;

  // chalk — ANSI color codes
  const chalkShim = `
const codes = { reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24],
  black: [30, 39], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39], white: [37, 39], gray: [90, 39],
  bgBlack: [40, 49], bgRed: [41, 49], bgGreen: [42, 49], bgYellow: [43, 49], bgBlue: [44, 49] };
function wrap(open, close, text) { return '\\x1b[' + open + 'm' + text + '\\x1b[' + close + 'm'; }
function build(styles) {
  const fn = function (...args) {
    let s = args.join(' ');
    for (let i = styles.length - 1; i >= 0; i--) { const [o, c] = codes[styles[i]]; s = wrap(o, c, s); }
    return s;
  };
  for (const k of Object.keys(codes)) Object.defineProperty(fn, k, { get: () => build([...styles, k]) });
  return fn;
}
const chalk = build([]);
chalk.level = 1;
chalk.supportsColor = { level: 1, hasBasic: true };
module.exports = chalk;
module.exports.default = chalk;
`;

  // multer — file upload middleware (no-op, no actual disk write)
  const multerShim = `
function multer(opts) {
  return {
    single: () => (req, res, next) => { req.file = null; next(); },
    array: () => (req, res, next) => { req.files = []; next(); },
    fields: () => (req, res, next) => { req.files = {}; next(); },
    any: () => (req, res, next) => { req.files = []; next(); },
    none: () => (req, res, next) => next(),
  };
}
multer.diskStorage = (opts) => ({ _kind: 'disk', opts });
multer.memoryStorage = () => ({ _kind: 'memory' });
module.exports = multer;
module.exports.default = multer;
`;

  // express — minimal HTTP framework shim (route matching, middleware chain,
  // req.params/query/body, res.json/send/status). Enough to boot a typical
  // LLM-generated Express app even without express in node_modules.
  const expressShim = `
const http = require('http');
const url = require('url');

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      try {
        if (/json/i.test(ct)) resolve(raw ? JSON.parse(raw) : {});
        else if (/urlencoded/i.test(ct)) {
          const o = {};
          for (const p of raw.split('&')) { const [k, v] = p.split('=').map(decodeURIComponent); if (k) o[k] = v || ''; }
          resolve(o);
        } else resolve(raw);
      } catch { resolve(raw); }
    });
  });
}

function compilePath(p) {
  if (p instanceof RegExp) return { re: p, keys: [] };
  const keys = [];
  const re = '^' + String(p).replace(/:([^/]+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '/?$';
  return { re: new RegExp(re), keys };
}

function createApp() {
  // Flat layer list — each handler is its own layer (matches Express semantics).
  // Layer types: 'normal' (3-arg) or 'error' (4-arg). Path-mounted layers
  // ('app.use("/api", router)') get a prefix that must match the URL.
  const layers = [];
  const settings = {};

  function addLayer(method, re, keys, prefix, handler) {
    const isErrHandler = typeof handler === 'function' && handler.length === 4;
    layers.push({ method, re, keys, prefix, handler, isErrHandler });
  }

  function use(arg, ...rest) {
    let prefix = '';
    let handlers = rest;
    if (typeof arg === 'function') {
      handlers = [arg, ...rest];
    } else {
      prefix = String(arg).replace(/\\/+$/, '');
    }
    for (const h of handlers.flat()) {
      if (typeof h !== 'function') continue;
      addLayer('ALL', /.*/, [], prefix, h);
    }
    return app;
  }
  function addRoute(method) {
    return (p, ...handlers) => {
      const c = compilePath(p);
      for (const h of handlers.flat()) {
        if (typeof h !== 'function') continue;
        addLayer(method, c.re, c.keys, '', h);
      }
      return app;
    };
  }
  const app = async function (req, res) {
    const parsed = url.parse(req.url, true);
    req.path = parsed.pathname;
    req.query = parsed.query;
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) req.body = await parseBody(req);
    if (!res.json) {
      res.json = function (obj) { this.setHeader('Content-Type', 'application/json'); this.end(JSON.stringify(obj)); return this; };
      res.send = function (data) { if (typeof data === 'object') return this.json(data); this.end(String(data)); return this; };
      res.status = function (n) { this.statusCode = n; return this; };
      res.sendStatus = function (n) { this.statusCode = n; this.end(http.STATUS_CODES[n] || ''); return this; };
      res.redirect = function (loc) { this.statusCode = 302; this.setHeader('Location', loc); this.end(); return this; };
    }

    // Real Express-style routing chain:
    //   - 3-arg handlers run ONLY when err is null/undefined
    //   - 4-arg handlers run ONLY when err is truthy
    //   - Path-mounted middleware ('/api') only runs if req.path matches prefix
    //   - Method-specific layers (GET/POST/...) only run for that method
    let idx = 0;
    function nextLayer(err) {
      while (idx < layers.length) {
        const layer = layers[idx++];
        // Method filter
        if (layer.method !== 'ALL' && layer.method !== req.method) continue;
        // Path filter
        if (layer.prefix) {
          if (!req.path.startsWith(layer.prefix)) continue;
          const remaining = req.path.slice(layer.prefix.length);
          if (remaining && !remaining.startsWith('/')) continue;
        } else if (layer.re && layer.method !== 'ALL') {
          // Specific route — must match
          const m = req.path.match(layer.re);
          if (!m) continue;
          req.params = {};
          layer.keys.forEach((k, i) => { req.params[k] = m[i + 1]; });
        }
        // Error chain filter: skip normal handlers when in error, and skip
        // error handlers when not in error. THIS is the fix for the MySaaS bug.
        if (err && !layer.isErrHandler) continue;
        if (!err && layer.isErrHandler) continue;

        try {
          if (layer.isErrHandler) {
            return layer.handler(err, req, res, nextLayer);
          }
          return layer.handler(req, res, nextLayer);
        } catch (e) { return nextLayer(e); }
      }
      // End of chain — default response
      if (err) {
        res.statusCode = err.status || err.statusCode || 500;
        res.end('Error: ' + ((err && err.message) || String(err)));
      } else {
        res.statusCode = 404;
        res.end('Cannot ' + req.method + ' ' + req.path);
      }
    }
    nextLayer();
  };
  app.use = use;
  app.get = addRoute('GET'); app.post = addRoute('POST'); app.put = addRoute('PUT');
  app.delete = addRoute('DELETE'); app.patch = addRoute('PATCH'); app.options = addRoute('OPTIONS');
  app.all = (path, ...handlers) => { const c = compilePath(path); stack.push({ method: 'ALL', re: c.re, keys: c.keys, handlers: handlers.flat() }); return app; };
  app.set = (k, v) => { settings[k] = v; return app; };
  app.get_setting = (k) => settings[k];
  app.disable = (k) => { settings[k] = false; return app; };
  app.enable = (k) => { settings[k] = true; return app; };
  app.listen = function (port, cb) { const server = http.createServer(app); server.listen(port, cb); return server; };
  return app;
}

const express = createApp;
express.json = function (opts) { return async (req, res, next) => { if (/json/i.test(req.headers['content-type'] || '')) req.body = await parseBody(req); next(); }; };
express.urlencoded = function (opts) { return async (req, res, next) => { if (/urlencoded/i.test(req.headers['content-type'] || '')) req.body = await parseBody(req); next(); }; };

// MIME type table for static files
const _MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.eot':  'application/vnd.ms-fontobject',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml',
  '.pdf':  'application/pdf',
  '.map':  'application/json',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
};

// Real express.static implementation — serves files from disk with proper
// MIME types. Supports index.html for directory requests, path traversal
// protection. Falls through to next() when the file doesn't exist.
express.static = function (root, opts) {
  opts = opts || {};
  const indexFile = opts.index === false ? null : (opts.index || 'index.html');
  const rootAbs = require('path').resolve(root);
  return function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      let relPath = decodeURIComponent((req.path || req.url || '/').split('?')[0]);
      // Path traversal protection
      if (relPath.includes('\\\\0') || relPath.includes('..')) return next();
      if (relPath.startsWith('/')) relPath = relPath.slice(1);
      const abs = require('path').resolve(rootAbs, relPath);
      // Ensure resolved path stays within root
      if (!abs.startsWith(rootAbs)) return next();
      let stat;
      try { stat = require('fs').statSync(abs); } catch { return next(); }
      let filePath = abs;
      if (stat.isDirectory()) {
        if (!indexFile) return next();
        filePath = require('path').join(abs, indexFile);
        try { stat = require('fs').statSync(filePath); } catch { return next(); }
        if (!stat.isFile()) return next();
      }
      const ext = require('path').extname(filePath).toLowerCase();
      const mime = _MIME[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'public, max-age=0');
      if (req.method === 'HEAD') return res.end();
      require('fs').createReadStream(filePath).pipe(res);
    } catch (e) {
      return next();
    }
  };
};

express.Router = function () { const r = createApp(); return r; };
module.exports = express;
module.exports.default = express;
`;

  // marked — minimal Markdown → HTML parser. Real `marked` is 200KB+ but we
  // only need basic parsing. Covers: headings, bold/italic, links, code blocks,
  // lists, paragraphs, line breaks. Good enough for blog-style content.
  const markedShim = `
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function parseMarkdown(md) {
  if (!md) return '';
  let html = String(md);
  // Code blocks (must come first)
  html = html.replace(/\\\`\\\`\\\`(\\\\w+)?\\n([\\s\\S]*?)\\n\\\`\\\`\\\`/g, (_, lang, code) => '<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' + escapeHtml(code) + '</code></pre>');
  // Inline code
  html = html.replace(/\\\`([^\\\`\\n]+)\\\`/g, '<code>$1</code>');
  // Headings
  html = html.replace(/^######\\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\\s+(.+)$/gm, '<h1>$1</h1>');
  // Bold + italic
  html = html.replace(/\\*\\*\\*([^*]+)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  // Links + images
  html = html.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img src="$2" alt="$1">');
  html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
  // Blockquotes
  html = html.replace(/^>\\s+(.+)$/gm, '<blockquote>$1</blockquote>');
  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr>');
  // Lists (simple)
  html = html.replace(/^[\\*\\-]\\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\\s\\S]*?<\\/li>\\n?)+/g, (m) => '<ul>' + m.replace(/\\n/g, '') + '</ul>');
  html = html.replace(/^\\d+\\.\\s+(.+)$/gm, '<li>$1</li>');
  // Paragraphs (lines not in other elements)
  const lines = html.split(/\\n\\n+/);
  html = lines.map(line => {
    line = line.trim();
    if (!line) return '';
    if (/^<(h[1-6]|ul|ol|pre|blockquote|hr|p|div)/.test(line)) return line;
    return '<p>' + line + '</p>';
  }).join('\\n');
  return html;
}
function marked(md, opts) {
  return parseMarkdown(md);
}
marked.parse = parseMarkdown;
marked.setOptions = function () { return marked; };
marked.use = function () { return marked; };
marked.Renderer = function () {};
marked.parseInline = function (md) {
  let html = String(md || '');
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  html = html.replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>');
  html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
  return html;
};
module.exports = marked;
module.exports.marked = marked;
module.exports.default = marked;
`;

  // axios — minimal fetch-based replacement
  const axiosShim = `
async function request(config) {
  const url = typeof config === 'string' ? config : config.url;
  const method = (typeof config === 'object' && config.method) || 'GET';
  const headers = (typeof config === 'object' && config.headers) || {};
  const body = typeof config === 'object' ? config.data : undefined;
  const init = { method, headers: { ...headers }, };
  if (body !== undefined) {
    if (typeof body === 'object' && !(body instanceof URLSearchParams)) {
      init.body = JSON.stringify(body);
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    } else { init.body = body; }
  }
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (res.status >= 400) { const err = new Error('Request failed with status code ' + res.status); err.response = { status: res.status, data, headers: Object.fromEntries(res.headers) }; throw err; }
  return { data, status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers) };
}
const axios = function (config) { return request(config); };
axios.request = request;
axios.get = (url, config) => request({ ...config, url, method: 'GET' });
axios.post = (url, data, config) => request({ ...config, url, method: 'POST', data });
axios.put = (url, data, config) => request({ ...config, url, method: 'PUT', data });
axios.patch = (url, data, config) => request({ ...config, url, method: 'PATCH', data });
axios.delete = (url, config) => request({ ...config, url, method: 'DELETE' });
axios.create = (defaults) => axios;
module.exports = axios;
module.exports.default = axios;
`;

  // Generic no-op shim — deeply chainable proxy. Survives any .a().b.c().d
  // access chain because every get/apply returns another proxy of the same shape.
  const noopShim = `
const noop = function () {};
const handler = {
  get(target, prop) {
    if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.iterator) return undefined;
    if (prop === 'default') return proxy;
    if (prop === 'toString') return () => '[nha-noop]';
    return proxy;
  },
  apply() { return proxy; },
  construct() { return proxy; },
};
const proxy = new Proxy(noop, handler);
module.exports = proxy;
module.exports.default = proxy;
`;

  const shimFiles = {
    'pg.js': pgShim,
    'redis.js': redisShim,
    'ioredis.js': redisShim,
    'helmet.js': helmetShim,
    'mongoose.js': noopShim,
    'sequelize.js': noopShim,
    'dotenv.js': dotenvShim,
    'cors.js': corsShim,
    'morgan.js': morganShim,
    'body-parser.js': bodyParserShim,
    'cookie-parser.js': cookieParserShim,
    'compression.js': compressionShim,
    'express-rate-limit.js': rateLimitShim,
    'jsonwebtoken.js': jwtShim,
    'bcryptjs.js': bcryptShim,
    'bcrypt.js': bcryptShim,
    'uuid.js': uuidShim,
    'lodash.js': lodashShim,
    'debug.js': debugShim,
    'chalk.js': chalkShim,
    'multer.js': multerShim,
    'axios.js': axiosShim,
    'express.js': expressShim,
    'marked.js': markedShim,
    'markdown-it.js': markedShim,
    'noop.js': noopShim,
  };
  for (const [name, content] of Object.entries(shimFiles)) {
    fs.writeFileSync(path.join(shimDir, name), content, 'utf-8');
  }

  // Shim index — only activates a shim if the REAL package is missing.
  // This lets a project that has its own dotenv/cors/etc. installed use the
  // real implementation, and only falls back to our shim when resolution fails.
  // Also supports NHA_OFFLINE_SHIM=1 to no-op any unresolvable module.
  const shimList = JSON.stringify(Object.keys(shimFiles).filter(f => f !== 'noop.js').map(f => f.replace(/\.js$/, '')));
  // ALIAS map: bare names the LLM tends to invent → real package name we shim.
  // Must stay in sync with _PACKAGE_ALIASES in the parent module so pre-scan
  // and runtime shim agree on what to resolve.
  const aliasJson = JSON.stringify({
    'bcrypt': 'bcryptjs',
    'jwt': 'jsonwebtoken',
    'mongo': 'mongoose',
    'postgres': 'pg',
    'postgresql': 'pg',
    'env': 'dotenv',
    'express-cors': 'cors',
    'express-helmet': 'helmet',
    'express-body-parser': 'body-parser',
  });
  const shimIndex = `
const Module = require('module');
const path = require('path');
const __shimDir = ${JSON.stringify(shimDir)};
const SHIM_NAMES = new Set(${shimList});
const ALIAS = ${aliasJson};
const OFFLINE = process.env.NHA_OFFLINE_SHIM === '1';
const _original = Module._resolveFilename.bind(Module);

function shimPath(name) {
  const f = (ALIAS[name] || name) + '.js';
  return path.join(__shimDir, f);
}

Module._resolveFilename = function(request, parent, isMain, options) {
  try {
    return _original(request, parent, isMain, options);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      if (SHIM_NAMES.has(request) || ALIAS[request]) {
        return shimPath(request);
      }
      if (OFFLINE && !request.startsWith('.') && !request.startsWith('/') && !request.startsWith('node:')) {
        try { console.error('[nha-shim] offline-noop for missing module: ' + request); } catch {}
        return path.join(__shimDir, 'noop.js');
      }
    }
    throw err;
  }
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
