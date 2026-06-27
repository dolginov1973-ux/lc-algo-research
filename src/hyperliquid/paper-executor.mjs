// Paper copy-executor. Mirrors the watchlist traders' LIVE positions onto a simulated account
// of our size, under our risk rules, marking to market with live Hyperliquid mids. This is the
// real executor minus real orders — swapping paperFill() for a Bitunix order makes it live, so
// the logic (sizing, leverage cap, exposure cap, kill-switch, avg-cost P&L) is proven on paper
// first, exactly as the plan requires (paper → micro → copiers).
//
// Mirror sizing: replicate each trader's RISK FRACTION (their position margin / their account)
// onto our per-trader allocation, with leverage capped. Same exposure %, our cap on leverage.
//
// State: data-hl/paper-state.json   Equity log: data-hl/paper-equity.jsonl
// Usage: node src/hyperliquid/paper-executor.mjs

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { clearinghouseState, allMids } from './api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '..', '..', 'data-hl');
const STATE = join(DIR, 'paper-state.json');
const EQLOG = join(DIR, 'paper-equity.jsonl');

const CAPITAL = Number(process.env.PAPER_CAPITAL || 10_000);
const MAX_LEVERAGE = Number(process.env.MAX_LEVERAGE || 5);
const FEE = Number(process.env.FEE || 0.0006);
const SLIP = Number(process.env.SLIP || 0.001);
const KILL_DD = Number(process.env.KILL_DD || 0.2); // halt new exposure if equity down 20%
const DUST = 5; // ignore target changes worth < $5

const usd = (x) => '$' + Number(x).toLocaleString('en-US', { maximumFractionDigits: 0 });

// Average-cost fill. Mutates pos {size, avgPx}; returns realized P&L delta (incl. fee).
function applyFill(pos, d, fillPx) {
  let realized = -Math.abs(d) * fillPx * FEE; // taker fee
  const s = pos.size;
  if (s === 0 || Math.sign(d) === Math.sign(s)) {
    pos.avgPx = s + d !== 0 ? (s * pos.avgPx + d * fillPx) / (s + d) : 0;
    pos.size = s + d;
  } else {
    const closedAbs = Math.min(Math.abs(d), Math.abs(s));
    realized += closedAbs * (fillPx - pos.avgPx) * Math.sign(s);
    const newSize = s + d;
    if (Math.sign(newSize) !== Math.sign(s) && newSize !== 0) pos.avgPx = fillPx; // flipped
    pos.size = newSize;
    if (newSize === 0) pos.avgPx = 0;
  }
  return realized;
}

await mkdir(DIR, { recursive: true });
const wl = JSON.parse(await readFile(join(DIR, 'watchlist.json'), 'utf8'));
const traders = wl.traders || [];
const alloc = CAPITAL / Math.max(traders.length, 1);

const mids = await allMids();
const priceOf = (coin) => +mids[coin];

// --- build target portfolio (coin -> signed units) from each trader's live book ---
const target = {};
for (const t of traders) {
  const chs = await clearinghouseState(t.addr);
  const av = +(chs.marginSummary?.accountValue || 0);
  if (av <= 0) continue;
  for (const ap of chs.assetPositions || []) {
    const p = ap.position;
    if (!p) continue;
    const szi = +p.szi;
    if (szi === 0) continue;
    const price = priceOf(p.coin);
    if (!price) continue;
    const lev = p.leverage ? +p.leverage.value : MAX_LEVERAGE;
    const theirMargin = +p.positionValue / lev;
    const marginFraction = theirMargin / av; // their risk % of account
    const ourLev = Math.min(lev, MAX_LEVERAGE);
    const ourNotional = marginFraction * alloc * ourLev * Math.sign(szi);
    target[p.coin] = (target[p.coin] || 0) + ourNotional / price; // signed units
  }
}

// --- load paper state ---
let state;
try {
  state = JSON.parse(await readFile(STATE, 'utf8'));
} catch {
  state = { capital: CAPITAL, realized: 0, positions: {}, peakEquity: CAPITAL, halted: false, cycles: 0 };
}
const positions = state.positions || {};

// mark-to-market BEFORE rebalance to evaluate kill-switch
const equityOf = () =>
  state.capital + state.realized + Object.entries(positions).reduce((s, [c, p]) => {
    const px = priceOf(c);
    return s + (px ? p.size * (px - p.avgPx) : 0);
  }, 0);

let preEquity = equityOf();
if (preEquity <= state.capital * (1 - KILL_DD)) state.halted = true;

// total target exposure cap: scale all targets so Σ|notional| ≤ CAPITAL × MAX_LEVERAGE
let grossTarget = Object.entries(target).reduce((s, [c, u]) => s + Math.abs(u * priceOf(c)), 0);
const capNotional = CAPITAL * MAX_LEVERAGE;
const scale = grossTarget > capNotional ? capNotional / grossTarget : 1;

// if halted, target flat (close everything, no new exposure)
const finalTarget = {};
if (!state.halted) for (const [c, u] of Object.entries(target)) finalTarget[c] = u * scale;

// --- rebalance: fill the delta toward target ---
const fills = [];
const coins = new Set([...Object.keys(positions), ...Object.keys(finalTarget)]);
for (const coin of coins) {
  const px = priceOf(coin);
  if (!px) continue;
  const cur = positions[coin]?.size || 0;
  const tgt = finalTarget[coin] || 0;
  const d = tgt - cur;
  if (Math.abs(d * px) < DUST) continue;
  const fillPx = px * (1 + Math.sign(d) * SLIP);
  if (!positions[coin]) positions[coin] = { size: 0, avgPx: 0 };
  state.realized += applyFill(positions[coin], d, fillPx);
  fills.push({ coin, delta: d, fillPx, notional: d * px });
  if (Math.abs(positions[coin].size * px) < DUST) delete positions[coin];
}

const equity = equityOf();
if (equity > state.peakEquity) state.peakEquity = equity;
state.cycles++;
const ts = new Date().toISOString();
state.positions = positions;
await writeFile(STATE, JSON.stringify(state, null, 2));
await appendFile(EQLOG, JSON.stringify({ ts, equity, realized: state.realized, openPos: Object.keys(positions).length, halted: state.halted }) + '\n');

// --- report ---
console.log(`\n=== PAPER EXECUTOR  cycle ${state.cycles}  ${ts} ===`);
console.log(`capital ${usd(CAPITAL)} | equity ${usd(equity)} (${((equity / CAPITAL - 1) * 100).toFixed(2)}%) | realized ${usd(state.realized)} | peak ${usd(state.peakEquity)}${state.halted ? '  ⛔ HALTED (kill-switch)' : ''}`);
console.log(`max lev ${MAX_LEVERAGE}x | fee ${(FEE * 1e4).toFixed(0)}bps | slip ${(SLIP * 1e4).toFixed(0)}bps | exposure cap ${usd(capNotional)}${scale < 1 ? ` (scaled ${(scale * 100).toFixed(0)}%)` : ''}`);
if (fills.length) {
  console.log(`\nFILLS this cycle:`);
  for (const f of fills) console.log(`  ${f.delta > 0 ? 'BUY ' : 'SELL'} ${f.coin.padEnd(6)} ${Math.abs(f.delta).toPrecision(4)} @ ${f.fillPx.toFixed(4)}  (${usd(f.notional)})`);
} else {
  console.log('\nno rebalance needed this cycle');
}
console.log(`\nOPEN PAPER POSITIONS:`);
const ps = Object.entries(positions);
if (!ps.length) console.log('  flat');
for (const [c, p] of ps) {
  const px = priceOf(c);
  const uPnl = p.size * (px - p.avgPx);
  console.log(`  ${(p.size > 0 ? 'LONG ' : 'SHORT')} ${c.padEnd(6)} ${Math.abs(p.size).toPrecision(4)}  avg ${p.avgPx.toFixed(4)}  mark ${px.toFixed(4)}  uPnL ${usd(uPnl)}  notional ${usd(Math.abs(p.size * px))}`);
}
