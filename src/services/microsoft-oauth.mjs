/**
 * Microsoft OAuth 2.0 with PKCE — browser-based consent flow.
 * Uses Microsoft identity platform (login.microsoftonline.com).
 * Runs ephemeral local HTTP server for callback.
 * Zero dependencies — uses Node.js native http + crypto.
 */

import http from 'http';
import crypto from 'crypto';
import { execSync } from 'child_process';
import os from 'os';
import { saveTokens, loadTokens, deleteTokens } from './token-store.mjs';
import { info, ok, fail, warn } from '../ui.mjs';

const SCOPES = [
  'openid',
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Mail.Send',
  'Calendars.ReadWrite',
  'Tasks.ReadWrite',
  'Files.Read',
].join(' ');

const CALLBACK_PORTS = [19852, 19853, 19854, 19855, 19856];

const PROVIDER = 'microsoft';

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
      const errorDesc = url.searchParams.get('error_description');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Authorization failed</h2><p>${error}: ${errorDesc || ''}</p><p>You can close this tab.</p></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error} — ${errorDesc || ''}`));
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
          <p>Microsoft account linked successfully.</p>
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
 * Exchange authorization code for tokens via Microsoft identity platform.
 */
async function exchangeCode(code, codeVerifier, clientId, clientSecret, redirectUri, tenantId) {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  if (clientSecret) {
    params.set('client_secret', clientSecret);
  }

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
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
 * Refresh access token using refresh_token.
 */
export async function refreshMicrosoftToken(clientId, clientSecret, refreshToken, tenantId) {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  if (clientSecret) {
    params.set('client_secret', clientSecret);
  }

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Microsoft token refresh failed: ${err}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + (data.expires_in * 1000),
    scope: data.scope,
  };
}

/**
 * Fetch authenticated user's profile from Microsoft Graph.
 */
async function getUserProfile(accessToken) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Get a valid Microsoft access token — refreshes automatically if expired.
 * @param {object} config — NHA config with microsoft.clientId etc.
 * @returns {Promise<string>} access_token
 */
export async function getMicrosoftAccessToken(config) {
  let tokens = loadTokens(PROVIDER);
  if (!tokens) throw new Error('Not authenticated with Microsoft. Run: nha microsoft auth');

  const expired = Date.now() >= (tokens.expires_at || 0) - 300_000;
  if (expired) {
    const clientId = config.microsoft?.clientId;
    const clientSecret = config.microsoft?.clientSecret || '';
    const tenantId = config.microsoft?.tenantId || 'common';
    if (!clientId) throw new Error('Microsoft client ID not configured');

    const refreshed = await refreshMicrosoftToken(clientId, clientSecret, tokens.refresh_token, tenantId);
    tokens = {
      ...tokens,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
      scope: refreshed.scope,
    };
    saveTokens(tokens, PROVIDER);
  }

  return tokens.access_token;
}

/**
 * Run the full Microsoft OAuth consent flow.
 * @param {object} config — NHA config
 */
export async function runMicrosoftAuthFlow(config) {
  const clientId = config.microsoft?.clientId;
  const clientSecret = config.microsoft?.clientSecret || '';
  const tenantId = config.microsoft?.tenantId || 'common';

  if (!clientId) {
    fail('Microsoft OAuth client ID not configured.');
    info('Get credentials from Azure Portal:');
    info('  1. Go to https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps');
    info('  2. Register an application (Personal accounts or Org + Personal)');
    info('  3. Add a "Mobile and desktop" platform with redirect URI');
    info('     http://127.0.0.1:19852/callback');
    info('  4. Under API permissions, add: Mail.Read, Mail.Send, Calendars.ReadWrite, Tasks.ReadWrite, User.Read');
    info('  5. Run:');
    info('     nha config set microsoft-client-id YOUR_CLIENT_ID');
    info('     nha config set microsoft-client-secret YOUR_CLIENT_SECRET  (optional for public clients)');
    info('     nha config set microsoft-tenant common  (or your tenant ID)');
    info('  6. Run: nha microsoft auth');
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
    fail('No available port for OAuth callback (tried 19852-19856)');
    return false;
  }

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(32).toString('hex');

  const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('prompt', 'consent');

  info('Opening browser for Microsoft authorization...');
  openBrowser(authUrl.toString());
  info('Waiting for authorization (5 min timeout)...\n');

  try {
    const { code } = await waitForCallback(state, port);
    info('Authorization code received. Exchanging for tokens...');

    const tokenData = await exchangeCode(code, verifier, clientId, clientSecret, redirectUri, tenantId);
    const profile = await getUserProfile(tokenData.access_token);

    const tokens = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in * 1000),
      scope: tokenData.scope,
      email: profile?.mail || profile?.userPrincipalName || 'unknown',
      displayName: profile?.displayName || '',
    };

    saveTokens(tokens, PROVIDER);
    ok(`Microsoft account connected: ${tokens.email}`);
    ok('Outlook Mail + Calendar + Tasks access granted.');
    info('Run "nha plan" to generate your first daily plan.');
    return true;
  } catch (err) {
    fail(err.message);
    return false;
  }
}

/**
 * Show Microsoft connection status.
 */
export function showMicrosoftStatus() {
  const tokens = loadTokens(PROVIDER);
  if (!tokens) {
    info('Not connected to Microsoft. Run: nha microsoft auth');
    return;
  }

  const expired = Date.now() >= tokens.expires_at;
  console.log(`\n  Microsoft Account:  ${tokens.email || 'unknown'}`);
  if (tokens.displayName) console.log(`  Display Name:       ${tokens.displayName}`);
  console.log(`  Token Status:       ${expired ? '\x1b[0;31mexpired\x1b[0m' : '\x1b[0;32mactive\x1b[0m'}`);
  console.log(`  Expires:            ${new Date(tokens.expires_at).toLocaleString()}`);
  console.log(`  Scopes:             ${tokens.scope || 'unknown'}\n`);
}

/**
 * Revoke tokens and delete local storage.
 */
export async function revokeMicrosoftAuth() {
  const tokens = loadTokens(PROVIDER);
  if (!tokens) {
    info('No Microsoft tokens found.');
    return;
  }

  // Microsoft doesn't have a simple revoke endpoint like Google.
  // Best effort: sign out via logout URL (this invalidates the session in browser).
  // The refresh token will expire naturally. Local deletion is the primary action.
  deleteTokens(PROVIDER);
  ok('Microsoft account disconnected. Local tokens deleted.');
  info('To fully revoke access, visit: https://account.live.com/consent/Manage');
}
