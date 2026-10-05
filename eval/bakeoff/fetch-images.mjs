// Downloads the manifest images into .cache/img/<id>.<ext>. Resumable and idempotent.
// Writes .cache/img-index.json: { [id]: { ok, ext, sha256, width, height, bytes, lum, excluded?, reason? } }
// Wikimedia hosts: 1-1.5 s between requests. YouTube thumbnails: 0.3 s.
// Dark-drama selection: after download, only the darkest KEEP_DARK posters stay (others get excluded: "not-dark").
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(HERE, '.cache', 'img');
const INDEX = path.join(HERE, '.cache', 'img-index.json');
const UA = 'scaredycat-eval/1.0 (https://github.com/flenguyen/scaredycat; model bake-off)';
const KEEP_DARK = 105;
fs.mkdirSync(IMG, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'images.json'), 'utf8'));
const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const save = () => fs.writeFileSync(INDEX, JSON.stringify(index, null, 1));

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

async function download(url) {
  let last;
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404 || res.status === 403 || res.status === 410) return { dead: `HTTP ${res.status}` };
      if (res.status === 429 || res.status >= 500) {
        const ra = +res.headers.get('retry-after');
        last = `HTTP ${res.status}`;
        await sleep(Math.max(ra * 1000 || 0, Math.min(60000, 4000 * 2 ** a)));
        continue;
      }
      if (!res.ok) return { dead: `HTTP ${res.status}` };
      return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type')?.split(';')[0] };
    } catch (e) {
      last = e.message;
      await sleep(Math.min(60000, 4000 * 2 ** a));
    }
  }
  return { dead: last || 'failed' };
}

async function lumOf(file) {
  const { channels } = await sharp(file).resize(64, 64, { fit: 'inside' }).flatten({ background: '#808080' }).greyscale().stats();
  return Math.round(channels[0].mean * 10) / 10;
}

let n = 0, fetched = 0;
for (const m of manifest) {
  n++;
  const have = index[m.id];
  if (have && (have.ok || have.reason)) {
    if (!have.ok || fs.existsSync(path.join(IMG, `${m.id}.${have.ext}`))) continue;
  }
  const r = await download(m.url);
  const slow = m.source !== 'youtube';
  if (r.dead) { index[m.id] = { ok: false, reason: `dead: ${r.dead}` }; }
  else {
    try {
      const ext = EXT[r.type] || (m.url.match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1].toLowerCase().replace('jpeg', 'jpg')) || 'jpg';
      const meta = await sharp(r.buf).metadata();
      if (m.source === 'youtube' && meta.width <= 120 && meta.height <= 90) index[m.id] = { ok: false, reason: 'youtube-placeholder' };
      else if (!meta.width || meta.width < 64 || meta.height < 64) index[m.id] = { ok: false, reason: 'too-small' };
      else {
        const file = path.join(IMG, `${m.id}.${ext}`);
        fs.writeFileSync(file, r.buf);
        index[m.id] = {
          ok: true, ext, sha256: crypto.createHash('sha256').update(r.buf).digest('hex'),
          width: meta.width, height: meta.height, bytes: r.buf.length, lum: await lumOf(file),
        };
      }
    } catch (e) { index[m.id] = { ok: false, reason: `undecodable: ${e.message}` }; }
  }
  fetched++;
  if (fetched % 25 === 0) { save(); log(`${n}/${manifest.length} fetched=${fetched} ok=${Object.values(index).filter((x) => x.ok).length}`); }
  await sleep(slow ? 1000 + Math.random() * 500 : 300);
}

// duplicate content (same sha256) within the set: keep the first, exclude later ones
const seen = new Map();
for (const m of manifest) {
  const x = index[m.id];
  if (!x?.ok) continue;
  delete x.excluded;
  if (seen.has(x.sha256)) { x.ok = false; x.reason = `duplicate of ${seen.get(x.sha256)}`; continue; }
  seen.set(x.sha256, m.id);
}
// dark-drama: keep the darkest KEEP_DARK
const drama = manifest.filter((m) => m.group === 'dark-drama' && index[m.id]?.ok).sort((a, b) => index[a.id].lum - index[b.id].lum);
drama.forEach((m, i) => { if (i >= KEEP_DARK) index[m.id].excluded = 'not-dark'; else delete index[m.id].excluded; });
save();
const ok = Object.values(index).filter((x) => x.ok && !x.excluded).length;
log(`done. downloaded/checked ${fetched} new, usable ${ok}/${manifest.length}, dropped ${Object.values(index).filter((x) => !x.ok).length}, excluded ${Object.values(index).filter((x) => x.excluded).length}`);
process.exit(0);
