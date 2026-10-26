from __future__ import annotations

import math
import statistics
from collections.abc import Iterable

from momo_scan.models import Bar


def normalized_bars(bars: Iterable[Bar]) -> list[Bar]:
    """Sort bars and keep the latest value for duplicate timestamps."""
    by_timestamp = {bar.t: bar for bar in bars}
    return [by_timestamp[key] for key in sorted(by_timestamp)]


def mean(values: Iterable[float]) -> float:
    data = list(values)
    return statistics.fmean(data) if data else 0.0


def adr_percent(bars: list[Bar], period: int = 20) -> float:
    data = normalized_bars(bars)
    if len(data) < period:
        raise ValueError(f"ADR{period} requires {period} completed bars")
    ratios = [bar.h / bar.l for bar in data[-period:] if bar.l > 0]
    if len(ratios) != period:
        raise ValueError("ADR cannot be calculated with non-positive lows")
    return 100.0 * (mean(ratios) - 1.0)


def average_dollar_volume(bars: list[Bar], period: int = 20) -> float:
    data = normalized_bars(bars)
    if len(data) < period:
        raise ValueError(f"ADV{period} requires {period} completed bars")
    return mean(bar.c * bar.v for bar in data[-period:])


def return_percent(bars: list[Bar], sessions: int) -> float:
    data = normalized_bars(bars)
    if len(data) <= sessions:
        raise ValueError(f"{sessions}-session return requires {sessions + 1} bars")
    prior = data[-sessions - 1].c
    if prior <= 0:
        raise ValueError("return cannot be calculated with a non-positive prior close")
    return 100.0 * (data[-1].c - prior) / prior


def simple_moving_average(bars: list[Bar], period: int, offset: int = 0) -> float:
    data = normalized_bars(bars)
    end = len(data) - offset
    start = end - period
    if start < 0 or end <= 0:
        raise ValueError(f"SMA{period} requires at least {period + offset} bars")
    return mean(bar.c for bar in data[start:end])


def percentile_rank(value: float, population: Iterable[float]) -> float:
    """Inclusive percentile with midpoint treatment for ties."""
    values = [item for item in population if math.isfinite(item)]
    if not values:
        return 0.0
    below = sum(item < value for item in values)
    equal = sum(item == value for item in values)
    return 100.0 * (below + 0.5 * equal) / len(values)


def linear_slope(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    x_mean = (len(values) - 1) / 2.0
    y_mean = mean(values)
    denominator = sum((index - x_mean) ** 2 for index in range(len(values)))
    if denominator == 0:
        return 0.0
    return (
        sum((index - x_mean) * (value - y_mean) for index, value in enumerate(values)) / denominator
    )


def clip(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))
