#!/usr/bin/env node
/** Entry point: `node index.js` (or `npm start`). */
import { start } from './src/server.js';

try {
  start();
} catch (err) {
  console.error(`\nCannot start the bridge:\n\n${err.message}\n`);
  process.exit(1);
}
