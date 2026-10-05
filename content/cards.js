/**
 * Scaredy Cat - Card layer
 * Finds the "card" a picture belongs to on any site (a search result, a
 * trailer tile, a sponsored unit, an embedded player) and reads three things
 * off it:
 *   primary   the card's own title ("Hotel Visitor - Horror Short")
 *   secondary byline / channel / description text, a weak signal only
 *   kind      'video' | 'ad' | 'image'
 *
 * Generic by design: walk up from the media element to the nearest ancestor
 * that has a title-like element, stopping before the walk reaches a grid
 * (another large picture) or a whole article (too much text). A site adapter
 * (site-adapters.js) only overrides this where a site's markup needs it.
 * DOM-only, no chrome APIs; loaded before detector.js.
 */

const ScaredyCatCards = (function () {
  'use strict';

  // How far up a card may be from its picture. YouTube's ad slot is 7 levels
  // up; anything further is a section, not a card.
  const MAX_UP = 8;
  // Another picture at least this big, and at least this share of the
  // subject's area, inside an ancestor means the ancestor holds several
  // cards (a grid, a shelf), so the walk stops below it. A channel avatar or
  // a logo next to the thumbnail is part of the same card.
  const MIN_MEDIA_PX = 60;
  const PEER_AREA_SHARE = 0.4;
  // A "card" with more text than this is an article or a page section.
  const MAX_CARD_TEXT = 1500;
  const MAX_MEDIA_PER_ANCESTOR = 12;
  const TITLE_MAX = 200;
  const SECONDARY_MAX = 300;

  const GENERIC_TITLE_SELECTORS = [
    'h1, h2, h3, h4, h5, [role="heading"]',
    'a[title]',
    '[class*="title" i]',
    'a[aria-label]'
  ];
  const DURATION_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
  const SPONSOR_RE = /^(sponsored|ad|promoted|advertisement|paid partnership)$/i;
  const VIDEO_PATH_RE = /(^|\/)(watch|video|videos|trailer|trailers|clip|clips|shorts|reel|reels|embed)(\/|$)/i;
  const PLAY_SELECTOR = '[aria-label^="play" i], [class*="play-button" i], [class*="playbutton" i], ' +
    '[class*="play-icon" i], [class*="playicon" i], [data-testid*="play" i]';
  // Embedded players. The thumbnail of a YouTube embed is drawn as a CSS
  // background inside the cross-origin frame, so the page around it gets the
  // same picture from the video id instead.
  const YT_EMBED_RE = /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/i;
  const PLAYER_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com|vimeo\.com|dailymotion\.com|jwplayer\.com|jwplatform\.com|brightcove\.net|wistia\.(com|net)|streamable\.com)$/i;
  const AD_HOST_RE = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs\.com|amazon-adsystem\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|adsrvr\.org|rubiconproject\.com|pubmatic\.com|openx\.net|teads\.tv)$/i;

  function parentOf(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    return root && root.host ? root.host : null;
  }

  /** Rendered size, or the decoded size for an image not laid out yet. */
  function sizeOf(el) {
    let w = el.offsetWidth, h = el.offsetHeight;
    if ((!w || !h) && el.tagName === 'IMG') { w = el.naturalWidth; h = el.naturalHeight; }
    return { w: w || 0, h: h || 0 };
  }

  /** True when `node` holds a picture other than `media` that looks like a peer card's. */
  function holdsOtherMedia(node, media, minArea) {
    const list = node.querySelectorAll('img, video, iframe');
    if (list.length > MAX_MEDIA_PER_ANCESTOR) return true;
    for (const el of list) {
      if (el === media || media.contains(el) || el.contains(media)) continue;
      const { w, h } = sizeOf(el);
      if (w >= MIN_MEDIA_PX && h >= MIN_MEDIA_PX && w * h >= minArea) return true;
    }
    return false;
  }

  function clean(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function usableTitle(text) {
    if (text.length < 3) return '';
    if (DURATION_RE.test(text) || /^[\d\s.,:kmb]+(views?)?$/i.test(text)) return '';
    return text.slice(0, TITLE_MAX);
  }

  /** Title text of a title-like element: the title attribute, its text, then aria-label. */
  function titleTextOf(el, media) {
    const attr = clean(el.getAttribute('title'));
    if (attr) return usableTitle(attr);
    // A wrapper around the picture itself carries the picture's whole card
    // as text; only its attributes are a title.
    if (!el.contains(media)) {
      const text = clean(el.textContent);
      if (text && text.length <= TITLE_MAX * 1.5) return usableTitle(text);
    }
    return usableTitle(clean(el.getAttribute('aria-label')));
  }

  function findTitle(node, media, selectors) {
    for (const selector of selectors) {
      let list;
      try { list = node.querySelectorAll(selector); } catch (e) { continue; }
      for (const el of list) {
        const text = titleTextOf(el, media);
        if (text) return { el, text };
      }
    }
    return null;
  }

  /**
   * One pass over the card's text: the secondary text (outside the title),
   * plus whether a duration badge or a "Sponsored" label is present.
   */
  function scanCardText(card, titleEl) {
    const out = { secondary: '', duration: false, sponsored: false };
    const parts = [];
    let length = 0;
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, noscript, template')) continue;
      if (titleEl && titleEl.contains(node)) continue;
      const text = clean(node.nodeValue);
      if (!text) continue;
      if (DURATION_RE.test(text)) { out.duration = true; continue; }
      if (SPONSOR_RE.test(text)) { out.sponsored = true; continue; }
      if (text.length < 3 || length >= SECONDARY_MAX) continue;
      parts.push(text);
      length += text.length + 1;
    }
    out.secondary = parts.join(' ').slice(0, SECONDARY_MAX);
    return out;
  }

  function linksToVideo(card, media) {
    const links = [];
    const own = media.closest && media.closest('a[href]');
    if (own) links.push(own);
    const inCard = card.querySelectorAll('a[href]');
    for (let i = 0; i < inCard.length && i < 6; i++) links.push(inCard[i]);
    for (const a of links) {
      try {
        const u = new URL(a.href, location.href);
        if (VIDEO_PATH_RE.test(u.pathname) || u.searchParams.has('v')) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  function hostOf(url) {
    try { return new URL(url, location.href).hostname; } catch (e) { return ''; }
  }

  /** Thumbnail URL for a known embedded player, or null. */
  function embedThumbnail(src) {
    const m = YT_EMBED_RE.exec(src || '');
    return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
  }

  function iframeKind(src) {
    const host = hostOf(src);
    if (!host) return 'image';
    if (AD_HOST_RE.test(host)) return 'ad';
    if (PLAYER_HOST_RE.test(host)) return 'video';
    return 'image';
  }

  function textsOf(card, selector, limit) {
    if (!selector) return [];
    const out = [];
    let list;
    try { list = card.querySelectorAll(selector); } catch (e) { return out; }
    for (const el of list) {
      const text = clean(el.textContent);
      if (text && !out.includes(text)) out.push(text.slice(0, TITLE_MAX));
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Site adapter path: exact selectors, no walk. */
  function fromAdapter(media, adapter) {
    const card = media.closest(adapter.card);
    if (!card) return null;
    const title = findTitle(card, media, adapter.title);
    const ad = !!(adapter.ad && (card.matches(adapter.ad) || card.querySelector(adapter.ad)));
    const adTexts = ad ? textsOf(card, adapter.adText, 2) : [];
    const secondary = textsOf(card, adapter.secondary, 4).join(' ').slice(0, SECONDARY_MAX);
    const primary = [title ? title.text : '', ...adTexts].filter(Boolean).join(' ').slice(0, TITLE_MAX * 2);
    return {
      card, primary, secondary,
      kind: ad ? 'ad' : (adapter.kind || 'image'),
      sponsored: ad
    };
  }

  /**
   * Describe the card around `media`. Always returns an object; `card` is
   * null when the picture sits directly in a grid or alone in a big section.
   */
  function describe(media) {
    const tag = media.tagName;
    if (tag === 'IFRAME') {
      const src = media.src || '';
      return {
        card: null,
        primary: usableTitle(clean(media.getAttribute('title') || media.getAttribute('aria-label') || '')),
        secondary: '',
        kind: iframeKind(src),
        sponsored: AD_HOST_RE.test(hostOf(src))
      };
    }

    const adapter = typeof ScaredyCatSiteAdapters !== 'undefined'
      ? ScaredyCatSiteAdapters.forHost(location.hostname) : null;
    if (adapter) {
      const hit = fromAdapter(media, adapter);
      if (hit) return hit;
    }

    let card = null;
    let title = null;
    const own = sizeOf(media);
    const minArea = Math.max(MIN_MEDIA_PX * MIN_MEDIA_PX, own.w * own.h * PEER_AREA_SHARE);
    let node = parentOf(media);
    for (let depth = 0; depth < MAX_UP && node; depth++) {
      if (node === document.body || node === document.documentElement) break;
      if (holdsOtherMedia(node, media, minArea)) break;
      if ((node.textContent || '').length > MAX_CARD_TEXT) break;
      card = node;
      title = findTitle(node, media, GENERIC_TITLE_SELECTORS);
      if (title) break;
      node = parentOf(node);
    }

    if (!card) {
      return { card: null, primary: '', secondary: '', kind: tag === 'VIDEO' ? 'video' : 'image', sponsored: false };
    }
    const scan = scanCardText(card, title && title.el);
    let kind = 'image';
    if (scan.sponsored) kind = 'ad';
    else if (tag === 'VIDEO' || scan.duration || card.querySelector('video') ||
      card.querySelector(PLAY_SELECTOR) || linksToVideo(card, media)) kind = 'video';
    return {
      card,
      primary: title ? title.text : '',
      // Without a title the card's text is all secondary: it never counts
      // as the card naming itself.
      secondary: scan.secondary,
      kind,
      sponsored: scan.sponsored
    };
  }

  return { describe, embedThumbnail, iframeKind };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatCards;
} else if (typeof self !== 'undefined') {
  self.ScaredyCatCards = ScaredyCatCards;
}
