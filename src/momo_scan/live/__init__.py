"""Live market data: one upstream feed, shared by every open chart.

A provider (Schwab, a simulated feed for development, later others) turns a vendor's stream
into normalized `Quote`s. The `LiveHub` holds the one connection, subscribes to the union of
symbols anyone is viewing, keeps the latest quote per symbol and fans updates out to browser
sockets. Nothing above the provider knows which vendor is behind it. See docs/live-data.md.

    # data/live.toml (gitignored; restart momo-serve after editing)
    provider = "schwab"   # "none" (default), "sim" or "schwab"

    [schwab]              # from the Schwab developer portal
    client_id = "..."
    client_secret = "..."
    callback_url = "https://127.0.0.1:8182"
"""

from __future__ import annotations

import tomllib
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from momo_scan.live.base import LiveProvider, Quote
from momo_scan.live.hub import LiveClient, LiveHub

__all__ = ["LiveClient", "LiveHub", "LiveProvider", "Quote", "load_live_settings", "make_provider"]

PROVIDERS = {"none", "sim", "schwab"}


def load_live_settings(path: Path) -> dict[str, Any]:
    """`data/live.toml`, or no live data when it is missing."""
    if not path.exists():
        return {"provider": "none"}
    with path.open("rb") as handle:
        settings = tomllib.load(handle)
    name = str(settings.get("provider", "none")).strip().lower()
    if name not in PROVIDERS:
        choices = ", ".join(sorted(PROVIDERS))
        raise ValueError(f"Unknown live provider {name!r} in {path}: use one of {choices}")
    return {**settings, "provider": name}


def make_provider(
    settings: dict[str, Any],
    last_close: Callable[[str], Awaitable[float | None]],
    data_dir: Path,
) -> LiveProvider | None:
    """The configured provider. `last_close` seeds the simulated feed from the archive."""
    if settings["provider"] == "sim":
        from momo_scan.live.sim import SimulatedProvider

        return SimulatedProvider(last_close)
    if settings["provider"] == "schwab":
        from momo_scan.live.schwab import SchwabProvider

        return SchwabProvider(schwab_auth(settings, data_dir))
    return None


def schwab_auth(settings: dict[str, Any], data_dir: Path) -> Any:
    from momo_scan.live.schwab import SchwabAuth

    return SchwabAuth(settings, data_dir / "schwab_tokens.json")
