/**
 * Scaredy Cat - Horror Database Updater
 * Keeps the title list fresh between Chrome Web Store releases by fetching a
 * remotely-hosted copy of horror-database.json on a periodic alarm and caching
 * it in chrome.storage.local, which content scripts read directly. The bundled
 * copy is seeded into the same key by background.js; a remote copy only
 * replaces what's stored when it is at least as new (db-version.js decides).
 *
 * The same alarm refreshes the spoiler summaries (synopses.json), which only
 * the worker reads (see synopses.js). The two fetches are independent: one
 * failing never blocks the other.
 *
 * All failures are silent: a dead host, offline user, or malformed payload just
 * leaves the last good cache (or the bundled file) in place — detection never
 * breaks. Loaded into the service worker via importScripts.
 */

const ScaredyCatDBUpdater = (function () {
  'use strict';

  // Served by the website (scared-cat-web): the curated list from this repo
  // merged with daily TMDB-generated `auto: true` entries. The website proxies
  // the stored artifact with a stable ETag and answers If-None-Match with 304.
  // The runtime fetch is independent of the Web Store build, so list changes
  // reach users without a new release.
  const REMOTE_URL = 'https://www.scaredycat.app/api/titles/horror-database.json';
  // Spoiler summaries, edited in Sanity and served by the same website with
  // the same ETag/304 contract. 404 until deployed: that just keeps the stored
  // copy (or none).
  const SYNOPSES_URL = 'https://www.scaredycat.app/api/titles/synopses.json';
  const ALARM_NAME = 'refresh-horror-db';
  // Every 6 hours: both requests are usually cheap 304s.
  const PERIOD_MINUTES = 360;
  const CACHE_KEY = 'horrorDatabase';
  const ETAG_KEY = 'horrorDatabaseEtag';
  const FETCHED_AT_KEY = 'horrorDatabaseFetchedAt';
  const SYNOPSES_KEY = 'synopses';
  const SYNOPSES_ETAG_KEY = 'synopsesEtag';
  const SYNOPSES_FETCHED_AT_KEY = 'synopsesFetchedAt';

  const { isValidDatabase, compareDbVersion } = ScaredyCatDBVersion;

  async function ensureAlarm() {
    try {
      const existing = await chrome.alarms.get(ALARM_NAME);
      // Recreated (same name replaces) when missing, or when an older build
      // registered it with a different period (daily before synopses).
      if (!existing || existing.periodInMinutes !== PERIOD_MINUTES) {
        // First fetch ~1 min out (don't block startup), then every period.
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
      }
    } catch (e) {
      // chrome.alarms unavailable — nothing to do.
    }
  }

  async function refresh() {
    await Promise.all([refreshDatabase(), refreshSynopses()]);
  }

  async function refreshDatabase() {
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

      // Never replace a newer stored copy (e.g. a fresh release's bundled DB)
      // with an older remote one.
      const { [CACHE_KEY]: stored } = await chrome.storage.local.get(CACHE_KEY);
      if (isValidDatabase(stored) && compareDbVersion(db, stored) < 0) return;

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

  async function refreshSynopses() {
    try {
      const { [SYNOPSES_ETAG_KEY]: etag } = await chrome.storage.local.get(SYNOPSES_ETAG_KEY);
      // Only revalidate a copy we still hold: a 304 must never leave us empty.
      // (Byte count, so the ~200KB payload isn't deserialized just to check.)
      const held = etag && (await chrome.storage.local.getBytesInUse(SYNOPSES_KEY)) > 0;
      const headers = {};
      if (held) headers['If-None-Match'] = etag;

      const res = await fetch(SYNOPSES_URL, { headers, cache: 'no-cache' });
      if (res.status === 304) {
        await chrome.storage.local.set({ [SYNOPSES_FETCHED_AT_KEY]: Date.now() });
        return;
      }
      if (!res.ok) return; // 404 (not deployed) / 5xx — keep what's stored

      let payload;
      try {
        payload = ScaredyCatSynopses.sanitizePayload(JSON.parse(await res.text()));
      } catch (e) {
        return; // malformed JSON
      }
      if (!payload) return;

      await chrome.storage.local.set({
        [SYNOPSES_KEY]: payload,
        [SYNOPSES_ETAG_KEY]: res.headers.get('ETag') || null,
        [SYNOPSES_FETCHED_AT_KEY]: Date.now()
      });
      console.log(`Scaredy Cat: synopses refreshed (${payload.titles.length} titles)`);
    } catch (e) {
      // Network/storage error — keep the last good copy silently.
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

  return { refresh, refreshDatabase, refreshSynopses, ensureAlarm, REMOTE_URL, SYNOPSES_URL, ALARM_NAME };
})();
