// Embed every image in images.json with one model's vision tower at one dtype.
// Usage: node embed.mjs --model <name> --dtype fp32|fp16|q8
// Writes .cache/emb/<name>-<dtype>.f32 (L2-normalised, row-major) + .json. Resumable.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE, images, loadIndex, imagePath, loadVision, embedFile, l2, arg, modelLocation } from './lib.mjs';

const name = arg('model'), dtype = arg('dtype', 'fp32');
const view = arg('view', null); // crop | squash: emulate the extension's geometry (default: the processor's own)
const idsFile = arg('ids', null);
const base = path.join(CACHE, 'emb', `${name}-${dtype}${view ? '-' + view : ''}`);
if (fs.existsSync(base + '.json')) { console.log('exists, skipping', base); process.exit(0); }

const idList = idsFile ? (j => Array.isArray(j) ? j : j.ids)(JSON.parse(fs.readFileSync(idsFile, 'utf8'))) : null;
const imgs = idList ? idList.map(id => ({ id })) : images(), idx = loadIndex();
const meta = { model: name, dtype, view, ...modelLocation(name), n: imgs.length, ids: imgs.map(i => i.id) };
const fail = (reason) => {
  fs.writeFileSync(base + '.json', JSON.stringify({ ...meta, status: 'failed', reason }, null, 1));
  console.log('FAILED', name, dtype, reason); process.exit(0);
};

let processor, model;
try { ({ processor, model } = await loadVision(name, dtype)); }
catch (e) { fail('load: ' + String(e.message || e).slice(0, 300)); }

let out = null, dim = 0, bad = 0;
const t0 = Date.now();
for (let i = 0; i < imgs.length; i++) {
  let v;
  try { v = await embedFile(processor, model, imagePath(imgs[i].id, idx), view); }
  catch (e) { fail(`run on ${imgs[i].id}: ` + String(e.message || e).slice(0, 300)); }
  if (!out) { dim = v.length; out = new Float32Array(imgs.length * dim); }
  let finite = true; for (let k = 0; k < v.length; k++) if (!Number.isFinite(v[k])) { finite = false; break; }
  const e = finite ? l2(v) : null;
  if (!e || !e.every(Number.isFinite)) { bad++; if (bad > 5) fail(`non-finite output on ${bad} images (e.g. ${imgs[i].id})`); continue; }
  out.set(e, i * dim);
  if (i % 200 === 0) console.log(name, dtype, i, '/', imgs.length, ((Date.now() - t0) / 1000).toFixed(0) + 's');
}
if (bad) fail(`non-finite output on ${bad} images`);
fs.writeFileSync(base + '.f32', Buffer.from(out.buffer));
fs.writeFileSync(base + '.json', JSON.stringify({ ...meta, status: 'ok', dim, seconds: (Date.now() - t0) / 1000 }, null, 1));
console.log('done', name, dtype, dim, ((Date.now() - t0) / 1000).toFixed(0) + 's');
process.exit(0);
