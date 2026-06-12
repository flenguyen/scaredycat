/**
 * Scaredy Cat - Verdict Cache
 * IndexedDB-backed cache of image classification scores, fronted by an
 * in-memory Map. Keyed by SHA-256(image URL) + model version so a model
 * swap invalidates old verdicts. Loaded into the service worker via
 * importScripts.
 */

const ScaredyCatVerdictCache = (function () {
  'use strict';

  const DB_NAME = 'scaredycat-verdicts';
  const STORE = 'verdicts';
  const MAX_ENTRIES = 10000;
  const PRUNE_BATCH = 2000;

  const memory = new Map(); // key -> score (session-level)
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

  async function hashKey(url, modelVersion) {
    const data = new TextEncoder().encode(url);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const hex = [...new Uint8Array(digest)]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return `${modelVersion}:${hex}`;
  }

  async function get(url, modelVersion) {
    const key = await hashKey(url, modelVersion);
    if (memory.has(key)) return memory.get(key);
    try {
      const db = await openDb();
      const score = await new Promise((resolve) => {
        const req = db.transaction(STORE).objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result ? req.result.score : null);
        req.onerror = () => resolve(null);
      });
      if (score !== null) memory.set(key, score);
      return score;
    } catch (e) {
      return null;
    }
  }

  async function set(url, modelVersion, score) {
    const key = await hashKey(url, modelVersion);
    memory.set(key, score);
    try {
      const db = await openDb();
      db.transaction(STORE, 'readwrite').objectStore(STORE)
        .put({ key, score, ts: Date.now() });
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

  return { get, set, prune };
})();
