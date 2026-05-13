/**
 * Google OAuth routes + Microsoft OAuth
 */

import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';

let _googleOAuthPending = null;

export function register(router) {
  router.post('/api/google/auth', async (req, res) => {
    try {
      const { buildAuthUrl } = await import('../../services/google-oauth.mjs');
      // Wipe out any cached refresh_token BEFORE starting a new flow.
      // Otherwise Google can return a fresh access_token with the OLD scopes
      // (using the still-valid refresh_token) and the user never gets the
      // new permissions even after re-authorizing.
      try {
        const { deleteTokens } = await import('../../services/token-store.mjs');
        deleteTokens('google');
      } catch {}
      const config = loadConfig();
      const host = req.headers['host'] || 'localhost:3847';
      const redirectUri = `http://${host}/api/google/callback`;
      const { url, verifier, state } = buildAuthUrl(config, redirectUri);
      _googleOAuthPending = { verifier, state, redirectUri };
      sendJSON(res, 200, { ok: true, url });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // GET /api/google/status — diagnostic: what scopes does the current token
  // actually have? Used by the Settings UI to highlight missing scopes.
  router.get('/api/google/status', async (_req, res) => {
    try {
      const { loadTokens } = await import('../../services/token-store.mjs');
      const tokens = loadTokens('google');
      if (!tokens) return sendJSON(res, 200, { authenticated: false });
      const scopeStr = tokens.scope || '';
      const scopes = scopeStr.split(/\s+/).filter(Boolean);
      const required = {
        'gmail.modify':         scopes.includes('https://www.googleapis.com/auth/gmail.modify'),
        'gmail.send':           scopes.includes('https://www.googleapis.com/auth/gmail.send'),
        'calendar.events':      scopes.includes('https://www.googleapis.com/auth/calendar.events'),
        'drive.readonly':       scopes.includes('https://www.googleapis.com/auth/drive.readonly'),
        'drive.file':           scopes.includes('https://www.googleapis.com/auth/drive.file'),
        'contacts':             scopes.includes('https://www.googleapis.com/auth/contacts'),
        'tasks':                scopes.includes('https://www.googleapis.com/auth/tasks'),
      };
      const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
      sendJSON(res, 200, {
        authenticated: true,
        email: tokens.email,
        scopes,
        scopeCheck: required,
        missing,
        canWriteDrive: required['drive.file'],
        expiresAt: tokens.expires_at,
      });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/google/callback', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !_googleOAuthPending || _googleOAuthPending.state !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>OAuth error: invalid state or missing code.</h2><p>Please try again from the NHA UI.</p></body></html>');
      return;
    }
    try {
      const { exchangeCodeFromUI } = await import('../../services/google-oauth.mjs');
      const config = loadConfig();
      const { email } = await exchangeCodeFromUI(config, code, _googleOAuthPending.verifier, _googleOAuthPending.redirectUri);
      _googleOAuthPending = null;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#fff"><h2 style="color:#22c55e">&#10003; Google Connected!</h2><p style="color:#aaa">Signed in as <strong>${email}</strong></p><p style="color:#aaa">You can close this tab and return to NHA.</p><script>setTimeout(function(){window.close()},3000)</script></body></html>`);
    } catch (e) {
      _googleOAuthPending = null;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#fff"><h2 style="color:#ef4444">&#10007; Error</h2><p style="color:#aaa">${e.message}</p></body></html>`);
    }
  });

  router.post('/api/microsoft/auth', async (req, res) => {
    try {
      const { buildMicrosoftAuthUrl } = await import('../../services/microsoft-oauth.mjs');
      const config = loadConfig();
      const host = req.headers['host'] || 'localhost:3847';
      const redirectUri = `http://${host}/api/microsoft/callback`;
      const { url, state } = buildMicrosoftAuthUrl(config, redirectUri);
      res._microsoftState = state;
      res._microsoftRedirectUri = redirectUri;
      sendJSON(res, 200, { ok: true, url });
    } catch (e) { sendError(res, 500, e.message); }
  });
}
