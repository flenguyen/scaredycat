/**
 * One-time dev setup: download the CLIP model files from Hugging Face and copy
 * the transformers.js browser bundle into vendor/.
 *
 * Two destinations:
 *   models/            — what the extension ships: config, preprocessor config
 *                        and the fp16 vision tower (~23MB). q8/int8 vision is
 *                        badly degraded for MobileCLIP; fp16 was validated
 *                        against fp32 with eval/fp16-compare.mjs.
 *   eval/.model-cache/ — dev-only: fp32 vision tower (comparison baseline),
 *                        tokenizer + quantized text tower used by
 *                        precompute-prompts.mjs. Gitignored, never packaged.
 *
 * vendor/ gets transformers.min.js plus the ONE ORT wasm build we load: the
 * JSPI build (offscreen/classifier.js points wasmPaths at it; smaller and
 * faster to load than the bundle's default Asyncify build, needs Chrome 137+).
 *
 * Downloads come from one pinned Hugging Face commit (MODEL_REVISION), and
 * every file is checked against a known sha256 before it is kept: shipped
 * files against vendor/CHECKSUMS.sha256 (which `npm run pack` checks too),
 * dev-only files against DEV_SHA256 below.
 *
 *   npm run setup:model                 download + vendor
 *   npm run setup:model -- --verify     check models/, vendor/ and the dev
 *                                       cache against the checksums, and
 *                                       vendor/ against node_modules; no writes
 *
 * Tracked risk: onnxruntime-web is a 1.31.0 dev prerelease (the stable 1.30
 * runtime can't load fp16 on WebGPU). Move to a stable 1.31.x when one ships,
 * then regenerate the vendor/ lines of CHECKSUMS.sha256.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readChecksums, verifyChecksums, sha256File } from '../scripts/checksums.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const MODEL_ID = 'Xenova/mobileclip_s0';
// Commit of huggingface.co/Xenova/mobileclip_s0 the shipped files came from
// (`sha` in https://huggingface.co/api/models/Xenova/mobileclip_s0).
export const MODEL_REVISION = '757d59c9c6870a76a4b0306f05f5061bca15c39f';
export const MODEL_VERSION = 'mobileclip_s0-fp16-v3';
export const SHIPPED_MODEL_DIR = path.join(ROOT, 'models');
export const DEV_MODEL_DIR = path.join(ROOT, 'eval', '.model-cache');

const SHIPPED_FILES = [
  'config.json',
  'preprocessor_config.json',
  'onnx/vision_model_fp16.onnx'
];
const DEV_FILES = [
  'config.json', // the text tower loader reads it too
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/text_model_quantized.onnx',
  'onnx/vision_model.onnx',      // fp32 baseline for eval/fp16-compare.mjs
  'onnx/vision_model_fp16.onnx'  // same file the extension ships, for Node evals
];
// Dev-only files at MODEL_REVISION (they never ship, so they live here
// rather than in vendor/CHECKSUMS.sha256).
const DEV_SHA256 = {
  'config.json': '8e33c1f2634a33de3e38715f9809ef86742aacbe31c310c66fc2636755458d56',
  'preprocessor_config.json': 'b031f09fbd69e22a605b6cc7433993249ee893b7fc1b79321f669cd015493dd4',
  'tokenizer.json': '72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85',
  'tokenizer_config.json': 'a7d9d24f248071b792e4a3b56ab0539c2f40eec8da56d6fd91fb3a50058acebd',
  'onnx/text_model_quantized.onnx': 'b8557b10e5c23a0126c6d2e6eba48d240484979007917d128953b31618a04211',
  'onnx/vision_model.onnx': '17d3c037b1d488c10c50e09f6009ea5a198caef4e0e8f4ea5617b7cb2d067ac0',
  'onnx/vision_model_fp16.onnx': '22b1d36ecc6837e8205aee05003440a25e1c1ee0c7e2945dbb9dd597211c59dc'
};
const VENDOR_FILES = [
  ['node_modules/@huggingface/transformers/dist', 'transformers.min.js'],
  ['node_modules/onnxruntime-web/dist', 'ort-wasm-simd-threaded.jspi.mjs'],
  ['node_modules/onnxruntime-web/dist', 'ort-wasm-simd-threaded.jspi.wasm']
];

/** Expected sha256 for a file under baseDir/MODEL_ID. */
function expectedSha(baseDir, file) {
  if (baseDir === SHIPPED_MODEL_DIR) {
    return readChecksums(ROOT).get(`models/${MODEL_ID}/${file}`) || null;
  }
  return DEV_SHA256[file] || null;
}

async function downloadInto(baseDir, files) {
  const base = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}`;
  const targetDir = path.join(baseDir, MODEL_ID);
  for (const file of files) {
    const dest = path.join(targetDir, file);
    const want = expectedSha(baseDir, file);
    if (!want) throw new Error(`${file}: no pinned sha256 (add it before downloading)`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      if (sha256File(dest) !== want) throw new Error(`${path.relative(ROOT, dest)}: cached copy does not match its pinned sha256; delete it and rerun`);
      console.log(`✓ ${path.relative(ROOT, dest)} (cached, sha256 ok)`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    process.stdout.write(`↓ ${path.relative(ROOT, dest)} ... `);
    const res = await fetch(`${base}/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== want) throw new Error(`${file}: downloaded sha256 ${got} does not match the pinned ${want}; nothing written`);
    fs.writeFileSync(dest, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)}MB, sha256 ok`);
  }
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

/** --verify: read-only consistency check. Exit 1 on any problem. */
function verify() {
  const problems = [];
  const shipped = SHIPPED_FILES.map(f => `models/${MODEL_ID}/${f}`);
  const vendored = VENDOR_FILES.map(([, f]) => `vendor/${f}`);
  problems.push(...verifyChecksums(ROOT, [...shipped, ...vendored]));
  for (const [dir, f] of VENDOR_FILES) {
    const src = path.join(ROOT, dir, f);
    if (!fs.existsSync(src)) { problems.push(`${dir}/${f}: missing (npm install)`); continue; }
    if (sha256File(src) !== sha256File(path.join(ROOT, 'vendor', f))) {
      problems.push(`vendor/${f}: differs from ${dir}/${f} (npm run setup:model re-vendors it)`);
    }
  }
  for (const file of DEV_FILES) {
    const abs = path.join(DEV_MODEL_DIR, MODEL_ID, file);
    if (!fs.existsSync(abs)) { console.log(`  (dev cache) ${file}: not downloaded`); continue; }
    if (sha256File(abs) !== DEV_SHA256[file]) problems.push(`eval/.model-cache/${MODEL_ID}/${file}: sha256 mismatch`);
  }
  if (problems.length) {
    console.error('setup:model --verify FAILED:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`setup:model --verify OK (models at ${MODEL_REVISION.slice(0, 12)}, vendor/ matches node_modules and CHECKSUMS)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--verify')) {
    verify();
  } else {
    await downloadInto(SHIPPED_MODEL_DIR, SHIPPED_FILES);
    await downloadInto(DEV_MODEL_DIR, DEV_FILES);
    vendor();
    console.log('\nModel + vendor setup complete. Next: npm run precompute:prompts');
  }
}
