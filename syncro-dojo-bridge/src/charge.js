/**
 * The charge state machine: Syncro invoice -> Dojo card machine -> Syncro payment.
 *
 * Design rules, in priority order:
 *  1. Never charge a card twice for one invoice. One active charge per invoice,
 *     and Dojo idempotency keys derived from the charge id.
 *  2. The amount is always read from Syncro here. The browser may *confirm* an
 *     amount but can never *choose* one.
 *  3. If the card is charged but writing the payment back to Syncro fails, that
 *     is a visible `needs_reconcile` state with a retry - never a silent loss.
 */

import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import * as dojo from './dojo.js';
import * as syncro from './syncro.js';
import * as ledger from './ledger.js';
import { format } from './money.js';

/** Terminal (i.e. finished) charge states. */
const FINISHED = new Set(['recorded', 'captured_not_recorded', 'failed', 'cancelled', 'timed_out']);

/** chargeId -> charge */
const charges = new Map();
/** invoiceId -> chargeId, for charges that are still running. */
const activeByInvoice = new Map();

function publicView(charge) {
  if (!charge) return null;
  return {
    chargeId: charge.chargeId,
    status: charge.status,
    message: charge.message,
    invoiceId: charge.invoiceId,
    invoiceNumber: charge.invoiceNumber,
    customerId: charge.customerId,
    customerName: charge.customerName,
    amountMinor: charge.amountMinor,
    amountDisplay: format(charge.amountMinor, config.dojo.currency),
    amountSource: charge.amountSource,
    currency: config.dojo.currency,
    terminalId: charge.terminalId,
    paymentIntentId: charge.paymentIntentId,
    terminalSessionId: charge.terminalSessionId,
    dojoStatus: charge.dojoStatus,
    syncroPaymentId: charge.syncroPaymentId,
    needsAttention: charge.status === 'captured_not_recorded',
    finished: FINISHED.has(charge.status),
    createdAt: charge.createdAt,
    updatedAt: charge.updatedAt,
  };
}

function setStatus(charge, status, message) {
  charge.status = status;
  if (message !== undefined) charge.message = message;
  charge.updatedAt = new Date().toISOString();
  ledger.record({
    event: 'charge.status',
    chargeId: charge.chargeId,
    status,
    message: charge.message,
    invoiceId: charge.invoiceId,
    amountMinor: charge.amountMinor,
    paymentIntentId: charge.paymentIntentId,
    terminalSessionId: charge.terminalSessionId,
    dojoStatus: charge.dojoStatus,
    syncroPaymentId: charge.syncroPaymentId,
  });
  if (FINISHED.has(status) && activeByInvoice.get(String(charge.invoiceId)) === charge.chargeId) {
    activeByInvoice.delete(String(charge.invoiceId));
  }
}

export function getCharge(chargeId) {
  return publicView(charges.get(chargeId));
}

export function listCharges({ limit = 50 } = {}) {
  return [...charges.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit)
    .map(publicView);
}

/** Charges that took money but are not yet recorded in Syncro. */
export function listNeedingAttention() {
  return [...charges.values()]
    .filter((c) => c.status === 'captured_not_recorded')
    .map(publicView);
}

/**
 * Look up what we would charge, without touching the card machine. The till UI
 * calls this to render the confirmation ("Charge £84.00 to card machine?").
 */
export async function quote(invoiceIdOrNumber) {
  const invoice = await syncro.getInvoice(invoiceIdOrNumber);
  if (!invoice || !invoice.id) {
    throw Object.assign(new Error(`Invoice ${invoiceIdOrNumber} not found in Syncro`), { statusCode: 404 });
  }
  const { amountMinor, source } = syncro.resolveBalanceMinor(invoice);
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number ?? invoice.invoice_number ?? null,
    customerId: invoice.customer_id ?? invoice.customer?.id ?? null,
    customerName:
      invoice.customer_business_then_name ??
      invoice.customer?.business_then_name ??
      invoice.customer?.fullname ??
      null,
    amountMinor,
    amountDisplay: format(amountMinor, config.dojo.currency),
    amountSource: source,
    currency: config.dojo.currency,
    alreadyCharging: activeByInvoice.get(String(invoice.id)) ?? null,
  };
}

/**
 * Start a charge. Returns as soon as the amount is on the card machine; the
 * till UI then polls getCharge() while the customer taps their card.
 *
 * @param {object}  opts
 * @param {string}  opts.invoiceIdOrNumber   Syncro invoice id or number.
 * @param {number} [opts.expectedAmountMinor] If given, must match Syncro, or
 *   the charge is refused. Protects against a stale till screen.
 * @param {number} [opts.amountMinorOverride] Explicit part-payment amount.
 */
export async function startCharge({ invoiceIdOrNumber, expectedAmountMinor, amountMinorOverride, operator }) {
  const q = await quote(invoiceIdOrNumber);
  const invoiceKey = String(q.invoiceId);

  // Rule 1: one live charge per invoice.
  const existingId = activeByInvoice.get(invoiceKey);
  if (existingId) {
    const existing = charges.get(existingId);
    if (existing && !FINISHED.has(existing.status)) {
      throw Object.assign(
        new Error(
          `Invoice ${q.invoiceNumber ?? q.invoiceId} is already being charged ` +
            `(${existing.status}). Finish or cancel that first.`
        ),
        { statusCode: 409, charge: publicView(existing) }
      );
    }
  }

  let amountMinor = q.amountMinor;
  if (amountMinorOverride !== undefined && amountMinorOverride !== null) {
    if (!Number.isInteger(amountMinorOverride) || amountMinorOverride <= 0) {
      throw Object.assign(new Error('A part-payment amount must be a positive whole number of pence'), { statusCode: 400 });
    }
    if (amountMinorOverride > q.amountMinor) {
      throw Object.assign(
        new Error(
          `Cannot charge ${format(amountMinorOverride, config.dojo.currency)} - the invoice ` +
            `balance is only ${q.amountDisplay}.`
        ),
        { statusCode: 400 }
      );
    }
    amountMinor = amountMinorOverride;
  }

  // Rule 2: the browser only confirms the amount, it never picks it.
  if (expectedAmountMinor !== undefined && expectedAmountMinor !== null && expectedAmountMinor !== amountMinor) {
    throw Object.assign(
      new Error(
        `The amount changed in Syncro (till showed ${format(expectedAmountMinor, config.dojo.currency)}, ` +
          `invoice is now ${format(amountMinor, config.dojo.currency)}). Refresh and try again.`
      ),
      { statusCode: 409 }
    );
  }

  if (amountMinor <= 0) {
    throw Object.assign(
      new Error(`Invoice ${q.invoiceNumber ?? q.invoiceId} has nothing outstanding (${q.amountDisplay}).`),
      { statusCode: 400 }
    );
  }
  if (amountMinor > config.charge.maxAmountMinor) {
    throw Object.assign(
      new Error(
        `${format(amountMinor, config.dojo.currency)} is above the configured per-sale ceiling of ` +
          `${format(config.charge.maxAmountMinor, config.dojo.currency)} (MAX_AMOUNT_MINOR).`
      ),
      { statusCode: 400 }
    );
  }

  const chargeId = randomUUID();
  const now = new Date().toISOString();
  const charge = {
    chargeId,
    status: 'starting',
    message: 'Preparing payment',
    invoiceId: q.invoiceId,
    invoiceNumber: q.invoiceNumber,
    customerId: q.customerId,
    customerName: q.customerName,
    amountMinor,
    amountSource: q.amountSource,
    operator: operator ?? null,
    terminalId: null,
    paymentIntentId: null,
    terminalSessionId: null,
    dojoStatus: null,
    syncroPaymentId: null,
    createdAt: now,
    updatedAt: now,
    cancelRequested: false,
  };
  charges.set(chargeId, charge);
  activeByInvoice.set(invoiceKey, chargeId);

  ledger.record({
    event: 'charge.created',
    chargeId,
    invoiceId: charge.invoiceId,
    invoiceNumber: charge.invoiceNumber,
    customerId: charge.customerId,
    amountMinor,
    amountSource: charge.amountSource,
    operator: charge.operator,
  });

  try {
    const terminalId = await dojo.pickTerminal();
    charge.terminalId = terminalId;

    const reference = `SYNCRO-INV-${charge.invoiceNumber ?? charge.invoiceId}`;
    const intent = await dojo.createPaymentIntent({
      amountMinor,
      reference,
      description: `Syncro invoice ${charge.invoiceNumber ?? charge.invoiceId}`,
      // Derived from chargeId, so a retried HTTP request cannot create a second intent.
      idempotencyKey: `${chargeId}:intent`,
    });
    charge.paymentIntentId = intent?.id ?? intent?.paymentIntentId;
    if (!charge.paymentIntentId) {
      throw new Error(`Dojo did not return a payment intent id. Response: ${JSON.stringify(intent).slice(0, 300)}`);
    }
    setStatus(charge, 'intent_created', 'Payment prepared');

    const session = await dojo.createTerminalSession({
      terminalId,
      paymentIntentId: charge.paymentIntentId,
      idempotencyKey: `${chargeId}:session`,
    });
    charge.terminalSessionId = session?.id ?? session?.terminalSessionId;
    charge.dojoStatus = session?.status ?? null;
    if (!charge.terminalSessionId) {
      throw new Error(`Dojo did not return a terminal session id. Response: ${JSON.stringify(session).slice(0, 300)}`);
    }

    setStatus(charge, 'on_terminal', `${format(amountMinor, config.dojo.currency)} sent to the card machine - waiting for the customer`);
  } catch (err) {
    charge.error = err.message;
    setStatus(charge, 'failed', err.message);
    throw err;
  }

  // Poll in the background; the till UI watches via getCharge().
  void watchToCompletion(charge).catch((err) => {
    console.error(`[charge ${chargeId}] watcher crashed:`, err);
  });

  return publicView(charge);
}

async function watchToCompletion(charge) {
  const deadline = Date.now() + config.charge.timeoutMs;

  while (Date.now() < deadline) {
    await sleep(config.charge.pollIntervalMs);

    if (charge.cancelRequested) return;

    let session;
    try {
      session = await dojo.getTerminalSession(charge.terminalSessionId);
    } catch (err) {
      // A blip while the customer is mid-tap must not fail the sale; keep
      // polling until the deadline.
      console.warn(`[charge ${charge.chargeId}] poll failed, retrying: ${err.message}`);
      continue;
    }

    const status = session?.status ?? null;
    if (status !== charge.dojoStatus) {
      charge.dojoStatus = status;
      charge.updatedAt = new Date().toISOString();
      ledger.record({
        event: 'charge.dojo_status',
        chargeId: charge.chargeId,
        dojoStatus: status,
        terminalSessionId: charge.terminalSessionId,
      });
    }

    switch (dojo.classifySessionStatus(status)) {
      case 'success':
        await onCaptured(charge, session);
        return;
      case 'failure':
        setStatus(charge, 'failed', declineMessage(status, session));
        return;
      default:
        if (status === 'SignatureVerificationRequired') {
          charge.message = 'Signature verification required on the card machine';
        }
    }
  }

  // Timed out: cancel at the terminal so the machine does not sit on the sale,
  // then re-check in case the customer paid in the last second.
  charge.cancelRequested = true;
  try {
    await dojo.cancelTerminalSession(charge.terminalSessionId);
  } catch (err) {
    console.warn(`[charge ${charge.chargeId}] timeout cancel failed: ${err.message}`);
  }

  try {
    const final = await dojo.getTerminalSession(charge.terminalSessionId);
    charge.dojoStatus = final?.status ?? charge.dojoStatus;
    if (dojo.classifySessionStatus(charge.dojoStatus) === 'success') {
      await onCaptured(charge, final);
      return;
    }
  } catch {
    // fall through to timed_out
  }

  setStatus(charge, 'timed_out', 'No response from the card machine in time - the sale was cancelled');
}

function declineMessage(status, session) {
  const reason =
    session?.declineReason ?? session?.decline?.reason ?? session?.errorMessage ?? session?.reason ?? null;
  switch (status) {
    case 'Declined':
      return reason ? `Card declined: ${reason}` : 'Card declined';
    case 'Canceled':
      return 'Cancelled at the card machine';
    case 'Expired':
      return 'The card machine session expired';
    case 'SignatureVerificationRejected':
      return 'Signature was rejected';
    default:
      return reason ? `Payment failed: ${reason}` : `Payment failed (${status})`;
  }
}

/** Money is taken. Everything from here is about not losing the record of it. */
async function onCaptured(charge, session) {
  charge.capturedAt = new Date().toISOString();
  charge.dojoStatus = session?.status ?? charge.dojoStatus;
  setStatus(charge, 'captured', 'Payment taken on the card machine');

  ledger.record({
    event: 'charge.captured',
    chargeId: charge.chargeId,
    invoiceId: charge.invoiceId,
    amountMinor: charge.amountMinor,
    paymentIntentId: charge.paymentIntentId,
    dojoStatus: charge.dojoStatus,
  });

  if (!config.syncro.recordPayment) {
    setStatus(charge, 'captured_not_recorded', 'Payment taken. Recording in Syncro is switched off (SYNCRO_RECORD_PAYMENT=false) - enter it manually.');
    return;
  }

  await recordInSyncro(charge);
}

async function recordInSyncro(charge) {
  // Rule 3: never write the same payment twice.
  if (charge.syncroPaymentId) return publicView(charge);

  try {
    const payment = await syncro.createPayment({
      customerId: charge.customerId,
      invoiceId: charge.invoiceId,
      amountMinor: charge.amountMinor,
      reference: charge.paymentIntentId,
    });
    charge.syncroPaymentId = payment?.id ?? payment?.payment_id ?? 'recorded';
    ledger.record({
      event: 'charge.recorded',
      chargeId: charge.chargeId,
      invoiceId: charge.invoiceId,
      amountMinor: charge.amountMinor,
      paymentIntentId: charge.paymentIntentId,
      syncroPaymentId: charge.syncroPaymentId,
    });
    setStatus(charge, 'recorded', `${format(charge.amountMinor, config.dojo.currency)} paid and recorded against invoice ${charge.invoiceNumber ?? charge.invoiceId}`);
  } catch (err) {
    charge.recordError = err.message;
    ledger.record({
      event: 'charge.record_failed',
      chargeId: charge.chargeId,
      invoiceId: charge.invoiceId,
      amountMinor: charge.amountMinor,
      paymentIntentId: charge.paymentIntentId,
      error: err.message,
    });
    setStatus(
      charge,
      'captured_not_recorded',
      `Card charged ${format(charge.amountMinor, config.dojo.currency)} BUT recording it in Syncro failed: ${err.message} ` +
        '- do not charge again; retry the record or enter the payment by hand.'
    );
  }
  return publicView(charge);
}

/** Operator-driven retry for a captured-but-unrecorded charge. */
export async function retryRecord(chargeId) {
  const charge = charges.get(chargeId);
  if (!charge) throw Object.assign(new Error(`Unknown charge ${chargeId}`), { statusCode: 404 });
  if (charge.status !== 'captured_not_recorded') {
    throw Object.assign(
      new Error(`Charge ${chargeId} is "${charge.status}", not awaiting a Syncro record.`),
      { statusCode: 409 }
    );
  }
  return recordInSyncro(charge);
}

/** Operator pressed Cancel on the till while the machine was waiting. */
export async function cancelCharge(chargeId) {
  const charge = charges.get(chargeId);
  if (!charge) throw Object.assign(new Error(`Unknown charge ${chargeId}`), { statusCode: 404 });
  if (FINISHED.has(charge.status)) return publicView(charge);

  charge.cancelRequested = true;
  if (charge.terminalSessionId) {
    try {
      await dojo.cancelTerminalSession(charge.terminalSessionId);
    } catch (err) {
      charge.cancelRequested = false;
      throw Object.assign(
        new Error(`Could not cancel at the card machine: ${err.message}. Cancel on the machine itself.`),
        { statusCode: 502 }
      );
    }
  }
  setStatus(charge, 'cancelled', 'Cancelled from the till');
  return publicView(charge);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
