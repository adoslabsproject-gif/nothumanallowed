/**
 * Google OAuth 2.0 with PKCE — browser-based consent flow.
 * Runs ephemeral local HTTP server for callback, or manual code-paste for headless/VM.
 * Zero dependencies — uses Node.js native http + crypto + readline.
 */

import http from 'http';
import crypto from 'crypto';
import readline from 'readline';
import { execSync } from 'child_process';
import os from 'os';
import { saveTokens, loadTokens, deleteTokens } from './token-store.mjs';
import { info, ok, fail, warn } from '../ui.mjs';

// IMPORTANT: NHA does NOT ship a default Google OAuth client ID.
// The previous placeholder (516893094132-8u2jf...) was a fake-looking value
// that always returned `invalid_client` from Google. Each user must register
// their own OAuth client in Google Cloud Console — this is by design for
// privacy (no shared client app), and it's a one-time 3-minute setup.
// See https://nothumanallowed.com/docs/google for the full guide.
const DEFAULT_CLIENT_ID = '';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  // drive.file: app può CREARE/MODIFICARE/ELIMINARE solo i file generati
  // dall'app stessa. Principio del privilegio minimo, raccomandato da Google.
  // Necessario per action_drive (workflow AWF), webhook automatic upload, etc.
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

const CALLBACK_PORTS = [19847, 19848, 19849, 19850, 19851];

/**
 * Generate PKCE code_verifier and code_challenge.
 */
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Open URL in user's default browser.
 * Returns true if browser opened successfully, false otherwise.
 */
function openBrowser(url) {
  const platform = os.platform();
  try {
    if (platform === 'darwin') execSync(`open "${url}"`, { stdio: 'ignore' });
    else if (platform === 'win32') execSync(`start "" "${url}"`, { stdio: 'ignore' });
    else execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Manual mode: print the auth URL and ask the user to paste back
 * the full redirect URL (http://127.0.0.1:PORT/callback?code=...&state=...)
 * that appears in their browser's address bar after Google login.
 * Works on any headless/VM/SSH setup — no local server needed.
 */
function waitForManualCode(authUrl, state) {
  return new Promise((resolve, reject) => {
    console.log('\n\x1b[1;33m  MANUAL AUTH MODE\x1b[0m');
    console.log('\x1b[0;90m  ─────────────────────────────────────────────────────\x1b[0m');
    console.log('  1. Open this URL on any device with a browser (phone, PC...):');
    console.log('\n\x1b[0;36m  ' + authUrl + '\x1b[0m\n');
    console.log('  2. Log in with Google and grant permissions.');
    console.log('  3. The browser will try to open a page that fails to load.');
    console.log('     That is expected. Copy the full URL from the address bar.');
    console.log('     It looks like: \x1b[0;32mhttp://127.0.0.1:19847/callback?code=4/0A...&state=...\x1b[0m');
    console.log('\x1b[0;90m  ─────────────────────────────────────────────────────\x1b[0m\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  Paste the full redirect URL here: ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      try {
        // Accept both the full URL and just the code= value
        let code, returnedState;
        if (trimmed.startsWith('http')) {
          const parsed = new URL(trimmed);
          code = parsed.searchParams.get('code');
          returnedState = parsed.searchParams.get('state');
        } else {
          // Maybe they pasted just the code directly
          code = trimmed;
          returnedState = state; // trust them
        }

        if (!code) {
          reject(new Error('No authorization code found in the URL you pasted.'));
          return;
        }
        if (returnedState && returnedState !== state) {
          reject(new Error('State mismatch — the URL does not match this auth session. Try again.'));
          return;
        }
        resolve(code);
      } catch {
        reject(new Error('Could not parse the URL. Make sure you copied the full address bar URL.'));
      }
    });
  });
}

/**
 * Start ephemeral HTTP server and wait for OAuth callback.
 * @returns {Promise<{code: string, port: number}>}
 */
function waitForCallback(state, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Authorization failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Invalid callback</h2><p>Missing code or state mismatch.</p></body></html>');
        server.close();
        reject(new Error('Invalid OAuth callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
        <head><style>body{font-family:monospace;background:#0a0a0a;color:#00ff41;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
        .box{text-align:center;border:1px solid #00ff41;padding:40px;border-radius:8px}</style></head>
        <body><div class="box">
          <h2>NHA Connected</h2>
          <p>Google account linked successfully.</p>
          <p style="color:#666">You can close this tab and return to the terminal.</p>
        </div></body></html>
      `);

      server.close();
      resolve({ code, port });
    });

    server.listen(port, '127.0.0.1');
    server.on('error', () => reject(new Error(`Port ${port} in use`)));

    // 5 minute timeout
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout — no callback received within 5 minutes'));
    }, 300_000);
  });
}

/**
 * Exchange authorization code for tokens.
 */
async function exchangeCode(code, codeVerifier, clientId, clientSecret, redirectUri) {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  return res.json();
}

/**
 * Fetch authenticated user's email address.
 */
async function getUserEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.email || null;
}

/**
 * Run the full OAuth consent flow.
 * @param {object} config — NHA config
 * @param {boolean} manual — force manual code-paste mode (for VMs/headless)
 */
export async function runAuthFlow(config, manual = false) {
  const clientId = config.google?.clientId || DEFAULT_CLIENT_ID;
  const clientSecret = config.google?.clientSecret || '';

  if (!clientId) {
    fail('Google OAuth client ID not configured.');
    info('');
    info('NHA does not ship a shared OAuth client (your data never goes through');
    info('our servers — Gmail/Calendar API calls go from your PC directly to');
    info('Google). You need a 3-minute one-time setup of your own OAuth client.');
    info('');
    info('STEPS:');
    info('  1. Open https://console.cloud.google.com/apis/credentials');
    info('  2. Click + CREATE CREDENTIALS → OAuth client ID');
    info('  3. Application type: "Desktop app", give it a name (e.g. "NHA local")');
    info('  4. Click CREATE. Google shows you Client ID + Client Secret.');
    info('  5. Enable the APIs you need:');
    info('     - Gmail API:   https://console.cloud.google.com/apis/library/gmail.googleapis.com');
    info('     - Calendar:    https://console.cloud.google.com/apis/library/calendar-json.googleapis.com');
    info('     - Drive:       https://console.cloud.google.com/apis/library/drive.googleapis.com');
    info('     - People API:  https://console.cloud.google.com/apis/library/people.googleapis.com');
    info('  6. Save the credentials in NHA:');
    info('     nha config set google-client-id YOUR_CLIENT_ID');
    info('     nha config set google-client-secret YOUR_CLIENT_SECRET');
    info('  7. Re-run: nha google auth');
    info('');
    info('Full guide with screenshots: https://nothumanallowed.com/docs/google');
    return false;
  }

  // Find available port (used for redirect_uri even in manual mode)
  let port = CALLBACK_PORTS[0];
  for (const p of CALLBACK_PORTS) {
    try {
      const srv = http.createServer();
      await new Promise((resolve, reject) => {
        srv.listen(p, '127.0.0.1', () => { srv.close(); resolve(true); });
        srv.on('error', () => reject());
      });
      port = p;
      break;
    } catch { continue; }
  }

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(32).toString('hex');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  const authUrlStr = authUrl.toString();

  try {
    let code;

    if (manual) {
      // Explicit manual mode
      code = await waitForManualCode(authUrlStr, state);
    } else {
      // Try to open browser — if it fails, auto-switch to manual mode
      info('Opening browser for Google authorization...');
      const browserOpened = openBrowser(authUrlStr);

      if (!browserOpened) {
        // Headless/VM detected — auto-switch to manual mode
        warn('No browser found. Switching to manual mode...');
        code = await waitForManualCode(authUrlStr, state);
      } else {
        // Browser opened — wait for local callback
        info('Waiting for authorization (5 min timeout)...\n');
        const result = await waitForCallback(state, port);
        code = result.code;
      }
    }

    info('Authorization code received. Exchanging for tokens...');
    const tokenData = await exchangeCode(code, verifier, clientId, clientSecret, redirectUri);
    const email = await getUserEmail(tokenData.access_token);

    const tokens = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in * 1000),
      scope: tokenData.scope,
      email: email || 'unknown',
    };

    saveTokens(tokens);
    ok(`Google account connected: ${email || 'unknown'}`);
    ok('Gmail + Calendar + Drive access granted.');
    info('Run "nha plan" to generate your first daily plan.');
    return true;
  } catch (err) {
    fail(err.message);
    return false;
  }
}

/**
 * Build an OAuth URL for the web UI flow.
 * The redirect_uri points back to the NHA web UI server so the callback
 * is received directly in the browser session (works across VMs/headless).
 *
 * @param {object} config
 * @param {string} redirectUri — e.g. http://192.168.1.45:3847/api/google/callback
 * @returns {{ url: string, verifier: string, state: string }}
 */
export function buildAuthUrl(config, redirectUri) {
  const clientId = config.google?.clientId || DEFAULT_CLIENT_ID;
  if (!clientId) throw new Error('Google client ID not configured. Run: nha config set google-client-id YOUR_ID');
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  return { url: authUrl.toString(), verifier, state };
}

/**
 * Exchange an auth code received by the web UI callback.
 */
export async function exchangeCodeFromUI(config, code, verifier, redirectUri) {
  const clientId = config.google?.clientId || DEFAULT_CLIENT_ID;
  const clientSecret = config.google?.clientSecret || '';
  const tokenData = await exchangeCode(code, verifier, clientId, clientSecret, redirectUri);
  const email = await getUserEmail(tokenData.access_token);
  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + (tokenData.expires_in * 1000),
    scope: tokenData.scope,
    email: email || 'unknown',
  };
  saveTokens(tokens);
  return { email: email || 'unknown' };
}

/**
 * Show connection status.
 */
export function showStatus() {
  const tokens = loadTokens();
  if (!tokens) {
    info('Not connected to Google. Run: nha google auth');
    return;
  }

  const expired = Date.now() >= tokens.expires_at;
  console.log(`\n  Google Account:  ${tokens.email || 'unknown'}`);
  console.log(`  Token Status:    ${expired ? '\x1b[0;31mexpired\x1b[0m' : '\x1b[0;32mactive\x1b[0m'}`);
  console.log(`  Expires:         ${new Date(tokens.expires_at).toLocaleString()}`);
  console.log(`  Scopes:          ${tokens.scope || 'unknown'}\n`);
}

/**
 * Revoke tokens and delete local storage.
 */
export async function revokeAuth() {
  const tokens = loadTokens();
  if (!tokens) {
    info('No Google tokens found.');
    return;
  }

  // Revoke at Google
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${tokens.access_token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch { /* best effort */ }

  deleteTokens();
  ok('Google account disconnected. Tokens revoked.');
}
