"""NYSE session counts for earnings warnings, matching the chart's earnings calendar."""

from datetime import date, timedelta
from functools import lru_cache


@lru_cache(maxsize=64)
def holidays(year: int) -> frozenset[date]:
    def nth(month: int, weekday: int, n: int) -> date:
        first = date(year, month, 1)
        return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))

    def observed(month: int, day: int, friday: bool = True) -> date:
        value = date(year, month, day)
        shift = 1 if value.weekday() == 6 else -1 if value.weekday() == 5 and friday else 0
        return value + timedelta(days=shift)

    # Gregorian Easter, then Good Friday.
    a, b, c = year % 19, year // 100, year % 100
    d, e, f = b // 4, b % 4, (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    leap = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * leap) // 451
    n = h + leap - 7 * m + 114
    easter = date(year, n // 31, n % 31 + 1)
    may = date(year, 5, 31)
    days = {
        observed(1, 1, False), nth(1, 0, 3), nth(2, 0, 3), easter - timedelta(days=2),
        may - timedelta(days=may.weekday()), observed(7, 4), nth(9, 0, 1), nth(11, 3, 4),
        observed(12, 25),
    }
    if year >= 2022:
        days.add(observed(6, 19))
    days.update(date.fromisoformat(day) for day in (
        "2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14", "2004-06-11",
        "2007-01-02", "2012-10-29", "2012-10-30", "2018-12-05", "2025-01-09",
    ))
    return frozenset(days)


def sessions_between(start: date, end: date) -> int:
    count = 0
    while start < end:
        start += timedelta(days=1)
        count += start.weekday() < 5 and start not in holidays(start.year)
    return count
