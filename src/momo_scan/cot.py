"""Commitments of Traders: how the big groups are positioned in the futures that matter here.

Source: the CFTC's public Legacy report (futures only), which splits each market into large
speculators, commercials (hedgers) and small speculators (too small to report). Reports are
for a Tuesday and published the Friday after at 3:30pm ET.

The web app only ever reads the local SQLite store (`data/cot.db`). `update` is the one place
that talks to the CFTC: a weekly job (`momo cot-update`, scheduled in Hermes cron) calls it, and
it asks the CFTC only when a new report is due.
"""

from __future__ import annotations

import json
import sqlite3
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from datetime import time as clock
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

URL = "https://publicreporting.cftc.gov/resource/6dca-aqww.json"
RELEASE = clock(15, 30)  # Eastern, three days after the Tuesday it covers
THROTTLE = 5 * 60
EASTERN = ZoneInfo("America/New_York")
WEEKS = 3 * 52  # the window "extreme" is measured against

# (code, symbol, name, family). Order is the order on screen.
MARKETS = [
    ("13874A", "ES", "S&P 500", "Equity"),
    ("209742", "NQ", "Nasdaq 100", "Equity"),
    ("239742", "RTY", "Russell 2000", "Equity"),
    ("1170E1", "VX", "VIX", "Volatility"),
    ("042601", "ZT", "2Y Treasury", "Rates"),
    ("043602", "ZN", "10Y Treasury", "Rates"),
    ("020601", "ZB", "30Y Treasury", "Rates"),
    ("098662", "DX", "US Dollar", "Currency"),
    ("099741", "6E", "Euro", "Currency"),
    ("097741", "6J", "Yen", "Currency"),
    ("133741", "BTC", "Bitcoin", "Crypto"),
    ("088691", "GC", "Gold", "Commodity"),
    ("084691", "SI", "Silver", "Commodity"),
    ("085692", "HG", "Copper", "Commodity"),
    ("067651", "CL", "Crude oil", "Commodity"),
    ("023651", "NG", "Natural gas", "Commodity"),
]

# Group key, label, and the report's field stem for its longs and shorts.
GROUPS = [
    ("spec", "Large Specs", "noncomm_positions"),
    ("comm", "Commercials", "comm_positions"),
    ("small", "Small Specs", "nonrept_positions"),
]
_LONG = {key: f"{stem}_long_all" for key, _, stem in GROUPS}
_SHORT = {key: f"{stem}_short_all" for key, _, stem in GROUPS}
_KEYS = [key for key, *_ in GROUPS]


def _rows(where: str) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({
        "$where": where,
        "$select": "cftc_contract_market_code,report_date_as_yyyy_mm_dd,open_interest_all,"
        + ",".join([*_LONG.values(), *_SHORT.values()]),
        "$order": "report_date_as_yyyy_mm_dd",
        "$limit": 100000,
    })
    with urllib.request.urlopen(f"{URL}?{query}", timeout=60) as response:
        return json.load(response)


def _codes() -> str:
    return ",".join(f"'{code}'" for code, *_ in MARKETS)


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute(
        "CREATE TABLE IF NOT EXISTS weeks (code TEXT, date TEXT, oi INTEGER, "
        "spec_l INTEGER, spec_s INTEGER, comm_l INTEGER, comm_s INTEGER, "
        "small_l INTEGER, small_s INTEGER, PRIMARY KEY (code, date))"
    )
    return db


def _save(db: sqlite3.Connection, rows: list[dict[str, Any]]) -> int:
    values = []
    for row in rows:
        oi = int(row["open_interest_all"])
        if not oi:
            continue
        values.append((
            row["cftc_contract_market_code"], row["report_date_as_yyyy_mm_dd"][:10], oi,
            *(int(row[field[key]]) for key in _KEYS for field in (_LONG, _SHORT)),
        ))
    with db:
        db.executemany("INSERT OR REPLACE INTO weeks VALUES (?,?,?,?,?,?,?,?,?)", values)
    return len(values)


def latest_date(path: Path) -> str | None:
    """Newest report date held for every market (a market that lags holds the answer back)."""
    if not path.exists():
        return None
    db = _connect(path)
    try:
        row = db.execute(
            "SELECT MIN(last) FROM (SELECT MAX(date) AS last FROM weeks GROUP BY code) "
            "HAVING COUNT(*) = ?", (len(MARKETS),),
        ).fetchone()
    finally:
        db.close()
    return row[0] if row else None


def expected_date(now: datetime) -> date:
    """The Tuesday of the newest report that should be out by now."""
    local = now.astimezone(EASTERN)
    tuesday = local.date() - timedelta(days=(local.weekday() - 1) % 7)
    if datetime.combine(tuesday + timedelta(days=3), RELEASE, local.tzinfo) > local:
        tuesday -= timedelta(days=7)
    return tuesday


def update(path: Path, now: datetime, wait: int = 0) -> str:
    """Bring the store up to date. Returns a one-line report; raises if the CFTC is overdue.

    Asks the CFTC nothing when the store already holds the expected report. With `wait`
    minutes, a report that isn't out yet is re-checked every five minutes.
    """
    deadline = time.monotonic() + wait * 60
    while True:
        have = latest_date(path)
        want = expected_date(now).isoformat()
        if have and have >= want:
            return f"up to date ({have})"
        db = _connect(path)
        try:
            since = f"report_date_as_yyyy_mm_dd > '{have}T00:00:00.000' AND " if have else ""
            rows = _rows(f"{since}cftc_contract_market_code in({_codes()})")
            added = _save(db, rows)
        finally:
            db.close()
        have = latest_date(path)
        if have and have >= want:
            return f"added {added} rows, now through {have}"
        if time.monotonic() >= deadline:
            overdue = date.fromisoformat(want) + timedelta(days=8)  # holidays can delay it
            if now.astimezone(EASTERN).date() > overdue:
                raise RuntimeError(f"CFTC report for {want} still missing (store has {have})")
            return f"report for {want} not published yet (store has {have})"
        time.sleep(THROTTLE)
        now = datetime.now(now.tzinfo)


def load(path: Path, code: str) -> list[dict[str, Any]]:
    """Every weekly report for one market, oldest first."""
    if not path.exists():
        raise FileNotFoundError(path)
    db = _connect(path)
    try:
        rows = db.execute(
            "SELECT date, oi, spec_l, spec_s, comm_l, comm_s, small_l, small_s "
            "FROM weeks WHERE code = ? ORDER BY date", (code,)).fetchall()
    finally:
        db.close()
    if not rows:
        raise KeyError(code)
    return [{"date": d, "oi": oi, "spec": [sl, ss], "comm": [cl, cs], "small": [ml, ms]}
            for d, oi, sl, ss, cl, cs, ml, ms in rows]


def net(week: dict[str, Any], key: str) -> float:
    """Net position (long minus short) as a percent of open interest."""
    longs, shorts = week[key]
    return 100 * (longs - shorts) / week["oi"]


def percentile(values: list[float], value: float) -> int:
    """Where value sits in the window: 0 is the lowest reading, 100 the highest."""
    if len(values) < 2:
        return 50
    below = sum(v < value for v in values) + 0.5 * sum(v == value for v in values)
    return round(100 * below / len(values))


def summary(weeks: list[dict[str, Any]]) -> dict[str, Any]:
    """Latest reading, one-week change and three-year percentile for each group."""
    window = weeks[-WEEKS:]
    last = weeks[-1]
    groups = {}
    for key, *_ in GROUPS:
        values = [net(w, key) for w in window]
        now = values[-1]
        groups[key] = {
            "net": round(now, 1),
            "change": round(now - net(weeks[-2], key), 1) if len(weeks) > 1 else 0,
            "pct": percentile(values, now),
            "lo": round(min(values), 1),
            "hi": round(max(values), 1),
        }
    return {"date": last["date"], "oi": last["oi"], "groups": groups}


def overview(path: Path) -> dict[str, Any]:
    markets = []
    for code, symbol, name, family in MARKETS:
        try:
            markets.append({"code": code, "symbol": symbol, "name": name, "family": family,
                            **summary(load(path, code))})
        except (OSError, ValueError, KeyError):
            continue  # one market failing shouldn't blank the screen
    return {"groups": [[key, label] for key, label, _ in GROUPS], "markets": markets,
            "as_of": max((m["date"] for m in markets), default=None)}


def history(path: Path, code: str) -> dict[str, Any]:
    """The full series for one market: net % of open interest for each group, by week."""
    entry = next((m for m in MARKETS if m[0] == code), None)
    if entry is None:
        raise KeyError(code)
    weeks = load(path, code)
    return {
        "code": code, "symbol": entry[1], "name": entry[2],
        "dates": [w["date"] for w in weeks],
        "oi": [w["oi"] for w in weeks],
        "series": {key: [round(net(w, key), 2) for w in weeks] for key, *_ in GROUPS},
        "longs": {key: [w[key][0] for w in weeks] for key, *_ in GROUPS},
        "shorts": {key: [w[key][1] for w in weeks] for key, *_ in GROUPS},
    }
