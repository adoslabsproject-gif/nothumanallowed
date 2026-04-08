/** nha tasks — Local task management */

import { getTasks, addTask, completeTask, editTask, moveTask, getWeekTasks, getDayStats } from '../services/task-store.mjs';
import { fail, info, ok, C, G, Y, D, W, BOLD, NC, R } from '../ui.mjs';

export async function cmdTasks(args) {
  const sub = args[0];

  // nha tasks (list today)
  if (!sub || sub === 'list' || sub === 'today') {
    const date = args[1] || undefined;
    return showTasks(date);
  }

  // nha tasks add "description" [--priority high] [--due 14:00]
  if (sub === 'add') {
    const parts = args.slice(1);
    let description = '';
    let priority = 'medium';
    let due = null;

    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '--priority' && parts[i + 1]) { priority = parts[++i]; continue; }
      if (parts[i] === '--due' && parts[i + 1]) { due = parts[++i]; continue; }
      if (parts[i] === '-p' && parts[i + 1]) { priority = parts[++i]; continue; }
      description += (description ? ' ' : '') + parts[i];
    }

    if (!description) {
      fail('Usage: nha tasks add "task description" [--priority high] [--due 14:00]');
      return;
    }

    const task = addTask({ description, priority, due });
    ok(`Task #${task.id} added: ${description}`);
    return;
  }

  // nha tasks done <id>
  if (sub === 'done' || sub === 'complete') {
    const id = parseInt(args[1]);
    if (!id) { fail('Usage: nha tasks done <task-id>'); return; }
    if (completeTask(id)) {
      ok(`Task #${id} completed`);
    } else {
      fail(`Task #${id} not found`);
    }
    return;
  }

  // nha tasks edit <id> "new description"
  if (sub === 'edit') {
    const id = parseInt(args[1]);
    const desc = args.slice(2).join(' ');
    if (!id || !desc) { fail('Usage: nha tasks edit <id> "new description"'); return; }
    if (editTask(id, desc)) {
      ok(`Task #${id} updated`);
    } else {
      fail(`Task #${id} not found`);
    }
    return;
  }

  // nha tasks move <id> tomorrow|YYYY-MM-DD
  if (sub === 'move') {
    const id = parseInt(args[1]);
    let toDate = args[2];
    if (!id || !toDate) { fail('Usage: nha tasks move <id> tomorrow'); return; }

    if (toDate === 'tomorrow') {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      toDate = d.toISOString().split('T')[0];
    }

    const today = new Date().toISOString().split('T')[0];
    if (moveTask(id, today, toDate)) {
      ok(`Task #${id} moved to ${toDate}`);
    } else {
      fail(`Task #${id} not found`);
    }
    return;
  }

  // nha tasks week
  if (sub === 'week') {
    const week = getWeekTasks();
    console.log(`\n  ${BOLD}Week Overview${NC}\n`);
    for (const day of week) {
      const stats = getDayStats(day.date);
      const isToday = day.date === new Date().toISOString().split('T')[0];
      const label = isToday ? `${BOLD}${day.day} ${day.date} (today)${NC}` : `${D}${day.day} ${day.date}${NC}`;
      console.log(`  ${label}  ${stats.total > 0 ? `${G}${stats.done}${NC}/${stats.total} done` : D + 'empty' + NC}`);
      for (const t of day.tasks.slice(0, 5)) {
        const icon = t.status === 'done' ? `${G}✓${NC}` : t.priority === 'high' || t.priority === 'critical' ? `${Y}●${NC}` : `${D}○${NC}`;
        console.log(`    ${icon} ${t.description}${t.due ? D + ' due ' + t.due + NC : ''}`);
      }
      if (day.tasks.length > 5) console.log(`    ${D}+${day.tasks.length - 5} more${NC}`);
    }
    console.log('');
    return;
  }

  fail(`Unknown: nha tasks ${sub}`);
  info('Commands: list, add, done, edit, move, week');
}

function showTasks(date) {
  const tasks = getTasks(date);
  const dateStr = date || new Date().toISOString().split('T')[0];
  const stats = getDayStats(date);

  console.log(`\n  ${BOLD}Tasks — ${dateStr}${NC}  ${D}(${stats.done}/${stats.total} done, ${stats.completionRate}%)${NC}\n`);

  if (tasks.length === 0) {
    info('No tasks for today. Add one: nha tasks add "your task"');
    console.log('');
    return;
  }

  for (const t of tasks) {
    const statusIcon = t.status === 'done' ? `${G}✓${NC}` : `${D}○${NC}`;
    const priorityBadge = t.priority === 'critical' ? `${R}[!!]${NC}` :
      t.priority === 'high' ? `${Y}[!]${NC}` : '';
    const dueStr = t.due ? ` ${D}due ${t.due}${NC}` : '';
    const sourceStr = t.source !== 'manual' ? ` ${D}(${t.source})${NC}` : '';
    const strikethrough = t.status === 'done' ? D : '';

    console.log(`  ${statusIcon} ${strikethrough}#${t.id} ${t.description}${NC} ${priorityBadge}${dueStr}${sourceStr}`);
  }
  console.log('');
}
