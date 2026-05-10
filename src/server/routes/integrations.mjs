/**
 * Third-party integrations — GitHub, Notion, Slack, Contacts, Birthdays, Reminders, Maps, Cron
 */

import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { NHA_DIR } from '../../constants.mjs';
import fs from 'fs';
import path from 'path';

export function register(router) {
  // ── GitHub ────────────────────────────────────────────────────────────

  router.get('/api/github/repos', async (_req, res) => {
    try {
      const { listUserRepos } = await import('../../services/github.mjs');
      const config = loadConfig();
      sendJSON(res, 200, { repos: await listUserRepos(config) });
    } catch (e) {
      if (e.message?.includes('token') || e.message?.includes('not configured')) return sendJSON(res, 200, { repos: [], authRequired: true });
      sendError(res, 500, e.message);
    }
  });

  router.get('/api/github', async (req, res) => {
    try {
      const { listNotificationsRaw } = await import('../../services/github.mjs');
      const config = loadConfig();
      const notifications = await listNotificationsRaw(config);
      sendJSON(res, 200, { notifications: Array.isArray(notifications) ? notifications : [] });
    } catch (e) {
      if (e.message?.includes('token') || e.message?.includes('not configured') || e.message?.includes('401')) {
        return sendJSON(res, 200, { notifications: [], error: 'GitHub token not configured or expired. Run: nha config set github-token YOUR_PAT' });
      }
      sendJSON(res, 200, { notifications: [], error: e.message });
    }
  });

  router.get('/api/github/issues', async (req, res) => {
    try {
      const { listIssues } = await import('../../services/github.mjs');
      const config = loadConfig();
      const url = new URL(req.url, 'http://localhost');
      sendJSON(res, 200, { issues: await listIssues(config, url.searchParams.get('repo')) });
    } catch (e) {
      if (e.message?.includes('token') || e.message?.includes('not configured')) return sendJSON(res, 200, { issues: [], authRequired: true });
      sendError(res, 500, e.message);
    }
  });

  router.get('/api/github/prs', async (req, res) => {
    try {
      const { listPRs } = await import('../../services/github.mjs');
      const config = loadConfig();
      const url = new URL(req.url, 'http://localhost');
      sendJSON(res, 200, { prs: await listPRs(config, url.searchParams.get('repo')) });
    } catch (e) {
      if (e.message?.includes('token') || e.message?.includes('not configured')) return sendJSON(res, 200, { prs: [], authRequired: true });
      sendError(res, 500, e.message);
    }
  });

  router.post('/api/github/mark-read', async (req, res) => {
    try {
      const { markNotificationsRead } = await import('../../services/github.mjs');
      const config = loadConfig();
      await markNotificationsRead(config);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Notion ────────────────────────────────────────────────────────────

  router.get('/api/notion/search', async (req, res) => {
    try {
      const { searchNotion } = await import('../../services/notion.mjs');
      const config = loadConfig();
      const url = new URL(req.url, 'http://localhost');
      sendJSON(res, 200, { results: await searchNotion(config, url.searchParams.get('q') || '') });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/notion/page', async (req, res) => {
    try {
      const { getNotionPage } = await import('../../services/notion.mjs');
      const config = loadConfig();
      const url = new URL(req.url, 'http://localhost');
      sendJSON(res, 200, { page: await getNotionPage(config, url.searchParams.get('id')) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Slack ─────────────────────────────────────────────────────────────

  router.get('/api/slack/channels', async (_req, res) => {
    try {
      const { listChannels } = await import('../../services/slack.mjs');
      const config = loadConfig();
      sendJSON(res, 200, { channels: await listChannels(config) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/slack/messages', async (req, res) => {
    try {
      const { getChannelMessages } = await import('../../services/slack.mjs');
      const config = loadConfig();
      const url = new URL(req.url, 'http://localhost');
      sendJSON(res, 200, { messages: await getChannelMessages(config, url.searchParams.get('channel')) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Contacts ──────────────────────────────────────────────────────────

  router.get('/api/contacts', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('q') || '';
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const config = loadConfig();
      if (q) {
        const { searchContacts } = await import('../../services/google-contacts.mjs');
        sendJSON(res, 200, { contacts: await searchContacts(config, q, limit) });
      } else {
        const { listContacts } = await import('../../services/google-contacts.mjs');
        sendJSON(res, 200, { contacts: await listContacts(config, limit) });
      }
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/contacts', async (req, res) => {
    try {
      const { createContact } = await import('../../services/google-contacts.mjs');
      const body = await parseBody(req);
      const config = loadConfig();
      sendJSON(res, 201, { contact: await createContact(config, body) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/contacts/update', async (req, res) => {
    try {
      const { updateContact } = await import('../../services/google-contacts.mjs');
      const body = await parseBody(req);
      const config = loadConfig();
      sendJSON(res, 200, { contact: await updateContact(config, body.resourceName, body) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/contacts/delete', async (req, res) => {
    try {
      const { deleteContact } = await import('../../services/google-contacts.mjs');
      const body = await parseBody(req);
      const config = loadConfig();
      await deleteContact(config, body.resourceName);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Birthdays ─────────────────────────────────────────────────────────

  const birthdaysFile = path.join(NHA_DIR, 'birthdays.json');
  const loadBirthdays = () => { try { return JSON.parse(fs.readFileSync(birthdaysFile, 'utf-8')); } catch { return []; } };
  const saveBirthdays = (b) => { fs.mkdirSync(NHA_DIR, { recursive: true }); fs.writeFileSync(birthdaysFile, JSON.stringify(b, null, 2)); };

  router.get('/api/birthdays', (_req, res) => {
    sendJSON(res, 200, { birthdays: loadBirthdays() });
  });

  router.post('/api/birthdays', async (req, res) => {
    try {
      const body = await parseBody(req);
      const list = loadBirthdays();
      const id = Date.now().toString(36);
      list.push({ id, ...body });
      saveBirthdays(list);
      sendJSON(res, 201, { birthday: { id, ...body } });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/birthdays/delete', async (req, res) => {
    try {
      const body = await parseBody(req);
      const list = loadBirthdays().filter(b => b.id !== body.id);
      saveBirthdays(list);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Cron jobs ─────────────────────────────────────────────────────────

  router.get('/api/cron', async (_req, res) => {
    try {
      const { listCronJobs } = await import('../../services/ops-daemon.mjs');
      sendJSON(res, 200, { jobs: listCronJobs() });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/cron', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { addCronJob, removeCronJob } = await import('../../services/ops-daemon.mjs');
      if (body.action === 'remove') { removeCronJob(body.id); return sendJSON(res, 200, { ok: true }); }
      const job = addCronJob(body);
      sendJSON(res, 201, { job });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Reminders ─────────────────────────────────────────────────────────

  const remindersFile = path.join(NHA_DIR, 'reminders.json');
  const loadReminders = () => { try { return JSON.parse(fs.readFileSync(remindersFile, 'utf-8')); } catch { return []; } };
  const saveReminders = (r) => { fs.mkdirSync(NHA_DIR, { recursive: true }); fs.writeFileSync(remindersFile, JSON.stringify(r, null, 2)); };

  router.get('/api/reminders', (_req, res) => {
    const now = Date.now();
    const reminders = loadReminders().map(r => ({ ...r, triggered: r.at && new Date(r.at).getTime() <= now }));
    sendJSON(res, 200, { reminders });
  });

  router.post('/api/reminders', async (req, res) => {
    try {
      const body = await parseBody(req);
      if (body.action === 'delete') {
        saveReminders(loadReminders().filter(r => r.id !== body.id));
        return sendJSON(res, 200, { ok: true });
      }
      if (body.action === 'snooze') {
        const mins = body.minutes || 10;
        const list = loadReminders().map(r => r.id === body.id ? { ...r, at: new Date(Date.now() + mins * 60_000).toISOString() } : r);
        saveReminders(list);
        return sendJSON(res, 200, { ok: true });
      }
      if (body.action === 'dismiss') {
        const list = loadReminders().map(r => r.id === body.id ? { ...r, dismissed: true } : r);
        saveReminders(list);
        return sendJSON(res, 200, { ok: true });
      }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const reminder = { id, text: body.text, at: body.at || null, repeat: body.repeat || null, dismissed: false, createdAt: new Date().toISOString() };
      const list = loadReminders();
      list.push(reminder);
      saveReminders(list);
      sendJSON(res, 201, { reminder });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Maps / Places ──────────────────────────────────────────────────────

  router.get('/api/maps', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('q') || '';
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      if (!q) return sendError(res, 400, 'Missing query parameter q');

      // Use Nominatim (free, no key required) for geocoding/search
      const base = 'https://nominatim.openstreetmap.org';
      const headers = { 'User-Agent': 'NHA-UI/1.0 (nothumanallowed.com)' };

      if (lat && lon) {
        // Nearby search: geocode nearby named places using overpass API approach via Nominatim
        const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lon}&format=json&limit=10&addressdetails=1`, { headers });
        const places = await r.json();
        return sendJSON(res, 200, { places: places.map(p => ({ id: p.place_id, name: p.display_name.split(',')[0], address: p.display_name, lat: parseFloat(p.lat), lon: parseFloat(p.lon), type: p.type, category: p.class })) });
      }

      const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}&format=json&limit=10&addressdetails=1`, { headers });
      const places = await r.json();
      sendJSON(res, 200, { places: places.map(p => ({ id: p.place_id, name: p.display_name.split(',')[0], address: p.display_name, lat: parseFloat(p.lat), lon: parseFloat(p.lon), type: p.type, category: p.class })) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Screen Capture ─────────────────────────────────────────────────────

  router.post('/api/screen/capture', async (_req, res) => {
    try {
      const { captureScreen } = await import('../../services/screen-capture.mjs');
      const result = captureScreen({ base64: true });
      if (!result.ok) return sendError(res, 500, result.error || 'Screenshot failed');
      sendJSON(res, 200, { ok: true, base64: result.base64, width: result.width, height: result.height });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/screen/status', async (_req, res) => {
    try {
      const { isScreenCaptureAvailable } = await import('../../services/screen-capture.mjs');
      sendJSON(res, 200, { available: isScreenCaptureAvailable(), platform: process.platform });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Slack send ────────────────────────────────────────────────────────

  router.post('/api/slack/send', async (req, res) => {
    try {
      const { sendMessage } = await import('../../services/slack.mjs');
      const body = await parseBody(req);
      const config = loadConfig();
      if (!body.channel || !body.text) return sendError(res, 400, 'channel and text required');
      await sendMessage(config, body.channel, body.text);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Notes full CRUD ───────────────────────────────────────────────────

  router.get('/api/notes/search', async (req, res) => {
    try {
      const { searchNotes } = await import('../../services/notes.mjs');
      const url = new URL(req.url, 'http://localhost');
      sendJSON(res, 200, { notes: searchNotes(url.searchParams.get('q') || '') });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get(/^\/api\/notes\/(?<id>[^/?]+)$/, async (req, res) => {
    try {
      const { getNote } = await import('../../services/notes.mjs');
      const note = getNote(req.params.id);
      if (!note) return sendError(res, 404, 'Note not found');
      sendJSON(res, 200, { note });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/notes/create', async (req, res) => {
    try {
      const { createNote } = await import('../../services/notes.mjs');
      const body = await parseBody(req);
      if (!body.title) return sendError(res, 400, 'title required');
      const note = createNote(body.title, body.content || '', body.tags || []);
      sendJSON(res, 201, { note });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/notes/update', async (req, res) => {
    try {
      const { updateNote } = await import('../../services/notes.mjs');
      const body = await parseBody(req);
      if (!body.id) return sendError(res, 400, 'id required');
      updateNote(body.id, body.title, body.content, body.tags);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/notes/delete', async (req, res) => {
    try {
      const { deleteNote } = await import('../../services/notes.mjs');
      const body = await parseBody(req);
      if (!body.id) return sendError(res, 400, 'id required');
      deleteNote(body.id);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Contacts — Google Birthdays ───────────────────────────────────────

  router.get('/api/contacts/birthdays', async (_req, res) => {
    try {
      const { getBirthdays } = await import('../../services/google-contacts.mjs');
      const config = loadConfig();
      sendJSON(res, 200, { birthdays: await getBirthdays(config) });
    } catch (e) {
      if (e.message?.includes('token') || e.message?.includes('auth')) {
        return sendJSON(res, 200, { birthdays: [], authRequired: true });
      }
      sendError(res, 500, e.message);
    }
  });

  // ── Microsoft To Do ───────────────────────────────────────────────────

  router.get('/api/mstodo', async (_req, res) => {
    try {
      const { listTasks } = await import('../../services/microsoft-todo.mjs');
      const config = loadConfig();
      const tasks = await listTasks(config, 'defaultList');
      sendJSON(res, 200, { tasks });
    } catch (e) {
      if (e.message?.includes('token') || e.message?.includes('auth') || e.message?.includes('Microsoft') || e.message?.includes('authenticated')) {
        return sendJSON(res, 200, { tasks: [], authRequired: true });
      }
      sendError(res, 500, e.message);
    }
  });

  router.post('/api/mstodo', async (req, res) => {
    try {
      const { createTask } = await import('../../services/microsoft-todo.mjs');
      const body = await parseBody(req);
      const config = loadConfig();
      if (!body.title) return sendError(res, 400, 'title required');
      const task = await createTask(config, body.listId || 'defaultList', body.title, body.body, body.dueDate, body.importance);
      sendJSON(res, 201, { task });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post(/^\/api\/mstodo\/(?<id>[^/?]+)\/complete$/, async (req, res) => {
    try {
      const { completeTask } = await import('../../services/microsoft-todo.mjs');
      const body = await parseBody(req);
      const config = loadConfig();
      const taskId = req.params?.id || req.url.match(/\/api\/mstodo\/([^/]+)\/complete/)?.[1];
      if (!taskId) return sendError(res, 400, 'task id required');
      const listId = body.listId || 'defaultList';
      const task = await completeTask(config, listId, taskId);
      sendJSON(res, 200, { task });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Connectors — workflow persistence ────────────────────────────────

  const workflowsFile = path.join(NHA_DIR, 'workflows.json');
  const loadWorkflows = () => { try { return JSON.parse(fs.readFileSync(workflowsFile, 'utf-8')); } catch { return []; } };
  const saveWorkflows = (w) => { fs.mkdirSync(NHA_DIR, { recursive: true }); fs.writeFileSync(workflowsFile, JSON.stringify(w, null, 2)); };

  router.get('/api/connectors/workflows', (_req, res) => {
    sendJSON(res, 200, { workflows: loadWorkflows() });
  });

  router.post('/api/connectors/workflows', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { action } = body;
      if (action === 'delete') {
        saveWorkflows(loadWorkflows().filter(w => w.id !== body.id));
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'toggle') {
        const updated = loadWorkflows().map(w => w.id === body.id ? { ...w, enabled: !w.enabled } : w);
        saveWorkflows(updated);
        return sendJSON(res, 200, { ok: true, workflows: updated });
      }
      // Upsert workflow
      const list = loadWorkflows();
      const idx = list.findIndex(w => w.id === body.id);
      if (idx >= 0) list[idx] = body;
      else list.push(body);
      saveWorkflows(list);
      sendJSON(res, 200, { ok: true, workflow: body });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Unread counts — sidebar badges ────────────────────────────────────

  router.get('/api/unread-counts', async (_req, res) => {
    try {
      const config = loadConfig();
      let gmailUnread = 0;
      let imapUnread = 0;
      let todayEvents = 0;

      // Gmail unread
      try {
        const { listMessages } = await import('../../services/mail-router.mjs');
        const emails = await listMessages(config, { folder: 'inbox' });
        gmailUnread = (Array.isArray(emails) ? emails : []).filter(e => e.isUnread).length;
      } catch { /* not connected */ }

      // IMAP unread
      try {
        const { listAccounts, getSystemLabel } = await import('../../services/email-db.mjs');
        const accounts = listAccounts();
        for (const acc of accounts) {
          const inbox = getSystemLabel(acc.id, 'inbox');
          imapUnread += inbox?.unreadCount ?? 0;
        }
      } catch { /* not configured */ }

      // Today events count
      try {
        const { getTodayEvents } = await import('../../services/mail-router.mjs');
        const events = await getTodayEvents(config);
        todayEvents = Array.isArray(events) ? events.length : 0;
      } catch { /* not connected */ }

      sendJSON(res, 200, { gmailUnread, imapUnread, emailUnread: gmailUnread + imapUnread, todayEvents });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Screenshots ───────────────────────────────────────────────────────

  router.get(/^\/api\/screenshots\/(.+)$/, (req, res) => {
    const name = req.url.match(/^\/api\/screenshots\/(.+)$/)?.[1];
    if (!name || name.includes('..') || !name.match(/\.(jpg|png|webp)$/)) {
      return sendError(res, 404, 'Not found');
    }
    const p = path.join(NHA_DIR, 'screenshots', name);
    if (!fs.existsSync(p)) return sendError(res, 404, 'Not found');
    const ext = path.extname(name);
    const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'image/jpeg';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    res.end(fs.readFileSync(p));
  });
}
