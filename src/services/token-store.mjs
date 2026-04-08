/**
 * Encrypted token storage — AES-256-GCM with machine-derived key.
 * Supports multiple providers (google, microsoft) via separate encrypted files.
 * Stores OAuth tokens at ~/.nha/ops/tokens-<provider>.enc
 * Legacy single-file (~/.nha/ops/tokens.enc) is treated as 'google' for backward compat.
 * Zero dependencies — uses Node.js native crypto.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NHA_DIR } from '../constants.mjs';

const OPS_DIR = path.join(NHA_DIR, 'ops');
const LEGACY_TOKENS_FILE = path.join(OPS_DIR, 'tokens.enc');

/** Get tokens file path for a given provider */
function getTokensFile(provider) {
  if (!provider || provider === 'google') {
    return LEGACY_TOKENS_FILE; // backward compatible — Google uses the original file
  }
  return path.join(OPS_DIR, `tokens-${provider}.enc`);
}

/** Derive encryption key from machine-specific fingerprint */
function deriveKey() {
  const fingerprint = os.hostname() + os.userInfo().username + os.homedir();
  return crypto.createHash('sha256').update(fingerprint).digest();
}

/** Encrypt JSON data with AES-256-GCM */
function encrypt(data) {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

/** Decrypt AES-256-GCM data back to JSON */
function decrypt(envelope) {
  const key = deriveKey();
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8'));
}

/**
 * Save OAuth tokens (encrypted).
 * @param {object} tokens — { access_token, refresh_token, expires_at, scope, email }
 * @param {string} provider — 'google' (default) or 'microsoft'
 */
export function saveTokens(tokens, provider) {
  fs.mkdirSync(OPS_DIR, { recursive: true });
  const file = getTokensFile(provider);
  const envelope = encrypt(tokens);
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2), { mode: 0o600 });
}

/**
 * Load OAuth tokens (decrypted).
 * @param {string} provider — 'google' (default) or 'microsoft'
 * @returns {object|null} tokens or null if not stored
 */
export function loadTokens(provider) {
  const file = getTokensFile(provider);
  if (!fs.existsSync(file)) return null;
  try {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return decrypt(envelope);
  } catch {
    return null;
  }
}

/**
 * Delete stored tokens.
 * @param {string} provider — 'google' (default) or 'microsoft'
 */
export function deleteTokens(provider) {
  const file = getTokensFile(provider);
  if (fs.existsSync(file)) fs.rmSync(file);
}

/**
 * Check if access token is expired (with 5-minute buffer).
 * @param {object} tokens
 * @returns {boolean}
 */
export function isExpired(tokens) {
  if (!tokens?.expires_at) return true;
  return Date.now() >= tokens.expires_at - 300_000;
}

/**
 * Refresh access token using refresh_token (Google-specific).
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} refreshToken
 * @returns {Promise<object>} new token set
 */
export async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: refreshToken, // Google doesn't always return a new refresh token
    expires_at: Date.now() + (data.expires_in * 1000),
    scope: data.scope,
  };
}

/**
 * Get a valid Google access token — refreshes automatically if expired.
 * @param {object} config — NHA config with google.clientId etc.
 * @returns {Promise<string>} access_token
 */
export async function getAccessToken(config) {
  let tokens = loadTokens('google');
  if (!tokens) throw new Error('Not authenticated. Run: nha google auth');

  if (isExpired(tokens)) {
    const clientId = config.google?.clientId;
    const clientSecret = config.google?.clientSecret || '';
    if (!clientId) throw new Error('Google client ID not configured');

    tokens = await refreshAccessToken(clientId, clientSecret, tokens.refresh_token);
    tokens.email = loadTokens('google')?.email; // preserve email
    saveTokens(tokens, 'google');
  }

  return tokens.access_token;
}

/**
 * Check which providers are currently authenticated.
 * @returns {{ google: boolean, microsoft: boolean }}
 */
export function getAuthenticatedProviders() {
  return {
    google: loadTokens('google') !== null,
    microsoft: loadTokens('microsoft') !== null,
  };
}
