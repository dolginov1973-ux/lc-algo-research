// Run every implemented strategy across every cached symbol, average per-strategy metrics,
// rank by composite score, print a table and write a report. Top-5 are flagged — those are
// the candidates that graduate to Infra B (live executor) for forward/paper before any real
// size. Stubs are excluded (they'd be all-flat zeros).
//
// Usage: node src/run-backtest.mjs   (reads everything in data/*.json)

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STRATEGIES } from './strategies/index.mjs';
import { runBacktest } from './engine/backtest.mjs';
import { computeMetrics, score } from './engine/metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const REPORT_DIR = join(__dirname, '..', 'reports');

const MIN_TRADES = Number(process.env.MIN_TRADES || 20);

async function loadDatasets() {
  let files;
  try {
    files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  const sets = [];
  for (const f of files) {
    const ds = JSON.parse(await readFile(join(DATA_DIR, f), 'utf8'));
    if (ds.bars && ds.bars.length) sets.push(ds);
  }
  return sets;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

async function main() {
  const datasets = await loadDatasets();
  if (!datasets.length) {
    console.error(
      'No data in data/. Run `npm run fetch` first (from a datacenter IP — locally the RU ISP blocks Binance). In CI: backtest.yml does fetch+run.',
    );
    process.exit(1);
  }
  console.log(
    `Datasets: ${datasets.map((d) => `${d.symbol}-${d.interval}(${d.bars.length})`).join(', ')}\n`,
  );

  const rows = [];
  for (const strat of STRATEGIES) {
    const perSymbol = [];
    for (const ds of datasets) {
      const positions = strat.generate(ds.bars);
      const result = runBacktest(ds.bars, positions);
      const m = computeMetrics(result, ds.interval);
      m.scoreVal = score(m, MIN_TRADES);
      perSymbol.push({ symbol: ds.symbol, ...m });
    }
    const agg = {
      key: strat.key,
      name: strat.name,
      category: strat.category,
      retPct: mean(perSymbol.map((p) => p.totalReturnPct)),
      sharpe: mean(perSymbol.map((p) => p.sharpe)),
      maxDDPct: mean(perSymbol.map((p) => p.maxDDPct)),
      winRatePct: mean(perSymbol.map((p) => p.winRatePct)),
      profitFactor: mean(perSymbol.map((p) => (isFinite(p.profitFactor) ? p.profitFactor : 5))),
      numTrades: Math.round(mean(perSymbol.map((p) => p.numTrades))),
      // Average of per-symbol scores; -Infinity (too few trades) treated as a hard fail.
      score: perSymbol.some((p) => p.scoreVal === -Infinity)
        ? -Infinity
        : mean(perSymbol.map((p) => p.scoreVal)),
      perSymbol,
    };
    rows.push(agg);
  }

  rows.sort((a, b) => b.score - a.score);

  const fmt = (n, d = 2) => (isFinite(n) ? n.toFixed(d) : 'n/a');
  console.log(
    'rank  strategy                         ret%    sharpe  maxDD%  win%   PF    trades  score',
  );
  console.log('-'.repeat(98));
  rows.forEach((r, i) => {
    const star = i < 5 && r.score !== -Infinity ? '★' : ' ';
    console.log(
      `${star}${String(i + 1).padStart(3)}  ${r.name.padEnd(32).slice(0, 32)}  ` +
        `${fmt(r.retPct).padStart(7)}  ${fmt(r.sharpe).padStart(6)}  ${fmt(r.maxDDPct).padStart(6)}  ` +
        `${fmt(r.winRatePct, 1).padStart(5)}  ${fmt(r.profitFactor).padStart(4)}  ${String(r.numTrades).padStart(6)}  ${fmt(r.score)}`,
    );
  });

  const top5 = rows.filter((r) => r.score !== -Infinity).slice(0, 5);
  console.log(`\nTOP-5 candidates -> Infra B: ${top5.map((r) => r.key).join(', ') || '(none qualified)'}`);

  await mkdir(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    generatedAt: new Date().toISOString(),
    datasets: datasets.map((d) => ({ symbol: d.symbol, interval: d.interval, bars: d.bars.length })),
    minTrades: MIN_TRADES,
    ranking: rows.map(({ perSymbol, ...r }) => r),
    top5: top5.map((r) => r.key),
  };
  await writeFile(join(REPORT_DIR, `backtest-${stamp}.json`), JSON.stringify(report, null, 2));
  await writeFile(join(REPORT_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  console.log(`\nReport: reports/backtest-${stamp}.json (+ reports/latest.json)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
