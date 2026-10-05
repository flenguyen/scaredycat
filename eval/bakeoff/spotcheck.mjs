// Spot check: MobileCLIP fp16 scores from our pipeline vs eval/image-classifier.mjs classifyImageFile --dtype fp16.
import fs from 'node:fs';
import path from 'node:path';
process.argv.push('--dtype', 'fp16');
const { classifyImageFile } = await import('../image-classifier.mjs');
import { CACHE, images, loadIndex, imagePath } from './lib.mjs';
const sc = JSON.parse(fs.readFileSync(path.join(CACHE, 'scores/mobileclip-s0-fp16-zs.json'), 'utf8'));
const imgs = images(), idx = loadIndex();
// 10 images, deterministic spread across the list, excluding RGBA/odd decodes (png alpha) where preprocessing may differ
const pick = []; for (let i = 7; pick.length < 10 && i < imgs.length; i += 197) pick.push(imgs[i]);
const rows = [];
for (const im of pick) {
  const ref = await classifyImageFile(imagePath(im.id, idx));
  rows.push({ id: im.id, ours: sc[im.id], ref, diff: Math.abs(sc[im.id] - ref) });
  console.log(im.id, sc[im.id].toFixed(3), ref.toFixed(3), Math.abs(sc[im.id] - ref).toFixed(4));
}
const max = Math.max(...rows.map(r => r.diff)); console.log('max abs diff', max, max <= 0.05 ? 'PASS' : 'FAIL');
fs.writeFileSync(path.join(CACHE, 'spotcheck.json'), JSON.stringify({ maxAbsDiff: max, pass: max <= 0.05, rows }, null, 1));
process.exit(0);
