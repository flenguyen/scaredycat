/**
 * Node-side image classifier for the eval harness, driven by
 * models/image-model.json: the shipped head or zero-shot prompts, the same
 * calibration, and the manifest's decode view emulated (crop or squash). The
 * vision tower comes from the dev cache (eval/.model-cache/bakeoff/<dir>/,
 * see eval/setup-model.mjs) at the manifest's dtype; `--dtype fp32` loads the
 * fp32 baseline instead.
 *
 * ************************************************************************
 * NODE IS NOT AUTHORITATIVE. Its decode and resampling (sharp) are not the
 * extension's (canvas), and scores differ from the extension's by up to
 * 50+ points on some images (eval/bakeoff/REPORT.md, "Methodology problems
 * found"). Use this for quick relative checks only. Any number that sets a
 * bar or goes into eval/verdict-corpus.json comes from the browser:
 * eval/bakeoff/browser-embed.mjs, eval/bakeoff/browser-check.mjs or
 * eval/fp16-compare.mjs, which drive the real offscreen classifier.
 * ************************************************************************
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';
import { MODEL_ID, MODEL_MANIFEST, DEV_MODEL_DIR } from './setup-model.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modelFile = (f) => path.join(ROOT, 'models', MODEL_MANIFEST.dir, f);

let processor = null;
let visionModel = null;
let head = null;
let promptData = null;

export async function loadImageClassifier() {
  if (visionModel) return;
  env.localModelPath = DEV_MODEL_DIR;
  env.allowRemoteModels = false;
  const argv = process.argv;
  const dtype = argv.includes('--dtype') ? argv[argv.indexOf('--dtype') + 1] : MODEL_MANIFEST.dtype;
  if (MODEL_MANIFEST.scorer.type === 'head') head = loadHead();
  else promptData = loadPromptData();
  processor = await AutoProcessor.from_pretrained(MODEL_ID);
  visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
    dtype, // q8 broke every bake-off model; fp32/fp16 only
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
  });
}

/** Same file and checks as offscreen/classifier.js loadHead(). */
export function loadHead() {
  const h = JSON.parse(fs.readFileSync(modelFile(MODEL_MANIFEST.scorer.file), 'utf8'));
  if (!Array.isArray(h.w) || h.w.length !== h.dim || h.normalise !== 'l2') throw new Error('head file is malformed');
  return { w: Float32Array.from(h.w), b: h.b, dim: h.dim };
}

/** Same on-disk format as offscreen/classifier.js loadPromptData(). */
export function loadPromptData() {
  const meta = JSON.parse(fs.readFileSync(modelFile('prompt-embeddings.json'), 'utf8'));
  const raw = fs.readFileSync(modelFile(meta.embeddings || 'prompt-embeddings.bin'));
  const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const dim = meta.dim;
  if (floats.length !== meta.prompts.length * dim) throw new Error('prompt-embeddings.bin does not match prompt-embeddings.json');
  return {
    ...meta,
    prompts: meta.prompts.map((p, i) => ({ ...p, embedding: floats.subarray(i * dim, (i + 1) * dim) }))
  };
}

/** Identical math to offscreen/classifier.js: 100 * sigmoid(w . e + b). */
export function scoreWithHead(imageEmbedding, h = head) {
  let z = h.b;
  for (let i = 0; i < h.dim; i++) z += h.w[i] * imageEmbedding[i];
  return 100 / (1 + Math.exp(-z));
}

/**
 * Identical math to offscreen/classifier.js: cosine vs prompt ensemble,
 * softmax with CLIP logit scale, summed horror probability as 0-100.
 */
export function scoreEmbedding(imageEmbedding, prompts, logitScale) {
  const logits = prompts.map(p => {
    let dot = 0;
    for (let i = 0; i < imageEmbedding.length; i++) dot += imageEmbedding[i] * p.embedding[i];
    return dot * logitScale;
  });
  const maxLogit = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - maxLogit));
  const total = exps.reduce((a, b) => a + b, 0);
  let horrorProb = 0;
  prompts.forEach((p, i) => {
    if (p.label === 'horror') horrorProb += exps[i] / total;
  });
  return horrorProb * 100;
}

/** Identical math to offscreen/classifier.js calibrate(): piecewise-linear through the knots. */
export function calibrate(raw, knots = MODEL_MANIFEST.calibration.knots) {
  if (raw <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i];
    if (raw <= x1) {
      const [x0, y0] = knots[i - 1];
      return y0 + (raw - x0) * (y1 - y0) / (x1 - x0);
    }
  }
  return knots[knots.length - 1][1];
}

/** The manifest's decode view, with Node's resize (not the extension's canvas). */
async function emulateView(image) {
  const { view, size: S } = MODEL_MANIFEST.decode;
  if (view === 'squash') return image.resize(S, S);
  const k = Math.max(S / image.width, S / image.height);
  const resized = await image.resize(Math.floor(Number((image.width * k).toFixed(2))), Math.floor(Number((image.height * k).toFixed(2))));
  return resized.center_crop(S, S);
}

/** { score (calibrated), raw } for one image path or URL. */
export async function classifyImageFileDetailed(urlOrPath) {
  await loadImageClassifier();
  let image = await RawImage.read(urlOrPath);
  if (image.channels !== 3) image = image.rgb();
  const inputs = await processor(await emulateView(image));
  const { image_embeds } = await visionModel(inputs);
  const vec = Array.from(image_embeds.data);
  const norm = Math.hypot(...vec);
  const normalized = vec.map(v => v / norm);
  const raw = head ? scoreWithHead(normalized) : scoreEmbedding(normalized, promptData.prompts, promptData.logitScale);
  return { score: calibrate(raw), raw };
}

/** Calibrated score (the scale ml-bridge.js's bars use). */
export async function classifyImageFile(urlOrPath) {
  return (await classifyImageFileDetailed(urlOrPath)).score;
}
