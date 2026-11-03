"""momo script: source text to a checked script (the port of compile.js).

check_source() runs the lexer and parser (syntax: stops at the first error) and the checker
(rules and types: all errors) and returns {ok, meta, ir} or {ok: False, errors}. The IR is what
the evaluator turns into closures; no Python source is ever built from a script.
"""

from __future__ import annotations

import sys

from .checker import check
from .errors import ScriptError, describe
from .lexer import utf16
from .limits import LIMITS
from .parser import allow_deep_nesting, parse


def _failure(code, message, fix=None):
    return {"ok": False, "errors": [{"line": 1, "col": 1, "endCol": 2, "code": code,
                                     "message": message, "fix": fix}]}


def check_source(source):
    if not isinstance(source, str):
        return _failure("E110", "The script should be text.")
    size = len(utf16(source))
    if size > LIMITS["source"]:
        return _failure("E401", f"A script can be at most {LIMITS['source']:,} characters; "
                        f"this one has {size:,}.",
                        "Split it into two scripts, or remove what you don't use.")
    allow_deep_nesting()
    try:
        ast = parse(source)
        return check(ast)
    except ScriptError as e:
        return {"ok": False, "errors": [describe(e)]}
    except RecursionError:
        sys.setrecursionlimit(sys.getrecursionlimit())
        return _failure("E120", "This script is nested too deeply.")
