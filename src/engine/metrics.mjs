// Performance metrics derived from a backtest result. Everything is AFTER fees+slippage
// (the backtester already nets them out). Sharpe is annualized from per-bar equity
// returns using the bar timeframe; maxDD is on the marked-to-market equity curve.

const BARS_PER_YEAR = {
  '1m': 525600,
  '5m': 105120,
  '15m': 35040,
  '30m': 17520,
  '1h': 8760,
  '2h': 4380,
  '4h': 2190,
  '1d': 365,
};

export function computeMetrics(result, timeframe = '1h') {
  const { equityCurve, trades, config, feesPaid } = result;
  const initial = config.initialEquity;
  const final = equityCurve[equityCurve.length - 1];
  const totalReturnPct = (final / initial - 1) * 100;

  // Per-bar returns for Sharpe.
  const rets = [];
  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i - 1] > 0) rets.push(equityCurve[i] / equityCurve[i - 1] - 1);
  }
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance = rets.length
    ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length
    : 0;
  const std = Math.sqrt(variance);
  const bpy = BARS_PER_YEAR[timeframe] || 8760;
  const sharpe = std === 0 ? 0 : (mean / std) * Math.sqrt(bpy);

  // Max drawdown on the equity curve.
  let peak = -Infinity;
  let maxDD = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Trade stats.
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const winRate = trades.length ? wins.length / trades.length : 0;
  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss;
  const avgTradePct = trades.length
    ? (trades.reduce((a, t) => a + t.retPct, 0) / trades.length) * 100
    : 0;
  const expectancy =
    trades.length === 0
      ? 0
      : winRate * (wins.length ? grossWin / wins.length : 0) -
        (1 - winRate) * (losses.length ? grossLoss / losses.length : 0);

  return {
    totalReturnPct,
    sharpe,
    maxDDPct: maxDD * 100,
    winRatePct: winRate * 100,
    profitFactor,
    numTrades: trades.length,
    avgTradePct,
    expectancy,
    feesPaid,
    finalEquity: final,
  };
}

// Composite ranking score. Rewards risk-adjusted return, penalizes drawdown, and
// disqualifies strategies with too few trades (overfit / not enough evidence).
export function score(m, minTrades = 20) {
  if (m.numTrades < minTrades) return -Infinity;
  if (!isFinite(m.sharpe)) return -Infinity;
  const pf = isFinite(m.profitFactor) ? Math.min(m.profitFactor, 5) : 5;
  // Sharpe-led, drawdown-taxed, profit-factor nudge. Negative-return strategies sink.
  return m.sharpe - m.maxDDPct / 50 + (pf - 1) * 0.5 + m.totalReturnPct / 200;
}
