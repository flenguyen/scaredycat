/**
 * Checks for models/image-model.json, the one source of truth for the shipped
 * image model (written by eval/bakeoff/promote.mjs, read by
 * offscreen/classifier.js, scripts/pack.mjs and eval/setup-model.mjs):
 * the schema, monotone calibration knots anchored on ml-bridge.js's bars,
 * every listed file present and in vendor/CHECKSUMS.sha256, nothing else
 * under models/, background/model-info.js in step with it, and the ordering
 * of ml-bridge.js's bars.
 *   node eval/model-manifest-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readChecksums, sha256File } from '../scripts/checksums.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MANIFEST_PATH = 'models/image-model.json';
const manifest = JSON.parse(read(MANIFEST_PATH));
const checksums = readChecksums(ROOT);
const modelPath = (f) => `models/${manifest.dir}/${f}`;

/** ml-bridge.js's image bars, read from the source (they are not exported). */
function bridgeBars() {
  const src = read('content/ml-bridge.js');
  const num = (name) => {
    const m = new RegExp(`const ${name} = (\\d+(?:\\.\\d+)?);`).exec(src);
    assert.ok(m, `ml-bridge.js: no numeric ${name}`);
    return Number(m[1]);
  };
  const bars = {
    veto: num('IMAGE_VETO_SCORE'), page: num('IMAGE_BLOCK_SCORE_HORROR_PAGE'),
    block: num('IMAGE_BLOCK_SCORE'), only: num('IMAGE_ONLY_BLOCK_SCORE')
  };
  const genre = /const IMAGE_BLOCK_SCORE_GENRE_LISTING = (?:IMAGE_VETO_SCORE \+ (\d+(?:\.\d+)?)|(\d+(?:\.\d+)?));/.exec(src);
  assert.ok(genre, 'ml-bridge.js: IMAGE_BLOCK_SCORE_GENRE_LISTING is neither a number nor IMAGE_VETO_SCORE + n');
  bars.genre = genre[1] !== undefined ? bars.veto + Number(genre[1]) : Number(genre[2]);
  return bars;
}

test('manifest schema', () => {
  assert.equal(manifest.schema, 1);
  for (const k of ['id', 'version', 'dir']) assert.equal(typeof manifest[k], 'string', k);
  // The version keys the verdict cache and goes into feedback reports, whose
  // server accepts [\w.-]{1,64} (scared-cat-web lib/feedback/schema.ts).
  assert.match(manifest.version, /^[\w.-]{1,64}$/);
  assert.match(manifest.dir, /^[\w.-]+(\/[\w.-]+)?$/);
  assert.ok(['fp16', 'fp32'].includes(manifest.dtype), 'dtype fp16 or fp32 (q8 is not usable)');
  assert.ok(['crop', 'squash'].includes(manifest.decode?.view), 'decode.view crop or squash');
  assert.ok(Number.isInteger(manifest.decode.size) && manifest.decode.size > 0, 'decode.size');
  assert.ok(['head', 'zero-shot'].includes(manifest.scorer?.type), 'scorer.type head or zero-shot');
  assert.ok(manifest.files.includes(manifest.scorer.file), 'the scorer file is listed in files');
  if (manifest.scorer.type === 'zero-shot') assert.ok(manifest.files.includes('prompt-embeddings.bin'), 'zero-shot ships prompt-embeddings.bin');
  assert.equal(typeof manifest.source?.hfId, 'string');
  assert.match(manifest.source.revision, /^[0-9a-f]{40}$/);
  assert.equal(typeof manifest.source.licence, 'string');
  assert.ok(Array.isArray(manifest.files) && new Set(manifest.files).size === manifest.files.length, 'files: unique list');
  for (const f of manifest.files) assert.ok(!f.startsWith('/') && !f.includes('..'), `${f}: relative path inside the model dir`);
  const onnx = manifest.files.filter(f => /vision_model.*\.onnx$/.test(f));
  assert.deepEqual(onnx, [manifest.dtype === 'fp16' ? 'onnx/vision_model_fp16.onnx' : 'onnx/vision_model.onnx'], 'exactly one vision tower, at the manifest dtype');
  assert.ok(!manifest.files.some(f => /tokenizer|text_model/.test(f)), 'no tokenizer or text tower ships');
});

test('calibration knots are monotone and anchored on the ml-bridge.js bars', () => {
  const k = manifest.calibration.knots;
  assert.ok(Array.isArray(k) && k.length >= 2);
  for (const p of k) assert.ok(Array.isArray(p) && p.length === 2 && p.every(Number.isFinite), JSON.stringify(p));
  for (let i = 1; i < k.length; i++) {
    assert.ok(k[i][0] > k[i - 1][0], `raw values increase: ${JSON.stringify(k)}`);
    assert.ok(k[i][1] > k[i - 1][1], `calibrated values increase: ${JSON.stringify(k)}`);
  }
  assert.deepEqual(k[0], [0, 0]);
  assert.deepEqual(k.at(-1), [100, 100]);
  // Every bar ml-bridge.js applies with a raw bar picked in the bake-off is a
  // knot, so the calibrated verdict at it is exactly the raw-bar verdict.
  const bars = bridgeBars();
  for (const name of ['veto', 'page', 'block', 'only']) {
    assert.ok(k.some(p => p[1] === bars[name]), `ml-bridge ${name} bar ${bars[name]} is a knot`);
  }
});

test('every listed file exists, is the real file and matches CHECKSUMS', () => {
  for (const rel of [MANIFEST_PATH, ...manifest.files.map(modelPath)]) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), `${rel}: missing`);
    const head = fs.readFileSync(abs).subarray(0, 64).toString('utf8');
    assert.ok(!head.startsWith('version https://git-lfs'), `${rel}: Git LFS pointer, not the file (git lfs pull)`);
    assert.ok(checksums.has(rel), `${rel}: not in vendor/CHECKSUMS.sha256`);
    assert.equal(sha256File(abs), checksums.get(rel), `${rel}: sha256 does not match vendor/CHECKSUMS.sha256`);
  }
  const listedModels = [...checksums.keys()].filter(f => f.startsWith('models/')).sort();
  assert.deepEqual(listedModels, [MANIFEST_PATH, ...manifest.files.map(modelPath)].sort(), 'CHECKSUMS lists exactly the manifest\'s model files');
});

test('nothing else lives under models/', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
  const found = walk(path.join(ROOT, 'models')).map(f => path.relative(ROOT, f).split(path.sep).join('/'))
    .filter(f => f !== 'models/README.md' && !f.endsWith('.DS_Store'));
  assert.deepEqual(found.sort(), [MANIFEST_PATH, ...manifest.files.map(modelPath)].sort());
});

test('the scorer file is well formed', () => {
  if (manifest.scorer.type === 'head') {
    const h = JSON.parse(read(modelPath(manifest.scorer.file)));
    assert.equal(h.normalise, 'l2');
    assert.ok(Number.isInteger(h.dim) && h.w.length === h.dim && h.w.every(Number.isFinite) && Number.isFinite(h.b));
    assert.equal(h.model, manifest.id, 'head trained for this model');
    assert.equal(h.view, manifest.decode.view, 'head trained on this decode view');
  } else {
    const meta = JSON.parse(read(modelPath('prompt-embeddings.json')));
    const bytes = fs.statSync(path.join(ROOT, modelPath(meta.embeddings || 'prompt-embeddings.bin'))).size;
    assert.equal(bytes, meta.prompts.length * meta.dim * 4, 'prompt-embeddings.bin matches its header');
  }
});

test('background/model-info.js matches the manifest and the worker loads it first', () => {
  const ctx = vm.createContext({});
  vm.runInContext(read('background/model-info.js'), ctx);
  const info = vm.runInContext('ScaredyCatModelInfo', ctx);
  assert.deepEqual({ ...info }, { id: manifest.id, version: manifest.version }, 'rerun eval/bakeoff/promote.mjs');
  const bg = read('background.js');
  const at = (f) => bg.indexOf(`'${f}'`);
  assert.ok(at('background/model-info.js') >= 0, 'background.js imports model-info.js');
  assert.ok(at('background/model-info.js') < at('background/ml-router.js'), 'model-info.js before ml-router.js');
  assert.ok(at('background/model-info.js') < at('background/feedback.js'), 'model-info.js before feedback.js');
  for (const f of ['background/ml-router.js', 'background/feedback.js']) {
    assert.ok(read(f).includes('ScaredyCatModelInfo.version'), `${f} reads the version from model-info.js`);
  }
});

test('ml-bridge.js bars keep their order', () => {
  const b = bridgeBars();
  assert.ok(b.veto < b.genre, `veto ${b.veto} < genre listing ${b.genre}`);
  assert.ok(b.genre <= b.page, `genre listing ${b.genre} <= horror page ${b.page}`);
  assert.ok(b.page <= b.block, `horror page ${b.page} <= block ${b.block}`);
  assert.ok(b.block <= b.only, `block ${b.block} <= image only ${b.only}`);
});
