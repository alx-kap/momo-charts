// The library scripts (static/scripts/*.momo) draw what the built-in indicators draw: same
// plots, same values to 1e-9, on the three fixture bar sets. (RS line waits for symbol(), phase 7.)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { INDICATORS } from "../../../src/momo_scan/web/static/js/indicators.js";
import { compile, execute } from "../../../src/momo_scan/web/static/js/script/compile.js";
import { SETS, loadBars, sameSeries } from "./fixtures.mjs";

const DIR = new URL("../../../src/momo_scan/web/static/scripts/", import.meta.url);
const source = (name) => readFileSync(new URL(`${name}.momo`, DIR), "utf8");
const TYPES = ["sma", "ema", "bb", "kc", "rsi", "macd", "atr", "adr"];

// The script's plot key for each built-in plot key, where the titles differ.
const KEYS = { rsi: { line: "rsi" }, atr: { line: "atr" }, adr: { line: "adr" }, macd: { hist: "histogram" } };

test("every library file compiles and is covered here", () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith(".momo")).map((name) => name.slice(0, -5)).sort();
  assert.deepEqual(files, [...TYPES].sort());
  for (const name of files) {
    const built = compile(source(name));
    assert.ok(built.ok, `${name}: ${JSON.stringify(built.errors)}`);
  }
});

for (const type of TYPES) {
  for (const set of SETS) {
    test(`${type} script matches the built-in on ${set} bars`, () => {
      const def = INDICATORS[type];
      const { bars, rows } = loadBars(set);
      const built = compile(source(type));
      assert.ok(built.ok);
      const run = execute(built.code, bars, {}, {});
      assert.ok(run.ok, JSON.stringify(run.error));
      const params = Object.fromEntries(def.inputs.map((input) => [input.key, input.value]));
      const expected = def.compute(rows, params, {});
      for (const plot of def.plots) {
        const key = (KEYS[type] || {})[plot.key] || plot.key;
        assert.ok(run.plots[key], `${type}: the script has no plot "${key}"`);
        sameSeries(run.plots[key].values, expected[plot.key], `${type}.${plot.key}`);
      }
      // The script's inputs are the built-in's, with the same defaults and limits.
      for (const input of def.inputs) {
        const mine = built.meta.inputs.find((each) => each.default === input.value && each.min === input.min && each.max === input.max);
        assert.ok(mine, `${type}: no input like ${input.label}`);
      }
      assert.deepEqual(built.meta.plots.filter((p) => p.kind === "hline").map((p) => p.price), def.levels || []);
      assert.equal(built.meta.overlay, def.pane === "price");
    });
  }
}
