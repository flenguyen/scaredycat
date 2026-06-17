/**
 * Scaredy Cat - Genre Signal
 * Pure helpers for detecting an explicit "Horror" genre declaration, shared by
 * the content-script detector (DOM walking) and the Node eval harness. No
 * chrome/window/document references live here — the DOM traversal stays in
 * detector.js and feeds strings/objects into these pure predicates, so the
 * decision logic is measurable offline (same pattern as scoring-core.js).
 */

const ScaredyCatGenre = (function () {
  'use strict';

  const HORROR_RE = /\bhorror\b/i;
  // A genre line is a short, separated list ("Horror/Sci-Fi/Romance",
  // "Horror, Mystery & Thriller") or a bare single genre.
  const SEPARATOR_RE = /[\/,•·|]|&|\band\b/i;

  // TMDB's genre id for Horror. Many catalog sites (Cineby and its mirror
  // domains, and any other TMDB-powered front-end) filter listings with the
  // raw id rather than the word, e.g. `/movies?genre=27` or `?genres=27,53`.
  // Matching the id keeps the predicate site-agnostic: it keys off the data
  // model the page is built on, not a hostname.
  const TMDB_HORROR_ID = '27';

  /**
   * Does a URL look like a listing/browse page filtered to the Horror genre?
   * Pure: takes an href string so it's testable offline. Covers the two
   * cross-site shapes a horror filter takes on catalog sites:
   *
   *   1. Path token:  /genre/horror, /genres/horror, /category/horror,
   *      /browse/movie/horror, hash routes (#/genre/horror).
   *   2. Query param: ?genre=horror, ?genres=horror, ?genre=27 (TMDB id),
   *      ?with_genres=27, ?genres=27,53.
   *
   * Deliberately requires the horror token to sit in a genre-shaped position
   * (a "genre" path segment, or a genre/with_genres query key) so a movie
   * literally titled "Horror" at /movie/the-horror doesn't trip it.
   */
  function urlLooksLikeHorrorListing(href) {
    if (!href) return false;
    let url;
    try {
      url = new URL(href, 'http://x/');
    } catch (e) {
      return false;
    }

    // Normalize hash routes (#/genre/horror) into the same space as the path.
    const pathSpace = (url.pathname + ' ' + url.hash).toLowerCase();
    // "horror" as a path segment immediately after a listing-context segment
    // (genre/genres/category/browse/movies/tv/shows/films), e.g.
    // /genre/horror, /browse/movie/horror, /category/horror; or the
    // hyphenated catalog slug (horror-movies). Requiring a listing-context
    // parent keeps a movie titled "Horror" at /movie/the-horror from tripping.
    if (/\/(?:genres?|category|categories|browse|movies?|tv|shows?|films?)\/(?:[a-z-]+\/)?horror(?:\/|$|[?#\s])/i.test(pathSpace)
        || /\bhorror-(?:movies|tv|shows|films)\b/i.test(pathSpace)) {
      return true;
    }

    // Query params: a genre-shaped key naming horror (word or TMDB id). Read
    // from both the real search string and any hash query (`#/x?genre=27`).
    const search = url.search + (url.hash.includes('?') ? '&' + url.hash.split('?')[1] : '');
    let params;
    try {
      params = new URLSearchParams(search);
    } catch (e) {
      return false;
    }
    for (const [key, value] of params) {
      if (!/^(?:with_)?genres?$/i.test(key)) continue;
      const tokens = String(value).split(/[,|]/).map(t => t.trim());
      if (tokens.some(t => HORROR_RE.test(t) || t === TMDB_HORROR_ID)) return true;
    }
    return false;
  }

  /**
   * Given a list of visible "active filter" labels (selected chips,
   * aria-current breadcrumbs), does one name the Horror genre? Each label is
   * held to the same genre-line shape as textLooksLikeHorrorGenre so a stray
   * "Horror" link that merely happens to be styled active doesn't qualify on
   * its own — the caller scopes which elements count as active.
   */
  function activeFiltersDeclareHorror(labels) {
    if (!labels) return false;
    return labels.some(label => textLooksLikeHorrorGenre(label));
  }

  /**
   * Does a visible text node read like a genre line that includes Horror?
   * Conservative: short, and either a multi-genre list or 1-3 words. A
   * synopsis paragraph that merely contains the word "horror" does not match.
   */
  function textLooksLikeHorrorGenre(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > 120) return false;
    if (!HORROR_RE.test(trimmed)) return false;
    const words = trimmed.split(/\s+/).length;
    return words <= 8 && (SEPARATOR_RE.test(trimmed) || words <= 3);
  }

  /** Does any genre string in a list name Horror? (structured metadata) */
  function genreListIsHorror(genre) {
    if (genre == null) return false;
    const genres = Array.isArray(genre) ? genre : [genre];
    return genres.some(g => HORROR_RE.test(String(g)));
  }

  /** schema.org @type that represents a single piece of screen media. */
  function isMediaType(type) {
    if (!type) return false;
    const s = Array.isArray(type) ? type.join(' ') : String(type);
    return /movie|tvseries|tvepisode|videoobject|creativework/i.test(s);
  }

  /**
   * Given parsed JSON-LD (object or array), does it declare a Horror-genre
   * media item?
   */
  function jsonLdDeclaresHorror(data) {
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (isMediaType(item['@type']) && genreListIsHorror(item.genre)) return true;
    }
    return false;
  }

  return {
    textLooksLikeHorrorGenre,
    genreListIsHorror,
    isMediaType,
    jsonLdDeclaresHorror,
    urlLooksLikeHorrorListing,
    activeFiltersDeclareHorror
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatGenre;
} else if (typeof self !== 'undefined') {
  self.ScaredyCatGenre = ScaredyCatGenre;
}
