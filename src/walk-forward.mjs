// Walk-forward test of the ORIGINAL plan, mechanically: "rank strategies on the recent window,
// trade the current winner forward, then re-pick and roll." This is the honest test of whether
// adaptive strategy-selection survives regime changes, vs just fixed strategies and buy & hold.
//
// For each symbol: slide a train window (TR bars) -> pick the best strategy by score -> trade
// the next TE bars with it -> roll forward by TE. Positions are causal (no look-ahead); each
// test segment is backtested flat-start and the per-segment returns are compounded into one
// forward equity curve. We compare ADAPTIVE against a few FIXED strategies and BUY&HOLD.
//
// Usage: DATA_DIR=/path/to/180d node src/walk-forward.mjs [interval]

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STRATEGIES } from './strategies/index.mjs';
import { runBacktest } from './engine/backtest.mjs';
import { computeMetrics, score } from './engine/metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
const ONLY = process.argv[2] || '1h';
const TR = Number(process.env.TRAIN_BARS || 720); // ~30d on 1h
const TE = Number(process.env.TEST_BARS || 168); //  ~7d on 1h
const MIN_TRADES_TRAIN = Number(process.env.MIN_TRADES_TRAIN || 5);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

async function load() {
  const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith(`-${ONLY}.json`));
  const out = [];
  for (const f of files) {
    const ds = JSON.parse(await readFile(join(DATA_DIR, f), 'utf8'));
    if (ds.bars?.length) out.push(ds);
  }
  return out;
}

// Trade `positions` over a slice, return the multiplicative equity factor (final/initial).
function segmentFactor(bars, positions) {
  const res = runBacktest(bars, positions);
  return res.equityCurve[res.equityCurve.length - 1] / res.config.initialEquity;
}

// Build a forward equity curve for a position-source over rolling test windows.
// pick(trainBars) -> strategy object to use for the next test window.
function walkForward(ds, pick) {
  const bars = ds.bars;
  let equity = 1;
  const picks = [];
  let segReturns = [];
  for (let ws = 0; ws + TR + 1 < bars.length; ws += TE) {
    const trainBars = bars.slice(ws, ws + TR);
    const testStart = ws + TR;
    const testEnd = Math.min(testStart + TE, bars.length);
    if (testEnd - testStart < 5) break;
    const strat = pick(trainBars);
    picks.push(strat.key);
    // Causal positions over history up to testEnd, then trade only the test slice.
    const full = strat.generate(bars.slice(0, testEnd));
    const f = segmentFactor(bars.slice(testStart, testEnd), full.slice(testStart, testEnd));
    equity *= f;
    segReturns.push(f - 1);
  }
  return { equity, picks, segReturns };
}

const pickAdaptive = (trainBars) => {
  let best = null;
  let bestScore = -Infinity;
  for (const s of STRATEGIES) {
    const m = computeMetrics(runBacktest(trainBars, s.generate(trainBars)), ONLY);
    const sc = score(m, MIN_TRADES_TRAIN);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best || STRATEGIES[0];
};
const fixed = (key) => () => STRATEGIES.find((s) => s.key === key);
const buyHold = {
  key: 'buy_hold',
  generate: (bars) => new Array(bars.length).fill(1),
};

const datasets = await load();
if (!datasets.length) {
  console.error(`No ${ONLY} data in ${DATA_DIR}. Fetch ~180d first.`);
  process.exit(1);
}

const approaches = [
  { name: 'ADAPTIVE (pick recent winner)', pick: pickAdaptive },
  { name: 'fixed dual_confirm_meanrev', pick: fixed('dual_confirm_meanrev') },
  { name: 'fixed rsi_meanrev', pick: fixed('rsi_meanrev') },
  { name: 'fixed ema_crossover', pick: fixed('ema_crossover') },
  { name: 'BUY & HOLD', pick: () => buyHold },
];

console.log(`Walk-forward — ${ONLY}, ${datasets.length} symbols, ${datasets[0].bars.length} bars; train=${TR} test=${TE}\n`);
console.log('approach                          fwd_ret%   avg_seg%   win_seg%   worst_seg%');
console.log('-'.repeat(80));
const adaptivePickCounts = {};
for (const ap of approaches) {
  const perSym = datasets.map((ds) => walkForward(ds, ap.pick));
  const fwdRet = mean(perSym.map((p) => (p.equity - 1) * 100));
  const allSeg = perSym.flatMap((p) => p.segReturns);
  const avgSeg = mean(allSeg) * 100;
  const winSeg = (allSeg.filter((r) => r > 0).length / Math.max(allSeg.length, 1)) * 100;
  const worst = allSeg.length ? Math.min(...allSeg) * 100 : 0;
  console.log(
    `${ap.name.padEnd(32).slice(0, 32)}  ${fwdRet.toFixed(2).padStart(7)}   ${avgSeg.toFixed(2).padStart(7)}   ${winSeg.toFixed(0).padStart(7)}   ${worst.toFixed(2).padStart(8)}`,
  );
  if (ap.name.startsWith('ADAPTIVE')) {
    for (const p of perSym) for (const k of p.picks) adaptivePickCounts[k] = (adaptivePickCounts[k] || 0) + 1;
  }
}

console.log('\nADAPTIVE picked (count across all windows/symbols):');
const sorted = Object.entries(adaptivePickCounts).sort((a, b) => b[1] - a[1]);
console.log('  ' + sorted.map(([k, c]) => `${k}:${c}`).join('  '));
