/**
 * Render the extension and store icons from the Twemoji weary cat
 * (icons/twemoji-1f640.svg, jdecked/twemoji 17.0.3, graphics CC-BY 4.0; see
 * THIRD_PARTY_NOTICES). The PNGs are committed; rerun only when the source
 * changes:
 *
 *   node scripts/make-icons.mjs
 *
 * 16/32/48 fill the canvas (toolbar sizes). 128 follows the Chrome Web Store
 * guideline: 96x96 artwork centred with 16px transparent padding, so the same
 * file serves the manifest and the store listing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(ROOT, 'icons/twemoji-1f640.svg');
const svg = fs.readFileSync(SOURCE);

async function render(size, art = size) {
  const pad = (size - art) / 2;
  const glyph = await sharp(svg, { density: Math.ceil((art / 36) * 72 * 4) })
    .resize(art, art)
    .png()
    .toBuffer();
  const out = path.join(ROOT, `icons/icon${size}.png`);
  await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: glyph, left: pad, top: pad }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`icons/icon${size}.png  (${art}px artwork)`);
}

await render(16);
await render(32);
await render(48);
await render(128, 96);
