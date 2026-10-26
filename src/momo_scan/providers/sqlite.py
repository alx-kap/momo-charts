from __future__ import annotations

import sqlite3
from collections import defaultdict
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from momo_scan.config import ProviderConfig, RegimeConfig
from momo_scan.models import Bar

REQUIRED_COLUMNS = {
    "ohlcv": {"ticker", "date", "open", "high", "low", "close", "volume"},
    "mm_universe": {"ticker", "name", "exchange", "is_common_stock"},
    "sectors": {"ticker", "sector", "industry", "name", "exchange"},
    "market_monitor_daily": {"date", "data_through_date"},
    "mm_diagnostics": {"date", "universe_size", "valid_symbols", "warnings"},
}

NASDAQ_CODES = {"NASDAQ", "NASDAQ-G", "NASDAQ-Q", "NASDAQ-S", "NCM", "NGM", "NMS"}
NYSE_CODES = {"NYSE", "NYQ"}
AMEX_CODES = {"AMEX", "ASE"}
RawBar = tuple[int, float, float, float, float, float]


# Listed funds in the archive: mm_universe has no fund type, so these exclusion reasons (ETF/ETN,
# NYSE Arca and Cboe listings) stand in for "ETF". Big funds like SMH or IWM are only here once
# the market-data project adds them to mm_universe.
ETF_REASONS = ("etf_etn", "exchange-PCX", "exchange-BTS")

def _ticker(symbol: str) -> str:
    return symbol.rsplit(":", 1)[-1].upper()


def _exchange(value: str | None) -> str:
    code = (value or "").upper()
    if code in NASDAQ_CODES:
        return "NASDAQ"
    if code in NYSE_CODES:
        return "NYSE"
    if code in AMEX_CODES:
        return "AMEX"
    return code or "UNKNOWN"


def _symbol(ticker: str, exchange: str | None) -> str:
    return f"{_exchange(exchange)}:{ticker}"


def _timestamp(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=UTC).timestamp())




def _valid_bar(row: sqlite3.Row) -> bool:
    values = [row[key] for key in ("open", "high", "low", "close")]
    if any(value is None for value in values) or row["volume"] is None:
        return False
    open_, high, low, close = (float(value) for value in values)
    return (
        open_ > 0
        and high > 0
        and low > 0
        and close > 0
        and high >= max(open_, close)
        and low <= min(open_, close)
        and float(row["volume"]) >= 0
    )


class LocalSQLiteProvider:
    name = "local-sqlite"

    def __init__(self, config: ProviderConfig, regime: RegimeConfig):
        self.config = config
        self.regime = regime
        self.path = Path(config.database).expanduser()
        self.source = str(self.path.resolve())
        self.connection: sqlite3.Connection | None = None
        self._snapshot_date: date | None = None
        self._sessions: list[str] = []
        self._raw_by_ticker: dict[str, list[RawBar]] = {}
        self._metadata_by_ticker: dict[str, dict[str, Any]] = {}

    async def __aenter__(self) -> LocalSQLiteProvider:
        if not self.path.is_file():
            raise RuntimeError(f"Market database does not exist: {self.path}")
        uri = f"file:{quote(str(self.path.resolve()), safe='/')}?mode=ro"
        self.connection = sqlite3.connect(uri, uri=True)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA query_only=ON")
        self._validate_schema()
        return self

    async def __aexit__(self, *_: Any) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def _db(self) -> sqlite3.Connection:
        if self.connection is None:
            raise RuntimeError("LocalSQLiteProvider must be used as an async context manager")
        return self.connection

    def _validate_schema(self) -> None:
        connection = self._db()
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
            )
        }
        missing_tables = sorted(REQUIRED_COLUMNS.keys() - tables)
        if missing_tables:
            raise RuntimeError(f"Market database is missing tables: {', '.join(missing_tables)}")
        for table, required in REQUIRED_COLUMNS.items():
            columns = {
                str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")
            }
            missing = sorted(required - columns)
            if missing:
                raise RuntimeError(
                    f"Market database table {table} is missing columns: {', '.join(missing)}"
                )
        index_shapes = set()
        for index_row in connection.execute("PRAGMA index_list(ohlcv)"):
            columns = tuple(
                str(row[2])
                for row in connection.execute(f"PRAGMA index_info({index_row[1]})")
            )
            index_shapes.add(columns)
        if not any(columns[:2] == ("ticker", "date") for columns in index_shapes):
            raise RuntimeError("Market database needs an ohlcv (ticker, date) index")
        if not any(columns[:2] == ("date", "ticker") for columns in index_shapes):
            raise RuntimeError("Market database needs an ohlcv (date, ticker) index")

    def _validated_row(self, requested: date | None = None) -> sqlite3.Row:
        parameters: tuple[Any, ...] = ()
        date_filter = ""
        if requested is not None:
            date_filter = "AND monitor.date = ?"
            parameters = (requested.isoformat(),)
        row = self._db().execute(
            f"""
            SELECT monitor.date, monitor.data_through_date,
                   diagnostics.universe_size, diagnostics.valid_symbols,
                   diagnostics.warnings
            FROM market_monitor_daily AS monitor
            JOIN mm_diagnostics AS diagnostics ON diagnostics.date = monitor.date
            WHERE monitor.data_through_date = monitor.date
              AND COALESCE(TRIM(diagnostics.warnings), '') IN ('', '[]')
              {date_filter}
            ORDER BY monitor.date DESC
            LIMIT 1
            """,
            parameters,
        ).fetchone()
        if row is None:
            target = requested.isoformat() if requested else "latest"
            raise RuntimeError(f"No validated market-data session is available for {target}")
        coverage = int(row["valid_symbols"] or 0) / max(int(row["universe_size"] or 0), 1)
        if coverage < self.config.minimum_latest_coverage:
            raise RuntimeError(
                f"Market-data coverage for {row['date']} is {coverage:.1%}; "
                f"minimum is {self.config.minimum_latest_coverage:.1%}"
            )
        return row

    async def doctor(self) -> dict[str, Any]:
        row = self._validated_row()
        common = int(
            self._db()
            .execute("SELECT COUNT(*) FROM mm_universe WHERE is_common_stock=1")
            .fetchone()[0]
        )
        metadata = int(
            self._db()
            .execute(
                """
                SELECT COUNT(*) FROM mm_universe AS universe
                JOIN sectors USING(ticker)
                WHERE universe.is_common_stock=1
                  AND sectors.sector IS NOT NULL AND TRIM(sectors.sector) <> ''
                """
            )
            .fetchone()[0]
        )
        query_only = bool(self._db().execute("PRAGMA query_only").fetchone()[0])
        return {
            "connected": True,
            "mode": self.name,
            "source": self.source,
            "read_only": query_only,
            "latest_validated_session": row["date"],
            "session_coverage": round(
                int(row["valid_symbols"]) / max(int(row["universe_size"]), 1), 4
            ),
            "common_stocks": common,
            "sector_metadata_coverage": round(metadata / max(common, 1), 4),
            "required_indexes": True,
        }

    async def resolve_session(self, requested: date | None = None) -> date:
        return date.fromisoformat(str(self._validated_row(requested)["date"]))

    async def get_sessions(self, start: date, end: date) -> list[date]:
        rows = self._db().execute(
            """
            SELECT DISTINCT date FROM ohlcv
            WHERE ticker='SPY' AND date BETWEEN ? AND ?
            ORDER BY date
            """,
            (start.isoformat(), end.isoformat()),
        ).fetchall()
        return [date.fromisoformat(str(row[0])) for row in rows]

    def _load_snapshot(self, as_of: date) -> None:
        if self._snapshot_date == as_of:
            return
        limit = max(self.config.history_bars, 260)
        session_rows = self._db().execute(
            """
            SELECT date FROM ohlcv
            WHERE ticker='SPY' AND date <= ? ORDER BY date DESC LIMIT ?
            """,
            (as_of.isoformat(), limit),
        ).fetchall()
        sessions = sorted({str(row[0]) for row in session_rows})
        if not sessions or sessions[-1] != as_of.isoformat():
            raise RuntimeError(f"No OHLCV session exists for {as_of.isoformat()}")
        session_index = {session: index for index, session in enumerate(sessions)}
        cursor = self._db().execute(
            """
            SELECT prices.ticker, prices.date, prices.open, prices.high, prices.low,
                   prices.close, prices.volume
            FROM ohlcv AS prices
            JOIN mm_universe AS universe ON universe.ticker = prices.ticker
            WHERE universe.is_common_stock=1
              AND prices.date BETWEEN ? AND ?
            ORDER BY prices.ticker, prices.date
            """,
            (sessions[0], sessions[-1]),
        ).fetchall()
        raw_by_ticker: dict[str, list[RawBar]] = defaultdict(list)
        for row in cursor:
            if not _valid_bar(row):
                continue
            index = session_index.get(str(row["date"]))
            if index is None:
                continue
            raw_by_ticker[str(row["ticker"])].append(
                (
                    index,
                    float(row["open"]),
                    float(row["high"]),
                    float(row["low"]),
                    float(row["close"]),
                    float(row["volume"]),
                )
            )

        metadata: dict[str, dict[str, Any]] = {}
        metadata_cursor = self._db().execute(
            """
            SELECT universe.ticker, universe.exchange, universe.name,
                   universe.is_common_stock,
                   sectors.sector, sectors.industry, sectors.name AS sector_name,
                   sectors.exchange AS sector_exchange
            FROM mm_universe AS universe
            LEFT JOIN sectors ON sectors.ticker = universe.ticker
            WHERE universe.is_common_stock=1
            ORDER BY universe.ticker
            """
        )
        for row in metadata_cursor:
            ticker = str(row["ticker"])
            exchange = row["sector_exchange"] or row["exchange"]
            metadata[ticker] = {
                "ticker": ticker,
                "symbol": _symbol(ticker, exchange),
                "description": row["sector_name"] or row["name"] or ticker,
                "exchange": _exchange(exchange),
                "sector": row["sector"] or "Unknown",
                "industry": row["industry"] or "Unknown",
                "type": "stock",
                "is_common_stock": bool(row["is_common_stock"]),
            }
        self._snapshot_date = as_of
        self._sessions = sessions
        self._raw_by_ticker = dict(raw_by_ticker)
        self._metadata_by_ticker = metadata


    async def get_ohlcv(
        self, symbol: str, count: int = 300, as_of: date | None = None
    ) -> list[Bar]:
        if as_of is not None:
            self._load_snapshot(as_of)
        ticker = _ticker(symbol)
        cached = self._raw_by_ticker.get(ticker)
        if cached is not None:
            return [
                Bar(
                    t=_timestamp(self._sessions[item[0]]),
                    o=item[1],
                    h=item[2],
                    l=item[3],
                    c=item[4],
                    v=item[5],
                )
                for item in cached[-count:]
            ]
        return self._query_ohlcv(ticker, count, as_of)

    async def get_chart_bars(
        self, symbol: str, count: int, as_of: date | None = None
    ) -> list[Bar]:
        """Display bars straight from the archive, independent of the scan snapshot."""
        return self._query_ohlcv(_ticker(symbol), count, as_of)

    def _query_ohlcv(self, ticker: str, count: int, as_of: date | None) -> list[Bar]:
        parameters: list[Any] = [ticker]
        date_clause = ""
        if as_of is not None:
            date_clause = "AND date <= ?"
            parameters.append(as_of.isoformat())
        parameters.append(count)
        rows = self._db().execute(
            f"""
            SELECT ticker, date, open, high, low, close, volume
            FROM ohlcv WHERE ticker=? {date_clause}
            ORDER BY date DESC LIMIT ?
            """,
            parameters,
        ).fetchall()
        return [
            Bar(
                t=_timestamp(str(row["date"])),
                o=float(row["open"]),
                h=float(row["high"]),
                l=float(row["low"]),
                c=float(row["close"]),
                v=float(row["volume"]),
            )
            for row in reversed(rows)
            if _valid_bar(row)
        ]

    async def get_symbol_data_batch(
        self, symbols: list[str]
    ) -> dict[str, dict[str, Any]]:
        output: dict[str, dict[str, Any]] = {}
        missing: list[str] = []
        for symbol in symbols:
            metadata = self._metadata_by_ticker.get(_ticker(symbol))
            if metadata is None:
                missing.append(_ticker(symbol))
            else:
                output[symbol] = dict(metadata)
        if missing:
            placeholders = ",".join("?" for _ in missing)
            rows = self._db().execute(
                f"""
                SELECT universe.ticker, universe.name, universe.exchange,
                       universe.is_common_stock,
                       sectors.name AS sector_name, sectors.exchange AS sector_exchange,
                       sectors.sector, sectors.industry
                FROM mm_universe AS universe
                LEFT JOIN sectors USING(ticker)
                WHERE universe.ticker IN ({placeholders})
                """,
                missing,
            ).fetchall()
            by_ticker = {str(row["ticker"]): row for row in rows}
            for symbol in symbols:
                row = by_ticker.get(_ticker(symbol))
                if row is None:
                    continue
                exchange = row["sector_exchange"] or row["exchange"]
                output[symbol] = {
                    "description": row["sector_name"] or row["name"] or _ticker(symbol),
                    "exchange": _exchange(exchange),
                    "sector": row["sector"] or "Unknown",
                    "industry": row["industry"] or "Unknown",
                    "is_common_stock": bool(row["is_common_stock"]),
                }
        return output

    async def screen_universe(self, count: int) -> list[tuple[dict[str, Any], list[Bar]]]:
        """Every common stock and listed ETF/ETN with its last `count` sessions, for the
        screener. ETFs carry `etf: True`.

        Reads straight from the archive and leaves the scan snapshot alone.
        """
        sessions = [
            str(row[0])
            for row in self._db().execute(
                "SELECT date FROM ohlcv WHERE ticker='SPY' ORDER BY date DESC LIMIT ?", (count,)
            )
        ]
        if not sessions:
            return []
        rows = self._db().execute(
            """
            SELECT prices.ticker, prices.date, prices.open, prices.high, prices.low,
                   prices.close, prices.volume,
                   universe.exchange, universe.name, universe.is_common_stock,
                   sectors.sector, sectors.industry,
                   sectors.name AS sector_name, sectors.exchange AS sector_exchange
            FROM ohlcv AS prices
            JOIN mm_universe AS universe ON universe.ticker = prices.ticker
            LEFT JOIN sectors ON sectors.ticker = prices.ticker
            WHERE (universe.is_common_stock=1 OR universe.exclusion_reason IN ({ETF_REASONS}))
              AND prices.date >= ?
            ORDER BY prices.ticker, prices.date
            """.replace("{ETF_REASONS}", ", ".join(f"'{reason}'" for reason in ETF_REASONS)),
            (sessions[-1],),
        )
        stocks: dict[str, tuple[dict[str, Any], list[Bar]]] = {}
        for row in rows:
            if not _valid_bar(row):
                continue
            ticker = str(row["ticker"])
            if ticker not in stocks:
                exchange = row["sector_exchange"] or row["exchange"]
                etf = not row["is_common_stock"]
                meta = {
                    "ticker": ticker,
                    "symbol": _symbol(ticker, exchange),
                    "description": row["sector_name"] or row["name"] or ticker,
                    "sector": row["sector"] or ("ETF" if etf else "Unknown"),
                    "industry": row["industry"] or ("ETF" if etf else "Unknown"),
                    "etf": etf,
                }
                stocks[ticker] = (meta, [])
            stocks[ticker][1].append(
                Bar(
                    t=_timestamp(str(row["date"])),
                    o=float(row["open"]),
                    h=float(row["high"]),
                    l=float(row["low"]),
                    c=float(row["close"]),
                    v=float(row["volume"]),
                )
            )
        return list(stocks.values())

    async def search_symbols(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        """Symbols for the symbol search: exact ticker first, then ticker prefixes, then names."""

        text = query.strip().upper()
        if not text:
            return []
        rows = self._db().execute(
            """
            SELECT universe.ticker, universe.exchange, sectors.exchange AS sector_exchange,
                   COALESCE(sectors.name, universe.name) AS name, universe.is_common_stock
            FROM mm_universe AS universe
            LEFT JOIN sectors USING(ticker)
            WHERE universe.ticker LIKE ? OR UPPER(COALESCE(sectors.name, universe.name)) LIKE ?
            ORDER BY universe.ticker = ? DESC, universe.ticker LIKE ? DESC,
                     universe.is_common_stock DESC, LENGTH(universe.ticker), universe.ticker
            LIMIT ?
            """,
            (f"{text}%", f"%{text}%", text, f"{text}%", limit),
        ).fetchall()
        return [
            {
                "symbol": f"{_exchange(row['sector_exchange'] or row['exchange'])}:{row['ticker']}",
                "ticker": row["ticker"],
                "name": row["name"] or row["ticker"],
                "exchange": _exchange(row["sector_exchange"] or row["exchange"]),
            }
            for row in rows
        ]

    async def get_market_cap(self, symbol: str) -> float | None:
        """Display-only market capitalization; absent when the source has no value."""
        try:
            row = self._db().execute(
                "SELECT market_cap FROM sectors WHERE ticker=?", (_ticker(symbol),)
            ).fetchone()
        except sqlite3.OperationalError:
            return None
        if row is None or row["market_cap"] is None:
            return None
        return float(row["market_cap"])

