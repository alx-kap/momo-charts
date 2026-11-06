// momo script indicators on the chart: fetch a script's source, compile it, run it through the
// sandbox host and hand the chart plain arrays. The chart never sees compiled code or the worker.
// Output from a script is data to be checked and drawn (docs/scripting.md, "Phase 3"): colours
// become hex strings built here, and text is only ever set with textContent by the callers.

import { LIBRARY, defFromMeta, failedDef, hydrate, registerScript, scriptKey } from "./indicators.js";
import { compile } from "./script/compile.js";
import { sharedHost } from "./script/host.js";
import { api } from "./util.js";

const compiled = new Map(); // script key → Promise of { ok, meta, code } | { ok: false, error }
const drafts = new Map();   // stored script id → the editor's text, shown in place of the head

async function storedSource(ind) {
  if (ind.version == null && drafts.has(ind.script)) return drafts.get(ind.script);
  const path = ind.version == null ? "" : `/versions/${ind.version}`;
  const response = await fetch(`/api/scripts/${ind.script}${path}`);
  if (response.status === 404) throw new Error("This script no longer exists.");
  if (!response.ok) throw new Error(`Couldn't load the script (${response.status}).`);
  return (await response.json()).source;
}

async function sourceOf(ind) {
  if (ind.library === undefined) return storedSource(ind);
  if (!LIBRARY.some((item) => item.key === ind.library)) throw new Error(`There is no ${ind.library} script.`);
  const response = await fetch(`/static/scripts/${ind.library}.momo`);
  if (!response.ok) throw new Error(`Couldn't load the ${ind.library} script (${response.status}).`);
  return response.text();
}

// A stored script's definition; the legend says when the chart shows the editor's draft.
function definition(ind, meta) {
  const def = defFromMeta(meta);
  if (ind.library !== undefined || ind.version != null || !drafts.has(ind.script)) return def;
  return { ...def, label: (params) => `${def.label(params)} · Draft` };
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
      registerScript(key, built.ok ? definition(ind, built.meta) : failedDef(ind, built.error));
      if (!built.ok && built.error.code === "L001" && ind.library === undefined) compiled.delete(key); // try again next time
      return built;
    }));
  }
  return compiled.get(key).then((built) => {
    if (built.ok && ind.params && ind.style) hydrate(ind, defFromMeta(built.meta));
    return built;
  });
}

// Charts next ask the server for this script's text: it has been saved.
export function forgetScript(id) {
  compiled.delete(`script:${id}@head`);
}

// Show the editor's text on charts in place of the head, or stop (null).
export function previewDraft(id, source) {
  if (source === null) drafts.delete(id);
  else drafts.set(id, source);
  forgetScript(id);
}

// The account's stored scripts: { id, name, head, favourite, in_trash, … }.
export const listScripts = async () => (await api("/api/scripts")).scripts;

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
  if (!reply.ok) return { ok: false, error: reply.error };
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

// The editor's text run once over `bars`, not on any chart: what it logged, how long it took, and
// whether every plot and signal came out empty. { ok: false, errors } if it doesn't compile.
export async function runSource(source, bars, chart) {
  const built = compile(source);
  if (!built.ok) return built;
  const reply = await sharedHost().run({ code: built.code, bars: columns(bars), inputs: {}, extra: { chart } });
  if (!reply.ok) return { ok: false, error: reply.error };
  const plots = Object.values(reply.plots).map((plot) => plot.values).filter((values) => values.length);
  const signals = Object.values(reply.signals);
  const empty = plots.length + signals.length > 0 && !plots.some((values) => values.some((v) => v === v)) && !signals.some((values) => values.some(Boolean));
  return { ok: true, ms: reply.ms, logs: reply.logs, empty };
}
