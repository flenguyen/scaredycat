/**
 * Promote a bake-off config to THE shipped image model. This is the swap tool
 * (runbook: models/README.md).
 *
 *   node eval/bakeoff/promote.mjs --config "<model>|<approach>|<dtype>|<view>" [--dry-run]
 *   e.g. --config "tinyclip-vit-40m-32-laion400m|head|fp16|crop"
 *
 * The config must be a finalist in eval/bakeoff/finalists.json with its
 * pre-test bars in eval/bakeoff/pretest.json. The script:
 *   1. copies the model files from eval/.model-cache/bakeoff/<model>/ into
 *      models/<model>/, plus the head (approach 'head') or the prompt
 *      embeddings (approach 'zero-shot')
 *   2. builds the calibration knots: the config's raw bars (image-only, block
 *      and horror-page from finalists.json, the benefit-matched veto from
 *      pretest.json) map to ml-bridge.js's own bars (80, 76, 65, 40)
 *   3. writes models/image-model.json and background/model-info.js
 *   4. rewrites the models/ lines of vendor/CHECKSUMS.sha256
 *   5. removes every other model directory under models/ (git rm when tracked)
 *   6. prints what is left to do by hand
 * --dry-run prints the plan and writes nothing.
 *
 * Only fp16/fp32 are accepted: q8 broke every model with a head in the
 * bake-off. The ONNX files come from eval/bakeoff/export.py; after a swap the
 * Git LFS copy under models/ is the source of truth (eval/setup-model.mjs).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256File, CHECKSUMS_FILE } from '../../scripts/checksums.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
const MODELS = path.join(ROOT, 'models');
const MANIFEST = 'models/image-model.json';
const MODEL_INFO = 'background/model-info.js';
const ONNX_FILE = { fp16: 'onnx/vision_model_fp16.onnx', fp32: 'onnx/vision_model.onnx' };
// The crop view is the extension's decode: 256 short edge, centre 256 crop,
// then the model's own processor (eval/bakeoff/browser-embed.mjs, 'crop').
const CROP_SIZE = 256;
const MODEL_README = 'models/README.md';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const DRY = process.argv.includes('--dry-run');
const CONFIG = arg('config');
const fail = (msg) => { console.error(`promote: ${msg}`); process.exit(1); };
if (!CONFIG) fail('usage: promote.mjs --config "<model>|<approach>|<dtype>|<view>" [--dry-run]');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const rel = (abs) => path.relative(ROOT, abs);

// ---- the config and its evidence ----------------------------------------------------

const [model, approach, dtype, view] = CONFIG.split('|');
if (!ONNX_FILE[dtype]) fail(`${CONFIG}: dtype must be fp16 or fp32 (q8 is not usable, see REPORT.md)`);
if (!['crop', 'squash'].includes(view)) fail(`${CONFIG}: view must be crop or squash`);
if (!['head', 'zero-shot'].includes(approach)) fail(`${CONFIG}: approach must be head or zero-shot`);

const finalists = readJson('eval/bakeoff/finalists.json');
const finalist = finalists.finalists.find(f => f.config === CONFIG);
if (!finalist) fail(`${CONFIG} is not in eval/bakeoff/finalists.json (finalists: ${finalists.finalists.map(f => f.config).join(', ')})`);
if (finalists.sourceMode !== 'browser') fail('finalists.json was not picked on in-browser embeddings (sourceMode must be "browser")');
const pre = readJson('eval/bakeoff/pretest.json').configs[CONFIG];
if (!pre?.vetoBenefitMatched || !pre.proposedConstants) fail(`${CONFIG}: no pre-test bars in eval/bakeoff/pretest.json`);
const candidate = readJson('eval/bakeoff/candidates.json').find(c => c.name === model);
if (!candidate) fail(`${model} is not in eval/bakeoff/candidates.json`);
if (!candidate.commercialOk || candidate.role !== 'candidate') fail(`${model}: licence not cleared for shipping (candidates.json role "${candidate.role}")`);

// The calibrated anchors are ml-bridge.js's own bars, read from the source so
// the two can't drift apart.
const bridge = fs.readFileSync(path.join(ROOT, 'content/ml-bridge.js'), 'utf8');
const bar = (name) => {
  const m = new RegExp(`const ${name} = (\\d+(?:\\.\\d+)?);`).exec(bridge);
  if (!m) fail(`content/ml-bridge.js: no numeric ${name}`);
  return Number(m[1]);
};
const anchors = {
  veto: bar('IMAGE_VETO_SCORE'), page: bar('IMAGE_BLOCK_SCORE_HORROR_PAGE'),
  block: bar('IMAGE_BLOCK_SCORE'), only: bar('IMAGE_ONLY_BLOCK_SCORE')
};
const t = finalist.thresholds;
const raw = { veto: pre.vetoBenefitMatched.V, page: t.T_page, block: t.T_block, only: t.T_only };
// pretest.json's proposed constants are the same numbers; refuse if not.
const pc = pre.proposedConstants;
for (const [k, c] of [['veto', 'IMAGE_VETO_SCORE'], ['page', 'IMAGE_BLOCK_SCORE_HORROR_PAGE'], ['block', 'IMAGE_BLOCK_SCORE'], ['only', 'IMAGE_ONLY_BLOCK_SCORE']]) {
  if (pc[c] !== raw[k]) fail(`${CONFIG}: ${c} is ${raw[k]} from finalists/pretest but ${pc[c]} in pretest.json proposedConstants`);
}
const knots = [[0, 0], [raw.veto, anchors.veto], [raw.page, anchors.page], [raw.block, anchors.block], [raw.only, anchors.only], [100, 100]];
for (let i = 1; i < knots.length; i++) {
  if (!(knots[i][0] > knots[i - 1][0] && knots[i][1] > knots[i - 1][1])) {
    fail(`calibration knots are not strictly increasing: ${JSON.stringify(knots)}`);
  }
}

// ---- files --------------------------------------------------------------------------

const srcDir = path.join(ROOT, 'eval/.model-cache/bakeoff', model);
const dstDir = path.join(MODELS, model);
const copies = []; // [src abs, file name under models/<model>/]
for (const f of ['config.json', 'preprocessor_config.json', ONNX_FILE[dtype]]) copies.push([path.join(srcDir, f), f]);
let scorer;
if (approach === 'head') {
  if (!finalist.head) fail(`${CONFIG}: finalists.json names no head file`);
  copies.push([path.join(ROOT, finalist.head), 'head.json']);
  scorer = { type: 'head', file: 'head.json' };
} else {
  if (!finalist.prompts) fail(`${CONFIG}: finalists.json names no prompt-embeddings directory`);
  for (const f of ['prompt-embeddings.json', 'prompt-embeddings.bin']) copies.push([path.join(ROOT, finalist.prompts, f), f]);
  scorer = { type: 'zero-shot', file: 'prompt-embeddings.json' };
}
for (const [src] of copies) if (!fs.existsSync(src)) fail(`missing ${rel(src)} (run eval/bakeoff/export.py ${model}, see models/README.md)`);

// The exported vision file must be the one the bake-off measured.
const exported = readJson('eval/bakeoff/model-files.json')[model]?.exports || {};
for (const [src, f] of copies) {
  const want = exported[path.basename(f)]?.sha256;
  if (want && sha256File(src) !== want) fail(`${rel(src)}: sha256 differs from eval/bakeoff/model-files.json (re-export or re-measure)`);
}
if (approach === 'head') {
  const h = JSON.parse(fs.readFileSync(copies.at(-1)[0], 'utf8'));
  if (h.model !== model || h.view !== view || h.normalise !== 'l2' || h.w?.length !== h.dim) fail(`${finalist.head}: not a ${model} ${view} head`);
}

let size = CROP_SIZE;
if (view === 'squash') {
  const p = JSON.parse(fs.readFileSync(path.join(srcDir, 'preprocessor_config.json'), 'utf8'));
  const s = typeof p.size === 'number' ? p.size : (p.size?.shortest_edge ?? p.size?.height);
  if (!Number.isInteger(s)) fail('preprocessor_config.json: cannot read the model input size for the squash view');
  size = s;
}

// ---- version ------------------------------------------------------------------------

// <family><size>-<dtype>-<approach>[-<view>]-v<N>: N goes up whenever the
// files or the calibration change, because the verdict cache is keyed by it.
const parts = model.split('-');
const short = parts[0] + (parts.find(p => /^\d+m$/.test(p)) || '');
const prefix = `${short}-${dtype}-${approach}${view === 'crop' ? '' : '-' + view}`;
const fileShas = Object.fromEntries(copies.map(([src, f]) => [f, sha256File(src)]));
const previous = fs.existsSync(path.join(ROOT, MANIFEST)) ? readJson(MANIFEST) : null;
let version = `${prefix}-v1`;
if (previous && previous.version.startsWith(prefix + '-v')) {
  const n = Number(previous.version.slice(prefix.length + 2)) || 0;
  const prevShas = Object.fromEntries((previous.files || []).map(f => {
    const abs = path.join(MODELS, previous.dir, f);
    return [f, fs.existsSync(abs) ? sha256File(abs) : null];
  }));
  const same = previous.dir === model && JSON.stringify(previous.calibration?.knots) === JSON.stringify(knots) &&
    JSON.stringify(previous.decode) === JSON.stringify({ view, size }) &&
    JSON.stringify(prevShas) === JSON.stringify(fileShas);
  version = `${prefix}-v${same ? n : n + 1}`;
}
// Same characters the report server accepts for context.modelVersion.
if (!/^[\w.-]{1,64}$/.test(version) || !/^[\w.-]+$/.test(model)) fail(`bad model id or version: ${model}, ${version}`);

const manifest = {
  schema: 1,
  id: model,
  version,
  dir: model,
  dtype,
  decode: { view, size },
  scorer,
  calibration: { knots },
  source: {
    hfId: candidate.hfId,
    revision: candidate.revision,
    licence: candidate.licence,
    export: 'eval/bakeoff/export.py'
  },
  files: copies.map(([, f]) => f)
};

const modelInfo = `/**
 * Scaredy Cat - Image model info
 * GENERATED by eval/bakeoff/promote.mjs from models/image-model.json; do not
 * edit by hand (eval/model-manifest-test.mjs checks the two agree). The
 * service worker reads it synchronously at start-up, so the verdict cache and
 * feedback reports use the shipped model's version before the offscreen
 * document has loaded. Loaded via importScripts.
 */

const ScaredyCatModelInfo = Object.freeze({ id: '${manifest.id}', version: '${manifest.version}' });
`;

// ---- CHECKSUMS: replace the models/ lines -----------------------------------------------

// Knots one pair per line, as models/README.md shows them.
const manifestText = JSON.stringify(manifest, null, 2)
  .replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]') + '\n';
const checksumLines = fs.readFileSync(path.join(ROOT, CHECKSUMS_FILE), 'utf8').split('\n');
const kept = [];
let ownComment = false; // this script's "# models/:" note and its indented continuation
for (const line of checksumLines) {
  if (line.startsWith('#')) {
    ownComment = line.startsWith('# models/:') || (ownComment && /^#\s{2,}/.test(line));
    if (ownComment) continue;
    if (/^#\s+shasum /.test(line)) kept.push(line.split(' ').filter(w => !w.startsWith('models/')).join(' '));
    else if (!line.includes('models/')) kept.push(line);
  } else if (line.trim() && !/ [ *]models\//.test(line)) {
    kept.push(line);
  }
}
const lastComment = kept.findLastIndex(l => l.startsWith('#'));
const shaOf = (text) => crypto.createHash('sha256').update(text).digest('hex');
const modelLines = [
  `${shaOf(manifestText)}  ${MANIFEST}`,
  ...copies.map(([, f]) => `${fileShas[f]}  models/${model}/${f}`)
];
const newChecksums = [
  ...kept.slice(0, lastComment + 1),
  `# models/: ${MANIFEST} and its files, written by eval/bakeoff/promote.mjs`,
  `#   (${model}, ${version}). Rerun it to change them; never edit`,
  '#   these lines by hand.',
  ...kept.slice(lastComment + 1),
  ...modelLines
].join('\n') + '\n';

// ---- old model directories ------------------------------------------------------------

const others = fs.existsSync(MODELS)
  ? fs.readdirSync(MODELS, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== model).map(d => path.join(MODELS, d.name))
  : [];
const strays = fs.existsSync(dstDir)
  ? walk(dstDir).filter(f => !manifest.files.includes(path.relative(dstDir, f).split(path.sep).join('/')))
  : [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}
function isTracked(abs) {
  return execFileSync('git', ['ls-files', '--', rel(abs)], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
}

// ---- plan / apply -----------------------------------------------------------------------

const mb = (n) => (n / 1e6).toFixed(2) + ' MB';
console.log(`${DRY ? 'DRY RUN: nothing is written.\n' : ''}Promote ${CONFIG}`);
console.log(`  version   ${previous ? previous.version : '(none)'} -> ${version}`);
console.log(`  licence   ${candidate.licence} (${candidate.hfId} @ ${candidate.revision.slice(0, 7)})`);
console.log(`  decode    ${view}, ${size} px; scorer ${scorer.type}`);
console.log(`  raw bars  veto ${raw.veto} (benefit-matched), horror page ${raw.page}, block ${raw.block}, image only ${raw.only}`);
console.log(`  knots     ${JSON.stringify(knots)}`);
const genreRaw = knots[1][0] + (anchors.veto + 1 - knots[1][1]) * (knots[2][0] - knots[1][0]) / (knots[2][1] - knots[1][1]);
console.log(`            ml-bridge's genre-listing bar (${anchors.veto} + 1) sits at raw ${genreRaw.toFixed(2)}`);
console.log('  copy');
for (const [src, f] of copies) console.log(`    ${rel(src)} -> models/${model}/${f} (${mb(fs.statSync(src).size)}, sha256 ${fileShas[f].slice(0, 12)}…)`);
console.log(`  write     ${MANIFEST}, ${MODEL_INFO}, ${CHECKSUMS_FILE} (models/ lines)`);
for (const d of others) console.log(`  remove    ${rel(d)}/ (${isTracked(d) ? 'git rm' : 'untracked'})`);
for (const f of strays) console.log(`  remove    ${rel(f)} (not in the manifest)`);

if (DRY) {
  console.log(`\n--- ${MANIFEST} ---\n${manifestText}--- ${MODEL_INFO} (last line) ---\n${modelInfo.trim().split('\n').at(-1)}`);
  console.log(`--- ${CHECKSUMS_FILE} models/ lines ---\n${modelLines.join('\n')}`);
  process.exit(0);
}

fs.mkdirSync(dstDir, { recursive: true });
for (const [src, f] of copies) {
  const dst = path.join(dstDir, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
for (const f of strays) fs.rmSync(f);
fs.writeFileSync(path.join(ROOT, MANIFEST), manifestText);
fs.writeFileSync(path.join(ROOT, MODEL_INFO), modelInfo);
fs.writeFileSync(path.join(ROOT, CHECKSUMS_FILE), newChecksums);
for (const d of others) {
  if (isTracked(d)) execFileSync('git', ['rm', '-r', '-q', '--', rel(d)], { cwd: ROOT, stdio: 'inherit' });
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`
Done. Still to do by hand (models/README.md has the details):
  1. git add .gitattributes models/ ${MODEL_INFO} ${CHECKSUMS_FILE}; then \`git lfs ls-files\` must list the .onnx file.
  2. THIRD_PARTY_NOTICES: the model's licence notice (${candidate.licence}, ${candidate.licenceUrls?.[0] || candidate.hfId}).
  3. eval/verdict-corpus.json: re-record the named posters' imageScore in-browser (calibrated), then npm run eval:combined.
  4. npm run model:check (setup:model --verify, browser parity on WASM and WebGPU, pack --check).
  5. npm run eval, npm run smoke, npm run latency.
  6. A new image model is a Level 1 release (CLAUDE.md "Releases", trigger 6): ask the user, then version + data/releases.json.
${fs.existsSync(path.join(ROOT, MODEL_README)) ? '' : `  (no ${MODEL_README} yet: write the runbook)\n`}`);
