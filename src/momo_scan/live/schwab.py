"""Schwab: OAuth sign-in, tokens, and quotes for the live hub.

Sign-in is Schwab's three-legged OAuth. Alex opens `authorize_url()`, approves, and Schwab
redirects to the app's callback (https://127.0.0.1:8182), a page that doesn't load; its
address carries a code that `sign_in()` trades for tokens within about 30 seconds. The access
token lasts 30 minutes and is refreshed here; the refresh token lasts 7 days, after which
`SignInNeeded` asks for a new sign-in. Tokens live in `data/schwab_tokens.json` (owner-only).

Quotes stream over Schwab's streamer (LEVELONE_EQUITIES), which needs the Accounts and Trading
product and costs none of the ~120 requests a minute. Without it, quotes are polled from the
Market Data API's /quotes endpoint about once a second while the market is open. Intraday
charts get history from /pricehistory and finished 1-minute bars from the streamer
(CHART_EQUITY). Every request goes through one limiter, so the app stays under Schwab's limit.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from collections.abc import Callable
from datetime import UTC, date, datetime
from datetime import time as dt_time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit
from zoneinfo import ZoneInfo

import httpx
import websockets

from momo_scan.live.base import MARKET_TZ, Emit, Quote, SignInNeeded, market_day

API = "https://api.schwabapi.com"
AUTHORIZE_URL = f"{API}/v1/oauth/authorize"
TOKEN_URL = f"{API}/v1/oauth/token"
QUOTES_URL = f"{API}/marketdata/v1/quotes"
HISTORY_URL = f"{API}/marketdata/v1/pricehistory"
PREFERENCES_URL = f"{API}/trader/v1/userPreference"  # the streamer's address and login ids
REFRESH_LIFETIME = 7 * 24 * 3600 - 300  # Schwab's 7 days, a little early to be safe
EARLY_REFRESH = 120  # refresh the access token this many seconds before it expires
POLL_OPEN = 1.0  # seconds between polls while stocks trade (4:00-20:00 ET, weekdays)
POLL_CLOSED = 30.0
BATCH = 500  # symbols per quotes request (Schwab's maximum)
STREAM_SILENCE = 60.0  # reconnect when the streamer says nothing, not even a heartbeat
# LEVELONE_EQUITIES fields: 1 bid, 2 ask, 3 last, 8 day volume, 10 high, 11 low,
# 12 previous close, 17 open, 29 regular-market last, 35 trade time, 36 regular trade time.
LEVEL_ONE_FIELDS = "0,1,2,3,8,10,11,12,17,29,35,36"
# CHART_EQUITY: a finished 1-minute bar. 2 open, 3 high, 4 low, 5 close, 6 volume, 7 time ms.
CHART_FIELDS = "0,1,2,3,4,5,6,7,8"
REQUESTS_PER_MINUTE = 100  # Schwab allows 120 for non-order calls; keep a margin
BURST = 20
CENTRAL = ZoneInfo("America/Chicago")  # where Schwab stamps daily candles

log = logging.getLogger(__name__)


class SchwabAuth:
    def __init__(self, settings: dict[str, Any], token_path: Path) -> None:
        schwab = settings.get("schwab") or {}
        self.client_id = str(schwab.get("client_id", "")).strip()
        self.client_secret = str(schwab.get("client_secret", "")).strip()
        self.callback_url = str(schwab.get("callback_url", "https://127.0.0.1:8182")).strip()
        if not self.client_id or not self.client_secret:
            raise ValueError("data/live.toml needs [schwab] client_id and client_secret")
        self.token_path = token_path
        self._lock = asyncio.Lock()

    def authorize_url(self) -> str:
        query = urlencode({"client_id": self.client_id, "redirect_uri": self.callback_url})
        return f"{AUTHORIZE_URL}?{query}"

    def _tokens(self) -> dict[str, Any]:
        try:
            return json.loads(self.token_path.read_text())
        except (OSError, ValueError):
            return {}

    def _save(self, tokens: dict[str, Any]) -> None:
        temp = self.token_path.with_suffix(".tmp")
        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump(tokens, handle)
        os.replace(temp, self.token_path)

    def sign_in_by(self) -> float | None:
        """When the 7-day sign-in runs out (epoch seconds), or None before the first."""
        return self._tokens().get("refresh_expires")

    async def _token_request(self, client: httpx.AsyncClient, form: dict[str, str]) -> Any:
        basic = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        response = await client.post(
            TOKEN_URL, data=form, headers={"Authorization": f"Basic {basic}"}, timeout=20
        )
        if response.status_code != 200:
            raise RuntimeError(f"Schwab token request failed ({response.status_code}): "
                               f"{response.text[:200]}")
        return response.json()

    async def sign_in(self, redirected: str, client: httpx.AsyncClient | None = None) -> None:
        """Trade the code in the redirect address (or the bare code) for tokens."""
        text = redirected.strip()
        code = parse_qs(urlsplit(text).query).get("code", [""])[0] if "code=" in text else text
        if not code:
            raise ValueError("No code in that address: copy the whole URL after approving")
        async with self._lock, _client(client) as http:
            body = await self._token_request(http, {
                "grant_type": "authorization_code", "code": code,
                "redirect_uri": self.callback_url,
            })
            now = time.time()
            self._save({
                "access_token": body["access_token"],
                "refresh_token": body["refresh_token"],
                "access_expires": now + float(body.get("expires_in", 1800)),
                "refresh_expires": now + REFRESH_LIFETIME,
            })

    def expire_access(self) -> None:
        tokens = self._tokens()
        if tokens:
            self._save({**tokens, "access_expires": 0})

    async def access_token(self, client: httpx.AsyncClient) -> str:
        async with self._lock:
            tokens = self._tokens()
            now = time.time()
            if not tokens.get("refresh_token") or tokens.get("refresh_expires", 0) <= now:
                raise SignInNeeded("Sign in to Schwab")
            if tokens.get("access_expires", 0) - EARLY_REFRESH > now:
                return str(tokens["access_token"])
            try:
                body = await self._token_request(client, {
                    "grant_type": "refresh_token", "refresh_token": tokens["refresh_token"],
                })
            except RuntimeError as error:
                if "(400)" in str(error) or "(401)" in str(error):
                    raise SignInNeeded("Schwab sign-in expired") from error
                raise
            tokens.update({
                "access_token": body["access_token"],
                "refresh_token": body.get("refresh_token", tokens["refresh_token"]),
                "access_expires": now + float(body.get("expires_in", 1800)),
            })
            self._save(tokens)
            return str(tokens["access_token"])


class Limiter:
    """Keeps every Schwab request inside the app's limit: a token bucket refilled evenly, so
    bursts (flipping charts) go at once and a long run slows down instead of being refused.
    Background work waits until the bucket is half full, so it never delays a chart."""

    def __init__(self, per_minute: float = REQUESTS_PER_MINUTE, burst: int = BURST) -> None:
        self.rate = per_minute / 60
        self.burst = burst
        self.tokens = float(burst)
        self.stamp = time.monotonic()

    async def take(self, background: bool = False) -> None:
        floor = self.burst / 2 if background else 0
        while True:
            now = time.monotonic()
            self.tokens = min(self.burst, self.tokens + (now - self.stamp) * self.rate)
            self.stamp = now
            if self.tokens >= 1 + floor:
                self.tokens -= 1
                return
            await asyncio.sleep((1 + floor - self.tokens) / self.rate)


def _client(client: httpx.AsyncClient | None) -> Any:
    """Use the caller's client, or a fresh one closed afterwards."""
    if client is not None:
        from contextlib import nullcontext

        return nullcontext(client)
    return httpx.AsyncClient()


def market_open(now: datetime | None = None) -> bool:
    """Weekday, 4:00-20:00 ET: pre-market through after-hours. Holidays just poll slowly."""
    local = (now or datetime.now(UTC)).astimezone(MARKET_TZ)
    return local.weekday() < 5 and 4 <= local.hour < 20


def _price(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and value > 0 else None


def _volumes(value: Any, day: Any, now: datetime | None) -> tuple[float | None, float | None]:
    """(day volume, pre-market volume). Before the open Schwab's total is today's pre-market
    while the regular fields still describe the last session, so it moves to `pre_volume`."""
    volume = float(value) if isinstance(value, int | float) else None
    local = (now or datetime.now(UTC)).astimezone(MARKET_TZ)
    pre_market = local.weekday() < 5 and 4 * 60 <= local.hour * 60 + local.minute < 9 * 60 + 30
    if pre_market and day < local.date():
        return None, volume
    return volume, None


def parse_quote(symbol: str, item: dict[str, Any], now: datetime | None = None) -> Quote | None:
    """One /quotes entry as a Quote. The daily bar follows the regular session, like the
    archive and TradingView: last is the regular-market price, stamped with its trade day."""
    quote = item.get("quote") or {}
    regular = item.get("regular") or {}
    last = _price(regular.get("regularMarketLastPrice")) or _price(quote.get("lastPrice"))
    if last is None:
        return None
    stamp = regular.get("regularMarketTradeTime") or quote.get("tradeTime") or quote.get(
        "quoteTime"
    )
    at = datetime.fromtimestamp(stamp / 1000, UTC) if stamp else datetime.now(UTC)
    volume, pre_volume = _volumes(quote.get("totalVolume"), market_day(at), now)
    return Quote(
        symbol=symbol, last=last, day=market_day(at), time=at.timestamp(),
        open=_price(quote.get("openPrice")), high=_price(quote.get("highPrice")),
        low=_price(quote.get("lowPrice")), volume=volume,
        prev_close=_price(quote.get("closePrice")),
        bid=_price(quote.get("bidPrice")), ask=_price(quote.get("askPrice")),
        trade=_price(quote.get("lastPrice")), pre_volume=pre_volume,
    )


def stream_quote(
    symbol: str, fields: dict[str, Any], now: datetime | None = None
) -> Quote | None:
    """A symbol's merged streamer fields as a Quote (the streamer sends only what changed)."""
    last = _price(fields.get("29")) or _price(fields.get("3"))
    if last is None:
        return None
    stamp = fields.get("36") or fields.get("35")
    at = datetime.fromtimestamp(stamp / 1000, UTC) if stamp else datetime.now(UTC)
    volume, pre_volume = _volumes(fields.get("8"), market_day(at), now)
    return Quote(
        symbol=symbol, last=last, day=market_day(at), time=at.timestamp(),
        open=_price(fields.get("17")), high=_price(fields.get("10")),
        low=_price(fields.get("11")), volume=volume,
        prev_close=_price(fields.get("12")),
        bid=_price(fields.get("1")), ask=_price(fields.get("2")),
        trade=_price(fields.get("3")), pre_volume=pre_volume,
    )


class SchwabProvider:
    name = "schwab"
    simulated = False

    def __init__(self, auth: SchwabAuth) -> None:
        self.auth = auth
        self.symbols: frozenset[str] = frozenset()
        self.changed = asyncio.Event()  # a new symbol polls at once instead of next round
        self.mode: str | None = None  # "stream" or "poll"
        self.bar_symbols: frozenset[str] = frozenset()  # streamed 1-minute bars
        self.bar_sink: Callable[[str, tuple[int, float, float, float, float, float]], None] | None
        self.bar_sink = None  # set by the hub
        self.limiter = Limiter()
        self._http: httpx.AsyncClient | None = None  # kept open: no new TLS handshake a chart
        self._socket: Any = None
        self._streamer: dict[str, Any] = {}
        self._streamed: dict[str, frozenset[str]] = {}
        self._fields: dict[str, dict[str, Any]] = {}
        self._request_id = 0

    def sign_in_by(self) -> float | None:
        return self.auth.sign_in_by()

    async def subscribe(self, symbols: frozenset[str]) -> None:
        if symbols - self.symbols:
            self.changed.set()
        self.symbols = symbols
        if self._socket is not None:
            await self._sync()

    async def subscribe_bars(self, symbols: frozenset[str]) -> None:
        self.bar_symbols = symbols
        if self._socket is not None:
            await self._sync()

    async def history(
        self, symbol: str, minutes: int, start: int, end: int, background: bool = False
    ) -> list[tuple[int, float, float, float, float, float]]:
        """Intraday bars from `start` to `end` (epoch seconds), pre- and post-market included."""
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=30)
        await self.limiter.take(background)
        token = await self.auth.access_token(self._http)
        response = await self._http.get(HISTORY_URL, params={
            "symbol": symbol, "frequencyType": "minute", "frequency": minutes,
            "startDate": start * 1000, "endDate": end * 1000, "needExtendedHoursData": "true",
        }, headers={"Authorization": f"Bearer {token}"})
        if response.status_code == 401:
            self.auth.expire_access()
            raise RuntimeError("Schwab refused the access token")
        response.raise_for_status()
        return [
            (int(c["datetime"]) // 1000, float(c["open"]), float(c["high"]), float(c["low"]),
             float(c["close"]), float(c["volume"]))
            for c in response.json().get("candles", [])
        ]

    async def daily(
        self, symbol: str, start: date | None = None, background: bool = True
    ) -> list[tuple[date, float, float, float, float, float]]:
        """Daily bars, split-adjusted: twenty years of them, or from `start` on. Each candle is
        stamped at midnight Central, so its date is the trading day."""
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=30)
        await self.limiter.take(background)
        token = await self.auth.access_token(self._http)
        params: dict[str, Any] = {
            "symbol": symbol, "periodType": "year", "frequencyType": "daily", "frequency": 1,
        }
        if start is None:
            params["period"] = 20
        else:
            params["startDate"] = int(datetime.combine(start, dt_time(), UTC).timestamp() * 1000)
            params["endDate"] = int(time.time() * 1000)
        response = await self._http.get(
            HISTORY_URL, params=params, headers={"Authorization": f"Bearer {token}"}
        )
        if response.status_code == 401:
            self.auth.expire_access()
            raise RuntimeError("Schwab refused the access token")
        response.raise_for_status()
        return [
            (datetime.fromtimestamp(int(c["datetime"]) / 1000, CENTRAL).date(),
             float(c["open"]), float(c["high"]), float(c["low"]), float(c["close"]),
             float(c["volume"]))
            for c in response.json().get("candles", [])
        ]

    async def run(self, emit: Emit, ready: Callable[[], None]) -> None:
        async with httpx.AsyncClient(timeout=10) as client:
            token = await self.auth.access_token(client)  # fail fast when a sign-in is needed
            streamer = await self._streamer_info(client, token)
            if streamer is None:
                self.mode = "poll"
                ready()
                await self._poll(client, emit)
            else:
                self.mode = "stream"
                await self._stream(streamer, token, emit, ready)

    async def _streamer_info(self, client: httpx.AsyncClient, token: str) -> dict[str, Any] | None:
        """The streamer's address and ids, or None when the app may not stream (Market Data
        alone answers 401 "Client not authorized")."""
        response = await client.get(PREFERENCES_URL, headers={"Authorization": f"Bearer {token}"})
        if response.status_code in (401, 403):
            return None
        response.raise_for_status()
        found = response.json().get("streamerInfo") or []
        return found[0] if found else None

    # ---------- streaming ----------

    async def _send(self, service: str, command: str, parameters: dict[str, Any]) -> None:
        self._request_id += 1
        await self._socket.send(json.dumps({"requests": [{
            "requestid": str(self._request_id), "service": service, "command": command,
            "SchwabClientCustomerId": self._streamer["schwabClientCustomerId"],
            "SchwabClientCorrelId": self._streamer["schwabClientCorrelId"],
            "parameters": parameters,
        }]}))

    async def _sync(self) -> None:
        """Bring the streamer's symbols in line with what the hub wants, per service."""
        for service, wanted, fields in (
            ("LEVELONE_EQUITIES", self.symbols, LEVEL_ONE_FIELDS),
            ("CHART_EQUITY", self.bar_symbols, CHART_FIELDS),
        ):
            streamed = self._streamed.get(service, frozenset())
            added, removed = wanted - streamed, streamed - wanted
            self._streamed[service] = wanted
            if removed:
                await self._send(service, "UNSUBS", {"keys": ",".join(sorted(removed))})
                if service == "LEVELONE_EQUITIES":
                    for symbol in removed:
                        self._fields.pop(symbol, None)
            if added:
                command = "ADD" if wanted - added else "SUBS"
                await self._send(service, command, {
                    "keys": ",".join(sorted(added)), "fields": fields,
                })

    async def _stream(
        self, streamer: dict[str, Any], token: str, emit: Emit, ready: Callable[[], None]
    ) -> None:
        self._streamer = streamer
        async with websockets.connect(streamer["streamerSocketUrl"]) as socket:
            self._socket = socket
            self._streamed = {}
            self._fields = {}
            try:
                await self._send("ADMIN", "LOGIN", {
                    "Authorization": token,
                    "SchwabClientChannel": streamer["schwabClientChannel"],
                    "SchwabClientFunctionId": streamer["schwabClientFunctionId"],
                })
                while True:  # the login answer comes first
                    message = json.loads(await asyncio.wait_for(socket.recv(), 20))
                    login = next((item for item in message.get("response", [])
                                  if item.get("command") == "LOGIN"), None)
                    if login is not None:
                        break
                content = login.get("content") or {}
                if content.get("code") != 0:
                    raise RuntimeError(f"Schwab streamer refused the login: {content.get('msg')}")
                await self._sync()
                ready()
                while True:
                    message = json.loads(await asyncio.wait_for(socket.recv(), STREAM_SILENCE))
                    self._handle(message, emit)
            finally:
                self._socket = None

    def _handle(self, message: dict[str, Any], emit: Emit) -> None:
        for item in message.get("data", []):
            if item.get("service") == "CHART_EQUITY":
                self._bars(item.get("content", []))
                continue
            if item.get("service") != "LEVELONE_EQUITIES":
                continue
            for content in item.get("content", []):
                symbol = content.get("key")
                if symbol not in self._streamed.get("LEVELONE_EQUITIES", ()):
                    continue
                fields = self._fields.setdefault(symbol, {})
                fields.update(content)
                quote = stream_quote(symbol, fields)
                if quote is not None:
                    emit(quote)
        for item in message.get("response", []):
            content = item.get("content") or {}
            if content.get("code") not in (0, None):
                log.warning("Schwab streamer %s %s: %s", item.get("service"),
                            item.get("command"), content.get("msg"))
        for item in message.get("notify", []):
            content = item.get("content") or {}
            if content.get("code") not in (0, None):  # e.g. another session took over
                raise RuntimeError(f"Schwab streamer closed: {content.get('msg')}")

    def _bars(self, contents: list[dict[str, Any]]) -> None:
        for content in contents:
            symbol = content.get("key")
            if self.bar_sink is None or symbol not in self.bar_symbols:
                continue
            try:
                row = (int(content["7"]) // 1000, float(content["2"]), float(content["3"]),
                       float(content["4"]), float(content["5"]), float(content["6"]))
            except (KeyError, TypeError, ValueError):
                continue  # a partial update: the next full bar will do
            self.bar_sink(symbol, row)

    # ---------- polling (no streamer) ----------

    async def _poll(self, client: httpx.AsyncClient, emit: Emit) -> None:
        while True:
            symbols = sorted(self.symbols)
            for start in range(0, len(symbols), BATCH):
                for quote in await self.fetch(client, symbols[start:start + BATCH]):
                    emit(quote)
            self.changed.clear()
            try:
                wait = POLL_OPEN if market_open() else POLL_CLOSED
                await asyncio.wait_for(self.changed.wait(), wait)
            except TimeoutError:
                pass

    async def sweep(self, symbols: list[str]) -> list[Quote]:
        """Quotes for a long list of symbols (the intraday screener), in batches at background
        priority: the limiter holds half its burst back for charts."""
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=30)
        found: list[Quote] = []
        for start in range(0, len(symbols), BATCH):
            found += await self.fetch(self._http, symbols[start:start + BATCH], background=True)
        return found

    async def fetch(
        self, client: httpx.AsyncClient, symbols: list[str], background: bool = False
    ) -> list[Quote]:
        if not symbols:
            return []
        await self.limiter.take(background)
        token = await self.auth.access_token(client)
        response = await client.get(
            QUOTES_URL,
            params={"symbols": ",".join(symbols), "fields": "quote,regular"},
            headers={"Authorization": f"Bearer {token}"},
        )
        if response.status_code == 401:  # refresh on the next try; a dead sign-in shows then
            self.auth.expire_access()
            raise RuntimeError("Schwab refused the access token")
        response.raise_for_status()
        body = response.json()
        quotes = []
        for symbol in symbols:
            item = body.get(symbol)
            parsed = parse_quote(symbol, item) if isinstance(item, dict) else None
            if parsed is not None:
                quotes.append(parsed)
        return quotes
