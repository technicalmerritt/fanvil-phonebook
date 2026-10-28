/**
 * Syncro client - reads the invoice (so the bridge, not the browser, decides
 * the amount) and writes the payment back once Dojo has taken the money.
 */

import { config, syncroBaseUrl } from './config.js';
import { requestJson, ApiError } from './http.js';
import { toMinorUnits, toDecimalString } from './money.js';

function headers() {
  const scheme = config.syncro.authScheme;
  return {
    Authorization: scheme ? `${scheme} ${config.syncro.apiKey}` : config.syncro.apiKey,
    Accept: 'application/json',
  };
}

function url(pathname, query) {
  const u = new URL(`${syncroBaseUrl()}${pathname}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

function call(pathname, { method = 'GET', body, query, timeoutMs } = {}) {
  return requestJson('Syncro', url(pathname, query), { method, headers: headers(), body, timeoutMs });
}

/** Syncro wraps single resources inconsistently; unwrap defensively. */
function unwrap(result, key) {
  if (!result || typeof result !== 'object') return result;
  if (result[key] && typeof result[key] === 'object') return result[key];
  return result;
}

/**
 * Field names for the outstanding balance differ between Syncro tenants and
 * API versions, so try the configured one first and then the known aliases.
 * Returns the amount in pence plus the field it came from, so the operator can
 * see on screen where the number originated.
 */
const BALANCE_FIELDS = ['balance_due', 'balance', 'amount_due', 'total_due', 'outstanding'];

export function resolveBalanceMinor(invoice) {
  const candidates = [config.syncro.balanceField, ...BALANCE_FIELDS];
  for (const field of candidates) {
    if (!field) continue;
    const raw = invoice?.[field];
    if (raw === undefined || raw === null || raw === '') continue;
    try {
      return { amountMinor: toMinorUnits(raw), source: field };
    } catch {
      // keep looking
    }
  }

  // Last resort: total minus whatever has already been paid.
  const total = invoice?.total ?? invoice?.total_cents;
  if (total !== undefined && total !== null && total !== '') {
    const totalMinor = invoice?.total_cents !== undefined
      ? Math.round(Number(invoice.total_cents))
      : toMinorUnits(total);
    const paid = invoice?.paid_amount ?? invoice?.amount_paid ?? 0;
    const paidMinor = paid === 0 ? 0 : toMinorUnits(paid);
    return { amountMinor: totalMinor - paidMinor, source: 'total - paid (derived)' };
  }

  throw new Error(
    `Could not find an outstanding balance on invoice ${invoice?.id ?? '?'}. ` +
      `Tried: ${candidates.filter(Boolean).join(', ')}. ` +
      'Set SYNCRO_BALANCE_FIELD to the correct field name for your tenant.'
  );
}

export async function getInvoice(invoiceIdOrNumber) {
  try {
    const result = await call(`/invoices/${encodeURIComponent(invoiceIdOrNumber)}`);
    return unwrap(result, 'invoice');
  } catch (err) {
    // A mistyped invoice number is an everyday till mistake, not a system
    // fault - it should read as such and not as a Syncro outage.
    if (err instanceof ApiError && err.status === 404) {
      throw Object.assign(
        new Error(`Invoice ${invoiceIdOrNumber} was not found in Syncro`),
        { statusCode: 404 }
      );
    }
    throw err;
  }
}

/** Open invoices, newest first - what the till UI lists. */
export async function listUnpaidInvoices({ customerId, limit = 25 } = {}) {
  const result = await call('/invoices', {
    query: { paid: 'false', customer_id: customerId, 'page[size]': limit },
  });
  const invoices = result?.invoices ?? result?.data ?? (Array.isArray(result) ? result : []);
  return invoices.slice(0, limit);
}

/**
 * Record the captured payment against the invoice.
 *
 * Shape follows Syncro's documented multi-invoice payment: a total in cents
 * plus an apply_payments map of invoice id -> decimal string.
 */
export async function createPayment({ customerId, invoiceId, amountMinor, reference }) {
  const body = {
    customer_id: customerId,
    amount_cents: amountMinor,
    payment_method: config.syncro.paymentMethod,
    apply_payments: {
      [String(invoiceId)]: toDecimalString(amountMinor),
    },
    ...(reference ? { ref_num: reference } : {}),
  };

  const result = await call('/payments', { method: 'POST', body });
  return unwrap(result, 'payment');
}

/** Cheap credential/connectivity check used by /api/health. */
export async function ping() {
  await call('/invoices', { query: { 'page[size]': 1 } });
  return true;
}
