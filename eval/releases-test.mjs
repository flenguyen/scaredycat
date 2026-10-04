/**
 * Unit tests for the popup's "What's new" helpers (popup/whats-new.js) and the
 * release-notes check (scripts/release-check.mjs):
 *   node eval/releases-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validateReleases, runReleaseCheck } from '../scripts/release-check.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Classic script: load through the same module shim as the other evals.
function loadClassic(rel) {
  const moduleObj = { exports: {} };
  new Function('module', 'self', fs.readFileSync(path.join(ROOT, rel), 'utf8'))(moduleObj, undefined);
  return moduleObj.exports;
}
const W = loadClassic('popup/whats-new.js');

const change = (type, text = `A ${type} change.`) => ({ type, text });
const ext = (version, level, date, extra = {}) => ({
  id: version, surface: 'extension', version, level, date,
  title: `Release ${version}`, summary: `Summary for ${version}.`,
  changes: [change('new')], commits: ['abc1234'], ...extra
});
const web = (id, date) => ({
  id, surface: 'website', version: null, level: null, date,
  title: 'Website launch', summary: 'The website did a thing.', changes: [change('new')], commits: []
});

function goodPayload() {
  return {
    schema: 1,
    current: '1.5.1',
    dataFlows: [
      { what: 'Title list download.', where: 'scaredycat.app', sends: 'Nothing about you.', since: '1.2.0', optIn: false }
    ],
    releases: [
      ext('1.5.1', 3, '2026-10-04'),
      ext('1.5.0', 2, '2026-10-04', { aside: 'The cat keeps a diary.' }),
      web('web-2026-10-03-spoiler-library', '2026-10-03'),
      ext('1.4.0', 2, '2026-10-02'),
      ext('1.3.1', 3, '2026-09-26'),
      ext('1.3.0', 2, '2026-09-25'),
      ext('1.2.0', 2, '2026-06-17'),
      ext('1.0.0', 1, '2026-01-23')
    ]
  };
}
const OPTS = { manifestVersion: '1.5.1', packageVersion: '1.5.1', today: '2026-10-04' };

// ---- whats-new.js ---------------------------------------------------------

test('compareVersions orders numerically, not as strings', () => {
  assert.ok(W.compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(W.compareVersions('1.5.0', '1.5.1') < 0);
  assert.equal(W.compareVersions('2.0.0', '2.0.0'), 0);
  assert.ok(W.compareVersions('2.0.0', '1.99.99') > 0);
  // Invalid input sorts below any real version and never throws.
  assert.ok(W.compareVersions('1.0.0', 'nope') > 0);
  assert.ok(W.compareVersions(undefined, '0.0.1') < 0);
});

test('extensionReleases drops website entries and sorts newest first', () => {
  const list = W.extensionReleases({ releases: [ext('1.2.0', 2, 'x'), web('web-a', 'x'), ext('1.10.0', 2, 'x'), { surface: 'extension', version: 'bad' }] });
  assert.deepEqual(list.map(r => r.version), ['1.10.0', '1.2.0']);
  assert.deepEqual(W.extensionReleases(null), []);
  assert.deepEqual(W.extensionReleases([ext('1.0.0', 1, 'x')]).map(r => r.version), ['1.0.0']);
});

test('latestHighlight is the newest level 1/2 release plus newer patches', () => {
  assert.deepEqual(W.latestHighlight(goodPayload()).map(r => r.version), ['1.5.1', '1.5.0']);
  const p = goodPayload();
  p.releases.shift();
  assert.deepEqual(W.latestHighlight(p).map(r => r.version), ['1.5.0']);
  // Several patches stack on top of the highlight.
  const stacked = [ext('1.4.2', 3, 'x'), ext('1.4.1', 3, 'x'), ext('1.4.0', 2, 'x'), ext('1.3.1', 3, 'x')];
  assert.deepEqual(W.latestHighlight(stacked).map(r => r.version), ['1.4.2', '1.4.1', '1.4.0']);
  // No level 1/2 release at all: just the newest one.
  assert.deepEqual(W.latestHighlight([ext('1.0.2', 3, 'x'), ext('1.0.1', 3, 'x')]).map(r => r.version), ['1.0.2']);
  assert.deepEqual(W.latestHighlight([]), []);
});

test('shouldShowMarker compares the newest level 1/2 release to the seen version', () => {
  const p = goodPayload();
  assert.equal(W.shouldShowMarker(p, '1.4.0'), true);
  assert.equal(W.shouldShowMarker(p, '1.1.0'), true);
  assert.equal(W.shouldShowMarker(p, '1.5.0'), false);
  // A patch on top of a seen highlight never brings the marker back.
  assert.equal(W.shouldShowMarker(p, '1.5.1'), false);
  // Missing or unreadable seen state shows it (users updating from 1.1.0 have no key).
  assert.equal(W.shouldShowMarker(p, undefined), true);
  assert.equal(W.shouldShowMarker(p, ''), true);
  assert.equal(W.shouldShowMarker(p, 'garbage'), true);
  // Nothing worth a marker.
  assert.equal(W.shouldShowMarker([ext('1.0.1', 3, 'x')], undefined), false);
  assert.equal(W.shouldShowMarker(null, undefined), false);
});

test('markerLabel, anchorFor and formatDate', () => {
  assert.equal(W.markerLabel('1.5.0'), 'New in 1.5');
  assert.equal(W.markerLabel(ext('2.0.0', 1, 'x')), 'New in 2.0');
  assert.equal(W.markerLabel('bad'), "What's new");
  assert.equal(W.anchorFor('1.5.0'), 'v1-5-0');
  assert.equal(W.anchorFor('1.10.2'), 'v1-10-2');
  assert.equal(W.anchorFor('web-2026-10-03-spoiler-library'), 'web-2026-10-03-spoiler-library');
  assert.equal(W.anchorFor(null), '');
  assert.equal(W.formatDate('2026-10-04'), 'Oct 4, 2026');
  assert.equal(W.formatDate('2026-01-23'), 'Jan 23, 2026');
  assert.equal(W.formatDate('2026-13-01'), '');
  assert.equal(W.formatDate(undefined), '');
});

test('groupChanges orders NEW, BETTER, FIXED and keeps privacy separate', () => {
  const { groups, privacy } = W.groupChanges([
    change('fixed', 'f1'), change('privacy', 'p1'), change('new', 'n1'),
    change('improved', 'i1'), change('new', 'n2'), change('bogus', 'x'), null, change('fixed', '  ')
  ]);
  assert.deepEqual(groups, [
    { type: 'new', label: 'NEW', items: ['n1', 'n2'] },
    { type: 'improved', label: 'BETTER', items: ['i1'] },
    { type: 'fixed', label: 'FIXED', items: ['f1'] }
  ]);
  assert.deepEqual(privacy, ['p1']);
  assert.deepEqual(W.groupChanges([change('new', 'n')]).groups.map(g => g.label), ['NEW']);
  assert.deepEqual(W.groupChanges(undefined), { groups: [], privacy: [] });
});

// ---- release-check.mjs ------------------------------------------------------

test('a good payload passes', () => {
  assert.deepEqual(validateReleases(goodPayload(), OPTS), []);
});

test('the shipped data/releases.json passes against manifest.json and package.json', () => {
  assert.deepEqual(runReleaseCheck({ root: ROOT }), []);
});

test('mismatched versions fail', () => {
  const errs = validateReleases(goodPayload(), { ...OPTS, packageVersion: '1.5.0' });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /version mismatch.*package\.json = 1\.5\.0/);

  const p = goodPayload();
  p.current = '1.5.0';
  assert.match(validateReleases(p, OPTS).join('\n'), /version mismatch/);
});

test('an em dash anywhere fails, with its location', () => {
  const p = goodPayload();
  p.releases[1].changes[0].text = 'Faster — much faster.';
  const errs = validateReleases(p, OPTS);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /releases\[1\]\.changes\[0\]\.text contains an em dash/);
  // En dashes in ranges are fine.
  p.releases[1].changes[0].text = 'Scores of 8–9.';
  assert.deepEqual(validateReleases(p, OPTS), []);
});

test('a level that does not match the version bump fails', () => {
  const p = goodPayload();
  p.releases[1].level = 3; // 1.4.0 -> 1.5.0 is a minor bump
  assert.match(validateReleases(p, OPTS).join('\n'), /1\.5\.0 is a minor bump from 1\.4\.0, so its level must be 2 \(found 3\)/);

  const q = goodPayload();
  q.releases[0].level = 2; // 1.5.0 -> 1.5.1 is a patch
  assert.match(validateReleases(q, OPTS).join('\n'), /1\.5\.1 is a patch bump.*must be 3/);

  // The oldest entry is exempt.
  const r = goodPayload();
  r.releases[r.releases.length - 1].level = 2;
  assert.deepEqual(validateReleases(r, OPTS), []);
});

test('a future date fails', () => {
  const p = goodPayload();
  p.releases[0].date = '2026-10-05';
  assert.match(validateReleases(p, OPTS).join('\n'), /2026-10-05 is in the future/);
});

test('ordering, website shape, summary length and dataFlows are enforced', () => {
  const swapped = goodPayload();
  [swapped.releases[3], swapped.releases[4]] = [swapped.releases[4], swapped.releases[3]];
  const swapErrs = validateReleases(swapped, OPTS).join('\n');
  assert.match(swapErrs, /newest first/);
  assert.match(swapErrs, /strictly decrease/);

  const dup = goodPayload();
  dup.releases.splice(1, 0, ext('1.5.1', 3, '2026-10-04', { id: '1.5.1-again' }));
  assert.match(validateReleases(dup, OPTS).join('\n'), /appears twice|id must equal/);

  const site = goodPayload();
  site.releases[2] = { ...site.releases[2], id: 'spoilers', version: '1.4.5', level: 2 };
  const siteErrs = validateReleases(site, OPTS).join('\n');
  assert.match(siteErrs, /"version": null/);
  assert.match(siteErrs, /"level": null/);
  assert.match(siteErrs, /must start with "web-"/);

  const long = goodPayload();
  long.releases[0].summary = 'x'.repeat(141);
  assert.match(validateReleases(long, OPTS).join('\n'), /summary is 141 characters/);

  const types = goodPayload();
  types.releases[0].changes = [{ type: 'security', text: 'x' }];
  assert.match(validateReleases(types, OPTS).join('\n'), /type must be new, improved, fixed or privacy/);

  const empty = goodPayload();
  empty.releases[0].changes = [];
  empty.releases[0].title = ' ';
  const emptyErrs = validateReleases(empty, OPTS).join('\n');
  assert.match(emptyErrs, /changes must be a non-empty array/);
  assert.match(emptyErrs, /title is empty/);

  const flows = goodPayload();
  flows.dataFlows[0].since = '1.1.0';
  assert.match(validateReleases(flows, OPTS).join('\n'), /since "1\.1\.0" is not an extension version/);

  const badId = goodPayload();
  badId.releases[0].id = 'v1.5.1';
  assert.match(validateReleases(badId, OPTS).join('\n'), /id must equal its version/);
});
