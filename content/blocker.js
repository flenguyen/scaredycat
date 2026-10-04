/**
 * Scaredy Cat - Content Blocker
 * Handles the visual blocking of horror content.
 *
 * DOM shape of a block:
 *   <div>                      wrapper, in the page's DOM; layout is inline !important
 *     #shadow-root (closed)    the card, unreachable from the page
 *       .scaredycat-wrapper.scaredycat-frame   size container (blur-overlay.css)
 *         <slot>               renders the blocked element
 *         .scaredycat-overlay  scrim + card  (or, once revealed: Hide again /
 *                              This isn't horror)
 *     <img>                    the blocked element, hidden by inline !important styles
 * The page can't read the card, can't .click() its buttons, and every handler
 * ignores synthetic events anyway. All per-block state (including a blanked
 * iframe's src) lives in this file's closures, never in attributes.
 */

const ScaredyCatBlocker = (function () {
  // Track blocked elements for stats
  const blockedElements = new Map(); // id -> entry
  const revealedElements = new Set();

  // Our wrappers, and each one's entry. Wrapper membership is checked here,
  // never by class name or attribute, which a page could plant to make us
  // skip its own media.
  const wrappers = new WeakSet();
  const wrapperData = new WeakMap();

  // Iframes we blanked -> their real src. Restored only from here.
  const blankedIframes = new Map();
  // Videos we paused -> { guard, autoplay, volume, muted } to undo on reveal.
  const pausedVideos = new WeakMap();

  // Re-entrancy guard for the horror-page video cascade: stopAllPageVideos()
  // creates overlays, and each of those must not re-run the page-wide scan.
  let cascading = false;

  // Reveal choreography: element opacity and scrim ease out together over
  // this window (mirrors the 250ms transitions in blur-overlay.css).
  const REVEAL_MS = 250;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Called when an entry is added, so content.js can arm its periodic prune.
  let onEntryAdded = null;

  // Assistive tech: a blurred image's alt text must not be read aloud, and a
  // blurred <video controls> must leave the tab order. Host pages often mark
  // images aria-hidden themselves, so the prior values are stored and restored.
  function hideFromAT(element, data) {
    if (data) {
      data.prevAriaHidden = element.getAttribute('aria-hidden');
      data.prevInert = element.hasAttribute('inert');
    }
    element.setAttribute('aria-hidden', 'true');
    element.setAttribute('inert', '');
  }
  function restoreAT(element, data) {
    if (data?.prevAriaHidden != null) element.setAttribute('aria-hidden', data.prevAriaHidden);
    else element.removeAttribute('aria-hidden');
    if (!data?.prevInert) element.removeAttribute('inert');
  }

  // ---- Stats and toolbar badge --------------------------------------------
  // New blocks are batched per page (one message per burst instead of one per
  // element). Every message carries the page's live hidden count, so the
  // worker sets the badge to an absolute number instead of reading it back.
  const MAX_INCREMENT = 200;
  const MAX_PAGE_COUNT = 100000;
  let pendingBlockedCount = 0;
  let lastSentPageCount = -1;
  let badgeTimer = null;

  function hiddenCount() {
    let n = 0;
    blockedElements.forEach((data) => {
      if (!data.revealed && data.wrapper.isConnected) n++;
    });
    return Math.min(n, MAX_PAGE_COUNT);
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch (e) {
      // Extension context may be invalidated
    }
  }

  function flushBadge() {
    clearTimeout(badgeTimer);
    badgeTimer = null;
    const pageCount = hiddenCount();
    if (pendingBlockedCount > 0) {
      while (pendingBlockedCount > 0) {
        const count = Math.min(pendingBlockedCount, MAX_INCREMENT);
        pendingBlockedCount -= count;
        send({ type: 'INCREMENT_BLOCKED', count, pageCount });
      }
    } else if (pageCount !== lastSentPageCount) {
      send({ type: 'SET_BADGE', pageCount });
    }
    lastSentPageCount = pageCount;
  }
  function scheduleBadge(delay) {
    if (!badgeTimer) badgeTimer = setTimeout(flushBadge, delay);
  }
  function noteBlocked() {
    pendingBlockedCount++;
    scheduleBadge(1000);
  }
  window.addEventListener('pagehide', () => {
    if (pendingBlockedCount) flushBadge();
  });

  // Page-wide media spillover (covering videos/iframes that were NOT themselves
  // judged horror) is only appropriate on a genuine horror page — a dedicated
  // title/trailer page whose document.title or URL matches a horror title with
  // definite strength. On social feeds (LinkedIn, etc.) this is always false,
  // so each post's media is judged on its own and unrelated videos are never
  // blanketed. Mirrors the strict signal used to lower the image block bar.
  function isHorrorPage() {
    const detector = window.ScaredyCatDetector;
    return !!(detector && detector.hasPageHorrorSignal && detector.hasPageHorrorSignal());
  }

  /**
   * Start fetching the card stylesheet while a classification is in flight,
   * so the first card renders styled on its first frame. Pages that never
   * classify pay nothing. Fonts wait for the first actual card.
   */
  function warmUi() {
    ScaredyCatUI.loadSheets();
  }

  // ---- Card shadow root ----------------------------------------------------
  // Adopted synchronously with the root, before the worker's sheets arrive:
  // the frame fills the wrapper and the scrim is opaque from the first frame.
  // Until the full sheet lands the card itself stays invisible rather than
  // rendering as unstyled text. (The blocked element is hidden by its own
  // inline styles either way.)
  const CARD_PRE_CSS = `
.scaredycat-frame { position: relative; display: block; width: 100%; height: 100%; overflow: hidden; border-radius: inherit; }
.scaredycat-overlay { position: absolute; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: rgba(20, 20, 30, 0.97); border-radius: inherit; }
.scaredycat-frame:not(.scaredycat-styled) .scaredycat-message,
.scaredycat-frame:not(.scaredycat-styled) button { visibility: hidden; }
`;
  // After blur-overlay.css / feedback.css. The frame is styled there as
  // .scaredycat-wrapper (tokens, size container); here it fills the host.
  // The light-DOM wrapper is the host, so hover/focus on the revealed
  // element shows the pills through :host() as well.
  const CARD_POST_CSS = `
.scaredycat-frame { display: block; width: 100%; height: 100%; border-radius: inherit; }
:host(:hover) .scaredycat-hide-again-btn,
:host(:focus-within) .scaredycat-hide-again-btn { opacity: 1; }
:host(:hover) .scaredycat-fp-link,
:host(:focus-within) .scaredycat-fp-link { opacity: 0.85 !important; }
:host .scaredycat-fp-link:hover,
:host .scaredycat-fp-link.scaredycat-fp-link--done { opacity: 1 !important; }
`;

  // ---- Blocked element styles ------------------------------------------------
  // Inline !important, so no page stylesheet can override them and nothing is
  // injected into the page's CSS. Opacity 0 under the 0.97 scrim: nothing of
  // the frame leaks, so there is no blur filter to pay for.
  const BLOCKED_STYLE = { opacity: '0', 'pointer-events': 'none', transition: 'none' };
  // Layout hints that make the element fill its wrapper. These only fill
  // gaps: a page's own inline value wins, as it did over the old class rules.
  const BLOCKED_LAYOUT = {
    IMG: { display: 'block', width: '100%', height: 'auto' },
    VIDEO: { display: 'block', width: '100%' },
    IFRAME: { display: 'block', width: '100%', position: 'relative' }
  };

  function applyBlockedStyle(element, data) {
    const s = element.style;
    if (!s) return;
    const saved = {};
    for (const [prop, value] of Object.entries(BLOCKED_STYLE)) {
      saved[prop] = [s.getPropertyValue(prop), s.getPropertyPriority(prop)];
      s.setProperty(prop, value, 'important');
    }
    const layout = BLOCKED_LAYOUT[element.tagName];
    if (layout) {
      for (const [prop, value] of Object.entries(layout)) {
        if (s.getPropertyValue(prop)) continue;
        saved[prop] = ['', ''];
        s.setProperty(prop, value);
      }
    }
    data.savedStyle = saved;
  }

  /**
   * Put the element's own inline styles back. With `animate`, opacity eases
   * in over REVEAL_MS (the transition is set in the same style change as the
   * opacity, so it runs) and the element's own transition is restored after.
   */
  function restoreBlockedStyle(element, data, animate) {
    const saved = data.savedStyle;
    if (!saved || !element.style) return;
    data.savedStyle = null;
    const s = element.style;
    for (const [prop, [value, priority]] of Object.entries(saved)) {
      if (prop === 'transition' && animate) continue;
      if (value) s.setProperty(prop, value, priority);
      else s.removeProperty(prop);
    }
    if (animate) {
      s.setProperty('transition', `opacity ${REVEAL_MS}ms ease-out`, 'important');
      data.revealTransition = saved.transition;
    }
  }

  function settleRevealTransition(element, data) {
    const prev = data.revealTransition;
    if (!prev) return;
    data.revealTransition = null;
    const [value, priority] = prev;
    if (value) element.style.setProperty('transition', value, priority);
    else element.style.removeProperty('transition');
  }

  // ---- Card rendering ----------------------------------------------------
  // Card states: 'blocked' | 'confirm' | 'synopsis'. "Revealed" is the
  // absence of an overlay (revealEntry removes it).

  // Must match the large @container tier in styles/blur-overlay.css.
  const LARGE_TIER = { width: 360, height: 220 };

  function isLargeTier(wrapper) {
    return wrapper.offsetWidth >= LARGE_TIER.width &&
      wrapper.offsetHeight >= LARGE_TIER.height;
  }

  function makeText(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
  }

  function makeButton(label, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      // Real clicks only: a page can't reveal or report by dispatching one.
      if (!e.isTrusted) return;
      // Cards often sit inside <a> wrappers: never let clicks through.
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  // Spoiler summaries live in the worker (background/synopses.js, served by
  // the website), not in the title database. One request per title + year per
  // page: a grid of 20 trailer cards for one film shares a single promise,
  // null results included.
  const synopsisRequests = new Map();

  function requestSynopsis(info) {
    const key = `${info.title}|${info.year ?? ''}`;
    let pending = synopsisRequests.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'GET_SYNOPSIS',
            title: info.title,
            year: info.year,
            tmdb: info.tmdb,
            mediaType: info.type
          });
          return res && typeof res.text === 'string' && res.text ? res : null;
        } catch (e) {
          return null; // extension context invalidated / worker unreachable
        }
      })();
      synopsisRequests.set(key, pending);
    }
    return pending;
  }

  /**
   * Resolve the summary for a block, once, right after block time. The card
   * renders without it; when the worker answers, the spoil buttons are added
   * in place. Stored on the entry so re-renders (and re-hides) never change it.
   */
  function resolveSynopsis(data) {
    const detector = window.ScaredyCatDetector;
    if (!detector || !detector.getTitleInfo) return;
    // Only blocks tied to a recognized title get a summary (and therefore the
    // "Just tell me what happens" affordance). General horror with no identified
    // movie/show — a blog article about the genre, a video essay on horror, a
    // genre-listing poster — has nothing specific to spoil, so it just stays
    // blurred. We key strictly on THIS element's own title match: a page that
    // merely names one movie must not attach that movie's summary to unrelated
    // horror imagery on it.
    const title = data.analysisResult?.matchedTitle;
    if (!title) return;
    const info = detector.getTitleInfo(title, data.analysisResult.context);
    if (!info) return;
    requestSynopsis(info).then((res) => {
      if (!res || data.synopsisInfo || !data.wrapper.isConnected) return;
      data.synopsisInfo = { kind: 'title', title: res.title || info.title, year: res.year || null, text: res.text };
      // Revealed meanwhile: stored for the next re-hide, nothing to update.
      const overlay = data.overlay;
      if (data.cardState === 'blocked' && overlay?.isConnected &&
          !overlay.classList.contains('scaredycat-fade-out')) {
        const actions = overlay.querySelector('.scaredycat-actions');
        if (actions) appendSpoilButtons(actions, data);
      }
    });
  }

  /**
   * The blocked card's "Just tell me what happens" pill (large tier) and "?"
   * pill (compact tiers). Appended to an existing card without a re-render, so
   * a late summary neither replays the entrance animation nor moves focus.
   */
  function appendSpoilButtons(actions, data) {
    actions.appendChild(makeButton('Just tell me what happens', 'scaredycat-btn scaredycat-btn--primary scaredycat-spoil-btn', () => {
      setCardState(data, 'synopsis');
    }));
    const helpBtn = makeButton('?', 'scaredycat-btn scaredycat-btn--primary scaredycat-help-btn', () => {
      setCardState(data, 'synopsis');
    });
    helpBtn.setAttribute('aria-label', 'Just tell me what happens');
    helpBtn.title = 'Just tell me what happens';
    actions.appendChild(helpBtn);
  }

  /**
   * Build the card for the current state. The blocked card renders both the
   * full (heading/subtext) and compact ("Content hidden") elements; container
   * queries in blur-overlay.css decide which set is visible per size tier.
   */
  function renderCard(data) {
    const { overlay } = data;
    overlay.dataset.state = data.cardState;
    // On the overlay (which persists across state swaps), not the message
    // (which is rebuilt): live regions only announce changes within them.
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('role', 'group');
    overlay.setAttribute('aria-label', 'Hidden by Scaredy Cat');
    // A state swap (blocked -> confirm -> synopsis) gets the quiet fade-in;
    // a fresh overlay gets the card entrance animation.
    const isSwap = overlay.childElementCount > 0;
    overlay.textContent = '';

    const message = document.createElement('div');
    message.className = 'scaredycat-message' + (isSwap ? ' scaredycat-message--swap' : '');

    if (data.cardState === 'confirm') {
      message.appendChild(makeText('span', 'scaredycat-icon', '🙀'));
      message.appendChild(makeText('p', 'scaredycat-heading', 'You sure? Be honest.'));
      message.appendChild(makeText('p', 'scaredycat-subtext', 'Statistically, you are not.'));
      const actions = document.createElement('div');
      actions.className = 'scaredycat-actions';
      actions.appendChild(makeButton('Yes. Show it.', 'scaredycat-btn scaredycat-btn--secondary', () => {
        revealEntry(data);
      }));
      actions.appendChild(makeButton('No. Tell me what happens.', 'scaredycat-btn scaredycat-btn--primary', () => {
        setCardState(data, 'synopsis');
      }));
      message.appendChild(actions);
    } else if (data.cardState === 'synopsis' && data.synopsisInfo) {
      const info = data.synopsisInfo;
      message.classList.add('scaredycat-message--synopsis');
      const title = makeText('p', 'scaredycat-syn-title', info.title);
      if (info.year) {
        const noun = data.element.tagName === 'IMG' ? 'poster' : 'trailer';
        title.appendChild(makeText('span', 'scaredycat-syn-meta', ` (${info.year}, ${noun})`));
      }
      message.appendChild(title);
      message.appendChild(makeText('p', 'scaredycat-syn-body', info.text));
      const actions = document.createElement('div');
      actions.className = 'scaredycat-actions';
      actions.appendChild(makeText('span', 'scaredycat-badge', '✅ Spoiled safely'));
      actions.appendChild(makeButton('← Back to the blur', 'scaredycat-btn scaredycat-btn--primary', () => {
        setCardState(data, 'blocked');
      }));
      message.appendChild(actions);
    } else {
      message.appendChild(makeText('span', 'scaredycat-icon', '🙀'));
      message.appendChild(makeText('p', 'scaredycat-heading', 'Something spooky was here.'));
      message.appendChild(makeText('p', 'scaredycat-subtext', "Blurred before it reached your eyes. You're welcome."));
      message.appendChild(makeText('span', 'scaredycat-text', 'Content hidden'));

      const actions = document.createElement('div');
      actions.className = 'scaredycat-actions';

      const showBtn = makeButton('', 'scaredycat-btn scaredycat-btn--secondary scaredycat-show-btn', () => {
        // The guilt-trip confirmation only fits (and only lands) on large
        // tiles, and only the first time around.
        if (data.synopsisInfo && !data.everRevealed && isLargeTier(data.wrapper)) {
          setCardState(data, 'confirm');
        } else {
          revealEntry(data);
        }
      });
      showBtn.title = 'Show anyway';
      showBtn.appendChild(makeText('span', 'scaredycat-btn-full', 'Show anyway'));
      showBtn.appendChild(makeText('span', 'scaredycat-btn-short', 'Show'));
      actions.appendChild(showBtn);

      if (data.synopsisInfo) appendSpoilButtons(actions, data);
      message.appendChild(actions);
    }

    overlay.appendChild(message);
  }

  /** Transition the card and move focus into the new state. */
  function setCardState(data, state) {
    if (!data.wrapper || !data.wrapper.isConnected || !data.overlay) return;
    data.cardState = state;
    renderCard(data);
    // Synopsis: focus "Back to the blur" so escape stays one keypress away.
    const focusTarget = state === 'synopsis'
      ? data.overlay.querySelector('.scaredycat-btn--primary')
      : data.overlay.querySelector('.scaredycat-btn');
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  }

  /** A fresh overlay in the 'blocked' state, inside the entry's frame. */
  function mountOverlay(data) {
    const overlay = document.createElement('div');
    overlay.className = 'scaredycat-overlay';
    overlay.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      if (e.key === 'Escape' && data.cardState !== 'blocked') {
        e.stopPropagation();
        setCardState(data, 'blocked');
      }
    });
    data.overlay = overlay;
    data.cardState = 'blocked';
    renderCard(data);
    data.frame.appendChild(overlay);
    return overlay;
  }

  /** The wrapper this element is blocked in, or null. */
  function wrapperOf(element) {
    const parent = element && element.parentNode;
    return parent && wrappers.has(parent) ? parent : null;
  }

  /** True if `node` is one of our wrappers or sits inside one. */
  function isInsideWrapper(node) {
    // Nothing blocked (the common case): no ancestor walk per mutation.
    if (!blockedElements.size) return false;
    for (let n = node; n; n = n.parentNode) {
      if (wrappers.has(n)) return true;
    }
    return false;
  }

  /**
   * Create a blur overlay for an element
   */
  function createBlurOverlay(element, analysisResult) {
    // Check if element is still in DOM
    if (!element.parentNode) return null;

    // Check if already wrapped
    if (isInsideWrapper(element)) return null;

    // Brand type for the card; the first block of a page fetches it.
    ScaredyCatUI.ensureFonts();
    // An early-hidden poster gets its own inline opacity back first; the
    // blocked styles below hide it again in the same task.
    window.__scaredycatRevealElement?.(element);

    // Create wrapper container
    const wrapper = document.createElement('div');
    const setWrapper = (prop, value) => wrapper.style.setProperty(prop, value, 'important');

    // Read phase (one style + layout flush), then write phase below.
    const computed = getComputedStyle(element);
    const originalDisplay = computed.display;
    // Rounded host thumbnails keep their corners: the wrapper is sized to the
    // element's box, so px and % radii both carry over unchanged.
    const radius = computed.borderRadius;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    // The rules blur-overlay.css used to give .scaredycat-wrapper, inline: no
    // page stylesheet can override them and nothing is added to page CSS.
    setWrapper('position', 'relative');
    setWrapper('display', originalDisplay === 'inline' ? 'inline-block' : originalDisplay);
    setWrapper('overflow', 'hidden');
    setWrapper('flex', 'none'); // a flex host must not shrink or stretch it
    setWrapper('vertical-align', 'top');
    setWrapper('isolation', 'isolate');
    setWrapper('background', '#14141e');
    setWrapper('container-type', 'size');
    setWrapper('width', width + 'px');
    setWrapper('height', height + 'px');
    if (radius && radius !== '0px') setWrapper('border-radius', radius);

    // An absolutely positioned element takes no part in its parent's flow
    // (IMDb slates: a flex host holding an `inset: 0` img). Wrapping it in an
    // in-flow block turns the wrapper into a flex item that gets squeezed to
    // half the host, so the blur covered only half the thumbnail. The wrapper
    // takes over the element's positioning instead; the element then fills
    // the wrapper, which stretches with the host when both insets are set.
    const position = computed.position;
    if (position === 'absolute' || position === 'fixed') {
      setWrapper('position', position);
      setWrapper('top', computed.top);
      setWrapper('right', computed.right);
      setWrapper('bottom', computed.bottom);
      setWrapper('left', computed.left);
      if (computed.zIndex !== 'auto') setWrapper('z-index', computed.zIndex);
      if (computed.left !== 'auto' && computed.right !== 'auto') wrapper.style.removeProperty('width');
      if (computed.top !== 'auto' && computed.bottom !== 'auto') wrapper.style.removeProperty('height');
    }

    // The card lives in a closed shadow root on the wrapper; a <slot> renders
    // the blocked element (still a light-DOM child) inside the frame.
    const frame = document.createElement('div');
    frame.className = 'scaredycat-wrapper scaredycat-frame';
    frame.appendChild(document.createElement('slot'));
    const root = ScaredyCatUI.attach(wrapper, {
      kinds: ['overlay', 'feedback'],
      pre: CARD_PRE_CSS,
      post: CARD_POST_CSS,
      onStyled: () => frame.classList.add('scaredycat-styled')
    });
    root.appendChild(frame);

    const id = generateId();
    const data = {
      id,
      element,
      wrapper,
      frame,
      overlay: null,
      analysisResult,
      cardState: 'blocked',
      synopsisInfo: null, // filled in by resolveSynopsis once the worker answers
      everRevealed: false,
      revealed: false,
      timestamp: Date.now(),
      wasPlaying: false,
      wasMuted: false,
      stoppedIframes: [],
      stoppedVideos: [],
      prevAriaHidden: null,
      prevInert: false,
      savedStyle: null,
      revealTransition: null,
      controls: [],
      cancelReveal: null
    };
    wrappers.add(wrapper);
    wrapperData.set(wrapper, data);

    // The card itself is built by the shared renderer (same path as re-hiding).
    mountOverlay(data);

    // Insert wrapper before element, then move the element into it
    element.parentNode.insertBefore(wrapper, element);
    wrapper.appendChild(element);

    // Hide the element itself (lands instantly: no transition on add)
    applyBlockedStyle(element, data);
    hideFromAT(element, data);

    // Handle video elements - pause and mute them
    if (element.tagName === 'VIDEO') {
      data.wasPlaying = isVideoPlaying(element);
      data.wasMuted = element.muted;
      pauseVideo(element);
    }

    // Handle iframe elements - blank the src to stop playback
    if (element.tagName === 'IFRAME') {
      blankIframe(element);
    }

    // Also check for videos inside nested elements
    const nestedVideos = element.querySelectorAll ? element.querySelectorAll('video') : [];
    nestedVideos.forEach(v => pauseVideo(v));

    // Find and stop ALL videos/iframes near the blocked element by walking up
    // to the surrounding media container. This intentionally reaches broad
    // containers (section/article/main), so it only runs on a genuine horror
    // page — on a social feed `main` is the whole feed and this would blank
    // every unrelated post's media.
    const containerSelectors = [
      '[class*="player"]', '[class*="video"]', '[class*="trailer"]', '[class*="media"]',
      '[class*="hero"]', '[class*="slate"]', '[data-testid*="video"]', '[data-testid*="hero"]',
      'section', 'article', 'main'
    ];

    let container = null;
    if (isHorrorPage()) {
      for (const selector of containerSelectors) {
        container = element.closest(selector);
        if (container) break;
      }

      // Fallback: go up 5 levels in the DOM
      if (!container) {
        container = element.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;
      }
    }

    if (container) {
      // Stop all videos in the container
      container.querySelectorAll('video').forEach(v => {
        if (!isInsideWrapper(v)) {
          pauseVideo(v);
          data.stoppedVideos.push(v);
        }
      });

      // Blank all iframes in the container (YouTube embeds, etc.)
      const containerIframes = container.querySelectorAll('iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="player"], iframe[src*="video"]');
      containerIframes.forEach(iframe => {
        if (!isInsideWrapper(iframe) && blankIframe(iframe)) {
          data.stoppedIframes.push(iframe);
        }
      });
    }

    // Store reference for stats and management
    blockedElements.set(id, data);
    window.ScaredyCatPerf?.mark('sc:blur');
    noteBlocked();
    if (onEntryAdded) onEntryAdded();
    resolveSynopsis(data);

    // On a genuine horror page, aggressively stop all videos on the page —
    // the player may live in a completely different DOM location than the
    // matched element. This is gated on the page-level signal so a single
    // block in a social feed never blankets unrelated posts' videos. The
    // cascade's own overlays skip this block (re-entrancy guard), so it runs
    // once per trigger instead of once per video.
    if (analysisResult?.isHorror && isHorrorPage() && !cascading) {
      cascading = true;
      try {
        stopAllPageVideos();
        // Also set up ongoing monitoring since videos may load/play after blocking
        startVideoMonitor();
      } finally {
        cascading = false;
      }
    }

    return wrapper;
  }

  // ---- Media playback ------------------------------------------------------

  /** Blank an iframe, remembering its src here (never in an attribute). */
  function blankIframe(iframe) {
    const src = iframe.src;
    if (!src || src === 'about:blank') return false;
    blankedIframes.set(iframe, src);
    iframe.src = 'about:blank';
    return true;
  }

  function restoreIframe(iframe) {
    if (!blankedIframes.has(iframe)) return;
    const src = blankedIframes.get(iframe);
    blankedIframes.delete(iframe);
    iframe.src = src;
  }

  /**
   * Check if a video is currently playing
   */
  function isVideoPlaying(element) {
    if (element.tagName === 'VIDEO') {
      return !element.paused && !element.ended;
    }
    return false;
  }

  /**
   * Pause a video element and mute it. A play listener (ours, not the page's
   * onplay, which stays untouched) keeps it paused until releaseVideo.
   */
  function pauseVideo(video) {
    try {
      if (!pausedVideos.has(video)) {
        const guard = () => {
          try {
            video.pause();
            video.currentTime = 0;
          } catch (e) { /* transient media state */ }
        };
        video.addEventListener('play', guard);
        pausedVideos.set(video, {
          guard,
          autoplay: video.hasAttribute('autoplay'),
          volume: video.volume,
          muted: video.muted
        });
      }
      video.pause();
      video.muted = true;
      video.volume = 0;
      // autoplay is a boolean attribute: any value ("false" included) turns
      // it on, so it is removed outright and restored by releaseVideo.
      video.removeAttribute('autoplay');
      // Also set currentTime to 0 to reset
      video.currentTime = 0;
    } catch (e) {
      console.error('Scaredy Cat: Failed to pause video', e);
    }
  }

  /** Undo pauseVideo: drop our play guard, restore autoplay/volume/muted. */
  function releaseVideo(video) {
    const saved = pausedVideos.get(video);
    if (!saved) return;
    pausedVideos.delete(video);
    video.removeEventListener('play', saved.guard);
    try {
      video.volume = saved.volume;
      video.muted = saved.muted;
    } catch (e) { /* ignore */ }
    if (saved.autoplay) video.setAttribute('autoplay', '');
  }

  /**
   * Resume a video element
   */
  function resumeVideo(video, shouldPlay, wasMuted) {
    releaseVideo(video);
    try {
      video.muted = wasMuted || false;
      if (shouldPlay) {
        video.play().catch(() => {
          // Autoplay might be blocked, that's ok
        });
      }
    } catch (e) {
      console.error('Scaredy Cat: Failed to resume video', e);
    }
  }

  // ---- Reveal / hide again -----------------------------------------------

  /**
   * Reveal a blocked element (public: by element + wrapper)
   */
  function revealElement(element, wrapper) {
    const data = wrapperData.get(wrapper);
    if (data) revealEntry(data);
  }

  function revealEntry(data) {
    if (data.cancelReveal) data.cancelReveal(); // re-entrancy: finish any in-flight reveal first
    const { element } = data;

    const overlay = data.overlay?.isConnected ? data.overlay : null;
    data.overlay = null;
    // Keyboard-initiated reveals land on "Hide again" afterwards, so the
    // way back is one keypress away and visible (it shows on focus-within).
    const viaKeyboard = !!overlay?.querySelector(':focus-visible');
    const instant = reducedMotion.matches;

    // One coordinated motion: the element's opacity eases in over the same
    // window as the scrim fade (the transition rides on the restored styles).
    restoreBlockedStyle(element, data, !instant);
    restoreAT(element, data);

    const finish = () => {
      settleRevealTransition(element, data);
      if (overlay) overlay.remove();
      data.cancelReveal = null;
    };
    if (instant || !overlay) {
      finish();
    } else {
      overlay.classList.add('scaredycat-fade-out');
      let done = false;
      let timer = null;
      const once = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        overlay.removeEventListener('transitionend', onEnd);
        finish();
      };
      const onEnd = (e) => {
        if (e.target === overlay && e.propertyName === 'opacity') once();
      };
      overlay.addEventListener('transitionend', onEnd);
      // Fallback: hidden tab, sheet not yet adopted, etc.
      timer = setTimeout(once, REVEAL_MS + 100);
      data.cancelReveal = once;
    }

    // Resume video if it was playing before
    if (element.tagName === 'VIDEO') {
      resumeVideo(element, data.wasPlaying, data.wasMuted);
    }

    // Restore iframe src if it was blanked
    if (element.tagName === 'IFRAME') restoreIframe(element);

    // Also check for nested videos
    const nestedVideos = element.querySelectorAll ? element.querySelectorAll('video') : [];
    nestedVideos.forEach(v => resumeVideo(v, false, false));

    // Restore any iframes and videos that were stopped in the container
    data.stoppedIframes.forEach(restoreIframe);
    data.stoppedIframes = [];
    data.stoppedVideos.forEach(releaseVideo);
    data.stoppedVideos = [];

    // Add "hide again" button
    addRevealedControls(data);
    if (viaKeyboard) {
      data.frame.querySelector('.scaredycat-hide-again-btn')?.focus({ preventScroll: true });
    }

    // Track revealed elements
    revealedElements.add(data.id);
    data.revealed = true;
    // Once they've seen it, re-confirming on every re-reveal is nagging.
    data.everRevealed = true;
    scheduleBadge(300);
  }

  /**
   * Add "Hide again" and "This isn't horror" to revealed content
   */
  function addRevealedControls(data) {
    removeRevealedControls(data);
    const hideBtn = document.createElement('button');
    hideBtn.className = 'scaredycat-hide-again-btn';
    hideBtn.type = 'button';
    hideBtn.textContent = '🙀 Hide again';

    hideBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      hideEntryAgain(data);
    });

    data.frame.appendChild(hideBtn);
    data.controls.push(hideBtn);
    addFalsePositiveLink(data);
  }

  function removeRevealedControls(data) {
    data.controls.forEach(node => node.remove());
    data.controls = [];
  }

  /**
   * Build the feedback report payload for one tracked element. The worker fills
   * in ids/versions/trimmed URL; here we only describe what we matched.
   */
  function buildReport(type, element, analysisResult) {
    const kind = element.tagName === 'IMG' ? 'image'
      : element.tagName === 'VIDEO' ? 'video'
      : element.tagName === 'IFRAME' ? 'iframe' : 'other';
    return {
      type,
      element: {
        // A blanked iframe reports its real src, not about:blank.
        src: blankedIframes.get(element) || element.src || element.poster || '',
        kind,
        matchedTitle: analysisResult?.matchedTitle || null,
        confidence: analysisResult?.confidence || 0,
        band: analysisResult?.band || '',
        reasons: analysisResult?.reasons || []
      }
    };
  }

  /**
   * Low-key, opt-in correction affordance shown only AFTER a reveal. Revealing
   * means "I want to see this" — frequently a correct blur — so this is the only
   * thing that signals a false positive. It never auto-appears over the blur and
   * never nags.
   */
  function addFalsePositiveLink(data) {
    const { element } = data;
    const link = document.createElement('button');
    link.className = 'scaredycat-fp-link';
    link.type = 'button';
    link.textContent = "This isn't horror";
    link.title = 'Tell us this was wrongly blurred';

    link.addEventListener('click', async (e) => {
      // A synthetic click must not be able to undo a user's report.
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      link.disabled = true;
      // A user-reported block is undone right away (it's their own report);
      // ML/text blocks stay signal-only, "Allow" is the explicit unblur.
      const reason = window.ScaredyCat?.USER_REPORTED_REASON;
      if (reason && data.analysisResult?.reasons?.includes(reason)) {
        window.ScaredyCat?.unblockReported?.(element.src || element.poster || '');
      }
      const report = buildReport('false_positive', element, data.analysisResult);
      const ok = await window.ScaredyCatFeedbackUI?.submit(report);
      if (ok) {
        link.textContent = 'Thanks, noted';
        link.classList.add('scaredycat-fp-link--done');
      } else {
        link.disabled = false;
      }
    });

    data.frame.appendChild(link);
    data.controls.push(link);
  }

  /**
   * Hide a previously revealed element again
   */
  function hideEntryAgain(data) {
    const { element } = data;
    removeRevealedControls(data);

    // A re-hide inside the reveal window must not leave a fading overlay
    // behind (the next reveal would find the stale one first).
    if (data.cancelReveal) data.cancelReveal();

    // Re-apply the hidden styles (instant: no transition on add)
    applyBlockedStyle(element, data);
    hideFromAT(element, data);

    // Pause video again if it's a video element
    if (element.tagName === 'VIDEO') {
      pauseVideo(element);
    }

    // Re-blank iframe src if it's an iframe
    if (element.tagName === 'IFRAME') {
      blankIframe(element);
    }

    const nestedVideos = element.querySelectorAll ? element.querySelectorAll('video') : [];
    nestedVideos.forEach(v => pauseVideo(v));

    // Re-create overlay through the shared renderer. The entry keeps the
    // summary resolved at block time (or the one that arrived while revealed).
    mountOverlay(data);

    // Update tracking
    revealedElements.delete(data.id);
    data.revealed = false;
    scheduleBadge(300);
  }

  /**
   * Remove blur completely (for allowlisted content or disabled extension)
   */
  function removeBlur(element) {
    const wrapper = wrapperOf(element);
    if (!wrapper) return;

    const data = wrapperData.get(wrapper);
    if (data?.cancelReveal) data.cancelReveal();

    // Move element back out of wrapper, then remove the wrapper
    if (wrapper.parentNode) {
      wrapper.parentNode.insertBefore(element, wrapper);
    }
    wrapper.remove();

    // Clean up element
    if (data) {
      restoreBlockedStyle(element, data, false);
      restoreAT(element, data);
      if (element.tagName === 'VIDEO') releaseVideo(element);
      if (element.tagName === 'IFRAME') restoreIframe(element);
      if (element.querySelectorAll) element.querySelectorAll('video').forEach(releaseVideo);
      data.stoppedIframes.forEach(restoreIframe);
      data.stoppedVideos.forEach(releaseVideo);
      blockedElements.delete(data.id);
      revealedElements.delete(data.id);
    }
    ScaredyCatState.clear(element);
    scheduleBadge(300);
  }

  /**
   * Remove all blurs on the page
   */
  function removeAllBlurs() {
    // Stop video monitoring
    stopVideoMonitor();

    // Iterate the tracking map, not document.querySelectorAll — wrappers
    // inside shadow roots are invisible to document-level queries.
    [...blockedElements.values()].forEach(data => {
      if (data.element) removeBlur(data.element);
    });
    blockedElements.clear();
    revealedElements.clear();

    // Restore all blanked iframes (from our own record of their src)
    [...blankedIframes.keys()].forEach(restoreIframe);
  }

  /**
   * Drop entries whose wrapper left the document (infinite feeds recycle
   * their DOM). Returns how many entries remain. Called from content.js's
   * periodic prune.
   */
  function pruneDetached() {
    let changed = false;
    blockedElements.forEach((data, id) => {
      if (!data.wrapper.isConnected) {
        blockedElements.delete(id);
        revealedElements.delete(id);
        changed = true;
      }
    });
    for (const iframe of [...blankedIframes.keys()]) {
      if (!iframe.isConnected) blankedIframes.delete(iframe);
    }
    if (changed) scheduleBadge(300);
    return blockedElements.size;
  }

  /**
   * Generate a unique ID for tracking
   */
  function generateId() {
    return 'sc-' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Get current blocked count for this page
   */
  function getBlockedCount() {
    return blockedElements.size;
  }

  /**
   * Get list of blocked items with details
   */
  function getBlockedItems() {
    const items = [];
    blockedElements.forEach((data, id) => {
      items.push({
        id,
        revealed: data.revealed || false,
        confidence: data.analysisResult?.confidence || 0,
        reasons: data.analysisResult?.reasons || [],
        context: data.analysisResult?.context || '',
        title: data.analysisResult?.matchedTitle || null,
        src: blankedIframes.get(data.element) || data.element?.src || data.element?.poster || ''
      });
    });
    return items;
  }

  /**
   * Get the tracked data for one blocked item (for allow/reveal by id)
   */
  function getBlockedData(id) {
    return blockedElements.get(id) || null;
  }

  /**
   * Get the still-connected wrapper elements for all blocked items. Used by the
   * YouTube preview guard to test whether the shared hover player overlaps a
   * blocked thumbnail.
   */
  function getBlockedWrappers() {
    const list = [];
    blockedElements.forEach((data) => {
      if (data.wrapper && data.wrapper.isConnected) list.push(data.wrapper);
    });
    return list;
  }

  /**
   * Reveal everything blocked on this page (session-only; the allowlist
   * is untouched and a rescan will block again)
   */
  function revealAll() {
    blockedElements.forEach((data) => {
      if (!data.revealed && data.element && data.wrapper?.isConnected) {
        revealEntry(data);
      }
    });
  }

  /**
   * Handle window resize - update wrapper sizes
   */
  function handleResize() {
    // Read every size first, then write: interleaving forces a layout per entry.
    const sizes = [];
    blockedElements.forEach((data) => {
      const { element, wrapper } = data;
      if (wrapper && element && wrapper.style.getPropertyValue('width')) {
        sizes.push([wrapper, element.offsetWidth, element.offsetHeight]);
      }
    });
    for (const [wrapper, w, h] of sizes) {
      wrapper.style.setProperty('width', w + 'px', 'important');
      if (wrapper.style.getPropertyValue('height')) wrapper.style.setProperty('height', h + 'px', 'important');
    }
  }

  function looksLikeVideoSrc(src) {
    return src.includes('youtube') || src.includes('vimeo') || src.includes('player') ||
      src.includes('video') || src.includes('embed');
  }

  /**
   * Stop all videos and video iframes on the page and cover them with blur overlay
   */
  function stopAllPageVideos() {
    // Stop and cover all video elements
    document.querySelectorAll('video').forEach(v => {
      if (!isInsideWrapper(v)) {
        pauseVideo(v);
        // Also create a blur overlay on the video
        createBlurOverlay(v, { isHorror: true, confidence: 100, reasons: ['Video on horror page'] });
      }
    });

    // Cover and blank all video iframes (YouTube, Vimeo, etc.)
    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.src || '';
      if (src && src !== 'about:blank' && looksLikeVideoSrc(src) && !isInsideWrapper(iframe)) {
        // Create blur overlay first, then blank the src
        createBlurOverlay(iframe, { isHorror: true, confidence: 100, reasons: ['Video iframe on horror page'] });
      }
    });
  }

  /**
   * Monitor for videos that start playing after initial block
   */
  let videoMonitorInterval = null;
  function startVideoMonitor() {
    // Don't start multiple monitors
    if (videoMonitorInterval) return;

    // Check every 500ms for 10 seconds for any uncovered videos
    let checks = 0;
    videoMonitorInterval = setInterval(() => {
      checks++;

      // Find and cover any videos not already wrapped
      document.querySelectorAll('video').forEach(v => {
        if (!isInsideWrapper(v)) {
          pauseVideo(v);
          createBlurOverlay(v, { isHorror: true, confidence: 100, reasons: ['Video on horror page'] });
        }
      });

      // Find and cover any video iframes not already wrapped
      document.querySelectorAll('iframe').forEach(iframe => {
        const src = blankedIframes.get(iframe) || iframe.src || '';
        if (!isInsideWrapper(iframe) && looksLikeVideoSrc(src)) {
          createBlurOverlay(iframe, { isHorror: true, confidence: 100, reasons: ['Video iframe on horror page'] });
        }
      });

      // Stop after 10 seconds (20 checks)
      if (checks >= 20) {
        clearInterval(videoMonitorInterval);
        videoMonitorInterval = null;
      }
    }, 500);
  }

  /**
   * Stop the video monitor (called when all blurs removed)
   */
  function stopVideoMonitor() {
    if (videoMonitorInterval) {
      clearInterval(videoMonitorInterval);
      videoMonitorInterval = null;
    }
  }

  // Listen for resize events
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(handleResize, 100);
  });

  // Public API
  return {
    createBlurOverlay,
    revealElement,
    revealAll,
    removeBlur,
    removeAllBlurs,
    pruneDetached,
    getBlockedCount,
    getBlockedItems,
    getBlockedData,
    getBlockedWrappers,
    buildReport,
    isBlocked: isInsideWrapper,
    isInsideWrapper,
    wrapperOf,
    warmUi,
    setEntryListener: (fn) => { onEntryAdded = fn; }
  };
})();

// Make available globally
window.ScaredyCatBlocker = ScaredyCatBlocker;
