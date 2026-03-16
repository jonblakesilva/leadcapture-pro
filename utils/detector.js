(function () {
  'use strict';

  window.LCP = window.LCP || {};

  // Schema.org @type values that indicate a local business
  const SCHEMA_BUSINESS_TYPES = new Set([
    'LocalBusiness', 'Organization', 'Corporation',
    'HomeAndConstructionBusiness', 'Plumber', 'Electrician',
    'GeneralContractor', 'RoofingContractor', 'HVACBusiness',
    'Locksmith', 'MovingCompany', 'Carpenter',
    'PestControlService', 'LawnCareService', 'Dentist', 'Physician',
    'MedicalBusiness', 'LegalService', 'Attorney', 'Accountant',
    'FinancialService', 'RealEstateAgent', 'InsuranceAgency',
    'Restaurant', 'FoodEstablishment', 'Store', 'AutoRepair',
    'AutoDealer', 'BeautySalon', 'BarberShop', 'SpaOrBeautyShop',
    'HealthAndBeautyBusiness', 'CleaningService', 'LandscapeService',
    'Hotel', 'Florist', 'WeddingService', 'ProfessionalService',
    'HomeImprovement', 'Painter', 'Roofer',
  ]);

  // Generic H1 values that should be skipped when determining the business name
  const GENERIC_H1S = new Set([
    'home', 'welcome', 'about us', 'about', 'contact us', 'contact',
    'services', 'our services', 'homepage', 'main', 'page not found',
    '404', 'error',
  ]);

  // Patterns that indicate a search/directory listing page — not a business name
  const SEARCH_RESULT_TITLE_RE = /^showing[\s\w,]+results?|results?\s+for\b|find\s+.{3,40}\s+near\b|\bsearch\s+results?\b|\b[\d,]+\s+(businesses|contractors|companies|listings|providers)\b|^top\s+\d+\b|^browse\b|^directory\b/i;

  // ---------------------------------------------------------------------------
  // Phone helpers
  // ---------------------------------------------------------------------------

  function normalizePhone(raw) {
    const digits = String(raw).replace(/\D/g, '');
    return digits.slice(-10);
  }

  // Decode Google's /url?q= redirect wrappers to get the real URL
  function decodeGoogleRedirectUrl(url) {
    if (!url) return null;
    try {
      const m = url.match(/[?&]q=([^&]+)/);
      if (m) {
        const decoded = decodeURIComponent(m[1]);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    } catch (_) {}
    return /^https?:\/\//i.test(url) ? url : null;
  }

  const PHONE_RE = /(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b/g;
  const PHONE_CONTEXT_WORDS_RE = /\b(phone|tel|telephone|call|mobile|fax|contact)\b/i;

  function isLikelyFalsePositivePhone(norm, rawMatch, contextBefore, contextAfter) {
    const rawDigitsOnly = rawMatch.replace(/\D/g, '');
    if (rawDigitsOnly.length === 5) return true;
    if (/\b(19|20)\d{2}\b/.test(rawMatch)) return true;
    if (/\$$/.test(contextBefore.slice(-1))) return true;
    if (/^\.\d{2}\b/.test(contextAfter)) return true;
    if (/^(\d)\1{9}$/.test(norm)) return true;
    if (norm === '1234567890' || norm === '0987654321') return true;
    if (/^\(\d\)$/.test(rawMatch.trim()) && /^\s+\w+s\b/i.test(contextAfter)) return true;
    return false;
  }

  function getPhoneConfidence(contextBefore, contextAfter) {
    const context = (contextBefore + ' ' + contextAfter).slice(0, 400);
    if (PHONE_CONTEXT_WORDS_RE.test(context)) return 'medium';
    return 'low';
  }

  function extractTelLinks() {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('a[href^="tel:"]').forEach(link => {
      const raw = decodeURIComponent(link.href.replace(/^tel:/, '')).trim();
      const norm = normalizePhone(raw);
      if (norm.length === 10 && !seen.has(norm)) {
        seen.add(norm);
        results.push({ display: raw, normalized: norm, confidence: 'high' });
      }
    });
    return results;
  }

  function extractPhonesFromText(telNorms) {
    const results = [];
    const seen = new Set(telNorms);
    const text = document.body ? (document.body.innerText || '') : '';
    let match;
    PHONE_RE.lastIndex = 0;
    while ((match = PHONE_RE.exec(text)) !== null) {
      const raw = match[0].trim();
      const norm = normalizePhone(raw);
      if (norm.length !== 10 || seen.has(norm)) continue;

      const matchStart = match.index;
      const matchEnd = match.index + match[0].length;
      const contextBefore = text.slice(Math.max(0, matchStart - 200), matchStart);
      const contextAfter  = text.slice(matchEnd, Math.min(text.length, matchEnd + 200));

      if (isLikelyFalsePositivePhone(norm, raw, contextBefore, contextAfter)) continue;

      seen.add(norm);
      const confidence = getPhoneConfidence(contextBefore, contextAfter);
      results.push({ display: raw, normalized: norm, confidence });
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Email helpers
  // ---------------------------------------------------------------------------

  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  const EMAIL_IGNORE_DOMAINS = new Set([
    'example.com', 'test.com', 'sentry.io', 'sentry-cdn.com',
    'w3.org', 'schema.org', 'google.com', 'googleapis.com',
    'cloudflare.com', 'gravatar.com', 'amazonaws.com',
    'stripe.com', 'mailchimp.com', 'hubspot.com',
  ]);

  const SPAM_PREFIX_RE = /^(noreply|no-reply|donotreply|do-not-reply|bounce|mailer-daemon|postmaster)@/i;
  const IMAGE_SUFFIX_RE = /@(2x|3x|mobile)$/i;

  function normalizeEmail(raw) {
    return String(raw).toLowerCase().trim();
  }

  function stripScriptTagsExceptLdJson(html) {
    return html.replace(/<script(?![^>]*type=["']application\/ld\+json["'])[^>]*>[\s\S]*?<\/script>/gi, '');
  }

  function isEmailFalsePositive(raw, norm) {
    if (SPAM_PREFIX_RE.test(norm)) return true;
    const localPart = norm.split('@')[0];
    if (IMAGE_SUFFIX_RE.test('@' + localPart.split('@').pop())) return true;
    if (/[@+._-](2x|3x|mobile)$/.test(localPart)) return true;
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf)$/i.test(raw)) return true;
    return false;
  }

  function extractMailtoLinks() {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('a[href^="mailto:"]').forEach(link => {
      const raw = decodeURIComponent(link.href.replace(/^mailto:/, '')).split('?')[0].trim();
      const norm = normalizeEmail(raw);
      const domain = norm.split('@')[1] || '';
      if (
        norm.includes('@') &&
        !EMAIL_IGNORE_DOMAINS.has(domain) &&
        !isEmailFalsePositive(raw, norm) &&
        !seen.has(norm)
      ) {
        seen.add(norm);
        results.push({ display: raw, normalized: norm, source: 'mailto' });
      }
    });
    return results;
  }

  function extractEmailsFromText(mailtoNorms) {
    // Don't scan page text for emails on Google search/maps pages —
    // the signed-in user's Gmail address often appears in the page chrome.
    if (/google\.[a-z.]+\/(search|maps)/i.test(window.location.href)) return [];
    const results = [];
    const seen = new Set(mailtoNorms);
    const rawHtml = document.body ? (document.body.innerHTML || '') : '';
    const html = stripScriptTagsExceptLdJson(rawHtml);
    let match;
    EMAIL_RE.lastIndex = 0;
    while ((match = EMAIL_RE.exec(html)) !== null) {
      const raw = match[0];
      const norm = normalizeEmail(raw);
      const domain = norm.split('@')[1] || '';
      if (
        EMAIL_IGNORE_DOMAINS.has(domain) ||
        isEmailFalsePositive(raw, norm) ||
        seen.has(norm)
      ) continue;
      seen.add(norm);
      results.push({ display: raw, normalized: norm, source: 'text' });
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Schema.org JSON-LD parsing — with ItemList support
  // ---------------------------------------------------------------------------

  function isItemList(node) {
    if (!node || !node['@type']) return false;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    return types.some(t =>
      t === 'ItemList' || t === 'SearchResultsPage' || t === 'CollectionPage'
    );
  }

  // Expand ItemList.itemListElement → individual business nodes
  function flattenItemList(node) {
    const results = [];
    const elements = Array.isArray(node.itemListElement) ? node.itemListElement : [];
    elements.forEach(el => {
      if (!el) return;
      // ListItem wraps the real item in .item
      const item = (el.item && typeof el.item === 'object') ? el.item : el;
      const types = item['@type'] ? (Array.isArray(item['@type']) ? item['@type'] : [item['@type']]) : [];
      if (types.length && !types.every(t => t === 'ListItem')) {
        results.push(item);
      }
    });
    return results;
  }

  function parseAllJsonLD() {
    const items = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try {
        const parsed = JSON.parse(script.textContent);
        const nodes = parsed['@graph'] ? parsed['@graph'] : [parsed];
        nodes.forEach(node => {
          if (isItemList(node)) {
            // Expand to individual business nodes
            items.push(...flattenItemList(node));
          } else {
            items.push(node);
            // Also surface businesses nested in contains/hasPart arrays
            ['contains', 'hasPart'].forEach(key => {
              const nested = node[key];
              if (!nested) return;
              (Array.isArray(nested) ? nested : [nested]).forEach(n => {
                if (n && typeof n === 'object' && isBusinessType(n)) items.push(n);
              });
            });
          }
        });
      } catch (_) {}
    });
    return items;
  }

  function isBusinessType(node) {
    if (!node || !node['@type']) return false;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    return types.some(t => SCHEMA_BUSINESS_TYPES.has(t));
  }

  function addressFromSchema(addr) {
    if (!addr) return null;
    if (typeof addr === 'string') return addr;
    const parts = [
      addr.streetAddress,
      addr.addressLocality,
      addr.addressRegion,
      addr.postalCode,
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }

  function contactFromSchemaNode(node) {
    const phones = [];
    const emails = [];

    const telRaw = node.telephone || node.phone;
    if (telRaw) {
      const tels = Array.isArray(telRaw) ? telRaw : [telRaw];
      tels.forEach(t => {
        const norm = normalizePhone(String(t));
        if (norm.length === 10) {
          phones.push({ display: String(t).trim(), normalized: norm, confidence: 'high' });
        }
      });
    }

    const emailRaw = node.email;
    if (emailRaw) {
      const ems = Array.isArray(emailRaw) ? emailRaw : [emailRaw];
      ems.forEach(e => {
        const norm = normalizeEmail(String(e));
        const domain = norm.split('@')[1] || '';
        if (
          norm.includes('@') &&
          !EMAIL_IGNORE_DOMAINS.has(domain) &&
          !isEmailFalsePositive(String(e), norm)
        ) {
          emails.push({ display: String(e).trim(), normalized: norm, source: 'schema' });
        }
      });
    }

    const addrSource = node.address || node.location;
    const address = addressFromSchema(
      addrSource && typeof addrSource === 'object' && addrSource.address
        ? addrSource.address
        : addrSource
    );

    return {
      businessName: node.name || null,
      phones,
      emails,
      address,
      website: node.url || node.website || null,
      fromSchema: true,
    };
  }

  function extractSchemaContacts(nodes) {
    return nodes
      .filter(isBusinessType)
      .map(contactFromSchemaNode)
      .filter(c => c.businessName || c.phones.length || c.emails.length);
  }

  // ---------------------------------------------------------------------------
  // Business name helpers
  // ---------------------------------------------------------------------------

  function cleanBusinessName(raw) {
    if (!raw) return raw;
    const LEGAL_SUFFIX_RE = /[\s,]+\b(LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Ltd\.?|Limited|LLP|LP|PC|PLLC)\b\.?$/i;
    let cleaned = raw.trim();
    let prev;
    do {
      prev = cleaned;
      cleaned = cleaned.replace(LEGAL_SUFFIX_RE, '').trim();
    } while (cleaned !== prev);
    cleaned = cleaned.replace(/[,.\s]+$/, '').trim();
    return cleaned || raw.trim();
  }

  // ---------------------------------------------------------------------------
  // Business name extraction (priority order)
  // ---------------------------------------------------------------------------

  // og:site_name values that belong to directories/aggregators — never a business name
  const DIRECTORY_SITE_NAMES = new Set([
    'yp.com', 'yellow pages', 'yellowpages', 'yellowpages.com',
    'yelp', 'yelp.com', 'bbb', 'bbb.org', 'better business bureau',
    'google', 'google.com', 'google maps',
    'linkedin', 'linkedin.com', 'facebook', 'facebook.com',
    'houzz', 'houzz.com', 'angi', 'angi.com', 'angies list',
    'thumbtack', 'thumbtack.com', 'homeadvisor', 'homeadvisor.com',
    'nextdoor', 'nextdoor.com', 'porch', 'porch.com',
    'tripadvisor', 'foursquare', 'manta', 'manta.com',
    'citysearch', 'superpages', 'superpages.com',
  ]);

  function getBusinessName(schemaNodes) {
    // 1. Schema.org
    for (const node of schemaNodes) {
      if (isBusinessType(node) && node.name) return node.name;
    }

    // 2. og:site_name — skip known directory/aggregator names
    const ogSiteName = document.querySelector('meta[property="og:site_name"]');
    if (ogSiteName && ogSiteName.content) {
      const sn = ogSiteName.content.trim();
      if (!DIRECTORY_SITE_NAMES.has(sn.toLowerCase())) return sn;
    }

    // 3. H1 — skip generic values and search-result headers
    const h1 = document.querySelector('h1');
    if (h1) {
      const h1Text = h1.textContent.trim();
      if (
        h1Text &&
        !GENERIC_H1S.has(h1Text.toLowerCase()) &&
        !SEARCH_RESULT_TITLE_RE.test(h1Text)
      ) {
        return h1Text.slice(0, 100);
      }
    }

    // 4. <title> heuristic
    const title = document.title || '';
    if (title && !SEARCH_RESULT_TITLE_RE.test(title)) {
      const stripped = title
        .replace(/\s*[\|–\-—•·]\s*.{2,40}$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
      if (stripped && !SEARCH_RESULT_TITLE_RE.test(stripped)) return stripped;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Address heuristic fallback
  // ---------------------------------------------------------------------------

  function getAddressFallback() {
    const text = document.body ? (document.body.innerText || '') : '';
    const m = text.match(/\d{1,5}\s+[\w\s.]{2,40},\s+[\w\s]{2,30},?\s+[A-Z]{2}\s+\d{5}(-\d{4})?/);
    return m ? m[0].replace(/\s+/g, ' ').trim() : null;
  }

  // ---------------------------------------------------------------------------
  // Confidence filtering helpers
  // ---------------------------------------------------------------------------

  function filterPhonesByConfidence(phones) {
    const hasHighOrMedium = phones.some(p => p.confidence === 'high' || p.confidence === 'medium');
    if (hasHighOrMedium) return phones.filter(p => p.confidence !== 'low');
    return phones;
  }

  function filterEmailsByConfidence(emails) {
    const hasHighConfidence = emails.some(e => e.source === 'mailto' || e.source === 'schema');
    if (hasHighConfidence) return emails.filter(e => e.source !== 'text');
    return emails;
  }

  function stripEmailSource(emails) {
    return emails.map(({ display, normalized }) => ({ display, normalized }));
  }

  // ---------------------------------------------------------------------------
  // Platform-specific DOM scrapers
  // ---------------------------------------------------------------------------

  // Google Maps — business detail page
  function extractGoogleMapsBusiness() {
    if (!/maps\.google\.|google\.com\/maps/i.test(window.location.href)) return null;

    // Name: try specific Maps class first, then any h1
    const nameEl = document.querySelector(
      'h1.DUwDvf, h1[class*="fontHeadline"], [jsaction*="pane.hero"] h1, h1'
    );
    const name = nameEl ? nameEl.textContent.trim() : null;

    const phones = extractTelLinks();

    // Address: try multiple selectors — Google Maps DOM changes frequently
    let address = null;
    const addrSelectors = [
      '[aria-label^="Address: "]',
      '[data-tooltip*="address" i]',
      '[data-item-id^="address"]',
      '[data-tooltip="Copy address"]',
      'button[aria-label*="ddress"]',
      '[aria-label*="Address:"]',
      'button[data-item-id*="address"]',
    ];
    for (const sel of addrSelectors) {
      const addrEl = document.querySelector(sel);
      if (addrEl) {
        const raw = (addrEl.getAttribute('aria-label') || addrEl.textContent || '').trim();
        const cleaned = raw.replace(/^(Copy address:|Address:)\s*/i, '').trim();
        if (cleaned && cleaned.length > 5) { address = cleaned; break; }
      }
    }
    // Fallback: aria-label buttons that look like street addresses
    if (!address) {
      const btns = Array.from(document.querySelectorAll('button[aria-label]'));
      for (const btn of btns) {
        const lbl = btn.getAttribute('aria-label') || '';
        if (/\d+\s+\w/.test(lbl) && /,\s*[A-Z]{2}/.test(lbl)) {
          address = lbl.trim(); break;
        }
      }
    }
    // Fallback: street address pattern in body text
    if (!address) {
      const bodyText = document.body ? (document.body.innerText || '') : '';
      const streetMatch = bodyText.match(/\d{1,5}\s+[\w\s.]{2,40},\s+[\w\s]{2,30},?\s+[A-Z]{2}\s+\d{5}(-\d{4})?/);
      if (streetMatch) address = streetMatch[0].replace(/\s+/g, ' ').trim();
    }

    // Website: try multiple selectors, decode Google redirect URLs
    let website = null;
    const siteSelectors = [
      'a[data-item-id="authority"]',
      'a[data-value="Website"]',
      'a[aria-label="Website"]',
      'a[aria-label*="website" i]',
      'a[data-item-id="website"]',
      'a[jsaction*="pane.website" i]',
    ];
    for (const sel of siteSelectors) {
      const siteEl = document.querySelector(sel);
      if (siteEl) {
        const dataUrl = siteEl.getAttribute('data-url');
        if (dataUrl && /^https?:\/\//i.test(dataUrl)) {
          website = dataUrl;
        } else {
          website = decodeGoogleRedirectUrl(siteEl.href) || siteEl.href || null;
        }
        if (website && /google\.com\/url/i.test(website)) {
          website = decodeGoogleRedirectUrl(website) || null;
        }
        if (website) break;
      }
    }

    // Modern Maps: single aria-label like "4.9 stars 477 reviews" on the review button
    let rating = null;
    let reviewCount = null;
    const combinedEl = document.querySelector('[aria-label*="stars"][aria-label*="reviews"], [aria-label*="star"][aria-label*="review"]');
    if (combinedEl) {
      const lbl = combinedEl.getAttribute('aria-label') || '';
      const rM = lbl.match(/(\d+\.?\d*)\s+stars?/i);
      const cM = lbl.match(/([\d,]+)\s+reviews?/i);
      if (rM) rating = rM[1];
      if (cM) reviewCount = cM[1].replace(/,/g, '');
    }

    // Rating (continue with fallbacks if combined extraction missed it)
    // Try aria-label first: "4.8 stars" or "Rated 4.8 out of 5"
    const ratingAria = document.querySelectorAll('[aria-label*="star" i], [aria-label*="rating" i], [aria-label*="Rated" i]');
    for (const el of ratingAria) {
      const lbl = el.getAttribute('aria-label') || '';
      const m = lbl.match(/(\d+\.?\d*)\s*(?:star|out of 5)/i);
      if (m && parseFloat(m[1]) <= 5) { rating = m[1]; break; }
    }
    // Try fontDisplayLarge (the big rating number)
    if (!rating) {
      for (const sel of ['.fontDisplayLarge', '[class*="fontDisplay"]']) {
        const el = document.querySelector(sel);
        if (el) {
          const t = el.textContent.trim();
          if (/^\d\.\d$/.test(t)) { rating = t; break; }
        }
      }
    }
    // Try F7nice span (Google Maps rating widget)
    if (!rating) {
      const el = document.querySelector('.F7nice span, [class*="F7nice"]');
      if (el && /^\d\.\d$/.test(el.textContent.trim())) rating = el.textContent.trim();
    }
    // Text fallback
    if (!rating) {
      const bodyText = document.body ? (document.body.innerText || '') : '';
      const m = bodyText.match(/^(\d\.\d)\n/m) || bodyText.match(/\b(\d\.\d)\s*(?:stars?|★)/i);
      if (m) rating = m[1];
    }

    // Review count (skip re-declaring if already found above)
    if (!reviewCount) {
    // Aria-label approach: "1,234 reviews"
    const reviewAria = document.querySelectorAll('[aria-label*="review" i]');
    for (const el of reviewAria) {
      const lbl = el.getAttribute('aria-label') || '';
      const m = lbl.match(/([\d,]+)\s+review/i);
      if (m) { reviewCount = m[1].replace(/,/g, ''); break; }
    }
    // Button with review count in text
    if (!reviewCount) {
      const btns = Array.from(document.querySelectorAll('button, span[jsaction]'));
      for (const btn of btns) {
        const t = btn.textContent.trim();
        const m = t.match(/^\(([\d,]+)\)$/) || t.match(/^([\d,]+)\s+reviews?$/i);
        if (m) { reviewCount = m[1].replace(/,/g, ''); break; }
      }
    }
    // jsaction contains rating
    if (!reviewCount) {
      const el = document.querySelector('[jsaction*="pane.rating.moreReviews"]');
      if (el) {
        const m = (el.textContent || '').match(/([\d,]+)/);
        if (m) reviewCount = m[1].replace(/,/g, '');
      }
    }
    // Text fallback
    if (!reviewCount) {
      const bodyText = document.body ? (document.body.innerText || '') : '';
      const m = bodyText.match(/\(([\d,]+)\s*reviews?\)/i) || bodyText.match(/\b([\d,]+)\s+reviews?\b/i);
      if (m) reviewCount = m[1].replace(/,/g, '');
    }
    } // end if (!reviewCount) outer block

    // Google Business Profile verification status
    // Unclaimed profiles show "Own this business?" prompt
    const bodyText2 = document.body ? (document.body.innerText || '') : '';
    const isUnclaimed = /own this business\?/i.test(bodyText2) ||
      !!document.querySelector('[data-value="Own this business?"], [aria-label*="Own this business" i], a[jsaction*="ownthisbusiness" i]');
    // null = unknown (not on Maps), false = unclaimed, true = likely claimed
    const isVerified = name ? !isUnclaimed : null;

    if (!name && !phones.length) return null;
    return { businessName: name, phones, emails: [], address, website, reviewCount, rating, isVerified, fromDom: true };
  }

  // LinkedIn — company pages
  function extractLinkedInBusiness() {
    if (!/linkedin\.com/i.test(window.location.href)) return null;

    // Company name from multiple possible selectors
    const nameEl = document.querySelector(
      '.org-top-card-summary__title, .top-card-layout__title, ' +
      '[class*="org-top-card"] h1, [class*="top-card"] h1, h1'
    );
    const name = nameEl ? nameEl.textContent.trim() : null;
    if (!name) return null;

    // Website from company About section
    const siteEl = document.querySelector(
      'a[data-tracking-control-name*="website"], ' +
      '.org-about-us-organization-description__url, ' +
      '.org-about-company-module__website a'
    );
    const website = siteEl ? siteEl.href : null;

    // LinkedIn rarely shows phone/email publicly but check anyway
    const phones = extractTelLinks();
    const emails = extractMailtoLinks();

    return { businessName: name, phones, emails, address: null, website, fromDom: true };
  }

  // Google Business Profile
  function extractGoogleBusinessProfile() {
    if (!/business\.google\.com/i.test(window.location.href)) return null;
    const nameEl = document.querySelector('h1, [aria-label="Business name"]');
    const name = nameEl ? nameEl.textContent.trim() : null;
    const phones = extractTelLinks();
    if (!name && !phones.length) return null;
    return { businessName: name, phones, emails: [], address: null, website: null, fromDom: true };
  }

  // Yellow Pages — single business detail page
  function extractYellowPagesBusiness() {
    if (!/yellowpages\.com/i.test(window.location.href)) return null;

    // Name: itemprop="name" on the business detail page, or the main h1
    const nameEl = document.querySelector(
      '[itemprop="name"].dockable-business-name, ' +
      'h1[itemprop="name"], ' +
      '.dockable-business-name, ' +
      '.business-name.heading, ' +
      'h1.ypg-heading'
    );
    const name = nameEl ? nameEl.textContent.trim() : null;

    const phones = extractTelLinks();

    // Address from microdata
    const streetEl = document.querySelector('[itemprop="streetAddress"]');
    const cityEl   = document.querySelector('[itemprop="addressLocality"]');
    const stateEl  = document.querySelector('[itemprop="addressRegion"]');
    const zipEl    = document.querySelector('[itemprop="postalCode"]');
    const addrParts = [streetEl, cityEl, stateEl, zipEl]
      .filter(Boolean).map(el => el.textContent.trim()).filter(Boolean);
    const address = addrParts.length ? addrParts.join(', ') : null;

    if (!name && !phones.length) return null;
    return { businessName: name, phones, emails: [], address, website: null, fromDom: true };
  }

  // Yellow Pages — search results page (multiple business cards)
  function extractYellowPagesBusinessList() {
    if (!/yellowpages\.com/i.test(window.location.href)) return null;

    const results = [];
    const cards = document.querySelectorAll('article.srp-listing, div.result, div[class*="listing-content"]');

    cards.forEach(card => {
      const nameEl = card.querySelector(
        'a.business-name, .business-name a, h2.n a, h2 a, [class*="businessName"] a, [class*="business-name"]'
      );
      const name = nameEl ? nameEl.textContent.trim() : null;

      const phoneEl = card.querySelector('[class*="phone"], .phones, [itemprop="telephone"]');
      const cardText = card.innerText || card.textContent || '';
      const phoneSource = (phoneEl ? phoneEl.textContent : '') || cardText;
      const phoneMatch = phoneSource.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/);

      const streetEl = card.querySelector('[itemprop="streetAddress"], .street-address');
      const cityEl   = card.querySelector('[itemprop="addressLocality"], .locality');
      const stateEl  = card.querySelector('[itemprop="addressRegion"], .region');
      const addrParts = [streetEl, cityEl, stateEl]
        .filter(Boolean).map(el => el.textContent.trim()).filter(Boolean);
      const address = addrParts.length ? addrParts.join(', ') : null;

      if (!name && !phoneMatch) return;

      const phones = phoneMatch ? [{
        display: phoneMatch[0].trim(),
        normalized: phoneMatch[0].replace(/\D/g, '').slice(-10),
        confidence: 'high',
      }] : [];

      results.push({
        businessName: name || null,
        phones,
        emails: [],
        address,
        website: null,
        sourceUrl: window.location.href,
        fromDom: true,
      });
    });

    return results.length >= 2 ? results : null;
  }

  // Google Search — extract individual business cards from the local pack
  function extractGoogleSearchBusinesses() {
    if (!/google\.[a-z.]+\/search/i.test(window.location.href)) return null;

    const results = [];

    // Helper: extract website from a container element
    function findWebsiteInContainer(el) {
      if (!el) return null;
      const links = Array.from(el.querySelectorAll('a[href]'));
      const siteLink = links.find(a => {
        const txt = (a.textContent || '').trim().toLowerCase();
        const lbl = (a.getAttribute('aria-label') || '').toLowerCase();
        return txt === 'website' || lbl.includes('website') || lbl.includes('official site');
      });
      if (!siteLink) return null;
      const dataUrl = siteLink.getAttribute('data-url');
      if (dataUrl && /^https?:\/\//i.test(dataUrl)) return dataUrl;
      return decodeGoogleRedirectUrl(siteLink.href);
    }

    // Strategy 1: .rllt__details — per-card container in the local pack
    const cards = document.querySelectorAll('.rllt__details');
    if (cards.length >= 2) {
      cards.forEach(card => {
        const nameEl = card.querySelector('[role="heading"], [aria-level], .dbg0pd, .OSrXXb, span[class]');
        const name = nameEl ? nameEl.textContent.trim() : null;
        const text = card.innerText || card.textContent || '';
        const phoneMatch = text.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/);
        if (!name && !phoneMatch) return;

        const phones = phoneMatch ? [{
          display: phoneMatch[0].trim(),
          normalized: phoneMatch[0].replace(/\D/g, '').slice(-10),
          confidence: 'high',
        }] : [];

        // Rating: "4.9" pattern
        let rating = null;
        const ratingMatch = text.match(/\b(\d\.\d)\b/);
        if (ratingMatch) rating = ratingMatch[1];

        // Review count: "(477)" pattern
        let reviewCount = null;
        const reviewMatch = text.match(/\(([\d,]+)\)/);
        if (reviewMatch) reviewCount = reviewMatch[1].replace(/,/g, '');

        // Address: "City, ST" pattern
        let address = null;
        const addrMatch = text.match(/([A-Z][a-z][\w ]{1,25}),\s+([A-Z]{2})\b/);
        if (addrMatch) address = addrMatch[0].trim();

        // Website: walk up to find a Website link
        let website = null;
        let parentEl = card.parentElement;
        for (let i = 0; i < 6 && parentEl; i++) {
          website = findWebsiteInContainer(parentEl);
          if (website) break;
          parentEl = parentEl.parentElement;
        }

        results.push({
          businessName: name || null,
          phones,
          emails: [],
          address,
          website,
          rating,
          reviewCount,
          sourceUrl: window.location.href,
          fromDom: true,
        });
      });
      if (results.length >= 2) return results;
    }

    // Strategy 2: scan visible business headings paired with nearby phone numbers
    const headings = Array.from(document.querySelectorAll('h3[class], div[role="heading"]'));
    if (headings.length >= 2) {
      headings.forEach(heading => {
        const name = heading.textContent.trim();
        if (!name || name.length > 80) return;
        let container = heading.parentElement;
        for (let i = 0; i < 4 && container; i++) {
          const text = container.innerText || container.textContent || '';
          const phoneMatch = text.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/);
          if (phoneMatch) {
            const phones = [{
              display: phoneMatch[0].trim(),
              normalized: phoneMatch[0].replace(/\D/g, '').slice(-10),
              confidence: 'high',
            }];

            let rating = null;
            const ratingMatch = text.match(/\b(\d\.\d)\b/);
            if (ratingMatch) rating = ratingMatch[1];

            let reviewCount = null;
            const reviewMatch = text.match(/\(([\d,]+)\)/);
            if (reviewMatch) reviewCount = reviewMatch[1].replace(/,/g, '');

            let address = null;
            const addrMatch = text.match(/([A-Z][a-z][\w ]{1,25}),\s+([A-Z]{2})\b/);
            if (addrMatch) address = addrMatch[0].trim();

            const website = findWebsiteInContainer(container);

            results.push({ businessName: name, phones, emails: [], address, website, rating, reviewCount, sourceUrl: window.location.href, fromDom: true });
            break;
          }
          container = container.parentElement;
        }
      });
      // Deduplicate by phone normalized
      const seenPhones = new Set();
      const deduped = results.filter(r => {
        if (!r.phones.length) return true;
        const key = r.phones[0].normalized;
        if (seenPhones.has(key)) return false;
        seenPhones.add(key);
        return true;
      });
      if (deduped.length >= 2) return deduped;
    }

    return null;
  }

  function extractPlatformSpecific() {
    const href = window.location.href;
    if (/maps\.google\.|google\.com\/maps/i.test(href)) return extractGoogleMapsBusiness();
    if (/business\.google\.com/i.test(href)) return extractGoogleBusinessProfile();
    if (/linkedin\.com/i.test(href)) return extractLinkedInBusiness();
    if (/yellowpages\.com/i.test(href)) return extractYellowPagesBusiness();
    return null;
  }

  // ---------------------------------------------------------------------------
  // Merge helpers
  // ---------------------------------------------------------------------------

  function mergePhones(primary, secondary) {
    const seen = new Set(primary.map(p => p.normalized));
    const merged = [...primary];
    for (const p of secondary) {
      if (!seen.has(p.normalized)) { seen.add(p.normalized); merged.push(p); }
    }
    return merged;
  }

  function mergeEmails(primary, secondary) {
    const seen = new Set(primary.map(e => e.normalized));
    const merged = [...primary];
    for (const e of secondary) {
      if (!seen.has(e.normalized)) { seen.add(e.normalized); merged.push(e); }
    }
    return merged;
  }

  // ---------------------------------------------------------------------------
  // Main detection function
  // ---------------------------------------------------------------------------

  window.LCP.detectContacts = function () {
    // Google Search local pack — extract individual business cards before anything else
    const googleSearchContacts = extractGoogleSearchBusinesses();
    if (googleSearchContacts && googleSearchContacts.length > 1) {
      return googleSearchContacts;
    }

    // Yellow Pages search results — extract individual business cards
    const ypListContacts = extractYellowPagesBusinessList();
    if (ypListContacts && ypListContacts.length > 1) {
      return ypListContacts;
    }

    const schemaNodes = parseAllJsonLD();
    const schemaContacts = extractSchemaContacts(schemaNodes);

    const telPhones = extractTelLinks();
    const telNorms = new Set(telPhones.map(p => p.normalized));
    const textPhones = extractPhonesFromText(telNorms);

    const mailtoEmails = extractMailtoLinks();
    const mailtoNorms = new Set(mailtoEmails.map(e => e.normalized));
    const textEmails = extractEmailsFromText(mailtoNorms);

    // Platform-specific DOM scraping (LinkedIn, Google Maps, etc.)
    const platformContact = extractPlatformSpecific();

    // ── Directory page: multiple distinct schema contacts ──────────────────
    // Each contact gets ONLY its own schema phones/emails — not page-wide ones,
    // which would incorrectly assign every number on the page to every business.
    if (schemaContacts.length > 1) {
      const results = schemaContacts
        .map(sc => ({
          businessName: cleanBusinessName(sc.businessName)
            ? cleanBusinessName(sc.businessName).slice(0, 100) : null,
          businessNameRaw: sc.businessName || null,
          phones: sc.phones,
          emails: stripEmailSource(sc.emails),
          address: sc.address || null,
          website: sc.website || null,
          sourceUrl: window.location.href,
          fromSchema: true,
        }))
        .filter(c => c.businessName || c.phones.length || c.emails.length);

      if (results.length > 0) return results;
      // Fall through to single-contact path if schema entries were all empty
    }

    // ── Single-contact page: aggregate all signals ─────────────────────────
    // Priority: platform-specific DOM > schema > page-wide tel/email
    const basePhones = platformContact
      ? platformContact.phones
      : (schemaContacts[0] ? schemaContacts[0].phones : []);

    const baseEmails = platformContact
      ? platformContact.emails
      : (schemaContacts[0] ? schemaContacts[0].emails : []);

    const allPhones = filterPhonesByConfidence(
      mergePhones(mergePhones(basePhones, telPhones), textPhones)
    );

    const allEmails = filterEmailsByConfidence(
      mergeEmails(mergeEmails(baseEmails, mailtoEmails), textEmails)
    );

    const rawName =
      (platformContact && platformContact.businessName) ||
      (schemaContacts[0] && schemaContacts[0].businessName) ||
      getBusinessName(schemaNodes);

    const cleanedName = cleanBusinessName(rawName);

    const address =
      (platformContact && platformContact.address) ||
      (schemaContacts[0] && schemaContacts[0].address) ||
      getAddressFallback();

    const website =
      (platformContact && platformContact.website) ||
      (schemaContacts[0] && schemaContacts[0].website) ||
      null;

    return [{
      businessName: cleanedName ? cleanedName.slice(0, 100) : null,
      businessNameRaw: rawName || null,
      phones: allPhones,
      emails: stripEmailSource(allEmails),
      address,
      website,
      reviewCount: (platformContact && platformContact.reviewCount) || null,
      rating: (platformContact && platformContact.rating) || null,
      sourceUrl: window.location.href,
      fromSchema: schemaContacts.length > 0,
    }];
  };

  // ---------------------------------------------------------------------------
  // MutationObserver watcher
  // ---------------------------------------------------------------------------

  window.LCP.watchForChanges = function (callback) {
    let timer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(callback, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  };

})();
