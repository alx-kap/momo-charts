// The catalogue: every built-in momo script has, in one table. The checker reads it for names,
// argument types and defaults; the code generator for how a call compiles; the editor (later)
// for autocomplete and hover docs; and a test keeps it equal to docs/script-language.md.
//
// GLOBALS maps a full name ("ta.sma", "close", "plot") to an entry; METHODS maps a value type to
// the methods and attributes it has ("list" → push, "color" → alpha). Entries:
//   kind     "ta" (a stepper with state) · "pure" (plain maths) · "input" · "output" · "series" ·
//            "const" · "special"
//   args     [{ name, type, fixed, literal, default, choices }] in call order. `fixed`: the same
//            on every bar (literal, input or maths on them). `literal`: written out in the source.
//            An arg with a `default` key may be left out.
//   returns  a type, or for ta functions that return several values, a list of output names
//   later    set when the name exists in the reference but isn't built yet (the phase that does it)
// Types: number (a `na` can sit in any number), bool, string, color, list, bars, plot (a handle
// for fill()), any (number, bool or string).

export const TYPES = ["number", "bool", "string", "color", "list", "bars", "plot", "any"];

// ---- colours: packed 0xRRGGBBAA, 0 means "none" -------------------------------------------

export const packColor = (r, g, b, a = 255) => (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);

// The colour with a new opacity (0 clear, 100 solid), keeping its red, green and blue.
export const withAlpha = (color, pct) => ((((color >>> 8) << 8) | Math.round(Math.min(100, Math.max(0, pct)) * 2.55)) >>> 0);

// "#rgb", "#rrggbb" or "#rrggbbaa" → packed, else null.
export function parseColor(text) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(text);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  if (hex.length === 6) hex += "ff";
  return packColor(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), parseInt(hex.slice(6, 8), 16));
}

// packed → "#rrggbb" (or "#rrggbbaa" when not solid); 0 → null.
export function formatColor(color) {
  if (!color) return null;
  const hex = (shift) => ((color >>> shift) & 255).toString(16).padStart(2, "0");
  const a = color & 255;
  return `#${hex(24)}${hex(16)}${hex(8)}${a === 255 ? "" : hex(0)}`;
}

// TradingView's palette, as the reference lists it.
export const PALETTE = {
  red: "#f23645", green: "#4caf50", blue: "#2962ff", orange: "#ff9800", yellow: "#fdd835",
  purple: "#9c27b0", teal: "#089981", aqua: "#00bcd4", lime: "#00e676", fuchsia: "#e040fb",
  maroon: "#880e4f", navy: "#311b92", olive: "#808000", silver: "#b2b5be", gray: "#787b86",
  white: "#ffffff", black: "#363a45",
};

// ---- helpers for writing entries ----------------------------------------------------------

const SHAPES = ["triangle_up", "triangle_down", "dot", "square", "diamond", "arrow_up", "arrow_down", "flag"];
const LINE_STYLES = ["solid", "dashed", "dotted"];
const FORMATS = ["price", "percent", "volume", "number"];

const arg = (name, type = "number", options = {}) => ({ name, type, ...options });
const src = arg("src");
const length = (name = "length") => arg(name, "number", { fixed: true });
const text = (name, options = {}) => arg(name, "string", { literal: true, ...options });
const color = (options = {}) => arg("color", "color", { default: null, ...options });

const GLOBALS = {};
const METHODS = { list: {}, color: {}, handle: {}, bars: {} };

function add(name, entry) {
  GLOBALS[name] = { name, args: [], ...entry };
}

const ta = (name, args, returns, doc, example, options = {}) => add(`ta.${name}`, {
  kind: "ta", group: "ta", args, returns, doc, example, implicit: [], ...options,
});

// ---- ta.* ----------------------------------------------------------------------------------

ta("sma", [src, length()], "number", "Simple moving average. na until `length` bars have values.", "ta.sma(close, 20)");
ta("ema", [src, length()], "number", "Exponential moving average, seeded with the simple average of the first `length` values.", "ta.ema(close, 21)");
ta("rma", [src, length()], "number", "Wilder's moving average, as RSI and ATR use.", "ta.rma(ta.tr(), 14)");
ta("wma", [src, length()], "number", "Weighted moving average: the newest bar counts most.", "ta.wma(close, 10)");
ta("vwma", [src, length()], "number", "Volume-weighted moving average.", "ta.vwma(close, 20)", { implicit: ["volume"] });
ta("hma", [src, length()], "number", "Hull moving average: fast and smooth.", "ta.hma(close, 21)");
ta("stdev", [src, length()], "number", "Standard deviation over `length` bars (population, like TradingView).", "ta.stdev(close, 20)");
ta("variance", [src, length()], "number", "Variance over `length` bars (population).", "ta.variance(close, 20)");
ta("highest", [src, length()], "number", "Highest value over the last `length` bars, this one included.", "ta.highest(high, 20)");
ta("lowest", [src, length()], "number", "Lowest value over the last `length` bars, this one included.", "ta.lowest(low, 20)");
ta("highestbars", [src, length()], "number", "Bars back to the highest value in the window: 0 is this bar, -3 is three bars ago.", "ta.highestbars(high, 20)");
ta("lowestbars", [src, length()], "number", "Bars back to the lowest value in the window: 0 is this bar, -3 is three bars ago.", "ta.lowestbars(low, 20)");
ta("change", [src, arg("length", "number", { fixed: true, default: 1 })], "number", "This value minus the value `length` bars ago.", "ta.change(close)");
ta("roc", [src, length()], "number", "Percent change over `length` bars.", "ta.roc(close, 10)");
ta("mom", [src, length()], "number", "Momentum: this value minus the value `length` bars ago.", "ta.mom(close, 10)");
ta("rsi", [src, length()], "number", "Relative strength index, 0 to 100.", "ta.rsi(close, 14)");
ta("atr", [length()], "number", "Average true range.", "ta.atr(14)", { implicit: ["high", "low", "close"] });
ta("tr", [], "number", "True range of this bar.", "ta.tr()", { implicit: ["high", "low", "close"] });
ta("adr", [length()], "number", "Average daily range in percent: the average of high / low - 1.", "ta.adr(20)", { implicit: ["high", "low"] });
ta("macd", [src, length("fast"), length("slow"), length("signal")], ["macd_line", "signal_line", "hist"],
  "MACD: the fast and slow EMAs' difference, its signal EMA and the gap between them.",
  "macd_line, signal_line, hist = ta.macd(close, 12, 26, 9)", { history: (v) => v.slow + v.signal });
ta("bb", [src, length(), arg("mult")], ["basis", "upper", "lower"],
  "Bollinger Bands: a simple average and bands `mult` standard deviations either side.",
  "basis, upper, lower = ta.bb(close, 20, 2.0)");
ta("kc", [src, length(), arg("mult"), length("atr_length")], ["basis", "upper", "lower"],
  "Keltner Channels: an EMA and bands `mult` average true ranges either side.",
  "basis, upper, lower = ta.kc(close, 20, 2.0, 10)", { implicit: ["high", "low", "close"] });
ta("stoch", [length(), length("k_smooth"), length("d_smooth")], ["k", "d"],
  "Stochastic oscillator: %K smoothed by `k_smooth`, and %D smoothed again by `d_smooth`.",
  "k, d = ta.stoch(14, 3, 3)", { implicit: ["high", "low", "close"], history: (v) => v.length + v.k_smooth + v.d_smooth });
ta("crossover", [arg("a"), arg("b")], "bool", "True on the bar `a` rises above `b`.", "ta.crossover(close, ma)");
ta("crossunder", [arg("a"), arg("b")], "bool", "True on the bar `a` falls below `b`.", "ta.crossunder(close, ma)");
ta("cross", [arg("a"), arg("b")], "bool", "True on a bar where `a` crosses `b` either way.", "ta.cross(close, ma)");
ta("rising", [src, length()], "bool", "True when `src` has risen on each of the last `length` bars.", "ta.rising(close, 3)");
ta("falling", [src, length()], "bool", "True when `src` has fallen on each of the last `length` bars.", "ta.falling(close, 3)");
ta("barssince", [arg("cond", "bool")], "number", "Bars since `cond` was last true: 0 on a bar where it is. na before the first time.", "ta.barssince(close > open)", { history: () => 0 });
ta("valuewhen", [arg("cond", "bool"), src, arg("nth", "number", { fixed: true, default: 0 })], "number",
  "The value of `src` on the bar `cond` was last true; `nth` 1 is the time before that.", "ta.valuewhen(close > open, low, 0)", { history: (v) => v.nth });
ta("cum", [src], "number", "Running total from the first bar.", "ta.cum(volume)", { history: () => 0 });
ta("sum", [src, length()], "number", "Sum over the last `length` bars.", "ta.sum(volume, 5)");
ta("median", [src, length()], "number", "Median over the last `length` bars.", "ta.median(close, 20)");
ta("percentrank", [src, length()], "number", "Percent of the previous `length` values that are at or below this one.", "ta.percentrank(close, 100)", { history: (v) => v.length + 1 });
ta("pivothigh", [src, length("left"), length("right")], "number",
  "The price of a pivot high, known `right` bars after it: it appears on the bar that confirms it, never earlier. na otherwise.",
  "ph = ta.pivothigh(high, 5, 5)", { history: (v) => v.left + v.right });
ta("pivotlow", [src, length("left"), length("right")], "number",
  "The price of a pivot low, known `right` bars after it: it appears on the bar that confirms it, never earlier. na otherwise.",
  "pl = ta.pivotlow(low, 5, 5)", { history: (v) => v.left + v.right });
ta("vwap", [], "number", "Volume-weighted average price, restarting each day. Intraday charts.", "ta.vwap()",
  { implicit: ["time", "high", "low", "close", "volume"], history: () => 0 });
ta("rvol", [length()], "number", "Volume divided by its average over the `length` bars before this one.", "ta.rvol(20)", { implicit: ["volume"], history: (v) => v.length + 1 });
ta("rvol_at_time", [length("days")], "number",
  "Intraday: volume so far today divided by the average to the same minute over `days` days.", "ta.rvol_at_time(20)", { later: "phase 7" });

// ---- maths ---------------------------------------------------------------------------------

const pure = (name, args, doc, example, options = {}) => add(name, {
  kind: "pure", group: "math", args, returns: "number", doc, example, ...options,
});
const x = arg("x");

pure("math.abs", [x], "Absolute value.", "math.abs(close - open)", { js: "Math.abs" });
pure("math.min", [arg("a"), arg("b")], "The smallest of two or more numbers.", "math.min(open, close)", { js: "Math.min", variadic: true });
pure("math.max", [arg("a"), arg("b")], "The largest of two or more numbers.", "math.max(open, close)", { js: "Math.max", variadic: true });
pure("math.round", [x, arg("digits", "number", { fixed: true, default: 0 })], "Round to the nearest whole number, or to `digits` decimals.", "math.round(x, 2)", { rt: "round" });
pure("math.floor", [x], "Round down.", "math.floor(x)", { js: "Math.floor" });
pure("math.ceil", [x], "Round up.", "math.ceil(x)", { js: "Math.ceil" });
pure("math.sqrt", [x], "Square root. na for a negative number.", "math.sqrt(x)", { js: "Math.sqrt" });
pure("math.log", [x], "Natural logarithm. na for zero or less.", "math.log(close / close[1])", { rt: "log" });
pure("math.exp", [x], "e to the power x.", "math.exp(x)", { js: "Math.exp" });
pure("math.pow", [arg("base"), arg("exponent")], "`base` to the power `exponent`. na where there's no real answer.", "math.pow(x, 0.5)", { rt: "pow" });
pure("math.sign", [x], "-1, 0 or 1.", "math.sign(close - open)", { js: "Math.sign" });
pure("math.clamp", [x, arg("lo"), arg("hi")], "x, held between `lo` and `hi`.", "math.clamp(x, 0, 100)", { rt: "clamp" });
for (const bare of ["abs", "min", "max", "round"]) {
  add(bare, { ...GLOBALS[`math.${bare}`], name: bare, alias: `math.${bare}` });
}
add("na", {
  kind: "special", group: "math", args: [arg("x", "any")], returns: "bool",
  doc: "True when `x` has no value.", example: "na(close[1])",
});
add("nz", {
  kind: "special", group: "math", args: [x, arg("replace", "number", { default: 0 })], returns: "number",
  doc: "`x`, or `replace` (0 unless given) when `x` has no value.", example: "nz(close[1], close)",
});
add("len", {
  kind: "special", group: "list", args: [arg("xs", "list")], returns: "number",
  doc: "How many items a list holds.", example: "len(xs)",
});
add("range", {
  kind: "special", group: "list", args: [arg("start", "number"), arg("stop", "number", { default: null }), arg("step", "number", { default: 1 })],
  returns: "list", doc: "The whole numbers for a `for` loop: range(n), range(start, stop) or range(start, stop, step).",
  example: "for i in range(10):",
});

// ---- inputs --------------------------------------------------------------------------------

export const KWARG_ALIASES = { minval: "min", maxval: "max" };
const inputExtras = [
  text("group", { default: "" }), text("tooltip", { default: "" }),
];
const input = (name, args, returns, doc, example) => add(`input.${name}`, {
  kind: "input", group: "input", args, returns, doc, example,
});
const title = text("title", { default: "" });
const range01 = [
  arg("min", "number", { literal: true, default: null }), arg("max", "number", { literal: true, default: null }),
  arg("step", "number", { literal: true, default: null }),
];
input("int", [arg("default", "number", { literal: true }), title, ...range01, ...inputExtras], "number",
  "A whole-number setting, shown in the indicator's settings.", 'length = input.int(20, "Length", min=1, max=500)');
input("float", [arg("default", "number", { literal: true }), title, ...range01, ...inputExtras], "number",
  "A decimal setting.", 'mult = input.float(2.0, "Multiplier", step=0.1)');
input("source", [arg("default", "number", { literal: true }), title, ...inputExtras], "number",
  "Which price to use: open, high, low, close, hl2, hlc3, ohlc4 or volume. A series.", 'src = input.source(close, "Source")');
input("bool", [arg("default", "bool", { literal: true }), title, ...inputExtras], "bool",
  "A yes/no setting.", 'show = input.bool(true, "Show labels")');
input("choice", [arg("default", "string", { literal: true }), title, arg("options", "list", { literal: true, keywordOnly: true }), ...inputExtras], "string",
  "A pick from a list of text options.", 'side = input.choice("Right", "Labels", options=["Left", "Right"])');
input("color", [arg("default", "color", { literal: true }), title, ...inputExtras], "color",
  "A colour setting.", 'line_c = input.color("#2962ff", "Line")');

// ---- output --------------------------------------------------------------------------------

const output = (name, args, returns, doc, example, options = {}) => add(name, {
  kind: "output", group: "output", args, returns, doc, example, ...options,
});
const plotStyles = ["line", "steps", "histogram", "columns", "area", "circles"];
add("indicator", {
  kind: "special", group: "output",
  args: [text("title"), arg("overlay", "bool", { literal: true, default: false }), text("short", { default: "" }),
    text("format", { default: "price", choices: FORMATS }), arg("precision", "number", { literal: true, default: 2 })],
  returns: "void", doc: "The script's name and where it draws. The first line after `#momo 1`.",
  example: 'indicator("Squeeze", overlay=true)',
});
output("plot", [src, text("title", { default: "" }), color(),
  arg("width", "number", { literal: true, default: 1 }), text("style", { default: "line", choices: plotStyles }),
  text("format", { default: null, choices: FORMATS })], "plot",
  "Draws a series. Returns a handle for fill().", 'p = plot(ta.sma(close, 20), "SMA", color=color.orange)');
output("fill", [arg("a", "plot"), arg("b", "plot"), color()], "void",
  "Shades between two plots (or a plot and an hline).", "fill(up, lo, color=color.blue.alpha(10))");
output("hline", [arg("price", "number", { fixed: true }), text("title", { default: "" }), color(),
  text("style", { default: "dashed", choices: LINE_STYLES })], "plot",
  "A fixed horizontal guide line, like RSI 70 and 30.", 'hline(70, "Overbought")');
output("level", [arg("price"), text("title", { default: "" }), color(),
  text("style", { default: "solid", choices: LINE_STYLES }), arg("show", "bool", { default: true })], "void",
  "A horizontal line at `price` on the last bar, with its value on the axis: key levels.", 'level(ta.highest(high, 252), "52w high")');
output("marker", [arg("cond", "bool"), text("title", { default: "" }),
  text("shape", { default: "triangle_up", choices: SHAPES }), arg("at", "any", { default: "above" }), color(),
  arg("text", "string", { default: "" })], "void",
  "A shape on each bar where `cond` is true. `at` is \"above\", \"below\" or a price.", 'marker(crossed, "Cross", shape="dot", at="below")');
output("barcolor", [arg("color", "color")], "void", "Colours this bar's candle. na leaves it normal.", "barcolor(color.yellow if tight else na)");
output("bgcolor", [arg("color", "color")], "void", "Shades this bar's column.", "bgcolor(color.red.alpha(10) if down else na)");
output("stat", [text("title"), arg("x", "any"), color(), text("format", { default: "number", choices: FORMATS })], "void",
  "A row in the script's corner panel, showing `x` on the last bar.", 'stat("ADR", ta.adr(20), format="percent")');
output("signal", [text("name"), arg("cond", "bool")], "void",
  "Publishes a yes/no for the screener, watchlist columns, alerts and signal stats. Draws nothing.", 'signal("squeeze", tight)');
output("value", [text("name"), arg("x")], "void",
  "Publishes a number for the screener, watchlist columns and alerts. Draws nothing.", 'value("adr", ta.adr(20))');
output("log", [arg("x", "any")], "void", "Prints to the editor's console with the bar's date.", 'log("close", close)', { variadic: true });
output("line", [arg("x1"), arg("y1"), arg("x2"), arg("y2"), color(), arg("width", "number", { default: 1 }),
  text("style", { default: "solid", choices: LINE_STYLES }), text("extend", { default: "none", choices: ["none", "right", "both"] })], "handle",
  "A drawn line between two points; x is a bar_index.", "g = line(bar_index[5], low[5], bar_index, low)", { later: "phase 6" });
output("box", [arg("x1"), arg("top"), arg("x2"), arg("bottom"), color(), arg("border", "color", { default: null })], "handle",
  "A shaded box.", "b = box(bar_index[3], high[3], bar_index, low[3])", { later: "phase 6" });
output("label", [arg("x"), arg("y"), arg("text", "string"), color(), text("at", { default: "above" })], "handle",
  "Text at a point.", 'label(bar_index, high, "Top")', { later: "phase 6" });

// ---- other timeframes, symbols and momo's data (later phases) ------------------------------

add("tf", {
  kind: "special", group: "data", args: [text("timeframe"), arg("expr", "any", { default: null })], returns: "bars",
  doc: "Finished bars of a higher timeframe (\"D\", \"W\", \"M\"), or an expression worked out on them.",
  example: 'daily = tf("D")', later: "phase 7",
});
add("symbol", {
  kind: "special", group: "data", args: [text("name")], returns: "bars",
  doc: "Another symbol's bars on the chart's timeframe, matched by time.", example: 'spy = symbol("SPY")', later: "phase 7",
});
for (const field of ["open", "high", "low", "close", "volume"]) {
  add(`today.${field}`, {
    kind: "series", group: "data", type: "number", doc: `The day so far: its ${field}, built from this chart's bars up to this one. Intraday charts.`,
    example: `today.${field}`, later: "phase 7",
  });
}
const dataSeries = {
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
};
for (const [name, doc] of Object.entries(dataSeries)) {
  add(name, { kind: "series", group: "data", type: name.startsWith("info.") ? "string" : "number", doc, example: name, later: "phase 7" });
}

// ---- bar series, calendar, chart -----------------------------------------------------------

const series = (name, type, doc, options = {}) => add(name, {
  kind: "series", group: "series", type, doc, example: name, ...options,
});
series("open", "number", "This bar's open.", { array: true });
series("high", "number", "This bar's high.", { array: true });
series("low", "number", "This bar's low.", { array: true });
series("close", "number", "This bar's close.", { array: true });
series("volume", "number", "This bar's volume.", { array: true });
series("hl2", "number", "(high + low) / 2.", { array: true });
series("hlc3", "number", "(high + low + close) / 3.", { array: true });
series("ohlc4", "number", "(open + high + low + close) / 4.", { array: true });
series("time", "number", "The bar's time in seconds.", { array: true });
series("bar_index", "number", "0 for the first bar, 1 for the next, and so on.", { array: true });
series("first_bar", "bool", "True on the first bar.");
series("last_bar", "bool", "True on the last bar (the latest, or the one replay has reached).");
series("year", "number", "The bar's year.", { array: true, calendar: true });
series("month", "number", "The bar's month, 1 to 12.", { array: true, calendar: true });
series("day", "number", "The bar's day of the month.", { array: true, calendar: true });
series("dayofweek", "number", "1 for Monday through 7 for Sunday.", { array: true, calendar: true });
series("hour", "number", "The bar's hour, New York time. Intraday charts.", { array: true, calendar: true });
series("minute", "number", "The bar's minute. Intraday charts.", { array: true, calendar: true });
series("session.regular", "bool", "True for bars inside 09:30–16:00 New York time.");
series("session.new_day", "bool", "True on the first bar of each day.");
series("timeframe.is_intraday", "bool", "True on minute and hour charts.", { fixed: true });
series("timeframe.is_daily", "bool", "True on a daily chart.", { fixed: true });
series("timeframe.is_weekly", "bool", "True on a weekly chart.", { fixed: true });
series("timeframe.is_monthly", "bool", "True on a monthly chart.", { fixed: true });
series("ticker", "string", "The chart's symbol.", { fixed: true });

// ---- colours -------------------------------------------------------------------------------

for (const [name, hex] of Object.entries(PALETTE)) {
  add(`color.${name}`, { kind: "const", group: "color", type: "color", value: parseColor(hex), doc: `The ${name} of TradingView's palette (${hex}).`, example: `color.${name}` });
}
add("color.rgb", {
  kind: "pure", group: "color", args: [arg("r"), arg("g"), arg("b"), arg("alpha", "number", { default: 100 })], returns: "color",
  rt: "rgb", doc: "A colour from red, green and blue (0–255) and opacity (0 clear, 100 solid).", example: "color.rgb(41, 98, 255)",
});

// ---- methods and attributes ----------------------------------------------------------------

const method = (type, name, args, returns, doc, example, options = {}) => {
  METHODS[type][name] = { name, owner: type, args, returns, doc, example, ...options };
};
method("color", "alpha", [arg("pct")], "color", "This colour with a new opacity (0 clear, 100 solid).", "color.blue.alpha(10)");
method("list", "push", [arg("value")], "void", "Adds an item to the end.", "xs.push(close)");
method("list", "pop", [], "number", "Removes and returns the last item.", "xs.pop()");
method("list", "remove", [arg("i")], "void", "Removes the item at position i.", "xs.remove(0)");
method("list", "clear", [], "void", "Empties the list.", "xs.clear()");
method("list", "sum", [], "number", "The items added up.", "xs.sum()");
method("list", "max", [], "number", "The largest item.", "xs.max()");
method("list", "min", [], "number", "The smallest item.", "xs.min()");
method("list", "avg", [], "number", "The average of the items.", "xs.avg()");
method("handle", "set", [], "void", "Changes a drawn line, box or label: g.set(x2=bar_index).", "g.set(x2=bar_index)", { later: "phase 6", kwargs: true });
method("handle", "delete", [], "void", "Removes a drawn line, box or label.", "g.delete()", { later: "phase 6" });
for (const field of ["open", "high", "low", "close", "volume", "time"]) {
  method("bars", field, [], "number", `The ${field} of another series of bars.`, `tf("D").${field}`, { later: "phase 7", attribute: true });
}

export { GLOBALS, METHODS };

// The namespaces a dotted name can start with.
export const NAMESPACES = new Set(Object.keys(GLOBALS).filter((n) => n.includes(".")).map((n) => n.split(".")[0]));

// Every public name, methods as "type.name" (the reference's tables and this list must agree).
export const allNames = () => [
  ...Object.keys(GLOBALS),
  ...Object.entries(METHODS).flatMap(([type, methods]) => Object.keys(methods).map((m) => `${type}.${m}`)),
];

// "ta.sma(src, length)" for hover docs and error messages.
export function signature(entry) {
  const shown = (a) => (a.default === null ? "na" : JSON.stringify(a.default));
  const parts = entry.args.map((a) => (Object.hasOwn(a, "default") ? `${a.name}=${shown(a)}` : a.name));
  return `${entry.name}(${parts.join(", ")})`;
}

// The members of a namespace: names("ta") → ["sma", "ema", ...].
export const members = (namespace) => Object.keys(GLOBALS)
  .filter((n) => n.startsWith(`${namespace}.`)).map((n) => n.slice(namespace.length + 1));
