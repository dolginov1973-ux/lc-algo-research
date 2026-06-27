// Copy-signal generator. Snapshots a Hyperliquid trader's live positions, diffs against the
// previous snapshot, and emits structured signals (OPEN / INCREASE / REDUCE / CLOSE / FLIP)
// that an executor can mirror. Designed to run on an interval (cron). First run records a
// baseline WITHOUT emitting — you don't copy a position whose entry you already missed; only
// changes after you start watching are actionable (override with --emit-initial).
//
// Output: appends JSON-line signals to data-hl/signals-<addr>.jsonl and prints them.
// Snapshot stored at data-hl/snap-<addr>.json.
//
// Usage: node src/hyperliquid/watch.mjs <address> [--emit-initial]

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { clearinghouseState } from './api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', '..', 'data-hl');

const addr = process.argv[2];
const emitInitial = process.argv.includes('--emit-initial');
if (!addr) {
  console.error('usage: node src/hyperliquid/watch.mjs <address> [--emit-initial]');
  process.exit(1);
}

const snapPath = join(OUT_DIR, `snap-${addr}.json`);
const sigPath = join(OUT_DIR, `signals-${addr}.jsonl`);

function positionsMap(chs) {
  const m = {};
  for (const ap of chs.assetPositions || []) {
    const p = ap.position;
    if (!p) continue;
    const szi = +p.szi;
    if (szi === 0) continue;
    m[p.coin] = { szi, entryPx: +p.entryPx, lev: p.leverage ? +p.leverage.value : null, leverageType: p.leverage?.type };
  }
  return m;
}

function diff(prev, cur, accountValue) {
  const signals = [];
  const coins = new Set([...Object.keys(prev), ...Object.keys(cur)]);
  for (const coin of coins) {
    const a = prev[coin]?.szi || 0;
    const b = cur[coin]?.szi || 0;
    const meta = cur[coin] || prev[coin];
    const base = { coin, lev: meta.lev, leverageType: meta.leverageType, refPx: cur[coin]?.entryPx ?? prev[coin]?.entryPx, accountValue };
    if (a === 0 && b !== 0) {
      signals.push({ ...base, action: b > 0 ? 'OPEN_LONG' : 'OPEN_SHORT', size: Math.abs(b) });
    } else if (a !== 0 && b === 0) {
      signals.push({ ...base, action: 'CLOSE', size: Math.abs(a) });
    } else if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) {
      signals.push({ ...base, action: b > 0 ? 'FLIP_LONG' : 'FLIP_SHORT', size: Math.abs(b) });
    } else if (Math.sign(a) === Math.sign(b)) {
      if (Math.abs(b) > Math.abs(a) * 1.05) signals.push({ ...base, action: 'INCREASE', size: Math.abs(b) - Math.abs(a) });
      else if (Math.abs(b) < Math.abs(a) * 0.95) signals.push({ ...base, action: 'REDUCE', size: Math.abs(a) - Math.abs(b) });
    }
  }
  return signals;
}

await mkdir(OUT_DIR, { recursive: true });
const chs = await clearinghouseState(addr);
const cur = positionsMap(chs);
const accountValue = +(chs.marginSummary?.accountValue || 0);

let prev = null;
try {
  prev = JSON.parse(await readFile(snapPath, 'utf8')).positions;
} catch {
  prev = null;
}

const ts = new Date().toISOString();
let signals = [];
if (prev === null) {
  if (emitInitial) signals = diff({}, cur, accountValue);
  console.log(`[${ts}] baseline recorded for ${addr} — ${Object.keys(cur).length} open position(s)${emitInitial ? ' (emitted as initial)' : ' (no signals; watching from here)'}`);
} else {
  signals = diff(prev, cur, accountValue);
  if (!signals.length) console.log(`[${ts}] no change (${Object.keys(cur).length} open position(s))`);
}

for (const s of signals) {
  const line = { ts, addr, ...s };
  console.log(`  SIGNAL ${s.action.padEnd(11)} ${s.coin.padEnd(6)} size ${s.size}${s.lev ? ` @${s.lev}x` : ''} refPx ${s.refPx}`);
  await appendFile(sigPath, JSON.stringify(line) + '\n');
}

await writeFile(snapPath, JSON.stringify({ ts, addr, accountValue, positions: cur }, null, 2));
if (signals.length) console.log(`\n${signals.length} signal(s) -> data-hl/signals-${addr.slice(0, 10)}….jsonl`);
