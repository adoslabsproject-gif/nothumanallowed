/**
 * Drive routes — Google Drive + OneDrive + Microsoft Todo + Notes
 */

import { sendJSON, sendError, parseBody } from '../index.mjs';
import { loadConfig } from '../../config.mjs';

export function register(router) {
  // ── Google Drive ──────────────────────────────────────────────────────

  router.get('/api/drive', async (req, res) => {
    try {
      const { listFiles, searchFiles } = await import('../../services/google-drive.mjs');
      const config = loadConfig();
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('q') || '';
      const files = q ? await searchFiles(config, q) : await listFiles(config);
      sendJSON(res, 200, { files });
    } catch (e) { sendError(res, 500, e.message); }
  });

  const DRIVE_READ_RE = /^\/api\/drive\/read\/(.+)$/;
  const DRIVE_DL_RE   = /^\/api\/drive\/download\/(.+)$/;
  const DRIVE_UPD_RE  = /^\/api\/drive\/update\/(.+)$/;
  const DRIVE_DEL_RE  = /^\/api\/drive\/delete\/(.+)$/;

  router.get(DRIVE_READ_RE, async (req, res) => {
    try {
      const { readFileAsText } = await import('../../services/google-drive.mjs');
      const id = req.url.match(DRIVE_READ_RE)?.[1];
      const config = loadConfig();
      sendJSON(res, 200, { content: await readFileAsText(config, id) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get(DRIVE_DL_RE, async (req, res) => {
    try {
      const { downloadFileContent } = await import('../../services/google-drive.mjs');
      const id = req.url.match(DRIVE_DL_RE)?.[1];
      const config = loadConfig();
      const result = await downloadFileContent(config, id);
      res.writeHead(200, { 'Content-Type': result.mimeType || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${result.name || id}"` });
      res.end(result.data);
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post(DRIVE_UPD_RE, async (req, res) => {
    try {
      const { updateFileContent } = await import('../../services/google-drive.mjs');
      const id = req.url.match(DRIVE_UPD_RE)?.[1];
      const body = await parseBody(req);
      const config = loadConfig();
      await updateFileContent(config, id, body.content);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/drive/upload', async (req, res) => {
    try {
      const { uploadFile } = await import('../../services/google-drive.mjs');
      const body = await parseBody(req, 20_000_000);
      const config = loadConfig();
      const file = await uploadFile(config, body.name, body.content, body.mimeType, body.folderId);
      sendJSON(res, 201, { file });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post(DRIVE_DEL_RE, async (req, res) => {
    try {
      const { trashFile } = await import('../../services/google-drive.mjs');
      const id = req.url.match(DRIVE_DEL_RE)?.[1];
      const config = loadConfig();
      await trashFile(config, id);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/drive/quota', async (_req, res) => {
    try {
      const { getStorageQuota } = await import('../../services/google-drive.mjs');
      const config = loadConfig();
      sendJSON(res, 200, await getStorageQuota(config));
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/drive/recent', async (_req, res) => {
    try {
      const { getRecentFiles } = await import('../../services/google-drive.mjs');
      const config = loadConfig();
      sendJSON(res, 200, { files: await getRecentFiles(config) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/drive/starred', async (_req, res) => {
    try {
      const { getStarredFiles } = await import('../../services/google-drive.mjs');
      const config = loadConfig();
      sendJSON(res, 200, { files: await getStarredFiles(config) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.get('/api/drive/shared', async (_req, res) => {
    try {
      const { getSharedFiles } = await import('../../services/google-drive.mjs');
      const config = loadConfig();
      sendJSON(res, 200, { files: await getSharedFiles(config) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  const DRIVE_FOLDER_RE = /^\/api\/drive\/folder\/(.+)$/;
  router.get(DRIVE_FOLDER_RE, async (req, res) => {
    try {
      const { listFolder } = await import('../../services/google-drive.mjs');
      const folderId = req.url.match(DRIVE_FOLDER_RE)?.[1] || 'root';
      const config = loadConfig();
      sendJSON(res, 200, { files: await listFolder(config, folderId) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/drive/folder/create', async (req, res) => {
    try {
      const { createFolder } = await import('../../services/google-drive.mjs');
      const body = await parseBody(req);
      const config = loadConfig();
      if (!body.name) return sendError(res, 400, 'name required');
      const folder = await createFolder(config, body.name, body.parentId || 'root');
      sendJSON(res, 201, { folder });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── OneDrive ──────────────────────────────────────────────────────────

  router.get('/api/onedrive', async (_req, res) => {
    try {
      const { listOneDriveFiles } = await import('../../services/microsoft-drive.mjs');
      const config = loadConfig();
      sendJSON(res, 200, { files: await listOneDriveFiles(config) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Microsoft Todo ────────────────────────────────────────────────────

  router.get('/api/mstodo', async (_req, res) => {
    try {
      const { getMsTodoTasks } = await import('../../services/microsoft-todo.mjs');
      const config = loadConfig();
      sendJSON(res, 200, { tasks: await getMsTodoTasks(config) });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/mstodo', async (req, res) => {
    try {
      const body = await parseBody(req);
      const config = loadConfig();
      if (body.action === 'complete') {
        const { completeMsTodoTask } = await import('../../services/microsoft-todo.mjs');
        await completeMsTodoTask(config, body.listId, body.taskId);
        return sendJSON(res, 200, { ok: true });
      }
      const { addMsTodoTask } = await import('../../services/microsoft-todo.mjs');
      const task = await addMsTodoTask(config, body.listId, body.title);
      sendJSON(res, 201, { task });
    } catch (e) { sendError(res, 500, e.message); }
  });

  // ── Notes ─────────────────────────────────────────────────────────────

  router.get('/api/notes', async (_req, res) => {
    try {
      const { listNotes } = await import('../../services/notes.mjs');
      sendJSON(res, 200, { notes: listNotes() });
    } catch (e) { sendError(res, 500, e.message); }
  });

  router.post('/api/notes', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { saveNote, deleteNote } = await import('../../services/notes.mjs');
      if (body.action === 'delete') { deleteNote(body.id); return sendJSON(res, 200, { ok: true }); }
      const note = saveNote(body);
      sendJSON(res, 200, { note });
    } catch (e) { sendError(res, 500, e.message); }
  });
}
