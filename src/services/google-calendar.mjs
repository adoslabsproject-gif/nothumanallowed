/**
 * Google Calendar API wrapper — zero dependencies.
 * All calls via native fetch to Calendar REST API.
 */

import fs from 'fs';
import path from 'path';
import { getAccessToken } from './token-store.mjs';
import { NHA_DIR } from '../constants.mjs';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const CAL_DIR = path.join(NHA_DIR, 'ops', 'calendar');

/** Authenticated fetch */
async function calFetch(config, urlPath, options = {}) {
  const token = await getAccessToken(config);
  const url = urlPath.startsWith('http') ? urlPath : `${CAL_BASE}${urlPath}`;

  let res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
    },
  });

  if (res.status === 401) {
    const newToken = await getAccessToken(config);
    res = await fetch(url, {
      ...options,
      headers: { ...options.headers, 'Authorization': `Bearer ${newToken}` },
    });
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Calendar API ${res.status}: ${err}`);
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') return {};
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * List all calendars the user has access to.
 */
export async function listCalendars(config) {
  const data = await calFetch(config, '/users/me/calendarList');
  return (data.items || []).map(c => ({
    id: c.id,
    summary: c.summary,
    primary: c.primary || false,
    timeZone: c.timeZone,
    accessRole: c.accessRole,
  }));
}

/**
 * List events for a date range.
 * @param {object} config
 * @param {string} calendarId — 'primary' or specific ID
 * @param {Date} timeMin
 * @param {Date} timeMax
 * @returns {Promise<Array>} parsed events
 */
export async function listEvents(config, calendarId = 'primary', timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

  const data = await calFetch(config, `/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
  const events = (data.items || []).map(raw => {
    const e = parseEvent(raw);
    e.calendarId = calendarId; // propagate real calendarId
    return e;
  });

  // Cache events
  cacheEvents(timeMin, events);
  return events;
}

/**
 * Get today's events from all calendars.
 */
export async function getTodayEvents(config) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000);

  const calendars = await listCalendars(config);
  const allEvents = [];

  for (const cal of calendars) {
    if (cal.accessRole === 'freeBusyReader') continue; // skip minimal access
    try {
      const events = await listEvents(config, cal.id, startOfDay, endOfDay);
      for (const e of events) {
        e.calendarName = cal.summary;
        e.calendarId = cal.id; // ensure real calendarId is set
        allEvents.push(e);
      }
    } catch { /* skip failed calendars */ }
  }

  // Sort by start time
  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return allEvents;
}

/**
 * Get events for a specific date.
 */
export async function getEventsForDate(config, date) {
  const d = new Date(date);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000);

  // Load from all calendars so calendarId is always accurate
  const calendars = await listCalendars(config);
  const allEvents = [];
  for (const cal of calendars) {
    if (cal.accessRole === 'freeBusyReader') continue;
    try {
      const events = await listEvents(config, cal.id, startOfDay, endOfDay);
      for (const e of events) {
        e.calendarName = cal.summary;
        e.calendarId = cal.id;
        allEvents.push(e);
      }
    } catch { /* skip */ }
  }
  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return allEvents;
}

/**
 * Get upcoming events (next N hours).
 * @param {number} hours — look-ahead hours (default 2)
 */
export async function getUpcomingEvents(config, hours = 2) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 3600000);
  return listEvents(config, 'primary', now, end);
}

/**
 * Create a new event.
 * @param {object} config
 * @param {object} event — { summary, start, end, description, location, attendees }
 * @param {string} calendarId
 */
export async function createEvent(config, event, calendarId = 'primary') {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // If the date string has no Z or offset, treat as local time — don't convert to UTC
  const startStr = String(event.start);
  const endStr = String(event.end);
  const startDT = (startStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(startStr))
    ? new Date(startStr).toISOString()
    : startStr; // Keep as-is (local time for the timeZone)
  const endDT = (endStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(endStr))
    ? new Date(endStr).toISOString()
    : endStr;

  const body = {
    summary: event.summary,
    description: event.description || '',
    location: event.location || '',
    start: { dateTime: startDT, timeZone: tz },
    end: { dateTime: endDT, timeZone: tz },
  };

  if (event.attendees?.length) {
    body.attendees = event.attendees.map(email => ({ email }));
  }

  return calFetch(config, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Update an existing event (partial).
 */
export async function updateEvent(config, calendarId, eventId, patch) {
  return calFetch(config, `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteEvent(config, calendarId, eventId) {
  await calFetch(config, `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: 'DELETE',
  });
}

// ── Event Parser ───────────────────────────────────────────────────────────

function parseEvent(raw) {
  const isAllDay = !!raw.start?.date;
  return {
    id: raw.id,
    summary: raw.summary || '(no title)',
    description: raw.description || '',
    location: raw.location || '',
    start: isAllDay ? raw.start.date : raw.start?.dateTime || '',
    end: isAllDay ? raw.end.date : raw.end?.dateTime || '',
    isAllDay,
    status: raw.status || 'confirmed',
    attendees: (raw.attendees || []).map(a => ({
      email: a.email,
      name: a.displayName || '',
      responseStatus: a.responseStatus || 'needsAction',
      self: a.self || false,
    })),
    organizer: raw.organizer?.email || '',
    hangoutLink: raw.hangoutLink || '',
    htmlLink: raw.htmlLink || '',
    calendarName: '',
  };
}

// ── Local Cache ────────────────────────────────────────────────────────────

function cacheEvents(date, events) {
  fs.mkdirSync(CAL_DIR, { recursive: true });
  const dateStr = date instanceof Date ? date.toISOString().split('T')[0] : String(date);
  const file = path.join(CAL_DIR, `events-${dateStr}.json`);
  fs.writeFileSync(file, JSON.stringify(events, null, 2), { mode: 0o600 });
}

/**
 * Load cached events for a date.
 */
export function loadCachedEvents(date) {
  const dateStr = date instanceof Date ? date.toISOString().split('T')[0] : String(date);
  const file = path.join(CAL_DIR, `events-${dateStr}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}
