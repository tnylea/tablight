// Shared spotlight UI. Used by content.js (inside a closed shadow root on the
// page) and by spotlight.html (popup window fallback for protected pages).
// Exposes a single global: TabSpotlight.create(root, payload, callbacks).
//
// callbacks:
//   onActivate(tabId)          switch to a tab
//   onClose()                  dismiss
//   fetchThumbs?(tabIds)       Promise<{ thumbs: { [tabId]: { data, kind } },
//                                        meta: { [tabId]: { color } } }> for
//                              tabs whose thumbnails weren't in the payload
//   standalone?                true inside the popup-window fallback
//   theme?                     'light' | 'dark' (defaults to resolveTheme)

(function () {
  'use strict';

  const GRID_COLS = 3;
  const GRID_SIZE = 9;
  let sharedSheet = null;

  // All styles live here — the overlay renders inside a closed shadow root with
  // `all: initial`, so nothing from the host page applies. Theme tokens are set
  // on .ts-light / .ts-dark; everything below reads only from tokens.
  const CSS = `
    :host, .ts-scope { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    /* Raycast-style glass: translucent panel blurred over the page, an
       inner highlight ring, big radius, filled (not outlined) selection. */
    .ts-light {
      color-scheme: light;
      --ts-accent: #3b82f6;
      --ts-accent-text: #1d4ed8;
      --ts-backdrop: rgba(10, 14, 22, 0.14);
      --ts-standalone: linear-gradient(135deg, #cfe0f2 0%, #e6edf6 55%, #d6e3f1 100%);
      --ts-panel: rgba(243, 246, 251, 0.70);
      --ts-panel-shadow:
        0 0 0 1px rgba(16, 24, 40, 0.10),
        0 30px 80px -12px rgba(16, 24, 40, 0.45),
        0 8px 24px -8px rgba(16, 24, 40, 0.20),
        inset 0 0 0 1px rgba(255, 255, 255, 0.60);
      --ts-divider: rgba(16, 24, 40, 0.10);
      --ts-text: #0b1220;
      --ts-text-2: rgba(11, 18, 32, 0.64);
      --ts-text-3: rgba(11, 18, 32, 0.48);
      --ts-placeholder: rgba(11, 18, 32, 0.38);
      --ts-item-hover: rgba(16, 24, 40, 0.05);
      --ts-item-active-bg: rgba(16, 24, 40, 0.10);
      --ts-item-active-ring: rgba(255, 255, 255, 0.55);
      --ts-thumb-bg: rgba(255, 255, 255, 0.55);
      --ts-thumb-border: rgba(16, 24, 40, 0.14);
      --ts-ph-bg: linear-gradient(160deg, rgba(255, 255, 255, 0.75), rgba(230, 236, 245, 0.75));
      --ts-ph-chip: rgba(255, 255, 255, 0.9);
      --ts-ph-chip-border: rgba(16, 24, 40, 0.08);
      --ts-ph-chip-shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
      --ts-kbd-bg: rgba(16, 24, 40, 0.09);
      --ts-kbd-text: rgba(11, 18, 32, 0.72);
      --ts-mark: rgba(59, 130, 246, 0.16);
      --ts-pill-bg: rgba(255, 255, 255, 0.85);
    }
    .ts-dark {
      color-scheme: dark;
      --ts-accent: #3b82f6;
      --ts-accent-text: #93c5fd;
      --ts-backdrop: rgba(0, 0, 0, 0.26);
      --ts-standalone: linear-gradient(135deg, #0f1826 0%, #182436 55%, #10192a 100%);
      --ts-panel: rgba(17, 24, 35, 0.70);
      --ts-panel-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.55),
        0 30px 80px -12px rgba(0, 0, 0, 0.75),
        0 8px 24px -8px rgba(0, 0, 0, 0.40),
        inset 0 0 0 1px rgba(255, 255, 255, 0.11);
      --ts-divider: rgba(255, 255, 255, 0.09);
      --ts-text: #f3f5f8;
      --ts-text-2: rgba(243, 245, 248, 0.64);
      --ts-text-3: rgba(243, 245, 248, 0.48);
      --ts-placeholder: rgba(243, 245, 248, 0.38);
      --ts-item-hover: rgba(255, 255, 255, 0.06);
      --ts-item-active-bg: rgba(255, 255, 255, 0.11);
      --ts-item-active-ring: rgba(255, 255, 255, 0.14);
      --ts-thumb-bg: rgba(255, 255, 255, 0.06);
      --ts-thumb-border: rgba(255, 255, 255, 0.10);
      --ts-ph-bg: linear-gradient(160deg, rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0.04));
      --ts-ph-chip: rgba(255, 255, 255, 0.10);
      --ts-ph-chip-border: rgba(255, 255, 255, 0.10);
      --ts-ph-chip-shadow: none;
      --ts-kbd-bg: rgba(255, 255, 255, 0.13);
      --ts-kbd-text: rgba(243, 245, 248, 0.78);
      --ts-mark: rgba(96, 165, 250, 0.24);
      --ts-pill-bg: rgba(30, 38, 52, 0.9);
    }

    .ts-backdrop {
      position: fixed; inset: 0;
      background: var(--ts-backdrop);
      display: flex; align-items: flex-start; justify-content: center;
      padding-top: 10vh;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
      color: var(--ts-text);
      z-index: 2147483647;
    }
    .ts-backdrop.ts-standalone {
      background: var(--ts-standalone);
      padding-top: 18px;
    }
    .ts-panel {
      width: min(760px, calc(100vw - 40px));
      background: var(--ts-panel);
      -webkit-backdrop-filter: blur(44px) saturate(1.8);
      backdrop-filter: blur(44px) saturate(1.8);
      border-radius: 22px;
      box-shadow: var(--ts-panel-shadow);
      overflow: hidden;
      /* Speed: a short fade only; no transform, nothing to wait for. */
      animation: ts-in 70ms ease-out;
    }
    @keyframes ts-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes ts-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      .ts-panel, .ts-thumb > img { animation: none !important; }
      .ts-item { transition: none !important; }
    }

    .ts-search {
      display: flex; align-items: center; gap: 14px;
      padding: 18px 20px 16px 22px;
      border-bottom: 1px solid var(--ts-divider);
    }
    .ts-search svg { flex: none; width: 20px; height: 20px; color: var(--ts-text-3); }
    .ts-input {
      flex: 1; min-width: 0;
      background: transparent; border: none; outline: none;
      font-family: inherit;
      font-size: 22px; font-weight: 400; line-height: 28px;
      color: var(--ts-text);
      caret-color: var(--ts-accent);
      letter-spacing: -0.01em;
    }
    .ts-input::placeholder { color: var(--ts-placeholder); }
    .ts-kbd {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 22px; height: 22px; padding: 0 6px;
      font-family: inherit;
      font-size: 12px; font-weight: 500; line-height: 1;
      color: var(--ts-kbd-text);
      background: var(--ts-kbd-bg);
      border-radius: 6px;
      white-space: nowrap;
    }
    .ts-search .ts-kbd { flex: none; }

    .ts-section {
      padding: 12px 22px 2px;
      font-size: 12.5px; font-weight: 500;
      color: var(--ts-text-2);
    }
    .ts-grid {
      display: grid;
      grid-template-columns: repeat(${GRID_COLS}, minmax(0, 1fr));
      gap: 6px;
      padding: 6px 14px 12px;
    }
    .ts-empty {
      grid-column: 1 / -1;
      padding: 52px 14px; text-align: center;
      font-size: 14px; color: var(--ts-text-3);
    }
    .ts-item {
      min-width: 0;
      border-radius: 14px;
      padding: 7px 7px 9px;
      cursor: pointer;
      background: transparent;
      box-shadow: 0 0 0 1px transparent;
      transition: background-color 70ms ease, box-shadow 70ms ease;
    }
    .ts-item:hover { background: var(--ts-item-hover); }
    .ts-item.ts-active {
      background: var(--ts-item-active-bg);
      box-shadow: inset 0 0 0 1px var(--ts-item-active-ring);
    }
    .ts-item.ts-current .ts-thumb { opacity: 0.92; }
    .ts-pill {
      position: absolute; top: 7px; left: 7px;
      padding: 3px 7px;
      font-size: 10px; font-weight: 600; letter-spacing: 0.04em; line-height: 1.2;
      text-transform: uppercase;
      color: var(--ts-text-2);
      background: var(--ts-pill-bg);
      border-radius: 6px;
      box-shadow: 0 1px 3px rgba(16, 24, 40, 0.12);
      pointer-events: none;
    }
    .ts-thumb {
      width: 100%;
      aspect-ratio: 16 / 10;
      border-radius: 9px;
      overflow: hidden;
      background: var(--ts-thumb-bg);
      box-shadow: inset 0 0 0 1px var(--ts-thumb-border);
      position: relative;
    }
    .ts-thumb > img {
      width: 100%; height: 100%;
      object-fit: cover; object-position: top;
      display: block;
    }
    .ts-thumb > img.ts-late { animation: ts-fade-in 160ms ease-out; }
    /* Generated (og:image) thumbnails are artwork, not a page — centre them. */
    .ts-thumb > img.ts-og { object-position: center; }
    .ts-placeholder {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 8px;
      background: var(--ts-ph-bg);
      padding: 8px;
    }
    /* Branded placeholder: tinted with the site's own colour. */
    .ts-placeholder.ts-tinted {
      background:
        linear-gradient(160deg,
          color-mix(in srgb, var(--ts-site) 18%, transparent),
          color-mix(in srgb, var(--ts-site) 44%, transparent));
    }
    .ts-placeholder.ts-tinted .ts-ph-fav {
      background: color-mix(in srgb, var(--ts-site) 10%, var(--ts-ph-chip));
    }
    .ts-ph-fav {
      width: 36px; height: 36px;
      border-radius: 10px;
      background: var(--ts-ph-chip);
      border: 1px solid var(--ts-ph-chip-border);
      box-shadow: var(--ts-ph-chip-shadow);
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; font-weight: 600; color: var(--ts-text-2);
    }
    .ts-ph-fav img { width: 18px; height: 18px; object-fit: contain; }
    .ts-ph-host {
      max-width: 92%;
      font-size: 11px; color: var(--ts-text-3);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* Chrome's own pages: icon card in Chrome blue. */
    .ts-placeholder.ts-native {
      background:
        linear-gradient(160deg,
          color-mix(in srgb, #3b82f6 12%, transparent),
          color-mix(in srgb, #3b82f6 26%, transparent));
    }
    .ts-placeholder.ts-native .ts-ph-fav {
      color: #2563eb;
      background: color-mix(in srgb, #3b82f6 12%, var(--ts-ph-chip));
    }
    .ts-dark .ts-placeholder.ts-native .ts-ph-fav { color: #93c5fd; }
    .ts-placeholder.ts-native .ts-ph-host { color: var(--ts-text-2); font-weight: 500; }
    .ts-meta {
      display: flex; align-items: center; gap: 8px;
      min-width: 0;
      padding: 9px 3px 0;
    }
    .ts-fav {
      width: 16px; height: 16px; flex: none;
      border-radius: 4px;
    }
    .ts-text { flex: 1; min-width: 0; }
    .ts-title {
      font-size: 13px; font-weight: 500; line-height: 17px;
      color: var(--ts-text);
      letter-spacing: -0.005em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ts-title mark {
      background: var(--ts-mark);
      color: var(--ts-accent-text);
      border-radius: 3px;
      padding: 0 1px; margin: 0 -1px;
    }
    .ts-host {
      margin-top: 1px;
      font-size: 11.5px; line-height: 15px;
      color: var(--ts-text-3);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ts-hints {
      display: flex; align-items: center; gap: 14px;
      padding: 10px 16px 12px 22px;
      border-top: 1px solid var(--ts-divider);
      font-size: 12.5px; color: var(--ts-text-2);
    }
    .ts-hints span { display: inline-flex; align-items: center; gap: 6px; }
    .ts-hints .ts-count { margin-right: auto; color: var(--ts-text-3); font-variant-numeric: tabular-nums; }
    .ts-status {
      padding: 6px 22px 8px;
      border-top: 1px solid var(--ts-divider);
      font-size: 11.5px; line-height: 1.4;
      color: #b42318;
      word-break: break-word;
    }
    .ts-dark .ts-status { color: #fda29b; }
    .ts-status b { font-weight: 600; }
  `;

  // Subsequence fuzzy match. Returns { score, idx } for a match (higher score
  // is better; idx are the matched character positions in `text`) or null.
  function fuzzyMatch(query, text) {
    if (!query) return { score: 0, idx: [] };
    if (!text) return null;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    const idx = [];
    let score = 0;
    let ti = 0;
    let prev = -2;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      const at = t.indexOf(c, ti);
      if (at === -1) return null;
      score += 1;
      if (at === prev + 1) score += 3; // consecutive run
      if (at === 0 || /[\s\-_/.:]/.test(t[at - 1])) score += 2; // word start
      score -= (at - ti) * 0.02; // gap penalty
      idx.push(at);
      prev = at;
      ti = at + 1;
    }
    return { score, idx };
  }

  // Best of title / url. `titleIdx` is only set when the title match won, so
  // highlighting never points at characters that aren't on screen.
  function bestMatch(query, tab) {
    const byTitle = fuzzyMatch(query, tab.title);
    const byUrl = fuzzyMatch(query, tab.url);
    if (!byTitle && !byUrl) return null;
    const urlScore = byUrl ? byUrl.score * 0.9 : -Infinity;
    if (byTitle && byTitle.score >= urlScore) return { score: byTitle.score, titleIdx: byTitle.idx };
    return { score: urlScore, titleIdx: null };
  }

  function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function hostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return url;
    }
  }

  function isSafeFavicon(url) {
    return typeof url === 'string' && /^(https|data):/.test(url);
  }


  // Chrome's own pages (chrome://extensions, the new tab page, extension
  // pages) can't be screenshotted unprompted. Describe them so the
  // placeholder reads as a deliberate card rather than a missing image.
  const NATIVE_ICONS = {
    extensions:
      '<path d="M13 3a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v2h-1a2 2 0 1 0 0 4h1v2a2 2 0 0 1-2 2h-2v-1a2 2 0 1 0-4 0v1H9a2 2 0 0 1-2-2v-2H6a2 2 0 1 1 0-4h1V8a2 2 0 0 1 2-2h2V5a2 2 0 0 1 2-2z"/>',
    settings:
      '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.4 3.5a8.4 8.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2-1.2l-.4-2.6h-4l-.4 2.6a8 8 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a8.4 8.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2 1.2l.4 2.6h4l.4-2.6a8 8 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>',
    history: '<path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7v3l4-4-4-4v3zm-1 5v5l4 2.4.8-1.4-3.3-2V8H11z"/>',
    downloads: '<path d="M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4L11 12.2V3zM4 17h16v2H4z"/>',
    bookmarks: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/>',
    newtab: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z"/>',
    chrome:
      '<path d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0-4.66 3.2L4.1 5.6A10 10 0 0 1 12 2zm9.5 7a10 10 0 0 1-7.1 12.6l4.25-7.35A5 5 0 0 0 16.6 9h4.9zM2.4 8.4l4.4 7.6a5 5 0 0 0 4.9 3.9h.3L9.7 21.9A10 10 0 0 1 2.4 8.4zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/>',
  };

  function describeNative(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    if (u.protocol === 'chrome:') {
      const page = u.hostname.replace(/^www\./, '');
      const names = {
        extensions: 'Extensions',
        settings: 'Settings',
        history: 'History',
        downloads: 'Downloads',
        bookmarks: 'Bookmarks',
        newtab: 'New Tab',
        'new-tab-page': 'New Tab',
        version: 'Version',
        flags: 'Flags',
      };
      const icon = NATIVE_ICONS[page] || NATIVE_ICONS.chrome;
      const label = names[page] || page.charAt(0).toUpperCase() + page.slice(1);
      return { label: 'Chrome \u00b7 ' + label, icon, host: 'chrome://' + page };
    }
    if (u.protocol === 'chrome-extension:') {
      return { label: 'Extension page', icon: NATIVE_ICONS.extensions, host: 'extension' };
    }
    if (u.protocol === 'about:') {
      return { label: 'Chrome \u00b7 ' + (u.pathname || 'blank'), icon: NATIVE_ICONS.chrome, host: url };
    }
    return null;
  }

  function nativeIcon(pathMarkup) {
    return (
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      pathMarkup +
      '</svg>'
    );
  }

  function resolveTheme(payload) {
    if (payload && payload.incognito) return 'dark';
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  // Accepts both { id: dataUrl } and { id: { data, kind } } shapes.
  function normalizeThumbs(map) {
    const out = {};
    if (!map) return out;
    for (const id of Object.keys(map)) {
      const v = map[id];
      if (typeof v === 'string') out[id] = { data: v, kind: 'shot' };
      else if (v && typeof v.data === 'string') out[id] = { data: v.data, kind: v.kind || 'shot' };
    }
    return out;
  }

  // Renders `text` into `node` with <mark> around the given character indices.
  function renderHighlighted(node, text, idx) {
    node.textContent = '';
    if (!idx || idx.length === 0) {
      node.textContent = text;
      return;
    }
    let cursor = 0;
    let i = 0;
    while (i < idx.length) {
      const start = idx[i];
      let end = start + 1;
      while (i + 1 < idx.length && idx[i + 1] === end) {
        end++;
        i++;
      }
      if (start > cursor) node.appendChild(document.createTextNode(text.slice(cursor, start)));
      const mark = el('mark', '', node);
      mark.textContent = text.slice(start, end);
      cursor = end;
      i++;
    }
    if (cursor < text.length) node.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function create(root, payload, callbacks) {
    const { onActivate, onClose } = callbacks;
    const standalone = !!callbacks.standalone;
    const theme = callbacks.theme === 'light' || callbacks.theme === 'dark'
      ? callbacks.theme
      : resolveTheme(payload);
    // The current tab is included (it's the most recently used, so it sits
    // first) as a "you are here" anchor; selection starts on the previous tab.
    const currentId = payload.activeTabId;
    const allTabs = payload.tabs.slice();
    // thumbs: tabId -> { data, kind }, meta: tabId -> { color }
    const thumbs = normalizeThumbs(payload.thumbs);
    const meta = Object.assign({}, payload.meta || {});
    const requestedThumbs = new Set(Object.keys(thumbs).map(Number));

    let results = []; // [{ tab, titleIdx }]
    let selected = 0;
    let destroyed = false;

    // Speed: parse the stylesheet once per page and adopt it into each shadow
    // root; the popup fallback (document.body root) gets a <style> element.
    let style = null;
    if (root instanceof ShadowRoot && typeof CSSStyleSheet !== 'undefined') {
      if (!sharedSheet) {
        sharedSheet = new CSSStyleSheet();
        sharedSheet.replaceSync(CSS);
      }
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sharedSheet];
    } else {
      style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }

    const backdrop = el(
      'div',
      'ts-backdrop ts-scope ts-' + theme + (standalone ? ' ts-standalone' : ''),
      root
    );
    const panel = el('div', 'ts-panel', backdrop);

    const search = el('div', 'ts-search', panel);
    search.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>';
    const input = el('input', 'ts-input', search);
    input.type = 'text';
    input.placeholder = 'Search tabs…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const escHint = el('span', 'ts-kbd', search);
    escHint.textContent = 'esc';

    const section = el('div', 'ts-section', panel);
    section.textContent = 'Recent';
    const grid = el('div', 'ts-grid', panel);

    const hints = el('div', 'ts-hints', panel);
    hints.innerHTML =
      '<span class="ts-count"></span>' +
      '<span>Switch <span class="ts-kbd">↵</span></span>' +
      '<span>Previous <span class="ts-kbd">space</span></span>' +
      '<span>Navigate <span class="ts-kbd">↑↓</span></span>';
    const countEl = hints.querySelector('.ts-count');

    // Capture diagnostics from the background: if screenshots are failing,
    // say so right here instead of hiding it in a console.
    const st = payload.status;
    if (st && st.captureOk === false && st.lastError) {
      const statusEl = el('div', 'ts-status', panel);
      const b = el('b', '', statusEl);
      b.textContent = 'Screenshots are failing: ';
      statusEl.appendChild(document.createTextNode(st.lastError));
    }

    function computeResults() {
      const q = input.value.trim();
      if (!q) {
        results = allTabs.slice(0, GRID_SIZE).map((tab) => ({ tab, titleIdx: null }));
      } else {
        results = allTabs
          .map((tab) => ({ tab, m: bestMatch(q, tab) }))
          .filter((r) => r.m)
          .sort((a, b) => b.m.score - a.m.score)
          .slice(0, GRID_SIZE)
          .map((r) => ({ tab: r.tab, titleIdx: r.m.titleIdx }));
      }
      if (selected >= results.length) selected = Math.max(0, results.length - 1);
      // Never leave the highlight on the tab we're already on when there is
      // somewhere else to go — Enter should always do something.
      if (results[selected] && results[selected].tab.id === currentId) {
        const other = results.findIndex((r) => r.tab.id !== currentId);
        if (other !== -1) selected = other;
      }
      const n = allTabs.length;
      section.textContent = q ? 'Results' : 'Recent';
      countEl.textContent = q
        ? results.length + ' of ' + n
        : n + (n === 1 ? ' tab' : ' tabs');
    }

    function mountThumb(thumbWrap, thumb, late) {
      thumbWrap.textContent = '';
      const img = el('img', (late ? 'ts-late' : '') + (thumb.kind === 'og' ? ' ts-og' : ''), thumbWrap);
      img.decoding = 'sync';
      img.src = thumb.data;
      img.alt = '';
    }

    function mountPlaceholder(thumbWrap, tab, host) {
      thumbWrap.textContent = '';
      const ph = el('div', 'ts-placeholder', thumbWrap);
      const native = describeNative(tab.url);
      if (native) {
        ph.classList.add('ts-native');
        const favWrap = el('div', 'ts-ph-fav', ph);
        favWrap.innerHTML = nativeIcon(native.icon);
        const hostEl = el('div', 'ts-ph-host', ph);
        hostEl.textContent = native.label;
        return;
      }
      const m = meta[tab.id];
      if (m && /^#[0-9a-f]{6}$/i.test(m.color || '')) {
        ph.classList.add('ts-tinted');
        ph.style.setProperty('--ts-site', m.color);
      }
      const favWrap = el('div', 'ts-ph-fav', ph);
      if (isSafeFavicon(tab.favIconUrl)) {
        const fav = el('img', '', favWrap);
        fav.src = tab.favIconUrl;
        fav.alt = '';
      } else {
        favWrap.textContent = (host || '?').charAt(0).toUpperCase();
      }
      const hostEl = el('div', 'ts-ph-host', ph);
      hostEl.textContent = host;
    }

    function render() {
      grid.textContent = '';
      if (results.length === 0) {
        const empty = el('div', 'ts-empty', grid);
        empty.textContent = 'No matching tabs';
        return;
      }
      results.forEach(({ tab, titleIdx }, i) => {
        const isCurrent = tab.id === currentId;
        const item = el(
          'div',
          'ts-item' + (i === selected ? ' ts-active' : '') + (isCurrent ? ' ts-current' : ''),
          grid
        );
        item.dataset.tabId = String(tab.id);
        const thumbWrap = el('div', 'ts-thumb', item);
        const host = hostname(tab.url);
        const thumb = thumbs[tab.id];
        if (thumb) mountThumb(thumbWrap, thumb, false);
        else mountPlaceholder(thumbWrap, tab, host);
        if (isCurrent) {
          const pill = el('span', 'ts-pill', thumbWrap);
          pill.textContent = 'Current';
        }

        const meta = el('div', 'ts-meta', item);
        if (isSafeFavicon(tab.favIconUrl)) {
          const fav = el('img', 'ts-fav', meta);
          fav.src = tab.favIconUrl;
          fav.alt = '';
        }
        const text = el('div', 'ts-text', meta);
        const title = el('div', 'ts-title', text);
        renderHighlighted(title, tab.title, titleIdx);
        const hostLine = el('div', 'ts-host', text);
        const nativeInfo = describeNative(tab.url);
        hostLine.textContent = nativeInfo ? nativeInfo.host : host;

        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', () => choose(tab.id));
        item.addEventListener('mousemove', () => {
          if (selected !== i) {
            selected = i;
            updateSelection();
          }
        });
      });
      ensureThumbs();
    }

    // Ask the host for thumbnails of visible results we don't have yet, and
    // patch them into the grid when they arrive (only if still on screen).
    function ensureThumbs() {
      if (typeof callbacks.fetchThumbs !== 'function') return;
      const missing = results
        .map((r) => r.tab.id)
        .filter((id) => !thumbs[id] && !requestedThumbs.has(id));
      if (missing.length === 0) return;
      missing.forEach((id) => requestedThumbs.add(id));
      Promise.resolve(callbacks.fetchThumbs(missing))
        .then((res) => {
          if (destroyed || !res) return;
          // Accept the { thumbs, meta } envelope or a bare thumbs map.
          const got = normalizeThumbs(res.thumbs && typeof res.thumbs === 'object' ? res.thumbs : res);
          if (res.meta && typeof res.meta === 'object') Object.assign(meta, res.meta);
          for (const id of missing) {
            const thumb = got[id];
            if (!thumb) continue;
            thumbs[id] = thumb;
            const item = grid.querySelector('.ts-item[data-tab-id="' + id + '"]');
            if (item) mountThumb(item.querySelector('.ts-thumb'), thumb, true);
          }
        })
        .catch(() => {});
    }

    // Selecting the tab we're already on is a no-op: just dismiss.
    function choose(tabId) {
      if (tabId === currentId) onClose();
      else onActivate(tabId);
    }

    // Alt-tab: the most recently used tab other than the current one.
    function goPrevious() {
      const prev = allTabs.find((t) => t.id !== currentId);
      if (prev) onActivate(prev.id);
      else onClose();
    }

    function isEmpty() {
      return input.value.length === 0;
    }

    function updateSelection() {
      const items = grid.querySelectorAll('.ts-item');
      items.forEach((node, i) => node.classList.toggle('ts-active', i === selected));
    }

    function move(delta) {
      if (results.length === 0) return;
      const next = selected + delta;
      if (next >= 0 && next < results.length) {
        selected = next;
        updateSelection();
      }
    }

    function moveWrapped(delta) {
      if (results.length === 0) return;
      selected = (selected + delta + results.length) % results.length;
      updateSelection();
    }

    function onKeyDown(e) {
      const key = e.key;
      if (key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (results[selected]) choose(results[selected].tab.id);
        return;
      }
      if (key === ' ' && isEmpty()) {
        // A leading space never contributes to a search (the query is
        // trimmed), so Space on an empty box is the alt-tab key.
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) goPrevious();
        return;
      }
      if (key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        moveWrapped(e.shiftKey ? -1 : 1);
        return;
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        move(key === 'ArrowUp' ? -GRID_COLS : GRID_COLS);
        return;
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        // While typing, let left/right move the text caret.
        if (input.value.length > 0) return;
        e.preventDefault();
        e.stopPropagation();
        move(key === 'ArrowLeft' ? -1 : 1);
      }
    }

    input.addEventListener('input', () => {
      selected = 0;
      computeResults();
      render();
    });
    backdrop.addEventListener('keydown', onKeyDown);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) onClose();
    });
    // Keep focus pinned to the input so keyboard navigation always works.
    panel.addEventListener('mousedown', (e) => {
      if (e.target !== input) e.preventDefault();
    });

    // Follow a live theme change while open (unless incognito forced dark).
    let mq = null;
    const onScheme = (ev) => {
      if (payload && payload.incognito) return;
      backdrop.classList.toggle('ts-dark', ev.matches);
      backdrop.classList.toggle('ts-light', !ev.matches);
    };
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', onScheme);
    } catch (e) {
      mq = null;
    }

    // Focus handling. Pages (editors, docs apps, focus traps) routinely pull
    // focus back to themselves; keep the search box focused for as long as the
    // spotlight is open so typing always lands in it.
    function focusInput() {
      if (destroyed) return;
      try {
        input.focus({ preventScroll: true });
      } catch (e) {
        input.focus();
      }
    }
    const focusTimers = [0, 30, 120, 300, 700].map((ms) => setTimeout(focusInput, ms));
    input.addEventListener('blur', () => {
      if (destroyed) return;
      setTimeout(() => {
        if (!destroyed && root.activeElement !== input) focusInput();
      }, 0);
    });

    computeResults();
    render();
    focusInput();

    return {
      theme,
      input,
      isEmpty,
      goPrevious,
      focus: focusInput,
      // Feed a keystroke that the page intercepted before it reached us.
      typeText(text) {
        if (destroyed || !text) return;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + text + input.value.slice(end);
        input.setSelectionRange(start + text.length, start + text.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        focusInput();
      },
      handleKey(e) {
        onKeyDown(e);
      },
      destroy() {
        destroyed = true;
        focusTimers.forEach(clearTimeout);
        if (mq) mq.removeEventListener('change', onScheme);
        backdrop.remove();
        if (style) style.remove();
      },
    };
  }

  const api = { create, fuzzyMatch, bestMatch, resolveTheme };
  if (typeof globalThis !== 'undefined') globalThis.TabSpotlight = api;
})();
