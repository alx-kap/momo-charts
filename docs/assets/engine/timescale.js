// The time axis. Every time any series holds, merged and sorted, is a logical index (0 is the
// oldest); the window onto them is a bar spacing in pixels and how far the right edge sits past
// the last index, in bars. The same model as Lightweight Charts, so logical ranges carry over.

// Times are "YYYY-MM-DD" days or Unix seconds (intraday bars: Eastern wall-clock time as UTC).
export const timeKey = (time) => (typeof time === "number" ? time : Date.parse(`${time}T00:00:00Z`) / 1000);

// What a tick mark at each time starts: a year, a month, a day, or (intraday) just a later time.
const YEAR = 3, MONTH = 2, DAY = 1, TIME = 0;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Labels fall on round calendar and clock steps, so they hold still while you pan.
const YEAR_STEPS = [1, 2, 5, 10, 20, 50];
const MONTH_STEPS = [1, 2, 3, 6];
const DAY_STEPS = [1, 2, 3, 5, 7, 10, 15];
const MINUTE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240];

function weightOf(key, prev) {
  if (prev == null || Math.floor(key / 86400) === Math.floor(prev / 86400)) return prev == null ? DAY : TIME;
  const a = new Date(key * 1000), b = new Date(prev * 1000);
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return YEAR;
  return a.getUTCMonth() !== b.getUTCMonth() ? MONTH : DAY;
}

const minuteOfDay = (key) => Math.floor((key % 86400) / 60);

const pad = (n) => String(n).padStart(2, "0");

export class TimeScale {
  constructor() {
    this.times = []; // the time values as the series gave them
    this.keys = []; // the same as numbers, ascending
    this.lookup = new Map(); // key -> index
    this.weights = [];
    this.spacing = 6;
    this.rightOffset = 0;
    this.width = 0;
    this.minSpacing = 0.5;
    this.pending = null; // a range set before the chart had a width
  }

  get last() { return this.keys.length - 1; }

  // Rebuild from every series' sorted keys and points.
  rebuild(lists) {
    const merged = new Map();
    for (const { keys, points } of lists) for (let i = 0; i < keys.length; i++) merged.set(keys[i], points[i].time);
    const keys = [...merged.keys()].sort((a, b) => a - b);
    const same = keys.length === this.keys.length && keys.every((k, i) => k === this.keys[i]);
    if (same) return false;
    this.keys = [];
    this.times = [];
    this.lookup = new Map();
    this.weights = [];
    for (const key of keys) this.push(key, merged.get(key));
    return true;
  }

  push(key, time) {
    const i = this.keys.length;
    const weight = weightOf(key, i ? this.keys[i - 1] : null);
    this.keys.push(key);
    this.times.push(time);
    this.lookup.set(key, i);
    this.weights.push(weight);
  }

  indexOf(time) {
    const i = this.lookup.get(timeKey(time));
    return i == null ? null : i;
  }

  // Bar centres, in CSS pixels from the plot's left edge.
  x(i) { return this.width - (this.last + this.rightOffset - i + 0.5) * this.spacing; }
  logicalAt(x) { return Math.round(this.last + this.rightOffset + 0.5 - (this.width - x) / this.spacing); }

  range() {
    if (!this.keys.length) return null;
    if (this.width <= 0) return this.pending;
    const to = this.last + this.rightOffset;
    return { from: to - this.width / this.spacing + 1, to };
  }

  setRange({ from, to }) {
    if (this.width <= 0) { this.pending = { from, to }; return; }
    this.pending = null;
    this.spacing = Math.max(this.minSpacing, Math.min(this.maxSpacing(), this.width / Math.max(1, to - from + 1)));
    this.rightOffset = to - this.last;
  }

  maxSpacing() { return Math.max(this.minSpacing, this.width / 2); }

  // Zoom to `spacing`, keeping the right edge where it is (TradingView: the latest bar stays put).
  zoom(spacing) {
    this.spacing = Math.max(this.minSpacing, Math.min(this.maxSpacing(), spacing));
    this.clamp();
  }

  scroll(bars) {
    this.rightOffset += bars;
    this.clamp();
  }

  // Panning and zooming keep at least a few bars in view.
  clamp() {
    const most = this.width / this.spacing - 3;
    const least = 2 - this.last;
    if (most > least) this.rightOffset = Math.max(least, Math.min(most, this.rightOffset));
  }

  // Tick marks across the view at least `gap` px apart: years first, then months, days and
  // times of day, each on the roundest step that leaves room (every 5th year, each quarter, the
  // 1st/8th/15th, each half hour...).
  marks(gap, timeVisible) {
    const range = this.range();
    if (!range || this.width <= 0) return [];
    const lo = Math.max(0, Math.ceil(range.from - 0.5));
    const hi = Math.min(this.last, Math.floor(range.to + 0.5));
    if (hi < lo) return [];
    const k = gap / this.spacing; // bars between labels
    const chosen = [];
    const place = (i) => {
      let a = 0, b = chosen.length;
      while (a < b) { const m = (a + b) >> 1; if (chosen[m] < i) a = m + 1; else b = m; }
      if ((a < chosen.length && chosen[a] - i < k) || (a > 0 && i - chosen[a - 1] < k)) return;
      chosen.splice(a, 0, i);
    };
    const date = (i) => new Date(this.keys[i] * 1000);
    const perMark = (w) => {
      let n = 0;
      for (let i = lo; i <= hi; i++) if (this.weights[i] >= w) n++;
      return n ? (hi - lo + 1) / n : Infinity;
    };
    for (const [w, steps, unit] of [[YEAR, YEAR_STEPS, (d) => d.getUTCFullYear()], [MONTH, MONTH_STEPS, (d) => d.getUTCMonth()]]) {
      const n = steps.find((s) => s * perMark(w) >= k);
      if (n) for (let i = lo; i <= hi; i++) if (this.weights[i] === w && unit(date(i)) % n === 0) place(i);
    }
    const daysPerBar = hi > lo ? (this.keys[hi] - this.keys[lo]) / 86400 / (hi - lo) : 1;
    const days = DAY_STEPS.find((d) => d >= k * daysPerBar);
    if (days) {
      for (let i = Math.max(lo, 1); i <= hi; i++) {
        if (this.weights[i] !== DAY) continue;
        const day = date(i).getUTCDate(), prev = date(i - 1).getUTCDate();
        if (Math.floor((day - 1) / days) !== Math.floor((prev - 1) / days)) place(i);
      }
    }
    if (timeVisible) {
      let barMinutes = Infinity;
      for (let i = Math.max(lo, 1); i <= Math.min(hi, lo + 50); i++) {
        if (this.weights[i] === TIME) barMinutes = Math.min(barMinutes, (this.keys[i] - this.keys[i - 1]) / 60);
      }
      const minutes = MINUTE_STEPS.find((m) => m >= k * barMinutes);
      if (minutes) {
        for (let i = Math.max(lo, 1); i <= hi; i++) {
          if (this.weights[i] !== TIME) continue;
          if (Math.floor(minuteOfDay(this.keys[i]) / minutes) !== Math.floor(minuteOfDay(this.keys[i - 1]) / minutes)) place(i);
        }
      }
    }
    return chosen.map((i) => ({ i, x: this.x(i), text: this.markText(i), major: this.weights[i] >= MONTH }));
  }

  markText(i) {
    const date = new Date(this.keys[i] * 1000);
    const w = this.weights[i];
    if (w === YEAR) return String(date.getUTCFullYear());
    if (w === MONTH) return MONTHS[date.getUTCMonth()];
    if (w === DAY) return String(date.getUTCDate());
    return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  }

  // The crosshair's label: "Wed 12 Mar '26", with the time on intraday charts.
  label(i, timeVisible) {
    if (i < 0 || i > this.last) return "";
    const date = new Date(this.keys[i] * 1000);
    const day = `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} '${String(date.getUTCFullYear()).slice(2)}`;
    return timeVisible ? `${day}  ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : day;
  }
}
