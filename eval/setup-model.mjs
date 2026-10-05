/**
 * Dev setup and integrity check for the shipped image model and the vendored
 * runtime. Driven by models/image-model.json (written by
 * eval/bakeoff/promote.mjs; runbook in models/README.md).
 *
 * Two model locations:
 *   models/<dir>/                 what the extension ships: exactly the files
 *                                 the manifest lists. The .onnx files are in
 *                                 Git LFS (`git lfs pull` after a clone).
 *   eval/.model-cache/bakeoff/<dir>/
 *                                 dev-only: the fp32 vision tower (baseline
 *                                 for eval/fp16-compare.mjs), the text tower
 *                                 and tokenizer (eval/precompute-prompts.mjs,
 *                                 zero-shot models only). Gitignored, never
 *                                 packaged; checked against
 *                                 eval/bakeoff/model-files.json.
 *
 * Where the shipped files come from depends on the manifest's `source`:
 *   - `export` set (our own ONNX export, e.g. TinyCLIP): the LFS copy in
 *     models/ is the source of truth. Nothing is downloaded; this prints the
 *     eval/bakeoff/export.py command that rebuilds the files from the pinned
 *     weights, if they are ever needed again.
 *   - no `export` (ready-made ONNX files on Hugging Face): the files are
 *     downloaded from `source.hfId` at `source.revision` and kept only when
 *     their sha256 matches vendor/CHECKSUMS.sha256. Files we made ourselves
 *     (the head, prompt embeddings) are never downloaded.
 *
 * vendor/ gets transformers.min.js plus the ONE ORT wasm build we load: the
 * JSPI build (offscreen/classifier.js points wasmPaths at it; smaller and
 * faster to load than the bundle's default Asyncify build, needs Chrome 137+).
 *
 *   npm run setup:model                 fetch/check the model, vendor runtime
 *   npm run setup:model -- --verify     check models/ against the manifest and
 *                                       CHECKSUMS, vendor/ against
 *                                       node_modules, and the dev cache; no writes
 *
 * Tracked risk: onnxruntime-web is a 1.31.0 dev prerelease (the stable 1.30
 * runtime can't load fp16 on WebGPU). Move to a stable 1.31.x when one ships,
 * then regenerate the vendor/ lines of CHECKSUMS.sha256.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readChecksums, verifyChecksums, sha256File, CHECKSUMS_FILE } from '../scripts/checksums.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const MODEL_MANIFEST_PATH = 'models/image-model.json';
export const MODEL_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, MODEL_MANIFEST_PATH), 'utf8'));
// transformers.js model id under SHIPPED_MODEL_DIR / DEV_MODEL_DIR.
export const MODEL_ID = MODEL_MANIFEST.dir;
export const MODEL_REVISION = MODEL_MANIFEST.source.revision;
export const MODEL_VERSION = MODEL_MANIFEST.version;
export const SHIPPED_MODEL_DIR = path.join(ROOT, 'models');
export const DEV_MODEL_DIR = path.join(ROOT, 'eval', '.model-cache', 'bakeoff');

const SHIPPED_FILES = MODEL_MANIFEST.files;
// Ours, not Hugging Face's: never downloaded.
const OWN_FILES = new Set(['head.json', 'prompt-embeddings.json', 'prompt-embeddings.bin']);
// Dev-only files, pinned in eval/bakeoff/model-files.json (fetch + export).
const DEV_FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',             // zero-shot prompt precompute
  'onnx/text_model.onnx',       // zero-shot prompt precompute
  'onnx/vision_model.onnx',     // fp32 baseline for eval/fp16-compare.mjs
  'onnx/vision_model_fp16.onnx' // same file the extension ships, for Node evals
];
const VENDOR_FILES = [
  ['node_modules/@huggingface/transformers/dist', 'transformers.min.js'],
  ['node_modules/onnxruntime-web/dist', 'ort-wasm-simd-threaded.jspi.mjs'],
  ['node_modules/onnxruntime-web/dist', 'ort-wasm-simd-threaded.jspi.wasm']
];
const shipped = () => [MODEL_MANIFEST_PATH, ...SHIPPED_FILES.map(f => `models/${MODEL_ID}/${f}`)];

/** Pinned sha256 of a dev-cache file, from the bake-off lockfile. */
function devSha(file) {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/bakeoff/model-files.json'), 'utf8'))[MODEL_ID];
  if (!lock) return null;
  return lock.exports?.[path.basename(file)]?.sha256 || lock.files?.[file] || null;
}

/** A Git LFS pointer instead of the real file (clone without `git lfs pull`). */
export function isLfsPointer(abs) {
  if (!fs.existsSync(abs) || fs.statSync(abs).size > 1024) return false;
  return fs.readFileSync(abs, 'utf8').startsWith('version https://git-lfs');
}

async function downloadShipped() {
  const want = readChecksums(ROOT);
  const base = `https://huggingface.co/${MODEL_MANIFEST.source.hfId}/resolve/${MODEL_REVISION}`;
  for (const file of SHIPPED_FILES.filter(f => !OWN_FILES.has(f))) {
    const rel = `models/${MODEL_ID}/${file}`;
    const dest = path.join(ROOT, rel);
    const sha = want.get(rel);
    if (!sha) throw new Error(`${rel}: no pinned sha256 in ${CHECKSUMS_FILE} (promote.mjs writes it)`);
    if (fs.existsSync(dest) && !isLfsPointer(dest)) {
      if (sha256File(dest) !== sha) throw new Error(`${rel}: does not match its pinned sha256; delete it and rerun`);
      console.log(`✓ ${rel} (sha256 ok)`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    process.stdout.write(`↓ ${rel} ... `);
    const res = await fetch(`${base}/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== sha) throw new Error(`${file}: downloaded sha256 ${got} does not match the pinned ${sha}; nothing written`);
    fs.writeFileSync(dest, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)}MB, sha256 ok`);
  }
}

/** Exported models: models/ (LFS) is the source; say how to rebuild it. */
function explainExport() {
  const pointers = shipped().filter(f => isLfsPointer(path.join(ROOT, f)));
  if (pointers.length) {
    throw new Error(`${pointers.join(', ')}: Git LFS pointer, not the file. Run: git lfs install && git lfs pull`);
  }
  console.log(`✓ models/${MODEL_ID}/ comes from Git LFS (our ONNX export of ${MODEL_MANIFEST.source.hfId} @ ${MODEL_REVISION.slice(0, 7)}).`);
  console.log('  To rebuild it, and the dev cache, from the pinned weights:');
  console.log(`    node eval/bakeoff/fetch-models.mjs ${MODEL_ID}`);
  console.log(`    eval/bakeoff/.cache/venv/bin/python ${MODEL_MANIFEST.source.export} ${MODEL_ID}`);
  console.log('  then compare the sha256s with vendor/CHECKSUMS.sha256 (models/README.md).');
}

function vendor() {
  const vendorDir = path.join(ROOT, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  for (const [dir, f] of VENDOR_FILES) {
    fs.copyFileSync(path.join(ROOT, dir, f), path.join(vendorDir, f));
    console.log(`✓ vendor/${f}`);
  }
  const errors = verifyChecksums(ROOT, VENDOR_FILES.map(([, f]) => `vendor/${f}`));
  if (errors.length) {
    console.warn('\nvendor/ now differs from vendor/CHECKSUMS.sha256 (expected after a dependency upgrade;');
    console.warn('review, then regenerate the vendor/ lines):\n  ' + errors.join('\n  '));
  }
}

/** All files under models/ (README.md is the runbook, never shipped). */
function modelTree() {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
  return walk(SHIPPED_MODEL_DIR).map(f => path.relative(ROOT, f).split(path.sep).join('/'))
    .filter(f => f !== 'models/README.md' && !f.endsWith('.DS_Store'));
}

/** --verify: read-only consistency check. Exit 1 on any problem. */
function verify() {
  const problems = [];
  const want = shipped();
  const pointers = want.filter(f => isLfsPointer(path.join(ROOT, f)));
  for (const f of pointers) problems.push(`${f}: Git LFS pointer, not the file (git lfs pull)`);
  for (const f of modelTree()) if (!want.includes(f)) problems.push(`${f}: not in ${MODEL_MANIFEST_PATH} (promote.mjs removes old models)`);
  const vendored = VENDOR_FILES.map(([, f]) => `vendor/${f}`);
  if (!pointers.length) problems.push(...verifyChecksums(ROOT, [...want, ...vendored]));
  for (const [dir, f] of VENDOR_FILES) {
    const src = path.join(ROOT, dir, f);
    if (!fs.existsSync(src)) { problems.push(`${dir}/${f}: missing (npm install)`); continue; }
    if (sha256File(src) !== sha256File(path.join(ROOT, 'vendor', f))) {
      problems.push(`vendor/${f}: differs from ${dir}/${f} (npm run setup:model re-vendors it)`);
    }
  }
  for (const file of DEV_FILES) {
    const abs = path.join(DEV_MODEL_DIR, MODEL_ID, file);
    if (!fs.existsSync(abs)) { console.log(`  (dev cache) ${file}: not present`); continue; }
    const sha = devSha(file);
    if (!sha) { console.log(`  (dev cache) ${file}: no pin in eval/bakeoff/model-files.json`); continue; }
    if (sha256File(abs) !== sha) problems.push(`eval/.model-cache/bakeoff/${MODEL_ID}/${file}: sha256 mismatch with eval/bakeoff/model-files.json`);
  }
  if (problems.length) {
    console.error('setup:model --verify FAILED:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`setup:model --verify OK (${MODEL_VERSION}: models/ matches its manifest and CHECKSUMS; vendor/ matches node_modules)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--verify')) {
    verify();
  } else {
    if (MODEL_MANIFEST.source.export) explainExport();
    else await downloadShipped();
    vendor();
    console.log('\nModel + vendor setup complete. Check it with: npm run setup:model -- --verify');
  }
}
