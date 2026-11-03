import assert from "node:assert/strict";
import { test } from "node:test";

import { INDICATORS, ema as ema0, sma as sma0 } from "../../../src/momo_scan/web/static/js/indicators.js";
import * as rt from "../../../src/momo_scan/web/static/js/script/runtime.js";
import { SETS, loadBars, sameSeries } from "./fixtures.mjs";

const AT = [1, 1];
const { ta } = rt;

// Runs a stepper over columns: `args(i)` gives this bar's step arguments.
function run(stepper, n, args) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    stepper.step(...args(i));
    out[i] = stepper.v;
  }
  return out;
}
const column = (stepper, n, get) => run(stepper, n, (i) => [get(i)]);
const outputs = (stepper, n, args, count) => {
  const outs = Array.from({ length: count }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    stepper.step(...args(i));
    outs.forEach((o, k) => { o[i] = stepper[`o${k}`]; });
  }
  return outs;
};
const na = (v) => (v === null ? NaN : v);

// ---- parity with indicators.js: each stepper against the chart's own maths -------------------------------

for (const name of SETS) {
  const { bars, rows, n } = loadBars(name);
  const close = (i) => bars.close[i];
  const hlc = (i) => [bars.high[i], bars.low[i], bars.close[i]];

  test(`${name}: sma matches indicators.js`, () => {
    for (const len of [1, 5, 20, 50]) {
      sameSeries(column(ta.sma(AT, len), n, close), sma0(Array.from(bars.close), len), `sma ${len}`);
    }
  });

  test(`${name}: ema matches indicators.js`, () => {
    for (const len of [1, 9, 21, 100]) {
      sameSeries(column(ta.ema(AT, len), n, close), ema0(Array.from(bars.close), len), `ema ${len}`);
    }
  });

  test(`${name}: bollinger bands match (sma and population stdev)`, () => {
    const expected = INDICATORS.bb.compute(rows, { period: 20, mult: 2 });
    const [basis, upper, lower] = outputs(ta.bb(AT, 20), n, (i) => [bars.close[i], 2], 3);
    sameSeries(basis, expected.basis, "basis");
    sameSeries(upper, expected.upper, "upper");
    sameSeries(lower, expected.lower, "lower");
  });

  test(`${name}: keltner channels match (ema and rma of true range)`, () => {
    const expected = INDICATORS.kc.compute(rows, { period: 20, mult: 2, atr: 10 });
    const [basis, upper, lower] = outputs(ta.kc(AT, 20, 10), n, (i) => [bars.close[i], 2, ...hlc(i)], 3);
    sameSeries(basis, expected.basis, "basis");
    sameSeries(upper, expected.upper, "upper");
    sameSeries(lower, expected.lower, "lower");
  });

  test(`${name}: rsi matches`, () => {
    for (const len of [2, 14, 30]) {
      sameSeries(column(ta.rsi(AT, len), n, close), INDICATORS.rsi.compute(rows, { period: len }).line, `rsi ${len}`);
    }
  });

  test(`${name}: macd, signal and histogram match`, () => {
    const expected = INDICATORS.macd.compute(rows, { fast: 12, slow: 26, signal: 9 });
    const [line, signal, hist] = outputs(ta.macd(AT, 12, 26, 9), n, (i) => [bars.close[i]], 3);
    sameSeries(line, expected.macd, "macd");
    sameSeries(signal, expected.signal, "signal");
    sameSeries(hist, expected.hist, "hist");
  });

  test(`${name}: atr and adr match`, () => {
    sameSeries(run(ta.atr(AT, 14), n, hlc), INDICATORS.atr.compute(rows, { period: 14 }).line, "atr");
    sameSeries(run(ta.adr(AT, 20), n, (i) => [bars.high[i], bars.low[i]]), INDICATORS.adr.compute(rows, { period: 20 }).line, "adr");
  });

  test(`${name}: vwap matches (restarts each day)`, () => {
    const got = run(ta.vwap(), n, (i) => [bars.time[i], bars.high[i], bars.low[i], bars.close[i], bars.volume[i]]);
    sameSeries(got, INDICATORS.vwap.compute(rows, {}).line, "vwap");
  });
}

test("rma matches indicators.js (through atr of a constant range)", () => {
  const { rows, n } = loadBars("trend");
  const expected = INDICATORS.atr.compute(rows, { period: 7 }).line;
  const got = run(ta.atr(AT, 7), n, (i) => [rows[i].high, rows[i].low, rows[i].close]);
  sameSeries(got, expected, "rma");
});

// ---- slow references: each stepper against its definition, written the plain way ---------------------

const window = (xs, i, n) => (i >= n - 1 ? xs.slice(i - n + 1, i + 1) : null);
const slow = {
  sma: (xs, n) => xs.map((_, i) => { const w = window(xs, i, n); return w && !w.some(Number.isNaN) ? w.reduce((a, b) => a + b, 0) / n : NaN; }),
  sum: (xs, n) => xs.map((_, i) => { const w = window(xs, i, n); return w && !w.some(Number.isNaN) ? w.reduce((a, b) => a + b, 0) : NaN; }),
  wma: (xs, n) => xs.map((_, i) => {
    const w = window(xs, i, n);
    return w && !w.some(Number.isNaN) ? w.reduce((a, v, k) => a + (k + 1) * v, 0) / ((n * (n + 1)) / 2) : NaN;
  }),
  variance: (xs, n) => xs.map((_, i) => {
    const w = window(xs, i, n);
    if (!w || w.some(Number.isNaN)) return NaN;
    const mean = w.reduce((a, b) => a + b, 0) / n;
    return w.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  }),
  highest: (xs, n) => xs.map((_, i) => { const w = window(xs, i, n); return w && !w.some(Number.isNaN) ? Math.max(...w) : NaN; }),
  lowest: (xs, n) => xs.map((_, i) => { const w = window(xs, i, n); return w && !w.some(Number.isNaN) ? Math.min(...w) : NaN; }),
  highestbars: (xs, n, sign = 1) => xs.map((_, i) => {
    const w = window(xs, i, n);
    if (!w || w.some(Number.isNaN)) return NaN;
    let best = w.length - 1;
    for (let k = w.length - 1; k >= 0; k--) if (sign * w[k] > sign * w[best]) best = k;
    return best - (w.length - 1);
  }),
  change: (xs, n) => xs.map((v, i) => (i >= n ? v - xs[i - n] : NaN)),
  roc: (xs, n) => xs.map((v, i) => (i >= n && xs[i - n] !== 0 ? ((v - xs[i - n]) / xs[i - n]) * 100 : NaN)),
  median: (xs, n) => xs.map((_, i) => {
    const w = window(xs, i, n);
    if (!w || w.some(Number.isNaN)) return NaN;
    const s = [...w].sort((a, b) => a - b);
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }),
  percentrank: (xs, n) => xs.map((v, i) => {
    const w = window(xs, i, n + 1);
    return w && !w.some(Number.isNaN) ? (w.slice(0, n).filter((p) => p <= v).length / n) * 100 : NaN;
  }),
  pivot: (xs, left, right, sign) => xs.map((_, i) => {
    const m = i - right;
    if (m - left < 0) return NaN;
    for (let k = m - left; k < m; k++) if (sign * xs[k] >= sign * xs[m]) return NaN;
    for (let k = m + 1; k <= i; k++) if (sign * xs[k] > sign * xs[m]) return NaN;
    return xs[m];
  }),
};

for (const name of SETS) {
  const { bars, n } = loadBars(name);
  const close = Array.from(bars.close);
  const volume = Array.from(bars.volume);
  const get = (xs) => (i) => xs[i];

  test(`${name}: window steppers match their definitions`, () => {
    for (const len of [1, 2, 7, 20, 64]) {
      sameSeries(column(ta.sma(AT, len), n, get(close)), slow.sma(close, len), `sma ${len}`);
      sameSeries(column(ta.sum(AT, len), n, get(volume)), slow.sum(volume, len), `sum ${len}`);
      sameSeries(column(ta.wma(AT, len), n, get(close)), slow.wma(close, len), `wma ${len}`);
      sameSeries(column(ta.variance(AT, len), n, get(close)), slow.variance(close, len), `variance ${len}`);
      sameSeries(column(ta.stdev(AT, len), n, get(close)), slow.variance(close, len).map(Math.sqrt), `stdev ${len}`);
      sameSeries(column(ta.highest(AT, len), n, get(close)), slow.highest(close, len), `highest ${len}`);
      sameSeries(column(ta.lowest(AT, len), n, get(close)), slow.lowest(close, len), `lowest ${len}`);
      sameSeries(column(ta.highestbars(AT, len), n, get(close)), slow.highestbars(close, len, 1), `highestbars ${len}`);
      sameSeries(column(ta.lowestbars(AT, len), n, get(close)), slow.highestbars(close, len, -1), `lowestbars ${len}`);
      sameSeries(column(ta.median(AT, len), n, get(close)), slow.median(close, len), `median ${len}`);
      sameSeries(column(ta.percentrank(AT, len), n, get(close)), slow.percentrank(close, len), `percentrank ${len}`);
    }
  });

  test(`${name}: change, roc and mom`, () => {
    for (const len of [1, 5, 30]) {
      sameSeries(column(ta.change(AT, len), n, get(close)), slow.change(close, len), `change ${len}`);
      sameSeries(column(ta.mom(AT, len), n, get(close)), slow.change(close, len), `mom ${len}`);
      sameSeries(column(ta.roc(AT, len), n, get(close)), slow.roc(close, len), `roc ${len}`);
    }
  });

  test(`${name}: vwma and hma`, () => {
    const len = 14;
    const pv = close.map((c, i) => c * volume[i]);
    const expectVwma = slow.sum(pv, len).map((v, i) => v / slow.sum(volume, len)[i]);
    sameSeries(run(ta.vwma(AT, len), n, (i) => [close[i], volume[i]]), expectVwma, "vwma");
    const half = slow.wma(close, 7);
    const full = slow.wma(close, 14);
    const raw = half.map((v, i) => 2 * v - full[i]);
    // wma over a series that starts with na: the first full window of raw values.
    const hull = raw.map((_, i) => {
      const w = i >= 2 ? raw.slice(i - 2, i + 1) : null;
      return w && !w.some(Number.isNaN) ? w.reduce((a, v, k) => a + (k + 1) * v, 0) / 6 : NaN;
    });
    sameSeries(column(ta.hma(AT, 14), n, get(close)), hull, "hma");
  });

  test(`${name}: pivots are confirmed on the later bar`, () => {
    for (const [left, right] of [[2, 2], [5, 3], [1, 6]]) {
      sameSeries(column(ta.pivothigh(AT, left, right), n, (i) => bars.high[i]), slow.pivot(Array.from(bars.high), left, right, 1), `high ${left},${right}`);
      sameSeries(column(ta.pivotlow(AT, left, right), n, (i) => bars.low[i]), slow.pivot(Array.from(bars.low), left, right, -1), `low ${left},${right}`);
    }
  });

  test(`${name}: true range, rvol and stoch`, () => {
    const tr = run(ta.tr(), n, (i) => [bars.high[i], bars.low[i], bars.close[i]]);
    const expectTr = Array.from(bars.close, (_, i) => (i === 0 ? bars.high[0] - bars.low[0]
      : Math.max(bars.high[i] - bars.low[i], Math.abs(bars.high[i] - bars.close[i - 1]), Math.abs(bars.low[i] - bars.close[i - 1]))));
    sameSeries(tr, expectTr, "tr");
    const avgBefore = slow.sma(volume, 20);
    sameSeries(column(ta.rvol(AT, 20), n, get(volume)), volume.map((v, i) => (i >= 20 && avgBefore[i - 1] ? v / avgBefore[i - 1] : NaN)), "rvol");
    const hh = slow.highest(Array.from(bars.high), 14);
    const ll = slow.lowest(Array.from(bars.low), 14);
    const raw = close.map((c, i) => (hh[i] - ll[i] > 0 ? (100 * (c - ll[i])) / (hh[i] - ll[i]) : NaN));
    const k = slow.sma(raw, 3);
    const d = slow.sma(k, 3);
    const [gotK, gotD] = outputs(ta.stoch(AT, 14, 3, 3), n, (i) => [bars.high[i], bars.low[i], bars.close[i]], 2);
    sameSeries(gotK, k, "k");
    sameSeries(gotD, d, "d");
  });

  test(`${name}: crossovers, runs, barssince, valuewhen, cum`, () => {
    const fast = slow.sma(close, 5);
    const slowAvg = slow.sma(close, 20);
    const over = fast.map((v, i) => i > 0 && v > slowAvg[i] && fast[i - 1] <= slowAvg[i - 1]);
    const under = fast.map((v, i) => i > 0 && v < slowAvg[i] && fast[i - 1] >= slowAvg[i - 1]);
    const args = (i) => [fast[i], slowAvg[i]];
    const bools = (s) => Array.from(run(s, n, args), Boolean);
    assert.deepEqual(bools(ta.crossover()), over);
    assert.deepEqual(bools(ta.crossunder()), under);
    assert.deepEqual(bools(ta.cross()), over.map((v, i) => v || under[i]));
    assert.ok(over.some(Boolean) && under.some(Boolean));

    const rises = (len) => close.map((_, i) => i >= len && close.slice(i - len, i + 1).every((v, k, w) => k === 0 || v > w[k - 1]));
    assert.deepEqual(Array.from(run(ta.rising(AT, 3), n, (i) => [close[i]]), Boolean), rises(3));
    const falls = (len) => close.map((_, i) => i >= len && close.slice(i - len, i + 1).every((v, k, w) => k === 0 || v < w[k - 1]));
    assert.deepEqual(Array.from(run(ta.falling(AT, 2), n, (i) => [close[i]]), Boolean), falls(2));

    const up = close.map((c, i) => i > 0 && c > close[i - 1]);
    let since = NaN;
    const expectSince = up.map((u) => { since = u ? 0 : since + 1; return since; });
    sameSeries(run(ta.barssince(), n, (i) => [up[i]]), expectSince, "barssince");

    for (const nth of [0, 1, 3]) {
      const hits = [];
      const expect = up.map((u, i) => { if (u) hits.unshift(close[i]); return hits.length > nth ? hits[nth] : NaN; });
      sameSeries(run(ta.valuewhen(AT, nth), n, (i) => [up[i], close[i]]), expect, `valuewhen ${nth}`);
    }

    let total = 0;
    sameSeries(column(ta.cum(), n, get(volume)), volume.map((v) => (total += v)), "cum");
  });
}

// ---- na handling, limits and long runs ---------------------------------------------------------------------

test("a window with an na gives na until it passes; recursive averages skip the na", () => {
  const xs = [1, 2, 3, NaN, 5, 6, 7, 8, 9];
  const out = (s) => Array.from(run(s, xs.length, (i) => [xs[i]]));
  assert.deepEqual(out(ta.sma(AT, 3)).map((v) => (v !== v ? null : v)), [null, null, 2, null, null, null, 6, 7, 8]);
  assert.deepEqual(out(ta.highest(AT, 2)).map((v) => (v !== v ? null : v)), [null, 2, 3, null, null, 6, 7, 8, 9]);
  assert.deepEqual(out(ta.lowest(AT, 3)).map((v) => (v !== v ? null : v)), [null, null, 1, null, null, null, 5, 6, 7]);
  const ema = out(ta.ema(AT, 2));
  assert.deepEqual(ema.slice(0, 3).map((v) => (v !== v ? null : v)), [null, 1.5, 2.5]);
  assert.ok(Number.isNaN(ema[3]) && ema[4] > 3);
  assert.equal(out(ta.cum())[3] !== out(ta.cum())[3], true);
});

test("running sums stay exact over thousands of bars (refresh and na recovery)", () => {
  const n = 6000;
  const xs = Array.from({ length: n }, (_, i) => 1000 + Math.sin(i / 7) * 50 + (i % 97) * 0.37 + (i % 1500 === 700 ? NaN : 0));
  sameSeries(column(ta.sma(AT, 40), n, (i) => xs[i]), slow.sma(xs, 40), "sma", 1e-9);
  sameSeries(column(ta.stdev(AT, 40), n, (i) => xs[i]), slow.variance(xs, 40).map(Math.sqrt), "stdev", 1e-9);
  sameSeries(column(ta.wma(AT, 40), n, (i) => xs[i]), slow.wma(xs, 40), "wma", 1e-9);
});

test("stoch, pivot and friends give na for flat ranges", () => {
  const flat = new Array(30).fill(10);
  const [k] = outputs(ta.stoch(AT, 5, 1, 1), 30, () => [10, 10, 10], 2);
  assert.ok(Array.from(k).every(Number.isNaN));
  assert.ok(Array.from(run(ta.pivothigh(AT, 2, 2), 30, (i) => [flat[i]])).every(Number.isNaN));
  assert.ok(Array.from(run(ta.rsi(AT, 5), 30, (i) => [flat[i]])).slice(6).every((v) => v === 100));
});

test("lengths are checked when a stepper is made (R404)", () => {
  for (const bad of [0, -1, 2.5, 5001, NaN]) {
    assert.throws(() => ta.sma([4, 9], bad), (e) => e instanceof rt.RunError && e.code === "R404" && e.line === 4 && e.col === 9);
  }
  assert.throws(() => ta.valuewhen(AT, -1), /R404|nth/);
  assert.doesNotThrow(() => ta.valuewhen(AT, 0));
  assert.doesNotThrow(() => ta.sma(AT, 5000));
  assert.throws(() => ta.pivothigh(AT, 0, 3), (e) => e.code === "R404");
});

test("every stepper the catalogue lists exists", async () => {
  const { GLOBALS } = await import("../../../src/momo_scan/web/static/js/script/catalog.js");
  for (const entry of Object.values(GLOBALS)) {
    if (entry.kind !== "ta" || entry.later) continue;
    assert.equal(typeof ta[entry.name.slice(3)], "function", entry.name);
  }
});

test("the catalogue's argument order matches the constructors", () => {
  // Fixed arguments go to the constructor in catalogue order; the rest, then the implicit bars, to step().
  const make = (name, ctor) => ta[name](AT, ...ctor);
  const macd = make("macd", [3, 6, 2]);
  macd.step(1);
  assert.ok("o2" in macd);
  assert.equal(make("kc", [5, 3]).atr.rma.n, 3);
  assert.equal(make("stoch", [5, 2, 4]).d.m.n, 4);
  assert.equal(make("pivothigh", [3, 5]).right, 5);
});

// ---- colours, text, numbers, lists ------------------------------------------------------------------

test("colours: rgb, alpha, packing", () => {
  assert.equal(rt.rgb(41, 98, 255), 0x2962ffff);
  assert.equal(rt.rgb(41, 98, 255, 50), 0x2962ff80);
  assert.equal(rt.rgb(300, -5, 0, 0), 0xff000000);
  assert.equal(rt.rgb(NaN, 1, 2), 0);
  assert.equal(rt.alpha(0x2962ffff, 10), 0x2962ff1a);
  assert.equal(rt.alpha(0x2962ffff, 0), 0x2962ff00);
  assert.equal(rt.alpha(0, 50), 0);
  assert.equal(rt.alpha(NaN, 50), 0);
  assert.equal(rt.alpha(0x2962ffff, 500), 0x2962ffff);
  assert.equal(rt.fmtColor(0x2962ffff), "#2962ff");
  assert.equal(rt.fmtColor(0), "none");
});

test("numbers: division, modulo, power, log, round, clamp, infinity", () => {
  assert.ok(Number.isNaN(rt.div(1, 0)) && rt.div(6, 3) === 2);
  assert.ok(Number.isNaN(rt.mod(5, 0)));
  assert.equal(rt.mod(-1, 5), 4);
  assert.equal(rt.mod(7, 5), 2);
  assert.ok(Number.isNaN(rt.pow(0, -1)) && Number.isNaN(rt.pow(-8, 0.5)) && rt.pow(2, 10) === 1024);
  assert.ok(Number.isNaN(rt.log(0)) && Number.isNaN(rt.log(-3)) && rt.log(1) === 0);
  assert.equal(rt.round(2.5), 3);
  assert.equal(rt.round(1.2345, 2), 1.23);
  assert.equal(rt.clamp(5, 0, 1), 1);
  assert.equal(rt.nz(NaN, 7), 7);
  assert.equal(rt.nz(3, 7), 3);
  assert.ok(rt.ne(1, 2) && !rt.ne(1, 1) && !rt.ne(NaN, 1) && !rt.ne(NaN, NaN));
  assert.ok(rt.T(2) && !rt.T(0) && !rt.T(NaN));
  assert.ok(Number.isNaN(rt.F(Infinity)) && rt.F(3) === 3);
});

test("text: fmt formats numbers, booleans and strings", () => {
  assert.equal(rt.fmt(3.14159, ".2f"), "3.14");
  assert.equal(rt.fmt(3.14159), "3.14159");
  assert.equal(rt.fmt(2, ""), "2");
  assert.equal(rt.fmt(1234567.891, ",.1f"), "1,234,567.9");
  assert.equal(rt.fmt(1234567, ","), "1,234,567");
  assert.equal(rt.fmt(0.256, ".1%"), "25.6%");
  assert.equal(rt.fmt(0.5, "%"), "50.00%");
  assert.equal(rt.fmt(NaN, ".2f"), "na");
  assert.equal(rt.fmt(Infinity), "na");
  assert.equal(rt.fmt(true), "true");
  assert.equal(rt.fmt("x", ".2f"), "x");
  assert.equal(rt.fmt(-1234.5, ",.0f"), "-1,235");
  assert.equal(rt.clip("a".repeat(500)).length, 200);
});

test("lists: push limit, pop, remove, get, aggregates skip na", () => {
  const xs = [];
  for (let i = 0; i < 10000; i++) rt.lpush(xs, i);
  assert.throws(() => rt.lpush(xs, 1, [3, 4], 9), (e) => e.code === "R403" && e.line === 3 && e.col === 4 && e.i === 9);
  const ys = [3, NaN, 1, 2];
  assert.equal(rt.lsum(ys), 6);
  assert.equal(rt.lmax(ys), 3);
  assert.equal(rt.lmin(ys), 1);
  assert.equal(rt.lavg(ys), 2);
  assert.ok(Number.isNaN(rt.lsum([])) && Number.isNaN(rt.lmax([NaN])));
  assert.equal(rt.lget(ys, -1), 2);
  assert.equal(rt.lget(ys, 0), 3);
  assert.ok(Number.isNaN(rt.lget(ys, 9)) && Number.isNaN(rt.lget(ys, 1.5)) && Number.isNaN(rt.lget(ys, NaN)));
  assert.equal(rt.lpop(ys), 2);
  assert.ok(Number.isNaN(rt.lpop([])));
  rt.lremove(ys, 0);
  assert.deepEqual(ys, [NaN, 1]);
  rt.lremove(ys, 9);
  assert.equal(ys.length, 2);
});

// ---- inputs, series, calendar, outputs ---------------------------------------------------------------------

test("inputs: the page's values are checked again", () => {
  const inputs = { n: 7.9, big: 9999, ok: true, side: "Left", c: "#ff0000", bad: "x", src: "hl2" };
  assert.equal(rt.inputNumber(inputs, "n", 20, 1, 500, true), 7);
  assert.equal(rt.inputNumber(inputs, "big", 20, 1, 500, true), 500);
  assert.equal(rt.inputNumber(inputs, "missing", 20, 1, 500, true), 20);
  assert.equal(rt.inputNumber(inputs, "bad", 2.5, null, null, false), 2.5);
  assert.equal(rt.inputNumber({ __proto__: { n: 3 } }, "n", 20, null, null, false), 20);
  assert.equal(rt.inputNumber({}, "constructor", 4, null, null, false), 4);
  assert.equal(rt.inputBool(inputs, "ok", false), true);
  assert.equal(rt.inputBool(inputs, "n", false), false);
  assert.equal(rt.inputChoice(inputs, "side", "Right", ["Left", "Right"]), "Left");
  assert.equal(rt.inputChoice({ side: "<script>" }, "side", "Right", ["Left", "Right"]), "Right");
  assert.equal(rt.inputColor(inputs, "c", "#00ff00"), 0xff0000ff);
  assert.equal(rt.inputColor(inputs, "bad", "#00ff00"), 0x00ff00ff);
  assert.equal(rt.inputColor({ c: 0x2962ffff }, "c", "#00ff00"), 0x2962ffff);
  const { bars } = loadBars("trend");
  assert.equal(rt.inputSource(bars, inputs, "src", "close")[3], (bars.high[3] + bars.low[3]) / 2);
  assert.equal(rt.inputSource(bars, { src: "evil" }, "src", "close"), bars.close);
});

test("derived series are built once and cached per bars object", () => {
  const { bars } = loadBars("trend");
  const hlc3 = rt.sourceSeries(bars, "hlc3");
  assert.equal(hlc3[10], (bars.high[10] + bars.low[10] + bars.close[10]) / 3);
  assert.equal(rt.sourceSeries(bars, "hlc3"), hlc3);
  assert.equal(rt.sourceSeries(bars, "ohlc4")[5], (bars.open[5] + bars.high[5] + bars.low[5] + bars.close[5]) / 4);
  assert.equal(rt.sourceSeries(bars, "bar_index")[42], 42);
  assert.equal(rt.sourceSeries(bars, "close"), bars.close);
});

test("calendar: dates, weekday, intraday clock, new day, regular session", () => {
  const { bars, n } = loadBars("intraday");
  const cal = rt.calendar(bars.time, true);
  assert.deepEqual([cal.year[0], cal.month[0], cal.day[0], cal.dayofweek[0], cal.hour[0], cal.minute[0]], [2024, 3, 4, 1, 9, 30]);
  assert.deepEqual([cal.hour[77], cal.minute[77]], [15, 55]);
  assert.equal(cal.newDay[0], 1);
  assert.equal(cal.newDay[1], 0);
  assert.equal(cal.newDay[78], 1);
  assert.equal(cal.regular[0], 1);
  assert.equal(n, 312);
  const daily = rt.calendar(Float64Array.of(Date.UTC(2024, 1, 29) / 1000, Date.UTC(2024, 11, 31) / 1000, Date.UTC(2000, 0, 1) / 1000), false);
  assert.deepEqual(Array.from(daily.month), [2, 12, 1]);
  assert.deepEqual(Array.from(daily.day), [29, 31, 1]);
  assert.deepEqual(Array.from(daily.year), [2024, 2024, 2000]);
  assert.deepEqual(Array.from(daily.dayofweek), [4, 2, 6]);
  assert.deepEqual(Array.from(daily.regular), [1, 1, 1]);
  const night = rt.calendar(Float64Array.of(Date.UTC(2024, 2, 4, 8, 0) / 1000, Date.UTC(2024, 2, 4, 16, 0) / 1000), true);
  assert.deepEqual(Array.from(night.regular), [0, 0]);
});

test("chart info comes from the interval", () => {
  const c = (interval) => rt.chart({ chart: { interval, ticker: "NVDA" } });
  assert.deepEqual([c("5m").intraday, c("1h").intraday, c("D").intraday, c("D").daily, c("2W").weekly, c("M").monthly], [true, true, false, true, true, true]);
  assert.equal(c("M").intraday, false);
  assert.equal(rt.chart({}).daily, true);
  assert.equal(c("D").ticker, "NVDA");
});

test("outputs: markers, levels, stats and logs drop non-finite and clip text", () => {
  const markers = [];
  rt.mark(markers, "up", "dot", 3, 10.5, 0xff0000ff, "a".repeat(300));
  rt.mark(markers, "up", "dot", 4, NaN, 0, "");
  assert.equal(markers.length, 1);
  assert.equal(markers[0].text.length, 200);
  const levels = [];
  rt.level(levels, "k", 5, 0, "solid", "K");
  rt.level(levels, "k", Infinity, 0, "solid", "K");
  assert.equal(levels.length, 1);
  const stats = [];
  rt.stat(stats, "ADR", Infinity, 0, "percent");
  rt.stat(stats, "Side", "Long", 0, "number");
  assert.ok(Number.isNaN(stats[0].value));
  assert.equal(stats[1].value, "Long");
  const logs = [];
  for (let i = 0; i < 700; i++) rt.logLine(logs, i, ["x", i, NaN]);
  assert.equal(logs.length, 500);
  assert.equal(logs[0].text, "x 0 na");
});

test("result puts plots and signals in null-prototype maps", () => {
  const out = rt.result({
    plots: [["__proto__", Float64Array.of(1), null], ["b", Float64Array.of(2), Uint32Array.of(3)]],
    markers: [], levels: [], stats: [], logs: [], signals: [["constructor", Uint8Array.of(1)]], barColors: null, bgColors: Uint32Array.of(1),
  });
  assert.equal(Object.getPrototypeOf(out.plots), null);
  assert.deepEqual(Object.keys(out.plots), ["__proto__", "b"]);
  assert.deepEqual(Array.from(out.plots.b.colors), [3]);
  assert.equal(out.plots.__proto__.colors, undefined);
  assert.deepEqual(Object.keys(out.signals), ["constructor"]);
  assert.equal("barColors" in out, false);
  assert.ok(out.bgColors);
  assert.deepEqual(out.drawings, { lines: [], boxes: [], labels: [] });
});

test("the step limit throws R402 with the loop's position", () => {
  assert.throws(() => rt.stepLimit([7, 5], 12), (e) => e.code === "R402" && e.line === 7 && e.col === 5 && e.i === 12);
});

test("limits match the plan", () => {
  assert.deepEqual({ ...rt.LIMITS }, {
    source: 100_000, loopSteps: 1_000_000, list: 10_000, drawings: 500, plots: 64, string: 200, runMs: 250,
    length: 5000, logs: 500, calls: 400,
  });
  assert.throws(() => { rt.LIMITS.list = 1; }, TypeError);
  assert.equal(na(null) !== na(null), true);
});
