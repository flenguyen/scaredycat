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

    // Create the blur overlay
    const overlay = document.createElement('div');
    overlay.className = 'scaredycat-overlay';

    // Create the message container
    const message = document.createElement('div');
    message.className = 'scaredycat-message';
    message.innerHTML = `
      <span class="scaredycat-icon">🙀</span>
      <span class="scaredycat-text">Content hidden</span>
      <button class="scaredycat-show-btn" type="button" title="Show anyway">
        <span class="scaredycat-btn-full">Show anyway</span>
        <span class="scaredycat-btn-short">Show</span>
      </button>
    `;

    // Add click handler to show button
    const showBtn = message.querySelector('.scaredycat-show-btn');
    showBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      revealElement(element, wrapper);
    });

    overlay.appendChild(message);

    // Insert wrapper before element
    element.parentNode.insertBefore(wrapper, element);

    // Move element into wrapper
    wrapper.appendChild(element);
    wrapper.appendChild(overlay);

    // Apply blur to the element itself
    element.classList.add('scaredycat-blurred');

    // Handle video elements - pause and mute them
    let wasPlaying = false;
    let wasMuted = false;
    let originalSrc = null;
    let stoppedIframes = [];

    if (element.tagName === 'VIDEO') {
      wasPlaying = isVideoPlaying(element);
      wasMuted = element.muted;
      pauseVideo(element);
    }

    // Handle iframe elements - blank the src to stop playback
    if (element.tagName === 'IFRAME') {
      originalSrc = element.src;
      element.setAttribute('data-scaredycat-original-src', originalSrc);
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
          stoppedIframes.push(iframe);
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
    blockedElements.set(id, {
      element,
      wrapper,
      analysisResult,
      timestamp: Date.now(),
      wasPlaying,
      wasMuted,
      originalSrc,
      stoppedIframes
    });

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

    // Re-create overlay
    const overlay = document.createElement('div');
    overlay.className = 'scaredycat-overlay';
    overlay.innerHTML = `
      <div class="scaredycat-message">
        <span class="scaredycat-icon">🙀</span>
        <span class="scaredycat-text">Content hidden</span>
        <button class="scaredycat-show-btn" type="button">Show anyway</button>
      </div>
    `;

    const showBtn = overlay.querySelector('.scaredycat-show-btn');
    showBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      revealElement(element, wrapper);
    });

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
