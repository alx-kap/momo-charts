"""Daily bars momo keeps itself, for installs without Alex's market-data archive.

The store uses the archive's tables (ohlcv, mm_universe, sectors, market_monitor_daily,
mm_diagnostics), so `LocalSQLiteProvider` reads it unchanged: charts, the screener, symbol
search and watchlists work the same on either.

- Symbols come from Nasdaq Trader's directory of every US-listed security (free, no key);
  sector, industry and market cap from Nasdaq's stock screener.
- History comes from the live feed's daily price history (Schwab: about 20 years a symbol,
  split-adjusted, one request each). A chart opened on a symbol not filled yet fetches it at
  once; the rest fill in the background, biggest companies first, about an hour for every
  stock at Schwab's request limit.
- Each weekday after the close, one quote per symbol (500 a request) adds the day's bar. A
  previous close that disagrees with the stored one means a split or a correction, so that
  symbol's history is fetched again. On Saturdays the last two weeks are fetched again for
  every symbol, which settles late volume and anything the quotes got wrong.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sqlite3
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any

import httpx

from momo_scan.live.base import MARKET_TZ, Quote, SignInNeeded

DIRECTORY_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt"
PROFILES_URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true"
BROWSER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0"
# Filled first, before any stock: SPY sets the trading calendar, the rest are the funds the
# screener and Market panel lean on. Other funds fill when a chart opens them.
FUNDS = [
    "SPY", "QQQ", "IWM", "DIA", "MDY", "RSP", "SMH", "XBI", "ARKK", "KRE", "GLD", "SLV", "TLT",
    "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC",
]
EXCHANGES = {"Q": "NASDAQ", "N": "NYSE", "A": "AMEX", "P": "ARCA", "Z": "BATS", "V": "IEXG"}
# Listings that aren't common stock, by words in the security name.
NOT_COMMON = (
    "warrant", " right", " unit", "preferred", "depositary shares representing", " notes",
    "debenture", "% ", "subordinated", "closed end fund", "closed-end fund",
)
# "Apple Inc. - Common Stock" → "Apple Inc."; "Alphabet Inc. - Class C Capital Stock" → "Alphabet
# Inc. - Class C".
SHARE_WORDS = re.compile(
    r"\s*-?\s*(common stock|ordinary shares|common shares|capital stock)\b.*$", re.IGNORECASE
)
UPDATE_AFTER = time(16, 15)  # ET: the day's bar is taken from quotes after this
SPLIT_TOLERANCE = 0.02  # a previous close further off than this refetches the history
LISTINGS_EVERY = timedelta(days=1)
REST = 15 * 60  # seconds between rounds once everything is filled

DailyRow = tuple[date, float, float, float, float, float]
History = Callable[[str, "date | None", bool], Awaitable[list[DailyRow]]]
Sweep = Callable[[list[str]], Awaitable[list[Quote]]]

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS ohlcv (
  ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL,
  volume REAL, PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS ohlcv_date_ticker ON ohlcv (date, ticker);
CREATE TABLE IF NOT EXISTS mm_universe (
  ticker TEXT PRIMARY KEY, name TEXT, exchange TEXT, is_common_stock INTEGER NOT NULL,
  exclusion_reason TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sectors (
  ticker TEXT PRIMARY KEY, sector TEXT, industry TEXT, name TEXT, market_cap REAL,
  exchange TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS market_monitor_daily (date TEXT PRIMARY KEY, data_through_date TEXT);
CREATE TABLE IF NOT EXISTS mm_diagnostics (
  date TEXT PRIMARY KEY, universe_size INTEGER, valid_symbols INTEGER, warnings TEXT
);
-- What momo itself has fetched: `through` is the newest stored day, `full` when the whole
-- history is in (rather than only days added from quotes).
CREATE TABLE IF NOT EXISTS bar_fill (
  ticker TEXT PRIMARY KEY, full INTEGER NOT NULL DEFAULT 0, through TEXT, fetched_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS bar_meta (key TEXT PRIMARY KEY, value TEXT);
"""


@dataclass(frozen=True, slots=True)
class Listing:
    ticker: str
    name: str
    exchange: str
    common: bool
    reason: str | None  # why it isn't common stock: "etf_etn", "warrant", ...


def clean_name(name: str) -> str:
    return SHARE_WORDS.sub("", name.strip()).rstrip(" -,") or name.strip()


def parse_directory(text: str) -> list[Listing]:
    """Nasdaq Trader's nasdaqtraded.txt: every US-listed security, pipe-separated."""
    lines = text.splitlines()
    if not lines or not lines[0].startswith("Nasdaq Traded|Symbol|"):
        raise ValueError("Not Nasdaq Trader's symbol directory")
    header = lines[0].split("|")
    listings = []
    for line in lines[1:]:
        row = dict(zip(header, line.split("|"), strict=False))
        ticker = (row.get("Symbol") or "").strip()
        if not ticker or row.get("Test Issue") != "N" or row.get("Nasdaq Traded") != "Y":
            continue
        name = (row.get("Security Name") or "").strip()
        lowered = f"{name.lower()} "
        name = clean_name(name)
        reason = None
        if row.get("ETF") == "Y":
            reason = "etf_etn"
        elif "$" in ticker or "preferred" in lowered:
            reason = "preferred"
        elif any(word in lowered for word in NOT_COMMON):
            reason = "other"
        listings.append(Listing(
            ticker, name, EXCHANGES.get(row.get("Listing Exchange", ""), "OTHER"),
            reason is None, reason,
        ))
    return listings


def parse_profiles(payload: Any) -> dict[str, dict[str, Any]]:
    """Nasdaq's stock screener download: sector, industry, market cap and a clean name."""
    rows = ((payload or {}).get("data") or {}).get("rows") or []
    profiles = {}
    for row in rows:
        ticker = str(row.get("symbol") or "").strip().replace("/", ".")
        if not ticker:
            continue
        try:
            cap = float(row.get("marketCap") or 0) or None
        except ValueError:
            cap = None
        profiles[ticker] = {
            "name": clean_name(row.get("name") or "") or None,
            "sector": (row.get("sector") or "").strip() or None,
            "industry": (row.get("industry") or "").strip() or None,
            "market_cap": cap,
        }
    return profiles


async def fetch_listings(client: httpx.AsyncClient) -> tuple[list[Listing], dict[str, Any]]:
    response = await client.get(DIRECTORY_URL, headers={"User-Agent": BROWSER}, timeout=60)
    response.raise_for_status()
    listings = parse_directory(response.text)
    try:  # a nicety: names and sectors; the symbols alone are enough to chart
        response = await client.get(
            PROFILES_URL, headers={"User-Agent": BROWSER, "Accept": "application/json"},
            timeout=60,
        )
        response.raise_for_status()
        profiles = parse_profiles(response.json())
    except (httpx.HTTPError, ValueError) as error:
        log.warning("Nasdaq profiles unavailable: %s", error)
        profiles = {}
    return listings, profiles


class BarStore:
    """The store's one writer. `LocalSQLiteProvider` reads the same file on its own
    (read-only) connection."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    def meta(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM bar_meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO bar_meta VALUES (?, ?)", (key, value))

    def save_listings(self, listings: Sequence[Listing], profiles: dict[str, Any]) -> None:
        stamp = datetime.now(UTC).isoformat(timespec="seconds")
        with self.db:
            self.db.executemany(
                "INSERT OR REPLACE INTO mm_universe VALUES (?, ?, ?, ?, ?, ?)",
                [(item.ticker, item.name, item.exchange, int(item.common), item.reason, stamp)
                 for item in listings],
            )
            self.db.executemany(
                "INSERT OR REPLACE INTO sectors VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(item.ticker, profile["sector"], profile["industry"],
                  profile["name"] or item.name, profile["market_cap"], item.exchange, stamp)
                 for item in listings if (profile := profiles.get(item.ticker))],
            )

    def save_bars(self, ticker: str, rows: Sequence[DailyRow], full: bool = False) -> None:
        """Store `rows`; with `full`, they are the whole history and replace what was there."""
        stamp = datetime.now(UTC).isoformat(timespec="seconds")
        with self.db:
            if full:
                self.db.execute("DELETE FROM ohlcv WHERE ticker=?", (ticker,))
            self.db.executemany(
                "INSERT OR REPLACE INTO ohlcv VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(ticker, day.isoformat(), *values) for day, *values in rows],
            )
            through = self.db.execute(
                "SELECT MAX(date) FROM ohlcv WHERE ticker=?", (ticker,)
            ).fetchone()[0]
            self.db.execute(
                """
                INSERT INTO bar_fill (ticker, full, through, fetched_at, error)
                VALUES (?, ?, ?, ?, NULL)
                ON CONFLICT(ticker) DO UPDATE SET full = MAX(full, excluded.full),
                  through = excluded.through, fetched_at = excluded.fetched_at, error = NULL
                """,
                (ticker, int(full), through, stamp),
            )

    def failed(self, ticker: str, error: str) -> None:
        with self.db:
            self.db.execute(
                """
                INSERT INTO bar_fill (ticker, full, error) VALUES (?, 0, ?)
                ON CONFLICT(ticker) DO UPDATE SET error = excluded.error
                """,
                (ticker, error[:200]),
            )

    def refetch(self, tickers: Sequence[str]) -> None:
        """Back to the backfill queue: the stored history is wrong (a split, say)."""
        with self.db:
            self.db.executemany(
                "UPDATE bar_fill SET full = 0 WHERE ticker=?", [(t,) for t in tickers]
            )

    def is_filled(self, ticker: str) -> bool:
        row = self.db.execute("SELECT full FROM bar_fill WHERE ticker=?", (ticker,)).fetchone()
        return bool(row and row[0])

    def known(self, ticker: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM mm_universe WHERE ticker=?", (ticker,)
        ).fetchone() is not None

    def backfill_queue(self, limit: int) -> list[str]:
        """Unfilled symbols in fill order: the funds above, then common stocks by market cap.
        A symbol that failed waits until everything else has had a turn."""
        funds = {ticker: n for n, ticker in enumerate(FUNDS)}
        rows = self.db.execute(
            """
            SELECT u.ticker, s.market_cap, f.error FROM mm_universe u
            LEFT JOIN sectors s ON s.ticker = u.ticker
            LEFT JOIN bar_fill f ON f.ticker = u.ticker
            WHERE COALESCE(f.full, 0) = 0
              AND (u.is_common_stock = 1 OR u.ticker IN (SELECT value FROM json_each(?)))
            """,
            (json.dumps(FUNDS),),
        ).fetchall()
        rows.sort(key=lambda r: (
            r["error"] is not None, r["ticker"] not in funds, funds.get(r["ticker"], 0),
            -(r["market_cap"] or 0), r["ticker"],
        ))
        return [row["ticker"] for row in rows[:limit]]

    def tracked(self) -> dict[str, tuple[str, float]]:
        """Every symbol with history: its newest stored day and close."""
        rows = self.db.execute(
            """
            SELECT f.ticker, f.through, o.close FROM bar_fill f
            JOIN ohlcv o ON o.ticker = f.ticker AND o.date = f.through
            WHERE f.full = 1
            """
        ).fetchall()
        return {row["ticker"]: (row["through"], row["close"]) for row in rows}

    def sessions(self, after: date) -> list[date]:
        rows = self.db.execute(
            "SELECT date FROM ohlcv WHERE ticker='SPY' AND date > ? ORDER BY date",
            (after.isoformat(),),
        ).fetchall()
        return [date.fromisoformat(row[0]) for row in rows]

    def latest_session(self) -> date | None:
        row = self.db.execute("SELECT MAX(date) FROM ohlcv WHERE ticker='SPY'").fetchone()
        return date.fromisoformat(row[0]) if row and row[0] else None

    def mark_session(self) -> None:
        """Record the newest session and how many stocks have it, which the provider checks
        before it calls a session complete."""
        latest = self.latest_session()
        if latest is None:
            return
        day = latest.isoformat()
        universe, valid = self.db.execute(
            """
            SELECT COUNT(*), COUNT(o.ticker) FROM mm_universe u
            LEFT JOIN ohlcv o ON o.ticker = u.ticker AND o.date = ?
            WHERE u.is_common_stock = 1
            """,
            (day,),
        ).fetchone()
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO market_monitor_daily VALUES (?, ?)", (day, day))
            self.db.execute(
                "INSERT OR REPLACE INTO mm_diagnostics VALUES (?, ?, ?, '')", (day, universe, valid)
            )

    def progress(self) -> dict[str, Any]:
        stocks, filled = self.db.execute(
            """
            SELECT COUNT(*), SUM(COALESCE(f.full, 0)) FROM mm_universe u
            LEFT JOIN bar_fill f ON f.ticker = u.ticker WHERE u.is_common_stock = 1
            """
        ).fetchone()
        latest = self.latest_session()
        return {
            "stocks": stocks, "filled": filled or 0,
            "through": latest.isoformat() if latest else None,
        }


class BarFiller:
    """Keeps a `BarStore` filled from a feed's daily history and quotes. `history(ticker,
    start, background)` returns daily rows (all of them when `start` is None); `sweep(tickers)`
    returns today's quotes at background priority."""

    def __init__(
        self, store: BarStore, history: History, sweep: Sweep,
        client: httpx.AsyncClient | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(MARKET_TZ),
    ) -> None:
        self.store = store
        self.history = history
        self.sweep = sweep
        self.client = client
        self.now = now
        self.error: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._locks: dict[str, asyncio.Lock] = {}
        self._wake = asyncio.Event()

    # ---------- on demand ----------

    async def ensure(self, ticker: str) -> bool:
        """A chart wants `ticker`: fetch its history now unless it is already in. False when
        the symbol is unknown or the feed has nothing for it."""
        ticker = ticker.rsplit(":", 1)[-1].upper()
        if self.store.is_filled(ticker):
            return True
        if not self.store.known(ticker):
            return False
        async with self._locks.setdefault(ticker, asyncio.Lock()):
            if not self.store.is_filled(ticker):
                await self.fill(ticker, background=False)
        return self.store.is_filled(ticker)

    async def fill(self, ticker: str, background: bool = True) -> None:
        try:
            rows = await self.history(ticker, None, background)
        except SignInNeeded:
            raise
        except Exception as error:  # noqa: BLE001 - one bad symbol mustn't stop the rest
            log.info("No history for %s: %s", ticker, error)
            self.store.failed(ticker, str(error))
            return
        if rows:
            self.store.save_bars(ticker, rows, full=True)
        else:
            self.store.failed(ticker, "no bars")

    # ---------- the background rounds ----------

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    def wake(self) -> None:
        """Start the next round now, e.g. right after a sign-in."""
        self._wake.set()

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        while True:
            try:
                busy = await self.round()
                self.error = None
            except asyncio.CancelledError:
                raise
            except SignInNeeded as error:
                self.error = str(error)
                busy = False
            except Exception as error:  # noqa: BLE001 - try again next round
                log.warning("Bar fill round failed: %s", error)
                self.error = str(error)
                busy = False
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), 1 if busy else REST)
            except TimeoutError:
                pass

    async def round(self, batch: int = 50) -> bool:
        """One step of upkeep; True while there is backfill left to do."""
        await self.refresh_listings()
        await self.daily_update()
        queue = self.store.backfill_queue(batch)
        for ticker in queue:
            await self.fill(ticker)
        if queue:
            self.store.mark_session()
        return bool(queue)

    async def refresh_listings(self, force: bool = False) -> None:
        stamp = self.store.meta("listings_at")
        due = stamp is None or datetime.fromisoformat(stamp) < datetime.now(UTC) - LISTINGS_EVERY
        if not (force or due):
            return
        if self.client is None:
            async with httpx.AsyncClient() as client:
                listings, profiles = await fetch_listings(client)
        else:
            listings, profiles = await fetch_listings(self.client)
        self.store.save_listings(listings, profiles)
        self.store.set_meta("listings_at", datetime.now(UTC).isoformat(timespec="seconds"))
        log.info("Listings: %d symbols, %d with profiles", len(listings), len(profiles))

    def _closed_day(self) -> date:
        """The newest session whose regular hours are over, by the clock alone (holidays
        show up as days the quotes don't move to)."""
        now = self.now().astimezone(MARKET_TZ)
        day = now.date() if now.time() >= UPDATE_AFTER else now.date() - timedelta(days=1)
        while day.weekday() >= 5:
            day -= timedelta(days=1)
        return day

    async def daily_update(self) -> None:
        """Bring every filled symbol up to the last closed session."""
        target = self._closed_day()
        latest = self.store.latest_session()
        if latest is None or latest >= target:
            await self.weekly_true_up()
            return
        # SPY first, from its history: it decides which days were sessions.
        await self._extend("SPY", latest - timedelta(days=7))
        sessions = self.store.sessions(latest)
        if not sessions:
            return
        tracked = self.store.tracked()
        missed: list[str] = []
        quoted: list[str] = []
        for ticker, (through, _) in tracked.items():
            if ticker == "SPY":
                continue
            behind = [day for day in sessions if day > date.fromisoformat(through)]
            if len(behind) == 1:
                quoted.append(ticker)  # only the newest day: today's quote has it
            elif behind:
                missed.append(ticker)  # days missed: their history has them
        newest = sessions[-1]
        stale: list[str] = []
        for quote in await self.sweep(quoted):
            through, close = tracked[quote.symbol]
            if quote.day != newest or None in (quote.open, quote.high, quote.low, quote.volume):
                continue
            if quote.prev_close and abs(quote.prev_close / close - 1) > SPLIT_TOLERANCE:
                stale.append(quote.symbol)
                continue
            high = max(quote.high, quote.open, quote.last)
            low = min(quote.low, quote.open, quote.last)
            self.store.save_bars(
                quote.symbol, [(newest, quote.open, high, low, quote.last, quote.volume)]
            )
        self.store.refetch(stale)
        for ticker in missed:
            await self._extend(ticker, date.fromisoformat(tracked[ticker][0]) - timedelta(days=7))
        self.store.mark_session()
        if stale:
            log.info("Refetching %d symbols whose history changed: %s", len(stale), stale[:10])

    async def _extend(self, ticker: str, start: date) -> None:
        """Fetch `ticker`'s days from `start` on again and store them."""
        try:
            rows = await self.history(ticker, start, True)
        except SignInNeeded:
            raise
        except Exception as error:  # noqa: BLE001
            log.info("Couldn't extend %s: %s", ticker, error)
            return
        self.store.save_bars(ticker, [row for row in rows if row[0] >= start])

    async def weekly_true_up(self) -> None:
        """Saturdays: the last two weeks again for every symbol, from history."""
        now = self.now().astimezone(MARKET_TZ)
        week = now.date().isocalendar()
        key = f"{week.year}-W{week.week:02d}"
        if now.weekday() != 5 or self.store.meta("true_up") == key:
            return
        since = now.date() - timedelta(days=14)
        for ticker in self.store.tracked():
            await self._extend(ticker, since)
        self.store.set_meta("true_up", key)
        self.store.mark_session()


def schwab_feed(provider: Any) -> tuple[History, Sweep]:
    """`history` and `sweep` for a `BarFiller` on the Schwab live feed, which shares its
    request limit. Schwab spells class shares with a slash (BRK/B); the store with a dot."""

    def vendor(ticker: str) -> str:
        return ticker.replace(".", "/")

    async def history(ticker: str, start: date | None, background: bool) -> list[DailyRow]:
        return await provider.daily(vendor(ticker), start, background)

    async def sweep(tickers: list[str]) -> list[Quote]:
        quotes = await provider.sweep([vendor(ticker) for ticker in tickers])
        return [replace(quote, symbol=quote.symbol.replace("/", ".")) for quote in quotes]

    return history, sweep
