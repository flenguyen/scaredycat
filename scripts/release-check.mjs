/**
 * Release-notes consistency check (npm run release:check).
 *
 * data/releases.json is the one source for the popup's "What's new" view and
 * scaredycat.app/changelog. This keeps it honest against manifest.json and
 * package.json, and keeps the policy in CLAUDE.md "Releases" mechanical:
 * versions, levels, dates and copy rules are checked here, not remembered.
 *
 *   node scripts/release-check.mjs   -> prints problems, exits 1 if any
 *
 * validateReleases() is pure (unit-tested in eval/releases-test.mjs);
 * runReleaseCheck() reads the files (scripts/pack.mjs and the commit guard
 * hook call it).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const RELEASES_PATH = 'data/releases.json';
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CHANGE_TYPES = new Set(['new', 'improved', 'fixed', 'privacy']);
const SURFACES = new Set(['extension', 'website']);
const SUMMARY_MAX = 140;
const EM_DASH = '—';

function parseVersion(v) {
  const m = typeof v === 'string' ? VERSION_RE.exec(v) : null;
  return m ? m.slice(1, 4).map(Number) : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// 1 = major bump, 2 = minor, 3 = patch. Only meaningful when newer > older.
function bumpLevel(newer, older) {
  const n = parseVersion(newer), o = parseVersion(older);
  if (n[0] !== o[0]) return 1;
  if (n[1] !== o[1]) return 2;
  return 3;
}

function isRealDate(s) {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Local calendar date as YYYY-MM-DD (release dates are written in local time). */
export function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

// Every string in the payload, with a readable path, for the em dash rule.
function* strings(value, at) {
  if (typeof value === 'string') yield [at, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${at}[${i}]`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* strings(v, at ? `${at}.${k}` : k);
}

/**
 * Validate a parsed releases.json against the manifest and package versions.
 * Returns a list of human-readable problems (empty = good).
 *
 * @param {object} payload           parsed data/releases.json
 * @param {object} opts
 * @param {string} opts.manifestVersion
 * @param {string} opts.packageVersion
 * @param {string} [opts.today]      YYYY-MM-DD; defaults to the local date
 */
export function validateReleases(payload, { manifestVersion, packageVersion, today = localToday() } = {}) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (!payload || typeof payload !== 'object') return ['releases.json is not a JSON object'];
  if (payload.schema !== 1) err(`schema must be 1 (found ${JSON.stringify(payload.schema)})`);
  if (!Array.isArray(payload.releases) || payload.releases.length === 0) {
    err('releases must be a non-empty array');
    return errors;
  }

  // ---- Copy rule: no em dashes anywhere ----
  for (const [at, s] of strings(payload, '')) {
    if (s.includes(EM_DASH)) err(`${at} contains an em dash (U+2014); use a period, comma, colon or parentheses`);
  }

  // ---- Per-entry shape ----
  const ids = new Set();
  payload.releases.forEach((r, i) => {
    const where = `releases[${i}]${r && r.id ? ` (${r.id})` : ''}`;
    if (!r || typeof r !== 'object') { err(`${where} is not an object`); return; }

    if (!nonEmpty(r.id)) err(`${where}: id is missing`);
    else if (ids.has(r.id)) err(`${where}: duplicate id "${r.id}"`);
    else ids.add(r.id);

    if (!SURFACES.has(r.surface)) err(`${where}: surface must be "extension" or "website" (found ${JSON.stringify(r.surface)})`);

    if (r.surface === 'extension') {
      if (!parseVersion(r.version)) err(`${where}: version must look like 1.2.3 (found ${JSON.stringify(r.version)})`);
      else if (r.id !== r.version) err(`${where}: id must equal its version "${r.version}"`);
      if (![1, 2, 3].includes(r.level)) err(`${where}: level must be 1, 2 or 3 (found ${JSON.stringify(r.level)})`);
    } else if (r.surface === 'website') {
      if (r.version !== null) err(`${where}: website entries must have "version": null`);
      if (r.level !== null) err(`${where}: website entries must have "level": null`);
      if (typeof r.id !== 'string' || !r.id.startsWith('web-')) err(`${where}: website ids must start with "web-"`);
    }

    if (!isRealDate(r.date)) err(`${where}: date must be a real YYYY-MM-DD date (found ${JSON.stringify(r.date)})`);
    else if (r.date > today) err(`${where}: date ${r.date} is in the future (today is ${today})`);

    if (!nonEmpty(r.title)) err(`${where}: title is empty`);
    if (!nonEmpty(r.summary)) err(`${where}: summary is empty`);
    else if (r.summary.length > SUMMARY_MAX) err(`${where}: summary is ${r.summary.length} characters (max ${SUMMARY_MAX})`);
    if ('aside' in r && !nonEmpty(r.aside)) err(`${where}: aside, when present, must be a non-empty string`);

    if (!Array.isArray(r.changes) || r.changes.length === 0) err(`${where}: changes must be a non-empty array`);
    else r.changes.forEach((c, j) => {
      if (!c || !CHANGE_TYPES.has(c.type)) err(`${where}: changes[${j}].type must be new, improved, fixed or privacy (found ${JSON.stringify(c && c.type)})`);
      if (!c || !nonEmpty(c.text)) err(`${where}: changes[${j}].text is empty`);
    });

    if (!Array.isArray(r.commits) || r.commits.some(h => typeof h !== 'string' || !/^[0-9a-f]{7,40}$/.test(h))) {
      err(`${where}: commits must be an array of git hashes`);
    }
  });

  // ---- Ordering: dates never increase down the array (newest first) ----
  for (let i = 1; i < payload.releases.length; i++) {
    const prev = payload.releases[i - 1], cur = payload.releases[i];
    if (isRealDate(prev?.date) && isRealDate(cur?.date) && cur.date > prev.date) {
      err(`releases[${i}] (${cur.id}) is dated ${cur.date}, after the entry above it (${prev.id}, ${prev.date}); keep the list newest first`);
    }
  }

  // ---- Extension versions: unique, strictly decreasing, level = bump size ----
  const ext = payload.releases.filter(r => r && r.surface === 'extension' && parseVersion(r.version));
  for (let i = 0; i < ext.length; i++) {
    const cur = ext[i], older = ext[i + 1];
    if (!older) break; // the oldest release is exempt from the bump rule
    const cmp = compareVersions(cur.version, older.version);
    if (cmp === 0) { err(`version ${cur.version} appears twice`); continue; }
    if (cmp < 0) { err(`version ${cur.version} is listed above the older-looking ${older.version}; extension versions must strictly decrease down the list`); continue; }
    const expected = bumpLevel(cur.version, older.version);
    if ([1, 2, 3].includes(cur.level) && cur.level !== expected) {
      const kind = { 1: 'major', 2: 'minor', 3: 'patch' }[expected];
      err(`${cur.version} is a ${kind} bump from ${older.version}, so its level must be ${expected} (found ${cur.level})`);
    }
  }

  // ---- The four version numbers agree ----
  const newest = ext[0]?.version;
  const versions = {
    'manifest.json': manifestVersion,
    'package.json': packageVersion,
    'releases.json "current"': payload.current,
    'newest extension release': newest
  };
  const distinct = new Set(Object.values(versions));
  if (distinct.size !== 1 || !parseVersion([...distinct][0])) {
    err('version mismatch: ' + Object.entries(versions).map(([k, v]) => `${k} = ${v ?? '(missing)'}`).join(', '));
  }

  // ---- dataFlows ----
  const extVersions = new Set(ext.map(r => r.version));
  if (!Array.isArray(payload.dataFlows)) err('dataFlows must be an array');
  else payload.dataFlows.forEach((f, i) => {
    const where = `dataFlows[${i}]`;
    if (!f || typeof f !== 'object') { err(`${where} is not an object`); return; }
    for (const k of ['what', 'where', 'sends']) if (!nonEmpty(f[k])) err(`${where}.${k} is empty`);
    if (!extVersions.has(f.since)) err(`${where}.since "${f.since}" is not an extension version in releases`);
    if ('optIn' in f && typeof f.optIn !== 'boolean') err(`${where}.optIn must be true or false`);
  });

  return errors;
}

/**
 * Read the three files and validate. `read(relPath)` returns file text; the
 * default reads the working tree, the commit guard passes one that reads the
 * git index so it checks what is about to be committed.
 */
export function runReleaseCheck({ root = ROOT, read, today } = {}) {
  const readText = read || ((rel) => fs.readFileSync(path.join(root, rel), 'utf8'));
  const load = (rel) => {
    try { return { value: JSON.parse(readText(rel)) }; }
    catch (e) { return { error: `${rel}: ${e.code === 'ENOENT' ? 'file not found' : e.message}` }; }
  };
  const releases = load(RELEASES_PATH), manifest = load('manifest.json'), pkg = load('package.json');
  const loadErrors = [releases, manifest, pkg].filter(x => x.error).map(x => x.error);
  if (loadErrors.length) return loadErrors;
  return validateReleases(releases.value, {
    manifestVersion: manifest.value.version,
    packageVersion: pkg.value.version,
    ...(today ? { today } : {})
  });
}

export function formatErrors(errors) {
  return `Release check failed (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n`
    + errors.map(e => `  - ${e}`).join('\n')
    + '\nSee CLAUDE.md "Releases".';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const errors = runReleaseCheck();
  if (errors.length) {
    console.error(formatErrors(errors));
    process.exit(1);
  }
  const { current, releases } = JSON.parse(fs.readFileSync(path.join(ROOT, RELEASES_PATH), 'utf8'));
  console.log(`Release check passed: version ${current}, ${releases.length} entries.`);
}
