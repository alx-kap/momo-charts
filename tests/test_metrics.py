from __future__ import annotations

import pytest

from momo_scan.metrics import adr_percent, average_dollar_volume, percentile_rank, return_percent
from momo_scan.models import Bar


def test_tc2000_formulas_are_exact() -> None:
    bars = [
        Bar(t=index, o=10 + index, h=(10 + index) * 1.05, l=10 + index, c=10 + index, v=2_000_000)
        for index in range(30)
    ]
    assert adr_percent(bars) == pytest.approx(5.0)
    expected_adv = sum(bar.c * bar.v for bar in bars[-20:]) / 20
    assert average_dollar_volume(bars) == pytest.approx(expected_adv)
    expected_return = 100 * (bars[-1].c - bars[-22].c) / bars[-22].c
    assert return_percent(bars, 21) == pytest.approx(expected_return)


def test_percentile_rank_uses_midpoint_for_ties() -> None:
    assert percentile_rank(3.0, [1.0, 2.0, 3.0, 3.0, 5.0]) == pytest.approx(60.0)


def test_adr_rejects_missing_history() -> None:
    with pytest.raises(ValueError, match="requires 20"):
        adr_percent([Bar(t=1, o=1, h=2, l=1, c=1.5, v=1)])
