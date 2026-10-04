/**
 * Unit tests for the title-list validation in background/db-version.js
 * (sanitizeDatabase, the remote body cap):
 *   node eval/db-validate-test.mjs
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
const DB = loadClassic('background/db-version.js');
const Scoring = loadClassic('content/scoring-core.js');

const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/horror-database.json'), 'utf8'));
const bundledMajor = DB.parseVersion(bundled.version)[0];
const maxMajor = bundledMajor + 1;

test('the bundled list passes unchanged in substance', () => {
  const clean = DB.sanitizeDatabase(bundled, { maxMajor });
  assert.ok(clean);
  assert.equal(clean.titles.length, bundled.titles.length);
  assert.equal(clean.keywords.length, bundled.keywords.length);
  assert.deepEqual(clean.safeTitles, bundled.safeTitles);
  // It still compiles, and scores the same text the same way.
  const a = Scoring.compile(bundled);
  const b = Scoring.compile(clean);
  for (const text of ['Hereditary official trailer', 'The Conjuring: Last Rites', 'Freaky Friday', 'beach vacation']) {
    const opts = { threshold: Scoring.SENSITIVITY_THRESHOLDS.medium };
    assert.deepEqual(Scoring.analyzeText(text, b, opts), Scoring.analyzeText(text, a, opts), text);
  }
});

test('malformed entries are dropped, the rest survive', () => {
  const db = {
    version: '1.4.0',
    lastUpdated: '2026-10-04',
    titles: [
      { title: 1 },                                   // would throw in normalizeText
      { title: '' },
      { title: 'x'.repeat(201) },
      { title: 'Good One', year: 2020, variations: ['good one film'] },
      { title: 'Bad Year', year: '2020' },
      { title: 'Bad Flag', definite: 'yes' },
      { title: 'Bad Variations', variations: 'nope' },
      { title: 'Bad Tmdb', tmdb: '12' },
      null, 'Halloween', [1, 2],
      { title: 'Auto Entry', year: null, variations: [], tmdb: 42, type: 'movie', auto: true, synopsis: 'dropped', extra: { x: 1 } },
      { title: 'Many Variations', variations: [...Array.from({ length: 30 }, (_, i) => `v${i}`), 5, ''] }
    ],
    keywords: [{ keyword: 'horror', weight: 30 }, { keyword: 'bad', weight: '9' }, { keyword: 3, weight: 1 }, { keyword: 'big', weight: 1e9 }],
    safeTitles: ['Freaky Friday', 5, '']
  };
  const clean = DB.sanitizeDatabase(db, { maxMajor });
  assert.deepEqual(clean.titles.map(t => t.title), ['Good One', 'Auto Entry', 'Many Variations']);
  assert.deepEqual(clean.titles[1], { title: 'Auto Entry', year: null, variations: [], auto: true, tmdb: 42, type: 'movie' });
  assert.equal(clean.titles[2].variations.length, 20);
  assert.deepEqual(clean.keywords, [{ keyword: 'horror', weight: 30 }]);
  assert.deepEqual(clean.safeTitles, ['Freaky Friday']);
  // And the survivor list compiles (the {"title": 1} case used to throw here).
  assert.doesNotThrow(() => Scoring.compile(clean));
  assert.throws(() => Scoring.compile(db));
});

test('whole-list rejections', () => {
  const titles = [{ title: 'Ok' }];
  assert.equal(DB.sanitizeDatabase({ version: '9999', titles }, { maxMajor }), null, 'pinned 9999');
  assert.equal(DB.sanitizeDatabase({ version: `${maxMajor + 1}.0.0`, titles }, { maxMajor }), null, 'two majors ahead');
  assert.ok(DB.sanitizeDatabase({ version: `${maxMajor}.0.0`, titles }, { maxMajor }), 'one major ahead is fine');
  assert.ok(DB.sanitizeDatabase({ version: '9999', titles }), 'no cap given: shape only');
  for (const version of ['1.2.3.4.5', 'v1.2', '1..2', '', '12345.0', 1.2, null, '1.2-beta']) {
    assert.equal(DB.sanitizeDatabase({ version, titles }, { maxMajor }), null, String(version));
  }
  assert.equal(DB.sanitizeDatabase({ version: '1.0', titles: [] }), null, 'empty');
  assert.equal(DB.sanitizeDatabase({ version: '1.0', titles: [{ title: 1 }] }), null, 'nothing usable');
  assert.equal(DB.sanitizeDatabase({ version: '1.0', titles: Array.from({ length: 10001 }, (_, i) => ({ title: `t${i}` })) }), null, 'too many');
  assert.ok(DB.sanitizeDatabase({ version: '1.0', titles: Array.from({ length: 10000 }, (_, i) => ({ title: `t${i}` })) }), '10000 is the cap');
  assert.equal(DB.sanitizeDatabase({ version: '1.0', titles, keywords: 'x' }), null);
  assert.equal(DB.sanitizeDatabase(null), null);
  assert.equal(DB.sanitizeDatabase([]), null);
});

function fakeResponse(body, headers = {}) {
  const bytes = new TextEncoder().encode(body);
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    body: new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 65536) controller.enqueue(bytes.subarray(i, i + 65536));
        controller.close();
      }
    })
  };
}

test('2 MB body cap, before JSON.parse', async () => {
  const small = JSON.stringify({ version: '1.0', titles: [{ title: 'Ok' }] });
  assert.equal(await DB.readCappedText(fakeResponse(small)), small);
  const big = 'x'.repeat(DB.MAX_BODY_BYTES + 1);
  assert.equal(await DB.readCappedText(fakeResponse(big)), null, 'streamed over the cap');
  assert.equal(await DB.readCappedText(fakeResponse(small, { 'Content-Length': String(3 * 1024 * 1024) })), null, 'declared over the cap');
  assert.equal((await DB.readCappedText(fakeResponse('x'.repeat(DB.MAX_BODY_BYTES)))).length, DB.MAX_BODY_BYTES, 'exactly at the cap');
});

test('content type must be JSON', () => {
  const r = (t) => ({ headers: { get: () => t } });
  assert.equal(DB.isJsonResponse(r('application/json; charset=utf-8')), true);
  assert.equal(DB.isJsonResponse(r('application/json')), true);
  assert.equal(DB.isJsonResponse(r('text/html')), false);
  assert.equal(DB.isJsonResponse(r('application/jsonp')), false);
  assert.equal(DB.isJsonResponse(r(null)), false);
});
