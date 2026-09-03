# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A Chrome extension (Manifest V3, plain JavaScript — no build step, no dependencies) called **Tab Thumbnails & Spotlight**. It gives Chrome two things its native vertical tab strip doesn't:

1. **Side panel tab list** — a vertical list of every tab in the current window, each rendered as a card with a live screenshot thumbnail, favicon, and title. Clicking a card switches to that tab, hovering shows a larger preview, an `×` button closes the tab. The active tab gets a blue outline.
2. **Spotlight tab switcher** — `⌘⇧Space` (Mac) / `Ctrl+Shift+Space` opens a spotlight-style overlay: fuzzy search box on top, a 3×3 grid of thumbnails of the most recently used tabs below. Arrow keys / `Tab` / `Shift+Tab` move the blue selection, `Enter` switches to the selected tab, `Esc` closes. Typing fuzzy-filters all open tabs by title and URL. The grid **excludes the current tab**, so shortcut + `Enter` jumps straight back to the previous tab (alt-tab style).

The original motivation: Chrome's native vertical tab strip can't be modified by extensions (no API exists for browser-chrome UI), so this extension provides the closest achievable equivalents via the side panel and an injected overlay.

## Architecture

```
manifest.json       MV3 manifest: permissions, command shortcut, content script, side panel
background.js       Service worker — the hub. Captures thumbnails, stores them,
                    routes all messages, handles the keyboard command
spotlight-core.js   Shared spotlight UI (global TabSpotlight.create). Owns the CSS
                    string, fuzzy matcher, grid rendering, keyboard navigation
content.js          Thin host: mounts spotlight-core inside a closed shadow root
                    on the page when told to by the background
spotlight.html/-page.js  Popup-window fallback for pages content scripts can't
                    touch (chrome://, Web Store). Same core UI, standalone mode
sidepanel.html/css/js    The side panel tab list
```

### Data flow

- **Thumbnail capture** (background.js): on tab activation, page-load complete, and window focus, the service worker calls `chrome.tabs.captureVisibleTab` (debounced per window, rate-limited — Chrome caps this API at ~2 calls/sec), downscales to a 480px-wide JPEG via `OffscreenCanvas`, and stores it in `chrome.storage.session` keyed `thumb_<tabId>` (in-memory only, capped at 60, oldest evicted, removed when the tab closes).
- **Spotlight open**: command → background captures the current tab, builds a payload (all normal-window tabs sorted by `lastAccessed` desc + thumbnail map) → `tabs.sendMessage` to the content script. If the content script isn't there (page predates install), it's injected via `chrome.scripting.executeScript` and retried; if injection is impossible, the popup-window fallback opens instead (active tab id is stashed in `stashedActiveTabId` first, since the popup steals focus).
- **All tab actions** (activate, close) go through the background via `runtime.sendMessage` — UI contexts never call `chrome.tabs.update` directly.
- Side panel refreshes on every `chrome.tabs` event plus `thumb-updated` broadcasts from the background, debounced 120ms.

## Hard-Won Gotchas (do not regress these)

- **`fetch()` on `data:` URLs is unreliable in MV3 service workers.** Thumbnail decoding uses manual `atob` → `Uint8Array` → `Blob` (`dataUrlToBlob` in background.js). Do not "simplify" it back to `fetch(dataUrl)` — that silently broke all thumbnail generation once already.
- **Grid/flex min-content blowout.** Long unbreakable tab titles will force grid columns unequal and overflow the panel unless the grid uses `repeat(3, minmax(0, 1fr))` and items/meta/titles keep `min-width: 0`. This bug shipped once; the fix lives in spotlight-core.js's CSS string and sidepanel.css.
- **Only the visible tab can be screenshotted.** There is no API to capture background tabs, so a tab has no thumbnail until first visited after install. Placeholders (favicon chip + domain) must always render well.
- **The spotlight overlay lives in a *closed* shadow root** with `all: initial` so page CSS can't leak in. Keep all spotlight styles inside the `CSS` string in spotlight-core.js.
- **Keyboard rules in the spotlight**: `←`/`→` move the text caret while the input has text, and only navigate the grid when it's empty. `↑`/`↓`/`Tab` always navigate. Preserve this.
- **`captureVisibleTab` failures are logged with `console.warn`**, never rethrown — but also never swallowed silently (that hid the fetch bug).

## Conventions

- Vanilla JS, IIFE modules, `'use strict'`, no framework, no build step — edit and reload.
- Every `chrome.*` promise that can reject in normal operation (tab closed, no listener, etc.) gets a `.catch(() => {})` or try/catch; the extension must never throw on routine races.
- Favicon URLs are only rendered when they match `/^(https|data):/` (blocks `chrome://favicon` and other unsafe schemes in UI contexts).
- UI follows the dark spotlight aesthetic (spotlight) and light/dark auto theme via CSS variables + `prefers-color-scheme` (side panel). Accent color is `#3b82f6` everywhere.

## Testing / Verification

No automated tests. Verify changes by:

1. `node --check` every touched JS file (this catches most mistakes; it's been the pre-flight for every change so far).
2. `chrome://extensions` → Developer mode → Load unpacked (or hit ↻ reload on the card after edits).
3. Manual pass: switch between a few tabs (thumbnails should appear within ~½s), open the side panel via the toolbar icon, hit `⌘⇧Space` on a normal page (overlay) and on `chrome://extensions` (popup fallback), type to fuzzy-filter, navigate with arrows/Tab, `Enter` to switch, `Esc` to close.
4. Debug capture issues in the service worker console (`chrome://extensions` → "service worker" link) — capture failures are `console.warn`'d there.

## Known Limitations (accepted, not bugs)

- Thumbnails exist only for tabs visited since the extension loaded; they live in `storage.session` and clear when Chrome quits. Nothing is written to disk or the network.
- The native vertical tab strip itself is untouchable; users who want hover previews there should enable Chrome's built-in **Settings → Appearance → Tab hover preview image**.
- If `⌘⇧Space` doesn't respond, another extension owns the shortcut — reassign at `chrome://extensions/shortcuts`.
- Content scripts run on `http(s)` pages only; `file://` pages get the popup fallback unless the user grants file access.
