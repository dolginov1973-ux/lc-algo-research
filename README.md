# lc-algo-research (Infra A — paper / backtest)

Research harness for the Lifechange Crypto algo copy-trading project. It fetches ~90 days of
OHLCV, runs a basket of standard strategies through a **no-look-ahead** backtester (fees +
slippage netted out), ranks them, and picks the **top-5** candidates that graduate to Infra B
(the live executor) for forward/paper testing before any real size.

This is the **paper** half. The **live** half lives in a separate repo (`lc-algo-trader`,
Infra B) so research can never accidentally place a real order.

## Why CI, not local

The operator's RU ISP blocks Binance/Bitunix endpoints. Data fetching runs from a datacenter
IP (GitHub Actions). The engine itself is pure and runs anywhere — `npm test` works offline.

## Run

```bash
npm test                 # offline: engine + indicators + no-look-ahead checks
npm run fetch            # datacenter IP only: pull 90d klines into data/
npm run backtest         # rank all strategies over data/, write reports/latest.json
```

Or trigger the `backtest` workflow (Actions tab) — it does fetch + rank + commits the report.

## Method (honest, not a profit pitch)

- **No look-ahead:** a signal at the close of bar *i* is only acted on at the open of bar *i+1*.
  The smoke test proves it — mutating the last bar changes no earlier signal.
- **Costs are real:** 0.06% taker fee + 5bps slippage on every fill. On random-walk noise the
  engine *loses to fees by design* — no fake edge.
- **Ranking:** Sharpe-led, drawdown-taxed, profit-factor nudge; strategies with too few trades
  are disqualified (overfit guard).
- A good backtest is necessary, not sufficient. Top-5 still must survive forward/paper and
  micro-size live before any follower money is involved. No edge is guaranteed.

## Strategies

17 single-position strategies are implemented (trend / breakout / momentum / mean-reversion).
4 are stubbed pending a layered-position engine or extra data: `grid`, `dca_martingale`,
`breakout_retest`, `funding_arb` — registered so they're tracked, all-flat so they never fake a
win. See `src/strategies/index.mjs`.

## Hyperliquid copy-signal source (on-chain top-trader following)

A second, probably stronger, alpha source than standard TA: mirror a proven directional trader.
Hyperliquid is a fully on-chain perp DEX — every trader's positions and fills are public and
verifiable, so leaderboards can't be faked the way centralized ones can.

```bash
node src/hyperliquid/rank-traders.mjs 15      # find copyable directional traders (not MMs/vaults)
node src/hyperliquid/track.mjs <address>      # live positions + recent fills for one trader
node src/hyperliquid/watch.mjs <address>      # diff vs last snapshot -> OPEN/CLOSE/FLIP/RESIZE signals
```

The leaderboard is a coarse, stale prefilter (its all-time ROI is garbage-inflated; a top-ranked
account can already be flat/withdrawn) — `track`/`watch` verify the LIVE on-chain state every time.
`watch` is the copy feed: run it on an interval, it emits structured signals an executor mirrors.
First run records a baseline silently (you don't copy an entry you already missed).

## Layout

```
src/engine/indicators.mjs   SMA/EMA/RSI/ATR/Bollinger/MACD/Donchian/Stoch/ADX/Supertrend/...
src/engine/backtest.mjs     event-driven, target-position model, fees+slippage, compounding
src/engine/metrics.mjs      return / Sharpe / maxDD / winrate / PF / expectancy + score()
src/strategies/index.mjs    strategy registry (17 live + 4 stubs)
src/data/fetch-klines.mjs   90d OHLCV -> data/<symbol>-<interval>.json
src/run-backtest.mjs        rank everything in data/, write report
test/engine-smoke.mjs       offline correctness + no-look-ahead suite
```
