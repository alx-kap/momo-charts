// The compiler's safety wall: whatever a script says, the code generated from it holds only the
// generator's own tokens (jscheck.mjs), nothing runs outside the sandbox's reach, and compile()
// never throws.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { compile, execute } from "../../../src/momo_scan/web/static/js/script/compile.js";
import * as runtime from "../../../src/momo_scan/web/static/js/script/runtime.js";
import { loadBars } from "./fixtures.mjs";
import { problems } from "./jscheck.mjs";

const HEAD = '#momo 1\nindicator("T", overlay=true)\n';
const { bars } = loadBars("ramp");

// ---- the checker of generated code works ------------------------------------------------------------

test("jscheck accepts real generated code", () => {
  const r = compile(`${HEAD}plot(ta.sma(close, 3), "SMA")\nmarker(close > open, "Up", text=f"{close:.1f}")`);
  assert.deepEqual(problems(r.code), []);
});

test("jscheck catches what hostile output would look like", () => {
  const cases = [
    'eval("1")', "constructor.constructor('return process')()", "x = `${1}`", "// comment", "a /* b */ c", "v_x.constructor",
    "globalThis", "process.exit()", 'rt.ta["constructor"]', '"</script>"', '"a\u2028b"', "fetch(1)", "x => x", "/re/", "а = 1",
    '"back`tick"', '"dollar$"', "v_x.__proto__", "import(1)", "1e", "0x10", "new Function(1)", "this", "arguments", "window",
  ];
  for (const code of cases) assert.ok(problems(code).length > 0, `not caught: ${code}`);
});

// ---- the corpus ------------------------------------------------------------------------------------------------

const IDENTIFIERS = [
  "constructor", "prototype", "eval", "Function", "process", "globalThis", "window", "self", "fetch", "require", "module",
  "arguments", "this", "new", "delete", "void", "typeof", "instanceof", "let", "const", "function", "return_", "throw", "super",
  "null", "undefined", "NaN", "Infinity", "rt", "bars", "inputs", "extra", "i", "N", "steps", "s0", "t0", "k0", "a0", "b0", "c0",
  "xs0", "in0", "P0", "C0", "SG0", "HH0", "L0", "iv0", "r0_0", "f0_x", "v_x", "H_v_x", "MK", "LV", "ST", "LG", "BC", "BG", "EMPTY",
  "ch", "cal", "Math", "Float64Array", "Object", "Array", "String", "Symbol", "Reflect", "Proxy", "JSON", "Date", "toString",
  "valueOf", "hasOwnProperty", "length", "step", "v", "o0", "enum", "yield_", "await_", "with_", "static", "x", "X", "_", "_x", "x_",
  "a1b2c3", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_", "é".normalize("NFD").replace(/[^\x00-\x7f]/g, "e"),
];

const ROLES = [
  (x) => `${x} = close\nplot(${x})`,
  (x) => `var ${x} = 0\n${x} += 1\nplot(${x})`,
  (x) => `def ${x}(a):\n    return a + 1\nplot(${x}(close))`,
  (x) => `def f(${x}):\n    return ${x} * 2\nplot(f(close))`,
  (x) => `def f(a, ${x}=2):\n    return a * ${x}\nplot(f(close, ${x}=3))`,
  (x) => `for ${x} in range(3):\n    pass\nplot(close)`,
  (x) => `a, ${x}, b = ta.bb(close, 3, 2.0)\nplot(${x})`,
  (x) => `${x} = input.int(5)\nplot(ta.sma(close, ${x}))`,
  (x) => `${x} = plot(close, "a")\nfill(${x}, ${x})`,
  (x) => `${x} = []\n${x}.push(close)\nplot(len(${x}))`,
  (x) => `${x} = close\nplot(${x}[1] + ${x}[2])`,
  (x) => `${x} = close\nplot((${x} + 1)[1])`,
  (x) => `signal("${x}", close > open)`,
  (x) => `value("${x}", close)`,
  (x) => `${x} = input.choice("${x}", "${x}", options=["${x}", "y"])\nplot(1 if ${x} == "${x}" else 0)`,
  (x) => `plot(close, "${x}")\nplot(open, "${x}")`,
  (x) => `${x} = 1 if close > open else 2\nbarcolor(color.red if ${x} == 1 else na)`,
  (x) => `${x}, ${x}2 = ta.macd(close, 3, 6, 2)[0], 1`,
];

const STRINGS = [
  "plain", "", "</script><script>alert(1)</script>", "`${process.exit()}`", "${1+1}", '" + eval("1") + "', "'; process.exit(); '",
  "\\u0022", "\\", '\\"', "*/ alert(1) /*", "// comment", "\u2028", "\u2029", "абв", "ｅｖａｌ", "\u{1F600}",
  "\ud800", "<img src=x onerror=alert(1)>", "constructor", "__proto__", "x".repeat(200), "x".repeat(201), "\x7f", "\n", "\t", "a\u0000b",
  "}); process.exit(); (function(){", "‮", "%s%d", "{{}}", "{", "}", "\\n", "\\x41", "&amp;", "'", "'''", '"""', "$", "$$", "#momo 1",
];

// A momo string literal for any text (control characters can't be written; those cases are skipped).
function literal(text) {
  if (/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/.test(text) && !/^[^\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]*$/.test(text)) {
    return JSON.stringify(text);                       // the lexer must refuse it
  }
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}
const fstringText = (text) => literal(text).slice(1, -1).replace(/[{}]/g, (m) => m + m);

const STRING_ROLES = [
  (s) => `plot(close, ${literal(s)})`,
  (s) => `marker(close > open, ${literal(s)}, text=${literal(s)})`,
  (s) => `stat(${literal(s)}, ${literal(s)})`,
  (s) => `x = ${literal(s)}\nstat("a", x)`,
  (s) => `stat("a", f"${fstringText(s)}{close:.1f}${fstringText(s)}")`,
  (s) => `n = input.int(5, ${literal(s)}, group=${literal(s)}, tooltip=${literal(s)})\nplot(close)`,
  (s) => `m = input.choice(${literal(s)}, ${literal(s)}, options=[${literal(s)}, "other"])\nplot(close)`,
  (s) => `signal(${literal(s)}, close > open)`,
  (s) => `if close > open:\n    log(${literal(s)})`,
  (s) => `#momo 1\nindicator(${literal(s)}, short=${literal(s)})\nplot(close)`,
  (s) => `level(close, ${literal(s)})`,
  (s) => `plot(close, color=${literal(s)})`,
  (s) => `hline(1, ${literal(s)})`,
  (s) => `x = ${literal(s)} == "a"\nplot(1 if x else 0)`,
];

function wall(source, label) {
  let result;
  assert.doesNotThrow(() => { result = compile(source); }, label);
  if (!result.ok) {
    assert.ok(result.errors.length >= 1, label);
    for (const e of result.errors) assert.ok(typeof e.message === "string" && e.code, label);
    assert.ok(!result.errors.some((e) => /internal/i.test(e.message)), label);
    return false;
  }
  const bad = problems(result.code);
  assert.deepEqual(bad, [], `${label}\n${result.code}`);
  JSON.parse(JSON.stringify(result.meta));
  // And running it changes nothing outside itself.
  const before = Object.keys(globalThis).length;
  const out = execute(result.code, bars);
  assert.ok(out.ok || ["R402", "R403", "R404"].includes(out.error.code), `${label}: ${JSON.stringify(out.error)}`);
  assert.equal(Object.keys(globalThis).length, before, label);
  assert.equal(Object.keys(Object.prototype).length, 0, label);
  assert.equal(({}).polluted, undefined, label);
  return true;
}

test("hostile identifiers in every role", () => {
  let compiled = 0;
  let total = 0;
  for (const name of IDENTIFIERS) {
    for (const role of ROLES) {
      total++;
      if (wall(HEAD + role(name), `${name}: ${role(name)}`)) compiled++;
    }
  }
  assert.ok(compiled > total * 0.5, `only ${compiled} of ${total} compiled`);
});

test("hostile text in every place a script can put text", () => {
  let compiled = 0;
  let total = 0;
  for (const text of STRINGS) {
    for (const role of STRING_ROLES) {
      total++;
      const source = role(text);
      if (wall(source.startsWith("#momo") ? source : HEAD + source, `${JSON.stringify(text)}: ${source}`)) compiled++;
    }
  }
  assert.ok(compiled > total * 0.35, `only ${compiled} of ${total} compiled`);
});

test("names that start with two underscores are refused, so __proto__ never reaches an object key", () => {
  for (const name of ["__proto__", "__defineGetter__", "__x", "__"]) {
    for (const role of ROLES.slice(0, 11)) {
      const r = compile(HEAD + role(name));
      assert.equal(r.ok, false, `${name}: ${role(name)}`);
    }
  }
});

test("hostile text survives as data: titles reach meta exactly, and never reach the code as code", () => {
  const nasty = "</script><img src=x onerror=alert(1)> ${x} `y` а \u{1F600}";
  const r = compile(`${HEAD}plot(close, ${literal(nasty)}, color="#ff0000")\nsignal("ok", close > open)`);
  assert.ok(r.ok);
  assert.equal(r.meta.plots[0].title, nasty);
  assert.deepEqual(problems(r.code), []);
  // The only text that reaches the code is the plot's key, a slug of [a-z0-9_], and the signal name.
  const strings = r.code.match(/"(?:[^"\\]|\\.)*"/g).filter((t) => t !== '"use strict"');
  assert.ok(strings.every((t) => /^"[A-Za-z0-9_]*"$/.test(t)), strings.join(" "));
  assert.ok(!/[`$]/.test(r.code));
  assert.ok(/^[\x20-\x7e\n]*$/.test(r.code));
});

test("the page's input values are data too: a hostile value never changes the code", () => {
  const r = compile(`${HEAD}n = input.int(3)\nm = input.choice("a", "M", options=["a", "b"])\nc = input.color("#ff0000")\nplot(ta.sma(close, n) + (1 if m == "a" else 2), color=c)`);
  assert.ok(r.ok);
  const hostile = { n: "3; process.exit()", m: "a\"; process.exit(); \"", c: { toString() { throw new Error("no"); } }, constructor: 1, __proto__: { n: 1 } };
  const out = execute(r.code, bars, hostile);
  assert.ok(out.ok);
  assert.equal(r.code.includes("process"), false);
});

// ---- fuzzing: mutations of real scripts never crash and never produce odd code -----------------------------------

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASES = new URL("./cases/", import.meta.url);
const SOURCES = readdirSync(CASES).filter((f) => f.endsWith(".momo")).sort().map((f) => readFileSync(new URL(f, CASES), "utf8"));
const SNIPPETS = ["(", ")", "[", "]", ",", ":", "=", "==", "!=", "**", "-", "not ", " and ", " or ", "if ", "else", "def ", "return ", "\n", "    ", "\t", "#", "//", '"', "'", "f\"{", "}", "na", "true", "ta.", "close", "[1]", "[-1]", "0", "1e999", "1e-999", "а", "`", "$", "\\", "__x", "constructor", "plot(", "input.int(", "var ", "for i in range(", "while true:", "break", "continue", "xs.push(", "2 ** 2 ** 2", ".5", "1_0", "e"];

function mutate(source, random) {
  const pick = (n) => Math.floor(random() * n);
  let text = source;
  for (let k = 0, count = 1 + pick(3); k < count; k++) {
    const at = pick(text.length + 1);
    switch (pick(6)) {
      case 0: text = text.slice(0, at) + SNIPPETS[pick(SNIPPETS.length)] + text.slice(at); break;
      case 1: text = text.slice(0, at) + text.slice(at + 1 + pick(8)); break;
      case 2: { const lines = text.split("\n"); lines.splice(pick(lines.length), 1); text = lines.join("\n"); break; }
      case 3: { const lines = text.split("\n"); const l = lines[pick(lines.length)]; lines.splice(pick(lines.length), 0, l); text = lines.join("\n"); break; }
      case 4: text = text.slice(0, at) + String.fromCharCode(32 + pick(95)) + text.slice(at + 1); break;
      default: { const words = text.split(/(\s+)/); const a = pick(words.length); const b = pick(words.length); [words[a], words[b]] = [words[b], words[a]]; text = words.join(""); }
    }
  }
  return text;
}

test("fuzz: mutated scripts never throw, never make odd code, and never fail except by RunError", () => {
  const random = mulberry(20261103);
  let compiled = 0;
  const rounds = 1500;
  for (let n = 0; n < rounds; n++) {
    const source = mutate(SOURCES[Math.floor(random() * SOURCES.length)], random);
    if (wall(source, `fuzz ${n}:\n${source}`)) compiled++;
  }
  assert.ok(compiled > rounds * 0.05, `only ${compiled} of ${rounds} mutations compiled`);
});

test("fuzz: random token soup is rejected without a crash", () => {
  const random = mulberry(7);
  for (let n = 0; n < 800; n++) {
    const parts = Array.from({ length: 1 + Math.floor(random() * 40) }, () => SNIPPETS[Math.floor(random() * SNIPPETS.length)]);
    const source = HEAD + parts.join(random() < 0.5 ? " " : "");
    assert.doesNotThrow(() => compile(source), source);
    const r = compile(source);
    if (r.ok) assert.deepEqual(problems(r.code), [], source);
  }
});

test("the runtime exposes nothing a script could reach but its own helpers", () => {
  // Generated code only ever names runtime exports; none of them is a way out.
  for (const [name, value] of Object.entries(runtime)) {
    assert.ok(!/eval|Function|fetch|import|require|process/i.test(name), name);
    assert.ok(typeof value !== "function" || value.length >= 0);
  }
  const source = readFileSync(new URL("../../../src/momo_scan/web/static/js/script/runtime.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const word of ["eval(", "new Function", "fetch(", "XMLHttpRequest", "WebSocket", "importScripts", "document.", "window.", "localStorage", "globalThis", "process."]) {
    assert.ok(!source.includes(word), `runtime.js mentions ${word}`);
  }
});
