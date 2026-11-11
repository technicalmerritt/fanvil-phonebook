'use strict';
/*
 * Builds a single-file preview of the till screen that runs without the server.
 * Product lookups go through the viewer's Syncro connector; sales are practice only.
 * Usage: node tools/build-preview.js <output.html>
 */
const fs = require('fs'); const path = require('path');
const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script src="app.js">'));

const adapter = String.raw`
(() => {
const SERVER = 'Syncro';
const mcpP = (window.claude && window.claude.use) ? window.claude.use('mcp').catch(() => null) : Promise.resolve(null);
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } } };
const byId = new Map(); const byCode = new Map();
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
function codeVariants(raw) {
  const c = String(raw || '').replace(/\s+/g, ''); const out = new Set(); if (!c) return [];
  out.add(c); const nz = c.replace(/^0+/, ''); if (nz) out.add(nz); if (/^\d{12}$/.test(c)) out.add('0' + c); return [...out];
}
const FIX = { server_not_connected: 'Syncro is not connected. Add it in claude.ai Settings, Connectors', needs_reauth: 'Syncro needs reconnecting in claude.ai Settings, Connectors', not_in_manifest: 'Syncro is not allowed for this page', blocked_by_policy: 'This Syncro tool is blocked by policy', approval_required: 'Syncro needs your approval. Try again and allow it', selection_required: 'Choose which Syncro connector to use when asked, then try again' };
async function call(tool, input) {
  const m = await mcpP;
  if (!m) { const e = new Error('Open this preview in claude.ai to look products up in Syncro'); throw e; }
  try { const r = await m.callTool(SERVER, tool, input); return (r && r.payload) || {}; }
  catch (e) { const x = new Error(FIX[e && e.code] || (e && e.message) || 'Syncro did not answer'); throw x; }
}
for (const p of ls.get('till.preview.quick', [])) byId.set(p.id, p);
let n = 0;
window.TILL_BACKEND = async (path, opts) => {
  const u = new URL(path, 'http://x'); const p = u.pathname; const method = (opts && opts.method) || 'GET';
  const ok = (data) => ({ ok: true, status: 200, data }); const fail = (status, data) => ({ ok: false, status, data });
  try {
    if (p === '/api/state') return ok({ mode: 'dry', preview: true, shop: 'Technical Merritt', catalogue: { count: 0, syncing: false, syncedAt: 0, page: 0, pages: 0, error: null }, cardMethod: 'Dojo card', cashMethod: 'Cash', methods: ['Dojo card', 'Dojo (Ltd)', 'GoCardless', 'Bank Transfer (Monzo)', 'Quick', 'Cash', 'Store Credit'] });
    if (p === '/api/lookup') {
      const code = u.searchParams.get('code') || ''; const variants = codeVariants(code);
      for (const v of variants) if (byCode.has(v)) return ok({ product: byCode.get(v), source: 'cache' });
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
          return ok({ product: prod, source: 'syncro' });
        }
      }
      return fail(404, { error: 'not_found', code });
    }
    if (p === '/api/fresh') return ok({ product: null });
    if (p === '/api/search') {
      const d = await call('list_products', { query: u.searchParams.get('q') || '', per_page: 12 });
      return ok({ results: (d.products || []).map(slim).filter((x) => !x.disabled) });
    }
    if (p === '/api/quickkeys') {
      if (method === 'PUT') { const ids = (JSON.parse(opts.body || '{}').ids || []); ls.set('till.preview.quick', ids.map((id) => byId.get(id)).filter(Boolean)); }
      return ok({ keys: ls.get('till.preview.quick', []) });
    }
    if (p === '/api/sale') return ok({ ok: true, dry: true, invoice: { id: null, number: 'PRACTICE-' + String(++n).padStart(3, '0') }, steps: [] });
    return fail(404, { error: 'Not found' });
  } catch (e) { return fail(502, { error: e.message }); }
};
})();`;

const out = `<title>TM Till</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}
body{padding:0}
</style>
${body}<script>${adapter}
</script>
<script>
${app}
</script>
`;
fs.writeFileSync(process.argv[2], out);
console.log('wrote', process.argv[2], out.length, 'bytes');
