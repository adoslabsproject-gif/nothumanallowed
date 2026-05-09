/**
 * Tasks routes — local task store + Google Tasks
 * All task operations: CRUD, priority, move, bulk, week view, Google Tasks sync
 */

import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import {
  getTasks, addTask, completeTask, editTask, moveTask, deleteTask,
  clearTasks, editTaskPriority, getWeekTasks, bulkAddTasks, getDayStats,
} from '../../services/task-store.mjs';

export function register(router) {
  // GET /api/tasks?date=YYYY-MM-DD
  router.get('/api/tasks', (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const date = url.searchParams.get('date');
      const week = url.searchParams.get('week') === '1';
      if (week) return sendJSON(res, 200, { tasks: getWeekTasks() });
      const tasks = getTasks(date);
      sendJSON(res, 200, { tasks, stats: getDayStats(date) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // POST /api/tasks — add / complete / edit / move / delete / clear / bulk / priority
  router.post('/api/tasks', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { action } = body;

      if (action === 'complete') {
        completeTask(body.id, body.date);
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'edit') {
        editTask(body.id, body.description, body.date);
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'priority') {
        editTaskPriority(body.id, body.priority, body.date);
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'move') {
        moveTask(body.id, body.fromDate, body.toDate);
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'delete') {
        deleteTask(body.id, body.date);
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'clear') {
        clearTasks(body.mode || 'all', body.date);
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'bulk') {
        const tasks = bulkAddTasks(body.tasks, body.date);
        return sendJSON(res, 201, { tasks });
      }

      // Default: add task
      const task = addTask(body, body.date);
      sendJSON(res, 201, { task });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Google Tasks ─────────────────────────────────────────────────────

  router.get('/api/gtasks/lists', async (_req, res) => {
    try {
      const { listTaskLists } = await import('../../services/google-tasks.mjs');
      const config = loadConfig();
      sendJSON(res, 200, { lists: await listTaskLists(config) });
    } catch (e) {
      if (e.message?.includes('token') || e.message?.includes('auth')) {
        return sendJSON(res, 200, { lists: [], authRequired: true });
      }
      sendError(res, 500, e.message);
    }
  });

  router.get('/api/gtasks', async (req, res) => {
    try {
      const { listTasks } = await import('../../services/google-tasks.mjs');
      const config = loadConfig();
      const url = new URL(req.url, 'http://localhost');
      const listId = url.searchParams.get('listId') || '@default';
      sendJSON(res, 200, { tasks: await listTasks(config, listId) });
    } catch (e) {
      if (e.message?.includes('token') || e.message?.includes('auth')) {
        return sendJSON(res, 200, { tasks: [], authRequired: true });
      }
      sendError(res, 500, e.message);
    }
  });

  router.post('/api/gtasks', async (req, res) => {
    try {
      const body = await parseBody(req);
      const config = loadConfig();
      if (body.action === 'complete') {
        const { completeTask: gComplete } = await import('../../services/google-tasks.mjs');
        await gComplete(config, body.listId || '@default', body.taskId);
        return sendJSON(res, 200, { ok: true });
      }
      if (body.action === 'delete') {
        const { deleteTask: gDelete } = await import('../../services/google-tasks.mjs');
        await gDelete(config, body.listId || '@default', body.taskId);
        return sendJSON(res, 200, { ok: true });
      }
      const { createTask } = await import('../../services/google-tasks.mjs');
      const task = await createTask(config, body.listId || '@default', body.title, body.notes, body.due);
      sendJSON(res, 201, { task });
    } catch (e) { sendError(res, 500, e.message); }
  });
}
