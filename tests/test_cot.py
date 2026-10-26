from datetime import UTC, datetime
from pathlib import Path

import pytest

from momo_scan import cot


def row(code: str, date: str, spec_long: int = 100, spec_short: int = 300) -> dict[str, str]:
    fields = {
        "cftc_contract_market_code": code,
        "report_date_as_yyyy_mm_dd": f"{date}T00:00:00.000",
        "open_interest_all": "1000",
    }
    for key in ("spec", "comm", "small"):
        fields[cot._LONG[key]] = str(spec_long if key == "spec" else 0)
        fields[cot._SHORT[key]] = str(spec_short if key == "spec" else 0)
    return fields


def every_market(date: str) -> list[dict[str, str]]:
    return [row(code, date) for code, *_ in cot.MARKETS]


def at(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


def test_net_is_a_percent_of_open_interest() -> None:
    week = {"oi": 1000, "spec": [100, 300]}
    assert cot.net(week, "spec") == -20


def test_percentile_ranks_against_the_window() -> None:
    values = [1.0, 2.0, 3.0, 4.0]
    assert cot.percentile(values, 4.0) == 88
    assert cot.percentile(values, 1.0) == 12
    assert cot.percentile([5.0], 5.0) == 50


def test_expected_report_follows_the_friday_release() -> None:
    # Friday 2026-10-09 15:29 ET is 19:29 UTC: the 10-06 report is not out yet.
    assert cot.expected_date(at("2026-10-09T19:29:00")).isoformat() == "2026-09-29"
    assert cot.expected_date(at("2026-10-09T19:31:00")).isoformat() == "2026-10-06"
    assert cot.expected_date(at("2026-10-12T14:00:00")).isoformat() == "2026-10-06"


def test_update_fills_an_empty_store_then_stays_quiet(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "cot.db"
    calls: list[str] = []

    def fake(where: str) -> list[dict[str, str]]:
        calls.append(where)
        return every_market("2026-10-06")

    monkeypatch.setattr(cot, "_rows", fake)
    now = at("2026-10-09T20:00:00")
    assert "through 2026-10-06" in cot.update(path, now)
    assert cot.latest_date(path) == "2026-10-06"
    assert cot.update(path, now).startswith("up to date")
    assert len(calls) == 1  # the second call never reached the CFTC


def test_update_fetches_only_rows_after_the_newest(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "cot.db"
    monkeypatch.setattr(cot, "_rows", lambda where: every_market("2026-10-06"))
    cot.update(path, at("2026-10-09T20:00:00"))
    seen: list[str] = []

    def fake(where: str) -> list[dict[str, str]]:
        seen.append(where)
        return every_market("2026-10-13")

    monkeypatch.setattr(cot, "_rows", fake)
    cot.update(path, at("2026-10-16T20:00:00"))
    assert "> '2026-10-06" in seen[0]
    assert len(cot.load(path, "13874A")) == 2


def test_update_before_publication_is_quiet_then_an_error_when_overdue(
    tmp_path: Path, monkeypatch
) -> None:
    path = tmp_path / "cot.db"
    monkeypatch.setattr(cot, "_rows", lambda where: every_market("2026-09-29"))
    assert "not published yet" in cot.update(path, at("2026-10-09T19:40:00"))
    with pytest.raises(RuntimeError):
        cot.update(path, at("2026-10-22T12:00:00"))


def test_history_reads_the_store(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "cot.db"
    monkeypatch.setattr(cot, "_rows", lambda where: every_market("2026-10-06"))
    cot.update(path, at("2026-10-09T20:00:00"))
    data = cot.history(path, "13874A")
    assert data["series"]["spec"] == [-20.0]
    with pytest.raises(KeyError):
        cot.history(path, "nope")
