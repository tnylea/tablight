// Side panel: vertical tab list with live screenshot thumbnails.

(function () {
  'use strict';

  const listEl = document.getElementById('tab-list');
  const countEl = document.getElementById('tab-count');
  const previewEl = document.getElementById('hover-preview');
  const previewImg = document.getElementById('hover-preview-img');
  const previewTitle = document.getElementById('hover-preview-title');

  let windowId = null;
  let thumbs = {};
  let refreshTimer = null;

  function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function hostname(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return url || '';
    }
  }

  function isSafeFavicon(url) {
    return typeof url === 'string' && /^(https|data):/.test(url);
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 120);
  }

  async function refresh() {
    refreshTimer = null;
    if (windowId === null) return;

    let tabs;
    try {
      tabs = await chrome.tabs.query({ windowId });
    } catch (e) {
      return;
    }
    thumbs = await chrome.runtime
      .sendMessage({ type: 'get-thumbs', tabIds: tabs.map((t) => t.id) })
      .catch(() => ({}));

    countEl.textContent = String(tabs.length);
    listEl.textContent = '';
    hidePreview();

    for (const tab of tabs) {
      listEl.appendChild(buildCard(tab));
    }

    const activeCard = listEl.querySelector('.tab-card.active');
    if (activeCard) activeCard.scrollIntoView({ block: 'nearest' });
  }

  function buildCard(tab) {
    const card = el('div', 'tab-card' + (tab.active ? ' active' : ''));
    card.title = tab.title || tab.url || '';

    const thumbWrap = el('div', 'tab-thumb', card);
    const data = thumbs && thumbs[tab.id];
    if (data) {
      const img = el('img', '', thumbWrap);
      img.src = data;
      img.alt = '';
    } else {
      const ph = el('div', 'placeholder', thumbWrap);
      if (isSafeFavicon(tab.favIconUrl)) {
        const fav = el('img', '', ph);
        fav.src = tab.favIconUrl;
        fav.alt = '';
      }
      const host = el('span', '', ph);
      host.textContent = hostname(tab.url) || 'No preview yet';
    }

    const meta = el('div', 'tab-meta', card);
    if (isSafeFavicon(tab.favIconUrl)) {
      const fav = el('img', 'favicon', meta);
      fav.src = tab.favIconUrl;
      fav.alt = '';
    }
    const title = el('div', 'tab-title', meta);
    title.textContent = tab.title || tab.url || 'Untitled';

    const closeBtn = el('button', 'tab-close', meta);
    closeBtn.textContent = '×';
    closeBtn.title = 'Close tab';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'close-tab', tabId: tab.id }).catch(() => {});
    });

    card.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'activate-tab', tabId: tab.id }).catch(() => {});
    });

    if (data) {
      card.addEventListener('mouseenter', () => showPreview(card, tab, data));
      card.addEventListener('mouseleave', hidePreview);
    }

    return card;
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

  // --- Event wiring -------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'thumb-updated') scheduleRefresh();
  });

  const tabEvents = [
    chrome.tabs.onActivated,
    chrome.tabs.onUpdated,
    chrome.tabs.onCreated,
    chrome.tabs.onRemoved,
    chrome.tabs.onMoved,
    chrome.tabs.onAttached,
    chrome.tabs.onDetached,
  ];
  for (const event of tabEvents) {
    event.addListener(scheduleRefresh);
  }

  chrome.windows.getCurrent().then((win) => {
    windowId = win.id;
    refresh();
    // Make sure the currently visible tab gets a fresh thumbnail.
    chrome.runtime.sendMessage({ type: 'capture-active' }).catch(() => {});
  });
})();
