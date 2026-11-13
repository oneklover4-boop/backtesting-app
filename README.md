# Tape Replay

A bar-by-bar futures backtesting app for MNQ, NQ, ES and MES. It runs entirely in the browser: open `index.html` and start replaying.

## What it does

- **Replay**: step bar by bar (→), play at 1 to 25 bars a second (P), or jump to the next 09:30 ET open.
- **Timeframes**: 15s, 30s, 1m, 3m, 5m, 15m, 30m, 1H, 4H, 1D, 1W, 1 month. Jump forward to any date. Type a number and Enter (minutes) or a number plus S/H/D to switch, like TradingView.
- **Orders**: market, limit and stop. Size by risk % of balance or by contracts. Stop loss and take profit in points, with draggable lines on the chart before and after entry. Move stop to entry, close, or cancel from the positions strip. B / S keys buy and sell.
- **Sessions**: each backtest session has its own balance, instruments, start date, default risk and commission.
- **Journal**: every closed trade with entry, exit, stop, target, exit reason, P&L, R multiple, MAE/MFE, hold time, notes and tags. Copy as CSV.
- **Analytics**: net P&L, win rate, profit factor, expectancy, average R, average win/loss, max drawdown, streaks, commissions, equity curve, P&L by weekday and hour, long vs short, R distribution, daily P&L calendar. Per session or across all sessions.

## Data

The app ships with **generated sample data** (15-second bars, March to April 2025 dates) so it works out of the box. It is not real market history.

To backtest on real data, go to **Sessions → Market data**, pick the instrument and select one or more CSV files. The importer reads:

- **Databento** CSV exports (OHLCV-1m or OHLCV-1s; nanosecond UTC timestamps and fixed-point prices are handled, calendar spreads are skipped, and when a file holds several contract months the most active contract is kept each day)
- **FirstRate Data** and other CSVs with `time,open,high,low,close,volume` (with or without a header, date and time in one or two columns)

UTC times are converted to New York time. 1-second data is rolled up into 15-second bars. Tested with 1.75M one-minute bars (2022 to 2026): about 3 seconds to import.

Imported data stays in your browser (IndexedDB). Do not commit market data files to this repo: it is public, and data licenses do not allow redistribution.

## Fill rules

- Market orders fill at the last price. Limit and stop orders fill at their price, or at the bar's open if price gapped through.
- Stops and targets are checked from the bar after entry. If one bar touches both, the stop is assumed to hit first (conservative).
- Commission is charged per contract per side.

## Where your data is saved

Sessions and trades are saved in your browser's local storage. Use **Sessions → Backup** to copy a backup you can restore anywhere.

Charts by [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache 2.0, bundled in `vendor/`).
