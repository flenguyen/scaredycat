// Phase D2 robustness (informative, not gating): Node embeddings of the 200 parity-subset images after
//   jpeg70 = re-encoded as JPEG quality 70 at full size
//   half   = downscaled to 50% (sharp's default lanczos3), saved losslessly (PNG), then decoded again
// with the extension's geometry emulated (--view crop|squash, see lib.mjs embedFile), fp16.
// Usage: node eval/bakeoff/robust-embed.mjs --model <name> --view crop|squash
// Writes .cache/emb/robust/<name>-fp16-<view>-<variant>.f32 (+ .json), L2-normalised, in parity-subset.json order.
// The untransformed reference is .cache/emb/<name>-fp16-<view>.f32 (phase E2, same ids, same code path).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { HERE, CACHE, loadIndex, imagePath, loadVision, embedFile, l2, arg } from './lib.mjs';

const name = arg('model'), view = arg('view');
if (!name || !['crop', 'squash'].includes(view)) throw new Error('need --model and --view crop|squash');
const ids = JSON.parse(fs.readFileSync(path.join(HERE, 'parity-subset.json'), 'utf8')).ids;
const idx = loadIndex();
const imgDir = path.join(CACHE, 'robust-img'), outDir = path.join(CACHE, 'emb', 'robust');
fs.mkdirSync(outDir, { recursive: true });

const VARIANTS = {
  jpeg70: { ext: 'jpg', make: (src) => sharp(src).flatten({ background: '#fff' }).jpeg({ quality: 70 }) },
  half: {
    ext: 'png', make: async (src) => {
      const m = await sharp(src).metadata();
      return sharp(src).flatten({ background: '#fff' })
        .resize(Math.max(1, Math.round(m.width / 2)), Math.max(1, Math.round(m.height / 2))).png();
    }
  }
};

// Transformed files are shared by every model (made once, idempotent).
for (const [v, spec] of Object.entries(VARIANTS)) {
  fs.mkdirSync(path.join(imgDir, v), { recursive: true });
  for (const id of ids) {
    const out = path.join(imgDir, v, `${id}.${spec.ext}`);
    if (!fs.existsSync(out)) await (await spec.make(imagePath(id, idx))).toFile(out);
  }
}

const { processor, model } = await loadVision(name, 'fp16');
for (const [v, spec] of Object.entries(VARIANTS)) {
  const base = path.join(outDir, `${name}-fp16-${view}-${v}`);
  if (fs.existsSync(base + '.json')) { console.log('exists', base); continue; }
  let out = null, dim = 0;
  for (let i = 0; i < ids.length; i++) {
    const e = l2(await embedFile(processor, model, path.join(imgDir, v, `${ids[i]}.${spec.ext}`), view));
    if (!e.every(Number.isFinite)) throw new Error(`non-finite ${ids[i]}`);
    if (!out) { dim = e.length; out = new Float32Array(ids.length * dim); }
    out.set(e, i * dim);
  }
  fs.writeFileSync(base + '.f32', Buffer.from(out.buffer));
  fs.writeFileSync(base + '.json', JSON.stringify({ model: name, dtype: 'fp16', view, variant: v, n: ids.length, dim, ids }));
  console.log('done', base);
}
process.exit(0);
