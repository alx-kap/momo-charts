from __future__ import annotations

import asyncio
import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

import typer
from rich.console import Console
from rich.table import Table

from momo_scan.config import AppConfig, load_config
from momo_scan.providers.fixture import FixtureProvider
from momo_scan.providers.sqlite import LocalSQLiteProvider
from momo_scan.storage import OWNER, Storage

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


script_app = typer.Typer(
    help="Check, run and store momo script indicators.", no_args_is_help=True
)
app.add_typer(script_app, name="script")


def _read_script(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        typer.echo(f"Can't read {path}: {error}", err=True)
        raise typer.Exit(2) from error


def _print_script_errors(path: Path, errors: list[dict[str, Any]]) -> None:
    from momo_scan.script.lexer import from_utf16

    for error in errors:
        typer.echo(
            f"{path}:{error['line']}:{error['col']}: {error['code']} {from_utf16(error['message'])}"
        )
        if error.get("fix"):
            typer.echo(f"    {from_utf16(error['fix'])}")


@script_app.command("check")
def script_check(
    file: Annotated[Path, typer.Argument(help="A .momo script")],
    as_json: Annotated[bool, typer.Option("--json", help="Print the result as JSON")] = False,
) -> None:
    """Check a script: every error with its code, position and fix; exit 1 if there are any."""
    from momo_scan.script.compile import check_source

    result = check_source(_read_script(file))
    if as_json:
        shown = {"ok": True, "meta": result["meta"]} if result["ok"] else result
        typer.echo(json.dumps(shown, indent=2, default=str))
    elif result["ok"]:
        from momo_scan.script.lexer import from_utf16

        meta = result["meta"]
        parts = [
            f"{len(meta['inputs'])} inputs", f"{len(meta['plots'])} plots",
            f"{len(meta['signals'])} signals",
            f"needs {int(meta['needs']['history'])} bars of history",
        ]
        typer.echo(f"OK: {from_utf16(meta['title'])} ({', '.join(parts)})")
    else:
        _print_script_errors(file, result["errors"])
    if not result["ok"]:
        raise typer.Exit(1)


def _script_value(value: Any) -> str:
    if isinstance(value, bool):
        return "yes" if value else "no"
    if value is None or value != value:
        return "na"
    if isinstance(value, int) or float(value).is_integer() and abs(value) < 1e15:
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")


def _script_inputs(settings: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for item in settings:
        key, _, text = item.partition("=")
        if not key or not _:
            raise typer.BadParameter(f"{item!r}: write NAME=VALUE, like length=50")
        lowered = text.strip().lower()
        if lowered in ("true", "false"):
            out[key] = lowered == "true"
            continue
        try:
            out[key] = float(text)
        except ValueError:
            out[key] = text
    return out


def _stored_script(scripts: Any, name: str) -> dict[str, Any]:
    script = scripts.by_name(OWNER, name)
    if script is None:
        typer.echo(f"No script called {name}", err=True)
        raise typer.Exit(1)
    return script


def _report_saved(path: Path | None, script: dict[str, Any]) -> None:
    """One line for the save, then the script's errors; a script with errors exits 1."""
    if script.get("saved", True):
        typer.echo(f"Saved {script['name']} v{script['head']}")
    else:
        typer.echo(f"No change: {script['name']} is still v{script['head']}")
    if script["errors"]:
        count = len(script["errors"])
        typer.echo(f"Saved with {count} error{'s' * (count > 1)}, charts will show it:", err=True)
        _print_script_errors(path or Path(script["name"]), script["errors"])
        raise typer.Exit(1)


@script_app.command("save")
def script_save(
    file: Annotated[Path, typer.Argument(help="A .momo script")],
    name: Annotated[str, typer.Option("--name", help="The script's name in momo")],
    note: Annotated[str, typer.Option("--note", help="What changed")] = "",
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
) -> None:
    """Save a file as a new version of a stored script, creating the script if it's new."""
    from momo_scan.scripts import ScriptRefused, Scripts

    source = _read_script(file)
    _, storage = _settings(config_path)
    with storage:
        scripts = Scripts(storage)
        stored = scripts.by_name(OWNER, name)
        try:
            script = (
                scripts.save(OWNER, stored["id"], source, note) if stored
                else scripts.create(OWNER, name, source, note)
            )
        except ScriptRefused as error:
            typer.echo(error.message, err=True)
            raise typer.Exit(1) from error
    _report_saved(file, script)


@script_app.command("list")
def script_list(
    trash: Annotated[bool, typer.Option("--trash", help="Show the trash too")] = False,
    as_json: Annotated[bool, typer.Option("--json", help="Print the result as JSON")] = False,
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
) -> None:
    """List the stored scripts."""
    from momo_scan.scripts import Scripts

    _, storage = _settings(config_path)
    with storage:
        rows = Scripts(storage).list(OWNER, trash=trash)
    if as_json:
        typer.echo(json.dumps(rows, indent=2))
        return
    for row in rows:
        marks = [
            *(["draft"] if row["has_draft"] else []),
            *([f"{row['errors']} errors"] if row["errors"] else []),
            *(["in trash"] if row["in_trash"] else []),
        ]
        extra = f"  ({', '.join(marks)})" if marks else ""
        typer.echo(f"{row['name']}  v{row['head']}  {row['updated_at']}{extra}")


@script_app.command("versions")
def script_versions(
    name: Annotated[str, typer.Argument(help="The script's name in momo")],
    as_json: Annotated[bool, typer.Option("--json", help="Print the result as JSON")] = False,
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
) -> None:
    """Show a stored script's versions, newest first."""
    from momo_scan.scripts import Scripts

    _, storage = _settings(config_path)
    with storage:
        scripts = Scripts(storage)
        rows = scripts.versions(OWNER, _stored_script(scripts, name)["id"]) or []
    if as_json:
        typer.echo(json.dumps(rows, indent=2))
        return
    for row in rows:
        note = f"  {row['note']}" if row["note"] else ""
        typer.echo(f"v{row['version']}  {row['created_at']}  {row['size']} bytes{note}")


@script_app.command("restore")
def script_restore(
    name: Annotated[str, typer.Argument(help="The script's name in momo")],
    version: Annotated[int, typer.Argument(help="The version to go back to")],
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
) -> None:
    """Go back to a version, saved as a new version; history stays as it was."""
    from momo_scan.scripts import ScriptRefused, Scripts

    _, storage = _settings(config_path)
    with storage:
        scripts = Scripts(storage)
        try:
            script = scripts.restore(OWNER, _stored_script(scripts, name)["id"], version)
        except ScriptRefused as error:
            typer.echo(error.message, err=True)
            raise typer.Exit(1) from error
    if script is None:
        typer.echo(f"{name} has no v{version}", err=True)
        raise typer.Exit(1)
    _report_saved(None, script)


@script_app.command("run")
def script_run(
    file: Annotated[Path, typer.Argument(help="A .momo script")],
    symbol: Annotated[str, typer.Option("--symbol", help="Ticker, like NVDA")],
    interval: Annotated[str, typer.Option("--interval", help="D, W, M, or 5m, 15m, 1h")] = "D",
    last: Annotated[int, typer.Option("--last", help="How many of the latest bars to show")] = 5,
    bars: Annotated[int, typer.Option("--bars", help="Bars to run the script over")] = 520,
    setting: Annotated[
        list[str] | None, typer.Option("--input", help="An input, NAME=VALUE (repeat)")
    ] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Print the result as JSON")] = False,
    config_path: Annotated[Path, typer.Option("--config")] = Path("config/momo.toml"),
) -> None:
    """Run a script on a symbol and print the last values of every plot, signal and value."""
    from momo_scan.script.compile import check_source
    from momo_scan.script.evaluator import run_script
    from momo_scan.script.lexer import from_utf16

    source = _read_script(file)
    compiled = check_source(source)
    if not compiled["ok"]:
        _print_script_errors(file, compiled["errors"])
        raise typer.Exit(1)
    config = load_config(config_path)
    try:
        columns, labels, shown = asyncio.run(_script_bars(config, symbol, interval, bars))
    except ValueError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(1) from error
    extra = {"chart": {"interval": interval, "ticker": shown}}
    out = run_script(compiled["ir"], columns, _script_inputs(setting or []), extra)
    if not out["ok"]:
        error = out["error"]
        typer.echo(
            f"{file}:{error['line']}:{error['col']}: {error['code']} "
            f"{from_utf16(error['message'])} (bar {error['i']})", err=True,
        )
        raise typer.Exit(1)
    count = max(1, min(last, len(labels)))
    series: dict[str, list[Any]] = {
        key: plot["values"] for key, plot in out["plots"].items() if plot["values"]
    }
    series.update(out["signals"])
    kinds = {item["name"]: item["kind"] for item in compiled["meta"]["signals"]}
    if as_json:
        rows = [
            {"time": labels[i], **{
                key: (bool(values[i]) if kinds.get(key) == "bool" else
                      None if values[i] != values[i] else values[i])
                for key, values in series.items()
            }}
            for i in range(len(labels) - count, len(labels))
        ]
        typer.echo(json.dumps({
            "symbol": shown, "interval": interval, "bars": len(labels), "rows": rows,
            "stats": out["stats"], "levels": out["levels"],
            "logs": out["logs"][-20:], "ms": round(out["ms"], 1),
        }, indent=2, default=str))
        return
    table = Table(title=f"{from_utf16(compiled['meta']['title'])}: {shown} {interval}")
    table.add_column("time")
    for key in series:
        table.add_column(key, justify="right")
    for i in range(len(labels) - count, len(labels)):
        table.add_row(labels[i], *[
            _script_value(bool(values[i]) if kinds.get(key) == "bool" else values[i])
            for key, values in series.items()
        ])
    console.print(table)
    for stat in out["stats"]:
        typer.echo(f"{from_utf16(stat['title'])}: {_script_value(stat['value'])}")
    for level in out["levels"]:
        typer.echo(f"level {from_utf16(level['title'])}: {_script_value(level['price'])}")
    for line in out["logs"][-10:]:
        typer.echo(f"log bar {line['i']}: {from_utf16(line['text'])}")
    typer.echo(f"{len(labels)} bars, ran in {out['ms']:.0f} ms")


async def _script_bars(
    config: AppConfig, symbol: str, interval: str, count: int
) -> tuple[dict[str, list[float]], list[str], str]:
    """The bars a chart of this symbol and interval would show, as the script's columns."""
    from zoneinfo import ZoneInfo

    from momo_scan.intraday import INTERVALS, IntradayStore
    from momo_scan.intraday import aggregate as aggregate_rows
    from momo_scan.web.timeframes import aggregate, daily_bars_needed, parse_interval

    ticker = symbol.strip().upper().split(":")[-1]
    count = max(20, min(count, 5000))
    if interval in INTERVALS:
        path = Path(config.storage.database).parent / "intraday.db"
        minutes, multiple = INTERVALS[interval]
        if not path.exists():
            raise ValueError(f"No intraday store at {path}: intraday bars come from the app.")
        store = IntradayStore(path)
        try:
            rows = store.read(ticker, minutes, limit=count * multiple + 400)
            if minutes == 5:
                rows = aggregate_rows(rows, minutes * multiple)
        finally:
            store.close()
        rows = rows[-count:]
        if not rows:
            raise ValueError(f"No stored {interval} bars for {ticker}.")
        zone = ZoneInfo("America/New_York")
        # Scripts see New York wall-clock seconds (docs/scripting.md, "Contracts").
        wall = [
            int(datetime.fromtimestamp(t, UTC).astimezone(zone).replace(tzinfo=UTC).timestamp())
            for t, *_ in rows
        ]
        labels = [datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%d %H:%M") for t in wall]
        columns = {"time": [float(t) for t in wall]}
        for k, name in enumerate(("open", "high", "low", "close", "volume"), 1):
            columns[name] = [float(row[k]) for row in rows]
        return columns, labels, ticker
    try:
        unit, multiple = parse_interval(interval)
    except ValueError as error:
        raise ValueError(f"{error}; intraday: {', '.join(INTERVALS)}") from error
    async with LocalSQLiteProvider(config.provider, config.regime) as provider:
        found = (await provider.get_symbol_data_batch([ticker])).get(ticker)
        qualified = f"{found['exchange']}:{ticker}" if found and found.get("exchange") else ticker
        loaded = await provider.get_chart_bars(qualified, daily_bars_needed(unit, multiple, count))
    if not loaded:
        raise ValueError(f"No bars for {qualified}")
    shown = aggregate(loaded, unit, multiple)[-count:]
    labels = [datetime.fromtimestamp(bar.t, UTC).date().isoformat() for bar in shown]
    columns = {
        "time": [float(bar.t) for bar in shown], "open": [bar.o for bar in shown],
        "high": [bar.h for bar in shown], "low": [bar.l for bar in shown],
        "close": [bar.c for bar in shown], "volume": [bar.v for bar in shown],
    }
    return columns, labels, qualified.split(":")[-1]


# Alex's scan, evaluation, practice, review and playbook commands (cli_private.py). The public
# edition leaves that module out; importing it registers its commands on `app`.
if importlib.util.find_spec("momo_scan.cli_private") is not None:
    import momo_scan.cli_private  # noqa: E402, F401


if __name__ == "__main__":
    app()
