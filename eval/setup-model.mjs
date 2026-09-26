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
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const MODEL_ID = 'Xenova/mobileclip_s0';
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

async function downloadInto(baseDir, files) {
  const base = `https://huggingface.co/${MODEL_ID}/resolve/main`;
  const targetDir = path.join(baseDir, MODEL_ID);
  for (const file of files) {
    const dest = path.join(targetDir, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`✓ ${path.relative(ROOT, dest)} (cached)`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    process.stdout.write(`↓ ${path.relative(ROOT, dest)} ... `);
    const res = await fetch(`${base}/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)}MB`);
  }
}

function vendor() {
  const tfDist = path.join(ROOT, 'node_modules/@huggingface/transformers/dist');
  const ortDist = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
  const vendorDir = path.join(ROOT, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  const files = [
    [tfDist, 'transformers.min.js'],
    [ortDist, 'ort-wasm-simd-threaded.jspi.mjs'],
    [ortDist, 'ort-wasm-simd-threaded.jspi.wasm']
  ];
  for (const [dir, f] of files) {
    fs.copyFileSync(path.join(dir, f), path.join(vendorDir, f));
    console.log(`✓ vendor/${f}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await downloadInto(SHIPPED_MODEL_DIR, SHIPPED_FILES);
  await downloadInto(DEV_MODEL_DIR, DEV_FILES);
  vendor();
  console.log('\nModel + vendor setup complete. Next: npm run precompute:prompts');
}
