/**
 * Build the distributable zip: runtime files only. Dev tooling (eval/, tools/,
 * scripts/, node_modules/, docs, the dev-only text tower) never ships.
 *
 *   npm run pack                  -> dist/scaredycat-<version>.zip + size report
 *   npm run pack -- --check       -> report only, no zip
 *   npm run pack:check -- --allow-dirty
 *                                 -> local check of uncommitted work (never
 *                                    for a build you upload)
 *
 * Both modes run the release check first (scripts/release-check.mjs) and
 * refuse to continue if the versions or data/releases.json disagree.
 *
 * Only files git tracks under INCLUDE are shipped, and only when they match
 * the commit: an untracked, modified or deleted file under INCLUDE stops the
 * build (a stray local file, such as a secrets file, can't slip into the zip).
 * vendor/ and models/ must match vendor/CHECKSUMS.sha256.
 *
 * models/ ships exactly models/image-model.json and the files it lists under
 * models/<dir>/ (one vision model); any other file there stops the build. The
 * .onnx files live in Git LFS, so a clone without `git lfs pull` holds small
 * pointer files instead, which also stops the build.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runReleaseCheck, formatErrors } from './release-check.mjs';
import { verifyChecksums, readChecksums, CHECKSUMS_FILE } from './checksums.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHECK_ONLY = process.argv.includes('--check');
const ALLOW_DIRTY = process.argv.includes('--allow-dirty');

const releaseErrors = runReleaseCheck({ root: ROOT });
if (releaseErrors.length) {
  console.error(formatErrors(releaseErrors));
  console.error('\nRefusing to build until the release check passes.');
  process.exit(1);
}

const INCLUDE = [
  'manifest.json',
  'background.js',
  'background',
  'content',
  'offscreen',
  'popup',
  'welcome',
  'styles',
  'fonts',
  'data',
  'vendor',
  'models',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png', 'icons/tmdb.svg',
  'THIRD_PARTY_NOTICES'
];
// Anything matching these must never end up in the zip.
const FORBIDDEN = [
  /(^|\/)tokenizer(_config)?\.json$/,
  /text_model/,
  /^eval\//, /^tools\//, /^scripts\//, /^node_modules\//, /^chrome\//, /^\.git\//, /^\.claude\//,
  /\.md$/, /^package(-lock)?\.json$/, /\.DS_Store$/, /(^|\/)\.env/,
  // Only the ORT build the transformers.js bundle actually loads ships.
  /ort-wasm-simd-threaded\.(jsep|asyncify)\./, /ort-wasm-simd-threaded\.(mjs|wasm)$/, /\.map$/
];

// Tracked but not shipped: the checksum list itself and the model runbook.
const SKIP = new Set([CHECKSUMS_FILE, 'models/README.md']);
const MODEL_MANIFEST = 'models/image-model.json';

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
}

const tracked = git('ls-files', '-z', '--', ...INCLUDE);
const untracked = git('ls-files', '-z', '--others', '--exclude-standard', '--', ...INCLUDE);
// Modified, deleted or staged-but-uncommitted, relative to HEAD.
const dirty = git('diff', '--name-only', '-z', 'HEAD', '--', ...INCLUDE);

const gitProblems = [
  ...untracked.map(f => `untracked: ${f}`),
  ...dirty.map(f => `${fs.existsSync(path.join(ROOT, f)) ? 'uncommitted changes' : 'deleted'}: ${f}`)
];
if (gitProblems.length) {
  if (ALLOW_DIRTY) {
    console.warn(`--allow-dirty: packing the working tree as is (${gitProblems.length} file(s) differ from HEAD)`);
  } else {
    console.error('Refusing to package files that differ from the commit:\n  ' + gitProblems.join('\n  '));
    console.error('Commit (or remove) them first; `--allow-dirty` is for local checks only.');
    process.exit(1);
  }
}

const files = [...new Set([...tracked, ...(ALLOW_DIRTY ? untracked : [])])]
  .filter(f => !SKIP.has(f) && fs.existsSync(path.join(ROOT, f)))
  .sort();
for (const entry of INCLUDE) {
  if (!files.some(f => f === entry || f.startsWith(entry + '/'))) console.warn(`  (missing) ${entry}`);
}

const bad = files.filter(f => FORBIDDEN.some(re => re.test(f)));
if (bad.length) {
  console.error('Refusing to package dev-only files:\n  ' + bad.join('\n  '));
  process.exit(1);
}

// models/: the manifest and exactly its files.
let modelFiles;
try {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, MODEL_MANIFEST), 'utf8'));
  if (typeof m.dir !== 'string' || !m.dir || m.dir.includes('..') || !Array.isArray(m.files) || !m.files.length) throw new Error('needs dir and files');
  modelFiles = [MODEL_MANIFEST, ...m.files.map(f => `models/${m.dir}/${f}`)];
} catch (e) {
  console.error(`Cannot read ${MODEL_MANIFEST}: ${e.message}`);
  process.exit(1);
}
const modelProblems = [
  ...files.filter(f => f.startsWith('models/') && !modelFiles.includes(f)).map(f => `${f}: not in ${MODEL_MANIFEST}`),
  ...modelFiles.filter(f => !files.includes(f)).map(f => `${f}: listed in ${MODEL_MANIFEST} but not tracked`)
];
if (modelProblems.length) {
  console.error('models/ does not match its manifest:\n  ' + modelProblems.join('\n  '));
  process.exit(1);
}
const lfsPointers = modelFiles.filter(f => {
  const abs = path.join(ROOT, f);
  if (fs.statSync(abs).size > 1024) return false;
  return fs.readFileSync(abs, 'utf8').startsWith('version https://git-lfs');
});
if (lfsPointers.length) {
  console.error('Model files are Git LFS pointers, not the files themselves (run git lfs pull):\n  ' + lfsPointers.join('\n  '));
  process.exit(1);
}
let listed;
try {
  listed = readChecksums(ROOT);
} catch (e) {
  console.error(`Cannot read ${CHECKSUMS_FILE}: ${e.message}`);
  process.exit(1);
}
const unlisted = modelFiles.filter(f => !listed.has(f));
if (unlisted.length) {
  console.error(`Model files missing from ${CHECKSUMS_FILE}:\n  ` + unlisted.join('\n  '));
  process.exit(1);
}

const checksumErrors = verifyChecksums(ROOT, files);
if (checksumErrors.length) {
  console.error('Vendored runtime or model files do not match their checksums:\n  ' + checksumErrors.join('\n  '));
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
