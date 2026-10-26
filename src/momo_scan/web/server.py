"""FastAPI application behind `momo serve`.

The server binds to loopback; remote access goes through `tailscale serve`, which keeps
it on the tailnet. Mutating requests require an `X-Momo` header so an arbitrary web page
cannot trigger them through the browser.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from momo_scan.alerts import Alerts, AlertWatcher
from momo_scan.config import AppConfig
from momo_scan.live import LiveHub, load_live_settings, make_provider
from momo_scan.metrics import adr_percent, average_dollar_volume
from momo_scan.models import Bar
from momo_scan.storage import Storage
from momo_scan.web.access import AccessDenied, Account, identify, load_accounts
from momo_scan.web.timeframes import aggregate, daily_bars_needed, parse_interval

# Daily review, Practice, the Playbook and notes for Claude (web/private.py). The public
# edition leaves that module out, and momo is then charts, watchlists and the screener.
PRIVATE = importlib.util.find_spec("momo_scan.web.private") is not None
STATIC = Path(__file__).parent / "static"
# Allowed setting keys and their size limits in bytes.
SETTING_KEYS = {
    "chart": 50_000, "chart_right": 50_000,  # split view: the left and right charts
    "watchlists": 200_000, "drawings": 2_000_000, "screens": 50_000,
    "alert_prefs": 2_000,  # price alerts: line colour and style, sound
}
CHART_BARS = 520
LIVE_FLUSH_SECONDS = 0.1  # at most 10 live messages a second per browser tab


log = logging.getLogger(__name__)


class AlertBody(BaseModel):
    symbol: str | None = Field(default=None, min_length=1, max_length=30)
    price: float | None = Field(default=None, gt=0)
    direction: str | None = Field(default=None, pattern="^(cross|up|down)$")
    repeat: bool | None = None
    extended: bool | None = None
    note: str | None = Field(default=None, max_length=200)
    drawing_id: str | None = Field(default=None, max_length=40)
    status: str | None = Field(default=None, pattern="^(active|paused)$")


class SeenBody(BaseModel):
    ids: list[int] = Field(max_length=500)


class SchwabKeysBody(BaseModel):
    client_id: str = Field(min_length=8, max_length=200)
    client_secret: str = Field(min_length=8, max_length=200)
    callback_url: str = Field(default="https://127.0.0.1:8182", pattern="^https://", max_length=200)


def write_live_settings(path: Path, settings: dict[str, Any]) -> None:
    """`data/live.toml` (top-level values and one level of tables), readable by its owner only."""

    def value(item: Any) -> str:
        if isinstance(item, bool):
            return "true" if item else "false"
        if isinstance(item, int | float):
            return str(item)
        return json.dumps(str(item))  # a JSON string is a valid TOML basic string

    lines = [
        f"{key} = {value(item)}" for key, item in settings.items() if not isinstance(item, dict)
    ]
    for table, items in settings.items():
        if isinstance(items, dict):
            lines += ["", f"[{table}]", *(f"{key} = {value(item)}" for key, item in items.items())]
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    os.replace(temp, path)


class SignInBody(BaseModel):
    redirect: str = Field(min_length=4, max_length=4000)  # the address Schwab redirected to


class _RevalidatedStaticFiles(StaticFiles):
    """Make browsers check for a newer file on every load (a cheap 304 when unchanged).

    Without an explicit header, mobile Safari heuristically reuses stale CSS/JS after a deploy.
    """

    def file_response(self, *args: Any, **kwargs: Any) -> Any:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


def _bar_payload(bar: Bar) -> dict[str, Any]:
    return {
        "time": datetime.fromtimestamp(bar.t, tz=UTC).date().isoformat(),
        "open": bar.o,
        "high": bar.h,
        "low": bar.l,
        "close": bar.c,
        "volume": bar.v,
    }


def same_origin(origin: str, headers: Any) -> bool:
    host = urlsplit(origin).netloc.lower()
    hosts = {headers.get("host", "").lower(), headers.get("x-forwarded-host", "").lower()}
    return host in hosts or urlsplit(origin).hostname in {"127.0.0.1", "localhost"}


def create_app(
    config: AppConfig,
    config_path: Path,
    *,
    provider_factory: Any = None,
    scan_command: list[str] | None = None,
    access_path: Path | None = None,
    live_provider: Any = None,
    live_name: str | None = None,
) -> FastAPI:
    """Build the app. `provider_factory` returns an async-context market data provider;
    `live_provider` (an object) or `live_name` overrides the feed named in `data/live.toml`."""

    if provider_factory is None:
        from momo_scan.providers.sqlite import LocalSQLiteProvider

        def provider_factory() -> Any:
            return LocalSQLiteProvider(config.provider, config.regime)

    state: dict[str, Any] = {}
    screening = asyncio.Lock()

    async def latest_session(provider: Any) -> date:
        today = date.today()
        sessions = await provider.get_sessions(today - timedelta(days=10), today)
        if not sessions:  # momo's own store before its first fill
            raise HTTPException(503, "No recent market data yet")
        return max(sessions)

    async def screen_table() -> tuple[date, list[dict[str, Any]]]:
        """Every stock's readings for the latest session. Building takes ~20 s, so one build
        at a time (a second caller waits for it) and it is kept until the next session."""
        from momo_scan.screener import BARS_NEEDED, build_table
        from momo_scan.themes import load_taxonomy

        provider = state["provider"]
        async with screening:
            latest = await latest_session(provider)
            cached = state.get("screen_table")
            if not cached or cached[0] != latest:
                memberships: dict[str, list[str]] = {}
                try:
                    taxonomy = load_taxonomy(config.themes.path)
                    names = {theme.theme_id: theme.name for theme in taxonomy.themes}
                    for item in taxonomy.active_memberships(latest):
                        memberships.setdefault(item.ticker, []).append(names.get(item.theme_id, ""))
                except (OSError, ValueError):  # the screener works without themes
                    pass
                universe = await provider.screen_universe(BARS_NEEDED)
                cached = (latest, await asyncio.to_thread(build_table, universe, memberships))
                state["screen_table"] = cached
            return cached

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> Any:
        state["storage"] = Storage(config.storage.database)
        bar_store = None
        if config.provider.fill == "schwab":
            from momo_scan.bars import BarStore

            bar_store = BarStore(Path(config.provider.database))  # before the provider opens it
        state["bar_store"] = bar_store
        provider = provider_factory()
        try:
            state["provider"] = await provider.__aenter__()
        except Exception as error:  # charts fall back to cached bars
            state["provider"] = None
            state["provider_error"] = str(error)
        state["live"] = LiveHub(None)
        state["alerts"] = Alerts(state["storage"])
        state["alert_watcher"] = AlertWatcher(state["alerts"], state["live"])
        await state["alert_watcher"].reload()
        await use_feed(live_provider or live_feed())
        warm = None
        if hasattr(state["provider"], "screen_universe"):
            # Build the screener's table now so the first open of the window isn't a long wait.
            warm = asyncio.create_task(screen_table())
        try:
            yield
        finally:
            if warm:
                warm.cancel()
            await drop_feed()
            if bar_store is not None:
                bar_store.close()
            if state.get("provider") is not None:
                await provider.__aexit__(None, None, None)
            state["storage"].close()

    data_dir = Path(config.storage.database).parent

    async def use_feed(provider: Any) -> None:
        """Start a live feed and what hangs off it: intraday charts, Volume Buzz, the market
        sweep and momo's own daily bars."""
        hub: LiveHub = state["live"]
        await hub.use(provider)
        state["intraday"] = intraday_service(hub)
        state["buzz"] = None
        if state["intraday"] is not None:
            from momo_scan.buzz import BuzzService

            state["buzz"] = BuzzService(state["intraday"], hub)
            state["buzz"].start()
        state["sweep"] = market_sweep(provider)
        state["filler"] = bar_filler(state.get("bar_store"), provider)

    async def drop_feed() -> None:
        for key in ("filler", "buzz", "sweep"):
            if state.get(key) is not None:
                await state[key].stop()
            state[key] = None
        await state["live"].stop()
        if state.get("intraday") is not None:
            state["intraday"].store.close()
            state["intraday"] = None

    def live_feed() -> Any:
        try:
            settings = load_live_settings(data_dir / "live.toml")
            if live_name:
                settings["provider"] = live_name
            return make_provider(settings, last_close, data_dir)
        except (OSError, ValueError) as error:  # bad settings: no live data, charts still work
            log.error("Live data off: %s", error)
            return None

    def market_sweep(provider: Any) -> Any:
        """The intraday screener's full-market sweep, when the feed can do one."""
        if provider is None or not hasattr(provider, "sweep"):
            return None
        from momo_scan.live.sweep import MIN_DVOL, SWEEP_SECONDS, MarketSweep

        try:
            settings = (load_live_settings(data_dir / "live.toml").get("sweep") or {})
            return MarketSweep(
                provider, max(5.0, float(settings.get("seconds", SWEEP_SECONDS))),
                float(settings.get("min_dvol", MIN_DVOL)),
            )
        except (OSError, ValueError):
            return MarketSweep(provider)

    def bar_filler(store: Any, provider: Any) -> Any:
        """Daily bars from the live feed's history, when momo keeps its own (momo_scan.bars)."""
        if store is None:
            return None
        if provider is None or not hasattr(provider, "daily"):
            log.error("Daily bars are filled from Schwab: set it as the live feed")
            return None
        from momo_scan.bars import BarFiller, schwab_feed

        filler = BarFiller(store, *schwab_feed(provider))
        filler.start()
        return filler

    def intraday_service(hub: LiveHub) -> Any:
        """Intraday charts, when the live feed has history (Schwab does; the sim doesn't)."""
        from momo_scan.intraday import IntradayService, IntradayStore

        provider = hub.provider
        if provider is None or not hasattr(provider, "history"):
            return None
        service = IntradayService(
            IntradayStore(data_dir / "intraday.db"), provider.history, hub.bars_since.get
        )

        def save(symbol: str, row: Any) -> None:
            task = asyncio.create_task(asyncio.to_thread(service.save_streamed, symbol, row))
            saving.add(task)
            task.add_done_callback(saving.discard)

        saving: set[asyncio.Task[None]] = set()
        hub.on_bar = save
        return service

    async def last_close(symbol: str) -> float | None:
        """The newest archived close, to start the simulated feed from."""
        provider = state.get("provider")
        if provider is None:
            return None
        qualified = await _qualify(provider, symbol)
        if hasattr(provider, "get_chart_bars"):
            loaded = await provider.get_chart_bars(qualified, 1, None)
        else:
            loaded = await provider.get_ohlcv(qualified, count=1)
        return loaded[-1].c if loaded else None

    app = FastAPI(title="Momo Scan", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(GZipMiddleware, minimum_size=1000)  # bar payloads are ~180 KB of JSON
    accounts_file = access_path or Path(config.storage.database).parent / "access.toml"

    @app.middleware("http")
    async def who(request: Request, call_next: Any) -> Any:
        # Re-read each request so adding someone doesn't need a restart.
        try:
            request.state.account = identify(request, load_accounts(accounts_file))
        except AccessDenied as error:
            if request.url.path.startswith("/api/"):
                return JSONResponse({"detail": str(error)}, status_code=403)
            return PlainTextResponse(f"{error}. Ask the owner for access.", status_code=403)
        return await call_next(request)
    app.mount("/static", _RevalidatedStaticFiles(directory=STATIC), name="static")

    def storage() -> Storage:
        return state["storage"]

    def require_header(request: Request) -> None:
        if request.headers.get("x-momo") != "1":
            raise HTTPException(403, "Missing X-Momo header")

    def account(request: Request) -> Account:
        return request.state.account

    def user(request: Request) -> str:
        return account(request).id

    def require_owner(request: Request) -> None:
        if not account(request).owner:
            raise HTTPException(403, "Only the owner can do that")

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/api/me")
    async def me(request: Request) -> dict[str, Any]:
        who = account(request)
        return {
            "id": who.id, "name": who.name, "owner": who.owner, "live": who.sees_live,
            "private": PRIVATE, "setup": who.owner and feed_setup()["needed"],
        }

    def feed_setup() -> dict[str, Any]:
        """What the owner still has to do before momo has data: Schwab's keys, then a sign-in.
        Only asked of installs that fill their own bars; others may run without a feed."""
        provider = state["live"].provider
        keys = provider is not None and provider.name == "schwab"
        signed_in = keys and provider.sign_in_by() is not None
        filler = state.get("filler")
        return {
            "fill": config.provider.fill,
            "keys": keys,
            "signed_in": signed_in,
            "needed": config.provider.fill == "schwab" and not signed_in,
            "bars": filler and {**filler.store.progress(), "error": filler.error},
        }

    @app.get("/api/live/setup")
    async def live_setup(request: Request) -> dict[str, Any]:
        require_owner(request)
        return feed_setup()

    @app.post("/api/live/schwab/keys")
    async def schwab_keys(body: SchwabKeysBody, request: Request) -> dict[str, Any]:
        """Keys from the owner's Schwab developer app: saved to data/live.toml (owner-only),
        then the feed starts on them. The sign-in comes next."""
        require_header(request)
        require_owner(request)
        path = data_dir / "live.toml"
        try:
            settings = load_live_settings(path) if path.exists() else {}
        except ValueError:
            settings = {}
        settings["provider"] = "schwab"
        settings["schwab"] = {
            **(settings.get("schwab") or {}), "client_id": body.client_id.strip(),
            "client_secret": body.client_secret.strip(), "callback_url": body.callback_url.strip(),
        }
        write_live_settings(path, settings)
        await drop_feed()
        await use_feed(live_feed())
        return feed_setup()

    def schwab() -> Any:
        provider = state["live"].provider
        if provider is None or provider.name != "schwab":
            raise HTTPException(404, "The live feed isn't Schwab")
        return provider.auth

    @app.get("/api/live/schwab/sign-in")
    async def schwab_sign_in_url(request: Request) -> dict[str, str]:
        require_owner(request)
        return {"url": schwab().authorize_url()}

    @app.post("/api/live/schwab/sign-in")
    async def schwab_sign_in(body: SignInBody, request: Request) -> dict[str, Any]:
        """The address Schwab redirected to after Alex approved; it carries the code."""
        require_header(request)
        require_owner(request)
        try:
            await schwab().sign_in(body.redirect)
        except (ValueError, RuntimeError) as error:
            log.warning("Schwab sign-in failed: %s", error)
            raise HTTPException(400, str(error)) from error
        await state["live"].restart()
        if state.get("filler") is not None:
            state["filler"].wake()
        return {"signed_in": True}

    @app.get("/api/intraday")
    async def intraday(
        request: Request, symbol: str, interval: str = "5m", count: int = 1500,
        extended: bool = True,
    ) -> dict[str, Any]:
        """Intraday bars from momo's store, topped up from the live feed's history."""
        from momo_scan.intraday import INTERVALS
        from momo_scan.live.base import SignInNeeded
        from momo_scan.live.hub import clean_symbol

        if not account(request).sees_live:
            raise HTTPException(403, "Intraday charts come with live prices")
        service = state.get("intraday")
        if service is None:
            raise HTTPException(503, "Intraday charts need a live feed with history (Schwab)")
        if interval not in INTERVALS:
            raise HTTPException(400, f"Unknown interval {interval}: use {', '.join(INTERVALS)}")
        ticker = clean_symbol(symbol)
        try:
            payload = await service.bars(ticker, interval, max(20, min(count, 5000)), extended)
        except SignInNeeded as error:
            raise HTTPException(503, str(error)) from error
        except Exception as error:  # the vendor failed: say so rather than show a gap
            log.warning("Intraday %s %s failed: %s", ticker, interval, error)
            raise HTTPException(502, f"Couldn't load {ticker} {interval}: {error}") from error
        if not payload["bars"]:
            raise HTTPException(404, f"No intraday bars for {ticker}")
        return payload

    @app.get("/api/extended")
    async def extended_bar(request: Request, symbol: str) -> dict[str, Any]:
        """Today's pre- or post-market so far as one bar (open, high, low, close, volume), for
        the daily chart's ghost candle; {"bar": null} outside those sessions."""
        from momo_scan.intraday import extended_session
        from momo_scan.live.base import SignInNeeded
        from momo_scan.live.hub import clean_symbol

        if not account(request).sees_live:
            raise HTTPException(403, "Extended hours come with live prices")
        service = state.get("intraday")
        if service is None or extended_session(service.clock()) is None:
            return {"bar": None}
        ticker = clean_symbol(symbol)
        try:
            if service.needs_fetch(ticker, 5):  # once: the stream keeps a shown chart current
                await service.ensure(ticker, 5, background=True)
        except SignInNeeded:
            pass
        except Exception as error:  # the vendor failed: the ghost waits for the next try
            log.warning("Extended bar for %s failed: %s", ticker, error)
        return {"bar": await asyncio.to_thread(service.extended_bar, ticker)}

    @app.websocket("/api/live")
    async def live_socket(socket: WebSocket) -> None:
        """Live quotes. The browser sends {"op": "watch", "symbols": [...]} whenever what it
        shows changes, {"op": "watch_bars", ...} for intraday charts and {"op": "watch_buzz",
        ...} for lists showing Volume Buzz; the server sends {"status": ...}, {"quotes": {SYMBOL:
        quote}}, {"bars": {SYMBOL: [[t, o, h, l, c, v]]}} (finished 1-minute bars) and {"buzz":
        {SYMBOL: {"session", "day", "pct", "volume"}}}."""
        try:
            who = identify(socket, load_accounts(accounts_file))
        except AccessDenied:
            await socket.close(code=4403)
            return
        # Another site's page can't open a socket here in Alex's name.
        origin = socket.headers.get("origin")
        if not who.sees_live or (origin and not same_origin(origin, socket.headers)):
            await socket.close(code=4403)
            return
        await socket.accept()
        hub: LiveHub = state["live"]
        client = hub.attach(who.id)

        async def send() -> None:
            while True:
                await client.wake.wait()
                message = hub.drain(client)
                if message:
                    await socket.send_json(message)
                await asyncio.sleep(LIVE_FLUSH_SECONDS)

        async def receive() -> None:
            while True:
                message = await socket.receive_json()
                if not isinstance(message, dict):
                    continue
                symbols = message.get("symbols")
                symbols = symbols if isinstance(symbols, list) else []
                if message.get("op") == "watch":
                    await hub.watch(client, symbols)
                elif message.get("op") == "watch_bars":  # intraday charts
                    await hub.watch_bars(client, symbols)
                elif message.get("op") == "watch_buzz":  # lists with a Volume Buzz column
                    await hub.watch_buzz(client, symbols)

        tasks = [asyncio.create_task(send()), asyncio.create_task(receive())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                error = task.exception()
                if error and not isinstance(error, WebSocketDisconnect | ValueError):
                    log.warning("Live socket ended: %s", error)
        finally:
            for task in tasks:
                task.cancel()
            await hub.detach(client)

    @app.get("/api/bars")
    async def bars(
        symbol: str, through: str | None = None, interval: str = "1D", count: int = CHART_BARS
    ) -> dict[str, Any]:
        provider = state.get("provider")
        through_date = date.fromisoformat(through) if through else None
        try:
            unit, multiple = parse_interval(interval)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        count = max(20, min(count, 5000))
        daily_count = daily_bars_needed(unit, multiple, count)
        qualified = await _qualify(provider, symbol)
        loaded: list[Bar] = []
        metadata: dict[str, Any] = {}
        if provider is not None:
            if hasattr(provider, "get_chart_bars"):
                loaded = await provider.get_chart_bars(qualified, daily_count, through_date)
            else:
                loaded = await provider.get_ohlcv(qualified, count=daily_count, as_of=through_date)
            metadata = (await provider.get_symbol_data_batch([qualified])).get(qualified, {})
        filler = state.get("filler")
        if not loaded and filler is not None and provider is not None:
            # Not filled yet: fetch this symbol's history now rather than wait for its turn.
            from momo_scan.live.base import SignInNeeded

            try:
                if await filler.ensure(qualified):
                    loaded = await provider.get_chart_bars(qualified, daily_count, through_date)
            except SignInNeeded as error:
                raise HTTPException(503, str(error)) from error
        if not loaded:
            loaded = storage().load_bars(qualified, limit=daily_count, as_of=through_date)
        if not loaded:
            raise HTTPException(404, f"No bars for {qualified}")
        market_cap = None
        if provider is not None and hasattr(provider, "get_market_cap"):
            market_cap = await provider.get_market_cap(qualified)
        shown = aggregate(loaded, unit, multiple)[-count:]
        return {
            "symbol": qualified,
            "interval": f"{multiple}{unit}",
            "company": metadata.get("description", ""),
            "industry": metadata.get("industry", ""),
            "sector": metadata.get("sector", ""),
            "market_cap": market_cap,
            "adr20": adr_percent(loaded) if len(loaded) >= 20 else None,
            "adv20": average_dollar_volume(loaded) if len(loaded) >= 20 else None,
            "bars": [_bar_payload(bar) for bar in shown],
            "last_day": _bar_payload(loaded[-1])["time"],  # live data merges after this day
        }

    @app.get("/api/symbols")
    async def symbols(q: str = "", limit: int = 20) -> dict[str, Any]:
        provider = state.get("provider")
        if provider is None or not hasattr(provider, "search_symbols"):
            return {"symbols": []}
        return {"symbols": await provider.search_symbols(q, max(1, min(limit, 50)))}

    # Last price and change for watchlist rows.
    @app.get("/api/quotes")
    async def quotes(symbols: str) -> dict[str, Any]:
        provider = state.get("provider")
        out: dict[str, Any] = {}
        for raw in [item for item in symbols.split(",") if item.strip()][:200]:
            qualified = await _qualify(provider, raw)
            loaded: list[Bar] = []
            if provider is not None and hasattr(provider, "get_chart_bars"):
                loaded = await provider.get_chart_bars(qualified, 21, None)
            elif provider is not None:
                loaded = await provider.get_ohlcv(qualified, count=21)
            if not loaded:
                continue
            last = loaded[-1]
            previous = loaded[-2].c if len(loaded) > 1 else last.o
            meta = {}
            if provider is not None and hasattr(provider, "get_symbol_data_batch"):
                meta = (await provider.get_symbol_data_batch([qualified])).get(qualified) or {}
            industry = meta.get("industry") or None
            out[raw] = {
                "industry": industry if industry != "Unknown" else None,
                "symbol": qualified,
                "last": last.c,
                "change": last.c - previous,
                "change_pct": (last.c / previous - 1) * 100,
                "volume": last.v,
                "date": _bar_payload(last)["time"],
                "adr20": adr_percent(loaded) if len(loaded) >= 20 else None,
            }
        return {"quotes": out}

    async def _qualify(provider: Any, symbol: str) -> str:
        text = symbol.strip().upper()
        if ":" in text or provider is None:
            return text
        found = (await provider.get_symbol_data_batch([text])).get(text)
        if not found or not found.get("exchange"):
            return text
        return f"{found['exchange']}:{text}"

    # Preferences that follow the user between devices. Only known keys, so the table stays tidy.
    @app.get("/api/settings/{key}")
    async def get_setting(key: str, request: Request) -> dict[str, Any]:
        if key not in SETTING_KEYS:
            raise HTTPException(404, f"Unknown setting {key}")
        return {"value": storage().load_setting(key, user(request))}

    @app.put("/api/settings/{key}")
    async def put_setting(key: str, request: Request) -> dict[str, bool]:
        require_header(request)
        if key not in SETTING_KEYS:
            raise HTTPException(404, f"Unknown setting {key}")
        body = await request.json()
        if not isinstance(body, dict) or len(json.dumps(body)) > SETTING_KEYS[key]:
            limit = SETTING_KEYS[key]
            raise HTTPException(400, f"Settings must be a JSON object under {limit} bytes")
        storage().save_setting(key, body, user(request))
        return {"saved": True}

    def found(ok: Any, what: str) -> dict[str, Any]:
        if not ok:
            raise HTTPException(404, f"No such {what}")
        return {"id": ok} if not isinstance(ok, bool) else {"saved": True}

    # Price alerts (momo_scan.alerts): checked on the server against live quotes, so they come
    # with live prices. Every change re-arms the watcher.
    def alerts() -> Alerts:
        return state["alerts"]

    def require_live(request: Request) -> None:
        if not account(request).sees_live:
            raise HTTPException(403, "Price alerts come with live prices")

    @app.get("/api/alerts")
    async def list_alerts(request: Request) -> dict[str, Any]:
        return {"alerts": alerts().list(user(request))}

    @app.post("/api/alerts")
    async def add_alert(body: AlertBody, request: Request) -> dict[str, Any]:
        require_header(request)
        require_live(request)
        if body.symbol is None or body.price is None:
            raise HTTPException(400, "An alert needs a symbol and a price")
        fields = body.model_dump(exclude_none=True, exclude={"status"})
        alert = alerts().add(user(request), **fields)
        await state["alert_watcher"].reload()
        return alert

    @app.put("/api/alerts/{alert_id}")
    async def update_alert(alert_id: int, body: AlertBody, request: Request) -> dict[str, Any]:
        require_header(request)
        require_live(request)
        alert = alerts().update(user(request), alert_id, body.model_dump(exclude_none=True))
        if alert is None:
            raise HTTPException(404, "No such alert")
        await state["alert_watcher"].reload()
        return alert

    @app.delete("/api/alerts/{alert_id}")
    async def delete_alert(alert_id: int, request: Request) -> dict[str, Any]:
        require_header(request)
        found(alerts().delete(user(request), alert_id), "alert")
        await state["alert_watcher"].reload()
        return {"saved": True}

    @app.delete("/api/alerts")
    async def clear_triggered_alerts(request: Request) -> dict[str, Any]:
        require_header(request)
        return {"removed": alerts().clear_triggered(user(request))}

    @app.post("/api/alerts/seen")
    async def alerts_seen(body: SeenBody, request: Request) -> dict[str, Any]:
        require_header(request)
        alerts().mark_seen(user(request), body.ids)
        return {"saved": True}

    @app.get("/api/themes")
    async def themes_view() -> dict[str, Any]:
        """Theme strength over 1W/1M/3M; recomputed when the newest session changes."""
        from momo_scan.theme_strength import theme_strength
        from momo_scan.themes import load_taxonomy

        provider = state.get("provider")
        if provider is None:
            raise HTTPException(503, "Market data unavailable")
        latest = await latest_session(provider)
        cached = state.get("themes")
        if not cached or cached[0] != latest:
            try:
                taxonomy = load_taxonomy(config.themes.path)
            except (OSError, ValueError) as error:  # the public edition ships no theme list
                raise HTTPException(404, "No theme list (config/themes.json)") from error
            cached = (latest, await theme_strength(provider, taxonomy, latest))
            state["themes"] = cached
        return cached[1]

    @app.get("/api/industries")
    async def industries_view() -> dict[str, Any]:
        """Industry strength from the screener's table; rebuilt when the newest session changes."""
        from momo_scan.theme_strength import industry_strength

        provider = state.get("provider")
        if provider is None or not hasattr(provider, "screen_universe"):
            raise HTTPException(503, "Market data unavailable")
        latest, rows = await screen_table()
        cached = state.get("industries")
        if not cached or cached[0] != latest:
            cached = (latest, industry_strength(rows))
            state["industries"] = cached
        return cached[1]

    @app.get("/api/fundamentals/{symbol}")
    async def fundamentals_view(
        symbol: str, asof: date | None = None, next_asof: date | None = None,
    ) -> dict[str, Any]:
        from momo_scan import fundamentals

        path = Path(config.storage.database).parent / "fundamentals.db"
        return await asyncio.to_thread(fundamentals.load, path, symbol, asof, next_asof)

    @app.get("/api/earnings")
    async def earnings_view(symbols: str = "", asof: date | None = None) -> dict[str, Any]:
        from momo_scan import fundamentals

        tickers = [symbol.strip() for symbol in symbols.split(",") if symbol.strip()]
        if len(tickers) > 500:
            raise HTTPException(400, "At most 500 symbols")
        path = Path(config.storage.database).parent / "fundamentals.db"
        return await asyncio.to_thread(fundamentals.earnings, path, tickers, asof)

    def cot_store() -> Path:
        """The local Commitments of Traders store. The weekly `momo cot-update` job fills it;
        only a store that has never been filled is bootstrapped from the CFTC here."""
        from momo_scan import cot

        path = Path(config.storage.database).parent / "cot.db"
        if cot.latest_date(path) is None:
            try:
                cot.update(path, datetime.now(UTC))
            except OSError as error:
                raise HTTPException(503, "CFTC data unavailable") from error
        return path

    @app.get("/api/cot")
    async def cot_overview() -> dict[str, Any]:
        """Where each trader group stands in each futures market (CFTC Commitments of Traders)."""
        from momo_scan import cot

        path = await asyncio.to_thread(cot_store)
        return await asyncio.to_thread(cot.overview, path)

    @app.get("/api/cot/{code}")
    async def cot_history(code: str) -> dict[str, Any]:
        from momo_scan import cot

        path = await asyncio.to_thread(cot_store)
        try:
            return await asyncio.to_thread(cot.history, path, code)
        except KeyError as error:
            raise HTTPException(404, "Unknown market") from error

    @app.get("/api/screen")
    async def screen_view(
        request: Request, filters: str = "[]", sort: str = "m1", dir: str = "desc",
        pin: str = "", pin_dir: str = "asc", etfs: bool = False, live: bool = False,
    ) -> dict[str, Any]:
        """The custom screener: every stock's readings, filtered. Nothing is saved. With `live`
        (owner only) the readings are first brought up to today by the market sweep."""
        from momo_scan.screener import FIELDS, clean_rules, screen, with_quotes

        provider = state.get("provider")
        if provider is None or not hasattr(provider, "screen_universe"):
            raise HTTPException(503, "Market data unavailable")
        try:
            rules = clean_rules(json.loads(filters))
        except ValueError as error:
            raise HTTPException(400, "filters must be JSON") from error
        latest, table = await screen_table()
        from momo_scan import fundamentals

        path = Path(config.storage.database).parent / "fundamentals.db"
        headlines = await asyncio.to_thread(fundamentals.screen_readings, path)
        keys = ("earnings_days", "eps_yoy_pct", "revenue_yoy_pct", "eps_annual_yoy_pct",
                "net_margin_pct", "eps_acceleration", "next_earnings")
        joined = []
        for row in table:
            ticker = row["symbol"].rsplit(":", 1)[-1].replace(".", "-")
            headline = headlines.get(ticker, {})
            joined.append({**row, **{key: headline.get(key) for key in keys}})
        table = joined
        sweep = state.get("sweep")
        sweeping = None
        if live:
            if sweep is None or not account(request).owner:
                raise HTTPException(403, "Live screening needs the owner and a feed that can sweep")
            sweep.want([
                row["symbol"].rsplit(":", 1)[-1] for row in table
                if (etfs or not row["etf"]) and row["dvol"] >= sweep.min_dvol
            ])
            await sweep.first(20)
            table = with_quotes(table, sweep.quotes)
            sweeping = {
                "symbols": len(sweep.symbols), "quotes": len(sweep.quotes),
                "requests": sweep.requests, "per_minute": sweep.per_minute,
                "seconds": sweep.seconds, "stamp": sweep.stamp, "error": sweep.error,
            }
        result = screen(table, rules, sort, dir != "asc", pin or None, pin_dir == "desc", etfs)
        funds = sum(row["etf"] for row in table)
        return {
            **result,
            "universe": len(table) - funds,
            "etfs": funds if etfs else 0,
            "as_of": latest.isoformat(),
            "can_sweep": sweep is not None and account(request).owner,
            "sweep": sweeping,
            "fields": FIELDS,
            "sectors": sorted({row["sector"] for row in table}),
        }

    if PRIVATE:
        from momo_scan.web import private

        private.add_routes(app, private.Context(
            config=config, config_path=config_path, scan_command=scan_command, state=state,
            storage=storage, user=user, require_header=require_header,
            require_owner=require_owner, found=found, bar_payload=_bar_payload,
        ))

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        filler = state.get("filler")
        return {
            "ok": True, "provider_error": state.get("provider_error"),
            "bars": filler and {**filler.store.progress(), "error": filler.error},
        }

    return app
