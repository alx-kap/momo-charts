"""Stored momo scripts: per account, with every save kept as a version.

`head` is the version charts use. Saving adds a version and moves it; saving unchanged text does
nothing. Restoring never rewrites history: it saves the old text as a new version, so `head` is
always the newest version. A save with errors is kept all the same (a bad save is one restore
away) and its errors stay in `meta_json` for whoever opens the script next.

`draft` is the editor's unsaved text, NULL when there is none. Deleting moves a script to the
trash, which empties after 30 days.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from momo_scan.script.compile import check_source
from momo_scan.script.lexer import from_utf16, utf16
from momo_scan.script.limits import LIMITS
from momo_scan.storage import Storage

# AUTOINCREMENT: charts name scripts by id, so a purged script's id is never handed out again.
SCHEMA = """
CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'owner',
    name TEXT NOT NULL,
    head INTEGER NOT NULL,
    draft TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS script_versions (
    script_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    source TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (script_id, version)
);
"""

TRASH_DAYS = 30
MAX_NAME = 80
MAX_NOTE = 500
MAX_SCRIPTS = 500  # per account, the trash included
MAX_VERSIONS = 1000  # per script
MAX_BYTES = 50_000_000  # every version of every script of an account
MAX_ERRORS = 100  # kept with a save


class ScriptRefused(Exception):
    """A change momo won't make; `status` is its HTTP status."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def _now() -> datetime:
    return datetime.now(UTC)


def _stamp(at: datetime) -> str:
    return at.isoformat(timespec="seconds")


def _clean_name(name: str) -> str:
    name = _clean_text(name, "name", MAX_NAME).strip()
    if not name:
        raise ScriptRefused("A script needs a name")
    return name


def _clean_text(text: str, what: str, limit: int) -> str:
    if len(text) > limit:
        raise ScriptRefused(f"The {what} can be at most {limit} characters")
    if any(ord(c) < 32 for c in text):
        raise ScriptRefused(f"The {what} can't hold control characters")
    _check_encodable(text, what)
    return text


def _check_encodable(text: str, what: str) -> None:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ScriptRefused(f"The {what} isn't valid text") from error


def _check_source(source: str) -> None:
    size = len(utf16(source))
    if size > LIMITS["source"]:
        raise ScriptRefused(
            f"A script can be at most {LIMITS['source']:,} characters; this one has {size:,}", 413
        )
    _check_encodable(source, "script")


def problems(source: str) -> list[dict[str, Any]]:
    """What the checker says about a script, ready to store and send. Slow on a hostile script
    (seconds), so the server calls this off its event loop."""
    result = check_source(source)
    if result["ok"]:
        return []
    return [
        {**error, "message": from_utf16(error["message"]),
         "fix": error["fix"] and from_utf16(error["fix"])}
        for error in result["errors"][:MAX_ERRORS]
    ]


def _summary(row: sqlite3.Row) -> dict[str, Any]:
    meta = json.loads(row["meta_json"])
    return {
        "id": row["id"], "name": row["name"], "head": row["head"],
        "created_at": row["created_at"], "updated_at": row["updated_at"],
        "favourite": bool(meta.get("favourite")), "has_draft": row["draft"] is not None,
        "errors": len(meta.get("errors", [])), "in_trash": row["deleted_at"] is not None,
    }


class Scripts:
    def __init__(self, storage: Storage):
        self.db: sqlite3.Connection = storage.connection
        self.db.executescript(SCHEMA)
        self.purge()

    def purge(self) -> int:
        """Empties what has been in the trash for 30 days, for every account."""
        cutoff = _stamp(_now() - timedelta(days=TRASH_DAYS))
        with self.db:
            self.db.execute(
                "DELETE FROM script_versions WHERE script_id IN "
                "(SELECT id FROM scripts WHERE deleted_at < ?)", (cutoff,),
            )
            return self.db.execute(
                "DELETE FROM scripts WHERE deleted_at < ?", (cutoff,)
            ).rowcount

    def _row(self, user: str, script_id: int, trash: bool = False) -> sqlite3.Row | None:
        """A script of this account; one in the trash only if `trash`."""
        row = self.db.execute(
            "SELECT * FROM scripts WHERE user_id=? AND id=?", (user, script_id)
        ).fetchone()
        return row if row and (trash or row["deleted_at"] is None) else None

    def list(self, user: str, trash: bool = True) -> list[dict[str, Any]]:
        """Every script of an account, the latest saved first."""
        self.purge()
        rows = self.db.execute(
            "SELECT * FROM scripts WHERE user_id=? ORDER BY updated_at DESC, id DESC", (user,)
        )
        return [s for s in map(_summary, rows) if trash or not s["in_trash"]]

    def by_name(self, user: str, name: str) -> dict[str, Any] | None:
        """The live script with this name, whatever its case."""
        row = self.db.execute(
            "SELECT * FROM scripts WHERE user_id=? AND name=? COLLATE NOCASE "
            "AND deleted_at IS NULL", (user, name.strip()),
        ).fetchone()
        return _summary(row) if row else None

    def get(self, user: str, script_id: int) -> dict[str, Any] | None:
        """A script with its head source, draft and the errors of its head."""
        row = self._row(user, script_id, trash=True)
        if row is None:
            return None
        source = self.db.execute(
            "SELECT source FROM script_versions WHERE script_id=? AND version=?",
            (script_id, row["head"]),
        ).fetchone()["source"]
        meta = json.loads(row["meta_json"])
        return {
            **_summary(row), "source": source, "draft": row["draft"],
            "errors": meta.get("errors", []), "copied_from": meta.get("copied_from"),
        }

    def _check_name_free(self, user: str, name: str, script_id: int | None = None) -> None:
        taken = self.by_name(user, name)
        if taken and taken["id"] != script_id:
            raise ScriptRefused(f"You already have a script called {taken['name']}", 409)

    def _check_room(self, user: str, added: str) -> None:
        used = self.db.execute(
            "SELECT COALESCE(SUM(LENGTH(CAST(v.source AS BLOB))), 0) FROM script_versions v "
            "JOIN scripts s ON s.id = v.script_id WHERE s.user_id=?", (user,),
        ).fetchone()[0]
        if used + len(added.encode("utf-8")) > MAX_BYTES:
            raise ScriptRefused("Your scripts are full: empty the trash or delete some", 409)

    def create(
        self, user: str, name: str, source: str, note: str = "",
        errors: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """A new script with `source` as v1. `errors` saves running the checker again."""
        name = _clean_name(name)
        note = _clean_text(note, "note", MAX_NOTE)
        _check_source(source)
        self._check_name_free(user, name)
        count = self.db.execute(
            "SELECT COUNT(*) FROM scripts WHERE user_id=?", (user,)
        ).fetchone()[0]
        if count >= MAX_SCRIPTS:
            raise ScriptRefused(f"An account can hold {MAX_SCRIPTS} scripts", 409)
        self._check_room(user, source)
        meta = {"errors": problems(source) if errors is None else errors}
        now = _stamp(_now())
        with self.db:
            script_id = self.db.execute(
                "INSERT INTO scripts (user_id, name, head, meta_json, created_at, updated_at) "
                "VALUES (?, ?, 1, ?, ?, ?)", (user, name, json.dumps(meta), now, now),
            ).lastrowid
            self.db.execute(
                "INSERT INTO script_versions (script_id, version, source, note, created_at) "
                "VALUES (?, 1, ?, ?, ?)", (script_id, source, note, now),
            )
        script = self.get(user, script_id)
        assert script is not None
        return script

    def save(
        self, user: str, script_id: int, source: str, note: str = "",
        errors: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        """A new version, unless the text is the head's: then nothing but the draft goes.
        None if there is no such script (or it is in the trash)."""
        note = _clean_text(note, "note", MAX_NOTE)
        _check_source(source)
        row = self._row(user, script_id)
        if row is None:
            return None
        current = self.get(user, script_id)
        assert current is not None
        if source == current["source"]:
            with self.db:
                self.db.execute("UPDATE scripts SET draft=NULL WHERE id=?", (script_id,))
            return {**current, "draft": None, "has_draft": False, "saved": False}
        if row["head"] >= MAX_VERSIONS:
            raise ScriptRefused(f"A script can hold {MAX_VERSIONS} versions", 409)
        self._check_room(user, source)
        meta = json.loads(row["meta_json"])
        meta["errors"] = problems(source) if errors is None else errors
        now = _stamp(_now())
        # The UPDATE first: it takes the write lock, so two saves can't share a number.
        with self.db:
            version = self.db.execute(
                "UPDATE scripts SET head=head+1, draft=NULL, meta_json=?, updated_at=? "
                "WHERE id=? RETURNING head", (json.dumps(meta), now, script_id),
            ).fetchone()["head"]
            self.db.execute(
                "INSERT INTO script_versions (script_id, version, source, note, created_at) "
                "VALUES (?, ?, ?, ?, ?)", (script_id, version, source, note, now),
            )
        saved = self.get(user, script_id)
        assert saved is not None
        return {**saved, "saved": True}

    def restore(
        self, user: str, script_id: int, version: int,
        errors: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        """Saves an old version's text as a new version. The draft goes with it, as with any
        save. None if the script or the version doesn't exist."""
        if self._row(user, script_id) is None:
            return None
        old = self.version(user, script_id, version)
        if old is None:
            return None
        return self.save(user, script_id, old["source"], f"Restored v{version}", errors)

    def set_draft(self, user: str, script_id: int, source: str) -> bool:
        """Autosave. Text equal to the head's means there's no draft."""
        _check_source(source)
        current = self.get(user, script_id)
        if current is None or current["in_trash"]:
            return False
        draft = None if source == current["source"] else source
        with self.db:
            self.db.execute("UPDATE scripts SET draft=? WHERE id=?", (draft, script_id))
        return True

    def update(
        self, user: str, script_id: int, name: str | None = None, favourite: bool | None = None
    ) -> dict[str, Any] | None:
        """Rename, or mark a favourite. Neither is a new version."""
        row = self._row(user, script_id)
        if row is None:
            return None
        meta = json.loads(row["meta_json"])
        if favourite is not None:
            meta["favourite"] = favourite
        new_name = row["name"]
        if name is not None:
            new_name = _clean_name(name)
            self._check_name_free(user, new_name, script_id)
        with self.db:
            self.db.execute(
                "UPDATE scripts SET name=?, meta_json=?, updated_at=? WHERE id=?",
                (new_name, json.dumps(meta), _stamp(_now()), script_id),
            )
        return self.get(user, script_id)

    def versions(self, user: str, script_id: int) -> list[dict[str, Any]] | None:
        """Newest first: number, time, note and size in bytes."""
        if self._row(user, script_id, trash=True) is None:
            return None
        rows = self.db.execute(
            "SELECT version, created_at, note, LENGTH(CAST(source AS BLOB)) AS size "
            "FROM script_versions WHERE script_id=? ORDER BY version DESC", (script_id,),
        )
        return [dict(row) for row in rows]

    def version(self, user: str, script_id: int, version: int) -> dict[str, Any] | None:
        if self._row(user, script_id, trash=True) is None:
            return None
        row = self.db.execute(
            "SELECT version, source, note, created_at FROM script_versions "
            "WHERE script_id=? AND version=?", (script_id, version),
        ).fetchone()
        return dict(row) if row else None

    def delete(self, user: str, script_id: int) -> bool:
        """To the trash."""
        if self._row(user, script_id) is None:
            return False
        with self.db:
            self.db.execute(
                "UPDATE scripts SET deleted_at=? WHERE id=?", (_stamp(_now()), script_id)
            )
        return True

    def undelete(self, user: str, script_id: int) -> dict[str, Any] | None:
        """Back from the trash, unless a live script has taken its name meanwhile."""
        row = self._row(user, script_id, trash=True)
        if row is None or row["deleted_at"] is None:
            return None
        self._check_name_free(user, row["name"])
        with self.db:
            self.db.execute("UPDATE scripts SET deleted_at=NULL WHERE id=?", (script_id,))
        return self.get(user, script_id)
