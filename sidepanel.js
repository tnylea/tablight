// Side panel: vertical tab list with live screenshot thumbnails.
//
// The list is reconciled in place — cards are created once per tab and then
// updated/reordered, and a new thumbnail patches a single card the moment the
// background broadcasts it. Nothing is re-fetched or rebuilt wholesale.

(function () {
  'use strict';

  // Incognito windows always use the dark theme (set before first paint).
  try {
    if (chrome.extension.inIncognitoContext) document.documentElement.dataset.theme = 'dark';
  } catch (e) {
    // chrome.extension unavailable — fall back to prefers-color-scheme.
  }

  const listEl = document.getElementById('tab-list');
  const countEl = document.getElementById('tab-count');
  const previewEl = document.getElementById('hover-preview');
  const previewImg = document.getElementById('hover-preview-img');
  const previewTitle = document.getElementById('hover-preview-title');
  const noticeEl = document.getElementById('notice');
  const fillBtn = document.getElementById('fill-btn');

  let windowId = null;
  // tabId -> { data, kind }, or null once we've asked and there is none yet.
  const thumbs = new Map();
  // tabId -> { color } (site colour for branded placeholders).
  const meta = new Map();
  // tabId -> { card, thumbWrap, favEl, titleEl, tab, data }
  const cards = new Map();
  let refreshTimer = null;
  let refreshSeq = 0;
  let lastActiveId = null;

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
      return url || '';
    }
  }

  function isSafeFavicon(url) {
    return typeof url === 'string' && /^(https|data):/.test(url);
  }

  function urlKey(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.href.slice(0, 2000);
    } catch (e) {
      return '';
    }
  }

  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch (e) {
      return '';
    }
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

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => undefined);
    } catch (e) {
      return Promise.resolve(undefined);
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(refresh, 30);
  }

  async function refresh() {
    refreshTimer = null;
    if (windowId === null) return;
    // Refreshes can overlap across awaits; only the newest may touch the DOM,
    // otherwise an older snapshot could resurrect a card for a closed tab.
    const token = ++refreshSeq;

    let tabs;
    try {
      tabs = await chrome.tabs.query({ windowId });
    } catch (e) {
      return;
    }
    if (token !== refreshSeq) return;

    // Only ask the background for thumbnails we've never seen.
    const missing = tabs.filter((t) => !thumbs.has(t.id)).map((t) => t.id);
    if (missing.length) {
      const res = (await send({ type: 'get-thumbs', tabIds: missing })) || {};
      if (token !== refreshSeq) return;
      const got = res.thumbs || {};
      const gotMeta = res.meta || {};
      // A broadcast may have landed while we waited; never downgrade it.
      for (const id of missing) {
        if (!thumbs.get(id)) thumbs.set(id, got[id] && got[id].data ? got[id] : null);
        if (gotMeta[id] && !meta.has(id)) meta.set(id, gotMeta[id]);
      }
    }

    countEl.textContent = String(tabs.length);

    const seen = new Set();
    let prev = null;
    for (const tab of tabs) {
      let entry = cards.get(tab.id);
      if (!entry) {
        entry = createCard(tab);
        cards.set(tab.id, entry);
      }
      updateCard(entry, tab);
      seen.add(tab.id);
      const expected = prev ? prev.nextSibling : listEl.firstChild;
      if (expected !== entry.card) listEl.insertBefore(entry.card, expected);
      prev = entry.card;
    }
    for (const [id, entry] of cards) {
      if (seen.has(id)) continue;
      entry.card.remove();
      cards.delete(id);
      thumbs.delete(id);
      meta.delete(id);
    }

    const active = tabs.find((t) => t.active);
    if (active && active.id !== lastActiveId) {
      lastActiveId = active.id;
      const entry = cards.get(active.id);
      if (entry) entry.card.scrollIntoView({ block: 'nearest' });
    }
  }

  function createCard(tab) {
    const card = el('div', 'tab-card');
    const thumbWrap = el('div', 'tab-thumb', card);
    const meta = el('div', 'tab-meta', card);
    const favEl = el('img', 'favicon', meta);
    favEl.alt = '';
    favEl.hidden = true;
    const titleEl = el('div', 'tab-title', meta);
    const closeBtn = el('button', 'tab-close', meta);
    closeBtn.type = 'button';
    closeBtn.title = 'Close tab';
    closeBtn.setAttribute('aria-label', 'Close tab');
    closeBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>';

    const entry = { card, thumbWrap, favEl, titleEl, tab, data: undefined, phKey: null };

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.add('closing');
      send({ type: 'close-tab', tabId: entry.tab.id });
    });
    card.addEventListener('click', () => send({ type: 'activate-tab', tabId: entry.tab.id }));
    card.addEventListener('mouseenter', () => {
      if (entry.data) showPreview(card, entry.tab, entry.data);
    });
    card.addEventListener('mouseleave', hidePreview);

    return entry;
  }

  function updateCard(entry, tab) {
    entry.tab = tab;
    entry.card.classList.toggle('active', !!tab.active);
    entry.card.title = tab.title || tab.url || '';

    const title = tab.title || tab.url || 'Untitled';
    if (entry.titleEl.textContent !== title) entry.titleEl.textContent = title;

    if (isSafeFavicon(tab.favIconUrl)) {
      if (entry.favEl.getAttribute('src') !== tab.favIconUrl) entry.favEl.src = tab.favIconUrl;
      entry.favEl.hidden = false;
    } else {
      entry.favEl.hidden = true;
    }

    setThumb(entry, thumbs.get(tab.id) || null, false);
  }

  function siteColor(tabId) {
    const m = meta.get(tabId);
    return m && /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : '';
  }

  // `thumb` is { data, kind } or null.
  function setThumb(entry, thumb, animate) {
    if (thumb) {
      if (entry.data === thumb.data) return;
      entry.data = thumb.data;
      entry.phKey = null;
      entry.thumbWrap.textContent = '';
      const img = el('img', (animate ? 'fresh' : '') + (thumb.kind === 'og' ? ' og' : ''), entry.thumbWrap);
      img.decoding = 'sync';
      img.alt = '';
      img.src = thumb.data;
    } else {
      // Placeholder content depends on url, favicon and site colour, which
      // change as a new tab navigates — re-render whenever those differ.
      const host = hostname(entry.tab.url);
      const fav = isSafeFavicon(entry.tab.favIconUrl) ? entry.tab.favIconUrl : '';
      const color = siteColor(entry.tab.id);
      const key = host + '\n' + fav + '\n' + color;
      if (entry.data === null && entry.phKey === key) return;
      entry.data = null;
      entry.phKey = key;
      entry.thumbWrap.textContent = '';
      const ph = el('div', 'placeholder', entry.thumbWrap);
      const native = describeNative(entry.tab.url);
      if (native) {
        ph.classList.add('native');
        const chip = el('div', 'placeholder-chip', ph);
        chip.innerHTML = nativeIcon(native.icon);
        const label = el('span', '', ph);
        label.textContent = native.label;
        return;
      }
      if (color) {
        ph.classList.add('tinted');
        ph.style.setProperty('--site', color);
      }
      const chip = el('div', 'placeholder-chip', ph);
      if (isSafeFavicon(entry.tab.favIconUrl)) {
        const fav = el('img', '', chip);
        fav.src = entry.tab.favIconUrl;
        fav.alt = '';
      } else {
        chip.textContent = (host || '?').charAt(0).toUpperCase();
      }
      const label = el('span', '', ph);
      label.textContent = host || 'No preview yet';
    }
  }

  function showPreview(card, tab, data) {
    previewImg.src = data;
    previewTitle.textContent = tab.title || tab.url || '';
    previewEl.hidden = false;

    const rect = card.getBoundingClientRect();
    // Position beside the card vertically, clamped to the viewport.
    const previewHeight = previewEl.offsetHeight || 260;
    let top = rect.top;
    if (top + previewHeight > window.innerHeight - 10) {
      top = window.innerHeight - previewHeight - 10;
    }
    if (top < 10) top = 10;
    previewEl.style.top = top + 'px';
  }

  function hidePreview() {
    previewEl.hidden = true;
  }

  // --- Status / diagnostics ------------------------------------------------
  // The background reports whether screenshots are working and whether an
  // idle warm-up is running, so a broken setup is visible here rather than
  // only in the service-worker console.
  let fillPending = false;

  function renderStatus(st) {
    if (!st) return;
    fillBtn.disabled = !!st.warming || fillPending;
    fillBtn.textContent = st.warming || fillPending ? 'Capturing…' : 'Capture all';
    let html = '';
    let error = false;
    if (st.captureOk === false && st.lastError) {
      error = true;
      html =
        '<b>Screenshots are failing.</b> ' +
        escapeHtml(st.lastError) +
        ' Try reloading the extension from chrome://extensions.';
    } else if (st.warming) {
      html = 'Capturing tabs that have no screenshot yet — this switches through them briefly.';
    }
    noticeEl.classList.toggle('error', error);
    noticeEl.innerHTML = html;
    noticeEl.hidden = !html;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  fillBtn.addEventListener('click', async () => {
    if (fillPending) return;
    fillPending = true;
    fillBtn.disabled = true;
    fillBtn.textContent = 'Capturing…';
    try {
      await send({ type: 'fill-missing', warm: true });
    } finally {
      fillPending = false;
      renderStatus((await send({ type: 'get-status' })) || {});
    }
  });

  // --- Event wiring -------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'status-updated') {
      renderStatus(msg.status);
      return;
    }
    if (msg.type === 'thumb-updated' && typeof msg.data === 'string') {
      // Thumbnails are keyed by URL: patch every card showing that page, and
      // every card on the same site that has nothing better yet.
      const thumb = { data: msg.data, kind: msg.kind || 'shot' };
      for (const [id, entry] of cards) {
        const url = entry.tab.url || '';
        const samePage = msg.urlKey ? urlKey(url) === msg.urlKey : id === msg.tabId;
        const sameSite = !samePage && msg.origin && originOf(url) === msg.origin && !entry.data;
        if (!samePage && !sameSite) continue;
        thumbs.set(id, thumb);
        setThumb(entry, thumb, true);
        if (!previewEl.hidden && entry.card.matches(':hover')) previewImg.src = msg.data;
      }
    } else if (msg.type === 'meta-updated' && msg.meta) {
      for (const [id, entry] of cards) {
        if (msg.origin ? originOf(entry.tab.url || '') !== msg.origin : id !== msg.tabId) continue;
        meta.set(id, msg.meta);
        if (entry.data === null) setThumb(entry, null, false);
      }
    }
  });

  chrome.tabs.onActivated.addListener(scheduleRefresh);
  chrome.tabs.onCreated.addListener(scheduleRefresh);
  chrome.tabs.onRemoved.addListener(scheduleRefresh);
  chrome.tabs.onMoved.addListener(scheduleRefresh);
  chrome.tabs.onAttached.addListener(scheduleRefresh);
  chrome.tabs.onDetached.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // A navigation means the cached thumbnail belongs to the previous page.
    if ('url' in changeInfo) {
      thumbs.delete(tabId);
      meta.delete(tabId);
    }
    if (
      'title' in changeInfo ||
      'favIconUrl' in changeInfo ||
      'url' in changeInfo ||
      'discarded' in changeInfo ||
      changeInfo.status === 'complete'
    ) {
      scheduleRefresh();
    }
  });
  document.addEventListener('scroll', hidePreview, { passive: true, capture: true });

  chrome.windows.getCurrent().then((win) => {
    windowId = win.id;
    if (win.incognito) document.documentElement.dataset.theme = 'dark';
    refresh();
    // Make sure the currently visible tab gets a fresh thumbnail.
    send({ type: 'capture-active' });
    send({ type: 'get-status' }).then(renderStatus);
  });
})();
