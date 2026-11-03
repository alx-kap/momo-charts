// momo script runtime: what compiled code calls. The `ta` steppers (one object per call site,
// O(1) work per bar and no allocation), colours, list helpers, input readers, calendar arrays
// and the limits. No DOM and no globals beyond Math and typed arrays, so it runs in node tests,
// the sandbox worker and the page alike.
//
// Steppers: `ta.sma(at, length)` builds one (`at` is [line, col] for errors); `step(...)` takes
// this bar's values and returns the result (NaN for na). Several outputs are read from `o0`,
// `o1`, `o2` after `step`. A window that holds an na gives na. ema, rma and rsi skip an na and
// keep their state. Constructors take the call's fixed arguments in the catalogue's order.

import { formatColor, packColor, parseColor, withAlpha } from "./catalog.js";

export { formatColor, packColor, parseColor, withAlpha };

export const LIMITS = Object.freeze({
  source: 100_000, loopSteps: 1_000_000, list: 10_000, drawings: 500, plots: 64, string: 200,
  runMs: 250, length: 5000, logs: 500, calls: 400,
});

export class RunError extends Error {
  constructor(code, message, at = [1, 1], i = -1) {
    super(message);
    this.name = "RunError";
    this.code = code;
    this.line = at[0];
    this.col = at[1];
    this.i = i;
  }
}

export const stepLimit = (at, i) => {
  throw new RunError("R402", `This loop ran more than ${LIMITS.loopSteps.toLocaleString("en-US")} steps in one run.`, at, i);
};

// ---- numbers ------------------------------------------------------------------------------

export const div = (a, b) => (b === 0 ? NaN : a / b);
export const mod = (a, b) => (b === 0 ? NaN : ((a % b) + b) % b);
export const pow = (a, b) => {
  const r = Math.pow(a, b);
  return r - r === 0 ? r : NaN;
};
export const log = (x) => (x > 0 ? Math.log(x) : NaN);
export const round = (x, digits = 0) => {
  if (!digits) return Math.round(x);
  const k = 10 ** Math.min(15, Math.max(0, digits));
  return Math.round(x * k) / k;
};
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const nz = (x, replace) => (x !== x ? replace : x);
export const ne = (a, b) => a !== b && a === a && b === b;
export const isna = (x) => x !== x;
// History: the value k bars before bar i of an array that holds every bar so far.
export const at = (array, i, k) => {
  const j = i - k;
  return k >= 0 && j >= 0 && Number.isInteger(j) ? array[j] : NaN;
};
export const T = (x) => x === x && x !== 0;                 // a number as true/false
export const F = (x) => (x - x === 0 ? x : NaN);            // infinity is na too

// ---- colours: packed 0xRRGGBBAA, 0 is none -----------------------------------------------------

const byte = (v) => Math.min(255, Math.max(0, Math.round(v)));
export const rgb = (r, g, b, alpha) => {
  const a = alpha === undefined ? 100 : alpha;
  return r - r === 0 && g - g === 0 && b - b === 0 && a - a === 0 ? packColor(byte(r), byte(g), byte(b), byte((a * 255) / 100)) : 0;
};
export const alpha = (color, pct) => (color && color - color === 0 && pct - pct === 0 ? withAlpha(color >>> 0, pct) : 0);

// ---- text -------------------------------------------------------------------------------------

const SPEC = /^(,)?(?:\.(\d+))?([f%])?$/;

export function fmt(v, spec = "") {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v - v !== 0) return "na";
  const m = SPEC.exec(spec);
  if (!m || !spec) return trim(v);
  const [, comma, digits, kind] = m;
  const scaled = kind === "%" ? v * 100 : v;
  const places = digits !== undefined ? Number(digits) : kind ? 2 : null;
  let text = places === null ? trim(scaled) : scaled.toFixed(Math.min(places, 20));
  if (comma) {
    const [whole, rest] = text.split(".");
    text = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (rest === undefined ? "" : `.${rest}`);
  }
  return kind === "%" ? `${text}%` : text;
}

const trim = (v) => (Math.abs(v) < 1e15 ? v.toFixed(6).replace(/\.?0+$/, "") || "0" : String(v));
export const fmtColor = (c) => formatColor(c >>> 0) || "none";
export const clip = (s) => (s.length > LIMITS.string ? s.slice(0, LIMITS.string) : s);

// ---- lists --------------------------------------------------------------------------------------

export function lpush(xs, v, at, i) {
  if (xs.length >= LIMITS.list) throw new RunError("R403", `A list can hold at most ${LIMITS.list.toLocaleString("en-US")} items.`, at, i);
  xs.push(v);
}
export const lpop = (xs) => (xs.length ? xs.pop() : NaN);
export function lremove(xs, i) {
  const k = i < 0 ? xs.length + i : i;
  if (Number.isInteger(k) && k >= 0 && k < xs.length) xs.splice(k, 1);
}
export function lget(xs, i) {
  const k = i < 0 ? xs.length + i : i;
  return Number.isInteger(k) && k >= 0 && k < xs.length ? xs[k] : NaN;
}
function fold(xs, start, f) {
  let acc = start;
  let seen = 0;
  for (let j = 0; j < xs.length; j++) if (xs[j] === xs[j]) { acc = f(acc, xs[j]); seen++; }
  return seen ? acc : NaN;
}
export const lsum = (xs) => fold(xs, 0, (a, b) => a + b);
export const lmax = (xs) => fold(xs, -Infinity, Math.max);
export const lmin = (xs) => fold(xs, Infinity, Math.min);
export function lavg(xs) {
  let sum = 0;
  let seen = 0;
  for (let j = 0; j < xs.length; j++) if (xs[j] === xs[j]) { sum += xs[j]; seen++; }
  return seen ? sum / seen : NaN;
}

// ---- inputs: the page's values, checked again here ----------------------------------------------

const SOURCES = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"];
const own = (inputs, key) => (inputs && Object.hasOwn(inputs, key) ? inputs[key] : undefined);

export function inputNumber(inputs, key, def, min, max, whole) {
  let v = own(inputs, key);
  if (typeof v !== "number" || v - v !== 0) v = def;
  if (whole) v = Math.trunc(v);
  if (min !== null && v < min) v = min;
  if (max !== null && v > max) v = max;
  return v;
}
export const inputBool = (inputs, key, def) => (typeof own(inputs, key) === "boolean" ? own(inputs, key) : def);
export const inputChoice = (inputs, key, def, options) => (options.includes(own(inputs, key)) ? own(inputs, key) : def);
export function inputColor(inputs, key, def) {
  const v = own(inputs, key);
  if (typeof v === "number" && v - v === 0) return v >>> 0;
  if (typeof v === "string") { const c = parseColor(v); if (c !== null) return c; }
  return parseColor(def) ?? 0;
}
export function inputSource(bars, inputs, key, def) {
  const name = own(inputs, key);
  return sourceSeries(bars, SOURCES.includes(name) ? name : def);
}

const cache = new WeakMap();

// open high low close volume time come straight from the bars; hl2 hlc3 ohlc4 and bar_index are
// worked out once per run, only when the script reads them.
export function sourceSeries(bars, name) {
  switch (name) {
    case "open": case "high": case "low": case "close": case "volume": case "time": return bars[name];
    default: {
      let derived = cache.get(bars);
      if (!derived) { derived = Object.create(null); cache.set(bars, derived); }
      if (!derived[name]) derived[name] = build(bars, name);
      return derived[name];
    }
  }
}

function build(bars, name) {
  const n = bars.close.length;
  const out = new Float64Array(n);
  const { open, high, low, close } = bars;
  for (let i = 0; i < n; i++) {
    out[i] = name === "hl2" ? (high[i] + low[i]) / 2
      : name === "hlc3" ? (high[i] + low[i] + close[i]) / 3
        : name === "ohlc4" ? (open[i] + high[i] + low[i] + close[i]) / 4
          : i;
  }
  return out;
}

// ---- calendar: bar times are New York wall-clock seconds --------------------------------------------

export function chart(extra) {
  const interval = String((extra && extra.chart && extra.chart.interval) || "D");
  const ticker = String((extra && extra.chart && extra.chart.ticker) || "").slice(0, 32);
  return {
    ticker,
    intraday: /[mh]$/.test(interval), daily: /D$/.test(interval), weekly: /W$/.test(interval), monthly: /M$/.test(interval),
  };
}

export function calendar(time, intraday) {
  const n = time.length;
  const year = new Float64Array(n);
  const month = new Float64Array(n);
  const day = new Float64Array(n);
  const dayofweek = new Float64Array(n);
  const hour = new Float64Array(n);
  const minute = new Float64Array(n);
  const regular = new Uint8Array(n);
  const newDay = new Uint8Array(n);
  let previous = NaN;
  for (let i = 0; i < n; i++) {
    const t = time[i];
    const days = Math.floor(t / 86400);
    // days → civil date (Howard Hinnant's algorithm)
    const z = days + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    year[i] = yoe + era * 400 + (m <= 2 ? 1 : 0);
    month[i] = m;
    day[i] = d;
    dayofweek[i] = ((days + 3) % 7 + 7) % 7 + 1;
    const seconds = t - days * 86400;
    hour[i] = Math.floor(seconds / 3600);
    minute[i] = Math.floor((seconds % 3600) / 60);
    const minutes = Math.floor(seconds / 60);
    regular[i] = intraday ? (minutes >= 570 && minutes < 960 ? 1 : 0) : 1;
    newDay[i] = days !== previous ? 1 : 0;
    previous = days;
  }
  return { year, month, day, dayofweek, hour, minute, regular, newDay };
}

// ---- outputs ----------------------------------------------------------------------------------------

export const f64 = (n) => new Float64Array(n).fill(NaN);

export function mark(list, key, shape, i, price, color, text) {
  if (price - price !== 0) return;
  list.push({ key, i, price, shape, color: color >>> 0, text: clip(text) });
}
export function level(list, key, price, color, style, title) {
  if (price - price === 0) list.push({ key, price, color: color >>> 0, style, title });
}
export function stat(list, title, value, color, format) {
  list.push({ title, value: typeof value === "number" ? F(value) : value, color: color >>> 0, format });
}
export function logLine(list, i, args) {
  if (list.length < LIMITS.logs) list.push({ i, text: clip(args.map((a) => fmt(a)).join(" ")) });
}

// plots: [key, values, colors|null]; signals: [name, array]
export function result({ plots, markers, barColors, bgColors, levels, stats, signals, logs }) {
  const plotMap = Object.create(null);
  for (const [key, values, colors] of plots) plotMap[key] = colors ? { values, colors } : { values };
  const signalMap = Object.create(null);
  for (const [name, array] of signals) signalMap[name] = array;
  const out = {
    plots: plotMap, markers, levels, drawings: { lines: [], boxes: [], labels: [] }, stats, signals: signalMap, logs,
  };
  if (barColors) out.barColors = barColors;
  if (bgColors) out.bgColors = bgColors;
  return out;
}

// ---- ta steppers --------------------------------------------------------------------------------

function whole(at, name, v, min = 1) {
  if (!(v >= min) || v !== Math.floor(v) || v > LIMITS.length) {
    throw new RunError("R404", `${name} must be a whole number from ${min} to ${LIMITS.length}, not ${v}.`, at);
  }
  return v;
}

const REFRESH = 1024;
const NEARLY_FLAT = 1e-8;

const pow2 = (n) => {
  let c = 2;
  while (c < n) c *= 2;
  return c;
};

// The last n values. `quiet` counts the values since the last na, so a window is clean when
// quiet >= n. The buffer holds a power of two, so positions wrap with a mask, not a division.
class Ring {
  constructor(n) {
    this.n = n;
    this.mask = pow2(n + 1) - 1;
    this.buf = new Float64Array(this.mask + 1);
    this.i = 0;
    this.quiet = 0;
  }

  // Adds x; returns the value that fell out of the window (NaN while it was filling).
  push(x) {
    const i = this.i;
    const old = i >= this.n ? this.buf[(i - this.n) & this.mask] : NaN;
    this.buf[i & this.mask] = x;
    this.quiet = x === x ? this.quiet + 1 : 0;
    this.i = i + 1;
    return old;
  }

  get ready() { return this.quiet >= this.n; }

  // Value k bars ago (0 is the newest).
  at(k) { return this.buf[(this.i - 1 - k) & this.mask]; }
}

// Running sum of a full, clean window, updated in O(1). `fresh` counts updates since the sum
// was last built from the ring (-1: not valid yet), so it is rebuilt every REFRESH bars and
// after an na leaves the window. `push` returns whether the window is full and clean.
class SumWindow extends Ring {
  constructor(n) {
    super(n);
    this.inv = 1 / n;
    this.sum = 0;
    this.fresh = -1;
  }

  push(x) {
    const n = this.n;
    const i = this.i;
    const buf = this.buf;
    const old = buf[(i - n) & this.mask];
    buf[i & this.mask] = x;
    this.i = i + 1;
    if (x !== x) { this.quiet = 0; this.fresh = -1; return false; }
    const quiet = this.quiet + 1;
    this.quiet = quiet;
    if (quiet < n) return false;
    const fresh = this.fresh;
    if (fresh >= 0 && fresh < REFRESH) {
      this.fresh = fresh + 1;
      this.sum += x - old;
    } else {
      this.rebuild();
    }
    return true;
  }

  rebuild() {
    const first = this.i - this.n;
    let sum = 0;
    for (let k = 0; k < this.n; k++) sum += this.buf[(first + k) & this.mask];
    this.sum = sum;
    this.fresh = 0;
  }
}

// Also the sum of squared deviations from the mean, by Welford's running update.
class M2Window extends SumWindow {
  constructor(n) { super(n); this.m2 = 0; }

  push(x) {
    const n = this.n;
    const i = this.i;
    const buf = this.buf;
    const old = buf[(i - n) & this.mask];
    buf[i & this.mask] = x;
    this.i = i + 1;
    if (x !== x) { this.quiet = 0; this.fresh = -1; return false; }
    const quiet = this.quiet + 1;
    this.quiet = quiet;
    if (quiet < n) return false;
    const fresh = this.fresh;
    if (fresh >= 0 && fresh < REFRESH) {
      this.fresh = fresh + 1;
      const inv = this.inv;
      const prevMean = this.sum * inv;
      const sum = this.sum + x - old;
      this.sum = sum;
      const mean = sum * inv;
      const m2 = this.m2 + (x - old) * (x - mean + old - prevMean);
      this.m2 = m2;
      // The running update loses precision when the window is nearly flat (its stdev under
      // 0.01% of its mean); work it out from scratch then, as a two-pass sum would.
      if (m2 < NEARLY_FLAT * sum * mean) this.rebuild();
    } else {
      this.rebuild();
    }
    return true;
  }

  rebuild() {
    super.rebuild();
    const first = this.i - this.n;
    const mean = this.sum * this.inv;
    let m2 = 0;
    for (let k = 0; k < this.n; k++) m2 += (this.buf[(first + k) & this.mask] - mean) ** 2;
    this.m2 = m2;
  }
}

// Also the weighted sum (the oldest value counts 1, the newest n).
class WeightedWindow extends SumWindow {
  constructor(n) { super(n); this.wsum = 0; }

  push(x) {
    const n = this.n;
    const i = this.i;
    const buf = this.buf;
    const old = buf[(i - n) & this.mask];
    buf[i & this.mask] = x;
    this.i = i + 1;
    if (x !== x) { this.quiet = 0; this.fresh = -1; return false; }
    const quiet = this.quiet + 1;
    this.quiet = quiet;
    if (quiet < n) return false;
    const fresh = this.fresh;
    if (fresh >= 0 && fresh < REFRESH) {
      this.fresh = fresh + 1;
      this.wsum = this.wsum - this.sum + n * x;
      this.sum += x - old;
    } else {
      this.rebuild();
    }
    return true;
  }

  rebuild() {
    super.rebuild();
    const first = this.i - this.n;
    let wsum = 0;
    for (let k = 0; k < this.n; k++) wsum += (k + 1) * this.buf[(first + k) & this.mask];
    this.wsum = wsum;
  }
}

// Highest (sign 1) or lowest (sign -1) over the last n values, with a monotonic deque of the
// candidates (indices into the stream) kept in a power-of-two ring.
class Extreme {
  constructor(n, sign) {
    this.n = n;
    this.sign = sign;
    this.mask = pow2(n) - 1;
    this.vals = new Float64Array(this.mask + 1);
    this.idx = new Float64Array(this.mask + 1);
    this.head = 0;
    this.tail = 0;
    this.i = 0;
    this.quiet = 0;
  }

  push(x) {
    const i = this.i;
    this.i = i + 1;
    if (x !== x) { this.quiet = 0; return false; }
    const quiet = ++this.quiet;
    const mask = this.mask;
    const vals = this.vals;
    const idx = this.idx;
    const sign = this.sign;
    const oldest = i - this.n;
    let head = this.head;
    let tail = this.tail;
    while (head < tail && idx[head & mask] <= oldest) head++;
    while (tail > head && sign * vals[(tail - 1) & mask] <= sign * x) tail--;
    vals[tail & mask] = x;
    idx[tail & mask] = i;
    this.head = head;
    this.tail = tail + 1;
    return quiet >= this.n;
  }

  get value() { return this.vals[this.head & this.mask]; }

  // 0 for this bar, -k for k bars ago.
  get offset() { return this.idx[this.head & this.mask] - (this.i - 1); }
}

// Every stepper's step() stores its result in `v` (and `o0`, `o1`, `o2` for several outputs)
// and returns nothing: a returned double would be boxed on the heap at each call site the JIT
// doesn't inline, which in a big script is most of them.

class Sma {
  constructor(at, n) { this.m = new SumWindow(whole(at, "length", n)); this.v = NaN; }

  step(x) { this.v = this.m.push(x) ? this.m.sum * this.m.inv : NaN; }
}

class Sum {
  constructor(at, n) { this.m = new SumWindow(whole(at, "length", n)); this.v = NaN; }

  step(x) { this.v = this.m.push(x) ? this.m.sum : NaN; }
}

// Exponential and Wilder moving averages. Both seed with the simple average of the first n
// values, then smooth; an na is skipped (the state is kept).
class Ema {
  constructor(at, n) {
    this.n = whole(at, "length", n);
    this.k = 2 / (n + 1);
    this.k1 = 1 - this.k;
    this.prev = NaN;
    this.seeded = false;
    this.seed = 0;
    this.count = 0;
    this.v = NaN;
  }

  step(x) {
    if (this.seeded) {
      if (x !== x) { this.v = NaN; return; }
      this.prev = x * this.k + this.prev * this.k1;
      this.v = this.prev;
      return;
    }
    this.start(x);
  }

  start(x) {
    this.v = NaN;
    if (x !== x) return;
    this.seed += x;
    if (++this.count < this.n) return;
    this.seeded = true;
    this.prev = this.seed / this.n;
    this.v = this.prev;
  }
}

class Rma {
  constructor(at, n) {
    this.n = whole(at, "length", n);
    this.nm1 = n - 1;
    this.inv = 1 / n;
    this.prev = NaN;
    this.seeded = false;
    this.seed = 0;
    this.count = 0;
    this.v = NaN;
  }

  step(x) {
    if (this.seeded) {
      if (x !== x) { this.v = NaN; return; }
      this.prev = (this.prev * this.nm1 + x) * this.inv;
      this.v = this.prev;
      return;
    }
    this.start(x);
  }

  start(x) {
    this.v = NaN;
    if (x !== x) return;
    this.seed += x;
    if (++this.count < this.n) return;
    this.seeded = true;
    this.prev = this.seed / this.n;
    this.v = this.prev;
  }
}

class Wma {
  constructor(at, n) {
    this.m = new WeightedWindow(whole(at, "length", n));
    this.div = (n * (n + 1)) / 2;
    this.v = NaN;
  }

  step(x) { this.v = this.m.push(x) ? this.m.wsum / this.div : NaN; }
}

class Hma {
  constructor(at, n) {
    whole(at, "length", n);
    this.half = new Wma(at, Math.max(1, Math.floor(n / 2)));
    this.full = new Wma(at, n);
    this.out = new Wma(at, Math.max(1, Math.floor(Math.sqrt(n))));
    this.v = NaN;
  }

  step(x) {
    this.half.step(x);
    this.full.step(x);
    this.out.step(2 * this.half.v - this.full.v);
    this.v = this.out.v;
  }
}

class Vwma {
  constructor(at, n) { this.pv = new SumWindow(whole(at, "length", n)); this.vol = new SumWindow(n); this.v = NaN; }

  step(x, volume) {
    const a = this.pv.push(x * volume);
    const b = this.vol.push(volume);
    this.v = a && b && this.vol.sum !== 0 ? this.pv.sum / this.vol.sum : NaN;
  }
}

class Variance {
  constructor(at, n, root) { this.m = new M2Window(whole(at, "length", n)); this.root = root; this.v = NaN; }

  step(x) {
    if (!this.m.push(x)) { this.v = NaN; return; }
    const v = Math.max(0, this.m.m2) * this.m.inv;
    this.v = this.root ? Math.sqrt(v) : v;
  }
}

// Highest or lowest over the last n values without a deque (van Herk / Gil-Werman): the
// window is the tail of the previous block of n values plus the head of the current one, so
// its extreme is Math.max / Math.min of a running head and a stored tail. An na poisons the
// head and the tails that cover it, which is exactly "a window that holds an na gives na".
class BlockMax {
  constructor(n) {
    this.n = n;
    this.block = new Float64Array(n);
    this.tail = new Float64Array(n + 1).fill(-Infinity);
    this.j = 0;
    this.head = -Infinity;
    this.count = 0;
    this.v = NaN;
  }

  step(x) {
    const j = this.j;
    const head = Math.max(this.head, x);
    const value = Math.max(head, this.tail[j + 1]);
    this.block[j] = x;
    if (j + 1 === this.n) {
      const block = this.block;
      const tail = this.tail;
      let t = -Infinity;
      for (let k = this.n - 1; k >= 0; k--) {
        t = Math.max(t, block[k]);
        tail[k] = t;
      }
      this.j = 0;
      this.head = -Infinity;
    } else {
      this.j = j + 1;
      this.head = head;
    }
    this.v = ++this.count >= this.n ? value : NaN;
  }
}

class BlockMin {
  constructor(n) {
    this.n = n;
    this.block = new Float64Array(n);
    this.tail = new Float64Array(n + 1).fill(Infinity);
    this.j = 0;
    this.head = Infinity;
    this.count = 0;
    this.v = NaN;
  }

  step(x) {
    const j = this.j;
    const head = Math.min(this.head, x);
    const value = Math.min(head, this.tail[j + 1]);
    this.block[j] = x;
    if (j + 1 === this.n) {
      const block = this.block;
      const tail = this.tail;
      let t = Infinity;
      for (let k = this.n - 1; k >= 0; k--) {
        t = Math.min(t, block[k]);
        tail[k] = t;
      }
      this.j = 0;
      this.head = Infinity;
    } else {
      this.j = j + 1;
      this.head = head;
    }
    this.v = ++this.count >= this.n ? value : NaN;
  }
}

class HighestBars {
  constructor(at, n, sign) { this.e = new Extreme(whole(at, "length", n), sign); this.v = NaN; }

  step(x) { this.v = this.e.push(x) ? this.e.offset : NaN; }
}

class Change {
  constructor(at, n, mode) { this.ring = new Ring(whole(at, "length", n)); this.mode = mode; this.v = NaN; }

  step(x) {
    const old = this.ring.push(x);
    this.v = this.mode === 0 ? x - old : old === 0 ? NaN : ((x - old) / old) * 100;
  }
}

class Rsi {
  constructor(at, n) {
    this.n = whole(at, "length", n);
    this.nm1 = n - 1;
    this.inv = 1 / n;
    this.prev = NaN;
    this.up = 0;
    this.down = 0;
    this.count = 0;
    this.seeded = false;
    this.v = NaN;
  }

  // Wilder smoothing of the gains and the losses, seeded with their simple averages.
  step(x) {
    const change = x - this.prev;
    this.prev = x;
    this.v = NaN;
    if (change !== change) return;
    const gain = (change + Math.abs(change)) * 0.5;      // branch-free max(change, 0)
    const loss = gain - change;
    if (this.seeded) {
      this.up = (this.up * this.nm1 + gain) * this.inv;
      this.down = (this.down * this.nm1 + loss) * this.inv;
    } else {
      this.up += gain;
      this.down += loss;
      if (++this.count < this.n) return;
      this.up *= this.inv;
      this.down *= this.inv;
      this.seeded = true;
    }
    this.v = this.down === 0 ? 100 : (100 * this.up) / (this.up + this.down);
  }
}

class Tr {
  constructor() { this.prev = NaN; this.first = true; this.v = NaN; }

  step(high, low, close) {
    const range = high - low;
    if (this.first) {
      this.v = range;
      this.first = false;
    } else {
      this.v = Math.max(range, Math.abs(high - this.prev), Math.abs(low - this.prev));
    }
    this.prev = close;
  }
}

class Atr {
  constructor(at, n) { this.tr = new Tr(); this.rma = new Rma(at, n); this.v = NaN; }

  step(high, low, close) {
    this.tr.step(high, low, close);
    this.rma.step(this.tr.v);
    this.v = this.rma.v;
  }
}

class Adr {
  constructor(at, n) { this.m = new SumWindow(whole(at, "length", n)); this.v = NaN; }

  step(high, low) { this.v = this.m.push(low === 0 ? NaN : (high / low - 1) * 100) ? this.m.sum * this.m.inv : NaN; }
}

class Macd {
  constructor(at, fast, slow, signal) {
    this.fast = new Ema(at, fast);
    this.slow = new Ema(at, slow);
    this.signal = new Ema(at, signal);
    this.v = this.o0 = this.o1 = this.o2 = NaN;
  }

  step(x) {
    this.fast.step(x);
    this.slow.step(x);
    const line = this.fast.v - this.slow.v;
    this.signal.step(line);
    this.o0 = this.v = line;
    this.o1 = this.signal.v;
    this.o2 = line - this.signal.v;
  }
}

class Bb {
  constructor(at, n) { this.m = new M2Window(whole(at, "length", n)); this.v = this.o0 = this.o1 = this.o2 = NaN; }

  step(x, mult) {
    if (!this.m.push(x)) { this.v = this.o0 = this.o1 = this.o2 = NaN; return; }
    const basis = this.m.sum * this.m.inv;
    const dev = Math.sqrt(Math.max(0, this.m.m2) * this.m.inv);
    this.v = this.o0 = basis;
    this.o1 = basis + mult * dev;
    this.o2 = basis - mult * dev;
  }
}

class Kc {
  constructor(at, n, atrLength) { this.ema = new Ema(at, n); this.atr = new Atr(at, atrLength); this.v = this.o0 = this.o1 = this.o2 = NaN; }

  step(x, mult, high, low, close) {
    this.ema.step(x);
    this.atr.step(high, low, close);
    const basis = this.ema.v;
    const atr = this.atr.v;
    this.v = this.o0 = basis;
    this.o1 = basis + mult * atr;
    this.o2 = basis - mult * atr;
  }
}

class Stoch {
  constructor(at, n, kSmooth, dSmooth) {
    this.hi = new BlockMax(whole(at, "length", n));
    this.lo = new BlockMin(n);
    this.k = new Sma(at, kSmooth);
    this.d = new Sma(at, dSmooth);
    this.v = this.o0 = this.o1 = NaN;
  }

  step(high, low, close) {
    this.hi.step(high);
    this.lo.step(low);
    const range = this.hi.v - this.lo.v;
    this.k.step(range > 0 ? (100 * (close - this.lo.v)) / range : NaN);
    this.d.step(this.k.v);
    this.v = this.o0 = this.k.v;
    this.o1 = this.d.v;
  }
}

class Cross {
  constructor(mode) { this.mode = mode; this.pa = NaN; this.pb = NaN; this.v = false; }

  step(a, b) {
    const over = a > b && this.pa <= this.pb;
    const under = a < b && this.pa >= this.pb;
    this.pa = a;
    this.pb = b;
    this.v = this.mode === 0 ? over : this.mode === 1 ? under : over || under;
  }
}

class Run {
  constructor(at, n, rising) { this.n = whole(at, "length", n); this.rising = rising; this.prev = NaN; this.run = 0; this.v = false; }

  step(x) {
    this.run = (this.rising ? x > this.prev : x < this.prev) ? this.run + 1 : 0;
    this.prev = x;
    this.v = this.run >= this.n;
  }
}

class BarsSince {
  constructor() { this.v = NaN; }

  step(cond) { this.v = cond ? 0 : this.v + 1; }
}

class ValueWhen {
  constructor(at, nth) { this.size = whole(at, "nth", nth, 0) + 1; this.buf = new Float64Array(this.size); this.count = 0; this.v = NaN; }

  step(cond, x) {
    if (cond) { this.buf[this.count % this.size] = x; this.count++; }
    this.v = this.count >= this.size ? this.buf[(this.count - this.size) % this.size] : NaN;
  }
}

class Cum {
  constructor() { this.total = 0; this.v = NaN; }

  step(x) {
    if (x !== x) { this.v = NaN; return; }
    this.total += x;
    this.v = this.total;
  }
}

class Median {
  constructor(at, n) { this.r = new Ring(whole(at, "length", n)); this.tmp = new Float64Array(n); this.v = NaN; }

  step(x) {
    this.r.push(x);
    if (!this.r.ready) { this.v = NaN; return; }
    const n = this.r.n;
    for (let k = 0; k < n; k++) this.tmp[k] = this.r.at(k);
    this.tmp.sort();
    this.v = n % 2 ? this.tmp[(n - 1) / 2] : (this.tmp[n / 2 - 1] + this.tmp[n / 2]) / 2;
  }
}

class PercentRank {
  constructor(at, n) { this.r = new Ring(whole(at, "length", n) + 1); this.v = NaN; }

  step(x) {
    this.r.push(x);
    if (!this.r.ready) { this.v = NaN; return; }
    let count = 0;
    for (let k = 1; k < this.r.n; k++) if (this.r.at(k) <= x) count++;
    this.v = (count / (this.r.n - 1)) * 100;
  }
}

// A pivot is confirmed `right` bars after it. A high must beat the `left` bars before it and
// at least match the `right` bars after it (an equal run pivots on its first bar).
class Pivot {
  constructor(at, left, right, sign) {
    this.left = whole(at, "left", left);
    this.right = whole(at, "right", right);
    this.r = new Ring(left + right + 1);
    this.sign = sign;
    this.v = NaN;
  }

  step(x) {
    this.r.push(x);
    this.v = NaN;
    if (!this.r.ready) return;
    const s = this.sign;
    const mid = this.r.at(this.right);
    for (let k = 0; k < this.right; k++) if (s * this.r.at(k) > s * mid) return;
    for (let k = this.right + 1; k <= this.right + this.left; k++) if (s * this.r.at(k) >= s * mid) return;
    this.v = mid;
  }
}

class Vwap {
  constructor() { this.day = NaN; this.value = 0; this.volume = 0; this.v = NaN; }

  step(time, high, low, close, volume) {
    const day = Math.floor(time / 86400);
    if (day !== this.day) { this.day = day; this.value = 0; this.volume = 0; }
    const typical = (high + low + close) / 3;
    if (typical !== typical || volume !== volume) { this.v = NaN; return; }
    this.value += typical * volume;
    this.volume += volume;
    this.v = this.volume ? this.value / this.volume : typical;
  }
}

// Volume over its average across the bars before this one.
class Rvol {
  constructor(at, n) { this.m = new SumWindow(whole(at, "length", n)); this.prev = NaN; this.v = NaN; }

  step(volume) {
    this.v = this.prev && this.prev === this.prev ? volume / this.prev : NaN;
    this.prev = this.m.push(volume) ? this.m.sum * this.m.inv : NaN;
  }
}

export const ta = {
  sma: (at, n) => new Sma(at, n),
  ema: (at, n) => new Ema(at, n),
  rma: (at, n) => new Rma(at, n),
  wma: (at, n) => new Wma(at, n),
  vwma: (at, n) => new Vwma(at, n),
  hma: (at, n) => new Hma(at, n),
  stdev: (at, n) => new Variance(at, n, true),
  variance: (at, n) => new Variance(at, n, false),
  highest: (at, n) => new BlockMax(whole(at, "length", n)),
  lowest: (at, n) => new BlockMin(whole(at, "length", n)),
  highestbars: (at, n) => new HighestBars(at, n, 1),
  lowestbars: (at, n) => new HighestBars(at, n, -1),
  change: (at, n) => new Change(at, n, 0),
  mom: (at, n) => new Change(at, n, 0),
  roc: (at, n) => new Change(at, n, 1),
  rsi: (at, n) => new Rsi(at, n),
  atr: (at, n) => new Atr(at, n),
  tr: () => new Tr(),
  adr: (at, n) => new Adr(at, n),
  macd: (at, fast, slow, signal) => new Macd(at, fast, slow, signal),
  bb: (at, n) => new Bb(at, n),
  kc: (at, n, atrLength) => new Kc(at, n, atrLength),
  stoch: (at, n, k, d) => new Stoch(at, n, k, d),
  crossover: () => new Cross(0),
  crossunder: () => new Cross(1),
  cross: () => new Cross(2),
  rising: (at, n) => new Run(at, n, true),
  falling: (at, n) => new Run(at, n, false),
  barssince: () => new BarsSince(),
  valuewhen: (at, nth) => new ValueWhen(at, nth),
  cum: () => new Cum(),
  sum: (at, n) => new Sum(at, n),
  median: (at, n) => new Median(at, n),
  percentrank: (at, n) => new PercentRank(at, n),
  pivothigh: (at, left, right) => new Pivot(at, left, right, 1),
  pivotlow: (at, left, right) => new Pivot(at, left, right, -1),
  vwap: () => new Vwap(),
  rvol: (at, n) => new Rvol(at, n),
};
