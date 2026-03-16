(function () {
  'use strict';

  window.LCP = window.LCP || {};

  const SOURCE_MAP = [
    { pattern: /\bangi\.com\b/i,          label: 'Angi',          tag: 'angi-lead' },
    { pattern: /\bthumbtack\.com\b/i,     label: 'Thumbtack',     tag: 'thumbtack-lead' },
    { pattern: /\bhomeadvisor\.com\b/i,   label: 'HomeAdvisor',   tag: 'homeadvisor-lead' },
    { pattern: /\byelp\.com\b/i,          label: 'Yelp',          tag: 'yelp-lead' },
    { pattern: /\blinkedin\.com\b/i,      label: 'LinkedIn',      tag: 'linkedin-lead' },
    { pattern: /\bfacebook\.com\b/i,      label: 'Facebook',      tag: 'facebook-lead' },
    { pattern: /maps\.google\.|google\.com\/maps/i, label: 'Google Maps', tag: 'google-maps-lead' },
    { pattern: /google\.[a-z.]+\/search/i, label: 'Google Search', tag: 'google-lead' },
    { pattern: /business\.google\.com/i,  label: 'Google Business', tag: 'google-business-lead' },
    { pattern: /\bbbb\.org\b/i,           label: 'BBB',           tag: 'bbb-lead' },
    { pattern: /\bhouzz\.com\b/i,         label: 'Houzz',         tag: 'houzz-lead' },
    { pattern: /\bnextdoor\.com\b/i,      label: 'Nextdoor',      tag: 'nextdoor-lead' },
    { pattern: /\bporch\.com\b/i,         label: 'Porch',         tag: 'porch-lead' },
    { pattern: /\byellowpages\.com\b/i,   label: 'Yellow Pages',  tag: 'yellowpages-lead' },
    { pattern: /\bgroupon\.com\b/i,       label: 'Groupon',       tag: 'groupon-lead' },
  ];

  window.LCP.detectSource = function (url) {
    for (const source of SOURCE_MAP) {
      if (source.pattern.test(url)) {
        return { label: source.label, tag: source.tag };
      }
    }
    return { label: 'Web', tag: 'web-lead' };
  };

})();
