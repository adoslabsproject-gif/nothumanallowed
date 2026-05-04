/**
 * Google Drive API wrapper — zero dependencies.
 * All calls via native fetch to Drive REST API v3.
 * Auto-refreshes tokens on 401.
 */

import { getAccessToken } from './token-store.mjs';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

/** Authenticated fetch with auto-retry on 401 */
async function driveFetch(config, urlPath, options = {}) {
  const token = await getAccessToken(config);
  const url = urlPath.startsWith('http') ? urlPath : `${DRIVE_BASE}${urlPath}`;

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
    throw new Error(`Drive API ${res.status}: ${err}`);
  }

  return res.json();
}

/**
 * List recent files.
 * @param {object} config
 * @param {number} maxResults
 * @param {string} query — Drive search query (e.g., "mimeType='application/pdf'")
 * @returns {Promise<Array>}
 */
export async function listFiles(config, maxResults = 20, query = '') {
  const params = new URLSearchParams({
    pageSize: String(maxResults),
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink,owners,shared,starred)',
    orderBy: 'modifiedTime desc',
  });
  if (query) params.set('q', query);

  const data = await driveFetch(config, `/files?${params}`);
  return (data.files || []).map(parseFile);
}

/**
 * Search files by name or content.
 */
export async function searchFiles(config, searchTerm, maxResults = 20) {
  const q = `name contains '${searchTerm.replace(/'/g, "\\'")}'`;
  return listFiles(config, maxResults, q);
}

/**
 * Get file metadata.
 */
export async function getFile(config, fileId) {
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,size,modifiedTime,createdTime,webViewLink,webContentLink,iconLink,owners,shared,starred,description,parents',
  });
  const data = await driveFetch(config, `/files/${fileId}?${params}`);
  return parseFile(data);
}

/**
 * List files in a specific folder.
 */
export async function listFolder(config, folderId = 'root', maxResults = 30) {
  const q = `'${folderId}' in parents and trashed = false`;
  return listFiles(config, maxResults, q);
}

/**
 * Get storage quota.
 */
export async function getStorageQuota(config) {
  const data = await driveFetch(config, '/about?fields=storageQuota,user');
  const q = data.storageQuota || {};
  return {
    limit: formatBytes(parseInt(q.limit || '0')),
    usage: formatBytes(parseInt(q.usage || '0')),
    usageInDrive: formatBytes(parseInt(q.usageInDrive || '0')),
    usageInTrash: formatBytes(parseInt(q.usageInTrash || '0')),
    percentUsed: q.limit ? Math.round((parseInt(q.usage || '0') / parseInt(q.limit)) * 100) : 0,
    user: data.user?.displayName || '',
    email: data.user?.emailAddress || '',
  };
}

/**
 * List recently modified files.
 */
export async function getRecentFiles(config, maxResults = 10) {
  return listFiles(config, maxResults, 'modifiedTime > \'' + new Date(Date.now() - 7 * 86400000).toISOString() + '\'');
}

/**
 * List starred files.
 */
export async function getStarredFiles(config, maxResults = 20) {
  return listFiles(config, maxResults, 'starred = true');
}

/**
 * List shared with me.
 */
export async function getSharedFiles(config, maxResults = 20) {
  return listFiles(config, maxResults, 'sharedWithMe = true');
}

/**
 * Download file content as base64. For Google Docs/Sheets/Slides, exports as PDF.
 * For binary files, downloads raw content.
 * @param {object} config
 * @param {string} fileId
 * @returns {Promise<{base64: string, mimeType: string, name: string}>}
 */
export async function downloadFileContent(config, fileId) {
  const token = await getAccessToken(config);
  const meta = await getFile(config, fileId);

  let downloadUrl;
  let finalMime = meta.mimeType;

  // Google Workspace files need export
  if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
    const exportMime = 'application/pdf';
    downloadUrl = `${DRIVE_BASE}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`;
    finalMime = exportMime;
  } else {
    downloadUrl = `${DRIVE_BASE}/files/${fileId}?alt=media`;
  }

  const res = await fetch(downloadUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive download ${res.status}: ${err.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    base64: buffer.toString('base64'),
    mimeType: finalMime,
    name: meta.name,
    size: buffer.length,
  };
}

/**
 * Upload a file to Google Drive.
 * @param {object} config
 * @param {string} name — filename
 * @param {string|Buffer} content — file content (string for text, Buffer for binary)
 * @param {string} mimeType — e.g. 'text/plain', 'application/pdf'
 * @param {string} folderId — parent folder ID (default: root)
 * @returns {Promise<object>} uploaded file metadata
 */
export async function uploadFile(config, name, content, mimeType = 'text/plain', folderId = 'root') {
  const token = await getAccessToken(config);
  const metadata = {
    name,
    parents: [folderId],
  };

  // Multipart upload
  const boundary = '===NHA_UPLOAD_BOUNDARY===';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(content).toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive upload ${res.status}: ${err.slice(0, 200)}`);
  }

  return parseFile(await res.json());
}

/**
 * Update (overwrite) file content on Drive.
 */
export async function updateFileContent(config, fileId, content, mimeType = 'text/plain') {
  const token = await getAccessToken(config);
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,mimeType,size,webViewLink`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': mimeType,
    },
    body: content,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive update ${res.status}: ${err.slice(0, 200)}`);
  }

  return parseFile(await res.json());
}

/**
 * Delete a file (move to trash).
 */
export async function trashFile(config, fileId) {
  const token = await getAccessToken(config);
  const res = await fetch(`${DRIVE_BASE}/files/${fileId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trashed: true }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive trash ${res.status}: ${err.slice(0, 200)}`);
  }

  return { ok: true };
}

/**
 * Read text content of a file directly (for text files, code, docs).
 * For Google Docs, exports as plain text. For other text files, downloads raw.
 * @returns {Promise<string>} file content as text
 */
export async function readFileAsText(config, fileId) {
  const token = await getAccessToken(config);
  const meta = await getFile(config, fileId);

  let downloadUrl;

  // Google Workspace files need export
  if (meta.mimeType === 'application/vnd.google-apps.document') {
    downloadUrl = `${DRIVE_BASE}/files/${fileId}/export?mimeType=text/plain`;
  } else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
    downloadUrl = `${DRIVE_BASE}/files/${fileId}/export?mimeType=text/csv`;
  } else if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
    downloadUrl = `${DRIVE_BASE}/files/${fileId}/export?mimeType=text/plain`;
  } else {
    downloadUrl = `${DRIVE_BASE}/files/${fileId}?alt=media`;
  }

  const res = await fetch(downloadUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive read ${res.status}: ${err.slice(0, 200)}`);
  }

  return res.text();
}

/**
 * Create a folder on Drive.
 */
export async function createFolder(config, name, parentId = 'root') {
  return driveFetch(config, '/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

function parseFile(raw) {
  return {
    id: raw.id,
    name: raw.name || '(untitled)',
    mimeType: raw.mimeType || '',
    type: mimeToType(raw.mimeType || ''),
    size: raw.size ? formatBytes(parseInt(raw.size)) : '',
    modifiedTime: raw.modifiedTime || '',
    createdTime: raw.createdTime || '',
    webViewLink: raw.webViewLink || '',
    webContentLink: raw.webContentLink || '',
    iconLink: raw.iconLink || '',
    owner: raw.owners?.[0]?.displayName || '',
    shared: raw.shared || false,
    starred: raw.starred || false,
    description: raw.description || '',
  };
}

function mimeToType(mime) {
  if (mime.includes('folder')) return 'folder';
  if (mime.includes('document')) return 'doc';
  if (mime.includes('spreadsheet')) return 'sheet';
  if (mime.includes('presentation')) return 'slides';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('image')) return 'image';
  if (mime.includes('video')) return 'video';
  if (mime.includes('audio')) return 'audio';
  if (mime.includes('zip') || mime.includes('compressed')) return 'archive';
  if (mime.includes('text') || mime.includes('json') || mime.includes('xml')) return 'text';
  return 'file';
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
