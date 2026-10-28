/**
 * The bridge's HTTP surface.
 *
 * Runs on the till machine (default 127.0.0.1:8787) and does two jobs:
 *   - serves the till UI in public/
 *   - exposes the JSON API that UI (and any other caller) drives
 *
 * It binds to localhost by default so the API keys never leave the machine.
 * Set HOST=0.0.0.0 only if other tills need to share one card machine, and put
 * it behind HTTPS if you do.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { config, assertConfigured, syncroBaseUrl } from './config.js';
import * as charge from './charge.js';
import * as syncro from './syncro.js';
import * as dojo from './dojo.js';
import * as ledger from './ledger.js';
import { ApiError } from './http.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!config.allowedOrigins.includes(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

/** Constant-time compare so the token cannot be guessed byte by byte. */
function tokenOk(provided) {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.bridgeToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authorized(req, url) {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  // Query fallback exists so the bookmarklet can deep-link the till UI.
  return tokenOk(bearer) || tokenOk(url.searchParams.get('token'));
}

async function readBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!total) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 });
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  // Keep path traversal out.
  if (!target.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    sendJson(res, 404, { error: `Not found: ${pathname}` });
    return;
  }
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function errorStatus(err) {
  if (err.statusCode) return err.statusCode;
  if (err instanceof ApiError) return err.status >= 400 && err.status < 600 ? 502 : 502;
  return 500;
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // --- health: does the bridge have working credentials for both ends? ---
  if (pathname === '/api/health' && method === 'GET') {
    const result = { ok: true, syncro: 'unknown', dojo: 'unknown', currency: config.dojo.currency };
    await Promise.all([
      syncro.ping().then(
        () => { result.syncro = 'ok'; },
        (err) => { result.syncro = `error: ${err.message}`; result.ok = false; }
      ),
      dojo.ping().then(
        () => { result.dojo = 'ok'; },
        (err) => { result.dojo = `error: ${err.message}`; result.ok = false; }
      ),
    ]);
    result.needsAttention = charge.listNeedingAttention();
    return sendJson(res, result.ok ? 200 : 503, result);
  }

  if (pathname === '/api/config' && method === 'GET') {
    // Deliberately no secrets - just what the UI needs to render.
    return sendJson(res, 200, {
      currency: config.dojo.currency,
      syncroBaseUrl: syncroBaseUrl(),
      terminalPinned: Boolean(config.dojo.terminalId),
      captureMode: config.dojo.captureMode,
      recordPayment: config.syncro.recordPayment,
      maxAmountMinor: config.charge.maxAmountMinor,
      timeoutMs: config.charge.timeoutMs,
      sandbox: config.dojo.apiKey.startsWith('sk_sandbox_'),
    });
  }

  if (pathname === '/api/terminals' && method === 'GET') {
    return sendJson(res, 200, { terminals: await dojo.listTerminals() });
  }

  if (pathname === '/api/invoices' && method === 'GET') {
    const invoices = await syncro.listUnpaidInvoices({
      customerId: url.searchParams.get('customer_id') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 25),
    });
    return sendJson(res, 200, { invoices });
  }

  // --- what would we charge, without touching the card machine ---
  if (pathname === '/api/quote' && method === 'GET') {
    const invoice = url.searchParams.get('invoice');
    if (!invoice) throw Object.assign(new Error('Pass ?invoice=<id or number>'), { statusCode: 400 });
    return sendJson(res, 200, await charge.quote(invoice));
  }

  // --- the button: push the amount to the card machine ---
  if (pathname === '/api/charges' && method === 'POST') {
    const body = await readBody(req);
    const invoiceIdOrNumber = body.invoice ?? body.invoiceId;
    if (!invoiceIdOrNumber) throw Object.assign(new Error('"invoice" is required'), { statusCode: 400 });
    const started = await charge.startCharge({
      invoiceIdOrNumber,
      expectedAmountMinor: body.expectedAmountMinor,
      amountMinorOverride: body.amountMinor,
      operator: body.operator,
    });
    return sendJson(res, 201, started);
  }

  if (pathname === '/api/charges' && method === 'GET') {
    return sendJson(res, 200, { charges: charge.listCharges({ limit: Number(url.searchParams.get('limit') ?? 50) }) });
  }

  if (pathname === '/api/attention' && method === 'GET') {
    return sendJson(res, 200, { charges: charge.listNeedingAttention() });
  }

  if (pathname === '/api/ledger' && method === 'GET') {
    return sendJson(res, 200, { entries: ledger.readRecent(Number(url.searchParams.get('limit') ?? 100)) });
  }

  const chargeMatch = pathname.match(/^\/api\/charges\/([^/]+)(\/(cancel|retry-record))?$/);
  if (chargeMatch) {
    const chargeId = decodeURIComponent(chargeMatch[1]);
    const action = chargeMatch[3];

    if (!action && method === 'GET') {
      const found = charge.getCharge(chargeId);
      if (!found) throw Object.assign(new Error(`Unknown charge ${chargeId}`), { statusCode: 404 });
      return sendJson(res, 200, found);
    }
    if (action === 'cancel' && method === 'POST') {
      return sendJson(res, 200, await charge.cancelCharge(chargeId));
    }
    if (action === 'retry-record' && method === 'POST') {
      return sendJson(res, 200, await charge.retryRecord(chargeId));
    }
  }

  return sendJson(res, 404, { error: `No such endpoint: ${method} ${pathname}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req, url)) {
        return sendJson(res, 401, { error: 'Unauthorized. Send Authorization: Bearer <BRIDGE_TOKEN>.' });
      }
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = errorStatus(err);
    if (status >= 500) console.error(`[server] ${req.method} ${url.pathname} failed:`, err);
    const payload = { error: err.message };
    if (err.charge) payload.charge = err.charge;
    return sendJson(res, status, payload);
  }
});

export function start() {
  assertConfigured();
  server.listen(config.port, config.host, () => {
    const where = `http://${config.host}:${config.port}`;
    console.log(`Syncro <-> Dojo bridge listening on ${where}`);
    console.log(`  Till UI:      ${where}/`);
    console.log(`  Setup / button: ${where}/setup.html?token=<BRIDGE_TOKEN>`);
    console.log(`  Dojo mode:    ${config.dojo.apiKey.startsWith('sk_sandbox_') ? 'SANDBOX' : 'LIVE'}`);
    console.log(`  Card machine: ${config.dojo.terminalId || 'auto-select first Available'}`);
  });
  return server;
}

export { server };
