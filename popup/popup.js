/**
 * Scaredy Cat - Popup Script
 * Handles the popup UI interactions and communication with background/content scripts
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const enableToggle = document.getElementById('enableToggle');
  const statusCard = document.getElementById('statusCard');
  const blockedCount = document.getElementById('blockedCount');
  const sensitivityBtns = document.querySelectorAll('.sensitivity-btn');
  const sensitivityValue = document.getElementById('sensitivityValue');
  const sensitivityHint = document.getElementById('sensitivityHint');
  const siteToggle = document.getElementById('siteToggle');
  const blockedSection = document.getElementById('blockedSection');
  const blockedList = document.getElementById('blockedList');
  const showAllBtn = document.getElementById('showAllBtn');
  const totalBlocked = document.getElementById('totalBlocked');
  const container = document.querySelector('.popup-container');

  // State
  let settings = null;
  let currentTab = null;
  let currentHostname = '';

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
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    try {
      currentHostname = new URL(tab.url).hostname;
    } catch (e) {
      currentHostname = '';
    }

    // Load settings
    const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (response?.success) {
      settings = response.settings;
      updateUI();
    }

    // Get page stats
    try {
      const statsResponse = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATS' });
      if (statsResponse?.success) {
        updatePageStats(statsResponse);
      }
    } catch (e) {
      // Content script might not be loaded
      blockedCount.textContent = '—';
    }

    // Get total blocked
    const globalStats = await chrome.runtime.sendMessage({ type: 'GET_PAGE_STATS' });
    if (globalStats?.success) {
      totalBlocked.textContent = globalStats.totalBlockedAllTime || 0;
    }

    // Set up event listeners
    setupEventListeners();
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
    sensitivityBtns.forEach(btn => {
      const value = btn.dataset.value;
      btn.classList.toggle('active', value === settings.sensitivity);
    });
    sensitivityValue.textContent = capitalizeFirst(settings.sensitivity);
    sensitivityHint.textContent = sensitivityDescriptions[settings.sensitivity];

    // Site toggle
    const isSiteDisabled = settings.disabledSites.includes(currentHostname);
    updateSiteToggle(isSiteDisabled);
  }

  /**
   * Update page stats display
   */
  function updatePageStats(stats) {
    blockedCount.textContent = stats.blockedCount || 0;

    // Update blocked items list
    if (stats.blockedItems && stats.blockedItems.length > 0) {
      blockedSection.style.display = 'block';
      renderBlockedItems(stats.blockedItems);
    } else {
      blockedSection.style.display = 'none';
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

      let reason = item.reasons?.[0];
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
        <button class="allow-btn" data-id="${item.id}">Allow</button>
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
  }

  /**
   * Re-query the content script and re-render the blocked list
   */
  async function refreshPageStats() {
    try {
      const stats = await chrome.tabs.sendMessage(currentTab.id, { type: 'GET_PAGE_STATS' });
      if (stats?.success) {
        updatePageStats(stats);
      }
    } catch (e) {
      // Content script might not be loaded
    }
  }

  /**
   * Update site toggle button state
   */
  function updateSiteToggle(isDisabled) {
    if (isDisabled) {
      siteToggle.classList.add('site-disabled');
      siteToggle.querySelector('.action-text').textContent = 'Enable on this site';
      siteToggle.querySelector('.action-icon').textContent = '✓';
    } else {
      siteToggle.classList.remove('site-disabled');
      siteToggle.querySelector('.action-text').textContent = 'Disable on this site';
      siteToggle.querySelector('.action-icon').textContent = '🌐';
    }
  }

  /**
   * Set up event listeners
   */
  function setupEventListeners() {
    // Enable/disable toggle
    enableToggle.addEventListener('change', async () => {
      const enabled = enableToggle.checked;
      const response = await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { enabled }
      });

      if (response?.success) {
        settings = response.settings;
        container.classList.toggle('disabled', !enabled);

        // Notify content script
        try {
          await chrome.tabs.sendMessage(currentTab.id, {
            type: 'TOGGLE_ENABLED',
            enabled
          });
        } catch (e) {
          // Content script might not be loaded
        }
      }
    });

    // Sensitivity buttons
    sensitivityBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const sensitivity = btn.dataset.value;

        sensitivityBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sensitivityValue.textContent = capitalizeFirst(sensitivity);
        sensitivityHint.textContent = sensitivityDescriptions[sensitivity];

        const response = await chrome.runtime.sendMessage({
          type: 'UPDATE_SETTINGS',
          settings: { sensitivity }
        });

        if (response?.success) {
          settings = response.settings;

          // Trigger rescan on current page
          try {
            await chrome.tabs.sendMessage(currentTab.id, { type: 'RESCAN_PAGE' });
            // Refresh stats after a short delay
            setTimeout(async () => {
              const stats = await chrome.tabs.sendMessage(currentTab.id, { type: 'GET_PAGE_STATS' });
              if (stats?.success) {
                updatePageStats(stats);
              }
            }, 500);
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
          settings = settingsResponse.settings;
        }

        // Trigger content script update
        try {
          await chrome.tabs.sendMessage(currentTab.id, {
            type: 'SETTINGS_UPDATED',
            settings
          });

          // Refresh stats
          setTimeout(async () => {
            const stats = await chrome.tabs.sendMessage(currentTab.id, { type: 'GET_PAGE_STATS' });
            if (stats?.success) {
              updatePageStats(stats);
            }
          }, 500);
        } catch (e) {
          // Content script might not be loaded
        }
      }
    });

    // Show all button: session-only reveal of everything blocked on the page
    showAllBtn.addEventListener('click', async () => {
      try {
        await chrome.tabs.sendMessage(currentTab.id, { type: 'SHOW_ALL_PAGE' });
        await refreshPageStats();
      } catch (e) {
        // Content script might not be loaded
      }
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
