import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "../../../src/momo_scan/web/static/js/script/checker.js";
import { parse } from "../../../src/momo_scan/web/static/js/script/parser.js";

const HEAD = '#momo 1\nindicator("T", overlay=true)\n';
const run = (body) => check(parse(HEAD + body));
const errorsOf = (body) => { const r = run(body); return r.ok ? [] : r.errors; };
// [code, line, col] of the first error, with lines counted from the body's first line.
const first = (body) => { const [e] = errorsOf(body); return e ? [e.code, e.line - 2, e.col] : null; };
const ok = (body) => { const r = run(body); assert.ok(r.ok, r.ok ? "" : r.errors.map((e) => `${e.code} ${e.line - 2}:${e.col} ${e.message}`).join("\n")); return r; };

// ---- one failing source per rule, with where the error points --------------------------------

const FAILING = [
  // E2xx: names and rules
  ["E201 unknown name", "x = clsoe", "E201", 1, 5],
  ["E201 function defined below", "y = f(1)\ndef f(a):\n    return a", "E201", 1, 5],
  ["E202 unknown member", "x = ta.smaa(close, 20)", "E202", 1, 8],
  ["E202 unknown attribute", "x = color.rde", "E202", 1, 11],
  ["E202 unknown list method", "xs = []\nxs.append(1)", "E202", 2, 4],
  ["E203 used before set", "y = x + 1\nx = 2", "E203", 1, 5],
  ["E203 changed before it has a value", "x += 1", "E203", 1, 1],
  ["E204 ta in an if", "if close > open:\n    x = ta.sma(close, 20)", "E204", 2, 9],
  ["E204 ta in a loop", "for i in range(3):\n    x = ta.ema(close, 5)", "E204", 2, 9],
  ["E204 ta in a var line", "var x = ta.sma(close, 3)", "E204", 1, 9],
  ["E204 ta in a function called from an if", "def f(a):\n    return ta.sma(a, 3)\nif close > open:\n    x = f(close)", "E204", 2, 12],
  ["E205 history of an expression inside an if", "if close > open:\n    y = (high - low)[1]", "E205", 2, 10],
  ["E206 negative history", "x = close[-1]", "E206", 1, 11],
  ["E206 negative history through a name", "n = -2\nx = close[n]", "E206", 2, 11],
  ["E207 plot inside an if", "if close > open:\n    plot(close)", "E207", 2, 5],
  ["E207 plot inside a function", "def f(a):\n    plot(a)\nf(close)", "E207", 2, 5],
  ["E207 def inside an if", "if close > open:\n    def f(a):\n        return a", "E207", 2, 5],
  ["E208 recursion", "def f(a):\n    return f(a)\nx = f(1)", "E208", 2, 12],
  ["E208 indirect recursion", "def g(a):\n    return h(a)\ndef h(a):\n    return g(a)\nx = g(1)", "E208", 4, 12],
  ["E209 return outside a function", "return 3", "E209", 1, 1],
  ["E209 break outside a loop", "break", "E209", 1, 1],
    ["E210 indicator twice", 'indicator("Again")', "E210", 1, 1],
  ["E211 reserved name", "close = 3", "E211", 1, 1],
  ["E211 function name", "signal = ta.ema(close, 9)", "E211", 1, 1],
  ["E211 double underscore", "__proto__ = 3", "E211", 1, 1],
  ["E211 a built-in as a parameter", "def f(close):\n    return close\nx = f(1)", "E211", 1, 7],
  ["E211 double underscore as a parameter", "def f(__a):\n    return 1\nx = f(1)", "E211", 1, 7],
  ["E212 duplicate def", "def f(a):\n    return a\ndef f(b):\n    return b", "E212", 3, 1],
  ["E212 var after set", "x = 1\nvar x = 2", "E212", 2, 5],
  ["E213 a line that does nothing", "close + 1", "E213", 1, 1],
  ["E214 input in an if", "if close > open:\n    n = input.int(5)", "E214", 2, 5],
  ["E214 input without a name", "input.int(5)", "E214", 1, 1],
  ["E214 input set twice", "n = input.int(5)\nn = 6", "E214", 1, 1],
  ["E214 input in an expression", "x = input.int(5) + 1", "E214", 1, 5],
  ["E215 input default not literal", "n = input.int(2 + 3)", "E215", 1, 15],
  ["E215 title not literal", 't = "a"\nplot(close, t)', "E215", 2, 13],
  ["E216 duplicate signal", 'signal("a", close > open)\nvalue("a", close)', "E216", 2, 7],
  ["E217 not available yet", 'x = tf("D")', "E217", 1, 5],
  ["E217 drawing not available yet", "line(1, 2, 3, 4)", "E217", 1, 1],
  // E3xx: types
  ["E301 text where a number goes", 'x = "a" + 1', "E301", 1, 5],
  ["E301 list in arithmetic", "xs = []\nx = xs + 1", "E301", 2, 5],
  ["E301 int input needs a whole number", "n = input.int(2.5)", "E301", 1, 15],
  ["E301 length must be whole", "x = ta.sma(close, 2.5)", "E301", 1, 19],
  ["E301 conditional of different kinds", 'x = "a" if close > open else 1', "E301", 1, 5],
  ["E301 compare text with number", 'x = "a" == 1', "E301", 1, 5],
  ["E302 variable changes type", 'x = "a"\nx = 1', "E302", 2, 5],
  ["E303 too many arguments", "x = ta.sma(close, 20, 5)", "E303", 1, 23],
  ["E303 missing argument", "x = ta.sma(close)", "E303", 1, 5],
  ["E303 unknown keyword (did you mean)", "x = ta.sma(close, lenght=20)", "E303", 1, 19],
  ["E303 given twice", "x = ta.sma(close, 20, length=20)", "E303", 1, 23],
  ["E303 user function arguments", "def f(a):\n    return a\nx = f(1, 2)", "E303", 3, 5],
  ["E304 length is a series", "x = ta.sma(close, bar_index)", "E304", 1, 19],
  ["E304 length varies in an if", "n = 5\nif close > open:\n    n = 6\nx = ta.sma(close, n)", "E304", 4, 19],
  ["E304 history index is a series", "x = close[bar_index]", "E304", 1, 11],
  ["E305 not one of the options", 'plot(close, style="lne")', "E305", 1, 19],
  ["E305 namespace used as a value", "x = ta", "E305", 1, 5],
  ["E306 index text", 'x = "abc"[1]', "E306", 1, 5],
  ["E306 method without a call", "x = color.red.alpha", "E306", 1, 15],
  ["E307 bad colour", 'plot(close, color="red")', "E307", 1, 19],
  ["E308 tuple needs unpacking", "x = ta.macd(close, 12, 26, 9)", "E308", 1, 5],
  ["E308 wrong number of names", "a, b = ta.macd(close, 12, 26, 9)", "E308", 1, 1],
  ["E308 tuple in an expression", "x = (1, 2)", "E308", 1, 5],
  ["E309 function without a call", "x = plot", "E309", 1, 5],
  ["E309 void used as a value", "def f(a):\n    pass\nx = f(1)", "E309", 3, 5],
  // E4xx: limits
  ["E403 text too long", `x = "${"a".repeat(201)}"`, "E403", 1, 5],
];

for (const [name, body, code, line, col] of FAILING) {
  if (!code) continue;
  test(`fails: ${name}`, () => {
    assert.deepEqual(first(body), [code, line, col], JSON.stringify(errorsOf(body).map((e) => [e.code, e.line - 2, e.col, e.message])));
  });
}

// ---- one passing source per rule -------------------------------------------------------------

const PASSING = [
  ["names, builtins and user variables", "x = close\ny = x + hl2"],
  ["a member of a namespace", "x = ta.sma(close, 20)"],
  ["a variable set before use", "x = 2\ny = x + 1"],
  ["last bar's value before the first set", "x = nz(x[1]) + 1"],
  ["ta on every bar, used inside an if", "avg = ta.sma(close, 20)\nif close > avg:\n    y = avg"],
  ["ta inside a conditional expression runs on every bar", "x = ta.sma(close, 3) if close > open else ta.ema(close, 3)"],
  ["ta inside a function called at the top", "def f(a):\n    return ta.sma(a, 3)\nx = f(close)"],
  ["history of an expression at the top level", "y = (high - low)[1]"],
  ["history of a name inside an if", "r = high - low\nif close > open:\n    y = r[1]"],
  ["plot, hline, fill, signal at the top level", 'p = plot(close, "A")\nh = hline(0, "Zero")\nfill(p, h)\nsignal("up", close > open)'],
  ["a function used twice with different lengths", "def avg(a, n):\n    return ta.sma(a, n)\nx = avg(close, 5) + avg(close, 10)"],
  ["a recursion-free chain of functions", "def a(x):\n    return x + 1\ndef b(x):\n    return a(a(x))\ny = b(close)"],
  ["return and break in the right places", "def f(a):\n    for i in range(3):\n        if i > a:\n            break\n    return a\nx = f(close)"],
  ["a shadowed calendar name", "day = tf_ok = 3\nx = day + 1".replace("tf_ok = ", "")],
  ["var then plain assignment", "var n = 0\nn += 1\nplot(n)"],
  ["a def at the top level", "def f(a):\n    return a"],
  ["an input at the top level", 'n = input.int(5, "N")'],
  ["inputs of every kind", 'a = input.int(1)\nb = input.float(1.5)\nc = input.bool(true)\nd = input.choice("x", "D", options=["x", "y"])\ne = input.color("#ff0000")\nf = input.source(close)'],
  ["string and colour literals", 'plot(close, "A", color="#2962ff")\nplot(open, "B", color=color.rgb(1, 2, 3))'],
  ["a conditional of the same kind", "x = 1 if close > open else 2"],
  ["comparisons of text", 'side = input.choice("a", "S", options=["a", "b"])\nx = 1 if side == "a" else 2'],
  ["a number where a bool goes, and back", "up_days = ta.sum(close > open, 5)\nif up_days:\n    pass"],
  ["a fixed length through variables", "n = 10\nm = n * 2\nx = ta.sma(close, m)"],
  ["a length from a function argument", "def f(a, n):\n    return ta.sma(a, n)\nx = f(close, 7)"],
  ["a length from an input", "n = input.int(20)\nx = ta.sma(close, n)"],
  ["a choice among the right options", 'plot(close, style="histogram")'],
  ["a method call", "xs = []\nxs.push(close)\nxs.clear()"],
  ["a method with a result", "var xs = []\nxs.push(close)\nm = xs.max()"],
  ["a color method", "c = color.red.alpha(30)\nx = c"],
  ["unpacking a ta call", "a, b, c = ta.macd(close, 12, 26, 9)"],
  ["unpacking a user function", "def f(a):\n    return a, a * 2\nx, y = f(close)"],
  ["f-strings", 'x = f"{close:.2f} {open}"'],
  ["round and clamp", "x = math.round(close, 2) + clamp_ok".replace(" + clamp_ok", "") + "\ny = math.clamp(x, 0, 1)"],
  ["a for loop over a list", "xs = [1, 2, 3]\ns = 0\nfor v in xs:\n    s += v"],
  ["a while loop", "n = 0\nwhile n < 3:\n    n += 1"],
  ["a bare call as a statement", "log(close)"],
  ["na and nz", "x = nz(na(close)) + 1"],
  ["a bool var starting from na", "var seen = false\nif close > open:\n    seen = true"],
];

for (const [name, body] of PASSING) {
  test(`passes: ${name}`, () => { ok(body); });
}

// ---- "did you mean", fixes and positions --------------------------------------------------

test("did you mean: names, members, keywords, options", () => {
  const fixOf = (body) => errorsOf(body)[0].fix;
  assert.match(fixOf("x = clsoe"), /`close`/);
  assert.match(fixOf("x = ta.smaa(close, 20)"), /`ta.sma`/);
  assert.match(fixOf("x = ta.sma(close, lenght=20)"), /`length`/);
  assert.match(fixOf('plot(close, style="lne")'), /"line"/);
  assert.match(fixOf("x = nz(clse)"), /`close`/);
  assert.match(fixOf("v = 1\nx = vv + 1"), /`v`/);
  assert.equal(errorsOf("x = zzzzzz")[0].fix, null);
});

test("errors carry an end column that spans the name", () => {
  const [e] = errorsOf("x = clsoe + 1");
  assert.deepEqual([e.col, e.endCol], [5, 10]);
});

test("E204 explains and shows the fix", () => {
  const [e] = errorsOf("if close > open:\n    x = ta.sma(close, 20)");
  assert.match(e.message, /ta\.sma runs inside an if, so it would skip bars/);
  assert.match(e.fix, /ta\.sma\(close, 20\)/);
});

test("all errors come back sorted, not just the first", () => {
  const errors = errorsOf("a = clsoe\nb = ta.smaa(close, 3)\nc = zzz");
  assert.deepEqual(errors.map((e) => e.code), ["E201", "E202", "E201"]);
  assert.deepEqual(errors.map((e) => e.line - 2), [1, 2, 3]);
});

test("one slip doesn't cascade into every later use", () => {
  const errors = errorsOf("a = clsoe\nb = a + 1\nplot(b)");
  assert.equal(errors.length, 1);
});

test("an uncalled function is still checked for names", () => {
  assert.deepEqual(first("def f(a):\n    return a + clsoe"), ["E201", 2, 16]);
  ok("def f(a, b):\n    return a.alpha(b)");
});

test("a function is checked with each call's types", () => {
  ok("def f(c):\n    return c.alpha(50)\nx = f(color.red)");
  assert.equal(first("def f(c):\n    return c.alpha(50)\nx = f(close)")[0], "E202");
});

test("E210: a script must start with indicator(...)", () => {
  const r = check(parse("#momo 1\nx = 1"));
  assert.equal(r.ok, false);
  assert.deepEqual([r.errors[0].code, r.errors[0].line, r.errors[0].col], ["E210", 2, 1]);
  assert.equal(check(parse("")).errors[0].code, "E210");
});

test("limits: too many plots, too many call sites, a long list", () => {
  const plots = Array.from({ length: 65 }, (_, i) => `plot(close, "P${i}")`).join("\n");
  assert.equal(errorsOf(plots).at(-1).code, "E402");
  ok(Array.from({ length: 64 }, (_, i) => `plot(close, "P${i}")`).join("\n"));
  const calls = "def f(a):\n    return a + 1\n" + Array.from({ length: 401 }, () => "x = f(1)").join("\n");
  assert.equal(errorsOf(calls)[0].code, "E405");
  assert.equal(first(`xs = [${Array(10001).fill(1).join(",")}]`)[0], "E404");
});

// ---- the IR the generator reads, and fixed vs series ------------------------------------------

test("fixed values: literals, inputs and maths on them, never series", () => {
  const r = ok("n = input.int(5)\nm = n * 2 + 1\nx = ta.sma(close, m)\nq = close * 2");
  const sym = (name) => r.ir.syms.find((s) => s.name === name);
  assert.equal(sym("n").fixed, true);
  assert.equal(sym("m").fixed, true);
  assert.equal(sym("q").fixed, false);
  assert.equal(sym("x").fixed, false);
});

test("a name set twice, or only in a branch, isn't fixed", () => {
  const r = ok("n = 5\nn = 6\nif close > open:\n    k = 3\nj = 2");
  const sym = (name) => r.ir.syms.find((s) => s.name === name);
  assert.equal(sym("n").fixed, false);
  assert.equal(sym("k").fixed, false);
  assert.equal(sym("j").fixed, true);
});

test("each ta call site is its own stepper", () => {
  const r = ok("a = ta.sma(close, 5)\nb = ta.sma(close, 5)\nc, d, e = ta.bb(close, 20, 2.0)");
  assert.equal(r.ir.steppers.length, 3);
  assert.deepEqual(r.ir.steppers.map((s) => s.entry.name), ["ta.sma", "ta.sma", "ta.bb"]);
  assert.deepEqual(r.ir.steppers[2].ctor.map((e) => e.v), [20]);
  assert.deepEqual(r.ir.steppers[2].step.map((e) => e.k), ["ser", "num"]);
});

test("a function gets its own steppers per call site", () => {
  const r = ok("def f(a, n):\n    return ta.sma(a, n)\nx = f(close, 5)\ny = f(open, 10)");
  assert.equal(r.ir.steppers.length, 2);
});

test("a function that is never called leaves nothing behind", () => {
  const r = ok("def f(a):\n    return ta.sma(a, 3)\nx = close");
  assert.equal(r.ir.steppers.length, 0);
  assert.ok(!r.ir.syms.some((s) => s.js.startsWith("f")));
});

test("history marks the variable and the series it reads", () => {
  const r = ok("x = close - open\ny = x[1] + x[2] + close[3] + (x * 2)[1]");
  assert.equal(r.ir.syms.find((s) => s.name === "x").hist, true);
  assert.equal(r.ir.hidden.length, 1);
  assert.ok(r.ir.uses.has("close"));
});

// ---- meta -----------------------------------------------------------------------------------

test("meta: title, overlay, format, precision", () => {
  const r = check(parse('indicator("Squeeze", overlay=true, short="SQ", format="percent", precision=1)\nplot(close)'));
  assert.equal(r.ok, true);
  assert.deepEqual([r.meta.version, r.meta.title, r.meta.short, r.meta.overlay, r.meta.format, r.meta.precision], [1, "Squeeze", "SQ", true, "percent", 1]);
  const defaults = ok("x = 1").meta;
  assert.deepEqual([defaults.title, defaults.short, defaults.overlay, defaults.format, defaults.precision], ["T", "T", true, "price", 2]);
});

test("meta: inputs", () => {
  const r = ok(`length = input.int(20, "Length", min=2, max=500, group="Average")
mult = input.float(2.0, "StdDev", step=0.1, tooltip="width")
src = input.source(hl2, "Source")
show = input.bool(true, "Show")
side = input.choice("Right", "Labels", options=["Left", "Right"])
tint = input.color("#2962ff", "Line")
loose = input.int(3, minval=1, maxval=9)`);
  assert.deepEqual(r.meta.inputs.map((i) => [i.key, i.kind, i.default]), [
    ["length", "int", 20], ["mult", "float", 2], ["src", "source", "hl2"], ["show", "bool", true],
    ["side", "choice", "Right"], ["tint", "color", "#2962ff"], ["loose", "int", 3],
  ]);
  assert.deepEqual(r.meta.inputs[0], { key: "length", kind: "int", default: 20, title: "Length", min: 2, max: 500, step: null, options: null, group: "Average", tooltip: "" });
  assert.equal(r.meta.inputs[1].step, 0.1);
  assert.equal(r.meta.inputs[1].tooltip, "width");
  assert.deepEqual(r.meta.inputs[4].options, ["Left", "Right"]);
  assert.deepEqual([r.meta.inputs[6].min, r.meta.inputs[6].max], [1, 9]);
  assert.equal(r.meta.inputs[6].title, "loose");
});

test("meta: plots with keys, kinds, colours", () => {
  const r = ok(`up = plot(close, "Upper Band", color=color.blue, width=2)
plot(open, "Upper Band", style="histogram", color="#ff980080")
plot(low)
dyn = plot(high, "Dyn", color=color.green if close > open else color.red)
hline(70, "Overbought", color=color.gray)
fill(up, dyn, color=color.blue.alpha(10))
marker(close > open, "Up", shape="dot", at="below")
level(ta.highest(high, 20), "High")
barcolor(color.yellow if close > open else na)
bgcolor(color.red.alpha(5))`);
  const plots = r.meta.plots;
  assert.deepEqual(plots.map((p) => [p.key, p.kind]), [
    ["upper_band", "line"], ["upper_band_2", "histogram"], ["plot_3", "line"], ["dyn", "line"], ["overbought", "hline"],
    ["fill", "fill"], ["up", "marker"], ["high", "level"], ["barcolor", "barcolor"], ["bgcolor", "bgcolor"],
  ]);
  assert.equal(plots[0].color, "#2962ff");
  assert.equal(plots[0].width, 2);
  assert.equal(plots[1].color, "#ff980080");
  assert.equal(plots[3].colorSeries, true);
  assert.equal(plots[0].colorSeries, false);
  assert.deepEqual([plots[4].price, plots[4].style], [70, "dashed"]);
  assert.deepEqual([plots[5].a, plots[5].b], ["upper_band", "dyn"]);
  assert.equal(plots[5].color, "#2962ff1a");
  assert.deepEqual([plots[6].shape, plots[6].at], ["dot", "below"]);
});

test("meta: signals", () => {
  const r = ok('signal("squeeze", close > open)\nvalue("adr", ta.adr(20))');
  assert.deepEqual(r.meta.signals, [{ name: "squeeze", kind: "bool" }, { name: "adr", kind: "number" }]);
});

test("meta: needs.history is the largest length plus the largest offset", () => {
  assert.equal(ok("x = ta.sma(close, 20)").meta.needs.history, 20);
  assert.equal(ok("x = ta.sma(close, 20)\ny = x[5]").meta.needs.history, 25);
  assert.equal(ok("n = input.int(10, max=250)\nx = ta.highest(high, n)[1]").meta.needs.history, 251);
  assert.equal(ok("a, b, c = ta.macd(close, 12, 26, 9)").meta.needs.history, 35);
  assert.equal(ok("x = close[3]").meta.needs.history, 3);
  assert.equal(ok("x = 1").meta.needs.history, 0);
  assert.deepEqual(ok("x = 1").meta.needs.tf, []);
});

test("a script with errors has no meta or ir", () => {
  const r = run("x = clsoe");
  assert.equal(r.ok, false);
  assert.equal(r.meta, undefined);
  assert.equal(r.ir, undefined);
});
