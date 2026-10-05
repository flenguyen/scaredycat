// Show TRAIN-split errors for a model's prompt set (never touches test). Usage: --model <m> --variant <v> [--dtype fp32]
import path from 'node:path';
import { CACHE, readEmb, images, arg } from './lib.mjs';
import { loadPromptDir, scoreAll, rocAuc, fbrAtRecall } from './score-lib.mjs';
const m = arg('model'), v = arg('variant', 'shipped');
const emb = readEmb(m, arg('dtype', 'fp32')); const pd = loadPromptDir(path.join(CACHE, 'prompts', m, v));
const sc = scoreAll(emb, pd), imgs = images();
const rows = imgs.map((im, i) => ({ ...im, s: sc[i] })).filter(r => r.split === 'train');
const hor = rows.filter(r => r.label === 'horror'), saf = rows.filter(r => r.label === 'safe');
console.log(m, v, 'train AUC', rocAuc(hor.map(r => r.s), saf.map(r => r.s)).toFixed(4));
const byGroup = (rs) => { const o = {}; rs.forEach(r => (o[r.group] ||= []).push(r.s)); return Object.entries(o).map(([g, a]) => `${g}:${(a.reduce((x, y) => x + y) / a.length).toFixed(0)}`).join(' '); };
console.log('mean score horror groups', byGroup(hor)); console.log('mean score safe groups', byGroup(saf));
console.log('--- lowest horror'); hor.sort((a, b) => a.s - b.s).slice(0, +arg('n', 15)).forEach(r => console.log(r.s.toFixed(1), r.group, r.title));
console.log('--- highest safe'); saf.sort((a, b) => b.s - a.s).slice(0, +arg('n', 20)).forEach(r => console.log(r.s.toFixed(1), r.group, r.title));
// which prompt wins most for those errors
const top = (rs, label) => { const cnt = {}; rs.forEach(r => { const i = imgs.indexOf(imgs.find(x => x.id === r.id)); let best = -1, bs = -9; pd.prompts.forEach((p, k) => { let d = 0; for (let j = 0; j < pd.dim; j++) d += emb.data[i * pd.dim + j] * p.embedding[j]; if (d > bs) { bs = d; best = k; } }); cnt[pd.prompts[best].text] = (cnt[pd.prompts[best].text] || 0) + 1; }); console.log('--- top prompt for', label); Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(e => console.log(e[1], e[0])); };
top(hor.slice(0, 40), 'worst 40 horror'); top(saf.slice(0, 40), 'worst 40 safe');
process.exit(0);
