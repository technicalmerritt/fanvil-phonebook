/**
 * End-to-end tests against stand-in Dojo and Syncro servers.
 *
 * These exercise the parts that matter when real money is involved: the happy
 * path, declines, double-charge protection, the amount-changed guard, and the
 * "card charged but Syncro write failed" recovery.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Stand-in upstreams
// ---------------------------------------------------------------------------

/** Tests set this before each charge to script what the card machine does. */
const scenario = {
  terminalOutcome: 'Captured',
  syncroPaymentFails: false,
  invoiceBalance: '84.00',
  invoiceMissing: false,
};

const received = { payments: [], intents: [], sessions: [], headers: {} };

const sessions = new Map();
let seq = 0;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---- Syncro ----
  if (p.startsWith('/syncro/api/v1/')) {
    if (!req.headers.authorization?.startsWith('Bearer ')) return json(res, 401, { error: 'no token' });

    const invoiceMatch = p.match(/^\/syncro\/api\/v1\/invoices\/(\d+)$/);
    if (invoiceMatch && req.method === 'GET') {
      if (scenario.invoiceMissing) return json(res, 404, { error: 'not found' });
      const id = Number(invoiceMatch[1]);
      return json(res, 200, {
        invoice: {
          id,
          number: 1000 + id,
          customer_id: 55,
          customer_business_then_name: 'Acme Ltd',
          total: '84.00',
          balance_due: scenario.invoiceBalance,
        },
      });
    }

    if (p === '/syncro/api/v1/invoices' && req.method === 'GET') {
      return json(res, 200, { invoices: [{ id: 1, number: 1001, balance_due: '84.00' }] });
    }

    if (p === '/syncro/api/v1/payments' && req.method === 'POST') {
      const payload = await body(req);
      if (scenario.syncroPaymentFails) return json(res, 500, { error: 'Syncro is having a moment' });
      received.payments.push(payload);
      return json(res, 201, { payment: { id: 9001 } });
    }
    return json(res, 404, { error: `mock syncro: no route ${req.method} ${p}` });
  }

  // ---- Dojo ----
  received.headers = req.headers;
  if (!req.headers.authorization?.startsWith('Basic ')) return json(res, 401, { error: 'no key' });

  if (p === '/payment-intents' && req.method === 'POST') {
    const payload = await body(req);
    received.intents.push({ payload, idempotencyKey: req.headers['idempotency-key'] });
    return json(res, 201, { id: `pi_${++seq}`, status: 'Created' });
  }

  if (p === '/terminals' && req.method === 'GET') {
    return json(res, 200, { items: [{ id: 'term_abc', status: 'Available' }] });
  }

  if (p === '/terminal-sessions' && req.method === 'POST') {
    const payload = await body(req);
    received.sessions.push({ payload, idempotencyKey: req.headers['idempotency-key'] });
    const id = `ts_${++seq}`;
    sessions.set(id, { polls: 0, outcome: scenario.terminalOutcome });
    return json(res, 201, { id, status: 'InitiateRequested' });
  }

  const sessionMatch = p.match(/^\/terminal-sessions\/([^/]+)$/);
  if (sessionMatch && req.method === 'GET') {
    const s = sessions.get(sessionMatch[1]);
    if (!s) return json(res, 404, { error: 'no session' });
    s.polls += 1;
    // One "still waiting" poll, then the scripted result.
    const status = s.polls < 2 ? 'Initiated' : s.outcome;
    return json(res, 200, { id: sessionMatch[1], status, declineReason: status === 'Declined' ? 'Insufficient funds' : undefined });
  }

  const cancelMatch = p.match(/^\/terminal-sessions\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    const s = sessions.get(cancelMatch[1]);
    if (s) s.outcome = 'Canceled';
    return json(res, 200, { id: cancelMatch[1], status: 'CancelRequested' });
  }

  return json(res, 404, { error: `mock dojo: no route ${req.method} ${p}` });
});

// ---------------------------------------------------------------------------
// Boot: configure the bridge to point at the stand-ins, then import it.
// (config.js reads the environment at import time, so order matters.)
// ---------------------------------------------------------------------------

let charge;
let money;

test.before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));

  Object.assign(process.env, {
    BRIDGE_TOKEN: 'test-token',
    SYNCRO_API_BASE: `http://127.0.0.1:${port}/syncro/api/v1`,
    SYNCRO_API_KEY: 'syncro-test-key',
    SYNCRO_PAYMENT_METHOD: 'Credit Card',
    DOJO_API_BASE: `http://127.0.0.1:${port}`,
    DOJO_API_KEY: 'sk_sandbox_test',
    DOJO_SOFTWARE_HOUSE_ID: 'sh_test',
    DOJO_RESELLER_ID: 'rs_test',
    DOJO_CURRENCY: 'GBP',
    POLL_INTERVAL_MS: '20',
    CHARGE_TIMEOUT_MS: '3000',
    MAX_AMOUNT_MINOR: '500000',
    LEDGER_PATH: path.join(tmp, 'ledger.jsonl'),
  });

  charge = await import('../src/charge.js');
  money = await import('../src/money.js');
});

test.after(() => new Promise((resolve) => upstream.close(resolve)));

function resetScenario() {
  scenario.terminalOutcome = 'Captured';
  scenario.syncroPaymentFails = false;
  scenario.invoiceBalance = '84.00';
  scenario.invoiceMissing = false;
  received.payments.length = 0;
  received.intents.length = 0;
  received.sessions.length = 0;
}

/** Poll the in-process charge state until it settles. */
async function settle(chargeId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = charge.getCharge(chargeId);
    if (state?.finished) return state;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`charge ${chargeId} did not settle within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test('money: decimal strings and floats convert to whole pence', () => {
  assert.equal(money.toMinorUnits('84.00'), 8400);
  assert.equal(money.toMinorUnits('1234.56'), 123456);
  assert.equal(money.toMinorUnits(84), 8400);
  assert.equal(money.toMinorUnits('£ 1,004.05'), 100405);
  // 19.99 * 100 is 1998.9999... in binary floating point; must still be 1999.
  assert.equal(money.toMinorUnits(19.99), 1999);
  assert.equal(money.toMinorUnits('0.07'), 7);
});

test('money: pence render back as two-decimal strings for Syncro', () => {
  assert.equal(money.toDecimalString(8400), '84.00');
  assert.equal(money.toDecimalString(7), '0.07');
  assert.equal(money.toDecimalString(100405), '1004.05');
});

test('money: an unreadable amount is rejected, not silently zeroed', () => {
  assert.throws(() => money.toMinorUnits(''));
  assert.throws(() => money.toMinorUnits(null));
  assert.throws(() => money.toMinorUnits('n/a'));
});

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

test('quote reads the outstanding balance from Syncro', async () => {
  resetScenario();
  const q = await charge.quote(1);
  assert.equal(q.amountMinor, 8400);
  assert.equal(q.amountDisplay, '£84.00');
  assert.equal(q.amountSource, 'balance_due');
  assert.equal(q.customerName, 'Acme Ltd');
  assert.equal(q.invoiceNumber, 1001);
});

test('a missing invoice is a clear 404, not a charge', async () => {
  resetScenario();
  scenario.invoiceMissing = true;
  await assert.rejects(() => charge.quote(999), /not found in Syncro/i);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('happy path: amount goes to the terminal, then the payment lands in Syncro', async () => {
  resetScenario();
  const started = await charge.startCharge({ invoiceIdOrNumber: 10, operator: 'till-1' });

  assert.equal(started.status, 'on_terminal');
  assert.equal(started.amountMinor, 8400);
  assert.equal(started.terminalId, 'term_abc');

  // The intent Dojo received must carry the exact invoice amount, in pence.
  assert.equal(received.intents.length, 1);
  assert.deepEqual(received.intents[0].payload.amount, { value: 8400, currencyCode: 'GBP' });
  assert.equal(received.intents[0].payload.captureMode, 'Auto');
  assert.match(received.intents[0].payload.reference, /^SYNCRO-INV-1010$/);
  assert.ok(received.intents[0].idempotencyKey, 'intent must be sent with an idempotency key');

  // The session must link that intent to the chosen machine.
  assert.equal(received.sessions.length, 1);
  assert.equal(received.sessions[0].payload.terminalId, 'term_abc');
  assert.equal(received.sessions[0].payload.sessionType, 'Sale');
  assert.equal(received.sessions[0].payload.details.sale.paymentIntentId, started.paymentIntentId);

  const final = await settle(started.chargeId);
  assert.equal(final.status, 'recorded');
  assert.equal(final.syncroPaymentId, 9001);

  // And Syncro must have been told the right amount against the right invoice.
  assert.equal(received.payments.length, 1);
  const payment = received.payments[0];
  assert.equal(payment.customer_id, 55);
  assert.equal(payment.amount_cents, 8400);
  assert.equal(payment.payment_method, 'Credit Card');
  assert.deepEqual(payment.apply_payments, { 10: '84.00' });
});

test('Dojo calls carry the version, software-house and reseller headers', () => {
  assert.equal(received.headers.version, '2024-02-05');
  assert.equal(received.headers['software-house-id'], 'sh_test');
  assert.equal(received.headers['reseller-id'], 'rs_test');
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

test('a declined card ends as failed and writes nothing to Syncro', async () => {
  resetScenario();
  scenario.terminalOutcome = 'Declined';

  const started = await charge.startCharge({ invoiceIdOrNumber: 11 });
  const final = await settle(started.chargeId);

  assert.equal(final.status, 'failed');
  assert.match(final.message, /declined/i);
  assert.match(final.message, /Insufficient funds/);
  assert.equal(received.payments.length, 0, 'a declined card must never record a payment');
});

test('cancelling at the machine ends as failed, with no payment recorded', async () => {
  resetScenario();
  scenario.terminalOutcome = 'Canceled';

  const started = await charge.startCharge({ invoiceIdOrNumber: 12 });
  const final = await settle(started.chargeId);

  assert.equal(final.status, 'failed');
  assert.match(final.message, /cancelled at the card machine/i);
  assert.equal(received.payments.length, 0);
});

test('card charged but Syncro write failed: surfaced for attention, then retryable', async () => {
  resetScenario();
  scenario.syncroPaymentFails = true;

  const started = await charge.startCharge({ invoiceIdOrNumber: 13 });
  const stuck = await settle(started.chargeId);

  assert.equal(stuck.status, 'captured_not_recorded');
  assert.equal(stuck.needsAttention, true);
  assert.match(stuck.message, /card charged/i);
  assert.match(stuck.message, /do not charge again/i);
  assert.ok(charge.listNeedingAttention().some((c) => c.chargeId === started.chargeId));

  // Syncro comes back; the operator retries the record only - not the card.
  scenario.syncroPaymentFails = false;
  const fixed = await charge.retryRecord(started.chargeId);

  assert.equal(fixed.status, 'recorded');
  assert.equal(received.payments.length, 1);
  assert.equal(received.payments[0].amount_cents, 8400);
  assert.equal(charge.listNeedingAttention().length, 0);
});

test('retryRecord never double-writes a payment', async () => {
  resetScenario();
  const started = await charge.startCharge({ invoiceIdOrNumber: 14 });
  await settle(started.chargeId);
  assert.equal(received.payments.length, 1);

  await assert.rejects(() => charge.retryRecord(started.chargeId), /not awaiting a Syncro record/i);
  assert.equal(received.payments.length, 1);
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test('a second charge for the same invoice is refused while one is live', async () => {
  resetScenario();
  const started = await charge.startCharge({ invoiceIdOrNumber: 20 });

  await assert.rejects(
    () => charge.startCharge({ invoiceIdOrNumber: 20 }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /already being charged/i);
      return true;
    }
  );
  assert.equal(received.intents.length, 1, 'no second payment intent may be created');

  await settle(started.chargeId);
});

test('a stale till screen cannot charge the wrong amount', async () => {
  resetScenario();
  await assert.rejects(
    () => charge.startCharge({ invoiceIdOrNumber: 21, expectedAmountMinor: 5000 }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /amount changed in Syncro/i);
      return true;
    }
  );
  assert.equal(received.intents.length, 0);
});

test('a fully paid invoice is not sent to the card machine', async () => {
  resetScenario();
  scenario.invoiceBalance = '0.00';
  await assert.rejects(
    () => charge.startCharge({ invoiceIdOrNumber: 22 }),
    /nothing outstanding/i
  );
  assert.equal(received.intents.length, 0);
});

test('an amount above the configured ceiling is refused', async () => {
  resetScenario();
  scenario.invoiceBalance = '9999.00';
  await assert.rejects(
    () => charge.startCharge({ invoiceIdOrNumber: 23 }),
    /above the configured per-sale ceiling/i
  );
  assert.equal(received.intents.length, 0);
});

test('a part payment is allowed, but never more than the balance', async () => {
  resetScenario();
  await assert.rejects(
    () => charge.startCharge({ invoiceIdOrNumber: 24, amountMinorOverride: 9000 }),
    /balance is only/i
  );

  const started = await charge.startCharge({ invoiceIdOrNumber: 25, amountMinorOverride: 2000 });
  const final = await settle(started.chargeId);

  assert.equal(final.status, 'recorded');
  assert.equal(received.payments.at(-1).amount_cents, 2000);
  assert.deepEqual(received.payments.at(-1).apply_payments, { 25: '20.00' });
});

test('an unknown terminal status keeps polling rather than guessing', async () => {
  const { classifySessionStatus } = await import('../src/dojo.js');
  assert.equal(classifySessionStatus('Captured'), 'success');
  assert.equal(classifySessionStatus('Authorized'), 'success');
  assert.equal(classifySessionStatus('Declined'), 'failure');
  assert.equal(classifySessionStatus('Expired'), 'failure');
  assert.equal(classifySessionStatus('Initiated'), 'pending');
  assert.equal(classifySessionStatus('SomethingDojoAddedLater'), 'pending');
});
