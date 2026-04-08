/**
 * GitHub API integration — zero dependencies.
 * Uses GitHub REST API v3 with Personal Access Token (PAT) authentication.
 * Token stored in config.github.token or via `nha config set github-token`.
 */

const GITHUB_API = 'https://api.github.com';

/**
 * Authenticated fetch to GitHub API.
 */
async function ghFetch(config, urlPath, options = {}) {
  const token = config.github?.token;
  if (!token) throw new Error('GitHub token not configured. Run: nha config set github-token YOUR_PAT');

  const url = urlPath.startsWith('http') ? urlPath : `${GITHUB_API}${urlPath}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${res.status}: ${err.slice(0, 200)}`);
  }

  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * List issues for a repository.
 * @returns {Promise<string>} formatted result
 */
export async function listIssues(config, repo, state = 'open', maxResults = 10) {
  if (!repo) return 'Repository required (e.g. "owner/repo").';

  const data = await ghFetch(config, `/repos/${repo}/issues?state=${state}&per_page=${maxResults}&sort=updated&direction=desc`);
  // Filter out PRs (GitHub API returns PRs as issues too)
  const issues = data.filter(i => !i.pull_request);

  if (issues.length === 0) return `No ${state} issues found in ${repo}.`;

  return issues.map((issue, i) => {
    const labels = issue.labels.map(l => l.name).join(', ');
    const assignee = issue.assignee ? ` → ${issue.assignee.login}` : '';
    return `${i + 1}. #${issue.number} ${issue.title}${assignee}${labels ? ` [${labels}]` : ''} (${issue.updated_at.split('T')[0]})`;
  }).join('\n');
}

/**
 * List pull requests for a repository.
 * @returns {Promise<string>} formatted result
 */
export async function listPRs(config, repo, state = 'open', maxResults = 10) {
  if (!repo) return 'Repository required (e.g. "owner/repo").';

  const data = await ghFetch(config, `/repos/${repo}/pulls?state=${state}&per_page=${maxResults}&sort=updated&direction=desc`);

  if (data.length === 0) return `No ${state} pull requests found in ${repo}.`;

  return data.map((pr, i) => {
    const reviewers = pr.requested_reviewers?.map(r => r.login).join(', ') || '';
    const draft = pr.draft ? ' [DRAFT]' : '';
    return `${i + 1}. #${pr.number} ${pr.title}${draft} by ${pr.user.login}${reviewers ? ` (reviewers: ${reviewers})` : ''} (${pr.updated_at.split('T')[0]})`;
  }).join('\n');
}

/**
 * List GitHub notifications.
 * @returns {Promise<string>} formatted result
 */
export async function listNotifications(config, maxResults = 10) {
  const data = await ghFetch(config, `/notifications?per_page=${maxResults}`);

  if (data.length === 0) return 'No unread notifications.';

  return data.map((n, i) => {
    const repo = n.repository?.full_name || '';
    const reason = n.reason || '';
    return `${i + 1}. [${repo}] ${n.subject.type}: ${n.subject.title} (${reason})`;
  }).join('\n');
}

/**
 * Create an issue on a repository.
 * @returns {Promise<string>} formatted result
 */
export async function createIssue(config, repo, title, body = '', labels = []) {
  if (!repo) return 'Repository required (e.g. "owner/repo").';
  if (!title) return 'Issue title required.';

  const payload = { title, body };
  if (labels.length > 0) payload.labels = labels;

  const issue = await ghFetch(config, `/repos/${repo}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return `Issue #${issue.number} created: "${issue.title}" — ${issue.html_url}`;
}

// ── Raw JSON functions for UI (structured data, not text) ──────────────

/**
 * List notifications as structured JSON for the web UI.
 */
export async function listNotificationsRaw(config, maxResults = 15) {
  const data = await ghFetch(config, `/notifications?per_page=${maxResults}`);
  return (Array.isArray(data) ? data : []).map(n => ({
    id: n.id,
    repo: n.repository?.full_name || '',
    type: n.subject?.type || '',
    title: n.subject?.title || '',
    reason: n.reason || '',
    url: n.subject?.url ? buildHtmlUrl(n.subject.url, n.subject.type) : '',
    updated: n.updated_at?.split('T')[0] || '',
  }));
}

/**
 * List issues as structured JSON for the web UI.
 */
export async function listIssuesRaw(config, repo, state = 'open', maxResults = 15) {
  if (!repo) return [];
  const data = await ghFetch(config, `/repos/${repo}/issues?state=${state}&per_page=${maxResults}&sort=updated&direction=desc`);
  return (Array.isArray(data) ? data : []).filter(i => !i.pull_request).map(i => ({
    number: i.number,
    title: i.title,
    state: i.state,
    labels: i.labels.map(l => l.name).join(', '),
    assignee: i.assignee?.login || '',
    updated: i.updated_at?.split('T')[0] || '',
    url: i.html_url,
  }));
}

/**
 * List PRs as structured JSON for the web UI.
 */
export async function listPRsRaw(config, repo, state = 'open', maxResults = 15) {
  if (!repo) return [];
  const data = await ghFetch(config, `/repos/${repo}/pulls?state=${state}&per_page=${maxResults}&sort=updated&direction=desc`);
  return (Array.isArray(data) ? data : []).map(pr => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft || false,
    author: pr.user?.login || '',
    reviewers: pr.requested_reviewers?.map(r => r.login).join(', ') || '',
    updated: pr.updated_at?.split('T')[0] || '',
    url: pr.html_url,
    additions: pr.additions || 0,
    deletions: pr.deletions || 0,
  }));
}

/**
 * Mark all notifications as read.
 */
export async function markNotificationsRead(config) {
  await ghFetch(config, '/notifications', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ last_read_at: new Date().toISOString() }),
  });
}

/**
 * Convert API URL to browser HTML URL.
 */
function buildHtmlUrl(apiUrl, type) {
  if (!apiUrl) return '';
  // api.github.com/repos/owner/repo/issues/1 → github.com/owner/repo/issues/1
  let htmlUrl = apiUrl.replace('https://api.github.com/repos/', 'https://github.com/');
  if (type === 'PullRequest') htmlUrl = htmlUrl.replace('/pulls/', '/pull/');
  return htmlUrl;
}
