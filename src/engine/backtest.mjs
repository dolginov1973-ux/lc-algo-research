// Event-driven backtester. Target-position model, strictly no look-ahead:
//   positions[i] is the position {-1 short, 0 flat, +1 long} DECIDED at the close
//   of bar i, and it governs what we hold starting at the OPEN of bar i+1.
// Fills happen at the next bar's open with slippage; taker fee charged on entry and
// exit notional. Sizing is fixed-fractional of current equity (compounding), leverage
// kept at 1x in the backtest so strategies compare on equal footing — real leverage is
// a live-execution multiplier that scales return AND drawdown together.

const DEFAULTS = {
  initialEquity: 10000,
  feeRate: 0.0006, // Bitunix futures taker ~0.06%
  slippage: 0.0005, // 5 bps each fill (alt futures); tune per symbol later
  positionPct: 1.0, // notional = equity * positionPct
};

export function runBacktest(bars, positions, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const n = bars.length;
  let equity = cfg.initialEquity;
  let curPos = 0; // -1 / 0 / +1
  let entryPrice = 0;
  let qty = 0; // positive notional units (dir tracked separately)
  let entryEquity = 0;
  let entryIndex = 0;

  const trades = [];
  const equityCurve = new Array(n).fill(cfg.initialEquity);
  let feesPaid = 0;

  const openPos = (dir, rawPrice, i) => {
    entryPrice = rawPrice * (1 + dir * cfg.slippage);
    const notional = equity * cfg.positionPct;
    qty = notional / entryPrice;
    const fee = cfg.feeRate * notional;
    equity -= fee;
    feesPaid += fee;
    entryEquity = equity;
    entryIndex = i;
    curPos = dir;
  };

  const closePos = (rawPrice, i) => {
    const exitPrice = rawPrice * (1 - curPos * cfg.slippage);
    const gross = qty * (exitPrice - entryPrice) * curPos;
    const exitNotional = qty * exitPrice;
    const fee = cfg.feeRate * exitNotional;
    equity += gross - fee;
    feesPaid += fee;
    trades.push({
      dir: curPos,
      entryIndex,
      exitIndex: i,
      entryPrice,
      exitPrice,
      barsHeld: i - entryIndex,
      pnl: gross - fee,
      retPct: (gross - fee) / entryEquity,
    });
    curPos = 0;
    qty = 0;
  };

  for (let i = 1; i < n; i++) {
    const desired = positions[i - 1] == null ? 0 : positions[i - 1];
    const openPrice = bars[i].open;

    if (desired !== curPos) {
      if (curPos !== 0) closePos(openPrice, i);
      if (desired !== 0) openPos(desired, openPrice, i);
    }

    const mark = bars[i].close;
    const unreal = curPos !== 0 ? qty * (mark - entryPrice) * curPos : 0;
    equityCurve[i] = equity + unreal;
  }

  // Close any residual position at the final close.
  if (curPos !== 0) {
    closePos(bars[n - 1].close, n - 1);
    equityCurve[n - 1] = equity;
  }

  return { equity, equityCurve, trades, feesPaid, config: cfg };
}
