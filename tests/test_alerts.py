from __future__ import annotations

import asyncio
from datetime import date, datetime
from pathlib import Path

from fastapi.testclient import TestClient
from test_live import FakeProvider, _emit, _tailnet

from momo_scan.alerts import Alerts, AlertWatcher, crossed, regular_session
from momo_scan.config import AppConfig
from momo_scan.live import LiveHub, Quote
from momo_scan.live.base import MARKET_TZ
from momo_scan.providers.fixture import FixtureProvider
from momo_scan.storage import Storage
from momo_scan.web.server import create_app

OPEN = datetime(2026, 10, 19, 10, 0, tzinfo=MARKET_TZ).timestamp()  # a Monday, 10:00 ET
EVENING = datetime(2026, 10, 19, 18, 0, tzinfo=MARKET_TZ).timestamp()


def quote(symbol: str, last: float, at: float = OPEN, trade: float | None = None) -> Quote:
    return Quote(symbol=symbol, last=last, day=date(2026, 10, 19), time=at, trade=trade)


def test_crossing_rules() -> None:
    assert crossed(99, 100, 100, "up") and crossed(99, 101, 100, "cross")
    assert not crossed(100, 101, 100, "up")  # starting on the level isn't a cross
    assert crossed(101, 100, 100, "down") and not crossed(101, 100, 100, "up")
    assert regular_session(OPEN) and not regular_session(EVENING)


async def test_watcher_fires_once_on_a_cross_and_tells_the_account(tmp_path: Path) -> None:
    storage = Storage(str(tmp_path / "momo.db"))
    alerts = Alerts(storage)
    feed = FakeProvider()
    hub = LiveHub(feed)
    watcher = AlertWatcher(alerts, hub)
    hub.start()
    await asyncio.sleep(0)
    once = alerts.add("owner", symbol="NASDAQ:NVDA", price=100.0, direction="up")
    every = alerts.add("owner", symbol="NVDA", price=95.0, direction="down", repeat=True)
    late = alerts.add("kim", symbol="AMD", price=50.0, extended=True)
    await watcher.reload()
    assert feed.subscribed[-1] == {"NVDA", "AMD"}  # streamed with no tab open
    mine, theirs = hub.attach("owner"), hub.attach("kim")

    feed.emit(quote("NVDA", 99.0))  # the first price only sets where it starts
    feed.emit(quote("NVDA", 100.5))
    feed.emit(quote("NVDA", 99.0))
    feed.emit(quote("NVDA", 100.5))  # crossed up again: already fired
    fired = hub.drain(mine)["alerts"]
    assert [a["id"] for a in fired] == [once["id"]] and fired[0]["fired_price"] == 100.5
    assert "alerts" not in hub.drain(theirs)
    await asyncio.sleep(0)  # the reload after a one-off alert
    assert {a["id"]: a["status"] for a in alerts.list("owner")}[once["id"]] == "triggered"

    feed.emit(quote("NVDA", 94.0))
    feed.emit(quote("NVDA", 96.0))
    feed.emit(quote("NVDA", 94.0))  # repeats, but not within ten minutes
    assert [a["id"] for a in hub.drain(mine)["alerts"]] == [every["id"]]
    assert alerts.get("owner", every["id"])["status"] == "active"

    # After hours only alerts with `extended` count, on the last trade.
    feed.emit(quote("AMD", 49.0, EVENING, trade=49.0))
    feed.emit(quote("AMD", 49.0, EVENING, trade=51.0))
    assert [a["id"] for a in hub.drain(theirs)["alerts"]] == [late["id"]]
    assert not alerts.get("kim", late["id"])["seen"]
    await hub.stop()
    storage.close()


def test_alerts_api(fixture_path: Path, tmp_path: Path) -> None:
    config = AppConfig()
    config.storage.database = str(tmp_path / "data" / "momo.db")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "access.toml").write_text('[accounts.sam]\nlogin = "sam@example.com"\n')
    feed = FakeProvider()
    app = create_app(
        config, Path("config/momo.toml"),
        provider_factory=lambda: FixtureProvider(fixture_path), live_provider=feed,
    )
    headers = {"X-Momo": "1"}
    with TestClient(app) as client:
        made = client.post(
            "/api/alerts", json={"symbol": "NASDAQ:MOMO", "price": 42}, headers=headers
        ).json()
        assert made["status"] == "active" and made["direction"] == "cross"
        while not feed.subscribed or "MOMO" not in feed.subscribed[-1]:
            client.portal.call(asyncio.sleep, 0.01)
        with client.websocket_connect("/api/live") as socket:
            socket.receive_json()  # status
            client.portal.call(lambda: _emit(feed, quote("MOMO", 41.0)))
            client.portal.call(lambda: _emit(feed, quote("MOMO", 42.5)))
            message = socket.receive_json()
            while "alerts" not in message:
                message = socket.receive_json()
            assert message["alerts"][0]["id"] == made["id"]
        listed = client.get("/api/alerts").json()["alerts"]
        assert listed[0]["status"] == "triggered" and not listed[0]["seen"]
        client.post("/api/alerts/seen", json={"ids": [made["id"]]}, headers=headers)
        armed = client.put(
            f"/api/alerts/{made['id']}", json={"status": "active", "price": 45}, headers=headers
        ).json()
        assert armed["fired_at"] is None and armed["price"] == 45 and armed["seen"]
        assert client.post(
            "/api/alerts", json={"symbol": "MOMO", "price": -1}, headers=headers
        ).status_code == 422
        # Alerts come with live prices.
        sam = {**headers, **_tailnet("sam@example.com")}
        assert client.post(
            "/api/alerts", json={"symbol": "MOMO", "price": 1}, headers=sam
        ).status_code == 403
        assert client.delete(f"/api/alerts/{made['id']}", headers=headers).json()["saved"]
        assert client.get("/api/alerts").json()["alerts"] == []
