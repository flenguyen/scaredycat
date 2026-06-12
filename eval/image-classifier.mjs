/**
 * Node-side image classifier for the eval harness. Uses the SAME vision
 * model and prompt embeddings the extension ships, so eval scores match
 * production scores.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';
import { MODEL_ID } from './setup-model.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let processor = null;
let visionModel = null;
let promptData = null;

export async function loadImageClassifier() {
  if (visionModel) return;
  env.localModelPath = path.join(ROOT, 'models');
  env.allowRemoteModels = false;
  promptData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/prompt-embeddings.json'), 'utf8'));
  processor = await AutoProcessor.from_pretrained(MODEL_ID);
  visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
    dtype: 'fp32', // q8 vision is badly degraded for MobileCLIP
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
  });
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
