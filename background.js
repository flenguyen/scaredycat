/**
 * Scaredy Cat - Background Service Worker
 * Handles extension state, messaging, storage management, and routing of
 * image classification requests to the offscreen ML document.
 */

importScripts('background/verdict-cache.js', 'background/ml-router.js');

// Trim the verdict cache when the worker spins up.
ScaredyCatVerdictCache.prune();

// Default settings for new installations
const DEFAULT_SETTINGS = {
  enabled: true,
  sensitivity: 'medium', // 'low' (80+), 'medium' (60+), 'high' (40+)
  disabledSites: [],
  allowedItems: [], // Specific URLs or titles user chose to show
  blockedCount: 0,
  totalBlockedAllTime: 0
};

// Initialize extension on install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    console.log('Scaredy Cat installed! Default settings applied.');
  } else if (details.reason === 'update') {
    // Merge new default settings with existing ones
    const { settings } = await chrome.storage.sync.get('settings');
    const mergedSettings = { ...DEFAULT_SETTINGS, ...settings };
    await chrome.storage.sync.set({ settings: mergedSettings });
    console.log('Scaredy Cat updated!');
  }
});

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // Keep message channel open for async response
});

/**
 * Handle incoming messages from content scripts or popup
 */
async function handleMessage(message, sender) {
  // Classification requests are hot-path: skip the settings read.
  if (message.type === 'CLASSIFY_IMAGE') {
    return ScaredyCatMLRouter.handleClassifyRequest(message.url);
  }

  const { settings } = await chrome.storage.sync.get('settings');

  switch (message.type) {
    case 'GET_SETTINGS':
      return { success: true, settings };

    case 'UPDATE_SETTINGS':
      const newSettings = { ...settings, ...message.settings };
      await chrome.storage.sync.set({ settings: newSettings });
      // Notify all tabs about settings change
      notifyAllTabs({ type: 'SETTINGS_UPDATED', settings: newSettings });
      return { success: true, settings: newSettings };

    case 'GET_SITE_STATUS':
      const hostname = message.hostname;
      const isDisabled = settings.disabledSites.includes(hostname);
      return { success: true, isDisabled, enabled: settings.enabled };

    case 'TOGGLE_SITE':
      const site = message.hostname;
      let disabledSites = [...settings.disabledSites];
      if (disabledSites.includes(site)) {
        disabledSites = disabledSites.filter(s => s !== site);
      } else {
        disabledSites.push(site);
      }
      const updatedSettings = { ...settings, disabledSites };
      await chrome.storage.sync.set({ settings: updatedSettings });
      return { success: true, isDisabled: disabledSites.includes(site) };

    case 'ADD_TO_ALLOWLIST':
      const allowedItems = [...settings.allowedItems, message.item];
      await chrome.storage.sync.set({
        settings: { ...settings, allowedItems }
      });
      return { success: true };

    case 'REMOVE_FROM_ALLOWLIST':
      const filteredItems = settings.allowedItems.filter(
        item => item !== message.item
      );
      await chrome.storage.sync.set({
        settings: { ...settings, allowedItems: filteredItems }
      });
      return { success: true };

    case 'INCREMENT_BLOCKED':
      const newCount = (settings.totalBlockedAllTime || 0) + 1;
      await chrome.storage.sync.set({
        settings: { ...settings, totalBlockedAllTime: newCount }
      });
      return { success: true, totalBlocked: newCount };

    case 'GET_PAGE_STATS':
      // This is handled by content script, but we track global stats here
      return {
        success: true,
        totalBlockedAllTime: settings.totalBlockedAllTime || 0
      };

    default:
      return { success: false, error: 'Unknown message type' };
  }
}

/**
 * Send a message to all tabs
 */
async function notifyAllTabs(message) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (e) {
      // Tab might not have content script loaded, ignore
    }
  }
}

// Handle extension icon click when popup is not available
chrome.action.onClicked.addListener(async (tab) => {
  // Toggle extension enabled state
  const { settings } = await chrome.storage.sync.get('settings');
  settings.enabled = !settings.enabled;
  await chrome.storage.sync.set({ settings });

  // Update icon to reflect state
  updateIcon(settings.enabled);

  // Notify the current tab
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'SETTINGS_UPDATED',
      settings
    });
  } catch (e) {
    // Content script not loaded
  }
});

/**
 * Update extension icon based on enabled state
 */
function updateIcon(enabled) {
  const suffix = enabled ? '' : '_disabled';
  chrome.action.setIcon({
    path: {
      16: `icons/icon16${suffix}.png`,
      48: `icons/icon48${suffix}.png`,
      128: `icons/icon128${suffix}.png`
    }
  }).catch(() => {
    // Icons might not exist, use default
  });
}

console.log('Scaredy Cat background service worker loaded!');
