/**
 * LeadCapture Pro — Sidebar Script
 *
 * Runs inside the extension page iframe.
 * Has direct access to chrome.* APIs.
 * Communicates with background.js via chrome.runtime.sendMessage.
 * Communicates with content.js (parent page) via window.parent.postMessage.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let settings = {};
  let contacts = [];
  let source = { label: 'Web', tag: 'web-lead' };
  let selectedContact = null;
  let pipelines = [];
  let currentTabId = null;
  let existingGhlContact = null;
  let sessionStats = { pushed: 0, existing: 0 };
  let listFilter = 'all'; // 'all' | 'no-website' | 'bad-reviews' | 'no-phone'

  // Cached scan results for the currently-viewed contact
  let lastScanProblems = null; // array of { icon, text } or null = not yet scanned
  let lastScanTechData = null; // { hasFbPixel, hasGoogleAds, hasAnalytics, hasForm, loadMs }

  // ---------------------------------------------------------------------------
  // Pipeline cache (5-minute in-memory cache)
  // ---------------------------------------------------------------------------

  let pipelineCache = null;
  let pipelineCacheTime = 0;
  const PIPELINE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // GHL tags cache (fetched once per sidebar session)
  let ghlTagsCache = null; // null = not yet fetched, [] = fetched but empty

  // GHL workflows cache (fetched once per sidebar session)
  let workflowCache = null;

  // ---------------------------------------------------------------------------
  // Duplicate check cache (60-second cache)
  // ---------------------------------------------------------------------------

  const checkCache = new Map(); // key: "phone|email", value: { result, timestamp }
  const CHECK_CACHE_TTL = 60 * 1000;

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', async () => {
    // Read tabId from URL params (set by content.js when creating iframe)
    const params = new URLSearchParams(window.location.search);
    currentTabId = params.get('tabId');

    // Load settings
    settings = await loadSettings();

    applyBranding(settings);
    bindStaticListeners();
    initTooltips();

    // Auto-refresh when content script re-detects contacts (e.g. Maps SPA navigation)
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area !== 'local') return;
      const key = 'contacts_' + currentTabId;
      if (!changes[key]) return;
      const detailView = el('contact-detail-view');
      const isDetailOpen = detailView && !detailView.classList.contains('hidden');
      if (!isDetailOpen) {
        loadContactData();
        return;
      }
      // Detail view is open — if Maps enriched the contact with address/website/rating,
      // silently patch those fields without disrupting the user's edits
      if (selectedContact) {
        const newContacts = changes[key].newValue;
        if (!Array.isArray(newContacts)) return;
        const updated = newContacts.find(c =>
          c.businessName && selectedContact.businessName &&
          c.businessName.toLowerCase().trim() === selectedContact.businessName.toLowerCase().trim()
        );
        if (!updated) return;
        const gained = (!selectedContact.address && updated.address) ||
                       (!selectedContact.website && updated.website) ||
                       (!selectedContact.rating && updated.rating) ||
                       (!selectedContact.reviewCount && updated.reviewCount);
        if (!gained) return;
        // Patch selectedContact and update only the fields that were empty
        if (!selectedContact.address && updated.address) {
          selectedContact.address = updated.address;
          const addrEl = el('f-address');
          if (addrEl && !addrEl.value.trim()) addrEl.value = updated.address;
        }
        if (!selectedContact.website && updated.website) {
          selectedContact.website = updated.website;
          const siteEl = el('f-website');
          if (siteEl && !siteEl.value.trim()) siteEl.value = updated.website;
        }
        if (updated.rating) selectedContact.rating = updated.rating;
        if (updated.reviewCount) selectedContact.reviewCount = updated.reviewCount;
        // Re-render just the score bar and marketing problems with enriched data
        const scoreBar = el('marketing-score-bar');
        if (scoreBar && (updated.rating || updated.reviewCount || updated.website !== undefined)) {
          const score = computeMarketingScore(selectedContact);
          const label = score >= 70 ? 'Hot Lead' : score >= 45 ? 'Warm Lead' : score >= 20 ? 'Cold Lead' : 'Pass';
          const colorClass = score >= 70 ? 'score-strong' : score >= 45 ? 'score-fair' : 'score-weak';
          const rc = selectedContact.reviewCount || '0';
          const rt = selectedContact.rating || null;
          const scoreTip = 'How much this business needs marketing help. Higher = more gaps = better prospect for selling your services. Hot Lead (70+) · Warm Lead (45+) · Cold Lead (20+) · Pass (<20)';
          scoreBar.innerHTML =
            '<span class="score-label">Opportunity Score <span class="tip-icon" data-tip="' + escHtml(scoreTip) + '">?</span></span>' +
            '<span class="score-value ' + colorClass + '">' + score + '/100</span>' +
            '<span class="score-grade ' + colorClass + '">' + label + '</span>' +
            (rt ? '<span class="score-reviews">\u2B50 ' + escHtml(String(rt)) + (selectedContact.reviewCount ? ' \u00B7 ' + escHtml(String(rc)) + ' reviews' : '') + '</span>' : '');
          scoreBar.classList.remove('hidden');
        }
        scanWebsiteForProblems(selectedContact);
      }
    });

    // Load contact data
    await loadContactData();
  });

  // ---------------------------------------------------------------------------
  // Settings & branding
  // ---------------------------------------------------------------------------

  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.sync.get(null, data => resolve(data || {}));
    });
  }

  function applyBranding(s) {
    if (s.brandColor) {
      document.documentElement.style.setProperty('--lcp-brand', s.brandColor);
      document.documentElement.style.setProperty('--lcp-brand-hover', s.brandColor);
      document.documentElement.style.setProperty('--lcp-brand-light', hexToLight(s.brandColor));
    }
    if (s.agencyName) {
      el('agency-name').textContent = s.agencyName;
      const footerAgency = el('footer-agency');
      if (footerAgency) {
        if (s.agencyWebsite) {
          footerAgency.innerHTML = '<a href="' + s.agencyWebsite.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;text-decoration-color:rgba(255,255,255,0.3)">' + s.agencyName.replace(/</g, '&lt;') + '</a>';
        } else {
          footerAgency.textContent = s.agencyName;
        }
      }
    }
    if (s.agencyLogo) {
      const logo = el('agency-logo');
      logo.src = s.agencyLogo;
      logo.hidden = false;
      logo.onerror = () => { logo.hidden = true; };
    }

    // White-label CRM name: replace "GHL" everywhere in the UI
    const crm = s.crmName ? s.crmName.trim() : 'GHL';
    const pushLabel = el('push-btn') && el('push-btn').querySelector('.btn-label');
    if (pushLabel) pushLabel.textContent = `Push to ${crm}`;
    const checkLabel = el('check-btn') && el('check-btn').querySelector('.btn-label');
    if (checkLabel) checkLabel.textContent = `Check ${crm}`;
    const viewLink = el('existing-link');
    if (viewLink) viewLink.textContent = `View in ${crm}`;
    const existingTitle = el('existing-contact-banner') &&
      el('existing-contact-banner').querySelector('.alert-title');
    if (existingTitle) existingTitle.textContent = `Contact already in ${crm}`;
    // Update button titles too
    if (el('push-btn')) el('push-btn').title = `Create a new contact in ${crm} with the details above. Checks for duplicates first.`;
    if (el('check-btn')) el('check-btn').title = `Search ${crm} to see if this contact already exists before pushing.`;
    if (viewLink) viewLink.title = `Open this contact's record in ${crm}`;
  }

  function hexToLight(hex) {
    // Generate a very light tint (10% opacity) as a hex isn't easy — use rgba
    return hex + '1a'; // rgba-ish for CSS — fallback to eff6ff
  }

  // ---------------------------------------------------------------------------
  // Friendly error mapper
  // ---------------------------------------------------------------------------

  function friendlyError(err) {
    const msg = err.message || String(err);
    if (msg.includes('401') || msg.toLowerCase().includes('invalid api'))
      return 'Invalid API key. Go to Settings and check your GHL credentials.';
    if (msg.includes('403'))
      return "Your API key doesn't have permission for this location.";
    if (msg.includes('400')) {
      // Show the actual GHL error so we can see the real reason
      const actualError = msg.replace(/something went wrong \(400\):\s*/i, '').trim();
      const hint = 'If this contact exists in GHL, click "Check GHL" first then use Update. If not, check the phone number has 10 digits and the name field is filled in.';
      return actualError ? `GHL rejected (400): ${actualError} — ${hint}` : `GHL rejected (400) — ${hint}`;
    }
    if (msg.includes('422'))
      return 'Contact data is invalid. Check the phone number format (need 10 digits) and email.';
    if (msg.includes('429'))
      return 'GHL rate limit reached. Wait 30 seconds and try again.';
    if (msg.includes('500'))
      return 'GoHighLevel is having issues right now. Try again in a moment.';
    if (msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('network') || msg.toLowerCase().includes('failed to fetch'))
      return "Can't reach GoHighLevel. Check your internet connection.";
    return msg;
  }

  // ---------------------------------------------------------------------------
  // Load contact data from storage
  // ---------------------------------------------------------------------------

  async function loadContactData() {
    checkChangelog();
    showView('loading-view');

    // Check if GHL credentials are configured
    if (!settings.ghlApiKey || !settings.ghlLocationId) {
      showView('setup-view');
      return;
    }

    // Read detected contacts from local storage
    const storageKey = `contacts_${currentTabId}`;
    const sourceKey = `source_${currentTabId}`;

    const data = await new Promise(resolve => {
      chrome.storage.local.get([storageKey, sourceKey], resolve);
    });

    contacts = data[storageKey] || [];
    source = data[sourceKey] || { label: 'Web', tag: 'web-lead' };

    const hasContacts = contacts.some(
      c => (c.phones && c.phones.length) || (c.emails && c.emails.length)
    );

    if (!hasContacts) {
      showView('empty-view');
      return;
    }

    if (contacts.length > 1) {
      renderContactList();
      showView('contact-list-view');
    } else {
      selectedContact = contacts[0];
      renderDetailView(selectedContact);
      showView('contact-detail-view');
    }

    // Pre-load pipelines, GHL tags, and workflows in background (non-blocking)
    loadPipelines();
    fetchGhlTags();
    loadWorkflows();
  }

  function fetchGhlTags() {
    if (ghlTagsCache !== null) return; // already fetched
    ghlTagsCache = []; // mark as in-flight to prevent duplicate calls
    chrome.runtime.sendMessage({ type: 'GHL_GET_TAGS' }, response => {
      if (chrome.runtime.lastError) return;
      ghlTagsCache = (response && response.tags) ? response.tags : [];
    });
  }

  function loadWorkflows() {
    if (workflowCache !== null) return; // already fetched
    workflowCache = []; // mark in-flight
    chrome.runtime.sendMessage({ type: 'GHL_GET_WORKFLOWS' }, response => {
      if (chrome.runtime.lastError) return;
      workflowCache = (response && response.workflows) ? response.workflows : [];
      populateWorkflowSelect();
    });
  }

  function populateWorkflowSelect() {
    const sel = el('workflow-select');
    if (!sel || !workflowCache || !workflowCache.length) return;
    const current = sel.value;
    // Remove old dynamic options (keep the "None" option)
    while (sel.options.length > 1) sel.remove(1);
    workflowCache.forEach(wf => {
      const opt = document.createElement('option');
      opt.value = wf.id;
      opt.textContent = wf.name;
      sel.appendChild(opt);
    });
    if (current) sel.value = current; // restore saved selection if re-rendered
  }

  // ---------------------------------------------------------------------------
  // Changelog notification
  // ---------------------------------------------------------------------------

  async function checkChangelog() {
    const data = await new Promise(resolve => {
      chrome.storage.local.get(['pendingChangelog', 'changelogVersion'], resolve);
    });
    if (!data.pendingChangelog) return;
    const version = data.changelogVersion || '';
    el('changelog-text').textContent = `LeadCapture Pro updated${version ? ' to v' + version : ''}`;
    el('changelog-link').href = 'https://jonblakesilva.github.io/leadcapture-pro/support.html';
    showElement('changelog-banner');

    el('changelog-dismiss').addEventListener('click', () => {
      hideElement('changelog-banner');
      chrome.storage.local.remove(['pendingChangelog', 'changelogVersion']);
    });
  }

  // ---------------------------------------------------------------------------
  // Session stats
  // ---------------------------------------------------------------------------

  function updateSessionStats() {
    const statsEl = el('session-stats');
    if (!statsEl) return;
    const parts = [];
    if (sessionStats.pushed > 0) parts.push(`↑ ${sessionStats.pushed} pushed`);
    if (sessionStats.existing > 0) parts.push(`${sessionStats.existing} in GHL`);
    if (parts.length === 0) {
      statsEl.classList.add('hidden');
    } else {
      statsEl.textContent = parts.join(' · ');
      statsEl.classList.remove('hidden');
    }
  }

  // ---------------------------------------------------------------------------
  // Tag pills
  // ---------------------------------------------------------------------------

  function initTagPills(containerId, pillsId, typeInputId, hiddenInputId, initialTags, lockedTags) {
    const container = el(containerId);
    const pillsDiv = el(pillsId);
    const typeInput = el(typeInputId);
    const hiddenInput = el(hiddenInputId);
    if (!container || !pillsDiv || !typeInput || !hiddenInput) return;

    let userTags = [...initialTags];
    const locked = new Set(lockedTags);

    // Suggestions dropdown
    let suggestEl = container.querySelector('.tag-suggestions');
    if (!suggestEl) {
      suggestEl = document.createElement('div');
      suggestEl.className = 'tag-suggestions hidden';
      container.appendChild(suggestEl);
    }
    let activeSuggIdx = -1;

    function hideSuggestions() {
      suggestEl.classList.add('hidden');
      activeSuggIdx = -1;
    }

    function showSuggestions(query) {
      const all = ghlTagsCache || [];
      const current = new Set([...lockedTags, ...userTags]);
      const matches = all
        .filter(t => t.toLowerCase().includes(query.toLowerCase()) && !current.has(t))
        .slice(0, 8);

      if (!matches.length || !query) { hideSuggestions(); return; }

      suggestEl.innerHTML = '';
      activeSuggIdx = -1;
      matches.forEach((tag, i) => {
        const item = document.createElement('div');
        item.className = 'tag-suggest-item';
        item.dataset.i = String(i);
        // Highlight matching portion
        const idx = tag.toLowerCase().indexOf(query.toLowerCase());
        if (idx >= 0) {
          item.innerHTML = escHtml(tag.slice(0, idx))
            + `<mark>${escHtml(tag.slice(idx, idx + query.length))}</mark>`
            + escHtml(tag.slice(idx + query.length));
        } else {
          item.textContent = tag;
        }
        item.addEventListener('mousedown', e => {
          e.preventDefault(); // prevent blur before click
          addTag(tag);
          typeInput.value = '';
          hideSuggestions();
          typeInput.focus();
        });
        suggestEl.appendChild(item);
      });
      suggestEl.classList.remove('hidden');
    }

    function setActiveSugg(idx) {
      const items = suggestEl.querySelectorAll('.tag-suggest-item');
      items.forEach(it => it.classList.remove('active'));
      activeSuggIdx = Math.max(-1, Math.min(items.length - 1, idx));
      if (activeSuggIdx >= 0) items[activeSuggIdx].classList.add('active');
    }

    function sync() {
      const all = [...lockedTags, ...userTags];
      hiddenInput.value = all.join(',');
    }

    function renderPills() {
      pillsDiv.innerHTML = '';
      lockedTags.forEach(tag => {
        const span = document.createElement('span');
        span.className = 'tag-pill-wrap locked';
        span.textContent = tag;
        pillsDiv.appendChild(span);
      });
      userTags.forEach((tag, i) => {
        const span = document.createElement('span');
        span.className = 'tag-pill-wrap';
        span.innerHTML = `${escHtml(tag)}<button class="tag-pill-remove" data-i="${i}" title="Remove" aria-label="Remove ${escHtml(tag)}">×</button>`;
        pillsDiv.appendChild(span);
      });
      pillsDiv.querySelectorAll('.tag-pill-remove').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          userTags.splice(parseInt(btn.dataset.i, 10), 1);
          renderPills();
          sync();
        });
      });
      sync();
    }

    function addTag(raw) {
      const tag = raw.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '').slice(0, 50);
      if (!tag || locked.has(tag) || userTags.includes(tag)) return;
      userTags.push(tag);
      renderPills();
    }

    typeInput.addEventListener('input', () => {
      showSuggestions(typeInput.value.trim());
    });

    typeInput.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveSugg(activeSuggIdx + 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveSugg(activeSuggIdx - 1);
        return;
      }
      if (e.key === 'Escape') { hideSuggestions(); return; }

      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const items = suggestEl.querySelectorAll('.tag-suggest-item');
        if (activeSuggIdx >= 0 && items[activeSuggIdx]) {
          addTag(items[activeSuggIdx].textContent);
        } else {
          addTag(typeInput.value);
        }
        typeInput.value = '';
        hideSuggestions();
      } else if (e.key === 'Backspace' && !typeInput.value && userTags.length > 0) {
        userTags.pop();
        renderPills();
      }
    });

    typeInput.addEventListener('blur', () => {
      setTimeout(() => {
        hideSuggestions();
        if (typeInput.value.trim()) { addTag(typeInput.value); typeInput.value = ''; }
      }, 150); // delay so mousedown on suggestion fires first
    });

    container.addEventListener('click', e => {
      if (!e.target.closest('.tag-pill-remove')) typeInput.focus();
    });

    renderPills();
    return { getAll: () => [...lockedTags, ...userTags] };
  }

  // ---------------------------------------------------------------------------
  // Contact list view — with approve/deny checkboxes + batch push
  // ---------------------------------------------------------------------------

  function renderContactList() {
    el('list-count').textContent = `${contacts.length} found`;

    // Compute intelligence stats
    var noWebsite = contacts.filter(function(c) { return !c.website; });
    var badReviews = contacts.filter(function(c) {
      return c.rating && parseFloat(c.rating) < 4.0;
    });
    var noPhone = contacts.filter(function(c) { return !c.phones || !c.phones.length; });

    // Render intel bar (only if any useful signal exists)
    var existingBar = document.getElementById('intel-bar');
    if (existingBar) existingBar.remove();

    if (noWebsite.length > 0 || badReviews.length > 0) {
      var bar = document.createElement('div');
      bar.id = 'intel-bar';
      bar.className = 'intel-bar';

      var chips = '<div class="intel-chips">';
      chips += '<span class="intel-stat">' + contacts.length + ' found</span>';
      if (noWebsite.length > 0) {
        chips += '<button class="intel-chip intel-chip-website" data-filter="no-website" title="Show only businesses without a website">' +
          '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><circle cx="8" cy="8" r="6.5"/><path d="M8 1.5C5.5 4 4.5 6 4.5 8s1 4 3.5 6.5M8 1.5C10.5 4 11.5 6 11.5 8s-1 4-3.5 6.5M1.5 8h13" stroke-linecap="round"/></svg>' +
          noWebsite.length + ' no website</button>';
      }
      if (badReviews.length > 0) {
        chips += '<button class="intel-chip intel-chip-reviews" data-filter="bad-reviews" title="Show only businesses with under 4.0 star rating">' +
          '<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M8 1l1.8 3.6L14 5.4l-3 2.9.7 4.1L8 10.4l-3.7 2 .7-4.1-3-2.9 4.2-.8z"/></svg>' +
          badReviews.length + ' under 4\u2605</button>';
      }
      if (noPhone.length > 0) {
        chips += '<button class="intel-chip intel-chip-phone" data-filter="no-phone" title="Show only businesses missing a phone number">' +
          '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><path d="M11 10.5c-.5.5-1.5 1.5-2 1.5S7.5 11 6.5 10 5 8.5 5 7.5s1-1.5 1.5-2l-2-3C4 2 3 2.5 2.5 3 1.5 4 1.5 6.5 4.5 9.5S12 14.5 13 13.5c.5-.5 1-1.5.5-2l-2.5-1z" stroke-linecap="round"/></svg>' +
          noPhone.length + ' no phone</button>';
      }
      chips += '<button class="intel-chip intel-chip-all' + (listFilter === 'all' ? ' active' : '') + '" data-filter="all">All</button>';
      chips += '</div>';

      bar.innerHTML = chips;
      var contactListView = el('contact-list-view');
      var listToolbar = contactListView.querySelector('.list-toolbar');
      listToolbar.after(bar);

      bar.querySelectorAll('.intel-chip[data-filter]').forEach(function(btn) {
        if (btn.dataset.filter === listFilter) btn.classList.add('active');
        btn.addEventListener('click', function() {
          listFilter = btn.dataset.filter;
          bar.querySelectorAll('.intel-chip').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          applyListFilter();
        });
      });
    }

    // Render cards — sorted by opportunity score descending (biggest gap first)
    const list = el('contact-list');
    list.innerHTML = '';

    const sortedIndices = contacts
      .map((c, i) => ({ i, score: computeMarketingScore(c) }))
      .sort((a, b) => b.score - a.score)
      .map(x => x.i);

    sortedIndices.forEach((index) => {
      const contact = contacts[index];
      const card = document.createElement('div');
      card.className = 'contact-card';

      const name = contact.businessName || 'Unknown Business';
      const initial = name.charAt(0).toUpperCase();
      const phone = contact.phones && contact.phones[0] ? contact.phones[0].display : '';
      const email = contact.emails && contact.emails[0] ? contact.emails[0].display : '';
      const addrParts = contact.address ? contact.address.split(',') : [];
      const addrShort = addrParts.length >= 2
        ? addrParts.slice(-2).join(',').trim()
        : (contact.address || '');
      const hasContact = !!(phone || email);

      // Badges for intel signals
      const cardScore = computeMarketingScore(contact);
      const cardLabel = cardScore >= 70 ? 'Hot Lead' : cardScore >= 45 ? 'Warm Lead' : cardScore >= 20 ? 'Cold Lead' : 'Pass';
      const cardLabelClass = cardScore >= 70 ? 'badge-hot' : cardScore >= 45 ? 'badge-warm' : 'badge-cold';
      var badges = '<span class="contact-badge ' + cardLabelClass + '">' + escHtml(cardLabel) + '</span>';
      if (!contact.website) badges += '<span class="contact-badge badge-no-website">No site</span>';
      if (contact.rating && parseFloat(contact.rating) < 4.0) {
        badges += '<span class="contact-badge badge-low-rating">' + escHtml(String(contact.rating)) + '\u2605</span>';
      }
      if (contact.isVerified === true) {
        badges += '<span class="contact-badge badge-verified" title="Google Business Profile is claimed/verified">✓ Verified</span>';
      } else if (contact.isVerified === false) {
        badges += '<span class="contact-badge badge-unverified" title="Google Business Profile appears unclaimed">Unclaimed</span>';
      }

      card.dataset.hasWebsite = contact.website ? 'true' : 'false';
      card.dataset.rating = contact.rating ? String(contact.rating) : '';
      card.dataset.hasPhone = phone ? 'true' : 'false';
      card.dataset.index = String(index);

      card.innerHTML = `
        <label class="contact-card-cb-wrap" title="${hasContact ? 'Include in batch push' : 'No phone or email — cannot push'}">
          <input type="checkbox" class="contact-cb" data-index="${index}" ${hasContact ? 'checked' : 'disabled'}>
        </label>
        <div class="contact-card-avatar-wrap"><div class="contact-card-avatar">${escHtml(initial)}</div></div>
        <div class="contact-card-body">
          <div class="contact-card-name">${escHtml(name)}${badges}</div>
          <div class="contact-card-details">
            <span class="card-detail ${phone ? '' : 'muted'}">${phone ? escHtml(phone) : 'No phone'}</span>
            ${email ? `<span class="card-detail">${escHtml(email)}</span>` : ''}
            ${addrShort ? `<span class="card-detail addr">${escHtml(addrShort)}</span>` : ''}
          </div>
          <div class="contact-card-status-wrap">
            <span class="contact-card-status" id="card-status-${index}"></span>
          </div>
        </div>
        <button class="contact-card-detail-btn" data-index="${index}" title="View &amp; edit details">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      `;

      list.appendChild(card);
    });

    // Detail button — view/edit individual contact before pushing
    list.querySelectorAll('.contact-card-detail-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        selectContact(parseInt(btn.dataset.index, 10));
      });
    });

    // Checkbox change — update count
    list.querySelectorAll('.contact-cb').forEach(cb => {
      cb.addEventListener('change', updateSelectedCount);
    });

    applyListFilter();
    updateSelectedCount();
  }

  function applyListFilter() {
    document.querySelectorAll('#contact-list .contact-card').forEach(function(card) {
      var show = true;
      if (listFilter === 'no-website') show = card.dataset.hasWebsite === 'false';
      else if (listFilter === 'bad-reviews') {
        var r = parseFloat(card.dataset.rating);
        show = !isNaN(r) && r < 4.0;
      }
      else if (listFilter === 'no-phone') show = card.dataset.hasPhone === 'false';
      card.style.display = show ? '' : 'none';
    });
    updateSelectedCount();
  }

  function updateSelectedCount() {
    const all = Array.from(document.querySelectorAll('.contact-cb'));
    const enabled = all.filter(cb => !cb.disabled);
    const checked = enabled.filter(cb => cb.checked);
    const count = checked.length;

    el('selected-count').textContent = count;
    el('push-selected-btn').disabled = count === 0;

    const selectAllCb = el('select-all-cb');
    if (selectAllCb && enabled.length > 0) {
      selectAllCb.checked = count === enabled.length;
      selectAllCb.indeterminate = count > 0 && count < enabled.length;
    }
  }

  async function pushSelectedContacts() {
    const checkboxes = Array.from(document.querySelectorAll('.contact-cb:checked')).filter(cb => !cb.disabled);
    const selectedIndices = checkboxes.map(cb => parseInt(cb.dataset.index, 10));
    if (selectedIndices.length === 0) return;

    setButtonLoading('push-selected-btn', true);

    const defaultTags = settings.defaultTags
      ? settings.defaultTags.split(',').map(t => t.trim()).filter(Boolean)
      : [];

    // Read extra tags and note from batch options panel (if it was opened)
    const batchTagsInput = el('batch-tags-input');
    const extraBatchTags = batchTagsInput && batchTagsInput.value
      ? batchTagsInput.value.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    const batchNote = (el('batch-note') && el('batch-note').value.trim()) || null;

    const batchTags = [...new Set([...defaultTags, ...extraBatchTags, source.tag])];

    for (const idx of selectedIndices) {
      const contact = contacts[idx];
      const statusEl = el(`card-status-${idx}`);
      if (statusEl) statusEl.innerHTML = '<span class="status-pushing">Pushing…</span>';

      const phone = normalizePhone(contact.phones && contact.phones[0] ? contact.phones[0].normalized : null);
      const email = contact.emails && contact.emails[0] ? contact.emails[0].normalized : null;

      if (!phone && !email) {
        if (statusEl) statusEl.innerHTML = '<span class="status-skip">No phone/email</span>';
        continue;
      }

      try {
        const res = await sendMessage({
          type: 'GHL_PUSH_CONTACT',
          contactData: {
            firstName: contact.businessName || undefined,
            phone: phone || undefined,
            email: email || undefined,
            address1: contact.address || undefined,
            website: contact.website || undefined,
          },
          pipelineId: settings.defaultPipelineId || null,
          stageId: settings.defaultStageId || null,
          tags: batchTags,
          userNote: batchNote,
          auditNote: buildAuditNote(contact, null, null),
          sourceUrl: contact.sourceUrl || window.location.href,
          sourcePlatform: source.label,
          reviewCount: contact.reviewCount || null,
          rating: contact.rating || null,
        });

        if (!res.success) throw new Error(res.error);

        if (res.exists) {
          sessionStats.existing++;
          if (statusEl) statusEl.innerHTML =
            `<span class="status-exists"><a href="${escAttr(res.contactUrl || '#')}" target="_blank" rel="noopener">Already in GHL ↗</a></span>`;
        } else {
          sessionStats.pushed++;
          if (statusEl) statusEl.innerHTML =
            `<span class="status-ok">✓ Pushed — <a href="${escAttr(res.contactUrl || '#')}" target="_blank" rel="noopener">View ↗</a></span>`;

          // Enroll in workflow if selected
          const workflowId = el('workflow-select') ? el('workflow-select').value : null;
          if (workflowId && res.contactId) {
            chrome.runtime.sendMessage({ type: 'GHL_ADD_TO_WORKFLOW', contactId: res.contactId, workflowId })
              .catch(() => null);
          }
        }

        // Mark done — disable checkbox so it won't be re-pushed
        const cb = document.querySelector(`.contact-cb[data-index="${idx}"]`);
        if (cb) { cb.checked = false; cb.disabled = true; }
      } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span class="status-error">${escHtml(friendlyError(e))}</span>`;
      }
    }

    setButtonLoading('push-selected-btn', false);
    updateSelectedCount();
    updateSessionStats();
  }

  function selectContact(index) {
    selectedContact = contacts[index];
    el('back-btn').classList.remove('hidden');
    renderDetailView(selectedContact);
    showView('contact-detail-view');
  }

  // ---------------------------------------------------------------------------
  // Detail view
  // ---------------------------------------------------------------------------

  function renderDetailView(contact) {
    // Reset state banners
    hideElement('existing-contact-banner');
    hideElement('not-found-banner');
    hideElement('success-banner');
    hideElement('error-banner');
    existingGhlContact = null;

    // Reset manual mode
    window._lcpManualMode = false;

    // Source badge
    el('source-badge').textContent = source.tag;

    // Basic fields
    el('f-name').value = contact.businessName || '';
    el('f-address').value = contact.address || '';
    el('f-website').value = contact.website || '';
    if (el('f-contact-person')) el('f-contact-person').value = '';

    // Note auto-preview — show what will be included in the GHL note automatically
    const notePreview = el('note-auto-preview');
    if (notePreview) {
      const previewParts = [];
      if (contact.rating || contact.reviewCount) {
        const rp = [];
        if (contact.rating) rp.push('\u2B50 ' + contact.rating);
        if (contact.reviewCount) rp.push(contact.reviewCount + ' reviews');
        previewParts.push(rp.join(' \u00B7 '));
      }
      const score = computeMarketingScore(contact);
      const label = score >= 70 ? 'Hot Lead' : score >= 45 ? 'Warm Lead' : score >= 20 ? 'Cold Lead' : 'Pass';
      previewParts.push('Score: ' + score + '/100 \u2014 ' + label);
      if (contact.website) previewParts.push('Website: ' + contact.website);
      notePreview.textContent = 'Auto-note will include: ' + previewParts.join(' \u00B7 ');
      notePreview.classList.remove('hidden');
    }

    // Show manual entry button in case it was hidden
    el('manual-entry-btn').style.display = '';

    // Phone selector — filter low-confidence if higher ones exist
    var phones = contact.phones || [];
    var hasGoodPhone = phones.some(function(p) { return p.confidence === 'high' || p.confidence === 'medium'; });
    if (hasGoodPhone) {
      phones = phones.filter(function(p) { return p.confidence !== 'low'; });
    }

    // Email selector — filter low-confidence if higher ones exist
    var emails = contact.emails || [];
    var hasGoodEmail = emails.some(function(e) { return e.confidence === 'high' || e.confidence === 'medium'; });
    if (hasGoodEmail) {
      emails = emails.filter(function(e) { return e.confidence !== 'low'; });
    }

    // Restore phone/email field groups in case manual entry replaced them
    var phoneGroup = el('phone-field-group');
    phoneGroup.innerHTML = '<label class="field-label">Phone</label><div id="phone-selector" class="option-selector"></div>';

    var emailGroup = el('email-field-group');
    emailGroup.innerHTML = '<label class="field-label">Email</label><div id="email-selector" class="option-selector"></div>';

    // Phone selector
    renderOptionSelector('phone-selector', phones, 'phone');

    // Email selector
    renderOptionSelector('email-selector', emails, 'email');

    // Tags — source tag is locked (auto-added, can't remove), default tags are pre-filled but removable
    const defaultTags = settings.defaultTags
      ? settings.defaultTags.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    const lockedTags = [source.tag].filter(Boolean);
    const initialUserTags = defaultTags.filter(t => t !== source.tag);
    initTagPills('tags-pill-container', 'tags-pills', 'tags-type-input', 'tags-input', initialUserTags, lockedTags);

    // Show manual entry button in case it was hidden (reset above handles it, but be explicit)
    el('manual-entry-btn').style.display = '';

    // Populate workflow dropdown if cache is already warm
    populateWorkflowSelect();

    // Show audit video button only when website is present
    const auditSection = el('audit-video-section');
    if (auditSection) {
      if (contact.website) auditSection.classList.remove('hidden');
      else auditSection.classList.add('hidden');
    }
    // Hide audit panel on re-render
    const auditPanel = el('audit-panel');
    if (auditPanel) auditPanel.classList.add('hidden');

    // Show marketing score bar when review/rating data is available
    const scoreBar = el('marketing-score-bar');
    if (scoreBar) {
      const hasScoreData = contact.reviewCount || contact.rating || contact.website !== undefined;
      if (hasScoreData) {
        const score = computeMarketingScore(contact);
        // Labels: how good a prospect are they for selling services
        const label = score >= 70 ? 'Hot Lead' : score >= 45 ? 'Warm Lead' : score >= 20 ? 'Cold Lead' : 'Pass';
        const colorClass = score >= 70 ? 'score-strong' : score >= 45 ? 'score-fair' : 'score-weak';
        const rc = contact.reviewCount || '0';
        const rt = contact.rating || null;
        const scoreTip = 'How much this business needs marketing help. Higher = more gaps = better prospect for selling your services. Hot Lead (70+) · Warm Lead (45+) · Cold Lead (20+) · Pass (<20)';
        scoreBar.innerHTML =
          '<span class="score-label">Opportunity Score <span class="tip-icon" data-tip="' + escHtml(scoreTip) + '">?</span></span>' +
          '<span class="score-value ' + colorClass + '">' + score + '/100</span>' +
          '<span class="score-grade ' + colorClass + '">' + label + '</span>' +
          (rt ? '<span class="score-reviews">\u2B50 ' + escHtml(String(rt)) + (contact.reviewCount ? ' \u00B7 ' + escHtml(String(rc)) + ' reviews' : '') + '</span>' : '');
        scoreBar.classList.remove('hidden');
      } else {
        scoreBar.classList.add('hidden');
      }
    }

    // Scan website for marketing problems
    hideElement('marketing-problems');
    hideElement('review-gap-panel');
    lastScanProblems = null;
    lastScanTechData = null;
    renderReviewGap(contact);
    scanWebsiteForProblems(contact);

    // Auto-check GHL on load if contact has phone or email
    const _hasContactData = (contact.phones && contact.phones.length > 0) || (contact.emails && contact.emails.length > 0);
    if (_hasContactData) {
      setTimeout(() => {
        // Only auto-check if no result already showing
        const banner = el('existing-contact-banner');
        const notFound = el('not-found-banner');
        if (banner && banner.classList.contains('hidden') && notFound && notFound.classList.contains('hidden')) {
          checkGhl();
        }
      }, 500);
    }
  }

  function renderOptionSelector(containerId, items, name) {
    const container = el(containerId);
    container.innerHTML = '';

    if (!items || items.length === 0) {
      container.innerHTML = `<div class="option-none">None detected</div>`;
      return;
    }

    items.forEach((item, index) => {
      const id = `${name}-opt-${index}`;

      // Determine confidence level and map to dot class
      var confidenceLevel = null;
      if (item.confidence) {
        if (item.confidence === 'tel-link' || item.confidence === 'schema' || item.confidence === 'high') {
          confidenceLevel = 'high';
        } else if (item.confidence === 'text' || item.confidence === 'medium') {
          confidenceLevel = 'medium';
        } else if (item.confidence === 'low') {
          confidenceLevel = 'low';
        }
      }

      var confidenceDotHtml = confidenceLevel
        ? `<span class="confidence-dot confidence-${confidenceLevel}"></span>`
        : '';

      var confidenceTextHtml = item.confidence
        ? `<span class="option-item-confidence ${confidenceLevel === 'high' ? 'high' : ''}">${confidenceLabel_(item.confidence)}</span>`
        : '';

      const div = document.createElement('div');
      div.className = `option-item ${index === 0 ? 'selected' : ''}`;

      div.innerHTML = `
        <input type="radio" name="${name}-select" id="${id}" value="${escAttr(item.normalized)}" ${index === 0 ? 'checked' : ''}>
        <label class="option-item-label" for="${id}">
          <span class="option-item-row">
            ${confidenceDotHtml}<span class="option-item-value">${escHtml(item.display)}</span>
          </span>
          ${confidenceTextHtml}
        </label>
      `;

      div.addEventListener('click', () => {
        container.querySelectorAll('.option-item').forEach(d => d.classList.remove('selected'));
        div.classList.add('selected');
        div.querySelector('input[type="radio"]').checked = true;
      });

      container.appendChild(div);
    });
  }

  // Opportunity Score: measures how much this business NEEDS marketing help.
  // Higher = more gaps = better prospect for selling your services.
  function computeMarketingScore(contact) {
    let score = 0;
    // Reachability (can we contact them?)
    if (contact.phones && contact.phones.length) score += 20;  // reachable by phone
    if (contact.emails && contact.emails.length) score += 15;  // reachable by email
    // Marketing gaps (the selling opportunities)
    if (!contact.website) score += 25;                          // no website = #1 upsell
    const rc = contact.reviewCount ? parseInt(contact.reviewCount, 10) : 0;
    if (rc < 10) score += 20;                                   // very few reviews
    else if (rc < 25) score += 10;                              // low reviews
    const rt = contact.rating ? parseFloat(contact.rating) : 0;
    if (rt > 0 && rt < 3.5) score += 15;                       // poor rating — recovery opportunity
    else if (rt >= 3.5 && rt < 4.0) score += 8;                // below average
    // SSL gap (website exists but no https)
    if (contact.website && !/^https:\/\//i.test(contact.website)) score += 5;
    return Math.min(score, 100);
  }

  // ---------------------------------------------------------------------------
  // Audit Note Builder — structured note attached to every GHL push
  // ---------------------------------------------------------------------------

  function buildAuditNote(contact, scanProblems, techData) {
    const score = computeMarketingScore(contact);
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C+' : score >= 40 ? 'C' : score >= 25 ? 'D' : 'F';

    const lines = [
      '--- Website Audit ---',
      'Score: ' + score + '/100',
      'Grade: ' + grade,
    ];

    // Top Issues — from scan if available, else derived from contact data
    const issues = [];
    if (scanProblems && scanProblems.length > 0) {
      scanProblems.forEach(function(p) { issues.push(p.text); });
    } else {
      if (!contact.website) issues.push('No website');
      const rc2 = contact.reviewCount ? parseInt(contact.reviewCount, 10) : 0;
      if (rc2 < 10) issues.push('Only ' + (rc2 || 0) + ' Google reviews');
      const rt2 = contact.rating ? parseFloat(contact.rating) : 0;
      if (rt2 > 0 && rt2 < 4.0) issues.push('Low rating: ' + rt2 + '\u2605');
    }
    if (issues.length > 0) {
      lines.push('');
      lines.push('Top Issues:');
      issues.slice(0, 6).forEach(function(i) { lines.push('- ' + i); });
    }

    // Strengths — from scan + contact data
    const strengths = [];
    if (techData) {
      if (techData.isHttps)        strengths.push('HTTPS enabled');
      if (techData.hasFbPixel)     strengths.push('Facebook Pixel active');
      if (techData.hasGoogleAds)   strengths.push('Google Ads tracking active');
      if (techData.hasAnalytics)   strengths.push('Analytics installed');
      if (techData.hasForm)        strengths.push('Lead capture form present');
    }
    if (contact.phones && contact.phones.length > 0) strengths.push('Phone number visible');
    if (contact.emails && contact.emails.length > 0) strengths.push('Email address found');
    if (contact.website) strengths.push('Website present');
    const rc3 = contact.reviewCount ? parseInt(contact.reviewCount, 10) : 0;
    const rt3 = contact.rating ? parseFloat(contact.rating) : 0;
    if (rc3 >= 25) strengths.push(rc3 + ' Google reviews');
    if (rt3 >= 4.0) strengths.push(rt3 + '\u2605 rating');

    if (strengths.length > 0) {
      lines.push('');
      lines.push('Strengths:');
      strengths.slice(0, 5).forEach(function(s) { lines.push('- ' + s); });
    }

    lines.push('---');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Marketing Problem Detector
  // ---------------------------------------------------------------------------

  function analyzeWebsiteProblems(html, contact, loadMs) {
    const problems = [];
    const h = html ? html.toLowerCase() : '';

    // SSL (from URL, no fetch needed)
    if (contact.website && !/^https:\/\//i.test(contact.website)) {
      problems.push({ icon: '🔒', text: 'No SSL (not HTTPS)' });
    }

    if (html) {
      // Facebook Pixel (note: may load via GTM — flag as "not detected in code")
      if (!h.includes('fbevents.js') && !h.includes('connect.facebook.net')) {
        problems.push({ icon: '📣', text: 'Pixel not detected in page code' });
      }

      // Google Ads (note: may load via GTM)
      if (!h.includes('googleadservices.com') && !h.includes('google_conversion') && !/aw-\d{9,}/.test(h)) {
        problems.push({ icon: '📈', text: 'Google Ads tag not detected' });
      }

      // Analytics
      if (!h.includes('google-analytics.com') && !h.includes('gtag(') && !h.includes('gtag (') && !h.includes('analytics.js') && !h.includes('googletagmanager.com')) {
        problems.push({ icon: '📊', text: 'No analytics detected' });
      }

      // Lead form
      const hasForm = h.includes('<form');
      const hasLeadInput = /type=["']?(?:email|tel)/.test(h) || /name=["']?(?:email|phone|name|contact)/.test(h) || /placeholder=["'][^"']*(?:email|name|phone|contact)/i.test(h);
      if (!hasForm || !hasLeadInput) {
        problems.push({ icon: '📝', text: 'No lead capture form' });
      }

      // Slow load
      if (loadMs && loadMs > 3000) {
        problems.push({ icon: '🐢', text: `Slow website (${(loadMs / 1000).toFixed(1)}s load)` });
      }
    }

    // Low reviews (from contact data — works even without website scan)
    // rc === -1 means not detected — the score already penalised this, so flag it
    const rc = contact.reviewCount != null ? parseInt(contact.reviewCount, 10) : -1;
    if (rc === 0) {
      problems.push({ icon: '⭐', text: 'No Google reviews found' });
    } else if (rc > 0 && rc < 10) {
      problems.push({ icon: '⭐', text: `Only ${rc} Google review${rc === 1 ? '' : 's'}` });
    } else if (rc === -1) {
      // Reviews weren't detected from this page — nudge the user to check
      problems.push({ icon: '⭐', text: 'Google reviews unverified — check on Maps' });
    }

    // Poor rating
    const rt = contact.rating ? parseFloat(contact.rating) : 0;
    if (rt > 0 && rt < 4.0) {
      problems.push({ icon: '⚠️', text: `Low rating: ${rt}★` });
    }

    return problems;
  }

  function renderMarketingProblems(problems, techData) {
    const panel = el('marketing-problems');
    if (!panel) return;

    // If no problems AND no tech data showing positive signals — hide panel
    const hasAdSignals = techData && (techData.hasFbPixel || techData.hasGoogleAds);
    if (problems.length === 0 && !hasAdSignals) {
      panel.classList.add('hidden');
      return;
    }

    if (problems.length === 0) {
      panel.classList.add('hidden');
      return;
    }

    const chips = problems.map(p =>
      `<span class="mkt-problem-chip"><span class="mkt-problem-chip-icon">${p.icon}</span>${escHtml(p.text)}</span>`
    ).join('');

    // Build ads-running row (positive signals from tech scan)
    let adsRow = '';
    if (techData) {
      const adChips = [];
      if (techData.hasFbPixel) adChips.push('<span class="ads-chip ads-chip-active">📘 FB Pixel ✓</span>');
      else adChips.push('<span class="ads-chip ads-chip-missing">📘 FB Pixel ✗</span>');
      if (techData.hasGoogleAds) adChips.push('<span class="ads-chip ads-chip-active">🔵 Google Ads ✓</span>');
      else adChips.push('<span class="ads-chip ads-chip-missing">🔵 Google Ads ✗</span>');
      if (techData.hasAnalytics) adChips.push('<span class="ads-chip ads-chip-active">📊 Analytics ✓</span>');
      adsRow = `<div class="ads-status-row">${adChips.join('')}</div>`;
    }

    panel.innerHTML =
      `<div class="mkt-problems-header">` +
        `<span class="mkt-problems-title">Marketing Gaps Detected</span>` +
        `<span class="mkt-problems-count">${problems.length} issue${problems.length === 1 ? '' : 's'}</span>` +
      `</div>` +
      adsRow +
      (problems.length > 0 ? `<div class="mkt-problem-list">${chips}</div>` : '') +
      `<div class="mkt-problems-note">Each gap is a selling point. Tags via GTM may not appear in static page code.</div>`;
    panel.classList.remove('hidden');
  }

  function renderReviewGap(contact) {
    const panel = el('review-gap-panel');
    if (!panel) return;

    const rc = contact.reviewCount ? parseInt(contact.reviewCount, 10) : null;
    if (rc === null || isNaN(rc)) { panel.classList.add('hidden'); return; }

    // Find highest reviewer count among other businesses on this page
    const others = contacts.filter(c =>
      c !== contact &&
      c.businessName !== contact.businessName &&
      c.reviewCount &&
      parseInt(c.reviewCount, 10) > 0
    );
    if (others.length === 0) { panel.classList.add('hidden'); return; }

    const topCount = Math.max(...others.map(c => parseInt(c.reviewCount, 10)));
    const gap = topCount - rc;
    if (gap <= 0) { panel.classList.add('hidden'); return; }

    panel.innerHTML =
      `<div class="rg-title">Review Gap Detector</div>` +
      `<div class="rg-stats">` +
        `<div class="rg-stat"><span class="rg-stat-label">This business</span><span class="rg-stat-count">${rc}</span></div>` +
        `<div class="rg-divider">vs</div>` +
        `<div class="rg-stat"><span class="rg-stat-label">Top competitor</span><span class="rg-stat-count rg-top">${topCount}</span></div>` +
        `<div class="rg-divider">·</div>` +
        `<div class="rg-stat rg-gap-stat"><span class="rg-stat-label">Gap to close</span><span class="rg-stat-count rg-gap">${gap} reviews</span></div>` +
      `</div>`;
    panel.classList.remove('hidden');
  }

  async function scanWebsiteForProblems(contact) {
    const panel = el('marketing-problems');
    if (!panel) return;

    // Always show contact-data-only problems immediately (reviews, rating, SSL from URL)
    const contactOnlyProblems = analyzeWebsiteProblems(null, contact, null);
    if (contactOnlyProblems.length > 0) {
      renderMarketingProblems(contactOnlyProblems);
    }

    if (!contact.website) return;

    // Show scanning indicator
    panel.classList.remove('hidden');
    if (contactOnlyProblems.length === 0) {
      panel.innerHTML = `<div class="mkt-problems-scanning"><div class="spinner spinner-sm"></div> Scanning website…</div>`;
    }

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'LCP_SCAN_WEBSITE', url: contact.website });
      const h = resp.html ? resp.html.toLowerCase() : '';
      // Cache tech stack data for outreach prompt
      lastScanTechData = {
        hasFbPixel:    h.includes('fbevents.js') || h.includes('connect.facebook.net'),
        hasGoogleAds:  h.includes('googleadservices.com') || h.includes('google_conversion') || /aw-\d{9,}/.test(h),
        hasAnalytics:  h.includes('google-analytics.com') || h.includes('gtag(') || h.includes('gtag (') || h.includes('analytics.js') || h.includes('googletagmanager.com'),
        hasForm:       (h.includes('<form') && (/type=["']?(?:email|tel)/.test(h) || /name=["']?(?:email|phone|name|contact)/.test(h))),
        isHttps:       /^https:\/\//i.test(contact.website),
        loadMs:        resp.loadMs || null,
      };
      const fullProblems = analyzeWebsiteProblems(resp.html || null, contact, resp.loadMs);
      lastScanProblems = fullProblems;
      renderMarketingProblems(fullProblems, lastScanTechData);
    } catch (_) {
      // Scan failed — show what we have from contact data + a note
      if (contactOnlyProblems.length > 0) {
        const panel2 = el('marketing-problems');
        if (panel2 && !panel2.classList.contains('hidden')) {
          const existing = panel2.querySelector('.mkt-problems-note');
          if (existing) existing.textContent = 'Website scan blocked by this site — showing review data only.';
        }
      } else {
        panel.innerHTML = `<div class="mkt-problems-scanning">⚠️ Website scan blocked by this site.</div>`;
        panel.classList.remove('hidden');
      }
    }
  }

  function confidenceLabel_(confidence) {
    switch (confidence) {
      case 'tel-link': return 'from tel: link';
      case 'schema': return 'from structured data';
      case 'text': return 'from page text';
      case 'high': return 'high confidence';
      case 'medium': return 'medium confidence';
      case 'low': return 'low confidence';
      default: return confidence;
    }
  }

  // ---------------------------------------------------------------------------
  // Pipelines
  // ---------------------------------------------------------------------------

  async function loadPipelines() {
    const pipelineSelect = el('pipeline-select');

    // Check cache first
    const now = Date.now();
    if (pipelineCache && (now - pipelineCacheTime) < PIPELINE_CACHE_TTL) {
      pipelines = pipelineCache;
      populatePipelineDropdown(pipelineSelect);
      return;
    }

    pipelineSelect.innerHTML = '<option value="">Loading…</option>';
    pipelineSelect.disabled = true;

    try {
      const res = await sendMessage({
        type: 'GHL_GET_PIPELINES',
        // credentials read from storage by background.js — not sent over message bus
      });

      if (!res.success) throw new Error(res.error);
      pipelines = res.pipelines || [];

      // Save to cache
      pipelineCache = pipelines;
      pipelineCacheTime = Date.now();

      populatePipelineDropdown(pipelineSelect);
    } catch (e) {
      pipelineSelect.innerHTML = '<option value="">Failed to load pipelines</option>';
      pipelineSelect.disabled = false;
    }
  }

  function populatePipelineDropdown(pipelineSelect) {
    pipelineSelect.innerHTML = '<option value="">Select a pipeline</option>';
    pipelines.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      pipelineSelect.appendChild(opt);
    });

    // Pre-select default pipeline
    if (settings.defaultPipelineId) {
      pipelineSelect.value = settings.defaultPipelineId;
      onPipelineChange();
    }

    pipelineSelect.disabled = false;
  }

  function onPipelineChange() {
    const pipelineId = el('pipeline-select').value;
    const stageSelect = el('stage-select');

    if (!pipelineId) {
      stageSelect.innerHTML = '<option value="">Select a pipeline first</option>';
      stageSelect.disabled = true;
      return;
    }

    const pipeline = pipelines.find(p => p.id === pipelineId);
    const stages = (pipeline && pipeline.stages) ? pipeline.stages : [];

    stageSelect.innerHTML = '<option value="">Select a stage</option>';
    stages.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      stageSelect.appendChild(opt);
    });

    if (settings.defaultStageId) stageSelect.value = settings.defaultStageId;
    stageSelect.disabled = false;
  }

  // ---------------------------------------------------------------------------
  // Check GHL
  // ---------------------------------------------------------------------------

  async function checkGhl() {
    hideElement('existing-contact-banner');
    hideElement('not-found-banner');
    hideElement('error-banner');

    const phone = getSelectedOption('phone-select');
    const email = getSelectedOption('email-select');

    if (!phone && !email) {
      showError('Please select a phone number or email to check.');
      return;
    }

    // Check cache
    const cacheKey = `${phone || ''}|${email || ''}`;
    const cached = checkCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CHECK_CACHE_TTL) {
      displayCheckResult(cached.result);
      return;
    }

    setButtonLoading('check-btn', true);

    try {
      const res = await sendMessage({
        type: 'GHL_SEARCH_CONTACT',
        phone: phone || null,
        email: email || null,
      });

      if (!res.success) throw new Error(res.error);

      // Store in cache
      checkCache.set(cacheKey, { result: res, timestamp: Date.now() });

      displayCheckResult(res);
    } catch (e) {
      showError(friendlyError(e));
    } finally {
      setButtonLoading('check-btn', false);
    }
  }

  function displayCheckResult(res) {
    if (res.contact) {
      existingGhlContact = res.contact;
      const name = [res.contact.firstName, res.contact.lastName].filter(Boolean).join(' ')
        || res.contact.email || res.contact.phone || 'Unknown';
      el('existing-contact-name').textContent = name;
      el('existing-link').href = res.contactUrl || '#';

      // Date added
      if (res.contact.dateAdded) {
        const d = new Date(res.contact.dateAdded);
        const formatted = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        el('existing-contact-meta').textContent = 'Added ' + formatted;
      } else {
        el('existing-contact-meta').textContent = 'Date unknown';
      }

      // Tags as pills
      var tagsContainer = el('existing-contact-tags');
      tagsContainer.innerHTML = '';
      var ghlTags = res.contact.tags || [];
      ghlTags.forEach(function(tag) {
        var pill = document.createElement('span');
        pill.className = 'tag-pill';
        pill.textContent = tag;
        tagsContainer.appendChild(pill);
      });

      showElement('existing-contact-banner');
    } else {
      existingGhlContact = null;
      showElement('not-found-banner');
    }
  }

  // ---------------------------------------------------------------------------
  // Push to GHL
  // ---------------------------------------------------------------------------

  async function pushToGhl() {
    hideElement('success-banner');
    hideElement('error-banner');

    const contactData = buildContactPayload();

    if (!contactData.phone && !contactData.email) {
      showError('Please add at least a phone number or email address.');
      return;
    }

    setButtonLoading('push-btn', true);
    el('push-btn').disabled = true;

    try {
      const tags = parseTags();
      const pipelineId = el('pipeline-select').value || null;
      const stageId = el('stage-select').value || null;
      const userNote = el('f-note').value.trim() || null;
      const auditNote = buildAuditNote(selectedContact, lastScanProblems, lastScanTechData);

      const res = await sendMessage({
        type: 'GHL_PUSH_CONTACT',
        contactData,
        pipelineId,
        stageId,
        tags,
        userNote,
        auditNote,
        sourceUrl: selectedContact ? selectedContact.sourceUrl : window.location.href,
        sourcePlatform: source.label,
        reviewCount: selectedContact ? (selectedContact.reviewCount || null) : null,
        rating: selectedContact ? (selectedContact.rating || null) : null,
      });

      if (!res.success) throw new Error(res.error);

      if (res.exists) {
        sessionStats.existing++;
        updateSessionStats();
        // Contact already exists — show existing banner
        displayCheckResult(res);
      } else {
        sessionStats.pushed++;
        updateSessionStats();
        el('new-contact-link').href = res.contactUrl || '#';
        showElement('success-banner');
        hideElement('existing-contact-banner');
        hideElement('not-found-banner');
        el('push-btn').disabled = true;
        if (settings.autoOpenGhl && res.contactUrl) {
          chrome.tabs.create({ url: res.contactUrl, active: false });
        }
        chrome.storage.sync.set({ firstPushDone: true });

        // Enroll in workflow if selected
        const workflowId = el('workflow-select') ? el('workflow-select').value : null;
        if (workflowId && res.contactId) {
          chrome.runtime.sendMessage({ type: 'GHL_ADD_TO_WORKFLOW', contactId: res.contactId, workflowId })
            .catch(() => null);
        }
      }
    } catch (e) {
      showError(friendlyError(e));
      el('push-btn').disabled = false;
    } finally {
      setButtonLoading('push-btn', false);
    }
  }

  // ---------------------------------------------------------------------------
  // Update existing contact (merge mode — only fill blank fields, add tags)
  // ---------------------------------------------------------------------------

  async function updateExistingContact() {
    if (!existingGhlContact) return;

    hideElement('error-banner');
    setButtonLoading('push-btn', true);
    el('update-btn').disabled = true;

    try {
      const allNewTags = parseTags();
      const pipelineId = el('pipeline-select').value || null;
      const stageId = el('stage-select').value || null;
      const fullPayload = buildContactPayload();

      // Build merge payload — only include fields blank on the existing contact
      var mergePayload = {};
      var existing = existingGhlContact;

      if (!existing.firstName && !existing.lastName && fullPayload.name) {
        mergePayload.name = fullPayload.name;
        mergePayload.firstName = fullPayload.firstName;
        mergePayload.lastName = fullPayload.lastName;
      }
      if (!existing.phone && fullPayload.phone) {
        mergePayload.phone = fullPayload.phone;
      }
      if (!existing.email && fullPayload.email) {
        mergePayload.email = fullPayload.email;
      }
      if (!existing.address1 && fullPayload.address1) {
        mergePayload.address1 = fullPayload.address1;
      }
      if (!existing.website && fullPayload.website) {
        mergePayload.website = fullPayload.website;
      }
      if (!existing.companyName && fullPayload.companyName) {
        mergePayload.companyName = fullPayload.companyName;
      }

      const noteUrl = selectedContact ? selectedContact.sourceUrl : '';
      const userNote = el('f-note').value.trim() || null;
      const auditNote = buildAuditNote(selectedContact, lastScanProblems, lastScanTechData);

      const res = await sendMessage({
        type: 'GHL_UPDATE_CONTACT',
        contactId: existingGhlContact.id,
        contactData: mergePayload,
        mergeMode: true,
        additionalTags: allNewTags,
        pipelineId,
        stageId,
        userNote,
        auditNote,
        sourceUrl: noteUrl,
        sourcePlatform: source.label,
      });

      if (!res.success) throw new Error(res.error);

      // Enroll in workflow if selected
      const workflowId = el('workflow-select') ? el('workflow-select').value : null;
      if (workflowId && existingGhlContact.id) {
        chrome.runtime.sendMessage({ type: 'GHL_ADD_TO_WORKFLOW', contactId: existingGhlContact.id, workflowId })
          .catch(() => null);
      }

      sessionStats.pushed++;
      updateSessionStats();
      el('new-contact-link').href = res.contactUrl || '#';
      showElement('success-banner');
      hideElement('existing-contact-banner');
      if (settings.autoOpenGhl && res.contactUrl) {
        chrome.tabs.create({ url: res.contactUrl, active: false });
      }
      chrome.storage.sync.set({ firstPushDone: true });
    } catch (e) {
      showError(friendlyError(e));
    } finally {
      setButtonLoading('push-btn', false);
      el('update-btn').disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Manual Entry Mode
  // ---------------------------------------------------------------------------

  function enableManualEntry() {
    // Preserve scraped name, address, website — just replace selectors with editable inputs
    const currentPhone = getSelectedOption('phone-select') || '';
    const currentEmail = getSelectedOption('email-select') || '';

    // Replace phone selector with plain input pre-filled with selected value
    const phoneGroup = el('phone-field-group');
    phoneGroup.innerHTML = `
      <label class="field-label">Phone</label>
      <input type="tel" id="f-phone-manual" class="lcp-input" placeholder="(555) 123-4567" value="${escAttr(currentPhone)}">
    `;

    // Replace email selector with plain input pre-filled with selected value
    const emailGroup = el('email-field-group');
    emailGroup.innerHTML = `
      <label class="field-label">Email</label>
      <input type="email" id="f-email-manual" class="lcp-input" placeholder="name@business.com" value="${escAttr(currentEmail)}">
    `;

    // Hide manual entry button
    el('manual-entry-btn').style.display = 'none';

    // Set flag so buildContactPayload reads from manual inputs
    window._lcpManualMode = true;
  }

  // ---------------------------------------------------------------------------
  // Enrich — open Google search for the detected lead
  // ---------------------------------------------------------------------------

  async function searchWebForLead() {
    const name = el('f-name').value.trim();
    const address = el('f-address').value.trim();
    const website = el('f-website').value.trim();
    const phone = getSelectedOption('phone-select') || '';

    // Build the most useful query we can from available data
    let query = name || '';
    if (address) query += ' ' + address;
    if (!query && phone) query = phone;
    if (!query && website) query = website;
    if (!query && selectedContact) query = selectedContact.sourceUrl || '';
    if (!query) {
      // Fall back to current page URL
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const url = tabs[0] && tabs[0].url ? tabs[0].url : 'local business';
        openSearchTab(url);
      });
      return;
    }
    openSearchTab(query);
  }

  function openSearchTab(query) {
    const url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
    chrome.tabs.create({ url, active: true });
  }

  // ---------------------------------------------------------------------------
  // Skip Lead — dismiss without pushing
  // ---------------------------------------------------------------------------

  function skipLead() {
    // If we navigated here from the contact list, go back to it
    if (!el('back-btn').classList.contains('hidden')) {
      showView('contact-list-view');
      return;
    }
    // Single-contact session — show a brief "skipped" confirmation then reset
    hideElement('existing-contact-banner');
    hideElement('not-found-banner');
    hideElement('error-banner');
    hideElement('success-banner');
    const banner = el('success-banner');
    // Re-use the success banner with a neutral message
    banner.querySelector('.alert-title').textContent = 'Lead skipped.';
    const link = banner.querySelector('.alert-link');
    if (link) link.style.display = 'none';
    showElement('success-banner');
    el('push-btn').disabled = true;
    el('skip-lead-btn').disabled = true;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function normalizePhone(raw) {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length > 10) return `+1${digits.slice(-10)}`; // best-effort
    return digits.length >= 7 ? raw : null; // pass-through short numbers, let GHL validate
  }

  function buildContactPayload() {
    var phone, email;

    if (window._lcpManualMode) {
      var phoneEl = el('f-phone-manual');
      var emailEl = el('f-email-manual');
      phone = phoneEl ? phoneEl.value.trim() || null : null;
      email = emailEl ? emailEl.value.trim() || null : null;
    } else {
      phone = getSelectedOption('phone-select');
      email = getSelectedOption('email-select');
    }

    phone = normalizePhone(phone);

    const name = el('f-name').value.trim();

    let website = el('f-website').value.trim() || undefined;
    if (website && !/^https?:\/\//i.test(website)) {
      website = 'https://' + website;
    }

    // GHL v2 contact payload rules (hard-won from API testing):
    // - Always send firstName — GHL needs at least one name field to create a contact.
    // - When a real contact person is known: firstName=person, lastName=person, companyName=business.
    // - When business-only (no person): firstName=businessName ONLY — omit companyName entirely.
    //   Sending both companyName AND firstName with the same value causes 400.
    const personRaw = (el('f-contact-person') ? el('f-contact-person').value.trim() : '') || '';
    const personParts = personRaw.split(/\s+/).filter(Boolean);
    let firstName, lastName, companyName;
    if (personParts.length > 0) {
      // Real contact person — split name, add business as company
      firstName = personParts[0];
      lastName = personParts.length > 1 ? personParts.slice(1).join(' ') : undefined;
      companyName = name || undefined;
    } else {
      // Business-only contact — use business name as firstName, skip companyName
      firstName = name || undefined;
      companyName = undefined;
    }

    const raw = {
      firstName,
      lastName,
      companyName,
      phone: phone || undefined,
      email: email || undefined,
      address1: el('f-address').value.trim() || undefined,
      website,
    };
    // Strip undefined so structured-clone message passing sends a clean object
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  }

  function getSelectedOption(radioName) {
    const checked = document.querySelector(`input[name="${radioName}"]:checked`);
    return checked ? checked.value : null;
  }

  function parseTags() {
    const raw = el('tags-input').value;
    return raw.split(',').map(t => t.trim()).filter(Boolean);
  }

  function setButtonLoading(btnId, loading) {
    const btn = el(btnId);
    const label = btn.querySelector('.btn-label');
    const spin = btn.querySelector('.btn-spin');
    if (loading) {
      if (label) label.style.opacity = '0.5';
      if (spin) spin.classList.remove('hidden');
      btn.disabled = true;
    } else {
      if (label) label.style.opacity = '';
      if (spin) spin.classList.add('hidden');
      btn.disabled = false;
    }
  }

  function showError(msg) {
    el('error-message').textContent = msg || 'An unexpected error occurred.';
    showElement('error-banner');
  }

  function showElement(id) { el(id).classList.remove('hidden'); }
  function hideElement(id) { el(id).classList.add('hidden'); }

  function showView(viewId) {
    ['loading-view', 'setup-view', 'empty-view', 'contact-list-view', 'contact-detail-view']
      .forEach(id => {
        const v = el(id);
        if (v) {
          if (id === viewId) v.classList.remove('hidden');
          else v.classList.add('hidden');
        }
      });
  }

  function el(id) { return document.getElementById(id); }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(str) {
    return String(str).replace(/"/g, '&quot;');
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response || {});
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Audit Video
  // ---------------------------------------------------------------------------

  function openAuditVideo() {
    const website = el('f-website').value.trim() || (selectedContact && selectedContact.website) || '';

    // Open the business website in a background tab
    if (website) {
      const siteUrl = /^https?:\/\//i.test(website) ? website : 'https://' + website;
      chrome.tabs.create({ url: siteUrl, active: false });
    }

    // Open Loom recorder in the foreground
    // loom.com: logged-in users land on their dashboard (can start recording),
    // logged-out users land on the signup page — both cases handled correctly.
    chrome.tabs.create({ url: 'https://www.loom.com', active: true });

    // Show the audit panel in the sidebar
    renderAuditPanel();
  }

  function generateTalkingPoints() {
    const contact = selectedContact || {};
    const website = el('f-website').value.trim() || contact.website || '';
    const phone = getSelectedOption('phone-select') || (contact.phones && contact.phones[0] ? contact.phones[0].display : '');
    const email = getSelectedOption('email-select') || (contact.emails && contact.emails[0] ? contact.emails[0].display : '');
    const reviewCount = contact.reviewCount ? parseInt(contact.reviewCount, 10) : null;
    const rating = contact.rating ? parseFloat(contact.rating) : null;

    const points = [];

    if (!website) {
      points.push({ icon: '🌐', text: "No website — they're essentially invisible online. This is your strongest opener." });
    }
    if (!phone) {
      points.push({ icon: '📞', text: "Phone number missing — potential customers can't call them easily." });
    }
    if (!email) {
      points.push({ icon: '📧', text: "No email detected — they're likely losing form and inquiry leads." });
    }
    if (reviewCount !== null && reviewCount < 10) {
      points.push({ icon: '⭐', text: 'Only ' + (reviewCount || 0) + ' Google reviews — a review generation campaign would make a massive impact.' });
    } else if (reviewCount !== null && reviewCount < 50) {
      points.push({ icon: '⭐', text: reviewCount + ' reviews — solid start but room to grow. Show them how to 5x reviews in 90 days.' });
    }
    if (rating !== null && rating < 4.0) {
      points.push({ icon: '📊', text: rating + ' star rating — below the 4.0 trust threshold. Reputation repair + review strategy is a clear win.' });
    }

    if (points.length === 0) {
      points.push({ icon: '✅', text: 'This business looks established. Lead with ROI — show them how to squeeze more out of what they already have.' });
    }

    return points;
  }

  function renderAuditPanel() {
    const contact = selectedContact || {};
    const businessName = el('f-name').value.trim() || contact.businessName || 'Business';
    const website = el('f-website').value.trim() || contact.website || '';
    const phone = getSelectedOption('phone-select') || (contact.phones && contact.phones[0] ? contact.phones[0].display : '');
    const reviewCount = contact.reviewCount || null;
    const rating = contact.rating || null;

    // Lead info card
    const cardEl = el('audit-lead-card');
    const siteUrl = website ? (/^https?:\/\//i.test(website) ? website : 'https://' + website) : '';
    const siteDisplay = website ? website.replace(/^https?:\/\//i, '').replace(/\/$/, '') : '';
    cardEl.innerHTML =
      '<div class="audit-lead-name">' + escHtml(businessName) + '</div>' +
      '<div class="audit-lead-meta">' +
        (website
          ? '<span class="audit-meta-item">\uD83C\uDF10 <a href="' + escAttr(siteUrl) + '" target="_blank" rel="noopener">' + escHtml(siteDisplay) + '</a></span>'
          : '<span class="audit-meta-item muted">No website</span>') +
        (phone ? '<span class="audit-meta-item">\uD83D\uDCDE ' + escHtml(phone) + '</span>' : '') +
        (rating
          ? '<span class="audit-meta-item">\u2B50 ' + escHtml(String(rating)) +
              (reviewCount ? ' (' + escHtml(String(reviewCount)) + ' reviews)' : '') + '</span>'
          : '') +
      '</div>';

    // Talking points
    const points = generateTalkingPoints();
    const tpEl = el('audit-talking-points');
    tpEl.innerHTML = '<p class="audit-tp-title">Talking Points</p>' +
      points.map(function(p) {
        return '<div class="audit-tp-item"><span class="audit-tp-icon">' + p.icon + '</span><span>' + escHtml(p.text) + '</span></div>';
      }).join('');

    // Checklist
    var checklistItems = [
      'Website speed (mobile)',
      'Mobile layout & design',
      'SEO basics (title, H1, meta)',
      'Google reviews & responses',
      'Running paid ads?',
      'Clear call to action',
      'Contact info prominent',
      'Social proof / testimonials',
    ];
    var checklistEl = el('audit-checklist-items');
    checklistEl.innerHTML = checklistItems.map(function(item, i) {
      return '<label class="audit-check-item"><input type="checkbox" class="audit-cb" id="audit-cb-' + i + '"><span>' + escHtml(item) + '</span></label>';
    }).join('');

    // Show and scroll to panel
    el('audit-panel').classList.remove('hidden');
    setTimeout(function() {
      var panel = el('audit-panel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
  }

  // ---------------------------------------------------------------------------
  // JS Tooltip system
  // ---------------------------------------------------------------------------

  function initTooltips() {
    var tooltip = document.createElement('div');
    tooltip.className = 'lcp-tooltip-fixed';
    document.body.appendChild(tooltip);

    document.addEventListener('mouseover', function(e) {
      var icon = e.target.closest && e.target.closest('.tip-icon[data-tip]');
      if (!icon) return;
      var tip = icon.getAttribute('data-tip');
      if (!tip) return;
      tooltip.textContent = tip;
      tooltip.style.display = 'block';
      var r = icon.getBoundingClientRect();
      var tw = tooltip.offsetWidth;
      var th = tooltip.offsetHeight;
      var top = r.top - th - 8;
      var left = r.right - tw;
      if (top < 4) top = r.bottom + 8;
      if (left < 4) left = 4;
      if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
      tooltip.style.top = top + 'px';
      tooltip.style.left = left + 'px';
    });

    document.addEventListener('mouseout', function(e) {
      if (e.target.closest && e.target.closest('.tip-icon[data-tip]')) {
        tooltip.style.display = 'none';
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Static event listeners
  // ---------------------------------------------------------------------------

  function bindStaticListeners() {
    // Close button
    el('close-btn').addEventListener('click', () => {
      // Target '*' is intentional: the parent is the host page whose origin is unknown.
      // Messages contain no sensitive data; content.js validates the source on receipt.
      try {
        window.parent.postMessage({ type: 'LCP_CLOSE_SIDEBAR' }, '*');
      } catch (_) {}
      // Fallback: if sidebar was somehow opened outside an iframe, close the window
      if (window.parent === window) window.close();
    });

    // Settings button (footer)
    el('settings-btn').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    // Setup view — open settings
    el('open-settings-btn').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    // Back button
    el('back-btn').addEventListener('click', () => {
      showView('contact-list-view');
    });

    // Select-all checkbox (contact list view)
    el('select-all-cb').addEventListener('change', () => {
      const allChecked = el('select-all-cb').checked;
      document.querySelectorAll('.contact-cb:not(:disabled)').forEach(cb => {
        cb.checked = allChecked;
      });
      updateSelectedCount();
    });

    // Batch options toggle
    el('batch-options-toggle').addEventListener('click', () => {
      const panel = el('batch-options-panel');
      const chevron = el('batch-options-chevron');
      if (!panel) return;
      const isHidden = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !isHidden);
      if (chevron) chevron.style.transform = isHidden ? 'rotate(180deg)' : '';
      // Initialize batch tag pills on first open
      if (isHidden && !panel.dataset.pillsInit) {
        panel.dataset.pillsInit = '1';
        initTagPills('batch-tags-pill-container', 'batch-tags-pills', 'batch-tags-type-input', 'batch-tags-input', [], []);
      }
    });

    // Batch push button
    el('push-selected-btn').addEventListener('click', pushSelectedContacts);

    // Pipeline change
    el('pipeline-select').addEventListener('change', onPipelineChange);

    // Check GHL button
    el('check-btn').addEventListener('click', checkGhl);

    // Push to GHL button
    el('push-btn').addEventListener('click', pushToGhl);

    // Update existing contact
    el('update-btn').addEventListener('click', updateExistingContact);

    // Skip existing contact
    el('skip-btn').addEventListener('click', () => {
      hideElement('existing-contact-banner');
      existingGhlContact = null;
    });

    // Dismiss error
    el('error-dismiss').addEventListener('click', () => hideElement('error-banner'));

    // Manual entry button (in detail view)
    el('manual-entry-btn').addEventListener('click', enableManualEntry);

    // Skip lead button
    el('skip-lead-btn').addEventListener('click', skipLead);

    // Enrich / search web button
    el('enrich-btn').addEventListener('click', searchWebForLead);

    // Generate Outreach button — copy a personalized AI prompt to clipboard
    el('claude-btn').addEventListener('click', function() {
      if (!selectedContact) return;
      const name    = el('f-name').value.trim() || selectedContact.businessName || 'this business';
      const phone   = (selectedContact.phones && selectedContact.phones[0]) ? selectedContact.phones[0].display : 'N/A';
      const email   = (selectedContact.emails && selectedContact.emails[0]) ? selectedContact.emails[0].display : 'N/A';
      const website = el('f-website').value.trim() || null;
      const addr    = el('f-address').value.trim() || 'N/A';
      const rating  = selectedContact.rating || null;
      const reviews = selectedContact.reviewCount ? parseInt(selectedContact.reviewCount, 10) : null;
      const score   = computeMarketingScore(selectedContact);
      const label   = score >= 70 ? 'Hot Lead' : score >= 45 ? 'Warm Lead' : score >= 20 ? 'Cold Lead' : 'Pass';

      // Build marketing gaps section from cached scan + contact data
      const gapLines = [];
      if (lastScanProblems && lastScanProblems.length > 0) {
        lastScanProblems.forEach(p => gapLines.push('- ' + p.text));
      } else {
        // Fallback: derive from contact data alone
        if (!website) gapLines.push('- No website');
        if (reviews !== null && reviews < 10) gapLines.push('- Only ' + (reviews || 0) + ' Google reviews');
        if (rating !== null && rating < 4.0) gapLines.push('- Low rating: ' + rating + '\u2605');
      }

      // Tech stack section
      const techLines = [];
      if (lastScanTechData) {
        techLines.push('Facebook Pixel: ' + (lastScanTechData.hasFbPixel ? 'Detected' : 'Not detected in page code'));
        techLines.push('Google Ads tag: ' + (lastScanTechData.hasGoogleAds ? 'Detected' : 'Not detected'));
        techLines.push('Analytics: ' + (lastScanTechData.hasAnalytics ? 'Detected' : 'Not detected'));
        techLines.push('Lead capture form: ' + (lastScanTechData.hasForm ? 'Present' : 'Not found'));
        techLines.push('SSL/HTTPS: ' + (lastScanTechData.isHttps ? 'Secure' : 'Not secure (HTTP only)'));
        if (lastScanTechData.loadMs && lastScanTechData.loadMs > 2000) {
          techLines.push('Page speed: ' + (lastScanTechData.loadMs / 1000).toFixed(1) + 's load time (slow)');
        }
      } else if (website) {
        techLines.push('(Website scan not yet complete — tech stack data unavailable)');
      } else {
        techLines.push('No website detected');
      }

      // Review gap section
      const others = contacts.filter(c =>
        c !== selectedContact &&
        c.businessName !== selectedContact.businessName &&
        c.reviewCount && parseInt(c.reviewCount, 10) > 0
      );
      const reviewGapLines = [];
      if (reviews !== null && others.length > 0) {
        const topCount = Math.max(...others.map(c => parseInt(c.reviewCount, 10)));
        const gap = topCount - reviews;
        if (gap > 0) {
          reviewGapLines.push('This business: ' + reviews + ' reviews');
          reviewGapLines.push('Top local competitor: ' + topCount + ' reviews');
          reviewGapLines.push('Gap to close: ' + gap + ' reviews');
        }
      }

      const needsReputation = reviews !== null && reviews <= 50;

      const lines = [
        'You are an expert local marketing agency outreach specialist. I am prospecting the business below.',
        '',
        'STEP 1: Enrich the lead. Based on the business name, website, and address below, infer:',
        '- Industry/niche (be specific: e.g. "residential roofing contractor" not just "contractor")',
        '- Likely owner name or decision-maker title',
        '- Their probable pain points based on the data gaps I found',
        '- What a $1,000–$3,000/month marketing retainer would realistically do for their revenue',
        '',
        'STEP 2: Generate all 6 outreach pieces below using the enriched profile.',
        '',
        '== BUSINESS PROFILE ==',
        'Name: ' + name,
        'Website: ' + (website || 'No website'),
        'Phone: ' + phone,
        'Email: ' + email,
        'Address: ' + addr,
        'Google Rating: ' + (rating ? rating + '\u2605 (' + reviews + ' reviews)' : 'Not available'),
        'Opportunity Score: ' + score + '/100 (' + label + ')',
        'Found via: ' + source.label,
        '',
        '== MARKETING GAPS DETECTED ==',
      ];
      if (gapLines.length > 0) {
        gapLines.forEach(l => lines.push(l));
      } else {
        lines.push('- No major gaps detected from available data');
      }
      lines.push('');
      lines.push('== TECH STACK STATUS ==');
      techLines.forEach(l => lines.push('- ' + l));

      if (reviewGapLines.length > 0) {
        lines.push('');
        lines.push('== REVIEW GAP ==');
        reviewGapLines.forEach(l => lines.push('- ' + l));
      }

      if (needsReputation) {
        lines.push('');
        lines.push('== REPUTATION OPPORTUNITY ==');
        lines.push('This business has ' + (reviews || 0) + ' Google reviews — well below the local average.');
        lines.push('Include reputation management as a core service pitch: review generation system, responding to reviews, protecting their star rating.');
        lines.push('Frame it as the fastest path to more inbound calls without any ad spend.');
      }

      lines.push('');
      lines.push('== OUTREACH FRAMEWORK ==');
      lines.push('Use Jeremy Miner\'s NEPQ (Neuro-Emotional Persuasion Questions) principles:');
      lines.push('- Ask questions that create self-awareness of the problem, not statements that trigger resistance');
      lines.push('- Use "How long has...?", "What have you tried...?", "What would it mean for you if...?" style questions');
      lines.push('- Never pitch first — lead with a specific observation, then ask a curious question');
      lines.push('- CTAs must be VIDEO-FIRST in 2026. No "hop on a call". Use: "Worth a quick look?", "Want me to send over the video?", "I recorded something for you — want it?"');
      lines.push('');
      lines.push('Use Alex Hormozi\'s value equation framing for any offer mentions:');
      lines.push('- Dream outcome: what they actually want (more customers, more calls, look credible)');
      lines.push('- Perceived likelihood: show social proof or a specific result you\'ve gotten');
      lines.push('- Time delay: how fast they\'ll see results');
      lines.push('- Effort/sacrifice: make it sound easy for them — "I do the work, you see the results"');
      lines.push('');
      lines.push('== GENERATE ALL 6 OF THESE ==');
      lines.push('');
      lines.push('1. COLD EMAIL');
      lines.push('Subject line: [pattern-interrupt, hyper-specific to their situation, not clickbait]');
      lines.push('Body: [3-4 sentences max. One specific observation. One NEPQ curiosity question. Video-first CTA — offer the Loom before asking for any time.]');
      lines.push('');
      lines.push('2. SMS (under 160 chars)');
      lines.push('[Name, specific hook from the data, Loom link placeholder, low-friction ask. No pitch.]');
      lines.push('');
      lines.push('3. FACEBOOK DM');
      lines.push('[Casual, warm, peer-to-peer tone. Reference something from their Facebook page if possible. One honest observation. Ask if they want the video. No pitch, no links yet.]');
      lines.push('');
      lines.push('4. INSTAGRAM DM');
      lines.push('[Very short. Compliment something real. One NEPQ question that surfaces their pain. Soft CTA — "I recorded something for you, want me to drop the link?"]');
      lines.push('');
      lines.push('5. LINKEDIN DM');
      lines.push('[Professional, credibility-first. Reference their industry + one specific data point. Connect-request style. Offer to share the audit video, not a call.]');
      lines.push('');
      lines.push('6. LOOM AUDIT VIDEO SCRIPT (2–3 min read-aloud script)');
      lines.push('[Warm intro → specific findings from the data above → 2-3 gaps they probably don\'t know about → quick-win you\'d deliver in 30 days → Hormozi offer frame → low-friction CTA: "Reply and I\'ll send you the full breakdown — no call needed"]');
      lines.push('');
      lines.push('IMPORTANT: Every message must reference specific data points from the profile above. No generic placeholders like [Business Name]. Use the real name. Make it feel like I spent 20 minutes on this business.');

      const prompt = lines.join('\n');

      // Always show the modal so the prompt is visible regardless of clipboard state
      const modalText = el('outreach-modal-text');
      if (modalText) modalText.value = prompt;
      const modal = el('outreach-modal');
      if (modal) modal.classList.remove('hidden');

      // Also try to copy to clipboard
      navigator.clipboard.writeText(prompt).then(function() {
        var copyBtn = el('outreach-modal-copy');
        if (copyBtn) {
          copyBtn.textContent = 'Copied!';
          setTimeout(function() { copyBtn.textContent = 'Copy Prompt'; }, 2500);
        }
      }).catch(function() {
        // Modal is open — user can select all and copy manually
      });
    });

    // Outreach modal close
    el('outreach-modal-close').addEventListener('click', function() {
      el('outreach-modal').classList.add('hidden');
    });
    el('outreach-modal').querySelector('.outreach-modal-backdrop').addEventListener('click', function() {
      el('outreach-modal').classList.add('hidden');
    });
    el('outreach-modal-copy').addEventListener('click', function() {
      const txt = el('outreach-modal-text');
      if (!txt) return;
      navigator.clipboard.writeText(txt.value).then(function() {
        var btn = el('outreach-modal-copy');
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy Prompt'; }, 2500);
      }).catch(function() {
        txt.select(); // let user copy manually if needed
      });
    });

    // Audit video button
    el('audit-video-btn').addEventListener('click', openAuditVideo);

    // Audit panel close
    el('audit-panel-close').addEventListener('click', function() {
      el('audit-panel').classList.add('hidden');
    });

    // Manual entry from empty state
    el('manual-from-empty-btn').addEventListener('click', () => {
      // Create a blank contact to render the detail view
      selectedContact = { businessName: '', phones: [], emails: [], address: '', website: '' };
      el('back-btn').classList.add('hidden');
      renderDetailView(selectedContact);
      showView('contact-detail-view');
      // Immediately enable manual entry
      enableManualEntry();
      // Load pipelines if not yet loaded
      loadPipelines();
    });

    // Daily prospecting tips toggle
    const dpsTipsToggle = el('dps-tips-toggle');
    if (dpsTipsToggle) {
      dpsTipsToggle.addEventListener('click', () => {
        const body = el('dps-tips-body');
        const chevron = dpsTipsToggle.querySelector('.dps-tips-chevron');
        body.classList.toggle('hidden');
        if (chevron) chevron.textContent = body.classList.contains('hidden') ? '▼' : '▲';
      });
    }
  }

})();
