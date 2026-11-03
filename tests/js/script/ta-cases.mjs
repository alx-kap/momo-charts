// What every ta stepper gives on the fixture bars, as plain data both languages check:
// tests/script_cases/ta/expected.json is built here (node tests/js/script/make-ta-expected.mjs)
// and read by the Python tests, so the two runtimes can't drift. A fourth bar set, `holes`, is
// the choppy bars with na punched into every column. `cases` says how each result was made:
// the stepper, its constructor arguments and the bar columns (or numbers) each step took.
import { readFileSync } from "node:fs";

import * as rt from "../../../src/momo_scan/web/static/js/script/runtime.js";
import { loadBars } from "./fixtures.mjs";

export const FILE = new URL("../../script_cases/ta/expected.json", import.meta.url);

function holes() {
  const { cols } = loadBars("choppy");
  const n = 240;
  const out = {};
  for (const key of Object.keys(cols)) out[key] = cols[key].slice(0, n);
  for (let i = 0; i < n; i++) {
    if (i % 37 === 5) out.close[i] = NaN;
    if (i % 41 === 9) out.high[i] = NaN;
    if (i % 43 === 11) out.low[i] = NaN;
    if (i % 53 === 3) out.volume[i] = NaN;
    if (i % 47 === 7) out.open[i] = NaN;
  }
  const bars = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Float64Array.from(v)]));
  return { cols: out, bars };
}

// name, constructor arguments, the bar columns each step takes (then the output names).
const CASES = [
  ["sma", [1], ["close"]], ["sma", [20], ["close"]], ["sma", [50], ["hl2"]],
  ["ema", [5], ["close"]], ["ema", [21], ["close"]],
  ["rma", [14], ["close"]], ["wma", [10], ["close"]], ["hma", [21], ["close"]], ["hma", [4], ["close"]],
  ["vwma", [20], ["close", "volume"]],
  ["stdev", [20], ["close"]], ["stdev", [5], ["close"]], ["variance", [20], ["close"]],
  ["highest", [1], ["high"]], ["highest", [20], ["high"]], ["lowest", [20], ["low"]],
  ["highestbars", [20], ["high"]], ["lowestbars", [20], ["low"]],
  ["change", [1], ["close"]], ["change", [5], ["close"]], ["roc", [10], ["close"]], ["mom", [10], ["close"]],
  ["rsi", [14], ["close"]], ["rsi", [2], ["close"]],
  ["atr", [14], ["high", "low", "close"]], ["tr", [], ["high", "low", "close"]],
  ["adr", [20], ["high", "low"]],
  ["macd", [12, 26, 9], ["close"], ["macd_line", "signal_line", "hist"]],
  ["bb", [20], ["close", 2], ["basis", "upper", "lower"]],
  ["kc", [20, 10], ["close", 1.5, "high", "low", "close"], ["basis", "upper", "lower"]],
  ["stoch", [14, 3, 3], ["high", "low", "close"], ["k", "d"]],
  ["crossover", [], ["close", "open"]], ["crossunder", [], ["close", "open"]], ["cross", [], ["close", "hl2"]],
  ["rising", [3], ["close"]], ["falling", [3], ["close"]],
  ["barssince", [], ["close>open"]],
  ["valuewhen", [0], ["close>open", "low"]], ["valuewhen", [2], ["close>open", "low"]],
  ["cum", [], ["volume"]], ["sum", [5], ["volume"]], ["median", [20], ["close"]], ["median", [7], ["close"]],
  ["percentrank", [50], ["close"]],
  ["pivothigh", [5, 5], ["high"]], ["pivotlow", [3, 2], ["low"]],
  ["vwap", [], ["time", "high", "low", "close", "volume"]],
  ["rvol", [20], ["volume"]],
];

const column = (cols, name) => {
  if (name === "hl2") return cols.high.map((h, i) => (h + cols.low[i]) / 2);
  if (name === "close>open") return cols.close.map((c, i) => c > cols.open[i]);
  return cols[name];
};
const num = (v) => (typeof v === "boolean" ? (v ? 1 : 0) : Number.isNaN(v) ? null : v);

export function build() {
  const sets = { trend: loadBars("trend"), choppy: loadBars("choppy"), intraday: loadBars("intraday"), holes: holes() };
  const out = { cases: {}, holes: Object.fromEntries(Object.entries(sets.holes.cols).map(([k, v]) => [k, Array.from(v, num)])), results: {} };
  for (const [set, { cols }] of Object.entries(sets)) {
    for (const [name, ctor, inputs, outputs] of CASES) {
      const stepper = rt.ta[name]([1, 1], ...ctor);
      const n = cols.close.length;
      const series = Array.from({ length: outputs ? outputs.length : 1 }, () => new Array(n));
      const feeds = inputs.map((i) => (typeof i === "number" ? null : column(cols, i)));
      for (let b = 0; b < n; b++) {
        stepper.step(...inputs.map((i, k) => (feeds[k] ? feeds[k][b] : i)));
        if (outputs) outputs.forEach((_, j) => { series[j][b] = num(stepper[`o${j}`]); });
        else series[0][b] = num(stepper.v);
      }
      const key = `${set}/${name}(${ctor.join(",")})`;
      out.results[key] = series;
      out.cases[key] = { set, name, ctor, inputs, outputs: series.length };
    }
  }
  return out;
}

export const read = () => JSON.parse(readFileSync(FILE, "utf8"));
