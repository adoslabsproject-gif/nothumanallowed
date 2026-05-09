/**
 * Calendar + Tasks + Plan routes
 */

import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { getTodayEvents, getUpcomingEvents, createEvent, updateEvent, deleteEvent, getEventsForDate } from '../../services/mail-router.mjs';
import { getTasks, addTask, completeTask, getDayStats } from '../../services/task-store.mjs';
import { runPlanningPipeline } from '../../services/ops-pipeline.mjs';
import { NHA_DIR } from '../../constants.mjs';
import fs from 'fs';
import path from 'path';

export function register(router) {
  // ── Calendar ──────────────────────────────────────────────────────────

  router.get('/api/calendar', async (req, res) => {
    try {
      const config = loadConfig();
      const url = new URL(req.url, 'http://localhost');
      const date = url.searchParams.get('date');
      const events = date ? await getEventsForDate(config, date) : await getTodayEvents(config);
      sendJSON(res, 200, { events });
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('No mail provider') || msg.includes('not authenticated') || msg.includes('No Google') || msg.includes('token')) {
        return sendJSON(res, 200, { events: [], authRequired: true, error: msg });
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

  router.post('/api/calendar', async (req, res) => {
    try {
      const body = await parseBody(req);
      const config = loadConfig();
      if (body.action === 'update' && body.id) {
        const updated = await updateEvent(config, body.id, body);
        return sendJSON(res, 200, { event: updated });
      }
      if (body.action === 'delete' && body.id) {
        await deleteEvent(config, body.id);
        return sendJSON(res, 200, { ok: true });
      }
      const event = await createEvent(config, body);
      sendJSON(res, 201, { event });
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
