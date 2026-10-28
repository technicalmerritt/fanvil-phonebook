/**
 * Dojo client - "Pay at Counter" terminal flow.
 *
 * The sale sequence Dojo documents for an EPOS is:
 *   1. POST /payment-intents                 -> paymentIntentId
 *   2. GET  /terminals?statuses=Available    -> pick a card machine
 *   3. POST /terminal-sessions               -> pushes the amount to the machine
 *   4. GET  /terminal-sessions/{id}          -> poll until it settles
 *   5. GET  /payment-intents/{id}            -> confirm the final state
 *
 * Auth is HTTP Basic with the secret key sent verbatim (Dojo's own examples do
 * not base64-encode it), plus the version/software-house-id/reseller-id headers.
 */

import { config } from './config.js';
import { requestJson, ApiError } from './http.js';

/** Terminal session statuses, grouped by what the till should do about them. */
export const SESSION_STATUS = {
  /** Still at the card machine - keep polling. */
  pending: [
    'InitiateRequested',
    'Initiated',
    'SignatureVerificationRequired',
    'SignatureVerificationAccepted',
    'CancelRequested',
  ],
  /** Money is ours. */
  success: ['Captured', 'Authorized'],
  /** Over, and no money taken. */
  failure: ['Declined', 'Canceled', 'Expired', 'SignatureVerificationRejected'],
};

export function classifySessionStatus(status) {
  if (SESSION_STATUS.success.includes(status)) return 'success';
  if (SESSION_STATUS.failure.includes(status)) return 'failure';
  if (SESSION_STATUS.pending.includes(status)) return 'pending';
  // Unknown status: treat as pending so we never assume a payment failed (or
  // succeeded) on a value Dojo added after this was written.
  return 'pending';
}

function headers(extra = {}) {
  return {
    Authorization: `Basic ${config.dojo.apiKey}`,
    version: config.dojo.apiVersion,
    'software-house-id': config.dojo.softwareHouseId,
    'reseller-id': config.dojo.resellerId,
    ...extra,
  };
}

function url(pathname, query) {
  const u = new URL(pathname, config.dojo.baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

function call(pathname, { method = 'GET', body, query, idempotencyKey, timeoutMs } = {}) {
  const extra = {};
  if (idempotencyKey) extra['idempotency-key'] = idempotencyKey;
  return requestJson('Dojo', url(pathname, query), {
    method,
    headers: headers(extra),
    body,
    timeoutMs,
  });
}

/**
 * Step 1 - reserve the amount. `amountMinor` is in pence.
 * `idempotencyKey` stops a double-click creating two intents for one sale.
 */
export function createPaymentIntent({ amountMinor, reference, description, idempotencyKey }) {
  return call('/payment-intents', {
    method: 'POST',
    idempotencyKey,
    body: {
      amount: {
        value: amountMinor,
        currencyCode: config.dojo.currency,
      },
      reference,
      description,
      captureMode: config.dojo.captureMode,
    },
  });
}

export function getPaymentIntent(paymentIntentId) {
  return call(`/payment-intents/${encodeURIComponent(paymentIntentId)}`);
}

/** Only needed when DOJO_CAPTURE_MODE=Manual. */
export function capturePaymentIntent(paymentIntentId, { amountMinor, idempotencyKey } = {}) {
  return call(`/payment-intents/${encodeURIComponent(paymentIntentId)}/captures`, {
    method: 'POST',
    idempotencyKey,
    body:
      amountMinor === undefined
        ? {}
        : { amount: { value: amountMinor, currencyCode: config.dojo.currency } },
  });
}

export function refundPaymentIntent(paymentIntentId, { amountMinor, reference, idempotencyKey } = {}) {
  return call(`/payment-intents/${encodeURIComponent(paymentIntentId)}/refunds`, {
    method: 'POST',
    idempotencyKey,
    body: {
      ...(amountMinor === undefined
        ? {}
        : { amount: { value: amountMinor, currencyCode: config.dojo.currency } }),
      ...(reference ? { reference } : {}),
    },
  });
}

export async function listTerminals({ statuses } = {}) {
  const result = await call('/terminals', { query: { statuses } });
  // Dojo has returned both a bare array and a wrapped list across versions.
  if (Array.isArray(result)) return result;
  return result?.items ?? result?.terminals ?? result?.data ?? [];
}

/**
 * Step 2 - decide which card machine to use. A pinned DOJO_TERMINAL_ID wins;
 * otherwise take the first Available one.
 */
export async function pickTerminal() {
  if (config.dojo.terminalId) return config.dojo.terminalId;

  const terminals = await listTerminals({ statuses: 'Available' });
  if (!terminals.length) {
    throw new Error(
      'No Dojo card machine is reporting as Available. Check the terminal is ' +
        'powered on and online, or pin one with DOJO_TERMINAL_ID.'
    );
  }
  const chosen = terminals[0];
  return chosen.id ?? chosen.terminalId ?? chosen;
}

/** Step 3 - this is the call that makes the amount appear on the card machine. */
export function createTerminalSession({ terminalId, paymentIntentId, idempotencyKey }) {
  return call('/terminal-sessions', {
    method: 'POST',
    idempotencyKey,
    body: {
      terminalId,
      sessionType: 'Sale',
      details: {
        sale: { paymentIntentId },
      },
    },
  });
}

export function getTerminalSession(terminalSessionId) {
  return call(`/terminal-sessions/${encodeURIComponent(terminalSessionId)}`);
}

/**
 * Cancel an in-flight session (operator pressed Cancel, or we timed out).
 *
 * Dojo documents a cancel-session operation but the exact path was not
 * verifiable while building this, so try the two plausible shapes. See the
 * "Verify points" section of the README.
 */
export async function cancelTerminalSession(terminalSessionId) {
  const id = encodeURIComponent(terminalSessionId);
  try {
    return await call(`/terminal-sessions/${id}/cancel`, { method: 'POST', body: {} });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
      return await call(`/terminal-sessions/${id}`, { method: 'DELETE' });
    }
    throw err;
  }
}

/** Cheap credential/connectivity check used by /api/health. */
export async function ping() {
  await listTerminals();
  return true;
}
