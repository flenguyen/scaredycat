/**
 * Scaredy Cat - Offscreen Image Classifier
 * Runs the MobileCLIP vision tower locally (WebGPU when available, WASM
 * otherwise) and scores images against precomputed prompt embeddings.
 * Nothing ever leaves the device.
 *
 * Protocol (runtime Port named 'sc-classify', opened by the service worker):
 *   -> { type: 'CLASSIFY', key, url }   one image; answered as soon as ITS
 *                                       inference is done (no batching):
 *   <- { type: 'RESULT', key, score|null, reason: 'ok'|'fetch'|'decode'|'infer', modelVersion }
 *   -> { type: 'WARM' }                 load the model + one dummy inference
 *   <- { type: 'WARM_DONE', modelVersion }
 *   <- { type: 'UNAVAILABLE' }          the model can't be loaded here
 *
 * Fetch + decode + preprocessing run a few images at a time; inference is
 * serialized on the single ORT session.
 */

import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage }
  from '../vendor/transformers.min.js';

const MODEL_ID = 'Xenova/mobileclip_s0';
const PORT_NAME = 'sc-classify';
const FETCH_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 8000;

env.allowRemoteModels = false;
env.allowLocalModels = true; // the web build defaults this to false
env.useBrowserCache = false; // Cache API rejects chrome-extension:// URLs
env.localModelPath = chrome.runtime.getURL('models/');
// ORT ships several wasm builds; the transformers.js bundle defaults to the
// Asyncify one (26.9MB). The JSPI build (16.8MB) does the same job on Chrome
// 137+ (JavaScript Promise Integration), loads ~40% faster and scores
// identically (eval/fp16-compare.mjs), so we point the runtime at it.
// manifest.json pins minimum_chrome_version accordingly.
env.backends.onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.jspi.mjs'),
  wasm: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.jspi.wasm')
};
// ORT logs "Some nodes were not assigned to the preferred execution
// providers" warnings at session creation, and Chrome lists every console
// warning as an extension error. Errors only.
env.backends.onnx.logLevel = 'error';
const SESSION_OPTIONS = { logSeverityLevel: 3 }; // 3 = error

// Weight precision of the shipped vision tower: fp16 halves the package
// (22.9MB vs 45.5MB) and eval/fp16-compare.mjs showed every calibration
// poster within 2 points of fp32 with no decision-bar crossings, on both
// WebGPU and WASM (needs the transformers.js 4.x / ORT 1.31 runtime in
// vendor/ — the 3.x runtime aborted loading fp16 on WebGPU). The harness
// drives the __scEval hook below to load another precision/backend per run.
const DEFAULT_DTYPE = 'fp16';

let loadPromise = null;
let warmPromise = null;
let processor = null;
let visionModel = null;
let promptData = null;
let activeDevice = null;
let activeDtype = null;
let loadMs = 0;

/**
 * Prompt embeddings ship as a small JSON header (labels, logit scale) plus a
 * Float32 blob (row-major [prompts x dim], L2-normalized) — ~70KB instead of
 * ~380KB of decimal text. Rebuilt by `npm run precompute:prompts`.
 */
async function loadPromptData() {
  const [metaRes, binRes] = await Promise.all([
    fetch(chrome.runtime.getURL('data/prompt-embeddings.json')),
    fetch(chrome.runtime.getURL('data/prompt-embeddings.bin'))
  ]);
  const meta = await metaRes.json();
  const floats = new Float32Array(await binRes.arrayBuffer());
  const dim = meta.dim;
  if (floats.length !== meta.prompts.length * dim) {
    throw new Error('prompt-embeddings.bin does not match prompt-embeddings.json');
  }
  return {
    ...meta,
    prompts: meta.prompts.map((p, i) => ({ ...p, embedding: floats.subarray(i * dim, (i + 1) * dim) }))
  };
}

/**
 * Load once. `dtype`/`device` overrides only apply to the first call (the
 * eval hook); the extension itself always uses the defaults.
 */
async function loadModel(dtypeOverride, deviceOverride) {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const t0 = performance.now();
    if (typeof WebAssembly.Suspending !== 'function') {
      throw new Error('WebAssembly JSPI unavailable (Chrome 137+ required)');
    }
    promptData = await loadPromptData();
    processor = await AutoProcessor.from_pretrained(MODEL_ID);

    // q8 vision is badly degraded for MobileCLIP (int8 scored Hereditary 2.2
    // vs 97.9); only fp16/fp32 are acceptable.
    const dtype = dtypeOverride || DEFAULT_DTYPE;
    let device = deviceOverride || (('gpu' in navigator) ? 'webgpu' : 'wasm');
    try {
      visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
        dtype, device, session_options: SESSION_OPTIONS
      });
    } catch (e) {
      if (device === 'webgpu') {
        console.warn('Scaredy Cat: WebGPU load failed, retrying on WASM', e);
        device = 'wasm';
        visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
          dtype, device, session_options: SESSION_OPTIONS
        });
      } else {
        throw e;
      }
    }
    activeDevice = device;
    activeDtype = dtype;
    loadMs = Math.round(performance.now() - t0);
    console.log(`Scaredy Cat: classifier ready (${device}, ${dtype}, ${loadMs}ms)`);
  })();
  return loadPromise;
}

// Dev hook for eval/fp16-compare.mjs (driven over CDP; never used by the
// extension itself).
globalThis.__scEval = {
  async ready(dtype, device) {
    await loadModel(dtype, device);
    return { device: activeDevice, dtype: activeDtype, loadMs };
  },
  async classify(url) {
    await loadModel();
    const t0 = performance.now();
    const r = await classifyOne(url, new Set());
    return { ...r, ms: Math.round(performance.now() - t0) };
  }
};

/** Load + one throwaway 256x256 inference. Idempotent. */
function warmUp() {
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    await loadModel();
    const t0 = performance.now();
    try {
      const pixels = new Uint8ClampedArray(256 * 256 * 3).fill(128);
      const image = new RawImage(pixels, 256, 256, 3);
      const inputs = await processor(image);
      await runInference(inputs);
      console.log(`Scaredy Cat: classifier warm (${Math.round(performance.now() - t0)}ms)`);
    } catch (e) {
      // Warm-up is best effort; real requests will surface any real failure.
    }
  })();
  return warmPromise;
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

// ---- concurrency ------------------------------------------------------------------

/** Counting semaphore for the fetch/decode/preprocess stage. */
function semaphore(n) {
  let free = n;
  const waiters = [];
  return {
    acquire() {
      if (free > 0) { free--; return Promise.resolve(); }
      return new Promise(resolve => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next(); else free++;
    }
  };
}
const fetchSlots = semaphore(FETCH_CONCURRENCY);

// One ORT session: run inferences one at a time, in arrival order.
let inferChain = Promise.resolve();
function runInference(inputs) {
  const run = inferChain.then(() => visionModel(inputs));
  inferChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Fetch, decode and preprocess one image. `controllers` lets the port's
 * disconnect handler abort everything still in flight for it.
 */
async function prepare(url, controllers) {
  await fetchSlots.acquire();
  const ctrl = new AbortController();
  controllers.add(ctrl);
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let blob;
    try {
      // Extension-context fetch: host_permissions <all_urls> bypasses page CORS.
      const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
      if (!res.ok) return { reason: 'fetch' };
      blob = await res.blob();
    } catch (e) {
      return { reason: 'fetch' };
    }
    if (!/^image\//.test(blob.type) || blob.size === 0) return { reason: 'fetch' };
    try {
      const image = await RawImage.fromBlob(blob);
      const inputs = await processor(image);
      return { inputs };
    } catch (e) {
      return { reason: 'decode' };
    }
  } finally {
    clearTimeout(timer);
    controllers.delete(ctrl);
    fetchSlots.release();
  }
}

async function classifyOne(url, controllers) {
  const prepared = await prepare(url, controllers);
  if (!prepared.inputs) return { score: null, reason: prepared.reason };
  try {
    const { image_embeds } = await runInference(prepared.inputs);
    const vec = image_embeds.data;
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    const normalized = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) normalized[i] = vec[i] / norm;
    return { score: scoreEmbedding(normalized, promptData.prompts, promptData.logitScale), reason: 'ok' };
  } catch (e) {
    return { score: null, reason: 'infer' };
  }
}

// ---- port protocol ----------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const controllers = new Set();
  let open = true;
  const post = (msg) => { if (open) { try { port.postMessage(msg); } catch (e) { open = false; } } };

  port.onDisconnect.addListener(() => {
    open = false;
    for (const ctrl of controllers) ctrl.abort();
    controllers.clear();
  });

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    (async () => {
      try {
        await loadModel();
      } catch (e) {
        console.error('Scaredy Cat: classifier unavailable', e);
        post({ type: 'UNAVAILABLE' });
        return;
      }
      if (message.type === 'WARM') {
        await warmUp();
        post({ type: 'WARM_DONE', modelVersion: promptData.modelVersion });
        return;
      }
      if (message.type !== 'CLASSIFY') return;
      const result = await classifyOne(message.url, controllers);
      post({ type: 'RESULT', key: message.key, score: result.score, reason: result.reason, modelVersion: promptData.modelVersion });
    })();
  });
});
