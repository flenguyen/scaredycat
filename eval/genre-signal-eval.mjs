/**
 * Scaredy Cat genre-signal eval.
 *
 *   node eval/genre-signal-eval.mjs
 *
 * Exercises the SAME genre-signal predicates the extension ships
 * (content/genre-signal.js) against labeled fixtures: genre lines that should
 * raise pageHasHorrorSignal, and look-alikes that must not. The DOM walking in
 * detector.js is covered end-to-end by browser-smoke; this is the fast,
 * dependency-free check on the decision logic.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadGenreSignal() {
  const src = fs.readFileSync(path.join(ROOT, 'content/genre-signal.js'), 'utf8');
  const moduleObj = { exports: {} };
  new Function('module', 'self', src)(moduleObj, undefined);
  return moduleObj.exports;
}

const Genre = loadGenreSignal();

// --- Visible genre-line text: should/shouldn't flag horror ----------------
const TEXT_CASES = [
  // Real genre lines from movie detail pages -> horror signal.
  { text: 'Horror/LGBTQ+/Sci-Fi/Romance', expect: true, note: 'Leviticus genre line (slashes)' },
  { text: 'Horror LGBTQ+ Sci-Fi Romance', expect: true, note: 'Leviticus genre chip row (no punctuation)' },
  { text: 'Horror/Mystery & Thriller', expect: true, note: 'Deep Water genre line' },
  { text: 'Horror', expect: true, note: 'bare single genre' },
  { text: 'Drama, Horror', expect: true, note: 'two-genre list' },
  { text: 'Comedy, Horror, Thriller', expect: true, note: 'three-genre list' },
  { text: 'Horror Thriller Mystery Drama', expect: true, note: 'space-separated genre chips, all known' },

  // Look-alikes that must NOT flag.
  { text: 'Comedy/Drama/Romance', expect: false, note: 'non-horror genre line' },
  { text: 'Action/Adventure/Sci-Fi', expect: false, note: 'non-horror genre line' },
  {
    text: 'A retrospective on how the horror genre evolved through the 1980s and the directors who shaped it.',
    expect: false,
    note: 'synopsis paragraph mentioning horror (too long)'
  },
  {
    text: 'This film is a masterful horror experience',
    expect: false,
    note: 'sentence with horror but no genre-list shape'
  },
  {
    text: 'Horror strikes a small town family',
    expect: false,
    note: 'prose: starts with Horror but has non-genre words'
  },
  { text: '', expect: false, note: 'empty' },
];

// --- Authoritative single-title structured detection -----------------------
// mediaItemsFromJsonLd + isSingleHorrorMediaPage gate the lowered image bar to
// real single-title detail pages (not multi-item carousels/listings).
const SINGLE_PAGE_CASES = [
  {
    data: { '@type': 'Movie', name: 'Leviticus', genre: ['Horror', 'LGBTQ+', 'Sci-Fi', 'Romance'] },
    expect: true, note: 'single horror Movie -> authoritative'
  },
  {
    data: { '@context': 'x', '@graph': [{ '@type': 'Movie', genre: 'Horror' }] },
    expect: true, note: 'single horror Movie nested under @graph'
  },
  {
    data: [
      { '@type': 'BreadcrumbList' },
      { '@type': 'Movie', name: 'Leviticus', genre: ['Horror'] }
    ],
    expect: true, note: 'one media item + non-media siblings -> authoritative'
  },
  {
    data: [
      { '@type': 'Movie', name: 'A', genre: ['Horror'] },
      { '@type': 'Movie', name: 'B', genre: ['Comedy'] }
    ],
    expect: false, note: 'two media items (carousel/listing) -> NOT authoritative'
  },
  {
    data: { '@type': 'Movie', name: 'The Notebook', genre: ['Romance'] },
    expect: false, note: 'single non-horror Movie -> not authoritative'
  },
];

// --- JSON-LD structured metadata -------------------------------------------
const JSONLD_CASES = [
  {
    data: { '@type': 'Movie', name: 'Leviticus', genre: ['Horror', 'Sci-Fi', 'Romance'] },
    expect: true, note: 'Movie with Horror in genre array'
  },
  {
    data: { '@type': 'Movie', name: 'Deep Water', genre: 'Horror' },
    expect: true, note: 'Movie with single Horror genre string'
  },
  {
    data: [
      { '@type': 'BreadcrumbList' },
      { '@type': 'TVSeries', genre: ['Drama', 'Horror'] }
    ],
    expect: true, note: 'array with a TVSeries Horror entry'
  },
  {
    data: { '@type': 'Movie', name: 'The Notebook', genre: ['Romance', 'Drama'] },
    expect: false, note: 'non-horror movie'
  },
  {
    data: { '@type': 'Organization', genre: 'Horror' },
    expect: false, note: 'non-media type with stray genre'
  },
  {
    data: { '@type': 'Movie', name: 'Untagged' },
    expect: false, note: 'movie with no genre'
  },
];

// --- URL genre-listing detection -------------------------------------------
const URL_CASES = [
  // Real Cineby (and mirror-domain) horror listing shapes -> signal.
  { href: 'https://www.cineby.at/browse/movie/horror', expect: true, note: 'path /browse/movie/horror' },
  { href: 'https://cineby.vg/genre/horror', expect: true, note: 'path /genre/horror' },
  { href: 'https://cineby.bz/movies?genre=27', expect: true, note: 'TMDB horror id in genre query' },
  { href: 'https://example.com/#/genre/horror', expect: true, note: 'hash route /genre/horror' },
  { href: 'https://example.com/discover?with_genres=27,53', expect: true, note: 'with_genres list incl 27' },
  { href: 'https://example.com/category/horror', expect: true, note: 'path /category/horror' },
  { href: 'https://example.com/horror-movies', expect: true, note: 'horror-movies path token' },

  // Look-alikes that must NOT flag.
  { href: 'https://example.com/movie/the-horror', expect: false, note: 'movie literally titled "The Horror"' },
  { href: 'https://example.com/genre/comedy', expect: false, note: 'non-horror genre path' },
  { href: 'https://example.com/movies?genre=18', expect: false, note: 'non-horror TMDB id (Drama)' },
  { href: 'https://example.com/', expect: false, note: 'plain homepage' },
  { href: 'https://example.com/article/the-horror-of-war', expect: false, note: 'horror substring not in genre position' },
];

// --- Active filter labels ---------------------------------------------------
const ACTIVE_FILTER_CASES = [
  { labels: ['Action', 'Horror', 'Comedy'], expect: true, note: 'Horror among active chips' },
  { labels: ['Horror'], expect: true, note: 'single active Horror chip' },
  { labels: ['Action', 'Comedy', 'Drama'], expect: false, note: 'no horror chip' },
  { labels: [], expect: false, note: 'no active filters' },
  {
    labels: ['A long blurb about how the horror genre evolved over decades and shaped modern cinema'],
    expect: false,
    note: 'long paragraph, not a chip label'
  },
];

let pass = 0, fail = 0;
const failures = [];

for (const c of TEXT_CASES) {
  const got = Genre.textLooksLikeHorrorGenre(c.text);
  if (got === c.expect) pass++;
  else { fail++; failures.push(`TEXT  [${c.note}] expected ${c.expect}, got ${got}: ${JSON.stringify(c.text).slice(0, 60)}`); }
}

for (const c of JSONLD_CASES) {
  const got = Genre.jsonLdDeclaresHorror(c.data);
  if (got === c.expect) pass++;
  else { fail++; failures.push(`JSONLD[${c.note}] expected ${c.expect}, got ${got}`); }
}

for (const c of SINGLE_PAGE_CASES) {
  const got = Genre.isSingleHorrorMediaPage(Genre.mediaItemsFromJsonLd(c.data));
  if (got === c.expect) pass++;
  else { fail++; failures.push(`SINGLE[${c.note}] expected ${c.expect}, got ${got}`); }
}

for (const c of URL_CASES) {
  const got = Genre.urlLooksLikeHorrorListing(c.href);
  if (got === c.expect) pass++;
  else { fail++; failures.push(`URL   [${c.note}] expected ${c.expect}, got ${got}: ${c.href}`); }
}

for (const c of ACTIVE_FILTER_CASES) {
  const got = Genre.activeFiltersDeclareHorror(c.labels);
  if (got === c.expect) pass++;
  else { fail++; failures.push(`CHIP  [${c.note}] expected ${c.expect}, got ${got}`); }
}

console.log(`genre-signal eval: ${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('failures:');
  failures.forEach(f => console.log('  - ' + f));
  process.exitCode = 1;
}
