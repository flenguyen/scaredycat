/**
 * Smoke test: video, short and ad cards on any site.
 *
 * Two fixture pages, served over TLS under mapped hostnames:
 *   www.youtube.com/results?search_query=cats  (a neutral search, no page signal)
 *     #yt-short-horror : Shorts lockup titled "Hotel Visitor - Horror Short"   -> blocked
 *     #yt-short-safe   : Shorts lockup titled "Cute puppy compilation"         -> safe
 *     #yt-ad           : in-feed ad, headline "Other Mommy (2026)" (definite)  -> blocked
 *   news.scaredycat-smoke.net/trailers  (the general web)
 *     #card-horror     : trailer tile (duration badge) "DISGUISE | Short Horror Film" -> blocked
 *     #card-safe       : trailer tile "Easy pasta at home"                     -> safe
 *     #article         : article card "The best horror movies of 2025" (not a video card) -> safe
 *     #embed           : YouTube embed iframe titled "Hotel Visitor - Horror Short"     -> blocked
 *     ad iframe (same site, ads.scaredycat-smoke.net): creative alt "Other Mommy - In theatres"
 *                        -> blocked inside the frame, counted in the top frame's badge
 *
 * Every thumbnail URL 404s, so no card gets an image score: the blocks come
 * from text alone (a card whose title files it under horror blurs at once,
 * like a definite title) and the safe cards show that the rest stays
 * text-gated. Requires: npm install --no-save puppeteer-core, SC_CHROME_BIN.
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
const PORT = 8913;

const short = (id, vid, title) => `
  <div class="ytGridShelfViewModelGridShelfItem">
    <ytm-shorts-lockup-view-model-v2 class="shortsLockupViewModelHost"><ytm-shorts-lockup-view-model class="shortsLockupViewModelHost">
      <a href="/shorts/${vid}" class="shortsLockupViewModelHostEndpoint reel-item-endpoint" aria-hidden="true">
        <div class="shortsLockupViewModelHostThumbnailParentContainer"><yt-thumbnail-view-model class="ytThumbnailViewModelHost">
          <div class="ytThumbnailViewModelImage"><img id="${id}" alt="" width="207" height="310" style="display:block;width:207px;height:310px;background:#456" src="https://i.ytimg.com:${PORT}/vi/${vid}/oar2.jpg"></div>
        </yt-thumbnail-view-model></div>
      </a>
      <div class="shortsLockupViewModelHostOutsideMetadata"><div>
        <h3 class="shortsLockupViewModelHostMetadataTitle"><a href="/shorts/${vid}" title="${title}"><span role="text">${title}</span></a></h3>
        <div class="shortsLockupViewModelHostMetadataSubhead"><span role="text">1.1M views</span></div>
      </div></div>
    </ytm-shorts-lockup-view-model></ytm-shorts-lockup-view-model-v2>
  </div>`;

const YT_PAGE = `<!DOCTYPE html><html><head><title>cats - YouTube</title></head><body>
<grid-shelf-view-model style="display:flex;gap:12px">
  ${short('yt-short-horror', 'AAAAAAAAAA1', 'Hotel Visitor - Horror Short')}
  ${short('yt-short-safe', 'AAAAAAAAAA2', 'Cute puppy compilation')}
</grid-shelf-view-model>
<ytd-ad-slot-renderer><div id="fulfilled-layout"><ytd-in-feed-ad-layout-renderer><div id="rendering-content">
  <compact-landscape-no-button-layout-view-model><div><div><ad-image-view-model><div>
    <img id="yt-ad" alt="" width="500" height="281" style="display:block;width:500px;height:281px;background:#654" src="https://tpc.googlesyndication.com:${PORT}/simgad/123">
  </div></ad-image-view-model></div></div>
  <feed-ad-metadata-view-model>
    <span class="ytwFeedAdMetadataViewModelHostTextsStyleCompactHeadline">Other Mommy (2026) - In Theatres This October</span>
    <span class="ytwFeedAdMetadataViewModelHostTextsStyleCompactDescription">From the producers of Obsession and Backrooms</span>
    <span>Sponsored</span>
  </feed-ad-metadata-view-model>
  </compact-landscape-no-button-layout-view-model>
</div></ytd-in-feed-ad-layout-renderer></div></ytd-ad-slot-renderer>
</body></html>`;

const tile = (id, title, href) => `
  <li class="tile" style="width:320px">
    <a href="${href}"><img id="${id}" alt="" width="320" height="180" style="display:block;background:#345" src="/thumbs/${id}.jpg"></a>
    <span class="duration">4:12</span>
    <h3><a href="${href}">${title}</a></h3>
    <p class="byline">Some Channel</p>
  </li>`;

const NEWS_PAGE = `<!DOCTYPE html><html><head><title>Trailers this week - Smoke News</title></head><body>
<header><h1>Trailers this week</h1></header>
<ul style="display:flex;gap:16px;list-style:none">
  ${tile('card-horror', 'DISGUISE | Short Horror Film', '/video/disguise')}
  ${tile('card-safe', 'Easy pasta at home', '/video/pasta')}
</ul>
<article style="width:600px">
  <img id="article" alt="" width="600" height="300" style="display:block;background:#543" src="/thumbs/article.jpg">
  <h2>The best horror movies of 2025</h2>
  <p>Our critics ranked the year. ${'Plenty of words about films and festivals. '.repeat(4)}</p>
</article>
<iframe id="embed" title="Hotel Visitor - Horror Short" width="560" height="315" src="https://www.youtube.com/embed/AAAAAAAAAA3"></iframe>
<iframe id="adframe" width="300" height="250" src="https://ads.scaredycat-smoke.net:${PORT}/creative"></iframe>
</body></html>`;

const AD_CREATIVE = `<!DOCTYPE html><html><head><title>ad</title></head><body style="margin:0">
<a href="https://example.com/"><img id="creative" alt="Other Mommy - In theatres October 9" width="300" height="250" style="display:block;background:#222" src="/thumbs/creative.jpg"></a>
</body></html>`;

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-smoke-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
  '-subj', '/CN=scaredycat-smoke'], { stdio: 'ignore' });
const tls = { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) };
fs.rmSync(certDir, { recursive: true, force: true });

const server = https.createServer(tls, (req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  const html = (body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
  if (host === 'www.youtube.com' && req.url.startsWith('/results')) return html(YT_PAGE);
  if (host === 'news.scaredycat-smoke.net' && req.url.startsWith('/trailers')) return html(NEWS_PAGE);
  if (host === 'ads.scaredycat-smoke.net' && req.url.startsWith('/creative')) return html(AD_CREATIVE);
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(PORT, r));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: extensionArgs(ROOT, [
    '--host-resolver-rules=MAP www.youtube.com 127.0.0.1, MAP i.ytimg.com 127.0.0.1, MAP tpc.googlesyndication.com 127.0.0.1, MAP *.scaredycat-smoke.net 127.0.0.1',
    '--ignore-certificate-errors',
    '--window-size=1300,1000'
  ])
});

async function settle(world, ids) {
  const deadline = Date.now() + 45000;
  let state = {};
  while (Date.now() < deadline) {
    state = await elementStates(world, ids);
    if (ids.every(id => state[id].state && state[id].state !== 'pending')) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  return state;
}

const checks = [];
try {
  await new Promise(r => setTimeout(r, 2000)); // let the worker seed the database
  const page = await browser.newPage();
  await focusPage(browser, page);

  const yt = await isolatedWorld(page);
  await page.goto(`https://www.youtube.com:${PORT}/results?search_query=cats`, { waitUntil: 'networkidle0' });
  const ytIds = ['yt-short-horror', 'yt-short-safe', 'yt-ad'];
  const ytState = await settle(yt, ytIds);
  console.log('YouTube page:', JSON.stringify(ytState));
  checks.push(['Short titled "Horror Short" blurs (strong self-label)', ytState['yt-short-horror'].state === 'blocked']);
  checks.push(['Short with a neutral title stays visible', ytState['yt-short-safe'].state === 'safe']);
  checks.push(['in-feed ad naming a definite horror title blurs', ytState['yt-ad'].state === 'blocked']);

  const news = await isolatedWorld(page);
  await page.goto(`https://news.scaredycat-smoke.net:${PORT}/trailers`, { waitUntil: 'networkidle0' });
  const newsIds = ['card-horror', 'card-safe', 'article', 'embed'];
  const newsState = await settle(news, newsIds);
  console.log('News page:', JSON.stringify(newsState));
  // The page must not count as a horror page: there, blocking one card
  // stops and covers every embed on the page, which would hide whether the
  // embed was judged on its own title.
  const horrorPage = await news.evaluate(() => ScaredyCatDetector.hasPageHorrorSignal());
  checks.push(['the trailer page is not a horror page (embed judged on its own)', horrorPage === false]);
  const kinds = await news.evaluate((ids) => Object.fromEntries(ids.map(id => [id, ScaredyCatDetector.analyzeElement(document.getElementById(id)).cardKind])), newsIds);
  console.log('Card kinds:', JSON.stringify(kinds));
  checks.push(['generic trailer tile is read as a video card', kinds['card-horror'] === 'video']);
  checks.push(['trailer tile titled "Short Horror Film" blurs on the general web', newsState['card-horror'].state === 'blocked']);
  checks.push(['trailer tile with a neutral title stays visible', newsState['card-safe'].state === 'safe']);
  checks.push(['an article picture stays text-gated (one keyword is not enough)', newsState.article.state === 'safe']);
  checks.push(['embedded YouTube player titled "Horror Short" blurs', newsState.embed.state === 'blocked']);

  const ad = await isolatedWorld(page, { frame: 'ads.scaredycat-smoke.net' });
  const adState = await settle(ad, ['creative']);
  console.log('Ad frame:', JSON.stringify(adState));
  checks.push(['ad creative inside an iframe blurs (content script runs in frames)', adState.creative.state === 'blocked']);
  let frameCount = 0;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && frameCount < 1) {
    frameCount = await news.evaluate(() => ScaredyCatBlocker.getFrameCount());
    if (frameCount < 1) await new Promise(r => setTimeout(r, 500));
  }
  checks.push(['the frame\'s block reaches the top frame\'s badge count', frameCount === 1]);
} finally {
  await browser.close();
  server.close();
}

let pass = true;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  pass = pass && ok;
}
console.log(`\nSMOKE ${pass ? 'PASS' : 'FAIL'}`);
process.exitCode = pass ? 0 : 1;
