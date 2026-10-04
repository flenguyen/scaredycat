/**
 * Titled-quiet skip eval (Phase 5: image-only ML budget).
 *
 * On media sites and horror-signal pages a quiet element (text score 0) goes
 * to the image classifier even when it carries a readable non-horror title.
 * scoring-core.js can skip those ("titled-quiet") and classify only the
 * textless ones, behind opts.skipTitledQuiet (detector.js SKIP_TITLED_QUIET,
 * all contexts off). This runs every fixture with the skip off and on and
 * reports, per context:
 *   recall     blocked horror / horror
 *   FP rate    blocked safe / safe
 *   requests   classifier requests (AMBIGUOUS elements), and how many the
 *              skip avoids
 *   lost       horror blocked with the skip off but not with it on, with the
 *              exact (Clopper-Pearson) 95% upper bound on the loss rate
 *
 * Decision rule (Phase 5 plan): the skip may ship for a context only when it
 * has >= 200 horror samples and loses <= 1 per 200 of them.
 *
 * Inputs:
 *   eval/verdict-corpus.json   end-to-end fixtures; context derived from the
 *                              page (horror signal / media site / feed);
 *                              optional per-entry pageText
 *   eval/quiet-skip-sample.json  per-context TMDB sample with recorded image
 *                              scores (eval/quiet-skip-collect.mjs)
 *
 *   node eval/quiet-skip-eval.mjs [--examples 8] [--json out.json]
 *   SC_DB_PATH=<served merged list> node eval/quiet-skip-eval.mjs
 *
 * Exits nonzero only if a gated verdict-corpus fixture changes with the skip
 * OFF (the flag must not move shipped behavior).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const EXAMPLES = parseInt(argVal('--examples', '8'), 10);
const JSON_OUT = argVal('--json', null);
const SAMPLE_PATH = argVal('--sample', path.join(ROOT, 'eval/quiet-skip-sample.json'));

function loadClassicScript(file, globals) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const names = Object.keys(globals);
  new Function(...names, src)(...names.map(n => globals[n]));
  return globals;
}
const scoringModule = { exports: {} };
loadClassicScript('content/scoring-core.js', { module: scoringModule, self: undefined });
const Scoring = scoringModule.exports;
const windowStub = {};
loadClassicScript('content/ml-bridge.js', { window: windowStub, chrome: undefined, module: undefined });
const Bridge = windowStub.ScaredyCatMLBridge;

const DB_PATH = process.env.SC_DB_PATH || path.join(ROOT, 'data/horror-database.json');
const database = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const compiled = Scoring.compile(database);
const THRESHOLD = Scoring.SENSITIVITY_THRESHOLDS.medium;
const BUDGET = 1 / 200;
const MIN_HORROR = 200;

console.log(`DB: ${DB_PATH === path.join(ROOT, 'data/horror-database.json') ? 'bundled' : DB_PATH} ` +
  `(v${database.version}, ${database.titles.length} titles, ${database.titles.filter(t => t.auto).length} auto)  sensitivity medium\n`);

/**
 * One element through content.js scanOne() routing. `cond` is the page:
 * { scanQuiet, pageSignal, genreListing, authoritative, nonHorror }.
 */
function verdict(item, cond, skip, threshold = THRESHOLD) {
  const text = Scoring.analyzeText(item.context, compiled, {
    threshold,
    scanQuietElements: cond.scanQuiet,
    pageText: typeof item.pageText === 'string' ? item.pageText : item.context,
    skipTitledQuiet: skip
  });
  if (text.band === Scoring.BANDS.DEFINITE_HORROR) return { block: true, request: false, text };
  if (text.band !== Scoring.BANDS.AMBIGUOUS) return { block: false, request: false, text };
  const v = Bridge.combineVerdict(text, item.imageScore ?? null, {
    pageHasHorrorSignal: cond.pageSignal,
    isHorrorGenreListing: cond.genreListing,
    authoritativeHorrorGenre: cond.authoritative,
    authoritativeNonHorrorGenre: cond.nonHorror
  });
  return { block: v.isHorror, request: true, text };
}

/** Exact binomial (Clopper-Pearson) one-sided 95% upper bound on k/n. */
function upper95(k, n) {
  if (n === 0) return 1;
  if (k >= n) return 1;
  const cdf = (p) => { // P(X <= k)
    let term = Math.pow(1 - p, n), sum = term;
    for (let i = 1; i <= k; i++) { term *= (n - i + 1) / i * p / (1 - p); sum += term; }
    return sum;
  };
  let lo = k / n, hi = 1;
  for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (cdf(mid) > 0.05) lo = mid; else hi = mid; }
  return hi;
}

function summarize(name, items, cond) {
  const row = {
    context: name, horror: 0, safe: 0,
    tpOff: 0, tpOn: 0, fpOff: 0, fpOn: 0,
    reqOff: 0, reqOn: 0, reqOffHorror: 0, reqOnHorror: 0,
    titledQuietHorror: 0, titledQuietSafe: 0, textlessQuiet: 0,
    lost: [], gained: []
  };
  for (const item of items) {
    const off = verdict(item, cond(item), false);
    const on = verdict(item, cond(item), true);
    const horror = item.label === 'horror';
    horror ? row.horror++ : row.safe++;
    if (off.text.quietKind === 'titled') horror ? row.titledQuietHorror++ : row.titledQuietSafe++;
    if (off.text.quietKind === 'textless') row.textlessQuiet++;
    if (off.request) { row.reqOff++; if (horror) row.reqOffHorror++; }
    if (on.request) { row.reqOn++; if (horror) row.reqOnHorror++; }
    if (horror) {
      if (off.block) row.tpOff++;
      if (on.block) row.tpOn++;
      if (off.block && !on.block) row.lost.push(item);
    } else {
      if (off.block) row.fpOff++;
      if (on.block) row.fpOn++;
      if (off.block && !on.block) row.gained.push(item);
    }
  }
  const k = row.lost.length, n = row.horror;
  row.lossRate = n ? k / n : null;
  row.lossUpper95 = n ? upper95(k, n) : null;
  row.decision = n < MIN_HORROR
    ? `too few horror samples (${n} < ${MIN_HORROR}): keep OFF`
    : row.lossRate <= BUDGET
      ? (row.lossUpper95 <= BUDGET ? 'within budget (95% bound too)' : 'within budget on the point estimate; 95% bound above it')
      : `over budget (${(row.lossRate * 200).toFixed(1)} per 200): keep OFF`;
  return row;
}

const pct = (a, b) => (b ? `${(a / b * 100).toFixed(1)}%` : 'n/a');
function printTable(title, rows) {
  console.log(`── ${title} ──`);
  console.log('context         horror  safe | recall off→on       lost (per 200, 95% ub) | FP off→on        | classify requests off→on (avoided)         | titled-quiet horror/safe');
  for (const r of rows) {
    const avoided = r.reqOff - r.reqOn;
    console.log(
      `${r.context.padEnd(15)} ${String(r.horror).padStart(6)} ${String(r.safe).padStart(5)} | ` +
      `${pct(r.tpOff, r.horror).padStart(6)} → ${pct(r.tpOn, r.horror).padStart(6)}   ` +
      `${String(r.lost.length).padStart(3)} (${r.horror ? (r.lossRate * 200).toFixed(2) : 'n/a'}, ub ${r.horror ? (r.lossUpper95 * 200).toFixed(2) : 'n/a'}) | ` +
      `${pct(r.fpOff, r.safe).padStart(6)} → ${pct(r.fpOn, r.safe).padStart(6)} | ` +
      `${String(r.reqOff).padStart(4)} → ${String(r.reqOn).padStart(4)} (${String(avoided).padStart(4)}, ${pct(avoided, r.reqOff)}; horror ${r.reqOffHorror}→${r.reqOnHorror}) | ` +
      `${r.titledQuietHorror}/${r.titledQuietSafe}`
    );
  }
  for (const r of rows) console.log(`  ${r.context}: ${r.decision}`);
  for (const r of rows) {
    if (!r.lost.length || !EXAMPLES) continue;
    console.log(`  ${r.context} lost horror (blocked off, missed on):`);
    for (const it of r.lost.slice(0, EXAMPLES)) {
      console.log(`    - [${it.id}] image ${it.imageScore} "${(it.pageText ?? it.context).slice(0, 80)}"`);
    }
  }
  console.log();
}

const report = { db: DB_PATH, version: database.version, tables: {} };

// ---- A. verdict corpus ---------------------------------------------------------
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/verdict-corpus.json'), 'utf8'));
function corpusPage(entry) {
  const page = corpus.pages[entry.page || 'neutral'];
  let pageSignal = false;
  if (!page.socialFeed) {
    if (page.forceSignal) pageSignal = true;
    else {
      const r = Scoring.analyzeText(page.titleUrl, compiled, { threshold: THRESHOLD, scanQuietElements: false });
      pageSignal = (r.titleMatched && r.titleScore >= 85) || r.keywordScore >= 30;
    }
  }
  const nonHorror = !!page.nonHorrorGenre && !pageSignal;
  return {
    scanQuiet: (pageSignal || !!entry.mediaSite) && !nonHorror,
    pageSignal, genreListing: false, authoritative: false, nonHorror,
    kind: page.socialFeed ? 'social' : pageSignal ? 'horrorSignal'
      : entry.mediaSite ? ((entry.page || 'neutral') === 'neutral' ? 'streaming' : 'database') : 'general'
  };
}

let driftFailures = 0;
for (const entry of corpus.entries) {
  if (!entry.gate) continue;
  const cond = corpusPage(entry);
  const threshold = Scoring.SENSITIVITY_THRESHOLDS[entry.sensitivity || 'medium'];
  // Same verdict with and without pageText when the skip is off.
  const withText = verdict(entry, cond, false, threshold).block;
  const without = verdict({ ...entry, pageText: undefined }, cond, false, threshold).block;
  if (withText !== entry.expectBlock || without !== entry.expectBlock) {
    driftFailures++;
    console.error(`  DRIFT [${entry.id}] skip off: block=${withText}/${without} expected ${entry.expectBlock}`);
  }
}

const corpusRows = [];
const byKind = {};
for (const entry of corpus.entries) {
  if ((entry.sensitivity || 'medium') !== 'medium') continue;
  const kind = corpusPage(entry).kind;
  (byKind[kind] ||= []).push(entry);
}
for (const kind of ['youtube', 'streaming', 'database', 'horrorSignal', 'general', 'social']) {
  if (byKind[kind]) corpusRows.push(summarize(kind, byKind[kind], corpusPage));
}
printTable(`A. verdict-corpus.json (${corpus.entries.length} entries; context from page + mediaSite)`, corpusRows);
report.tables.verdictCorpus = corpusRows;

// ---- B. per-context sample -------------------------------------------------------
if (fs.existsSync(SAMPLE_PATH)) {
  const sample = JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'));
  const items = sample.items;
  const ctx = (name) => items.filter(it => it.site === name);
  // A media-site page with no page-level signal: quiet elements classified,
  // image-only bar 80.
  const neutralMedia = () => ({ scanQuiet: true, pageSignal: false, genreListing: false, authoritative: false, nonHorror: false });
  // A horror-signal page (horror search, horror title page rails): bar 65.
  const horrorPage = () => ({ scanQuiet: true, pageSignal: true, genreListing: false, authoritative: false, nonHorror: false });
  // A horror genre listing or a title page whose JSON-LD says Horror: bar 41.
  const genreListing = () => ({ scanQuiet: true, pageSignal: true, genreListing: true, authoritative: false, nonHorror: false });

  const rows = [
    summarize('youtube', ctx('youtube'), neutralMedia),
    summarize('streaming', ctx('streaming'), neutralMedia),
    summarize('database', ctx('database'), neutralMedia),
    summarize('horrorSignal', items, horrorPage),
    summarize('horrorListing', items, genreListing)
  ];
  printTable(`B. ${path.relative(ROOT, SAMPLE_PATH)} (generated ${sample.generated}; ${items.length} items)`, rows);
  console.log('  horrorSignal = every sample item on a horror-signal page (bar 65); horrorListing = on a horror genre listing or JSON-LD horror title page (bar 41).');
  console.log('  The horror/safe mix is the sample\'s, not a real page\'s: read requests avoided per label, not as a page total.\n');
  report.tables.sample = rows;
} else {
  console.log(`(no ${path.relative(ROOT, SAMPLE_PATH)}: run eval/quiet-skip-collect.mjs for the per-context sample)\n`);
}

if (JSON_OUT) {
  const strip = (rows) => rows.map(({ lost, gained, ...r }) => ({ ...r, lost: lost.map(i => i.id), gained: gained.map(i => i.id) }));
  for (const k of Object.keys(report.tables)) report.tables[k] = strip(report.tables[k]);
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
}

if (driftFailures) {
  console.error(`${driftFailures} gated fixture(s) changed with the skip OFF`);
  process.exit(1);
}
console.log('skip OFF leaves every gated verdict-corpus fixture unchanged ✓');
