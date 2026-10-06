/**
 * Checks for the welcome page's shared copy (data/welcome.json):
 *   node eval/welcome-test.mjs
 *
 * welcome/welcome.js renders this file in the extension, and
 * scaredycat.app/welcome renders the same file from main, so a missing key or
 * a banned character breaks both pages at once. Run by `npm run eval`.
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const copy = JSON.parse(read('data/welcome.json'));
const script = read('welcome/welcome.js');

function leaves(value, at = 'copy', out = []) {
  if (typeof value === 'string') out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, `${at}.${k}`, out);
  }
  return out;
}

test('schema version is 1', () => {
  assert.equal(copy.schema, 1);
});

test('every copy path the script reads exists', () => {
  const paths = new Set(script.match(/\bcopy(?:\.[A-Za-z]+)+/g));
  assert.ok(paths.size > 20, 'expected the script to read the copy');
  for (const p of paths) {
    const value = p.split('.').slice(1).reduce((o, k) => (o == null ? o : o[k]), copy);
    assert.notEqual(value, undefined, `${p} is missing from data/welcome.json`);
  }
});

test('fixed-length lists match the page layout', () => {
  assert.equal(copy.mistake.steps.length, 3, 'mistake.steps drives three how-to rows');
  assert.equal(copy.loop.cards.length, 3, 'loop.cards drives three cards');
  assert.ok(copy.note.categories.length >= 1);
  for (const c of copy.note.categories) assert.ok(c.id && c.label);
});

test('demo copy the script reads through aliases', () => {
  for (const k of ['posterArt', 'posterTitle', 'year', 'synopsis', 'revealToast']) assert.ok(copy.see.demo[k], `see.demo.${k}`);
  for (const k of ['posterArt', 'posterTitle', 'reportToast']) assert.ok(copy.mistake.demo[k], `mistake.demo.${k}`);
  for (const k of ['posterArt', 'posterTitle', 'reportToast', 'undoToast']) assert.ok(copy.missed.demo[k], `missed.demo.${k}`);
  for (const k of ['empty', 'sent', 'queued', 'deduped', 'rateLimited', 'failed', 'declined']) assert.ok(copy.note.status[k], `note.status.${k}`);
});

test('no empty strings, no em dashes, balanced bold markers', () => {
  for (const [at, text] of leaves(copy)) {
    assert.ok(text.trim(), `${at} is empty`);
    assert.ok(!text.includes('—'), `${at} has an em dash`);
    assert.ok(!/\bthe cat\b/i.test(text), `${at} says "the cat"; the mascot is Scaredy Cat`);
    assert.equal((text.match(/\*\*/g) || []).length % 2, 0, `${at} has an unclosed **`);
  }
});

test('the tip jar is a plain on/off flag', () => {
  assert.equal(typeof copy.band.tip.enabled, 'boolean', 'band.tip.enabled must be true or false');
});

test('links are absolute https or site-relative', () => {
  // Checked even while the tip is off, so turning it back on is one flag.
  assert.match(copy.band.tip.url, /^https:\/\//);
  assert.match(copy.footer.tmdbHref, /^https:\/\//);
  assert.match(copy.band.webInstallHref, /^(\/|https:\/\/)/);
});

test('the shared page files carry no em dashes', () => {
  for (const rel of ['welcome/welcome.html', 'welcome/welcome.css', 'welcome/welcome.js']) {
    assert.ok(!read(rel).includes('—'), `${rel} has an em dash`);
  }
});
