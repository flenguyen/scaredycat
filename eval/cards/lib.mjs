/**
 * Shared pieces for the card eval (eval/cards/): where captures live, the
 * page recipes, the replay port and the browser launch.
 *
 * A capture is a frozen copy of a live page (scripts stripped, open shadow
 * roots kept as declarative shadow DOM, every image downloaded). Replay
 * serves it back under its original hostnames (every host maps to the local
 * server), so the real extension judges the same cards on every run.
 * Captures and assets are local only (.cache, gitignored); labels are in
 * corpus.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(path.dirname(HERE));
export const CACHE = path.join(HERE, '.cache');
export const CAPTURES = path.join(CACHE, 'captures');
export const ASSETS = path.join(CACHE, 'assets');
export const CORPUS = path.join(HERE, 'corpus.json');
// Replay serves every page and asset over TLS on this port; capture rewrites
// asset URLs to https://<original host>:REPLAY_PORT/<original path>. TLS
// because youtube.com and imdb.com are HSTS-preloaded (Chrome upgrades
// http), so replay runs Chrome with --ignore-certificate-errors.
export const REPLAY_PORT = 8911;

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const yt = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q).replace(/%20/g, '+')}`;

/**
 * Page recipes. `set` is horror (the page is mostly horror cards) or
 * negative (hard negatives: things that look or sound close to horror and
 * aren't). Labels are per card either way.
 */
export const RECIPES = [
  // Video platforms
  { id: 'yt-horror', set: 'horror', url: yt('horror'), scrolls: 6 },
  { id: 'yt-horror-short-film', set: 'horror', url: yt('horror short film'), scrolls: 5 },
  { id: 'yt-analog-horror', set: 'horror', url: yt('analog horror'), scrolls: 5 },
  { id: 'yt-creepypasta', set: 'horror', url: yt('creepypasta'), scrolls: 4 },
  { id: 'yt-horror-trailer-2026', set: 'horror', url: yt('horror trailer 2026'), scrolls: 5 },
  { id: 'yt-found-footage', set: 'horror', url: yt('found footage horror'), scrolls: 4 },
  { id: 'yt-halloween-kids', set: 'negative', url: yt('halloween costumes kids'), scrolls: 4 },
  { id: 'yt-true-crime', set: 'negative', url: yt('true crime documentary'), scrolls: 4 },
  { id: 'yt-thriller-trailer', set: 'negative', url: yt('thriller trailer 2026'), scrolls: 4 },
  { id: 'yt-retail-horror-stories', set: 'negative', url: yt('retail horror stories'), scrolls: 4 },
  { id: 'yt-cooking', set: 'negative', url: yt('easy pasta recipe'), scrolls: 3 },
  { id: 'yt-action-trailer', set: 'negative', url: yt('action movie trailer 2026'), scrolls: 4 },
  { id: 'vimeo-horror', set: 'horror', url: 'https://vimeo.com/search?q=horror%20short', scrolls: 3 },
  { id: 'dm-horror', set: 'horror', url: 'https://www.dailymotion.com/search/horror%20trailer/videos', scrolls: 3 },
  { id: 'dm-comedy', set: 'negative', url: 'https://www.dailymotion.com/search/comedy%20trailer/videos', scrolls: 3 },
  // Media sites (IMDb and a second Vimeo search sit behind bot walls for
  // automated visits, Oct 2026, so they aren't here)
  { id: 'rt-in-theaters', set: 'negative', url: 'https://www.rottentomatoes.com/browse/movies_in_theaters/', scrolls: 4 },
  // Pages with trailer embeds, rails and display ads
  { id: 'bd-home', set: 'horror', url: 'https://bloody-disgusting.com/', scrolls: 5 },
  { id: 'ign-trailers', set: 'negative', url: 'https://www.ign.com/videos', scrolls: 4 },
  { id: 'collider-trailers', set: 'negative', url: 'https://collider.com/movie-trailers/', scrolls: 4 }
];

export function chromeBin() {
  const bin = process.env.SC_CHROME_BIN;
  if (!bin) throw new Error('SC_CHROME_BIN not set (Chrome for Testing; branded Chrome ignores --load-extension)');
  return bin;
}

export function assetKey(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 20);
}

/** https://<host>:REPLAY_PORT/<path><query> for an absolute http(s) URL, else null. */
export function replayUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `https://${u.hostname}:${REPLAY_PORT}${u.pathname}${u.search}`;
  } catch (e) {
    return null;
  }
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function listCaptures() {
  if (!fs.existsSync(CAPTURES)) return [];
  return fs.readdirSync(CAPTURES)
    .filter(d => fs.existsSync(path.join(CAPTURES, d, 'meta.json')))
    .map(d => readJson(path.join(CAPTURES, d, 'meta.json')));
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
