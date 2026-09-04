// Shown once after install when Chrome couldn't bind the suggested shortcut
// (it never auto-assigns a key another extension already owns, and there is
// no API to bind one ourselves). Polls until the user has set it.
(function () {
  'use strict';

  const COMMAND = 'toggle-spotlight';
  const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform);
  const label = isMac ? '⌘⇧Space' : 'Ctrl+Shift+Space';
  document.querySelectorAll('kbd.combo, #combo').forEach((k) => (k.textContent = label));

  const stateEl = document.getElementById('state');

  document.getElementById('open').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open-shortcuts' }).catch(() => {});
  });

  async function poll() {
    try {
      const cmds = await chrome.commands.getAll();
      const cmd = cmds.find((c) => c.name === COMMAND);
      if (cmd && cmd.shortcut) {
        document.body.classList.add('ready');
        document.querySelectorAll('kbd.combo').forEach((k) => (k.textContent = cmd.shortcut));
        // Refresh the side-panel notice.
        chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => {});
        return;
      }
    } catch (e) {
      // Extension reloading — keep polling.
    }
    setTimeout(poll, 1000);
  }
  poll();
})();
