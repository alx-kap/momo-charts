from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, date, datetime
from pathlib import Path

import httpx
import pytest

from momo_scan.live import LiveHub
from momo_scan.live.base import SignInNeeded
from momo_scan.live.schwab import SchwabAuth, SchwabProvider, market_open, parse_quote

SETTINGS = {"schwab": {"client_id": "id", "client_secret": "secret",
                       "callback_url": "https://127.0.0.1:8182"}}
# 2026-10-12 15:30 ET
TRADE_MS = int(datetime(2026, 10, 12, 19, 30, tzinfo=UTC).timestamp() * 1000)


def nvda(last: float = 190.5) -> dict:
    return {
        "symbol": "NVDA",
        "quote": {"lastPrice": last + 0.2, "openPrice": 185.0, "highPrice": 191.0,
                  "lowPrice": 184.0, "closePrice": 186.0, "totalVolume": 120_000_000,
                  "bidPrice": last - 0.01, "askPrice": last + 0.01, "tradeTime": TRADE_MS},
        "regular": {"regularMarketLastPrice": last, "regularMarketTradeTime": TRADE_MS},
    }


class FakeSchwab:
    """Schwab's token and quotes endpoints."""

    def __init__(self) -> None:
        self.forms: list[dict[str, str]] = []
        self.quote_calls = 0
        self.refresh_ok = True
        self.streamer_url: str | None = None  # None: the app may not stream (Market Data only)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth/token":
            assert request.headers["authorization"].startswith("Basic ")
            form = dict(httpx.QueryParams(request.content.decode()))
            self.forms.append(form)
            if form["grant_type"] == "refresh_token" and not self.refresh_ok:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json={
                "access_token": f"access-{len(self.forms)}", "refresh_token": "refresh-1",
                "expires_in": 1800,
            })
        if request.url.path == "/trader/v1/userPreference":
            if self.streamer_url is None:
                return httpx.Response(401, json={"errors": [{"detail": "Client not authorized"}]})
            return httpx.Response(200, json={"streamerInfo": [{
                "streamerSocketUrl": self.streamer_url, "schwabClientCustomerId": "cust",
                "schwabClientCorrelId": "corr", "schwabClientChannel": "N9",
                "schwabClientFunctionId": "APIAPP",
            }]})
        if request.url.path == "/marketdata/v1/quotes":
            self.quote_calls += 1
            assert request.headers["authorization"].startswith("Bearer access-")
            symbols = request.url.params["symbols"].split(",")
            return httpx.Response(200, json={s: nvda() for s in symbols if s == "NVDA"})
        return httpx.Response(404)


def client(fake: FakeSchwab) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(fake))


def test_parse_quote_follows_the_regular_session() -> None:
    quote = parse_quote("NVDA", nvda(), now=datetime(2026, 10, 12, 19, 31, tzinfo=UTC))
    assert quote is not None
    assert quote.last == 190.5  # regular market, not the extended-hours last
    assert quote.trade == 190.7  # ...which intraday charts with pre/post use
    assert quote.day == date(2026, 10, 12)
    assert (quote.open, quote.high, quote.low, quote.prev_close) == (185.0, 191.0, 184.0, 186.0)
    assert quote.volume == 120_000_000
    blank = nvda()
    blank["quote"]["openPrice"] = 0  # before the open: no bar values yet
    assert parse_quote("NVDA", blank).open is None
    assert parse_quote("NVDA", {"quote": {}}) is None


def test_before_the_open_todays_volume_is_pre_market() -> None:
    # 8:30 ET the next morning: the regular fields still describe Monday's session, while
    # Schwab's total volume is already Tuesday's pre-market.
    morning = datetime(2026, 10, 13, 12, 30, tzinfo=UTC)
    quote = parse_quote("NVDA", nvda(), now=morning)
    assert quote.day == date(2026, 10, 12) and quote.last == 190.5
    assert quote.volume is None and quote.pre_volume == 120_000_000
    assert quote.trade == 190.7  # the pre-market price
    # After the open, or on the same day, the volume is the day's again.
    same_day = parse_quote("NVDA", nvda(), now=datetime(2026, 10, 12, 12, 30, tzinfo=UTC))
    assert same_day.volume == 120_000_000 and same_day.pre_volume is None


def test_market_hours_cover_extended_sessions_on_weekdays() -> None:
    assert market_open(datetime(2026, 10, 12, 13, 0, tzinfo=UTC))  # 9:00 ET Monday
    assert not market_open(datetime(2026, 10, 13, 1, 0, tzinfo=UTC))  # 21:00 ET
    assert not market_open(datetime(2026, 10, 10, 15, 0, tzinfo=UTC))  # Saturday


async def test_sign_in_saves_private_tokens_and_refreshes_them(tmp_path: Path) -> None:
    fake = FakeSchwab()
    auth = SchwabAuth(SETTINGS, tmp_path / "tokens.json")
    assert "client_id=id" in auth.authorize_url()
    assert "redirect_uri=https%3A%2F%2F127.0.0.1%3A8182" in auth.authorize_url()
    async with client(fake) as http:
        with pytest.raises(SignInNeeded):
            await auth.access_token(http)
        await auth.sign_in("https://127.0.0.1:8182/?code=C0DE%40abc&session=xyz", http)
        assert fake.forms[0] == {"grant_type": "authorization_code", "code": "C0DE@abc",
                                 "redirect_uri": "https://127.0.0.1:8182"}
        assert (tmp_path / "tokens.json").stat().st_mode & 0o777 == 0o600
        assert auth.sign_in_by() > time.time() + 6 * 24 * 3600
        assert await auth.access_token(http) == "access-1"  # still fresh: no request

        auth.expire_access()
        assert await auth.access_token(http) == "access-2"
        assert fake.forms[-1]["grant_type"] == "refresh_token"

        fake.refresh_ok = False  # the 7-day sign-in ran out early
        auth.expire_access()
        with pytest.raises(SignInNeeded):
            await auth.access_token(http)


async def test_provider_polls_watched_symbols_into_the_hub(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeSchwab()
    auth = SchwabAuth(SETTINGS, tmp_path / "tokens.json")
    async with client(fake) as http:
        await auth.sign_in("CODE", http)
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(fake), **kw))
    hub = LiveHub(SchwabProvider(auth))
    hub.start()
    watcher = hub.attach()
    await hub.watch(watcher, ["NASDAQ:NVDA", "NOPE"])
    for _ in range(100):
        if "NVDA" in hub.quotes:
            break
        await asyncio.sleep(0.01)
    message = hub.drain(watcher)
    assert message["status"]["state"] == "live" and message["status"]["sign_in_by"]
    assert message["status"]["mode"] == "poll"
    assert message["quotes"]["NVDA"]["last"] == 190.5 and "NOPE" not in message["quotes"]
    await hub.stop()


async def test_hub_asks_for_a_sign_in_when_tokens_are_missing(tmp_path: Path) -> None:
    hub = LiveHub(SchwabProvider(SchwabAuth(SETTINGS, tmp_path / "tokens.json")))
    hub.start()
    watcher = hub.attach()
    for _ in range(100):
        if hub.needs_sign_in:
            break
        await asyncio.sleep(0.01)
    status = hub.drain(watcher)["status"]
    assert status["sign_in"] is True and status["state"] == "down"
    await hub.stop()


def test_sign_in_endpoint_is_owner_only(fixture_path: Path, tmp_path: Path,
                                        monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from momo_scan.config import AppConfig
    from momo_scan.providers.fixture import FixtureProvider
    from momo_scan.web.server import create_app

    config = AppConfig()
    config.storage.database = str(tmp_path / "data" / "momo.db")
    data = tmp_path / "data"
    data.mkdir()
    (data / "live.toml").write_text('provider = "schwab"\n[schwab]\nclient_id = "id"\n'
                                    'client_secret = "secret"\n')
    (data / "access.toml").write_text('[accounts.sam]\nlogin = "sam@example.com"\nlive = true\n')
    fake = FakeSchwab()
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(fake), **kw))
    app = create_app(config, Path("config/momo.toml"),
                     provider_factory=lambda: FixtureProvider(fixture_path))
    sam = {"Tailscale-Headers-Info": "x", "X-Forwarded-For": "1.2.3.4",
           "Tailscale-User-Login": "sam@example.com", "X-Momo": "1"}
    with TestClient(app) as http:
        assert "client_id=id" in http.get("/api/live/schwab/sign-in").json()["url"]
        assert http.get("/api/live/schwab/sign-in", headers=sam).status_code == 403
        body = {"redirect": "https://127.0.0.1:8182/?code=abc"}
        assert http.post("/api/live/schwab/sign-in", json=body, headers=sam).status_code == 403
        assert http.post("/api/live/schwab/sign-in", json=body).status_code == 403  # no X-Momo
        done = http.post("/api/live/schwab/sign-in", json=body, headers={"X-Momo": "1"})
        assert done.json() == {"signed_in": True}
        assert json.loads((data / "schwab_tokens.json").read_text())["access_token"]


async def test_provider_streams_quotes_when_the_app_may_stream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Against a local stand-in for Schwab's streamer: login, subscriptions, partial updates."""
    import websockets

    requests: list[dict] = []

    async def streamer(socket) -> None:  # type: ignore[no-untyped-def]
        async for raw in socket:
            request = json.loads(raw)["requests"][0]
            requests.append(request)
            await socket.send(json.dumps({"response": [{
                "service": request["service"], "command": request["command"],
                "content": {"code": 0, "msg": "ok"},
            }]}))
            if request["command"] in ("SUBS", "ADD"):
                for key in request["parameters"]["keys"].split(","):  # a full first update
                    await socket.send(json.dumps({"data": [{"service": "LEVELONE_EQUITIES",
                        "content": [{"key": key, "3": 190.6, "29": 190.5, "8": 1000, "10": 191.0,
                                     "11": 184.0, "12": 186.0, "17": 185.0, "36": TRADE_MS}]}]}))
                await socket.send(json.dumps({"data": [{"service": "LEVELONE_EQUITIES",
                    "content": [{"key": "NVDA", "29": 190.75, "8": 1500}]}]}))  # only changes

    async with websockets.serve(streamer, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        fake = FakeSchwab()
        fake.streamer_url = f"ws://127.0.0.1:{port}"
        auth = SchwabAuth(SETTINGS, tmp_path / "tokens.json")
        async with client(fake) as http:
            await auth.sign_in("CODE", http)
        real = httpx.AsyncClient
        monkeypatch.setattr(httpx, "AsyncClient",
                            lambda **kw: real(transport=httpx.MockTransport(fake), **kw))
        hub = LiveHub(SchwabProvider(auth))
        hub.start()
        watcher = hub.attach()
        await hub.watch(watcher, ["NVDA"])
        for _ in range(200):
            if hub.quotes.get("NVDA") and hub.quotes["NVDA"].last == 190.75:
                break
            await asyncio.sleep(0.01)
        quote = hub.quotes["NVDA"]
        volume = quote.volume if quote.volume is not None else quote.pre_volume  # by the clock
        assert (quote.last, volume, quote.high, quote.prev_close) == (190.75, 1500, 191, 186)
        assert quote.day == date(2026, 10, 12)
        assert hub.drain(watcher)["status"]["mode"] == "stream"
        assert fake.quote_calls == 0  # streaming costs no requests

        await hub.watch(watcher, ["NVDA", "AMD"])
        await hub.watch(watcher, ["AMD"])
        await asyncio.sleep(0.05)
        commands = [(item["command"], item["parameters"].get("keys")) for item in requests]
        assert commands[0][0] == "LOGIN"
        assert commands[1:] == [("SUBS", "NVDA"), ("ADD", "AMD"), ("UNSUBS", "NVDA")]
        await hub.stop()
