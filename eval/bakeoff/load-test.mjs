import path from 'node:path';
import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';
const [dir, id, size] = process.argv.slice(2);
env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = path.resolve(dir);
const proc = await AutoProcessor.from_pretrained(id);
const img = new RawImage(new Uint8ClampedArray(Array.from({ length: 64 * 64 * 3 }, (_, i) => (i * 7) % 256)), 64, 64, 3);
const inputs = await proc(img);
console.log('processed', inputs.pixel_values.dims);
const out = {};
for (const dtype of ['fp32', 'fp16', 'q8']) {
  try {
    const m = await CLIPVisionModelWithProjection.from_pretrained(id, { dtype, session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } });
    const r = await m.forward ? await m(inputs) : null;
    out[dtype] = r.image_embeds.data; console.log(dtype, 'ok', r.image_embeds.dims, Array.from(r.image_embeds.data.slice(0, 3)).map(x => x.toFixed(4)).join(' '));
  } catch (e) { console.log(dtype, 'FAILED', String(e.message || e).slice(0, 200)); }
}
process.exit(0);
