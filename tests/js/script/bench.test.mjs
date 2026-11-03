// Benchmarks are tests: they fail when a script gets slower than its budget (docs/scripting.md,
// "Speed"). Timing is noisy, so a budget passes when any of three attempts meets it; the median
// of many warm runs is what counts, not the first (cold) one. Run alone: the Python wrapper
// uses --test-concurrency=1 so other test files don't compete for the CPU.
import assert from "node:assert/strict";
import { test } from "node:test";

import { compile, instantiate } from "../../../src/momo_scan/web/static/js/script/compile.js";

// ---- 10,000 synthetic bars ---------------------------------------------------------------------------

function bars(n = 10_000) {
  const column = () => new Float64Array(n);
  const out = { time: column(), open: column(), high: column(), low: column(), close: column(), volume: column() };
  let price = 100;
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const open = price;
    price *= 1 + (random() - 0.5) * 0.04;
    out.time[i] = 1.7e9 + i * 86400;
    out.open[i] = open;
    out.close[i] = price;
    out.high[i] = Math.max(open, price) * (1 + random() * 0.01);
    out.low[i] = Math.min(open, price) * (1 - random() * 0.01);
    out.volume[i] = 1e6 * (0.5 + random());
  }
  return out;
}

// A typical indicator: bands, squeeze, trend, momentum, volume, signals. 50 lines, 10 ta calls, 12 outputs.
const FIFTY_LINES = `#momo 1
indicator("Squeeze and trend", overlay=true)

# Bollinger squeeze, trend and momentum in one pane.

length = input.int(20, "Length", min=2, max=200)
mult = input.float(2.0, "StdDev", step=0.1)
src = input.source(close, "Source")
fast_n = input.int(12, "Fast")
slow_n = input.int(26, "Slow")

# Bands and squeeze.
basis = ta.sma(src, length)
dev = mult * ta.stdev(src, length)
upper = basis + dev
lower = basis - dev
width = (upper - lower) / basis * 100
squeeze = width < ta.lowest(width, 120)[1]
trend = ta.ema(close, fast_n) - ta.ema(close, slow_n)
momentum = ta.rsi(close, 14)
atr = ta.atr(14)
macd_line, signal_line, hist = ta.macd(close, fast_n, slow_n, 9)
vol_ratio = volume / ta.sma(volume, 20)
range_pct = (high - low) / close * 100
cross_up = ta.crossover(close, basis)

def score(a, b):
    return (a - b) / b * 100

var count = 0
var best = na
if na(best) or close > best:
    best = close
if squeeze and not squeeze[1]:
    count += 1
sc = score(close, basis)

# Drawing and signals.
plot(basis, "Basis", color=color.orange)
plot(upper, "Upper", color=color.blue)
plot(lower, "Lower", color=color.blue)
plot(trend, "Trend")
plot(momentum, "RSI")
plot(hist, "Hist", style="histogram")
plot(sc, "Score")
marker(squeeze and not squeeze[1], "Squeeze", shape="dot", at="below")
marker(cross_up, "Cross", shape="triangle_up")
barcolor(color.yellow if squeeze else na)
signal("squeeze", squeeze)
value("vol", vol_ratio)
`;

// The same with more on every bar: 14 ta calls, 16 outputs.
const HEAVY = FIFTY_LINES.replace('value("vol", vol_ratio)', `value("vol", vol_ratio)
hh = ta.highest(high, 50)
ll = ta.lowest(low, 50)
value("pos", (close - ll) / (hh - ll))
value("since", ta.barssince(cross_up))
value("ups", ta.sum(close > open, 10))
value("range", range_pct + atr)`);

function median(fn, runs) {
  const times = [];
  for (let k = 0; k < runs; k++) {
    const started = performance.now();
    fn();
    times.push(performance.now() - started);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

function within(budget, fn, t) {
  const medians = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    medians.push(median(fn, 40));
    if (medians[attempt] < budget) break;
  }
  t.diagnostic(`median ${medians.map((m) => m.toFixed(2)).join(", ")} ms (budget ${budget} ms)`);
  assert.ok(medians.at(-1) < budget, `median ${medians.at(-1).toFixed(2)} ms is over ${budget} ms`);
}

// Cold first: nothing has been compiled yet in this process.
test("100 different 50-line scripts compile in under 100 ms", (t) => {
  const scripts = (offset) => Array.from({ length: 100 }, (_, k) => FIFTY_LINES
    .replace("Squeeze and trend", `Script ${offset}-${k}`)
    .replace("120", String(100 + k + offset))
    .replace("min=2, max=200", `min=${2 + (k % 3)}, max=${200 + k}`)
    .replace(/\bscore\b/g, `score_${k}`));
  const totals = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const batch = scripts(attempt * 1000);
    const started = performance.now();
    for (const source of batch) { const r = compile(source); assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.errors)); }
    totals.push(performance.now() - started);
    if (totals[attempt] < 100) break;
  }
  t.diagnostic(`100 compiles: ${totals.map((m) => m.toFixed(1)).join(", ")} ms (budget 100 ms)`);
  assert.ok(totals.at(-1) < 100, `100 compiles took ${totals.at(-1).toFixed(1)} ms`);
});

test("the benchmark scripts are what they say", () => {
  assert.equal(FIFTY_LINES.trimEnd().split("\n").length, 50);
  const fifty = compile(FIFTY_LINES);
  assert.ok(fifty.ok, JSON.stringify(fifty.errors));
  assert.equal((fifty.code.match(/rt\.ta\./g) || []).length, 10);
  const heavy = compile(HEAVY);
  assert.ok(heavy.ok, JSON.stringify(heavy.errors));
  assert.equal((heavy.code.match(/rt\.ta\./g) || []).length, 14);
});

test("a 50-line script runs over 10,000 bars in under 2 ms", (t) => {
  const run = instantiate(compile(FIFTY_LINES).code);
  const data = bars();
  const first = performance.now();
  run(data);
  t.diagnostic(`first (cold) run ${(performance.now() - first).toFixed(1)} ms`);
  for (let k = 0; k < 10; k++) run(data);
  within(2, () => run(data), t);
});

test("a heavier script (14 ta calls, 16 outputs) stays under 3 ms; the aim is still 2", (t) => {
  const run = instantiate(compile(HEAVY).code);
  const data = bars();
  for (let k = 0; k < 10; k++) run(data);
  within(3, () => run(data), t);
});

test("time grows with the bars, not worse: 100,000 bars take about ten times 10,000", (t) => {
  const run = instantiate(compile(FIFTY_LINES).code);
  const small = bars(10_000);
  const large = bars(100_000);
  for (let k = 0; k < 5; k++) { run(small); run(large); }
  const a = median(() => run(small), 20);
  const b = median(() => run(large), 10);
  t.diagnostic(`10k: ${a.toFixed(2)} ms, 100k: ${b.toFixed(2)} ms`);
  assert.ok(b < a * 25, `${b} vs ${a}`);
});
