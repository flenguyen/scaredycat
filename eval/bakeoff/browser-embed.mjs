// Phase E2: embed images inside Chrome through the extension's real decode path.
//   SC_CHROME_BIN=<chrome> node eval/bakeoff/browser-embed.mjs --root <worktree> --name <config> --view crop|squash --device wasm|webgpu [--ids file.json]
// crop = the extension's decode (canvas resize to 256 short edge + centre crop 256, then the model's processor).
// squash = whole image resized to the model's square input (offscreen/classifier.js decodeSquash; worktrees older
// than the 2.0 model swap need the classifier-squash.diff patch).
// <root> is a git worktree of this repo (never the repo itself: its models/ is rewritten). The candidate is staged
// into <root>/models/<name>/ with a placeholder manifest (zero head, identity calibration): only the embedding is
// read here, and the real head and bars come later from analyze.py.
// Writes .cache/emb-browser/<name>-<view>-<device>.f32 (+ .json). Resumable via a .partial.jsonl checkpoint.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { CACHE, ROOT, images, loadIndex, imagePath, arg } from './lib.mjs';

const CHROME = process.env.SC_CHROME_BIN;
if (!CHROME) throw new Error('SC_CHROME_BIN not set');
const WT = path.resolve(arg('root')), NAME = arg('name'), VIEW = arg('view', 'crop'), DEVICE = arg('device', 'wasm');
const IDS = arg('ids', null);
const PORT = 8908, HOST = 'bake.scaredycat.test';
const outDir = path.join(CACHE, 'emb-browser'); fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, `${NAME}-${VIEW}-${DEVICE}`);
const partial = base + '.partial.jsonl';

// Stage the model into the worktree. MobileCLIP (the pre-2.0 baseline) needs a worktree checked out before the
// swap, where it is restored from git.
if (path.resolve(WT) === path.resolve(ROOT)) throw new Error('--root must be a worktree, not this repo (its models/ would be rewritten)');
if (NAME === 'mobileclip-s0') {
  (await import('node:child_process')).execFileSync('git', ['-C', WT, 'checkout', '--', 'models']);
} else {
  const src = path.join(ROOT, 'eval/.model-cache/bakeoff', NAME), dst = path.join(WT, 'models', NAME);
  fs.mkdirSync(path.join(dst, 'onnx'), { recursive: true });
  for (const f of ['config.json', 'preprocessor_config.json']) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  fs.copyFileSync(path.join(src, 'onnx/vision_model_fp16.onnx'), path.join(dst, 'onnx/vision_model_fp16.onnx'));
  const dim = JSON.parse(fs.readFileSync(path.join(src, 'config.json'), 'utf8')).projection_dim || 512;
  fs.writeFileSync(path.join(dst, 'head.json'), JSON.stringify({ model: NAME, view: VIEW, dim, normalise: 'l2', b: 0, w: new Array(dim).fill(0) }));
  const p = JSON.parse(fs.readFileSync(path.join(src, 'preprocessor_config.json'), 'utf8'));
  const input = typeof p.size === 'number' ? p.size : (p.size?.shortest_edge ?? p.size?.height);
  fs.writeFileSync(path.join(WT, 'models/image-model.json'), JSON.stringify({
    schema: 1, id: NAME, version: `${NAME}-embed-staging`, dir: NAME, dtype: 'fp16',
    decode: { view: VIEW, size: VIEW === 'squash' ? input : 256 },
    scorer: { type: 'head', file: 'head.json' }, calibration: { knots: [[0, 0], [100, 100]] },
    source: { hfId: '', revision: '', licence: '' }, files: ['config.json', 'preprocessor_config.json', 'onnx/vision_model_fp16.onnx', 'head.json']
  }, null, 1));
}

const all = images(), idx = loadIndex();
let ids = all.map(i => i.id);
if (IDS) { const j = JSON.parse(fs.readFileSync(IDS, 'utf8')); ids = Array.isArray(j) ? j : j.ids; }
const files = Object.fromEntries(ids.map(id => [id, imagePath(id, idx)]));

const done = new Map(); // id -> { score, reason, ms, embedding }
if (fs.existsSync(partial)) for (const l of fs.readFileSync(partial, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); done.set(r.id, r); }
console.log(`${NAME} ${VIEW} ${DEVICE}: ${ids.length} images, ${done.size} already done`);

const server = http.createServer((req, res) => {
  const id = decodeURIComponent(req.url.slice(1));
  if (!files[id]) { res.writeHead(404); return res.end(); }
  const ext = files[id].split('.').pop().toLowerCase();
  const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' }[ext] || 'image/jpeg';
  res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(files[id]));
});
await new Promise(r => server.listen(PORT, r));

let loadMs = null, info = null;
async function pass() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${WT}`, `--load-extension=${WT}`, '--no-first-run', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`]
  });
  try {
    const sw = await (await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 })).worker();
    await sw.evaluate(async () => {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!ctx.length) await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['WORKERS'], justification: 'bakeoff embeddings' });
    });
    const off = await browser.waitForTarget(t => t.url().includes('offscreen/offscreen.html'), { timeout: 20000 });
    const cdp = await off.createCDPSession();
    await cdp.send('Runtime.enable');
    const ev = async (expression) => {
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || JSON.stringify(exceptionDetails));
      return result.value;
    };
    let lastErr = null; info = null;
    for (let i = 0; i < 100 && !info; i++) {
      try { info = await ev(`globalThis.__scEval ? __scEval.ready('fp16', ${JSON.stringify(DEVICE)}) : null`); } catch (e) { lastErr = e; }
      if (!info) await new Promise(r => setTimeout(r, 300));
    }
    if (!info) throw new Error('never ready: ' + (lastErr && lastErr.message));
    if (info.device !== DEVICE) throw new Error(`wanted ${DEVICE}, got ${info.device} (fell back)`);
    loadMs = info.loadMs;
    const opts = VIEW === 'squash' ? { decode: 'squash' } : {};
    let n = 0;
    for (const id of ids) {
      if (done.has(id)) continue;
      const r = await ev(`__scEval.classify(${JSON.stringify(`http://${HOST}:${PORT}/${encodeURIComponent(id)}`)}, ${JSON.stringify(opts)})`);
      const rec = { id, score: typeof r.score === 'number' ? r.score : null, reason: r.reason, ms: r.ms, embedding: r.embedding || null };
      done.set(id, rec); fs.appendFileSync(partial, JSON.stringify(rec) + '\n');
      if (++n % 250 === 0) console.log(`  ${done.size}/${ids.length}`);
    }
  } finally { await browser.close(); }
}

let ok = false;
for (let attempt = 0; attempt < 6 && !ok; attempt++) {
  try { await pass(); ok = true; } catch (e) { console.log('pass failed, retrying:', String(e.message || e).slice(0, 200)); }
}
server.close();
if (!ok) { console.log('GAVE UP; checkpoint kept at', partial); process.exit(1); }

let dim = 0; for (const r of done.values()) if (r.embedding) { dim = r.embedding.length; break; }
const out = new Float32Array(ids.length * dim), failures = [], ms = [];
ids.forEach((id, i) => {
  const r = done.get(id);
  if (r.embedding && r.embedding.every(Number.isFinite)) { out.set(r.embedding, i * dim); ms.push(r.ms); }
  else failures.push({ id, reason: r.embedding ? 'nonfinite' : r.reason });
});
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const meta = {
  name: NAME, view: VIEW, device: DEVICE, dtype: 'fp16', dim, n: ids.length, embedded: ids.length - failures.length,
  ids, failures, msP50: pct(ms, 0.5), msP95: pct(ms, 0.95), loadMs, info,
  ...(NAME === 'mobileclip-s0' ? { scores: Object.fromEntries(ids.map(id => [id, done.get(id).score])) } : {})
};
fs.writeFileSync(base + '.f32', Buffer.from(out.buffer));
fs.writeFileSync(base + '.json', JSON.stringify(meta));
fs.unlinkSync(partial);
console.log(`done ${base}: embedded ${meta.embedded}/${meta.n}, failures ${failures.length}, p50 ${meta.msP50}ms p95 ${meta.msP95}ms, load ${loadMs}ms`);
process.exit(0);
