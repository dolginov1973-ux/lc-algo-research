// Copy-edge-retention test — the decisive copyability question: a trader can be hugely
// profitable, but if their edge per trade is thinner than the cost of COPYING them (we enter
// after they do, at a worse price = lag slippage, and pay our own taker fee on entry AND exit),
// mirroring them loses money. This replays their closing fills and nets out our copy costs.
//
// We don't claim to reproduce their $ — we measure what fraction of their realized edge survives
// our round-trip cost = 2 × (FEE + LAG_SLIPPAGE) charged on each trade's notional.
//
// Usage: node src/hyperliquid/paper-replay.mjs <address|all> [feeBps] [lagBps]
//   defaults: fee 6bps (Bitunix taker), lag 10bps (copy delay on liquid alts)

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { userFills } from './api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '..', '..', 'data-hl');

const target = process.argv[2] || 'all';
const FEE = (Number(process.argv[3]) || 6) / 10000;
const LAG = (Number(process.argv[4]) || 10) / 10000;
const ROUND_TRIP = 2 * (FEE + LAG); // entry + exit, each pays fee + slippage

const usd = (x) => '$' + Number(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (x) => (x * 100).toFixed(1) + '%';

async function replay(addr) {
  const fills = await userFills(addr);
  const closes = fills.filter((f) => +f.closedPnl !== 0);
  let theirRealized = 0;
  let ourRealized = 0;
  let notionalSum = 0;
  let theirWins = 0;
  let ourWins = 0;
  for (const f of closes) {
    const notional = Math.abs(+f.sz) * +f.px;
    const their = +f.closedPnl;
    const cost = notional * ROUND_TRIP;
    const ours = their - cost;
    theirRealized += their;
    ourRealized += ours;
    notionalSum += notional;
    if (their > 0) theirWins++;
    if (ours > 0) ourWins++;
  }
  const n = closes.length;
  return {
    addr, n,
    theirRealized, ourRealized,
    retention: theirRealized !== 0 ? ourRealized / theirRealized : 0,
    theirEdgeBps: notionalSum ? (theirRealized / notionalSum) * 10000 : 0,
    ourEdgeBps: notionalSum ? (ourRealized / notionalSum) * 10000 : 0,
    costBps: ROUND_TRIP * 10000,
    theirWinRate: n ? theirWins / n : 0,
    ourWinRate: n ? ourWins / n : 0,
  };
}

let addrs = [];
if (target === 'all') {
  const wl = JSON.parse(await readFile(join(DIR, 'watchlist.json'), 'utf8'));
  addrs = wl.traders.map((t) => t.addr);
} else {
  addrs = [target];
}

console.log(`Copy-edge-retention — round-trip copy cost ${(ROUND_TRIP * 10000).toFixed(0)}bps (fee ${(FEE * 10000).toFixed(0)} + lag ${(LAG * 10000).toFixed(0)}, ×2)\n`);
console.log('address                                      trades  theirEdge/tr  ourEdge/tr   retention  their$         our$(copy)    win%→');
console.log('-'.repeat(126));
for (const addr of addrs) {
  try {
    const r = await replay(addr);
    const survives = r.ourEdgeBps > 0;
    console.log(
      `${r.addr}  ${String(r.n).padStart(6)}  ${(r.theirEdgeBps.toFixed(1) + 'bps').padStart(11)}  ${(r.ourEdgeBps.toFixed(1) + 'bps').padStart(10)}  ${pct(r.retention).padStart(9)}  ${usd(r.theirRealized).padStart(11)}  ${usd(r.ourRealized).padStart(11)}  ${pct(r.theirWinRate)}→${pct(r.ourWinRate)}  ${survives ? '✅' : '❌ edge eaten'}`,
    );
  } catch (e) {
    console.error(`${addr.slice(0, 10)}… error: ${e.message}`);
  }
}
console.log('\nReads: ourEdge/tr > 0 = copying is net-profitable after lag+fees. Low retention = thin per-trade edge, fragile to lag. Try pessimistic lag: ... <addr> 6 20');
