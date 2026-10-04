/**
 * Scaredy Cat - "What's new" logic
 * Pure helpers over data/releases.json (bundled with the extension, so the
 * popup reads it locally with no network request). The popup renders what
 * these return; nothing here touches the DOM or chrome.* APIs.
 *
 * Loaded in the popup as a classic script (global ScaredyCatWhatsNew) and in
 * node tests through the module shim in eval/releases-test.mjs.
 */

const ScaredyCatWhatsNew = (function () {
  'use strict';

  const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Display order and kicker label for each change type. Privacy changes are
  // pulled out into their own card, so they have no kicker here.
  const GROUPS = [
    { type: 'new', label: 'NEW' },
    { type: 'improved', label: 'BETTER' },
    { type: 'fixed', label: 'FIXED' }
  ];

  function parseVersion(v) {
    const m = typeof v === 'string' ? VERSION_RE.exec(v.trim()) : null;
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  function isVersion(v) {
    return parseVersion(v) !== null;
  }

  /** Negative, zero or positive, like a sort comparator. Invalid sorts lowest. */
  function compareVersions(a, b) {
    const pa = parseVersion(a), pb = parseVersion(b);
    if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
  }

  /** Extension entries only, newest first. Accepts the payload or its releases array. */
  function extensionReleases(payload) {
    const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.releases) ? payload.releases : []);
    return list
      .filter(r => r && r.surface === 'extension' && isVersion(r.version))
      .sort((a, b) => compareVersions(b.version, a.version));
  }

  const isHighlight = (r) => r.level === 1 || r.level === 2;

  /**
   * What the popup shows: the newest Level 1 or 2 release, plus any Level 3
   * patches released on top of it. Newest first. When there is no Level 1/2
   * release at all, the newest release on its own.
   */
  function latestHighlight(releases) {
    const ext = extensionReleases(releases);
    const idx = ext.findIndex(isHighlight);
    if (idx === -1) return ext.slice(0, 1);
    return ext.slice(0, idx + 1);
  }

  /** True when the newest Level 1/2 release is newer than the version the user last saw. */
  function shouldShowMarker(releases, seen) {
    const highlight = extensionReleases(releases).find(isHighlight);
    if (!highlight) return false;
    if (!isVersion(seen)) return true;
    return compareVersions(highlight.version, seen) > 0;
  }

  /** "New in 1.5" for 1.5.0 (or for a release object carrying it). */
  function markerLabel(versionOrRelease) {
    const v = typeof versionOrRelease === 'string' ? versionOrRelease : versionOrRelease && versionOrRelease.version;
    const p = parseVersion(v);
    return p ? `New in ${p[0]}.${p[1]}` : "What's new";
  }

  /** Stable anchor on scaredycat.app/changelog: "1.5.0" -> "v1-5-0"; website ids pass through. */
  function anchorFor(versionOrId) {
    if (typeof versionOrId !== 'string') return '';
    if (versionOrId.startsWith('web-')) return versionOrId;
    return isVersion(versionOrId) ? 'v' + versionOrId.trim().replace(/\./g, '-') : '';
  }

  /** "2026-10-04" -> "Oct 4, 2026". Parsed by hand so no time zone can shift the day. */
  function formatDate(iso) {
    const m = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
    if (!m || +m[2] < 1 || +m[2] > 12) return '';
    return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  }

  /**
   * Split changes for display: ordered groups (NEW, BETTER, FIXED; empty ones
   * dropped) and the privacy texts on their own. Source order is kept inside
   * each group; unknown types are ignored.
   */
  function groupChanges(changes) {
    const list = Array.isArray(changes) ? changes : [];
    const text = (c) => (c && typeof c.text === 'string' ? c.text.trim() : '');
    const groups = GROUPS
      .map(g => ({ type: g.type, label: g.label, items: list.filter(c => c && c.type === g.type).map(text).filter(Boolean) }))
      .filter(g => g.items.length);
    const privacy = list.filter(c => c && c.type === 'privacy').map(text).filter(Boolean);
    return { groups, privacy };
  }

  return {
    compareVersions,
    isVersion,
    extensionReleases,
    latestHighlight,
    shouldShowMarker,
    markerLabel,
    anchorFor,
    formatDate,
    groupChanges
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatWhatsNew;
}
