/**
 * Config routes — read/write ~/.nha/config.json + version check + weather + health
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig, saveConfig, setConfigValue } from '../../config.mjs';
import { VERSION } from '../../constants.mjs';
import { getAuthenticatedProviders, loadTokens } from '../../services/token-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function _weatherIcon(code) {
  const c = parseInt(code);
  if ([113].includes(c)) return '☀️';
  if ([116].includes(c)) return '⛅';
  if ([119, 122].includes(c)) return '☁️';
  if ([143, 248, 260].includes(c)) return '🌫️';
  if ([176, 263, 266, 293, 296, 299, 302, 305, 308, 353].includes(c)) return '🌧️';
  if ([179, 182, 185, 227, 230, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377].includes(c)) return '❄️';
  if ([200, 386, 389, 392, 395].includes(c)) return '⚡';
  return '🌡️';
}

export function register(router) {

  // GET /api/health
  router.get('/api/health', (_req, res) => {
    sendJSON(res, 200, { ok: true, version: VERSION, ts: Date.now() });
  });

  // GET /api/audit/query — query the cross-channel audit log.
  // Optional query params: tool, channel, since (ms timestamp), limit.
  router.get('/api/audit/query', async (req, res) => {
    try {
      const { queryAuditLog } = await import('../../services/message-responder.mjs');
      const url = new URL(req.url, 'http://localhost');
      const entries = queryAuditLog({
        tool: url.searchParams.get('tool') || undefined,
        channel: url.searchParams.get('channel') || undefined,
        since: url.searchParams.get('since') ? parseInt(url.searchParams.get('since'), 10) : undefined,
        limit: parseInt(url.searchParams.get('limit') || '100', 10),
      });
      sendJSON(res, 200, { entries });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
  });

  // GET /api/version/check
  //
  // Returns three version signals so the UI can distinguish three states:
  //   - runtime:   what this LIVE process loaded into memory at startup
  //   - installed: what's currently on disk in package.json (post-npm-install)
  //   - latest:    what npm registry advertises as latest
  //
  // The classic "I just ran npm install but the UI still shows the old version"
  // happens because the long-running server still holds the OLD version in
  // memory while the disk has the NEW one. needsRestart flags exactly this.
  router.get('/api/version/check', async (_req, res) => {
    let installedVersion = VERSION;
    try {
      const pkgPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version) installedVersion = pkg.version;
    } catch { /* fallback to in-memory VERSION */ }

    const needsRestart = installedVersion !== VERSION;

    try {
      const r = await fetch('https://registry.npmjs.org/nothumanallowed/latest', {
        signal: AbortSignal.timeout(5_000),
      });
      const data = await r.json();
      const latest = data.version;
      const hasUpdate = latest !== installedVersion;
      sendJSON(res, 200, {
        current: installedVersion,
        runtime: VERSION,
        installed: installedVersion,
        latest,
        hasUpdate,
        updateAvailable: hasUpdate,
        needsRestart,
        restartHint: needsRestart
          ? `Server in esecuzione: v${VERSION}. Pacchetto installato sul disco: v${installedVersion}. Riavvia "nha ui" per attivare la nuova versione.`
          : null,
      });
    } catch {
      sendJSON(res, 200, {
        current: installedVersion,
        runtime: VERSION,
        installed: installedVersion,
        latest: installedVersion,
        hasUpdate: false,
        updateAvailable: false,
        needsRestart,
        restartHint: needsRestart
          ? `Server in esecuzione: v${VERSION}. Pacchetto installato sul disco: v${installedVersion}. Riavvia "nha ui" per attivare la nuova versione.`
          : null,
      });
    }
  });

  // POST /api/npm-update
  //
  // Two-phase update:
  //   1. Sync part: run `npm install -g nothumanallowed@latest --prefer-online`
  //      with cache bypass. Bypass is critical — without --prefer-online, npm
  //      can install the same version it had cached locally and the user sees
  //      "nothing changed" (the classic stale-manifest trap).
  //   2. Async part: spawn a DETACHED helper that watches our PID, waits until
  //      we exit, sleeps 1 s so the port frees, then re-spawns this process
  //      with the SAME argv. The newly installed code runs because node will
  //      re-read the entry script from disk on the next invocation.
  //
  // The response is sent BEFORE the parent exits, so the client knows what
  // version to expect and can poll /api/health for the restart to complete.
  router.post('/api/npm-update', async (req, res) => {
    try {
      const { exec, spawn } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Permission preflight on POSIX
      if (process.platform !== 'win32') {
        try {
          const { stdout: prefix } = await execAsync('npm config get prefix', { timeout: 5000 });
          const globalDir = prefix.trim();
          await fs.promises.access(path.join(globalDir, 'lib'), fs.constants.W_OK);
        } catch {
          sendJSON(res, 200, {
            success: false,
            error: 'EACCES: permission denied',
            message: 'Permission denied. Run: sudo npm install -g nothumanallowed@latest --prefer-online',
          });
          return;
        }
      }

      // Clean the metadata cache first — defeats the stale-cache trap that
      // makes `npm install -g <pkg>` silently install an older version.
      try { await execAsync('npm cache clean --force', { timeout: 10_000 }); } catch { /* non-fatal */ }

      const cmd = 'npm install -g nothumanallowed@latest --registry=https://registry.npmjs.org/ --prefer-online --no-fund --no-audit';
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 120_000,
        env: { ...process.env, NODE_ENV: 'production' },
      });

      // Resolve the version that actually landed on disk
      let newVersion = '';
      try {
        const verMatch = stdout.match(/nothumanallowed@(\d+\.\d+\.\d+)/);
        if (verMatch) {
          newVersion = verMatch[1];
        } else {
          const regResp = await fetch('https://registry.npmjs.org/nothumanallowed/latest');
          const regData = await regResp.json();
          newVersion = regData.version || '';
        }
      } catch { /* ignore */ }

      // Remember if the ops daemon (Telegram/Discord bot) was running so the
      // newly-spawned server can restart it. Without this, a VM user who
      // controls everything via Telegram would lose the bot until they ran
      // `nha ops start` manually.
      let daemonWasRunning = false;
      try {
        const { isRunning, stopDaemon } = await import('../../services/ops-daemon.mjs');
        if (isRunning()) {
          daemonWasRunning = true;
          await stopDaemon();
        }
      } catch { /* ignore */ }

      // Send the response NOW, before we kick off the restart. The client
      // needs this payload to know what version to wait for during polling.
      sendJSON(res, 200, {
        success: true,
        message: newVersion ? `Updated to v${newVersion}. Restarting server...` : 'Update completed. Restarting...',
        newVersion,
        restart: true,
        restarting: true,
        needsManualRestart: false,
        stdout: stdout.trim().slice(-2000),
        stderr: stderr.trim().slice(-2000),
      });

      // ── Schedule the self-restart ──
      const parentPid = process.pid;
      const respawnNode = process.execPath;
      const respawnArgs = process.argv.slice(1);
      const home = os.homedir();
      const nhaDir = path.join(home, '.nha');
      if (!fs.existsSync(nhaDir)) fs.mkdirSync(nhaDir, { recursive: true });

      // Write the restart marker BEFORE spawning the helper. The new server
      // reads this on boot to know:
      //   - the update happened (so it can show "Updated to v…" on first load)
      //   - whether the ops daemon (Telegram bot) was running and must be restarted
      const markerPath = path.join(nhaDir, 'last-restart.json');
      try {
        fs.writeFileSync(
          markerPath,
          JSON.stringify({
            at: new Date().toISOString(),
            fromVersion: VERSION,
            toVersion: newVersion,
            daemonWasRunning,
            parentPid,
          }, null, 2),
        );
      } catch { /* non-fatal */ }

      // Open log file for the detached child — if anything goes wrong on boot
      // we want the user to be able to read why instead of staring at a black
      // screen. Append mode so previous restart logs survive.
      const logPath = path.join(nhaDir, 'server.log');
      let logFd;
      try {
        logFd = fs.openSync(logPath, 'a');
        fs.writeSync(logFd, `\n[${new Date().toISOString()}] === Restart helper spawning. Parent PID: ${parentPid}. Target version: ${newVersion} ===\n`);
      } catch { /* will fall back to 'ignore' */ }

      setTimeout(() => {
        try {
          if (process.platform === 'win32') {
            // Windows: PowerShell waits for the parent to die, frees the port,
            // then starts node hidden. Output is redirected to server.log.
            const psScript = [
              `try { Wait-Process -Id ${parentPid} -Timeout 30 } catch {};`,
              `Start-Sleep -Milliseconds 1500;`,
              `$logPath = "${logPath.replace(/\\/g, '\\\\')}";`,
              `Start-Process -FilePath "${respawnNode.replace(/\\/g, '\\\\')}"`,
              ` -ArgumentList ${JSON.stringify(respawnArgs).replace(/"/g, '\\"')}`,
              ` -RedirectStandardOutput $logPath -RedirectStandardError $logPath`,
              ` -WindowStyle Hidden`,
            ].join('').replace(/\s+/g, ' ').trim();
            spawn('powershell.exe', ['-NoProfile', '-Command', psScript], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            }).unref();
          } else {
            // POSIX: poll for parent death (max ~12s), then wait an extra 2s
            // for TIME_WAIT to clear on the listen socket, then exec node
            // with stdio redirected to the log file.
            const escArg = a => `'${a.replace(/'/g, `'\\''`)}'`;
            const escapedArgs = respawnArgs.map(escArg).join(' ');
            const escapedNode = escArg(respawnNode);
            const escapedLog = escArg(logPath);
            const sh = `
              i=0
              while kill -0 ${parentPid} 2>/dev/null && [ $i -lt 60 ]; do
                sleep 0.2
                i=$((i+1))
              done
              # Extra wait: lets TIME_WAIT on the listen socket release and
              # gives the kernel a moment to fully reap the parent.
              sleep 2
              exec ${escapedNode} ${escapedArgs} >> ${escapedLog} 2>&1
            `;
            const childStdio = logFd ? ['ignore', logFd, logFd] : 'ignore';
            spawn('sh', ['-c', sh], {
              detached: true,
              stdio: childStdio,
            }).unref();
          }
        } catch { /* spawn failed — user will need to restart manually */ }

        setTimeout(() => process.exit(0), 200);
      }, 600);
    } catch (e) {
      const isPermission = e.message?.includes('EACCES') || e.message?.includes('permission denied');
      sendJSON(res, 200, {
        success: false,
        error: isPermission ? 'EACCES: permission denied' : e.message,
        message: isPermission
          ? 'Permission denied. Run: sudo npm install -g nothumanallowed@latest --prefer-online'
          : `Update failed: ${e.message}. Try manually: npm cache clean --force && npm install -g nothumanallowed@latest --prefer-online`,
      });
    }
  });

  // GET /api/config
  router.get('/api/config', (_req, res) => {
    try {
      const config = loadConfig();
      // Return a flat view that the UI can consume directly
      sendJSON(res, 200, {
        // raw nested (for anything that needs it)
        ...config,
        // flat aliases used by Settings.tsx
        provider:     config.llm?.provider     || 'nha',
        model:        config.llm?.model        || '',
        thinking:     config.thinking          || 'off',
        lang:         config.language          || config.voice?.language || 'en',
        planTime:     config.ops?.planTime     || '07:00',
        summaryTime:  config.ops?.summaryTime  || '18:00',
        meetingAlert: config.ops?.meetingAlertMinutes ?? 30,
        hasTelegram:  !!(config.responder?.telegram?.token),
        hasDiscord:   !!(config.responder?.discord?.token),
        // Key presence flags (never expose the actual key)
        hasApiKey:    !!(config.llm?.apiKey),
        hasOpenaiKey: !!(config.llm?.openaiKey),
        hasGeminiKey: !!(config.llm?.geminiKey),
        hasDeepseekKey: !!(config.llm?.deepseekKey),
        hasGrokKey:   !!(config.llm?.grokKey),
        hasGroqKey:   !!(config.llm?.groqKey),
        hasMistralKey: !!(config.llm?.mistralKey),
        hasCohereKey: !!(config.llm?.cohereKey),
        hasGithubToken: !!(config.github?.token),
        hasNotionToken: !!(config.notion?.token),
        hasSlackToken:  !!(config.slack?.token),
        // Google / Microsoft — use token-store (encrypted) as source of truth
        hasGoogle:    !!((() => { try { return getAuthenticatedProviders().google; } catch { return config.google?.accessToken || config.google?.refreshToken; } })()),
        hasMicrosoft: !!((() => { try { return getAuthenticatedProviders().microsoft; } catch { return config.microsoft?.accessToken || config.microsoft?.refreshToken; } })()),
        googleEmail:  (() => { try { return loadTokens('google')?.email || null; } catch { return null; } })(),
        microsoftEmail: (() => { try { return loadTokens('microsoft')?.email || null; } catch { return null; } })(),
        // Profile (safe)
        profile: config.profile || {},
        // Redact sensitive nested fields
        llm: undefined,
        agent: undefined,
        responder: undefined,
      });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/config — set one or more config values
  router.post('/api/config', async (req, res) => {
    try {
      const body = await parseBody(req);
      if (body.key && body.value !== undefined) {
        const ok = setConfigValue(body.key, body.value);
        if (!ok) return sendError(res, 400, `Unknown config key: ${body.key}`);
        return sendJSON(res, 200, { ok: true });
      }
      // Bulk update: { updates: [{key, value}] }
      if (body.updates && Array.isArray(body.updates)) {
        for (const { key, value } of body.updates) setConfigValue(key, value);
        return sendJSON(res, 200, { ok: true });
      }
      sendError(res, 400, 'Expected { key, value } or { updates: [{key,value}] }');
    } catch (e) { sendError(res, 500, e.message); }
  });

  // GET /api/status — system status (provider, version, platform)
  router.get('/api/status', (_req, res) => {
    try {
      const config = loadConfig();
      sendJSON(res, 200, {
        version: VERSION,
        provider: config.llm?.provider || 'nha',
        platform: process.platform,
        node: process.version,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // GET /api/weather?location=<city name OR lat,lon>
  // Uses wttr.in — accepts both "Milan" and "45.46,9.19"
  router.get('/api/weather', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const loc = url.searchParams.get('location') || '';
      if (!loc) return sendError(res, 400, 'Missing location');
      const encodedLoc = encodeURIComponent(loc);
      const r = await fetch(
        `https://wttr.in/${encodedLoc}?format=j1`,
        { headers: { 'User-Agent': 'nha-ui/1.0' }, signal: AbortSignal.timeout(15000) }
      );
      if (!r.ok) return sendError(res, 502, `Weather service error: ${r.status}`);
      const w = await r.json();
      const cur = w.current_condition?.[0];
      const area = w.nearest_area?.[0];
      if (!cur) return sendError(res, 404, 'No weather data');
      sendJSON(res, 200, {
        tempC:    parseFloat(cur.temp_C),
        feelsC:   parseFloat(cur.FeelsLikeC),
        humidity: cur.humidity,
        desc:     cur.weatherDesc?.[0]?.value || '',
        icon:     _weatherIcon(cur.weatherCode),
        city:     area?.areaName?.[0]?.value || loc,
        country:  area?.country?.[0]?.value || '',
        windKmph: cur.windspeedKmph,
      });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/update-npm — run npm install -g nothumanallowed@latest
  router.post('/api/update-npm', async (_req, res) => {
    const { exec } = await import('child_process');
    exec('npm install -g nothumanallowed@latest', { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '');
        // Permission denied — retry with sudo (Linux/VM)
        if (msg.includes('EACCES') || msg.includes('permission denied')) {
          exec('sudo npm install -g nothumanallowed@latest', { timeout: 120000 }, (err2, stdout2, stderr2) => {
            if (err2) return sendError(res, 500, stderr2 || err2.message);
            sendJSON(res, 200, { ok: true, output: stdout2, sudo: true });
          });
          return;
        }
        return sendError(res, 500, msg);
      }
      sendJSON(res, 200, { ok: true, output: stdout });
    });
  });

  // GET /api/screenshots/:filename — serve screenshot files from ~/.nha/screenshots/
  router.get(/^\/api\/screenshots\/(?<filename>[^/?]+)/, (req, res) => {
    const filename = req.params.filename ?? '';
    if (!filename || filename.includes('..') || filename.includes('/')) {
      return sendError(res, 400, 'Invalid filename');
    }
    const screenshotsDir = path.join(os.homedir(), '.nha', 'screenshots');
    const abs = path.join(screenshotsDir, filename);
    if (!abs.startsWith(screenshotsDir)) return sendError(res, 400, 'Path traversal rejected');
    if (!fs.existsSync(abs)) return sendError(res, 404, 'Screenshot not found');
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
    const data = fs.readFileSync(abs);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
}
