/**
 * PAO Background Daemon — watches Gmail + Calendar, triggers agents.
 *
 * Runs as detached child process. Polls every 5 min (mail), 15 min (calendar).
 * Generates daily plan at configured time. Sends notifications.
 *
 * WebSocket server on port 3848 broadcasts real-time events to connected
 * clients (nha ui dashboard, etc.) when new emails arrive or meetings approach.
 *
 * Proactive Intelligence Engine — unsolicited analysis:
 * - Email follow-up detector (24h unreplied)
 * - Meeting prep auto-trigger (2h before large meetings)
 * - Pattern detection (weekly analysis at summary time)
 * - Deadline tracker (9am + 5pm alerts)
 *
 * Message Responder — auto-responds to Telegram/Discord messages via agents.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { NHA_DIR, DAEMON_SCRIPT } from '../constants.mjs';
import { loadConfig } from '../config.mjs';
import { hasMailProvider, getUnreadImportant, getUpcomingEvents, getTodayEmails, listEvents } from './mail-router.mjs';
import { notify } from './notification.mjs';
import { callAgent } from './llm.mjs';
import { runPlanningPipeline } from './ops-pipeline.mjs';
import { getTasks, getWeekTasks } from './task-store.mjs';
import { startResponder, stopResponder, getResponderStatus, getAllTelegramChatIds } from './message-responder.mjs';
import { VERSION } from '../constants.mjs';

const DAEMON_DIR = path.join(NHA_DIR, 'ops', 'daemon');
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid');
const STATE_FILE = path.join(DAEMON_DIR, 'state.json');
const LOG_FILE = path.join(DAEMON_DIR, 'daemon.log');
const BRIEFS_DIR = path.join(NHA_DIR, 'ops', 'briefs');
const INSIGHTS_DIR = path.join(NHA_DIR, 'ops', 'insights');
const CRON_FILE = path.join(DAEMON_DIR, 'cron.json');
const HEARTBEAT_FILE = path.join(DAEMON_DIR, 'heartbeat.json');
const WS_PORT = 3848;

// ── Cron / Heartbeat Persistence ────────────────────────────────────────────

function loadCronJobs() {
  if (!fs.existsSync(CRON_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CRON_FILE, 'utf-8')); } catch { return []; }
}

function saveCronJobs(jobs) {
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  fs.writeFileSync(CRON_FILE, JSON.stringify(jobs, null, 2), { mode: 0o600 });
}

function loadHeartbeats() {
  if (!fs.existsSync(HEARTBEAT_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf-8')); } catch { return []; }
}

function saveHeartbeats(beats) {
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(beats, null, 2), { mode: 0o600 });
}

/**
 * Parse a human-readable schedule into a cron-like spec.
 * Supports:
 *   "every 5m" / "every 2h" / "every 30min"
 *   "every monday 9am" / "every friday 17:00"
 *   "every day 8:30" / "daily 9am"
 *   "every hour"
 *   "at 14:00" (once daily)
 *
 * Returns { type: 'interval'|'daily'|'weekly', intervalMs?, hour?, minute?, dayOfWeek? }
 */
function parseSchedule(schedule) {
  const s = schedule.toLowerCase().trim();

  // Interval: "every 5m", "every 2h", "every 30min", "every 1 hour"
  const intervalMatch = s.match(/every\s+(\d+)\s*(m(?:in(?:utes?)?)?|h(?:ours?)?|s(?:ec(?:onds?)?)?)/);
  if (intervalMatch) {
    const num = parseInt(intervalMatch[1]);
    const unit = intervalMatch[2][0]; // m, h, or s
    const ms = unit === 'h' ? num * 3_600_000 : unit === 'm' ? num * 60_000 : num * 1_000;
    return { type: 'interval', intervalMs: Math.max(ms, 60_000) }; // min 1 minute
  }

  // "every hour"
  if (s === 'every hour' || s === 'hourly') {
    return { type: 'interval', intervalMs: 3_600_000 };
  }

  // Weekly: "every monday 9am", "every friday 17:00"
  const weeklyMatch = s.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (weeklyMatch) {
    const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    let hour = parseInt(weeklyMatch[2]);
    const minute = parseInt(weeklyMatch[3] || '0');
    const ampm = weeklyMatch[4];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { type: 'weekly', dayOfWeek: days[weeklyMatch[1]], hour, minute };
  }

  // Daily: "every day 8:30", "daily 9am", "at 14:00"
  const dailyMatch = s.match(/(?:every\s*day|daily|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1]);
    const minute = parseInt(dailyMatch[2] || '0');
    const ampm = dailyMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { type: 'daily', hour, minute };
  }

  return null;
}

/**
 * Check if a cron job should run now (within the current minute).
 */
function shouldRunNow(spec, lastRun) {
  const now = new Date();

  if (spec.type === 'interval') {
    if (!lastRun) return true;
    return (now.getTime() - lastRun) >= spec.intervalMs;
  }

  if (spec.type === 'daily') {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const targetMinutes = spec.hour * 60 + spec.minute;
    // Run if we're in the right minute and haven't run today
    if (Math.abs(nowMinutes - targetMinutes) > 1) return false;
    if (lastRun) {
      const lastRunDate = new Date(lastRun);
      if (lastRunDate.toDateString() === now.toDateString()) return false;
    }
    return true;
  }

  if (spec.type === 'weekly') {
    if (now.getDay() !== spec.dayOfWeek) return false;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const targetMinutes = spec.hour * 60 + spec.minute;
    if (Math.abs(nowMinutes - targetMinutes) > 1) return false;
    if (lastRun) {
      const lastRunDate = new Date(lastRun);
      const daysDiff = (now.getTime() - lastRunDate.getTime()) / 86_400_000;
      if (daysDiff < 1) return false;
    }
    return true;
  }

  return false;
}

/**
 * Add a cron job. Returns the job object.
 */
export function addCronJob(schedule, prompt, options = {}) {
  const spec = parseSchedule(schedule);
  if (!spec) return { ok: false, error: `Cannot parse schedule: "${schedule}"` };

  const jobs = loadCronJobs();
  const job = {
    id: crypto.randomUUID(),
    schedule,
    spec,
    prompt,
    agent: options.agent || null,    // null = auto-route
    notify: options.notify !== false, // default: send notification
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRun: null,
    lastResult: null,
    runCount: 0,
  };
  jobs.push(job);
  saveCronJobs(jobs);

  // Notify daemon if running (it will pick up changes on next tick)
  if (isRunning()) {
    wsBroadcast({ type: 'cron_added', data: { id: job.id, schedule, prompt } });
  }

  return { ok: true, job };
}

/**
 * Remove a cron job by ID or index.
 */
export function removeCronJob(idOrIndex) {
  const jobs = loadCronJobs();
  let removed;
  if (typeof idOrIndex === 'number' || /^\d+$/.test(idOrIndex)) {
    const idx = parseInt(idOrIndex) - 1; // 1-based
    if (idx < 0 || idx >= jobs.length) return { ok: false, error: 'Invalid job index' };
    removed = jobs.splice(idx, 1)[0];
  } else {
    const idx = jobs.findIndex(j => j.id === idOrIndex);
    if (idx === -1) return { ok: false, error: 'Job not found' };
    removed = jobs.splice(idx, 1)[0];
  }
  saveCronJobs(jobs);
  return { ok: true, removed };
}

/**
 * List all cron jobs.
 */
export function listCronJobs() {
  return loadCronJobs();
}

/**
 * Add a heartbeat (recurring prompt at fixed interval).
 * Convenience wrapper over cron with interval spec.
 */
export function addHeartbeat(intervalStr, prompt, options = {}) {
  return addCronJob(`every ${intervalStr}`, prompt, options);
}

/**
 * Execute cron jobs that are due. Called from daemon loop.
 */
async function executeDueCronJobs(config) {
  const jobs = loadCronJobs();
  let changed = false;

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!shouldRunNow(job.spec, job.lastRun)) continue;

    log(`[Cron] Executing: "${job.prompt}" (schedule: ${job.schedule})`);

    try {
      const agent = job.agent || 'conductor';
      const result = await callAgent(config, agent, job.prompt);
      job.lastRun = Date.now();
      job.lastResult = result.slice(0, 500); // cap stored result
      job.runCount++;
      changed = true;

      log(`[Cron] Completed: "${job.prompt}" → ${result.slice(0, 100)}...`);

      // Broadcast result to connected clients
      wsBroadcast({
        type: 'cron_result',
        timestamp: new Date().toISOString(),
        data: { id: job.id, schedule: job.schedule, prompt: job.prompt, result: result.slice(0, 500) },
      });

      // Send notification if enabled
      if (job.notify) {
        await notify('Scheduled Task', `${job.prompt}\n\n${result.slice(0, 200)}`, config);
      }
    } catch (err) {
      log(`[Cron] Error executing "${job.prompt}": ${err.message}`);
      job.lastRun = Date.now();
      job.lastResult = `ERROR: ${err.message}`;
      job.runCount++;
      changed = true;
    }
  }

  if (changed) saveCronJobs(jobs);
}

// ── Daemon Control ─────────────────────────────────────────────────────────

/**
 * Check if daemon is running.
 */
export function isRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
  try {
    process.kill(pid, 0); // signal 0 = check if alive
    return true;
  } catch {
    // PID file stale — clean up
    fs.rmSync(PID_FILE, { force: true });
    return false;
  }
}

/**
 * Start the daemon as a detached background process.
 */
export function startDaemon() {
  if (isRunning()) {
    return { ok: false, message: 'Daemon already running' };
  }

  fs.mkdirSync(DAEMON_DIR, { recursive: true });

  // The daemon runs this same file with --daemon-loop flag
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [
    DAEMON_SCRIPT,
    '--daemon-loop',
  ], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, NHA_DAEMON: '1' },
  });

  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });
  fs.closeSync(logFd);

  return { ok: true, pid: child.pid };
}

/**
 * Stop the daemon.
 */
export function stopDaemon() {
  if (!fs.existsSync(PID_FILE)) {
    return { ok: false, message: 'No daemon running' };
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
  try {
    process.kill(pid, 'SIGTERM');
    fs.rmSync(PID_FILE, { force: true });
    return { ok: true, pid };
  } catch {
    fs.rmSync(PID_FILE, { force: true });
    return { ok: false, message: 'Daemon process not found (stale PID)' };
  }
}

/**
 * Get daemon status.
 */
export function getDaemonStatus() {
  const running = isRunning();
  let state = {};
  if (fs.existsSync(STATE_FILE)) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch {}
  }
  let pid = null;
  if (fs.existsSync(PID_FILE)) {
    pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
  }
  return { running, pid, ...state };
}

// ── WebSocket Server (RFC 6455, zero-dependency) ────────────────────────────

const wsClients = new Set();

/**
 * Minimal WebSocket handshake and frame implementation.
 * Implements just enough of RFC 6455 for text-frame broadcast.
 */
function startWebSocketServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, clients: wsClients.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC86C11B')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      '\r\n'
    );

    wsClients.add(socket);
    log(`WebSocket client connected (${wsClients.size} total)`);

    socket.on('data', (buf) => {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x08) { wsClients.delete(socket); socket.end(); return; }
      if (opcode === 0x09) {
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a;
        pong[1] = 0;
        socket.write(pong);
      }
    });

    socket.on('close', () => {
      wsClients.delete(socket);
      log(`WebSocket client disconnected (${wsClients.size} remaining)`);
    });

    socket.on('error', () => { wsClients.delete(socket); });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`WebSocket port ${WS_PORT} already in use — skipping WS server`);
      return;
    }
    log(`WebSocket server error: ${err.message}`);
  });

  server.listen(WS_PORT, '127.0.0.1', () => {
    log(`WebSocket server listening on 127.0.0.1:${WS_PORT}`);
  });

  return server;
}

/**
 * Encode a string into a WebSocket text frame (RFC 6455).
 */
function encodeWSFrame(text) {
  const data = Buffer.from(text, 'utf-8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

/**
 * Broadcast a JSON message to all connected WebSocket clients.
 */
function wsBroadcast(payload) {
  const frame = encodeWSFrame(JSON.stringify(payload));
  for (const socket of wsClients) {
    try { socket.write(frame); } catch { wsClients.delete(socket); }
  }
}

export { wsBroadcast, WS_PORT };

// ── Proactive Intelligence Engine ───────────────────────────────────────────

/**
 * Notification rate limiter: max 3 proactive notifications per hour.
 * Tracks timestamps of recent proactive notifications.
 */
const proactiveNotificationTimestamps = [];
const MAX_PROACTIVE_PER_HOUR = 3;

function canSendProactiveNotification() {
  const oneHourAgo = Date.now() - 3_600_000;
  // Purge stale entries
  while (proactiveNotificationTimestamps.length > 0 && proactiveNotificationTimestamps[0] < oneHourAgo) {
    proactiveNotificationTimestamps.shift();
  }
  return proactiveNotificationTimestamps.length < MAX_PROACTIVE_PER_HOUR;
}

function recordProactiveNotification() {
  proactiveNotificationTimestamps.push(Date.now());
}

async function proactiveNotify(title, body, config) {
  if (!canSendProactiveNotification()) {
    log(`[Proactive] Rate limited — skipping: ${title}`);
    return false;
  }
  recordProactiveNotification();
  await notify(title, body, config);
  wsBroadcast({
    type: 'proactive_insight',
    timestamp: new Date().toISOString(),
    data: { title, body },
  });
  return true;
}

/**
 * Email Follow-Up Detector
 *
 * Tracks emails that appear to need a reply (questions, requests, action items).
 * After 24 hours with no reply detected, generates a reminder.
 */
const emailFollowUpTracker = new Map(); // emailId -> { from, subject, receivedAt, reminded }

async function checkEmailFollowUps(config) {
  if (!hasMailProvider()) return;

  const proactiveConfig = config.ops?.proactive || {};
  if (proactiveConfig.emailFollowUp === false) return;

  try {
    const emails = await getUnreadImportant(config, 20);
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    // Register new emails that look like they need a reply
    for (const email of emails) {
      if (emailFollowUpTracker.has(email.id)) continue;

      // Simple heuristic: questions, requests, or emails from known senders
      const subject = (email.subject || '').toLowerCase();
      const snippet = (email.snippet || '').toLowerCase();
      const needsReply = subject.includes('?') ||
        snippet.includes('?') ||
        snippet.includes('please') ||
        snippet.includes('could you') ||
        snippet.includes('can you') ||
        snippet.includes('would you') ||
        snippet.includes('let me know') ||
        snippet.includes('get back to') ||
        snippet.includes('respond') ||
        snippet.includes('reply') ||
        snippet.includes('waiting for') ||
        snippet.includes('action required') ||
        email.isImportant;

      if (needsReply) {
        emailFollowUpTracker.set(email.id, {
          from: email.from,
          subject: email.subject,
          receivedAt: new Date(email.date || Date.now()).getTime(),
          reminded: false,
        });
      }
    }

    // Check for overdue follow-ups
    const overdueByFrom = new Map(); // from -> count
    for (const [id, entry] of emailFollowUpTracker) {
      if (entry.reminded) continue;
      if (now - entry.receivedAt < twentyFourHours) continue;

      entry.reminded = true;
      const fromName = entry.from.split('<')[0].trim() || entry.from;
      const count = (overdueByFrom.get(fromName) || 0) + 1;
      overdueByFrom.set(fromName, count);
    }

    // Generate grouped notifications
    for (const [fromName, count] of overdueByFrom) {
      const msg = count === 1
        ? `${fromName} sent you an email that may need a reply.`
        : `${fromName} sent you ${count} emails this week that may need replies.`;

      await proactiveNotify('Email Follow-Up', `${msg} Want me to draft a reply?`, config);
      log(`[Proactive] Email follow-up reminder: ${fromName} (${count} emails)`);
    }

    // Prune tracker (remove entries older than 7 days)
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    for (const [id, entry] of emailFollowUpTracker) {
      if (now - entry.receivedAt > sevenDays) {
        emailFollowUpTracker.delete(id);
      }
    }
  } catch (err) {
    log(`[Proactive] Email follow-up error: ${err.message}`);
  }
}

/**
 * Meeting Prep Auto-Trigger
 *
 * 2 hours before any meeting with >2 attendees, runs HERALD + SCHEHERAZADE
 * to generate a brief. Saves to ~/.nha/ops/briefs/<event-id>.json.
 */
const preparedMeetings = new Set(); // event IDs already prepped

async function checkMeetingPrep(config) {
  if (!hasMailProvider()) return;

  const proactiveConfig = config.ops?.proactive || {};
  if (proactiveConfig.meetingPrep === false) return;

  try {
    const upcoming = await getUpcomingEvents(config, 3); // next 3 hours
    const now = Date.now();

    for (const event of upcoming) {
      const eventStart = new Date(event.start).getTime();
      const minutesUntil = (eventStart - now) / 60_000;
      const eventId = event.id || `${event.summary}-${event.start}`;

      // Only prep meetings 90-150 min away with >2 attendees
      if (minutesUntil < 90 || minutesUntil > 150) continue;
      if (!event.attendees || event.attendees.length <= 2) continue;
      if (preparedMeetings.has(eventId)) continue;

      preparedMeetings.add(eventId);
      log(`[Proactive] Generating meeting brief: "${event.summary}" (${Math.round(minutesUntil)}min away)`);

      try {
        // HERALD: meeting context and logistics brief
        const heraldBrief = await callAgent(config, 'herald',
          `Prepare a comprehensive meeting brief.\n` +
          `Meeting: "${event.summary}"\n` +
          `Start: ${event.start}\n` +
          `Attendees (${event.attendees.length}): ${event.attendees.map(a => a.name || a.email).join(', ')}\n` +
          `Description: ${(event.description || 'No description').slice(0, 1000)}\n` +
          `Location: ${event.location || 'Not specified'}\n\n` +
          `Provide:\n1. Meeting purpose and expected outcomes\n2. Key attendees and their roles\n3. Suggested talking points\n4. Time management recommendations`
        );

        // SCHEHERAZADE: executive summary and notes template
        const scheherazadeBrief = await callAgent(config, 'scheherazade',
          `Based on this meeting context, create an executive preparation document.\n\n` +
          `Meeting: "${event.summary}"\n` +
          `Attendees: ${event.attendees.map(a => a.name || a.email).join(', ')}\n` +
          `Context from HERALD agent:\n${heraldBrief.slice(0, 2000)}\n\n` +
          `Create:\n1. One-paragraph executive summary\n2. Three key questions to ask\n3. Notes template with sections for decisions, action items, follow-ups`
        );

        // Save brief
        fs.mkdirSync(BRIEFS_DIR, { recursive: true });
        const briefData = {
          eventId,
          summary: event.summary,
          start: event.start,
          attendees: event.attendees,
          generatedAt: new Date().toISOString(),
          heraldBrief,
          scheherazadeBrief,
        };

        const safeId = eventId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
        fs.writeFileSync(
          path.join(BRIEFS_DIR, `${safeId}.json`),
          JSON.stringify(briefData, null, 2),
          { mode: 0o600 }
        );

        await proactiveNotify(
          'Meeting Brief Ready',
          `Brief for "${event.summary}" (${Math.round(minutesUntil)}min away) is ready.\n` +
          `${event.attendees.length} attendees. View at ~/.nha/ops/briefs/`,
          config
        );

        wsBroadcast({
          type: 'meeting_brief',
          timestamp: new Date().toISOString(),
          data: { eventId, summary: event.summary, minutesUntil: Math.round(minutesUntil) },
        });

        log(`[Proactive] Meeting brief generated for "${event.summary}"`);
      } catch (err) {
        log(`[Proactive] Meeting prep failed for "${event.summary}": ${err.message}`);
      }
    }

    // Prune old prepared meeting IDs (keep last 50)
    if (preparedMeetings.size > 50) {
      const arr = [...preparedMeetings];
      for (let i = 0; i < arr.length - 50; i++) {
        preparedMeetings.delete(arr[i]);
      }
    }
  } catch (err) {
    log(`[Proactive] Meeting prep error: ${err.message}`);
  }
}

/**
 * Pattern Detection (Weekly Analysis)
 *
 * Runs at summary time. ORACLE analyzes 7 days of tasks, email, and meetings
 * to find patterns and generate actionable insights.
 */
async function runPatternDetection(config) {
  const proactiveConfig = config.ops?.proactive || {};
  if (proactiveConfig.patterns === false) return;

  try {
    log('[Proactive] Running weekly pattern detection...');

    // Gather 7 days of task data
    const weekTasks = getWeekTasks();
    const taskSummary = weekTasks.map(day => {
      const total = day.tasks.length;
      const done = day.tasks.filter(t => t.status === 'done').length;
      const high = day.tasks.filter(t => t.priority === 'high' || t.priority === 'critical').length;
      return `${day.day} ${day.date}: ${total} tasks, ${done} completed, ${high} high-priority`;
    }).join('\n');

    // Gather email/calendar context if available
    let emailContext = 'Email data: not available';
    let calendarContext = 'Calendar data: not available';

    if (hasMailProvider()) {
      try {
        const emails = await getTodayEmails(config, 50);
        emailContext = `Email volume today: ${emails.length} emails received`;
      } catch {}

      try {
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const events = await listEvents(config, 'primary', weekAgo.toISOString(), now.toISOString());
        const cancelledCount = events.filter(e => e.status === 'cancelled').length;
        calendarContext = `Calendar this week: ${events.length} events total, ${cancelledCount} cancelled`;
      } catch {}
    }

    // ORACLE analysis
    const analysis = await callAgent(config, 'oracle',
      `Analyze this week's productivity patterns and generate actionable insights.\n\n` +
      `TASK DATA (last 7 days):\n${taskSummary}\n\n` +
      `${emailContext}\n${calendarContext}\n\n` +
      `Generate 2-3 concise, actionable insights based on patterns you detect.\n` +
      `Focus on: task completion trends, workload distribution, meeting load, potential bottlenecks.\n` +
      `Format each insight as: "[PATTERN] observation — [ACTION] suggestion"\n` +
      `Keep each insight to 1-2 sentences maximum.`
    );

    // Save insight
    fs.mkdirSync(INSIGHTS_DIR, { recursive: true });
    const todayStr = new Date().toISOString().split('T')[0];
    const insightData = {
      date: todayStr,
      generatedAt: new Date().toISOString(),
      analysis,
      taskSummary,
      emailContext,
      calendarContext,
    };

    fs.writeFileSync(
      path.join(INSIGHTS_DIR, `${todayStr}.json`),
      JSON.stringify(insightData, null, 2),
      { mode: 0o600 }
    );

    await proactiveNotify('Weekly Insights', analysis.slice(0, 300), config);

    wsBroadcast({
      type: 'pattern_insight',
      timestamp: new Date().toISOString(),
      data: { date: todayStr, analysis },
    });

    log(`[Proactive] Pattern detection complete — insight saved to ${todayStr}.json`);
  } catch (err) {
    log(`[Proactive] Pattern detection error: ${err.message}`);
  }
}

/**
 * Deadline Tracker
 *
 * At 9am: alerts about tasks due today.
 * At 5pm: alerts about tasks due tomorrow that haven't been started.
 */
async function checkDeadlines(config, currentTime) {
  const proactiveConfig = config.ops?.proactive || {};
  if (proactiveConfig.deadlines === false) return;

  const now = new Date();

  // 9:00 AM check — tasks due today
  if (currentTime === '09:00') {
    try {
      const todayStr = now.toISOString().split('T')[0];
      const tasks = getTasks(todayStr);
      const dueTodayPending = tasks.filter(t => t.status === 'pending' && t.due);

      if (dueTodayPending.length > 0) {
        const taskList = dueTodayPending
          .map(t => `  #${t.id}: ${t.description} (${t.priority})`)
          .join('\n');

        await proactiveNotify(
          'Tasks Due Today',
          `You have ${dueTodayPending.length} task${dueTodayPending.length > 1 ? 's' : ''} due today:\n${taskList}`,
          config
        );
        log(`[Proactive] Deadline alert: ${dueTodayPending.length} tasks due today`);
      }
    } catch (err) {
      log(`[Proactive] Deadline check (9am) error: ${err.message}`);
    }
  }

  // 5:00 PM check — tasks due tomorrow that haven't started
  if (currentTime === '17:00') {
    try {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];
      const tasks = getTasks(tomorrowStr);
      const notStarted = tasks.filter(t => t.status === 'pending');

      // Also check today's incomplete tasks
      const todayStr = now.toISOString().split('T')[0];
      const todayTasks = getTasks(todayStr);
      const todayIncomplete = todayTasks.filter(t => t.status === 'pending' && (t.priority === 'high' || t.priority === 'critical'));

      const messages = [];

      if (notStarted.length > 0) {
        messages.push(`${notStarted.length} task${notStarted.length > 1 ? 's' : ''} due tomorrow not yet started`);
      }

      if (todayIncomplete.length > 0) {
        const list = todayIncomplete
          .map(t => `#${t.id}: ${t.description}`)
          .join(', ');
        messages.push(`${todayIncomplete.length} high-priority task${todayIncomplete.length > 1 ? 's' : ''} still pending today: ${list}`);
      }

      if (messages.length > 0) {
        await proactiveNotify('Deadline Reminder', messages.join('\n'), config);
        log(`[Proactive] Deadline alert (5pm): ${messages.join('; ')}`);
      }
    } catch (err) {
      log(`[Proactive] Deadline check (5pm) error: ${err.message}`);
    }
  }
}

// ── Daemon Loop (runs in background process) ───────────────────────────────

function saveState(state) {
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function daemonLoop() {
  log('NHA PAO Daemon started');
  const config = loadConfig();

  // Start WebSocket server for real-time push notifications
  startWebSocketServer();

  // Start message responder if tokens are configured
  const responderResult = startResponder(config, log, wsBroadcast);
  if (responderResult.telegram) log('Message responder: Telegram active');
  if (responderResult.discord) log('Message responder: Discord active');

  // ── Auto-update check: every 24h, notify + restart if new npm version ──────
  // First check after 5 minutes (let things settle), then every 24h.
  // When a new version is found: notifies via Telegram, then does
  // `npm install -g nothumanallowed@latest` and restarts itself.
  let _lastNotifiedUpdateVersion = null;
  async function _checkAndAutoUpdate() {
    try {
      const res = await fetch('https://registry.npmjs.org/nothumanallowed/latest', {
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': 'application/json' },
      });
      const data = await res.json();
      const latest = data.version;
      const current = VERSION;

      // Compare semver
      const pa = current.split('.').map(Number);
      const pb = latest.split('.').map(Number);
      let updateAvailable = false;
      for (let i = 0; i < 3; i++) {
        if ((pb[i] || 0) > (pa[i] || 0)) { updateAvailable = true; break; }
        if ((pb[i] || 0) < (pa[i] || 0)) break;
      }

      if (!updateAvailable) return;
      if (_lastNotifiedUpdateVersion === latest) return;
      _lastNotifiedUpdateVersion = latest;

      log(`[AutoUpdate] New version ${latest} available (current: ${current}). Updating...`);

      // Notify via Telegram before restarting
      const tgToken = config.responder?.telegram?.token;
      if (tgToken) {
        const chatIds = getAllTelegramChatIds();
        const msg = `NHA v${latest} disponibile — aggiornamento automatico in corso...\nIl bot si riavvierà tra pochi secondi.`;
        for (const chatId of chatIds) {
          await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: parseInt(chatId, 10), text: msg }),
          }).catch(() => {});
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // npm install -g then restart
      await new Promise((resolve) => {
        const proc = spawn('npm', ['install', '-g', `nothumanallowed@${latest}`], { stdio: 'inherit' });
        proc.on('close', resolve);
      });

      log('[AutoUpdate] npm install complete. Restarting daemon...');
      // Exit — the parent process (startDaemon) will restart us, or the user will
      // The daemon is spawned detached so we just exit and the next `nha ops start` picks it up
      process.exit(0);
    } catch (err) {
      log(`[AutoUpdate] Check failed: ${err.message}`);
    }
  }

  setTimeout(() => {
    _checkAndAutoUpdate();
    setInterval(_checkAndAutoUpdate, 24 * 60 * 60 * 1000);
  }, 5 * 60 * 1000);

  const state = {
    startedAt: new Date().toISOString(),
    lastMailCheck: null,
    lastCalendarCheck: null,
    lastPlanGenerated: null,
    lastProactiveCheck: null,
    lastPatternDetection: null,
    responder: responderResult,
    proactive: {
      enabled: config.ops?.proactive?.enabled !== false,
      emailFollowUp: config.ops?.proactive?.emailFollowUp !== false,
      meetingPrep: config.ops?.proactive?.meetingPrep !== false,
      patterns: config.ops?.proactive?.patterns !== false,
      deadlines: config.ops?.proactive?.deadlines !== false,
    },
    wsPort: WS_PORT,
    errors: 0,
  };
  saveState(state);

  const MAIL_INTERVAL = config.ops?.pollIntervalMail || 300_000;     // 5 min
  const CAL_INTERVAL = config.ops?.pollIntervalCalendar || 900_000;  // 15 min
  const PROACTIVE_INTERVAL = 1_800_000;                               // 30 min
  const MEETING_ALERT = config.ops?.meetingAlertMinutes || 30;
  const PLAN_TIME = config.ops?.planTime || '07:00';
  const SUMMARY_TIME = config.ops?.summaryTime || '18:00';

  let lastMailCheck = 0;
  let lastCalCheck = 0;
  let lastProactiveCheck = 0;
  let todayPlanDone = false;
  let todayPatternDone = false;
  let knownEmailIds = new Set();

  const proactiveEnabled = config.ops?.proactive?.enabled !== false;

  // Graceful shutdown — stop responder on SIGTERM
  process.on('SIGTERM', () => {
    log('Received SIGTERM — shutting down');
    stopResponder();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('Received SIGINT — shutting down');
    stopResponder();
    process.exit(0);
  });

  // Main loop
  setInterval(async () => {
    const now = Date.now();

    // ── Mail check ─────────────────────────────────────────
    if (hasMailProvider() && now - lastMailCheck > MAIL_INTERVAL) {
      lastMailCheck = now;
      try {
        const emails = await getUnreadImportant(config, 10);
        const newEmails = emails.filter(e => !knownEmailIds.has(e.id));

        for (const email of newEmails) {
          knownEmailIds.add(email.id);

          // Broadcast new email event to WebSocket clients
          wsBroadcast({
            type: 'new_email',
            timestamp: new Date().toISOString(),
            data: {
              id: email.id,
              from: email.from,
              subject: email.subject,
              snippet: (email.snippet || '').slice(0, 120),
              isImportant: email.isImportant,
            },
          });

          // SABER quick scan — only for emails with suspicious URLs (not known domains)
          const suspiciousUrls = (email.urls || []).filter(u => {
            try {
              const host = new URL(u).hostname.toLowerCase();
              // Skip known legitimate domains
              const safe = ['google.com','accounts.google.com','paypal.com','paypal.it','apple.com','microsoft.com','github.com','linkedin.com','amazon.com','facebook.com','instagram.com','twitter.com','x.com','youtube.com','netflix.com','disneyplus.com','spotify.com'];
              return !safe.some(d => host === d || host.endsWith('.' + d));
            } catch { return true; } // malformed URL = suspicious
          });
          if (suspiciousUrls.length > 0) {
            try {
              const scanResult = await callAgent(config, 'saber',
                `Quick phishing scan. ONLY flag if there are CLEAR red flags (domain spoofing, credential harvesting URLs, mismatched sender/domain). Do NOT flag legitimate emails from real companies.\n\nFrom: "${email.from}"\nSubject: "${email.subject}"\nSuspicious URLs: ${suspiciousUrls.join(', ')}\n\nRespond ONLY: SAFE or FLAGGED with one-line reason. Default to SAFE unless clearly malicious.`
              );
              if (scanResult.toUpperCase().includes('FLAGGED')) {
                await notify('Security Alert', `Suspicious email from ${email.from}: ${email.subject}\n${scanResult}`, config);
                wsBroadcast({
                  type: 'security_alert',
                  timestamp: new Date().toISOString(),
                  data: { from: email.from, subject: email.subject, reason: scanResult },
                });
              }
            } catch { /* non-fatal */ }
          }

          // Notify about important new emails
          if (email.isImportant) {
            await notify('Important Email', `From: ${email.from}\n${email.subject}`, config);
          }
        }

        state.lastMailCheck = new Date().toISOString();
        saveState(state);
        log(`Mail check: ${emails.length} unread, ${newEmails.length} new`);
      } catch (err) {
        state.errors++;
        log(`Mail check error: ${err.message}`);
      }
    }

    // ── Calendar check ─────────────────────────────────────
    if (hasMailProvider() && now - lastCalCheck > CAL_INTERVAL) {
      lastCalCheck = now;
      try {
        const upcoming = await getUpcomingEvents(config, 1); // next 1 hour

        for (const event of upcoming) {
          const eventStart = new Date(event.start).getTime();
          const minutesUntil = (eventStart - now) / 60000;

          if (minutesUntil > 0 && minutesUntil <= MEETING_ALERT) {
            // Broadcast meeting alert to WebSocket clients
            wsBroadcast({
              type: 'meeting_alert',
              timestamp: new Date().toISOString(),
              data: {
                summary: event.summary,
                start: event.start,
                minutesUntil: Math.round(minutesUntil),
                location: event.location || null,
                hangoutLink: event.hangoutLink || null,
              },
            });

            // Generate quick brief with HERALD
            try {
              const brief = await callAgent(config, 'herald',
                `Meeting in ${Math.round(minutesUntil)} minutes: "${event.summary}"\nAttendees: ${event.attendees.map(a => a.name || a.email).join(', ')}\nDescription: ${event.description.slice(0, 500)}\n\nGenerate a 3-sentence brief.`
              );
              await notify(`Meeting in ${Math.round(minutesUntil)}min`, `${event.summary}\n${brief}`, config);
            } catch {
              await notify(`Meeting in ${Math.round(minutesUntil)}min`, event.summary, config);
            }
          }
        }

        state.lastCalendarCheck = new Date().toISOString();
        saveState(state);
        log(`Calendar check: ${upcoming.length} upcoming events`);
      } catch (err) {
        state.errors++;
        log(`Calendar check error: ${err.message}`);
      }
    }

    // ── Proactive Intelligence Engine ──────────────────────
    const nowTime = new Date();
    const currentTime = `${String(nowTime.getHours()).padStart(2, '0')}:${String(nowTime.getMinutes()).padStart(2, '0')}`;
    const todayStr = nowTime.toISOString().split('T')[0];

    if (proactiveEnabled && now - lastProactiveCheck > PROACTIVE_INTERVAL) {
      lastProactiveCheck = now;
      state.lastProactiveCheck = new Date().toISOString();
      saveState(state);

      log('[Proactive] Running proactive checks...');

      // Email follow-up detection
      await checkEmailFollowUps(config);

      // Meeting prep auto-trigger
      await checkMeetingPrep(config);

      // Deadline tracking (time-gated inside the function)
      await checkDeadlines(config, currentTime);
    }

    // ── Pattern detection (daily at summary time) ──────────
    if (proactiveEnabled && !todayPatternDone && currentTime >= SUMMARY_TIME &&
        currentTime < SUMMARY_TIME.replace(/:(\d+)/, (_, m) => ':' + String(Number(m) + 5).padStart(2, '0'))) {
      todayPatternDone = true;
      state.lastPatternDetection = new Date().toISOString();
      saveState(state);
      await runPatternDetection(config);
    }

    // ── Daily plan generation ──────────────────────────────
    if (!todayPlanDone && currentTime >= PLAN_TIME && currentTime < PLAN_TIME.replace(/:(\d+)/, (_, m) => ':' + String(Number(m) + 5).padStart(2, '0'))) {
      todayPlanDone = true;
      try {
        log('Generating daily plan...');
        await runPlanningPipeline(config, { date: todayStr, refresh: true });
        state.lastPlanGenerated = new Date().toISOString();
        saveState(state);
        await notify('Daily Plan Ready', `Your plan for ${todayStr} is ready. Run "nha plan --show" to view.`, config);
        wsBroadcast({
          type: 'plan_ready',
          timestamp: new Date().toISOString(),
          data: { date: todayStr },
        });
        log('Daily plan generated');
      } catch (err) {
        log(`Plan generation error: ${err.message}`);
      }
    }

    // ── User-defined Cron Jobs ────────────────────────────
    try {
      await executeDueCronJobs(config);
    } catch (err) {
      log(`[Cron] Execution error: ${err.message}`);
    }

    // Reset daily flags at midnight
    if (currentTime === '00:00') {
      todayPlanDone = false;
      todayPatternDone = false;
    }

  }, 60_000); // Check every 60 seconds
}

// ── Direct execution (daemon mode) ─────────────────────────────────────────
if (process.argv.includes('--daemon-loop')) {
  daemonLoop().catch(err => {
    console.error('Daemon fatal error:', err);
    process.exit(1);
  });
}
