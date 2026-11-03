"""JavaScript's number behaviour in Python, so both languages give the same values.

Python raises where JavaScript returns NaN or Infinity (math.sqrt(-1), math.floor(inf), 1 / 0,
10.0 ** 400), rounds half to even where JavaScript rounds half up, and orders NaN differently in
max() and min(). Every helper here is the JavaScript's answer.
"""

from __future__ import annotations

import math
import re
from decimal import ROUND_HALF_UP, Decimal

NAN = float("nan")
INF = float("inf")


def finite(x):
    return x - x == 0


def js_floor(x):
    return float(math.floor(x)) if x - x == 0 else x


def js_ceil(x):
    return float(math.ceil(x)) if x - x == 0 else x


def js_round(x):
    """Math.round: the nearest whole number, halves toward +infinity."""
    if not x - x == 0:
        return x
    f = math.floor(x)
    return float(f + 1 if x - f >= 0.5 else f)


def js_trunc(x):
    return float(math.trunc(x)) if x - x == 0 else x


def js_sqrt(x):
    return math.sqrt(x) if x >= 0 else (x if x != x else NAN)


def js_exp(x):
    try:
        return math.exp(x)
    except OverflowError:
        return INF


def js_log(x):
    return math.log(x) if x > 0 else NAN


def js_sign(x):
    return x if x != x or x == 0 else (1.0 if x > 0 else -1.0)


def js_abs(x):
    return abs(x)


def js_min(*values):
    best = INF
    for v in values:
        if v != v:
            return NAN
        if v < best:
            best = v
    return best


def js_max(*values):
    best = -INF
    for v in values:
        if v != v:
            return NAN
        if v > best:
            best = v
    return best


def div(a, b):
    return NAN if b == 0 else a / b


def js_fmod(a, b):
    try:
        return math.fmod(a, b)
    except ValueError:
        return NAN


def mod(a, b):
    return NAN if b == 0 else js_fmod(js_fmod(a, b) + b, b)


def js_pow(a, b):
    """Math.pow, then (as the runtime does) NaN for anything that isn't a real number."""
    if b != b or ((a == 1 or a == -1) and b - b != 0):
        return NAN
    try:
        r = math.pow(a, b)
    except (OverflowError, ValueError, ZeroDivisionError):
        return NAN
    return r if r - r == 0 else NAN


def u32(x):
    """x >>> 0."""
    if not x - x == 0:
        return 0
    return int(x) & 0xFFFFFFFF


def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


_EXPONENT = re.compile(r"^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-][0-9]+))?$")


def js_str(v):
    """String(number)."""
    if v != v:
        return "NaN"
    if v == INF:
        return "Infinity"
    if v == -INF:
        return "-Infinity"
    if v == 0:
        return "0"
    sign = "-" if v < 0 else ""
    m = _EXPONENT.match(repr(abs(v)))
    whole, frac, exp = m.group(2), m.group(3) or "", int(m.group(4) or 0)
    lead = (whole + frac).lstrip("0")
    digits = lead.rstrip("0")
    k = len(digits)
    n = k + exp - len(frac) + (len(lead) - k)      # the value is 0.digits * 10 ** n
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    tail = f"{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + tail


def to_fixed(v, places):
    """Number.prototype.toFixed: exact, ties away from zero."""
    if v != v:
        return "NaN"
    if abs(v) >= 1e21 or v - v != 0:
        return js_str(v)
    quantum = Decimal(1).scaleb(-places)
    text = format(Decimal(v).quantize(quantum, rounding=ROUND_HALF_UP), "f")
    if text.startswith("-") and v == 0:
        text = text[1:]
    return text
