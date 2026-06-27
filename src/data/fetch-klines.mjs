// Fetch ~90 days of OHLCV and cache it to data/<symbol>-<interval>.json so backtests are
// reproducible. Transport: if KLINES_PROXY is set we route every request through it via curl
// (works identically local + CI, no npm deps); otherwise plain fetch. GitHub's US runners and
// the operator's RU ISP are both geo/network-blocked from Binance/Bybit directly — the proxy
// is the clean egress that makes the deep perp data reachable.
//
// ⚠️ KLINES_PROXY is a MARKET-DATA proxy ONLY. It must never touch Bitunix — the trading
// venue gets its own dedicated API keys + proxy (provided separately for Infra B).
// Sources tried in order; first that returns data wins for the whole run:
//   1) Binance USDⓈ-M perps (deepest, most faithful) 2) OKX perps 3) CryptoCompare hourly.
//
// Usage: KLINES_PROXY=http://user:pass@host:port node src/data/fetch-klines.mjs [interval] [sym...]

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DAYS = Number(process.env.BACKTEST_DAYS || 90);
const PROXY = process.env.KLINES_PROXY || '';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const args = process.argv.slice(2);
const interval = args[0] || '1h';
const symbols = args.length > 1 ? args.slice(1) : DEFAULT_SYMBOLS;

const baseOf = (symbol) => symbol.replace(/USDT$/, '');
const dedupSort = (bars, start) => {
  const m = new Map();
  for (const b of bars) m.set(b.time, b);
  return [...m.values()].filter((b) => b.time >= start).sort((a, b) => a.time - b.time);
};

// HTTP GET -> text. Uses curl through the proxy when configured, else native fetch.
async function httpGet(url) {
  if (PROXY) {
    const { stdout } = await execFileP('curl', ['-s', '--max-time', '40', '-x', PROXY, url], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return await res.text();
}
const getJson = async (url) => JSON.parse(await httpGet(url));

// ---- Binance USDⓈ-M perp ----
async function binance(symbol, start, end) {
  const stepMs = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '1d': 86400e3 }[interval];
  if (!stepMs) throw new Error(`binance: unsupported interval ${interval}`);
  const out = [];
  let cursor = start;
  for (let g = 0; g < 400; g++) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1500`;
    const rows = await getJson(url);
    if (!Array.isArray(rows)) throw new Error(`binance: ${JSON.stringify(rows).slice(0, 120)}`);
    if (!rows.length) break;
    for (const r of rows) out.push({ time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    const last = rows[rows.length - 1][0];
    if (last >= end || rows.length < 1500) break;
    cursor = last + stepMs;
  }
  return dedupSort(out, start);
}

// ---- OKX perp ----
const OKX_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '1d': '1D' };
async function okx(symbol, start, end) {
  const bar = OKX_BAR[interval];
  if (!bar) throw new Error(`okx: unsupported interval ${interval}`);
  const instId = `${baseOf(symbol)}-USDT-SWAP`;
  const out = [];
  let cursor = end;
  for (let g = 0; g < 400; g++) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${bar}&after=${cursor}&limit=100`;
    const json = await getJson(url);
    if (json.code !== '0') throw new Error(`okx code ${json.code}: ${json.msg}`);
    const rows = json.data || [];
    if (!rows.length) break;
    for (const r of rows) out.push({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    const oldest = +rows[rows.length - 1][0];
    if (oldest <= start || rows.length < 100) break;
    cursor = oldest;
  }
  return dedupSort(out, start);
}

// ---- CryptoCompare (hourly / daily) ----
async function cryptocompare(symbol, start, end) {
  const path = interval === '1d' ? 'histoday' : interval === '1h' ? 'histohour' : null;
  if (!path) throw new Error(`cryptocompare: only 1h/1d (got ${interval})`);
  const out = [];
  let toTs = Math.floor(end / 1000);
  const startSec = Math.floor(start / 1000);
  for (let g = 0; g < 50; g++) {
    const url = `https://min-api.cryptocompare.com/data/v2/${path}?fsym=${baseOf(symbol)}&tsym=USDT&limit=2000&toTs=${toTs}`;
    const json = await getJson(url);
    if (json.Response === 'Error') throw new Error(`cryptocompare: ${json.Message}`);
    const rows = json.Data?.Data || [];
    if (!rows.length) break;
    for (const r of rows) {
      if (r.open === 0 && r.close === 0) continue;
      out.push({ time: r.time * 1000, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volumefrom });
    }
    const earliest = rows[0].time;
    if (earliest <= startSec) break;
    toTs = earliest - 1;
  }
  return dedupSort(out, start);
}

const SOURCES = [
  { name: 'binance', fn: binance },
  { name: 'okx', fn: okx },
  { name: 'cryptocompare', fn: cryptocompare },
];

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const end = Date.now();
  const start = end - DAYS * 86400e3;
  console.log(PROXY ? 'transport: curl via KLINES_PROXY' : 'transport: direct fetch');

  let chosen = null;
  for (const src of SOURCES) {
    try {
      process.stdout.write(`probing ${src.name} ... `);
      const bars = await src.fn(symbols[0], start, end);
      if (bars.length > 100) {
        chosen = src;
        console.log(`ok (${bars.length} bars)`);
        break;
      }
      console.log(`too few bars (${bars.length})`);
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }
  if (!chosen) throw new Error('all data sources failed/blocked');
  console.log(`source: ${chosen.name}\n`);

  for (const symbol of symbols) {
    process.stdout.write(`fetching ${symbol} ${interval} ${DAYS}d ... `);
    const bars = await chosen.fn(symbol, start, end);
    const file = join(DATA_DIR, `${symbol}-${interval}.json`);
    await writeFile(file, JSON.stringify({ symbol, interval, days: DAYS, source: chosen.name, bars }));
    console.log(`${bars.length} bars -> ${file}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
