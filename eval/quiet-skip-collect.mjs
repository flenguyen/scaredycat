/**
 * Builds eval/quiet-skip-sample.json, the per-context sample behind
 * eval/quiet-skip-eval.mjs (Phase 5: should titled-quiet elements skip the
 * image classifier?).
 *
 * Sampling frames (TMDB, US region, movies only):
 *   streaming  horror (genre 27) and non-horror movies on subscription
 *              services (Netflix, Prime Video, Hulu, Max, Shudder, Peacock,
 *              Paramount+, Disney+, AMC+): the most popular pages plus
 *              seeded random deeper pages
 *   database   horror and non-horror movies with >= 50 votes, sorted by vote
 *              count (IMDb / Letterboxd listings): top pages plus seeded
 *              random deeper pages
 *   youtube    the official YouTube trailer of a seeded subset of the above,
 *              with its real YouTube title (oEmbed) and 16:9 thumbnail
 *
 * Each item records the text an element would carry, laid out the way
 * detector.js extractTextParts() assembles it for that site's card markup
 * (`context`, scored as-is, and `pageText`, the part that is page text
 * rather than URL path tokens), plus the image score of its picture from the
 * shipped fp16 vision tower run in Node (same prompts and math as
 * offscreen/classifier.js; Node's resize differs from the browser's canvas
 * by a point or two).
 *
 *   node --env-file=<repo>/.env.local eval/quiet-skip-collect.mjs [--seed 5]
 *
 * Needs TMDB_API_KEY. Images are cached in /tmp/scaredycat-fixtures/quiet-skip
 * and never committed. Network: TMDB API + image CDN, YouTube oEmbed,
 * i.ytimg.com thumbnails.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';
import { loadPromptData, scoreEmbedding } from './image-classifier.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'eval/quiet-skip-sample.json');
const CACHE = '/tmp/scaredycat-fixtures/quiet-skip';
fs.mkdirSync(CACHE, { recursive: true });

const KEY = process.env.TMDB_API_KEY;
if (!KEY) throw new Error('TMDB_API_KEY not set (node --env-file=<repo>/.env.local ...)');
const args = process.argv.slice(2);
const SEED = parseInt(args.includes('--seed') ? args[args.indexOf('--seed') + 1] : '5', 10);

// ---- seeded randomness ---------------------------------------------------------
let rngState = SEED >>> 0 || 1;
function rand() {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState >>>= 0;
  return rngState / 4294967296;
}
function pickPages(from, to, n) {
  const set = new Set();
  while (set.size < Math.min(n, to - from + 1)) set.add(from + Math.floor(rand() * (to - from + 1)));
  return [...set].sort((a, b) => a - b);
}
function fakeHash(len, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

// ---- TMDB ------------------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function tmdb(endpoint, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  // v4 read tokens (JWTs) go in a header; v3 keys in the query string.
  const bearer = KEY.startsWith('eyJ');
  if (!bearer) url.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, bearer ? { headers: { authorization: `Bearer ${KEY}` } } : {});
    if (res.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`TMDB ${endpoint} HTTP ${res.status}`);
    await sleep(40);
    return res.json();
  }
  throw new Error(`TMDB ${endpoint}: rate limited`);
}

const HORROR = 27;
const PROVIDERS = '8|9|15|1899|99|386|531|337|526';
const STREAMING_BASE = {
  watch_region: 'US', with_watch_providers: PROVIDERS, with_watch_monetization_types: 'flatrate',
  sort_by: 'popularity.desc', include_adult: false, language: 'en-US'
};
const DATABASE_BASE = { 'vote_count.gte': 50, sort_by: 'vote_count.desc', include_adult: false, language: 'en-US' };

async function discover(base, genreParams, pages) {
  const out = [];
  for (const page of pages) {
    const data = await tmdb('/discover/movie', { ...base, ...genreParams, page });
    for (const r of data.results || []) {
      if (!r.poster_path || !r.title) continue;
      out.push(r);
    }
  }
  return out;
}

async function totalPages(base, genreParams) {
  const data = await tmdb('/discover/movie', { ...base, ...genreParams, page: 1 });
  return Math.min(data.total_pages || 1, 500);
}

// ---- images ----------------------------------------------------------------------
async function download(url, file) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return dest;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'scaredycat-eval/1.0 (github.com/flenguyen/scaredycat)' } });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) return null;
      fs.writeFileSync(dest, buf);
      return dest;
    } catch (e) {
      await sleep(500);
    }
  }
  return null;
}

let processor = null, visionModel = null, promptData = null;
async function loadModel() {
  env.localModelPath = path.join(ROOT, 'models');
  env.allowRemoteModels = false;
  promptData = loadPromptData();
  processor = await AutoProcessor.from_pretrained('Xenova/mobileclip_s0');
  visionModel = await CLIPVisionModelWithProjection.from_pretrained('Xenova/mobileclip_s0', {
    dtype: 'fp16', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
  });
}
async function scoreFile(file) {
  const image = await RawImage.read(file);
  const inputs = await processor(image);
  const { image_embeds } = await visionModel(inputs);
  const vec = Array.from(image_embeds.data);
  const norm = Math.hypot(...vec);
  return scoreEmbedding(vec.map(v => v / norm), promptData.prompts, promptData.logitScale);
}

// ---- element text, laid out like detector.js extractTextParts() ----------------
const year = (r) => (r.release_date || '').slice(0, 4);

/** Netflix-style boxart card: <a href="/watch/ID"><img alt=""><p class=fallback-text>Title</p></a>. */
function streamingText(r) {
  const src = `dnm api v6 ${fakeHash(27)} AAAAB${fakeHash(40)} .jpg`;
  const linkText = r.title;
  const href = ` watch ${80000000 + (r.id % 9999999)}`;
  return { context: [` ${src}`, linkText, href].join(' '), pageText: linkText };
}

/** IMDb list item: poster <img alt="Title (Year)"> outside the overlay link, ipc-title "N. Title". */
function databaseText(r, rank) {
  const alt = year(r) ? `${r.title} (${year(r)})` : r.title;
  const src = ` images M MV5B${fakeHash(40)}@. V1 QL75 UX140 CR0,1,140,207 .jpg`;
  const containerTitle = `${rank}. ${r.title}`;
  return { context: [alt, src, containerTitle].join(' '), pageText: [alt, containerTitle].join(' ') };
}

/** YouTube result: empty-alt thumbnail in <a id=thumbnail> holding the duration, title in #video-title. */
function youtubeText(key, ytTitle) {
  const duration = `${1 + Math.floor(rand() * 3)}:${String(Math.floor(rand() * 60)).padStart(2, '0')}`;
  const src = ` vi ${key} mqdefault.jpg`;
  return { context: [src, duration, ' watch', ytTitle.slice(0, 200)].join(' '), pageText: [duration, ytTitle.slice(0, 200)].join(' ') };
}

// ---- collect -----------------------------------------------------------------------
const items = [];
const posterScores = new Map(); // tmdb id -> score

async function posterScore(r) {
  if (posterScores.has(r.id)) return posterScores.get(r.id);
  const file = await download(`https://image.tmdb.org/t/p/w342${r.poster_path}`, `poster-${r.id}.jpg`);
  const score = file ? +(await scoreFile(file)).toFixed(1) : null;
  posterScores.set(r.id, score);
  return score;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

console.log('loading model...');
await loadModel();

const frames = [];
{
  const hTotal = await totalPages(STREAMING_BASE, { with_genres: HORROR });
  const sTotal = await totalPages(STREAMING_BASE, { without_genres: HORROR });
  frames.push({ context: 'streaming', label: 'horror',
    rows: await discover(STREAMING_BASE, { with_genres: HORROR }, [...pickPages(1, 15, 15), ...pickPages(16, hTotal, 12)]) });
  frames.push({ context: 'streaming', label: 'safe',
    rows: await discover(STREAMING_BASE, { without_genres: HORROR }, [...pickPages(1, 10, 10), ...pickPages(11, sTotal, 6)]) });
  console.log(`streaming frame: horror ${hTotal} pages, safe ${sTotal} pages`);
}
{
  const hTotal = await totalPages(DATABASE_BASE, { with_genres: HORROR });
  const sTotal = await totalPages(DATABASE_BASE, { without_genres: HORROR });
  frames.push({ context: 'database', label: 'horror',
    rows: await discover(DATABASE_BASE, { with_genres: HORROR }, [...pickPages(1, 5, 5), ...pickPages(6, hTotal, 12)]) });
  frames.push({ context: 'database', label: 'safe',
    rows: await discover(DATABASE_BASE, { without_genres: HORROR }, [...pickPages(1, 4, 4), ...pickPages(5, sTotal, 8)]) });
  console.log(`database frame: horror ${hTotal} pages, safe ${sTotal} pages`);
}

for (const frame of frames) {
  const rows = dedupe(frame.rows);
  let rank = 0;
  for (const r of rows) {
    rank++;
    const imageScore = await posterScore(r);
    const text = frame.context === 'streaming' ? streamingText(r) : databaseText(r, rank);
    items.push({
      id: `${frame.context}-${frame.label}-${r.id}`, site: frame.context, label: frame.label,
      title: r.title, year: year(r) || null, tmdb: r.id, ...text, imageScore
    });
  }
  console.log(`${frame.context}/${frame.label}: ${rows.length} items`);
}

// YouTube: official trailers of a seeded subset of every movie seen above.
const pool = { horror: [], safe: [] };
for (const frame of frames) pool[frame.label].push(...frame.rows);
for (const label of ['horror', 'safe']) {
  const rows = dedupe(pool[label]).sort(() => rand() - 0.5).slice(0, label === 'horror' ? 320 : 200);
  let kept = 0;
  for (const r of rows) {
    const videos = await tmdb(`/movie/${r.id}/videos`, { language: 'en-US' });
    const yt = (videos.results || []).filter(v => v.site === 'YouTube' && v.type === 'Trailer');
    const video = yt.find(v => v.official) || yt[0];
    if (!video) continue;
    let ytTitle = null;
    try {
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${video.key}`)}`);
      if (res.ok) ytTitle = (await res.json()).title;
    } catch (e) { /* skip */ }
    await sleep(150);
    if (!ytTitle) continue;
    const file = await download(`https://i.ytimg.com/vi/${video.key}/mqdefault.jpg`, `yt-${video.key}.jpg`);
    if (!file) continue;
    const imageScore = +(await scoreFile(file)).toFixed(1);
    items.push({
      id: `youtube-${label}-${r.id}`, site: 'youtube', label,
      title: r.title, year: year(r) || null, tmdb: r.id, youtube: video.key,
      ...youtubeText(video.key, ytTitle), imageScore
    });
    kept++;
  }
  console.log(`youtube/${label}: ${kept} items`);
}

const summary = {};
for (const it of items) {
  const k = `${it.site}/${it.label}`;
  summary[k] = (summary[k] || 0) + 1;
}
fs.writeFileSync(OUT, JSON.stringify({
  description: 'Generated by eval/quiet-skip-collect.mjs (TMDB movie data; this product uses the TMDB API but is not endorsed or certified by TMDB). context/pageText mirror detector.js extractTextParts() for each site card shape; imageScore is the shipped fp16 vision tower in Node on the TMDB w342 poster (streaming, database) or the YouTube mqdefault thumbnail (youtube). Labels: horror = TMDB genre 27.',
  generated: new Date().toISOString().slice(0, 10),
  seed: SEED,
  counts: summary,
  items
}, null, 0).replace(/\},\{/g, '},\n{'));
console.log('wrote', OUT, summary);
process.exit(0);
