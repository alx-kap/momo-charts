from __future__ import annotations

import hashlib
import json
import tomllib
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

# Lines between "# private" and "# /private" are the scanner's settings; the public edition
# strips them.


class ProviderConfig(BaseModel):
    name: str = "sqlite"
    database: str = "data/bars.db"  # daily bars; Alex's momo.toml points at the archive
    history_bars: int = 300
    minimum_latest_coverage: float = 0.80
    # "schwab": momo fills `database` itself from the Schwab live feed (momo_scan.bars), for
    # installs without the market-data archive. "none": the archive is filled elsewhere.
    fill: str = "none"




class RegimeConfig(BaseModel):
    """Market breadth, for the scanner's regime."""





class StorageConfig(BaseModel):
    database: str = "data/momo.db"


class ThemesConfig(BaseModel):
    path: str = Field(
        default_factory=lambda: str(
            (Path(__file__).resolve().parents[2] / "config" / "themes.json").resolve()
        )
    )




class FundamentalsConfig(BaseModel):
    user_agent: str = "momo-scan admin@momo-scan.local"


class AppConfig(BaseModel):
    provider: ProviderConfig = Field(default_factory=ProviderConfig)
    regime: RegimeConfig = Field(default_factory=RegimeConfig)
    storage: StorageConfig = Field(default_factory=StorageConfig)
    themes: ThemesConfig = Field(default_factory=ThemesConfig)
    fundamentals: FundamentalsConfig = Field(default_factory=FundamentalsConfig)

    @property
    def config_hash(self) -> str:
        payload = json.dumps(
            self.model_dump(mode="json", exclude={"fundamentals"}), sort_keys=True,
        ).encode()
        return hashlib.sha256(payload).hexdigest()[:16]


def load_config(path: Path | str = Path("config/momo.toml")) -> AppConfig:
    path = Path(path)
    if not path.exists():
        return AppConfig()
    with path.open("rb") as handle:
        data: dict[str, Any] = tomllib.load(handle)
    explicit_theme_path = data.get("themes", {}).get("path")
    config = AppConfig.model_validate(data)
    if explicit_theme_path is not None:
        theme_path = Path(str(explicit_theme_path)).expanduser()
        if not theme_path.is_absolute():
            theme_path = (path.parent / theme_path).resolve()
        config.themes.path = str(theme_path)
    return config
