/**
 * Desktop + webhook notifications — zero dependencies.
 * macOS: osascript, Linux: notify-send, Webhooks: fetch POST
 */

import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { NHA_DIR } from '../constants.mjs';

const LOG_FILE = path.join(NHA_DIR, 'ops', 'daemon', 'notifications.log');

/**
 * Send a notification via all configured channels.
 * @param {string} title
 * @param {string} body
 * @param {object} config — NHA config
 */
export async function notify(title, body, config) {
  const ops = config.ops || {};
  const notifs = ops.notifications || {};

  // Desktop notification
  if (notifs.desktop !== false) {
    sendDesktop(title, body);
  }

  // Terminal log
  if (notifs.terminal !== false) {
    logToFile(title, body);
  }

  // Telegram webhook
  if (ops.webhooks?.telegram) {
    sendTelegram(ops.webhooks.telegram, title, body).catch(() => {});
  }

  // Discord webhook
  if (ops.webhooks?.discord) {
    sendDiscord(ops.webhooks.discord, title, body).catch(() => {});
  }
}

function sendDesktop(title, body) {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      const escaped = body.replace(/"/g, '\\"').replace(/'/g, "'").slice(0, 200);
      const escapedTitle = 'NHA: ' + title.replace(/"/g, '\\"');
      // Try terminal-notifier first (supports click-to-open)
      try {
        execSync(`which terminal-notifier`, { stdio: 'ignore' });
        execSync(`terminal-notifier -title "${escapedTitle}" -message "${escaped}" -open "http://127.0.0.1:3847" -appIcon "" -group nha 2>/dev/null`);
      } catch {
        // Fallback to osascript — use "NHA" as subtitle so click goes nowhere confusing
        execSync(`osascript -e 'display notification "${escaped}" with title "${escapedTitle}" subtitle "Open nha ui to see details"'`);
      }
    } else if (platform === 'linux') {
      execSync(`notify-send "NHA: ${title}" "${body.slice(0, 200)}"`);
    } else if (platform === 'win32') {
      execSync(`powershell -Command "New-BurntToastNotification -Text 'NHA: ${title}', '${body.slice(0, 200)}'" 2>NUL`);
    }
  } catch { /* non-fatal */ }
}

function logToFile(title, body) {
  const dir = path.dirname(LOG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${title}: ${body}\n`;
  fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });

  // Rotate if > 1MB
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 1_048_576) {
      const rotated = LOG_FILE + '.1';
      if (fs.existsSync(rotated)) fs.rmSync(rotated);
      fs.renameSync(LOG_FILE, rotated);
    }
  } catch {}
}

async function sendTelegram(config, title, body) {
  // config format: "botToken:chatId" or { botToken, chatId }
  let botToken, chatId;
  if (typeof config === 'string') {
    [botToken, chatId] = config.split(':');
  } else {
    botToken = config.botToken;
    chatId = config.chatId;
  }
  if (!botToken || !chatId) return;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `*NHA: ${title}*\n${body}`,
      parse_mode: 'Markdown',
    }),
  });
}

async function sendDiscord(webhookUrl, title, body) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `**NHA: ${title}**\n${body}`,
    }),
  });
}
