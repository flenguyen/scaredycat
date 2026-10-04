# Scaredy Cat (extension)

Chrome MV3 extension that blurs horror pictures and trailers while you browse. Detection runs on the device: text scoring first, then a bundled image model for unclear cases. The website lives in the separate `scared-cat-web` repo. UI work follows [DESIGN.md](DESIGN.md).

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
