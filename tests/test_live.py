from __future__ import annotations

import asyncio
import random
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from momo_scan.config import AppConfig
from momo_scan.live import LiveHub, Quote, load_live_settings
from momo_scan.live.sim import SimulatedProvider
from momo_scan.providers.fixture import FixtureProvider
from momo_scan.web.server import create_app


class FakeProvider:
    """A feed the test drives by hand."""

    name = "fake"
    simulated = False

    def __init__(self) -> None:
        self.subscribed: list[frozenset[str]] = []
        self.emit = None

    async def subscribe(self, symbols: frozenset[str]) -> None:
        self.subscribed.append(symbols)

    async def run(self, emit, ready) -> None:  # type: ignore[no-untyped-def]
        self.emit = emit
        ready()
        await asyncio.Event().wait()


def quote(symbol: str, last: float) -> Quote:
    return Quote(symbol=symbol, last=last, day=date(2026, 10, 12), time=0.0, prev_close=100.0)


async def test_hub_subscribes_the_union_and_coalesces_ticks() -> None:
    feed = FakeProvider()
    hub = LiveHub(feed)
    hub.start()
    await asyncio.sleep(0)
    a, b = hub.attach(), hub.attach()
    await hub.watch(a, ["NASDAQ:nvda", "AMD"])
    await hub.watch(b, ["NVDA", "TSLA"])
    assert feed.subscribed[-1] == {"NVDA", "AMD", "TSLA"}
    assert hub.drain(a)["status"]["state"] == "live"

    for price in (101.0, 102.0, 103.0):  # three ticks between flushes: one message
        feed.emit(quote("NVDA", price))
    feed.emit(quote("MSFT", 50.0))  # nobody watches it
    message = hub.drain(a)
    assert set(message["quotes"]) == {"NVDA"} and message["quotes"]["NVDA"]["last"] == 103.0
    assert hub.drain(a) == {} and "MSFT" not in hub.quotes

    # A new watcher gets the cached quote at once, without waiting for a tick.
    c = hub.attach()
    await hub.watch(c, ["NVDA"])
    assert hub.drain(c)["quotes"]["NVDA"]["last"] == 103.0

    await hub.detach(b)
    await hub.detach(c)
    assert feed.subscribed[-1] == {"NVDA", "AMD"}
    await hub.stop()


async def test_hub_drops_quotes_when_the_feed_goes_down() -> None:
    feed = FakeProvider()
    hub = LiveHub(feed)
    hub.start()
    await asyncio.sleep(0)
    client = hub.attach()
    await hub.watch(client, ["NVDA"])
    feed.emit(quote("NVDA", 101.0))
    hub._set_state("down")
    assert hub.quotes == {}
    assert hub.drain(client)["status"]["state"] == "down"
    await hub.stop()


async def test_simulated_feed_walks_from_the_archived_close() -> None:
    async def last_close(symbol: str) -> float | None:
        return {"NVDA": 100.0}.get(symbol)

    feed = SimulatedProvider(last_close, tick=0, rng=random.Random(1))
    await feed.subscribe(frozenset({"NVDA", "NOPE"}))
    quotes: list[Quote] = []
    task = asyncio.create_task(feed.run(quotes.append, lambda: None))
    while len(quotes) < 20:
        await asyncio.sleep(0)
    task.cancel()
    assert {item.symbol for item in quotes} == {"NVDA"}
    last = quotes[-1]
    assert last.prev_close == 100.0 and 90 < last.last < 110
    assert last.low <= min(item.last for item in quotes) and last.high >= last.last


def test_live_settings_default_to_off_and_reject_unknown_feeds(tmp_path: Path) -> None:
    path = tmp_path / "live.toml"
    assert load_live_settings(path)["provider"] == "none"
    path.write_text('provider = "SIM"\n')
    assert load_live_settings(path)["provider"] == "sim"
    path.write_text('provider = "bloomberg"\n')
    with pytest.raises(ValueError):
        load_live_settings(path)


def _tailnet(login: str) -> dict[str, str]:
    return {"Tailscale-Headers-Info": "x", "X-Forwarded-For": "100.64.0.9",
            "Tailscale-User-Login": login}


def test_live_socket_streams_quotes_to_allowed_accounts(
    fixture_path: Path, tmp_path: Path
) -> None:
    config = AppConfig()
    config.storage.database = str(tmp_path / "data" / "momo.db")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "access.toml").write_text(
        '[accounts.sam]\nlogin = "sam@example.com"\n\n'
        '[accounts.kim]\nlogin = "kim@example.com"\nlive = true\n'
    )
    feed = FakeProvider()
    app = create_app(
        config, Path("config/momo.toml"),
        provider_factory=lambda: FixtureProvider(fixture_path), live_provider=feed,
    )
    with TestClient(app) as client:
        assert client.get("/api/me").json()["live"] is True
        with client.websocket_connect("/api/live") as socket:
            assert socket.receive_json()["status"] == {
                "provider": "fake", "simulated": False, "state": "live", "mode": None,
                "error": None, "sign_in": False, "sign_in_by": None,
            }
            socket.send_json({"op": "watch", "symbols": ["NASDAQ:MOMO"]})
            while not feed.subscribed or "MOMO" not in feed.subscribed[-1]:
                client.portal.call(asyncio.sleep, 0.01)
            client.portal.call(lambda: _emit(feed, quote("MOMO", 42.5)))
            assert socket.receive_json()["quotes"]["MOMO"]["last"] == 42.5

        # Members need `live = true`; other sites' pages are refused.
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/live", headers=_tailnet("sam@example.com")) as s:
                s.receive_json()
        with client.websocket_connect("/api/live", headers=_tailnet("kim@example.com")) as s:
            assert "status" in s.receive_json()
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/api/live", headers={"Origin": "https://evil.example"}
            ) as s:
                s.receive_json()


async def _emit(feed: FakeProvider, item: Quote) -> None:
    feed.emit(item)


async def test_hub_routes_minute_bars_and_tracks_streaming() -> None:
    feed = FakeProvider()
    feed.bar_sink = None  # type: ignore[attr-defined]
    bar_subs: list[frozenset[str]] = []

    async def subscribe_bars(symbols: frozenset[str]) -> None:
        bar_subs.append(symbols)

    feed.subscribe_bars = subscribe_bars  # type: ignore[attr-defined]
    hub = LiveHub(feed)
    saved: list[tuple[str, tuple]] = []
    hub.on_bar = lambda symbol, row: saved.append((symbol, row))
    hub.start()
    await asyncio.sleep(0)
    chart = hub.attach()
    await hub.watch_bars(chart, ["NASDAQ:NVDA"])
    assert bar_subs[-1] == {"NVDA"} and "NVDA" in hub.bars_since
    row = (1_791_817_800, 1.0, 2.0, 0.5, 1.5, 100.0)
    feed.bar_sink("NVDA", row)  # type: ignore[attr-defined]
    feed.bar_sink("AMD", row)  # type: ignore[attr-defined]  # nobody's chart
    assert saved == [("NVDA", row)]
    assert hub.drain(chart)["bars"] == {"NVDA": [row]}
    await hub.watch_bars(chart, [])
    assert bar_subs[-1] == frozenset() and "NVDA" not in hub.bars_since
    await hub.stop()
