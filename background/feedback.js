/**
 * Scaredy Cat - Feedback Sender
 * The single send path for all user feedback (false positives, missed blurs,
 * general feedback). Mirrors the resilient, fail-quiet style of db-updater.js:
 * nothing here is allowed to break detection or surface a hard error to the page.
 *
 * Where reports go: POST https://www.scaredycat.app/api/feedback. The website
 * checks each report against the same caps used here and passes it on to the
 * report database; the database address stays on the server.
 *
 * Privacy: reports carry URLs + metadata ONLY. No image pixels and no browsing
 * history ever leave the device. The page URL and the element's src are
 * reduced to origin + path (query string and hash are dropped, since they
 * often carry session tokens), and data:/blob: sources are never sent.
 * Every field is type-checked and clamped here to the server's caps: the
 * report arrives from a content script, which a hostile page can try to
 * forge, and the server refuses (400) anything over a cap.
 *
 * Retries: 2xx is sent. 400/403/413/415 mean the server will never take this
 * report, so it is dropped with a console.warn. 429 holds every send until
 * Retry-After (600 s when absent). 5xx and network errors are retried from
 * the outbox, up to MAX_ATTEMPTS. All sends, first tries and retries, share a
 * budget of SEND_BUDGET per 10 minutes, kept in storage across worker
 * restarts, below the server's per-IP limit of 30 per 10 minutes.
 *
 * Consent: a report is only sent when settings.feedbackConsent is true. The
 * caller (content/popup) gates on consent too, but we re-check here so a UI bug
 * can never leak data. Loaded into the service worker via importScripts;
 * unit-tested in eval/feedback-test.mjs with a mocked chrome and fetch.
 */

const ScaredyCatFeedback = (function () {
  'use strict';

  // The website's report proxy (scared-cat-web app/api/feedback). It requires
  // an Origin of chrome-extension://<our id>, which the worker's fetch sends.
  const ENDPOINT = 'https://www.scaredycat.app/api/feedback';

  // Kept in sync with ml-router.js's default; reported so corrections can be
  // tied to the model that produced (or missed) the verdict.
  const MODEL_VERSION = 'mobileclip_s0-fp16-v3';

  const OUTBOX_KEY = 'feedbackOutbox';     // [{ report, attempts }] awaiting a retry
  const RECENT_KEY = 'feedbackRecent';     // hash -> ts, for dedupe
  const SEND_LOG_KEY = 'feedbackSendLog';  // timestamps of recent POSTs (pacing)
  const RETRY_AT_KEY = 'feedbackRetryAt';  // no POST before this (after a 429)
  const ALARM_NAME = 'flush-feedback';
  const MAX_OUTBOX = 50;                    // drop oldest beyond this
  const MAX_ATTEMPTS = 5;                   // give up on a report after this
  const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
  const RATE_LIMIT = 10;                    // user submits per rolling minute
  const RATE_WINDOW_MS = 60 * 1000;
  // Every POST, including retries, within this budget. The server allows 30
  // per IP per 10 minutes; staying at 20 leaves room for a shared address.
  const SEND_BUDGET = 20;
  const SEND_WINDOW_MS = 10 * 60 * 1000;
  const FLUSH_BATCH = 10;                   // most POSTs one flush may make
  const DEFAULT_RETRY_AFTER_MS = 600 * 1000;
  const MIN_RETRY_AFTER_MS = 60 * 1000;
  const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
  const PERMANENT_STATUSES = [400, 403, 413, 415];

  // Server caps (scared-cat-web lib/feedback/schema.ts LIMITS and enums).
  const NOTE_MAX = 2000;
  const CONTACT_MAX = 200;
  const TITLE_MAX = 200;
  const MATCHED_TITLE_MAX = 200;
  const URL_MAX = 2048;
  const REASONS_MAX = 10;
  const REASON_MAX = 100;
  const DB_VERSION_MAX = 32;
  const MAX_BODY_BYTES = 8000;              // server refuses bodies over 8 KiB
  const REPORT_TYPES = ['false_positive', 'missed_blur', 'general'];
  const KINDS = ['image', 'video', 'iframe', 'other'];
  const BANDS = ['definite_horror', 'ambiguous', 'likely_safe'];
  const SENSITIVITIES = ['low', 'medium', 'high'];
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const REPORT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
  const MIN_TS = Date.UTC(2024, 0, 1);

  // In-memory per-minute window for user submits; resetting on worker
  // restart is acceptable (the persisted send budget is what protects the
  // server).
  let recentSendTimes = [];

  function nowAllowedByRate() {
    const cut = Date.now() - RATE_WINDOW_MS;
    recentSendTimes = recentSendTimes.filter(t => t > cut);
    return recentSendTimes.length < RATE_LIMIT;
  }

  // Short, stable key for a report so re-reporting the same thing is a no-op.
  function dedupeHash(report) {
    const basis = `${report.type}|${report.element?.src || ''}|${report.pageUrl || ''}|${report.note || ''}`;
    let h = 5381;
    for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }

  // ---- Clamping (pure) -------------------------------------------------------

  /** At most `max` UTF-16 units, never ending on half of a surrogate pair. */
  function clip(v, max) {
    if (typeof v !== 'string') return '';
    if (v.length <= max) return v;
    let out = v.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    return out;
  }

  // origin + pathname of an http(s) URL; query and hash (session tokens),
  // credentials, data:, blob: and every other scheme become ''. A path that
  // would push it over URL_MAX is dropped, leaving the origin.
  function trimUrl(url) {
    if (typeof url !== 'string' || !/^\s*https?:/i.test(url)) return '';
    try {
      const u = new URL(url.trim());
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
      const full = u.origin + u.pathname;
      return full.length <= URL_MAX ? full : `${u.origin}/`;
    } catch (e) {
      return '';
    }
  }

  function originOnly(url) {
    if (!url) return '';
    try {
      return `${new URL(url).origin}/`;
    } catch (e) {
      return '';
    }
  }

  // A reply address the user typed, or '' when it doesn't look like one.
  function cleanContact(v) {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    return s.length <= CONTACT_MAX && EMAIL_RE.test(s) ? s : '';
  }

  function cleanReasons(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(r => typeof r === 'string' && r).slice(0, REASONS_MAX).map(r => clip(r, REASON_MAX));
  }

  function cleanConfidence(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
  }

  function oneOf(v, allowed) {
    return allowed.includes(v) ? v : '';
  }

  function cleanDbVersion(v) {
    return typeof v === 'string' && v.length <= DB_VERSION_MAX && /^[\w.-]+$/.test(v) ? v : null;
  }

  function newReportId() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function manifestVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return '';
    }
  }

  function bodyBytes(report) {
    return new TextEncoder().encode(JSON.stringify(report)).length;
  }

  /**
   * Shrink a clamped report until its JSON body fits MAX_BODY_BYTES. Every
   * field is already under its own cap, but multi-byte text in every field at
   * once can still pass 8 KiB. Least useful parts go first: the reasons, the
   * URL paths, the titles, then the end of the note.
   */
  function fitBody(report) {
    if (bodyBytes(report) <= MAX_BODY_BYTES) return report;
    report.element.reasons = [];
    if (bodyBytes(report) <= MAX_BODY_BYTES) return report;
    report.pageUrl = originOnly(report.pageUrl);
    report.element.src = originOnly(report.element.src);
    if (bodyBytes(report) <= MAX_BODY_BYTES) return report;
    report.title = clip(report.title, 50);
    if (report.element.matchedTitle) report.element.matchedTitle = clip(report.element.matchedTitle, 50);
    for (let i = 0; i < 40 && report.note && bodyBytes(report) > MAX_BODY_BYTES; i++) {
      report.note = clip(report.note, Math.floor(report.note.length * 0.85));
    }
    return report;
  }

  /**
   * A report the server will accept, rebuilt field by field from `raw` (a
   * fresh report or one stored in the outbox by any earlier version).
   * Unknown fields, such as an old outbox entry's `attempts`, are dropped.
   * Idempotent.
   */
  function clampReport(raw, { extVersion = manifestVersion() } = {}) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const el = r.element && typeof r.element === 'object' && !Array.isArray(r.element) ? r.element : {};
    const ctx = r.context && typeof r.context === 'object' && !Array.isArray(r.context) ? r.context : {};
    const ts = Number.isSafeInteger(r.ts) && r.ts >= MIN_TS && r.ts <= Date.now() ? r.ts : Date.now();
    const version = typeof r.ext?.version === 'string' && /^\d{1,5}(\.\d{1,5}){0,3}$/.test(r.ext.version)
      ? r.ext.version : extVersion;
    const matched = clip(el.matchedTitle, MATCHED_TITLE_MAX);
    return fitBody({
      type: REPORT_TYPES.includes(r.type) ? r.type : 'general',
      reportId: typeof r.reportId === 'string' && REPORT_ID_RE.test(r.reportId) ? r.reportId : newReportId(),
      ts,
      pageUrl: trimUrl(r.pageUrl),
      element: {
        src: trimUrl(el.src),
        kind: oneOf(el.kind, KINDS),
        matchedTitle: matched || null,
        confidence: cleanConfidence(el.confidence),
        band: oneOf(el.band, BANDS),
        reasons: cleanReasons(el.reasons)
      },
      context: {
        sensitivity: oneOf(ctx.sensitivity, SENSITIVITIES),
        modelVersion: MODEL_VERSION,
        dbVersion: cleanDbVersion(ctx.dbVersion)
      },
      ext: { version },
      note: clip(r.note, NOTE_MAX),
      title: clip(r.title, TITLE_MAX),
      contact: cleanContact(r.contact)
    });
  }

  /** 'sent' | 'drop' | 'later' | 'retry' for an HTTP status (0 = network error). */
  function classifyStatus(status) {
    if (status >= 200 && status < 300) return 'sent';
    if (PERMANENT_STATUSES.includes(status)) return 'drop';
    if (status === 429) return 'later';
    return 'retry';
  }

  /** Milliseconds to wait from a Retry-After value (seconds or HTTP date). */
  function parseRetryAfter(value, now = Date.now()) {
    let ms = NaN;
    if (typeof value === 'string' && value.trim()) {
      const v = value.trim();
      if (/^\d+$/.test(v)) ms = parseInt(v, 10) * 1000;
      else {
        const at = Date.parse(v);
        if (Number.isFinite(at)) ms = at - now;
      }
    }
    if (!Number.isFinite(ms)) ms = DEFAULT_RETRY_AFTER_MS;
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
  }

  // ---- Storage helpers ---------------------------------------------------------

  async function getDbVersion() {
    try {
      const { horrorDatabase } = await chrome.storage.local.get('horrorDatabase');
      return horrorDatabase?.version || null;
    } catch (e) {
      return null;
    }
  }

  async function isRecentlySent(hash) {
    try {
      const { [RECENT_KEY]: recent = {} } = await chrome.storage.local.get(RECENT_KEY);
      const ts = recent[hash];
      return !!ts && (Date.now() - ts) < DEDUPE_TTL_MS;
    } catch (e) {
      return false;
    }
  }

  async function markSent(hash) {
    try {
      const { [RECENT_KEY]: recent = {} } = await chrome.storage.local.get(RECENT_KEY);
      const cut = Date.now() - DEDUPE_TTL_MS;
      const pruned = {};
      for (const [k, ts] of Object.entries(recent)) {
        if (ts > cut) pruned[k] = ts;
      }
      pruned[hash] = Date.now();
      await chrome.storage.local.set({ [RECENT_KEY]: pruned });
    } catch (e) {
      // Non-fatal: dedupe is best-effort.
    }
  }

  // Storage read-modify-writes (outbox, send log) run one at a time, so a
  // submit queuing a report can't be lost under a flush writing back.
  let storageChain = Promise.resolve();
  function serialized(fn) {
    const run = storageChain.then(fn, fn);
    storageChain = run.catch(() => {});
    return run;
  }

  /** Old outbox entries were bare reports with an `attempts` field. */
  function normalizeEntry(entry) {
    if (entry && typeof entry === 'object' && entry.report && typeof entry.report === 'object') {
      return { report: entry.report, attempts: Number(entry.attempts) || 0 };
    }
    return { report: entry, attempts: Number(entry?.attempts) || 0 };
  }

  function mutateOutbox(fn) {
    return serialized(async () => {
      const { [OUTBOX_KEY]: raw = [] } = await chrome.storage.local.get(OUTBOX_KEY);
      const outbox = (Array.isArray(raw) ? raw : []).map(normalizeEntry);
      const next = fn(outbox) || outbox;
      // Bound the queue: drop the oldest if we somehow pile up offline.
      while (next.length > MAX_OUTBOX) next.shift();
      await chrome.storage.local.set({ [OUTBOX_KEY]: next });
      return next;
    });
  }

  async function enqueue(report, attempts) {
    try {
      await mutateOutbox(outbox => { outbox.push({ report, attempts }); });
      await ensureFlushAlarm();
    } catch (e) {
      // Storage error — the report is lost, but detection is unaffected.
    }
  }

  /**
   * Reserve one POST in the shared 10-minute budget. False when the budget
   * is spent (the report waits in the outbox instead).
   */
  function takeSendSlot() {
    return serialized(async () => {
      const { [SEND_LOG_KEY]: log = [] } = await chrome.storage.local.get(SEND_LOG_KEY);
      const cut = Date.now() - SEND_WINDOW_MS;
      const recent = (Array.isArray(log) ? log : []).filter(t => typeof t === 'number' && t > cut);
      if (recent.length >= SEND_BUDGET) return false;
      recent.push(Date.now());
      await chrome.storage.local.set({ [SEND_LOG_KEY]: recent });
      return true;
    }).catch(() => false);
  }

  async function retryAt() {
    try {
      const { [RETRY_AT_KEY]: at = 0 } = await chrome.storage.local.get(RETRY_AT_KEY);
      return typeof at === 'number' ? at : 0;
    } catch (e) {
      return 0;
    }
  }

  async function holdUntil(at) {
    try {
      await chrome.storage.local.set({ [RETRY_AT_KEY]: at });
      // Wake for the outbox no earlier than the server asked.
      chrome.alarms.create(ALARM_NAME, { when: at, periodInMinutes: 30 });
    } catch (e) {
      // ignore
    }
  }

  // ---- Sending -----------------------------------------------------------------

  /** POST one report. Resolves 'sent' | 'drop' | 'later' | 'retry'. */
  async function post(report) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (e) {
      return 'retry';
    }
    const outcome = classifyStatus(res.status);
    if (outcome === 'drop') {
      console.warn(`Scaredy Cat: the report server refused report ${report.reportId} (HTTP ${res.status}); it was dropped`);
    } else if (outcome === 'later') {
      await holdUntil(Date.now() + parseRetryAfter(res.headers.get('Retry-After')));
    }
    return outcome;
  }

  // Fill in the parts only the worker knows (ids, versions), then clamp
  // every field to the server's caps.
  async function enrich(partial) {
    const manifest = chrome.runtime.getManifest();
    const dbVersion = await getDbVersion();
    return clampReport({
      type: partial.type,
      ts: Date.now(),
      pageUrl: partial.pageUrl,
      element: partial.element,
      context: { sensitivity: partial.sensitivity, dbVersion },
      ext: { version: manifest.version },
      note: partial.note,
      title: partial.title,
      contact: partial.contact
    }, { extVersion: manifest.version });
  }

  /**
   * Public entry: validate, enrich, dedupe, then send (or queue).
   * `settings` is passed by the background message handler so we can re-check
   * consent and stamp the active sensitivity. Returns a small status object the
   * caller turns into a toast.
   */
  async function submit(partial, settings) {
    if (!settings?.feedbackConsent) {
      return { success: false, needsConsent: true };
    }
    if (!nowAllowedByRate()) {
      return { success: false, rateLimited: true };
    }

    const report = await enrich({ ...(partial && typeof partial === 'object' ? partial : {}), sensitivity: settings.sensitivity });
    const hash = dedupeHash(report);

    if (await isRecentlySent(hash)) {
      return { success: true, deduped: true };
    }

    recentSendTimes.push(Date.now());
    // Held back by a 429 or out of budget: the outbox sends it later.
    if (Date.now() < await retryAt() || !(await takeSendSlot())) {
      await enqueue(report, 0);
      return { success: true, queued: true };
    }

    const outcome = await post(report);
    if (outcome === 'sent') {
      await markSent(hash);
      flush(); // opportunistically drain anything queued earlier
      return { success: true };
    }
    if (outcome === 'drop') {
      return { success: false, rejected: true };
    }
    // 'later' (429) or 'retry' (5xx, offline): keep it for the retry alarm.
    await enqueue(report, outcome === 'retry' ? 1 : 0);
    return { success: true, queued: true };
  }

  let flushing = null;

  /**
   * Drain the outbox: at most FLUSH_BATCH POSTs, within the send budget,
   * none while a 429's Retry-After holds. Sent and refused reports leave the
   * outbox; failed ones stay until MAX_ATTEMPTS.
   */
  function flush() {
    if (!flushing) {
      flushing = flushOnce().finally(() => { flushing = null; });
    }
    return flushing;
  }

  async function flushOnce() {
    let outbox;
    try {
      outbox = await mutateOutbox(() => {});
    } catch (e) {
      return;
    }
    if (!outbox.length) {
      try { await chrome.alarms.clear(ALARM_NAME); } catch (e) { /* ignore */ }
      return;
    }
    if (Date.now() < await retryAt()) return; // the 429 alarm wakes us later

    const done = new Set();        // reportIds that leave the outbox
    const failed = new Set();      // reportIds whose attempt count goes up
    const extVersion = chrome.runtime.getManifest().version;
    let sends = 0;
    for (const entry of outbox) {
      if (sends >= FLUSH_BATCH) break;
      const report = clampReport(entry.report, { extVersion });
      const id = entry.report?.reportId;
      if (!(await takeSendSlot())) break;
      sends++;
      const outcome = await post(report);
      if (outcome === 'sent') {
        await markSent(dedupeHash(report));
        done.add(id);
      } else if (outcome === 'drop') {
        done.add(id);
      } else if (outcome === 'later') {
        break;
      } else {
        failed.add(id);
      }
    }

    try {
      const next = await mutateOutbox(current => current
        .filter(e => !done.has(e.report?.reportId))
        .map(e => (failed.has(e.report?.reportId) ? { ...e, attempts: e.attempts + 1 } : e))
        .filter(e => e.attempts < MAX_ATTEMPTS));
      // Nothing left to retry: stop waking the worker for it.
      if (!next.length) await chrome.alarms.clear(ALARM_NAME);
    } catch (e) {
      // ignore
    }
  }

  async function ensureFlushAlarm() {
    try {
      const existing = await chrome.alarms.get(ALARM_NAME);
      if (!existing) {
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 30 });
      }
    } catch (e) {
      // chrome.alarms unavailable — flush still happens on next submit().
    }
  }

  // Retries run from the alarm only (it exists while the outbox has reports,
  // and survives worker restarts), plus right after a successful send. No
  // flush on worker start: that read ran on every wake.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) flush();
  });

  return {
    submit,
    flush,
    clampReport,
    classifyStatus,
    parseRetryAfter,
    ENDPOINT,
    SEND_BUDGET,
    MAX_ATTEMPTS,
    MAX_BODY_BYTES
  };
})();
