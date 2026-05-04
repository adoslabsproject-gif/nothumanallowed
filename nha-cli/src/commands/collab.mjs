/**
 * nha collab — Alexandria E2E Encrypted Inter-Agent Communication
 *
 * Commands:
 *   nha collab create "name"     — create encrypted channel
 *   nha collab join <code>       — join channel with invite code
 *   nha collab send "message"    — encrypt and send
 *   nha collab read              — decrypt and show messages
 *   nha collab list              — list your channels
 *   nha collab members           — show channel members
 *   nha collab delete            — delete channel (creator only)
 *
 * Crypto: X25519 key exchange + AES-256-GCM
 * Identity: keypair stored in ~/.nha/collab/identity.json
 * Zero-knowledge: server sees only ciphertext
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { NHA_DIR, API_BASE } from '../constants.mjs';
import { info, ok, fail, warn, C, G, D, Y, R, NC, BOLD } from '../ui.mjs';

const COLLAB_DIR = path.join(NHA_DIR, 'collab');
const IDENTITY_FILE = path.join(COLLAB_DIR, 'identity.json');
const CHANNELS_FILE = path.join(COLLAB_DIR, 'channels.json');
const API = API_BASE + '/alexandria';

// ── Crypto Primitives ─────────────────────────────────────────────────────

/**
 * Generate X25519 keypair for Diffie-Hellman key exchange.
 */
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
    fingerprint: crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16),
  };
}

/**
 * Derive shared secret from my private key + their public key (X25519 ECDH).
 */
function deriveSharedSecret(myPrivateKeyB64, theirPublicKeyB64) {
  const myPrivate = crypto.createPrivateKey({
    key: Buffer.from(myPrivateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const theirPublic = crypto.createPublicKey({
    key: Buffer.from(theirPublicKeyB64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const shared = crypto.diffieHellman({
    privateKey: myPrivate,
    publicKey: theirPublic,
  });
  // Derive a 256-bit AES key from the shared secret
  return crypto.createHash('sha256').update(shared).digest();
}

/**
 * Encrypt a message with AES-256-GCM.
 */
function encrypt(plaintext, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString('base64'),
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
  };
}

/**
 * Decrypt a message with AES-256-GCM.
 */
function decrypt(ciphertextB64, nonceB64, key) {
  const nonce = Buffer.from(nonceB64, 'base64');
  const data = Buffer.from(ciphertextB64, 'base64');
  const tag = data.subarray(data.length - 16);
  const encrypted = data.subarray(0, data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf-8');
}

/**
 * Derive channel encryption key from channel ID + secret.
 * The secret is part of the invite code and NEVER sent to the server.
 * Without the secret, the server cannot decrypt messages.
 */
function deriveChannelKey(channelId, secret) {
  return crypto.createHash('sha256')
    .update('alexandria-e2e-key-v2')
    .update(channelId)
    .update(secret || '') // legacy channels without secret use empty string
    .digest();
}

// ── Identity Management ───────────────────────────────────────────────────

function loadIdentity() {
  if (!fs.existsSync(IDENTITY_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf-8')); } catch { return null; }
}

function saveIdentity(identity) {
  fs.mkdirSync(COLLAB_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), { mode: 0o600 });
}

function getOrCreateIdentity() {
  let id = loadIdentity();
  if (!id) {
    id = generateKeypair();
    // Use profile name from NHA config if available
    try {
      const cfgFile = path.join(NHA_DIR, 'config.json');
      if (fs.existsSync(cfgFile)) {
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
        id.displayName = cfg.profile?.name || `Agent-${id.fingerprint.slice(0, 6)}`;
      } else {
        id.displayName = `Agent-${id.fingerprint.slice(0, 6)}`;
      }
    } catch {
      id.displayName = `Agent-${id.fingerprint.slice(0, 6)}`;
    }
    id.createdAt = new Date().toISOString();
    saveIdentity(id);
    info(`Identity created: ${id.fingerprint}`);
  }
  return id;
}

// ── Channel Management ────────────────────────────────────────────────────

function loadChannels() {
  if (!fs.existsSync(CHANNELS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8')); } catch { return []; }
}

function saveChannels(channels) {
  fs.mkdirSync(COLLAB_DIR, { recursive: true });
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), { mode: 0o600 });
}

function getActiveChannel() {
  const channels = loadChannels();
  const active = channels.find(c => c.active);
  return active || channels[0] || null;
}

function setActiveChannel(channelId) {
  const channels = loadChannels();
  for (const ch of channels) ch.active = ch.id === channelId;
  saveChannels(channels);
}

// ── API Helpers ───────────────────────────────────────────────────────────

async function apiPost(endpoint, body) {
  const res = await fetch(API + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiGet(endpoint) {
  const res = await fetch(API + endpoint);
  return res.json();
}

async function apiDelete(endpoint, body) {
  const res = await fetch(API + endpoint, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Commands ──────────────────────────────────────────────────────────────

async function cmdCreate(args) {
  const name = args.join(' ') || 'Unnamed Channel';
  const identity = getOrCreateIdentity();

  // Generate a channel secret — this NEVER goes to the server
  // The invite code is channelId:secret — only people with the invite can decrypt
  const channelSecret = crypto.randomBytes(16).toString('hex');

  const result = await apiPost('/channels', {
    name: name,
    creatorFingerprint: identity.fingerprint,
    creatorPublicKey: identity.publicKey,
    creatorDisplayName: identity.displayName,
    ttlHours: 0,
    maxMessages: 5000,
  });

  if (result.error) { fail(result.error); return; }

  // The invite code includes the secret — server only knows the ID, not the secret
  const inviteCode = `${result.id}:${channelSecret}`;

  // Save channel locally WITH the secret
  const channels = loadChannels();
  channels.forEach(c => c.active = false);
  channels.push({
    id: result.id,
    secret: channelSecret, // stored locally, NEVER sent to server
    name,
    createdAt: result.createdAt,
    active: true,
    role: 'creator',
  });
  saveChannels(channels);

  console.log('');
  ok(`Channel created: ${name}`);
  console.log('');
  console.log(`  ${BOLD}Invite Code:${NC}  ${G}${inviteCode}${NC}`);
  console.log('');
  console.log(`  ${D}Share this code securely with collaborators.${NC}`);
  console.log(`  ${D}They join with: ${C}nha collab join ${inviteCode}${NC}`);
  console.log(`  ${R}The server CANNOT read your messages — the secret stays with you.${NC}`);
  console.log('');
}

async function cmdJoin(args) {
  const inviteCode = args[0];
  if (!inviteCode) { fail('Usage: nha collab join <invite-code>'); return; }

  // Parse invite code: channelId:secret or just channelId (legacy)
  const parts = inviteCode.split(':');
  const channelId = parts[0];
  const channelSecret = parts[1] || ''; // empty = legacy channel (less secure)

  const identity = getOrCreateIdentity();

  // Check if already joined
  const channels = loadChannels();
  if (channels.find(c => c.id === channelId)) {
    setActiveChannel(channelId);
    ok(`Already a member. Switched to this channel.`);
    return;
  }

  const result = await apiPost(`/channels/${channelId}/join`, {
    fingerprint: identity.fingerprint,
    publicKey: identity.publicKey,
    displayName: identity.displayName,
  });

  if (result.error) { fail(result.error); return; }

  // Get channel info
  const chInfo = await apiGet(`/channels/${channelId}`);

  channels.forEach(c => c.active = false);
  channels.push({
    id: channelId,
    secret: channelSecret, // stored locally, never sent to server
    name: chInfo.name || 'Unknown',
    createdAt: chInfo.createdAt,
    active: true,
    role: 'member',
  });
  saveChannels(channels);

  ok(`Joined channel: ${chInfo.name || channelId} (${result.members} members)`);
  if (channelSecret) {
    info('E2E encryption active — server cannot read your messages.');
  } else {
    warn('Legacy invite code (no secret). Messages use channel-ID-based key.');
  }
}

async function cmdSend(args) {
  const message = args.join(' ');
  if (!message) { fail('Usage: nha collab send "your message"'); return; }

  const identity = getOrCreateIdentity();
  const channel = getActiveChannel();
  if (!channel) { fail('No active channel. Create or join one first.'); return; }

  // Get channel members for key exchange
  const chInfo = await apiGet(`/channels/${channel.id}`);
  if (chInfo.error) { fail(chInfo.error); return; }

  // Channel key: derived from channel ID + secret (secret NEVER sent to server)
  // Only people with the invite code (id:secret) can derive this key
  const channelKey = deriveChannelKey(channel.id, channel.secret);

  const { nonce, ciphertext } = encrypt(message, channelKey);

  const result = await apiPost(`/channels/${channel.id}/messages`, {
    senderFingerprint: identity.fingerprint,
    nonce,
    ciphertext,
    type: 'text',
  });

  if (result.error) { fail(result.error); return; }
  ok(`Sent (encrypted) at ${result.timestamp}`);
}

async function cmdRead(args) {
  const identity = getOrCreateIdentity();
  const channel = getActiveChannel();
  if (!channel) { fail('No active channel. Create or join one first.'); return; }

  const showAll = args.includes('--all');
  const limit = showAll ? 9999 : 10; // default: last 10 messages
  const query = `?fp=${identity.fingerprint}&limit=${limit}`;
  const result = await apiGet(`/channels/${channel.id}/messages${query}`);
  if (result.error) { fail(result.error); return; }

  if (result.messages.length === 0) {
    info('No messages yet in this channel.');
    return;
  }

  // Derive channel key from ID + secret
  const channelKey = deriveChannelKey(channel.id, channel.secret);

  const msgs = result.messages.slice(-limit);
  const total = result.total || result.messages.length;
  const showing = msgs.length;
  console.log(`\n  ${BOLD}${channel.name}${NC} ${D}(showing ${showing}/${total} messages${showing < total ? ' — use --all for full history' : ''})${NC}\n`);

  for (const msg of msgs) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const sender = result.members?.find(m => m.fingerprint === msg.senderFingerprint);
    const senderName = sender?.displayName || msg.senderFingerprint.slice(0, 8);

    if (msg.type === 'system') {
      console.log(`  ${D}${time} — ${senderName} joined${NC}`);
      continue;
    }

    try {
      const plaintext = decrypt(msg.ciphertext, msg.nonce, channelKey);
      const isMe = msg.senderFingerprint === identity.fingerprint;
      const color = isMe ? G : C;
      console.log(`  ${D}${time}${NC} ${color}${senderName}${NC}: ${plaintext}`);
    } catch {
      console.log(`  ${D}${time}${NC} ${R}${senderName}${NC}: ${D}[cannot decrypt — key mismatch]${NC}`);
    }
  }
  console.log('');
}

async function cmdList() {
  const channels = loadChannels();
  if (channels.length === 0) {
    info('No channels. Create one: nha collab create "Project Name"');
    return;
  }

  console.log(`\n  ${BOLD}Your Channels (${channels.length})${NC}\n`);
  for (const ch of channels) {
    const active = ch.active ? `${G}●${NC}` : `${D}○${NC}`;
    console.log(`  ${active} ${ch.name} ${D}(${ch.role}, ${ch.id.slice(0, 8)}...)${NC}`);
  }
  console.log(`\n  ${D}Switch: nha collab switch <number>${NC}\n`);
}

async function cmdMembers() {
  const channel = getActiveChannel();
  if (!channel) { fail('No active channel.'); return; }

  const chInfo = await apiGet(`/channels/${channel.id}`);
  if (chInfo.error) { fail(chInfo.error); return; }

  console.log(`\n  ${BOLD}${channel.name}${NC} — ${chInfo.memberCount} members\n`);
  for (const m of chInfo.members) {
    const online = (Date.now() - new Date(m.lastSeen).getTime()) < 300_000;
    const status = online ? `${G}online${NC}` : `${D}${new Date(m.lastSeen).toLocaleString()}${NC}`;
    console.log(`  ${m.displayName || m.fingerprint.slice(0, 8)} — ${status}`);
  }
  console.log('');
}

async function cmdSwitch(args) {
  const channels = loadChannels();
  const idx = parseInt(args[0]) - 1;
  if (isNaN(idx) || idx < 0 || idx >= channels.length) {
    fail('Invalid channel number. Use: nha collab list');
    return;
  }
  channels.forEach(c => c.active = false);
  channels[idx].active = true;
  saveChannels(channels);
  ok(`Switched to: ${channels[idx].name}`);
}

async function cmdDelete() {
  const identity = getOrCreateIdentity();
  const channel = getActiveChannel();
  if (!channel) { fail('No active channel.'); return; }

  const result = await apiDelete(`/channels/${channel.id}`, {
    fingerprint: identity.fingerprint,
  });

  if (result.error) { fail(result.error); return; }

  const channels = loadChannels().filter(c => c.id !== channel.id);
  if (channels.length > 0) channels[0].active = true;
  saveChannels(channels);
  ok(`Channel deleted: ${channel.name}`);
}

async function cmdIdentity() {
  const identity = getOrCreateIdentity();
  console.log(`\n  ${BOLD}Your Identity${NC}\n`);
  console.log(`  Fingerprint:  ${G}${identity.fingerprint}${NC}`);
  console.log(`  Display Name: ${identity.displayName}`);
  console.log(`  Created:      ${identity.createdAt}`);
  console.log(`  Public Key:   ${D}${identity.publicKey.slice(0, 40)}...${NC}`);
  console.log(`\n  ${D}Keys stored in: ${IDENTITY_FILE}${NC}\n`);
}

// ── Main Router ───────────────────────────────────────────────────────────

export async function cmdCollab(args) {
  const sub = args[0] || 'help';
  const subArgs = args.slice(1);

  switch (sub) {
    case 'create': return cmdCreate(subArgs);
    case 'join': return cmdJoin(subArgs);
    case 'send': return cmdSend(subArgs);
    case 'read': return cmdRead(subArgs);
    case 'list': case 'ls': return cmdList();
    case 'members': return cmdMembers();
    case 'switch': return cmdSwitch(subArgs);
    case 'delete': return cmdDelete();
    case 'identity': case 'id': return cmdIdentity();
    case 'help': default:
      console.log(`\n  ${BOLD}${Y}Alexandria${NC} — E2E Encrypted Communication\n`);
      console.log(`  ${C}nha collab create "name"${NC}     Create encrypted channel`);
      console.log(`  ${C}nha collab join <code>${NC}       Join with invite code`);
      console.log(`  ${C}nha collab send "msg"${NC}        Encrypt and send`);
      console.log(`  ${C}nha collab read${NC}              Decrypt and show messages`);
      console.log(`  ${C}nha collab list${NC}              Your channels`);
      console.log(`  ${C}nha collab members${NC}           Show channel members`);
      console.log(`  ${C}nha collab switch <n>${NC}        Switch active channel`);
      console.log(`  ${C}nha collab delete${NC}            Delete channel`);
      console.log(`  ${C}nha collab identity${NC}          Show your keypair info`);
      console.log(`\n  ${D}All messages E2E encrypted (X25519 + AES-256-GCM).${NC}`);
      console.log(`  ${D}The server sees only ciphertext. No accounts needed.${NC}\n`);
  }
}
