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

  // Image evidence at/above this score blocks on its own.
  const IMAGE_BLOCK_SCORE = 70;
  // Image evidence at/below this score vetoes a keyword-only text block.
  const IMAGE_VETO_SCORE = 25;

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
  function combineVerdict(textResult, imageScore) {
    const reasons = [...(textResult.reasons || [])];

    if (imageScore === null) {
      // No image evidence: fall back to the legacy text-only decision.
      return {
        isHorror: textResult.isHorrorTextOnly,
        confidence: textResult.confidence,
        reasons
      };
    }

    reasons.push(`Image classifier: ${Math.round(imageScore)}%`);

    if (imageScore >= IMAGE_BLOCK_SCORE) {
      return {
        isHorror: true,
        confidence: Math.max(textResult.confidence, Math.round(imageScore)),
        reasons
      };
    }

    if (textResult.isHorrorTextOnly) {
      // Keyword-driven text blocks can be vetoed by clean image evidence —
      // this kills the LinkedIn/AI-hype false positives. Title matches are
      // never vetoed: horror posters often look innocuous.
      const vetoed = !textResult.titleMatched && imageScore <= IMAGE_VETO_SCORE;
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
    isUnavailable: () => mlUnavailable
  };
})();

window.ScaredyCatMLBridge = ScaredyCatMLBridge;
