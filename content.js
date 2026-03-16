(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Guards — fail silently if env isn't suitable
  // ---------------------------------------------------------------------------

  // Skip if detection utils didn't load (should never happen, but be safe)
  if (!window.LCP || typeof window.LCP.detectContacts !== 'function') return;
  if (location.protocol === 'chrome-extension:' || location.protocol === 'chrome:') return;

  // Single-initialization guard — also used to detect re-entry after SPA navigation
  if (window.__lcpInitialized) return;
  window.__lcpInitialized = true;

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------

  let sidebarFrame   = null;
  let triggerHost    = null;
  let triggerShadow  = null;
  let currentTabId   = null;
  let mutationObserver = null;
  let currentUrl     = location.href;
  let spaCheckTimer  = null;

  // ---------------------------------------------------------------------------
  // Extension context keepalive
  // Detects when the extension is disabled/reloaded mid-session and cleans up.
  // ---------------------------------------------------------------------------

  try {
    const port = chrome.runtime.connect({ name: 'lcp-keepalive' });
    port.onDisconnect.addListener(() => {
      cleanup();
    });
  } catch (_) {
    // Extension context already invalid — abort silently
    cleanup();
    return;
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  try {
    chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, response => {
      if (chrome.runtime.lastError) return; // context invalidated
      if (response && response.tabId != null) {
        currentTabId = response.tabId;
      }
      safeRunDetection();
    });
  } catch (_) {
    return; // Extension context invalid, bail out
  }

  // SPA navigation watcher — intercept history API mutations
  patchHistoryApi();
  window.addEventListener('popstate', onUrlChange);
  startSpaPolling();

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  function safeRunDetection() {
    try {
      runDetection();
    } catch (e) {
      // Never let detection crash the host page
      console.warn('[LCP] Detection failed:', e && e.message);
    }
  }

  function runDetection() {
    if (!document.body) return; // guard for early-injection edge cases

    let contacts;
    try {
      contacts = window.LCP.detectContacts();
    } catch (_) {
      return;
    }

    let source;
    try {
      source = window.LCP.detectSource(window.location.href);
    } catch (_) {
      source = { label: 'Web', tag: 'web-lead' };
    }

    const count = countDataPoints(contacts);
    if (count === 0) return;

    // Store in local storage (keyed by tab ID — never PII cached long-term)
    if (currentTabId != null) {
      try {
        chrome.storage.local.set({
          [`contacts_${currentTabId}`]: contacts,
          [`source_${currentTabId}`]: source,
        });
      } catch (_) {}
    }

    if (triggerHost) {
      updateBadgeCount(count);
    } else {
      injectTriggerButton(count);
    }

    // MutationObserver: re-scan on DOM changes (SPAs, infinite scroll)
    if (!mutationObserver && document.body) {
      try {
        mutationObserver = window.LCP.watchForChanges(() => {
          if (!document.body) return;
          let fresh;
          try { fresh = window.LCP.detectContacts(); } catch (_) { return; }
          const freshCount = countDataPoints(fresh);
          if (freshCount > 0) {
            if (currentTabId != null) {
              try {
                chrome.storage.local.set({ [`contacts_${currentTabId}`]: fresh });
              } catch (_) {}
            }
            updateBadgeCount(freshCount);
            if (!triggerHost) injectTriggerButton(freshCount);
          }
        });
      } catch (_) {}
    }
  }

  function countDataPoints(contacts) {
    if (!Array.isArray(contacts)) return 0;
    return contacts.reduce((sum, c) => {
      return sum + (c.phones ? c.phones.length : 0) + (c.emails ? c.emails.length : 0);
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Floating trigger button — Shadow DOM for host-page style isolation
  // ---------------------------------------------------------------------------

  function injectTriggerButton(count) {
    if (!document.body) return;

    // Safety: remove stale host if body was rebuilt (rare)
    if (triggerHost && !document.contains(triggerHost)) {
      triggerHost = null;
      triggerShadow = null;
    }
    if (triggerHost) { updateBadgeCount(count); return; }

    try {
      triggerHost = document.createElement('div');
      triggerHost.id = 'lcp-trigger-host';
      triggerShadow = triggerHost.attachShadow({ mode: 'open' });

      triggerShadow.innerHTML = `
        <style>
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          :host { all: initial; display: block; }
          #btn {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 52px;
            height: 52px;
            border-radius: 50%;
            background: #2563eb;
            border: none;
            cursor: pointer;
            box-shadow: 0 4px 16px rgba(37,99,235,0.45), 0 2px 6px rgba(0,0,0,0.20);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2147483646;
            transition: transform 150ms ease, box-shadow 150ms ease, right 250ms ease;
            outline: none;
          }
          #btn:hover {
            transform: scale(1.08);
            box-shadow: 0 6px 20px rgba(37,99,235,0.55), 0 3px 8px rgba(0,0,0,0.25);
          }
          #btn:active { transform: scale(0.94); }
          #btn:focus-visible {
            box-shadow: 0 0 0 3px rgba(37,99,235,0.4), 0 4px 16px rgba(37,99,235,0.45);
          }
          svg { width: 22px; height: 22px; fill: white; pointer-events: none; }
          #badge {
            position: absolute;
            top: -3px;
            right: -3px;
            background: #ef4444;
            color: white;
            border-radius: 10px;
            min-width: 19px;
            height: 19px;
            font-size: 10px;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0 4px;
            border: 2px solid white;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            line-height: 1;
            pointer-events: none;
          }
        </style>
        <button id="btn" title="LeadCapture Pro — ${count} contact data point(s) detected"
                aria-label="Open LeadCapture Pro sidebar">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
          </svg>
          <span id="badge">${count}</span>
        </button>
      `;

      triggerShadow.querySelector('#btn').addEventListener('click', toggleSidebar);

      // Apply brand color from settings (non-blocking)
      try {
        chrome.storage.sync.get(['brandColor'], result => {
          if (chrome.runtime.lastError) return;
          if (result && result.brandColor && triggerShadow) {
            const btn = triggerShadow.querySelector('#btn');
            if (btn) btn.style.background = result.brandColor;
          }
        });
      } catch (_) {}

      document.body.appendChild(triggerHost);
    } catch (e) {
      // If injection fails (e.g. restricted page), fail silently
      triggerHost = null;
      triggerShadow = null;
    }
  }

  function updateBadgeCount(count) {
    if (!triggerShadow) return;
    try {
      const badge = triggerShadow.querySelector('#badge');
      if (badge) badge.textContent = count;
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Sidebar iframe
  // ---------------------------------------------------------------------------

  function toggleSidebar() {
    if (sidebarFrame) {
      closeSidebar();
    } else {
      openSidebar();
    }
  }

  function openSidebar() {
    if (sidebarFrame) return;
    if (!document.body) return;

    try {
      const url = chrome.runtime.getURL('sidebar.html') + `?tabId=${currentTabId}`;
      sidebarFrame = document.createElement('iframe');
      sidebarFrame.src = url;
      sidebarFrame.id = 'lcp-sidebar-frame';
      sidebarFrame.setAttribute('allow', 'clipboard-read; clipboard-write');
      // No sandbox — sidebar.html is a trusted chrome-extension:// page.
      // Sandbox blocks clipboard access even with allow="clipboard-write".

      Object.assign(sidebarFrame.style, {
        position:   'fixed',
        top:        '0',
        right:      '-380px',
        width:      '360px',
        height:     '100vh',
        border:     'none',
        borderLeft: '1px solid rgba(0,0,0,0.08)',
        zIndex:     '2147483647',
        boxShadow:  '-4px 0 32px rgba(0,0,0,0.14)',
        transition: 'right 250ms cubic-bezier(0.4,0,0.2,1)',
        background: 'white',
        display:    'block',
        colorScheme: 'light', // prevent dark-mode inversion on host pages
      });

      document.body.appendChild(sidebarFrame);

      // Trigger CSS slide-in on next two animation frames (ensures layout reflow first)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (sidebarFrame) sidebarFrame.style.right = '0';
        shiftTriggerButton(true);
      }));
    } catch (_) {
      sidebarFrame = null;
    }
  }

  function closeSidebar() {
    if (!sidebarFrame) return;
    try {
      sidebarFrame.style.right = '-380px';
    } catch (_) {}
    shiftTriggerButton(false);

    const frameRef = sidebarFrame;
    sidebarFrame = null; // clear ref immediately to prevent double-close

    setTimeout(() => {
      try {
        if (frameRef && frameRef.parentNode) frameRef.remove();
      } catch (_) {}
    }, 260);
  }

  function shiftTriggerButton(sidebarOpen) {
    if (!triggerShadow) return;
    try {
      const btn = triggerShadow.querySelector('#btn');
      if (btn) btn.style.right = sidebarOpen ? '376px' : '24px';
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Messages from sidebar iframe (postMessage — cross-origin safe pattern)
  // ---------------------------------------------------------------------------

  function onSidebarMessage(event) {
    // Only accept messages from chrome-extension:// pages (our trusted sidebar/popup)
    if (!event.data || typeof event.data !== 'object') return;
    if (!event.origin.startsWith('chrome-extension://')) return;

    switch (event.data.type) {
      case 'LCP_CLOSE_SIDEBAR':
        closeSidebar();
        break;
      case 'LCP_OPEN_SETTINGS':
        try { chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' }); } catch (_) {}
        break;
    }
  }

  window.addEventListener('message', onSidebarMessage);

  // ---------------------------------------------------------------------------
  // SPA navigation detection
  // Patches history.pushState and history.replaceState to fire a custom event,
  // then listens for URL changes to reset detection.
  // ---------------------------------------------------------------------------

  function patchHistoryApi() {
    try {
      const _pushState    = history.pushState.bind(history);
      const _replaceState = history.replaceState.bind(history);

      history.pushState = function (...args) {
        _pushState(...args);
        onUrlChange();
      };
      history.replaceState = function (...args) {
        _replaceState(...args);
        onUrlChange();
      };
    } catch (_) {
      // Some pages restrict history patching — fall back to polling
    }
  }

  function startSpaPolling() {
    // Belt-and-suspenders: poll every 1.5s for URL changes that history patching missed
    spaCheckTimer = setInterval(() => {
      if (location.href !== currentUrl) {
        onUrlChange();
      }
    }, 1500);
  }

  function onUrlChange() {
    const newUrl = location.href;
    if (newUrl === currentUrl) return;
    currentUrl = newUrl;

    // Give the SPA a moment to render new page content
    setTimeout(() => {
      try { resetForNewPage(); } catch (_) {}
    }, 600);
  }

  function resetForNewPage() {
    // Disconnect observer — it will be re-created by runDetection
    if (mutationObserver) {
      try { mutationObserver.disconnect(); } catch (_) {}
      mutationObserver = null;
    }

    // Close sidebar if open
    closeSidebar();

    // Remove trigger button so it gets re-created with fresh count
    if (triggerHost) {
      try { triggerHost.remove(); } catch (_) {}
      triggerHost = null;
      triggerShadow = null;
    }

    // Clear old contact data for this tab
    if (currentTabId != null) {
      try {
        chrome.storage.local.remove([`contacts_${currentTabId}`, `source_${currentTabId}`]);
      } catch (_) {}
    }

    // Re-run detection on new page
    safeRunDetection();
  }

  // ---------------------------------------------------------------------------
  // Full cleanup — called on extension disable/reload or fatal errors
  // ---------------------------------------------------------------------------

  function cleanup() {
    try {
      // Stop SPA polling
      if (spaCheckTimer) { clearInterval(spaCheckTimer); spaCheckTimer = null; }

      // Disconnect mutation observer
      if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }

      // Remove sidebar
      if (sidebarFrame) { sidebarFrame.remove(); sidebarFrame = null; }

      // Remove trigger button
      if (triggerHost) { triggerHost.remove(); triggerHost = null; triggerShadow = null; }

      // Remove message listener
      window.removeEventListener('message', onSidebarMessage);
      window.removeEventListener('popstate', onUrlChange);

      // Clear local storage for this tab
      if (currentTabId != null) {
        try {
          chrome.storage.local.remove([`contacts_${currentTabId}`, `source_${currentTabId}`]);
        } catch (_) {}
      }

      // Allow re-initialization if extension is re-enabled without full page reload
      delete window.__lcpInitialized;
    } catch (_) {
      // Cleanup itself must never throw
    }
  }

})();
