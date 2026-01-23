# Scaredy Cat - Horror Content Blocker

A Chrome extension that protects you from horror-related content while browsing. Because not everyone wants to see scary stuff!

## Features

- **Automatic Detection**: Scans images and video thumbnails on any webpage
- **Smart Detection**: Uses text analysis and a comprehensive horror database (500+ titles)
- **Blur Protection**: Blurs detected horror content with a friendly overlay
- **Easy Controls**: Toggle protection on/off, adjust sensitivity, manage allowlists
- **Dynamic Content Support**: Works with infinite scroll and dynamically loaded content
- **Site-Specific Settings**: Disable on specific websites
- **Privacy-First**: All processing happens locally, no data sent to external servers

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

Scaredy Cat uses a multi-layered approach to detect horror content:

1. **Text Analysis**
   - Image alt text and title attributes
   - Surrounding text and headings
   - URL and filename analysis
   - Link text pointing to images

2. **Horror Database**
   - 500+ known horror movies, TV shows, and games
   - Includes variations and alternate spellings
   - Updated regularly

3. **Keyword Scoring**
   - Horror-related keywords with weighted scores
   - Multiple keyword matches increase confidence
   - Context-aware scoring

4. **Fuzzy Matching**
   - Handles typos and variations
   - "28 Years Later" matches "28yearslater" or "Twenty Eight Years Later"

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
├── manifest.json          # Extension configuration
├── background.js          # Service worker for state management
├── content/
│   ├── content.js        # Main content script
│   ├── detector.js       # Horror detection logic
│   ├── blocker.js        # Blur overlay UI
│   └── observer.js       # MutationObserver for dynamic content
├── data/
│   └── horror-database.json  # Horror titles and keywords
├── popup/
│   ├── popup.html        # Extension popup UI
│   ├── popup.js          # Popup interactions
│   └── popup.css         # Popup styling
├── icons/
│   ├── icon16.png        # Toolbar icon
│   ├── icon48.png        # Extension page icon
│   └── icon128.png       # Chrome Web Store icon
├── styles/
│   └── blur-overlay.css  # Content blur styles
└── scripts/
    └── generate-icons.js # Icon generation script
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
