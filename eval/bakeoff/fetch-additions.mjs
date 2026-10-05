// Phase B3 helper: resolves curated family-Halloween films (enwiki thumbnail + Wikidata P1651 trailer) and extra Commons photos,
// downloads them into .cache/img/ with fetch-images' conventions, writes .cache/additions-index.json and qa/additions-candidates.json.
// Same User-Agent, 1-1.5 s Wikimedia delay, 0.3 s YouTube delay, sha256 dedupe against img-index.json, YouTube placeholder detection.
// Does not touch images.json or img-index.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(HERE, '.cache', 'img');
const UA = 'scaredycat-eval/1.0 (https://github.com/flenguyen/scaredycat; model bake-off)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wiki = () => sleep(1000 + Math.random() * 500);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };

const FILMS = ['Hocus Pocus (1993 film)', 'Hocus Pocus 2', 'Casper (film)', 'Casper: A Spirited Beginning', 'Casper Meets Wendy', "Casper's Scare School", 'Hubie Halloween',
  'Halloweentown (film)', 'Halloweentown II: Kalabar\'s Revenge', 'Halloweentown High', 'Return to Halloweentown', "It's the Great Pumpkin, Charlie Brown", "Garfield's Halloween Adventure",
  'Room on the Broom (film)', 'Toy Story of Terror!', 'Toy Story That Time Forgot', 'Scooby-Doo (film)', 'Scooby-Doo 2: Monsters Unleashed', 'Hotel Transylvania', 'Hotel Transylvania 2',
  'Hotel Transylvania 3: Summer Vacation', 'Monsters, Inc.', 'Monsters University', 'The Haunted Mansion (2003 film)', "Wallace & Gromit: The Curse of the Were-Rabbit", 'The Halloween Tree',
  'Twitches (film)', 'The Little Vampire (2000 film)', 'The Adventures of Ichabod and Mr. Toad', "Pooh's Heffalump Halloween Movie", 'Under Wraps (1997 film)', 'Z-O-M-B-I-E-S (film)',
  'Spooky Buddies', 'Halloween Is Grinch Night', "Mickey's House of Villains", 'Scooby-Doo! and the Ghoul School', 'The Worst Witch (1986 film)', 'Mad Monster Party?', "Charlie Brown's Christmas Tales",
  'The Spiderwick Chronicles (film)', 'Igor (2008 film)', 'Gnomeo & Juliet', 'The Addams Family (2019 film)', 'Disney Channel Halloween', 'Halloween Hijinks', 'Mickey\'s Halloween Treat',
  'Winnie the Pooh: Boo to You Too!', 'Scary Godmother: Halloween Spooktakular', "A Garfield Halloween", 'Tom and Jerry: Haunted Mouse', 'Monster Family', 'Goosebumps 2: Haunted Halloween'];
const EXCLUDE_TITLE = /nightmare before|paranorman|monster house|coraline|goosebumps|frankenweenie/i;
const CATS = ['Trick-or-treating', 'Halloween costumes', "Halloween jack-o'-lanterns", 'Halloween decorations', 'Halloween parades', 'Children in Halloween costumes', 'Pumpkin carving', 'Halloween candy', 'Halloween in the United States', 'Halloween parties'];
const BAD_FILE = /zombie|gore|blood|horror|corpse|skull|death|hang|noose|knife|wound|slasher|macabre|nude|bikini|sexy/i;
const HORROR_CAT = /horror|slasher|splatter|giallo|cannibal|zombie|vampire|werewolf|haunted|demon|monster films|creature|ghost films|supernatural films|occult|exorcis|witchcraft films/i;

async function mw(host, params) {
  await wiki();
  const u = `https://${host}/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  for (let a = 0; a < 5; a++) {
    const res = await fetch(u, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    await sleep(Math.min(60000, 3000 * 2 ** a));
  }
  throw new Error('mw failed ' + u);
}
async function download(url) {
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if ([404, 403, 410].includes(res.status)) return { dead: `HTTP ${res.status}` };
      if (res.status === 429 || res.status >= 500) { await sleep(Math.min(60000, 4000 * 2 ** a)); continue; }
      if (!res.ok) return { dead: `HTTP ${res.status}` };
      return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type')?.split(';')[0] };
    } catch { await sleep(Math.min(60000, 4000 * 2 ** a)); }
  }
  return { dead: 'failed' };
}

// ---- films
const cands = [];
for (let i = 0; i < FILMS.length; i += 20) {
  const batch = FILMS.slice(i, i + 20);
  const pages = new Map(); let redirects = [], normalized = [], cont = {};
  for (let g = 0; g < 20; g++) {
    const j = await mw('en.wikipedia.org', { action: 'query', titles: batch.join('|'), redirects: '1', prop: 'categories|pageprops|revisions', rvprop: 'content', rvslots: 'main', rvsection: '0', cllimit: 'max', clshow: '!hidden', ppprop: 'wikibase_item|page_image', ...cont });
    if (!g) { redirects = j.query.redirects || []; normalized = j.query.normalized || []; }
    for (const p of j.query.pages || []) {
      if (p.missing) continue;
      const e = pages.get(p.pageid) || { title: p.title, qid: null, cats: [], pageImage: null, wt: '' };
      if (p.pageprops?.wikibase_item) e.qid = p.pageprops.wikibase_item;
      if (p.pageprops?.page_image) e.pageImage = p.pageprops.page_image;
      if (p.revisions?.[0]?.slots?.main?.content) e.wt = p.revisions[0].slots.main.content;
      for (const c of p.categories || []) e.cats.push(c.title);
      pages.set(p.pageid, e);
    }
    if (j.continue) cont = j.continue; else break;
  }
  for (const e of pages.values()) {
    if (!e.pageImage) { const m = e.wt.match(/\|\s*image\s*=\s*(?:\[\[)?(?:File:|Image:)?\s*([^\n|\]]+\.(?:jpe?g|png))/i); if (m) e.pageImage = m[1].trim(); }
    cands.push(e);
  }
}
const uniqC = [...new Map(cands.filter((e) => e.qid).map((e) => [e.qid, e])).values()].filter((e) => !EXCLUDE_TITLE.test(e.title));
log(`resolved ${uniqC.length} pages of ${FILMS.length} requested`);

// thumbnails
const withImg = uniqC.filter((e) => e.pageImage);
for (let i = 0; i < withImg.length; i += 40) {
  const chunk = withImg.slice(i, i + 40);
  const j = await mw('en.wikipedia.org', { action: 'query', titles: chunk.map((e) => 'File:' + e.pageImage.replace(/_/g, ' ')).join('|'), prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '330' });
  const norm = new Map((j.query.normalized || []).map((n) => [n.from, n.to]));
  const by = new Map((j.query.pages || []).filter((x) => x.imageinfo?.[0]?.thumburl).map((x) => [x.title, x.imageinfo[0]]));
  for (const e of chunk) {
    const t = 'File:' + e.pageImage.replace(/_/g, ' ');
    const ii = by.get(norm.get(t) || t);
    if (ii && /^image\/(jpeg|png)/.test(ii.mime || '')) e.thumb = ii.thumburl;
  }
}
// wikidata: P1651, P136 + labels, year
const wd = new Map();
const genreIds = new Set();
for (let i = 0; i < uniqC.length; i += 40) {
  const ids = uniqC.slice(i, i + 40).map((e) => e.qid);
  const j = await mw('www.wikidata.org', { action: 'wbgetentities', ids: ids.join('|'), props: 'claims', });
  for (const id of ids) {
    const c = j.entities?.[id]?.claims || {};
    const yt = c.P1651?.[0]?.mainsnak?.datavalue?.value || null;
    const genres = (c.P136 || []).map((x) => x.mainsnak?.datavalue?.value?.id).filter(Boolean);
    const date = c.P577?.[0]?.mainsnak?.datavalue?.value?.time || null;
    genres.forEach((g) => genreIds.add(g));
    wd.set(id, { yt, genres, year: date ? +date.slice(1, 5) : null });
  }
}
const glabel = new Map();
const gl = [...genreIds];
for (let i = 0; i < gl.length; i += 50) {
  const j = await mw('www.wikidata.org', { action: 'wbgetentities', ids: gl.slice(i, i + 50).join('|'), props: 'labels', languages: 'en' });
  for (const [k, v] of Object.entries(j.entities || {})) glabel.set(k, v.labels?.en?.value || k);
}
const entries = [];
for (const e of uniqC) {
  const w = wd.get(e.qid);
  const title = e.title.replace(/ \((\d{4} )?film\)$/, '');
  const tags = [...w.genres.map((g) => glabel.get(g)).filter((l) => /horror|ghost|creature|monster|supernatural|zombie|vampire|haunted|slasher/i.test(l)), ...e.cats.filter((c) => HORROR_CAT.test(c)).map((c) => c.replace(/^Category:/, ''))];
  const override = tags.length ? `family-rated Halloween title the product must not blur; tagged: ${[...new Set(tags)].slice(0, 4).join('; ')}` : undefined;
  const base = { label: 'safe', group: 'family-halloween', film: e.qid, title, year: w.year, split: null, ...(override ? { override } : {}) };
  if (e.thumb) entries.push({ id: `wp-${e.qid}`, source: 'wikipedia', url: e.thumb, ...base });
  if (w.yt) entries.push({ id: `yt-${e.qid}`, source: 'youtube', url: `https://i.ytimg.com/vi/${w.yt}/hqdefault.jpg`, ...base });
  log(`${title} (${w.year}) thumb=${!!e.thumb} yt=${w.yt || '-'} ${override ? 'OVERRIDE' : ''}`);
}

// ---- commons
const seenPage = new Set();
for (const cat of CATS) {
  const j = await mw('commons.wikimedia.org', { action: 'query', generator: 'categorymembers', gcmtitle: 'Category:' + cat, gcmtype: 'file', gcmlimit: '40', prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '400' });
  let n = 0;
  for (const p of j.query?.pages || []) {
    const ii = p.imageinfo?.[0];
    if (!ii || !/^image\/(jpeg|png)$/.test(ii.mime || '') || !ii.thumburl || (ii.width || 0) < 300 || BAD_FILE.test(p.title) || seenPage.has(p.pageid)) continue;
    seenPage.add(p.pageid);
    if (n++ >= 6) break;
    entries.push({ id: `cm-${p.pageid}`, label: 'safe', group: 'family-halloween', source: 'commons', url: ii.thumburl, film: null, title: p.title.replace(/^File:/, ''), year: null, split: null });
  }
  log(`commons ${cat}: ${n}`);
}

// ---- download
const main = JSON.parse(fs.readFileSync(path.join(HERE, 'images.json'), 'utf8'));
const mainIdx = JSON.parse(fs.readFileSync(path.join(HERE, '.cache', 'img-index.json'), 'utf8'));
const have = new Set(main.map((m) => m.id));
const shas = new Map(Object.entries(mainIdx).filter(([, x]) => x.ok).map(([id, x]) => [x.sha256, id]));
const out = [], idxPath = path.join(HERE, '.cache', 'additions-index.json'), idx = {};
for (const m of entries) {
  if (have.has(m.id)) { log(`skip ${m.id}: already in images.json`); continue; }
  const r = await download(m.url);
  if (r.dead) { idx[m.id] = { ok: false, reason: `dead: ${r.dead}` }; continue; }
  try {
    const ext = EXT[r.type] || 'jpg';
    const meta = await sharp(r.buf).metadata();
    if (m.source === 'youtube' && meta.width <= 120 && meta.height <= 90) { idx[m.id] = { ok: false, reason: 'youtube-placeholder' }; }
    else if (!meta.width || meta.width < 64 || meta.height < 64) idx[m.id] = { ok: false, reason: 'too-small' };
    else {
      const sha256 = crypto.createHash('sha256').update(r.buf).digest('hex');
      if (shas.has(sha256)) { idx[m.id] = { ok: false, reason: `duplicate of ${shas.get(sha256)}` }; }
      else {
        shas.set(sha256, m.id);
        fs.writeFileSync(path.join(IMG, `${m.id}.${ext}`), r.buf);
        idx[m.id] = { ok: true, ext, sha256, width: meta.width, height: meta.height, bytes: r.buf.length };
        out.push(m);
      }
    }
  } catch (e) { idx[m.id] = { ok: false, reason: `undecodable: ${e.message}` }; }
  await sleep(m.source === 'youtube' ? 300 : 1000 + Math.random() * 500);
}
fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1));
fs.writeFileSync(path.join(HERE, 'qa', 'additions-candidates.json'), JSON.stringify({ entries: out }, null, 1));
log(`downloaded ${out.length}/${entries.length}; failures: ${Object.entries(idx).filter(([, x]) => !x.ok).map(([k, x]) => k + ':' + x.reason).join(', ')}`);
