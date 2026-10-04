/**
 * Hostile-page smoke test: a page that knows Scaredy Cat is installed and
 * tries to drive it. Every check here is something the page must FAIL to do.
 *
 * Content-script half (always enforced):
 *   - reveal a block, grant feedback consent, or undo a user's report with
 *     .click(), dispatched mouse events or synthetic KeyboardEvents
 *   - drive the element picker (and so the blocklist) with synthetic input
 *   - get a real click counted on the consent sheet in its first 600ms, or
 *     while the page has restyled it (opacity 0)
 *   - read <html data-sc-perf>, sc:* performance marks, a verdict attribute,
 *     the extension id or any chrome-extension:// URL from the DOM
 *   - reach the card through wrapper.shadowRoot
 *   - fetch chrome-extension://<id>/data/horror-database.json (or the CSS
 *     and fonts): no web_accessible_resources any more
 *   - make the extension load a URL it planted in data-scaredycat-original-src
 *     (on reveal of a blocked iframe, and on "disable everywhere")
 * Positive controls: real clicks still reveal, open and accept consent.
 *
 * Service-worker half (needs the merged build; pass --pre-merge to report
 * these without failing):
 *   - CLASSIFY_IMAGE for http://127.0.0.1 / http://192.168.1.1 never reaches
 *     the network (a local server sees no extension request)
 *   - 5,000 unique ambiguous <img> tags hit the per-tab classify limit
 *     (throttled responses) and the worker stays responsive
 *
 * Requires: npm install --no-save puppeteer-core sharp, SC_CHROME_BIN.
 */

import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { extensionArgs, focusPage, isolatedWorld, withHelpers, realClick, elementStates } from './browser-smoke-lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SC_CHROME_BIN;
if (!CHROME) throw new Error('SC_CHROME_BIN not set');
const PRE_MERGE = process.argv.includes('--pre-merge');
const HOST = 'hostile.scaredycat-smoke.net';
const PORT = 8960;
const VICTIM_PORT = 8961;

const sharp = (await import('sharp')).default;
const PIXEL = await sharp({
  create: { width: 300, height: 400, channels: 3, background: { r: 90, g: 140, b: 90 } }
}).png().toBuffer();

const REPORTED_SRC = `http://${HOST}:${PORT}/img/reported.png`;

const PAGE = `<!DOCTYPE html><html><head><title>hostile</title>
<style>body{margin:16px;font-family:sans-serif} .row{display:flex;gap:16px;flex-wrap:wrap}</style></head><body>
<h1>Totally normal page</h1>
<div class="row">
  <img id="definite" src="/img/definite.png" alt="The Conjuring: Last Rites official trailer poster" width="300" height="400">
  <img id="reported" src="/img/reported.png" alt="A garden path" width="300" height="400">
  <iframe id="trailer" title="The Conjuring: Last Rites official trailer" src="/frame/real" width="400" height="225"></iframe>
  <iframe id="planted" title="Garden tour" src="/frame/garden" data-scaredycat-original-src="/frame/evil-planted" width="400" height="225"></iframe>
  <img id="neutral" src="/img/neutral.png" alt="A tulip" width="300" height="400">
  <img id="ssrf" src="http://127.0.0.1:${VICTIM_PORT}/ssrf/page.png" alt="creepy haunted nightmare scary" width="300" height="400">
</div>
</body></html>`;

const FLOOD = `<!DOCTYPE html><html><head><title>flood</title></head><body>
<div style="position:relative;width:200px;height:200px">
${Array.from({ length: 5000 }, (_, i) =>
  `<img src="/flood/${i}.png" alt="creepy haunted nightmare scary" width="150" height="150" style="position:absolute;left:0;top:0">`).join('\n')}
</div></body></html>`;

const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  } else if (req.url === '/flood') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FLOOD);
  } else if (req.url.startsWith('/img/') || req.url.startsWith('/flood/')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PIXEL);
  } else if (req.url.startsWith('/frame/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<p>${req.url}</p>`);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(PORT, r));

// Stands in for a LAN/loopback service. The page's own <img> load arrives
// with Sec-Fetch-Dest: image; anything else is the extension fetching.
const victimHits = [];
const victim = http.createServer((req, res) => {
  victimHits.push({ url: req.url, dest: req.headers['sec-fetch-dest'] || '', origin: req.headers.origin || '' });
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(PIXEL);
});
await new Promise(r => victim.listen(VICTIM_PORT, '127.0.0.1', r));
const extensionVictimHits = () => victimHits.filter(h => h.dest !== 'image');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  defaultViewport: { width: 1400, height: 1000 },
  // The consent control below grants consent; feedback hosts don't resolve
  // in this browser, so no report can reach a real endpoint even if the
  // worker restarts and loses the in-worker stub.
  args: extensionArgs(ROOT, [
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1, ` +
      'MAP *.scaredycat.app ~NOTFOUND, MAP scaredycat.app ~NOTFOUND',
    '--window-size=1400,1100'
  ])
});

const failures = [];
const pending = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}
// Service-worker checks: enforced unless --pre-merge.
function checkSw(name, ok, detail = '') {
  if (ok || !PRE_MERGE) return check(name, ok, detail);
  console.log(`  WAIT  ${name}  (needs the merged service worker${detail ? `; ${detail}` : ''})`);
  pending.push(name);
}
const pause = (ms) => new Promise(r => setTimeout(r, ms));

try {
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  const worker = await swTarget.worker();
  const consentGranted = () => worker.evaluate(async () =>
    (await chrome.storage.sync.get('settings')).settings?.feedbackConsent === true);
  const blockedItems = () => worker.evaluate(async () =>
    (await chrome.storage.local.get('blockedItems')).blockedItems || []);

  // Seed one user report (canonical key = the plain URL here), consent off,
  // and keep feedback on the device: a granted consent in the positive
  // control below must not send anything anywhere.
  await worker.evaluate(async (reported) => {
    await chrome.alarms.clear(ScaredyCatDBUpdater.ALARM_NAME);
    await chrome.storage.local.set({ blockedItems: [ScaredyCatImageKey.canonicalImageKey(reported)] });
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...(settings || {}), feedbackConsent: false } });
    if (typeof ScaredyCatFeedback !== 'undefined') ScaredyCatFeedback.submit = async () => ({ success: true });
    const realFetch = self.fetch;
    self.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (/\/api\/feedback/.test(url)) return Promise.resolve(new Response('{}', { status: 200 }));
      return realFetch.call(self, input, init);
    };
  }, REPORTED_SRC);
  const seeded = await blockedItems();

  const page = await browser.newPage();
  await focusPage(browser, page);
  const world = await isolatedWorld(page);
  await page.goto(`http://${HOST}:${PORT}/`, { waitUntil: 'networkidle0' });
  await world.waitFor(() =>
    ['definite', 'reported', 'trailer'].every(id => ScaredyCatState.get(document.getElementById(id)) === 'blocked') &&
    ['planted', 'neutral'].every(id => ScaredyCatState.has(document.getElementById(id))), { timeout: 20000 });
  await world.waitFor(() => ScaredyCatUI.__testShadowRoot(
    ScaredyCatBlocker.wrapperOf(document.getElementById('definite')))?.querySelector('.scaredycat-styled'));
  await pause(500);

  const hidden = async (id) => (await elementStates(world, [id]))[id].blurred;
  const overlayState = (id) => withHelpers(world, `(id) => live(id, '.scaredycat-overlay')?.dataset.state ?? null`, id);

  console.log('\n-- Fingerprinting: what the page can read --');
  const leaks = await page.evaluate((extId) => {
    const html = document.documentElement.outerHTML;
    const wrapper = document.getElementById('definite').parentElement;
    return {
      scPerf: document.documentElement.hasAttribute('data-sc-perf'),
      marks: performance.getEntriesByType('mark').filter(m => m.name.startsWith('sc:')).length,
      extUrl: html.includes('chrome-extension://'),
      extId: html.includes(extId),
      stateAttrs: document.querySelectorAll('[data-scaredycat-processed]').length,
      // Any data-scaredycat-* attribute we wrote (the page's own planted
      // one on #planted doesn't count).
      anyScAttr: [...document.querySelectorAll('*')].some(el =>
        [...el.attributes].some(a => a.name.startsWith('data-scaredycat') && el.id !== 'planted')),
      shadowRoot: wrapper.shadowRoot,
      wrapperClass: wrapper.className,
      docSheets: document.adoptedStyleSheets.length,
      linkedSheets: [...document.styleSheets].filter(s => s.href && s.href.startsWith('chrome-extension://')).length,
      blockedText: wrapper.textContent.includes('spooky')
    };
  }, extId);
  check('no <html data-sc-perf>', !leaks.scPerf);
  check('no sc:* performance marks', leaks.marks === 0, `${leaks.marks}`);
  check('no chrome-extension:// URL in the DOM', !leaks.extUrl);
  check('extension id nowhere in the DOM', !leaks.extId);
  check('no verdict or state attributes on a non-media site', leaks.stateAttrs === 0 && !leaks.anyScAttr,
    `${leaks.stateAttrs}`);
  check('card shadow root closed (wrapper.shadowRoot === null)', leaks.shadowRoot === null);
  check('card copy not readable through textContent', !leaks.blockedText);
  check('no stylesheet injected into the page', leaks.docSheets === 0 && leaks.linkedSheets === 0);

  const fetches = await page.evaluate(async (extId) => {
    const out = {};
    for (const p of ['data/horror-database.json', 'styles/blur-overlay.css', 'fonts/Inter.woff2']) {
      try {
        const r = await fetch(`chrome-extension://${extId}/${p}`);
        out[p] = `HTTP ${r.status}`;
      } catch (e) {
        out[p] = 'blocked';
      }
    }
    return out;
  }, extId);
  for (const [p, r] of Object.entries(fetches)) check(`page can't fetch ${p}`, r === 'blocked', r);

  console.log('\n-- Synthetic input against the blur card --');
  // Everything a page can do to a wrapper it can see: click it, dispatch
  // pointer and mouse events at the card's buttons' coordinates, press keys.
  const attackCard = (id) => page.evaluate((id) => {
    const wrapper = document.getElementById(id).parentElement;
    const r = wrapper.getBoundingClientRect();
    const points = [];
    for (let fx = 0.1; fx < 1; fx += 0.2) for (let fy = 0.1; fy < 1; fy += 0.2) {
      points.push([r.left + r.width * fx, r.top + r.height * fy]);
    }
    wrapper.click();
    document.getElementById(id).click();
    for (const [x, y] of points) {
      const target = document.elementFromPoint(x, y);
      if (!target) continue;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        target.dispatchEvent(new Ctor(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      }
      target.click?.();
    }
    for (const key of ['Enter', ' ', 'Escape', 'Tab']) {
      for (const t of [wrapper, document, document.body]) {
        t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
        t.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, composed: true }));
      }
    }
    return points.length;
  }, id);
  await attackCard('definite');
  await pause(500);
  check('synthetic clicks/keys did not reveal the block', await hidden('definite') && await overlayState('definite') === 'blocked');

  // The user reveals their own report; the "This isn't horror" pill (which
  // would also undo the report) is now on screen. The page attacks it.
  await realClick(page, world, `() => live('reported', '.scaredycat-show-btn')`);
  await world.waitFor(() => document.getElementById('reported').style.getPropertyValue('opacity') !== '0', { timeout: 3000 });
  check('real click reveals (control)', !(await hidden('reported')));
  await attackCard('reported');
  await pause(800);
  const afterAttack = await blockedItems();
  check('synthetic clicks could not undo the user report', JSON.stringify(afterAttack) === JSON.stringify(seeded),
    JSON.stringify(afterAttack));
  check('no consent sheet opened by synthetic clicks', !(await world.evaluate(() =>
    [...document.documentElement.children].some(n => ScaredyCatUI.isOwnHost(n) &&
      ScaredyCatUI.__testShadowRoot(n)?.querySelector('.scaredycat-consent')))));

  console.log('\n-- Planted data-scaredycat-original-src --');
  await page.evaluate(() => document.getElementById('trailer').setAttribute('data-scaredycat-original-src', '/frame/evil-trailer'));
  check('blocked iframe blanked', (await page.evaluate(() => document.getElementById('trailer').src)) === 'about:blank');
  await realClick(page, world, `() => live('trailer', '.scaredycat-show-btn')`);
  await pause(800);
  const trailerSrc = await page.evaluate(() => document.getElementById('trailer').src);
  check('reveal restores the real src, not the planted one', trailerSrc.endsWith('/frame/real'), trailerSrc);
  check('planted URL never loaded on reveal', !hits.includes('/frame/evil-trailer'));

  console.log('\n-- Consent sheet --');
  const consentHost = () => world.evaluate(() => {
    const host = [...document.documentElement.children].find(n => ScaredyCatUI.isOwnHost(n) &&
      ScaredyCatUI.__testShadowRoot(n)?.querySelector('.scaredycat-consent'));
    if (!host) return null;
    const btn = (sel) => {
      const r = ScaredyCatUI.__testShadowRoot(host).querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    return { accept: btn('.scaredycat-consent-btn--primary'), decline: btn('.scaredycat-consent-btn--ghost'), t: performance.now() };
  });
  const waitConsent = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const h = await consentHost();
      if (h) return h;
      await pause(20);
    }
    return null;
  };

  // Reveal #definite for real, then "This isn't horror" opens the sheet.
  await realClick(page, world, `() => live('definite', '.scaredycat-show-btn')`);
  await pause(500);
  await realClick(page, world, `() => live('definite', '.scaredycat-fp-link')`);
  let sheet = await waitConsent();
  check('real click on "This isn\'t horror" opens the sheet (control)', !!sheet);
  if (sheet) {
    await page.mouse.click(sheet.accept.x, sheet.accept.y);
    const elapsed = await world.evaluate((t) => performance.now() - t, sheet.t);
    if (elapsed < 550) {
      check('a real click in the first 600ms is ignored', !(await consentGranted()) && !!(await consentHost()),
        `${Math.round(elapsed)}ms after found`);
    } else {
      console.log(`  SKIP  first-600ms click (harness too slow: ${Math.round(elapsed)}ms)`);
    }

    // Page-side attacks on the open sheet.
    await page.evaluate(() => {
      const host = document.documentElement.lastElementChild;
      host.click();
      const r = host.getBoundingClientRect();
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      t?.click();
      for (const key of ['Enter', ' ', 'Tab', 'Escape']) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
        host.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
      }
    });
    await pause(700);
    check('synthetic clicks/keys did not grant consent', !(await consentGranted()));
    check('synthetic Escape did not touch the sheet', !!(await consentHost()));

    // The page hides the sheet (opacity 0) and lures a real click onto it.
    await page.evaluate(() => { document.documentElement.lastElementChild.style.opacity = '0'; });
    sheet = await consentHost();
    await page.mouse.click(sheet.accept.x, sheet.accept.y);
    await pause(400);
    check('real click on a page-hidden sheet is ignored', !(await consentGranted()));

    // Decline with a real click (works even on the tampered sheet), reopen,
    // wait out the arming delay, accept for real: consent is granted.
    await page.mouse.click(sheet.decline.x, sheet.decline.y);
    await pause(400);
    check('real click on "Not now" closes the sheet (control)', !(await consentHost()));
    await pause(3500); // the "nothing was sent" toast
    await realClick(page, world, `() => live('definite', '.scaredycat-fp-link')`);
    sheet = await waitConsent();
    await pause(700);
    if (sheet) await page.mouse.click(sheet.accept.x, sheet.accept.y);
    await pause(600);
    check('real click after 600ms on an untouched sheet grants consent (control)', await consentGranted());
  }

  console.log('\n-- Element picker --');
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `http://${HOST}:${PORT}/`);
  await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'START_PICK_MODE' }), tabId);
  await pause(300);
  const beforePick = await blockedItems();
  await page.evaluate(() => {
    const el = document.getElementById('neutral');
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, composed: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20, button: 0 };
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    el.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await pause(500);
  check('synthetic click/Escape did not drive the picker', await world.evaluate(() => ScaredyCatPicker.isActive()));
  check('synthetic click did not add a blocklist entry', JSON.stringify(await blockedItems()) === JSON.stringify(beforePick));
  check('neutral image not blocked', !(await hidden('neutral')));
  await page.keyboard.press('Escape');
  await pause(300);
  check('real Escape cancels the picker (control)', !(await world.evaluate(() => ScaredyCatPicker.isActive())));

  console.log('\n-- Classifier fetches to loopback / private addresses --');
  await pause(3000); // let the #ssrf element's classify round trip finish
  const direct = await world.evaluate(async (port) => {
    const ask = (url) => chrome.runtime.sendMessage({ type: 'CLASSIFY_IMAGE', url }).catch(e => ({ error: String(e) }));
    const started = performance.now();
    const results = await Promise.all([
      ask(`http://127.0.0.1:${port}/ssrf/direct.png`),
      ask(`http://localhost:${port}/ssrf/direct-localhost.png`),
      ask('http://192.168.1.1/ssrf/router.png')
    ]);
    return { results, ms: Math.round(performance.now() - started) };
  }, VICTIM_PORT);
  await pause(1000);
  const extHits = extensionVictimHits();
  checkSw('no extension request reached the loopback server', extHits.length === 0,
    extHits.map(h => `${h.url} dest=${h.dest}`).join(', '));
  checkSw('CLASSIFY_IMAGE refused loopback/private URLs', direct.results.every(r => r?.success !== true),
    JSON.stringify(direct.results));

  console.log('\n-- Disable everywhere restores only what we blanked --');
  await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, {
    type: 'SETTINGS_UPDATED',
    settings: { enabled: false, sensitivity: 'medium', disabledSites: [], allowedTitles: [], feedbackConsent: true }
  }), tabId);
  await pause(800);
  check('planted iframe src never loaded', !hits.includes('/frame/evil-planted'));
  check('blocks removed on disable', !(await elementStates(world, ['definite'])).definite.blurred);

  console.log('\n-- Classify flood: 5,000 unique ambiguous images --');
  if (PRE_MERGE) {
    console.log('  WAIT  classify flood (needs the merged service worker\'s rate limit; skipped)');
    pending.push('classify flood');
  } else {
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...(settings || {}), enabled: true } });
    });
    const flood = await browser.newPage();
    const floodWorld = await isolatedWorld(flood);
    await flood.goto(`http://${HOST}:${PORT}/flood`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pause(10000);
    const started = Date.now();
    await worker.evaluate(() => chrome.storage.local.get('stats'));
    const workerMs = Date.now() - started;
    const stats = await floodWorld.evaluate(() => ScaredyCatMLBridge.getStats());
    check('worker answers within 2s during the flood', workerMs < 2000, `${workerMs}ms`);
    check('per-tab classify limit throttles the flood', stats.throttled > 0, JSON.stringify(stats));
    await flood.close();
  }

  const summary = failures.length === 0 ? 'PASS' : `FAIL (${failures.length}: ${failures.join(', ')})`;
  console.log(`\nSMOKE-HOSTILE ${summary}${pending.length ? ` [${pending.length} waiting on the merged worker: ${pending.join(', ')}]` : ''}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  await browser.close();
  server.close();
  victim.close();
}
