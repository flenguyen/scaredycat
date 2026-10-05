# Model bake-off: replacing MobileCLIP-S0

Date: 2026-10-05. Brief: `eval/MODEL_BAKEOFF_PROMPT.md`. Progress log and every decision: `eval/bakeoff/PROGRESS.md`. Raw numbers: `eval/bakeoff/results.json`. Nothing that ships has changed.

## Summary

- The shipped image model, MobileCLIP-S0, is licensed for research only (Apple `apple-amlr`), so it cannot go in the Chrome Web Store build.
- Eleven licence entries were checked. Seven models were measured on 1,981 labelled images (610 horror, 1,002 hard safe, 369 easy safe). The two finalists and the baseline were then measured inside Chrome through the extension's real decode path, because the Node harness turned out not to reproduce the extension (see "Methodology problems found").
- **Decision rule: no finalist passes on test as the rule was applied here (both comparisons required). Read at equal false-blur rates only, as the brief words it, TinyCLIP-40M passes from 1.4% to 2.9% false blur; see the coordinator note in section 5.** The closest option is TinyCLIP ViT-40M/32 (LAION-400M) with a linear head. It passes (b), the minimalist-horror condition, by a wide margin. It fails (a) at its val-picked image-only bar: it blurs 36.8% of test horror there against the baseline's 44.0% (7.2 points down, 95% CI from 17.2 down to 2.4 up). At the same test false-blur rate as the baseline it blurs 63.2% against 44.0% (19.2 points up, CI from 33.1 down to 36.9 up). It ranks horror above safe images better than the baseline (test AUC 0.938 against 0.900; paired difference +0.038, CI +0.006 to +0.072).
- **Closest option, if the user accepts the image-only gap:** TinyCLIP-40M, fp16 vision tower, linear head, `crop` view (the decode the extension uses today). Proposed constants: `IMAGE_ONLY_BLOCK_SCORE` 52.39, `IMAGE_BLOCK_SCORE` 49.99, `IMAGE_BLOCK_SCORE_HORROR_PAGE` 45.83, `IMAGE_VETO_SCORE` 34.69, `IMAGE_BLOCK_SCORE_GENRE_LISTING` 35.69 (veto + 1, unchanged formula), `UNVERIFIED_BLOCK_SCORE` 80 (unchanged). Package zip 78.46 MB, against 26.00 MB today. This needs the user's raised size cap of about 85 MB.
- **Alternative within the original 50 MB cap:** TinyCLIP ViT-8M/16 head with the `squash` view (20.25 MB zip). It fails both (a) and (b) on test.
- Nothing changes for privacy: inference stays on the device, and no new data leaves it. A swap is a Level 1 release (detection rebuild), so the user decides. A release-note draft is at the end.

## 1. Licences

Every candidate considered, including rejected ones. Licences were read on the Hugging Face model card and API at a pinned revision and on the upstream repository's LICENSE (`candidates.json` has the full record and revisions).

| Candidate | Licence | Quoted line | URL | Outcome |
|---|---|---|---|---|
| TinyCLIP ViT-8M/16 Text-3M YFCC15M (`wkcn/...`, rev a2a8c6e) | MIT | HF card header `license: mit`; LICENSE: "MIT License / Copyright (c) Microsoft Corporation." | https://huggingface.co/wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M, https://github.com/microsoft/Cream/blob/main/TinyCLIP/LICENSE | Candidate. Finalist (head, squash view). |
| TinyCLIP ViT-8M/16 ONNX copy (`onnx-community/...`, rev 9463a9c) | MIT (inherited) | HF card header `license: mit`, links the Cream MIT LICENSE | https://huggingface.co/onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX | Same weights. Not used: one combined graph with both towers, so it cannot load as a vision model alone. We exported our own. |
| TinyCLIP ViT-40M/32 Text-19M LAION-400M (`wkcn/...`, rev 95ec819) | MIT | HF card header `license: mit`; card links the Cream MIT LICENSE | https://huggingface.co/wkcn/TinyCLIP-ViT-40M-32-Text-19M-LAION400M, https://github.com/microsoft/Cream/blob/main/TinyCLIP/LICENSE | Ceiling reference under the 50 MB cap; candidate after the user raised the cap to about 85 MB. Finalist (head, crop view). |
| TinyCLIP ResNet-19M Text-19M LAION-400M | No statement for the weights file | "wkcn/TinyCLIP-model-zoo GitHub API license=null, repo has only README.md and figure/, README has no licence text." | https://github.com/wkcn/TinyCLIP-model-zoo | **Rejected**: licence unclear. The user kept it rejected. |
| TinyCLIP-auto ViT-45M/32 Text-18M LAION+YFCC | No statement for the weights file | Same model-zoo repository, no licence | https://github.com/wkcn/TinyCLIP-model-zoo | **Rejected**: licence unclear (also about 90 MB at fp16). |
| DINOv2-small (`facebook/dinov2-small`, rev ed25f3a) | Apache-2.0 | README: "DINOv2 code and model weights are released under the Apache License 2.0." | https://huggingface.co/facebook/dinov2-small, https://github.com/facebookresearch/dinov2#license | Candidate. Out in the browser check: 270 ms per image on WASM (bar 250) and runtime score gaps of 3.0 (WASM) and 3.9 (WebGPU) points. |
| MobileNetV3-Large (`timm/mobilenetv3_large_100.ra_in1k`, rev 96f46a1) | Apache-2.0 | HF card header `license: apache-2.0`; timm LICENSE "Apache License Version 2.0, January 2004" | https://huggingface.co/timm/mobilenetv3_large_100.ra_in1k | Candidate. Too weak on val (recall 21% at the image-only bar). Caveat: trained on ImageNet-1k, whose own terms are non-commercial. |
| EfficientNet-Lite0 (`timm/tf_efficientnet_lite0.in1k`, rev e074755) | Apache-2.0 | HF card header `license: apache-2.0`; timm LICENSE as above | https://huggingface.co/timm/tf_efficientnet_lite0.in1k | Candidate. Too weak on val (17%). Same ImageNet-1k caveat. |
| OpenAI CLIP ViT-B/32 (`openai/clip-vit-base-patch32`, rev 3d74acf) | MIT (code repository); no tag on the HF model | openai/CLIP LICENSE: "MIT License / Copyright (c) 2021 OpenAI". The HF card says "The model is intended as a research output for research communities." | https://github.com/openai/CLIP/blob/main/LICENSE, https://huggingface.co/openai/clip-vit-base-patch32 | **Ceiling reference only** (176 MB at fp16). Never a shipping option. |
| MobileCLIP-S0 (`Xenova/mobileclip_s0`, rev 757d59c) | apple-amlr | "This Apple Machine Learning Research Model is specifically developed and released by Apple Inc. ("Apple") for the sole purpose of scientific research..." and "Research Purposes means non-commercial scientific research" | https://huggingface.co/apple/MobileCLIP-S0/raw/main/LICENSE | **Baseline only.** The reason for this work. |

Not evaluated, per the brief's list of known licence traps: MobileCLIP2, DFN and AIMv2 (apple-amlr), MetaCLIP and jina-clip-v2 (CC-BY-NC).

## 2. How it was measured

- **Image set** (`images.json`, manifest only, no images committed): Wikipedia thumbnails, Wikimedia Commons and YouTube trailer thumbnails found through Wikidata. No TMDB data. 7 horror groups, 10 hard-safe groups and 7 easy-safe groups, labelled by film genre, then checked by eye on contact sheets. Split by film (no film in two splits) 60/20/20: train 1,192, val 387, test 402.
- **Pipeline that counts:** in-browser embeddings (Chrome for Testing 149, the extension's own decode, fp16, WASM) for every image and both views: `crop` (today's decode: 256-pixel short edge, centre 256 crop, then the model's processor) and `squash` (the whole image resized to the model input; needs `ship-patch/classifier-squash.diff`).
- **Heads:** L2 logistic regression on the train split, `score = 100 * sigmoid(w . e + b)` on the L2-normalised embedding. C chosen by val log-loss among the values whose head keeps the WASM and WebGPU scores within 2 points on 200 parity images.
- **Bars, picked on val only:** image-only = lowest bar with at most 2% hard-safe false blur (3 of 192), horror-page = at most 5%, block = at most 5 of 192 (the baseline's count at 76). Veto: see (a) below.
- **Test was read once** (`analyze.py --source browser --final-test`, logged in `.cache/test-runs.log`) after the pre-test fixes were written to `pretest.json` and PROGRESS.md. Before that, a dry run on val rows relabelled as test reproduced the val numbers exactly. No threshold or config was chosen after seeing test.
- **Confidence intervals:** 2,000 bootstrap resamples of films within (label, group) strata. Differences use paired resamples.

### Pre-test fixes (val only, recorded before test)

**(a) Veto line.** The shipped veto at 40 cancels the blur for 15 of 16 val short-title collision posters (93.75%), but it also cancels it for 41.0% of all val horror (CI 32 to 50) and for 7 of 14 moody horror posters. Phase D2 matched that cost, which copies the flaw. The proposed line is benefit-matched instead: the lowest line that vetoes at least 93.75% of val collision posters.

| Model | Proposed veto (benefit-matched) | Val horror vetoed | Val moody vetoed | Cost-matched line (D2) | Val horror vetoed there |
|---|---|---|---|---|---|
| TinyCLIP-40M head | 34.69 | 14.8% (CI 9 to 22) | 2 of 14 | 45.38 | 41.0% |
| TinyCLIP-8M head | 34.94 | 23.0% (CI 16 to 31) | 2 of 14 | 51.61 | 41.0% |
| MobileCLIP (reference) | its own line would be 17.45 | 23.8% | 5 of 14 | shipped 40 | 41.0% |

The collision group has 16 val images, so this line is set by the 15th-lowest collision score.

**(b) Constant ordering.** `ml-bridge.js` sets `IMAGE_BLOCK_SCORE_GENRE_LISTING = IMAGE_VETO_SCORE + 1`, and the bars must keep veto < genre-listing <= horror-page <= block <= image-only. With the proposed veto, veto + 1 keeps that order for both finalists, so no code change is needed for it:

| Constant | TinyCLIP-40M head (crop) | TinyCLIP-8M head (squash) | Shipped today |
|---|---|---|---|
| `IMAGE_VETO_SCORE` | 34.69 | 34.94 | 40 |
| `IMAGE_BLOCK_SCORE_GENRE_LISTING` | 35.69 (veto + 1) | 35.94 (veto + 1) | 41 |
| `IMAGE_BLOCK_SCORE_HORROR_PAGE` | 45.83 | 62.87 | 65 |
| `IMAGE_BLOCK_SCORE` | 49.99 | 67.32 | 76 |
| `IMAGE_ONLY_BLOCK_SCORE` | 52.39 | 71.27 | 80 |
| `UNVERIFIED_BLOCK_SCORE` | 80 (text only) | 80 | 80 |

Values are used as picked (scores are floats, so there is no need to round). If the user prefers the cost-matched veto for the 40M head (45.38), veto + 1 = 46.38 would sit above the horror-page bar (45.83). In that case `IMAGE_BLOCK_SCORE_GENRE_LISTING` has to be decoupled in `ml-bridge.js` and set to the horror-page bar, 45.83 (the lowest value that keeps the order without making horror listings stricter than horror pages).

**(c) Backend verdict flips.** On the 200 parity images, the number whose verdict changes between WASM and WebGPU (label-free; the 168 non-test images in brackets):

| Config | image-only | block | horror-page | genre-listing | veto | images with any flip | max score gap |
|---|---|---|---|---|---|---|---|
| MobileCLIP at 80 / 76 / 65 / 41 / 40 | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 1 (0) | 1 | 2.95 |
| TinyCLIP-40M at 52.39 / 49.99 / 45.83 / 35.69 / 34.69 | 1 (0) | 2 (1) | 1 (1) | 2 (1) | 2 (1) | 8 | 1.50 |
| TinyCLIP-8M at 71.27 / 67.32 / 62.87 / 35.94 / 34.94 | 2 (1) | 0 (0) | 1 (1) | 3 (2) | 2 (1) | 7 | 1.63 |

The heads have smaller score gaps but more flips, because their bars sit where many images score. The 40M head's block bars are only 7 points apart, so its decisions are more sensitive to small score shifts than the baseline's.

## 3. Results

### Test (one run, 402 images: 125 horror, 207 hard safe, 70 easy safe)

Recall is the share of test horror blurred; hard-safe false blur is the share of the 207 hard-safe images blurred. 95% CIs in brackets.

| config (bars) | AUC [95% CI] | PR-AUC | image-only bar: recall / hard-safe false blur | horror-page bar | block bar | minimalist recall @ image-only / horror-page |
|---|---|---|---|---|---|---|
| TinyCLIP-40M head, crop (52.39 / 45.83 / 49.99) | 0.938 [0.913, 0.960] | 0.871 | 36.8 [29, 45] / 1.4 [0, 3] | 65.6 [57, 74] / 3.4 [1, 6] | 48.0 [39, 57] / 1.9 [0, 4] | 55.0 / 80.0 |
| TinyCLIP-8M head, squash (71.27 / 62.87 / 67.32) | 0.890 [0.859, 0.920] | 0.779 | 31.2 [24, 40] / 2.4 [0, 4] | 43.2 [35, 52] / 3.9 [1, 7] | 36.0 [28, 44] / 2.4 [0, 4] | 25.0 / 30.0 |
| **MobileCLIP-S0 baseline** at its val thresholds (78.07 / 72.69 / 75.33) | 0.900 [0.867, 0.929] | 0.815 | 44.0 [34, 54] / 2.9 [1, 5] | 50.4 [41, 60] / 3.4 [1, 6] | 46.4 [37, 56] / 3.4 [1, 6] | 40.0 / 45.0 |
| **MobileCLIP-S0 baseline** at the shipped bars (80 / 65 / 76) | 0.900 [0.867, 0.929] | 0.815 | 41.6 [32, 51] / 1.9 [0, 4] | 54.4 [45, 64] / 3.9 [1, 6] | 46.4 [37, 56] / 3.4 [1, 6] | 40.0 / 45.0 |

Hard-safe false blurs as counts out of 207 at image-only / horror-page / block: 40M 3 / 7 / 4; 8M 5 / 8 / 5; baseline at val thresholds 6 / 7 / 7; baseline at shipped bars 4 / 8 / 7. Easy-safe false blur is 0 for all three at these bars. The ceiling reference (CLIP ViT-B/32) was never scored on test; its val numbers are in the val table below.

Paired AUC difference against the baseline on test: 40M +0.038 (CI +0.006 to +0.072); 8M -0.010 (CI -0.045 to +0.027).

### Weak spots on test

| config | bar | minimalist recall [CI] | dark-thriller false blur | action-fantasy false blur | family-halloween false blur |
|---|---|---|---|---|---|
| TinyCLIP-40M | image-only 52.39 | 55.0 [35, 75] | 0.0 | 0.0 | 4.8 |
| TinyCLIP-40M | horror-page 45.83 | 80.0 [60, 95] | 3.8 | 0.0 | 4.8 |
| TinyCLIP-40M | block 49.99 | 65.0 [45, 85] | 0.0 | 0.0 | 4.8 |
| TinyCLIP-40M | genre-listing 35.69 | 95.0 [85, 100] | 11.5 | 4.0 | 19.0 |
| TinyCLIP-8M | image-only 71.27 | 25.0 [10, 45] | 0.0 | 0.0 | 4.8 |
| TinyCLIP-8M | horror-page 62.87 | 30.0 [10, 50] | 0.0 | 4.0 | 4.8 |
| TinyCLIP-8M | block 67.32 | 25.0 [10, 45] | 0.0 | 0.0 | 4.8 |
| TinyCLIP-8M | genre-listing 35.94 | 80.0 [60, 95] | 30.8 | 24.0 | 14.3 |
| Baseline (val thresholds) | image-only 78.07 | 40.0 [20, 65] | 0.0 | 0.0 | 19.0 |
| Baseline (val thresholds) | horror-page 72.69 | 45.0 [25, 65] | 0.0 | 0.0 | 19.0 |
| Baseline (val thresholds) | block 75.33 | 40.0 [20, 65] | 0.0 | 0.0 | 19.0 |
| Baseline (shipped) | image-only 80 | 40.0 [20, 65] | 0.0 | 0.0 | 14.3 |
| Baseline (shipped) | horror-page 65 | 45.0 [25, 65] | 0.0 | 0.0 | 23.8 |
| Baseline (shipped) | block 76 | 40.0 [20, 65] | 0.0 | 0.0 | 19.0 |
| Baseline (shipped) | genre-listing 41 | 65.0 [45, 85] | 0.0 | 8.0 | 38.1 |

Group sizes on test: minimalist 20, dark-thriller 26, action-fantasy 25, family-halloween 21. One image is 5 points of minimalist recall and about 4 to 5 points of a hard-safe group's false blur.

### Veto and genre-listing bars on test

| config | line | collision posters vetoed | all horror vetoed [CI] | moody horror vetoed | hard safe vetoed |
|---|---|---|---|---|---|
| TinyCLIP-40M | proposed (benefit-matched) 34.69 | 76.5 | 16.8 [11, 23] | 23.1 | 84.5 |
| TinyCLIP-40M | cost-matched 45.38 | 94.1 | 32.8 [25, 41] | 38.5 | 96.6 |
| TinyCLIP-8M | proposed (benefit-matched) 34.94 | 82.4 | 19.2 [13, 26] | 15.4 | 73.9 |
| TinyCLIP-8M | cost-matched 51.61 | 94.1 | 41.6 [33, 50] | 46.2 | 91.3 |
| Baseline | its own benefit-matched line 17.45 | 76.5 | 19.2 [12, 26] | 15.4 | 77.8 |
| Baseline | shipped 40 | 88.2 | 34.4 [26, 43] | 53.8 | 90.8 |

The benefit-matched lines did not hold their collision share on test (17 collision posters): the 40M line vetoes 13 of 17 against the baseline's 15 of 17 at 40. One of the four it misses is The Devil Wears Prada 2 (35.8, just above 34.69), a named calibration case. In exchange it cancels the blur for about half as much real horror (16.8% against 34.4%).

Genre-listing bar on test: 40M at 35.69 blurs 81.6% of horror (CI 75 to 88) and 95% of minimalist, with 12.6% hard-safe false blur (CI 8 to 17). 8M at 35.94: 79.2%, 80% and 25.1%. Baseline at 41: 64.0%, 65% and 8.7%. This bar only applies on horror-filtered listings and on pages whose metadata says horror.

### Ranking by group on test (AUC / PR-AUC)

Horror groups are scored against all safe images; safe groups against all horror images.

| group (n) | 40M AUC / PR | 8M AUC / PR | baseline AUC / PR |
|---|---|---|---|
| horror:classic (21) | 0.90 / 0.47 | 0.85 / 0.32 | 0.85 / 0.43 |
| horror:minimalist (20) | 0.97 / 0.70 | 0.89 / 0.40 | 0.89 / 0.47 |
| horror:creature-gore (15) | 0.95 / 0.54 | 0.89 / 0.41 | 0.91 / 0.49 |
| horror:possession-ghost (18) | 0.94 / 0.66 | 0.92 / 0.56 | 0.94 / 0.56 |
| horror:slasher (19) | 0.98 / 0.63 | 0.92 / 0.44 | 0.95 / 0.60 |
| horror:trailer-thumb (19) | 0.91 / 0.55 | 0.89 / 0.44 | 0.87 / 0.53 |
| horror:moody (13) | 0.90 / 0.51 | 0.87 / 0.38 | 0.90 / 0.34 |
| hard:dark-thriller (26) | 0.93 / 0.98 | 0.84 / 0.96 | 0.91 / 0.98 |
| hard:action-fantasy (25) | 0.96 / 0.99 | 0.87 / 0.97 | 0.91 / 0.98 |
| hard:crime (21) | 0.93 / 0.99 | 0.91 / 0.98 | 0.88 / 0.98 |
| hard:scifi (17) | 0.94 / 0.99 | 0.85 / 0.97 | 0.89 / 0.98 |
| hard:war (13) | 0.82 / 0.97 | 0.70 / 0.95 | 0.88 / 0.99 |
| hard:game-art (19) | 0.98 / 1.00 | 0.91 / 0.98 | 0.97 / 1.00 |
| hard:family-halloween (21) | 0.90 / 0.97 | 0.90 / 0.97 | 0.75 / 0.93 |
| hard:dark-drama (24) | 0.91 / 0.98 | 0.83 / 0.96 | 0.90 / 0.98 |
| hard:collision (17) | 0.88 / 0.98 | 0.89 / 0.98 | 0.90 / 0.98 |
| hard:trailer-thumb-safe (24) | 0.89 / 0.97 | 0.82 / 0.96 | 0.87 / 0.97 |
| easy:photo (12) | 1.00 / 1.00 | 1.00 / 1.00 | 0.92 / 0.99 |
| easy:ui-screenshot (12) | 1.00 / 1.00 | 1.00 / 1.00 | 0.99 / 1.00 |
| easy:logo (12) | 1.00 / 1.00 | 0.95 / 1.00 | 0.93 / 0.99 |
| easy:food (9) | 1.00 / 1.00 | 1.00 / 1.00 | 0.87 / 0.99 |
| easy:product (7) | 1.00 / 1.00 | 0.99 / 1.00 | 0.98 / 1.00 |
| easy:people (6) | 1.00 / 1.00 | 1.00 / 1.00 | 0.92 / 1.00 |
| easy:kids-cartoon (12) | 1.00 / 1.00 | 0.99 / 1.00 | 0.95 / 0.99 |
| hard (207) | 0.92 / 0.87 | 0.86 / 0.78 | 0.89 / 0.83 |
| easy (70) | 1.00 / 1.00 | 0.99 / 0.99 | 0.94 / 0.96 |

### Val, all configs on the shipping pipeline (phase D2)

Browser WASM unless marked. Val numbers are optimistic: C, prompt variants and bars were all picked on val. "Parity" is the largest WASM against WebGPU score gap on the 200 parity images (bar: 2 points).

| config (model, approach, view) | AUC | recall @ image-only [CI] | minimalist @ image-only / horror-page | parity | MB raw (zip) | eligible |
|---|---|---|---|---|---|---|
| CLIP ViT-B/32 head, Node squash, **ceiling reference** | 0.952 | 63 [54, 72] | 65 / 85 | n/a | 176.0 (162.6) | no: ceiling reference, over 85 MB, Node only |
| MobileCLIP-S0 head, crop | 0.948 | 54 [46, 63] | 65 / 70 | 1.80 | 22.9 (21.1) | no: baseline licence |
| TinyCLIP-40M head, unconstrained C, squash | 0.951 | 47 [37, 56] | 45 / 65 | 4.90 | 79.7 (73.6) | no: parity |
| **TinyCLIP-40M head, crop (finalist)** | 0.937 | 43 [33, 52] | 50 / 70 | 1.50 | 79.7 (73.6) | yes |
| TinyCLIP-40M head, unconstrained C, crop | 0.938 | 41 [32, 50] | 40 / 65 | 4.14 | 79.7 (73.6) | no: parity |
| TinyCLIP-8M head, unconstrained C, crop | 0.886 | 39 [31, 48] | 40 / 55 | 2.66 | 16.8 (15.4) | no: parity |
| TinyCLIP-40M head, squash | 0.940 | 39 [30, 48] | 50 / 70 | 1.28 | 79.7 (73.6) | yes |
| CLIP ViT-B/32 zero-shot, Node squash, **ceiling reference** | 0.906 | 39 [31, 48] | 25 / 55 | n/a | 176.0 (162.6) | no: ceiling reference |
| TinyCLIP-8M head, unconstrained C, squash | 0.895 | 36 [27, 45] | 40 / 60 | 2.14 | 16.8 (15.4) | no: parity |
| **MobileCLIP-S0 zero-shot, crop: baseline, val thresholds** | 0.857 | 34 [25, 43] | 25 / 25 | 2.95 | 22.9 (21.1) | no: baseline licence |
| **MobileCLIP-S0 zero-shot, crop: baseline, shipped bars** | 0.857 | 30 [21, 38] | 25 / 30 | 2.95 | 22.9 (21.1) | no: baseline licence |
| **TinyCLIP-8M head, squash (finalist)** | 0.894 | 33 [24, 41] | 35 / 60 | 1.63 | 16.8 (15.4) | yes |
| TinyCLIP-8M head, crop | 0.885 | 31 [23, 40] | 35 / 55 | 1.80 | 16.8 (15.4) | yes |
| TinyCLIP-40M zero-shot, squash | 0.882 | 29 [21, 37] | 15 / 30 | 3.77 | 79.7 (73.6) | no: parity |
| TinyCLIP-40M zero-shot, crop | 0.878 | 29 [21, 37] | 10 / 30 | 3.29 | 79.7 (73.6) | no: parity |
| TinyCLIP-8M zero-shot, crop | 0.799 | 16 [9, 23] | 5 / 25 | 2.39 | 16.8 (15.4) | no: parity |
| TinyCLIP-8M zero-shot, squash | 0.800 | 8 [3, 13] | 0 / 5 | 2.34 | 16.8 (15.4) | no: parity |

Models dropped before the browser stage (phase D, Node, val, best config each): DINOv2-small head fp16 AUC 0.886, recall 25% (43.5 MB; then out on browser speed and parity); MobileNetV3-Large head fp16 0.833, 21% (8.4 MB); EfficientNet-Lite0 head fp16 0.806, 17% (6.9 MB). Every q8 export failed the precision bar (max score change against fp32 of 21 to 75 points), so q8 was never eligible.

### Footprint and speed

| model | vision params | fp16 file MB raw (deflate) | pack zip MB | Node CPU ms/img p50, fp16 | WASM ms/img p50 (browser) | WebGPU ms/img p50 | cold IMDb first / last verdict ms |
|---|---|---|---|---|---|---|---|
| MobileCLIP-S0 (baseline) | 11.4M | 22.9 (21.1) | 26.00 | 42.3 | 139 | 14 | 1,059 / 1,274 |
| TinyCLIP-40M | 39.7M | 79.7 (73.6) | 78.46 | 21.3 | 89 (crop) | 17 | 629 / 887 |
| TinyCLIP-8M | 8.3M | 16.8 (15.4) | 20.25 | 24.6 | 86 (squash) | 14 | 503 / 731 |
| DINOv2-small | 21.5M | 43.5 (40.1) | 44.93 | 61.4 | 270 | 15 to 22 | 598 / 900 |
| MobileNetV3-Large | 4.2M | 8.4 (7.8) | n/a | 10.5 | n/a | n/a | n/a |
| EfficientNet-Lite0 | 3.4M | 6.9 (6.2) | n/a | 18.4 | n/a | n/a | n/a |
| CLIP ViT-B/32 (ceiling reference) | 87.8M | 176.0 (162.6) | n/a | 45.0 | n/a | n/a | n/a |

Latency pages ran once each on the default backend (WebGPU), so read them as "not slower than today". fp16 against fp32 (Node, same head): max score change 0.08 for the 40M head and 0.19 for the 8M head (bar 2).

Robustness (Node with the view emulated, 200 images, p95 / max score change): JPEG quality 70: baseline 8.6 / 16.2, 40M 4.3 / 6.4, 8M 8.1 / 14.8. Half-size downscale: baseline 19.0 / 37.4, 40M 7.4 / 13.9, 8M 16.7 / 35.0.

## 4. Per-group failure examples (test)

For horror groups, the five lowest-scoring images (missed horror). For safe groups, the five highest-scoring images (likely false blurs). Image id, film title, score. Commons images (`cm-`) are listed by id only.

#### TinyCLIP-40M head (crop)

| group | 5 worst (image id, title, score) |
|---|---|
| classic | `wp-Q19405` The Ninth Gate 24.3; `wp-Q46637` Maximum Overdrive 24.5; `wp-Q1199837` Jaws 3-D 27.1; `wp-Q133488` Kwaidan 29.5; `wp-Q431873` The Wolf Man 32.6 |
| minimalist | `wp-Q27492140` The Killing of a Sacred Deer 26.1; `wp-Q111655610` Enys Men 38.9; `wp-Q87519760` Relic 42.1; `wp-Q106371709` Lamb 42.7; `wp-Q121367826` When Evil Lurks 47.4 |
| creature-gore | `wp-Q284042` Resident Evil: Degeneration 29.1; `wp-Q155163` Alien vs. Predator 34.2; `wp-Q58879016` Zombieland: Double Tap 34.8; `wp-Q1537343` Re-Animator 40.7; `wp-Q505712` Gremlins 2: The New Batch 44.1 |
| possession-ghost | `wp-Q320384` Beetlejuice 23.2; `wp-Q124841936` The Monkey 31.4; `wp-Q570481` What Lies Beneath 34.2; `wp-Q23823461` Personal Shopper 36.2; `wp-Q666082` The Innocents 38.6 |
| slasher | `wp-Q672248` I'll Always Know What You Did Last Summer 35.7; `wp-Q1089281` Child's Play 2 37.8; `wp-Q691788` House of 1000 Corpses 42.3; `wp-Q208592` Sleepy Hollow 44.1; `wp-Q1145824` A Nightmare on Elm Street 2 48.4 |
| trailer-thumb | `yt-Q224647` The Devil's Advocate 17.1; `yt-Q921510` Dorian Gray 23.8; `yt-Q680989` Underworld: Awakening 28.1; `yt-Q58879016` Zombieland: Double Tap 28.6; `yt-Q208592` Sleepy Hollow 36.9 |
| moody | `wp-Q134480207` Exit 8 17.3; `wp-Q846088` I Know Who Killed Me 25.9; `wp-Q680989` Underworld: Awakening 32.2; `wp-Q652592` The Invasion 35.1; `wp-Q587707` Abraham Lincoln: Vampire Hunter 41.5 |
| dark-thriller | `wp-Q74958` Blood Diamond 47.3; `wp-Q18225084` The Hateful Eight 39.6; `wp-Q42198` Heat 38.2; `wp-Q244604` Minority Report 33.7; `wp-Q105624` The Bourne Identity 33.6 |
| action-fantasy | `wp-Q426837` Mortal Kombat Annihilation 40.1; `wp-Q318975` Atlantis: The Lost Empire 33.9; `wp-Q188652` Rocky 33.4; `wp-Q212965` The Hunger Games 31.1; `wp-Q215365` Brother Bear 31.0 |
| crime | `wp-Q994481` The Wild Bunch 38.4; `wp-Q117037697` Anatomy of a Fall 35.7; `wp-Q504053` Ocean's Twelve 34.4; `wp-Q108006` Speed 32.7; `wp-Q43370948` BlacKkKlansman 31.8 |
| scifi | `wp-Q222018` Total Recall 46.6; `wp-Q80322391` The Matrix Resurrections 35.3; `wp-Q60834962` Dune 31.0; `wp-Q243983` Rise of the Planet of the Apes 28.6; `wp-Q867283` The Iron Giant 27.8 |
| war | `wp-Q483941` Schindler's List 67.1; `wp-Q221491` The Thin Red Line 43.0; `wp-Q507994` The Hunt for Red October 37.8; `wp-Q190643` Platoon 34.9; `wp-Q144483` The Last of the Mohicans 34.3 |
| game-art | `wp-Q677351` Assassin's Creed: Brotherhood 34.3; `wp-Q4267401` The Witcher 3: Wild Hunt 27.5; `wp-Q12395` The Legend of Zelda 26.0; `wp-Q337865` Far Cry 25.1; `wp-Q211735` Assassin's Creed II 24.6 |
| family-halloween | `wp-Q1212923` The Haunted Mansion 61.4; `yt-Q1212923` The Haunted Mansion 45.0; `wp-Q259357` Halloweentown II 43.0; `wp-Q109284173` Hocus Pocus 2 36.2; `wp-Q3278447` Casper's Scare School 35.7 |
| dark-drama | `wp-Q660894` What's Eating Gilbert Grape 46.9; `wp-Q478780` Talk to Her 40.4; `wp-Q624603` Snow White and the Huntsman 37.8; `wp-Q163899` 10,000 BC 36.1; `wp-Q245271` Evita 35.0 |
| collision | `wp-Q22001032` The Ghosts in Our Machine 50.4; `wp-Q997206` Ghosts of Mississippi 42.0; `wp-Q1123629` Conan the Barbarian 39.3; `wp-Q134611972` The Devil Wears Prada 2 35.8; `wp-Q24692181` Final Destination: Red Lantern 34.4 |
| trailer-thumb-safe | `yt-Q74958` Blood Diamond 62.2; `yt-Q212965` The Hunger Games 44.5; `yt-Q108839994` Oppenheimer 42.2; `yt-Q80379` The Hobbit: An Unexpected Journey 38.7; `yt-Q162729` Braveheart 36.6 |
| photo | `cm-67777378` 11.9; `cm-70143624` 10.0; `cm-87563679` 9.1; `cm-37946704` 8.7; `cm-11234285` 7.6 |
| ui-screenshot | `cm-87280245` 14.5; `cm-365954` 13.9; `cm-142384897` 11.6; `cm-161505420` 11.4; `cm-83545390` 11.2 |
| logo | `cm-133607258` 19.7; `cm-23226649` 19.3; `cm-124486607` 17.9; `cm-85198444` 16.7; `cm-185147971` 16.6 |
| food | `cm-83154589` 11.1; `cm-57023054` 10.0; `cm-39964442` 9.2; `cm-107663196` 8.0; `cm-83598800` 7.6 |
| product | `cm-127112518` 15.0; `cm-1930098` 11.0; `cm-17522965` 10.9; `cm-61904751` 9.9; `cm-68076141` 8.5 |
| people | `cm-27354352` 14.9; `cm-97179304` 9.2; `cm-52667` 6.7; `cm-100279899` 5.8; `cm-92722732` 5.7 |
| kids-cartoon | `wp-Q218235` Charlie and the Chocolate Factory 24.1; `wp-Q126800` Happy Feet 18.6; `wp-Q208131` Shrek Forever After 16.6; `wp-Q10298666` How to Train Your Dragon 2 16.6; `wp-Q22970530` How to Train Your Dragon: The Hidden World 15.7 |

#### TinyCLIP-8M head (squash)

| group | 5 worst (image id, title, score) |
|---|---|
| classic | `wp-Q133488` Kwaidan 5.7; `wp-Q1199837` Jaws 3-D 20.0; `wp-Q2171744` Killer Klowns from Outer Space 22.0; `wp-Q46637` Maximum Overdrive 23.5; `wp-Q431873` The Wolf Man 24.5 |
| minimalist | `wp-Q27492140` The Killing of a Sacred Deer 20.3; `wp-Q55606479` Cam 23.4; `wp-Q42837930` The Ritual 26.4; `wp-Q107389143` Nanny 31.6; `wp-Q121367826` When Evil Lurks 38.5 |
| creature-gore | `wp-Q22432` Signs 16.8; `wp-Q284042` Resident Evil: Degeneration 20.9; `wp-Q58879016` Zombieland: Double Tap 23.5; `wp-Q1537343` Re-Animator 25.4; `wp-Q505712` Gremlins 2: The New Batch 38.3 |
| possession-ghost | `wp-Q570481` What Lies Beneath 13.4; `wp-Q320384` Beetlejuice 22.5; `wp-Q23823461` Personal Shopper 36.0; `wp-Q666082` The Innocents 39.8; `wp-Q843450` The Invisible 49.9 |
| slasher | `wp-Q42726338` It Chapter Two 20.2; `wp-Q672248` I'll Always Know What You Did Last Summer 29.8; `wp-Q1145824` A Nightmare on Elm Street 2 31.7; `wp-Q373362` A Nightmare on Elm Street 3 43.9; `wp-Q470771` From Hell 44.1 |
| trailer-thumb | `yt-Q224647` The Devil's Advocate 2.1; `yt-Q921510` Dorian Gray 26.6; `yt-Q45386` Invasion of the Body Snatchers 29.7; `yt-Q680989` Underworld: Awakening 35.7; `yt-Q28912376` The New Mutants 37.9 |
| moody | `wp-Q134480207` Exit 8 2.4; `wp-Q652592` The Invasion 30.5; `wp-Q28912376` The New Mutants 39.8; `wp-Q680989` Underworld: Awakening 40.9; `wp-Q587707` Abraham Lincoln: Vampire Hunter 41.6 |
| dark-thriller | `wp-Q431252` Jackie Brown 58.2; `wp-Q244604` Minority Report 55.0; `wp-Q182212` Spider-Man 3 54.6; `wp-Q29054009` Terminator 3: Rise of the Machines 53.8; `wp-Q191543` Terminator Salvation 48.0 |
| action-fantasy | `wp-Q215365` Brother Bear 62.9; `wp-Q426837` Mortal Kombat Annihilation 59.9; `wp-Q212965` The Hunger Games 50.1; `wp-Q162729` Braveheart 44.6; `wp-Q226773` Wrath of the Titans 38.3 |
| crime | `wp-Q504053` Ocean's Twelve 48.0; `wp-Q112322474` Thunderbolts* 42.6; `wp-Q25627545` Ocean's 8 34.6; `wp-Q117037697` Anatomy of a Fall 34.3; `wp-Q208572` American History X 31.6 |
| scifi | `wp-Q222018` Total Recall 76.5; `wp-Q243983` Rise of the Planet of the Apes 71.3; `wp-Q213081` Star Trek 49.4; `wp-Q18604504` Suicide Squad 25.8; `wp-Q637212` Despicable Me 2 24.5 |
| war | `wp-Q483941` Schindler's List 90.2; `wp-Q471716` Barry Lyndon 63.3; `wp-Q190643` Platoon 60.6; `wp-Q244963` First Blood 53.4; `wp-Q507994` The Hunt for Red October 43.3 |
| game-art | `wp-Q677351` Assassin's Creed: Brotherhood 73.1; `wp-Q12395` The Legend of Zelda 65.7; `wp-Q211735` Assassin's Creed II 25.1; `wp-Q337865` Far Cry 14.9; `wp-Q4267401` The Witcher 3: Wild Hunt 14.6 |
| family-halloween | `wp-Q1212923` The Haunted Mansion 89.6; `wp-Q724774` Mad Monster Party? 49.6; `yt-Q1212923` The Haunted Mansion 43.5; `cm-11182893` 23.1; `wp-Q109284173` Hocus Pocus 2 20.4 |
| dark-drama | `wp-Q156911` Wings of Desire 60.7; `wp-Q280918` Leaving Las Vegas 56.7; `wp-Q624603` Snow White and the Huntsman 48.5; `wp-Q56881140` Little Women 46.1; `wp-Q163899` 10,000 BC 43.4 |
| collision | `wp-Q22001032` The Ghosts in Our Machine 60.7; `wp-Q4780597` Apostle Peter and the Last Supper 43.3; `wp-Q997206` Ghosts of Mississippi 41.5; `wp-Q1123629` Conan the Barbarian 31.2; `wp-Q134611972` The Devil Wears Prada 2 26.1 |
| trailer-thumb-safe | `yt-Q191543` Terminator Salvation 48.8; `yt-Q102235` Harry Potter and the Order of the Phoenix 48.3; `yt-Q226773` Wrath of the Titans 47.9; `yt-Q74958` Blood Diamond 46.4; `yt-Q80379` The Hobbit: An Unexpected Journey 44.7 |
| photo | `cm-70143624` 2.3; `cm-67777378` 1.7; `cm-87563679` 1.4; `cm-60520938` 1.0; `cm-69470251` 1.0 |
| ui-screenshot | `cm-87280245` 10.3; `cm-83545390` 7.3; `cm-50548836` 2.2; `cm-50298286` 2.1; `cm-9568961` 1.5 |
| logo | `cm-23226649` 44.8; `cm-133607258` 20.1; `cm-198901091` 19.7; `cm-85198444` 15.0; `cm-107690627` 9.5 |
| food | `cm-57023054` 4.2; `cm-83598800` 2.5; `cm-83154589` 1.5; `cm-189436557` 1.3; `cm-192812500` 1.0 |
| product | `cm-61904751` 7.4; `cm-68076141` 3.7; `cm-17522965` 3.2; `cm-1930098` 3.0; `cm-127112518` 1.3 |
| people | `cm-97179304` 2.4; `cm-52667` 2.0; `cm-92722732` 1.6; `cm-27354352` 1.5; `cm-100279899` 0.9 |
| kids-cartoon | `wp-Q10298666` How to Train Your Dragon 2 13.2; `wp-Q22970530` How to Train Your Dragon: The Hidden World 12.7; `wp-Q218235` Charlie and the Chocolate Factory 9.0; `wp-Q40083273` A Minecraft Movie 6.4; `wp-Q221947` The Jungle Book 2 4.2 |

Several "missed horror" examples are labelling edge cases from genre tags (Beetlejuice, Abraham Lincoln: Vampire Hunter, Underworld: Awakening, The Devil's Advocate trailer). The Haunted Mansion (2003) is the top false blur in family-halloween for both models.

## 5. Decision rule

The rule, fixed before test: (a) image-only recall no more than 3 points below the baseline, compared at the val-picked image-only bars and again at matched test hard-safe false-blur rates (both must pass); (b) minimalist recall no more than 5 points below the baseline at the image-only and horror-page bars.

| Condition | TinyCLIP-40M head (crop) | TinyCLIP-8M head (squash) |
|---|---|---|
| (a) recall at val-picked image-only bar (baseline 44.0%) | 36.8%: -7.2 points (CI -17.2 to +2.4). **Fails** the -3 margin. | 31.2%: -12.8 points (CI -22.0 to -3.2). **Fails**, and the whole CI is below the margin. |
| (a) recall at the baseline's test false-blur rate (6 of 207, 2.9%) | 63.2%: +19.2 points (CI -33.1 to +36.9). Passes. | 43.2%: -0.8 points (CI -25.8 to +12.8). Passes. |
| (b) minimalist at image-only bar (baseline 40%) | 55%: +15 (CI -15 to +45). Passes. | 25%: -15 (CI -35 to +5). **Fails.** |
| (b) minimalist at horror-page bar (baseline 45%) | 80%: +35 (CI +15 to +55). Passes. | 30%: -15 (CI -35 to +5). **Fails.** |
| **Result** | **Does not pass**: (a) fails at the val-picked bar. | **Does not pass**: (a) and (b) fail. |

**Plainly: no finalist passes the decision rule.** The CIs are wide, so most comparisons are inconclusive at 95% confidence, but the rule is applied to the point estimates as written.

What the 40M result means: the model ranks images better than MobileCLIP (higher AUC, and much higher recall at an equal false-blur rate), but its val-picked image-only bar turned out conservative on test (1.4% hard-safe false blur, 3 of 207, against a 2% target). The baseline's val-picked bar went the other way (2.9%, 6 of 207), and the baseline itself scored much better on test than on val (AUC 0.900 against 0.857; image-only recall 44.0% against 33.6%). So at the bars each model would actually ship with, they sit at different false-blur rates on test. A 2% bar on 192 val hard-safe images is set by about the fourth-highest hard-safe score, which is too few images to place it precisely.

Against what users have today (baseline at the shipped bars), the 40M head at its proposed bars: image-only 36.8% against 41.6%, with 1.4% against 1.9% false blur; horror-page 65.6% against 54.4%, with 3.4% against 3.9%; block 48.0% against 46.4%, with 1.9% against 3.4%; minimalist 55% against 40% (image-only) and 80% against 45% (horror page); family-halloween false blur 4.8% against 14.3% (image-only) and 23.8% (horror page).

What it would need to pass: more labelled hard-safe data to place the image-only bar. That means a fresh calibration set of new films (for example 600 or more hard-safe images), with the bar re-picked there and confirmed on another holdout, never on this test split. A sharper head could also help: the parity rule limited the 40M head to C = 0.3, which flattens its scores (95th percentile of val scores 60.4), so its three block bars sit within 7 points of each other. A parity test based on verdict flips at the bars, in place of the 2-point score bar, would let a sharper head through.

### Coordinator note: rule (a) read at equal false-blur rates (added after the single test run; no bar or config was re-picked)

The brief words rule (a) as recall "at equal hard-safe false-blur rate". The table above applies it two ways and requires both. The val-picked bars landed at different test rates (TinyCLIP-40M 1.4%, baseline 2.9%), so the first row compares the models at unequal rates. Below, each model is held to the same number of wrong blurs among the 207 test hard-safe images, using the same in-browser test scores (recall % of 125 horror / minimalist % of 20):

| Hard-safe false blurs allowed | 2 (1.0%) | 3 (1.4%) | 4 (1.9%) | 5 (2.4%) | 6 (2.9%) |
|---|---|---|---|---|---|
| MobileCLIP-S0 baseline | 21.6 / 15 | 30.4 / 25 | 44.0 / 40 | 44.0 / 40 | 45.6 / 40 |
| TinyCLIP-40M head (crop) | 13.6 / 10 | 45.6 / 55 | 60.8 / 80 | 62.4 / 80 | 63.2 / 80 |
| TinyCLIP-8M head (squash) | 23.2 / 25 | 28.8 / 25 | 30.4 / 25 | 38.4 / 25 | 43.2 / 30 |

Read this way, TinyCLIP-40M meets (a) and (b) at every rate from 1.4% to 2.9%, including the brief's 2% operating point (about 1.9%: 60.8% against 44.0%). It falls behind only at 1.0%, where both models are set by one or two images. TinyCLIP-8M is behind at most rates. The intervals are wide either way. What stays true under both readings: the proposed 40M bars were picked on val and ran conservative on test, so the recall users would actually get at those bars is the 36.8% in the table above, unless the bar is re-placed on a larger calibration set. The user decides which reading to apply.

## 6. Recommendation

The decision rule is not met, so this is the closest option and what it would take to ship it. The user decides.

- **Model:** TinyCLIP ViT-40M/32 Text-19M LAION-400M (MIT), vision tower only, our ONNX export at HF revision 95ec819, fp16 (`vision_model_fp16.onnx`, 79,654,451 bytes, sha256 `6d0b86438ac07844deba33a9f347ceb512ad39e0d99945aff4b2db50eb877335`).
- **Approach:** linear head on the L2-normalised image embedding, `heads/tinyclip-vit-40m-32-laion400m-crop-browser.json` (512 weights, C 0.3, trained on in-browser train-split embeddings). Ship this exact file: retraining it means re-picking every bar.
- **View:** `crop`, the decode the extension uses today (`decodeLikeLegacy`: 256 short edge, centre 256 crop, then the processor resizes to 224). No decode change.
- **Constants:** `IMAGE_ONLY_BLOCK_SCORE` 52.39, `IMAGE_BLOCK_SCORE` 49.99, `IMAGE_BLOCK_SCORE_HORROR_PAGE` 45.83, `IMAGE_VETO_SCORE` 34.69, `IMAGE_BLOCK_SCORE_GENRE_LISTING` = veto + 1 = 35.69 (no change to the formula), `UNVERIFIED_BLOCK_SCORE` 80 (unchanged, text only). If the user prefers the cost-matched veto (45.38), decouple `IMAGE_BLOCK_SCORE_GENRE_LISTING` and set it to 45.83.
- **Size:** package zip 78.46 MB (`node scripts/pack.mjs --check` in phase E), against 26.00 MB today. **This depends on the user's decision of 2026-10-05 to raise the cap on the shipped vision file from 50 MB to about 85 MB.** Under the original 50 MB cap this model is not eligible.
- **Speed:** 89 ms per image on WASM (139 ms today), 17 ms on WebGPU; cold first verdict on the IMDb test page 629 ms (1,059 ms today, one run).
- **Known costs:** image-only recall below today's at its bar (section 5); its veto leaves fewer short-title collision posters vetoed on test (13 of 17 against 15 of 17); backend verdict flips on 8 of 200 images against 1 of 200 today.

**Alternative within the original 50 MB cap:** TinyCLIP ViT-8M/16 YFCC15M (MIT), fp16 (16.8 MB, zip 20.25 MB), linear head `heads/tinyclip-vit-8m-16-yfcc15m-squash-browser.json` (C 3), `squash` view, which needs the decode change in `ship-patch/classifier-squash.diff`. Constants: image-only 71.27, block 67.32, horror-page 62.87, veto 34.94, genre-listing 35.94. It fails (a) and (b) on test (image-only recall 31.2% against 44.0%; minimalist 25% and 30% against 40% and 45%), so it would blur noticeably less horror than today.

## 7. What else changes if it ships

1. **Model files.** Replace `models/Xenova/mobileclip_s0/` with the new model directory (`config.json` sha256 `a7694656...ed88`, `preprocessor_config.json` `910e70b3...57bd`, `onnx/vision_model_fp16.onnx` `6d0b8643...7335`; full hashes in `model-files.json`). The fp16 file is 79.7 MB: above GitHub's 50 MB warning size and below its 100 MB limit for a plain git file, so consider Git LFS.
2. **Head file and loading code.** Ship the head as `data/image-head.json` and add the loader and scorer from `ship-patch/classifier-head.diff` (`loadHead`, `scoreWithHead`, `modelVersion` passed through). **Do not apply that diff's `INPUT_SIZE` hunk for the crop view:** it reads the processor size (224), which would make `decodeLikeLegacy` crop at 224 and give different pixels from the 256 crop the head was trained on.
3. **Decode change, only for the 8M alternative.** Apply `ship-patch/classifier-squash.diff` (`decodeSquash`) and set `DECODE_PATH` to `'squash'`.
4. **Offscreen `INPUT_SIZE` and comments.** Keep `INPUT_SIZE = 256` for the 40M crop view and rewrite its comment ("canvas crop size; the processor then resizes to the model's 224 input"). Update `MODEL_ID` and the MobileCLIP comments (file header, the q8 note).
5. **ml-bridge constants.** Set the five constants above in `content/ml-bridge.js` and rewrite their calibration comments, which cite MobileCLIP scores (Cape Fear 72, Nun 51 and others). `IMAGE_BLOCK_SCORE_GENRE_LISTING` stays `IMAGE_VETO_SCORE + 1` with the proposed veto. With the cost-matched veto it must become its own constant (45.83).
6. **`MODEL_VERSION`** in `background/feedback.js` (constant) and `background/ml-router.js` (initial `modelVersion`), plus `eval/setup-model.mjs`, for example `tinyclip_40m-fp16-head-v1`. The verdict cache is keyed by it, so old cached scores are dropped, which is wanted.
7. **`eval/verdict-corpus.json`.** Re-record every `imageScore` **in the browser** with the shipped extension (a harness like `eval/bakeoff/browser-embed.mjs` or `eval/fp16-compare.mjs`), because `eval/image-classifier.mjs` in Node does not reproduce the extension's scores. Re-derive the synthetic stress points against the new bars (for example `v-freaky-50`: 50 is now above the new block bar of 49.99), and update the description.
8. **`eval/setup-model.mjs`.** New `MODEL_ID`, `MODEL_REVISION` (95ec8197b3f2fe7f747865c61ca556cf0768b2f7), `MODEL_VERSION`, `SHIPPED_FILES`, `DEV_FILES` and `DEV_SHA256`. The upstream repository has safetensors only, so the fp16 vision file cannot be downloaded ready-made: either setup runs `eval/bakeoff/export.py` from the pinned weights, or the committed `models/` file becomes the source and setup only verifies it.
9. **`vendor/CHECKSUMS.sha256`.** Replace the three `models/` lines with the new paths and hashes, add `data/image-head.json`, and update the header comment and the regenerate command.
10. **`scripts/pack.mjs`.** Add `THIRD_PARTY_NOTICES` to `INCLUDE`. The existing rules still hold (exactly one vision model; no tokenizer or text tower).
11. **`THIRD_PARTY_NOTICES`.** No such file exists today. Create it with the TinyCLIP MIT notice ("Copyright (c) Microsoft Corporation", https://github.com/microsoft/Cream/blob/main/TinyCLIP/LICENSE), and add the runtime notices for transformers.js and onnxruntime-web while it is being created.
12. **Prompt embeddings.** With a head, `data/prompt-embeddings.*` are no longer used. They were made with MobileCLIP's text tower, so remove them from the shipped build, and retire or update `eval/precompute-prompts.mjs` and `eval/image-classifier.mjs`.
13. **README.** It mentions MobileCLIP in five places.
14. **Release.** Level 1: bump to 2.0.0 in `manifest.json`, `package.json` and both root fields of `package-lock.json`; add the approved note to `data/releases.json` (`dataFlows` unchanged); run `npm run release:check`, `npm run eval` and `npm run latency`.

## 8. Methodology problems found

- **transformers.js squashes legacy `size: 224` configs.** transformers.js 4.x reads a legacy `CLIPFeatureExtractor` `"size": 224` (TinyCLIP, and OpenAI CLIP) as "resize the whole image to 224x224", with no crop (checked with a banded synthetic image). The extension always centre-crops a 256 square first. So the phase C and D Node numbers for TinyCLIP and CLIP came from squashed full posters, while the browser sees centre crops. This is why phase E's browser scores for TinyCLIP differed from Node by up to 72 points.
- **`eval/image-classifier.mjs` does not reproduce the shipped extension.** Even for MobileCLIP, whose geometry matches, its Node scores differ from the extension's in-browser scores by up to 52.3 points (mean 1.7), and 390 of 1,981 images (20%) differ by more than 2 points. The cause is resampling: Node's sharp resize and the extension's canvas resize give different pixels. Any bar calibrated with the Node harness is calibrated on the wrong scores. This bake-off's final numbers all come from in-browser embeddings.
- **MobileCLIP itself fails the 2-point WASM/WebGPU parity bar.** Its shipped zero-shot scores differ between backends by up to 2.95 points on the 200 parity images. The bar was applied to the candidates anyway, which pushed the heads towards small C values.
- **The shipped 40 veto cancels about 41% of horror on val** (34% on test), including half the moody horror. It does veto 94% of val short-title collision posters, but its own benefit-matched line would be 17.45.
- **The groups are named by intent more than by poster style.** "minimalist" is really a list of 2013 and later elevated horror films (It Follows, Hereditary and Midsommar, but also The Conjuring, Annabelle and Terrifier, whose posters are not minimal). "dark-thriller" leans towards action and Bond: 13 Bond films, 6 Mission: Impossible films, 6 Fast & Furious films (with Hobbs & Shaw), and Rambo and Terminator sequels. Cape Fear itself is not in the set.

## 9. Limits

- **Sample sizes.** Test has 125 horror, 207 hard-safe and 70 easy-safe images. Minimalist has 20 (one image is 5 points), moody 13, collision 17 and family-halloween 21. A 2% false-blur bar means 4 of 207 images. Most decision-rule differences are inside their 95% CIs, which are 20 to 70 points wide.
- **Sources.** Images come only from Wikipedia thumbnails (about 330 px), Wikimedia Commons and YouTube trailer thumbnails. They are not screenshots of IMDb, Netflix or YouTube pages, which show crops, overlays and other sizes. Half-size downscaling moves scores by up to 14 (40M) and 37 (baseline) points.
- **Labels follow film genre.** A horror film's poster counts as horror even when the image is mild, and genre tags let some edge cases in (Beetlejuice, horror comedies, monster action). Hard-safe groups exclude anything tagged horror, so borderline family Halloween films were curated by hand.
- **One test run, two finalists.** The test split was read once. Val numbers are optimistic because C, prompt variants and every bar were picked on val.
- **Latency** was one run per page on the default backend.

## 10. Level 1 release-note draft (for approval; not added to `data/releases.json`)

**Why Level 1:** trigger 6, a detection rebuild that broadly changes what gets blurred. The image model is replaced, and every image bar changes with it. No other trigger applies: there is no new permission or host permission, `minimum_chrome_version` does not change (the JSPI runtime already needs Chrome 137), and no new data leaves the device, so `dataFlows` stay as they are. The download grows from about 26 MB to about 78 MB. The user picks 2.0.0 or downgrades it to Level 2.

The draft passes `validateReleases` from `scripts/release-check.mjs` (summary 128 characters). Set `date` on the day it ships.

```json
{
  "id": "2.0.0",
  "surface": "extension",
  "version": "2.0.0",
  "level": 1,
  "date": "2026-10-05",
  "title": "A new picture model",
  "aside": "Scaredy Cat has new glasses, and it finds the quiet, arty posters much easier to spot now.",
  "summary": "Scaredy Cat now checks pictures with a new model that can go in the Chrome Web Store, and it catches more modern horror posters.",
  "changes": [
    {
      "type": "improved",
      "text": "Scaredy Cat now uses a different model to look at pictures. The licence of the old model only allowed research use, so it could not go in the Chrome Web Store. The new model's licence allows that."
    },
    {
      "type": "improved",
      "text": "On pages that are already about horror, Scaredy Cat now catches about 8 in 10 modern horror posters in our test pictures. The old model caught fewer than half of them."
    },
    {
      "type": "fixed",
      "text": "Family Halloween pictures, such as pumpkin photos and children's Halloween films, were sometimes blurred by mistake. That now happens far less often."
    },
    {
      "type": "fixed",
      "text": "When the text around a picture only weakly suggested horror, a calm-looking picture could cancel the blur, even when it was a real horror poster. This happened to about a third of the horror pictures in our tests. Scaredy Cat now cancels a blur only when the picture looks clearly safe, which happens to about 1 in 6 of them. As a result, some films that share a short name with a horror film may be blurred a little more often."
    },
    {
      "type": "improved",
      "text": "A picture with no title or other clue nearby is now blurred a little less often, and fewer safe pictures get blurred by mistake."
    },
    {
      "type": "improved",
      "text": "The download is larger, about 78 MB, up from about 26 MB, because the new model is bigger. Pictures are still checked on your computer, and no new information leaves it."
    }
  ],
  "commits": []
}
```

The figures behind it (test split, 40M head at the proposed bars against today's shipped bars): modern horror at the horror-page bar 80% against 45%; family-halloween false blur 4.8% against 14.3% to 23.8%; horror vetoed 16.8% against 34.4%; collision posters vetoed 76.5% against 88.2%; image-only recall 36.8% against 41.6%, with hard-safe false blur 1.4% against 1.9%.
