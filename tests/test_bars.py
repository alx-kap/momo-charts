from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from momo_scan.bars import (
    BarFiller,
    BarStore,
    Listing,
    parse_directory,
    parse_profiles,
    schwab_feed,
)
from momo_scan.config import AppConfig, ProviderConfig, RegimeConfig
from momo_scan.live import Quote, load_live_settings
from momo_scan.live.base import MARKET_TZ
from momo_scan.providers.sqlite import LocalSQLiteProvider
from momo_scan.web.server import create_app

HEADER = (
    "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|"
    "Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares"
)
DIRECTORY = HEADER + """
Y|AAPL|Apple Inc. - Common Stock|Q|Q|N|100|N|N||AAPL|N
Y|BRK.B|Berkshire Hathaway Inc. New Common Stock|N| |N|100|N||BRK.B|BRK.B|N
Y|SPY|State Street SPDR S&P 500 ETF Trust|P| |Y|100|N||SPY|SPY|N
Y|BAC$K|Bank of America Corporation Preferred Series K|N| |N|100|N||BAC$K|BAC$K|N
Y|ACAHW|Acme Acquisition Corp - Warrant|Q|G|N|100|N|N||ACAHW|N
Y|ZZZT|Test Stock Common Stock|Q|G|N|100|Y|N||ZZZT|N
File Creation Time: 1026202608:32|||||"""


def days(start: date, count: int) -> list[date]:
    out, day = [], start
    while len(out) < count:
        if day.weekday() < 5:
            out.append(day)
        day += timedelta(days=1)
    return out


def rows(sessions: list[date], close: float = 100.0) -> list[tuple]:
    return [(day, close, close + 1, close - 1, close, 1_000_000.0) for day in sessions]


SESSIONS = days(date(2026, 9, 1), 39)  # through Friday 2026-10-23


class FakeFeed:
    """Daily history and quotes the test sets up by hand."""

    def __init__(self, history: dict[str, list[tuple]]) -> None:
        self.bars = history
        self.calls: list[tuple[str, date | None]] = []
        self.quotes: list[Quote] = []

    async def history(self, ticker: str, start: date | None, background: bool) -> list[tuple]:
        self.calls.append((ticker, start))
        return [row for row in self.bars.get(ticker, []) if start is None or row[0] >= start]

    async def sweep(self, tickers: list[str]) -> list[Quote]:
        return [quote for quote in self.quotes if quote.symbol in tickers]


def store_with(tmp_path: Path, listings: list[Listing] | None = None) -> BarStore:
    store = BarStore(tmp_path / "bars.db")
    store.save_listings(listings or parse_directory(DIRECTORY), parse_profiles({"data": {"rows": [
        {"symbol": "AAPL", "name": "Apple Inc.", "sector": "Technology",
         "industry": "Computer Manufacturing", "marketCap": "4000000000000.00"},
        {"symbol": "BRK/B", "name": "Berkshire Hathaway", "sector": "Finance",
         "industry": "Insurance", "marketCap": "1000000000000.00"},
    ]}}))
    store.set_meta("listings_at", datetime.now().astimezone().isoformat())
    return store


def at(day: date, hour: int) -> datetime:
    return datetime(day.year, day.month, day.day, hour, tzinfo=MARKET_TZ)


def test_directory_keeps_common_stock_and_marks_the_rest() -> None:
    listings = {item.ticker: item for item in parse_directory(DIRECTORY)}
    assert "ZZZT" not in listings  # test issues are left out
    assert listings["AAPL"].common and listings["AAPL"].exchange == "NASDAQ"
    assert listings["BRK.B"].common and listings["BRK.B"].exchange == "NYSE"
    assert (listings["SPY"].common, listings["SPY"].reason) == (False, "etf_etn")
    assert listings["BAC$K"].reason == "preferred"
    assert listings["ACAHW"].reason == "other"


def test_profiles_use_the_stores_spelling() -> None:
    profiles = parse_profiles({"data": {"rows": [
        {"symbol": "BRK/B", "name": "Berkshire", "sector": "", "industry": "", "marketCap": ""},
    ]}})
    assert profiles == {"BRK.B": {
        "name": "Berkshire", "sector": None, "industry": None, "market_cap": None,
    }}


async def test_the_archive_provider_reads_the_store(tmp_path: Path) -> None:
    store = store_with(tmp_path)
    store.save_bars("SPY", rows(SESSIONS, 600), full=True)
    store.save_bars("AAPL", rows(SESSIONS, 200), full=True)
    store.mark_session()
    config = ProviderConfig(database=str(tmp_path / "bars.db"), minimum_latest_coverage=0.0)
    async with LocalSQLiteProvider(config, RegimeConfig()) as provider:
        assert await provider.resolve_session() == SESSIONS[-1]
        bars = await provider.get_chart_bars("NASDAQ:AAPL", 10)
        assert len(bars) == 10 and bars[-1].c == 200
        found = await provider.search_symbols("AAP")
        assert found[0]["symbol"] == "NASDAQ:AAPL"
        meta = await provider.get_symbol_data_batch(["AAPL"])
        assert meta["AAPL"]["sector"] == "Technology"
        assert await provider.get_market_cap("AAPL") == 4e12
        universe = await provider.screen_universe(5)
        assert {meta["ticker"]: meta["etf"] for meta, _ in universe} == {
            "AAPL": False, "SPY": True,
        }
    store.close()


def test_backfill_goes_spy_then_funds_then_biggest_and_failures_last(tmp_path: Path) -> None:
    store = store_with(tmp_path)
    store.failed("AAPL", "no bars")
    assert store.backfill_queue(10) == ["SPY", "BRK.B", "AAPL"]
    store.save_bars("SPY", rows(SESSIONS), full=True)
    assert store.backfill_queue(10) == ["BRK.B", "AAPL"]


async def test_a_chart_fetches_its_symbol_once(tmp_path: Path) -> None:
    store = store_with(tmp_path)
    feed = FakeFeed({"AAPL": rows(SESSIONS)})
    filler = BarFiller(store, feed.history, feed.sweep)
    results = await asyncio.gather(filler.ensure("NASDAQ:AAPL"), filler.ensure("AAPL"))
    assert results == [True, True]
    assert feed.calls == [("AAPL", None)]
    assert not await filler.ensure("NOPE")  # not a listed symbol
    assert not await filler.ensure("BRK.B")  # listed, but the feed has nothing
    assert store.backfill_queue(10)[-1] == "BRK.B"  # tried again after the rest
    store.close()


async def test_after_the_close_quotes_add_the_day_and_catch_splits(tmp_path: Path) -> None:
    store = store_with(tmp_path)
    history = SESSIONS[:-1]  # stored through Thursday
    store.save_bars("SPY", rows(history, 600), full=True)
    store.save_bars("AAPL", rows(history, 200), full=True)
    store.save_bars("BRK.B", rows(history, 500), full=True)
    friday = SESSIONS[-1]
    feed = FakeFeed({"SPY": rows(SESSIONS, 600)})
    feed.quotes = [
        Quote("AAPL", last=210, day=friday, time=0, open=201, high=209, low=199,
              volume=5e6, prev_close=200),
        # Split 2-for-1 overnight: the previous close no longer matches the stored one.
        Quote("BRK.B", last=251, day=friday, time=0, open=250, high=252, low=249,
              volume=1e6, prev_close=250),
    ]
    before = BarFiller(store, feed.history, feed.sweep, now=lambda: at(friday, 15))
    await before.daily_update()
    assert store.latest_session() == friday - timedelta(days=1)  # not before the close
    filler = BarFiller(store, feed.history, feed.sweep, now=lambda: at(friday, 17))
    await filler.daily_update()
    assert store.latest_session() == friday
    aapl = store.db.execute(
        "SELECT open, high, low, close, volume FROM ohlcv WHERE ticker='AAPL' AND date=?",
        (friday.isoformat(),),
    ).fetchone()
    assert tuple(aapl) == (201, 210, 199, 210, 5e6)  # the high takes the last price
    assert store.backfill_queue(10) == ["BRK.B"]
    store.close()


async def test_missed_days_come_from_history(tmp_path: Path) -> None:
    store = store_with(tmp_path)
    store.save_bars("SPY", rows(SESSIONS[:-3], 600), full=True)
    store.save_bars("AAPL", rows(SESSIONS[:-3], 200), full=True)
    feed = FakeFeed({"SPY": rows(SESSIONS, 600), "AAPL": rows(SESSIONS, 200)})
    filler = BarFiller(store, feed.history, feed.sweep, now=lambda: at(date(2026, 10, 24), 10))
    await filler.daily_update()
    assert store.tracked()["AAPL"][0] == SESSIONS[-1].isoformat()
    assert {ticker for ticker, _ in feed.calls} == {"SPY", "AAPL"}
    store.close()


async def test_schwab_feed_spells_class_shares_with_a_slash() -> None:
    class Provider:
        asked: list[str] = []

        async def daily(self, symbol: str, start: date | None, background: bool) -> list:
            self.asked.append(symbol)
            return []

        async def sweep(self, symbols: list[str]) -> list[Quote]:
            return [Quote(symbol, last=1, day=date(2026, 10, 23), time=0) for symbol in symbols]

    provider = Provider()
    history, sweep = schwab_feed(provider)
    await history("BRK.B", None, True)
    assert provider.asked == ["BRK/B"]
    assert [quote.symbol for quote in await sweep(["BRK.B", "AAPL"])] == ["BRK.B", "AAPL"]


class LiveFeed(FakeFeed):
    """A live provider with daily history, as Schwab is."""

    name = "fake"
    simulated = False

    async def daily(self, symbol: str, start: date | None, background: bool) -> list[tuple]:
        return await self.history(symbol, start, background)

    async def subscribe(self, symbols: frozenset[str]) -> None:
        pass

    async def run(self, emit, ready) -> None:  # type: ignore[no-untyped-def]
        ready()
        await asyncio.Event().wait()


def test_the_server_fills_a_chart_on_first_open(tmp_path: Path) -> None:
    store_with(tmp_path).close()  # listings in, as a first run fetches them
    config = AppConfig()
    config.storage.database = str(tmp_path / "momo.db")
    config.provider.database = str(tmp_path / "bars.db")
    config.provider.fill = "schwab"
    feed = LiveFeed({"AAPL": rows(SESSIONS, 200)})
    app = create_app(config, Path("config/momo.toml"), live_provider=feed)
    with TestClient(app) as client:
        payload = client.get("/api/bars", params={"symbol": "AAPL", "count": 20}).json()
        assert payload["symbol"] == "NASDAQ:AAPL"
        assert len(payload["bars"]) == 20
        assert payload["company"] == "Apple Inc."
        assert client.get("/api/health").json()["bars"]["stocks"] == 2


def test_first_run_takes_schwab_keys_in_the_app(tmp_path: Path) -> None:
    store_with(tmp_path).close()
    config = AppConfig()
    config.storage.database = str(tmp_path / "data" / "momo.db")
    config.provider.database = str(tmp_path / "bars.db")
    config.provider.fill = "schwab"
    app = create_app(config, Path("config/momo.toml"))
    with TestClient(app) as client:
        assert client.get("/api/me").json()["setup"] is True
        assert client.get("/api/live/setup").json() == {
            "fill": "schwab", "keys": False, "signed_in": False, "needed": True, "bars": None,
        }
        keys = {"client_id": "app-key-1234", "client_secret": "secret-5678"}
        assert client.post("/api/live/schwab/keys", json=keys).status_code == 403  # no header
        setup = client.post("/api/live/schwab/keys", json=keys, headers={"X-Momo": "1"}).json()
        assert (setup["keys"], setup["signed_in"], setup["bars"]["stocks"]) == (True, False, 2)
        url = client.get("/api/live/schwab/sign-in").json()["url"]
        assert "client_id=app-key-1234" in url
    path = tmp_path / "data" / "live.toml"
    assert path.stat().st_mode & 0o777 == 0o600
    settings = load_live_settings(path)
    assert settings["provider"] == "schwab"
    assert settings["schwab"] == {**keys, "callback_url": "https://127.0.0.1:8182"}
