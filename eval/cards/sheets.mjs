/**
 * Contact sheets for labelling captured cards: one tile per media element
 * with its capture id, index and the card's text. Verdicts are left off on
 * purpose so they can't steer the labels.
 *
 *   node eval/cards/sheets.mjs [--only id,id] [--unlabelled]
 *
 * Output: .cache/sheets/<capture>-NN.jpg
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { CACHE, ASSETS, CORPUS, readJson, listCaptures } from './lib.mjs';

const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const ONLY = argVal('--only', null)?.split(',');
const UNLABELLED = args.includes('--unlabelled');
const OUT = path.join(CACHE, 'sheets');
fs.mkdirSync(OUT, { recursive: true });

const assetIndex = readJson(path.join(CACHE, 'assets.json'), {});
const corpus = readJson(CORPUS, { items: {} });
const COLS = 5, ROWS = 4, TW = 300, TH = 200, LAB = 64, GAP = 6;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/[^\x20-\x7E]/g, '');

function wrap(text, width, lines) {
  const words = text.split(' ');
  const out = [''];
  for (const w of words) {
    const line = out[out.length - 1];
    if ((line + ' ' + w).trim().length > width) {
      if (out.length === lines) break;
      out.push(w);
    } else out[out.length - 1] = (line + ' ' + w).trim();
  }
  return out;
}

let total = 0;
for (const c of listCaptures().filter(c => !ONLY || ONLY.includes(c.id))) {
  const media = c.media.filter(m => !UNLABELLED || !corpus.items[`${c.id}#${m.idx}`]);
  for (let p = 0; p * COLS * ROWS < media.length; p++) {
    const page = media.slice(p * COLS * ROWS, (p + 1) * COLS * ROWS);
    const W = COLS * (TW + GAP) + GAP, H = ROWS * (TH + LAB + GAP) + GAP;
    const comps = [];
    for (let i = 0; i < page.length; i++) {
      const m = page[i];
      const left = GAP + (i % COLS) * (TW + GAP), top = GAP + Math.floor(i / COLS) * (TH + LAB + GAP);
      const a = assetIndex[m.src];
      if (a?.ok) {
        try {
          const buf = await sharp(path.join(ASSETS, a.key)).resize(TW, TH, { fit: 'contain', background: '#222' })
            .flatten({ background: '#222' }).jpeg({ quality: 80 }).toBuffer();
          comps.push({ input: buf, left, top });
        } catch { /* blank tile */ }
      }
      const lines = wrap((m.cardText || '').replace(/\s+/g, ' '), 52, 3);
      const svg = `<svg width="${TW}" height="${LAB}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/>` +
        `<text x="4" y="13" font-family="Helvetica,Arial" font-size="12" font-weight="bold" fill="#fd6">${esc(`#${m.idx} ${m.tag} ${m.w}x${m.h}`)}</text>` +
        lines.map((l, k) => `<text x="4" y="${28 + k * 13}" font-family="Helvetica,Arial" font-size="11" fill="#cde">${esc(l)}</text>`).join('') +
        `</svg>`;
      comps.push({ input: Buffer.from(svg), left, top: top + TH });
    }
    const file = path.join(OUT, `${c.id}-${String(p + 1).padStart(2, '0')}.jpg`);
    await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } }).composite(comps).jpeg({ quality: 82 }).toFile(file);
    total++;
  }
}
console.log(`${total} sheets in ${OUT}`);
