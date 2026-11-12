'use strict';
/*
 * TM Till server. No dependencies.
 *  - serves the till UI from ./public
 *  - keeps the Syncro API token server-side and proxies only what the till needs
 *  - keeps a slim local copy of the product catalogue so scans are instant
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env: use the environment */ }

const env = process.env;
const SUBDOMAIN = env.SYNCRO_SUBDOMAIN || 'technicalmerritt';
const BASE = `https://${SUBDOMAIN}.syncromsp.com/api/v1`;
const TOKEN = env.SYNCRO_TOKEN || '';
const CUSTOMER_ID = Number(env.POS_CUSTOMER_ID || 20760699);
const SALES_MODE = env.SALES_MODE === 'live' ? 'live' : 'dry';
const PIN = env.TILL_PIN || '';
const CARD_METHOD = env.CARD_METHOD || 'Dojo card';
const CASH_METHOD = env.CASH_METHOD || 'Cash';
const PORT = Number(env.PORT || 8787);
const SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DATA = path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const CATALOGUE_FILE = path.join(DATA, 'catalogue.json');
const QUICK_FILE = path.join(DATA, 'quickkeys.json');
const CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000;
const SYNC_GAP_MS = 500; // 120 requests/min, under Syncro's 180/min limit

if (SALES_MODE === 'live' && !PIN) {
  console.error('Refusing to start: SALES_MODE=live needs TILL_PIN set.');
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

/* ---------------- Syncro client ---------------- */
async function syncro(method, p, body) {
  const headers = { Accept: 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = data.error || data.message || `Syncro answered ${res.status}`;
    const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    e.status = res.status;
    throw e;
  }
  return data;
}

/* ---------------- catalogue ---------------- */
const products = new Map();   // id -> slim product
const byCode = new Map();     // normalised barcode -> id
const cat = { syncing: false, syncedAt: 0, page: 0, pages: 0, error: null };

const codeLike = (s) => !/\s/.test(s) || (/^[A-Z0-9\-_.\/ ]{1,24}$/.test(s) && /\d/.test(s));

function slim(p) {
  const rawName = String(p.name || '').trim();
  const rawDesc = String(p.description || '').trim();
  let title = rawName, sub = '';
  if (rawDesc && rawDesc.length <= 160 && codeLike(rawName)) { title = rawDesc; sub = rawName; }
  else if (rawDesc) { sub = rawDesc.replace(/\s+/g, ' ').slice(0, 90); }
  return {
    id: p.id, title: title || `Product ${p.id}`, sub,
    item: rawName.slice(0, 255), lineName: (rawDesc || rawName).slice(0, 1000),
    price: Number(p.price_retail) || 0, cost: Number(p.price_cost) || 0,
    taxable: p.taxable !== false, upc: String(p.upc_code || '').trim(),
    category: p.product_category || '', qty: Number(p.quantity) || 0,
    stock: !!p.maintain_stock, serialized: !!p.serialized, disabled: !!p.disabled,
  };
}
function codeVariants(raw) {
  const c = String(raw || '').replace(/\s+/g, '');
  const out = new Set();
  if (!c) return [];
  out.add(c);
  const nz = c.replace(/^0+/, '');
  if (nz) out.add(nz);
  if (/^\d{12}$/.test(c)) out.add('0' + c);
  return [...out];
}
function upsert(raw) {
  const s = slim(raw);
  const old = products.get(s.id);
  if (old && old.upc) for (const v of codeVariants(old.upc)) if (byCode.get(v) === s.id) byCode.delete(v);
  s.hay = `${s.title} ${s.sub} ${s.item} ${s.upc} ${s.category}`.toLowerCase();
  products.set(s.id, s);
  if (s.upc && !s.disabled) for (const v of codeVariants(s.upc)) if (!byCode.has(v)) byCode.set(v, s.id);
  return s;
}
const pub = (s) => { if (!s) return null; const { hay, ...rest } = s; return rest; };

function loadCatalogueFile() {
  try {
    const j = JSON.parse(fs.readFileSync(CATALOGUE_FILE, 'utf8'));
    for (const s of j.products) {
      s.hay = `${s.title} ${s.sub} ${s.item} ${s.upc} ${s.category}`.toLowerCase();
      products.set(s.id, s);
      if (s.upc && !s.disabled) for (const v of codeVariants(s.upc)) if (!byCode.has(v)) byCode.set(v, s.id);
    }
    cat.syncedAt = j.syncedAt || 0;
  } catch { /* first run */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncCatalogue() {
  if (cat.syncing) return;
  cat.syncing = true; cat.error = null; cat.page = 0;
  const seen = new Set();
  try {
    let page = 1, pages = 1;
    while (page <= pages) {
      const d = await syncro('GET', `/products?page=${page}`);
      pages = (d.meta && d.meta.total_pages) || pages;
      cat.page = page; cat.pages = pages;
      for (const p of d.products || []) { upsert(p); seen.add(p.id); }
      page++;
      await sleep(SYNC_GAP_MS);
    }
    for (const id of [...products.keys()]) if (!seen.has(id)) {
      const old = products.get(id);
      for (const v of codeVariants(old.upc)) if (byCode.get(v) === id) byCode.delete(v);
      products.delete(id);
    }
    cat.syncedAt = Date.now();
    const out = { syncedAt: cat.syncedAt, products: [...products.values()].map(pub) };
    fs.writeFileSync(CATALOGUE_FILE + '.tmp', JSON.stringify(out));
    fs.renameSync(CATALOGUE_FILE + '.tmp', CATALOGUE_FILE);
  } catch (e) {
    cat.error = e.message;
  } finally {
    cat.syncing = false;
  }
}

async function lookup(code) {
  const variants = codeVariants(code);
  for (const v of variants) { const id = byCode.get(v); if (id && products.has(id)) return { product: products.get(id), source: 'cache' }; }
  for (const v of variants) {
    const d = await syncro('GET', `/products/barcode?barcode=${encodeURIComponent(v)}`);
    if (d && d.product && d.product.id) return { product: upsert(d.product), source: 'syncro' };
  }
  // Syncro's barcode endpoint is exact-match; search finds records with stray spaces.
  const s = await syncro('GET', `/search?query=${encodeURIComponent(variants[0])}`);
  for (const r of (s.results || [])) {
    const t = r && r.table;
    if (!t || t._type !== 'product') continue;
    const upc = String((t._source && t._source.table && t._source.table.upc_code) || '').trim();
    if (!variants.some((v) => codeVariants(upc).includes(v))) continue;
    const d = await syncro('GET', `/products/${t._id}`);
    if (d && d.product) return { product: upsert(d.product), source: 'search' };
  }
  return null;
}
function search(q) {
  const toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!toks.length) return [];
  const hits = [];
  for (const s of products.values()) {
    if (s.disabled) continue;
    if (!toks.every((t) => s.hay.includes(t))) continue;
    const lead = s.title.toLowerCase().startsWith(toks[0]) || s.item.toLowerCase().startsWith(toks[0]) ? 0 : 1;
    hits.push([lead, s.title.length, s]);
    if (hits.length > 400) break;
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return hits.slice(0, 20).map((h) => pub(h[2]));
}

/* ---------------- quick keys ---------------- */
function readQuick() { try { return JSON.parse(fs.readFileSync(QUICK_FILE, 'utf8')); } catch { return []; } }
function writeQuick(ids) { fs.writeFileSync(QUICK_FILE, JSON.stringify(ids)); }
const quickExpanded = () => readQuick().map((id) => pub(products.get(id))).filter(Boolean);

/* ---------------- sales ---------------- */
const recentSales = new Map(); // sale_id -> result, so a retried request never double-invoices
let dryCounter = 0;

function validateSale(b) {
  if (!b || typeof b !== 'object') return 'Bad request';
  if (typeof b.sale_id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(b.sale_id)) return 'Missing sale id';
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) return 'A sale needs between 1 and 100 lines';
  let total = 0;
  for (const l of b.lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 999) return 'Bad quantity';
    if (!Number.isInteger(l.unit) || l.unit < 0 || l.unit > 10000000) return 'Bad price';
    if (typeof l.item !== 'string' || !l.item.trim()) return 'Line has no name';
    total += l.qty * l.unit;
  }
  if (total !== b.total) return 'Total does not match the lines';
  if (typeof b.method !== 'string' || !b.method) return 'No payment method';
  return null;
}

/*
 * LIVE sale. The invoice call is verified against the real account.
 * The line item, payment and print calls follow Syncro's API docs but have NOT
 * yet been run against the account - keep SALES_MODE=dry until they are.
 */
async function createSaleLive(sale) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const out = { ok: false, dry: false, steps: [] };
  const inv = (await syncro('POST', '/invoices', { customer_id: CUSTOMER_ID, date: today })).invoice;
  out.invoice = { id: inv.id, number: inv.number };
  let stage = 'lines';
  try {
    for (const l of sale.lines) {
      const body = { item: l.item.slice(0, 255), name: (l.name || l.item).slice(0, 1000), quantity: l.qty, price: l.unit / 100, cost: Number(l.cost) || 0, taxable: l.taxable !== false };
      if (l.product_id) body.product_id = l.product_id;
      await syncro('POST', `/invoices/${inv.id}/line_items`, body);
    }
    out.steps.push('lines');
    stage = 'payment';
    await syncro('POST', '/payments', {
      customer_id: CUSTOMER_ID, invoice_id: inv.id, amount_cents: sale.total,
      payment_method: sale.method, apply_payments: { [inv.id]: (sale.total / 100).toFixed(2) },
    });
    out.steps.push('payment');
    if (sale.print) {
      try { await syncro('POST', `/invoices/${inv.id}/print`, {}); out.steps.push('print'); }
      catch (e) { out.printError = e.message; }
    }
    out.ok = true;
  } catch (e) {
    out.stage = stage; out.error = e.message;
  }
  return out;
}
async function createSale(sale) {
  if (recentSales.has(sale.sale_id)) return recentSales.get(sale.sale_id);
  let out;
  if (SALES_MODE === 'live') out = await createSaleLive(sale);
  else out = { ok: true, dry: true, invoice: { id: null, number: `PRACTICE-${String(++dryCounter).padStart(3, '0')}` }, steps: [] };
  recentSales.set(sale.sale_id, out);
  if (recentSales.size > 500) recentSales.delete(recentSales.keys().next().value);
  return out;
}

/* ---------------- auth ---------------- */
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
function authed(req) {
  if (!PIN) return true;
  const m = /(?:^|;\s*)till=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const attempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 60000);
  a.push(now); attempts.set(ip, a);
  return a.length <= 6;
}

/* ---------------- http ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'self' https://*.claude.ai https://claude.ai" };

function json(res, code, body, extra) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SEC, ...(extra || {}) });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 200000) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
    res.end(buf);
  });
}

let payMethodsCache = null;
async function payMethods() {
  if (payMethodsCache) return payMethodsCache;
  try {
    const d = await syncro('GET', '/payment_methods');
    payMethodsCache = (d.payment_methods || []).map((m) => m.name).filter(Boolean);
  } catch { return [CARD_METHOD, CASH_METHOD]; }
  return payMethodsCache;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, p);
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '';
      if (!loginAllowed(ip)) return json(res, 429, { error: 'Too many tries. Wait a minute.' });
      const b = await readBody(req);
      const given = Buffer.from(String(b.pin || '')); const want = Buffer.from(PIN);
      if (!PIN || (given.length === want.length && crypto.timingSafeEqual(given, want))) {
        const exp = String(Date.now() + 12 * 60 * 60 * 1000);
        return json(res, 200, { ok: true }, { 'Set-Cookie': `till=${encodeURIComponent(exp + '.' + sign(exp))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` });
      }
      return json(res, 401, { error: 'Wrong PIN' });
    }
    if (!authed(req)) return json(res, 401, { error: 'locked' });

    if (p === '/api/state' && req.method === 'GET') {
      return json(res, 200, {
        mode: SALES_MODE, shop: 'Technical Merritt',
        catalogue: { count: products.size, syncing: cat.syncing, syncedAt: cat.syncedAt, page: cat.page, pages: cat.pages, error: cat.error },
        cardMethod: CARD_METHOD, cashMethod: CASH_METHOD, methods: await payMethods(),
      });
    }
    if (p === '/api/lookup' && req.method === 'GET') {
      const code = (url.searchParams.get('code') || '').slice(0, 80);
      if (!code.trim()) return json(res, 400, { error: 'No code' });
      const r = await lookup(code);
      if (!r) return json(res, 404, { error: 'not_found', code });
      if (r.product.disabled) return json(res, 404, { error: 'disabled', code });
      return json(res, 200, { product: pub(r.product), source: r.source });
    }
    if (p === '/api/fresh' && req.method === 'GET') {
      const id = Number(url.searchParams.get('id'));
      if (!id) return json(res, 400, { error: 'No id' });
      const d = await syncro('GET', `/products/${id}`);
      return json(res, 200, { product: d.product ? pub(upsert(d.product)) : null });
    }
    if (p === '/api/search' && req.method === 'GET') {
      return json(res, 200, { results: search(url.searchParams.get('q')) });
    }
    if (p === '/api/quickkeys' && req.method === 'GET') return json(res, 200, { keys: quickExpanded() });
    if (p === '/api/quickkeys' && req.method === 'PUT') {
      const b = await readBody(req);
      const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 48) : [];
      writeQuick(ids);
      return json(res, 200, { keys: quickExpanded() });
    }
    if (p === '/api/sync' && req.method === 'POST') { syncCatalogue(); return json(res, 202, { ok: true }); }
    if (p === '/api/sale' && req.method === 'POST') {
      const b = await readBody(req);
      const bad = validateSale(b);
      if (bad) return json(res, 400, { error: bad });
      const out = await createSale(b);
      return json(res, out.ok ? 200 : 502, out);
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    const code = e.status === 401 || e.status === 403 ? 502 : (e.status && e.status >= 400 && e.status < 500 ? 502 : 500);
    return json(res, code, { error: e.message || 'Something went wrong' });
  }
});

loadCatalogueFile();
server.listen(PORT, () => {
  console.log(`TM Till on http://localhost:${PORT}  mode=${SALES_MODE}  catalogue=${products.size} products`);
  if (Date.now() - cat.syncedAt > CATALOGUE_TTL_MS) syncCatalogue();
  setInterval(() => { if (Date.now() - cat.syncedAt > CATALOGUE_TTL_MS) syncCatalogue(); }, 10 * 60 * 1000).unref();
});
