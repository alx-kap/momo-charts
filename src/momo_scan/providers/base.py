from __future__ import annotations

from datetime import date
from typing import Any, Protocol

from momo_scan.models import Bar


class MarketDataProvider(Protocol):
    name: str
    source: str

    async def __aenter__(self) -> MarketDataProvider: ...

    async def __aexit__(self, *_: Any) -> None: ...

    async def doctor(self) -> dict[str, Any]: ...

    async def resolve_session(self, requested: date | None = None) -> date: ...

    async def get_sessions(self, start: date, end: date) -> list[date]: ...


    async def get_ohlcv(
        self, symbol: str, count: int = 300, as_of: date | None = None
    ) -> list[Bar]: ...

    async def get_symbol_data_batch(
        self, symbols: list[str]
    ) -> dict[str, dict[str, Any]]: ...

