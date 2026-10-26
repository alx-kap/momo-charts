# momo charts

**Self-hosted, TradingView-style stock charts for swing traders.** Watchlists, drawings,
indicators, a screener for every US stock and price alerts, all running on your own computer.
Live prices and 20 years of daily history come from your Charles Schwab account.

Open source (Apache 2.0) · Python and FastAPI · plain JavaScript, no build step ·
charts drawn with [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/)

![momo charts: an NVDA daily chart with moving averages and earnings markers, a watchlist with prices and days to earnings, and NVIDIA's quarterly fundamentals](docs/screenshots/hero.png)

## Why momo charts

- **Your data, on your machine.** No subscription and no account with us. momo keeps its own
  database of daily bars and talks only to Schwab (prices) and free public sources: Nasdaq
  (symbols, earnings dates), SEC EDGAR (fundamentals) and the CFTC (futures positioning).
- **Feels like TradingView and TC2000.** Start typing a ticker to open it, type `5` or `1W` to
  change the timeframe, `⌥T` for a trend line, `Ctrl+K` for every command. Press `?` for the
  full list.
- **Built for momentum swing trading.** ADR %, dollar volume, relative volume, distance from
  highs, days to earnings and quarterly EPS and sales growth sit next to every chart and in
  every list.
- **Free data if you have a Schwab account.** The Schwab Trader API's market data comes with a
  brokerage account at no extra cost.

## Features

### Charts

- Daily, weekly and monthly charts, plus 1-minute to 1-hour intraday with pre- and
  post-market sessions shaded.
- Split view: two charts side by side, each with its own symbol and timeframe, with the
  symbol and crosshair synced or not.
- Indicators: simple and exponential moving averages, VWAP, Bollinger Bands, Keltner Channels,
  RSI, MACD, ATR, ADR %, a relative strength line against SPY, high-volume closes, and
  earnings dates on the time axis.
- Drawing tools: trend lines, rays, horizontal and vertical lines, rectangles, arrows, text
  and a measure tool. Drawings are saved per symbol.
- Bar Replay: step a chart forward from any past day.
- Live prices update the forming daily bar, a pre- and post-market price tag and a ghost
  candle.
- Chart settings in the style of TradingView: colours, scales (log, inverted), the status
  line, and a picture of the chart copied to the clipboard.

![Split view: Broadcom on daily and weekly charts side by side, each with its own moving averages and volume](docs/screenshots/split-view.png)

### Watchlists

- Several lists with live prices, change, volume, ADR, earnings countdowns and fundamentals
  columns that you can sort, resize and reorder.
- A built-in Flagged list (`⇧F` flags the chart's symbol), and `↓` / `↑` to step through a
  list.
- A details panel for the selected stock: price, 52-week range, returns over 1 week to 1 year,
  and eight quarters and three years of EPS and sales with year-over-year growth.

### Screener

Filter every US-listed stock on your own rules, like a TC2000 scan: returns and return ranks
over 1 day to 6 months, ADR, dollar volume, relative volume, moving-average positions and
stacking, distance from highs and lows, new highs, earnings timing, and EPS and sales growth.
Start from built-in starters (breakouts on volume, pullbacks to the 20-day, top 1/3/6-month
gainers, growth leaders...) or save your own. During the session, a live mode re-screens on
today's prices. Results work like a watchlist: click to chart, step with the arrow keys.

![The screener: top 1, 3 and 6-month gainers with at least $60M of daily dollar volume, sorted by 1-month return](docs/screenshots/screener.png)

### Market

- **Industries:** which industries are leading and lagging today, this week, this month and
  over three months, with each industry's stocks one click away.
- **Positioning:** where commercials (hedgers), large speculators (hedge funds and CTAs) and
  small traders stand in each futures market, from the CFTC's weekly Commitments of Traders
  report.

![The Market panel: industries ranked by today's median return, oil and gas leading, travel and life insurance lagging](docs/screenshots/market.png)

### Price alerts

Set an alert from the chart (`⌥A`) and drag its line to move it. Alerts are checked on the server
against live quotes, so they fire with a sound in every open tab, even when the symbol isn't
on screen.

## Quick start

You need Python 3.12, [uv](https://docs.astral.sh/uv/) and a Schwab brokerage account.

```bash
git clone https://github.com/alx-kap/momo-charts.git
cd momo-charts
uv sync
uv run momo serve
```

Open http://127.0.0.1:8790. The first time, the Market data window asks for your Schwab app's
keys and then a sign-in.

### Setting up Schwab (once)

1. Sign in at [developer.schwab.com](https://developer.schwab.com) with your Schwab login and
   create an app with **Market Data Production**. Add **Accounts and Trading Production** to
   stream quotes instead of polling them. Use the callback URL `https://127.0.0.1:8182` and an
   order limit of 0 (momo never places orders).
2. Wait for Schwab to approve the app, usually a few days. Its page then shows an **App Key**
   and a **Secret**.
3. Paste both into momo's Market data window and click **Save and connect**.
4. Click **Sign in to Schwab…**, approve at Schwab, then paste the address of the page that
   fails to load (it carries the sign-in code). The sign-in lasts 7 days; the live badge in the
   top bar warns a day ahead.

![The first-run Market data window: fields for the Schwab app key, secret and callback URL](docs/screenshots/first-run.png)

## How the data works

Everything lives in `data/` on your computer.

- **Daily bars (`bars.db`):** the list of every US-listed stock comes from Nasdaq's public
  symbol directory, with sectors, industries and market caps from Nasdaq's screener. History
  (about 20 years a symbol, split-adjusted) comes from Schwab, biggest companies first. The
  first full fill takes about an hour; any chart you open fills at once. After each close,
  momo adds the day's bar, catches splits and refetches those symbols, and on Saturdays
  re-checks the last two weeks. Expect 1 to 3 GB on disk.
- **Intraday bars (`intraday.db`):** fetched from Schwab when an intraday chart opens, then kept
  current from the live stream.
- **Your settings (`momo.db`):** watchlists, drawings, chart settings, saved screens and
  alerts.
- **Your Schwab keys and sign-in (`live.toml`, `schwab_tokens.json`):** readable only by your
  user account.

Two optional data sets, each one command:

- **Earnings dates and fundamentals:** `uv run momo fundamentals-update` (SEC EDGAR and Nasdaq).
  SEC asks for a contact address: set `user_agent = "momo you@example.com"` under
  `[fundamentals]` in `config/momo.toml`.
- **Futures positioning:** `uv run momo cot-update` (the CFTC's weekly report).

## Using another data provider

Daily bars are read from the tables that `src/momo_scan/bars.py` creates, through
`src/momo_scan/providers/sqlite.py`. Live prices come through a provider in
`src/momo_scan/live/` (the interface is in `live/base.py`). To use another vendor, add a live
provider with `daily()` history and `sweep()` quotes like `live/schwab.py`, or fill `bars.db`
yourself.

## FAQ

**Is this a TradingView alternative?** For charting, watchlists and screening US stocks on
daily and intraday bars, yes: it borrows TradingView's keys, look and tools. It doesn't have
TradingView's social features, Pine Script, or markets beyond US stocks and ETFs.

**Does it trade?** No. momo only reads market data. The Schwab app it uses is created with an
order limit of 0.

**Do I need Schwab?** Today, yes: Schwab supplies the prices and history. Other data providers
can be added (see above).

**Where does it run?** Anywhere Python 3.12 runs. It's developed on Linux and used from a
browser on a Mac. The server listens on your own computer only (127.0.0.1) unless you choose
otherwise.

**Is it affiliated with TradingView or Charles Schwab?** No. TradingView Lightweight Charts™ is
used under its Apache 2.0 licence; Schwab data is used through your own developer app.

## Development

```bash
uv run --extra dev pytest
uv run --extra dev ruff check src tests tools
```

The browser code is plain ES modules in `src/momo_scan/web/static/js/`, with no build step.
momo charts is the charting part of a personal trading workbench and is published as it
develops.

## License

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). Charts are drawn with
[TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/), also
Apache 2.0.
