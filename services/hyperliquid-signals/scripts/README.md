# Backtest scripts

## One-time setup

After deploying the price logger, wait at least 30 min so a few rows land in `hl_signals_prices`. Then backfill historical prices:

```bash
cd services/hyperliquid-signals
MONGODB_URI=... python -m scripts.backfill_prices --days 30
```

This pulls 5m candles from Hyperliquid's public `candleSnapshot` API for every coin that appears in `hl_signals_coin_metrics` and upserts them into `hl_signals_prices`. Idempotent — safe to re-run.

## Run the backtest

```bash
MONGODB_URI=... python -m scripts.backtest --horizons 1,4,24,72 --out backtest_report.md
```

Outputs a markdown table showing, for each trigger:
- N events found
- Win rate at each horizon
- Mean and median forward return

## Triggers evaluated

**Whale events (from `hl_signals_whale_events`):**
- `WHALE_WAKEUP` — dormant Q1 trader opens
- `WHALE_SCALEUP` — Q1 trader grows position
- `WHALE_FLIP` — Q1 trader reverses side
- `WHALE_EXIT` — Q1 trader closes (we test fading the prior side)
- `WHALE_LEVERAGE_PUSH` — Q1 trader cranks leverage

**Threshold crossings (synthesised from `hl_signals_coin_metrics`):**
- `L:S≥5/10/20 (long)` and the short equivalents
- `Q1_long≥10`
- `dollar_conv≥70%`
- `cohort_part≥30%`
- `avg_lev≥10x`
- `Q1−Q4 divergence ≥40pp`

**Composite:**
- `WAKEUP + L:S≥10` — wakeup happening into already-built conviction

## Interpreting the output

A row with high win-rate AND high mean return AND ≥20 trades is a candidate live trigger. Watch for:
- High win-rate but tiny mean → noise, not edge
- Big mean but low win-rate → few outliers driving it; check median
- < 10 trades at any horizon → not enough data yet, wait more days
