"""The limits every run has (the same as the browser's) and the error a run stops with."""

from __future__ import annotations

LIMITS = {
    "source": 100_000, "loop_steps": 1_000_000, "list": 10_000, "drawings": 500, "plots": 64,
    "string": 200, "run_ms": 250, "length": 5000, "logs": 500, "calls": 400,
}


class RunError(Exception):
    """A run that stops: R402 (loop steps), R403 (list size), R404 (a length out of range)."""

    def __init__(self, code, message, at=(1, 1), i=-1):
        super().__init__(message)
        self.code = code
        self.message = message
        self.line = at[0]
        self.col = at[1]
        self.i = i

    def describe(self):
        return {"code": self.code, "message": self.message, "line": self.line, "col": self.col,
                "i": self.i}
