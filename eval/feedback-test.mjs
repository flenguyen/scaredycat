/**
 * Unit tests for background/feedback.js: field clamping to the report
 * server's caps, and the status-code retry policy, with a mocked chrome API
 * and a mocked fetch. Nothing here touches the network: fetch is replaced
 * inside the sandbox and the test fails if any other URL is requested.
 *   node eval/feedback-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = fs.readFileSync(path.join(ROOT, 'background/feedback.js'), 'utf8');
// Loaded first, as background.js does: feedback.js reads the model version from it.
const MODEL_INFO = fs.readFileSync(path.join(ROOT, 'background/model-info.js'), 'utf8');
const ENDPOINT = 'https://www.scaredycat.app/api/feedback';

// The server's schema (scared-cat-web lib/feedback/schema.ts), restated so a
// clamped report can be checked against it here.
function serverAccepts(r) {
  const s = (v, max) => typeof v === 'string' && v.length <= max;
  const url = (v) => v === '' || (s(v, 2048) && /^https?:\/\/[^?#]*$/.test(v));
  return ['false_positive', 'missed_blur', 'general'].includes(r.type)
    && /^[A-Za-z0-9-]{8,64}$/.test(r.reportId)
    && Number.isSafeInteger(r.ts) && r.ts >= Date.UTC(2024, 0, 1)
    && url(r.pageUrl) && url(r.element.src)
    && ['image', 'video', 'iframe', 'other', ''].includes(r.element.kind)
    && (r.element.matchedTitle === null || s(r.element.matchedTitle, 200))
    && typeof r.element.confidence === 'number' && r.element.confidence >= 0 && r.element.confidence <= 100
    && ['definite_horror', 'ambiguous', 'likely_safe', ''].includes(r.element.band)
    && Array.isArray(r.element.reasons) && r.element.reasons.length <= 10 && r.element.reasons.every(x => s(x, 100))
    && ['low', 'medium', 'high', ''].includes(r.context.sensitivity)
    && s(r.context.modelVersion, 64) && /^[\w.-]+$/.test(r.context.modelVersion)
    && (r.context.dbVersion === null || (s(r.context.dbVersion, 32) && /^[\w.-]+$/.test(r.context.dbVersion)))
    && /^\d{1,5}(\.\d{1,5}){0,3}$/.test(r.ext.version)
    && s(r.note, 2000) && s(r.title, 200) && s(r.contact, 200)
    && (r.contact === '' || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r.contact))
    && new TextEncoder().encode(JSON.stringify(r)).length <= 8192;
}

/**
 * A fresh feedback.js in a sandbox. `responder(report)` returns
 * { status, headers } or throws (network error). Returns the module, the
 * fake storage, the requests made, warnings, alarms and a clock.
 */
function load(responder = () => ({ status: 200 })) {
  const store = {};
  const alarms = new Map();
  const requests = [];
  const sentAt = [];
  const warnings = [];
  let now = Date.UTC(2026, 9, 4, 12);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const chrome = {
    runtime: { getManifest: () => ({ version: '1.6.2' }) },
    storage: {
      local: {
        async get(keys) {
          const list = typeof keys === 'string' ? [keys] : keys;
          const out = {};
          for (const k of list) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(obj) { for (const [k, v] of Object.entries(obj)) store[k] = clone(v); }
      }
    },
    alarms: {
      async get(name) { return alarms.get(name); },
      create(name, info) { alarms.set(name, { name, ...info }); },
      async clear(name) { return alarms.delete(name); },
      onAlarm: { addListener() {} }
    }
  };
  async function fetch(url, init) {
    if (url !== ENDPOINT) throw new Error(`unexpected request to ${url}`);
    const body = JSON.parse(init.body);
    requests.push(body);
    sentAt.push(now);
    const r = responder(body);
    return new Response(null, { status: r.status, headers: r.headers || {} });
  }
  const sandbox = {
    chrome, fetch, Response, URL, TextEncoder, crypto: globalThis.crypto,
    console: { ...console, warn: (...a) => warnings.push(a.join(' ')), log() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(MODEL_INFO, sandbox);
  const Feedback = vm.runInContext(`${SOURCE}\n;ScaredyCatFeedback`, sandbox);
  vm.runInContext('Date', sandbox).now = () => now;
  return {
    Feedback, store, alarms, requests, sentAt, warnings,
    tick: (ms) => { now += ms; },
    now: () => now
  };
}

const CONSENT = { feedbackConsent: true, sensitivity: 'medium' };
let n = 0;
const report = (extra = {}) => ({
  type: 'false_positive',
  pageUrl: `https://www.imdb.com/title/tt${++n}/?ref_=x#y`,
  element: { src: 'https://m.media-amazon.com/p.jpg?token=secret', kind: 'image', band: 'definite_horror', confidence: 92, reasons: ['Matched title'] },
  ...extra
});

test('the endpoint is the website proxy', () => {
  const { Feedback } = load();
  assert.equal(Feedback.ENDPOINT, ENDPOINT);
});

test('every field is clamped to the server caps before sending', async () => {
  const { Feedback, requests } = load();
  const res = await Feedback.submit({
    type: 'false_positive',
    pageUrl: `https://user:pw@www.imdb.com/${'p/'.repeat(1500)}?session=abc#frag`,
    element: {
      src: 'data:image/png;base64,AAAA',
      kind: 'IMG',
      matchedTitle: 'M'.repeat(500),
      confidence: '250',
      band: 'DEFINITE',
      reasons: Array.from({ length: 30 }, (_, i) => `${i}`.repeat(300)).concat([42, null])
    },
    note: 'n'.repeat(5000),
    title: 't'.repeat(500),
    contact: `${'a'.repeat(300)}@example.com`,
    extra: 'dropped',
    attempts: 3
  }, CONSENT);
  assert.equal(res.success, true);
  assert.equal(requests.length, 1);
  const r = requests[0];
  assert.ok(serverAccepts(r), JSON.stringify(r).slice(0, 300));
  assert.equal(r.note.length, 2000);
  assert.equal(r.title.length, 200);
  assert.equal(r.element.matchedTitle.length, 200);
  assert.equal(r.element.reasons.length, 10);
  assert.ok(r.element.reasons.every(x => x.length === 100));
  assert.equal(r.element.src, '', 'data: URI dropped');
  assert.equal(r.element.kind, '');
  assert.equal(r.element.band, '');
  assert.equal(r.element.confidence, 100);
  assert.equal(r.contact, '', 'an over-long address is dropped');
  assert.equal(r.pageUrl, 'https://www.imdb.com/', 'over-long path cut to the origin, no credentials');
  assert.equal('extra' in r || 'attempts' in r, false);
  assert.equal(r.context.dbVersion, null);
  assert.equal(r.ext.version, '1.6.2');
});

test('URLs keep origin + path only, and only http(s)', () => {
  const { Feedback } = load();
  const c = (pageUrl, src) => Feedback.clampReport({ pageUrl, element: { src } });
  assert.equal(c('https://a.example/x/y?q=1#h').pageUrl, 'https://a.example/x/y');
  assert.equal(c('chrome-extension://abc/popup/popup.html').pageUrl, '');
  assert.equal(c('javascript:alert(1)').pageUrl, '');
  assert.equal(c('', 'blob:https://a.example/uuid').element.src, '');
  assert.equal(c('', 'http://b.example/i.png?t=1').element.src, 'http://b.example/i.png');
});

test('a valid contact is kept (trimmed); a malformed one becomes empty', () => {
  const { Feedback } = load();
  assert.equal(Feedback.clampReport({ contact: '  me@example.com ' }).contact, 'me@example.com');
  for (const bad of ['me@example.c', 'not an email', 'a@b', 42, null]) {
    assert.equal(Feedback.clampReport({ contact: bad }).contact, '', String(bad));
  }
});

test('multi-byte text in every field still fits the 8 KiB body cap', () => {
  const { Feedback } = load();
  const r = Feedback.clampReport({
    type: 'general',
    pageUrl: `https://a.example/${'é'.repeat(600)}`,
    element: { src: `https://b.example/${'ü'.repeat(600)}`, reasons: Array(10).fill('界'.repeat(100)), matchedTitle: '界'.repeat(200) },
    note: '界'.repeat(2000),
    title: '界'.repeat(200)
  });
  assert.ok(serverAccepts(r));
  assert.ok(new TextEncoder().encode(JSON.stringify(r)).length <= Feedback.MAX_BODY_BYTES);
  assert.ok(r.note.length > 500, 'the note keeps as much as fits');
});

test('clipping never leaves half of a surrogate pair', () => {
  const { Feedback } = load();
  const r = Feedback.clampReport({ note: `${'x'.repeat(1999)}😱😱` });
  assert.equal(r.note.length, 1999);
});

test('clampReport is idempotent', () => {
  const { Feedback } = load();
  const once = Feedback.clampReport(report({ note: 'hi', contact: 'me@example.com' }));
  assert.deepEqual(Feedback.clampReport(once), once);
});

test('status codes map to the retry policy', () => {
  const { Feedback } = load();
  for (const s of [200, 201, 204]) assert.equal(Feedback.classifyStatus(s), 'sent');
  for (const s of [400, 403, 413, 415]) assert.equal(Feedback.classifyStatus(s), 'drop');
  assert.equal(Feedback.classifyStatus(429), 'later');
  for (const s of [0, 500, 502, 503, 504, 404]) assert.equal(Feedback.classifyStatus(s), 'retry');
});

test('Retry-After: seconds, HTTP date, default 600 s', () => {
  const { Feedback } = load();
  const now = Date.UTC(2026, 9, 4, 12);
  assert.equal(Feedback.parseRetryAfter('120', now), 120000);
  assert.equal(Feedback.parseRetryAfter(null, now), 600000);
  assert.equal(Feedback.parseRetryAfter('soon', now), 600000);
  assert.equal(Feedback.parseRetryAfter(new Date(now + 900000).toUTCString(), now), 900000);
  assert.equal(Feedback.parseRetryAfter('0', now), 60000, 'never hammer right away');
});

for (const status of [400, 403, 413, 415]) {
  test(`HTTP ${status} is permanent: not queued, warned, and dropped from the outbox`, async () => {
    const { Feedback, store, requests, warnings } = load(() => ({ status }));
    const res = await Feedback.submit(report(), CONSENT);
    assert.equal(res.success, false);
    assert.equal(res.rejected, true);
    assert.equal((store.feedbackOutbox || []).length, 0);
    assert.equal(requests.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`HTTP ${status}`));
  });
}

test('a permanent refusal during a flush removes that report from the outbox', async () => {
  let status = 503;
  const { Feedback, store, warnings, tick } = load(() => ({ status }));
  await Feedback.submit(report(), CONSENT);
  assert.equal(store.feedbackOutbox.length, 1);
  status = 400;
  tick(60000);
  await Feedback.flush();
  assert.equal(store.feedbackOutbox.length, 0);
  assert.equal(warnings.length, 1);
});

test('5xx and network errors are retried until MAX_ATTEMPTS, then given up', async () => {
  let mode = 'down';
  const { Feedback, store, requests, alarms, tick } = load(() => {
    if (mode === 'offline') throw new TypeError('Failed to fetch');
    return { status: 503 };
  });
  const res = await Feedback.submit(report(), CONSENT);
  assert.deepEqual({ ...res }, { success: true, queued: true });
  assert.equal(store.feedbackOutbox.length, 1);
  assert.equal(store.feedbackOutbox[0].attempts, 1);
  assert.ok(alarms.has('flush-feedback'));
  mode = 'offline';
  for (let i = 2; i < Feedback.MAX_ATTEMPTS; i++) {
    tick(30 * 60000);
    await Feedback.flush();
    assert.equal(store.feedbackOutbox.length, 1, `kept after attempt ${i}`);
    assert.equal(store.feedbackOutbox[0].attempts, i);
  }
  tick(30 * 60000);
  await Feedback.flush();
  assert.equal(store.feedbackOutbox.length, 0, 'dropped at MAX_ATTEMPTS');
  assert.equal(alarms.has('flush-feedback'), false, 'no more wakes for an empty outbox');
  assert.equal(requests.length, Feedback.MAX_ATTEMPTS, 'one first try plus the retries');
});

test('a retried report is sent and leaves the outbox', async () => {
  let status = 502;
  const { Feedback, store, requests, tick } = load(() => ({ status }));
  await Feedback.submit(report(), CONSENT);
  status = 200;
  tick(60000);
  await Feedback.flush();
  assert.equal(store.feedbackOutbox.length, 0);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reportId, requests[1].reportId);
  assert.ok(Object.keys(store.feedbackRecent).length === 1, 'marked sent for dedupe');
});

test('429 holds every send until Retry-After', async () => {
  let status = 429;
  const { Feedback, store, requests, alarms, tick, now } = load(() => ({ status, headers: { 'Retry-After': '900' } }));
  const res = await Feedback.submit(report(), CONSENT);
  assert.equal(res.queued, true);
  assert.equal(store.feedbackRetryAt, now() + 900000);
  assert.equal(alarms.get('flush-feedback').when, now() + 900000);
  assert.equal(store.feedbackOutbox[0].attempts, 0, 'a 429 is not the report\'s fault');
  status = 200;
  // A new report inside the window is queued without a request.
  tick(5 * 60000);
  const second = await Feedback.submit(report(), CONSENT);
  assert.equal(second.queued, true);
  await Feedback.flush();
  assert.equal(requests.length, 1, 'nothing sent before Retry-After');
  assert.equal(store.feedbackOutbox.length, 2);
  tick(10 * 60000 + 1);
  await Feedback.flush();
  assert.equal(requests.length, 3);
  assert.equal(store.feedbackOutbox.length, 0);
});

test('429 without Retry-After waits 600 s', async () => {
  const { Feedback, store, now } = load(() => ({ status: 429 }));
  await Feedback.submit(report(), CONSENT);
  assert.equal(store.feedbackRetryAt, now() + 600000);
});

test('sends are paced below the server limit of 30 per 10 minutes', async () => {
  let status = 503;
  const { Feedback, store, requests, sentAt, tick } = load(() => ({ status }));
  // 40 reports in under 5 minutes, all failing: only SEND_BUDGET of them get
  // a first try, the rest wait in the outbox unsent.
  for (let i = 0; i < 40; i++) {
    await Feedback.submit(report(), CONSENT);
    tick(7000);
  }
  assert.equal(requests.length, Feedback.SEND_BUDGET);
  assert.equal(store.feedbackOutbox.length, 40);
  status = 200;
  // Flush far more often than the alarm would, until the outbox is empty.
  for (let i = 0; i < 200 && store.feedbackOutbox.length; i++) {
    await Feedback.flush();
    tick(20000);
  }
  assert.equal(store.feedbackOutbox.length, 0, 'everything goes out eventually');
  assert.equal(requests.length, 60, '20 failed first tries, then 40 sends');
  // No 10-minute window, anywhere, holds more than the budget (server: 30).
  for (const t of sentAt) {
    const inWindow = sentAt.filter(u => u > t - 10 * 60000 && u <= t).length;
    assert.ok(inWindow <= Feedback.SEND_BUDGET && inWindow <= 30, `${inWindow} sends in 10 minutes`);
  }
});

test('reports queued by 1.6.1 (bare reports with attempts) are sent clamped', async () => {
  const { Feedback, store, requests } = load(() => ({ status: 200 }));
  store.feedbackOutbox = [{
    type: 'missed_blur', reportId: '3b241101-e2bb-4255-8caf-4136c566a962', ts: Date.UTC(2026, 9, 1),
    pageUrl: 'https://x.example/a', element: { src: '', kind: 'image', matchedTitle: null, confidence: 0, band: '', reasons: [] },
    context: { sensitivity: 'medium', modelVersion: 'mobileclip_s0-fp16-v3', dbVersion: '1.3.3' },
    ext: { version: '1.6.1' }, note: 'n'.repeat(2500), title: '', contact: '', attempts: 2
  }];
  await Feedback.flush();
  assert.equal(requests.length, 1);
  assert.ok(serverAccepts(requests[0]));
  assert.equal('attempts' in requests[0], false);
  assert.equal(requests[0].note.length, 2000);
  assert.equal(requests[0].ext.version, '1.6.1');
  assert.equal(store.feedbackOutbox.length, 0);
});

test('no consent: nothing is sent or queued', async () => {
  const { Feedback, store, requests } = load();
  const res = await Feedback.submit(report(), { feedbackConsent: false });
  assert.equal(res.needsConsent, true);
  assert.equal(requests.length, 0);
  assert.equal(store.feedbackOutbox, undefined);
});
