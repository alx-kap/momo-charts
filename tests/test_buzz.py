from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
from pathlib import Path

from momo_scan.buzz import BuzzService, session_at, usual, usual_at
from momo_scan.intraday import IntradayService, IntradayStore
from momo_scan.live import LiveHub
from momo_scan.live.base import MARKET_TZ

TODAY = date(2026, 10, 13)  # a Tuesday


def et(day: date, hour: int, minute: int = 0) -> int:
    return int(datetime(day.year, day.month, day.day, hour, minute, tzinfo=MARKET_TZ).timestamp())


def sessions_before(day: date, count: int) -> list[date]:
    out = []
    while len(out) < count:
        day -= timedelta(days=1)
        if day.weekday() < 5:
            out.append(day)
    return out[::-1]


def bars(day: date, volume: float, start: tuple[int, int] = (7, 0), end: tuple[int, int] = (20, 0),
         minutes: int = 5) -> list[tuple[int, float, float, float, float, float]]:
    t, stop = et(day, *start), et(day, *end)
    rows = []
    while t < stop:
        rows.append((t, 10.0, 10.0, 10.0, 10.0, volume * minutes / 5))
        t += minutes * 60
    return rows


def buzz_service(tmp_path: Path, now: list[float], days: int = 20) -> BuzzService:
    """20 past sessions of 1,000 shares every 5 minutes, 7:00-20:00."""
    store = IntradayStore(tmp_path / "intraday.db")
    past = sessions_before(TODAY, days)
    for day in past:
        store.upsert("NVDA", 5, bars(day, 1000.0))
    end = et(past[-1], 20)
    store.cover("NVDA", 5, et(past[0], 4), end, True, end)

    async def history(*args, **kwargs):  # type: ignore[no-untyped-def]
        return []

    intraday = IntradayService(store, history, clock=lambda: now[0])
    return BuzzService(intraday, hub=None, clock=lambda: now[0])


class FakeProvider:
    name = "fake"
    simulated = False

    async def subscribe(self, symbols: frozenset[str]) -> None:
        pass

    async def run(self, emit, ready) -> None:  # type: ignore[no-untyped-def]
        ready()
        await asyncio.Event().wait()


def test_sessions_and_the_usual_curve() -> None:
    assert session_at(6 * 60 + 59) is None
    assert session_at(7 * 60)[0] == "pre" and session_at(9 * 60 + 29)[0] == "pre"
    assert session_at(9 * 60 + 30)[0] == "regular" and session_at(16 * 60 + 4)[0] == "regular"
    assert session_at(16 * 60 + 5)[0] == "post" and session_at(20 * 60) is None
    marks = [100.0, 300.0, 600.0]
    assert usual_at(marks, 2.5) == 50.0  # halfway to the first mark
    assert usual_at(marks, 7.5) == 200.0
    assert usual_at(marks, 99) == 600.0
    slots = {day: [1.0] * 156 for day in sessions_before(TODAY, 4)}
    assert usual(slots, TODAY, session_at(600)) == []  # too few days to know the usual


def test_buzz_compares_today_with_the_same_time_of_day(tmp_path: Path) -> None:
    now = [float(et(TODAY, 10, 1) + 30)]  # 10:01:30: minutes up to 10:00 count
    service = buzz_service(tmp_path, now)
    # Today: twice the usual volume, as the stream's 1-minute bars.
    service.intraday.store.upsert("NVDA", 1, bars(TODAY, 2000.0, end=(10, 1), minutes=1))
    value = service.value("NVDA")
    assert value == {"session": "regular", "day": "2026-10-13", "pct": 100.0, "volume": 12000.0}

    now[0] = float(et(TODAY, 8, 31))  # pre-market: from 7:00, both sides
    value = service.value("NVDA")
    assert value["session"] == "pre" and value["pct"] == 100.0 and value["volume"] == 36000.0


def test_quiet_days_and_off_hours(tmp_path: Path) -> None:
    now = [float(et(TODAY, 16, 31))]  # after-hours with no trades yet: -100%
    service = buzz_service(tmp_path, now)
    service.intraday.store.upsert("NVDA", 1, bars(TODAY, 500.0, end=(16, 5), minutes=1))
    value = service.value("NVDA")
    assert value["session"] == "post" and value["pct"] == -100.0 and value["volume"] == 0
    # Saturday: Friday's... here Tuesday's final regular-session Buzz (half the usual).
    now[0] = float(et(TODAY + timedelta(days=4), 12))
    value = service.value("NVDA")
    assert value["session"] == "regular" and value["day"] == "2026-10-13"
    assert value["pct"] == -50.0


def test_no_buzz_without_enough_history(tmp_path: Path) -> None:
    service = buzz_service(tmp_path, [float(et(TODAY, 11))], days=3)
    assert service.value("NVDA") is None
    assert service.value("AMD") is None  # never fetched


async def test_hub_streams_bars_for_buzz_lists_and_sends_values() -> None:
    feed = FakeProvider()
    feed.bar_sink = None  # type: ignore[attr-defined]
    bar_subs: list[frozenset[str]] = []

    async def subscribe_bars(symbols: frozenset[str]) -> None:
        bar_subs.append(symbols)

    feed.subscribe_bars = subscribe_bars  # type: ignore[attr-defined]
    hub = LiveHub(feed)
    saved: list[str] = []
    hub.on_bar = lambda symbol, row: saved.append(symbol)
    hub.start()
    await asyncio.sleep(0)
    chart, lists = hub.attach(), hub.attach()
    await hub.watch_bars(chart, ["NVDA"])
    await hub.watch_buzz(lists, ["NVDA", "AMD"])
    assert bar_subs[-1] == {"NVDA", "AMD"} and set(hub.bars_since) == {"NVDA", "AMD"}
    row = (1_791_817_800, 1.0, 2.0, 0.5, 1.5, 100.0)
    feed.bar_sink("AMD", row)  # type: ignore[attr-defined]
    assert saved == ["AMD"]  # stored for the buzz...
    assert "bars" not in hub.drain(chart)  # ...but no chart shows it

    hub.set_buzz("AMD", {"session": "pre", "pct": 120.0})
    assert hub.drain(lists)["buzz"] == {"AMD": {"session": "pre", "pct": 120.0}}
    assert "buzz" not in hub.drain(chart)
    late = hub.attach()  # a new list gets known values at once
    await hub.watch_buzz(late, ["AMD"])
    assert hub.drain(late)["buzz"]["AMD"]["pct"] == 120.0

    await hub.watch_buzz(lists, [])
    await hub.detach(late)
    assert bar_subs[-1] == {"NVDA"} and "AMD" not in hub.buzz
    await hub.stop()


async def test_buzz_waits_for_a_stale_store() -> None:
    class Hub:
        wanted_buzz = frozenset({"NVDA"})
        buzz: dict = {}

        def set_buzz(self, symbol, value):  # type: ignore[no-untyped-def]
            self.buzz[symbol] = value

    class Intraday:
        fetched = 0.0
        fetches: list[str] = []

        def needs_fetch(self, symbol, minutes):  # type: ignore[no-untyped-def]
            return True

        class store:  # noqa: N801
            @staticmethod
            def coverage(symbol, minutes):  # type: ignore[no-untyped-def]
                return type("C", (), {"fetched_at": Intraday.fetched, "deep": True,
                                      "start": 0})()

        async def ensure(self, symbol, minutes, background=False):  # type: ignore[no-untyped-def]
            Intraday.fetches.append(symbol)

    hub = Hub()
    service = BuzzService(Intraday(), hub, clock=lambda: 10_000.0)  # type: ignore[arg-type]
    service.value = lambda symbol: {"pct": 1.0}  # type: ignore[method-assign]
    await service.refresh()
    await asyncio.sleep(0)
    assert Intraday.fetches == ["NVDA"] and hub.buzz == {}  # fetched yesterday: wait
    Intraday.fetched = 9_990.0  # the gap fetch landed
    await service.refresh()
    assert hub.buzz == {"NVDA": {"pct": 1.0}}
