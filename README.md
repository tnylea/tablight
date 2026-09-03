# Tab Thumbnails & Spotlight

A Chrome extension with two features:

1. **Side panel tab list** — a vertical list of every tab in the current window,
   each with a live screenshot thumbnail. Click a card to switch to that tab,
   hover for a larger preview, and use the `×` button to close a tab.
2. **Spotlight tab switcher** — press **⌘⇧Space** (Mac) / **Ctrl+Shift+Space**
   (Windows/Linux) to open a spotlight overlay: a fuzzy search box on top and a
   3×3 grid of your most recently used tabs below it. Navigate with the arrow
   keys or `Tab` / `Shift+Tab`, press `Enter` to jump to the selected tab, and
   `Esc` to close. Typing fuzzy-filters all open tabs by title and URL, with
   matched characters highlighted.

The spotlight is light by default and switches to a dark theme when Chrome is
in dark mode or the current tab is incognito.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Click the extension's toolbar icon to open the side panel

If the keyboard shortcut doesn't respond, another extension may already own
it — set it manually at `chrome://extensions/shortcuts`.

## How it works

- The service worker captures a screenshot of the active tab whenever you
  switch tabs, finish loading a page, refocus a window, or stop scrolling.
  Screenshots are downscaled to 480px JPEGs and kept in an in-memory cache
  mirrored to `chrome.storage.session` (cleared when Chrome quits, capped at
  the 60 most recent). New thumbnails are pushed straight into the side panel
  and spotlight, so they show up the moment they exist.
- The spotlight overlay is injected into the current page inside a closed
  shadow root, so page CSS can't affect it. On pages where content scripts
  can't run (`chrome://` pages, the Web Store), it opens as a small centered
  popup window instead.
- The tab you're on appears first with a "Current" pill, but the selection
  starts on your previous tab, so `Enter` right after opening jumps back —
  alt-tab style. `Space` on an empty search box does the same, and so does
  pressing the shortcut again: ⌘⇧Space, Space bounces between two tabs.

## Notes & limitations

- Chrome only lets extensions screenshot the *visible* tab. Tabs you haven't
  looked at yet get a thumbnail generated from the site's own Open Graph
  image (read from the page, or fetched from its HTML if the page has been
  put to sleep by Memory Saver). If a site has none, a placeholder tinted with
  the site's colour plus its favicon is shown.
- To get *real* screenshots for every tab, the extension waits until you've
  been idle for 30 seconds, then briefly shows each tab that still lacks one,
  captures it, and returns to your tab. It stops the moment you touch the
  keyboard or mouse, and it never runs while a tab is playing audio, the
  window is fullscreen, or you're on a call/video site. The **Capture all**
  button in the side panel does the same on demand.
- To read a sleeping tab's Open Graph image the extension re-requests that
  tab's URL without cookies. It skips incognito tabs and links that look
  single-use (password resets, confirmations, tokens). Nothing is sent
  anywhere other than the site itself.
- Thumbnails are remembered per page and kept in the extension's local
  storage inside your Chrome profile, so they survive reloads and restarts.
  A new tab to a page you've seen before gets its thumbnail instantly, and a
  tab on a site you've captured borrows that site's latest thumbnail until
  its own is taken. Incognito thumbnails are never written to disk.
- Chrome's own pages (`chrome://extensions`, the new tab page, settings) can
  only be screenshotted at the moment you press the shortcut on them, which
  the extension now does; one capture covers every tab on that page. Until
  then they show a Chrome icon card.
- Typing always goes to the spotlight while it's open, even on pages that
  normally capture the keyboard (editors, docs apps).
- After editing the extension's files, click ↻ on its card at
  `chrome://extensions` — Chrome does not reload unpacked extensions on its
  own.
- Chrome's native vertical tab strip can't be modified by extensions; the side
  panel is the extension-accessible equivalent. For hover previews on the
  native strip itself, enable Chrome's built-in setting:
  **Settings → Appearance → Tab hover preview → Show tab preview image**.
- Thumbnails are never written to disk and never leave the browser.
