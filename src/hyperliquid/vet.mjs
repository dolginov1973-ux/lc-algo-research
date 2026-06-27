// Vet a Hyperliquid trader by their ACTUAL on-chain fill history, not the noisy leaderboard.
// Computes realized P&L, win rate, profit factor, realized max drawdown, coin concentration,
// activity, current live risk — and a GO / CAUTION / SKIP verdict. Exported as vetTrader() so
// vet-all.mjs and the paper tools can reuse it.
//
// Usage: node src/hyperliquid/vet.mjs <address>

import { clearinghouseState, userFills } from './api.mjs';

export async function vetTrader(addr) {
  const [chs, fills] = await Promise.all([clearinghouseState(addr), userFills(addr)]);
  const av = +(chs.marginSummary?.accountValue || 0);
  const ntl = +(chs.marginSummary?.totalNtlPos || 0);
  const positions = (chs.assetPositions || []).map((p) => p.position).filter(Boolean);

  const closes = fills.filter((f) => +f.closedPnl !== 0).map((f) => ({ ...f, pnl: +f.closedPnl, t: f.time }));
  closes.sort((a, b) => a.t - b.t);
  const realized = closes.reduce((s, f) => s + f.pnl, 0);
  const fees = fills.reduce((s, f) => s + (+f.fee || 0), 0);
  const wins = closes.filter((f) => f.pnl > 0);
  const losses = closes.filter((f) => f.pnl < 0);
  const grossWin = wins.reduce((s, f) => s + f.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, f) => s + f.pnl, 0));
  const winRate = closes.length ? wins.length / closes.length : 0;
  const profitFactor = grossLoss === 0 ? Infinity : grossWin / grossLoss;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  let cum = 0, peak = 0, maxDD = 0;
  for (const f of closes) {
    cum += f.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const byCoin = {};
  for (const f of closes) byCoin[f.coin] = (byCoin[f.coin] || 0) + f.pnl;
  const coinsSorted = Object.entries(byCoin).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  const span = fills.length ? (fills[0].time - fills[fills.length - 1].time) / 86400e3 : 0;
  const closesPerDay = span > 0 ? closes.length / span : 0;
  const grossLev = av > 0 ? ntl / av : 0;
  const maxPosLev = positions.reduce((m, p) => Math.max(m, p.leverage ? +p.leverage.value : 0), 0);

  const flags = [];
  const isMM = (winRate > 0.9 && closesPerDay > 25) || (winRate > 0.97 && av > 0 && avgWin < av * 0.001);
  if (isMM) flags.push('MM/SCALPER pattern (very high win-rate + frequency) — not directionally copyable');
  if (av < 50_000) flags.push('account small/withdrawn (live AV low)');
  if (positions.length === 0) flags.push('currently flat (nothing to mirror right now)');
  if (winRate < 0.4 && profitFactor < 1.3) flags.push('weak win rate + PF');
  if (profitFactor < 1.1) flags.push('profit factor ≤1.1 (thin/negative edge)');
  if (maxPosLev >= 20) flags.push(`high leverage (${maxPosLev}x) — liquidation risk`);
  if (av > 0 && maxDD / av > 0.4) flags.push('realized drawdown >40% of account (volatile)');
  if (closes.length < 15) flags.push('few closed trades (small sample)');

  let verdict = 'GO';
  if (flags.some((f) => f.includes('MM/SCALPER') || f.includes('small/withdrawn') || f.includes('thin/negative'))) verdict = 'SKIP';
  else if (flags.length >= 1) verdict = 'CAUTION';

  return {
    addr, av, ntl, positions, grossLev, maxPosLev,
    closes: closes.length, closesPerDay, realized, fees, winRate, profitFactor, avgWin, avgLoss,
    maxDD, coinsSorted, span, isMM, flags, verdict,
  };
}

const usd = (x) => '$' + Number(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (x) => (x * 100).toFixed(1) + '%';

// CLI
if (process.argv[1]?.endsWith('vet.mjs')) {
  const addr = process.argv[2];
  if (!addr) {
    console.error('usage: node src/hyperliquid/vet.mjs <address>');
    process.exit(1);
  }
  const v = await vetTrader(addr);
  console.log(`\n=== VET ${addr} ===`);
  console.log(`LIVE: accountValue ${usd(v.av)} | open ${v.positions.length} pos | grossLeverage ${v.grossLev.toFixed(1)}x | maxPosLev ${v.maxPosLev}x`);
  if (v.positions.length) {
    console.log('  ' + v.positions.map((p) => `${p.coin} ${+p.szi > 0 ? 'L' : 'S'}${p.leverage?.value || '?'}x(${usd(p.positionValue)})`).join('  '));
  }
  console.log(`\nFILL-HISTORY (${v.span.toFixed(1)}d):`);
  console.log(`  closed trades   ${v.closes}  (${v.closesPerDay.toFixed(1)}/day)`);
  console.log(`  realized PnL    ${usd(v.realized)}   fees ${usd(v.fees)}`);
  console.log(`  win rate        ${pct(v.winRate)}`);
  console.log(`  profit factor   ${isFinite(v.profitFactor) ? v.profitFactor.toFixed(2) : '∞'}`);
  console.log(`  avg win/loss    ${usd(v.avgWin)} / ${usd(v.avgLoss)}`);
  console.log(`  realized maxDD  ${usd(v.maxDD)}  (${v.av > 0 ? pct(v.maxDD / v.av) : 'n/a'} of AV)`);
  console.log(`  coins           ${v.coinsSorted.slice(0, 6).map(([c, p]) => `${c}(${usd(p)})`).join('  ')}`);
  console.log(`\nVERDICT: ${v.verdict}${v.flags.length ? '  — ' + v.flags.join('; ') : '  — clean'}`);
}
