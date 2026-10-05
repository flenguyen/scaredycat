/**
 * Video, short and ad cards: the text rules that decide whether a card's
 * picture gets checked and how strong its own title is.
 *   - a card whose own title files it under the genre ("Horror Short",
 *     "#horror") blurs at once; a weaker label ("horror stories", "#creepy")
 *     blurs unless the image vetoes it, and when there is no image verdict
 *   - any horror text on a video or ad card goes to the classifier (the old
 *     1-39 gap waved "Hotel Visitor - Horror Short" through unchecked)
 *   - byline/description text is weak: classifier at the horror-page bar,
 *     never a block on its own
 *   node eval/cards-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const moduleObj = { exports: {} };
new Function('module', 'self', read('content/scoring-core.js'))(moduleObj, undefined);
const Scoring = moduleObj.exports;
const windowStub = {};
new Function('window', 'chrome', 'module', 'ScaredyCatCards', read('content/ml-bridge.js'))(windowStub, undefined, undefined, undefined);
const Bridge = windowStub.ScaredyCatMLBridge;

const db = JSON.parse(read('data/horror-database.json'));
const compiled = Scoring.compile(db);
const MEDIUM = Scoring.SENSITIVITY_THRESHOLDS.medium;
const BANDS = Scoring.BANDS;

const analyze = (text, opts = {}) => Scoring.analyzeText(text, compiled, { threshold: MEDIUM, scanQuietElements: false, ...opts });
const asCard = (title) => analyze(title, { scanAnyText: true, selfLabelText: title });

test('genre labels in a card title: strong and weak', () => {
  const strong = [
    ['Hotel Visitor - Horror Short', 'horror short'],
    ['DISGUISE | Short Horror Film', 'short horror'],
    ["Don't Answer Your Mom's Voice | Analog Horror", 'analog horror'],
    ['Smiling Woman 4 | Short Film #horrorshorts', '#horrorshorts'],
    ['Oh my Limbs #horror #scary', '#horror'],
    ['the rake creepypasta', 'creepypasta'],
    ['Watching FOUND FOOTAGE Until I Scream', 'found footage'],
    ['Top 10 jump scares', 'jump scares'],
    ['When A Horror Movie Gives You Nowhere To Run', 'horror movie']
  ];
  for (const [title, label] of strong) assert.deepEqual(Scoring.findGenreLabel(title, compiled), { label, strong: true }, title);
  const weak = [
    ['Not my dad | horror story animated', 'horror'],
    ['Retail workers, what are your horror stories?', 'horror'],
    ['Walmart Employee Horror Story! #shorts', 'horror'],
    ['Retail HORROR Stories #horrorstories', 'horror'],
    ["I think it's safe to swim here #nightmare #creepy", '#creepy'],
    ['They Recorded Proof of a Haunting #scary', '#scary'],
    ['3 scary stories to read in the dark', 'scary stories']
  ];
  for (const [title, label] of weak) assert.deepEqual(Scoring.findGenreLabel(title, compiled), { label, strong: false }, title);
  const no = [
    'Easy pasta recipe in 10 minutes',
    'Horrible bosses: the best scenes',
    'Halloween costumes for kids 2026',
    'The creepy crawlies of the Amazon rainforest',
    'Spooky season haul'
  ];
  for (const title of no) assert.equal(Scoring.findGenreLabel(title, compiled), null, title);
});

test('a strong self-label blurs at once, like a definite title', () => {
  const r = asCard('Hotel Visitor - Horror Short');
  assert.equal(r.band, BANDS.DEFINITE_HORROR);
  assert.equal(r.selfLabel, true);
  assert.equal(r.selfLabelStrong, true);
  assert.ok(r.confidence >= MEDIUM);
});

test('a weak self-label blurs unless the picture vetoes it', () => {
  const r = asCard('Walmart Employee Horror Story! #shorts');
  assert.equal(r.band, BANDS.AMBIGUOUS);
  assert.equal(r.selfLabel, true);
  assert.equal(r.selfLabelStrong, false);
  assert.equal(r.isHorrorTextOnly, true);
  assert.equal(r.requiresPositiveImage, false);
  assert.equal(Bridge.combineVerdict(r, 55).isHorror, true, 'a middling picture keeps the blur');
  assert.equal(Bridge.combineVerdict(r, 41).isHorror, true);
  assert.equal(Bridge.combineVerdict(r, 40).isHorror, false, 'a clearly harmless picture vetoes it');
  assert.equal(Bridge.combineVerdict(r, null).isHorror, true, 'no picture verdict is not a veto');
});

test('the self-label needs the option: plain pages are unchanged', () => {
  const r = analyze('Hotel Visitor - Horror Short');
  assert.equal(r.selfLabel, false);
  assert.equal(r.band, BANDS.LIKELY_SAFE, 'one keyword (30) on the general web stays text-gated');
});

test('definite titles stay definite', () => {
  const r = asCard('A Nightmare on Elm Street official horror trailer');
  assert.equal(r.band, BANDS.DEFINITE_HORROR);
});

test('any horror text on a video or ad card goes to the classifier', () => {
  const title = 'Ghost hunting in an abandoned school at night';
  const zombie = analyze(title, { scanAnyText: true, selfLabelText: title });
  assert.equal(zombie.selfLabel, false);
  assert.ok(zombie.confidence > 0 && zombie.confidence < 40, `score ${zombie.confidence}`);
  assert.equal(zombie.band, BANDS.AMBIGUOUS);
  assert.equal(zombie.isHorrorTextOnly, false);
  // Neutral page: needs the block bar; a horror page lowers it.
  assert.equal(Bridge.combineVerdict(zombie, 70).isHorror, false);
  assert.equal(Bridge.combineVerdict(zombie, 76).isHorror, true);
  assert.equal(Bridge.combineVerdict(zombie, 66, { pageHasHorrorSignal: true }).isHorror, true);
  assert.equal(Bridge.combineVerdict(zombie, null).isHorror, false, 'weak text never blocks unverified');

  const quiet = analyze('Easy pasta recipe', { scanAnyText: true });
  assert.equal(quiet.band, BANDS.LIKELY_SAFE, 'no horror text at all: still nothing to check');
});

test('secondary text is weak: horror-page bar, never a block alone', () => {
  const textResult = { ...analyze('Do You See Her?', { scanAnyText: true }), secondaryOnly: true, band: BANDS.AMBIGUOUS };
  assert.equal(textResult.isHorrorTextOnly, false);
  assert.equal(Bridge.combineVerdict(textResult, 64).isHorror, false);
  assert.equal(Bridge.combineVerdict(textResult, 65).isHorror, true);
  assert.equal(Bridge.combineVerdict(textResult, null).isHorror, false);
});

test('a label inside a safe title does not count', () => {
  const safe = db.safeTitles.find(t => /horror/i.test(t));
  if (!safe) return; // nothing to check against in this database
  assert.equal(Scoring.findGenreLabel(safe, compiled), null, safe);
});
