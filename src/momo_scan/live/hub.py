"""The hub: one upstream connection, many browser sockets.

Each socket is a `LiveClient` with its own symbol set. The provider is subscribed to the union.
Updates only mark a client's symbols dirty; the socket's sender drains them at its own pace, so
a busy symbol costs one message per flush however many ticks arrived.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

from momo_scan.live.base import LiveProvider, Quote, SignInNeeded

log = logging.getLogger(__name__)

MAX_SYMBOLS = 300  # per socket: a long watchlist plus the chart
MAX_BAR_SYMBOLS = 10  # per socket: the intraday chart and the ones hovered or next in line
MAX_BUZZ_SYMBOLS = 300  # per socket: lists showing Volume Buzz (their minute bars are stored)
RETRY_SECONDS = (1, 2, 5, 15, 30, 60)
SIGN_IN_RETRY_SECONDS = 300  # until the owner signs in again (a sign-in restarts the hub)


def clean_symbol(text: str) -> str:
    """'NASDAQ:nvda' -> 'NVDA'."""
    return str(text).split(":")[-1].strip().upper()


Row = tuple[int, float, float, float, float, float]


class LiveClient:
    def __init__(self, user: str | None = None) -> None:
        self.user = user  # the account the tab belongs to: its price alerts come here
        self.alerts: list[dict[str, Any]] = []  # fired since the last drain
        self.symbols: frozenset[str] = frozenset()
        self.bar_symbols: frozenset[str] = frozenset()  # intraday charts: finished minute bars
        self.bars: dict[str, list[Row]] = {}
        self.buzz_symbols: frozenset[str] = frozenset()  # lists with a Volume Buzz column
        self.dirty: set[str] = set()
        self.buzz_dirty: set[str] = set()
        self.status_dirty = True
        self.wake = asyncio.Event()
        self.wake.set()  # the first drain sends the status


class LiveHub:
    def __init__(self, provider: LiveProvider | None) -> None:
        self.provider = provider
        self.quotes: dict[str, Quote] = {}
        self.clients: set[LiveClient] = set()
        self.state = "off" if provider is None else "connecting"
        self.error: str | None = None
        self.needs_sign_in = False
        self.wanted: frozenset[str] = frozenset()
        self.wanted_bars: frozenset[str] = frozenset()
        self.wanted_buzz: frozenset[str] = frozenset()
        self.buzz: dict[str, dict[str, Any]] = {}  # symbol -> Volume Buzz (momo.buzz)
        # When the stream started sending a symbol's minute bars without a break: from then
        # on the intraday store has every minute, so its chart needs no history request.
        self.bars_since: dict[str, float] = {}
        self.on_bar: Callable[[str, Row], None] | None = None  # e.g. save to the store
        # Price alerts (momo.alerts): their symbols stream with no tab open, every quote is checked.
        self.alert_symbols: frozenset[str] = frozenset()
        self.on_quote: Callable[[Quote], None] | None = None
        self._task: asyncio.Task[None] | None = None
        if provider is not None and hasattr(provider, "bar_sink"):
            provider.bar_sink = self._emit_bar

    @property
    def status(self) -> dict[str, Any]:
        return {
            "provider": self.provider.name if self.provider else None,
            "simulated": bool(self.provider and self.provider.simulated),
            "state": self.state,
            "mode": getattr(self.provider, "mode", None),  # e.g. Schwab "stream" or "poll"
            "error": self.error,
            "sign_in": self.needs_sign_in,
            "sign_in_by": self.provider.sign_in_by()
            if hasattr(self.provider, "sign_in_by") else None,
        }

    def start(self) -> None:
        if self.provider is not None and self._task is None:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def restart(self) -> None:
        """Reconnect now, e.g. right after a sign-in."""
        await self.stop()
        self.start()

    async def use(self, provider: LiveProvider | None) -> None:
        """Switch to another feed (keys saved in the app), keeping what everyone watches."""
        await self.stop()
        self.provider = provider
        self.quotes.clear()
        self.bars_since.clear()
        self.error = None
        self.needs_sign_in = False
        self.state = "off" if provider is None else "connecting"
        if provider is not None and hasattr(provider, "bar_sink"):
            provider.bar_sink = self._emit_bar
        if provider is not None:
            await provider.subscribe(self.wanted)
            if hasattr(provider, "subscribe_bars"):
                await provider.subscribe_bars(self.streamed_bars)
        for client in self.clients:
            client.status_dirty = True
            client.wake.set()
        self.start()

    async def _run(self) -> None:
        assert self.provider is not None
        attempt = 0
        while True:
            self._set_state("connecting")

            def ready() -> None:
                nonlocal attempt
                attempt = 0
                self.error = None
                self.needs_sign_in = False
                self._set_state("live")
                now = time.time()
                self.bars_since = {symbol: now for symbol in self.streamed_bars}

            try:
                await self.provider.run(self._emit, ready)
                self.error = "Feed closed"
            except asyncio.CancelledError:
                raise
            except SignInNeeded as error:
                self.error = str(error)
                self.needs_sign_in = True
                self._set_state("down", force=True)
                await asyncio.sleep(SIGN_IN_RETRY_SECONDS)
                continue
            except Exception as error:  # surfaced to the UI; the hub keeps retrying
                log.warning("Live feed %s failed: %s", self.provider.name, error)
                self.error = f"{type(error).__name__}: {error}"
            self._set_state("down")
            await asyncio.sleep(RETRY_SECONDS[min(attempt, len(RETRY_SECONDS) - 1)])
            attempt += 1

    def _set_state(self, state: str, force: bool = False) -> None:
        if state == self.state and not force:
            return
        self.state = state
        if state != "live":
            # A quote that stops updating must not pass for a live price.
            self.quotes.clear()
            self.bars_since.clear()
        for client in self.clients:
            client.status_dirty = True
            client.wake.set()

    def _emit(self, quote: Quote) -> None:
        if quote.symbol not in self.wanted:
            return
        self.quotes[quote.symbol] = quote
        if self.on_quote is not None:
            try:
                self.on_quote(quote)
            except Exception:  # a broken check must never stop the feed
                log.exception("Alert check failed for %s", quote.symbol)
        for client in self.clients:
            if quote.symbol in client.symbols:
                client.dirty.add(quote.symbol)
                client.wake.set()

    def notify(self, user: str, alert: dict[str, Any]) -> None:
        """A price alert fired: every open tab of its account hears on the next drain."""
        for client in self.clients:
            if client.user == user:
                client.alerts.append(alert)
                client.wake.set()

    @property
    def streamed_bars(self) -> frozenset[str]:
        """Symbols whose finished minute bars are stored: intraday charts and buzz lists."""
        return self.wanted_bars | self.wanted_buzz

    def set_buzz(self, symbol: str, value: dict[str, Any] | None) -> None:
        """A symbol's Volume Buzz changed; it goes out with the next drain."""
        if value is None:
            self.buzz.pop(symbol, None)
        else:
            self.buzz[symbol] = value
        for client in self.clients:
            if symbol in client.buzz_symbols:
                client.buzz_dirty.add(symbol)
                client.wake.set()

    def _emit_bar(self, symbol: str, row: Row) -> None:
        if symbol not in self.streamed_bars:
            return
        if self.on_bar is not None:
            self.on_bar(symbol, row)
        for client in self.clients:
            if symbol in client.bar_symbols:
                client.bars.setdefault(symbol, []).append(row)
                client.wake.set()

    def attach(self, user: str | None = None) -> LiveClient:
        client = LiveClient(user)
        self.clients.add(client)
        return client

    async def detach(self, client: LiveClient) -> None:
        self.clients.discard(client)
        await self._resubscribe()

    async def watch(self, client: LiveClient, symbols: list[Any]) -> None:
        """Replace a client's symbols; cached quotes for them go out on the next drain."""
        cleaned = [clean_symbol(item) for item in symbols if clean_symbol(item)]
        client.symbols = frozenset(cleaned[:MAX_SYMBOLS])
        client.dirty &= client.symbols
        client.dirty |= client.symbols & self.quotes.keys()
        if client.dirty:
            client.wake.set()
        await self._resubscribe()

    async def watch_bars(self, client: LiveClient, symbols: list[Any]) -> None:
        """Replace the symbols whose finished minute bars a client wants (intraday charts)."""
        cleaned = [clean_symbol(item) for item in symbols if clean_symbol(item)]
        client.bar_symbols = frozenset(cleaned[:MAX_BAR_SYMBOLS])
        client.bars = {key: rows for key, rows in client.bars.items() if key in client.bar_symbols}
        await self._resubscribe()

    async def watch_buzz(self, client: LiveClient, symbols: list[Any]) -> None:
        """Replace the symbols a client shows Volume Buzz for; known values go out at once."""
        cleaned = [clean_symbol(item) for item in symbols if clean_symbol(item)]
        client.buzz_symbols = frozenset(cleaned[:MAX_BUZZ_SYMBOLS])
        client.buzz_dirty = set(client.buzz_symbols & self.buzz.keys())
        if client.buzz_dirty:
            client.wake.set()
        await self._resubscribe()

    async def watch_alerts(self, symbols: frozenset[str]) -> None:
        """Replace the symbols price alerts watch."""
        self.alert_symbols = symbols
        await self._resubscribe()

    async def _resubscribe(self) -> None:
        before = self.streamed_bars
        self.wanted_bars = frozenset().union(*(client.bar_symbols for client in self.clients))
        self.wanted_buzz = frozenset().union(*(client.buzz_symbols for client in self.clients))
        streamed = self.streamed_bars
        if streamed != before:
            now = time.time()
            if self.state == "live":
                for symbol in streamed - before:
                    self.bars_since[symbol] = now
            for symbol in before - streamed:
                self.bars_since.pop(symbol, None)
            if self.provider is not None and hasattr(self.provider, "subscribe_bars"):
                await self.provider.subscribe_bars(streamed)
        for symbol in self.buzz.keys() - self.wanted_buzz:
            del self.buzz[symbol]
        wanted = self.alert_symbols.union(*(client.symbols for client in self.clients))
        if wanted == self.wanted:
            return
        self.wanted = wanted
        for symbol in self.quotes.keys() - wanted:
            del self.quotes[symbol]
        if self.provider is not None:
            await self.provider.subscribe(wanted)

    def drain(self, client: LiveClient) -> dict[str, Any]:
        """What changed for this client since its last drain."""
        message: dict[str, Any] = {}
        if client.status_dirty:
            message["status"] = self.status
            client.status_dirty = False
        quotes = {
            symbol: self.quotes[symbol].payload()
            for symbol in client.dirty
            if symbol in self.quotes
        }
        if quotes:
            message["quotes"] = quotes
        if client.bars:
            message["bars"] = client.bars
            client.bars = {}
        buzz = {symbol: self.buzz[symbol] for symbol in client.buzz_dirty if symbol in self.buzz}
        if buzz:
            message["buzz"] = buzz
        if client.alerts:
            message["alerts"] = client.alerts
            client.alerts = []
        client.buzz_dirty.clear()
        client.dirty.clear()
        client.wake.clear()
        return message
