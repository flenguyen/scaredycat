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

  // Image evidence at/above this score blocks on its own. Calibrated against
  // a poster corpus (eval/corpus.json + Wikipedia poster sweep): scariest
  // safe poster (Cape Fear) ~72, atmospheric horror (Hereditary) 74-81
  // depending on backend (WebGPU and CPU disagree by several points). The
  // two classes overlap, so the bar is contextual: high on neutral pages,
  // lower when the page itself carries horror signal and weak evidence may
  // reinforce. Dark action/fantasy posters (Mortal Kombat 34, White House
  // Down 0) sit far below either bar.
  const IMAGE_BLOCK_SCORE = 76;
  const IMAGE_BLOCK_SCORE_HORROR_PAGE = 65;
  // Image evidence at/below this score vetoes a non-definite text block.
  // Calibrated: Devil Wears Prada 37 / Mortal Kombat 34 must veto their
  // short-title collisions; moody horror posters (Nun 51, Insidious 59)
  // must not veto weak-but-real text signals.
  const IMAGE_VETO_SCORE = 40;
  // Without image evidence (no pixels, fetch failed, ML unavailable), text
  // alone must be this strong to block. Weak short-title collisions
  // ("Freaky Friday" ~ "Freaky" = 62) stay below; keyword-stacked horror
  // text clears it.
  const UNVERIFIED_BLOCK_SCORE = 80;

  /**
   * URL whose pixels represent this element, or null if there are none we
   * can classify (e.g. iframes).
   */
  function getClassifiableUrl(element) {
    const tag = element.tagName;
    if (tag === 'IMG') {
      const url = element.currentSrc || element.src || '';
      return /^https?:/.test(url) ? url : null;
    }
    if (tag === 'VIDEO') {
      const poster = element.poster || '';
      return /^https?:/.test(poster) ? poster : null;
    }
    return null;
  }

  /**
   * Ask the background for an image score (0-100). Resolves null when the
   * classifier can't help (unavailable, fetch failure, invalid image).
   */
  async function classifyUrl(url) {
    if (mlUnavailable) return null;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CLASSIFY_IMAGE', url });
      if (response?.success && typeof response.score === 'number') {
        return response.score;
      }
      if (response?.unavailable) {
        mlUnavailable = true;
      }
      return null;
    } catch (e) {
      // Extension context invalidated or background asleep mid-request.
      return null;
    }
  }

  /**
   * Combine the text layer's result with image evidence into a final verdict.
   * Returns { isHorror, confidence, reasons }.
   */
  function combineVerdict(textResult, imageScore, opts = {}) {
    const reasons = [...(textResult.reasons || [])];

    if (imageScore === null) {
      // No image evidence: only strong text blocks unverified.
      return {
        isHorror: textResult.isHorrorTextOnly && textResult.confidence >= UNVERIFIED_BLOCK_SCORE,
        confidence: textResult.confidence,
        reasons
      };
    }

    reasons.push(`Image classifier: ${Math.round(imageScore)}%`);

    const blockScore = opts.pageHasHorrorSignal
      ? IMAGE_BLOCK_SCORE_HORROR_PAGE
      : IMAGE_BLOCK_SCORE;
    if (imageScore >= blockScore) {
      return {
        isHorror: true,
        confidence: Math.max(textResult.confidence, Math.round(imageScore)),
        reasons
      };
    }

    if (textResult.isHorrorTextOnly) {
      // Non-definite text blocks can be vetoed by clean image evidence.
      // This covers keyword stacks (LinkedIn/AI hype) AND weak short-title
      // collisions: "Freaky Friday" matching "Freaky", "The Devil Wears
      // Prada" matching "Devil". Only DEFINITE title matches (>=85, which
      // blur before ML ever runs) are immune.
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
    classifyUrl,
    combineVerdict,
    UNVERIFIED_BLOCK_SCORE,
    isUnavailable: () => mlUnavailable
  };
})();

window.ScaredyCatMLBridge = ScaredyCatMLBridge;
