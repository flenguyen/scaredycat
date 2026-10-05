// Zero-shot prompt tuning for the CLIP models. Scores train and val only. NEVER reads the test split.
// Usage: node tune.mjs [--model <name>]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HERE, CACHE, CLIP_MODELS, readEmb, arg } from './lib.mjs';
import { loadPromptDir, scoreAll, rocAuc, fbrAtRecall, splitMetrics } from './score-lib.mjs';
import { VARIANTS } from './prompt-variants.mjs';

const models = arg('model') ? [arg('model')] : CLIP_MODELS.filter(m => m !== 'mobileclip-s0');
fs.mkdirSync(path.join(HERE, 'prompts'), { recursive: true });
for (const m of models) {
  const emb = readEmb(m, 'fp32'); const results = [];
  for (const [v, list] of Object.entries(VARIANTS)) {
    const vf = path.join(CACHE, 'variants', m, v + '.json'); fs.mkdirSync(path.dirname(vf), { recursive: true });
    fs.writeFileSync(vf, JSON.stringify(list, null, 1));
    execFileSync('node', [path.join(HERE, 'precompute-prompts.mjs'), '--model', m, '--prompts', vf, '--out', path.join(CACHE, 'prompts', m, v)], { stdio: 'pipe' });
    const pd = loadPromptDir(path.join(CACHE, 'prompts', m, v)); const sc = scoreAll(emb, pd);
    const val = splitMetrics(sc, 'val'), tr = splitMetrics(sc, 'train');
    const f = fbrAtRecall(val.pos, val.hard, 0.8);
    results.push({ variant: v, nPrompts: list.length, logitScale: pd.logitScale,
      valAuc: rocAuc(val.pos, val.neg), valHardAuc: rocAuc(val.pos, val.hard),
      valHardFalseBlurAtRecall80: f.fbr, valThreshold: f.threshold, valRecallAtThreshold: f.recall,
      trainAuc: rocAuc(tr.pos, tr.neg) });
    console.log(m, v.padEnd(24), 'valAUC', results.at(-1).valAuc.toFixed(4), 'hardFBR@R80', f.fbr.toFixed(3), 'trainAUC', results.at(-1).trainAuc.toFixed(4));
  }
  const maxAuc = Math.max(...results.map(r => r.valAuc));
  const best = results.filter(r => r.valAuc >= maxAuc - 0.005).sort((a, b) => a.valHardFalseBlurAtRecall80 - b.valHardFalseBlurAtRecall80)[0];
  fs.writeFileSync(path.join(HERE, 'prompts', m + '.variants.json'), JSON.stringify({ model: m, selectedBy: 'among variants within 0.005 of the best val ROC-AUC, lowest hard-safe false-blur at val recall 80%', chosen: best.variant, variants: results }, null, 1) + '\n');
  fs.writeFileSync(path.join(HERE, 'prompts', m + '.json'), JSON.stringify({ model: m, variant: best.variant, logitScale: best.logitScale, prompts: VARIANTS[best.variant] }, null, 1) + '\n');
  console.log('CHOSEN', m, best.variant, best.valAuc.toFixed(4));
}
process.exit(0);
