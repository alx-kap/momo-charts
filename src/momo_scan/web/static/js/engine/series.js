// Series: candles, OHLC bars, lines and histograms. Each keeps its points with their logical
// indexes on the shared time axis and paints the ones in view, snapped to device pixels so
// bodies, wicks and columns stay crisp at any zoom.

import { priceFormatter } from "./pricescale.js";
import { timeKey } from "./timescale.js";

export const LineStyle = { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 };

export function dash(style, width) {
  const w = Math.max(1, width);
  switch (Number(style)) {
    case LineStyle.Dotted: return [w, w];
    case LineStyle.Dashed: return [2 * w, 2 * w];
    case LineStyle.LargeDashed: return [6 * w, 6 * w];
    case LineStyle.SparseDotted: return [w, 4 * w];
    default: return [];
  }
}

const COMMON = {
  title: "", visible: true, lastValueVisible: true, priceLineVisible: true, priceLineWidth: 1,
  priceLineColor: "", priceLineStyle: LineStyle.Dashed, priceFormat: { type: "price", precision: 2, minMove: 0.01 },
  priceScaleId: "right", crosshairMarkerVisible: true, autoscaleInfoProvider: undefined,
};
const DEFAULTS = {
  Candlestick: {
    upColor: "#26a69a", downColor: "#ef5350", wickVisible: true, borderVisible: true,
    borderUpColor: "#26a69a", borderDownColor: "#ef5350", wickUpColor: "#26a69a", wickDownColor: "#ef5350",
  },
  Bar: { upColor: "#26a69a", downColor: "#ef5350", openVisible: true, thinBars: true },
  Line: { color: "#2196f3", lineWidth: 3, lineStyle: LineStyle.Solid, lineVisible: true },
  // columnWidth: the share of a bar's slot a column fills (1 for a solid band, like session shading).
  Histogram: { color: "#26a69a", base: 0, columnWidth: 0.8 },
};

const ohlc = (type) => type === "Candlestick" || type === "Bar";
// "transparent", #rrggbb00 or rgba(..., 0).
const seeThrough = (color) => !color || color === "transparent" || /^#[0-9a-f]{6}00$/i.test(color) ||
  /^rgba\(.*,\s*0(\.0*)?\s*\)$/.test(color);

export class Series {
  constructor(chart, type, options, pane) {
    this.chart = chart;
    this.type = type;
    this.pane = pane;
    this.options = { ...COMMON, ...DEFAULTS[type], ...options };
    this.points = []; // as given, ascending by time
    this.keys = [];
    this.idx = []; // each point's logical index
    this.lines = []; // price lines
    this.order = 0;
    this._formatter = null;
  }

  has(point) { return ohlc(this.type) ? point.close != null : point.value != null; }
  valueOf(point) { return ohlc(this.type) ? point.close : point.value; }

  formatter() {
    return (this._formatter ||= priceFormatter(this.options.priceFormat));
  }

  setData(points) {
    this.points = points.slice();
    this.keys = this.points.map((p) => timeKey(p.time));
    this.idx = [];
    this.chart._timesChanged();
  }

  // A new last point, or a new version of the last one (live bars).
  update(point) {
    const key = timeKey(point.time);
    const n = this.points.length;
    if (n && key === this.keys[n - 1]) {
      this.points[n - 1] = point;
      this.chart._dataChanged();
      return;
    }
    if (n && key < this.keys[n - 1]) {
      const at = this.keys.indexOf(key);
      if (at >= 0) { this.points[at] = point; this.chart._dataChanged(); }
      return;
    }
    this.points.push(point);
    this.keys.push(key);
    this.chart._timeAppended(this, key, point.time);
  }

  // Map points to logical indexes after the time axis changed.
  reindex(scale) {
    this.idx = this.keys.map((key) => scale.lookup.get(key));
  }

  // The first point at or after logical index `i`.
  lowerBound(i) {
    let a = 0, b = this.idx.length;
    while (a < b) { const m = (a + b) >> 1; if (this.idx[m] < i) a = m + 1; else b = m; }
    return a;
  }

  // Lowest and highest values between two logical indexes, for auto-scaling.
  extent(from, to) {
    if (!this.options.visible || this.options.autoscaleInfoProvider) {
      const info = this.options.autoscaleInfoProvider && this.options.autoscaleInfoProvider();
      if (!info) return null;
      return info.priceRange ? { min: info.priceRange.minValue, max: info.priceRange.maxValue } : null;
    }
    let min = Infinity, max = -Infinity;
    const end = this.idx.length;
    for (let n = this.lowerBound(Math.floor(from)); n < end && this.idx[n] <= to; n++) {
      const p = this.points[n];
      if (!this.has(p)) continue;
      if (ohlc(this.type)) { min = Math.min(min, p.low); max = Math.max(max, p.high); } else { min = Math.min(min, p.value); max = Math.max(max, p.value); }
    }
    if (this.type === "Histogram" && min <= max) { min = Math.min(min, this.options.base); max = Math.max(max, this.options.base); }
    return min <= max ? { min, max } : null;
  }

  // The newest point with a value, for the last-price line and label.
  lastPoint() {
    for (let n = this.points.length - 1; n >= 0; n--) if (this.has(this.points[n])) return this.points[n];
    return null;
  }

  // The last-price tag and line: the bar's colour. A hollow candle's body is see-through, so it
  // takes the border's (Lightweight Charts makes it black).
  lastColor(point) {
    const o = this.options;
    if (!ohlc(this.type)) return point.color || o.color;
    const up = point.close >= point.open;
    const body = point.color || (up ? o.upColor : o.downColor);
    if (this.type !== "Candlestick" || !seeThrough(body)) return body;
    return point.borderColor || (o.borderVisible ? (up ? o.borderUpColor : o.borderDownColor) : (up ? o.wickUpColor : o.wickDownColor));
  }

  // ---------- painting ----------
  // `v` is the view: { ctx, dpr, scale (price), time (time scale), from, to } with the context's
  // origin at the pane's top-left in device pixels.

  paint(v) {
    if (!this.options.visible || !this.points.length) return;
    if (this.type === "Candlestick") this.paintCandles(v);
    else if (this.type === "Bar") this.paintBars(v);
    else if (this.type === "Line") this.paintLine(v);
    else if (this.type === "Histogram") this.paintHistogram(v);
  }

  // Each visible point with its pixel x, as [point, x] pairs.
  visible(v, margin = 1) {
    const out = [];
    const end = this.idx.length;
    for (let n = this.lowerBound(Math.floor(v.from) - margin); n < end && this.idx[n] <= v.to + margin; n++) {
      const p = this.points[n];
      if (this.has(p)) out.push([p, v.time.x(this.idx[n])]);
    }
    return out;
  }

  // Widths in device pixels for a bar's body and wick at this zoom. Odd bodies centre on the wick.
  widths(dpr, spacing) {
    const wick = Math.max(1, Math.floor(dpr));
    let body = Math.floor(spacing * dpr * 0.8);
    if (body >= spacing * dpr) body = Math.floor(spacing * dpr) - 1;
    if ((body - wick) % 2) body -= 1;
    return { wick, body: Math.max(wick, body) };
  }

  paintCandles(v) {
    const { ctx, dpr, scale } = v;
    const o = this.options;
    const items = this.visible(v);
    const { wick, body } = this.widths(dpr, v.time.spacing);
    if (v.time.spacing * dpr < 2) return this.paintColumns(v, items, (p) => (p.close >= p.open ? o.wickUpColor : o.wickDownColor));
    const y = (price) => Math.round(scale.coordinate(price) * dpr);
    const groups = new Map(); // colour -> rects
    const add = (color, x, top, w, h) => {
      if (!color) return;
      let list = groups.get(color);
      if (!list) groups.set(color, (list = []));
      list.push(x, top, w, h);
    };
    const border = o.borderVisible && body > 2 * wick + 1 ? wick : 0;
    for (const [p, xc] of items) {
      const up = p.close >= p.open;
      const cx = Math.round(xc * dpr);
      const hi = y(p.high), lo = y(p.low), op = y(p.open), cl = y(p.close);
      const top = Math.min(op, cl), bottom = Math.max(op, cl);
      const left = cx - Math.floor(body / 2);
      const h = Math.max(1, bottom - top);
      if (o.wickVisible) {
        const color = p.wickColor || (up ? o.wickUpColor : o.wickDownColor);
        const wl = cx - Math.floor(wick / 2);
        add(color, wl, hi, wick, top - hi);
        add(color, wl, top + h, wick, lo - top - h);
      }
      const fill = p.color || (up ? o.upColor : o.downColor);
      if (border) {
        const edge = p.borderColor || (up ? o.borderUpColor : o.borderDownColor);
        add(edge, left, top, body, border);
        add(edge, left, top + h - border, body, border);
        add(edge, left, top + border, border, h - 2 * border);
        add(edge, left + body - border, top + border, border, h - 2 * border);
        add(fill, left + border, top + border, body - 2 * border, h - 2 * border);
      } else {
        add(o.borderVisible && body <= 2 * wick + 1 ? (p.borderColor || (up ? o.borderUpColor : o.borderDownColor)) : fill, left, top, body, h);
      }
    }
    fillGroups(ctx, groups);
  }

  paintBars(v) {
    const { ctx, dpr, scale } = v;
    const o = this.options;
    const items = this.visible(v);
    if (v.time.spacing * dpr < 2) return this.paintColumns(v, items, (p) => p.color || (p.close >= p.open ? o.upColor : o.downColor));
    const line = o.thinBars ? Math.max(1, Math.floor(dpr)) : Math.max(1, Math.floor(v.time.spacing * dpr / 6));
    const arm = Math.max(line, Math.floor(v.time.spacing * dpr * 0.4));
    const y = (price) => Math.round(scale.coordinate(price) * dpr);
    const groups = new Map();
    for (const [p, xc] of items) {
      const color = p.color || (p.close >= p.open ? o.upColor : o.downColor);
      let list = groups.get(color);
      if (!list) groups.set(color, (list = []));
      const cx = Math.round(xc * dpr) - Math.floor(line / 2);
      const hi = y(p.high), lo = y(p.low);
      list.push(cx, hi, line, Math.max(line, lo - hi));
      if (o.openVisible) list.push(cx - arm, y(p.open) - Math.floor(line / 2), arm, line);
      list.push(cx + line, y(p.close) - Math.floor(line / 2), arm, line);
    }
    fillGroups(ctx, groups);
  }

  paintLine(v) {
    const { ctx, dpr, scale } = v;
    const o = this.options;
    if (!o.lineVisible) return;
    const items = this.visible(v, 1);
    // A line runs from the last point before the view (HVC levels span far past the edge).
    const first = this.lowerBound(Math.floor(v.from) - 1);
    for (let n = first - 1; n >= 0; n--) {
      if (this.has(this.points[n])) { items.unshift([this.points[n], v.time.x(this.idx[n])]); break; }
    }
    if (!items.length) return;
    const path = v.time.spacing * dpr < 1 ? thin(items, dpr) : items;
    ctx.save();
    ctx.strokeStyle = o.color;
    ctx.lineWidth = o.lineWidth * dpr;
    ctx.lineJoin = "round";
    ctx.lineCap = "butt";
    ctx.setLineDash(dash(o.lineStyle, o.lineWidth * dpr));
    ctx.beginPath();
    path.forEach(([p, x], n) => {
      const px = x * dpr, py = scale.coordinate(p.value) * dpr;
      if (n) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    if (items.length === 1) ctx.lineTo(items[0][1] * dpr + 0.01, scale.coordinate(items[0][0].value) * dpr);
    ctx.stroke();
    ctx.restore();
  }

  paintHistogram(v) {
    const { ctx, dpr, scale } = v;
    const o = this.options;
    const items = this.visible(v);
    const spacing = v.time.spacing * dpr;
    const base = Math.round(scale.coordinate(o.base) * dpr);
    const groups = new Map();
    const solid = o.columnWidth >= 1;
    let width = Math.max(1, Math.floor(spacing * o.columnWidth));
    if (!solid && width >= spacing && spacing > 2) width = Math.floor(spacing) - 1;
    const dense = spacing < 2;
    const open = new Map(); // colour -> the column being merged: [x, top, bottom]
    for (const [p, xc] of items) {
      const color = p.color || o.color;
      let list = groups.get(color);
      if (!list) groups.set(color, (list = []));
      const yv = Math.round(scale.coordinate(p.value) * dpr);
      if (dense) {
        // Bars sharing a pixel column become one column, as tall as the tallest.
        const cx = Math.round(xc * dpr), top = Math.min(yv, base), bottom = Math.max(yv, base) || top + 1;
        const col = open.get(color);
        if (col && col[0] === cx) { col[1] = Math.min(col[1], top); col[2] = Math.max(col[2], bottom); continue; }
        if (col) list.push(col[0], col[1], 1, Math.max(1, col[2] - col[1]));
        open.set(color, [cx, top, bottom]);
        continue;
      }
      const top = Math.min(yv, base), h = Math.max(1, Math.abs(base - yv));
      if (solid) {
        // Edges at the slot boundaries, so neighbours meet without seams or overlaps.
        const left = Math.round((xc - v.time.spacing / 2) * dpr), right = Math.round((xc + v.time.spacing / 2) * dpr);
        list.push(left, top, right - left, h);
      } else {
        list.push(Math.round(xc * dpr) - Math.floor(width / 2), top, width, h);
      }
    }
    for (const [color, col] of open) groups.get(color).push(col[0], col[1], 1, Math.max(1, col[2] - col[1]));
    fillGroups(ctx, groups);
  }

  // Zoomed far out (under 2 device px a bar): one high-to-low column per pixel and colour.
  paintColumns(v, items, colorOf) {
    const { ctx, dpr, scale } = v;
    const w = Math.max(1, Math.floor(dpr));
    const groups = new Map();
    const open = new Map();
    for (const [p, xc] of items) {
      const color = colorOf(p);
      const cx = Math.round(xc * dpr);
      const hi = Math.round(scale.coordinate(p.high) * dpr), lo = Math.round(scale.coordinate(p.low) * dpr);
      const col = open.get(color);
      if (col && col[0] === cx) { col[1] = Math.min(col[1], hi); col[2] = Math.max(col[2], lo); continue; }
      if (col) groups.get(color).push(col[0], col[1], w, Math.max(1, col[2] - col[1]));
      if (!groups.has(color)) groups.set(color, []);
      open.set(color, [cx, hi, lo]);
    }
    for (const [color, col] of open) groups.get(color).push(col[0], col[1], w, Math.max(1, col[2] - col[1]));
    fillGroups(ctx, groups);
  }
}

// A line's points thinned to the first, lowest, highest and last in each device pixel.
function thin(items, dpr) {
  const out = [];
  let column = null, bucket = [];
  const flush = () => {
    if (!bucket.length) return;
    let lo = bucket[0], hi = bucket[0];
    for (const item of bucket) {
      if (item[0].value < lo[0].value) lo = item;
      if (item[0].value > hi[0].value) hi = item;
    }
    const keep = new Set([bucket[0], lo, hi, bucket[bucket.length - 1]]);
    for (const item of bucket) if (keep.has(item)) out.push(item);
  };
  for (const item of items) {
    const cx = Math.round(item[1] * dpr);
    if (cx !== column) { flush(); bucket = []; column = cx; }
    bucket.push(item);
  }
  flush();
  return out;
}

// One fill colour at a time. fillRect per rect: the rasteriser handles big, many-rect areas
// (volume columns) far faster that way than as one path.
function fillGroups(ctx, groups) {
  for (const [color, rects] of groups) {
    ctx.fillStyle = color;
    for (let n = 0; n < rects.length; n += 4) if (rects[n + 2] > 0 && rects[n + 3] > 0) ctx.fillRect(rects[n], rects[n + 1], rects[n + 2], rects[n + 3]);
  }
}
