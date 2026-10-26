from __future__ import annotations

from pydantic import BaseModel, field_validator


class Bar(BaseModel):
    t: int
    o: float
    h: float
    l: float
    c: float
    v: float

    @field_validator("o", "h", "l", "c")
    @classmethod
    def positive_prices(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("price must be positive")
        return value


