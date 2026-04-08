/**
 * Local notes service — JSON files stored at ~/.nha/notes/.
 * Zero dependencies — uses Node.js native fs, path, crypto.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { NHA_DIR } from '../constants.mjs';

const NOTES_DIR = path.join(NHA_DIR, 'notes');

/** Ensure notes directory exists */
function ensureDir() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
}

/**
 * List all notes sorted by updatedAt descending.
 * @returns {Array<{id: string, title: string, content: string, tags: string[], createdAt: string, updatedAt: string}>}
 */
export function listNotes() {
  ensureDir();

  const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.json'));
  const notes = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(NOTES_DIR, file), 'utf-8');
      notes.push(JSON.parse(raw));
    } catch {
      // skip corrupted files
    }
  }

  notes.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return notes;
}

/**
 * Get a single note by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getNote(id) {
  ensureDir();
  const filePath = path.join(NOTES_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Create a new note.
 * @param {string} title
 * @param {string} content
 * @param {string[]} tags
 * @returns {object} the created note
 */
export function createNote(title, content, tags = []) {
  ensureDir();

  const now = new Date().toISOString();
  const note = {
    id: crypto.randomUUID(),
    title: title || '',
    content: content || '',
    tags: Array.isArray(tags) ? tags : [],
    createdAt: now,
    updatedAt: now,
  };

  const filePath = path.join(NOTES_DIR, `${note.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(note, null, 2), { mode: 0o600 });
  return note;
}

/**
 * Update an existing note.
 * @param {string} id
 * @param {string} title
 * @param {string} content
 * @param {string[]} tags
 * @returns {object|null} updated note, or null if not found
 */
export function updateNote(id, title, content, tags) {
  const existing = getNote(id);
  if (!existing) return null;

  const updated = {
    ...existing,
    title: title !== undefined ? title : existing.title,
    content: content !== undefined ? content : existing.content,
    tags: tags !== undefined ? (Array.isArray(tags) ? tags : existing.tags) : existing.tags,
    updatedAt: new Date().toISOString(),
  };

  const filePath = path.join(NOTES_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), { mode: 0o600 });
  return updated;
}

/**
 * Delete a note by ID.
 * @param {string} id
 * @returns {boolean} true if deleted, false if not found
 */
export function deleteNote(id) {
  const filePath = path.join(NOTES_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return false;

  fs.rmSync(filePath);
  return true;
}

/**
 * Search notes by title or content (case-insensitive substring match).
 * @param {string} query
 * @returns {Array<object>} matching notes sorted by updatedAt desc
 */
export function searchNotes(query) {
  if (!query) return listNotes();

  const term = query.toLowerCase();
  return listNotes().filter(note =>
    note.title.toLowerCase().includes(term) ||
    note.content.toLowerCase().includes(term),
  );
}
