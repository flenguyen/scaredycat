/**
 * Replay captured pages through the real extension and score the verdicts
 * against the labels in corpus.json.
 *
 *   SC_CHROME_BIN=<chrome-for-testing> node eval/cards/replay.mjs [--only id,id] [--name before] [--sensitivity medium] [--root <extension dir>]
 *
 * Every hostname resolves to a local TLS server (--host-resolver-rules
 * MAP * 127.0.0.1) that serves each capture's page.html at its original URL
 * and every downloaded asset at its original path, so site detection, the
 * page signal and image keys behave as they did live. Each page is scrolled
 * top to bottom (viewport gating), then every captured element's state is
 * read in the isolated world. Image scores come from the offscreen
 * classifier's __scEval hook (no rate limit), cached per model version in
 * .cache/image-scores.json.
 *
 * Writes .cache/replay-<name>.json and prints recall / false blur by site
 * and kind, plus image-only recall at the 65/76/80 bars.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { extensionArgs, focusPage, isolatedWorld } from '../browser-smoke-lib.mjs';
import {
  ROOT, CACHE, CAPTURES, ASSETS, CORPUS, REPLAY_PORT, chromeBin, replayUrl,
  readJson, writeJson, listCaptures, sleep
} from './lib.mjs';
import { report } from './report.mjs';

const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const ONLY = argVal('--only', null)?.split(',');
const NAME = argVal('--name', 'latest');
const SENSITIVITY = argVal('--sensitivity', 'medium');
// The extension to load: this checkout by default, or another one (a
// worktree of the commit to compare against).
const EXT_ROOT = path.resolve(argVal('--root', ROOT));

const captures = listCaptures().filter(c => !ONLY || ONLY.includes(c.id));
if (!captures.length) throw new Error('no captures (run eval/cards/capture.mjs first)');
const assetIndex = readJson(path.join(CACHE, 'assets.json'), {});
const corpus = readJson(CORPUS, { items: {} });
const manifest = readJson(path.join(EXT_ROOT, 'models', 'image-model.json'));
const SCORE_CACHE = path.join(CACHE, 'image-scores.json');
const scoreCache = readJson(SCORE_CACHE, {});

// ---- server ---------------------------------------------------------------------
const routes = new Map(); // replay URL -> { file, type }
for (const c of captures) {
  routes.set(replayUrl(c.url), { file: path.join(CAPTURES, c.id, 'page.html'), type: 'text/html; charset=utf-8' });
}
for (const [url, a] of Object.entries(assetIndex)) {
  const r = replayUrl(url);
  if (a.ok && r && !routes.has(r)) routes.set(r, { file: path.join(ASSETS, a.key), type: a.type });
}

const certDir = path.join(CACHE, 'cert');
if (!fs.existsSync(path.join(certDir, 'cert.pem'))) {
  fs.mkdirSync(certDir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
    '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
    '-subj', '/CN=scaredycat-replay'], { stdio: 'ignore' });
}
const server = https.createServer({
  key: fs.readFileSync(path.join(certDir, 'key.pem')),
  cert: fs.readFileSync(path.join(certDir, 'cert.pem'))
}, (req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  const hit = routes.get(`https://${host}:${REPLAY_PORT}${req.url}`);
  if (!hit) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': hit.type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  fs.createReadStream(hit.file).pipe(res);
});
await new Promise(r => server.listen(REPLAY_PORT, r));

// ---- isolated-world readers -------------------------------------------------------
function readVerdicts() {
  const out = {};
  const visit = (root) => {
    for (const el of root.querySelectorAll('[data-sc-cap]')) {
      let a = null;
      try { a = ScaredyCatDetector.analyzeElement(el); } catch (e) { /* not ready */ }
      out[el.getAttribute('data-sc-cap')] = {
        state: ScaredyCatState.get(el),
        blurred: ScaredyCatBlocker.wrapperOf(el) !== null,
        band: a && a.band, confidence: a && a.confidence,
        reasons: a && a.reasons, context: a && (a.context || '').slice(0, 200),
        selfLabel: !!(a && a.selfLabel), secondaryOnly: !!(a && a.secondaryOnly),
        kind: a && a.cardKind || null
      };
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) if (n.shadowRoot) visit(n.shadowRoot);
  };
  visit(document);
  return out;
}

function countPending() {
  let n = 0;
  const visit = (root) => {
    for (const el of root.querySelectorAll('img, video, iframe')) if (ScaredyCatState.get(el) === 'pending') n++;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let x;
    while ((x = walker.nextNode())) if (x.shadowRoot) visit(x.shadowRoot);
  };
  visit(document);
  return n;
}

// ---- run ---------------------------------------------------------------------------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-replay-'));
const browser = await puppeteer.launch({
  executablePath: chromeBin(),
  headless: false,
  defaultViewport: null,
  userDataDir: profile,
  args: extensionArgs(EXT_ROOT, [
    '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost',
    '--ignore-certificate-errors',
    '--window-size=1400,1000'
  ])
});

const results = {};
try {
  const sw = await (await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 })).worker();
  // Settings + db seed, and no remote refresh mid-run.
  for (let i = 0; i < 50; i++) {
    const seeded = await sw.evaluate(async () => !!(await chrome.storage.local.get('horrorDatabase')).horrorDatabase);
    if (seeded) break;
    await sleep(200);
  }
  await sw.evaluate(async (sensitivity) => {
    await chrome.alarms.clearAll();
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...(settings || {}), sensitivity } });
  }, SENSITIVITY);

  async function replayOne(c) {
    const page = await browser.newPage();
    await focusPage(browser, page);
    const world = await isolatedWorld(page);
    const t0 = Date.now();
    await page.goto(replayUrl(c.url), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 700) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await sleep(450);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    const deadline = Date.now() + 45000;
    let quiet = 0;
    while (Date.now() < deadline && quiet < 3) {
      await sleep(1000);
      const pending = await world.evaluate(countPending).catch(() => 1);
      quiet = pending === 0 ? quiet + 1 : 0;
    }
    results[c.id] = await world.evaluate(readVerdicts);
    const blocked = Object.values(results[c.id]).filter(v => v.state === 'blocked').length;
    console.log(`${c.id.padEnd(26)} ${String(Object.keys(results[c.id]).length).padStart(4)} cards  ${String(blocked).padStart(3)} blocked  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    await page.close();
  }

  // One retry per page: a long run occasionally hits a browser-side timeout.
  for (const c of captures) {
    try {
      await replayOne(c);
    } catch (e) {
      console.log(`${c.id.padEnd(26)} retrying after: ${String(e.message || e).slice(0, 100)}`);
      for (const p of await browser.pages()) if (p.url().includes(`:${REPLAY_PORT}`)) await p.close().catch(() => {});
      await replayOne(c);
    }
  }

  // Image scores straight from the classifier, for the image-only numbers.
  const want = [];
  for (const c of captures) {
    for (const m of c.media) {
      if (m.tag === 'iframe') continue;
      const key = `${manifest.version}|${m.src}`;
      if (scoreCache[key] === undefined && assetIndex[m.src]?.ok) want.push(m.src);
    }
  }
  if (want.length) {
    await sw.evaluate(async () => {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!ctx.length) await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['WORKERS'], justification: 'card eval' });
    });
    const off = await browser.waitForTarget(t => t.url().includes('offscreen/offscreen.html'), { timeout: 20000 });
    const cdp = await off.createCDPSession();
    await cdp.send('Runtime.enable');
    const ev = async (expression) => {
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'eval failed');
      return result.value;
    };
    for (let i = 0; i < 100; i++) {
      try { if (await ev('globalThis.__scEval ? __scEval.ready().then(() => true) : false')) break; } catch (e) { /* loading */ }
      await sleep(300);
    }
    for (const src of [...new Set(want)]) {
      try {
        const r = await ev(`__scEval.classify(${JSON.stringify(replayUrl(src))}).then(r => r.score)`);
        scoreCache[`${manifest.version}|${src}`] = typeof r === 'number' ? Math.round(r * 10) / 10 : null;
      } catch (e) {
        scoreCache[`${manifest.version}|${src}`] = null;
      }
    }
    writeJson(SCORE_CACHE, scoreCache);
  }
} finally {
  await browser.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

// ---- report ---------------------------------------------------------------------
const rows = [];
for (const c of captures) {
  for (const m of c.media) {
    const id = `${c.id}#${m.idx}`;
    const lab = corpus.items[id];
    const v = results[c.id]?.[String(m.idx)];
    rows.push({
      id, capture: c.id, site: c.id.split('-')[0], src: m.src,
      label: lab?.label || null, kind: lab?.kind || null,
      present: !!v, blocked: v?.state === 'blocked', state: v?.state || null,
      band: v?.band, confidence: v?.confidence, selfLabel: v?.selfLabel, secondaryOnly: v?.secondaryOnly,
      reasons: v?.reasons, context: v?.context,
      imageScore: scoreCache[`${manifest.version}|${m.src}`] ?? null
    });
  }
}
writeJson(path.join(CACHE, `replay-${NAME}.json`), { name: NAME, sensitivity: SENSITIVITY, model: manifest.version, at: new Date().toISOString(), rows });

report(NAME);
