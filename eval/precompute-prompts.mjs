/**
 * Precompute the zero-shot prompt embeddings and write them to
 * data/prompt-embeddings.json. The extension then needs only the CLIP
 * vision tower at runtime (~12MB instead of ~55MB) and never tokenizes.
 *
 * Tuning detection = editing PROMPTS and re-running this script.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';
import { MODEL_ID, MODEL_VERSION } from './setup-model.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
env.localModelPath = path.join(ROOT, 'models');
env.allowRemoteModels = false;

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

console.log(`Embedding ${PROMPTS.length} prompts with ${MODEL_ID} text tower...`);
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, {
  dtype: 'q8',
  // Single-threaded: onnxruntime-node aborts in threaded mode on macOS arm64.
  session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
});

// MobileCLIP's text tower has a fixed 77-token context (no dynamic axis).
const inputs = tokenizer(PROMPTS.map(p => p.text), {
  padding: 'max_length', max_length: 77, truncation: true
});
const { text_embeds } = await textModel(inputs);

const [n, dim] = text_embeds.dims;
const data = text_embeds.data;
const prompts = PROMPTS.map((p, i) => {
  const vec = Array.from(data.slice(i * dim, (i + 1) * dim));
  const norm = Math.hypot(...vec);
  return { label: p.label, text: p.text, embedding: vec.map(v => v / norm) };
});

const out = {
  modelId: MODEL_ID,
  modelVersion: MODEL_VERSION,
  dim,
  logitScale: 100,
  prompts
};

const outPath = path.join(ROOT, 'data', 'prompt-embeddings.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${outPath} (${n} prompts, dim=${dim}, ${(fs.statSync(outPath).size / 1e3).toFixed(0)}KB)`);
// Exit explicitly: onnxruntime-node's teardown otherwise aborts the process
// with a (harmless) mutex error after all work is done.
process.exit(0);
