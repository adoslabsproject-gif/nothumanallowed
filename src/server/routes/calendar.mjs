/**
 * Calendar + Tasks + Plan routes
 */

import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { getTodayEvents, getUpcomingEvents, createEvent, updateEvent, deleteEvent, getEventsForDate, listEvents, detectMailProvider } from '../../services/mail-router.mjs';
import { getTasks, addTask, completeTask, getDayStats } from '../../services/task-store.mjs';
import { runPlanningPipeline } from '../../services/ops-pipeline.mjs';
import { NHA_DIR } from '../../constants.mjs';
import fs from 'fs';
import path from 'path';

/**
 * Load all events for a given month from all calendars.
 * Returns { byDate: { "2026-05-01": [...], "2026-05-02": [...] } }
 */
async function getMonthEvents(config, monthStr) {
  // monthStr = "2026-05"
  const [y, m] = monthStr.split('-').map(Number);
  const startOfMonth = new Date(y, m - 1, 1);
  const endOfMonth = new Date(y, m, 1); // first day of next month

  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  // Load calendars list
  let listCalendars;
  if (provider === 'microsoft') {
    const ms = await import('../../services/microsoft-calendar.mjs');
    listCalendars = ms.listCalendars || (() => [{ id: 'primary', accessRole: 'owner' }]);
  } else {
    const gc = await import('../../services/google-calendar.mjs');
    listCalendars = gc.listCalendars;
  }

  const calendars = await listCalendars(config);
  const byDate = {};

  for (const cal of calendars) {
    if (cal.accessRole === 'freeBusyReader') continue;
    const isHolidayFeed = (cal.id || '').includes('#holiday@group');
    try {
      const events = await listEvents(config, cal.id, startOfMonth, endOfMonth);
      for (const e of events) {
        e.calendarName = cal.summary;
        e.calendarId = cal.id;
        e.readOnly = cal.accessRole === 'reader' || cal.accessRole === 'freeBusyReader';
        e._isHoliday = isHolidayFeed;

        // Determine which date this event belongs to
        const dateKey = (e.start || '').slice(0, 10);
        if (!dateKey) continue;
        if (!byDate[dateKey]) byDate[dateKey] = [];
        byDate[dateKey].push(e);
      }
    } catch { /* skip failed calendars */ }
  }

  // Sort events within each day and deduplicate holidays
  for (const dateKey of Object.keys(byDate)) {
    byDate[dateKey].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    const holidaySeen = new Set();
    byDate[dateKey] = byDate[dateKey].filter(e => {
      if (!e._isHoliday) return true;
      if (holidaySeen.has(dateKey)) return false;
      holidaySeen.add(dateKey);
      return true;
    });
  }

  return { byDate };
}

export function register(router) {
  // ── Calendar ──────────────────────────────────────────────────────────

  router.get('/api/calendar', async (req, res) => {
    try {
      const config = loadConfig();

      if (!config.google?.clientId && !config.google?.tokens?.access_token) {
        return sendJSON(res, 200, {
          events: [],
          byDate: {},
          authRequired: true,
          message: 'Google Calendar requires authentication. Setup OAuth to view events.',
          setupUrl: 'https://console.cloud.google.com/apis/credentials'
        });
      }

      const url = new URL(req.url, 'http://localhost');
      const month = url.searchParams.get('month');
      const date = url.searchParams.get('date');

      if (month) {
        // Month view: return all events grouped by date
        const result = await getMonthEvents(config, month);
        return sendJSON(res, 200, result);
      }

      if (date) {
        const events = await getEventsForDate(config, date);
        return sendJSON(res, 200, { events });
      }

      // Default: today's events
      const events = await getTodayEvents(config);
      sendJSON(res, 200, { events });
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('invalid_grant') || msg.includes('unauthorized') || msg.includes('token')) {
        return sendJSON(res, 200, {
          events: [], byDate: {},
          authRequired: true,
          message: 'Google OAuth expired. Please re-authenticate.',
          error: 'Authentication required'
        });
      }
      if (msg.includes('quota') || msg.includes('rate limit')) {
        return sendJSON(res, 429, {
          error: 'Google Calendar API rate limit exceeded. Try again later.',
          retryAfter: 300
        });
      }
      if (msg.includes('No mail provider') || msg.includes('not authenticated') || msg.includes('No Google')) {
        return sendJSON(res, 200, { events: [], byDate: {}, authRequired: true, error: msg });
      }
      sendError(res, 500, msg);
    }
  });

  router.get('/api/calendar/upcoming', async (req, res) => {
    try {
      const config = loadConfig();
      const url = new URL(req.url, 'http://localhost');
      const hours = parseInt(url.searchParams.get('hours') || '24', 10);
      const events = await getUpcomingEvents(config, hours);
      sendJSON(res, 200, { events });
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('No mail provider') || msg.includes('not authenticated') || msg.includes('token')) {
        return sendJSON(res, 200, { events: [], authRequired: true });
      }
      sendError(res, 500, msg);
    }
  });

  // Create a new event
  router.post('/api/calendar', async (req, res) => {
    try {
      const body = await parseBody(req);
      const config = loadConfig();
      const event = await createEvent(config, body);
      sendJSON(res, 201, { event });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // Update an existing event (PATCH)
  router.patch('/api/calendar/:calId/:eventId', async (req, res) => {
    try {
      const body = await parseBody(req);
      const config = loadConfig();
      const { calId, eventId } = req.params;

      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const patch = {};
      if (body.summary) patch.summary = body.summary;
      if (body.description !== undefined) patch.description = body.description;
      if (body.location !== undefined) patch.location = body.location;
      if (body.start) patch.start = { dateTime: body.start, timeZone: tz };
      if (body.end) patch.end = { dateTime: body.end, timeZone: tz };

      const updated = await updateEvent(config, calId, eventId, patch);
      sendJSON(res, 200, { event: updated });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // Delete an event
  router.delete('/api/calendar/:calId/:eventId', async (req, res) => {
    try {
      const config = loadConfig();
      const { calId, eventId } = req.params;
      await deleteEvent(config, calId, eventId);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Tasks ─────────────────────────────────────────────────────────────

  router.get('/api/tasks', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const date = url.searchParams.get('date');
      const tasks = getTasks(date);
      sendJSON(res, 200, { tasks, stats: getDayStats(date) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/tasks', async (req, res) => {
    try {
      const body = await parseBody(req);
      if (body.action === 'complete') {
        completeTask(body.id);
        return sendJSON(res, 200, { ok: true });
      }
      if (body.action === 'clear') {
        const { clearTasks } = await import('../../services/task-store.mjs');
        clearTasks(body.date);
        return sendJSON(res, 200, { ok: true });
      }
      const task = addTask(body);
      sendJSON(res, 201, { task });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Daily Plan ────────────────────────────────────────────────────────

  router.get('/api/plan', async (_req, res) => {
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const planFile = path.join(NHA_DIR, 'ops', 'plans', `${dateStr}.json`);
      if (fs.existsSync(planFile)) {
        sendJSON(res, 200, JSON.parse(fs.readFileSync(planFile, 'utf-8')));
      } else {
        sendJSON(res, 200, { plan: null });
      }
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/plan/refresh', async (_req, res) => {
    try {
      const config = loadConfig();
      const plan = await runPlanningPipeline(config);
      sendJSON(res, 200, { plan });
    } catch (e) { sendError(res, 500, e.message); }
  });
}
