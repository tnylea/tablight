// Runs at document_start in every http(s) page, before any page script, so
// the extension's capture-phase keydown listener is registered first and
// therefore runs first. While the spotlight is open, content.js installs a
// handler here that routes every key to the spotlight and stops the page from
// seeing it (editors and app shells otherwise swallow or redirect keys).

(function () {
  'use strict';
  if (window.__tsKeyguard) return;
  const guard = { handler: null };
  window.__tsKeyguard = guard;
  window.addEventListener(
    'keydown',
    (e) => {
      if (guard.handler) guard.handler(e);
    },
    true
  );
})();
