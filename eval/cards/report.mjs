/**
 * Score a replay run against the labels in corpus.json.
 *
 *   node eval/cards/report.mjs [--name latest] [--vs before] [--misses] [--false-blurs]
 *
 * Prints recall (horror cards blurred) and false blur (safe cards blurred)
 * by site and by kind, plus image-only recall at the ml-bridge bars. With
 * --vs, prints both runs side by side. --misses / --false-blurs list the
 * cards behind the numbers.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE, CORPUS, readJson } from './lib.mjs';

function load(name) {
  const run = readJson(path.join(CACHE, `replay-${name}.json`));
  if (!run) throw new Error(`no replay named "${name}" (.cache/replay-${name}.json)`);
  const corpus = readJson(CORPUS, { items: {} });
  for (const r of run.rows) {
    const lab = corpus.items[r.id];
    // A card missing from the replayed page (the site re-rendered between
    // reading verdicts and taking the snapshot) can't be judged: leave it out.
    // So is a card the replay never scanned: it didn't render in the
    // stripped-down page (counted separately, so a real scanning regression
    // still shows).
    r.unscanned = r.present !== false && !r.state;
    r.label = r.present === false || r.unscanned ? null : lab?.label || null;
    r.kind = lab?.kind || null;
  }
  return run;
}

function tally(rows, groupOf) {
  const groups = new Map();
  for (const r of rows) {
    if (r.label !== 'horror' && r.label !== 'safe') continue;
    for (const g of [groupOf(r), 'ALL']) {
      if (!groups.has(g)) groups.set(g, { h: 0, hb: 0, s: 0, sb: 0 });
      const x = groups.get(g);
      if (r.label === 'horror') { x.h++; if (r.blocked) x.hb++; } else { x.s++; if (r.blocked) x.sb++; }
    }
  }
  return groups;
}

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
const cell = (a, b) => `${a}/${b} ${pct(a, b)}`.padStart(15);

function printTables(runs) {
  for (const [title, groupOf] of [['By site', r => r.site], ['By kind', r => r.kind || '?'], ['By page set', r => r.capture.startsWith('yt-') ? `youtube ${r.capture.slice(3)}` : r.capture]]) {
    const tallies = runs.map(run => tally(run.rows, groupOf));
    const keys = [...new Set(tallies.flatMap(t => [...t.keys()]))].sort((a, b) => (a === 'ALL') - (b === 'ALL') || a.localeCompare(b));
    console.log(`\n${title}`);
    console.log(`${''.padEnd(34)}${runs.map(r => `${('recall ' + r.name).padStart(15)}${('false blur ' + r.name).padStart(18)}`).join('  ')}`);
    for (const k of keys) {
      console.log(`${k.padEnd(34)}${tallies.map(t => { const x = t.get(k) || { h: 0, hb: 0, s: 0, sb: 0 }; return `${cell(x.hb, x.h)}${cell(x.sb, x.s).padStart(18)}`; }).join('  ')}`);
    }
  }
}

export function report(name, { vs = null, misses = false, falseBlurs = false } = {}) {
  const runs = [load(name)];
  if (vs) runs.unshift(load(vs));
  const latest = runs[runs.length - 1];
  const labelled = latest.rows.filter(r => r.label === 'horror' || r.label === 'safe');
  console.log(`\n${runs.map(r => `${r.name}: model ${r.model}, sensitivity ${r.sensitivity}`).join(' | ')}`);
  for (const run of runs) {
    const absent = run.rows.filter(r => r.present === false).length;
    const unscanned = run.rows.filter(r => r.unscanned).length;
    console.log(`${run.name}: ${run.rows.length} cards, ${absent} missing from the replayed page, ${unscanned} never scanned there (both left out)`);
  }
  printTables(runs);

  console.log(`\nImage-only (${latest.name}: classifier score alone, labelled cards with a score)`);
  const h = labelled.filter(r => r.label === 'horror' && r.imageScore !== null);
  const s = labelled.filter(r => r.label === 'safe' && r.imageScore !== null);
  for (const bar of [41, 65, 76, 80]) {
    console.log(`  >= ${bar}: recall ${cell(h.filter(r => r.imageScore >= bar).length, h.length)}   false blur ${cell(s.filter(r => r.imageScore >= bar).length, s.length)}`);
  }
  const vetoed = h.filter(r => r.imageScore <= 40).length;
  console.log(`  <= 40 (veto): ${cell(vetoed, h.length)} of horror cards`);

  const show = (r) => `  ${r.id.padEnd(30)} ${String(r.state).padEnd(8)} ${String(r.band).padEnd(15)} text ${String(r.confidence).padStart(3)} img ${String(r.imageScore).padStart(5)} ${r.selfLabel ? 'L' : ' '}${r.secondaryOnly ? 'S' : ' '} ${(r.context || '').replace(/\s+/g, ' ').slice(0, 70)}`;
  if (misses) {
    console.log(`\nMissed horror (${latest.name})`);
    latest.rows.filter(r => r.label === 'horror' && !r.blocked).forEach(r => console.log(show(r)));
  }
  if (falseBlurs) {
    console.log(`\nBlurred safe (${latest.name})`);
    latest.rows.filter(r => r.label === 'safe' && r.blocked).forEach(r => console.log(show(r)));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
  report(argVal('--name', 'latest'), {
    vs: argVal('--vs', null),
    misses: args.includes('--misses'),
    falseBlurs: args.includes('--false-blurs')
  });
}
