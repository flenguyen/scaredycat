/**
 * Build the distributable zip: runtime files only. Dev tooling (eval/, tools/,
 * scripts/, node_modules/, docs, the dev-only text tower) never ships.
 *
 *   npm run pack            -> dist/scaredycat-<version>.zip + size report
 *   npm run pack -- --check -> report only, no zip
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHECK_ONLY = process.argv.includes('--check');

const INCLUDE = [
  'manifest.json',
  'background.js',
  'background',
  'content',
  'offscreen',
  'popup',
  'styles',
  'fonts',
  'data',
  'vendor',
  'models',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'
];
// Anything matching these must never end up in the zip.
const FORBIDDEN = [
  /(^|\/)tokenizer(_config)?\.json$/,
  /text_model/,
  /^eval\//, /^tools\//, /^scripts\//, /^node_modules\//, /^chrome\//, /^\.git\//, /^\.claude\//,
  /\.md$/, /^package(-lock)?\.json$/, /\.DS_Store$/,
  // Only the ORT build the transformers.js bundle actually loads ships.
  /ort-wasm-simd-threaded\.(jsep|asyncify)\./, /ort-wasm-simd-threaded\.(mjs|wasm)$/, /\.map$/
];

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name), out);
  } else {
    out.push(rel);
  }
}

const files = [];
for (const entry of INCLUDE) {
  if (!fs.existsSync(path.join(ROOT, entry))) { console.warn(`  (missing) ${entry}`); continue; }
  walk(entry, files);
}

const bad = files.filter(f => FORBIDDEN.some(re => re.test(f)));
if (bad.length) {
  console.error('Refusing to package dev-only files:\n  ' + bad.join('\n  '));
  process.exit(1);
}
const visionModels = files.filter(f => /vision_model.*\.onnx$/.test(f));
if (visionModels.length !== 1) {
  console.error(`Expected exactly one vision model in models/, found ${visionModels.length}:\n  ${visionModels.join('\n  ')}`);
  process.exit(1);
}

let rawTotal = 0, gzTotal = 0;
const rows = [];
for (const f of files) {
  const buf = fs.readFileSync(path.join(ROOT, f));
  const gz = zlib.gzipSync(buf, { level: 6 }).length;
  rawTotal += buf.length; gzTotal += gz;
  rows.push({ f, raw: buf.length, gz });
}
rows.sort((a, b) => b.gz - a.gz);
const mb = (n) => (n / 1e6).toFixed(2).padStart(7) + ' MB';
console.log('Largest shipped files (raw / compressed):');
for (const r of rows.slice(0, 10)) console.log(`  ${mb(r.raw)}  ${mb(r.gz)}  ${r.f}`);
console.log(`\n${files.length} files, total ${mb(rawTotal)} raw, ${mb(gzTotal)} compressed (≈ Web Store download)`);

if (CHECK_ONLY) process.exit(0);

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const distDir = path.join(ROOT, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const zipPath = path.join(distDir, `scaredycat-${version}.zip`);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
execFileSync('zip', ['-q', '-X', zipPath, ...files], { cwd: ROOT, stdio: 'inherit' });
console.log(`\nWrote ${path.relative(ROOT, zipPath)} (${mb(fs.statSync(zipPath).size)})`);
