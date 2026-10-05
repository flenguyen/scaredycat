// Phase E2 summary: parity numbers for the in-browser embeddings -> .cache/browser-embed-summary.json
import fs from 'node:fs';
import { CACHE as C, HERE } from './lib.mjs';
const rd = (b) => { const m = JSON.parse(fs.readFileSync(b + '.json', 'utf8')); const r = fs.readFileSync(b + '.f32'); return { m, d: new Float32Array(r.buffer, r.byteOffset, r.byteLength / 4) }; };
const sub = JSON.parse(fs.readFileSync(HERE + '/parity-subset.json', 'utf8')).ids;
const stat = a => ({ min: Math.min(...a), mean: a.reduce((x, y) => x + y, 0) / a.length });
const pos = e => (e.pos ??= new Map(e.m.ids.map((id, i) => [id, i])));
const row = (e, id) => { const i = pos(e).get(id), D = e.m.dim; return e.d.subarray(i * D, (i + 1) * D); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const nrm = a => Math.sqrt(dot(a, a));
const out = {};
for (const [name, view] of [['mobileclip-s0', 'crop'], ['tinyclip-vit-8m-16-yfcc15m', 'crop'], ['tinyclip-vit-8m-16-yfcc15m', 'squash'], ['tinyclip-vit-40m-32-laion400m', 'crop'], ['tinyclip-vit-40m-32-laion400m', 'squash']]) {
  const w = rd(`${C}/emb-browser/${name}-${view}-wasm`), g = rd(`${C}/emb-browser/${name}-${view}-webgpu`), nd = rd(`${C}/emb/${name}-fp16-${view}`);
  const cw = [], cn = [], cng = [];
  for (const id of sub) { const a = row(w, id), b = row(g, id), n = row(nd, id); cw.push(dot(a, b)); cn.push(dot(a, n) / (nrm(a) * nrm(n))); cng.push(dot(b, n) / (nrm(b) * nrm(n))); }
  const o = { embedded: w.m.embedded, failed: w.m.failures.length, failures: w.m.failures, wasmMsP50: w.m.msP50, wasmMsP95: w.m.msP95, webgpuMsP50: g.m.msP50, loadMsWasm: w.m.loadMs,
    wasmVsWebgpuCos: stat(cw), browserWasmVsNodeCos: stat(cn), browserWebgpuVsNodeCos: stat(cng), webgpuEmbedded: g.m.embedded };
  if (name === 'mobileclip-s0') {
    const zs = JSON.parse(fs.readFileSync(`${C}/scores/mobileclip-s0-fp16-zs.json`, 'utf8'));
    const all = w.m.ids.filter(id => w.m.scores[id] != null && zs[id] != null).map(id => Math.abs(w.m.scores[id] - zs[id]));
    o.zeroShotMaxAbsDelta = Math.max(...all); o.zeroShotMeanAbsDelta = all.reduce((x, y) => x + y, 0) / all.length; o.zeroShotCompared = all.length; o.zeroShotOver2 = all.filter(x => x > 2).length;
    o.zeroShotMaxAbsDeltaWebgpuSubset = Math.max(...sub.map(id => Math.abs(g.m.scores[id] - zs[id])));
  }
  out[`${name}/${view}`] = o;
}
fs.writeFileSync(`${C}/browser-embed-summary.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, (k, v) => typeof v === 'number' ? +v.toFixed(5) : v));
