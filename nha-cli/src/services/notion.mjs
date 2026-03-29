/**
 * Notion API integration — zero dependencies.
 * Uses Notion API v2022-06-28 with Integration Token authentication.
 * Token stored in config.notion.token or via `nha config set notion-token`.
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/**
 * Authenticated fetch to Notion API.
 */
async function notionFetch(config, urlPath, options = {}) {
  const token = config.notion?.token;
  if (!token) throw new Error('Notion token not configured. Run: nha config set notion-token YOUR_TOKEN');

  const url = urlPath.startsWith('http') ? urlPath : `${NOTION_API}${urlPath}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion API ${res.status}: ${err.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Extract plain text from Notion rich text array.
 */
function richTextToPlain(richText) {
  if (!richText || !Array.isArray(richText)) return '';
  return richText.map(rt => rt.plain_text || '').join('');
}

/**
 * Extract a readable title from a Notion page/database object.
 */
function extractTitle(obj) {
  if (obj.properties?.title?.title) {
    return richTextToPlain(obj.properties.title.title);
  }
  if (obj.properties?.Name?.title) {
    return richTextToPlain(obj.properties.Name.title);
  }
  // Try all properties for any title-type
  for (const prop of Object.values(obj.properties || {})) {
    if (prop.type === 'title' && prop.title) {
      return richTextToPlain(prop.title);
    }
  }
  return obj.id || 'Untitled';
}

/**
 * Search Notion pages and databases.
 * @returns {Promise<string>} formatted result
 */
export async function search(config, query, maxResults = 10) {
  if (!query) return 'Search query required.';

  const data = await notionFetch(config, '/search', {
    method: 'POST',
    body: JSON.stringify({
      query,
      page_size: maxResults,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    }),
  });

  const results = data.results || [];
  if (results.length === 0) return `No Notion pages found matching "${query}".`;

  return results.map((r, i) => {
    const type = r.object === 'database' ? 'DB' : 'Page';
    const title = extractTitle(r);
    const edited = r.last_edited_time?.split('T')[0] || '';
    const icon = r.icon?.emoji || '';
    return `${i + 1}. [${type}] ${icon} ${title} (edited: ${edited}) — ID: ${r.id}`;
  }).join('\n');
}

/**
 * Read a Notion page content by ID.
 * @returns {Promise<string>} formatted result
 */
export async function getPage(config, pageId) {
  if (!pageId) return 'Page ID required.';

  // Get page metadata
  const page = await notionFetch(config, `/pages/${pageId}`);
  const title = extractTitle(page);

  // Get page content (blocks)
  const blocks = await notionFetch(config, `/blocks/${pageId}/children?page_size=100`);
  const content = (blocks.results || []).map(block => {
    const type = block.type;
    const data = block[type];
    if (!data) return '';

    switch (type) {
      case 'paragraph':
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
      case 'quote':
      case 'callout':
        return richTextToPlain(data.rich_text);
      case 'bulleted_list_item':
      case 'numbered_list_item':
        return `• ${richTextToPlain(data.rich_text)}`;
      case 'to_do':
        return `[${data.checked ? 'x' : ' '}] ${richTextToPlain(data.rich_text)}`;
      case 'code':
        return `\`\`\`${data.language || ''}\n${richTextToPlain(data.rich_text)}\n\`\`\``;
      case 'divider':
        return '---';
      case 'toggle':
        return `▶ ${richTextToPlain(data.rich_text)}`;
      default:
        return `[${type}]`;
    }
  }).filter(Boolean).join('\n');

  return `Title: ${title}\n\n${content || '(empty page)'}`;
}
