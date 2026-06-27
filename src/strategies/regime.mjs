// Regime-aware composite strategies. The v1 finding was that single-indicator strategies have
// no standalone edge after costs — they fire trend signals in chop and mean-revert into trends.
// These gate each behaviour by market regime (ADX) and/or demand multi-indicator confirmation,
// which is where any real edge in standard TA tends to live. Same target-position contract:
// generate(bars) -> Array<-1|0|1> decided at close of bar i, acted on at open of i+1.

import { rsi, adx, bollinger, keltner, supertrend, zscore, ema } from '../engine/indicators.mjs';

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// A) RSI mean-reversion, but ONLY in a ranging market (ADX low). Bail if a trend forms.
function rsiRangeFiltered(bars, period = 14, lo = 30, hi = 70, adxRange = 22, adxTrend = 28) {
  const c = bars.map((b) => b.close);
  const r = rsi(c, period);
  const { adx: a } = adx(bars, 14);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (r[i] !== null && a[i] !== null) {
      if (pos === 0) {
        if (a[i] < adxRange) {
          if (r[i] < lo) pos = 1;
          else if (r[i] > hi) pos = -1;
        }
      } else if ((pos === 1 && r[i] >= 50) || (pos === -1 && r[i] <= 50) || a[i] > adxTrend) {
        pos = 0; // hit mean, or a trend is forming — get out
      }
    }
    out[i] = pos;
  }
  return out;
}

// B) EMA 12/26 crossover, but ONLY when ADX confirms a trend; flat otherwise.
function trendAdxGated(bars, fast = 12, slow = 26, level = 25) {
  const c = bars.map((b) => b.close);
  const f = ema(c, fast);
  const s = ema(c, slow);
  const { adx: a } = adx(bars, 14);
  return bars.map((_, i) => {
    if (f[i] === null || s[i] === null || a[i] === null) return 0;
    return a[i] >= level ? sign(f[i] - s[i]) : 0;
  });
}

// C) Regime switch: trend regime -> follow Supertrend; range regime -> z-score mean-revert;
// dead zone (20-25) -> hold whatever we have.
function regimeSwitch(bars) {
  const c = bars.map((b) => b.close);
  const z = zscore(c, 20);
  const { adx: a } = adx(bars, 14);
  const { trend } = supertrend(bars, 10, 3);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (a[i] === null || z[i] === null || trend[i] === null) {
      out[i] = pos;
      continue;
    }
    if (a[i] > 25) {
      pos = trend[i]; // always-in with the trend
    } else if (a[i] < 20) {
      if (pos === 0) {
        if (z[i] < -1) pos = 1;
        else if (z[i] > 1) pos = -1;
      } else if ((pos === 1 && z[i] >= 0) || (pos === -1 && z[i] <= 0)) {
        pos = 0; // reverted to mean
      }
    } // else dead zone: hold
    out[i] = pos;
  }
  return out;
}

// D) Dual-confirmation mean reversion: need RSI extreme AND price outside the Bollinger band.
function dualConfirmMeanRev(bars, rsiLo = 35, rsiHi = 65, bbPeriod = 20, bbMult = 2) {
  const c = bars.map((b) => b.close);
  const r = rsi(c, 14);
  const { mid, upper, lower } = bollinger(c, bbPeriod, bbMult);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (r[i] !== null && mid[i] !== null) {
      if (pos === 0) {
        if (r[i] < rsiLo && c[i] < lower[i]) pos = 1;
        else if (r[i] > rsiHi && c[i] > upper[i]) pos = -1;
      } else if ((pos === 1 && c[i] >= mid[i]) || (pos === -1 && c[i] <= mid[i])) {
        pos = 0;
      }
    }
    out[i] = pos;
  }
  return out;
}

// E) Bollinger/Keltner squeeze breakout: when BB is inside Keltner (low vol), wait for the
// squeeze to release and take the breakout in the direction of price vs the basis.
function squeezeBreakout(bars, period = 20, bbMult = 2, kcMult = 1.5) {
  const c = bars.map((b) => b.close);
  const bb = bollinger(c, period, bbMult);
  const kc = keltner(bars, period, kcMult);
  const out = new Array(bars.length).fill(0);
  let pos = 0;
  let prevSqueeze = false;
  for (let i = 0; i < bars.length; i++) {
    if (bb.upper[i] !== null && kc.upper[i] !== null) {
      const squeeze = bb.upper[i] < kc.upper[i] && bb.lower[i] > kc.lower[i];
      if (prevSqueeze && !squeeze) {
        pos = c[i] > bb.mid[i] ? 1 : -1; // release -> breakout direction
      } else if ((pos === 1 && c[i] < bb.mid[i]) || (pos === -1 && c[i] > bb.mid[i])) {
        pos = 0; // basis cross back -> exit
      }
      prevSqueeze = squeeze;
    }
    out[i] = pos;
  }
  return out;
}

export const REGIME_STRATEGIES = [
  { key: 'rsi_range_filtered', name: 'RSI mean-rev (range only, ADX<22)', category: 'regime', generate: (b) => rsiRangeFiltered(b) },
  { key: 'trend_adx_gated', name: 'EMA cross (trend only, ADX>25)', category: 'regime', generate: (b) => trendAdxGated(b) },
  { key: 'regime_switch', name: 'Regime switch (trend↔range)', category: 'regime', generate: (b) => regimeSwitch(b) },
  { key: 'dual_confirm_meanrev', name: 'Dual-confirm mean-rev (RSI+BB)', category: 'regime', generate: (b) => dualConfirmMeanRev(b) },
  { key: 'squeeze_breakout', name: 'BB/Keltner squeeze breakout', category: 'regime', generate: (b) => squeezeBreakout(b) },
];
