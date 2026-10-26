from __future__ import annotations

import pytest
from pydantic import ValidationError

from momo_scan.themes import ThemeTaxonomy


def test_taxonomy_rejects_metric_active_adjacent_membership() -> None:
    with pytest.raises(ValidationError, match="adjacent memberships cannot be metric-active"):
        ThemeTaxonomy.model_validate(
            {
                "taxonomy_version": "invalid",
                "imported_at": "2026-01-01",
                "themes": [{"theme_id": "test", "name": "Test"}],
                "memberships": [
                    {
                        "ticker": "TEST",
                        "theme_id": "test",
                        "role": "adjacent",
                        "include_in_metrics": True,
                        "effective_from": "2026-01-01",
                    }
                ],
            }
        )


@pytest.mark.parametrize(
    "change, message",
    [
        ({"schema_version": 2}, "Input should be 1"),
        ({"taxonomy_version": "  "}, "taxonomy_version must be nonempty"),
        ({"themes": [{"theme_id": "test", "name": "  "}]}, "must be nonempty"),
    ],
)
def test_taxonomy_rejects_unsupported_or_blank_identity(change, message) -> None:
    payload = {
        "taxonomy_version": "v1",
        "imported_at": "2026-01-01",
        "themes": [{"theme_id": "test", "name": "Test"}],
        "memberships": [],
    }
    payload.update(change)
    with pytest.raises(ValidationError, match=message):
        ThemeTaxonomy.model_validate(payload)
