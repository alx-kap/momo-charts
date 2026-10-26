"""Price alerts: tell me when a stock crosses a level.

An alert is a symbol, a price and a direction (crossing either way, up through it, or down
through it). Every row belongs to one account (`user_id`). The watcher checks live quotes on
the server, so an alert fires with no browser open; open tabs of that account hear about it at
once, and the rest show it on their next load (`seen` = 0 until then).

An alert fires on a cross: the previous price on one side of the level, the new one on the other
side or on it. Starting already past the level isn't a cross. By default only regular-session
prices count; `extended` lets pre- and post-market trades fire it too. `repeat` keeps it armed
after it fires, at most once every ten minutes; otherwise it fires once and stops.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import UTC, datetime, time
from typing import Any

from momo_scan.live.base import MARKET_TZ, Quote
from momo_scan.live.hub import LiveHub, clean_symbol
from momo_scan.storage import Storage

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    direction TEXT NOT NULL DEFAULT 'cross',
    repeat INTEGER NOT NULL DEFAULT 0,
    extended INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    drawing_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    fired_at TEXT,
    fired_price REAL,
    seen INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, status);
"""

DIRECTIONS = ("cross", "up", "down")
STATUSES = ("active", "paused", "triggered")
FIELDS = ("symbol", "price", "direction", "repeat", "extended", "note", "drawing_id", "status")
REPEAT_SECONDS = 600  # an alert that repeats fires at most this often
OPEN, CLOSE = time(9, 30), time(16, 0)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _alert(row: sqlite3.Row) -> dict[str, Any]:
    alert = dict(row)
    alert.pop("user_id")
    for key in ("repeat", "extended", "seen"):
        alert[key] = bool(alert[key])
    return alert


def crossed(before: float, after: float, level: float, direction: str) -> bool:
    up = before < level <= after
    down = before > level >= after
    return up if direction == "up" else down if direction == "down" else up or down


def regular_session(at: float) -> bool:
    local = datetime.fromtimestamp(at, MARKET_TZ)
    return local.weekday() < 5 and OPEN <= local.time() < CLOSE


class Alerts:
    def __init__(self, storage: Storage):
        self.db: sqlite3.Connection = storage.connection
        self.db.executescript(SCHEMA)

    def list(self, user: str) -> list[dict[str, Any]]:
        """Every alert of an account: active and paused first, then the ones that fired."""
        rows = self.db.execute(
            "SELECT * FROM alerts WHERE user_id=? "
            "ORDER BY status='triggered', COALESCE(fired_at, created_at) DESC, id DESC",
            (user,),
        )
        return [_alert(row) for row in rows]

    def armed(self) -> list[dict[str, Any]]:
        """Active alerts of every account, for the watcher."""
        rows = self.db.execute("SELECT * FROM alerts WHERE status='active'")
        return [{**_alert(row), "user_id": row["user_id"]} for row in rows]

    def get(self, user: str, alert_id: int) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT * FROM alerts WHERE user_id=? AND id=?", (user, alert_id)
        ).fetchone()
        return _alert(row) if row else None

    def add(self, user: str, **fields: Any) -> dict[str, Any]:
        fields = _clean(fields)
        fields.pop("status", None)
        columns = ", ".join(["user_id", "created_at", *fields])
        marks = ", ".join("?" * (len(fields) + 2))
        with self.db:
            cursor = self.db.execute(
                f"INSERT INTO alerts({columns}) VALUES({marks})", (user, _now(), *fields.values())
            )
        alert = self.get(user, int(cursor.lastrowid or 0))
        assert alert is not None
        return alert

    def update(self, user: str, alert_id: int, changes: dict[str, Any]) -> dict[str, Any] | None:
        """Change an alert. Arming a fired one again clears when it fired."""
        changes = _clean(changes)
        if changes.get("status") == "active":
            changes |= {"fired_at": None, "fired_price": None, "seen": 1}
        if changes:
            sets = ", ".join(f"{key}=?" for key in changes)
            with self.db:
                self.db.execute(
                    f"UPDATE alerts SET {sets} WHERE user_id=? AND id=?",
                    (*changes.values(), user, alert_id),
                )
        return self.get(user, alert_id)

    def delete(self, user: str, alert_id: int) -> bool:
        with self.db:
            cursor = self.db.execute(
                "DELETE FROM alerts WHERE user_id=? AND id=?", (user, alert_id)
            )
        return cursor.rowcount > 0

    def clear_triggered(self, user: str) -> int:
        with self.db:
            cursor = self.db.execute(
                "DELETE FROM alerts WHERE user_id=? AND status='triggered'", (user,)
            )
        return cursor.rowcount

    def mark_seen(self, user: str, ids: list[int]) -> None:
        with self.db:
            self.db.executemany(
                "UPDATE alerts SET seen=1 WHERE user_id=? AND id=?", [(user, i) for i in ids]
            )

    def fire(self, alert_id: int, price: float, repeat: bool) -> str:
        at = _now()
        status = "active" if repeat else "triggered"
        with self.db:
            self.db.execute(
                "UPDATE alerts SET fired_at=?, fired_price=?, seen=0, status=? WHERE id=?",
                (at, price, status, alert_id),
            )
        return at


def _clean(fields: dict[str, Any]) -> dict[str, Any]:
    out = {key: value for key, value in fields.items() if key in FIELDS}
    if "symbol" in out:
        out["symbol"] = str(out["symbol"]).strip().upper()
    if "direction" in out and out["direction"] not in DIRECTIONS:
        raise ValueError(f"Direction is one of {', '.join(DIRECTIONS)}")
    if "status" in out and out["status"] not in STATUSES:
        raise ValueError(f"Status is one of {', '.join(STATUSES)}")
    if "price" in out and not (float(out["price"]) > 0):
        raise ValueError("The price must be above zero")
    for key in ("repeat", "extended"):
        if key in out:
            out[key] = int(bool(out[key]))
    return out


class AlertWatcher:
    """Checks every live quote of an alerted symbol against its alerts. The hub streams those
    symbols whether or not a browser shows them."""

    def __init__(self, alerts: Alerts, hub: LiveHub):
        self.alerts = alerts
        self.hub = hub
        self.armed: dict[str, list[dict[str, Any]]] = {}  # ticker -> its active alerts
        self.last: dict[int, float] = {}  # alert id -> the last price it saw
        self.fired: dict[int, float] = {}  # alert id -> when it last fired (epoch)
        hub.on_quote = self.check

    async def reload(self) -> None:
        """Read the active alerts again (after any change) and stream their symbols."""
        armed: dict[str, list[dict[str, Any]]] = {}
        for alert in self.alerts.armed():
            armed.setdefault(clean_symbol(alert["symbol"]), []).append(alert)
        # A moved alert starts over: its next cross is measured from the next price.
        before = {alert["id"]: alert for group in self.armed.values() for alert in group}
        now = {alert["id"]: alert for group in armed.values() for alert in group}
        same = {
            key for key, alert in now.items()
            if key in before and (alert["price"], alert["direction"])
            == (before[key]["price"], before[key]["direction"])
        }
        self.last = {key: value for key, value in self.last.items() if key in same}
        self.fired = {key: value for key, value in self.fired.items() if key in now}
        self.armed = armed
        await self.hub.watch_alerts(frozenset(armed))

    def check(self, quote: Quote) -> None:
        group = self.armed.get(quote.symbol)
        if not group:
            return
        done = []  # fired once: disarmed now, before the reload catches up
        for alert in group:
            if alert["extended"]:
                price = quote.trade if quote.trade is not None else quote.last
            elif regular_session(quote.time):
                price = quote.last
            else:
                continue
            before = self.last.get(alert["id"])
            self.last[alert["id"]] = price
            if before is None or not crossed(before, price, alert["price"], alert["direction"]):
                continue
            if alert["repeat"] and quote.time - self.fired.get(alert["id"], 0) < REPEAT_SECONDS:
                continue
            self.fired[alert["id"]] = quote.time
            at = self.alerts.fire(alert["id"], price, alert["repeat"])
            event = {k: v for k, v in alert.items() if k != "user_id"}
            event |= {"fired_at": at, "fired_price": price, "seen": False}
            if not alert["repeat"]:
                event["status"] = "triggered"
                done.append(alert)
            self.hub.notify(alert["user_id"], event)
        if done:
            self.armed[quote.symbol] = [alert for alert in group if alert not in done]
            asyncio.get_running_loop().create_task(self.reload())
