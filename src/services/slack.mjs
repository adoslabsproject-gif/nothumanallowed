/**
 * Slack API integration — zero dependencies.
 * Uses Slack Web API with Bot Token (xoxb-) authentication.
 * Token stored in config.slack.token or via `nha config set slack-token`.
 */

const SLACK_API = 'https://slack.com/api';

/**
 * Authenticated fetch to Slack Web API.
 */
async function slackFetch(config, method, params = {}) {
  const token = config.slack?.token;
  if (!token) throw new Error('Slack token not configured. Run: nha config set slack-token YOUR_XOXB_TOKEN');

  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    throw new Error(`Slack API HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error || 'unknown'}`);
  }

  return data;
}

/**
 * Resolve a channel name to its ID.
 * Accepts both "#channel-name" / "channel-name" and raw channel IDs.
 */
async function resolveChannelId(config, channel) {
  // Already an ID (starts with C, D, or G)
  if (/^[CDG][A-Z0-9]{8,}$/.test(channel)) return channel;

  // Strip leading #
  const name = channel.replace(/^#/, '');

  const data = await slackFetch(config, 'conversations.list', {
    types: 'public_channel,private_channel',
    limit: 200,
    exclude_archived: true,
  });

  const match = (data.channels || []).find(c => c.name === name);
  if (!match) throw new Error(`Channel "${channel}" not found. Use slack_channels to list available channels.`);
  return match.id;
}

/**
 * Format a Unix timestamp into human-readable.
 */
function formatSlackTime(ts) {
  try {
    const d = new Date(parseFloat(ts) * 1000);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return '';
  }
}

/**
 * List channels the bot is a member of.
 * @returns {Promise<string>} formatted result
 */
export async function listChannels(config, maxResults = 20) {
  const data = await slackFetch(config, 'conversations.list', {
    types: 'public_channel,private_channel',
    limit: maxResults,
    exclude_archived: true,
  });

  const channels = data.channels || [];
  if (channels.length === 0) return 'No channels found.';

  return channels.map((c, i) => {
    const members = c.num_members || 0;
    const purpose = c.purpose?.value?.slice(0, 60) || '';
    return `${i + 1}. #${c.name} (${members} members)${purpose ? ' — ' + purpose : ''}`;
  }).join('\n');
}

/**
 * List recent messages in a channel.
 * @returns {Promise<string>} formatted result
 */
export async function listMessages(config, channel, maxResults = 15) {
  if (!channel) return 'Channel name or ID required.';

  const channelId = await resolveChannelId(config, channel);

  const data = await slackFetch(config, 'conversations.history', {
    channel: channelId,
    limit: maxResults,
  });

  const messages = (data.messages || []).reverse(); // chronological order
  if (messages.length === 0) return `No messages in #${channel}.`;

  // Fetch user names for the messages
  const userIds = [...new Set(messages.map(m => m.user).filter(Boolean))];
  const userMap = {};
  for (const uid of userIds.slice(0, 20)) {
    try {
      const u = await slackFetch(config, 'users.info', { user: uid });
      userMap[uid] = u.user?.real_name || u.user?.name || uid;
    } catch {
      userMap[uid] = uid;
    }
  }

  return messages.map((m, i) => {
    const user = userMap[m.user] || m.user || 'bot';
    const time = formatSlackTime(m.ts);
    const text = (m.text || '').slice(0, 200);
    return `${time} [${user}]: ${text}`;
  }).join('\n');
}

/**
 * Send a message to a channel.
 * @returns {Promise<string>} formatted result
 */
export async function sendMessage(config, channel, text) {
  if (!channel) return 'Channel name or ID required.';
  if (!text) return 'Message text required.';

  const channelId = await resolveChannelId(config, channel);

  await slackFetch(config, 'chat.postMessage', {
    channel: channelId,
    text,
  });

  return `Message sent to #${channel}.`;
}
