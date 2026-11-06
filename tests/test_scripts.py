"""Stored momo scripts: versions, drafts, the trash, accounts, the API and the CLI."""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from momo_scan import scripts as scripts_module
from momo_scan.cli import app as cli_app
from momo_scan.config import AppConfig
from momo_scan.providers.fixture import FixtureProvider
from momo_scan.script.compile import check_source
from momo_scan.script.limits import LIMITS
from momo_scan.scripts import ScriptRefused, Scripts, problems
from momo_scan.storage import Storage
from momo_scan.web.server import create_app

GOOD = '#momo 1\nindicator("One", overlay=true)\nplot(ta.sma(close, 10))\n'
BETTER = '#momo 1\nindicator("One", overlay=true)\nplot(ta.sma(close, 20))\n'
BROKEN = '#momo 1\nindicator("One", overlay=true)\nplot(clsoe)\n'
HEADERS = {"X-Momo": "1"}


@pytest.fixture
def scripts(tmp_path: Path) -> Scripts:
    return Scripts(Storage(tmp_path / "momo.db"))


def test_save_adds_versions_and_unchanged_text_does_nothing(scripts: Scripts) -> None:
    made = scripts.create("owner", "One", GOOD, "first")
    assert (made["head"], made["source"], made["errors"]) == (1, GOOD, [])

    saved = scripts.save("owner", made["id"], BETTER, "longer")
    assert saved and saved["saved"] and saved["head"] == 2 and saved["source"] == BETTER

    same = scripts.save("owner", made["id"], BETTER, "ignored")
    assert same and not same["saved"] and same["head"] == 2

    versions = scripts.versions("owner", made["id"])
    assert versions is not None
    assert [(v["version"], v["note"]) for v in versions] == [(2, "longer"), (1, "first")]
    assert versions[0]["size"] == len(BETTER)
    old = scripts.version("owner", made["id"], 1)
    assert old and old["source"] == GOOD
    assert scripts.version("owner", made["id"], 9) is None


def test_restore_saves_a_new_version_and_keeps_history(scripts: Scripts) -> None:
    made = scripts.create("owner", "One", GOOD)
    scripts.save("owner", made["id"], BROKEN)
    restored = scripts.restore("owner", made["id"], 1)
    assert restored and restored["head"] == 3 and restored["source"] == GOOD
    assert restored["errors"] == []
    versions = scripts.versions("owner", made["id"])
    assert versions and [v["note"] for v in versions] == ["Restored v1", "", ""]
    assert scripts.version("owner", made["id"], 2)["source"] == BROKEN  # type: ignore[index]
    assert scripts.restore("owner", made["id"], 9) is None


def test_a_save_with_errors_is_kept_with_them(scripts: Scripts) -> None:
    made = scripts.create("owner", "One", GOOD)
    saved = scripts.save("owner", made["id"], BROKEN)
    assert saved and saved["head"] == 2
    assert [e["code"] for e in saved["errors"]] == ["E201"]
    assert saved["errors"][0]["fix"] == "Did you mean `close`?"
    assert scripts.get("owner", made["id"])["errors"] == saved["errors"]  # type: ignore[index]
    assert scripts.list("owner")[0]["errors"] == 1


def test_draft_follows_the_script_until_saved(scripts: Scripts) -> None:
    made = scripts.create("owner", "One", GOOD)
    assert scripts.set_draft("owner", made["id"], BETTER)
    script = scripts.get("owner", made["id"])
    assert script and script["draft"] == BETTER and script["has_draft"]
    assert script["source"] == GOOD and script["head"] == 1

    assert scripts.set_draft("owner", made["id"], GOOD)  # back to the saved text: no draft
    assert scripts.get("owner", made["id"])["draft"] is None  # type: ignore[index]

    scripts.set_draft("owner", made["id"], BETTER)
    scripts.save("owner", made["id"], BETTER)
    assert scripts.get("owner", made["id"])["draft"] is None  # type: ignore[index]


def test_trash_undelete_and_purge(scripts: Scripts) -> None:
    made = scripts.create("owner", "One", GOOD)
    assert scripts.delete("owner", made["id"])
    assert not scripts.delete("owner", made["id"])
    assert scripts.list("owner")[0]["in_trash"]
    assert scripts.list("owner", trash=False) == []
    assert scripts.by_name("owner", "One") is None
    assert scripts.save("owner", made["id"], BETTER) is None
    assert not scripts.set_draft("owner", made["id"], BETTER)
    assert scripts.update("owner", made["id"], name="Two") is None
    assert scripts.restore("owner", made["id"], 1) is None

    # Its name is free while it's away, and taken again stops it coming back.
    other = scripts.create("owner", "one", BETTER)
    with pytest.raises(ScriptRefused) as refused:
        scripts.undelete("owner", made["id"])
    assert refused.value.status == 409
    scripts.update("owner", other["id"], name="Other")
    back = scripts.undelete("owner", made["id"])
    assert back and not back["in_trash"]
    assert scripts.undelete("owner", made["id"]) is None

    # 29 days stays, 31 goes, versions with it, and the id is never used again.
    scripts.delete("owner", made["id"])
    last = scripts.create("owner", "Last", GOOD)
    scripts.delete("owner", last["id"])
    day = lambda n: (datetime.now(UTC) - timedelta(days=n)).isoformat(timespec="seconds")  # noqa: E731
    with scripts.db:
        scripts.db.execute("UPDATE scripts SET deleted_at=? WHERE id=?", (day(29), made["id"]))
        scripts.db.execute("UPDATE scripts SET deleted_at=? WHERE id=?", (day(31), last["id"]))
    assert {s["id"] for s in scripts.list("owner")} == {made["id"], other["id"]}
    left = scripts.db.execute(
        "SELECT COUNT(*) FROM script_versions WHERE script_id=?", (last["id"],)
    ).fetchone()[0]
    assert left == 0
    assert scripts.create("owner", "New", GOOD)["id"] > last["id"]


def test_another_account_cannot_see_or_touch_a_script(scripts: Scripts) -> None:
    made = scripts.create("owner", "One", GOOD)
    script_id = made["id"]
    assert scripts.list("sam") == []
    assert scripts.get("sam", script_id) is None
    assert scripts.by_name("sam", "One") is None
    assert scripts.versions("sam", script_id) is None
    assert scripts.version("sam", script_id, 1) is None
    assert scripts.save("sam", script_id, BETTER) is None
    assert scripts.restore("sam", script_id, 1) is None
    assert not scripts.set_draft("sam", script_id, BETTER)
    assert scripts.update("sam", script_id, name="Mine") is None
    assert not scripts.delete("sam", script_id)
    assert scripts.undelete("sam", script_id) is None
    script = scripts.get("owner", script_id)
    assert script and script["head"] == 1 and script["name"] == "One" and not script["draft"]
    assert scripts.create("sam", "One", GOOD)["id"] != script_id  # names are per account


def test_rename_favourite_and_names(scripts: Scripts) -> None:
    one = scripts.create("owner", "One", GOOD)
    two = scripts.create("owner", "Two", GOOD)
    assert scripts.by_name("owner", " ONE ")["id"] == one["id"]  # type: ignore[index]
    with pytest.raises(ScriptRefused) as taken:
        scripts.create("owner", "one", GOOD)
    assert taken.value.status == 409
    with pytest.raises(ScriptRefused):
        scripts.update("owner", two["id"], name="ONE")
    assert scripts.update("owner", one["id"], name="ONE")["name"] == "ONE"  # type: ignore[index]
    changed = scripts.update("owner", two["id"], favourite=True)
    assert changed and changed["favourite"] and changed["head"] == 1
    for bad in ("", "   ", "x" * 81, "a\nb", "\ud800"):
        with pytest.raises(ScriptRefused):
            scripts.create("owner", bad, GOOD)


def test_limits(scripts: Scripts, monkeypatch: pytest.MonkeyPatch) -> None:
    made = scripts.create("owner", "One", GOOD)
    long = "x" * (LIMITS["source"] + 1)
    for attempt in (
        lambda: scripts.create("owner", "Two", long),
        lambda: scripts.save("owner", made["id"], long),
        lambda: scripts.set_draft("owner", made["id"], long),
    ):
        with pytest.raises(ScriptRefused) as refused:
            attempt()
        assert refused.value.status == 413
    with pytest.raises(ScriptRefused):
        scripts.save("owner", made["id"], "\ud800")
    with pytest.raises(ScriptRefused):
        scripts.save("owner", made["id"], BETTER, "n" * 501)

    monkeypatch.setattr(scripts_module, "MAX_VERSIONS", 2)
    scripts.save("owner", made["id"], BETTER)
    with pytest.raises(ScriptRefused):
        scripts.save("owner", made["id"], BROKEN)

    monkeypatch.setattr(scripts_module, "MAX_SCRIPTS", 1)
    with pytest.raises(ScriptRefused):
        scripts.create("owner", "Two", GOOD)
    scripts.create("sam", "Two", GOOD)  # per account

    monkeypatch.setattr(scripts_module, "MAX_VERSIONS", 1000)
    monkeypatch.setattr(scripts_module, "MAX_BYTES", len(GOOD) + len(BETTER) + 5)
    with pytest.raises(ScriptRefused):
        scripts.save("owner", made["id"], BROKEN)


def test_a_script_full_of_typos_is_checked_quickly() -> None:
    lines = "".join(f"a{i} = nope{i}\n" for i in range(6000))
    started = time.perf_counter()
    result = check_source(f'#momo 1\nindicator("x")\n{lines}')
    assert time.perf_counter() - started < 2
    assert len(result["errors"]) == 6000
    assert all(error["fix"] is None for error in result["errors"][10:])
    assert len(problems(f'#momo 1\nindicator("x")\n{lines}')) == scripts_module.MAX_ERRORS


def test_error_text_with_emoji_can_be_sent(scripts: Scripts) -> None:
    made = scripts.create("owner", "One", '#momo 1\nindicator("x")\nplot(😀)\n')
    assert made["errors"]
    str(made["errors"]).encode("utf-8")


def _client(fixture_path: Path, tmp_path: Path) -> TestClient:
    config = AppConfig()
    config.storage.database = str(tmp_path / "data" / "momo.db")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "access.toml").write_text('[accounts.sam]\nlogin = "sam@example.com"\n')
    return TestClient(create_app(
        config, Path("config/momo.toml"), provider_factory=lambda: FixtureProvider(fixture_path),
    ))


def test_scripts_api(fixture_path: Path, tmp_path: Path) -> None:
    with _client(fixture_path, tmp_path) as client:
        assert client.post("/api/scripts", json={"name": "One", "source": GOOD}).status_code == 403

        made = client.post(
            "/api/scripts", json={"name": "One", "source": GOOD, "note": "first"}, headers=HEADERS
        ).json()
        url = f"/api/scripts/{made['id']}"
        assert made["head"] == 1 and made["errors"] == []
        again = client.post("/api/scripts", json={"name": "one", "source": GOOD}, headers=HEADERS)
        assert again.status_code == 409 and "already" in again.json()["detail"]

        assert client.put(f"{url}/draft", json={"source": BETTER}, headers=HEADERS).json() == {
            "saved": True
        }
        assert client.get(url).json()["draft"] == BETTER
        listed = client.get("/api/scripts").json()["scripts"][0]
        assert listed["has_draft"] and listed["id"] == made["id"] and "source" not in listed

        broken = client.post(
            f"{url}/versions", json={"source": BROKEN, "note": "oops"}, headers=HEADERS
        ).json()
        assert broken["saved"] and broken["head"] == 2 and broken["draft"] is None
        assert broken["errors"][0]["code"] == "E201"

        versions = client.get(f"{url}/versions").json()["versions"]
        assert [v["version"] for v in versions] == [2, 1]
        assert client.get(f"{url}/versions/1").json()["source"] == GOOD
        assert client.get(f"{url}/versions/7").status_code == 404

        restored = client.post(f"{url}/restore", json={"version": 1}, headers=HEADERS).json()
        assert restored["head"] == 3 and restored["errors"] == [] and restored["source"] == GOOD
        missing = client.post(f"{url}/restore", json={"version": 7}, headers=HEADERS)
        assert missing.status_code == 404

        changed = client.patch(url, json={"name": "Two", "favourite": True}, headers=HEADERS)
        assert changed.json()["name"] == "Two" and changed.json()["favourite"]

        too_long = client.post(
            f"{url}/versions", json={"source": "x" * (LIMITS["source"] + 1)}, headers=HEADERS
        )
        assert too_long.status_code == 413
        lone = client.post(
            f"{url}/versions", content='{"source": "\\ud800"}',
            headers={**HEADERS, "Content-Type": "application/json"},
        )
        assert lone.status_code in (400, 422)

        assert client.delete(url).status_code == 403
        assert client.delete(url, headers=HEADERS).json() == {"saved": True}
        assert client.get(url).json()["in_trash"]
        assert client.post(f"{url}/versions", json={"source": BETTER}, headers=HEADERS).status_code == 404  # noqa: E501
        assert client.delete(url, headers=HEADERS).status_code == 404
        assert not client.post(f"{url}/undelete", headers=HEADERS).json()["in_trash"]
        assert client.post(f"{url}/undelete", headers=HEADERS).status_code == 404


def test_scripts_api_keeps_accounts_apart(fixture_path: Path, tmp_path: Path) -> None:
    sam = {
        "Tailscale-Headers-Info": "x", "Tailscale-User-Login": "sam@example.com", **HEADERS,
    }
    with _client(fixture_path, tmp_path) as client:
        made = client.post(
            "/api/scripts", json={"name": "One", "source": GOOD}, headers=HEADERS
        ).json()
        url = f"/api/scripts/{made['id']}"
        calls = [
            client.get(url, headers=sam),
            client.get(f"{url}/versions", headers=sam),
            client.get(f"{url}/versions/1", headers=sam),
            client.patch(url, json={"name": "Mine"}, headers=sam),
            client.put(f"{url}/draft", json={"source": BETTER}, headers=sam),
            client.post(f"{url}/versions", json={"source": BETTER}, headers=sam),
            client.post(f"{url}/restore", json={"version": 1}, headers=sam),
            client.delete(url, headers=sam),
            client.post(f"{url}/undelete", headers=sam),
        ]
        assert [call.status_code for call in calls] == [404] * len(calls)
        assert client.get("/api/scripts", headers=sam).json() == {"scripts": []}
        script = client.get(url).json()
        assert script["name"] == "One" and script["head"] == 1 and script["draft"] is None


def test_cli_saves_lists_and_rolls_back(tmp_path: Path) -> None:
    config = tmp_path / "momo.toml"
    config.write_text(f'[storage]\ndatabase = "{tmp_path / "momo.db"}"\n')
    file = tmp_path / "one.momo"
    run = lambda *args: CliRunner().invoke(  # noqa: E731
        cli_app, ["script", *args, "--config", str(config)]
    )

    file.write_text(GOOD)
    assert "Saved Squeeze v1" in run("save", str(file), "--name", "Squeeze", "--note", "a").stdout
    assert "No change" in run("save", str(file), "--name", "squeeze").stdout

    file.write_text(BROKEN)
    bad = run("save", str(file), "--name", "Squeeze", "--note", "typo")
    assert bad.exit_code == 1 and "Saved Squeeze v2" in bad.stdout and "E201" in bad.output

    assert "1 errors" in run("list").stdout
    history = run("versions", "Squeeze").stdout
    assert history.index("v2") < history.index("v1") and "typo" in history

    back = run("restore", "Squeeze", "1")
    assert back.exit_code == 0 and "Saved Squeeze v3" in back.stdout
    assert "errors" not in run("list").stdout

    assert run("restore", "Squeeze", "9").exit_code == 1
    assert run("versions", "Nope").exit_code == 1
    assert run("restore", "Nope", "1").exit_code == 1

    with Storage(tmp_path / "momo.db") as storage:
        rows = Scripts(storage).list("owner")
    assert [(r["name"], r["head"]) for r in rows] == [("Squeeze", 3)]
