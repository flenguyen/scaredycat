/**
 * Scaredy Cat - Welcome page script
 *
 * Builds the welcome page from data/welcome.json and wires it up. Two pages
 * run this exact file:
 *  - welcome/welcome.html in the extension (data-mode="extension"), opened
 *    on install and from the popup's "How it works" link;
 *  - scaredycat.app/welcome (data-mode="web"), which serves this file, the
 *    stylesheets and welcome.json from the repo's main branch and inlines the
 *    copy as <script id="welcome-copy" type="application/json">.
 * Change the copy in data/welcome.json and the markup here; both pages follow.
 *
 * The demo tiles mirror the DOM and classes built by content/blocker.js
 * (renderCard, revealElement, addHideAgainButton, addFalsePositiveLink) so
 * styles/blur-overlay.css draws them exactly as it does on IMDb. They never
 * message the worker: nothing a visitor does in a demo is sent or stored.
 * If blocker.js changes its card markup or copy, update the mirror here.
 *
 * Extension mode also has the real report-sharing switch and "Send a note"
 * form (ported from popup/popup.js). The website can't reach the extension,
 * so web mode shows where to find both in the popup instead.
 */

(() => {
  const root = document.getElementById('welcome');
  if (!root) return;

  const MODE = root.dataset.mode === 'web' ? 'web' : 'extension';
  const hasExtension = MODE === 'extension' && typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Must match REVEAL_MS / LARGE_TIER in content/blocker.js.
  const REVEAL_MS = 250;
  const LARGE_TIER = { width: 360, height: 220 };

  // ---- DOM helpers ---------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Copy strings may mark bold with **double asterisks**; nothing else. */
  function rich(tag, className, text) {
    const node = el(tag, className);
    String(text).split(/\*\*(.+?)\*\*/g).forEach((part, i) => {
      if (!part) return;
      node.appendChild(i % 2 ? el('strong', null, part) : document.createTextNode(part));
    });
    return node;
  }

  // Same shape as blocker.js makeText / makeButton.
  const makeText = (tag, className, text) => el(tag, className, text);

  function makeButton(label, className, onClick) {
    const btn = el('button', className, label);
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  // The content-side toast from styles/feedback.css, reused as is.
  let toastTimer = null;
  function toast(text) {
    let node = document.querySelector('.scaredycat-toast');
    if (!node) {
      node = el('div', 'scaredycat-toast');
      node.setAttribute('role', 'status');
      document.body.appendChild(node);
    }
    node.textContent = text;
    requestAnimationFrame(() => node.classList.add('scaredycat-toast--in'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('scaredycat-toast--in'), 3600);
  }

  // ---- Page skeleton -------------------------------------------------------

  function step({ numeral, flip, wide, text, titleId }) {
    const section = el('section', 'wc-step' + (flip ? ' wc-step--flip' : '') + (wide ? ' wc-step--wide' : ''));
    section.setAttribute('aria-labelledby', titleId);
    if (numeral) {
      const num = el('span', 'wc-numeral', numeral);
      num.setAttribute('aria-hidden', 'true');
      section.appendChild(num);
    }
    const col = el('div', 'wc-copy' + (wide ? ' wc-copy--wide' : ''));
    col.appendChild(el('p', 'wc-kicker', text.kicker));
    const title = el('h2', 'wc-title', text.title);
    title.id = titleId;
    col.appendChild(title);
    section.appendChild(col);
    return { section, col };
  }

  function tile(id, variant, demo, open) {
    const wrapper = el('div', 'scaredycat-wrapper wc-tile' + (open ? ' wc-tile--open' : ''));
    wrapper.id = id;
    const poster = el('div', `wc-poster wc-poster--${variant}`);
    const art = el('span', 'wc-poster-art', demo.posterArt);
    art.setAttribute('aria-hidden', 'true');
    poster.append(art, el('span', 'wc-poster-title', demo.posterTitle));
    wrapper.appendChild(poster);
    return wrapper;
  }

  function stage(...children) {
    const node = el('div', 'wc-stage');
    node.append(...children);
    return node;
  }

  function render(copy) {
    const refs = {};

    // Hero: what it does, in one line
    const hero = el('header', 'wc-hero');
    const mascot = el('span', 'wc-hero-mascot', '🙀');
    mascot.setAttribute('aria-hidden', 'true');
    hero.append(
      mascot,
      el('p', 'wc-kicker', copy.hero.kicker),
      el('h1', 'wc-hero-title', copy.hero.title),
      el('p', 'wc-hero-lede', copy.hero.lede),
      el('p', 'wc-aside', copy.hero.aside)
    );
    root.appendChild(hero);

    // 01: the value, in a tile you can poke
    const s1 = step({ numeral: '01', text: copy.see, titleId: 'wcSeeTitle' });
    copy.see.paragraphs.forEach(p => s1.col.appendChild(rich('p', null, p)));
    s1.col.appendChild(el('p', 'wc-hint', copy.see.hint));
    refs.spooky = tile('wcDemoSpooky', 'plum', copy.see.demo);
    s1.section.appendChild(stage(refs.spooky));
    root.appendChild(s1.section);

    // 02: unblocking something that wasn't horror
    const s2 = step({ numeral: '02', flip: true, text: copy.mistake, titleId: 'wcMistakeTitle' });
    const howto = el('ol', 'wc-howto');
    ['reveal', 'report', 'allow'].forEach((name, i) => {
      const li = rich('li', null, copy.mistake.steps[i]);
      li.dataset.step = name;
      howto.appendChild(li);
    });
    s2.col.appendChild(howto);
    refs.howto = [...howto.children];
    refs.mistake = tile('wcDemoMistake', 'lavender', copy.mistake.demo);
    s2.section.appendChild(stage(refs.mistake));
    root.appendChild(s2.section);

    // 03: blocking something Scaredy Cat missed
    const s3 = step({ numeral: '03', text: copy.missed, titleId: 'wcMissedTitle' });
    copy.missed.paragraphs.forEach(p => s3.col.appendChild(rich('p', null, p)));
    refs.openMenu = el('button', 'wc-ghost-btn', copy.missed.tryButton);
    refs.openMenu.type = 'button';
    refs.openMenu.setAttribute('aria-haspopup', 'menu');
    refs.openMenu.setAttribute('aria-controls', 'wcMockMenu');
    refs.openMenu.setAttribute('aria-expanded', 'false');
    s3.col.appendChild(refs.openMenu);
    refs.missed = tile('wcDemoMissed', 'mist', copy.missed.demo, true);
    // A stand-in for Chrome's own menu (a page can't open the real one on
    // demand). Only the Scaredy Cat item does anything.
    refs.menu = el('div', 'wc-menu');
    refs.menu.id = 'wcMockMenu';
    refs.menu.setAttribute('role', 'menu');
    refs.menu.setAttribute('aria-label', 'Right-click menu');
    refs.menu.hidden = true;
    copy.missed.menuItems.forEach(label => {
      const item = el('div', 'wc-menu-item', label);
      item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-disabled', 'true');
      refs.menu.appendChild(item);
    });
    const sep = el('div', 'wc-menu-sep');
    sep.setAttribute('role', 'separator');
    refs.menuReport = el('button', 'wc-menu-item wc-menu-item--sc', copy.missed.menuReport);
    refs.menuReport.type = 'button';
    refs.menuReport.setAttribute('role', 'menuitem');
    refs.menu.append(sep, refs.menuReport);
    refs.missStage = stage(refs.missed, refs.menu);
    s3.section.appendChild(refs.missStage);
    root.appendChild(s3.section);

    // 04: why reports matter, plus the sharing switch
    const s4 = step({ numeral: '04', wide: true, text: copy.loop, titleId: 'wcLoopTitle' });
    s4.col.appendChild(el('p', null, copy.loop.body));
    const loop = el('ol', 'wc-loop');
    copy.loop.cards.forEach((card, i) => {
      const li = el('li', 'wc-loop-card');
      const num = el('span', 'wc-loop-num', String(i + 1));
      num.setAttribute('aria-hidden', 'true');
      li.append(num, el('h3', 'wc-loop-title', card.title), el('p', null, card.text));
      loop.appendChild(li);
    });
    s4.section.appendChild(loop);
    const consent = el('div', 'wc-card wc-consent');
    if (MODE === 'extension') {
      const label = el('label', 'wc-switch');
      refs.consentToggle = el('input', 'wc-toggle-input');
      refs.consentToggle.type = 'checkbox';
      const slider = el('span', 'wc-toggle-slider');
      slider.setAttribute('aria-hidden', 'true');
      label.append(el('span', 'wc-switch-label', copy.loop.consentLabel), refs.consentToggle, slider);
      consent.appendChild(label);
    } else {
      consent.appendChild(rich('p', null, copy.loop.webConsent));
    }
    consent.appendChild(el('p', 'wc-consent-detail', copy.loop.consentDetail));
    refs.consentStatus = el('p', 'wc-status');
    refs.consentStatus.setAttribute('role', 'status');
    consent.appendChild(refs.consentStatus);
    s4.section.appendChild(consent);
    root.appendChild(s4.section);

    // Invite feedback
    const s5 = step({ text: copy.note, titleId: 'wcNoteTitle' });
    s5.col.appendChild(el('p', null, copy.note.body));
    if (MODE === 'extension') s5.section.appendChild(noteForm(copy.note, refs));
    else {
      const card = el('div', 'wc-card wc-webcard');
      card.appendChild(rich('p', null, copy.note.webCard));
      s5.section.appendChild(card);
    }
    root.appendChild(s5.section);

    // The one plum band: you're set, and the tip jar when copy.band.tip.enabled
    const band = el('section', 'wc-band');
    band.setAttribute('aria-labelledby', 'wcBandTitle');
    const bandCat = el('span', 'wc-band-mascot', '🙀');
    bandCat.setAttribute('aria-hidden', 'true');
    const bandTitle = el('h2', 'wc-band-title', copy.band.title);
    bandTitle.id = 'wcBandTitle';
    const tip = copy.band.tip.enabled === true;
    const bandBody = tip ? copy.band.body + ' ' + copy.band.tip.body : copy.band.body;
    band.append(bandCat, bandTitle, el('p', 'wc-band-body', bandBody));
    if (tip) {
      const kofi = el('a', 'wc-band-btn', copy.band.tip.cta);
      kofi.href = copy.band.tip.url;
      kofi.target = '_blank';
      kofi.rel = 'noopener';
      band.appendChild(kofi);
    }
    if (MODE === 'web') {
      const install = el('p', 'wc-band-install', copy.band.webInstall + ' ');
      const link = el('a', 'wc-band-link', copy.band.webInstallLink);
      link.href = copy.band.webInstallHref;
      install.appendChild(link);
      band.appendChild(install);
    }
    root.appendChild(band);

    const footer = el('footer', 'wc-footer');
    footer.appendChild(el('p', 'wc-aside', copy.footer.aside));
    refs.version = el('p', 'wc-version');
    footer.appendChild(refs.version);
    const privacy = el('p', 'wc-privacy');
    const privacyLink = el('a', '', copy.footer.privacy);
    privacyLink.href = copy.footer.privacyHref;
    if (MODE === 'extension') {
      privacyLink.target = '_blank';
      privacyLink.rel = 'noopener';
    }
    privacy.appendChild(privacyLink);
    footer.appendChild(privacy);
    // TMDB's terms want their logo and notice in the app. The website's own
    // footer already carries them, so the web page skips this.
    if (MODE === 'extension') {
      const credit = el('p', 'wc-credit');
      const tmdb = el('a', 'wc-credit-logo');
      tmdb.href = copy.footer.tmdbHref;
      tmdb.target = '_blank';
      tmdb.rel = 'noopener';
      const logo = el('img');
      logo.src = '../icons/tmdb.svg';
      logo.alt = 'TMDB';
      tmdb.appendChild(logo);
      credit.append(tmdb, ' ' + copy.footer.tmdb);
      footer.appendChild(credit);
    }
    root.appendChild(footer);

    return refs;
  }

  function noteForm(note, refs) {
    const form = el('form', 'wc-card wc-note-form');
    form.noValidate = true;
    const cats = el('div', 'wc-cats');
    cats.setAttribute('role', 'group');
    cats.setAttribute('aria-label', 'Feedback category');
    note.categories.forEach((c, i) => {
      const btn = el('button', 'wc-cat' + (i === 0 ? ' active' : ''), c.label);
      btn.type = 'button';
      btn.dataset.cat = c.id;
      btn.setAttribute('aria-pressed', String(i === 0));
      cats.appendChild(btn);
    });
    refs.noteCats = [...cats.children];

    refs.noteText = el('textarea', 'wc-input');
    refs.noteText.rows = 4;
    refs.noteText.maxLength = 2000;
    refs.noteText.placeholder = note.placeholder;
    refs.noteText.setAttribute('aria-label', 'Your note');

    refs.noteEmail = el('input', 'wc-input');
    refs.noteEmail.type = 'email';
    refs.noteEmail.maxLength = 200;
    refs.noteEmail.placeholder = note.emailPlaceholder;
    refs.noteEmail.setAttribute('aria-label', 'Email, optional');

    refs.noteConsent = el('div', 'wc-note-consent');
    refs.noteConsent.hidden = true;
    const actions = el('div', 'wc-note-consent-actions');
    refs.noteDecline = el('button', 'wc-ghost-btn wc-ghost-btn--sm', note.consentDecline);
    refs.noteDecline.type = 'button';
    refs.noteAccept = el('button', 'wc-plum-btn wc-plum-btn--sm', note.consentAccept);
    refs.noteAccept.type = 'button';
    actions.append(refs.noteDecline, refs.noteAccept);
    refs.noteConsent.append(el('p', null, note.consentText), actions);

    refs.noteSubmit = el('button', 'wc-plum-btn', note.send);
    refs.noteSubmit.type = 'submit';
    refs.noteStatus = el('p', 'wc-status');
    refs.noteStatus.setAttribute('role', 'status');

    form.append(cats, refs.noteText, refs.noteEmail, refs.noteConsent, refs.noteSubmit, refs.noteStatus);
    refs.noteForm = form;
    return form;
  }

  // ---- Demo tile -----------------------------------------------------------

  /**
   * Turn a .scaredycat-wrapper.wc-tile into a working blur card.
   * opts: { synopsis?, startBlocked, onReveal?, onHide?, onFalsePositive? }
   */
  function createDemo(wrapper, opts) {
    const poster = wrapper.querySelector('.wc-poster');
    const data = { cardState: 'blocked', everRevealed: false, overlay: null, blocked: false };

    function isLargeTier() {
      return wrapper.offsetWidth >= LARGE_TIER.width && wrapper.offsetHeight >= LARGE_TIER.height;
    }

    function renderCard() {
      const overlay = data.overlay;
      overlay.dataset.state = data.cardState;
      const isSwap = overlay.childElementCount > 0;
      overlay.textContent = '';

      const message = el('div', 'scaredycat-message' + (isSwap ? ' scaredycat-message--swap' : ''));
      const actions = el('div', 'scaredycat-actions');

      if (data.cardState === 'confirm') {
        message.appendChild(makeText('span', 'scaredycat-icon', '🙀'));
        message.appendChild(makeText('p', 'scaredycat-heading', 'You sure? Be honest.'));
        message.appendChild(makeText('p', 'scaredycat-subtext', 'Statistically, you are not.'));
        actions.appendChild(makeButton('Yes. Show it.', 'scaredycat-btn scaredycat-btn--secondary', reveal));
        actions.appendChild(makeButton('No. Tell me what happens.', 'scaredycat-btn scaredycat-btn--primary', () => setCardState('synopsis')));
      } else if (data.cardState === 'synopsis' && opts.synopsis) {
        const info = opts.synopsis;
        message.classList.add('scaredycat-message--synopsis');
        const title = makeText('p', 'scaredycat-syn-title', info.title);
        title.appendChild(makeText('span', 'scaredycat-syn-meta', ` (${info.year}, poster)`));
        message.appendChild(title);
        message.appendChild(makeText('p', 'scaredycat-syn-body', info.text));
        actions.appendChild(makeText('span', 'scaredycat-badge', '✅ Spoiled safely'));
        actions.appendChild(makeButton('← Back to the blur', 'scaredycat-btn scaredycat-btn--primary', () => setCardState('blocked')));
      } else {
        message.appendChild(makeText('span', 'scaredycat-icon', '🙀'));
        message.appendChild(makeText('p', 'scaredycat-heading', 'Something spooky was here.'));
        message.appendChild(makeText('p', 'scaredycat-subtext', "Blurred before it reached your eyes. You're welcome."));
        message.appendChild(makeText('span', 'scaredycat-text', 'Content hidden'));

        const showBtn = makeButton('', 'scaredycat-btn scaredycat-btn--secondary scaredycat-show-btn', () => {
          if (opts.synopsis && !data.everRevealed && isLargeTier()) setCardState('confirm');
          else reveal();
        });
        showBtn.title = 'Show anyway';
        showBtn.appendChild(makeText('span', 'scaredycat-btn-full', 'Show anyway'));
        showBtn.appendChild(makeText('span', 'scaredycat-btn-short', 'Show'));
        actions.appendChild(showBtn);

        if (opts.synopsis) {
          actions.appendChild(makeButton('Just tell me what happens', 'scaredycat-btn scaredycat-btn--primary scaredycat-spoil-btn', () => setCardState('synopsis')));
          const helpBtn = makeButton('?', 'scaredycat-btn scaredycat-btn--primary scaredycat-help-btn', () => setCardState('synopsis'));
          helpBtn.setAttribute('aria-label', 'Just tell me what happens');
          helpBtn.title = 'Just tell me what happens';
          actions.appendChild(helpBtn);
        }
      }

      message.appendChild(actions);
      overlay.appendChild(message);
    }

    function setCardState(state) {
      data.cardState = state;
      renderCard();
      const focusTarget = state === 'synopsis'
        ? data.overlay.querySelector('.scaredycat-btn--primary')
        : data.overlay.querySelector('.scaredycat-btn');
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    }

    function removeRevealedControls() {
      wrapper.querySelectorAll('.scaredycat-hide-again-btn, .scaredycat-fp-link').forEach(n => n.remove());
    }

    /** Blur instantly (never transition the blur in) and show the card. */
    function block() {
      if (data.blocked) return;
      data.blocked = true;
      removeRevealedControls();
      poster.classList.remove('scaredycat-revealing');
      poster.classList.add('scaredycat-blurred');
      poster.setAttribute('aria-hidden', 'true');

      const overlay = el('div', 'scaredycat-overlay');
      overlay.setAttribute('aria-live', 'polite');
      overlay.setAttribute('role', 'group');
      overlay.setAttribute('aria-label', 'Hidden by Scaredy Cat');
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && data.cardState !== 'blocked') {
          e.stopPropagation();
          setCardState('blocked');
        }
      });
      data.overlay = overlay;
      data.cardState = 'blocked';
      renderCard();
      wrapper.appendChild(overlay);
    }

    /** One coordinated motion, as in blocker.js revealElement. */
    function reveal() {
      const overlay = data.overlay;
      const viaKeyboard = !!overlay?.querySelector(':focus-visible');
      const instant = reducedMotion.matches;
      data.blocked = false;
      data.everRevealed = true;
      data.overlay = null;

      if (!instant) poster.classList.add('scaredycat-revealing');
      poster.classList.remove('scaredycat-blurred');
      poster.removeAttribute('aria-hidden');

      const finish = () => {
        poster.classList.remove('scaredycat-revealing');
        overlay?.remove();
      };
      if (instant || !overlay) finish();
      else {
        overlay.classList.add('scaredycat-fade-out');
        setTimeout(finish, REVEAL_MS + 100);
      }

      addRevealedControls();
      if (viaKeyboard) wrapper.querySelector('.scaredycat-hide-again-btn')?.focus({ preventScroll: true });
      opts.onReveal?.();
    }

    function addRevealedControls() {
      const hideBtn = makeButton('🙀 Hide again', 'scaredycat-hide-again-btn', () => {
        block();
        data.overlay.querySelector('.scaredycat-btn')?.focus({ preventScroll: true });
        opts.onHide?.();
      });
      wrapper.appendChild(hideBtn);

      const link = makeButton("This isn't horror", 'scaredycat-fp-link', () => {
        link.disabled = true;
        link.textContent = 'Thanks, noted';
        link.classList.add('scaredycat-fp-link--done');
        opts.onFalsePositive?.();
      });
      link.title = 'Tell us this was wrongly blurred';
      wrapper.appendChild(link);
    }

    /** Back to an untouched, unblurred tile (step 03's reset). */
    function reset() {
      data.overlay?.remove();
      data.overlay = null;
      data.blocked = false;
      data.everRevealed = false;
      removeRevealedControls();
      poster.classList.remove('scaredycat-blurred', 'scaredycat-revealing');
      poster.removeAttribute('aria-hidden');
    }

    if (opts.startBlocked) block();
    return { block, reset, isBlocked: () => data.blocked };
  }

  // ---- Wiring --------------------------------------------------------------

  function wireDemos(copy, refs) {
    // 01: See it work
    const see = copy.see.demo;
    createDemo(refs.spooky, {
      startBlocked: true,
      synopsis: { title: see.posterTitle, year: see.year, text: see.synopsis },
      onReveal: () => toast(see.revealToast)
    });

    // 02: Blurred by mistake. The how-to steps light up as you go.
    let reported = false;
    function setUnblockStep(name) {
      const at = refs.howto.findIndex(li => li.dataset.step === name);
      refs.howto.forEach((li, i) => {
        li.classList.toggle('is-done', i < at);
        li.classList.toggle('is-current', i === at);
        if (i === at) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
      });
    }
    setUnblockStep('reveal');
    createDemo(refs.mistake, {
      startBlocked: true,
      onReveal: () => setUnblockStep(reported ? 'allow' : 'report'),
      onHide: () => { if (!reported) setUnblockStep('reveal'); },
      onFalsePositive: () => {
        reported = true;
        setUnblockStep('allow');
        toast(copy.mistake.demo.reportToast);
      }
    });

    // 03: Something slipped through
    const { missed, menu, menuReport, openMenu, missStage } = refs;
    const missDemo = createDemo(missed, {
      startBlocked: false,
      onFalsePositive: () => toast(copy.missed.demo.undoToast)
    });

    function showMenu(x, y) {
      menu.hidden = false;
      // Keep the menu inside the stage, like Chrome keeps it on screen.
      const maxX = missStage.clientWidth - menu.offsetWidth - 8;
      const maxY = missStage.clientHeight - menu.offsetHeight - 8;
      menu.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
      menu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
      openMenu.setAttribute('aria-expanded', 'true');
    }

    function hideMenu() {
      if (menu.hidden) return;
      menu.hidden = true;
      openMenu.setAttribute('aria-expanded', 'false');
    }

    function resetMissed() {
      missDemo.reset();
      openMenu.textContent = copy.missed.tryButton;
      delete openMenu.dataset.mode;
    }

    missed.addEventListener('contextmenu', (e) => {
      if (missDemo.isBlocked()) return;
      e.preventDefault();
      const box = missStage.getBoundingClientRect();
      showMenu(e.clientX - box.left, e.clientY - box.top);
      menuReport.focus({ preventScroll: true });
    });

    openMenu.addEventListener('click', () => {
      if (openMenu.dataset.mode === 'reset') resetMissed();
      const t = missed.getBoundingClientRect();
      const box = missStage.getBoundingClientRect();
      showMenu(t.left - box.left + t.width * 0.3, t.top - box.top + t.height * 0.35);
      menuReport.focus({ preventScroll: true });
    });

    menuReport.addEventListener('click', () => {
      hideMenu();
      missDemo.block();
      openMenu.textContent = copy.missed.resetButton;
      openMenu.dataset.mode = 'reset';
      missed.querySelector('.scaredycat-btn')?.focus({ preventScroll: true });
      toast(copy.missed.demo.reportToast);
    });

    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        hideMenu();
        openMenu.focus();
      }
    });

    document.addEventListener('pointerdown', (e) => {
      if (!menu.contains(e.target) && e.target !== openMenu) hideMenu();
    });
  }

  // Extension only: the real sharing switch and note form.
  function wireExtension(copy, refs) {
    let feedbackConsent = false;

    function applyConsent(on) {
      feedbackConsent = !!on;
      refs.consentToggle.checked = feedbackConsent;
    }

    async function setConsent(on) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { feedbackConsent: on } });
        if (res?.success) applyConsent(res.settings.feedbackConsent);
        return !!res?.success;
      } catch (e) {
        return false;
      }
    }

    chrome.storage.sync.get('settings').then(({ settings }) => applyConsent(settings?.feedbackConsent));
    // Stay in step with the popup's switch if it's flipped while this tab is open.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.settings) applyConsent(changes.settings.newValue?.feedbackConsent);
    });

    refs.consentToggle.addEventListener('change', async () => {
      const wanted = refs.consentToggle.checked;
      if (!(await setConsent(wanted))) {
        applyConsent(!wanted);
        refs.consentStatus.textContent = copy.loop.consentError;
        return;
      }
      refs.consentStatus.textContent = wanted ? copy.loop.consentOn : copy.loop.consentOff;
    });

    // ---- Send a note (ported from popup/popup.js) ----
    const status = copy.note.status;
    let selectedCat = refs.noteCats[0]?.dataset.cat || 'other';

    refs.noteCats.forEach(btn => {
      btn.addEventListener('click', () => {
        selectedCat = btn.dataset.cat;
        refs.noteCats.forEach(b => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
      });
    });

    function buildGeneralReport() {
      return {
        type: 'general',
        title: selectedCat,
        note: (refs.noteText.value || '').slice(0, 2000),
        contact: (refs.noteEmail.value || '').slice(0, 200),
        // No page address: the consent text promises we don't send one.
        pageUrl: '',
        element: {}
      };
    }

    async function sendGeneral() {
      refs.noteSubmit.disabled = true;
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: 'SUBMIT_FEEDBACK', report: buildGeneralReport() });
      } catch (e) {
        res = null;
      }
      refs.noteSubmit.disabled = false;
      if (res?.needsConsent) {
        refs.noteConsent.hidden = false;
        refs.noteAccept.focus();
      } else if (res?.deduped) {
        refs.noteStatus.textContent = status.deduped;
      } else if (res?.success) {
        refs.noteStatus.textContent = res.queued ? status.queued : status.sent;
        refs.noteText.value = '';
        refs.noteEmail.value = '';
      } else if (res?.rateLimited) {
        refs.noteStatus.textContent = status.rateLimited;
      } else {
        refs.noteStatus.textContent = status.failed;
      }
    }

    refs.noteForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!refs.noteText.value.trim()) {
        refs.noteStatus.textContent = status.empty;
        refs.noteText.focus();
        return;
      }
      // First send needs consent: show the inline step instead of sending.
      if (!feedbackConsent) {
        refs.noteConsent.hidden = false;
        refs.noteStatus.textContent = '';
        refs.noteAccept.focus();
        return;
      }
      await sendGeneral();
    });

    refs.noteAccept.addEventListener('click', async () => {
      refs.noteConsent.hidden = true;
      if (await setConsent(true)) await sendGeneral();
      else refs.noteStatus.textContent = status.failed;
    });

    refs.noteDecline.addEventListener('click', () => {
      refs.noteConsent.hidden = true;
      refs.noteStatus.textContent = status.declined;
    });

    refs.version.textContent = `Version ${chrome.runtime.getManifest().version}`;
  }

  // ---- Boot ----------------------------------------------------------------

  async function loadCopy() {
    const inline = document.getElementById('welcome-copy');
    if (inline) return JSON.parse(inline.textContent);
    const res = await fetch(root.dataset.copy || '../data/welcome.json');
    if (!res.ok) throw new Error(`welcome.json: ${res.status}`);
    return res.json();
  }

  loadCopy().then((copy) => {
    if (copy.meta?.title) document.title = copy.meta.title;
    const refs = render(copy);
    wireDemos(copy, refs);
    if (hasExtension) wireExtension(copy, refs);
    root.dataset.ready = 'true';
  }).catch((e) => {
    console.error('Scaredy Cat: welcome page failed to load', e);
  });
})();
