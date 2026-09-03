// Shared spotlight UI. Used by content.js (inside a closed shadow root on the
// page) and by spotlight.html (popup window fallback for protected pages).
// Exposes a single global: TabSpotlight.create(root, payload, callbacks).

(function () {
  'use strict';

  const GRID_COLS = 3;
  const GRID_SIZE = 9;

  const CSS = `
    :host, .ts-scope { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .ts-backdrop {
      position: fixed; inset: 0;
      background: rgba(8, 9, 13, 0.5);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      display: flex; align-items: flex-start; justify-content: center;
      padding-top: 9vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      z-index: 2147483647;
    }
    .ts-backdrop.ts-standalone {
      background: #141419;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      padding-top: 18px;
    }
    .ts-panel {
      width: min(700px, calc(100vw - 40px));
      background: linear-gradient(180deg, #1f2028, #18191f);
      border: 1px solid rgba(255, 255, 255, 0.11);
      border-radius: 16px;
      box-shadow: 0 32px 90px rgba(0, 0, 0, 0.55), 0 4px 16px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      color: #e9e9ee;
    }
    .ts-search {
      display: flex; align-items: center; gap: 11px;
      padding: 15px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .ts-search svg { flex: none; opacity: 0.5; }
    .ts-input {
      flex: 1; min-width: 0;
      background: transparent; border: none; outline: none;
      font-family: inherit;
      font-size: 16px; font-weight: 400; color: #f4f4f7;
      caret-color: #3b82f6;
    }
    .ts-input::placeholder { color: rgba(233, 233, 238, 0.35); }
    .ts-grid {
      display: grid;
      grid-template-columns: repeat(${GRID_COLS}, minmax(0, 1fr));
      gap: 10px;
      padding: 12px;
    }
    .ts-empty {
      grid-column: 1 / -1;
      padding: 44px 14px; text-align: center;
      font-size: 13.5px; color: rgba(233, 233, 238, 0.45);
    }
    .ts-item {
      min-width: 0;
      border: 1.5px solid rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      padding: 5px 5px 7px;
      cursor: pointer;
      background: rgba(255, 255, 255, 0.03);
      transition: border-color 0.09s ease, background 0.09s ease, box-shadow 0.09s ease;
    }
    .ts-item:hover { background: rgba(255, 255, 255, 0.06); }
    .ts-item.ts-active {
      border-color: #3b82f6;
      background: rgba(59, 130, 246, 0.13);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.22);
    }
    .ts-thumb {
      width: 100%;
      aspect-ratio: 16 / 10;
      border-radius: 8px;
      overflow: hidden;
      background: #23242b;
      border: 1px solid rgba(255, 255, 255, 0.055);
      position: relative;
    }
    .ts-thumb > img {
      width: 100%; height: 100%;
      object-fit: cover; object-position: top;
      display: block;
    }
    .ts-placeholder {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 8px;
      background:
        radial-gradient(90% 70% at 50% 0%, rgba(255, 255, 255, 0.05), transparent 65%),
        linear-gradient(150deg, #262731, #1d1e25);
      padding: 8px;
    }
    .ts-ph-fav {
      width: 34px; height: 34px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.07);
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; font-weight: 600; color: rgba(233, 233, 238, 0.55);
    }
    .ts-ph-fav img { width: 19px; height: 19px; object-fit: contain; }
    .ts-ph-host {
      max-width: 92%;
      font-size: 10.5px; color: rgba(233, 233, 238, 0.42);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ts-meta {
      display: flex; align-items: center; gap: 8px;
      min-width: 0;
      padding: 8px 4px 1px;
    }
    .ts-fav {
      width: 15px; height: 15px; flex: none;
      border-radius: 3px;
    }
    .ts-text { flex: 1; min-width: 0; }
    .ts-title {
      font-size: 12px; font-weight: 500; color: #e7e7ec;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ts-host {
      margin-top: 2px;
      font-size: 10.5px; color: rgba(233, 233, 238, 0.42);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ts-hints {
      display: flex; justify-content: center; gap: 18px;
      padding: 10px 14px 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      font-size: 11px; color: rgba(233, 233, 238, 0.4);
    }
    .ts-hints b {
      font-weight: 600; color: rgba(233, 233, 238, 0.68);
      background: rgba(255, 255, 255, 0.09);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 4px; padding: 1px 5px;
    }
  `;

  // Subsequence fuzzy match. Returns a score, or -1 for no match.
  function fuzzyScore(query, text) {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let score = 0;
    let ti = 0;
    let prev = -2;
    for (let qi = 0; qi < q.length; qi++) {
      const idx = t.indexOf(q[qi], ti);
      if (idx === -1) return -1;
      score += 1;
      if (idx === prev + 1) score += 3; // consecutive run
      if (idx === 0 || /[\s\-_/.:]/.test(t[idx - 1])) score += 2; // word start
      score -= (idx - ti) * 0.02; // gap penalty
      prev = idx;
      ti = idx + 1;
    }
    return score;
  }

  function bestScore(query, tab) {
    const byTitle = fuzzyScore(query, tab.title);
    const byUrl = fuzzyScore(query, tab.url);
    if (byTitle === -1 && byUrl === -1) return -1;
    return Math.max(byTitle, byUrl === -1 ? -1 : byUrl * 0.9);
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

  function create(root, payload, callbacks) {
    const { onActivate, onClose } = callbacks;
    const standalone = !!callbacks.standalone;
    const allTabs = payload.tabs.filter((t) => t.id !== payload.activeTabId);
    const thumbs = payload.thumbs || {};

    let results = [];
    let selected = 0;

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const backdrop = el('div', 'ts-backdrop ts-scope' + (standalone ? ' ts-standalone' : ''), root);
    const panel = el('div', 'ts-panel', backdrop);

    const search = el('div', 'ts-search', panel);
    search.innerHTML =
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#e9e9ee" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>';
    const input = el('input', 'ts-input', search);
    input.type = 'text';
    input.placeholder = 'Search tabs…';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const grid = el('div', 'ts-grid', panel);

    const hints = el('div', 'ts-hints', panel);
    hints.innerHTML =
      '<span><b>↑↓←→</b> / <b>tab</b> navigate</span><span><b>⏎</b> switch</span><span><b>esc</b> close</span>';

    function computeResults() {
      const q = input.value.trim();
      if (!q) {
        results = allTabs.slice(0, GRID_SIZE);
      } else {
        results = allTabs
          .map((t) => ({ t, s: bestScore(q, t) }))
          .filter((r) => r.s >= 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, GRID_SIZE)
          .map((r) => r.t);
      }
      if (selected >= results.length) selected = Math.max(0, results.length - 1);
    }

    function render() {
      grid.textContent = '';
      if (results.length === 0) {
        const empty = el('div', 'ts-empty', grid);
        empty.textContent = 'No matching tabs';
        return;
      }
      results.forEach((tab, i) => {
        const item = el('div', 'ts-item' + (i === selected ? ' ts-active' : ''), grid);
        const thumbWrap = el('div', 'ts-thumb', item);
        const host = hostname(tab.url);
        const data = thumbs[tab.id];
        if (data) {
          const img = el('img', '', thumbWrap);
          img.src = data;
          img.alt = '';
        } else {
          const ph = el('div', 'ts-placeholder', thumbWrap);
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

        const meta = el('div', 'ts-meta', item);
        if (isSafeFavicon(tab.favIconUrl)) {
          const fav = el('img', 'ts-fav', meta);
          fav.src = tab.favIconUrl;
          fav.alt = '';
        }
        const text = el('div', 'ts-text', meta);
        const title = el('div', 'ts-title', text);
        title.textContent = tab.title;
        const hostLine = el('div', 'ts-host', text);
        hostLine.textContent = host;

        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', () => onActivate(tab.id));
        item.addEventListener('mousemove', () => {
          if (selected !== i) {
            selected = i;
            updateSelection();
          }
        });
      });
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
        if (results[selected]) onActivate(results[selected].id);
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

    computeResults();
    render();
    input.focus();

    return {
      destroy() {
        backdrop.remove();
        style.remove();
      },
    };
  }

  const api = { create };
  if (typeof globalThis !== 'undefined') globalThis.TabSpotlight = api;
})();
