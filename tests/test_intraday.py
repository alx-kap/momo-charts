from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path

import pytest

from momo_scan.intraday import (
    IntradayService,
    IntradayStore,
    aggregate,
    bucket_start,
    in_session,
)
from momo_scan.live.base import MARKET_TZ


def et(day: int, hour: int, minute: int = 0, second: int = 0) -> int:
    return int(datetime(2026, 10, day, hour, minute, second, tzinfo=MARKET_TZ).timestamp())


class FakeHistory:
    """The provider's history: a bar every `minutes` from 4:00 to 20:00 ET, weekdays."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, int, int, int, bool]] = []
        self.delay = 0.0

    async def __call__(
        self, symbol: str, minutes: int, start: int, end: int, background: bool = False
    ) -> list[tuple[int, float, float, float, float, float]]:
        self.calls.append((symbol, minutes, start, end, background))
        await asyncio.sleep(self.delay)
        step = minutes * 60
        rows = []
        t = start - start % step
        while t < end:
            if in_session(t, extended=True) and datetime.fromtimestamp(t, MARKET_TZ).weekday() < 5:
                price = 100 + (t % 3600) / 3600
                rows.append((t, price, price + 0.5, price - 0.5, price + 0.1, 1000.0 * minutes))
            t += step
        return rows


def service(tmp_path: Path, now: list[float], since: dict[str, float] | None = None):
    history = FakeHistory()
    store = IntradayStore(tmp_path / "intraday.db")
    lookup = (since if since is not None else {}).get
    return IntradayService(store, history, lookup, clock=lambda: now[0]), history


def test_buckets_anchor_at_the_open_and_merge_bars() -> None:
    assert bucket_start(et(12, 10, 47), 60) == et(12, 9, 30) + 3600  # 10:30 bar
    assert bucket_start(et(12, 9, 10), 60) == et(12, 8, 30)  # pre-market hour
    assert bucket_start(et(12, 9, 34), 5) == et(12, 9, 30)
    rows = [(et(12, 9, 30), 10, 11, 9, 10.5, 100), (et(12, 9, 35), 10.5, 12, 10, 11, 50),
            (et(12, 9, 45), 11, 11.5, 10.8, 11.2, 70)]
    assert aggregate(rows, 15) == [
        (et(12, 9, 30), 10, 12, 9, 11, 150), (et(12, 9, 45), 11, 11.5, 10.8, 11.2, 70),
    ]
    assert in_session(et(12, 9, 30), extended=False) and not in_session(et(12, 9, 25), False)
    assert in_session(et(12, 7, 0), extended=True) and not in_session(et(12, 20, 0), True)


async def test_first_open_fetches_two_weeks_then_the_rest_in_the_background(tmp_path: Path) -> None:
    now = [float(et(12, 11, 2, 30))]
    intraday, history = service(tmp_path, now)
    payload = await intraday.bars("NVDA", "5m", 50)
    first = history.calls[0]
    assert first[:2] == ("NVDA", 5) and (now[0] - first[2]) / 86400 == pytest.approx(12)
    # The forming 11:00 bar is built from its finished minutes (11:00 and 11:01).
    assert history.calls[1][:3] == ("NVDA", 1, et(12, 11, 0))
    bars = payload["bars"]
    assert bars[-1]["time"] == et(12, 11, 0) and bars[-1]["volume"] == 2000
    assert bars[-2]["time"] == et(12, 10, 55) and bars[-2]["volume"] == 5000
    await asyncio.sleep(0.05)  # the background fill: 200 days, marked as background
    deep = history.calls[2]
    assert deep[1] == 5 and deep[4] is True and (now[0] - deep[2]) / 86400 == pytest.approx(200)
    assert intraday.store.coverage("NVDA", 5).deep


async def test_reopening_reads_the_store_and_charts_share_one_fetch(tmp_path: Path) -> None:
    now = [float(et(12, 11, 2, 30))]
    intraday, history = service(tmp_path, now)
    history.delay = 0.02
    await asyncio.gather(*(intraday.bars("NVDA", "5m", 50) for _ in range(5)))
    assert len([call for call in history.calls if call[1] == 5 and not call[4]]) == 1
    calls = len(history.calls)
    for interval in ("5m", "15m", "1h"):
        await intraday.bars("NVDA", interval, 50)  # all from the stored 5m bars
    assert len(history.calls) == calls


async def test_stale_charts_fetch_only_the_gap_unless_the_stream_kept_them(tmp_path: Path) -> None:
    now = [float(et(12, 11, 2, 30))]
    since: dict[str, float] = {}
    intraday, history = service(tmp_path, now, since)
    await intraday.bars("NVDA", "5m", 50)
    await asyncio.sleep(0.05)
    calls = len(history.calls)
    now[0] += 30
    await intraday.bars("NVDA", "5m", 50)
    assert len(history.calls) == calls  # fresh enough
    now[0] += 120
    await intraday.bars("NVDA", "5m", 50)
    gap = history.calls[calls]
    assert gap[1] == 5 and gap[2] == et(12, 11, 0)  # from the first unfinished bar
    calls = len(history.calls)
    since["NVDA"] = now[0] - 1  # streaming since before the last fetch
    now[0] += 600
    intraday.save_streamed("NVDA", (et(12, 11, 10), 101, 102, 100, 101.5, 777))
    payload5 = await intraday.bars("NVDA", "5m", 5)
    assert history.calls[calls:] == []  # all from the store
    # The 11:10 bar so far is the one streamed minute.
    assert payload5["bars"][-1]["time"] == et(12, 11, 10) and payload5["bars"][-1]["volume"] == 777


async def test_after_the_close_one_refresh_then_none(tmp_path: Path) -> None:
    now = [float(et(12, 15, 0))]
    intraday, history = service(tmp_path, now)
    await intraday.bars("NVDA", "5m", 50)
    await asyncio.sleep(0.05)
    now[0] = float(et(12, 21, 0))  # after the post-market ends: the day's bars are final
    calls = len(history.calls)
    await intraday.bars("NVDA", "5m", 50)
    assert len(history.calls) == calls + 1
    now[0] += 3600
    await intraday.bars("NVDA", "5m", 50, extended=False)
    assert len(history.calls) == calls + 1
    payload = await intraday.bars("NVDA", "5m", 500, extended=False)
    times = [datetime.fromtimestamp(bar["time"], MARKET_TZ) for bar in payload["bars"]]
    assert all((9, 30) <= (t.hour, t.minute) < (16, 0) for t in times)


async def test_on_a_bar_boundary_there_are_no_minutes_to_fetch(tmp_path: Path) -> None:
    now = [float(et(12, 11, 5, 0))]  # Schwab refuses an empty range
    intraday, history = service(tmp_path, now)
    await intraday.bars("NVDA", "5m", 50)
    assert [call[1] for call in history.calls if not call[4]] == [5]


async def test_extended_bar_is_the_session_so_far(tmp_path: Path) -> None:
    now = [float(et(13, 8, 30))]
    intraday, _ = service(tmp_path, now)
    store = intraday.store
    store.upsert("NVDA", 1, [
        (et(12, 19, 59), 9.0, 9.0, 9.0, 9.0, 5.0),  # yesterday's post-market: not today's
        (et(13, 7, 0), 10.0, 11.0, 9.5, 10.5, 100.0),
        (et(13, 8, 0), 10.5, 12.0, 10.0, 11.5, 50.0),
    ])
    assert intraday.extended_bar("NVDA") == {
        "session": "pre", "open": 10.0, "high": 12.0, "low": 9.5, "close": 11.5, "volume": 150.0,
    }
    now[0] = float(et(13, 10, 0))  # regular session: no ghost
    assert intraday.extended_bar("NVDA") is None
    now[0] = float(et(13, 16, 30))  # post-market, nothing traded yet
    assert intraday.extended_bar("NVDA") is None
