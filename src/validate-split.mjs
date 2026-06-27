// Out-of-sample integrity gate. A strategy that only looks good in-sample is curve-fit noise.
// For each (strategy, symbol) we split the series 50/50 in TIME: first half = in-sample (IS),
// second half = out-of-sample (OOS, the recent data the strategy effectively "didn't see" in
// aggregate). Indicators warm up WITHIN each half (positions regenerated per half), so OOS is
// a genuine forward window. Run on ~180d so each half ≈ 90d.
//
// Robust = positive Sharpe AND return OOS, consistent across most symbols. Everything else is
// a maybe-overfit and must NOT graduate to live.
//
// Usage: DATA_DIR=/path/to/180d node src/validate-split.mjs [interval]

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STRATEGIES } from './strategies/index.mjs';
import { runBacktest } from './engine/backtest.mjs';
import { computeMetrics } from './engine/metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
const ONLY = process.argv[2] || '1h';
const MIN_TRADES_HALF = Number(process.env.MIN_TRADES_HALF || 10);

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

function half(bars, which) {
  const mid = Math.floor(bars.length / 2);
  return which === 'IS' ? bars.slice(0, mid) : bars.slice(mid);
}

function evalHalf(strat, bars, interval) {
  const pos = strat.generate(bars);
  const m = computeMetrics(runBacktest(bars, pos), interval);
  return m;
}

const datasets = await load();
if (!datasets.length) {
  console.error(`No ${ONLY} data in ${DATA_DIR}. Fetch ~180d first (DATA_DIR=... BACKTEST_DAYS=180 npm run fetch).`);
  process.exit(1);
}
console.log(`OOS split validation — ${ONLY}, ${datasets.length} symbols, ${datasets[0].bars.length} bars each (≈${Math.round(datasets[0].bars.length / 2)} per half)\n`);

const rows = [];
for (const strat of STRATEGIES) {
  const is = [];
  const oos = [];
  let oosPosSymbols = 0;
  let oosTrades = 0;
  let counted = 0;
  for (const ds of datasets) {
    const mIS = evalHalf(strat, half(ds.bars, 'IS'), ds.interval);
    const mOOS = evalHalf(strat, half(ds.bars, 'OOS'), ds.interval);
    is.push(mIS);
    oos.push(mOOS);
    oosTrades += mOOS.numTrades;
    if (mOOS.numTrades >= MIN_TRADES_HALF) {
      counted++;
      if (mOOS.totalReturnPct > 0) oosPosSymbols++;
    }
  }
  rows.push({
    key: strat.key,
    name: strat.name,
    isRet: mean(is.map((m) => m.totalReturnPct)),
    isSharpe: mean(is.map((m) => m.sharpe)),
    oosRet: mean(oos.map((m) => m.totalReturnPct)),
    oosSharpe: mean(oos.map((m) => m.sharpe)),
    oosTrades,
    oosPos: counted ? `${oosPosSymbols}/${counted}` : '0/0',
    // TRUE robustness = profitable in BOTH time halves (survives a regime change), not just
    // in whichever regime happened to be recent. A strategy that's +OOS but −IS is just buying
    // the last regime — that's the trap this gate exists to catch.
    robust:
      mean(is.map((m) => m.sharpe)) > 0 &&
      mean(is.map((m) => m.totalReturnPct)) > 0 &&
      mean(oos.map((m) => m.sharpe)) > 0 &&
      mean(oos.map((m) => m.totalReturnPct)) > 0 &&
      counted >= Math.ceil(datasets.length * 0.5) &&
      oosPosSymbols / Math.max(counted, 1) >= 0.6,
  });
}

rows.sort((a, b) => b.oosSharpe - a.oosSharpe);
const f = (n, d = 2) => (isFinite(n) ? n.toFixed(d) : 'n/a');
console.log('strategy                              IS_ret  IS_shp   OOS_ret OOS_shp  OOS_pos  trades  robust');
console.log('-'.repeat(100));
for (const r of rows) {
  console.log(
    `${r.name.padEnd(36).slice(0, 36)}  ${f(r.isRet).padStart(6)}  ${f(r.isSharpe).padStart(5)}   ` +
      `${f(r.oosRet).padStart(6)}  ${f(r.oosSharpe).padStart(5)}   ${String(r.oosPos).padStart(6)}  ${String(r.oosTrades).padStart(6)}  ${r.robust ? '✅' : ''}`,
  );
}
const robust = rows.filter((r) => r.robust);
console.log(`\nROBUST (positive IS→OOS, consistent across symbols): ${robust.map((r) => r.key).join(', ') || '(none — nothing survived OOS)'}`);
