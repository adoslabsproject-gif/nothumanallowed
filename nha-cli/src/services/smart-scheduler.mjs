/**
 * Smart Scheduler — finds optimal meeting slots considering existing calendar
 * events, locations, and travel time estimates.
 *
 * Zero dependencies. Uses Google Calendar / Outlook data already fetched
 * via mail-router.mjs.
 *
 * Travel time estimation:
 * - Same city: 30 min buffer
 * - Different city (< 200km): 90 min buffer
 * - Different city (> 200km): 180 min buffer
 * - Remote/virtual (no location): 15 min buffer
 * - No location on both: 0 min buffer
 */

import { listEvents } from './mail-router.mjs';

// ── Travel Time Estimation ──────────────────────────────────────────────────

/**
 * Well-known Italian cities with approximate lat/lon for distance estimation.
 * Covers the major cities. Falls back to "different city" for unknown locations.
 */
const CITY_COORDS = {
  'milano': { lat: 45.46, lon: 9.19 },
  'milan': { lat: 45.46, lon: 9.19 },
  'roma': { lat: 41.90, lon: 12.50 },
  'rome': { lat: 41.90, lon: 12.50 },
  'napoli': { lat: 40.85, lon: 14.27 },
  'naples': { lat: 40.85, lon: 14.27 },
  'torino': { lat: 45.07, lon: 7.69 },
  'turin': { lat: 45.07, lon: 7.69 },
  'firenze': { lat: 43.77, lon: 11.25 },
  'florence': { lat: 43.77, lon: 11.25 },
  'bologna': { lat: 44.49, lon: 11.34 },
  'genova': { lat: 44.41, lon: 8.93 },
  'genoa': { lat: 44.41, lon: 8.93 },
  'venezia': { lat: 45.44, lon: 12.32 },
  'venice': { lat: 45.44, lon: 12.32 },
  'verona': { lat: 45.44, lon: 10.99 },
  'padova': { lat: 45.41, lon: 11.88 },
  'trieste': { lat: 45.65, lon: 13.78 },
  'brescia': { lat: 45.54, lon: 10.21 },
  'parma': { lat: 44.80, lon: 10.33 },
  'modena': { lat: 44.65, lon: 10.93 },
  'reggio emilia': { lat: 44.70, lon: 10.63 },
  'reggio': { lat: 44.70, lon: 10.63 },
  'piacenza': { lat: 45.05, lon: 9.69 },
  'ferrara': { lat: 44.84, lon: 11.62 },
  'ravenna': { lat: 44.42, lon: 12.20 },
  'rimini': { lat: 44.06, lon: 12.57 },
  'perugia': { lat: 43.11, lon: 12.39 },
  'bari': { lat: 41.13, lon: 16.87 },
  'catania': { lat: 37.50, lon: 15.09 },
  'palermo': { lat: 38.12, lon: 13.36 },
  'cagliari': { lat: 39.22, lon: 9.12 },
  'bergamo': { lat: 45.69, lon: 9.67 },
  'como': { lat: 45.81, lon: 9.08 },
  'monza': { lat: 45.58, lon: 9.27 },
  'vicenza': { lat: 45.55, lon: 11.55 },
  'treviso': { lat: 45.67, lon: 12.24 },
  'udine': { lat: 46.07, lon: 13.24 },
  'ancona': { lat: 43.62, lon: 13.52 },
  'pescara': { lat: 42.46, lon: 14.21 },
  'lecce': { lat: 40.35, lon: 18.17 },
  'salerno': { lat: 40.68, lon: 14.77 },
  'sassari': { lat: 40.73, lon: 8.56 },
  'trento': { lat: 46.07, lon: 11.12 },
  'bolzano': { lat: 46.50, lon: 11.35 },
  'aosta': { lat: 45.74, lon: 7.32 },
  'london': { lat: 51.51, lon: -0.13 },
  'paris': { lat: 48.86, lon: 2.35 },
  'berlin': { lat: 52.52, lon: 13.41 },
  'amsterdam': { lat: 52.37, lon: 4.90 },
  'zurich': { lat: 47.38, lon: 8.54 },
  'munich': { lat: 48.14, lon: 11.58 },
  'vienna': { lat: 48.21, lon: 16.37 },
  'barcelona': { lat: 41.39, lon: 2.17 },
  'madrid': { lat: 40.42, lon: -3.70 },
  'lisbon': { lat: 38.72, lon: -9.14 },
  'new york': { lat: 40.71, lon: -74.01 },
  'san francisco': { lat: 37.77, lon: -122.42 },
};

const VIRTUAL_KEYWORDS = [
  'zoom', 'meet', 'teams', 'webex', 'hangout', 'remote', 'online',
  'virtual', 'call', 'video', 'teleconferenza', 'videocall',
  'google meet', 'skype', 'slack huddle',
];

/**
 * Extract city name from a location string.
 * @param {string} location
 * @returns {string|null}
 */
function extractCity(location) {
  if (!location) return null;
  const lower = location.toLowerCase();

  // Check for virtual meeting
  for (const kw of VIRTUAL_KEYWORDS) {
    if (lower.includes(kw)) return '__virtual__';
  }

  // Try to find a known city in the location string
  for (const [city] of Object.entries(CITY_COORDS)) {
    if (lower.includes(city)) return city;
  }

  // Try comma-separated parts (e.g., "Via Roma 123, Milano, MI")
  const parts = location.split(',').map(p => p.trim().toLowerCase());
  for (const part of parts) {
    for (const [city] of Object.entries(CITY_COORDS)) {
      if (part === city || part.startsWith(city + ' ') || part.endsWith(' ' + city)) {
        return city;
      }
    }
  }

  // Unknown location — treat as physical but unknown city
  return '__unknown__';
}

/**
 * Haversine distance between two lat/lon points in km.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Estimate travel time in minutes between two locations.
 * @param {string} fromLocation
 * @param {string} toLocation
 * @returns {{ minutes: number, label: string }}
 */
export function estimateTravelTime(fromLocation, toLocation) {
  const fromCity = extractCity(fromLocation);
  const toCity = extractCity(toLocation);

  // No location on either side — no buffer needed
  if (!fromCity && !toCity) return { minutes: 0, label: 'no travel' };

  // Virtual meetings — minimal buffer
  if (fromCity === '__virtual__' || toCity === '__virtual__') {
    return { minutes: 15, label: '15 min buffer (virtual)' };
  }

  // One side has no location — assume 30 min buffer
  if (!fromCity || !toCity || fromCity === '__unknown__' || toCity === '__unknown__') {
    return { minutes: 30, label: '30 min buffer (location unknown)' };
  }

  // Same city
  if (fromCity === toCity) {
    return { minutes: 30, label: `30 min (same city: ${fromCity})` };
  }

  // Different known cities — calculate distance
  const fromCoords = CITY_COORDS[fromCity];
  const toCoords = CITY_COORDS[toCity];

  if (fromCoords && toCoords) {
    const km = haversineKm(fromCoords.lat, fromCoords.lon, toCoords.lat, toCoords.lon);

    if (km < 50) return { minutes: 45, label: `45 min (~${Math.round(km)}km: ${fromCity} → ${toCity})` };
    if (km < 150) return { minutes: 90, label: `90 min (~${Math.round(km)}km: ${fromCity} → ${toCity})` };
    if (km < 400) return { minutes: 150, label: `2.5h (~${Math.round(km)}km: ${fromCity} → ${toCity})` };
    return { minutes: 240, label: `4h+ (~${Math.round(km)}km: ${fromCity} → ${toCity}) — consider video call` };
  }

  // Fallback: different city, unknown distance
  return { minutes: 90, label: `90 min (${fromCity} → ${toCity})` };
}

// ── Slot Finder ─────────────────────────────────────────────────────────────

/**
 * Find available meeting slots in a date range, considering travel time.
 *
 * @param {object} config — NHA config (for calendar API access)
 * @param {object} params
 * @param {string} params.meetingLocation — where the new meeting will be
 * @param {number} params.durationMinutes — meeting duration
 * @param {string} params.dateFrom — YYYY-MM-DD start of search range
 * @param {string} params.dateTo — YYYY-MM-DD end of search range
 * @param {number} [params.workdayStart=9] — earliest hour (0-23)
 * @param {number} [params.workdayEnd=18] — latest hour (0-23)
 * @param {number} [params.maxSlots=5] — max slots to return
 * @returns {Promise<Array<{start: string, end: string, date: string, day: string, travelBefore: object, travelAfter: object, score: number}>>}
 */
export async function findAvailableSlots(config, params) {
  const {
    meetingLocation = '',
    durationMinutes = 60,
    dateFrom,
    dateTo,
    workdayStart = 9,
    workdayEnd = 18,
    maxSlots = 5,
  } = params;

  // Fetch all events in the date range
  const from = new Date(dateFrom + 'T00:00:00');
  const to = new Date(dateTo + 'T23:59:59');
  const events = await listEvents(config, 'primary', from, to);

  // Group events by date
  const eventsByDate = new Map();
  for (const event of events) {
    if (event.isAllDay) continue; // skip all-day events
    const dateKey = event.start.split('T')[0];
    if (!eventsByDate.has(dateKey)) eventsByDate.set(dateKey, []);
    eventsByDate.get(dateKey).push(event);
  }

  const slots = [];
  const durationMs = durationMinutes * 60000;

  // Iterate each day in range
  const current = new Date(from);
  while (current <= to && slots.length < maxSlots * 2) {
    const dayOfWeek = current.getDay();
    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      current.setDate(current.getDate() + 1);
      continue;
    }

    const dateKey = current.toISOString().split('T')[0];
    const dayName = current.toLocaleDateString('en-US', { weekday: 'long' });
    const dayEvents = (eventsByDate.get(dateKey) || [])
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    // Build busy blocks with travel buffers
    const busyBlocks = [];
    for (const event of dayEvents) {
      const eventStart = new Date(event.start).getTime();
      const eventEnd = new Date(event.end).getTime();

      // Travel time FROM previous location TO this event
      const travelTo = estimateTravelTime(meetingLocation, event.location);
      // Travel time FROM this event TO meeting location
      const travelFrom = estimateTravelTime(event.location, meetingLocation);

      busyBlocks.push({
        start: eventStart - travelTo.minutes * 60000, // need to arrive before
        end: eventEnd + travelFrom.minutes * 60000,   // need travel time after
        eventStart,
        eventEnd,
        summary: event.summary,
        location: event.location,
        travelTo,
        travelFrom,
      });
    }

    // Find free windows in the workday
    const workStart = new Date(dateKey + `T${String(workdayStart).padStart(2, '0')}:00:00`).getTime();
    const workEnd = new Date(dateKey + `T${String(workdayEnd).padStart(2, '0')}:00:00`).getTime();

    // Merge overlapping busy blocks
    const merged = [];
    for (const block of busyBlocks.sort((a, b) => a.start - b.start)) {
      if (merged.length > 0 && block.start <= merged[merged.length - 1].end) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, block.end);
      } else {
        merged.push({ ...block });
      }
    }

    // Find gaps
    let cursor = workStart;
    for (const block of merged) {
      if (block.start > cursor) {
        const gapDuration = block.start - cursor;
        if (gapDuration >= durationMs) {
          // Find the event BEFORE this gap (for travel info)
          const prevEvent = dayEvents.find(e => new Date(e.end).getTime() <= cursor + 60000);
          const nextEvent = dayEvents.find(e => new Date(e.start).getTime() >= block.eventStart - 60000);

          const travelBefore = prevEvent
            ? { ...estimateTravelTime(prevEvent.location, meetingLocation), fromLocation: prevEvent.location }
            : { minutes: 0, label: 'no previous event', fromLocation: '' };
          const travelAfter = nextEvent
            ? { ...estimateTravelTime(meetingLocation, nextEvent.location), toLocation: nextEvent.location }
            : { minutes: 0, label: 'no next event', toLocation: '' };

          const slotStart = new Date(cursor + travelBefore.minutes * 60000);
          const slotEnd = new Date(slotStart.getTime() + durationMs);

          // Make sure slot fits before the next busy block
          if (slotEnd.getTime() + travelAfter.minutes * 60000 <= block.start) {
            // Score: prefer morning, prefer no travel, prefer earlier in the week
            const hour = slotStart.getHours();
            const hourScore = hour >= 9 && hour <= 11 ? 10 : hour >= 14 && hour <= 16 ? 8 : 5;
            const travelScore = Math.max(0, 10 - (travelBefore.minutes + travelAfter.minutes) / 15);
            const score = hourScore + travelScore;

            slots.push({
              start: slotStart.toISOString(),
              end: slotEnd.toISOString(),
              date: dateKey,
              day: dayName,
              startTime: slotStart.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
              endTime: slotEnd.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
              travelBefore,
              travelAfter,
              score,
            });
          }
        }
      }
      cursor = Math.max(cursor, block.end);
    }

    // Check gap after last event
    if (cursor < workEnd) {
      const gapDuration = workEnd - cursor;
      if (gapDuration >= durationMs) {
        const lastEvent = dayEvents[dayEvents.length - 1];
        const travelBefore = lastEvent
          ? { ...estimateTravelTime(lastEvent.location, meetingLocation), fromLocation: lastEvent.location }
          : { minutes: 0, label: 'no previous event', fromLocation: '' };

        const slotStart = new Date(cursor + travelBefore.minutes * 60000);
        const slotEnd = new Date(slotStart.getTime() + durationMs);

        if (slotEnd.getTime() <= workEnd) {
          const hour = slotStart.getHours();
          const hourScore = hour >= 9 && hour <= 11 ? 10 : hour >= 14 && hour <= 16 ? 8 : 5;
          const travelScore = Math.max(0, 10 - travelBefore.minutes / 15);

          slots.push({
            start: slotStart.toISOString(),
            end: slotEnd.toISOString(),
            date: dateKey,
            day: dayName,
            startTime: slotStart.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
            endTime: slotEnd.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
            travelBefore,
            travelAfter: { minutes: 0, label: 'end of day' },
            score: hourScore + travelScore,
          });
        }
      }
    }

    current.setDate(current.getDate() + 1);
  }

  // Sort by score (highest first), take top N
  slots.sort((a, b) => b.score - a.score);
  return slots.slice(0, maxSlots);
}

/**
 * Generate a Google Maps directions link between two locations.
 * Free — just opens the browser, no API key needed.
 *
 * @param {string} from — origin location/city
 * @param {string} to — destination location/city
 * @returns {string} Google Maps URL
 */
export function getMapsLink(from, to) {
  if (!from || !to) return '';
  const origin = encodeURIComponent(from);
  const dest = encodeURIComponent(to);
  return `https://www.google.com/maps/dir/${origin}/${dest}`;
}

/**
 * Format slots into a human-readable proposal string.
 * Includes Google Maps links for travel between locations.
 */
export function formatSlotProposal(slots, clientName, meetingSubject, meetingLocation) {
  if (slots.length === 0) {
    return 'No available slots found in the requested date range. Try expanding the range or shortening the meeting duration.';
  }

  const lines = [`Found ${slots.length} optimal slot${slots.length > 1 ? 's' : ''} for "${meetingSubject}" with ${clientName}:\n`];

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    lines.push(`${i + 1}. ${s.day} ${s.date} — ${s.startTime} to ${s.endTime}`);
    if (s.travelBefore.minutes > 0) {
      lines.push(`   Travel before: ${s.travelBefore.label}`);
      // Add Maps link if we have a previous location and the meeting location
      if (s.travelBefore.fromLocation && meetingLocation) {
        lines.push(`   Route: ${getMapsLink(s.travelBefore.fromLocation, meetingLocation)}`);
      }
    }
    if (s.travelAfter.minutes > 0) {
      lines.push(`   Travel after: ${s.travelAfter.label}`);
      if (meetingLocation && s.travelAfter.toLocation) {
        lines.push(`   Route: ${getMapsLink(meetingLocation, s.travelAfter.toLocation)}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Generate a professional email/message proposing slots to a client.
 */
export function generateSlotMessage(slots, clientName, meetingSubject, senderName) {
  if (slots.length === 0) return '';

  const slotLines = slots.slice(0, 3).map((s, i) => {
    return `  ${i + 1}. ${s.day} ${s.date}, ${s.startTime} - ${s.endTime}`;
  });

  return `Gentile ${clientName},

Le scrivo per fissare un incontro riguardo "${meetingSubject}".

In base alla mia disponibilità, Le propongo le seguenti opzioni:

${slotLines.join('\n')}

Mi faccia sapere quale opzione Le è più comoda, o se preferisce suggerire un orario alternativo.

Cordiali saluti,
${senderName || 'Il team'}`;
}
