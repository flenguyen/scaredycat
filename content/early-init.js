/**
 * Scaredy Cat - Early Init Script
 * Runs at document_start ONLY on media sites to pre-hide hero content.
 * Minimal footprint - does nothing on regular websites.
 */

(function() {
  'use strict';

  // Only run on known media sites - exit immediately otherwise
  const MEDIA_SITES = /^(www\.)?(imdb\.com|rottentomatoes\.com|themoviedb\.org|letterboxd\.com|shudder\.com|netflix\.com|hulu\.com|disneyplus\.com|hbomax\.com|max\.com|primevideo\.com|fandango\.com)/i;

  if (!MEDIA_SITES.test(window.location.hostname)) {
    return; // Exit immediately - no overhead on regular sites
  }

  console.log('Scaredy Cat: Media site detected, enabling early protection');
  window.__scaredycatMediaSite = true;

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
    if (!el || !el.matches) return;

    // Quick check for hero/poster elements
    if (el.matches('[data-testid*="hero"], [data-testid*="poster"], .ipc-poster, .ipc-media--poster, [class*="hero-media"], [data-qa*="poster"]')) {
      el.style.opacity = '0';
      el.setAttribute('data-scaredycat-early-hidden', '1');
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
  window.__scaredycatRevealElement = function(el) {
    if (el.hasAttribute('data-scaredycat-early-hidden')) {
      el.removeAttribute('data-scaredycat-early-hidden');
      el.style.opacity = '1';
    }
  };
})();
