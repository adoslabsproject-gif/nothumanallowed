/**
 * Shared tool executor, action parser, and tool definitions — the SINGLE source
 * of truth for all PAO tools used by chat.mjs, ui.mjs, and voice.mjs.
 *
 * Every tool lives HERE. Adding a tool means editing ONE file.
 *
 * Zero external dependencies — pure Node.js 22.
 */

import {
  listMessages,
  getMessage,
  getUnreadImportant,
  sendEmail,
  createDraft,
  getTodayEvents,
  getUpcomingEvents,
  getEventsForDate,
  createEvent,
  updateEvent,
  listEvents,
  markAsRead,
  markAsUnread,
  archiveMessage,
  markAllAsRead,
} from './mail-router.mjs';

import {
  findAvailableSlots,
  formatSlotProposal,
  generateSlotMessage,
} from './smart-scheduler.mjs';

import {
  getTasks,
  addTask,
  completeTask,
  moveTask,
  deleteTask,
  clearTasks,
  editTask,
  editTaskPriority,
} from './task-store.mjs';

import { notify } from './notification.mjs';

// ── Constants ────────────────────────────────────────────────────────────────

/** Actions that mutate external state and require user confirmation. */
export const DESTRUCTIVE_ACTIONS = new Set([
  'gmail_send',
  'gmail_send_attach',
  'gmail_reply',
  'gmail_delete',
  'calendar_create',
  'calendar_move',
  'calendar_update',
  'contact_delete',
  'task_done',
  'task_delete',
  'task_clear',
  'notify_remind',
  'slack_send',
  'github_create_issue',
]);

// ── Tool Definitions (for system prompt) ─────────────────────────────────────

/**
 * The FULL list of tool definitions for the LLM system prompt.
 * Callers replace {{TODAY}} and {{TIMEZONE}} and append their own persona.
 */
export const TOOL_DEFINITIONS = `
You have access to the following tools. When the user's message requires an action,
output EXACTLY ONE fenced JSON block per action:

\`\`\`json
{"action": "<tool_name>", "params": { ... }}
\`\`\`

You may include conversational text BEFORE or AFTER the JSON block. If no action
is needed, respond normally without any JSON block.

TOOLS:

--- EMAIL ---

1. gmail_list(query: string, maxResults?: number)
   Search emails. query uses Gmail search syntax (e.g. "from:boss@co.com", "is:unread subject:invoice").
   Default maxResults = 10.

2. gmail_read(messageId: string)
   Read the full body of an email by its ID (returned by gmail_list).

3. gmail_send(to: string, subject: string, body: string)
   Send an email. ALWAYS confirm with the user before sending.

4. gmail_draft(to: string, subject: string, body: string)
   Create a draft email (safe — does not send).

5. gmail_reply(messageId: string, body: string)
   Reply to an existing email thread. ALWAYS confirm before sending.

6. gmail_mark_read(all?: boolean, count?: number, messageId?: string)
   Mark emails as read. Options: all=true marks ALL unread. count=5 marks the last 5 unread. messageId marks one specific email.

7. gmail_mark_unread(count?: number, messageId?: string)
   Mark emails as unread. count=5 marks the last 5 read emails as unread. messageId marks one specific email.

8. gmail_archive(messageId: string)
   Archive a specific email (removes from inbox).

9. gmail_delete(query: string)
   Delete an email. Query can be a messageId OR a search term like "pranzo from:me in:sent".
   Finds the matching email and moves it to Trash. ALWAYS confirm before deleting.

--- CALENDAR ---

10. calendar_today()
    List all events for today.

11. calendar_tomorrow()
    List all events for tomorrow.

12. calendar_upcoming(hours?: number)
    List upcoming events in the next N hours (default 2).

13. calendar_week(startDate?: string)
    List all events for a full week starting from startDate (YYYY-MM-DD). Defaults to current week.

14. calendar_create(summary: string, start: string, end: string, attendees?: string[], description?: string)
    Create a calendar event. start/end are ISO 8601 datetime strings.
    ALWAYS confirm with the user before creating.

15. calendar_move(eventId: string, newStart: string, newEnd: string)
    Reschedule an event. ALWAYS confirm before moving.

16. calendar_find(query: string, daysAhead?: number)
    Search for a calendar event by name/keyword in the next N days (default 7). Returns matching events with their IDs.
    ALWAYS use this FIRST when the user wants to modify an event — you need the eventId.

17. calendar_update(eventId: string, summary?: string, location?: string, description?: string, start?: string, end?: string)
    Update ANY field of an existing calendar event: title, location, description, start time, end time.
    You MUST call calendar_find first to get the eventId. Only include fields that need to change. ALWAYS confirm before updating.

18. schedule_meeting(clientName: string, subject: string, location: string, durationMinutes: number, dateFrom: string, dateTo: string, workdayStart?: number, workdayEnd?: number)
    Find optimal meeting slots considering existing calendar events, locations, and estimated travel time between appointments. Returns ranked slots with travel info. dateFrom and dateTo are YYYY-MM-DD.

19. schedule_draft_email(clientName: string, subject: string, location: string, durationMinutes: number, dateFrom: string, dateTo: string)
    Same as schedule_meeting, but also generates a professional email proposing the top 3 slots to the client. Returns both the slots and a ready-to-send email draft.

--- TASKS ---

20. task_list()
    List today's tasks.

21. task_add(description: string, priority?: "low"|"medium"|"high"|"critical", due?: string)
    Add a new task for today.

22. task_done(id: number)
    Mark a task as completed. Confirm before completing.

23. task_move(id: number, toDate: string)
    Move a task to another date (YYYY-MM-DD).

24. task_delete(id: number)
    Delete a specific task permanently. ALWAYS confirm before deleting.

25. task_clear(mode?: "all"|"done")
    Clear tasks. mode="done" removes only completed tasks. mode="all" removes ALL tasks. Default: "all". ALWAYS confirm before clearing.

26. task_edit(id: number, description?: string, priority?: "low"|"medium"|"high"|"critical")
    Edit a task's description and/or priority.

--- CONTACTS ---

24. contact_search(query: string)
    Search contacts by name, email or phone. Returns matching contacts.

25. contact_add(name: string, email?: string, phone?: string, company?: string, address?: string)
    Add a new contact to Google Contacts.

26. contact_update(query: string, email?: string, phone?: string, company?: string, address?: string)
    Update an existing contact. Query is the contact name to search for.

27. contact_delete(query: string)
    Delete a contact by name. ALWAYS confirm before deleting.

--- GOOGLE TASKS ---

28. gtask_list()
    List Google Tasks (not completed).

29. gtask_add(title: string, notes?: string, due?: string)
    Add a Google Task. due is YYYY-MM-DD.

30. gtask_complete(title: string)
    Complete a Google Task by title.

--- NOTES ---

31. note_add(title: string, content?: string)
    Create a local note.

32. note_list()
    List all local notes.

--- GITHUB ---

33. github_issues(repo: string, state?: "open"|"closed"|"all", maxResults?: number)
    List issues for a GitHub repo (e.g. "owner/repo"). Default: open issues, max 10.

34. github_prs(repo: string, state?: "open"|"closed"|"all", maxResults?: number)
    List pull requests for a GitHub repo. Default: open PRs, max 10.

35. github_notifications(maxResults?: number)
    List your GitHub notifications (unread). Default max 10.

36. github_create_issue(repo: string, title: string, body?: string, labels?: string[])
    Create a new issue on a GitHub repo. ALWAYS confirm before creating.

--- NOTION ---

37. notion_search(query: string, maxResults?: number)
    Search Notion pages and databases. Default max 10.

38. notion_page(pageId: string)
    Read a Notion page content by ID.

--- SLACK ---

39. slack_channels(maxResults?: number)
    List Slack channels you're a member of. Default max 20.

40. slack_messages(channel: string, maxResults?: number)
    List recent messages in a Slack channel (name or ID). Default max 15.

41. slack_send(channel: string, text: string)
    Send a message to a Slack channel. ALWAYS confirm before sending.

--- FILE ATTACHMENT ---

42. gmail_send_attach(to: string, subject: string, body: string, fileQuery: string)
    Send an email with a Google Drive file attached. fileQuery is the name of the file to search for in Drive.
    The system finds the file, downloads it, and attaches it. ALWAYS confirm before sending.

--- NAVIGATION ---

43. maps_directions(from: string, to: string)
    Generate a Google Maps directions link between two locations. Returns a clickable URL.
    Use this when the user asks for directions, route, or "how to get to" somewhere.

--- REMINDERS ---

44. notify_remind(message: string, atTime: string)
    Set a desktop reminder. atTime is ISO 8601 or relative like "in 30 minutes".

--- BIRTHDAYS ---

45. birthdays_upcoming(days?: number)
    Check upcoming birthdays from Google Contacts in the next N days (default 30).

RULES:
- For search/read operations, execute immediately and present results conversationally.
- For write/send/delete operations (gmail_send, gmail_reply, gmail_delete, calendar_create, calendar_move, calendar_update, contact_delete, task_done, notify_remind), DESCRIBE what you're about to do and include the JSON block so the system can ask the user for confirmation.
- For schedule_meeting and schedule_draft_email, execute immediately — these are read operations that suggest slots.
- When presenting email results, show From, Subject, Date, and a brief snippet. Never dump raw JSON.
- When presenting calendar events, show Time, Title, Location/Link. Format times in a human-readable way.
- When presenting tasks, show ID, Description, Priority, Status.
- When presenting slot proposals, show day, date, time range, and travel info clearly.
- If you need multiple actions in sequence (e.g., read an email then reply), do them ONE AT A TIME — wait for the result of each before proceeding.
- Dates: today is {{TODAY}}. Infer relative dates from this.
- The user's timezone is {{TIMEZONE}}.
- CRITICAL: when creating calendar events, always use LOCAL time in format "YYYY-MM-DDTHH:MM:SS" WITHOUT any Z suffix or timezone offset.
`.trim();

// ── Action Parser ────────────────────────────────────────────────────────────

/**
 * Extract JSON action blocks from LLM response text.
 * Supports ```json ... ``` fenced blocks.
 *
 * @param {string} text
 * @returns {{ textParts: string[], actions: Array<{action: string, params: object}> }}
 */
export function parseActions(text) {
  const actions = [];
  const textParts = [];
  const fenceRegex = /```json\s*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).trim();
    if (before) textParts.push(before);

    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.action && typeof parsed.action === 'string') {
        actions.push({ action: parsed.action, params: parsed.params || {} });
      }
    } catch {
      textParts.push(match[0]);
    }

    lastIndex = match.index + match[0].length;
  }

  const trailing = text.slice(lastIndex).trim();
  if (trailing) textParts.push(trailing);

  return { textParts, actions };
}

// ── Formatting Helpers ───────────────────────────────────────────────────────

/**
 * Format an ISO timestamp into a human-readable time string.
 */
export function formatTime(isoStr) {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return isoStr;
  }
}

/**
 * Format an array of calendar events into human-readable text.
 */
export function formatEvents(events) {
  return events.map((e, i) => {
    const time = e.isAllDay ? 'All day' : `${formatTime(e.start)} - ${formatTime(e.end)}`;
    const location = e.location ? ` | Location: ${e.location}` : '';
    const link = e.hangoutLink ? ` | ${e.hangoutLink}` : '';
    const cal = e.calendarName ? ` (${e.calendarName})` : '';
    return `${i + 1}. [ID:${e.id}] ${time} — ${e.summary}${location}${link}${cal}`;
  }).join('\n');
}

/**
 * Resolve a time string into a Date. Supports ISO 8601 and relative formats
 * like "in 30 minutes", "in 2 hours".
 */
export function resolveTime(timeStr) {
  const direct = new Date(timeStr);
  if (!isNaN(direct.getTime()) && timeStr.includes('T')) return direct;

  const relMatch = timeStr.match(/in\s+(\d+)\s+(minute|min|hour|hr)s?/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const ms = unit.startsWith('h') ? amount * 3600000 : amount * 60000;
    return new Date(Date.now() + ms);
  }

  const today = new Date();
  const timeOnly = new Date(`${today.toISOString().split('T')[0]}T${timeStr}`);
  if (!isNaN(timeOnly.getTime())) return timeOnly;

  return new Date(Date.now() + 1800000);
}

/**
 * Format bytes into human-readable size.
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Build a human-readable description of an action (for confirmation prompts).
 */
export function describeAction(action, params) {
  switch (action) {
    case 'gmail_send':
      return `Send email to ${params.to} — Subject: "${params.subject}"`;
    case 'gmail_send_attach':
      return `Send email to ${params.to} with Drive file "${params.fileQuery}" — Subject: "${params.subject}"`;
    case 'gmail_reply':
      return `Reply to message ${params.messageId}`;
    case 'gmail_delete':
      return `Delete email matching "${params.query || params.messageId}"`;
    case 'calendar_create':
      return `Create event "${params.summary}" at ${formatTime(params.start)}`;
    case 'calendar_move':
      return `Reschedule event ${params.eventId} to ${formatTime(params.newStart)}`;
    case 'calendar_update':
      return `Update event ${params.eventId}`;
    case 'contact_delete':
      return `Delete contact "${params.query}"`;
    case 'task_done':
      return `Mark task #${params.id} as completed`;
    case 'task_delete':
      return `Delete task #${params.id} permanently`;
    case 'task_clear':
      return `Clear ${params.mode === 'done' ? 'completed' : 'ALL'} tasks`;
    case 'notify_remind':
      return `Set reminder: "${params.message}" at ${params.atTime}`;
    case 'slack_send':
      return `Send Slack message to #${params.channel}`;
    case 'github_create_issue':
      return `Create GitHub issue on ${params.repo}: "${params.title}"`;
    default:
      return `Execute ${action}`;
  }
}

/**
 * Build the system prompt with TOOL_DEFINITIONS + persona + profile + context.
 * @param {string} persona — e.g. "NHA Chat", "NHA Voice"
 * @param {string} personaDescription — description appended to system prompt
 * @param {object} config — NHA config (for profile injection)
 * @param {string} [initialContext] — optional preloaded context (today's events, etc.)
 * @returns {string}
 */
export function buildSystemPrompt(persona, personaDescription, config, initialContext) {
  const today = new Date().toISOString().split('T')[0];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  let prompt = TOOL_DEFINITIONS
    .replace('{{TODAY}}', today)
    .replace('{{TIMEZONE}}', tz);

  prompt += `\n\n${personaDescription}`;

  // Inject user profile if configured
  const profile = config?.profile;
  if (profile) {
    const fields = [];
    if (profile.name) fields.push(`Name: ${profile.name}`);
    if (profile.email) fields.push(`Email: ${profile.email}`);
    if (profile.phone) fields.push(`Phone: ${profile.phone}`);
    if (profile.homeAddress) fields.push(`Home address: ${profile.homeAddress}`);
    if (profile.workAddress) fields.push(`Work address: ${profile.workAddress}`);
    if (profile.city) fields.push(`City: ${profile.city}`);
    if (profile.country) fields.push(`Country: ${profile.country}`);
    if (profile.company) fields.push(`Company: ${profile.company}`);
    if (profile.role) fields.push(`Role: ${profile.role}`);
    if (profile.notes) fields.push(`Notes: ${profile.notes}`);

    if (fields.length > 0) {
      prompt += `\n\n--- USER PROFILE (use this for personal references like "my home", "my city", etc.) ---\n${fields.join('\n')}`;
    }
  }

  if (initialContext) {
    prompt += `\n\n--- CURRENT CONTEXT (fetched at session start) ---\n${initialContext}`;
  }

  return prompt;
}

// ── Tool Executor ────────────────────────────────────────────────────────────

/**
 * Execute a parsed tool action and return a human-readable result string.
 *
 * @param {string} action — tool name
 * @param {object} params — tool parameters
 * @param {object} config — NHA config
 * @returns {Promise<string>} result description
 */
export async function executeTool(action, params, config) {
  switch (action) {
    // ── Gmail ──────────────────────────────────────────────────────────────
    case 'gmail_list': {
      const query = params.query || 'is:unread';
      const max = params.maxResults || 10;
      const refs = await listMessages(config, query, max);
      if (refs.length === 0) return 'No emails found matching that query.';

      const messages = [];
      for (const ref of refs.slice(0, max)) {
        try {
          const msg = await getMessage(config, ref.id);
          messages.push(msg);
        } catch { /* skip failed */ }
      }

      return messages.map((m, i) =>
        `${i + 1}. [${m.id}] From: ${m.from} | Subject: ${m.subject} | Date: ${m.date}\n   ${m.snippet.slice(0, 120)}`
      ).join('\n');
    }

    case 'gmail_read': {
      const msg = await getMessage(config, params.messageId);
      return [
        `From: ${msg.from}`,
        `To: ${msg.to}`,
        `Subject: ${msg.subject}`,
        `Date: ${msg.date}`,
        `---`,
        msg.body.slice(0, 4000),
      ].join('\n');
    }

    case 'gmail_send': {
      await sendEmail(config, params.to, params.subject, params.body);
      return `Email sent to ${params.to} with subject "${params.subject}".`;
    }

    case 'gmail_draft': {
      await createDraft(config, params.to, params.subject, params.body);
      return `Draft created for ${params.to} with subject "${params.subject}".`;
    }

    case 'gmail_reply': {
      const original = await getMessage(config, params.messageId);
      await sendEmail(config, original.from, `Re: ${original.subject}`, params.body, {
        replyToMessageId: original.id,
        threadId: original.threadId,
      });
      return `Reply sent to ${original.from} on thread "${original.subject}".`;
    }

    case 'gmail_mark_read': {
      if (params.all) {
        const result = await markAllAsRead(config);
        if (result.count === 0) return 'All emails are already read. No changes needed.';
        return `Success! ${result.count} email${result.count !== 1 ? 's' : ''} marked as read.`;
      }
      if (params.count) {
        const refs = await listMessages(config, 'is:unread', params.count);
        if (refs.length === 0) return 'No unread emails found.';
        for (const ref of refs) { await markAsRead(config, ref.id); }
        return `Done! ${refs.length} email${refs.length !== 1 ? 's' : ''} marked as read.`;
      }
      if (params.messageId) {
        await markAsRead(config, params.messageId);
        return 'Email marked as read.';
      }
      return 'Specify all=true, count=N, or a messageId.';
    }

    case 'gmail_mark_unread': {
      if (params.count) {
        const refs = await listMessages(config, 'in:inbox -is:unread', params.count);
        if (refs.length === 0) return 'No read emails found to mark as unread.';
        for (const ref of refs) { await markAsUnread(config, ref.id); }
        return `Done! ${refs.length} email${refs.length !== 1 ? 's' : ''} marked as unread.`;
      }
      if (params.messageId) {
        await markAsUnread(config, params.messageId);
        return 'Email marked as unread.';
      }
      return 'Specify count=N or a messageId.';
    }

    case 'gmail_archive': {
      await archiveMessage(config, params.messageId);
      return `Email ${params.messageId} archived.`;
    }

    case 'gmail_delete': {
      const gm = await import('./google-gmail.mjs');
      let messageId = params.query || params.messageId;
      if (messageId && (messageId.includes(' ') || messageId.includes(':') || messageId.length < 15)) {
        const msgs = await gm.listMessages(config, messageId, 1);
        if (msgs.length === 0) return `No email found matching "${messageId}".`;
        messageId = msgs[0].id;
      }
      await gm.trashMessage(config, messageId);
      return 'Email moved to Trash.';
    }

    // ── Gmail with attachment ───────────────────────────────────────────
    case 'gmail_send_attach': {
      const gd = await import('./google-drive.mjs');
      // Search for the file in Drive
      const files = await gd.searchFiles(config, params.fileQuery, 5);
      if (files.length === 0) return `No file found in Drive matching "${params.fileQuery}".`;

      const file = files[0]; // Use best match
      const downloaded = await gd.downloadFileContent(config, file.id);

      await sendEmail(config, params.to, params.subject, params.body, {
        attachments: [{
          name: downloaded.name,
          mimeType: downloaded.mimeType,
          base64: downloaded.base64,
        }],
      });

      return `Email sent to ${params.to} with attachment "${downloaded.name}" (${formatFileSize(downloaded.size)}).`;
    }

    // ── Calendar ──────────────────────────────────────────────────────────
    case 'calendar_today': {
      const events = await getTodayEvents(config);
      if (events.length === 0) return 'No events scheduled for today.';
      return formatEvents(events);
    }

    case 'calendar_tomorrow': {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split('T')[0];
      const events = await getEventsForDate(config, dateStr);
      if (events.length === 0) return 'No events scheduled for tomorrow.';
      return formatEvents(events);
    }

    case 'calendar_upcoming': {
      const hours = params.hours || 2;
      const events = await getUpcomingEvents(config, hours);
      if (events.length === 0) return `No events in the next ${hours} hour(s).`;
      return formatEvents(events);
    }

    case 'calendar_create': {
      await createEvent(config, {
        summary: params.summary,
        start: params.start,
        end: params.end,
        description: params.description || '',
        attendees: params.attendees || [],
      });
      return `Event "${params.summary}" created for ${formatTime(params.start)} - ${formatTime(params.end)}.`;
    }

    case 'calendar_move': {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await updateEvent(config, 'primary', params.eventId, {
        start: { dateTime: new Date(params.newStart).toISOString(), timeZone: tz },
        end: { dateTime: new Date(params.newEnd).toISOString(), timeZone: tz },
      });
      return `Event rescheduled to ${formatTime(params.newStart)} - ${formatTime(params.newEnd)}.`;
    }

    case 'calendar_week': {
      const startDate = params.startDate || new Date().toISOString().split('T')[0];
      const from = new Date(startDate + 'T00:00:00');
      const to = new Date(from.getTime() + 7 * 86400000);
      const events = await listEvents(config, 'primary', from, to);
      if (events.length === 0) return `No events found for the week starting ${startDate}.`;

      const byDay = new Map();
      for (const e of events) {
        const day = e.start.split('T')[0];
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(e);
      }

      const lines = [];
      for (const [day, dayEvents] of [...byDay.entries()].sort()) {
        const dayName = new Date(day).toLocaleDateString('en-US', { weekday: 'long' });
        lines.push(`\n${dayName} ${day} (${dayEvents.length} events):`);
        for (const e of dayEvents) {
          const time = e.isAllDay ? 'All day' : `${formatTime(e.start)} - ${formatTime(e.end)}`;
          const loc = e.location ? ` @ ${e.location}` : '';
          lines.push(`  ${time} — ${e.summary}${loc}`);
        }
      }
      return lines.join('\n');
    }

    case 'calendar_find': {
      const query = (params.query || '').toLowerCase();
      const daysAhead = params.daysAhead || 7;
      const from = new Date();
      const to = new Date(from.getTime() + daysAhead * 86400000);
      const events = await listEvents(config, 'primary', from, to);

      const matches = events.filter(e =>
        (e.summary || '').toLowerCase().includes(query) ||
        (e.description || '').toLowerCase().includes(query)
      );

      if (matches.length === 0) return `No events found matching "${params.query}" in the next ${daysAhead} days.`;

      return matches.map((e, i) => {
        const time = e.isAllDay ? 'All day' : `${formatTime(e.start)} - ${formatTime(e.end)}`;
        const date = e.start.split('T')[0];
        const loc = e.location ? ` | Location: ${e.location}` : '';
        return `${i + 1}. [eventId: ${e.id}] ${date} ${time} — ${e.summary}${loc}`;
      }).join('\n');
    }

    case 'calendar_update': {
      // Smart eventId resolution: if it looks like a name instead of a Google Calendar ID, search for it
      let eventId = params.eventId;
      if (eventId && (eventId.includes(' ') || eventId.length < 10 || /[A-Z]/.test(eventId))) {
        const from = new Date();
        const to = new Date(from.getTime() + 14 * 86400000);
        const events = await listEvents(config, 'primary', from, to);
        const match = events.find(e => (e.summary || '').toLowerCase().includes(eventId.toLowerCase()));
        if (match) {
          eventId = match.id;
        } else {
          return `Could not find event matching "${params.eventId}" in the next 2 weeks. Use calendar_find to search.`;
        }
      }

      const patch = {};
      if (params.summary) patch.summary = params.summary;
      if (params.location) patch.location = params.location;
      if (params.description) patch.description = params.description;
      if (params.start) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        patch.start = { dateTime: new Date(params.start).toISOString(), timeZone: tz };
      }
      if (params.end) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        patch.end = { dateTime: new Date(params.end).toISOString(), timeZone: tz };
      }
      await updateEvent(config, 'primary', eventId, patch);
      const changes = Object.keys(patch).join(', ');
      return `Event updated successfully (${changes}). ${params.location ? `New location: ${params.location}` : ''}`;
    }

    // ── Smart Scheduling ──────────────────────────────────────────────────
    case 'schedule_meeting': {
      const slots = await findAvailableSlots(config, {
        meetingLocation: params.location || '',
        durationMinutes: params.durationMinutes || 60,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        workdayStart: params.workdayStart || 9,
        workdayEnd: params.workdayEnd || 18,
        maxSlots: 5,
      });
      return formatSlotProposal(slots, params.clientName || 'the client', params.subject || 'meeting', params.location || '');
    }

    case 'schedule_draft_email': {
      const slots = await findAvailableSlots(config, {
        meetingLocation: params.location || '',
        durationMinutes: params.durationMinutes || 60,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        workdayStart: 9,
        workdayEnd: 18,
        maxSlots: 5,
      });

      const proposal = formatSlotProposal(slots, params.clientName || 'the client', params.subject || 'meeting');
      const email = generateSlotMessage(slots, params.clientName || 'the client', params.subject || 'meeting');

      return `${proposal}\n\n--- DRAFT EMAIL ---\n\n${email}`;
    }

    // ── Tasks ─────────────────────────────────────────────────────────────
    case 'task_list': {
      const tasks = getTasks();
      if (tasks.length === 0) return 'No tasks for today.';
      return tasks.map(t =>
        `#${t.id} [${t.priority}] ${t.status === 'done' ? '[DONE] ' : ''}${t.description}${t.due ? ' (due: ' + t.due + ')' : ''}`
      ).join('\n');
    }

    case 'task_add': {
      const task = addTask({
        description: params.description,
        priority: params.priority || 'medium',
        due: params.due || null,
        source: 'tool',
      });
      return `Task #${task.id} added: "${task.description}" [${task.priority}]`;
    }

    case 'task_done': {
      const success = completeTask(params.id);
      return success ? `Task #${params.id} marked as done.` : `Task #${params.id} not found.`;
    }

    case 'task_move': {
      const todayStr = new Date().toISOString().split('T')[0];
      const toDate = params.toDate === 'tomorrow'
        ? new Date(new Date().setDate(new Date().getDate() + 1)).toISOString().split('T')[0]
        : params.toDate;
      const success = moveTask(params.id, todayStr, toDate);
      return success ? `Task #${params.id} moved to ${toDate}.` : `Task #${params.id} not found.`;
    }

    case 'task_delete': {
      const success = deleteTask(params.id);
      return success ? `Task #${params.id} deleted.` : `Task #${params.id} not found.`;
    }

    case 'task_clear': {
      const mode = params.mode || 'all';
      const count = clearTasks(mode);
      return count > 0
        ? `${count} task${count !== 1 ? 's' : ''} ${mode === 'done' ? 'completed' : ''} removed.`
        : 'No tasks to remove.';
    }

    case 'task_edit': {
      if (params.description) {
        editTask(params.id, params.description);
      }
      if (params.priority) {
        editTaskPriority(params.id, params.priority);
      }
      const parts = [];
      if (params.description) parts.push(`description updated`);
      if (params.priority) parts.push(`priority set to ${params.priority}`);
      return parts.length > 0 ? `Task #${params.id}: ${parts.join(', ')}.` : `No changes specified for task #${params.id}.`;
    }

    // ── Notifications ─────────────────────────────────────────────────────
    case 'notify_remind': {
      const atTime = resolveTime(params.atTime);
      const delayMs = atTime.getTime() - Date.now();

      if (delayMs <= 0) {
        await notify('Reminder', params.message, config);
        return `Reminder sent now: "${params.message}"`;
      }

      setTimeout(async () => {
        try { await notify('Reminder', params.message, config); } catch { /* best effort */ }
      }, Math.min(delayMs, 86400000));

      const minutes = Math.round(delayMs / 60000);
      return `Reminder set for ${formatTime(atTime.toISOString())} (in ~${minutes} min): "${params.message}"`;
    }

    // ── Contacts ──────────────────────────────────────────────────────────
    case 'contact_search': {
      const gc = await import('./google-contacts.mjs');
      const contacts = await gc.searchContacts(config, params.query, 10);
      if (contacts.length === 0) return `No contacts matching "${params.query}".`;
      return contacts.map((c, i) =>
        `${i + 1}. ${c.name}${c.email ? ' — ' + c.email : ''}${c.phone ? ' — ' + c.phone : ''}${c.company ? ' (' + c.company + ')' : ''}`
      ).join('\n');
    }

    case 'contact_add': {
      const gc = await import('./google-contacts.mjs');
      const contact = await gc.createContact(config, {
        name: params.name, email: params.email, phone: params.phone,
        company: params.company, address: params.address,
      });
      return `Contact created: ${contact.name}${contact.phone ? ' — ' + contact.phone : ''}${contact.email ? ' — ' + contact.email : ''}`;
    }

    case 'contact_update': {
      const gc = await import('./google-contacts.mjs');
      const matches = await gc.searchContacts(config, params.query, 1);
      if (matches.length === 0) return `No contact found matching "${params.query}".`;
      const updated = await gc.updateContact(config, matches[0].resourceName, {
        email: params.email, phone: params.phone, company: params.company, address: params.address,
      });
      return `Contact updated: ${updated.name}`;
    }

    case 'contact_delete': {
      const gc = await import('./google-contacts.mjs');
      const matches = await gc.searchContacts(config, params.query, 1);
      if (matches.length === 0) return `No contact found matching "${params.query}".`;
      await gc.deleteContact(config, matches[0].resourceName);
      return `Contact "${matches[0].name}" deleted.`;
    }

    // ── Google Tasks ──────────────────────────────────────────────────────
    case 'gtask_list': {
      const gt = await import('./google-tasks.mjs');
      const tasks = await gt.listTasks(config);
      if (tasks.length === 0) return 'No active Google Tasks.';
      return tasks.map((t, i) =>
        `${i + 1}. ${t.title}${t.due ? ' (due: ' + t.due.split('T')[0] + ')' : ''}${t.notes ? ' — ' + t.notes.slice(0, 80) : ''}`
      ).join('\n');
    }

    case 'gtask_add': {
      const gt = await import('./google-tasks.mjs');
      const lists = await gt.listTaskLists(config);
      const listId = lists[0]?.id || '@default';
      const task = await gt.createTask(config, listId, params.title, params.notes || '', params.due || '');
      return `Google Task created: "${task.title}"${task.due ? ' (due: ' + task.due.split('T')[0] + ')' : ''}`;
    }

    case 'gtask_complete': {
      const gt = await import('./google-tasks.mjs');
      const tasks = await gt.listTasks(config);
      const match = tasks.find(t => t.title.toLowerCase().includes((params.title || '').toLowerCase()));
      if (!match) return `No task found matching "${params.title}".`;
      await gt.completeTask(config, match.listId || '@default', match.id);
      return `Task "${match.title}" completed.`;
    }

    // ── Notes ─────────────────────────────────────────────────────────────
    case 'note_add': {
      const ns = await import('./notes.mjs');
      const note = ns.createNote(params.title || 'Untitled', params.content || '', params.tags || []);
      return `Note created: "${note.title}"`;
    }

    case 'note_list': {
      const ns = await import('./notes.mjs');
      const notes = ns.listNotes();
      if (notes.length === 0) return 'No notes.';
      return notes.map((n, i) => `${i + 1}. ${n.title} (${new Date(n.updatedAt).toLocaleDateString()})`).join('\n');
    }

    // ── GitHub ────────────────────────────────────────────────────────────
    case 'github_issues': {
      const gh = await import('./github.mjs');
      return gh.listIssues(config, params.repo, params.state || 'open', params.maxResults || 10);
    }

    case 'github_prs': {
      const gh = await import('./github.mjs');
      return gh.listPRs(config, params.repo, params.state || 'open', params.maxResults || 10);
    }

    case 'github_notifications': {
      const gh = await import('./github.mjs');
      return gh.listNotifications(config, params.maxResults || 10);
    }

    case 'github_create_issue': {
      const gh = await import('./github.mjs');
      return gh.createIssue(config, params.repo, params.title, params.body || '', params.labels || []);
    }

    // ── Notion ────────────────────────────────────────────────────────────
    case 'notion_search': {
      const nt = await import('./notion.mjs');
      return nt.search(config, params.query, params.maxResults || 10);
    }

    case 'notion_page': {
      const nt = await import('./notion.mjs');
      return nt.getPage(config, params.pageId);
    }

    // ── Slack ─────────────────────────────────────────────────────────────
    case 'slack_channels': {
      const sl = await import('./slack.mjs');
      return sl.listChannels(config, params.maxResults || 20);
    }

    case 'slack_messages': {
      const sl = await import('./slack.mjs');
      return sl.listMessages(config, params.channel, params.maxResults || 15);
    }

    case 'slack_send': {
      const sl = await import('./slack.mjs');
      return sl.sendMessage(config, params.channel, params.text);
    }

    // ── Maps Directions ──────────────────────────────────────────────────
    case 'maps_directions': {
      const from = encodeURIComponent(params.from || '');
      const to = encodeURIComponent(params.to || '');
      if (!from || !to) return 'Both "from" and "to" locations are required.';
      return `Google Maps directions:\nhttps://www.google.com/maps/dir/${from}/${to}`;
    }

    // ── Birthdays ─────────────────────────────────────────────────────────
    case 'birthdays_upcoming': {
      const gc = await import('./google-contacts.mjs');
      const days = params.days || 30;
      const contacts = await gc.getBirthdays(config);
      if (contacts.length === 0) return 'No contacts with birthdays set.';

      const today = new Date();
      const upcoming = [];

      for (const c of contacts) {
        if (!c.birthday) continue;
        const parts = c.birthday.split('-');
        const month = parseInt(parts.length === 3 ? parts[1] : parts[0], 10);
        const day = parseInt(parts.length === 3 ? parts[2] : parts[1], 10);

        const thisYear = new Date(today.getFullYear(), month - 1, day);
        if (thisYear < today) thisYear.setFullYear(today.getFullYear() + 1);

        const daysUntil = Math.ceil((thisYear - today) / 86400000);
        if (daysUntil <= days) {
          upcoming.push({ name: c.name, birthday: c.birthday, daysUntil, date: thisYear });
        }
      }

      if (upcoming.length === 0) return `No birthdays in the next ${days} days.`;

      upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
      return upcoming.map((u, i) => {
        const dateStr = u.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
        const label = u.daysUntil === 0 ? 'TODAY!' : u.daysUntil === 1 ? 'Tomorrow' : `in ${u.daysUntil} days`;
        return `${i + 1}. ${u.name} — ${dateStr} (${label})`;
      }).join('\n');
    }

    default:
      return `Unknown action: ${action}`;
  }
}
