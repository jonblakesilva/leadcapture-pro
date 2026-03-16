/**
 * GoHighLevel v2 API wrapper.
 * All functions are called exclusively from background.js (service worker).
 * Credentials never touch content scripts.
 */

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

function makeHeaders(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Version': API_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

const USER_MESSAGES = {
  401: 'Invalid API key. Please check your GHL credentials in Settings.',
  403: 'Access denied. Your API key may not have the required permissions.',
  404: 'Resource not found. Please verify your Location ID in Settings.',
  422: 'Invalid data submitted. Please review the contact fields.',
  429: 'Rate limit reached. Please wait a moment and try again.',
  500: 'GoHighLevel server error. Please try again shortly.',
};

function buildError(response, data) {
  // Include the full GHL response body in the error message for easier debugging
  const rawMessage = data?.message || data?.msg ||
    (data && Object.keys(data).length ? JSON.stringify(data) : null) ||
    `GHL API error ${response.status}`;
  const err = new Error(rawMessage);
  err.code = response.status;
  err.ghlResponse = data;
  err.userMessage = USER_MESSAGES[response.status]
    ? `${USER_MESSAGES[response.status]} (${rawMessage})`
    : `Something went wrong (${response.status}): ${rawMessage}`;
  return err;
}

async function safeParse(response) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Retry wrapper: auto-retry on 429 with exponential backoff
// ---------------------------------------------------------------------------

async function withRetry(fn, maxRetries = 3) {
  const delays = [1000, 2000, 4000];
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err.code === 429 && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export async function testConnection({ apiKey, locationId }) {
  const res = await fetch(`${BASE_URL}/locations/${locationId}`, {
    method: 'GET',
    headers: makeHeaders(apiKey),
  });
  const data = await safeParse(res);
  if (!res.ok) throw buildError(res, data);
  const name = data.location?.name || data.name || 'Connected';
  return { ok: true, locationName: name };
}

// ---------------------------------------------------------------------------
// Contact search
// ---------------------------------------------------------------------------

export async function searchContact({ apiKey, locationId, phone, email }) {
  if (!phone && !email) return null;

  return withRetry(async () => {
    // GHL v2: simple text search via GET /contacts/ with query param.
    // The GET /contacts/search path (with /search segment) returns 404.
    // POST /contacts/search filter body has unreliable phone matching.
    const params = new URLSearchParams({ locationId, query: phone || email });
    const res = await fetch(`${BASE_URL}/contacts/?${params}`, {
      method: 'GET',
      headers: makeHeaders(apiKey),
    });
    const data = await safeParse(res);
    if (!res.ok) throw buildError(res, data);

    const contacts = data.contacts || [];
    return contacts.length > 0 ? contacts[0] : null;
  });
}

// ---------------------------------------------------------------------------
// Create / update contact
// ---------------------------------------------------------------------------

export async function createContact({ apiKey, locationId, contactData }) {
  return withRetry(async () => {
    const res = await fetch(`${BASE_URL}/contacts/`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify({ ...contactData, locationId }),
    });
    const data = await safeParse(res);
    if (!res.ok) throw buildError(res, data);
    return data.contact;
  });
}

export async function updateContact({ apiKey, contactId, updates }) {
  return withRetry(async () => {
    const res = await fetch(`${BASE_URL}/contacts/${contactId}`, {
      method: 'PUT',
      headers: makeHeaders(apiKey),
      body: JSON.stringify(updates),
    });
    const data = await safeParse(res);
    if (!res.ok) throw buildError(res, data);
    return data.contact;
  });
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export async function addTags({ apiKey, contactId, tags }) {
  if (!tags || tags.length === 0) return null;
  return withRetry(async () => {
    const res = await fetch(`${BASE_URL}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify({ tags }),
    });
    const data = await safeParse(res);
    if (!res.ok) throw buildError(res, data);
    return data;
  });
}

// ---------------------------------------------------------------------------
// Opportunities (pipeline)
// ---------------------------------------------------------------------------

export async function addToOpportunity({ apiKey, locationId, contactId, pipelineId, stageId, name }) {
  if (!pipelineId || !stageId) return null;
  return withRetry(async () => {
    const res = await fetch(`${BASE_URL}/opportunities/`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify({
        pipelineId,
        pipelineStageId: stageId,
        contactId,
        name: name || 'New Lead',
        status: 'open',
        locationId,
      }),
    });
    if (!res.ok) {
      // Non-fatal: contact was already created
      console.warn('[LCP] Failed to add pipeline opportunity:', res.status);
      return null;
    }
    return safeParse(res);
  });
}

export async function getPipelines({ apiKey, locationId }) {
  return withRetry(async () => {
    const params = new URLSearchParams({ locationId });
    const res = await fetch(`${BASE_URL}/opportunities/pipelines?${params}`, {
      method: 'GET',
      headers: makeHeaders(apiKey),
    });
    const data = await safeParse(res);
    if (!res.ok) throw buildError(res, data);
    return data.pipelines || [];
  });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export async function getWorkflows({ apiKey, locationId }) {
  return withRetry(async () => {
    const params = new URLSearchParams({ locationId });
    const res = await fetch(`${BASE_URL}/workflows/?${params}`, {
      method: 'GET',
      headers: makeHeaders(apiKey),
    });
    const data = await safeParse(res);
    if (!res.ok) throw buildError(res, data);
    return data.workflows || [];
  });
}

export async function addContactToWorkflow({ apiKey, contactId, workflowId }) {
  return withRetry(async () => {
    const res = await fetch(`${BASE_URL}/contacts/${contactId}/workflow/${workflowId}`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify({ eventStartTime: new Date().toISOString() }),
    });
    if (!res.ok) {
      console.warn('[LCP] Failed to add to workflow:', res.status);
      return null;
    }
    return safeParse(res);
  });
}

// ---------------------------------------------------------------------------
// Location tags
// ---------------------------------------------------------------------------

export async function getLocationTags({ apiKey, locationId }) {
  return withRetry(async () => {
    const res = await fetch(`${BASE_URL}/locations/${locationId}/tags`, {
      method: 'GET',
      headers: makeHeaders(apiKey),
    });
    const data = await safeParse(res);
    if (!res.ok) throw buildError(res, data);
    // GHL returns { tags: [{ id, name, ... }] }
    const raw = data.tags || [];
    return raw.map(t => (typeof t === 'string' ? t : t.name)).filter(Boolean);
  });
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function addNote({ apiKey, contactId, body }) {
  return withRetry(async () => {
    const res = await fetch(`${BASE_URL}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const errData = await safeParse(res);
      console.warn('[LCP] Failed to add note:', res.status, errData);
      return null;
    }
    return safeParse(res);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildContactUrl(locationId, contactId) {
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`;
}
