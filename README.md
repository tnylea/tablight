# Tab Thumbnails & Spotlight

A Chrome extension with two features:

1. **Side panel tab list** — a vertical list of every tab in the current window,
   each with a live screenshot thumbnail. Click a card to switch to that tab,
   hover for a larger preview, and use the `×` button to close a tab.
2. **Spotlight tab switcher** — press **⌘⇧Space** (Mac) / **Ctrl+Shift+Space**
   (Windows/Linux) to open a spotlight overlay: a fuzzy search box on top and a
   3×3 grid of your most recently used tabs below it. Navigate with the arrow
   keys or `Tab` / `Shift+Tab`, press `Enter` to jump to the selected tab, and
   `Esc` to close. Typing fuzzy-filters all open tabs by title and URL.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Click the extension's toolbar icon to open the side panel

If the keyboard shortcut doesn't respond, another extension may already own
it — set it manually at `chrome://extensions/shortcuts`.

## How it works

- The service worker captures a screenshot of the active tab whenever you
  switch tabs, finish loading a page, or refocus a window. Screenshots are
  downscaled to 480px JPEGs and kept in `chrome.storage.session` (in-memory,
  cleared when Chrome quits, capped at the 60 most recent).
- The spotlight overlay is injected into the current page inside a closed
  shadow root, so page CSS can't affect it. On pages where content scripts
  can't run (`chrome://` pages, the Web Store), it opens as a small centered
  popup window instead.
- The spotlight grid excludes the tab you're currently on, so pressing
  `Enter` immediately after opening it jumps to your previous tab —
  alt-tab style.

## Notes & limitations

- Chrome only lets extensions screenshot the *visible* tab, so a tab gets its
  thumbnail the first time you visit it after the extension is installed.
  Until then a favicon + domain placeholder is shown.
- Chrome's native vertical tab strip can't be modified by extensions; the side
  panel is the extension-accessible equivalent. For hover previews on the
  native strip itself, enable Chrome's built-in setting:
  **Settings → Appearance → Tab hover preview → Show tab preview image**.
- Thumbnails are never written to disk and never leave the browser.
