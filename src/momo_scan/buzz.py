"""Volume Buzz, like TC2000's: how far today's volume so far runs ahead of (or behind) what the
stock usually trades by this time of day. +250% is three and a half times the usual; -50% half.

Each session has its own buzz: Pre Buzz (7:00-9:30 ET), Buzz (9:30-16:05) and Post Buzz
(16:05-20:00). The usual is the average cumulative volume at the same minute of the session
over the last 20 sessions; both sides come from the provider's minute bars in momo's intraday
store, so they count trades the same way (Schwab's quote volume also counts odd lots, which its
bars leave out: 1.3-3.7× the bars' volume, measured 2026-10-13, so the two can't be mixed).

Why those windows: Schwab's history of the latest day or two starts at 7:00 (older days go back
to 4:00 and the overnight session), so pre-market before 7:00 can't be compared like for like.
The 16:00 5-minute bar holds the closing auction, so it counts towards the regular session.

Outside the sessions (overnight, weekends) the last session day's final Buzz shows. Symbols get
their history once at background priority; after that the stream's finished minute bars keep
the store current, so a watched list costs no further requests.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any

from momo_scan.intraday import IntradayService, Row, aggregate
from momo_scan.live.base import MARKET_TZ

log = logging.getLogger(__name__)

LOOKBACK = 20  # sessions in the usual
MIN_DAYS = 5  # fewer than this and there's no usual to speak of
HISTORY_DAYS = 35  # calendar days read for the usual: 20 sessions plus holidays
SLOT = 5  # minutes per step of the usual
FIRST = 7 * 60  # the store's slots run 7:00-20:00 ET
SESSIONS = (("pre", 7 * 60, 9 * 60 + 30), ("regular", 9 * 60 + 30, 16 * 60 + 5),
            ("post", 16 * 60 + 5, 20 * 60))
REFRESH_SECONDS = 15.0
REFETCH_SECONDS = 300.0  # a symbol the stream doesn't keep current is topped up this often
MAX_FETCHES = 20  # history fetches queued at once


def _minute(t: int) -> tuple[date, int]:
    local = datetime.fromtimestamp(t, MARKET_TZ)
    return local.date(), local.hour * 60 + local.minute


def session_at(minute: int) -> tuple[str, int, int] | None:
    for session in SESSIONS:
        if session[1] <= minute < session[2]:
            return session
    return None


def day_slots(rows: list[Row]) -> dict[date, list[float]]:
    """Volume per 5-minute slot from 7:00 to 20:00 ET, per day."""
    days: dict[date, list[float]] = {}
    for row in aggregate(rows, SLOT):
        day, minute = _minute(row[0])
        if FIRST <= minute < SESSIONS[-1][2]:
            slots = days.setdefault(day, [0.0] * ((SESSIONS[-1][2] - FIRST) // SLOT))
            slots[(minute - FIRST) // SLOT] += row[5]
    return days


def usual(
    days: dict[date, list[float]], before: date, session: tuple[str, int, int]
) -> list[float]:
    """Average cumulative volume at each 5-minute mark of the session, over the last LOOKBACK
    days before `before` that traded in the regular session. Empty without MIN_DAYS of them."""
    past = [day for day in sorted(days) if day < before and _traded(days[day])][-LOOKBACK:]
    if len(past) < MIN_DAYS:
        return []
    first, last = (session[1] - FIRST) // SLOT, (session[2] - FIRST) // SLOT
    marks = [0.0] * (last - first)
    for day in past:
        total = 0.0
        for i, volume in enumerate(days[day][first:last]):
            total += volume
            marks[i] += total
    return [mark / len(past) for mark in marks]


def usual_at(marks: list[float], elapsed: float) -> float:
    """The usual cumulative volume `elapsed` minutes into the session, between the marks."""
    position = min(elapsed / SLOT, len(marks))
    whole = int(position)
    below = marks[whole - 1] if whole else 0.0
    if whole >= len(marks):
        return marks[-1]
    return below + (marks[whole] - below) * (position - whole)


class BuzzService:
    """Keeps the hub's Volume Buzz current for every symbol a list shows it for."""

    def __init__(
        self, intraday: IntradayService, hub: Any, clock: Callable[[], float] = time.time
    ) -> None:
        self.intraday = intraday
        self.hub = hub
        self.clock = clock
        self._usual: dict[tuple[str, date, str], tuple[int, list[float]]] = {}
        self._days: dict[str, tuple[Any, dict[date, list[float]]]] = {}
        self._fetched: dict[str, float] = {}
        self._fetching: set[asyncio.Task[None]] = set()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        for task in [self._task, *self._fetching]:
            if task is not None:
                task.cancel()
        self._task = None

    async def _run(self) -> None:
        while True:
            try:
                await self.refresh()
            except Exception as error:  # keep going: the next round may do better
                log.warning("Volume Buzz refresh failed: %s", error)
            await asyncio.sleep(REFRESH_SECONDS)

    async def refresh(self) -> None:
        symbols = sorted(self.hub.wanted_buzz)
        for symbol in symbols:
            self._top_up(symbol)
        # A symbol whose bars are behind (just watched, its gap fetch on the way) waits rather
        # than show a Buzz that misses the morning's volume.
        values = await asyncio.to_thread(self.compute, [s for s in symbols if self.current(s)])
        for symbol, value in values.items():
            if self.hub.buzz.get(symbol) != value and symbol in self.hub.wanted_buzz:
                self.hub.set_buzz(symbol, value)

    def current(self, symbol: str) -> bool:
        """Whether the store has the symbol's bars up to now: kept by the stream, or fetched
        lately (without the stream, refetches come every REFETCH_SECONDS)."""
        if not self.intraday.needs_fetch(symbol, 5):
            return True
        cover = self.intraday.store.coverage(symbol, 5)
        return cover is not None and self.clock() - cover.fetched_at < REFETCH_SECONDS + 60

    def _top_up(self, symbol: str) -> None:
        """Fetch history in the background when the store can't answer for a symbol."""
        now = self.clock()
        if len(self._fetching) >= MAX_FETCHES:
            return
        if now - self._fetched.get(symbol, 0) < REFETCH_SECONDS:
            return
        if not self.intraday.needs_fetch(symbol, 5):
            cover = self.intraday.store.coverage(symbol, 5)
            if cover is None or cover.deep or cover.start <= now - HISTORY_DAYS * 86400:
                return
        self._fetched[symbol] = now
        task = asyncio.create_task(self.intraday.ensure(symbol, 5, background=True))
        self._fetching.add(task)

        def done(finished: asyncio.Task[None]) -> None:
            self._fetching.discard(finished)
            if not finished.cancelled() and finished.exception():
                log.warning("Buzz history for %s failed: %s", symbol, finished.exception())

        task.add_done_callback(done)

    def compute(self, symbols: list[str]) -> dict[str, dict[str, Any] | None]:
        return {symbol: self.value(symbol) for symbol in symbols}

    def value(self, symbol: str) -> dict[str, Any] | None:
        """{"session", "day", "pct", "volume"} for now, or None without enough history."""
        now = int(self.clock())
        # Finished minutes only, with a minute's grace for the stream's bar to arrive.
        cutoff = now - now % 60 - 60
        today, minute = _minute(cutoff)
        weekday = datetime.fromtimestamp(cutoff, MARKET_TZ).weekday() < 5
        current = session_at(minute) if weekday else None
        days = dict(self._past(symbol, today))
        rows = self.intraday.session_rows(symbol, _at(today, 0))
        days.update(day_slots([row for row in rows if row[0] < cutoff]))
        if current is not None:
            day, session, elapsed = today, current, minute - current[1]
        else:  # between sessions: the last session day's final Buzz
            traded = [d for d in days if d <= today and _traded(days[d])]
            if not traded:
                return None
            day, session = max(traded), SESSIONS[1]
            elapsed = session[2] - session[1]
        if elapsed < 1:
            return None
        marks = self._usual_for(symbol, days, day, session)
        base = usual_at(marks, elapsed) if marks else 0.0
        if base <= 0:
            return None
        slots = days.get(day, [])
        volume = sum(slots[(session[1] - FIRST) // SLOT:(session[2] - FIRST) // SLOT])
        return {"session": session[0], "day": day.isoformat(),
                "pct": round((volume / base - 1) * 100, 1), "volume": volume}

    def _past(self, symbol: str, today: date) -> dict[date, list[float]]:
        """Slots of the days before today; read again when the history reaches further back."""
        cover = self.intraday.store.coverage(symbol, 5)
        key = (today, cover.start if cover else None)
        cached = self._days.get(symbol)
        if cached is None or cached[0] != key:
            rows = self.intraday.session_rows(symbol, _at(today - timedelta(days=HISTORY_DAYS), 0))
            past = {d: slots for d, slots in day_slots(rows).items() if d < today}
            cached = self._days[symbol] = (key, past)
        return cached[1]

    def _usual_for(
        self, symbol: str, days: dict[date, list[float]], day: date, session: tuple[str, int, int]
    ) -> list[float]:
        """The usual, worked out once per symbol, day and session (again if history grows)."""
        known = sum(1 for d in days if d < day)
        key = (symbol, day, session[0])
        cached = self._usual.get(key)
        if cached is None or cached[0] != known:
            cached = self._usual[key] = (known, usual(days, day, session))
        return cached[1]


def _at(day: date, minute: int) -> int:
    """Epoch seconds of a minute of an ET day."""
    return int(datetime.combine(day, datetime.min.time(), MARKET_TZ).timestamp()) + minute * 60


def _traded(slots: list[float]) -> bool:
    """Whether a day had regular-session volume (not a weekend's overnight trading)."""
    regular = SESSIONS[1]
    return any(slots[(regular[1] - FIRST) // SLOT:(regular[2] - FIRST) // SLOT])
