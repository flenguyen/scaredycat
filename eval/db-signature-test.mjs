/**
 * Unit tests for the download signature check in background/trust.js, using
 * Node's WebCrypto (Ed25519 in crypto.subtle) and the same message the
 * website signs (scared-cat-web lib/titles/sign.ts):
 *   UTF-8("scaredycat-sig-v1\n" + <name> + "\n") || <body bytes>
 * Also checks that db-version.js readCappedBytes keeps the raw bytes.
 *   node eval/db-signature-test.mjs
 * No network.
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash, sign as nodeSign, generateKeyPairSync } from 'node:crypto';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadClassic(rel) {
  const moduleObj = { exports: {} };
  new Function('module', 'self', fs.readFileSync(path.join(ROOT, rel), 'utf8'))(moduleObj, undefined);
  return moduleObj.exports;
}
const Trust = loadClassic('background/trust.js');
const DB = loadClassic('background/db-version.js');

const DB_URL = 'https://www.scaredycat.app/api/titles/horror-database.json';
const SYN_URL = 'https://www.scaredycat.app/api/titles/synopses.json';
const subtle = globalThis.crypto.subtle;

// The website signs with node:crypto; do the same here so the test checks
// the extension against the server's construction, not against itself.
function serverSign(privateKey, name, bodyText) {
  const msg = Buffer.concat([Buffer.from(`scaredycat-sig-v1\n${name}\n`, 'utf8'), Buffer.from(bodyText, 'utf8')]);
  return nodeSign(null, msg, privateKey).toString('base64');
}
function rawPublicB64(publicKey) {
  return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
}

const main = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const KEYS = { t1: rawPublicB64(main.publicKey) };

const dbText = JSON.stringify({ version: '1.9.0', titles: [{ title: 'Hereditary', year: 2018, variations: [] }] });
const synText = JSON.stringify({ version: 1, titles: [{ title: 'Hereditary', year: 2018, text: 'A family grieves.' }] });
const bytes = (s) => new TextEncoder().encode(s);

const verify = (url, header, body, opts = {}) =>
  Trust.verifyArtifact({ url, header, body: bytes(body) }, { keys: KEYS, required: true, subtle, ...opts });

test('the shipped trust map is empty and signatures are required', () => {
  // Fail closed until the production key is inserted before release. When a
  // key is added this test should be updated with it, on purpose.
  assert.equal(Trust.SIGNATURES_REQUIRED, true);
  for (const [kid, key] of Object.entries(Trust.TRUSTED_KEYS)) {
    assert.match(kid, /^[A-Za-z0-9_-]{1,16}$/);
    assert.equal(Buffer.from(key, 'base64').length, 32, `kid ${kid} must be 32 raw bytes`);
  }
});

test('message construction matches the server byte for byte', () => {
  const msg = Trust.signedMessage('horror-database.json', bytes(dbText));
  const expected = Buffer.concat([Buffer.from('scaredycat-sig-v1\nhorror-database.json\n'), Buffer.from(dbText)]);
  assert.deepEqual(Buffer.from(msg), expected);
  assert.throws(() => Trust.signedMessage('other.json', bytes('{}')));
});

test('artifact name comes from the fetched URL path', () => {
  assert.equal(Trust.artifactNameFromUrl(DB_URL), 'horror-database.json');
  assert.equal(Trust.artifactNameFromUrl(SYN_URL), 'synopses.json');
  assert.equal(Trust.artifactNameFromUrl(`${DB_URL}?x=synopses.json`), 'horror-database.json');
  assert.equal(Trust.artifactNameFromUrl('https://www.scaredycat.app/api/titles/other.json'), null);
  assert.equal(Trust.artifactNameFromUrl('not a url'), null);
});

test('a valid signature is accepted, for both files', async () => {
  const dbSig = serverSign(main.privateKey, 'horror-database.json', dbText);
  assert.deepEqual(await verify(DB_URL, `kid=t1;sig=${dbSig}`, dbText), { ok: true, kid: 't1' });
  const synSig = serverSign(main.privateKey, 'synopses.json', synText);
  assert.deepEqual(await verify(SYN_URL, `kid=t1;sig=${synSig}`, synText), { ok: true, kid: 't1' });
  // Non-ASCII bytes survive (titles carry accents).
  const accented = JSON.stringify({ version: '1.9.0', titles: [{ title: 'Alien³ – Déjà vu', variations: [] }] });
  const sig = serverSign(main.privateKey, 'horror-database.json', accented);
  assert.equal((await verify(DB_URL, `kid=t1;sig=${sig}`, accented)).ok, true);
});

test('a tampered body is rejected', async () => {
  const sig = serverSign(main.privateKey, 'horror-database.json', dbText);
  const tampered = dbText.replace('Hereditary', 'Paddington');
  assert.deepEqual(await verify(DB_URL, `kid=t1;sig=${sig}`, tampered), { ok: false, reason: 'bad-signature' });
  // One flipped byte at the end too.
  assert.equal((await verify(DB_URL, `kid=t1;sig=${sig}`, `${dbText} `)).ok, false);
});

test('a signature for the other file is rejected (no cross-artifact replay)', async () => {
  // The synopses signature over the very same bytes, served as the title list.
  const synSig = serverSign(main.privateKey, 'synopses.json', dbText);
  assert.deepEqual(await verify(DB_URL, `kid=t1;sig=${synSig}`, dbText), { ok: false, reason: 'bad-signature' });
  const dbSig = serverSign(main.privateKey, 'horror-database.json', synText);
  assert.equal((await verify(SYN_URL, `kid=t1;sig=${dbSig}`, synText)).ok, false);
});

test('a valid signature under the wrong kid is rejected', async () => {
  const sig = serverSign(main.privateKey, 'horror-database.json', dbText);
  // The kid is trusted, but it is a different key.
  const keys = { t1: rawPublicB64(rogue.publicKey), t2: KEYS.t1 };
  assert.deepEqual(await verify(DB_URL, `kid=t1;sig=${sig}`, dbText, { keys }), { ok: false, reason: 'bad-signature' });
  assert.deepEqual(await verify(DB_URL, `kid=t2;sig=${sig}`, dbText, { keys }), { ok: true, kid: 't2' });
});

test('an untrusted kid is rejected, even with a self-consistent signature', async () => {
  const sig = serverSign(rogue.privateKey, 'horror-database.json', dbText);
  assert.deepEqual(await verify(DB_URL, `kid=rogue;sig=${sig}`, dbText), { ok: false, reason: 'untrusted-kid' });
  for (const kid of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(await verify(DB_URL, `kid=${kid};sig=${sig}`, dbText), { ok: false, reason: 'untrusted-kid' }, kid);
  }
});

test('malformed headers are rejected', async () => {
  const sig = serverSign(main.privateKey, 'horror-database.json', dbText);
  const short = Buffer.alloc(63).toString('base64');
  const long = Buffer.alloc(65).toString('base64');
  const cases = [
    `sig=${sig};kid=t1`,                    // wrong order
    `kid=t1; sig=${sig}`,                   // extra space
    `kid=t1;sig=${sig};x=1`,                // trailing field
    `kid=;sig=${sig}`,                      // empty kid
    `kid=${'a'.repeat(17)};sig=${sig}`,     // kid too long
    `kid=t.1;sig=${sig}`,                   // kid charset
    `kid=t1;sig=${sig.replace(/==$/, '')}`, // unpadded
    `kid=t1;sig=${Buffer.from(sig, 'base64').toString('base64url')}`, // base64url alphabet
    `kid=t1;sig=${short}`,                  // 63 bytes
    `kid=t1;sig=${long}`,                   // 65 bytes
    'kid=t1',
    'garbage'
  ];
  for (const header of cases) {
    assert.deepEqual(await verify(DB_URL, header, dbText), { ok: false, reason: 'malformed-signature' }, header);
  }
  assert.equal(Trust.parseSignatureHeader(`kid=t1;sig=${sig}`).sig.length, 64);
  assert.equal(Trust.parseSignatureHeader(null), null);
});

test('a missing header is rejected', async () => {
  assert.deepEqual(await verify(DB_URL, null, dbText), { ok: false, reason: 'missing-signature' });
  assert.deepEqual(await verify(DB_URL, '', dbText), { ok: false, reason: 'missing-signature' });
});

test('an empty trust map rejects everything, even a valid signature', async () => {
  const sig = serverSign(main.privateKey, 'horror-database.json', dbText);
  for (const required of [true, false]) {
    assert.deepEqual(await verify(DB_URL, `kid=t1;sig=${sig}`, dbText, { keys: {}, required }),
      { ok: false, reason: 'no-trusted-keys' });
    assert.deepEqual(await verify(DB_URL, null, dbText, { keys: {}, required }),
      { ok: false, reason: 'no-trusted-keys' });
  }
  // The shipped defaults (no options) behave the same while the map is empty.
  if (!Object.keys(Trust.TRUSTED_KEYS).length) {
    assert.deepEqual(await Trust.verifyArtifact({ url: DB_URL, header: `kid=t1;sig=${sig}`, body: bytes(dbText) }),
      { ok: false, reason: 'no-trusted-keys' });
  }
});

test('canAcceptRemote is false and warns exactly once with no keys', () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    assert.equal(Trust.canAcceptRemote({}), false);
    assert.equal(Trust.canAcceptRemote({}), false);
    assert.equal(Trust.canAcceptRemote(KEYS), true);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no signing keys/);
});

test('the unsigned policy only relaxes a missing header, never a bad one', async () => {
  assert.deepEqual(await verify(DB_URL, null, dbText, { required: false }), { ok: true, kid: null });
  const sig = serverSign(main.privateKey, 'synopses.json', dbText);
  assert.equal((await verify(DB_URL, `kid=t1;sig=${sig}`, dbText, { required: false })).ok, false);
});

test('a trusted entry that is not a 32-byte key is never usable', async () => {
  const sig = serverSign(main.privateKey, 'horror-database.json', dbText);
  const keys = { t1: Buffer.alloc(31).toString('base64') };
  assert.deepEqual(await verify(DB_URL, `kid=t1;sig=${sig}`, dbText, { keys }), { ok: false, reason: 'bad-trusted-key' });
});

test('an unknown URL is rejected before any crypto', async () => {
  const sig = serverSign(main.privateKey, 'horror-database.json', dbText);
  assert.deepEqual(await verify('https://www.scaredycat.app/api/titles/x.json', `kid=t1;sig=${sig}`, dbText),
    { ok: false, reason: 'unknown-artifact' });
});

test('readCappedBytes returns the exact bytes, and the cap still holds', async () => {
  const text = JSON.stringify({ t: 'Déjà vu ³' });
  const res = new Response(text, { headers: { 'Content-Type': 'application/json' } });
  const got = await DB.readCappedBytes(res);
  assert.equal(createHash('sha256').update(got).digest('hex'), createHash('sha256').update(text, 'utf8').digest('hex'));
  const big = new Response('x'.repeat(DB.MAX_BODY_BYTES + 1));
  assert.equal(await DB.readCappedBytes(big), null);
  // And the verified path works on what readCappedBytes returned.
  const sig = serverSign(main.privateKey, 'horror-database.json', text);
  const verdict = await Trust.verifyArtifact({ url: DB_URL, header: `kid=t1;sig=${sig}`, body: got },
    { keys: KEYS, subtle });
  assert.equal(verdict.ok, true);
});
