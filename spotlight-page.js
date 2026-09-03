// Popup-window fallback for the spotlight (used on chrome:// and other pages
// where content scripts can't run).

(async function () {
  'use strict';

  // Paint the right background before the payload arrives to avoid a flash.
  let incognito = false;
  try {
    incognito = !!chrome.extension.inIncognitoContext;
  } catch (e) {
    incognito = false;
  }
  if (incognito) document.documentElement.dataset.theme = 'dark';

  const payload = await chrome.runtime
    .sendMessage({ type: 'get-spotlight-data' })
    .catch(() => null);
  if (!payload) {
    window.close();
    return;
  }
  incognito = incognito || !!payload.incognito;
  if (incognito) document.documentElement.dataset.theme = 'dark';

  const instance = TabSpotlight.create(document.body, { ...payload, incognito }, {
    standalone: true,
    async onActivate(tabId) {
      try {
        await chrome.runtime.sendMessage({ type: 'activate-tab', tabId });
      } finally {
        window.close();
      }
    },
    onClose() {
      window.close();
    },
    fetchThumbs(tabIds) {
      return chrome.runtime.sendMessage({ type: 'get-thumbs', tabIds }).catch(() => ({}));
    },
  });
  document.documentElement.dataset.theme = instance.theme;

  // A freshly created popup window doesn't always receive keyboard focus on
  // macOS; ask for it explicitly, then keep the search box focused.
  window.focus();
  instance.focus();
  window.addEventListener('focus', () => instance.focus());

  // Shortcut pressed again while this popup is up: alt-tab if nothing typed.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'spotlight-shortcut-again') return;
    if (instance.isEmpty()) instance.goPrevious();
    else window.close();
  });

  window.addEventListener('blur', () => window.close());
})();
