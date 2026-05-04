/**
 * Outlook Calendar API wrapper via Microsoft Graph — zero dependencies.
 * All calls via native fetch to Microsoft Graph REST API.
 *
 * Output format matches google-calendar.mjs parsed shape for unified consumption.
 */

import fs from 'fs';
import path from 'path';
import { getMicrosoftAccessToken } from './microsoft-oauth.mjs';
import { NHA_DIR } from '../constants.mjs';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me';
const CAL_DIR = path.join(NHA_DIR, 'ops', 'calendar');

/** Authenticated fetch with auto-retry on 401 */
async function graphFetch(config, urlPath, options = {}) {
  const token = await getMicrosoftAccessToken(config);
  const url = urlPath.startsWith('http') ? urlPath : `${GRAPH_BASE}${urlPath}`;

  let res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
      'Prefer': 'outlook.timezone="' + Intl.DateTimeFormat().resolvedOptions().timeZone + '"',
    },
  });

  if (res.status === 401) {
    const newToken = await getMicrosoftAccessToken(config);
    res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${newToken}`,
        'Prefer': 'outlook.timezone="' + Intl.DateTimeFormat().resolvedOptions().timeZone + '"',
      },
    });
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Microsoft Calendar API ${res.status}: ${err}`);
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
  const data = await graphFetch(config, '/calendars');
  return (data.value || []).map(c => ({
    id: c.id,
    summary: c.name,
    primary: c.isDefaultCalendar || false,
    timeZone: c.owner?.address ? undefined : undefined, // Graph doesn't expose per-calendar TZ the same way
    accessRole: c.canEdit ? 'writer' : 'reader',
  }));
}

/**
 * List events for a date range.
 * @param {object} config
 * @param {string} calendarId — calendar ID or 'primary' for default
 * @param {Date} timeMin
 * @param {Date} timeMax
 * @returns {Promise<Array>} parsed events
 */
export async function listEvents(config, calendarId = 'primary', timeMin, timeMax) {
  const calPath = calendarId === 'primary'
    ? '/calendar/calendarView'
    : `/calendars/${calendarId}/calendarView`;

  const params = new URLSearchParams({
    startDateTime: timeMin.toISOString(),
    endDateTime: timeMax.toISOString(),
    '$top': '50',
    '$orderby': 'start/dateTime',
    '$select': 'id,subject,body,location,start,end,isAllDay,attendees,organizer,onlineMeeting,webLink,showAs,responseStatus',
  });

  const data = await graphFetch(config, `${calPath}?${params}`);
  const events = (data.value || []).map(parseEvent);

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
    try {
      const events = await listEvents(config, cal.id, startOfDay, endOfDay);
      for (const e of events) {
        e.calendarName = cal.summary;
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
  return listEvents(config, 'primary', startOfDay, endOfDay);
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

  const startStr = String(event.start);
  const endStr = String(event.end);

  // Normalize datetime — Microsoft Graph expects ISO format or { dateTime, timeZone }
  const startDT = (startStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(startStr))
    ? new Date(startStr).toISOString().replace('Z', '')
    : startStr;
  const endDT = (endStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(endStr))
    ? new Date(endStr).toISOString().replace('Z', '')
    : endStr;

  const body = {
    subject: event.summary,
    body: {
      contentType: 'Text',
      content: event.description || '',
    },
    start: { dateTime: startDT, timeZone: tz },
    end: { dateTime: endDT, timeZone: tz },
  };

  if (event.location) {
    body.location = { displayName: event.location };
  }

  if (event.attendees?.length) {
    body.attendees = event.attendees.map(email => ({
      emailAddress: { address: email },
      type: 'required',
    }));
  }

  const calPath = calendarId === 'primary'
    ? '/calendar/events'
    : `/calendars/${calendarId}/events`;

  return graphFetch(config, calPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Update an existing event (partial).
 */
export async function updateEvent(config, calendarId, eventId, patch) {
  // Translate Google-style patch to Microsoft Graph format
  const body = {};

  if (patch.summary) body.subject = patch.summary;
  if (patch.description) body.body = { contentType: 'Text', content: patch.description };
  if (patch.location) body.location = { displayName: patch.location };

  if (patch.start) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof patch.start === 'object' && patch.start.dateTime) {
      body.start = { dateTime: patch.start.dateTime.replace('Z', ''), timeZone: tz };
    } else {
      body.start = { dateTime: new Date(patch.start).toISOString().replace('Z', ''), timeZone: tz };
    }
  }

  if (patch.end) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof patch.end === 'object' && patch.end.dateTime) {
      body.end = { dateTime: patch.end.dateTime.replace('Z', ''), timeZone: tz };
    } else {
      body.end = { dateTime: new Date(patch.end).toISOString().replace('Z', ''), timeZone: tz };
    }
  }

  const calPath = calendarId === 'primary'
    ? `/calendar/events/${eventId}`
    : `/calendars/${calendarId}/events/${eventId}`;

  return graphFetch(config, calPath, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function deleteEvent(config, calendarId, eventId) {
  const calPath = calendarId === 'primary'
    ? `/calendar/events/${eventId}`
    : `/calendars/${calendarId}/events/${eventId}`;
  await graphFetch(config, calPath, { method: 'DELETE' });
}

// ── Event Parser ───────────────────────────────────────────────────────────

/**
 * Parse Microsoft Graph event to unified format matching Google Calendar output.
 */
function parseEvent(raw) {
  const isAllDay = raw.isAllDay || false;

  // Microsoft returns { dateTime, timeZone } objects for start/end
  let start = '';
  let end = '';

  if (isAllDay) {
    // All-day events: use date portion only (YYYY-MM-DD)
    start = raw.start?.dateTime?.split('T')[0] || '';
    end = raw.end?.dateTime?.split('T')[0] || '';
  } else {
    // Timed events: use full ISO datetime
    start = raw.start?.dateTime || '';
    end = raw.end?.dateTime || '';
  }

  // Build online meeting link (Teams or other)
  const meetingLink = raw.onlineMeeting?.joinUrl || '';

  return {
    id: raw.id,
    summary: raw.subject || '(no title)',
    description: raw.body?.content
      ? raw.body.content
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2000)
      : '',
    location: raw.location?.displayName || '',
    start,
    end,
    isAllDay,
    status: raw.showAs || 'busy',
    attendees: (raw.attendees || []).map(a => ({
      email: a.emailAddress?.address || '',
      name: a.emailAddress?.name || '',
      responseStatus: mapResponseStatus(a.status?.response),
      self: false,
    })),
    organizer: raw.organizer?.emailAddress?.address || '',
    hangoutLink: meetingLink, // unified field for any online meeting link
    htmlLink: raw.webLink || '',
    calendarName: '',
    provider: 'microsoft',
  };
}

/**
 * Map Microsoft response status to Google-compatible values.
 */
function mapResponseStatus(msStatus) {
  const map = {
    none: 'needsAction',
    organizer: 'accepted',
    tentativelyAccepted: 'tentative',
    accepted: 'accepted',
    declined: 'declined',
    notResponded: 'needsAction',
  };
  return map[msStatus] || 'needsAction';
}

// ── Local Cache ────────────────────────────────────────────────────────────

function cacheEvents(date, events) {
  fs.mkdirSync(CAL_DIR, { recursive: true });
  const dateStr = date instanceof Date ? date.toISOString().split('T')[0] : String(date);
  const file = path.join(CAL_DIR, `ms-events-${dateStr}.json`);
  fs.writeFileSync(file, JSON.stringify(events, null, 2), { mode: 0o600 });
}

/**
 * Load cached events for a date.
 */
export function loadCachedEvents(date) {
  const dateStr = date instanceof Date ? date.toISOString().split('T')[0] : String(date);
  const file = path.join(CAL_DIR, `ms-events-${dateStr}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}
