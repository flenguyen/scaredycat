/**
 * Scaredy Cat - Spoiler summaries
 * The blur card's "Just tell me what happens" text comes from the website
 * (synopses.json, edited in Sanity), not the title database: content scripts
 * read and compile the title DB on every page load, so ~200KB of prose stays
 * out of it. db-updater.js keeps chrome.storage.local.synopses fresh; the
 * worker answers one GET_SYNOPSIS message per blocked title from an in-memory
 * index built lazily on first use after each worker wake.
 *
 * sanitizePayload / buildIndex / lookup are pure (unit-tested in
 * eval/synopses-test.mjs). Loaded into the service worker via importScripts,
 * after content/scoring-core.js, whose normalizeText it shares so a name the
 * detector matched keys the same way here.
 */

const ScaredyCatSynopses = (function () {
  'use strict';

  const STORAGE_KEY = 'synopses';
  const PAYLOAD_VERSION = 1;

  function isValidEntry(e) {
    return !!e && typeof e.title === 'string'
      && typeof e.text === 'string' && e.text.trim() !== ''
      && Array.isArray(e.names);
  }

  /**
   * Check a fetched payload and drop unusable entries (one bad Sanity record
   * must not freeze updates for the rest). Null when nothing usable is left.
   */
  function sanitizePayload(payload) {
    if (!payload || payload.version !== PAYLOAD_VERSION || !Array.isArray(payload.titles)) return null;
    const titles = payload.titles.filter(isValidEntry);
    if (!titles.length) return null;
    return titles.length === payload.titles.length ? payload : { ...payload, titles };
  }

  /**
   * Three lookups over one payload: `type:tmdb`, `name|year` (also under
   * `curatedYear` when the curated list files the title under a different
   * year than TMDB), and bare name -> every entry carrying it.
   */
  function buildIndex(payload, normalize) {
    const byTmdb = new Map();
    const byNameYear = new Map();
    const byName = new Map();
    for (const entry of payload?.titles || []) {
      if (!isValidEntry(entry)) continue;
      if (entry.tmdb != null && entry.type && !byTmdb.has(`${entry.type}:${entry.tmdb}`)) {
        byTmdb.set(`${entry.type}:${entry.tmdb}`, entry);
      }
      const years = [entry.year, entry.curatedYear].filter(Number.isInteger);
      const names = new Set([entry.title, ...entry.names].map(n => normalize(String(n || ''))));
      names.delete('');
      for (const name of names) {
        for (const year of years) {
          if (!byNameYear.has(`${name}|${year}`)) byNameYear.set(`${name}|${year}`, entry);
        }
        const list = byName.get(name);
        if (list) list.push(entry);
        else byName.set(name, [entry]);
      }
    }
    return { byTmdb, byNameYear, byName, normalize };
  }

  /**
   * TMDB id first (auto titles carry one), then name + year, then the bare
   * name only when exactly one entry has it and its year is within one of
   * the request's — an ambiguous name (remakes) gets no summary rather than
   * the wrong film's.
   */
  function lookup(index, { title, year, tmdb, mediaType } = {}) {
    if (!index) return null;
    let entry = null;
    if (tmdb != null && mediaType) entry = index.byTmdb.get(`${mediaType}:${tmdb}`) || null;
    const name = index.normalize(String(title || ''));
    if (!entry && name && Number.isInteger(year)) entry = index.byNameYear.get(`${name}|${year}`) || null;
    if (!entry && name) {
      // A year that misses by more than one is a different work with the same
      // name (Halloween 1978 vs the 2018 page, a 1996 game vs its 2002 film):
      // no summary beats the wrong one. ±1 absorbs festival vs release years.
      const list = index.byName.get(name);
      const candidate = list && list.length === 1 ? list[0] : null;
      const years = candidate ? [candidate.year, candidate.curatedYear].filter(Number.isInteger) : [];
      if (candidate && (!Number.isInteger(year) || !years.length || years.some(y => Math.abs(y - year) <= 1))) {
        entry = candidate;
      }
    }
    if (!entry) return null;
    const shownYear = [entry.year, entry.curatedYear].find(Number.isInteger) ?? null;
    return { title: entry.title, year: shownYear, text: entry.text, slug: entry.slug || null };
  }

  // ---- Service-worker wiring (skipped under Node) ---------------------------
  let indexPromise = null;

  function getIndex() {
    if (!indexPromise) {
      indexPromise = chrome.storage.local.get(STORAGE_KEY)
        .then(({ [STORAGE_KEY]: payload }) => buildIndex(payload, ScaredyCatScoring.normalizeText))
        .catch(() => {
          indexPromise = null; // storage hiccup: try again next request
          return null;
        });
    }
    return indexPromise;
  }

  async function handleRequest(message) {
    try {
      return lookup(await getIndex(), message);
    } catch (e) {
      return null;
    }
  }

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    // A refresh replaced the payload: rebuild on the next request.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) indexPromise = null;
    });
  }

  return { STORAGE_KEY, sanitizePayload, buildIndex, lookup, handleRequest };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatSynopses;
}
