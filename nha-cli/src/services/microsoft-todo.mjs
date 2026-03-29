/**
 * Microsoft To Do API wrapper via Microsoft Graph — zero dependencies.
 * All calls via native fetch to Microsoft Graph REST API.
 * Auto-refreshes tokens on 401.
 *
 * Provides task list and task management for daily planning integration.
 */

import { getMicrosoftAccessToken } from './microsoft-oauth.mjs';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Authenticated fetch with auto-retry on 401 */
async function graphFetch(config, urlPath, options = {}) {
  const token = await getMicrosoftAccessToken(config);
  const url = urlPath.startsWith('http') ? urlPath : `${GRAPH_BASE}${urlPath}`;

  let res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
    },
  });

  // Retry once on 401 (token may have expired between check and request)
  if (res.status === 401) {
    const newToken = await getMicrosoftAccessToken(config);
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
    throw new Error(`Microsoft Graph API ${res.status}: ${err}`);
  }

  // DELETE and some PATCH return 204 No Content
  if (res.status === 204) return null;

  return res.json();
}

/**
 * List all task lists for the user.
 * @param {object} config
 * @returns {Promise<Array<object>>} task lists
 */
export async function listTaskLists(config) {
  const data = await graphFetch(config, '/me/todo/lists');
  return (data.value || []).map(list => ({
    id: list.id,
    name: list.displayName || '(untitled)',
    isOwner: list.isOwner ?? true,
    isShared: list.isShared ?? false,
    wellknownListName: list.wellknownListName || '',
  }));
}

/**
 * Get the default ("Tasks") task list ID.
 * Falls back to the first list if no default is found.
 * @param {object} config
 * @returns {Promise<string>} list ID
 */
export async function getDefaultListId(config) {
  const lists = await listTaskLists(config);

  // Microsoft marks the default list with wellknownListName = 'defaultList'
  const defaultList = lists.find(l => l.wellknownListName === 'defaultList');
  if (defaultList) return defaultList.id;

  // Fallback: first list named "Tasks" or just the first list
  const tasksL = lists.find(l => l.name.toLowerCase() === 'tasks');
  if (tasksL) return tasksL.id;

  if (lists.length > 0) return lists[0].id;

  throw new Error('No task lists found in Microsoft To Do');
}

/**
 * List tasks in a specific task list. Excludes completed tasks by default.
 * @param {object} config
 * @param {string} listId — task list ID, or 'defaultList' to auto-resolve
 * @returns {Promise<Array<object>>} parsed tasks
 */
export async function listTasks(config, listId = 'defaultList') {
  const resolvedListId = listId === 'defaultList'
    ? await getDefaultListId(config)
    : listId;

  // Fetch the list name for context
  const lists = await listTaskLists(config);
  const listInfo = lists.find(l => l.id === resolvedListId);
  const listName = listInfo?.name || '';

  const params = new URLSearchParams({
    '$filter': "status ne 'completed'",
    '$orderby': 'importance desc,createdDateTime desc',
  });

  const data = await graphFetch(config, `/me/todo/lists/${encodeURIComponent(resolvedListId)}/tasks?${params}`);
  return (data.value || []).map(task => parseTask(task, resolvedListId, listName));
}

/**
 * Create a new task in a task list.
 * @param {object} config
 * @param {string} listId — task list ID, or 'defaultList' to auto-resolve
 * @param {string} title — task title (required)
 * @param {string} [body] — task body/notes (plain text)
 * @param {string} [dueDate] — ISO 8601 date string (e.g., '2026-03-30')
 * @param {string} [importance] — 'low', 'normal', or 'high' (default 'normal')
 * @returns {Promise<object>} created task
 */
export async function createTask(config, listId, title, body, dueDate, importance) {
  const resolvedListId = listId === 'defaultList'
    ? await getDefaultListId(config)
    : listId;

  const taskPayload = {
    title,
    importance: importance || 'normal',
  };

  if (body) {
    taskPayload.body = {
      contentType: 'text',
      content: body,
    };
  }

  if (dueDate) {
    // Microsoft To Do expects dueDateTime as { dateTime, timeZone }
    // Date-only: set time to midnight UTC
    const dateOnly = dueDate.includes('T') ? dueDate.split('T')[0] : dueDate;
    taskPayload.dueDateTime = {
      dateTime: `${dateOnly}T00:00:00.0000000`,
      timeZone: 'UTC',
    };
  }

  const data = await graphFetch(config, `/me/todo/lists/${encodeURIComponent(resolvedListId)}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(taskPayload),
  });

  // Fetch list name for the response
  const lists = await listTaskLists(config);
  const listInfo = lists.find(l => l.id === resolvedListId);

  return parseTask(data, resolvedListId, listInfo?.name || '');
}

/**
 * Mark a task as completed.
 * @param {object} config
 * @param {string} listId — task list ID
 * @param {string} taskId — task ID
 * @returns {Promise<object>} updated task
 */
export async function completeTask(config, listId, taskId) {
  const resolvedListId = listId === 'defaultList'
    ? await getDefaultListId(config)
    : listId;

  const data = await graphFetch(config, `/me/todo/lists/${encodeURIComponent(resolvedListId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'completed',
      completedDateTime: {
        dateTime: new Date().toISOString(),
        timeZone: 'UTC',
      },
    }),
  });

  if (!data) {
    // 204 response — return minimal confirmation
    return { id: taskId, status: 'completed', listId: resolvedListId };
  }

  const lists = await listTaskLists(config);
  const listInfo = lists.find(l => l.id === resolvedListId);

  return parseTask(data, resolvedListId, listInfo?.name || '');
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Parse Microsoft Graph todoTask to unified format.
 */
function parseTask(raw, listId, listName) {
  return {
    id: raw.id,
    title: raw.title || '(untitled)',
    body: raw.body?.content || '',
    status: raw.status || 'notStarted',
    importance: raw.importance || 'normal',
    dueDate: raw.dueDateTime?.dateTime
      ? raw.dueDateTime.dateTime.split('T')[0]
      : null,
    createdAt: raw.createdDateTime || '',
    completedAt: raw.completedDateTime?.dateTime || null,
    listId: listId || '',
    listName: listName || '',
  };
}
