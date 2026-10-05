// Phase E browser check: drive a worktree's offscreen classifier on the 50 timing-subset images
// on WASM (JSPI) and WebGPU, and compare with the Node reference embeddings + the same head.
//   SC_CHROME_BIN=<chrome> node eval/bakeoff/browser-check.mjs --root <worktree> --ref <model>-fp16 [--out file.json]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { CACHE, HERE, loadIndex, imagePath, readEmb, arg, loadVision } from './lib.mjs';

const CHROME = process.env.SC_CHROME_BIN;
if (!CHROME) throw new Error('SC_CHROME_BIN not set');
const WT = path.resolve(arg('root'));
const REF = arg('ref'); // e.g. dinov2-small
const OUT = arg('out', null);
// --pixels node: serve each image already resized/cropped/denormalised by Node's processor (a PNG of exactly
// the model input), so the browser's decode is the identity and any difference is the runtime alone.
const PIXELS = arg('pixels', 'real');
const PORT = 8907, HOST = 'bake.scaredycat.test';

const head = JSON.parse(fs.readFileSync(path.join(WT, 'data/image-head.json'), 'utf8'));
const emb = readEmb(REF, 'fp16');
if (!emb) throw new Error('no Node fp16 embeddings for ' + REF);
const dim = emb.meta.dim;
const ids = JSON.parse(fs.readFileSync(path.join(HERE, 'timing-subset.json'), 'utf8')).ids;
const idx = loadIndex();
const files = Object.fromEntries(ids.map(id => [id, imagePath(id, idx)]));
if (PIXELS === 'node') {
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
const nodeEmb = (id) => emb.data.subarray(emb.meta.ids.indexOf(id) * dim, (emb.meta.ids.indexOf(id) + 1) * dim);
const nodeScore = (e) => { let z = head.b; for (let i = 0; i < dim; i++) z += head.w[i] * e[i]; return 100 / (1 + Math.exp(-z)); };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

const server = http.createServer((req, res) => {
  const id = decodeURIComponent(req.url.slice(1));
  if (!files[id]) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': files[id].endsWith('.png') ? 'image/png' : 'image/jpeg' });
  res.end(fs.readFileSync(files[id]));
});
await new Promise(r => server.listen(PORT, r));

async function run(dtype, device) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${WT}`, `--load-extension=${WT}`, '--no-first-run', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`]
  });
  try {
    const sw = await (await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 })).worker();
    await sw.evaluate(async () => {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!ctx.length) await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['WORKERS'], justification: 'bakeoff browser check' });
    });
    const off = await browser.waitForTarget(t => t.url().includes('offscreen/offscreen.html'), { timeout: 20000 });
    const cdp = await off.createCDPSession();
    await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    const fetched = new Set();
    cdp.on('Network.requestWillBeSent', ev => { const m = /\/(vendor|models)\/(.+?)(\?|$)/.exec(ev.request.url); if (m) fetched.add(m[2]); });
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
    const per = {};
    for (const id of ids) per[id] = await ev(`__scEval.classify(${JSON.stringify(`http://${HOST}:${PORT}/${encodeURIComponent(id)}`)})`);
    const dS = [], cos = [], ms = [], perImage = {};
    let fails = 0;
    for (const id of ids) {
      const r = per[id];
      if (typeof r.score !== 'number') { fails++; continue; }
      const n = nodeEmb(id);
      dS.push(Math.abs(r.score - nodeScore(n)));
      let d = 0; for (let i = 0; i < dim; i++) d += n[i] * r.embedding[i];
      cos.push(d); ms.push(r.ms);
      perImage[id] = { score: r.score, nodeScore: nodeScore(n), cosine: d, ms: r.ms };
    }
    return {
      info, fails, n: dS.length, perImage,
      maxAbsDelta: Math.max(...dS), p95AbsDelta: pct(dS, 0.95), meanAbsDelta: dS.reduce((a, b) => a + b, 0) / dS.length,
      minCosine: Math.min(...cos), meanCosine: cos.reduce((a, b) => a + b, 0) / cos.length,
      perImageMsP50: pct(ms, 0.5), perImageMsP95: pct(ms, 0.95),
      jspiBuildFetched: [...fetched].some(f => /ort-wasm-simd-threaded\.jspi\./.test(f)),
      fetchedRuntime: [...fetched].filter(f => /ort-wasm/.test(f)), errors: errors.slice(0, 5)
    };
  } finally { await browser.close(); }
}

const out = { pixels: PIXELS, root: WT, ref: REF, head: head.model, runs: {} };
for (const dev of ['wasm', 'webgpu']) {
  process.stdout.write(`fp16/${dev} ... `);
  try { out.runs[dev] = { loaded: true, ...(await run('fp16', dev)) };
    const r = out.runs[dev]; console.log(`load ${r.info.loadMs}ms, max|d| ${r.maxAbsDelta.toFixed(3)}, p95 ${r.p95AbsDelta.toFixed(3)}, cos>=${r.minCosine.toFixed(5)}, ${r.perImageMsP50}ms/img, jspi ${r.jspiBuildFetched}`);
  } catch (e) { out.runs[dev] = { loaded: false, error: String(e.message || e) }; console.log('FAILED/UNAVAILABLE: ' + out.runs[dev].error); }
}
server.close();
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
process.exit(0);
