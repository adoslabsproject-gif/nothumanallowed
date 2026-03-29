/**
 * nha chat — Interactive conversational REPL for PAO (Personal Agent Ops).
 *
 * The user types natural language; an LLM interprets intent, optionally
 * invokes Gmail / Calendar / Tasks / GitHub / Notion / Slack APIs via a
 * structured JSON action protocol, and responds conversationally.
 *
 * All tool definitions, parsing, and execution are in tool-executor.mjs (DRY).
 *
 * Zero npm dependencies — Node.js 22 built-in readline only.
 */

import readline from 'readline';
import { loadConfig } from '../config.mjs';
import { callLLM } from '../services/llm.mjs';
import { loadChatHistory, saveChatHistory, extractMemory } from '../services/memory.mjs';
import { fail, info, ok, warn, C, G, Y, D, W, BOLD, NC, R } from '../ui.mjs';
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

// ── Slash Command Handlers ───────────────────────────────────────────────────

async function handleSlashCommand(input, config, history) {
  const trimmed = input.trim();

  if (trimmed === '/quit' || trimmed === '/exit' || trimmed === '/q') {
    console.log(`\n  ${D}Session ended. Goodbye.${NC}\n`);
    process.exit(0);
  }

  if (trimmed === '/clear') {
    history.length = 0;
    try { saveChatHistory([]); } catch { /* non-critical */ }
    console.clear();
    console.log(`  ${G}Conversation cleared (memory preserved, chat history reset).${NC}`);
    return true;
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
    return true;
  }

  if (trimmed === '/plan') {
    try {
      const { cmdPlan } = await import('./plan.mjs');
      await cmdPlan([]);
    } catch (err) {
      console.log(`  ${R}Plan error: ${err.message}${NC}`);
    }
    return true;
  }

  if (trimmed === '/help') {
    console.log(`
  ${BOLD}Chat Commands${NC}

  ${C}/tasks${NC}    Show today's tasks
  ${C}/plan${NC}     Run daily planner
  ${C}/clear${NC}    Clear conversation history
  ${C}/help${NC}     Show this help
  ${C}/quit${NC}     Exit chat

  ${D}Otherwise, just type naturally — the AI understands
  requests like "show my unread emails", "add a task to review PR #42",
  "what's on my calendar tomorrow?", "list GitHub issues", etc.${NC}
`);
    return true;
  }

  return false;
}

// ── Main REPL ────────────────────────────────────────────────────────────────

export async function cmdChat(args) {
  const config = loadConfig();

  if (!config.llm.apiKey) {
    fail('No API key configured. Run: nha config set key YOUR_KEY');
    process.exit(1);
  }

  console.log(`
  ${BOLD}${C}NHA Chat${NC}  ${D}— Personal Operations Assistant${NC}
  ${D}Type naturally to manage emails, calendar, tasks, GitHub, Notion, Slack.${NC}
  ${D}Commands: /tasks /plan /clear /help /quit${NC}
`);

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

  const history = loadChatHistory();
  if (history.length > 0) {
    ok(`Loaded ${Math.floor(history.length / 2)} previous conversation turns from memory.`);
  }
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
      const handled = await handleSlashCommand(input, config, history);
      if (handled) {
        rl.prompt();
        continue;
      }
    }

    try {
      const userMessage = serializeHistory(history, input);

      process.stdout.write(`\n  ${D}Thinking...${NC}`);
      const response = await callLLM(config, systemPrompt, userMessage);
      process.stdout.write('\r' + ' '.repeat(40) + '\r');

      const { textParts, actions } = parseActions(response);

      if (textParts.length > 0) {
        const text = textParts.join('\n\n');
        console.log(`\n  ${W}${text}${NC}\n`);
      }

      for (const { action, params } of actions) {
        const isDestructive = DESTRUCTIVE_ACTIONS.has(action);

        if (isDestructive) {
          const desc = describeAction(action, params);
          const confirmed = await askConfirmation(rl, desc);

          if (!confirmed) {
            console.log(`  ${D}Cancelled.${NC}\n`);
            history.push({ role: 'user', content: input });
            history.push({ role: 'assistant', content: response + '\n[User cancelled this action]' });
            continue;
          }
        }

        try {
          process.stdout.write(`  ${D}Executing ${action}...${NC}`);
          const result = await executeTool(action, params, config);
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
          console.log(`  ${G}Result:${NC}\n  ${result.split('\n').join('\n  ')}\n`);

          history.push({ role: 'user', content: input });
          history.push({
            role: 'assistant',
            content: response + `\n\n[Tool ${action} executed. Result: ${result}]`,
          });
        } catch (err) {
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
          console.log(`  ${R}Error executing ${action}: ${err.message}${NC}\n`);
          history.push({ role: 'user', content: input });
          history.push({
            role: 'assistant',
            content: response + `\n\n[Tool ${action} failed: ${err.message}]`,
          });
        }
      }

      if (actions.length === 0) {
        history.push({ role: 'user', content: input });
        history.push({ role: 'assistant', content: response });
      }

      while (history.length > MAX_HISTORY * 2) {
        history.shift();
        history.shift();
      }

      try { saveChatHistory(history); } catch { /* non-critical */ }
      try { extractMemory('chat', input, response); } catch { /* non-critical */ }
    } catch (err) {
      process.stdout.write('\r' + ' '.repeat(40) + '\r');
      console.log(`\n  ${R}LLM error: ${err.message}${NC}\n`);
    }

    rl.prompt();
  }
}
