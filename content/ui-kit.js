/**
 * Scaredy Cat - In-page UI kit
 * Shared plumbing for everything we draw on a third-party page (the blur
 * card, the consent sheet, toasts, the picker):
 *  - closed shadow roots, so the page can neither read our UI nor reach its
 *    buttons to .click() them;
 *  - styles adopted as constructed stylesheets from CSS text the worker sends
 *    once per tab (GET_UI_CSS). Nothing is injected into the page's own CSS
 *    and no chrome-extension:// URL is ever fetched or written into the DOM;
 *  - brand fonts built from bytes the worker sends (GET_FONT), loaded lazily
 *    on the first card;
 *  - trusted(): event handlers that ignore synthetic (page-dispatched) events.
 *
 * styles/blur-overlay.css and styles/feedback.css stay plain light-DOM
 * stylesheets: the welcome page links them directly.
 */

const ScaredyCatUI = (function () {
  'use strict';

  // ---- Stylesheets ---------------------------------------------------------

  let sheets = null;      // { overlay, feedback } constructed sheets, once loaded
  let sheetsPromise = null;
  const textSheets = new Map(); // css text -> constructed sheet (shared across roots)

  function sheetFor(cssText) {
    let sheet = textSheets.get(cssText);
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      textSheets.set(cssText, sheet);
    }
    return sheet;
  }

  /**
   * The card and feedback sheets, fetched from the worker once per tab.
   * Resolves null on failure and forgets it, so the next block retries.
   */
  function loadSheets() {
    if (sheets) return Promise.resolve(sheets);
    if (!sheetsPromise) {
      sheetsPromise = (async () => {
        const res = await chrome.runtime.sendMessage({ type: 'GET_UI_CSS' });
        const css = res && res.success && res.css;
        if (!css || typeof css.overlay !== 'string' || typeof css.feedback !== 'string') {
          throw new Error('no UI css');
        }
        sheets = { overlay: sheetFor(css.overlay), feedback: sheetFor(css.feedback) };
        return sheets;
      })().catch(() => {
        sheetsPromise = null;
        return null;
      });
    }
    return sheetsPromise;
  }

  // ---- Shadow roots ----------------------------------------------------------

  // Closed roots are only reachable through this map, which lives in the
  // isolated world. The page sees `host.shadowRoot === null`.
  const roots = new WeakMap(); // host -> closed shadow root
  const ownHosts = new WeakSet();

  /**
   * Attach a closed shadow root to `host`.
   *   kinds:    which worker sheets to adopt ('overlay', 'feedback')
   *   pre/post: CSS text adopted synchronously, before/after those sheets.
   *             `pre` carries whatever must hold on the very first frame.
   *   onStyled: called once the worker sheets are adopted.
   */
  function attach(host, { kinds = [], pre = '', post = '', onStyled } = {}) {
    const root = host.attachShadow({ mode: 'closed' });
    roots.set(host, root);
    ownHosts.add(host);
    const before = pre ? [sheetFor(pre)] : [];
    const after = post ? [sheetFor(post)] : [];
    root.adoptedStyleSheets = [...before, ...after];
    if (kinds.length) {
      loadSheets().then((loaded) => {
        if (!loaded) return;
        root.adoptedStyleSheets = [...before, ...kinds.map(k => loaded[k]), ...after];
        if (onStyled) onStyled();
      });
    }
    return root;
  }

  // Floating hosts (consent sheet, toast, picker) sit directly under <html>,
  // so body-level transforms, filters or opacity can't touch them. Every
  // property the host needs is inline and !important: page stylesheets can't
  // override an inline !important declaration.
  function hostStyle(extra) {
    const base = {
      all: 'initial',
      position: 'fixed',
      display: 'block',
      opacity: '1',
      visibility: 'visible',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      overflow: 'visible',
      ...extra
    };
    return Object.entries(base).map(([k, v]) => `${k}: ${v} !important`).join('; ');
  }

  /**
   * Create a floating host + closed root, appended under <html>.
   *   style:    extra inline host properties (inset, z-index, pointer-events)
   *   topLayer: show the host as a manual popover, which puts it in the top
   *             layer above any page z-index and outside ancestor effects.
   * Returns { host, root, styleText }; styleText is what the host's style
   * attribute must still equal for the host to count as untampered.
   */
  function createFloatingHost({ style = {}, topLayer = false, kinds = ['feedback'], pre = '', post = '' } = {}) {
    const host = document.createElement('div');
    const styleText = hostStyle(style);
    host.setAttribute('style', styleText);
    const root = attach(host, { kinds, pre, post });
    (document.documentElement || document.body).appendChild(host);
    if (topLayer) {
      try {
        host.popover = 'manual';
        host.showPopover();
      } catch (e) {
        // No popover support or not connected: the inline styles still show it.
        host.removeAttribute('popover');
      }
    }
    return { host, root, styleText };
  }

  function removeHost(host) {
    if (!host) return;
    try { if (host.matches(':popover-open')) host.hidePopover(); } catch (e) { /* ignore */ }
    host.remove();
  }

  // ---- Fonts -------------------------------------------------------------------

  // @font-face would need a chrome-extension:// URL in the page (which leaks
  // the extension id and needs web_accessible_resources). FontFace objects
  // built from bytes need neither. Document-level faces also apply inside
  // shadow roots. System stacks in the CSS cover a failed load.
  const BRAND_FONTS = [
    { family: 'Bricolage Grotesque', style: 'normal', weight: '700 800', file: 'BricolageGrotesque.woff2' },
    { family: 'Inter', style: 'normal', weight: '400 700', file: 'Inter.woff2' },
    { family: 'Fraunces', style: 'normal', weight: '400 700', file: 'Fraunces.woff2' },
    { family: 'Fraunces', style: 'italic', weight: '400 700', file: 'Fraunces-Italic.woff2' }
  ];
  let fontsPromise = null;

  function base64ToBuffer(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64).buffer;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function loadFont(f) {
    const res = await chrome.runtime.sendMessage({ type: 'GET_FONT', file: f.file });
    if (!res || !res.success || typeof res.b64 !== 'string') throw new Error('no font');
    const face = new FontFace(f.family, base64ToBuffer(res.b64), {
      style: f.style, weight: f.weight, display: 'swap'
    });
    await face.load();
    document.fonts.add(face);
  }

  /** Register the brand fonts once per document. Best effort. */
  function ensureFonts() {
    if (!fontsPromise) {
      fontsPromise = Promise.all(BRAND_FONTS.map(f => loadFont(f).catch(() => {}))).then(() => {});
    }
    return fontsPromise;
  }

  // ---- Events ------------------------------------------------------------------

  /**
   * Wrap a handler so it only runs for real user input. Synthetic events
   * (el.click(), dispatchEvent from page script) have isTrusted === false.
   */
  function trusted(handler) {
    return function (e) {
      if (!e || !e.isTrusted) return;
      return handler.call(this, e);
    };
  }

  return {
    loadSheets,
    attach,
    createFloatingHost,
    removeHost,
    ensureFonts,
    trusted,
    isOwnHost: (el) => !!el && ownHosts.has(el),
    // Test hook for the eval/browser-smoke* scripts, which drive the closed
    // UI over CDP in the content script's isolated world. The page's main
    // world can't reach this object at all.
    __testShadowRoot: (host) => roots.get(host) || null
  };
})();

window.ScaredyCatUI = ScaredyCatUI;
