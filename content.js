// Content script: hosts the spotlight overlay inside a closed shadow root so
// page styles can't leak in and the page can't easily reach the UI.

(function () {
  'use strict';
  if (window.__tabSpotlightInit) return;
  window.__tabSpotlightInit = true;

  let host = null;
  let instance = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle-spotlight') {
      if (host) {
        closeSpotlight();
      } else {
        openSpotlight(msg.payload);
      }
    }
  });

  function openSpotlight(payload) {
    host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    (document.documentElement || document.body).appendChild(host);

    instance = TabSpotlight.create(shadow, payload, {
      onActivate(tabId) {
        chrome.runtime.sendMessage({ type: 'activate-tab', tabId }).catch(() => {});
        closeSpotlight();
      },
      onClose: closeSpotlight,
    });
  }

  function closeSpotlight() {
    if (instance) instance.destroy();
    if (host) host.remove();
    instance = null;
    host = null;
  }
})();
