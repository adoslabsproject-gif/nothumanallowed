/**
 * Google People API (Contacts) wrapper — zero dependencies.
 * All calls via native fetch to People API v1.
 * Auto-refreshes tokens on 401.
 */

import { getAccessToken } from './token-store.mjs';

const PEOPLE_BASE = 'https://people.googleapis.com/v1';

const CONTACT_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,birthdays,addresses';
const CONTACT_FIELDS_FULL = 'names,emailAddresses,phoneNumbers,organizations,birthdays,addresses,biographies,urls';

/** Authenticated fetch with auto-retry on 401 */
async function peopleFetch(config, urlPath, options = {}) {
  const token = await getAccessToken(config);
  const url = urlPath.startsWith('http') ? urlPath : `${PEOPLE_BASE}${urlPath}`;

  let res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (res.status === 401) {
    const newToken = await getAccessToken(config);
    res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${newToken}`,
      },
    });
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`People API ${res.status}: ${err}`);
  }

  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * Search contacts by name or email.
 * @param {object} config
 * @param {string} query — search term (name, email, phone)
 * @param {number} maxResults
 * @returns {Promise<Array>}
 */
export async function searchContacts(config, query, maxResults = 10) {
  const params = new URLSearchParams({
    query,
    readMask: CONTACT_FIELDS,
    sources: 'READ_SOURCE_TYPE_CONTACT',
    pageSize: String(maxResults),
  });

  const data = await peopleFetch(config, `/people:searchContacts?${params}`);
  return (data.results || []).map(r => parseContact(r.person));
}

/**
 * List all contacts sorted by first name.
 * @param {object} config
 * @param {number} maxResults
 * @returns {Promise<Array>}
 */
export async function listContacts(config, maxResults = 50) {
  const params = new URLSearchParams({
    personFields: CONTACT_FIELDS,
    sortOrder: 'FIRST_NAME_ASCENDING',
    pageSize: String(Math.min(maxResults, 1000)),
  });

  const contacts = [];
  let pageToken = null;

  do {
    if (pageToken) params.set('pageToken', pageToken);
    const data = await peopleFetch(config, `/people/me/connections?${params}`);
    const connections = data.connections || [];
    contacts.push(...connections.map(parseContact));
    pageToken = data.nextPageToken || null;
  } while (pageToken && contacts.length < maxResults);

  return contacts.slice(0, maxResults);
}

/**
 * Get a single contact by resourceName (e.g. "people/c1234567890").
 * @param {object} config
 * @param {string} resourceName
 * @returns {Promise<object>}
 */
export async function getContact(config, resourceName) {
  const params = new URLSearchParams({
    personFields: CONTACT_FIELDS_FULL,
  });

  const name = resourceName.startsWith('people/') ? resourceName : `people/${resourceName}`;
  const data = await peopleFetch(config, `/${name}?${params}`);
  return parseContact(data);
}

/**
 * Get all contacts that have a birthday set.
 * @param {object} config
 * @returns {Promise<Array>}
 */
export async function getBirthdays(config) {
  const all = await listContacts(config, 1000);
  return all.filter(c => c.birthday);
}

/**
 * Create a new contact.
 */
export async function createContact(config, { name, email, phone, company, title, address }) {
  const body = { names: [], emailAddresses: [], phoneNumbers: [], organizations: [], addresses: [] };

  if (name) {
    const parts = name.split(' ');
    body.names.push({ givenName: parts[0], familyName: parts.slice(1).join(' ') || '' });
  }
  if (email) body.emailAddresses.push({ value: email });
  if (phone) body.phoneNumbers.push({ value: phone });
  if (company || title) body.organizations.push({ name: company || '', title: title || '' });
  if (address) body.addresses.push({ formattedValue: address });

  const data = await peopleFetch(config, '/people:createContact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseContact(data);
}

/**
 * Update an existing contact.
 */
export async function updateContact(config, resourceName, fields) {
  // First get the current contact to get etag
  const current = await peopleFetch(config, `/${resourceName}?personFields=names,emailAddresses,phoneNumbers,organizations,addresses`);

  const body = { etag: current.etag };
  const updateFields = [];

  if (fields.name !== undefined) {
    const parts = (fields.name || '').split(' ');
    body.names = [{ givenName: parts[0], familyName: parts.slice(1).join(' ') || '' }];
    updateFields.push('names');
  }
  if (fields.email !== undefined) {
    body.emailAddresses = [{ value: fields.email }];
    updateFields.push('emailAddresses');
  }
  if (fields.phone !== undefined) {
    body.phoneNumbers = [{ value: fields.phone }];
    updateFields.push('phoneNumbers');
  }
  if (fields.company !== undefined || fields.title !== undefined) {
    body.organizations = [{ name: fields.company || '', title: fields.title || '' }];
    updateFields.push('organizations');
  }
  if (fields.address !== undefined) {
    body.addresses = [{ formattedValue: fields.address }];
    updateFields.push('addresses');
  }

  const data = await peopleFetch(config, `/${resourceName}:updateContact?updatePersonFields=${updateFields.join(',')}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseContact(data);
}

/**
 * Delete a contact.
 */
export async function deleteContact(config, resourceName) {
  await peopleFetch(config, `/${resourceName}:deleteContact`, { method: 'DELETE' });
  return { ok: true };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function parseContact(raw) {
  if (!raw) return null;

  const names = raw.names || [];
  const primaryName = names.find(n => n.metadata?.primary) || names[0] || {};

  const emailAddresses = raw.emailAddresses || [];
  const primaryEmail = emailAddresses.find(e => e.metadata?.primary) || emailAddresses[0] || {};

  const phoneNumbers = raw.phoneNumbers || [];
  const primaryPhone = phoneNumbers.find(p => p.metadata?.primary) || phoneNumbers[0] || {};

  const organizations = raw.organizations || [];
  const primaryOrg = organizations.find(o => o.metadata?.primary) || organizations[0] || {};

  const birthdays = raw.birthdays || [];
  const primaryBirthday = birthdays.find(b => b.metadata?.primary) || birthdays[0];

  const addresses = raw.addresses || [];
  const primaryAddress = addresses.find(a => a.metadata?.primary) || addresses[0] || {};

  return {
    resourceName: raw.resourceName || '',
    name: primaryName.displayName || '',
    firstName: primaryName.givenName || '',
    lastName: primaryName.familyName || '',
    email: primaryEmail.value || '',
    emails: emailAddresses.map(e => e.value).filter(Boolean),
    phone: primaryPhone.value || '',
    phones: phoneNumbers.map(p => p.value).filter(Boolean),
    company: primaryOrg.name || '',
    title: primaryOrg.title || '',
    birthday: formatBirthday(primaryBirthday),
    address: formatAddress(primaryAddress),
  };
}

function formatBirthday(birthday) {
  if (!birthday?.date) return '';
  const { year, month, day } = birthday.date;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  if (year) return `${year}-${mm}-${dd}`;
  return `${mm}-${dd}`;
}

function formatAddress(address) {
  if (!address) return '';
  if (address.formattedValue) return address.formattedValue;
  const parts = [
    address.streetAddress,
    address.city,
    address.region,
    address.postalCode,
    address.country,
  ].filter(Boolean);
  return parts.join(', ');
}
