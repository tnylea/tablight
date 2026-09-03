// Content script: hosts the spotlight overlay inside a closed shadow root so
// page styles can't leak in and the page can't easily reach the UI. Also
// reports the page's own meta (og:image + site colour) so background tabs get
// a generated thumbnail without ever being visible, and tells the background
// when the page has settled after a scroll so screenshots reflect what the
// user actually last saw.

(function () {
  'use strict';
  if (window.__tabSpotlightInit) return;
  window.__tabSpotlightInit = true;

  let host = null;
  let instance = null;

  // runtime.sendMessage throws synchronously once the extension is reloaded
  // ("Extension context invalidated"); never let that surface on the page.
  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => undefined);
    } catch (e) {
      return Promise.resolve(undefined);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'toggle-spotlight') {
      if (host) {
        // Shortcut pressed again while open: with nothing typed that's the
        // alt-tab gesture (⌘⇧Space, Space); otherwise it's a toggle.
        if (instance && instance.isEmpty()) instance.goPrevious();
        else closeSpotlight();
        sendResponse({ open: false });
      } else {
        openSpotlight(msg.payload);
        sendResponse({ open: true });
      }
    }
    return false;
  });

  function openSpotlight(payload) {
    host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    (document.documentElement || document.body).appendChild(host);

    let incognito = !!payload.incognito;
    try {
      incognito = incognito || !!chrome.extension.inIncognitoContext;
    } catch (e) {
      // chrome.extension may be unavailable; payload flag is authoritative.
    }

    window.__tsKeyguard.handler = routeKey;
    instance = TabSpotlight.create(shadow, { ...payload, incognito }, {
      onActivate(tabId) {
        send({ type: 'activate-tab', tabId });
        closeSpotlight();
      },
      onClose: closeSpotlight,
      fetchThumbs(tabIds) {
        return send({ type: 'get-thumbs', tabIds });
      },
    });
  }

  // --- Page meta → generated thumbnail -------------------------------------
  // Runs in every tab, visible or not. Chrome can only screenshot the visible
  // tab, so this is how hidden tabs get a thumbnail that looks like the site.
  function metaContent(selectors) {
    for (const sel of selectors) {
      const node = document.querySelector(sel);
      const v = node && (node.getAttribute('content') || node.getAttribute('href'));
      if (v && v.trim()) return v.trim();
    }
    return '';
  }

  function absoluteUrl(value) {
    try {
      const u = new URL(value, document.baseURI);
      return /^https?:$/.test(u.protocol) ? u.href : '';
    } catch (e) {
      return '';
    }
  }

  // Normalise any CSS colour (hex, rgb(), hsl(), keywords like "white") to
  // #rrggbb; '' for transparent / unparsable. A canvas fillStyle round-trip
  // always serialises to #rrggbb or rgba(), unlike inline style which keeps
  // keywords verbatim.
  let colorCtx = null;
  function toHex(color) {
    if (!color || typeof color !== 'string') return '';
    try {
      if (!colorCtx) colorCtx = document.createElement('canvas').getContext('2d');
      if (!colorCtx) return '';
      const SENTINEL = '#010203';
      colorCtx.fillStyle = SENTINEL;
      colorCtx.fillStyle = color.trim();
      const out = colorCtx.fillStyle;
      if (out === SENTINEL && color.trim().toLowerCase() !== SENTINEL) return '';
      if (/^#[0-9a-f]{6}$/i.test(out)) return out.toLowerCase();
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(out);
      if (!m) return '';
      if (m[4] !== undefined && Number(m[4]) < 0.5) return '';
      return (
        '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
      );
    } catch (e) {
      return '';
    }
  }

  // theme-color may be declared per colour scheme via a media attribute;
  // prefer the variant matching the current scheme, then an unconditional one.
  function themeColor() {
    const nodes = document.querySelectorAll('meta[name="theme-color"]');
    let fallback = '';
    for (const node of nodes) {
      const content = (node.getAttribute('content') || '').trim();
      if (!content) continue;
      const media = (node.getAttribute('media') || '').trim();
      if (!media) {
        if (!fallback) fallback = content;
        continue;
      }
      try {
        if (window.matchMedia(media).matches) return content;
      } catch (e) {
        // Unparsable media query — ignore this node.
      }
    }
    return fallback;
  }

  function computedBg(el) {
    if (!el) return '';
    try {
      const c = getComputedStyle(el).backgroundColor;
      return /rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(c) ? '' : toHex(c);
    } catch (e) {
      return '';
    }
  }

  function collectMeta() {
    const image = absoluteUrl(
      metaContent([
        'meta[property="og:image:secure_url"]',
        'meta[property="og:image"]',
        'meta[name="og:image"]',
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:src"]',
        'link[rel="image_src"]',
      ])
    );
    const color =
      toHex(metaContent(['meta[name="theme-color"]', 'meta[name="msapplication-TileColor"]'])) ||
      computedBg(document.body) ||
      computedBg(document.documentElement);
    return { image, color, url: location.href };
  }

  let lastMetaKey = '';
  function reportMeta() {
    if (!document.body) return;
    const meta = collectMeta();
    const key = meta.image + '|' + meta.color + '|' + meta.url;
    if (key === lastMetaKey) return;
    lastMetaKey = key;
    send({ type: 'page-meta', meta });
  }

  reportMeta();
  // Late-injected meta (SPAs, apps that set theme-color after boot).
  if (document.readyState !== 'complete') {
    window.addEventListener('load', () => setTimeout(reportMeta, 250), { once: true });
  } else {
    setTimeout(reportMeta, 250);
  }
  setTimeout(reportMeta, 2500);

  function closeSpotlight() {
    if (!host) return;
    if (window.__tsKeyguard) window.__tsKeyguard.handler = null;
    if (instance) instance.destroy();
    host.remove();
    instance = null;
    host = null;
    send({ type: 'spotlight-closed' });
  }

  // --- Keep keyboard input in the spotlight --------------------------------
  // The overlay lives in a closed shadow root, but page scripts (Docs,
  // Notion, games, app shells) register capture-phase key handlers that run
  // before the overlay's and swallow or redirect keys. keyguard.js registers a
  // window-level capture listener at document_start — before any page script,
  // so it runs first — and hands every key here while the spotlight is open:
  // navigation keys go to the spotlight, printable characters are typed into
  // its input, and nothing reaches the page.
  const NAV_KEYS = new Set(['Escape', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  function isPrintable(e) {
    return e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
  }
  function routeKey(e) {
    if (!host || !instance) return;
    const fromOverlay = e.composedPath().includes(host);
    if (NAV_KEYS.has(e.key)) {
      // handleKey decides about preventDefault (←/→ move the caret while
      // there is text); never let the page see it either way.
      e.stopImmediatePropagation();
      instance.handleKey(e);
      return;
    }
    if (e.key === ' ' && instance.isEmpty()) {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (!e.repeat) instance.goPrevious();
      return;
    }
    if (isPrintable(e)) {
      e.stopImmediatePropagation();
      if (!fromOverlay) {
        e.preventDefault();
        instance.typeText(e.key);
      }
      return;
    }
    if (e.key === 'Backspace') {
      e.stopImmediatePropagation();
      if (fromOverlay) return; // native edit on the focused input
      e.preventDefault();
      const input = instance.input;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const from = start === end ? Math.max(0, start - 1) : start;
      input.value = input.value.slice(0, from) + input.value.slice(end);
      input.setSelectionRange(from, from);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      instance.focus();
      return;
    }
    // Everything else (modifier combos, function keys): keep it away from
    // page shortcuts, but allow the default action (e.g. ⌘A in the input).
    e.stopImmediatePropagation();
  }
  // keyguard.js is present on pages loaded after install; older pages fall
  // back to a late-registered listener (works unless the page stops keys).
  if (!window.__tsKeyguard) {
    window.__tsKeyguard = { handler: null };
    window.addEventListener('keydown', (e) => window.__tsKeyguard.handler && window.__tsKeyguard.handler(e), true);
  }
  // Focus stolen by the page (focus traps, editors re-focusing on blur)?
  // Take it back.
  let refocusBurst = 0;
  let refocusWindow = 0;
  document.addEventListener(
    'focusin',
    (e) => {
      if (!host || !instance || e.composedPath().includes(host)) return;
      // Guard against a page that fights back on every blur.
      const now = Date.now();
      if (now - refocusWindow > 500) {
        refocusWindow = now;
        refocusBurst = 0;
      }
      if (++refocusBurst > 12) return;
      instance.focus();
    },
    true
  );

  // --- Keep the thumbnail fresh -------------------------------------------
  // Chrome only lets us screenshot the visible tab, so capture once scrolling
  // stops (and when the tab becomes visible again) rather than only on switch.
  let scrollTimer = null;
  window.addEventListener(
    'scroll',
    () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        if (document.visibilityState === 'visible' && !host) send({ type: 'capture-active' });
      }, 350);
    },
    { passive: true, capture: true }
  );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !host) send({ type: 'capture-active' });
  });
})();
