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
 * Both payloads must be application/json under 2 MB and carry a valid
 * X-Scaredy-Signature from a key in trust.js. The signature is checked on the
 * raw bytes before they are decoded or parsed; an unsigned, tampered or
 * wrongly signed download is refused and the last good copy stays. While
 * trust.js has no keys, no download is attempted at all. A copy stored by an
 * older version (before the website signed its files) stays in use until a
 * signed one arrives: the website's ETag gains the kid when it starts
 * signing, so that first request is a 200 with a signature instead of a 304.
 * After the signature, the title list goes through db-version.js
 * sanitizeDatabase (typed entries, bad ones dropped, version sanity) before
 * it is stored.
 *
 * Failures leave the last good cache (or the bundled file) in place, so
 * detection never breaks. A dead host, offline user or malformed payload is
 * silent; a refused signature logs one console.warn. Loaded into the service
 * worker via importScripts, after trust.js.
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

  const { sanitizeDatabase, compareDbVersion, maxAllowedMajor, readCappedBytes, isJsonResponse } = ScaredyCatDBVersion;
  // The verdict cache (IndexedDB) is trimmed from this alarm, at most once a
  // day, instead of on every worker start.
  const PRUNED_AT_KEY = 'verdictsPrunedAt';
  const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

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
    await Promise.all([refreshDatabase(), refreshSynopses(), pruneVerdictsDaily()]);
  }

  async function pruneVerdictsDaily() {
    try {
      const { [PRUNED_AT_KEY]: at } = await chrome.storage.local.get(PRUNED_AT_KEY);
      if (at && Date.now() - at < PRUNE_EVERY_MS) return;
      await ScaredyCatVerdictCache.prune();
      await chrome.storage.local.set({ [PRUNED_AT_KEY]: Date.now() });
    } catch (e) {
      // Best effort; the next alarm tries again.
    }
  }

  /**
   * The body of a 200 JSON response as text, once its signature checks out
   * for `url` (the URL we requested, which names the file in the signed
   * message). Null for a non-200, a non-JSON type, a body over 2 MB, a
   * missing or bad signature, or bytes that aren't UTF-8. The signature is
   * checked on the raw bytes before anything is decoded.
   */
  async function readVerifiedText(res, url) {
    if (!res.ok || !isJsonResponse(res)) return null;
    const bytes = await readCappedBytes(res);
    if (bytes === null) return null;
    const verdict = await ScaredyCatTrust.verifyArtifact({
      url,
      header: res.headers.get(ScaredyCatTrust.SIGNATURE_HEADER),
      body: bytes
    });
    if (!verdict.ok) {
      console.warn(`Scaredy Cat: refused a downloaded ${url.slice(url.lastIndexOf('/') + 1)} ` +
        `(${verdict.reason}); keeping the last good copy`);
      return null;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  async function refreshDatabase() {
    // No trusted key built in: don't download what would be refused.
    if (!ScaredyCatTrust.canAcceptRemote()) return;
    try {
      const { [ETAG_KEY]: etag } = await chrome.storage.local.get(ETAG_KEY);
      const headers = {};
      if (etag) headers['If-None-Match'] = etag;

      const res = await fetch(REMOTE_URL, { headers, cache: 'no-cache', credentials: 'omit' });
      if (res.status === 304) return;        // unchanged — cheap path
      const text = await readVerifiedText(res, REMOTE_URL);
      if (text === null) return;
      let db;
      try {
        db = JSON.parse(text);
      } catch (e) {
        return; // malformed JSON — never poison the cache
      }
      // Strict per-entry validation; a version more than one major ahead of
      // the bundled list is refused (it could never be replaced again).
      const maxMajor = await maxAllowedMajor();
      db = sanitizeDatabase(db, { maxMajor });
      if (!db) return;

      // Never replace a newer stored copy (e.g. a fresh release's bundled DB)
      // with an older remote one.
      const { [CACHE_KEY]: stored } = await chrome.storage.local.get(CACHE_KEY);
      const storedClean = sanitizeDatabase(stored, { maxMajor });
      if (storedClean && compareDbVersion(db, storedClean) < 0) return;

      await chrome.storage.local.set({
        [CACHE_KEY]: db,
        [ETAG_KEY]: res.headers.get('ETag') || null,
        [FETCHED_AT_KEY]: Date.now()
      });
      console.debug(
        `Scaredy Cat: horror DB refreshed to v${db.version} (${db.titles.length} titles)`
      );
    } catch (e) {
      // Network/storage error — keep the last good cache silently.
    }
  }

  async function refreshSynopses() {
    if (!ScaredyCatTrust.canAcceptRemote()) return;
    try {
      const { [SYNOPSES_ETAG_KEY]: etag } = await chrome.storage.local.get(SYNOPSES_ETAG_KEY);
      // Only revalidate a copy we still hold: a 304 must never leave us empty.
      // (Byte count, so the ~200KB payload isn't deserialized just to check.)
      const held = etag && (await chrome.storage.local.getBytesInUse(SYNOPSES_KEY)) > 0;
      const headers = {};
      if (held) headers['If-None-Match'] = etag;

      const res = await fetch(SYNOPSES_URL, { headers, cache: 'no-cache', credentials: 'omit' });
      if (res.status === 304) {
        await chrome.storage.local.set({ [SYNOPSES_FETCHED_AT_KEY]: Date.now() });
        return;
      }
      // 404 (not deployed), 5xx, over the size cap or not signed by us:
      // keep what's stored.
      const text = await readVerifiedText(res, SYNOPSES_URL);
      if (text === null) return;
      let payload;
      try {
        payload = ScaredyCatSynopses.sanitizePayload(JSON.parse(text));
      } catch (e) {
        return; // malformed JSON
      }
      if (!payload) return;

      await chrome.storage.local.set({
        [SYNOPSES_KEY]: payload,
        [SYNOPSES_ETAG_KEY]: res.headers.get('ETag') || null,
        [SYNOPSES_FETCHED_AT_KEY]: Date.now()
      });
      console.debug(`Scaredy Cat: synopses refreshed (${payload.titles.length} titles)`);
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
  // A build without signing keys says so on every worker start, not only
  // when the 6-hour alarm fires.
  ScaredyCatTrust.canAcceptRemote();

  return { refresh, refreshDatabase, refreshSynopses, ensureAlarm, REMOTE_URL, SYNOPSES_URL, ALARM_NAME };
})();
