/**
 * Capture live pages for the card eval.
 *
 *   SC_CHROME_BIN=<chrome-for-testing> node eval/cards/capture.mjs [--only id,id] [--skip-existing]
 *
 * For each recipe in lib.mjs: load the live page with the unpacked extension
 * (headful, persistent profile in .cache/profile, which gets past most bot
 * walls), scroll through it, and record for every image/video/iframe of at
 * least 60px:
 *   - what the extension decided live (state, blurred, band, text score,
 *     reasons, the text it read)
 *   - the text of the nearest ancestor holding only this one media element
 *     (for labelling, independent of the extension's own text reading)
 * Then remove the extension's blurs, rewrite every asset URL to the replay
 * host, strip scripts, serialize the DOM (open shadow roots as declarative
 * shadow DOM) and download the assets. Output: .cache/captures/<id>/
 * {page.html, meta.json}, .cache/assets/<sha1>, .cache/assets.json.
 *
 * Requires: puppeteer-core (npm install --no-save puppeteer-core sharp).
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { extensionArgs, focusPage, isolatedWorld } from '../browser-smoke-lib.mjs';
import {
  ROOT, CACHE, CAPTURES, ASSETS, RECIPES, UA, chromeBin, assetKey, replayUrl,
  readJson, writeJson, sleep
} from './lib.mjs';

const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const ONLY = argVal('--only', null)?.split(',');
const SKIP_EXISTING = args.includes('--skip-existing');
const recipes = RECIPES.filter(r => !ONLY || ONLY.includes(r.id))
  .filter(r => !SKIP_EXISTING || !fs.existsSync(path.join(CAPTURES, r.id, 'meta.json')));

fs.mkdirSync(ASSETS, { recursive: true });
const ASSET_INDEX = path.join(CACHE, 'assets.json');
const assetIndex = readJson(ASSET_INDEX, {});

/** Runs in the isolated world: per-media verdicts and labelling text. */
function collect() {
  const all = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('img, video, iframe')) all.push(el);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) if (n.shadowRoot) visit(n.shadowRoot);
  };
  visit(document);
  const big = (m) => {
    const r = m.getBoundingClientRect();
    return r.width >= 60 && r.height >= 60;
  };
  const out = [];
  for (const el of all) {
    const tag = el.tagName;
    const src = tag === 'IMG' ? (el.currentSrc || el.src) : tag === 'VIDEO' ? el.poster : el.src;
    const r = el.getBoundingClientRect();
    if (!src || !/^https?:/.test(src)) continue;
    if (r.width < 60 || r.height < 60) continue;
    const idx = out.length;
    el.setAttribute('data-sc-cap', String(idx));
    let analysis = null;
    try {
      const a = ScaredyCatDetector.analyzeElement(el);
      analysis = {
        band: a.band, confidence: a.confidence, reasons: a.reasons,
        context: a.context, matchedTitle: a.matchedTitle || null
      };
    } catch (e) { /* not ready */ }
    let card = el;
    for (let k = 0, p = el.parentElement; k < 10 && p; k++, p = p.parentElement) {
      if ([...p.querySelectorAll('img, video')].filter(big).length > 1) break;
      card = p;
    }
    out.push({
      idx, tag: tag.toLowerCase(), src,
      w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + scrollY),
      state: ScaredyCatState.get(el),
      blurred: ScaredyCatBlocker.wrapperOf(el) !== null,
      analysis,
      cardText: (card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      cardTag: card.tagName.toLowerCase()
    });
  }
  return out;
}

/** Runs in the isolated world: unblur, rewrite assets, serialize. */
function snapshot(port) {
  ScaredyCatBlocker.removeAllBlurs();
  const toReplay = (url) => {
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      return { orig: u.href, replay: `https://${u.hostname}:${port}${u.pathname}${u.search}` };
    } catch (e) { return null; }
  };
  const assets = new Set();
  const roots = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('img')) {
      const m = toReplay(el.currentSrc || el.src);
      if (m) { assets.add(m.orig); el.setAttribute('src', m.replay); }
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
      el.removeAttribute('loading');
    }
    for (const el of root.querySelectorAll('picture source')) el.remove();
    for (const el of root.querySelectorAll('video[poster]')) {
      const m = toReplay(el.poster);
      if (m) { assets.add(m.orig); el.setAttribute('poster', m.replay); }
    }
    for (const el of root.querySelectorAll('video')) {
      el.removeAttribute('src');
      el.removeAttribute('autoplay');
      for (const s of el.querySelectorAll('source')) s.remove();
    }
    for (const el of root.querySelectorAll('link[rel~="stylesheet"][href]')) {
      const m = toReplay(el.href);
      if (m) { assets.add(m.orig); el.setAttribute('href', m.replay); }
    }
    for (const el of root.querySelectorAll('iframe[src]')) {
      const m = toReplay(el.src);
      if (m) el.setAttribute('src', m.replay);
    }
    for (const el of root.querySelectorAll('script, noscript, link[rel~="preload"], link[rel~="modulepreload"], link[rel~="prefetch"], link[rel~="preconnect"], link[rel~="dns-prefetch"], base, meta[http-equiv]')) el.remove();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.shadowRoot) { roots.push(n.shadowRoot); visit(n.shadowRoot); }
    }
  };
  visit(document);
  const html = document.documentElement;
  const attrs = [...html.attributes].map(a => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
  const body = html.getHTML({ serializableShadowRoots: true, shadowRoots: roots });
  return { html: `<!DOCTYPE html><html${attrs}>${body}</html>`, assets: [...assets] };
}

async function download(url, referer) {
  const key = assetKey(url);
  const hit = assetIndex[url];
  if (hit && hit.ok && fs.existsSync(path.join(ASSETS, key))) return;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) { assetIndex[url] = { ok: false, status: res.status }; return; }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(ASSETS, key), buf);
    assetIndex[url] = { ok: true, key, type: res.headers.get('content-type') || 'application/octet-stream', bytes: buf.length };
  } catch (e) {
    assetIndex[url] = { ok: false, error: String(e.message || e).slice(0, 120) };
  }
}

async function downloadAll(urls, referer) {
  const queue = [...urls];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) await download(queue.shift(), referer);
  });
  await Promise.all(workers);
  writeJson(ASSET_INDEX, assetIndex);
}

const { REPLAY_PORT } = await import('./lib.mjs');
const browser = await puppeteer.launch({
  executablePath: chromeBin(),
  headless: false,
  defaultViewport: null,
  userDataDir: path.join(CACHE, 'profile'),
  args: extensionArgs(ROOT, ['--window-size=1400,1000'])
});

try {
  for (const recipe of recipes) {
    const page = await browser.newPage();
    await focusPage(browser, page);
    const world = await isolatedWorld(page);
    process.stdout.write(`${recipe.id.padEnd(26)} `);
    try {
      await sleep(1500);
      await page.mouse.move(300, 300);
      await page.goto(recipe.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(4000);
      for (let i = 0; i < recipe.scrolls; i++) {
        await page.mouse.wheel({ deltaY: 900 });
        await sleep(1800);
      }
      // Let verdicts settle: nothing pending for two polls, or 30s.
      const deadline = Date.now() + 30000;
      let quiet = 0;
      while (Date.now() < deadline && quiet < 2) {
        await sleep(1000);
        const pending = await world.evaluate(() => [...document.querySelectorAll('img, video')]
          .filter(el => ScaredyCatState.get(el) === 'pending').length).catch(() => 1);
        quiet = pending === 0 ? quiet + 1 : 0;
      }
      const title = await page.title();
      const media = await world.evaluate(collect);
      const snap = await world.evaluate(snapshot, REPLAY_PORT);
      const dir = path.join(CAPTURES, recipe.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'page.html'), snap.html);
      const finalUrl = page.url();
      await downloadAll(snap.assets, finalUrl);
      writeJson(path.join(dir, 'meta.json'), {
        id: recipe.id, set: recipe.set, url: finalUrl, requestedUrl: recipe.url, title,
        capturedAt: new Date().toISOString(), assets: snap.assets.length, media
      });
      const blocked = media.filter(m => m.state === 'blocked').length;
      console.log(`${String(media.length).padStart(4)} media  ${String(blocked).padStart(3)} blocked  ${snap.assets.length} assets  "${title.slice(0, 50)}"`);
    } catch (e) {
      console.log(`FAILED: ${String(e.message || e).slice(0, 160)}`);
    } finally {
      await page.close().catch(() => {});
      await sleep(2000);
    }
  }
} finally {
  await browser.close();
}
