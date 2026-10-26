from __future__ import annotations

from dataclasses import replace
from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient

from momo_scan.config import AppConfig
from momo_scan.models import Bar
from momo_scan.screener import build_table, clean_rules, readings, screen
from momo_scan.web.server import create_app

DAY = 86400


def _bars(closes: list[float], volume: float = 1e6) -> list[Bar]:
    return [
        Bar(t=1_700_000_000 + n * DAY, o=c, h=c * 1.02, l=c * 0.98, c=c, v=volume)
        for n, c in enumerate(closes)
    ]


def _meta(ticker: str, sector: str = "Tech") -> dict[str, str]:
    return {"ticker": ticker, "symbol": f"NASDAQ:{ticker}", "sector": sector, "industry": "Chips"}


def test_readings_for_a_steady_climb() -> None:
    row = readings(_bars([50 + n for n in range(120)]), _meta("UP"), ["AI"])
    assert row is not None
    assert row["stack"] and row["new_high"] and row["from_high"] < 2
    assert row["d50"] > 0 and row["m1"] == round(100 * (169 / 148 - 1), 2)
    assert row["adr"] > 3
    # The last session's volume, and the 50-day average live volume is measured against.
    assert row["vol"] == 1e6 and row["dvol1"] == 169.0 and row["avg_vol"] == 1e6


def test_relentless_readings() -> None:
    # 120 days up: above the 50-day since its first full average, the 20-day on every close.
    climb = [50 + n for n in range(120)]
    row = readings(_bars(climb), _meta("UP"), [])
    assert row is not None and row["run50"] == 71 and row["held20"] == 100
    # Then a dip under both averages, and four days back above the 50-day but not the 20-day.
    row = readings(_bars(climb + [120, 100, 150, 151, 152, 153]), _meta("DIP"), [])
    assert row is not None and row["run50"] == 4 and row["held20"] == 90  # all six under the 20-day
    # Too short for three months of 20-day readings.
    assert readings(_bars(climb[:80]), _meta("NEW"), [])["held20"] is None


def test_too_little_history_is_left_out() -> None:
    assert readings(_bars([10.0] * 30), _meta("NEW"), []) is None


def test_filters_and_sort() -> None:
    table = build_table(
        [
            (_meta("UP"), _bars([50 + n for n in range(120)])),
            (_meta("DOWN", "Energy"), _bars([200 - n for n in range(120)])),
        ],
        {"UP": ["AI"]},
    )
    assert [r["symbol"] for r in screen(table, [])["rows"]] == ["NASDAQ:UP", "NASDAQ:DOWN"]
    above = clean_rules([{"field": "d50", "op": ">=", "value": 0}])
    assert [r["symbol"] for r in screen(table, above)["rows"]] == ["NASDAQ:UP"]
    both = clean_rules([{"field": "sector", "value": "energy"}, {"field": "stack", "value": False}])
    assert [r["symbol"] for r in screen(table, both)["rows"]] == ["NASDAQ:DOWN"]
    assert screen(table, clean_rules([{"field": "theme", "value": "ai"}]))["total"] == 1
    assert [r["symbol"] for r in screen(table, [], "sector", desc=False)["rows"]] == [
        "NASDAQ:DOWN", "NASDAQ:UP"]
    assert screen(table, [], "m1", desc=False)["rows"][0]["symbol"] == "NASDAQ:DOWN"


def test_bad_rules_are_dropped() -> None:
    raw = [{"field": "nope", "value": 1}, {"field": "adr", "value": "x"}, "junk", {"field": "adr"}]
    assert clean_rules(raw) == []
    assert clean_rules("junk") == []


class _Stocks:
    async def __aenter__(self) -> _Stocks:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def get_sessions(self, start: date, end: date) -> list[date]:
        return [end]

    async def screen_universe(self, count: int):
        fund = {**_meta("FUND"), "etf": True}
        return [(_meta("UP"), _bars([50 + n for n in range(120)])),
                (fund, _bars([20 + n for n in range(120)]))]


def test_screen_endpoint() -> None:
    app = create_app(AppConfig(), Path("config/momo.toml"), provider_factory=_Stocks)
    with TestClient(app) as client:
        found = client.get(
            "/api/screen", params={"filters": '[{"field":"adr","op":">=","value":1}]'}
        ).json()
        assert found["total"] == 1 and found["universe"] == 1
        assert found["rows"][0]["symbol"] == "NASDAQ:UP"
        assert {f["key"] for f in found["fields"]} >= {"adr", "stack", "theme"}
        assert client.get("/api/screen", params={"filters": "{"}).status_code == 400
        both = client.get("/api/screen", params={"etfs": "true"}).json()
        assert both["total"] == 2 and both["universe"] == 1 and both["etfs"] == 1


def test_any_rules_need_only_one_to_pass() -> None:
    table = build_table(
        [
            (_meta("UP"), _bars([50 + n for n in range(120)])),
            (_meta("DOWN", "Energy"), _bars([200 - n for n in range(120)])),
        ],
        {},
    )
    either = clean_rules([
        {"field": "sector", "value": "tech", "any": True},
        {"field": "sector", "value": "energy", "any": True},
    ])
    assert screen(table, either)["total"] == 2
    assert screen(table, [*either, {"field": "stack", "value": True}])["total"] == 1
    loose = clean_rules([{"field": "sector", "value": "tech", "any": 1}])
    assert screen(table, loose)["total"] == 1


def test_pinned_column_sorts_first() -> None:
    def stock(ticker: str, sector: str, top: float) -> tuple[dict[str, str], list[Bar]]:
        return _meta(ticker, sector), _bars([top / 2 + n * top / 240 for n in range(120)])

    table = build_table(
        [stock("A", "Tech", 100), stock("B", "Energy", 50), stock("C", "Tech", 20),
         stock("D", "Energy", 200)],
        {},
    )
    found = screen(table, [], "price", desc=True, pin="sector")["rows"]
    assert [r["symbol"].split(":")[1] for r in found] == ["D", "B", "A", "C"]
    found = screen(table, [], "price", desc=False, pin="sector", pin_desc=True)["rows"]
    assert [r["symbol"].split(":")[1] for r in found] == ["C", "A", "B", "D"]


def test_etfs_only_when_asked_and_ranked_against_stocks() -> None:
    stocks = [(_meta(f"S{n}"), _bars([50 + n * k / 10 for k in range(120)])) for n in range(4)]
    fund = ({**_meta("FUND"), "etf": True}, _bars([50 + 2 * k for k in range(120)]))
    alone = {r["symbol"]: r["m1_rank"] for r in build_table(stocks, {})}
    table = build_table([*stocks, fund], {})
    assert {r["symbol"]: r["m1_rank"] for r in table if not r["etf"]} == alone
    assert screen(table, [])["total"] == 4
    found = screen(table, [], "m1", etfs=True)["rows"]
    assert found[0]["symbol"] == "NASDAQ:FUND" and found[0]["m1_rank"] == 100.0


def test_growth_fields_filters_and_null_sort() -> None:
    table = [
        {"symbol": "A", "etf": False, "eps_yoy_pct": 35, "revenue_yoy_pct": 25,
         "eps_acceleration": True, "dvol": 12, "d50": 2},
        {"symbol": "B", "etf": False, "eps_yoy_pct": None, "revenue_yoy_pct": 30,
         "eps_acceleration": False, "dvol": 40, "d50": 5},
        {"symbol": "C", "etf": False, "eps_yoy_pct": 45, "revenue_yoy_pct": 40,
         "eps_acceleration": None, "dvol": 40, "d50": 5},
    ]
    rules = clean_rules([
        {"field": "eps_yoy_pct", "op": ">=", "value": 25},
        {"field": "revenue_yoy_pct", "op": ">=", "value": 20},
        {"field": "eps_acceleration", "value": True},
        {"field": "dvol", "op": ">=", "value": 10},
        {"field": "d50", "op": ">=", "value": 0},
    ])
    assert len(rules) == 5
    assert [r["symbol"] for r in screen(table, rules)["rows"]] == ["A"]
    assert [r["symbol"] for r in screen(table, [], "eps_yoy_pct")["rows"]] == ["C", "A", "B"]
    assert [r["symbol"] for r in screen(table, [], "eps_acceleration")["rows"]] == ["A", "B", "C"]
    assert [r["symbol"] for r in screen(table, [
        {"field": "eps_acceleration", "value": False}], "symbol")["rows"]] == ["B"]


def test_screen_joins_updater_summaries_without_deriving(tmp_path, monkeypatch) -> None:
    import json
    from contextlib import closing

    from momo_scan import fundamentals as f

    config = AppConfig()
    config.storage.database = str(tmp_path / "momo.db")
    path = tmp_path / "fundamentals.db"
    payload = {"next_earnings": None, "eps_yoy_pct": 35, "revenue_yoy_pct": 25,
               "eps_annual_yoy_pct": 40, "net_margin_pct": 20, "eps_acceleration": True}
    with closing(f._connect(path)) as db, db:
        db.execute("INSERT INTO summaries VALUES (?,?,?)", ("UP", "2026-10-17",
                                                           json.dumps(payload)))
    monkeypatch.setattr(f, "_load", lambda *args: (_ for _ in ()).throw(
        AssertionError("Screener must not derive fundamentals")))
    app = create_app(config, Path("config/momo.toml"), provider_factory=_Stocks)
    with TestClient(app) as client:
        params = {"filters": json.dumps([
            {"field": "eps_yoy_pct", "op": ">=", "value": 25},
            {"field": "revenue_yoy_pct", "op": ">=", "value": 20},
            {"field": "eps_acceleration", "value": True},
            {"field": "dvol", "op": ">=", "value": 10},
            {"field": "d50", "op": ">=", "value": 0},
        ]), "sort": "eps_yoy_pct"}
        found = client.get("/api/screen", params=params).json()
        assert found["total"] == 1
        assert found["rows"][0]["eps_yoy_pct"] == 35
        assert found["rows"][0]["net_margin_pct"] == 20
        assert len({field["key"] for field in found["fields"]} & {
            "earnings_days", "eps_yoy_pct", "revenue_yoy_pct", "eps_annual_yoy_pct",
            "net_margin_pct", "eps_acceleration"}) == 6
        # A same-session updater publication must not be hidden by the price-table cache.
        payload["eps_yoy_pct"] = None
        with closing(f._connect(path)) as db, db:
            db.execute("UPDATE summaries SET payload=?", (json.dumps(payload),))
        assert client.get("/api/screen", params=params).json()["total"] == 0


def _quote(symbol: str, last: float, volume: float, prev: float = 100.0, open_: float = 101.0):
    from momo_scan.live import Quote

    return Quote(symbol=symbol, last=last, day=date(2030, 1, 2), time=0.0, open=open_,
                 volume=volume, prev_close=prev)


def test_quotes_bring_rows_up_to_today() -> None:
    from datetime import UTC, datetime

    from momo_scan.screener import session_done, with_quotes

    table = build_table(
        [(_meta("UP"), _bars([50 + n for n in range(120)], volume=1e6)),
         (_meta("QUIET"), _bars([20 + n for n in range(120)]))], {},
    )
    noon = datetime(2030, 1, 2, 17, 0, tzinfo=UTC)  # 12:00 ET: 150 of 390 minutes
    assert session_done("2030-01-02", noon) == 150 / 390
    assert session_done("2030-01-01", noon) == 1.0
    live = with_quotes(table, {"UP": _quote("UP", 108.0, 6e6)}, noon)
    up, quiet = live
    assert up["live"] and up["price"] == 108.0 and up["chg"] == 8.0 and up["gap"] == 1.0
    assert up["dvol1"] == 648.0 and up["vol"] == 6e6
    assert up["rvol"] == round(6e6 / (1e6 * 150 / 390), 2)
    assert "live" not in quiet and quiet is table[1]
    movers = [{"field": "chg", "op": ">=", "value": 5}, {"field": "dvol1", "op": ">=", "value": 5}]
    assert [r["symbol"] for r in screen(live, clean_rules(movers))["rows"]] == ["NASDAQ:UP"]
    assert screen(table, clean_rules(movers))["total"] == 0
    # A quote still on the last archived session adds nothing.
    old = _quote("UP", 108.0, 6e6)
    old = replace(old, day=date(2020, 1, 1))
    assert with_quotes(table, {"UP": old})[0] is table[0]


class _SweepFeed:
    name = "fake"
    simulated = False

    def __init__(self) -> None:
        self.swept: list[list[str]] = []

    async def subscribe(self, symbols: frozenset[str]) -> None:
        return None

    async def run(self, emit, ready) -> None:  # type: ignore[no-untyped-def]
        import asyncio

        ready()
        await asyncio.Event().wait()

    async def sweep(self, symbols: list[str]):
        self.swept.append(symbols)
        return [_quote("UP", 108.0, 6e6)]


def test_live_screen_sweeps_for_the_owner_only() -> None:
    feed = _SweepFeed()
    app = create_app(
        AppConfig(), Path("config/momo.toml"), provider_factory=_Stocks, live_provider=feed
    )
    movers = '[{"field":"chg","op":">=","value":5}]'
    with TestClient(app) as client:
        plain = client.get("/api/screen", params={"filters": movers}).json()
        assert plain["total"] == 0 and plain["can_sweep"] is True and plain["sweep"] is None
        assert feed.swept == []  # nothing is requested until the screener asks
        found = client.get("/api/screen", params={"filters": movers, "live": "true"}).json()
        assert [r["symbol"] for r in found["rows"]] == ["NASDAQ:UP"]
        assert found["sweep"]["quotes"] == 1 and found["sweep"]["requests"] == 1
        assert feed.swept[0] == ["UP"]  # ETFs stay out unless asked for


async def test_sweep_stops_with_its_lease() -> None:
    from momo_scan.live import sweep as module

    feed = _SweepFeed()
    sweeping = module.MarketSweep(feed, seconds=0.01)
    sweeping.want(["UP"])
    await sweeping.first(2)
    assert sweeping.quotes["UP"].last == 108.0
    sweeping._lease = 0  # the screener went away
    await sweeping._task
    assert sweeping.quotes == {} and sweeping.stamp is None
    await sweeping.stop()
