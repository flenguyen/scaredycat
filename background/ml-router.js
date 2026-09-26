/**
 * Scaredy Cat - ML Router
 * Service-worker side of the image classification pipeline. Owns the
 * offscreen document lifecycle, dedupes classification requests, consults
 * the verdict cache, and streams requests over a runtime Port so every image
 * resolves the moment its own inference finishes (no batch tail).
 * Loaded via importScripts (depends on verdict-cache.js, image-key.js).
 */

const ScaredyCatMLRouter = (function () {
  'use strict';

  const OFFSCREEN_URL = 'offscreen/offscreen.html';
  const PORT_NAME = 'sc-classify';
  // Per-request safety net: a verdict that never comes back resolves null
  // (unverified) instead of leaving the element pending forever.
  const REQUEST_TIMEOUT_MS = 30 * 1000;
  // Images whose fetch/decode failed (403 from cookie-gated CDNs, dead
  // links) are not retried for a while: same URL, same failure.
  const NEGATIVE_TTL_MS = 10 * 60 * 1000;
  // Idle teardown runs on a chrome.alarm (a setTimeout dies with the service
  // worker, which is killed ~30s after the last message, so it never fired).
  // The model + WebGPU buffers are a few hundred MB resident; 30 min idle is
  // the tradeoff between memory and paying the load again.
  const IDLE_ALARM = 'sc-ml-idle';
  const IDLE_TEARDOWN_MINUTES = 30;
  const IDLE_REARM_THROTTLE_MS = 60 * 1000;
  // A port that drops within this window of connecting most likely hit the
  // offscreen module-load race (listener not registered yet): retry.
  const EARLY_DISCONNECT_MS = 1500;
  const MAX_SEND_ATTEMPTS = 4;

  // Set true once we know the classifier can't run (model not bundled,
  // offscreen unsupported). Content scripts stop asking after one report.
  let unavailable = false;
  let modelVersion = 'mobileclip_s0-fp16-v3';

  const inflight = new Map(); // key -> entry {key, url, promise, resolve, t0, timer, attempts}
  const failed = new Map();   // key -> timestamp of last fetch/decode failure
  let port = null;
  let portConnectedAt = 0;
  let warmSent = false;
  let lastActivityAt = 0;
  let lastAlarmArmedAt = 0;

  // Counters for eval/browser-latency.mjs (read via the SW target). Cheap
  // increments only; never consulted by product logic.
  const stats = {
    classifyRequests: 0, cacheHits: 0, negativeHits: 0, offscreenSends: 0,
    verdictLatencies: [],
    reset() {
      this.classifyRequests = 0; this.cacheHits = 0; this.negativeHits = 0;
      this.offscreenSends = 0; this.verdictLatencies = [];
    }
  };
  self.__scStats = stats;

  // ---- offscreen document lifecycle -----------------------------------------

  async function hasOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.length > 0;
  }

  // Serialized: concurrent callers must not race createDocument ("Only a
  // single offscreen document may be created" otherwise kills one request).
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
        offscreenReady = null; // allow retry on the next request
        throw e;
      });
    }
    return offscreenReady;
  }

  /** Note classifier activity; (re)arm the idle alarm at most once a minute. */
  function touchActivity() {
    const now = Date.now();
    lastActivityAt = now;
    if (now - lastAlarmArmedAt < IDLE_REARM_THROTTLE_MS) return;
    lastAlarmArmedAt = now;
    try {
      chrome.alarms.create(IDLE_ALARM, { delayInMinutes: IDLE_TEARDOWN_MINUTES });
    } catch (e) { /* alarms unavailable */ }
  }

  async function teardownOffscreen() {
    if (port) { try { port.disconnect(); } catch (e) { /* ignore */ } }
    port = null;
    warmSent = false;
    try {
      if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    } catch (e) { /* already gone */ }
    offscreenReady = null;
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== IDLE_ALARM) return;
    // Activity in the last few minutes (the re-arm is throttled): keep it.
    if (Date.now() - lastActivityAt < 5 * 60 * 1000 || inflight.size > 0) {
      lastAlarmArmedAt = 0;
      touchActivity();
      return;
    }
    teardownOffscreen();
  });

  // ---- port ---------------------------------------------------------------------

  async function getPort() {
    if (port) return port;
    await ensureOffscreen();
    if (port) return port;
    const p = chrome.runtime.connect({ name: PORT_NAME });
    port = p;
    portConnectedAt = Date.now();
    p.onMessage.addListener(onPortMessage);
    p.onDisconnect.addListener(() => onPortDisconnect(p));
    return p;
  }

  function onPortMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'RESULT') {
      if (message.modelVersion) modelVersion = message.modelVersion;
      const entry = inflight.get(message.key);
      const score = typeof message.score === 'number' ? message.score : null;
      if (score !== null) {
        ScaredyCatVerdictCache.set(message.key, modelVersion, score);
      } else if (message.reason === 'fetch' || message.reason === 'decode') {
        failed.set(message.key, Date.now());
      }
      if (entry) finish(entry, score);
    } else if (message.type === 'WARM_DONE') {
      if (message.modelVersion) modelVersion = message.modelVersion;
    } else if (message.type === 'UNAVAILABLE') {
      unavailable = true;
      for (const entry of [...inflight.values()]) finish(entry, null);
    }
  }

  function onPortDisconnect(p) {
    if (port !== p) return;
    void chrome.runtime.lastError; // consume "receiving end does not exist"
    port = null;
    warmSent = false;
    offscreenReady = null;
    const entries = [...inflight.values()];
    const early = Date.now() - portConnectedAt < EARLY_DISCONNECT_MS;
    if (early && entries.length) {
      // Module-load race on a freshly created document: resend shortly.
      setTimeout(() => {
        for (const entry of entries) {
          if (!inflight.has(entry.key)) continue;
          if (entry.attempts < MAX_SEND_ATTEMPTS) send(entry);
          else finish(entry, null);
        }
      }, 300 * Math.max(1, entries[0].attempts));
      return;
    }
    // The document is gone mid-work: nothing will answer these.
    for (const entry of entries) finish(entry, null);
  }

  async function send(entry) {
    entry.attempts++;
    try {
      const p = await getPort();
      stats.offscreenSends++;
      p.postMessage({ type: 'CLASSIFY', key: entry.key, url: entry.url });
    } catch (e) {
      console.warn('Scaredy Cat: classifier unreachable', e);
      finish(entry, null);
    }
  }

  function finish(entry, score) {
    if (!inflight.delete(entry.key)) return;
    clearTimeout(entry.timer);
    if (stats.verdictLatencies.length < 500) {
      stats.verdictLatencies.push(Math.round(performance.now() - entry.t0));
    }
    entry.resolve(score);
  }

  // ---- public ---------------------------------------------------------------------

  /**
   * Classify one image URL. Resolves a 0-100 horror score, or null on
   * failure. Throws nothing.
   */
  function classify(url) {
    if (unavailable) return Promise.resolve(null);
    const key = ScaredyCatImageKey.canonicalImageKey(url);
    stats.classifyRequests++;

    const memHit = ScaredyCatVerdictCache.getSync(key, modelVersion);
    if (memHit !== null) { stats.cacheHits++; return Promise.resolve(memHit); }

    const failedAt = failed.get(key);
    if (failedAt && Date.now() - failedAt < NEGATIVE_TTL_MS) {
      stats.negativeHits++;
      return Promise.resolve(null);
    }
    if (failedAt) failed.delete(key);

    const existing = inflight.get(key);
    if (existing) return existing.promise;

    const entry = { key, url, t0: performance.now(), attempts: 0, timer: null, resolve: null, promise: null };
    entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
    inflight.set(key, entry);

    (async () => {
      const cached = await ScaredyCatVerdictCache.get(key, modelVersion);
      if (!inflight.has(key)) return; // already resolved (disconnect/unavailable)
      if (cached !== null) { stats.cacheHits++; finish(entry, cached); return; }
      entry.timer = setTimeout(() => finish(entry, null), REQUEST_TIMEOUT_MS);
      touchActivity();
      send(entry);
    })();

    return entry.promise;
  }

  /**
   * Pre-load the model and run one dummy inference (WebGPU compiles its
   * shaders on first run) so the first real image doesn't pay for it.
   * Idempotent per offscreen document; fire-and-forget.
   */
  async function warm() {
    if (unavailable || warmSent) return;
    warmSent = true;
    try {
      const p = await getPort();
      touchActivity();
      p.postMessage({ type: 'WARM' });
    } catch (e) {
      warmSent = false;
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

  return { handleClassifyRequest, warm };
})();
