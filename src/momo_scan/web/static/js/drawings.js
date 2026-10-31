import { $, api, escapeHtml, fmtPrice, store, ticker, toast } from "./util.js";
import { activePane, onChartActivate, onChartLoad, onChartRender, scheduleCallouts } from "./chart.js";
import { floatingCard, FLOAT_GRIP } from "./dialog.js";
import { swatch } from "./colorpicker.js";

// Drawing tools, TradingView-style: trend line (⌥T), ray, arrow, horizontal line (⌥H), horizontal
// ray (⌥J), vertical line, rectangle, label (a text box on a line from the point you click) and
// floating text, and images (an animated GIF keeps playing). Points are stored as a date and a price, so a line drawn on the daily chart lands
// in the right place on the weekly. On intraday charts a point is a time (New York wall-clock
// seconds, as the chart shows them); a date maps to that day's 9:30 there, and a time to its
// date on daily charts, so drawings are shared across timeframes. Drawings are kept per ticker and saved to the server;
// practice charts get a scratch layer that is never saved, so a setup can't be recognised by
// your own old lines.

const SVG = "http://www.w3.org/2000/svg";
const DEFAULT_STYLE = { color: "#2962ff", width: 2, dash: 0 };
const DASHES = { 0: "", 1: "2 3", 2: "6 4" };
const MAGNET_PX = 10;
const HIT_PX = 10;
// Tools placed with two clicks: a trend line, or a label (a line from a point to a text box).
const twoPoint = (type) => ["trend", "label", "arrow", "rect"].includes(type);
const clipped = (type) => type !== "hline" && type !== "hray"; // those two carry a price tag
const measure = document.createElement("canvas").getContext("2d");
const hasText = (type) => type === "label" || type === "text";
let editing = null; // id of the label or text being typed into on the chart
const SIZES = [10, 12, 14, 16, 20, 24, 32, 48];
const UNIT_DAYS = { D: 1, W: 5, M: 21 };
const DAY = 86400000;

let saved = { version: 1, symbols: {}, ...store.get("drawings", {}) };
// One layer per chart (split view has two). Drawings are kept per ticker, so two charts of the
// same symbol show the same ones. Placing, selecting and dragging happen in one chart at a time:
// `layer` is that chart's (the one last pointed at, or the active one).
const layers = new Map(); // pane -> { pane, svg, key, scratch }
let layer = null;
let key = null; // the ticker on `layer`'s chart; null for a practice scratch layer
let scratch = [];
let tool = null; // the drawing tool in use: a type, or "ray" (a trend line carried on)
let hidden = Boolean(store.get("drawingsHidden", false));
const watchers = [];
let pending = null; // the drawing being placed
let selected = null; // id
let drag = null;
let positionToolbar = () => {};
let closePosition = () => {};
let lastHit = null; // the last drawing clicked, to tell a double click
const history = { undo: [], redo: [] };
// Price alerts on horizontal lines and rays (alerts.js): `has(id)` lights the bell, `open(item,
// key)` sets one up, `saved(key, items)` hears every change to a symbol's drawings.
let alertHooks = null;
export const setDrawingAlerts = (hooks) => { alertHooks = hooks; };
const alertable = (item) => Boolean(alertHooks && key && (item.type === "hline" || item.type === "hray"));

const list = () => (key ? saved.symbols[key] || [] : scratch);
const itemsOf = (l) => (l.key ? saved.symbols[l.key] || [] : l.scratch);
const chartContext = () => layer.pane.context();
const find = (id) => list().find((item) => item.id === id);

// ---------- dates and bars ----------

const toMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

function weekdaysBetween(a, b) {
  if (a === b) return 0;
  if (a > b) return -weekdaysBetween(b, a);
  const start = toMs(a);
  const days = Math.round((toMs(b) - start) / DAY);
  const weeks = Math.floor(days / 7);
  let count = weeks * 5;
  for (let k = weeks * 7 + 1; k <= days; k++) {
    const weekday = new Date(start + k * DAY).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

function addWeekdays(iso, n) {
  let ms = toMs(iso);
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(Math.round(n)); left > 0;) {
    ms += step * DAY;
    const weekday = new Date(ms).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return toIso(ms);
}

const INTRADAY_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600 };
const intradayChart = (bars) => bars.length && typeof bars[0].time === "number";
// A point's time in the chart's terms: dates on daily charts, seconds on intraday ones.
const inDomain = (t, bars) => (intradayChart(bars)
  ? (typeof t === "number" ? t : Date.parse(`${t}T09:30:00Z`) / 1000)
  : (typeof t === "number" ? new Date(t * 1000).toISOString().slice(0, 10) : t));

function barDays(interval) {
  const match = /^(\d+)([DWM])$/.exec(interval || "1D");
  return match ? Number(match[1]) * UNIT_DAYS[match[2]] : 1;
}

// A date's position in bars: fractional inside a weekly or monthly bar, extrapolated in
// trading days beyond either end of the data.
function timeToLogical(t, bars, interval) {
  const n = bars.length;
  const iso = inDomain(t, bars);
  if (intradayChart(bars)) return secondsToLogical(iso, bars, INTRADAY_SECONDS[interval] || 60);
  const per = barDays(interval);
  if (iso > bars[n - 1].time) return n - 1 + weekdaysBetween(bars[n - 1].time, iso) / per;
  if (iso < bars[0].time) return -weekdaysBetween(iso, bars[0].time) / per;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].time <= iso) lo = mid;
    else hi = mid - 1;
  }
  if (bars[lo].time === iso || lo === n - 1) return lo;
  const span = weekdaysBetween(bars[lo].time, bars[lo + 1].time);
  return lo + (span ? weekdaysBetween(bars[lo].time, iso) / span : 0);
}

// Intraday: a time's position, fractional between bars, and extrapolated a bar per interval
// beyond the data (overnight gaps make far extrapolation approximate).
function secondsToLogical(t, bars, step) {
  const n = bars.length;
  if (t >= bars[n - 1].time) return n - 1 + (t - bars[n - 1].time) / step;
  if (t <= bars[0].time) return (t - bars[0].time) / step;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  const span = bars[lo + 1].time - bars[lo].time;
  return lo + Math.min(1, (t - bars[lo].time) / span);
}

function logicalToTime(logical, bars, interval) {
  const i = Math.round(logical);
  const n = bars.length;
  if (intradayChart(bars)) {
    const step = INTRADAY_SECONDS[interval] || 60;
    if (i < 0) return bars[0].time + i * step;
    if (i < n) return bars[i].time;
    return bars[n - 1].time + (i - (n - 1)) * step;
  }
  if (i < 0) return addWeekdays(bars[0].time, i * barDays(interval));
  if (i < n) return bars[i].time;
  return addWeekdays(bars[n - 1].time, (i - (n - 1)) * barDays(interval));
}

// ---------- pixels ----------

// The chart only maps whole bar positions to pixels, so interpolate between two of them.
function logicalX(scale, logical) {
  const base = Math.floor(logical);
  const left = scale.logicalToCoordinate(base);
  if (left == null || logical === base) return left;
  const right = scale.logicalToCoordinate(base + 1);
  return right == null ? left : left + (right - left) * (logical - base);
}

function toPixel(point, ctx) {
  const logical = timeToLogical(point.t, ctx.bars, ctx.interval);
  const x = logicalX(ctx.chart.timeScale(), logical);
  const y = ctx.candles.priceToCoordinate(point.p);
  return x == null || y == null ? null : { x, y: y + ctx.box.top };
}

function localXY(event) {
  const rect = layer.pane.root.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// The date and price under the pointer, snapped to the nearest open/high/low/close when close.
function pointAt(event, magnet = true) {
  const ctx = chartContext();
  const { x, y } = localXY(event);
  const logical = ctx.chart.timeScale().coordinateToLogical(x);
  if (logical == null) return null;
  const i = Math.round(logical);
  let price = ctx.candles.coordinateToPrice(y - ctx.box.top);
  if (price == null) return null;
  const bar = ctx.bars[i];
  if (magnet && bar) {
    let best = MAGNET_PX;
    for (const value of [bar.open, bar.high, bar.low, bar.close]) {
      const at = ctx.candles.priceToCoordinate(value);
      if (at != null && Math.abs(at + ctx.box.top - y) < best) {
        best = Math.abs(at + ctx.box.top - y);
        price = value;
      }
    }
  }
  return { t: logicalToTime(i, ctx.bars, ctx.interval), p: price, logical: i };
}

// ---------- render ----------

function lineEnds(item, ctx) {
  const a = toPixel(item.p1, ctx);
  if (!a) return null;
  if (item.type === "hline") return [{ x: 0, y: a.y }, { x: ctx.plotWidth, y: a.y }];
  if (item.type === "vline") return [{ x: a.x, y: ctx.box.top }, { x: a.x, y: ctx.box.top + ctx.box.height }];
  if (item.type === "hray") return [a, { x: ctx.plotWidth, y: a.y }];
  const b = toPixel(item.p2, ctx);
  if (!b) return null;
  if (!item.extend || Math.abs(b.x - a.x) < 0.5) return [a, b];
  // A ray: carry the line on past the second point to the edge of the chart.
  const edge = b.x > a.x ? ctx.plotWidth : 0;
  return [a, { x: edge, y: a.y + ((b.y - a.y) * (edge - a.x)) / (b.x - a.x) }];
}

// The label's text box sits at the second point, on the side away from the first.
function labelGeom(item, a, b) {
  const lines = (item.text || "").split("\n");
  const size = item.size || 12;
  const lh = Math.round(size * 1.35);
  measure.font = `${size}px Inter, sans-serif`;
  const width = Math.max(28, Math.ceil(Math.max(...lines.map((line) => measure.measureText(line).width))) + 16);
  const height = lines.length * lh + 10;
  return { lines, size, lh, width, height, x: b.x >= a.x ? b.x : b.x - width, top: b.y - height / 2 };
}

function labelBox(item, a, b) {
  const { lines, size, lh, width, height, x, top } = labelGeom(item, a, b);
  const color = escapeHtml(item.color);
  return `<circle cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="3" fill="${color}"/>` +
    `<rect class="hit hit-box" data-id="${item.id}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${width}" height="${height}" rx="5" fill="rgba(14,16,21,.92)" stroke="${color}" stroke-width="${Math.min(item.width, 2)}"/>` +
    (item.id === editing ? "" : `<text fill="#fff" font-size="${size}" font-family="Inter, sans-serif" pointer-events="none">${lines.map((line, i) =>
      `<tspan x="${(x + 8).toFixed(1)}" y="${(top + 5 + size + i * lh).toFixed(1)}">${escapeHtml(line)}</tspan>`).join("")}</text>`);
}

// Words wrapped to a width in pixels (none: only the lines you typed).
function wrap(text, width, size) {
  measure.font = `${size}px Inter, sans-serif`;
  const out = [];
  for (const paragraph of (text || "").split("\n")) {
    if (!width) { out.push(paragraph); continue; }
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure.measureText(next).width > width) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

function textGeom(item) {
  const size = item.size || 14;
  const lh = Math.round(size * 1.3);
  const lines = wrap(item.text, item.boxW, size);
  measure.font = `${size}px Inter, sans-serif`;
  const width = item.boxW || Math.max(20, Math.ceil(Math.max(...lines.map((line) => measure.measureText(line).width))));
  return { lines, size, lh, width, height: lines.length * lh };
}

// Floating text: its top-left is the point; a handle on the right edge sets where it wraps.
function textShape(item, ctx, isSelected) {
  const a = toPixel(item.p1, ctx);
  if (!a) return "";
  const { lines, size, lh, width, height } = textGeom(item);
  const color = escapeHtml(item.color);
  let out = `<rect class="hit hit-box" data-id="${item.id}" x="${(a.x - 3).toFixed(1)}" y="${(a.y - 3).toFixed(1)}" width="${width + 6}" height="${height + 6}" fill="transparent"` +
    `${isSelected ? ' stroke="rgba(255,255,255,.35)" stroke-dasharray="3 3"' : ""}/>` +
    (item.id === editing ? "" : `<text fill="${color}" font-size="${size}" font-family="Inter, sans-serif" pointer-events="none">${lines.map((line, i) =>
      `<tspan x="${a.x.toFixed(1)}" y="${(a.y + size - 2 + i * lh).toFixed(1)}" xml:space="preserve">${escapeHtml(line)}</tspan>`).join("")}</text>`);
  if (isSelected && !item.locked && item.id !== editing) {
    out += `<circle class="handle" data-id="${item.id}" data-end="p1" cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="4" fill="#000" stroke="${color}" stroke-width="2"/>` +
      `<rect class="handle ew" data-id="${item.id}" data-end="width" x="${(a.x + width - 2).toFixed(1)}" y="${(a.y + height / 2 - 9).toFixed(1)}" width="8" height="18" rx="3" fill="#000" stroke="${color}" stroke-width="1.5"/>`;
  }
  return out;
}

// Type straight into a label or text on the chart: an editor laid over it, in the same place and
// size. It applies as you type; Ctrl+Enter, Esc or a click elsewhere finishes (empty text goes).
function editText(item) {
  const l = layer;
  if (!l || !hasText(item.type) || editing) return;
  const field = document.createElement("textarea");
  field.className = "draw-edit";
  field.value = item.text || "";
  field.maxLength = 500;
  field.spellcheck = false;
  const isLabel = item.type === "label";
  let edited = false;
  const place = () => {
    const ctx = l.pane.context();
    const a = toPixel(item.p1, ctx);
    const b = isLabel ? toPixel(item.p2, ctx) : a;
    if (!a || !b) return;
    const g = isLabel ? labelGeom(item, a, b) : textGeom(item);
    const color = escapeHtml(item.color);
    field.style.cssText = `left:${isLabel ? g.x : a.x - 3}px; top:${isLabel ? g.top : a.y - 3}px; ` +
      `width:${g.width + (isLabel ? 12 : 12)}px; height:${g.height + (isLabel ? 0 : 6)}px; ` +
      `font-size:${g.size}px; line-height:${g.lh}px; color:${isLabel ? "#fff" : color}; ` +
      (isLabel ? `padding:5px 8px; background:rgba(14,16,21,.97); border:${Math.min(item.width, 2)}px solid ${color};` : "padding:3px; background:transparent; border:1px dashed rgba(255,255,255,.35);") +
      (!isLabel && item.boxW ? "" : " white-space:pre;");
  };
  const done = () => {
    document.removeEventListener("pointerdown", outside, true);
    field.remove();
    editing = null;
    if (!item.text.trim() && item.type === "text") {
      replaceList(list().filter((each) => each.id !== item.id));
      selected = null;
    }
    persist();
  };
  const outside = (event) => { if (event.target !== field) done(); };
  field.addEventListener("input", () => {
    if (!edited) { remember(); edited = true; }
    item.text = field.value;
    place();
    render();
  });
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); done(); }
    else if (event.key === "Escape") { event.preventDefault(); done(); }
    event.stopPropagation();
  });
  l.pane.root.appendChild(field);
  editing = item.id;
  selected = item.id;
  place();
  render();
  document.addEventListener("pointerdown", outside, true);
  field.focus();
  field.select();
}

// Price-tag text that reads on the line's colour: dark on light fills, white on dark ones.
const colorProbe = document.createElement("canvas").getContext("2d");
function tagTextColor(color) {
  const probe = colorProbe;
  probe.fillStyle = "#000";
  probe.fillStyle = color; // an unparseable colour keeps black, so falls back to white text
  const hex = probe.fillStyle;
  const [r, g, b] = hex.startsWith("#") ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    : (hex.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000" : "#fff";
}

const handleAt = (item, end, at) =>
  `<circle class="handle" data-id="${item.id}" data-end="${end}" cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="5" fill="#000" stroke="${escapeHtml(item.color)}" stroke-width="2"/>`;

// A box between two corners, lightly filled; picked up by its edge so the chart inside still
// pans. "c12" is the corner at p1's time and p2's price, "c21" the other way round.
function rectShape(item, ctx, isSelected) {
  const a = toPixel(item.p1, ctx);
  const b = toPixel(item.p2, ctx);
  if (!a || !b) return "";
  const box = `x="${Math.min(a.x, b.x).toFixed(1)}" y="${Math.min(a.y, b.y).toFixed(1)}" width="${Math.abs(b.x - a.x).toFixed(1)}" height="${Math.abs(b.y - a.y).toFixed(1)}"`;
  const color = escapeHtml(item.color);
  const dash = DASHES[item.dash] ? ` stroke-dasharray="${DASHES[item.dash]}"` : "";
  let out = `<rect ${box} fill="${color}" fill-opacity=".14" stroke="${color}" stroke-width="${item.width}"${dash}/>`;
  if (item.id) out += `<rect class="hit" data-id="${item.id}" ${box} fill="none" stroke="transparent" stroke-width="${HIT_PX}"/>`;
  if (isSelected && !item.locked) {
    for (const [end, at] of [["p1", a], ["p2", b], ["c12", { x: a.x, y: b.y }], ["c21", { x: b.x, y: a.y }]]) out += handleAt(item, end, at);
  }
  return out;
}

// An arrowhead at b, pointing away from a, sized to the line.
function arrowHead(a, b, item) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1) return "";
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const size = 7 + item.width * 2.5;
  const base = { x: b.x - ux * size, y: b.y - uy * size };
  const half = size * 0.55;
  const pts = [b, { x: base.x - uy * half, y: base.y + ux * half }, { x: base.x + uy * half, y: base.y - ux * half }];
  return `<polygon points="${pts.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ")}" fill="${escapeHtml(item.color)}"/>`;
}

function shape(item, ctx, isSelected) {
  if (item.type === "text") return textShape(item, ctx, isSelected);
  if (item.type === "rect") return rectShape(item, ctx, isSelected);
  if (item.type === "image") return imageShape(item, ctx, isSelected);
  const ends = lineEnds(item, ctx);
  if (!ends) return "";
  const [a, b] = ends;
  const coords = `x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"`;
  const dash = DASHES[item.dash] ? ` stroke-dasharray="${DASHES[item.dash]}"` : "";
  let out = `<line ${coords} stroke="${escapeHtml(item.color)}" stroke-width="${item.width}"${dash} stroke-linecap="round"/>`;
  if (item.id) out += `<line class="hit" data-id="${item.id}" ${coords} stroke="transparent" stroke-width="${HIT_PX}"/>`;
  if (item.type === "hline" || item.type === "hray") {
    const y = a.y;
    out += `<g class="tag"><rect x="${ctx.plotWidth + 1}" y="${(y - 9).toFixed(1)}" width="62" height="18" rx="2" fill="${escapeHtml(item.color)}"/>` +
      `<text x="${ctx.plotWidth + 6}" y="${(y + 4).toFixed(1)}" fill="${tagTextColor(item.color)}" font-size="11" font-family="Inter, sans-serif">${fmtPrice(item.p1.p)}</text></g>`;
  }
  if (item.type === "label") out += labelBox(item, a, b);
  if (item.type === "arrow") out += arrowHead(a, b, item);
  if (isSelected && !item.locked) {
    const middle = item.type === "hline" ? { x: ctx.plotWidth / 2, y: a.y }
      : item.type === "vline" ? { x: a.x, y: ctx.box.top + ctx.box.height / 2 } : a;
    const points = twoPoint(item.type) ? [["p1", toPixel(item.p1, ctx)], ["p2", toPixel(item.p2, ctx)]] : [["p1", middle]];
    for (const [end, at] of points) if (at) out += handleAt(item, end, at);
  }
  return out;
}

// Every chart's layer, or one. The working layer also shows the drawing being placed and the
// selection's handles.
function render(only = null) {
  for (const each of layers.values()) if (!only || each.pane === only) renderLayer(each);
  renderToolbar();
}

function renderLayer(l) {
  const { svg, pane } = l;
  const ctx = pane.context();
  const area = pane.root;
  if (area.hidden || !area.clientWidth) return; // a chart that isn't showing (e.g. outside Chart mode)
  svg.setAttribute("width", area.clientWidth);
  svg.setAttribute("height", area.clientHeight);
  if (!ctx.bars.length || hidden) { svg.innerHTML = ""; l.images.replaceChildren(); return; }
  const working = l === layer;
  const items = [...itemsOf(l)];
  if (pending && working) items.push({ ...pending, id: null });
  renderImages(l, items, ctx);
  const isSelected = (item) => working && item.id === selected;
  const clip = `draw-clip-${pane.side}`;
  svg.innerHTML =
    `<defs><clipPath id="${clip}"><rect x="0" y="${ctx.box.top}" width="${ctx.plotWidth}" height="${ctx.box.height}"/></clipPath></defs>` +
    `<g clip-path="url(#${clip})">${items.filter((item) => clipped(item.type)).map((item) => shape(item, ctx, isSelected(item))).join("")}</g>` +
    items.filter((item) => !clipped(item.type)).map((item) => shape(item, ctx, isSelected(item))).join("");
}

function renderToolbar() {
  const bar = $("draw-toolbar");
  const item = layer && selected && find(selected);
  bar.hidden = !item;
  if (!item) { bar.dataset.id = ""; return; }
  positionToolbar();
  const sig = item.id + (item.boxW ? "w" : ""); // rebuilt when "Auto width" should appear or go
  if (bar.dataset.id === sig) return; // keep focus on the controls while editing
  bar.dataset.id = sig;
  const line = item.type !== "text" && item.type !== "image";
  bar.innerHTML =
    `<span class="db-grip" title="Drag to move">${FLOAT_GRIP}</span>` +
    (item.type === "image" ? `<button data-k="natural" title="Back to the image's own size (up to ${IMAGE_MAX_W}px wide)">Reset size</button>` : swatch(escapeHtml(item.color), `data-k="color" title="${line ? "Colour" : "Text colour"}"`)) +
    (hasText(item.type) ? `<select data-k="size" title="Text size">${SIZES.map((n) => `<option value="${n}" ${(item.size || (item.type === "text" ? 14 : 12)) === n ? "selected" : ""}>${n}px</option>`).join("")}</select>` : "") +
    (line ? `<select data-k="width" title="Width">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${item.width === n ? "selected" : ""}>${n}px</option>`).join("")}</select>` +
    `<select data-k="dash" title="Style">${[[0, "Solid"], [2, "Dashed"], [1, "Dotted"]].map(([v, l]) => `<option value="${v}" ${item.dash === v ? "selected" : ""}>${l}</option>`).join("")}</select>` : "") +
    (item.type === "trend" ? `<label title="Extend right into a ray"><input type="checkbox" data-k="extend" ${item.extend ? "checked" : ""}> Ray</label>` : "") +
    (item.type === "text" && item.boxW ? `<button data-k="autowidth" title="Stop wrapping: one line per line you type">Auto width</button>` : "") +
    (alertable(item) ? `<button class="icon${alertHooks.has(item.id) ? " active" : ""}" data-k="alert" title="${alertHooks.has(item.id) ? "Edit its alert" : "Add an alert on this line (⌥A)"}" aria-label="Alert"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5V8a4.5 4.5 0 0 1 9 0v4.5l1.2 1.5H3.3zM7.5 15.5a1.6 1.6 0 0 0 3 0"/></svg></button>` : "") +
    `<button class="icon" data-k="delete" title="Remove (Delete)" aria-label="Remove drawing"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h12M7 5V3h4v2M4.5 5l.8 10h7.4l.8-10M7.5 8v4.5M10.5 8v4.5"/></svg></button>`;
}

// ---------- images ----------

// An image hangs from its top-left point and keeps its size in pixels (`w`, and `ratio` for the
// height), so zooming the chart moves it but never stretches it. The pictures themselves are
// <img> elements under the SVG, kept from one render to the next so a GIF doesn't restart; the
// SVG only carries the box you pick it up by and its handles.
const IMAGE_MAX_W = 240;
const imageSize = (item) => ({ w: item.w, h: item.w / (item.ratio || 1) });

function imageShape(item, ctx, isSelected) {
  const a = toPixel(item.p1, ctx);
  if (!a) return "";
  const { w, h } = imageSize(item);
  const box = `x="${a.x.toFixed(1)}" y="${a.y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"`;
  if (!item.id) return `<rect ${box} fill="none" stroke="rgba(255,255,255,.35)" stroke-dasharray="3 3"/>`;
  let out = `<rect class="hit hit-box" data-id="${item.id}" ${box} fill="transparent"` +
    `${isSelected ? ' stroke="rgba(255,255,255,.5)" stroke-dasharray="3 3"' : ""}/>`;
  if (isSelected && !item.locked) {
    out += `<circle class="handle" data-id="${item.id}" data-end="p1" cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="4" fill="#000" stroke="#fff" stroke-width="2"/>` +
      `<rect class="handle nwse" data-id="${item.id}" data-end="size" x="${(a.x + w - 5).toFixed(1)}" y="${(a.y + h - 5).toFixed(1)}" width="10" height="10" rx="2" fill="#000" stroke="#fff" stroke-width="1.5"/>`;
  }
  return out;
}

function renderImages(l, items, ctx) {
  const holder = l.images;
  holder.style.cssText = `top:${ctx.box.top}px; width:${ctx.plotWidth}px; height:${ctx.box.height}px;`;
  const keep = new Set();
  for (const item of items) {
    if (item.type !== "image" || !item.src) continue;
    const a = toPixel(item.p1, ctx);
    if (!a) continue;
    const id = item.id || "pending";
    keep.add(id);
    let img = holder.querySelector(`img[data-id="${id}"]`);
    if (!img || img.getAttribute("src") !== item.src) {
      img?.remove();
      img = document.createElement("img");
      img.dataset.id = id;
      img.alt = "";
      img.draggable = false;
      img.src = item.src;
      holder.append(img);
    }
    const { w, h } = imageSize(item);
    img.style.cssText = `left:${a.x.toFixed(1)}px; top:${(a.y - ctx.box.top).toFixed(1)}px; width:${w.toFixed(1)}px; height:${h.toFixed(1)}px;`;
  }
  for (const img of [...holder.children]) if (!keep.has(img.dataset.id)) img.remove();
}

// Upload a picture and put it in the middle of the working chart, selected.
export async function addImage(file) {
  if (!file || !/^image\/(gif|png|jpeg|webp)$/.test(file.type)) return toast("Pick a GIF, PNG, JPEG or WebP image");
  if (!layer || !chartContext().bars.length) return toast("Open a chart first");
  const owner = layer;
  let url;
  try {
    ({ url } = await api("/api/images", { method: "POST", body: file, headers: { "Content-Type": file.type } }));
  } catch (error) {
    return toast(`Couldn't add the image: ${error.message}`);
  }
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { return toast("Couldn't read that image"); }
  if (layer !== owner) return; // the chart changed while it uploaded
  const ctx = chartContext();
  const w = Math.max(24, Math.min(IMAGE_MAX_W, img.naturalWidth, ctx.plotWidth * 0.5));
  const ratio = img.naturalWidth / img.naturalHeight || 1;
  const x = ctx.plotWidth / 2 - w / 2;
  const y = ctx.box.height / 2 - w / ratio / 2;
  const logical = ctx.chart.timeScale().coordinateToLogical(x);
  const price = ctx.candles.coordinateToPrice(y);
  if (logical == null || price == null) return;
  if (tool) setTool(null);
  if (hidden) toggleDrawingsHidden();
  pending = { type: "image", p1: { t: logicalToTime(Math.round(logical), ctx.bars, ctx.interval), p: price }, src: url, w, ratio };
  finish();
}

// The toolbar's Image button: pick a file.
export function pickImage() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/gif,image/png,image/jpeg,image/webp";
  input.addEventListener("change", () => addImage(input.files[0]));
  input.click();
}

// ---------- editing ----------

function remember() {
  history.undo.push(JSON.stringify(list()));
  if (history.undo.length > 100) history.undo.shift();
  history.redo = [];
}

function replaceList(items) {
  if (key) saved.symbols[key] = items;
  else scratch = items;
}

let saveTimer = 0;
function persist() {
  render();
  if (!key) return;
  if (saved.symbols[key] && !saved.symbols[key].length) delete saved.symbols[key];
  sync();
  if (alertHooks) alertHooks.saved(key, list());
}

function sync() {
  saved.savedAt = new Date().toISOString();
  store.set("drawings", saved);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api("/api/settings/drawings", { method: "PUT", body: JSON.stringify(saved) })
      .catch((error) => toast(`Couldn't save drawings: ${error.message}`));
  }, 600);
}

const stored = (point) => ({ t: point.t, p: point.p });

function finish() {
  const { start, awaiting, ...rest } = pending;
  const item = { ...rest, p1: stored(rest.p1), ...(rest.p2 ? { p2: stored(rest.p2) } : {}), id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` };
  pending = null;
  setTool(null);
  remember();
  replaceList([...list(), item]);
  selected = item.id;
  persist();
  if (hasText(item.type)) setTimeout(() => editText(item), 0);
}

export function setTool(next) {
  tool = next;
  pending = null;
  if (tool && hidden) toggleDrawingsHidden(); // drawing brings the others back
  watchers.forEach((fn) => fn());
  if (tool) work(layerFor(activePane())); // drawing tools act on the active chart
  for (const each of layers.values()) each.svg.classList.toggle("capture", Boolean(tool) && each === layer);
  document.querySelectorAll("[data-tool]").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
  render();
}

export const drawingTool = () => tool;
export const drawingsHidden = () => hidden;
export const onDrawingTool = (fn) => watchers.push(fn); // tool picked, or drawings hidden / shown

export function toggleDrawingsHidden() {
  hidden = !hidden;
  store.set("drawingsHidden", hidden);
  if (hidden) { selected = null; if (tool) setTool(null); }
  render();
  watchers.forEach((fn) => fn());
}
export const hasSelection = () => Boolean(selected && find(selected));
// The selected horizontal line or ray, for ⌥A to put an alert on.
export function selectedLevel() {
  const item = hasSelection() && find(selected);
  return item && alertable(item) ? { item, key } : null;
}
// The bell's state changed (an alert added or removed): draw the settings bar again.
export function refreshDrawingBar() {
  $("draw-toolbar").dataset.id = "";
  renderToolbar();
}

// Escape: drop the half-placed drawing, then the tool, then the selection.
export function cancelDrawing() {
  if (pending || tool) { setTool(null); return true; }
  if (selected) { selected = null; render(); return true; }
  return false;
}

export function deleteSelected() {
  if (!hasSelection()) return false;
  if (find(selected).locked) return toast("Unlock it first"), true;
  remember();
  replaceList(list().filter((item) => item.id !== selected));
  selected = null;
  persist();
  return true;
}

// A copy a few bars along and a little lower, selected so it can be dragged where it goes.
const COPY_BARS = 5;
const COPY_DROP = 0.98;
function duplicate(item) {
  const ctx = chartContext();
  const copy = JSON.parse(JSON.stringify(item));
  delete copy.locked;
  copy.id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  for (const end of ["p1", "p2"]) {
    if (!copy[end]) continue;
    const at = timeToLogical(copy[end].t, ctx.bars, ctx.interval);
    copy[end] = { t: logicalToTime(at + COPY_BARS, ctx.bars, ctx.interval), p: copy[end].p * COPY_DROP };
  }
  remember();
  replaceList([...list(), copy]);
  selected = copy.id;
  persist();
}

export function duplicateSelected() {
  const item = hasSelection() && find(selected);
  if (!item) return toast("Select a drawing to clone it");
  duplicate(item);
}

function lock(item) {
  remember();
  item.locked = !item.locked;
  persist();
}

const TYPE_NAMES = {
  trend: "Trend line", arrow: "Arrow", hline: "Horizontal line", hray: "Horizontal ray", vline: "Vertical line",
  rect: "Rectangle", label: "Label", text: "Text", image: "Image",
};

// Dates use the chart's wall clock, including intraday bars, and snap to the nearest bar.
function editPosition(item, event) {
  if (item.locked) return;
  closePosition();
  const owner = layer;
  const ctx = chartContext();
  if (!ctx.bars.length) return;
  const card = document.createElement("form");
  card.className = "dlg draw-position";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Edit drawing position");
  const intra = intradayChart(ctx.bars);
  const fields = [];
  for (const end of item.p2 ? ["p1", "p2"] : ["p1"]) {
    if (item.type !== "hline") {
      const t = inDomain(item[end].t, ctx.bars);
      fields.push({ end, key: "t", label: item.p2 ? `Anchor ${end.slice(1)} date` : "Date",
        type: intra ? "datetime-local" : "date", value: intra ? new Date(t * 1000).toISOString().slice(0, 16) : t });
    }
    if (item.type !== "vline") fields.push({ end, key: "p", label: item.p2 ? `Anchor ${end.slice(1)} price` : "Price",
      type: "number", value: ctx.candles.priceFormatter().format(item[end].p) });
  }
  card.innerHTML = `<div class="dlg-title">${TYPE_NAMES[item.type]} position</div>` +
    fields.map((field, i) => `<label class="dlg-field">${field.label}<input name="f${i}" type="${field.type}" step="any" required value="${escapeHtml(String(field.value))}"></label>`).join("") +
    (item.type !== "hline" ? '<div class="dlg-hint">Dates snap to the nearest bar.</div>' : "") +
    '<div class="dlg-buttons"><button type="button" class="dlg-cancel">Cancel</button><button class="dlg-ok" type="submit">Apply</button></div>';
  const opener = document.activeElement;
  const finish = () => {
    card.remove();
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", position);
    closePosition = () => {};
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const outside = (e) => { if (!card.contains(e.target)) finish(); };
  const position = () => {
    card.style.left = `${Math.max(4, Math.min(event.clientX + 12, innerWidth - card.offsetWidth - 4))}px`;
    card.style.top = `${Math.max(4, Math.min(event.clientY + 12, innerHeight - card.offsetHeight - 4))}px`;
  };
  card.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); finish(); }
  });
  card.addEventListener("submit", (e) => {
    e.preventDefault();
    if (layer !== owner || find(item.id) !== item || item.locked) return finish();
    const points = { p1: { ...item.p1 }, ...(item.p2 ? { p2: { ...item.p2 } } : {}) };
    for (const [i, field] of fields.entries()) {
      const input = card.elements.namedItem(`f${i}`);
      if (input.value === String(field.value)) continue; // don't round untouched prices or dates
      if (field.key === "p") {
        const price = Number(input.value);
        if (!Number.isFinite(price)) return;
        points[field.end].p = price;
      } else {
        const ms = Date.parse(input.value + (intra ? "Z" : "T00:00:00Z"));
        if (!Number.isFinite(ms)) return;
        const stamp = (bar) => intra ? bar.time * 1000 : toMs(bar.time);
        const nearest = ctx.bars.reduce((a, b) => Math.abs(stamp(b) - ms) < Math.abs(stamp(a) - ms) ? b : a);
        points[field.end].t = nearest.time;
      }
    }
    if (JSON.stringify(points) !== JSON.stringify({ p1: item.p1, ...(item.p2 ? { p2: item.p2 } : {}) })) {
      remember();
      Object.assign(item, points);
      persist();
    }
    finish();
  });
  card.querySelector(".dlg-cancel").addEventListener("click", finish);
  document.body.append(card);
  position();
  card.querySelector("input").focus();
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", position);
  closePosition = finish;
}

// For the right-click menu: what is under the pointer in `pane`'s chart. A drawing hit is
// selected, as a click would. `addLine` puts a horizontal line at the pointer's price.
export function drawingsAt(pane, event) {
  work(layerFor(pane));
  const hit = event.target.closest(".hit, .handle");
  const item = hit ? find(hit.dataset.id) : null;
  if (item) { selected = item.id; render(); }
  const point = pointAt(event, false);
  return {
    count: list().length,
    item: item && {
      name: TYPE_NAMES[item.type] || "Drawing", text: hasText(item.type), locked: Boolean(item.locked),
      edit: () => editText(item), position: () => editPosition(item, event), remove: deleteSelected, duplicate: () => duplicate(item), lock: () => lock(item),
    },
    price: point ? point.p : null,
    addLine() {
      pending = { type: "hline", p1: point, ...DEFAULT_STYLE, ...saved.defaults?.hline };
      finish();
    },
  };
}

export function undo() {
  if (!history.undo.length) return toast("Nothing to undo");
  history.redo.push(JSON.stringify(list()));
  replaceList(JSON.parse(history.undo.pop()));
  selected = null;
  persist();
}

export function redo() {
  if (!history.redo.length) return toast("Nothing to redo");
  history.undo.push(JSON.stringify(list()));
  replaceList(JSON.parse(history.redo.pop()));
  selected = null;
  persist();
}

export function removeAllDrawings() {
  if (!list().length) return toast("No drawings on this chart");
  remember();
  replaceList([]);
  selected = null;
  persist();
  toast("Drawings removed · Ctrl+Z brings them back");
}

// Shift holds a trend line level, like TradingView: the moving end takes the anchor's price.
function level(point, anchor, event) {
  return point && anchor && event.shiftKey ? { ...point, p: anchor.p } : point;
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const target = event.target;
  if (tool) {
    event.preventDefault();
    event.stopPropagation();
    const point = pointAt(event);
    if (!point) return;
    const type = tool === "ray" ? "trend" : tool;
    if (!twoPoint(type)) {
      pending = {
        type, p1: point, ...DEFAULT_STYLE, ...(type === "text" ? { text: "Text", size: 14, color: "#ffffff" } : {}),
        ...saved.defaults?.[type],
      };
      return finish();
    }
    if (pending && pending.awaiting) {
      pending.p2 = level(point, pending.p1, event);
      return finish();
    }
    pending = {
      type, p1: point, p2: point, ...(type === "label" ? { text: "Label", size: 12 } : {}),
      ...DEFAULT_STYLE, ...saved.defaults?.[type], ...(type === "trend" ? { extend: tool === "ray" } : {}),
      start: localXY(event),
    };
    layer.svg.setPointerCapture(event.pointerId);
    return render();
  }
  const handle = target.closest(".handle");
  const hit = target.closest(".hit");
  if (!handle && !hit) return;
  event.preventDefault();
  event.stopPropagation();
  const item = find((handle || hit).dataset.id);
  if (!item) return;
  const again = lastHit && lastHit.id === item.id && event.timeStamp - lastHit.at < 400;
  lastHit = { id: item.id, at: event.timeStamp };
  selected = item.id;
  if (item.locked) return render(); // selectable, but it stays where it is
  if (again) { // a double click edits the text in place, or a line's exact coordinates
    lastHit = null;
    render();
    return setTimeout(() => (hasText(item.type) ? editText(item) : editPosition(item, event)), 0);
  }
  const origin = pointAt(event, false);
  const ctx = chartContext();
  drag = {
    item, end: handle ? handle.dataset.end : null, origin, moved: false, before: JSON.stringify(list()),
    start: { p1: { ...item.p1 }, p2: item.p2 ? { ...item.p2 } : null },
    logicals: {
      p1: timeToLogical(item.p1.t, ctx.bars, ctx.interval),
      p2: item.p2 ? timeToLogical(item.p2.t, ctx.bars, ctx.interval) : null,
    },
  };
  layer.svg.setPointerCapture(event.pointerId);
  render();
}

function onPointerMove(event) {
  if (pending && twoPoint(pending.type)) {
    const point = level(pointAt(event), pending.p1, event);
    if (point) { pending.p2 = point; render(); }
    return;
  }
  if (!drag) return;
  const ctx = chartContext();
  if (drag.end === "width") {
    const at = toPixel(drag.item.p1, ctx);
    if (at) drag.item.boxW = Math.max(40, Math.round(localXY(event).x - at.x));
  } else if (drag.end === "size") { // an image's corner: wider or narrower, same shape
    const at = toPixel(drag.item.p1, ctx);
    const here = localXY(event);
    const ratio = drag.item.ratio || 1;
    // Follow whichever way the corner went further, so a mostly-down drag still grows it.
    if (at) drag.item.w = Math.round(Math.max(24, here.x - at.x, (here.y - at.y) * ratio));
  } else if (drag.end === "c12" || drag.end === "c21") { // a rectangle's other two corners
    const point = pointAt(event);
    const [timeEnd, priceEnd] = drag.end === "c12" ? ["p1", "p2"] : ["p2", "p1"];
    if (point) { drag.item[timeEnd] = { ...drag.item[timeEnd], t: point.t }; drag.item[priceEnd] = { ...drag.item[priceEnd], p: point.p }; }
  } else if (drag.end) {
    const other = drag.end === "p1" ? drag.item.p2 : drag.item.p1;
    const point = twoPoint(drag.item.type) ? level(pointAt(event), other, event) : pointAt(event);
    if (point) drag.item[drag.end] = { t: point.t, p: point.p };
  } else {
    const here = pointAt(event, false);
    if (!here || !drag.origin) return;
    const shift = here.logical - drag.origin.logical;
    const dp = here.p - drag.origin.p;
    for (const end of ["p1", "p2"]) {
      if (!drag.start[end]) continue;
      drag.item[end] = {
        t: logicalToTime(drag.logicals[end] + shift, ctx.bars, ctx.interval),
        p: drag.start[end].p + dp,
      };
    }
  }
  drag.moved = true;
  render();
}

function onPointerUp(event) {
  if (pending && twoPoint(pending.type) && pending.start) {
    const at = localXY(event);
    if (Math.hypot(at.x - pending.start.x, at.y - pending.start.y) > 5) return finish();
    pending.awaiting = true; // click, move, click
    delete pending.start;
    return;
  }
  if (!drag) return;
  if (drag.moved) {
    history.undo.push(drag.before);
    history.redo = [];
    persist();
  }
  drag = null;
}

function onToolbar(event) {
  const el = event.target.closest("[data-k]"); // a click on the trash icon lands on its <path>
  const item = selected && find(selected);
  if (!item || !el) return;
  if (el.dataset.k === "delete") return event.type === "click" && deleteSelected();
  if (el.dataset.k === "alert") return event.type === "click" && alertHooks.open(item, key);
  if (el.dataset.k === "natural") {
    if (event.type !== "click") return;
    const img = new Image();
    img.src = item.src;
    img.decode().then(() => {
      remember();
      item.w = Math.max(24, Math.min(IMAGE_MAX_W, img.naturalWidth));
      item.ratio = img.naturalWidth / img.naturalHeight || item.ratio;
      persist();
    }).catch(() => toast("Couldn't read that image"));
    return;
  }
  if (el.dataset.k === "autowidth") {
    if (event.type !== "click") return;
    remember();
    delete item.boxW;
    return persist();
  }
  if (event.type !== "change") return;
  remember();
  if (el.dataset.k === "extend") item.extend = el.checked;
  else if (el.dataset.k === "color") item.color = el.value;
  else item[el.dataset.k] = Number(el.value);
  // The next drawing of this kind starts with the style you just chose (trend line or ray is
  // the tool's choice).
  const { color, width, dash, size } = item;
  saved.defaults = { ...saved.defaults, [item.type]: { color, width, dash, ...(size ? { size } : {}) } };
  persist();
  if (!key) sync();
}

// ---------- layers ----------

// A chart's layer, made (and wired up) the first time it is needed.
function layerFor(pane) {
  if (!layers.has(pane)) {
    const svg = pane.root.querySelector('[data-part="drawings"]');
    const images = document.createElement("div");
    images.className = "draw-images";
    svg.before(images);
    const l = { pane, svg, images, key: null, scratch: [] };
    layers.set(pane, l);
    // Drop an image file on a chart, as well as the toolbar's Image button and pasting.
    pane.root.addEventListener("dragover", (event) => {
      if ([...event.dataTransfer.items].some((each) => each.kind === "file")) event.preventDefault();
    });
    pane.root.addEventListener("drop", (event) => {
      const file = [...event.dataTransfer.files].find((each) => each.type.startsWith("image/"));
      if (!file) return;
      event.preventDefault();
      work(l);
      addImage(file);
    });
    const enter = (handler) => (event) => { work(l); handler(event); };
    l.svg.addEventListener("pointerdown", enter(onPointerDown));
    l.svg.addEventListener("pointermove", (event) => { if (l === layer) onPointerMove(event); });
    l.svg.addEventListener("pointerup", (event) => { if (l === layer) onPointerUp(event); });
    l.svg.addEventListener("pointercancel", (event) => { if (l === layer) onPointerUp(event); });
    // Moving over the chart while placing the second point of a click-click trend line.
    pane.root.addEventListener("pointermove", (event) => { if (l === layer && pending && pending.awaiting) onPointerMove(event); });
    // Clicking empty chart drops the selection.
    pane.root.querySelector('[data-part="chart"]').addEventListener("pointerdown", () => {
      if (l === layer && selected && !drag) { selected = null; render(); }
    });
  }
  return layers.get(pane);
}

// Make a chart's layer the working one: its symbol's list is the one being edited.
function work(l) {
  if (l === layer) return;
  closePosition();
  if (layer) { layer.key = key; layer.scratch = scratch; }
  layer = l;
  key = l.key;
  scratch = l.scratch;
  selected = null;
  pending = null;
  history.undo = [];
  history.redo = [];
  for (const each of layers.values()) each.svg.classList.toggle("capture", Boolean(tool) && each === layer);
  render();
}

onChartLoad(({ pane, symbol, anonymous }) => {
  const l = layerFor(pane);
  const next = anonymous ? null : ticker(symbol);
  if (next !== l.key || anonymous) {
    if (l === layer) closePosition();
    l.key = next;
    l.scratch = [];
    if (l === layer) {
      key = next;
      scratch = [];
      selected = null;
      pending = null;
      history.undo = [];
      history.redo = [];
    }
  }
  if (!layer) work(l);
  render(pane);
});
onChartRender((pane) => { if (layers.has(pane)) render(pane); });
onChartActivate((pane) => work(layerFor(pane)));

export async function syncDrawings() {
  try {
    const { value } = await api("/api/settings/drawings");
    if (!value) return;
    if ((value.savedAt || "") <= (saved.savedAt || "")) return;
    saved = { version: 1, symbols: {}, ...value };
    store.set("drawings", saved);
    render();
  } catch {}
}

export function bindDrawings() {
  const bar = $("draw-toolbar");
  document.body.append(bar);
  positionToolbar = floatingCard(bar, "drawingSettingsPosition", ".db-grip", () => {
    const box = layer.pane.root.getBoundingClientRect();
    return { x: box.right - bar.offsetWidth - 90, y: box.top + 8 };
  });
  bar.addEventListener("pointerdown", (event) => event.stopPropagation());
  work(layerFor(activePane()));
  $("draw-toolbar").addEventListener("change", onToolbar);
  $("draw-toolbar").addEventListener("click", onToolbar);
  document.querySelectorAll("[data-tool]").forEach((button) =>
    button.addEventListener("click", () => setTool(tool === button.dataset.tool ? null : button.dataset.tool)));
  window.addEventListener("resize", () => scheduleCallouts());
  // Paste an image (a copied GIF file or screenshot) onto the chart.
  document.addEventListener("paste", (event) => {
    if (event.target.closest?.("input, textarea, [contenteditable]") || !document.body.classList.contains("mode-chart")) return;
    const file = [...(event.clipboardData?.files || [])].find((each) => each.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    addImage(file);
  });
  syncDrawings();
}
