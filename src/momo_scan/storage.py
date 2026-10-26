from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from momo_scan.models import Bar

# The account that owns everything from before accounts existed: Alex.
OWNER = "owner"

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;


CREATE TABLE IF NOT EXISTS bars (
    symbol TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    PRIMARY KEY (symbol, timestamp)
);


-- App preferences that should follow the user between devices, e.g. chart styling.
CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT NOT NULL DEFAULT 'owner',
    key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_bars_symbol_time ON bars(symbol, timestamp);
"""


class Storage:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(SCHEMA)
        self._add_user_ids()

    def _add_user_ids(self) -> None:
        """Give rows from before accounts existed to the owner, keyed per user."""
        tables = {
            "settings": "key, updated_at, value_json",
        }
        for table, columns in tables.items():
            existing = {
                row["name"] for row in self.connection.execute(f"PRAGMA table_info({table})")
            }
            if "user_id" in existing:
                continue
            # The old table survives under a new name until its rows are copied. Rows are
            # copied as they are, so foreign keys aren't re-checked on the way.
            self.connection.execute(f"ALTER TABLE {table} RENAME TO {table}_old")
            self.connection.executescript(SCHEMA)  # turns foreign keys on, so switch after
            self.connection.execute("PRAGMA foreign_keys=OFF")
            try:
                with self.connection:
                    self.connection.execute(
                        f"INSERT INTO {table}(user_id, {columns}) "
                        f"SELECT '{OWNER}', {columns} FROM {table}_old"
                    )
                    self.connection.execute(f"DROP TABLE {table}_old")
            finally:
                self.connection.execute("PRAGMA foreign_keys=ON")


    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> Storage:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def save_bars(self, symbol: str, bars: Iterable[Bar]) -> None:
        self.connection.executemany(
            """
            INSERT INTO bars(symbol, timestamp, open, high, low, close, volume)
            VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, timestamp) DO UPDATE SET
                open=excluded.open, high=excluded.high, low=excluded.low,
                close=excluded.close, volume=excluded.volume
            """,
            [(symbol, bar.t, bar.o, bar.h, bar.l, bar.c, bar.v) for bar in bars],
        )
        self.connection.commit()

    def load_bars(self, symbol: str, limit: int = 300, as_of: date | None = None) -> list[Bar]:
        parameters: list[object] = [symbol]
        cutoff = ""
        if as_of is not None:
            cutoff = "AND timestamp <= ?"
            end = datetime.combine(as_of, datetime.max.time(), tzinfo=UTC)
            parameters.append(int(end.timestamp()))
        parameters.append(limit)
        rows = self.connection.execute(
            f"""
            SELECT timestamp, open, high, low, close, volume
            FROM bars WHERE symbol=? {cutoff} ORDER BY timestamp DESC LIMIT ?
            """,
            parameters,
        ).fetchall()
        return [
            Bar(
                t=row["timestamp"],
                o=row["open"],
                h=row["high"],
                l=row["low"],
                c=row["close"],
                v=row["volume"],
            )
            for row in reversed(rows)
        ]


    def save_setting(self, key: str, value: Any, user: str = OWNER) -> None:
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO settings(user_id, key, updated_at, value_json) VALUES(?, ?, ?, ?)
                ON CONFLICT(user_id, key) DO UPDATE SET
                    updated_at=excluded.updated_at, value_json=excluded.value_json
                """,
                (user, key, datetime.now(UTC).isoformat(), json.dumps(value)),
            )

    def load_setting(self, key: str, user: str = OWNER) -> Any:
        row = self.connection.execute(
            "SELECT value_json FROM settings WHERE user_id=? AND key=?", (user, key)
        ).fetchone()
        return json.loads(row["value_json"]) if row else None

