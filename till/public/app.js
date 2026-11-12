(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt = (p) => (p < 0 ? '-' : '') + '£' + (Math.abs(p) / 100).toFixed(2);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const PREVIEW = !!window.TILL_BACKEND;

const S = {
  cfg: null,
  lines: store.get('till.lines', []),
  saleId: store.get('till.saleId', null),
  quick: [],            // pinned products, in order, each with an optional group id
  groups: [],           // quick key groups: {id, name, color}
  tab: 'all',
  editing: false,
  cashier: store.get('till.cashier', null),   // {id, name} of whoever is signed in
  overlay: null,        // name of the open dialog
  dialogKeys: null,     // keyboard handler owned by the open dialog
  busy: false,
  online: true,
};
const qEl = $('#q');

/* ---------------- api ---------------- */
async function api(path, opts) {
  if (window.TILL_BACKEND) return window.TILL_BACKEND(path, opts); // preview build: no server
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) } });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && data.error === 'locked') { showPin(); const e = new Error('locked'); e.locked = true; throw e; }
  return { ok: res.ok, status: res.status, data };
}

/* ---------------- sound ---------------- */
let actx = null;
function tone(freq, ms, type, vol) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.12, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + ms / 1000);
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + ms / 1000);
  } catch { /* no audio */ }
}
const beepOk = () => tone(1040, 90);
const beepBad = () => tone(200, 280, 'square', 0.09);
const chime = () => { tone(784, 120); setTimeout(() => tone(1175, 220), 110); };

/* ---------------- basket ---------------- */
const total = () => S.lines.reduce((t, l) => t + l.unit * l.qty, 0);
const units = () => S.lines.reduce((t, l) => t + l.qty, 0);
const vatIncluded = () => S.lines.reduce((t, l) => t + (l.taxable ? Math.round(l.unit * l.qty / 6) : 0), 0);

function save() {
  if (S.lines.length && !S.saleId) S.saleId = uid();
  if (!S.lines.length) S.saleId = null;
  store.set('till.lines', S.lines); store.set('till.saleId', S.saleId);
}
let pulseTimer;
function pulse() { const b = $('#basket'); b.classList.add('pulse'); clearTimeout(pulseTimer); pulseTimer = setTimeout(() => b.classList.remove('pulse'), 420); }
function addProduct(p, source) {
  const unit = Math.round((Number(p.price) || 0) * 100);
  let line = S.lines.find((l) => l.product_id === p.id);
  if (line) { line.qty += 1; S.lines = [line, ...S.lines.filter((l) => l !== line)]; }
  else {
    line = { key: 'p' + p.id, product_id: p.id, title: p.title, fullTitle: p.fullTitle || p.title, short: p.fullTitle ? p.title : '', sub: p.sub || p.upc || '', item: p.item || p.title, name: p.lineName || p.title, unit, base: unit, qty: 1, taxable: p.taxable !== false, cost: Number(p.cost) || 0 };
    S.lines.unshift(line);
  }
  save(); render(line.key); beepOk(); pulse(); hideNotice();
  if (unit === 0) toast('No price set for this item. Tap it to set one.');
  if (source === 'cache') refresh(p.id);
}
async function refresh(id) {
  try {
    const r = await api('/api/fresh?id=' + id);
    const p = r.ok && r.data.product; if (!p) return;
    const line = S.lines.find((l) => l.product_id === id); if (!line) return;
    const unit = Math.round((Number(p.price) || 0) * 100);
    if (unit !== line.base && line.unit === line.base) {
      line.unit = line.base = unit; save(); render(line.key);
      toast('Price updated to ' + fmt(unit) + ' from Syncro');
    }
  } catch { /* stay on the cached price */ }
}
function addMisc(name, pence) {
  const line = { key: 'm' + uid(), product_id: null, title: name, sub: 'Misc item', item: name, name, unit: pence, base: pence, qty: 1, taxable: true, cost: 0 };
  S.lines.unshift(line); save(); render(line.key); beepOk(); pulse();
}
function setQty(line, q) {
  if (q <= 0) S.lines = S.lines.filter((l) => l !== line); else line.qty = Math.min(999, q);
  save(); render();
}
function clearSale() { S.lines = []; save(); render(); hideNotice(); }

/* ---------------- render ---------------- */
let shownTotal = null;
function render(flashKey) {
  const ul = $('#lines'); ul.textContent = '';
  for (const l of S.lines) {
    const li = el('li', 'line' + (l.key === flashKey ? ' flash' : ''));
    const info = el('button', 'linfo'); info.type = 'button'; info.setAttribute('aria-label', 'Edit ' + l.title); info.onclick = () => showLine(l);
    const sub = el('span', 'lsub');
    if (l.unit < l.base) sub.append(el('span', 'cut', '−' + Math.round((1 - l.unit / l.base) * 100) + '%'), el('span', 'was', fmt(l.base)));
    else if (l.unit !== l.base) sub.append(el('span', 'was', fmt(l.base)));
    sub.append(document.createTextNode(fmt(l.unit) + (l.sub ? '  ·  ' + l.sub : '')));
    info.append(el('span', 'ltitle', l.title), sub);
    const q = el('div', 'lqty');
    const minus = el('button', null, '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'One fewer'); minus.onclick = () => setQty(l, l.qty - 1);
    const plus = el('button', null, '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'One more'); plus.onclick = () => setQty(l, l.qty + 1);
    q.append(minus, el('span', null, String(l.qty)), plus);
    const amt = el('button', 'lamt', fmt(l.unit * l.qty)); amt.type = 'button'; amt.setAttribute('aria-label', 'Edit line'); amt.onclick = () => showLine(l);
    li.append(info, q, amt);
    ul.append(li);
  }
  const t = total(), n = units();
  $('#empty').hidden = S.lines.length > 0;
  const tot = $('#total'); tot.textContent = fmt(t);
  if (shownTotal !== null && shownTotal !== t) { tot.classList.remove('tick'); void tot.offsetWidth; tot.classList.add('tick'); }
  shownTotal = t;
  $('#count').textContent = n === 1 ? '1 item' : n + ' items';
  $('#vat').textContent = n ? 'includes ' + fmt(vatIncluded()) + ' VAT' : 'nothing in the sale yet';
  const can = S.lines.length > 0 && !S.busy;
  $('#paycard').disabled = !can; $('#paycash').disabled = !can; $('#payother').disabled = !can;
  $('#clear').disabled = !S.lines.length;
  pushDisplay();
}
function renderQuick() {
  if (S.tab !== 'all' && !S.groups.some((g) => g.id === S.tab)) S.tab = 'all';
  const tabs = $('#qtabs'); tabs.textContent = '';
  const tab = (id, label, color) => {
    const b = el('button', 'qtab' + (S.tab === id ? ' on' : ''), label); b.type = 'button';
    if (color) b.dataset.c = color;
    b.onclick = () => { if (S.editing && id !== 'all' && S.tab === id) return showGroup(S.groups.find((g) => g.id === id)); S.tab = id; renderQuick(); };
    return b;
  };
  if (S.groups.length || S.editing) { tabs.append(tab('all', 'All')); S.groups.forEach((g) => tabs.append(tab(g.id, g.name, g.color))); }
  if (S.editing && S.groups.length < 8) { const add = el('button', 'qtab add', '+ Group'); add.type = 'button'; add.onclick = () => showGroup(null); tabs.append(add); }
  const g = $('#quick'); g.textContent = ''; g.classList.toggle('editing', S.editing);
  for (const p of S.quick.filter((k) => S.tab === 'all' || k.group === S.tab)) {
    const b = el('button', 'qk'); b.type = 'button'; b.dataset.id = p.id;
    const grp = S.groups.find((x) => x.id === p.group); if (grp) b.dataset.c = grp.color;
    b.append(el('b', null, p.title), el('i', null, fmt(Math.round(p.price * 100))));
    b.onclick = () => { if (dragMoved) return; if (S.editing) showKey(p); else addProduct(p, 'cache'); };
    if (S.editing) b.addEventListener('pointerdown', (e) => { if (e.button) return; drag = { el: b, x: e.clientX, y: e.clientY, active: false, pid: e.pointerId }; dragMoved = false; });
    g.append(b);
  }
  const edit = $('#qedit'); edit.hidden = !S.quick.length && !S.editing; edit.textContent = S.editing ? 'Done' : 'Edit';
  $('#quickhint').textContent = S.editing ? 'Drag a key to move it. Tap a key to change its group or remove it. Tap a selected group to rename it.'
    : (S.quick.length ? '' : 'Tap an item in the sale and pin it to keep it here.');
}
async function saveQuick() {
  try {
    const r = await api('/api/quickkeys', { method: 'PUT', body: JSON.stringify({ groups: S.groups, keys: S.quick.map((k) => ({ id: k.id, group: k.group || null })) }) });
    if (r.ok) { S.groups = r.data.groups; S.quick = r.data.keys; }
  } catch { /* keep what is on screen */ }
  renderQuick();
}
// Drag to reorder, for finger or mouse. The key follows the pointer and the others make room.
let drag = null, dragMoved = false;
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  let dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.active) {
    if (Math.hypot(dx, dy) < 8) return;
    drag.active = true; dragMoved = true; drag.el.classList.add('dragging');
    try { drag.el.setPointerCapture(drag.pid); } catch { /* older browsers */ }
  }
  e.preventDefault();
  const over = document.elementFromPoint(e.clientX, e.clientY); const target = over && over.closest ? over.closest('.qk') : null;
  if (target && target !== drag.el && target.parentNode === drag.el.parentNode) {
    drag.el.style.transform = '';
    const before = drag.el.getBoundingClientRect();
    const kids = [...target.parentNode.children];
    if (kids.indexOf(drag.el) < kids.indexOf(target)) target.after(drag.el); else target.before(drag.el);
    const after = drag.el.getBoundingClientRect();
    drag.x += after.left - before.left; drag.y += after.top - before.top;
    dx = e.clientX - drag.x; dy = e.clientY - drag.y;
  }
  drag.el.style.transform = `translate(${dx}px,${dy}px) scale(1.04)`;
}, { passive: false });
function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.active) return;
  d.el.classList.remove('dragging'); d.el.style.transform = '';
  const order = [...d.el.parentNode.children].map((c) => Number(c.dataset.id));
  const vis = new Set(order); const byId = new Map(S.quick.map((k) => [k.id, k])); let i = 0;
  S.quick = S.quick.map((k) => (vis.has(k.id) ? byId.get(order[i++]) : k));
  saveQuick();
  setTimeout(() => { dragMoved = false; }, 60);
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
function renderStatus() {
  const c = S.cfg, cat = $('#cat');
  renderCashier();
  if (!S.online) { cat.className = 'cat down'; cat.textContent = 'Offline'; return; }
  if (!c) return;
  const m = $('#mode');
  m.hidden = c.mode !== 'dry'; m.textContent = 'Practice';
  m.title = 'Practice mode: sales are not sent to Syncro';
  const k = c.catalogue;
  if (c.preview) { cat.className = 'cat'; cat.textContent = 'Preview'; return; }
  cat.className = 'cat' + (k.syncing ? ' busy' : (k.error && !k.count ? ' down' : ''));
  cat.textContent = k.syncing ? `Updating ${k.page}/${k.pages || '…'}` : (k.error && !k.count ? 'Catalogue unavailable' : k.count.toLocaleString('en-GB') + ' products');
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200); }
function hideNotice() { $('#notice').hidden = true; }
function notice(kind, build) { const n = $('#notice'); n.className = 'notice ' + kind; n.textContent = ''; build(n); n.hidden = false; }

/* ---------------- lookups ---------------- */
async function handleCode(raw, fast) {
  const code = String(raw || '').trim(); if (!code) return;
  try {
    const r = await api('/api/lookup?code=' + encodeURIComponent(code));
    if (r.ok) return addProduct(r.data.product, r.data.source);
    if (r.status === 404) {
      if (!fast && code.length < 8) { qEl.value = code; qEl.focus(); return runSearch(); }
      beepBad();
      return notice('bad', (n) => {
        const s = el('span'); s.append(document.createTextNode(r.data.error === 'disabled' ? 'That product is switched off in Syncro: ' : 'No product with barcode '), el('b', null, code));
        const box = el('div', 'nbtn');
        const add = el('button', null, 'Sell as misc item'); add.type = 'button'; add.onclick = () => { hideNotice(); showMisc('Item ' + code); };
        const x = el('button', null, 'Dismiss'); x.type = 'button'; x.onclick = hideNotice;
        box.append(add, x); n.append(s, box);
      });
    }
    beepBad(); notice('warn', (n) => n.append(el('span', null, 'Could not look that up: ' + (r.data.error || 'Syncro did not answer') + '. Scan it again.')));
  } catch (e) {
    if (e.locked) return;
    beepBad(); notice('warn', (n) => n.append(el('span', null, 'The till has lost its connection. Scan it again in a moment.')));
  }
}
let searchSeq = 0, results = [], sel = 0;
function drawResults(q) {
  const box = $('#results'); box.textContent = '';
  if (!results.length) box.append(el('li', 'none', 'Nothing matches “' + q + '”'));
  results.forEach((p, i) => {
    const li = el('li'); const b = el('button', i === sel ? 'sel' : ''); b.type = 'button';
    b.append(el('span', 'rt', p.title), el('span', 'rp', fmt(Math.round(p.price * 100))), el('span', 'rs', [p.sub, p.upc].filter(Boolean).join('  ·  ')));
    b.onclick = () => pick(p);
    li.append(b); box.append(li);
  });
  box.hidden = false;
  const s = box.querySelector('.sel'); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' });
}
async function runSearch() {
  const q = qEl.value.trim(); const box = $('#results');
  if (q.length < 2) { box.hidden = true; results = []; return; }
  const seq = ++searchSeq;
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    if (seq !== searchSeq) return;
    results = (r.ok && r.data.results) || [];
  } catch { results = []; }
  sel = 0; drawResults(q);
}
function pick(p) { addProduct(p, 'cache'); qEl.value = ''; $('#results').hidden = true; results = []; qEl.blur(); }
let searchTimer;
qEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 140); });

/* ---------------- scanner + keyboard ---------------- */
// A barcode scanner is a very fast keyboard that ends with Enter. Anything typed
// at scanner speed is a barcode, wherever the focus is. Anything typed at human
// speed lands in the search box so the cashier can see it.
let buf = '', bufTimer = null, sTimes = [];
const isPrintable = (e) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
function flushToSearch() { if (!buf) return; qEl.value = buf; buf = ''; qEl.focus(); runSearch(); }
const SHORTCUTS = { F3: () => { qEl.focus(); qEl.select(); }, F4: () => showMisc(''), F8: () => { if (S.lines.length) ensureCashier(showCard); }, F9: () => { if (S.lines.length) ensureCashier(showCash); } };

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const inSearch = t === qEl;
  const editable = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
  if (e.key === 'Escape') { if (S.overlay && S.overlay !== 'pin' && S.overlay !== 'busy') closeOverlay(); else { qEl.value = ''; $('#results').hidden = true; qEl.blur(); } return; }
  if (S.overlay && S.overlay !== 'done') { if (S.dialogKeys && !editable) S.dialogKeys(e); return; }   // dialogs own the keyboard
  if (SHORTCUTS[e.key] && !S.busy) { e.preventDefault(); if (S.overlay === 'done') closeOverlay(); SHORTCUTS[e.key](); return; }
  if (editable && !inSearch) return;

  if (inSearch) {
    if (isPrintable(e)) { const now = performance.now(); if (sTimes.length && now - sTimes[sTimes.length - 1] > 1500) sTimes = []; sTimes.push(now); }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && results.length) {
      e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length; drawResults(qEl.value.trim()); return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = qEl.value.trim(); const n = sTimes.length;
      const fast = n >= 4 && (sTimes[n - 1] - sTimes[0]) / (n - 1) < 45;
      sTimes = [];
      if (!v) return;
      if (fast || /^\d{8,}$/.test(v)) { qEl.value = ''; $('#results').hidden = true; qEl.blur(); handleCode(v, fast); }
      else if (results.length) pick(results[sel] || results[0]);
    }
    return;
  }
  if (e.key === 'Enter') {
    if (!buf) return;
    e.preventDefault(); clearTimeout(bufTimer);
    const code = buf; buf = '';
    if (S.overlay === 'done') closeOverlay();
    handleCode(code, true);
    return;
  }
  if (!isPrintable(e)) return;
  if (S.overlay === 'done' && !buf && !/[0-9A-Za-z]/.test(e.key)) return;
  e.preventDefault();
  buf += e.key;
  clearTimeout(bufTimer);
  bufTimer = setTimeout(() => { if (S.overlay) { buf = ''; return; } flushToSearch(); }, 120);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.searchbox')) $('#results').hidden = true; });

/* ---------------- dialogs ---------------- */
function openOverlay(name, build) {
  const p = $('#panel'); p.textContent = ''; p.className = 'panel'; S.dialogKeys = null; build(p);
  S.overlay = name; $('#overlay').hidden = false;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const first = p.querySelector('[data-focus]'); if (first) setTimeout(() => first.focus(), 30);
}
function closeOverlay() { const was = S.overlay; S.overlay = null; S.dialogKeys = null; $('#overlay').hidden = true; $('#panel').textContent = ''; if (was === 'done') pushDisplay(); }
$('#overlay').addEventListener('click', (e) => { if (e.target === $('#overlay') && S.overlay !== 'pin' && S.overlay !== 'busy') closeOverlay(); });
const btn = (text, cls, fn) => { const b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; };
const parseMoney = (v) => { const n = Number(String(v).replace(/[£,\s]/g, '')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
const svg = (markup) => { const d = el('div'); d.innerHTML = markup; return d.firstElementChild; };  // static markup only
const TICK = '<svg class="tickmark" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29"/><path d="M19 33l9 9 17-19"/></svg>';

function showLine(l) {
  openOverlay('line', (p) => {
    p.append(el('h2', null, l.title), el('p', null, l.sub || ''));
    const fq = el('label', 'field', 'Quantity'); const iq = el('input'); iq.type = 'number'; iq.min = '1'; iq.max = '999'; iq.step = '1'; iq.inputMode = 'numeric'; iq.value = l.qty; iq.id = 'line-qty'; fq.append(iq);
    const fp = el('label', 'field', 'Price each, inc. VAT'); const ip = el('input'); ip.type = 'text'; ip.inputMode = 'decimal'; ip.value = (l.unit / 100).toFixed(2); ip.id = 'line-price'; fp.append(ip);
    const chips = el('div', 'chips');
    for (const pc of [10, 20, 50]) chips.append(btn(pc + '% off', null, () => { ip.value = (Math.round(l.base * (100 - pc) / 100) / 100).toFixed(2); }));
    chips.append(btn('List price', null, () => { ip.value = (l.base / 100).toFixed(2); }));
    p.append(fq, fp, chips);
    let iname = null;
    if (l.product_id) {
      const fn = el('label', 'field', 'Short name on the till'); iname = el('input'); iname.type = 'text'; iname.maxLength = 60; iname.id = 'line-short';
      iname.value = l.short || ''; iname.placeholder = (l.fullTitle || l.title).slice(0, 40); fn.append(iname); p.append(fn);
    }
    const apply = async () => {
      const q = Math.floor(Number(iq.value)); const u = parseMoney(ip.value);
      if (u != null) l.unit = u;
      if (iname && iname.value.trim() !== (l.short || '')) await renameProduct(l, iname.value.trim());
      closeOverlay(); setQty(l, Number.isFinite(q) ? q : l.qty);
    };
    const r1 = el('div', 'row');
    if (l.product_id) {
      const pinned = S.quick.some((k) => k.id === l.product_id);
      r1.append(btn(pinned ? 'Unpin quick key' : 'Pin as quick key', null, async () => {
        if (pinned) S.quick = S.quick.filter((k) => k.id !== l.product_id);
        else S.quick.push({ id: l.product_id, title: l.title, price: l.base / 100, group: S.tab !== 'all' ? S.tab : null });
        await saveQuick(); toast(pinned ? 'Removed from quick keys' : 'Added to quick keys');
        apply();
      }));
    }
    r1.append(btn('Remove', 'danger', () => { closeOverlay(); setQty(l, 0); }));
    const r2 = el('div', 'row'); r2.append(btn('Done', 'go card', apply));
    p.append(r1, r2);
    [iq, ip, iname].filter(Boolean).forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }));
  });
}
async function renameProduct(l, name) {
  try {
    const r = await api('/api/names', { method: 'PUT', body: JSON.stringify({ id: l.product_id, name }) });
    if (!r.ok) return toast('Could not save the short name');
    const pr = r.data.product;
    l.title = pr.title; l.fullTitle = pr.fullTitle || pr.title; l.short = name;
    const k = S.quick.find((x) => x.id === l.product_id); if (k) { k.title = pr.title; renderQuick(); }
    save();
  } catch { toast('Could not save the short name'); }
}
function showKey(k) {
  openOverlay('key', (p) => {
    p.append(el('h2', null, k.title), el('p', null, 'Quick key'));
    if (S.groups.length) {
      p.append(el('span', 'label', 'Group'));
      const chips = el('div', 'chips');
      const mk = (id, label, color) => { const b = btn(label, (k.group || null) === id ? 'on' : null, async () => { k.group = id; closeOverlay(); await saveQuick(); }); if (color) b.dataset.c = color; return b; };
      chips.append(mk(null, 'No group')); S.groups.forEach((g) => chips.append(mk(g.id, g.name, g.color)));
      p.append(chips);
    }
    const r = el('div', 'row');
    r.append(btn('Remove key', 'danger', async () => { S.quick = S.quick.filter((x) => x.id !== k.id); closeOverlay(); await saveQuick(); }), btn('Done', 'go card', closeOverlay));
    p.append(r);
  });
}
function showGroup(g) {
  const colours = (S.cfg && S.cfg.colours) || ['blue', 'green', 'amber', 'red', 'violet', 'slate'];
  let colour = g ? g.color : colours[S.groups.length % colours.length];
  openOverlay('group', (p) => {
    p.append(el('h2', null, g ? 'Edit group' : 'New group'), el('p', null, 'Groups sort quick keys into tabs, each with its own colour.'));
    const fn = el('label', 'field', 'Name'); const iname = el('input'); iname.type = 'text'; iname.maxLength = 24; iname.id = 'group-name'; iname.value = g ? g.name : ''; iname.placeholder = 'Repairs'; iname.setAttribute('data-focus', ''); fn.append(iname);
    const sw = el('div', 'swatches');
    const draw = () => { sw.textContent = ''; colours.forEach((c) => { const b = btn('', 'swatch' + (c === colour ? ' on' : ''), () => { colour = c; draw(); }); b.dataset.c = c; b.setAttribute('aria-label', c); sw.append(b); }); };
    draw();
    const err = el('div', 'err'); err.hidden = true;
    const go = async () => {
      const name = iname.value.trim();
      if (!name) { err.textContent = 'Give the group a name'; err.hidden = false; return; }
      if (g) { g.name = name; g.color = colour; } else { const id = 'g' + uid().replace(/[^A-Za-z0-9]/g, '').slice(0, 10); S.groups.push({ id, name, color: colour }); S.tab = id; }
      closeOverlay(); await saveQuick();
    };
    const r = el('div', 'row');
    if (g) r.append(btn('Delete group', 'danger', async () => { S.groups = S.groups.filter((x) => x.id !== g.id); S.quick.forEach((k) => { if (k.group === g.id) k.group = null; }); S.tab = 'all'; closeOverlay(); await saveQuick(); }));
    else r.append(btn('Cancel', null, closeOverlay));
    r.append(btn('Save', 'go card', go));
    p.append(fn, el('span', 'label', 'Colour'), sw, err, r);
    iname.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  });
}
function showMisc(defaultName) {
  openOverlay('misc', (p) => {
    p.append(el('h2', null, 'Misc item'), el('p', null, 'For anything without a barcode or a product record.'));
    const fn = el('label', 'field', 'Description'); const iname = el('input'); iname.type = 'text'; iname.value = defaultName || ''; iname.placeholder = 'Screen protector fitting'; iname.id = 'misc-name'; iname.maxLength = 120; fn.append(iname);
    const fp = el('label', 'field', 'Price, inc. VAT'); const ip = el('input'); ip.type = 'text'; ip.inputMode = 'decimal'; ip.placeholder = '0.00'; ip.id = 'misc-price'; ip.setAttribute('data-focus', ''); fp.append(ip);
    const err = el('div', 'err'); err.hidden = true;
    const go = () => {
      const pence = parseMoney(ip.value); const name = iname.value.trim() || 'Misc item';
      if (pence == null || ip.value.trim() === '') { err.textContent = 'Enter a price, like 9.99'; err.hidden = false; return; }
      closeOverlay(); addMisc(name, pence);
    };
    const r = el('div', 'row'); r.append(btn('Cancel', null, closeOverlay), btn('Add to sale', 'go card', go));
    p.append(fn, fp, err, r);
    [iname, ip].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }));
  });
}
function showCard() {
  const t = total();
  openOverlay('card', (p) => {
    p.append(el('h2', null, 'Card payment'), el('div', 'big', fmt(t)), el('p', 'center', 'Take this on the card machine, then confirm once it is approved.'));
    const r = el('div', 'row'); r.append(btn('Cancel', null, closeOverlay), btn('Payment approved', 'go card', () => submit(S.cfg.cardMethod, null)));
    p.append(r);
  });
}
function showCash() {
  const t = total(); let tendered = '';
  openOverlay('cash', (p) => {
    p.append(el('h2', null, 'Cash payment'));
    const due = el('div', 'sum'); due.append(el('span', null, 'To pay'), el('b', null, fmt(t)));
    const given = el('div', 'sum'); const gv = el('b', null, '—'); given.append(el('span', null, 'Cash given'), gv);
    const change = el('div', 'sum strong'); const cv = el('b', null, '—'); const cl = el('span', null, 'Change'); change.append(cl, cv);
    const chips = el('div', 'chips'); const pad = el('div', 'keypad');
    const go = btn('Complete sale', 'go', () => submit(S.cfg.cashMethod, parseMoney(tendered)));
    const upd = () => {
      const pence = tendered === '' ? null : parseMoney(tendered);
      gv.textContent = pence == null ? '—' : fmt(pence);
      const ok = pence != null && pence >= t;
      change.classList.toggle('short', pence != null && !ok);
      cl.textContent = pence != null && !ok ? 'Still to pay' : 'Change';
      cv.textContent = pence == null ? '—' : fmt(ok ? pence - t : t - pence);
      go.disabled = !ok;
    };
    const press = (k) => {
      if (k === '⌫') tendered = tendered.slice(0, -1);
      else if (k === '.') { if (!tendered.includes('.')) tendered += tendered ? '.' : '0.'; }
      else if (!/\.\d\d$/.test(tendered) && tendered.length < 8) tendered += k;
      upd();
    };
    const opts = new Set([t]);
    for (const step of [500, 1000, 2000, 5000]) { const up = Math.ceil(t / step) * step; if (up > t) opts.add(up); }
    [...opts].sort((a, b) => a - b).slice(0, 5).forEach((v, i) => chips.append(btn(i === 0 ? 'Exact' : fmt(v).replace('.00', ''), null, () => { tendered = (v / 100).toFixed(2); upd(); })));
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']) pad.append(btn(k, null, () => press(k)));
    const r = el('div', 'row'); r.append(btn('Cancel', null, closeOverlay), go);
    p.append(due, given, change, chips, pad, r);
    upd();
    // Keyboard entry for the PC. A scanner fired by mistake types digits far faster
    // than a person can, so a burst like that is thrown away rather than taken as cash.
    let last = 0, before = '', blockUntil = 0;
    S.dialogKeys = (e) => {
      const now = performance.now(); const gap = now - last;
      const isKey = /^[0-9.]$/.test(e.key) || e.key === 'Backspace' || e.key === 'Enter';
      if (!isKey) return;
      e.preventDefault();
      if (now < blockUntil) { blockUntil = now + 400; last = now; return; }
      if (gap < 25 && e.key !== 'Backspace') { tendered = before; upd(); blockUntil = now + 400; last = now; return; }
      last = now;
      if (e.key === 'Enter') { if (!go.disabled && gap > 150) go.click(); return; }
      before = tendered;
      press(e.key === 'Backspace' ? '⌫' : e.key);
    };
  });
}
function showOther() {
  const skip = new Set([S.cfg.cardMethod, S.cfg.cashMethod]);
  const list = (S.cfg.methods || []).filter((m) => !skip.has(m));
  openOverlay('other', (p) => {
    p.append(el('h2', null, 'Other payment'), el('div', 'big', fmt(total())), el('p', 'center', list.length ? 'Choose how this sale was paid.' : 'No other payment methods are set up in Syncro.'));
    const box = el('div', 'methods'); list.forEach((m) => box.append(btn(m, null, () => submit(m, null))));
    const r = el('div', 'row'); r.append(btn('Cancel', null, closeOverlay));
    p.append(box, r);
  });
}
async function submit(method, tenderedPence) {
  if (S.busy) return;
  const t = total();
  const body = {
    sale_id: S.saleId, total: t, method, print: $('#receipt').checked, staff_id: S.cashier ? S.cashier.id : null,
    lines: S.lines.slice().reverse().map((l) => ({ product_id: l.product_id, item: l.item, name: l.name, qty: l.qty, unit: l.unit, taxable: l.taxable, cost: l.cost })),
  };
  S.busy = true; render();
  openOverlay('busy', (p) => { p.append(el('div', 'spinner'), el('h2', 'center', 'Completing sale'), el('p', 'center', 'One moment.')); });
  let r;
  try { r = await api('/api/sale', { method: 'POST', body: JSON.stringify(body) }); }
  catch (e) {
    S.busy = false; render();
    if (e.locked) return;
    return openOverlay('error', (p) => {
      p.append(el('h2', null, 'The sale did not go through'), el('div', 'err', 'The till could not reach its server. The sale is still here, so try again. It will not be recorded twice.'));
      const row = el('div', 'row'); row.append(btn('Back to sale', null, closeOverlay)); p.append(row);
    });
  }
  S.busy = false;
  const d = r.data || {};
  if (r.ok && d.ok) {
    const change = tenderedPence != null ? tenderedPence - t : null;
    S.lines = []; save(); render(); chime();
    pushDisplay({ state: 'paid', lines: [], total: t, vat: 0, change, method });
    return openOverlay('done', (p) => {
      p.append(svg(TICK), el('h2', 'center', d.dry ? 'Practice sale complete' : 'Sale complete'));
      p.append(el('p', 'center', (d.dry ? 'Nothing was sent to Syncro.' : 'Invoice #' + d.invoice.number + ', paid by ' + method) + (d.staff ? ' Served by ' + d.staff + '.' : '')));
      if (change != null) { p.append(el('p', 'center label', 'Change due')); p.append(el('div', 'big change', fmt(change))); }
      else p.append(el('div', 'big', fmt(t)));
      if (d.printError) p.append(el('div', 'err', 'The receipt did not print: ' + d.printError));
      const row = el('div', 'row'); row.append(btn('Next sale', 'go card', closeOverlay));
      p.append(row, el('p', 'center', 'Or scan the next item.'));
    });
  }
  render();
  openOverlay('error', (p) => {
    p.append(el('h2', null, 'The sale did not complete'));
    if (d.invoice && d.invoice.number) {
      const what = d.stage === 'payment' ? 'recording the payment' : 'adding the items';
      p.append(el('div', 'err', 'Invoice #' + d.invoice.number + ' was created in Syncro, but ' + what + ' failed: ' + (d.error || 'unknown error') + '. Open that invoice in Syncro to finish or delete it. Pressing pay again will not create a second invoice.'));
    } else p.append(el('div', 'err', (d.error || 'Something went wrong') + '. Nothing was created in Syncro.'));
    const row = el('div', 'row'); row.append(btn('Back to sale', null, closeOverlay)); p.append(row);
  });
}
function showPin() {
  if (S.overlay === 'pin') return;
  let pin = '';
  openOverlay('pin', (p) => {
    p.append(el('h2', 'center', 'Till locked'), el('p', 'center', 'Enter the till PIN.'));
    const dots = el('div', 'pin-dots'); const err = el('div', 'err'); err.hidden = true;
    const draw = () => { dots.textContent = ''; for (let i = 0; i < Math.max(4, pin.length); i++) dots.append(el('i', i < pin.length ? 'on' : '')); };
    const go = async () => {
      if (!pin) return;
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
      if (res.ok) { closeOverlay(); boot(); return; }
      let m = 'Wrong PIN'; try { m = (await res.json()).error || m; } catch { /* keep default */ }
      err.textContent = m; err.hidden = false; pin = ''; draw();
    };
    const press = (k) => { if (k === '⌫') pin = pin.slice(0, -1); else if (k === 'OK') return go(); else if (pin.length < 12) pin += k; draw(); };
    const pad = el('div', 'keypad');
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK']) pad.append(btn(k, null, () => press(k)));
    p.append(dots, err, pad); draw();
    S.dialogKeys = (e) => { if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); } else if (e.key === 'Backspace') { e.preventDefault(); press('⌫'); } else if (e.key === 'Enter') { e.preventDefault(); go(); } };
  });
}

/* ---------------- customer display ---------------- */
const displayState = () => ({ state: S.lines.length ? 'sale' : 'idle', lines: S.lines.slice().reverse().map((l) => ({ title: l.title, qty: l.qty, unit: l.unit, total: l.unit * l.qty })), total: total(), vat: vatIncluded(), change: null, method: '' });
let dispTimer;
function pushDisplay(st) {
  clearTimeout(dispTimer);
  dispTimer = setTimeout(() => { api('/api/display', { method: 'PUT', body: JSON.stringify(st || displayState()) }).catch(() => {}); }, st ? 0 : 120);
}
function openDisplay() {
  if (!PREVIEW) { closeOverlay(); window.open('display.html', 'tm-display', 'popup,width=1024,height=640'); return; }
  openOverlay('custview', (p) => {   // the preview has no second window, so show it in place
    p.classList.add('wide');
    p.append(el('h2', null, 'Customer display'), el('p', null, 'This is what the customer sees on the second screen for the sale as it stands now.'));
    const frame = el('div', 'cvframe'); const box = el('div', 'cv'); frame.append(box); p.append(frame);
    window.CustomerView.render(box, displayState());
    const r = el('div', 'row'); r.append(btn('Close', null, closeOverlay)); p.append(r);
  });
}

/* ---------------- staff ---------------- */
const GEAR = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const staffList = () => (S.cfg && S.cfg.staff) || [];
function renderCashier() {
  const b = $('#cashier'); const list = staffList();
  if (S.cashier && !list.some((s) => s.id === S.cashier.id)) { S.cashier = null; store.set('till.cashier', null); }
  b.hidden = !list.length;
  b.textContent = S.cashier ? S.cashier.name : 'Sign in'; b.classList.toggle('none', !S.cashier);
}
function setCashier(c) { S.cashier = c; store.set('till.cashier', c); renderCashier(); }
function ensureCashier(next) { if (!staffList().length || S.cashier) return next(); showStaff(next); }
function showStaff(next) {
  openOverlay('staff', (p) => {
    p.append(el('h2', null, 'Who is serving?'), el('p', null, next ? 'Sign in to take this payment.' : 'Every sale records who made it.'));
    const grid = el('div', 'people');
    staffList().forEach((s) => grid.append(btn(s.name, S.cashier && S.cashier.id === s.id ? 'on' : null, () => (s.hasPin ? askPin(s, next) : signIn(s, '', next)))));
    p.append(grid);
    const r = el('div', 'row');
    if (S.cashier) r.append(btn('Sign out', null, () => { setCashier(null); closeOverlay(); }));
    r.append(btn('Cancel', null, closeOverlay)); p.append(r);
  });
}
async function signIn(s, pin, next, onFail) {
  let r;
  try { r = await api('/api/staff/signin', { method: 'POST', body: JSON.stringify({ id: s.id, pin }) }); } catch { return onFail ? onFail('No connection') : toast('No connection'); }
  if (!r.ok) return onFail ? onFail(r.data.error || 'Wrong PIN') : toast(r.data.error || 'Could not sign in');
  setCashier(r.data.staff); closeOverlay();
  if (next) next(); else toast('Signed in as ' + r.data.staff.name);
}
function askPin(s, next) {
  let pin = '';
  openOverlay('staffpin', (p) => {
    p.append(el('h2', 'center', s.name), el('p', 'center', 'Enter your PIN.'));
    const dots = el('div', 'pin-dots'); const err = el('div', 'err'); err.hidden = true;
    const draw = () => { dots.textContent = ''; for (let i = 0; i < Math.max(4, pin.length); i++) dots.append(el('i', i < pin.length ? 'on' : '')); };
    const go = () => { if (pin) signIn(s, pin, next, (m) => { err.textContent = m; err.hidden = false; pin = ''; draw(); }); };
    const press = (k) => { if (k === '⌫') pin = pin.slice(0, -1); else if (k === 'OK') return go(); else if (pin.length < 8) pin += k; draw(); };
    const pad = el('div', 'keypad');
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK']) pad.append(btn(k, null, () => press(k)));
    const r = el('div', 'row'); r.append(btn('Back', null, () => showStaff(next)));
    p.append(dots, err, pad, r); draw();
    S.dialogKeys = (e) => { if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); } else if (e.key === 'Backspace') { e.preventDefault(); press('⌫'); } else if (e.key === 'Enter') { e.preventDefault(); go(); } };
  });
}
function showSettings() {
  openOverlay('settings', (p) => {
    p.append(el('h2', null, 'Till settings'));
    const st = el('div', 'sect'); st.append(el('h3', null, 'Staff'));
    const list = staffList();
    if (!list.length) st.append(el('p', null, 'Add the people who use this till. Once anyone is listed, a sale cannot be paid until someone signs in.'));
    list.forEach((s) => {
      const row = el('div', 'srow'); const name = el('span', null, s.name); name.append(el('small', null, s.hasPin ? 'PIN set' : 'no PIN'));
      row.append(name, btn('Remove', null, async () => { try { const r = await api('/api/staff?id=' + encodeURIComponent(s.id), { method: 'DELETE' }); if (r.ok) { S.cfg.staff = r.data.staff; renderCashier(); showSettings(); } } catch { toast('Could not remove'); } }));
      st.append(row);
    });
    const add = el('div', 'inline'); const iname = el('input'); iname.type = 'text'; iname.placeholder = 'Name'; iname.maxLength = 40; iname.id = 'staff-name'; iname.setAttribute('aria-label', 'Name');
    const ipin = el('input'); ipin.type = 'text'; ipin.inputMode = 'numeric'; ipin.placeholder = 'PIN (optional)'; ipin.maxLength = 8; ipin.id = 'staff-pin'; ipin.setAttribute('aria-label', 'PIN, optional'); ipin.autocomplete = 'off';
    const err = el('div', 'err'); err.hidden = true;
    const go = async () => {
      try {
        const r = await api('/api/staff', { method: 'POST', body: JSON.stringify({ name: iname.value, pin: ipin.value }) });
        if (!r.ok) { err.textContent = r.data.error || 'Could not add'; err.hidden = false; return; }
        S.cfg.staff = r.data.staff; renderCashier(); showSettings();
      } catch { err.textContent = 'No connection'; err.hidden = false; }
    };
    add.append(iname, ipin, btn('Add', null, go)); st.append(add, err);
    [iname, ipin].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }));
    const cd = el('div', 'sect'); cd.append(el('h3', null, 'Customer display'), el('p', null, PREVIEW ? 'Shows the items and the total to the customer on a second screen.' : 'Opens in its own window. Drag it to the screen facing the customer and make it full screen. A tablet can open the same page from the till’s address.'));
    const cr = el('div', 'srow'); cr.append(el('span', null, 'Second screen'), btn(PREVIEW ? 'Preview it' : 'Open display', null, openDisplay)); cd.append(cr);
    const r = el('div', 'row'); r.append(btn('Done', 'go card', closeOverlay));
    p.append(st, cd, r);
  });
}

/* ---------------- wiring ---------------- */
$('#paycard').onclick = () => ensureCashier(showCard);
$('#paycash').onclick = () => ensureCashier(showCash);
$('#payother').onclick = () => ensureCashier(showOther);
$('#cashier').onclick = () => showStaff(null);
$('#settings').onclick = showSettings;
$('#settings').append(svg(GEAR));
$('#qedit').onclick = () => { S.editing = !S.editing; renderQuick(); };
$('#misc').onclick = () => showMisc('');
$('#clear').onclick = () => {
  if (!S.lines.length) return;
  openOverlay('clear', (p) => {
    p.append(el('h2', null, 'Clear this sale?'), el('p', null, (units() === 1 ? '1 item' : units() + ' items') + ', ' + fmt(total()) + '. This cannot be undone.'));
    const r = el('div', 'row'); r.append(btn('Keep it', null, closeOverlay), btn('Clear sale', 'danger', () => { closeOverlay(); clearSale(); }));
    p.append(r);
  });
};
const rc = $('#receipt'); rc.checked = store.get('till.receipt', true); rc.onchange = () => store.set('till.receipt', rc.checked);

/* theme: follows the device unless the cashier picks one */
const THEMES = ['auto', 'light', 'dark'];
const THEME_ICON = {
  auto: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3"/></g></svg>',
  dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z" fill="currentColor"/></svg>',
};
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const b = $('#theme'); b.textContent = ''; b.append(svg(THEME_ICON[t])); b.title = 'Theme: ' + t;
}
if (!PREVIEW) {   // in the preview the page follows the viewer's own theme
  let theme = store.get('till.theme', 'auto'); if (!THEMES.includes(theme)) theme = 'auto';
  $('#theme').hidden = false; applyTheme(theme);
  $('#theme').onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; store.set('till.theme', theme); applyTheme(theme); };
}
const tickClock = () => { $('#clock').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
tickClock(); setInterval(tickClock, 15000);

let wake = null;
async function keepAwake() { try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { /* not allowed */ } }
document.addEventListener('pointerdown', keepAwake, { once: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

let pollTimer;
async function loadState() {
  try { const r = await api('/api/state'); if (r.ok) { S.cfg = r.data; S.online = true; } }
  catch (e) { if (!e.locked) S.online = false; }
  renderStatus();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(loadState, !S.online ? 5000 : (S.cfg && S.cfg.catalogue.syncing ? 4000 : 60000));
}
async function boot() {
  await loadState();
  try { const r = await api('/api/quickkeys'); if (r.ok) { S.groups = r.data.groups || []; S.quick = r.data.keys || []; renderQuick(); } } catch { /* later */ }
}
render(); renderQuick(); boot();
})();
