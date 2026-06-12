/**
 * Combined text+image verdict eval.
 *
 * Runs verdict-corpus.json fixtures through the SAME scoring-core.js and
 * ml-bridge.js the extension ships, emulating content.js band routing and
 * detector.js page-signal computation. No browser, no model: imageScore
 * values are calibrated poster scores (see ml-bridge.js comments).
 *
 * Usage: npm run eval:combined
 * Exits nonzero if any fixture marked "gate": true mismatches.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadClassicScript(file, globals) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const names = Object.keys(globals);
  new Function(...names, src)(...names.map(n => globals[n]));
  return globals;
}

// scoring-core.js exports via module.exports; ml-bridge.js attaches to window.
const scoringModule = { exports: {} };
loadClassicScript('content/scoring-core.js', { module: scoringModule, self: undefined });
const Scoring = scoringModule.exports;

const windowStub = {};
loadClassicScript('content/ml-bridge.js', { window: windowStub, chrome: undefined, module: undefined });
const Bridge = windowStub.ScaredyCatMLBridge;

const database = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/horror-database.json'), 'utf8'));
const compiled = Scoring.compile(database);
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/verdict-corpus.json'), 'utf8'));

const SENSITIVITIES = Scoring.SENSITIVITY_THRESHOLDS;

/**
 * Page-level horror signal. KEEP IN SYNC with detector.js computePageSignal():
 * computed from document.title + URL pathname only (not h1 — homepage
 * carousels poison it), and requires a definite-strength title match or a
 * strong keyword signal.
 */
function computePageSignal(page, threshold) {
  const result = Scoring.analyzeText(page.titleUrl, compiled, {
    threshold,
    pageHasHorrorSignal: false,
    scanQuietElements: false
  });
  return (result.titleMatched && result.titleScore >= 85) || result.keywordScore >= 30;
}

/** Emulates content.js scanOne() routing for one element-context. */
function endToEndVerdict(entry, threshold) {
  const page = corpus.pages[entry.page || 'neutral'];
  const pageSignal = computePageSignal(page, threshold);
  const scanQuiet = pageSignal || !!entry.mediaSite;

  const text = Scoring.analyzeText(entry.context, compiled, {
    threshold,
    // Pre-rename and post-rename opt names; analyzeText reads whichever exists.
    pageHasHorrorSignal: scanQuiet,
    scanQuietElements: scanQuiet
  });

  if (text.band === Scoring.BANDS.DEFINITE_HORROR) {
    return { block: true, via: 'definite', text };
  }
  if (text.band !== Scoring.BANDS.AMBIGUOUS) {
    return { block: false, via: 'safe-band', text };
  }
  const verdict = Bridge.combineVerdict(text, entry.imageScore ?? null, {
    pageHasHorrorSignal: pageSignal
  });
  return { block: verdict.isHorror, via: 'ml', text, verdict };
}

let gateFailures = 0;

// Gate assertions at each fixture's own sensitivity (default medium).
console.log('── fixture assertions ──');
for (const entry of corpus.entries) {
  const sensitivity = entry.sensitivity || 'medium';
  const r = endToEndVerdict(entry, SENSITIVITIES[sensitivity]);
  const ok = r.block === entry.expectBlock;
  const flag = ok ? 'pass' : (entry.gate ? 'FAIL' : 'fail (non-gate)');
  if (!ok && entry.gate) gateFailures++;
  console.log(
    `  [${entry.id}] ${flag}  block=${r.block} expected=${entry.expectBlock}` +
    ` via=${r.via} text=${r.text.confidence} band=${r.text.band}` +
    `${entry.imageScore === null ? ' image=null' : ` image=${entry.imageScore}`}@${sensitivity}`
  );
  if (!ok) console.log(`      ${entry.note}`);
}

// Aggregate metrics per sensitivity (expectBlock is the medium-calibrated
// label, so metrics use label horror/safe instead).
console.log('\n── metrics by sensitivity (label-based) ──');
for (const [name, threshold] of Object.entries(SENSITIVITIES)) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const entry of corpus.entries) {
    const r = endToEndVerdict(entry, threshold);
    if (entry.label === 'horror') r.block ? tp++ : fn++;
    else r.block ? fp++ : tn++;
  }
  const pct = (a, b) => (a + b ? (a / (a + b) * 100).toFixed(1) + '%' : 'n/a');
  console.log(`  ${name.padEnd(6)} precision ${pct(tp, fp)}  recall ${pct(tp, fn)}  FP-rate ${pct(fp, tn)}  (tp=${tp} fp=${fp} tn=${tn} fn=${fn})`);
}

if (gateFailures) {
  console.error(`\n${gateFailures} gated fixture(s) failed`);
  process.exit(1);
}
console.log('\nall gated fixtures pass ✓');
