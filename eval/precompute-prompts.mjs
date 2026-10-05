/**
 * Zero-shot models only: embed the prompt ensemble below with the model's
 * text tower (dev cache, fp32) into eval/bakeoff/.cache/prompts/<model>/custom/
 * as prompt-embeddings.json (labels + logit scale) and prompt-embeddings.bin
 * (Float32 [prompts x dim], L2-normalized), the format offscreen/classifier.js
 * reads. The extension then needs only the vision tower and never tokenizes.
 *
 * New prompts mean new raw scores, so the calibration has to be re-picked
 * before they can ship: score the bake-off images with them (eval/bakeoff,
 * analyze.py on in-browser embeddings), point the config's `prompts` in
 * finalists.json at the new directory, then run eval/bakeoff/promote.mjs,
 * which copies the files into models/<dir>/ and writes the new knots and
 * version (models/README.md).
 *
 * A model with a linear head (the shipped one, see models/image-model.json)
 * has no prompts: this exits with a message.
 *
 *   npm run precompute:prompts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODEL_ID, MODEL_MANIFEST } from './setup-model.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (MODEL_MANIFEST.scorer.type !== 'zero-shot') {
  console.error(`${MODEL_MANIFEST.version} scores images with a linear head (${MODEL_MANIFEST.scorer.file}), not prompts: nothing to precompute.`);
  console.error('A head is retrained in eval/bakeoff (analyze.py) and shipped with eval/bakeoff/promote.mjs; see models/README.md.');
  process.exit(1);
}

// Prompt ensemble. horror prompts vote FOR blocking, safe prompts AGAINST.
// The safe set deliberately covers historical false-positive classes
// (logos, dashboards, benign Halloween) so they have somewhere to land.
const PROMPTS = [
  { label: 'horror', text: 'a terrifying scene from a horror movie' },
  { label: 'horror', text: 'a horror movie poster with a frightening figure' },
  { label: 'horror', text: 'a zombie or rotting undead monster' },
  { label: 'horror', text: 'a bloody, gory, or mutilated body' },
  { label: 'horror', text: 'a creepy haunted figure in a dark room' },
  { label: 'horror', text: 'a demonic or possessed face with unnatural features' },
  { label: 'horror', text: 'a scary evil clown or masked killer with a weapon' },
  { label: 'horror', text: 'a ghostly supernatural apparition' },
  { label: 'horror', text: 'a human skull, corpse, or dead body in a disturbing setting' },
  { label: 'horror', text: 'a frightening jump scare moment from a scary film' },

  { label: 'safe', text: 'an ordinary everyday photograph' },
  { label: 'safe', text: 'a screenshot of a website, app, or software dashboard' },
  { label: 'safe', text: 'a company logo or app icon' },
  { label: 'safe', text: 'a portrait photo of a person smiling' },
  { label: 'safe', text: 'a movie poster for a comedy, drama, or romance' },
  { label: 'safe', text: 'a landscape, city, or nature photo' },
  { label: 'safe', text: 'food photography or a recipe photo' },
  { label: 'safe', text: 'a product photo for online shopping' },
  { label: 'safe', text: 'a sports game or athletic event' },
  { label: 'safe', text: 'a colorful cartoon for children' },
  { label: 'safe', text: 'a cute halloween pumpkin or family costume' },
  { label: 'safe', text: 'people working in an office or business meeting' },
  { label: 'safe', text: 'a cute pet such as a dog or cat' },
  { label: 'safe', text: 'a wild animal in nature' },
  { label: 'safe', text: 'a musician, concert, or album cover' },
  { label: 'safe', text: 'a car, vehicle, or technology gadget' },
  { label: 'safe', text: 'a baby or children playing' },
  { label: 'safe', text: 'a fashion or beauty photo' },
  // Dark-but-not-horror genres: without these, action/fantasy posters
  // (Mortal Kombat, Masters of the Universe) read as horror-adjacent.
  { label: 'safe', text: 'an action movie poster with explosions, guns, or car chases' },
  { label: 'safe', text: 'a science fiction movie poster with spaceships or futuristic technology' },
  { label: 'safe', text: 'a fantasy adventure movie poster with warriors, dragons, or magic' },
  { label: 'safe', text: 'a superhero movie poster' },
  { label: 'safe', text: 'a video game cover or fighting game artwork' },
  { label: 'safe', text: 'a dark moody movie poster for a thriller, crime, or spy film' },
  { label: 'safe', text: 'a war or military movie poster' }
];

const out = path.join(ROOT, 'eval/bakeoff/.cache/prompts', MODEL_ID, 'custom');
if (fs.existsSync(path.join(out, 'prompt-embeddings.json'))) {
  console.error(`${path.relative(ROOT, out)} already exists; move it aside first.`);
  process.exit(1);
}
const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-prompts-')), 'prompts.json');
fs.writeFileSync(list, JSON.stringify(PROMPTS));
console.log(`Embedding ${PROMPTS.length} prompts with ${MODEL_ID} text tower...`);
// The bake-off script does the work: fp32 text tower, one prompt at a time
// (no padding), the model's own trained logit scale.
execFileSync(process.execPath, [path.join(ROOT, 'eval/bakeoff/precompute-prompts.mjs'),
  '--model', MODEL_ID, '--prompts', list, '--out', out], { stdio: 'inherit' });
console.log(`Next: re-pick the bars for these prompts, then eval/bakeoff/promote.mjs (models/README.md).`);
