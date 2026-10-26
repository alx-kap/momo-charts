"""SEC facts and earnings in a rebuildable store. Only ``update`` uses the network.

Keep the original filing versions, not just today's answers. Reads select a filing vintage
before deriving quarters and growth. EPS uses the same split basis as the archived prices.
Bulk downloads live in temporary files; only one company's JSON is decoded at a time.
"""

from __future__ import annotations

import fcntl
import json
import math
import re
import sqlite3
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from bisect import bisect_left, bisect_right
from collections import defaultdict
from collections.abc import Iterator
from contextlib import closing, contextmanager, nullcontext
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

from momo_scan.sessions import sessions_between

EASTERN = ZoneInfo("America/New_York")
SEC = "https://www.sec.gov"
DATA = "https://data.sec.gov"
TICKERS = f"{SEC}/files/company_tickers.json"
FACTS_ZIP = f"{SEC}/Archives/edgar/daily-index/xbrl/companyfacts.zip"
SUBMISSIONS_ZIP = f"{SEC}/Archives/edgar/daily-index/bulkdata/submissions.zip"
DEFAULT_AGENT = "momo-scan admin@momo-scan.local"
CONCEPTS = {
    "eps": ("EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"),
    "revenue": (
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax", "Revenues",
        "SalesRevenueNet", "SalesRevenueGoodsNet", "SalesRevenueServicesNet",
    ),
    "net_income": (
        "NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic",
    ),
    "gross_profit": ("GrossProfit",),
    "shares": ("CommonStockSharesOutstanding", "EntityCommonStockSharesOutstanding"),
}
FORMS = {"10-K", "10-K/A", "10-Q", "10-Q/A"}


def _ticker(symbol: str) -> str:
    return symbol.rsplit(":", 1)[-1].strip().upper().replace(".", "-")


def _readonly(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(f"file:{quote(str(path.resolve()), safe='/')}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS companies (
            ticker TEXT PRIMARY KEY, cik INTEGER NOT NULL, quarterly INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS companies_cik ON companies(cik);
        CREATE TABLE IF NOT EXISTS excluded (ticker TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS facts (
            cik INTEGER, metric TEXT, start TEXT, end TEXT, filed TEXT, accession TEXT,
            concept TEXT, value REAL,
            PRIMARY KEY(cik, metric, start, end, filed, accession, concept)
        );
        CREATE INDEX IF NOT EXISTS facts_company ON facts(cik, filed);
        CREATE TABLE IF NOT EXISTS events (
            ticker TEXT, date TEXT, timing TEXT, source TEXT, known TEXT, accession TEXT,
            eps_estimate REAL, active INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY(ticker, date, source, known, accession)
        );
        CREATE INDEX IF NOT EXISTS events_company ON events(ticker, known);
        CREATE INDEX IF NOT EXISTS events_accession ON events(accession);
        CREATE TABLE IF NOT EXISTS filings (accession TEXT PRIMARY KEY, cik INTEGER, filed TEXT);
        CREATE TABLE IF NOT EXISTS splits (
            ticker TEXT, date TEXT, ratio REAL, PRIMARY KEY(ticker, date)
        );
        CREATE TABLE IF NOT EXISTS reactions (
            ticker TEXT, date TEXT, timing TEXT, reaction_date TEXT, gap_pct REAL,
            day_pct REAL, gap_adr REAL, day_adr REAL, change_5_pct REAL, date_5 TEXT,
            PRIMARY KEY(ticker, date, timing)
        );
        CREATE TABLE IF NOT EXISTS summaries (ticker TEXT PRIMARY KEY, asof TEXT, payload TEXT);
        CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    return db


def _get(db: sqlite3.Connection, key: str) -> str | None:
    row = db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
    return row[0] if row else None


def _set(db: sqlite3.Connection, key: str, value: str) -> None:
    db.execute("INSERT OR REPLACE INTO state VALUES (?,?)", (key, value))


def save_facts(db: sqlite3.Connection, cik: int, payload: dict[str, Any]) -> int:
    """Retain each filing's values, including old versions later restated by the issuer."""
    facts = payload.get("facts", {})
    gaap = facts.get("us-gaap", {})
    values = []
    quarterly = False
    for metric, concepts in CONCEPTS.items():
        unit = "USD/shares" if metric == "eps" else "shares" if metric == "shares" else "USD"
        for concept in concepts:
            node = gaap.get(concept, facts.get("dei", {}).get(concept, {}))
            for row in node.get("units", {}).get(unit, []):
                if (row.get("form") not in FORMS | {"8-K", "8-K/A"}
                        or not row.get("filed") or not row.get("end")):
                    continue
                value = row.get("val")
                if not isinstance(value, (int, float)) or not math.isfinite(value):
                    continue
                start = row.get("start", "")
                if metric != "shares":
                    if not start:
                        continue
                    days = (date.fromisoformat(row["end"]) - date.fromisoformat(start)).days + 1
                    if not 65 <= days <= 385:
                        continue
                    quarterly |= row["form"].startswith("10-Q") and days <= 110
                values.append((cik, metric, start, row["end"], row["filed"],
                               row.get("accn", ""), concept, value))
    db.executemany("INSERT OR REPLACE INTO facts VALUES (?,?,?,?,?,?,?,?)", values)
    db.execute("UPDATE companies SET quarterly=? WHERE cik=?", (int(quarterly), cik))
    return len(values)


def _timing(value: str) -> tuple[str | None, str]:
    if not value:
        return None, "unknown"
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=EASTERN)
    local = stamp.astimezone(EASTERN)
    minute = local.hour * 60 + local.minute
    timing = "before_open" if minute < 570 else "after_close" if minute >= 960 else "unknown"
    return local.date().isoformat(), timing


def save_submissions(
    db: sqlite3.Connection, cik: int, payload: dict[str, Any],
) -> None:
    """Accept both the main submissions object and an older, columnar history shard."""
    recent = payload.get("filings", {}).get("recent", payload)
    tickers = [r[0] for r in db.execute("SELECT ticker FROM companies WHERE cik=?", (cik,))]
    for i, form in enumerate(recent.get("form", [])):
        def at(key: str, index: int = i) -> str:
            items = recent.get(key, [])
            return str(items[index] or "") if index < len(items) else ""

        accession, filed = at("accessionNumber"), at("filingDate")
        if not accession or not filed:
            continue
        db.execute("INSERT OR IGNORE INTO filings VALUES (?,?,?)", (accession, cik, filed))
        if form not in {"8-K", "8-K/A"} or "2.02" not in re.split(r"[,;\s]+", at("items")):
            continue
        event_date, timing = _timing(at("acceptanceDateTime"))
        event_date = event_date or filed
        for ticker in tickers:
            db.execute("INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?,?,1)",
                       (ticker, event_date, timing, "edgar", filed, accession, None))


def _eps_value(
    row: dict[str, Any], splits: list[dict[str, Any]], versions: list[dict[str, Any]],
) -> float:
    # A comparative EPS filed after a split is already restated. Older vintages still need
    # the subsequent splits so historical as-of views match today's adjusted daily bars.
    factor = 1.0
    for split in splits:
        if split["date"] <= row["end"]:
            continue
        if split["date"] > row["filed"]:
            factor *= split["ratio"]
            continue
        before = [v for v in versions if v["metric"] == "eps" and v["start"] == row["start"]
                  and v["end"] == row["end"] and v["filed"] < split["date"]]
        if before:
            reference = max(before, key=lambda v: (v["filed"], v["accession"]))
            later = math.prod(s["ratio"] for s in splits
                              if split["date"] < s["date"] <= row["filed"])
            # Some comparative filings repeat the original EPS. Recognise that unchanged
            # basis rather than treating every post-split filing as a split restatement.
            if math.isclose(row["value"] * later, reference["value"], rel_tol=.01, abs_tol=.005):
                factor *= split["ratio"]
    return row["value"] / factor


def _periods(
    rows: list[dict[str, Any]], splits: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    best: dict[tuple[str, str, str], dict[str, Any]] = {}
    eps_versions: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["metric"] == "eps":
            eps_versions[row["start"], row["end"]].append(row)
        key = row["metric"], row["start"], row["end"]
        rank = (row["filed"], row["accession"], -CONCEPTS[row["metric"]].index(row["concept"]))
        if key not in best or rank > best[key]["rank"]:
            best[key] = {**row, "rank": rank}
    durations: dict[str, list[dict[str, Any]]] = defaultdict(list)
    shares: dict[str, dict[str, Any]] = {}
    for row in best.values():
        if row["metric"] == "shares":
            if row["end"] not in shares or row["rank"] > shares[row["end"]]["rank"]:
                shares[row["end"]] = row
            continue
        if row["metric"] == "eps":
            row["value"] = _eps_value(row, splits, eps_versions[row["start"], row["end"]])
        durations[row["metric"]].append(row)
    quarters: dict[tuple[str, str], dict[str, Any]] = {}
    years: dict[tuple[str, str], dict[str, Any]] = {}

    def put(target: dict, row: dict[str, Any], derived: bool = False) -> None:
        key = row["start"], row["end"]
        period = target.setdefault(key, {"start": key[0], "end": key[1], "filed": {},
                                         "derived": [], **dict.fromkeys(CONCEPTS)})
        metric = row["metric"]
        if period[metric] is not None and period["filed"][metric] > row["filed"]:
            return
        period[metric] = row["value"]
        period["filed"][metric] = row["filed"]
        if derived and metric not in period["derived"]:
            period["derived"].append(metric)

    for items in durations.values():
        direct = []
        annual = []
        for row in items:
            days = (date.fromisoformat(row["end"]) - date.fromisoformat(row["start"])).days + 1
            if 65 <= days <= 110:
                direct.append(row)
                put(quarters, row)
            elif 330 <= days <= 385:
                annual.append(row)
                put(years, row)
        # Subtract cumulative periods when a filing supplies only YTD values. Dates, rather
        # than XBRL's fy/fp labels, identify periods (comparatives carry the filing's labels).
        for end in sorted(items, key=lambda r: r["end"]):
            prior = [r for r in items if r["start"] == end["start"] and r["end"] < end["end"]
                     and 65 <= (date.fromisoformat(end["end"])
                                - date.fromisoformat(r["end"])).days <= 110]
            if prior:
                previous = max(prior, key=lambda r: r["end"])
                start = (date.fromisoformat(previous["end"]) + timedelta(days=1)).isoformat()
                if not any(r["start"] == start and r["end"] == end["end"] for r in direct):
                    derived = {**end, "start": start, "value": end["value"] - previous["value"],
                               "filed": max(end["filed"], previous["filed"])}
                    put(quarters, derived, True)
        # Q4 also works when only the three standalone quarters and the FY are supplied.
        for fy in annual:
            parts = sorted([r for r in direct if fy["start"] <= r["start"]
                            and r["end"] < fy["end"]], key=lambda r: r["start"])
            if len(parts) != 3 or parts[0]["start"] != fy["start"]:
                continue
            if any((date.fromisoformat(b["start"]) - date.fromisoformat(a["end"])).days != 1
                   for a, b in zip(parts, parts[1:], strict=False)):
                continue
            start = (date.fromisoformat(parts[-1]["end"]) + timedelta(days=1)).isoformat()
            if not 65 <= (date.fromisoformat(fy["end"]) - date.fromisoformat(start)).days <= 110:
                continue
            if any(r["start"] == start and r["end"] == fy["end"] for r in direct):
                continue
            put(quarters, {**fy, "start": start,
                           "value": fy["value"] - sum(r["value"] for r in parts),
                           "filed": max(fy["filed"], *(r["filed"] for r in parts))}, True)

    def finish(periods: dict, annual: bool = False) -> list[dict[str, Any]]:
        result = sorted(periods.values(), key=lambda p: p["end"])
        for period in result:
            share = shares.get(period["end"])
            if share:
                period["shares"] = share["value"]
                period["filed"]["shares"] = share["filed"]
            previous = [p for p in result if 350 <= (date.fromisoformat(period["end"])
                        - date.fromisoformat(p["end"])).days <= 380]
            prior = min(previous, key=lambda p: abs((date.fromisoformat(period["end"])
                        - date.fromisoformat(p["end"])).days - 365)) if previous else None
            for metric in ("eps", "revenue"):
                value, old = period[metric], prior[metric] if prior else None
                period[f"{metric}_yoy_pct"] = (
                    100 * (value - old) / old
                    if value is not None and old is not None and old > 0 else None
                )
            period["net_margin_pct"] = (100 * period["net_income"] / period["revenue"]
                                        if period["net_income"] is not None
                                        and period["revenue"] else None)
        for i, period in enumerate(result):
            recent = result[max(0, i - 2):i + 1]
            growth = [p["eps_yoy_pct"] for p in recent]
            contiguous = all(
                (330 if annual else 65) <= (date.fromisoformat(b["end"])
                 - date.fromisoformat(a["end"])).days <= (385 if annual else 110)
                for a, b in zip(recent, recent[1:], strict=False)
            )
            period["eps_acceleration"] = (len(growth) == 3 and all(g is not None for g in growth)
                                          and contiguous and growth[0] < growth[1] < growth[2])
        return result

    return finish(quarters), finish(years, annual=True)


def _precision(value: Any) -> Any:
    """Keep useful EPS precision after splits without exposing floating-point subtraction noise."""
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, dict):
        return {key: _precision(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_precision(item) for item in value]
    return value


def _project(result: dict[str, Any], asof: date) -> dict[str, Any] | None:
    quarters = result["quarters"]
    if not quarters:
        return None
    latest = date.fromisoformat(quarters[-1]["end"])
    # The next fiscal quarter's counterpart is three quarters before the latest reported one.
    # Dates also work for non-calendar fiscal years and 52/53-week reporting calendars.
    counterparts = [q for q in quarters
                    if 230 <= (latest - date.fromisoformat(q["end"])).days <= 310]
    if not counterparts:
        return None
    counterpart = min(counterparts, key=lambda q: abs(
        (latest - date.fromisoformat(q["end"])).days - 273,
    ))
    end = date.fromisoformat(counterpart["end"])
    reports = [e for e in result["events"] if e["source"] == "edgar"
               and e["known"] <= asof.isoformat() and e["date"] <= asof.isoformat()
               and 0 < (date.fromisoformat(e["date"]) - end).days <= 100]
    if not reports:
        return None
    report = min(reports, key=lambda e: e["date"])
    projected = date.fromisoformat(report["date"]) + timedelta(weeks=52)
    while projected.weekday() >= 5:
        projected += timedelta(days=1)
    if not 0 < (projected - asof).days <= 160:
        return None
    return {"ticker": _ticker(result["symbol"]), "date": projected.isoformat(),
            "timing": "unknown", "source": "edgar", "estimated": True,
            "reference_date": report["date"], "known": report["known"],
            "accession": "", "eps_estimate": None, "reaction": None}


def _load(
    db: sqlite3.Connection, symbol: str, asof: date, next_asof: date | None = None,
) -> dict[str, Any]:
    ticker, cutoff = _ticker(symbol), asof.isoformat()
    next_day = (next_asof or asof).isoformat()
    result: dict[str, Any] = {"symbol": symbol.upper(), "asof": cutoff, "quarters": [],
                              "years": [], "events": [], "next_earnings": None}
    company = db.execute("SELECT * FROM companies WHERE ticker=?", (ticker,)).fetchone()
    excluded = db.execute("SELECT 1 FROM excluded WHERE ticker=?", (ticker,)).fetchone()
    if company is None or not company["quarterly"] or excluded:
        return result
    rows = [dict(r) for r in db.execute("SELECT * FROM facts WHERE cik=? AND filed<=? AND end<=?",
                                       (company["cik"], cutoff, cutoff))]
    splits = [dict(r) for r in db.execute("SELECT * FROM splits WHERE ticker=?", (ticker,))]
    result["quarters"], result["years"] = _periods(rows, splits)
    events: dict[tuple[str, str], dict[str, Any]] = {}
    for r in db.execute(
        "SELECT * FROM events WHERE ticker=? AND "
        "((source='edgar' AND known<=?) OR (source='nasdaq' AND known<=?)) "
        "ORDER BY known, accession",
        (ticker, cutoff, next_day),
    ):
        events[r["date"], r["source"]] = dict(r)
    all_days = sorted({d for d, _ in events})  # EDGAR and the confirmed calendar
    for (day, source), event in sorted(events.items()):
        if not event["active"] or (source == "nasdaq" and day <= next_day):
            continue  # only EDGAR is a record of past earnings
        if source == "edgar" and event["timing"] == "unknown" and _preface(day, all_days):
            continue  # a 2.02 filing just before the real release (Tesla's delivery reports)
        if source == "nasdaq" and (day, "edgar") in events:
            continue
        event.pop("active")
        event["estimated"] = False
        reaction = db.execute("SELECT * FROM reactions WHERE ticker=? AND date=? AND timing=?",
                              (ticker, day, event["timing"])).fetchone()
        event["reaction"] = None
        if reaction and reaction["reaction_date"] <= cutoff:
            value = dict(reaction)
            if value["date_5"] is None or value["date_5"] > cutoff:
                value["change_5_pct"] = value["date_5"] = None
            event["reaction"] = value
        result["events"].append(event)
        if day > next_day and result["next_earnings"] is None:
            result["next_earnings"] = event
    if result["next_earnings"] is None:
        result["next_earnings"] = _project(result, next_asof or asof)
        if result["next_earnings"]:
            result["events"].append(result["next_earnings"])
    result["next_asof"] = next_day
    return _precision(result)


def _preface(day: str, days: list[str]) -> bool:
    """True when another earnings date follows 10 to 45 days later."""
    start = date.fromisoformat(day)
    return any(10 <= (date.fromisoformat(other) - start).days <= 45 for other in days)


def load(
    path: Path, symbol: str, asof: date | None = None, next_asof: date | None = None,
) -> dict[str, Any]:
    cutoff = asof or datetime.now(EASTERN).date()
    if not path.is_file():
        return {"symbol": symbol.upper(), "asof": cutoff.isoformat(), "quarters": [],
                "years": [], "events": [], "next_earnings": None}
    with closing(_readonly(path)) as db:
        return _load(db, symbol, cutoff, next_asof)


def _headline(data: dict[str, Any]) -> dict[str, Any]:
    quarter = data["quarters"][-1] if data["quarters"] else {}
    year = data["years"][-1] if data["years"] else {}
    return {
        "next_earnings": data["next_earnings"], "quarter_end": quarter.get("end"),
        "eps_yoy_pct": quarter.get("eps_yoy_pct"),
        "revenue_yoy_pct": quarter.get("revenue_yoy_pct"),
        "eps_annual_yoy_pct": year.get("eps_yoy_pct"),
        "net_margin_pct": quarter.get("net_margin_pct"),
        "eps_acceleration": quarter.get("eps_acceleration"),
    }


def refresh_summaries(db: sqlite3.Connection, today: date) -> None:
    """Materialize once in the updater; readers see a complete headline snapshot."""
    db.execute("DELETE FROM summaries")
    tickers = [r[0] for r in db.execute("SELECT ticker FROM companies")]
    for ticker in tickers:
        payload = _headline(_load(db, ticker, today))
        db.execute("INSERT INTO summaries VALUES (?,?,?)",
                   (ticker, today.isoformat(), json.dumps(payload, separators=(",", ":"))))


def summaries(path: Path, symbols: list[str] | None = None) -> dict[str, dict[str, Any]]:
    """One small table scan; never derive facts in a whole-market request."""
    if not path.is_file():
        return {}
    with closing(_readonly(path)) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='summaries'").fetchone():
            return {}  # an older store is upgraded by fundamentals-update, never by the web app
        query, params = "SELECT * FROM summaries", []
        if symbols is not None:
            params = list(dict.fromkeys(_ticker(symbol) for symbol in symbols))
            query += f" WHERE ticker IN ({','.join('?' for _ in params)})"
        return {r["ticker"]: {**json.loads(r["payload"]), "asof": r["asof"]}
                for r in db.execute(query, params)}


def earnings(path: Path, symbols: list[str], asof: date | None = None) -> dict[str, Any]:
    """Current lists use stored summaries. Explicit historical cuts retain filing honesty."""
    cutoff = asof or datetime.now(EASTERN).date()
    result = {}
    stored = screen_readings(path, cutoff, symbols) if asof is None else {}
    with closing(_readonly(path)) if path.is_file() else nullcontext(None) as db:
        for symbol in dict.fromkeys(symbols):
            if asof is None:
                result[symbol.upper()] = stored.get(_ticker(symbol), _headline({
                    "quarters": [], "years": [], "next_earnings": None,
                }))
            else:
                data = _load(db, symbol, cutoff) if db else load(path, symbol, cutoff)
                headline = _headline(data)
                event = headline["next_earnings"]
                headline["earnings_days"] = (sessions_between(cutoff,
                    date.fromisoformat(event["date"])) if event else None)
                result[symbol.upper()] = headline
    for headline in result.values():
        headline.setdefault("earnings_days", None)
    return {"asof": cutoff.isoformat(), "symbols": result}


def screen_readings(
    path: Path, today: date | None = None, symbols: list[str] | None = None,
) -> dict[str, dict[str, Any]]:
    today = today or datetime.now(EASTERN).date()
    rows = {}
    # Count once per distinct report date rather than once per stock.
    counts: dict[str, int | None] = {}
    for ticker, summary in summaries(path, symbols).items():
        event = summary["next_earnings"]
        day = event["date"] if event else ""
        if day not in counts:
            counts[day] = (sessions_between(today, date.fromisoformat(day))
                           if day and day >= today.isoformat() else None)
        rows[ticker] = {**summary, "earnings_days": counts[day]}
    return rows


def reaction(
    event: dict[str, Any], bars: list[dict[str, Any]], sessions: list[str] | None = None,
) -> dict[str, Any] | None:
    """Gap and close-to-close day change; ADR20 is measured before the reaction day.

    Five-session change is measured from the reaction close to the close five sessions later.
    Unknown timing stays unknown; an intraday release cannot safely imply a reaction bar.
    """
    if event["timing"] == "unknown":
        return None
    sessions = sessions if sessions is not None else [b["date"] for b in bars]
    locate = bisect_left if event["timing"] == "before_open" else bisect_right
    index = locate(sessions, event["date"])
    if index >= len(bars) or index == 0:
        return None
    current, prior = bars[index], bars[index - 1]
    if not all(current.get(k, 0) and current[k] > 0 for k in ("open", "close")):
        return None
    if not prior.get("close") or prior["close"] <= 0:
        return None
    gap = 100 * (current["open"] / prior["close"] - 1)
    day = 100 * (current["close"] / prior["close"] - 1)
    window = bars[max(0, index - 20):index]
    adr = (100 * (sum(b["high"] / b["low"] for b in window) / 20 - 1)
           if len(window) == 20 and all(b.get("low") and b.get("high")
                                       and b["low"] > 0 for b in window) else None)
    later = bars[index + 5] if index + 5 < len(bars) else None
    return {"reaction_date": current["date"], "gap_pct": gap, "day_pct": day,
            "gap_adr": gap / adr if adr else None, "day_adr": day / adr if adr else None,
            "change_5_pct": 100 * (later["close"] / current["close"] - 1)
            if later and later.get("close") else None, "date_5": later["date"] if later else None}


def refresh_market(db: sqlite3.Connection, market_path: Path, today: date) -> None:
    """Copy split metadata and compute reactions without opening market data for writing."""
    if not market_path.is_file():
        return
    with closing(_readonly(market_path)) as market:
        if market.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mm_universe'",
        ).fetchone():
            db.execute("DELETE FROM excluded")
            db.executemany("INSERT OR IGNORE INTO excluded VALUES (?)", [
                (_ticker(r[0]),) for r in market.execute(
                    "SELECT ticker FROM mm_universe WHERE is_common_stock=0",
                )
            ])
        db.execute("DELETE FROM splits")
        db.executemany("INSERT INTO splits VALUES (?,?,?)", market.execute(
            "SELECT ticker, date, ratio FROM splits WHERE date<=? AND ratio>0",
            (today.isoformat(),),
        ))
        tickers = [r[0] for r in db.execute(
            "SELECT DISTINCT ticker FROM events WHERE source='edgar'",
        )]
        for ticker in tickers:
            bars = [dict(r) for r in market.execute(
                "SELECT date, open, high, low, close FROM ohlcv WHERE ticker=? AND date<=? "
                "ORDER BY date", (ticker, today.isoformat()))]
            sessions = [b["date"] for b in bars]
            for row in db.execute(
                "SELECT * FROM events WHERE ticker=? AND source='edgar'", (ticker,),
            ):
                value = reaction(dict(row), bars, sessions)
                if value:
                    db.execute("INSERT OR REPLACE INTO reactions VALUES (?,?,?,?,?,?,?,?,?,?)",
                               (ticker, row["date"], row["timing"], *value.values()))


class Fetcher:
    """Sequential requests, below SEC's ten/second limit, with a bounded initial fill."""

    def __init__(self, user_agent: str, deadline: float):
        self.user_agent, self.deadline = user_agent, deadline
        self.last_request = 0.0

    def check_time(self) -> None:
        if time.monotonic() >= self.deadline:
            raise RuntimeError("Initial fill reached its 28-minute limit; rerun to resume")

    def open(self, url: str, browser: bool = False) -> Any:
        self.check_time()
        time.sleep(max(0, 0.15 - (time.monotonic() - self.last_request)))
        self.last_request = time.monotonic()
        agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0" if browser \
            else self.user_agent
        request = urllib.request.Request(url, headers={"User-Agent": agent,
                                                       "Accept": "application/json"})
        return urllib.request.urlopen(request, timeout=60)

    def json(self, url: str, browser: bool = False) -> Any:
        with self.open(url, browser) as response:
            return json.load(response)

    def text(self, url: str) -> str:
        with self.open(url) as response:
            return response.read().decode("utf-8")

    def download(self, url: str, path: Path) -> None:
        with self.open(url) as response, path.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                self.check_time()
                output.write(chunk)


def _bulk(db: sqlite3.Connection, fetcher: Fetcher, kind: str) -> None:
    ciks = {r[0] for r in db.execute("SELECT DISTINCT cik FROM companies")}
    with tempfile.TemporaryDirectory(prefix="momo-fundamentals-") as temporary:
        path = Path(temporary) / f"{kind}.zip"
        fetcher.download(FACTS_ZIP if kind == "facts" else SUBMISSIONS_ZIP, path)
        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                fetcher.check_time()
                match = re.fullmatch(r"CIK(\d+)(?:-submissions-\d+)?\.json", Path(name).name)
                if not match or int(match[1]) not in ciks:
                    continue
                with archive.open(name) as member:
                    payload = json.load(member)
                if kind == "facts":
                    save_facts(db, int(match[1]), payload)
                else:
                    save_submissions(db, int(match[1]), payload)
        _set(db, f"bulk_{kind}", "done")
        db.commit()


def _changed(
    fetcher: Fetcher, since: date, through: date,
) -> list[tuple[int, str, str, str]]:
    """Quarterly master indexes bridge long gaps with at most one request per quarter."""
    changed = []
    cursor = date(since.year, 3 * ((since.month - 1) // 3) + 1, 1)
    while cursor <= through:
        quarter = (cursor.month - 1) // 3 + 1
        url = f"{SEC}/Archives/edgar/full-index/{cursor.year}/QTR{quarter}/master.idx"
        for line in fetcher.text(url).splitlines():
            fields = line.split("|")
            if len(fields) != 5 or not fields[0].isdigit():
                continue
            cik, _, form, filed, filename = fields
            if (since.isoformat() <= filed <= through.isoformat()
                    and form in FORMS | {"8-K", "8-K/A"}):
                changed.append((int(cik), form, filed, Path(filename).stem))
        cursor = (date(cursor.year + 1, 1, 1) if quarter == 4
                  else date(cursor.year, cursor.month + 3, 1))
    return changed


def _incremental(
    db: sqlite3.Connection, fetcher: Fetcher, since: date, through: date,
) -> int:
    changed = _changed(fetcher, since, through)
    ciks = {r[0] for r in db.execute("SELECT DISTINCT cik FROM companies")}
    pending: dict[int, list[tuple[str, str, str]]] = defaultdict(list)
    for cik, form, filed, accession in changed:
        if cik in ciks and not db.execute(
            "SELECT 1 FROM filings WHERE accession=?", (accession,)
        ).fetchone():
            pending[cik].append((form, filed, accession))
    for cik, filings in pending.items():
        submissions = fetcher.json(f"{DATA}/submissions/CIK{cik:010}.json")
        save_submissions(db, cik, submissions)
        # A long outage may put the indexed filings in older history shards.
        for shard in submissions.get("filings", {}).get("files", []):
            if shard["filingTo"] >= since.isoformat():
                save_submissions(db, cik, fetcher.json(f"{DATA}/submissions/{shard['name']}"))
        earnings_filed = any(db.execute(
            "SELECT 1 FROM events WHERE accession=? AND source='edgar' LIMIT 1", (accession,),
        ).fetchone() for _, _, accession in filings)
        if earnings_filed or any(form in FORMS for form, _, _ in filings):
            try:
                payload = fetcher.json(f"{DATA}/api/xbrl/companyfacts/CIK{cik:010}.json")
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
            else:
                save_facts(db, cik, payload)
        # Remember irrelevant 8-Ks too, including index rows absent from a recent shard.
        db.executemany("INSERT OR IGNORE INTO filings VALUES (?,?,?)",
                       [(accession, cik, filed) for _, filed, accession in filings])
    return len(pending)


def _calendar(db: sqlite3.Connection, fetcher: Fetcher, today: date) -> None:
    day, count = today, 0
    while count < 30:
        day += timedelta(days=1)
        if day.weekday() >= 5:
            continue
        count += 1
        key = f"calendar:{day.isoformat()}"
        if _get(db, key) == today.isoformat():
            continue
        payload = fetcher.json(
            f"https://api.nasdaq.com/api/calendar/earnings?date={day.isoformat()}", browser=True)
        if payload.get("status", {}).get("rCode") not in (None, 200):
            raise RuntimeError(f"Nasdaq calendar unavailable for {day}")
        rows = (payload.get("data") or {}).get("rows") or []
        # A snapshot also records cancellations, so an old estimate cannot linger forever.
        db.execute("INSERT OR REPLACE INTO events "
                   "SELECT ticker,date,timing,source,?,accession,eps_estimate,0 FROM events "
                   "WHERE date=? AND source='nasdaq'", (today.isoformat(), day.isoformat()))
        for row in rows:
            ticker = _ticker(row.get("symbol", ""))
            if not db.execute("SELECT 1 FROM companies WHERE ticker=?", (ticker,)).fetchone():
                continue
            label = str(row.get("time", "")).lower()
            timing = "before_open" if "pre-market" in label else \
                "after_close" if "after-hours" in label else "unknown"
            estimate = str(row.get("epsForecast", "")).replace("$", "").replace(",", "")
            try:
                eps = float(estimate.replace("(", "-").replace(")", ""))
                if not math.isfinite(eps):
                    eps = None
            except ValueError:
                eps = None
            db.execute("INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?,?,1)",
                       (ticker, day.isoformat(), timing, "nasdaq", today.isoformat(), "", eps))
        _set(db, key, today.isoformat())
        db.commit()


@contextmanager
def _update_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Lock the store itself: no separate lock file or changes to another data store.
    with path.open("ab") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("A fundamentals update is already running") from error
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def update(
    path: Path, market_path: Path, now: datetime, user_agent: str = DEFAULT_AGENT,
    *, fetcher: Fetcher | None = None,
) -> str:
    """Fill from both bulk archives once; thereafter fetch only newly indexed companies.

    SEC's index is complete overnight. Keep a one-day overlap and a filing ledger, and check
    each completed index day once. Repeating a successful run on the same day uses no network.
    Failed stages leave their checkpoint unchanged and can be safely retried.
    """
    today = now.astimezone(EASTERN).date()
    fetcher = fetcher or Fetcher(user_agent, time.monotonic() + 28 * 60)
    with _update_lock(path), closing(_connect(path)) as db:
        if _get(db, "tickers_checked") != today.isoformat():
            payload = fetcher.json(TICKERS)
            db.executemany("INSERT INTO companies(ticker,cik) VALUES (?,?) "
                           "ON CONFLICT(ticker) DO UPDATE SET cik=excluded.cik",
                           [(_ticker(r["ticker"]), int(r["cik_str"])) for r in payload.values()])
            _set(db, "tickers_checked", today.isoformat())
            db.commit()
        initial = _get(db, "bulk_facts") is None or _get(db, "bulk_submissions") is None
        for kind in ("facts", "submissions"):
            if _get(db, f"bulk_{kind}") is None:
                _bulk(db, fetcher, kind)
        # A snapshot can lag the index by a day, so replay two days on the first fill.
        through = today - timedelta(days=1)
        since = date.fromisoformat(_get(db, "index_through") or
                                   (today - timedelta(days=2)).isoformat())
        count = 0
        if _get(db, "index_checked") != today.isoformat():
            count = _incremental(db, fetcher, since, through)
            _set(db, "index_through", through.isoformat())
            _set(db, "index_checked", today.isoformat())
            db.commit()
        _calendar(db, fetcher, today)
        refresh_market(db, market_path, today)
        refresh_summaries(db, today)
        _set(db, "updated", now.isoformat())
        db.commit()
        total = db.execute("SELECT COUNT(*) FROM companies WHERE quarterly=1").fetchone()[0]
    return f"{'filled' if initial else 'updated'} {count} companies; {total} quarterly filers"
