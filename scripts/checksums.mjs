/**
 * vendor/CHECKSUMS.sha256: the pinned sha256 of every vendored runtime file
 * and every shipped model file. Shared by scripts/pack.mjs (refuses to build
 * on a mismatch) and eval/setup-model.mjs (verifies downloads, --verify).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CHECKSUMS_FILE = 'vendor/CHECKSUMS.sha256';

/** Files that must be listed: vendor/* (but the list itself) and models' json + onnx. */
export function isChecksummed(rel) {
  return (/^vendor\/[^/]+$/.test(rel) && rel !== CHECKSUMS_FILE)
    || /^models\/.+\.(onnx|json)$/.test(rel);
}

export function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/** Map of repo-relative path -> expected hex digest. */
export function readChecksums(root) {
  const map = new Map();
  const text = fs.readFileSync(path.join(root, CHECKSUMS_FILE), 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(t);
    if (!m) throw new Error(`${CHECKSUMS_FILE}: bad line "${t}"`);
    map.set(m[2], m[1]);
  }
  return map;
}

/**
 * Compare `files` (repo-relative) against the list. Returns error strings:
 * a checksummed file that isn't listed, a digest mismatch, or a listed file
 * that is missing on disk.
 */
export function verifyChecksums(root, files) {
  const errors = [];
  let expected;
  try {
    expected = readChecksums(root);
  } catch (e) {
    return [`cannot read ${CHECKSUMS_FILE}: ${e.message}`];
  }
  for (const rel of files.filter(isChecksummed)) {
    const want = expected.get(rel);
    if (!want) { errors.push(`${rel}: not listed in ${CHECKSUMS_FILE}`); continue; }
    const got = sha256File(path.join(root, rel));
    if (got !== want) errors.push(`${rel}: sha256 ${got} does not match ${CHECKSUMS_FILE} (${want})`);
  }
  for (const rel of expected.keys()) {
    if (!fs.existsSync(path.join(root, rel))) errors.push(`${rel}: listed in ${CHECKSUMS_FILE} but missing`);
  }
  return errors;
}
