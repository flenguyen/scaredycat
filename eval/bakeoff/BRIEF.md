# Model bake-off: replace MobileCLIP-S0 in Scaredy Cat

You're working in the Scaredy Cat repo (Chrome MV3 extension, see `CLAUDE.md`). Your job is to find a replacement for the bundled image model, pick a winner with evidence, and write it up. **Don't swap the shipped model.** That's a Level 1 release and the user decides.

## Why

The extension ships `Xenova/mobileclip_s0` (fp16 vision tower, 23 MB, `models/`). Apple licenses those weights under `apple-amlr`, which is research-only and excludes "use in any commercial product or service." The extension is about to go on the Chrome Web Store with a tip link, so the weights have to go. MobileCLIP2, DFN and any other Apple ML-research checkpoint have the same licence.

## Hard requirements (a candidate that fails any of these is out)

1. **Free and commercial-use OK.** The weights licence must explicitly allow commercial use and redistribution: MIT, Apache-2.0, BSD or similar. Check the licence yourself on the primary source: the upstream repo `LICENSE` *and* the Hugging Face model card. A converted copy (Xenova/, onnx-community/) inherits the upstream licence, whatever its own tag says. Reject anything that's NC, research-only, "other" with no text, or unclear. Known traps: Apple MobileCLIP/MobileCLIP2/DFN/AIMv2 (`apple-amlr`), MetaCLIP (CC-BY-NC), jina-clip-v2 (CC-BY-NC). Record the exact licence name, a quoted line and the URL for every candidate.
2. **Local.** Inference runs entirely on-device in the existing pipeline: transformers.js 4.x plus onnxruntime-web 1.31 (JSPI WASM build, `vendor/`) in the offscreen document. No network at inference, no cloud APIs and no paid services (Vercel Pro is the only paid thing this project has).
3. **Small footprint.** Only the **vision tower** ships. Prompt text embeddings are precomputed (`eval/precompute-prompts.mjs`), so text-tower size doesn't count.
   - Shipped model file: **≤ 50 MB hard cap**, ≤ 25 MB preferred (current: 23 MB).
   - Cold in-browser verdict p50 on WASM: ≤ 250 ms (current ~150 ms, `npm run latency`).
   - A model over the cap may still be run once as a **quality ceiling reference**. Label it that way in the report and never present it as a shipping option.
4. **Runs in our stack.** It must export to ONNX with ops onnxruntime-web WASM supports, load through transformers.js, and keep its scores at fp16 (max |Δ| vs fp32 ≤ 2 points on the 0–100 scale, the same bar `eval/fp16-compare.mjs` used). Don't trust q8/int8 without measuring it: MobileCLIP's q8 was badly broken.

## Candidates

Verify each licence before spending compute on it. You may add others that meet the requirements, but explain why.

| Candidate | Expected licence | Approach |
|---|---|---|
| TinyCLIP ViT-8M/16 Text-3M YFCC15M (`onnx-community/...-ONNX` exists) | MIT | Zero-shot prompts |
| TinyCLIP ViT-45M/32 Text-18M auto LAION+YFCC (needs ONNX export) | MIT | Zero-shot prompts; check fp16 size against the cap |
| TinyCLIP ViT-40M/32 Text-19M LAION-400M | MIT | Zero-shot; same size check |
| DINOv2-small (`facebook/dinov2-small`, 21M params) | Apache-2.0 | Image embedding + trained linear head (no text tower) |
| MobileNetV3 / EfficientNet-Lite class backbone | Apache/BSD | Embedding + trained linear head; the smallest option |
| OpenAI CLIP ViT-B/32 or LAION/DataComp ViT-B-32 | MIT | **Ceiling reference only** (~175 MB fp16) |
| MobileCLIP-S0 (current) | apple-amlr | **Baseline only**, never a candidate |

For every CLIP-family candidate, run **both** zero-shot with the prompt ensemble **and** a trained linear head (logistic regression on the image embedding). On a single yes/no task, the head often closes most of the gap between a small model and a big one.

## Step 1: build a real labelled image set (nothing like it is committed yet)

`eval/corpus.json` has no image entries, and the bars in `content/ml-bridge.js` were tuned on a handful of posters that aren't saved anywhere (named in `eval/verdict-corpus.json`'s description). Build one before comparing anything.

- Commit a **manifest only**: `eval/bakeoff/images.json` with `{id, label: "horror"|"safe", group, source, url, split}`. Cache image files in a gitignored directory (`eval/bakeoff/.cache/`). Never commit image files, which are copyrighted posters.
- Sources: Wikipedia REST summary thumbnails (pattern in `eval/ab-test.mjs`; keep the polite User-Agent and the delays) and Wikimedia Commons. **Don't use TMDB images or data in the set.** TMDB's API terms forbid "training or validating a machine learning or artificial intelligence system" with TMDB content.
- Target at least **300 horror and 500 safe** images. The safe set must be weighted towards **hard negatives**, because those are what cause wrong blurs. Tag each image with a `group`:
  - **Horror:** classic posters, modern minimalist posters (these scored 0–64 on MobileCLIP and are the known weak spot), trailer stills and YouTube-style thumbnails, creature/gore, possession/ghost, slasher. Also include the named calibration posters (Hereditary, The Nun, Insidious).
  - **Hard safe:** dark thrillers (Cape Fear), action/fantasy (Mortal Kombat, White House Down), crime/true crime, sci-fi, war, video game key art, family Halloween (pumpkins, costumes), dark-palette dramas, Devil Wears Prada and other short-title collision cases.
  - **Easy safe:** everyday photos, UI screenshots, logos, food, products, people, children's cartoons.
- Split it **60% train / 20% val / 20% test**, stratified by group, with a fixed seed. Never put two images of the same film in different splits. Prompt tuning, head training and threshold picking use train/val only. **Test is touched once per finalist**, at the end.

## Step 2: generalise the harness without touching shipped files

- Work under `eval/bakeoff/`. Parameterise `eval/image-classifier.mjs` and `eval/precompute-prompts.mjs` (or write bake-off copies) by model ID, dtype and output path. Keep `MODEL_ID` in `eval/setup-model.mjs` and the shipped behaviour unchanged.
- **Don't modify** `models/`, `vendor/`, `data/prompt-embeddings.*`, `offscreen/`, `content/ml-bridge.js` or `manifest.json`.
- Download weights into a gitignored dev cache (like `eval/.model-cache/`), pin each Hugging Face revision, and record its sha256 (pattern in `setup-model.mjs`).
- Node only: onnxruntime-node with `session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }` and `process.exit(0)` at the end. The fixed 77-token text input applies to CLIP text towers.
- Zero-shot scoring must use the same maths as `scoreEmbedding` in `eval/image-classifier.mjs` (cosine against the prompt ensemble, softmax at the model's logit scale, summed horror probability × 100). You may retune `PROMPTS` per model on train/val, and keep the final prompt list for each model.

## Step 3: measure

For each candidate × {zero-shot, linear head} × {fp32, fp16}:

- **Ranking quality:** ROC-AUC and PR-AUC on the full set and per group.
- **The bars the extension actually uses:** pick thresholds on val that reproduce the current operating points, then report test results at them.
  - **Image-only block:** horror recall when the false-blur rate on *hard safe* is ≤ 2% (MobileCLIP's equivalent bar is 80).
  - **Horror-page block:** recall at hard-safe false-blur ≤ 5% (bar 65).
  - **Veto:** what share of short-title collision safe posters fall below the veto line, while moody horror (Nun-class) stays above it (bar 40).
- **Weak spots:** recall on the modern-minimalist horror group and false blurs on dark thrillers, action and family Halloween, reported separately.
- **Footprint:** shipped file size at each dtype (raw and zip-compressed, as `npm run pack:check` counts it), parameters and peak RSS.
- **Speed:** Node CPU ms per image (p50/p95) on a 50-image subset.
- **fp16 vs fp32:** max and p95 |Δ| score.

Then, for the **top two** shipping-eligible candidates only, run a browser check:
1. Load each one into a throwaway copy of the extension (a git worktree or a temp directory, never the real `models/`) in Chrome for Testing (`SC_CHROME_BIN`; see `eval/fp16-compare.mjs` and `eval/browser-latency.mjs`).
2. Confirm it loads on the JSPI WASM build, and on WebGPU where available.
3. Confirm its scores match Node within 2 points, and record its cold and warm verdict latency.

## Step 4: report and recommend

Write `eval/bakeoff/REPORT.md`, plus a `results.json` holding the raw numbers. Include:

1. A **licence table** for every candidate considered, including rejected ones, with quote and URL.
2. A **results table** with MobileCLIP-S0 as the baseline row and the ceiling reference marked.
3. Per-group failure examples for each finalist: image ID and score. No images embedded.
4. A **recommendation**: the winner, dtype, approach (zero-shot or head), proposed new values for the five constants in `content/ml-bridge.js` (`IMAGE_BLOCK_SCORE`, `IMAGE_BLOCK_SCORE_HORROR_PAGE`, `IMAGE_ONLY_BLOCK_SCORE`, `IMAGE_VETO_SCORE`, `UNVERIFIED_BLOCK_SCORE` if it changes), and the zip size it would produce.
5. **What else changes if it ships:**
   - Re-record the `imageScore` values in `eval/verdict-corpus.json`.
   - Update `MODEL_VERSION` in `background/feedback.js` and `background/ml-router.js`.
   - Change `eval/setup-model.mjs`.
   - Update `vendor/CHECKSUMS.sha256` and the pack rules in `scripts/pack.mjs`.
   - Add the attribution in `THIRD_PARTY_NOTICES`.
   - If a head is used, ship its weights file and add its loading code.
   - Add a Level 1 release note draft for the user to approve (follow "Writing the notes" in `CLAUDE.md`).
6. **The decision rule.** Recommend a candidate only if, on test, it is shipping-eligible **and** meets both conditions:
   - **(a)** It beats or matches MobileCLIP's image-only recall within 3 points at equal hard-safe false-blur rate.
   - **(b)** It doesn't regress minimalist-horror recall by more than 5 points.

   If nothing passes, say so plainly, name the closest option and say what it would need (more labelled data, a bigger head, a different backbone).

## Ground rules

- Read `CLAUDE.md` and the memory notes first. `eval/` and `*.md` never ship (`scripts/pack.mjs` excludes them).
- Commits from this work are tooling only: put `[no-release]` in the message. Don't push. Don't tag.
- Run the existing `npm run eval` at the end to prove nothing shipped has changed.
- If a requirement can't be met as written (e.g. no candidate fits under 50 MB at fp16), stop and report it. Don't loosen the bar yourself.
