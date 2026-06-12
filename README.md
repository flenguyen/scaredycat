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

5. **(Optional) Better Icons**
   - Open `icons/generate-icons.html` in your browser
   - Download each icon and save to the `icons/` folder
   - Reload the extension in `chrome://extensions/`

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

1. **Definite horror** — strong title match → blurred instantly, no ML latency
2. **Ambiguous** — keyword-only signal, weak/fuzzy title match, or no text at all on a
   horror-adjacent page or media site → the image's pixels are scored by the bundled
   MobileCLIP model in an offscreen document (WebGPU when available, WASM otherwise).
   Image evidence ≥70 blocks on its own; ≤25 vetoes a keyword-only text block.
   Title matches are never vetoed (horror posters often look innocuous).
3. **Likely safe** — revealed, zero ML cost

Image verdicts are cached in IndexedDB (keyed by URL + model version), so repeat
browsing costs nothing. Text scoring is memoized per page. Viewport-visible elements
are scanned first; offscreen elements wait for idle time.

### Dev setup (image classifier + eval)

Text detection works out of the box. The ML model files are fetched once:

```bash
npm install
npm run setup:model          # MobileCLIP-S0 vision tower (~46MB) + vendor transformers.js
npm run precompute:prompts   # embed zero-shot prompts -> data/prompt-embeddings.json
npm run eval                 # text-layer quality metrics + legacy parity + benchmark
```

Detection tuning = editing the prompt list in `eval/precompute-prompts.mjs` and
re-running `precompute:prompts` — no retraining, no code changes. End-to-end pipeline
test (requires Chrome for Testing — regular Chrome no longer supports --load-extension):

```bash
npx @puppeteer/browsers install chrome@stable --path /tmp/sc-chrome
npm install --no-save puppeteer-core
SC_CHROME_BIN=<path-to-chrome-for-testing-binary> node eval/browser-smoke.mjs
SC_CHROME_BIN=<path-to-chrome-for-testing-binary> node eval/browser-smoke2.mjs
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

### Too many false positives
- Lower the sensitivity to "Low"
- Use "Show anyway" to reveal individual items

### Performance issues
- The extension processes max 50 images per batch
- Uses debouncing (200ms) to prevent excessive scanning
- Skips images smaller than 100x100 pixels

## File Structure

```
scaredycat/
├── manifest.json              # Extension configuration (MV3)
├── background.js              # Service worker: state, messaging, ML routing
├── background/
│   ├── ml-router.js          # Batches/dedupes classification requests, offscreen lifecycle
│   └── verdict-cache.js      # IndexedDB cache of image scores (URL + model version)
├── content/
│   ├── scoring-core.js       # Pure text-scoring engine (also used by the eval harness)
│   ├── detector.js           # DOM context extraction, bands, memoization
│   ├── ml-bridge.js          # Sends ambiguous images for classification, combines verdicts
│   ├── blocker.js            # Blur overlay UI
│   ├── observer.js           # MutationObserver for dynamic content
│   ├── early-init.js         # Pre-hides hero content on media sites
│   └── content.js            # Main coordinator
├── offscreen/
│   ├── offscreen.html        # Offscreen document hosting the classifier
│   └── classifier.js         # MobileCLIP vision tower (WebGPU/WASM), prompt scoring
├── data/
│   ├── horror-database.json  # Horror titles and keywords
│   └── prompt-embeddings.json # Precomputed zero-shot prompt embeddings
├── models/                    # MobileCLIP-S0 ONNX files (npm run setup:model)
├── vendor/                    # transformers.js + ONNX runtime WASM (npm run setup:model)
├── eval/
│   ├── run-eval.mjs          # Quality metrics, legacy parity, benchmark
│   ├── corpus.json           # Labeled test contexts (curated + generated)
│   ├── legacy-core.mjs       # Pre-refactor scorer (parity baseline — do not edit)
│   ├── precompute-prompts.mjs # Prompt ensemble -> embeddings
│   ├── image-classifier.mjs  # Node-side classifier (same files as the extension)
│   ├── ab-test.mjs           # Score real images from Wikipedia (prompt tuning aid)
│   └── browser-smoke*.mjs    # End-to-end tests in Chrome for Testing
├── popup/                     # Extension popup UI
├── icons/                     # Extension icons
└── styles/                    # Blur overlay styles
```

## Development

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
