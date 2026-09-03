// Tab Thumbnails & Spotlight — service worker.
// Captures screenshots of the active tab, stores downscaled JPEG thumbnails
// in chrome.storage.session, and coordinates the side panel + spotlight UI.

const THUMB_WIDTH = 480;
const JPEG_QUALITY = 0.72;
const MAX_THUMBS = 60;
const CAPTURE_DELAY_MS = 150;
// captureVisibleTab is rate-limited by Chrome (~2 calls/sec).
const MIN_CAPTURE_INTERVAL_MS = 450;

let lastCaptureAt = 0;
const pendingCaptures = new Map(); // windowId -> timeout id
// Active tab id of the last focused normal window, stashed when the spotlight
// popup fallback opens (the popup itself steals focus).
let stashedActiveTabId = null;

async function captureFocusedWindow() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (win && typeof win.id === 'number') scheduleCapture(win.id, 200);
  } catch (e) {
    // No normal window open.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  captureFocusedWindow();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  captureFocusedWindow();
});

// ---------------------------------------------------------------------------
// Thumbnail capture
// ---------------------------------------------------------------------------

function isCapturable(url) {
  return typeof url === 'string' && /^(https?|file):/.test(url);
}

function scheduleCapture(windowId, delay = CAPTURE_DELAY_MS) {
  if (typeof windowId !== 'number' || windowId === chrome.windows.WINDOW_ID_NONE) return;
  const existing = pendingCaptures.get(windowId);
  if (existing) clearTimeout(existing);
  const id = setTimeout(() => {
    pendingCaptures.delete(windowId);
    captureActiveTab(windowId);
  }, delay);
  pendingCaptures.set(windowId, id);
}

async function captureActiveTab(windowId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab || !isCapturable(tab.url)) return;

    const now = Date.now();
    if (now - lastCaptureAt < MIN_CAPTURE_INTERVAL_MS) {
      scheduleCapture(windowId, MIN_CAPTURE_INTERVAL_MS);
      return;
    }
    lastCaptureAt = now;

    const raw = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: 80,
    });
    const thumb = await resizeDataUrl(raw);
    await saveThumb(tab.id, thumb, tab.url);
  } catch (e) {
    // Tab closed, window gone, rate limit hit, or a protected page.
    console.warn('[tab-thumbs] capture failed:', e && e.message ? e.message : e);
  }
}

// fetch() on data: URLs is unreliable in MV3 service workers — decode manually.
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

async function resizeDataUrl(dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB_WIDTH / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  return blobToDataUrl(out);
}

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return 'data:image/jpeg;base64,' + btoa(binary);
}

async function saveThumb(tabId, dataUrl, url) {
  await chrome.storage.session.set({
    ['thumb_' + tabId]: { data: dataUrl, ts: Date.now(), url },
  });
  await evictOldThumbs();
  chrome.runtime.sendMessage({ type: 'thumb-updated', tabId }).catch(() => {});
}

async function evictOldThumbs() {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('thumb_'));
  if (keys.length <= MAX_THUMBS) return;
  keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
  await chrome.storage.session.remove(keys.slice(0, keys.length - MAX_THUMBS));
}

async function getThumbs(tabIds) {
  const keys = tabIds.map((id) => 'thumb_' + id);
  const stored = await chrome.storage.session.get(keys);
  const thumbs = {};
  for (const id of tabIds) {
    const entry = stored['thumb_' + id];
    if (entry) thumbs[id] = entry.data;
  }
  return thumbs;
}

chrome.tabs.onActivated.addListener((info) => scheduleCapture(info.windowId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    scheduleCapture(tab.windowId, 300);
  }
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) scheduleCapture(windowId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('thumb_' + tabId).catch(() => {});
});

// ---------------------------------------------------------------------------
// Spotlight
// ---------------------------------------------------------------------------

async function buildSpotlightPayload(activeTabId) {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const list = tabs.map((t) => ({
    id: t.id,
    windowId: t.windowId,
    title: t.title || t.url || 'Untitled',
    url: t.url || '',
    favIconUrl: t.favIconUrl || '',
  }));
  const thumbs = await getThumbs(list.map((t) => t.id));
  return { tabs: list, thumbs, activeTabId };
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-spotlight') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || typeof tab.id !== 'number') return;

    if (isCapturable(tab.url)) {
      await captureActiveTab(tab.windowId);
      const payload = await buildSpotlightPayload(tab.id);
      const msg = { type: 'toggle-spotlight', payload };
      try {
        await chrome.tabs.sendMessage(tab.id, msg);
      } catch (e) {
        // Content script not loaded (page opened before install) — inject it.
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['spotlight-core.js', 'content.js'],
          });
          await chrome.tabs.sendMessage(tab.id, msg);
        } catch (e2) {
          await openSpotlightWindow(tab.id);
        }
      }
    } else {
      // chrome:// pages, Web Store, etc. — use the popup window fallback.
      await openSpotlightWindow(tab.id);
    }
  } catch (e) {
    // Nothing sensible to do; never let the command handler throw.
  }
});

async function openSpotlightWindow(activeTabId) {
  stashedActiveTabId = activeTabId;
  const width = 740;
  const height = 760;
  let left;
  let top;
  try {
    const win = await chrome.windows.getLastFocused();
    if (typeof win.left === 'number' && typeof win.width === 'number') {
      left = win.left + Math.round((win.width - width) / 2);
      top = win.top + Math.round((win.height - height) / 4);
    }
  } catch (e) {
    // Fall through to default positioning.
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL('spotlight.html'),
    type: 'popup',
    width,
    height,
    ...(typeof left === 'number' ? { left, top } : {}),
  });
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'activate-tab') {
    (async () => {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'close-tab') {
    chrome.tabs.remove(msg.tabId).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'get-spotlight-data') {
    (async () => {
      const payload = await buildSpotlightPayload(stashedActiveTabId);
      sendResponse(payload);
    })();
    return true;
  }

  if (msg.type === 'get-thumbs') {
    (async () => {
      sendResponse(await getThumbs(msg.tabIds || []));
    })();
    return true;
  }

  if (msg.type === 'capture-active') {
    (async () => {
      try {
        const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
        scheduleCapture(win.id, 100);
      } catch (e) {
        // No normal window focused.
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
