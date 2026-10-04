/**
 * Scaredy Cat - Message and URL guards
 * Everything the worker accepts from outside its own code goes through here:
 * who sent a message (popup/extension page vs content script), whether its
 * payload has the expected shape, what a settings object may contain, and
 * which image URLs the classifier is allowed to fetch.
 *
 * Content scripts run inside web pages, so a hostile or compromised page can
 * forge their messages. The rules below keep what such a page can do narrow:
 * no settings changes beyond the feedback opt-in, no site toggles, no
 * allowlist removals, bounded payloads, and no fetches into the private
 * network through the classifier.
 *
 * Pure functions (unit-tested in eval/guards-test.mjs). Loaded into the
 * service worker via importScripts, into the popup with a <script> tag, and
 * into the offscreen document as a classic script before its module, which
 * then reads the same global (one copy of isFetchableImageUrl everywhere).
 */

const ScaredyCatGuards = (function () {
  'use strict';

  const MAX_URL = 2048;
  const MAX_ITEM = 2048;
  const MAX_TITLE = 200;
  const SENSITIVITIES = ['low', 'medium', 'high'];
  const DISABLED_SITES_MAX = 300;
  const ALLOWED_TITLES_MAX = 100;
  const BLOCKED_COUNT_MAX = 200;
  const PAGE_COUNT_MAX = 100000;
  const FONT_FILES = ['BricolageGrotesque.woff2', 'Fraunces.woff2', 'Fraunces-Italic.woff2', 'Inter.woff2'];

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    sensitivity: 'medium', // 'low' (80+), 'medium' (60+), 'high' (40+)
    disabledSites: Object.freeze([]),
    allowedTitles: Object.freeze([]), // normalized titles the user chose to show
    feedbackConsent: false // opt-in gate for sending any feedback off-device
  });

  // Same as ScaredyCatScoring.normalizeText (content/scoring-core.js); the
  // popup loads this file without scoring-core. eval/guards-test.mjs checks
  // the two agree.
  function normalizeTitle(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isString(v, max) {
    return typeof v === 'string' && v.length > 0 && v.length <= max;
  }

  function isCount(v, max) {
    return Number.isInteger(v) && v >= 0 && v <= max;
  }

  // ---- senders ----------------------------------------------------------------

  /**
   * 'page' for the extension's own pages (popup, welcome page, offscreen):
   * same extension id and a URL on the extension's origin. The welcome page
   * runs in a tab, so a tab alone doesn't make a sender a content script.
   * 'content' for content scripts (same extension id, inside a web page tab).
   * null for anything else (other extensions, no sender).
   */
  function senderKind(sender, runtimeId, extensionOrigin) {
    if (!sender || !runtimeId || sender.id !== runtimeId) return null;
    const url = typeof sender.url === 'string' ? sender.url : '';
    if (extensionOrigin && url.startsWith(extensionOrigin) &&
        (sender.origin === undefined || extensionOrigin.startsWith(sender.origin))) {
      return 'page';
    }
    if (sender.tab) return 'content';
    return null;
  }

  // ---- hostnames --------------------------------------------------------------

  function isHostnameShaped(host) {
    if (typeof host !== 'string' || !host || host.length > 253) return false;
    return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/i.test(host) || /^\[[0-9a-f:.]+\]$/i.test(host);
  }

  // ---- settings ---------------------------------------------------------------

  /**
   * Keep only known keys with valid values; anything missing or wrong falls
   * back to the default. Applied on every read and every write, so a corrupt
   * synced value repairs itself instead of breaking the extension.
   */
  function sanitizeSettings(obj, normalize = normalizeTitle) {
    const src = isPlainObject(obj) ? obj : {};
    const out = {
      enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_SETTINGS.enabled,
      sensitivity: SENSITIVITIES.includes(src.sensitivity) ? src.sensitivity : DEFAULT_SETTINGS.sensitivity,
      disabledSites: [],
      allowedTitles: [],
      feedbackConsent: typeof src.feedbackConsent === 'boolean' ? src.feedbackConsent : DEFAULT_SETTINGS.feedbackConsent
    };
    if (Array.isArray(src.disabledSites)) {
      const seen = new Set();
      for (const site of src.disabledSites) {
        if (!isHostnameShaped(site)) continue;
        const host = site.toLowerCase();
        if (seen.has(host)) continue;
        seen.add(host);
        out.disabledSites.push(host);
      }
      // Newest entries are at the end; keep those.
      out.disabledSites = out.disabledSites.slice(-DISABLED_SITES_MAX);
    }
    if (Array.isArray(src.allowedTitles)) {
      out.allowedTitles = addTitles([], src.allowedTitles, normalize);
    }
    return out;
  }

  /** Append normalized titles, deduplicated, newest kept when over the cap. */
  function addTitles(current, titles, normalize = normalizeTitle) {
    const out = [];
    const seen = new Set();
    for (const raw of [...current, ...titles]) {
      if (typeof raw !== 'string' || raw.length > MAX_TITLE * 2) continue;
      const t = normalize(raw).slice(0, MAX_TITLE);
      if (!t) continue;
      if (seen.has(t)) {
        // Re-adding moves it to the end (most recent).
        out.splice(out.indexOf(t), 1);
      }
      seen.add(t);
      out.push(t);
    }
    return out.slice(-ALLOWED_TITLES_MAX);
  }

  // ---- messages ---------------------------------------------------------------

  const any = () => true;
  const item = (m) => isString(m.item, MAX_ITEM);
  const hostname = (m) => isHostnameShaped(m.hostname);

  /**
   * Per-type payload rules. `pageOnly` types are refused from content
   * scripts. `check` returns true, false (malformed) or 'forbidden'.
   */
  const SCHEMAS = {
    CLASSIFY_IMAGE: { check: (m) => isString(m.url, MAX_URL) },
    WARM_ML: { check: any },
    GET_SYNOPSIS: {
      check: (m) => isString(m.title, 300)
        && (m.year == null || Number.isInteger(m.year))
        && (m.tmdb == null || Number.isInteger(m.tmdb) || (typeof m.tmdb === 'string' && /^\d{1,12}$/.test(m.tmdb)))
        && (m.mediaType == null || isString(m.mediaType, 16))
    },
    INCREMENT_BLOCKED: {
      // count is clamped to BLOCKED_COUNT_MAX by the handler; pageCount is the
      // tab's live total for the badge (optional for older content scripts).
      check: (m) => Number.isInteger(m.count) && m.count >= 1
        && (m.pageCount == null || isCount(m.pageCount, PAGE_COUNT_MAX))
    },
    SET_BADGE: { check: (m) => isCount(m.pageCount, PAGE_COUNT_MAX) },
    GET_PAGE_STATS: { check: any },
    GET_SETTINGS: { check: any },
    UPDATE_SETTINGS: {
      check: (m, kind) => {
        if (!isPlainObject(m.settings)) return false;
        if (kind === 'page') return true;
        // Content scripts may only record the feedback opt-in (the in-page
        // consent sheet). Everything else belongs to the popup.
        const keys = Object.keys(m.settings);
        if (keys.length !== 1 || keys[0] !== 'feedbackConsent') return 'forbidden';
        return typeof m.settings.feedbackConsent === 'boolean';
      }
    },
    SUBMIT_FEEDBACK: { check: (m) => isPlainObject(m.report) },
    ADD_TO_ALLOWLIST: { check: item },
    REMOVE_FROM_ALLOWLIST: { check: item, pageOnly: true },
    ADD_TO_BLOCKLIST: { check: item },
    REMOVE_FROM_BLOCKLIST: { check: item },
    TOGGLE_SITE: { check: hostname, pageOnly: true },
    GET_SITE_STATUS: { check: hostname, pageOnly: true },
    GET_DB: { check: (m) => m.bundled == null || typeof m.bundled === 'boolean' },
    GET_UI_CSS: { check: any },
    GET_FONT: { check: (m) => FONT_FILES.includes(m.file) }
  };

  /**
   * null when the message may be handled, otherwise the error to answer
   * with: 'forbidden' (wrong sender), 'invalid' (malformed payload) or
   * 'unknown' (no such message type).
   */
  function checkMessage(message, kind) {
    if (kind !== 'page' && kind !== 'content') return 'forbidden';
    if (!isPlainObject(message) || typeof message.type !== 'string') return 'invalid';
    if (!Object.prototype.hasOwnProperty.call(SCHEMAS, message.type)) return 'unknown';
    const schema = SCHEMAS[message.type];
    if (schema.pageOnly && kind !== 'page') return 'forbidden';
    const ok = schema.check(message, kind);
    if (ok === 'forbidden') return 'forbidden';
    return ok === true ? null : 'invalid';
  }

  // ---- image URLs -------------------------------------------------------------

  function parseIPv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    return parts.every(n => n <= 255) ? parts : null;
  }

  /** Not a globally routable unicast address (private, loopback, reserved...). */
  function isNonPublicIPv4([a, b, c]) {
    return a === 0                                   // 0.0.0.0/8 "this network"
      || a === 10                                    // 10/8 private
      || a === 127                                   // loopback
      || (a === 100 && b >= 64 && b <= 127)          // 100.64/10 CGNAT
      || (a === 169 && b === 254)                    // link-local
      || (a === 172 && b >= 16 && b <= 31)           // 172.16/12 private
      || (a === 192 && b === 168)                    // 192.168/16 private
      || (a === 192 && b === 0 && (c === 0 || c === 2)) // IETF assignments, TEST-NET-1
      || (a === 198 && (b === 18 || b === 19))       // benchmarking
      || (a === 198 && b === 51 && c === 100)        // TEST-NET-2
      || (a === 203 && b === 0 && c === 113)         // TEST-NET-3
      || a >= 224;                                   // multicast, reserved, broadcast
  }

  /** Eight 16-bit groups, or null. Accepts a trailing dotted IPv4. */
  function parseIPv6(host) {
    let s = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (!/^[0-9a-f:.]+$/.test(s)) return null;
    // Rewrite a trailing dotted IPv4 as two hex groups.
    const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
    if (v4) {
      const p = parseIPv4(v4[1]);
      if (!p) return null;
      s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const toGroups = (part) => (part ? part.split(':') : []).map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    const head = toGroups(halves[0]);
    const rest = halves.length === 2 ? toGroups(halves[1]) : [];
    if (halves.length === 2 && head.length + rest.length > 7) return null;
    const groups = halves.length === 2
      ? [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest]
      : head;
    if (groups.length !== 8 || groups.some(g => !Number.isInteger(g))) return null;
    return groups;
  }

  function isNonPublicIPv6(g) {
    const zeroPrefix = (n) => g.slice(0, n).every(x => x === 0);
    const embedded = (hi, lo) => isNonPublicIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    if (zeroPrefix(7) && (g[7] === 0 || g[7] === 1)) return true;          // :: and ::1
    if (zeroPrefix(5) && g[5] === 0xffff) return embedded(g[6], g[7]);      // ::ffff:a.b.c.d mapped
    if (zeroPrefix(6)) return true;                                          // ::a.b.c.d (deprecated)
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return embedded(g[6], g[7]); // NAT64
    if (g[0] === 0x2002) return embedded(g[1], g[2]);                        // 6to4
    if ((g[0] & 0xfe00) === 0xfc00) return true;                             // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true;                             // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true;                             // fec0::/10 site-local
    if ((g[0] & 0xff00) === 0xff00) return true;                             // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                     // documentation
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
    return false;
  }

  const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.localdomain', '.intranet'];

  /**
   * May the classifier fetch this URL? http(s) only, no credentials, and
   * never a host on the user's own machine or network. new URL() already
   * turns decimal, octal and hex IPv4 forms (http://2130706433/,
   * http://0x7f.1/) into dotted quads, so one range check covers them.
   * DNS names that resolve to private addresses can't be seen from here;
   * that gap is accepted (the response is never readable by a page).
   */
  function isFetchableImageUrl(url) {
    if (typeof url !== 'string' || !url || url.length > MAX_URL) return false;
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/\.+$/, '');
    if (!host) return false;
    if (host.startsWith('[')) {
      const groups = parseIPv6(host);
      return !!groups && !isNonPublicIPv6(groups);
    }
    const v4 = parseIPv4(host);
    if (v4) return !isNonPublicIPv4(v4);
    // A bare all-numeric label is an IPv4 form URL didn't normalize; refuse.
    if (/^[0-9.]+$/.test(host)) return false;
    if (host === 'localhost' || LOCAL_SUFFIXES.some(sfx => host.endsWith(sfx))) return false;
    // Single-label names ("router", "nas") resolve through the local network.
    if (!host.includes('.')) return false;
    return true;
  }

  return {
    DEFAULT_SETTINGS,
    SENSITIVITIES,
    FONT_FILES,
    BLOCKED_COUNT_MAX,
    PAGE_COUNT_MAX,
    MAX_ITEM,
    normalizeTitle,
    senderKind,
    isHostnameShaped,
    sanitizeSettings,
    addTitles,
    checkMessage,
    isFetchableImageUrl,
    parseIPv6
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatGuards;
}
