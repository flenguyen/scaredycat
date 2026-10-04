/**
 * Unit tests for background/guards.js (who may send which message, settings
 * sanitizing, which image URLs the classifier may fetch) and the CDN
 * variant rewrite in background/image-key.js:
 *   node eval/guards-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadClassic(rel) {
  const moduleObj = { exports: {} };
  new Function('module', 'self', fs.readFileSync(path.join(ROOT, rel), 'utf8'))(moduleObj, undefined);
  return moduleObj.exports;
}
const Guards = loadClassic('background/guards.js');
const Scoring = loadClassic('content/scoring-core.js');
const ImageKey = loadClassic('background/image-key.js');

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${ID}/`;
const kind = (sender) => Guards.senderKind(sender, ID, ORIGIN);

// ---- senders ------------------------------------------------------------------

test('senderKind: popup, welcome tab, content script, strangers', () => {
  assert.equal(kind({ id: ID, url: `${ORIGIN}popup/popup.html`, origin: ORIGIN.slice(0, -1) }), 'page');
  // The welcome page runs in a tab but is still an extension page.
  assert.equal(kind({ id: ID, url: `${ORIGIN}welcome/welcome.html`, tab: { id: 3 } }), 'page');
  assert.equal(kind({ id: ID, url: 'https://www.imdb.com/', tab: { id: 3 }, origin: 'https://www.imdb.com' }), 'content');
  assert.equal(kind({ id: 'otherextension', url: `chrome-extension://otherextension/x.html` }), null);
  assert.equal(kind({ id: ID, url: 'https://evil.example/' }), null); // no tab, not ours
  assert.equal(kind(null), null);
  assert.equal(kind({ id: ID, url: `${ORIGIN}popup/popup.html`, origin: 'https://evil.example' }), null);
});

// ---- messages -----------------------------------------------------------------

test('popup-only messages are refused from content scripts', () => {
  for (const m of [
    { type: 'TOGGLE_SITE', hostname: 'www.imdb.com' },
    { type: 'GET_SITE_STATUS', hostname: 'www.imdb.com' },
    { type: 'REMOVE_FROM_ALLOWLIST', item: 'the exorcist' }
  ]) {
    assert.equal(Guards.checkMessage(m, 'content'), 'forbidden', m.type);
    assert.equal(Guards.checkMessage(m, 'page'), null, m.type);
  }
});

test('content scripts may only set feedbackConsent', () => {
  assert.equal(Guards.checkMessage({ type: 'UPDATE_SETTINGS', settings: { feedbackConsent: true } }, 'content'), null);
  assert.equal(Guards.checkMessage({ type: 'UPDATE_SETTINGS', settings: { enabled: false } }, 'content'), 'forbidden');
  assert.equal(Guards.checkMessage({ type: 'UPDATE_SETTINGS', settings: { feedbackConsent: true, sensitivity: 'low' } }, 'content'), 'forbidden');
  assert.equal(Guards.checkMessage({ type: 'UPDATE_SETTINGS', settings: { feedbackConsent: 'yes' } }, 'content'), 'invalid');
  assert.equal(Guards.checkMessage({ type: 'UPDATE_SETTINGS', settings: { enabled: false, sensitivity: 'low' } }, 'page'), null);
  assert.equal(Guards.checkMessage({ type: 'UPDATE_SETTINGS', settings: [] }, 'page'), 'invalid');
});

test('payload schemas', () => {
  const ok = (m, k = 'content') => assert.equal(Guards.checkMessage(m, k), null, JSON.stringify(m).slice(0, 80));
  const bad = (m, k = 'content') => assert.equal(Guards.checkMessage(m, k), 'invalid', JSON.stringify(m).slice(0, 80));
  ok({ type: 'CLASSIFY_IMAGE', url: 'https://image.tmdb.org/t/p/w500/a.jpg' });
  bad({ type: 'CLASSIFY_IMAGE', url: 'https://x.test/' + 'a'.repeat(2048) });
  bad({ type: 'CLASSIFY_IMAGE', url: 42 });
  ok({ type: 'INCREMENT_BLOCKED', count: 3 });
  ok({ type: 'INCREMENT_BLOCKED', count: 500, pageCount: 12 }); // clamped by the handler
  bad({ type: 'INCREMENT_BLOCKED', count: 0 });
  bad({ type: 'INCREMENT_BLOCKED', count: 1.5 });
  bad({ type: 'INCREMENT_BLOCKED', count: 1, pageCount: -1 });
  ok({ type: 'SET_BADGE', pageCount: 0 });
  bad({ type: 'SET_BADGE', pageCount: 1e9 });
  bad({ type: 'SET_BADGE' });
  ok({ type: 'ADD_TO_ALLOWLIST', item: 'https://m.media-amazon.com/images/M/abc._V1_.jpg' });
  bad({ type: 'ADD_TO_ALLOWLIST', item: '' });
  bad({ type: 'ADD_TO_BLOCKLIST', item: 'x'.repeat(2049) });
  bad({ type: 'REMOVE_FROM_BLOCKLIST', item: { toString: () => 'x' } });
  ok({ type: 'GET_SYNOPSIS', title: 'Halloween', year: 1978, tmdb: 948, mediaType: 'movie' });
  ok({ type: 'GET_SYNOPSIS', title: 'Halloween', year: null, tmdb: null, mediaType: null });
  bad({ type: 'GET_SYNOPSIS', title: 'Halloween', year: '1978' });
  bad({ type: 'GET_SYNOPSIS', title: { a: 1 } });
  ok({ type: 'GET_FONT', file: 'Inter.woff2' });
  bad({ type: 'GET_FONT', file: '../manifest.json' });
  ok({ type: 'SUBMIT_FEEDBACK', report: { type: 'general' } });
  bad({ type: 'SUBMIT_FEEDBACK', report: 'x' });
  ok({ type: 'GET_DB' });
  ok({ type: 'GET_UI_CSS' });
  bad({ type: 'TOGGLE_SITE', hostname: 'not a host!' }, 'page');
  assert.equal(Guards.checkMessage({ type: 'NOPE' }, 'content'), 'unknown');
  assert.equal(Guards.checkMessage({ type: 'toString' }, 'content'), 'unknown');
  assert.equal(Guards.checkMessage(null, 'content'), 'invalid');
  assert.equal(Guards.checkMessage({ type: 'GET_SETTINGS' }, null), 'forbidden');
});

// ---- settings -----------------------------------------------------------------

test('sanitizeSettings: defaults, types, caps, repair', () => {
  assert.deepEqual(Guards.sanitizeSettings(undefined), {
    enabled: true, sensitivity: 'medium', disabledSites: [], allowedTitles: [], feedbackConsent: false
  });
  const s = Guards.sanitizeSettings({
    enabled: 'no', sensitivity: 'extreme', feedbackConsent: 1,
    disabledSites: ['WWW.IMDB.COM', 'www.imdb.com', '<script>', 42, 'localhost', '[::1]'],
    allowedTitles: ['The Exorcist!', 'the exorcist', 7, '', 'Us'],
    allowedItems: ['https://x.test/a.jpg'], totalBlockedAllTime: 99, extra: { a: 1 }
  });
  assert.deepEqual(s, {
    enabled: true, sensitivity: 'medium', feedbackConsent: false,
    disabledSites: ['www.imdb.com', 'localhost', '[::1]'],
    allowedTitles: ['the exorcist', 'us']
  });
  const many = Guards.sanitizeSettings({
    disabledSites: Array.from({ length: 400 }, (_, i) => `site${i}.test`),
    allowedTitles: Array.from({ length: 150 }, (_, i) => `title ${i}`)
  });
  assert.equal(many.disabledSites.length, 300);
  assert.equal(many.disabledSites[299], 'site399.test'); // newest kept
  assert.equal(many.allowedTitles.length, 100);
  assert.equal(many.allowedTitles[99], 'title 149');
  // Not an object at all: defaults.
  assert.equal(Guards.sanitizeSettings('corrupt').sensitivity, 'medium');
  assert.equal(Guards.sanitizeSettings([1, 2]).enabled, true);
});

test('normalizeTitle matches scoring-core normalizeText', () => {
  for (const t of ['The Exorcist', "Don't Breathe 2", '  Smile  2 ', 'Amélie', 'IT: Chapter Two', '28 Days Later...', 'Us']) {
    assert.equal(Guards.normalizeTitle(t), Scoring.normalizeText(t), t);
  }
  assert.equal(Guards.normalizeTitle(1), '');
});

// ---- fetchable URLs -----------------------------------------------------------

test('isFetchableImageUrl: public CDNs pass', () => {
  for (const u of [
    'https://image.tmdb.org/t/p/w500/abc.jpg',
    'https://m.media-amazon.com/images/M/MV5B._V1_.jpg',
    'http://i.ytimg.com/vi/abc/hqdefault.jpg',
    'https://8.8.8.8/x.png',
    'https://[2606:4700::1111]/x.png',
    'https://www.imdb.com:8905/img/poster.png',
    'https://calib.scaredycat.test:8906/a.jpg'
  ]) assert.equal(Guards.isFetchableImageUrl(u), true, u);
});

test('isFetchableImageUrl: local, private and odd URLs are refused', () => {
  for (const u of [
    'http://localhost/x.png', 'http://localhost.:8080/x.png', 'http://foo.localhost/x.png',
    'http://printer.local/x.png', 'http://metadata.google.internal/x', 'http://router/x.png',
    'http://nas.lan/x.png', 'http://box.home.arpa/x',
    'http://127.0.0.1/x', 'http://127.1/x', 'http://2130706433/x', 'http://0x7f.0.0.1/x', 'http://0177.0.0.1/x',
    'http://0x7f000001/x', 'http://0/x', 'http://0.0.0.0/x',
    'http://10.0.0.5/x', 'http://172.16.0.1/x', 'http://172.31.255.255/x', 'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/x', 'http://100.127.255.255/x',
    'http://224.0.0.1/x', 'http://255.255.255.255/x', 'http://198.18.0.1/x',
    'http://[::1]/x', 'http://[::]/x', 'http://[fc00::1]/x', 'http://[fd12:3456::1]/x', 'http://[fe80::1]/x',
    'http://[::ffff:127.0.0.1]/x', 'http://[::ffff:192.168.1.1]/x', 'http://[::ffff:7f00:1]/x',
    'http://[64:ff9b::a00:1]/x', 'http://[2002:c0a8:101::1]/x', 'http://[ff02::1]/x',
    'https://user:pass@image.tmdb.org/x.jpg', 'https://user@image.tmdb.org/x.jpg',
    'ftp://image.tmdb.org/x.jpg', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'blob:https://x.test/1',
    'chrome-extension://abc/x.png', 'javascript:alert(1)', 'not a url', '', null,
    'https://x.test/' + 'a'.repeat(2048)
  ]) assert.equal(Guards.isFetchableImageUrl(u), false, String(u));
  // Public neighbours of private ranges stay fetchable.
  for (const u of ['http://172.32.0.1/x', 'http://100.128.0.1/x', 'http://11.0.0.1/x', 'http://[::ffff:8.8.8.8]/x']) {
    assert.equal(Guards.isFetchableImageUrl(u), true, u);
  }
});

test('parseIPv6 expands :: and embedded IPv4', () => {
  assert.deepEqual(Guards.parseIPv6('[::1]'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(Guards.parseIPv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(Guards.parseIPv6('2001:db8::'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
  assert.equal(Guards.parseIPv6('1::2::3'), null);
  assert.equal(Guards.parseIPv6('1:2:3:4:5:6:7:8:9'), null);
});

// ---- smaller CDN variants (image-key.js) -------------------------------------

test('smallVariantUrl: downsizes only, keeps crops', () => {
  const v = ImageKey.smallVariantUrl;
  assert.equal(v('https://image.tmdb.org/t/p/original/abc.jpg'), 'https://image.tmdb.org/t/p/w500/abc.jpg');
  assert.equal(v('https://image.tmdb.org/t/p/w1280/abc.jpg'), 'https://image.tmdb.org/t/p/w500/abc.jpg');
  assert.equal(v('https://image.tmdb.org/t/p/w342/abc.jpg'), 'https://image.tmdb.org/t/p/w342/abc.jpg');
  assert.equal(v('https://m.media-amazon.com/images/M/MV5Babc@._V1_.jpg'), 'https://m.media-amazon.com/images/M/MV5Babc@._V1_UX512_.jpg');
  assert.equal(v('https://m.media-amazon.com/images/M/MV5Babc@._V1_QL75_UX1000_.jpg'), 'https://m.media-amazon.com/images/M/MV5Babc@._V1_UX512_.jpg');
  const cropped = 'https://m.media-amazon.com/images/M/MV5Babc@._V1_QL75_UX380_CR0,0,380,562_.jpg';
  assert.equal(v(cropped), cropped);
  const small = 'https://m.media-amazon.com/images/M/MV5Babc@._V1_UX300_.jpg';
  assert.equal(v(small), small);
  assert.equal(v('https://i.ytimg.com/vi/abc123/maxresdefault.jpg'), 'https://i.ytimg.com/vi/abc123/hqdefault.jpg');
  const signed = 'https://i.ytimg.com/vi/abc123/hq720.jpg?sqp=xyz&rs=abc';
  assert.equal(v(signed), signed);
  assert.equal(v('https://i.ytimg.com/vi/abc123/maxresdefault.jpg', { cdns: ['tmdb'] }), 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg');
  // Same canonical key before and after: the verdict cache is unaffected.
  for (const u of ['https://image.tmdb.org/t/p/original/abc.jpg', 'https://m.media-amazon.com/images/M/MV5Babc@._V1_.jpg', 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg']) {
    assert.equal(ImageKey.canonicalImageKey(v(u)), ImageKey.canonicalImageKey(u), u);
  }
});
