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

  return { canonicalImageKey };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatImageKey;
}
