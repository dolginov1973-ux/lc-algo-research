// Fetch ~90 days of OHLCV and cache it to data/<symbol>-<interval>.json so backtests are
// reproducible. Source: Bybit v5 linear (USDT perps) — public, no key, and (unlike Binance)
// not geo-blocked from GitHub's US runners. Bybit USDT perps are a faithful proxy for
// strategy ranking; once Bitunix's own kline response shape is confirmed live we can switch
// the venue here (it's the only place that needs to change).
//
// Runs from a datacenter IP (GitHub Actions). The operator's RU ISP blocks these hosts.
//
// Usage: node src/data/fetch-klines.mjs [interval] [symbol1 symbol2 ...]
//   defaults: interval=1h, symbols = a basket of liquid USDⓈ-M perps.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const BASE = process.env.KLINES_BASE || 'https://api.bybit.com';
const DAYS = Number(process.env.BACKTEST_DAYS || 90);

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];

const args = process.argv.slice(2);
const interval = args[0] || '1h';
const symbols = args.length > 1 ? args.slice(1) : DEFAULT_SYMBOLS;

// Our interval label -> Bybit interval code.
const BYBIT_INTERVAL = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '1d': 'D',
};

async function fetchSymbol(symbol) {
  const iv = BYBIT_INTERVAL[interval];
  if (!iv) throw new Error(`unsupported interval ${interval}`);
  const end = Date.now();
  const start = end - DAYS * 86400e3;
  const collected = new Map(); // time -> bar
  let cursor = end;
  // Bybit returns up to 1000 bars with ts <= `end`, newest first. Page backward.
  for (let guard = 0; guard < 200; guard++) {
    const url = `${BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}&end=${cursor}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol} HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`${symbol} retCode ${json.retCode}: ${json.retMsg}`);
    const rows = json.result?.list || [];
    if (!rows.length) break;
    for (const r of rows) {
      const t = +r[0];
      collected.set(t, {
        time: t,
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[5],
      });
    }
    const oldest = +rows[rows.length - 1][0];
    if (oldest <= start || rows.length < 1000) break;
    cursor = oldest - 1;
  }
  return [...collected.values()]
    .filter((b) => b.time >= start)
    .sort((a, b) => a.time - b.time);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  for (const symbol of symbols) {
    process.stdout.write(`fetching ${symbol} ${interval} ${DAYS}d ... `);
    const bars = await fetchSymbol(symbol);
    const file = join(DATA_DIR, `${symbol}-${interval}.json`);
    await writeFile(file, JSON.stringify({ symbol, interval, days: DAYS, source: 'bybit-linear', bars }));
    console.log(`${bars.length} bars -> ${file}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
