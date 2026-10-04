/**
 * Scaredy Cat - Allowlist rules
 * "Allow" stores two kinds of things. Images go to chrome.storage.local
 * (allowedImages) as canonical image keys, so the same poster at another
 * size stays allowed and image URLs never sync to Google (sync's 8 KB
 * per-item limit would break on them anyway). Titles go to synced settings
 * (settings.allowedTitles) as normalized text, so allowing "The Exorcist"
 * follows the user to other devices. Matching is exact on both sides.
 *
 * Older versions kept both in one synced settings.allowedItems list;
 * splitLegacy() turns that into the two new lists (the worker runs it once
 * after an update).
 *
 * Pure functions (unit-tested in eval/allowlist-test.mjs). Loaded into the
 * service worker via importScripts.
 */

const ScaredyCatAllowlist = (function () {
  'use strict';

  const IMAGES_MAX = 500;
  const ITEM_MAX = 2048;

  /** An item the content script took from an element's src/poster. */
  function isImageItem(item) {
    return typeof item === 'string' && /^(https?|data|blob):/i.test(item);
  }

  /**
   * Append keys, deduplicated; re-adding moves a key to the end (newest),
   * and the oldest fall off past the cap.
   */
  function addImageKeys(current, keys, cap = IMAGES_MAX) {
    const out = Array.isArray(current) ? current.filter(k => typeof k === 'string' && k && k.length <= ITEM_MAX) : [];
    for (const key of keys) {
      if (typeof key !== 'string' || !key || key.length > ITEM_MAX) continue;
      const i = out.indexOf(key);
      if (i !== -1) out.splice(i, 1);
      out.push(key);
    }
    return [...new Set(out)].slice(-cap);
  }

  function removeImageKey(current, key) {
    return (Array.isArray(current) ? current : []).filter(k => k !== key);
  }

  /**
   * Route one legacy allowedItems list into { images, titles }: URLs become
   * canonical keys, everything else a normalized title. Empty and oversized
   * entries are dropped.
   */
  function splitLegacy(items, canonicalKey, normalize) {
    const images = [];
    const titles = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (typeof item !== 'string' || !item || item.length > ITEM_MAX) continue;
      if (isImageItem(item)) {
        images.push(canonicalKey(item));
      } else {
        const t = normalize(item);
        if (t) titles.push(t);
      }
    }
    return { images, titles };
  }

  return { IMAGES_MAX, isImageItem, addImageKeys, removeImageKey, splitLegacy };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatAllowlist;
}
