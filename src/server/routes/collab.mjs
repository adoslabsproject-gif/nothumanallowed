/**
 * Alexandria Collab routes — E2E encrypted messaging
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { NHA_DIR } from '../../constants.mjs';

const ALEX_API = 'https://nothumanallowed.com/api/v1/alexandria';
const collabDir = path.join(NHA_DIR, 'collab');
const idFile = path.join(collabDir, 'identity.json');
const chFile = path.join(collabDir, 'channels.json');

function getIdentity() {
  if (fs.existsSync(idFile)) return JSON.parse(fs.readFileSync(idFile, 'utf-8'));
  fs.mkdirSync(collabDir, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(NHA_DIR, 'config.json'), 'utf-8')); } catch { return {}; } })();
  const identity = {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
    fingerprint: crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16),
    displayName: config.profile?.name || 'User',
  };
  fs.writeFileSync(idFile, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

export function register(router) {
  router.get('/api/collab/channels', (_req, res) => {
    try {
      const identity = getIdentity();
      let channels = [];
      if (fs.existsSync(chFile)) try { channels = JSON.parse(fs.readFileSync(chFile, 'utf-8')); } catch {}
      sendJSON(res, 200, { channels, identity: { fingerprint: identity.fingerprint, displayName: identity.displayName } });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/collab/channels', async (req, res) => {
    try {
      const body = await parseBody(req);
      let channels = [];
      if (fs.existsSync(chFile)) try { channels = JSON.parse(fs.readFileSync(chFile, 'utf-8')); } catch {}
      if (!channels.find(c => c.id === body.id)) {
        channels.push({ id: body.id, name: body.name, active: true, role: body.role || 'member', createdAt: new Date().toISOString() });
        channels.forEach(c => { if (c.id !== body.id) c.active = false; });
        fs.mkdirSync(collabDir, { recursive: true });
        fs.writeFileSync(chFile, JSON.stringify(channels, null, 2), { mode: 0o600 });
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/collab/send', async (req, res) => {
    try {
      const body = await parseBody(req);
      const identity = getIdentity();
      const r = await fetch(`${ALEX_API}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, senderPublicKey: identity.publicKey, senderFingerprint: identity.fingerprint }),
      });
      const data = await r.json();
      sendJSON(res, r.ok ? 200 : 500, data);
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/collab/messages', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const channelId = url.searchParams.get('channelId');
      const since = url.searchParams.get('since') || '0';
      const r = await fetch(`${ALEX_API}/messages?channelId=${channelId}&since=${since}`);
      const data = await r.json();
      sendJSON(res, r.ok ? 200 : 500, data);
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/collab/create-channel', async (req, res) => {
    try {
      const body = await parseBody(req);
      const r = await fetch(`${ALEX_API}/create-channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      sendJSON(res, r.ok ? 200 : 500, data);
    } catch (e) { sendError(res, 500, e.message); }
  });
}
