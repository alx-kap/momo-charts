from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class ThemeDefinition(BaseModel):
    theme_id: str
    name: str
    description: str = ""

    @field_validator("theme_id", "name")
    @classmethod
    def nonempty_trimmed_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("theme identifiers and names must be nonempty")
        return value


class TaxonomyMembership(BaseModel):
    ticker: str
    theme_id: str
    role: Literal["core", "enabler", "adjacent"]
    include_in_metrics: bool
    effective_from: date
    effective_to: date | None = None
    source_reason: str = ""

    @field_validator("ticker")
    @classmethod
    def normalized_ticker(cls, value: str) -> str:
        normalized = value.strip().upper()
        if not normalized or ":" in normalized:
            raise ValueError("theme membership tickers must be nonempty unqualified tickers")
        return normalized

    @field_validator("theme_id")
    @classmethod
    def normalized_theme_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("membership theme_id must be nonempty")
        return value

    @model_validator(mode="after")
    def valid_role_policy_and_dates(self) -> TaxonomyMembership:
        if self.role == "adjacent" and self.include_in_metrics:
            raise ValueError("adjacent memberships cannot be metric-active")
        if self.role in {"core", "enabler"} and not self.include_in_metrics:
            raise ValueError("core and enabler memberships must be metric-active")
        if self.effective_to is not None and self.effective_to <= self.effective_from:
            raise ValueError("effective_to must be after effective_from")
        return self


class ThemeTaxonomy(BaseModel):
    schema_version: Literal[1] = 1
    taxonomy_version: str
    imported_at: date
    provenance: dict[str, Any] = Field(default_factory=dict)
    themes: list[ThemeDefinition]
    memberships: list[TaxonomyMembership]

    @field_validator("taxonomy_version")
    @classmethod
    def nonempty_version(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("taxonomy_version must be nonempty")
        return value

    @model_validator(mode="after")
    def validate_references_and_intervals(self) -> ThemeTaxonomy:
        theme_ids = [theme.theme_id for theme in self.themes]
        if len(theme_ids) != len(set(theme_ids)):
            raise ValueError("theme IDs must be unique")
        known = set(theme_ids)
        intervals: dict[tuple[str, str], list[tuple[date, date | None]]] = {}
        for item in self.memberships:
            if item.theme_id not in known:
                raise ValueError(f"membership references unknown theme {item.theme_id}")
            intervals.setdefault((item.ticker, item.theme_id), []).append(
                (item.effective_from, item.effective_to)
            )
        for key, values in intervals.items():
            ordered = sorted(values, key=lambda item: item[0])
            for left, right in zip(ordered, ordered[1:], strict=False):
                if left[1] is None or left[1] > right[0]:
                    raise ValueError(f"overlapping membership intervals for {key[0]} / {key[1]}")
        return self

    @property
    def content_hash(self) -> str:
        payload = json.dumps(self.compact_snapshot(), sort_keys=True).encode()
        return hashlib.sha256(payload).hexdigest()

    def active_memberships(self, as_of: date) -> list[TaxonomyMembership]:
        return [
            item
            for item in self.memberships
            if item.effective_from <= as_of
            and (item.effective_to is None or as_of < item.effective_to)
        ]

    def compact_snapshot(self) -> dict[str, Any]:
        payload = self.model_dump(mode="json")
        payload["themes"] = sorted(payload["themes"], key=lambda item: item["theme_id"])
        payload["memberships"] = sorted(
            payload["memberships"],
            key=lambda item: (
                item["ticker"],
                item["theme_id"],
                item["effective_from"],
                item.get("effective_to") or "",
            ),
        )
        return payload


def load_taxonomy(path: Path | str) -> ThemeTaxonomy:
    source = Path(path).expanduser()
    if not source.is_file():
        raise ValueError(f"Theme taxonomy does not exist: {source}")
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not read theme taxonomy {source}: {error}") from error
    return ThemeTaxonomy.model_validate(payload)
