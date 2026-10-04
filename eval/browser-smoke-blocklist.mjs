/**
 * End-to-end smoke test for "reported images become blocked":
 *   - the popup picker path (START_PICK_MODE + a real click) blurs at once
 *   - the context-menu path (REPORT_MISSED_CONTEXT via the worker) blurs at once
 *   - the same image at another size is caught (canonical key)
 *   - other open tabs pick it up without a reload (BLOCKLIST_UPDATED fan-out)
 *   - the block survives a reload (chrome.storage.local)
 *   - "Allow" undoes it for good, and a fresh report re-blocks
 *
 * Uses neutral alt text so nothing is blocked by the detector itself, and no
 * ML is involved. Verdicts and the card live out of the page's reach, so
 * state is read in the content script's isolated world over CDP
 * (browser-smoke-lib.mjs) and actions go through real input or extension
 * messaging. Requires: npm install --no-save puppeteer-core sharp, SC_CHROME_BIN.
 */

import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { extensionArgs, focusPage, isolatedWorld, elementStates } from './browser-smoke-lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SC_CHROME_BIN;

const sharp = (await import('sharp')).default;
const PIXEL = await sharp({
  create: { width: 300, height: 400, channels: 3, background: { r: 60, g: 120, b: 200 } }
}).png().toBuffer();

// Two size variants of one image (generic resize params collapse to one key)
// plus an unrelated image that must never be touched. All on one row so every
// element is inside the viewport scan margin.
const PAGE = `<!DOCTYPE html><html><head><title>smoke blocklist</title></head><body>
  <h1>Garden photos</h1>
  <img id="small" src="/img/rose.jpg?w=300" alt="A rose in the garden" width="300" height="400">
  <img id="large" src="/img/rose.jpg?w=600" alt="A rose in the garden, large" width="450" height="600">
  <img id="other" src="/img/tulip.jpg" alt="A tulip in the garden" width="300" height="400">
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/?') || req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  } else if (req.url.startsWith('/img/')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PIXEL);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(8903, r));
const URL_A = 'http://localhost:8903/?tab=a';
const URL_B = 'http://localhost:8903/?tab=b';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  defaultViewport: { width: 1300, height: 900 },
  args: extensionArgs(ROOT, ['--window-size=1300,900'])
});

const failures = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

// One isolated-world handle per page (verdicts aren't in the page's DOM).
const worlds = new Map();
const worldOf = async (page) => {
  if (!worlds.has(page)) worlds.set(page, await isolatedWorld(page));
  return worlds.get(page);
};
const state = async (page, id) => {
  const st = (await elementStates(await worldOf(page), [id]))[id];
  return { processed: st.state, blurred: st.blurred };
};
const waitBlurred = async (page, id, want, timeout = 8000) => (await worldOf(page)).waitFor((id, want) => {
  const el = document.getElementById(id);
  const hidden = !!el && ScaredyCatBlocker.wrapperOf(el) !== null && el.style.getPropertyValue('opacity') === '0';
  return hidden === want;
}, { timeout, args: [id, want] });
const settle = async (page) => (await worldOf(page)).waitFor(() =>
  ['small', 'large', 'other'].every(id => ScaredyCatState.has(document.getElementById(id))), { timeout: 10000 });
const pause = (ms) => new Promise(r => setTimeout(r, ms));

try {
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 10000 });
  const worker = await swTarget.worker();
  const tabIdOf = (url) => worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, url);
  const send = (tabId, msg) => worker.evaluate((tabId, msg) => chrome.tabs.sendMessage(tabId, msg), tabId, msg);
  const storage = () => worker.evaluate(async () => ({
    blocked: (await chrome.storage.local.get('blockedItems')).blockedItems || [],
    allowed: (await chrome.storage.local.get('allowedImages')).allowedImages || []
  }));

  console.log('\n-- Baseline: nothing blocked on a plain page --');
  const pageA = await browser.newPage();
  await focusPage(browser, pageA);
  await worldOf(pageA);
  await pageA.goto(URL_A, { waitUntil: 'networkidle0' });
  await settle(pageA);
  for (const id of ['small', 'large', 'other']) {
    const s = await state(pageA, id);
    check(`${id} untouched`, s.processed === 'safe' && !s.blurred, s.processed);
  }

  // A second tab open on the same page, to test fan-out without a reload.
  const pageB = await browser.newPage();
  await worldOf(pageB);
  await pageB.goto(URL_B, { waitUntil: 'networkidle0' });
  await settle(pageB);
  await pageA.bringToFront();
  const tabA = await tabIdOf(URL_A);
  check('found tab A', Number.isInteger(tabA));

  console.log('\n-- Picker path: popup "Report missed horror" + click --');
  await send(tabA, { type: 'START_PICK_MODE' });
  await pause(200);
  await pageA.hover('#small');
  await pageA.click('#small');
  await waitBlurred(pageA, 'small', true);
  check('reported image blurred', (await state(pageA, 'small')).blurred);
  await waitBlurred(pageA, 'large', true);
  check('same image at another size blurred (canonical key)', (await state(pageA, 'large')).blurred);
  check('unrelated image untouched', !(await state(pageA, 'other')).blurred);
  check('processed marker is "blocked"', (await state(pageA, 'small')).processed === 'blocked');
  const worldA = await worldOf(pageA);
  const overlay = await worldA.evaluate(() => !!ScaredyCatUI.__testShadowRoot(
    ScaredyCatBlocker.wrapperOf(document.getElementById('small')))?.querySelector('.scaredycat-overlay'));
  check('overlay card rendered', overlay);
  const consent = await worldA.evaluate(() => [...document.documentElement.children].some(n =>
    ScaredyCatUI.isOwnHost(n) && !!ScaredyCatUI.__testShadowRoot(n)?.querySelector('.scaredycat-consent')));
  check('consent sheet shown after the block (block did not wait on it)', consent);

  console.log('\n-- Fan-out: other open tab --');
  await waitBlurred(pageB, 'small', true);
  await waitBlurred(pageB, 'large', true);
  check('other tab blurred without reload', (await state(pageB, 'small')).blurred && (await state(pageB, 'large')).blurred);
  check('other tab unrelated image untouched', !(await state(pageB, 'other')).blurred);

  console.log('\n-- Persistence: reload --');
  const st1 = await storage();
  check('blocklist persisted as canonical key', st1.blocked.length === 1 && st1.blocked[0] === 'http://localhost:8903/img/rose.jpg', JSON.stringify(st1.blocked));
  await pageA.reload({ waitUntil: 'networkidle0' });
  await waitBlurred(pageA, 'small', true);
  await waitBlurred(pageA, 'large', true);
  await settle(pageA);
  check('blocked after reload', (await state(pageA, 'small')).blurred && (await state(pageA, 'large')).blurred);
  check('unrelated still safe after reload', (await state(pageA, 'other')).processed === 'safe');
  const noMl = (await state(pageA, 'small')).processed;
  check('blocked without classifier (never "pending")', noMl === 'blocked');

  console.log('\n-- Allow undoes the report --');
  const ids = ((await send(tabA, { type: 'GET_PAGE_STATS' }))?.blockedItems || []).map(item => item.id);
  check('popup would list both blocked items', ids.length === 2, `${ids.length}`);
  const allowRes = await send(tabA, { type: 'ALLOW_ITEM', id: ids[0] });
  check('ALLOW_ITEM succeeds', allowRes?.success === true);
  await pause(400);
  const st2 = await storage();
  check('blocklist emptied by Allow', st2.blocked.length === 0, JSON.stringify(st2.blocked));
  check('allowlist has the canonical key', st2.allowed.includes('http://localhost:8903/img/rose.jpg'), JSON.stringify(st2.allowed));
  await pageA.reload({ waitUntil: 'networkidle0' });
  await settle(pageA);
  const s1 = await state(pageA, 'small');
  const s2 = await state(pageA, 'large');
  check('allowed image visible after reload', !s1.blurred && s1.processed === 'allowed', s1.processed);
  check('other size visible after reload too', !s2.blurred, s2.processed);

  console.log('\n-- Context-menu path re-blocks and clears the allowlist entry --');
  const largeSrc = await pageA.evaluate(() => document.getElementById('large').currentSrc);
  await send(tabA, { type: 'REPORT_MISSED_CONTEXT', srcUrl: largeSrc, kind: 'image' });
  await waitBlurred(pageA, 'large', true);
  await waitBlurred(pageA, 'small', true);
  check('re-blocked via context menu (both sizes, over "allowed")', (await state(pageA, 'large')).blurred && (await state(pageA, 'small')).blurred);
  await pause(400);
  const st3 = await storage();
  check('blocklist has the key again', st3.blocked.length === 1, JSON.stringify(st3.blocked));
  check('allowlist entries for that poster (any size) removed', !st3.allowed.includes('http://localhost:8903/img/rose.jpg'), JSON.stringify(st3.allowed));
  await waitBlurred(pageB, 'large', true);
  check('other tab re-blocked too', (await state(pageB, 'large')).blurred);

  console.log(`\nSMOKE-BLOCKLIST ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length}: ${failures.join(', ')})`}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
