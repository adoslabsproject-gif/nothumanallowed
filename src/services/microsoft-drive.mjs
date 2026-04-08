/**
 * OneDrive API wrapper via Microsoft Graph — zero dependencies.
 * All calls via native fetch to Microsoft Graph REST API.
 * Auto-refreshes tokens on 401.
 *
 * Output format matches google-drive.mjs parsed shape for unified consumption.
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

  return res.json();
}

/**
 * List files in a OneDrive folder.
 * @param {object} config
 * @param {number} maxResults — max items (default 20)
 * @param {string} folder — folder item ID or 'root' (default 'root')
 * @returns {Promise<Array<object>>} parsed files
 */
export async function listFiles(config, maxResults = 20, folder = 'root') {
  const params = new URLSearchParams({
    '$top': String(maxResults),
    '$orderby': 'lastModifiedDateTime desc',
    '$select': 'id,name,size,lastModifiedDateTime,webUrl,file,folder,createdBy,shared,parentReference',
  });

  const basePath = folder === 'root'
    ? '/me/drive/root/children'
    : `/me/drive/items/${encodeURIComponent(folder)}/children`;

  const data = await graphFetch(config, `${basePath}?${params}`);
  return (data.value || []).map(parseFile);
}

/**
 * Search files in OneDrive by query string.
 * @param {object} config
 * @param {string} query — search term
 * @param {number} maxResults
 * @returns {Promise<Array<object>>} parsed files
 */
export async function searchFiles(config, query, maxResults = 20) {
  const encodedQuery = encodeURIComponent(query);
  const params = new URLSearchParams({
    '$top': String(maxResults),
  });

  const data = await graphFetch(config, `/me/drive/root/search(q='${encodedQuery}')?${params}`);
  return (data.value || []).map(parseFile);
}

/**
 * Get OneDrive storage quota.
 * @param {object} config
 * @returns {Promise<object>} quota info
 */
export async function getStorageQuota(config) {
  const data = await graphFetch(config, '/me/drive?$select=quota,owner');
  const q = data.quota || {};

  const total = q.total || 0;
  const used = q.used || 0;
  const deleted = q.deleted || 0;
  const remaining = q.remaining || 0;

  return {
    limit: formatBytes(total),
    usage: formatBytes(used),
    usageInDrive: formatBytes(used - deleted),
    usageInTrash: formatBytes(deleted),
    remaining: formatBytes(remaining),
    percentUsed: total > 0 ? Math.round((used / total) * 100) : 0,
    user: data.owner?.user?.displayName || '',
    email: data.owner?.user?.email || '',
    state: q.state || 'normal',
  };
}

/**
 * Get recently accessed files.
 * @param {object} config
 * @param {number} maxResults
 * @returns {Promise<Array<object>>} parsed files
 */
export async function getRecentFiles(config, maxResults = 10) {
  const params = new URLSearchParams({
    '$top': String(maxResults),
  });

  const data = await graphFetch(config, `/me/drive/recent?${params}`);
  return (data.value || []).map(parseFile);
}

/**
 * Get files shared with the user.
 * @param {object} config
 * @param {number} maxResults
 * @returns {Promise<Array<object>>} parsed files
 */
export async function getSharedFiles(config, maxResults = 20) {
  const params = new URLSearchParams({
    '$top': String(maxResults),
  });

  const data = await graphFetch(config, `/me/drive/sharedWithMe?${params}`);
  return (data.value || []).map(parseFile);
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Parse Microsoft Graph drive item to unified format matching google-drive.mjs shape.
 */
function parseFile(raw) {
  const isFolder = !!raw.folder;
  const mimeType = raw.file?.mimeType || (isFolder ? 'application/vnd.ms-folder' : '');

  return {
    id: raw.id,
    name: raw.name || '(untitled)',
    mimeType,
    type: isFolder ? 'folder' : mimeToType(mimeType),
    size: raw.size != null ? formatBytes(raw.size) : '',
    modifiedTime: raw.lastModifiedDateTime || '',
    webViewLink: raw.webUrl || '',
    owner: raw.createdBy?.user?.displayName || '',
    shared: !!raw.shared,
  };
}

function mimeToType(mime) {
  if (!mime) return 'file';
  if (mime.includes('folder')) return 'folder';
  if (mime.includes('document') || mime.includes('wordprocessing')) return 'doc';
  if (mime.includes('spreadsheet') || mime.includes('ms-excel')) return 'sheet';
  if (mime.includes('presentation') || mime.includes('ms-powerpoint')) return 'slides';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('image')) return 'image';
  if (mime.includes('video')) return 'video';
  if (mime.includes('audio')) return 'audio';
  if (mime.includes('zip') || mime.includes('compressed')) return 'archive';
  if (mime.includes('text') || mime.includes('json') || mime.includes('xml')) return 'text';
  return 'file';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
