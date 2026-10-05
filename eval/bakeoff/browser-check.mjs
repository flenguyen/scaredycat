// Browser parity check for the shipped image model (`npm run model:check` runs it), and the phase E check.
//
// Default (model check): load the unpacked extension at --root (default: this repo) in Chrome for Testing, score
// the bake-off's timing subset (50) and parity subset (200) through the real offscreen classifier on WASM (JSPI)
// and on WebGPU, and compare its CALIBRATED scores with the bake-off's in-browser embeddings of the same images
// (.cache/emb-browser/<model>-<view>-<device>) x the shipped scorer x the shipped calibration, both read from
// <root>/models/image-model.json. Each backend is compared with the bake-off run on the same backend (the
// WebGPU reference covers the 200 parity images plus the timing images among them). Passes when every image
// scores, the offscreen document reports the manifest's version, and max |calibrated delta| <= --tolerance (2).
// The WASM vs WebGPU gap and the verdict flips at ml-bridge.js's bars are printed too (not gated: the
// calibration stretches raw gaps by up to 2.6x, and the bake-off read parity on raw scores).
//   SC_CHROME_BIN=<chrome> node eval/bakeoff/browser-check.mjs [--root <dir>] [--ids timing|parity|both] [--tolerance 2] [--out file.json]
//
// Phase E (--ref <model>): a worktree with data/image-head.json, compared with the Node reference embeddings.
//   SC_CHROME_BIN=<chrome> node eval/bakeoff/browser-check.mjs --root <worktree> --ref <model>-fp16 [--pixels node] [--out file.json]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { CACHE, HERE, ROOT, loadIndex, imagePath, readEmb, arg, loadVision } from './lib.mjs';

const CHROME = process.env.SC_CHROME_BIN;
if (!CHROME) throw new Error('SC_CHROME_BIN not set (Chrome for Testing, see README.md)');
const WT = path.resolve(arg('root', ROOT));
const REF = arg('ref', null); // phase E: e.g. dinov2-small
const OUT = arg('out', null);
const TOLERANCE = Number(arg('tolerance', '2'));
// --pixels node (phase E only): serve each image already resized/cropped/denormalised by Node's processor (a PNG of
// exactly the model input), so the browser's decode is the identity and any difference is the runtime alone.
const PIXELS = arg('pixels', 'real');
const PORT = 8907, HOST = 'bake.scaredycat.test';
const BARS = [40, 41, 65, 76, 80]; // ml-bridge.js: veto, genre listing, horror page, block, image only
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const readIds = (f) => JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8')).ids;

// ---- what to compare against ------------------------------------------------------------

let ids, refRaw, refScore, refEmb, manifest = null, head;
const idx = loadIndex();
if (REF) {
  head = JSON.parse(fs.readFileSync(path.join(WT, 'data/image-head.json'), 'utf8'));
  const emb = readEmb(REF, 'fp16');
  if (!emb) throw new Error('no Node fp16 embeddings for ' + REF);
  ids = readIds('timing-subset.json');
  const at = (id) => emb.meta.ids.indexOf(id);
  refEmb = () => (id) => at(id) < 0 ? null : emb.data.subarray(at(id) * emb.meta.dim, (at(id) + 1) * emb.meta.dim);
  refRaw = (e) => { let z = head.b; for (let i = 0; i < head.dim; i++) z += head.w[i] * e[i]; return 100 / (1 + Math.exp(-z)); };
  refScore = refRaw;
} else {
  manifest = JSON.parse(fs.readFileSync(path.join(WT, 'models/image-model.json'), 'utf8'));
  const { scoreWithHead, scoreEmbedding, calibrate } = await import('../image-classifier.mjs');
  const modelFile = (f) => path.join(WT, 'models', manifest.dir, f);
  if (manifest.scorer.type === 'head') {
    const h = JSON.parse(fs.readFileSync(modelFile(manifest.scorer.file), 'utf8'));
    head = { w: Float32Array.from(h.w), b: h.b, dim: h.dim };
    refRaw = (e) => scoreWithHead(e, head);
  } else {
    const meta = JSON.parse(fs.readFileSync(modelFile('prompt-embeddings.json'), 'utf8'));
    const buf = fs.readFileSync(modelFile(meta.embeddings || 'prompt-embeddings.bin'));
    const fl = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const prompts = meta.prompts.map((p, i) => ({ ...p, embedding: fl.subarray(i * meta.dim, (i + 1) * meta.dim) }));
    refRaw = (e) => scoreEmbedding(e, prompts, meta.logitScale);
  }
  refScore = (e) => calibrate(refRaw(e), manifest.calibration.knots);
  const set = arg('ids', 'both');
  ids = [...new Set([...(set !== 'parity' ? readIds('timing-subset.json') : []), ...(set !== 'timing' ? readIds('parity-subset.json') : [])])];
  const browserEmb = (device) => {
    const base = path.join(CACHE, 'emb-browser', `${manifest.id}-${manifest.decode.view}-${device}`);
    if (!fs.existsSync(base + '.json')) return null;
    const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
    const raw = fs.readFileSync(base + '.f32');
    return { meta, data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) };
  };
  const refs = { wasm: browserEmb('wasm'), webgpu: browserEmb('webgpu') };
  if (!refs.wasm) throw new Error(`no in-browser bake-off embeddings for ${manifest.id} (${manifest.decode.view}): run eval/bakeoff/browser-embed.mjs first`);
  refEmb = (device) => {
    const r = refs[device];
    if (!r) return () => null;
    const pos = new Map(r.meta.ids.map((id, i) => [id, i]));
    return (id) => {
      const i = pos.get(id);
      if (i === undefined || r.meta.failures?.some(f => f.id === id)) return null;
      return r.data.subarray(i * r.meta.dim, (i + 1) * r.meta.dim);
    };
  };
}
const missing = ids.filter(id => !idx[id] || !fs.existsSync(imagePath(id, idx)));
if (missing.length) throw new Error(`${missing.length} bake-off images missing from eval/bakeoff/.cache/img (run eval/bakeoff/fetch-images.mjs), e.g. ${missing[0]}`);
const files = Object.fromEntries(ids.map(id => [id, imagePath(id, idx)]));

if (PIXELS === 'node') {
  if (!REF) throw new Error('--pixels node needs --ref');
  const { default: sharp } = await import('sharp');
  const { RawImage } = await import('@huggingface/transformers');
  const { processor } = await loadVision(REF, 'fp16');
  const ip = processor.image_processor, [mean, std] = [ip.image_mean, ip.image_std];
  const dir = path.join(path.dirname(WT), `nodepix-${REF}`); fs.mkdirSync(dir, { recursive: true });
  for (const id of ids) {
    let img;
    try { img = await RawImage.read(files[id]); } catch { const r = await sharp(files[id]).flatten({ background: '#fff' }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true }); img = new RawImage(new Uint8ClampedArray(r.data), r.info.width, r.info.height, r.info.channels); }
    if (img.channels === 4) { const { data, width, height } = img, rgb = new Uint8ClampedArray(width * height * 3); for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { const a = data[i + 3] / 255; for (let c = 0; c < 3; c++) rgb[j + c] = data[i + c] * a + 255 * (1 - a); } img = new RawImage(rgb, width, height, 3); }
    if (ip.size.shortest_edge && ip.size.shortest_edge > (ip.crop_size.height || ip.crop_size)) { // DINOv2: resize 256, crop 256 here; the extension's processor crops 224
      const S = ip.size.shortest_edge, k = Math.max(S / img.width, S / img.height);
      const sq = await (await img.resize(Math.floor(Number((img.width * k).toFixed(2))), Math.floor(Number((img.height * k).toFixed(2))))).center_crop(S, S);
      const f = path.join(dir, id + '.png'); await sharp(Buffer.from(sq.data), { raw: { width: S, height: S, channels: 3 } }).png().toFile(f); files[id] = f; continue;
    }
    const { pixel_values } = await processor(img);
    const [, , H, W] = pixel_values.dims, hw = H * W, out = Buffer.alloc(hw * 3);
    for (let c = 0; c < 3; c++) for (let i = 0; i < hw; i++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round((pixel_values.data[c * hw + i] * std[c] + mean[c]) * 255)));
    const f = path.join(dir, id + '.png'); await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(f); files[id] = f;
  }
}

const server = http.createServer((req, res) => {
  const id = decodeURIComponent(req.url.slice(1));
  if (!files[id]) { res.writeHead(404); return res.end(); }
  const ext = files[id].split('.').pop().toLowerCase();
  const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' }[ext] || 'image/jpeg';
  res.writeHead(200, { 'content-type': type });
  res.end(fs.readFileSync(files[id]));
});
await new Promise(r => server.listen(PORT, r));

// ---- one backend ------------------------------------------------------------------------

async function run(dtype, device) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${WT}`, `--load-extension=${WT}`, '--no-first-run', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`]
  });
  try {
    const sw = await (await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 })).worker();
    await sw.evaluate(async () => {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!ctx.length) await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['WORKERS'], justification: 'model browser check' });
    });
    const off = await browser.waitForTarget(t => t.url().includes('offscreen/offscreen.html'), { timeout: 20000 });
    const cdp = await off.createCDPSession();
    await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    const fetched = new Set();
    cdp.on('Network.requestWillBeSent', ev => { const m = /\/(vendor|models)\/(.+?)(\?|$)/.exec(ev.request.url); if (m) fetched.add(`${m[1]}/${m[2]}`); });
    const errors = [];
    cdp.on('Runtime.consoleAPICalled', ev => { if (ev.type === 'error') errors.push(ev.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)); });
    const ev = async (expression) => {
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || JSON.stringify(exceptionDetails));
      return result.value;
    };
    let info = null, lastErr = null;
    for (let i = 0; i < 100 && !info; i++) {
      try { info = await ev(`globalThis.__scEval ? __scEval.ready(${JSON.stringify(dtype)}, ${JSON.stringify(device)}) : null`); } catch (e) { lastErr = e; }
      if (!info) await new Promise(r => setTimeout(r, 300));
    }
    if (!info) throw new Error('never ready: ' + (lastErr && lastErr.message));
    if (info.device !== device) throw new Error(`wanted ${device}, got ${info.device} (fell back)`);
    const ref = refEmb(device);
    const dS = [], dRaw = [], cos = [], ms = [], perImage = {};
    let fails = 0;
    for (const id of ids) {
      const r = await ev(`__scEval.classify(${JSON.stringify(`http://${HOST}:${PORT}/${encodeURIComponent(id)}`)})`);
      if (typeof r.score !== 'number') { fails++; perImage[id] = { reason: r.reason }; continue; }
      ms.push(r.ms);
      perImage[id] = { score: r.score, raw: r.raw ?? null, ms: r.ms };
      const e = ref(id);
      if (!e) continue;
      const want = refScore(e);
      let d = 0; for (let i = 0; i < e.length; i++) d += e[i] * r.embedding[i];
      dS.push(Math.abs(r.score - want)); cos.push(d);
      if (typeof r.raw === 'number') dRaw.push(Math.abs(r.raw - refRaw(e)));
      Object.assign(perImage[id], { refScore: want, cosine: d });
    }
    return {
      info, fails, n: ids.length, compared: dS.length, perImage,
      maxAbsDelta: Math.max(...dS), p95AbsDelta: pct(dS, 0.95), meanAbsDelta: dS.reduce((a, b) => a + b, 0) / dS.length,
      maxAbsRawDelta: dRaw.length ? Math.max(...dRaw) : null,
      minCosine: Math.min(...cos), meanCosine: cos.reduce((a, b) => a + b, 0) / cos.length,
      perImageMsP50: pct(ms, 0.5), perImageMsP95: pct(ms, 0.95),
      jspiBuildFetched: [...fetched].some(f => /ort-wasm-simd-threaded\.jspi\./.test(f)),
      fetched: [...fetched].sort(), errors: errors.slice(0, 5)
    };
  } finally { await browser.close(); }
}

const out = { mode: REF ? 'phase-e' : 'model-check', pixels: PIXELS, root: WT, ref: REF, model: manifest ? manifest.version : head.model, tolerance: TOLERANCE, ids: ids.length, runs: {} };
for (const dev of ['wasm', 'webgpu']) {
  process.stdout.write(`fp16/${dev} ... `);
  try {
    out.runs[dev] = { loaded: true, ...(await run(REF ? 'fp16' : manifest.dtype, dev)) };
    const r = out.runs[dev];
    console.log(`load ${r.info.loadMs}ms, ${r.compared}/${r.n} compared, max|d| ${r.maxAbsDelta.toFixed(3)}${r.maxAbsRawDelta === null ? '' : ` (raw ${r.maxAbsRawDelta.toFixed(3)})`}, p95 ${r.p95AbsDelta.toFixed(3)}, cos>=${r.minCosine.toFixed(5)}, ${r.perImageMsP50}ms/img, jspi ${r.jspiBuildFetched}, fails ${r.fails}`);
  } catch (e) { out.runs[dev] = { loaded: false, error: String(e.message || e) }; console.log('FAILED/UNAVAILABLE: ' + out.runs[dev].error); }
}
server.close();

let pass = true;
if (!REF) {
  const problems = [];
  for (const [dev, r] of Object.entries(out.runs)) {
    if (!r.loaded) { problems.push(`${dev}: did not load (${r.error})`); continue; }
    if (r.info.modelVersion !== manifest.version) problems.push(`${dev}: offscreen reports ${r.info.modelVersion}, manifest says ${manifest.version}`);
    if (r.fails) problems.push(`${dev}: ${r.fails} image(s) did not score`);
    if (r.compared < 50) problems.push(`${dev}: only ${r.compared} images have a bake-off reference`);
    if (!(r.maxAbsDelta <= TOLERANCE)) problems.push(`${dev}: max |calibrated delta| ${r.maxAbsDelta.toFixed(3)} > ${TOLERANCE}`);
    const shipped = manifest.files.filter(f => f.endsWith('.onnx')).map(f => `models/${manifest.dir}/${f}`);
    if (!shipped.every(f => r.fetched.includes(f))) problems.push(`${dev}: did not load ${shipped.join(', ')}`);
    if (dev === 'wasm' && !r.jspiBuildFetched) problems.push('wasm: the JSPI runtime was not the one loaded');
  }
  const [a, b] = [out.runs.wasm, out.runs.webgpu];
  if (a?.loaded && b?.loaded) {
    const both = ids.filter(id => typeof a.perImage[id]?.score === 'number' && typeof b.perImage[id]?.score === 'number');
    const gaps = both.map(id => Math.abs(a.perImage[id].score - b.perImage[id].score));
    const flips = Object.fromEntries(BARS.map(t => [t, both.filter(id => (a.perImage[id].score >= t) !== (b.perImage[id].score >= t)).length]));
    out.crossBackend = { n: both.length, maxAbsDelta: Math.max(...gaps), p95AbsDelta: pct(gaps, 0.95), flipsAtBars: flips };
    console.log(`WASM vs WebGPU (info, not gated): ${both.length} images, max |calibrated delta| ${out.crossBackend.maxAbsDelta.toFixed(2)}, p95 ${out.crossBackend.p95AbsDelta.toFixed(2)}, verdict flips at ${BARS.map(t => `${t}: ${flips[t]}`).join(', ')}`);
  }
  pass = !problems.length;
  out.pass = pass; out.problems = problems;
  console.log(pass ? `MODEL CHECK PASS (${manifest.version}, calibrated scores within ${TOLERANCE} of the bake-off on both backends)` : 'MODEL CHECK FAIL:\n  ' + problems.join('\n  '));
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
process.exit(pass ? 0 : 1);
