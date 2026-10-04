# Scaredy Cat (extension)

Chrome MV3 extension that blurs horror pictures and trailers while you browse. Detection runs on the device: text scoring first, then a bundled image model for unclear cases. The website lives in the separate `scared-cat-web` repo. UI work follows [DESIGN.md](DESIGN.md).

## Welcome page

One page, two places: `welcome/welcome.html` in the extension (opened on install by `background.js` and from the popup's "How it works" link) and https://www.scaredycat.app/welcome. Both run the same files from this repo:

| File | Role |
|---|---|
| `data/welcome.json` | All of the page's copy. Bold is `**like this**`; nothing else is parsed. |
| `welcome/welcome.js` | Builds the page from the copy and runs the demo tiles. `data-mode="extension"` adds the real report-sharing switch and note form; `data-mode="web"` shows where to find them in the popup instead. |
| `welcome/welcome.css` | Layout, scoped under `.wc` with `wc-` class names so it can sit inside the website's CSS. |
| `styles/blur-overlay.css`, `styles/feedback.css`, `fonts/*.woff2` | The real blur card, toast and fonts, used by the demos. |

The website reads these from this repo's `main` branch through `scared-cat-web/app/welcome/x/[...path]/route.ts` (an allowlist in `lib/welcome/source.ts`). It holds no copy of its own. So:
- **Change the welcome page here, never in the web repo.** A push to `main` updates the website within 5 minutes, or right away with `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://www.scaredycat.app/api/revalidate/releases`.
- **Anything on `main` goes live on the website before the extension update ships.** Copy that describes a feature should land on `main` with (or after) the feature.
- **Keep both modes working.** Run the extension check and look at the page in web mode (`WELCOME_DIR=<this repo> npm run build && npx next start` in `scared-cat-web`, then open `/welcome`).
- A new file the page loads must be added to `WELCOME_ASSETS` in the web repo, or the website 404s it.
- `npm run eval` includes `eval/welcome-test.mjs`: every `copy.*` path the script reads must exist in the JSON, and the copy follows the writing rules (no em dashes).
- The demos mirror `content/blocker.js` card markup and copy ("Something spooky was here.", "Show anyway", "This isn't horror"). When the real card changes, update the mirror in `welcome/welcome.js`.
- Copy follows "Writing the notes" below.

## Releases

`data/releases.json` is the single source for the popup's "What's new" view and https://www.scaredycat.app/changelog. Every user-visible change gets a version and a note there.

### Levels

| Level | Example | Meaning | Who decides | Popup marker |
|---|---|---|---|---|
| **1** | `2.0.0` | A change to the deal people made with us. | **The user.** Stop, explain the trigger, draft the note. They pick 2.0 or downgrade it to Level 2. | Yes |
| **2** | `1.6.0` | Something people can see or use that they couldn't before. | Claude | Yes ("New in 1.6") |
| **3** | `1.5.1` | Works better: fixes, wrong-blur corrections, speed, accessibility, copy. | Claude | No (listed only) |
| none | n/a | Tests, eval and tooling; docs; title-list data updates (they ship through the 6-hourly list, not a release); website articles. | Claude | n/a |

**Level 1 triggers.** Any one of these means stop and ask:
1. A new kind of data leaves the device, or there is a new destination or third party.
2. A new Chrome permission or host permission (Chrome disables the extension until the user re-approves).
3. A higher `minimum_chrome_version`.
4. A feature is removed, or a default people rely on changes (sensitivity, the sites it skips, whether reporting is on by default).
5. A new browser or platform, accounts, or pricing.
6. A detection rebuild that broadly changes what gets blurred.

**Level 2 examples:** a new feature, setting or surface; a visible redesign; a new detection signal (such as reading genre tags); coverage of a new site.

**Level 3 examples:** false positives and negatives fixed; performance; polish.

### Release steps

a. **Classify** the change with the table above. Level 1: stop here and ask.
b. **Bump** `version` in `manifest.json` and `package.json` (and the two root `version` fields in `package-lock.json`).
c. **Add or extend the entry** at the top of `data/releases.json`. Same-day changes that haven't been packed yet may share an entry; its level is the highest level included. If what leaves the device changed, update `dataFlows` too.
d. Run **`npm run release:check`** (`npm run pack` runs it as well and refuses to build on failure).
e. Code, version bump and note go in the **same commit**.
f. Tag it locally: `git tag vX.Y.Z`. **Ask before pushing** the tag or `main`.

Pushing to `main` is what updates scaredycat.app/changelog: the website reads `https://raw.githubusercontent.com/flenguyen/scaredycat/main/data/releases.json`. The page re-reads it every 5 minutes; to update it immediately after a push, run `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://www.scaredycat.app/api/revalidate/releases` (secret in `.env.local`). A user-facing website launch gets a `"surface": "website"` entry here (`version` and `level` null, id `web-YYYY-MM-DD-slug`). Never hand-edit release text in the web repo.

A commit with no user-visible effect (tests, tooling, docs, comments) puts **`[no-release]`** in its message. The guard hook in `.claude/settings.json` (`scripts/release-guard.mjs`) blocks a `git commit` that stages runtime files (`manifest.json`, `background*`, `content/`, `popup/`, `offscreen/`, `styles/`, `fonts/`, `icons/`) without `data/releases.json` or `[no-release]`.

### Writing the notes

Follow `scared-cat-web/CLAUDE.md` "Writing copy":
- No em dashes (U+2014); the release check rejects them.
- No punchline couplets or fragment stacks.
- No "X, not Y" contrasts.
- No rhythm tricolons or flourish lists.
- Plain full sentences that state a fact. At most one joke per line, and the `aside` is where it goes.
- State mistakes plainly: what was wrong and when it was fixed.
- `summary` is one sentence, at most 140 characters. Text fields are plain strings (no Markdown or HTML).
