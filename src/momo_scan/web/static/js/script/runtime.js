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

// The last n values, with a count of the na among them.
class Ring {
  constructor(n) {
    this.n = n;
    this.buf = new Float64Array(n);
    this.i = 0;
    this.bad = 0;
  }

  // Adds x; returns the value that fell out of the window (NaN while it was filling).
  push(x) {
    const n = this.n;
    const p = this.i % n;
    let old = NaN;
    if (this.i >= n) {
      old = this.buf[p];
      if (old !== old) this.bad--;
    }
    if (x !== x) this.bad++;
    this.buf[p] = x;
    this.i++;
    return old;
  }

  get ready() { return this.i >= this.n && this.bad === 0; }

  // Value k bars ago (0 is the newest).
  at(k) { return this.buf[(((this.i - 1 - k) % this.n) + this.n) % this.n]; }
}

// Running sum (and sum of squared deviations, and weighted sum) of a full, clean window,
// updated in O(1) and rebuilt from the ring every REFRESH bars and after an na leaves.
class Moments extends Ring {
  constructor(n, m2 = false, weighted = false) {
    super(n);
    this.wantM2 = m2;
    this.weighted = weighted;
    this.sum = 0;
    this.m2 = 0;
    this.wsum = 0;
    this.valid = false;
    this.age = 0;
  }

  push(x) {
    const n = this.n;
    const old = super.push(x);
    if (this.i < n || this.bad > 0) { this.valid = false; return false; }
    if (this.valid && ++this.age < REFRESH) {
      const prevSum = this.sum;
      this.sum = prevSum + x - old;
      if (this.wantM2) this.m2 += (x - old) * (x - this.sum / n + old - prevSum / n);
      if (this.weighted) this.wsum = this.wsum - prevSum + n * x;
      // The running update loses precision when the window is nearly flat (its stdev under
      // 0.01% of its mean); work it out from scratch then, as a two-pass sum would.
      if (this.wantM2 && this.m2 < NEARLY_FLAT * ((this.sum * this.sum) / n)) this.rebuild();
    } else {
      this.rebuild();
    }
    return true;
  }

  rebuild() {
    const n = this.n;
    const start = this.i % n;
    let sum = 0;
    let wsum = 0;
    for (let k = 0; k < n; k++) {
      const v = this.buf[(start + k) % n];
      sum += v;
      wsum += (k + 1) * v;
    }
    this.sum = sum;
    this.wsum = wsum;
    if (this.wantM2) {
      const mean = sum / n;
      let m2 = 0;
      for (let k = 0; k < n; k++) m2 += (this.buf[k] - mean) ** 2;
      this.m2 = m2;
    }
    this.valid = true;
    this.age = 0;
  }
}

// Highest (sign 1) or lowest (sign -1) over the last n values, with a monotonic deque.
class Extreme {
  constructor(n, sign) {
    this.n = n;
    this.sign = sign;
    this.vals = new Float64Array(n);
    this.idx = new Float64Array(n);
    this.raw = new Float64Array(n);
    this.head = 0;
    this.size = 0;
    this.i = 0;
    this.bad = 0;
  }

  push(x) {
    const n = this.n;
    const p = this.i % n;
    if (this.i >= n && this.raw[p] !== this.raw[p]) this.bad--;
    if (x !== x) this.bad++;
    this.raw[p] = x;
    const oldest = this.i - n + 1;
    while (this.size && this.idx[this.head] < oldest) { this.head = (this.head + 1) % n; this.size--; }
    if (x === x) {
      const s = this.sign;
      while (this.size && s * this.vals[(this.head + this.size - 1) % n] <= s * x) this.size--;
      const t = (this.head + this.size) % n;
      this.vals[t] = x;
      this.idx[t] = this.i;
      this.size++;
    }
    this.i++;
    return this.i >= n && this.bad === 0 && this.size > 0;
  }

  get value() { return this.vals[this.head]; }

  // 0 for this bar, -k for k bars ago.
  get offset() { return this.idx[this.head] - (this.i - 1); }
}

class Sma {
  constructor(at, n) { this.m = new Moments(whole(at, "length", n)); }

  step(x) { return this.m.push(x) ? this.m.sum / this.m.n : NaN; }
}

class Sum {
  constructor(at, n) { this.m = new Moments(whole(at, "length", n)); }

  step(x) { return this.m.push(x) ? this.m.sum : NaN; }
}

// Seeds with the simple average of the first n values, then smooths.
class Smooth {
  constructor(at, n, wilder) {
    this.n = whole(at, "length", n);
    this.k = wilder ? 0 : 2 / (n + 1);
    this.wilder = wilder;
    this.prev = NaN;
    this.seeded = false;
    this.seed = 0;
    this.count = 0;
  }

  step(x) {
    if (x !== x) return NaN;
    if (!this.seeded) {
      this.seed += x;
      if (++this.count === this.n) { this.prev = this.seed / this.n; this.seeded = true; return this.prev; }
      return NaN;
    }
    this.prev = this.wilder ? (this.prev * (this.n - 1) + x) / this.n : x * this.k + this.prev * (1 - this.k);
    return this.prev;
  }
}

class Ema extends Smooth { constructor(at, n) { super(at, n, false); } }
class Rma extends Smooth { constructor(at, n) { super(at, n, true); } }

class Wma {
  constructor(at, n) {
    this.m = new Moments(whole(at, "length", n), false, true);
    this.div = (n * (n + 1)) / 2;
  }

  step(x) { return this.m.push(x) ? this.m.wsum / this.div : NaN; }
}

class Hma {
  constructor(at, n) {
    whole(at, "length", n);
    this.half = new Wma(at, Math.max(1, Math.floor(n / 2)));
    this.full = new Wma(at, n);
    this.out = new Wma(at, Math.max(1, Math.floor(Math.sqrt(n))));
  }

  step(x) { return this.out.step(2 * this.half.step(x) - this.full.step(x)); }
}

class Vwma {
  constructor(at, n) { this.pv = new Moments(whole(at, "length", n)); this.v = new Moments(n); }

  step(x, volume) {
    const a = this.pv.push(x * volume);
    const b = this.v.push(volume);
    return a && b && this.v.sum !== 0 ? this.pv.sum / this.v.sum : NaN;
  }
}

class Variance {
  constructor(at, n, root) { this.m = new Moments(whole(at, "length", n), true); this.root = root; }

  step(x) {
    if (!this.m.push(x)) return NaN;
    const v = Math.max(0, this.m.m2) / this.m.n;
    return this.root ? Math.sqrt(v) : v;
  }
}

class Highest {
  constructor(at, n, sign) { this.e = new Extreme(whole(at, "length", n), sign); }

  step(x) { return this.e.push(x) ? this.e.value : NaN; }
}

class HighestBars {
  constructor(at, n, sign) { this.e = new Extreme(whole(at, "length", n), sign); }

  step(x) { return this.e.push(x) ? this.e.offset : NaN; }
}

class Change {
  constructor(at, n, mode) { this.n = whole(at, "length", n); this.buf = new Float64Array(this.n); this.i = 0; this.mode = mode; }

  step(x) {
    const p = this.i % this.n;
    const old = this.i >= this.n ? this.buf[p] : NaN;
    this.buf[p] = x;
    this.i++;
    return this.mode === 0 ? x - old : old === 0 ? NaN : ((x - old) / old) * 100;
  }
}

class Rsi {
  constructor(at, n) {
    this.up = new Rma(at, n);
    this.down = new Rma(at, n);
    this.prev = NaN;
  }

  step(x) {
    const change = x - this.prev;
    this.prev = x;
    const g = this.up.step(change !== change ? NaN : Math.max(change, 0));
    const l = this.down.step(change !== change ? NaN : Math.max(-change, 0));
    if (g !== g || l !== l) return NaN;
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
}

class Tr {
  constructor() { this.prev = NaN; this.first = true; }

  step(high, low, close) {
    const range = high - low;
    let r;
    if (this.first) { r = range; this.first = false; } else {
      r = Math.max(range, Math.abs(high - this.prev), Math.abs(low - this.prev));
    }
    this.prev = close;
    return r;
  }
}

class Atr {
  constructor(at, n) { this.tr = new Tr(); this.rma = new Rma(at, n); }

  step(high, low, close) { return this.rma.step(this.tr.step(high, low, close)); }
}

class Adr {
  constructor(at, n) { this.m = new Moments(whole(at, "length", n)); }

  step(high, low) { return this.m.push(low === 0 ? NaN : (high / low - 1) * 100) ? this.m.sum / this.m.n : NaN; }
}

class Macd {
  constructor(at, fast, slow, signal) {
    this.fast = new Ema(at, fast);
    this.slow = new Ema(at, slow);
    this.signal = new Ema(at, signal);
    this.o0 = this.o1 = this.o2 = NaN;
  }

  step(x) {
    const line = this.fast.step(x) - this.slow.step(x);
    const signal = this.signal.step(line);
    this.o0 = line;
    this.o1 = signal;
    this.o2 = line - signal;
    return line;
  }
}

class Bb {
  constructor(at, n) { this.m = new Moments(whole(at, "length", n), true); this.o0 = this.o1 = this.o2 = NaN; }

  step(x, mult) {
    if (!this.m.push(x)) { this.o0 = this.o1 = this.o2 = NaN; return NaN; }
    const basis = this.m.sum / this.m.n;
    const dev = Math.sqrt(Math.max(0, this.m.m2) / this.m.n);
    this.o0 = basis;
    this.o1 = basis + mult * dev;
    this.o2 = basis - mult * dev;
    return basis;
  }
}

class Kc {
  constructor(at, n, atrLength) { this.ema = new Ema(at, n); this.atr = new Atr(at, atrLength); this.o0 = this.o1 = this.o2 = NaN; }

  step(x, mult, high, low, close) {
    const basis = this.ema.step(x);
    const atr = this.atr.step(high, low, close);
    this.o0 = basis;
    this.o1 = basis + mult * atr;
    this.o2 = basis - mult * atr;
    return basis;
  }
}

class Stoch {
  constructor(at, n, kSmooth, dSmooth) {
    this.hi = new Extreme(whole(at, "length", n), 1);
    this.lo = new Extreme(n, -1);
    this.k = new Sma(at, kSmooth);
    this.d = new Sma(at, dSmooth);
    this.o0 = this.o1 = NaN;
  }

  step(high, low, close) {
    const a = this.hi.push(high);
    const b = this.lo.push(low);
    let raw = NaN;
    if (a && b) {
      const range = this.hi.value - this.lo.value;
      raw = range > 0 ? (100 * (close - this.lo.value)) / range : NaN;
    }
    this.o0 = this.k.step(raw);
    this.o1 = this.d.step(this.o0);
    return this.o0;
  }
}

class Cross {
  constructor(mode) { this.mode = mode; this.pa = NaN; this.pb = NaN; }

  step(a, b) {
    const over = a > b && this.pa <= this.pb;
    const under = a < b && this.pa >= this.pb;
    this.pa = a;
    this.pb = b;
    return this.mode === 0 ? over : this.mode === 1 ? under : over || under;
  }
}

class Run {
  constructor(at, n, rising) { this.n = whole(at, "length", n); this.rising = rising; this.prev = NaN; this.run = 0; }

  step(x) {
    this.run = (this.rising ? x > this.prev : x < this.prev) ? this.run + 1 : 0;
    this.prev = x;
    return this.run >= this.n;
  }
}

class BarsSince {
  constructor() { this.n = NaN; }

  step(cond) { this.n = cond ? 0 : this.n + 1; return this.n; }
}

class ValueWhen {
  constructor(at, nth) { this.size = whole(at, "nth", nth, 0) + 1; this.buf = new Float64Array(this.size); this.count = 0; }

  step(cond, x) {
    if (cond) { this.buf[this.count % this.size] = x; this.count++; }
    return this.count >= this.size ? this.buf[(this.count - this.size) % this.size] : NaN;
  }
}

class Cum {
  constructor() { this.total = 0; }

  step(x) { if (x !== x) return NaN; this.total += x; return this.total; }
}

class Median {
  constructor(at, n) { this.r = new Ring(whole(at, "length", n)); this.tmp = new Float64Array(n); }

  step(x) {
    this.r.push(x);
    if (!this.r.ready) return NaN;
    const n = this.r.n;
    this.tmp.set(this.r.buf);
    this.tmp.sort();
    return n % 2 ? this.tmp[(n - 1) / 2] : (this.tmp[n / 2 - 1] + this.tmp[n / 2]) / 2;
  }
}

class PercentRank {
  constructor(at, n) { this.r = new Ring(whole(at, "length", n) + 1); }

  step(x) {
    this.r.push(x);
    if (!this.r.ready) return NaN;
    let count = 0;
    for (let k = 1; k < this.r.n; k++) if (this.r.at(k) <= x) count++;
    return (count / (this.r.n - 1)) * 100;
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
  }

  step(x) {
    this.r.push(x);
    if (!this.r.ready) return NaN;
    const s = this.sign;
    const mid = this.r.at(this.right);
    for (let k = 0; k < this.right; k++) if (s * this.r.at(k) > s * mid) return NaN;
    for (let k = this.right + 1; k <= this.right + this.left; k++) if (s * this.r.at(k) >= s * mid) return NaN;
    return mid;
  }
}

class Vwap {
  constructor() { this.day = NaN; this.value = 0; this.volume = 0; }

  step(time, high, low, close, volume) {
    const day = Math.floor(time / 86400);
    if (day !== this.day) { this.day = day; this.value = 0; this.volume = 0; }
    const typical = (high + low + close) / 3;
    if (typical !== typical || volume !== volume) return NaN;
    this.value += typical * volume;
    this.volume += volume;
    return this.volume ? this.value / this.volume : typical;
  }
}

// Volume over its average across the bars before this one.
class Rvol {
  constructor(at, n) { this.m = new Moments(whole(at, "length", n)); this.prev = NaN; }

  step(volume) {
    const out = this.prev && this.prev === this.prev ? volume / this.prev : NaN;
    this.prev = this.m.push(volume) ? this.m.sum / this.m.n : NaN;
    return out;
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
  highest: (at, n) => new Highest(at, n, 1),
  lowest: (at, n) => new Highest(at, n, -1),
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
