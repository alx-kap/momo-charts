// momo script sandbox: the dedicated worker compiled scripts run in (second wall, docs/scripting.md).
// The server sends this file with `Content-Security-Policy: default-src 'none'; script-src 'self'
// 'unsafe-eval'`, so the worker has no fetch, XHR or WebSocket whatever the code does. On top of
// that, before any code arrives, it hides every network, storage, thread and messaging global
// (shadowing them on the global object and deleting them from its prototype chain, because
// `delete self.fetch` alone leaves the prototype's copy), freezes the built-in prototypes and
// the runtime, and takes the message port for itself: the page's `postMessage` and
// `addEventListener` are captured here and removed from the global, so run code can't send
// anything or listen for later requests. If any of that can't be verified the worker says so and
// refuses every run. Nothing in this file is a test hook: the page sends `code`, the worker runs it.
//
// page → worker  { id, op: "run", code, bars, inputs, extra }  (docs/scripting.md, "run() and the worker")
// worker → page  { ready: true } | { fatal } once, then { id, ok, ... } per run

import * as rt from "./runtime.js";

const MAX_CODE = 2_000_000;        // characters of generated code (the source is capped at 100 KB)
const MAX_BARS = 1_000_000;
const COLUMNS = ["time", "open", "high", "low", "close", "volume"];
const COMPILED = 16;               // compiled functions kept, by code text

// The port and the few things the loop needs, taken before the globals go.
const send = self.postMessage.bind(self);
const listen = self.addEventListener.bind(self);
const now = performance.now.bind(performance);
const Compile = Function;

const HIDDEN = [
  // network
  "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "WebTransport", "EventSource", "importScripts",
  "RTCPeerConnection", "Request", "Response", "Headers", "navigator", "WorkerNavigator",
  // storage
  "indexedDB", "IDBFactory", "caches", "CacheStorage", "BroadcastChannel", "localStorage", "sessionStorage",
  "cookieStore", "StorageManager", "FileSystemHandle", "webkitRequestFileSystem",
  // threads, messaging and timing channels
  "Worker", "SharedWorker", "MessageChannel", "MessagePort", "Notification", "WebAssembly",
  "SharedArrayBuffer", "Atomics", "performance", "Performance",
  // the port itself (captured above)
  "postMessage", "addEventListener", "removeEventListener", "dispatchEvent", "onmessage", "onmessageerror", "close",
];

function hide(name) {
  for (let o = globalThis; o; o = Object.getPrototypeOf(o)) {
    if (Object.prototype.hasOwnProperty.call(o, name)) {
      try { delete o[name]; } catch { /* checked below */ }
    }
  }
  try {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false, enumerable: false });
  } catch { /* checked below */ }
}

// Names that are still reachable on the global or anywhere up its prototype chain.
function leaks() {
  const found = [];
  for (const name of HIDDEN) {
    if (globalThis[name] !== undefined) found.push(name);
    else for (let o = Object.getPrototypeOf(globalThis); o; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, name)) found.push(`${name} (prototype)`);
    }
  }
  return found;
}

function freeze(value, seen = new WeakSet(), depth = 0) {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value) || ArrayBuffer.isView(value)) return;
  seen.add(value);
  Object.freeze(value);
  if (depth > 3) return;
  if (typeof value === "function" && value.prototype) freeze(value.prototype, seen, depth + 1);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d && "value" in d) freeze(d.value, seen, depth + 1);
  }
}

function lockdown() {
  // RunError's constructor assigns `this.name`, which throws once the prototypes are frozen (an
  // inherited read-only property can't be assigned to). An accessor that defines the property on
  // the new error instead keeps it working on a frozen prototype.
  Object.defineProperty(rt.RunError.prototype, "name", {
    get: () => "RunError",
    set(value) { Object.defineProperty(this, "name", { value, writable: true, configurable: true }); },
    configurable: true,
  });
  for (const name of HIDDEN) hide(name);
  for (const o of [
    Object, Function, Array, String, Number, Boolean, Symbol, BigInt, Math, JSON, Reflect, Promise, Map, Set,
    WeakMap, WeakSet, WeakRef, RegExp, Date, Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError,
    URIError, AggregateError, ArrayBuffer, DataView, Intl, Object.getPrototypeOf(Float64Array),
    Float64Array, Float32Array, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array,
    Uint32Array, EventTarget, Object.getPrototypeOf(globalThis), globalThis.constructor,
  ]) freeze(o);
  for (const exported of Object.values(rt)) freeze(exported);  // a module namespace can't be frozen itself
  // Run code can't create a global that the next run would see. Best effort: the language has no
  // way to write one, and a browser that won't freeze its global object still has every wall above.
  try { Object.freeze(globalThis); } catch { /* see above */ }
  return leaks();
}

// ---- runs ------------------------------------------------------------------------------------------

const compiled = new Map();

function functionFor(code) {
  let fn = compiled.get(code);
  if (!fn) {
    fn = new Compile("rt", "bars", "inputs", "extra", code);
    if (compiled.size >= COMPILED) compiled.delete(compiled.keys().next().value);
    compiled.set(code, fn);
  }
  return fn;
}

const isObject = (v) => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

function request(msg) {
  if (!isObject(msg) || msg.op !== "run" || !Number.isSafeInteger(msg.id)) throw new TypeError("not a run request");
  if (typeof msg.code !== "string" || msg.code.length > MAX_CODE) throw new TypeError("code should be text");
  if (!isObject(msg.bars)) throw new TypeError("bars should be an object");
  const n = msg.bars.close instanceof Float64Array ? msg.bars.close.length : -1;
  if (n < 0 || n > MAX_BARS) throw new TypeError("bars should be typed arrays of at most 1,000,000 bars");
  for (const c of COLUMNS) {
    if (!(msg.bars[c] instanceof Float64Array) || msg.bars[c].length !== n) throw new TypeError(`bars.${c} should be a Float64Array of ${n}`);
  }
  const inputs = msg.inputs === undefined ? {} : msg.inputs;
  const extra = msg.extra === undefined ? {} : msg.extra;
  if (!isObject(inputs) || !isObject(extra)) throw new TypeError("inputs and extra should be objects");
  return { id: msg.id, code: msg.code, bars: msg.bars, inputs, extra };
}

const failure = (id, code, message, at = {}) => ({
  id, ok: false, error: { code, message, line: at.line ?? 1, col: at.col ?? 1, i: at.i ?? -1 },
});

// Every typed array in a result, with the buffers to transfer. A view over part of a bigger
// buffer is copied first so the transfer carries exactly what it should.
function pack(result) {
  const buffers = new Set();
  const own = (a) => {
    if (!ArrayBuffer.isView(a)) return a;
    const whole = a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && a.buffer instanceof ArrayBuffer;
    const out = whole ? a : a.slice();
    buffers.add(out.buffer);
    return out;
  };
  for (const key of Object.keys(result.plots)) {
    const p = result.plots[key];
    p.values = own(p.values);
    if (p.colors) p.colors = own(p.colors);
  }
  for (const key of Object.keys(result.signals)) result.signals[key] = own(result.signals[key]);
  if (result.barColors) result.barColors = own(result.barColors);
  if (result.bgColors) result.bgColors = own(result.bgColors);
  return [...buffers];
}

function run(data) {
  let req;
  try {
    req = request(data);
  } catch (e) {
    return { reply: failure(Number.isSafeInteger(data?.id) ? data.id : -1, "R405", `The sandbox refused the request: ${e.message}`) };
  }
  const started = now();
  try {
    const result = functionFor(req.code)(rt, req.bars, req.inputs, req.extra);
    const ms = now() - started;
    const transfer = pack(result);
    return { reply: { id: req.id, ok: true, ms, ...result }, transfer };
  } catch (e) {
    if (e instanceof rt.RunError) return { reply: failure(req.id, e.code, e.message, e) };
    return { reply: failure(req.id, "R405", `The script failed inside the runtime (${e instanceof Error ? e.name : "error"}).`) };
  }
}

function onMessage(event) {
  const { reply, transfer = [] } = run(event.data);
  try {
    send(reply, transfer);
  } catch {
    send(failure(reply.id, "R405", "The sandbox could not send the result."));
  }
}

const problems = lockdown();
if (problems.length) {
  send({ fatal: `The sandbox could not hide: ${problems.join(", ")}` });
} else {
  listen("message", onMessage);
  send({ ready: true });
}
