from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest


def make_bars(
    *,
    start_price: float = 20.0,
    impulse_multiple: float = 2.2,
    base_days: int = 10,
    total_days: int = 180,
) -> list[dict[str, float | int]]:
    start = datetime(2026, 1, 2, tzinfo=UTC)
    flat_days = total_days - 30 - base_days
    closes: list[float] = []
    for index in range(flat_days):
        closes.append(start_price * (1.0 + 0.0005 * index))
    impulse_start = closes[-1]
    for index in range(30):
        fraction = (index + 1) / 30.0
        closes.append(impulse_start * (1.0 + (impulse_multiple - 1.0) * fraction))
    peak = closes[-1]
    for index in range(base_days):
        # Controlled pullback followed by higher lows/tightness.
        close = peak * (0.91 + 0.025 * index / max(1, base_days - 1))
        closes.append(close)

    bars: list[dict[str, float | int]] = []
    for index, close in enumerate(closes):
        if index < flat_days:
            volume = 3_200_000
        elif index < flat_days + 30:
            volume = 6_000_000 + index * 15_000
        else:
            volume = 1_600_000 - (index - flat_days - 30) * 30_000
        bars.append(
            {
                "t": int((start + timedelta(days=index)).timestamp()),
                "o": close * 0.985,
                "h": close * 1.035,
                "l": close * 0.965,
                "c": close,
                "v": max(volume, 500_000),
            }
        )
    return bars


@pytest.fixture
def bars_factory() -> Any:
    """Expose the bar builder so tests can synthesize their own symbols."""
    return make_bars


def build_symbol_bars(
    bars_factory: Any,
    *,
    start_price: float,
    impulse_multiple: float,
    volume: float,
    high_multiple: float = 1.035,
    low_multiple: float = 0.965,
) -> list[dict[str, float | int]]:
    """Bars with a fixed volume and a controlled high/low spread (ADR)."""
    bars = bars_factory(start_price=start_price, impulse_multiple=impulse_multiple, base_days=10)
    for bar in bars:
        bar["v"] = volume
        bar["h"] = bar["c"] * high_multiple
        bar["l"] = bar["c"] * low_multiple
    return bars


@pytest.fixture
def universe_fixture_path(tmp_path: Path, bars_factory: Any) -> Path:
    """Five momentum seeds: three pass the liquidity and volatility floors, two do not."""
    payload = {
        "seeds": [
            {"symbol": "NASDAQ:SEMI", "ranks": {"21": 95.0, "63": 96.0, "126": 97.0}, "raw": {}},
            {"symbol": "NYSE:OILX", "ranks": {"21": 92.0, "126": 91.0}, "raw": {}},
            {"symbol": "NASDAQ:MOMO", "ranks": {"21": 90.5}, "raw": {}},
            {"symbol": "NASDAQ:THIN", "ranks": {"21": 93.0}, "raw": {}},
            {"symbol": "NASDAQ:CALM", "ranks": {"63": 94.0}, "raw": {}},
        ],
        "bars": {
            "NASDAQ:SEMI": build_symbol_bars(
                bars_factory, start_price=40.0, impulse_multiple=2.0, volume=3_000_000
            ),
            "NYSE:OILX": build_symbol_bars(
                bars_factory, start_price=30.0, impulse_multiple=1.9, volume=3_000_000
            ),
            "NASDAQ:MOMO": build_symbol_bars(
                bars_factory, start_price=24.0, impulse_multiple=2.2, volume=3_000_000
            ),
            "NASDAQ:THIN": build_symbol_bars(
                bars_factory, start_price=20.0, impulse_multiple=2.0, volume=50_000
            ),
            "NASDAQ:CALM": build_symbol_bars(
                bars_factory,
                start_price=35.0,
                impulse_multiple=2.0,
                volume=3_000_000,
                high_multiple=1.005,
                low_multiple=0.998,
            ),
        },
        "metadata": {
            "NASDAQ:SEMI": {
                "description": "Semi Systems",
                "exchange": "NASDAQ",
                "sector": "Technology",
                "industry": "Semiconductors",
            },
            "NYSE:OILX": {
                "description": "Oil Explorers",
                "exchange": "NYSE",
                "sector": "Energy",
                "industry": "Oil & Gas Refining & Marketing",
            },
            "NASDAQ:MOMO": {
                "description": "Momo Biotech",
                "exchange": "NASDAQ",
                "sector": "Healthcare",
                "industry": "Biotechnology",
            },
            "NASDAQ:THIN": {
                "description": "Thinly Traded",
                "exchange": "NASDAQ",
                "sector": "Technology",
                "industry": "Semiconductors",
            },
            "NASDAQ:CALM": {
                "description": "Calm Range",
                "exchange": "NASDAQ",
                "sector": "Healthcare",
                "industry": "Biotechnology",
            },
        },
    }
    path = tmp_path / "universe.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


@pytest.fixture
def fixture_path(tmp_path: Path) -> Path:
    candidate = make_bars()
    supplemental = make_bars(start_price=30.0, impulse_multiple=1.8, total_days=66)
    timestamp_shift = int(candidate[-1]["t"]) - int(supplemental[-1]["t"])
    for bar in supplemental:
        bar["t"] = int(bar["t"]) + timestamp_shift
    benchmark = make_bars(start_price=100.0, impulse_multiple=1.25, base_days=10)
    payload = {
        "seeds": [
            {
                "symbol": "NASDAQ:MOMO",
                "ranks": {"21": 96.0, "63": 98.0, "126": 99.0},
                "raw": {"exchange": "NASDAQ", "type": "stock"},
            }
        ],
        "bars": {
            "NASDAQ:MOMO": candidate,
            "NASDAQ:EXTRA": supplemental,
            "AMEX:SPY": benchmark,
            "NASDAQ:QQQ": benchmark,
        },
        "metadata": {
            "NASDAQ:MOMO": {
                "description": "Momo Systems",
                "exchange": "NASDAQ",
                "sector": "Technology",
                "industry": "Semiconductors",
            },
            "NASDAQ:EXTRA": {
                "description": "Supplemental Systems",
                "exchange": "NASDAQ",
                "sector": "Technology",
                "industry": "Semiconductors",
            },
        },
    }
    path = tmp_path / "market.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path
