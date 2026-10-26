"""The normalized quote and the interface every live provider implements."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import date, datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo

MARKET_TZ = ZoneInfo("America/New_York")


def market_day(at: datetime | None = None) -> date:
    """The trading day a moment belongs to, by the exchange's clock."""
    return (at or datetime.now(MARKET_TZ)).astimezone(MARKET_TZ).date()


@dataclass(frozen=True, slots=True)
class Quote:
    """One symbol's state for the day. The day's open/high/low/volume make the forming daily
    bar; `prev_close` is the base for the change. Optional fields are None when a vendor lacks
    them."""

    symbol: str  # plain ticker, no exchange prefix
    last: float
    day: date  # trading day the quote belongs to
    time: float  # epoch seconds of the last trade or update
    open: float | None = None
    high: float | None = None
    low: float | None = None
    volume: float | None = None  # shares traded so far today
    prev_close: float | None = None
    bid: float | None = None
    ask: float | None = None
    trade: float | None = None  # last trade in any session; intraday charts with pre/post use it
    # Today's volume before the open, while `day` is still the last regular session (whose
    # volume then stays None, so the forming pre-market doesn't land on yesterday's bar).
    pre_volume: float | None = None

    def payload(self) -> dict[str, Any]:
        return asdict(self) | {"day": self.day.isoformat()}


Emit = Callable[[Quote], None]


class SignInNeeded(Exception):
    """The feed needs the owner to sign in to the vendor again (Schwab: every 7 days)."""


class LiveProvider(Protocol):
    """A vendor feed. `run` connects and streams until the connection ends (return or raise;
    the hub reconnects with backoff). It calls `ready()` once connected and `emit` for every
    update. `subscribe` replaces the symbol set, and may be called before or during `run`; a
    provider re-subscribes the current set itself after reconnecting."""

    name: str
    simulated: bool

    async def run(self, emit: Emit, ready: Callable[[], None]) -> None: ...

    async def subscribe(self, symbols: frozenset[str]) -> None: ...
