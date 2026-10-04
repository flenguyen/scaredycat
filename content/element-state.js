/**
 * Scaredy Cat - Element state
 * Every per-element verdict (blocked, allowed, safe, skip, pending, error)
 * lives here, in the content script's isolated world. Attributes on page
 * elements are page-writable and page-readable: a page could plant one to
 * make us skip an element, or read the user's allowlist and blocklist off
 * the values. A WeakMap is neither.
 *
 * The only DOM trace is a valueless `data-scaredycat-processed` marker, set
 * on media sites only (where early-init.js ran), because styles/early-block.css
 * keys on it to stop pre-hiding a poster once it has a final verdict. It says
 * "looked at", never what we decided, and nothing here ever reads it back.
 */

const ScaredyCatState = (function () {
  'use strict';

  const MARKER = 'data-scaredycat-processed';
  const states = new WeakMap(); // element -> { state, gen, safeGen }
  // The containers styles/early-block.css hides (keep in sync). A poster
  // container rendered after init is never scanned itself, so the verdict
  // on the image inside it is what lets it show.
  const EARLY_BLOCK_SELECTOR = '.ipc-media--poster, .ipc-poster, [data-testid="hero-media__slate"], ' +
    '[data-testid="hero-title-block__poster"], [data-qa="poster-image"]';

  function mark(el) {
    if (el && !el.hasAttribute(MARKER)) el.setAttribute(MARKER, '');
  }

  // Bulk resets without enumerating elements (a WeakMap can't be walked):
  // bumping a generation expires every older entry at once. resetAll() keeps
  // blocks (they are undone through the blocker, never by a rescan);
  // resetSafe() expires only 'safe' verdicts, for re-judging under a lower
  // image bar once the page-level horror signal turns on.
  let generation = 0;
  let safeGeneration = 0;

  function get(element) {
    const entry = states.get(element);
    if (!entry) return null;
    if (entry.state !== 'blocked' && entry.gen < generation) return null;
    if (entry.state === 'safe' && entry.safeGen < safeGeneration) return null;
    return entry.state;
  }

  function set(element, state) {
    states.set(element, { state, gen: generation, safeGen: safeGeneration });
    // Pending elements stay pre-hidden until their verdict lands.
    if (state !== 'pending' && window.__scaredycatMediaSite) {
      mark(element);
      if (element.parentElement) mark(element.parentElement.closest(EARLY_BLOCK_SELECTOR));
    }
  }

  return {
    get,
    set,
    has: (element) => get(element) !== null,
    clear: (element) => { states.delete(element); },
    resetAll: () => { generation++; },
    resetSafe: () => { safeGeneration++; }
  };
})();

window.ScaredyCatState = ScaredyCatState;
