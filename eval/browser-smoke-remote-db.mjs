/**
 * Live smoke test for the periodic remote refresh (background/db-updater.js)
 * against the real endpoints:
 *   https://www.scaredycat.app/api/titles/horror-database.json
 *   - first refresh() fetches 200 and stores the merged list + ETag + fetchedAt
 *   - second refresh() sends If-None-Match and gets 304: nothing rewritten
 *   - the stored list is larger than the bundled curated list (auto titles)
 *   https://www.scaredycat.app/api/titles/synopses.json (same refresh() run)
 *   - first fetch 200 stores `synopses` + `synopsesEtag`; second is a 304 that
 *     only bumps `synopsesFetchedAt`; the worker answers GET_SYNOPSIS from it
 *   - SKIPPED with a message while the endpoint answers 404 (not deployed)
 *
 * Needs network access and a deployed scared-cat-web. No pages, no ML.
 *   SC_CHROME_BIN=<chrome-for-testing> npm run smoke:remote-db
 * Requires: npm install --no-save puppeteer-core
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SC_CHROME_BIN;
if (!CHROME) throw new Error('SC_CHROME_BIN not set');

const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/horror-database.json'), 'utf8'));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-first-run',
    '--window-size=800,600'
  ]
});

const failures = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

try {
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
  const worker = await swTarget.worker();

  // Let background.js's install-time seed land first so the version guard
  // compares the remote list against the bundled one, as in production.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const seeded = await worker.evaluate(async () => !!(await chrome.storage.local.get('horrorDatabase')).horrorDatabase);
    if (seeded) break;
    await new Promise(r => setTimeout(r, 200));
  }

  // One evaluate for the whole sequence, so a worker restart between calls
  // can't drop the fetch wrapper.
  const result = await worker.evaluate(async () => {
    // Keep the daily alarm from racing a third refresh in.
    await chrome.alarms.clear(ScaredyCatDBUpdater.ALARM_NAME);
    const remote = ScaredyCatDBUpdater.REMOTE_URL;
    const synRemote = ScaredyCatDBUpdater.SYNOPSES_URL;
    const statuses = [];
    const sentEtags = [];
    const synStatuses = [];
    const synSentEtags = [];
    const realFetch = self.fetch;
    self.fetch = async (input, init) => {
      const res = await realFetch.call(self, input, init);
      const url = typeof input === 'string' ? input : input.url;
      if (url === remote) {
        statuses.push(res.status);
        sentEtags.push(init?.headers?.['If-None-Match'] || null);
      } else if (url === synRemote) {
        synStatuses.push(res.status);
        synSentEtags.push(init?.headers?.['If-None-Match'] || null);
      }
      return res;
    };
    const keys = ['horrorDatabase', 'horrorDatabaseEtag', 'horrorDatabaseFetchedAt'];
    const snapshot = async () => {
      const s = await chrome.storage.local.get(keys);
      return {
        titles: s.horrorDatabase?.titles?.length ?? 0,
        auto: (s.horrorDatabase?.titles || []).filter(t => t.auto === true).length,
        version: s.horrorDatabase?.version ?? null,
        lastUpdated: s.horrorDatabase?.lastUpdated ?? null,
        etag: s.horrorDatabaseEtag ?? null,
        fetchedAt: s.horrorDatabaseFetchedAt ?? null
      };
    };
    const synSnapshot = async () => {
      const s = await chrome.storage.local.get(['synopses', 'synopsesEtag', 'synopsesFetchedAt']);
      return {
        titles: s.synopses?.titles?.length ?? 0,
        sample: s.synopses?.titles?.[0] ?? null,
        etag: s.synopsesEtag ?? null,
        fetchedAt: s.synopsesFetchedAt ?? null
      };
    };
    try {
      // Start from no stored summaries so the first request is a plain 200.
      await chrome.storage.local.remove(['synopses', 'synopsesEtag', 'synopsesFetchedAt']);
      const before = await snapshot();
      await ScaredyCatDBUpdater.refresh();
      const first = await snapshot();
      const synFirst = await synSnapshot();
      await ScaredyCatDBUpdater.refresh();
      const second = await snapshot();
      const synSecond = await synSnapshot();
      // Round-trip one stored entry through the worker's lookup.
      const s = synSecond.sample;
      const answer = s ? await ScaredyCatSynopses.handleRequest(
        { title: s.title, year: s.year, tmdb: s.tmdb, mediaType: s.type }) : null;
      return {
        remote, statuses, sentEtags, before, first, second,
        synRemote, synStatuses, synSentEtags, synFirst, synSecond, sample: s, answer
      };
    } finally {
      self.fetch = realFetch;
    }
  });

  console.log(`remote: ${result.remote}`);
  console.log(`bundled: v${bundled.version} ${bundled.lastUpdated} (${bundled.titles.length} titles)`);
  console.log(`stored after 1st: v${result.first.version} ${result.first.lastUpdated} (${result.first.titles} titles, ${result.first.auto} auto) etag ${result.first.etag}`);

  check('statuses are [200, 304]', JSON.stringify(result.statuses) === '[200,304]', JSON.stringify(result.statuses));
  check('second request sent If-None-Match', !!result.sentEtags[1] && result.sentEtags[1] === result.first.etag, JSON.stringify(result.sentEtags));
  check('horrorDatabaseEtag stored', typeof result.first.etag === 'string' && result.first.etag.length > 0);
  check('horrorDatabaseFetchedAt set by the 200', typeof result.first.fetchedAt === 'number');
  check('horrorDatabaseFetchedAt unchanged by the 304', result.second.fetchedAt === result.first.fetchedAt,
    `${result.first.fetchedAt} -> ${result.second.fetchedAt}`);
  check('stored list larger than bundled', result.first.titles > bundled.titles.length,
    `${result.first.titles} vs ${bundled.titles.length}`);

  console.log(`\nsynopses: ${result.synRemote}`);
  if (result.synStatuses[0] === 404) {
    console.log('  SKIP  synopses endpoint answered 404 (not deployed yet): nothing stored, nothing to check');
    check('404 left no synopses stored', result.synFirst.titles === 0 && result.synSecond.titles === 0);
  } else {
    console.log(`stored after 1st: ${result.synFirst.titles} summaries, etag ${result.synFirst.etag}`);
    check('synopses statuses are [200, 304]', JSON.stringify(result.synStatuses) === '[200,304]',
      JSON.stringify(result.synStatuses));
    check('synopses stored', result.synFirst.titles > 0, `${result.synFirst.titles} titles`);
    check('synopsesEtag stored', typeof result.synFirst.etag === 'string' && result.synFirst.etag.length > 0);
    check('second synopses request sent If-None-Match',
      !!result.synSentEtags[1] && result.synSentEtags[1] === result.synFirst.etag, JSON.stringify(result.synSentEtags));
    check('synopsesFetchedAt bumped by the 304', result.synSecond.fetchedAt > result.synFirst.fetchedAt,
      `${result.synFirst.fetchedAt} -> ${result.synSecond.fetchedAt}`);
    check('payload unchanged by the 304', result.synSecond.titles === result.synFirst.titles);
    check('GET_SYNOPSIS lookup answers a stored entry',
      !!result.answer && result.answer.text === result.sample.text, result.answer?.title ?? 'null');
  }

  console.log(`\nSMOKE remote-db ${failures.length ? 'FAIL' : 'PASS'}`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  await browser.close();
}
