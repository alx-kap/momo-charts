"""Screener: filter the whole stock database on today's readings, like a TC2000 scan.

Every common stock (and listed ETF) gets one row of readings from its daily bars. Filters are
applied to those rows; ETFs only when asked for. Read-only; nothing here touches the scanner,
its rankings or Alex's reviews.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from momo_scan.metrics import adr_percent
from momo_scan.models import Bar

BARS_NEEDED = 260
MIN_BARS = 64
LIMIT = 500

# key, label, kind. Numbers filter with >= and <=; flags are on or off; text matches a name.
# Rules marked "any" form one OR group: a stock passes all the other rules and at least one of
# those, like TC2000's "top 10% over 1M OR 3M OR 6M".
FIELDS: list[dict[str, str]] = [
    {"key": "price", "label": "Price", "kind": "number"},
    {"key": "chg", "label": "Change 1D %", "kind": "number"},
    {"key": "gap", "label": "Gap %", "kind": "number"},
    {"key": "w1", "label": "Return 1W %", "kind": "number"},
    {"key": "m1", "label": "Return 1M %", "kind": "number"},
    {"key": "m3", "label": "Return 3M %", "kind": "number"},
    {"key": "m6", "label": "Return 6M %", "kind": "number"},
    {"key": "m1_rank", "label": "1M return rank (0-100)", "kind": "number"},
    {"key": "m3_rank", "label": "3M return rank (0-100)", "kind": "number"},
    {"key": "m6_rank", "label": "6M return rank (0-100)", "kind": "number"},
    {"key": "adr", "label": "ADR %", "kind": "number"},
    {"key": "dvol", "label": "$ Volume (20d avg, M)", "kind": "number"},
    {"key": "dvol1", "label": "$ Volume 1D (M)", "kind": "number"},
    {"key": "vol", "label": "Volume 1D (shares)", "kind": "number"},
    {"key": "rvol", "label": "Volume vs 50d avg (×)", "kind": "number"},
    {"key": "from_high", "label": "Below 52w high %", "kind": "number"},
    {"key": "from_low", "label": "Above 52w low %", "kind": "number"},
    {"key": "d10", "label": "Above 10d avg %", "kind": "number"},
    {"key": "d20", "label": "Above 20d avg %", "kind": "number"},
    {"key": "d50", "label": "Above 50d avg %", "kind": "number"},
    {"key": "d200", "label": "Above 200d avg %", "kind": "number"},
    {"key": "range5", "label": "5-day range (ADRs)", "kind": "number"},
    {"key": "run50", "label": "Days closing above 50d avg", "kind": "number"},
    {"key": "held20", "label": "Closes above 20d avg, last 3M %", "kind": "number"},
    {"key": "stack", "label": "10 > 20 > 50d averages", "kind": "flag"},
    {"key": "new_high", "label": "Closing at a 52w high", "kind": "flag"},
    {"key": "earnings_days", "label": "Days to earnings", "kind": "number"},
    {"key": "eps_yoy_pct", "label": "EPS Q YoY %", "kind": "number"},
    {"key": "revenue_yoy_pct", "label": "Sales Q YoY %", "kind": "number"},
    {"key": "eps_annual_yoy_pct", "label": "EPS annual YoY %", "kind": "number"},
    {"key": "net_margin_pct", "label": "Net margin %", "kind": "number"},
    {"key": "eps_acceleration", "label": "EPS acceleration", "kind": "flag"},
    {"key": "sector", "label": "Sector", "kind": "text"},
    {"key": "industry", "label": "Industry", "kind": "text"},
    {"key": "theme", "label": "Theme", "kind": "text"},
]
KINDS = {field["key"]: field["kind"] for field in FIELDS}


def _sma(closes: list[float], period: int) -> float | None:
    return sum(closes[-period:]) / period if len(closes) >= period else None


def _closes_above(closes: list[float], period: int, days: int) -> list[bool]:
    """For each of the last `days` sessions: did it close at or above its own `period` average?
    Sessions without a full average yet count as below."""

    sums = [0.0]
    for close in closes:
        sums.append(sums[-1] + close)
    return [
        i >= period - 1 and closes[i] * period >= sums[i + 1] - sums[i + 1 - period]
        for i in range(len(closes) - days, len(closes))
    ]


def _run(flags: list[bool]) -> int:
    """How many of the latest flags are True in a row."""

    count = 0
    for flag in reversed(flags):
        if not flag:
            break
        count += 1
    return count


def _above(last: float, average: float | None) -> float | None:
    return None if not average else round(100.0 * (last / average - 1), 2)


def readings(bars: list[Bar], meta: dict[str, Any], themes: list[str]) -> dict[str, Any] | None:
    """One stock's row, or None without enough history."""

    if len(bars) < MIN_BARS:
        return None
    last = bars[-1]
    closes = [bar.c for bar in bars]
    try:
        adr = adr_percent(bars)
    except ValueError:
        return None

    def back(n: int) -> float | None:
        prior = closes[-n - 1] if len(closes) > n else None
        return round(100.0 * (last.c / prior - 1), 2) if prior else None

    year = bars[-252:]
    high, low = max(bar.h for bar in year), min(bar.l for bar in year)
    prior_close = max((bar.c for bar in year[:-1]), default=last.c)
    recent = bars[-5:]
    width = 100.0 * (max(bar.h for bar in recent) - min(bar.l for bar in recent)) / last.c
    sma10, sma20, sma50 = _sma(closes, 10), _sma(closes, 20), _sma(closes, 50)
    avg_volume = sum(bar.v for bar in bars[-51:-1]) / 50 if len(bars) > 50 else None
    return {
        "symbol": meta["symbol"],
        "name": meta.get("description") or meta["ticker"],
        "sector": meta.get("sector") or "Unknown",
        "industry": meta.get("industry") or "Unknown",
        "theme": themes,
        "etf": bool(meta.get("etf")),
        "date": datetime.fromtimestamp(last.t, tz=UTC).date().isoformat(),
        "price": round(last.c, 2),
        "chg": back(1),
        "gap": round(100.0 * (last.o / closes[-2] - 1), 2) if closes[-2] else None,
        "from_open": round(100.0 * (last.c / last.o - 1), 2),
        "w1": back(5),
        "m1": back(21),
        "m3": back(65),  # TC2000's "Price Percent Change 3 Month" is C65
        "m6": back(130),  # and 6 Month is C130
        "adr": round(adr, 2),
        "dvol": round(sum(bar.c * bar.v for bar in bars[-20:]) / 20 / 1e6, 2),
        "dvol1": round(last.c * last.v / 1e6, 2),
        "vol": last.v,
        "avg_vol": avg_volume,  # for relative volume as live volume comes in
        "rvol": round(last.v / avg_volume, 2) if avg_volume else None,
        "from_high": round(100.0 * (1 - last.c / high), 2),
        "from_low": round(100.0 * (last.c / low - 1), 2) if low > 0 else None,
        "d10": _above(last.c, sma10),
        "d20": _above(last.c, sma20),
        "d50": _above(last.c, sma50),
        "d200": _above(last.c, _sma(closes, 200)),
        "range5": round(width / adr, 2) if adr else None,
        # Relentless leaders respect their averages for months: a streak above the 50-day, and
        # the 20-day held on most closes.
        "run50": _run(_closes_above(closes, 50, len(closes))),
        "held20": round(100.0 * sum(_closes_above(closes, 20, 63)) / 63) if len(closes) >= 83
        else None,
        "stack": bool(sma10 and sma20 and sma50 and sma10 > sma20 > sma50),
        "new_high": last.c >= prior_close,
    }


def build_table(
    stocks: Iterable[tuple[dict[str, Any], list[Bar]]], themes: dict[str, list[str]]
) -> list[dict[str, Any]]:
    rows = []
    for meta, bars in stocks:
        row = readings(bars, meta, themes.get(meta["ticker"], []))
        if row:
            rows.append(row)
    _add_ranks(rows)
    return rows


def _add_ranks(rows: list[dict[str, Any]]) -> None:
    """Percentile of each 1/3/6-month return among all stocks, like TC2000's rank. ETFs are
    placed against the stocks too, so adding them never moves a stock's rank."""

    for period in ("m1", "m3", "m6"):
        ordered = sorted(row[period] for row in rows if row[period] is not None and not row["etf"])
        for row in rows:
            have = row[period]
            if have is None or not ordered:
                row[f"{period}_rank"] = None
                continue
            below, through = bisect_left(ordered, have), bisect_right(ordered, have)
            row[f"{period}_rank"] = round(100.0 * (below + through) / 2 / len(ordered), 1)


SESSION_MINUTES = 390
MARKET_TZ = ZoneInfo("America/New_York")


def session_done(day: str, now: datetime | None = None) -> float:
    """The share of a regular session traded by now (at least 15 minutes' worth); 1 for any
    day but today. The same estimate as sessionDone() in live.js."""

    local = (now or datetime.now(UTC)).astimezone(MARKET_TZ)
    if local.date().isoformat() != day:
        return 1.0
    minutes = local.hour * 60 + local.minute - (9 * 60 + 30)
    return min(1.0, max(15, minutes) / SESSION_MINUTES)


def with_quotes(
    table: list[dict[str, Any]], quotes: dict[str, Any], now: datetime | None = None
) -> list[dict[str, Any]]:
    """Rows brought up to today's trading by live quotes (keyed by plain ticker). Price,
    change, gap, volume, $ volume and relative volume follow the quote, like liveRow() in
    screener.js; the readings built on closes keep yesterday's. Stocks without a quote from
    today's session stay as they were."""

    out = []
    for row in table:
        quote = quotes.get(row["symbol"].rsplit(":", 1)[-1])
        if quote is None or quote.day.isoformat() < row["date"]:
            out.append(row)
            continue
        base = quote.prev_close
        volume = quote.volume if quote.volume is not None else row["vol"]
        avg = row.get("avg_vol")
        out.append({
            **row, "live": True, "price": round(quote.last, 2),
            "chg": round(100.0 * (quote.last / base - 1), 2) if base else row["chg"],
            "gap": round(100.0 * (quote.open / base - 1), 2) if base and quote.open
            else row["gap"],
            "from_open": round(100.0 * (quote.last / quote.open - 1), 2) if quote.open
            else row["from_open"],
            "vol": volume, "dvol1": round(volume * quote.last / 1e6, 2),
            "rvol": round(volume / (avg * session_done(quote.day.isoformat(), now)), 2)
            if avg else row["rvol"],
        })
    return out


def _passes(row: dict[str, Any], rule: dict[str, Any]) -> bool:
    key, kind, value = rule.get("field"), KINDS.get(rule.get("field", "")), rule.get("value")
    if kind == "number":
        have = row.get(key)
        if have is None:
            return False
        return have >= value if rule.get("op") == ">=" else have <= value
    if kind == "flag":
        return row.get(key) is not None and bool(row.get(key)) == bool(value)
    if kind == "text":
        have = row.get(key)
        names = have if isinstance(have, list) else [have]
        return any(str(value).lower() in str(name).lower() for name in names)
    return False


def clean_rules(raw: Any) -> list[dict[str, Any]]:
    """Keep only well-formed rules, so a stale saved scan can't break the screen."""

    rules = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict) or item.get("field") not in KINDS:
            continue
        kind, value = KINDS[item["field"]], item.get("value")
        if kind == "number":
            if isinstance(value, bool) or not isinstance(value, int | float):
                continue
            rule = {"field": item["field"], "op": "<=" if item.get("op") == "<=" else ">=",
                    "value": value}
        elif kind == "flag":
            rule = {"field": item["field"], "value": bool(value)}
        elif isinstance(value, str) and value.strip():
            rule = {"field": item["field"], "value": value.strip()}
        else:
            continue
        if item.get("any") is True:
            rule["any"] = True
        rules.append(rule)
    return rules


def _matches(row: dict[str, Any], every: list[dict[str, Any]], some: list[dict[str, Any]]) -> bool:
    return all(_passes(row, rule) for rule in every) and (
        not some or any(_passes(row, rule) for rule in some))


def _sort(rows: list[dict[str, Any]], sort: str, desc: bool) -> None:
    if KINDS.get(sort) in ("number", "flag"):
        sign = -1 if desc else 1
        rows.sort(key=lambda row: (row.get(sort) is None, sign * (row.get(sort) or 0)))
    else:
        key = sort if sort in ("name", "sector", "industry") else "symbol"
        rows.sort(key=lambda row: str(row[key]).lower(), reverse=desc)


def screen(
    table: list[dict[str, Any]],
    rules: list[dict[str, Any]],
    sort: str = "m1",
    desc: bool = True,
    pin: str | None = None,
    pin_desc: bool = False,
    etfs: bool = False,
) -> dict[str, Any]:
    """Matches, sorted by the pinned column first (if any), then by `sort` within it. ETFs are
    left out unless `etfs`."""

    every = [rule for rule in rules if not rule.get("any")]
    some = [rule for rule in rules if rule.get("any")]
    found = [row for row in table if (etfs or not row["etf"]) and _matches(row, every, some)]
    _sort(found, sort, desc)
    if pin:
        _sort(found, pin, pin_desc)  # stable, so `sort` holds within each pinned group
    return {"total": len(found), "rows": found[:LIMIT]}
