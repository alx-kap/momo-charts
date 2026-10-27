// One chart: panes stacked over a shared time axis, a price axis on the right, painted on two
// canvases (the chart, and the crosshair over it so moving the pointer repaints almost nothing).
// The API follows the parts of Lightweight Charts momo uses, so chart.js can run on either.

import { TimeScale } from "./timescale.js";
import { PriceScale } from "./pricescale.js";
import { LineStyle, Series, dash } from "./series.js";

export const CrosshairMode = { Normal: 0, Magnet: 1, Hidden: 2, MagnetOHLC: 3 };
export const ColorType = { Solid: "solid", VerticalGradient: "gradient" };

const SEPARATOR = 1; // px between panes
const MIN_PANE = 30; // px a pane keeps when you drag the line between two
const FAMILY = "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";

const defaults = () => ({
  layout: {
    background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#191919", fontSize: 12, fontFamily: FAMILY,
    panes: { enableResize: true, separatorColor: "#2b2b43", separatorHoverColor: "rgba(178, 181, 190, 0.2)" },
  },
  grid: { vertLines: { visible: true, color: "#d6dcde", style: LineStyle.Solid }, horzLines: { visible: true, color: "#d6dcde", style: LineStyle.Solid } },
  crosshair: {
    mode: CrosshairMode.Magnet,
    vertLine: { visible: true, labelVisible: true, color: "#9598a1", width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: "#131722" },
    horzLine: { visible: true, labelVisible: true, color: "#9598a1", width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: "#131722" },
  },
  rightPriceScale: { borderVisible: false },
  timeScale: { visible: true, timeVisible: false, secondsVisible: false, rightOffset: 0, barSpacing: 6, minBarSpacing: 0.5, borderVisible: false },
});

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (isObject(value) && isObject(target[key])) merge(target[key], value);
    else target[key] = isObject(value) ? merge({}, value) : value;
  }
  return target;
}

// Dark text on light label backgrounds, white on dark ones.
const probe = document.createElement("canvas").getContext("2d");
const contrasts = new Map();
function contrast(color) {
  let text = contrasts.get(color);
  if (text) return text;
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  const value = probe.fillStyle;
  const [r, g, b] = value[0] === "#"
    ? [1, 3, 5].map((n) => parseInt(value.slice(n, n + 2), 16))
    : value.match(/[\d.]+/g).map(Number);
  text = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#131722" : "#ffffff";
  contrasts.set(color, text);
  return text;
}

class Pane {
  constructor(chart) {
    this.chart = chart;
    this.series = [];
    this.scales = new Map([["right", new PriceScale("right")]]);
    this.stretch = 1;
    this.top = 0;
    this.height = 0;
    this.watermark = null;
    this.api = {
      getHeight: () => { chart._ensure(); return this.height; },
      setStretchFactor: (factor) => { this.stretch = factor; chart._changed(); },
      getStretchFactor: () => this.stretch,
      getHTMLElement: () => null,
      paneIndex: () => chart.panes_.indexOf(this),
      getSeries: () => this.series.map((s) => s.api),
      _pane: this,
    };
  }

  get right() { return this.scales.get("right"); }

  scale(id) {
    const key = id || "";
    if (!this.scales.has(key)) this.scales.set(key, new PriceScale(key));
    return this.scales.get(key);
  }
}

export class Chart {
  constructor(container, options = {}) {
    this.el = container;
    this.o = merge(defaults(), options);
    this.time = new TimeScale();
    this.panes_ = [new Pane(this)];
    this.order = 0;
    this.timesDirty = false;
    this.layoutDirty = true;
    this.frame = 0;
    this.axisW = 0;
    this.plotW = 0;
    this.timeH = 0;
    this.width = 0;
    this.height = 0;
    this.cross = null; // { x, pane, y } from the pointer, or { index, pane, price, series } set by code
    this.drag = null;
    this.touches = new Map(); // pointerId -> point, for pinch zoom
    this.pinch = null;
    this.glide = 0; // the momentum scroll's animation frame
    this.hoverSeparator = -1;
    this.subs = { crosshair: [], click: [], range: [], size: [] };
    this.lastRange = null;
    this.lastSize = null;
    this.applyTimeOptions(this.o.timeScale);

    container.style.touchAction = "none";
    container.style.userSelect = "none";
    this.canvas = this.makeCanvas();
    this.top = this.makeCanvas();
    this.top.style.pointerEvents = "none";
    this.ctx = this.canvas.getContext("2d");
    this.topCtx = this.top.getContext("2d");

    this.observer = new ResizeObserver(() => this._changed());
    this.observer.observe(container);
    this.bindInput();
    this.api = this.makeApi();
  }

  makeCanvas() {
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", display: "block" });
    this.el.appendChild(canvas);
    return canvas;
  }

  applyTimeOptions(o) {
    if (o.minBarSpacing != null) this.time.minSpacing = o.minBarSpacing;
    if (o.barSpacing != null) this.time.spacing = o.barSpacing;
    if (o.rightOffset != null) this.time.rightOffset = o.rightOffset;
  }

  allSeries() { return this.panes_.flatMap((pane) => pane.series); }

  // ---------- change tracking ----------

  _timesChanged() { this.timesDirty = true; this._changed(); }
  _dataChanged() { this._changed(); }

  // A point added after a series' last one: usually a new time at the end of the axis.
  _timeAppended(series, key, time) {
    const lookup = this.time.lookup.get(key);
    if (this.timesDirty) { /* rebuilt on the next read */ } else if (lookup != null) {
      series.idx.push(lookup);
    } else if (!this.time.keys.length || key > this.time.keys[this.time.last]) {
      this.time.push(key, time);
      series.idx.push(this.time.last);
      if (this.time.rightOffset < 0) this.time.rightOffset -= 1; // scrolled back: the view stays put
    } else {
      this.timesDirty = true;
    }
    this._changed();
  }

  _changed() {
    this.layoutDirty = true;
    this.schedule();
  }

  schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  // Bring the time axis, sizes and price ranges up to date before anything reads coordinates.
  _ensure() {
    if (this.timesDirty) {
      this.timesDirty = false;
      const series = this.allSeries();
      this.time.rebuild(series);
      for (const s of series) s.reindex(this.time);
    }
    if (this.layoutDirty) this.layout();
  }

  layout() {
    this.layoutDirty = false;
    this.width = this.el.clientWidth;
    this.height = this.el.clientHeight;
    const fs = this.o.layout.fontSize;
    this.timeH = this.o.timeScale.visible ? Math.round(fs * 2.3) : 0;
    let axisW = this.axisW || Math.round(fs * 4.5);
    for (let pass = 0; pass < 2; pass++) {
      this.plotW = Math.max(0, this.width - axisW);
      this.time.width = this.plotW;
      if (this.time.pending && this.plotW > 0) this.time.setRange(this.time.pending);
      this.layoutPanes();
      const needed = this.measureAxis();
      // A few pixels' slack, so the axis doesn't twitch as labels change while you pan.
      if (needed <= axisW && axisW - needed < 8) break;
      axisW = needed;
    }
    this.axisW = axisW;
  }

  layoutPanes() {
    const panes = this.panes_;
    const total = Math.max(0, this.height - this.timeH - SEPARATOR * (panes.length - 1));
    const sum = panes.reduce((s, pane) => s + pane.stretch, 0) || 1;
    let top = 0;
    let left = total;
    panes.forEach((pane, n) => {
      pane.top = top;
      pane.height = n === panes.length - 1 ? left : Math.floor((total * pane.stretch) / sum);
      left -= pane.height;
      top += pane.height + SEPARATOR;
    });
    const range = this.time.range();
    for (const pane of panes) {
      const ordered = [...pane.series].sort((a, b) => a.order - b.order);
      for (const scale of pane.scales.values()) {
        scale.height = pane.height;
        scale.series = ordered.filter((s) => s.scale === scale);
        if (range) scale.fit(range.from, range.to);
        else scale.range = null;
      }
    }
  }

  font(weight = "") {
    return `${weight ? weight + " " : ""}${this.o.layout.fontSize}px ${this.o.layout.fontFamily}`;
  }

  tickGap() { return this.o.layout.fontSize * 2.6; }

  // The price axis is as wide as its widest label.
  measureAxis() {
    const ctx = this.ctx;
    ctx.font = this.font();
    const fs = this.o.layout.fontSize;
    let widest = ctx.measureText("0000.00").width;
    for (const pane of this.panes_) {
      const scale = pane.right;
      if (!scale.range) continue;
      const format = scale.formatter().format;
      for (const price of scale.ticks(this.tickGap())) widest = Math.max(widest, ctx.measureText(format(price)).width);
      for (const label of this.axisLabels(pane)) widest = Math.max(widest, ctx.measureText(label.text).width);
    }
    return Math.ceil(widest + fs * 1.5);
  }

  // Last-value and price-line labels for a pane's price axis, nudged apart so none overlap.
  axisLabels(pane) {
    const labels = [];
    for (const s of pane.series) {
      if (!s.options.visible || !s.scale.options.visible) continue;
      const format = s.formatter().format;
      if (s.options.lastValueVisible) {
        const last = s.lastPoint();
        const y = last && s.scale.coordinate(s.valueOf(last));
        if (y != null) labels.push({ y, text: format(s.valueOf(last)), bg: s.lastColor(last) });
      }
      for (const { options: l } of s.lines) {
        if (!l.axisLabelVisible) continue;
        const y = s.scale.coordinate(l.price);
        if (y != null) labels.push({ y, text: format(l.price), bg: l.axisLabelColor || l.color, fg: l.axisLabelTextColor, title: l.title });
      }
    }
    const h = this.o.layout.fontSize + 7;
    const shown = labels.filter((l) => l.y >= -h / 2 && l.y <= pane.height + h / 2).sort((a, b) => a.y - b.y);
    for (let n = 1; n < shown.length; n++) shown[n].y = Math.max(shown[n].y, shown[n - 1].y + h);
    for (let n = shown.length - 1; n >= 0; n--) {
      const limit = n === shown.length - 1 ? pane.height - h / 2 : shown[n + 1].y - h;
      if (shown[n].y > limit) shown[n].y = Math.max(h / 2, limit);
    }
    return shown;
  }

  // ---------- painting ----------

  render() {
    this.frame = 0;
    this._ensure();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.width * dpr), h = Math.round(this.height * dpr);
    for (const canvas of [this.canvas, this.top]) {
      if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
    }
    if (w && h) {
      this.paint(dpr);
      this.paintCrosshair(dpr);
    }
    this.emitChanges();
  }

  emitChanges() {
    const range = this.time.range();
    const key = range ? `${range.from}|${range.to}` : "";
    if (key !== this.lastRange) {
      this.lastRange = key;
      for (const fn of this.subs.range) fn(range && { ...range });
    }
    const size = `${this.plotW}x${this.height}`;
    if (size !== this.lastSize) {
      this.lastSize = size;
      for (const fn of this.subs.size) fn(this.plotW, this.timeH);
    }
  }

  paint(dpr) {
    const ctx = this.ctx;
    const L = this.o.layout;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = L.background;
    if (bg.type === ColorType.VerticalGradient) {
      const gradient = ctx.createLinearGradient(0, 0, 0, this.canvas.height);
      gradient.addColorStop(0, bg.topColor);
      gradient.addColorStop(1, bg.bottomColor);
      ctx.fillStyle = gradient;
    } else ctx.fillStyle = bg.color;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const range = this.time.range();
    const marks = range ? this.time.marks(L.fontSize * 7, this.o.timeScale.timeVisible) : [];
    const plotW = Math.round(this.plotW * dpr);
    for (const pane of this.panes_) {
      const top = Math.round(pane.top * dpr);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, plotW, Math.round(pane.height * dpr));
      ctx.clip();
      ctx.translate(0, top);
      this.paintWatermark(ctx, pane, dpr);
      this.paintGrid(ctx, pane, marks, dpr);
      if (range) {
        const view = { ctx, dpr, time: this.time, from: range.from, to: range.to };
        for (const s of [...pane.series].sort((a, b) => a.order - b.order)) {
          if (!s.scale.range) continue;
          s.paint({ ...view, scale: s.scale });
        }
        this.paintPriceLines(ctx, pane, dpr);
      }
      ctx.restore();
    }
    this.paintSeparators(ctx, dpr);
    for (const pane of this.panes_) this.paintPriceAxis(ctx, pane, dpr);
    this.paintTimeAxis(ctx, marks, dpr);
  }

  // A horizontal line across the plot, `y` in CSS px from the current origin.
  hline(ctx, y, color, width, style, dpr) {
    const w = Math.max(1, Math.round(width * dpr));
    const yy = Math.round(y * dpr) + (w % 2 ? 0.5 : 0);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.setLineDash(dash(style, w));
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(Math.round(this.plotW * dpr), yy);
    ctx.stroke();
    ctx.restore();
  }

  vline(ctx, x, y0, y1, color, width, style, dpr) {
    const w = Math.max(1, Math.round(width * dpr));
    const xx = Math.round(x * dpr) + (w % 2 ? 0.5 : 0);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.setLineDash(dash(style, w));
    ctx.beginPath();
    ctx.moveTo(xx, Math.round(y0 * dpr));
    ctx.lineTo(xx, Math.round(y1 * dpr));
    ctx.stroke();
    ctx.restore();
  }

  paintWatermark(ctx, pane, dpr) {
    const mark = pane.watermark;
    if (!mark || !mark.visible) return;
    const lines = (mark.lines || []).filter((line) => line.text);
    if (!lines.length) return;
    const heights = lines.map((line) => (line.lineHeight || line.fontSize * 1.2) * dpr);
    let y = mark.vertAlign === "top" ? 0 : mark.vertAlign === "bottom" ? pane.height * dpr - heights.reduce((a, b) => a + b, 0)
      : (pane.height * dpr - heights.reduce((a, b) => a + b, 0)) / 2;
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = mark.horzAlign === "left" ? "left" : mark.horzAlign === "right" ? "right" : "center";
    const x = mark.horzAlign === "left" ? 0 : mark.horzAlign === "right" ? this.plotW * dpr : (this.plotW * dpr) / 2;
    lines.forEach((line, n) => {
      ctx.font = `${line.fontStyle || ""} ${line.fontSize * dpr}px ${line.fontFamily || this.o.layout.fontFamily}`;
      ctx.fillStyle = line.color;
      ctx.fillText(line.text, x, y + heights[n] / 2);
      y += heights[n];
    });
    ctx.restore();
  }

  paintGrid(ctx, pane, marks, dpr) {
    const { vertLines: v, horzLines: h } = this.o.grid;
    if (v.visible) for (const mark of marks) this.vline(ctx, mark.x, 0, pane.height, v.color, 1, v.style, dpr);
    if (h.visible && pane.right.range) {
      for (const price of pane.right.ticks(this.tickGap())) this.hline(ctx, pane.right.coordinate(price), h.color, 1, h.style, dpr);
    }
  }

  paintPriceLines(ctx, pane, dpr) {
    for (const s of pane.series) {
      if (!s.options.visible || !s.scale.range) continue;
      for (const { options: l } of s.lines) {
        if (l.lineVisible === false) continue;
        const y = s.scale.coordinate(l.price);
        if (y != null) this.hline(ctx, y, l.color, l.lineWidth, l.lineStyle, dpr);
      }
      const last = s.options.priceLineVisible && s.lastPoint();
      if (last) {
        const o = s.options;
        this.hline(ctx, s.scale.coordinate(s.valueOf(last)), o.priceLineColor || s.lastColor(last), o.priceLineWidth, o.priceLineStyle, dpr);
      }
    }
  }

  paintSeparators(ctx, dpr) {
    const L = this.o.layout.panes;
    this.panes_.slice(0, -1).forEach((pane, n) => {
      ctx.fillStyle = n === this.hoverSeparator ? L.separatorHoverColor : L.separatorColor;
      ctx.fillRect(0, Math.round((pane.top + pane.height) * dpr), this.canvas.width, Math.max(1, Math.round(SEPARATOR * dpr)));
    });
  }

  // An axis tag: a filled box on the price axis with its text, and the line's title beside it.
  tag(ctx, y, text, bg, fg, dpr, title = "") {
    const fs = this.o.layout.fontSize;
    const h = Math.round((fs + 7) * dpr);
    const top = Math.round(y * dpr - h / 2);
    const left = Math.round(this.plotW * dpr);
    ctx.fillStyle = bg;
    ctx.fillRect(left, top, this.canvas.width - left, h);
    ctx.fillStyle = fg || contrast(bg);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(text, left + Math.round(fs * 0.6 * dpr), top + h / 2);
    if (title) {
      const w = Math.ceil(ctx.measureText(title).width + fs * dpr);
      ctx.fillStyle = bg;
      ctx.fillRect(left - w, top, w, h);
      ctx.fillStyle = fg || contrast(bg);
      ctx.fillText(title, left - w + Math.round(fs * 0.5 * dpr), top + h / 2);
    }
  }

  paintPriceAxis(ctx, pane, dpr) {
    const scale = pane.right;
    if (!scale.range || !scale.options.visible) return;
    const fs = this.o.layout.fontSize;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, Math.round(pane.top * dpr), this.canvas.width, Math.round(pane.height * dpr));
    ctx.clip();
    ctx.font = `${fs * dpr}px ${this.o.layout.fontFamily}`;
    ctx.fillStyle = this.o.layout.textColor;
    ctx.textBaseline = "middle";
    const format = scale.formatter().format;
    const x = Math.round((this.plotW + fs * 0.6) * dpr);
    const labels = this.axisLabels(pane);
    for (const price of scale.ticks(this.tickGap())) {
      const y = scale.coordinate(price);
      if (y < fs / 2 || y > pane.height - fs / 2) continue;
      if (labels.some((label) => Math.abs(label.y - y) < fs + 4)) continue; // under a tag
      ctx.fillText(format(price), x, Math.round((pane.top + y) * dpr));
    }
    for (const label of labels) this.tag(ctx, pane.top + label.y, label.text, label.bg, label.fg, dpr, label.title);
    ctx.restore();
  }

  paintTimeAxis(ctx, marks, dpr) {
    if (!this.timeH) return;
    const fs = this.o.layout.fontSize;
    const y = Math.round((this.height - this.timeH / 2) * dpr);
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = this.o.layout.textColor;
    for (const mark of marks) {
      ctx.font = `${mark.major ? "600 " : ""}${fs * dpr}px ${this.o.layout.fontFamily}`;
      const half = ctx.measureText(mark.text).width / 2 / dpr;
      if (mark.x - half < 0 || mark.x + half > this.plotW) continue;
      ctx.fillText(mark.text, Math.round(mark.x * dpr), y);
    }
    ctx.restore();
  }

  paintCrosshair(dpr) {
    const ctx = this.topCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.top.width, this.top.height);
    const c = this.o.crosshair;
    const at = this.cross;
    if (!at || c.mode === CrosshairMode.Hidden || !this.time.keys.length) return;
    const pane = this.panes_[at.pane];
    if (!pane) return;
    const index = at.x != null ? this.time.logicalAt(at.x) : at.index;
    const x = this.time.x(index);
    const fs = this.o.layout.fontSize;
    ctx.font = `${fs * dpr}px ${this.o.layout.fontFamily}`;
    if (c.vertLine.visible && x >= 0 && x <= this.plotW) {
      this.vline(ctx, x, 0, this.height - this.timeH, c.vertLine.color, c.vertLine.width, c.vertLine.style, dpr);
    }
    const y = this.crossY(at, index);
    if (y != null && c.horzLine.visible) {
      ctx.save();
      ctx.translate(0, Math.round(pane.top * dpr));
      this.hline(ctx, y, c.horzLine.color, c.horzLine.width, c.horzLine.style, dpr);
      ctx.restore();
    }
    if (y != null && c.horzLine.labelVisible && pane.right.range && pane.right.options.visible) {
      const price = pane.right.price(y);
      this.tag(ctx, pane.top + y, pane.right.formatter().format(price), c.horzLine.labelBackgroundColor, null, dpr);
    }
    const text = this.timeH && c.vertLine.labelVisible && this.time.label(index, this.o.timeScale.timeVisible);
    if (text) {
      const pad = fs * 0.6;
      const w = ctx.measureText(text).width / dpr + 2 * pad;
      const left = Math.max(0, Math.min(this.plotW - w, x - w / 2));
      const top = this.height - this.timeH;
      const bg = c.vertLine.labelBackgroundColor;
      ctx.fillStyle = bg;
      ctx.fillRect(Math.round(left * dpr), Math.round(top * dpr), Math.round(w * dpr), Math.round(this.timeH * dpr));
      ctx.fillStyle = contrast(bg);
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(text, Math.round((left + w / 2) * dpr), Math.round((top + this.timeH / 2) * dpr));
    }
  }

  // The crosshair's height in its pane: the pointer's, or in magnet mode the close at its bar.
  crossY(at, index) {
    const pane = this.panes_[at.pane];
    if (at.price != null && at.series) return at.series.scale.coordinate(at.price);
    if (this.o.crosshair.mode === CrosshairMode.Magnet || this.o.crosshair.mode === CrosshairMode.MagnetOHLC) {
      for (const s of [...pane.series].sort((a, b) => a.order - b.order)) {
        if (s.type !== "Candlestick" && s.type !== "Bar") continue;
        const n = s.lowerBound(index);
        if (s.idx[n] === index && s.has(s.points[n])) return s.scale.coordinate(s.points[n].close);
      }
    }
    return at.y;
  }

  // ---------- input ----------
  // Drag the chart to pan (let go mid-swipe and it coasts), the price axis to stretch prices,
  // the time axis to zoom, the line between panes to resize them. Pinch with two fingers to
  // zoom. The wheel zooms (or pans, sideways); double-click an axis to reset it.

  bindInput() {
    const el = this.el;
    el.addEventListener("pointerdown", (e) => this.onDown(e));
    el.addEventListener("pointermove", (e) => this.onMove(e));
    el.addEventListener("pointerup", (e) => this.onUp(e));
    el.addEventListener("pointercancel", (e) => this.onUp(e));
    el.addEventListener("pointerleave", () => { if (!this.drag) this.setCross(null); });
    el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    el.addEventListener("dblclick", (e) => this.onDoubleClick(e));
  }

  point(e) {
    const rect = this.el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  zone({ x, y }) {
    this._ensure();
    if (y >= this.height - this.timeH) return { kind: x < this.plotW ? "time" : "corner" };
    const resize = this.o.layout.panes.enableResize;
    for (let n = 0; n < this.panes_.length; n++) {
      const pane = this.panes_[n];
      const bottom = pane.top + pane.height;
      if (resize && n < this.panes_.length - 1 && Math.abs(y - bottom - 0.5) <= 3) return { kind: "separator", n };
      if (y >= pane.top && y < bottom + SEPARATOR) return { kind: x >= this.plotW ? "axis" : "plot", pane: n, y: y - pane.top };
    }
    return { kind: "none" };
  }

  onDown(e) {
    if (e.button !== 0 || e.defaultPrevented) return;
    this.stopGlide();
    const p = this.point(e);
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, p);
      if (this.touches.size === 2) return this.startPinch(e);
    }
    const zone = this.zone(p);
    if (zone.kind === "none" || zone.kind === "corner") return;
    this.el.setPointerCapture(e.pointerId);
    const pane = zone.pane != null ? this.panes_[zone.pane] : null;
    this.drag = {
      zone, x0: p.x, y0: p.y, moved: false, offset: this.time.rightOffset, spacing: this.time.spacing, trail: [],
      range: pane && pane.right.range ? { ...pane.right.range } : null,
      heights: this.panes_.map((item) => item.height),
    };
    if (zone.kind === "plot") this.el.style.cursor = "grabbing";
  }

  onMove(e) {
    const p = this.point(e);
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, p);
    if (this.pinch) return this.movePinch();
    const d = this.drag;
    if (!d) {
      const zone = this.zone(p);
      this.el.style.cursor = { plot: "crosshair", axis: "ns-resize", time: "ew-resize", separator: "row-resize" }[zone.kind] || "";
      const hover = zone.kind === "separator" ? zone.n : -1;
      if (hover !== this.hoverSeparator) { this.hoverSeparator = hover; this._changed(); }
      if (zone.kind === "plot") this.pointerCross(p, zone, e);
      else this.setCross(null);
      return;
    }
    if (Math.abs(p.x - d.x0) + Math.abs(p.y - d.y0) > 2) d.moved = true;
    const pane = d.zone.pane != null ? this.panes_[d.zone.pane] : null;
    if (d.zone.kind === "plot") {
      d.trail.push({ t: e.timeStamp, x: p.x });
      while (d.trail.length > 2 && e.timeStamp - d.trail[0].t > 100) d.trail.shift();
      this.time.rightOffset = d.offset - (p.x - d.x0) / this.time.spacing;
      this.time.clamp();
      const scale = pane.right;
      if (!scale.options.autoScale && d.range) {
        const shift = (p.y - d.y0) * scale.unitsPerPixel() * (scale.options.invertScale ? -1 : 1);
        scale.range = { min: d.range.min + shift, max: d.range.max + shift };
      }
      this.pointerCross(p, this.zone(p), e);
    } else if (d.zone.kind === "axis" && d.range) {
      const scale = pane.right;
      scale.options.autoScale = false;
      const mid = (d.range.min + d.range.max) / 2;
      const half = ((d.range.max - d.range.min) / 2) * Math.exp((p.y - d.y0) * 0.006);
      scale.range = { min: mid - half, max: mid + half };
    } else if (d.zone.kind === "time") {
      const from = Math.max(1, this.plotW - d.x0), to = Math.max(1, this.plotW - p.x);
      this.time.zoom(d.spacing * from / to);
    } else if (d.zone.kind === "separator") {
      const n = d.zone.n;
      const both = d.heights[n] + d.heights[n + 1];
      const upper = Math.max(MIN_PANE, Math.min(both - MIN_PANE, d.heights[n] + p.y - d.y0));
      const heights = [...d.heights];
      heights[n] = upper;
      heights[n + 1] = both - upper;
      this.panes_.forEach((item, k) => { item.stretch = heights[k]; });
    }
    this._changed();
  }

  onUp(e) {
    this.touches.delete(e.pointerId);
    if (this.pinch) {
      if (this.touches.size < 2) this.pinch = null;
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    if (d.zone.kind === "plot" && d.moved && e.type === "pointerup") this.startGlide(d.trail, e.timeStamp);
    this.el.style.cursor = d.zone.kind === "plot" ? "crosshair" : this.el.style.cursor;
    if (!d.moved && d.zone.kind === "plot" && this.subs.click.length) {
      const param = this.crossParam(this.point(e), d.zone, e);
      for (const fn of this.subs.click) fn(param);
    }
  }

  // Momentum: the swipe's speed over its last 100 ms, fading like a phone's list.
  startGlide(trail, now) {
    const first = trail[0], last = trail[trail.length - 1];
    if (!first || last === first || now - last.t > 60) return;
    let v = (last.x - first.x) / Math.max(1, last.t - first.t); // px per ms
    if (Math.abs(v) < 0.25) return;
    v = Math.max(-6, Math.min(6, v));
    let then = performance.now();
    const step = (t) => {
      const dt = Math.min(50, t - then);
      then = t;
      v *= Math.exp(-dt / 325);
      const before = this.time.rightOffset;
      this.time.scroll(-(v * dt) / this.time.spacing);
      this._changed();
      this.glide = Math.abs(v) > 0.02 && this.time.rightOffset !== before ? requestAnimationFrame(step) : 0;
    };
    this.glide = requestAnimationFrame(step);
  }

  stopGlide() {
    cancelAnimationFrame(this.glide);
    this.glide = 0;
  }

  // Two fingers: the bar between them stays under them while the spacing follows their spread.
  startPinch(e) {
    this.drag = null;
    this.setCross(null);
    this.el.setPointerCapture(e.pointerId);
    const [a, b] = [...this.touches.values()];
    const mid = (a.x + b.x) / 2;
    this.pinch = {
      spread: Math.max(10, Math.abs(a.x - b.x)), spacing: this.time.spacing,
      logical: this.time.last + this.time.rightOffset + 0.5 - (this.time.width - mid) / this.time.spacing,
    };
  }

  movePinch() {
    const [a, b] = [...this.touches.values()];
    if (!b) return;
    const pinch = this.pinch;
    const mid = (a.x + b.x) / 2;
    this.time.zoom(pinch.spacing * Math.max(10, Math.abs(a.x - b.x)) / pinch.spread);
    this.time.rightOffset = pinch.logical - this.time.last - 0.5 + (this.time.width - mid) / this.time.spacing;
    this.time.clamp();
    this._changed();
  }

  onWheel(e) {
    const zone = this.zone(this.point(e));
    if (zone.kind === "none" || zone.kind === "separator" || !this.time.keys.length) return;
    e.preventDefault();
    this.stopGlide();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (Math.abs(dx) > Math.abs(dy)) this.time.scroll(dx / this.time.spacing);
    else this.time.zoom(this.time.spacing * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)));
    this._changed();
    if (zone.kind === "plot") this.pointerCross(this.point(e), zone, e); // a new bar is under the pointer
  }

  onDoubleClick(e) {
    const zone = this.zone(this.point(e));
    if (zone.kind === "axis") {
      for (const scale of this.panes_[zone.pane].scales.values()) scale.options.autoScale = true;
    } else if (zone.kind === "time") {
      this.time.spacing = this.o.timeScale.barSpacing;
      this.time.rightOffset = this.o.timeScale.rightOffset;
    } else return;
    this._changed();
  }

  // ---------- crosshair ----------

  pointerCross(p, zone, e) {
    if (zone.kind !== "plot") return this.setCross(null);
    this.cross = { x: p.x, pane: zone.pane, y: zone.y };
    this.schedule();
    this.emitCross(this.crossParam(p, zone, e));
  }

  crossParam(p, zone, e) {
    const index = this.time.logicalAt(p.x);
    const time = index >= 0 && index <= this.time.last ? this.time.times[index] : undefined;
    return { point: { x: p.x, y: zone.y }, logical: index, time, paneIndex: zone.pane, seriesData: new Map(), sourceEvent: e };
  }

  setCross(at) {
    const had = this.cross;
    this.cross = at;
    this.schedule();
    if (!at && had) this.emitCross({ point: undefined, logical: undefined, time: undefined, seriesData: new Map() });
  }

  emitCross(param) {
    for (const fn of this.subs.crosshair) fn(param);
  }

  // ---------- the API ----------

  makeApi() {
    const chart = this;
    const seriesApis = new WeakMap();
    const scaleApi = (scale) => ({
      applyOptions(options) { scale.applyOptions(options); chart._changed(); },
      options: () => ({ ...scale.options }),
      width: () => { chart._ensure(); return scale.id === "right" ? chart.axisW : 0; },
    });
    const timeApi = {
      getVisibleLogicalRange() { chart._ensure(); const r = chart.time.range(); return r && { ...r }; },
      setVisibleLogicalRange(range) { chart.stopGlide(); chart._ensure(); chart.time.setRange(range); chart._changed(); },
      subscribeVisibleLogicalRangeChange: (fn) => chart.subs.range.push(fn),
      unsubscribeVisibleLogicalRangeChange: (fn) => { chart.subs.range = chart.subs.range.filter((f) => f !== fn); },
      subscribeSizeChange: (fn) => chart.subs.size.push(fn),
      unsubscribeSizeChange: (fn) => { chart.subs.size = chart.subs.size.filter((f) => f !== fn); },
      applyOptions: (options) => api.applyOptions({ timeScale: options }),
      options: () => ({ ...chart.o.timeScale, barSpacing: chart.time.spacing, rightOffset: chart.time.rightOffset }),
      logicalToCoordinate(i) { chart._ensure(); return chart.time.keys.length ? chart.time.x(i) : null; },
      coordinateToLogical(x) { chart._ensure(); return chart.time.keys.length ? chart.time.logicalAt(x) : null; },
      timeToCoordinate(time) { chart._ensure(); const i = chart.time.indexOf(time); return i == null ? null : chart.time.x(i); },
      coordinateToTime(x) { chart._ensure(); const i = chart.time.logicalAt(x); return chart.time.times[i] ?? null; },
      scrollToRealTime() { chart.time.rightOffset = chart.o.timeScale.rightOffset; chart._changed(); },
      fitContent() { chart._ensure(); if (chart.time.keys.length) chart.time.setRange({ from: 0, to: chart.time.last }); chart._changed(); },
      height: () => { chart._ensure(); return chart.timeH; },
      width: () => { chart._ensure(); return chart.plotW; },
    };
    const makeSeries = (s) => {
      const sApi = {
        setData: (points) => s.setData(points),
        update: (point) => s.update(point),
        data: () => s.points.slice(),
        applyOptions(options) {
          if (options.priceFormat) s._formatter = null;
          merge(s.options, options);
          chart._changed();
        },
        options: () => ({ ...s.options }),
        seriesType: () => s.type,
        seriesOrder: () => s.order,
        setSeriesOrder(order) { s.order = order; chart._changed(); },
        priceScale: () => scaleApi(s.scale),
        priceFormatter: () => s.formatter(),
        priceToCoordinate(price) { chart._ensure(); return s.scale.coordinate(price); },
        coordinateToPrice(y) { chart._ensure(); return s.scale.price(y); },
        createPriceLine(options) {
          const line = {
            options: {
              price: 0, color: "", lineWidth: 1, lineStyle: LineStyle.Solid, lineVisible: true, axisLabelVisible: true,
              title: "", axisLabelColor: "", axisLabelTextColor: "", ...options,
            },
          };
          s.lines.push(line);
          chart._changed();
          return {
            applyOptions(more) { Object.assign(line.options, more); chart._changed(); },
            options: () => ({ ...line.options }),
            _line: line,
          };
        },
        removePriceLine(handle) {
          s.lines = s.lines.filter((line) => line !== handle._line);
          chart._changed();
        },
        moveToPane(index) { api._move(s, index); },
      };
      s.api = sApi;
      seriesApis.set(sApi, s);
      return sApi;
    };
    const paneAt = (index) => {
      while (chart.panes_.length <= index) chart.panes_.push(new Pane(chart));
      return chart.panes_[index];
    };
    const api = {
      applyOptions(options) {
        merge(chart.o, options);
        if (options.timeScale) chart.applyTimeOptions(options.timeScale);
        chart._changed();
      },
      options: () => merge({}, chart.o),
      addSeries(type, options = {}, paneIndex = 0) {
        const pane = paneAt(paneIndex);
        const s = new Series(chart, type, options, pane);
        s.scale = pane.scale(s.options.priceScaleId);
        s.order = ++chart.order;
        pane.series.push(s);
        chart._timesChanged();
        return makeSeries(s);
      },
      removeSeries(sApi) {
        const s = seriesApis.get(sApi);
        if (!s) return;
        s.pane.series = s.pane.series.filter((item) => item !== s);
        chart._timesChanged();
      },
      _move(s, index) {
        s.pane.series = s.pane.series.filter((item) => item !== s);
        s.pane = paneAt(index);
        s.scale = s.pane.scale(s.options.priceScaleId);
        s.pane.series.push(s);
        chart._changed();
      },
      panes: () => chart.panes_.map((pane) => pane.api),
      removePane(index) {
        if (index <= 0 || index >= chart.panes_.length) return;
        chart.panes_.splice(index, 1);
        chart._timesChanged();
      },
      timeScale: () => timeApi,
      priceScale: (id = "right", paneIndex = 0) => scaleApi(paneAt(paneIndex).scale(id)),
      subscribeCrosshairMove: (fn) => chart.subs.crosshair.push(fn),
      unsubscribeCrosshairMove: (fn) => { chart.subs.crosshair = chart.subs.crosshair.filter((f) => f !== fn); },
      subscribeClick: (fn) => chart.subs.click.push(fn),
      unsubscribeClick: (fn) => { chart.subs.click = chart.subs.click.filter((f) => f !== fn); },
      // Show the crosshair at a price and time (another chart's crosshair, a dragged line).
      setCrosshairPosition(price, time, sApi) {
        const s = seriesApis.get(sApi);
        chart._ensure();
        const index = chart.time.indexOf(time);
        if (!s || index == null) return;
        const pane = chart.panes_.indexOf(s.pane);
        chart.cross = { index, pane, price, series: s };
        chart.schedule();
        const y = s.scale.coordinate(price);
        chart.emitCross({ point: { x: chart.time.x(index), y }, logical: index, time: chart.time.times[index], paneIndex: pane, seriesData: new Map() });
      },
      clearCrosshairPosition() { chart.setCross(null); },
      takeScreenshot() {
        chart.render();
        const shot = document.createElement("canvas");
        [shot.width, shot.height] = [chart.canvas.width, chart.canvas.height];
        shot.getContext("2d").drawImage(chart.canvas, 0, 0);
        return shot;
      },
      resize() { chart._changed(); },
      remove() {
        chart.observer.disconnect();
        cancelAnimationFrame(chart.frame);
        chart.canvas.remove();
        chart.top.remove();
      },
      chartElement: () => chart.el,
    };
    return api;
  }
}

// Lightweight Charts' text watermark: lines of text centred on a pane.
export function createTextWatermark(paneApi, options = {}) {
  const pane = paneApi._pane;
  pane.watermark = merge({ visible: true, horzAlign: "center", vertAlign: "center", lines: [] }, options);
  pane.chart._changed();
  return {
    applyOptions(more) {
      merge(pane.watermark, more);
      if (more.lines) pane.watermark.lines = more.lines;
      pane.chart._changed();
    },
    detach() { pane.watermark = null; pane.chart._changed(); },
  };
}

export const createChart = (container, options) => new Chart(container, options).api;
