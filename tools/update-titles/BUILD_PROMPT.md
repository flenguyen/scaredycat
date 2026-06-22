# Build: TMDB-fed horror title-database updater (PR-based, weekly)

> Hand this file to a coding agent (e.g. Claude Code) run in the
> `flenguyen/scaredycat` repo. It is self-contained — it assumes no knowledge of
> the conversation that produced it. Do not run it from here; it is the spec for
> a follow-up task.

## What you're building
A simple, low-maintenance system that keeps the horror **title list** in
`data/horror-database.json` current by pulling new horror films from TMDB,
merging them in additively, and opening a **pull request** for review on a
weekly schedule. Optimize for simplicity: a single Node script + one GitHub
Actions workflow. No server, no database, no new runtime services.

## Why this exists (context)
The title list is one of three detection layers in the Scaredy Cat extension
(title DB → page genre metadata → ML poster classifier). On a movie **detail
page**, structured genre metadata catches new titles. But on a **homepage/grid**
(e.g. Rotten Tomatoes "Movies in Theaters"), tiles carry no per-card genre —
only the title and the poster — so the curated title list is the *only* reliable
per-card signal. Keeping that list fresh is what this system automates.

## Background you need
- `data/horror-database.json` is consumed by the Chrome extension, which fetches
  it daily from
  `https://raw.githubusercontent.com/flenguyen/scaredycat/main/data/horror-database.json`
  and reloads only when the top-level `version` (semver) or `lastUpdated` date is
  newer than what it has. So **every change must bump `version` (patch) and set
  `lastUpdated` to today (YYYY-MM-DD)**, or users won't pick it up.
- Schema (preserve every key):
  ```json
  {
    "version": "1.3.2",
    "lastUpdated": "2026-06-22",
    "safeTitlesNote": "<keep verbatim>",
    "safeTitles": ["Freaky Friday", "..."],
    "titles": [ { "title": "28 Days Later", "year": 2002, "variations": ["28dayslater","twenty eight days later"], "synopsis": "..." } ],
    "keywords": [ { "keyword": "horror", "weight": 30 } ],
    "fallbackSynopses": ["..."]
  }
  ```
  Only `title` + `year` are required per entry; `variations` and `synopsis` are
  optional (a few entries also carry `"type": "game"`). `keywords`, `safeTitles`,
  `fallbackSynopses`, and all existing `synopsis`/`variations` are
  **hand-curated** — the updater must NEVER modify, reorder, or delete them. It
  only **appends new `titles` entries**.
- Validation already exists: `npm run lint:database` (enforces safeTitles
  invariants) and `npm run eval`. Both must pass after any update.
- Matching note: a bare single-word title (e.g. "Obsession") is intentionally
  scored AMBIGUOUS (image-confirmed), not auto-block — so common-word titles are
  safe to add; the extension's image layer gates them. You do not need to mark
  them specially.

## The updater script (`tools/update-titles/index.mjs`)
1. Read `TMDB_API_KEY` from env (v3 key). Query TMDB Discover for horror:
   `GET https://api.themoviedb.org/3/discover/movie?with_genres=27&sort_by=primary_release_date.desc`
   paginating recent releases. Use built-in `fetch` (Node 20+) — no HTTP deps.
2. **Conservative inclusion filters** (the goal is quality, not volume — the
   extension also has genre-metadata + ML layers, so this list is mainly for
   cross-site name matching; bloat raises false positives):
   - released within a bounded window (e.g. since `lastUpdated` minus a small
     overlap; on a first/back-fill run go no further than ~3 years),
   - `vote_count >=` a threshold (propose a sensible default, e.g. 50) so
     obscure/unreleased entries are skipped,
   - skip adult titles.
3. For each candidate, build `{ title, year }` from TMDB `title` +
   `release_date` year. Generate `variations`: a punctuation-stripped slug and a
   spelled-out-number form when the title contains digits. Keep it minimal.
4. **Merge additively:**
   - Dedupe key = normalized(title) + year (lowercase, strip punctuation/
     whitespace). Skip any candidate already in `titles`.
   - Skip (and log) any candidate whose normalized title equals an entry in
     `safeTitles` — never add a horror title that collides with a known-safe one.
   - Append survivors to `titles`. Do not touch existing entries.
   - **Cap additions per run** (e.g. 200) so a TMDB anomaly can't flood the list;
     log when the cap is hit.
5. If nothing was added, exit 0 without writing (clean no-op — important so CI
   doesn't open empty PRs).
6. If titles were added: bump `version` patch, set `lastUpdated` to today, and
   write the file **deterministically** — stable key order, 2-space indent,
   trailing newline — so diffs stay small and reviewable.
7. After writing, run the validators (`npm run lint:database`, `npm run eval`)
   and fail the run if either fails (don't open a PR with invalid data).

## The GitHub Actions workflow (`.github/workflows/update-titles.yml`)
- Triggers: `schedule` (weekly cron) + `workflow_dispatch` (manual button).
- Steps: checkout, setup-node 20, `npm ci`, run the updater with
  `TMDB_API_KEY` from `secrets.TMDB_API_KEY`, run validators.
- If the file changed, open a PR with `peter-evans/create-pull-request`:
  branch like `auto/title-update`, title `Update horror titles (N added)`, body
  listing each added `title (year)`. If unchanged, the action is a no-op.
- Least-privilege `permissions:` (contents: write, pull-requests: write).
- Public-repo Actions minutes are free, so cadence/cost is not a concern.

## Docs (`tools/update-titles/README.md`)
Short: how to get a free TMDB v3 API key, add it as the `TMDB_API_KEY` repo
secret, and run the updater locally
(`TMDB_API_KEY=... node tools/update-titles/index.mjs`).

## Constraints
- Keep it minimal: ideally zero new runtime dependencies (the PR step is a CI
  action, not an npm dep). Pure, well-commented, readable merge logic.
- Additive only; never clobber curation; deterministic output; idempotent
  (re-running with no new titles changes nothing).
- Don't change the extension code or the schema.

## Acceptance criteria
- `TMDB_API_KEY=... node tools/update-titles/index.mjs` on a clean checkout adds
  recent horror titles, bumps version + lastUpdated, and the result passes
  `npm run lint:database` and `npm run eval`.
- Re-running immediately is a clean no-op (no diff, no PR).
- The scheduled workflow opens a reviewable PR listing the additions; merging it
  makes the raw URL serve the new version within a day.
