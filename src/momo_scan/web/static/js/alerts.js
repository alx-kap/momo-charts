import { $, api, escapeHtml, fmtPrice, ticker, toast } from "./util.js";
import { openMenu, wantsMenu } from "./contextmenu.js";
import { FLOAT_GRIP, floatingCard } from "./dialog.js";
import { pickOption } from "./picker.js";
import { state } from "./state.js";
import { activePane, chartPane, onChartLoad, onChartRender, onCrosshair } from "./chart.js";
import { onLiveAlerts } from "./live.js";
import { drawingTool, refreshDrawingBar, selectedLevel, setDrawingAlerts } from "./drawings.js";
import { playAlertSound } from "./sound.js";
import { alertPrefs, onAlertPrefs, syncAlertPrefs } from "./alertprefs.js";

// Price alerts (TradingView's ⌥A): tell me when a stock crosses a level. The server checks them
// against live quotes (momo_scan/alerts.py), so they fire with momo closed; open tabs ring and
// show a card, a background tab sends a browser notification, and alerts that fired while you
// were away wait in the Alerts panel (right rail) with a dot on its bell.
//
// On the chart an alert is a line with a bell tag at its right end: drag the line (or the tag)
// to move the alert, double-click it to edit, right-click it for its menu. The editor is a
// floating window; while it's open, its alert's line follows the price in it. A fired alert's
// line goes; the alert waits in the panel's Fired list.

const DIRECTIONS = { cross: "Crossing", up: "Crossing up", down: "Crossing down" };
const TRIGGERS = { once: "Once", every: "Every time, at most every 10 minutes" };
const PAUSED_COLOR = "#787b86";
const HIT_PX = 5; // how near the pointer must be to grab a line
let alerts = [];
let hover = null; // the crosshair's price on the active chart, for ⌥A
let onOpenSymbol = () => {};
const allowed = () => Boolean(state.me.live);

const condition = (alert) => `${DIRECTIONS[alert.direction]} ${fmtPrice(alert.price)}`;
const linked = (drawingId) => alerts.find((alert) => alert.drawing_id === drawingId && alert.status !== "triggered");
const when = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const rounded = (price) => Number(price.toFixed(price < 1 ? 4 : 2));
const sameSymbol = (a, b) => Boolean(a && b) && ticker(a) === ticker(b);

// `greet`: say how many fired while momo was closed (the first load only).
export async function loadAlerts({ greet = false } = {}) {
  document.querySelector('[data-rail="alerts"]').hidden = !allowed();
  if (!allowed()) return render();
  syncAlertPrefs();
  try {
    alerts = (await api("/api/alerts")).alerts;
  } catch {
    return;
  }
  changed();
  const away = alerts.filter((alert) => !alert.seen);
  if (greet && away.length) toast(`${away.length} alert${away.length > 1 ? "s" : ""} fired while you were away · see Alerts`, 3200);
}

function changed() {
  render();
  drawLines();
  refreshDrawingBar();
}

// ---------- on the charts ----------

let draft = null; // the alert open in the editor: { alert, symbol, price, drawing, onLine }
let drag = null; // a line being dragged: { pane, key, price, moved }
let hot = null; // the key of the line under the pointer
const shown = new Map(); // pane -> the lines it shows, for finding one under the pointer

// The lines a chart of `symbol` shows. The alert open in the editor shows at the editor's price.
function linesFor(symbol) {
  const lines = [];
  for (const alert of alerts) {
    if (alert.status === "triggered" || !sameSymbol(alert.symbol, symbol)) continue;
    if (draft && draft.alert && draft.alert.id === alert.id && !draft.onLine) continue;
    const price = drag && drag.key === alert.id ? drag.price : alert.price;
    lines.push({ key: alert.id, alert, price, paused: alert.status === "paused", onLine: Boolean(alert.drawing_id) });
  }
  if (draft && !draft.onLine && sameSymbol(draft.symbol, symbol) && draft.price > 0) {
    lines.push({ key: "draft", price: draft.price, draft: true });
  }
  return lines;
}

function drawLines() {
  for (const pane of panes()) {
    const symbol = pane.shown().symbol;
    const lines = !symbol || pane.shown().anonymous ? [] : linesFor(symbol);
    shown.set(pane, lines);
    pane.setAlertLines(lines.map((line) => ({
      price: line.price,
      color: line.paused ? PAUSED_COLOR : alertPrefs.color,
      width: alertPrefs.width + (line.draft || line.key === hot || (drag && drag.key === line.key) ? 1 : 0),
      style: alertPrefs.style,
      onLine: line.onLine,
    })));
    placeTags(pane);
  }
}

const panes = () => ["left", "right"].map(chartPane).filter((pane) => pane && pane.setAlertLines);

// A bell tag at the right end of each line, clear of the price scale: something to grab.
function placeTags(pane) {
  let layer = pane.root.querySelector(".alert-tags");
  if (!layer) {
    layer = Object.assign(document.createElement("div"), { className: "alert-tags" });
    pane.root.append(layer);
  }
  const ctx = pane.context();
  layer.innerHTML = (shown.get(pane) || []).filter((line) => !line.onLine).map((line) => {
    const y = ctx.candles.priceToCoordinate(line.price);
    if (y == null || y < ctx.box.top || y > ctx.box.top + ctx.box.height) return "";
    const color = line.paused ? PAUSED_COLOR : alertPrefs.color;
    const title = line.draft ? "The new alert's price: drag to move"
      : `${condition(line.alert)} · drag to move, double-click to edit, right-click for more`;
    return `<i class="alert-tag${line.draft ? " draft" : ""}${line.key === hot ? " hot" : ""}" data-key="${line.key}" ` +
      `style="top:${Math.round(y)}px;left:${Math.round(ctx.plotWidth - 30)}px;--alert:${color}" title="${escapeHtml(title)}"></i>`;
  }).join("");
}

// The line under the pointer on `pane`'s price pane, or null.
function lineAt(pane, event) {
  const tag = event.target.closest?.(".alert-tag");
  const lines = shown.get(pane) || [];
  if (tag) return lines.find((line) => String(line.key) === tag.dataset.key) || null;
  const rect = pane.root.getBoundingClientRect();
  const ctx = pane.context();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  if (x < 0 || x >= ctx.plotWidth || y < ctx.box.top || y > ctx.box.top + ctx.box.height) return null;
  let best = null, gap = HIT_PX + 1;
  for (const line of lines) {
    if (line.onLine) continue; // a drawn line moves its own alert
    const at = ctx.candles.priceToCoordinate(line.price);
    if (at != null && Math.abs(at - y) < gap) { best = line; gap = Math.abs(at - y); }
  }
  return best;
}

function priceAt(pane, event) {
  const rect = pane.root.getBoundingClientRect();
  const price = pane.context().candles.coordinateToPrice(event.clientY - rect.top);
  return price > 0 ? rounded(price) : null;
}

// The chart sees none of the drag (so it doesn't pan), which would leave its crosshair frozen
// where the drag began, looking like the old line. Move it along with the line.
function followCrosshair(pane, event, price) {
  const { chart, candles, bars } = pane.context();
  const logical = chart.timeScale().coordinateToLogical(event.clientX - pane.root.getBoundingClientRect().left);
  const bar = logical == null || !bars.length ? null : bars[Math.max(0, Math.min(bars.length - 1, Math.round(logical)))];
  if (bar) chart.setCrosshairPosition(price, bar.time, candles);
}

function setHot(pane, key) {
  pane.root.classList.toggle("alert-hover", key != null);
  if (key === hot) return;
  hot = key;
  drawLines();
}

// Drag a line to move its alert there (the new alert's line moves the editor's price).
function bindPane(pane) {
  const root = pane.root;
  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drawingTool() || !allowed()) return;
    const line = lineAt(pane, event);
    if (!line) return;
    event.preventDefault();
    event.stopPropagation(); // the chart doesn't pan
    drag = { pane, key: line.key, price: line.price, from: event.clientY, moved: false };
    root.classList.add("alert-dragging");
    const move = (e) => {
      if (Math.abs(e.clientY - drag.from) > 2) drag.moved = true;
      const price = priceAt(pane, e);
      if (!drag.moved || price == null) return;
      drag.price = price;
      if (line.draft) setDraftPrice(price);
      drawLines();
      followCrosshair(pane, e, price);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      root.classList.remove("alert-dragging");
      const done = drag;
      drag = null;
      if (done.moved && !line.draft) moveAlert(line.alert, done.price);
      else drawLines();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, true);
  root.addEventListener("dblclick", (event) => {
    const line = lineAt(pane, event);
    if (!line || line.draft || drawingTool()) return;
    event.stopPropagation();
    openEditor({ alert: line.alert });
  }, true);
  root.addEventListener("pointermove", (event) => {
    if (drag || event.buttons || drawingTool()) return;
    setHot(pane, lineAt(pane, event)?.key ?? null);
  });
  root.addEventListener("pointerleave", () => { if (!drag) setHot(pane, null); });
  root.addEventListener("contextmenu", (event) => {
    if (!wantsMenu(event)) return;
    const line = lineAt(pane, event);
    if (!line || line.draft) return;
    event.stopPropagation();
    lineMenu(event, line.alert);
  }, true);
}

// The line stays where it was dropped while the change saves; a failed save puts it back.
async function moveAlert(alert, price) {
  if (price === alert.price) return drawLines();
  const before = alert.price;
  alert.price = price;
  drawLines();
  if (await save(alert.id, { price })) toast(`${ticker(alert.symbol)} alert moved to ${fmtPrice(price)}`);
  else { alert.price = before; drawLines(); }
}

// ---------- the editor ----------
// A floating window, like the drawing settings bar: drag it by its title, it stays where you
// leave it, and the chart keeps working while it's open.

let editor = null;
let placeEditor = () => {};

// Create (no `alert`) or edit one. `drawing` ties a new one to a horizontal line or ray.
export function openAlertDialog({ symbol, price, alert = null, drawing = null } = {}) {
  openEditor({ symbol, price, alert, drawing });
}

function openEditor({ symbol, price, alert = null, drawing = null }) {
  if (!allowed()) return toast("Price alerts come with live prices");
  symbol = alert ? alert.symbol : symbol;
  if (!symbol) return toast("Open a chart first");
  const onLine = Boolean(drawing || alert?.drawing_id);
  const current = alert || { direction: "cross", repeat: false, extended: false, note: "" };
  const start = rounded(price ?? alert?.price ?? 0);
  draft = { alert, symbol, price: start, drawing, onLine };
  editor.innerHTML =
    `<div class="ae-head"><span class="ae-grip" title="Drag to move">${FLOAT_GRIP}</span>` +
    `<b>${alert ? "Edit alert" : "New alert"}</b><span class="ae-sym">${escapeHtml(ticker(symbol))}</span>` +
    `<button type="button" class="ae-x" title="Cancel (Esc)" aria-label="Cancel">×</button></div>` +
    `<div class="alert-grid">` +
    `<label>Condition${pickButton("direction", DIRECTIONS, current.direction)}</label>` +
    `<label>Price<input name="price" type="number" step="any" min="0" value="${start || ""}" ${onLine ? "readonly" : ""}></label>` +
    `<label class="alert-wide">Trigger${pickButton("repeat", TRIGGERS, current.repeat ? "every" : "once")}</label>` +
    `<label class="alert-check">Pre- and post-market too<input name="extended" type="checkbox" class="switch" ${current.extended ? "checked" : ""}></label>` +
    `<label class="alert-wide">Note<input name="note" maxlength="200" placeholder="Optional" value="${escapeHtml(current.note || "")}"></label>` +
    `</div><div class="ae-foot"><span class="ae-hint">${onLine ? "Moves with its line on the chart."
      : "Drag the line on the chart to set the price."}</span>` +
    `<button type="button" class="dlg-cancel">Cancel</button><button type="submit" class="dlg-ok">${alert ? "Save" : "Create"}</button></div>`;
  editor.hidden = false;
  placeEditor();
  drawLines();
  const field = onLine ? editor.querySelector('[data-pick="direction"]') : editor.price;
  field.focus({ preventScroll: true });
  if (!onLine) field.select();
}

// The app's own dropdown (picker.js), not the browser's: a button showing the choice.
const pickButton = (name, options, value) =>
  `<button type="button" class="pick ae-pick" data-pick="${name}" data-value="${value}"><span>${escapeHtml(options[value])}</span><i aria-hidden="true">▾</i></button>`;
const picked = (name) => editor.querySelector(`[data-pick="${name}"]`).dataset.value;

async function choose(button) {
  const options = button.dataset.pick === "direction" ? DIRECTIONS : TRIGGERS;
  const items = Object.entries(options).map(([value, label]) => ({ value, label }));
  const value = await pickOption(button, { groups: [{ items }], current: button.dataset.value });
  if (value == null || !button.isConnected) return;
  button.dataset.value = value;
  button.querySelector("span").textContent = options[value];
}

function setDraftPrice(price) {
  if (!draft || draft.onLine) return;
  draft.price = price;
  if (editor.price) editor.price.value = price;
}

function closeEditor() {
  if (editor.hidden) return;
  editor.hidden = true;
  editor.innerHTML = "";
  draft = null;
  drawLines();
}

async function submitEditor() {
  if (!draft) return;
  const fields = {
    direction: picked("direction"), repeat: picked("repeat") === "every",
    extended: editor.extended.checked, note: editor.note.value.trim(),
    ...(draft.onLine ? {} : { price: Number(editor.price.value) }),
  };
  if (!draft.onLine && !(fields.price > 0)) return editor.price.focus();
  const { alert, symbol, drawing } = draft;
  closeEditor();
  if (alert) await save(alert.id, fields);
  else await create({ symbol, ...fields, ...(drawing ? { drawing_id: drawing.id, price: drawing.p1.p } : {}) });
}

// ⌥A: an alert on the selected line, else at the crosshair's price, else at the last price.
export function newAlert() {
  const level = selectedLevel();
  if (level) return drawingAlert(level.item, level.key);
  const pane = activePane();
  const { symbol, anonymous } = pane.shown();
  if (!symbol || anonymous) return toast("Open a chart first");
  const price = hover && hover.symbol === symbol && hover.price > 0 ? hover.price : pane.context().bars.at(-1)?.close;
  openEditor({ symbol, price });
}

function drawingAlert(item, key) {
  const alert = linked(item.id);
  if (alert) return openEditor({ alert });
  const symbol = activePane().shown().symbol;
  openEditor({ symbol: symbol && ticker(symbol) === key ? symbol : key, price: item.p1.p, drawing: item });
}

// A drawn line moved or went away: its alert follows it, or goes with it.
async function drawingsSaved(key, items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const alert of alerts.filter((a) => a.drawing_id && ticker(a.symbol) === key && a.status !== "triggered")) {
    const item = byId.get(alert.drawing_id);
    if (!item) {
      if (draft?.alert?.id === alert.id) closeEditor();
      await remove(alert, { quiet: true });
      toast("Its alert went with the line");
    } else if (Math.abs(item.p1.p - alert.price) > 1e-9) {
      await save(alert.id, { price: Number(item.p1.p.toFixed(4)) });
    }
  }
}

// ---------- saving ----------

async function create(fields) {
  try {
    const alert = await api("/api/alerts", { method: "POST", body: JSON.stringify(fields) });
    alerts = [alert, ...alerts];
    changed();
    toast(`Alert set: ${ticker(alert.symbol)} ${condition(alert).toLowerCase()}`);
    askToNotify();
  } catch (error) {
    toast(`Couldn't set the alert: ${error.message}`, 2400);
  }
}

async function save(id, fields) {
  try {
    const alert = await api(`/api/alerts/${id}`, { method: "PUT", body: JSON.stringify(fields) });
    alerts = alerts.map((each) => (each.id === id ? alert : each));
    changed();
    return true;
  } catch (error) {
    toast(`Couldn't save the alert: ${error.message}`, 2400);
    return false;
  }
}

async function remove(alert, { quiet = false } = {}) {
  try {
    await api(`/api/alerts/${alert.id}`, { method: "DELETE" });
    alerts = alerts.filter((each) => each.id !== alert.id);
    if (draft?.alert?.id === alert.id) closeEditor();
    changed();
    if (!quiet) toast("Alert removed");
  } catch (error) {
    toast(`Couldn't remove the alert: ${error.message}`, 2400);
  }
}

async function clearTriggered() {
  try {
    await api("/api/alerts", { method: "DELETE" });
    alerts = alerts.filter((alert) => alert.status !== "triggered");
    changed();
  } catch (error) {
    toast(`Couldn't clear them: ${error.message}`, 2400);
  }
}

function markSeen(list) {
  const ids = list.filter((alert) => !alert.seen).map((alert) => alert.id);
  if (!ids.length) return;
  for (const alert of alerts) if (ids.includes(alert.id)) alert.seen = true;
  api("/api/alerts/seen", { method: "POST", body: JSON.stringify({ ids }) }).catch(() => {});
  render();
}

// The same commands from a line on the chart and a row in the panel.
function lineMenu(event, alert) {
  const done = alert.status === "triggered", paused = alert.status === "paused";
  openMenu(event, [
    { heading: `${ticker(alert.symbol)} · ${condition(alert).toLowerCase()}` },
    !pane(alert) && { label: "Open chart", run: () => onOpenSymbol(alert.symbol) },
    !done && { label: "Edit…", run: () => openEditor({ alert }) },
    !done && { label: paused ? "Resume" : "Pause", run: () => save(alert.id, { status: paused ? "active" : "paused" }) },
    done && { label: "Set it again", run: () => save(alert.id, { status: "active" }) },
    "-",
    { label: "Remove", danger: true, run: () => remove(alert) },
  ]);
}
const pane = (alert) => panes().some((each) => sameSymbol(each.shown().symbol, alert.symbol) && !each.root.hidden);

// ---------- firing ----------

// The browser asks once, the first time you set an alert.
function askToNotify() {
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
}

function fired(list) {
  for (const event of list) {
    const known = alerts.some((alert) => alert.id === event.id);
    alerts = known ? alerts.map((alert) => (alert.id === event.id ? { ...alert, ...event } : alert)) : [event, ...alerts];
    const away = document.hidden || !document.hasFocus();
    card(event);
    if (away && "Notification" in window && Notification.permission === "granted") {
      const note = new Notification(`${ticker(event.symbol)} ${condition(event).toLowerCase()}`, {
        body: `Last ${fmtPrice(event.fired_price)}${event.note ? ` · ${event.note}` : ""}`, tag: `momo-alert-${event.id}`,
      });
      note.onclick = () => { window.focus(); onOpenSymbol(event.symbol); note.close(); };
    }
  }
  playAlertSound(alertPrefs.sound, alertPrefs.volume); // once, however many fired together
  // Seen if you were looking; a background tab leaves the dot on the bell.
  if (!document.hidden) markSeen(list);
  changed();
}

// A card in the charts' corner per alert, until closed; clicking it opens the chart.
function card(alert) {
  const stack = $("alert-cards");
  const el = document.createElement("div");
  el.className = "alert-card";
  el.style.setProperty("--alert", alertPrefs.color);
  el.innerHTML = `<i class="alert-bell"></i><div><b>${escapeHtml(ticker(alert.symbol))}</b> ${escapeHtml(condition(alert).toLowerCase())}` +
    `<em>Last ${fmtPrice(alert.fired_price)} · ${when(alert.fired_at)}</em>` +
    (alert.note ? `<span>${escapeHtml(alert.note)}</span>` : "") + `</div><button class="alert-x" title="Close" aria-label="Close">×</button>`;
  el.addEventListener("click", (event) => {
    if (!event.target.closest(".alert-x")) onOpenSymbol(alert.symbol);
    el.remove();
  });
  stack.prepend(el);
  while (stack.children.length > 4) stack.lastChild.remove();
}

// ---------- the panel ----------
// Laid out like the watchlist: a row per alert, Active and Fired sections. Click a row for its
// chart, double-click to edit, right-click for the rest.

const ARROWS = { cross: "↕", up: "↑", down: "↓" };
const SHORT = { cross: "Cross", up: "Up", down: "Down" };
const stamp = (iso) => new Date(iso).toDateString() === new Date().toDateString()
  ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function row(alert) {
  const paused = alert.status === "paused", done = alert.status === "triggered";
  const status = done ? stamp(alert.fired_at) : paused ? "Paused" : alert.repeat ? "Every" : "Once";
  const title = [
    `${ticker(alert.symbol)} ${condition(alert).toLowerCase()}`,
    done ? `Fired ${when(alert.fired_at)} at ${fmtPrice(alert.fired_price)}` : alert.repeat ? "Every time, at most every 10 minutes" : "Once",
    alert.extended ? "Pre- and post-market too" : "", alert.drawing_id ? "On a drawn line: moves with it" : "", alert.note,
  ].filter(Boolean).join("\n");
  return `<div class="hw-row al-row${paused ? " paused" : ""}${done ? " done" : ""}" data-id="${alert.id}" title="${escapeHtml(title)}">` +
    `<span class="sym">${alert.seen ? "" : '<i class="al-new"></i>'}${escapeHtml(ticker(alert.symbol))}</span>` +
    `<span class="num"><i class="al-dir">${ARROWS[alert.direction]}</i>${SHORT[alert.direction]}</span>` +
    `<span class="num">${fmtPrice(alert.price)}</span><span class="num al-status">${status}</span>` +
    `<button class="hw-x" data-k="delete" title="Remove">×</button></div>`;
}

function render() {
  const box = $("alerts-list");
  const badge = alerts.some((alert) => !alert.seen);
  document.querySelector('[data-rail="alerts"]')?.classList.toggle("has-new", badge);
  if (!box) return;
  const live = alerts.filter((alert) => alert.status !== "triggered");
  const done = alerts.filter((alert) => alert.status === "triggered");
  $("alerts-count").textContent = live.length ? ` · ${live.length}` : "";
  if (!allowed()) { box.innerHTML = '<div class="hw-empty">Price alerts come with live prices.</div>'; return; }
  box.innerHTML = (!alerts.length ? '<div class="hw-empty">No alerts. <kbd>⌥A</kbd> sets one at the crosshair, or on a selected horizontal line.</div>' : "") +
    (live.length ? `<div class="hw-sec al-sec"><span>Active</span><em>${live.length}</em></div>${live.map(row).join("")}` : "") +
    (done.length ? `<div class="hw-sec al-sec"><span>Fired</span><em>${done.length}</em><button class="hw-x al-clear" data-k="clear" title="Remove every fired alert">Clear</button></div>${done.map(row).join("")}` : "");
}

export function alertsShown() {
  markSeen(alerts.filter((alert) => alert.status === "triggered" || !alert.seen));
}

export function bindAlerts({ openSymbol }) {
  onOpenSymbol = openSymbol;
  document.body.append(Object.assign(document.createElement("div"), { id: "alert-cards" })); // bottom left of the page
  editor = Object.assign(document.createElement("form"), { className: "dlg alert-editor", hidden: true });
  editor.setAttribute("role", "dialog");
  editor.setAttribute("aria-label", "Price alert");
  document.body.append(editor);
  // It starts on the left of the chart, clear of the lines' tags on the right.
  placeEditor = floatingCard(editor, "alertEditorPosition", ".ae-head", () => {
    const box = activePane().root.getBoundingClientRect();
    return { x: box.left + 56, y: box.top + 120 };
  });
  // The whole title bar drags it, except its × (which must still click).
  editor.addEventListener("pointerdown", (event) => { if (event.target.closest(".ae-x")) event.stopPropagation(); }, true);
  editor.addEventListener("submit", (event) => { event.preventDefault(); submitEditor(); });
  editor.addEventListener("click", (event) => {
    if (event.target.closest(".dlg-cancel, .ae-x")) closeEditor();
    const pick = event.target.closest("[data-pick]");
    if (pick) choose(pick);
  });
  editor.addEventListener("input", (event) => {
    if (event.target.name !== "price" || !draft || draft.onLine) return;
    const price = Number(event.target.value);
    if (price > 0) { draft.price = price; drawLines(); }
  });
  editor.addEventListener("keydown", (event) => event.stopPropagation()); // typing here isn't a hotkey
  // Esc cancels the editor before anything else it might mean (leaving a replay, a drawing).
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || editor.hidden || document.querySelector(".ctx-root, .dlg-back, .pick-menu")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeEditor();
  }, true);

  setDrawingAlerts({ has: (id) => Boolean(linked(id)), open: drawingAlert, saved: drawingsSaved });
  onLiveAlerts(fired);
  onAlertPrefs(() => drawLines());
  const bound = new WeakSet();
  onChartLoad(({ pane: each }) => {
    if (!bound.has(each)) { bound.add(each); bindPane(each); }
    drawLines();
  });
  onChartRender((each) => { if (shown.has(each)) placeTags(each); });
  onCrosshair((each, at) => { if (each === activePane()) hover = at && { ...at }; });

  $("alerts-new").addEventListener("click", () => newAlert());
  const alertOf = (event) => {
    const el = event.target.closest(".al-row[data-id]");
    return el && alerts.find((each) => each.id === Number(el.dataset.id));
  };
  $("alerts-list").addEventListener("click", (event) => {
    const k = event.target.closest("[data-k]")?.dataset.k;
    if (k === "clear") return clearTriggered();
    const alert = alertOf(event);
    if (!alert) return;
    if (k === "delete") remove(alert);
    else onOpenSymbol(alert.symbol);
  });
  $("alerts-list").addEventListener("dblclick", (event) => {
    const alert = alertOf(event);
    if (alert && alert.status !== "triggered") openEditor({ alert });
  });
  $("alerts-list").addEventListener("contextmenu", (event) => {
    const alert = alertOf(event);
    if (alert && wantsMenu(event)) lineMenu(event, alert);
  });
  // Another tab or device may have changed them: catch up when this tab comes back.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && allowed()) loadAlerts(); });
}
