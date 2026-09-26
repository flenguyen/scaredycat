/**
 * Scaredy Cat - Verdict Cache
 * IndexedDB-backed cache of image classification scores, fronted by an
 * in-memory Map. The memory tier is keyed by the plain canonical image key so
 * hits are synchronous (no hashing, no await); the IndexedDB tier is keyed by
 * SHA-256(key) so browsing URLs are not stored in plaintext. Both include the
 * model version so a model swap invalidates old verdicts. Loaded into the
 * service worker via importScripts.
 */

const ScaredyCatVerdictCache = (function () {
  'use strict';

  const DB_NAME = 'scaredycat-verdicts';
  const STORE = 'verdicts';
  const MAX_ENTRIES = 10000;
  const PRUNE_BATCH = 2000;
  const MEMORY_MAX = 5000;

  const memory = new Map(); // `${modelVersion}|${key}` -> score (worker lifetime)
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('ts', 'ts');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function memKey(key, modelVersion) {
    return `${modelVersion}|${key}`;
  }

  function remember(mk, score) {
    if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value);
    memory.set(mk, score);
  }

  async function hashKey(key, modelVersion) {
    const data = new TextEncoder().encode(key);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const hex = [...new Uint8Array(digest)]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return `${modelVersion}:${hex}`;
  }

  /** Synchronous memory-tier lookup. null on miss. */
  function getSync(key, modelVersion) {
    const v = memory.get(memKey(key, modelVersion));
    return v === undefined ? null : v;
  }

  /** Memory tier first, then IndexedDB (populating memory on a hit). */
  async function get(key, modelVersion) {
    const mk = memKey(key, modelVersion);
    if (memory.has(mk)) return memory.get(mk);
    try {
      const idbKey = await hashKey(key, modelVersion);
      const db = await openDb();
      const score = await new Promise((resolve) => {
        const req = db.transaction(STORE).objectStore(STORE).get(idbKey);
        req.onsuccess = () => resolve(req.result ? req.result.score : null);
        req.onerror = () => resolve(null);
      });
      if (score !== null) remember(mk, score);
      return score;
    } catch (e) {
      return null;
    }
  }

  async function set(key, modelVersion, score) {
    remember(memKey(key, modelVersion), score);
    try {
      const idbKey = await hashKey(key, modelVersion);
      const db = await openDb();
      db.transaction(STORE, 'readwrite').objectStore(STORE)
        .put({ key: idbKey, score, ts: Date.now() });
    } catch (e) {
      // Cache write failures are non-fatal.
    }
  }

  /** Drop the oldest entries when the store outgrows its cap. */
  async function prune() {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const count = await new Promise((resolve) => {
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      });
      if (count <= MAX_ENTRIES) return;

      let toDelete = Math.min(count - MAX_ENTRIES + PRUNE_BATCH, count);
      const cursorReq = store.index('ts').openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && toDelete > 0) {
          cursor.delete();
          toDelete--;
          cursor.continue();
        }
      };
    } catch (e) {
      // Best effort.
    }
  }

  return { get, getSync, set, prune };
})();
