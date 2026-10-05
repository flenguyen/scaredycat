// Zero-shot scoring helpers for phase C. Uses the canonical scoreEmbedding from eval/image-classifier.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { scoreEmbedding } from '../image-classifier.mjs';
import { readEmb, images } from './lib.mjs';

export function loadPromptDir(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'prompt-embeddings.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(dir, meta.embeddings));
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  return { ...meta, prompts: meta.prompts.map((p, i) => ({ ...p, embedding: f.subarray(i * meta.dim, (i + 1) * meta.dim) })) };
}

export function scoreAll(emb, pd) {
  const { data, meta } = emb, out = new Array(meta.n);
  for (let i = 0; i < meta.n; i++) out[i] = scoreEmbedding(data.subarray(i * meta.dim, (i + 1) * meta.dim), pd.prompts, pd.logitScale);
  return out;
}

export function rocAuc(pos, neg) { // Mann-Whitney with ties
  const all = [...pos.map(s => [s, 1]), ...neg.map(s => [s, 0])].sort((a, b) => a[0] - b[0]);
  let rankSum = 0, i = 0;
  while (i < all.length) { let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) if (all[k][1]) rankSum += r; i = j + 1; }
  return (rankSum - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}

/** threshold where recall (score >= t) on positives is just >= target; returns fraction of neg >= t. */
export function fbrAtRecall(pos, neg, target = 0.8) {
  const s = [...pos].sort((a, b) => b - a);
  const k = Math.ceil(target * s.length) - 1; const t = s[k];
  return { threshold: t, fbr: neg.filter(x => x >= t).length / neg.length, recall: pos.filter(x => x >= t).length / pos.length };
}

const EASY = new Set(['photo', 'ui-screenshot', 'logo', 'food', 'product', 'people', 'kids-cartoon']);
export function splitMetrics(scores, split) {
  const imgs = images(); const pos = [], neg = [], hard = [];
  imgs.forEach((im, i) => {
    if (im.split !== split) return;
    if (im.label === 'horror') pos.push(scores[i]);
    else { neg.push(scores[i]); if (!EASY.has(im.group)) hard.push(scores[i]); }
  });
  return { pos, neg, hard };
}
