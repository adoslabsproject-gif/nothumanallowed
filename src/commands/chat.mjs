/**
 * nha chat — Interactive conversational REPL for PAO (Personal Agent Ops).
 *
 * Features:
 * - Streaming responses (token-by-token display)
 * - Multi-conversation management (/new, /list, /switch, /delete, /rename)
 * - Export conversations (/export md, /export json)
 * - @agent inline routing and /agent persistent mode
 * - Tool execution with confirmation for destructive actions
 *
 * All tool definitions, parsing, and execution are in tool-executor.mjs (DRY).
 *
 * Zero npm dependencies — Node.js 22 built-in readline only.
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from '../config.mjs';
import { AGENTS_DIR, AGENTS } from '../constants.mjs';
import { callLLMStream, parseAgentFile } from '../services/llm.mjs';

import { extractMemory } from '../services/memory.mjs';
import { fail, info, ok, warn, C, G, Y, D, W, BOLD, NC, R, M } from '../ui.mjs';
import {
  DESTRUCTIVE_ACTIONS,
  parseActions,
  executeTool,
  describeAction,
  formatTime,
  formatEvents,
  buildSystemPrompt,
} from '../services/tool-executor.mjs';
import {
  getTodayEvents,
  getUnreadImportant,
} from '../services/mail-router.mjs';
import { getTasks } from '../services/task-store.mjs';
import {
  createConversation,
  loadConversation,
  saveConversation,
  deleteConversation,
  listConversations,
  getOrCreateActive,
  setActiveId,
  getHistory,
  addMessages,
  exportAsMarkdown,
  exportAsJson,
  migrateOldHistory,
} from '../services/conversations.mjs';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_HISTORY = 20;

const CHAT_PERSONA = `You are NHA Chat, a personal operations assistant inside the NotHumanAllowed CLI. ` +
  `You help the user manage their emails, calendar, tasks, GitHub issues, Notion pages, and Slack channels through natural conversation. ` +
  `Be concise, helpful, and proactive. When presenting data, format it clearly. ` +
  `Never output raw JSON to the user — always wrap results in natural language.`;

// ── System Prompt Builder ────────────────────────────────────────────────────

/**
 * Serialize conversation history into a single user message string.
 * Each turn is prefixed with [User] or [Assistant] to maintain role clarity.
 */
function serializeHistory(history, currentMessage) {
  const parts = [];

  for (const turn of history) {
    const prefix = turn.role === 'user' ? '[User]' : '[Assistant]';
    parts.push(`${prefix} ${turn.content}`);
  }

  parts.push(`[User] ${currentMessage}`);
  return parts.join('\n\n');
}

// ── Confirmation Prompt ──────────────────────────────────────────────────────

/**
 * Ask the user for y/n confirmation before executing a destructive action.
 */
function askConfirmation(rl, description) {
  return new Promise((resolve) => {
    rl.question(`  ${Y}?${NC} ${description} ${D}[y/n]${NC} `, (answer) => {
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ── Initial Context Fetcher ──────────────────────────────────────────────────

async function fetchInitialContext(config) {
  const parts = [];

  try {
    const events = await getTodayEvents(config);
    if (events.length > 0) {
      parts.push(`TODAY'S CALENDAR (${events.length} events):\n` + formatEvents(events));
    } else {
      parts.push('TODAY\'S CALENDAR: No events scheduled.');
    }
  } catch {
    parts.push('CALENDAR: Could not fetch (Google not connected?).');
  }

  try {
    const emails = await getUnreadImportant(config, 10);
    if (emails.length > 0) {
      parts.push(`UNREAD EMAILS (${emails.length}):\n` +
        emails.map((m, i) =>
          `${i + 1}. [${m.id}] From: ${m.from} | Subject: ${m.subject}\n   ${m.snippet.slice(0, 100)}`
        ).join('\n'));
    } else {
      parts.push('UNREAD EMAILS: Inbox zero!');
    }
  } catch {
    parts.push('EMAIL: Could not fetch (Google not connected?).');
  }

  try {
    const tasks = getTasks();
    if (tasks.length > 0) {
      parts.push(`TODAY'S TASKS (${tasks.length}):\n` +
        tasks.map(t => `#${t.id} [${t.priority}] ${t.status === 'done' ? '[DONE] ' : ''}${t.description}`).join('\n'));
    } else {
      parts.push('TODAY\'S TASKS: None yet.');
    }
  } catch {
    parts.push('TASKS: Could not load.');
  }

  return parts.join('\n\n');
}

// ── Relative Time ────────────────────────────────────────────────────────────

function relativeTime(isoString) {
  const ms = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

// ── Slash Command Handlers ───────────────────────────────────────────────────

async function handleSlashCommand(input, config, conv, rl) {
  const trimmed = input.trim();

  if (trimmed === '/quit' || trimmed === '/exit' || trimmed === '/q') {
    console.log(`\n  ${D}Session ended. Goodbye.${NC}\n`);
    process.exit(0);
  }

  // ── Multi-conversation commands ──────────────────────────────────────────

  if (trimmed === '/new') {
    const newConv = createConversation();
    // Update the outer reference via return
    console.log(`  ${G}New conversation started.${NC} ${D}(${newConv.id})${NC}`);
    return { handled: true, switchTo: newConv };
  }

  if (trimmed === '/list' || trimmed === '/conversations') {
    const convs = listConversations();
    if (convs.length === 0) {
      console.log(`  ${D}No conversations yet.${NC}`);
    } else {
      console.log(`\n  ${BOLD}Conversations${NC} (${convs.length})\n`);
      for (const c of convs) {
        const active = c.id === conv.id ? ` ${G}<- active${NC}` : '';
        const turns = Math.floor(c.messageCount / 2);
        console.log(`  ${C}${c.id}${NC}  ${c.title}  ${D}(${turns} turns, ${relativeTime(c.updatedAt)})${NC}${active}`);
      }
      console.log(`\n  ${D}Switch: /switch <id> | New: /new | Delete: /delete <id>${NC}`);
    }
    return { handled: true };
  }

  if (trimmed.startsWith('/switch ')) {
    const targetId = trimmed.slice(8).trim();
    const target = loadConversation(targetId);
    if (!target) {
      console.log(`  ${R}Conversation "${targetId}" not found. Use /list to see all.${NC}`);
      return { handled: true };
    }
    setActiveId(targetId);
    const turns = Math.floor(target.messages.length / 2);
    console.log(`  ${G}Switched to:${NC} ${target.title} ${D}(${turns} turns)${NC}`);
    return { handled: true, switchTo: target };
  }

  if (trimmed.startsWith('/delete ')) {
    const targetId = trimmed.slice(8).trim();
    if (targetId === conv.id) {
      console.log(`  ${R}Cannot delete active conversation. Switch to another first.${NC}`);
      return { handled: true };
    }
    if (deleteConversation(targetId)) {
      console.log(`  ${G}Deleted conversation ${targetId}.${NC}`);
    } else {
      console.log(`  ${R}Conversation "${targetId}" not found.${NC}`);
    }
    return { handled: true };
  }

  if (trimmed.startsWith('/rename ')) {
    const newTitle = trimmed.slice(8).trim();
    if (!newTitle) {
      console.log(`  ${R}Usage: /rename <new title>${NC}`);
      return { handled: true };
    }
    conv.title = newTitle;
    saveConversation(conv);
    console.log(`  ${G}Renamed to:${NC} ${newTitle}`);
    return { handled: true };
  }

  // ── Export commands ──────────────────────────────────────────────────────

  if (trimmed === '/export' || trimmed === '/export md' || trimmed === '/export markdown') {
    if (conv.messages.length === 0) {
      console.log(`  ${D}Nothing to export — conversation is empty.${NC}`);
      return { handled: true };
    }
    const md = exportAsMarkdown(conv);
    const filename = `nha-chat-${conv.id}.md`;
    const filePath = path.join(os.homedir(), filename);
    fs.writeFileSync(filePath, md, 'utf-8');
    console.log(`  ${G}Exported as Markdown:${NC} ~/${filename}`);
    return { handled: true };
  }

  if (trimmed === '/export json') {
    if (conv.messages.length === 0) {
      console.log(`  ${D}Nothing to export — conversation is empty.${NC}`);
      return { handled: true };
    }
    const json = exportAsJson(conv);
    const filename = `nha-chat-${conv.id}.json`;
    const filePath = path.join(os.homedir(), filename);
    fs.writeFileSync(filePath, json, 'utf-8');
    console.log(`  ${G}Exported as JSON:${NC} ~/${filename}`);
    return { handled: true };
  }

  // ── Original commands ────────────────────────────────────────────────────

  if (trimmed === '/clear') {
    conv.messages.length = 0;
    saveConversation(conv);
    console.clear();
    console.log(`  ${G}Conversation cleared (memory preserved).${NC}`);
    return { handled: true };
  }

  if (trimmed === '/tasks') {
    try {
      const tasks = getTasks();
      if (tasks.length === 0) {
        console.log(`  ${D}No tasks for today.${NC}`);
      } else {
        for (const t of tasks) {
          const icon = t.status === 'done' ? `${G}[done]${NC}` : `${Y}[${t.priority}]${NC}`;
          console.log(`  ${icon} #${t.id} ${t.description}`);
        }
      }
    } catch (err) {
      console.log(`  ${R}Could not load tasks: ${err.message}${NC}`);
    }
    return { handled: true };
  }

  if (trimmed === '/plan') {
    try {
      const { cmdPlan } = await import('./plan.mjs');
      await cmdPlan([]);
    } catch (err) {
      console.log(`  ${R}Plan error: ${err.message}${NC}`);
    }
    return { handled: true };
  }

  // /agent <name> — switch to talking with a specific agent
  if (trimmed.startsWith('/agent ')) {
    const agentName = trimmed.slice(7).trim().toLowerCase();

    if (agentName === 'off' || agentName === 'reset') {
      delete config._chatAgent;
      console.log(`  ${G}Switched back to NHA Chat.${NC}`);
      return { handled: true };
    }

    const agentFile = path.join(AGENTS_DIR, `${agentName}.mjs`);
    if (!fs.existsSync(agentFile)) {
      console.log(`  ${R}Agent "${agentName}" not found. Available: ${AGENTS.join(', ')}${NC}`);
      return { handled: true };
    }
    const agentSource = fs.readFileSync(agentFile, 'utf-8');
    const { card, systemPrompt: agentSysPrompt } = parseAgentFile(agentSource, agentName);
    if (agentSysPrompt) {
      config._chatAgent = { name: agentName, systemPrompt: agentSysPrompt, card };
      console.log(`  ${G}Now chatting with ${BOLD}${card?.displayName || agentName.toUpperCase()}${NC}${G} (${card?.tagline || 'agent'})${NC}`);
      console.log(`  ${D}Type /agent off to return to NHA Chat${NC}`);
    } else {
      console.log(`  ${R}Agent "${agentName}" has no system prompt.${NC}`);
    }
    return { handled: true };
  }

  // /create-agent <name> "<tagline>" "<system prompt>"
  if (trimmed === '/create-agent' || trimmed.startsWith('/create-agent ')) {
    const parts = trimmed.slice(14).trim();
    if (!parts) {
      console.log(`\n  ${BOLD}${Y}Create Custom Agent${NC}`);
      console.log(`  Usage: ${C}/create-agent mybot "Short description" "You are an expert in..."${NC}`);
      console.log(`  Example: ${D}/create-agent chef "Italian cooking expert" "You are a master Italian chef. Always suggest authentic recipes with step-by-step instructions."${NC}\n`);
      return { handled: true };
    }
    const nameMatch = parts.match(/^(\S+)\s+(.+)/);
    if (!nameMatch) {
      console.log(`  ${R}Usage: /create-agent <name> "<tagline>" "<system prompt>"${NC}`);
      return { handled: true };
    }
    const name = nameMatch[1].toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const rest = nameMatch[2];
    const quoteParts = rest.match(/"([^"]*)"/g);
    let tagline = '', sysPrompt = '';
    if (quoteParts && quoteParts.length >= 2) {
      tagline = quoteParts[0].replace(/"/g, '');
      sysPrompt = quoteParts[1].replace(/"/g, '');
    } else {
      const firstDot = rest.indexOf('.');
      if (firstDot > 0) {
        tagline = rest.slice(0, firstDot).replace(/"/g, '').trim();
        sysPrompt = rest.slice(firstDot + 1).replace(/"/g, '').trim();
      } else {
        tagline = rest.replace(/"/g, '').trim();
        sysPrompt = tagline;
      }
    }

    if (!name || !tagline || !sysPrompt) {
      console.log(`  ${R}All fields required. Usage: /create-agent name "tagline" "system prompt"${NC}`);
      return { handled: true };
    }

    const agentFile = path.join(AGENTS_DIR, `${name}.mjs`);
    if (fs.existsSync(agentFile)) {
      console.log(`  ${R}Agent "${name}" already exists.${NC}`);
      return { handled: true };
    }

    const content = `// NHA Custom Agent: ${name}\n// Created: ${new Date().toISOString()}\n\nexport const CARD = {\n  name: '${name}',\n  displayName: '${name.toUpperCase()}',\n  category: 'custom',\n  tagline: '${tagline.replace(/'/g, "\\'")}',\n};\n\nexport const SYSTEM_PROMPT = \`${sysPrompt.replace(/`/g, '\\`')}\`;\n`;
    if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });
    fs.writeFileSync(agentFile, content, 'utf-8');
    console.log(`  ${G}Agent "${name}" created!${NC}`);
    console.log(`  ${D}Switch to it: /agent ${name}${NC}`);
    return { handled: true };
  }

  // /agents — list available agents
  if (trimmed === '/agents') {
    const available = [];
    if (fs.existsSync(AGENTS_DIR)) {
      for (const f of fs.readdirSync(AGENTS_DIR)) {
        if (f.endsWith('.mjs')) available.push(f.replace('.mjs', ''));
      }
    }
    console.log(`  ${BOLD}Available Agents${NC} (${available.length})`);
    for (const a of available) {
      console.log(`  ${C}${a}${NC}`);
    }
    console.log(`\n  ${D}Switch: /agent <name> | Create: /create-agent${NC}`);
    return { handled: true };
  }

  if (trimmed === '/help') {
    console.log(`
  ${BOLD}Chat Commands${NC}

  ${BOLD}Conversations${NC}
  ${C}/new${NC}            Start a new conversation
  ${C}/list${NC}           List all conversations
  ${C}/switch <id>${NC}    Switch to a conversation
  ${C}/rename <title>${NC} Rename current conversation
  ${C}/delete <id>${NC}    Delete a conversation
  ${C}/export${NC}         Export as Markdown (~/)
  ${C}/export json${NC}    Export as JSON (~/)

  ${BOLD}Agents${NC}
  ${C}/agents${NC}         List available agents
  ${C}/agent <name>${NC}   Switch to chatting with a specific agent
  ${C}/agent off${NC}      Return to NHA Chat
  ${C}/create-agent${NC}   Create a new custom agent

  ${BOLD}Tools${NC}
  ${C}/tasks${NC}          Show today's tasks
  ${C}/plan${NC}           Run daily planner
  ${C}/clear${NC}          Clear current conversation
  ${C}/help${NC}           Show this help
  ${C}/quit${NC}           Exit chat

  ${D}Tip: Type @agent in any message to route it inline.
  Example: "@saber audit this function for SQL injection"

  Type naturally — "show my unread emails", "add a task",
  "what's on my calendar tomorrow?", "list GitHub issues"${NC}
`);
    return { handled: true };
  }

  return { handled: false };
}

// ── Tool Indicators ──────────────────────────────────────────────────────────

/**
 * Format a user-visible label while a tool is executing.
 */
function formatToolLabel(action, params) {
  switch (action) {
    case 'web_search':
      return `Searching the web for "${params.query || '...'}"...`;
    case 'fetch_url':
      return `Fetching ${params.url || 'URL'}...`;
    case 'browser_open':
      return `Opening ${params.url || 'page'} in browser...`;
    case 'browser_screenshot':
      return `Taking screenshot...`;
    case 'browser_click':
      return `Clicking ${params.selector || `(${params.x}, ${params.y})`}...`;
    case 'browser_type':
      return `Typing into ${params.selector || 'field'}...`;
    case 'browser_extract':
      return `Extracting content from ${params.selector || 'page'}...`;
    case 'browser_js':
      return `Executing JavaScript...`;
    case 'browser_wait':
      return `Waiting for ${params.selector || 'element'}...`;
    case 'browser_scroll':
      return `Scrolling ${params.direction || 'down'}...`;
    case 'browser_key':
      return `Pressing ${params.key || 'key'}...`;
    case 'browser_close':
      return `Closing browser...`;
    case 'gmail_list':
      return `Searching emails...`;
    case 'gmail_read':
      return `Reading email...`;
    case 'gmail_send':
    case 'gmail_send_attach':
      return `Sending email to ${params.to || '...'}...`;
    case 'gmail_reply':
      return `Sending reply...`;
    case 'calendar_create':
      return `Creating event "${params.summary || '...'}"...`;
    case 'calendar_today':
    case 'calendar_tomorrow':
    case 'calendar_upcoming':
    case 'calendar_week':
      return `Loading calendar...`;
    case 'github_issues':
    case 'github_prs':
      return `Fetching from GitHub...`;
    case 'notion_search':
      return `Searching Notion...`;
    case 'slack_messages':
    case 'slack_channels':
      return `Loading Slack...`;
    default:
      return `Executing ${action}...`;
  }
}

/**
 * Format a result header with visual indicator based on tool type.
 */
function formatToolResult(action, params, result) {
  switch (action) {
    case 'web_search': {
      const count = (result.match(/\d+\. /g) || []).length;
      const deep = params.deep ? ', deep mode' : '';
      return `${C}[Web Search: ${count} results${deep}]${NC}`;
    }
    case 'fetch_url': {
      const domain = (params.url || '').replace(/^https?:\/\//, '').split('/')[0];
      return `${C}[Fetched: ${domain}]${NC}`;
    }
    case 'browser_open': {
      const domain = (params.url || '').replace(/^https?:\/\//, '').split('/')[0];
      return `${M}[Browser: ${domain}]${NC}`;
    }
    case 'browser_screenshot':
      return `${M}[Screenshot]${NC}`;
    case 'browser_click':
      return `${M}[Click: ${params.selector || `(${params.x}, ${params.y})`}]${NC}`;
    case 'browser_type':
      return `${M}[Typed: ${(params.text || '').slice(0, 30)}${(params.text || '').length > 30 ? '...' : ''}]${NC}`;
    case 'browser_extract':
      return `${M}[Extracted: ${params.selector || 'page'}]${NC}`;
    case 'browser_js':
      return `${M}[JS executed]${NC}`;
    case 'browser_wait':
      return `${M}[Found: ${params.selector}]${NC}`;
    case 'browser_scroll':
      return `${M}[Scrolled ${params.direction || 'down'}]${NC}`;
    case 'browser_key':
      return `${M}[Key: ${params.key}]${NC}`;
    case 'browser_close':
      return `${M}[Browser closed]${NC}`;
    case 'gmail_list':
    case 'gmail_read':
    case 'gmail_send':
    case 'gmail_send_attach':
    case 'gmail_reply':
    case 'gmail_draft':
    case 'gmail_mark_read':
    case 'gmail_mark_unread':
    case 'gmail_archive':
    case 'gmail_delete':
      return `${G}[Email]${NC}`;
    case 'calendar_today':
    case 'calendar_tomorrow':
    case 'calendar_upcoming':
    case 'calendar_week':
    case 'calendar_create':
    case 'calendar_move':
    case 'calendar_find':
    case 'calendar_update':
    case 'schedule_meeting':
    case 'schedule_draft_email':
      return `${G}[Calendar]${NC}`;
    case 'task_list':
    case 'task_add':
    case 'task_done':
    case 'task_move':
    case 'task_delete':
    case 'task_clear':
    case 'task_edit':
      return `${G}[Tasks]${NC}`;
    case 'github_issues':
    case 'github_prs':
    case 'github_notifications':
    case 'github_create_issue':
      return `${G}[GitHub]${NC}`;
    case 'notion_search':
    case 'notion_page':
      return `${G}[Notion]${NC}`;
    case 'slack_channels':
    case 'slack_messages':
    case 'slack_send':
      return `${G}[Slack]${NC}`;
    default:
      return `${G}[${action}]${NC}`;
  }
}

// ── Main REPL ────────────────────────────────────────────────────────────────

export async function cmdChat(args) {
  const config = loadConfig();

  if (!config.llm.apiKey) {
    fail('No API key configured. Run: nha config set key YOUR_KEY');
    process.exit(1);
  }

  // Migrate old single-file chat history on first run
  migrateOldHistory();

  // Load or create active conversation
  let conv = getOrCreateActive();

  console.log(`
  ${BOLD}${C}NHA Chat${NC}  ${D}— Personal Operations Assistant${NC}
  ${D}Type naturally to manage emails, calendar, tasks, GitHub, Notion, Slack.${NC}
  ${D}Commands: /new /list /export /help /quit${NC}
`);

  // Show active conversation info
  const turns = Math.floor(conv.messages.length / 2);
  if (turns > 0) {
    ok(`Conversation: "${conv.title}" (${turns} turns)`);
  } else {
    info(`New conversation started. (${conv.id})`);
  }

  info('Loading today\'s context...');
  let initialContext = '';
  try {
    initialContext = await fetchInitialContext(config);
    ok('Context loaded (calendar, email, tasks).');
  } catch {
    warn('Could not load full context. Google may not be connected.');
    warn('Run "nha google auth" to connect Gmail + Calendar.');
  }
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C}NHA>${NC} `,
    terminal: true,
  });

  const systemPrompt = buildSystemPrompt('NHA Chat', CHAT_PERSONA, config, initialContext);

  rl.on('close', () => {
    console.log(`\n  ${D}Session ended. Goodbye.${NC}\n`);
    process.exit(0);
  });

  let pendingExit = false;
  process.on('SIGINT', () => {
    if (pendingExit) {
      console.log(`\n  ${D}Goodbye.${NC}\n`);
      process.exit(0);
    }
    pendingExit = true;
    console.log(`\n  ${D}Press Ctrl+C again to exit, or type to continue.${NC}`);
    rl.prompt();
    setTimeout(() => { pendingExit = false; }, 3000);
  });

  rl.prompt();

  for await (const rawLine of rl) {
    const input = rawLine.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    if (input.startsWith('/')) {
      const result = await handleSlashCommand(input, config, conv, rl);
      if (result.handled) {
        // Handle conversation switch
        if (result.switchTo) {
          conv = result.switchTo;
        }
        rl.prompt();
        continue;
      }
    }

    try {
      // Handle @agent inline routing
      let effectiveSystemPrompt = systemPrompt;
      let effectiveInput = input;
      const atMatch = input.match(/^@(\w+)\s+(.*)/s);
      if (atMatch) {
        const inlineAgent = atMatch[1].toLowerCase();
        const inlinePrompt = atMatch[2];
        const agentFile = path.join(AGENTS_DIR, `${inlineAgent}.mjs`);
        if (fs.existsSync(agentFile)) {
          const agentSource = fs.readFileSync(agentFile, 'utf-8');
          const { card, systemPrompt: agentSysPrompt } = parseAgentFile(agentSource, inlineAgent);
          if (agentSysPrompt) {
            effectiveSystemPrompt = agentSysPrompt;
            effectiveInput = inlinePrompt;
            process.stdout.write(`  ${D}Routing to ${card?.displayName || inlineAgent.toUpperCase()}...${NC}\n`);
          }
        }
      } else if (config._chatAgent) {
        effectiveSystemPrompt = config._chatAgent.systemPrompt;
      }

      const history = getHistory(conv, MAX_HISTORY);
      const userMessage = serializeHistory(history, effectiveInput);

      process.stdout.write(`\n  ${D}Thinking...${NC}`);
      let firstToken = true;
      const response = await callLLMStream(config, effectiveSystemPrompt, userMessage, (chunk) => {
        if (firstToken) {
          process.stdout.write('\r' + ' '.repeat(40) + '\r\n  ');
          firstToken = false;
        }
        process.stdout.write(chunk);
      });
      if (firstToken) {
        process.stdout.write('\r' + ' '.repeat(40) + '\r');
      } else {
        process.stdout.write('\n');
      }

      const { textParts, actions } = parseActions(response);
      console.log('');

      for (const { action, params } of actions) {
        const isDestructive = DESTRUCTIVE_ACTIONS.has(action);

        if (isDestructive) {
          const desc = describeAction(action, params);
          const confirmed = await askConfirmation(rl, desc);

          if (!confirmed) {
            console.log(`  ${D}Cancelled.${NC}\n`);
            addMessages(conv, input, response + '\n[User cancelled this action]');
            continue;
          }
        }

        try {
          // Show action-specific indicator
          const toolLabel = formatToolLabel(action, params);
          process.stdout.write(`  ${D}${toolLabel}${NC}`);
          const result = await executeTool(action, params, config);
          process.stdout.write('\r' + ' '.repeat(80) + '\r');

          // Handle screen capture vision result
          if (result && typeof result === 'object' && result.__screenshot) {
            console.log(`  ${G}Screenshot captured${NC} — analyzing with vision...\n`);
            try {
              const { callLLMVision } = await import('../services/llm.mjs');
              const visionResponse = await callLLMVision(config,
                'Describe EXACTLY and ONLY what you see in this screenshot. NEVER invent or fabricate details.',
                `The user said: "${input}"\n\n${result.question}`,
                { base64: result.base64, mimeType: 'image/png' }
              );
              console.log(`  ${visionResponse.split('\n').join('\n  ')}\n`);
              addMessages(conv, input, response + `\n\n[Screenshot: ${result.path}]\n${visionResponse}`);
            } catch (visionErr) {
              console.log(`  ${R}Vision failed: ${visionErr.message}${NC}\n`);
              addMessages(conv, input, response + `\n\n[Screenshot captured but vision failed: ${visionErr.message}]`);
            }
          } else {
            // Show action-specific result header
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            const resultHeader = formatToolResult(action, params, resultStr);
            console.log(`  ${resultHeader}`);
            console.log(`  ${resultStr.split('\n').join('\n  ')}\n`);

            addMessages(conv, input, response + `\n\n[Tool ${action} executed. Result: ${resultStr}]`);
          }
        } catch (err) {
          process.stdout.write('\r' + ' '.repeat(80) + '\r');
          console.log(`  ${R}Error executing ${action}: ${err.message}${NC}\n`);
          addMessages(conv, input, response + `\n\n[Tool ${action} failed: ${err.message}]`);
        }
      }

      if (actions.length === 0) {
        addMessages(conv, input, response);
      }

      try { extractMemory('chat', input, response); } catch { /* non-critical */ }
    } catch (err) {
      process.stdout.write('\r' + ' '.repeat(40) + '\r');
      console.log(`\n  ${R}LLM error: ${err.message}${NC}\n`);
    }

    rl.prompt();
  }
}
