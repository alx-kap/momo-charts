"""The market sweep: today's quote for every liquid stock, for the intraday screener.

One /quotes request carries up to 500 symbols, so the whole market is a handful of requests. The
sweep runs only while the owner's screener asks for it (each screen with live on renews a short
lease), at the provider's background priority so charts never wait behind it, and clears its
quotes when the lease lapses. Watchlist and chart streaming are untouched. See
docs/live-data.md.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Any

from momo_scan.live.base import Quote

log = logging.getLogger(__name__)

SWEEP_SECONDS = 15.0  # pause between sweeps, so a slow round never overlaps the next
MIN_DVOL = 1.0  # $M traded a day (20-day average) below which a stock isn't swept
LEASE_SECONDS = 60.0  # the sweep stops this long after the last screen that wanted it
BATCH = 500


class MarketSweep:
    def __init__(
        self, provider: Any, seconds: float = SWEEP_SECONDS, min_dvol: float = MIN_DVOL
    ) -> None:
        self.provider = provider
        self.seconds = seconds
        self.min_dvol = min_dvol
        self.symbols: list[str] = []
        self.quotes: dict[str, Quote] = {}
        self.stamp: float | None = None  # when the last full sweep finished
        self.error: str | None = None
        self._lease = 0.0
        self._task: asyncio.Task[None] | None = None
        self._fresh = asyncio.Event()

    @property
    def requests(self) -> int:
        return math.ceil(len(self.symbols) / BATCH)

    @property
    def per_minute(self) -> float:
        """Requests a minute at the pace the sweep keeps (a sweep's own time not counted)."""
        return round(self.requests * 60 / self.seconds, 1)

    def want(self, symbols: list[str]) -> None:
        """Renew the lease for these symbols (plain tickers) and start sweeping if idle."""
        wanted = sorted(set(symbols))
        if wanted != self.symbols:
            self.symbols = wanted
            self.quotes = {k: v for k, v in self.quotes.items() if k in set(wanted)}
        self._lease = time.monotonic() + LEASE_SECONDS
        if self._task is None or self._task.done():
            self._fresh.clear()
            self._task = asyncio.create_task(self._run())

    async def first(self, timeout: float) -> None:
        """Wait for the first sweep after a start, up to `timeout` seconds."""
        if self.stamp is None:
            try:
                await asyncio.wait_for(self._fresh.wait(), timeout)
            except TimeoutError:
                pass

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        try:
            while time.monotonic() < self._lease:
                try:
                    found = await self.provider.sweep(list(self.symbols))
                    self.quotes.update({quote.symbol: quote for quote in found})
                    self.stamp = time.time()
                    self.error = None
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # surfaced in the screener; the next round retries
                    log.warning("Market sweep failed: %s", error)
                    self.error = f"{type(error).__name__}: {error}"
                self._fresh.set()
                await asyncio.sleep(self.seconds)
        finally:
            # Prices nobody is refreshing must not pass for live ones.
            self.quotes.clear()
            self.stamp = None
