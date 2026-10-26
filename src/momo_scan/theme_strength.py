"""Theme strength: where money is moving, from the theme taxonomy and daily bars.

Each theme is its metric-active members' median change from the last open and 1D/1W/1M/3M
return, how many sit above their 20- and 50-day averages, and how many are tightening: above both
averages with a 5-session range no wider than 1.5 ADR. Read-only; nothing here touches the
scanner or its rankings.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from statistics import median
from typing import Any

from momo_scan.metrics import adr_percent
from momo_scan.models import Bar
from momo_scan.themes import ThemeTaxonomy

PERIODS = {"d1": 1, "w1": 5, "m1": 21, "m3": 63}
MOVES = ("from_open", *PERIODS)  # the medians a theme shows: change since the last open, returns
TIGHT_SESSIONS = 5
TIGHT_ADR = 1.5
BARS_NEEDED = 130
PULLBACK_WINDOW = 20  # sessions the high must sit within
PULLBACK_RECENT = 10  # the low must be this recent
PULLBACK_MIN_DIP = 2.0  # percent off the high
PULLBACK_TOUCH = 1.5  # percent: the low got this close to (or under) the average
PULLBACK_UNDER = 5.0  # but not more than this far under it (that is a breakdown)
BOUGHT_BOUNCE = 1.0  # percent off the low that counts as bought


def _sma(closes: list[float], period: int) -> float | None:
    return sum(closes[-period:]) / period if len(closes) >= period else None


def member_stats(bars: list[Bar]) -> dict[str, Any] | None:
    """One stock's returns and averages, or None without enough history."""

    if len(bars) < PERIODS["m3"] + 1:
        return None
    closes = [bar.c for bar in bars]
    last = closes[-1]
    sma20, sma50 = _sma(closes, 20), _sma(closes, 50)
    if not last or sma20 is None or sma50 is None:
        return None
    recent = bars[-TIGHT_SESSIONS:]
    width = 100.0 * (max(bar.h for bar in recent) - min(bar.l for bar in recent)) / last
    try:
        adr = adr_percent(bars)
    except ValueError:
        adr = None
    above = last > sma20 and last > sma50
    return {
        **{
            key: round(100.0 * (last / closes[-n - 1] - 1), 1) if closes[-n - 1] > 0 else None
            for key, n in PERIODS.items()
        },
        "from_open": round(100.0 * (last / bars[-1].o - 1), 1),
        "above20": last > sma20,
        "above50": last > sma50,
        "tightening": bool(above and adr and width <= TIGHT_ADR * adr),
    }


def theme_trend(series: list[list[float]]) -> list[float]:
    """The theme's path over the last 3 months: each stock rebased to 100, median by day."""

    length = PERIODS["m3"] + 1
    rebased = []
    for closes in series:
        tail = closes[-length:]
        if len(tail) == length and tail[0] > 0:
            rebased.append([100.0 * close / tail[0] for close in tail])
    return [round(median(day), 1) for day in zip(*rebased, strict=True)]


def theme_pullback(path: list[float]) -> dict[str, Any] | None:
    """A theme in an uptrend that pulled back to its 20- or 50-day average, from its 3M path.

    Looks at the theme's median path: its lowest close of the last 10 sessions against the high
    of the 20 before it. The low must be at least 2% under that high and between 5% below and
    1.5% above the 20-day (else the 50-day) average at that moment, with the 20-day above the
    50-day: a dip in a rising group. "bought" once the path has come 1% off the low and is back
    above its 20-day; else "testing".
    """

    n = len(path)
    if n < 51:
        return None
    recent = path[-PULLBACK_RECENT:]
    low_at = n - PULLBACK_RECENT + recent.index(min(recent))
    before = path[max(0, low_at - PULLBACK_WINDOW) : low_at]
    if not before:
        return None
    high, low, last = max(before), path[low_at], path[-1]
    dip = 100.0 * (low / high - 1)
    sma20, sma50 = _sma(path[: low_at + 1], 20), _sma(path[: low_at + 1], 50)
    if dip > -PULLBACK_MIN_DIP or sma20 is None or sma50 is None or sma20 <= sma50:
        return None
    touch = 1 + PULLBACK_TOUCH / 100
    under = 1 - PULLBACK_UNDER / 100
    near = ((20, sma20), (50, sma50))
    average = next((p for p, v in near if v * under <= low <= v * touch), None)
    if average is None:
        return None
    bounce = 100.0 * (last / low - 1)
    bought = bounce >= BOUGHT_BOUNCE and last > (_sma(path, 20) or last)
    return {
        "state": "bought" if bought else "testing",
        "average": average,
        "dip": round(dip, 1),
        "bounce": round(bounce, 1),
        "days": n - 1 - low_at,
        "up_days": sum(b > a for a, b in zip(path[low_at:], path[low_at + 1 :], strict=False)),
        "vs20": round(100.0 * (last / _sma(path, 20) - 1), 1),
    }


def _median(values: list[float | None]) -> float | None:
    found = [value for value in values if value is not None]
    return round(median(found), 1) if found else None


async def theme_strength(
    provider: Any, taxonomy: ThemeTaxonomy, as_of: date | None = None
) -> dict[str, Any]:
    day = as_of or date.today()
    members: dict[str, list[str]] = {}
    for item in taxonomy.active_memberships(day):
        if item.include_in_metrics:
            members.setdefault(item.theme_id, []).append(item.ticker)
    cache: dict[str, dict[str, Any] | None] = {}
    closes: dict[str, list[float]] = {}
    themes = []
    latest = ""
    for theme in taxonomy.themes:
        rows = []
        for symbol in sorted(set(members.get(theme.theme_id, []))):
            if symbol not in cache:
                bars = await provider.get_chart_bars(symbol, BARS_NEEDED, day)
                cache[symbol] = member_stats(bars)
                closes[symbol] = [bar.c for bar in bars[-(PERIODS['m3'] + 1):]]
                if bars:
                    stamp = datetime.fromtimestamp(bars[-1].t, tz=UTC).date().isoformat()
                    latest = max(latest, stamp)
            if cache[symbol]:
                rows.append({"symbol": symbol, **cache[symbol]})
        if not rows:
            continue
        trend = theme_trend([closes[row["symbol"]] for row in rows])
        themes.append({
            "id": theme.theme_id,
            "name": theme.name,
            "members": len(rows),
            **{key: _median([row[key] for row in rows]) for key in MOVES},
            "above20": round(100.0 * sum(row["above20"] for row in rows) / len(rows)),
            "above50": round(100.0 * sum(row["above50"] for row in rows) / len(rows)),
            "tightening": sum(row["tightening"] for row in rows),
            "trend": trend,
            "pullback": theme_pullback(trend),
            "stocks": sorted(rows, key=lambda row: -(row["m1"] if row["m1"] is not None else -999)),
        })
    return {"as_of": latest or None, "themes": themes}


INDUSTRY_MIN_DVOL = 10.0  # $M a day (20d avg): thinner stocks would swing an industry's median
INDUSTRY_MIN_MEMBERS = 4


def industry_strength(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Strength by industry, from the screener's table: the same median returns, share above the
    50-day and tightening count as a theme, over each industry's liquid common stocks."""

    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        if row["etf"] or row["industry"] == "Unknown" or row["dvol"] < INDUSTRY_MIN_DVOL:
            continue
        groups.setdefault(row["industry"], []).append(row)
    industries = []
    for name, members in sorted(groups.items()):
        if len(members) < INDUSTRY_MIN_MEMBERS:
            continue
        stocks = [
            {
                "symbol": row["symbol"].split(":")[-1],
                "from_open": row["from_open"],
                "d1": row["chg"],
                "w1": row["w1"],
                "m1": row["m1"],
                "m3": row["m3"],
                "tightening": bool(
                    row["d20"] and row["d20"] > 0 and row["d50"] and row["d50"] > 0
                    and row["range5"] is not None and row["range5"] <= TIGHT_ADR
                ),
            }
            for row in members
        ]
        industries.append({
            "id": name,
            "name": name,
            "members": len(members),
            **{key: _median([row[src] for row in members])
               for key, src in (("from_open", "from_open"), ("d1", "chg"), ("w1", "w1"),
                                ("m1", "m1"), ("m3", "m3"))},
            "above50": round(100.0 * sum(bool(r["d50"] and r["d50"] > 0) for r in members)
                             / len(members)),
            "tightening": sum(stock["tightening"] for stock in stocks),
            "stocks": sorted(stocks, key=lambda stock: -(stock["m1"] if stock["m1"] is not None
                                                          else -999)),
        })
    return {"as_of": max((row["date"] for row in rows), default=None), "industries": industries}
