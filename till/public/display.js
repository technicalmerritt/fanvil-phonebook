(() => {
'use strict';
const root = document.getElementById('cv'); const note = document.getElementById('note'); const fs = document.getElementById('fs');
window.CustomerView.render(root, { state: 'idle' });
function connect() {
  const es = new EventSource('/api/display/stream');
  es.onmessage = (e) => { note.hidden = true; try { window.CustomerView.render(root, JSON.parse(e.data)); } catch { /* skip a bad message */ } };
  es.onerror = () => { note.textContent = 'Reconnecting to the till…'; note.hidden = false; };
}
fetch('/api/state', { credentials: 'same-origin' }).then((r) => {
  if (r.status === 401) { note.textContent = 'This screen is locked. Open the till on this device, enter the PIN, then reload this page.'; note.hidden = false; return; }
  connect();
}).catch(() => { note.hidden = false; connect(); });
fs.onclick = () => { const d = document.documentElement; if (d.requestFullscreen) d.requestFullscreen().catch(() => {}); if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {}); };
document.addEventListener('fullscreenchange', () => { fs.hidden = !!document.fullscreenElement; });
})();
