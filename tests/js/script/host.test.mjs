// The host's checks on what a worker sends back (no browser needed), and its cache key. The
// worker itself, the pool and the timeout run in a browser: tools/script_sandbox_probe.js.

import assert from "node:assert/strict";
import test from "node:test";
import { GLOBALS } from "../../../src/momo_scan/web/static/js/script/catalog.js";
import { checkResult, fingerprint, hash } from "../../../src/momo_scan/web/static/js/script/host.js";
import { LIMITS } from "../../../src/momo_scan/web/static/js/script/runtime.js";

const N = 4;
const good = () => ({
  ok: true, ms: 1.5,
  plots: { a: { values: new Float64Array(N) }, b: { values: new Float64Array(N), colors: new Uint32Array(N) }, fill: { values: new Float64Array(0), colors: new Uint32Array(N) } },
  markers: [{ key: "m", i: 3, price: 10, shape: "dot", color: 0xff0000ff, text: "x" }],
  levels: [{ key: "l", price: 1, color: 0, style: "dashed", title: "t" }],
  drawings: { lines: [], boxes: [], labels: [] },
  stats: [{ title: "ADR", value: 3.2, color: 0, format: "percent" }, { title: "na", value: NaN, color: 0, format: null }],
  signals: { up: new Uint8Array(N), v: new Float64Array(N) },
  logs: [{ i: 0, text: "hello" }],
  barColors: new Uint32Array(N),
});
const refused = (mutate, why) => {
  const reply = good();
  mutate(reply);
  assert.throws(() => checkResult(reply, N), /./, why);
};

test("an honest result passes and comes back as fresh objects", () => {
  const reply = good();
  const out = checkResult(reply, N);
  assert.equal(out.ok, true);
  assert.deepEqual(Object.keys(out.plots), ["a", "b", "fill"]);
  assert.equal(out.plots.a.values, reply.plots.a.values);       // typed arrays pass by reference
  assert.notEqual(out.plots.a, reply.plots.a);                  // everything else is rebuilt
  assert.equal(out.levels[0].title, "t");
  assert.equal(out.stats[1].format, null);
});

test("extra fields on the reply are dropped, not passed on", () => {
  const reply = { ...good(), innerHTML: "<img>", plots: { ...good().plots } };
  reply.markers[0].onclick = "x";
  const out = checkResult(reply, N);
  assert.equal("innerHTML" in out, false);
  assert.equal("onclick" in out.markers[0], false);
});

test("series must be typed arrays of the bars' length", () => {
  refused((r) => { r.plots.a.values = [1, 2, 3, 4]; }, "plain array");
  refused((r) => { r.plots.a.values = new Float64Array(N + 1); }, "wrong length");
  refused((r) => { r.plots.a.values = new Float32Array(N); }, "wrong type");
  refused((r) => { r.plots.b.colors = new Float64Array(N); }, "colours as floats");
  refused((r) => { r.plots.b.colors = new Uint32Array(0); }, "colours short");
  refused((r) => { r.barColors = ["#fff", "#fff", "#fff", "#fff"]; }, "colours as text");
  refused((r) => { r.signals.up = new Int8Array(N); }, "signal type");
  refused((r) => { r.signals.up = new Uint8Array(3); }, "signal length");
  refused((r) => { r.plots.a.values = new Float64Array(new ArrayBuffer(8 * (N + 2)), 8, N); }, "a window on a bigger buffer");
});

test("markers, levels, stats and logs are checked field by field", () => {
  refused((r) => { r.markers[0].color = "red"; });
  refused((r) => { r.markers[0].color = -1; });
  refused((r) => { r.markers[0].color = 2 ** 32; });
  refused((r) => { r.markers[0].color = 1.5; });
  refused((r) => { r.markers[0].shape = "<script>"; });
  refused((r) => { r.markers[0].i = N; });
  refused((r) => { r.markers[0].i = 0.5; });
  refused((r) => { r.markers[0].price = Infinity; });
  refused((r) => { r.markers[0].text = "x".repeat(LIMITS.string + 1); });
  refused((r) => { r.markers[0].key = ""; });
  refused((r) => { r.levels[0].style = "wavy"; });
  refused((r) => { r.levels[0].price = NaN; });
  refused((r) => { r.stats[0].format = "html"; });
  refused((r) => { r.stats[0].value = {}; });
  refused((r) => { r.stats[0].title = "x".repeat(LIMITS.string + 1); });
  refused((r) => { r.logs[0].i = N; });
  refused((r) => { r.logs[0].text = "x".repeat(LIMITS.string + 1); });
  refused((r) => { r.logs = Array.from({ length: LIMITS.logs + 1 }, () => ({ i: 0, text: "" })); });
});

test("counts are capped", () => {
  refused((r) => { r.plots = Object.fromEntries(Array.from({ length: LIMITS.plots + 1 }, (_, k) => [`p${k}`, { values: new Float64Array(N) }])); });
  refused((r) => { r.levels = Array.from({ length: LIMITS.plots + 1 }, () => good().levels[0]); });
  refused((r) => { r.stats = Array.from({ length: LIMITS.plots + 1 }, () => good().stats[0]); });
});

test("drawings stay empty until their phase adds checks", () => {
  refused((r) => { r.drawings.lines = [{ x: 1 }]; });
  refused((r) => { r.drawings = null; });
});

test("keys can't be __proto__ and the result is not a prototype trap", () => {
  const reply = good();
  Object.defineProperty(reply.plots, "__proto__", { value: { values: new Float64Array(N) }, enumerable: true });
  assert.throws(() => checkResult(reply, N));
  assert.throws(() => checkResult({ ok: false }, N));
  assert.throws(() => checkResult(null, N));
  assert.throws(() => checkResult({ ...good(), ms: "1" }, N));
});

test("the host's allowed shapes, styles and formats are the catalogue's", () => {
  const choices = (arg) => new Set(Object.values(GLOBALS).flatMap((e) => (e.args || []).filter((a) => a.name === arg && a.choices).flatMap((a) => a.choices)));
  const ok = (mutate) => assert.doesNotThrow(() => { const r = good(); mutate(r); checkResult(r, N); });
  for (const shape of choices("shape")) ok((r) => { r.markers[0].shape = shape; });
  for (const style of choices("style")) if (["solid", "dashed", "dotted"].includes(style)) ok((r) => { r.levels[0].style = style; });
  for (const format of choices("format")) ok((r) => { r.stats[0].format = format; });
  assert.ok(choices("shape").size >= 8);
});

test("cache keys follow the bars, not the object", () => {
  const bars = (n, f = (i) => i) => Object.fromEntries(["time", "open", "high", "low", "close", "volume"].map((c) => [c, Float64Array.from({ length: n }, (_, i) => f(i))]));
  assert.equal(fingerprint(bars(100)), fingerprint(bars(100)));
  assert.notEqual(fingerprint(bars(100)), fingerprint(bars(101)));
  assert.notEqual(fingerprint(bars(100)), fingerprint(bars(100, (i) => (i === 99 ? 5 : i))));
  assert.notEqual(hash("a"), hash("b"));
  assert.equal(hash("same"), hash("same"));
});
