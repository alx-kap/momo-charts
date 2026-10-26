import { api, ticker } from "./util.js";
import { state, throughDate } from "./state.js";
import { onLiveBars, onLiveQuotes, watchBars, watchLive } from "./live.js";

// The shared data layer: one copy of a chart's bars per symbol, timeframe, end date and length,
// loaded once and cached. Live quotes are merged into every copy that runs to today once, here,
// however many charts and panels show it; they subscribe to a series and redraw from its bars.

export const DECK_BARS = 520; // review and practice charts
// Chart mode: years of daily history, weeks of intraday. Keyed by the interval's last letter.
export const CHART_BARS = { D: 1300, W: 520, M: 520, m: 1500, h: 1500 };
const LIVE_INTERVALS = new Set(["1D", "1W", "1M"]);
// Intraday intervals and their minutes; served from momo's intraday store (/api/intraday).
export const INTRADAY = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60 };
export const isIntraday = (interval) => interval in INTRADAY;
const REFRESH_SECONDS = 30; // an intraday series nobody watched for this long reloads on open
const PREFETCH_WORKERS = 4;

const cache = state.barCache; // key -> Series; cleared when a new scan loads

class Series {
  constructor(key, symbol, through, interval, count) {
    Object.assign(this, { key, symbol, through, interval, count });
    this.data = null; // the /api/bars payload once loaded; its bars are kept live in place
    this.promise = null;
    this.listeners = new Set();
    this.liveBase = null; // weekly/monthly: the period's bar before today, per day
  }

  load() {
    if (!this.promise) {
      const params = new URLSearchParams({ symbol: this.symbol, interval: this.interval, count: this.count });
      if (this.through) params.set("through", this.through);
      this.promise = api(`/api/bars?${params}`).then((data) => {
        this.data = data;
        if (this.interval === "1D") noteDayChange(this.symbol, this.through, data);
        return data;
      }).catch((error) => {
        cache.delete(this.key);
        throw error;
      });
    }
    return this.promise;
  }

  // Runs to today, so live quotes extend it. Never past scans or practice (they have an end date).
  get liveable() {
    return this.through == null && LIVE_INTERVALS.has(this.interval) && Boolean(this.data && this.data.last_day);
  }

  get ticker() {
    return ticker(this.data ? this.data.symbol : this.symbol);
  }

  // fn({ bar, added }) after each live update; returns the unsubscribe.
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  apply(quote) {
    const bars = this.data.bars;
    const last = bars[bars.length - 1];
    const bar = last && this.liveBar(quote, last);
    if (!bar) return;
    const added = bar.time > last.time;
    if (added) bars.push(bar);
    else bars[bars.length - 1] = bar;
    for (const fn of this.listeners) fn({ bar, added });
  }

  // The newest bar with a live quote in it, or null. Daily: today's bar, replaced while it
  // forms and added when a new session opens. Weekly and monthly: the period's bar as it stood
  // before today, with today's trading merged in.
  liveBar(quote, last) {
    const unit = this.interval.slice(-1);
    if (unit === "D") return quote.day < last.time ? null : dailyBar(quote, last);
    const today = dailyBar(quote, last);
    const lastDay = this.data.last_day;
    if (quote.day < lastDay) return null;
    if (quote.day === lastDay) {
      // The archive already has today in this bar: follow the price, keep its volume.
      return { ...last, high: Math.max(last.high, today.high), low: Math.min(last.low, today.low), close: today.close };
    }
    if (!this.liveBase || this.liveBase.day !== quote.day) {
      // First quote of the day: today either opens a new period or extends the last bar.
      const fresh = periodOf(last.time, unit) !== periodOf(quote.day, unit);
      this.liveBase = { day: quote.day, bar: fresh ? null : { ...last } };
    }
    const base = this.liveBase.bar;
    if (!base) return { ...today, volume: quote.volume ?? 0 };
    return {
      ...base, high: Math.max(base.high, today.high), low: Math.min(base.low, today.low), close: today.close,
      volume: base.volume + (quote.volume ?? 0),
    };
  }
}

// Today's daily bar from a live quote (`live` marks it as not yet in the archive).
function dailyBar(quote, last) {
  const close = quote.last;
  if (quote.day === last.time) {
    // The bar is already there: merge, never shrink it. Before the open Schwab sends no
    // open/high/low (yesterday's quote, zeroed), which alone would flatten it to a dash.
    return {
      ...last, open: quote.open ?? last.open, close,
      high: Math.max(last.high, quote.high ?? close, close), low: Math.min(last.low, quote.low ?? close, close),
      volume: quote.volume ?? last.volume,
    };
  }
  return {
    time: quote.day, open: quote.open ?? close,
    high: Math.max(quote.high ?? close, close), low: Math.min(quote.low ?? close, close), close,
    volume: quote.volume ?? (quote.day === last.time ? last.volume : 0), live: true,
  };
}

// The week or month a day falls in, to tell whether today extends the last bar.
function periodOf(day, unit) {
  if (unit === "M") return day.slice(0, 7);
  const date = new Date(`${day}T00:00:00Z`);
  const monday = new Date(date - ((date.getUTCDay() + 6) % 7) * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

// ---------- intraday ----------
// Times on intraday charts are New York wall-clock seconds (the chart library shows UTC, so
// each bar is shifted by the zone's offset); `t` keeps the real time.

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const offsets = new Map(); // UTC hour -> offset seconds (changes only on the hour, twice a year)
export function etShift(t) {
  const hour = Math.floor(t / 3600);
  let offset = offsets.get(hour);
  if (offset == null) {
    const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(hour * 3_600_000)).map((x) => [x.type, x.value]));
    offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 1000 - hour * 3600;
    offsets.set(hour, offset);
  }
  return t + offset;
}

const OPEN = 9.5 * 3600; // 9:30
const CLOSE = 16 * 3600;
export const inRegular = (shifted) => { const s = ((shifted % 86400) + 86400) % 86400; return s >= OPEN && s < CLOSE; };

// The bar a (shifted) time falls in; bars are anchored at 9:30 like TradingView's.
function bucketOf(shifted, seconds) {
  const anchor = shifted - (((shifted % 86400) + 86400) % 86400) + OPEN;
  return anchor + Math.floor((shifted - anchor) / seconds) * seconds;
}

// The daily payload's facts about the stock, for the chart's title and info table.
const META = ["symbol", "company", "industry", "sector", "market_cap", "adr20", "adv20"];

// An intraday chart's bars. The forming bar is made of the stream's finished minutes in it
// (`done`) plus, since the last of those, the live quote: high, low and last trade, and the
// volume traded since (from the day's running total).
class IntradaySeries {
  constructor(key, symbol, interval, count, extended) {
    Object.assign(this, { key, symbol, interval, count, extended, through: null });
    this.seconds = INTRADAY[interval] * 60;
    this.data = null;
    this.promise = null;
    this.loadedAt = 0;
    this.listeners = new Set();
    // Bars still open to updates, by bucket: { bucket, done, high, low, close, since, volumeAt }.
    // The stream sends a minute just after it ends, when quotes have already opened the next
    // bar, so the last few stay open for their late minutes.
    this.forming = new Map();
    this.lastVolume = null; // the quote's day volume at the latest update
  }

  load() {
    // A series nobody kept live may have missed finished bars: reload (the store answers fast).
    const stale = !this.listeners.size && Date.now() / 1000 - this.loadedAt > REFRESH_SECONDS;
    if (!this.promise || (this.data && stale)) {
      const params = new URLSearchParams({ symbol: this.symbol, interval: this.interval, count: this.count, extended: this.extended });
      const daily = series(this.symbol, { interval: "1D", count: CHART_BARS.D }).load().catch(() => null);
      const promise = Promise.all([api(`/api/intraday?${params}`), daily]).then(([raw, day]) => {
        const meta = day ? Object.fromEntries(META.map((key) => [key, day[key]])) : { symbol: this.symbol };
        const bars = raw.bars.map((bar) => ({ ...bar, t: bar.time, time: etShift(bar.time) }));
        this.data = { ...meta, interval: this.interval, intraday: true, extended: this.extended, bars };
        this.loadedAt = Date.now() / 1000;
        this.forming.clear();
        return this.data;
      }).catch((error) => {
        if (this.promise === promise) cache.delete(this.key);
        throw error;
      });
      this.promise = promise;
    }
    return this.promise;
  }

  get liveable() { return Boolean(this.data); }
  get ticker() { return ticker(this.data ? this.data.symbol : this.symbol); }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // The bar a time belongs in, or null outside the chart's hours.
  bucket(t) {
    const shifted = etShift(t);
    if (!this.extended && !inRegular(shifted)) return null;
    return bucketOf(shifted, this.seconds);
  }

  // The open bar for `bucket`: kept, or started (seeded from the loaded bar when the server
  // sent it still forming). Null for a bar older than the open ones.
  formingFor(bucket) {
    if (this.forming.has(bucket)) return this.forming.get(bucket);
    const bars = this.data.bars;
    const last = bars[bars.length - 1];
    if (last && last.time > bucket) return null;
    const seeded = last && last.time === bucket ? { o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume } : null;
    const forming = { bucket, done: seeded, high: null, low: null, close: null, since: 0, volumeAt: this.lastVolume };
    this.forming.set(bucket, forming);
    for (const old of [...this.forming.keys()].sort((a, b) => a - b).slice(0, -3)) this.forming.delete(old);
    return forming;
  }

  // A finished minute from the stream.
  minute([t, o, h, l, c, v]) {
    if (t + 60 <= this.loadedAt - 5) return; // already in what was loaded
    const bucket = this.bucket(t);
    if (bucket == null) return;
    const forming = this.formingFor(bucket);
    if (!forming) return;
    const done = forming.done;
    forming.done = done ? { o: done.o, h: Math.max(done.h, h), l: Math.min(done.l, l), c, v: done.v + v } : { o, h, l, c, v };
    // The quote's moves up to now are inside this minute (only for the newest bar: a late minute
    // for the previous bar leaves the next one's quotes alone).
    if (this.newest() === bucket) Object.assign(forming, { high: null, low: null, close: null, since: 0, volumeAt: this.lastVolume });
    else Object.assign(forming, { high: null, low: null, close: null, since: 0 });
    this.emit(forming);
  }

  quote(quote) {
    const price = quote.trade ?? quote.last;
    const volume = quote.volume ?? quote.pre_volume; // before the open, the day's total is pre-market
    const bucket = this.bucket(Date.now() / 1000);
    if (bucket == null || price == null) return;
    const forming = this.formingFor(bucket);
    if (!forming) return;
    if (forming.volumeAt == null && volume != null) forming.volumeAt = volume;
    this.lastVolume = volume ?? this.lastVolume;
    forming.high = Math.max(forming.high ?? price, price);
    forming.low = Math.min(forming.low ?? price, price);
    forming.close = price;
    forming.since = volume != null && forming.volumeAt != null ? Math.max(0, volume - forming.volumeAt) : 0;
    this.emit(forming);
  }

  newest() {
    return Math.max(...this.forming.keys());
  }

  emit(forming) {
    const done = forming.done;
    if (!done && forming.close == null) return;
    const bar = {
      time: forming.bucket, t: forming.bucket,
      open: done ? done.o : forming.close,
      high: Math.max(done ? done.h : -Infinity, forming.high ?? -Infinity),
      low: Math.min(done ? done.l : Infinity, forming.low ?? Infinity),
      close: forming.close ?? done.c,
      volume: (done ? done.v : 0) + (forming.close == null ? 0 : forming.since || 0),
    };
    const bars = this.data.bars;
    const added = !bars.length || bar.time > bars[bars.length - 1].time;
    if (added) bars.push(bar);
    else {
      const at = bars.findLastIndex((item) => item.time === bar.time);
      if (at < 0) return;
      bars[at] = bar;
      if (at < bars.length - 1) return void this.notify({ bar, added: false, index: at });
    }
    this.notify({ bar, added, index: bars.length - 1 });
  }

  notify(update) {
    for (const fn of this.listeners) fn(update);
  }
}

// Every loaded series that runs to today takes the quote once, shown or not, so switching back
// to a symbol shows its latest bar at once.
onLiveQuotes((quotes) => {
  for (const item of cache.values()) {
    if (!item.liveable) continue;
    const quote = quotes.get(item.ticker);
    if (!quote) continue;
    if (item instanceof IntradaySeries) item.quote(quote);
    else item.apply(quote);
  }
});

onLiveBars((symbol, rows) => {
  for (const item of cache.values()) {
    if (item instanceof IntradaySeries && item.liveable && item.ticker === symbol) for (const row of rows) item.minute(row);
  }
});

export function series(symbol, { through = null, interval = "1D", count = DECK_BARS, extended = false } = {}) {
  if (isIntraday(interval)) {
    const key = `${symbol}|${interval}|${count}|${extended ? "ext" : "rth"}`;
    if (!cache.has(key)) cache.set(key, new IntradaySeries(key, symbol, interval, count, extended));
    return cache.get(key);
  }
  const key = `${symbol}|${through || ""}|${interval}|${count}`;
  if (!cache.has(key)) cache.set(key, new Series(key, symbol, through, interval, count));
  return cache.get(key);
}

export const fetchBars = (symbol, through, interval = "1D", count = DECK_BARS, extended = state.extended) =>
  series(symbol, { through, interval, count, extended }).load();

// What each part of the screen shows live ("chart", "details"): its symbol is streamed while
// shown. Returns the unsubscribe for `onUpdate`, or null when the series isn't live.
export function showLive(owner, item, onUpdate) {
  const live = Boolean(item && item.liveable);
  watchLive(owner, live ? [item.ticker] : []);
  watchBars(owner, live && item instanceof IntradaySeries ? [item.ticker] : []);
  return live && onUpdate ? item.subscribe(onUpdate) : null;
}

// The scan-day change shown in the scan list comes from the same bars the chart uses.
function noteDayChange(symbol, through, data) {
  if (!state.deck || through !== state.deck.as_of) return;
  const bars = data.bars;
  if (bars.length < 2) return;
  const last = bars[bars.length - 1].close;
  const prev = bars[bars.length - 2].close;
  state.dayChange.set(symbol, (last / prev - 1) * 100);
  document.dispatchEvent(new CustomEvent("momo:daychange", { detail: symbol }));
}

// ---------- prefetch ----------

// Hovering a row in a list: load its chart (and the details panel's daily bars) and start its
// live quote, so a click shows both at once. A short pause first, so sweeping across a list
// doesn't load every row on the way.
const HOVER_MS = 90;
let hoverTimer = 0;
let hovered = null;
export function warmSymbol(symbol) {
  if (symbol === hovered) return; // moving within the same row
  hovered = symbol;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    const interval = state.interval;
    fetchBars(symbol, null, interval, CHART_BARS[interval.slice(-1)]).catch(() => {});
    if (interval !== "1D") fetchBars(symbol, null, "1D", CHART_BARS.D).catch(() => {});
    watchLive("hover", [symbol]);
  }, HOVER_MS);
}

// Warm the cache for the charts Space/arrows will reach next (chart mode).
export function prefetchSymbols(symbols, interval, count) {
  for (const symbol of symbols) fetchBars(symbol, null, interval, count).catch(() => {});
}

// The review deck's next charts.
export function prefetchNeighbors() {
  if (!state.deck || state.adhoc) return;
  for (const offset of [1, 2, -1]) {
    const card = state.deck.cards[state.index + offset];
    if (card) fetchBars(card.symbol, throughDate(), state.interval).catch(() => {});
  }
}

// Load every chart in the deck in the background, nearest first, so flipping never waits.
export function prefetchDeck() {
  if (!state.deck) return;
  const token = ++state.prefetchToken;
  const through = throughDate();
  const order = state.deck.cards
    .map((card, i) => ({ card, distance: Math.abs(i - state.index) }))
    .sort((a, b) => a.distance - b.distance)
    .map((item) => item.card);
  let next = 0;
  const worker = async () => {
    while (token === state.prefetchToken && next < order.length) {
      const card = order[next++];
      try { await fetchBars(card.symbol, through, state.interval); } catch {}
    }
  };
  for (let n = 0; n < PREFETCH_WORKERS; n++) worker();
}
