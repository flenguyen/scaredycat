/**
 * Scaredy Cat - Background Service Worker
 * Handles extension state, messaging, storage management, and routing of
 * image classification requests to the offscreen ML document.
 */

importScripts(
  'background/guards.js',
  'background/db-version.js',
  'background/image-key.js',
  'background/allowlist.js',
  'background/verdict-cache.js',
  'background/model-info.js',
  'background/ml-router.js',
  'content/scoring-core.js',
  'background/synopses.js',
  'background/trust.js',
  'background/db-updater.js',
  'background/feedback.js'
);

// The verdict cache is trimmed from the title-list alarm (db-updater.js),
// once a day, not on every worker start.

// Default settings for new installations. guards.js owns the shape: every
// read and write goes through sanitizeSettings, so a corrupt synced value
// repairs itself.
const DEFAULT_SETTINGS = ScaredyCatGuards.DEFAULT_SETTINGS;
const sanitizeSettings = (obj) => ScaredyCatGuards.sanitizeSettings(obj, ScaredyCatScoring.normalizeText);

// ---- Settings (chrome.storage.sync) -----------------------------------------
// Read-modify-write is serialized so two quick changes (a popup toggle and an
// "Allow" on a title) can't overwrite each other.
let settingsWriteChain = Promise.resolve();

async function readSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  // A legacy allowedItems list still in sync: split it before anything
  // writes settings back without it.
  if (settings && Object.prototype.hasOwnProperty.call(settings, 'allowedItems')) {
    await migrateLegacyAllowlist();
    return sanitizeSettings((await chrome.storage.sync.get('settings')).settings);
  }
  return sanitizeSettings(settings);
}

function updateSettings(mutate) {
  const run = settingsWriteChain.then(async () => {
    const current = await readSettings();
    const next = sanitizeSettings(mutate({ ...current }));
    await chrome.storage.sync.set({ settings: next });
    return { previous: current, settings: next };
  });
  settingsWriteChain = run.catch(() => {});
  return run;
}

// ---- Allowlist ----------------------------------------------------------------
// Images: canonical keys in chrome.storage.local.allowedImages (local only,
// capped). Titles: normalized text in settings.allowedTitles (synced). Exact
// matching on both sides; see background/allowlist.js.
let allowlistWriteChain = Promise.resolve();

async function getAllowedImages() {
  const { allowedImages } = await chrome.storage.local.get('allowedImages');
  return Array.isArray(allowedImages) ? allowedImages : [];
}

function updateAllowedImages(mutate) {
  const run = allowlistWriteChain.then(async () => {
    const current = await getAllowedImages();
    const next = ScaredyCatAllowlist.addImageKeys([], mutate(current));
    const changed = next.length !== current.length || next.some((k, i) => k !== current[i]);
    if (changed) {
      await chrome.storage.local.set({ allowedImages: next });
      notifyAllTabs({ type: 'ALLOWLIST_UPDATED', allowedImages: next });
    }
    return next;
  });
  allowlistWriteChain = run.catch(() => {});
  return run;
}

/**
 * One-time split of the old synced settings.allowedItems: image URLs to
 * local allowedImages, titles to settings.allowedTitles. Idempotent (a run
 * with no allowedItems left is a no-op), and shared so concurrent callers
 * wait on the same run.
 */
let migrationPromise = null;
function migrateLegacyAllowlist() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const { settings: raw } = await chrome.storage.sync.get('settings');
      if (!raw || !Object.prototype.hasOwnProperty.call(raw, 'allowedItems')) return;
      const { images, titles } = ScaredyCatAllowlist.splitLegacy(
        raw.allowedItems, ScaredyCatImageKey.canonicalImageKey, ScaredyCatScoring.normalizeText
      );
      if (images.length) await updateAllowedImages(current => [...current, ...images]);
      const next = sanitizeSettings({
        ...raw,
        allowedTitles: ScaredyCatGuards.addTitles(
          Array.isArray(raw.allowedTitles) ? raw.allowedTitles : [], titles, ScaredyCatScoring.normalizeText
        )
      });
      await chrome.storage.sync.set({ settings: next });
      console.log(`Scaredy Cat: moved ${images.length} allowed images to local storage, kept ${titles.length} titles`);
    })().finally(() => { migrationPromise = null; });
  }
  return migrationPromise;
}

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

// ---- User blocklist --------------------------------------------------------
// Images the user reported as missed horror, kept as canonical image keys so
// the same poster at another size is caught too. Local, not sync: URLs would
// blow through sync's 8 KB per-item quota. Oldest first; capped. Writes are
// serialized so two quick reports can't lose each other.
const BLOCKLIST_MAX = 500;
let blocklistWriteChain = Promise.resolve();

async function getBlockedItems() {
  const { blockedItems } = await chrome.storage.local.get('blockedItems');
  return Array.isArray(blockedItems) ? blockedItems : [];
}

function updateBlockedItems(mutate) {
  blocklistWriteChain = blocklistWriteChain.then(async () => {
    const current = await getBlockedItems();
    const next = mutate(current).slice(-BLOCKLIST_MAX);
    const changed = next.length !== current.length || next.some((k, i) => k !== current[i]);
    if (changed) {
      await chrome.storage.local.set({ blockedItems: next });
      notifyAllTabs({ type: 'BLOCKLIST_UPDATED', blockedItems: next });
    }
    return next;
  });
  return blocklistWriteChain;
}

// ---- Toolbar badge: per-tab hidden count ------------------------------------
// Plum badge, cream digits (DESIGN.md tokens). The content script sends the
// tab's absolute count (INCREMENT_BLOCKED / SET_BADGE pageCount), so nothing
// is read back or kept in worker memory. Chrome clears tab-scoped badge text
// on cross-document navigation by itself, which is why there is no
// tabs.onUpdated listener (it woke the worker for every tab update in the
// browser).
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

async function setBadgeCount(tabId, count) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeText({ tabId, text: formatBadge(count) });
  } catch (e) {
    // Tab may have closed between the block and the message.
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

// ---- Horror database seeding ------------------------------------------------
// Content scripts read the database from chrome.storage.local in one call, in
// parallel with settings, instead of fetching + parsing the bundled JSON on
// every page load. The worker keeps that key populated: the bundled copy is
// written here whenever it's newer than what's stored (fresh install, or an
// update shipping a newer list), and db-updater.js writes newer remote copies.
// A stored copy that fails validation (or claims a major version more than one
// ahead of the bundled list) is replaced too.
const DB_CACHE_KEY = 'horrorDatabase';

async function seedBundledDatabase() {
  try {
    const bundled = await ScaredyCatDBVersion.getBundledDatabase();
    if (!bundled) return;
    const maxMajor = await ScaredyCatDBVersion.maxAllowedMajor();
    const { [DB_CACHE_KEY]: stored } = await chrome.storage.local.get(DB_CACHE_KEY);
    const storedClean = ScaredyCatDBVersion.sanitizeDatabase(stored, { maxMajor });
    if (storedClean && ScaredyCatDBVersion.compareDbVersion(storedClean, bundled) >= 0) {
      return; // stored copy is at least as new
    }
    await chrome.storage.local.set({ [DB_CACHE_KEY]: bundled });
    console.log(`Scaredy Cat: seeded horror DB v${bundled.version} (${bundled.titles.length} titles)`);
  } catch (e) {
    // Content scripts fall back to GET_DB (the bundled file, via the worker).
  }
}

/**
 * GET_DB: the stored list if it validates, else the bundled one. Content
 * scripts ask only when their own copy is missing or fails to compile.
 */
async function getDatabaseForContent({ bundled = false } = {}) {
  if (bundled) return ScaredyCatDBVersion.getBundledDatabase();
  try {
    const maxMajor = await ScaredyCatDBVersion.maxAllowedMajor();
    const { [DB_CACHE_KEY]: stored } = await chrome.storage.local.get(DB_CACHE_KEY);
    const clean = ScaredyCatDBVersion.sanitizeDatabase(stored, { maxMajor });
    if (clean) return clean;
  } catch (e) {
    // fall through to the bundled copy
  }
  return ScaredyCatDBVersion.getBundledDatabase();
}

// ---- In-page UI resources ------------------------------------------------------
// The card's stylesheets and brand fonts are no longer web-accessible (a page
// could probe them to detect the extension). Content scripts fetch them once
// per tab through the worker instead; cached here for the worker's life.
const UI_CSS_FILES = { overlay: 'styles/blur-overlay.css', feedback: 'styles/feedback.css' };
let uiCssPromise = null;
const fontCache = new Map(); // file -> Promise<base64>

function getUiCss() {
  if (!uiCssPromise) {
    uiCssPromise = Promise.all(Object.entries(UI_CSS_FILES).map(async ([name, file]) => {
      const res = await fetch(chrome.runtime.getURL(file));
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      return [name, await res.text()];
    })).then(Object.fromEntries).catch((e) => {
      uiCssPromise = null;
      throw e;
    });
  }
  return uiCssPromise;
}

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function getFont(file) {
  // `file` is already checked against guards.js FONT_FILES.
  if (!fontCache.has(file)) {
    fontCache.set(file, fetch(chrome.runtime.getURL(`fonts/${file}`))
      .then(async (res) => {
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
        return bytesToBase64(new Uint8Array(await res.arrayBuffer()));
      })
      .catch((e) => {
        fontCache.delete(file);
        throw e;
      }));
  }
  return fontCache.get(file);
}

chrome.runtime.onInstalled.addListener(seedBundledDatabase);
chrome.runtime.onStartup.addListener(seedBundledDatabase);

// Initialize extension on install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.sync.set({ settings: sanitizeSettings(DEFAULT_SETTINGS) });
    // A new user has nothing to catch up on: no "New in x.y" marker in the
    // popup footer. Updates leave this key alone, so people coming from an
    // older version see the marker (popup/whats-new.js).
    await chrome.storage.local.set({ whatsNewSeen: chrome.runtime.getManifest().version });
    console.log('Scaredy Cat installed! Default settings applied.');
    // First run only: the welcome page shows how blocking, unblocking and
    // reporting work. Updates and unpacked reloads never reopen it.
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  } else if (details.reason === 'update') {
    const { settings } = await chrome.storage.sync.get('settings');

    // Migrate the all-time counter out of synced settings (it used to live
    // there and blew through sync's write quota).
    const { stats } = await chrome.storage.local.get('stats');
    if (!stats && Number.isFinite(settings?.totalBlockedAllTime) && settings.totalBlockedAllTime > 0) {
      await chrome.storage.local.set({
        stats: { totalBlockedAllTime: settings.totalBlockedAllTime }
      });
    }

    // Split the old allowedItems list, then write the settings back in the
    // current shape (unknown keys such as the old counters are dropped).
    await migrateLegacyAllowlist();
    await updateSettings(current => current);
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

// Listen for messages from content scripts and popup. Every message gets a
// response, even when the handler throws.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .catch((e) => {
      console.warn('Scaredy Cat: message failed', message?.type, e);
      return { success: false, error: 'failed' };
    })
    .then(sendResponse);
  return true; // Keep message channel open for async response
});

/**
 * Handle incoming messages from content scripts or popup. guards.js decides
 * who may send what: content scripts run inside web pages, so their messages
 * are checked against a per-type schema and kept away from popup-only
 * actions.
 */
async function handleMessage(message, sender) {
  const kind = ScaredyCatGuards.senderKind(sender, chrome.runtime.id, chrome.runtime.getURL(''));
  const error = ScaredyCatGuards.checkMessage(message, kind);
  if (error) {
    return { success: false, error: error === 'unknown' ? 'Unknown message type' : error };
  }

  // Classification requests are hot-path: skip the settings read.
  if (message.type === 'CLASSIFY_IMAGE') {
    return ScaredyCatMLRouter.handleClassifyRequest(message.url, sender);
  }
  // Pre-load the classifier, fire-and-forget.
  if (message.type === 'WARM_ML') {
    ScaredyCatMLRouter.warm();
    return { success: true };
  }

  // Spoiler summary for one blocked title (blur card's "Just tell me what
  // happens"); answered from the in-memory index, no settings read.
  if (message.type === 'GET_SYNOPSIS') {
    return ScaredyCatSynopses.handleRequest(message);
  }

  // Stats and badge messages hit storage.local / the action only.
  if (message.type === 'INCREMENT_BLOCKED') {
    const n = Math.min(message.count, ScaredyCatGuards.BLOCKED_COUNT_MAX);
    if (Number.isInteger(message.pageCount)) setBadgeCount(sender?.tab?.id, message.pageCount);
    const totalBlocked = await incrementBlocked(n);
    return { success: true, totalBlocked };
  }
  if (message.type === 'SET_BADGE') {
    await setBadgeCount(sender?.tab?.id, message.pageCount);
    return { success: true };
  }
  if (message.type === 'GET_PAGE_STATS') {
    // Per-page stats are handled by the content script; we track global here.
    const stats = await getStats();
    return { success: true, totalBlockedAllTime: stats.totalBlockedAllTime || 0 };
  }
  if (message.type === 'GET_DB') {
    const db = await getDatabaseForContent({ bundled: message.bundled === true });
    return db ? { success: true, db } : { success: false };
  }
  if (message.type === 'GET_UI_CSS') {
    return { success: true, css: await getUiCss() };
  }
  if (message.type === 'GET_FONT') {
    return { success: true, b64: await getFont(message.file) };
  }

  switch (message.type) {
    case 'GET_SETTINGS':
      return { success: true, settings: await readSettings() };

    case 'SUBMIT_FEEDBACK':
      // Consent is re-checked inside submit() so a UI bug can't leak data.
      return ScaredyCatFeedback.submit(message.report, await readSettings());

    case 'UPDATE_SETTINGS': {
      // Content scripts only get here with { feedbackConsent } (guards.js).
      const patch = message.settings;
      const { previous, settings } = await updateSettings(current => ({ ...current, ...patch }));
      if (previous.enabled && !settings.enabled) clearAllBadges();
      notifyAllTabs({ type: 'SETTINGS_UPDATED', settings });
      return { success: true, settings };
    }

    case 'GET_SITE_STATUS': {
      const settings = await readSettings();
      const isDisabled = settings.disabledSites.includes(message.hostname.toLowerCase());
      return { success: true, isDisabled, enabled: settings.enabled };
    }

    case 'TOGGLE_SITE': {
      const site = message.hostname.toLowerCase();
      const { settings } = await updateSettings(current => ({
        ...current,
        disabledSites: current.disabledSites.includes(site)
          ? current.disabledSites.filter(s => s !== site)
          : [...current.disabledSites, site]
      }));
      const nowDisabled = settings.disabledSites.includes(site);
      if (nowDisabled) clearAllBadges(site);
      return { success: true, isDisabled: nowDisabled };
    }

    case 'ADD_TO_ALLOWLIST': {
      if (ScaredyCatAllowlist.isImageItem(message.item)) {
        const key = ScaredyCatImageKey.canonicalImageKey(message.item);
        await updateAllowedImages(current => [...current, key]);
      } else {
        const { previous, settings } = await updateSettings(current => ({
          ...current,
          allowedTitles: ScaredyCatGuards.addTitles(current.allowedTitles, [message.item], ScaredyCatScoring.normalizeText)
        }));
        if (settings.allowedTitles.join('\n') !== previous.allowedTitles.join('\n')) {
          notifyAllTabs({ type: 'SETTINGS_UPDATED', settings });
        }
      }
      return { success: true };
    }

    case 'REMOVE_FROM_ALLOWLIST': {
      if (ScaredyCatAllowlist.isImageItem(message.item)) {
        const key = ScaredyCatImageKey.canonicalImageKey(message.item);
        await updateAllowedImages(current => ScaredyCatAllowlist.removeImageKey(current, key));
      } else {
        const title = ScaredyCatScoring.normalizeText(message.item);
        const { previous, settings } = await updateSettings(current => ({
          ...current,
          allowedTitles: current.allowedTitles.filter(t => t !== title)
        }));
        if (settings.allowedTitles.length !== previous.allowedTitles.length) {
          notifyAllTabs({ type: 'SETTINGS_UPDATED', settings });
        }
      }
      return { success: true };
    }

    case 'ADD_TO_BLOCKLIST': {
      // A "missed horror" report. Persist before anything else so the block
      // holds even if the report itself is never sent (no consent, offline).
      const key = ScaredyCatImageKey.canonicalImageKey(message.item);
      const blockedItems = await updateBlockedItems(
        current => [...current.filter(k => k !== key), key]
      );
      // Keep the lists disjoint: a report overrides an earlier "Allow", at
      // any size variant of the poster.
      await updateAllowedImages(current => ScaredyCatAllowlist.removeImageKey(current, key));
      return { success: true, blockedItems };
    }

    case 'REMOVE_FROM_BLOCKLIST': {
      const key = ScaredyCatImageKey.canonicalImageKey(message.item);
      const blockedItems = await updateBlockedItems(
        current => current.filter(k => k !== key)
      );
      return { success: true, blockedItems };
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}

/**
 * Send a message to all tabs, in parallel. Tabs without the content script
 * just reject, which is fine.
 */
async function notifyAllTabs(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs.filter(tab => tab.id != null).map(tab => chrome.tabs.sendMessage(tab.id, message))
  );
}

console.log('Scaredy Cat background service worker loaded!');
