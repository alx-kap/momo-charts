import { fmtPrice } from "./util.js";
import { onChartLoad, onChartRender } from "./chart.js";
import { drawingTool } from "./drawings.js";

// Measure a move, like TradingView: hold Shift and click the first point, then click the second
// (or hold Shift and drag). A see-through box spans
// the bars and prices you dragged over, labelled with the price change (dollars and percent) and
// how many bars and how much time it covers. It isn't saved: the next click anywhere, Esc, or a
// new symbol clears it. Ends snap to whole bars, so the bar count is exact.

const INTRADAY = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600 };
const panes = new Map(); // pane -> { layer, box, label, range }
let armed = false; // the toolbar's measure button: the next press measures without Shift

// Arm (or disarm) a measure from the toolbar; its button shows the state.
export function armMeasure(on = !armed) {
  armed = on;
  document.querySelectorAll("[data-measure]").forEach((button) => button.classList.toggle("active", armed));
}

function ensure(pane) {
  if (panes.has(pane)) return panes.get(pane);
  const layer = document.createElement("div");
  layer.className = "measure";
  layer.innerHTML = '<div class="m-box"></div><div class="m-label"></div>';
  pane.root.append(layer);
  const state = { layer, box: layer.firstChild, label: layer.lastChild, range: null };
  layer.hidden = true;
  panes.set(pane, state);
  pane.root.addEventListener("pointerdown", (event) => start(pane, state, event), true);
  pane.root.addEventListener("pointermove", (event) => { if (state.dragging || state.awaiting) move(pane, state, event); });
  // A press that barely moves is a click: the box then follows the pointer until the next click.
  pane.root.addEventListener("pointerup", (event) => {
    if (!state.dragging) return;
    state.dragging = false;
    state.awaiting = Math.hypot(event.clientX - state.down.x, event.clientY - state.down.y) < 4;
  });
  pane.root.addEventListener("pointercancel", () => { state.dragging = false; });
  return state;
}

function clear(state) {
  state.range = null;
  state.dragging = false;
  state.awaiting = false;
  state.layer.hidden = true;
}

// Where a pointer is on the chart: a whole bar and a price, or null outside the plot area.
function locate(pane, event) {
  const ctx = pane.context();
  const rect = pane.root.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (!ctx.bars.length || x < 0 || x > ctx.plotWidth || y < ctx.box.top || y > ctx.box.top + ctx.box.height) return null;
  const logical = ctx.chart.timeScale().coordinateToLogical(x);
  const price = ctx.candles.coordinateToPrice(y);
  return logical == null || price == null ? null : { i: Math.round(logical), p: price };
}

function start(pane, state, event) {
  if (event.button !== 0) return;
  if (state.awaiting) { // the second click
    const end = locate(pane, event);
    if (end) state.range.b = end;
    state.awaiting = false;
    event.preventDefault();
    event.stopPropagation();
    return draw(pane);
  }
  if (!(event.shiftKey || armed) || drawingTool()) return;
  const at = locate(pane, event);
  if (!at) return;
  armMeasure(false);
  event.preventDefault();
  event.stopPropagation(); // not a chart pan
  pane.root.setPointerCapture(event.pointerId);
  state.dragging = true;
  state.down = { x: event.clientX, y: event.clientY };
  state.range = { a: at, b: at };
  draw(pane);
}

function move(pane, state, event) {
  const at = locate(pane, event);
  if (at) { state.range.b = at; draw(pane); }
}

function span(bars, a, b, interval) {
  const last = bars.length - 1;
  const clamp = (i) => Math.max(0, Math.min(last, i));
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const count = hi - lo;
  const from = bars[clamp(lo)].time;
  const to = bars[clamp(hi)].time;
  const intraday = typeof from === "number";
  let seconds = intraday ? to - from : (Date.parse(to) - Date.parse(from)) / 1000;
  // Past either end of the data there are no bars to read: count a bar's usual length.
  const unit = /^(\d+)([DWM])$/.exec(interval || "1D");
  const step = intraday ? INTRADAY[interval] || 60
    : (unit ? Number(unit[1]) * { D: 1.4, W: 7, M: 30 }[unit[2]] : 1.4) * 86400;
  seconds += (Math.max(0, hi - last) + Math.max(0, -lo)) * step;
  return { count, time: duration(seconds, intraday) };
}

function duration(seconds, intraday) {
  const days = seconds / 86400;
  if (!intraday || days >= 1) {
    const d = Math.round(days);
    if (!intraday) return `${d}d`;
    const hours = Math.round((seconds - Math.floor(days) * 86400) / 3600);
    return hours ? `${Math.floor(days)}d ${hours}h` : `${Math.floor(days)}d`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

function draw(pane) {
  const state = panes.get(pane);
  if (!state || !state.range) return;
  const ctx = pane.context();
  const { a, b } = state.range;
  const scale = ctx.chart.timeScale();
  const x1 = scale.logicalToCoordinate(Math.min(a.i, b.i));
  const x2 = scale.logicalToCoordinate(Math.max(a.i, b.i));
  const y1 = ctx.candles.priceToCoordinate(a.p);
  const y2 = ctx.candles.priceToCoordinate(b.p);
  if ([x1, x2, y1, y2].some((v) => v == null)) { state.layer.hidden = true; return; }
  const up = b.p >= a.p;
  const change = b.p - a.p;
  const { count, time } = span(ctx.bars, a.i, b.i, ctx.interval);
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  state.layer.hidden = false;
  state.layer.classList.toggle("up", up);
  Object.assign(state.box.style, {
    left: `${x1}px`, width: `${Math.max(1, x2 - x1)}px`, top: `${Math.min(y1, y2)}px`, height: `${Math.max(1, Math.abs(y2 - y1))}px`,
  });
  state.label.innerHTML = `<b>${sign}${fmtPrice(Math.abs(change))} (${sign}${(Math.abs(change / a.p) * 100).toFixed(2)}%)</b>` +
    `<span>${count} bar${count === 1 ? "" : "s"} · ${time}</span>`;
  // The label sits past the end of the move (above an up move, below a down one), kept on screen.
  const labelW = state.label.offsetWidth;
  const labelH = state.label.offsetHeight;
  const cx = (x1 + x2) / 2;
  const left = Math.max(4, Math.min(cx - labelW / 2, ctx.plotWidth - labelW - 4));
  const top = up ? Math.min(y1, y2) - labelH - 8 : Math.max(y1, y2) + 8;
  state.label.style.left = `${left}px`;
  state.label.style.top = `${Math.max(ctx.box.top + 2, Math.min(top, ctx.box.top + ctx.box.height - labelH - 2))}px`;
}

export function bindMeasure() {
  // Any click or key elsewhere puts the box away; a Shift-press on a chart then starts a new one.
  // The click that sets the second point is the chart's own, so it isn't "elsewhere".
  document.addEventListener("pointerdown", (event) => {
    for (const [pane, state] of panes) if (!(state.awaiting && pane.root.contains(event.target))) clear(state);
  }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") panes.forEach(clear); });
  onChartLoad(({ pane }) => { clear(ensure(pane)); });
  onChartRender((pane) => draw(pane));
}
