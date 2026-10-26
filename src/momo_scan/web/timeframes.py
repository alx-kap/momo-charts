"""Chart timeframes built from daily bars: 1D, 1W, 1M and multiples like 2W or 3M.

The archive only has daily bars, so weekly and monthly bars are aggregated here. A bar is
stamped with its first trading day, like TradingView, and the latest one may be partial.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime

from momo_scan.models import Bar

# Roughly how many trading days one bar of each unit spans, to size the daily fetch.
TRADING_DAYS = {"D": 1, "W": 5, "M": 21}
MAX_DAILY = 12_000  # about 47 years: the whole archive


def parse_interval(text: str) -> tuple[str, int]:
    """'1D', 'w', '3M' -> (unit, count). Raises ValueError on anything else."""

    match = re.fullmatch(r"(\d{1,2})?\s*([DWM])", text.strip().upper())
    if not match:
        raise ValueError(f"Unknown timeframe {text!r}: use D, W or M, e.g. 1D, 1W, 3M")
    count = int(match.group(1) or 1)
    if not 1 <= count <= 12:
        raise ValueError("Timeframe multiples run from 1 to 12")
    return match.group(2), count


def daily_bars_needed(unit: str, count: int, bars: int) -> int:
    return min(MAX_DAILY, bars * count * TRADING_DAYS[unit] + 30)


def _day(bar: Bar) -> date:
    return datetime.fromtimestamp(bar.t, tz=UTC).date()


def _period(day: date, unit: str) -> tuple[int, int]:
    if unit == "W":
        year, week, _ = day.isocalendar()
        return (year, week)
    return (day.year, day.month)


def aggregate(bars: list[Bar], unit: str, count: int) -> list[Bar]:
    """Merge daily bars into `count`-period bars of `unit` (D, W or M), oldest first."""

    if unit == "D" and count == 1:
        return list(bars)
    groups: list[list[Bar]] = []
    last_period: tuple[int, int] | None = None
    periods_in_group = 0
    for bar in bars:
        if unit == "D":
            starts = not groups or len(groups[-1]) == count
        else:
            period = _period(_day(bar), unit)
            starts = period != last_period
            if starts and groups and periods_in_group < count:
                starts = False
                periods_in_group += 1
            elif starts:
                periods_in_group = 1
            last_period = period
        if starts:
            groups.append([bar])
        else:
            groups[-1].append(bar)
    return [
        Bar(
            t=group[0].t,
            o=group[0].o,
            h=max(bar.h for bar in group),
            l=min(bar.l for bar in group),
            c=group[-1].c,
            v=sum(bar.v for bar in group),
        )
        for group in groups
    ]
