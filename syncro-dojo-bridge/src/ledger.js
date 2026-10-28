/**
 * Append-only JSONL audit trail. Every state change of every charge lands
 * here, so there is always a paper record of what the card machine was asked
 * to do - independent of Dojo's and Syncro's own reporting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let ready = false;

function ensureFile() {
  if (ready) return;
  fs.mkdirSync(path.dirname(config.ledgerPath), { recursive: true });
  ready = true;
}

export function record(event) {
  try {
    ensureFile();
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    fs.appendFileSync(config.ledgerPath, `${line}\n`, 'utf8');
  } catch (err) {
    // A failed audit write must never abort a live payment.
    console.error('[ledger] could not write entry:', err.message);
  }
}

export function readRecent(limit = 100) {
  try {
    ensureFile();
    if (!fs.existsSync(config.ledgerPath)) return [];
    const lines = fs.readFileSync(config.ledgerPath, 'utf8').trim().split('\n');
    return lines
      .slice(-limit)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { at: null, event: 'unparseable', raw: line };
        }
      })
      .reverse();
  } catch (err) {
    console.error('[ledger] could not read entries:', err.message);
    return [];
  }
}
