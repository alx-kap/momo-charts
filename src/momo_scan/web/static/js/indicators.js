// Indicator maths and the catalogue the chart settings offer. Every series is computed over the
// whole bar list and aligned to it (null where there isn't enough history), using only bars up
// to each point, so a replay can reveal them one bar at a time.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] != null) { sum += values[i]; count++; }
    if (i >= period && values[i - period] != null) { sum -= values[i - period]; count--; }
    if (i >= period - 1 && count === period) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  let seed = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed.push(v);
      if (seed.length === period) { prev = seed.reduce((a, b) => a + b, 0) / period; out[i] = prev; seed = null; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's smoothing (RMA), as TradingView uses for RSI and ATR.
function rma(values, period) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  let seed = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed.push(v);
      if (seed.length === period) { prev = seed.reduce((a, b) => a + b, 0) / period; out[i] = prev; seed = null; }
      continue;
    }
    prev = (prev * (period - 1) + v) / period;
    out[i] = prev;
  }
  return out;
}

function stdev(values, period, means) {
  return values.map((_, i) => {
    if (means[i] == null) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (values[j] - means[i]) ** 2;
    return Math.sqrt(sum / period);
  });
}

const trueRange = (bars) => bars.map((bar, i) => i === 0 ? bar.high - bar.low : Math.max(
  bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close),
));

const closes = (bars) => bars.map((bar) => bar.close);
const zip = (a, b, fn) => a.map((v, i) => (v == null || b[i] == null ? null : fn(v, b[i])));

function rsi(bars, period) {
  const c = closes(bars);
  const gains = c.map((v, i) => (i === 0 ? null : Math.max(v - c[i - 1], 0)));
  const losses = c.map((v, i) => (i === 0 ? null : Math.max(c[i - 1] - v, 0)));
  return zip(rma(gains, period), rma(losses, period), (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l)));
}

// Volume-weighted average price from each New York day's first bar (intraday bars only: their
// times are New York wall-clock seconds; daily charts get no line).
function vwap(bars) {
  let day = null;
  let value = 0;
  let volume = 0;
  return bars.map((bar) => {
    if (typeof bar.time !== "number") return null;
    const today = Math.floor(bar.time / 86400);
    if (today !== day) { day = today; value = 0; volume = 0; }
    const typical = (bar.high + bar.low + bar.close) / 3;
    value += typical * bar.volume;
    volume += bar.volume;
    return volume ? value / volume : typical;
  });
}

// High-volume closes. Each day's dollar volume is a multiple of two baselines up to the day
// before: the 20-day EMA (the average line Alex's brother reads in his volume pane) and the
// 100-day average, which still stands out when volume ramps through a run and drags the short
// average up with it (MU, April 2026). Each multiple is ranked against the stock's own over the
// prior `window` bars, since a mega cap's steady volume rarely reaches the 2× a stock like W
// does: `top` is the share of those days at least as big (5 = a top-5% day), the better of the two.
const MIN_RANK_BARS = 60;
const LONG_BASE = 100;

function rankAgainstPast(mult, window) {
  return mult.map((m, i) => {
    if (m == null) return null;
    let count = 0;
    let beat = 0;
    for (let j = Math.max(0, i - window); j < i; j++) {
      if (mult[j] == null) continue;
      count++;
      if (mult[j] >= m) beat++;
    }
    return count >= MIN_RANK_BARS ? (beat / count) * 100 : null;
  });
}

function hvcStats(bars, period, window) {
  const dollars = bars.map((bar) => bar.volume * bar.close);
  const versus = (avg) => dollars.map((v, i) => (i > 0 && avg[i - 1] ? v / avg[i - 1] : null));
  const short = versus(ema(dollars, period));
  const long = versus(sma(dollars, LONG_BASE));
  const shortTop = rankAgainstPast(short, window);
  const longTop = rankAgainstPast(long, window);
  const range = sma(bars.map((bar) => bar.high - bar.low), 20);
  return short.map((m, i) => {
    if (m == null) return null;
    const useLong = longTop[i] != null && (shortTop[i] == null || longTop[i] < shortTop[i]);
    return useLong
      ? { mult: long[i], top: longTop[i], base: LONG_BASE, range: range[i] }
      : { mult: m, top: shortTop[i], base: period, range: range[i] };
  });
}

// The HVC levels to draw with `n` bars on the chart: the closes of top-ranked days in the
// lookback that sit near the last close, biggest first, each absorbing smaller ones
// nearby (see below). Uses only those `n` bars, so a replay never draws a level from the future.
export function hvcLevels(bars, stats, p, n = bars.length) {
  if (!n) return [];
  const last = bars[n - 1].close;
  const found = [];
  for (let i = Math.max(1, n - p.lookback); i < n; i++) {
    const day = stats[i];
    const price = bars[i].close;
    if (day && day.top != null && day.top <= p.top && Math.abs(price / last - 1) * 100 <= p.within) {
      found.push({ i, price, mult: day.mult, major: day.top <= p.majorTop });
    }
  }
  found.sort((a, b) => b.mult - a.mult);
  const kept = [];
  // Merge distance scales with the stock's daily range: `mergeAdr` average daily ranges.
  const gap = p.mergeAdr * ((stats[n - 1] && stats[n - 1].range) || 0);
  for (const level of found) {
    if (!kept.some((k) => Math.abs(level.price - k.price) <= gap)) kept.push(level);
  }
  return kept;
}

// The catalogue. `pane: "price"` draws over the candles, `pane: "own"` gets a pane of its own.
// `inputs` are the numeric parameters; `plots` are the drawn lines, each with a default style
// (`was` lists retired default colours, which saved settings swap for the current one).
// `levels` are fixed horizontal guides in an own-pane indicator. `kind: "levels"` draws
// horizontal lines from `lines(bars, result, params, n)` instead of one line per plot; its
// plots are styles (major, minor) and `value` names the series the legend shows.
export const INDICATORS = {
  earnings: {
    name: "Earnings", pane: "price", kind: "events", chartOnly: true,
    inputs: [], plots: [], label: () => "Earnings",
  },
  sma: {
    name: "Moving average (simple)", pane: "price",
    inputs: [{ key: "period", label: "Length", value: 20, min: 1, max: 500 }],
    plots: [{ key: "line", label: "Line", color: "#f5ea6b" }],
    label: (p) => `SMA ${p.period}`,
    compute: (bars, p) => ({ line: sma(closes(bars), p.period) }),
  },
  ema: {
    name: "Moving average (exponential)", pane: "price",
    inputs: [{ key: "period", label: "Length", value: 21, min: 1, max: 500 }],
    plots: [{ key: "line", label: "Line", color: "#49b3c4" }],
    label: (p) => `EMA ${p.period}`,
    compute: (bars, p) => ({ line: ema(closes(bars), p.period) }),
  },
  vwap: {
    name: "VWAP (intraday, resets daily)", pane: "price",
    inputs: [],
    plots: [{ key: "line", label: "VWAP", color: "#e040fb" }],
    label: () => "VWAP",
    compute: (bars) => ({ line: vwap(bars) }),
  },
  bb: {
    name: "Bollinger Bands", pane: "price",
    inputs: [
      { key: "period", label: "Length", value: 20, min: 2, max: 500 },
      { key: "mult", label: "StdDev", value: 2, min: 0.1, max: 10, step: 0.1 },
    ],
    plots: [
      { key: "basis", label: "Basis", color: "#ff6d00" },
      { key: "upper", label: "Upper", color: "#2962ff" },
      { key: "lower", label: "Lower", color: "#2962ff" },
    ],
    label: (p) => `BB ${p.period} ${p.mult}`,
    compute: (bars, p) => {
      const c = closes(bars);
      const basis = sma(c, p.period);
      const dev = stdev(c, p.period, basis);
      return {
        basis,
        upper: zip(basis, dev, (m, d) => m + p.mult * d),
        lower: zip(basis, dev, (m, d) => m - p.mult * d),
      };
    },
  },
  kc: {
    name: "Keltner Channels", pane: "price",
    inputs: [
      { key: "period", label: "Length", value: 20, min: 2, max: 500 },
      { key: "mult", label: "Multiplier", value: 2, min: 0.1, max: 10, step: 0.1 },
      { key: "atr", label: "ATR length", value: 10, min: 1, max: 500 },
    ],
    plots: [
      { key: "basis", label: "Basis", color: "#2962ff" },
      { key: "upper", label: "Upper", color: "#2962ff" },
      { key: "lower", label: "Lower", color: "#2962ff" },
    ],
    label: (p) => `KC ${p.period} ${p.mult}`,
    compute: (bars, p) => {
      const basis = ema(closes(bars), p.period);
      const atr = rma(trueRange(bars), p.atr);
      return {
        basis,
        upper: zip(basis, atr, (m, a) => m + p.mult * a),
        lower: zip(basis, atr, (m, a) => m - p.mult * a),
      };
    },
  },
  rsi: {
    name: "Relative Strength Index", pane: "own",
    inputs: [{ key: "period", label: "Length", value: 14, min: 2, max: 500 }],
    plots: [{ key: "line", label: "RSI", color: "#7e57c2" }],
    levels: [70, 30],
    label: (p) => `RSI ${p.period}`,
    compute: (bars, p) => ({ line: rsi(bars, p.period) }),
  },
  macd: {
    name: "MACD", pane: "own",
    inputs: [
      { key: "fast", label: "Fast", value: 12, min: 1, max: 500 },
      { key: "slow", label: "Slow", value: 26, min: 1, max: 500 },
      { key: "signal", label: "Signal", value: 9, min: 1, max: 500 },
    ],
    plots: [
      { key: "hist", label: "Histogram", color: "#26a69a", color2: "#ef5350", type: "histogram" },
      { key: "macd", label: "MACD", color: "#2962ff" },
      { key: "signal", label: "Signal", color: "#ff6d00" },
    ],
    levels: [0],
    label: (p) => `MACD ${p.fast} ${p.slow} ${p.signal}`,
    compute: (bars, p) => {
      const c = closes(bars);
      const macd = zip(ema(c, p.fast), ema(c, p.slow), (f, s) => f - s);
      const signal = ema(macd, p.signal);
      return { macd, signal, hist: zip(macd, signal, (m, s) => m - s) };
    },
  },
  atr: {
    name: "Average True Range", pane: "own",
    inputs: [{ key: "period", label: "Length", value: 14, min: 1, max: 500 }],
    plots: [{ key: "line", label: "ATR", color: "#ff5252" }],
    label: (p) => `ATR ${p.period}`,
    compute: (bars, p) => ({ line: rma(trueRange(bars), p.period) }),
  },
  adr: {
    name: "Average Daily Range %", pane: "own",
    inputs: [{ key: "period", label: "Length", value: 20, min: 1, max: 500 }],
    plots: [{ key: "line", label: "ADR %", color: "#df8540" }],
    label: (p) => `ADR% ${p.period}`,
    format: (v) => `${v.toFixed(2)}%`,
    compute: (bars, p) => ({ line: sma(bars.map((b) => (b.high / b.low - 1) * 100), p.period) }),
  },
  hvc: {
    name: "High-volume closes (HVC)", pane: "price", kind: "levels", value: "stats",
    inputs: [
      { key: "top", label: "Top %", value: 10, min: 0.5, max: 50, step: 0.5 },
      { key: "majorTop", label: "Major top %", value: 2, min: 0.1, max: 50, step: 0.1 },
      { key: "period", label: "EMA", value: 20, min: 2, max: 200 },
      { key: "lookback", label: "Bars back", value: 250, min: 60, max: 2000 },
      { key: "within", label: "Within %", value: 50, min: 1, max: 200 },
      { key: "mergeAdr", label: "Merge ADR", value: 0.25, min: 0, max: 5, step: 0.1 },
    ],
    plots: [
      { key: "major", label: "Major", color: "#ff9800" },
      { key: "minor", label: "Minor", color: "rgba(255, 152, 0, 0.75)", was: ["rgba(255, 152, 0, 0.45)"] },
    ],
    label: (p) => `HVC top ${p.top}%`,
    format: (v) => `${v.mult.toFixed(1)}× ${v.base}d` + (v.top == null ? "" : ` · top ${v.top < 1 ? v.top.toFixed(1) : Math.round(v.top)}%`),
    compute: (bars, p) => ({ stats: hvcStats(bars, p.period, p.lookback) }),
    lines: (bars, result, p, n) => hvcLevels(bars, result.stats, p, n),
  },
  rs: {
    name: "Relative strength line (vs SPY)", pane: "own", benchmark: true,
    inputs: [{ key: "period", label: "Average", value: 21, min: 1, max: 500 }],
    plots: [
      { key: "line", label: "RS", color: "#2962ff" },
      { key: "avg", label: "Average", color: "#787b86" },
    ],
    label: (p) => `RS vs SPY · ${p.period}`,
    format: (v) => v.toFixed(2),
    compute: (bars, p, ctx) => {
      const spy = new Map((ctx.benchmark || []).map((bar) => [bar.time, bar.close]));
      const line = bars.map((bar) => (spy.get(bar.time) ? (bar.close / spy.get(bar.time)) * 100 : null));
      return { line, avg: sma(line, p.period) };
    },
  },
};

// Visibility per timeframe, like TradingView's: an indicator's `hiddenOn` lists the timeframes
// it is off on. Multiples follow their unit (2W is W, 3M is M).
export const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "D", "W", "M"];
export const timeframeOf = (interval) => (TIMEFRAMES.includes(interval) ? interval : interval.slice(-1));
export const shownOn = (ind, interval) => !(ind.hiddenOn || []).includes(timeframeOf(interval));

let counter = 0;
export function newIndicator(type, overrides = {}) {
  const def = INDICATORS[type];
  const params = Object.fromEntries(def.inputs.map((input) => [input.key, input.value]));
  const style = Object.fromEntries(def.plots.map((plot) => [plot.key, {
    color: plot.color, ...(plot.color2 ? { color2: plot.color2 } : {}), width: 1,
  }]));
  counter += 1;
  return {
    id: `${type}-${Date.now().toString(36)}-${counter}`,
    type, visible: true,
    params: { ...params, ...(overrides.params || {}) },
    style: { ...style, ...(overrides.style || {}) },
  };
}
