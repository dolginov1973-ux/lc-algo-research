// Rank Hyperliquid leaderboard for COPYABLE directional traders — not market makers / vaults.
// Filters out: dust accounts, mega-vaults/MMs (huge volume, tiny ROI), and anyone underwater
// recently. Ranks by recent-weighted, consistency-aware ROI. Writes a shortlist for the tracker.
//
// NOTE: the leaderboard's allTime `roi` is pnl/initial-deposit and is garbage-inflated
// (accounts that grew from dust show millions of %). We IGNORE allTime roi and rank on the
// bounded windows (day/week/month roi are return-on-account, meaningful) + absolute allTime
// PnL in USD. Lottery spikes (month roi > MAX_MONTH_ROI) are excluded as un-copyable luck.
// The leaderboard is only a COARSE prefilter — real vetting is track.mjs (on-chain positions
// + fills: leverage, hold time, coin spread, drawdown).
//
// Heuristics (override via env):
//   MIN_AV ($300k) / MAX_AV ($30M)   real money, not dust, not a vault/MM
//   MIN_ALLTIME_PNL ($200k)          real cumulative profit
//   MIN_MONTH_ROI (3%) / MAX_MONTH_ROI (300%)  in form, but not a lottery spike
//   week roi > -15% (not currently imploding) ; MAX_TURNOVER 800x (exclude HFT/MM churn)
//
// Usage: node src/hyperliquid/rank-traders.mjs [topN]

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { leaderboard, perf } from './api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', '..', 'data-hl');

const MIN_AV = Number(process.env.MIN_AV || 300_000);
const MAX_AV = Number(process.env.MAX_AV || 30_000_000);
const MIN_ALLTIME_PNL = Number(process.env.MIN_ALLTIME_PNL || 200_000);
const MIN_MONTH_ROI = Number(process.env.MIN_MONTH_ROI || 0.03);
const MAX_MONTH_ROI = Number(process.env.MAX_MONTH_ROI || 3.0);
const MAX_TURNOVER = Number(process.env.MAX_TURNOVER || 800);
const topN = Number(process.argv[2] || 25);

const pct = (x) => (x * 100).toFixed(1) + '%';
const usd = (x) => '$' + Math.round(x).toLocaleString('en-US');

const lb = await leaderboard();
const rows = lb.leaderboardRows.map(perf).filter((r) => r.allTime && r.month && r.week && r.day);

const candidates = rows.filter((r) => {
  const turnover = r.av > 0 ? r.allTime.vlm / r.av : Infinity;
  return (
    r.av >= MIN_AV &&
    r.av <= MAX_AV &&
    r.allTime.pnl >= MIN_ALLTIME_PNL &&
    r.month.roi >= MIN_MONTH_ROI &&
    r.month.roi <= MAX_MONTH_ROI &&
    // bound day/week too — huge spikes (4000% in a day) are lottery wins, not copyable edge
    r.day.roi > -0.5 &&
    r.day.roi < 3.0 &&
    r.week.roi > -0.3 &&
    r.week.roi < 5.0 &&
    turnover >= 1 && // real traded volume exists (excludes 0x "no data" rows)
    turnover <= MAX_TURNOVER
  );
});

// Recent-weighted, consistency-aware on the bounded windows only.
const scoreOf = (r) => r.month.roi * 0.6 + r.week.roi * 0.4;
candidates.sort((a, b) => scoreOf(b) - scoreOf(a));

console.log(
  `Leaderboard rows: ${rows.length} | copyable candidates: ${candidates.length} ` +
    `(AV ${usd(MIN_AV)}-${usd(MAX_AV)}, allTimePnL≥${usd(MIN_ALLTIME_PNL)}, month ROI ${pct(MIN_MONTH_ROI)}-${pct(MAX_MONTH_ROI)})\n`,
);
console.log('rank  address                                      name              accountValue    day      week     month    allTimePnL    turnover');
console.log('-'.repeat(132));
const top = candidates.slice(0, topN);
top.forEach((r, i) => {
  const turnover = r.allTime.vlm / r.av;
  console.log(
    `${String(i + 1).padStart(3)}  ${r.addr}  ${(r.name || '—').padEnd(16).slice(0, 16)}  ${usd(r.av).padStart(12)}  ` +
      `${pct(r.day.roi).padStart(7)}  ${pct(r.week.roi).padStart(7)}  ${pct(r.month.roi).padStart(7)}  ${usd(r.allTime.pnl).padStart(11)}  ${turnover.toFixed(0).padStart(6)}x`,
  );
});

await mkdir(OUT_DIR, { recursive: true });
await writeFile(
  join(OUT_DIR, 'shortlist.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      filters: { MIN_AV, MAX_AV, MIN_ALLTIME_PNL, MIN_MONTH_ROI, MAX_MONTH_ROI, MAX_TURNOVER },
      traders: top,
    },
    null,
    2,
  ),
);
console.log(`\nShortlist -> data-hl/shortlist.json (top ${top.length}). Track one: node src/hyperliquid/track.mjs <address>`);
