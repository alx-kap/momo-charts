import { $, api, store, ticker, toast, typing } from "./util.js";
import { actions, state } from "./state.js";
import {
  activateChart, activePane, applyLevels, chartMessage, chartPane, onChartActivate, onChartLoad, onFundamentalsLoad, resetView, rightPane,
  setCrosshairSync, showChart, copySnapshot, snapshot,
} from "./chart.js";
import { CHART_BARS, isIntraday, prefetchSymbols } from "./feed.js";
import {
  addToWatchlist, isFlagged, toggleFlag, bindWatchlists, markActiveSymbol, renderDetails, renderWatchlists, setDetailsFundamentals, stepWatchlist, watchlistNeighbors, syncWatchlists, openWatchlistPicker, openAddToWatchlist,
} from "./watchlists.js";
import { bindPalette, closePalette, openPalette, paletteOpen } from "./palette.js";
import {
  bindChartSettings, changeSettings, chartSettingsOpen, closeChartSettings, openChartSettings, syncChartSettings,
} from "./chartsettings.js";
import { bindScreener, closeScreener, refreshScreener, screenerNeighbors, stepScreener } from "./screener.js";
import { bindThemes, closeThemes, openThemes, themesOpen } from "./themes.js";
import { bindColorPicker } from "./colorpicker.js";
import { bindHelp, closeHelp, helpOpen, openHelp } from "./help.js";
import { bindMenus } from "./menus.js";
import { bindSidebar } from "./sidebar.js";
import { startLive } from "./live.js";
import {
  bindDrawings, cancelDrawing, deleteSelected, drawingTool, hasSelection, redo, removeAllDrawings, setTool, undo,
} from "./drawings.js";
import { armMeasure, bindMeasure } from "./measure.js";
import { bindDrawbar } from "./drawbar.js";
import { bindTooltips } from "./tooltip.js";
import { applyRails, bindRails, showScreener } from "./rails.js";
import { bindReplay, exitReplay, replayDay, replayKey, replayOptions, startReplay } from "./replay.js";
import { bindAlerts, loadAlerts, newAlert } from "./alerts.js";
import {
  bindSymbolSearch, closeSymbolSearch, intervalBoxOpen, openIntervalBox, openSymbolSearch, rememberSymbol,
  symbolSearchOpen,
} from "./symsearch.js";

// ---------- modes ----------
// Chart (home): your own charts and watchlists. Daily review (the momo scan as a review hub)
// and Practice (past setups, blind) come from private.js, which the public edition leaves out:
// `extra` is its hooks, null without it.

let extra = null;
const practicing = () => state.mode === "practice";

async function setMode(mode) {
  if (mode !== "chart" && !extra) return;
  if (mode !== "chart") exitReplay({ redraw: false });
  if (extra?.enter(mode)) return;
  state.mode = mode;
  store.set("mode", mode);
  renderModes(mode);
  if (mode === "chart") return showHome();
  await extra.show();
}

// The highlight behind the picked mode slides to the new one instead of jumping.
function slideModeHighlight() {
  const nav = $("modes");
  const glider = nav.querySelector(".mode-glider") || nav.appendChild(Object.assign(document.createElement("span"), { className: "mode-glider" }));
  const active = nav.querySelector("button.active");
  glider.hidden = !active || !active.offsetWidth;
  if (glider.hidden) return;
  glider.style.transform = `translateX(${active.offsetLeft}px)`;
  glider.style.width = `${active.offsetWidth}px`;
  glider.classList.toggle("practice", active.dataset.mode === "practice");
  if (!glider.classList.contains("placed")) requestAnimationFrame(() => glider.classList.add("placed")); // no slide in from the left on load
}
new ResizeObserver(slideModeHighlight).observe($("modes"));

function renderModes(mode) {
  if (mode !== "chart") {
    for (const side of ["left", "right"]) chartPane(side)?.clearEarnings();
    setDetailsFundamentals(null);
  }
  document.body.classList.toggle("mode-chart", mode === "chart");
  document.body.classList.toggle("mode-review", mode === "review");
  // Split view is Chart mode's: elsewhere the left chart is the one, and the right one rests.
  if (mode !== "chart" && layout.split) {
    activateChart("left");
    if (chartPane("right")) chartPane("right").clear();
  }
  renderSplit();
  if (mode !== "chart") { closeScreener(); closeThemes(); }
  applyRails();
  document.querySelectorAll("#modes button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  slideModeHighlight();
  renderSymbolBar();
}

function renderSymbolBar() {
  const symbol = currentSymbol();
  $("symbol-label").textContent = symbol ? ticker(symbol) : practicing() ? "Hidden" : "—";
  $("symbol-button").classList.toggle("flagged", !practicing() && isFlagged(symbol));
  const interval = shownInterval();
  document.querySelectorAll("#intervals button[data-interval]").forEach((button) =>
    button.classList.toggle("active", button.dataset.interval === interval));
  document.body.classList.toggle("intraday", isIntraday(interval));
  $("ext-toggle").checked = state.extended;
  // The ▾ names the timeframe only when it isn't one of the quick buttons beside it.
  const quick = document.querySelector(`.iv-quick [data-interval="${interval}"]`);
  $("iv-label").textContent = quick ? "" : interval.replace(/^1([DWM])$/, "$1");
}

// Intraday charts are Chart mode's; Daily review shows the daily chart for them.
const shownInterval = () => (state.mode !== "chart" && isIntraday(state.interval) ? "1D" : state.interval);

const chartOptions = () => ({
  interval: shownInterval(),
  count: state.mode === "chart" ? CHART_BARS[shownInterval().slice(-1)] : undefined,
});

async function showHome({ follow = true } = {}) {
  chartMessage(null);
  applyLevels(null);
  markActiveSymbol();
  const options = chartOptions();
  const replay = replayDay();
  const details = renderDetails(state.home.symbol, { through: replay }); // shares the chart's request
  // The other chart follows when linked, and fills in when it shows nothing yet.
  const other = splitOn() && ((follow && linked()) || !shownSymbol(otherSide())) ? otherChart() : null;
  if (other && linked()) other.record.symbol = state.home.symbol;
  await Promise.all([
    showChart(state.home.symbol, null, { through: null, ...options, ...replayOptions(options.interval) }),
    other ? showOther(other) : null,
  ]);
  saveCharts();
  await details;
  if (replay) return;
  // Step order: next, the one after, then back one; for the other chart's timeframe too.
  const offsets = [1, 2, -1];
  const near = screenerNeighbors(state.home.symbol, offsets);
  const next = near.length ? near : watchlistNeighbors(offsets);
  prefetchSymbols(next, options.interval, options.count);
  if (other && linked()) prefetchSymbols(next, other.record.interval, CHART_BARS[other.record.interval.slice(-1)]);
}

// Open a symbol from search, a watchlist or the palette, in whichever mode is showing.
async function openSymbol(symbol) {
  if (practicing()) return;
  if (state.mode !== "chart") return extra.openSymbol(symbol);
  state.home.symbol = symbol;
  saveCharts();
  renderSymbolBar();
  await showHome();
}

// The chart reports the qualified symbol (e.g. "MRNA" → "NASDAQ:MRNA").
onChartLoad(({ pane, symbol, anonymous }) => {
  if (anonymous || state.mode !== "chart") return;
  const record = charts[pane.side];
  if (!record || symbol === record.symbol || ticker(symbol) !== ticker(record.symbol || "")) return;
  record.symbol = symbol;
  if (pane === activePane()) {
    state.home.symbol = symbol;
    rememberSymbol(symbol);
    markActiveSymbol();
  }
  saveCharts();
});

function updateFundamentals({ pane, anonymous }) {
  if (state.mode === "chart" && !anonymous && pane === activePane()) {
    setDetailsFundamentals(pane.fundamentals());
  }
}
onChartLoad(updateFundamentals);
onFundamentalsLoad(updateFundamentals);

function changeInterval(interval) {
  if (practicing()) return toast("Practice charts are daily");
  state.interval = interval;
  saveCharts();
  renderSymbolBar();
  redraw({ follow: false });
}

// ---------- split view ----------
// Two charts side by side in Chart mode, each with its own symbol, timeframe and indicators.
// The app's current symbol and timeframe (state.home.symbol, state.interval) are the active
// chart's; `charts` keeps each chart's. The layout menu (the button's menu) picks one chart or
// two, and what the two share: the symbol, the crosshair.

const stored = store.get("layout", {});
const layout = { split: false, ratio: 0.5, active: "left", ...stored, sync: { symbol: true, crosshair: true, ...stored.sync } };
const charts = {
  left: { symbol: state.home.symbol, interval: state.interval },
  right: { symbol: state.home.symbol, interval: "5m", ...layout.right },
};
delete charts.right.linked; // from the per-chart link buttons this menu replaced
const splitOn = () => layout.split && state.mode === "chart";
const otherSide = () => (activePane().side === "left" ? "right" : "left");
const otherChart = () => ({ side: otherSide(), record: charts[otherSide()] });
const linked = () => layout.sync.symbol;
const shownSymbol = (side) => { const pane = side === "right" ? chartPane("right") : chartPane("left"); return pane && pane.shown().symbol; };

// Write the active chart's symbol and timeframe back to its record, and keep everything.
function saveCharts() {
  const record = charts[activePane().side];
  record.symbol = state.home.symbol;
  record.interval = state.interval;
  store.set("homeSymbol", charts.left.symbol);
  store.set("interval", charts.left.interval);
  delete layout.left;
  layout.right = { symbol: charts.right.symbol, interval: charts.right.interval };
  layout.active = activePane().side;
  store.set("layout", layout);
}

function showOther({ side, record }) {
  const pane = side === "right" ? rightPane() : chartPane("left");
  const interval = record.interval;
  return pane.show(record.symbol || state.home.symbol, null, {
    through: null, interval, count: CHART_BARS[interval.slice(-1)], ...replayOptions(interval),
  });
}

function renderSplit() {
  const on = splitOn();
  document.body.classList.toggle("split", on);
  $("chart-right").hidden = !on;
  $("split-resizer").hidden = !on;
  $("charts").style.setProperty("--right-width", `${((1 - layout.ratio) * 100).toFixed(2)}%`);
  setCrosshairSync(on && layout.sync.crosshair);
  renderLayoutMenu();
}

// ---------- the layout menu ----------

const SINGLE_ICON = '<svg width="18" height="18" viewBox="0 0 18 18"><rect x="2" y="3" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const SPLIT_ICON = '<svg width="18" height="18" viewBox="0 0 18 18"><rect x="2" y="3" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 3v12" stroke="currentColor" stroke-width="1.5"/></svg>';

function renderLayoutMenu() {
  const menu = $("layout-menu");
  $("split-button").innerHTML = layout.split ? SPLIT_ICON : SINGLE_ICON;
  menu.classList.toggle("single", !layout.split);
  for (const tile of menu.querySelectorAll("[data-layout]")) {
    const on = (tile.dataset.layout === "split") === layout.split;
    tile.classList.toggle("active", on);
    tile.classList.toggle("next", !on); // the one ⌥2 switches to
  }
  for (const box of menu.querySelectorAll("[data-sync]")) box.checked = layout.sync[box.dataset.sync];
}

function closeLayoutMenu() {
  $("layout-menu").hidden = true;
}

$("split-button").addEventListener("click", (event) => {
  event.currentTarget.blur();
  if (state.mode !== "chart") return toast("Split view is in Chart mode");
  renderLayoutMenu();
  $("layout-menu").hidden = !$("layout-menu").hidden;
});
$("layout-menu").addEventListener("click", (event) => {
  const tile = event.target.closest("[data-layout]");
  if (!tile) return;
  if ((tile.dataset.layout === "split") !== layout.split) toggleSplit();
});
$("layout-menu").addEventListener("change", (event) => {
  const box = event.target.closest("[data-sync]");
  if (!box) return;
  layout.sync[box.dataset.sync] = box.checked;
  saveCharts();
  renderSplit();
  // Turning symbol sync on brings the other chart to this one's symbol.
  if (box.dataset.sync === "symbol" && box.checked && splitOn()) showHome();
});
document.addEventListener("pointerdown", (event) => {
  if (!$("layout-menu").hidden && !event.target.closest(".layout-wrap")) closeLayoutMenu();
});

async function toggleSplit() {
  if (state.mode !== "chart") return toast("Split view is in Chart mode");
  layout.split = !layout.split;
  if (!layout.split) {
    activateChart("left");
    if (chartPane("right")) chartPane("right").clear();
  }
  saveCharts();
  renderSplit();
  if (layout.split) {
    // Symbols changed in single view: a linked right chart catches up as it reopens.
    if (linked() || !charts.right.symbol) charts.right.symbol = state.home.symbol;
    await showOther({ side: "right", record: charts.right });
  }
}

// Clicking a chart makes it the active one: the symbol bar, watchlist, details and keys follow.
onChartActivate((pane) => {
  const before = charts[pane.side === "left" ? "right" : "left"];
  before.symbol = state.home.symbol;
  before.interval = state.interval;
  state.home.symbol = charts[pane.side].symbol || state.home.symbol;
  state.interval = charts[pane.side].interval;
  saveCharts();
  renderSymbolBar();
  markActiveSymbol();
  renderDetails(state.home.symbol, { through: replayDay() }).then(() => {
    if (pane === activePane()) setDetailsFundamentals(pane.fundamentals());
  });
});

// Drag the line between the charts; double-click to split evenly.
$("split-resizer").addEventListener("pointerdown", (event) => {
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  handle.classList.add("drag");
  document.body.classList.add("resizing");
  const box = $("charts").getBoundingClientRect();
  const move = (e) => {
    layout.ratio = Math.min(0.8, Math.max(0.2, (e.clientX - box.left) / box.width));
    renderSplit();
  };
  const done = () => {
    handle.removeEventListener("pointermove", move);
    handle.classList.remove("drag");
    document.body.classList.remove("resizing");
    saveCharts();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", done, { once: true });
  handle.addEventListener("pointercancel", done, { once: true });
});
$("split-resizer").addEventListener("dblclick", () => { layout.ratio = 0.5; renderSplit(); saveCharts(); });


// ETH: pre- and post-market on intraday charts.
function toggleExtended() {
  state.extended = !state.extended;
  store.set("extended", state.extended);
  renderSymbolBar();
  redraw();
}

// Bar Replay starting or ending: both charts load again, linked or not.
function redrawCharts() {
  const other = splitOn() && !linked() && shownSymbol(otherSide()) ? showOther(otherChart()) : null;
  return Promise.all([showHome(), other]);
}

// The replay day moved: the details panel follows once it stops.
let replayDetails = null;
function replayMoved(day) {
  clearTimeout(replayDetails);
  replayDetails = setTimeout(() => {
    if (replayDay() !== day) return;
    renderDetails(state.home.symbol, { through: day }).then(() => setDetailsFundamentals(activePane().fundamentals()));
  }, 300);
}

function redraw({ follow = true } = {}) {
  if (state.mode === "chart") return showHome({ follow });
  return extra?.redraw();
}

function step(delta) {
  if (state.mode === "chart") return stepScreener(delta, state.home.symbol) || stepWatchlist(delta);
  extra?.step(delta);
}

function currentSymbol() {
  if (practicing()) return null;
  return state.mode === "chart" ? state.home.symbol : extra?.symbol();
}

function addCurrentToWatchlist() {
  const symbol = currentSymbol();
  if (symbol) addToWatchlist(symbol);
}

function flagCurrent() {
  const symbol = currentSymbol();
  if (symbol) toggleFlag(symbol);
}

function flagsChanged() {
  renderSymbolBar();
  extra?.flagsChanged();
  refreshScreener();
}

Object.assign(actions, {
  openThemes: (tab) => state.mode === "chart" && !practicing() && openThemes(tab),
  openScreener: () => !practicing() && showScreener(), openSymbol, setInterval: changeInterval, setMode, addCurrentToWatchlist,
  flagCurrent, flagsChanged, removeAllDrawings, setTool, copyChart, saveChart: () => snapshot(drawingsOf()),
  startReplay, newAlert,
});

// The chart as a picture on the clipboard; where the browser won't allow that, a PNG download.
const drawingsOf = () => activePane().root.querySelector('[data-part="drawings"]');
async function copyChart() {
  if (await copySnapshot(drawingsOf())) return toast("Chart copied to clipboard");
  await snapshot(drawingsOf());
  toast("Couldn't copy here, so it was saved as a PNG", 2400);
}
$("snapshot-button").addEventListener("click", copyChart);

// ---------- keyboard: TradingView's keys ----------
// Letters open symbol search, digits the timeframe box. ⌥ (Alt) letters are TradingView's
// tool keys, matched on the physical key since ⌥ changes the character on a Mac.

const ALT_KEYS = {
  KeyT: () => setTool("trend"),
  KeyH: () => setTool("hline"),
  KeyJ: () => setTool("hray"),
  KeyR: () => resetView(),
  KeyL: () => changeSettings((s) => { s.scale.log = !s.scale.log; }),
  KeyI: () => changeSettings((s) => { s.scale.invert = !s.scale.invert; }),
  KeyW: () => addCurrentToWatchlist(),
  KeyS: (event) => (event.shiftKey ? snapshot(drawingsOf()) : copyChart()),
  Digit2: () => toggleSplit(),
  KeyE: (event) => { if (event.shiftKey && document.body.classList.contains("intraday")) toggleExtended(); },
  KeyA: () => { if (state.mode === "chart" && !practicing()) newAlert(); },
};

function overlayKey(event) {
  if (helpOpen()) {
    if (event.key === "Escape" || event.key === "?") closeHelp();
    return true;
  }
  if (chartSettingsOpen() && event.key === "Escape") { closeChartSettings(); return true; }
  if (extra?.overlayKey(event)) return true;
  if (themesOpen()) {
    if (event.key === "Escape") closeThemes();
    return true;
  }
  return false;
}

document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    return paletteOpen() ? closePalette() : openPalette();
  }
  if (typing(event.target)) {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  if (symbolSearchOpen() || intervalBoxOpen() || paletteOpen()) return;
  if (overlayKey(event)) { event.preventDefault(); return; }

  if (mod && !event.altKey && event.code === "KeyZ") {
    event.preventDefault();
    return event.shiftKey ? redo() : undo();
  }
  if (mod && !event.altKey && event.code === "KeyY") { event.preventDefault(); return redo(); }
  if (mod && event.altKey && event.code === "KeyW" && !practicing()) {
    event.preventDefault();
    const symbol = currentSymbol();
    if (symbol) openAddToWatchlist(symbol);
    return;
  }
  // Ctrl+A sets an alert too (⌥A is TradingView's); ⌘A stays the browser's select-all.
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === "KeyA" && state.mode === "chart" && !practicing()) {
    event.preventDefault();
    return newAlert();
  }
  if (mod) return;
  if (event.altKey) {
    const run = ALT_KEYS[event.code];
    if (!run || (practicing() && event.code === "KeyW")) return;
    event.preventDefault();
    return run(event);
  }

  const key = event.key;
  if (key === "Escape") {
    const menuOpen = !$("settings").hidden || !$("layout-menu").hidden;
    $("settings").hidden = true;
    closeLayoutMenu();
    armMeasure(false);
    if (cancelDrawing()) return event.preventDefault();
    if (replayDay() && state.mode === "chart" && !menuOpen) { exitReplay(); return event.preventDefault(); }
  }
  if ((key === "Delete" || key === "Backspace") && hasSelection()) {
    event.preventDefault();
    return deleteSelected();
  }
  if (key === "/") { event.preventDefault(); return openChartSettings("indicators"); }
  if (key === "?") { event.preventDefault(); return openHelp(); }

  if (practicing()) {
    if (extra.key(event)) event.preventDefault();
    return;
  }
  if (drawingTool()) return;
  if (replayKey(event)) return event.preventDefault();
  if (extra?.key(event)) return event.preventDefault();

  let handled = true;
  if (event.shiftKey && event.code === "KeyF") flagCurrent();
  else if (event.shiftKey && event.code === "KeyW") openWatchlistPicker();
  else if (key === " ") step(event.shiftKey ? -1 : 1);
  else if (key === "ArrowDown") step(1);
  else if (key === "ArrowUp") step(-1);
  else if (/^[a-zA-Z]$/.test(key)) openSymbolSearch(key.toUpperCase());
  else if (/^[0-9]$/.test(key) && !event.shiftKey) openIntervalBox(key);
  else handled = false;
  if (handled) event.preventDefault();
});

// ---------- top bar and settings ----------

$("modes").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  button.blur();
  if (button.dataset.mode === "practice" && practicing()) return;
  setMode(button.dataset.mode);
});
$("intervals").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-interval]");
  if (button) { button.blur(); changeInterval(button.dataset.interval); }
});
$("ext-toggle").addEventListener("change", (event) => { event.currentTarget.blur(); toggleExtended(); });
$("iv-button").addEventListener("click", (event) => {
  event.stopPropagation();
  $("iv-button").blur();
  $("iv-menu").hidden = !$("iv-menu").hidden;
});
// Picking a timeframe closes the menu; clicking its other controls (extended hours) doesn't.
document.addEventListener("click", (event) => {
  if (!event.target.closest("#iv-menu") || event.target.closest("button[data-interval]")) $("iv-menu").hidden = true;
});
$("symbol-button").addEventListener("click", () => { if (!practicing()) openSymbolSearch(""); });
$("search-button").addEventListener("click", () => openPalette()); // phones only: Ctrl K does it on a keyboard
$("settings-button").addEventListener("click", (event) => {
  event.stopPropagation();
  $("settings").hidden = !$("settings").hidden;
});
$("settings").addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => { $("settings").hidden = true; });
$("settings-chart").addEventListener("click", () => { $("settings").hidden = true; openChartSettings("symbol"); });
document.addEventListener("momo:open-settings", (event) => openChartSettings(event.detail));
$("indicators-button").addEventListener("click", () => openChartSettings("indicators"));
$("settings-help").addEventListener("click", () => { $("settings").hidden = true; openHelp(); });
$("prev-button").addEventListener("click", () => step(-1));
$("next-button").addEventListener("click", () => step(1));
bindWatchlists();
bindPalette();
bindThemes();
bindScreener();
bindRails();
bindReplay({ redraw: redrawCharts, onDay: replayMoved });
bindAlerts({ openSymbol: (symbol) => { if (state.mode !== "chart") setMode("chart").then(() => openSymbol(symbol)); else openSymbol(symbol); } });
bindChartSettings();
bindDrawbar();
bindTooltips();
bindDrawings();
bindMeasure();
bindColorPicker();
bindHelp();
bindMenus();
bindSidebar();
bindSymbolSearch();
syncChartSettings();
syncWatchlists();

// The profile button at the top left: the account's initial in a circle, like
// Claude's desktop app. It opens settings and help.
function renderProfile(me) {
  const name = me.name || me.id;
  const initial = (name.trim()[0] || "?").toUpperCase();
  $("settings-button").textContent = initial;
  $("settings-button").title = `${name} · Settings and help`;
  const menu = $("settings");
  menu.querySelector('[data-part="avatar"]').textContent = initial;
  menu.querySelector('[data-part="name"]').textContent = name;
  menu.querySelector('[data-part="role"]').textContent = me.owner ? "Owner" : "Member";
}

(async function init() {
  const mode = store.get("mode", "chart");
  state.mode = mode === "practice" ? "chart" : mode;
  renderModes(state.mode);
  try {
    state.me = await api("/api/me");
    if (state.me.private) {
      extra = (await import("./private.js")).bindPrivate({
        chartOptions, currentSymbol, redraw, renderModes, renderSymbolBar, saveCharts, setMode, showHome, step,
      });
      Object.assign(ALT_KEYS, extra.altKeys);
    } else if (state.mode !== "chart") {
      state.mode = "chart";
      renderModes("chart");
    }
    renderProfile(state.me);
    startLive(state.me);
    if (state.me.setup) openChartSettings("live"); // first run: Schwab's keys and sign-in
    loadAlerts({ greet: true });
    renderWatchlists(); // its live columns depend on the account
    await (extra ? extra.start() : showHome());
  } catch (error) {
    chartMessage(`Failed to load: ${error.message}`);
  }
})();
