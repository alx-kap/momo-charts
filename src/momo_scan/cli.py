from __future__ import annotations

import asyncio
import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

import typer
from rich.console import Console

from momo_scan.config import AppConfig, load_config
from momo_scan.providers.fixture import FixtureProvider
from momo_scan.providers.sqlite import LocalSQLiteProvider
from momo_scan.storage import Storage

app = typer.Typer(
    help="momo: charts, watchlists and a screener for momentum traders.", no_args_is_help=True
)
console = Console()


def _settings(config_path: Path) -> tuple[AppConfig, Storage]:
    config = load_config(config_path)
    return config, Storage(config.storage.database)


def _provider(config: AppConfig, fixture: Path | None = None) -> Any:
    if fixture:
        return FixtureProvider(fixture)
    return LocalSQLiteProvider(config.provider, config.regime)


@app.command()
def doctor(
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
    fixture: Annotated[Path | None, typer.Option("--fixture")] = None,
) -> None:
    """Check local storage and the read-only market database."""

    async def execute() -> None:
        config, storage = _settings(config_path)
        storage.close()
        async with _provider(config, fixture) as provider:
            result = await provider.doctor()
        result["config_hash"] = config.config_hash
        result["state_database"] = config.storage.database
        console.print_json(json.dumps(result))

    asyncio.run(execute())


@app.command()
def serve(
    host: Annotated[str, typer.Option("--host")] = "127.0.0.1",
    port: Annotated[int, typer.Option("--port")] = 8790,
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
    live: Annotated[
        str | None, typer.Option("--live", help="Live feed, overriding data/live.toml: none, sim")
    ] = None,
) -> None:
    """Serve the app (loopback by default)."""
    import uvicorn

    from momo_scan.config import load_config
    from momo_scan.web.server import create_app

    app_ = create_app(load_config(config_path), config_path, live_name=live)
    uvicorn.run(app_, host=host, port=port)


@app.command("schwab-login")
def schwab_login(
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
) -> None:
    """Sign in to Schwab for live prices (every 7 days). Also in the app: the live badge."""
    from momo_scan.live import load_live_settings, schwab_auth

    config = load_config(config_path)
    data_dir = Path(config.storage.database).parent
    auth = schwab_auth(load_live_settings(data_dir / "live.toml"), data_dir)
    typer.echo("1. Open this, sign in to Schwab and approve:\n")
    typer.echo(f"   {auth.authorize_url()}\n")
    typer.echo("2. Your browser lands on a page that doesn't load. Copy its whole address.")
    redirected = typer.prompt("3. Paste it here (within 30 seconds)")
    try:
        asyncio.run(auth.sign_in(redirected))
    except (ValueError, RuntimeError) as error:
        typer.echo(f"Sign-in failed: {error}", err=True)
        raise typer.Exit(1) from error
    typer.echo("Signed in for 7 days. Restart momo-serve if it's running on Schwab.")


@app.command("bars-update")
def bars_update(
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
    limit: Annotated[int, typer.Option("--limit", help="Symbols to backfill this run")] = 100,
) -> None:
    """Fill momo's own daily bars from Schwab (`fill = "schwab"`). `momo serve` does this by
    itself; this is for a first fill or a check without the server. Don't run both at once:
    each keeps to Schwab's request limit alone."""
    from momo_scan.bars import BarFiller, BarStore, schwab_feed
    from momo_scan.live import load_live_settings, make_provider

    config = load_config(config_path)
    if config.provider.fill != "schwab":
        typer.echo('Set fill = "schwab" under [provider] first.', err=True)
        raise typer.Exit(1)
    data_dir = Path(config.storage.database).parent
    settings = load_live_settings(data_dir / "live.toml") | {"provider": "schwab"}

    async def no_close(_: str) -> None:
        return None

    async def execute() -> None:
        store = BarStore(Path(config.provider.database))
        filler = BarFiller(store, *schwab_feed(make_provider(settings, no_close, data_dir)))
        try:
            await filler.round(batch=limit)
            typer.echo(json.dumps(store.progress()))
        finally:
            store.close()

    asyncio.run(execute())


@app.command("fundamentals-update")
def fundamentals_update(
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
) -> None:
    """Update SEC facts and the upcoming earnings calendar in the local store."""
    import sqlite3
    import zipfile

    from momo_scan import fundamentals

    config = load_config(config_path)
    path = Path(config.storage.database).parent / "fundamentals.db"
    try:
        report = fundamentals.update(
            path, Path(config.provider.database), datetime.now(UTC), config.fundamentals.user_agent,
        )
        typer.echo(f"Fundamentals: {report}")
    except (OSError, RuntimeError, ValueError, sqlite3.Error, zipfile.BadZipFile) as error:
        typer.echo(f"Fundamentals update failed: {error}", err=True)
        raise typer.Exit(1) from error


@app.command("cot-update")
def cot_update(
    wait: Annotated[int, typer.Option("--wait", help="Minutes to keep checking")] = 0,
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
) -> None:
    """Bring the Commitments of Traders store up to date (a no-op unless a report is due)."""
    from momo_scan import cot

    config = load_config(config_path)
    path = Path(config.storage.database).parent / "cot.db"
    try:
        typer.echo(f"COT: {cot.update(path, datetime.now(UTC), wait)}")
    except (OSError, RuntimeError) as error:
        typer.echo(f"COT update failed: {error}", err=True)
        raise typer.Exit(1) from error


# Alex's scan, evaluation, practice, review and playbook commands (cli_private.py). The public
# edition leaves that module out; importing it registers its commands on `app`.
if importlib.util.find_spec("momo_scan.cli_private") is not None:
    import momo_scan.cli_private  # noqa: E402, F401


if __name__ == "__main__":
    app()
