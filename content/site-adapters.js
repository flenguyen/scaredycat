/**
 * Scaredy Cat - Site adapters
 * Optional per-site hints for the card layer (cards.js). The generic card
 * heuristic works on any site; an adapter only exists where a site's markup
 * defeats it (ad units whose headline isn't a heading, say) or where exact
 * selectors are cheaper and more precise. Each entry:
 *   host:      hostname pattern
 *   card:      selector for a card container (closest() from the media)
 *   title:     selector(s) for the card's own title, tried in order
 *   secondary: selector for byline / channel / description text (weak signal)
 *   adText:    selector for an ad's headline and description; read as title
 *              text, since an ad is entirely about what it advertises
 *   ad:        selector that marks the card as an ad
 *   kind:      the card kind when the adapter's card matches ('video' here)
 * Selectors were read off captured pages (eval/cards/capture.mjs).
 */

const ScaredyCatSiteAdapters = (function () {
  'use strict';

  const ADAPTERS = [
    {
      // YouTube: classic polymer renderers, the newer lockup view models,
      // Shorts lockups and in-feed / search ad slots.
      host: /(^|\.)youtube\.com$/i,
      card: [
        'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer',
        'ytd-grid-video-renderer', 'ytd-playlist-video-renderer', 'ytd-reel-item-renderer',
        'yt-lockup-view-model', 'ytd-rich-grid-media', 'ytm-shorts-lockup-view-model',
        'ytm-shorts-lockup-view-model-v2', 'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer',
        'ytd-promoted-video-renderer', 'ytd-promoted-sparkles-web-renderer', 'ytd-search-pyv-renderer',
        'ytd-movie-renderer', 'ytd-radio-renderer'
      ].join(', '),
      title: [
        '#video-title', 'a#video-title-link',
        'h3 a[title]', 'h3 a[aria-label]',
        '[class*="lockup-metadata"] a[aria-label]', '[class*="LockupMetadata"] a[aria-label]',
        '.shortsLockupViewModelHostMetadataTitle', '[class*="MetadataTitle"]',
        'h3'
      ],
      secondary: [
        'ytd-channel-name #text', '#channel-name', '.metadata-snippet-text',
        '#description-text', '.videoSummaryContentViewModelParagraph',
        '[class*="ContentMetadata"]'
      ].join(', '),
      adText: 'feed-ad-metadata-view-model [class*="Headline"], feed-ad-metadata-view-model [class*="Description"], ' +
        '#ad-title, #ad-description, [class*="AdMetadata"] [class*="Headline"]',
      ad: 'ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-video-renderer, ' +
        'ytd-promoted-sparkles-web-renderer, ytd-search-pyv-renderer, feed-ad-metadata-view-model, ad-image-view-model',
      kind: 'video'
    }
  ];

  let cached;
  function forHost(hostname) {
    if (cached === undefined || cached.hostname !== hostname) {
      cached = { hostname, adapter: ADAPTERS.find(a => a.host.test(hostname)) || null };
    }
    return cached.adapter;
  }

  return { forHost };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatSiteAdapters;
} else if (typeof self !== 'undefined') {
  self.ScaredyCatSiteAdapters = ScaredyCatSiteAdapters;
}
