// Contact sheets per group: 6x5 tiles labelled with the image id -> .cache/sheets/<group>-NN.jpg
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(HERE, '.cache', 'img');
const OUT = path.join(HERE, '.cache', 'sheets');
const COLS = 6, ROWS = 5, TILE = 200, LAB = 28, GAP = 4;
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'images.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(HERE, '.cache', 'img-index.json'), 'utf8'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const groups = new Map();
for (const m of manifest) {
  const x = index[m.id];
  if (!x?.ok || x.excluded) continue;
  const k = `${m.label}-${m.group}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(m);
}
let sheets = 0;
for (const [g, items] of groups) {
  for (let p = 0; p * COLS * ROWS < items.length; p++) {
    const page = items.slice(p * COLS * ROWS, (p + 1) * COLS * ROWS);
    const W = COLS * (TILE + GAP) + GAP, H = ROWS * (TILE + LAB + GAP) + GAP;
    const comps = [];
    for (let i = 0; i < page.length; i++) {
      const m = page[i], x = index[m.id];
      const left = GAP + (i % COLS) * (TILE + GAP), top = GAP + Math.floor(i / COLS) * (TILE + LAB + GAP);
      try {
        const buf = await sharp(path.join(IMG, `${m.id}.${x.ext}`)).resize(TILE, TILE, { fit: 'contain', background: '#222' }).flatten({ background: '#222' }).jpeg({ quality: 80 }).toBuffer();
        comps.push({ input: buf, left, top });
      } catch { /* leave tile blank */ }
      const label = `${m.id}${m.calibration ? '*' : ''} ${m.split[0]}`;
      const svg = `<svg width="${TILE}" height="${LAB}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="3" y="12" font-family="Helvetica,Arial" font-size="11" fill="#fff">${esc(label)}</text><text x="3" y="25" font-family="Helvetica,Arial" font-size="10" fill="#9ad">${esc((m.title || '').slice(0, 34))}${m.year ? ' ' + m.year : ''}</text></svg>`;
      comps.push({ input: Buffer.from(svg), left, top: top + TILE });
    }
    const file = path.join(OUT, `${g}-${String(p + 1).padStart(2, '0')}.jpg`);
    await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } }).composite(comps).jpeg({ quality: 82 }).toFile(file);
    sheets++;
  }
}
console.log(`wrote ${sheets} sheets for ${groups.size} groups to ${OUT}`);
process.exit(0);
