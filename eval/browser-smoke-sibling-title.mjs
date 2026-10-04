/**
 * Smoke test: trailer cards that borrow their title from a sibling card.
 *
 * IMDb's search dropdown renders each trailer as its own <li> whose link goes
 * to a sub-resource of the title (/title/tt…/videoplayer/vi…/) and whose only
 * text is "0:51 Official Teaser". The title's name sits in the neighbouring
 * <li>. Without borrowing it, every trailer is judged on pixels alone and a
 * known title ends up half-blurred (Backrooms, Sept 2026).
 *
 * The fixture is served under www.imdb.com via --host-resolver-rules so the
 * media-site text path runs exactly as in production. All images are the
 * same neutral gradient, so any blur comes from text alone:
 *   - #horror-video : sibling title "The Backrooms" (definite)  -> blocked
 *   - #safe-video   : sibling title "Paddington in Peru"        -> safe
 *   - #orphan-video : no sibling title card at all              -> safe
 *
 * Element states are read in the content script's isolated world
 * (browser-smoke-lib.mjs). Requires: npm install --no-save puppeteer-core sharp, SC_CHROME_BIN set to
 * Chrome for Testing (branded Chrome >= 137 ignores --load-extension).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { extensionArgs, focusPage, isolatedWorld, elementStates } from './browser-smoke-lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SC_CHROME_BIN;
if (!CHROME) throw new Error('SC_CHROME_BIN not set');
const PORT = 8907;

const sharp = (await import('sharp')).default;
const THUMB = await sharp({
  create: { width: 344, height: 194, channels: 3, background: { r: 120, g: 150, b: 200 } }
}).png().toBuffer();

const videoCard = (id, tt, vi, label) => `
  <li role="option" class="react-autosuggest__suggestion">
    <a class="searchResult searchResult--video" data-testid="search-result--video" href="/title/${tt}/videoplayer/${vi}/?ref_=nv_sr_srsg">
      <div class="ipc-slate" role="group"><div class="ipc-media">
        <img id="${id}" class="ipc-image" alt="${label}" src="/img/${vi}.png" width="344" height="194">
      </div><span>0:51</span></div>
      <div class="searchResult__videoTitle">${label}</div>
    </a>
  </li>`;

const titleCard = (tt, name, meta) => `
  <li role="option" class="react-autosuggest__suggestion">
    <a class="searchResult searchResult--const" data-testid="search-result--const" href="/title/${tt}/?ref_=nv_sr_srsg">
      <div class="searchResult--const__img"><div class="ipc-media">
        <img class="ipc-image" alt="${name}" src="/img/${tt}.png" width="50" height="74">
      </div></div>
      <div><div class="searchResult__constTitle">${name}</div><div class="searchResult__metadata">${meta}</div></div>
    </a>
  </li>`;

const PAGE = `<!DOCTYPE html><html><head><title>IMDb: Ratings, Reviews, and Where to Watch</title></head><body>
<h1>Search</h1>
<div role="listbox" class="react-autosuggest__suggestions-container">
<ul role="listbox" class="react-autosuggest__suggestions-list">
  ${titleCard('tt20863294', 'The Backrooms', '2022 TV Series')}
  ${videoCard('horror-video', 'tt20863294', 'vi1053476889', 'Official Trailer')}
  ${titleCard('tt5822536', 'Paddington in Peru', '2024')}
  ${videoCard('safe-video', 'tt5822536', 'vi2000000001', 'Official Trailer')}
  ${videoCard('orphan-video', 'tt9999999', 'vi3000000001', 'Official Teaser')}
</ul>
</div>
</body></html>`;

// imdb.com is HSTS-preloaded, so Chrome upgrades http://www.imdb.com to
// https. Serve the fixture over TLS with a throwaway self-signed certificate
// (Chrome runs with --ignore-certificate-errors for this test only).
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-smoke-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
  '-subj', '/CN=www.imdb.com'], { stdio: 'ignore' });
const tls = {
  key: fs.readFileSync(path.join(certDir, 'key.pem')),
  cert: fs.readFileSync(path.join(certDir, 'cert.pem'))
};
fs.rmSync(certDir, { recursive: true, force: true });

const server = https.createServer(tls, (req, res) => {
  if (req.url.startsWith('/img/')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(THUMB);
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  }
});
await new Promise(r => server.listen(PORT, r));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: extensionArgs(ROOT, [
    '--host-resolver-rules=MAP www.imdb.com 127.0.0.1',
    '--ignore-certificate-errors',
    '--window-size=1200,900'
  ])
});

try {
  const page = await browser.newPage();
  page.on('console', m => {
    const t = m.text();
    if (t.includes('Scaredy Cat')) console.log('  [page]', t);
  });
  // Let the worker seed the database into storage before the page loads.
  await new Promise(r => setTimeout(r, 2000));
  await focusPage(browser, page);
  const world = await isolatedWorld(page);
  await page.goto(`https://www.imdb.com:${PORT}/`, { waitUntil: 'networkidle0' });

  const IDS = ['horror-video', 'safe-video', 'orphan-video'];
  const deadline = Date.now() + 60000;
  let state = {};
  while (Date.now() < deadline) {
    state = await elementStates(world, IDS);
    if (IDS.every(id => state[id].state && state[id].state !== 'pending')) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\nFinal element states:', JSON.stringify(state, null, 2));

  const checks = [
    ['trailer next to a definite horror title blurs', state['horror-video'].state === 'blocked' && state['horror-video'].blurred],
    ['trailer next to a neutral title stays visible', state['safe-video'].state === 'safe'],
    ['trailer with no title card stays visible', state['orphan-video'].state === 'safe']
  ];
  let pass = true;
  for (const [label, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
    pass = pass && ok;
  }
  console.log(`\nSMOKE ${pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
