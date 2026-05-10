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

  // GET /api/version/check
  router.get('/api/version/check', async (_req, res) => {
    try {
      // Read installed version from disk (not from in-memory constant) so that
      // after npm-update the check reflects the newly installed version
      let installedVersion = VERSION;
      try {
        const pkgPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.version) installedVersion = pkg.version;
      } catch { /* fallback to in-memory VERSION */ }

      const r = await fetch('https://registry.npmjs.org/nothumanallowed/latest');
      const data = await r.json();
      const upd = data.version !== installedVersion;
      sendJSON(res, 200, { current: installedVersion, latest: data.version, hasUpdate: upd, updateAvailable: upd });
    } catch {
      sendJSON(res, 200, { current: VERSION, latest: VERSION, hasUpdate: false, updateAvailable: false });
    }
  });

  // POST /api/npm-update
  router.post('/api/npm-update', async (req, res) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Detect the package manager and global prefix to handle permissions correctly
      let cmd = 'npm install -g nothumanallowed@latest';

      // On macOS/Linux, check if we need special handling for permission
      if (process.platform !== 'win32') {
        try {
          // Check if npm global dir is writable by current user
          const { stdout: prefix } = await execAsync('npm config get prefix', { timeout: 5000 });
          const globalDir = prefix.trim();
          await fs.promises.access(path.join(globalDir, 'lib'), fs.constants.W_OK);
        } catch {
          // Global dir not writable — return error with clear instructions
          sendJSON(res, 200, {
            success: false,
            error: 'EACCES: permission denied',
            message: 'Permission denied. Run: sudo npm install -g nothumanallowed@latest'
          });
          return;
        }
      }

      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 120_000,
        env: { ...process.env, NODE_ENV: 'production' },
      });

      // Read the newly installed version from disk
      let newVersion = '';
      try {
        const pkgPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        newVersion = pkg.version || '';
      } catch { /* ignore */ }

      sendJSON(res, 200, {
        success: true,
        message: newVersion ? `Updated to v${newVersion}` : 'Update completed',
        newVersion,
        restart: true,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });

      // Self-restart: resolve the NEW nha binary from npm global, spawn it, then exit.
      // Must use the fresh binary path (not process.argv which points to the OLD code).
      setTimeout(async () => {
        try {
          const { spawn, execSync } = await import('child_process');
          // Find the nha binary in PATH (points to the newly installed version)
          let nhaBin = 'nha';
          try {
            nhaBin = execSync('which nha', { encoding: 'utf-8', timeout: 3000 }).trim() || 'nha';
          } catch { /* fallback to bare 'nha' */ }

          const child = spawn(nhaBin, ['ui'], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, NHA_RESTARTED: '1' },
            shell: true,
          });
          child.unref();
          // Give the child process time to bind the port before we die
          await new Promise((r) => setTimeout(r, 2000));
        } catch { /* ignore spawn errors */ }
        process.exit(0);
      }, 1500);
    } catch (e) {
      const isPermission = e.message?.includes('EACCES') || e.message?.includes('permission denied');
      sendJSON(res, 200, {
        success: false,
        error: isPermission ? 'EACCES: permission denied' : e.message,
        message: isPermission
          ? 'Permission denied. Run: sudo npm install -g nothumanallowed@latest'
          : 'Update failed. Try running: npm install -g nothumanallowed@latest'
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
        hasMistralKey: !!(config.llm?.mistralKey),
        hasCohereKey: !!(config.llm?.cohereKey),
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
