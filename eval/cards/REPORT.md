# Card eval: trailers, videos, Shorts and ads (October 2026)

## Why

After 2.0.0, horror search results on YouTube were mostly left unblurred. That included horror shorts, analog horror, Shorts shelves and a sponsored "Other Mommy" trailer. Most misses happened before the image model was asked:

- A title whose only signal was "horror" (score 30) was marked likely safe and never classified.
- Shorts and some ads had no card selector, so their titles were never read.
- The extension never ran inside frames, so embedded players and ad iframes were never seen.

These gaps are not specific to YouTube. The fix is a site-agnostic card layer (`content/cards.js`), with site adapters as optional overrides (`content/site-adapters.js`).

## Corpus

| Item | Value |
|---|---|
| Pages captured live | 19, on 2026-10-05 |
| Sites | YouTube (12 searches), Vimeo, Dailymotion (2), Rotten Tomatoes, Bloody Disgusting, IGN, Collider |
| Cards | 494 |
| Labels | 275 horror, 216 safe, 3 skip |
| Left out | 16 Vimeo cards that never render in the stripped replay page (same on both runs) |

- **Pages:**
  - Horror pages: YouTube searches for horror, horror short film, analog horror, creepypasta, horror trailer 2026 and found footage horror.
  - Hard negatives: halloween costumes kids, true crime documentary, thriller trailer 2026, retail horror stories, pasta recipes and action trailers.
  - IMDb and a second Vimeo search are behind bot walls for automated visits, so they aren't in the corpus.
- **Labels** are in `corpus.json`. Borderline calls carry a note.
  - A card is horror when its picture or its title shows horror-genre content that someone frightened of horror would want hidden.
  - True crime with no horror imagery, kids' costumes and retail "horror stories" anecdotes are safe.

The captured pages and pictures stay local in `.cache/` and are not committed.

## Results

Replay of the frozen pages through the real extension, at medium sensitivity, with model `tinyclip40m-fp16-head-v1`.

| | Before (2.0.0) | After (2.1.0) |
|---|---|---|
| Horror cards blurred | 81/259 (31.3%) | 210/259 (81.1%) |
| Safe cards blurred | 2/216 (0.9%) | 5/216 (2.3%) |
| YouTube horror blurred | 33/158 (20.9%) | 135/158 (85.4%) |
| Shorts | 17/66 (25.8%) | 60/66 (90.9%) |
| Ads | 5/7 (71.4%) | 7/7 (100%) |
| Dailymotion | 18/41 (43.9%) | 36/41 (87.8%) |
| Self-labelled horror (title names the genre) | n/a | 162/172 (94.2%) |
| Strong self-labels ("horror short", "analog horror", "#horror") | n/a | 146/146 |
| Safe cards with a self-label blurred | n/a | 1/13 |
| Cards sent to the image classifier | 329 | 250 |

**The 3 new false blurs:**
- Two true-crime documentaries. Their descriptions mention murder, and their pictures score 80 or more.
- One "Retail workers, what are your horror stories?" video. It is a weak label and its picture scores 40.7, just over the veto line.

## The image model on these pictures

With the classifier score alone, on labelled cards:

| Bar | Horror recall | False blur |
|---|---|---|
| 41 | 59.5% | 8.8% |
| 65 | 34.4% | 3.7% |
| 76 | 27.0% | 3.2% |
| 80 | 21.2% | 1.4% |

- 39.8% of horror thumbnails score at or below the veto line (40).
- On posters, the model reaches 65.6% at the horror-page bar (bake-off test set). Video thumbnails and Shorts frames are much harder for it. They are dark, full of text overlays and often animated.
- This is why strong genre labels blur without waiting for the picture.
- What's still missed is mostly cards with no horror words at all (trailers titled only "BREEDER Official Trailer (2026)") and weak-label cards whose picture vetoes them.
- **Next step, if wanted:** retrain the head with YouTube thumbnails and Shorts frames added to the bake-off set. That is a Level 1 decision (trigger 6).

## Cost of running in frames

The content scripts now run in all frames. Measured live on ad-heavy pages, 2 rounds each:

| Page | Frames | Total renderer CPU before | After |
|---|---|---|---|
| collider.com | ~1,100 | 43.5 s / 46.0 s | 44.1 s / 47.0 s |

- Top-frame script time didn't rise on any page.
- Frames smaller than 120x90 don't start at all.

## How to run

```
SC_CHROME_BIN=<chrome-for-testing> node eval/cards/capture.mjs [--only id] [--skip-existing]   # live pages -> .cache
node eval/cards/sheets.mjs [--unlabelled]                                                       # contact sheets for labelling
SC_CHROME_BIN=... node eval/cards/replay.mjs --name after [--root <other checkout>]             # verdicts + image scores
node eval/cards/report.mjs --name after --vs before [--misses] [--false-blurs]
```

For the baseline, replay a `git worktree` of the previous release with `--root`.
