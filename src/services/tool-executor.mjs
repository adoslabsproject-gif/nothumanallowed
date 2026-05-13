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
  deleteEvent,
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

// ── execute_code: module-level tsx path cache ─────────────────────────────────
// Resolved once lazily (first TypeScript execution) — avoids shell spawn on every call.
import { execSync as _execSyncTsx } from 'child_process';
let _tsxPath = undefined; // undefined = not yet resolved; null = not found; string = path
function getTsxPath() {
  if (_tsxPath !== undefined) return _tsxPath;
  try { _tsxPath = _execSyncTsx('which tsx 2>/dev/null', { timeout: 3000 }).toString().trim() || null; }
  catch { _tsxPath = null; }
  return _tsxPath;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Actions that mutate external state and require user confirmation. */
export const DESTRUCTIVE_ACTIONS = new Set([
  // Gmail
  'gmail_send', 'gmail_send_attach', 'gmail_reply', 'gmail_delete',
  'gmail_mark_read', 'gmail_mark_starred', 'gmail_archive', 'gmail_trash',
  // IMAP (custom email accounts)
  'imap_send', 'imap_reply', 'imap_bulk_send', 'imap_send_template',
  'imap_trash', 'imap_mark_read', 'imap_mark_starred', 'imap_draft',
  // Calendar
  'calendar_create', 'calendar_move', 'calendar_update', 'calendar_delete',
  // Contacts
  'contact_add', 'contact_update', 'contact_delete',
  // Tasks (local) + Google Tasks
  'task_add', 'task_done', 'task_delete', 'task_clear',
  'gtask_add', 'gtask_complete', 'gtask_delete',
  // Notes
  'note_add',
  // Reminders / notifications
  'notify_remind', 'reminder_create',
  // Slack
  'slack_send', 'slack_dm', 'slack_react', 'slack_mark_read',
  // Notion
  'notion_page', 'notion_update',
  // GitHub
  'github_create_issue', 'github_comment',
  // File system (local)
  'file_write', 'file_move', 'file_delete', 'file_mkdir',
  // Google Drive
  'drive_upload', 'drive_update', 'drive_delete', 'drive_move', 'drive_share',
  // Birthdays
  'birthday_add', 'birthday_update', 'birthday_delete',
  // Alexandria messaging
  'alexandria_send',
  // Cron / scheduling
  'cron_create', 'cron_delete',
  // Portfolio (local file)
  'portfolio_add', 'portfolio_remove', 'portfolio_tx_add',
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

13b. calendar_month(month?: string)
    List ALL events for a full calendar month. month is YYYY-MM (e.g. "2026-05"). Defaults to current month.
    USE THIS when the user asks for events in a month: "appuntamenti di maggio", "eventi di giugno", "show me April", "cosa ho in marzo".
    NEVER use calendar_find with month names — use calendar_month instead.

14. calendar_create(summary: string, start: string, end: string, attendees?: string[], description?: string)
    Create a NEW calendar event. start/end are ISO 8601 datetime strings.
    Use this when the user says: "inserisci", "aggiungi", "crea", "metti", "fissa", "prenota", "add", "create", "schedule", "book".

    PARAMETER MEANING (CRITICAL — most common mistake):
      - summary  = the TITLE of the event (what you'd write on a calendar grid). Short, derived from what the user said.
      - description = optional NOTES/details. Leave empty unless the user gave extra context that doesn't fit in the title.
      - NEVER put the title in description. NEVER leave summary empty.

    Always derive summary, date and time from the actual user message — never use literal values from this documentation.

    IMPORTANT: When user says "inserisci appuntamento" or "crea evento" → use calendar_create, NOT calendar_find.
    Extract the summary, date, and time from the user message. If end time is not specified, default to 1 hour after start.
    The tool RESPONSE will include the real eventId in parentheses (a long lowercase alphanumeric Google ID — NEVER invent one). REMEMBER this exact value. If the user later says "correggi", "modifica", "cambia", "sposta", "elimina" referring to this same event, use calendar_update / calendar_move / calendar_delete with that exact eventId — do NOT create a second event. Never use placeholder IDs like "ABC123" or "event_123" — those are illustrative only.

15. calendar_move(eventId: string, newStart: string, newEnd: string)
    Reschedule an event. ALWAYS confirm before moving.

16. calendar_date(date: string)
    List all events for a specific date (YYYY-MM-DD). Use this when the user asks about a specific day (e.g. "May 13", "next Tuesday"). ALWAYS prefer this over calendar_week when a specific date is mentioned.

17. calendar_find(query: string, daysAhead?: number)
    Search for a calendar event by name/keyword in the next N days (default 30). Returns matching events with their IDs.
    ALWAYS use this FIRST when the user wants to modify an event — you need the eventId.

18. calendar_update(eventId: string, summary?: string, location?: string, description?: string, start?: string, end?: string)
    Update ANY field of an existing calendar event: title, location, description, start time, end time.
    Only include fields that need to change.

    HOW TO GET eventId — IN ORDER OF PREFERENCE:
      1. From your OWN previous tool response in this conversation: when you ran calendar_create / calendar_find / calendar_date earlier, the response contained the REAL eventId (a long lowercase alphanumeric Google-issued string). Use that exact value verbatim.
      2. If step 1 doesn't apply, call calendar_find or calendar_date FIRST to look it up.
      3. NEVER fabricate an eventId. NEVER copy placeholder strings from this documentation. Real eventIds come from Google Calendar tool responses only.

    CRITICAL — "CORREGGI" / "MODIFICA" / "CAMBIA TITOLO" mappings:
      When the user says "correggi", "modifica", "cambia", "rinomina", "sposta", "aggiorna" referring to the most recent event you just created, use calendar_update with the real eventId returned by your previous calendar_create call.
      Do NOT call calendar_create a second time — that would create a DUPLICATE event.

19. calendar_delete(eventId: string)
    Delete (permanently remove) a calendar event by its eventId.
    You MUST call calendar_find first to get the eventId. ALWAYS confirm with the user before deleting.

20. schedule_meeting(clientName: string, subject: string, location: string, durationMinutes: number, dateFrom: string, dateTo: string, workdayStart?: number, workdayEnd?: number)
    Find optimal meeting slots considering existing calendar events, locations, and estimated travel time between appointments. Returns ranked slots with travel info. dateFrom and dateTo are YYYY-MM-DD.

20. schedule_draft_email(clientName: string, subject: string, location: string, durationMinutes: number, dateFrom: string, dateTo: string)
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

41. slack_send(channel: string, text: string, threadTs?: string)
    Send a message to a Slack channel. ALWAYS confirm before sending.
    If threadTs is provided, post as a thread reply instead of a top-level message.

41b. slack_search(query: string, count?: number)
     Full-text search messages across the whole Slack workspace. Returns the most
     recent matches with channel, user, text and a Slack permalink each. Use this
     for "find the message where X talked about Y", "trova il messaggio di Marco
     su X", "did anyone post about the release", etc.

41c. slack_dm(user: string, text?: string)
     Open or send a direct message to a user. The user parameter accepts a Slack
     user ID (Uxxx), username, real name, or email — the tool resolves them
     automatically. If text is provided, the message is sent immediately; otherwise
     the DM channel is just opened.

41d. slack_thread(channel: string, ts: string)
     List all replies in a thread. ts is the parent message timestamp (returned
     by slack_messages or slack_search). Use this before posting a contextual
     reply with slack_send + threadTs.

41e. slack_react(channel: string, ts: string, emoji: string)
     Add an emoji reaction to a message. emoji is the name without colons
     (e.g. "thumbsup", "rocket", "white_check_mark"). Confirm before reacting on
     someone else's message.

41f. slack_mark_read(channel: string, ts?: string)
     Mark a Slack channel as read up to a given timestamp (default: now).

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

49. get_weather(location: string, lang?: string)
    Get current weather and 3-day forecast for any city or location. No API key needed.
    Returns: temperature (°C/°F), feels like, humidity, wind speed, UV index, weather condition, and 3-day forecast.
    ALWAYS use this for weather requests ("meteo", "tempo", "weather", "temperatura", "piove", "sole", "forecast").
    Examples: get_weather("Viterbo"), get_weather("Rome, Italy"), get_weather("New York")

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

--- IMAP EMAIL (custom accounts) ---

64. imap_list(accountId: string, labelId?: string, search?: string, limit?: number)
    List emails from a custom IMAP account. accountId is known from the IMAP ACCOUNTS section above — use it directly.
    search does full-text match on subject, from_address, from_name, body. Use it to filter by sender name/domain.
    Example: search="zeli" finds all emails from *@zeli.it or with "zeli" in subject/body.
    Returns: [{id, subject, from_address, from_name, internal_date, body_preview, is_read, is_starred}]

65. imap_accounts()
    List all configured IMAP accounts. NOTE: accounts are already listed in the IMAP ACCOUNTS section above.
    Only call this if you need to refresh or the section is missing.

66. imap_read(messageId: string)
    Read a full email message from the local DB by its id. Returns subject, from, to, body_text, body_html, and a numbered ATTACHMENTS list.
    If the email has attachments, follow up with imap_attachment_read to read each one's content.

66b. imap_attachment_read(messageId: string, filename?: string, index?: number, attachmentId?: string)
    Download and parse an attachment of a given email. messageId is required; pick the attachment by filename (substring match,
    case-insensitive), 1-based index, or attachmentId (exact). Returns extracted text for PDF (text-based POs/quotes/invoices),
    DOCX (Word), and any text/* type. For image-based PDFs or unsupported binary types, returns metadata and instructs the
    user to share the relevant section as text. Use this whenever the user says "leggi l'allegato", "read the attachment",
    "estrai dati dall'allegato", "what's in the PDF", etc.

67. imap_send(accountId: string, to: string, subject: string, bodyHtml: string, cc?: string, inReplyTo?: string)
    Send an email via SMTP from a configured IMAP account. ALWAYS confirm with user before sending.
    bodyHtml can contain HTML. inReplyTo is the Message-ID of the original email for threading.

68. imap_sync(accountId: string)
    Trigger an incremental IMAP sync for an account. Fetches new messages into local DB.
    Run this before imap_list if you need fresh data.

69. imap_labels(accountId: string)
    List all labels for an IMAP account (system + user-defined). Returns [{id, name, system_type, color, unread_count}].

70. imap_mark_read(messageId: string, isRead?: boolean)
    Mark a local message as read or unread. Does NOT touch the IMAP server. Default isRead=true.

71. imap_reply(accountId: string, messageId: string, bodyHtml: string, cc?: string)
    Reply to an existing email. Automatically sets In-Reply-To and References headers for proper threading.
    Fetches the original message from DB to build correct subject (Re: ...) and recipient.
    ALWAYS confirm with user before sending.

72. imap_thread(accountId: string, threadId: string)
    Read all messages in a thread. Returns them in chronological order with subject, from, date, body.
    Use imap_read() to get the threadId from a message.

73. imap_search(accountId: string, query: string, limit?: number)
    Full-text search across all synced emails (subject, body_preview, from_address, from_name).
    query is a plain text string — use sender name, domain, or keyword.
    Examples: "zeli" finds emails from *@zeli.it. "fattura" finds emails with that word. limit defaults to 20.

74. imap_mark_starred(messageId: string, isStarred?: boolean)
    Star or unstar a message locally. Default isStarred=true.

75. imap_trash(messageId: string)
    Move a message to local Trash (soft delete — does NOT touch IMAP server). ALWAYS confirm.

76. imap_draft(accountId: string, to: string, subject: string, bodyHtml: string)
    Save a draft locally. Safe — does not send anything.

77. imap_send_template(accountId: string, to: string, templateId: string, vars: object)
    Send an email using a built-in marketing template. templateId is one of:
    "promo_product" | "newsletter" | "follow_up" | "offerta" | "evento" | "ringraziamento"
    vars is a key-value object to replace [PLACEHOLDERS] in the template, e.g.:
    {"AZIENDA": "Zeli Srl", "TITOLO OFFERTA": "Sconto 20%", "LINK_CTA": "https://..."}
    ALWAYS confirm with user before sending.

78. imap_bulk_send(accountId: string, recipients: string[], subject: string, templateId: string, vars: object, perRecipientVars?: object)
    Send a templated email to multiple recipients (marketing campaign).
    recipients: array of email addresses.
    vars: global placeholders applied to all.
    perRecipientVars: optional object keyed by email with per-recipient overrides, e.g. {"mario@co.it": {"NOME": "Mario"}}.
    Sends one-by-one with 1s delay to avoid spam filters. ALWAYS confirm with user — shows recipient count.

--- CANVAS ---

71. canvas_render(html: string, title?: string)
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

--- FINANCIAL MARKET DATA (Real-time) ---

82. market_price(ticker: string)
    Get the real-time price quote for any stock, ETF, index, forex pair, or futures contract.
    Uses Yahoo Finance — no API key needed. Returns: price, change %, day range, 52-week range, volume.
    ticker examples: "AAPL" (Apple), "TSLA" (Tesla), "ENI.MI" (Borsa Italiana), "BMW.DE" (DAX),
    "BTC-USD" (Bitcoin), "GC=F" (Gold futures), "EURUSD=X" (EUR/USD forex), "^GSPC" (S&P 500).
    ALWAYS use this before any financial analysis — get real data first.

83. market_chart(ticker: string, period?: string, interval?: string)
    Get OHLCV price history + computed technical indicators (RSI-14, MACD 12/26/9, EMA-20, EMA-50, ATR-14).
    period: "1d" "5d" "1mo" "3mo" "6mo" "1y" "2y" "5y" "ytd" "max". Default: "3mo".
    interval: "1m" "5m" "15m" "1h" "1d" "1wk" "1mo". Default: "1d".
    Returns last 10 candles + full indicator breakdown + trend signal.
    Use this for technical analysis, support/resistance, momentum assessment.

84. market_indicators(ticker: string)
    Get comprehensive fundamental analysis: P/E, P/B, PEG, EV/EBITDA, EV/Revenue, gross/EBITDA/profit margins,
    ROE, ROA, debt/equity, current ratio, quick ratio, revenue growth, market cap, enterprise value,
    dividend yield, beta, short interest, analyst consensus (buy/hold/sell), and price target.
    Use this for fundamental/value analysis, DCF inputs, and screener-style evaluation.

85. macro_data(indicator?: string)
    Get real-time macroeconomic data. indicator: "all" | "yield" | "commodities" | "indices" | "macro".
    Default: "all" — returns everything.
    - yield: U.S. Treasury yield curve (3M/5Y/10Y/30Y) + inversion status (recession signal)
    - commodities: Gold, Silver, WTI Crude, Natural Gas, EUR/USD, DXY Dollar Index
    - indices: S&P 500, Nasdaq 100, Dow, Russell 2000, VIX, EURO STOXX 50, DAX, CAC 40, Nikkei, Shanghai
    - macro: FRED indicators (Fed Funds Rate, CPI, Unemployment, GDP) — requires FRED_API_KEY
    ALWAYS use this for macro regime analysis, risk-on/risk-off context, and cross-asset positioning.

86. crypto_data(coin: string, vs_currency?: string)
    Get real-time crypto data from CoinGecko (no API key needed, 60 req/min free tier).
    coin: CoinGecko ID like "bitcoin", "ethereum", "solana", "ripple". vs_currency default: "usd".
    Returns: price, 24h/7d/30d/1y performance, market cap, volume, ATH, circulating supply,
    max supply, sparkline momentum signal, and global crypto market context (BTC/ETH dominance).
    Also returns supply scarcity % and ATH distance zone (fear/greed proxy).

87. market_news(ticker?: string, query?: string, limit?: number)
    Get latest financial news from Yahoo Finance for a ticker or topic. limit default: 10, max: 20.
    ticker: "AAPL", "BTC-USD", "^SPX" — returns news specific to that asset.
    query: free-text like "Federal Reserve inflation", "AI chips", "earnings season".
    Returns: headline, source, publish time, and URL for each article.

88. earnings_calendar(ticker: string, days?: number)
    Next earnings date + EPS/revenue estimates + last 4 quarters surprise history + analyst trend for next quarter.
    Use BEFORE any near-term trade idea — earnings move stocks more than fundamentals.

89. dividend_calendar(ticker: string)
    Dividend yield, payout ratio, next ex-dividend date, next pay date, 5y average yield.

90. economic_calendar(country?: string, days?: number)
    Upcoming macroeconomic releases (FOMC, ECB, CPI, NFP, etc.) for a country. Defaults: US, 7 days.
    country codes: "US" | "EU" | "IT" | "DE" | "FR" | "UK" | "JP" | "CN". Returns time, importance ★/★★/★★★, forecast vs previous.

91. stock_screener(screen?: string, count?: number)
    Pre-built Yahoo Finance screeners. screen values:
    most_actives | day_gainers | day_losers | undervalued_growth_stocks | growth_technology_stocks |
    aggressive_small_caps | small_cap_gainers | undervalued_large_caps | conservative_foreign_funds |
    high_yield_bond | portfolio_anchors | top_mutual_funds.
    Returns sym/name/price/change%/mcap/P/E for the top N matches.

92. peer_comparison(ticker: string)
    Identify direct peers via Yahoo recommendations + side-by-side comparison of P/E, P/B, ROE, D/E, dividend yield.
    Use to position a stock vs its industry, NOT just vs the broad market.

93. sec_filings(ticker: string, form?: string, limit?: number)
    SEC EDGAR filings for a US-listed company. form filter: "10-K" | "10-Q" | "8-K" | "DEF 14A" | "4" (insider) | "13F-HR" etc.
    Each row: date · form · description + direct URL to the filing document. Default: latest 10 of any form.

94. options_chain(ticker: string)
    Options chain for nearest expiry: top 10 calls and puts by strike with bid/ask/last/IV/OI.
    Lists all available expirations. Use for IV analysis, options strategy sizing, gamma proximity.

95. portfolio_add(ticker: string, qty: number, cost?: number)
    Add (or average-down) a stock position to the local portfolio (~/.nha/portfolio.json). cost = price/share.

96. portfolio_remove(ticker: string)
    Remove a position completely from the portfolio.

97. portfolio_summary()
    Live snapshot of all positions: qty, cost, current price, value, P/L $, P/L %, plus aggregate totals.

98. portfolio_metrics(period?: string)
    Quant metrics computed from historical prices: annualized return, volatility, Sharpe, Sortino, max drawdown, beta vs SPY.
    period: "1mo" "3mo" "6mo" "1y" "2y" "5y" "10y". Default: "1y". Assumes 4% risk-free rate.

99. news_sentiment(ticker?: string, query?: string)
    Fetch ~15 recent headlines and score each (positive/neutral/negative) via LLM. Returns aggregate verdict (🟢/🟡/🔴),
    distribution, and the top 5 most signal-bearing headlines with one-line reasoning.

100. backtest_strategy(ticker?: string, period?: string, strategy?: string)
    Run a parametric backtest. strategy values:
    - "sma_crossover": go long when SMA-20 > SMA-50, flat otherwise
    - "rsi_meanrev": buy oversold (<30), sell overbought (>70), hold otherwise
    - "buy_hold": baseline
    Returns total return, annualized return, vol, Sharpe, max drawdown. For custom strategies use execute_code directly.

101. italian_market(what?: string)
    Italian market snapshot. what: "all" | "mib" (FTSE MIB index) | "constituents" (top 15 blue chips with live prices) | "spread" (BTP-Bund 10y).

102. portfolio_correlation(period?: string)
    Pearson correlation matrix between all holdings + SPY benchmark over a period (default 1y).
    Surfaces concentration risk (>0.7 correlation = redundant) and diversification opportunities (<0.3 = good).

103. portfolio_sector_breakdown()
    Breakdown of portfolio exposure by sector, country, and currency. Computed from live prices × position size.
    Use to spot over-concentration (e.g. 60% in tech) or unhedged currency exposure.

104. portfolio_var(period?: string, confidence?: number)
    Historical-simulation Value at Risk and Expected Shortfall (CVaR). Default: 1y, 95% confidence.
    Output: 1-day VaR % and $, 10-day VaR (sqrt-time scaled), Expected Shortfall (avg tail loss).
    For stress testing pass confidence=0.99.

105. portfolio_rebalance(targets?: object)
    Compare current weights vs target weights and suggest the exact share trades to rebalance.
    targets: optional {AAPL: 0.20, MSFT: 0.15, ...} (sum to 1.0). If not provided, falls back to ~/.nha/portfolio.json
    "targets" field, otherwise assumes equal-weight. Drift threshold for action: 1%.

106. insider_trading(ticker: string, limit?: number)
    SEC Form 4 (insider/officer transactions) for a US-listed company. Returns last N filings with direct URLs.
    Open each URL to see whether the insider BOUGHT or SOLD shares — strong signal when clustered.

107. option_strategy_builder(ticker: string, direction?: string, maxRisk?: number, daysToExpiry?: number)
    Suggests concrete option strategies with strikes, expiry, net debit/credit, max profit/loss, breakeven, ROI.
    direction: "bullish" | "bearish" | "neutral". Default: neutral. maxRisk: $ budget (default 1000). daysToExpiry: default 30.
    Output adapts to ATM IV percentile vs 30d realized vol (cheap < 30th = buy premium; rich > 70th = sell premium):
    - bullish+cheap → Bull Call Debit Spread        - bullish+rich → Bull Put Credit Spread
    - bearish+cheap → Bear Put Debit Spread         - bearish+rich → Bear Call Credit Spread
    - neutral+rich  → Iron Condor                   - neutral+cheap → Long Straddle
    Each suggestion includes exact contracts × ticker × expiry × strike × side, with sizing scaled to maxRisk.

108. crypto_onchain_metrics(coin: string)
    Multi-source on-chain & derivatives view of a crypto asset. coin = CoinGecko ID (bitcoin, ethereum, solana, …).
    Combines:
    - CoinGecko market data: price, mcap, supply, ATH distance, social signal
    - DeFi Llama TVL (for L1s): 30-day TVL trend
    - Binance perpetual futures: 8h funding rate (last + avg of 8), open interest, positioning signal 🟢/🔴/🟡
    - Alternative.me Fear & Greed Index (0-100)
    - CoinGecko global: BTC/ETH/stablecoin market share
    All-free APIs. No API key required.

109. portfolio_tax_lots(method?: string)
    Tax-lot accounting on the transaction history. method: "FIFO" | "LIFO" | "HIFO". Default: FIFO.
    Computes realized short-term (taxed at income rate) vs long-term (15%/20% US) gains per ticker.
    Lists open lots with cost basis, age (long-term threshold 365 days), unrealized P/L per lot.
    Surfaces:
    - ⚠ Wash-sale warnings: buys within 30 days of a loss sale (IRS §1091)
    - 💡 Tax-loss harvest candidates: open lots with unrealized loss > $100, flags if hold < 31d (wash-sale risk)
    Requires transactions recorded via portfolio_tx_add (legacy portfolio_add still works for current state).

110. portfolio_tx_add(ticker: string, type: "buy"|"sell", qty: number, price: number, date?: string)
    Record a dated transaction. Feeds portfolio_tax_lots. Also updates current positions for portfolio_summary parity.
    date format: "YYYY-MM-DD" (defaults to today).

--- CODE EXECUTION ---

81. execute_code(language: "python"|"javascript"|"typescript", code: string, files?: [{path: string, content: string}], packages?: string[], stdin?: string, timeout?: number)
    Execute code in an isolated sandbox and return the full output.
    - language: "python", "javascript", or "typescript"
    - code: the main script to run
    - files (optional): extra files to create in the sandbox before running (e.g. input CSVs, helper modules). Paths are relative to sandbox.
    - packages (optional): pip or npm packages to install before execution (e.g. ["pandas","numpy"] for python, ["lodash"] for js)
    - stdin (optional): text piped to the process stdin
    - timeout (optional): seconds before SIGKILL, default 30, max 120
    Returns: exit_code (0=success ✓, non-zero=failure ✗), stdout, stderr, list of files written in sandbox.
    Sandbox: isolated temp dir, stripped env (no NHA API keys visible to subprocess), SIGKILL on timeout, sandbox deleted after run.
    Use for: data analysis, algorithm verification, running Python scripts, CSV/JSON processing, math computations, generating files (charts, reports), testing TypeScript/JS logic.
    Do NOT use for: network requests (use fetch_url), permanent file I/O (use file_write/file_read).

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
- When presenting calendar events, show Time, Title, Location/Link. Format times in a human-readable way. NEVER show raw eventId to the user — it's internal.
- When confirming a created event, say something like "Ho creato l'appuntamento 'X' per il giorno Y alle ore Z." — natural, human, no IDs.
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
- FINANCE TIP: For ANY financial analysis request, ALWAYS call real data tools FIRST — never fabricate prices, never use training data prices (they are stale). Workflow: market_price → market_chart → market_indicators → macro_data → analysis. For crypto: crypto_data → market_news. For macro regime: macro_data(indicator="all").
- FINANCE TIP: After gathering data, use canvas_render to produce a professional HTML report with Chart.js charts (price chart, indicator gauges, summary table). A visual report is ALWAYS superior to plain text for financial analysis. Use dark theme: bg #0a0a0a, green #00ff41, amber #f59e0b, red #ff4444, blue #00e5ff.
- FINANCE TIP: When building a trading strategy, ALWAYS cover: 1) macro regime (macro_data), 2) asset-specific technicals (market_chart), 3) fundamentals if equity (market_indicators), 4) news catalyst (market_news), 5) entry/exit/stop levels with specific prices, 6) position sizing (% of portfolio), 7) risk/reward ratio.
`.trim();

// ── Liara compact system prompt ───────────────────────────────────────────────
// Used ONLY when provider === 'nha'. Liara already knows tool signatures from
// LoRA training — no verbose descriptions needed. Dynamic values (today, tz,
// language, profile, imap accounts) are still injected at runtime below.
export const LIARA_TOOL_DEFINITIONS = `## LANGUAGE — HIGHEST PRIORITY

You MUST write your ENTIRE response in {{LANGUAGE}}. Every sentence, every confirmation, every error message. This overrides everything else. Even when this prompt itself is written in English, your reply to the user must be in {{LANGUAGE}} only. Do NOT mix languages. Do NOT default to English.

If {{LANGUAGE}} is Italian, write only in Italian: "L'appuntamento è stato cancellato." NOT "The event has been deleted." or "Both events have been deleted."

---

You are Liara, the NHA personal AI assistant.
Today: {{TODAY}} | Timezone: {{TIMEZONE}} | Language: {{LANGUAGE}}

When the user's request requires an action, output one or more fenced JSON blocks:
\`\`\`json
{"action": "<tool_name>", "params": { ... }}
\`\`\`
Multiple blocks allowed for chaining. Include natural text before/between/after blocks.
Never output a JSON block as a suggestion — every block executes immediately.

## ABSOLUTE RULES (violate these and the user loses trust)

1. NEVER invent tool output. If you need data (an event ID, a price, a search result), you MUST emit a tool JSON block and wait for its real response. Do NOT write fake "(eventId: 123456789)" or fake results.
2. NEVER claim an action was completed unless you have just received a SUCCESS tool result for that action in this same turn. NEVER write "cancellato con successo", "creato con successo", "inviato" etc. without a real tool execution behind it. If you didn't emit the tool block, the action didn't happen.
3. NEVER duplicate. If the user says "correggi/modifica/sposta/aggiorna" referring to an item you just created in this conversation, use the corresponding *_update / *_move tool with the eventId/taskId from your previous tool response. Do NOT create a second item.
4. NEVER put the TITLE in the description field. The "summary" / "title" field is the SHORT name (what shows on a calendar grid). The "description" field is ONLY for extra notes.
5. NEVER invent times. If the user did not specify a time, ASK them ("A che ora?"). Do not default to 10:00 or any other time silently. Same for missing date, duration, attendees.
6. When the user confirms ("procedi", "sì", "fallo", "ok", "vai") AND there is a pending action from the IMMEDIATELY PREVIOUS assistant turn (you proposed something like "Posso cancellare X. Procedo?"), EXECUTE that exact pending action with the same parameters — do NOT search again, do NOT propose again, do NOT ask again. Emit the tool block for the action you just proposed.
7. When in doubt, ASK ONE concise question — do not invent details.
8. Tool JSON blocks MUST be wrapped in \`\`\`json ... \`\`\` fences. If you emit raw JSON without fences, the system can sometimes still parse it but it's unreliable — always use the fences.

## TOOL SIGNATURES (parameters and how to use them)

### Calendar
calendar_create(summary, start, end, description?, attendees?, location?)
  - summary = SHORT title derived from what the user actually said. REQUIRED. Do NOT leave empty.
  - description = optional notes only. Do NOT put the title here.
  - start/end = ISO 8601 datetimes. Default end = start + 1 hour.
  - The tool response includes the REAL eventId. Use that exact value verbatim for any subsequent operation on the same event. The eventId is a long alphanumeric string returned by Google — NEVER fabricate one.
  - Always derive every parameter value from the user's message, never from this documentation.

calendar_update(eventId, summary?, location?, description?, start?, end?)
  - Use this for "correggi", "modifica", "rinomina", "cambia titolo", "sposta", "aggiorna" referring to an event you JUST created or found.
  - eventId MUST come from a real tool response (calendar_create / calendar_find / calendar_date). NEVER invent it.
  - DO NOT use placeholder strings like "ABC123", "DEF456", "abc123", "event_123" — those are not real eventIds.
  - If you don't have a real eventId, call calendar_find or calendar_date FIRST. Do not guess.

calendar_delete(eventId)  — Delete an event you have a REAL eventId for. Same rules as update: never invent, never use placeholders.
calendar_move(eventId, newStart, newEnd)  — Reschedule.
calendar_find(query, daysAhead?)  — Search events by name. Returns eventIds. Use ONLY when you don't already have the id.
  - daysAhead default is 7 — pass 30 or 60 for broader search if not found in 7.
  - Query is matched case-insensitively against summary AND description.
  - If a user names an event ambiguously (e.g. "Italiano della BMW" via voice-to-text typo for "Tagliando della BMW"), try BOTH the literal query AND alternative spellings.
calendar_today() / calendar_tomorrow() / calendar_date(date) / calendar_upcoming(hours?) / calendar_week(startDate?) / calendar_month(month?)  — Read-only listings.
  - **calendar_week with NO arguments** returns the CURRENT calendar week (Mon..Sun). Use this when the user says "questa settimana" / "this week". Do NOT pass startDate — let the tool compute the right Monday. Only pass startDate when the user explicitly names a different week.
  - **"elimina gli appuntamenti di [date]"** → call calendar_date(date) FIRST to get real eventIds, then calendar_delete with each real id.
schedule_meeting(clientName, subject, location, durationMinutes, dateFrom, dateTo)  — Find optimal slots considering travel time.

### Gmail / IMAP
gmail_list(limit?, query?)  — List recent emails. query supports Gmail search syntax.
gmail_read(messageId)  — Read full email body.
gmail_send(to, subject, body, cc?, bcc?)  — Send a new email.
gmail_reply(messageId, body)  — Reply to a thread.
gmail_draft(to, subject, body)  — Save a draft without sending.
gmail_mark_read(messageId) / gmail_mark_unread(messageId) / gmail_archive(messageId) / gmail_delete(messageId)
gmail_send_attach(to, subject, body, filePath)  — Send with attachment.
imap_*  — Same operations for non-Gmail accounts. imap_send_template/imap_bulk_send for templated sends.

### Tasks
task_list() / task_add(text, dueDate?) / task_done(index) / task_edit(index, newText) / task_move(fromIndex, toIndex) / task_delete(index) / task_clear()
gtask_list() / gtask_add(text) / gtask_complete(taskId)  — Google Tasks.

### Contacts
contact_search(query) / contact_add(name, email?, phone?) / contact_update(id, fields) / contact_delete(id)

### Web + research
web_search(query)  — Search the web (returns title/URL/snippet for top results).
fetch_url(url)  — Fetch a page; returns title, meta description, OG tags, JSON-LD, main content. Use the full URL with https://. For naked domains (www.x.com), prepend https://.
get_weather(location)  — Returns current conditions + 3-day forecast.
maps_directions(origin, destination)

### Browser automation (for JS-rendered pages or interaction)
browser_open(url) → returns sessionId. browser_screenshot(sessionId) · browser_click(sessionId, selector) · browser_type(sessionId, selector, text) · browser_extract(sessionId, selector) · browser_js(sessionId, code) · browser_wait(sessionId, ms) · browser_scroll(sessionId, deltaY) · browser_key(sessionId, key) · browser_close(sessionId)

### Notes / GitHub / Notion / Slack
note_add(text) · note_list()
github_issues(repo) · github_prs(repo) · github_notifications() · github_create_issue(repo, title, body)
notion_search(query) · notion_page(pageId)
slack_channels() · slack_messages(channel) · slack_send(channel, text, threadTs?) · slack_search(query) · slack_dm(user, text?) · slack_thread(channel, ts) · slack_react(channel, ts, emoji) · slack_mark_read(channel, ts?)

### Files / Drive
file_list(dir?) · file_read(path) · file_write(path, content) · file_info(path) · file_search(query)
drive_list(folderId?) · drive_read(fileId) · drive_upload(name, content, folderId?) · drive_update(fileId, content) · drive_delete(fileId) · drive_info(fileId) · drive_folder(name, parentId?) · drive_download(fileId, savePath)

### Reminders / automation
notify_remind(text, when)  — Notify the user at a future time.
birthdays_upcoming(days?) · birthday_add(name, date)
cron_add(schedule, prompt) · cron_list() · cron_remove(index)

### Screen / canvas / collab
screen_capture() / screen_analyze(question?)
canvas_render(html, title?)  — Render an HTML report/dashboard in the canvas panel.
collab_send(channel, text) · collab_read(channel)

### Finance
market_price(symbol) · market_chart(symbol, period?) · market_indicators(symbol) · macro_data(metric, country?) · crypto_data(coin) · market_news(symbol?)
FINANCE FLOW: always call real data tools first (market_price → market_chart → market_indicators OR crypto_data + macro_data), then canvas_render with a Chart.js HTML dashboard (dark theme: bg #070b0f, green #00ff41, amber #f59e0b, red #ff4444, blue #00e5ff). Never invent prices.

### Code
execute_code(language, code)  — Run Python/JS/shell in a sandbox.

## CONFIRMATIONS

Write operations that change state (gmail_send/reply/delete, calendar_create/update/move/delete, contact_delete, task_done/delete, notify_remind, file_write, drive_upload/update/delete) — describe what you're about to do in natural language first, then emit the JSON block. The system shows the user what's pending and acts on confirmation.

If the user already confirmed in the previous turn ("procedi", "sì", "fallo"), execute the pending action directly using the parameters from that prior turn — do NOT ask again or restart from scratch.`.trim();

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

  // Normalize: some LLMs output "json ... ", 'json ... ' or '''json ... '''
  // (Python-style triple-quote) instead of ```json ... ```. We rewrite all
  // these to proper triple-backtick fences before the main regex runs.
  const normalized = text
    .replace(/'''json\s*\n?([\s\S]*?)\n?\s*'''/g, (_, body) => '```json\n' + body.trim() + '\n```')
    .replace(/"""json\s*\n?([\s\S]*?)\n?\s*"""/g, (_, body) => '```json\n' + body.trim() + '\n```')
    .replace(/"json\s*\n([\s\S]*?)\n\s*"/g, (_, body) => '```json\n' + body.trim() + '\n```')
    .replace(/'json\s*\n([\s\S]*?)\n\s*'/g, (_, body) => '```json\n' + body.trim() + '\n```');

  const fenceRegex = /```json\s*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fenceRegex.exec(normalized)) !== null) {
    const before = normalized.slice(lastIndex, match.index).trim();
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

  const trailing = normalized.slice(lastIndex).trim();
  if (trailing) textParts.push(trailing);

  // Fallback: if no fenced blocks found, scan for bare {"action": ...} objects
  // in the text. The previous regex was naive and stopped at the first `}`,
  // breaking on nested params like {"action":"X","params":{"summary":"Y"}}.
  // Now we do proper brace balancing so we always capture the FULL object.
  if (actions.length === 0) {
    const consumed = new Set();
    const findBareActions = (src) => {
      let i = 0;
      while (i < src.length) {
        // Quick filter: only consider candidates that start with {"action"
        const idx = src.indexOf('{"action"', i);
        if (idx < 0) break;
        // Walk forward balancing braces, respecting strings
        let depth = 0;
        let inStr = false;
        let escape = false;
        let end = -1;
        for (let j = idx; j < src.length; j++) {
          const c = src[j];
          if (escape) { escape = false; continue; }
          if (c === '\\' && inStr) { escape = true; continue; }
          if (c === '"' && !escape) { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) { end = j; break; }
          }
        }
        if (end < 0) break;
        const candidate = src.slice(idx, end + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed.action && typeof parsed.action === 'string' && !consumed.has(candidate)) {
            actions.push({ action: parsed.action, params: parsed.params || {} });
            consumed.add(candidate);
          }
        } catch { /* not valid JSON, skip */ }
        i = end + 1;
      }
    };
    findBareActions(text);
    // Legacy fallback kept for very loose JSON shapes — only fires if the
    // brace scanner found nothing.
    const bareRegex = /\{[\s\S]*?"action"\s*:\s*"[^"]+[\s\S]*?\}/g;
    let bareMatch;
    while (actions.length === 0 && (bareMatch = bareRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(bareMatch[0]);
        if (parsed.action && typeof parsed.action === 'string' && !consumed.has(bareMatch[0])) {
          actions.push({ action: parsed.action, params: parsed.params || {} });
          consumed.add(bareMatch[0]);
        }
      } catch { /* not valid JSON, skip */ }
    }
    // If we found bare actions, rebuild textParts stripping out the JSON blobs
    if (actions.length > 0) {
      const cleaned = text.replace(/\{[\s\S]*?"action"\s*:\s*"[^"]+[\s\S]*?\}/g, '').trim();
      return { textParts: cleaned ? [cleaned] : [], actions };
    }
  }

  return { textParts, actions };
}

/**
 * Strip orphan tool-fence blocks from a finished LLM response. These appear
 * when the model emits an empty `'''json '''` (or backtick-fenced) block
 * as a no-op marker — the parser doesn't pick them up as actions but they
 * leak into the UI as visible noise. Run this on the final assistant text
 * before showing it to the user.
 */
export function stripOrphanFences(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // Triple-backtick, triple-single, triple-double quote fences with `json`
    // marker — empty or with a body. We strip the whole block.
    .replace(/```json\s*\n?[\s\S]*?```/g, '')
    .replace(/'''json\s*\n?[\s\S]*?'''/g, '')
    .replace(/"""json\s*\n?[\s\S]*?"""/g, '')
    // Bare action JSON that the parser already consumed but the synthesis
    // step regurgitated (rare but happens with Liara). Only strip if the
    // JSON shape matches "action":"...".
    .replace(/\{\s*"action"\s*:\s*"[^"]+"\s*,?\s*("params"\s*:\s*\{[\s\S]*?\}\s*)?\}/g, '')
    // Collapse blank-line clusters produced by the stripping.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Formatting Helpers ───────────────────────────────────────────────────────

/**
 * Format an ISO timestamp into a human-readable time string.
 */
// ── Attachment Parsers (zero-deps, best-effort) ────────────────────────────

/**
 * Extract text from a PDF buffer using a naïve pattern scan. Catches text
 * inside `BT ... (text) Tj ... ET` blocks of uncompressed content streams.
 * Won't work on PDFs whose content streams are FlateDecode-compressed — those
 * need a real parser (pdfjs-dist). For typical ERP-generated POs/quotes the
 * content stream is usually plain enough that this catches the line items.
 */
function _naivePdfText(buf) {
  if (!Buffer.isBuffer(buf)) return '';
  // PDFs can store text in (...) strings, sometimes split across multiple Tj
  // calls. We collect them all, decode the basic escapes, and join with spaces.
  const raw = buf.toString('latin1');
  const out = [];
  // BT ... ET text blocks. Inside: (text) Tj or [(a)(b)] TJ.
  const blockRe = /BT[\s\S]*?ET/g;
  let m;
  while ((m = blockRe.exec(raw))) {
    const block = m[0];
    const strRe = /\(((?:\\.|[^\\)])*)\)/g;
    let sm;
    const parts = [];
    while ((sm = strRe.exec(block))) {
      const s = sm[1]
        .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
        .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
        .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
      parts.push(s);
    }
    if (parts.length) out.push(parts.join(' '));
  }
  // Cleanup: collapse whitespace, drop control chars.
  return out.join('\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[ \t]+/g, ' ').trim();
}

/**
 * Extract text from a DOCX buffer. DOCX = zip with `word/document.xml`. We
 * use Node's built-in zlib to decompress the central directory, find the
 * document.xml entry, decompress it, and pull <w:t>...</w:t> text runs.
 */
async function _naiveDocxText(buf) {
  if (!Buffer.isBuffer(buf)) return '';
  const zlib = await import('zlib');
  const { promisify } = await import('util');
  const inflateRaw = promisify(zlib.inflateRaw);
  // ZIP local file headers start with 0x504b0304. We scan for them and pick
  // out the entry whose filename is "word/document.xml".
  let i = 0;
  while (i < buf.length - 30) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const compMethod = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;
    if (name === 'word/document.xml') {
      const compData = buf.slice(dataStart, dataStart + compSize);
      let xml = '';
      try {
        if (compMethod === 0) xml = compData.toString('utf8');
        else if (compMethod === 8) xml = (await inflateRaw(compData)).toString('utf8');
        else return '';
      } catch { return ''; }
      // Extract <w:t>...</w:t> runs (and the xml: space="preserve" variant).
      const parts = [];
      const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
      let m;
      while ((m = re.exec(xml))) parts.push(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
      return parts.join(' ').replace(/[ \t]+/g, ' ').trim();
    }
    i = dataStart + compSize;
  }
  return '';
}

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
export async function buildSystemPrompt(persona, personaDescription, config, initialContext) {
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

  // Liara (provider 'nha') uses the compact prompt — tool signatures are
  // already baked into the LoRA weights, no verbose descriptions needed.
  // All other providers get the full TOOL_DEFINITIONS with descriptions.
  const isLiara = config?.llm?.provider === 'nha';
  const baseDefinitions = isLiara ? LIARA_TOOL_DEFINITIONS : TOOL_DEFINITIONS;

  let prompt = baseDefinitions
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

  // Inject IMAP accounts so the AI knows accountIds without calling imap_accounts()
  try {
    const { listAccounts } = await import('./email-db.mjs').catch(() => ({ listAccounts: null }));
    if (listAccounts) {
      const imapAccounts = listAccounts();
      if (imapAccounts.length > 0) {
        prompt += `\n\n--- IMAP EMAIL ACCOUNTS (custom, already configured) ---\n`;
        prompt += `Use these accountIds directly — do NOT call imap_accounts() first.\n`;
        for (const a of imapAccounts) {
          prompt += `accountId: "${a.id}" | email: ${a.email_address} | name: "${a.display_name}" | status: ${a.sync_status}\n`;
        }
        prompt += `When the user mentions their company name, email domain, or display name, map it to the correct accountId above.`;
      }
    }
  } catch {}

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

/**
 * Detect IDs that the model has clearly invented vs real Google Calendar
 * eventIds. Real ones are LONG (≥10), LOWERCASE, alphanumeric (a-v + 0-9,
 * sometimes with `_` or `-`). Placeholders are typically short, uppercase,
 * dictionary words, or alternate-letter+digit pseudo-random patterns like
 * "A1B2C3D4E5F6G7H8I9J0".
 */
function isPlaceholderEventId(id) {
  if (!id || typeof id !== 'string') return true;
  const s = id.trim();
  // 1. Explicit literal blocklist (covers everything we've seen so far)
  const LITERAL = new Set([
    'abc123', 'def456', 'xyz789', 'event_123', 'event_123456789',
    '123', '456', 'foo', 'bar', 'baz', 'example', 'placeholder',
    'eventid', 'event_id', 'id', 'null', 'undefined', 'some-google-id',
    'event-id', 'id-from-tool', 'event_abc', 'event_xyz',
  ]);
  if (LITERAL.has(s.toLowerCase())) return true;
  // 2. Too short — Google eventIds are always ≥ 16 chars in practice
  if (s.length < 10) return true;
  // 3. Contains spaces — never valid
  if (/\s/.test(s)) return true;
  // 4. Pseudo-random alternating letter+digit pattern like "A1B2C3D4..."
  //    Real Google eventIds NEVER look like this — they have natural
  //    base32-ish randomness, not human-readable patterns.
  if (/^[A-Z](?:\d[A-Z]){3,}/i.test(s)) return true;
  // 5. Almost-all-uppercase: Google eventIds are lowercase. UPPERCASE
  //    is a model invention signature.
  const upper = (s.match(/[A-Z]/g) || []).length;
  const lower = (s.match(/[a-z]/g) || []).length;
  if (upper >= 3 && upper > lower) return true;
  return false;
}

/**
 * Wrapper around executeTool that ALSO persists structured items for
 * any list-tool, so the anaphoric resolver in message-responder can later
 * map "cancellalo / il primo / aprilo" to the correct item ID.
 * Use this from chat.mjs / message-responder.mjs to get free "memory"
 * across turns and channels.
 */
export async function executeToolAndRemember(action, params, config, chatId) {
  const result = await executeTool(action, params, config);
  try { await _maybeRememberList(action, params, result, config, chatId); } catch {}
  return result;
}

async function _maybeRememberList(action, params, result, config, chatId) {
  if (!action) return;
  const { rememberList } = await import('./list-cache.mjs');
  // ── CALENDAR list tools — call listEvents directly for structured IDs ──
  if (['calendar_today', 'calendar_tomorrow', 'calendar_week', 'calendar_month', 'calendar_date', 'calendar_upcoming'].includes(action)) {
    try {
      const { listEvents } = await import('./google-calendar.mjs');
      const now = new Date();
      let from, to;
      if (action === 'calendar_today') { from = new Date(now.getFullYear(), now.getMonth(), now.getDate()); to = new Date(from.getTime() + 86400000); }
      else if (action === 'calendar_tomorrow') { from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1); to = new Date(from.getTime() + 86400000); }
      else if (action === 'calendar_week') { from = new Date(now.getFullYear(), now.getMonth(), now.getDate()); to = new Date(from.getTime() + 7 * 86400000); }
      else if (action === 'calendar_month') {
        let y = now.getFullYear(), m = now.getMonth();
        if (params?.month && /^\d{4}-\d{2}$/.test(params.month)) { const [yy, mm] = params.month.split('-'); y = parseInt(yy, 10); m = parseInt(mm, 10) - 1; }
        from = new Date(y, m, 1); to = new Date(y, m + 1, 1);
      }
      else if (action === 'calendar_date' && params?.date) { const [yy, mm, dd] = params.date.split('-').map(n => parseInt(n, 10)); from = new Date(yy, mm - 1, dd); to = new Date(from.getTime() + 86400000); }
      else if (action === 'calendar_upcoming') { const h = parseInt(params?.hours || '48', 10); from = now; to = new Date(now.getTime() + h * 3600000); }
      if (from && to) {
        const evs = await listEvents(config, 'primary', from, to);
        const items = (evs || []).map(e => ({ eventId: e.id, id: e.id, summary: e.summary || '(senza titolo)', time: (e.start || '').slice(11, 16), date: (e.start || '').slice(0, 10) }));
        rememberList(chatId, 'calendar', items);
      }
    } catch {}
    return;
  }
  // ── EMAIL list tools ──
  if (['gmail_list', 'gmail_search', 'gmail_unread', 'email_search', 'email_list'].includes(action)) {
    try {
      const { listMessages, getMessage } = await import('./google-gmail.mjs');
      const query = params?.query || (action === 'gmail_unread' ? 'is:unread' : 'in:inbox');
      const refs = await listMessages(config, query, params?.maxResults || 10);
      const items = [];
      for (const ref of refs.slice(0, 10)) {
        try { const m = await getMessage(config, ref.id); items.push({ messageId: m.id, id: m.id, subject: m.subject, from: m.from, date: m.date }); }
        catch {}
      }
      rememberList(chatId, 'email', items);
    } catch {}
    return;
  }
  // ── TASK list (internal NHA tasks) ──
  if (action === 'task_list') {
    try {
      const { getTasks } = await import('./tasks.mjs');
      const items = (getTasks() || []).map(t => ({ id: t.id, description: t.description, priority: t.priority, due: t.due }));
      rememberList(chatId, 'task', items);
    } catch {}
    return;
  }
  // ── GOOGLE TASKS list ──
  if (action === 'gtask_list') {
    try {
      const { listGTasks } = await import('./google-tasks.mjs').catch(() => ({}));
      if (listGTasks) {
        const tasks = await listGTasks(config, params?.listId);
        const items = (tasks || []).map(t => ({ id: t.id, taskId: t.id, title: t.title, due: t.due }));
        rememberList(chatId, 'gtask', items);
      }
    } catch {}
    return;
  }
  // ── CONTACT search ──
  if (action === 'contact_search' || action === 'contact_list') {
    try {
      const { searchContacts, listContacts } = await import('./google-contacts.mjs').catch(() => ({}));
      const fn = action === 'contact_search' ? searchContacts : listContacts;
      if (fn) {
        const arr = await fn(config, params?.query || '');
        const items = (arr || []).map(c => ({ id: c.resourceName || c.id, name: c.name || c.displayName, email: c.email }));
        rememberList(chatId, 'contact', items);
      }
    } catch {}
    return;
  }
  // ── DRIVE list ──
  if (action === 'drive_list' || action === 'drive_search') {
    try {
      const { listDriveFiles } = await import('./google-drive.mjs').catch(() => ({}));
      if (listDriveFiles) {
        const files = await listDriveFiles(config, params?.folderId || null, params?.query || '');
        const items = (files || []).map(f => ({ fileId: f.id, id: f.id, name: f.name, mimeType: f.mimeType }));
        rememberList(chatId, 'drive', items);
      }
    } catch {}
    return;
  }
  // ── NOTE list ──
  if (action === 'note_list') {
    try {
      const { getNotes } = await import('./notes.mjs').catch(() => ({}));
      if (getNotes) {
        const notes = getNotes();
        const items = (notes || []).map(n => ({ id: n.id, title: n.title, body: n.body?.slice(0, 200) }));
        rememberList(chatId, 'note', items);
      }
    } catch {}
    return;
  }
  // ── REMINDER list ──
  if (action === 'reminder_list') {
    try {
      const { listReminders } = await import('./reminders.mjs').catch(() => ({}));
      if (listReminders) {
        const arr = listReminders();
        const items = (arr || []).map(r => ({ id: r.id, message: r.message, when: r.when }));
        rememberList(chatId, 'reminder', items);
      }
    } catch {}
    return;
  }
  // ── NOTION search ──
  if (action === 'notion_search') {
    try {
      // Notion search returns pages — we parse from the textual result as
      // a best-effort, falling back to whatever ID hints the result contains.
      const m = String(result).match(/[a-f0-9]{32}|[a-f0-9-]{36}/g);
      if (m && m.length > 0) {
        const items = m.slice(0, 10).map(id => ({ id, pageId: id }));
        rememberList(chatId, 'notion', items);
      }
    } catch {}
    return;
  }
  // ── SLACK search ──
  if (action === 'slack_search') {
    try {
      const m = String(result).match(/\b(\d{10}\.\d{6})\b/g);
      if (m && m.length > 0) {
        const items = m.slice(0, 10).map(ts => ({ id: ts, ts }));
        rememberList(chatId, 'slack', items);
      }
    } catch {}
    return;
  }
  // ── GITHUB issue/PR list ──
  if (action === 'github_list_issues' || action === 'github_issues' || action === 'github_prs' || action === 'github_pulls') {
    try {
      // Best effort from result text: lines like "#123 Title"
      const matches = [...String(result).matchAll(/#(\d+)\s+(.+)/g)];
      if (matches.length > 0) {
        const items = matches.slice(0, 20).map(m => ({ id: m[1], number: parseInt(m[1], 10), title: m[2].trim() }));
        rememberList(chatId, 'github', items);
      }
    } catch {}
    return;
  }
}

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

    // ── IMAP Email (custom accounts) ─────────────────────────────────────
    case 'imap_accounts': {
      const { listAccounts } = await import('./email-db.mjs');
      const accs = listAccounts();
      if (!accs.length) return 'No IMAP accounts configured. Ask the user to add one in Settings > Email Accounts.';
      return accs.map(a => `[${a.id}] ${a.display_name} <${a.email_address}> — ${a.sync_status}`).join('\n');
    }

    case 'imap_sync': {
      if (!params.accountId) return 'accountId required.';
      const { syncAccount } = await import('./email-imap.mjs');
      syncAccount(params.accountId).catch(e => console.error('[imap_sync]', e.message));
      return `Sync started for account ${params.accountId}. New messages will appear in a few seconds.`;
    }

    case 'imap_labels': {
      if (!params.accountId) return 'accountId required.';
      const { listLabels } = await import('./email-db.mjs');
      const labels = listLabels(params.accountId);
      if (!labels.length) return 'No labels found.';
      return labels.map(l => `[${l.id}] ${l.name}${l.system_type ? ' (' + l.system_type + ')' : ''}${l.unread_count > 0 ? ' — ' + l.unread_count + ' unread' : ''}`).join('\n');
    }

    case 'imap_list': {
      if (!params.accountId) return 'accountId required. Use imap_accounts() first.';
      const { listMessages: imapListMessages } = await import('./email-db.mjs');
      const result = imapListMessages(params.accountId, params.labelId || null, params.limit || 20, 0, params.search || null);
      if (!result.messages.length) return 'No messages found.';
      const rows = result.messages.map((m, i) => {
        const date = (m.internal_date || '').slice(0, 10);
        const time = (m.internal_date || '').slice(11, 16);
        const from = m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address;
        const status = m.is_read ? '✓' : '● UNREAD';
        const star = m.is_starred ? ' ★' : '';
        const attach = m.has_attachments ? ' 📎' : '';
        const preview = (m.body_preview || '').slice(0, 150);
        return `${i + 1}. ${status}${star}${attach}\n   ID: ${m.id}\n   From: ${from}\n   Subject: ${m.subject || '(no subject)'}\n   Date: ${date} ${time}\n   Preview: ${preview}`;
      });
      return `Found ${result.total} messages (showing ${result.messages.length}):\n\n` + rows.join('\n\n---\n\n');
    }

    case 'imap_read': {
      if (!params.messageId) return 'messageId required.';
      const { getMessage: imapGetMessage, markRead: imapMarkRead } = await import('./email-db.mjs');
      const msg = imapGetMessage(params.messageId);
      if (!msg) return 'Message not found.';
      imapMarkRead(params.messageId, true);
      const to = (() => { try { const a = JSON.parse(msg.to_addresses || '[]'); return a.map(x => x.address || x).join(', '); } catch { return msg.to_addresses || ''; } })();
      const body = msg.body_reply_only || msg.body_text || msg.body_preview || '(empty)';
      // Surface attachments in the tool response so the LLM can decide whether
      // to follow up with imap_attachment_read. Without this it has no way to
      // know an attachment exists.
      const atts = (msg.attachments || []).map((a, i) =>
        `[${i + 1}] "${a.filename || 'unnamed'}" — ${a.content_type || 'application/octet-stream'} — ${Math.round((a.size_bytes || 0) / 1024)} KB — id:${a.id}`
      ).join('\n');
      const attBlock = atts
        ? `\n\n--- ATTACHMENTS (${msg.attachments.length}) ---\n${atts}\n\nTo read the content of an attachment, call: imap_attachment_read with messageId="${msg.id}" and either filename or index.`
        : '';
      return `Subject: ${msg.subject}\nFrom: ${msg.from_name ? msg.from_name + ' <' + msg.from_address + '>' : msg.from_address}\nTo: ${to}\nDate: ${msg.internal_date}\n\n${body.slice(0, 3000)}${attBlock}`;
    }

    case 'imap_attachment_read': {
      if (!params.messageId) return 'messageId required. Use imap_read first to get the messageId and the list of attachments.';
      const { getMessage: imapGetMsgForAtt } = await import('./email-db.mjs');
      const msg = imapGetMsgForAtt(params.messageId);
      if (!msg) return 'Message not found.';
      const attachments = msg.attachments || [];
      if (!attachments.length) return 'This message has no attachments.';
      // Resolution: explicit attachmentId > filename match > index > first
      let chosen = null;
      if (params.attachmentId) {
        chosen = attachments.find(a => a.id === params.attachmentId);
      } else if (params.filename) {
        const needle = String(params.filename).toLowerCase();
        chosen = attachments.find(a => (a.filename || '').toLowerCase().includes(needle));
      } else if (typeof params.index === 'number') {
        chosen = attachments[Math.max(0, params.index - 1)] || null;
      }
      if (!chosen) chosen = attachments[0];
      if (!chosen) return 'Could not resolve which attachment to read.';
      const { fetchAttachmentContent } = await import('./email-imap.mjs');
      let result;
      try {
        result = await fetchAttachmentContent(msg.account_id, msg.imap_folder_path, msg.uid, chosen.part_id);
      } catch (e) {
        return `Failed to fetch attachment "${chosen.filename}" from server: ${e.message}`;
      }
      if (!result?.buffer) return `Attachment "${chosen.filename}" returned no content.`;
      const buf = result.buffer;
      const ct = (chosen.content_type || result.contentType || '').toLowerCase();
      const head = `Attachment: ${chosen.filename}\nType: ${ct || 'unknown'}\nSize: ${Math.round(buf.length / 1024)} KB\n\n`;

      // Text-ish — return up to 10k chars of UTF-8.
      if (/^text\/|application\/(json|xml|csv|x-yaml)/i.test(ct) || /\.(txt|csv|json|xml|log|md|html)$/i.test(chosen.filename || '')) {
        return head + buf.toString('utf8').slice(0, 10000);
      }

      // PDF — naïve text extraction from the raw stream. Catches text-based
      // PDFs (invoices, purchase orders, quotes generated by ERP software).
      // Doesn't handle scanned/OCR PDFs — for those the model gets a clear
      // "image-based PDF" hint so it can ask the user.
      if (/pdf/i.test(ct) || /\.pdf$/i.test(chosen.filename || '')) {
        const text = _naivePdfText(buf);
        if (text && text.length > 30) {
          return head + `--- Extracted text (best-effort, ${text.length} chars) ---\n${text.slice(0, 10000)}`;
        }
        return head + `PDF appears to be image-based or compressed (no extractable text found). ` +
          `Tell the user the PDF can't be auto-read — they can open it manually or share the relevant section as text.`;
      }

      // DOCX — minimal text extraction from word/document.xml inside the zip.
      if (/wordprocessingml|msword/i.test(ct) || /\.docx?$/i.test(chosen.filename || '')) {
        const text = await _naiveDocxText(buf);
        if (text) return head + `--- Extracted text (${text.length} chars) ---\n${text.slice(0, 10000)}`;
        return head + 'Could not extract text from DOCX (possibly malformed or password-protected).';
      }

      // Unsupported — return metadata only.
      return head + `Tipo "${ct}" non supportato per lettura automatica. Allegato disponibile nella casella email; chiedi all'utente di condividere il contenuto rilevante come testo.`;
    }

    case 'imap_send': {
      if (!params.accountId || !params.to || !params.subject) return 'accountId, to, subject required.';
      const { sendEmail: imapSendEmail } = await import('./email-smtp.mjs');
      try {
        const result = await imapSendEmail(params.accountId, {
          to: params.to,
          cc: params.cc || null,
          subject: params.subject,
          bodyHtml: params.bodyHtml || params.body || '',
          bodyText: params.bodyText || null,
          inReplyTo: params.inReplyTo || null,
        });
        return `✅ Email sent and saved to Sent folder. Message-ID: ${result.messageId}`;
      } catch (e) {
        return `❌ SEND FAILED — the email was NOT delivered. Error: ${e.message}. Tell the user the send failed and show the exact error.`;
      }
    }

    case 'imap_mark_read': {
      if (!params.messageId) return 'messageId required.';
      const { markRead: imapMarkRead2 } = await import('./email-db.mjs');
      imapMarkRead2(params.messageId, params.isRead !== false);
      return `Message marked as ${params.isRead !== false ? 'read' : 'unread'}.`;
    }

    case 'imap_reply': {
      if (!params.accountId || !params.messageId || !params.bodyHtml) return 'accountId, messageId, bodyHtml required.';
      const { getMessage: imapGetMsg2 } = await import('./email-db.mjs');
      const { sendEmail: imapSendReply } = await import('./email-smtp.mjs');
      const orig = imapGetMsg2(params.messageId);
      if (!orig) return 'Original message not found in local DB.';
      const replySubject = orig.subject?.startsWith('Re:') ? orig.subject : 'Re: ' + (orig.subject || '');
      let refs = [];
      try { refs = JSON.parse(orig.references_list || '[]'); } catch {}
      if (orig.message_id) refs.push(orig.message_id);
      try {
        const result = await imapSendReply(params.accountId, {
          to: orig.from_address,
          cc: params.cc || null,
          subject: replySubject,
          bodyHtml: params.bodyHtml,
          inReplyTo: orig.message_id || null,
          references: refs,
        });
        return `✅ Reply sent to ${orig.from_address} and saved to Sent folder. Message-ID: ${result.messageId}`;
      } catch (e) {
        return `❌ SEND FAILED — reply was NOT delivered. Error: ${e.message}. Tell the user the send failed and show the exact error.`;
      }
    }

    case 'imap_thread': {
      if (!params.accountId || !params.threadId) return 'accountId and threadId required.';
      const { getThread: imapGetThread } = await import('./email-db.mjs');
      const msgs = imapGetThread(params.threadId, params.accountId);
      if (!msgs.length) return 'No messages found in thread.';
      return msgs.map((m, i) => {
        const body = m.body_reply_only || m.body_text || m.body_preview || '(empty)';
        return `--- Message ${i + 1} ---\nFrom: ${m.from_name ? m.from_name + ' <' + m.from_address + '>' : m.from_address}\nDate: ${m.internal_date}\n\n${body.slice(0, 1500)}`;
      }).join('\n\n');
    }

    case 'imap_search': {
      if (!params.accountId || !params.query) return 'accountId and query required.';
      const { listMessages: imapSearch } = await import('./email-db.mjs');
      const result = imapSearch(params.accountId, null, params.limit || 20, 0, params.query);
      if (!result.messages.length) return `No messages found for "${params.query}".`;
      return result.messages.map(m =>
        `[${m.id}] ${m.is_read ? '' : '[UNREAD] '}From: ${m.from_name || m.from_address} | ${m.subject} | ${(m.internal_date || '').slice(0, 10)}\n  ${(m.body_preview || '').slice(0, 100)}`
      ).join('\n\n') + `\n\n(${result.total} total matches)`;
    }

    case 'imap_mark_starred': {
      if (!params.messageId) return 'messageId required.';
      const { markStarred } = await import('./email-db.mjs');
      markStarred(params.messageId, params.isStarred !== false);
      return `Message ${params.isStarred !== false ? 'starred' : 'unstarred'}.`;
    }

    case 'imap_trash': {
      if (!params.messageId) return 'messageId required.';
      const { softDelete } = await import('./email-db.mjs');
      softDelete(params.messageId);
      return 'Message moved to local Trash. Not deleted from IMAP server.';
    }

    case 'imap_draft': {
      if (!params.accountId || !params.to || !params.subject) return 'accountId, to, subject required.';
      const { saveDraft } = await import('./email-db.mjs');
      const id = saveDraft(params.accountId, {
        to: [{ address: params.to }],
        subject: params.subject,
        body_html: params.bodyHtml || '',
      });
      return `Draft saved with id: ${id}`;
    }

    case 'imap_send_template': {
      if (!params.accountId || !params.to || !params.templateId || !params.vars) return 'accountId, to, templateId, vars required.';
      const { sendEmail: imapSendTpl } = await import('./email-smtp.mjs');
      const TEMPLATES = {
        promo_product: { subject: 'Scopri la nostra offerta su [PRODOTTO]', html: '<table width="100%" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#1a1a2e;padding:32px 40px;text-align:center"><h1 style="color:#00ff9d;margin:0">[AZIENDA]</h1></td></tr><tr><td style="padding:40px;background:#fff"><h2 style="color:#1a1a2e">[TITOLO OFFERTA]</h2><p style="color:#444;line-height:1.7">[DESCRIZIONE PRODOTTO/SERVIZIO]</p><p style="color:#444;line-height:1.7">[DETTAGLIO BENEFICI O SPECIFICHE]</p><table><tr><td style="background:#00ff9d;border-radius:6px;padding:14px 32px"><a href="[LINK_CTA]" style="color:#1a1a2e;font-weight:700;text-decoration:none">[TESTO CTA]</a></td></tr></table></td></tr><tr><td style="padding:24px 40px;background:#f5f5f5;text-align:center"><p style="color:#888;font-size:12px">[AZIENDA] &bull; [INDIRIZZO] &bull; [EMAIL]</p></td></tr></table>' },
        newsletter: { subject: '[AZIENDA] Newsletter — [MESE] [ANNO]', html: '<table width="100%" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#0f0f1a;padding:28px 40px;border-bottom:3px solid #00ff9d"><h1 style="color:#fff;margin:0">[AZIENDA]</h1><p style="color:#00ff9d;margin:6px 0 0;font-size:13px">Newsletter [MESE] [ANNO]</p></td></tr><tr><td style="padding:36px 40px;background:#fff"><h2 style="color:#1a1a2e">[TITOLO PRINCIPALE]</h2><p style="color:#555;line-height:1.8">[TESTO PRINCIPALE]</p><hr style="border:none;border-top:1px solid #eee;margin:24px 0"><h3 style="color:#1a1a2e">[TITOLO SEZIONE 2]</h3><p style="color:#555;line-height:1.8">[TESTO SEZIONE 2]</p></td></tr><tr><td style="padding:20px 40px;background:#f9f9f9;text-align:center"><p style="color:#999;font-size:12px">&copy; [ANNO] [AZIENDA]</p></td></tr></table>' },
        follow_up: { subject: 'Seguito alla nostra conversazione — [ARGOMENTO]', html: '<table width="100%" style="max-width:580px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="padding:40px"><p style="color:#333;line-height:1.7">Gentile [NOME],</p><p style="color:#333;line-height:1.7">la contatto in seguito a [CONTESTO].</p><p style="color:#333;line-height:1.7">[CORPO PRINCIPALE]</p><p style="color:#333;line-height:1.7">[CHIUSURA]</p><p style="color:#333">Cordiali saluti,</p><p style="color:#1a1a2e;font-weight:700">[NOME MITTENTE]</p><p style="color:#888;font-size:13px">[RUOLO] &bull; [AZIENDA] &bull; [TELEFONO]</p></td></tr></table>' },
        offerta: { subject: 'Offerta [NUMERO] — [OGGETTO FORNITURA]', html: '<table width="100%" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#1a1a2e;padding:24px 40px"><h1 style="color:#00ff9d;margin:0">[AZIENDA]</h1><p style="color:#aaa;margin:4px 0 0;font-size:12px">Offerta n. [NUMERO] del [DATA]</p></td></tr><tr><td style="padding:36px 40px;background:#fff"><p style="color:#333;line-height:1.7">Gentile [NOME],</p><p style="color:#555;font-size:13px"><strong>Condizioni di pagamento:</strong> [PAGAMENTO]</p><p style="color:#555;font-size:13px"><strong>Tempi di consegna:</strong> [CONSEGNA]</p><p style="color:#555;font-size:13px"><strong>Validita offerta:</strong> [VALIDITA]</p><p style="color:#333">Cordiali saluti,</p><p style="color:#1a1a2e;font-weight:700">[NOME MITTENTE]</p></td></tr></table>' },
        evento: { subject: 'Sei invitato: [NOME EVENTO] — [DATA]', html: '<table width="100%" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:linear-gradient(135deg,#0f0f1a,#1a2a1a);padding:48px 40px;text-align:center"><h1 style="color:#00ff9d;margin:0">[NOME EVENTO]</h1><p style="color:#aaffcc;margin:8px 0 0">[DATA] &bull; [ORA] &bull; [LUOGO]</p></td></tr><tr><td style="padding:40px;background:#fff;text-align:center"><p style="color:#444;line-height:1.8;max-width:460px;margin:0 auto 28px">[DESCRIZIONE EVENTO]</p><table style="margin:0 auto"><tr><td style="background:#00ff9d;border-radius:8px;padding:14px 40px"><a href="[LINK_REGISTRAZIONE]" style="color:#0f0f1a;font-weight:700;text-decoration:none">Registrati ora</a></td></tr></table></td></tr></table>' },
        ringraziamento: { subject: 'Grazie per la fiducia, [NOME]', html: '<table width="100%" style="max-width:580px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#0f0f1a;padding:32px 40px;text-align:center"><h1 style="color:#fff;font-size:22px">Grazie, [NOME]!</h1></td></tr><tr><td style="padding:40px;background:#fff"><p style="color:#333;line-height:1.8">Volevamo ringraziarti per [MOTIVO].</p><p style="color:#333;line-height:1.8">[MESSAGGIO PERSONALE]</p><p style="color:#333">Con stima,</p><p style="color:#1a1a2e;font-weight:700">[NOME MITTENTE]</p></td></tr></table>' },
      };
      const tpl = TEMPLATES[params.templateId];
      if (!tpl) return `Unknown templateId "${params.templateId}". Valid: ${Object.keys(TEMPLATES).join(', ')}`;
      const applyVars = (str, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split('[' + k + ']').join(v || ''), str);
      const subject = applyVars(tpl.subject, params.vars);
      const html = applyVars(tpl.html, params.vars);
      try {
        const result = await imapSendTpl(params.accountId, { to: params.to, subject, bodyHtml: html });
        return `✅ Template email "${params.templateId}" sent to ${params.to} and saved to Sent folder. Message-ID: ${result.messageId}`;
      } catch (e) {
        return `❌ SEND FAILED — email was NOT delivered. Error: ${e.message}. Tell the user the send failed and show the exact error.`;
      }
    }

    case 'imap_bulk_send': {
      if (!params.accountId || !params.recipients?.length || !params.subject || !params.templateId) return 'accountId, recipients, subject, templateId required.';
      const { sendEmail: imapSendBulk } = await import('./email-smtp.mjs');
      const BULK_TEMPLATES = {
        promo_product: '<table width="100%" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#1a1a2e;padding:32px 40px;text-align:center"><h1 style="color:#00ff9d;margin:0">[AZIENDA]</h1></td></tr><tr><td style="padding:40px;background:#fff"><h2 style="color:#1a1a2e">[TITOLO OFFERTA]</h2><p style="color:#444;line-height:1.7">[DESCRIZIONE PRODOTTO/SERVIZIO]</p><table><tr><td style="background:#00ff9d;border-radius:6px;padding:14px 32px"><a href="[LINK_CTA]" style="color:#1a1a2e;font-weight:700;text-decoration:none">[TESTO CTA]</a></td></tr></table></td></tr></table>',
        newsletter: '<table width="100%" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#0f0f1a;padding:28px 40px;border-bottom:3px solid #00ff9d"><h1 style="color:#fff;margin:0">[AZIENDA]</h1></td></tr><tr><td style="padding:36px 40px;background:#fff"><h2 style="color:#1a1a2e">[TITOLO PRINCIPALE]</h2><p style="color:#555;line-height:1.8">[TESTO PRINCIPALE]</p></td></tr></table>',
        follow_up: '<table width="100%" style="max-width:580px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="padding:40px"><p style="color:#333;line-height:1.7">Gentile [NOME],</p><p style="color:#333;line-height:1.7">[CORPO PRINCIPALE]</p><p style="color:#1a1a2e;font-weight:700">[NOME MITTENTE]</p></td></tr></table>',
        offerta: '<table width="100%" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#1a1a2e;padding:24px 40px"><h1 style="color:#00ff9d;margin:0">[AZIENDA]</h1></td></tr><tr><td style="padding:36px 40px;background:#fff"><p style="color:#333;line-height:1.7">Gentile [NOME],</p><p style="color:#555">[CORPO PRINCIPALE]</p><p style="color:#1a1a2e;font-weight:700">[NOME MITTENTE]</p></td></tr></table>',
        evento: '<table width="100%" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#0f0f1a;padding:48px 40px;text-align:center"><h1 style="color:#00ff9d;margin:0">[NOME EVENTO]</h1><p style="color:#aaffcc">[DATA]</p></td></tr><tr><td style="padding:40px;background:#fff;text-align:center"><p style="color:#444;line-height:1.8">[DESCRIZIONE EVENTO]</p><table style="margin:0 auto"><tr><td style="background:#00ff9d;border-radius:8px;padding:14px 40px"><a href="[LINK_REGISTRAZIONE]" style="color:#0f0f1a;font-weight:700;text-decoration:none">Registrati</a></td></tr></table></td></tr></table>',
        ringraziamento: '<table width="100%" style="max-width:580px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#0f0f1a;padding:32px 40px;text-align:center"><h1 style="color:#fff">Grazie, [NOME]!</h1></td></tr><tr><td style="padding:40px;background:#fff"><p style="color:#333;line-height:1.8">[MESSAGGIO PERSONALE]</p><p style="color:#1a1a2e;font-weight:700">[NOME MITTENTE]</p></td></tr></table>',
      };
      const baseTplHtml = BULK_TEMPLATES[params.templateId];
      if (!baseTplHtml) return `Unknown templateId. Valid: ${Object.keys(BULK_TEMPLATES).join(', ')}`;
      const applyVars2 = (str, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split('[' + k + ']').join(v || ''), str);
      const results = [];
      for (const email of params.recipients) {
        const perVars = { ...(params.vars || {}), ...((params.perRecipientVars || {})[email] || {}) };
        const subject = applyVars2(params.subject, perVars);
        const html = applyVars2(baseTplHtml, perVars);
        try {
          await imapSendBulk(params.accountId, { to: email, subject, bodyHtml: html });
          results.push(`OK: ${email}`);
        } catch (e) {
          results.push(`FAIL: ${email} — ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 1200)); // 1.2s delay between sends
      }
      const ok = results.filter(r => r.startsWith('OK')).length;
      return `Bulk send complete: ${ok}/${params.recipients.length} sent.\n${results.join('\n')}`;
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

    case 'calendar_date': {
      const dateStr = params.date;
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return 'Invalid date format. Use YYYY-MM-DD.';
      const events = await getEventsForDate(config, dateStr);
      if (events.length === 0) return `No events scheduled for ${dateStr}.`;
      return formatEvents(events);
    }

    case 'calendar_upcoming': {
      const hours = params.hours || 2;
      const events = await getUpcomingEvents(config, hours);
      if (events.length === 0) return `No events in the next ${hours} hour(s).`;
      return formatEvents(events);
    }

    case 'calendar_create': {
      // Robustness: accept common param-name aliases that the model often
      // emits instead of `summary` (Google Calendar's official field name
      // for the event title — but LLMs trained on natural language confuse
      // "summary" with "description/note", so they sometimes put the actual
      // title under `title`/`name`/`subject` or even leave summary empty
      // and put the title text in `description`).
      let summary = params.summary || params.title || params.name || params.subject || '';
      let description = params.description || params.notes || '';

      // Last-resort fallback: if summary is still empty but description
      // looks like a title (one line, < 120 chars, no period), promote it.
      if (!summary.trim() && description.trim()) {
        const firstLine = description.split('\n')[0].trim();
        if (firstLine.length > 0 && firstLine.length < 120) {
          summary = firstLine;
          // If description was JUST the title, clear it — otherwise keep the rest
          const rest = description.split('\n').slice(1).join('\n').trim();
          description = rest;
        }
      }

      if (!summary.trim()) {
        return 'Error: event title (summary) is required. Please specify what the event is about.';
      }

      const created = await createEvent(config, {
        summary,
        start: params.start,
        end: params.end,
        description,
        attendees: params.attendees || [],
      });
      // Surface the eventId so the model/Telegram responder can use it for
      // subsequent calendar_update or calendar_delete in the same turn.
      const eventId = created?.id || created?.eventId || '';
      const idHint = eventId ? ` (eventId: ${eventId})` : '';
      return `Event "${summary}" created for ${formatTime(params.start)} - ${formatTime(params.end)}.${idHint}`;
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
      // Default to MONDAY of the current ISO week, not "today". When a user
      // asks "questa settimana"/"this week", they mean Mon..Sun of the calendar
      // week — not "next 7 days from today". If they want the latter they can
      // pass startDate explicitly.
      const isoMondayOfCurrentWeek = () => {
        const d = new Date();
        const day = d.getDay();                   // 0=Sun, 1=Mon, ..., 6=Sat
        const offset = day === 0 ? -6 : 1 - day;  // shift back to Monday
        const monday = new Date(d.getTime() + offset * 86400000);
        return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
      };
      const startDate = params.startDate || isoMondayOfCurrentWeek();
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

    case 'calendar_month': {
      // Determine target month: params.month = 'YYYY-MM' or defaults to current month
      const now = new Date();
      let year = now.getFullYear();
      let month = now.getMonth(); // 0-based

      if (params.month && /^\d{4}-\d{2}$/.test(params.month)) {
        const parts = params.month.split('-');
        year = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10) - 1; // convert to 0-based
      }

      const from = new Date(year, month, 1, 0, 0, 0);
      const to = new Date(year, month + 1, 1, 0, 0, 0);
      const events = await listEvents(config, 'primary', from, to);
      const monthLabel = from.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });

      if (events.length === 0) return `Nessun evento trovato per ${monthLabel}.`;

      const byDay = new Map();
      for (const e of events) {
        const day = e.start.split('T')[0];
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(e);
      }

      const lines = [`📅 ${monthLabel} — ${events.length} eventi:`];
      for (const [day, dayEvents] of [...byDay.entries()].sort()) {
        const d = new Date(day + 'T12:00:00');
        const dayName = d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' });
        lines.push(`\n${dayName}:`);
        for (const e of dayEvents) {
          const time = e.isAllDay ? 'Tutto il giorno' : `${formatTime(e.start)} - ${formatTime(e.end)}`;
          const loc = e.location ? ` @ ${e.location}` : '';
          lines.push(`  ${time} — ${e.summary}${loc}`);
        }
      }
      return lines.join('\n');
    }

    case 'calendar_find': {
      const queryRaw = (params.query || '').trim();
      const query = queryRaw.toLowerCase();
      // Token-level fuzzy match: handles voice-to-text typos like
      // "Italiano della BMW" matching event "Tagliando BMW" via the shared
      // significant token "BMW". Stop-words and articles are ignored.
      const STOP_WORDS = new Set(['il','la','i','le','gli','un','una','di','del','dello','della','dei','degli','delle','a','al','allo','alla','ai','agli','alle','con','per','su','da','in','e','o','che','the','a','an','of','for','to','in','on','with','and','or','my','your']);
      const tokens = query.split(/\s+/).filter(t => t.length >= 3 && !STOP_WORDS.has(t));

      const requestedDays = params.daysAhead || 30;
      // Try the requested range first, then auto-broaden to 90 days if empty.
      // Voice users frequently underestimate how far ahead an event is.
      const tryRange = async (days) => {
        const from = new Date();
        const to = new Date(from.getTime() + days * 86400000);
        const events = await listEvents(config, 'primary', from, to);

        // Strict substring match first
        let matches = events.filter(e =>
          (e.summary || '').toLowerCase().includes(query) ||
          (e.description || '').toLowerCase().includes(query)
        );

        // Fuzzy fallback: any significant token (3+ chars, no stop-word) matches
        if (matches.length === 0 && tokens.length > 0) {
          matches = events.filter(e => {
            const hay = ((e.summary || '') + ' ' + (e.description || '')).toLowerCase();
            return tokens.some(t => hay.includes(t));
          });
        }
        return { events, matches };
      };

      let { matches } = await tryRange(requestedDays);
      let effectiveDays = requestedDays;
      if (matches.length === 0 && requestedDays < 90) {
        const broad = await tryRange(90);
        matches = broad.matches;
        effectiveDays = 90;
      }

      if (matches.length === 0) {
        return `No events found matching "${queryRaw}" in the next ${effectiveDays} days (tried fuzzy match on tokens: ${tokens.join(', ') || '(none)'}). Try calendar_week or calendar_month for a broader view.`;
      }

      const widened = effectiveDays > requestedDays ? ` (auto-broadened to ${effectiveDays} days)` : '';
      return matches.map((e, i) => {
        const time = e.isAllDay ? 'All day' : `${formatTime(e.start)} - ${formatTime(e.end)}`;
        const date = e.start.split('T')[0];
        const loc = e.location ? ` | Location: ${e.location}` : '';
        return `${i + 1}. [eventId: ${e.id}] ${date} ${time} — ${e.summary}${loc}`;
      }).join('\n') + (widened ? `\n${widened}` : '');
    }

    case 'calendar_update': {
      let eventId = String(params.eventId || '').trim();
      if (!eventId) return 'eventId required. Call calendar_find or calendar_date first to get the REAL eventId.';

      // Reject obvious placeholder IDs (model copied from prompt examples or
      // emitted obvious patterns like "A1B2C3D4E5F6G7H8I9J0").
      if (isPlaceholderEventId(eventId)) {
        return `"${eventId}" looks invented (placeholder pattern). Call calendar_find or calendar_date FIRST to get real eventIds.`;
      }

      // Smart eventId resolution: if it looks like a name instead of a Google Calendar ID, search for it
      if (eventId.includes(' ') || eventId.length < 10 || /[A-Z]/.test(eventId)) {
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

      // Accept same param-name aliases as calendar_create so the model can
      // be sloppy about title vs summary without breaking things.
      const newSummary = params.summary || params.title || params.name || params.subject;
      const newDescription = params.description ?? params.notes;

      const patch = {};
      if (newSummary) patch.summary = newSummary;
      if (params.location) patch.location = params.location;
      if (newDescription !== undefined) patch.description = newDescription;
      if (params.start) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        patch.start = { dateTime: new Date(params.start).toISOString(), timeZone: tz };
      }
      if (params.end) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        patch.end = { dateTime: new Date(params.end).toISOString(), timeZone: tz };
      }
      if (Object.keys(patch).length === 0) {
        return 'No fields to update. Specify at least one of: summary (title), location, description, start, end.';
      }
      try {
        await updateEvent(config, 'primary', eventId, patch);
      } catch (err) {
        const msg = String(err?.message || err);
        if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
          return `eventId "${eventId}" does NOT exist in Google Calendar. The ID looks invented — DO NOT retry with this value. Call calendar_date or calendar_find FIRST to retrieve real eventIds, then call calendar_update with one of those.`;
        }
        throw err;
      }
      const changes = Object.keys(patch).join(', ');
      return `Event updated successfully (changed: ${changes})${newSummary ? `. New title: "${newSummary}"` : ''}${params.location ? `. New location: ${params.location}` : ''}`;
    }

    case 'calendar_delete': {
      if (!params.eventId) return 'eventId required. Call calendar_find or calendar_date first to get the REAL eventId.';
      let delEventId = String(params.eventId).trim();

      // Reject placeholder IDs the model may have copied verbatim from prompt
      // examples or hallucinated wholesale. Real Google Calendar eventIds
      // are long LOWERCASE alphanumeric strings — never UPPERCASE patterns
      // like "A1B2C3D4E5F6G7H8I9J0" (visibly invented).
      if (isPlaceholderEventId(delEventId)) {
        return `"${delEventId}" looks invented (placeholder pattern). Real Google Calendar eventIds are long lowercase alphanumeric strings (a-v + 0-9, often with - and _). Call calendar_date(YYYY-MM-DD) or calendar_find(query) FIRST to get the real eventIds, then call calendar_delete with one of those.`;
      }

      // Branch A — looks like a free-text search query (spaces, caps, very short).
      // The model passed a NAME instead of an ID — resolve to ID via listEvents.
      if (delEventId.includes(' ') || delEventId.length < 10 || /[A-Z]/.test(delEventId)) {
        const fromD = new Date();
        const toD = new Date(fromD.getTime() + 60 * 86400000);
        const evts = await listEvents(config, 'primary', fromD, toD);
        const m = evts.find(e => (e.summary || '').toLowerCase().includes(delEventId.toLowerCase()));
        if (m) {
          delEventId = m.id;
        } else {
          return `Could not find event matching "${params.eventId}" in the next 60 days. Use calendar_find or calendar_date to get the real eventId first.`;
        }
      }

      // Branch B — try the delete. If Google returns 404 the ID is invalid
      // (almost always means the model hallucinated it). Surface this clearly
      // to the LLM so its next turn doesn't try the same fake ID again.
      try {
        await deleteEvent(config, 'primary', delEventId);
        return `Event ${delEventId} deleted successfully.`;
      } catch (err) {
        const msg = String(err?.message || err);
        const is404 = msg.includes('404') || msg.toLowerCase().includes('not found');
        if (is404) {
          // Try to look up real events near the requested date (if user hinted one)
          const hintDate = params.date || params.day || params.on;
          let hint = '';
          if (hintDate) {
            try {
              const d = new Date(hintDate + 'T00:00:00');
              const from = d;
              const to = new Date(d.getTime() + 86400000);
              const evts = await listEvents(config, 'primary', from, to);
              if (evts.length > 0) {
                hint = `\n\nReal events on ${hintDate} (use these IDs, NOT invented ones):\n` +
                  evts.map(e => `- [eventId: ${e.id}] ${formatTime(e.start)} — ${e.summary || '(no title)'}`).join('\n');
              }
            } catch { /* ignore */ }
          }
          return `eventId "${delEventId}" does NOT exist in Google Calendar. Looks like it was invented — DO NOT retry with this ID. Call calendar_date(YYYY-MM-DD) or calendar_find(query) FIRST to get the real eventId, then call calendar_delete with the value you receive.${hint}`;
        }
        throw err;
      }
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
      return sl.sendMessage(config, params.channel, params.text, params.threadTs || null);
    }

    case 'slack_search': {
      const sl = await import('./slack.mjs');
      const results = await sl.searchMessages(config, params.query, { count: params.count || 20 });
      if (!results.length) return `No messages match "${params.query}".`;
      return results.map((r, i) =>
        `${i + 1}. [#${r.channel}] ${r.user} (${new Date(parseFloat(r.ts) * 1000).toLocaleString()}): ${r.text.slice(0, 200)}${r.permalink ? `\n   → ${r.permalink}` : ''}`,
      ).join('\n');
    }

    case 'slack_dm': {
      const sl = await import('./slack.mjs');
      const channelId = await sl.openDM(config, params.user);
      if (params.text) await sl.sendMessage(config, channelId, params.text);
      return params.text
        ? `DM sent to ${params.user} (channel ${channelId}).`
        : `Opened DM channel ${channelId} with ${params.user}.`;
    }

    case 'slack_thread': {
      const sl = await import('./slack.mjs');
      const replies = await sl.getThreadReplies(config, params.channel, params.ts);
      if (!replies.length) return 'Thread has no replies.';
      return replies.map((r, i) =>
        `${i + 1}. ${r.user} (${new Date(parseFloat(r.ts) * 1000).toLocaleTimeString()}): ${r.text.slice(0, 200)}`,
      ).join('\n');
    }

    case 'slack_react': {
      const sl = await import('./slack.mjs');
      return sl.addReaction(config, params.channel, params.ts, params.emoji || 'thumbsup');
    }

    case 'slack_mark_read': {
      const sl = await import('./slack.mjs');
      return sl.markRead(config, params.channel, params.ts || null);
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
          lines.push(dr.content.slice(0, 4000));
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

      // Use the rich variant so we get OpenGraph / JSON-LD / headings.
      // The structured preamble dramatically reduces hallucination on sites
      // where the body alone is ambiguous (e.g. SPA shells, B2B catalogs).
      const result = await wt.fetchUrlRich(url);
      if (result.error) {
        return `Fetch error (${result.code || 'UNKNOWN'}): ${result.message}. ` +
               `Try web_search to find an alternative source, or browser_open for JS-rendered pages.`;
      }

      const meta = result.metadata || {};
      const lines = [];
      if (result.title) lines.push(`Title: ${result.title}`);
      lines.push(`URL: ${result.url || url}`);
      lines.push(`Status: ${result.status}  Bytes: ${result.bytes}  Attempts: ${result.attempts}`);
      if (meta.description) lines.push(`Description: ${meta.description}`);
      if (meta.lang) lines.push(`Lang: ${meta.lang}`);
      if (meta.canonical) lines.push(`Canonical: ${meta.canonical}`);

      const ogKeys = Object.keys(meta.og || {});
      if (ogKeys.length) {
        const ogPairs = ogKeys.slice(0, 8).map(k => `${k}=${String(meta.og[k]).slice(0, 240)}`);
        lines.push(`OpenGraph: ${ogPairs.join(' | ')}`);
      }

      const ldTypes = (meta.jsonLd || []).map(j => j.type).filter(Boolean);
      if (ldTypes.length) {
        lines.push(`Schema.org types found: ${[...new Set(ldTypes)].join(', ')}`);
        const ldNames = (meta.jsonLd || []).map(j => j.name).filter(Boolean).slice(0, 5);
        if (ldNames.length) lines.push(`Schema.org entities: ${ldNames.join(' | ')}`);
      }

      if (meta.headings) {
        if (meta.headings.h1?.length) lines.push(`H1: ${meta.headings.h1.slice(0, 3).join(' | ')}`);
        if (meta.headings.h2?.length) lines.push(`H2: ${meta.headings.h2.slice(0, 6).join(' | ')}`);
      }

      if (result.truncated) lines.push('[Content was truncated due to size limits]');
      lines.push('');
      lines.push('--- MAIN CONTENT ---');
      lines.push(result.body);

      return lines.join('\n');
    }

    // ── Weather ──────────────────────────────────────────────────────────
    case 'get_weather': {
      const location = (params.location || '').trim();
      if (!location) return 'A location is required (e.g. "Rome", "Viterbo, Italy").';
      const encodedLoc = encodeURIComponent(location);
      const WTTR_UA = 'Mozilla/5.0 (compatible; nha-weather/1.0; +https://nothumanallowed.com)';
      const fetchWithRetry = async (attempts = 3) => {
        let lastErr = null;
        for (let i = 0; i < attempts; i++) {
          try {
            const r = await fetch(`https://wttr.in/${encodedLoc}?format=j1`, {
              headers: { 'User-Agent': WTTR_UA, 'Accept': 'application/json' },
              signal: AbortSignal.timeout(10_000),
            });
            if (r.ok) return r;
            // 429/5xx → retry; 4xx other → don't retry
            if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
              await new Promise(rs => setTimeout(rs, 600 * (i + 1) + Math.random() * 400));
              continue;
            }
            return r;
          } catch (e) {
            lastErr = e;
            if (i < attempts - 1) await new Promise(rs => setTimeout(rs, 600 * (i + 1)));
          }
        }
        if (lastErr) throw lastErr;
        return null;
      };
      try {
        const wttrRes = await fetchWithRetry(3);
        if (!wttrRes || !wttrRes.ok) {
          const status = wttrRes ? wttrRes.status : 'NET_ERR';
          return `Weather service returned ${status} for "${location}". Try a more specific location (e.g. "Rome, Italy") or use web_search("weather ${location}") as fallback.`;
        }
        const w = await wttrRes.json();
        const cur = w.current_condition?.[0];
        const area = w.nearest_area?.[0];
        if (!cur) return `No weather data found for "${location}".`;

        const cityName = area?.areaName?.[0]?.value || location;
        const country = area?.country?.[0]?.value || '';
        const desc = cur.weatherDesc?.[0]?.value || '';
        const tempC = cur.temp_C;
        const feelsC = cur.FeelsLikeC;
        const humidity = cur.humidity;
        const windKmph = cur.windspeedKmph;
        const windDir = cur.winddir16Point;
        const uvIndex = cur.uvIndex;
        const visibility = cur.visibility;
        const cloudcover = cur.cloudcover;

        const lines = [
          `📍 ${cityName}${country ? ', ' + country : ''}`,
          `🌡️  ${tempC}°C (feels like ${feelsC}°C) — ${desc}`,
          `💧 Humidity: ${humidity}%  |  💨 Wind: ${windKmph} km/h ${windDir}`,
          `☀️  UV Index: ${uvIndex}  |  👁️  Visibility: ${visibility} km  |  ☁️  Cloud: ${cloudcover}%`,
        ];

        // 3-day forecast
        const forecast = w.weather || [];
        if (forecast.length > 0) {
          lines.push('');
          lines.push('📅 3-day forecast:');
          for (const day of forecast.slice(0, 3)) {
            const date = day.date;
            const maxC = day.maxtempC;
            const minC = day.mintempC;
            const dayDesc = day.hourly?.[4]?.weatherDesc?.[0]?.value || '';
            const rain = day.hourly?.[4]?.chanceofrain || '0';
            lines.push(`  ${date}: ${minC}°C → ${maxC}°C  ${dayDesc}  🌧️ ${rain}% rain`);
          }
        }

        return lines.join('\n');
      } catch (e) {
        return `Weather lookup failed: ${e.message}. Try using web_search("weather ${location}") as fallback.`;
      }
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

    case 'execute_code': {
      const {
        language = 'python',
        code,
        files = [],    // [{path: string, content: string}] — extra files to write in sandbox
        packages = [], // string[] — pip/npm packages to install before running
        stdin = '',    // string — piped to process stdin
        timeout = 30,  // seconds (max 120)
      } = params;

      if (!code || typeof code !== 'string') return 'execute_code: missing required param "code"';

      // bash removed: unrestricted shell has full filesystem access and can exfiltrate data.
      const SUPPORTED = ['python', 'javascript', 'typescript'];
      if (!SUPPORTED.includes(language)) {
        return `execute_code: unsupported language "${language}" — use: ${SUPPORTED.join(', ')}`;
      }

      const { spawn } = await import('child_process');
      const os = await import('os');
      const fs = await import('fs');
      const path = await import('path');
      const crypto = await import('crypto');

      const MAX_OUTPUT_BYTES = 128 * 1024;   // 128 KB per stream
      const TIMEOUT_MS = Math.min(Math.max(timeout, 5), 120) * 1000;

      // ── Isolated sandbox directory ─────────────────────────────────────────
      // Each execution gets its own temp dir — cleaned up after run.
      // Subprocess never sees NHA's cwd or env vars (API keys etc.).
      const sandboxId = crypto.default.randomBytes(8).toString('hex');
      const sandboxDir = path.default.join(os.default.tmpdir(), `nha_sandbox_${sandboxId}`);
      fs.default.mkdirSync(sandboxDir, { recursive: true });

      // Stripped env — only safe POSIX vars, zero NHA secrets.
      // NOTE: packages install runs with network access (pip/npm fetch from registries).
      // This is an accepted risk for a local CLI tool — not suitable for server deployment.
      const safeEnv = {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: sandboxDir,
        TMPDIR: sandboxDir,
        LANG: 'en_US.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUNBUFFERED: '1',
        NODE_NO_WARNINGS: '1',
      };

      const cleanup = () => {
        try { fs.default.rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* ignore */ }
      };

      try {
        // ── Write extra files first ──────────────────────────────────────────
        for (const f of (files || [])) {
          if (!f.path || typeof f.content !== 'string') continue;
          // Prevent path traversal — only allow relative paths inside sandbox
          const safePath = path.default.join(sandboxDir, path.default.normalize(f.path).replace(/^(\.\.[/\\])+/, ''));
          fs.default.mkdirSync(path.default.dirname(safePath), { recursive: true });
          fs.default.writeFileSync(safePath, f.content, 'utf-8');
        }

        // ── Install packages ─────────────────────────────────────────────────
        if (packages && packages.length > 0) {
          const validPkgName = /^[a-zA-Z0-9@._/-]+$/;
          const safePkgs = packages.filter(p => typeof p === 'string' && validPkgName.test(p) && p.length < 80);
          if (safePkgs.length > 0) {
            let installCmd, installArgs;
            if (language === 'python') {
              installCmd = 'pip3';
              // --only-binary=:all: forces pre-built wheels — no setup.py/build hook execution,
              // eliminating arbitrary code execution during install.
              // Network access is still live (accepted risk for local CLI; use --no-index for server).
              installArgs = ['install', '--quiet', '--only-binary=:all:', '--target', path.default.join(sandboxDir, 'site-packages'), ...safePkgs];
            } else {
              // javascript / typescript
              fs.default.writeFileSync(path.default.join(sandboxDir, 'package.json'), JSON.stringify({ type: 'module' }));
              installCmd = 'npm';
              installArgs = ['install', '--prefix', sandboxDir, '--no-save', '--quiet', ...safePkgs];
            }
            await new Promise((resolve) => {
              const inst = spawn(installCmd, installArgs, { cwd: sandboxDir, env: safeEnv, timeout: 60_000 });
              inst.on('close', resolve);
              inst.on('error', resolve);
            });
          }
        }

        // ── Resolve runtime + write main entrypoint ──────────────────────────
        let cmd, cmdArgs, mainFile;
        if (language === 'python') {
          mainFile = path.default.join(sandboxDir, 'main.py');
          // Prepend sys.path so installed packages are found
          const sitePkgs = path.default.join(sandboxDir, 'site-packages');
          const preamble = `import sys; sys.path.insert(0, ${JSON.stringify(sitePkgs)})\n`;
          fs.default.writeFileSync(mainFile, preamble + code, 'utf-8');
          cmd = 'python3'; cmdArgs = [mainFile];
        } else if (language === 'javascript') {
          mainFile = path.default.join(sandboxDir, 'main.mjs');
          fs.default.writeFileSync(mainFile, code, 'utf-8');
          cmd = 'node'; cmdArgs = [mainFile];
        } else if (language === 'typescript') {
          // Prefer tsx (faster, more compatible), fallback to node --experimental-strip-types (Node 22+)
          mainFile = path.default.join(sandboxDir, 'main.ts');
          fs.default.writeFileSync(mainFile, code, 'utf-8');
          const tsxPath = getTsxPath();
          if (tsxPath) { cmd = tsxPath; cmdArgs = [mainFile]; }
          else { cmd = 'node'; cmdArgs = ['--experimental-strip-types', mainFile]; }
        }

        // ── Execute ──────────────────────────────────────────────────────────
        const result = await new Promise((resolve) => {
          const child = spawn(cmd, cmdArgs, {
            cwd: sandboxDir,
            env: safeEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          // Feed stdin if provided
          if (stdin) {
            child.stdin.write(stdin);
            child.stdin.end();
          } else {
            child.stdin.end();
          }

          let stdoutBuf = '';
          let stderrBuf = '';
          let stdoutTrunc = false;
          let stderrTrunc = false;

          child.stdout.on('data', (d) => {
            if (stdoutBuf.length < MAX_OUTPUT_BYTES) stdoutBuf += d.toString();
            else stdoutTrunc = true;
          });
          child.stderr.on('data', (d) => {
            if (stderrBuf.length < MAX_OUTPUT_BYTES) stderrBuf += d.toString();
            else stderrTrunc = true;
          });

          // Hard kill after timeout
          const killer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
            resolve({ exit_code: 124, stdout: stdoutBuf, stderr: stderrBuf, timed_out: true });
          }, TIMEOUT_MS);

          child.on('close', (exitCode) => {
            clearTimeout(killer);
            resolve({
              exit_code: exitCode ?? 1,
              stdout: stdoutBuf + (stdoutTrunc ? '\n[stdout truncated at 128 KB]' : ''),
              stderr: stderrBuf + (stderrTrunc ? '\n[stderr truncated at 128 KB]' : ''),
              timed_out: false,
            });
          });

          child.on('error', (err) => {
            clearTimeout(killer);
            resolve({ exit_code: 1, stdout: '', stderr: `[spawn error] ${err.message}`, timed_out: false });
          });
        });

        // ── Collect created/modified files ───────────────────────────────────
        // List files written inside sandbox (excluding the main entrypoint and site-packages)
        let createdFiles = [];
        try {
          const walk = (dir, base) => {
            for (const entry of fs.default.readdirSync(dir, { withFileTypes: true })) {
              const rel = base ? `${base}/${entry.name}` : entry.name;
              if (entry.isDirectory()) {
                if (!['site-packages', 'node_modules', '__pycache__'].includes(entry.name)) walk(path.default.join(dir, entry.name), rel);
              } else if (!['main.py','main.mjs','main.ts','main.sh','package.json'].includes(entry.name)) {
                const size = fs.default.statSync(path.default.join(dir, entry.name)).size;
                createdFiles.push(`  ${rel} (${size} bytes)`);
              }
            }
          };
          walk(sandboxDir, '');
        } catch {}

        // ── Format response ──────────────────────────────────────────────────
        const lines = [];
        if (result.timed_out) lines.push(`⏱ TIMEOUT — execution exceeded ${timeout}s (exit 124)`);
        lines.push(`exit_code: ${result.exit_code}${result.exit_code === 0 ? ' ✓' : ' ✗'}`);
        if (result.stdout.trim()) lines.push(`\nstdout:\n${result.stdout.trimEnd()}`);
        if (result.stderr.trim()) lines.push(`\nstderr:\n${result.stderr.trimEnd()}`);
        if (!result.stdout.trim() && !result.stderr.trim()) lines.push('\n(no output)');
        if (createdFiles.length > 0) lines.push(`\nfiles written in sandbox:\n${createdFiles.join('\n')}`);

        return lines.join('\n');
      } finally {
        cleanup();
      }
    }

    // ── Financial Market Data ────────────────────────────────────────────
    // All endpoints are free-tier, no API key required for Yahoo Finance, CoinGecko.
    // FRED macro data requires a free key (optional — falls back gracefully).

    case 'market_price': {
      const ticker = (params.ticker || '').trim().toUpperCase();
      if (!ticker) return 'market_price: ticker is required (e.g. "AAPL", "BTC-USD", "EURUSD=X")';

      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true&events=div%2Csplits`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)',
            'Accept': 'application/json',
          },
        });
        if (!res.ok) return `market_price: Yahoo Finance returned HTTP ${res.status} for ${ticker}. Check the ticker symbol.`;
        const data = await res.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) return `market_price: No data found for ticker "${ticker}". Try adding the exchange suffix (e.g. "ENI.MI" for Borsa Italiana, "BMW.DE" for XETRA).`;

        const price = meta.regularMarketPrice;
        const prev  = meta.previousClose || meta.chartPreviousClose;
        const change = prev ? price - prev : null;
        const changePct = prev ? ((price - prev) / prev) * 100 : null;
        const currency = meta.currency || 'USD';
        const exchange = meta.exchangeName || meta.fullExchangeName || '';
        const marketState = meta.marketState || 'UNKNOWN';
        const dayHigh = meta.regularMarketDayHigh;
        const dayLow  = meta.regularMarketDayLow;
        const volume  = meta.regularMarketVolume;
        const fiftyTwoHigh = meta.fiftyTwoWeekHigh;
        const fiftyTwoLow  = meta.fiftyTwoWeekLow;

        const fmtNum = (n, d=2) => n != null ? n.toFixed(d) : 'N/A';
        const fmtVol = (n) => {
          if (n == null) return 'N/A';
          if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
          if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
          if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
          return n.toString();
        };

        const arrow = change == null ? '' : change >= 0 ? '+' : '';
        const lines = [
          `${ticker} — ${exchange} [${marketState}]`,
          `Price: ${fmtNum(price)} ${currency}  ${arrow}${fmtNum(change)} (${arrow}${fmtNum(changePct)}%)`,
          `Day Range: ${fmtNum(dayLow)} – ${fmtNum(dayHigh)}`,
          `52-Week Range: ${fmtNum(fiftyTwoLow)} – ${fmtNum(fiftyTwoHigh)}`,
          `Volume: ${fmtVol(volume)}`,
          `As of: ${new Date(meta.regularMarketTime * 1000).toISOString()}`,
        ];
        return lines.join('\n');
      } catch (e) {
        return `market_price error: ${e.message}`;
      }
    }

    case 'market_chart': {
      const ticker   = (params.ticker || '').trim().toUpperCase();
      const period   = params.period   || '3mo';  // 1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max
      const interval = params.interval || '1d';   // 1m 2m 5m 15m 30m 60m 90m 1h 1d 5d 1wk 1mo 3mo
      if (!ticker) return 'market_chart: ticker is required';

      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${period}&events=div%2Csplits`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        if (!res.ok) return `market_chart: HTTP ${res.status} for ${ticker}`;
        const data = await res.json();
        const result = data?.chart?.result?.[0];
        if (!result) return `market_chart: No data for "${ticker}"`;

        const meta        = result.meta;
        const timestamps  = result.timestamp || [];
        const ohlcv       = result.indicators?.quote?.[0] || {};
        const closes      = ohlcv.close  || [];
        const opens       = ohlcv.open   || [];
        const highs       = ohlcv.high   || [];
        const lows        = ohlcv.low    || [];
        const volumes     = ohlcv.volume || [];

        // Filter valid candles
        const candles = timestamps.map((t, i) => ({
          date: new Date(t * 1000).toISOString().slice(0, 10),
          open:  opens[i],  high: highs[i], low: lows[i],
          close: closes[i], volume: volumes[i],
        })).filter(c => c.close != null);

        if (candles.length < 2) return `market_chart: insufficient data for ${ticker}`;

        // ── Technical indicators (computed in pure JS — no dependencies) ──

        // EMA helper
        const ema = (arr, n) => {
          const k = 2 / (n + 1);
          const out = [];
          let prev = null;
          for (const v of arr) {
            if (v == null) { out.push(null); continue; }
            if (prev == null) { out.push(v); prev = v; continue; }
            const e = v * k + prev * (1 - k);
            out.push(e);
            prev = e;
          }
          return out;
        };

        const priceArr = candles.map(c => c.close);

        // EMA 20 & 50
        const ema20arr = ema(priceArr, 20);
        const ema50arr = ema(priceArr, 50);
        const ema20 = ema20arr[ema20arr.length - 1];
        const ema50 = ema50arr[ema50arr.length - 1];

        // RSI 14
        let gains = 0, losses = 0;
        const rsiBars = priceArr.slice(-15);
        for (let i = 1; i < rsiBars.length; i++) {
          const d = rsiBars[i] - rsiBars[i - 1];
          if (d > 0) gains += d; else losses += Math.abs(d);
        }
        const avgGain = gains / 14;
        const avgLoss = losses / 14;
        const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

        // MACD (12/26/9)
        const ema12arr = ema(priceArr, 12);
        const ema26arr = ema(priceArr, 26);
        const macdLine  = ema12arr.map((v, i) => (v != null && ema26arr[i] != null) ? v - ema26arr[i] : null);
        const macdSignal = ema(macdLine.filter(v => v != null), 9);
        const macdVal    = macdLine[macdLine.length - 1];
        const signalVal  = macdSignal[macdSignal.length - 1];
        const macdHist   = macdVal != null && signalVal != null ? macdVal - signalVal : null;

        // ATR 14
        const atrPeriod = 14;
        const trs = candles.slice(-(atrPeriod + 1)).map((c, i, arr) => {
          if (i === 0) return c.high - c.low;
          const prev = arr[i - 1].close;
          return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
        });
        const atr = trs.reduce((a, b) => a + b, 0) / trs.length;

        // Volume SMA 20
        const vols = volumes.filter(v => v != null);
        const volSma20 = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);

        const lastCandle = candles[candles.length - 1];
        const firstCandle = candles[0];
        const totalReturn = ((lastCandle.close / firstCandle.close) - 1) * 100;

        const maxHigh = Math.max(...candles.map(c => c.high).filter(Boolean));
        const minLow  = Math.min(...candles.map(c => c.low).filter(Boolean));

        const fmt2 = (n) => n != null ? n.toFixed(2) : 'N/A';
        const fmtV = (n) => {
          if (n == null) return 'N/A';
          if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
          if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
          return (n/1e3).toFixed(0) + 'K';
        };

        const rsiSignal = rsi < 30 ? 'OVERSOLD' : rsi > 70 ? 'OVERBOUGHT' : 'NEUTRAL';
        const macdSignalStr = macdHist != null ? (macdHist > 0 ? 'BULLISH' : 'BEARISH') : 'N/A';
        const trend = ema20 && ema50 ? (ema20 > ema50 ? 'BULLISH (EMA20 > EMA50)' : 'BEARISH (EMA20 < EMA50)') : 'N/A';

        const lines = [
          `${ticker} Chart — ${period} / ${interval} bars (${candles.length} candles)`,
          `Currency: ${meta.currency || 'USD'} | Exchange: ${meta.exchangeName || ''}`,
          '',
          `── Price Summary ──`,
          `Current:  ${fmt2(lastCandle.close)}  (${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}% period return)`,
          `Period High: ${fmt2(maxHigh)}  |  Period Low: ${fmt2(minLow)}`,
          `Last Candle: O ${fmt2(lastCandle.open)} H ${fmt2(lastCandle.high)} L ${fmt2(lastCandle.low)} C ${fmt2(lastCandle.close)} V ${fmtV(lastCandle.volume)}`,
          '',
          `── Technical Indicators ──`,
          `RSI(14):     ${fmt2(rsi)} → ${rsiSignal}`,
          `MACD(12,26,9): Line ${fmt2(macdVal)} / Signal ${fmt2(signalVal)} / Hist ${fmt2(macdHist)} → ${macdSignalStr}`,
          `EMA(20):     ${fmt2(ema20)}`,
          `EMA(50):     ${fmt2(ema50)}`,
          `Trend:       ${trend}`,
          `ATR(14):     ${fmt2(atr)} (volatility proxy)`,
          `Vol SMA(20): ${fmtV(volSma20)}  |  Last Volume: ${fmtV(lastCandle.volume)}`,
          '',
          `── Last 10 Candles (OHLCV) ──`,
          candles.slice(-10).map(c =>
            `${c.date}  O ${fmt2(c.open)} H ${fmt2(c.high)} L ${fmt2(c.low)} C ${fmt2(c.close)}  V ${fmtV(c.volume)}`
          ).join('\n'),
        ];

        return lines.join('\n');
      } catch (e) {
        return `market_chart error: ${e.message}`;
      }
    }

    case 'market_indicators': {
      const ticker = (params.ticker || '').trim().toUpperCase();
      if (!ticker) return 'market_indicators: ticker is required';

      try {
        // Fetch quote summary — fundamentals, key stats, analyst data
        const url = `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=summaryDetail%2CdefaultKeyStatistics%2CfinancialData%2CassetProfile%2CearningsTrend%2CrecommendationTrend`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        if (!res.ok) return `market_indicators: HTTP ${res.status} for ${ticker}`;
        const data = await res.json();
        const r = data?.quoteSummary?.result?.[0];
        if (!r) return `market_indicators: No fundamental data for "${ticker}"`;

        const sd  = r.summaryDetail || {};
        const ks  = r.defaultKeyStatistics || {};
        const fd  = r.financialData || {};
        const ap  = r.assetProfile || {};
        const rt  = r.recommendationTrend?.trend?.[0] || {};

        const fmtN  = (v) => v?.raw != null ? v.raw.toFixed(2) : (v?.fmt || 'N/A');
        const fmtPct = (v) => v?.raw != null ? (v.raw * 100).toFixed(2) + '%' : (v?.fmt || 'N/A');
        const fmtLg = (v) => {
          const n = v?.raw ?? v;
          if (n == null) return 'N/A';
          if (n >= 1e12) return (n/1e12).toFixed(2) + 'T';
          if (n >= 1e9)  return (n/1e9).toFixed(2) + 'B';
          if (n >= 1e6)  return (n/1e6).toFixed(2) + 'M';
          return n.toFixed(0);
        };

        const totalBuy = (rt.strongBuy?.raw || 0) + (rt.buy?.raw || 0);
        const totalSell = (rt.strongSell?.raw || 0) + (rt.sell?.raw || 0);
        const totalHold = rt.hold?.raw || 0;
        const analystSum = totalBuy + totalSell + totalHold;
        const analystRec = analystSum > 0
          ? `Buy: ${totalBuy} | Hold: ${totalHold} | Sell: ${totalSell} (${analystSum} analysts)`
          : 'N/A';

        const lines = [
          `${ticker} — Fundamental & Key Indicators`,
          `Sector: ${ap.sector || 'N/A'}  |  Industry: ${ap.industry || 'N/A'}`,
          '',
          `── Valuation ──`,
          `Market Cap:       ${fmtLg(sd.marketCap)}`,
          `Enterprise Value: ${fmtLg(ks.enterpriseValue)}`,
          `P/E (trailing):   ${fmtN(sd.trailingPE)}`,
          `P/E (forward):    ${fmtN(sd.forwardPE)}`,
          `PEG Ratio:        ${fmtN(ks.pegRatio)}`,
          `P/B Ratio:        ${fmtN(ks.priceToBook)}`,
          `EV/EBITDA:        ${fmtN(ks.enterpriseToEbitda)}`,
          `EV/Revenue:       ${fmtN(ks.enterpriseToRevenue)}`,
          '',
          `── Profitability ──`,
          `Revenue (TTM):        ${fmtLg(fd.totalRevenue)}`,
          `Revenue Growth (YoY): ${fmtPct(fd.revenueGrowth)}`,
          `Gross Margin:         ${fmtPct(fd.grossMargins)}`,
          `EBITDA Margin:        ${fmtPct(fd.ebitdaMargins)}`,
          `Operating Margin:     ${fmtPct(fd.operatingMargins)}`,
          `Profit Margin:        ${fmtPct(fd.profitMargins)}`,
          `ROE:                  ${fmtPct(fd.returnOnEquity)}`,
          `ROA:                  ${fmtPct(fd.returnOnAssets)}`,
          '',
          `── Balance Sheet ──`,
          `Total Cash:    ${fmtLg(fd.totalCash)}`,
          `Total Debt:    ${fmtLg(fd.totalDebt)}`,
          `Debt/Equity:   ${fmtN(fd.debtToEquity)}`,
          `Current Ratio: ${fmtN(fd.currentRatio)}`,
          `Quick Ratio:   ${fmtN(fd.quickRatio)}`,
          '',
          `── Dividends & Shares ──`,
          `Dividend Yield:  ${fmtPct(sd.dividendYield)}`,
          `Payout Ratio:    ${fmtPct(sd.payoutRatio)}`,
          `Shares Out:      ${fmtLg(ks.sharesOutstanding)}`,
          `Float:           ${fmtLg(ks.floatShares)}`,
          `Short Interest:  ${fmtPct(ks.shortPercentOfFloat)}`,
          `Beta:            ${fmtN(sd.beta)}`,
          '',
          `── Analyst Consensus ──`,
          `Recommendation: ${fd.recommendationKey?.toUpperCase() || 'N/A'}`,
          `Target Price:   ${fmtN(fd.targetMeanPrice)} (low ${fmtN(fd.targetLowPrice)} / high ${fmtN(fd.targetHighPrice)})`,
          `Analysts:       ${analystRec}`,
        ];

        return lines.join('\n');
      } catch (e) {
        return `market_indicators error: ${e.message}`;
      }
    }

    case 'macro_data': {
      // Returns key macro indicators from multiple free sources
      // FRED requires a free API key (optional — config.fredApiKey or env FRED_API_KEY)
      const indicator = (params.indicator || 'all').toLowerCase();
      const fredKey = config?.fredApiKey || process.env.FRED_API_KEY || null;

      const results = [];

      // ── 1. Treasury yields from Yahoo Finance (always available) ──
      const yieldTickers = [
        ['^IRX',  '13-Week T-Bill'],
        ['^FVX',  '5-Year T-Note'],
        ['^TNX',  '10-Year T-Note'],
        ['^TYX',  '30-Year T-Bond'],
      ];

      if (indicator === 'all' || indicator === 'yield' || indicator === 'yields' || indicator === 'curve') {
        const yieldResults = await Promise.all(yieldTickers.map(async ([sym, name]) => {
          try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
            const d = await res.json();
            const meta = d?.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice) return `  ${name.padEnd(20)} ${meta.regularMarketPrice.toFixed(3)}%`;
            return `  ${name.padEnd(20)} N/A`;
          } catch { return `  ${name.padEnd(20)} N/A`; }
        }));
        results.push('── U.S. Treasury Yield Curve ──');
        results.push(...yieldResults);
        // Inversion check
        try {
          const r2 = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=5d', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
          const r10 = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
          const d2 = (await r2.json())?.chart?.result?.[0]?.meta;
          const d10 = (await r10.json())?.chart?.result?.[0]?.meta;
          if (d2 && d10) {
            const spread = d10.regularMarketPrice - d2.regularMarketPrice;
            const inv = spread < 0 ? ' *** INVERTED — recession signal ***' : '';
            results.push(`  10Y-3M Spread: ${spread.toFixed(3)}%${inv}`);
          }
        } catch {}
        results.push('');
      }

      // ── 2. Key commodities & FX ──
      const commodTickers = [
        ['GC=F',   'Gold ($/oz)'],
        ['SI=F',   'Silver ($/oz)'],
        ['CL=F',   'WTI Crude Oil ($/bbl)'],
        ['NG=F',   'Nat. Gas ($/MMBtu)'],
        ['EURUSD=X', 'EUR/USD'],
        ['DX-Y.NYB', 'DXY (Dollar Index)'],
      ];

      if (indicator === 'all' || indicator === 'commodities' || indicator === 'fx' || indicator === 'commodity') {
        const commodResults = await Promise.all(commodTickers.map(async ([sym, name]) => {
          try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
            const d = await res.json();
            const meta = d?.chart?.result?.[0]?.meta;
            if (!meta?.regularMarketPrice) return `  ${name.padEnd(26)} N/A`;
            const prev = meta.previousClose || meta.chartPreviousClose;
            const chg = prev ? ((meta.regularMarketPrice - prev) / prev * 100).toFixed(2) : null;
            const chgStr = chg != null ? ` (${parseFloat(chg) >= 0 ? '+' : ''}${chg}%)` : '';
            return `  ${name.padEnd(26)} ${meta.regularMarketPrice.toFixed(3)}${chgStr}`;
          } catch { return `  ${name.padEnd(26)} N/A`; }
        }));
        results.push('── Commodities & FX ──');
        results.push(...commodResults);
        results.push('');
      }

      // ── 3. Major equity indices ──
      const indexTickers = [
        ['^GSPC',  'S&P 500'],
        ['^NDX',   'Nasdaq 100'],
        ['^DJI',   'Dow Jones'],
        ['^RUT',   'Russell 2000'],
        ['^VIX',   'VIX (Fear Index)'],
        ['^STOXX50E', 'EURO STOXX 50'],
        ['^FCHI',  'CAC 40'],
        ['^GDAXI', 'DAX'],
        ['^N225',  'Nikkei 225'],
        ['000001.SS', 'Shanghai Comp.'],
      ];

      if (indicator === 'all' || indicator === 'indices' || indicator === 'index' || indicator === 'equity') {
        const idxResults = await Promise.all(indexTickers.map(async ([sym, name]) => {
          try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
            const d = await res.json();
            const meta = d?.chart?.result?.[0]?.meta;
            if (!meta?.regularMarketPrice) return `  ${name.padEnd(20)} N/A`;
            const prev = meta.previousClose || meta.chartPreviousClose;
            const chg = prev ? ((meta.regularMarketPrice - prev) / prev * 100).toFixed(2) : null;
            const chgStr = chg != null ? ` (${parseFloat(chg) >= 0 ? '+' : ''}${chg}%)` : '';
            return `  ${name.padEnd(20)} ${meta.regularMarketPrice.toFixed(2)}${chgStr}`;
          } catch { return `  ${name.padEnd(20)} N/A`; }
        }));
        results.push('── Global Equity Indices ──');
        results.push(...idxResults);
        results.push('');
      }

      // ── 4. FRED macro indicators (requires free key) ──
      if (fredKey && (indicator === 'all' || indicator === 'macro' || indicator === 'fred')) {
        const fredSeries = [
          ['FEDFUNDS',   'Fed Funds Rate'],
          ['CPIAUCSL',   'CPI (YoY)'],
          ['UNRATE',     'Unemployment Rate'],
          ['GDP',        'US GDP (Annualized)'],
          ['T10YIE',     '10Y Breakeven Inflation'],
          ['IORB',       'Interest on Reserve Balances'],
        ];
        const fredResults = await Promise.all(fredSeries.map(async ([id, name]) => {
          try {
            const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${fredKey}&file_type=json&sort_order=desc&limit=2`;
            const res = await fetch(url);
            const d = await res.json();
            const obs = d?.observations?.filter(o => o.value !== '.') || [];
            const latest = obs[0];
            if (!latest) return `  ${name.padEnd(30)} N/A`;
            return `  ${name.padEnd(30)} ${latest.value}  (${latest.date})`;
          } catch { return `  ${name.padEnd(30)} N/A`; }
        }));
        results.push('── FRED Macro Indicators ──');
        results.push(...fredResults);
        results.push('');
      } else if (!fredKey && (indicator === 'macro' || indicator === 'fred')) {
        results.push('── FRED Macro Indicators ──');
        results.push('  FRED API key not configured. Set config.fredApiKey or FRED_API_KEY env var.');
        results.push('  Free key at: https://fred.stlouisfed.org/docs/api/api_key.html');
        results.push('');
      }

      if (results.length === 0) return `macro_data: unknown indicator "${params.indicator}". Use: all | yield | commodities | indices | macro`;
      return [`Macro Overview — ${new Date().toUTCString()}`, '', ...results].join('\n');
    }

    case 'crypto_data': {
      const coin = (params.coin || 'bitcoin').toLowerCase().replace(/\s+/g, '-');
      const vsCurrency = (params.vs_currency || 'usd').toLowerCase();

      try {
        // CoinGecko free tier — no API key needed (60 req/min)
        const [marketRes, globalRes] = await Promise.all([
          fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin)}?localization=false&tickers=true&market_data=true&community_data=false&developer_data=false&sparkline=true`, {
            headers: { 'Accept': 'application/json' },
          }),
          fetch('https://api.coingecko.com/api/v3/global', { headers: { 'Accept': 'application/json' } }),
        ]);

        if (!marketRes.ok) {
          // Try searching by symbol
          const searchRes = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(coin)}`, { headers: { 'Accept': 'application/json' } });
          const searchData = await searchRes.json();
          const found = searchData?.coins?.[0];
          if (found) return `crypto_data: "${coin}" not found. Did you mean "${found.id}" (${found.symbol.toUpperCase()})? Retry with that id.`;
          return `crypto_data: "${coin}" not found on CoinGecko.`;
        }

        const d  = await marketRes.json();
        const gl = marketRes.ok && globalRes.ok ? (await globalRes.json())?.data : null;
        const md = d.market_data;
        const p  = md?.current_price?.[vsCurrency];
        const mc = md?.market_cap?.[vsCurrency];
        const vol = md?.total_volume?.[vsCurrency];
        const h24 = md?.high_24h?.[vsCurrency];
        const l24 = md?.low_24h?.[vsCurrency];
        const chg1h  = md?.price_change_percentage_1h_in_currency?.[vsCurrency];
        const chg24  = md?.price_change_percentage_24h_in_currency?.[vsCurrency];
        const chg7d  = md?.price_change_percentage_7d_in_currency?.[vsCurrency];
        const chg30d = md?.price_change_percentage_30d_in_currency?.[vsCurrency];
        const chgYtd = md?.price_change_percentage_1y_in_currency?.[vsCurrency];
        const ath    = md?.ath?.[vsCurrency];
        const athDate = md?.ath_date?.[vsCurrency]?.slice(0, 10);
        const athPct  = md?.ath_change_percentage?.[vsCurrency];
        const supply  = md?.circulating_supply;
        const maxSupply = md?.max_supply;
        const mcRank = d.market_cap_rank;

        const fmtP   = (n) => n != null ? n.toLocaleString('en-US', { maximumFractionDigits: 6 }) : 'N/A';
        const fmtPct = (n) => n != null ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : 'N/A';
        const fmtLg  = (n) => {
          if (n == null) return 'N/A';
          if (n >= 1e12) return (n/1e12).toFixed(2) + 'T';
          if (n >= 1e9)  return (n/1e9).toFixed(2) + 'B';
          if (n >= 1e6)  return (n/1e6).toFixed(2) + 'M';
          return n.toFixed(0);
        };

        // Sparkline momentum signal
        const sparkline = md?.sparkline_in_7d?.price || [];
        const sparkStart = sparkline[0];
        const sparkEnd   = sparkline[sparkline.length - 1];
        const sparkMomentum = sparkStart && sparkEnd ? ((sparkEnd - sparkStart) / sparkStart * 100).toFixed(2) : null;

        // Supply inflation
        const supplyPct = supply && maxSupply ? ((supply / maxSupply) * 100).toFixed(1) + '%' : 'uncapped';

        // Fear/Greed proxy via ATH distance
        const fearGreedy = athPct != null ? (athPct > -20 ? 'GREED ZONE' : athPct > -60 ? 'NEUTRAL' : 'FEAR ZONE') : 'N/A';

        const lines = [
          `${d.name} (${d.symbol?.toUpperCase()}) — CoinGecko  |  Rank #${mcRank || 'N/A'}`,
          `Category: ${(d.categories || []).slice(0, 3).join(', ') || 'N/A'}`,
          '',
          `── Price & Market Data ──`,
          `Price:       ${fmtP(p)} ${vsCurrency.toUpperCase()}`,
          `24h Range:   ${fmtP(l24)} – ${fmtP(h24)}`,
          `Market Cap:  ${fmtLg(mc)} ${vsCurrency.toUpperCase()}`,
          `24h Volume:  ${fmtLg(vol)} ${vsCurrency.toUpperCase()}`,
          `Vol/MC:      ${mc && vol ? (vol / mc * 100).toFixed(2) + '%' : 'N/A'}`,
          '',
          `── Performance ──`,
          `1h:   ${fmtPct(chg1h)}`,
          `24h:  ${fmtPct(chg24)}`,
          `7d:   ${fmtPct(chg7d)}`,
          `30d:  ${fmtPct(chg30d)}`,
          `1y:   ${fmtPct(chgYtd)}`,
          `7d Sparkline Momentum: ${sparkMomentum != null ? fmtPct(parseFloat(sparkMomentum)) : 'N/A'}`,
          '',
          `── On-Chain / Supply ──`,
          `ATH:           ${fmtP(ath)} ${vsCurrency.toUpperCase()} (${athDate}) — ${fmtPct(athPct)} from ATH`,
          `Circulating:   ${fmtLg(supply)} ${d.symbol?.toUpperCase() || ''}`,
          `Max Supply:    ${maxSupply ? fmtLg(maxSupply) : 'None (uncapped)'}`,
          `Supply %:      ${supplyPct}`,
          `ATH Distance Zone: ${fearGreedy}`,
        ];

        // Global market context
        if (gl) {
          const glMcPct = gl.market_cap_percentage;
          const btcDom = glMcPct?.btc ? glMcPct.btc.toFixed(1) + '%' : 'N/A';
          const ethDom = glMcPct?.eth ? glMcPct.eth.toFixed(1) + '%' : 'N/A';
          const totalMc = gl.total_market_cap?.[vsCurrency];
          lines.push('');
          lines.push('── Crypto Market Context ──');
          lines.push(`Total Crypto Market Cap: ${fmtLg(totalMc)} ${vsCurrency.toUpperCase()}`);
          lines.push(`BTC Dominance: ${btcDom}  |  ETH Dominance: ${ethDom}`);
          lines.push(`Active Coins: ${(gl.active_cryptocurrencies || 0).toLocaleString()}`);
        }

        return lines.join('\n');
      } catch (e) {
        return `crypto_data error: ${e.message}`;
      }
    }

    case 'market_news': {
      const query  = params.query  || params.ticker || '';
      const ticker = params.ticker || '';
      const limit  = Math.min(params.limit || 10, 20);

      try {
        let articles = [];

        // Source 1: Yahoo Finance news for a specific ticker
        if (ticker) {
          const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=${limit}&quotesCount=0&enableFuzzyQuery=false`;
          const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)', 'Accept': 'application/json' } });
          if (res.ok) {
            const d = await res.json();
            const news = d?.news || [];
            articles = news.map(n => ({
              title:     n.title,
              source:    n.publisher,
              published: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'N/A',
              url:       n.link,
            }));
          }
        }

        // Source 2: Yahoo Finance search for general query
        if (articles.length === 0 && query) {
          const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=${limit}&quotesCount=0`;
          const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)', 'Accept': 'application/json' } });
          if (res.ok) {
            const d = await res.json();
            articles = (d?.news || []).map(n => ({
              title:     n.title,
              source:    n.publisher,
              published: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'N/A',
              url:       n.link,
            }));
          }
        }

        // Source 3: Fallback to web_search via fetch for financial news
        if (articles.length === 0) {
          const wt = await import('./web-tools.mjs');
          const searchQ = query || ticker ? `${query || ticker} stock market news today` : 'financial markets news today';
          const sr = await wt.webSearch(searchQ);
          if (sr.results?.length > 0) {
            articles = sr.results.slice(0, limit).map(r => ({
              title:     r.title,
              source:    r.url ? new URL(r.url).hostname.replace('www.', '') : 'Web',
              published: 'recent',
              url:       r.url,
              snippet:   r.snippet,
            }));
          }
        }

        if (articles.length === 0) return `market_news: no news found for "${query || ticker}"`;

        const label = ticker ? `${ticker} News` : query ? `News: "${query}"` : 'Financial News';
        const header = `${label} — ${new Date().toUTCString()} (${articles.length} articles)`;
        const body = articles.map((a, i) =>
          `${i + 1}. ${a.title}\n   Source: ${a.source}  |  ${a.published}\n   ${a.url || ''}${a.snippet ? '\n   ' + a.snippet.slice(0, 200) : ''}`
        ).join('\n\n');

        return `${header}\n\n${body}`;
      } catch (e) {
        return `market_news error: ${e.message}`;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FINANCIAL ANALYSIS — extended tool suite
    // All providers are free / public APIs (Yahoo Finance unofficial,
    // SEC EDGAR, CoinGecko, FRED with optional key). Tools return
    // human-readable text so an LLM can synthesize a report on top.
    // ═══════════════════════════════════════════════════════════════════════

    case 'earnings_calendar': {
      const ticker = String(params.ticker || '').toUpperCase();
      const days = Math.min(parseInt(params.days || '60', 10), 365);
      if (!ticker) return 'earnings_calendar: ticker required (e.g. "AAPL").';
      try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=earnings,calendarEvents,earningsHistory,earningsTrend`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        if (!res.ok) return `earnings_calendar: HTTP ${res.status}`;
        const d = await res.json();
        const summary = d?.quoteSummary?.result?.[0] || {};
        const cal = summary.calendarEvents?.earnings || {};
        const hist = summary.earningsHistory?.history || [];
        const trend = summary.earningsTrend?.trend || [];
        const lines = [`Earnings calendar — ${ticker}`];
        if (cal.earningsDate?.length) {
          const dates = cal.earningsDate.map(d => (d.fmt || d.raw)).filter(Boolean).join(' – ');
          lines.push(`Next earnings: ${dates}${cal.isEarningsDateEstimate ? ' (estimated)' : ''}`);
          if (cal.earningsAverage?.fmt) lines.push(`  EPS estimate: ${cal.earningsAverage.fmt} (low ${cal.earningsLow?.fmt || '?'} / high ${cal.earningsHigh?.fmt || '?'})`);
          if (cal.revenueAverage?.fmt) lines.push(`  Revenue estimate: ${cal.revenueAverage.fmt}`);
        }
        if (hist.length) {
          lines.push('\nHistory (last quarters): est → actual (surprise %)');
          hist.slice(0, 4).forEach(h => {
            const est = h.epsEstimate?.fmt ?? '?';
            const act = h.epsActual?.fmt ?? '?';
            const surp = h.surprisePercent?.fmt ?? '?';
            lines.push(`  ${h.quarter?.fmt || '?'}: ${est} → ${act} (${surp})`);
          });
        }
        if (trend.length) {
          const next = trend.find(t => t.period === '+1q') || trend[0];
          if (next?.earningsEstimate?.avg?.fmt) {
            lines.push(`\nAnalyst trend next Q: avg EPS ${next.earningsEstimate.avg.fmt}, growth ${next.earningsEstimate.growth?.fmt || '?'} (${next.earningsEstimate.numberOfAnalysts?.fmt || '?'} analysts)`);
          }
        }
        return lines.join('\n');
      } catch (e) { return `earnings_calendar error: ${e.message}`; }
    }

    case 'dividend_calendar': {
      const ticker = String(params.ticker || '').toUpperCase();
      if (!ticker) return 'dividend_calendar: ticker required.';
      try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=summaryDetail,calendarEvents`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        if (!res.ok) return `dividend_calendar: HTTP ${res.status}`;
        const d = await res.json();
        const sd = d?.quoteSummary?.result?.[0]?.summaryDetail || {};
        const cal = d?.quoteSummary?.result?.[0]?.calendarEvents || {};
        const lines = [`Dividend — ${ticker}`];
        lines.push(`Yield: ${sd.dividendYield?.fmt || 'n/a'}${sd.trailingAnnualDividendRate?.fmt ? ` (${sd.trailingAnnualDividendRate.fmt}/yr)` : ''}`);
        lines.push(`Payout ratio: ${sd.payoutRatio?.fmt || 'n/a'}`);
        if (cal.exDividendDate?.fmt) lines.push(`Next ex-dividend: ${cal.exDividendDate.fmt}`);
        if (cal.dividendDate?.fmt) lines.push(`Next pay date: ${cal.dividendDate.fmt}`);
        if (sd.fiveYearAvgDividendYield?.fmt) lines.push(`5y avg yield: ${sd.fiveYearAvgDividendYield.fmt}`);
        return lines.join('\n');
      } catch (e) { return `dividend_calendar error: ${e.message}`; }
    }

    case 'economic_calendar': {
      const days = Math.min(parseInt(params.days || '7', 10), 30);
      const country = String(params.country || 'US').toUpperCase();
      try {
        // Use Trading Economics public calendar feed (free tier, JSON, no key).
        const today = new Date();
        const to = new Date(today.getTime() + days * 86400000);
        const fmt = (d) => d.toISOString().slice(0, 10);
        const url = `https://api.tradingeconomics.com/calendar/country/${encodeURIComponent(country)}?d1=${fmt(today)}&d2=${fmt(to)}&c=guest:guest&f=json`;
        const res = await fetch(url, { headers: { 'User-Agent': 'NHA/1.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) return `economic_calendar: HTTP ${res.status} — try country code like "US", "EU", "IT", "DE".`;
        const events = await res.json();
        if (!Array.isArray(events) || events.length === 0) return `economic_calendar: no events in next ${days} days for ${country}.`;
        const lines = [`Economic calendar — ${country}, next ${days} days (${events.length} events)`];
        events.slice(0, 30).forEach(e => {
          const when = (e.Date || '').slice(0, 16).replace('T', ' ');
          const imp = e.Importance === 3 ? '★★★' : e.Importance === 2 ? '★★' : '★';
          lines.push(`  ${when} ${imp} ${e.Event || e.Category}: forecast ${e.Forecast ?? '?'} | previous ${e.Previous ?? '?'}${e.Actual != null ? ` | actual ${e.Actual}` : ''}`);
        });
        return lines.join('\n');
      } catch (e) { return `economic_calendar error: ${e.message}`; }
    }

    case 'stock_screener': {
      // Yahoo Finance has a public "screener" endpoint. We use it via the
      // predefined-screener IDs (no key required). For complex filtering on
      // arbitrary criteria the LLM should chain calls (e.g. screener →
      // peer_comparison → market_indicators on each result).
      const screen = String(params.screen || 'most_actives').toLowerCase();
      const count = Math.min(parseInt(params.count || '20', 10), 50);
      // Known screen IDs: most_actives, day_gainers, day_losers, undervalued_growth_stocks,
      //   growth_technology_stocks, aggressive_small_caps, small_cap_gainers, undervalued_large_caps,
      //   conservative_foreign_funds, high_yield_bond, portfolio_anchors, solid_large_growth_funds,
      //   solid_midcap_growth_funds, top_mutual_funds.
      try {
        const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&lang=en-US&region=US&scrIds=${encodeURIComponent(screen)}&count=${count}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)', 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) return `stock_screener: HTTP ${res.status} — known screens: most_actives, day_gainers, day_losers, undervalued_growth_stocks, growth_technology_stocks, aggressive_small_caps, small_cap_gainers, undervalued_large_caps.`;
        const d = await res.json();
        const quotes = d?.finance?.result?.[0]?.quotes || [];
        if (!quotes.length) return `stock_screener: no results for "${screen}".`;
        const lines = [`Stock screener — ${screen} (${quotes.length} results)`];
        quotes.forEach((q, i) => {
          const sym = q.symbol;
          const name = (q.shortName || q.longName || '').slice(0, 40);
          const price = q.regularMarketPrice?.fmt || q.regularMarketPrice;
          const chg = q.regularMarketChangePercent?.fmt || `${q.regularMarketChangePercent?.toFixed?.(2)}%`;
          const mcap = q.marketCap?.fmt || '?';
          const pe = q.trailingPE?.fmt || q.forwardPE?.fmt || '?';
          lines.push(`${i + 1}. ${sym} (${name}) — $${price} ${chg} | mcap ${mcap} | P/E ${pe}`);
        });
        return lines.join('\n');
      } catch (e) { return `stock_screener error: ${e.message}`; }
    }

    case 'peer_comparison': {
      const ticker = String(params.ticker || '').toUpperCase();
      if (!ticker) return 'peer_comparison: ticker required.';
      try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=recommendationTrend,upgradeDowngradeHistory,assetProfile,summaryProfile`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        if (!res.ok) return `peer_comparison: HTTP ${res.status}`;
        const d = await res.json();
        const profile = d?.quoteSummary?.result?.[0]?.assetProfile || d?.quoteSummary?.result?.[0]?.summaryProfile || {};
        const peersUrl = `https://query1.finance.yahoo.com/v1/finance/recommendationsbysymbol/${encodeURIComponent(ticker)}`;
        const peerRes = await fetch(peersUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        const peerData = peerRes.ok ? await peerRes.json() : null;
        const peers = peerData?.finance?.result?.[0]?.recommendedSymbols?.map(s => s.symbol) || [];
        const lines = [`Peer comparison — ${ticker}`];
        if (profile.industry) lines.push(`Industry: ${profile.industry}${profile.sector ? ` · ${profile.sector}` : ''}`);
        if (peers.length === 0) return lines.join('\n') + '\nNo peer suggestions available.';
        lines.push(`\nPeers: ${peers.join(', ')}\n`);
        // Compare key metrics for ticker + first 5 peers.
        const symbols = [ticker, ...peers.slice(0, 5)];
        const batch = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}&fields=regularMarketPrice,marketCap,trailingPE,forwardPE,priceToBook,returnOnEquity,profitMargins,debtToEquity,dividendYield`;
        const bres = await fetch(batch, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        if (!bres.ok) return lines.join('\n');
        const bd = await bres.json();
        const rows = bd?.quoteResponse?.result || [];
        const fmt = (v) => v == null ? '?' : (typeof v === 'number' ? v.toFixed(2) : v);
        const header = `${'Ticker'.padEnd(10)}${'Price'.padStart(10)}${'P/E (ttm)'.padStart(12)}${'P/E (fwd)'.padStart(12)}${'P/B'.padStart(10)}${'ROE %'.padStart(10)}${'D/E'.padStart(10)}${'DivYld %'.padStart(11)}`;
        lines.push(header);
        rows.forEach(r => {
          lines.push(
            `${r.symbol.padEnd(10)}${String(fmt(r.regularMarketPrice)).padStart(10)}${String(fmt(r.trailingPE)).padStart(12)}${String(fmt(r.forwardPE)).padStart(12)}${String(fmt(r.priceToBook)).padStart(10)}${String(fmt(r.returnOnEquity ? (r.returnOnEquity * 100) : null)).padStart(10)}${String(fmt(r.debtToEquity)).padStart(10)}${String(fmt(r.dividendYield ? (r.dividendYield * 100) : null)).padStart(11)}`
          );
        });
        return lines.join('\n');
      } catch (e) { return `peer_comparison error: ${e.message}`; }
    }

    case 'sec_filings': {
      const ticker = String(params.ticker || '').toUpperCase();
      const formType = String(params.form || '').toUpperCase();
      const limit = Math.min(parseInt(params.limit || '10', 10), 25);
      if (!ticker) return 'sec_filings: ticker required.';
      try {
        // SEC EDGAR requires a User-Agent with contact info per their TOS.
        const ua = 'NotHumanAllowed CLI hello@nothumanallowed.com';
        // Step 1: ticker → CIK
        const tickersRes = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': ua } });
        if (!tickersRes.ok) return `sec_filings: failed to map ticker (HTTP ${tickersRes.status})`;
        const map = await tickersRes.json();
        const entry = Object.values(map).find(e => e.ticker?.toUpperCase() === ticker);
        if (!entry) return `sec_filings: ticker ${ticker} not found in SEC EDGAR (only US-listed companies).`;
        const cik = String(entry.cik_str).padStart(10, '0');
        // Step 2: fetch filings list for that CIK
        const fres = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'User-Agent': ua } });
        if (!fres.ok) return `sec_filings: HTTP ${fres.status}`;
        const fd = await fres.json();
        const recent = fd.filings?.recent || {};
        const rows = [];
        for (let i = 0; i < (recent.form?.length || 0); i++) {
          const form = recent.form[i];
          if (formType && form !== formType) continue;
          rows.push({
            form,
            date: recent.filingDate[i],
            accession: recent.accessionNumber[i],
            primary: recent.primaryDocument[i],
            description: recent.primaryDocDescription[i] || '',
          });
          if (rows.length >= limit) break;
        }
        if (rows.length === 0) return `sec_filings: no ${formType || ''} filings for ${ticker}.`;
        const lines = [`SEC filings — ${entry.title} (${ticker}) — CIK ${cik}`];
        rows.forEach(r => {
          const accNoDash = r.accession.replace(/-/g, '');
          const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accNoDash}/${r.primary}`;
          lines.push(`  ${r.date}  ${r.form.padEnd(6)} ${r.description || ''}\n    ${url}`);
        });
        return lines.join('\n');
      } catch (e) { return `sec_filings error: ${e.message}`; }
    }

    case 'options_chain': {
      const ticker = String(params.ticker || '').toUpperCase();
      if (!ticker) return 'options_chain: ticker required.';
      try {
        const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        if (!res.ok) return `options_chain: HTTP ${res.status}`;
        const d = await res.json();
        const result = d?.optionChain?.result?.[0];
        if (!result) return `options_chain: no options data for ${ticker}.`;
        const exps = (result.expirationDates || []).slice(0, 6);
        const quote = result.quote || {};
        const chain = result.options?.[0] || {};
        const lines = [`Options chain — ${ticker} @ $${quote.regularMarketPrice}`];
        lines.push(`Expirations available: ${exps.map(t => new Date(t * 1000).toISOString().slice(0, 10)).join(', ')}`);
        const calls = (chain.calls || []).slice(0, 10);
        const puts = (chain.puts || []).slice(0, 10);
        if (calls.length) {
          lines.push(`\nCalls (top ${calls.length} by strike, exp ${new Date(chain.expirationDate * 1000).toISOString().slice(0, 10)}):`);
          calls.forEach(c => lines.push(`  K=$${c.strike} bid=${c.bid} ask=${c.ask} last=${c.lastPrice} IV=${(c.impliedVolatility * 100).toFixed(1)}% OI=${c.openInterest}`));
        }
        if (puts.length) {
          lines.push(`\nPuts (top ${puts.length} by strike):`);
          puts.forEach(p => lines.push(`  K=$${p.strike} bid=${p.bid} ask=${p.ask} last=${p.lastPrice} IV=${(p.impliedVolatility * 100).toFixed(1)}% OI=${p.openInterest}`));
        }
        return lines.join('\n');
      } catch (e) { return `options_chain error: ${e.message}`; }
    }

    case 'portfolio_add': {
      const ticker = String(params.ticker || '').toUpperCase();
      const qty = parseFloat(params.qty || params.quantity || '0');
      const cost = parseFloat(params.cost || params.price || '0');
      if (!ticker || qty <= 0) return 'portfolio_add: ticker and qty (>0) required.';
      const fs = await import('fs'); const path = await import('path'); const os = await import('os');
      const file = path.default.join(os.default.homedir(), '.nha', 'portfolio.json');
      let pf = { positions: [], cash: 0 };
      try { if (fs.default.existsSync(file)) pf = JSON.parse(fs.default.readFileSync(file, 'utf-8')); } catch {}
      pf.positions = pf.positions || [];
      const existing = pf.positions.find(p => p.ticker === ticker);
      if (existing) {
        const totalQty = existing.qty + qty;
        const avgCost = ((existing.qty * existing.cost) + (qty * cost)) / totalQty;
        existing.qty = totalQty;
        existing.cost = avgCost;
      } else {
        pf.positions.push({ ticker, qty, cost, addedAt: new Date().toISOString() });
      }
      fs.default.mkdirSync(path.default.dirname(file), { recursive: true });
      fs.default.writeFileSync(file, JSON.stringify(pf, null, 2));
      return `Portfolio updated: ${ticker} qty=${qty}${cost ? ` @ avg cost $${cost}` : ''}. Total positions: ${pf.positions.length}.`;
    }

    case 'portfolio_remove': {
      const ticker = String(params.ticker || '').toUpperCase();
      if (!ticker) return 'portfolio_remove: ticker required.';
      const fs = await import('fs'); const path = await import('path'); const os = await import('os');
      const file = path.default.join(os.default.homedir(), '.nha', 'portfolio.json');
      let pf = { positions: [] };
      try { if (fs.default.existsSync(file)) pf = JSON.parse(fs.default.readFileSync(file, 'utf-8')); } catch {}
      const before = (pf.positions || []).length;
      pf.positions = (pf.positions || []).filter(p => p.ticker !== ticker);
      if (pf.positions.length === before) return `Portfolio: ${ticker} not found.`;
      fs.default.writeFileSync(file, JSON.stringify(pf, null, 2));
      return `Portfolio: ${ticker} removed.`;
    }

    case 'portfolio_summary': {
      const fs = await import('fs'); const path = await import('path'); const os = await import('os');
      const file = path.default.join(os.default.homedir(), '.nha', 'portfolio.json');
      if (!fs.default.existsSync(file)) return 'Portfolio is empty. Add positions with portfolio_add.';
      const pf = JSON.parse(fs.default.readFileSync(file, 'utf-8'));
      const positions = pf.positions || [];
      if (positions.length === 0) return 'Portfolio is empty.';
      // Fetch live prices in batch
      const symbols = positions.map(p => p.ticker).join(',');
      const res = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
      if (!res.ok) return `portfolio_summary: HTTP ${res.status}`;
      const d = await res.json();
      const quotes = d?.quoteResponse?.result || [];
      const priceMap = Object.fromEntries(quotes.map(q => [q.symbol, q.regularMarketPrice]));
      let totalValue = 0, totalCost = 0;
      const rows = positions.map(p => {
        const price = priceMap[p.ticker] || 0;
        const value = price * p.qty;
        const cost = (p.cost || 0) * p.qty;
        const pl = value - cost;
        const plPct = cost > 0 ? (pl / cost) * 100 : 0;
        totalValue += value; totalCost += cost;
        return { ticker: p.ticker, qty: p.qty, costBasis: p.cost, currentPrice: price, value, pl, plPct };
      });
      const totalPL = totalValue - totalCost;
      const totalPLPct = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
      const lines = [`Portfolio summary — ${positions.length} positions`];
      lines.push(`${'Ticker'.padEnd(10)}${'Qty'.padStart(10)}${'Cost'.padStart(12)}${'Price'.padStart(12)}${'Value'.padStart(14)}${'P/L'.padStart(14)}${'P/L %'.padStart(10)}`);
      rows.forEach(r => {
        lines.push(`${r.ticker.padEnd(10)}${String(r.qty).padStart(10)}${('$' + (r.costBasis || 0).toFixed(2)).padStart(12)}${('$' + r.currentPrice.toFixed(2)).padStart(12)}${('$' + r.value.toFixed(2)).padStart(14)}${((r.pl >= 0 ? '+' : '') + '$' + r.pl.toFixed(2)).padStart(14)}${(r.plPct.toFixed(2) + '%').padStart(10)}`);
      });
      lines.push(`\nTotal value: $${totalValue.toFixed(2)} | Cost basis: $${totalCost.toFixed(2)} | P/L: ${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)} (${totalPLPct.toFixed(2)}%)`);
      return lines.join('\n');
    }

    case 'portfolio_metrics': {
      const period = params.period || '1y';
      const fs = await import('fs'); const path = await import('path'); const os = await import('os');
      const file = path.default.join(os.default.homedir(), '.nha', 'portfolio.json');
      if (!fs.default.existsSync(file)) return 'Portfolio is empty.';
      const pf = JSON.parse(fs.default.readFileSync(file, 'utf-8'));
      const positions = pf.positions || [];
      if (positions.length === 0) return 'Portfolio is empty.';
      // Fetch historical returns for each ticker → compute weighted portfolio returns,
      // then Sharpe, Sortino, max drawdown, beta vs SPY.
      const symbols = [...positions.map(p => p.ticker), 'SPY'];
      const fetchHist = async (sym) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${period}&interval=1d`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        if (!r.ok) return null;
        const d = await r.json();
        return d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || null;
      };
      const series = {};
      for (const s of symbols) series[s] = await fetchHist(s);
      const valid = Object.values(series).filter(Array.isArray);
      if (valid.length === 0) return 'portfolio_metrics: failed to fetch historical data.';
      const N = Math.min(...valid.map(a => a.length));
      // Weighted returns: weight = current_value / total_value
      const lastPrice = (s) => (series[s] || []).slice(-1)[0];
      const weights = positions.map(p => p.qty * (lastPrice(p.ticker) || 0));
      const totalW = weights.reduce((a, b) => a + b, 0) || 1;
      const wNorm = weights.map(w => w / totalW);
      const dailyRet = (arr) => arr.slice(1).map((v, i) => (v - arr[i]) / arr[i]).filter(r => Number.isFinite(r));
      const tickerRets = positions.map(p => dailyRet(series[p.ticker] || []).slice(-N + 1));
      const minRetLen = Math.min(...tickerRets.map(r => r.length), dailyRet(series.SPY).length);
      const portfRets = [];
      for (let i = 0; i < minRetLen; i++) {
        let r = 0;
        for (let j = 0; j < tickerRets.length; j++) r += (tickerRets[j][i] || 0) * wNorm[j];
        portfRets.push(r);
      }
      const spyRets = dailyRet(series.SPY).slice(-minRetLen);
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const stdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
      const annRet = mean(portfRets) * 252 * 100;
      const annVol = stdev(portfRets) * Math.sqrt(252) * 100;
      const sharpe = annVol > 0 ? (annRet - 4) / annVol : 0; // assume 4% risk-free
      const downside = portfRets.filter(r => r < 0);
      const sortino = downside.length > 1 ? (annRet - 4) / (stdev(downside) * Math.sqrt(252) * 100) : 0;
      // Max drawdown
      const cum = []; let acc = 1;
      portfRets.forEach(r => { acc *= (1 + r); cum.push(acc); });
      let peak = -Infinity, maxDD = 0;
      cum.forEach(v => { peak = Math.max(peak, v); maxDD = Math.min(maxDD, (v - peak) / peak); });
      // Beta vs SPY
      const covMean = mean(portfRets.map((r, i) => (r - mean(portfRets)) * (spyRets[i] - mean(spyRets))));
      const varSpy = mean(spyRets.map(r => (r - mean(spyRets)) ** 2));
      const beta = varSpy > 0 ? covMean / varSpy : 0;
      return `Portfolio metrics (${period}, ${minRetLen} trading days):
  Annualized return: ${annRet.toFixed(2)}%
  Annualized volatility: ${annVol.toFixed(2)}%
  Sharpe ratio: ${sharpe.toFixed(2)} (assuming 4% RFR)
  Sortino ratio: ${sortino.toFixed(2)}
  Max drawdown: ${(maxDD * 100).toFixed(2)}%
  Beta vs SPY: ${beta.toFixed(2)}`;
    }

    case 'news_sentiment': {
      const ticker = String(params.ticker || '').toUpperCase();
      const query = params.query || ticker;
      if (!ticker && !query) return 'news_sentiment: ticker or query required.';
      // 1. Pull recent news via the existing market_news tool
      const newsRes = await executeTool('market_news', { ticker, query, limit: 15 }, config);
      if (typeof newsRes !== 'string' || newsRes.startsWith('market_news error')) return newsRes;
      // 2. Sentiment-score each headline via LLM (single call, batched)
      const { callLLM } = await import('./llm.mjs');
      const sysPrompt = `You score financial-news headlines for sentiment. Output ONLY JSON array, no prose.\n` +
        `For each headline, output {"i": index, "s": "positive"|"neutral"|"negative", "c": confidence 0..1, "why": "<10 words"}.\n` +
        `Bullish/positive for the asset = "positive". Bearish/risk = "negative". Pure info = "neutral".`;
      const headlines = newsRes.split('\n').filter(l => /^\d+\./.test(l)).map((l, i) => `${i + 1}. ${l.replace(/^\d+\.\s*/, '').slice(0, 200)}`);
      const userMsg = headlines.join('\n');
      let scored;
      try {
        const raw = await callLLM(config, sysPrompt, userMsg, { temperature: 0, maxTokens: 800 });
        const m = raw.match(/\[[\s\S]*\]/);
        if (m) scored = JSON.parse(m[0]);
      } catch { /* fallthrough */ }
      if (!Array.isArray(scored)) return newsRes + '\n\n(sentiment scoring failed)';
      const counts = { positive: 0, neutral: 0, negative: 0 };
      const weightedSum = scored.reduce((acc, s) => { counts[s.s] = (counts[s.s] || 0) + 1; return acc + (s.s === 'positive' ? s.c : s.s === 'negative' ? -s.c : 0); }, 0);
      const avg = scored.length ? weightedSum / scored.length : 0;
      const verdict = avg > 0.2 ? '🟢 Bullish' : avg < -0.2 ? '🔴 Bearish' : '🟡 Mixed';
      const out = [`News sentiment — ${ticker || query} (${scored.length} headlines)`,
        `Aggregate: ${verdict} (score ${avg.toFixed(2)})`,
        `Distribution: ${counts.positive || 0} positive · ${counts.neutral || 0} neutral · ${counts.negative || 0} negative`,
        '',
        'Top signals:'];
      scored.slice(0, 5).forEach(s => out.push(`  [${s.s}] ${headlines[s.i - 1] || '?'} — ${s.why}`));
      return out.join('\n');
    }

    case 'backtest_strategy': {
      // Thin wrapper around execute_code: produces a parametric backtest
      // script (pandas + numpy) and runs it. Useful as a one-liner from the
      // chat — for production-grade backtesting users should call execute_code
      // directly with their own strategy.
      const ticker = String(params.ticker || 'SPY').toUpperCase();
      const period = params.period || '5y';
      const strategy = params.strategy || 'sma_crossover'; // sma_crossover | rsi_meanrev | buy_hold
      const code = `
import urllib.request, json, sys
url = "https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${period}&interval=1d"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
r = urllib.request.urlopen(req).read()
d = json.loads(r)
res = d["chart"]["result"][0]
closes = [c for c in res["indicators"]["quote"][0]["close"] if c is not None]
strategy = "${strategy}"
signal = [0]*len(closes)
if strategy == "sma_crossover":
    fast, slow = 20, 50
    for i in range(slow, len(closes)):
        f = sum(closes[i-fast+1:i+1])/fast
        s = sum(closes[i-slow+1:i+1])/slow
        signal[i] = 1 if f > s else 0
elif strategy == "rsi_meanrev":
    gains = [max(0, closes[i]-closes[i-1]) for i in range(1, len(closes))]
    losses = [max(0, closes[i-1]-closes[i]) for i in range(1, len(closes))]
    p = 14
    for i in range(p, len(closes)-1):
        avg_g = sum(gains[i-p:i])/p; avg_l = sum(losses[i-p:i])/p
        rsi = 100 - (100 / (1 + (avg_g / (avg_l or 1e-9))))
        signal[i+1] = 1 if rsi < 30 else 0 if rsi > 70 else signal[i]
else:
    signal = [1]*len(closes)  # buy & hold

rets, eq = [], [1.0]
for i in range(1, len(closes)):
    r = signal[i-1] * (closes[i]-closes[i-1]) / closes[i-1]
    rets.append(r); eq.append(eq[-1] * (1+r))
total = (eq[-1] - 1) * 100
days = len(rets)
ann = ((eq[-1]) ** (252/days) - 1) * 100 if days else 0
import statistics as st
vol = (st.pstdev(rets) * (252**0.5) * 100) if len(rets) > 1 else 0
sharpe = (ann - 4) / vol if vol else 0
peak = max_dd = 0
for v in eq:
    peak = max(peak, v); max_dd = min(max_dd, (v-peak)/peak)
print(f"Backtest {strategy} on ${ticker} (${period}):")
print(f"  Total return: {total:.2f}% over {days} days")
print(f"  Annualized: {ann:.2f}%, vol {vol:.2f}%, Sharpe {sharpe:.2f}")
print(f"  Max drawdown: {max_dd*100:.2f}%")
`;
      return executeTool('execute_code', { language: 'python', code, timeout: 60 }, config);
    }

    case 'portfolio_correlation': {
      // Pearson correlation matrix of all portfolio holdings + SPY benchmark.
      const period = params.period || '1y';
      const fs = await import('fs'); const path = await import('path'); const os = await import('os');
      const file = path.default.join(os.default.homedir(), '.nha', 'portfolio.json');
      if (!fs.default.existsSync(file)) return 'Portfolio is empty.';
      const pf = JSON.parse(fs.default.readFileSync(file, 'utf-8'));
      const positions = pf.positions || [];
      if (positions.length < 2) return 'Need at least 2 positions for a correlation matrix.';
      const symbols = [...positions.map(p => p.ticker), 'SPY'];
      const series = {};
      for (const s of symbols) {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=${period}&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
          if (!r.ok) continue;
          const d = await r.json();
          series[s] = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Number.isFinite) || [];
        } catch {}
      }
      const valid = Object.entries(series).filter(([_, a]) => a.length > 30);
      if (valid.length < 2) return 'portfolio_correlation: not enough historical data.';
      const N = Math.min(...valid.map(([_, a]) => a.length));
      const rets = Object.fromEntries(valid.map(([s, a]) => {
        const arr = a.slice(-N);
        return [s, arr.slice(1).map((v, i) => (v - arr[i]) / arr[i])];
      }));
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const corr = (a, b) => {
        const ma = mean(a), mb = mean(b);
        let num = 0, dA = 0, dB = 0;
        for (let i = 0; i < a.length; i++) { const xa = a[i] - ma, xb = b[i] - mb; num += xa * xb; dA += xa * xa; dB += xb * xb; }
        return num / Math.sqrt(dA * dB || 1);
      };
      const syms = valid.map(([s]) => s);
      const matrix = syms.map(a => syms.map(b => corr(rets[a], rets[b])));
      const lines = [`Correlation matrix (${period}, ${N} days)`];
      lines.push('         ' + syms.map(s => s.padStart(8)).join(''));
      matrix.forEach((row, i) => {
        lines.push(syms[i].padEnd(9) + row.map(v => v.toFixed(2).padStart(8)).join(''));
      });
      // Find pairs with highest correlation (excluding self/SPY)
      const pairs = [];
      for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
        if (syms[i] === 'SPY' || syms[j] === 'SPY') continue;
        pairs.push({ a: syms[i], b: syms[j], r: matrix[i][j] });
      }
      pairs.sort((a, b) => b.r - a.r);
      if (pairs.length) {
        lines.push('\nMost correlated pairs (concentration risk):');
        pairs.slice(0, 3).forEach(p => lines.push(`  ${p.a} ↔ ${p.b}: ${p.r.toFixed(2)}${p.r > 0.7 ? '  ⚠ high' : ''}`));
        lines.push('\nLeast correlated (diversification value):');
        pairs.slice(-3).reverse().forEach(p => lines.push(`  ${p.a} ↔ ${p.b}: ${p.r.toFixed(2)}`));
      }
      return lines.join('\n');
    }

    case 'portfolio_sector_breakdown': {
      const fs = await import('fs'); const path = await import('path'); const os = await import('os');
      const file = path.default.join(os.default.homedir(), '.nha', 'portfolio.json');
      if (!fs.default.existsSync(file)) return 'Portfolio is empty.';
      const pf = JSON.parse(fs.default.readFileSync(file, 'utf-8'));
      const positions = pf.positions || [];
      if (positions.length === 0) return 'Portfolio is empty.';
      const symbols = positions.map(p => p.ticker);
      // Batch-fetch assetProfile + live price
      const summaries = {};
      for (const s of symbols) {
        try {
          const r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(s)}?modules=assetProfile,summaryDetail,price`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
          if (r.ok) {
            const d = await r.json();
            summaries[s] = d?.quoteSummary?.result?.[0] || {};
          }
        } catch {}
      }
      const rows = positions.map(p => {
        const sx = summaries[p.ticker] || {};
        const sector = sx.assetProfile?.sector || sx.assetProfile?.industry || 'Unknown';
        const industry = sx.assetProfile?.industry || '';
        const country = sx.assetProfile?.country || 'Unknown';
        const currency = sx.price?.currency || sx.summaryDetail?.currency || 'USD';
        const price = sx.price?.regularMarketPrice?.raw || 0;
        const value = price * p.qty;
        return { ticker: p.ticker, sector, industry, country, currency, value };
      });
      const total = rows.reduce((a, r) => a + r.value, 0) || 1;
      const bySector = {};
      const byCountry = {};
      const byCurrency = {};
      rows.forEach(r => {
        bySector[r.sector] = (bySector[r.sector] || 0) + r.value;
        byCountry[r.country] = (byCountry[r.country] || 0) + r.value;
        byCurrency[r.currency] = (byCurrency[r.currency] || 0) + r.value;
      });
      const fmt = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  ${k.padEnd(28)} ${((v / total) * 100).toFixed(1).padStart(6)}%   $${v.toFixed(0).padStart(10)}`).join('\n');
      return [
        `Portfolio breakdown — total value $${total.toFixed(0)}`,
        '',
        `By sector:\n${fmt(bySector)}`,
        '',
        `By country:\n${fmt(byCountry)}`,
        '',
        `By currency:\n${fmt(byCurrency)}`,
      ].join('\n');
    }

    case 'portfolio_var': {
      // Historical-simulation Value at Risk and Expected Shortfall.
      const period = params.period || '1y';
      const conf = parseFloat(params.confidence || '0.95'); // 95% default; pass 0.99 for stress
      const fs = await import('fs'); const path = await import('path'); const os = await import('os');
      const file = path.default.join(os.default.homedir(), '.nha', 'portfolio.json');
      if (!fs.default.existsSync(file)) return 'Portfolio is empty.';
      const pf = JSON.parse(fs.default.readFileSync(file, 'utf-8'));
      const positions = pf.positions || [];
      if (positions.length === 0) return 'Portfolio is empty.';
      const symbols = positions.map(p => p.ticker);
      const series = {};
      for (const s of symbols) {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=${period}&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
          if (!r.ok) continue;
          const d = await r.json();
          series[s] = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Number.isFinite) || [];
        } catch {}
      }
      const valid = positions.filter(p => (series[p.ticker] || []).length > 30);
      if (valid.length === 0) return 'portfolio_var: not enough data.';
      const N = Math.min(...valid.map(p => series[p.ticker].length));
      const lastPrice = (p) => series[p.ticker][series[p.ticker].length - 1];
      const values = valid.map(p => p.qty * lastPrice(p));
      const totalValue = values.reduce((a, b) => a + b, 0);
      const weights = values.map(v => v / totalValue);
      const dailyRet = (a) => a.slice(1).map((v, i) => (v - a[i]) / a[i]);
      const tickerRets = valid.map(p => dailyRet(series[p.ticker]).slice(-N + 1));
      const minLen = Math.min(...tickerRets.map(r => r.length));
      const portfRets = [];
      for (let i = 0; i < minLen; i++) {
        let r = 0;
        for (let j = 0; j < tickerRets.length; j++) r += (tickerRets[j][i] || 0) * weights[j];
        portfRets.push(r);
      }
      // Sort returns ascending; VaR is the loss at the (1-conf) quantile.
      const sorted = [...portfRets].sort((a, b) => a - b);
      const idx = Math.floor((1 - conf) * sorted.length);
      const varRet = sorted[idx];
      const tailLosses = sorted.slice(0, idx + 1);
      const esRet = tailLosses.reduce((a, b) => a + b, 0) / (tailLosses.length || 1);
      const portValue = positions.reduce((a, p) => a + (lastPrice(p) || 0) * p.qty, 0);
      return [
        `Portfolio VaR (Historical Simulation, ${period}, ${minLen} days)`,
        `Confidence: ${(conf * 100).toFixed(0)}%`,
        `Portfolio value: $${portValue.toFixed(0)}`,
        `Daily VaR: ${(varRet * 100).toFixed(2)}%  =  $${(varRet * portValue).toFixed(0)} loss`,
        `Expected Shortfall (CVaR): ${(esRet * 100).toFixed(2)}%  =  $${(esRet * portValue).toFixed(0)} avg tail loss`,
        `10-day VaR (sqrt-time scaled): ${(varRet * Math.sqrt(10) * 100).toFixed(2)}%  =  $${(varRet * Math.sqrt(10) * portValue).toFixed(0)}`,
        '',
        `Interpretation: with ${(conf * 100).toFixed(0)}% confidence, daily losses won't exceed the VaR figure.`,
        `When they do (the worst ${((1 - conf) * 100).toFixed(0)}% of days), the average loss is the ES/CVaR.`,
      ].join('\n');
    }

    case 'portfolio_rebalance': {
      // Compare current weights vs target weights. Targets can be passed as
      // `params.targets = {AAPL: 0.20, MSFT: 0.15, ...}` or read from
      // `~/.nha/portfolio.json` field `targets`. Without targets we assume
      // equal-weight.
      const fs = await import('fs'); const path = await import('path'); const os = await import('os');
      const file = path.default.join(os.default.homedir(), '.nha', 'portfolio.json');
      if (!fs.default.existsSync(file)) return 'Portfolio is empty.';
      const pf = JSON.parse(fs.default.readFileSync(file, 'utf-8'));
      const positions = pf.positions || [];
      if (positions.length === 0) return 'Portfolio is empty.';
      let targets = params.targets || pf.targets || null;
      if (!targets) {
        const eq = 1 / positions.length;
        targets = Object.fromEntries(positions.map(p => [p.ticker, eq]));
      }
      const symbols = positions.map(p => p.ticker);
      const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
      if (!r.ok) return `portfolio_rebalance: HTTP ${r.status}`;
      const d = await r.json();
      const priceMap = Object.fromEntries((d?.quoteResponse?.result || []).map(q => [q.symbol, q.regularMarketPrice]));
      const rows = positions.map(p => {
        const px = priceMap[p.ticker] || 0;
        const value = px * p.qty;
        return { ticker: p.ticker, qty: p.qty, price: px, value };
      });
      const total = rows.reduce((a, r) => a + r.value, 0) || 1;
      const lines = [`Portfolio rebalance — total $${total.toFixed(0)}`];
      lines.push(`${'Ticker'.padEnd(10)}${'Current %'.padStart(12)}${'Target %'.padStart(12)}${'Drift'.padStart(10)}${'Action'.padStart(30)}`);
      let totalTrade = 0;
      rows.forEach(p => {
        const current = (p.value / total) * 100;
        const target = (targets[p.ticker] || 0) * 100;
        const drift = current - target;
        const tradeUsd = (target - current) / 100 * total;
        const shares = p.price > 0 ? tradeUsd / p.price : 0;
        const action = Math.abs(drift) < 1 ? '✓ ok'
          : drift > 0 ? `SELL ${Math.abs(shares).toFixed(2)} @ $${p.price.toFixed(2)}`
          : `BUY  ${Math.abs(shares).toFixed(2)} @ $${p.price.toFixed(2)}`;
        totalTrade += Math.abs(tradeUsd);
        lines.push(`${p.ticker.padEnd(10)}${current.toFixed(2).padStart(11)}%${target.toFixed(2).padStart(11)}%${(drift >= 0 ? '+' : '') + drift.toFixed(2).padStart(8)}%${action.padStart(30)}`);
      });
      lines.push(`\nTotal trade volume to rebalance: $${totalTrade.toFixed(0)}`);
      lines.push(`Drift threshold ≥ 1% → trades suggested above. Below threshold → leave as is.`);
      return lines.join('\n');
    }

    case 'option_strategy_builder': {
      const ticker = String(params.ticker || '').toUpperCase();
      const direction = String(params.direction || 'neutral').toLowerCase();
      const maxRisk = parseFloat(params.maxRisk || params.max_risk || '1000');
      const targetDays = parseInt(params.daysToExpiry || params.dte || '30', 10);
      if (!ticker) return 'option_strategy_builder: ticker required.';
      try {
        // 1. Fetch options chain (Yahoo Finance, free)
        const chainRes = await fetch(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        if (!chainRes.ok) return `option_strategy_builder: HTTP ${chainRes.status}`;
        const cd = await chainRes.json();
        const result = cd?.optionChain?.result?.[0];
        if (!result) return `option_strategy_builder: no options data for ${ticker}.`;
        const spot = result.quote?.regularMarketPrice;
        // 2. Pick the expiration closest to targetDays
        const today = Date.now() / 1000;
        const exps = result.expirationDates || [];
        const expPicked = exps.reduce((best, e) => {
          const dte = (e - today) / 86400;
          if (dte < 5) return best;
          const bestDte = best ? (best - today) / 86400 : Infinity;
          return Math.abs(dte - targetDays) < Math.abs(bestDte - targetDays) ? e : best;
        }, 0);
        if (!expPicked) return `option_strategy_builder: no suitable expiry near ${targetDays} days.`;
        const dtePicked = Math.round((expPicked - today) / 86400);
        // Fetch the picked chain
        const pickedRes = await fetch(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?date=${expPicked}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        const pickedData = await pickedRes.json();
        const opts = pickedData?.optionChain?.result?.[0]?.options?.[0] || {};
        const calls = opts.calls || [];
        const puts = opts.puts || [];
        if (calls.length === 0 || puts.length === 0) return `option_strategy_builder: empty chain for chosen expiry.`;
        // 3. ATM IV (average call+put closest to spot)
        const closest = (arr) => arr.reduce((a, b) => Math.abs(a.strike - spot) < Math.abs(b.strike - spot) ? a : b);
        const atmCall = closest(calls);
        const atmPut = closest(puts);
        const atmIV = ((atmCall.impliedVolatility || 0) + (atmPut.impliedVolatility || 0)) / 2;
        // 4. IV rank from market_chart historical realized vol as proxy (no API for historical IV free)
        const chartRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
        let ivPercentile = null;
        try {
          const ch = await chartRes.json();
          const closes = ch?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Number.isFinite) || [];
          // Rolling 30-day realized vol annualized
          const rollingVols = [];
          for (let i = 30; i < closes.length; i++) {
            const window = closes.slice(i - 30, i);
            const rets = window.slice(1).map((v, j) => Math.log(v / window[j]));
            const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
            const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
            rollingVols.push(Math.sqrt(variance * 252));
          }
          if (rollingVols.length > 20) {
            const sorted = [...rollingVols].sort((a, b) => a - b);
            const rank = sorted.findIndex(v => v >= atmIV);
            ivPercentile = rank < 0 ? 100 : (rank / sorted.length) * 100;
          }
        } catch {}
        const ivCheap = ivPercentile != null && ivPercentile < 30;
        const ivRich = ivPercentile != null && ivPercentile > 70;
        // 5. Build strategy recommendations
        const expStr = new Date(expPicked * 1000).toISOString().slice(0, 10);
        const findStrike = (arr, targetDelta) => {
          // Find option whose abs(delta) is closest to target. Yahoo doesn't always provide delta;
          // approximate by inMoneyness: for calls, delta≈0.5 at ATM; +0.05 per 1% ITM.
          let best = arr[0], bestDist = Infinity;
          for (const o of arr) {
            const moneyness = (o.strike - spot) / spot;
            const approxDelta = arr === calls ? Math.max(0.05, Math.min(0.95, 0.5 - moneyness * 5)) : Math.max(-0.95, Math.min(-0.05, -0.5 - moneyness * 5));
            const dist = Math.abs(Math.abs(approxDelta) - targetDelta);
            if (dist < bestDist) { bestDist = dist; best = o; }
          }
          return best;
        };
        const mid = (o) => ((o.bid || 0) + (o.ask || 0)) / 2 || o.lastPrice || 0;
        const strategies = [];

        if (direction === 'bullish' || direction === 'long') {
          if (ivCheap || ivPercentile == null) {
            // Bull Call Debit Spread (buy ATM, sell OTM)
            const buy = atmCall;
            const sell = calls.find(c => c.strike > spot * 1.05) || calls[calls.length - 1];
            const debit = (mid(buy) - mid(sell)) * 100;
            const width = (sell.strike - buy.strike) * 100;
            const maxProfit = width - debit;
            const maxLoss = debit;
            const be = buy.strike + (debit / 100);
            const contracts = Math.max(1, Math.floor(maxRisk / debit));
            strategies.push({
              name: 'Bull Call Debit Spread',
              rationale: 'Bullish, IV cheap → buy premium, defined risk',
              legs: [`BUY  ${contracts}x ${ticker} ${expStr} ${buy.strike} CALL @ ~$${mid(buy).toFixed(2)}`,
                     `SELL ${contracts}x ${ticker} ${expStr} ${sell.strike} CALL @ ~$${mid(sell).toFixed(2)}`],
              netDebit: debit * contracts,
              maxProfit: maxProfit * contracts,
              maxLoss: maxLoss * contracts,
              breakeven: be.toFixed(2),
              roi: ((maxProfit / Math.max(1, maxLoss)) * 100).toFixed(0) + '%',
            });
          }
          if (ivRich) {
            // Bull Put Credit Spread (sell OTM put, buy further OTM put)
            const sell = puts.find(p => p.strike < spot * 0.97 && p.strike > spot * 0.93) || puts[Math.floor(puts.length / 2)];
            const buy = puts.find(p => p.strike < sell.strike - spot * 0.03) || puts[0];
            const credit = (mid(sell) - mid(buy)) * 100;
            const width = (sell.strike - buy.strike) * 100;
            const maxLoss = width - credit;
            const be = sell.strike - (credit / 100);
            const contracts = Math.max(1, Math.floor(maxRisk / maxLoss));
            strategies.push({
              name: 'Bull Put Credit Spread',
              rationale: 'Bullish, IV rich → sell premium, defined risk',
              legs: [`SELL ${contracts}x ${ticker} ${expStr} ${sell.strike} PUT @ ~$${mid(sell).toFixed(2)}`,
                     `BUY  ${contracts}x ${ticker} ${expStr} ${buy.strike} PUT @ ~$${mid(buy).toFixed(2)}`],
              netCredit: credit * contracts,
              maxProfit: credit * contracts,
              maxLoss: maxLoss * contracts,
              breakeven: be.toFixed(2),
              roi: ((credit / Math.max(1, maxLoss)) * 100).toFixed(0) + '%',
            });
          }
        }

        if (direction === 'bearish' || direction === 'short') {
          if (ivCheap || ivPercentile == null) {
            const buy = atmPut;
            const sell = puts.find(p => p.strike < spot * 0.95) || puts[0];
            const debit = (mid(buy) - mid(sell)) * 100;
            const width = (buy.strike - sell.strike) * 100;
            const maxProfit = width - debit;
            const be = buy.strike - (debit / 100);
            const contracts = Math.max(1, Math.floor(maxRisk / debit));
            strategies.push({
              name: 'Bear Put Debit Spread',
              rationale: 'Bearish, IV cheap → buy premium, defined risk',
              legs: [`BUY  ${contracts}x ${ticker} ${expStr} ${buy.strike} PUT @ ~$${mid(buy).toFixed(2)}`,
                     `SELL ${contracts}x ${ticker} ${expStr} ${sell.strike} PUT @ ~$${mid(sell).toFixed(2)}`],
              netDebit: debit * contracts, maxProfit: maxProfit * contracts, maxLoss: debit * contracts,
              breakeven: be.toFixed(2), roi: ((maxProfit / Math.max(1, debit)) * 100).toFixed(0) + '%',
            });
          }
          if (ivRich) {
            const sell = calls.find(c => c.strike > spot * 1.03 && c.strike < spot * 1.07) || calls[Math.floor(calls.length / 2)];
            const buy = calls.find(c => c.strike > sell.strike + spot * 0.03) || calls[calls.length - 1];
            const credit = (mid(sell) - mid(buy)) * 100;
            const width = (buy.strike - sell.strike) * 100;
            const maxLoss = width - credit;
            const be = sell.strike + (credit / 100);
            const contracts = Math.max(1, Math.floor(maxRisk / maxLoss));
            strategies.push({
              name: 'Bear Call Credit Spread',
              rationale: 'Bearish, IV rich → sell premium, defined risk',
              legs: [`SELL ${contracts}x ${ticker} ${expStr} ${sell.strike} CALL @ ~$${mid(sell).toFixed(2)}`,
                     `BUY  ${contracts}x ${ticker} ${expStr} ${buy.strike} CALL @ ~$${mid(buy).toFixed(2)}`],
              netCredit: credit * contracts, maxProfit: credit * contracts, maxLoss: maxLoss * contracts,
              breakeven: be.toFixed(2), roi: ((credit / Math.max(1, maxLoss)) * 100).toFixed(0) + '%',
            });
          }
        }

        if (direction === 'neutral' || direction === 'range') {
          if (ivRich) {
            // Iron Condor — sell OTM call + OTM put, buy further OTM wings
            const sellPut  = puts.find(p => p.strike < spot * 0.95 && p.strike > spot * 0.90) || puts[Math.floor(puts.length * 0.3)];
            const buyPut   = puts.find(p => p.strike < sellPut.strike - spot * 0.05) || puts[0];
            const sellCall = calls.find(c => c.strike > spot * 1.05 && c.strike < spot * 1.10) || calls[Math.floor(calls.length * 0.7)];
            const buyCall  = calls.find(c => c.strike > sellCall.strike + spot * 0.05) || calls[calls.length - 1];
            const credit = (mid(sellPut) + mid(sellCall) - mid(buyPut) - mid(buyCall)) * 100;
            const widthPut = (sellPut.strike - buyPut.strike) * 100;
            const widthCall = (buyCall.strike - sellCall.strike) * 100;
            const maxLoss = Math.max(widthPut, widthCall) - credit;
            const contracts = Math.max(1, Math.floor(maxRisk / maxLoss));
            strategies.push({
              name: 'Iron Condor',
              rationale: 'Neutral, IV rich → defined-risk short premium, profits if price stays in range',
              legs: [
                `SELL ${contracts}x ${expStr} ${sellPut.strike} PUT @ ~$${mid(sellPut).toFixed(2)}`,
                `BUY  ${contracts}x ${expStr} ${buyPut.strike} PUT @ ~$${mid(buyPut).toFixed(2)}`,
                `SELL ${contracts}x ${expStr} ${sellCall.strike} CALL @ ~$${mid(sellCall).toFixed(2)}`,
                `BUY  ${contracts}x ${expStr} ${buyCall.strike} CALL @ ~$${mid(buyCall).toFixed(2)}`,
              ],
              netCredit: credit * contracts, maxProfit: credit * contracts, maxLoss: maxLoss * contracts,
              breakeven: `${(sellPut.strike - credit / 100).toFixed(2)} to ${(sellCall.strike + credit / 100).toFixed(2)}`,
              roi: ((credit / Math.max(1, maxLoss)) * 100).toFixed(0) + '%',
            });
          }
          if (ivCheap) {
            // Long Straddle — direction-agnostic, profits from large move
            const debit = (mid(atmCall) + mid(atmPut)) * 100;
            const contracts = Math.max(1, Math.floor(maxRisk / debit));
            strategies.push({
              name: 'Long Straddle',
              rationale: 'Neutral, IV cheap → expecting a large move either direction (often pre-earnings)',
              legs: [
                `BUY ${contracts}x ${expStr} ${atmCall.strike} CALL @ ~$${mid(atmCall).toFixed(2)}`,
                `BUY ${contracts}x ${expStr} ${atmPut.strike} PUT @ ~$${mid(atmPut).toFixed(2)}`,
              ],
              netDebit: debit * contracts, maxProfit: 'unlimited (call) / large (put)', maxLoss: debit * contracts,
              breakeven: `${(atmCall.strike - debit / 100).toFixed(2)} or ${(atmCall.strike + debit / 100).toFixed(2)}`,
              roi: 'depends on move magnitude',
            });
          }
        }

        if (strategies.length === 0) {
          strategies.push({ name: '(no recommendation)', rationale: `direction=${direction} + IV=${ivPercentile?.toFixed(0)}% — no matching template. Try direction=bullish/bearish/neutral.` });
        }

        const ivLabel = ivPercentile == null ? 'n/a' : `${ivPercentile.toFixed(0)}th percentile (${ivCheap ? 'CHEAP' : ivRich ? 'RICH' : 'normal'})`;
        const lines = [
          `Option strategy builder — ${ticker} @ $${spot}`,
          `Direction: ${direction}  |  ATM IV: ${(atmIV * 100).toFixed(1)}%  |  IV rank: ${ivLabel}`,
          `Expiry chosen: ${expStr} (${dtePicked} DTE)  |  Max risk budget: $${maxRisk}`,
          '',
        ];
        strategies.forEach((s, i) => {
          lines.push(`${i + 1}. ${s.name}`);
          lines.push(`   ${s.rationale}`);
          (s.legs || []).forEach(l => lines.push(`   ${l}`));
          if (s.netDebit) lines.push(`   Net debit: $${(s.netDebit).toFixed(0)}`);
          if (s.netCredit) lines.push(`   Net credit: $${(s.netCredit).toFixed(0)}`);
          if (s.maxProfit != null) lines.push(`   Max profit: ${typeof s.maxProfit === 'number' ? '$' + s.maxProfit.toFixed(0) : s.maxProfit}`);
          if (s.maxLoss != null) lines.push(`   Max loss: $${typeof s.maxLoss === 'number' ? s.maxLoss.toFixed(0) : s.maxLoss}`);
          if (s.breakeven) lines.push(`   Breakeven: ${s.breakeven}`);
          if (s.roi) lines.push(`   ROI: ${s.roi}`);
          lines.push('');
        });
        return lines.join('\n');
      } catch (e) { return `option_strategy_builder error: ${e.message}`; }
    }

    case 'crypto_onchain_metrics': {
      const coin = String(params.coin || 'bitcoin').toLowerCase();
      const lines = [`On-chain & derivatives — ${coin}`];
      try {
        // 1. CoinGecko: price + market cap + supply
        const cgRes = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin)}?localization=false&tickers=false&community_data=true&developer_data=false`, { headers: { 'Accept': 'application/json', 'User-Agent': 'NHA/1.0' } });
        if (cgRes.ok) {
          const cg = await cgRes.json();
          const md = cg.market_data || {};
          const price = md.current_price?.usd;
          const mcap = md.market_cap?.usd;
          const supply = md.circulating_supply;
          const ath = md.ath?.usd;
          const athDate = md.ath_date?.usd?.slice(0, 10);
          const fromAth = md.ath_change_percentage?.usd?.toFixed(1);
          lines.push(`Price: $${price?.toLocaleString()}  |  Market cap: $${(mcap / 1e9)?.toFixed(2)}B  |  Circulating: ${(supply / 1e6)?.toFixed(2)}M`);
          lines.push(`ATH: $${ath?.toLocaleString()} on ${athDate}  (${fromAth}% from ATH)`);
          if (cg.community_data?.twitter_followers) lines.push(`Twitter followers: ${cg.community_data.twitter_followers.toLocaleString()}`);
          // MVRV approximation using market cap / realized cap (CoinGecko doesn't expose realized cap directly,
          // but we approximate via mcap / (supply × avg_30d_price) — quick proxy).
          if (md.market_cap_change_percentage_24h_in_currency?.usd != null) {
            lines.push(`24h mcap change: ${md.market_cap_change_percentage_24h_in_currency.usd.toFixed(2)}%`);
          }
        }

        // 2. DeFi Llama TVL (free, no key) — for L1s and DeFi protocols
        try {
          const llSlugMap = { bitcoin: null, ethereum: 'ethereum', solana: 'solana', avalanche: 'avalanche', polygon: 'polygon', arbitrum: 'arbitrum', optimism: 'optimism', polkadot: 'polkadot', cosmos: 'cosmos' };
          const slug = llSlugMap[coin];
          if (slug) {
            const llRes = await fetch(`https://api.llama.fi/v2/historicalChainTvl/${slug}`);
            if (llRes.ok) {
              const tvl = await llRes.json();
              const latest = tvl[tvl.length - 1];
              const month = tvl[tvl.length - 30] || tvl[0];
              const chgPct = month?.tvl ? ((latest.tvl - month.tvl) / month.tvl * 100) : 0;
              lines.push(`\nDeFi TVL on ${slug}: $${(latest.tvl / 1e9).toFixed(2)}B (30d ${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(1)}%)`);
            }
          } else if (coin === 'bitcoin') {
            // BTC: pull total DeFi TVL on bitcoin sidechains
            const llRes = await fetch('https://api.llama.fi/v2/historicalChainTvl/Bitcoin');
            if (llRes.ok) {
              const tvl = await llRes.json();
              const latest = tvl[tvl.length - 1];
              lines.push(`\nDeFi TVL on Bitcoin (sidechains/L2): $${(latest.tvl / 1e6).toFixed(0)}M`);
            }
          }
        } catch {}

        // 3. Binance perpetual futures: funding rate + open interest (free, no key)
        try {
          const sym = coin === 'bitcoin' ? 'BTCUSDT' : coin === 'ethereum' ? 'ETHUSDT' : coin === 'solana' ? 'SOLUSDT' : null;
          if (sym) {
            const [fr, oi] = await Promise.all([
              fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=8`).then(r => r.ok ? r.json() : null).catch(() => null),
              fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`).then(r => r.ok ? r.json() : null).catch(() => null),
            ]);
            if (Array.isArray(fr) && fr.length) {
              const lastFr = parseFloat(fr[fr.length - 1].fundingRate) * 100;
              const avg8 = fr.reduce((a, x) => a + parseFloat(x.fundingRate), 0) / fr.length * 100;
              lines.push(`\nBinance perp funding (8h × 8 readings): last ${lastFr.toFixed(4)}%  |  avg ${avg8.toFixed(4)}%`);
              lines.push(`  → ${avg8 > 0.02 ? '🟢 longs paying shorts (bullish positioning)' : avg8 < -0.02 ? '🔴 shorts paying longs (bearish positioning)' : '🟡 neutral'}`);
            }
            if (oi?.openInterest) lines.push(`Open Interest: ${parseFloat(oi.openInterest).toLocaleString()} ${sym.replace('USDT', '')}`);
          }
        } catch {}

        // 4. Fear & Greed Index (alternative.me, free)
        try {
          const fgRes = await fetch('https://api.alternative.me/fng/?limit=1', { headers: { 'Accept': 'application/json' } });
          if (fgRes.ok) {
            const fg = await fgRes.json();
            const f = fg.data?.[0];
            if (f) lines.push(`\nFear & Greed Index: ${f.value}/100 — ${f.value_classification}`);
          }
        } catch {}

        // 5. BTC dominance + Stablecoin supply proxy
        try {
          const gRes = await fetch('https://api.coingecko.com/api/v3/global', { headers: { 'Accept': 'application/json' } });
          if (gRes.ok) {
            const g = await gRes.json();
            const dom = g.data?.market_cap_percentage || {};
            lines.push(`\nMarket structure: BTC dominance ${dom.btc?.toFixed(1)}%  |  ETH ${dom.eth?.toFixed(1)}%  |  Stablecoins (USDT+USDC) ${((dom.usdt || 0) + (dom.usdc || 0)).toFixed(1)}%`);
          }
        } catch {}

        return lines.join('\n');
      } catch (e) { return `crypto_onchain_metrics error: ${e.message}`; }
    }

    case 'portfolio_tax_lots': {
      // Tax-lot accounting. Reads ~/.nha/portfolio.json's `transactions` array
      // (buy/sell events with date + qty + price), produces realized + unrealized
      // gain breakdown using the chosen accounting method.
      const method = String(params.method || 'FIFO').toUpperCase(); // FIFO | LIFO | HIFO
      const fs = await import('fs'); const path = await import('path'); const os = await import('os');
      const file = path.default.join(os.default.homedir(), '.nha', 'portfolio.json');
      if (!fs.default.existsSync(file)) return 'Portfolio empty (no ~/.nha/portfolio.json).';
      const pf = JSON.parse(fs.default.readFileSync(file, 'utf-8'));
      const txs = (pf.transactions || []).slice().sort((a, b) => a.date.localeCompare(b.date));
      if (txs.length === 0) return 'No transactions recorded. Use portfolio_tx_add to record buys/sells with date.';

      // Build open lots per ticker by applying buys/sells with the chosen method.
      const lotsByTicker = {};
      const realizedByTicker = {};
      const washSaleWarnings = [];
      const today = new Date().toISOString().slice(0, 10);
      const yearAgoMs = Date.now() - 365 * 86400000;

      for (const tx of txs) {
        const t = (tx.ticker || '').toUpperCase();
        if (!t) continue;
        lotsByTicker[t] = lotsByTicker[t] || [];
        realizedByTicker[t] = realizedByTicker[t] || { shortTerm: 0, longTerm: 0, totalSold: 0 };
        if (tx.type === 'buy' || tx.type === 'BUY') {
          lotsByTicker[t].push({ date: tx.date, qty: tx.qty, cost: tx.price, remaining: tx.qty });
          // Wash sale check: any sale at a LOSS within 30 days before this buy?
          const recentLosses = (realizedByTicker[t].events || []).filter(ev => ev.loss < 0 && (new Date(tx.date) - new Date(ev.date)) <= 30 * 86400000 && (new Date(tx.date) - new Date(ev.date)) >= 0);
          if (recentLosses.length) washSaleWarnings.push(`${t}: buy on ${tx.date} may trigger wash-sale rule (loss sale on ${recentLosses[0].date}, $${(-recentLosses[0].loss).toFixed(2)} disallowed).`);
        } else if (tx.type === 'sell' || tx.type === 'SELL') {
          let qtyToClose = tx.qty;
          const sortLots = (lots) => {
            if (method === 'LIFO') return [...lots].sort((a, b) => b.date.localeCompare(a.date));
            if (method === 'HIFO') return [...lots].sort((a, b) => b.cost - a.cost);
            return [...lots].sort((a, b) => a.date.localeCompare(b.date)); // FIFO
          };
          const order = sortLots(lotsByTicker[t]);
          for (const lot of order) {
            if (qtyToClose <= 0) break;
            if (lot.remaining <= 0) continue;
            const take = Math.min(lot.remaining, qtyToClose);
            const proceeds = take * tx.price;
            const costBasis = take * lot.cost;
            const gain = proceeds - costBasis;
            const holdMs = new Date(tx.date) - new Date(lot.date);
            const isLongTerm = holdMs > 365 * 86400000;
            if (isLongTerm) realizedByTicker[t].longTerm += gain;
            else realizedByTicker[t].shortTerm += gain;
            realizedByTicker[t].totalSold += take;
            realizedByTicker[t].events = realizedByTicker[t].events || [];
            realizedByTicker[t].events.push({ date: tx.date, qty: take, gain, loss: gain < 0 ? gain : 0, lotDate: lot.date, isLongTerm });
            lot.remaining -= take;
            qtyToClose -= take;
          }
        }
      }

      // Fetch live prices for unrealized gain.
      const tickersOpen = Object.keys(lotsByTicker).filter(t => lotsByTicker[t].some(l => l.remaining > 0));
      let priceMap = {};
      if (tickersOpen.length) {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickersOpen.join(',')}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
          if (r.ok) {
            const d = await r.json();
            priceMap = Object.fromEntries((d?.quoteResponse?.result || []).map(q => [q.symbol, q.regularMarketPrice]));
          }
        } catch {}
      }

      const lines = [`Tax lot report — method: ${method}`, ''];
      let totalRealizedShort = 0, totalRealizedLong = 0, totalUnrealized = 0;
      let lossHarvestCandidates = [];
      for (const t of Object.keys(lotsByTicker)) {
        const open = lotsByTicker[t].filter(l => l.remaining > 0);
        const realized = realizedByTicker[t] || { shortTerm: 0, longTerm: 0 };
        const price = priceMap[t];
        let unrealized = 0;
        open.forEach(l => { if (price) unrealized += (price - l.cost) * l.remaining; });
        totalRealizedShort += realized.shortTerm;
        totalRealizedLong += realized.longTerm;
        totalUnrealized += unrealized;
        // Tax-loss harvesting: lot with unrealized loss + holding > some threshold
        open.forEach(l => {
          if (price && (price - l.cost) * l.remaining < -100) {
            const holdDays = (Date.now() - new Date(l.date).getTime()) / 86400000;
            lossHarvestCandidates.push({ ticker: t, lotDate: l.date, qty: l.remaining, cost: l.cost, currentPrice: price, loss: (price - l.cost) * l.remaining, holdDays });
          }
        });
        lines.push(`${t}:`);
        lines.push(`  Realized: short-term $${realized.shortTerm.toFixed(2)} | long-term $${realized.longTerm.toFixed(2)} | total $${(realized.shortTerm + realized.longTerm).toFixed(2)}`);
        if (open.length) {
          lines.push(`  Open lots (${open.length}, live $${price?.toFixed(2) || '?'}):`);
          open.forEach(l => {
            const u = price ? (price - l.cost) * l.remaining : 0;
            const ageDays = ((Date.now() - new Date(l.date).getTime()) / 86400000).toFixed(0);
            lines.push(`    ${l.date}  qty ${l.remaining}  cost $${l.cost.toFixed(2)}  unrealized $${u.toFixed(2)}  (${ageDays}d, ${ageDays > 365 ? 'long-term' : 'SHORT-TERM'})`);
          });
        }
        lines.push('');
      }
      lines.push(`TOTALS:`);
      lines.push(`  Realized short-term gains: $${totalRealizedShort.toFixed(2)}  (taxed at ordinary income rate)`);
      lines.push(`  Realized long-term gains:  $${totalRealizedLong.toFixed(2)}  (taxed at 0/15/20% in US)`);
      lines.push(`  Unrealized gains: $${totalUnrealized.toFixed(2)}`);
      if (washSaleWarnings.length) {
        lines.push(`\n⚠ Wash-sale warnings:\n  ${washSaleWarnings.join('\n  ')}`);
      }
      if (lossHarvestCandidates.length) {
        lines.push(`\n💡 Tax-loss harvest candidates (unrealized loss > $100):`);
        lossHarvestCandidates.sort((a, b) => a.loss - b.loss).slice(0, 5).forEach(c => {
          lines.push(`  ${c.ticker} lot ${c.lotDate} qty ${c.qty}: realize $${c.loss.toFixed(2)} loss${c.holdDays < 31 ? ' ⚠ <31 days, wash-sale risk' : ''}`);
        });
      }
      return lines.join('\n');
    }

    case 'portfolio_tx_add': {
      // Record a buy/sell transaction. Used to feed portfolio_tax_lots.
      const ticker = String(params.ticker || '').toUpperCase();
      const type = String(params.type || 'buy').toLowerCase();
      const qty = parseFloat(params.qty || params.quantity || '0');
      const price = parseFloat(params.price || '0');
      const date = String(params.date || new Date().toISOString().slice(0, 10));
      if (!ticker || qty <= 0 || !['buy', 'sell'].includes(type)) return 'portfolio_tx_add: ticker, type (buy|sell), qty (>0), price required.';
      const fs = await import('fs'); const path = await import('path'); const os = await import('os');
      const file = path.default.join(os.default.homedir(), '.nha', 'portfolio.json');
      let pf = { positions: [], transactions: [] };
      try { if (fs.default.existsSync(file)) pf = JSON.parse(fs.default.readFileSync(file, 'utf-8')); } catch {}
      pf.transactions = pf.transactions || [];
      pf.transactions.push({ ticker, type, qty, price, date, recordedAt: new Date().toISOString() });
      // Also update current `positions` for parity with portfolio_summary.
      pf.positions = pf.positions || [];
      const idx = pf.positions.findIndex(p => p.ticker === ticker);
      if (type === 'buy') {
        if (idx >= 0) {
          const existing = pf.positions[idx];
          const totalQty = existing.qty + qty;
          existing.cost = ((existing.qty * existing.cost) + (qty * price)) / totalQty;
          existing.qty = totalQty;
        } else {
          pf.positions.push({ ticker, qty, cost: price, addedAt: new Date().toISOString() });
        }
      } else {
        if (idx >= 0) {
          pf.positions[idx].qty -= qty;
          if (pf.positions[idx].qty <= 0) pf.positions.splice(idx, 1);
        }
      }
      fs.default.mkdirSync(path.default.dirname(file), { recursive: true });
      fs.default.writeFileSync(file, JSON.stringify(pf, null, 2));
      return `Transaction recorded: ${type.toUpperCase()} ${qty} ${ticker} @ $${price} on ${date}. Total transactions: ${pf.transactions.length}.`;
    }

    case 'insider_trading': {
      const ticker = String(params.ticker || '').toUpperCase();
      const limit = Math.min(parseInt(params.limit || '15', 10), 30);
      if (!ticker) return 'insider_trading: ticker required.';
      try {
        const ua = 'NotHumanAllowed CLI hello@nothumanallowed.com';
        const tres = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': ua } });
        if (!tres.ok) return `insider_trading: ticker map HTTP ${tres.status}`;
        const map = await tres.json();
        const entry = Object.values(map).find(e => e.ticker?.toUpperCase() === ticker);
        if (!entry) return `insider_trading: ${ticker} not in SEC EDGAR (US-listed only).`;
        const cik = String(entry.cik_str).padStart(10, '0');
        const fres = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'User-Agent': ua } });
        if (!fres.ok) return `insider_trading: HTTP ${fres.status}`;
        const fd = await fres.json();
        const recent = fd.filings?.recent || {};
        const rows = [];
        for (let i = 0; i < (recent.form?.length || 0); i++) {
          if (recent.form[i] !== '4') continue;
          rows.push({
            date: recent.filingDate[i],
            accession: recent.accessionNumber[i],
            primary: recent.primaryDocument[i],
          });
          if (rows.length >= limit) break;
        }
        if (rows.length === 0) return `insider_trading: no Form 4 (insider) filings for ${ticker}.`;
        const lines = [`Insider trading (Form 4) — ${entry.title} (${ticker}) — last ${rows.length}`];
        rows.forEach(r => {
          const accNoDash = r.accession.replace(/-/g, '');
          const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accNoDash}/${r.primary}`;
          lines.push(`  ${r.date}  Form 4 → ${url}`);
        });
        lines.push(`\nNote: Form 4 filings report officer/director/10%-owner transactions. Open URLs to see whether BUY (acquired) or SELL (disposed).`);
        return lines.join('\n');
      } catch (e) { return `insider_trading error: ${e.message}`; }
    }

    case 'italian_market': {
      // FTSE MIB constituents and BTP-Bund spread (10y Italy minus 10y Germany).
      const which = String(params.what || 'all').toLowerCase();
      const lines = [];
      try {
        if (which === 'all' || which === 'mib' || which === 'index') {
          const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/FTSEMIB.MI?range=5d&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
          if (r.ok) {
            const d = await r.json();
            const res = d.chart.result[0];
            const closes = res.indicators.quote[0].close.filter(Boolean);
            const last = closes[closes.length - 1];
            const prev = closes[closes.length - 2];
            const chg = prev ? ((last - prev) / prev * 100) : 0;
            lines.push(`FTSE MIB: ${last?.toFixed(0)} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% giorn.)`);
          }
        }
        if (which === 'all' || which === 'spread' || which === 'btp') {
          const [it, de] = await Promise.all([
            fetch('https://query1.finance.yahoo.com/v8/finance/chart/^TNX-IT?range=1d&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null),
            fetch('https://query1.finance.yahoo.com/v8/finance/chart/^TNX-DE?range=1d&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null),
          ]);
          // Yahoo doesn't expose BTP/Bund directly via simple ticker; use approx via futures or skip.
          lines.push('BTP-Bund spread: dato non disponibile via Yahoo gratis. Suggerisco fetch_url su https://www.borsaitaliana.it/borsa/obbligazioni.html');
        }
        // Top constituents — manual list of FTSE MIB blue chips, fetched as batch
        if (which === 'all' || which === 'constituents' || which === 'top') {
          const tickers = ['ENI.MI','ENEL.MI','UCG.MI','ISP.MI','STLAM.MI','RACE.MI','TIT.MI','G.MI','MB.MI','LDO.MI','PRY.MI','SPM.MI','PST.MI','BAMI.MI','FBK.MI'];
          const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NHA/1.0)' } });
          if (r.ok) {
            const d = await r.json();
            const quotes = d?.quoteResponse?.result || [];
            lines.push('\nFTSE MIB — Top constituents:');
            quotes.forEach(q => {
              const chg = q.regularMarketChangePercent;
              lines.push(`  ${q.symbol.padEnd(9)} ${(q.shortName || '').slice(0, 22).padEnd(23)} €${(q.regularMarketPrice || 0).toFixed(2).padStart(8)}  ${(chg >= 0 ? '+' : '') + chg?.toFixed(2)}%`);
            });
          }
        }
        if (lines.length === 0) return `italian_market: parametro "what" non riconosciuto. Usa "all" | "mib" | "constituents" | "spread".`;
        return lines.join('\n');
      } catch (e) { return `italian_market error: ${e.message}`; }
    }

    default:
      return `Unknown action: ${action}`;
  }
}
