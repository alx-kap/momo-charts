// Loads the fixture bar sets: columns as Float64Arrays, and rows like indicators.js takes.
import { readFileSync } from "node:fs";

export const SETS = ["trend", "choppy", "intraday"];

export function loadBars(name) {
  const cols = JSON.parse(readFileSync(new URL(`./fixtures/bars-${name}.json`, import.meta.url), "utf8"));
  const bars = Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, Float64Array.from(v)]));
  const rows = cols.time.map((time, i) => ({
    time, open: cols.open[i], high: cols.high[i], low: cols.low[i], close: cols.close[i], volume: cols.volume[i],
  }));
  return { cols, bars, rows, n: cols.time.length };
}

// Same length, na where both are na, otherwise within 1e-9 (relative above 1).
export function sameSeries(actual, expected, label = "", tolerance = 1e-9) {
  if (actual.length !== expected.length) throw new Error(`${label}: length ${actual.length} vs ${expected.length}`);
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const b = expected[i] === null ? NaN : expected[i];
    const bothNa = a !== a && b !== b;
    if (bothNa) continue;
    if (!(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)))) {
      throw new Error(`${label}: bar ${i}: got ${a}, expected ${b}`);
    }
  }
}
