// momo script host: the page's side of the sandbox (docs/scripting.md, "run() and the worker").
// A small pool of sandbox workers (worker.js), request ids, a 250 ms limit per run (the worker is
// terminated and replaced, the run answers R401), a result cache, and a strict check of every
// answer before the page uses it: series arrive only as typed arrays of the bars' length, colours
// as packed integers, text capped. A worker that answers with anything else is treated as broken.
//
//   const host = createHost();
//   const result = await host.run({ code, bars, inputs, extra });   // never rejects
//   result.ok ? result.plots : result.error                          // { code, message, line, col, i }
//
// `bars` is { time, open, high, low, close, volume } as Float64Arrays. They are copied for the
// worker unless `transfer: true`, which hands them over (and empties them here). Results are
// shared between callers of the same cache key: read them, don't change them.

import { LIMITS } from "./runtime.js";

const COLUMNS = ["time", "open", "high", "low", "close", "volume"];
const SHAPES = ["triangle_up", "triangle_down", "dot", "square", "diamond", "arrow_up", "arrow_down", "flag"];
const LINE_STYLES = ["solid", "dashed", "dotted"];
const FORMATS = ["price", "percent", "volume", "number"];
const MAX_POOL = 4;
const MAX_BARS = 1_000_000;
const START_MS = 10_000;           // a worker that isn't ready by then is broken
const CACHED = 64;                 // results kept
const MAX_MARKERS = 500_000;
const MAX_SIGNALS = 256;
const ERROR_TEXT = 400;

export const WORKER_URL = new URL("./worker.js", import.meta.url);

const fail = (code, message, at = {}) => ({
  ok: false, error: { code, message: String(message).slice(0, ERROR_TEXT), line: at.line ?? 1, col: at.col ?? 1, i: at.i ?? -1 },
});
export const stopped = () => fail("R401", "Stopped: took too long");

// ---- checking what comes back ----------------------------------------------------------------------

class Refused extends Error {}
const refuse = (what) => {
  throw new Refused(what);
};
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v);
const isInt = (v) => Number.isInteger(v);
const isColor = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const isText = (v) => typeof v === "string" && v.length <= LIMITS.string;
const isKey = (v) => typeof v === "string" && v.length >= 1 && v.length <= 64 && v !== "__proto__";
const isList = (v, max) => Array.isArray(v) && v.length <= max;

// The typed array must be the declared type, whole (its own buffer, not a window on a shared one)
// and `length` long (or one of several allowed lengths).
function series(v, Type, lengths, what) {
  if (!(v instanceof Type) || v.constructor !== Type) refuse(`${what} should be a ${Type.name}`);
  if (!lengths.includes(v.length)) refuse(`${what} has ${v.length} values, expected ${lengths.join(" or ")}`);
  if (v.byteOffset !== 0 || v.byteLength !== v.buffer.byteLength) refuse(`${what} is a window on a bigger buffer`);
  return v;
}

// Returns a fresh result built only from fields that passed: nothing from the worker's object is
// passed on by reference except the typed arrays.
export function checkResult(reply, n) {
  if (!isPlain(reply) || reply.ok !== true) refuse("not a result");
  const full = [n];
  const plotLengths = [0, n];
  if (!Number.isFinite(reply.ms) || reply.ms < 0) refuse("ms");
  const out = { ok: true, ms: reply.ms, plots: Object.create(null), markers: [], levels: [], drawings: { lines: [], boxes: [], labels: [] }, stats: [], signals: Object.create(null), logs: [] };

  if (!isPlain(reply.plots)) refuse("plots");
  const keys = Object.keys(reply.plots);
  if (keys.length > LIMITS.plots) refuse("too many plots");
  for (const key of keys) {
    if (!isKey(key)) refuse("a plot key");
    const p = reply.plots[key];
    if (!isPlain(p)) refuse(`plot ${key}`);
    const plot = { values: series(p.values, Float64Array, plotLengths, `plot ${key}`) };
    if (p.colors !== undefined) plot.colors = series(p.colors, Uint32Array, full, `colors of ${key}`);
    out.plots[key] = plot;
  }

  if (!isList(reply.markers, MAX_MARKERS)) refuse("markers");
  for (const m of reply.markers) {
    if (!isPlain(m) || !isKey(m.key) || !isInt(m.i) || m.i < 0 || m.i >= n || !Number.isFinite(m.price)
      || !SHAPES.includes(m.shape) || !isColor(m.color) || !isText(m.text)) refuse("a marker");
    out.markers.push({ key: m.key, i: m.i, price: m.price, shape: m.shape, color: m.color, text: m.text });
  }

  if (!isList(reply.levels, LIMITS.plots)) refuse("levels");
  for (const l of reply.levels) {
    if (!isPlain(l) || !isKey(l.key) || !Number.isFinite(l.price) || !isColor(l.color) || !LINE_STYLES.includes(l.style)
      || (l.title !== undefined && l.title !== null && !isText(l.title))) refuse("a level");
    out.levels.push({ key: l.key, price: l.price, color: l.color, style: l.style, title: l.title ?? null });
  }

  // Lines, boxes and labels arrive with phase 6, which adds their checks here.
  if (!isPlain(reply.drawings) || !["lines", "boxes", "labels"].every((k) => isList(reply.drawings[k], 0))) refuse("drawings");

  if (!isList(reply.stats, LIMITS.plots)) refuse("stats");
  for (const s of reply.stats) {
    const valueOk = typeof s?.value === "number" || typeof s?.value === "boolean" || isText(s?.value);
    const formatOk = s?.format === null || s?.format === undefined || FORMATS.includes(s?.format);
    if (!isPlain(s) || !isText(s.title) || !valueOk || !isColor(s.color) || !formatOk) refuse("a stat");
    out.stats.push({ title: s.title, value: s.value, color: s.color, format: s.format ?? null });
  }

  if (!isPlain(reply.signals)) refuse("signals");
  const names = Object.keys(reply.signals);
  if (names.length > MAX_SIGNALS) refuse("too many signals");
  for (const name of names) {
    if (!isKey(name)) refuse("a signal name");
    const a = reply.signals[name];
    out.signals[name] = series(a, a instanceof Uint8Array ? Uint8Array : Float64Array, full, `signal ${name}`);
  }

  if (!isList(reply.logs, LIMITS.logs)) refuse("logs");
  for (const l of reply.logs) {
    if (!isPlain(l) || !isInt(l.i) || l.i < 0 || l.i >= n || !isText(l.text)) refuse("a log line");
    out.logs.push({ i: l.i, text: l.text });
  }

  if (reply.barColors !== undefined) out.barColors = series(reply.barColors, Uint32Array, full, "barColors");
  if (reply.bgColors !== undefined) out.bgColors = series(reply.bgColors, Uint32Array, full, "bgColors");
  return out;
}

// { ok: false, error } from a worker, checked the same way.
function checkError(reply) {
  const e = reply.error;
  if (!isPlain(e) || typeof e.code !== "string" || !/^R\d{3}$/.test(e.code) || typeof e.message !== "string") refuse("an error");
  const num = (v, min) => (isInt(v) && v >= min ? v : min);
  return fail(e.code, e.message, { line: num(e.line, 1), col: num(e.col, 1), i: num(e.i, -1) });
}

// ---- cache key -------------------------------------------------------------------------------------

// cyrb53: a quick 53-bit string hash. A cache key, not a security check.
export function hash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// What identifies a set of bars: its length, ends and a sample of values in between.
export function fingerprint(bars) {
  const n = bars.close.length;
  const parts = [n];
  const step = Math.max(1, Math.floor(n / 16));
  for (const c of COLUMNS) {
    const a = bars[c];
    for (let i = 0; i < n; i += step) parts.push(a[i]);
    if (n) parts.push(a[n - 1]);
  }
  return hash(parts.join(","));
}

const stable = (v) => JSON.stringify(v, (_k, x) => (isPlain(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

function cacheKey(req) {
  const extra = req.extra ?? {};
  const more = [];
  for (const group of ["tf", "symbols"]) {
    for (const k of Object.keys(extra[group] ?? {}).sort()) more.push(`${group}:${k}:${fingerprint(extra[group][k])}`);
  }
  return [hash(req.code), req.code.length, stable(req.inputs ?? {}), req.barsKey ?? fingerprint(req.bars),
    stable(extra.chart ?? null), stable(extra.data ?? null), more.join("|")].join("#");
}

// ---- the pool --------------------------------------------------------------------------------------

export function createHost({ size = 1, url = WORKER_URL, timeoutMs = LIMITS.runMs } = {}) {
  const limit = Math.min(MAX_POOL, Math.max(1, size));
  const slots = [];               // { worker, ready, job, timer, starting }
  const queue = [];               // { id, key, message, transfer, n, resolve }
  const cache = new Map();        // key → result, oldest first
  const counts = { runs: 0, hits: 0, spawns: 0, timeouts: 0, crashes: 0, refused: 0 };
  let nextId = 1;
  let broken = null;              // why workers can't start, until the next run tries again
  let closed = false;

  function remember(key, result) {
    cache.delete(key);
    cache.set(key, result);
    if (cache.size > CACHED) cache.delete(cache.keys().next().value);
  }

  function finish(slot, result, { keep = true } = {}) {
    const job = slot.job;
    slot.job = null;
    clearTimeout(slot.timer);
    if (keep && job.key) remember(job.key, result);
    job.resolve(result);
    pump();
  }

  function drop(slot) {
    clearTimeout(slot.timer);
    clearTimeout(slot.starting);
    slot.worker?.terminate();
    slot.worker = null;
    slot.ready = false;
    const at = slots.indexOf(slot);
    if (at >= 0) slots.splice(at, 1);
  }

  // The worker is stopped or untrusted: end it, answer its run, and start a replacement.
  function retire(slot, result) {
    const job = slot.job;
    slot.job = null;
    drop(slot);
    if (job) job.resolve(result);
    if (!closed) {
      const next = { worker: null, ready: false, job: null, timer: 0, starting: 0 };
      slots.push(next);
      spawn(next);
    }
    pump();
  }

  function spawn(slot) {
    counts.spawns++;
    let worker;
    try {
      worker = new Worker(url, { type: "module", name: "momo-script" });
    } catch (e) {
      return startFailed(slot, `The sandbox could not start (${e?.name ?? "error"}).`);
    }
    slot.worker = worker;
    slot.ready = false;
    slot.starting = setTimeout(() => slot.worker === worker && startFailed(slot, "The sandbox did not start in time."), START_MS);
    worker.onmessage = (event) => slot.worker === worker && onReply(slot, event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      if (slot.worker === worker) lost(slot, "The sandbox stopped unexpectedly.");
    };
    worker.onmessageerror = () => slot.worker === worker && lost(slot, "The sandbox sent something unreadable.");
  }

  function startFailed(slot, message) {
    broken = message;
    counts.crashes++;
    const result = fail("R405", message);
    if (slot.job) { slot.job.resolve(result); slot.job = null; }
    drop(slot);
    while (queue.length) queue.shift().resolve(result);   // not retried in a loop; the next run() tries again
  }

  function lost(slot, message) {
    if (!slot.ready) return startFailed(slot, message);
    counts.crashes++;
    retire(slot, fail("R405", message));
  }

  function onReply(slot, data) {
    if (!slot.ready) {
      if (isPlain(data) && data.ready === true) {
        slot.ready = true;
        broken = null;
        clearTimeout(slot.starting);
        pump();
      } else if (isPlain(data) && typeof data.fatal === "string") {
        startFailed(slot, data.fatal);
      } else {
        startFailed(slot, "The sandbox said something unexpected while starting.");
      }
      return;
    }
    const job = slot.job;
    if (!job || !isPlain(data) || data.id !== job.id) return;   // not the answer we're waiting for
    let result;
    try {
      result = data.ok === true ? checkResult(data, job.n) : checkError(data);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      counts.refused++;
      // A worker that answers wrongly is not trusted again.
      const bad = fail("R405", `The sandbox's answer failed the page's checks (${e.message}).`);
      slot.job = null;
      job.resolve(bad);
      return retire(slot, bad);
    }
    finish(slot, result, { keep: result.ok || result.error.code !== "R405" });
  }

  // Hands queued runs to idle ready workers; starts workers up to the pool size.
  function pump() {
    if (closed) return;
    for (const slot of slots) {
      if (!queue.length) return;
      if (slot.ready && !slot.job) dispatch(slot, queue.shift());
    }
    // One booting worker per waiting run, up to the pool size.
    while (queue.length > slots.filter((s) => !s.job).length && slots.length < limit) {
      const slot = { worker: null, ready: false, job: null, timer: 0, starting: 0 };
      slots.push(slot);
      spawn(slot);
    }
  }

  function dispatch(slot, job) {
    slot.job = job;
    // The clock starts when the run is sent to a worker that is ready, not while it queued or booted.
    slot.timer = setTimeout(() => {
      counts.timeouts++;
      retire(slot, stopped());
    }, timeoutMs);
    try {
      slot.worker.postMessage(job.message, job.transfer);
    } catch {
      lost(slot, "The run could not be sent to the sandbox.");
    }
  }

  function run(request) {
    counts.runs++;
    let n;
    try {
      n = checkRequest(request);
    } catch (e) {
      return Promise.resolve(fail("R405", e.message));
    }
    if (closed) return Promise.resolve(fail("R405", "The sandbox is shut down."));
    const key = cacheKey(request);
    const hit = cache.get(key);
    if (hit) {
      counts.hits++;
      remember(key, hit);
      return Promise.resolve(hit);
    }
    const bars = {};
    for (const c of COLUMNS) bars[c] = request.transfer ? request.bars[c] : request.bars[c].slice();
    const message = { id: nextId++, op: "run", code: request.code, codeHash: hash(request.code), bars, inputs: request.inputs ?? {}, extra: request.extra ?? {} };
    const transfer = COLUMNS.map((c) => bars[c].buffer);
    return new Promise((resolve) => {
      queue.push({ id: message.id, key, message, transfer, n, resolve });
      pump();
    });
  }

  function checkRequest(request) {
    if (!isPlain(request) || typeof request.code !== "string") throw new TypeError("run() takes { code, bars, inputs, extra }");
    const b = request.bars;
    if (!isPlain(b)) throw new TypeError("bars should be an object of Float64Arrays");
    const n = b.close instanceof Float64Array ? b.close.length : -1;
    if (n < 0 || n > MAX_BARS) throw new TypeError("bars should be Float64Arrays of at most 1,000,000 bars");
    for (const c of COLUMNS) {
      if (!(b[c] instanceof Float64Array) || b[c].length !== n) throw new TypeError(`bars.${c} should be a Float64Array of ${n} values`);
    }
    for (const field of ["inputs", "extra"]) {
      if (request[field] !== undefined && !isPlain(request[field])) throw new TypeError(`${field} should be an object`);
    }
    return n;
  }

  return {
    run,
    // Starts the first worker now, so the first run doesn't pay for it.
    warm() {
      if (!slots.length && !closed) {
        const slot = { worker: null, ready: false, job: null, timer: 0, starting: 0 };
        slots.push(slot);
        spawn(slot);
      }
    },
    stats: () => ({ ...counts, workers: slots.length, cached: cache.size, queued: queue.length, broken }),
    clear: () => cache.clear(),
    close() {
      closed = true;
      for (const slot of [...slots]) retire(slot, fail("R405", "The sandbox is shut down."));
      slots.length = 0;
      while (queue.length) queue.shift().resolve(fail("R405", "The sandbox is shut down."));
    },
  };
}

let shared = null;
export const sharedHost = () => shared ?? (shared = createHost());
