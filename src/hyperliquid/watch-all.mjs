// Cron runner: watch every trader in data-hl/watchlist.json once. Each run diffs live positions
// against the stored snapshot and appends any OPEN/CLOSE/FLIP/RESIZE signals — building a
// forward, on-chain-verifiable record of the copy feed BEFORE we wire real execution. This is
// the "paper" half of copy-trading: we learn whether mirroring these traders would have worked
// over the coming weeks, with zero money at risk.
//
// Usage: node src/hyperliquid/watch-all.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { watchOnce } from './watch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const listPath = join(__dirname, '..', '..', 'data-hl', 'watchlist.json');

const list = JSON.parse(await readFile(listPath, 'utf8'));
const traders = list.traders || [];
console.log(`watch-all: ${traders.length} trader(s)\n`);

let totalSignals = 0;
for (const t of traders) {
  try {
    const { signals } = await watchOnce(t.addr, { emitInitial: false });
    totalSignals += signals.length;
  } catch (e) {
    console.error(`  ERROR ${t.label || t.addr}: ${e.message}`);
  }
}
console.log(`\ndone — ${totalSignals} new signal(s) this cycle`);
