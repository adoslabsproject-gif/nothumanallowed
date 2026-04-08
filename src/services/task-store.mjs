/**
 * Local task management — JSON files per day at ~/.nha/ops/tasks/.
 * Zero dependencies.
 */

import fs from 'fs';
import path from 'path';
import { NHA_DIR } from '../constants.mjs';

const TASKS_DIR = path.join(NHA_DIR, 'ops', 'tasks');

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function taskFile(date) {
  return path.join(TASKS_DIR, `${date || todayStr()}.json`);
}

function loadDay(date) {
  const file = taskFile(date);
  if (!fs.existsSync(file)) return { tasks: [], version: 1 };
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return { tasks: [], version: 1 }; }
}

function saveDay(date, data) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(taskFile(date), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Get all tasks for a date.
 * @param {string} [date] — YYYY-MM-DD (default: today)
 * @returns {Array} tasks
 */
export function getTasks(date) {
  return loadDay(date).tasks;
}

/**
 * Add a new task.
 * @param {object} task — { description, priority?, due?, source?, sourceRef? }
 * @param {string} [date]
 * @returns {object} the created task
 */
export function addTask(task, date) {
  const data = loadDay(date);
  const id = data.tasks.length > 0 ? Math.max(...data.tasks.map(t => t.id)) + 1 : 1;
  const newTask = {
    id,
    description: task.description,
    priority: task.priority || 'medium',
    status: 'pending',
    due: task.due || null,
    source: task.source || 'manual',
    sourceRef: task.sourceRef || null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    estimatedMinutes: task.estimatedMinutes || null,
    suggestedSlot: task.suggestedSlot || null,
  };
  data.tasks.push(newTask);
  saveDay(date, data);
  return newTask;
}

/**
 * Mark a task as done.
 * @param {number} taskId
 * @param {string} [date]
 * @returns {boolean} success
 */
export function completeTask(taskId, date) {
  const data = loadDay(date);
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return false;
  task.status = 'done';
  task.completedAt = new Date().toISOString();
  saveDay(date, data);
  return true;
}

/**
 * Edit a task description.
 */
export function editTask(taskId, description, date) {
  const data = loadDay(date);
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return false;
  task.description = description;
  saveDay(date, data);
  return true;
}

/**
 * Move a task to another date.
 */
export function moveTask(taskId, fromDate, toDate) {
  const fromData = loadDay(fromDate);
  const idx = fromData.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return false;

  const [task] = fromData.tasks.splice(idx, 1);
  task.status = 'pending'; // reset status on move
  task.completedAt = null;
  saveDay(fromDate, fromData);

  const toData = loadDay(toDate);
  task.id = toData.tasks.length > 0 ? Math.max(...toData.tasks.map(t => t.id)) + 1 : 1;
  toData.tasks.push(task);
  saveDay(toDate, toData);
  return true;
}

/**
 * Delete a single task by ID.
 * @param {number} taskId
 * @param {string} [date]
 * @returns {boolean} success
 */
export function deleteTask(taskId, date) {
  const data = loadDay(date);
  const idx = data.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return false;
  data.tasks.splice(idx, 1);
  saveDay(date, data);
  return true;
}

/**
 * Clear all tasks for a date (delete completed, or all).
 * @param {'done'|'all'} mode — 'done' removes only completed, 'all' removes everything
 * @param {string} [date]
 * @returns {number} count of removed tasks
 */
export function clearTasks(mode = 'all', date) {
  const data = loadDay(date);
  const before = data.tasks.length;
  if (mode === 'done') {
    data.tasks = data.tasks.filter(t => t.status !== 'done');
  } else {
    data.tasks = [];
  }
  saveDay(date, data);
  return before - data.tasks.length;
}

/**
 * Edit task priority.
 * @param {number} taskId
 * @param {string} priority
 * @param {string} [date]
 * @returns {boolean}
 */
export function editTaskPriority(taskId, priority, date) {
  const data = loadDay(date);
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return false;
  task.priority = priority;
  saveDay(date, data);
  return true;
}

/**
 * Get tasks for the week (Mon-Sun).
 */
export function getWeekTasks() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));

  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const tasks = getTasks(dateStr);
    week.push({ date: dateStr, day: d.toLocaleDateString('en', { weekday: 'short' }), tasks });
  }
  return week;
}

/**
 * Bulk add tasks (from agent pipeline).
 * @param {Array<{description, priority, due, source, estimatedMinutes, suggestedSlot}>} tasks
 * @param {string} [date]
 */
export function bulkAddTasks(tasks, date) {
  for (const t of tasks) {
    addTask(t, date);
  }
}

/**
 * Get daily stats.
 */
export function getDayStats(date) {
  const tasks = getTasks(date);
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const pending = tasks.filter(t => t.status === 'pending').length;
  const high = tasks.filter(t => t.priority === 'high' || t.priority === 'critical').length;
  return { total, done, pending, high, completionRate: total > 0 ? Math.round(done / total * 100) : 0 };
}
