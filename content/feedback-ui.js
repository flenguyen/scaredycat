/**
 * Scaredy Cat - Feedback UI (content side)
 * Shared in-page surface for every feedback channel: the one-time consent sheet,
 * the acknowledgement toast, and the single submit() helper that all callers
 * (blur-card "This isn't horror", the element picker, the right-click report)
 * route through. The popup has its own copies of consent/toast for its context.
 *
 * Consent and the actual network send live in the service worker; this file only
 * owns the page-level UI and message round-trips. Styles are in
 * styles/feedback.css (injected via content_scripts).
 */

window.ScaredyCatFeedbackUI = (function () {
  'use strict';

  let consentInFlight = null; // de-dupe concurrent consent prompts

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
  let toastEl = null;
  let toastTimer = null;

  function toast(message) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'scaredycat-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
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
  // Resolves true if the user opts in, false otherwise. Focus is trapped to the
  // two buttons; Escape declines.
  function showConsentSheet() {
    return new Promise((resolve) => {
      if (!document.body) { resolve(false); return; }

      const backdrop = document.createElement('div');
      backdrop.className = 'scaredycat-consent-backdrop';

      const sheet = document.createElement('div');
      sheet.className = 'scaredycat-consent';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-label', 'Share feedback with Scaredy Cat');

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

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(false); }
        if (e.key === 'Tab') {
          // Minimal focus trap between the two buttons.
          e.preventDefault();
          (document.activeElement === accept ? decline : accept).focus();
        }
      }

      decline.addEventListener('click', () => close(false));
      accept.addEventListener('click', () => close(true));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
      document.addEventListener('keydown', onKey, true);

      backdrop.appendChild(sheet);
      document.body.appendChild(backdrop);
      accept.focus({ preventScroll: true });
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
