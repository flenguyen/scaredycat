// Prompt-list variants for the CLIP zero-shot tuning (phase C). Each is derived from the shipped list.
// Designed from TRAIN-split errors only (eval/bakeoff/analyze-train.mjs): genre-poster safe prompts
// ("dark moody thriller", "war", "sci-fi", "action", "superhero") win on many missed horror posters, while
// the single "horror movie poster" prompt and the jump-scare prompt win on most false blurs (family
// halloween, dark dramas, trailer frames).
import fs from 'node:fs';
import path from 'node:path';
import { CACHE } from './lib.mjs';

export const shipped = JSON.parse(fs.readFileSync(path.join(CACHE, 'variants/shipped.json'), 'utf8'));
const H = (text) => ({ label: 'horror', text }), S = (text) => ({ label: 'safe', text });
const dropIf = (list, re) => list.filter(p => !re.test(p.text));

const GENRE_SINKS = /action movie|science fiction|fantasy adventure|superhero|dark moody|war or military|video game/;
const THRILLER_WAR_SCIFI = /dark moody|war or military|science fiction/;
const MORE_HORROR = [
  H('a scary horror movie poster'), H('a dark and frightening movie still'),
  H('a monster or creature attacking people'), H('a person covered in blood'),
  H('a screaming terrified face'), H('an eerie dark silhouette in the fog')
];
const MORE_SAFE = [
  S('a children\'s halloween party, costume or decoration'), S('a family-friendly animated movie'),
  S('a prestige drama movie poster'), S('a historical photograph'), S('a dramatic movie scene with actors in costume')
];

export const VARIANTS = {
  shipped,
  'no-genre-sinks': dropIf(shipped, GENRE_SINKS),
  'drop-thriller-war-scifi': dropIf(shipped, THRILLER_WAR_SCIFI),
  'more-horror': [...shipped.filter(p => p.label === 'horror'), ...MORE_HORROR, ...shipped.filter(p => p.label === 'safe')],
  'more-horror-no-sinks': [...shipped.filter(p => p.label === 'horror'), ...MORE_HORROR, ...dropIf(shipped.filter(p => p.label === 'safe'), GENRE_SINKS)],
  'binary-minimal': [
    H('a horror movie poster'), H('a scary scene from a horror film'), H('a gory monster'), H('a frightening ghost'),
    S('a movie poster'), S('an ordinary photograph'), S('a screenshot of a website or app'), S('a company logo'), S('a cartoon')
  ],
  'more-safe': [...shipped, ...MORE_SAFE],
  'more-both': [...shipped.filter(p => p.label === 'horror'), ...MORE_HORROR, ...shipped.filter(p => p.label === 'safe'), ...MORE_SAFE],
  'more-both-no-sinks': [...shipped.filter(p => p.label === 'horror'), ...MORE_HORROR, ...dropIf(shipped.filter(p => p.label === 'safe'), GENRE_SINKS), ...MORE_SAFE]
};
