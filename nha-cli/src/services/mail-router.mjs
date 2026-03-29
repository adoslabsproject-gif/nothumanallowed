/**
 * Unified Mail + Calendar router — routes to Google or Microsoft based on auth state.
 *
 * Detects which provider is authenticated and routes all mail/calendar calls
 * through the appropriate service. If both are authenticated, prefers the
 * provider specified in config, falling back to the first authenticated one.
 *
 * All functions return the same unified data shapes defined by google-gmail.mjs
 * and google-calendar.mjs parsers (Microsoft services normalize to the same shape).
 *
 * Zero dependencies — pure routing layer.
 */

import { getAuthenticatedProviders, loadTokens } from './token-store.mjs';

// Lazy imports to avoid loading both provider modules at startup
let _google = null;
let _microsoft = null;
let _googleCal = null;
let _microsoftCal = null;

async function getGoogleMail() {
  if (!_google) _google = await import('./google-gmail.mjs');
  return _google;
}

async function getMicrosoftMail() {
  if (!_microsoft) _microsoft = await import('./microsoft-mail.mjs');
  return _microsoft;
}

async function getGoogleCalendar() {
  if (!_googleCal) _googleCal = await import('./google-calendar.mjs');
  return _googleCal;
}

async function getMicrosoftCalendar() {
  if (!_microsoftCal) _microsoftCal = await import('./microsoft-calendar.mjs');
  return _microsoftCal;
}

/**
 * Determine which mail provider to use.
 * @param {object} config — NHA config
 * @returns {'google' | 'microsoft' | null}
 */
export function detectMailProvider(config) {
  const providers = getAuthenticatedProviders();

  // If a preferred provider is set in config and authenticated, use it
  const preferred = config.ops?.mailProvider;
  if (preferred && providers[preferred]) return preferred;

  // Otherwise, use whichever is authenticated (Google first for backward compat)
  if (providers.google) return 'google';
  if (providers.microsoft) return 'microsoft';

  return null;
}

/**
 * Check if any mail provider is authenticated.
 */
export function hasMailProvider() {
  const providers = getAuthenticatedProviders();
  return providers.google || providers.microsoft;
}

/**
 * Get authentication status for display purposes.
 */
export function getProviderStatus() {
  const providers = getAuthenticatedProviders();
  const result = [];

  if (providers.google) {
    const tokens = loadTokens('google');
    result.push({ provider: 'google', email: tokens?.email || 'unknown', active: true });
  }
  if (providers.microsoft) {
    const tokens = loadTokens('microsoft');
    result.push({ provider: 'microsoft', email: tokens?.email || 'unknown', active: true });
  }

  return result;
}

// ── Mail Functions ─────────────────────────────────────────────────────────

/**
 * List messages matching a query.
 */
export async function listMessages(config, query = '', maxResults = 20) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated. Run: nha google auth OR nha microsoft auth');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftMail();
    return ms.listMessages(config, query, maxResults);
  }

  const gm = await getGoogleMail();
  return gm.listMessages(config, query || 'is:unread', maxResults);
}

/**
 * Get a full message by ID.
 */
export async function getMessage(config, messageId) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftMail();
    return ms.getMessage(config, messageId);
  }

  const gm = await getGoogleMail();
  return gm.getMessage(config, messageId);
}

/**
 * Get unread important emails (for daily planner).
 */
export async function getUnreadImportant(config, maxResults = 30) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftMail();
    return ms.getUnreadImportant(config, maxResults);
  }

  const gm = await getGoogleMail();
  return gm.getUnreadImportant(config, maxResults);
}

/**
 * Get today's emails.
 */
export async function getTodayEmails(config, maxResults = 50) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftMail();
    return ms.getTodayEmails(config, maxResults);
  }

  const gm = await getGoogleMail();
  return gm.getTodayEmails(config, maxResults);
}

/**
 * Send an email.
 */
export async function sendEmail(config, to, subject, body, opts = {}) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftMail();
    return ms.sendEmail(config, to, subject, body, opts);
  }

  const gm = await getGoogleMail();
  return gm.sendEmail(config, to, subject, body, opts);
}

/**
 * Create a draft email.
 */
export async function createDraft(config, to, subject, body) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftMail();
    return ms.createDraft(config, to, subject, body);
  }

  const gm = await getGoogleMail();
  return gm.createDraft(config, to, subject, body);
}

/**
 * Get user's email profile.
 */
export async function getProfile(config) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftMail();
    return ms.getProfile(config);
  }

  const gm = await getGoogleMail();
  return gm.getProfile(config);
}

// ── Calendar Functions ────────────────────────────────────────────────────

/**
 * Get today's events from all calendars.
 */
export async function getTodayEvents(config) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftCalendar();
    return ms.getTodayEvents(config);
  }

  const gc = await getGoogleCalendar();
  return gc.getTodayEvents(config);
}

/**
 * Get upcoming events (next N hours).
 */
export async function getUpcomingEvents(config, hours = 2) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftCalendar();
    return ms.getUpcomingEvents(config, hours);
  }

  const gc = await getGoogleCalendar();
  return gc.getUpcomingEvents(config, hours);
}

/**
 * Get events for a specific date.
 */
export async function getEventsForDate(config, date) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftCalendar();
    return ms.getEventsForDate(config, date);
  }

  const gc = await getGoogleCalendar();
  return gc.getEventsForDate(config, date);
}

/**
 * Create a new calendar event.
 */
export async function createEvent(config, event, calendarId = 'primary') {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftCalendar();
    return ms.createEvent(config, event, calendarId);
  }

  const gc = await getGoogleCalendar();
  return gc.createEvent(config, event, calendarId);
}

/**
 * Update an existing calendar event.
 */
export async function updateEvent(config, calendarId, eventId, patch) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftCalendar();
    return ms.updateEvent(config, calendarId, eventId, patch);
  }

  const gc = await getGoogleCalendar();
  return gc.updateEvent(config, calendarId, eventId, patch);
}

/**
 * List events for a date range.
 */
export async function listEvents(config, calendarId = 'primary', timeMin, timeMax) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');

  if (provider === 'microsoft') {
    const ms = await getMicrosoftCalendar();
    return ms.listEvents(config, calendarId, timeMin, timeMax);
  }

  const gc = await getGoogleCalendar();
  return gc.listEvents(config, calendarId, timeMin, timeMax);
}

/**
 * Mark a message as read.
 */
export async function markAsRead(config, messageId) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');
  const gm = await getGoogleMail();
  return gm.markAsRead(config, messageId);
}

/**
 * Mark a message as unread.
 */
export async function markAsUnread(config, messageId) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');
  const gm = await getGoogleMail();
  return gm.markAsUnread(config, messageId);
}

/**
 * Archive a message.
 */
export async function archiveMessage(config, messageId) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');
  const gm = await getGoogleMail();
  return gm.archiveMessage(config, messageId);
}

/**
 * Mark ALL unread messages as read.
 */
export async function markAllAsRead(config) {
  const provider = detectMailProvider(config);
  if (!provider) throw new Error('No mail provider authenticated.');
  const gm = await getGoogleMail();
  return gm.markAllAsRead(config);
}
