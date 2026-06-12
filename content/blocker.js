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

  function ensureStylesFor(element) {
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
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
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

  /**
   * Resolve the satirical synopsis for a block, once, at block time.
   * Stored on the entry so re-renders never reshuffle the joke.
   */
  function resolveSynopsis(element, analysisResult) {
    const detector = window.ScaredyCatDetector;
    if (!detector || !detector.getTitleInfo) return null;
    // Synthetic blocks (videos covered on a horror page) carry no element
    // context; the page-level matched title is usually the right movie.
    const title = analysisResult?.matchedTitle ||
      (detector.getPageMatchedTitle && detector.getPageMatchedTitle());
    if (title) {
      const info = detector.getTitleInfo(title);
      if (info && info.synopsis) {
        return { kind: 'title', title: info.title, year: info.year, text: info.synopsis };
      }
    }
    const seed = analysisResult?.context || element.src || element.poster || '';
    const text = detector.pickFallbackSynopsis && detector.pickFallbackSynopsis(seed);
    return text ? { kind: 'generic', text } : null;
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
    overlay.textContent = '';

    const message = document.createElement('div');
    message.className = 'scaredycat-message';

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
      const title = makeText('p', 'scaredycat-syn-title', info.kind === 'title' ? info.title : "Here's the gist.");
      if (info.kind === 'title' && info.year) {
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
      message.appendChild(makeText('p', 'scaredycat-heading', 'Horror content detected'));
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

      if (data.synopsisInfo) {
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
    console.log('Scaredy Cat: Creating blur overlay for', element.tagName, element.src?.slice(0, 50));

    // Check if element is still in DOM
    if (!element.parentNode) {
      console.warn('Scaredy Cat: Element has no parent, cannot wrap');
      return null;
    }

    ensureStylesFor(element);

    // Check if already wrapped
    if (element.closest('.scaredycat-wrapper')) {
      console.log('Scaredy Cat: Element already wrapped, skipping');
      return null;
    }

    // Create wrapper container
    const wrapper = document.createElement('div');
    wrapper.className = 'scaredycat-wrapper';
    wrapper.setAttribute('data-scaredycat-wrapper', 'true');

    // Store original element properties for restoration
    const originalDisplay = getComputedStyle(element).display;
    const originalPosition = getComputedStyle(element).position;

    // Position the wrapper based on element
    const rect = element.getBoundingClientRect();
    wrapper.style.width = element.offsetWidth + 'px';
    wrapper.style.height = element.offsetHeight + 'px';
    wrapper.style.display = originalDisplay === 'inline' ? 'inline-block' : originalDisplay;

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
      synopsisInfo: resolveSynopsis(element, analysisResult),
      everRevealed: false,
      timestamp: Date.now(),
      wasPlaying: false,
      wasMuted: false,
      originalSrc: null,
      stoppedIframes: []
    };

    attachEscapeHandler(overlay, data);
    renderCard(data);

    // Insert wrapper before element
    element.parentNode.insertBefore(wrapper, element);

    // Move element into wrapper
    wrapper.appendChild(element);
    wrapper.appendChild(overlay);

    // Apply blur to the element itself
    element.classList.add('scaredycat-blurred');

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

    // IMPORTANT: Find and stop ALL videos/iframes near the blocked element
    // Search multiple levels up to find the media container
    const containerSelectors = [
      '[class*="player"]', '[class*="video"]', '[class*="trailer"]', '[class*="media"]',
      '[class*="hero"]', '[class*="slate"]', '[data-testid*="video"]', '[data-testid*="hero"]',
      'section', 'article', 'main'
    ];

    let container = null;
    for (const selector of containerSelectors) {
      container = element.closest(selector);
      if (container) break;
    }

    // Fallback: go up 5 levels in the DOM
    if (!container) {
      container = element.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;
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

    // For ANY horror content, aggressively stop all videos on the page
    // This catches cases where the video player is in a completely different DOM location
    if (analysisResult?.isHorror) {
      stopAllPageVideos();

      // Also set up ongoing monitoring since videos may load/play after blocking
      startVideoMonitor();
    }

    // Store reference for stats and management
    const id = generateId();
    wrapper.setAttribute('data-scaredycat-id', id);
    blockedElements.set(id, data);

    // Notify background about blocked content
    try {
      chrome.runtime.sendMessage({ type: 'INCREMENT_BLOCKED' });
    } catch (e) {
      // Extension context may be invalidated
    }

    console.log('Scaredy Cat: Blur overlay created successfully', {
      wrapperId: id,
      wrapperInDOM: wrapper.isConnected,
      elementBlurred: element.classList.contains('scaredycat-blurred'),
      wrapperSize: `${wrapper.offsetWidth}x${wrapper.offsetHeight}`
    });

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
      console.log('Scaredy Cat: Video paused and muted');
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

    // Remove blur from element
    element.classList.remove('scaredycat-blurred');

    // Remove overlay
    const overlay = wrapper.querySelector('.scaredycat-overlay');
    if (overlay) {
      overlay.classList.add('scaredycat-fade-out');
      setTimeout(() => overlay.remove(), 300);
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
  }

  /**
   * Hide a previously revealed element again
   */
  function hideElementAgain(element, wrapper) {
    const id = wrapper.getAttribute('data-scaredycat-id');

    // Remove hide button
    const hideBtn = wrapper.querySelector('.scaredycat-hide-again-btn');
    if (hideBtn) hideBtn.remove();

    // Re-apply blur
    element.classList.add('scaredycat-blurred');

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

    const data = blockedElements.get(id) || {
      element,
      wrapper,
      analysisResult: null,
      synopsisInfo: resolveSynopsis(element, null),
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

    // Move element back out of wrapper
    wrapper.parentNode.insertBefore(element, wrapper);

    // Remove wrapper
    wrapper.remove();

    // Clean up element
    element.classList.remove('scaredycat-blurred');
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
    blockedElements.forEach((data) => {
      const { element, wrapper } = data;
      if (wrapper && element) {
        wrapper.style.width = element.offsetWidth + 'px';
        wrapper.style.height = element.offsetHeight + 'px';
      }
    });
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
    isBlocked
  };
})();

// Make available globally
window.ScaredyCatBlocker = ScaredyCatBlocker;
