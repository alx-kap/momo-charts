"""What the evaluator calls (the port of runtime.js, minus the steppers in ta.py): colours, list
helpers, text, input readers, the calendar arrays and the output buffers' helpers.

Numbers are floats (NaN is na), true/false are bools, text is str, colours are packed 0xRRGGBBAA
numbers (0 is none) and lists are Python lists. Bars are columns: lists of floats.
"""

from __future__ import annotations

import math
import re

from . import jsnum
from .catalog import format_color, parse_color, with_alpha
from .jsnum import NAN, is_number, js_floor, js_round, js_str, to_fixed, u32
from .lexer import from_utf16
from .limits import LIMITS, RunError

SOURCES = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]
COLUMNS = ("open", "high", "low", "close", "volume", "time")
DERIVED = ("hl2", "hlc3", "ohlc4", "bar_index")
CALENDAR = ("year", "month", "day", "dayofweek", "hour", "minute")

# ---- numbers ------------------------------------------------------------------------------

div = jsnum.div
mod = jsnum.mod
pow_ = jsnum.js_pow
log = jsnum.js_log


def round_(x, digits=0.0):
    if digits == 0 or digits != digits:
        return js_round(x)
    k = 10.0 ** min(15, max(0, digits))
    return js_round(x * k) / k


def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def nz(x, replace):
    return replace if x != x else x


def ne(a, b):
    return a != b and a == a and b == b


def at(array, i, k):
    """History: the value k bars before bar i of an array that holds every bar so far."""
    j = i - k
    return array[int(j)] if k >= 0 and j >= 0 and j == int(j) else NAN


def T(x):
    """A number as true/false."""
    return x == x and x != 0


def F(x):
    """Infinity is na too."""
    return x if x - x == 0 else NAN


# ---- colours: packed 0xRRGGBBAA, 0 is none -------------------------------------------------


def _byte(v):
    return min(255, max(0, js_round(v)))


def rgb(r, g, b, alpha=100.0):
    if r - r == 0 and g - g == 0 and b - b == 0 and alpha - alpha == 0:
        return ((int(_byte(r)) << 24) | (int(_byte(g)) << 16) | (int(_byte(b)) << 8)
                | int(_byte((alpha * 255) / 100))) & 0xFFFFFFFF
    return 0


def alpha(color, pct):
    if color and color - color == 0 and pct - pct == 0:
        return with_alpha(u32(color), pct)
    return 0


# ---- text ---------------------------------------------------------------------------------

_SPEC = re.compile(r"(,)?(?:\.([0-9]+))?([f%])?")
_COMMAS = re.compile(r"\B(?=([0-9]{3})+(?![0-9]))")
_TRAILING_ZEROS = re.compile(r"\.?0+\Z")


def _trim(v):
    if abs(v) < 1e15:
        return _TRAILING_ZEROS.sub("", to_fixed(v, 6), count=1) or "0"
    return js_str(v)


def fmt(v, spec=""):
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    if v - v != 0:
        return "na"
    m = _SPEC.fullmatch(spec)
    if not m or not spec:
        return _trim(v)
    comma, digits, kind = m.groups()
    scaled = v * 100 if kind == "%" else v
    places = int(digits) if digits is not None else 2 if kind else None
    text = _trim(scaled) if places is None else to_fixed(scaled, min(places, 20))
    if comma:
        whole, _, rest = text.partition(".")
        text = _COMMAS.sub(",", whole) + (f".{rest}" if "." in text else "")
    return f"{text}%" if kind == "%" else text


def fmt_color(c):
    return format_color(u32(c)) or "none"


def clip(s):
    return s[:LIMITS["string"]] if len(s) > LIMITS["string"] else s


# ---- lists --------------------------------------------------------------------------------


def lpush(xs, v, where, i):
    if len(xs) >= LIMITS["list"]:
        raise RunError("R403", f"A list can hold at most {LIMITS['list']:,} items.", where, i)
    xs.append(v)


def lpop(xs):
    return xs.pop() if xs else NAN


def lremove(xs, i):
    k = len(xs) + i if i < 0 else i
    if k - k == 0 and k == int(k) and 0 <= k < len(xs):
        del xs[int(k)]


def lget(xs, i):
    k = len(xs) + i if i < 0 else i
    return xs[int(k)] if k - k == 0 and k == int(k) and 0 <= k < len(xs) else NAN


def lsum(xs):
    acc = 0.0
    seen = 0
    for x in xs:
        if x == x:
            acc += x
            seen += 1
    return acc if seen else NAN


def lmax(xs):
    acc = -math.inf
    seen = 0
    for x in xs:
        if x == x:
            acc = x if x > acc else acc
            seen += 1
    return acc if seen else NAN


def lmin(xs):
    acc = math.inf
    seen = 0
    for x in xs:
        if x == x:
            acc = x if x < acc else acc
            seen += 1
    return acc if seen else NAN


def lavg(xs):
    total = 0.0
    seen = 0
    for x in xs:
        if x == x:
            total += x
            seen += 1
    return total / seen if seen else NAN


# ---- inputs: the caller's values, checked again here ---------------------------------------


def _own(inputs, key):
    return inputs.get(key) if isinstance(inputs, dict) and key in inputs else None


def input_number(inputs, key, default, minimum, maximum, whole):
    v = _own(inputs, key)
    if not is_number(v) or v - v != 0:
        v = default
    v = float(v)
    if whole:
        v = float(math.trunc(v))
    if minimum is not None and v < minimum:
        v = float(minimum)
    if maximum is not None and v > maximum:
        v = float(maximum)
    return v


def input_bool(inputs, key, default):
    v = _own(inputs, key)
    return v if isinstance(v, bool) else default


def input_choice(inputs, key, default, options):
    v = _own(inputs, key)
    return v if isinstance(v, str) and v in options else default


def input_color(inputs, key, default):
    v = _own(inputs, key)
    if is_number(v) and v - v == 0:
        return u32(v)
    if isinstance(v, str):
        c = parse_color(v)
        if c is not None:
            return c
    c = parse_color(default)
    return 0 if c is None else c


def input_source(bars, derived, inputs, key, default):
    name = _own(inputs, key)
    return source_series(bars, derived, name if isinstance(name, str) and name in SOURCES
                         else default)


def source_series(bars, derived, name):
    """open high low close volume time come straight from the bars; hl2 hlc3 ohlc4 and
    bar_index are worked out once per run, only when the script reads them."""
    if name in COLUMNS:
        return bars[name]
    if name not in derived:
        derived[name] = _build(bars, name)
    return derived[name]


def _build(bars, name):
    n = len(bars["close"])
    o, h, lo, c = bars["open"], bars["high"], bars["low"], bars["close"]
    if name == "hl2":
        return [(h[i] + lo[i]) / 2 for i in range(n)]
    if name == "hlc3":
        return [(h[i] + lo[i] + c[i]) / 3 for i in range(n)]
    if name == "ohlc4":
        return [(o[i] + h[i] + lo[i] + c[i]) / 4 for i in range(n)]
    return [float(i) for i in range(n)]


# ---- calendar: bar times are New York wall-clock seconds -----------------------------------


def chart(extra):
    info = extra.get("chart") if isinstance(extra, dict) else None
    info = info if isinstance(info, dict) else {}
    interval = info.get("interval")
    interval = _text(interval) if interval else "D"
    ticker = info.get("ticker")
    ticker = _text(ticker)[:32] if ticker else ""
    return {"ticker": ticker, "intraday": interval[-1:] in ("m", "h") and interval != "",
            "daily": interval.endswith("D"), "weekly": interval.endswith("W"),
            "monthly": interval.endswith("M")}


def _text(v):
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    if is_number(v):
        return js_str(float(v))
    return str(v)


def calendar(time, intraday):
    n = len(time)
    year = [NAN] * n
    month = [NAN] * n
    day = [NAN] * n
    dayofweek = [NAN] * n
    hour = [NAN] * n
    minute = [NAN] * n
    regular = [0] * n
    new_day = [0] * n
    previous = NAN
    for i in range(n):
        t = time[i]
        if t - t != 0:                          # no time: na everywhere, like the JavaScript
            regular[i] = 0 if intraday else 1
            new_day[i] = 1
            previous = NAN
            continue
        days = int(js_floor(t / 86400))
        # days to civil date (Howard Hinnant's algorithm)
        z = days + 719468
        era = z // 146097
        doe = z - era * 146097
        yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
        doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
        mp = (5 * doy + 2) // 153
        d = doy - (153 * mp + 2) // 5 + 1
        m = mp + 3 if mp < 10 else mp - 9
        year[i] = float(yoe + era * 400 + (1 if m <= 2 else 0))
        month[i] = float(m)
        day[i] = float(d)
        dayofweek[i] = float((days + 3) % 7 + 1)
        seconds = t - days * 86400
        hour[i] = js_floor(seconds / 3600)
        minute[i] = js_floor((seconds % 3600) / 60)
        minutes = js_floor(seconds / 60)
        regular[i] = (1 if 570 <= minutes < 960 else 0) if intraday else 1
        new_day[i] = 1 if days != previous else 0
        previous = days
    return {"year": year, "month": month, "day": day, "dayofweek": dayofweek, "hour": hour,
            "minute": minute, "regular": regular, "newDay": new_day}


# ---- outputs ------------------------------------------------------------------------------


def mark(items, key, shape, i, price, color, text):
    if price - price != 0:
        return
    items.append({"key": key, "i": i, "price": price, "shape": shape, "color": u32(color),
                  "text": clip(text)})


def level(items, key, price, color, style, title):
    if price - price == 0:
        items.append({"key": key, "price": price, "color": u32(color), "style": style,
                      "title": title})


def stat(items, title, value, color, format_):
    items.append({"title": title, "value": F(value) if is_number(value) else value,
                  "color": u32(color), "format": format_})


def log_line(items, i, args):
    if len(items) < LIMITS["logs"]:
        items.append({"i": i, "text": clip(" ".join(fmt(a) for a in args))})


def text_out(s):
    """Text for output: surrogate halves from the lexer joined back into characters."""
    return from_utf16(s)
