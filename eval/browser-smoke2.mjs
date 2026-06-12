// Smoke test 2: the "neutral text" miss case. A real horror poster served
// with a meaningless filename on a page whose title carries horror signal.
// The old extension missed this 100% of the time; the image layer must catch it.
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Fixture cached locally: Wikipedia rate-limits repeated fetches, and a
// failed fetch must fail loudly here, not surface as a bogus test result.
import fs from 'node:fs';
const FIXTURE = '/tmp/scaredycat-fixtures/hereditary.png';
if (!fs.existsSync(FIXTURE)) {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  const posterRes = await fetch('https://upload.wikimedia.org/wikipedia/en/d/d9/Hereditary.png',
    { headers: { 'User-Agent': 'scaredycat-eval/1.0 (github.com/flenguyen/scaredycat)' } });
  if (!posterRes.ok) throw new Error(`fixture fetch failed: HTTP ${posterRes.status}`);
  const buf = Buffer.from(await posterRes.arrayBuffer());
  if (buf.length < 10000) throw new Error(`fixture suspiciously small: ${buf.length}B`);
  fs.writeFileSync(FIXTURE, buf);
}
const POSTER = fs.readFileSync(FIXTURE);
console.log(`poster fixture: ${(POSTER.length / 1e3).toFixed(0)}KB`);

const PAGE = `<!DOCTYPE html><html><head><title>Best horror movies of 2026 ranked</title></head><body>
<h1>Our favorites this year</h1>
<img id="poster" src="/img/movie-still-04521.png" alt="promotional image" width="300" height="445">
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, {'content-type':'text/html'}); res.end(PAGE); }
  else if (req.url.startsWith('/img/')) { res.writeHead(200, {'content-type':'image/png'}); res.end(POSTER); }
  else res.writeHead(404).end();
});
await new Promise(r => server.listen(8903, r));

const browser = await puppeteer.launch({
  executablePath: process.env.SC_CHROME_BIN, headless: false,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run']
});
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:8903/', { waitUntil: 'networkidle0' });
  const deadline = Date.now() + 60000;
  let state = {};
  while (Date.now() < deadline) {
    state = await page.evaluate(() => ({
      poster: document.getElementById('poster')?.getAttribute('data-scaredycat-processed') ?? null,
      blurred: !!document.getElementById('poster')?.closest('.scaredycat-wrapper')
    }));
    if (state.poster && state.poster !== 'pending') break;
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('state:', JSON.stringify(state));
  console.log(`neutral-text horror caught by image layer: ${state.poster === 'blocked' && state.blurred ? 'PASS' : 'FAIL'}`);
  process.exitCode = state.poster === 'blocked' ? 0 : 1;
} finally { await browser.close(); server.close(); }
