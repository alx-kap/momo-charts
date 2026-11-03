// Golden cases: tests/js/script/cases/NAME.momo (a script) + NAME.json (bars, inputs, what to
// expect). They are plain data so the Python port of the language can run the same files.
// See cases/README.md for the format.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { compile, execute } from "../../../src/momo_scan/web/static/js/script/compile.js";
import { loadBars } from "./fixtures.mjs";

const DIR = new URL("./cases/", import.meta.url);
const TOLERANCE = 1e-9;
const read = (name) => readFileSync(new URL(name, DIR), "utf8");

const same = (a, b) => (a === null || a === undefined || Number.isNaN(a) ? b === null : b !== null && Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(b)));
const asNull = (x) => (typeof x === "number" && Number.isNaN(x) ? null : x);

// expected is a subset of actual: objects by key, arrays element by element.
function subset(actual, expected, path) {
  if (expected === null || typeof expected !== "object") {
    if (typeof expected === "number") assert.ok(same(actual, expected), `${path}: got ${actual}, expected ${expected}`);
    else assert.equal(actual, expected, path);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(actual && actual.length === expected.length, `${path}: length ${actual && actual.length}, expected ${expected.length}`);
    expected.forEach((e, i) => subset(actual[i], e, `${path}[${i}]`));
    return;
  }
  for (const [key, value] of Object.entries(expected)) subset(actual && actual[key], value, `${path}.${key}`);
}

function series(actual, expected, path) {
  assert.equal(actual.length, expected.length, `${path}: length`);
  expected.forEach((e, i) => assert.ok(same(actual[i], e), `${path}[${i}]: got ${actual[i]}, expected ${e}`));
}

const names = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

test("there are golden cases", () => assert.ok(names.length >= 50));

for (const name of names) {
  test(`golden: ${name}`, () => {
    const spec = JSON.parse(read(`${name}.json`));
    const compiled = compile(read(`${name}.momo`));
    const expect = spec.expect;

    if (expect.errors) {
      assert.equal(compiled.ok, false, "expected compile errors");
      assert.deepEqual(compiled.errors.map((e) => ({ code: e.code, line: e.line, col: e.col })), expect.errors);
      for (const e of compiled.errors) assert.ok(e.message && e.endCol > e.col - 1, JSON.stringify(e));
      return;
    }
    assert.ok(compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.errors));
    const { bars } = loadBars(spec.bars);
    const out = execute(compiled.code, bars, spec.inputs || {}, spec.extra || {});

    if (expect.runError) {
      assert.equal(out.ok, false, "expected a run error");
      subset(out.error, expect.runError, "runError");
      return;
    }
    assert.ok(out.ok, out.ok ? "" : JSON.stringify(out.error));
    for (const [key, values] of Object.entries(expect.plots || {})) {
      assert.ok(out.plots[key], `no plot ${key}`);
      series(out.plots[key].values, values, `plots.${key}`);
    }
    for (const [key, at] of Object.entries(expect.plotsAt || {})) {
      for (const [i, v] of Object.entries(at)) assert.ok(same(out.plots[key].values[i], v), `plots.${key}[${i}]: got ${out.plots[key].values[i]}, expected ${v}`);
    }
    for (const [key, values] of Object.entries(expect.plotColors || {})) series(out.plots[key].colors, values, `plotColors.${key}`);
    for (const [key, values] of Object.entries(expect.signals || {})) {
      assert.ok(out.signals[key], `no signal ${key}`);
      series(out.signals[key], values, `signals.${key}`);
    }
    for (const [key, at] of Object.entries(expect.signalsAt || {})) {
      for (const [i, v] of Object.entries(at)) assert.equal(out.signals[key][i], v, `signals.${key}[${i}]`);
    }
    if (expect.barColors) series(out.barColors, expect.barColors, "barColors");
    if (expect.bgColors) series(out.bgColors, expect.bgColors, "bgColors");
    for (const key of ["markers", "levels", "stats", "logs"]) {
      if (expect[key]) subset(JSON.parse(JSON.stringify(out[key], (_, v) => asNull(v))), expect[key], key);
    }
    if (expect.meta) subset(JSON.parse(JSON.stringify(compiled.meta)), expect.meta, "meta");
    // Unexpected extras: no plot values that nobody asked about are checked, but na must be na.
    for (const p of Object.values(out.plots)) assert.ok(p.values instanceof Float64Array);
  });
}
