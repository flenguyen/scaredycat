/**
 * End-to-end browser smoke test: loads the unpacked extension in real Chrome,
 * opens a test page with horror-titled and neutral images, and checks that
 * the full pipeline (text bands -> offscreen CLIP classifier -> blur overlay)
 * behaves. Requires: npm install --no-save puppeteer-core, system Chrome.
 */

import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SC_CHROME_BIN;

// A real 300x400 solid-red PNG: must pass the min-size check (naturalWidth
// >= 100). A plain color block is also a clean "not horror" input for the
// ML veto test.
const sharp = (await import('sharp')).default;
const PIXEL = await sharp({
  create: { width: 300, height: 400, channels: 3, background: { r: 200, g: 40, b: 40 } }
}).png().toBuffer();

const PAGE = `<!DOCTYPE html><html><head><title>smoke</title></head><body>
  <h1>Test page</h1>
  <!-- DEFINITE band: strong title match, should blur immediately -->
  <img id="definite" src="/img/the-conjuring-poster.jpg" alt="The Conjuring official poster" width="300" height="400">
  <!-- AMBIGUOUS band: keyword-only -> ML veto on a plain red pixel -->
  <img id="keyword" src="/img/creepy-haunted-nightmare.jpg" alt="creepy haunted nightmare scary" width="300" height="400">
  <!-- SAFE: no signal at all -->
  <img id="safe" src="/img/vacation-photo.jpg" alt="beach vacation sunset" width="300" height="400">
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
await new Promise(r => server.listen(8901, r));

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

try {
  const page = await browser.newPage();
  page.on('console', m => {
    const t = m.text();
    if (t.includes('Scaredy Cat')) console.log('  [page]', t);
  });
  await page.goto('http://localhost:8901/', { waitUntil: 'networkidle0' });

  // Give the pipeline time: text pass is instant, ML pass needs model load
  // (first run can take several seconds for the 45MB vision tower).
  const deadline = Date.now() + 60000;
  let state = {};
  while (Date.now() < deadline) {
    state = await page.evaluate(() => ({
      definite: document.getElementById('definite')?.getAttribute('data-scaredycat-processed') ?? null,
      keyword: document.getElementById('keyword')?.getAttribute('data-scaredycat-processed') ?? null,
      safe: document.getElementById('safe')?.getAttribute('data-scaredycat-processed') ?? null,
      definiteBlurred: !!document.getElementById('definite')?.closest('.scaredycat-wrapper'),
      overlays: document.querySelectorAll('.scaredycat-overlay').length
    }));
    if (state.definite && state.keyword && state.keyword !== 'pending' && state.safe) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\nFinal element states:', JSON.stringify(state, null, 2));

  const pass =
    state.definite === 'blocked' && state.definiteBlurred &&
    (state.keyword === 'safe' || state.keyword === 'blocked') &&
    state.safe === 'safe';

  // ML verdict on the keyword image: a plain red pixel should be vetoed (safe).
  console.log(`\ndefinite-band blur: ${state.definite === 'blocked' ? 'PASS' : 'FAIL'}`);
  console.log(`keyword image resolved (${state.keyword}): ${state.keyword !== 'pending' && state.keyword ? 'PASS' : 'FAIL'}`);
  console.log(`  -> ML veto worked: ${state.keyword === 'safe' ? 'YES (vetoed)' : 'no (text-only fallback or blocked)'}`);
  console.log(`safe image untouched: ${state.safe === 'safe' ? 'PASS' : 'FAIL'}`);
  console.log(`\nSMOKE ${pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
