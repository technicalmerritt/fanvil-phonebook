/**
 * Configuration. Every value comes from the environment (see .env.example).
 *
 * Nothing in this file contains a real credential. The names marked REQUIRED
 * must be filled in before the bridge will start.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Minimal .env loader so the till machine needs no npm packages at all. */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.resolve(process.cwd(), '.env'));

function str(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

function int(name, fallback) {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be a whole number, got "${v}"`);
  return n;
}

function bool(name, fallback) {
  const v = str(name);
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export const config = {
  // ---- Bridge ----------------------------------------------------------
  port: int('PORT', 8787),
  host: str('HOST', '127.0.0.1'),
  /** Shared secret the till UI sends as `Authorization: Bearer <token>`. */
  bridgeToken: str('BRIDGE_TOKEN'),
  /** Extra browser origins allowed to call the bridge (the bookmarklet needs this). */
  allowedOrigins: (str('ALLOWED_ORIGINS', '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ---- Syncro ----------------------------------------------------------
  syncro: {
    /** e.g. "acmecomputers" for https://acmecomputers.syncromsp.com */
    subdomain: str('SYNCRO_SUBDOMAIN'),
    apiKey: str('SYNCRO_API_KEY'),
    /** Header scheme for the token. Set to "" to send the bare key. */
    authScheme: str('SYNCRO_AUTH_SCHEME', 'Bearer'),
    baseUrl: str('SYNCRO_API_BASE'), // optional override, incl. .syncromsp.eu tenants
    /** Label written against the payment in Syncro. */
    paymentMethod: str('SYNCRO_PAYMENT_METHOD', 'Credit Card'),
    /** Invoice JSON field holding the outstanding balance. See README verify-points. */
    balanceField: str('SYNCRO_BALANCE_FIELD', 'balance_due'),
    /** Post the payment back into Syncro after a successful capture. */
    recordPayment: bool('SYNCRO_RECORD_PAYMENT', true),
  },

  // ---- Dojo ------------------------------------------------------------
  dojo: {
    baseUrl: str('DOJO_API_BASE', 'https://api.dojo.tech'),
    /** sk_sandbox_... while testing, sk_prod_... when live. */
    apiKey: str('DOJO_API_KEY'),
    apiVersion: str('DOJO_API_VERSION', '2024-02-05'),
    softwareHouseId: str('DOJO_SOFTWARE_HOUSE_ID'),
    resellerId: str('DOJO_RESELLER_ID'),
    /** Pin one card machine, or leave blank to auto-pick an Available one. */
    terminalId: str('DOJO_TERMINAL_ID'),
    currency: str('DOJO_CURRENCY', 'GBP'),
    /** "Auto" captures on authorisation; "Manual" needs a separate capture call. */
    captureMode: str('DOJO_CAPTURE_MODE', 'Auto'),
  },

  // ---- Charge behaviour ------------------------------------------------
  charge: {
    pollIntervalMs: int('POLL_INTERVAL_MS', 1500),
    /** How long to wait at the card machine before giving up and cancelling. */
    timeoutMs: int('CHARGE_TIMEOUT_MS', 180000),
    /** Refuse any single charge above this, in minor units (pence). Safety net. */
    maxAmountMinor: int('MAX_AMOUNT_MINOR', 500000),
  },

  /** Append-only audit trail of every charge. */
  ledgerPath: str('LEDGER_PATH', path.resolve(process.cwd(), 'data', 'ledger.jsonl')),
};

/** Fail fast and loudly rather than halfway through a customer's payment. */
export function assertConfigured() {
  const missing = [];
  if (!config.bridgeToken) missing.push('BRIDGE_TOKEN');
  if (!config.syncro.subdomain && !config.syncro.baseUrl) missing.push('SYNCRO_SUBDOMAIN');
  if (!config.syncro.apiKey) missing.push('SYNCRO_API_KEY');
  if (!config.dojo.apiKey) missing.push('DOJO_API_KEY');
  if (!config.dojo.softwareHouseId) missing.push('DOJO_SOFTWARE_HOUSE_ID');
  if (!config.dojo.resellerId) missing.push('DOJO_RESELLER_ID');

  if (missing.length) {
    throw new Error(
      `Missing required configuration: ${missing.join(', ')}.\n` +
        'Copy .env.example to .env and fill in the placeholders (see README.md).'
    );
  }

  if (config.dojo.apiKey.startsWith('sk_prod_')) {
    console.warn('[config] LIVE Dojo key in use - real cards will be charged.');
  }
}

export function syncroBaseUrl() {
  if (config.syncro.baseUrl) return config.syncro.baseUrl.replace(/\/+$/, '');
  return `https://${config.syncro.subdomain}.syncromsp.com/api/v1`;
}
