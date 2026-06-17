/**
 * Scaredy Cat - YouTube hover-preview guard
 *
 * YouTube uses a SINGLE shared inline-preview player (<ytd-video-preview>,
 * #video-preview) that it repositions over whatever thumbnail you hover and
 * autoplays muted. That player is a sibling of the thumbnail rendered on top —
 * NOT inside our blur wrapper — so the blocker's per-element video pausing never
 * touches it, and an accidental hover plays a horror trailer over a blocked
 * thumbnail.
 *
 * This guard suppresses (pauses + hides) that shared preview while the pointer
 * is over a blocked thumbnail. It is targeted: previews over safe thumbnails
 * play normally.
 *
 * Flash-free design: the suppressed state is driven by which thumbnail the
 * pointer is over (tracked in the CAPTURE phase, so it is immune to any
 * propagation quirks), not by a geometry read of the preview that may be stale
 * the instant it appears. When the pointer is over a blocked thumbnail we
 * pre-hide the preview, so it never paints a horror frame even for one tick.
 * A geometry overlap check is kept as a secondary backstop.
 */

const ScaredyCatYouTubeGuard = (function () {
  const SUPPRESSED_CLASS = 'scaredycat-preview-suppressed';
  // Fraction of the preview that must sit over a blocked thumbnail to count.
  const OVERLAP_THRESHOLD = 0.4;
  const PREVIEW_SELECTOR = 'ytd-video-preview, #video-preview, #inline-preview-player';

  let active = false;
  // Whether the pointer is currently over a blocked thumbnail.
  let hoveredBlocked = false;

  function isYouTube() {
    const h = location.hostname;
    return h === 'youtube.com' || h.endsWith('.youtube.com');
  }

  /** The preview host element to hide (keeps layout so geometry stays valid). */
  function previewHostOf(node) {
    return node && node.closest ? node.closest(PREVIEW_SELECTOR) : null;
  }

  /** The currently-mounted shared preview host, if any. */
  function currentPreviewHost() {
    return document.querySelector(PREVIEW_SELECTOR);
  }

  /**
   * Is the pointer over the item (thumbnail, title, channel, metadata...) that
   * owns a blocked thumbnail? Hovering anywhere in a YouTube video item — not
   * just the thumbnail — triggers the shared preview over that thumbnail, so the
   * whole item must count as "over blocked content".
   *
   * We climb from the target until we hit the smallest ancestor that contains a
   * blocked wrapper: that is the item renderer (the lowest common ancestor of
   * the title and its thumbnail). The bound keeps us from ever reaching a whole
   * shelf/grid of items.
   */
  function isOverBlockedItem(target) {
    let el = target;
    for (let i = 0; i < 10 && el && el.nodeType === 1; i++, el = el.parentElement) {
      if (el.classList && el.classList.contains('scaredycat-wrapper')) return true;
      if (el.querySelector && el.querySelector('.scaredycat-wrapper')) return true;
    }
    return false;
  }

  /** Blocked thumbnail wrappers, preferring the blocker's live tracking. */
  function blockedWrappers() {
    const blocker = window.ScaredyCatBlocker;
    if (blocker && blocker.getBlockedWrappers) {
      const wrappers = blocker.getBlockedWrappers();
      if (wrappers && wrappers.length) return wrappers;
    }
    return document.querySelectorAll('.scaredycat-wrapper');
  }

  /** Does `rect` overlap any blocked wrapper by more than the threshold? */
  function overlapsBlocked(rect) {
    const area = rect.width * rect.height;
    if (area <= 0) return false;
    for (const wrapper of blockedWrappers()) {
      if (!wrapper.isConnected) continue;
      const w = wrapper.getBoundingClientRect();
      const ix = Math.max(0, Math.min(rect.right, w.right) - Math.max(rect.left, w.left));
      const iy = Math.max(0, Math.min(rect.bottom, w.bottom) - Math.max(rect.top, w.top));
      if ((ix * iy) / area > OVERLAP_THRESHOLD) return true;
    }
    return false;
  }

  function suppress(host) {
    if (!host) return;
    host.classList.add(SUPPRESSED_CLASS);
    const video = host.querySelector('video');
    if (video) {
      try {
        video.pause();
        video.muted = true;
      } catch (e) {
        // Transient media state; the activity listener will catch retries.
      }
    }
  }

  function release(host) {
    if (host) host.classList.remove(SUPPRESSED_CLASS);
  }

  /**
   * Pointer tracking. Capture phase so nothing downstream can hide these events
   * from us. Events whose target is the preview itself are ignored, so the
   * (suppressed, pointer-events:none) preview overlaying a thumbnail can never
   * flip our state back.
   */
  function onPointer(e) {
    if (!active) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest(PREVIEW_SELECTOR)) return;
    const nowBlocked = isOverBlockedItem(t);
    if (nowBlocked === hoveredBlocked) return;
    hoveredBlocked = nowBlocked;
    const host = currentPreviewHost();
    // Pre-hide on entry (host may not exist yet — loadstart will catch it);
    // un-hide on exit so safe previews play normally.
    if (hoveredBlocked) suppress(host);
    else release(host);
  }

  /**
   * Preview activity. play/playing/loadstart do not bubble, so listen in the
   * capture phase. loadstart fires before the first frame paints, so suppressing
   * here while hoveredBlocked is true keeps the preview from ever flashing.
   */
  function onPreviewActivity(e) {
    if (!active) return;
    const video = e.target;
    if (!(video instanceof HTMLVideoElement)) return;
    // Videos inside our wrapper are the blocker's responsibility.
    if (video.closest('.scaredycat-wrapper')) return;
    const host = previewHostOf(video);
    if (!host) return;
    if (hoveredBlocked || overlapsBlocked(host.getBoundingClientRect())) {
      suppress(host);
    } else {
      release(host);
    }
  }

  function init() {
    if (active || !isYouTube()) return;
    active = true;
    document.addEventListener('pointerover', onPointer, true);
    document.addEventListener('play', onPreviewActivity, true);
    document.addEventListener('playing', onPreviewActivity, true);
    document.addEventListener('loadstart', onPreviewActivity, true);
  }

  function stop() {
    if (!active) return;
    active = false;
    hoveredBlocked = false;
    document.removeEventListener('pointerover', onPointer, true);
    document.removeEventListener('play', onPreviewActivity, true);
    document.removeEventListener('playing', onPreviewActivity, true);
    document.removeEventListener('loadstart', onPreviewActivity, true);
    document.querySelectorAll('.' + SUPPRESSED_CLASS).forEach(el => el.classList.remove(SUPPRESSED_CLASS));
  }

  return { init, stop };
})();

window.ScaredyCatYouTubeGuard = ScaredyCatYouTubeGuard;
