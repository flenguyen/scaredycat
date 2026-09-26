/**
 * Scaredy Cat - Element Picker
 * Turns the page into a click-to-report surface for missed blurs (horror we
 * failed to catch). Launched from the popup's "Report something that wasn't
 * blurred" button. Hovering highlights the element under the cursor; a click
 * selects it and files a `missed_blur` report; Escape cancels.
 *
 * It reuses the detector's text-context extraction so the report carries the
 * same nearby-text signal a real detection would. Submission and all
 * acknowledgement UI go through ScaredyCatFeedbackUI. Styles: feedback.css.
 */

window.ScaredyCatPicker = (function () {
  'use strict';

  let active = false;
  let box = null;       // the floating highlight rectangle
  let hint = null;      // the "click the thing we missed" banner
  let lastTarget = null;

  function isOwnUi(el) {
    return !!el && !!el.closest && !!el.closest(
      '.scaredycat-picker-box, .scaredycat-picker-hint, .scaredycat-toast, ' +
      '.scaredycat-consent, .scaredycat-consent-backdrop'
    );
  }

  function positionBox(el) {
    const rect = el.getBoundingClientRect();
    box.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    box.style.display = 'block';
  }

  // mousemove can fire far above frame rate; coalesce to one hit-test and
  // one layout read per frame.
  let moveRaf = 0;
  let lastX = 0;
  let lastY = 0;
  function onMove(e) {
    lastX = e.clientX;
    lastY = e.clientY;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (!active || !box) return;
      const el = document.elementFromPoint(lastX, lastY);
      if (!el || isOwnUi(el)) { box.style.display = 'none'; lastTarget = null; return; }
      lastTarget = el;
      positionBox(el);
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stop();
      window.ScaredyCatFeedbackUI?.toast('Cancelled 🐾');
    }
  }

  // Resolve the most report-worthy element near the click: prefer a real media
  // element (the click may land on an overlaying link/div).
  function resolveTarget(el) {
    if (!el) return null;
    if (/^(IMG|VIDEO|IFRAME)$/.test(el.tagName)) return el;
    const media = el.querySelector && el.querySelector('img, video, iframe');
    if (media) return media;
    const up = el.closest && el.closest('img, video, iframe, a, article, [class*="card"], [class*="poster"]');
    return up || el;
  }

  function describe(el) {
    const kind = el.tagName === 'IMG' ? 'image'
      : el.tagName === 'VIDEO' ? 'video'
      : el.tagName === 'IFRAME' ? 'iframe' : 'other';
    let src = el.src || el.poster || '';
    if (!src && el.querySelector) {
      const inner = el.querySelector('img, video');
      src = inner?.src || inner?.poster || '';
    }
    let note = '';
    try {
      // Reuse the detector's context extraction for the same text signal a real
      // detection would carry (alt text, nearby link, captions).
      const ctx = window.ScaredyCatDetector?.extractTextContext?.(el);
      note = (typeof ctx === 'string' ? ctx : ctx?.context || '').slice(0, 240);
    } catch (e) { /* best effort */ }
    return { kind, src, note };
  }

  async function onClick(e) {
    if (isOwnUi(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    const target = resolveTarget(lastTarget || e.target);
    stop();
    if (!target) return;

    const info = describe(target);
    // Block first: the click means "hide this". The report is the optional part.
    if (info.src) window.ScaredyCat?.blockReported?.(info.src);
    const report = {
      type: 'missed_blur',
      element: {
        src: info.src,
        kind: info.kind,
        matchedTitle: null,
        confidence: 0,
        band: '',
        reasons: ['user-reported missed blur']
      },
      note: info.note
    };
    await window.ScaredyCatFeedbackUI?.submit(report);
  }

  function start() {
    if (active) return;
    if (!document.body) return;
    active = true;

    box = document.createElement('div');
    box.className = 'scaredycat-picker-box';
    box.style.display = 'none';
    document.body.appendChild(box);

    hint = document.createElement('div');
    hint.className = 'scaredycat-picker-hint';
    hint.textContent = 'Click the horror we missed · Esc to cancel';
    document.body.appendChild(hint);

    document.documentElement.classList.add('scaredycat-picking');
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function stop() {
    if (!active) return;
    active = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.classList.remove('scaredycat-picking');
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
    box?.remove(); box = null;
    hint?.remove(); hint = null;
    lastTarget = null;
  }

  return { start, stop, isActive: () => active };
})();
