/**
 * One-time dev setup: download the CLIP model files from Hugging Face into
 * models/ and copy the transformers.js browser bundle into vendor/.
 *
 * The extension ships ONLY the vision tower (~12MB) — text prompts are
 * embedded ahead of time by precompute-prompts.mjs. The text tower is
 * downloaded too but used exclusively by the local tooling.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const MODEL_ID = 'Xenova/mobileclip_s0';
export const MODEL_VERSION = 'mobileclip_s0-fp32-v2';

const FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  // fp32 vision: the q8 vision tower is badly degraded for MobileCLIP
  // (the repo's transformers.js_config pins vision_model to fp32 too).
  'onnx/vision_model.onnx',
  'onnx/text_model_quantized.onnx' // dev-only (prompt precompute); not loaded by the extension
];

async function download() {
  const base = `https://huggingface.co/${MODEL_ID}/resolve/main`;
  const targetDir = path.join(ROOT, 'models', MODEL_ID);

  for (const file of FILES) {
    const dest = path.join(targetDir, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`✓ ${file} (cached)`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    process.stdout.write(`↓ ${file} ... `);
    const res = await fetch(`${base}/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)}MB`);
  }
}

function vendor() {
  const dist = path.join(ROOT, 'node_modules/@huggingface/transformers/dist');
  const vendorDir = path.join(ROOT, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  const files = [
    'transformers.min.js',
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm'
  ];
  for (const f of files) {
    fs.copyFileSync(path.join(dist, f), path.join(vendorDir, f));
    console.log(`✓ vendor/${f}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await download();
  vendor();
  console.log('\nModel + vendor setup complete. Next: npm run precompute:prompts');
}
