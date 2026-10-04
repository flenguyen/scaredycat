/**
 * Scaredy Cat - Content Blocker
 * Handles the visual blurring of horror content
 */

const ScaredyCatBlocker = (function () {
  // Track blocked elements for stats
  let blockedElements = new Map();
  let revealedElements = new Set();

  // Page stylesheets don't cross shadow boundaries: when we blur an element
  // living inside a shadow root (e.g. Rotten Tomatoes' rt-img components),
  // the overlay styles must be adopted into that root explicitly.
  const styledShadowRoots = new WeakSet();
  let overlayCssPromise = null;
  let sharedOverlaySheet = null; // one constructed sheet adopted by every shadow root
  let brandFontsInjected = false;

  // Re-entrancy guard for the horror-page video cascade: stopAllPageVideos()
  // creates overlays, and each of those must not re-run the page-wide scan.
  let cascading = false;

  // Reveal choreography: blur, element opacity and scrim ease out together
  // over this window (mirrors the 250ms transitions in blur-overlay.css).
  const REVEAL_MS = 250;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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

  // Blocked-count stats are batched per page (one storage write per burst
  // instead of one per element).
  let pendingBlockedCount = 0;
  let statsFlushTimer = null;
  function flushBlockedStats() {
    statsFlushTimer = null;
    if (!pendingBlockedCount) return;
    const count = pendingBlockedCount;
    pendingBlockedCount = 0;
    try {
      chrome.runtime.sendMessage({ type: 'INCREMENT_BLOCKED', count }).catch(() => {});
    } catch (e) {
      // Extension context may be invalidated
    }
  }
  function noteBlocked() {
    pendingBlockedCount++;
    if (!statsFlushTimer) statsFlushTimer = setTimeout(flushBlockedStats, 1000);
  }
  window.addEventListener('pagehide', flushBlockedStats);

  // @font-face only registers at document level (it is ignored inside
  // shadow-adopted stylesheets), so the brand fonts are injected once per
  // document — and only on pages that actually block something, keeping
  // unaffected pages at zero font cost. System stacks in blur-overlay.css
  // cover pages whose CSP blocks chrome-extension:// font fetches.
  const BRAND_FONTS = [
    { family: 'Bricolage Grotesque', style: 'normal', weight: '700 800', file: 'fonts/BricolageGrotesque.woff2' },
    { family: 'Inter', style: 'normal', weight: '400 700', file: 'fonts/Inter.woff2' },
    { family: 'Fraunces', style: 'normal', weight: '400 700', file: 'fonts/Fraunces.woff2' },
    { family: 'Fraunces', style: 'italic', weight: '400 700', file: 'fonts/Fraunces-Italic.woff2' },
  ];

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

  function ensureBrandFonts() {
    if (brandFontsInjected || !document.head) return;
    brandFontsInjected = true;
    const style = document.createElement('style');
    style.setAttribute('data-scaredycat-fonts', 'true');
    style.textContent = BRAND_FONTS.map(f => `@font-face {
  font-family: '${f.family}';
  font-style: ${f.style};
  font-weight: ${f.weight};
  font-display: swap;
  src: url('${chrome.runtime.getURL(f.file)}') format('woff2');
}`).join('\n');
    document.head.appendChild(style);
  }

  // Kick the (local, ~270KB) font fetch as soon as a classification request
  // is in flight, so the first card lands in brand type instead of swapping
  // from the system fallback a beat later. Pages that never classify pay
  // nothing; pages that classify almost always block within the fetch window.
  let fontsWarmed = false;
  function warmFonts() {
    if (fontsWarmed) return;
    fontsWarmed = true;
    ensureBrandFonts();
    try {
      if (document.fonts?.load) {
        document.fonts.load("600 14px 'Inter'").catch(() => {});
        document.fonts.load("700 20px 'Bricolage Grotesque'").catch(() => {});
        document.fonts.load("400 14px 'Fraunces'").catch(() => {});
      }
    } catch (e) { /* best effort */ }
  }

  function ensureStylesFor(element) {
    ensureBrandFonts();
    const root = element.getRootNode();
    if (!(root instanceof ShadowRoot) || styledShadowRoots.has(root)) return;
    styledShadowRoots.add(root);
    if (!overlayCssPromise) {
      overlayCssPromise = fetch(chrome.runtime.getURL('styles/blur-overlay.css'))
        .then(r => r.text())
        .catch(() => '');
    }
    overlayCssPromise.then(css => {
      if (!css) return;
      try {
        if (!sharedOverlaySheet) {
          sharedOverlaySheet = new CSSStyleSheet();
          sharedOverlaySheet.replaceSync(css);
        }
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sharedOverlaySheet];
      } catch (e) {
        // Constructable stylesheets unavailable: fall back to a <style> node.
        const style = document.createElement('style');
        style.textContent = css;
        root.appendChild(style);
      }
    });
  }

  // ---- Card rendering ----------------------------------------------------
  // Card states: 'blocked' | 'confirm' | 'synopsis'. "Revealed" is the
  // absence of an overlay (revealElement removes it).

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
        revealElement(data.element, data.wrapper);
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
          revealElement(data.element, data.wrapper);
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
    if (!data.wrapper || !data.wrapper.isConnected) return;
    data.cardState = state;
    renderCard(data);
    // Synopsis: focus "Back to the blur" so escape stays one keypress away.
    const focusTarget = state === 'synopsis'
      ? data.overlay.querySelector('.scaredycat-btn--primary')
      : data.overlay.querySelector('.scaredycat-btn');
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  }

  function attachEscapeHandler(overlay, data) {
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && data.cardState !== 'blocked') {
        e.stopPropagation();
        setCardState(data, 'blocked');
      }
    });
  }

  /**
   * Create a blur overlay for an element
   */
  function createBlurOverlay(element, analysisResult) {
    // Check if element is still in DOM
    if (!element.parentNode) return null;

    ensureStylesFor(element);

    // Check if already wrapped
    if (element.closest('.scaredycat-wrapper')) return null;

    // Create wrapper container
    const wrapper = document.createElement('div');
    wrapper.className = 'scaredycat-wrapper';
    wrapper.setAttribute('data-scaredycat-wrapper', 'true');

    // Read phase (one style + layout flush), then write phase below.
    const computed = getComputedStyle(element);
    const originalDisplay = computed.display;
    // Rounded host thumbnails keep their corners: the wrapper is sized to the
    // element's box, so px and % radii both carry over unchanged.
    const radius = computed.borderRadius;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    wrapper.style.width = width + 'px';
    wrapper.style.height = height + 'px';
    wrapper.style.display = originalDisplay === 'inline' ? 'inline-block' : originalDisplay;
    if (radius && radius !== '0px') wrapper.style.borderRadius = radius;

    // An absolutely positioned element takes no part in its parent's flow
    // (IMDb slates: a flex host holding an `inset: 0` img). Wrapping it in an
    // in-flow block turns the wrapper into a flex item that gets squeezed to
    // half the host, so the blur covered only half the thumbnail. The wrapper
    // takes over the element's positioning instead; the element then fills
    // the wrapper, which stretches with the host when both insets are set.
    const position = computed.position;
    if (position === 'absolute' || position === 'fixed') {
      wrapper.style.position = position;
      wrapper.style.top = computed.top;
      wrapper.style.right = computed.right;
      wrapper.style.bottom = computed.bottom;
      wrapper.style.left = computed.left;
      if (computed.zIndex !== 'auto') wrapper.style.zIndex = computed.zIndex;
      if (computed.left !== 'auto' && computed.right !== 'auto') wrapper.style.width = '';
      if (computed.top !== 'auto' && computed.bottom !== 'auto') wrapper.style.height = '';
    }

    // Create the blur overlay and its tracking entry; the card itself is
    // built by the shared renderer (same path as re-hiding).
    const overlay = document.createElement('div');
    overlay.className = 'scaredycat-overlay';

    const data = {
      element,
      wrapper,
      overlay,
      analysisResult,
      cardState: 'blocked',
      synopsisInfo: null, // filled in by resolveSynopsis once the worker answers
      everRevealed: false,
      timestamp: Date.now(),
      wasPlaying: false,
      wasMuted: false,
      originalSrc: null,
      stoppedIframes: [],
      prevAriaHidden: null,
      prevInert: false,
      cancelReveal: null
    };

    attachEscapeHandler(overlay, data);
    renderCard(data);

    // Insert wrapper before element
    element.parentNode.insertBefore(wrapper, element);

    // Move element into wrapper
    wrapper.appendChild(element);
    wrapper.appendChild(overlay);

    // Apply blur to the element itself (lands instantly: no transition on add)
    element.classList.add('scaredycat-blurred');
    hideFromAT(element, data);

    // Handle video elements - pause and mute them
    if (element.tagName === 'VIDEO') {
      data.wasPlaying = isVideoPlaying(element);
      data.wasMuted = element.muted;
      pauseVideo(element);
    }

    // Handle iframe elements - blank the src to stop playback
    if (element.tagName === 'IFRAME') {
      data.originalSrc = element.src;
      element.setAttribute('data-scaredycat-original-src', data.originalSrc);
      element.src = 'about:blank';
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
      const containerVideos = container.querySelectorAll('video');
      containerVideos.forEach(v => {
        if (!v.closest('.scaredycat-wrapper')) {
          pauseVideo(v);
        }
      });

      // Blank all iframes in the container (YouTube embeds, etc.)
      const containerIframes = container.querySelectorAll('iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="player"], iframe[src*="video"]');
      containerIframes.forEach(iframe => {
        if (!iframe.closest('.scaredycat-wrapper') && iframe.src && iframe.src !== 'about:blank') {
          const iframeSrc = iframe.src;
          iframe.setAttribute('data-scaredycat-original-src', iframeSrc);
          iframe.src = 'about:blank';
          data.stoppedIframes.push(iframe);
        }
      });
    }

    // Store reference for stats and management
    const id = generateId();
    wrapper.setAttribute('data-scaredycat-id', id);
    blockedElements.set(id, data);
    window.ScaredyCatPerf?.mark('sc:blur');
    noteBlocked();
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
   * Pause a video element and mute it
   */
  function pauseVideo(video) {
    try {
      video.pause();
      video.muted = true;
      video.volume = 0;
      // Remove autoplay to prevent it from starting again
      video.removeAttribute('autoplay');
      video.setAttribute('autoplay', 'false');
      // Also set currentTime to 0 to reset
      video.currentTime = 0;
      // Prevent future play attempts
      video.onplay = function() {
        this.pause();
        this.currentTime = 0;
      };
    } catch (e) {
      console.error('Scaredy Cat: Failed to pause video', e);
    }
  }

  /**
   * Resume a video element
   */
  function resumeVideo(video, shouldPlay, wasMuted) {
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

  /**
   * Reveal a blocked element
   */
  function revealElement(element, wrapper) {
    const id = wrapper.getAttribute('data-scaredycat-id');
    const data = blockedElements.get(id);
    if (data?.cancelReveal) data.cancelReveal(); // re-entrancy: finish any in-flight reveal first

    const overlay = data?.overlay?.isConnected
      ? data.overlay
      : wrapper.querySelector('.scaredycat-overlay:not(.scaredycat-fade-out)');
    // Keyboard-initiated reveals land on "Hide again" afterwards, so the
    // way back is one keypress away and visible (it shows on focus-within).
    const viaKeyboard = !!overlay?.querySelector(':focus-visible');
    const instant = reducedMotion.matches;

    // One coordinated motion: .scaredycat-revealing carries the transition
    // for the after-change style, so removing the blur class eases filter and
    // opacity out over the same window as the scrim fade.
    if (!instant) element.classList.add('scaredycat-revealing');
    element.classList.remove('scaredycat-blurred');
    restoreAT(element, data);

    const finish = () => {
      element.classList.remove('scaredycat-revealing');
      if (overlay) overlay.remove();
      if (data) data.cancelReveal = null;
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
      // Fallback: hidden tab, shadow-root sheet not yet adopted, etc.
      timer = setTimeout(once, REVEAL_MS + 100);
      if (data) data.cancelReveal = once;
    }

    // Resume video if it was playing before
    if (element.tagName === 'VIDEO') {
      resumeVideo(element, data?.wasPlaying, data?.wasMuted);
    }

    // Restore iframe src if it was blanked
    if (element.tagName === 'IFRAME' && data?.originalSrc) {
      element.src = data.originalSrc;
      element.removeAttribute('data-scaredycat-original-src');
    }

    // Also check for nested videos
    const nestedVideos = element.querySelectorAll ? element.querySelectorAll('video') : [];
    nestedVideos.forEach(v => resumeVideo(v, false, false));

    // Restore any iframes that were stopped in the container
    if (data?.stoppedIframes) {
      data.stoppedIframes.forEach(iframe => {
        const originalSrc = iframe.getAttribute('data-scaredycat-original-src');
        if (originalSrc) {
          iframe.src = originalSrc;
          iframe.removeAttribute('data-scaredycat-original-src');
        }
      });
    }

    // Add "hide again" button
    addHideAgainButton(element, wrapper);
    if (viaKeyboard) {
      wrapper.querySelector('.scaredycat-hide-again-btn')?.focus({ preventScroll: true });
    }

    // Track revealed elements
    revealedElements.add(id);

    // Update stored data
    if (data) {
      data.revealed = true;
      // Once they've seen it, re-confirming on every re-reveal is nagging.
      data.everRevealed = true;
    }
  }

  /**
   * Add a "Hide again" button to revealed content
   */
  function addHideAgainButton(element, wrapper) {
    const hideBtn = document.createElement('button');
    hideBtn.className = 'scaredycat-hide-again-btn';
    hideBtn.type = 'button';
    hideBtn.textContent = '🙀 Hide again';

    hideBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideElementAgain(element, wrapper);
    });

    wrapper.appendChild(hideBtn);
    addFalsePositiveLink(element, wrapper);
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
        src: element.src || element.poster || '',
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
  function addFalsePositiveLink(element, wrapper) {
    if (wrapper.querySelector('.scaredycat-fp-link')) return;
    const id = wrapper.getAttribute('data-scaredycat-id');
    const data = blockedElements.get(id);

    const link = document.createElement('button');
    link.className = 'scaredycat-fp-link';
    link.type = 'button';
    link.textContent = "This isn't horror";
    link.title = 'Tell us this was wrongly blurred';

    link.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      link.disabled = true;
      // A user-reported block is undone right away (it's their own report);
      // ML/text blocks stay signal-only, "Allow" is the explicit unblur.
      const reason = window.ScaredyCat?.USER_REPORTED_REASON;
      if (reason && data?.analysisResult?.reasons?.includes(reason)) {
        window.ScaredyCat?.unblockReported?.(element.src || element.poster || '');
      }
      const report = buildReport('false_positive', element, data?.analysisResult);
      const ok = await window.ScaredyCatFeedbackUI?.submit(report);
      if (ok) {
        link.textContent = 'Thanks, noted';
        link.classList.add('scaredycat-fp-link--done');
      } else {
        link.disabled = false;
      }
    });

    wrapper.appendChild(link);
  }

  /**
   * Hide a previously revealed element again
   */
  function hideElementAgain(element, wrapper) {
    const id = wrapper.getAttribute('data-scaredycat-id');

    // Remove hide button
    const hideBtn = wrapper.querySelector('.scaredycat-hide-again-btn');
    if (hideBtn) hideBtn.remove();

    // A re-hide inside the reveal window must not leave a fading overlay
    // behind (the next reveal would find the stale one first).
    const tracked = blockedElements.get(id);
    if (tracked?.cancelReveal) tracked.cancelReveal();
    element.classList.remove('scaredycat-revealing');

    // Re-apply blur (instant — no transition on add)
    element.classList.add('scaredycat-blurred');
    hideFromAT(element, tracked);

    // Pause video again if it's a video element
    if (element.tagName === 'VIDEO') {
      pauseVideo(element);
    }

    // Re-blank iframe src if it's an iframe
    if (element.tagName === 'IFRAME') {
      const originalSrc = element.src;
      if (originalSrc && originalSrc !== 'about:blank') {
        element.setAttribute('data-scaredycat-original-src', originalSrc);
        element.src = 'about:blank';
        // Update stored data with new src
        if (blockedElements.has(id)) {
          blockedElements.get(id).originalSrc = originalSrc;
        }
      }
    }

    const nestedVideos = element.querySelectorAll ? element.querySelectorAll('video') : [];
    nestedVideos.forEach(v => pauseVideo(v));

    // Re-create overlay through the shared renderer
    const overlay = document.createElement('div');
    overlay.className = 'scaredycat-overlay';

    // The tracked entry keeps the summary resolved at block time (or the one
    // that arrived while revealed). An untracked wrapper has no title match,
    // so no summary.
    const data = blockedElements.get(id) || {
      element,
      wrapper,
      analysisResult: null,
      synopsisInfo: null,
      everRevealed: true
    };
    data.overlay = overlay;
    data.cardState = 'blocked';
    attachEscapeHandler(overlay, data);
    renderCard(data);

    wrapper.appendChild(overlay);

    // Update tracking
    revealedElements.delete(id);
    if (blockedElements.has(id)) {
      blockedElements.get(id).revealed = false;
    }
  }

  /**
   * Remove blur completely (for allowlisted content or disabled extension)
   */
  function removeBlur(element) {
    const wrapper = element.closest('.scaredycat-wrapper');
    if (!wrapper) return;

    const id = wrapper.getAttribute('data-scaredycat-id');
    const data = blockedElements.get(id);
    if (data?.cancelReveal) data.cancelReveal();

    // Move element back out of wrapper
    wrapper.parentNode.insertBefore(element, wrapper);

    // Remove wrapper
    wrapper.remove();

    // Clean up element
    element.classList.remove('scaredycat-blurred');
    element.classList.remove('scaredycat-revealing');
    restoreAT(element, data);
    element.removeAttribute('data-scaredycat-processed');

    // Remove from tracking
    blockedElements.delete(id);
    revealedElements.delete(id);
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
    document.querySelectorAll('.scaredycat-wrapper').forEach(wrapper => {
      const element = wrapper.querySelector('img, video, [data-scaredycat-processed]');
      if (element) removeBlur(element);
    });
    blockedElements.clear();
    revealedElements.clear();

    // Restore all blanked iframes
    document.querySelectorAll('iframe[data-scaredycat-original-src]').forEach(iframe => {
      iframe.src = iframe.getAttribute('data-scaredycat-original-src');
      iframe.removeAttribute('data-scaredycat-original-src');
    });
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
        src: data.element?.src || data.element?.poster || ''
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
    const wrappers = [];
    blockedElements.forEach((data) => {
      if (data.wrapper && data.wrapper.isConnected) wrappers.push(data.wrapper);
    });
    return wrappers;
  }

  /**
   * Reveal everything blocked on this page (session-only; the allowlist
   * is untouched and a rescan will block again)
   */
  function revealAll() {
    blockedElements.forEach((data) => {
      if (!data.revealed && data.element && data.wrapper?.isConnected) {
        revealElement(data.element, data.wrapper);
      }
    });
  }

  /**
   * Check if an element is currently blocked
   */
  function isBlocked(element) {
    return element.classList.contains('scaredycat-blurred') ||
      element.closest('.scaredycat-wrapper') !== null;
  }

  /**
   * Handle window resize - update wrapper sizes
   */
  function handleResize() {
    // Read every size first, then write: interleaving forces a layout per entry.
    const sizes = [];
    blockedElements.forEach((data) => {
      const { element, wrapper } = data;
      if (wrapper && element) sizes.push([wrapper, element.offsetWidth, element.offsetHeight]);
    });
    for (const [wrapper, w, h] of sizes) {
      wrapper.style.width = w + 'px';
      wrapper.style.height = h + 'px';
    }
  }

  /**
   * Stop all videos and video iframes on the page and cover them with blur overlay
   */
  function stopAllPageVideos() {
    // Stop and cover all video elements
    document.querySelectorAll('video').forEach(v => {
      if (!v.closest('.scaredycat-wrapper')) {
        pauseVideo(v);
        // Also create a blur overlay on the video
        createBlurOverlay(v, { isHorror: true, confidence: 100, reasons: ['Video on horror page'] });
      }
    });

    // Cover and blank all video iframes (YouTube, Vimeo, etc.)
    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.src || '';
      if (src && src !== 'about:blank' &&
          (src.includes('youtube') || src.includes('vimeo') || src.includes('player') ||
           src.includes('video') || src.includes('embed'))) {
        if (!iframe.closest('.scaredycat-wrapper')) {
          // Create blur overlay first, then blank the src
          createBlurOverlay(iframe, { isHorror: true, confidence: 100, reasons: ['Video iframe on horror page'] });
        }
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
        if (!v.closest('.scaredycat-wrapper')) {
          pauseVideo(v);
          createBlurOverlay(v, { isHorror: true, confidence: 100, reasons: ['Video on horror page'] });
        }
      });

      // Find and cover any video iframes not already wrapped
      document.querySelectorAll('iframe').forEach(iframe => {
        const src = iframe.src || iframe.getAttribute('data-scaredycat-original-src') || '';
        if (!iframe.closest('.scaredycat-wrapper') &&
            (src.includes('youtube') || src.includes('vimeo') || src.includes('player') ||
             src.includes('video') || src.includes('embed'))) {
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
    getBlockedCount,
    getBlockedItems,
    getBlockedData,
    getBlockedWrappers,
    buildReport,
    isBlocked,
    warmFonts
  };
})();

// Make available globally
window.ScaredyCatBlocker = ScaredyCatBlocker;
