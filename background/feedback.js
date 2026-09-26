/**
 * Scaredy Cat - Feedback Sender
 * The single send path for all user feedback (false positives, missed blurs,
 * general feedback). Mirrors the resilient, fail-quiet style of db-updater.js:
 * nothing here is allowed to break detection or surface a hard error to the page.
 *
 * Privacy: reports carry URLs + metadata ONLY. No image pixels and no browsing
 * history ever leave the device. The page URL is reduced to origin + path
 * (query string and hash are dropped, since they often carry session tokens).
 *
 * Consent: a report is only sent when settings.feedbackConsent is true. The
 * caller (content/popup) gates on consent too, but we re-check here so a UI bug
 * can never leak data. Loaded into the service worker via importScripts.
 */

const ScaredyCatFeedback = (function () {
  'use strict';

  // Airtable "When webhook received" automation — ingests reports straight into
  // the Reports base (no proxy server). The background fetch is exempt from CORS
  // via the extension's <all_urls> host_permissions. This is a capability URL,
  // not a secret: it can only create rows, never read or delete.
  const ENDPOINT = 'https://hooks.airtable.com/workflows/v1/genericWebhook/appdaQoOqfVNFWEb7/wfl0eYOecr7pRHeRk/wtrRSMbrOc7RRoJYp';

  // Kept in sync with ml-router.js's default; reported so corrections can be
  // tied to the model that produced (or missed) the verdict.
  const MODEL_VERSION = 'mobileclip_s0-fp32-v2';

  const OUTBOX_KEY = 'feedbackOutbox';     // reports awaiting a retry
  const RECENT_KEY = 'feedbackRecent';     // hash -> ts, for dedupe
  const ALARM_NAME = 'flush-feedback';
  const MAX_OUTBOX = 50;                    // drop oldest beyond this
  const MAX_ATTEMPTS = 5;                   // give up on a report after this
  const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
  const RATE_LIMIT = 10;                    // sends per rolling minute
  const RATE_WINDOW_MS = 60 * 1000;

  // In-memory rate-limit window; resetting on worker restart is acceptable.
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

  // origin + pathname only — drop query/hash (session tokens) and never the
  // full href.
  function trimUrl(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) {
      return '';
    }
  }

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

  async function enqueue(report) {
    try {
      const { [OUTBOX_KEY]: outbox = [] } = await chrome.storage.local.get(OUTBOX_KEY);
      outbox.push(report);
      // Bound the queue: drop the oldest if we somehow pile up offline.
      while (outbox.length > MAX_OUTBOX) outbox.shift();
      await chrome.storage.local.set({ [OUTBOX_KEY]: outbox });
      ensureFlushAlarm();
    } catch (e) {
      // Storage error — the report is lost, but detection is unaffected.
    }
  }

  // POST one finished report. Returns true on success (2xx), false otherwise.
  async function post(report) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report)
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  // Fill in the parts only the worker knows: ids, versions, trimmed URL.
  async function enrich(partial) {
    const manifest = chrome.runtime.getManifest();
    const dbVersion = await getDbVersion();
    return {
      type: partial.type,
      reportId: (crypto.randomUUID && crypto.randomUUID()) ||
        `r-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ts: Date.now(),
      pageUrl: trimUrl(partial.pageUrl),
      element: {
        src: partial.element?.src || '',
        kind: partial.element?.kind || '',
        matchedTitle: partial.element?.matchedTitle || null,
        confidence: partial.element?.confidence || 0,
        band: partial.element?.band || '',
        reasons: partial.element?.reasons || []
      },
      context: {
        sensitivity: partial.sensitivity || '',
        modelVersion: MODEL_VERSION,
        dbVersion
      },
      ext: { version: manifest.version },
      note: partial.note || '',
      title: partial.title || '',
      contact: partial.contact || ''
    };
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

    const report = await enrich({ ...partial, sensitivity: settings.sensitivity });
    const hash = dedupeHash(report);

    if (await isRecentlySent(hash)) {
      return { success: true, deduped: true };
    }

    recentSendTimes.push(Date.now());
    const ok = await post(report);
    if (ok) {
      await markSent(hash);
      flush(); // opportunistically drain anything queued earlier
      return { success: true };
    }

    // Couldn't reach the endpoint: keep it for the retry alarm.
    report.attempts = 1;
    await enqueue(report);
    return { success: true, queued: true };
  }

  // Drain the outbox; survivors (still failing, under attempt cap) are kept.
  async function flush() {
    let outbox;
    try {
      ({ [OUTBOX_KEY]: outbox = [] } = await chrome.storage.local.get(OUTBOX_KEY));
    } catch (e) {
      return;
    }
    if (!outbox.length) return;

    const survivors = [];
    for (const report of outbox) {
      const ok = await post(report);
      if (ok) {
        await markSent(dedupeHash(report));
        continue;
      }
      report.attempts = (report.attempts || 1) + 1;
      if (report.attempts < MAX_ATTEMPTS) survivors.push(report);
    }
    try {
      await chrome.storage.local.set({ [OUTBOX_KEY]: survivors });
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

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) flush();
  });
  // Try to drain on every worker spin-up (cheap; no-op when the outbox is empty).
  chrome.runtime.onStartup.addListener(flush);
  flush();

  return { submit, flush, ENDPOINT };
})();
