"""A simulated feed for building and checking the live pipeline without a vendor: outside
market hours, before a key is approved, and in tests. Each symbol random-walks from its last
archived close. The UI labels it SIM so it is never mistaken for real prices."""

from __future__ import annotations

import asyncio
import math
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace

from momo_scan.live.base import Emit, Quote, market_day

TICK_SECONDS = 0.25
STEP_SIGMA = 0.0012  # per tick: about a 2-3% daily range over a few minutes of ticks


class SimulatedProvider:
    name = "sim"
    simulated = True

    def __init__(
        self,
        last_close: Callable[[str], Awaitable[float | None]],
        *,
        tick: float = TICK_SECONDS,
        rng: random.Random | None = None,
    ) -> None:
        self.last_close = last_close
        self.tick = tick
        self.rng = rng or random.Random()
        self.symbols: frozenset[str] = frozenset()
        self.days: dict[str, Quote] = {}
        self.missing: set[str] = set()  # no archived close to start from

    async def subscribe(self, symbols: frozenset[str]) -> None:
        self.symbols = symbols

    async def run(self, emit: Emit, ready: Callable[[], None]) -> None:
        ready()
        while True:
            for symbol in list(self.symbols):
                quote = await self._step(symbol)
                if quote is not None:
                    emit(quote)
            await asyncio.sleep(self.tick)

    async def sweep(self, symbols: list[str]) -> list[Quote]:
        """A quote for every symbol, like the vendor's market-wide request. A symbol first seen
        here starts with a plausible day's volume so the screener has something to filter."""
        found = []
        for symbol in symbols:
            known = symbol in self.days
            quote = await self._step(symbol) or self.days.get(symbol)
            if quote is None:
                continue
            if not known:
                quote = replace(quote, volume=float(self.rng.randint(20, 2000) * 1000))
                self.days[symbol] = quote
            found.append(quote)
        return found

    async def _step(self, symbol: str) -> Quote | None:
        previous = self.days.get(symbol)
        if previous is None:
            if symbol in self.missing:
                return None
            close = await self.last_close(symbol)
            if not close:
                self.missing.add(symbol)
                return None
            start = round(close * math.exp(self.rng.gauss(0, 0.01)), 2)
            quote = Quote(
                symbol=symbol, last=start, day=market_day(), time=time.time(),
                open=start, high=start, low=start, volume=0.0, prev_close=close,
            )
        elif self.rng.random() < 0.4:  # not every symbol trades every tick
            return None
        else:
            last = round(previous.last * math.exp(self.rng.gauss(0, STEP_SIGMA)), 2)
            quote = Quote(
                symbol=symbol, last=last, day=previous.day, time=time.time(),
                open=previous.open, high=max(previous.high or last, last),
                low=min(previous.low or last, last),
                volume=(previous.volume or 0) + self.rng.randint(1, 50) * 100,
                prev_close=previous.prev_close,
                bid=round(last - 0.01, 2), ask=round(last + 0.01, 2), trade=last,
            )
        self.days[symbol] = quote
        return quote
