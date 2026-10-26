from __future__ import annotations

import sqlite3
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from momo_scan.config import ProviderConfig, RegimeConfig
from momo_scan.providers.sqlite import LocalSQLiteProvider


def _market_database(path: Path) -> date:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE ohlcv (
            ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL, high REAL,
            low REAL, close REAL, volume INTEGER, PRIMARY KEY(ticker, date)
        );
        CREATE INDEX idx_date_ticker ON ohlcv(date, ticker);
        CREATE TABLE mm_universe (
            ticker TEXT PRIMARY KEY, name TEXT, exchange TEXT,
            is_common_stock INTEGER NOT NULL
        );
        CREATE TABLE sectors (
            ticker TEXT PRIMARY KEY, sector TEXT, industry TEXT, name TEXT, exchange TEXT
        );
        CREATE TABLE market_monitor_daily (date TEXT PRIMARY KEY, data_through_date TEXT);
        CREATE TABLE mm_diagnostics (
            date TEXT PRIMARY KEY, universe_size INTEGER, valid_symbols INTEGER, warnings TEXT
        );
        """
    )
    connection.executemany(
        "INSERT INTO mm_universe VALUES(?,?,?,1)",
        [("AAA", "Alpha", "NASDAQ-Q"), ("BBB", "Beta", "NYSE")],
    )
    connection.executemany(
        "INSERT INTO sectors VALUES(?,?,?,?,?)",
        [
            ("AAA", "Technology", "Software", "Alpha Inc", "NMS"),
            ("BBB", "Industrials", "Machinery", "Beta Inc", "NYQ"),
        ],
    )
    start = date(2026, 1, 1)
    rows = []
    for index in range(151):
        session = start + timedelta(days=index)
        for ticker, growth, base in (
            ("AAA", 0.012, 20.0),
            ("BBB", 0.002, 30.0),
            ("SPY", 0.003, 100.0),
            ("QQQ", 0.004, 120.0),
        ):
            close = base * ((1.0 + growth) ** index)
            rows.append(
                (
                    ticker,
                    session.isoformat(),
                    close * 0.995,
                    close * 1.02,
                    close * 0.98,
                    close,
                    2_000_000,
                )
            )
    connection.executemany("INSERT INTO ohlcv VALUES(?,?,?,?,?,?,?)", rows)
    target = start + timedelta(days=149)
    connection.execute(
        "INSERT INTO market_monitor_daily VALUES(?,?)",
        (target.isoformat(), target.isoformat()),
    )
    connection.execute(
        "INSERT INTO mm_diagnostics VALUES(?,?,?,?)",
        (target.isoformat(), 2, 2, ""),
    )
    connection.commit()
    connection.close()
    return target


@pytest.mark.asyncio
async def test_local_provider_is_read_only_ranked_and_session_bounded(tmp_path: Path) -> None:
    database = tmp_path / "market.db"
    target = _market_database(database)
    config = ProviderConfig(database=str(database), history_bars=140)
    async with LocalSQLiteProvider(config, RegimeConfig()) as provider:
        doctor = await provider.doctor()
        assert doctor["read_only"] is True
        assert doctor["latest_validated_session"] == target.isoformat()
        assert await provider.resolve_session() == target
        sessions = await provider.get_sessions(target - timedelta(days=2), target)
        assert sessions == [
            target - timedelta(days=2),
            target - timedelta(days=1),
            target,
        ]


        bars = await provider.get_ohlcv("NASDAQ:AAA", count=140, as_of=target)
        assert len(bars) == 140
        assert datetime.fromtimestamp(bars[-1].t, tz=UTC).date() == target
        metadata = await provider.get_symbol_data_batch(["NASDAQ:AAA"])
        assert metadata["NASDAQ:AAA"]["industry"] == "Software"

        assert provider.connection is not None
        with pytest.raises(sqlite3.OperationalError):
            provider.connection.execute("INSERT INTO mm_universe VALUES('ZZZ','Zed','NYSE',1)")


@pytest.mark.asyncio
async def test_explicit_unvalidated_session_fails(tmp_path: Path) -> None:
    database = tmp_path / "market.db"
    target = _market_database(database)
    config = ProviderConfig(database=str(database))
    async with LocalSQLiteProvider(config, RegimeConfig()) as provider:
        with pytest.raises(RuntimeError, match="No validated"):
            await provider.resolve_session(target + timedelta(days=1))
