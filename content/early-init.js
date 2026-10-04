/**
 * Scaredy Cat - Early Init Script
 * Runs at document_start ONLY on media sites to pre-hide hero content.
 * Minimal footprint - does nothing on regular websites.
 */

(function() {
  'use strict';

  // Only run on known media sites - exit immediately otherwise. Anchored to
  // the end of the hostname so subdomains (m.imdb.com) match and look-alikes
  // (imdb.com.example.net) don't.
  const MEDIA_SITES = /(^|\.)(imdb\.com|rottentomatoes\.com|themoviedb\.org|letterboxd\.com|shudder\.com|netflix\.com|hulu\.com|disneyplus\.com|hbomax\.com|max\.com|primevideo\.com|fandango\.com)$/i;

  if (!MEDIA_SITES.test(window.location.hostname)) {
    return; // Exit immediately - no overhead on regular sites
  }

  console.log('Scaredy Cat: Media site detected, enabling early protection');
  window.__scaredycatMediaSite = true;

  // No model warm-up from here: content.js asks for it only once settings
  // say this site is protected and an element actually needs the classifier.

  // Pre-hidden elements -> their own inline opacity (value, priority), put
  // back on reveal. Kept here in the isolated world rather than as a DOM
  // attribute, so a page can't plant or read it.
  const hidden = new Map();
  window.__scaredycatEarlyHidden = hidden;

  // Simple observer that just hides hero content as it appears
  // Will be stopped once main script takes over
  let stopped = false;

  const observer = new MutationObserver((mutations) => {
    if (stopped) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        hideIfHero(node);
      }
    }
  });

  function hideIfHero(el) {
    if (!el || !el.matches || hidden.has(el)) return;

    // Quick check for hero/poster elements
    if (el.matches('[data-testid*="hero"], [data-testid*="poster"], .ipc-poster, .ipc-media--poster, [class*="hero-media"], [data-qa*="poster"]')) {
      hidden.set(el, [el.style.getPropertyValue('opacity'), el.style.getPropertyPriority('opacity')]);
      el.style.opacity = '0';
    }
  }

  // Start observing
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Stop function for main script
  window.__scaredycatStopEarlyObserver = function() {
    stopped = true;
    observer.disconnect();
  };

  // Reveal function for main script
  function reveal(el) {
    const prev = hidden.get(el);
    if (!prev) return;
    hidden.delete(el);
    const [value, priority] = prev;
    if (value) el.style.setProperty('opacity', value, priority);
    else el.style.removeProperty('opacity');
  }
  window.__scaredycatRevealElement = reveal;
  window.__scaredycatRevealAll = function() {
    [...hidden.keys()].forEach(reveal);
  };
})();
