/**
 * Scaredy Cat - ML Router
 * Service-worker side of the image classification pipeline. Owns the
 * offscreen document lifecycle, dedupes/batches classification requests,
 * and consults the verdict cache before doing any work.
 * Loaded via importScripts (depends on verdict-cache.js).
 */

const ScaredyCatMLRouter = (function () {
  'use strict';

  const OFFSCREEN_URL = 'offscreen/offscreen.html';
  const BATCH_SIZE = 12;
  const BATCH_DELAY_MS = 40;
  const IDLE_TEARDOWN_MS = 5 * 60 * 1000;

  // Set true once we know the classifier can't run (model not bundled,
  // offscreen unsupported). Content scripts stop asking after one report.
  let unavailable = false;
  let modelVersion = 'mobileclip_s0-fp32-v2';

  const pending = new Map(); // url -> Promise<number|null>
  let queue = [];            // [{url, resolve}]
  let flushTimer = null;
  let teardownTimer = null;

  async function hasOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.length > 0;
  }

  // Serialized: concurrent flushes must not race createDocument ("Only a
  // single offscreen document may be created" otherwise kills one batch).
  let offscreenReady = null;
  function ensureOffscreen() {
    if (!offscreenReady) {
      offscreenReady = (async () => {
        if (await hasOffscreenDocument()) return;
        try {
          await chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: ['WORKERS'],
            justification: 'Runs the local on-device image classifier (WASM/WebGPU) for horror content detection. No data leaves the device.'
          });
        } catch (e) {
          if (!String(e?.message || e).includes('single offscreen')) throw e;
        }
      })().catch(e => {
        offscreenReady = null; // allow retry on the next batch
        throw e;
      });
    }
    return offscreenReady;
  }

  /**
   * Send a batch to the offscreen document, retrying briefly if its message
   * listener isn't registered yet (module-load race on first creation).
   */
  async function sendBatch(message) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await chrome.runtime.sendMessage(message);
      } catch (e) {
        const transient = String(e?.message || e).includes('Receiving end does not exist');
        if (!transient || attempt >= 4) throw e;
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }

  function scheduleTeardown() {
    clearTimeout(teardownTimer);
    // Best effort: if the service worker dies first the offscreen document
    // lingers until the next teardown cycle; acceptable memory tradeoff.
    teardownTimer = setTimeout(async () => {
      try {
        if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
      } catch (e) { /* already gone */ }
      offscreenReady = null;
    }, IDLE_TEARDOWN_MS);
  }

  /**
   * Classify one image URL. Resolves a 0-100 horror score, or null on
   * failure. Throws nothing.
   */
  function classify(url) {
    if (unavailable) return Promise.resolve(null);
    if (pending.has(url)) return pending.get(url);

    const promise = (async () => {
      const cached = await ScaredyCatVerdictCache.get(url, modelVersion);
      if (cached !== null) return cached;
      return new Promise((resolve) => {
        queue.push({ url, resolve });
        if (queue.length >= BATCH_SIZE) {
          flush();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flush, BATCH_DELAY_MS);
        }
      });
    })().finally(() => {
      // Allow later re-queries (e.g. after cache write) without leaking.
      setTimeout(() => pending.delete(url), 1000);
    });

    pending.set(url, promise);
    return promise;
  }

  async function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (queue.length === 0) return;
    const batch = queue.splice(0, BATCH_SIZE);
    if (queue.length > 0 && !flushTimer) {
      flushTimer = setTimeout(flush, 0);
    }

    let results = null;
    try {
      await ensureOffscreen();
      scheduleTeardown();
      const response = await sendBatch({
        target: 'sc-offscreen',
        type: 'CLASSIFY_BATCH',
        urls: batch.map(item => item.url)
      });
      if (response?.unavailable) {
        unavailable = true;
      } else if (response?.success) {
        if (response.modelVersion) modelVersion = response.modelVersion;
        results = response.results; // [{url, score|null}]
      }
    } catch (e) {
      console.warn('Scaredy Cat: classification batch failed', e);
    }

    const byUrl = new Map((results || []).map(r => [r.url, r.score]));
    for (const item of batch) {
      const score = byUrl.has(item.url) ? byUrl.get(item.url) : null;
      if (typeof score === 'number') {
        ScaredyCatVerdictCache.set(item.url, modelVersion, score);
      }
      item.resolve(typeof score === 'number' ? score : null);
    }
  }

  /** Message-handler entry: respond to a content script's CLASSIFY_IMAGE. */
  async function handleClassifyRequest(url) {
    if (unavailable) return { success: false, unavailable: true };
    if (!/^https?:/.test(url || '')) return { success: false };
    const score = await classify(url);
    if (unavailable) return { success: false, unavailable: true };
    if (typeof score === 'number') return { success: true, score };
    return { success: false };
  }

  return { handleClassifyRequest };
})();
