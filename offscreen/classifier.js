/**
 * Scaredy Cat - Offscreen Image Classifier
 * Runs the image model named in models/image-model.json locally (WebGPU when
 * available, WASM otherwise): a CLIP-style vision tower whose image embedding
 * is scored by a linear head or against zero-shot prompt embeddings. The raw
 * score is then mapped through the manifest's calibration, so every model
 * reports on the same scale (40 veto, 65 horror page, 76 block, 80 image
 * only; see content/ml-bridge.js). Swap the model with
 * eval/bakeoff/promote.mjs (models/README.md). Nothing ever leaves the device.
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
 * serialized on the single ORT session. A fetch slot is held until the
 * image's inference starts, so at most FETCH_CONCURRENCY prepared tensors
 * ever wait in memory.
 *
 * Only the extension's own service worker may connect (checked on every
 * port), and only public http(s) image URLs are fetched (guards.js, loaded
 * by offscreen.html before this module), re-checked after redirects, typed
 * as images by their headers and capped at MAX_IMAGE_BYTES.
 */

import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage }
  from '../vendor/transformers.min.js';

const MODEL_MANIFEST = 'models/image-model.json';
const PORT_NAME = 'sc-classify';
const FETCH_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Canvas size the decoders produce, from the manifest's decode.size at load.
// 'crop': the short edge is resized to it and the centre square cut out (the
// processor then resizes that square to the model's own input). 'squash': the
// whole image is resized to this square, the model's input.
let INPUT_SIZE = 256;
// Decode path, from the manifest's decode.view at load. 'canvas' (view
// 'crop'): the legacy pixels with one full-size buffer instead of five
// (decodeLikeLegacy). 'squash' (view 'squash'): decodeSquash. 'bitmap':
// createImageBitmap resizes during decode, no full-size buffer at all, but it
// scores differently on large images and would need a recalibration first.
// 'legacy': the old RawImage.fromBlob path, which leaves the geometry to the
// processor (a whole-image squash for TinyCLIP's "size": 224 config). The
// last two stay as candidates for eval/decode-compare.mjs.
const DECODE_PATHS = { crop: 'canvas', squash: 'squash' };
let DECODE_PATH = 'canvas';
const RESIZE_QUALITY = 'high';

// Fail closed if guards.js didn't load: no URL is fetchable.
const isFetchableImageUrl = (url) =>
  typeof ScaredyCatGuards !== 'undefined' && ScaredyCatGuards.isFetchableImageUrl(url);

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

// The weight precision comes from the manifest (`dtype`, fp16 today: half the
// size of fp32, checked against it with eval/fp16-compare.mjs; it needs the
// transformers.js 4.x / ORT 1.31 runtime in vendor/, the 3.x runtime aborted
// loading fp16 on WebGPU). The harness drives the __scEval hook below to load
// another precision/backend per run.

let loadPromise = null;
let warmPromise = null;
let manifest = null; // models/image-model.json, validated
let processor = null;
let visionModel = null;
let head = null;       // scorer 'head': { w: Float32Array, b, dim }
let promptData = null; // scorer 'zero-shot': prompt embeddings
let knots = null;      // calibration: [[raw, calibrated], ...], increasing in both
let activeDevice = null;
let activeDtype = null;
let loadMs = 0;

const modelUrl = (file) => chrome.runtime.getURL(`models/${manifest.dir}/${file}`);

/**
 * models/image-model.json: which model to load and how to score it. Written
 * by eval/bakeoff/promote.mjs and checked by eval/model-manifest-test.mjs;
 * re-checked here so a broken file fails the load instead of scoring wrong.
 */
async function loadManifest() {
  const res = await fetch(chrome.runtime.getURL(MODEL_MANIFEST));
  if (!res.ok) throw new Error(`${MODEL_MANIFEST}: HTTP ${res.status}`);
  const m = await res.json();
  const k = m?.calibration?.knots;
  const ok = m && m.schema === 1 && typeof m.dir === 'string' && typeof m.version === 'string' &&
    ['fp16', 'fp32'].includes(m.dtype) && DECODE_PATHS[m.decode?.view] && Number.isInteger(m.decode?.size) &&
    ['head', 'zero-shot'].includes(m.scorer?.type) && Array.isArray(k) && k.length >= 2 &&
    k.every((p, i) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) &&
      (i === 0 || (p[0] > k[i - 1][0] && p[1] >= k[i - 1][1])));
  if (!ok) throw new Error(`${MODEL_MANIFEST} is malformed`);
  return m;
}

/**
 * Linear head: score = 100 * sigmoid(w . e + b) on the L2-normalised image
 * embedding (trained in eval/bakeoff on in-browser embeddings).
 */
async function loadHead() {
  const res = await fetch(modelUrl(manifest.scorer.file));
  const h = await res.json();
  if (!Array.isArray(h.w) || h.w.length !== h.dim || h.normalise !== 'l2' || !Number.isFinite(h.b)) {
    throw new Error(`models/${manifest.dir}/${manifest.scorer.file} is malformed`);
  }
  return { w: Float32Array.from(h.w), b: h.b, dim: h.dim };
}

/**
 * Zero-shot prompt embeddings ship as a small JSON header (labels, logit
 * scale) plus a Float32 blob (row-major [prompts x dim], L2-normalized),
 * ~70KB instead of ~380KB of decimal text. Rebuilt by
 * `npm run precompute:prompts` for a zero-shot model.
 */
async function loadPromptData() {
  const [metaRes, binRes] = await Promise.all([
    fetch(modelUrl('prompt-embeddings.json')),
    fetch(modelUrl('prompt-embeddings.bin'))
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
    manifest = await loadManifest();
    INPUT_SIZE = manifest.decode.size;
    DECODE_PATH = DECODE_PATHS[manifest.decode.view];
    knots = manifest.calibration.knots;
    if (manifest.scorer.type === 'head') head = await loadHead();
    else promptData = await loadPromptData();
    processor = await AutoProcessor.from_pretrained(manifest.dir);

    // q8 (dynamic int8) broke every model measured in the bake-off (score
    // changes of 21 to 75 points); only fp16/fp32 are acceptable.
    const dtype = dtypeOverride || manifest.dtype;
    let device = deviceOverride || (('gpu' in navigator) ? 'webgpu' : 'wasm');
    try {
      visionModel = await CLIPVisionModelWithProjection.from_pretrained(manifest.dir, {
        dtype, device, session_options: SESSION_OPTIONS
      });
    } catch (e) {
      if (device === 'webgpu') {
        console.warn('Scaredy Cat: WebGPU load failed, retrying on WASM', e);
        device = 'wasm';
        visionModel = await CLIPVisionModelWithProjection.from_pretrained(manifest.dir, {
          dtype, device, session_options: SESSION_OPTIONS
        });
      } else {
        throw e;
      }
    }
    activeDevice = device;
    activeDtype = dtype;
    loadMs = Math.round(performance.now() - t0);
    console.log(`Scaredy Cat: classifier ready (${manifest.version}, ${device}, ${dtype}, ${loadMs}ms)`);
  })();
  return loadPromise;
}

// Dev hook for eval/fp16-compare.mjs and eval/decode-compare.mjs (driven
// over CDP; never used by the extension itself). It stays in production
// builds on purpose: only extension contexts and DevTools can reach this
// document's globals, and it fetches through the same URL checks as the port.
// `opts.decode` / `opts.quality` pick the decode path for the comparison.
// classify returns the calibrated `score`, the model's `raw` score and the
// L2-normalised `embedding` (eval/bakeoff/browser-check.mjs compares them).
globalThis.__scEval = {
  async ready(dtype, device) {
    await loadModel(dtype, device);
    return { device: activeDevice, dtype: activeDtype, loadMs, modelVersion: manifest.version };
  },
  async classify(url, opts = {}) {
    await loadModel();
    const t0 = performance.now();
    const r = await classifyOne(url, new Set(), opts);
    return { ...r, embedding: r.embedding && Array.from(r.embedding), ms: Math.round(performance.now() - t0) };
  }
};

/** Load + one throwaway inference on a grey square. Idempotent. */
function warmUp() {
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    await loadModel();
    const t0 = performance.now();
    try {
      const pixels = new Uint8ClampedArray(INPUT_SIZE * INPUT_SIZE * 3).fill(128);
      const image = new RawImage(pixels, INPUT_SIZE, INPUT_SIZE, 3);
      const inputs = await processor(image);
      await runInference(inputs);
      console.log(`Scaredy Cat: classifier warm (${Math.round(performance.now() - t0)}ms)`);
    } catch (e) {
      // Warm-up is best effort; real requests will surface any real failure.
    }
  })();
  return warmPromise;
}

/** Linear head: 100 * sigmoid(w . e + b). Same math as eval/image-classifier.mjs. */
function scoreWithHead(imageEmbedding) {
  if (imageEmbedding.length !== head.dim) throw new Error('head does not match the model');
  let z = head.b;
  for (let i = 0; i < head.dim; i++) z += head.w[i] * imageEmbedding[i];
  return 100 / (1 + Math.exp(-z));
}

/**
 * Raw model score -> the shared scale, piecewise-linear through the
 * manifest's knots. Monotone, so a verdict at each bar is the verdict the raw
 * bar picked in the bake-off would give. Same math as eval/image-classifier.mjs.
 */
function calibrate(raw) {
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
// `onStart` fires when this inference actually begins (the fetch slot is
// handed back then, not earlier).
let inferChain = Promise.resolve();
function runInference(inputs, onStart) {
  const run = inferChain.then(() => {
    if (onStart) onStart();
    return visionModel(inputs);
  });
  inferChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Fetch one image as a Blob, or { reason } on failure. The content type is
 * checked from the headers before any of the body is read, the size by
 * Content-Length and then by a running count, and the final URL after
 * redirects must pass the same check as the original.
 */
async function fetchImage(url, signal) {
  if (!isFetchableImageUrl(url)) return { reason: 'fetch' };
  let res;
  try {
    // Extension-context fetch: host_permissions <all_urls> bypasses page CORS.
    res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal });
  } catch (e) {
    return { reason: 'fetch' };
  }
  const drop = () => { try { res.body?.cancel(); } catch (e) { /* ignore */ } };
  if (!res.ok || (res.redirected && !isFetchableImageUrl(res.url))) { drop(); return { reason: 'fetch' }; }
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) { drop(); return { reason: 'fetch' }; }
  const declared = parseInt(res.headers.get('Content-Length') || '', 10);
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) { drop(); return { reason: 'fetch' }; }
  try {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        return { reason: 'fetch' };
      }
      chunks.push(value);
    }
    if (!total) return { reason: 'fetch' };
    return { blob: new Blob(chunks, { type }) };
  } catch (e) {
    return { reason: 'fetch' };
  }
}

// One canvas for every crop: decode work never allocates a full-size buffer.
let cropCtx = null;
function getCropContext() {
  if (!cropCtx) {
    cropCtx = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE).getContext('2d', { willReadFrequently: true });
  }
  return cropCtx;
}

/**
 * Blob -> INPUT_SIZE square RGB RawImage. The browser decodes straight to a
 * bitmap whose short side is INPUT_SIZE (portrait first; a landscape image is
 * decoded again by height), the center is cropped onto the reused canvas, and
 * the bitmap is freed at once. Same geometry as the processor's shortest-edge
 * resize + center crop, which then has nothing left to do.
 */
async function decodeToInput(blob, quality = RESIZE_QUALITY) {
  let bitmap = await createImageBitmap(blob, { resizeWidth: INPUT_SIZE, resizeQuality: quality });
  if (bitmap.height < INPUT_SIZE) {
    bitmap.close();
    bitmap = await createImageBitmap(blob, { resizeHeight: INPUT_SIZE, resizeQuality: quality });
  }
  try {
    const ctx = getCropContext();
    const sx = (bitmap.width - INPUT_SIZE) / 2;
    const sy = (bitmap.height - INPUT_SIZE) / 2;
    ctx.clearRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    ctx.drawImage(bitmap, sx, sy, INPUT_SIZE, INPUT_SIZE, 0, 0, INPUT_SIZE, INPUT_SIZE);
    const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
    return new RawImage(data, INPUT_SIZE, INPUT_SIZE, 4).rgb();
  } finally {
    bitmap.close();
  }
}

/**
 * Blob -> INPUT_SIZE square RGB RawImage (view 'crop', 256): a shortest-edge
 * resize and center crop, each a canvas drawImage. It was written to give
 * exactly the legacy path's pixels under MobileCLIP, whose processor crops
 * (eval/decode-compare.mjs: Δ 0.00 then). TinyCLIP's processor squashes
 * instead, so legacy no longer matches; this path is the one the current head
 * was trained and calibrated on, and decode-compare uses it as the reference.
 * Compared with legacy it also saves copies. Legacy held the decoded image as a bitmap, a canvas, a full-size
 * RGBA array, an RGB array and another canvas (~140 MB for a 2000x3000
 * poster). Here the bitmap is drawn into one full-size canvas and closed,
 * that canvas is drawn down to INPUT_SIZE px and released, and only
 * INPUT_SIZE x INPUT_SIZE pixels ever reach the JS heap.
 *
 * Drawing straight from the bitmap (skipping the full-size canvas) or
 * letting createImageBitmap resize would save that one buffer too, but both
 * resample differently and moved scores by up to 40 points on full-size
 * posters, so they fail the gate (see 'bitmap' below).
 */
async function decodeLikeLegacy(blob) {
  const bitmap = await createImageBitmap(blob);
  let full;
  try {
    full = new OffscreenCanvas(bitmap.width, bitmap.height);
    full.getContext('2d').drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
  // Processor.get_resize_output_image_size for { shortest_edge: INPUT_SIZE }.
  const scale = Math.max(INPUT_SIZE / full.width, INPUT_SIZE / full.height);
  const w = Math.floor(Number((full.width * scale).toFixed(2)));
  const h = Math.floor(Number((full.height * scale).toFixed(2)));
  const resized = new OffscreenCanvas(w, h);
  resized.getContext('2d').drawImage(full, 0, 0, w, h);
  full.width = full.height = 0; // release the backing store now, not at GC
  // RawImage.center_crop: fractional offsets, drawn the way it draws them.
  // A fresh canvas per image, as legacy does: a reused one trips Chrome's
  // repeated-readback warning, and willReadFrequently would silence it by
  // rendering on the CPU, which resamples these offsets differently (up to
  // 3.4 points on the page set).
  const crop = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE).getContext('2d');
  const sx = (w - INPUT_SIZE) / 2;
  const sy = (h - INPUT_SIZE) / 2;
  crop.drawImage(resized, Math.max(sx, 0), Math.max(sy, 0), INPUT_SIZE, INPUT_SIZE,
    Math.max(-sx, 0), Math.max(-sy, 0), INPUT_SIZE, INPUT_SIZE);
  const { data } = crop.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  return new RawImage(data, INPUT_SIZE, INPUT_SIZE, 4).rgb();
}

/**
 * Blob -> INPUT_SIZE square RGB RawImage of the whole image, no crop (view
 * 'squash'): the processor then has nothing left to resize.
 */
async function decodeSquash(blob) {
  const bitmap = await createImageBitmap(blob, { resizeWidth: INPUT_SIZE, resizeHeight: INPUT_SIZE, resizeQuality: RESIZE_QUALITY });
  try {
    const ctx = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE).getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
    return new RawImage(data, INPUT_SIZE, INPUT_SIZE, 4).rgb();
  } finally {
    bitmap.close();
  }
}

/**
 * Fetch, decode and preprocess one image. `controllers` lets the port's
 * disconnect handler abort everything still in flight for it. On success the
 * caller owns `release` and must call it once (when inference starts).
 */
async function prepare(url, controllers, opts = {}) {
  await fetchSlots.acquire();
  let released = false;
  const release = () => { if (!released) { released = true; fetchSlots.release(); } };
  const ctrl = new AbortController();
  controllers.add(ctrl);
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const fetched = await fetchImage(url, ctrl.signal);
    clearTimeout(timer);
    controllers.delete(ctrl);
    if (!fetched.blob) { release(); return { reason: fetched.reason }; }
    try {
      const decode = opts.decode || DECODE_PATH;
      const image = decode === 'squash' ? await decodeSquash(fetched.blob)
        : decode === 'legacy' ? await RawImage.fromBlob(fetched.blob)
        : decode === 'canvas' ? await decodeLikeLegacy(fetched.blob)
        : await decodeToInput(fetched.blob, opts.quality || RESIZE_QUALITY);
      const inputs = await processor(image);
      return { inputs, release };
    } catch (e) {
      release();
      return { reason: 'decode' };
    }
  } catch (e) {
    release();
    return { reason: 'fetch' };
  } finally {
    clearTimeout(timer);
    controllers.delete(ctrl);
  }
}

async function classifyOne(url, controllers, opts) {
  const prepared = await prepare(url, controllers, opts);
  if (!prepared.inputs) return { score: null, reason: prepared.reason };
  try {
    const { image_embeds } = await runInference(prepared.inputs, prepared.release);
    const vec = image_embeds.data;
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    const normalized = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) normalized[i] = vec[i] / norm;
    const raw = head ? scoreWithHead(normalized)
      : scoreEmbedding(normalized, promptData.prompts, promptData.logitScale);
    return { score: calibrate(raw), raw, reason: 'ok', embedding: normalized };
  } catch (e) {
    return { score: null, reason: 'infer' };
  } finally {
    prepared.release(); // no-op once inference started
  }
}

// ---- port protocol ----------------------------------------------------------------

/**
 * Only the service worker may drive the classifier. Content scripts can
 * call runtime.connect() too (their ports reach this document), so check
 * the sender: this extension, no tab, and the worker's own URL.
 */
function isServiceWorkerSender(sender) {
  return !!sender && sender.id === chrome.runtime.id && !sender.tab &&
    sender.url === chrome.runtime.getURL('background.js');
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  if (!isServiceWorkerSender(port.sender)) {
    try { port.disconnect(); } catch (e) { /* ignore */ }
    return;
  }
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
        post({ type: 'WARM_DONE', modelVersion: manifest.version });
        return;
      }
      if (message.type !== 'CLASSIFY' || typeof message.url !== 'string') return;
      const result = await classifyOne(message.url, controllers);
      post({ type: 'RESULT', key: message.key, score: result.score, reason: result.reason, modelVersion: manifest.version });
    })();
  });
});
