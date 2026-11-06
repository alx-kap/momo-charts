"""The chart's price axis: enough labels on a log scale when zoomed in (runs in node)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

SCALE = Path("src/momo_scan/web/static/js/engine/pricescale.js").resolve()
SCRIPT = """
import { Mode, PriceScale } from "%s";
const scale = new PriceScale("right", { mode: Mode.%s });
scale.height = 600;
scale.range = { min: scale.toUnits(%f), max: scale.toUnits(%f) };
console.log(JSON.stringify(scale.ticks(50)));
"""


def ticks(mode: str, low: float, high: float) -> list[float]:
    if shutil.which("node") is None:
        pytest.skip("needs node")
    source = SCRIPT % (SCALE.as_uri(), mode, low, high)
    run = subprocess.run(
        ["node", "--input-type=module", "-e", source], capture_output=True, text=True, check=True,
    )
    return json.loads(run.stdout)


@pytest.mark.parametrize(("low", "high"), [(50, 51), (9.8, 10.1), (100, 104), (400, 430)])
def test_log_scale_zoomed_in_labels_as_often_as_linear(low: float, high: float) -> None:
    log = ticks("Logarithmic", low, high)
    linear = ticks("Normal", low, high)
    assert len(log) >= len(linear) * 0.75, (log, linear)
    assert len(set(log)) == len(log)


def test_log_scale_zoomed_out_still_spreads_labels() -> None:
    labels = ticks("Logarithmic", 10, 1000)
    assert len(labels) >= 6
    assert labels == sorted(labels)
