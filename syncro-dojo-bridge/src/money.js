/**
 * Money is handled in minor units (pence) as integers everywhere inside the
 * bridge. Floats only appear at the edges, where an API insists on them.
 */

/** "123.45" | 123.45 | "£123.45" -> 12345 */
export function toMinorUnits(value) {
  if (value === null || value === undefined || value === '') {
    throw new Error('Cannot read an amount from an empty value');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Not a finite amount: ${value}`);
    return Math.round(value * 100);
  }
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') {
    throw new Error(`Cannot read an amount from "${value}"`);
  }
  const n = Number.parseFloat(cleaned);
  if (Number.isNaN(n)) throw new Error(`Cannot read an amount from "${value}"`);
  return Math.round(n * 100);
}

/** 12345 -> "123.45" (what Syncro's apply_payments map expects) */
export function toDecimalString(minor) {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 12345 -> "£123.45" for display only. */
export function format(minor, currency = 'GBP') {
  const symbols = { GBP: '£', EUR: '€', USD: '$' };
  const symbol = symbols[currency] ?? `${currency} `;
  return `${symbol}${toDecimalString(minor)}`;
}
