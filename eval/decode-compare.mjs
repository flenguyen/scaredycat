/**
 * Score-drift gate for the offscreen decode path and smaller CDN variants.
 *
 * Launches Chrome for Testing with the unpacked extension, drives the
 * offscreen classifier over CDP through its __scEval dev hook (shipped fp16
 * tower), and scores the calibration images two ways:
 *
 *   decode   'legacy' (RawImage.fromBlob + transformers.js resize/crop) vs
 *            'canvas' (the same canvas resize/crop, drawn straight from the
 *            decoded bitmap: one full-size buffer instead of five) and
 *            'bitmap-<quality>' (createImageBitmap straight to 256 px + one
 *            reused canvas crop, no full-size buffer at all)
 *   variants (--variants) the page's CDN URL vs the smaller rendition from
 *            image-key.js smallVariantUrl, fetched live: TMDB original vs
 *            w500, Amazon/IMDb ._V1_ vs ._V1_UX512_, YouTube maxresdefault
 *            vs hqdefault
 *
 * Gate (per comparison): max |Δ| <= --tolerance (2) and no image crossing an
 * ml-bridge.js decision bar (41/40/65/76/80).
 *
 * Also reports the offscreen document's peak JS memory per path (JS heap +
 * ArrayBuffer backing stores, sampled every 25 ms over the set after a
 * forced GC; canvas and bitmap pixels outside JS are not counted).
 *
 *   SC_CHROME_BIN=<chrome> node eval/decode-compare.mjs [--paths canvas,bitmap-high,bitmap-low]
 *     [--sets full,page] [--device webgpu|wasm] [--variants] [--tolerance 2] [--json out.json]
 *
 * Calibration images: posters and trailer stills from IMDb's suggestion API,
 * cached in CALIB_DIR on first run, in two sets: 'full' (the originals, 1-23
 * MP, the worst case for resampling) and 'page' (the sizes pages actually
 * show: posters at 380 px wide, stills at 500 px). Images over the
 * classifier's 8 MB cap are reported and skipped. They are served on a
 * mapped public-looking hostname: the classifier refuses localhost URLs.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SC_CHROME_BIN;
if (!CHROME) throw new Error('SC_CHROME_BIN not set');
const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const TOLERANCE = parseFloat(argVal('--tolerance', '2'));
const PATHS = argVal('--paths', 'canvas,bitmap-high,bitmap-low').split(',');
const SETS = argVal('--sets', 'full,page').split(',');
const DEVICE = argVal('--device', 'webgpu');
const VARIANTS = args.includes('--variants');
const JSON_OUT = argVal('--json', null);
const CALIB_DIR = '/tmp/scaredycat-fixtures/calib-decode';
const BARS = [41, 40, 65, 76, 80]; // ml-bridge.js decision bars
const PORT = 8908;
const HOST = 'calib.scaredycat.test';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// Horror posters across the bars, plus the dark-but-safe posters the bars
// were calibrated against (ml-bridge.js comments) and plainly safe ones.
const TITLES = [
  ['Hereditary', 2018], ['The Conjuring', 2013], ['Insidious', 2010], ['The Nun', 2018],
  ['It', 2017], ['Sinister', 2012], ['The Babadook', 2014], ['Midsommar', 2019],
  ['Smile', 2022], ['Talk to Me', 2022], ['Terrifier', 2016], ['Us', 2019],
  ['Get Out', 2017], ['A Quiet Place', 2018], ['The Exorcist', 1973], ['The Shining', 1980],
  ['Cape Fear', 1991], ['The Devil Wears Prada', 2006], ['Mortal Kombat', 2021],
  ['White House Down', 2013], ['Masters of the Universe', 1987], ['Se7en', 1995],
  ['The Dark Knight', 2008], ['Joker', 2019], ['Barbie', 2023], ['Finding Nemo', 2003],
  ['Paddington 2', 2017], ['Oppenheimer', 2023]
];
// Trailer stills (16:9) for these, to cover the landscape decode branch.
const STILLS = new Set(['Hereditary', 'The Conjuring', 'Smile', 'Talk to Me', 'Us', 'Cape Fear', 'Barbie', 'Finding Nemo']);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Fill CALIB_DIR from IMDb's suggestion API; returns the sources list. */
async function ensureFixtures() {
  fs.mkdirSync(CALIB_DIR, { recursive: true });
  const sourcesFile = path.join(CALIB_DIR, 'sources.json');
  if (fs.existsSync(sourcesFile)) return JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));
  const sources = [];
  for (const [title, year] of TITLES) {
    const data = await getJson(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(title.toLowerCase())}.json?includeVideos=1`);
    const hit = (data.d || []).find(r => r.y === year && r.qid === 'movie' && r.i?.imageUrl);
    if (!hit) { console.warn(`  no IMDb poster for ${title} (${year})`); continue; }
    const base = `${slug(title)}-${year}`;
    const add = async (file, kind, url, w, h, pageOps) => {
      sources.push({ set: 'full', file, title, year, imdb: hit.id, kind, url, w, h });
      await download(url, path.join(CALIB_DIR, file));
      const pageUrl = url.replace(/\._V1_\.(jpe?g)$/i, `._V1_${pageOps}_.$1`);
      const pageFile = file.replace(/\.jpg$/, '-page.jpg');
      sources.push({ set: 'page', file: pageFile, title, year, imdb: hit.id, kind, url: pageUrl });
      await download(pageUrl, path.join(CALIB_DIR, pageFile));
    };
    await add(`${base}.jpg`, 'poster', hit.i.imageUrl, hit.i.width, hit.i.height, 'QL75_UX380');
    const still = (hit.v || []).find(v => v.i?.imageUrl && v.i.width > v.i.height);
    if (STILLS.has(title) && still) {
      await add(`${base}-still.jpg`, 'still', still.i.imageUrl, still.i.width, still.i.height, 'QL75_UX500');
    }
    process.stdout.write('.');
  }
  console.log(` ${sources.length} calibration images`);
  fs.writeFileSync(sourcesFile, JSON.stringify(sources, null, 2));
  return sources;
}

/**
 * TMDB poster file + YouTube trailer key per title, scraped from
 * themoviedb.org (no API key). Through curl: the site answers Node's fetch
 * with a 403.
 */
function curlText(url) {
  return execFileSync('curl', ['-sL', '-A', UA, url], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

async function tmdbSources(titles) {
  const out = [];
  for (const [title, year] of titles) {
    try {
      const search = curlText(`https://www.themoviedb.org/search/movie?query=${encodeURIComponent(title)}`);
      const id = /href="\/movie\/(\d+)[^"]*"/.exec(search)?.[1];
      if (!id) continue;
      const page = curlText(`https://www.themoviedb.org/movie/${id}`);
      const poster = /t\/p\/w300_and_h450_[a-z_]+\/([A-Za-z0-9]+\.jpg)/.exec(page)?.[1];
      const videos = curlText(`https://www.themoviedb.org/movie/${id}/videos?active_nav_item=Trailers`);
      const yt = /data-id="([A-Za-z0-9_-]{11})"/.exec(videos)?.[1];
      out.push({ title, year, tmdb: id, poster, yt });
    } catch (e) {
      console.warn(`  tmdb lookup failed for ${title}: ${e.message}`);
    }
  }
  return out;
}

function loadImageKey() {
  const moduleObj = { exports: {} };
  new Function('module', fs.readFileSync(path.join(ROOT, 'background/image-key.js'), 'utf8'))(moduleObj);
  return moduleObj.exports;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // offscreen/classifier.js cap
const allSources = await ensureFixtures();
const sources = allSources.filter(s => SETS.includes(s.set) && fs.statSync(path.join(CALIB_DIR, s.file)).size <= MAX_IMAGE_BYTES);
for (const s of allSources) {
  if (SETS.includes(s.set) && !sources.includes(s)) console.log(`  skipped ${s.file}: over the 8 MB fetch cap (the classifier refuses it on every path)`);
}
const files = sources.map(s => s.file);
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  if (!files.includes(name)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'image/jpeg' });
  res.end(fs.readFileSync(path.join(CALIB_DIR, name)));
});
await new Promise(r => server.listen(PORT, r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run',
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`]
});
const results = { device: DEVICE, decode: {}, variants: {} };
try {
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 });
  const sw = await swTarget.worker();
  await sw.evaluate(async () => {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!ctx.length) {
      await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['WORKERS'], justification: 'decode comparison harness' });
    }
  });
  const offTarget = await browser.waitForTarget(t => t.url().includes('offscreen/offscreen.html'), { timeout: 20000 });
  const cdp = await offTarget.createCDPSession();
  await cdp.send('Runtime.enable');
  await cdp.send('Performance.enable');
  cdp.on('Runtime.exceptionThrown', (ev) => console.log(`    [offscreen exception] ${(ev.exceptionDetails.exception?.description || ev.exceptionDetails.text || '').slice(0, 300)}`));
  const evalIn = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || JSON.stringify(exceptionDetails));
    return result.value;
  };
  let info = null;
  for (let i = 0; i < 100 && !info; i++) {
    try { info = await evalIn(`globalThis.__scEval ? __scEval.ready('fp16', ${JSON.stringify(DEVICE)}) : null`); } catch (e) { info = null; }
    if (!info) await new Promise(r => setTimeout(r, 300));
  }
  if (!info) throw new Error('classifier never became ready');
  console.log(`classifier ready: ${info.device}/${info.dtype} in ${info.loadMs}ms`);
  const classify = (url, opts) => evalIn(`__scEval.classify(${JSON.stringify(url)}, ${JSON.stringify(opts)})`);

  // ---- decode paths ---------------------------------------------------------------
  const optsFor = (label) => label.startsWith('bitmap-') ? { decode: 'bitmap', quality: label.slice(7) } : { decode: label };
  const paths = [['legacy', { decode: 'legacy' }], ...PATHS.map(label => [label, optsFor(label)])];
  // JS heap plus ArrayBuffer backing stores (where decoded pixel arrays live).
  const heapUsed = async () => {
    const u = await cdp.send('Runtime.getHeapUsage');
    return (u.usedSize || 0) + (u.backingStorageSize || 0);
  };
  for (const [label, opts] of paths) {
    const scores = {};
    const ms = [];
    await cdp.send('HeapProfiler.collectGarbage');
    const baseHeap = await heapUsed();
    let peakHeap = baseHeap;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        peakHeap = Math.max(peakHeap, await heapUsed());
        await new Promise(r => setTimeout(r, 25));
      }
    })();
    for (const s of sources) {
      const r = await classify(`http://${HOST}:${PORT}/${encodeURIComponent(s.file)}`, opts);
      scores[s.file] = r.score;
      ms.push(r.ms);
    }
    sampling = false;
    await sampler;
    results.decode[label] = {
      scores,
      medianMs: ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)],
      peakHeapMB: +((peakHeap - baseHeap) / 1e6).toFixed(1)
    };
    console.log(`  ${label}: done (median ${results.decode[label].medianMs}ms/image, peak JS memory +${results.decode[label].peakHeapMB} MB)`);
  }

  // ---- CDN variants ---------------------------------------------------------------
  if (VARIANTS) {
    const { smallVariantUrl } = loadImageKey();
    const pairs = [];
    for (const s of sources.filter(x => x.set === 'full')) pairs.push({ cdn: 'amzn', name: s.file, url: s.url });
    for (const t of await tmdbSources(TITLES.slice(0, 16))) {
      if (t.poster) pairs.push({ cdn: 'tmdb', name: `${slug(t.title)} tmdb`, url: `https://image.tmdb.org/t/p/original/${t.poster}` });
      if (t.yt) pairs.push({ cdn: 'yt', name: `${slug(t.title)} yt`, url: `https://i.ytimg.com/vi/${t.yt}/maxresdefault.jpg` });
    }
    for (const p of pairs) {
      p.variant = smallVariantUrl(p.url, { cdns: [p.cdn] });
      if (p.variant === p.url) continue;
      const a = await classify(p.url, {});
      const b = await classify(p.variant, {});
      p.a = a.score; p.b = b.score; p.reasons = [a.reason, b.reason];
    }
    results.variants = pairs;
  }
} finally {
  await browser.close();
  server.close();
}

// ---- report -------------------------------------------------------------------------
const crossings = (a, b) => BARS.filter(bar => (a >= bar) !== (b >= bar));
function compare(label, rows) {
  let maxDelta = 0, crossed = 0, missing = 0;
  const lines = [];
  for (const { name, a, b } of rows) {
    if (typeof a !== 'number' || typeof b !== 'number') { missing++; lines.push(`  ${name.padEnd(44)} ${String(a).padStart(6)} ${String(b).padStart(6)}  (no score)`); continue; }
    const d = b - a;
    maxDelta = Math.max(maxDelta, Math.abs(d));
    const c = crossings(a, b);
    if (c.length) crossed++;
    lines.push(`  ${name.padEnd(44)} ${a.toFixed(1).padStart(6)} ${b.toFixed(1).padStart(6)} ${d.toFixed(2).padStart(7)}${c.length ? '  CROSSES ' + c.join(',') : ''}`);
  }
  const pass = rows.length > 0 && missing === 0 && maxDelta <= TOLERANCE && crossed === 0;
  return { label, maxDelta, crossed, missing, n: rows.length, pass, lines };
}

const summaries = [];
const legacy = results.decode.legacy.scores;
for (const label of PATHS) {
  for (const set of SETS) {
    const rows = sources.filter(s => s.set === set).map(s => ({ name: s.file, a: legacy[s.file], b: results.decode[label].scores[s.file] }));
    summaries.push(compare(`decode legacy -> ${label} [${set}]`, rows));
  }
}
if (VARIANTS) {
  for (const cdn of ['amzn', 'tmdb', 'yt']) {
    const rows = results.variants.filter(p => p.cdn === cdn && p.variant !== p.url).map(p => ({ name: p.name, a: p.a, b: p.b }));
    summaries.push(compare(`variant ${cdn} (page URL -> smaller)`, rows));
  }
}
for (const s of summaries) {
  console.log(`\n${s.label}   (orig / new / Δ)`);
  for (const l of s.lines) console.log(l);
  console.log(`  => n=${s.n} max |Δ| ${s.maxDelta.toFixed(2)} (tolerance ${TOLERANCE}), bar crossings ${s.crossed}, unscored ${s.missing}: ${s.pass ? 'PASS' : 'FAIL'}`);
}
console.log('\nmedian ms/image: ' + Object.entries(results.decode).map(([k, v]) => `${k} ${v.medianMs}`).join(', '));
console.log('peak offscreen JS memory over the set: ' + Object.entries(results.decode).map(([k, v]) => `${k} +${v.peakHeapMB} MB`).join(', '));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ results, summaries: summaries.map(({ lines, ...s }) => s) }, null, 2));
const passing = PATHS.filter(label => summaries.filter(s => s.label.startsWith(`decode legacy -> ${label} [`)).every(s => s.pass));
const decodePass = passing.length > 0;
console.log(`\nDECODE GATE ${decodePass ? 'PASS' : 'FAIL'}: paths within tolerance on every set: ${passing.join(', ') || 'none'}`);
process.exit(decodePass ? 0 : 1);
