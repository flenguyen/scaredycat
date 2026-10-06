/**
 * Keeps TMDB content out of the eval and tooling scripts:
 *   node eval/tmdb-rule-test.mjs
 *
 * TMDB's API terms count "training or validating a machine learning or
 * artificial intelligence system" with TMDB content as commercial use, which
 * the free licence does not allow. So no tracked file under eval/, scripts/ or
 * tools/ may fetch from a TMDB host. The only exceptions are unit tests that
 * use image.tmdb.org URLs as plain strings to check URL handling; they fetch
 * nothing and score nothing. Run by `npm run eval`.
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SELF = 'eval/tmdb-rule-test.mjs';

// URL-parsing unit tests: TMDB URLs as strings, never fetched or scored.
const URL_STRING_TESTS = new Set([
  'eval/allowlist-test.mjs',
  'eval/guards-test.mjs',
  'eval/image-key-test.mjs'
]);

// A fetchable TMDB address: the site, its API or its image CDN.
const TMDB_URL = /https?:\/\/(?:[a-z0-9-]+\.)*(?:themoviedb\.org|tmdb\.org)\b/i;

const tracked = execFileSync('git', ['ls-files', '-z', 'eval', 'scripts', 'tools'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

test('the scan covers the eval scripts', () => {
  assert.ok(tracked.includes('eval/decode-compare.mjs'), 'git ls-files found no eval scripts');
});

test('no eval or tooling script fetches from TMDB', () => {
  const offenders = [];
  for (const rel of tracked) {
    if (rel === SELF || URL_STRING_TESTS.has(rel)) continue;
    const file = path.join(ROOT, rel);
    if (!fs.statSync(file).isFile()) continue;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue; // binary (models, images)
    if (TMDB_URL.test(buf.toString('utf8'))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `TMDB URLs in: ${offenders.join(', ')}. TMDB images and pages must not be used to check or train the model.`);
});

test('the URL-string tests still only parse strings', () => {
  for (const rel of URL_STRING_TESTS) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/\bfetch\(|\bcurl\b|puppeteer|node:https?'/.test(src), `${rel} now fetches; move its TMDB URLs to a non-TMDB host`);
  }
});
