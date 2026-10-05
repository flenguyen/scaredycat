// Shared helpers for the bake-off Node scripts (phase C).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(path.dirname(HERE));
export const CACHE = path.join(HERE, '.cache');
export const MODELS = ['mobileclip-s0', 'tinyclip-vit-8m-16-yfcc15m', 'tinyclip-vit-40m-32-laion400m', 'clip-vit-b-32', 'dinov2-small', 'mobilenetv3-large-100', 'efficientnet-lite0'];
export const CLIP_MODELS = ['mobileclip-s0', 'tinyclip-vit-8m-16-yfcc15m', 'tinyclip-vit-40m-32-laion400m', 'clip-vit-b-32'];
export const DTYPES = ['fp32', 'fp16', 'q8'];

/** Where transformers.js should look for a model, and its id under that root. */
export function modelLocation(name) {
  if (name === 'mobileclip-s0') return { root: path.join(ROOT, 'eval/.model-cache'), id: 'Xenova/mobileclip_s0' };
  return { root: path.join(ROOT, 'eval/.model-cache/bakeoff'), id: name };
}

export const images = () => JSON.parse(fs.readFileSync(path.join(HERE, 'images.json'), 'utf8'));
const index = () => ({ ...JSON.parse(fs.readFileSync(path.join(CACHE, 'additions-index.json'), 'utf8')), ...JSON.parse(fs.readFileSync(path.join(CACHE, 'img-index.json'), 'utf8')) });
export function imagePath(id, idx) { return path.join(CACHE, 'img', `${id}.${idx[id].ext}`); }
export const loadIndex = index;

export async function loadVision(name, dtype) {
  const { root, id } = modelLocation(name);
  env.localModelPath = root; env.allowRemoteModels = false; env.allowLocalModels = true;
  const processor = await AutoProcessor.from_pretrained(id);
  const model = await CLIPVisionModelWithProjection.from_pretrained(id, {
    dtype, session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
  });
  return { processor, model };
}

export async function embedFile(processor, model, file, view = null) {
  let image;
  try { image = await RawImage.read(file); }
  catch { // RawImage.read rejects a few gray+alpha PNGs: decode with sharp, flatten onto white
    const { default: sharp } = await import('sharp');
    const { data, info } = await sharp(file).flatten({ background: '#fff' }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    image = new RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels);
  }
  if (image.channels === 4) { // RGBA: composite over white
    const { data, width, height } = image, rgb = new Uint8ClampedArray(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      const a = data[i + 3] / 255;
      for (let c = 0; c < 3; c++) rgb[j + c] = data[i + c] * a + 255 * (1 - a);
    }
    image = new RawImage(rgb, width, height, 3);
  }
  if (view === 'crop') { // the extension's geometry: shortest edge 256, centre crop 256, then the processor
    const S = 256, k = Math.max(S / image.width, S / image.height);
    image = await (await image.resize(Math.floor(Number((image.width * k).toFixed(2))), Math.floor(Number((image.height * k).toFixed(2))))).center_crop(S, S);
  } else if (view === 'squash') { // whole image to the model's square input
    const sz = processor.image_processor.size, S = typeof sz === 'number' ? sz : (sz.shortest_edge ?? sz.height);
    image = await image.resize(S, S);
  }
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);
  return image_embeds.data;
}

export function l2(v) {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s); const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / n;
  return o;
}

export function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

export function readEmb(name, dtype) {
  const base = path.join(CACHE, 'emb', `${name}-${dtype}`);
  if (!fs.existsSync(base + '.json')) return null;
  const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
  if (meta.status !== 'ok') return null;
  const raw = fs.readFileSync(base + '.f32');
  return { meta, data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) };
}
