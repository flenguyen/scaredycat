/**
 * Unit tests for the spoiler-summary lookup (background/synopses.js) and the
 * detector's year pick for titles shared by several entries
 * (ScaredyCatScoring.pickEntryByYear):
 *   node eval/synopses-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Both are classic scripts: load through the same module shim as run-eval.mjs.
function loadClassic(rel) {
  const moduleObj = { exports: {} };
  new Function('module', 'self', fs.readFileSync(path.join(ROOT, rel), 'utf8'))(moduleObj, undefined);
  return moduleObj.exports;
}
const Scoring = loadClassic('content/scoring-core.js');
const Synopses = loadClassic('background/synopses.js');

const payload = {
  version: 1,
  updatedAt: '2026-10-04T00:00:00Z',
  titles: [
    { title: '28 Years Later', year: 2025, names: ['28 Years Later'], tmdb: 1100988, type: 'movie',
      slug: '28-years-later-2025', text: 'Twenty-eight years after an outbreak.' },
    // TMDB says 2013, the curated list files it as "Conjuring" 2012.
    { title: 'The Conjuring', year: 2013, curatedYear: 2012, names: ['The Conjuring', 'Conjuring'],
      tmdb: 138843, type: 'movie', slug: 'the-conjuring-2013', text: 'A farmhouse.' },
    // Same name, two films: the bare name is ambiguous.
    { title: 'Halloween', year: 1978, names: ['Halloween', 'Michael Myers'], tmdb: 948, type: 'movie',
      slug: 'halloween-1978', text: 'Babysitters.' },
    { title: 'Halloween', year: 2018, names: ['Halloween'], tmdb: 424139, type: 'movie',
      slug: 'halloween-2018', text: 'Forty years later.' },
    // Same id, other media type.
    { title: 'Chucky', year: 2021, names: ['Chucky'], tmdb: 948, type: 'tv',
      slug: 'chucky-2021', text: 'A doll, serialized.' },
    { title: 'Untitled', year: null, names: ['Untitled Horror Thing'], tmdb: null, type: 'movie',
      slug: 'untitled', text: 'Nobody knows.' }
  ]
};

const index = Synopses.buildIndex(payload, Scoring.normalizeText);
const find = (q) => Synopses.lookup(index, q);

test('tmdb + media type wins, and the type disambiguates a shared id', () => {
  assert.equal(find({ title: 'whatever', year: 1999, tmdb: 948, mediaType: 'movie' })?.slug, 'halloween-1978');
  assert.equal(find({ title: 'whatever', tmdb: 948, mediaType: 'tv' })?.slug, 'chucky-2021');
  // An unknown id falls through to the name.
  assert.equal(find({ title: '28 Years Later', year: 2025, tmdb: 1, mediaType: 'movie' })?.slug, '28-years-later-2025');
});

test('name + year, normalized like the detector', () => {
  assert.equal(find({ title: 'Halloween', year: 2018 })?.slug, 'halloween-2018');
  assert.equal(find({ title: 'HALLOWEEN!', year: 1978 })?.slug, 'halloween-1978');
  assert.equal(find({ title: 'michael myers', year: 1978 })?.slug, 'halloween-1978');
});

test('curatedYear is an alias year; the response carries the canonical year', () => {
  const hit = find({ title: 'Conjuring', year: 2012 });
  assert.deepEqual(hit, { title: 'The Conjuring', year: 2013, text: 'A farmhouse.', slug: 'the-conjuring-2013' });
  assert.equal(find({ title: 'The Conjuring', year: 2013 })?.slug, 'the-conjuring-2013');
});

test('bare name: unique -> hit, ambiguous -> null', () => {
  assert.equal(find({ title: '28 Years Later' })?.slug, '28-years-later-2025');
  assert.equal(find({ title: '28 years later', year: 2026 })?.slug, '28-years-later-2025');
  // A unique name with a distant year is another work (remake, game): no hit.
  assert.equal(find({ title: '28 years later', year: 2030 }), null);
  assert.equal(find({ title: 'Untitled Horror Thing' })?.year, null);
  assert.equal(find({ title: 'Halloween' }), null);
  assert.equal(find({ title: 'Halloween', year: 2007 }), null);
  assert.equal(find({ title: 'Not In The List', year: 2020 }), null);
  assert.equal(find({}), null);
  assert.equal(Synopses.lookup(null, { title: 'Halloween' }), null);
});

test('sanitizePayload rejects bad shapes and drops unusable entries', () => {
  assert.equal(Synopses.sanitizePayload(null), null);
  assert.equal(Synopses.sanitizePayload({ version: 2, titles: payload.titles }), null);
  assert.equal(Synopses.sanitizePayload({ version: 1, titles: {} }), null);
  assert.equal(Synopses.sanitizePayload({ version: 1, titles: [] }), null);
  assert.equal(Synopses.sanitizePayload(payload), payload); // untouched when all valid
  const mixed = Synopses.sanitizePayload({ version: 1, titles: [
    payload.titles[0],
    { ...payload.titles[1], text: '   ' },
    { ...payload.titles[2], names: 'Halloween' },
    null
  ] });
  assert.deepEqual(mixed.titles.map(t => t.slug), ['28-years-later-2025']);
  // An empty index (nothing fetched yet) answers null, never throws.
  assert.equal(Synopses.lookup(Synopses.buildIndex(undefined, Scoring.normalizeText), { title: 'x' }), null);
});

test('pickEntryByYear: the year named in the element text wins, else first', () => {
  const entries = [{ title: 'Halloween', year: 1978 }, { title: 'Halloween', year: 2018 }];
  assert.equal(Scoring.pickEntryByYear(entries, 'Halloween (2018) official trailer').year, 2018);
  assert.equal(Scoring.pickEntryByYear(entries, 'Halloween 1978 poster').year, 1978);
  assert.equal(Scoring.pickEntryByYear(entries, 'Halloween official trailer').year, 1978);
  assert.equal(Scoring.pickEntryByYear(entries, '').year, 1978);
  // Digits inside a longer number are not a year.
  assert.equal(Scoring.pickEntryByYear(entries, 'Halloween clip 120181').year, 1978);
  assert.equal(Scoring.pickEntryByYear([], 'x'), null);
  assert.equal(Scoring.pickEntryByYear(undefined, 'x'), null);
});
