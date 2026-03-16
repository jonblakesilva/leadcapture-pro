/**
 * LeadCapture Pro — Settings Page Script
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // YOUR affiliate links — hardcoded, not editable by agency owners.
  // When you get your referral codes, update these four URLs and rebuild the zip.
  // ---------------------------------------------------------------------------
  const AFFILIATE_LINKS = {
    ghl:       'https://www.gohighlevel.com/',         // TODO: add ?fp_ref=YOURCODE
    loom:      'https://www.loom.com/',                // TODO: add ?via=YOURCODE
    descript:  'https://www.descript.com/',            // TODO: add ?via=YOURCODE
    instantly: 'https://instantly.ai/',                // TODO: add ?via=YOURCODE
  };

  let currentStep = 1;
  const TOTAL_STEPS = 5;
  let settings = {};
  let pipelines = [];
  let locationProfiles = [];
  let _settingsTagPillState = null; // pill system state ref

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', async () => {
    settings = await loadSettings();
    locationProfiles = settings.locationProfiles
      ? JSON.parse(settings.locationProfiles)
      : [];

    populateForm(settings);
    applyPreviewBranding();
    bindListeners();
    renderProfiles();
    goToStep(1, false);

    // Try to load pipelines and GHL tags if credentials exist
    if (settings.ghlApiKey && settings.ghlLocationId) {
      loadPipelines();
      fetchGhlTagsIfNeeded();
    }
  });

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  function loadSettings() {
    return new Promise(resolve => chrome.storage.sync.get(null, data => resolve(data || {})));
  }

  // Change 2: saveSettings with logo URL validation
  async function saveSettings() {
    const data = collectFormData();

    // Validate logo URL before saving
    const logoUrl = getVal('agency-logo');
    if (logoUrl) {
      const logoValid = await validateLogoUrl(logoUrl);
      if (!logoValid) {
        showFieldWarning('agency-logo', 'Logo URL could not be loaded. The URL has been saved but may not display correctly.');
      }
    }

    await new Promise(resolve => chrome.storage.sync.set(data, resolve));
    settings = { ...settings, ...data };

    // "Saved! ✓" button feedback
    const saveBtn = el('save-btn');
    if (saveBtn) {
      const origText = saveBtn.textContent;
      saveBtn.textContent = 'Saved! ✓';
      saveBtn.disabled = true;
      setTimeout(() => {
        saveBtn.textContent = origText;
        saveBtn.disabled = false;
      }, 2000);
    }
    showSaveToast();
  }

  // Change 2: Logo URL image validator
  async function validateLogoUrl(url) {
    if (!url) return true; // empty is fine
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
      setTimeout(() => resolve(false), 5000); // 5s timeout
    });
  }

  // Change 2: Field warning helper
  function showFieldWarning(fieldId, msg) {
    // Remove any existing warning for this field
    const existing = document.getElementById(`field-warning-${fieldId}`);
    if (existing) existing.remove();

    const field = el(fieldId);
    if (!field) return;

    const warning = document.createElement('p');
    warning.id = `field-warning-${fieldId}`;
    warning.className = 'field-warning';
    warning.innerHTML = `⚠ ${escHtml(msg)}`;
    field.parentNode.insertAdjacentElement('afterend', warning);

    setTimeout(() => {
      const w = document.getElementById(`field-warning-${fieldId}`);
      if (w) w.remove();
    }, 4000);
  }

  // ---------------------------------------------------------------------------
  // GHL tags fetch (non-blocking, called once credentials are confirmed)
  // ---------------------------------------------------------------------------

  let _ghlTagsCache = null;

  function fetchGhlTagsIfNeeded() {
    if (_ghlTagsCache !== null) return;
    _ghlTagsCache = [];
    chrome.runtime.sendMessage({ type: 'GHL_GET_TAGS' }, response => {
      if (chrome.runtime.lastError) return;
      _ghlTagsCache = (response && response.tags) ? response.tags : [];
      // Refresh suggestion pool if pill input already rendered
      if (_settingsTagPillState) _settingsTagPillState.refreshSuggestions();
    });
  }

  // ---------------------------------------------------------------------------
  // Default-tags pill input
  // ---------------------------------------------------------------------------

  function initSettingsTagPills(initialTagsString) {
    const pillsDiv  = el('default-tags-pills');
    const typeInput = el('default-tags-type-input');
    const hidden    = el('default-tags');
    const container = el('default-tags-pill-container');
    if (!pillsDiv || !typeInput || !hidden) return;

    let tags = initialTagsString
      ? initialTagsString.split(',').map(t => t.trim()).filter(Boolean)
      : [];

    // Suggestions dropdown element (created once inside container)
    let suggestEl = container ? container.querySelector('.s-tag-suggestions') : null;
    if (!suggestEl && container) {
      suggestEl = document.createElement('div');
      suggestEl.className = 's-tag-suggestions hidden';
      container.appendChild(suggestEl);
    }
    let activeSuggIdx = -1;

    function hideSugg() { if (suggestEl) { suggestEl.classList.add('hidden'); activeSuggIdx = -1; } }

    function showSugg(query) {
      if (!suggestEl || !query) { hideSugg(); return; }
      const pool = _ghlTagsCache || [];
      const current = new Set(tags);
      const matches = pool.filter(t => t.toLowerCase().includes(query.toLowerCase()) && !current.has(t)).slice(0, 8);
      if (!matches.length) { hideSugg(); return; }

      suggestEl.innerHTML = '';
      activeSuggIdx = -1;
      matches.forEach(tag => {
        const item = document.createElement('div');
        item.className = 's-tag-suggest-item';
        const idx = tag.toLowerCase().indexOf(query.toLowerCase());
        item.innerHTML = escHtml(tag.slice(0, idx))
          + `<mark>${escHtml(tag.slice(idx, idx + query.length))}</mark>`
          + escHtml(tag.slice(idx + query.length));
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          addTag(tag);
          typeInput.value = '';
          hideSugg();
          typeInput.focus();
        });
        suggestEl.appendChild(item);
      });
      suggestEl.classList.remove('hidden');
    }

    function setActiveSugg(idx) {
      const items = suggestEl ? suggestEl.querySelectorAll('.s-tag-suggest-item') : [];
      items.forEach(it => it.classList.remove('active'));
      activeSuggIdx = Math.max(-1, Math.min(items.length - 1, idx));
      if (activeSuggIdx >= 0) items[activeSuggIdx].classList.add('active');
    }

    function renderPills() {
      pillsDiv.innerHTML = '';
      tags.forEach((tag, i) => {
        const pill = document.createElement('span');
        pill.className = 's-pill s-pill-user';
        const labelSpan = document.createElement('span');
        labelSpan.textContent = tag;
        const removeBtn = document.createElement('button');
        removeBtn.className = 's-pill-remove';
        removeBtn.dataset.i = String(i);
        removeBtn.title = 'Remove';
        removeBtn.textContent = '×';
        pill.appendChild(labelSpan);
        pill.appendChild(removeBtn);
        pillsDiv.appendChild(pill);
      });
      hidden.value = tags.join(',');
    }

    function addTag(raw) {
      const tag = raw.trim().toLowerCase()
        .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      if (!tag || tags.includes(tag) || tags.length >= 20) return;
      tags.push(tag);
      renderPills();
    }

    if (_settingsTagPillState) {
      _settingsTagPillState.setTags(tags);
      return;
    }

    pillsDiv.addEventListener('click', e => {
      const btn = e.target.closest('.s-pill-remove');
      if (!btn) return;
      tags.splice(Number(btn.dataset.i), 1);
      renderPills();
    });

    typeInput.addEventListener('input', () => showSugg(typeInput.value.trim()));

    typeInput.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveSugg(activeSuggIdx + 1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveSugg(activeSuggIdx - 1); return; }
      if (e.key === 'Escape')    { hideSugg(); return; }
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const items = suggestEl ? suggestEl.querySelectorAll('.s-tag-suggest-item') : [];
        if (activeSuggIdx >= 0 && items[activeSuggIdx]) {
          addTag(items[activeSuggIdx].textContent);
        } else {
          addTag(typeInput.value);
        }
        typeInput.value = '';
        hideSugg();
      } else if (e.key === 'Backspace' && typeInput.value === '' && tags.length > 0) {
        tags.pop();
        renderPills();
      }
    });

    typeInput.addEventListener('blur', () => {
      setTimeout(() => {
        hideSugg();
        if (typeInput.value.trim()) { addTag(typeInput.value); typeInput.value = ''; }
      }, 150);
    });

    if (container) container.addEventListener('click', e => {
      if (!e.target.closest('.s-pill-remove')) typeInput.focus();
    });

    _settingsTagPillState = {
      setTags(newTags) { tags = newTags; renderPills(); },
      refreshSuggestions() { if (typeInput.value.trim()) showSugg(typeInput.value.trim()); },
    };
    renderPills();
  }

  // ---------------------------------------------------------------------------
  // Form population
  // ---------------------------------------------------------------------------

  function populateForm(s) {
    setVal('agency-name', s.agencyName || '');
    setVal('crm-name', s.crmName || '');
    setVal('agency-logo', s.agencyLogo || '');
    setVal('brand-color', s.brandColor || '#2563eb');
    setVal('ghl-api-key', s.ghlApiKey || '');
    setVal('ghl-location-id', s.ghlLocationId || '');
    setVal('agency-website', s.agencyWebsite || '');
    const autoOpenEl = el('auto-open-ghl');
    if (autoOpenEl) autoOpenEl.checked = !!s.autoOpenGhl;
    // Affiliate buttons are hardcoded — set hrefs from AFFILIATE_LINKS constant
    [['affiliate-ghl-btn', AFFILIATE_LINKS.ghl], ['affiliate-loom-btn', AFFILIATE_LINKS.loom],
     ['affiliate-descript-btn', AFFILIATE_LINKS.descript], ['affiliate-instantly-btn', AFFILIATE_LINKS.instantly]]
    .forEach(([btnId, url]) => { const b = el(btnId); if (b) b.href = url; });
    updateChecklist(s);
    initSettingsTagPills(s.defaultTags || '');

    const colorPicker = el('brand-color-picker');
    if (colorPicker) colorPicker.value = s.brandColor || '#2563eb';

    // Sync character counter after populating
    const apiKeyInput = el('ghl-api-key');
    if (apiKeyInput) {
      const len = apiKeyInput.value.length;
      const countEl = el('api-key-count');
      const statusEl = el('api-key-status');
      if (countEl) countEl.textContent = len;
      if (statusEl) {
        if (len === 0) { statusEl.textContent = ''; statusEl.className = ''; }
        else if (len < 50) { statusEl.textContent = '(too short?)'; statusEl.className = 'hint-warn'; }
        else { statusEl.textContent = '✓'; statusEl.className = 'hint-ok'; }
      }
    }
  }

  function collectFormData() {
    return {
      agencyName: getVal('agency-name'),
      crmName: getVal('crm-name'),
      agencyLogo: getVal('agency-logo'),
      brandColor: getVal('brand-color') || '#2563eb',
      ghlApiKey: getVal('ghl-api-key'),
      ghlLocationId: getVal('ghl-location-id'),
      defaultTags: getVal('default-tags'),
      defaultPipelineId: getVal('default-pipeline'),
      defaultStageId: getVal('default-stage'),
      autoOpenGhl: el('auto-open-ghl') ? el('auto-open-ghl').checked : false,
      agencyWebsite: getVal('agency-website'),
      locationProfiles: JSON.stringify(locationProfiles),
    };
  }


  // ---------------------------------------------------------------------------
  // Getting Started checklist
  // ---------------------------------------------------------------------------

  function updateChecklist(s) {
    function setDone(id, done) {
      const item = document.getElementById(id);
      if (!item) return;
      item.classList.toggle('done', done);
      const icon = item.querySelector('.check-icon');
      if (icon) icon.textContent = done ? '✓' : '○';
      const btn = item.querySelector('.check-goto');
      if (btn) btn.style.display = done ? 'none' : '';
    }
    setDone('check-branding', !!(s.agencyName && s.agencyName.trim()));
    setDone('check-api', !!(s.ghlApiKey && s.ghlApiKey.length > 20));
    setDone('check-connection', !!s.connectionVerified);
    setDone('check-pipeline', !!(s.defaultPipelineId && s.defaultPipelineId !== ''));
    setDone('check-first-push', !!s.firstPushDone);

    const allDone = ['check-branding','check-api','check-connection','check-pipeline','check-first-push']
      .every(id => document.getElementById(id) && document.getElementById(id).classList.contains('done'));
    const checklist = document.getElementById('setup-checklist');
    if (checklist) checklist.style.display = allDone ? 'none' : '';
  }

  // ---------------------------------------------------------------------------
  // Step navigation
  // ---------------------------------------------------------------------------

  function goToStep(step, animate = true) {
    currentStep = Math.max(1, Math.min(TOTAL_STEPS, step));

    // Update panels
    document.querySelectorAll('.step-panel').forEach(panel => {
      panel.classList.toggle('active', Number(panel.dataset.step) === currentStep);
    });

    // Update nav items
    document.querySelectorAll('.step-nav-item').forEach(item => {
      const n = Number(item.dataset.step);
      item.classList.toggle('active', n === currentStep);
      item.classList.toggle('completed', n < currentStep);
    });

    // Update footer buttons
    el('prev-btn').disabled = currentStep === 1;
    el('next-btn').style.display = currentStep === TOTAL_STEPS ? 'none' : '';
    el('save-btn').style.display = '';

    // Step-specific actions
    if (currentStep === 3 && pipelines.length === 0 && settings.ghlApiKey) {
      loadPipelines();
    }
  }

  // ---------------------------------------------------------------------------
  // Branding preview
  // ---------------------------------------------------------------------------

  function applyPreviewBranding() {
    const color = getVal('brand-color') || '#2563eb';
    const name = getVal('agency-name') || 'LeadCapture Pro';
    const logoUrl = getVal('agency-logo');
    const crmName = getVal('crm-name') || 'GHL';

    el('preview-header').style.background = color;
    el('preview-btn').style.background = color;
    el('preview-btn').textContent = `Push to ${crmName}`;
    el('preview-name').textContent = name;
    el('preview-footer-name').textContent = name;
    el('header-title').textContent = name;

    const safeLogoUrl = logoUrl && /^https?:\/\//i.test(logoUrl) ? logoUrl : null;
    const previewLogo = el('preview-logo');
    if (safeLogoUrl) {
      previewLogo.style.backgroundImage = `url(${safeLogoUrl})`;
      previewLogo.style.backgroundSize = 'cover';
      previewLogo.hidden = false;
    } else {
      previewLogo.hidden = true;
    }

    const headerLogo = el('header-logo');
    if (safeLogoUrl) {
      headerLogo.src = safeLogoUrl;
      headerLogo.hidden = false;
      headerLogo.onerror = () => { headerLogo.hidden = true; };
    }
  }

  // ---------------------------------------------------------------------------
  // GHL connection test
  // ---------------------------------------------------------------------------

  async function testConnection() {
    const apiKey = getVal('ghl-api-key').trim();
    const locationId = getVal('ghl-location-id').trim();
    const resultEl = el('connection-result');

    if (!apiKey || !locationId) {
      showConnectionResult(false, 'Please enter both API key and Location ID.');
      return;
    }

    setButtonLoading('test-connection-btn', true);
    resultEl.classList.add('hidden');

    try {
      const res = await sendMessage({
        type: 'GHL_TEST_CONNECTION',
        apiKey,
        locationId,
      });

      if (res.success && res.ok) {
        showConnectionResult(true, `✓ Connected to "${res.locationName}"`);
        chrome.storage.sync.set({ connectionVerified: true });
        updateChecklist(Object.assign({}, settings, { connectionVerified: true }));
        // Save creds and load pipelines
        settings.ghlApiKey = apiKey;
        settings.ghlLocationId = locationId;
        await new Promise(r => chrome.storage.sync.set({ ghlApiKey: apiKey, ghlLocationId: locationId }, r));
        loadPipelines();
        fetchGhlTagsIfNeeded();
        markStepCompleted(2);
      } else {
        showConnectionResult(false, `✗ ${res.error || 'Connection failed'}`);
      }
    } catch (e) {
      showConnectionResult(false, `✗ ${e.message}`);
    } finally {
      setButtonLoading('test-connection-btn', false);
    }
  }

  function showConnectionResult(success, message) {
    const el_ = el('connection-result');
    el_.textContent = message;
    el_.className = `connection-result ${success ? 'success' : 'error'}`;
    el_.classList.remove('hidden');
  }

  function markStepCompleted(stepNum) {
    const navItem = document.querySelector(`.step-nav-item[data-step="${stepNum}"]`);
    if (navItem && stepNum < currentStep) navItem.classList.add('completed');
  }

  // ---------------------------------------------------------------------------
  // Pipeline loading
  // ---------------------------------------------------------------------------

  async function loadPipelines() {
    const pipelineSelect = el('default-pipeline');
    const stageSelect = el('default-stage');

    if (!pipelineSelect) return;

    pipelineSelect.innerHTML = '<option value="">Loading…</option>';
    pipelineSelect.disabled = true;

    try {
      const res = await sendMessage({
        type: 'GHL_GET_PIPELINES',
        // credentials read from storage by background.js — not sent over message bus
      });

      if (!res.success) throw new Error(res.error);
      pipelines = res.pipelines || [];

      pipelineSelect.innerHTML = '<option value="">None — user selects each time</option>';
      pipelines.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        pipelineSelect.appendChild(opt);
      });

      if (settings.defaultPipelineId) {
        pipelineSelect.value = settings.defaultPipelineId;
        onPipelineChange();
      }

      pipelineSelect.disabled = false;
    } catch (_) {
      pipelineSelect.innerHTML = '<option value="">Could not load (check credentials)</option>';
      pipelineSelect.disabled = false;
    }
  }

  function onPipelineChange() {
    const pipelineId = getVal('default-pipeline');
    const stageSelect = el('default-stage');

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
  // Location profiles
  // ---------------------------------------------------------------------------

  // Change 6: renderProfiles shows profile name prominently and location ID truncated,
  //           plus "last used" timestamp if available
  function renderProfiles() {
    const list = el('profiles-list');
    if (!list) return;
    list.innerHTML = '';

    if (locationProfiles.length === 0) {
      list.innerHTML = `<p class="profiles-empty">No profiles added yet.</p>`;
      return;
    }

    locationProfiles.forEach((profile, i) => {
      const div = document.createElement('div');
      div.className = 'profile-item';

      let subLine = `Location: ${escHtml(profile.locationId.slice(0, 20))}…`;
      if (profile.lastUsed) {
        const daysAgo = Math.floor((Date.now() - profile.lastUsed) / 86400000);
        const lastUsedText = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
        subLine += ` · Last used: ${lastUsedText}`;
      }

      div.innerHTML = `
        <div>
          <div class="profile-item-name">${escHtml(profile.name)}</div>
          <div class="profile-item-sub">${subLine}</div>
        </div>
        <button class="profile-item-del" data-index="${i}" title="Remove profile">✕</button>
      `;
      list.appendChild(div);
    });

    list.querySelectorAll('.profile-item-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.index);
        locationProfiles.splice(i, 1);
        renderProfiles();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Profile modal
  // ---------------------------------------------------------------------------

  function openProfileModal() {
    setVal('profile-name', '');
    setVal('profile-api-key', '');
    setVal('profile-location-id', '');
    el('profile-modal').classList.remove('hidden');
  }

  function closeProfileModal() {
    el('profile-modal').classList.add('hidden');
  }

  function saveProfile() {
    const name = getVal('profile-name').trim();
    const apiKey = getVal('profile-api-key').trim();
    const locationId = getVal('profile-location-id').trim();

    if (!name || !apiKey || !locationId) {
      alert('Please fill in all fields.');
      return;
    }

    locationProfiles.push({ name, apiKey, locationId });
    renderProfiles();
    closeProfileModal();
  }

  // ---------------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------------

  // Change 4: exportSettings strips API key for security
  async function exportSettings() {
    const data = await loadSettings();

    // Security: exclude API keys from export
    const exportData = { ...data };
    delete exportData.ghlApiKey;
    // Also remove API keys from location profiles
    if (exportData.locationProfiles) {
      try {
        const profiles = JSON.parse(exportData.locationProfiles);
        exportData.locationProfiles = JSON.stringify(
          profiles.map(p => ({ ...p, apiKey: '' }))
        );
      } catch (_) {}
    }

    // Add version for future compatibility
    exportData._version = chrome.runtime.getManifest().version;
    exportData._exportedAt = new Date().toISOString();

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leadcapture-pro-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  // Change 5: importSettings with structure validation and diff preview
  function importSettings(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async e => {
      let imported;
      try {
        imported = JSON.parse(e.target.result);
      } catch (_) {
        showImportError('Invalid JSON file. Please use a file exported from LeadCapture Pro.');
        return;
      }

      // Validate structure
      const knownKeys = ['agencyName', 'crmName', 'agencyLogo', 'brandColor', 'ghlLocationId',
                         'defaultTags', 'defaultPipelineId', 'defaultStageId',
                         'locationProfiles', '_version', '_exportedAt'];
      const validKeys = Object.keys(imported).filter(k => knownKeys.includes(k));
      if (validKeys.length === 0) {
        showImportError('This file does not appear to be a valid LeadCapture Pro settings export.');
        return;
      }

      // Build diff summary
      const current = await loadSettings();
      const changes = [];
      if (imported.agencyName && imported.agencyName !== current.agencyName)
        changes.push(`Agency Name: "${current.agencyName || '(none)'}" → "${imported.agencyName}"`);
      if (imported.brandColor && imported.brandColor !== current.brandColor)
        changes.push(`Brand Color: ${current.brandColor || '(none)'} → ${imported.brandColor}`);
      if (imported.ghlLocationId && imported.ghlLocationId !== current.ghlLocationId)
        changes.push(`Location ID: will be updated`);
      if (changes.length === 0) changes.push('No visible changes detected.');

      const confirmed = confirm(
        `Import settings?\n\nChanges:\n• ${changes.join('\n• ')}\n\nNote: Your API key will NOT be changed.`
      );
      if (!confirmed) return;

      // Apply import (preserve current API key)
      const toApply = { ...imported };
      delete toApply.ghlApiKey; // never overwrite API key from import
      delete toApply._version;
      delete toApply._exportedAt;

      chrome.storage.sync.set(toApply, () => {
        settings = { ...settings, ...toApply };
        locationProfiles = toApply.locationProfiles ? JSON.parse(toApply.locationProfiles) : locationProfiles;
        populateForm({ ...settings, ...toApply });
        applyPreviewBranding();
        renderProfiles();
        showSaveToast('Settings imported successfully!');
      });
    };
    reader.readAsText(file);
  }

  function showImportError(msg) {
    alert(msg);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function showSaveToast(msg) {
    const toast = el('save-toast');
    if (msg) {
      toast.querySelector('svg').nextSibling.textContent = ` ${msg}`;
    }
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 2500);
  }

  function setButtonLoading(btnId, loading) {
    const btn = el(btnId);
    const label = btn.querySelector('.btn-label');
    const spin = btn.querySelector('.btn-spin');
    btn.disabled = loading;
    if (label) label.style.opacity = loading ? '0.5' : '';
    if (spin) spin.classList.toggle('hidden', !loading);
  }

  function el(id) { return document.getElementById(id); }
  function getVal(id) { const e = el(id); return e ? e.value : ''; }
  function setVal(id, val) { const e = el(id); if (e) e.value = val; }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response || {});
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  function bindListeners() {
    // Step navigation clicks
    document.querySelectorAll('.step-nav-item').forEach(item => {
      item.addEventListener('click', () => goToStep(Number(item.dataset.step)));
    });

    el('prev-btn').addEventListener('click', () => goToStep(currentStep - 1));
    el('next-btn').addEventListener('click', () => goToStep(currentStep + 1));
    el('save-btn').addEventListener('click', saveSettings);

    // Branding live preview
    ['agency-name', 'crm-name', 'agency-logo', 'brand-color'].forEach(id => {
      el(id).addEventListener('input', applyPreviewBranding);
    });

    // Color picker sync
    el('brand-color-picker').addEventListener('input', e => {
      setVal('brand-color', e.target.value);
      applyPreviewBranding();
    });
    el('brand-color').addEventListener('input', e => {
      const val = e.target.value;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        el('brand-color-picker').value = val;
        applyPreviewBranding();
      }
    });

    // Change 3: Preset color swatch buttons
    document.querySelectorAll('.color-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.dataset.color;
        setVal('brand-color', color);
        el('brand-color-picker').value = color;
        applyPreviewBranding();
      });
    });

    // Change 1: API key character counter
    el('ghl-api-key').addEventListener('input', e => {
      const len = e.target.value.length;
      el('api-key-count').textContent = len;
      const status = el('api-key-status');
      if (len === 0) { status.textContent = ''; status.className = ''; }
      else if (len < 50) { status.textContent = '(too short?)'; status.className = 'hint-warn'; }
      else { status.textContent = '✓'; status.className = 'hint-ok'; }
    });

    // GHL test connection
    el('test-connection-btn').addEventListener('click', testConnection);

    // Pipeline change
    el('default-pipeline').addEventListener('change', onPipelineChange);

    // Key visibility toggle
    el('toggle-key').addEventListener('click', () => {
      const input = el('ghl-api-key');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    // Profile modal
    el('add-profile-btn').addEventListener('click', openProfileModal);
    el('modal-close').addEventListener('click', closeProfileModal);
    el('modal-cancel').addEventListener('click', closeProfileModal);
    el('modal-save').addEventListener('click', saveProfile);
    el('profile-modal').addEventListener('click', e => {
      if (e.target === el('profile-modal')) closeProfileModal();
    });

    // Export
    el('export-btn').addEventListener('click', exportSettings);
    el('export-btn-2').addEventListener('click', exportSettings);

    // Import
    el('import-input').addEventListener('change', e => importSettings(e.target.files[0]));
    el('import-input-2').addEventListener('change', e => importSettings(e.target.files[0]));


    // Getting Started checklist — goto buttons
    document.querySelectorAll('.check-goto[data-goto-step]').forEach(btn => {
      btn.addEventListener('click', () => goToStep(parseInt(btn.dataset.gotoStep, 10)));
    });

    // Niche tabs
    document.querySelectorAll('.niche-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.niche-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.niche-script').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        const niche = tab.dataset.niche;
        const script = document.querySelector('.niche-script[data-niche="' + niche + '"]');
        if (script) script.classList.add('active');
      });
    });

    // Outreach template tabs
    document.querySelectorAll('.otpl-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.otpl-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.otpl-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const tpl = tab.dataset.tpl;
        const panel = document.querySelector('.otpl-panel[data-tpl="' + tpl + '"]');
        if (panel) panel.classList.add('active');
      });
    });

    // Template copy buttons
    document.querySelectorAll('.template-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = el(btn.dataset.target);
        if (!target) return;
        navigator.clipboard.writeText(target.textContent).then(() => {
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1800);
        });
      });
    });

    // Niche chip — copy the search query to clipboard
    document.querySelectorAll('.niche-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const query = chip.dataset.query || chip.textContent.trim();
        navigator.clipboard.writeText(query).then(() => {
          const orig = chip.textContent;
          chip.textContent = '\u2713 Copied!';
          chip.classList.add('copied');
          setTimeout(() => { chip.textContent = orig; chip.classList.remove('copied'); }, 1500);
        });
      });
    });
  }

})();
