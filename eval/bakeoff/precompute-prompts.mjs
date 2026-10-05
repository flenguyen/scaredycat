// Bake-off copy of eval/precompute-prompts.mjs.
// Usage: node precompute-prompts.mjs --model <name> --prompts <file.json> --out <dir>
// <file.json> is [{label,text}] (or {prompts:[...]}). Writes prompt-embeddings.json + .bin into <dir>,
// same format as data/prompt-embeddings.*. fp32 text tower, one prompt at a time so no padding is needed
// (the CLIP text exports have dynamic sequence length; the pooled token is the EOS position).
// logitScale is the model's own trained logit_scale (from src weights, recorded in LOGIT_SCALE below).
import fs from 'node:fs';
import path from 'node:path';
import { env, AutoTokenizer, CLIPTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';
import { arg, modelLocation } from './lib.mjs';

// Trained logit_scale.exp() read from each model's weights (logit_scale param):
// TinyCLIP 8M/40M: 3.9121 -> 50.0; CLIP ViT-B/32: 4.6052 -> 100.0; MobileCLIP shipped list uses 100 (unchanged).
export const LOGIT_SCALE = { 'tinyclip-vit-8m-16-yfcc15m': 50, 'tinyclip-vit-40m-32-laion400m': 50, 'clip-vit-b-32': 100, 'mobileclip-s0': 100 };

const name = arg('model'), promptsFile = arg('prompts'), out = arg('out');
let prompts = JSON.parse(fs.readFileSync(promptsFile, 'utf8')); if (!Array.isArray(prompts)) prompts = prompts.prompts;
const jsonPath = path.join(out, 'prompt-embeddings.json');
if (fs.existsSync(jsonPath)) { console.log('exists, skipping', out); process.exit(0); }
fs.mkdirSync(out, { recursive: true });

const { root, id } = modelLocation(name);
env.localModelPath = root; env.allowRemoteModels = false; env.allowLocalModels = true;
// The TinyCLIP exports ship tokenizer.json but no tokenizer_config.json; reuse the (identical,
// OpenAI BPE) config from the CLIP ViT-B/32 export for them.
const dir = path.join(root, id);
const cfgPath = fs.existsSync(path.join(dir, 'tokenizer_config.json')) ? path.join(dir, 'tokenizer_config.json') : path.join(root, 'clip-vit-b-32', 'tokenizer_config.json');
const tokenizer = fs.existsSync(path.join(dir, 'tokenizer_config.json')) ? await AutoTokenizer.from_pretrained(id)
  : new CLIPTokenizer(JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')), JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
const textModel = await CLIPTextModelWithProjection.from_pretrained(id, {
  dtype: 'fp32', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
});
const rows = [];
for (const p of prompts) {
  const inputs = tokenizer([p.text], { padding: false, truncation: true, max_length: 77 });
  const { text_embeds } = await textModel(inputs);
  const v = Array.from(text_embeds.data); const n = Math.hypot(...v);
  rows.push(v.map(x => x / n));
}
const dim = rows[0].length, floats = new Float32Array(rows.length * dim);
rows.forEach((r, i) => floats.set(r, i * dim));
fs.writeFileSync(path.join(out, 'prompt-embeddings.bin'), Buffer.from(floats.buffer));
fs.writeFileSync(jsonPath, JSON.stringify({
  modelId: name, dim, logitScale: LOGIT_SCALE[name] ?? 100, embeddings: 'prompt-embeddings.bin',
  prompts: prompts.map(p => ({ label: p.label, text: p.text }))
}, null, 2) + '\n');
console.log('wrote', out, rows.length, 'prompts dim', dim);
process.exit(0);
