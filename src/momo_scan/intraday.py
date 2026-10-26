"""Intraday bars: momo's own store, filled from the live provider.

The daily-bar archive has daily bars only. Intraday charts read `data/intraday.db`, which momo owns:
1-minute and 5-minute bars as the provider sends them (15m, 30m and 1h are built from 5m).
The provider's history fills it when a chart first opens (Schwab: about 6 weeks of 1m, 6.5
months of 5m); after that the stream's finished 1-minute bars keep it current, so a watched
chart never asks the provider again. Bars are kept, so history grows past the provider's
window. Times are epoch seconds at the bar's start; pre- and post-market bars are kept and
filtered on read.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import threading
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from momo_scan.live.base import MARKET_TZ

Row = tuple[int, float, float, float, float, float]  # t, open, high, low, close, volume
log = logging.getLogger(__name__)

# Chart interval -> (stored bar minutes, how many make one bar).
INTERVALS: dict[str, tuple[int, int]] = {
    "1m": (1, 1), "5m": (5, 1), "15m": (5, 3), "30m": (5, 6), "1h": (5, 12),
}
FIRST_DAYS = {1: 5, 5: 12}  # fetched while the chart waits: more than a chart's worth
DEEP_DAYS = {1: 45, 5: 200}  # filled in the background afterwards
STALE_SECONDS = 60  # a chart nobody streams is refreshed after this, while stocks trade
REGULAR = (9 * 60 + 30, 16 * 60)  # regular session, minutes after midnight ET
EXTENDED = (4 * 60, 20 * 60)

SCHEMA = """
CREATE TABLE IF NOT EXISTS bars (
  symbol TEXT NOT NULL, minutes INTEGER NOT NULL, t INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
  PRIMARY KEY (symbol, minutes, t)
) WITHOUT ROWID;
-- What the provider's history has covered: `through` is the start of the first bar not yet
-- fetched (the in-progress bar is never stored from history).
CREATE TABLE IF NOT EXISTS coverage (
  symbol TEXT NOT NULL, minutes INTEGER NOT NULL,
  start INTEGER NOT NULL, through INTEGER NOT NULL, fetched_at REAL NOT NULL,
  deep INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, minutes)
) WITHOUT ROWID;
"""


@dataclass(frozen=True)
class Coverage:
    start: int
    through: int
    fetched_at: float
    deep: bool


class IntradayStore:
    """SQLite store; every call is quick, and safe from worker threads."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.executescript(SCHEMA)
        self.lock = threading.Lock()

    def close(self) -> None:
        self.connection.close()

    def upsert(self, symbol: str, minutes: int, rows: Iterable[Row]) -> None:
        with self.lock, self.connection:
            self.connection.executemany(
                "INSERT OR REPLACE INTO bars VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [(symbol, minutes, *row) for row in rows],
            )

    def read(
        self, symbol: str, minutes: int, since: int | None = None, limit: int | None = None
    ) -> list[Row]:
        """Bars oldest first: from `since` on, or the newest `limit`."""
        with self.lock:
            if since is not None:
                cursor = self.connection.execute(
                    "SELECT t, o, h, l, c, v FROM bars WHERE symbol=? AND minutes=? AND t>=? "
                    "ORDER BY t", (symbol, minutes, since))
                return cursor.fetchall()
            cursor = self.connection.execute(
                "SELECT t, o, h, l, c, v FROM bars WHERE symbol=? AND minutes=? "
                "ORDER BY t DESC LIMIT ?", (symbol, minutes, limit or -1))
            return cursor.fetchall()[::-1]

    def coverage(self, symbol: str, minutes: int) -> Coverage | None:
        with self.lock:
            row = self.connection.execute(
                "SELECT start, through, fetched_at, deep FROM coverage "
                "WHERE symbol=? AND minutes=?", (symbol, minutes)).fetchone()
        return Coverage(row[0], row[1], row[2], bool(row[3])) if row else None

    def cover(
        self, symbol: str, minutes: int, start: int, through: int, deep: bool, at: float
    ) -> None:
        """Record a history fetch made at `at`, widening what's covered."""
        old = self.coverage(symbol, minutes)
        if old:
            start, through = min(start, old.start), max(through, old.through)
            deep, at = deep or old.deep, max(at, old.fetched_at)
        with self.lock, self.connection:
            self.connection.execute(
                "INSERT OR REPLACE INTO coverage VALUES (?, ?, ?, ?, ?, ?)",
                (symbol, minutes, start, through, at, int(deep)))


def minute_of_day(t: int) -> int:
    local = datetime.fromtimestamp(t, MARKET_TZ)
    return local.hour * 60 + local.minute


def in_session(t: int, extended: bool) -> bool:
    low, high = EXTENDED if extended else REGULAR
    return low <= minute_of_day(t) < high


def bucket_start(t: int, size_minutes: int) -> int:
    """The bar a time falls in. Buckets are anchored at 9:30 ET, like TradingView, so hourly
    bars run 9:30, 10:30, and pre-market ones 8:30, 7:30..."""
    local = datetime.fromtimestamp(t, MARKET_TZ)
    anchor = local.replace(hour=9, minute=30, second=0, microsecond=0)
    offset = int((local - anchor).total_seconds()) // 60
    return int((anchor + timedelta(minutes=offset - offset % size_minutes)).timestamp())


def aggregate(rows: list[Row], size_minutes: int) -> list[Row]:
    """Merge bars into `size_minutes` bars, oldest first."""
    out: list[list[float]] = []
    current = None
    for t, o, h, l, c, v in rows:  # noqa: E741
        start = bucket_start(t, size_minutes)
        if start != current:
            current = start
            out.append([start, o, h, l, c, v])
        else:
            bar = out[-1]
            bar[2], bar[3], bar[4], bar[5] = max(bar[2], h), min(bar[3], l), c, bar[5] + v
    return [(int(b[0]), b[1], b[2], b[3], b[4], b[5]) for b in out]


# symbol, minutes, start, end (epoch seconds); background=True for work nobody waits on
History = Callable[..., Awaitable[list[Row]]]


def last_session_end(now: float) -> float:
    """The latest 20:00 ET on a weekday at or before `now`: when the day's bars are final."""
    local = datetime.fromtimestamp(now, MARKET_TZ)
    day = local.replace(hour=20, minute=0, second=0, microsecond=0)
    if local < day:
        day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day.timestamp()


def trading_now(now: float) -> bool:
    local = datetime.fromtimestamp(now, MARKET_TZ)
    return local.weekday() < 5 and EXTENDED[0] <= local.hour * 60 + local.minute < EXTENDED[1]


def extended_session(now: float) -> tuple[str, int, int] | None:
    """("pre" or "post", first minute, end minute) while that session runs, else None."""
    local = datetime.fromtimestamp(now, MARKET_TZ)
    minute = local.hour * 60 + local.minute
    if local.weekday() >= 5:
        return None
    if EXTENDED[0] <= minute < REGULAR[0]:
        return "pre", EXTENDED[0], REGULAR[0]
    if REGULAR[1] <= minute < EXTENDED[1]:
        return "post", REGULAR[1], EXTENDED[1]
    return None


class IntradayService:
    """Serves intraday charts from the store, asking the provider's history only when the
    store can't answer: never fetched, or stale and not kept current by the stream."""

    def __init__(
        self,
        store: IntradayStore,
        history: History,
        streamed_since: Callable[[str], float | None] = lambda symbol: None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.store = store
        self.history = history
        self.streamed_since = streamed_since
        self.clock = clock
        self._inflight: dict[tuple[str, int], asyncio.Task[None]] = {}
        self._background: set[asyncio.Task[None]] = set()
        self._deepening: set[tuple[str, int]] = set()

    def needs_fetch(self, symbol: str, minutes: int) -> bool:
        cover = self.store.coverage(symbol, minutes)
        if cover is None:
            return True
        now = self.clock()
        if trading_now(now):
            since = self.streamed_since(symbol)
            if since is not None and since <= cover.fetched_at:
                return False  # the stream has saved every minute since the fetch
            return now - cover.fetched_at > STALE_SECONDS
        return cover.fetched_at < last_session_end(now)

    async def ensure(self, symbol: str, minutes: int, background: bool = False) -> None:
        """Bring the store up to date; concurrent callers share one fetch. `background`: for
        work nobody waits on (Volume Buzz), which yields the request budget to charts."""
        if not self.needs_fetch(symbol, minutes):
            cover = self.store.coverage(symbol, minutes)
            if cover is not None and not cover.deep:
                self._deepen(symbol, minutes)  # e.g. an earlier fill was cut short
            return
        key = (symbol, minutes)
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._fetch(symbol, minutes, background))
            self._inflight[key] = task
            task.add_done_callback(lambda _: self._inflight.pop(key, None))
        await asyncio.shield(task)

    async def _fetch(self, symbol: str, minutes: int, background: bool = False) -> None:
        now = self.clock()
        cover = self.store.coverage(symbol, minutes)
        size = minutes * 60
        if cover is None:
            start = int(now - FIRST_DAYS[minutes] * 86400)
        else:  # just the gap, from the first bar not yet complete
            start = cover.through
        requests = [self.history(symbol, minutes, start, int(now), background=background)]
        forming = bucket_start(int(now), minutes)
        if minutes == 5 and trading_now(now) and now - forming >= 60:
            # The 5m bar in progress is built from 1m bars: fetch its finished minutes too,
            # at the same time, so the chart waits for one round trip, not two.
            requests.append(self.history(symbol, 1, forming, int(now), background=background))
        rows, *minute_rows = await asyncio.gather(*requests)
        # The bar still forming isn't final: leave it to the stream or the next fetch.
        complete = [row for row in rows if row[0] + size <= now]
        through = complete[-1][0] + size if complete else (cover.through if cover else start)
        await asyncio.to_thread(self.store.upsert, symbol, minutes, complete)
        await asyncio.to_thread(self.store.cover, symbol, minutes, start, through, False, now)
        if minute_rows:
            done = [row for row in minute_rows[0] if row[0] + 60 <= now]
            await asyncio.to_thread(self.store.upsert, symbol, 1, done)
        if cover is None or not cover.deep:
            self._deepen(symbol, minutes)

    def _deepen(self, symbol: str, minutes: int) -> None:
        """Fill the rest of the provider's history without making the chart wait."""
        if (symbol, minutes) in self._deepening:
            return
        self._deepening.add((symbol, minutes))

        async def run() -> None:
            cover = self.store.coverage(symbol, minutes)
            if cover is None or cover.deep:
                return
            start = int(self.clock() - DEEP_DAYS[minutes] * 86400)
            if start < cover.start:
                rows = await self.history(symbol, minutes, start, cover.start, background=True)
                await asyncio.to_thread(self.store.upsert, symbol, minutes, rows)
            await asyncio.to_thread(  # the past only: the last fetch time stands
                self.store.cover, symbol, minutes, start, cover.through, True, cover.fetched_at)

        task = asyncio.create_task(run())
        self._background.add(task)

        def done(finished: asyncio.Task[None]) -> None:
            self._background.discard(finished)
            self._deepening.discard((symbol, minutes))
            if not finished.cancelled() and finished.exception():
                log.warning("Intraday fill for %s failed: %s", symbol, finished.exception())

        task.add_done_callback(done)

    def save_streamed(self, symbol: str, row: Row) -> None:
        """A finished 1-minute bar from the stream."""
        self.store.upsert(symbol, 1, [row])

    async def bars(
        self, symbol: str, interval: str, count: int, extended: bool = True
    ) -> dict[str, Any]:
        minutes, multiple = INTERVALS[interval]
        await self.ensure(symbol, minutes)
        size = minutes * multiple
        rows = await asyncio.to_thread(self._rows, symbol, minutes, multiple, count, extended)
        # 5m-based charts merge their 1m tail too, so always aggregate them.
        bars = aggregate(rows, size) if minutes == 5 else rows
        bars = bars[-count:]
        return {
            "symbol": symbol,
            "interval": interval,
            "minutes": size,
            "extended": extended,
            "bars": [
                {"time": t, "open": o, "high": h, "low": l, "close": c, "volume": v}
                for t, o, h, l, c, v in bars  # noqa: E741
            ],
        }

    def session_rows(self, symbol: str, since: int) -> list[Row]:
        """Stored bars from `since` on, oldest first: the 5m history, then the 1-minute bars
        after it (from the stream or a gap fetch). `aggregate(rows, 5)` evens them out."""
        cover = self.store.coverage(symbol, 5)
        tail_from = cover.through if cover else since
        rows = [row for row in self.store.read(symbol, 5, since=since) if row[0] < tail_from]
        return rows + self.store.read(symbol, 1, since=max(since, tail_from))

    def extended_bar(self, symbol: str) -> dict[str, Any] | None:
        """Today's pre-market (4:00-9:30 ET) or post-market (16:00-20:00) so far as one bar,
        from the stored bars, while that session runs; None otherwise or before any trade."""
        now = self.clock()
        found = extended_session(now)
        if found is None:
            return None
        session, low, high = found
        local = datetime.fromtimestamp(now, MARKET_TZ)
        midnight = int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        rows = [row for row in self.session_rows(symbol, midnight + low * 60)
                if row[0] < midnight + high * 60]
        if not rows:
            return None
        return {
            "session": session, "open": rows[0][1], "high": max(row[2] for row in rows),
            "low": min(row[3] for row in rows), "close": rows[-1][4],
            "volume": sum(row[5] for row in rows),
        }

    def _rows(
        self, symbol: str, minutes: int, multiple: int, count: int, extended: bool
    ) -> list[Row]:
        # Extra rows: pre- and post-market bars filtered out, and 5m bars merged into larger.
        spare = 3 if not extended else 1
        rows = self.store.read(symbol, minutes, limit=count * multiple * spare + 200)
        if minutes == 5:
            # Past the last stored 5m bar, the stream's (and gap fetch's) 1m bars.
            cover = self.store.coverage(symbol, 5)
            tail_from = cover.through if cover else (rows[-1][0] + 300 if rows else 0)
            rows = [row for row in rows if row[0] < tail_from]
            rows += self.store.read(symbol, 1, since=tail_from)
        return [row for row in rows if in_session(row[0], extended)]

