from datetime import UTC, date, datetime, timedelta

import pytest

from momo_scan.models import Bar
from momo_scan.web.timeframes import aggregate, parse_interval


def _daily(start: date, days: int) -> list[Bar]:
    bars = []
    day = start
    n = 0
    while len(bars) < days:
        if day.weekday() < 5:
            t = int(datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp())
            bars.append(Bar(t=t, o=10 + n, h=12 + n, l=9 + n, c=11 + n, v=100))
            n += 1
        day += timedelta(days=1)
    return bars


def test_parse_interval_accepts_tradingview_style_text() -> None:
    assert parse_interval("1d") == ("D", 1)
    assert parse_interval("W") == ("W", 1)
    assert parse_interval("3M") == ("M", 3)
    for bad in ("5", "1h", "0W", "13M", ""):
        with pytest.raises(ValueError):
            parse_interval(bad)


def test_weekly_bars_merge_each_iso_week() -> None:
    daily = _daily(date(2026, 1, 5), 10)  # Monday: two full weeks
    weekly = aggregate(daily, "W", 1)
    assert len(weekly) == 2
    first = weekly[0]
    assert first.t == daily[0].t
    assert (first.o, first.c) == (daily[0].o, daily[4].c)
    assert first.h == max(bar.h for bar in daily[:5])
    assert first.l == min(bar.l for bar in daily[:5])
    assert first.v == 500


def test_monthly_multiples_group_consecutive_months() -> None:
    daily = _daily(date(2026, 1, 1), 130)  # about six months
    months = aggregate(daily, "M", 1)
    quarters = aggregate(daily, "M", 3)
    assert len(months) == 7 or len(months) == 6
    assert len(quarters) == -(-len(months) // 3)
    assert quarters[0].v == sum(bar.v for bar in months[:3])
    assert aggregate(daily, "D", 1) == daily
    assert len(aggregate(daily, "D", 5)) == 26
