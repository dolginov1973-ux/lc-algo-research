// Show a Hyperliquid trader's CURRENT open positions + recent fills in a readable sheet.
// This is the raw material for copy signals: positions = what to mirror now; fills (with the
// `dir` field: Open Long / Close Long / Open Short / Close Short) = their action stream.
//
// Usage: node src/hyperliquid/track.mjs <address> [nFills]

import { clearinghouseState, userFills } from './api.mjs';

const addr = process.argv[2];
const nFills = Number(process.argv[3] || 20);
if (!addr) {
  console.error('usage: node src/hyperliquid/track.mjs <address> [nFills]');
  process.exit(1);
}

const usd = (x) => '$' + Number(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
const f2 = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });

const chs = await clearinghouseState(addr);
const ms = chs.marginSummary || {};
console.log(`\n=== ${addr} ===`);
console.log(`accountValue ${usd(ms.accountValue)} | totalNtlPos ${usd(ms.totalNtlPos)} | marginUsed ${usd(ms.totalMarginUsed)}\n`);

const positions = (chs.assetPositions || []).map((p) => p.position).filter(Boolean);
if (!positions.length) {
  console.log('OPEN POSITIONS: none (flat)\n');
} else {
  console.log('OPEN POSITIONS:');
  console.log('coin      side    size            entry        notional       uPnL         lev     liqPx        ROE');
  console.log('-'.repeat(104));
  for (const p of positions) {
    const szi = +p.szi;
    const side = szi > 0 ? 'LONG ' : 'SHORT';
    const lev = p.leverage ? `${p.leverage.value}x${p.leverage.type === 'isolated' ? 'i' : ''}` : '—';
    console.log(
      `${(p.coin || '').padEnd(8)}  ${side}  ${f2(Math.abs(szi)).padStart(12)}  ${f2(p.entryPx).padStart(11)}  ` +
        `${usd(p.positionValue).padStart(12)}  ${usd(p.unrealizedPnl).padStart(10)}  ${String(lev).padStart(6)}  ${f2(p.liquidationPx).padStart(10)}  ${(p.returnOnEquity ? (+p.returnOnEquity * 100).toFixed(1) + '%' : '—').padStart(7)}`,
    );
  }
  console.log();
}

const fills = await userFills(addr);
console.log(`RECENT FILLS (last ${nFills} of ${fills.length}):`);
console.log('time                 coin      action            size           px            closedPnl');
console.log('-'.repeat(96));
for (const fl of fills.slice(0, nFills)) {
  const t = new Date(fl.time).toISOString().replace('T', ' ').slice(0, 19);
  console.log(
    `${t}  ${(fl.coin || '').padEnd(8)}  ${(fl.dir || '').padEnd(16)}  ${f2(fl.sz).padStart(12)}  ${f2(fl.px).padStart(11)}  ${(fl.closedPnl && +fl.closedPnl !== 0 ? usd(fl.closedPnl) : '').padStart(10)}`,
  );
}
console.log();
