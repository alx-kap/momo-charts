from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from momo_scan.models import Bar


class FixtureProvider:
    name = "fixture"

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.source = str(self.path)
        self.payload = json.loads(self.path.read_text())

    async def __aenter__(self) -> FixtureProvider:
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    async def doctor(self) -> dict[str, Any]:
        return {
            "connected": True,
            "mode": "fixture",
            "source": self.source,
            "symbols": len(self.payload["bars"]),
        }

    async def resolve_session(self, requested: date | None = None) -> date:
        if requested is not None:
            return requested
        timestamps = [item["t"] for bars in self.payload["bars"].values() for item in bars]
        return datetime.fromtimestamp(max(timestamps), tz=UTC).date()

    async def get_sessions(self, start: date, end: date) -> list[date]:
        raw_bars = self.payload.get("bars", {})
        benchmark = raw_bars.get("AMEX:SPY") or raw_bars.get("NASDAQ:QQQ")
        source = benchmark or [item for values in raw_bars.values() for item in values]
        return sorted(
            {
                session
                for item in source
                if start <= (session := datetime.fromtimestamp(item["t"], tz=UTC).date()) <= end
            }
        )


    async def get_ohlcv(
        self, symbol: str, count: int = 300, as_of: date | None = None
    ) -> list[Bar]:
        bars = [Bar.model_validate(item) for item in self.payload["bars"][symbol]]
        if as_of is not None:
            bars = [
                bar
                for bar in bars
                if datetime.fromtimestamp(bar.t, tz=UTC).date() <= as_of
            ]
        return bars[-count:]

    async def get_symbol_data_batch(
        self, symbols: list[str]
    ) -> dict[str, dict[str, Any]]:
        output: dict[str, dict[str, Any]] = {}
        metadata = self.payload.get("metadata", {})
        for symbol in symbols:
            if symbol not in self.payload.get("bars", {}) and symbol not in metadata:
                continue
            output[symbol] = {"is_common_stock": True, **metadata.get(symbol, {})}
        return output

