// Zero-shot scores for every CLIP model x dtype with the chosen prompts. Writes .cache/scores/<m>-<dtype>-zs.json {id: score}.
// MobileCLIP uses the SHIPPED data/prompt-embeddings.* unchanged. Prints val AUC only (no test).
import fs from 'node:fs';
import path from 'node:path';
import { HERE, ROOT, CACHE, CLIP_MODELS, DTYPES, readEmb, images } from './lib.mjs';
import { loadPromptDir, scoreAll, rocAuc, fbrAtRecall, splitMetrics } from './score-lib.mjs';

fs.mkdirSync(path.join(CACHE, 'scores'), { recursive: true });
const mdir = path.join(CACHE, 'prompts/mobileclip-s0/shipped'); fs.mkdirSync(mdir, { recursive: true });
for (const f of ['prompt-embeddings.json', 'prompt-embeddings.bin']) fs.copyFileSync(path.join(ROOT, 'data', f), path.join(mdir, f));
const ship = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/prompt-embeddings.json'), 'utf8'));
fs.writeFileSync(path.join(HERE, 'prompts/mobileclip-s0.json'), JSON.stringify({ model: 'mobileclip-s0', variant: 'shipped', logitScale: ship.logitScale, note: 'shipped data/prompt-embeddings.* unchanged, no tuning', prompts: ship.prompts }, null, 1) + '\n');

const imgs = images();
for (const m of CLIP_MODELS) {
  const chosen = m === 'mobileclip-s0' ? 'shipped' : JSON.parse(fs.readFileSync(path.join(HERE, 'prompts', m + '.json'), 'utf8')).variant;
  const pd = loadPromptDir(path.join(CACHE, 'prompts', m, chosen));
  for (const dtype of DTYPES) {
    const emb = readEmb(m, dtype); if (!emb) { console.log(m, dtype, 'no embeddings (failed)'); continue; }
    const sc = scoreAll(emb, pd); const o = {}; imgs.forEach((im, i) => { o[im.id] = sc[i]; });
    fs.writeFileSync(path.join(CACHE, 'scores', `${m}-${dtype}-zs.json`), JSON.stringify(o));
    const v = splitMetrics(sc, 'val');
    console.log(m, dtype, chosen, 'val AUC', rocAuc(v.pos, v.neg).toFixed(4), 'hardFBR@R80', fbrAtRecall(v.pos, v.hard).fbr.toFixed(3));
  }
}
process.exit(0);
