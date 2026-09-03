// Popup-window fallback for the spotlight (used on chrome:// and other pages
// where content scripts can't run).

(async function () {
  'use strict';
  const payload = await chrome.runtime.sendMessage({ type: 'get-spotlight-data' });

  TabSpotlight.create(document.body, payload, {
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
  });

  window.addEventListener('blur', () => window.close());
})();
