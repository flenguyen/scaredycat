# Scaredy Cat - Horror Content Blocker

A Chrome extension that protects you from horror-related content while browsing. Because not everyone wants to see scary stuff!

## Features

- **Automatic Detection**: Scans images and video thumbnails on any webpage
- **Hybrid Detection**: Fast text analysis (600+ title database, 200+ keywords) routes
  uncertain cases to an **on-device image classifier** (MobileCLIP via WebGPU/WASM) that
  looks at the actual pixels — catching horror images with innocent text, and vetoing
  false positives where scary *words* sit over harmless images
- **Blur Protection**: Blurs detected horror content with a friendly overlay
- **Easy Controls**: Toggle protection on/off, adjust sensitivity, allow individual
  items, reveal everything on a page
- **Dynamic Content Support**: Works with infinite scroll and dynamically loaded content
- **Site-Specific Settings**: Disable on specific websites
- **Privacy-First**: All processing happens locally — the ML model is bundled with the
  extension and no data is ever sent anywhere

## Installation

### Quick Install (Unpacked Extension)

1. **Download/Clone this repository**
   ```bash
   git clone https://github.com/yourusername/scaredycat.git
   ```

2. **Open Chrome Extensions page**
   - Navigate to `chrome://extensions/`
   - Or click Menu > More Tools > Extensions

3. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top-right corner

4. **Load the extension**
   - Click "Load unpacked"
   - Select the `scaredycat` folder
   - The extension should now appear in your toolbar

## Usage

### Basic Controls

- **Click the extension icon** in your toolbar to open the popup
- **Toggle switch** at the top enables/disables the extension
- **Sensitivity slider** adjusts detection threshold:
  - **Low**: Only blocks content with 80%+ confidence (fewer blocks, fewer false positives)
  - **Medium**: Blocks content with 60%+ confidence (balanced)
  - **High**: Blocks content with 40%+ confidence (more blocks, may have false positives)

### When Content is Blocked

When horror content is detected, you'll see:
- A blurred image/video with a dark overlay
- A message: "Horror content hidden"
- A "Show anyway" button to reveal the content

### Site Controls

- Click "Disable on this site" to turn off protection for the current website
- Settings are saved automatically

## How Detection Works

Every image/video gets a text score first (title + keyword matching, fuzzy matching for
typos, all precompiled into fast indexes), which lands it in one of three bands:

1. **Definite horror** — strong title match → blurred instantly, no ML latency. Long
   titles qualify by score; shorter distinctive names ("The Exorcist", "Train to Busan")
   qualify through a curated `definite: true` flag on their database entry (audited by
   `node eval/run-eval.mjs --definite-report` and `npm run lint:database`; generic
   phrases like "escape room" or "white noise" are deliberately NOT flagged so the image
   veto still protects them)
2. **Ambiguous** — keyword-only signal, weak/fuzzy title match, or no text at all on a
   horror-adjacent page or media site → the image's pixels are scored by the bundled
   MobileCLIP model in an offscreen document (WebGPU when available, WASM otherwise).
   Image evidence ≥70 blocks on its own; ≤25 vetoes a keyword-only text block.
   Title matches are never vetoed (horror posters often look innocuous).
3. **Likely safe** — revealed, zero ML cost

### Borrowed titles

Trailer and clip cards in search dropdowns and video rails (IMDb's suggestion list, for
one) link to a sub-resource of a title (`/title/tt…/videoplayer/vi…/`) and carry only
"0:51 Official Teaser" as text, so on their own they never reach the title list and each
one is judged on pixels alone — a known title ended up half-blurred. On media sites the
detector borrows the name from a sibling card in the same list that links to the entity
itself (`/title/tt…/`), so every card tied to a listed title scores as that title. Covered
by `eval/browser-smoke-sibling-title.mjs` (part of `npm run smoke`).

### Page-level signals

Beyond per-element text, the page itself is scored once. A strong title match in
`document.title`/URL, a keyword stack, **or an explicit "Horror" genre declaration on a
single-title detail page** raises a page horror signal. This handles movies too new to be
in the title database (where the title and synopsis give no usable text signal): the genre
line is read from JSON-LD/Open Graph metadata or the visible genre line near the page's
`<h1>`. When the signal is set, no-text posters on the page route to the image classifier
and the image-block bar drops (76 → 65), so every poster/thumbnail on the page is judged
consistently instead of catching only some. The genre check is deliberately scoped to
one-title pages so a homepage carousel listing one horror movie doesn't lower the bar for
every poster on the page.

The structured metadata also works as a **negative signal**. When a detail page's JSON-LD
names exactly one media item whose genres contain neither Horror nor Thriller (Forrest
Gump: Drama, Romance), and nothing else on the page says horror (no listed title in the
page title, no keyword stack, no genre line), the site's own data model says this title
is not horror. Quiet elements (no text signal at all) then band as likely safe without a
classifier round trip, and image-only evidence can never block. Text-backed elements keep
the normal bars, so a listed horror title in a "more like this" rail still blurs. This is
what stops the classifier from reading a drama's own trailer thumbnails as a jump scare
(Forrest Gump's scored 95-97 and were blurred). Any horror signal appearing later drops
the negative signal; horror evidence always wins.

The same page signal also fires on **browse/listing pages filtered to Horror** (e.g. a
catalog showing `/genre/horror`, `/browse/movie/horror`, or `?genre=27` — TMDB's horror
id), where the entire grid is intended to be horror but most cards are poster-only and
escape the per-element text layer. This is detected from generic, site-agnostic cues — the
URL's genre path/query and any active filter chip naming Horror — rather than a hardcoded
list of sites, so it generalizes across Cineby's mirror domains and any other TMDB-powered
front-end. Genre-string and URL logic lives in `content/genre-signal.js` and is covered by
`npm run eval:genre`.

Image verdicts are cached in IndexedDB (keyed by a size-agnostic canonical image key +
model version, so the same poster at different CDN sizes is one entry), so repeat
browsing costs nothing. Text scoring is memoized per page.

### Performance model

- **No service-worker round trip on page load**: settings and the horror database are
  read straight from `chrome.storage` in parallel; the worker seeds the database into
  storage on install/update and the daily refresh keeps it there.
- **Viewport gating**: elements near the viewport (one viewport of margin in every
  direction) are scored right away; everything else waits in an `IntersectionObserver`
  until it approaches, so a 40-thumbnail YouTube results page costs ~7 classifier
  requests instead of 40.
- **Streaming classifier**: the worker talks to the offscreen document over a runtime
  Port; each image resolves as soon as its own inference finishes (no batch tail), fetch
  and decode run a few at a time with an 8s timeout, inference is serialized on the one
  ORT session, and fetch failures are negative-cached for 10 minutes.
- **Warm model**: media sites and horror pages ask the worker to pre-load the model (and
  run one dummy inference to compile WebGPU shaders) while the page is still loading. The
  offscreen document is torn down by a `chrome.alarms` timer after 30 idle minutes.
- **Measure, don't guess**: `npm run latency` (needs `SC_CHROME_BIN`) loads fixture pages
  under real media hostnames and reports init→db-ready, time to first blur, classifier
  requests, verdict latency and script time, cold and warm.

### Dev setup (image classifier + eval)

Text detection works out of the box. The ML model files are fetched once:

```bash
npm install
npm run setup:model          # fp16 MobileCLIP-S0 vision tower (~23MB) into models/,
                             # fp32 + text tower into eval/.model-cache (dev only),
                             # transformers.js 4.x + its ORT wasm into vendor/
npm run precompute:prompts   # embed zero-shot prompts -> data/prompt-embeddings.{json,bin}
npm run eval                 # text-layer metrics, genre-signal and image-key tests
npm run eval:combined        # text + image verdict fixtures
npm run lint:database        # safeTitles + definite-flag invariants
npm run pack                 # dist/scaredycat-<version>.zip + size report (~26MB compressed)
```

The shipped vision tower is **fp16** (validated against fp32 with
`eval/fp16-compare.mjs`: every calibration poster within 2 points, no decision-bar
crossings, works on WebGPU and WASM). It needs the transformers.js 4.x runtime in
`vendor/`; the 3.x runtime aborted loading fp16 on WebGPU. The vendored ONNX Runtime is
its **JSPI** wasm build (16.8MB, Chrome 137+ — hence `minimum_chrome_version`), which
loads ~40% faster than the bundle's default Asyncify build. The shipped
`data/prompt-embeddings.bin` was computed with the 3.x runtime and is what the
`ml-bridge.js` bars are calibrated against — if you regenerate it under 4.x, re-check
calibration (components shift by up to ~0.025).

Detection tuning = editing the prompt list in `eval/precompute-prompts.mjs` and
re-running `precompute:prompts` — no retraining, no code changes. End-to-end pipeline
tests (require Chrome for Testing — regular Chrome no longer supports --load-extension):

```bash
npx @puppeteer/browsers install chrome@stable --path /tmp/sc-chrome
npm install --no-save puppeteer-core sharp
export SC_CHROME_BIN=<path-to-chrome-for-testing-binary>
npm run smoke                # blur/veto/overlay end-to-end
npm run latency              # perf harness (add --live for real IMDb/YouTube pages)
node eval/fp16-compare.mjs   # fp16 vs fp32 scores (needs fp32 copied into models/ for the run)
```

## Testing

Test the extension on these sites:

- [Rotten Tomatoes](https://www.rottentomatoes.com/) - Movie posters
- [IMDB](https://www.imdb.com/) - Thumbnails and posters
- [YouTube](https://www.youtube.com/) - Search for horror movie trailers
- [Reddit r/horror](https://www.reddit.com/r/horror/) - Post images

### Expected Results

The extension should blur:
- Known horror movie posters (28 Years Later, Nosferatu, Hereditary, etc.)
- Images with horror keywords in alt text or surrounding content
- Video thumbnails for horror trailers

The extension should NOT blur:
- Non-horror content
- Small icons and UI elements (under 100x100 pixels)
- Already processed content

## Troubleshooting

### Extension not loading
- Make sure Developer Mode is enabled
- Check for errors in `chrome://extensions/`
- Try reloading the extension

### Content not being blocked
- Check if the extension is enabled (purple toggle in popup)
- Try increasing sensitivity to "High"
- Make sure the site isn't in the disabled list
- Report it: right-click the image and choose "Scaredy Cat: Report missed horror", or use
  "Report missed horror" in the popup and click the image. It is blurred immediately and
  remembered on this device, so it stays blurred on reload and wherever the same poster
  appears. "Allow" in the popup undoes it.

### Too many false positives
- Lower the sensitivity to "Low"
- Use "Show anyway" to reveal individual items

### Performance issues
- Only elements within a viewport of the visible area are scored; the rest wait until
  they scroll near
- DOM mutations are batched (150ms, max 500ms wait) before scanning
- Skips images smaller than 100x100 pixels (60x60 on media sites)
- Run `npm run latency` to see where time goes on a fixture page set

## File Structure

```
scaredycat/
├── manifest.json              # Extension configuration (MV3)
├── background.js              # Service worker: state, messaging, DB seeding, ML routing
├── background/
│   ├── ml-router.js          # Streams classification requests over a Port, offscreen lifecycle
│   ├── verdict-cache.js      # Memory + IndexedDB cache of image scores (key + model version)
│   ├── image-key.js          # Size-agnostic canonical image keys (cache/dedupe)
│   ├── db-version.js         # Database version compare shared by seeding + refresh
│   └── db-updater.js         # Daily remote refresh of the title list
├── content/
│   ├── scoring-core.js       # Pure text-scoring engine (also used by the eval harness)
│   ├── genre-signal.js       # Pure genre-declaration predicates (shared with eval)
│   ├── detector.js           # DOM context extraction, bands, memoization, page genre signal
│   ├── ml-bridge.js          # Sends ambiguous images for classification, combines verdicts
│   ├── blocker.js            # Blur overlay UI
│   ├── observer.js           # MutationObserver for dynamic content (batched, max-wait)
│   ├── early-init.js         # Pre-hides hero content + warms the model on media sites
│   └── content.js            # Main coordinator, viewport gating, perf marks
├── offscreen/
│   ├── offscreen.html        # Offscreen document hosting the classifier
│   └── classifier.js         # MobileCLIP vision tower (WebGPU/WASM), streaming port
├── data/
│   ├── horror-database.json  # Horror titles (with curated `definite` flags) and keywords
│   ├── prompt-embeddings.json # Prompt labels + logit scale
│   └── prompt-embeddings.bin  # Float32 prompt embeddings
├── models/                    # fp16 MobileCLIP-S0 vision tower (npm run setup:model)
├── vendor/                    # transformers.js 4.x + ONNX runtime WASM (npm run setup:model)
├── scripts/pack.mjs           # Builds the distributable zip, refuses dev files
├── eval/
│   ├── run-eval.mjs          # Quality metrics, --definite-report audit, benchmark
│   ├── corpus.json           # Labeled test contexts (curated + generated)
│   ├── verdict-corpus.json   # Text + image verdict fixtures (combined-eval.mjs)
│   ├── legacy-core.mjs       # Pre-refactor scorer (parity baseline — do not edit)
│   ├── precompute-prompts.mjs # Prompt ensemble -> embeddings
│   ├── image-classifier.mjs  # Node-side classifier (dev model cache)
│   ├── image-key-test.mjs    # Canonical image key unit test
│   ├── fp16-compare.mjs      # fp16 vs fp32 in the real extension runtime
│   ├── browser-latency.mjs   # Perf harness: cold/warm timings on fixture pages
│   ├── ab-test.mjs           # Score real images from Wikipedia (prompt tuning aid)
│   └── browser-smoke*.mjs    # End-to-end tests in Chrome for Testing
├── popup/                     # Extension popup UI
├── icons/                     # Extension icons
└── styles/                    # Blur overlay styles
```

## Development

> **Designing UI?** Every surface follows the canonical design system in [DESIGN.md](DESIGN.md) — tokens, type, components, and rules. Start there before touching any CSS.

### Making Changes

1. Edit the relevant files
2. Go to `chrome://extensions/`
3. Click the reload button on the Scaredy Cat card
4. Refresh any open tabs to see changes

### Adding Horror Titles

Edit `data/horror-database.json`:

```json
{
  "title": "Movie Name",
  "year": 2024,
  "variations": ["alternate spelling", "other name"]
}
```

### Adding Keywords

Edit the `keywords` array in `data/horror-database.json`:

```json
{
  "keyword": "newkeyword",
  "weight": 20
}
```

Weight guide:
- 5-10: Low confidence keywords (common words)
- 15-20: Medium confidence (genre indicators)
- 25-30: High confidence (strong horror indicators)

### Debugging

Open DevTools (F12) and check the Console for messages starting with "Scaredy Cat:".

You can also use the global `ScaredyCat` object in the console:

```javascript
// Check extension status
ScaredyCat.isEnabled()

// Get stats
ScaredyCat.getStats()

// Force rescan
ScaredyCat.rescan()

// Temporarily disable
ScaredyCat.disable()

// Re-enable
ScaredyCat.enable()
```

## Privacy

- **No external requests**: All detection happens locally in your browser
- **No data collection**: Your browsing data is never sent anywhere
- **Local storage only**: Settings are stored in Chrome's sync storage

## License

MIT License - Feel free to modify and distribute.

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

### Ideas for Contributions

- Add more horror titles to the database
- Improve detection algorithms
- Add support for more content types
- Create better icons
- Improve accessibility
- Add internationalization

## Acknowledgments

- Horror database compiled from various sources
- Icon design inspired by the classic scaredy cat emoji
- Built with modern Chrome Extension APIs (Manifest V3)

---

Stay safe from spooky stuff!
