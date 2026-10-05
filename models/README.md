# The image model

This folder holds the one image model the extension ships. `image-model.json` says which
model it is and how to use it; the files it lists live in `models/<dir>/`. This README is
the runbook for changing it. It never ships (`scripts/pack.mjs` skips it).

## What is here

| File | Role |
|---|---|
| `image-model.json` | The single source of truth: model directory, `version`, `dtype`, decode view, scorer, calibration knots, source and licence, and the list of shipped files. Written by `eval/bakeoff/promote.mjs`. |
| `<dir>/config.json`, `<dir>/preprocessor_config.json` | Read by transformers.js. |
| `<dir>/onnx/vision_model_fp16.onnx` | The vision tower (Git LFS). Exactly one ships. |
| `<dir>/head.json` | Scorer `head`: `score = 100 * sigmoid(w . e + b)` on the L2-normalised image embedding. |
| `<dir>/prompt-embeddings.{json,bin}` | Scorer `zero-shot` only: prompt ensemble embeddings. |

Other places that follow the manifest:

- `background/model-info.js` (generated): the id and version, read synchronously by the
  service worker for the verdict cache and feedback reports.
- `vendor/CHECKSUMS.sha256`: the sha256 of the manifest and every file it lists.
  `npm run pack` and `npm run setup:model -- --verify` refuse a mismatch.
- `eval/model-manifest-test.mjs` (in `npm run eval`): schema, monotone knots, files,
  checksums, model-info.js and the ordering of the `ml-bridge.js` bars.

## The calibrated scale

`offscreen/classifier.js` maps each model's raw score through the manifest's
piecewise-linear `calibration.knots` before it returns it. The knots put each of the
model's raw bars, picked on the bake-off's validation images, on `content/ml-bridge.js`'s
fixed bars:

| `ml-bridge.js` bar | Calibrated | How the raw bar is picked (validation set) |
|---|---|---|
| `IMAGE_VETO_SCORE` | 40 | Lowest line that still vetoes at least 15 of 16 short-title collision posters (benefit-matched) |
| `IMAGE_BLOCK_SCORE_GENRE_LISTING` | 41 | Veto + 1 on the calibrated scale (no raw pick) |
| `IMAGE_BLOCK_SCORE_HORROR_PAGE` | 65 | At most 5% hard-safe false blur |
| `IMAGE_BLOCK_SCORE` | 76 | At most 5 of 192 hard-safe images |
| `IMAGE_ONLY_BLOCK_SCORE` | 80 | At most 2% hard-safe false blur |

The mapping is monotone, so a verdict at each of those bars is exactly the verdict the
raw bar would give. Because of this the `ml-bridge.js` constants, the synthetic points in
`eval/verdict-corpus.json`, the combined-eval gates, the "Image classifier: N%" reason
text and the `imageScore` in feedback reports all keep their meaning when the model
changes. The genre-listing bar has no raw pick of its own: calibrated 41 lands just
above the veto (raw 35.14 for the current model).

`version` keys the verdict cache and is sent in feedback reports. `promote.mjs` changes it
whenever the files or the knots change, so scores cached for an old model are never reused.

## Node is not authoritative

`eval/image-classifier.mjs` scores images in Node, but its decode and resampling differ
from the extension's canvas path. Scores differed by up to 72 points for TinyCLIP in the
bake-off (`eval/bakeoff/REPORT.md`, "Methodology problems found"). Every bar, head and
`imageScore` must come from in-browser embeddings: `eval/bakeoff/browser-embed.mjs` drives
the real offscreen classifier over CDP.

## Swapping the model

1. **Bake-off.** Measure the candidate in `eval/bakeoff/` (brief:
   `eval/bakeoff/BRIEF.md`). The licence must allow commercial use; record it in
   `candidates.json` with role `candidate`. Export the vision tower with
   `eval/bakeoff/export.py`, embed every image in Chrome with `browser-embed.mjs`, then
   let `analyze.py --source browser` train the head and pick the bars on validation
   only. The config must end up in `finalists.json`, with its veto in `pretest.json`.
   q8 is not usable (it broke every model with a head).
2. **Promote.** Check the plan, then run it:

   ```bash
   node eval/bakeoff/promote.mjs --config "<model>|<head|zero-shot>|<fp16|fp32>|<crop|squash>" --dry-run
   node eval/bakeoff/promote.mjs --config "<model>|<head|zero-shot>|<fp16|fp32>|<crop|squash>"
   git add .gitattributes models/ background/model-info.js vendor/CHECKSUMS.sha256
   git lfs ls-files     # must list the new .onnx file
   ```

   It copies the files from `eval/.model-cache/bakeoff/<model>/` (and the head from
   `eval/bakeoff/heads/`), writes the knots, `image-model.json`, `background/model-info.js`
   and the `models/` lines of `vendor/CHECKSUMS.sha256`, and removes the old model
   directory with `git rm`. Never edit those files by hand; rerun the script.
3. **Check.** `npm run model:check` runs `setup:model --verify`, the browser parity
   check (`eval/bakeoff/browser-check.mjs`: the unpacked extension scores 243 bake-off
   images on WASM and WebGPU, and its calibrated scores must be within 2 points of the
   bake-off's in-browser embeddings x head x knots) and `pack --check`. Then run
   `npm run eval`, `npm run smoke` and `npm run latency` (`SC_CHROME_BIN` set).
4. **Verdict corpus.** Re-record the measured posters' `imageScore` in
   `eval/verdict-corpus.json` as calibrated in-browser scores (from
   `eval/bakeoff/.cache/emb-browser/<model>-<view>-wasm.*` x head x knots), update its
   description, and run `npm run eval:combined`. Report any gate that changes and why;
   never flip an expectation just to make it pass.
5. **Notices.** Put the model's licence notice in `THIRD_PARTY_NOTICES` and drop the old
   one.
6. **Release.** A new image model is a detection rebuild: Level 1 in CLAUDE.md
   "Releases" (trigger 6). Stop and ask the user, then bump the version and add the
   `data/releases.json` note in the same commit.

The decode view must match how the head was trained. `crop` is the extension's decode
(256 short edge, centre 256 crop, then the model's processor); `squash` resizes the whole
image to the model's input square. Both are in `offscreen/classifier.js`.

## Git LFS

`models/**/*.onnx` is stored in Git LFS (`.gitattributes`). End users get the real file
inside the packed zip; only people who clone the repo need LFS:

```bash
git lfs install      # once per machine
git lfs pull         # after a clone made without LFS
```

Without it the `.onnx` file is a ~130-byte pointer. The extension then cannot load the
model (image checks stay off), and `npm run pack`, `setup:model --verify` and
`npm run eval` fail with "run git lfs pull".

The ONNX export is ours (the upstream repository has safetensors only), so the LFS copy
is the source of truth. To rebuild it from the pinned weights:
`node eval/bakeoff/fetch-models.mjs <model>` then
`eval/bakeoff/.cache/venv/bin/python eval/bakeoff/export.py <model>`, and compare the
sha256s with `vendor/CHECKSUMS.sha256`.
