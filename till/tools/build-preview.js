'use strict';
/*
 * Builds a single-file preview of the till screen that runs without the server.
 * Product lookups go through the viewer's Syncro connector; sales are practice only,
 * and staff, quick keys and short names are kept in that browser.
 * Usage: node tools/build-preview.js <output.html>
 */
const fs = require('fs'); const path = require('path');
const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8')
  .replace(/url\(fonts\/([\w.-]+\.woff2)\)/g, (m, f) => 'url(data:font/woff2;base64,' + fs.readFileSync(path.join(pub, 'fonts', f)).toString('base64') + ')');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const view = fs.readFileSync(path.join(pub, 'customer-view.js'), 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script src="customer-view.js">'));

const adapter = String.raw`
(() => {
const SERVER = 'Syncro';
const mcpP = (window.claude && window.claude.use) ? window.claude.use('mcp').catch(() => null) : Promise.resolve(null);
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } } };
const COLOURS = ['blue', 'green', 'amber', 'red', 'violet', 'slate'];
const byId = new Map(Object.entries(ls.get('till.preview.products', {})).map(([k, v]) => [Number(k), v]));
const byCode = new Map();
const codeLike = (s) => !/\s/.test(s) || (/^[A-Z0-9\-_.\/ ]{1,24}$/.test(s) && /\d/.test(s));
function slim(p) {
  const rawName = String(p.name || '').trim(); const rawDesc = String(p.description || '').trim();
  let title = rawName, sub = '';
  if (rawDesc && rawDesc.length <= 160 && codeLike(rawName)) { title = rawDesc; sub = rawName; }
  else if (rawDesc) { sub = rawDesc.replace(/\s+/g, ' ').slice(0, 90); }
  const s = { id: p.id, title: title || 'Product ' + p.id, sub, item: rawName.slice(0, 255), lineName: (rawDesc || rawName).slice(0, 1000),
    price: Number(p.price_retail) || 0, cost: Number(p.price_cost) || 0, taxable: p.taxable !== false, upc: String(p.upc_code || '').trim(),
    category: p.product_category || '', qty: Number(p.quantity) || 0, stock: !!p.maintain_stock, serialized: !!p.serialized, disabled: !!p.disabled };
  byId.set(s.id, s); return s;
}
const out = (s) => { if (!s) return null; const short = ls.get('till.preview.names', {})[s.id]; return short ? { ...s, title: short, fullTitle: s.title } : { ...s }; };
function codeVariants(raw) {
  const c = String(raw || '').replace(/\s+/g, ''); const set = new Set(); if (!c) return [];
  set.add(c); const nz = c.replace(/^0+/, ''); if (nz) set.add(nz); if (/^\d{12}$/.test(c)) set.add('0' + c); return [...set];
}
const FIX = { server_not_connected: 'Syncro is not connected. Add it in claude.ai Settings, Connectors', needs_reauth: 'Syncro needs reconnecting in claude.ai Settings, Connectors', not_in_manifest: 'Syncro is not allowed for this page', blocked_by_policy: 'This Syncro tool is blocked by policy', approval_required: 'Syncro needs your approval. Try again and allow it', selection_required: 'Choose which Syncro connector to use when asked, then try again' };
async function call(tool, input) {
  const m = await mcpP;
  if (!m) throw new Error('Open this preview in claude.ai to look products up in Syncro');
  try { const r = await m.callTool(SERVER, tool, input); return (r && r.payload) || {}; }
  catch (e) { throw new Error(FIX[e && e.code] || (e && e.message) || 'Syncro did not answer'); }
}
const quick = () => { const q = ls.get('till.preview.quick2', { groups: [], keys: [] }); return { groups: q.groups || [], keys: (q.keys || []).map((k) => { const p = out(byId.get(k.id)); return p ? { ...p, group: k.group || null } : null; }).filter(Boolean) }; };
const staff = () => ls.get('till.preview.staff', []);
const pubStaff = () => staff().map((s) => ({ id: s.id, name: s.name, hasPin: !!s.pin }));
let n = 0;
window.TILL_BACKEND = async (path, opts) => {
  const u = new URL(path, 'http://x'); const p = u.pathname; const method = (opts && opts.method) || 'GET';
  const body = () => { try { return JSON.parse((opts && opts.body) || '{}'); } catch { return {}; } };
  const ok = (data) => ({ ok: true, status: 200, data }); const fail = (status, data) => ({ ok: false, status, data });
  try {
    if (p === '/api/state') return ok({ mode: 'dry', preview: true, shop: 'Technical Merritt', catalogue: { count: 0, syncing: false, syncedAt: 0, page: 0, pages: 0, error: null }, cardMethod: 'Dojo card', cashMethod: 'Cash', methods: ['Dojo card', 'Dojo (Ltd)', 'GoCardless', 'Bank Transfer (Monzo)', 'Quick', 'Cash', 'Store Credit'], staff: pubStaff(), colours: COLOURS });
    if (p === '/api/lookup') {
      const code = u.searchParams.get('code') || ''; const variants = codeVariants(code);
      for (const v of variants) if (byCode.has(v)) return ok({ product: out(byCode.get(v)), source: 'cache' });
      for (const v of variants) {
        const s = await call('search', { query: v });
        for (const r of (s.results || [])) {
          const t = r && r.table; if (!t || t._type !== 'product') continue;
          const upc = String((t._source && t._source.table && t._source.table.upc_code) || '').trim();
          if (!variants.some((x) => codeVariants(upc).includes(x))) continue;
          const d = await call('get_product', { product_id: Number(t._id) });
          if (!d.product) continue;
          const prod = slim(d.product);
          if (prod.disabled) return fail(404, { error: 'disabled', code });
          for (const x of variants) byCode.set(x, prod);
          return ok({ product: out(prod), source: 'syncro' });
        }
      }
      return fail(404, { error: 'not_found', code });
    }
    if (p === '/api/fresh') return ok({ product: null });
    if (p === '/api/search') {
      const d = await call('list_products', { query: u.searchParams.get('q') || '', per_page: 12 });
      return ok({ results: (d.products || []).map(slim).filter((x) => !x.disabled).map(out) });
    }
    if (p === '/api/quickkeys') {
      if (method === 'PUT') {
        const b = body(); const groups = (b.groups || []).slice(0, 8); const gids = new Set(groups.map((g) => g.id));
        const keys = (b.keys || []).map((k) => ({ id: Number(k.id), group: gids.has(k.group) ? k.group : null })).filter((k) => byId.has(k.id));
        ls.set('till.preview.quick2', { groups, keys });
        const keep = {}; keys.forEach((k) => { keep[k.id] = byId.get(k.id); }); ls.set('till.preview.products', keep);
      }
      return ok(quick());
    }
    if (p === '/api/names' && method === 'PUT') {
      const b = body(); const id = Number(b.id); const names = ls.get('till.preview.names', {});
      const name = String(b.name || '').trim().slice(0, 60);
      if (name) names[id] = name; else delete names[id];
      ls.set('till.preview.names', names);
      return ok({ product: out(byId.get(id)) });
    }
    if (p === '/api/staff' && method === 'POST') {
      const b = body(); const name = String(b.name || '').trim().slice(0, 40); const pin = String(b.pin || '');
      if (!name) return fail(400, { error: 'Enter a name' });
      if (pin && !/^\d{4,8}$/.test(pin)) return fail(400, { error: 'A PIN is 4 to 8 digits' });
      const list = staff(); list.push({ id: 's' + Date.now().toString(36), name, pin }); ls.set('till.preview.staff', list);
      return ok({ staff: pubStaff() });
    }
    if (p === '/api/staff' && method === 'DELETE') { ls.set('till.preview.staff', staff().filter((s) => s.id !== u.searchParams.get('id'))); return ok({ staff: pubStaff() }); }
    if (p === '/api/staff/signin') {
      const b = body(); const s = staff().find((x) => x.id === b.id);
      if (!s) return fail(404, { error: 'Unknown member of staff' });
      if (s.pin && s.pin !== String(b.pin || '')) return fail(401, { error: 'Wrong PIN' });
      return ok({ ok: true, staff: { id: s.id, name: s.name } });
    }
    if (p === '/api/display') return ok({ ok: true });
    if (p === '/api/sale') {
      const b = body(); const list = staff(); const who = list.find((s) => s.id === b.staff_id);
      if (list.length && !who) return fail(400, { error: 'Sign in before taking a payment' });
      return ok({ ok: true, dry: true, staff: who ? who.name : '', invoice: { id: null, number: 'PRACTICE-' + String(++n).padStart(3, '0') }, steps: [] });
    }
    return fail(404, { error: 'Not found' });
  } catch (e) { return fail(502, { error: e.message }); }
};
})();`;

const page = `<title>TM Till</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}
body{padding:0}
</style>
${body}<script>${adapter}
</script>
<script>
${view}
</script>
<script>
${app}
</script>
`;
fs.writeFileSync(process.argv[2], page);
console.log('wrote', process.argv[2], page.length, 'bytes');
