/**
 * Unit test for background/image-key.js: same image at different sizes must
 * share a key; different images must not collide.
 *   node eval/image-key-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const moduleObj = { exports: {} };
new Function('module', fs.readFileSync(path.join(ROOT, 'background/image-key.js'), 'utf8'))(moduleObj);
const { canonicalImageKey: key } = moduleObj.exports;

let failures = 0;
function same(a, b, why) {
  const ka = key(a), kb = key(b);
  const ok = ka === kb;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} same   ${why}${ok ? '' : `\n         ${ka}\n         ${kb}`}`);
}
function differ(a, b, why) {
  const ka = key(a), kb = key(b);
  const ok = ka !== kb;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} differ ${why}${ok ? '' : `\n         both -> ${ka}`}`);
}

same('https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg?sqp=-oaymwE&rs=AOn4CLA',
     'https://i.ytimg.com/vi_webp/abc123XYZ/maxresdefault.webp', 'youtube sizes/formats');
differ('https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg', 'https://i.ytimg.com/vi/other9/hqdefault.jpg', 'youtube ids');

same('https://image.tmdb.org/t/p/w300/poster1.jpg', 'https://image.tmdb.org/t/p/original/poster1.jpg', 'tmdb width buckets');
differ('https://image.tmdb.org/t/p/w300/poster1.jpg', 'https://image.tmdb.org/t/p/w300/poster2.jpg', 'tmdb files');

same('https://m.media-amazon.com/images/M/MV5BMTU1@._V1_QL75_UX190_CR0,0,190,281_.jpg',
     'https://m.media-amazon.com/images/M/MV5BMTU1@._V1_.jpg', 'amazon resize ops');
differ('https://m.media-amazon.com/images/M/MV5BMTU1@._V1_.jpg', 'https://m.media-amazon.com/images/M/MV5BOTHER@._V1_.jpg', 'amazon ids');

same('https://resizing.flixster.com/abc/300x450/v2/https://resizing.flixster.com/x/y/z.jpg',
     'https://resizing.flixster.com/def/600x900/v2/https://resizing.flixster.com/x/y/z.jpg', 'flixster sizes');
differ('https://resizing.flixster.com/abc/300x450/v2/https://a/1.jpg', 'https://resizing.flixster.com/abc/300x450/v2/https://a/2.jpg', 'flixster inner');

same('https://a.ltrbxd.com/resized/film-poster/1/2/3/name-0-230-0-345-crop.jpg?v=aa',
     'https://a.ltrbxd.com/resized/film-poster/1/2/3/name-0-500-0-750-crop.jpg?v=aa', 'letterboxd sizes');
differ('https://a.ltrbxd.com/resized/film-poster/1/2/3/name-0-230-0-345-crop.jpg?v=aa',
       'https://a.ltrbxd.com/resized/film-poster/1/2/3/other-0-230-0-345-crop.jpg?v=aa', 'letterboxd names');

same('https://cdn.example.com/img/pic.jpg?w=300&h=200&q=80&fit=crop', 'https://cdn.example.com/img/pic.jpg?w=1200', 'generic resize params');
same('https://cdn.example.com/img/pic.jpg#frag', 'https://cdn.example.com/img/pic.jpg', 'hash dropped');
differ('https://cdn.example.com/img/pic.jpg?id=1', 'https://cdn.example.com/img/pic.jpg?id=2', 'non-resize params kept');
differ('https://cdn.example.com/img/a.jpg', 'https://cdn.example.com/img/b.jpg', 'generic paths');
same('not a url', 'not a url', 'non-url passthrough');

console.log(failures ? `\nimage-key: ${failures} failure(s)` : '\nimage-key: all cases pass ✓');
process.exit(failures ? 1 : 0);
