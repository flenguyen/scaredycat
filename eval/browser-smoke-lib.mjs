/**
 * Shared helpers for the browser smoke tests.
 *
 * The extension keeps every per-element verdict and all of its in-page UI out
 * of the page's reach: verdicts live in the content script's isolated world
 * (ScaredyCatState) and the blur card, consent sheet and toasts render in
 * closed shadow roots. So the smokes read state over CDP inside the
 * "Scaredy Cat" isolated world, and click with real (trusted) input events at
 * coordinates measured there. page.evaluate (the main world) sees what a
 * hostile page would see, which is what eval/browser-smoke-hostile.mjs checks.
 */

/** Standard launch args for the unpacked extension. */
export function extensionArgs(root, extra = []) {
  return [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    ...extra
  ];
}

/**
 * Close the welcome tab the extension opens on install and bring `page` to
 * the front: a background tab doesn't render, so screenshots and real
 * clicks would stall.
 */
export async function focusPage(browser, page) {
  await new Promise(r => setTimeout(r, 800));
  for (const p of await browser.pages()) {
    if (p !== page && p.url().includes('/welcome/welcome.html')) await p.close().catch(() => {});
  }
  await page.bringToFront();
}

/**
 * Evaluate functions in the content script's isolated world of the page's
 * main frame. Survives navigations (contexts are tracked as they come and go).
 */
export async function isolatedWorld(page, { name = 'Scaredy Cat' } = {}) {
  const cdp = await page.createCDPSession();
  const contexts = new Map(); // id -> frameId
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.name === name && context.auxData && context.auxData.isDefault === false) {
      contexts.set(context.id, context.auxData.frameId);
    }
  });
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => contexts.clear());
  await cdp.send('Runtime.enable');

  async function mainFrameId() {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    return frameTree.frame.id;
  }

  async function contextId(timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const frameId = await mainFrameId();
      const ids = [...contexts].filter(([, f]) => f === frameId).map(([id]) => id);
      if (ids.length) return ids[ids.length - 1];
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('no Scaredy Cat isolated world in the main frame');
  }

  /** Run `fn(...args)` in the isolated world; returns its (JSON) value. */
  async function evaluate(fn, ...args) {
    const id = await contextId();
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const r = await cdp.send('Runtime.evaluate', {
      expression, contextId: id, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /** Poll `fn` in the isolated world until it returns truthy. */
  async function waitFor(fn, { timeout = 15000, interval = 100, args = [] } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await evaluate(fn, ...args);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`waitFor timed out (last: ${JSON.stringify(last)})`);
  }

  return { evaluate, waitFor, cdp };
}

/**
 * Functions for the isolated world, passed as source so evaluate() can
 * define them before running a step. `card(id)` returns the shadow parts of
 * the block around #id; `live(id, sel)` the last matching node in that card
 * that isn't fading out.
 */
export const CARD_HELPERS = `
  const card = (id) => {
    const el = document.getElementById(id);
    const wrapper = el && ScaredyCatBlocker.wrapperOf(el);
    const root = wrapper && ScaredyCatUI.__testShadowRoot(wrapper);
    return root ? { el, wrapper, root } : null;
  };
  const live = (id, sel) => {
    const c = card(id);
    if (!c) return null;
    const nodes = [...c.root.querySelectorAll(sel)].filter(n => !n.closest('.scaredycat-fade-out'));
    return nodes[nodes.length - 1] || null;
  };
  const isHidden = (id) => {
    const el = document.getElementById(id);
    return !!el && ScaredyCatBlocker.wrapperOf(el) !== null && el.style.getPropertyValue('opacity') === '0';
  };
`;

/**
 * Verdict and block state for elements by id, read in the isolated world:
 * { id: { state: 'blocked'|'safe'|...|null, blurred: bool } }.
 */
export function elementStates(world, ids) {
  return world.evaluate((ids) => Object.fromEntries(ids.map((id) => {
    const el = document.getElementById(id);
    return [id, {
      state: el ? ScaredyCatState.get(el) : null,
      blurred: !!el && ScaredyCatBlocker.wrapperOf(el) !== null &&
        el.style.getPropertyValue('opacity') === '0'
    }];
  })), ids);
}

/** Evaluate `body` (a function source taking `args`) with CARD_HELPERS in scope. */
export function withHelpers(world, body, ...args) {
  return world.evaluate(`(...args) => { ${CARD_HELPERS}; return (${body})(...args); }`, ...args);
}

/**
 * A real mouse click on the node `locate` (function source, runs in the
 * isolated world with CARD_HELPERS) returns. Scrolls it into view first if
 * it is off-screen (only then: scrollIntoView also scrolls overflow:hidden
 * ancestors such as the card frame). Returns false if there was nothing to
 * click.
 */
export async function realClick(page, world, locate, ...args) {
  const point = await withHelpers(world, `(...a) => {
    const node = (${locate})(...a);
    if (!node) return null;
    let r = node.getBoundingClientRect();
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
      node.scrollIntoView({ block: 'center', inline: 'center' });
      r = node.getBoundingClientRect();
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }`, ...args);
  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}
