/**
 * Scaredy Cat - Offscreen Image Classifier
 * Runs the MobileCLIP vision tower locally (WebGPU when available, WASM
 * otherwise) and scores images against precomputed prompt embeddings.
 * Nothing ever leaves the device.
 *
 * Protocol: background sends { target: 'sc-offscreen', type: 'CLASSIFY_BATCH',
 * urls: [...] } and gets { success, modelVersion, results: [{url, score|null}] }
 * or { unavailable: true } when the model can't be loaded.
 */

import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage }
  from '../vendor/transformers.min.js';

const MODEL_ID = 'Xenova/mobileclip_s0';

env.allowRemoteModels = false;
env.allowLocalModels = true; // the web build defaults this to false
env.useBrowserCache = false; // Cache API rejects chrome-extension:// URLs
env.localModelPath = chrome.runtime.getURL('models/');
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');

let loadPromise = null;
let processor = null;
let visionModel = null;
let promptData = null;

async function loadModel() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const t0 = performance.now();
    const promptsRes = await fetch(chrome.runtime.getURL('data/prompt-embeddings.json'));
    promptData = await promptsRes.json();

    processor = await AutoProcessor.from_pretrained(MODEL_ID);

    // q8 vision is badly degraded for MobileCLIP; fp32 only.
    const device = ('gpu' in navigator) ? 'webgpu' : 'wasm';
    try {
      visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
        dtype: 'fp32', device
      });
    } catch (e) {
      if (device === 'webgpu') {
        console.warn('Scaredy Cat: WebGPU load failed, retrying on WASM', e);
        visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
          dtype: 'fp32', device: 'wasm'
        });
      } else {
        throw e;
      }
    }
    console.log(`Scaredy Cat: classifier ready (${device}, ${Math.round(performance.now() - t0)}ms)`);
  })();
  return loadPromise;
}

/** Same math as eval/image-classifier.mjs — keep the two in sync. */
function scoreEmbedding(imageEmbedding, prompts, logitScale) {
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

async function classifyOne(url) {
  try {
    // Extension-context fetch: host_permissions <all_urls> bypasses page CORS.
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!/^image\//.test(blob.type) || blob.size === 0) return null;

    const image = await RawImage.fromBlob(blob);
    const inputs = await processor(image);
    const { image_embeds } = await visionModel(inputs);
    const vec = image_embeds.data;

    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    const normalized = new Array(vec.length);
    for (let i = 0; i < vec.length; i++) normalized[i] = vec[i] / norm;

    return scoreEmbedding(normalized, promptData.prompts, promptData.logitScale);
  } catch (e) {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'sc-offscreen' || message.type !== 'CLASSIFY_BATCH') return;

  (async () => {
    try {
      await loadModel();
    } catch (e) {
      console.error('Scaredy Cat: classifier unavailable', e);
      sendResponse({ unavailable: true });
      return;
    }
    const results = [];
    for (const url of message.urls || []) {
      results.push({ url, score: await classifyOne(url) });
    }
    sendResponse({ success: true, modelVersion: promptData.modelVersion, results });
  })();

  return true; // async response
});
