/**
 * Google Tasks API wrapper — zero dependencies.
 * All calls via native fetch to Tasks REST API v1.
 * Auto-refreshes tokens on 401.
 */

import { getAccessToken } from './token-store.mjs';

const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';

/** Authenticated fetch with auto-retry on 401 */
async function tasksFetch(config, urlPath, options = {}) {
  const token = await getAccessToken(config);
  const url = urlPath.startsWith('http') ? urlPath : `${TASKS_BASE}${urlPath}`;

  let res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (res.status === 401) {
    const newToken = await getAccessToken(config);
    res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${newToken}`,
      },
    });
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tasks API ${res.status}: ${err}`);
  }

  // DELETE returns 204 No Content
  if (res.status === 204) return null;

  return res.json();
}

/**
 * List all task lists for the authenticated user.
 * @param {object} config
 * @returns {Promise<Array<{id: string, title: string, updated: string}>>}
 */
export async function listTaskLists(config) {
  const data = await tasksFetch(config, '/users/@me/lists');
  return (data.items || []).map(item => ({
    id: item.id,
    title: item.title || '(untitled)',
    updated: item.updated || '',
  }));
}

/**
 * List tasks in a task list.
 * @param {object} config
 * @param {string} taskListId — task list ID, defaults to '@default'
 * @returns {Promise<Array>}
 */
export async function listTasks(config, taskListId = '@default') {
  const params = new URLSearchParams({
    showCompleted: 'false',
    maxResults: '100',
  });

  const data = await tasksFetch(config, `/lists/${encodeURIComponent(taskListId)}/tasks?${params}`);
  return (data.items || []).map(item => parseTask(item, taskListId));
}

/**
 * Create a new task.
 * @param {object} config
 * @param {string} taskListId
 * @param {string} title
 * @param {string} [notes]
 * @param {string} [due] — RFC 3339 date-time string
 * @returns {Promise<object>}
 */
export async function createTask(config, taskListId, title, notes, due) {
  const body = { title };
  if (notes) body.notes = notes;
  if (due) body.due = due;

  const data = await tasksFetch(config, `/lists/${encodeURIComponent(taskListId)}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return parseTask(data, taskListId);
}

/**
 * Mark a task as completed.
 * @param {object} config
 * @param {string} taskListId
 * @param {string} taskId
 * @returns {Promise<object>}
 */
export async function completeTask(config, taskListId, taskId) {
  const data = await tasksFetch(
    config,
    `/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    },
  );

  return parseTask(data, taskListId);
}

/**
 * Delete a task.
 * @param {object} config
 * @param {string} taskListId
 * @param {string} taskId
 * @returns {Promise<void>}
 */
export async function deleteTask(config, taskListId, taskId) {
  await tasksFetch(
    config,
    `/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'DELETE' },
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function parseTask(raw, listId) {
  return {
    id: raw.id,
    title: raw.title || '',
    notes: raw.notes || '',
    status: raw.status || 'needsAction',
    due: raw.due || '',
    updated: raw.updated || '',
    listId: listId || '',
  };
}
