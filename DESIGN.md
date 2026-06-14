# Scaredy Cat Design System

**This is the canonical reference for every Scaredy Cat surface** — the landing page, the extension popup, the in-page blur cards, and anything we build next (options page, onboarding, web app). If a screen doesn't trace back to this document, it isn't shipped.

---

## 1. The idea

Scaredy Cat stands between you and the jump scare, and it does it with a smile. The product's entire emotional job is **de-escalation**: the user just nearly saw something they didn't want to see, and what we show them instead must feel like a warm hand on the shoulder — never like antivirus software catching a threat.

So the visual language is a **warm picture book, not a security product.** Cream paper, deep plum ink, soft lavender washes, hand-stamped chips, an editorial serif for the spoilers. The 🙀 mascot carries the brand at every size. Horror itself is only ever represented as abstract blurred blobs — we never reproduce the frightening frame, not even stylized.

Three principles that decide every call:

1. **Calm is the feature.** Generous whitespace, low-saturation surfaces, one high-contrast moment per screen (the plum band). Nothing flashes, nothing pulses, nothing is red.
2. **Ink on paper.** Everything reads as plum ink printed on cream paper. Color is structural, not decorative — if a color doesn't carry meaning, it doesn't appear.
3. **Funny in the copy, straight in the chrome.** The personality lives in the words (and the mascot). The components themselves are disciplined and quiet so the jokes can land.

---

## 2. Tokens — the single source of truth

Ten lines. Everything is built from these and nothing else.

| Token group | Values |
|---|---|
| **Surfaces** | page cream `#FDF8F0` · card `#FFFCF5` · lavender `#F1EBFA` · numeral wash `#EFE8FA` |
| **Ink** | plum `#2E2447` · body `#54496E` · serif body `#42365E` · muted `#8D83A6` · on-dark `#C9BFE0` / `#A99BCB` |
| **CTA green** | `#1E7A52`, hover `#27895F`, cream text. **Install CTAs only. Never decoration.** |
| **Status** | success chip `#E7F2E7` on `#3E6E4A` · borders `rgba(46,36,71, 0.08–0.14)` · dashed stamp chips with ±1.5deg rotation |
| **Type** | Bricolage Grotesque 700/800 display · Inter 400–700 body and UI · Fraunces for spoiler text and italic asides |
| **Shape** | 999px pills for buttons and chips · 14–20px radii for cards · shadows `0 10px 30px rgba(46,36,71, 0.1–0.18)` |
| **Mascot** | 🙀 at every size. Horror imagery is always abstract blurred blobs, never the actual frame. |
| **Labels** | kickers: 0.72rem, 700, letterspaced 0.18em, `#8D83A6` · giant background numerals in `#EFE8FA` for stepped content |
| **Buttons** | primary: green pill (install only) · secondary: plum `#2E2447` pill, hover `#42365E` · ghost: 2px plum-tinted outline pill |
| **Spacing** | sections `clamp(64px, 9vw, 100px)` · content max 1040px · card grids gap 24px · dark plum band for final CTAs |

In code these live as `--sc-*` custom properties — see [popup/popup.css](popup/popup.css) (`:root` block, the reference implementation) and [styles/blur-overlay.css](styles/blur-overlay.css) (scoped to `.scaredycat-wrapper` so host-page CSS can't bleed in).

---

## 3. Type system

Three families, three jobs, no exceptions.

| Family | Role | Where it's allowed |
|---|---|---|
| **Bricolage Grotesque** 700–800 | Display. Headlines, the wordmark, hero numerals (the blocked count). | Anything that announces. Never body text, never below ~16px. |
| **Inter** 400–700 | The workhorse. All UI text, buttons, labels, settings, stats. | Everywhere functional. When in doubt, it's Inter. |
| **Fraunces** 400–700 (+italic) | The spoiler voice. Synopsis titles and body, italic asides, footer quips. | Editorial moments only. Fraunces appearing means "the product is talking to you, off the record." |

Kickers (section eyebrows like SENSITIVITY, HIDDEN ITEMS) are Inter 700, 0.72rem, 0.18em tracking, uppercase, muted `#8D83A6`.

**Fonts ship inside the extension** (`fonts/*.woff2`, latin subsets, ~272KB total — listed in `web_accessible_resources`). The popup declares them in `popup.css`; in-page overlays inject `@font-face` lazily via `ensureBrandFonts()` in [content/blocker.js](content/blocker.js), so pages that block nothing pay nothing. Every `font-family` carries system fallbacks (Georgia for Fraunces, the system sans for Inter/Bricolage) for hosts whose CSP blocks extension font fetches.

---

## 4. Components

**Card** — `#FFFCF5` on the `#FDF8F0` page, 1px border `rgba(46,36,71,.10)`, 14–20px radius, soft token shadow. Cards are paper; they never change color to convey state.

**Pill buttons** — all 999px radius.
- *Primary (green)*: install CTAs on the landing page exclusively. The extension contains no green buttons, ever.
- *Secondary (plum fill)*: the main action inside the product — "Show anyway," reveal confirmations. Hover `#42365E`, lift `translateY(-1px)`.
- *Ghost (2px plum-tinted outline)*: reversible or reluctant actions — "Disable on this site," "Back to the blur," the "?" affordance.

**Kicker** — the section eyebrow (spec in §3). Use it instead of bold headings inside cards.

**Success chip** — `#E7F2E7` background, `#3E6E4A` text, pill. For confirmed-good states: totals, "you're protected."

**Dashed stamp chip** — success-chip or lavender fill, 1.5px *dashed* border, rotated ±1.5deg. A hand stamp on the page: "Spoiled safely ✅," "Paused on this site." Reserve it for states the user caused — it reads as a mark left on purpose.

**Dark plum band** — solid `#2E2447`, cream display type, `#C9BFE0` supporting text. One per screen, maximum: the landing page's final CTA, the popup's blocked-count hero.

**Verdict Box** *(landing)* — card surface + kicker + dashed stamps + a Fraunces italic punchline.

**Cat-rating icons** *(landing)* — the 🙀 mascot repeated; unfilled cats dim to 18% opacity. Never stars.

**The blur card** *(in page)* — cream card centered on a near-black `rgba(20,20,30,.97)` scrim over the blurred element. Container-query tiers adapt the *layout* (full card → compact → emoji-only → horizontal banner) but never the language. The synopsis state switches to left-aligned Fraunces — the editorial voice taking over. The card stays cream even on dark sites; the scrim supplies contrast, and the cream card *is* the brand.

---

## 5. Voice & motion

**Voice** — reassuring-funny, never mocking the user for being scared (see [context/persona.md](context/persona.md)). The interface speaks plainly ("3 items hidden on this page"); the *asides* carry the wit, in Fraunces italic ("Keeping you safe from spooky stuff! 👻").

**Motion** — 150–300ms, simple `ease`/`ease-out`, opacity and small translates/scales only (the overlay enters at `scale(.95)→1`). Hover lift is −1px. Nothing bounces, spins, or attention-seeks — this product lowers heart rates. `prefers-reduced-motion` is honored on every surface, no exceptions; `prefers-contrast: high` gets real borders.

---

## 6. Rules

**Do**
- Trace every color, radius, and shadow to §2.
- Keep one dark plum moment per screen.
- Let the mascot 🙀 do the brand work.
- Use dashed stamps for user-caused states.
- Write the joke into the copy, not the chrome.

**Don't**
- Green outside an install CTA — green is conversion, plum is state.
- Red, orange, or warning yellow anywhere. The calmest possible product does not have alarm colors.
- Real horror imagery, ever — blurred abstract blobs only.
- Gradients. The old indigo→purple gradient is retired; surfaces are flat paper.
- Gray for disabled states — mute toward lavender/`#A99BCB` instead, staying in the plum family.
- More than one typeface per sentence.

---

## 7. Surface map

| Surface | What it borrows |
|---|---|
| **Popup** | Page cream body · plum band hero (count in Bricolage 800) · kickers · lavender active states · ghost pill site toggle · dashed stamp when paused · success chip for totals · Fraunces italic footer. The reference implementation: [popup/popup.css](popup/popup.css). |
| **Blur card (all tiers)** | Card surface on dark scrim · plum pill + ghost pill · Bricolage heading at the large tier. [styles/blur-overlay.css](styles/blur-overlay.css). |
| **Synopsis state** | Fraunces title/body in serif-body ink · Inter muted meta · "Spoiled safely" dashed stamp. |
| **Landing page** | The full set, including green install CTAs, giant `#EFE8FA` numerals, Verdict Box, cat ratings, dark plum final band. |
| **Future: options page / onboarding** | Page cream + cards + kickers; onboarding may use the giant background numerals for steps; final "you're all set" screen earns the plum band. Still zero green unless it's literally an install/upgrade action. |
