// Technical indicators. Every function returns an array aligned 1:1 with the input
// series; warm-up slots are `null` so callers can guard `=== null` instead of guessing
// offsets. No look-ahead: value at index i uses only data at indices <= i.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      // seed with SMA of the first `period` values
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += values[j];
    mean /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

// Wilder's RSI.
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

// True Range series (index 0 is null).
export function trueRange(bars) {
  const out = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const pc = bars[i - 1].close;
    out[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return out;
}

// Wilder's ATR.
export function atr(bars, period = 14) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(null);
  let prev = null;
  let seed = 0;
  let count = 0;
  for (let i = 1; i < bars.length; i++) {
    if (prev === null) {
      seed += tr[i];
      count++;
      if (count === period) {
        prev = seed / period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
  }
  return out;
}

// Bollinger Bands: { mid, upper, lower } aligned arrays.
export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] !== null && sd[i] !== null) {
      upper[i] = mid[i] + mult * sd[i];
      lower[i] = mid[i] - mult * sd[i];
    }
  }
  return { mid, upper, lower };
}

// MACD: { macd, signal, hist }.
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null,
  );
  // Build signal as EMA over the defined macd values.
  const signal = new Array(closes.length).fill(null);
  const k = 2 / (signalPeriod + 1);
  let prev = null;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] === null) continue;
    if (prev === null) {
      seedSum += macdLine[i];
      seedCount++;
      if (seedCount === signalPeriod) {
        prev = seedSum / signalPeriod;
        signal[i] = prev;
      }
    } else {
      prev = macdLine[i] * k + prev * (1 - k);
      signal[i] = prev;
    }
  }
  const hist = closes.map((_, i) =>
    macdLine[i] !== null && signal[i] !== null ? macdLine[i] - signal[i] : null,
  );
  return { macd: macdLine, signal, hist };
}

// Donchian channel over the PRIOR `period` bars (excludes current bar to avoid
// the trivial "today is its own breakout" look-ahead).
export function donchian(bars, period = 20) {
  const upper = new Array(bars.length).fill(null);
  const lower = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period; j < i; j++) {
      if (bars[j].high > hh) hh = bars[j].high;
      if (bars[j].low < ll) ll = bars[j].low;
    }
    upper[i] = hh;
    lower[i] = ll;
  }
  return { upper, lower };
}

// Stochastic oscillator: { k, d }.
export function stochastic(bars, kPeriod = 14, dPeriod = 3) {
  const kArr = new Array(bars.length).fill(null);
  for (let i = kPeriod - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (bars[j].high > hh) hh = bars[j].high;
      if (bars[j].low < ll) ll = bars[j].low;
    }
    kArr[i] = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
  }
  const d = sma(kArr.map((v) => (v === null ? 0 : v)), dPeriod).map((v, i) =>
    i >= kPeriod - 1 + dPeriod - 1 ? v : null,
  );
  return { k: kArr, d };
}

// ADX with +DI/-DI (Wilder).
export function adx(bars, period = 14) {
  const len = bars.length;
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  const tr = trueRange(bars);
  for (let i = 1; i < len; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const smooth = (arr) => {
    const out = new Array(len).fill(null);
    let prev = null;
    let seed = 0;
    let count = 0;
    for (let i = 1; i < len; i++) {
      const v = arr[i] === null ? 0 : arr[i];
      if (prev === null) {
        seed += v;
        count++;
        if (count === period) {
          prev = seed;
          out[i] = prev;
        }
      } else {
        prev = prev - prev / period + v;
        out[i] = prev;
      }
    }
    return out;
  };
  const trS = smooth(tr);
  const plusS = smooth(plusDM);
  const minusS = smooth(minusDM);
  const plusDI = new Array(len).fill(null);
  const minusDI = new Array(len).fill(null);
  const dx = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    if (trS[i] && trS[i] !== 0) {
      plusDI[i] = (plusS[i] / trS[i]) * 100;
      minusDI[i] = (minusS[i] / trS[i]) * 100;
      const sum = plusDI[i] + minusDI[i];
      dx[i] = sum === 0 ? 0 : (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100;
    }
  }
  // ADX = Wilder-smoothed DX.
  const adxArr = new Array(len).fill(null);
  let prev = null;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < len; i++) {
    if (dx[i] === null) continue;
    if (prev === null) {
      seed += dx[i];
      count++;
      if (count === period) {
        prev = seed / period;
        adxArr[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + dx[i]) / period;
      adxArr[i] = prev;
    }
  }
  return { adx: adxArr, plusDI, minusDI };
}

// Supertrend: returns { trend: +1/-1, line }.
export function supertrend(bars, period = 10, mult = 3) {
  const atrArr = atr(bars, period);
  const len = bars.length;
  const trend = new Array(len).fill(null);
  const line = new Array(len).fill(null);
  let prevUpper = null;
  let prevLower = null;
  let prevTrend = 1;
  for (let i = 0; i < len; i++) {
    if (atrArr[i] === null) continue;
    const hl2 = (bars[i].high + bars[i].low) / 2;
    let upper = hl2 + mult * atrArr[i];
    let lower = hl2 - mult * atrArr[i];
    if (prevUpper !== null) {
      upper = upper < prevUpper || bars[i - 1].close > prevUpper ? upper : prevUpper;
      lower = lower > prevLower || bars[i - 1].close < prevLower ? lower : prevLower;
    }
    let t = prevTrend;
    if (prevUpper !== null) {
      if (prevTrend === 1 && bars[i].close < prevLower) t = -1;
      else if (prevTrend === -1 && bars[i].close > prevUpper) t = 1;
    }
    trend[i] = t;
    line[i] = t === 1 ? lower : upper;
    prevUpper = upper;
    prevLower = lower;
    prevTrend = t;
  }
  return { trend, line };
}

// Keltner channel: { mid, upper, lower } (EMA +/- mult*ATR).
export function keltner(bars, period = 20, mult = 2) {
  const closes = bars.map((b) => b.close);
  const mid = ema(closes, period);
  const atrArr = atr(bars, period);
  const upper = new Array(bars.length).fill(null);
  const lower = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    if (mid[i] !== null && atrArr[i] !== null) {
      upper[i] = mid[i] + mult * atrArr[i];
      lower[i] = mid[i] - mult * atrArr[i];
    }
  }
  return { mid, upper, lower };
}

// Rate of change (momentum) in percent over `period` bars.
export function roc(closes, period = 10) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i - period] === 0 ? null : ((closes[i] - closes[i - period]) / closes[i - period]) * 100;
  }
  return out;
}

// Rolling z-score of close vs its own SMA/stdev.
export function zscore(closes, period = 20) {
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  return closes.map((c, i) =>
    mid[i] !== null && sd[i] && sd[i] !== 0 ? (c - mid[i]) / sd[i] : null,
  );
}

// Rolling VWAP over `period` bars using typical price.
export function vwap(bars, period = 20) {
  const out = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let pv = 0;
    let vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (bars[j].high + bars[j].low + bars[j].close) / 3;
      pv += tp * bars[j].volume;
      vol += bars[j].volume;
    }
    out[i] = vol === 0 ? null : pv / vol;
  }
  return out;
}

export function highest(bars, period, field = 'high') {
  const out = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    for (let j = i - period + 1; j <= i; j++) if (bars[j][field] > hh) hh = bars[j][field];
    out[i] = hh;
  }
  return out;
}

export function lowest(bars, period, field = 'low') {
  const out = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) if (bars[j][field] < ll) ll = bars[j][field];
    out[i] = ll;
  }
  return out;
}
