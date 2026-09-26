/**
 * Scaredy Cat - Database version helpers
 * Shared by the install-time seeder (background.js) and the daily remote
 * refresh (db-updater.js) so both agree on what "newer" means. Loaded into the
 * service worker via importScripts.
 */

const ScaredyCatDBVersion = (function () {
  'use strict';

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

  return { isValidDatabase, parseVersion, compareDbVersion };
})();
