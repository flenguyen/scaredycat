# Title list pipeline

The extension's horror title list has two parts:

- **Curated** — `data/horror-database.json` in this repo. Hand-edited, reviewed,
  and the source of truth. It is also the copy bundled into the Web Store zip,
  so a fresh install always has it.
- **Auto** — horror movies and TV series pulled from TMDB every day and appended
  to the curated list as `auto: true` entries:

  ```json
  { "title": "…", "year": 2025, "variations": ["…"], "tmdb": 1234, "type": "movie", "auto": true }
  ```

## Where it runs

Generation and hosting live in the **scared-cat-web** repo (Vercel), not here:

1. A daily Vercel Cron (08:30 UTC) calls `/api/cron/refresh-titles`.
2. The refresh reads `data/horror-database.json` and this folder's
   `overrides.json` **from `main` on GitHub** (raw URLs), sweeps TMDB, and merges:
   curated keys verbatim, auto entries appended, sorted and hashed so an
   unchanged list produces identical bytes.
3. The merged file is stored in Vercel Blob and served at
   `https://www.scaredycat.app/api/titles/horror-database.json` with an ETag; repeat
   requests get `304 Not Modified`.
4. The extension (`background/db-updater.js`) fetches that URL once a day with
   `If-None-Match` and replaces its cached copy when the served list is at least
   as new as what it has (`background/db-version.js`). If the site is down, the
   last good copy (or the bundled curated file) stays in use.

So: edit curated titles here and merge to `main`; the next daily run picks the
change up. Nothing in this folder ships in the extension (`scripts/pack.mjs`
excludes `tools/`).

## How auto titles are kept safe

A bigger list means more chances for a title to collide with ordinary text, so
auto entries are matched on a separate path in `content/scoring-core.js`:

- Word-bounded exact n-gram lookup only (no substring, no fuzzy, no no-space
  URL-slug form), independent of list size.
- Title score capped at 79 (`AUTO_MAX_SCORE`): below the definite bar (85) and
  the text-only block bar (80). An auto match never blurs on the title alone
  and never sets the page-level horror signal.
- Short or single-word auto matches ("Together", "Obsession") need the image
  classifier to positively confirm. Distinctive multi-word titles (11+ chars)
  only need the image not to veto.
- Curated always wins: the generator skips auto titles whose normalized title
  equals a curated title/variation, safeTitle or keyword, and the scorer ignores
  any auto variant a curated entry already owns. Auto entries never carry
  `definite`.

## Editing `overrides.json`

Changes take effect on the next daily run after they reach `main`.

| Field | Use it to | Example |
| --- | --- | --- |
| `excludeTitles` | Drop an auto title that keeps colliding with normal text. Matched after normalization (case and punctuation ignored), any year. | `["Together"]` |
| `excludeTmdbIds` | Drop one specific TMDB item without affecting others with the same name. | `{ "movie": [12345], "tv": [] }` |
| `forceInclude` | Add a title TMDB doesn't file as horror, or one the sweep misses (it is included ahead of the size cap). `note` is for humans. | `[{ "type": "movie", "tmdbId": 12345, "note": "Leviticus" }]` |
| `extraVariations` | Add alternate names for an auto title, keyed `type:tmdbId`. Variations that collide with curated names are dropped. | `{ "movie:12345": ["alt title"] }` |

`note` at the top is free text and ignored by the pipeline.

To promote an auto title to curated (to add a `definite` flag or URL-slug
variations), add it to `data/horror-database.json` instead; the generator then
skips the auto copy automatically.

Spoiler summaries (the blur card's "Just tell me what happens") are not part of
either list. They are edited in Sanity and served by the website at
`/api/titles/synopses.json`; the extension's worker fetches that file on the
same alarm as the title list and matches summaries to blocked titles by TMDB id,
then name + year (see `background/synopses.js`).

## Testing a merged list locally

In scared-cat-web, write the merged list to a file without publishing:

```sh
npm run titles:refresh -- --dry-run --out /tmp/merged.json
```

Then, in this repo, point the evals at it with `SC_DB_PATH`:

```sh
SC_DB_PATH=/tmp/merged.json npm run lint:database   # auto-entry invariants
SC_DB_PATH=/tmp/merged.json npm run eval
SC_DB_PATH=/tmp/merged.json node eval/run-eval.mjs --definite-report
SC_CHROME_BIN=<chrome-for-testing> node eval/browser-latency.mjs --db /tmp/merged.json
```

`eval/auto-titles-test.mjs` (part of `npm run eval`) covers the scoring rules
above; `npm run smoke:remote-db` checks the live endpoint (200 then 304).

Title data from TMDB. This product uses TMDB and the TMDB APIs but is not
endorsed, certified, or otherwise approved by TMDB.
