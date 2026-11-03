import assert from "node:assert/strict";
import { test } from "node:test";

import { parse } from "../../../src/momo_scan/web/static/js/script/parser.js";
import { strip, unparse } from "./helpers.mjs";

const SPECIMEN = `#momo 1
indicator("Squeeze", overlay=true)

length = input.int(20, "Length", min=2, max=500)
basis = ta.sma(close, length)
dev = 2.0 * ta.stdev(close, length)
width = (basis + dev - (basis - dev)) / basis * 100
tight = width < ta.lowest(width, 120)[1]
up = plot(basis, "Basis", color=color.orange)
fill(up, up, color=color.blue.alpha(10))
marker(tight and not tight[1], "Squeeze", shape="dot", at="below")
var highest_close = na
if na(highest_close) or close > highest_close:
    highest_close = close
elif close < 0:
    pass
else:
    highest_close -= 1
var up_days = 0
up_days += 1 if close > open else 0
for i in range(0, 10, 2):
    if i == 4:
        continue
    if i > 6:
        break
for x in [1, 2, 3]:
    up_days *= x
while up_days > 100:
    up_days /= 2

def band(src, length, k=2.0):
    basis = ta.sma(src, length)
    return basis + k * ta.stdev(src, length), basis - k * ta.stdev(src, length)

def pct(a, b):
    return (a / b - 1) * 100

hi, lo = band(close, 20)
label_text = f"ADR {pct(high, low):.2f}% {{ok}}"
power = -2 ** -1 ** 2
`;

test("a specimen script parses and round-trips through unparse", () => {
  const ast = parse(SPECIMEN);
  const again = parse(unparse(ast));
  assert.deepEqual(strip(again), strip(ast));
  assert.equal(ast.type, "Program");
  assert.deepEqual(ast.header, { version: 1 });
});

const expression = (source) => strip(parse(`x = ${source}`).body[0].value);
const num = (value) => ({ type: "Num", value });
const name = (id) => ({ type: "Name", id });

test("literals and constants", () => {
  assert.deepEqual(expression("14"), num(14));
  assert.deepEqual(expression('"hi"'), { type: "Str", value: "hi" });
  assert.deepEqual(expression("true"), { type: "Bool", value: true });
  assert.deepEqual(expression("False"), { type: "Bool", value: false });
  assert.deepEqual(expression("na"), { type: "Na" });
  assert.deepEqual(expression("None"), { type: "Na" });
  assert.deepEqual(expression("[1, x, ]"), { type: "List", items: [num(1), name("x")] });
  assert.deepEqual(expression("[]"), { type: "List", items: [] });
});

test("na(x) is a call, bare na is the constant", () => {
  assert.deepEqual(expression("na(x)"), { type: "Call", callee: name("na"), args: [name("x")], kwargs: [] });
});

test("precedence: arithmetic, comparison, logic, conditional", () => {
  assert.equal(unparse(parse("x = 1 + 2 * 3 ** 2 ** 2 - 4 / 5 % 6").body[0].value), "((1 + (2 * (3 ** (2 ** 2)))) - ((4 / 5) % 6))");
  assert.equal(unparse(parse("x = a < b and c >= d or not e == f").body[0].value), "(((a < b) and (c >= d)) or (not (e == f)))");
  assert.equal(unparse(parse("x = a if b else c if d else e").body[0].value), "(a if b else (c if d else e))");
  assert.equal(unparse(parse("x = -a ** 2").body[0].value), "(-(a ** 2))");
  assert.equal(unparse(parse("x = 2 ** -1").body[0].value), "(2 ** (-1))");
  assert.equal(unparse(parse("x = +a - -b").body[0].value), "(a - (-b))");
  assert.equal(unparse(parse("x = (a + b) * c").body[0].value), "((a + b) * c)");
});

test("postfix: calls, keyword arguments, indexing, attributes", () => {
  assert.deepEqual(expression("ta.sma(close, n=20)[1]"), {
    type: "Index",
    target: {
      type: "Call",
      callee: { type: "Attr", target: name("ta"), name: "sma" },
      args: [name("close")],
      kwargs: [{ name: "n", value: num(20) }],
    },
    index: num(1),
  });
  assert.equal(unparse(parse("x = color.blue.alpha(10)").body[0].value), "color.blue.alpha(10)");
  assert.equal(unparse(parse("x = tf('D').high[2]").body[0].value), 'tf("D").high[2]');
  assert.equal(unparse(parse("x = f(a, b,)").body[0].value), "f(a, b)");
});

test("f-strings hold expressions with their specs", () => {
  const f = expression('f"a {x + 1:.1f}b{y}"');
  assert.equal(f.type, "FStr");
  assert.equal(f.parts[0], "a ");
  assert.deepEqual(f.parts[1], { expr: { type: "Binary", op: "+", left: name("x"), right: num(1) }, spec: ".1f" });
  assert.equal(f.parts[2], "b");
  assert.deepEqual(f.parts[3], { expr: name("y"), spec: "" });
});

test("f-string expressions keep their real positions", () => {
  const ast = parse('x = f"ab {foo + 1}"');
  const binary = ast.body[0].value.parts[1].expr;
  assert.deepEqual([binary.left.line, binary.left.col], [1, 11]);
});

test("statements: assign, augmented, var, :=, unpack, expression statement", () => {
  const body = (s) => strip(parse(s).body);
  assert.deepEqual(body("x = 1"), [{ type: "Assign", target: name("x"), op: "=", value: num(1), isVar: false }]);
  assert.deepEqual(body("x := 1"), body("x = 1"));
  assert.deepEqual(body("x += 2")[0].op, "+=");
  assert.deepEqual(body("x -= 2")[0].op, "-=");
  assert.deepEqual(body("x *= 2")[0].op, "*=");
  assert.deepEqual(body("x /= 2")[0].op, "/=");
  assert.deepEqual(body("var x = 0")[0], { type: "Assign", target: name("x"), op: "=", value: num(0), isVar: true });
  assert.deepEqual(body("var x := 0")[0].isVar, true);
  assert.deepEqual(body("a, b, c = f(1)"), [{
    type: "Unpack", targets: [name("a"), name("b"), name("c")],
    value: { type: "Call", callee: name("f"), args: [num(1)], kwargs: [] },
  }]);
  assert.deepEqual(body("plot(x)"), [{ type: "ExprStmt", expr: { type: "Call", callee: name("plot"), args: [name("x")], kwargs: [] } }]);
});

test("if / elif / else nest the elif in orelse; `else if` is read as elif", () => {
  const a = strip(parse("if a:\n    x = 1\nelif b:\n    x = 2\nelse:\n    x = 3\n").body);
  const b = strip(parse("if a:\n    x = 1\nelse if b:\n    x = 2\nelse:\n    x = 3\n").body);
  assert.deepEqual(a, b);
  assert.equal(a[0].orelse[0].type, "If");
  assert.equal(a[0].orelse[0].orelse.length, 1);
  assert.deepEqual(a[0].orelse[0].test, name("b"));
});

test("loops, break, continue, pass", () => {
  const [f, w] = strip(parse("for i in range(3):\n    continue\nwhile x:\n    break\n").body);
  assert.deepEqual(f.target, name("i"));
  assert.equal(f.iter.type, "Call");
  assert.deepEqual(f.body, [{ type: "Continue" }]);
  assert.deepEqual(w.body, [{ type: "Break" }]);
  assert.deepEqual(strip(parse("if a:\n    pass\n").body[0].body), [{ type: "Pass" }]);
});

test("def with defaults, return of nothing, a value and a tuple", () => {
  const [d] = strip(parse("def f(a, b=2):\n    return\n\ndef g():\n    return a, b\n").body);
  assert.deepEqual(d.params, [{ name: "a", default: null }, { name: "b", default: num(2) }]);
  assert.deepEqual(d.body, [{ type: "Return", value: null }]);
  const g = strip(parse("def g():\n    return a, b\n").body[0]);
  assert.deepEqual(g.body[0].value, { type: "Tuple", items: [name("a"), name("b")] });
});

test("one-line suites", () => {
  const ast = strip(parse("if a: x = 1\nelse: x = 2\n").body);
  assert.deepEqual(ast[0].body[0].type, "Assign");
  assert.deepEqual(ast[0].orelse[0].type, "Assign");
});

test("brackets continue a line across newlines", () => {
  const ast = parse("x = foo(1,\n    2,\n)\ny = 3\n");
  assert.equal(ast.body.length, 2);
  assert.equal(ast.body[0].value.args.length, 2);
});

test("a blank, comment-only or header-only script parses to an empty body", () => {
  assert.deepEqual(parse("").body, []);
  assert.deepEqual(parse("# nothing\n").header, null);
  assert.deepEqual(parse("#momo 1\n").header, { version: 1 });
});

test("every node has a position", () => {
  const seen = [];
  const visit = (n) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (n && typeof n === "object") {
      if (n.type && n.type !== "Program") seen.push(n);
      Object.values(n).forEach(visit);
    }
  };
  visit(parse(SPECIMEN).body);
  assert.ok(seen.length > 100);
  for (const n of seen) assert.ok(Number.isInteger(n.line) && Number.isInteger(n.col), `${n.type} has no position`);
});

test("positions point at the node's first token", () => {
  const ast = parse("a = 1\nif b:\n    c = foo(2) + 3\n");
  const assign = ast.body[1].body[0];
  assert.deepEqual([assign.line, assign.col], [3, 5]);
  assert.deepEqual([assign.value.line, assign.value.col], [3, 9]);
  assert.deepEqual([assign.value.left.callee.line, assign.value.left.callee.col], [3, 9]);
  assert.deepEqual([assign.value.right.line, assign.value.right.col], [3, 18]);
});

// ---- errors: source → [code, line, col] ----------------------------------------------------

const BAD = [
  ["x = (1 + 2", "E111", 1, 5],
  ["x = 1 +", "E110", 1, 8],
  ["x = * 2", "E110", 1, 5],
  ["if a\n    x = 1", "E110", 1, 5],
  ["if a:\nx = 1", "E112", 1, 6],
  ["    x = 1", "E113", 1, 1],
  ["else:\n    x = 1", "E110", 1, 1],
  ["x = 1 2", "E110", 1, 7],
  ["x = a < b < c", "E119", 1, 11],
  ["f(a=1, 2)", "E118", 1, 8],
  ["f(a=1, a=2)", "E118", 1, 8],
  ["def f(a=1, b):\n    return a", "E118", 1, 12],
  ["def f(a, a):\n    return a", "E118", 1, 10],
  ["1 = x", "E114", 1, 1],
  ["na = 3", "E114", 1, 1],
  ["close[1] = 3", "E114", 1, 1],
  ["a.b = 3", "E114", 1, 1],
  ["a, 1 = f()", "E114", 1, 4],
  ["a, b", "E110", 1, 5],
  ["x = a = 1", "E110", 1, 7],
  ["import math", "E115", 1, 1],
  ["x = lambda: 1", "E115", 1, 5],
  ["try:\n    x = 1", "E115", 1, 1],
  ["#momo\nx = 1", "E116", 1, 1],
  ["#momo one\nx = 1", "E116", 1, 1],
  ["#momo 2\nx = 1", "E117", 1, 1],
  ["x = a if b", "E110", 1, 11],
  ["for 3 in x:\n    pass", "E110", 1, 5],
  ["for i x:\n    pass", "E110", 1, 7],
  ["x = f(1)(2)", "E110", 1, 9],
  ["x = 3(1)", "E110", 1, 6],
  ["var = 3", "E110", 1, 5],
  ["var x\n", "E110", 1, 6],
  ["x = a[]", "E110", 1, 7],
  ["x = ()", "E110", 1, 6],
  ["x = a.", "E110", 1, 7],
  ["x = f\"{a b}\"", "E107", 1, 10],
  ["x = " + "(".repeat(150) + "1" + ")".repeat(150), "E120", 1, 105],
  ["x = a ? b : c", "E102", 1, 7],
  ["if a:\n  x = 1", "E106", 2, 1],
];

for (const [source, code, line, col] of BAD) {
  test(`error ${code} at ${line}:${col}: ${JSON.stringify(source.length > 40 ? source.slice(0, 20) + "…" : source)}`, () => {
    let error;
    try { parse(source); } catch (e) { error = e; }
    assert.ok(error, "expected a syntax error");
    assert.deepEqual([error.code, error.line, error.col], [code, line, col], error.message);
    assert.ok(error.message.length > 5);
  });
}

test("errors carry a fix where one is obvious", () => {
  const fix = (source) => { try { parse(source); } catch (e) { return e.fix; } return undefined; };
  assert.match(fix("if a\n    x = 1"), /:/);
  assert.match(fix("a < b < c"), /and/);
  assert.match(fix("#momo\nx = 1"), /#momo 1/);
  assert.match(fix("if a:\nx = 1"), /pass/);
});
