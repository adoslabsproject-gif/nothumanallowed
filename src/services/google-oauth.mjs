/**
 * Google OAuth 2.0 with PKCE — browser-based consent flow.
 * Runs ephemeral local HTTP server for callback.
 * Zero dependencies — uses Node.js native http + crypto.
 */

import http from 'http';
import crypto from 'crypto';
import { execSync } from 'child_process';
import os from 'os';
import { saveTokens, loadTokens, deleteTokens } from './token-store.mjs';
import { info, ok, fail, warn } from '../ui.mjs';

// NHA published OAuth client (Desktop app type — client_id is not a secret)
const DEFAULT_CLIENT_ID = ''; // Will be set when Google Cloud project is verified
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
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
 */
function openBrowser(url) {
  const platform = os.platform();
  try {
    if (platform === 'darwin') execSync(`open "${url}"`);
    else if (platform === 'win32') execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {
    warn('Could not open browser automatically.');
    info(`Open this URL manually:\n\n  ${url}\n`);
  }
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
 */
export async function runAuthFlow(config) {
  const clientId = config.google?.clientId || DEFAULT_CLIENT_ID;
  const clientSecret = config.google?.clientSecret || '';

  if (!clientId) {
    fail('Google OAuth client ID not configured.');
    info('Get credentials from Google Cloud Console:');
    info('  1. Go to https://console.cloud.google.com/apis/credentials');
    info('  2. Create an OAuth 2.0 Client ID (Desktop app type)');
    info('  3. Enable Gmail API and Calendar API');
    info('  4. Run:');
    info('     nha config set google-client-id YOUR_CLIENT_ID');
    info('     nha config set google-client-secret YOUR_CLIENT_SECRET');
    info('  5. Run: nha google auth');
    return false;
  }

  // Find available port
  let port = 0;
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
  if (!port) {
    fail('No available port for OAuth callback (tried 19847-19851)');
    return false;
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

  info('Opening browser for Google authorization...');
  openBrowser(authUrl.toString());
  info('Waiting for authorization (5 min timeout)...\n');

  try {
    const { code } = await waitForCallback(state, port);
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
    ok('Gmail + Calendar access granted.');
    info('Run "nha plan" to generate your first daily plan.');
    return true;
  } catch (err) {
    fail(err.message);
    return false;
  }
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
