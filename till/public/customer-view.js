/* What the customer sees: the items, the total, then a thank-you. Shared by the
   second-screen page and the till's own preview of it. */
(() => {
'use strict';
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const fmt = (p) => '£' + (Math.abs(p) / 100).toFixed(2);
const TICK = '<svg class="tickmark" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29"/><path d="M19 33l9 9 17-19"/></svg>';
window.CustomerView = {
  render(root, st, shop) {
    const s = st || { state: 'idle' };
    root.className = 'cv cv-' + (s.state === 'sale' && s.lines && s.lines.length ? 'sale' : (s.state === 'paid' ? 'paid' : 'idle'));
    root.textContent = '';
    if (s.state === 'paid') {
      const box = el('div', 'cv-center'); const t = el('div'); t.innerHTML = TICK;   // static markup
      box.append(t.firstElementChild, el('h1', null, 'Thank you'));
      if (s.change != null) box.append(el('p', 'cv-label', 'Your change'), el('div', 'cv-big cv-change', fmt(s.change)));
      else box.append(el('p', 'cv-label', 'Paid'), el('div', 'cv-big', fmt(s.total)));
      root.append(box); return;
    }
    if (s.state !== 'sale' || !s.lines || !s.lines.length) {
      const box = el('div', 'cv-center');
      box.append(el('div', 'cv-logo'), el('h1', null, shop || 'Technical Merritt'), el('p', 'cv-sub', 'Welcome'));
      root.append(box); return;
    }
    const list = el('ul', 'cv-list');
    for (const l of s.lines) {
      const li = el('li'); const a = el('div', 'cv-item');
      a.append(el('span', 'cv-title', l.title));
      if (l.qty > 1) a.append(el('span', 'cv-meta', l.qty + ' × ' + fmt(l.unit)));
      li.append(a, el('span', 'cv-amt', fmt(l.total))); list.append(li);
    }
    const n = s.lines.reduce((t, l) => t + l.qty, 0);
    const tot = el('div', 'cv-total');
    tot.append(el('span', 'cv-label', 'To pay'), el('strong', null, fmt(s.total)), el('span', 'cv-meta', (n === 1 ? '1 item' : n + ' items') + ' · includes ' + fmt(s.vat) + ' VAT'));
    root.append(list, tot);
    list.scrollTop = list.scrollHeight;
  },
};
})();
