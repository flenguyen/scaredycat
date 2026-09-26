/**
 * fp16 vs fp32 vision tower, in the real extension runtime.
 *
 * Launches Chrome for Testing with the unpacked extension once per
 * (dtype, backend) combination, drives the offscreen classifier over CDP
 * through its __scEval dev hook, and scores the calibration posters that the
 * ml-bridge.js bars were tuned on. Reports per-image deltas vs fp32/WebGPU,
 * flags any image that crosses a decision bar (76/65/80/40/41) under fp16 but
 * not under fp32, and checks that fp16 loads on the WASM fallback at all.
 *
 *   SC_CHROME_BIN=<chrome> node eval/fp16-compare.mjs [--tolerance 2]
 *
 * Requires BOTH models/Xenova/mobileclip_s0/onnx/vision_model_fp16.onnx (shipped)
 * and vision_model.onnx (fp32 baseline) in models/ for the run: copy the fp32
 * file in from eval/.model-cache, then remove it again (npm run pack refuses to
 * ship two vision models).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SC_CHROME_BIN;
if (!CHROME) throw new Error('SC_CHROME_BIN not set');
const args = process.argv.slice(2);
const TOLERANCE = parseFloat(args[args.indexOf('--tolerance') + 1] || '2');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const CALIB_DIR = '/tmp/scaredycat-fixtures/calib';
const BARS = [41, 40, 65, 76, 80]; // ml-bridge.js decision bars
const PORT = 8906;

for (const f of ['onnx/vision_model.onnx', 'onnx/vision_model_fp16.onnx']) {
  if (!fs.existsSync(path.join(ROOT, 'models/Xenova/mobileclip_s0', f))) {
    throw new Error(`missing models/Xenova/mobileclip_s0/${f}`);
  }
}

const images = fs.readdirSync(CALIB_DIR).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
if (!images.length) throw new Error(`no calibration images in ${CALIB_DIR}`);

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  const file = path.join(CALIB_DIR, name);
  if (!images.includes(name)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg' });
  res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(PORT, r));

async function run(dtype, device) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run']
  });
  try {
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 });
    const sw = await swTarget.worker();
    // Create the offscreen document WITHOUT warming it, so the eval hook gets
    // to pick dtype/device before the model loads.
    await sw.evaluate(async () => {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!ctx.length) {
        await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['WORKERS'], justification: 'fp16 comparison harness' });
      }
    });
    const offTarget = await browser.waitForTarget(t => t.url().includes('offscreen/offscreen.html'), { timeout: 20000 });
    const cdp = await offTarget.createCDPSession();
    // Surface the offscreen document's console (ORT/transformers.js errors),
    // and which runtime files it actually loads (which wasm variant ships).
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (ev) => {
      if (/\/vendor\/|\/models\//.test(ev.request.url)) console.log(`    [offscreen fetch] ${ev.request.url.split('/').slice(-2).join('/')}`);
    });
    cdp.on('Runtime.consoleAPICalled', (ev) => {
      if (ev.type === 'error' || ev.type === 'warning') {
        console.log(`    [offscreen ${ev.type}] ${ev.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400)}`);
      }
    });
    cdp.on('Runtime.exceptionThrown', (ev) => {
      console.log(`    [offscreen exception] ${(ev.exceptionDetails.exception?.description || ev.exceptionDetails.text || '').slice(0, 400)}`);
    });
    const evalIn = async (expression) => {
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || JSON.stringify(exceptionDetails));
      return result.value;
    };
    // The module script may still be loading when the target appears.
    let info = null, lastErr = null;
    for (let i = 0; i < 100 && !info; i++) {
      try { info = await evalIn(`globalThis.__scEval ? __scEval.ready(${JSON.stringify(dtype)}, ${JSON.stringify(device)}) : null`); } catch (e) { lastErr = e; info = null; }
      if (!info) await new Promise(r => setTimeout(r, 300));
    }
    if (!info) throw new Error('classifier never became ready: ' + (lastErr && lastErr.message));
    if (info.dtype !== dtype || info.device !== device) throw new Error(`wanted ${dtype}/${device}, got ${info.dtype}/${info.device}`);
    const scores = {};
    for (const img of images) {
      scores[img] = await evalIn(`__scEval.classify(${JSON.stringify(`http://localhost:${PORT}/${encodeURIComponent(img)}`)})`);
    }
    // Steady-state per-image latency: rerun a few (fetch is local).
    const timings = [];
    for (const img of images.slice(0, 6)) {
      const r = await evalIn(`__scEval.classify(${JSON.stringify(`http://localhost:${PORT}/${encodeURIComponent(img)}`)})`);
      timings.push(r.ms);
    }
    return { info, scores, medianMs: timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)] };
  } finally {
    await browser.close();
  }
}

const runs = {};
for (const [label, dtype, device] of [['fp32-webgpu', 'fp32', 'webgpu'], ['fp16-webgpu', 'fp16', 'webgpu'], ['fp32-wasm', 'fp32', 'wasm'], ['fp16-wasm', 'fp16', 'wasm']]) {
  if (ONLY && !ONLY.includes(label)) continue;
  process.stdout.write(`running ${label} ... `);
  try {
    runs[label] = await run(dtype, device);
    console.log(`ready in ${runs[label].info.loadMs}ms on ${runs[label].info.device}/${runs[label].info.dtype}, per-image median ${runs[label].medianMs}ms`);
  } catch (e) {
    runs[label] = { error: String(e.message || e) };
    console.log(`FAILED: ${runs[label].error}`);
  }
}
server.close();

if (ONLY) process.exit(Object.values(runs).some(r => r.error) ? 1 : 0);
const ref = runs['fp32-webgpu'];
if (!ref || ref.error) { console.error('reference run failed; cannot compare'); process.exit(1); }
const allLoaded = Object.values(runs).every(r => !r.error);
const crossings = (a, b) => BARS.filter(bar => (a >= bar) !== (b >= bar));
console.log(`\n${'image'.padEnd(20)} ${Object.keys(runs).map(k => k.padStart(12)).join(' ')}   Δfp16(gpu)  crossings`);
let maxDelta = 0, crossed = 0;
for (const img of images) {
  const cells = Object.keys(runs).map(k => {
    const s = runs[k].scores?.[img];
    return s && typeof s.score === 'number' ? s.score.toFixed(1).padStart(12) : (s ? s.reason : 'n/a').padStart(12);
  });
  const a = ref.scores[img]?.score, b = runs['fp16-webgpu']?.scores?.[img]?.score;
  let delta = '', cross = '';
  if (typeof a === 'number' && typeof b === 'number') {
    delta = (b - a).toFixed(1).padStart(8);
    maxDelta = Math.max(maxDelta, Math.abs(b - a));
    const c = crossings(a, b);
    if (c.length) { crossed++; cross = 'CROSSES ' + c.join(','); }
  }
  console.log(`${img.padEnd(20)} ${cells.join(' ')} ${delta}  ${cross}`);
}
const wasmOk = runs['fp16-wasm'] && !runs['fp16-wasm'].error && runs['fp16-wasm'].info.device === 'wasm' &&
  Object.values(runs['fp16-wasm'].scores).every(s => typeof s.score === 'number');
console.log(`\nmax |Δ| fp16 vs fp32 on WebGPU: ${maxDelta.toFixed(2)} (tolerance ${TOLERANCE}); bar crossings: ${crossed}; fp16 on WASM: ${wasmOk ? 'OK' : 'FAILED'}`);
if (!allLoaded) console.log('fp16 must load on BOTH backends; a failed run fails the gate.');
const pass = allLoaded && maxDelta <= TOLERANCE && crossed === 0 && wasmOk;
console.log(`FP16 GATE ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
