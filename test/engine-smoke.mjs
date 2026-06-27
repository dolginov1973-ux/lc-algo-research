// Local smoke test — no network. Proves the engine, indicators and strategies are sane and,
// most importantly, free of look-ahead. Run: npm test
import { STRATEGIES } from '../src/strategies/index.mjs';
import { runBacktest } from '../src/engine/backtest.mjs';
import { computeMetrics } from '../src/engine/metrics.mjs';

let failures = 0;
const check = (cond, msg) => {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    console.error(`FAIL  ${msg}`);
    failures++;
  }
};

// Deterministic PRNG so the test is reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBars(n, { drift = 0, vol = 0.01, seed = 42, start = 100 } = {}) {
  const rnd = mulberry32(seed);
  const bars = [];
  let price = start;
  let t = 1700000000000;
  for (let i = 0; i < n; i++) {
    const open = price;
    const ret = drift + (rnd() - 0.5) * 2 * vol;
    const close = Math.max(0.01, open * (1 + ret));
    const high = Math.max(open, close) * (1 + rnd() * vol);
    const low = Math.min(open, close) * (1 - rnd() * vol);
    bars.push({ time: t, open, high, low, close, volume: 1000 + rnd() * 500 });
    price = close;
    t += 3600e3;
  }
  return bars;
}

console.log('1) strategies run without throwing and return aligned -1/0/1 arrays');
const bars = makeBars(1500, { drift: 0.0003, vol: 0.012, seed: 7 });
for (const s of STRATEGIES) {
  const pos = s.generate(bars);
  const aligned = pos.length === bars.length;
  const valid = pos.every((p) => p === -1 || p === 0 || p === 1);
  check(aligned && valid, `${s.key}: aligned=${aligned} valid=${valid}`);
}

console.log('\n2) backtest + metrics produce finite numbers');
for (const s of STRATEGIES) {
  const pos = s.generate(bars);
  const res = runBacktest(bars, pos);
  const m = computeMetrics(res, '1h');
  const finite = isFinite(m.totalReturnPct) && isFinite(m.sharpe) && isFinite(m.maxDDPct);
  check(finite, `${s.key}: ret=${m.totalReturnPct.toFixed(1)}% sharpe=${m.sharpe.toFixed(2)} dd=${m.maxDDPct.toFixed(1)}% trades=${m.numTrades}`);
}

console.log('\n3) PnL sign sanity: all-long on a pure uptrend is profitable; pure downtrend loses');
{
  const up = makeBars(500, { drift: 0.002, vol: 0.001, seed: 1 });
  const down = makeBars(500, { drift: -0.002, vol: 0.001, seed: 2 });
  const longAll = new Array(up.length).fill(1);
  const upRes = computeMetrics(runBacktest(up, longAll), '1h');
  const downRes = computeMetrics(runBacktest(down, longAll), '1h');
  check(upRes.totalReturnPct > 0, `long+uptrend ret ${upRes.totalReturnPct.toFixed(1)}% > 0`);
  check(downRes.totalReturnPct < 0, `long+downtrend ret ${downRes.totalReturnPct.toFixed(1)}% < 0`);
  const shortAll = new Array(down.length).fill(-1);
  const shortDown = computeMetrics(runBacktest(down, shortAll), '1h');
  check(shortDown.totalReturnPct > 0, `short+downtrend ret ${shortDown.totalReturnPct.toFixed(1)}% > 0`);
}

console.log('\n4) NO LOOK-AHEAD: mutating the LAST bar must not change ANY earlier signal');
{
  const base = makeBars(800, { drift: 0.0005, vol: 0.015, seed: 99 });
  const mutated = base.map((b) => ({ ...b }));
  const last = mutated.length - 1;
  // Drastically alter only the final bar.
  mutated[last] = {
    ...mutated[last],
    open: mutated[last].open * 1.5,
    high: mutated[last].high * 2,
    low: mutated[last].low * 0.5,
    close: mutated[last].close * 1.8,
  };
  for (const s of STRATEGIES) {
    const a = s.generate(base);
    const b = s.generate(mutated);
    let firstDiff = -1;
    for (let i = 0; i < last; i++) {
      if (a[i] !== b[i]) {
        firstDiff = i;
        break;
      }
    }
    check(firstDiff === -1, `${s.key}: earlier signals stable (first diff at ${firstDiff})`);
  }
}

console.log('\n5) flat market: a crossover strategy makes few/zero trades and tiny return');
{
  const flat = makeBars(600, { drift: 0, vol: 0.0005, seed: 5 });
  const pos = STRATEGIES.find((s) => s.key === 'ema_crossover').generate(flat);
  const m = computeMetrics(runBacktest(flat, pos), '1h');
  check(Math.abs(m.totalReturnPct) < 30, `ema_crossover flat ret ${m.totalReturnPct.toFixed(1)}% (no blow-up)`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
