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
 * Send a message to a channel — supports thread replies via threadTs.
 * @returns {Promise<string>} formatted result with the new message ts
 */
export async function sendMessage(config, channel, text, threadTs = null) {
  if (!channel) return 'Channel name or ID required.';
  if (!text) return 'Message text required.';

  const channelId = await resolveChannelId(config, channel);

  const params = { channel: channelId, text };
  if (threadTs) params.thread_ts = threadTs;

  const res = await slackFetch(config, 'chat.postMessage', params);

  return `Message sent to #${channel}${threadTs ? ' (thread reply)' : ''}. ts=${res.ts}`;
}

// ── Advanced operations (15.1.37) ───────────────────────────────────────────

/**
 * Cache of user_id → display info to avoid re-fetching on every list call.
 * Cleared when the responder restarts. TTL implicit per process lifetime.
 */
const _userCache = new Map();

async function _resolveUsers(config, userIds) {
  const unknown = [...new Set(userIds)].filter(u => u && !_userCache.has(u));
  for (const uid of unknown.slice(0, 30)) {
    try {
      const u = await slackFetch(config, 'users.info', { user: uid });
      _userCache.set(uid, {
        id: uid,
        name: u.user?.real_name || u.user?.name || uid,
        avatar: u.user?.profile?.image_48 || '',
        title: u.user?.profile?.title || '',
        is_bot: !!u.user?.is_bot,
      });
    } catch {
      _userCache.set(uid, { id: uid, name: uid, avatar: '', title: '', is_bot: false });
    }
  }
  return _userCache;
}

/** Return raw channel objects with member-resolved metadata. */
export async function listChannelsRich(config, { types = 'public_channel,private_channel,mpim,im', maxResults = 200, excludeArchived = true } = {}) {
  const data = await slackFetch(config, 'conversations.list', {
    types, limit: maxResults, exclude_archived: excludeArchived,
  });
  const channels = data.channels || [];
  // For DMs, resolve the other user's name
  const dmUserIds = channels.filter(c => c.is_im).map(c => c.user).filter(Boolean);
  if (dmUserIds.length) await _resolveUsers(config, dmUserIds);
  return channels.map(c => ({
    id: c.id,
    name: c.is_im ? (`@${_userCache.get(c.user)?.name || c.user}`) : c.name,
    is_member: c.is_member,
    is_private: c.is_private,
    is_im: c.is_im,
    is_mpim: c.is_mpim,
    is_archived: c.is_archived,
    num_members: c.num_members,
    purpose: c.purpose?.value || '',
    topic: c.topic?.value || '',
    unread_count: c.unread_count_display || 0,
  }));
}

/** Return raw message objects with user names resolved + thread metadata. */
export async function listMessagesRich(config, channel, { limit = 50, oldest, latest } = {}) {
  const channelId = await resolveChannelId(config, channel);
  const params = { channel: channelId, limit };
  if (oldest) params.oldest = oldest;
  if (latest) params.latest = latest;
  const data = await slackFetch(config, 'conversations.history', params);
  const messages = (data.messages || []).reverse();
  const userIds = messages.map(m => m.user || m.bot_id).filter(Boolean);
  await _resolveUsers(config, userIds);
  return messages.map(m => ({
    ts: m.ts,
    user: _userCache.get(m.user)?.name || m.user || (m.username ? m.username : 'bot'),
    user_id: m.user,
    avatar: _userCache.get(m.user)?.avatar || '',
    text: m.text || '',
    type: m.type,
    subtype: m.subtype,
    thread_ts: m.thread_ts,
    reply_count: m.reply_count || 0,
    reactions: (m.reactions || []).map(r => ({ name: r.name, count: r.count })),
    files: (m.files || []).map(f => ({ id: f.id, name: f.name, mimetype: f.mimetype, url: f.url_private })),
  }));
}

/** Get all replies in a thread. */
export async function getThreadReplies(config, channel, threadTs) {
  const channelId = await resolveChannelId(config, channel);
  const data = await slackFetch(config, 'conversations.replies', {
    channel: channelId, ts: threadTs, limit: 100,
  });
  const messages = data.messages || [];
  const userIds = messages.map(m => m.user || m.bot_id).filter(Boolean);
  await _resolveUsers(config, userIds);
  return messages.map(m => ({
    ts: m.ts,
    user: _userCache.get(m.user)?.name || m.user || 'bot',
    text: m.text || '',
    reactions: (m.reactions || []).map(r => ({ name: r.name, count: r.count })),
  }));
}

/** Search messages across the workspace (requires search:read scope). */
export async function searchMessages(config, query, { count = 20 } = {}) {
  const data = await slackFetch(config, 'search.messages', { query, count, sort: 'timestamp', sort_dir: 'desc' });
  const matches = data.messages?.matches || [];
  const userIds = matches.map(m => m.user).filter(Boolean);
  await _resolveUsers(config, userIds);
  return matches.map(m => ({
    ts: m.ts,
    user: _userCache.get(m.user)?.name || m.user || m.username || 'unknown',
    text: m.text || '',
    channel: m.channel?.name || m.channel?.id,
    channel_id: m.channel?.id,
    permalink: m.permalink,
  }));
}

/** Add an emoji reaction to a message. */
export async function addReaction(config, channel, ts, emoji) {
  const channelId = await resolveChannelId(config, channel);
  await slackFetch(config, 'reactions.add', {
    channel: channelId, timestamp: ts, name: emoji.replace(/^:|:$/g, ''),
  });
  return `Added :${emoji}: reaction.`;
}

/** Mark a channel as read up to a given ts (or now). */
export async function markRead(config, channel, ts = null) {
  const channelId = await resolveChannelId(config, channel);
  await slackFetch(config, 'conversations.mark', {
    channel: channelId, ts: ts || (Date.now() / 1000).toString(),
  });
  return `Marked #${channel} as read.`;
}

/** Open a DM with a user by ID or name lookup. */
export async function openDM(config, userIdOrName) {
  let uid = userIdOrName;
  // If it doesn't look like a user ID (U...), try to look it up
  if (!/^U[A-Z0-9]{8,}$/.test(uid)) {
    const data = await slackFetch(config, 'users.list', { limit: 1000 });
    const match = (data.members || []).find(u =>
      u.real_name?.toLowerCase() === uid.toLowerCase() ||
      u.name?.toLowerCase() === uid.toLowerCase() ||
      u.profile?.email?.toLowerCase() === uid.toLowerCase(),
    );
    if (!match) throw new Error(`User "${userIdOrName}" not found in workspace.`);
    uid = match.id;
  }
  const data = await slackFetch(config, 'conversations.open', { users: uid });
  return data.channel?.id;
}

/** Workspace info (team name, icon). */
export async function getWorkspaceInfo(config) {
  try {
    const data = await slackFetch(config, 'team.info', {});
    return {
      id: data.team?.id,
      name: data.team?.name,
      domain: data.team?.domain,
      icon: data.team?.icon?.image_88,
    };
  } catch { return null; }
}

/** Update the cached user info — useful before listing messages. */
export { _resolveUsers as resolveUsers };

