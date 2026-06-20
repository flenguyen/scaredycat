/**
 * Scaredy Cat - Horror Database Updater
 * Keeps the title list fresh between Chrome Web Store releases by fetching a
 * remotely-hosted copy of horror-database.json on a daily alarm and caching it
 * in chrome.storage.local. The content-script detector prefers this cached copy
 * when it's at least as new as the bundled file (see detector.js resolveDatabase).
 *
 * All failures are silent: a dead host, offline user, or malformed payload just
 * leaves the last good cache (or the bundled file) in place — detection never
 * breaks. Loaded into the service worker via importScripts.
 */

const ScaredyCatDBUpdater = (function () {
  'use strict';

  // Served from the extension repo itself. The runtime fetch is independent of
  // the Web Store build, so list changes reach users without a new release.
  const REMOTE_URL =
    'https://raw.githubusercontent.com/flenguyen/scaredycat/main/data/horror-database.json';
  const ALARM_NAME = 'refresh-horror-db';
  const PERIOD_MINUTES = 1440; // daily
  const CACHE_KEY = 'horrorDatabase';
  const ETAG_KEY = 'horrorDatabaseEtag';
  const FETCHED_AT_KEY = 'horrorDatabaseFetchedAt';

  function isValidDatabase(db) {
    return !!db
      && Array.isArray(db.titles) && db.titles.length > 0
      && typeof db.version === 'string';
  }

  async function ensureAlarm() {
    try {
      const existing = await chrome.alarms.get(ALARM_NAME);
      if (!existing) {
        // First fetch ~1 min after install (don't block startup), daily after.
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
      }
    } catch (e) {
      // chrome.alarms unavailable — nothing to do.
    }
  }

  async function refresh() {
    try {
      const { [ETAG_KEY]: etag } = await chrome.storage.local.get(ETAG_KEY);
      const headers = {};
      if (etag) headers['If-None-Match'] = etag;

      const res = await fetch(REMOTE_URL, { headers, cache: 'no-cache' });
      if (res.status === 304) return;        // unchanged — cheap path
      if (!res.ok) return;

      const text = await res.text();
      let db;
      try {
        db = JSON.parse(text);
      } catch (e) {
        return; // malformed JSON — never poison the cache
      }
      if (!isValidDatabase(db)) return;

      await chrome.storage.local.set({
        [CACHE_KEY]: db,
        [ETAG_KEY]: res.headers.get('ETag') || null,
        [FETCHED_AT_KEY]: Date.now()
      });
      console.log(
        `Scaredy Cat: horror DB refreshed to v${db.version} (${db.titles.length} titles)`
      );
    } catch (e) {
      // Network/storage error — keep the last good cache silently.
    }
  }

  // Self-register lifecycle hooks at worker evaluation time.
  chrome.runtime.onInstalled.addListener(ensureAlarm);
  chrome.runtime.onStartup.addListener(ensureAlarm);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) refresh();
  });
  // Also ensure the alarm exists on every worker spin-up (cheap; no-op if set).
  ensureAlarm();

  return { refresh, ensureAlarm, REMOTE_URL, ALARM_NAME };
})();
