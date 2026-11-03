"""The one error type of the momo script compiler (the port of errors.js).

Every error has a stable code (E1xx syntax, E2xx rules, E3xx types, E4xx limits, R4xx at run
time), a 1-based position (`end_col` just past the last character) and, where it can, a fix.
"""

from __future__ import annotations


class ScriptError(Exception):
    def __init__(self, code, message, line, col, end_col=None, fix=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.line = line
        self.col = col
        self.end_col = col + 1 if end_col is None else end_col
        self.fix = fix


def fail(code, message, line, col, end_col=None, fix=None):
    raise ScriptError(code, message, line, col, end_col, fix)


def describe(error: ScriptError) -> dict:
    """The plain dict compile() returns for an error (the same keys as the JavaScript)."""
    return {
        "line": error.line, "col": error.col, "endCol": error.end_col, "code": error.code,
        "message": error.message, "fix": error.fix or None,
    }


def distance(a: str, b: str) -> int:
    """Edit distance, for "did you mean"."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        row = [i]
        for j in range(1, len(b) + 1):
            row.append(min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1])))
        prev = row
    return prev[len(b)]


def did_you_mean(word: str, candidates) -> str | None:
    """The candidate closest to `word`, if it is close enough to be a typo."""
    best = None
    best_distance = float("inf")
    lower = word.lower()
    for name in candidates:
        d = min(distance(word, name), distance(lower, name.lower()))
        if d < best_distance:
            best, best_distance = name, d
    allowed = 1 if len(word) <= 3 else 2 if len(word) <= 7 else 3
    return best if best is not None and best_distance <= allowed else None
