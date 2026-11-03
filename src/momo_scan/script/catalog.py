"""The catalogue: every built-in momo script has, in one table (the port of catalog.js).

The checker reads it for names, argument types and defaults; the evaluator for how a call runs;
and a test keeps it equal to the JavaScript's and to docs/script-language.md.

GLOBALS maps a full name ("ta.sma", "close", "plot") to an entry; METHODS maps a value type to
the methods and attributes it has. Entries are dicts with the same keys as the JavaScript's:
kind ("ta" a stepper with state, "pure" plain maths, "input", "output", "series", "const",
"special"), args [{name, type, fixed, literal, default, choices}] in call order (an arg with a
"default" key may be left out), returns (a type, or a list of output names for ta functions that
return several values), later (set when the name isn't built yet).
"""

from __future__ import annotations

import re

TYPES = ["number", "bool", "string", "color", "list", "bars", "plot", "any"]

# ---- colours: packed 0xRRGGBBAA, 0 means "none" -------------------------------------------


def pack_color(r, g, b, a=255):
    return ((int(r) << 24) | (int(g) << 16) | (int(b) << 8) | int(a)) & 0xFFFFFFFF


def with_alpha(color, pct):
    """The colour with a new opacity (0 clear, 100 solid), keeping its red, green and blue."""
    from .jsnum import js_round

    alpha = int(js_round(min(100, max(0, pct)) * 255 / 100))
    return ((int(color) & 0xFFFFFF00) | alpha) & 0xFFFFFFFF


_COLOR = re.compile(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")


def parse_color(text):
    """"#rgb", "#rrggbb" or "#rrggbbaa" to packed, else None."""
    m = _COLOR.fullmatch(text) if isinstance(text, str) else None
    if not m:
        return None
    digits = m.group(1)
    if len(digits) == 3:
        digits = "".join(c + c for c in digits)
    if len(digits) == 6:
        digits += "ff"
    return pack_color(int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16),
                      int(digits[6:8], 16))


def format_color(color):
    """Packed to "#rrggbb" (or "#rrggbbaa" when not solid); 0 or none to None."""
    if not color:
        return None
    color = int(color) & 0xFFFFFFFF

    def hex_(shift):
        return format((color >> shift) & 255, "02x")

    a = color & 255
    return f"#{hex_(24)}{hex_(16)}{hex_(8)}{'' if a == 255 else hex_(0)}"


# TradingView's palette, as the reference lists it.
PALETTE = {
    "red": "#f23645", "green": "#4caf50", "blue": "#2962ff", "orange": "#ff9800",
    "yellow": "#fdd835", "purple": "#9c27b0", "teal": "#089981", "aqua": "#00bcd4",
    "lime": "#00e676", "fuchsia": "#e040fb", "maroon": "#880e4f", "navy": "#311b92",
    "olive": "#808000", "silver": "#b2b5be", "gray": "#787b86", "white": "#ffffff",
    "black": "#363a45",
}

# ---- helpers for writing entries ----------------------------------------------------------

SHAPES = ["triangle_up", "triangle_down", "dot", "square", "diamond", "arrow_up", "arrow_down",
          "flag"]
LINE_STYLES = ["solid", "dashed", "dotted"]
FORMATS = ["price", "percent", "volume", "number"]


def arg(name, type="number", **options):
    return {"name": name, "type": type, **options}


src = arg("src")


def length(name="length"):
    return arg(name, "number", fixed=True)


def text(name, **options):
    return arg(name, "string", literal=True, **options)


def color(**options):
    return arg("color", "color", default=None, **options)


GLOBALS: dict = {}
METHODS: dict = {"list": {}, "color": {}, "handle": {}, "bars": {}}


def add(name, /, **entry):
    GLOBALS[name] = {"name": name, "args": [], **entry}


def ta(name, args, returns, doc, example, **options):
    add(f"ta.{name}", **{"kind": "ta", "group": "ta", "args": args, "returns": returns,
                         "doc": doc, "example": example, "implicit": [], **options})


# ---- ta.* ----------------------------------------------------------------------------------

ta("sma", [src, length()], "number",
   "Simple moving average. na until `length` bars have values.", "ta.sma(close, 20)")
ta("ema", [src, length()], "number",
   "Exponential moving average, seeded with the simple average of the first `length` values.",
   "ta.ema(close, 21)")
ta("rma", [src, length()], "number", "Wilder's moving average, as RSI and ATR use.",
   "ta.rma(ta.tr(), 14)")
ta("wma", [src, length()], "number", "Weighted moving average: the newest bar counts most.",
   "ta.wma(close, 10)")
ta("vwma", [src, length()], "number", "Volume-weighted moving average.", "ta.vwma(close, 20)",
   implicit=["volume"])
ta("hma", [src, length()], "number", "Hull moving average: fast and smooth.", "ta.hma(close, 21)")
ta("stdev", [src, length()], "number",
   "Standard deviation over `length` bars (population, like TradingView).", "ta.stdev(close, 20)")
ta("variance", [src, length()], "number", "Variance over `length` bars (population).",
   "ta.variance(close, 20)")
ta("highest", [src, length()], "number",
   "Highest value over the last `length` bars, this one included.", "ta.highest(high, 20)")
ta("lowest", [src, length()], "number",
   "Lowest value over the last `length` bars, this one included.", "ta.lowest(low, 20)")
ta("highestbars", [src, length()], "number",
   "Bars back to the highest value in the window: 0 is this bar, -3 is three bars ago.",
   "ta.highestbars(high, 20)")
ta("lowestbars", [src, length()], "number",
   "Bars back to the lowest value in the window: 0 is this bar, -3 is three bars ago.",
   "ta.lowestbars(low, 20)")
ta("change", [src, arg("length", "number", fixed=True, default=1)], "number",
   "This value minus the value `length` bars ago.", "ta.change(close)")
ta("roc", [src, length()], "number", "Percent change over `length` bars.", "ta.roc(close, 10)")
ta("mom", [src, length()], "number", "Momentum: this value minus the value `length` bars ago.",
   "ta.mom(close, 10)")
ta("rsi", [src, length()], "number", "Relative strength index, 0 to 100.", "ta.rsi(close, 14)")
ta("atr", [length()], "number", "Average true range.", "ta.atr(14)",
   implicit=["high", "low", "close"])
ta("tr", [], "number", "True range of this bar.", "ta.tr()", implicit=["high", "low", "close"])
ta("adr", [length()], "number", "Average daily range in percent: the average of high / low - 1.",
   "ta.adr(20)", implicit=["high", "low"])
ta("macd", [src, length("fast"), length("slow"), length("signal")],
   ["macd_line", "signal_line", "hist"],
   "MACD: the fast and slow EMAs' difference, its signal EMA and the gap between them.",
   "macd_line, signal_line, hist = ta.macd(close, 12, 26, 9)",
   history=lambda v: v["slow"] + v["signal"])
ta("bb", [src, length(), arg("mult")], ["basis", "upper", "lower"],
   "Bollinger Bands: a simple average and bands `mult` standard deviations either side.",
   "basis, upper, lower = ta.bb(close, 20, 2.0)")
ta("kc", [src, length(), arg("mult"), length("atr_length")], ["basis", "upper", "lower"],
   "Keltner Channels: an EMA and bands `mult` average true ranges either side.",
   "basis, upper, lower = ta.kc(close, 20, 2.0, 10)", implicit=["high", "low", "close"])
ta("stoch", [length(), length("k_smooth"), length("d_smooth")], ["k", "d"],
   "Stochastic oscillator: %K smoothed by `k_smooth`, and %D smoothed again by `d_smooth`.",
   "k, d = ta.stoch(14, 3, 3)", implicit=["high", "low", "close"],
   history=lambda v: v["length"] + v["k_smooth"] + v["d_smooth"])
ta("crossover", [arg("a"), arg("b")], "bool", "True on the bar `a` rises above `b`.",
   "ta.crossover(close, ma)")
ta("crossunder", [arg("a"), arg("b")], "bool", "True on the bar `a` falls below `b`.",
   "ta.crossunder(close, ma)")
ta("cross", [arg("a"), arg("b")], "bool", "True on a bar where `a` crosses `b` either way.",
   "ta.cross(close, ma)")
ta("rising", [src, length()], "bool",
   "True when `src` has risen on each of the last `length` bars.", "ta.rising(close, 3)")
ta("falling", [src, length()], "bool",
   "True when `src` has fallen on each of the last `length` bars.", "ta.falling(close, 3)")
ta("barssince", [arg("cond", "bool")], "number",
   "Bars since `cond` was last true: 0 on a bar where it is. na before the first time.",
   "ta.barssince(close > open)", history=lambda v: 0)
ta("valuewhen", [arg("cond", "bool"), src, arg("nth", "number", fixed=True, default=0)], "number",
   "The value of `src` on the bar `cond` was last true; `nth` 1 is the time before that.",
   "ta.valuewhen(close > open, low, 0)", history=lambda v: v["nth"])
ta("cum", [src], "number", "Running total from the first bar.", "ta.cum(volume)",
   history=lambda v: 0)
ta("sum", [src, length()], "number", "Sum over the last `length` bars.", "ta.sum(volume, 5)")
ta("median", [src, length()], "number", "Median over the last `length` bars.",
   "ta.median(close, 20)")
ta("percentrank", [src, length()], "number",
   "Percent of the previous `length` values that are at or below this one.",
   "ta.percentrank(close, 100)", history=lambda v: v["length"] + 1)
ta("pivothigh", [src, length("left"), length("right")], "number",
   "The price of a pivot high, known `right` bars after it: it appears on the bar that confirms "
   "it, never earlier. na otherwise.", "ph = ta.pivothigh(high, 5, 5)",
   history=lambda v: v["left"] + v["right"])
ta("pivotlow", [src, length("left"), length("right")], "number",
   "The price of a pivot low, known `right` bars after it: it appears on the bar that confirms "
   "it, never earlier. na otherwise.", "pl = ta.pivotlow(low, 5, 5)",
   history=lambda v: v["left"] + v["right"])
ta("vwap", [], "number", "Volume-weighted average price, restarting each day. Intraday charts.",
   "ta.vwap()", implicit=["time", "high", "low", "close", "volume"], history=lambda v: 0)
ta("rvol", [length()], "number",
   "Volume divided by its average over the `length` bars before this one.", "ta.rvol(20)",
   implicit=["volume"], history=lambda v: v["length"] + 1)
ta("rvol_at_time", [length("days")], "number",
   "Intraday: volume so far today divided by the average to the same minute over `days` days.",
   "ta.rvol_at_time(20)", later="phase 7")

# ---- maths ---------------------------------------------------------------------------------


def pure(name, args, doc, example, **options):
    add(name, kind="pure", group="math", args=args, returns="number", doc=doc, example=example,
        **options)


x = arg("x")

pure("math.abs", [x], "Absolute value.", "math.abs(close - open)", js="Math.abs")
pure("math.min", [arg("a"), arg("b")], "The smallest of two or more numbers.",
     "math.min(open, close)", js="Math.min", variadic=True)
pure("math.max", [arg("a"), arg("b")], "The largest of two or more numbers.",
     "math.max(open, close)", js="Math.max", variadic=True)
pure("math.round", [x, arg("digits", "number", fixed=True, default=0)],
     "Round to the nearest whole number, or to `digits` decimals.", "math.round(x, 2)",
     rt="round")
pure("math.floor", [x], "Round down.", "math.floor(x)", js="Math.floor")
pure("math.ceil", [x], "Round up.", "math.ceil(x)", js="Math.ceil")
pure("math.sqrt", [x], "Square root. na for a negative number.", "math.sqrt(x)", js="Math.sqrt")
pure("math.log", [x], "Natural logarithm. na for zero or less.", "math.log(close / close[1])",
     rt="log")
pure("math.exp", [x], "e to the power x.", "math.exp(x)", js="Math.exp")
pure("math.pow", [arg("base"), arg("exponent")],
     "`base` to the power `exponent`. na where there's no real answer.", "math.pow(x, 0.5)",
     rt="pow")
pure("math.sign", [x], "-1, 0 or 1.", "math.sign(close - open)", js="Math.sign")
pure("math.clamp", [x, arg("lo"), arg("hi")], "x, held between `lo` and `hi`.",
     "math.clamp(x, 0, 100)", rt="clamp")
for bare in ("abs", "min", "max", "round"):
    add(bare, **{**GLOBALS[f"math.{bare}"], "name": bare, "alias": f"math.{bare}"})
add("na", kind="special", group="math", args=[arg("x", "any")], returns="bool",
    doc="True when `x` has no value.", example="na(close[1])")
add("nz", kind="special", group="math", args=[x, arg("replace", "number", default=0)],
    returns="number", doc="`x`, or `replace` (0 unless given) when `x` has no value.",
    example="nz(close[1], close)")
add("len", kind="special", group="list", args=[arg("xs", "list")], returns="number",
    doc="How many items a list holds.", example="len(xs)")
add("range", kind="special", group="list",
    args=[arg("start", "number"), arg("stop", "number", default=None),
          arg("step", "number", default=1)],
    returns="list",
    doc="The whole numbers for a `for` loop: range(n), range(start, stop) or "
        "range(start, stop, step).",
    example="for i in range(10):")

# ---- inputs --------------------------------------------------------------------------------

KWARG_ALIASES = {"minval": "min", "maxval": "max"}
input_extras = [text("group", default=""), text("tooltip", default="")]


def input_(name, args, returns, doc, example):
    add(f"input.{name}", kind="input", group="input", args=args, returns=returns, doc=doc,
        example=example)


title = text("title", default="")
range01 = [arg("min", "number", literal=True, default=None),
           arg("max", "number", literal=True, default=None),
           arg("step", "number", literal=True, default=None)]
input_("int", [arg("default", "number", literal=True), title, *range01, *input_extras], "number",
       "A whole-number setting, shown in the indicator's settings.",
       'length = input.int(20, "Length", min=1, max=500)')
input_("float", [arg("default", "number", literal=True), title, *range01, *input_extras],
       "number", "A decimal setting.", 'mult = input.float(2.0, "Multiplier", step=0.1)')
input_("source", [arg("default", "number", literal=True), title, *input_extras], "number",
       "Which price to use: open, high, low, close, hl2, hlc3, ohlc4 or volume. A series.",
       'src = input.source(close, "Source")')
input_("bool", [arg("default", "bool", literal=True), title, *input_extras], "bool",
       "A yes/no setting.", 'show = input.bool(true, "Show labels")')
input_("choice", [arg("default", "string", literal=True), title,
                  arg("options", "list", literal=True, keywordOnly=True), *input_extras],
       "string", "A pick from a list of text options.",
       'side = input.choice("Right", "Labels", options=["Left", "Right"])')
input_("color", [arg("default", "color", literal=True), title, *input_extras], "color",
       "A colour setting.", 'line_c = input.color("#2962ff", "Line")')

# ---- output --------------------------------------------------------------------------------


def output(name, args, returns, doc, example, **options):
    add(name, kind="output", group="output", args=args, returns=returns, doc=doc,
        example=example, **options)


PLOT_STYLES = ["line", "steps", "histogram", "columns", "area", "circles"]
add("indicator", kind="special", group="output",
    args=[text("title"), arg("overlay", "bool", literal=True, default=False),
          text("short", default=""), text("format", default="price", choices=FORMATS),
          arg("precision", "number", literal=True, default=2)],
    returns="void",
    doc="The script's name and where it draws. The first line after `#momo 1`.",
    example='indicator("Squeeze", overlay=true)')
output("plot", [src, text("title", default=""), color(),
                arg("width", "number", literal=True, default=1),
                text("style", default="line", choices=PLOT_STYLES),
                text("format", default=None, choices=FORMATS)], "plot",
       "Draws a series. Returns a handle for fill().",
       'p = plot(ta.sma(close, 20), "SMA", color=color.orange)')
output("fill", [arg("a", "plot"), arg("b", "plot"), color()], "void",
       "Shades between two plots (or a plot and an hline).",
       "fill(up, lo, color=color.blue.alpha(10))")
output("hline", [arg("price", "number", fixed=True), text("title", default=""), color(),
                 text("style", default="dashed", choices=LINE_STYLES)], "plot",
       "A fixed horizontal guide line, like RSI 70 and 30.", 'hline(70, "Overbought")')
output("level", [arg("price"), text("title", default=""), color(),
                 text("style", default="solid", choices=LINE_STYLES),
                 arg("show", "bool", default=True)], "void",
       "A horizontal line at `price` on the last bar, with its value on the axis: key levels.",
       'level(ta.highest(high, 252), "52w high")')
output("marker", [arg("cond", "bool"), text("title", default=""),
                  text("shape", default="triangle_up", choices=SHAPES),
                  arg("at", "any", default="above"), color(), arg("text", "string", default="")],
       "void", 'A shape on each bar where `cond` is true. `at` is "above", "below" or a price.',
       'marker(crossed, "Cross", shape="dot", at="below")')
output("barcolor", [arg("color", "color")], "void",
       "Colours this bar's candle. na leaves it normal.", "barcolor(color.yellow if tight else na)")
output("bgcolor", [arg("color", "color")], "void", "Shades this bar's column.",
       "bgcolor(color.red.alpha(10) if down else na)")
output("stat", [text("title"), arg("x", "any"), color(),
                text("format", default="number", choices=FORMATS)], "void",
       "A row in the script's corner panel, showing `x` on the last bar.",
       'stat("ADR", ta.adr(20), format="percent")')
output("signal", [text("name"), arg("cond", "bool")], "void",
       "Publishes a yes/no for the screener, watchlist columns, alerts and signal stats. "
       "Draws nothing.", 'signal("squeeze", tight)')
output("value", [text("name"), arg("x")], "void",
       "Publishes a number for the screener, watchlist columns and alerts. Draws nothing.",
       'value("adr", ta.adr(20))')
output("log", [arg("x", "any")], "void",
       "Prints to the editor's console with the bar's date.", 'log("close", close)',
       variadic=True)
output("line", [arg("x1"), arg("y1"), arg("x2"), arg("y2"), color(),
                arg("width", "number", default=1),
                text("style", default="solid", choices=LINE_STYLES),
                text("extend", default="none", choices=["none", "right", "both"])], "handle",
       "A drawn line between two points; x is a bar_index.",
       "g = line(bar_index[5], low[5], bar_index, low)", later="phase 6")
output("box", [arg("x1"), arg("top"), arg("x2"), arg("bottom"), color(),
               arg("border", "color", default=None)], "handle", "A shaded box.",
       "b = box(bar_index[3], high[3], bar_index, low[3])", later="phase 6")
output("label", [arg("x"), arg("y"), arg("text", "string"), color(), text("at", default="above")],
       "handle", "Text at a point.", 'label(bar_index, high, "Top")', later="phase 6")

# ---- other timeframes, symbols and momo's data (later phases) ------------------------------

add("tf", kind="special", group="data",
    args=[text("timeframe"), arg("expr", "any", default=None)], returns="bars",
    doc='Finished bars of a higher timeframe ("D", "W", "M"), or an expression worked out on '
        "them.", example='daily = tf("D")', later="phase 7")
add("symbol", kind="special", group="data", args=[text("name")], returns="bars",
    doc="Another symbol's bars on the chart's timeframe, matched by time.",
    example='spy = symbol("SPY")', later="phase 7")
for field in ("open", "high", "low", "close", "volume"):
    add(f"today.{field}", kind="series", group="data", type="number",
        doc=f"The day so far: its {field}, built from this chart's bars up to this one. "
            "Intraday charts.", example=f"today.{field}", later="phase 7")
DATA_SERIES = {
    "earnings.days_to_next": "Days until the next earnings report, as of this bar.",
    "earnings.days_since_last": "Days since the last earnings report, as of this bar.",
    "fund.eps_yoy": "Year-over-year EPS growth, as of the latest filing on this bar.",
    "fund.sales_yoy": "Year-over-year sales growth, as of the latest filing on this bar.",
    "info.industry": "The stock's industry.",
    "info.sector": "The stock's sector.",
    "market.t2108": "Share of stocks above their 40-day average, as of this bar.",
    "market.new_highs": "How many stocks made a new high, as of this bar.",
    "market.new_lows": "How many stocks made a new low, as of this bar.",
    "rs.rank": "The stock's relative strength percentile against all stocks.",
    "theme.rank": "The stock's theme's rank.",
    "cot.net": "Net positioning from the Commitments of Traders report.",
}
for _name, _doc in DATA_SERIES.items():
    add(_name, kind="series", group="data",
        type="string" if _name.startswith("info.") else "number", doc=_doc, example=_name,
        later="phase 7")

# ---- bar series, calendar, chart -----------------------------------------------------------


def series(name, type, doc, **options):
    add(name, kind="series", group="series", type=type, doc=doc, example=name, **options)


series("open", "number", "This bar's open.", array=True)
series("high", "number", "This bar's high.", array=True)
series("low", "number", "This bar's low.", array=True)
series("close", "number", "This bar's close.", array=True)
series("volume", "number", "This bar's volume.", array=True)
series("hl2", "number", "(high + low) / 2.", array=True)
series("hlc3", "number", "(high + low + close) / 3.", array=True)
series("ohlc4", "number", "(open + high + low + close) / 4.", array=True)
series("time", "number", "The bar's time in seconds.", array=True)
series("bar_index", "number", "0 for the first bar, 1 for the next, and so on.", array=True)
series("first_bar", "bool", "True on the first bar.")
series("last_bar", "bool", "True on the last bar (the latest, or the one replay has reached).")
series("year", "number", "The bar's year.", array=True, calendar=True)
series("month", "number", "The bar's month, 1 to 12.", array=True, calendar=True)
series("day", "number", "The bar's day of the month.", array=True, calendar=True)
series("dayofweek", "number", "1 for Monday through 7 for Sunday.", array=True, calendar=True)
series("hour", "number", "The bar's hour, New York time. Intraday charts.", array=True,
       calendar=True)
series("minute", "number", "The bar's minute. Intraday charts.", array=True, calendar=True)
series("session.regular", "bool", "True for bars inside 09:30–16:00 New York time.")
series("session.new_day", "bool", "True on the first bar of each day.")
series("timeframe.is_intraday", "bool", "True on minute and hour charts.", fixed=True)
series("timeframe.is_daily", "bool", "True on a daily chart.", fixed=True)
series("timeframe.is_weekly", "bool", "True on a weekly chart.", fixed=True)
series("timeframe.is_monthly", "bool", "True on a monthly chart.", fixed=True)
series("ticker", "string", "The chart's symbol.", fixed=True)

# ---- colours -------------------------------------------------------------------------------

for _name, _hex in PALETTE.items():
    add(f"color.{_name}", kind="const", group="color", type="color", value=parse_color(_hex),
        doc=f"The {_name} of TradingView's palette ({_hex}).", example=f"color.{_name}")
add("color.rgb", kind="pure", group="color",
    args=[arg("r"), arg("g"), arg("b"), arg("alpha", "number", default=100)], returns="color",
    rt="rgb",
    doc="A colour from red, green and blue (0–255) and opacity (0 clear, 100 solid).",
    example="color.rgb(41, 98, 255)")

# ---- methods and attributes ----------------------------------------------------------------


def method(type, name, args, returns, doc, example, **options):
    METHODS[type][name] = {"name": name, "owner": type, "args": args, "returns": returns,
                           "doc": doc, "example": example, **options}


method("color", "alpha", [arg("pct")], "color",
       "This colour with a new opacity (0 clear, 100 solid).", "color.blue.alpha(10)")
method("list", "push", [arg("value")], "void", "Adds an item to the end.", "xs.push(close)")
method("list", "pop", [], "number", "Removes and returns the last item.", "xs.pop()")
method("list", "remove", [arg("i")], "void", "Removes the item at position i.", "xs.remove(0)")
method("list", "clear", [], "void", "Empties the list.", "xs.clear()")
method("list", "sum", [], "number", "The items added up.", "xs.sum()")
method("list", "max", [], "number", "The largest item.", "xs.max()")
method("list", "min", [], "number", "The smallest item.", "xs.min()")
method("list", "avg", [], "number", "The average of the items.", "xs.avg()")
method("handle", "set", [], "void",
       "Changes a drawn line, box or label: g.set(x2=bar_index).", "g.set(x2=bar_index)",
       later="phase 6", kwargs=True)
method("handle", "delete", [], "void", "Removes a drawn line, box or label.", "g.delete()",
       later="phase 6")
for _field in ("open", "high", "low", "close", "volume", "time"):
    method("bars", _field, [], "number", f"The {_field} of another series of bars.",
           f'tf("D").{_field}', later="phase 7", attribute=True)

# The namespaces a dotted name can start with.
NAMESPACES = frozenset(n.split(".")[0] for n in GLOBALS if "." in n)


def all_names():
    """Every public name, methods as "type.name"."""
    return [*GLOBALS,
            *(f"{type}.{m}" for type, methods in METHODS.items() for m in methods)]


def _json(value):
    return "na" if value is None else (
        "true" if value is True else "false" if value is False else
        f'"{value}"' if isinstance(value, str) else
        str(int(value)) if isinstance(value, float) and value == int(value) else str(value))


def signature(entry):
    """"ta.sma(src, length)" for hover docs and error messages."""
    parts = [f"{a['name']}={_json(a['default'])}" if "default" in a else a["name"]
             for a in entry["args"]]
    return f"{entry['name']}({', '.join(parts)})"


def members(namespace):
    """The members of a namespace: members("ta") is ["sma", "ema", ...]."""
    prefix = f"{namespace}."
    return [n[len(prefix):] for n in GLOBALS if n.startswith(prefix)]
