/**
 * Scaredy Cat - Background Service Worker
 * Handles extension state, messaging, storage management, and routing of
 * image classification requests to the offscreen ML document.
 */

importScripts(
  'background/db-version.js',
  'background/image-key.js',
  'background/verdict-cache.js',
  'background/ml-router.js',
  'background/db-updater.js',
  'background/feedback.js'
);

// Trim the verdict cache when the worker spins up.
ScaredyCatVerdictCache.prune();

// Default settings for new installations
const DEFAULT_SETTINGS = {
  enabled: true,
  sensitivity: 'medium', // 'low' (80+), 'medium' (60+), 'high' (40+)
  disabledSites: [],
  allowedItems: [], // Specific URLs or titles user chose to show
  feedbackConsent: false // Opt-in gate for sending any feedback off-device
};

// Stats live in chrome.storage.local, not sync: they change on every blocked
// element, and sync's MAX_WRITE_OPERATIONS_PER_MINUTE quota (120/min) is easy
// to exceed on image-heavy pages.
async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  return stats || { totalBlockedAllTime: 0 };
}

// Serialize increments so concurrent messages don't lose counts. Content
// scripts batch their blocks and send a count.
let statsWriteChain = Promise.resolve();
function incrementBlocked(count = 1) {
  statsWriteChain = statsWriteChain.then(async () => {
    const stats = await getStats();
    stats.totalBlockedAllTime = (stats.totalBlockedAllTime || 0) + count;
    await chrome.storage.local.set({ stats });
    return stats.totalBlockedAllTime;
  });
  return statsWriteChain;
}

// ---- Toolbar badge: per-tab hidden count ------------------------------------
// Plum badge, cream digits (DESIGN.md tokens). The count is read back from the
// badge itself rather than kept in worker memory, so a service-worker restart
// can never desync it. Chrome clears tab-scoped badge text on navigation; the
// onUpdated listener below makes that explicit for the loading state too.
const BADGE_MAX = 99;

function setBadgeColors() {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#2E2447' });
    chrome.action.setBadgeTextColor?.({ color: '#FDF8F0' });
  } catch (e) {
    // Older Chrome without setBadgeTextColor: background alone is fine.
  }
}

function formatBadge(n) {
  if (n <= 0) return '';
  return n > BADGE_MAX ? `${BADGE_MAX}+` : String(n);
}

function parseBadge(text) {
  if (!text) return 0;
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : 0;
}

async function bumpBadge(tabId, count) {
  if (tabId == null) return;
  try {
    const current = parseBadge(await chrome.action.getBadgeText({ tabId }));
    await chrome.action.setBadgeText({ tabId, text: formatBadge(current + count) });
  } catch (e) {
    // Tab may have closed between the block and the flush.
  }
}

async function clearBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (e) {
    // Tab gone — nothing to clear.
  }
}

async function clearAllBadges(hostname = null) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null) continue;
    if (hostname) {
      let host = '';
      try { host = new URL(tab.url || '').hostname; } catch (e) { /* no url */ }
      if (host !== hostname) continue;
    }
    clearBadge(tab.id);
  }
}

chrome.runtime.onInstalled.addListener(setBadgeColors);
chrome.runtime.onStartup.addListener(setBadgeColors);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') clearBadge(tabId);
});

// ---- Horror database seeding ------------------------------------------------
// Content scripts read the database from chrome.storage.local in one call, in
// parallel with settings, instead of fetching + parsing the bundled JSON on
// every page load. The worker keeps that key populated: the bundled copy is
// written here whenever it's newer than what's stored (fresh install, or an
// update shipping a newer list), and db-updater.js writes newer remote copies.
const DB_CACHE_KEY = 'horrorDatabase';

async function seedBundledDatabase() {
  try {
    const res = await fetch(chrome.runtime.getURL('data/horror-database.json'));
    const bundled = await res.json();
    if (!ScaredyCatDBVersion.isValidDatabase(bundled)) return;
    const { [DB_CACHE_KEY]: stored } = await chrome.storage.local.get(DB_CACHE_KEY);
    if (ScaredyCatDBVersion.isValidDatabase(stored) &&
        ScaredyCatDBVersion.compareDbVersion(stored, bundled) >= 0) {
      return; // stored copy is at least as new
    }
    await chrome.storage.local.set({ [DB_CACHE_KEY]: bundled });
    console.log(`Scaredy Cat: seeded horror DB v${bundled.version} (${bundled.titles.length} titles)`);
  } catch (e) {
    // Content scripts fall back to fetching the bundled file themselves.
  }
}

chrome.runtime.onInstalled.addListener(seedBundledDatabase);
chrome.runtime.onStartup.addListener(seedBundledDatabase);

// Initialize extension on install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    console.log('Scaredy Cat installed! Default settings applied.');
  } else if (details.reason === 'update') {
    // Merge new default settings with existing ones
    const { settings } = await chrome.storage.sync.get('settings');
    const mergedSettings = { ...DEFAULT_SETTINGS, ...settings };

    // Migrate the all-time counter out of synced settings (it used to live
    // there and blew through sync's write quota).
    const { stats } = await chrome.storage.local.get('stats');
    if (!stats && mergedSettings.totalBlockedAllTime) {
      await chrome.storage.local.set({
        stats: { totalBlockedAllTime: mergedSettings.totalBlockedAllTime }
      });
    }
    delete mergedSettings.totalBlockedAllTime;
    delete mergedSettings.blockedCount;

    await chrome.storage.sync.set({ settings: mergedSettings });
    console.log('Scaredy Cat updated!');
  }
});

// ---- Right-click "report missed horror" -------------------------------------
// Adds our own line to Chrome's context menu, scoped to media so it never
// clutters the menu on plain text. The click handler hands the image/video URL
// to the page's content script, which owns all in-page feedback UI (consent
// sheet, toast) and funnels the report back through SUBMIT_FEEDBACK.
const CONTEXT_MENU_ID = 'scaredycat-report-missed';

function ensureContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: '🙀 Scaredy Cat: Report missed horror',
        contexts: ['image', 'video']
      });
    });
  } catch (e) {
    // contextMenus unavailable — nothing to do.
  }
}

chrome.runtime.onInstalled.addListener(ensureContextMenu);
chrome.runtime.onStartup.addListener(ensureContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;
  const srcUrl = info.srcUrl || '';
  const kind = info.mediaType === 'video' ? 'video' : 'image';
  chrome.tabs.sendMessage(tab.id, {
    type: 'REPORT_MISSED_CONTEXT',
    srcUrl,
    kind
  }).catch(() => {
    // Content script not loaded on this page — ignore.
  });
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
  // Pre-load the classifier (media sites / horror pages), fire-and-forget.
  if (message.type === 'WARM_ML') {
    ScaredyCatMLRouter.warm();
    return { success: true };
  }

  // Stats messages hit storage.local only — no settings read needed.
  if (message.type === 'INCREMENT_BLOCKED') {
    const n = Number.isInteger(message.count) && message.count > 0 ? message.count : 1;
    bumpBadge(sender?.tab?.id, n);
    const totalBlocked = await incrementBlocked(n);
    return { success: true, totalBlocked };
  }
  if (message.type === 'GET_PAGE_STATS') {
    // Per-page stats are handled by the content script; we track global here.
    const stats = await getStats();
    return { success: true, totalBlockedAllTime: stats.totalBlockedAllTime || 0 };
  }

  // Tolerate a missing/partial key (fresh profile, sync wipe) so a partial
  // UPDATE_SETTINGS can never persist a settings object with holes in it.
  const stored = await chrome.storage.sync.get('settings');
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };

  switch (message.type) {
    case 'GET_SETTINGS':
      return { success: true, settings };

    case 'SUBMIT_FEEDBACK':
      // Consent is re-checked inside submit() so a UI bug can't leak data.
      return ScaredyCatFeedback.submit(message.report, settings);

    case 'UPDATE_SETTINGS':
      const newSettings = { ...settings, ...message.settings };
      await chrome.storage.sync.set({ settings: newSettings });
      if (message.settings?.enabled === false) clearAllBadges();
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
      const nowDisabled = disabledSites.includes(site);
      if (nowDisabled) clearAllBadges(site);
      return { success: true, isDisabled: nowDisabled };

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

console.log('Scaredy Cat background service worker loaded!');
