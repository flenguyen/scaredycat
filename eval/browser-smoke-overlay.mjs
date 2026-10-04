/**
 * End-to-end smoke test for the overlay card state machine:
 * blocked -> confirm -> synopsis -> back, tier gating (large vs medium),
 * summary vs no summary (no spoil affordance at all), and the confirm-once
 * rule. Summaries come from the worker (background/synopses.js); the test
 * seeds chrome.storage.local.synopses with a stub instead of hitting the
 * website, so it is deterministic and offline.
 *
 * Uses only DEFINITE-band title matches so it never waits on the ML model.
 * Requires: npm install --no-save puppeteer-core sharp, SC_CHROME_BIN.
 */

import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SC_CHROME_BIN;

const sharp = (await import('sharp')).default;
const PIXEL = await sharp({
  create: { width: 300, height: 400, channels: 3, background: { r: 200, g: 40, b: 40 } }
}).png().toBuffer();

const PAGE = `<!DOCTYPE html><html><head><title>smoke overlay</title></head><body>
  <h1>Test page</h1>
  <!-- Large tier (>=360x220): "twenty eight years later" variant scores 98
       = DEFINITE, and the stub has a summary for 28 Years Later (2025). -->
  <img id="large" src="/img/teaser-a.jpg" alt="Twenty Eight Years Later official teaser trailer" width="640" height="360">
  <!-- Medium tier: "the conjuring" is a curated definite fast-track title and
       the stub has a summary for it (2013) -> compact card with the "?" pill.
       (No year in the alt: "the conjuring 2013" also contains the "the
       conjuring 2" variant, which outscores it and isn't word-bounded, so the
       fast-track neighbor check would demote it to the classifier.) -->
  <img id="medium" src="/img/teaser-b.jpg" alt="The Conjuring official trailer poster" width="300" height="400">
  <!-- No summary: "conjuring last rites" scores 90 = DEFINITE but the stub has
       no summary for it -> blur + Show only, no spoil affordance. -->
  <img id="nosyn" src="/img/teaser-c.jpg" alt="The Conjuring: Last Rites official trailer poster" width="300" height="400">
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  } else if (req.url.startsWith('/img/')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PIXEL);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(8902, r));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-first-run',
    '--window-size=1200,900'
  ]
});

// Stand-in for https://www.scaredycat.app/api/titles/synopses.json.
const SYNOPSES = {
  version: 1,
  updatedAt: '2026-10-04T00:00:00Z',
  titles: [
    { title: '28 Years Later', year: 2025, names: ['28 Years Later'], tmdb: 1100988, type: 'movie',
      slug: '28-years-later-2025', text: "The fast ones still run. You're safe. Britain isn't." },
    { title: 'The Conjuring', year: 2013, names: ['The Conjuring', 'Conjuring'], tmdb: 138843, type: 'movie',
      slug: 'the-conjuring-2013', text: 'A family moves into a farmhouse where the previous owner never left.' }
  ]
};

const failures = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

try {
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
  const worker = await swTarget.worker();
  await worker.evaluate(async (synopses) => {
    // No refresh mid-test: the stub must stay what the worker answers from.
    await chrome.alarms.clear(ScaredyCatDBUpdater.ALARM_NAME);
    await chrome.storage.local.set({ synopses });
  }, SYNOPSES);

  const page = await browser.newPage();
  await page.goto('http://localhost:8902/', { waitUntil: 'networkidle0' });

  // Both blocks are definite-band: text-only, no model load to wait for.
  await page.waitForFunction(() =>
    document.getElementById('large')?.getAttribute('data-scaredycat-processed') === 'blocked' &&
    document.getElementById('medium')?.getAttribute('data-scaredycat-processed') === 'blocked' &&
    document.getElementById('nosyn')?.getAttribute('data-scaredycat-processed') === 'blocked',
    { timeout: 15000 });
  // Summaries arrive from the worker after the block; the spoil pills are
  // added in place. Give the no-summary card's (null) answer time to land too.
  await page.waitForFunction(() =>
    ['large', 'medium'].every(id =>
      document.getElementById(id).closest('.scaredycat-wrapper')?.querySelector('.scaredycat-spoil-btn')),
    { timeout: 5000 });
  await new Promise(r => setTimeout(r, 500));

  // Helpers run inside the page against a specific element's wrapper.
  // Revealed overlays linger ~300ms while fading out, so all queries skip
  // .scaredycat-fade-out nodes.
  const q = (id, sel) => page.evaluate((id, sel) => {
    const wrapper = document.getElementById(id).closest('.scaredycat-wrapper');
    if (!wrapper) return null;
    const live = [...wrapper.querySelectorAll(sel)].filter(el => !el.closest('.scaredycat-fade-out'));
    const el = live[live.length - 1];
    return el ? { text: el.textContent, display: getComputedStyle(el).display } : null;
  }, id, sel);
  const clickIn = (id, sel) => page.evaluate((id, sel) => {
    const wrapper = document.getElementById(id).closest('.scaredycat-wrapper');
    const live = [...wrapper.querySelectorAll(sel)].filter(el => !el.closest('.scaredycat-fade-out'));
    live[live.length - 1].click();
  }, id, sel);
  const overlayState = (id) => page.evaluate((id) =>
    document.getElementById(id).closest('.scaredycat-wrapper')
      ?.querySelector('.scaredycat-overlay:not(.scaredycat-fade-out)')?.dataset.state ?? null, id);
  const isBlurred = (id) => page.evaluate((id) =>
    document.getElementById(id).classList.contains('scaredycat-blurred'), id);

  console.log('\n-- Large tier: full card + confirm + summary --');
  check('blocked state', await overlayState('large') === 'blocked');
  const heading = await q('large', '.scaredycat-heading');
  check('heading visible at large tier', heading?.display === 'block' && heading.text === 'Something spooky was here.');
  const spoil = await q('large', '.scaredycat-spoil-btn');
  check('spoil pill visible at large tier', !!spoil && spoil.display !== 'none', spoil?.display);
  check('"?" pill hidden at large tier', (await q('large', '.scaredycat-help-btn'))?.display === 'none');

  await clickIn('large', '.scaredycat-show-btn');
  check('Show anyway -> confirm (not reveal)', await overlayState('large') === 'confirm');
  check('still blurred during confirm', await isBlurred('large'));
  check('confirm copy', (await q('large', '.scaredycat-heading'))?.text === 'You sure? Be honest.');

  await clickIn('large', '.scaredycat-btn--primary'); // "No. Tell me what happens."
  check('confirm -> synopsis', await overlayState('large') === 'synopsis');
  const synTitle = await q('large', '.scaredycat-syn-title');
  check('summary title shown', synTitle?.text.startsWith('28 Years Later'), synTitle?.text);
  check('year + medium noun', synTitle?.text.includes('(2025, poster)'), synTitle?.text);
  const synBody = await q('large', '.scaredycat-syn-body');
  check('summary text', synBody?.text.includes("Britain isn't."));
  check('Spoiled safely badge', (await q('large', '.scaredycat-badge'))?.text.includes('Spoiled safely'));

  await clickIn('large', '.scaredycat-btn--primary'); // "← Back to the blur"
  check('back to blocked', await overlayState('large') === 'blocked');
  check('still blurred after back', await isBlurred('large'));

  await clickIn('large', '.scaredycat-show-btn');
  await clickIn('large', '.scaredycat-btn--secondary'); // "Yes. Show it."
  await page.waitForFunction(() => !document.getElementById('large').classList.contains('scaredycat-blurred'), { timeout: 3000 });
  check('Yes. Show it. reveals', !(await isBlurred('large')));
  check('hide-again appears', await q('large', '.scaredycat-hide-again-btn') !== null);

  await clickIn('large', '.scaredycat-hide-again-btn');
  check('hide again re-blocks', await overlayState('large') === 'blocked' && await isBlurred('large'));
  check('re-hidden card keeps the summary pill', (await q('large', '.scaredycat-spoil-btn')) !== null);
  await clickIn('large', '.scaredycat-show-btn');
  check('second reveal skips confirm', await overlayState('large') === null || !(await isBlurred('large')));

  console.log('\n-- Medium tier: compact card + "?" + summary --');
  check('blocked state', await overlayState('medium') === 'blocked');
  check('heading hidden at medium tier', (await q('medium', '.scaredycat-heading'))?.display === 'none');
  check('spoil pill hidden at medium tier', (await q('medium', '.scaredycat-spoil-btn'))?.display === 'none');
  const help = await q('medium', '.scaredycat-help-btn');
  check('"?" pill visible at medium tier', help !== null && help.display !== 'none');

  await clickIn('medium', '.scaredycat-help-btn');
  check('? -> synopsis', await overlayState('medium') === 'synopsis');
  const medTitle = await q('medium', '.scaredycat-syn-title');
  check('website title shown', medTitle?.text.startsWith('The Conjuring'), medTitle?.text);
  check('year from the worker', medTitle?.text.includes('(2013, poster)'), medTitle?.text);
  const medBody = (await q('medium', '.scaredycat-syn-body'))?.text;
  check('summary text', !!medBody && medBody.includes('farmhouse'), medBody?.slice(0, 50) + '…');

  await clickIn('medium', '.scaredycat-btn--primary'); // back
  await clickIn('medium', '.scaredycat-show-btn');
  await page.waitForFunction(() => !document.getElementById('medium').classList.contains('scaredycat-blurred'), { timeout: 3000 });
  check('medium reveals in one click (no confirm)', !(await isBlurred('medium')));

  console.log('\n-- No summary: blur + Show only --');
  check('blocked state', await overlayState('nosyn') === 'blocked');
  check('no spoil pill rendered', await q('nosyn', '.scaredycat-spoil-btn') === null);
  check('no "?" pill rendered', await q('nosyn', '.scaredycat-help-btn') === null);
  check('Show anyway present', await q('nosyn', '.scaredycat-show-btn') !== null);
  await clickIn('nosyn', '.scaredycat-show-btn');
  await page.waitForFunction(() => !document.getElementById('nosyn').classList.contains('scaredycat-blurred'), { timeout: 3000 });
  check('reveals in one click', !(await isBlurred('nosyn')));

  console.log(`\nSMOKE-OVERLAY ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length}: ${failures.join(', ')})`}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
