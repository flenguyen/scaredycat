// Applies the phase B QA decisions to the pre-QA manifest and writes the final images.json (split FROZEN).
// Idempotent: always rebuilds from .cache/images.preqa.json. Usage: node eval/bakeoff/apply-qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = path.join(HERE, '.cache');
const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const PRE = path.join(C, 'images.preqa.json');
if (!fs.existsSync(PRE)) fs.copyFileSync(path.join(HERE, 'images.json'), PRE);
const pre = rd(PRE);
const idx = { ...rd(path.join(C, 'img-index.json')), ...rd(path.join(C, 'additions-index.json')) };
const add = rd(path.join(HERE, 'qa/additions.json'));
const SEED = 1337;
const hashNum = (s) => parseInt(crypto.createHash('sha1').update(`${SEED}|${s}`).digest('hex').slice(0, 12), 16);

const map = new Map(pre.map((m) => [m.id, { ...m }]));
const missing = [];
const stats = { relabels: 0, drops: 0, regroups: 0, additions: 0, dropsOverriddenByRelabel: 0 };

// 1. relabels win over drops
const relabeled = new Set();
for (const r of add.relabelExisting) {
  const m = map.get(r.id);
  if (!m) { missing.push(`relabel ${r.id}`); continue; }
  m.label = r.label; m.group = r.group; m.override = r.override; m.split = null;
  relabeled.add(r.id); stats.relabels++;
}
// 2. drops and regroups
for (const f of ['horror', 'hardsafe-films', 'hardsafe-other', 'easysafe']) {
  for (const d of rd(path.join(HERE, `qa/${f}.json`)).decisions) {
    const m = map.get(d.id);
    if (!m) { missing.push(`${f}:${d.action} ${d.id}`); continue; }
    if (relabeled.has(d.id)) { if (d.action === 'drop') stats.dropsOverriddenByRelabel++; continue; }
    if (d.action === 'drop') { map.delete(d.id); stats.drops++; }
    else if (d.action === 'regroup') { m.group = d.newGroup; stats.regroups++; }
  }
}
// 3. additions
for (const e of add.entries) {
  if (map.has(e.id)) { missing.push(`addition already present ${e.id}`); continue; }
  map.set(e.id, { ...e, split: null }); stats.additions++;
}
// 4. exclude entries without a usable download
const excluded = [];
for (const [id] of [...map]) {
  const x = idx[id];
  const file = x?.ok && !x.excluded && x.ext ? path.join(C, 'img', `${id}.${x.ext}`) : null;
  if (!file || !fs.existsSync(file)) { excluded.push(`${id} ${x?.excluded || x?.reason || 'no file'}`); map.delete(id); }
}
// 5. splits: existing keep theirs; new units: film's existing split, else deficit-balanced by seeded hash within group
const all = [...map.values()];
const unitOf = (m) => m.film || m.id;
const unitSplit = new Map();
for (const m of all) if (m.split && !unitSplit.has(unitOf(m))) unitSplit.set(unitOf(m), m.split);
const target = { train: 0.6, val: 0.2, test: 0.2 };
const newUnits = new Map(); // group -> [unit]
for (const m of all) if (!m.split && !unitSplit.has(unitOf(m))) {
  const l = newUnits.get(m.group) || []; if (!l.includes(unitOf(m))) l.push(unitOf(m)); newUnits.set(m.group, l);
}
for (const [g, units] of newUnits) {
  const cnt = { train: 0, val: 0, test: 0 };
  const seen = new Set();
  for (const m of all) if (m.group === g && unitSplit.has(unitOf(m)) && !seen.has(unitOf(m))) { seen.add(unitOf(m)); cnt[unitSplit.get(unitOf(m))]++; }
  units.sort((a, b) => hashNum(`${g}|${a}`) - hashNum(`${g}|${b}`));
  for (const u of units) {
    const n = cnt.train + cnt.val + cnt.test + 1;
    const s = Object.keys(target).sort((a, b) => (target[b] * n - cnt[b]) - (target[a] * n - cnt[a]))[0];
    cnt[s]++; unitSplit.set(u, s);
  }
}
for (const m of all) m.split = unitSplit.get(unitOf(m));
const order = new Map(pre.map((m, i) => [m.id, i]));
all.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
fs.writeFileSync(path.join(HERE, 'images.json'), JSON.stringify(all, null, 1) + '\n');

// ---- validation ----
const sum = {}; const tot = { train: 0, val: 0, test: 0 };
for (const m of all) { const k = `${m.label}/${m.group}`; sum[k] ??= { train: 0, val: 0, test: 0, total: 0 }; sum[k][m.split]++; sum[k].total++; tot[m.split]++; }
console.table(sum);
const hard = (m) => m.label === 'safe' && !['photo', 'ui-screenshot', 'logo', 'food', 'product', 'people', 'kids-cartoon'].includes(m.group);
const cls = (f) => { const o = { train: 0, val: 0, test: 0, total: 0 }; for (const m of all.filter(f)) { o[m.split]++; o.total++; } return o; };
console.table({ horror: cls((m) => m.label === 'horror'), hardSafe: cls(hard), easySafe: cls((m) => m.label === 'safe' && !hard(m)), safe: cls((m) => m.label === 'safe'), all: cls(() => true) });
const filmSplits = new Map(); for (const m of all) if (m.film) { const s = filmSplits.get(m.film) || new Set(); s.add(m.split); filmSplits.set(m.film, s); }
const multi = [...filmSplits].filter(([, s]) => s.size > 1);
console.log('films in >1 split:', multi.length, multi.map(([f]) => f).join(','));
console.log('entries without file:', all.filter((m) => !fs.existsSync(path.join(C, 'img', `${m.id}.${idx[m.id]?.ext}`))).length);
const n = all.length; console.log('split %:', Object.entries(tot).map(([k, v]) => `${k} ${(100 * v / n).toFixed(1)}`).join(' '));
console.log('applied', JSON.stringify(stats), 'excluded', excluded.length);
console.log('excluded by reason:', excluded.reduce((a, e) => { const r = e.split(' ').slice(1).join(' ').replace(/HTTP \d+/, 'HTTP'); a[r] = (a[r] || 0) + 1; return a; }, {}));
console.log('QA ids not found:', missing);
console.log('hard safe by hard():', all.filter(hard).length);
