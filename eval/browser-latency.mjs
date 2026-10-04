/**
 * Latency / work harness: loads the unpacked extension in Chrome for Testing
 * and measures, per fixture page, what the user feels and what the extension
 * does:
 *   - init -> db-ready (content-script cold start)
 *   - time to first blur (from navigation start)
 *   - CLASSIFY_IMAGE requests issued, ML verdicts, p50/p95 verdict latency
 *   - service-worker counters (requests, cache hits, offscreen sends, throttled)
 *   - page.metrics() ScriptDuration as a per-page CPU proxy, JSHeapUsedSize
 *   - whether the offscreen document exists after the page, and its memory
 *     (JS heap + ArrayBuffer backing stores)
 *
 * Fixtures are served locally but under real media hostnames via
 * --host-resolver-rules, so early-init / isMediaSite paths trigger exactly
 * as in production. Each page is visited twice per round: first = cold
 * (model/cache may be cold), second = warm.
 *
 *   SC_CHROME_BIN=<chrome-for-testing> node eval/browser-latency.mjs [--rounds N] [--live] [--json out.json] [--db merged.json]
 *     [--wakes N] [--wake-gap 35]
 *
 * Content-script perf marks (data-sc-perf) are off by default; the harness
 * turns them on by setting chrome.storage.local.scDebugPerf = true through
 * the worker before the first page.
 *
 * --wakes N runs a separate pass that counts service-worker starts while a
 * tab navigates N times between unrelated pages (no content-script message
 * involved), N * --wake-gap seconds apart. The gap must exceed the worker's
 * ~30 s idle timeout, or one start covers several navigations. The worker
 * is not attached to in this pass (DevTools would keep it alive).
 *
 * --db <path> installs that database (e.g. the merged curated + auto artifact
 * from scared-cat-web's `titles:refresh -- --out`) into chrome.storage.local
 * before the first page of each round, so init→db and verdict latency are
 * measured against it instead of the bundled curated list.
 *
 * Requires: npm install --no-save puppeteer-core sharp
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { isolatedWorld } from './browser-smoke-lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SC_CHROME_BIN;
if (!CHROME) throw new Error('SC_CHROME_BIN not set');

const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const ROUNDS = parseInt(argVal('--rounds', '1'), 10);
const LIVE = args.includes('--live');
const JSON_OUT = argVal('--json', null);
const SETTLE_MS = parseInt(argVal('--settle', '12000'), 10);
const DB_PATH = argVal('--db', null);
const WAKES = parseInt(argVal('--wakes', '0'), 10);
const WAKE_GAP_S = parseFloat(argVal('--wake-gap', '35'));
const DB_OVERRIDE = DB_PATH ? JSON.parse(fs.readFileSync(path.resolve(DB_PATH), 'utf8')) : null;
if (DB_OVERRIDE && (!Array.isArray(DB_OVERRIDE.titles) || typeof DB_OVERRIDE.version !== 'string')) {
  throw new Error(`--db ${DB_PATH}: not a horror database (needs titles[] and version)`);
}
console.log(DB_OVERRIDE
  ? `DB: ${path.resolve(DB_PATH)} (v${DB_OVERRIDE.version}, ${DB_OVERRIDE.titles.length} titles, ${DB_OVERRIDE.titles.filter(t => t.auto === true).length} auto)`
  : 'DB: bundled data/horror-database.json');
const PORT = 8905;

// ---- fixtures ---------------------------------------------------------------
const sharp = (await import('sharp')).default;
const FIXTURE_DIR = '/tmp/scaredycat-fixtures';
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

async function fixturePoster() {
  const file = path.join(FIXTURE_DIR, 'hereditary.png');
  if (!fs.existsSync(file)) {
    const res = await fetch('https://upload.wikimedia.org/wikipedia/en/d/d9/Hereditary.png',
      { headers: { 'User-Agent': 'scaredycat-eval/1.0 (github.com/flenguyen/scaredycat)' } });
    if (!res.ok) throw new Error(`poster fetch failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 10000) throw new Error('poster fixture suspiciously small');
    fs.writeFileSync(file, buf);
  }
  return fs.readFileSync(file);
}

// Deterministic "photo-like" cards: gradient + noise so every URL is a
// distinct image and none is a flat color the model has seen before.
const cardCache = new Map();
async function cardImage(n, w = 300, h = 444) {
  const key = `${n}-${w}x${h}`;
  if (cardCache.has(key)) return cardCache.get(key);
  const seed = (n * 2654435761) >>> 0;
  const r = seed & 255, g = (seed >> 8) & 255, b = (seed >> 16) & 255;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="rgb(${r},${g},${b})"/>
      <stop offset="1" stop-color="rgb(${255 - r},${255 - g},${255 - b})"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${(seed % w)}" cy="${(seed >> 4) % h}" r="${40 + (seed % 60)}" fill="rgba(255,255,255,0.35)"/>
    <text x="16" y="${h - 20}" font-size="28" fill="#fff">card ${n}</text>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
  cardCache.set(key, buf);
  return buf;
}

const POSTER = await fixturePoster();

const YT_TITLES = [
  'HEREDITARY Official Trailer (2018) Toni Collette Horror Movie',
  'Top 10 Scariest Movies of All Time',
  'How to bake sourdough bread at home',
  'THE CONJURING: LAST RITES - Official Trailer',
  'iPhone 17 review: is it worth it?',
  'Golden retriever puppy first day home',
  'Terrifier 3 trailer reaction',
  'Lo-fi beats to study to',
  'The Nun II | Final Trailer',
  'Best budget travel destinations 2026'
];

function imdbPage() {
  const cards = Array.from({ length: 30 }, (_, i) => `
    <div class="ipc-poster-card">
      <a href="/title/tt${1000 + i}/" class="ipc-lockup-overlay">
        <div class="ipc-poster"><img class="ipc-image" alt="Poster for Film ${i + 1}" loading="eager"
          src="/img/card-${i}.jpg" width="200" height="296"></div>
      </a>
      <span class="ipc-title">Film ${i + 1}</span>
    </div>`).join('');
  return `<!DOCTYPE html><html><head><title>Hereditary (2018) - IMDb</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Movie","name":"Hereditary","genre":["Drama","Horror","Mystery"],"url":"https://www.imdb.com/title/tt7784604/"}</script>
  <style>body{margin:0;font-family:sans-serif}.hero{display:flex;gap:24px;padding:24px}.grid{display:grid;grid-template-columns:repeat(5,200px);gap:16px;padding:24px}img{display:block}</style>
  </head><body>
  <section data-testid="hero-parent">
    <h1 data-testid="hero__pageTitle">Hereditary</h1>
    <div class="ipc-chip-list"><a class="ipc-chip" href="/search/title/?genres=drama">Drama</a><a class="ipc-chip" href="/search/title/?genres=horror">Horror</a><a class="ipc-chip" href="/search/title/?genres=mystery">Mystery</a></div>
    <div class="hero">
      <div class="ipc-poster" data-testid="hero-media__poster"><img id="hero" class="ipc-image" alt="Hereditary" src="/img/poster.png" width="300" height="444"></div>
      <div style="width:640px;height:360px;background:#222"></div>
    </div>
  </section>
  <section data-testid="MoreLikeThis"><h3>More like this</h3><div class="grid">${cards}</div></section>
  </body></html>`;
}

function youtubePage() {
  const items = Array.from({ length: 40 }, (_, i) => `
    <ytd-video-renderer class="style-scope">
      <a id="thumbnail" href="/watch?v=vid${i}"><yt-image><img src="/img/thumb-${i}.jpg" width="360" height="202" alt=""></yt-image></a>
      <div id="meta"><h3><a id="video-title" title="${YT_TITLES[i % YT_TITLES.length]}" href="/watch?v=vid${i}">${YT_TITLES[i % YT_TITLES.length]}</a></h3></div>
    </ytd-video-renderer>`).join('');
  return `<!DOCTYPE html><html><head><title>horror trailer 2026 - YouTube</title>
  <style>body{margin:0}ytd-video-renderer{display:flex;gap:16px;padding:8px 24px}img{display:block}</style></head>
  <body><ytd-app><div id="contents">${items}</div></ytd-app></body></html>`;
}

function neutralPage() {
  const imgs = Array.from({ length: 40 }, (_, i) => `
    <figure><img src="/img/photo-${i}.jpg" alt="Golden retriever photo ${i + 1}" width="400" height="300"><figcaption>Photo ${i + 1}</figcaption></figure>`).join('');
  return `<!DOCTYPE html><html><head><title>Golden Retriever care guide - The Dog Blog</title>
  <style>body{margin:0;font-family:serif;max-width:900px}figure{margin:16px}</style></head>
  <body><h1>Golden Retriever care guide</h1><p>Everything about grooming, feeding and training.</p>${imgs}</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/img/')) {
      const name = url.slice(5);
      if (name === 'poster.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(POSTER); }
      const m = /^(card|thumb|photo)-(\d+)\.jpg$/.exec(name);
      if (m) {
        const n = parseInt(m[2], 10);
        const dims = m[1] === 'card' ? [200, 296] : m[1] === 'thumb' ? [360, 202] : [400, 300];
        const buf = await cardImage(n + (m[1] === 'thumb' ? 100 : m[1] === 'photo' ? 200 : 0), ...dims);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
        return res.end(buf);
      }
      res.writeHead(404); return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (host.endsWith('imdb.com')) return res.end(imdbPage());
    if (host.endsWith('youtube.com')) return res.end(youtubePage());
    return res.end(neutralPage());
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});
await new Promise(r => server.listen(PORT, r));

const PAGES = LIVE ? [
  { id: 'imdb-live', url: 'https://www.imdb.com/title/tt7784604/' },
  { id: 'youtube-live', url: 'https://www.youtube.com/results?search_query=horror+trailer+2026' },
  { id: 'neutral-live', url: 'https://en.wikipedia.org/wiki/Golden_Retriever' }
] : [
  { id: 'imdb', url: `http://www.imdb.com:${PORT}/title/tt7784604/` },
  { id: 'youtube', url: `http://www.youtube.com:${PORT}/results?search_query=horror+trailer+2026` },
  { id: 'neutral', url: `http://dogblog.test:${PORT}/golden-retriever` }
];

// ---- measurement --------------------------------------------------------------
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const median = (arr) => pct(arr.filter(v => v !== null && v !== undefined), 0.5);

// Perf marks are mirrored to <html data-sc-perf> (main world) once the
// scDebugPerf flag is on. Verdicts live in the content script's isolated
// world (ScaredyCatState), so they are read there.
async function readPerf(page, world) {
  const perf = await page.evaluate(() => {
    try { return JSON.parse(document.documentElement.dataset.scPerf || '{}'); } catch (e) { return {}; }
  });
  let states = {}, overlays = 0;
  try {
    ({ states, overlays } = await world.evaluate(() => {
      const states = {};
      document.querySelectorAll('img, video, iframe').forEach(el => {
        const s = ScaredyCatState.get(el);
        if (s) states[s] = (states[s] || 0) + 1;
      });
      return { states, overlays: ScaredyCatBlocker.getBlockedCount() };
    }));
  } catch (e) { /* content script not injected yet */ }
  return { perf, states, overlays };
}

async function getSwWorker(browser) {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
  return target.worker();
}

/**
 * Replace the stored database with DB_OVERRIDE. Waits for background.js's
 * install-time seed to land first (otherwise the seed could race in after us
 * and overwrite it), and clears the daily refresh alarm so db-updater can't
 * swap in the remote list mid-run.
 */
async function installDbOverride(browser) {
  const sw = await getSwWorker(browser);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const seeded = await sw.evaluate(async () => !!(await chrome.storage.local.get('horrorDatabase')).horrorDatabase);
    if (seeded) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const count = await sw.evaluate(async (db) => {
    await chrome.alarms.clear('refresh-horror-db');
    await chrome.storage.local.set({ horrorDatabase: db });
    return (await chrome.storage.local.get('horrorDatabase')).horrorDatabase.titles.length;
  }, DB_OVERRIDE);
  if (count !== DB_OVERRIDE.titles.length) throw new Error(`--db install failed: stored ${count} titles`);
}

/** Turn on content-script perf marks (off by default) before any page loads. */
async function enableDebugPerf(browser) {
  const sw = await getSwWorker(browser);
  await sw.evaluate(() => chrome.storage.local.set({ scDebugPerf: true }));
}

/** Offscreen document memory, or null when there is no offscreen document. */
async function offscreenMemory(browser) {
  const target = browser.targets().find(t => t.url().includes('offscreen/offscreen.html'));
  if (!target) return null;
  try {
    const cdp = await target.createCDPSession();
    const u = await cdp.send('Runtime.getHeapUsage');
    await cdp.detach();
    return { jsHeapMB: +(u.usedSize / 1e6).toFixed(1), backingMB: +((u.backingStorageSize || 0) / 1e6).toFixed(1) };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function measure(browser, pageDef, label) {
  let sw = null;
  try { sw = await getSwWorker(browser); await sw.evaluate(() => self.__scStats?.reset?.()); } catch (e) { /* SW asleep; counters start at 0 anyway */ }

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const world = await isolatedWorld(page);
  const t0 = Date.now();
  await page.goto(pageDef.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Poll until nothing is pending or the settle window closes.
  let snap = null;
  const deadline = t0 + SETTLE_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    snap = await readPerf(page, world);
    const pending = snap.states.pending || 0;
    const anyProcessed = Object.keys(snap.states).length > 0;
    if (anyProcessed && pending === 0 && Date.now() - t0 > 3000) break;
  }
  snap = await readPerf(page, world);
  const metrics = await page.metrics();
  let swStats = null;
  try { sw = sw || await getSwWorker(browser); swStats = await sw.evaluate(() => { const s = self.__scStats; return s ? { classifyRequests: s.classifyRequests, cacheHits: s.cacheHits, negativeHits: s.negativeHits, offscreenSends: s.offscreenSends, throttled: s.throttled || 0, lat: s.verdictLatencies } : null; }); } catch (e) {}
  const offscreen = await offscreenMemory(browser);
  await page.close();

  const m = snap.perf.marks || {}, c = snap.perf.counts || {};
  const first = (name) => (m[name] && m[name].length ? m[name][0] : null);
  const verdictTimes = (m['sc:ml-verdict'] || []).concat(m['sc:ml-verdict-null'] || []);
  const requestTimes = m['sc:classify-request'] || [];
  return {
    page: pageDef.id, label,
    initMs: first('sc:init'),
    dbReadyMs: first('sc:db-ready'),
    initToDb: first('sc:db-ready') !== null && first('sc:init') !== null ? +(first('sc:db-ready') - first('sc:init')).toFixed(1) : null,
    firstScanMs: first('sc:first-scan'),
    firstBlurMs: first('sc:blur'),
    blurs: c['sc:blur'] || 0,
    classifyRequests: c['sc:classify-request'] || 0,
    verdicts: (c['sc:ml-verdict'] || 0) + (c['sc:ml-verdict-null'] || 0),
    firstVerdictMs: verdictTimes.length ? Math.min(...verdictTimes) : null,
    lastVerdictMs: verdictTimes.length ? Math.max(...verdictTimes) : null,
    firstRequestMs: requestTimes.length ? Math.min(...requestTimes) : null,
    states: snap.states,
    sw: swStats ? { requests: swStats.classifyRequests, cacheHits: swStats.cacheHits, negative: swStats.negativeHits, sends: swStats.offscreenSends, throttled: swStats.throttled, latP50: pct(swStats.lat, 0.5), latP95: pct(swStats.lat, 0.95) } : null,
    offscreen,
    scriptMs: +(metrics.ScriptDuration * 1000).toFixed(0),
    taskMs: +(metrics.TaskDuration * 1000).toFixed(0),
    heapMB: +(metrics.JSHeapUsedSize / 1e6).toFixed(1)
  };
}

const results = [];
for (let round = 0; round < ROUNDS; round++) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: [
      `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run', '--window-size=1200,900',
      ...(LIVE ? [] : ['--host-resolver-rules=MAP www.imdb.com 127.0.0.1, MAP www.youtube.com 127.0.0.1, MAP dogblog.test 127.0.0.1'])
    ]
  });
  try {
    await enableDebugPerf(browser);
    if (DB_OVERRIDE) await installDbOverride(browser);
    for (const label of ['cold', 'warm']) {
      for (const p of PAGES) {
        const r = await measure(browser, p, label);
        r.round = round;
        results.push(r);
        console.log(`[r${round} ${label.padEnd(4)} ${p.id.padEnd(12)}] init→db ${String(r.initToDb).padStart(6)}ms  firstScan ${String(r.firstScanMs).padStart(7)}ms  firstBlur ${String(r.firstBlurMs).padStart(7)}ms  blurs ${String(r.blurs).padStart(2)}  classify ${String(r.classifyRequests).padStart(3)}  verdicts ${String(r.verdicts).padStart(3)} (first ${r.firstVerdictMs}ms, last ${r.lastVerdictMs}ms)  sw ${r.sw ? `req ${r.sw.requests} hit ${r.sw.cacheHits} sends ${r.sw.sends} p50 ${r.sw.latP50}ms p95 ${r.sw.latP95}ms` : 'n/a'}  script ${r.scriptMs}ms  heap ${r.heapMB}MB  offscreen ${r.offscreen ? `${r.offscreen.jsHeapMB}+${r.offscreen.backingMB}MB` : 'none'}  states ${JSON.stringify(r.states)}`);
      }
    }
  } finally {
    await browser.close();
  }
}

// ---- summary (median across rounds) ------------------------------------------
console.log('\n== medians across rounds ==');
for (const label of ['cold', 'warm']) {
  for (const p of PAGES) {
    const rs = results.filter(r => r.page === p.id && r.label === label);
    const med = (k) => median(rs.map(r => r[k]));
    console.log(`${label.padEnd(4)} ${p.id.padEnd(12)} init→db ${med('initToDb')}ms  firstBlur ${med('firstBlurMs')}ms  classify ${med('classifyRequests')}  verdicts ${med('verdicts')}  firstVerdict ${med('firstVerdictMs')}ms  lastVerdict ${med('lastVerdictMs')}ms  script ${med('scriptMs')}ms`);
  }
}

// ---- service-worker wakes over unrelated navigations -----------------------------
let wakeResult = null;
if (WAKES > 0 && !LIVE) {
  // Don't let puppeteer attach to the worker: an attached worker never idles.
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    targetFilter: (target) => target.type() !== 'service_worker',
    args: [
      `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run', '--window-size=1200,900',
      '--host-resolver-rules=MAP dogblog.test 127.0.0.1, MAP otherblog.test 127.0.0.1'
    ]
  });
  try {
    const cdp = await browser.target().createCDPSession();
    let starts = 0;
    const isOurWorker = (info) => info.type === 'service_worker' && info.url.endsWith('/background.js');
    cdp.on('Target.targetCreated', ({ targetInfo }) => { if (isOurWorker(targetInfo)) starts++; });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const page = await browser.newPage();
    // Let the install-time work finish and the worker go idle first.
    await new Promise(r => setTimeout(r, WAKE_GAP_S * 1000));
    const before = starts;
    for (let i = 0; i < WAKES; i++) {
      const host = i % 2 ? 'otherblog.test' : 'dogblog.test';
      await page.goto(`http://${host}:${PORT}/post-${i}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise(r => setTimeout(r, WAKE_GAP_S * 1000));
    }
    wakeResult = { navigations: WAKES, gapS: WAKE_GAP_S, workerStarts: starts - before };
    console.log(`\n== service-worker wakes ==\n${wakeResult.workerStarts} worker start(s) over ${WAKES} unrelated navigations, ${WAKE_GAP_S}s apart`);
  } finally {
    await browser.close();
  }
}
server.close();

if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ results, wakes: wakeResult }, null, 2));
