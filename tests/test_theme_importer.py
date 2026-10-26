from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_invalid_import_does_not_replace_existing_destination(tmp_path: Path) -> None:
    source = tmp_path / "atlas"
    source.mkdir()
    (source / "approval.yaml").write_text(
        "status: approved\nrelease_version: test-v1\nproposal_hash: abc\n",
        encoding="utf-8",
    )
    (source / "themes.yaml").write_text(
        'themes:\n  - theme_id: test\n    name: "  "\n',
        encoding="utf-8",
    )
    (source / "memberships.csv").write_text(
        "ticker,theme_id,role,include_in_metrics,effective_from,effective_to,source,"
        "review_status\n",
        encoding="utf-8",
    )
    destination = tmp_path / "themes.json"
    original = b'{"existing": true}\n'
    destination.write_bytes(original)
    result = subprocess.run(
        [
            sys.executable,
            "scripts/import_market_atlas_themes.py",
            str(source),
            str(destination),
            "--overwrite",
        ],
        cwd=Path(__file__).parents[1],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "PYTHONPATH": "src"},
    )
    assert result.returncode != 0
    assert destination.read_bytes() == original
