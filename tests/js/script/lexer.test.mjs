import assert from "node:assert/strict";
import { test } from "node:test";

import { tokenize } from "../../../src/momo_scan/web/static/js/script/lexer.js";

// "NAME:x", "NUM:2", "OP:+", with NEWLINE / INDENT / DEDENT / EOF bare.
const kinds = (source, options) => tokenize(source, options).map((t) => (
  ["NEWLINE", "INDENT", "DEDENT", "EOF"].includes(t.type) ? t.type : `${t.type}:${t.value}`
));
const failure = (source) => {
  try { tokenize(source); } catch (e) { return e; }
  assert.fail(`expected an error for ${JSON.stringify(source)}`);
};

test("names, keywords and operators", () => {
  assert.deepEqual(kinds("a = b + 1"), ["NAME:a", "OP:=", "NAME:b", "OP:+", "NUM:1", "NEWLINE", "EOF"]);
  assert.deepEqual(kinds("x if not y else z").slice(0, 5), ["NAME:x", "KEYWORD:if", "KEYWORD:not", "NAME:y", "KEYWORD:else"]);
  assert.deepEqual(kinds("a ** b <= c != d == e >= f"), [
    "NAME:a", "OP:**", "NAME:b", "OP:<=", "NAME:c", "OP:!=", "NAME:d", "OP:==", "NAME:e", "OP:>=", "NAME:f", "NEWLINE", "EOF",
  ]);
  assert.deepEqual(kinds("x := 1; ".slice(0, 6)), ["NAME:x", "OP::=", "NUM:1", "NEWLINE", "EOF"]);
  assert.deepEqual(kinds("n += 1\nn -= 1\nn *= 2\nn /= 2").filter((t) => t.startsWith("OP")), ["OP:+=", "OP:-=", "OP:*=", "OP:/="]);
  assert.deepEqual(kinds("ta.sma(close, 20)[1]"), [
    "NAME:ta", "OP:.", "NAME:sma", "OP:(", "NAME:close", "OP:,", "NUM:20", "OP:)", "OP:[", "NUM:1", "OP:]", "NEWLINE", "EOF",
  ]);
});

test("unsupported Python words lex as keywords so the parser can name them", () => {
  assert.equal(tokenize("import x")[0].type, "KEYWORD");
  assert.equal(tokenize("lambda")[0].value, "lambda");
});

test("numbers: ints, floats, underscores, exponents, leading dot", () => {
  const nums = (s) => tokenize(s).filter((t) => t.type === "NUM").map((t) => t.value);
  assert.deepEqual(nums("14 2.5 1e6 1_000_000 1.5e-3 2E+2 3.\nx = .5\ny = (.25)"), [14, 2.5, 1e6, 1000000, 0.0015, 200, 3, 0.5, 0.25]);
});

test("number errors: E105", () => {
  for (const bad of ["1__0", "1_", "1e", "1e+", "12abc", "1_.5", "0x10"]) {
    assert.equal(failure(bad).code, "E105", bad);
  }
  const e = failure("x = 12abc");
  assert.deepEqual([e.line, e.col], [1, 5]);
});

test("strings: both quotes, escapes, position", () => {
  const [s, t] = tokenize(`"a\\tb" 'it\\'s \\\\ \\n \\"'`);
  assert.equal(s.value, "a\tb");
  assert.equal(t.value, "it's \\ \n \"");
  assert.deepEqual([s.col, s.endCol], [1, 7]);
});

test("string errors: E103 unterminated, E104 bad escape and control characters", () => {
  assert.equal(failure('x = "abc').code, "E103");
  assert.equal(failure('x = "abc\ny"').code, "E103");
  assert.equal(failure('x = "a\\qb"').code, "E104");
  assert.equal(failure('x = "a\u0001b"').code, "E104");
  assert.equal(failure('x = "a\u2028b"').code, "E104");
  assert.equal(failure('x = """').code, "E103");
  const e = failure('x = "a\\qb"');
  assert.deepEqual([e.line, e.col, e.endCol], [1, 7, 9]);
  assert.match(e.fix, /\\n/);
});

test("f-strings: parts, escapes, braces, specs, positions", () => {
  const [f] = tokenize('f"ADR {adr:.2f}% {{x}} {a + b}"');
  assert.equal(f.type, "FSTR");
  assert.deepEqual(f.parts.map((p) => (typeof p === "string" ? p : [p.code, p.spec, p.col])), [
    "ADR ", ["adr", ".2f", 8], "% {x} ", ["a + b", "", 25],
  ]);
  assert.deepEqual(tokenize("f'{n:,}'")[0].parts[0].spec, ",");
  assert.deepEqual(tokenize("f\"{f(a[1], 'x'):%}\"")[0].parts[0].spec, "%");
  assert.deepEqual(tokenize('f"plain"')[0].parts, ["plain"]);
});

test("f-string errors: E107", () => {
  for (const bad of ['f"{x"', 'f"{}"', 'f"}"', 'f"{x:abc}"', "f\"{'a}\""]) {
    assert.equal(failure(bad).code, "E107", bad);
  }
  assert.deepEqual([failure('f"ab{x"').col], [5]);
});

test("comments: # and // are skipped, kept on request", () => {
  assert.deepEqual(kinds("a = 1  # note\n// whole line\nb = 2"), [
    "NAME:a", "OP:=", "NUM:1", "NEWLINE", "NAME:b", "OP:=", "NUM:2", "NEWLINE", "EOF",
  ]);
  assert.deepEqual(kinds("a = 1 // two\n", { comments: true }).filter((t) => t.startsWith("COMMENT")), ["COMMENT:// two"]);
});

test("the #momo header", () => {
  const [h, n] = tokenize("#momo 1\nindicator('x')");
  assert.deepEqual([h.type, h.value, h.line, h.col], ["HEADER", "1", 1, 1]);
  assert.equal(n.type, "NAME");
  assert.equal(tokenize("# momo is great\nx=1")[0].type, "NAME");
  assert.equal(tokenize("x = 1\n#momo 1")[0].type, "NAME");
  assert.equal(tokenize("\n\n#momo 2")[0].value, "2");
});

test("indent and dedent", () => {
  const source = "if a:\n    b = 1\n    if c:\n        d = 2\ne = 3\n";
  assert.deepEqual(kinds(source), [
    "KEYWORD:if", "NAME:a", "OP::", "NEWLINE",
    "INDENT", "NAME:b", "OP:=", "NUM:1", "NEWLINE",
    "NAME:if".replace("NAME", "KEYWORD"), "NAME:c", "OP::", "NEWLINE",
    "INDENT", "NAME:d", "OP:=", "NUM:2", "NEWLINE",
    "DEDENT", "DEDENT", "NAME:e", "OP:=", "NUM:3", "NEWLINE", "EOF",
  ]);
});

test("blank lines and comment lines don't change the indent; EOF closes blocks", () => {
  const source = "if a:\n    b = 1\n\n  # odd comment\n    c = 2";
  const out = kinds(source);
  assert.equal(out.filter((t) => t === "INDENT").length, 1);
  assert.deepEqual(out.slice(-3), ["NEWLINE", "DEDENT", "EOF"]);
});

test("brackets join lines and ignore indentation", () => {
  const source = "x = foo(1,\n  2,\n        3) + 4\ny = 5";
  const out = kinds(source);
  assert.ok(!out.includes("INDENT"));
  assert.equal(out.filter((t) => t === "NEWLINE").length, 2);
  assert.deepEqual(tokenize("x = [\n1,\n2\n]\ny = 1").filter((t) => t.type === "NEWLINE").length, 2);
});

test("an indent error is E106; tabs are E101", () => {
  assert.equal(failure("if a:\n  b = 1").code, "E106");
  assert.equal(failure("if a:\n        b = 1").code, "E106");
  assert.equal(failure("if a:\n    if b:\n        c = 1\n      d = 1").code, "E106");
  const tab = failure("if a:\n\tb = 1");
  assert.deepEqual([tab.code, tab.line, tab.col], ["E101", 2, 1]);
  assert.match(tab.fix, /4 spaces/);
  assert.equal(failure("a =\t1").code, "E101");
  assert.deepEqual([failure("if a:\n    b = 1\n  c = 2").code], ["E106"]);
});

test("unexpected characters are E102 with a fix for common slips", () => {
  const q = failure("x = a ? b : c");
  assert.deepEqual([q.code, q.line, q.col], ["E102", 1, 7]);
  assert.match(q.fix, /a if cond else b/);
  assert.match(failure("x = !y").fix, /not/);
  assert.match(failure("x = a && b").fix, /and/);
  assert.match(failure("f(x) => x").message, /function arrow/);
  assert.equal(failure("x = {1}").code, "E102");
  assert.match(failure("x = а").message, /U\+0430/);
  assert.equal(failure("x = 1; y = 2").code, "E102");
});

test("brackets: E111 for unmatched and unclosed", () => {
  const open = failure("x = foo(1,\n2");
  assert.deepEqual([open.code, open.line, open.col], ["E111", 1, 8]);
  assert.equal(failure("x = 1)").code, "E111");
  assert.equal(failure("x = (1]").code, "E111");
});

test("positions are 1-based and endCol is exclusive", () => {
  const [a, b] = tokenize("  \nfoo = 12");
  assert.deepEqual([a.line, a.col, a.endCol], [2, 1, 4]);
  assert.deepEqual([b.line, b.col, b.endCol], [2, 5, 6]);
});

test("line endings: CRLF, CR and a BOM are normalised", () => {
  assert.deepEqual(kinds("\uFEFFa = 1\r\nb = 2\rc = 3"), kinds("a = 1\nb = 2\nc = 3"));
});

test("inline mode lexes an f-string expression at its own offset", () => {
  const tokens = tokenize("a + b", { inline: true, origin: { line: 3, col: 10 } });
  assert.deepEqual(tokens.map((t) => [t.type, t.line, t.col]), [
    ["NAME", 3, 10], ["OP", 3, 12], ["NAME", 3, 14], ["EOF", 3, 15],
  ]);
});

test("empty and comment-only sources give just EOF", () => {
  assert.deepEqual(kinds(""), ["EOF"]);
  assert.deepEqual(kinds("# only\n\n"), ["EOF"]);
});
