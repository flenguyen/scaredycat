// Timing pass. Run serially with nothing else running.
//   node timing.mjs                      -> driver: runs each model x dtype in a fresh process, merges .cache/timing.json
//   node timing.mjs --model m --dtype d  -> one measurement (prints JSON line)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HERE, CACHE, MODELS, DTYPES, images, loadIndex, imagePath, loadVision, arg, embedFile } from './lib.mjs';

const subsetFile = path.join(HERE, 'timing-subset.json');
function makeSubset() {
  if (fs.existsSync(subsetFile)) return JSON.parse(fs.readFileSync(subsetFile, 'utf8')).ids;
  const h = (id) => crypto.createHash('sha256').update('1337:' + id).digest().readUInt32BE(0);
  const byGroup = {}; images().forEach(i => (byGroup[i.group] ||= []).push(i));
  Object.values(byGroup).forEach(a => a.sort((x, y) => h(x.id) - h(y.id)));
  const groups = Object.keys(byGroup).sort(), ids = []; let r = 0;
  while (ids.length < 50) { for (const g of groups) { if (ids.length < 50 && byGroup[g][r]) ids.push(byGroup[g][r].id); } r++; }
  fs.writeFileSync(subsetFile, JSON.stringify({ seed: 1337, method: 'round-robin over groups, within group by sha256("1337:"+id)', ids }, null, 1) + '\n');
  return ids;
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

if (arg('model')) {
  const ids = makeSubset(), idx = loadIndex(), m = arg('model'), d = arg('dtype');
  const t0 = performance.now();
  const { processor, model } = await loadVision(m, d);
  const loadMs = performance.now() - t0;
  const files = ids.map(id => imagePath(id, idx));
  // embedFile includes file decode; keep decode out of the timed section by pre-reading into RawImage is not
  // possible with the shared helper, so time the whole call (decode is small and identical for every model).
  for (let i = 0; i < 3; i++) await embedFile(processor, model, files[i]);
  const times = [];
  for (const f of files) { const t = performance.now(); await embedFile(processor, model, f); times.push(performance.now() - t); }
  console.log('RESULT ' + JSON.stringify({ model: m, dtype: d, loadMs, n: times.length, p50Ms: pct(times, 0.5), p95Ms: pct(times, 0.95), meanMs: times.reduce((a, b) => a + b) / times.length, maxRssMB: process.resourceUsage().maxRSS / 1024 }));
  process.exit(0);
}
makeSubset();
const outFile = path.join(CACHE, 'timing.json');
const all = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { note: 'per-image ms includes image decode + preprocess + inference, 1 thread, onnxruntime-node, fresh process per row, 3 warm-up images, 50 timed', rows: [] };
for (const m of MODELS) for (const d of DTYPES) {
  if (all.rows.some(r => r.model === m && r.dtype === d)) continue;
  const emb = JSON.parse(fs.readFileSync(path.join(CACHE, 'emb', `${m}-${d}.json`), 'utf8'));
  if (emb.status !== 'ok') { all.rows.push({ model: m, dtype: d, failed: emb.reason.slice(0, 120) }); continue; }
  const out = execFileSync('node', [path.join(HERE, 'timing.mjs'), '--model', m, '--dtype', d], { encoding: 'utf8' });
  const row = JSON.parse(out.split('\n').find(l => l.startsWith('RESULT ')).slice(7)); all.rows.push(row);
  console.log(m, d, 'load', row.loadMs.toFixed(0), 'p50', row.p50Ms.toFixed(1), 'p95', row.p95Ms.toFixed(1), 'rss', row.maxRssMB.toFixed(0));
  fs.writeFileSync(outFile, JSON.stringify(all, null, 1));
}
fs.writeFileSync(outFile, JSON.stringify(all, null, 1));
process.exit(0);
