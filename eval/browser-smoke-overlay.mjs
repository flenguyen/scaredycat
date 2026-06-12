/**
 * End-to-end smoke test for the overlay card state machine:
 * blocked -> confirm -> synopsis -> back, tier gating (large vs medium),
 * curated vs generic-fallback synopses, and the confirm-once rule.
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
       = DEFINITE, and the 28 Years Later entry has a curated synopsis. -->
  <img id="large" src="/img/teaser-a.jpg" alt="Twenty Eight Years Later official teaser trailer" width="640" height="360">
  <!-- Medium tier: "conjuring last rites" variant scores 90 = DEFINITE,
       entry has NO curated synopsis -> generic fallback line. -->
  <img id="medium" src="/img/teaser-b.jpg" alt="The Conjuring: Last Rites official trailer poster" width="300" height="400">
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

const failures = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

try {
  const page = await browser.newPage();
  await page.goto('http://localhost:8902/', { waitUntil: 'networkidle0' });

  // Both blocks are definite-band: text-only, no model load to wait for.
  await page.waitForFunction(() =>
    document.getElementById('large')?.getAttribute('data-scaredycat-processed') === 'blocked' &&
    document.getElementById('medium')?.getAttribute('data-scaredycat-processed') === 'blocked',
    { timeout: 15000 });

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

  console.log('\n-- Large tier: full card + confirm + curated synopsis --');
  check('blocked state', await overlayState('large') === 'blocked');
  const heading = await q('large', '.scaredycat-heading');
  check('heading visible at large tier', heading?.display === 'block' && heading.text === 'Horror content detected');
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
  check('curated title shown', synTitle?.text.startsWith('28 Years Later'), synTitle?.text);
  check('year + medium noun', synTitle?.text.includes('(2025, poster)'), synTitle?.text);
  const synBody = await q('large', '.scaredycat-syn-body');
  check('curated synopsis text', synBody?.text.includes("Britain isn't."));
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
  await clickIn('large', '.scaredycat-show-btn');
  check('second reveal skips confirm', await overlayState('large') === null || !(await isBlurred('large')));

  console.log('\n-- Medium tier: compact card + "?" + generic fallback --');
  check('blocked state', await overlayState('medium') === 'blocked');
  check('heading hidden at medium tier', (await q('medium', '.scaredycat-heading'))?.display === 'none');
  check('spoil pill hidden at medium tier', (await q('medium', '.scaredycat-spoil-btn'))?.display === 'none');
  const help = await q('medium', '.scaredycat-help-btn');
  check('"?" pill visible at medium tier', help !== null && help.display !== 'none');

  await clickIn('medium', '.scaredycat-help-btn');
  check('? -> synopsis', await overlayState('medium') === 'synopsis');
  check('generic title', (await q('medium', '.scaredycat-syn-title'))?.text === "Here's the gist.");
  const fallbackBody = (await q('medium', '.scaredycat-syn-body'))?.text;
  check('generic fallback present', !!fallbackBody && fallbackBody.length >= 80, fallbackBody?.slice(0, 50) + '…');

  await clickIn('medium', '.scaredycat-btn--primary'); // back
  await clickIn('medium', '.scaredycat-show-btn');
  await page.waitForFunction(() => !document.getElementById('medium').classList.contains('scaredycat-blurred'), { timeout: 3000 });
  check('medium reveals in one click (no confirm)', !(await isBlurred('medium')));

  console.log(`\nSMOKE-OVERLAY ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length}: ${failures.join(', ')})`}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
