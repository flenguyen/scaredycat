/**
 * Scaredy Cat eval harness.
 *
 * Usage:
 *   npm run eval          # parity (old vs new scoring) + quality metrics
 *   npm run bench         # micro-benchmark old vs new scoring throughput
 *   npm run eval:image    # additionally score corpus imageUrl entries with the
 *                         # bundled CLIP model (requires npm run setup:model)
 *
 * The harness loads the SAME scoring-core.js the extension ships, so numbers
 * here are numbers in production.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyAnalyzeText } from './legacy-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// scoring-core.js is a UMD-ish classic script; load it via a module shim.
function loadScoringCore() {
  const src = fs.readFileSync(path.join(ROOT, 'content/scoring-core.js'), 'utf8');
  const moduleObj = { exports: {} };
  new Function('module', 'self', src)(moduleObj, undefined);
  return moduleObj.exports;
}

const Scoring = loadScoringCore();
const database = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/horror-database.json'), 'utf8'));
const corpusFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/corpus.json'), 'utf8'));

const SENSITIVITIES = { low: 80, medium: 60, high: 40 };

/** Generated positives: every Nth database title rendered through context templates. */
function generatedEntries() {
  const templates = [
    (t, y) => `Watch ${t} (${y}) official trailer HD`,
    (t) => `${t.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}-poster.jpg`,
    (t) => `${t} streaming now reviews cast`
  ];
  const entries = [];
  database.titles.forEach((entry, i) => {
    if (i % 6 !== 0) return; // ~104 titles, ~312 contexts
    templates.forEach((tpl, j) => {
      entries.push({
        id: `gen-${i}-${j}`,
        label: 'horror',
        generated: true,
        context: tpl(entry.title, entry.year || 2020),
        note: `generated from "${entry.title}"`
      });
    });
  });
  return entries;
}

const corpus = [...corpusFile.entries, ...generatedEntries()];

function runNew(context, threshold) {
  return Scoring.analyzeText(context, compiled, { threshold, pageHasHorrorSignal: false });
}

const compiled = Scoring.compile(database);

// ---------------------------------------------------------------------------
// Parity + quality
// ---------------------------------------------------------------------------

function evaluate() {
  console.log(`Corpus: ${corpus.length} entries (${corpusFile.entries.length} curated, ${corpus.length - corpusFile.entries.length} generated)\n`);

  for (const [name, threshold] of Object.entries(SENSITIVITIES)) {
    let tp = 0, fp = 0, tn = 0, fn = 0, textMissCaught = 0, textMissTotal = 0;
    const fpList = [], fnList = [], parityDiffs = [];

    for (const entry of corpus) {
      const oldR = legacyAnalyzeText(entry.context, database, threshold);
      const newR = runNew(entry.context, threshold);

      // Parity: the refactor must not change the text-only verdict.
      if (oldR.isHorror !== newR.isHorrorTextOnly || oldR.confidence !== newR.confidence) {
        parityDiffs.push({
          id: entry.id, context: entry.context.slice(0, 60),
          old: { isHorror: oldR.isHorror, conf: oldR.confidence },
          new: { isHorror: newR.isHorrorTextOnly, conf: newR.confidence }
        });
      }

      const predicted = newR.isHorrorTextOnly;
      if (entry.expectTextMiss) {
        textMissTotal++;
        if (predicted) textMissCaught++;
        continue; // not counted against the text layer
      }
      if (entry.label === 'horror') {
        if (predicted) tp++; else { fn++; fnList.push(entry); }
      } else {
        if (predicted) { fp++; fpList.push(entry); } else tn++;
      }
    }

    const precision = tp + fp ? (tp / (tp + fp) * 100).toFixed(1) : 'n/a';
    const recall = tp + fn ? (tp / (tp + fn) * 100).toFixed(1) : 'n/a';
    const fpRate = fp + tn ? (fp / (fp + tn) * 100).toFixed(1) : 'n/a';

    console.log(`── sensitivity=${name} (threshold ${threshold}) ──`);
    console.log(`   precision ${precision}%  recall ${recall}%  FP-rate ${fpRate}%   (tp=${tp} fp=${fp} tn=${tn} fn=${fn})`);
    console.log(`   neutral-text horror (image-layer territory): ${textMissCaught}/${textMissTotal} caught by text`);
    if (parityDiffs.length) {
      console.log(`   ⚠ PARITY DIFFS vs legacy: ${parityDiffs.length}`);
      parityDiffs.slice(0, 10).forEach(d => console.log('     ', JSON.stringify(d)));
    } else {
      console.log('   parity vs legacy scorer: identical verdicts & confidences ✓');
    }
    if (fpList.length) {
      console.log('   false positives:');
      fpList.slice(0, 8).forEach(e => console.log(`     - [${e.id}] ${e.context.slice(0, 70)}`));
    }
    if (fnList.length) {
      console.log('   false negatives:');
      fnList.slice(0, 8).forEach(e => console.log(`     - [${e.id}] ${e.context.slice(0, 70)}`));
    }
    console.log();
  }

  // Band distribution at medium — what fraction of work would hit the ML layer
  let bands = {};
  for (const entry of corpus) {
    const r = runNew(entry.context, SENSITIVITIES.medium);
    bands[r.band] = (bands[r.band] || 0) + 1;
  }
  console.log('Band distribution @ medium:', bands);
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

function bench() {
  const contexts = corpus.map(e => e.context);
  const N = 5;

  // warmup
  for (const c of contexts) { legacyAnalyzeText(c, database, 60); runNew(c, 60); }

  let t0 = performance.now();
  for (let i = 0; i < N; i++) for (const c of contexts) legacyAnalyzeText(c, database, 60);
  const oldMs = performance.now() - t0;

  t0 = performance.now();
  for (let i = 0; i < N; i++) for (const c of contexts) runNew(c, 60);
  const newMs = performance.now() - t0;

  const total = contexts.length * N;
  console.log(`Scored ${total} contexts:`);
  console.log(`  legacy: ${oldMs.toFixed(0)}ms  (${(oldMs / total * 1000).toFixed(0)}µs/context)`);
  console.log(`  new:    ${newMs.toFixed(0)}ms  (${(newMs / total * 1000).toFixed(0)}µs/context)`);
  console.log(`  speedup: ${(oldMs / newMs).toFixed(1)}x`);
}

// ---------------------------------------------------------------------------
// Image eval (optional, requires model setup)
// ---------------------------------------------------------------------------

async function imageEval() {
  const { classifyImageFile, loadImageClassifier } = await import('./image-classifier.mjs');
  const withImages = corpus.filter(e => e.imageUrl || e.imageFile);
  if (!withImages.length) {
    console.log('No corpus entries with imageUrl/imageFile — add some to run the image eval.');
    return;
  }
  await loadImageClassifier();
  for (const entry of withImages) {
    const score = await classifyImageFile(entry.imageFile || entry.imageUrl);
    console.log(`[${entry.id}] label=${entry.label} imageScore=${score.toFixed(1)}`);
  }
}

const args = process.argv.slice(2);
if (args.includes('--bench')) {
  bench();
} else if (args.includes('--image')) {
  await imageEval();
} else {
  evaluate();
  console.log();
  bench();
}
