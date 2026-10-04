/**
 * Scaredy Cat - Canonical image keys
 * The same poster is served at many URLs (YouTube thumbnail sizes, TMDB
 * width buckets, Amazon's _V1_ resize ops, generic ?w=&h= params). The
 * classifier's verdict is the same for all of them, so the verdict cache and
 * in-flight dedupe key on a canonical form. Only rules anchored on an
 * immutable image id collapse across sizes; anything ambiguous is left alone.
 * The ORIGINAL url is still what gets fetched. Pure function (also unit-tested
 * in eval/image-key-test.mjs); loaded into the service worker via importScripts.
 */

const ScaredyCatImageKey = (function () {
  'use strict';

  // Query params that only describe a resize/format, never a different image.
  const RESIZE_PARAMS = new Set([
    'w', 'h', 'width', 'height', 'q', 'quality', 'fit', 'format', 'auto', 'dpr', 'size', 'resize'
  ]);

  function canonicalImageKey(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return String(url || '');
    }
    const host = u.hostname.toLowerCase();
    const p = u.pathname;
    let m;

    // YouTube: /vi/<videoId>/hqdefault.jpg, /vi_webp/<id>/maxresdefault.webp,
    // plus ?sqp=…&rs=… crop params. All frames of one video id.
    if (/(^|\.)ytimg\.com$/.test(host) && (m = /^\/vi(?:_webp)?\/([^/]+)\//.exec(p))) {
      return `yt:${m[1]}`;
    }
    // TMDB: /t/p/<w300|w500|original>/<file>
    if (host === 'image.tmdb.org' && (m = /^\/t\/p\/[^/]+\/(.+)$/.exec(p))) {
      return `tmdb:${m[1]}`;
    }
    // Amazon/IMDb: /images/M/<immutable id>._V1_<resize ops>_.jpg
    if (host === 'm.media-amazon.com' && (m = /^\/images\/M\/([^./]+)\./.exec(p))) {
      return `amzn:${m[1]}`;
    }
    // Flixster (Rotten Tomatoes): /<hash>/<w>x<h>/v2/<inner image url>
    if (host === 'resizing.flixster.com' && (m = /^\/[^/]+\/\d+x\d+\/v2\/(.+)$/.exec(p))) {
      return `flixster:${m[1]}`;
    }
    // Letterboxd: /resized/.../<name>-0-<w>-0-<h>-crop.jpg
    if (/(^|\.)ltrbxd\.com$/.test(host) && /^\/resized\//.test(p)) {
      return `ltrbxd:${p.replace(/-0-\d+-0-\d+(?=(-crop)?\.[a-z]+$)/i, '')}${u.search}`;
    }

    // Generic: drop pure resize params, keep everything else, drop the hash.
    if (u.search) {
      const params = new URLSearchParams(u.search);
      let changed = false;
      for (const k of [...params.keys()]) {
        if (RESIZE_PARAMS.has(k.toLowerCase())) {
          params.delete(k);
          changed = true;
        }
      }
      if (changed) {
        const s = params.toString();
        return `${u.origin}${p}${s ? '?' + s : ''}`;
      }
    }
    return `${u.origin}${p}${u.search}`;
  }

  // Smaller renditions the classifier could fetch instead of the page's URL.
  // The model only ever sees a 256x256 center crop, so the target is the
  // smallest size whose short side stays at or above 256 for both posters
  // (2:3) and stills (16:9), without knowing which one a URL is.
  const TMDB_SIZE = 'w500';           // 500x750 poster, 500x281 backdrop
  const TMDB_WIDTHS = { w92: 92, w154: 154, w185: 185, w300: 300, w342: 342, w500: 500, w780: 780, w1280: 1280, original: Infinity };
  const AMZN_WIDTH = 512;             // ._V1_UX512_ -> 512x758 poster, 512x288 still
  const YT_SMALL = 'hqdefault';       // 480x360 (letterboxed for 16:9 videos)
  const YT_LARGE = new Set(['maxresdefault', 'sddefault', 'hq720']);

  /**
   * Same image at a smaller size on the same CDN, or the URL unchanged when
   * there is no safe rewrite. Never asks for a bigger image than the page
   * did, and leaves Amazon URLs with crop ops alone (the crop changes what
   * the model sees). `cdns` picks which rules apply.
   */
  function smallVariantUrl(url, { cdns = ['tmdb', 'amzn', 'yt'] } = {}) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return url;
    }
    const host = u.hostname.toLowerCase();
    let m;
    if (cdns.includes('tmdb') && host === 'image.tmdb.org' && (m = /^\/t\/p\/([^/]+)\/(.+)$/.exec(u.pathname))) {
      const width = TMDB_WIDTHS[m[1]];
      if (width && width > TMDB_WIDTHS[TMDB_SIZE]) {
        return `${u.origin}/t/p/${TMDB_SIZE}/${m[2]}`;
      }
      return url;
    }
    if (cdns.includes('amzn') && host === 'm.media-amazon.com' &&
        (m = /^(\/images\/M\/[^./]+\.)_V1_(.*?)\.(jpe?g|png|webp)$/i.exec(u.pathname))) {
      const ops = m[2].replace(/_+$/, '');
      // Plain resize/quality ops only (or none, the full-size original).
      if (ops && !/^((QL|UX|UY|SX|SY)\d+_?)+$/i.test(ops + '_')) return url;
      const w = /(?:UX|SX)(\d+)/i.exec(ops);
      if (w && parseInt(w[1], 10) <= AMZN_WIDTH) return url;
      if (/(?:UY|SY)\d+/i.test(ops) && !w) return url; // height-bound: aspect unknown, leave it
      return `${u.origin}${m[1]}_V1_UX${AMZN_WIDTH}_.${m[3]}`;
    }
    if (cdns.includes('yt') && /(^|\.)ytimg\.com$/.test(host) &&
        (m = /^\/vi(_webp)?\/([^/]+)\/([a-z0-9]+)\.(jpg|webp)$/i.exec(u.pathname))) {
      // Signed crop params (sqp/rs) describe the page's crop; keep those.
      if (u.search || !YT_LARGE.has(m[3])) return url;
      return `${u.origin}/vi/${m[2]}/${YT_SMALL}.jpg`;
    }
    return url;
  }

  return { canonicalImageKey, smallVariantUrl };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatImageKey;
}
