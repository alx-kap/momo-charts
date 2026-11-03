// momo script indicators on the chart: fetch a script's source, compile it, run it through the
// sandbox host and hand the chart plain arrays. The chart never sees compiled code or the worker.
// Output from a script is data to be checked and drawn (docs/scripting.md, "Phase 3"): colours
// become hex strings built here, and text is only ever set with textContent by the callers.

import { LIBRARY, defFromMeta, failedDef, hydrate, registerScript, scriptKey } from "./indicators.js";
import { compile } from "./script/compile.js";
import { sharedHost } from "./script/host.js";

const compiled = new Map(); // script key → Promise of { ok, meta, code } | { ok: false, error }

async function sourceOf(ind) {
  if (!LIBRARY.some((item) => item.key === ind.library)) throw new Error("Stored scripts arrive in a later release.");
  const response = await fetch(`/static/scripts/${ind.library}.momo`);
  if (!response.ok) throw new Error(`Couldn't load the ${ind.library} script (${response.status}).`);
  return response.text();
}

async function build(ind) {
  let source;
  try {
    source = await sourceOf(ind);
  } catch (error) {
    return { ok: false, error: { code: "L001", message: error.message } };
  }
  const result = compile(source);
  if (result.ok) return result;
  const first = result.errors[0];
  return { ok: false, error: { code: first.code, message: `line ${first.line}: ${first.message}` } };
}

// Compiles the entry's script once and registers its definition. Never rejects: a script that
// fails gets a bare definition carrying the error.
export function loadScript(ind) {
  const key = scriptKey(ind);
  if (!compiled.has(key)) {
    compiled.set(key, build(ind).then((built) => {
      registerScript(key, built.ok ? defFromMeta(built.meta) : failedDef(ind, built.error));
      return built;
    }));
  }
  return compiled.get(key).then((built) => {
    if (built.ok && ind.params && ind.style) hydrate(ind, defFromMeta(built.meta));
    return built;
  });
}

// The chart's bars as the columns the sandbox takes. Daily times are dates; scripts see seconds.
export function columns(bars) {
  const n = bars.length;
  const out = { time: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    out.time[i] = typeof bar.time === "number" ? bar.time : Date.parse(`${bar.time}T00:00:00Z`) / 1000;
    out.open[i] = bar.open;
    out.high[i] = bar.high;
    out.low[i] = bar.low;
    out.close[i] = bar.close;
    out.volume[i] = bar.volume;
  }
  return out;
}

const hex = (n) => (n & 0xff).toString(16).padStart(2, "0");
// 0xRRGGBBAA → "#rrggbb" or "#rrggbbaa"; 0 means no colour.
export function colorText(packed) {
  if (!packed) return null;
  const alpha = packed & 0xff;
  return `#${hex(packed >>> 24)}${hex(packed >>> 16)}${hex(packed >>> 8)}${alpha === 255 ? "" : hex(alpha)}`;
}

// One run of the entry's script over `bars`: { ok: true, series, colors, ms } where series maps a
// plot key to an array (null where the script has no value) as long as `bars`, or { ok: false,
// error: { code, message } }.
export async function runScript(ind, bars, chart) {
  const built = await loadScript(ind);
  if (!built.ok) return { ok: false, error: built.error };
  if (!bars.length) return { ok: true, series: {}, colors: {}, ms: 0 };
  const def = defFromMeta(built.meta);
  const inputs = Object.fromEntries(def.inputs.filter((input) => input.key in ind.params).map((input) => [input.key, ind.params[input.key]]));
  const reply = await sharedHost().run({ code: built.code, bars: columns(bars), inputs, extra: { chart } });
  if (!reply.ok) return { ok: false, error: { code: reply.error.code, message: reply.error.message } };
  const series = {};
  const colors = {};
  for (const plot of def.plots) {
    const found = reply.plots[plot.key];
    if (!found) continue;
    const values = found.values;
    series[plot.key] = Array.from(values, (v) => (v === v ? v : null));
    if (found.colors) colors[plot.key] = Array.from(found.colors, colorText);
  }
  return { ok: true, series, colors, ms: reply.ms };
}
