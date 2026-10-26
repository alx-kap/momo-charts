# momo charts

TradingView-style stock charts that run on your own computer, with your own data: watchlists,
drawings, indicators, split view, a screener, price alerts and market panels. Prices come from
your Schwab account; momo builds and keeps its own daily-bar history from it.

This is the charting part of a personal trading workbench, published as it develops.

## What's in it

- **Charts**: daily, weekly, monthly and intraday (1m to 1h, pre- and post-market), split view,
  Bar Replay, drawings, moving averages and other indicators, TradingView's hotkeys (press `?`).
- **Watchlists** with live prices, flags, sortable columns, earnings dates and fundamentals.
- **Screener**: filter every US stock on your own rules (performance, ADR, dollar volume,
  moving averages, earnings growth...) and save the filters. Live filtering during the session.
- **Market**: industry strength, and futures positioning from the CFTC's weekly Commitments of
  Traders.
- **Price alerts** checked against live quotes, with sound.

momo never places orders.

## What you need

- Python 3.12 and [uv](https://docs.astral.sh/uv/).
- A Schwab brokerage account and a Schwab developer app (free):
  1. Sign in at [developer.schwab.com](https://developer.schwab.com) with your Schwab login.
  2. Create an app with **Market Data Production** (add **Accounts and Trading Production** to
     stream quotes instead of polling), order limit 0, callback URL `https://127.0.0.1:8182`.
  3. Wait for Schwab to approve it (usually a few days). Its page then shows an App Key and a
     Secret.

## Run it

```bash
uv sync
uv run momo serve
```

Open http://127.0.0.1:8790. The first time, the Market data window asks for the app's key
and secret, then for a Schwab sign-in (approve at Schwab, then paste the address of the page
that doesn't load). The sign-in lasts 7 days; the live badge warns a day ahead.

## Your data

Everything stays in `data/` on your machine:

- `bars.db`: daily bars. A list of every US-listed stock comes from Nasdaq's public symbol
  directory; history (about 20 years a symbol) from Schwab, biggest companies first, about an
  hour for everything. A chart you open fills at once. Each weekday's bar is added after the
  close, and splits are caught and refetched.
- `momo.db`: your watchlists, drawings, chart settings, screens and alerts.
- `live.toml` and `schwab_tokens.json`: your Schwab keys and sign-in, readable only by you.

Other data:

- Earnings dates and fundamentals: `uv run momo fundamentals-update` (SEC EDGAR and Nasdaq).
  SEC asks for a contact: set `user_agent = "your-app you@example.com"` under
  `[fundamentals]` in `config/momo.toml`.
- Futures positioning: `uv run momo cot-update` (weekly, from the CFTC).

## Using another data service

Daily bars are read through `src/momo_scan/providers/sqlite.py` from the tables
`src/momo_scan/bars.py` creates, and live prices come through a provider in
`src/momo_scan/live/` (see `live/base.py`). To use another vendor, add a live provider with
`daily()` history and `sweep()` quotes like `live/schwab.py`, or fill `bars.db` yourself.

## Development

```bash
uv run --extra dev pytest
uv run --extra dev ruff check src tests tools
```

The browser code is plain ES modules in `src/momo_scan/web/static/js/`, with no build step.

## License

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). Charts are drawn with
[TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/), also
Apache 2.0.
