/**
 * Scaredy Cat - ML Bridge
 * Content-script side of the image classification pipeline. Sends AMBIGUOUS
 * elements' image URLs to the background router and combines the returned
 * image score with the text result.
 */

const ScaredyCatMLBridge = (function () {
  'use strict';

  // Sticky per-page flag: once the background reports the classifier is
  // unavailable (model not bundled, offscreen failure), stop asking.
  let mlUnavailable = false;

  // Image scores arrive on a shared 0-100 scale: the offscreen classifier maps
  // each model's raw score through the calibration knots in
  // models/image-model.json, and these four bars are the anchors of that
  // mapping. So they are operating points, not scores of one model, and they
  // stay put when the model is swapped (eval/bakeoff/promote.mjs picks the
  // model's raw bar for each on the bake-off's validation images).
  //
  // Image evidence at/above this score blocks on its own when there is some
  // text signal (the bake-off's "block" bar: at most 5 of 192 hard-safe
  // validation posters, dark thrillers, action and family Halloween films,
  // reach it). The two classes overlap, so the bar is contextual: high on
  // neutral pages, lower when the page itself carries horror signal and weak
  // evidence may reinforce.
  const IMAGE_BLOCK_SCORE = 76;
  // On a page whose own title or URL says horror (at most 5% hard-safe false
  // blur on validation).
  const IMAGE_BLOCK_SCORE_HORROR_PAGE = 65;
  // With ZERO text signal on a neutral page, pixels carry the full burden of
  // proof: at most 2% hard-safe false blur on validation, so dark non-horror
  // posters (The Furious, Masters of the Universe class) must not block
  // image-only.
  const IMAGE_ONLY_BLOCK_SCORE = 80;
  // Image evidence at/below this score vetoes a non-definite text block. Set
  // where the veto still cancels at least 15 of 16 validation short-title
  // collision posters (The Devil Wears Prada class) while cancelling as little
  // real horror as possible, so moody horror posters don't veto weak-but-real
  // text signals.
  const IMAGE_VETO_SCORE = 40;
  // On a listing explicitly filtered to the Horror genre, the site has already
  // categorized every card as horror. The classifier is no longer the arbiter
  // of "is this horror"; it only needs to veto images that clearly AREN'T a
  // horror poster (site chrome, banners, a stray non-horror still). So the bar
  // drops to just above the veto line: anything not "clearly not horror"
  // blocks. This catches the modern/minimalist horror posters that score
  // between the veto and the 65 bar on these pages, while still letting an
  // obvious non-poster image (very low score) reveal.
  const IMAGE_BLOCK_SCORE_GENRE_LISTING = IMAGE_VETO_SCORE + 1;
  // Without image evidence (no pixels, fetch failed, ML unavailable), text
  // alone must be this strong to block. Weak short-title collisions
  // ("Freaky Friday" ~ "Freaky" = 62) stay below; keyword-stacked horror
  // text clears it.
  const UNVERIFIED_BLOCK_SCORE = 80;

  // The worker rejects longer URLs; such an element gets the no-pixels path.
  const MAX_URL_LENGTH = 2048;

  // Request counters, read by eval/browser-smoke-hostile.mjs over CDP.
  const stats = { requests: 0, scored: 0, throttled: 0 };

  /**
   * URL whose pixels represent this element, or null if there are none we
   * can classify. An embedded YouTube player draws its thumbnail inside the
   * cross-origin frame, so the frame is judged on that same thumbnail,
   * fetched by video id. Other iframes have no pixels we can reach.
   */
  function getClassifiableUrl(element) {
    const tag = element.tagName;
    let url = '';
    if (tag === 'IMG') url = element.currentSrc || element.src || '';
    else if (tag === 'VIDEO') url = element.poster || '';
    else if (tag === 'IFRAME' && typeof ScaredyCatCards !== 'undefined') {
      url = ScaredyCatCards.embedThumbnail(element.src) || '';
    }
    return /^https?:/.test(url) && url.length <= MAX_URL_LENGTH ? url : null;
  }

  /**
   * Ask the background for an image score (0-100). Resolves
   * { score, throttled }: score is null when the classifier can't help
   * (unavailable, fetch failure, invalid image). `throttled` means the
   * worker's rate limit turned the request away: no verdict this time, but
   * the classifier is fine and the caller may ask again later.
   */
  async function classify(url) {
    if (mlUnavailable) return { score: null, throttled: false };
    stats.requests++;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CLASSIFY_IMAGE', url });
      if (response?.success && typeof response.score === 'number') {
        stats.scored++;
        return { score: response.score, throttled: false };
      }
      if (response?.throttled) {
        stats.throttled++;
        return { score: null, throttled: true };
      }
      if (response?.unavailable) {
        mlUnavailable = true;
      }
      return { score: null, throttled: false };
    } catch (e) {
      // Extension context invalidated or background asleep mid-request.
      return { score: null, throttled: false };
    }
  }

  /**
   * Combine the text layer's result with image evidence into a final verdict.
   * Returns { isHorror, confidence, reasons }.
   */
  function combineVerdict(textResult, imageScore, opts = {}) {
    const reasons = [...(textResult.reasons || [])];

    if (imageScore === null) {
      // A card that labels itself horror blurs unless the picture clears it,
      // and a missing picture verdict clears nothing.
      if (textResult.selfLabel) {
        return { isHorror: true, confidence: textResult.confidence, reasons };
      }
      // No image evidence: only strong text blocks unverified, and text that
      // needs positive image confirmation (fragment title matches, weak
      // keywords) can never block without it.
      return {
        isHorror: textResult.isHorrorTextOnly &&
          !textResult.requiresPositiveImage &&
          textResult.confidence >= UNVERIFIED_BLOCK_SCORE,
        confidence: textResult.confidence,
        reasons
      };
    }

    reasons.push(`Image classifier: ${Math.round(imageScore)}%`);

    // Negative signal: the page's structured metadata files this single title
    // under a non-horror genre (Drama, Romance, ...) and nothing else on the
    // page says horror. With ZERO text evidence the classifier is the only
    // witness, and on a drama's own stills it is exactly the unreliable one
    // (Forrest Gump's trailer thumbnail read as 95% "jump scare"). Text-backed
    // elements (a listed title in the "more like this" rail) keep the normal
    // bars, so real horror still blocks here.
    if (opts.authoritativeNonHorrorGenre && textResult.confidence === 0 &&
        !opts.isHorrorGenreListing && !opts.authoritativeHorrorGenre) {
      return {
        isHorror: false,
        confidence: 0,
        reasons: [...reasons, 'Non-horror title page: image alone cannot block']
      };
    }

    // A horror-filtered listing AND a detail page whose structured metadata
    // authoritatively tags the title as horror both get the lowest bar: the
    // site's own data model asserts horror, so the classifier only needs to
    // veto images that clearly AREN'T a horror poster. This catches the
    // modern/minimalist posters that score 41-64 and slip the 65 detail-page
    // bar.
    // A card whose byline or description mentions horror (and whose title
    // doesn't) gets the horror-page bar: weak text, but text about this card.
    const blockScore = (opts.isHorrorGenreListing || opts.authoritativeHorrorGenre)
      ? IMAGE_BLOCK_SCORE_GENRE_LISTING
      : (opts.pageHasHorrorSignal || textResult.secondaryOnly)
        ? IMAGE_BLOCK_SCORE_HORROR_PAGE
        : (textResult.confidence === 0 ? IMAGE_ONLY_BLOCK_SCORE : IMAGE_BLOCK_SCORE);
    if (imageScore >= blockScore) {
      return {
        isHorror: true,
        confidence: Math.max(textResult.confidence, Math.round(imageScore)),
        reasons
      };
    }

    if (textResult.isHorrorTextOnly) {
      if (textResult.requiresPositiveImage) {
        // Fragment-of-another-title matches ("Freaky Friday" ~ "Freaky") and
        // weak keyword evidence carry the burden of proof: the image had to
        // CONFIRM (>= block bar, handled above) — merely "not vetoed" is not
        // enough. Reaching here means it didn't confirm.
        return {
          isHorror: false,
          confidence: textResult.confidence,
          reasons: [...reasons, 'Weak text signal without image confirmation']
        };
      }
      // Non-definite text blocks can be vetoed by clean image evidence.
      // This covers keyword stacks (LinkedIn/AI hype) and exact-bounded
      // short-title matches with mid-range posters. Only DEFINITE title
      // matches (>=85, which blur before ML ever runs) are immune.
      const vetoed = imageScore <= IMAGE_VETO_SCORE;
      return {
        isHorror: !vetoed,
        confidence: vetoed ? Math.round(imageScore) : textResult.confidence,
        reasons: vetoed ? [...reasons, 'Vetoed by image classifier'] : reasons
      };
    }

    return {
      isHorror: false,
      confidence: textResult.confidence,
      reasons
    };
  }

  return {
    getClassifiableUrl,
    classify,
    combineVerdict,
    UNVERIFIED_BLOCK_SCORE,
    isUnavailable: () => mlUnavailable,
    getStats: () => ({ ...stats })
  };
})();

window.ScaredyCatMLBridge = ScaredyCatMLBridge;
