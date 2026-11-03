// tests/script_cases/ta/expected.json is what the steppers give today; the Python port is
// checked against the same file, so a change to a stepper means regenerating it on purpose.
import assert from "node:assert/strict";
import { test } from "node:test";

import { build, read } from "./ta-cases.mjs";

test("ta expected values are current", () => {
  const fresh = JSON.parse(JSON.stringify(build()));
  const saved = read();
  assert.deepEqual(Object.keys(fresh.results), Object.keys(saved.results));
  for (const [key, series] of Object.entries(fresh.results)) assert.deepEqual(series, saved.results[key], key);
  assert.deepEqual(fresh.holes, saved.holes);
  assert.deepEqual(fresh.cases, saved.cases);
});
