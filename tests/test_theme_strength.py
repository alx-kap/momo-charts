from __future__ import annotations

import asyncio
from datetime import date

from momo_scan.models import Bar
from momo_scan.theme_strength import member_stats, theme_pullback, theme_strength, theme_trend
from momo_scan.themes import ThemeTaxonomy

DAY = 86400


def _bars(closes: list[float], spread: float = 0.5) -> list[Bar]:
    return [
        Bar(t=1_700_000_000 + n * DAY, o=c, h=c + spread, l=c - spread, c=c, v=1e6)
        for n, c in enumerate(closes)
    ]


def test_member_stats_returns_and_tightening() -> None:
    # A steady climb, then five tight sessions on top: above both averages and tightening.
    closes = [50 + n * 0.5 for n in range(100)] + [100.0] * 5
    stats = member_stats(_bars(closes, spread=0.3))
    assert stats is not None
    assert stats["above20"] and stats["above50"] and stats["tightening"]
    assert stats["w1"] == round(100 * (100.0 / closes[-6] - 1), 1)


def test_member_stats_needs_history() -> None:
    assert member_stats(_bars([10.0] * 30)) is None


def test_downtrend_is_not_above_its_averages() -> None:
    stats = member_stats(_bars([100 - n * 0.4 for n in range(100)]))
    assert stats is not None
    assert not stats["above20"] and not stats["above50"] and not stats["tightening"]
    assert stats["m1"] < 0


class _Provider:
    async def get_chart_bars(self, symbol: str, count: int, as_of: date | None = None):
        rising = [50 + n for n in range(100)]
        return _bars(rising if symbol == "UP" else rising[::-1])


def test_theme_medians_and_adjacent_members_are_left_out() -> None:
    taxonomy = ThemeTaxonomy.model_validate({
        "taxonomy_version": "t", "imported_at": "2026-01-01",
        "themes": [{"theme_id": "a", "name": "A"}, {"theme_id": "empty", "name": "Empty"}],
        "memberships": [
            {"ticker": "UP", "theme_id": "a", "role": "core", "include_in_metrics": True,
             "effective_from": "2026-01-01"},
            {"ticker": "DOWN", "theme_id": "a", "role": "adjacent", "include_in_metrics": False,
             "effective_from": "2026-01-01"},
        ],
    })
    report = asyncio.run(theme_strength(_Provider(), taxonomy, date(2026, 6, 1)))
    assert [t["id"] for t in report["themes"]] == ["a"]  # empty themes drop out
    theme = report["themes"][0]
    assert theme["members"] == 1 and theme["above50"] == 100
    assert [s["symbol"] for s in theme["stocks"]] == ["UP"]


def test_trend_rebases_each_stock_and_takes_the_daily_median() -> None:
    doubling = [50.0 + n * 50.0 / 63 for n in range(64)]
    flat = [20.0] * 64
    trend = theme_trend([doubling, flat, [10.0] * 10])  # too little history: left out
    assert len(trend) == 64 and trend[0] == 100.0
    assert trend[-1] == 150.0  # median of 200 and 100
    assert theme_trend([[10.0] * 10]) == []


def _uptrend_then_dip(tail: list[float]) -> list[float]:
    return [100 + n * 0.5 for n in range(50)] + tail


def test_pullback_bought_after_dip_to_the_20_day() -> None:
    # Rising to ~125, dips to ~117 (near the 20-day), then recovers above it.
    path = _uptrend_then_dip([124, 122, 120, 118, 117, 118.5, 120, 122, 124.5, 126])
    pullback = theme_pullback(path)
    assert pullback is not None
    assert pullback["state"] == "bought" and pullback["average"] == 20
    assert pullback["dip"] < -2 and pullback["bounce"] >= 1 and pullback["up_days"] >= 4


def test_pullback_testing_when_the_bounce_has_not_come() -> None:
    pullback = theme_pullback(_uptrend_then_dip([124, 122, 120, 118, 117.5, 117.3, 117.4]))
    assert pullback is not None and pullback["state"] == "testing"


def test_no_pullback_in_a_straight_climb_or_a_downtrend() -> None:
    assert theme_pullback([100 + n * 0.5 for n in range(64)]) is None
    assert theme_pullback([160 - n * 0.5 for n in range(64)]) is None


def _row(symbol, industry, **over):
    base = {"symbol": symbol, "industry": industry, "etf": False, "dvol": 50.0,
            "date": "2026-10-13", "chg": 1.0, "from_open": 0.5,
            "w1": 2.0, "m1": 3.0, "m3": 4.0, "d20": 1.0, "d50": 2.0, "range5": 1.0}
    return {**base, **over}


def test_industry_strength_filters_and_takes_medians():
    from momo_scan.theme_strength import industry_strength

    rows = [_row(f"A{i}", "Oil", m1=float(i)) for i in range(5)]
    rows += [_row("ETF", "Oil", etf=True), _row("THIN", "Oil", dvol=1.0, m1=99.0)]
    rows += [_row(f"B{i}", "Tiny") for i in range(3)] + [_row("U", "Unknown")]
    rows[0]["d50"] = -1.0
    rows[1]["range5"] = 2.0
    report = industry_strength(rows)
    assert [i["name"] for i in report["industries"]] == ["Oil"]
    oil = report["industries"][0]
    assert (oil["members"], oil["m1"], oil["above50"], oil["tightening"]) == (5, 2.0, 80, 3)
    assert oil["stocks"][0]["symbol"] == "A4"
    assert report["as_of"] == "2026-10-13"


def test_change_from_open_for_stocks_themes_and_industries():
    from momo_scan.theme_strength import industry_strength

    bars = _bars([50 + n * 0.5 for n in range(100)])
    bars[-1] = Bar(t=bars[-1].t, o=100.0, h=104.0, l=99.0, c=103.0, v=1e6)
    assert member_stats(bars)["from_open"] == 3.0
    report = asyncio.run(theme_strength(_Provider(), ThemeTaxonomy.model_validate({
        "taxonomy_version": "t", "imported_at": "2026-01-01",
        "themes": [{"theme_id": "a", "name": "A"}],
        "memberships": [{"ticker": "UP", "theme_id": "a", "role": "core",
                         "include_in_metrics": True, "effective_from": "2026-01-01"}],
    }), date(2026, 6, 1)))
    assert report["themes"][0]["from_open"] == 0.0  # the test bars open at the close
    rows = [_row(f"A{i}", "Oil", from_open=float(i)) for i in range(5)]
    oil = industry_strength(rows)["industries"][0]
    assert oil["from_open"] == 2.0 and oil["stocks"][0]["from_open"] is not None
