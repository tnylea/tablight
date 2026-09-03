// Tab Thumbnails & Spotlight — service worker.
//
// Keeps a thumbnail for every tab, from three sources in order of preference:
//   1. A real screenshot ('shot') — Chrome can only screenshot the *visible*
//      tab, so these come from tab switches, page loads, scroll-stops, and an
//      idle-time warm-up that briefly shows each un-screenshotted tab.
//   2. The page's Open Graph image ('og') — reported by the content script
//      from background tabs, or fetched straight from the page HTML by this
//      worker when there is no content script (discarded tabs, etc.).
//   3. A placeholder tinted with the site colour (rendered by the UIs).
//
// Thumbnails are keyed by URL (not tab id) and persisted in
// chrome.storage.local, so they survive extension reloads and browser
// restarts, a new tab opened to a known URL is thumbnailed instantly, and any
// tab on a known site borrows that site's latest screenshot until its own is
// taken. Incognito tabs are kept in memory only and never written to disk.

const THUMB_WIDTH = 480;
const JPEG_QUALITY = 0.72;
// Persisted thumbnail cap (~30KB each). Generated (og) ones are evicted first.
const MAX_STORED_THUMBS = 400;
// captureVisibleTab is rate-limited by Chrome (2 calls/sec per extension).
const MIN_CAPTURE_INTERVAL_MS = 520;
// First capture right after a switch (one or two frames in), then a second
// "settle" capture once the page has had time to lay out / finish painting.
const ACTIVATE_DELAY_MS = 60;
const SETTLE_DELAY_MS = 650;
const LOAD_DELAY_MS = 250;
// How many thumbnails the spotlight receives up front; the rest are fetched
// lazily as search results change.
const SPOTLIGHT_EAGER_THUMBS = 12;
// Open Graph image download limits.
const OG_FETCH_TIMEOUT_MS = 8000;
const OG_MAX_BYTES = 6 * 1024 * 1024;
const OG_MIN_PIXELS = 120 * 60;
// Page-HTML fallback (no content script): read at most this much of the page.
const HTML_FETCH_TIMEOUT_MS = 6000;
const HTML_MAX_BYTES = 256 * 1024;
const HTML_FETCH_CONCURRENCY = 3;
// Idle warm-up: after this many seconds without input, briefly show each tab
// that still has no screenshot so it can be captured.
const WARMUP_IDLE_SECONDS = 30;
const WARMUP_SHOW_MS = 420;
const WARMUP_MAX_TABS = 40;
// Never warm up while the user is plausibly watching or on a call, even with
// no input: audible tabs, fullscreen windows, or one of these on screen.
const DO_NOT_DISTURB_HOSTS = /(^|\.)(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com|discord\.com|slack\.com|webex\.com|youtube\.com|netflix\.com|twitch\.tv|vimeo\.com|hulu\.com|disneyplus\.com|primevideo\.com|max\.com|tv\.apple\.com|loom\.com)$/i;
// URLs we must not re-request from the worker: one-time / signed links.
const SENSITIVE_URL = /(token|auth|session|signature|sig|otp|password|passwd|secret|reset|confirm|verify|unsubscribe|magic|invite|code)=/i;
const SENSITIVE_PATH = /\/(reset|confirm|verify|unsubscribe|login|signin|sign-in|logout|auth|oauth|callback|invite|magic)(\/|$)/i;

let lastCaptureAt = 0;
const pendingCaptures = new Map(); // windowId -> timeout id
// chrome:// and other privileged pages can only be screenshotted under the
// activeTab grant, which the user's shortcut press confers on the current
// tab until it navigates. Remember which tabs currently hold that grant.
const activeTabGranted = new Set();
// Tabs that currently have the spotlight overlay mounted. Captures are skipped
// for these so we never screenshot the overlay itself. Mirrored to
// storage.session because the service worker can be torn down while an
// overlay is still open.
const openOverlays = new Set();
// Active tab of the last focused normal window, stashed when the spotlight
// popup fallback opens (the popup itself steals focus).
let stashedActiveTabId = null;
let stashedIncognito = false;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return '';
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

// Thumbnail identity: the page minus its fragment. Query strings stay — a
// Google search result is a different page from another search.
function urlKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href.slice(0, 2000);
  } catch (e) {
    return '';
  }
}

function isCapturable(url) {
  return typeof url === 'string' && /^(https?|file):/.test(url);
}

// Anything with a URL can hold a thumbnail (chrome://extensions included);
// isCapturable() only says whether we may screenshot it *unprompted*.
function isThumbable(url) {
  return typeof url === 'string' && /^(https?|file|chrome|chrome-extension|about|edge):/.test(url);
}

function mayCapture(tab) {
  return !!tab && (isCapturable(tab.url) || activeTabGranted.has(tab.id));
}

// ---------------------------------------------------------------------------
// Thumbnail store
//
//   index:   urlKey -> { origin, ts, kind, provisional? }   (small; always in memory)
//   thumbs:  urlKey -> { data, kind, ts, url, provisional? } (in memory once read)
//   storage.local: 't:' + urlKey -> entry, 'index' -> index object,
//                  'meta' -> { origin: { color, ts } }
//   privateThumbs: tabId -> entry   (incognito; memory + storage.session only)
//   meta:    origin -> { color, ts }
// ---------------------------------------------------------------------------

const index = new Map();
const thumbs = new Map();
const privateThumbs = new Map();
const meta = new Map();
const mruCache = new Map(); // tabId -> ts (our own recency, immune to warm-up)
let hydrated = null;
// og:image URLs currently being downloaded, keyed by urlKey.
const ogInFlight = new Map();
// Page URLs whose HTML we've already scanned for og:image (success or not).
const htmlScanned = new Map(); // url -> ts
const HTML_SCANNED_MAX = 600;
const HTML_SCAN_TTL_MS = 6 * 60 * 60 * 1000;

// Diagnostics surfaced in the side panel and spotlight footer.
const status = {
  captureOk: null, // null = never tried, true/false = last result
  lastError: '',
  lastErrorAt: 0,
  lastCaptureAt: 0,
  attempts: 0,
  warming: false,
};

function hydrate() {
  if (!hydrated) {
    hydrated = (async () => {
      try {
        const local = await chrome.storage.local.get(['index']);
        if (local.index && typeof local.index === 'object') {
          for (const [key, v] of Object.entries(local.index)) {
            if (v && typeof v === 'object') index.set(key, v);
          }
        }
      } catch (e) {
        console.warn('[tab-thumbs] index read failed:', e && e.message ? e.message : e);
      }
      try {
        const all = await chrome.storage.session.get(null);
        for (const key of Object.keys(all)) {
          if (key.startsWith('p_')) {
            const id = Number(key.slice(2));
            if (Number.isFinite(id) && !privateThumbs.has(id)) privateThumbs.set(id, all[key]);
          }
        }
        if (Array.isArray(all.openOverlays)) {
          for (const id of all.openOverlays) if (Number.isFinite(id)) openOverlays.add(id);
        }
        if (all.mru && typeof all.mru === 'object') {
          for (const [id, ts] of Object.entries(all.mru)) {
            if (!mruCache.has(Number(id))) mruCache.set(Number(id), ts);
          }
        }
        if (all.status && typeof all.status === 'object') Object.assign(status, all.status, { warming: false });
        if (all.htmlScanned && typeof all.htmlScanned === 'object') {
          for (const [url, ts] of Object.entries(all.htmlScanned)) {
            if (!htmlScanned.has(url) && typeof ts === 'number') htmlScanned.set(url, ts);
          }
        }
        if (all.meta && typeof all.meta === 'object') {
          for (const [origin, m] of Object.entries(all.meta)) if (!meta.has(origin)) meta.set(origin, m);
        }
      } catch (e) {
        // storage.session unavailable — everything still works from memory.
      }
      // Site colours are tiny — they live in one object, never read per-key.
      try {
        const local = await chrome.storage.local.get(['meta']);
        if (local.meta && typeof local.meta === 'object') {
          for (const [origin, m] of Object.entries(local.meta)) {
            if (m && typeof m === 'object' && !meta.has(origin)) meta.set(origin, m);
          }
        }
      } catch (e) {
        // Fine without.
      }
    })();
  }
  return hydrated;
}

let indexPersistTimer = null;
function persistIndex() {
  if (indexPersistTimer) return;
  indexPersistTimer = setTimeout(() => {
    indexPersistTimer = null;
    chrome.storage.local.set({ index: Object.fromEntries(index) }).catch(() => {});
  }, 400);
}

function setOverlayOpen(tabId, open) {
  if (open) openOverlays.add(tabId);
  else openOverlays.delete(tabId);
  chrome.storage.session.set({ openOverlays: [...openOverlays] }).catch(() => {});
}

let mruPersistTimer = null;
function touchMru(tabId, ts = Date.now()) {
  mruCache.set(tabId, ts);
  if (mruPersistTimer) return;
  mruPersistTimer = setTimeout(() => {
    mruPersistTimer = null;
    chrome.storage.session.set({ mru: Object.fromEntries(mruCache) }).catch(() => {});
  }, 500);
}

let htmlScannedPersistTimer = null;
function markHtmlScanned(url) {
  htmlScanned.set(url, Date.now());
  if (htmlScanned.size > HTML_SCANNED_MAX) {
    const oldest = [...htmlScanned.entries()].sort((a, b) => a[1] - b[1]).slice(0, htmlScanned.size - HTML_SCANNED_MAX);
    for (const [u] of oldest) htmlScanned.delete(u);
  }
  if (htmlScannedPersistTimer) return;
  htmlScannedPersistTimer = setTimeout(() => {
    htmlScannedPersistTimer = null;
    chrome.storage.session.set({ htmlScanned: Object.fromEntries(htmlScanned) }).catch(() => {});
  }, 1000);
}

function statusSnapshot() {
  let shots = 0;
  let generated = 0;
  for (const e of index.values()) {
    if ((e.kind || 'shot') === 'shot') shots++;
    else generated++;
  }
  return { ...status, shots, generated };
}

function publishStatus(patch) {
  Object.assign(status, patch);
  chrome.runtime.sendMessage({ type: 'status-updated', status: statusSnapshot() }).catch(() => {});
  const { warming, ...persist } = status;
  chrome.storage.session.set({ status: persist }).catch(() => {});
}

// A real screenshot always beats a generated one for the same page. A
// provisional (loading-time) frame never replaces a settled screenshot or an
// og image, and is replaced by either.
function shouldStore(existing, kind, provisional) {
  if (!existing) return true;
  if (kind === 'shot') {
    if (!provisional) return true;
    if (existing.kind === 'og') return false;
    return !!existing.provisional;
  }
  return existing.kind !== 'shot' || !!existing.provisional;
}

// Exact-page thumbnail, reading from disk on first use.
async function lookupExact(key) {
  if (!key) return null;
  const cached = thumbs.get(key);
  if (cached) return cached;
  if (!index.has(key)) return null;
  try {
    const got = await chrome.storage.local.get('t:' + key);
    const entry = got['t:' + key];
    if (entry && typeof entry.data === 'string') {
      thumbs.set(key, entry);
      return entry;
    }
  } catch (e) {
    // Fall through.
  }
  // Index says it exists but it doesn't — heal the index.
  index.delete(key);
  persistIndex();
  return null;
}

// Best thumbnail for a tab: its own page, else the site's most recent one.
async function thumbForTab(tab) {
  if (!tab || !isThumbable(tab.url)) return null;
  if (tab.incognito) {
    const p = privateThumbs.get(tab.id);
    return p ? { data: p.data, kind: p.kind } : null;
  }
  const key = urlKey(tab.url);
  const exact = await lookupExact(key);
  if (exact) return { data: exact.data, kind: exact.kind || 'shot' };
  const origin = originOf(tab.url);
  let bestKey = '';
  let bestTs = 0;
  for (const [k, v] of index) {
    if (v.origin === origin && !v.provisional && (v.ts || 0) > bestTs) {
      bestTs = v.ts || 0;
      bestKey = k;
    }
  }
  if (!bestKey) return null;
  const site = await lookupExact(bestKey);
  return site ? { data: site.data, kind: site.kind || 'shot' } : null;
}

async function saveThumb(tab, dataUrl, kind, provisional = false) {
  await hydrate();
  const url = tab.url || '';
  const entry = { data: dataUrl, kind, ts: Date.now(), url, ...(provisional ? { provisional: true } : {}) };

  if (tab.incognito) {
    const existing = privateThumbs.get(tab.id);
    if (!shouldStore(existing, kind, provisional)) return false;
    privateThumbs.set(tab.id, entry);
    chrome.storage.session.set({ ['p_' + tab.id]: entry }).catch(() => {});
    broadcastThumb(tab, entry);
    return true;
  }

  const key = urlKey(url);
  if (!key) return false;
  const existing = await lookupExact(key);
  if (!shouldStore(existing, kind, provisional)) return false;
  thumbs.set(key, entry);
  index.set(key, { origin: originOf(url), ts: entry.ts, kind, ...(provisional ? { provisional: true } : {}) });
  broadcastThumb(tab, entry);

  const evicted = evictThumbs();
  persistIndex();
  try {
    await chrome.storage.local.set({ ['t:' + key]: entry });
    if (evicted.length) await chrome.storage.local.remove(evicted.map((k) => 't:' + k));
  } catch (e) {
    console.warn('[tab-thumbs] storage write failed:', e && e.message ? e.message : e);
  }
  return true;
}

function broadcastThumb(tab, entry) {
  chrome.runtime
    .sendMessage({
      type: 'thumb-updated',
      tabId: tab.id,
      urlKey: tab.incognito ? '' : urlKey(tab.url || ''),
      origin: tab.incognito ? '' : originOf(tab.url || ''),
      data: entry.data,
      kind: entry.kind,
    })
    .catch(() => {});
}

// Oldest generated thumbnails go first, then oldest screenshots. Returns the
// urlKeys that were removed.
function evictThumbs() {
  const evicted = [];
  if (index.size <= MAX_STORED_THUMBS) return evicted;
  const byAge = (kind) =>
    [...index.entries()].filter(([, e]) => (e.kind || 'shot') === kind).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  const drop = (entries, count) => {
    for (const [k] of entries.slice(0, Math.max(0, count))) {
      index.delete(k);
      thumbs.delete(k);
      evicted.push(k);
    }
  };
  drop(byAge('og'), index.size - MAX_STORED_THUMBS);
  if (index.size > MAX_STORED_THUMBS) drop(byAge('shot'), index.size - MAX_STORED_THUMBS);
  return evicted;
}

async function saveMeta(tab, color) {
  if (!color) return;
  await hydrate();
  const origin = originOf(tab.url || '');
  if (!origin) return;
  const prev = meta.get(origin);
  if (prev && prev.color === color) return;
  const m = { color, ts: Date.now() };
  meta.set(origin, m);
  chrome.runtime.sendMessage({ type: 'meta-updated', tabId: tab.id, origin, meta: { color } }).catch(() => {});
  if (tab.incognito) privateMeta.add(origin);
  persistMeta();
}

// Colours for origins seen in incognito stay out of storage.local.
const privateMeta = new Set();
let metaPersistTimer = null;
function persistMeta() {
  if (metaPersistTimer) return;
  metaPersistTimer = setTimeout(() => {
    metaPersistTimer = null;
    const pub = {};
    const priv = {};
    for (const [origin, m] of meta) (privateMeta.has(origin) ? priv : pub)[origin] = m;
    chrome.storage.local.set({ meta: pub }).catch(() => {});
    chrome.storage.session.set({ meta: priv }).catch(() => {});
  }, 500);
}

function dropTab(tabId) {
  privateThumbs.delete(tabId);
  mruCache.delete(tabId);
  chrome.storage.session.remove('p_' + tabId).catch(() => {});
}

// Returns { thumbs: { id: { data, kind } }, meta: { id: { color } } }.
async function getThumbs(tabIds) {
  await hydrate();
  const out = { thumbs: {}, meta: {} };
  if (!tabIds.length) return out;
  const all = await chrome.tabs.query({}).catch(() => []);
  const byId = new Map(all.map((t) => [t.id, t]));
  // Warm the exact-key entries in one storage read.
  const missingKeys = [];
  for (const id of tabIds) {
    const t = byId.get(id);
    if (!t || t.incognito || !isThumbable(t.url)) continue;
    const key = urlKey(t.url);
    if (key && index.has(key) && !thumbs.has(key)) missingKeys.push('t:' + key);
  }
  if (missingKeys.length) {
    try {
      const got = await chrome.storage.local.get(missingKeys);
      for (const [k, v] of Object.entries(got)) if (v && typeof v.data === 'string') thumbs.set(k.slice(2), v);
    } catch (e) {
      // Per-key lookups below will cope.
    }
  }
  for (const id of tabIds) {
    const t = byId.get(id);
    if (!t) continue;
    const thumb = await thumbForTab(t);
    if (thumb) out.thumbs[id] = thumb;
    const m = meta.get(originOf(t.url || ''));
    if (m && m.color) out.meta[id] = { color: m.color };
  }
  return out;
}

function hasGoodShot(tab) {
  if (tab.incognito) {
    const p = privateThumbs.get(tab.id);
    return !!(p && p.kind === 'shot' && !p.provisional);
  }
  const e = index.get(urlKey(tab.url || ''));
  return !!(e && (e.kind || 'shot') === 'shot' && !e.provisional);
}

function hasAnyThumb(tab) {
  if (tab.incognito) return privateThumbs.has(tab.id);
  const e = index.get(urlKey(tab.url || ''));
  return !!(e && !e.provisional);
}

// ---------------------------------------------------------------------------
// Image pipeline
// ---------------------------------------------------------------------------

// fetch() on data: URLs is unreliable in MV3 service workers — decode manually.
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

async function resizeBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB_WIDTH / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const pixels = bitmap.width * bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  // Transparent PNG/WebP og images get a white ground so they read as a card.
  // (SVG blobs aren't decodable here; those sites fall back to the placeholder.)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  return { dataUrl: await blobToDataUrl(out), pixels };
}

async function resizeDataUrl(dataUrl) {
  return (await resizeBlob(dataUrlToBlob(dataUrl))).dataUrl;
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

// ---------------------------------------------------------------------------
// Screenshot capture (visible tab only)
// ---------------------------------------------------------------------------

function scheduleCapture(windowId, delay = ACTIVATE_DELAY_MS) {
  if (typeof windowId !== 'number' || windowId === chrome.windows.WINDOW_ID_NONE) return;
  const existing = pendingCaptures.get(windowId);
  if (existing) clearTimeout(existing);
  const id = setTimeout(() => {
    pendingCaptures.delete(windowId);
    captureActiveTab(windowId);
  }, delay);
  pendingCaptures.set(windowId, id);
}

// Activation captures come in two beats: one as soon as the tab is visible so
// a thumbnail exists immediately, and one after the page settles.
function scheduleActivationCapture(windowId) {
  scheduleCapture(windowId, ACTIVATE_DELAY_MS);
  setTimeout(() => {
    if (!pendingCaptures.has(windowId)) scheduleCapture(windowId, 0);
  }, SETTLE_DELAY_MS);
}

async function activeCapturableTab(windowId) {
  await hydrate();
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!mayCapture(tab) || openOverlays.has(tab.id)) return null;
  return tab;
}

// Takes the screenshot if the rate limiter allows it. Returns the raw data URL
// or null if the capture was deferred/skipped.
async function grabVisible(windowId, tab, opts = {}) {
  let now = Date.now();
  const wait = MIN_CAPTURE_INTERVAL_MS - (now - lastCaptureAt);
  if (wait > 0) {
    if (!opts.force) {
      scheduleCapture(windowId, wait + 10);
      return null;
    }
    // Warm-up paces itself: wait out the quota instead of deferring.
    await new Promise((r) => setTimeout(r, wait + 10));
    now = Date.now();
  }
  lastCaptureAt = now;
  status.attempts++;
  try {
    const raw = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 });
    if (status.captureOk !== true) publishStatus({ captureOk: true, lastCaptureAt: now });
    else status.lastCaptureAt = now;
    return raw;
  } catch (e) {
    // Rate limit hit, protected page, window minimized, tab mid-navigation…
    const message = e && e.message ? e.message : String(e);
    console.warn('[tab-thumbs] capture failed:', message);
    // Quota errors are transient and expected, and a privileged page we
    // weren't allowed to capture isn't a broken setup — don't flag those.
    const privileged = !isCapturable(tab && tab.url);
    if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(message) && !privileged) {
      publishStatus({ captureOk: false, lastError: message, lastErrorAt: now });
    }
    if (privileged && tab) activeTabGranted.delete(tab.id);
    return null;
  }
}

async function processCapture(tab, raw) {
  try {
    const thumb = await resizeDataUrl(raw);
    await saveThumb(tab, thumb, 'shot', tab.status !== 'complete');
  } catch (e) {
    console.warn('[tab-thumbs] thumbnail encode failed:', e && e.message ? e.message : e);
  }
}

async function captureActiveTab(windowId) {
  try {
    const tab = await activeCapturableTab(windowId);
    if (!tab) return;
    const raw = await grabVisible(windowId, tab);
    // The overlay may have mounted while the screenshot was in flight.
    if (raw && !openOverlays.has(tab.id)) await processCapture(tab, raw);
  } catch (e) {
    // Window gone between query and capture.
    console.warn('[tab-thumbs] capture failed:', e && e.message ? e.message : e);
  }
}

async function captureFocusedWindow() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (win && typeof win.id === 'number') scheduleActivationCapture(win.id);
  } catch (e) {
    // No normal window open.
  }
}

// ---------------------------------------------------------------------------
// Generated thumbnails — from og:image + site colour. Meta arrives either from
// the content script (page-meta) or from scanning the page HTML here.
// ---------------------------------------------------------------------------

// Only public http(s) hosts. A page controls its own og:image, so never let
// it point the service worker (which has <all_urls>) at loopback, link-local
// or private-network addresses.
function isFetchableImage(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return false;
  if (host.startsWith('[')) return false; // IPv6 literal
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  }
  return true;
}

async function fetchOgThumb(tab, imageUrl, pageUrl) {
  await hydrate();
  const key = tab.incognito ? 'p:' + tab.id : urlKey(pageUrl);
  if (!key) return;
  const existing = tab.incognito ? privateThumbs.get(tab.id) : await lookupExact(key);
  if (!shouldStore(existing, 'og', false)) return;
  if (existing && existing.kind === 'og' && existing.url === pageUrl) return;
  if (ogInFlight.get(key) === imageUrl) return;
  ogInFlight.set(key, imageUrl);
  try {
    const res = await fetch(imageUrl, {
      credentials: 'omit',
      redirect: 'follow',
      cache: 'force-cache',
      signal: AbortSignal.timeout(OG_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type && !type.startsWith('image/')) return;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > OG_MAX_BYTES) return;
    const blob = await res.blob();
    if (blob.size > OG_MAX_BYTES || blob.size === 0) return;
    const { dataUrl, pixels } = await resizeBlob(blob);
    if (pixels < OG_MIN_PIXELS) return; // tracking pixels / tiny icons
    // The tab may have navigated while we were downloading — only keep the
    // image if it still shows that page.
    let fresh = null;
    try {
      fresh = await chrome.tabs.get(tab.id);
    } catch (e) {
      return;
    }
    if (urlKey(fresh.url || '') !== urlKey(pageUrl)) return;
    await saveThumb(fresh, dataUrl, 'og');
  } catch (e) {
    // Blocked by the site, not an image, timed out — the branded placeholder
    // (favicon + site colour) remains. Not worth a warning per tab.
  } finally {
    if (ogInFlight.get(key) === imageUrl) ogInFlight.delete(key);
  }
}

function handlePageMeta(tab, m) {
  if (!tab || typeof tab.id !== 'number' || !m) return;
  const url = typeof m.url === 'string' ? m.url : tab.url || '';
  const color = typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '';
  if (color) saveMeta({ ...tab, url }, color);
  if (isFetchableImage(m.image)) fetchOgThumb(tab, m.image, url);
}

// --- Page-HTML fallback ----------------------------------------------------
// For tabs with no content script (discarded by Memory Saver, injection
// blocked, or simply not loaded yet) read the first chunk of the page HTML
// and pull og:image / theme-color out of it with regexes.

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // last, so "&amp;quot;" stays literal
}

function extractMetaFromHtml(html, baseUrl) {
  const head = html.slice(0, HTML_MAX_BYTES);
  const tags = head.match(/<(?:meta|link)\b[^>]*>/gi) || [];
  const attrs = (tag) => {
    const out = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    return out;
  };
  const wanted = [
    ['property', 'og:image:secure_url'],
    ['property', 'og:image'],
    ['name', 'og:image'],
    ['name', 'twitter:image'],
    ['name', 'twitter:image:src'],
    ['rel', 'image_src'],
  ];
  let image = '';
  let color = '';
  const parsed = tags.map(attrs);
  for (const [attr, value] of wanted) {
    const hit = parsed.find((a) => (a[attr] || '').toLowerCase() === value && (a.content || a.href));
    if (hit) {
      try {
        const u = new URL(hit.content || hit.href, baseUrl);
        if (/^https?:$/.test(u.protocol)) {
          image = u.href;
          break;
        }
      } catch (e) {
        // Bad URL in the page — try the next candidate.
      }
    }
  }
  const theme = parsed.find((a) => (a.name || '').toLowerCase() === 'theme-color' && a.content);
  if (theme) {
    const c = theme.content.trim();
    const hex6 = /^#([0-9a-f]{6})$/i.exec(c);
    const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
    if (hex6) color = '#' + hex6[1].toLowerCase();
    else if (hex3) color = ('#' + hex3[1] + hex3[1] + hex3[2] + hex3[2] + hex3[3] + hex3[3]).toLowerCase();
    else if (rgb) color = '#' + [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
  }
  return { image, color };
}

async function readHtmlHead(url) {
  const res = await fetch(url, {
    credentials: 'omit',
    redirect: 'follow',
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    signal: AbortSignal.timeout(HTML_FETCH_TIMEOUT_MS),
  });
  const bail = () => {
    if (res.body) res.body.cancel().catch(() => {});
    return { html: '', finalUrl: res.url };
  };
  if (!res.ok) return bail();
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type && !/html|xml/.test(type)) return bail();
  if (!res.body) return { html: (await res.text()).slice(0, HTML_MAX_BYTES), finalUrl: res.url };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  while (html.length < HTML_MAX_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    // Stop early once the head is closed — everything we want is in it.
    if (/<\/head>/i.test(html) || /<body[\s>]/i.test(html)) break;
  }
  html += decoder.decode();
  reader.cancel().catch(() => {});
  return { html, finalUrl: res.url };
}

// The worker re-requests a tab's URL without cookies to read its <head>. Never
// do that for links that may be single-use or that identify the user.
function isScannableUrl(url) {
  if (!isFetchableImage(url)) return false; // same public-host rules
  try {
    const u = new URL(url);
    if (SENSITIVE_URL.test(u.search) || SENSITIVE_PATH.test(u.pathname)) return false;
    if (u.username || u.password) return false;
    return true;
  } catch (e) {
    return false;
  }
}

async function scanTabHtml(tab) {
  if (!tab || typeof tab.id !== 'number' || !/^https?:/.test(tab.url || '')) return;
  if (tab.incognito || !isScannableUrl(tab.url)) return;
  await hydrate();
  if (hasAnyThumb(tab)) return;
  const scannedAt = htmlScanned.get(tab.url);
  if (scannedAt && Date.now() - scannedAt < HTML_SCAN_TTL_MS) return;
  markHtmlScanned(tab.url);
  try {
    const { html, finalUrl } = await readHtmlHead(tab.url);
    if (!html) return;
    // Redirected elsewhere (login page, auth provider) — its og:image would
    // misrepresent the tab.
    if (finalUrl && originOf(finalUrl) !== originOf(tab.url)) return;
    const { image, color } = extractMetaFromHtml(html, tab.url);
    if (color) saveMeta(tab, color);
    if (isFetchableImage(image)) await fetchOgThumb(tab, image, tab.url);
  } catch (e) {
    // Offline, blocked, non-HTML — placeholder stays.
  }
}

// Every tab without a thumbnail for its current page gets an HTML scan.
let sweepRunning = null;
function sweepMissingThumbs() {
  if (sweepRunning) return sweepRunning;
  sweepRunning = (async () => {
    try {
      await hydrate();
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      const queue = tabs.filter((t) => !t.incognito && !hasAnyThumb(t));
      const worker = async () => {
        while (queue.length) await scanTabHtml(queue.shift());
      };
      await Promise.all(Array.from({ length: HTML_FETCH_CONCURRENCY }, worker));
    } catch (e) {
      // Nothing to do.
    } finally {
      sweepRunning = null;
    }
  })();
  return sweepRunning;
}

// Content scripts declared in the manifest only reach pages loaded after
// install. Inject into everything that's already open so every existing tab
// reports its meta (and gets the spotlight) right away.
async function injectIntoExistingTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch (e) {
    return;
  }
  const queue = tabs.filter((t) => typeof t.id === 'number' && !t.discarded);
  const CONCURRENCY = 6;
  async function worker() {
    while (queue.length) {
      const tab = queue.shift();
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['keyguard.js', 'spotlight-core.js', 'content.js'],
        });
      } catch (e) {
        // Protected page (Web Store, PDF viewer, policy-blocked) — skip.
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// ---------------------------------------------------------------------------
// Idle warm-up — the only way to get a *real* screenshot of a tab is to show
// it. When the user has been idle for a while, briefly show each tab in the
// focused window that still has no screenshot, capture it, and put the
// original tab back. Aborts the moment the user does anything.
// ---------------------------------------------------------------------------

let warmup = null; // { windowId, originalTabId, expectTabId, aborted, abortReason, userTabId, done }

// Resolves once the warm-up (if any) has finished restoring the user's tab.
function abortWarmup(reason, userTabId) {
  if (!warmup) return Promise.resolve();
  if (!warmup.aborted) {
    warmup.aborted = true;
    warmup.abortReason = reason;
    if (typeof userTabId === 'number') warmup.userTabId = userTabId;
  }
  return warmup.done;
}

async function runWarmup() {
  if (warmup) return warmup.done;
  // Claim the slot synchronously so idle + "Capture all" can't both start.
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  warmup = {
    windowId: null,
    originalTabId: null,
    expectTabId: null,
    aborted: false,
    abortReason: '',
    userTabId: null,
    done,
  };
  const w = warmup;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let started = false;

  try {
    let win;
    try {
      win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    } catch (e) {
      return;
    }
    if (!win || typeof win.id !== 'number' || !win.focused) return;
    if (win.state === 'minimized' || win.state === 'fullscreen') return;
    await hydrate();
    const tabs = await chrome.tabs.query({ windowId: win.id }).catch(() => []);
    const original = tabs.find((t) => t.active);
    if (!original) return;
    // Watching something / on a call: leave the screen alone.
    if (tabs.some((t) => t.audible)) return;
    if (DO_NOT_DISTURB_HOSTS.test(hostOf(original.url))) return;

    const targets = tabs
      .filter(
        (t) =>
          t.status === 'complete' &&
          !t.active &&
          !t.discarded &&
          mayCapture(t) &&
          !openOverlays.has(t.id) &&
          !hasGoodShot(t)
      )
      .slice(0, WARMUP_MAX_TABS);
    if (targets.length === 0) return;

    started = true;
    w.windowId = win.id;
    w.originalTabId = original.id;
    publishStatus({ warming: true });

    for (const tab of targets) {
      if (w.aborted) break;
      // Keep our own recency untouched: remember the tab's real last access.
      if (!mruCache.has(tab.id)) touchMru(tab.id, tab.lastAccessed || 0);
      w.expectTabId = tab.id;
      try {
        await chrome.tabs.update(tab.id, { active: true });
      } catch (e) {
        w.expectTabId = null;
        continue; // tab closed meanwhile
      }
      await sleep(WARMUP_SHOW_MS);
      if (w.aborted) break;
      const [current] = await chrome.tabs.query({ active: true, windowId: win.id }).catch(() => []);
      if (!current || current.id !== tab.id) break; // user took over
      if (openOverlays.has(current.id)) continue;
      const raw = await grabVisible(win.id, current, { force: true });
      if (raw && !openOverlays.has(current.id)) await processCapture(current, raw);
    }
  } catch (e) {
    console.warn('[tab-thumbs] warm-up failed:', e && e.message ? e.message : e);
  } finally {
    if (started) {
      // Put the user back: on their own tab, or on the one they clicked.
      let target = w.originalTabId;
      if (w.abortReason === 'user-activated' && typeof w.userTabId === 'number') target = w.userTabId;
      try {
        w.expectTabId = target; // our own switch — don't treat it as user input
        await chrome.tabs.update(target, { active: true });
      } catch (e) {
        // Target tab closed — leave things as they are.
      }
      // A click that landed during the restore wins.
      if (w.abortReason === 'user-activated' && typeof w.userTabId === 'number' && w.userTabId !== target) {
        chrome.tabs.update(w.userTabId, { active: true }).catch(() => {});
      }
      publishStatus({ warming: false });
    }
    warmup = null;
    resolveDone();
  }
}

chrome.idle.setDetectionInterval(WARMUP_IDLE_SECONDS);
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'idle') runWarmup().catch(() => {});
  else abortWarmup(state);
});

// ---------------------------------------------------------------------------
// Lifecycle + tab events
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  captureFocusedWindow();
  injectIntoExistingTabs().then(() => setTimeout(sweepMissingThumbs, 1500));
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  captureFocusedWindow();
  setTimeout(sweepMissingThumbs, 3000);
});

chrome.tabs.onActivated.addListener((info) => {
  if (warmup && info.tabId === warmup.expectTabId) return; // our own switch
  if (warmup) abortWarmup('user-activated', info.tabId);
  touchMru(info.tabId);
  scheduleActivationCapture(info.windowId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && openOverlays.has(tabId)) setOverlayOpen(tabId, false);
  if ('url' in changeInfo) activeTabGranted.delete(tabId);
  if (changeInfo.status === 'complete') {
    if (tab.active) scheduleCapture(tab.windowId, LOAD_DELAY_MS);
    // If the content script hasn't reported meta a few seconds after load
    // (blocked, or a page that never ran it), scan the HTML ourselves.
    setTimeout(async () => {
      try {
        const fresh = await chrome.tabs.get(tabId);
        await hydrate();
        if (!hasAnyThumb(fresh)) scanTabHtml(fresh);
      } catch (err) {
        // Tab closed.
      }
    }, 3000);
  }
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (warmup && windowId !== warmup.windowId) abortWarmup('focus-changed');
  if (windowId !== chrome.windows.WINDOW_ID_NONE) scheduleCapture(windowId, 100);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (openOverlays.has(tabId)) setOverlayOpen(tabId, false);
  activeTabGranted.delete(tabId);
  dropTab(tabId);
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (openOverlays.has(removedTabId)) setOverlayOpen(removedTabId, false);
  dropTab(removedTabId);
});

// ---------------------------------------------------------------------------
// Spotlight
// ---------------------------------------------------------------------------

async function buildSpotlightPayload(activeTabId, incognito) {
  await hydrate();
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const recency = (t) => {
    const ours = mruCache.get(t.id);
    return typeof ours === 'number' ? ours : t.lastAccessed || 0;
  };
  tabs.sort((a, b) => recency(b) - recency(a));
  const list = tabs.map((t) => ({
    id: t.id,
    windowId: t.windowId,
    title: t.title || t.url || 'Untitled',
    url: t.url || '',
    favIconUrl: t.favIconUrl || '',
  }));
  // The current tab is shown too (first, as the "you are here" card).
  const eager = list.slice(0, SPOTLIGHT_EAGER_THUMBS).map((t) => t.id);
  const { thumbs: eagerThumbs } = await getThumbs(eager);
  // Colours are tiny — send them for every tab so placeholders are branded
  // from the first frame, even for lazily-thumbnailed search results.
  const metaOut = {};
  for (const t of list) {
    const m = meta.get(originOf(t.url));
    if (m && m.color) metaOut[t.id] = { color: m.color };
  }
  return {
    tabs: list,
    thumbs: eagerThumbs,
    meta: metaOut,
    activeTabId,
    incognito: !!incognito,
    status: statusSnapshot(),
  };
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-spotlight') return;
  // Let a running warm-up finish restoring the user's tab first, otherwise the
  // overlay would mount on a tab that's about to be hidden.
  await abortWarmup('command');
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || typeof tab.id !== 'number') return;
    await hydrate();

    // The popup fallback has focus: a second press there is the alt-tab
    // gesture (or a close), not a request for another popup.
    if ((tab.url || '').startsWith(chrome.runtime.getURL('spotlight.html'))) {
      chrome.runtime.sendMessage({ type: 'spotlight-shortcut-again' }).catch(() => {});
      return;
    }

    if (!isCapturable(tab.url)) {
      // chrome:// pages, Web Store, etc. The shortcut press just granted
      // activeTab on this tab, which is the one way Chrome lets an extension
      // screenshot a privileged page — take it now, keyed by URL so every
      // other tab on the same page (six chrome://extensions tabs…) shares it.
      if (isThumbable(tab.url) && !openOverlays.has(tab.id)) {
        activeTabGranted.add(tab.id);
        const raw = await grabVisible(tab.windowId, tab, { force: true });
        if (raw) processCapture(tab, raw);
        else activeTabGranted.delete(tab.id);
      }
      await openSpotlightWindow(tab);
      return;
    }

    // Speed: nothing but building the payload stands between the keypress
    // and the overlay. The current tab was already captured on activation,
    // load and scroll-stop, so no screenshot is taken here.
    const wasOpen = openOverlays.has(tab.id);
    // Mark the overlay open *before* it mounts so no scheduled capture that
    // starts from here on can include it. Rolled back if it didn't open.
    if (!wasOpen) setOverlayOpen(tab.id, true);

    const payload = await buildSpotlightPayload(tab.id, tab.incognito);
    const msg = { type: 'toggle-spotlight', payload };
    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      // Content script not loaded (page opened before install) — inject it.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['keyguard.js', 'spotlight-core.js', 'content.js'],
        });
        result = await chrome.tabs.sendMessage(tab.id, msg);
      } catch (e2) {
        setOverlayOpen(tab.id, false);
        await openSpotlightWindow(tab);
        return;
      }
    }
    setOverlayOpen(tab.id, !!(result && result.open));
  } catch (e) {
    // Nothing sensible to do; never let the command handler throw.
  }
});

async function openSpotlightWindow(tab) {
  stashedActiveTabId = tab.id;
  stashedIncognito = !!tab.incognito;
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
  const opts = {
    url: chrome.runtime.getURL('spotlight.html'),
    type: 'popup',
    focused: true,
    width,
    height,
    ...(typeof left === 'number' ? { left, top } : {}),
  };
  try {
    await chrome.windows.create({ ...opts, incognito: stashedIncognito });
  } catch (e) {
    // Incognito windows may be disallowed by policy — open a regular one.
    await chrome.windows.create(opts);
  }
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

  if (msg.type === 'spotlight-closed') {
    if (sender.tab && typeof sender.tab.id === 'number') setOverlayOpen(sender.tab.id, false);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'page-meta') {
    // Only trust meta from a real tab's top-level, *active* document — never
    // from UI pages, iframes, or a prerendered page the tab isn't showing yet.
    const lifecycle = sender.documentLifecycle;
    const active = lifecycle === undefined || lifecycle === 'active';
    if (sender.tab && sender.frameId === 0 && active) handlePageMeta(sender.tab, msg.meta);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'get-spotlight-data') {
    (async () => {
      const payload = await buildSpotlightPayload(stashedActiveTabId, stashedIncognito);
      sendResponse(payload);
    })();
    return true;
  }

  if (msg.type === 'get-thumbs') {
    (async () => {
      sendResponse(await getThumbs(Array.isArray(msg.tabIds) ? msg.tabIds : []));
    })();
    return true;
  }

  if (msg.type === 'get-status') {
    (async () => {
      await hydrate();
      sendResponse(statusSnapshot());
    })();
    return true;
  }

  if (msg.type === 'fill-missing') {
    // Side panel "Capture all" action: scan HTML for every tab lacking a
    // thumbnail, then warm up screenshots for the focused window.
    (async () => {
      await sweepMissingThumbs();
      if (msg.warm) await runWarmup().catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'capture-active') {
    (async () => {
      try {
        if (warmup) {
          // Warm-up paces its own captures; side requests would starve it.
        } else if (sender.tab) {
          // From a content script (scroll settled, page became visible).
          if (sender.tab.active) scheduleCapture(sender.tab.windowId, 80);
        } else {
          const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
          scheduleCapture(win.id, 60);
        }
      } catch (e) {
        // No normal window focused.
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

// Chrome suspends an idle MV3 service worker after ~30s; a cold start adds
// 100–300ms to the next shortcut press. Any extension API call resets the
// idle timer, so a cheap periodic call keeps the worker warm.
setInterval(() => {
  chrome.runtime.getPlatformInfo(() => {});
}, 20000);

// Pull the most recently used tabs' thumbnails into memory as soon as the
// worker starts so the first spotlight open never touches disk.
async function prewarm() {
  try {
    await hydrate();
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    const recency = (t) => {
      const ours = mruCache.get(t.id);
      return typeof ours === 'number' ? ours : t.lastAccessed || 0;
    };
    tabs.sort((a, b) => recency(b) - recency(a));
    await getThumbs(tabs.slice(0, SPOTLIGHT_EAGER_THUMBS + 4).map((t) => t.id));
  } catch (e) {
    // Best effort.
  }
}
prewarm();

// The worker may have just been (re)started with tabs already open — make
// sure nothing is left without a thumbnail.
setTimeout(sweepMissingThumbs, 4000);
