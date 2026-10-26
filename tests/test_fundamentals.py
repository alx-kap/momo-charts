from __future__ import annotations

import json
import shutil
import sqlite3
import time
import urllib.request
import zipfile
from contextlib import closing
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from momo_scan import fundamentals as f
from momo_scan.cli import app
from momo_scan.config import AppConfig, load_config
from momo_scan.web.server import create_app

FIXTURES = Path(__file__).parent / "fixtures" / "fundamentals"


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def blocked(*args: Any, **kwargs: Any) -> None:
        pytest.fail("Fundamentals tests must never use the network")

    monkeypatch.setattr(urllib.request, "urlopen", blocked)


@pytest.fixture
def store(tmp_path: Path) -> Path:
    path = tmp_path / "fundamentals.db"
    with closing(f._connect(path)) as db, db:
        db.executemany("INSERT INTO companies(ticker,cik) VALUES (?,?)",
                       [("NVDA", 123), ("TSM", 456)])
        f.save_facts(db, 123, fixture("companyfacts.json"))
        f.save_facts(db, 456, fixture("foreign.json"))
        f.save_submissions(db, 123, fixture("submissions.json"))
        db.execute("INSERT INTO splits VALUES ('NVDA','2024-06-10',4)")
    return path


def test_concept_fallback_and_filing_vintages(store: Path) -> None:
    old = f.load(store, "NASDAQ:NVDA", date(2024, 2, 2))
    assert [q["revenue"] for q in old["quarters"]] == [110, 200, 300, 390]
    assert old["quarters"][0]["filed"]["revenue"] == "2023-05-01"
    current = f.load(store, "nvda", date(2024, 8, 2))
    assert current["quarters"][1]["revenue"] == 220
    assert current["quarters"][1]["filed"]["revenue"] == "2024-08-01"
    assert old["quarters"][1]["revenue"] == 200
    assert current["years"][0]["net_margin_pct"] == 20
    assert current["quarters"][0]["shares"] == 1000


def test_q4_uses_only_public_components(store: Path) -> None:
    before = f.load(store, "NVDA", date(2024, 1, 31))
    assert len(before["quarters"]) == 3
    assert before["years"] == []
    data = f.load(store, "NVDA", date(2024, 2, 1))
    q4 = data["quarters"][-1]
    assert (q4["start"], q4["end"]) == ("2023-10-01", "2023-12-31")
    assert q4["eps"] == pytest.approx(1)
    assert q4["net_income"] == 80
    assert q4["gross_profit"] == 240
    assert q4["filed"]["eps"] == "2024-02-01"
    assert "eps" in q4["derived"]
    # A restated component must change Q4 only once that revision is public.
    latest = f.load(store, "NVDA", date(2024, 8, 1))["quarters"][-1]
    assert latest["eps"] == pytest.approx(.95)
    assert latest["filed"]["eps"] == "2024-08-01"


def test_split_adjustment_does_not_double_adjust_comparatives(store: Path) -> None:
    before = f.load(store, "NVDA", date(2024, 6, 9))
    after = f.load(store, "NVDA", date(2024, 8, 1))
    assert before["quarters"][0]["eps"] == .25
    assert after["quarters"][0]["eps"] == .3
    assert before["quarters"][1]["eps"] == after["quarters"][1]["eps"] == .5
    assert before["years"][0]["eps"] == after["years"][0]["eps"] == 2.5


def test_comparatives_that_were_not_split_restated(store: Path) -> None:
    payload = fixture("companyfacts.json")
    values = payload["facts"]["us-gaap"]["EarningsPerShareDiluted"]["units"]["USD/shares"]
    for row in values:
        if row["filed"] == "2024-08-01" and row["end"] == "2023-06-30":
            row["val"] = 2
    with closing(f._connect(store)) as db, db:
        f.save_facts(db, 123, payload)
    latest = f.load(store, "NVDA", date(2024, 8, 1))
    assert latest["quarters"][1]["eps"] == .5


def test_growth_and_batch_headlines(store: Path) -> None:
    with closing(f._connect(store)) as db, db:
        f.save_facts(db, 123, fixture("growth.json"))
    now = date(2024, 11, 1)
    data = f.load(store, "NVDA", now)
    assert [q["eps_yoy_pct"] for q in data["quarters"][-3:]] == [33.3333, 60, 100]
    assert data["quarters"][-1]["eps_acceleration"] is True
    batch = f.earnings(store, ["NVDA", "TSM"], now)["symbols"]
    assert batch["NVDA"]["quarter_end"] == "2024-09-30"
    assert batch["NVDA"]["eps_yoy_pct"] == 100
    assert batch["NVDA"]["revenue_yoy_pct"] == 60
    assert batch["NVDA"]["eps_acceleration"] is True
    assert batch["TSM"]["eps_yoy_pct"] is None
    assert f.earnings(store, ["NVDA"], date(2025, 2, 1))[
        "symbols"]["NVDA"]["eps_annual_yoy_pct"] == 100
    # Headlines must follow the filing cutoff too.
    assert f.earnings(store, ["NVDA"], date(2024, 10, 31))[
        "symbols"]["NVDA"]["quarter_end"] == "2024-06-30"


def test_api_rounds_derived_values_and_growth(store: Path) -> None:
    with closing(f._connect(store)) as db, db:
        f.save_facts(db, 123, fixture("growth.json"))
    data = f.load(store, "NVDA", date(2024, 11, 1))
    assert data["quarters"][3]["eps"] == .95
    assert data["quarters"][4]["eps_yoy_pct"] == 33.3333
    for period in data["quarters"] + data["years"]:
        for value in period.values():
            if isinstance(value, float):
                assert value == round(value, 4)


def test_estimate_uses_same_fiscal_quarter_and_known_edgar_report(store: Path) -> None:
    with closing(f._connect(store)) as db, db:
        f.save_facts(db, 123, fixture("growth.json"))
    data = f.load(store, "NVDA", date(2024, 11, 1))
    next_event = data["next_earnings"]
    assert next_event["date"] == "2025-01-31"  # 2024-02-02 + 52 weeks
    assert next_event["reference_date"] == "2024-02-02"
    assert next_event["estimated"] is True
    assert next_event["timing"] == "unknown"
    assert next_event["known"] <= data["asof"]
    assert next_event in data["events"]
    batch = f.earnings(store, ["NVDA"], date(2024, 11, 1))
    assert batch["symbols"]["NVDA"]["next_earnings"]["estimated"] is True
    assert f.load(store, "NVDA", date(2024, 10, 31))["next_earnings"] is None
    assert f.load(store, "TSM", date(2024, 11, 1))["next_earnings"] is None


def test_confirmed_calendar_date_replaces_estimate_only_when_known(store: Path) -> None:
    with closing(f._connect(store)) as db, db:
        f.save_facts(db, 123, fixture("growth.json"))
        db.execute("INSERT INTO events VALUES ('NVDA','2025-02-05','after_close',"
                   "'nasdaq','2024-11-02','',.8,1)")
    old = f.load(store, "NVDA", date(2024, 11, 1))["next_earnings"]
    assert old["estimated"] is True
    current = f.load(store, "NVDA", date(2024, 11, 2))["next_earnings"]
    assert current["date"] == "2025-02-05"
    assert current["estimated"] is False
    assert current["eps_estimate"] == .8


def test_projection_moves_weekend_and_ignores_stale_or_future_reports() -> None:
    data = {"symbol": "NVDA", "quarters": [{"end": "2023-12-31"}, {"end": "2024-09-30"}],
            "events": [{"source": "edgar", "date": "2024-02-03", "known": "2024-02-03"}]}
    projected = f._project(data, date(2024, 11, 1))
    assert projected["date"] == "2025-02-03"  # Saturday -> Monday
    assert f._project(data, date(2025, 2, 4)) is None
    data["events"] = []
    assert f._project(data, date(2024, 11, 1)) is None


def test_q4_requires_contiguous_quarters(store: Path) -> None:
    with closing(f._connect(store)) as db, db:
        db.execute("DELETE FROM facts WHERE start='2023-04-01' AND metric='eps'")
    data = f.load(store, "NVDA", date(2024, 2, 1))
    assert data["quarters"][-1]["eps"] is None


def test_ytd_difference_and_noncalendar_fiscal_year(tmp_path: Path) -> None:
    path = tmp_path / "fundamentals.db"
    payload = fixture("companyfacts.json")
    rows = payload["facts"]["us-gaap"]["SalesRevenueNet"]["units"]["USD"]
    base = rows[0]
    payload["facts"]["us-gaap"] = {"Revenues": {"units": {"USD": [
        {**base, "start": "2023-02-01", "end": "2023-04-30", "val": 10},
        {**base, "start": "2023-02-01", "end": "2023-07-31", "val": 30},
        {**base, "start": "2023-02-01", "end": "2023-10-31", "val": 60},
        {**base, "start": "2023-02-01", "end": "2024-01-31", "val": 100,
         "form": "10-K", "filed": "2024-03-01"},
    ]}}}
    with closing(f._connect(path)) as db, db:
        db.execute("INSERT INTO companies(ticker,cik) VALUES ('NVDA',123)")
        f.save_facts(db, 123, payload)
    data = f.load(path, "NVDA", date(2024, 3, 2))
    assert [q["revenue"] for q in data["quarters"]] == [10, 20, 30, 40]
    assert data["years"][0]["end"] == "2024-01-31"


@pytest.mark.parametrize("symbol", ["TSM", "SPY", "NYSE:UNKNOWN"])
def test_foreign_funds_and_unknown_are_empty(store: Path, symbol: str) -> None:
    data = f.load(store, symbol, date(2024, 8, 2))
    assert data["quarters"] == data["years"] == data["events"] == []
    assert data["next_earnings"] is None


def test_missing_store_reads_do_not_create_it(tmp_path: Path) -> None:
    path = tmp_path / "missing" / "fundamentals.db"
    assert f.load(path, "SPY")["quarters"] == []
    assert f.earnings(path, ["SPY"])["symbols"]["SPY"]["next_earnings"] is None
    assert not path.parent.exists()


def bars() -> list[dict[str, Any]]:
    days = [date(2024, 1, 1) + timedelta(days=i) for i in range(65)]
    return [{"date": d.isoformat(), "open": 105, "high": 110, "low": 100, "close": 108}
            for d in days if d.weekday() < 5]


def test_event_timing_and_reaction_sessions(store: Path) -> None:
    events = f.load(store, "NVDA", date(2024, 2, 20))["events"]
    assert [e["timing"] for e in events] == ["before_open", "after_close", "unknown", "unknown"]
    am, pm = [f.reaction(e, bars()) for e in events[:2]]
    assert am["reaction_date"] == "2024-02-02"
    assert pm["reaction_date"] == "2024-02-12"  # Friday after the close -> Monday
    assert am["gap_pct"] == pytest.approx(100 * (105 / 108 - 1))
    assert am["day_pct"] == 0
    assert am["gap_adr"] == pytest.approx(am["gap_pct"] / 10)
    assert am["date_5"] == "2024-02-09"
    assert f.reaction(events[2], bars()) is None
    assert f.reaction(events[3], bars()) is None
    assert f.reaction({"date": "2024-02-03", "timing": "before_open"}, bars())[
        "reaction_date"] == "2024-02-05"
    assert f._timing("2024-07-01T13:00:00Z") == ("2024-07-01", "before_open")
    assert f._timing("2024-07-01T20:00:00Z") == ("2024-07-01", "after_close")


def test_market_readonly_and_reaction_asof(store: Path, tmp_path: Path) -> None:
    path = tmp_path / "market.db"
    with closing(sqlite3.connect(path)) as market, market:
        market.executescript("CREATE TABLE splits(ticker TEXT,date TEXT,ratio REAL);"
                             "CREATE TABLE ohlcv(ticker TEXT,date TEXT,open REAL,high REAL,"
                             "low REAL,close REAL);"
                             "CREATE TABLE mm_universe(ticker TEXT,is_common_stock INTEGER);"
                             "INSERT INTO mm_universe VALUES ('GLD',0),('NVDA',1);")
        market.execute("INSERT INTO splits VALUES ('NVDA','2024-06-10',4)")
        market.executemany("INSERT INTO ohlcv VALUES ('NVDA',?,?,?,?,?)",
                           [(b["date"], b["open"], b["high"], b["low"], b["close"])
                            for b in bars()])
    original = path.read_bytes()
    with closing(f._connect(store)) as db, db:
        db.execute("INSERT INTO companies(ticker,cik,quarterly) VALUES ('GLD',123,1)")
        f.refresh_market(db, path, date(2024, 8, 2))
    assert path.read_bytes() == original
    assert f.load(store, "GLD")["quarters"] == []  # funds can have 10-Q XBRL too
    before = f.load(store, "NVDA", date(2024, 2, 9))
    assert before["events"][-1]["reaction"] is None
    same = f.load(store, "NVDA", date(2024, 2, 12))
    assert same["events"][-1]["reaction"]["date_5"] is None
    assert same["events"][-1]["reaction"]["change_5_pct"] is None
    later = f.load(store, "NVDA", date(2024, 2, 20))
    assert later["events"][1]["reaction"]["date_5"] == "2024-02-19"


class FakeFetcher:
    def __init__(self, tmp_path: Path):
        self.calls: list[str] = []
        self.calendar = fixture("calendar.json")
        self.index = ""
        self.archives = {}
        for kind, name in (("facts", "companyfacts.json"), ("submissions", "submissions.json")):
            path = tmp_path / f"{kind}.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.write(FIXTURES / name, "CIK0000000123.json")
                if kind == "facts":
                    archive.write(FIXTURES / "foreign.json", "CIK0000000456.json")
                else:
                    archive.writestr("CIK0000000123-submissions-001.json", json.dumps({
                        "form": ["8-K"], "items": ["2.02"], "filingDate": ["2020-01-01"],
                        "accessionNumber": ["old-shard"], "acceptanceDateTime": [""],
                    }))
            self.archives[kind] = path

    def json(self, url: str, browser: bool = False) -> Any:
        self.calls.append(url)
        if url == f.TICKERS:
            return {"0": {"ticker": "NVDA", "cik_str": 123},
                    "1": {"ticker": "TSM", "cik_str": 456}}
        if "nasdaq" in url:
            assert browser
            return self.calendar
        if "/submissions/" in url:
            return fixture("submissions.json")
        if "companyfacts" in url:
            return fixture("companyfacts.json")
        pytest.fail(f"Unexpected URL: {url}")

    def text(self, url: str) -> str:
        self.calls.append(url)
        return self.index

    def download(self, url: str, path: Path) -> None:
        self.calls.append(url)
        shutil.copyfile(self.archives["facts" if url == f.FACTS_ZIP else "submissions"], path)

    def check_time(self) -> None:
        pass


def test_bulk_fill_idempotence_and_calendar_history(tmp_path: Path) -> None:
    path, market = tmp_path / "fundamentals.db", tmp_path / "absent.db"
    fetcher = FakeFetcher(tmp_path)
    now = datetime(2024, 8, 2, 16, tzinfo=UTC)
    report = f.update(path, market, now, fetcher=fetcher)
    assert "filled" in report
    assert f.FACTS_ZIP in fetcher.calls and f.SUBMISSIONS_ZIP in fetcher.calls
    assert f.load(path, "NVDA", now.date())["events"][0]["accession"] == "old-shard"
    upcoming = f.load(path, "NVDA", now.date())["next_earnings"]
    assert upcoming["date"] == "2024-08-05"
    assert upcoming["timing"] == "after_close"
    assert upcoming["eps_estimate"] == .75
    assert f.summaries(path)["NVDA"]["next_earnings"] == upcoming
    assert f.earnings(path, ["NVDA"])["symbols"]["NVDA"]["quarter_end"] == "2023-12-31"
    assert f.load(path, "NVDA", date(2024, 8, 1))["next_earnings"] is None
    count = len(fetcher.calls)
    f.update(path, market, now, fetcher=fetcher)
    assert len(fetcher.calls) == count
    # A later calendar snapshot retracts dates; an earlier as-of retains its snapshot.
    fetcher.calendar = {"data": {"rows": None}, "status": {"rCode": 200}}
    f.update(path, market, datetime(2024, 8, 3, 16, tzinfo=UTC), fetcher=fetcher)
    assert f.load(path, "NVDA", date(2024, 8, 3))["next_earnings"] is None
    assert f.summaries(path)["NVDA"]["next_earnings"] is None
    assert f.summaries(path)["NVDA"]["asof"] == "2024-08-03"
    assert f.load(path, "NVDA", now.date())["next_earnings"]["date"] == "2024-08-05"
    assert f.load(path, "NVDA", date(2024, 8, 6))["next_earnings"] is None


def test_incremental_fetches_only_new_filers(tmp_path: Path) -> None:
    path, market = tmp_path / "fundamentals.db", tmp_path / "absent.db"
    fetcher = FakeFetcher(tmp_path)
    f.update(path, market, datetime(2024, 8, 2, 16, tzinfo=UTC), fetcher=fetcher)
    fetcher.calls.clear()
    fetcher.index = ("123|Fixture|10-Q|2024-08-02|edgar/data/123/new-filing.txt\n"
                     "999|Unlisted|10-Q|2024-08-02|edgar/data/999/unlisted.txt\n")
    report = f.update(path, market, datetime(2024, 8, 3, 16, tzinfo=UTC), fetcher=fetcher)
    assert "updated 1 companies" in report
    assert f"{f.DATA}/api/xbrl/companyfacts/CIK0000000123.json" in fetcher.calls
    assert not any("0000000999" in call for call in fetcher.calls)
    assert f.FACTS_ZIP not in fetcher.calls and f.SUBMISSIONS_ZIP not in fetcher.calls
    # An overlapping master index does not refetch the same filing on the next day.
    fetcher.calls.clear()
    f.update(path, market, datetime(2024, 8, 4, 16, tzinfo=UTC), fetcher=fetcher)
    assert not any("companyfacts/" in call or "/submissions/" in call for call in fetcher.calls)


def test_failed_calendar_is_retried_without_losing_history(tmp_path: Path) -> None:
    path, market = tmp_path / "fundamentals.db", tmp_path / "absent.db"
    fetcher = FakeFetcher(tmp_path)
    now = datetime(2024, 8, 2, 16, tzinfo=UTC)
    f.update(path, market, now, fetcher=fetcher)
    fetcher.calendar = {"status": {"rCode": 500}, "data": None}
    with pytest.raises(RuntimeError, match="Nasdaq calendar unavailable"):
        f.update(path, market, datetime(2024, 8, 3, 16, tzinfo=UTC), fetcher=fetcher)
    assert f.load(path, "NVDA", now.date())["next_earnings"] is not None


def test_deadline_stops_bulk_before_request() -> None:
    fetcher = f.Fetcher(f.DEFAULT_AGENT, time.monotonic() - 1)
    with pytest.raises(RuntimeError, match="28-minute"):
        fetcher.open(f.FACTS_ZIP)


def test_overlapping_updates_are_rejected_before_fetching(store: Path) -> None:
    with f._update_lock(store), pytest.raises(RuntimeError, match="already running"):
        f.update(store, store.parent / "absent.db", datetime.now(UTC))


def test_api_reads_previous_snapshot_during_update(store: Path) -> None:
    with closing(f._connect(store)) as db:
        db.execute("UPDATE facts SET value=999 WHERE metric='revenue'")
        assert f.load(store, "NVDA", date(2024, 2, 2))["quarters"][0]["revenue"] == 110
        db.rollback()


def test_api_reads_store_and_validates_asof(store: Path) -> None:
    config = AppConfig()
    config.storage.database = str(store.parent / "momo.db")
    client = TestClient(create_app(config, Path("config/momo.toml")))
    response = client.get("/api/fundamentals/NASDAQ:NVDA?asof=2024-02-02")
    assert response.status_code == 200
    assert response.json()["quarters"][0]["eps"] == .25
    assert client.get("/api/fundamentals/TSM").json()["quarters"] == []
    assert client.get("/api/fundamentals/SPY").json()["quarters"] == []
    assert client.get("/api/fundamentals/NVDA?asof=wrong").status_code == 422
    batch = client.get("/api/earnings?symbols=NVDA,TSM,SPY&asof=2024-02-02")
    assert batch.status_code == 200
    assert set(batch.json()["symbols"]) == {"NVDA", "TSM", "SPY"}
    assert batch.json()["symbols"]["TSM"]["eps_yoy_pct"] is None
    assert client.get("/api/earnings?asof=bad").status_code == 422
    assert client.get("/api/earnings", params={"symbols": ",".join(["NVDA"] * 501)}
                      ).status_code == 400
    assert not (store.parent / "momo.db").exists()


def test_cli_config_and_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = tmp_path / "momo.toml"
    config.write_text('[fundamentals]\nuser_agent="Fixture admin@example.com"\n'
                      '[storage]\ndatabase="/tmp/fixture-momo.db"\n')
    assert load_config(config).fundamentals.user_agent == "Fixture admin@example.com"
    calls = []

    def update(*args: Any) -> str:
        calls.append(args)
        return "fixture updated"

    monkeypatch.setattr(f, "update", update)
    result = CliRunner().invoke(app, ["fundamentals-update", "--config", str(config)])
    assert result.exit_code == 0, result.output
    assert "fixture updated" in result.output
    assert calls[0][0] == Path("/tmp/fundamentals.db")
    assert calls[0][3] == "Fixture admin@example.com"

    def fail(*args: Any) -> str:
        raise RuntimeError("fixture failure")

    monkeypatch.setattr(f, "update", fail)
    result = CliRunner().invoke(app, ["fundamentals-update", "--config", str(config)])
    assert result.exit_code == 1
    assert "fixture failure" in result.output


def test_latest_calendar_cutoff_does_not_move_filing_cutoff(store: Path) -> None:
    with closing(f._connect(store)) as db, db:
        db.execute("INSERT INTO events VALUES "
                   "('NVDA','2024-11-20','after_close','nasdaq','2024-11-02','',1,1)")
        f.save_facts(db, 123, fixture("growth.json"))
    # Friday's bars, calendar fetched Saturday. A cut chart can't know that confirmation.
    strict = f.load(store, "NVDA", date(2024, 11, 1))
    latest = f.load(store, "NVDA", date(2024, 11, 1), date(2024, 11, 2))
    assert strict["next_earnings"]["estimated"] is True
    assert latest["next_earnings"]["estimated"] is False
    assert latest["next_earnings"]["date"] == "2024-11-20"
    assert latest["quarters"] == strict["quarters"]
    assert latest["asof"] == "2024-11-01"
    assert latest["next_asof"] == "2024-11-02"
    config = AppConfig()
    config.storage.database = str(store.parent / "momo.db")
    client = TestClient(create_app(config, None))
    data = client.get("/api/fundamentals/NVDA?asof=2024-11-01&next_asof=2024-11-02").json()
    assert data["next_earnings"]["estimated"] is False


@pytest.mark.parametrize("prior", [0, -2])
def test_yoy_requires_positive_prior_for_quarters_and_years(store: Path, prior: float) -> None:
    with closing(f._connect(store)) as db, db:
        f.save_facts(db, 123, fixture("growth.json"))
        db.execute("UPDATE facts SET value=? WHERE end<'2024-01-01' "
                   "AND metric IN ('eps','revenue')", (prior,))
    data = f.load(store, "NVDA", date(2025, 2, 1))
    for period in data["quarters"] + data["years"]:
        if period["end"].startswith("2024") and (not period["end"].endswith("12-31")
                                                or period in data["years"]):
            assert period["eps_yoy_pct"] is None
            assert period["revenue_yoy_pct"] is None
            assert period["eps_acceleration"] is False
    headline = f.earnings(store, ["NVDA"], date(2024, 11, 1))["symbols"]["NVDA"]
    assert headline["eps_yoy_pct"] is None
    assert f.earnings(store, ["NVDA"], date(2025, 2, 1))[
        "symbols"]["NVDA"]["eps_annual_yoy_pct"] is None


def test_stored_summaries_never_derive_on_current_reads(store: Path, monkeypatch) -> None:
    today = date(2024, 11, 1)
    with closing(f._connect(store)) as db, db:
        f.save_facts(db, 123, fixture("growth.json"))
        f.refresh_summaries(db, today)
    monkeypatch.setattr(f, "_load", lambda *args: pytest.fail("Current reads must be precomputed"))
    batch = f.earnings(store, ["NASDAQ:NVDA", "TSM", "SPY"])["symbols"]
    assert batch["NASDAQ:NVDA"]["eps_yoy_pct"] == 100
    assert batch["TSM"]["eps_yoy_pct"] is None
    assert batch["SPY"]["eps_acceleration"] is None
    rows = f.screen_readings(store, today)
    assert rows["NVDA"]["eps_acceleration"] is True
    assert rows["NVDA"]["earnings_days"] > 0
    assert rows["TSM"]["earnings_days"] is None


def test_earnings_session_counts_match_exchange_holidays() -> None:
    from momo_scan.sessions import sessions_between

    assert sessions_between(date(2026, 10, 17), date(2026, 11, 18)) == 23
    assert sessions_between(date(2026, 10, 17), date(2026, 12, 1)) == 31
    assert sessions_between(date(2024, 3, 28), date(2024, 4, 1)) == 1
    assert sessions_between(date(2025, 1, 8), date(2025, 1, 10)) == 1
