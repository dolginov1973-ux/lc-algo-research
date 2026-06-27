// Fetch ~90 days of OHLCV and cache it to data/<symbol>-<interval>.json so backtests are
// reproducible. Source: Binance USDⓈ-M futures klines (deep, free, no key). Bitunix's own
// fapi klines are a drop-in alternative but Cloudflare-fronted — this must run from a
// datacenter IP (GitHub Actions / Vercel), NOT the operator's RU ISP which blocks it.
//
// Usage: node src/data/fetch-klines.mjs [interval] [symbol1 symbol2 ...]
//   defaults: interval=1h, symbols = a basket of liquid USDⓈ-M perps.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const BASE = process.env.KLINES_BASE || 'https://fapi.binance.com';
const DAYS = Number(process.env.BACKTEST_DAYS || 90);

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];

const args = process.argv.slice(2);
const interval = args[0] || '1h';
const symbols = args.length > 1 ? args.slice(1) : DEFAULT_SYMBOLS;

const INTERVAL_MS = {
  '1m': 60e3,
  '5m': 300e3,
  '15m': 900e3,
  '30m': 1800e3,
  '1h': 3600e3,
  '2h': 7200e3,
  '4h': 14400e3,
  '1d': 86400e3,
};

async function fetchSymbol(symbol) {
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) throw new Error(`unsupported interval ${interval}`);
  const end = Date.now();
  const start = end - DAYS * 86400e3;
  const bars = [];
  let cursor = start;
  while (cursor < end) {
    const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol} ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) {
      bars.push({
        time: r[0],
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[5],
      });
    }
    const last = rows[rows.length - 1][0];
    if (rows.length < 1500) break;
    cursor = last + stepMs;
  }
  // De-dup by time (pagination overlap guard) and sort.
  const seen = new Map();
  for (const b of bars) seen.set(b.time, b);
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  for (const symbol of symbols) {
    process.stdout.write(`fetching ${symbol} ${interval} ${DAYS}d ... `);
    const bars = await fetchSymbol(symbol);
    const file = join(DATA_DIR, `${symbol}-${interval}.json`);
    await writeFile(file, JSON.stringify({ symbol, interval, days: DAYS, bars }));
    console.log(`${bars.length} bars -> ${file}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
