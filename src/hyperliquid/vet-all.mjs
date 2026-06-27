// Batch-vet every address in data-hl/shortlist.json (from rank-traders.mjs) and print a verdict
// table. GO traders that are directional (not MM/scalper, currently active) are the watchlist
// candidates. Writes data-hl/vetted.json.
//
// Usage: node src/hyperliquid/vet-all.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { vetTrader } from './vet.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '..', '..', 'data-hl');

const usd = (x) => '$' + Number(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (x) => (x * 100).toFixed(0) + '%';

const shortlist = JSON.parse(await readFile(join(DIR, 'shortlist.json'), 'utf8'));
const addrs = shortlist.traders.map((t) => t.addr);
console.log(`Vetting ${addrs.length} shortlisted traders...\n`);

const results = [];
for (const addr of addrs) {
  try {
    results.push(await vetTrader(addr));
  } catch (e) {
    console.error(`  ${addr.slice(0, 10)}… error: ${e.message}`);
  }
}

// Best copyable first: GO + directional + open positions, ranked by realized PnL.
const rank = (v) => (v.verdict === 'GO' ? 2 : v.verdict === 'CAUTION' ? 1 : 0);
results.sort((a, b) => rank(b) - rank(a) || b.realized - a.realized);

console.log('verdict   address                                      AV          openPos  lev   win%   PF      realizedPnL   note');
console.log('-'.repeat(128));
for (const v of results) {
  const note = v.flags.length ? v.flags[0].slice(0, 38) : 'clean directional';
  console.log(
    `${v.verdict.padEnd(8)}  ${v.addr}  ${usd(v.av).padStart(10)}  ${String(v.positions.length).padStart(6)}   ${String(v.maxPosLev + 'x').padStart(4)}  ${pct(v.winRate).padStart(4)}  ${(isFinite(v.profitFactor) ? v.profitFactor.toFixed(1) : '∞').padStart(5)}  ${usd(v.realized).padStart(12)}   ${note}`,
  );
}

const go = results.filter((v) => v.verdict === 'GO');
console.log(`\nGO (copyable directional): ${go.length}`);
go.forEach((v) => console.log(`  ${v.addr}  ${usd(v.av)}  win ${pct(v.winRate)} PF ${isFinite(v.profitFactor) ? v.profitFactor.toFixed(1) : '∞'}  realized ${usd(v.realized)}`));

await writeFile(
  join(DIR, 'vetted.json'),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), results: results.map(({ positions, coinsSorted, ...r }) => ({ ...r, topCoins: coinsSorted.slice(0, 4) })) },
    null,
    2,
  ),
);
console.log('\n-> data-hl/vetted.json');
