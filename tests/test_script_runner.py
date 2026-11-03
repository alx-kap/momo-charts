"""The worker processes that run momo scripts with a time limit (src/momo_scan/script/runner.py)
and the `momo script` commands."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from momo_scan.script.runner import Pool

ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "tests" / "script_cases"
HEAD = '#momo 1\nindicator("T")\n'


def bars(n=60):
    return {
        "time": [1.7e9 + i * 86400 for i in range(n)],
        "open": [100.0 + i for i in range(n)], "high": [101.0 + i for i in range(n)],
        "low": [99.0 + i for i in range(n)], "close": [100.5 + i for i in range(n)],
        "volume": [1e6] * n,
    }


@pytest.fixture(scope="module")
def pool():
    with Pool(2, seconds=10) as pool:
        yield pool


def test_a_run_comes_back_whole(pool):
    out = pool.run(HEAD + 'plot(ta.sma(close, 3), "m")\nsignal("up", close > open)\n', bars())
    assert out["ok"]
    assert out["plots"]["m"]["values"][2] == pytest.approx(101.5)
    assert out["signals"]["up"][-1] == 1
    assert out["meta"]["title"] == "T"


def test_last_bar_only(pool):
    out = pool.run(HEAD + 'plot(close, "c")\nsignal("up", close > open)\nvalue("x", 2)\n',
                   bars(), last_only=True)
    assert out["last"]["plots"] == {"c": 159.5}
    assert out["last"]["signals"] == {"up": True, "x": 2.0}


def test_compile_errors_come_back_without_a_worker(pool):
    out = pool.run("plot(", bars())
    assert not out["ok"] and out["errors"][0]["code"] == "E111"


def test_a_script_that_runs_too_long_is_killed_and_the_pool_carries_on(pool):
    forever = HEAD + "var n = 0\nwhile true:\n    n += 1\nplot(n, 'n')\n"
    # Stopped by the loop-step limit when that comes first, by the clock otherwise.
    out = pool.run(forever, bars(), seconds=0.05)
    assert not out["ok"] and out["error"]["code"] in ("R401", "R402")
    again = pool.run(HEAD + 'plot(close, "c")\n', bars())
    assert again["ok"]


def test_the_clock_kills_a_worker_that_does_not_answer(pool):
    slow = HEAD + "var n = 0\nfor i in range(900000):\n    n += 1\nplot(n, 'n')\n"
    out = pool.run(slow, bars(2), seconds=0.01)
    assert not out["ok"] and out["error"]["code"] == "R401"
    assert pool.run(HEAD + 'plot(close, "c")\n', bars())["ok"]


def test_screen_runs_every_symbol_and_caches_until_the_next_bar(pool):
    source = HEAD + 'signal("up", close > open)\nvalue("c", close)\n'
    universe = {f"S{i}": (bars(40 + i), {}) for i in range(7)}
    first = pool.screen(source, universe)
    assert set(first) == set(universe) and all(r["ok"] for r in first.values())
    assert first["S3"]["last"]["signals"]["c"] == 100.5 + 42
    again = pool.screen(source, universe)
    assert again["S3"] is first["S3"]                     # from the cache, not run again
    universe["S3"] = (bars(50), {})                        # a new bar
    assert pool.screen(source, universe)["S3"]["last"]["signals"]["c"] == 100.5 + 49


def test_a_run_error_is_a_result_not_a_crash(pool):
    source = HEAD + 'n = input.int(3, "N")\nplot(ta.sma(close, n), "x")\n'
    out = pool.run(source, bars(), inputs={"N": 0, "n": 0})
    assert not out["ok"] and out["error"]["code"] == "R404"


# ---- the commands ---------------------------------------------------------------------------


def run_cli(*args):
    from momo_scan.cli import app

    return CliRunner().invoke(app, ["script", *args])


def test_check_reports_errors_with_positions(tmp_path):
    bad = tmp_path / "bad.momo"
    bad.write_text(HEAD + "x = clsoe\n")
    result = run_cli("check", str(bad))
    assert result.exit_code == 1
    assert "bad.momo:3:5: E201" in result.output and "Did you mean `close`?" in result.output


def test_check_says_ok(tmp_path):
    good = tmp_path / "good.momo"
    good.write_text(HEAD + 'plot(ta.sma(close, 20), "m")\n')
    result = run_cli("check", str(good))
    assert result.exit_code == 0 and result.output.startswith("OK: T (0 inputs, 1 plots")
    parsed = json.loads(run_cli("check", str(good), "--json").output)
    assert parsed["ok"] and parsed["meta"]["needs"]["history"] == 20


def test_check_json_errors(tmp_path):
    bad = tmp_path / "bad.momo"
    bad.write_text("x = (")
    parsed = json.loads(run_cli("check", str(bad), "--json").output)
    assert parsed["ok"] is False and parsed["errors"][0]["code"] == "E111"


def test_run_needs_a_script_that_checks(tmp_path):
    bad = tmp_path / "bad.momo"
    bad.write_text("x = (")
    result = run_cli("run", str(bad), "--symbol", "NVDA")
    assert result.exit_code == 1 and "E111" in result.output


def test_run_prints_the_last_values(tmp_path, monkeypatch):
    from momo_scan import cli

    async def fake(config, symbol, interval, count):
        data = bars(30)
        return data, [f"2026-01-{i + 1:02d}" for i in range(30)], symbol

    monkeypatch.setattr(cli, "_script_bars", fake)
    script = tmp_path / "s.momo"
    script.write_text(HEAD + 'plot(close, "c")\nsignal("up", close > open)\n')
    result = run_cli("run", str(script), "--symbol", "NVDA", "--last", "2")
    assert result.exit_code == 0, result.output
    assert "2026-01-30" in result.output and "129.5" in result.output and "yes" in result.output
    parsed = json.loads(run_cli("run", str(script), "--symbol", "NVDA", "--last", "2",
                                "--json").output)
    assert [r["c"] for r in parsed["rows"]] == [128.5, 129.5]
    assert parsed["rows"][-1]["up"] is True
