/**
 * Shared tool executor, action parser, and tool definitions — the SINGLE source
 * of truth for all PAO tools used by chat.mjs, ui.mjs, and voice.mjs.
 *
 * Every tool lives HERE. Adding a tool means editing ONE file.
 *
 * Zero external dependencies — pure Node.js 22.
 */

import os from 'os';
import path from 'path';

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
  'file_write',
  'drive_upload',
  'drive_update',
  'drive_delete',
]);

// ── Tool Definitions (for system prompt) ─────────────────────────────────────

/**
 * The FULL list of tool definitions for the LLM system prompt.
 * Callers replace {{TODAY}} and {{TIMEZONE}} and append their own persona.
 */
export const TOOL_DEFINITIONS = `
You have access to the following tools. When the user's message requires an action,
output one or more fenced JSON blocks:

\`\`\`json
{"action": "<tool_name>", "params": { ... }}
\`\`\`

You can include multiple JSON blocks in one response for sequential actions.
You may include conversational text BEFORE, BETWEEN, or AFTER JSON blocks.
If no action is needed, respond normally without any JSON block.
CRITICAL: Never output a JSON block as a "suggestion" or "let me try" — every JSON block WILL be executed immediately. Only output a JSON block when you are certain the action should be performed.

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

46. birthday_add(name: string, date: string)
    Add or update a birthday for a contact. Name is the contact name (must exist in Google Contacts — creates one if not found). Date is MM-DD (e.g. "04-06" for April 6) or YYYY-MM-DD.

--- WEB SEARCH & FETCH ---

47. web_search(query: string, deep?: boolean, screenshot?: boolean)
    Search the web using DuckDuckGo. Returns titles, URLs, and snippets.
    Set deep=true to also fetch and extract the top 3 pages' full content (slower but more detailed).
    Set screenshot=true when the user asks for a screenshot/image of the results — this renders results as a visual page and captures a screenshot. ALWAYS set screenshot=true if the user mentions "screenshot", "screen", "immagine", "foto", "mostra", or "vedi" in relation to search results.
    ALWAYS use this for ANY web search request ("search for X", "find X", "look up X", "cerca X").
    Do NOT open Google/Bing in the browser for searches — use this tool instead. It's faster and never gets blocked.

48. fetch_url(url: string)
    Fetch a web page and extract its text content. SSRF-protected (blocks private IPs, localhost).
    Returns: title, excerpt, and body text (max 8000 chars). Only fetches text/html/json/xml.
    Use this when the user provides a specific URL to read, summarize, or analyze.

--- BROWSER AUTOMATION ---

49. browser_open(url: string, waitForLoad?: boolean)
    Open a URL in a headless Chrome browser. Launches Chrome automatically on first use.
    SSRF-protected (blocks private IPs, localhost). Renders JavaScript, SPAs, and dynamic pages.
    Use this when you need to interact with a page (click, type, screenshot) or when fetch_url fails on JS-rendered content.
    WARNING: Do NOT use this to search the web — use web_search instead. Google/Bing block automated browsers with CAPTCHAs.

50. browser_screenshot(saveTo?: string)
    Capture a screenshot of the current browser viewport (what's visible on screen).
    saveTo saves to a file path (e.g. "~/screenshot.png"). Returns base64-encoded image.
    ALWAYS use viewport screenshots (the default). Do NOT pass fullPage=true — it produces oversized images.
    Screenshots are automatically compressed as JPEG for efficiency.

51. browser_click(text?: string, selector?: string, x?: number, y?: number)
    Click an element on the page by visible text, CSS selector, or x/y coordinates.
    PREFERRED: use text="Rifiuta tutto" or text="Submit" to click buttons/links by their visible label (case-insensitive partial match).
    CSS selector: selector="#submit-btn", selector="a.nav-link"
    Coordinates: x=500, y=300 for precise clicking.
    Always try text first — it works for buttons, links, and any clickable element regardless of CSS structure.

52. browser_type(text: string, selector?: string, clear?: boolean, delay?: number)
    Type text into an input field. If selector is provided, clicks the element first to focus it.
    clear=true clears existing content before typing. delay=50 types with 50ms delay between keys.

53. browser_extract(selector?: string, mode?: "text"|"html"|"value"|"attribute", attribute?: string, all?: boolean)
    Extract content from the page. Default: extract all text from body.
    selector="h1" extracts the first h1 text. all=true extracts from ALL matching elements.
    mode="value" gets input values. mode="attribute" with attribute="href" gets link URLs.
    mode="html" gets raw HTML of the element.

54. browser_js(code: string)
    Execute arbitrary JavaScript in the browser page context and return the result.
    The code runs inside the page — you have access to document, window, fetch, etc.
    Example: "document.querySelectorAll('.item').length" returns the count of items.
    Use for complex interactions, form filling, or data extraction that other tools can't handle.

55. browser_wait(selector: string, timeout?: number, visible?: boolean)
    Wait for an element to appear on the page. Default timeout: 10 seconds.
    visible=true (default) waits for the element to be visible, not just in DOM.
    Use after clicking or navigating to wait for dynamic content to load.

56. browser_scroll(direction?: "up"|"down"|"top"|"bottom", amount?: number)
    Scroll the page. direction="down" (default) scrolls down 500px. "top"/"bottom" go to extremes.
    amount=1000 scrolls 1000px instead of default 500.

57. browser_key(key: string, ctrl?: boolean, shift?: boolean, alt?: boolean)
    Press a keyboard key. Keys: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space.
    ctrl=true holds Ctrl (or Cmd on Mac). Example: key="Enter" to submit a form.

58. browser_close()
    Close the browser. Frees resources. Browser auto-closes when NHA exits.

--- SCHEDULED TASKS ---

59. cron_add(schedule: string, prompt: string, agent?: string)
    Create a recurring background task. The daemon executes it automatically.
    Schedule formats: "every 5m", "every 2h", "every monday 9am", "daily 8:30", "at 14:00", "hourly".

60. cron_list()
    List all scheduled background tasks with their status, run count, and last result.

61. cron_remove(index: number)
    Remove a scheduled task by its number (1-based, from cron_list).

--- SCREEN & VISION ---

62. screen_capture(monitor?: number)
    Capture a screenshot of the user's desktop screen. Returns the image for visual analysis.
    Use when the user asks to look at their screen or analyze something visible.

63. screen_analyze(question: string)
    Capture the screen AND analyze it with vision. Combines capture + question.

--- CANVAS ---

64. canvas_render(html: string, title?: string)
    Render HTML in the web UI canvas panel. Show charts, tables, diagrams, reports.
    ALWAYS use Chart.js from CDN for charts and graphs — never build charts with raw HTML/CSS.
    Template for charts:
    <html><head><script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script></head>
    <body style="background:#0a0a0a;padding:20px;margin:0">
    <canvas id="c" style="max-height:400px"></canvas>
    <script>new Chart(document.getElementById('c'),{type:'bar',data:{labels:['A','B'],datasets:[{label:'Data',data:[10,20],backgroundColor:['#00ff41','#00e5ff']}]},options:{plugins:{legend:{labels:{color:'#ccc'}}},scales:{x:{ticks:{color:'#888'}},y:{ticks:{color:'#888'}}}}});</script>
    </body></html>
    Supported chart types: bar, line, pie, doughnut, radar, polarArea, scatter, bubble.
    Use dark theme: background #0a0a0a, text #ccc, grid #333, accent colors #00ff41 #00e5ff #ffaa00 #ff4444 #a78bfa.
    For tables: use proper HTML tables with dark styling. For Mermaid diagrams: load from CDN.

65. canvas_clear()
    Clear the canvas panel.

--- AGENT MESSENGER ---

66. collab_send(message: string, channel?: string)
    Send an E2E encrypted message to the active Alexandria channel (AgentMessenger).
    Use this when the user asks to notify collaborators, share progress, or send a message to other agents/team members.
    If channel is not specified, sends to the active channel.

67. collab_read(channel?: string, limit?: number)
    Read and decrypt messages from an Alexandria channel. Returns the latest messages (default 20).
    Use this when the user asks to check messages, read a conversation, or see what others wrote.
    If channel is not specified, reads from the active channel. Channel can be an ID or a name.

--- FILE MANAGER ---

68. file_list(path?: string, pattern?: string)
    List files and folders in a directory. Default path is the current working directory.
    pattern filters by glob (e.g. "*.js", "*.csv"). Shows: name, size, type (file/dir), modified date.
    Use when the user asks "show files", "what's in this folder", "list files in ~/Downloads".

69. file_read(path: string, lines?: number)
    Read the content of a text file. Returns up to 500 lines by default (adjustable with lines parameter).
    Supports: .txt, .md, .json, .csv, .js, .ts, .py, .html, .css, .xml, .yaml, .toml, .env, .log, .sh, and similar text formats.
    Use when the user asks "read this file", "show me the contents of", "open file X".
    For binary files (images, PDFs, etc.), returns file info instead of content.

70. file_write(path: string, content: string, append?: boolean)
    Write content to a file. Creates the file if it doesn't exist. Creates parent directories if needed.
    append=true adds to the end instead of overwriting.
    ALWAYS confirm with the user before writing. NEVER overwrite without permission.
    Use when the user asks "create a file", "save this to", "write to".

71. file_info(path: string)
    Get detailed info about a file or folder: size, created date, modified date, permissions, type, extension.
    For directories: also shows total items count and total size.
    Use when the user asks "how big is this file", "when was this modified", "file details".

72. file_search(query: string, path?: string, content?: boolean)
    Search for files by name. Default path is current directory, searches recursively.
    content=true also searches inside file contents (like grep). Max depth: 5 levels. Max results: 50.
    Use when the user asks "find files named", "search for", "where is the file".

--- GOOGLE DRIVE ---

73. drive_list(filter?: "recent"|"starred"|"shared", query?: string, maxResults?: number)
    List files from Google Drive. filter="recent" shows last 7 days, "starred" shows starred, "shared" shows shared with me.
    query is a search term to find files by name. Default: all files, 20 results.

74. drive_read(fileId: string)
    Read the text content of a Drive file. Works with Google Docs (exported as plain text), Sheets (as CSV), and any text/code file.
    Returns the content as text. For binary files (images, PDFs), use drive_download instead.

75. drive_upload(name: string, content: string, mimeType?: string, folderId?: string)
    Upload a new file to Google Drive. content is the file text content.
    mimeType defaults to "text/plain". folderId defaults to root.
    ALWAYS confirm before uploading. Use for creating new files on Drive.

76. drive_update(fileId: string, content: string)
    Update (overwrite) the content of an existing Drive file.
    ALWAYS confirm before updating. Use for saving edits to existing files.

77. drive_delete(fileId: string)
    Move a Drive file to trash. ALWAYS confirm before deleting.

78. drive_info(fileId: string)
    Get detailed metadata of a Drive file: size, type, owner, dates, sharing status, link.

79. drive_folder(folderId?: string)
    List files inside a specific Drive folder. Default: root folder.
    Returns files with their IDs, names, types, sizes.

80. drive_download(fileId: string)
    Download a file from Drive. For Google Docs/Sheets/Slides, exports as PDF.
    Returns the file as base64-encoded content. Use for binary files, PDFs, images.

RULES:
- ABSOLUTE RULE: NEVER LIE. NEVER fabricate, invent, or guess information. If you do not know, say "I don't know." If a tool fails, say it failed. If you cannot see something, say so. Honesty is MORE important than being helpful.
- CRITICAL ROUTING RULE — browser_open vs web_search:
  * "visita X.com", "vai su X", "apri X.com", "open X", "go to X" → ALWAYS use browser_open("https://X.com"). The user wants to SEE a specific website.
  * "cerca X", "search for X", "find X", "look up X" → ALWAYS use web_search. The user wants search results.
  * If the user mentions a SPECIFIC domain name (corriere.it, github.com, youtube.com, etc.) → browser_open, NEVER web_search.
  * NEVER open Google/Bing/DuckDuckGo in the browser — use web_search for searching.
  * web_search is for QUERIES. browser_open is for URLS. If it looks like a website name, it's a URL.
- For search/read operations, execute immediately and present results conversationally.
- For write/send/delete operations (gmail_send, gmail_reply, gmail_delete, calendar_create, calendar_move, calendar_update, contact_delete, task_done, notify_remind, file_write), DESCRIBE what you're about to do and include the JSON block so the system can ask the user for confirmation.
- For schedule_meeting and schedule_draft_email, execute immediately — these are read operations that suggest slots.
- When presenting email results, show From, Subject, Date, and a brief snippet. Never dump raw JSON.
- When presenting calendar events, show Time, Title, Location/Link. Format times in a human-readable way.
- When presenting tasks, show ID, Description, Priority, Status.
- When presenting slot proposals, show day, date, time range, and travel info clearly.
- If you need multiple actions in sequence (e.g., read an email then reply), do them ONE AT A TIME — wait for the result of each before proceeding.
- Dates: today is {{TODAY}}. Infer relative dates from this.
- The user's timezone is {{TIMEZONE}}.
- CRITICAL: when creating calendar events, always use LOCAL time in format "YYYY-MM-DDTHH:MM:SS" WITHOUT any Z suffix or timezone offset.
- LANGUAGE: Respond in {{LANGUAGE}}. All conversational text, explanations, and descriptions must be in {{LANGUAGE}}. Tool names and JSON blocks remain in English.
- BROWSER TIP: Cookie/consent banners are auto-dismissed when a page loads. Do NOT waste time clicking cookie buttons — the browser handles it automatically.
- BROWSER TIP: When extracting data from a page, prefer browser_js with code "document.body.innerText.slice(0, 3000)" to get all visible text. This is more reliable than guessing CSS selectors.
- API TIP: For npm package info, use fetch_url with the registry API: fetch_url("https://registry.npmjs.org/PACKAGE/latest") for version/description, and fetch_url("https://api.npmjs.org/downloads/point/last-week/PACKAGE") for weekly downloads. These are JSON APIs, much more reliable than scraping the npm website.
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
    case 'file_write':
      return `${params.append ? 'Append to' : 'Write'} file: ${params.path} (${params.content?.length || 0} chars)`;
    case 'drive_upload':
      return `Upload to Drive: ${params.name}`;
    case 'drive_update':
      return `Update Drive file: ${params.fileId}`;
    case 'drive_delete':
      return `Delete from Drive: ${params.fileId}`;
    default:
      return `Execute ${action}`;
  }
}

function driveIcon(type) {
  const icons = { folder: '📁', doc: '📄', sheet: '📊', slides: '🎬', pdf: '📕', image: '🖼️', video: '🎥', audio: '🎵', archive: '📦', text: '📝', file: '📄' };
  return icons[type] || icons.file;
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

  // Detect system language from locale
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  const langCode = locale.split('-')[0];
  const LANG_MAP = {
    en: 'English', it: 'Italian', es: 'Spanish', fr: 'French', de: 'German',
    pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', ja: 'Japanese',
    ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish',
    sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', cs: 'Czech',
    ro: 'Romanian', hu: 'Hungarian', el: 'Greek', th: 'Thai', vi: 'Vietnamese',
    uk: 'Ukrainian', he: 'Hebrew', id: 'Indonesian', ms: 'Malay',
  };
  const language = config?.language || LANG_MAP[langCode] || 'English';

  let prompt = TOOL_DEFINITIONS
    .replace('{{TODAY}}', today)
    .replace('{{TIMEZONE}}', tz)
    .replace(/\{\{LANGUAGE\}\}/g, language);

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

    // ── Birthday Add ──────────────────────────────────────────────────
    case 'birthday_add': {
      const gc = await import('./google-contacts.mjs');
      const name = params.name;
      const date = params.date;
      if (!name || !date) return 'Both name and date are required. Date format: MM-DD or YYYY-MM-DD.';

      // Search for existing contact
      let contacts = await gc.searchContacts(config, name, 5);
      let contact = contacts.find(c => c.name.toLowerCase().includes(name.toLowerCase()));

      if (!contact) {
        // Create the contact first
        contact = await gc.createContact(config, { name });
      }

      // Update birthday
      await gc.updateContact(config, contact.resourceName, { birthday: date });

      // Parse date for display
      const parts = date.split('-').map(Number);
      const month = parts.length === 3 ? parts[1] : parts[0];
      const day = parts.length === 3 ? parts[2] : parts[1];
      const monthName = new Date(2000, month - 1, 1).toLocaleDateString('en-US', { month: 'long' });

      return `Birthday set for ${contact.name}: ${monthName} ${day}. It will appear in the Birthdays tab.`;
    }

    // ── Browser Automation ────────────────────────────────────────────
    case 'browser_open': {
      const url = params.url;
      if (!url) return 'A URL is required.';

      // Intercept search engine URLs — redirect to web_search tool
      const searchEngines = /^https?:\/\/(www\.)?(google|bing|duckduckgo|yahoo|baidu|yandex)\.(com|it|co\.uk|de|fr|es|org|net)/i;
      if (searchEngines.test(url)) {
        // Extract search query if present in URL
        try {
          const u = new URL(url);
          const q = u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('p');
          if (q) {
            return `REDIRECT: Use web_search instead. Search engines block automated browsers. Executing web_search for "${q}"...\n\n` +
              await executeTool('web_search', { query: q }, config);
          }
        } catch {}
        return 'Do NOT open search engines in the browser — they block automated access with CAPTCHAs. Use the web_search tool instead: {"action": "web_search", "params": {"query": "your search terms"}}';
      }

      const be = await import('./browser-engine.mjs');
      const result = await be.browserOpen(url, {
        waitForLoad: params.waitForLoad !== false,
      });
      if (result.error) {
        // Navigate to blank to prevent stale screenshots from previous page
        try { await be.browserOpen('about:blank', { waitForLoad: false }); } catch {}
        return `Browser error: ${result.message}`;
      }

      return `Page loaded: "${result.title}"\nURL: ${result.url}`;
    }

    case 'browser_screenshot': {
      const be = await import('./browser-engine.mjs');
      if (!be.isBrowserRunning()) return 'No browser open. Use browser_open first.';

      // Check current URL — don't screenshot blank or error pages
      const currentInfo = await be.browserInfo();
      if (currentInfo.url === 'about:blank' || !currentInfo.url || currentInfo.url === '') {
        return 'No page loaded in browser. Use browser_open to navigate to a page first.';
      }

      // Scroll to top before screenshot so user sees the most important content
      await be.browserScroll({ direction: 'top' });
      await new Promise(r => setTimeout(r, 300));

      const saveTo = params.saveTo
        ? params.saveTo.replace(/^~/, os.homedir())
        : null;

      // Always use JPEG for efficiency (smaller base64, faster rendering in web UI)
      const result = await be.browserScreenshot({
        fullPage: false, // Always viewport — fullPage produces oversized images
        format: 'jpeg',
        quality: 75,
        saveTo,
      });
      if (result.error) return `Screenshot error: ${result.message}`;

      if (result.savedTo) {
        return `Screenshot saved to: ${result.savedTo} (${Math.round(result.size / 1024)}KB base64)`;
      }

      // Return base64 for LLM vision analysis
      return `Screenshot captured (${Math.round(result.size / 1024)}KB base64 PNG).\n[Base64 data available — use browser_js or browser_extract to analyze page content instead]`;
    }

    case 'browser_click': {
      const be = await import('./browser-engine.mjs');
      if (!be.isBrowserRunning()) return 'No browser open. Use browser_open first.';

      const result = await be.browserClick({
        text: params.text,
        selector: params.selector,
        x: params.x,
        y: params.y,
      });
      if (result.error) return `Click error: ${result.message}`;

      return `Clicked: ${result.selector} at (${result.x}, ${result.y})`;
    }

    case 'browser_type': {
      const be = await import('./browser-engine.mjs');
      if (!be.isBrowserRunning()) return 'No browser open. Use browser_open first.';

      if (!params.text) return 'Text is required.';

      const result = await be.browserType({
        text: params.text,
        selector: params.selector,
        clear: params.clear || false,
        delay: params.delay || 0,
      });
      if (result.error) return `Type error: ${result.message}`;

      return `Typed ${result.length} chars into ${result.selector}`;
    }

    case 'browser_extract': {
      const be = await import('./browser-engine.mjs');
      if (!be.isBrowserRunning()) return 'No browser open. Use browser_open first.';

      const result = await be.browserExtract({
        selector: params.selector || 'body',
        mode: params.mode || 'text',
        attribute: params.attribute,
        all: params.all || false,
      });
      if (result.error) return `Extract error: ${result.message}`;

      return `[${result.selector}] (${result.length} chars):\n${result.content}`;
    }

    case 'browser_js': {
      const be = await import('./browser-engine.mjs');
      if (!be.isBrowserRunning()) return 'No browser open. Use browser_open first.';

      if (!params.code) return 'JavaScript code is required.';

      const result = await be.browserEval(params.code);
      if (result.error) return `JS error: ${result.message}`;

      return `[${result.type}] ${result.result}`;
    }

    case 'browser_wait': {
      const be = await import('./browser-engine.mjs');
      if (!be.isBrowserRunning()) return 'No browser open. Use browser_open first.';

      if (!params.selector) return 'A CSS selector is required.';

      const result = await be.browserWaitFor(params.selector, {
        timeout: params.timeout || 10000,
        visible: params.visible !== false,
      });
      if (result.error) return `Wait failed: ${result.message}`;

      return `Element found: ${result.selector} (${result.elapsed}ms)`;
    }

    case 'browser_scroll': {
      const be = await import('./browser-engine.mjs');
      if (!be.isBrowserRunning()) return 'No browser open. Use browser_open first.';

      const result = await be.browserScroll({
        direction: params.direction || 'down',
        amount: params.amount || 500,
      });
      if (result.error) return `Scroll error: ${result.message}`;

      return `Scrolled ${result.direction}`;
    }

    case 'browser_key': {
      const be = await import('./browser-engine.mjs');
      if (!be.isBrowserRunning()) return 'No browser open. Use browser_open first.';

      if (!params.key) return 'A key name is required (e.g. Enter, Tab, Escape).';

      const result = await be.browserKeyPress(params.key, {
        ctrl: params.ctrl,
        shift: params.shift,
        alt: params.alt,
      });
      if (result.error) return `Key error: ${result.message}`;

      return `Pressed: ${result.key}`;
    }

    case 'browser_close': {
      const be = await import('./browser-engine.mjs');
      const result = await be.browserClose();
      return result.message;
    }

    // ── Web Search & Fetch ──────────────────────────────────────────────
    case 'web_search': {
      const wt = await import('./web-tools.mjs');
      const query = params.query;
      if (!query) return 'A search query is required.';

      if (params.deep) {
        const result = await wt.webSearchDeep(query, 3);
        if (result.error) return `Search error: ${result.message}`;
        if (result.results.length === 0) return `No results found for "${query}".`;

        const lines = [`Web search: "${query}" — ${result.resultCount} results, ${result.deepFetched} pages fetched\n`];

        // Deep results first (with content)
        for (const dr of result.deepResults) {
          lines.push(`--- ${dr.title} ---`);
          lines.push(`URL: ${dr.url}`);
          lines.push(dr.content.slice(0, 2000));
          lines.push('');
        }

        // Remaining results (snippets only)
        const deepUrls = new Set(result.deepResults.map(d => d.url));
        for (const r of result.results.filter(r => !deepUrls.has(r.url))) {
          lines.push(`${r.title}`);
          lines.push(`  ${r.url}`);
          if (r.snippet) lines.push(`  ${r.snippet}`);
        }

        return lines.join('\n');
      }

      const result = await wt.webSearch(query);
      if (result.error) return `Search error: ${result.message}`;
      if (result.results.length === 0) return `No results found for "${query}".`;

      const textResult = `Web search: "${query}" — ${result.resultCount} results\n\n` +
        result.results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
        ).join('\n\n');

      // If screenshot requested, render results as HTML in browser and capture
      if (params.screenshot) {
        try {
          const be = await import('./browser-engine.mjs');
          // Ensure browser is running
          if (!be.isBrowserRunning()) {
            await be.browserOpen('https://example.com', { waitForLoad: true });
          }
          // Build search results HTML
          const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
          const htmlItems = result.results.map((r, i) =>
            `<div style="margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #3c4043"><div style="font-size:18px;color:#8ab4f8;margin-bottom:4px;font-weight:600">${i + 1}. ${esc(r.title)}</div><div style="font-size:13px;color:#bdc1c6;margin-bottom:6px">${esc(r.url)}</div><div style="font-size:14px;color:#969ba1;line-height:1.5">${esc(r.snippet)}</div></div>`
          ).join('');
          const fullHtml = `<html><head><style>body{background:#202124;color:#e8eaed;font-family:Arial,Helvetica,sans-serif;padding:24px 40px;max-width:800px;margin:0 auto}h1{font-size:22px;color:#8ab4f8;margin-bottom:24px;border-bottom:2px solid #3c4043;padding-bottom:12px}</style></head><body><h1>Search results: "${esc(query)}"</h1>${htmlItems}<div style="color:#5f6368;font-size:12px;margin-top:16px">Powered by NHA web_search — ${result.resultCount} results via DuckDuckGo</div></body></html>`;
          // Render by injecting HTML into current page via JS
          await be.browserEval(`document.open();document.write(${JSON.stringify(fullHtml)});document.close();`);
          await new Promise(r => setTimeout(r, 300));
          const ss = await be.browserScreenshot({ fullPage: false, format: 'jpeg', quality: 75 });
          if (!ss.error) {
            // Save to disk for persistence
            const ssDir = path.join(os.homedir(), '.nha', 'screenshots');
            const fsMod = await import('fs');
            fsMod.mkdirSync(ssDir, { recursive: true });
            const ssFilename = `ss-${Date.now()}.jpg`;
            fsMod.writeFileSync(path.join(ssDir, ssFilename), Buffer.from(ss.base64, 'base64'));
            return textResult + `\n\n[Screenshot of results captured (${Math.round(ss.size / 1024)}KB) file:${ssFilename}]`;
          }
        } catch { /* screenshot failed */ }
      }

      return textResult;
    }

    case 'fetch_url': {
      const wt = await import('./web-tools.mjs');
      const url = params.url;
      if (!url) return 'A URL is required.';

      const result = await wt.fetchUrl(url);
      if (result.error) return `Fetch error: ${result.message}`;

      const lines = [];
      if (result.title) lines.push(`Title: ${result.title}`);
      lines.push(`URL: ${result.url || url}`);
      lines.push(`Status: ${result.status}`);
      if (result.truncated) lines.push('[Content was truncated due to size limits]');
      lines.push('');
      lines.push(result.body);

      return lines.join('\n');
    }

    // ── Cron / Heartbeat ───────────────────────────────────────────────
    case 'cron_add': {
      const { addCronJob } = await import('./ops-daemon.mjs');
      const result = addCronJob(params.schedule, params.prompt, { agent: params.agent || null });
      if (result.ok) return `Scheduled task created: "${params.schedule}" → "${params.prompt}". Start daemon with \`nha ops start\` if not running.`;
      return `Failed: ${result.error}`;
    }
    case 'cron_list': {
      const { listCronJobs } = await import('./ops-daemon.mjs');
      const jobs = listCronJobs();
      if (jobs.length === 0) return 'No scheduled tasks configured.';
      return jobs.map((j, i) => `${i + 1}. [${j.enabled ? 'active' : 'paused'}] ${j.schedule} → ${j.prompt} (runs: ${j.runCount}, last: ${j.lastRun ? new Date(j.lastRun).toLocaleString() : 'never'})`).join('\n');
    }
    case 'cron_remove': {
      const { removeCronJob } = await import('./ops-daemon.mjs');
      const result = removeCronJob(params.index || params.id);
      if (result.ok) return `Removed: "${result.removed.schedule}" → "${result.removed.prompt}"`;
      return `Failed: ${result.error}`;
    }

    // ── Screen Capture + Vision ──────────────────────────────────────────
    case 'screen_capture':
    case 'screen_analyze': {
      const { captureScreen } = await import('./screen-capture.mjs');
      const result = captureScreen({ monitor: params.monitor || 1 });
      if (!result.ok) return `Screen capture failed: ${result.error}`;
      const question = params.question || 'Describe EXACTLY and ONLY what you see in this screenshot.';
      return { __screenshot: true, path: result.path, base64: result.base64, question };
    }

    // ── Canvas ───────────────────────────────────────────────────────────
    case 'canvas_render': {
      if (!params.html) return 'Error: html parameter is required.';
      return `[CANVAS_RENDER]${JSON.stringify({ html: params.html, title: params.title || 'Canvas' })}[/CANVAS_RENDER]\nRendered in canvas panel.`;
    }
    case 'canvas_clear': {
      return '[CANVAS_CLEAR]Canvas cleared.[/CANVAS_CLEAR]';
    }

    // ── Agent Messenger ──────────────────────────────────────────────────
    case 'collab_send': {
      const { addCronJob, listCronJobs, loadChannels, getActiveChannel } = await import('./ops-daemon.mjs').catch(() => ({}));
      const collabMod = await import('../commands/collab.mjs').catch(() => null);
      if (!collabMod) return 'AgentMessenger not available.';

      const msg = params.message;
      if (!msg) return 'Message is required.';

      // Use collab CLI to send
      try {
        const fs = await import('fs');
        const path = await import('path');
        const crypto = await import('crypto');
        const os = await import('os');
        const NHA_DIR = path.default.join(os.default.homedir(), '.nha');
        const chFile = path.default.join(NHA_DIR, 'collab', 'channels.json');
        const idFile = path.default.join(NHA_DIR, 'collab', 'identity.json');

        if (!fs.default.existsSync(chFile) || !fs.default.existsSync(idFile)) {
          return 'No Alexandria channels configured. Create one first: nha collab create "name"';
        }

        const channels = JSON.parse(fs.default.readFileSync(chFile, 'utf-8'));
        const identity = JSON.parse(fs.default.readFileSync(idFile, 'utf-8'));
        const channel = params.channel
          ? channels.find(c => c.name?.toLowerCase().includes(params.channel.toLowerCase()) || c.id === params.channel)
          : channels.find(c => c.active) || channels[0];

        if (!channel) return 'No active channel found.';

        const API = 'https://nothumanallowed.com/api/v1/alexandria';
        const channelKey = crypto.default.createHash('sha256').update('alexandria-e2e-key-v2').update(channel.id).update(channel.secret || '').digest();
        const nonce = crypto.default.randomBytes(12);
        const cipher = crypto.default.createCipheriv('aes-256-gcm', channelKey, nonce);
        const encrypted = Buffer.concat([cipher.update(msg, 'utf-8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        const ciphertext = Buffer.concat([encrypted, tag]).toString('base64');

        const r = await fetch(API + '/channels/' + channel.id + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senderFingerprint: identity.fingerprint, nonce: nonce.toString('base64'), ciphertext, type: 'text' }),
        });

        if (!r.ok) return `Failed to send: ${r.status}`;
        return `Message sent to "${channel.name}" (encrypted). Other members will see it in real-time.`;
      } catch (e) {
        return `Failed to send: ${e.message}`;
      }
    }

    case 'collab_read': {
      try {
        const fs2 = await import('fs');
        const path2 = await import('path');
        const crypto2 = await import('crypto');
        const os2 = await import('os');
        const NHA2 = path2.default.join(os2.default.homedir(), '.nha');
        const chFile2 = path2.default.join(NHA2, 'collab', 'channels.json');
        const idFile2 = path2.default.join(NHA2, 'collab', 'identity.json');

        if (!fs2.default.existsSync(chFile2) || !fs2.default.existsSync(idFile2)) {
          return 'No Alexandria channels configured.';
        }

        const channels2 = JSON.parse(fs2.default.readFileSync(chFile2, 'utf-8'));
        const identity2 = JSON.parse(fs2.default.readFileSync(idFile2, 'utf-8'));
        const channel2 = params.channel
          ? channels2.find(c => c.name?.toLowerCase().includes(params.channel.toLowerCase()) || c.id === params.channel || c.id.startsWith(params.channel))
          : channels2.find(c => c.active) || channels2[0];

        if (!channel2) return 'No matching channel found.';

        const AAPI = 'https://nothumanallowed.com/api/v1/alexandria';
        const r2 = await fetch(AAPI + '/channels/' + channel2.id + '/messages?fp=' + identity2.fingerprint);
        if (!r2.ok) return 'Channel not found or expired.';
        const data2 = await r2.json();
        if (!data2.messages || data2.messages.length === 0) return `No messages in "${channel2.name}".`;

        const cKey = crypto2.default.createHash('sha256').update('alexandria-e2e-key-v2').update(channel2.id).update(channel2.secret || '').digest();
        const lim = params.limit || 20;
        const msgs2 = data2.messages.slice(-lim);
        const lines = [`Channel: ${channel2.name} (${data2.messages.length} total)\n`];

        for (const msg of msgs2) {
          if (msg.type === 'system') { lines.push('[system] member joined'); continue; }
          let content = '[encrypted]';
          if (msg.ciphertext && msg.nonce) {
            try {
              const nonce = Buffer.from(msg.nonce, 'base64');
              const raw = Buffer.from(msg.ciphertext, 'base64');
              const tag = raw.subarray(raw.length - 16);
              const enc = raw.subarray(0, raw.length - 16);
              const dec = crypto2.default.createDecipheriv('aes-256-gcm', cKey, nonce);
              dec.setAuthTag(tag);
              content = dec.update(enc) + dec.final('utf-8');
            } catch {}
          }
          const sender = data2.members?.find(m => m.fingerprint === msg.senderFingerprint);
          const time = new Date(msg.timestamp).toLocaleTimeString();
          lines.push(`[${time}] ${sender?.displayName || '?'}: ${content}`);
        }

        return lines.join('\n');
      } catch (e) {
        return `Failed to read: ${e.message}`;
      }
    }

    // ── Google Drive ──────────────────────────────────────────────────────
    case 'drive_list': {
      const drv = await import('./google-drive.mjs');
      let files;
      if (params.query) {
        files = await drv.searchFiles(config, params.query, params.maxResults || 20);
      } else if (params.filter === 'recent') {
        files = await drv.getRecentFiles(config, params.maxResults || 20);
      } else if (params.filter === 'starred') {
        files = await drv.getStarredFiles(config, params.maxResults || 20);
      } else if (params.filter === 'shared') {
        files = await drv.getSharedFiles(config, params.maxResults || 20);
      } else {
        files = await drv.listFiles(config, params.maxResults || 20);
      }
      if (files.length === 0) return 'No files found on Drive.';
      return files.map((f, i) =>
        `${i + 1}. [${f.id}] ${driveIcon(f.type)} ${f.name}${f.size ? ' (' + f.size + ')' : ''} — ${f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ''}${f.shared ? ' [shared]' : ''}${f.starred ? ' ★' : ''}`
      ).join('\n');
    }

    case 'drive_read': {
      if (!params.fileId) return 'Error: fileId required. Use drive_list first to get file IDs.';
      const drv = await import('./google-drive.mjs');
      const text = await drv.readFileAsText(config, params.fileId);
      if (text.length > 10000) return text.slice(0, 10000) + '\n\n[... truncated at 10000 chars]';
      return text;
    }

    case 'drive_upload': {
      if (!params.name || !params.content) return 'Error: name and content required.';
      const drv = await import('./google-drive.mjs');
      const uploaded = await drv.uploadFile(config, params.name, params.content, params.mimeType || 'text/plain', params.folderId || 'root');
      return `Uploaded: ${uploaded.name} (${uploaded.size || ''}) — ${uploaded.webViewLink || uploaded.id}`;
    }

    case 'drive_update': {
      if (!params.fileId || !params.content) return 'Error: fileId and content required.';
      const drv = await import('./google-drive.mjs');
      const updated = await drv.updateFileContent(config, params.fileId, params.content);
      return `Updated: ${updated.name} — ${updated.webViewLink || updated.id}`;
    }

    case 'drive_delete': {
      if (!params.fileId) return 'Error: fileId required.';
      const drv = await import('./google-drive.mjs');
      await drv.trashFile(config, params.fileId);
      return `File ${params.fileId} moved to trash.`;
    }

    case 'drive_info': {
      if (!params.fileId) return 'Error: fileId required.';
      const drv = await import('./google-drive.mjs');
      const f = await drv.getFile(config, params.fileId);
      return [
        `Name: ${f.name}`,
        `Type: ${f.type} (${f.mimeType})`,
        `Size: ${f.size || 'unknown'}`,
        `Modified: ${f.modifiedTime}`,
        `Created: ${f.createdTime || 'unknown'}`,
        `Owner: ${f.owner}`,
        `Shared: ${f.shared ? 'yes' : 'no'}`,
        `Starred: ${f.starred ? 'yes' : 'no'}`,
        `Link: ${f.webViewLink}`,
        f.description ? `Description: ${f.description}` : '',
      ].filter(Boolean).join('\n');
    }

    case 'drive_folder': {
      const drv = await import('./google-drive.mjs');
      const files = await drv.listFolder(config, params.folderId || 'root', 30);
      if (files.length === 0) return 'Empty folder.';
      return files.map((f, i) =>
        `${i + 1}. [${f.id}] ${driveIcon(f.type)} ${f.name}${f.size ? ' (' + f.size + ')' : ''}`
      ).join('\n');
    }

    case 'drive_download': {
      if (!params.fileId) return 'Error: fileId required.';
      const drv = await import('./google-drive.mjs');
      const dl = await drv.downloadFileContent(config, params.fileId);
      return `Downloaded: ${dl.name} (${formatFileSize(dl.size)}, ${dl.mimeType})\n[File content available as base64 — ${dl.base64.length} chars]`;
    }

    // ── File Manager (Local) ────────────────────────────────────────────
    case 'file_list': {
      const fsM = await import('fs');
      const pathM = await import('path');
      const osM = await import('os');
      let dir = params.path || process.cwd();
      dir = dir.replace(/^~/, osM.default.homedir());
      dir = pathM.default.resolve(dir);

      if (!fsM.default.existsSync(dir)) return `Directory not found: ${dir}`;
      if (!fsM.default.statSync(dir).isDirectory()) return `Not a directory: ${dir}`;

      // Security: block sensitive paths
      const blocked = ['/etc/shadow', '/etc/passwd', '.ssh/id_', '.gnupg/', 'Keychain'];
      if (blocked.some(b => dir.includes(b))) return 'Access denied — sensitive path.';

      let entries = fsM.default.readdirSync(dir, { withFileTypes: true });

      // Pattern filter
      if (params.pattern) {
        const pat = params.pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
        const re = new RegExp(`^${pat}$`, 'i');
        entries = entries.filter(e => re.test(e.name));
      }

      if (entries.length === 0) return `Empty directory: ${dir}`;

      const lines = entries.slice(0, 100).map(e => {
        const full = pathM.default.join(dir, e.name);
        try {
          const st = fsM.default.statSync(full);
          const size = e.isDirectory() ? '<DIR>' : formatFileSize(st.size);
          const mod = st.mtime.toISOString().split('T')[0];
          return `${e.isDirectory() ? 'd' : '-'} ${size.padStart(10)}  ${mod}  ${e.name}`;
        } catch {
          return `?          ?           ${e.name}`;
        }
      });

      return `${dir}/ (${entries.length} items${entries.length > 100 ? ', showing first 100' : ''})\n\n${lines.join('\n')}`;
    }

    case 'file_read': {
      const fsR = await import('fs');
      const pathR = await import('path');
      const osR = await import('os');
      let filePath = params.path;
      filePath = filePath.replace(/^~/, osR.default.homedir());
      filePath = pathR.default.resolve(filePath);

      if (!fsR.default.existsSync(filePath)) return `File not found: ${filePath}`;
      const stat = fsR.default.statSync(filePath);

      if (stat.isDirectory()) return `"${filePath}" is a directory. Use file_list to browse it.`;

      // Block sensitive files
      const sensitivePatterns = ['.ssh/id_', '.gnupg/', 'Keychain', '.env', 'credentials', 'secret', '.npmrc', '.pypirc'];
      if (sensitivePatterns.some(p => filePath.includes(p))) return 'Access denied — sensitive file.';

      // Binary check
      const ext = pathR.default.extname(filePath).toLowerCase();
      const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.mp3', '.mp4', '.avi', '.mov', '.zip', '.tar', '.gz', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.woff', '.woff2', '.ttf', '.otf', '.eot']);
      if (binaryExts.has(ext)) {
        return `Binary file: ${pathR.default.basename(filePath)} (${formatFileSize(stat.size)}, ${ext} format). Cannot display content.`;
      }

      // Size check
      if (stat.size > 1024 * 1024) return `File too large to display: ${formatFileSize(stat.size)}. Use file_info for details.`;

      const maxLines = params.lines || 500;
      const content = fsR.default.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const truncated = lines.length > maxLines;
      const display = lines.slice(0, maxLines).join('\n');

      return `${pathR.default.basename(filePath)} (${formatFileSize(stat.size)}, ${lines.length} lines)${truncated ? ` [showing first ${maxLines}]` : ''}\n\n${display}`;
    }

    case 'file_write': {
      const fsW = await import('fs');
      const pathW = await import('path');
      const osW = await import('os');
      let writePath = params.path;
      writePath = writePath.replace(/^~/, osW.default.homedir());
      writePath = pathW.default.resolve(writePath);

      // Block writing to sensitive locations
      const blockedWrite = ['/etc/', '/usr/', '/bin/', '/sbin/', '/System/', '/Library/', '.ssh/', '.gnupg/', 'node_modules/'];
      if (blockedWrite.some(b => writePath.includes(b))) return 'Access denied — cannot write to system/sensitive paths.';

      // Create parent directories
      const dir = pathW.default.dirname(writePath);
      if (!fsW.default.existsSync(dir)) {
        fsW.default.mkdirSync(dir, { recursive: true });
      }

      if (params.append) {
        fsW.default.appendFileSync(writePath, params.content, 'utf-8');
        return `Appended ${params.content.length} chars to ${writePath}`;
      } else {
        fsW.default.writeFileSync(writePath, params.content, 'utf-8');
        return `Written ${params.content.length} chars to ${writePath}`;
      }
    }

    case 'file_info': {
      const fsI = await import('fs');
      const pathI = await import('path');
      const osI = await import('os');
      let infoPath = params.path;
      infoPath = infoPath.replace(/^~/, osI.default.homedir());
      infoPath = pathI.default.resolve(infoPath);

      if (!fsI.default.existsSync(infoPath)) return `Not found: ${infoPath}`;
      const st = fsI.default.statSync(infoPath);

      const info = [
        `Path: ${infoPath}`,
        `Type: ${st.isDirectory() ? 'directory' : 'file'}`,
        `Size: ${formatFileSize(st.size)}`,
        `Created: ${st.birthtime.toISOString()}`,
        `Modified: ${st.mtime.toISOString()}`,
        `Permissions: ${(st.mode & 0o777).toString(8)}`,
      ];

      if (!st.isDirectory()) {
        info.push(`Extension: ${pathI.default.extname(infoPath) || '(none)'}`);
      } else {
        try {
          const items = fsI.default.readdirSync(infoPath);
          info.push(`Items: ${items.length}`);
        } catch { /* permission denied */ }
      }

      return info.join('\n');
    }

    case 'file_search': {
      const fsS = await import('fs');
      const pathS = await import('path');
      const osS = await import('os');
      let searchDir = params.path || process.cwd();
      searchDir = searchDir.replace(/^~/, osS.default.homedir());
      searchDir = pathS.default.resolve(searchDir);

      if (!fsS.default.existsSync(searchDir)) return `Directory not found: ${searchDir}`;

      const query = params.query.toLowerCase();
      const searchContent = params.content || false;
      const results = [];
      const maxDepth = 5;
      const maxResults = 50;

      function searchRecursive(dir, depth) {
        if (depth > maxDepth || results.length >= maxResults) return;
        try {
          const entries = fsS.default.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= maxResults) break;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

            const full = pathS.default.join(dir, entry.name);

            // Name match
            if (entry.name.toLowerCase().includes(query)) {
              const st = fsS.default.statSync(full);
              results.push(`${entry.isDirectory() ? 'd' : '-'} ${formatFileSize(st.size).padStart(10)}  ${full}`);
            }

            // Content search
            if (searchContent && entry.isFile() && !entry.name.match(/\.(png|jpg|gif|mp4|zip|tar|gz|exe|bin|pdf|woff|ttf)$/i)) {
              try {
                const st = fsS.default.statSync(full);
                if (st.size < 512 * 1024) { // Max 512KB per file
                  const content = fsS.default.readFileSync(full, 'utf-8');
                  if (content.toLowerCase().includes(query)) {
                    const lineNum = content.split('\n').findIndex(l => l.toLowerCase().includes(query)) + 1;
                    if (!results.some(r => r.includes(full))) {
                      results.push(`- ${formatFileSize(st.size).padStart(10)}  ${full}:${lineNum} (content match)`);
                    }
                  }
                }
              } catch { /* skip unreadable */ }
            }

            if (entry.isDirectory()) searchRecursive(full, depth + 1);
          }
        } catch { /* permission denied */ }
      }

      searchRecursive(searchDir, 0);

      if (results.length === 0) return `No files matching "${params.query}" in ${searchDir}`;
      return `Found ${results.length} match${results.length > 1 ? 'es' : ''} for "${params.query}":\n\n${results.join('\n')}`;
    }

    default:
      return `Unknown action: ${action}`;
  }
}
