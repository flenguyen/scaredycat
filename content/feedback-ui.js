/**
 * Scaredy Cat - Feedback UI (content side)
 * Shared in-page surface for every feedback channel: the one-time consent sheet,
 * the acknowledgement toast, and the single submit() helper that all callers
 * (blur-card "This isn't horror", the element picker, the right-click report)
 * route through. The popup has its own copies of consent/toast for its context.
 *
 * Consent and the actual network send live in the service worker; this file only
 * owns the page-level UI and message round-trips. Both surfaces render in closed
 * shadow roots (ui-kit.js) styled by styles/feedback.css, so the page can't
 * read them or click them. The consent sheet also refuses clicks the page could
 * have engineered: synthetic events, clicks in the first moments after it
 * appears, and clicks while the page has hidden or restyled it.
 */

window.ScaredyCatFeedbackUI = (function () {
  'use strict';

  let consentInFlight = null; // de-dupe concurrent consent prompts

  // A real click on "Share feedback" only counts once the sheet has been on
  // screen this long: a page can't open it under a click the user had already
  // started (or a key they were already pressing).
  const CONSENT_ARM_MS = 600;

  async function getConsent() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      return !!r?.settings?.feedbackConsent;
    } catch (e) {
      return false;
    }
  }

  async function setConsent(value) {
    try {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { feedbackConsent: value }
      });
    } catch (e) {
      // Non-fatal; submit() will just re-prompt next time.
    }
  }

  // ---- Toast --------------------------------------------------------------
  let toastHost = null;
  let toastEl = null;
  let toastTimer = null;

  function toast(message) {
    if (!document.documentElement) return;
    if (!toastHost || !toastHost.isConnected) {
      // A zero-size fixed host; the toast inside positions against the viewport.
      const { host, root } = ScaredyCatUI.createFloatingHost({
        style: { inset: 'auto', left: '0', bottom: '0', width: '0', height: '0', 'z-index': '2147483646', 'pointer-events': 'none' }
      });
      toastHost = host;
      toastEl = document.createElement('div');
      toastEl.className = 'scaredycat-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      root.appendChild(toastEl);
    }
    toastEl.textContent = message;
    // Reflow so the same toast re-animates on repeat sends.
    toastEl.classList.remove('scaredycat-toast--in');
    void toastEl.offsetWidth;
    toastEl.classList.add('scaredycat-toast--in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl?.classList.remove('scaredycat-toast--in');
    }, 3200);
  }

  // ---- Consent sheet ------------------------------------------------------
  // The sheet takes focus itself (not "Share feedback"), so a key the user is
  // already holding can't land on the opt-in button.
  const CONSENT_POST_CSS = '.scaredycat-consent:focus { outline: none !important; }';

  // Resolves true if the user opts in, false otherwise. Focus is trapped to the
  // two buttons; Escape declines.
  function showConsentSheet() {
    return new Promise((resolve) => {
      if (!document.documentElement) { resolve(false); return; }

      // Full-viewport host in the top layer: above any page z-index, and out
      // of reach of ancestor opacity, transforms and filters.
      const { host, root, styleText } = ScaredyCatUI.createFloatingHost({
        style: { inset: '0', 'z-index': '2147483647', 'pointer-events': 'auto' },
        topLayer: true,
        post: CONSENT_POST_CSS
      });

      const backdrop = document.createElement('div');
      backdrop.className = 'scaredycat-consent-backdrop';

      const sheet = document.createElement('div');
      sheet.className = 'scaredycat-consent';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-label', 'Share feedback with Scaredy Cat');
      sheet.tabIndex = -1;

      sheet.innerHTML = `
        <div class="scaredycat-consent-icon">🙀</div>
        <h2 class="scaredycat-consent-title">Help the cat learn?</h2>
        <p class="scaredycat-consent-body">
          To improve detection, we'd send a small report. It includes:
        </p>
        <ul class="scaredycat-consent-list">
          <li>The page address (cut off before any ? or #) and the image or video link</li>
          <li>Text next to it, what we matched, and how confident we were</li>
          <li>Your sensitivity setting and our version numbers</li>
        </ul>
        <p class="scaredycat-consent-note">
          It goes to our report database. We never send images or your browsing history. You can turn this off anytime in the popup.
        </p>
        <div class="scaredycat-consent-actions"></div>
      `;

      const actions = sheet.querySelector('.scaredycat-consent-actions');

      const decline = document.createElement('button');
      decline.type = 'button';
      decline.className = 'scaredycat-consent-btn scaredycat-consent-btn--ghost';
      decline.textContent = 'Not now';

      const accept = document.createElement('button');
      accept.type = 'button';
      accept.className = 'scaredycat-consent-btn scaredycat-consent-btn--primary';
      accept.textContent = 'Share feedback';

      actions.appendChild(decline);
      actions.appendChild(accept);

      const shownAt = performance.now();

      // Opt-in is the one click here that changes what leaves the device, so
      // it must be a real click on a sheet that is really there: armed for a
      // moment, untouched by page script (same inline style, still in the
      // document) and visible.
      function acceptCountable(e) {
        if (!e.isTrusted) return false;
        if (performance.now() - shownAt < CONSENT_ARM_MS) return false;
        if (!host.isConnected || host.getAttribute('style') !== styleText) return false;
        try {
          if (!host.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
        } catch (err) {
          return false;
        }
        return true;
      }

      let closed = false;
      function close(result) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        ScaredyCatUI.removeHost(host);
        resolve(result);
      }
      function onKey(e) {
        if (!e.isTrusted) return;
        if (e.key === 'Escape') { e.stopPropagation(); close(false); }
        if (e.key === 'Tab') {
          // Minimal focus trap between the two buttons.
          e.preventDefault();
          (root.activeElement === accept ? decline : accept).focus();
        }
      }

      decline.addEventListener('click', ScaredyCatUI.trusted(() => close(false)));
      accept.addEventListener('click', (e) => {
        if (acceptCountable(e)) close(true);
      });
      backdrop.addEventListener('click', ScaredyCatUI.trusted((e) => {
        if (e.target === backdrop) close(false);
      }));
      document.addEventListener('keydown', onKey, true);

      backdrop.appendChild(sheet);
      root.appendChild(backdrop);
      sheet.focus({ preventScroll: true });
    });
  }

  // Ensure consent, prompting once. Concurrent calls share one prompt.
  async function ensureConsent() {
    if (await getConsent()) return true;
    if (!consentInFlight) {
      consentInFlight = showConsentSheet().then(async (ok) => {
        if (ok) await setConsent(true);
        consentInFlight = null;
        return ok;
      });
    }
    return consentInFlight;
  }

  /**
   * The one send path for content-side feedback. `partial` is a report missing
   * the worker-filled fields (ids, versions, trimmed URL). Returns true on a
   * successful (or queued) send. Always sets pageUrl from the live location.
   */
  async function submit(partial) {
    if (!(await ensureConsent())) {
      toast('No worries — nothing was sent 🐾');
      return false;
    }
    const report = { ...partial, pageUrl: location.href };
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'SUBMIT_FEEDBACK', report });
    } catch (e) {
      toast("Couldn't send right now — try again later");
      return false;
    }

    if (res?.deduped) {
      toast('Already noted — thanks 🙀');
      return true;
    }
    if (res?.success) {
      toast(res.queued
        ? "Saved — the cat will send it when you're back online 🙀"
        : "Noted. The cat's taking notes 🙀");
      return true;
    }
    if (res?.rateLimited) {
      toast('Whoa, easy — give it a moment and try again');
      return false;
    }
    toast("Couldn't send right now — try again later");
    return false;
  }

  return { submit, toast, ensureConsent };
})();
