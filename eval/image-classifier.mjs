/**
 * Node-side image classifier for the eval harness. Uses the same prompt
 * embeddings the extension ships and the MobileCLIP vision tower from
 * eval/.model-cache (fp32 by default — the CPU baseline; pass --dtype fp16 to
 * load the file the extension ships). The authoritative in-browser
 * comparison is eval/fp16-compare.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';
import { MODEL_ID, DEV_MODEL_DIR } from './setup-model.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let processor = null;
let visionModel = null;
let promptData = null;

export async function loadImageClassifier() {
  if (visionModel) return;
  env.localModelPath = DEV_MODEL_DIR;
  env.allowRemoteModels = false;
  const argv = process.argv;
  const dtype = argv.includes('--dtype') ? argv[argv.indexOf('--dtype') + 1] : 'fp32';
  promptData = loadPromptData();
  processor = await AutoProcessor.from_pretrained(MODEL_ID);
  visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
    dtype, // q8 vision is badly degraded for MobileCLIP; fp32/fp16 only
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
  });
}

/** Same on-disk format as offscreen/classifier.js loadPromptData(). */
export function loadPromptData() {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/prompt-embeddings.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(ROOT, 'data', meta.embeddings || 'prompt-embeddings.bin'));
  const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const dim = meta.dim;
  if (floats.length !== meta.prompts.length * dim) throw new Error('prompt-embeddings.bin does not match prompt-embeddings.json');
  return {
    ...meta,
    prompts: meta.prompts.map((p, i) => ({ ...p, embedding: floats.subarray(i * dim, (i + 1) * dim) }))
  };
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

export async function classifyImageFile(urlOrPath) {
  await loadImageClassifier();
  const image = await RawImage.read(urlOrPath);
  const inputs = await processor(image);
  const { image_embeds } = await visionModel(inputs);
  const vec = Array.from(image_embeds.data);
  const norm = Math.hypot(...vec);
  const normalized = vec.map(v => v / norm);
  return scoreEmbedding(normalized, promptData.prompts, promptData.logitScale);
}
