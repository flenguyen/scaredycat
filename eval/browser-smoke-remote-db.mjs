/**
 * Smoke test for the periodic remote refresh (background/db-updater.js) and
 * its signature check (background/trust.js), fully offline.
 *
 * A local HTTPS server stands in for www.scaredycat.app (Chrome maps the
 * host to localhost and ignores the self-signed certificate; every other
 * scaredycat.app host doesn't resolve). It serves the title list and the
 * summaries signed, unsigned, tampered, signed for the other file, signed by
 * an untrusted kid, signed by the wrong key under a trusted kid, and with a
 * malformed header. Nothing is ever sent to the real website.
 *
 * Part 1 runs a temporary copy of the extension whose trust.js holds a test
 * key generated for this run (the real background/trust.js is never edited,
 * and the test checks that). Starting from copies stored by an older
 * version (unsigned), it checks:
 *   - unsigned and every bad signature: refused, the older copy stays in use
 *   - signed: stored with its ETag; the next request revalidates with
 *     If-None-Match and a 304 keeps it
 *   - a tampered list after that keeps the signed copy
 *   - the same for synopses.json, with GET_SYNOPSIS answering from the result
 * Part 2 runs the real extension (empty trust map): refresh() makes no
 * request at all, stored copies stay, and even a validly signed body is
 * refused.
 *
 *   SC_CHROME_BIN=<chrome-for-testing> npm run smoke:remote-db
 * Requires: npm install --no-save puppeteer-core, and openssl on PATH.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { extensionArgs } from './browser-smoke-lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SC_CHROME_BIN;
if (!CHROME) throw new Error('SC_CHROME_BIN not set');

const HOST = 'www.scaredycat.app';
const DB_PATH = '/api/titles/horror-database.json';
const SYN_PATH = '/api/titles/synopses.json';
const KID = 'smoke';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const rawPublicB64 = (publicKey) => Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
// Exactly what scared-cat-web lib/titles/sign.ts signs.
const signFor = (privateKey, name, body) =>
  nodeSign(null, Buffer.concat([Buffer.from(`scaredycat-sig-v1\n${name}\n`), Buffer.from(body)]), privateKey).toString('base64');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-remote-db-'));
const failures = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

// ---- Keys, certificate, extension copy ---------------------------------------

const main = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');

const certFile = path.join(TMP, 'cert.pem');
const keyFile = path.join(TMP, 'key.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
  '-keyout', keyFile, '-out', certFile, '-days', '1',
  '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`
], { stdio: 'ignore' });

const TRUST_FILE = path.join(ROOT, 'background/trust.js');
const trustBefore = sha256(fs.readFileSync(TRUST_FILE));
const EXT = path.join(TMP, 'ext');
// Everything the worker needs; models/ and vendor/ (the image check) aren't.
for (const entry of ['manifest.json', 'background.js', 'background', 'content', 'offscreen', 'popup',
  'welcome', 'styles', 'fonts', 'data', 'icons']) {
  fs.cpSync(path.join(ROOT, entry), path.join(EXT, entry), { recursive: true });
}
const trustSrc = fs.readFileSync(path.join(EXT, 'background/trust.js'), 'utf8');
const TRUST_RE = /const TRUSTED_KEYS = Object\.freeze\(\{[\s\S]*?\}\);/;
if (!TRUST_RE.test(trustSrc)) throw new Error('trust.js: TRUSTED_KEYS literal not found');
fs.writeFileSync(path.join(EXT, 'background/trust.js'), trustSrc.replace(TRUST_RE,
  `const TRUSTED_KEYS = Object.freeze({ ${JSON.stringify(KID)}: ${JSON.stringify(rawPublicB64(main.publicKey))} });`));

// ---- Payloads -------------------------------------------------------------------

const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/horror-database.json'), 'utf8'));
const bump = (v, n) => v.split('.').map((x, i, a) => (i === a.length - 1 ? String(Number(x) + n) : x)).join('.');
const withMarker = (version, marker) => ({
  ...bundled,
  version,
  lastUpdated: '2026-10-05',
  titles: [...bundled.titles, { title: marker, year: 2001, variations: [], definite: true }]
});
const legacyDb = withMarker(bump(bundled.version, 1), 'Smoke Legacy Marker');
const signedDbText = JSON.stringify(withMarker(bump(bundled.version, 2), 'Smoke Signed Marker'));
const synEntry = (title, text) => ({ title, year: 2001, names: [], text });
const legacySyn = { version: 1, titles: [synEntry('Smoke Legacy Film', 'Legacy summary.')] };
const signedSynText = JSON.stringify({ version: 1, titles: [synEntry('Smoke Signed Film', 'Signed summary.')] });

/** One served variant of a file: body, ETag, X-Scaredy-Signature. */
function variant(name, body, mode) {
  const other = name === 'synopses.json' ? 'horror-database.json' : 'synopses.json';
  const good = signFor(main.privateKey, name, body);
  switch (mode) {
    case 'signed': return { body, etag: `"${sha256(body)}.${KID}"`, sig: `kid=${KID};sig=${good}` };
    case 'unsigned': return { body, etag: `"${sha256(body)}"`, sig: null };
    case 'tampered': {
      const t = body.replace(/Smoke Signed (Marker|Film)/, 'Smoke Tampered $1');
      return { body: t, etag: `"${sha256(t)}.${KID}"`, sig: `kid=${KID};sig=${good}` };
    }
    case 'other-file': return { body, etag: `"${sha256(body)}.x1"`, sig: `kid=${KID};sig=${signFor(main.privateKey, other, body)}` };
    case 'untrusted-kid': return { body, etag: `"${sha256(body)}.x2"`, sig: `kid=rogue;sig=${signFor(rogue.privateKey, name, body)}` };
    case 'wrong-key': return { body, etag: `"${sha256(body)}.x3"`, sig: `kid=${KID};sig=${signFor(rogue.privateKey, name, body)}` };
    case 'malformed': return { body, etag: `"${sha256(body)}.x4"`, sig: `kid=${KID};sig=${good.slice(0, -4)}` };
    default: throw new Error(mode);
  }
}

// ---- Local stand-in for www.scaredycat.app -------------------------------------------

const served = { [DB_PATH]: null, [SYN_PATH]: null };
const hits = [];
const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
  const art = served[req.url];
  const hit = { path: req.url, method: req.method, ifNoneMatch: req.headers['if-none-match'] || null, status: 404 };
  hits.push(hit);
  if (!art) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  const headers = { 'content-type': 'application/json; charset=utf-8', etag: art.etag, 'cache-control': 'no-cache' };
  if (art.sig) headers['x-scaredy-signature'] = art.sig;
  if (hit.ifNoneMatch && hit.ifNoneMatch === art.etag) {
    hit.status = 304;
    res.writeHead(304, headers);
    res.end();
    return;
  }
  hit.status = 200;
  res.writeHead(200, headers);
  res.end(art.body);
});
// All interfaces: Chrome for Testing on macOS refuses the 127.0.0.1 literal
// (ERR_ADDRESS_INVALID) but reaches `localhost`.
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

function launch(extDir) {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    args: extensionArgs(extDir, [
      `--host-resolver-rules=MAP ${HOST} localhost:${PORT}, MAP *.scaredycat.app ~NOTFOUND, MAP scaredycat.app ~NOTFOUND`,
      '--ignore-certificate-errors',
      '--window-size=800,600'
    ])
  });
}

async function workerOf(browser) {
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
  const worker = await swTarget.worker();
  // Let background.js's install-time seed land first.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await worker.evaluate(async () => !!(await chrome.storage.local.get('horrorDatabase')).horrorDatabase)) break;
    await new Promise(r => setTimeout(r, 200));
  }
  return worker;
}

// Runs one refresh in the worker and returns what is stored afterwards.
async function refreshDb(worker) {
  return worker.evaluate(async () => {
    await chrome.alarms.clear(ScaredyCatDBUpdater.ALARM_NAME);
    await ScaredyCatDBUpdater.refreshDatabase();
    const s = await chrome.storage.local.get(['horrorDatabase', 'horrorDatabaseEtag', 'horrorDatabaseFetchedAt']);
    return {
      version: s.horrorDatabase?.version ?? null,
      markers: (s.horrorDatabase?.titles || []).map(t => t.title).filter(t => t.startsWith('Smoke ')),
      etag: s.horrorDatabaseEtag ?? null,
      fetchedAt: s.horrorDatabaseFetchedAt ?? null
    };
  });
}
async function refreshSyn(worker) {
  return worker.evaluate(async () => {
    await chrome.alarms.clear(ScaredyCatDBUpdater.ALARM_NAME);
    await ScaredyCatDBUpdater.refreshSynopses();
    const s = await chrome.storage.local.get(['synopses', 'synopsesEtag', 'synopsesFetchedAt']);
    const t = s.synopses?.titles?.[0];
    const answer = t ? await ScaredyCatSynopses.handleRequest({ title: t.title, year: t.year }) : null;
    return {
      titles: (s.synopses?.titles || []).map(e => e.title),
      answer: answer?.text ?? null,
      etag: s.synopsesEtag ?? null,
      fetchedAt: s.synopsesFetchedAt ?? null
    };
  });
}

const lastHit = (p) => [...hits].reverse().find(h => h.path === p) || null;
const BAD_MODES = ['unsigned', 'tampered', 'other-file', 'untrusted-kid', 'wrong-key', 'malformed'];

try {
  // ---- Part 1: test key trusted ----------------------------------------------------
  console.log(`local ${HOST} on localhost:${PORT}; extension copy in ${EXT}`);
  let browser = await launch(EXT);
  try {
    const worker = await workerOf(browser);
    // Copies stored by an older, unsigned-era version.
    await worker.evaluate(async (db, syn) => {
      await chrome.alarms.clear(ScaredyCatDBUpdater.ALARM_NAME);
      await chrome.storage.local.set({
        horrorDatabase: db, horrorDatabaseEtag: '"legacy-unsigned"', horrorDatabaseFetchedAt: 1,
        synopses: syn, synopsesEtag: '"legacy-syn"', synopsesFetchedAt: 1
      });
    }, legacyDb, legacySyn);

    // The worker reaches the stand-in (host mapping + certificate).
    const probe = await worker.evaluate(async (url) => {
      try {
        return `HTTP ${(await fetch(url, { cache: 'no-store' })).status}`;
      } catch (e) {
        return `${e.name}: ${e.message}`;
      }
    }, `https://${HOST}/probe`);
    check('the worker reaches the local stand-in', probe === 'HTTP 404', probe);
    if (probe !== 'HTTP 404') throw new Error(`stand-in unreachable: ${probe}`);
    hits.length = 0;

    console.log('\ntitle list');
    for (const mode of BAD_MODES) {
      served[DB_PATH] = variant('horror-database.json', signedDbText, mode);
      const s = await refreshDb(worker);
      const h = lastHit(DB_PATH);
      check(`${mode}: refused, the older stored copy stays`,
        h?.status === 200 && s.markers.join() === 'Smoke Legacy Marker' && s.version === legacyDb.version
          && s.etag === '"legacy-unsigned"' && s.fetchedAt === 1,
        `served ${h?.status}, stored v${s.version} ${s.markers.join()} etag ${s.etag}`);
    }
    check('the first request revalidated the older copy with its ETag',
      hits.find(h => h.path === DB_PATH)?.ifNoneMatch === '"legacy-unsigned"');

    served[DB_PATH] = variant('horror-database.json', signedDbText, 'signed');
    const signed = await refreshDb(worker);
    check('signed: stored', signed.markers.join() === 'Smoke Signed Marker' && signed.version === bump(bundled.version, 2),
      `v${signed.version} ${signed.markers.join()}`);
    check('signed: ETag stored', signed.etag === served[DB_PATH].etag, signed.etag);
    check('signed: fetchedAt set', typeof signed.fetchedAt === 'number' && signed.fetchedAt > 1);

    const again = await refreshDb(worker);
    const h304 = lastHit(DB_PATH);
    check('second request sent If-None-Match and got 304', h304.ifNoneMatch === signed.etag && h304.status === 304,
      `${h304.ifNoneMatch} -> ${h304.status}`);
    check('304 changed nothing', again.fetchedAt === signed.fetchedAt && again.markers.join() === 'Smoke Signed Marker');

    served[DB_PATH] = variant('horror-database.json', signedDbText, 'tampered');
    const afterTamper = await refreshDb(worker);
    check('tampered after signed: the signed copy stays',
      lastHit(DB_PATH).status === 200 && afterTamper.markers.join() === 'Smoke Signed Marker' && afterTamper.etag === signed.etag);

    console.log('\nsynopses');
    for (const mode of ['unsigned', 'tampered', 'other-file', 'untrusted-kid', 'malformed']) {
      served[SYN_PATH] = variant('synopses.json', signedSynText, mode);
      const s = await refreshSyn(worker);
      check(`${mode}: refused, the older summaries stay and still answer`,
        lastHit(SYN_PATH)?.status === 200 && s.titles.join() === 'Smoke Legacy Film'
          && s.answer === 'Legacy summary.' && s.etag === '"legacy-syn"',
        `${s.titles.join()} etag ${s.etag}`);
    }
    served[SYN_PATH] = variant('synopses.json', signedSynText, 'signed');
    const synSigned = await refreshSyn(worker);
    check('signed: stored and GET_SYNOPSIS answers from it',
      synSigned.titles.join() === 'Smoke Signed Film' && synSigned.answer === 'Signed summary.', synSigned.titles.join());
    check('signed: ETag stored', synSigned.etag === served[SYN_PATH].etag);
    await new Promise(r => setTimeout(r, 20)); // so the bumped fetchedAt is a later millisecond
    const synAgain = await refreshSyn(worker);
    check('second request is a 304 that only bumps fetchedAt',
      lastHit(SYN_PATH).status === 304 && synAgain.fetchedAt > synSigned.fetchedAt && synAgain.titles.join() === 'Smoke Signed Film',
      `${lastHit(SYN_PATH).ifNoneMatch} -> ${lastHit(SYN_PATH).status}, fetchedAt ${synSigned.fetchedAt} -> ${synAgain.fetchedAt}`);
  } finally {
    await browser.close();
  }

  // ---- Part 2: the real extension, empty trust map ------------------------------------
  console.log('\nreal extension (no keys in trust.js)');
  served[DB_PATH] = variant('horror-database.json', signedDbText, 'signed');
  served[SYN_PATH] = variant('synopses.json', signedSynText, 'signed');
  const hitsBefore = hits.length;
  browser = await launch(ROOT);
  try {
    const worker = await workerOf(browser);
    const sig = served[DB_PATH].sig;
    const result = await worker.evaluate(async (body, header) => {
      await chrome.alarms.clear(ScaredyCatDBUpdater.ALARM_NAME);
      const before = await chrome.storage.local.get(['horrorDatabase', 'horrorDatabaseEtag', 'synopses']);
      await ScaredyCatDBUpdater.refresh();
      const after = await chrome.storage.local.get(['horrorDatabase', 'horrorDatabaseEtag', 'synopses']);
      const verdict = await ScaredyCatTrust.verifyArtifact({
        url: ScaredyCatDBUpdater.REMOTE_URL, header, body: new TextEncoder().encode(body)
      });
      return {
        keys: Object.keys(ScaredyCatTrust.TRUSTED_KEYS).length,
        required: ScaredyCatTrust.SIGNATURES_REQUIRED,
        canAccept: ScaredyCatTrust.canAcceptRemote(),
        sameDb: JSON.stringify(before.horrorDatabase) === JSON.stringify(after.horrorDatabase),
        version: after.horrorDatabase?.version,
        etag: after.horrorDatabaseEtag ?? null,
        synopses: after.synopses ? after.synopses.titles.length : 0,
        verdict
      };
    }, signedDbText, sig);
    if (result.keys > 0) {
      console.log(`  SKIP  trust.js ships ${result.keys} key(s); the empty-map checks don't apply`);
    } else {
      check('signatures required', result.required === true);
      check('canAcceptRemote() is false', result.canAccept === false);
      check('refresh() made no request', hits.length === hitsBefore, `${hits.length - hitsBefore} request(s)`);
      check('the bundled list stays stored', result.sameDb && result.version === bundled.version && result.etag === null,
        `v${result.version}`);
      check('no summaries stored', result.synopses === 0);
      check('a validly signed body is still refused', result.verdict.ok === false && result.verdict.reason === 'no-trusted-keys',
        JSON.stringify(result.verdict));
    }
  } finally {
    await browser.close();
  }

  check('background/trust.js was not modified', sha256(fs.readFileSync(TRUST_FILE)) === trustBefore);
  const stray = hits.filter(h => h.path !== DB_PATH && h.path !== SYN_PATH);
  check('no other requests reached the stand-in host', !stray.length, stray.map(h => h.path).join(', '));

  console.log(`\nSMOKE remote-db ${failures.length ? 'FAIL' : 'PASS'}`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
