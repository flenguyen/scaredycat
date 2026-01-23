/**
 * Scaredy Cat - Content Blocker
 * Handles the visual blurring of horror content
 */

const ScaredyCatBlocker = (function () {
  // Track blocked elements for stats
  let blockedElements = new Map();
  let revealedElements = new Set();

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
      <span class="scaredycat-text">Horror content hidden</span>
      <button class="scaredycat-show-btn" type="button">Show anyway</button>
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

    if (element.tagName === 'VIDEO') {
      wasPlaying = isVideoPlaying(element);
      wasMuted = element.muted;
      pauseVideo(element);
    }

    // Handle iframe elements - blank the src to stop playback
    if (element.tagName === 'IFRAME') {
      originalSrc = element.src;
      // Store src and blank it to stop any video playback
      element.setAttribute('data-scaredycat-original-src', originalSrc);
      element.src = 'about:blank';
    }

    // Also check for videos inside nested elements
    const nestedVideos = element.querySelectorAll ? element.querySelectorAll('video') : [];
    nestedVideos.forEach(v => pauseVideo(v));

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
      originalSrc
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
        <span class="scaredycat-text">Horror content hidden</span>
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
    const wrappers = document.querySelectorAll('.scaredycat-wrapper');
    wrappers.forEach(wrapper => {
      const element = wrapper.querySelector('img, video, [data-scaredycat-processed]');
      if (element) {
        removeBlur(element);
      }
    });
    blockedElements.clear();
    revealedElements.clear();
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
        context: data.analysisResult?.context || ''
      });
    });
    return items;
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
    removeBlur,
    removeAllBlurs,
    getBlockedCount,
    getBlockedItems,
    isBlocked
  };
})();

// Make available globally
window.ScaredyCatBlocker = ScaredyCatBlocker;
