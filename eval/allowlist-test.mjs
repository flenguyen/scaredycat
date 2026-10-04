/**
 * Unit tests for the worker-side allowlist rules (background/allowlist.js
 * plus the title half in guards.js): the legacy allowedItems split, routing
 * of new "Allow" items, dedupe and caps, and exact matching.
 *   node eval/allowlist-test.mjs
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
const Allowlist = loadClassic('background/allowlist.js');
const Guards = loadClassic('background/guards.js');
const Scoring = loadClassic('content/scoring-core.js');
const { canonicalImageKey } = loadClassic('background/image-key.js');

test('legacy allowedItems split into image keys and normalized titles', () => {
  const legacy = [
    'https://i.ytimg.com/vi/abc123/hqdefault.jpg?sqp=x',
    'https://i.ytimg.com/vi/abc123/maxresdefault.jpg', // same video: same key
    'https://image.tmdb.org/t/p/w500/poster.jpg',
    'the exorcist',
    'The Exorcist!',
    'us',
    'HTTP://EXAMPLE.TEST/a.png',
    '',
    42,
    'x'.repeat(5000)
  ];
  const { images, titles } = Allowlist.splitLegacy(legacy, canonicalImageKey, Scoring.normalizeText);
  assert.deepEqual(images, ['yt:abc123', 'yt:abc123', 'tmdb:poster.jpg', 'http://example.test/a.png']);
  assert.deepEqual(titles, ['the exorcist', 'the exorcist', 'us']);
  // After dedupe (what the worker stores):
  assert.deepEqual(Allowlist.addImageKeys([], images), ['yt:abc123', 'tmdb:poster.jpg', 'http://example.test/a.png']);
  assert.deepEqual(Guards.addTitles([], titles, Scoring.normalizeText), ['the exorcist', 'us']);
});

test('migration is idempotent', () => {
  const legacy = ['https://image.tmdb.org/t/p/w500/poster.jpg', 'Smile'];
  const first = Allowlist.splitLegacy(legacy, canonicalImageKey, Scoring.normalizeText);
  const images1 = Allowlist.addImageKeys([], first.images);
  const titles1 = Guards.addTitles([], first.titles, Scoring.normalizeText);
  // A second run over the same input (e.g. an interrupted first run) adds nothing.
  const again = Allowlist.splitLegacy(legacy, canonicalImageKey, Scoring.normalizeText);
  assert.deepEqual(Allowlist.addImageKeys(images1, again.images), images1);
  assert.deepEqual(Guards.addTitles(titles1, again.titles, Scoring.normalizeText), titles1);
  // And settings written back carry no allowedItems.
  const settings = Guards.sanitizeSettings({ enabled: true, allowedItems: legacy, allowedTitles: titles1 });
  assert.equal('allowedItems' in settings, false);
  assert.deepEqual(settings.allowedTitles, ['smile']);
});

test('routing: what counts as an image item', () => {
  for (const item of ['https://x.test/a.jpg', 'http://x.test/a.jpg', 'HTTPS://X.TEST/A.JPG', 'data:image/png;base64,AAAA', 'blob:https://x.test/1']) {
    assert.equal(Allowlist.isImageItem(item), true, item);
  }
  for (const item of ['the exorcist', 'us', 'httpx', 'ftp://x.test/a.jpg', '', null]) {
    assert.equal(Allowlist.isImageItem(item), false, String(item));
  }
});

test('image cap 500, newest kept, re-adding moves to the end', () => {
  const keys = Array.from({ length: 520 }, (_, i) => `k${i}`);
  const capped = Allowlist.addImageKeys([], keys);
  assert.equal(capped.length, Allowlist.IMAGES_MAX);
  assert.equal(capped[0], 'k20');
  assert.equal(capped.at(-1), 'k519');
  const moved = Allowlist.addImageKeys(['a', 'b', 'c'], ['a']);
  assert.deepEqual(moved, ['b', 'c', 'a']);
  assert.deepEqual(Allowlist.addImageKeys(['a', 'a', 7, ''], []), ['a']);
  assert.deepEqual(Allowlist.removeImageKey(['a', 'b'], 'a'), ['b']);
});

test('title cap 100', () => {
  const titles = Guards.addTitles([], Array.from({ length: 130 }, (_, i) => `Film ${i}`), Scoring.normalizeText);
  assert.equal(titles.length, 100);
  assert.equal(titles[0], 'film 30');
});

test('exact matching: allowing "Us" no longer allows URLs containing "us"', () => {
  const allowedTitles = new Set(Guards.addTitles([], ['Us'], Scoring.normalizeText));
  const allowedImages = new Set(Allowlist.addImageKeys([], [canonicalImageKey('https://image.tmdb.org/t/p/w500/us-poster.jpg')]));
  // The old rule was allowedItems.some(item => url.includes(item)).
  const url = 'https://twitter.com/status/123/photo.jpg';
  assert.equal(['us'].some(item => url.includes(item)), true, 'the old substring bug');
  assert.equal(allowedImages.has(canonicalImageKey(url)), false);
  assert.equal(allowedTitles.has(Scoring.normalizeText('Us')), true);
  assert.equal(allowedTitles.has(Scoring.normalizeText('Jordan Peele: Us and Them')), false);
  // The same poster at another TMDB size is still allowed.
  assert.equal(allowedImages.has(canonicalImageKey('https://image.tmdb.org/t/p/original/us-poster.jpg')), true);
});
