/**
 * Scaredy Cat - Database version helpers and validation
 * Shared by the install-time seeder (background.js), the remote refresh
 * (db-updater.js) and the GET_DB fallback so all of them agree on what
 * "newer" means and on what a usable database looks like. Loaded into the
 * service worker via importScripts; sanitizeDatabase is unit-tested in
 * eval/db-validate-test.mjs.
 */

const ScaredyCatDBVersion = (function () {
  'use strict';

  const VERSION_RE = /^\d{1,4}(\.\d{1,4}){0,3}$/;
  const MAX_TITLES = 10000;
  const MAX_TITLE_LEN = 200;
  const MAX_VARIATIONS = 20;
  const MAX_SAFE_TITLES = 2000;
  const MAX_KEYWORDS = 1000;
  const MAX_KEYWORD_LEN = 100;
  // Remote payloads (title list, synopses) are refused above this size
  // before JSON.parse; today's merged list is ~270 KB.
  const MAX_BODY_BYTES = 2 * 1024 * 1024;

  function isValidDatabase(db) {
    return !!db
      && Array.isArray(db.titles) && db.titles.length > 0
      && typeof db.version === 'string';
  }

  function parseVersion(v) {
    return String(v || '').split('.').map(n => parseInt(n, 10) || 0);
  }

  /** Compare two databases by semver `version`, tie-broken by `lastUpdated`. */
  function compareDbVersion(a, b) {
    const va = parseVersion(a.version);
    const vb = parseVersion(b.version);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (va[i] || 0) - (vb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    const la = a.lastUpdated || '';
    const lb = b.lastUpdated || '';
    if (la < lb) return -1;
    if (la > lb) return 1;
    return 0;
  }

  function isShortString(v, max) {
    return typeof v === 'string' && v.trim() !== '' && v.length <= max;
  }

  /** One title entry rebuilt from known, typed fields; null if unusable. */
  function sanitizeEntry(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    if (!isShortString(e.title, MAX_TITLE_LEN)) return null;
    if (e.year != null && !Number.isInteger(e.year)) return null;
    if (e.variations != null && !Array.isArray(e.variations)) return null;
    for (const k of ['definite', 'auto']) {
      if (e[k] != null && typeof e[k] !== 'boolean') return null;
    }
    if (e.tmdb != null && !Number.isInteger(e.tmdb)) return null;
    if (e.type != null && !isShortString(e.type, 16)) return null;

    const out = {
      title: e.title,
      year: e.year ?? null,
      variations: (e.variations || [])
        .filter(v => isShortString(v, MAX_TITLE_LEN))
        .slice(0, MAX_VARIATIONS)
    };
    if (e.definite != null) out.definite = e.definite;
    if (e.auto != null) out.auto = e.auto;
    if (e.tmdb != null) out.tmdb = e.tmdb;
    if (e.type != null) out.type = e.type;
    return out;
  }

  /**
   * Strict copy of a title database, or null when it can't be used. Bad
   * entries are dropped one by one (one broken record must not disable the
   * list); a bad version, too many titles, or no usable titles rejects the
   * whole thing so the last good copy stays in place.
   *
   * `maxMajor` caps the major version: a remote list may be at most one
   * major ahead of the bundled one, so a forged "9999" can't pin itself as
   * newer than every future release.
   */
  function sanitizeDatabase(db, { maxMajor = null } = {}) {
    if (!db || typeof db !== 'object' || Array.isArray(db)) return null;
    if (typeof db.version !== 'string' || !VERSION_RE.test(db.version)) return null;
    if (maxMajor != null && parseVersion(db.version)[0] > maxMajor) return null;
    if (!Array.isArray(db.titles) || db.titles.length === 0 || db.titles.length > MAX_TITLES) return null;
    if (db.keywords != null && !Array.isArray(db.keywords)) return null;
    if (db.safeTitles != null && !Array.isArray(db.safeTitles)) return null;

    const titles = [];
    for (const e of db.titles) {
      const clean = sanitizeEntry(e);
      if (clean) titles.push(clean);
    }
    if (!titles.length) return null;

    const keywords = (db.keywords || [])
      .filter(k => k && isShortString(k.keyword, MAX_KEYWORD_LEN)
        && typeof k.weight === 'number' && Number.isFinite(k.weight) && k.weight >= 0 && k.weight <= 100)
      .slice(0, MAX_KEYWORDS)
      .map(k => ({ keyword: k.keyword, weight: k.weight }));
    const safeTitles = (db.safeTitles || [])
      .filter(t => isShortString(t, MAX_TITLE_LEN))
      .slice(0, MAX_SAFE_TITLES);

    const out = { version: db.version, titles, keywords, safeTitles };
    if (isShortString(db.lastUpdated, 40)) out.lastUpdated = db.lastUpdated;
    return out;
  }

  // ---- Service-worker helpers (not used under Node) --------------------------

  let bundledPromise = null;

  /**
   * The database shipped inside the extension, sanitized, read once per
   * worker life. Null if the file is missing or broken.
   */
  function getBundledDatabase() {
    if (!bundledPromise) {
      bundledPromise = fetch(chrome.runtime.getURL('data/horror-database.json'))
        .then(res => res.json())
        .then(db => sanitizeDatabase(db))
        .catch(() => {
          bundledPromise = null;
          return null;
        });
    }
    return bundledPromise;
  }

  /** Highest major version a stored or remote list may claim. */
  async function maxAllowedMajor() {
    const bundled = await getBundledDatabase();
    return bundled ? parseVersion(bundled.version)[0] + 1 : null;
  }

  /**
   * Read a fetch Response body as text, refusing anything over `maxBytes`
   * (by Content-Length up front, then by a running count while streaming).
   * Null when over the cap.
   */
  async function readCappedText(res, maxBytes = MAX_BODY_BYTES) {
    const declared = parseInt(res.headers.get('Content-Length') || '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    if (!res.body || !res.body.getReader) {
      const text = await res.text();
      return text.length > maxBytes ? null : text;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
    return new TextDecoder().decode(bytes);
  }

  function isJsonResponse(res) {
    return /^application\/json\b/i.test(res.headers.get('Content-Type') || '');
  }

  return {
    MAX_BODY_BYTES,
    isValidDatabase,
    parseVersion,
    compareDbVersion,
    sanitizeDatabase,
    getBundledDatabase,
    maxAllowedMajor,
    readCappedText,
    isJsonResponse
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatDBVersion;
}
