// Builds eval/bakeoff/images.json (the labelled image manifest) for the model bake-off.
// Sources: Wikidata SPARQL, enwiki (pageimages/categories), Wikimedia Commons, YouTube thumbnails
// for Wikidata P1651 trailer ids. No TMDB. API responses are cached in .cache/api/ so reruns are cheap.
// Usage: node eval/bakeoff/build-manifest.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, '.cache', 'api');
fs.mkdirSync(CACHE, { recursive: true });
const UA = 'scaredycat-eval/1.0 (https://github.com/flenguyen/scaredycat; model bake-off)';
const SEED = 1337;

// ---------- utilities ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wikiDelay = () => sleep(1000 + Math.random() * 500);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function cachedJson(key, doFetch) {
  const f = path.join(CACHE, sha1(key) + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const data = await doFetch();
  fs.writeFileSync(f, JSON.stringify(data));
  return data;
}

async function httpJson(url, { method = 'GET', body, headers = {}, delay = true } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (delay) await wikiDelay();
    try {
      const res = await fetch(url, { method, body, headers: { 'User-Agent': UA, ...headers } });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(Math.min(60000, 3000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const j = await res.json();
      if (j?.error?.code === 'maxlag') {
        lastErr = new Error('maxlag');
        await sleep(5000 * (attempt + 1));
        continue;
      }
      return j;
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(60000, 3000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

function mwUrl(host, params) {
  const u = new URL(`https://${host}/w/api.php`);
  const p = { format: 'json', formatversion: '2', maxlag: '5', ...params };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return u.toString();
}
const mw = (host, params) => cachedJson(`mw|${host}|${JSON.stringify(params)}`, () => httpJson(mwUrl(host, params)));

async function sparql(query) {
  return cachedJson('sparql|' + query, async () => {
    const j = await httpJson('https://query.wikidata.org/sparql', {
      method: 'POST',
      body: new URLSearchParams({ query }),
      headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
      delay: false,
    });
    await sleep(1500);
    return j.results.bindings;
  });
}
const qidOf = (uri) => uri.split('/').pop();
const val = (b, k) => (b[k] ? b[k].value : null);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashNum = (s) => parseInt(sha1(`${SEED}|${s}`).slice(0, 12), 16);

// ---------- genres ----------
const G = {
  horror: 'Q200092', slasher: 'Q853630', zombie: 'Q3072049', monster: 'Q1342372', splatter: 'Q909586',
  bodyHorror: 'Q102260466', ghost: 'Q31888058', supernatural: 'Q43911809', psych: 'Q109629396',
  gothic: 'Q114413232', folk: 'Q104902646', thriller: 'Q2484376', psychThriller: 'Q109733304',
  neoNoir: 'Q2421031', noir: 'Q185867', action: 'Q188473', actionAdv: 'Q78461348', fantasy: 'Q157394',
  superhero: 'Q1535153', adventure: 'Q319221', crime: 'Q959790', heist: 'Q496523', scifi: 'Q471839',
  war: 'Q369747', drama: 'Q130232', family: 'Q1361932', children: 'Q2143665', animated: 'Q202866',
  halloween: 'Q116918819', comedyHorror: 'Q108466999',
};

async function horrorGenreSet() {
  const rows = await sparql('SELECT ?g WHERE { ?g wdt:P279* wd:Q200092 }');
  const s = new Set(rows.map((r) => qidOf(r.g.value)));
  for (const q of [G.horror, G.slasher, G.zombie, G.splatter, G.bodyHorror, G.ghost, G.supernatural, G.psych,
    G.gothic, G.folk, G.comedyHorror, 'Q224700', 'Q3641550']) s.add(q);
  return s;
}

// ---------- Wikidata pools ----------
async function filmPool({ genres, minSitelinks = 8, limit = 300, requireYt = false, yearMin, yearMax, anyType = false }) {
  const filters = [];
  if (yearMin) filters.push(`?year >= ${yearMin}`);
  if (yearMax) filters.push(`?year <= ${yearMax}`);
  const q = `SELECT ?f ?title (MIN(?y) AS ?year) (SAMPLE(?yt) AS ?ytid) (MAX(?n) AS ?sl) WHERE {
  VALUES ?G { ${genres.map((g) => 'wd:' + g).join(' ')} }
  ?f wdt:P136 ?G; wikibase:sitelinks ?n.
  ${anyType ? '' : '?f wdt:P31/wdt:P279* wd:Q11424.'}
  ?a schema:about ?f; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?title.
  ${requireYt ? '?f wdt:P1651 ?yt.' : 'OPTIONAL { ?f wdt:P1651 ?yt }'}
  OPTIONAL { ?f wdt:P577 ?d. BIND(YEAR(?d) AS ?y) }
  FILTER(?n >= ${minSitelinks})
} GROUP BY ?f ?title ${filters.length ? `HAVING(${filters.map((f) => f.replace('?year', 'MIN(?y)')).join(' && ')})` : ''}
ORDER BY DESC(?sl) LIMIT ${limit}`;
  const rows = await sparql(q);
  return rows.map((b) => ({
    qid: qidOf(b.f.value), title: val(b, 'title'), year: b.year ? +b.year.value : null,
    yt: val(b, 'ytid'), sl: +val(b, 'sl'),
  }));
}

async function gamePool(limit, minSitelinks) {
  const q = `SELECT ?f ?title (MIN(?y) AS ?year) (MAX(?n) AS ?sl) WHERE {
  ?f wdt:P31 wd:Q7889; wikibase:sitelinks ?n.
  ?a schema:about ?f; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?title.
  OPTIONAL { ?f wdt:P577 ?d. BIND(YEAR(?d) AS ?y) }
  FILTER(?n >= ${minSitelinks})
} GROUP BY ?f ?title ORDER BY DESC(?sl) LIMIT ${limit}`;
  const rows = await sparql(q);
  return rows.map((b) => ({ qid: qidOf(b.f.value), title: val(b, 'title'), year: b.year ? +b.year.value : null, yt: null, sl: +val(b, 'sl') }));
}

// genres, trailer id, year, isFilm for arbitrary QIDs
async function enrich(qids) {
  const out = new Map();
  const list = [...new Set(qids)];
  for (let i = 0; i < list.length; i += 120) {
    const chunk = list.slice(i, i + 120);
    const q = `SELECT ?f (GROUP_CONCAT(DISTINCT STRAFTER(STR(?g),"entity/");separator=",") AS ?genres) (SAMPLE(?yt) AS ?ytid) (MIN(?y) AS ?year) (SAMPLE(?film) AS ?isFilm) WHERE {
  VALUES ?f { ${chunk.map((x) => 'wd:' + x).join(' ')} }
  OPTIONAL { ?f wdt:P136 ?g }
  OPTIONAL { ?f wdt:P1651 ?yt }
  OPTIONAL { ?f wdt:P577 ?d. BIND(YEAR(?d) AS ?y) }
  OPTIONAL { ?f wdt:P31/wdt:P279* wd:Q11424. BIND(1 AS ?film) }
} GROUP BY ?f`;
    for (const b of await sparql(q)) {
      out.set(qidOf(b.f.value), {
        genres: val(b, 'genres') ? val(b, 'genres').split(',') : [], yt: val(b, 'ytid'),
        year: b.year ? +b.year.value : null, isFilm: !!b.isFilm,
      });
    }
  }
  return out;
}

// ---------- enwiki page info ----------
// returns Map(requestedTitle -> {title, qid, thumb, cats[]}) for the titles that exist (redirects followed)
async function pageInfo(titles) {
  const res = new Map();
  const uniq = [...new Set(titles)];
  for (let i = 0; i < uniq.length; i += 40) {
    const batch = uniq.slice(i, i + 40);
    const pages = new Map();
    let redirects = [], normalized = [];
    let cont = {};
    for (let guard = 0; guard < 30; guard++) {
      const j = await mw('en.wikipedia.org', {
        action: 'query', titles: batch.join('|'), redirects: '1', prop: 'categories|pageprops', cllimit: 'max', clshow: '!hidden',
        ppprop: 'wikibase_item|page_image', ...cont,
      });
      const q = j.query || {};
      if (!guard) { redirects = q.redirects || []; normalized = q.normalized || []; }
      for (const p of q.pages || []) {
        if (p.missing) continue;
        const e = pages.get(p.pageid) || { title: p.title, qid: null, thumb: null, cats: [] };
        if (p.pageprops?.page_image && !e.pageImage) e.pageImage = p.pageprops.page_image;
        if (p.pageprops?.wikibase_item) e.qid = p.pageprops.wikibase_item;
        for (const c of p.categories || []) e.cats.push(c.title);
        pages.set(p.pageid, e);
      }
      if (j.continue) cont = j.continue; else break;
    }
    // non-free posters are excluded from the pageimages prop, so resolve the page_image file to a thumbnail via imageinfo
    const withImg = [...pages.values()].filter((e) => e.pageImage);
    if (withImg.length) {
      const names = withImg.map((e) => 'File:' + e.pageImage.replace(/_/g, ' '));
      const j = await mw('en.wikipedia.org', { action: 'query', titles: names.join('|'), prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '330' });
      const thumbs = new Map((j.query?.pages || []).filter((x) => x.imageinfo?.[0]?.thumburl).map((x) => [x.title, x.imageinfo[0]]));
      for (const e of withImg) {
        const ii = thumbs.get('File:' + e.pageImage.replace(/_/g, ' '));
        if (ii && /^image\/(jpeg|png)/.test(ii.mime || '')) e.thumb = ii.thumburl;
      }
    }
    const byTitle = new Map([...pages.values()].map((e) => [e.title, e]));
    for (const t of batch) {
      let cur = t;
      const n = normalized.find((x) => x.from === cur); if (n) cur = n.to;
      const r = redirects.find((x) => x.from === cur); if (r) cur = r.to;
      if (byTitle.has(cur)) res.set(t, byTitle.get(cur));
    }
    if ((i / 40) % 10 === 0) log(`pageInfo ${Math.min(i + 40, uniq.length)}/${uniq.length}`);
  }
  return res;
}

const HORROR_CAT = /horror|slasher|splatter|giallo|cannibal|zombie|vampire|werewolf|haunted|demon|monster films|creature|ghost films|supernatural films|occult|exorcis|survival horror|witchcraft films/i;

// ---------- Commons ----------
async function commonsFiles(cat, { want = 80, subcats = 6, rngSeed = cat } = {}) {
  const rng = mulberry32(hashNum(rngSeed) % 2 ** 31);
  const files = [];
  const listFiles = async (c) => {
    let cont = {};
    for (let g = 0; g < 4; g++) {
      const j = await mw('commons.wikimedia.org', {
        action: 'query', generator: 'categorymembers', gcmtitle: 'Category:' + c, gcmtype: 'file', gcmlimit: '200',
        prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '400', ...cont,
      });
      for (const p of j.query?.pages || []) {
        const ii = p.imageinfo?.[0];
        if (!ii || !/^image\/(jpeg|png)$|svg/.test(ii.mime || '') || !ii.thumburl) continue;
        files.push({ pageid: p.pageid, file: p.title, url: ii.thumburl, w: ii.width, h: ii.height });
      }
      if (j.continue) cont = j.continue; else break;
    }
  };
  await listFiles(cat);
  if (files.length < want * 3) {
    const j = await mw('commons.wikimedia.org', {
      action: 'query', list: 'categorymembers', cmtitle: 'Category:' + cat, cmtype: 'subcat', cmlimit: '100',
    });
    const subs = (j.query?.categorymembers || []).map((m) => m.title.replace(/^Category:/, ''));
    const pick = subs.map((s) => [rng(), s]).sort((a, b) => a[0] - b[0]).slice(0, subcats).map((x) => x[1]);
    for (const s of pick) { await listFiles(s); if (files.length >= want * 4) break; }
  }
  const seen = new Set();
  const uniq = files.filter((f) => !seen.has(f.pageid) && seen.add(f.pageid));
  return uniq.filter((f) => !/\.(tif|tiff|pdf|gif|webm|ogv)$/i.test(f.file) && (f.w || 400) >= 300)
    .map((f) => [rng(), f]).sort((a, b) => a[0] - b[0]).slice(0, want).map((x) => x[1]);
}

// ---------- curated lists ----------
const MINIMALIST = `The Witch|2015;It Follows|2014;Midsommar|2019;The Lighthouse|2019;Saint Maud|2019;Men|2022;X|2022;Pearl|2022;Talk to Me|2022;Smile|2022;Longlegs|2024;The Babadook|2014;Relic|2020;The Night House|2020;Barbarian|2022;Get Out|2017;Us|2019;Nope|2022;It Comes at Night|2017;Lamb|2021;The Blackcoat's Daughter|2015;Under the Skin|2013;Starry Eyes|2014;Possessor|2020;Speak No Evil|2022;Late Night with the Devil|2023;I Saw the TV Glow|2024;A Quiet Place|2018;Hush|2016;The Invitation|2015;A Dark Song|2016;The Autopsy of Jane Doe|2016;Raw|2016;Green Room|2015;The Void|2016;Annihilation|2018;Mother!|2017;Suspiria|2018;The Killing of a Sacred Deer|2017;Climax|2018;Revenge|2017;Vivarium|2019;The Vigil|2019;His House|2020;Censor|2021;Titane|2021;Last Night in Soho|2021;Antlers|2021;The Menu|2022;Nanny|2022;Run|2020;Host|2020;Hellbender|2021;Master|2022;Bones and All|2022;Crimes of the Future|2022;Infinity Pool|2023;Skinamarink|2022;Enys Men|2022;Evil Dead Rise|2023;Heretic|2024;The Substance|2024;Nosferatu|2024;Oddity|2024;Immaculate|2024;Strange Darling|2023;When Evil Lurks|2023;Bird Box|2018;The Ritual|2017;Gerald's Game|2017;1922|2017;Apostle|2018;Hagazussa|2017;November|2017;The Wailing|2016;Goodnight Mommy|2014;The Eyes of My Mother|2016;The Love Witch|2016;Housebound|2014;The Hallow|2015;Under the Shadow|2016;The Girl with All the Gifts|2016;Pyewacket|2017;Mandy|2018;Ready or Not|2019;The Platform|2019;The Wretched|2019;Color Out of Space|2019;Gretel & Hansel|2020;The Empty Man|2020;Underwater|2020;Fresh|2022;Resurrection|2022;Watcher|2022;Piggy|2022;The First Omen|2024;Abigail|2024;Lights Out|2016;Don't Breathe|2016;Split|2016;Oculus|2013;The Conjuring|2013;Annabelle|2014;The Gallows|2015;The Bay|2012;Cam|2018;Anything for Jackson|2020;The Djinn|2021;Sissy|2022;Cobweb|2023;Hounds of Love|2016;Kill List|2011;A Girl Walks Home Alone at Night|2014;The Endless|2017;Spring|2014;The Mortuary Collection|2019;Gaia|2021;Terrifier|2016;Sinister|2012;Black Mirror?|0`.split(';').map((s) => s.split('|')).filter((x) => +x[1] > 0).map(([t, y]) => ({ title: t, year: +y }));

const CALIBRATION = [{ title: 'Hereditary', year: 2018 }, { title: 'The Nun', year: 2018 }, { title: 'Insidious', year: 2010 }];

const FAMILY_HALLOWEEN = ['Hocus Pocus (1993 film)', 'Casper (film)', "It's the Great Pumpkin, Charlie Brown", 'Hubie Halloween', 'Halloweentown (film)',
  'Monster House (film)', 'ParaNorman', 'Frankenweenie (2012 film)', 'The Nightmare Before Christmas', 'Goosebumps (film)', 'Hotel Transylvania',
  'Hotel Transylvania 2', 'Spooky Buddies', 'The Halloween Tree', 'Coraline (film)', 'Scooby-Doo (film)', 'Hocus Pocus 2', "Casper's Haunted Christmas",
  'Halloween Is Grinch Night', 'Wallace & Gromit: The Curse of the Were-Rabbit', 'The Addams Family (1991 film)', 'Addams Family Values', 'Twitches (film)',
  'The Witches (2020 film)', 'The Little Vampire (2000 film)', 'Casper Meets Wendy', 'Halloweentown II: Kalabar\'s Revenge', "Mickey's House of Villains",
  "Scooby-Doo! Abracadabra-Doo", 'Scooby-Doo on Zombie Island', 'Goosebumps 2: Haunted Halloween', 'The Witches (1990 film)', 'Wendell & Wild', 'Monster Family',
  'Hotel Transylvania 3: Summer Vacation', 'The Haunted Mansion (2003 film)', 'Haunted Mansion (2023 film)', "Tim Burton's Corpse Bride", 'Corpse Bride',
  'Spirited Away', "Kiki's Delivery Service", 'The Worst Witch (1986 film)', 'Room on the Broom (film)', "The Cat in the Hat (film)", 'Casper: A Spirited Beginning',
  'Pete\'s Dragon (2016 film)', 'The Spiderwick Chronicles (film)', 'The House with a Clock in Its Walls (film)', "A Series of Unfortunate Events (film)", 'Lemony Snicket\'s A Series of Unfortunate Events (film)',
  'Mad Monster Party?', 'Mr. Peabody & Sherman', 'Maleficent (film)', 'Halloween (1978 film)x'].filter((t) => !t.endsWith('x'));

const NAMED_SAFE = [
  ['action-fantasy', ['Mortal Kombat (1995 film)', 'White House Down', 'Mortal Kombat Annihilation', 'Mortal Kombat (2021 film)', 'Olympus Has Fallen', 'Die Hard', 'Clash of the Titans (2010 film)', 'Wrath of the Titans']],
  ['dark-thriller', ['Cape Fear (1991 film)', 'Cape Fear (1962 film)', 'Se7en', 'The Silence of the Lambs (film)x', 'Zodiac (2007 film)', 'Gone Girl (film)', 'Prisoners (2013 film)', 'Shutter Island (film)', 'Nightcrawler (film)', 'No Country for Old Men (film)']],
  ['crime', ['In Cold Blood (1967 film)', 'Capote (film)', 'Catch Me If You Can', 'Goodfellas', 'Casino (1995 film)', 'American Gangster (film)', 'Bonnie and Clyde (film)', 'Heat (1995 film)', 'The Godfather', 'Zodiac (2007 film)', 'Mindhunter (TV series)x', 'Dog Day Afternoon', 'Public Enemies', 'Black Mass (film)', 'The Irishman']],
].map(([g, l]) => [g, l.filter((t) => !t.endsWith('x'))]);

// ---------- main ----------
const manifest = [];
const filmInfo = new Map(); // qid -> {title, year, label, group, yt, thumb}
const addedFilm = new Set();

async function main() {
  const HG = await horrorGenreSet();
  const isHorrorGenre = (genres) => genres.some((g) => HG.has(g));
  const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/horror-database.json'), 'utf8'));
  log('horror genre set', HG.size);

  // ---- pools: [{group, label, entries:[{qid,title,year,yt,sl}], target}] ----
  const pools = [];

  // curated resolution: title+year -> candidate enwiki titles
  async function resolveCurated(items) {
    const cand = items.flatMap((it) => [`${it.title} (${it.year} film)`, `${it.title} (film)`, it.title]);
    const info = await pageInfo(cand);
    const found = items.map((it) => {
      const options = [`${it.title} (${it.year} film)`, `${it.title} (film)`, it.title].map((t) => info.get(t)).filter((e) => e?.qid);
      return { it, options };
    });
    const en = await enrich(found.flatMap((f) => f.options.map((o) => o.qid)));
    const out = [];
    for (const { it, options } of found) {
      const pick = options.find((o) => { const e = en.get(o.qid); return e?.isFilm && e.year && Math.abs(e.year - it.year) <= 1; });
      if (pick) out.push({ qid: pick.qid, title: pick.title, year: en.get(pick.qid).year, yt: en.get(pick.qid).yt, sl: 999 });
      else log('  unresolved curated:', it.title, it.year);
    }
    return out;
  }
  // curated by enwiki title (redirects followed)
  async function resolveTitles(titles, { anyType = false } = {}) {
    const info = await pageInfo(titles);
    const items = [...info.values()].filter((e) => e.qid);
    const en = await enrich(items.map((e) => e.qid));
    const out = [];
    for (const e of items) {
      const x = en.get(e.qid);
      if (!anyType && !x?.isFilm) continue;
      out.push({ qid: e.qid, title: e.title, year: x?.year ?? null, yt: x?.yt ?? null, sl: 999 });
    }
    for (const t of titles) if (!info.get(t)?.qid) log('  unresolved title:', t);
    return out;
  }

  log('== horror pools');
  const hMin = await resolveCurated(MINIMALIST);
  const hCal = await resolveCurated(CALIBRATION);
  const hSlasher = await filmPool({ genres: [G.slasher], minSitelinks: 6, limit: 220 });
  const hCreature = await filmPool({ genres: [G.zombie, G.monster, G.splatter, G.bodyHorror], minSitelinks: 8, limit: 300 });
  const hGhost = await filmPool({ genres: [G.ghost, G.supernatural], minSitelinks: 8, limit: 300 });
  const hMoodyG = await filmPool({ genres: [G.psych, G.gothic, G.folk], minSitelinks: 8, limit: 300, yearMin: 2000 });
  const hAll = await filmPool({ genres: [G.horror], minSitelinks: 10, limit: 900 });
  const hHorrorTrailer = await filmPool({ genres: [G.horror], minSitelinks: 3, limit: 400, requireYt: true });

  log('== safe pools');
  const sThriller = await filmPool({ genres: [G.thriller, G.psychThriller, G.neoNoir, G.noir], minSitelinks: 20, limit: 400, yearMin: 1955 });
  const sAction = await filmPool({ genres: [G.action, G.actionAdv, G.fantasy, G.superhero, G.adventure], minSitelinks: 25, limit: 400 });
  const sCrime = await filmPool({ genres: [G.crime, G.heist], minSitelinks: 20, limit: 300 });
  const sScifi = await filmPool({ genres: [G.scifi], minSitelinks: 25, limit: 260 });
  const sWar = await filmPool({ genres: [G.war], minSitelinks: 20, limit: 200 });
  const sDrama = await filmPool({ genres: [G.drama], minSitelinks: 25, limit: 700, yearMin: 1985 });
  const sFamilyG = await filmPool({ genres: [G.halloween], minSitelinks: 3, limit: 60, anyType: true });
  const sKids = await filmPool({ genres: [G.children, G.family, G.animated], minSitelinks: 25, limit: 300 });
  const sGames = await gamePool(450, 30);
  const sTrailerSafe = await filmPool({ genres: [G.thriller, G.action, G.adventure, G.family, G.children, G.halloween, G.fantasy, G.crime], minSitelinks: 3, limit: 500, requireYt: true, anyType: true });
  const namedSafe = [];
  for (const [g, titles] of NAMED_SAFE) namedSafe.push([g, await resolveTitles(titles)]);
  const famNamed = await resolveTitles(FAMILY_HALLOWEEN);

  // collision pool
  log('== collision pool');
  const safeTitleResolved = await resolveTitles([
    'Freaky Friday (1976 film)', 'Freaky Friday (2003 film)', 'Freaky Friday (2018 film)', 'The Devil Wears Prada (film)', 'Devil in a Blue Dress (film)',
    'Monsters, Inc.', 'Monsters University', 'Love and Monsters', 'The Lord of the Rings: The Fellowship of the Ring', 'The Lord of the Rings: The Two Towers',
    'The Lord of the Rings: The Return of the King', 'The Lord of the Rings: The Rings of Power', 'Monsters at Work', 'Freakier Friday', 'The Devil Wears Prada 2',
  ], { anyType: true });
  const horrorTitleSet = new Set(db.titles.map((t) => t.title.toLowerCase()));
  const shortHorror = db.titles.map((t) => t.title).filter((t) => {
    const w = t.replace(/^(the|a|an)\s+/i, '').split(/\s+/);
    return w.length <= 2 && t.length >= 4 && /^[A-Za-z' !-]+$/.test(t);
  });
  const collCands = new Map();
  for (const ht of shortHorror) {
    const j = await mw('en.wikipedia.org', { action: 'query', list: 'search', srsearch: `intitle:"${ht}" film`, srnamespace: '0', srlimit: '20' });
    const re = new RegExp(`(^|[^A-Za-z0-9])${ht.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i');
    for (const r of j.query?.search || []) {
      const bare = r.title.replace(/\s*\((\d{4} )?(film|TV series|miniseries)\)$/i, '');
      if (!re.test(bare) || bare.toLowerCase() === ht.toLowerCase() || horrorTitleSet.has(bare.toLowerCase())) continue;
      if (!collCands.has(r.title)) collCands.set(r.title, ht);
    }
  }
  log('collision candidate titles', collCands.size);
  const collInfo = await pageInfo([...collCands.keys()]);
  const collEn = await enrich([...collInfo.values()].filter((e) => e.qid).map((e) => e.qid));
  const collFilms = [...collInfo.values()].filter((e) => e.qid && collEn.get(e.qid)?.isFilm)
    .map((e) => ({ qid: e.qid, title: e.title, year: collEn.get(e.qid).year, yt: collEn.get(e.qid).yt, sl: 1 }));

  // ---------- gather all wikipedia pages we may need and fetch page info ----------
  const allEntries = new Map();
  const take = (arr) => arr.forEach((e) => { if (!allEntries.has(e.qid)) allEntries.set(e.qid, e); });
  [hMin, hCal, hSlasher, hCreature, hGhost, hMoodyG, hAll, hHorrorTrailer, sThriller, sAction, sCrime, sScifi, sWar, sDrama,
    sFamilyG, sKids, sGames, sTrailerSafe, safeTitleResolved, famNamed, collFilms, ...namedSafe.map((x) => x[1])].forEach(take);
  log('total candidate films/games', allEntries.size);
  const infoByTitle = await pageInfo([...allEntries.values()].map((e) => e.title));
  const en = await enrich([...allEntries.keys()]);
  const meta = new Map();
  for (const [qid, e] of allEntries) {
    const pi = infoByTitle.get(e.title);
    const x = en.get(qid) || { genres: [], yt: null, year: null };
    meta.set(qid, {
      qid, title: e.title.replace(/\s*\((\d{4} )?(film|video game|TV series)\)$/i, ''), year: e.year ?? x.year,
      yt: e.yt || x.yt, thumb: pi?.thumb || null, cats: pi?.cats || [], genres: x.genres,
      horrorGenre: isHorrorGenre(x.genres), horrorCat: (pi?.cats || []).some((c) => HORROR_CAT.test(c)),
    });
  }
  const horrorOk = (q) => { const m = meta.get(q.qid); return m && m.thumb && m.horrorGenre; };
  const safeOk = (q) => { const m = meta.get(q.qid); return m && m.thumb && !m.horrorGenre && !m.horrorCat && !G_BAD.has(q.qid); };
  const G_BAD = new Set();
  const stats = { dropped: {} };
  const drop = (grp, why) => { stats.dropped[grp] = stats.dropped[grp] || {}; stats.dropped[grp][why] = (stats.dropped[grp][why] || 0) + 1; };

  const used = new Set();
  const pick = (grp, label, list, target, filterFn, extra = {}) => {
    let n = 0;
    for (const q of list) {
      if (n >= target) break;
      if (used.has(q.qid)) continue;
      const m = meta.get(q.qid);
      if (!m) continue;
      if (!m.thumb) { drop(grp, 'no-thumbnail'); continue; }
      if (!filterFn(q)) { if (['family-halloween', 'collision'].includes(grp)) log(`    rejected ${m.title}: genre=${m.horrorGenre} cats=${m.cats.filter((c) => HORROR_CAT.test(c)).join(';')}`); drop(grp, label === 'safe' ? 'horror-genre-or-category' : 'not-horror-genre'); continue; }
      used.add(q.qid);
      filmInfo.set(q.qid, { group: grp, label });
      manifest.push({ id: `wp-${q.qid}`, label, group: grp, source: 'wikipedia', url: m.thumb, film: q.qid, title: m.title, year: m.year ?? null, split: null, ...extra });
      n++;
    }
    log(`  ${grp}: ${n}/${target}`);
    return n;
  };
  const byYear = (a, b) => 0;

  // ---- horror (priority order) ----
  log('== picking horror');
  pick('minimalist', 'horror', hMin, 130, horrorOk);
  pick('moody', 'horror', hCal, 3, horrorOk, { calibration: true });
  pick('slasher', 'horror', hSlasher, 95, horrorOk);
  pick('creature-gore', 'horror', hCreature, 115, horrorOk);
  pick('possession-ghost', 'horror', hGhost, 115, horrorOk);
  pick('moody', 'horror', hMoodyG, 110, horrorOk);
  pick('classic', 'horror', hAll.filter((q) => q.year && q.year < 2000), 145, horrorOk);
  // top up moody with generic horror 2000+ if short
  const moodyN = manifest.filter((m) => m.group === 'moody').length;
  if (moodyN < 110) pick('moody', 'horror', hAll.filter((q) => q.year && q.year >= 2000), 110 - moodyN, horrorOk);
  // horror trailer thumbs: any horror film with a trailer id (poster may or may not be in set)
  const ytPush = (qid, grp, label) => {
    const m = meta.get(qid);
    if (!m?.yt) return false;
    manifest.push({ id: `yt-${qid}`, label, group: grp, source: 'youtube', url: `https://i.ytimg.com/vi/${m.yt}/hqdefault.jpg`, film: qid, title: m.title, year: m.year ?? null, split: null });
    return true;
  };
  let ty = 0;
  const horrorTrailerCands = [...hHorrorTrailer, ...[...manifest].filter((m) => m.label === 'horror').map((m) => meta.get(m.film))].filter(Boolean);
  const seenY = new Set();
  for (const q of horrorTrailerCands) {
    const m = meta.get(q.qid);
    if (!m || seenY.has(q.qid) || !m.yt || !m.horrorGenre) continue;
    seenY.add(q.qid);
    if (!filmInfo.has(q.qid)) filmInfo.set(q.qid, { group: 'trailer-thumb', label: 'horror' });
    if (ytPush(q.qid, 'trailer-thumb', 'horror')) ty++;
    if (ty >= 130) break;
  }
  log(`  trailer-thumb: ${ty}`);

  // ---- hard safe ----
  log('== picking safe');
  const nm = Object.fromEntries(namedSafe);
  pick('action-fantasy', 'safe', [...nm['action-fantasy'], ...sAction], 130, safeOk);
  pick('dark-thriller', 'safe', [...nm['dark-thriller'], ...sThriller], 130, safeOk);
  pick('crime', 'safe', [...nm['crime'], ...sCrime], 100, safeOk);
  pick('scifi', 'safe', sScifi, 85, safeOk);
  pick('war', 'safe', sWar, 65, safeOk);
  pick('game-art', 'safe', sGames.filter((g) => !horrorTitleSet.has(g.title.replace(/\s*\(.*\)$/, '').toLowerCase())), 95, safeOk);
  pick('family-halloween', 'safe', [...famNamed, ...sFamilyG], 60, safeOk);
  // collision: named safeTitles first, then search-derived
  pick('collision', 'safe', [...safeTitleResolved, ...collFilms], 90, safeOk);
  pick('dark-drama', 'safe', sDrama, 260, safeOk); // fetch-images keeps the darkest ones
  pick('kids-cartoon', 'safe', sKids, 60, safeOk);

  // safe trailer thumbs: films already in safe groups (thriller/action/family/crime) + trailer pool
  let tys = 0;
  const safeTrailerCands = [...manifest.filter((m) => m.label === 'safe' && ['dark-thriller', 'action-fantasy', 'family-halloween', 'crime', 'scifi'].includes(m.group)).map((m) => ({ qid: m.film })), ...sTrailerSafe];
  const seenS = new Set();
  for (const q of safeTrailerCands) {
    const m = meta.get(q.qid);
    if (!m || seenS.has(q.qid) || !m.yt || m.horrorGenre || m.horrorCat) continue;
    if (!safeOk(q) && !m?.thumb) { /* still fine for a thumbnail-only film */ }
    seenS.add(q.qid);
    if (!filmInfo.has(q.qid)) filmInfo.set(q.qid, { group: 'trailer-thumb-safe', label: 'safe' });
    if (ytPush(q.qid, 'trailer-thumb-safe', 'safe')) tys++;
    if (tys >= 120) break;
  }
  log(`  trailer-thumb-safe: ${tys}`);

  // ---- Commons: family-halloween photos + easy safe ----
  log('== commons');
  const commonsAdd = async (grp, cats, total) => {
    const per = Math.ceil(total / cats.length);
    let n = 0;
    for (const c of cats) {
      let files = [];
      try { files = await commonsFiles(c, { want: per + 6 }); } catch (e) { log('  commons fail', c, e.message); }
      let k = 0;
      for (const f of files) {
        if (k >= per || n >= total) break;
        if (manifest.some((m) => m.id === `cm-${f.pageid}`)) continue;
        manifest.push({ id: `cm-${f.pageid}`, label: 'safe', group: grp, source: 'commons', url: f.url, film: null, title: f.file.replace(/^File:/, ''), year: null, split: null });
        k++; n++;
      }
      log(`  ${grp} <- ${c}: ${k}`);
    }
  };
  await commonsAdd('family-halloween', ['Halloween costumes', 'Pumpkins', 'Jack-o-lanterns', 'Halloween'], 40);
  await commonsAdd('photo', ['Quality images of landscapes', 'Quality images of buildings', 'Featured pictures of landscapes', 'Featured pictures of architecture'], 60);
  await commonsAdd('ui-screenshot', ['Screenshots of websites', 'Computer screenshots', 'Screenshots of free software', 'Screenshots of Netscape', 'Screenshots of Opera', 'Screenshots of Vim'], 60);
  await commonsAdd('logo', ['Logos of companies', 'Logos of brands', 'Logos of websites'], 60);
  await commonsAdd('food', ['Featured pictures of food', 'Desserts', 'Pizza', 'Salads', 'Cakes', 'Sushi'], 60);
  await commonsAdd('product', ['Smartphones', 'Consumer electronics', 'Furniture'], 60);
  await commonsAdd('people', ['Portrait photographs of women', 'Portrait photographs of men', 'Featured pictures of people'], 60);

  // ---- split: per film (global), rank by seeded hash within primary group, 60/20/20 ----
  const unitGroup = new Map(); // unit key -> primary group
  for (const m of manifest) {
    const key = m.film || m.id;
    const g = filmInfo.get(m.film)?.group || m.group;
    unitGroup.set(key, g);
  }
  const byGroup = new Map();
  for (const [k, g] of unitGroup) { if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(k); }
  const splitOf = new Map();
  for (const [g, keys] of byGroup) {
    keys.sort((a, b) => hashNum(`${g}|${a}`) - hashNum(`${g}|${b}`));
    keys.forEach((k, i) => splitOf.set(k, i / keys.length < 0.6 ? 'train' : i / keys.length < 0.8 ? 'val' : 'test'));
  }
  for (const m of manifest) m.split = splitOf.get(m.film || m.id);

  fs.writeFileSync(path.join(HERE, 'images.json'), JSON.stringify(manifest, null, 1) + '\n');
  // summary
  const sum = {};
  for (const m of manifest) { const k = `${m.label}/${m.group}`; sum[k] = sum[k] || { train: 0, val: 0, test: 0, total: 0 }; sum[k][m.split]++; sum[k].total++; }
  console.table(sum);
  const tot = (l) => manifest.filter((m) => m.label === l).length;
  log('horror', tot('horror'), 'safe', tot('safe'), 'dropped at build', JSON.stringify(stats.dropped));
  fs.writeFileSync(path.join(HERE, '.cache', 'build-stats.json'), JSON.stringify({ sum, dropped: stats.dropped }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
