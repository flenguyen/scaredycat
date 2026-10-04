/**
 * Scaredy Cat - Popup Script
 * Handles the popup UI interactions and communication with background/content scripts
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const enableToggle = document.getElementById('enableToggle');
  const statusCard = document.getElementById('statusCard');
  const blockedCount = document.getElementById('blockedCount');
  const statusLabel = document.getElementById('statusLabel');
  const sensitivityBtns = document.querySelectorAll('.sensitivity-btn');
  const sensitivityValue = document.getElementById('sensitivityValue');
  const sensitivityHint = document.getElementById('sensitivityHint');
  const siteToggle = document.getElementById('siteToggle');
  const blockedSection = document.getElementById('blockedSection');
  const blockedList = document.getElementById('blockedList');
  const showAllBtn = document.getElementById('showAllBtn');
  const totalBlocked = document.getElementById('totalBlocked');
  const container = document.querySelector('.popup-container');

  // Feedback section
  const reportMissedBtn = document.getElementById('reportMissedBtn');
  const sendFeedbackBtn = document.getElementById('sendFeedbackBtn');
  const feedbackForm = document.getElementById('feedbackForm');
  const feedbackText = document.getElementById('feedbackText');
  const feedbackEmail = document.getElementById('feedbackEmail');
  const feedbackCats = document.querySelectorAll('.feedback-cat[data-cat]');
  const feedbackSubmit = document.getElementById('feedbackSubmit');
  const feedbackStatus = document.getElementById('feedbackStatus');
  const popupConsentRow = document.getElementById('popupConsentRow');
  const popupConsentAccept = document.getElementById('popupConsentAccept');
  const popupConsentDecline = document.getElementById('popupConsentDecline');
  const feedbackConsentToggle = document.getElementById('feedbackConsentToggle');

  // What's new (footer link + its view)
  const mainView = document.getElementById('mainView');
  const whatsNew = document.getElementById('whatsNew');
  const whatsNewOpen = document.getElementById('whatsNewOpen');
  const footerVersion = document.getElementById('footerVersion');
  const whatsNewBack = document.getElementById('whatsNewBack');
  const whatsNewMeta = document.getElementById('whatsNewMeta');
  const whatsNewHighlight = document.getElementById('whatsNewHighlight');
  const whatsNewPatches = document.getElementById('whatsNewPatches');
  const whatsNewPatchList = document.getElementById('whatsNewPatchList');
  const whatsNewMore = document.getElementById('whatsNewMore');
  // Top-level const from whats-new.js: shared global scope, not a window property.
  const WhatsNew = typeof ScaredyCatWhatsNew !== 'undefined' ? ScaredyCatWhatsNew : null;

  // State
  let settings = null;
  let currentTab = null;
  let currentHostname = '';
  let pageState = { count: 0, unsupported: false };
  const extVersion = chrome.runtime.getManifest().version;
  let releases = null;      // parsed data/releases.json, null if it didn't load
  let whatsNewSeen = null;  // version whose notes the user last opened

  // Mirrors background.js DEFAULT_SETTINGS: the popup reads storage directly
  // (no service-worker round trip), so it must tolerate a missing key.
  const DEFAULT_SETTINGS = {
    enabled: true,
    sensitivity: 'medium',
    disabledSites: [],
    allowedItems: [],
    feedbackConsent: false
  };

  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(undefined), ms))
  ]);

  // Sensitivity descriptions
  const sensitivityDescriptions = {
    low: 'Blocks content with 80%+ horror confidence',
    medium: 'Blocks content with 60%+ horror confidence',
    high: 'Blocks content with 40%+ horror confidence (may have false positives)'
  };

  /**
   * Initialize the popup
   */
  async function init() {
    // Listeners first: a click during the (brief) load must never be lost.
    setupEventListeners();
    renderFooter(); // plain version until the release notes are read

    // Everything the first frame needs, in flight at once. Settings and the
    // all-time total come straight from storage (same shape the worker
    // returns) so opening the popup wakes the service worker zero times.
    const tabP = chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => tab || null)
      .catch(() => null);
    const pageStatsP = tabP
      .then(tab => tab?.id != null
        ? chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATS' })
        : { noContentScript: true })
      .catch(() => ({ noContentScript: true }));

    // Release notes ship inside the extension, so this is a local read that
    // lands well inside the first frame; the footer never changes after paint.
    const releasesP = loadReleases();

    try {
      const [tab, syncRes, localRes, notes] = await Promise.all([
        tabP,
        chrome.storage.sync.get('settings').catch(() => ({})),
        chrome.storage.local.get(['stats', 'whatsNewSeen']).catch(() => ({})),
        withTimeout(releasesP, 300)
      ]);
      whatsNewSeen = localRes?.whatsNewSeen ?? null;
      if (notes === undefined) {
        // Unusually slow disk: paint the plain version now, upgrade if it arrives.
        renderFooter();
        releasesP.then(late => { releases = late; renderFooter(); });
      } else {
        releases = notes;
        renderFooter();
      }
      currentTab = tab;
      try {
        currentHostname = new URL(tab.url).hostname;
      } catch (e) {
        currentHostname = '';
      }

      settings = { ...DEFAULT_SETTINGS, ...(syncRes?.settings || {}) };
      updateUI();
      totalBlocked.textContent = formatCount(localRes?.stats?.totalBlockedAllTime || 0);

      // A responsive tab gets its hidden-items list into the first frame; a
      // slow one applies late rather than holding the whole popup back.
      const stats = await withTimeout(pageStatsP, 120);
      if (stats?.success) {
        updatePageStats(stats);
      } else if (stats?.noContentScript) {
        pageState = { count: 0, unsupported: true };
        renderStatus();
      } else {
        pageStatsP.then(late => {
          if (late?.success) updatePageStats(late);
          else if (late?.noContentScript) {
            pageState = { count: 0, unsupported: true };
            renderStatus();
          }
        });
      }
    } finally {
      // One synchronous style flush so the before-change style is already the
      // final state; removing the gate then only fades the body in.
      void document.body.offsetHeight;
      document.documentElement.classList.remove('sc-preload');
    }
  }

  /**
   * The bundled release notes, or null when missing or unreadable (the footer
   * then shows just the version and the view isn't offered).
   */
  async function loadReleases() {
    try {
      if (!WhatsNew) return null;
      const res = await fetch(chrome.runtime.getURL('data/releases.json'));
      if (!res.ok) return null;
      const payload = await res.json();
      return WhatsNew.latestHighlight(payload).length ? payload : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Footer meta row: "v1.5.0 · What's new", or "New in 1.5 · See what changed"
   * when a Level 1/2 release hasn't been opened yet. Static: no dot, no motion.
   */
  function renderFooter() {
    if (!releases) {
      whatsNewOpen.hidden = true;
      footerVersion.textContent = `v${extVersion}`;
      footerVersion.hidden = false;
      return;
    }
    const highlight = WhatsNew.extensionReleases(releases).find(r => r.level === 1 || r.level === 2);
    const fresh = WhatsNew.shouldShowMarker(releases, whatsNewSeen);
    whatsNewOpen.textContent = fresh
      ? `${WhatsNew.markerLabel(highlight)} · See what changed`
      : `v${extVersion} · What's new`;
    whatsNewOpen.classList.toggle('is-new', fresh);
    whatsNewOpen.hidden = false;
    footerVersion.hidden = true;
  }

  // ---- What's new view ----------------------------------------------------
  // Built from the JSON with createElement + textContent only (never innerHTML).

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function metaLine(release) {
    const date = WhatsNew.formatDate(release.date);
    return date ? `${release.version} · ${date}` : release.version;
  }

  function changeList(items, className = 'release-list') {
    const ul = el('ul', className);
    for (const text of items) ul.appendChild(el('li', null, text));
    return ul;
  }

  function privacyCard(items) {
    const box = el('div', 'release-privacy');
    box.appendChild(el('h4', 'release-privacy-title', 'What this changes about your data'));
    box.appendChild(changeList(items));
    return box;
  }

  let whatsNewBuilt = false;
  function buildWhatsNew() {
    if (whatsNewBuilt || !releases) return;
    whatsNewBuilt = true;

    // Newest first: any Level 3 patches, then the Level 1/2 release they sit on.
    const entries = WhatsNew.latestHighlight(releases);
    const main = entries[entries.length - 1];
    const patches = entries.slice(0, -1);

    whatsNewMeta.textContent = metaLine(main);
    whatsNewHighlight.replaceChildren();
    whatsNewHighlight.appendChild(el('h3', 'release-title', main.title));
    if (main.aside) whatsNewHighlight.appendChild(el('p', 'release-aside', main.aside));

    const { groups, privacy } = WhatsNew.groupChanges(main.changes);
    for (const group of groups) {
      const block = el('div', 'release-group');
      block.appendChild(el('h4', 'control-title release-group-kicker', group.label));
      block.appendChild(changeList(group.items));
      whatsNewHighlight.appendChild(block);
    }
    if (privacy.length) whatsNewHighlight.appendChild(privacyCard(privacy));

    whatsNewPatchList.replaceChildren();
    for (const patch of patches) {
      const li = el('li', 'release-patch');
      li.appendChild(el('p', 'release-meta', metaLine(patch)));
      li.appendChild(el('p', 'release-patch-title', patch.title));
      li.appendChild(el('p', 'release-patch-summary', patch.summary));
      const patchPrivacy = WhatsNew.groupChanges(patch.changes).privacy;
      if (patchPrivacy.length) li.appendChild(privacyCard(patchPrivacy));
      whatsNewPatchList.appendChild(li);
    }
    whatsNewPatches.hidden = patches.length === 0;
  }

  function openWhatsNew() {
    if (!releases) return;
    buildWhatsNew();
    mainView.hidden = true;
    whatsNew.hidden = false;
    window.scrollTo(0, 0);
    whatsNewBack.focus();

    // Opening the notes is what "seen" means; the footer goes back to normal
    // for the next time the main view shows.
    whatsNewSeen = extVersion;
    renderFooter();
    chrome.storage.local.set({ whatsNewSeen: extVersion }).catch(() => {});
  }

  function closeWhatsNew() {
    whatsNew.hidden = true;
    mainView.hidden = false;
    whatsNewOpen.focus();
  }

  function setupWhatsNew() {
    whatsNewOpen.addEventListener('click', openWhatsNew);
    whatsNewBack.addEventListener('click', closeWhatsNew);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !whatsNew.hidden) {
        e.preventDefault(); // Esc would otherwise close the whole popup
        closeWhatsNew();
      }
    });
    whatsNewMore.addEventListener('click', () => {
      const newest = WhatsNew.extensionReleases(releases)[0];
      const anchor = newest ? WhatsNew.anchorFor(newest.version) : '';
      chrome.tabs.create({ url: `https://www.scaredycat.app/changelog${anchor ? '#' + anchor : ''}` });
    });
  }

  /**
   * The plum band: numeral + label, phrased for the page's actual state.
   */
  function renderStatus() {
    const enabled = settings ? settings.enabled : true;
    const sitePaused = !!(settings && currentHostname && settings.disabledSites.includes(currentHostname));
    const { count, unsupported } = pageState;

    if (!enabled) {
      blockedCount.textContent = '—';
      statusLabel.textContent = 'Paused everywhere';
    } else if (unsupported) {
      blockedCount.textContent = '—';
      statusLabel.textContent = "Can't run on this page";
    } else if (sitePaused) {
      blockedCount.textContent = '—';
      statusLabel.textContent = 'Paused on this site';
    } else if (count === 0) {
      blockedCount.textContent = '0';
      statusLabel.textContent = 'All clear on this page';
    } else {
      blockedCount.textContent = formatCount(count);
      statusLabel.textContent = count === 1 ? 'item hidden on this page' : 'items hidden on this page';
    }
  }

  function formatCount(n) {
    return Number(n).toLocaleString();
  }

  /**
   * Update UI based on current settings
   */
  function updateUI() {
    if (!settings) return;

    // Enable toggle
    enableToggle.checked = settings.enabled;
    container.classList.toggle('disabled', !settings.enabled);

    // Sensitivity buttons
    setSensitivityUI(settings.sensitivity);

    // Site toggle
    const isSiteDisabled = settings.disabledSites.includes(currentHostname);
    updateSiteToggle(isSiteDisabled);

    // Feedback consent toggle reflects the stored opt-in.
    if (feedbackConsentToggle) feedbackConsentToggle.checked = !!settings.feedbackConsent;

    renderStatus();
  }

  function setSensitivityUI(sensitivity) {
    sensitivityBtns.forEach(btn => {
      const on = btn.dataset.value === sensitivity;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    sensitivityValue.textContent = capitalizeFirst(sensitivity);
    sensitivityHint.textContent = sensitivityDescriptions[sensitivity];
  }

  /**
   * Update page stats display
   */
  function updatePageStats(stats) {
    pageState = { count: stats.blockedCount || 0, unsupported: false };
    renderStatus();

    // Update blocked items list
    if (stats.blockedItems && stats.blockedItems.length > 0) {
      blockedSection.hidden = false;
      renderBlockedItems(stats.blockedItems);
    } else {
      blockedSection.hidden = true;
    }
  }

  /**
   * Render the list of blocked items
   */
  function renderBlockedItems(items) {
    blockedList.innerHTML = '';

    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'blocked-item';

      let reason = item.title || item.reasons?.[0];
      if (!reason && item.src) {
        try {
          reason = decodeURIComponent(new URL(item.src).pathname.split('/').pop() || '');
        } catch (e) { /* fall through */ }
      }
      reason = reason || 'Horror content detected';
      const confidence = item.confidence || 0;

      li.innerHTML = `
        <div class="blocked-item-info">
          <span class="blocked-item-title">${escapeHtml(reason)}</span>
          <span class="blocked-item-confidence">${confidence}% confidence</span>
        </div>
        <div class="blocked-item-actions">
          <button class="wrong-btn" data-id="${item.id}" title="Tell us this isn't horror">Not horror?</button>
          <button class="allow-btn" data-id="${item.id}">Allow</button>
        </div>
      `;

      blockedList.appendChild(li);
    });

    // Add click handlers for allow buttons
    blockedList.querySelectorAll('.allow-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const response = await chrome.tabs.sendMessage(currentTab.id, {
            type: 'ALLOW_ITEM',
            id: btn.dataset.id
          });
          if (response?.success) {
            await refreshPageStats();
          } else {
            btn.disabled = false;
          }
        } catch (e) {
          btn.disabled = false;
        }
      });
    });

    // "Not horror?" — false-positive signal only; the content side handles
    // consent + toast and does NOT unblur (that's what "Allow" is for).
    blockedList.querySelectorAll('.wrong-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await chrome.tabs.sendMessage(currentTab.id, {
            type: 'REPORT_FALSE_POSITIVE',
            id: btn.dataset.id
          });
          btn.textContent = 'Thanks';
        } catch (e) {
          btn.disabled = false;
        }
      });
    });
  }

  /**
   * Re-query the content script and re-render the blocked list
   */
  async function refreshPageStats() {
    if (!currentTab) return;
    try {
      const stats = await chrome.tabs.sendMessage(currentTab.id, { type: 'GET_PAGE_STATS' });
      if (stats?.success) {
        updatePageStats(stats);
      }
    } catch (e) {
      // Content script might not be loaded
    }
  }

  // Image verdicts arrive after the synchronous text pass; one delayed
  // refresh picks them up without polling.
  let statsRefreshTimer = null;
  function scheduleStatsRefresh(delay = 700) {
    clearTimeout(statsRefreshTimer);
    statsRefreshTimer = setTimeout(refreshPageStats, delay);
  }

  /**
   * Update site toggle button state
   */
  function updateSiteToggle(isDisabled) {
    siteToggle.classList.toggle('site-disabled', isDisabled);
    siteToggle.setAttribute('aria-pressed', String(isDisabled));
    siteToggle.querySelector('.action-text').textContent = isDisabled
      ? '✓ Paused on this site'
      : 'Pause on this site';
  }

  /**
   * Set up event listeners
   */
  function setupEventListeners() {
    // Enable/disable toggle
    enableToggle.addEventListener('change', async () => {
      const enabled = enableToggle.checked;
      // Optimistic: the band and controls follow the switch immediately.
      container.classList.toggle('disabled', !enabled);
      if (settings) settings.enabled = enabled;
      renderStatus();

      const response = await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { enabled }
      });

      if (response?.success) {
        settings = response.settings;
        renderStatus();
        // The worker already broadcast SETTINGS_UPDATED to every tab; give the
        // page a beat to (un)blur, then refresh the list.
        scheduleStatsRefresh();
      } else {
        // Roll back
        enableToggle.checked = !enabled;
        container.classList.toggle('disabled', enabled);
        if (settings) settings.enabled = !enabled;
        renderStatus();
      }
    });

    // Sensitivity buttons
    sensitivityBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const sensitivity = btn.dataset.value;

        setSensitivityUI(sensitivity);

        const response = await chrome.runtime.sendMessage({
          type: 'UPDATE_SETTINGS',
          settings: { sensitivity }
        });

        if (response?.success) {
          settings = response.settings;
          if (!currentTab) return;

          // Trigger rescan on current page. The rescan acks synchronously
          // after the text pass; image verdicts land a moment later.
          try {
            await chrome.tabs.sendMessage(currentTab.id, { type: 'RESCAN_PAGE' });
            await refreshPageStats();
            scheduleStatsRefresh();
          } catch (e) {
            // Content script might not be loaded
          }
        }
      });
    });

    // Site toggle
    siteToggle.addEventListener('click', async () => {
      if (!currentHostname) return;

      const response = await chrome.runtime.sendMessage({
        type: 'TOGGLE_SITE',
        hostname: currentHostname
      });

      if (response?.success) {
        updateSiteToggle(response.isDisabled);

        // Reload settings
        const settingsResponse = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (settingsResponse?.success) {
          settings = { ...DEFAULT_SETTINGS, ...settingsResponse.settings };
        }
        renderStatus();
        if (!currentTab) return;

        // Trigger content script update
        try {
          await chrome.tabs.sendMessage(currentTab.id, {
            type: 'SETTINGS_UPDATED',
            settings
          });
          await refreshPageStats();
          scheduleStatsRefresh();
        } catch (e) {
          // Content script might not be loaded
        }
      }
    });

    // Show all button: session-only reveal of everything blocked on the page
    showAllBtn.addEventListener('click', async () => {
      if (!currentTab) return;
      try {
        await chrome.tabs.sendMessage(currentTab.id, { type: 'SHOW_ALL_PAGE' });
        await refreshPageStats();
      } catch (e) {
        // Content script might not be loaded
      }
    });

    setupFeedback();
    setupWhatsNew();
  }

  /**
   * Wire the feedback section: missed-blur picker launcher, the general
   * feedback form, the inline consent step, and the revocable consent toggle.
   */
  function setupFeedback() {
    let selectedCat = 'bug';

    // Launch the in-page element picker, then close the popup so the user can
    // click the missed content. Consent is handled in-page by the picker flow.
    reportMissedBtn?.addEventListener('click', async () => {
      try {
        if (!currentTab) throw new Error('no tab');
        await chrome.tabs.sendMessage(currentTab.id, { type: 'START_PICK_MODE' });
        window.close();
      } catch (e) {
        feedbackStatus.textContent = "Can't pick on this page — try the right-click menu.";
      }
    });

    // Expand/collapse the general feedback form.
    sendFeedbackBtn?.addEventListener('click', () => {
      const open = feedbackForm.hasAttribute('hidden');
      if (open) {
        feedbackForm.removeAttribute('hidden');
        sendFeedbackBtn.setAttribute('aria-expanded', 'true');
        feedbackText.focus();
      } else {
        feedbackForm.setAttribute('hidden', '');
        sendFeedbackBtn.setAttribute('aria-expanded', 'false');
      }
    });

    // Category chips (single select).
    feedbackCats.forEach(chip => {
      chip.addEventListener('click', () => {
        feedbackCats.forEach(c => {
          c.classList.remove('active');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        selectedCat = chip.dataset.cat;
      });
    });

    // Revocable consent toggle.
    feedbackConsentToggle?.addEventListener('change', async () => {
      const res = await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { feedbackConsent: feedbackConsentToggle.checked }
      });
      if (res?.success) settings = { ...DEFAULT_SETTINGS, ...res.settings };
    });

    function buildGeneralReport() {
      return {
        type: 'general',
        title: selectedCat,
        note: (feedbackText.value || '').slice(0, 2000),
        contact: (feedbackEmail.value || '').slice(0, 200),
        pageUrl: currentTab?.url || '',
        element: {}
      };
    }

    async function sendGeneral() {
      const report = buildGeneralReport();
      const res = await chrome.runtime.sendMessage({ type: 'SUBMIT_FEEDBACK', report });
      if (res?.deduped) {
        feedbackStatus.textContent = 'Already noted — thanks 🙀';
      } else if (res?.success) {
        feedbackStatus.textContent = res.queued
          ? "Saved — we'll send it when you're back online 🙀"
          : "Thanks! The cat's taking notes 🙀";
        feedbackText.value = '';
        feedbackEmail.value = '';
      } else if (res?.rateLimited) {
        feedbackStatus.textContent = 'Easy there — give it a moment.';
      } else {
        feedbackStatus.textContent = "Couldn't send right now — try again later.";
      }
    }

    feedbackForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!feedbackText.value.trim()) {
        feedbackStatus.textContent = 'Add a quick note first 🙂';
        feedbackText.focus();
        return;
      }
      // First send needs consent: show the inline step instead of sending.
      if (!settings?.feedbackConsent) {
        popupConsentRow.removeAttribute('hidden');
        feedbackStatus.textContent = '';
        popupConsentAccept.focus();
        return;
      }
      feedbackSubmit.disabled = true;
      await sendGeneral();
      feedbackSubmit.disabled = false;
    });

    // Inline consent: accept enables sharing and sends; decline backs out.
    popupConsentAccept?.addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { feedbackConsent: true }
      });
      if (res?.success) {
        settings = res.settings;
        if (feedbackConsentToggle) feedbackConsentToggle.checked = true;
      }
      popupConsentRow.setAttribute('hidden', '');
      feedbackSubmit.disabled = true;
      await sendGeneral();
      feedbackSubmit.disabled = false;
    });

    popupConsentDecline?.addEventListener('click', () => {
      popupConsentRow.setAttribute('hidden', '');
      feedbackStatus.textContent = 'No worries — nothing was sent 🐾';
    });
  }

  /**
   * Utility: Capitalize first letter
   */
  function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Utility: Escape HTML
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Initialize
  init();
});
