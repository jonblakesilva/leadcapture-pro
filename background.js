/**
 * LeadCapture Pro — Background Service Worker
 *
 * All GHL API calls are made exclusively here.
 * Credentials are read from chrome.storage.sync per request.
 */

import {
  testConnection,
  searchContact,
  createContact,
  updateContact,
  addTags,
  addToOpportunity,
  addNote,
  getPipelines,
  getLocationTags,
  getWorkflows,
  addContactToWorkflow,
  buildContactUrl,
} from './utils/ghl-api.js';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getSettings() {
  return new Promise(resolve => chrome.storage.sync.get(null, resolve));
}

// ---------------------------------------------------------------------------
// Rate limiter: max 10 requests/second
// ---------------------------------------------------------------------------
const requestQueue = [];
let requestsThisSecond = 0;
let rateLimitWindow = Date.now();

function scheduleRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

function processQueue() {
  const now = Date.now();
  if (now - rateLimitWindow >= 1000) {
    rateLimitWindow = now;
    requestsThisSecond = 0;
  }

  while (requestQueue.length > 0 && requestsThisSecond < 10) {
    const { fn, resolve, reject } = requestQueue.shift();
    requestsThisSecond++;
    fn().then(resolve).catch(reject);
  }

  if (requestQueue.length > 0) {
    const delay = 1000 - (Date.now() - rateLimitWindow);
    setTimeout(processQueue, Math.max(delay, 0));
  }
}

// ---------------------------------------------------------------------------
// Tag sanitizer: lowercase, hyphenated, alphanumeric only, max 50 chars each,
// deduped, max 20 tags total (GHL limit)
// ---------------------------------------------------------------------------

function sanitizeTags(tags) {
  return [...new Set(
    tags
      .map(t => t.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, ''))
      .filter(t => t.length > 0 && t.length <= 50)
  )].slice(0, 20);
}

// ---------------------------------------------------------------------------
// Badge helper: shows '!' when settings are incomplete
// ---------------------------------------------------------------------------

async function updateBadgeForSettings() {
  const settings = await getSettings();
  const isComplete = settings.ghlApiKey && settings.ghlLocationId;
  if (!isComplete) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    chrome.action.setTitle({ title: 'LeadCapture Pro — Setup Required' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'LeadCapture Pro' });
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleMessage(msg, sender) {
  switch (msg.type) {

    // Sidebar asks for the tab ID it lives in
    case 'GET_TAB_ID':
      return { tabId: sender.tab ? sender.tab.id : null };

    // Settings page tests GHL credentials
    case 'GHL_TEST_CONNECTION': {
      const { apiKey, locationId } = msg;
      return scheduleRequest(() => testConnection({ apiKey, locationId }));
    }

    // Settings page / sidebar loads pipelines
    // Always reads credentials from storage — never accept them over the message bus
    case 'GHL_GET_PIPELINES': {
      const settings = await getSettings();
      const { ghlApiKey: apiKey, ghlLocationId: locationId } = settings;
      if (!apiKey || !locationId) return { pipelines: [] };
      const pipelines = await scheduleRequest(() => getPipelines({ apiKey, locationId }));
      return { pipelines };
    }

    // Sidebar / settings: fetch all tags defined in this GHL location
    case 'GHL_GET_TAGS': {
      const settings = await getSettings();
      const { ghlApiKey: apiKey, ghlLocationId: locationId } = settings;
      if (!apiKey || !locationId) return { tags: [] };
      try {
        const tags = await scheduleRequest(() => getLocationTags({ apiKey, locationId }));
        return { tags };
      } catch (_) {
        return { tags: [] };
      }
    }

    // Sidebar: fetch all active workflows for this GHL location
    case 'GHL_GET_WORKFLOWS': {
      const settings = await getSettings();
      const { ghlApiKey: apiKey, ghlLocationId: locationId } = settings;
      if (!apiKey || !locationId) return { workflows: [] };
      try {
        const workflows = await scheduleRequest(() => getWorkflows({ apiKey, locationId }));
        return { workflows };
      } catch (_) {
        return { workflows: [] };
      }
    }

    // Sidebar: enroll a contact in a workflow after push
    case 'GHL_ADD_TO_WORKFLOW': {
      const settings = await getSettings();
      const { ghlApiKey: apiKey } = settings;
      const { contactId, workflowId } = msg;
      if (!apiKey || !contactId || !workflowId) return { success: false };
      try {
        await scheduleRequest(() => addContactToWorkflow({ apiKey, contactId, workflowId }));
        return { success: true };
      } catch (_) {
        return { success: false };
      }
    }

    // Sidebar checks if a contact already exists
    case 'GHL_SEARCH_CONTACT': {
      const settings = await getSettings();
      const { ghlApiKey: apiKey, ghlLocationId: locationId } = settings;
      const { phone, email } = msg;
      const contact = await scheduleRequest(() =>
        searchContact({ apiKey, locationId, phone, email })
      );
      return {
        contact: contact || null,
        contactUrl: contact ? buildContactUrl(locationId, contact.id) : null,
      };
    }

    // Push new contact to GHL
    case 'GHL_PUSH_CONTACT': {
      const settings = await getSettings();
      const { ghlApiKey: apiKey, ghlLocationId: locationId } = settings;
      let { contactData, pipelineId, stageId, tags, userNote, auditNote, sourceUrl, sourcePlatform, reviewCount, rating } = msg;

      // Guard: require at least phone or email
      if (!contactData.phone && !contactData.email) {
        return { success: false, error: 'Please provide at least a phone number or email address.' };
      }

      // Validate and format phone
      if (contactData.phone) {
        const digits = contactData.phone.replace(/\D/g, '');
        const last10 = digits.slice(-10);
        if (last10.length !== 10) {
          return { success: false, error: 'Phone number must be 10 digits. Please check and try again.' };
        }
        // Format for GHL: +1XXXXXXXXXX
        contactData = { ...contactData, phone: `+1${last10}` };
      }

      // Validate email format
      if (contactData.email) {
        const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
        if (!emailRe.test(contactData.email)) {
          return { success: false, error: 'Email address format is invalid. Please check and try again.' };
        }
      }

      // 1. Check for existing contact
      let existing = null;
      if (contactData.phone) {
        existing = await scheduleRequest(() =>
          searchContact({ apiKey, locationId, phone: contactData.phone, email: null })
        ).catch(() => null);
      }
      if (!existing && contactData.email) {
        existing = await scheduleRequest(() =>
          searchContact({ apiKey, locationId, phone: null, email: contactData.email })
        ).catch(() => null);
      }

      if (existing) {
        return {
          exists: true,
          contact: existing,
          contactUrl: buildContactUrl(locationId, existing.id),
        };
      }

      // 2. Build full tag list (sanitized)
      const defaultTags = settings.defaultTags
        ? settings.defaultTags.split(',').map(t => t.trim()).filter(Boolean)
        : [];
      const rawTags = [...new Set([...defaultTags, ...(tags || [])])];
      const allTags = sanitizeTags(rawTags);

      // 3. Create contact
      const contact = await scheduleRequest(() =>
        createContact({
          apiKey,
          locationId,
          contactData: {
            ...contactData,
            tags: allTags,
            // Note: 'source' field omitted — GHL only accepts specific enum values;
            // source info is captured in tags and the capture note instead.
          },
        })
      );

      // 4. Add to pipeline (non-fatal)
      const pid = pipelineId || settings.defaultPipelineId;
      const sid = stageId || settings.defaultStageId;
      if (pid && sid) {
        await scheduleRequest(() =>
          addToOpportunity({
            apiKey,
            locationId,
            contactId: contact.id,
            pipelineId: pid,
            stageId: sid,
            name: contactData.name || contactData.businessName || 'New Lead',
          })
        ).catch(() => null);
      }

      // 5. Add capture note with marketing score (non-fatal)
      const date = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });

      // Compute simple marketing competency score (0–100)
      // Opportunity score: higher = more marketing gaps = better prospect
      let score = 0;
      if (contactData.phone) score += 20;
      if (contactData.email) score += 15;
      if (!contactData.website) score += 25;
      const rc = reviewCount ? parseInt(reviewCount, 10) : 0;
      if (rc < 10) score += 20;
      else if (rc < 25) score += 10;
      const rt = rating ? parseFloat(rating) : 0;
      if (rt > 0 && rt < 3.5) score += 15;
      else if (rt >= 3.5 && rt < 4.0) score += 8;
      if (contactData.website && !/^https:\/\//i.test(contactData.website)) score += 5;
      score = Math.min(score, 100);
      const scoreLabel = score >= 70 ? 'Hot Lead' : score >= 45 ? 'Warm Lead' : score >= 20 ? 'Cold Lead' : 'Pass';

      const noteLines = [
        'Lead captured via LeadCapture Pro',
        `Source: ${sourcePlatform || 'Web'}`,
        `URL: ${sourceUrl || 'Unknown'}`,
        `Date: ${date}`,
        '',
        auditNote || `Marketing Score: ${score}/100 (${scoreLabel})`,
      ];
      if (userNote) noteLines.push(`\nNote: ${userNote}`);

      await scheduleRequest(() =>
        addNote({
          apiKey,
          contactId: contact.id,
          body: noteLines.join('\n'),
        })
      ).catch(() => null);

      return {
        exists: false,
        contact,
        contactId: contact.id,
        contactUrl: buildContactUrl(locationId, contact.id),
      };
    }

    // Update existing contact
    case 'GHL_UPDATE_CONTACT': {
      const settings = await getSettings();
      const { ghlApiKey: apiKey, ghlLocationId: locationId } = settings;
      const { contactId, contactData, pipelineId, stageId, userNote, auditNote, sourceUrl, sourcePlatform } = msg;
      const tags = msg.tags || msg.additionalTags; // sidebar sends additionalTags

      const contact = await scheduleRequest(() =>
        updateContact({ apiKey, contactId, updates: contactData })
      );

      if (tags && tags.length) {
        const sanitized = sanitizeTags(tags);
        await scheduleRequest(() =>
          addTags({ apiKey, contactId, tags: sanitized })
        ).catch(() => null);
      }

      const pid = pipelineId || settings.defaultPipelineId;
      const sid = stageId || settings.defaultStageId;
      if (pid && sid) {
        await scheduleRequest(() =>
          addToOpportunity({
            apiKey, locationId, contactId,
            pipelineId: pid, stageId: sid,
          })
        ).catch(() => null);
      }

      const date = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      await scheduleRequest(() =>
        addNote({
          apiKey,
          contactId,
          body: [
            'Contact updated via LeadCapture Pro',
            `Source: ${sourcePlatform || 'Web'}`,
            `URL: ${sourceUrl || 'Unknown'}`,
            `Date: ${date}`,
            '',
            ...(auditNote ? [auditNote] : []),
            ...(userNote ? [`\nNote: ${userNote}`] : []),
          ].join('\n'),
        })
      ).catch(() => null);

      return {
        contact,
        contactUrl: buildContactUrl(locationId, contact.id),
      };
    }

    // Sidebar: fetch a prospect's website HTML for marketing analysis
    case 'LCP_SCAN_WEBSITE': {
      const { url } = msg;
      if (!url || !/^https?:\/\//i.test(url)) return { html: null, error: 'Invalid URL' };
      const t0 = Date.now();
      try {
        const res = await fetch(url, { method: 'GET' });
        const loadMs = Date.now() - t0;
        if (!res.ok) return { html: null, error: `HTTP ${res.status}`, loadMs };
        const raw = await res.text();
        // Truncate to 150KB to keep message size manageable
        return { html: raw.slice(0, 150000), loadMs };
      } catch (err) {
        return { html: null, error: err.message, loadMs: Date.now() - t0 };
      }
    }

    case 'OPEN_SETTINGS':
      chrome.runtime.openOptionsPage();
      return { ok: true };

    default:
      throw new Error(`[LCP] Unknown message type: ${msg.type}`);
  }
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(result => sendResponse({ success: true, ...result }))
    .catch(err => {
      console.warn('[LCP]', err.message);
      sendResponse({ success: false, error: err.userMessage || err.message });
    });
  return true; // keep message channel open for async response
});

// ---------------------------------------------------------------------------
// Lifecycle: install / update
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    // Auto-open settings on fresh install
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
  } else if (details.reason === 'update') {
    // Store update notification flag
    const prevVersion = details.previousVersion;
    const newVersion = chrome.runtime.getManifest().version;
    if (prevVersion !== newVersion) {
      chrome.storage.local.set({
        pendingChangelog: true,
        changelogVersion: newVersion,
      });
    }
  }
  updateBadgeForSettings();
});

// ---------------------------------------------------------------------------
// Badge: refresh on startup and whenever API key / location ID change
// ---------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(updateBadgeForSettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.ghlApiKey || changes.ghlLocationId)) {
    updateBadgeForSettings();
  }
});
