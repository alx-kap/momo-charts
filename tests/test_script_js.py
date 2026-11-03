"""Runs the momo script compiler's tests (tests/js/, plain `node --test`, no packages)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def node_major(node: str) -> int:
    out = subprocess.run([node, "--version"], capture_output=True, text=True, check=True).stdout
    return int(out.strip().lstrip("v").split(".")[0])


def test_script_compiler_in_node() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    if node_major(node) < 21:
        pytest.skip("node 21+ is needed for test globs")
    # Node 22 takes globs, not directories, so `node --test tests/js/` becomes this.
    result = subprocess.run(
        [node, "--test", "tests/js/**/*.test.mjs"],
        cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stdout[-4000:] + result.stderr[-2000:]
