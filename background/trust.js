/**
 * Scaredy Cat - Signature check for downloaded lists
 * The title list and the spoiler summaries are downloaded from scaredycat.app
 * every 6 hours (db-updater.js). The website signs both files with an Ed25519
 * key that lives only in its server settings, and sends the signature as
 *
 *   X-Scaredy-Signature: kid=<kid>;sig=<standard base64 of 64 bytes>
 *
 * The signed message is
 *
 *   UTF-8("scaredycat-sig-v1\n" + <name> + "\n") || <body bytes>
 *
 * where <name> is "horror-database.json" or "synopses.json", taken from the
 * URL the worker fetched (never from the response), and the body bytes are
 * exactly what `res.arrayBuffer()` returns. The name keeps a signature for
 * one file from being replayed as the other. The check runs on the raw bytes
 * before anything is decoded or parsed, so a leaked storage token or a
 * compromised website can't feed the extension a list we didn't sign.
 *
 * Policy (fail closed):
 * - With SIGNATURES_REQUIRED, a download without a valid signature from a
 *   kid in TRUSTED_KEYS is refused, and the last good copy stays in use.
 * - With an empty TRUSTED_KEYS, every download is refused whatever the
 *   other setting says. The extension then runs on the list it shipped with
 *   (or the copy already stored), and the worker says so once per life with
 *   console.warn.
 * The list bundled inside the extension package is not signed and doesn't
 * need to be: Chrome already verifies the package.
 *
 * Pure apart from crypto.subtle (unit-tested in eval/db-signature-test.mjs
 * with Node's WebCrypto). Loaded into the service worker via importScripts.
 */

const ScaredyCatTrust = (function () {
  'use strict';

  // Public keys the extension accepts, by kid: the standard base64 of the raw
  // 32-byte Ed25519 public key (what scared-cat-web's gen-signing-key script
  // prints as the public key, and Signer.publicKeyBase64).
  //
  // PRODUCTION KEYS GO HERE before a release, one line per kid, for example
  //   '1': 'base64-of-32-bytes=',
  // Keep the old kid listed while the website rotates to a new one. While this
  // map is empty, no downloaded list is ever accepted (see the policy above).
  // eval/browser-smoke-remote-db.mjs rewrites this object in a temporary copy
  // of the extension; it never edits this file.
  const TRUSTED_KEYS = Object.freeze({
  });

  // Keep true. False would accept downloads that carry no signature at all
  // (a present but bad signature is refused either way); it exists only so
  // the policy is spelled out in one place.
  const SIGNATURES_REQUIRED = true;

  const SIGNATURE_HEADER = 'X-Scaredy-Signature';
  const CONTEXT = 'scaredycat-sig-v1';
  const ARTIFACT_NAMES = Object.freeze(['horror-database.json', 'synopses.json']);
  const HEADER_RE = /^kid=([A-Za-z0-9_-]{1,16});sig=([A-Za-z0-9+/]{86}==)$/;
  const KEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;
  const SIG_BYTES = 64;
  const KEY_BYTES = 32;

  let warnedNoKeys = false;
  // base64 public key -> Promise<CryptoKey|null>, imported once per worker life.
  const keyCache = new Map();

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * { kid, sig: Uint8Array(64) } from a header value, or null unless it is
   * exactly `kid=<kid>;sig=<base64 of 64 bytes>`.
   */
  function parseSignatureHeader(value) {
    if (typeof value !== 'string') return null;
    const m = HEADER_RE.exec(value.trim());
    if (!m) return null;
    let sig;
    try {
      sig = base64ToBytes(m[2]);
    } catch (e) {
      return null;
    }
    if (sig.length !== SIG_BYTES) return null;
    return { kid: m[1], sig };
  }

  /** "horror-database.json" / "synopses.json" from the fetched URL, else null. */
  function artifactNameFromUrl(url) {
    let path;
    try {
      path = new URL(url).pathname;
    } catch (e) {
      return null;
    }
    const name = path.slice(path.lastIndexOf('/') + 1);
    return ARTIFACT_NAMES.includes(name) ? name : null;
  }

  /** prefix || body, the exact bytes the website signs. */
  function signedMessage(name, body) {
    if (!ARTIFACT_NAMES.includes(name)) throw new Error(`unknown artifact ${name}`);
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    const prefix = new TextEncoder().encode(`${CONTEXT}\n${name}\n`);
    const out = new Uint8Array(prefix.length + bytes.length);
    out.set(prefix, 0);
    out.set(bytes, prefix.length);
    return out;
  }

  function importKey(b64, subtle) {
    const cacheKey = b64;
    if (!keyCache.has(cacheKey)) {
      let promise;
      if (typeof b64 !== 'string' || !KEY_B64_RE.test(b64)) {
        promise = Promise.resolve(null);
      } else {
        const raw = base64ToBytes(b64);
        promise = raw.length !== KEY_BYTES
          ? Promise.resolve(null)
          : subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']).catch(() => null);
      }
      keyCache.set(cacheKey, promise);
    }
    return keyCache.get(cacheKey);
  }

  function trustedKids(keys) {
    return Object.keys(keys || {}).filter(kid => typeof keys[kid] === 'string');
  }

  /**
   * Whether downloads can be accepted at all. False (with one console.warn
   * per worker life) when no key is built in, so the caller can skip the
   * download instead of fetching bytes it would refuse.
   */
  function canAcceptRemote(keys = TRUSTED_KEYS) {
    if (trustedKids(keys).length) return true;
    if (!warnedNoKeys) {
      warnedNoKeys = true;
      console.warn('Scaredy Cat: no signing keys are built in (background/trust.js TRUSTED_KEYS is empty). ' +
        'Title list and summary downloads are refused; the list that shipped with the extension, ' +
        'or the copy already stored, stays in use.');
    }
    return false;
  }

  /**
   * Check one downloaded file. `url` is the URL the worker requested,
   * `header` the X-Scaredy-Signature value (or null), `body` the raw bytes.
   * Resolves { ok: true, kid } or { ok: false, reason }. Never throws.
   */
  async function verifyArtifact({ url, header, body }, {
    keys = TRUSTED_KEYS,
    required = SIGNATURES_REQUIRED,
    subtle = globalThis.crypto && globalThis.crypto.subtle
  } = {}) {
    try {
      if (!trustedKids(keys).length) return { ok: false, reason: 'no-trusted-keys' };
      const name = artifactNameFromUrl(url);
      if (!name) return { ok: false, reason: 'unknown-artifact' };
      if (header == null || header === '') {
        return required ? { ok: false, reason: 'missing-signature' } : { ok: true, kid: null };
      }
      const parsed = parseSignatureHeader(header);
      if (!parsed) return { ok: false, reason: 'malformed-signature' };
      if (!Object.prototype.hasOwnProperty.call(keys, parsed.kid) || typeof keys[parsed.kid] !== 'string') {
        return { ok: false, reason: 'untrusted-kid' };
      }
      if (!subtle) return { ok: false, reason: 'no-webcrypto' };
      const key = await importKey(keys[parsed.kid], subtle);
      if (!key) return { ok: false, reason: 'bad-trusted-key' };
      const valid = await subtle.verify('Ed25519', key, parsed.sig, signedMessage(name, body));
      return valid ? { ok: true, kid: parsed.kid } : { ok: false, reason: 'bad-signature' };
    } catch (e) {
      return { ok: false, reason: 'verify-error' };
    }
  }

  return {
    TRUSTED_KEYS,
    SIGNATURES_REQUIRED,
    SIGNATURE_HEADER,
    ARTIFACT_NAMES,
    parseSignatureHeader,
    artifactNameFromUrl,
    signedMessage,
    canAcceptRemote,
    verifyArtifact
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatTrust;
}
