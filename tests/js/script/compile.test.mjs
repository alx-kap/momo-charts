import assert from "node:assert/strict";
import { test } from "node:test";

import { INDICATORS } from "../../../src/momo_scan/web/static/js/indicators.js";
import { compile, execute, instantiate } from "../../../src/momo_scan/web/static/js/script/compile.js";
import * as runtime from "../../../src/momo_scan/web/static/js/script/runtime.js";
import { SETS, loadBars, sameSeries } from "./fixtures.mjs";

const HEAD = '#momo 1\nindicator("T", overlay=true)\n';
const build = (body) => {
  const r = compile(HEAD + body);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.errors));
  return r;
};
const run = (body, name = "trend", inputs = {}, extra = {}) => {
  const out = execute(build(body).code, loadBars(name).bars, inputs, extra);
  assert.ok(out.ok, JSON.stringify(out.error));
  return out;
};

test("compile returns meta and code, or errors with positions and fixes", () => {
  const ok = compile(`${HEAD}plot(close)`);
  assert.equal(ok.ok, true);
  assert.equal(typeof ok.code, "string");
  assert.equal(ok.meta.version, 1);
  assert.equal(ok.errors, undefined);
  const bad = compile(`${HEAD}x = clsoe`);
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors[0]).sort(), ["code", "col", "endCol", "fix", "line", "message"]);
  assert.equal(bad.code, undefined);
});

test("E401: too long a script; and anything but text", () => {
  const long = compile(`${HEAD}${"# padding\n".repeat(10000)}`);
  assert.equal(long.errors[0].code, "E401");
  assert.equal(compile(HEAD + "x = 1\n".repeat(5000)).ok, true);
  assert.equal(compile(null).errors[0].code, "E110");
  assert.equal(compile(undefined).ok, false);
});

test("deep nesting is an error, never a crash", () => {
  const cases = [
    `${HEAD}x = ${"(".repeat(5000)}1${")".repeat(5000)}`,
    `${HEAD}x = ${"not ".repeat(5000)}true`,
    `${HEAD}x = ${"-".repeat(5000)}1`,
    `${HEAD}x = ${"[".repeat(3000)}${"]".repeat(3000)}`,
    `${HEAD}x = ${"f(".repeat(2000)}1${")".repeat(2000)}`,
    `${HEAD}x = 1${"**1".repeat(3000)}`,
    HEAD + Array.from({ length: 60 }, (_, i) => `${"    ".repeat(i)}if true:`).join("\n") + `\n${"    ".repeat(60)}pass`,
    `${HEAD}x = ${"1 if true else ".repeat(3000)}1`,
  ];
  for (const source of cases) {
    const r = compile(source);
    assert.equal(r.ok, false);
    assert.ok(/^E1/.test(r.errors[0].code), r.errors[0].code);
  }
});

test("compile never throws on odd input", () => {
  const odd = ["", "\n\n", "#", "#momo", "\u0000", "x = ", "def", "if", "else:", "    ", "\t", "'", '"', "f'{", "1e", "((", "]]", "a.b.c.d", "x[", "@", "plot(", "plot(close,", "= 1"];
  for (const source of odd) {
    for (const full of [source, HEAD + source]) {
      assert.doesNotThrow(() => compile(full), JSON.stringify(full));
      const r = compile(full);
      if (!r.ok) assert.ok(r.errors.length >= 1);
    }
  }
});

test("execute: the worker's reply shape", () => {
  const out = run("plot(close, 'C')\nsignal('s', close > open)");
  assert.equal(out.ok, true);
  assert.equal(typeof out.ms, "number");
  assert.ok(out.plots.c.values instanceof Float64Array);
  assert.ok(out.signals.s instanceof Uint8Array);
  assert.deepEqual(out.markers, []);
  assert.deepEqual(out.levels, []);
  assert.deepEqual(out.stats, []);
  assert.deepEqual(out.logs, []);
  assert.deepEqual(out.drawings, { lines: [], boxes: [], labels: [] });
  const failed = execute(build("while true:\n    pass").code, loadBars("trend").bars);
  assert.equal(failed.ok, false);
  assert.deepEqual(Object.keys(failed.error).sort(), ["code", "col", "i", "line", "message"]);
});

test("a run on no bars gives empty results", () => {
  const empty = Object.fromEntries(["time", "open", "high", "low", "close", "volume"].map((k) => [k, new Float64Array(0)]));
  const out = execute(build("plot(ta.sma(close, 3))\nlevel(close)\nstat('x', close)\nsignal('s', close > open)").code, empty);
  assert.ok(out.ok);
  assert.equal(out.plots.plot_1.values.length, 0);
  assert.equal(out.levels.length, 0);
});

test("instantiate takes any runtime with the same shape", () => {
  const fn = instantiate(build("plot(close)").code, runtime);
  const out = fn(loadBars("trend").bars);
  assert.equal(out.plots.plot_1.values.length, 300);
});

// ---- end to end: scripts reproduce the chart's built-in indicators --------------------------------

for (const set of SETS) {
  const { bars, rows } = loadBars(set);

  test(`${set}: scripts reproduce SMA, EMA, Bollinger, Keltner, RSI, MACD, ATR, ADR and VWAP`, () => {
    const out = run(`
length = input.int(20, "Length", min=2, max=500)
mult = input.float(2.0, "StdDev")
plot(ta.sma(close, length), "sma")
plot(ta.ema(close, 21), "ema")
b, u, l = ta.bb(close, length, mult)
plot(b, "bb_basis")
plot(u, "bb_upper")
plot(l, "bb_lower")
kb, ku, kl = ta.kc(close, length, mult, 10)
plot(kb, "kc_basis")
plot(ku, "kc_upper")
plot(kl, "kc_lower")
plot(ta.rsi(close, 14), "rsi")
m, s, h = ta.macd(close, 12, 26, 9)
plot(m, "macd")
plot(s, "signal_line")
plot(h, "hist")
plot(ta.atr(14), "atr")
plot(ta.adr(20), "adr")
plot(ta.vwap(), "vwap")
`, set);
    const expected = {
      sma: INDICATORS.sma.compute(rows, { period: 20 }).line,
      ema: INDICATORS.ema.compute(rows, { period: 21 }).line,
      ...Object.fromEntries(Object.entries(INDICATORS.bb.compute(rows, { period: 20, mult: 2 })).map(([k, v]) => [`bb_${k}`, v])),
      ...Object.fromEntries(Object.entries(INDICATORS.kc.compute(rows, { period: 20, mult: 2, atr: 10 })).map(([k, v]) => [`kc_${k}`, v])),
      rsi: INDICATORS.rsi.compute(rows, { period: 14 }).line,
      macd: INDICATORS.macd.compute(rows, { fast: 12, slow: 26, signal: 9 }).macd,
      signal_line: INDICATORS.macd.compute(rows, { fast: 12, slow: 26, signal: 9 }).signal,
      hist: INDICATORS.macd.compute(rows, { fast: 12, slow: 26, signal: 9 }).hist,
      atr: INDICATORS.atr.compute(rows, { period: 14 }).line,
      adr: INDICATORS.adr.compute(rows, { period: 20 }).line,
      vwap: INDICATORS.vwap.compute(rows, {}).line,
    };
    for (const [key, values] of Object.entries(expected)) sameSeries(out.plots[key].values, values, key);
    assert.equal(Object.keys(out.plots).length, Object.keys(expected).length);
    void bars;
  });
}

// ---- no lookahead: a script run on the first k bars gives the same values as the full run ------------

const EVERYTHING = `
n = input.int(10, "n", min=2, max=50)
basis = ta.sma(close, n)
bb_b, bb_u, bb_l = ta.bb(close, n, 2.0)
rsi = ta.rsi(close, 14)
m, s, h = ta.macd(close, 12, 26, 9)
ph = ta.pivothigh(high, 3, 3)
pl = ta.pivotlow(low, 3, 3)
up = ta.crossover(close, basis)
since = ta.barssince(up)
vw = ta.valuewhen(up, close, 1)
prior = ta.highest(high, n)[1]
k, d = ta.stoch(14, 3, 3)
var top = na
if na(top) or high > top:
    top = high
rv = ta.rvol(20)
streak = nz(streak[1]) + 1 if close > open else 0
spread = (high - low)[2] / close
total = ta.cum(volume) + ta.vwap() + ta.hma(close, 9) + ta.median(close, 7) + ta.percentrank(close, 20)
words = [close, open]
words.push(streak)
plot(basis, "basis")
plot(bb_u - bb_l, "width")
plot(rsi, "rsi")
plot(h, "hist")
plot(ph, "ph")
plot(pl, "pl")
plot(since, "since")
plot(vw, "vw")
plot(prior, "prior")
plot(k - d, "stoch")
plot(top, "top")
plot(rv, "rv")
plot(streak, "streak")
plot(spread, "spread")
plot(total, "total")
plot(words.sum(), "words")
signal("up", up)
marker(not na(ph), "pivot")
`;

test("no lookahead: values on the first k bars never change when later bars arrive", () => {
  const compiled = build(EVERYTHING);
  for (const set of SETS) {
    const { bars, n } = loadBars(set);
    const full = execute(compiled.code, bars);
    assert.ok(full.ok);
    for (const k of [30, 97, n - 1]) {
      const part = Object.fromEntries(Object.entries(bars).map(([key, col]) => [key, col.subarray(0, k)]));
      const cut = execute(compiled.code, part);
      assert.ok(cut.ok);
      for (const [key, plot] of Object.entries(full.plots)) sameSeries(cut.plots[key].values, plot.values.subarray(0, k), `${set} ${key} @${k}`);
      for (const [key, s] of Object.entries(full.signals)) assert.deepEqual(Array.from(cut.signals[key]), Array.from(s.subarray(0, k)), `${set} ${key}`);
      assert.deepEqual(cut.markers, full.markers.filter((m) => m.i < k));
    }
  }
});

test("replay is honest: last_bar, levels and stats follow the bars shown", () => {
  const compiled = build("signal('last', last_bar)\nlevel(close, 'Last')\nstat('Close', close)");
  const { bars } = loadBars("trend");
  for (const k of [10, 100, 300]) {
    const part = Object.fromEntries(Object.entries(bars).map(([key, col]) => [key, col.subarray(0, k)]));
    const out = execute(compiled.code, part);
    assert.equal(out.signals.last[k - 1], 1);
    assert.equal(out.signals.last.reduce((a, b) => a + b, 0), 1);
    assert.equal(out.levels[0].price, bars.close[k - 1]);
    assert.equal(out.stats[0].value, bars.close[k - 1]);
  }
});
