/**
 * Scaredy Cat - Main Content Script
 * Coordinates detection, blocking, and observation of horror content.
 * Optimized for performance - minimal impact on regular browsing.
 */

(function () {
  'use strict';

  // Extension state
  let isEnabled = true;
  let settings = null;
  let isInitialized = false;
  const currentHostname = window.location.hostname;

  // Trusted domains where we should never run
  const TRUSTED_DOMAINS = [
    'loom.com', 'loomcdn.com', 'zoom.us', 'zoom.com', 'meet.google.com',
    'teams.microsoft.com', 'teams.live.com', 'webex.com', 'slack.com',
    'discord.com', 'discordapp.com', 'twitch.tv', 'whereby.com',
    'around.co', 'screen.so', 'cal.com', 'calendly.com'
  ];

  function isTrustedDomain() {
    return TRUSTED_DOMAINS.some(d => currentHostname === d || currentHostname.endsWith('.' + d));
  }

  /**
   * Initialize the extension
   */
  async function init() {
    if (isInitialized) return;

    // Skip on trusted domains
    if (isTrustedDomain()) {
      isInitialized = true;
      isEnabled = false;
      revealAllEarlyHidden();
      return;
    }

    // Stop early observer
    if (window.__scaredycatStopEarlyObserver) {
      window.__scaredycatStopEarlyObserver();
    }

    // Load settings
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response?.success) {
        settings = response.settings;
        isEnabled = settings.enabled;
        if (settings.disabledSites?.includes(currentHostname)) {
          isEnabled = false;
        }
        if (settings.sensitivity) {
          ScaredyCatDetector.setSensitivity(settings.sensitivity);
        }
      }
    } catch (e) {
      settings = { enabled: true, sensitivity: 'medium', allowedItems: [], disabledSites: [] };
    }

    // Load horror database
    await ScaredyCatDetector.loadDatabase();

    isInitialized = true;

    if (!isEnabled) {
      revealAllEarlyHidden();
      return;
    }

    // Start scanning and observing
    performInitialScan();
    ScaredyCatObserver.init(scanElements);
    ScaredyCatObserver.startObserving();

    // Listen for messages
    chrome.runtime.onMessage.addListener(handleMessage);

    console.log('Scaredy Cat: Initialized');
  }

  /**
   * Handle messages from popup
   */
  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'SETTINGS_UPDATED':
        settings = message.settings;
        isEnabled = settings.enabled && !settings.disabledSites?.includes(currentHostname);
        if (settings.sensitivity) ScaredyCatDetector.setSensitivity(settings.sensitivity);
        if (!isEnabled) {
          ScaredyCatBlocker.removeAllBlurs();
          ScaredyCatObserver.stopObserving();
        }
        sendResponse({ success: true });
        break;
      case 'GET_PAGE_STATS':
        sendResponse({ success: true, blockedCount: ScaredyCatBlocker.getBlockedCount() });
        break;
      case 'RESCAN_PAGE':
        if (isEnabled) {
          document.querySelectorAll('[data-scaredycat-processed]').forEach(el => {
            el.removeAttribute('data-scaredycat-processed');
          });
          performInitialScan();
        }
        sendResponse({ success: true });
        break;
      default:
        sendResponse({ success: false });
    }
    return true;
  }

  /**
   * Initial scan - keep it fast
   */
  function performInitialScan() {
    if (!isEnabled || !isInitialized) return;

    // Scan early-hidden elements first (media sites only)
    const earlyHidden = document.querySelectorAll('[data-scaredycat-early-hidden]');
    if (earlyHidden.length > 0) {
      scanElements(Array.from(earlyHidden));
    }

    // Scan standard media elements
    const media = document.querySelectorAll(
      'img:not([data-scaredycat-processed]), ' +
      'video:not([data-scaredycat-processed]), ' +
      'iframe:not([data-scaredycat-processed])'
    );

    if (media.length > 0) {
      scanElements(Array.from(media));
    }
  }

  /**
   * Scan elements for horror content
   */
  async function scanElements(elements) {
    if (!isEnabled || !isInitialized || !settings || elements.length === 0) return;

    for (const element of elements) {
      if (element.hasAttribute('data-scaredycat-processed')) continue;
      if (!ScaredyCatDetector.shouldAnalyzeElement(element)) {
        element.setAttribute('data-scaredycat-processed', 'skip');
        revealEarlyHidden(element);
        continue;
      }

      // Check allowlist
      const src = element.src || element.poster || '';
      if (settings.allowedItems?.length && ScaredyCatDetector.isAllowed(src, settings.allowedItems)) {
        element.setAttribute('data-scaredycat-processed', 'allowed');
        revealEarlyHidden(element);
        continue;
      }

      try {
        const result = await ScaredyCatDetector.analyzeElement(element);
        element.setAttribute('data-scaredycat-processed', result.isHorror ? 'blocked' : 'safe');

        if (result.isHorror) {
          ScaredyCatBlocker.createBlurOverlay(element, result);
        } else {
          revealEarlyHidden(element);
        }
      } catch (e) {
        element.setAttribute('data-scaredycat-processed', 'error');
        revealEarlyHidden(element);
      }
    }
  }

  function revealAllEarlyHidden() {
    document.querySelectorAll('[data-scaredycat-early-hidden]').forEach(el => {
      el.removeAttribute('data-scaredycat-early-hidden');
      el.style.opacity = '1';
    });
  }

  function revealEarlyHidden(element) {
    if (window.__scaredycatRevealElement) {
      window.__scaredycatRevealElement(element);
    } else if (element.hasAttribute('data-scaredycat-early-hidden')) {
      element.removeAttribute('data-scaredycat-early-hidden');
      element.style.opacity = '1';
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging
  window.ScaredyCat = {
    isEnabled: () => isEnabled,
    rescan: performInitialScan,
    getStats: () => ({ blocked: ScaredyCatBlocker.getBlockedCount() })
  };
})();
