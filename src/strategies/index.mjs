// Strategy registry. Each strategy: { key, name, category, generate(bars) -> Array<-1|0|1> }
// where the value at index i is the position decided at the CLOSE of bar i (acted on at
// the open of bar i+1 by the backtester — no look-ahead). Mean-reversion strategies carry
// state to hold a position until their exit condition; trend strategies are always-in.
//
// 17 strategies are implemented under the single-position target model. 4 are STUBBED
// (grid, dca_martingale, breakout_retest, funding_arb) because they need a different
// engine (layered positions) or extra data (funding rates) — see STUBS at the bottom.

import {
  sma,
  ema,
  rsi,
  atr,
  bollinger,
  macd,
  donchian,
  stochastic,
  adx,
  supertrend,
  keltner,
  roc,
  zscore,
  vwap,
  highest,
  lowest,
} from '../engine/indicators.mjs';

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// ---- trend / always-in ----

function smaCrossover(bars, fast = 20, slow = 50) {
  const c = bars.map((b) => b.close);
  const f = sma(c, fast);
  const s = sma(c, slow);
  return bars.map((_, i) => (f[i] !== null && s[i] !== null ? sign(f[i] - s[i]) : 0));
}

function emaCrossover(bars, fast = 12, slow = 26) {
  const c = bars.map((b) => b.close);
  const f = ema(c, fast);
  const s = ema(c, slow);
  return bars.map((_, i) => (f[i] !== null && s[i] !== null ? sign(f[i] - s[i]) : 0));
}

function macdCross(bars) {
  const c = bars.map((b) => b.close);
  const { macd: m, signal: sg } = macd(c);
  return bars.map((_, i) => (m[i] !== null && sg[i] !== null ? sign(m[i] - sg[i]) : 0));
}

function donchianBreakout(bars, period = 20) {
  const { upper, lower } = donchian(bars, period);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (upper[i] !== null) {
      if (bars[i].close > upper[i]) pos = 1;
      else if (bars[i].close < lower[i]) pos = -1;
    }
    out[i] = pos;
  }
  return out;
}

function supertrendStrat(bars, period = 10, mult = 3) {
  const { trend } = supertrend(bars, period, mult);
  return bars.map((_, i) => (trend[i] === null ? 0 : trend[i]));
}

function ichimoku(bars) {
  const tenkanH = highest(bars, 9, 'high');
  const tenkanL = lowest(bars, 9, 'low');
  const kijunH = highest(bars, 26, 'high');
  const kijunL = lowest(bars, 26, 'low');
  const sbH = highest(bars, 52, 'high');
  const sbL = lowest(bars, 52, 'low');
  const tenkan = bars.map((_, i) =>
    tenkanH[i] !== null ? (tenkanH[i] + tenkanL[i]) / 2 : null,
  );
  const kijun = bars.map((_, i) => (kijunH[i] !== null ? (kijunH[i] + kijunL[i]) / 2 : null));
  const senkouA = bars.map((_, i) =>
    tenkan[i] !== null && kijun[i] !== null ? (tenkan[i] + kijun[i]) / 2 : null,
  );
  const senkouB = bars.map((_, i) => (sbH[i] !== null ? (sbH[i] + sbL[i]) / 2 : null));
  const out = new Array(bars.length).fill(0);
  for (let i = 26; i < bars.length; i++) {
    const a = senkouA[i - 26];
    const b = senkouB[i - 26];
    if (a == null || b == null || tenkan[i] == null || kijun[i] == null) continue;
    const cloudTop = Math.max(a, b);
    const cloudBot = Math.min(a, b);
    if (bars[i].close > cloudTop && tenkan[i] > kijun[i]) out[i] = 1;
    else if (bars[i].close < cloudBot && tenkan[i] < kijun[i]) out[i] = -1;
    else out[i] = 0;
  }
  return out;
}

function keltnerBreakout(bars, period = 20, mult = 2) {
  const { upper, lower } = keltner(bars, period, mult);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (upper[i] !== null) {
      if (bars[i].close > upper[i]) pos = 1;
      else if (bars[i].close < lower[i]) pos = -1;
    }
    out[i] = pos;
  }
  return out;
}

function bollingerBreakout(bars, period = 20, mult = 2) {
  const c = bars.map((b) => b.close);
  const { upper, lower } = bollinger(c, period, mult);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (upper[i] !== null) {
      if (c[i] > upper[i]) pos = 1;
      else if (c[i] < lower[i]) pos = -1;
    }
    out[i] = pos;
  }
  return out;
}

function momentumRoc(bars, period = 10, thr = 1.0) {
  const c = bars.map((b) => b.close);
  const r = roc(c, period);
  return bars.map((_, i) => (r[i] === null ? 0 : r[i] > thr ? 1 : r[i] < -thr ? -1 : 0));
}

function adxTrendFilter(bars, period = 14, level = 25) {
  const { adx: a, plusDI, minusDI } = adx(bars, period);
  return bars.map((_, i) => {
    if (a[i] === null || a[i] < level) return 0;
    return plusDI[i] > minusDI[i] ? 1 : -1;
  });
}

// Chandelier stop-and-reverse: ATR-based trailing flip.
function atrTrailingTrend(bars, period = 22, mult = 3) {
  const atrArr = atr(bars, period);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  let extreme = null; // running high while long / low while short
  for (let i = 0; i < bars.length; i++) {
    if (atrArr[i] === null) continue;
    const c = bars[i].close;
    if (pos === 0) {
      pos = 1;
      extreme = bars[i].high;
    } else if (pos === 1) {
      extreme = Math.max(extreme, bars[i].high);
      if (c < extreme - mult * atrArr[i]) {
        pos = -1;
        extreme = bars[i].low;
      }
    } else {
      extreme = Math.min(extreme, bars[i].low);
      if (c > extreme + mult * atrArr[i]) {
        pos = 1;
        extreme = bars[i].high;
      }
    }
    out[i] = pos;
  }
  return out;
}

// ---- mean reversion (state held until exit) ----

function rsiMeanRev(bars, period = 14, lo = 30, hi = 70) {
  const c = bars.map((b) => b.close);
  const r = rsi(c, period);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (r[i] !== null) {
      if (pos === 0) {
        if (r[i] < lo) pos = 1;
        else if (r[i] > hi) pos = -1;
      } else if (pos === 1 && r[i] >= 50) pos = 0;
      else if (pos === -1 && r[i] <= 50) pos = 0;
    }
    out[i] = pos;
  }
  return out;
}

function bollingerReversion(bars, period = 20, mult = 2) {
  const c = bars.map((b) => b.close);
  const { mid, upper, lower } = bollinger(c, period, mult);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (mid[i] !== null) {
      if (pos === 0) {
        if (c[i] < lower[i]) pos = 1;
        else if (c[i] > upper[i]) pos = -1;
      } else if (pos === 1 && c[i] >= mid[i]) pos = 0;
      else if (pos === -1 && c[i] <= mid[i]) pos = 0;
    }
    out[i] = pos;
  }
  return out;
}

function stochReversion(bars, kP = 14, dP = 3, lo = 20, hi = 80) {
  const { k } = stochastic(bars, kP, dP);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (k[i] !== null) {
      if (pos === 0) {
        if (k[i] < lo) pos = 1;
        else if (k[i] > hi) pos = -1;
      } else if (pos === 1 && k[i] >= 50) pos = 0;
      else if (pos === -1 && k[i] <= 50) pos = 0;
    }
    out[i] = pos;
  }
  return out;
}

function vwapReversion(bars, period = 20, band = 0.01) {
  const vw = vwap(bars, period);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (vw[i] !== null) {
      const dev = (bars[i].close - vw[i]) / vw[i];
      if (pos === 0) {
        if (dev < -band) pos = 1;
        else if (dev > band) pos = -1;
      } else if (pos === 1 && bars[i].close >= vw[i]) pos = 0;
      else if (pos === -1 && bars[i].close <= vw[i]) pos = 0;
    }
    out[i] = pos;
  }
  return out;
}

function zscoreReversion(bars, period = 20, entry = 2, exit = 0.5) {
  const c = bars.map((b) => b.close);
  const z = zscore(c, period);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (z[i] !== null) {
      if (pos === 0) {
        if (z[i] < -entry) pos = 1;
        else if (z[i] > entry) pos = -1;
      } else if (Math.abs(z[i]) < exit) pos = 0;
    }
    out[i] = pos;
  }
  return out;
}

// Opening-range breakout on the UTC daily session: the first ORB_BARS bars of each
// UTC day define the range; break above -> long, below -> short; flat until next break,
// reset each new day.
function openingRangeBreakout(bars, orBars = 4) {
  const out = new Array(bars.length).fill(0);
  let day = null;
  let count = 0;
  let orHigh = -Infinity;
  let orLow = Infinity;
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = Math.floor(bars[i].time / 86400000);
    if (d !== day) {
      day = d;
      count = 0;
      orHigh = -Infinity;
      orLow = Infinity;
      pos = 0;
    }
    if (count < orBars) {
      orHigh = Math.max(orHigh, bars[i].high);
      orLow = Math.min(orLow, bars[i].low);
      count++;
    } else {
      if (bars[i].close > orHigh) pos = 1;
      else if (bars[i].close < orLow) pos = -1;
    }
    out[i] = pos;
  }
  return out;
}

export const STRATEGIES = [
  { key: 'sma_crossover', name: 'SMA 20/50 crossover', category: 'trend', generate: (b) => smaCrossover(b) },
  { key: 'ema_crossover', name: 'EMA 12/26 crossover', category: 'trend', generate: (b) => emaCrossover(b) },
  { key: 'macd_cross', name: 'MACD signal cross', category: 'trend', generate: (b) => macdCross(b) },
  { key: 'donchian_breakout', name: 'Donchian 20 breakout (Turtle)', category: 'breakout', generate: (b) => donchianBreakout(b) },
  { key: 'supertrend', name: 'Supertrend 10x3', category: 'trend', generate: (b) => supertrendStrat(b) },
  { key: 'ichimoku', name: 'Ichimoku cloud', category: 'trend', generate: (b) => ichimoku(b) },
  { key: 'keltner_breakout', name: 'Keltner 20x2 breakout', category: 'breakout', generate: (b) => keltnerBreakout(b) },
  { key: 'bollinger_breakout', name: 'Bollinger 20x2 breakout', category: 'breakout', generate: (b) => bollingerBreakout(b) },
  { key: 'momentum_roc', name: 'Momentum ROC(10)', category: 'momentum', generate: (b) => momentumRoc(b) },
  { key: 'adx_trend_filter', name: 'ADX(14) DI trend filter', category: 'trend', generate: (b) => adxTrendFilter(b) },
  { key: 'atr_trailing_trend', name: 'ATR chandelier stop-and-reverse', category: 'trend', generate: (b) => atrTrailingTrend(b) },
  { key: 'rsi_meanrev', name: 'RSI(14) mean reversion', category: 'meanrev', generate: (b) => rsiMeanRev(b) },
  { key: 'bollinger_reversion', name: 'Bollinger 20x2 reversion', category: 'meanrev', generate: (b) => bollingerReversion(b) },
  { key: 'stoch_reversion', name: 'Stochastic(14,3) reversion', category: 'meanrev', generate: (b) => stochReversion(b) },
  { key: 'vwap_reversion', name: 'VWAP(20) reversion', category: 'meanrev', generate: (b) => vwapReversion(b) },
  { key: 'zscore_reversion', name: 'Z-score(20) reversion', category: 'meanrev', generate: (b) => zscoreReversion(b) },
  { key: 'opening_range_breakout', name: 'Opening-range breakout (UTC day)', category: 'breakout', generate: (b) => openingRangeBreakout(b) },
];

// STUBS — registered for completeness, excluded from the live run until their engine/data
// is built. grid + dca_martingale need a layered-position engine; breakout_retest needs
// pullback state; funding_arb needs funding-rate data. They return all-flat so they never
// silently "win" with fake numbers.
export const STUB_STRATEGIES = [
  { key: 'breakout_retest', name: 'Breakout + retest (NEEDS pullback engine)', category: 'breakout', stub: true, generate: (b) => new Array(b.length).fill(0) },
  { key: 'grid', name: 'Grid (NEEDS layered-position engine)', category: 'grid', stub: true, generate: (b) => new Array(b.length).fill(0) },
  { key: 'dca_martingale', name: 'DCA / martingale (RISKY, NEEDS layered engine)', category: 'grid', stub: true, generate: (b) => new Array(b.length).fill(0) },
  { key: 'funding_arb', name: 'Funding-rate arb (NEEDS funding data)', category: 'arb', stub: true, generate: (b) => new Array(b.length).fill(0) },
];

export const ALL_STRATEGY_KEYS = [...STRATEGIES, ...STUB_STRATEGIES].map((s) => s.key);
