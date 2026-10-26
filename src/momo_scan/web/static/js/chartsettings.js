import { $, api, escapeHtml, store, toast } from "./util.js";
import { INDICATORS, TIMEFRAMES, newIndicator } from "./indicators.js";
import { swatch } from "./colorpicker.js";
import { liveSetup, marketSetup, onLiveStatus, openSignIn, saveSchwabKeys } from "./live.js";
import { state } from "./state.js";
import { alertPrefs, setAlertPref } from "./alertprefs.js";
import { alertSounds, playAlertSound } from "./sound.js";

// Chart styling and indicators, TradingView-style. The defaults match the user's TradingView
// layout. Settings are cached in localStorage so the chart never flashes the wrong colours, and
// saved to the server so they follow the user between devices. Each chart in split view has its
// own profile: the left one is the original "chart" setting, the right one "chart_right"
// (started as a copy of the left). The dialog and the indicator commands edit the active chart's.

const MAS = [
  [5, "#49b3c4"], [10, "#df76e4"], [20, "#f5ea6b"], [50, "#d54456"], [100, "#df8540"], [200, "#180385"],
];

export function defaultSettings() {
  return {
    version: 2,
    candles: {
      style: "candles", // or "hollow", "bars"
      up: "#00b705", down: "#d60200",
      borders: false, borderUp: "#00b705", borderDown: "#d60200",
      wickUp: "#00b705", wickDown: "#d60200",
    },
    volume: { visible: true, dollar: true, up: "#0eb60a", down: "#b70603", average: true, ema: false, period: 20, averageColor: "#ffffff" },
    canvas: {
      background: "solid", color: "#000000", color2: "#0b1220",
      text: "#b2b5be", fontSize: 12,
      gridV: false, gridH: false, gridColor: "#1e222d",
      crosshair: "#9598a1", crosshairStyle: 3, magnet: false,
      watermark: true, watermarkColor: "#ffffff", watermarkOpacity: 7,
      separator: "#2a2e39",
    },
    levels: { trigger: "#ffffff", early: "#44d17a", overhead: "#ffbf4b" },
    // Pre- and post-market price on live charts: a tag on the price scale, a line, a legend chip.
    extended: {
      pre: "#f57c00", post: "#2962ff", tag: true, line: false, lineStyle: 2, lineWidth: 1, chip: true,
      ghost: true, ghostColor: "rgba(255, 255, 255, 0.8)",
    },
    scale: { log: false, invert: false, handles: true, rightOffset: 18 },
    // The indicator legend in the top left, as TradingView's status line.
    status: { titles: true, values: true, collapsed: false },
    // Per-pane price margins as fractions of the pane: top and bottom.
    margins: { price: { top: 0.27, bottom: 0.04 }, volume: { top: 0.15, bottom: 0 } },
    indicators: [...MAS.map(([period, color]) => newIndicator("sma", {
      params: { period }, style: { line: { color, width: 1 } },
    })), newIndicator("earnings")],
  };
}

// Fill in anything missing (new settings added later) from the defaults.
function merge(defaults, saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaults;
  const out = { ...defaults };
  for (const [key, value] of Object.entries(saved)) {
    if (key === "indicators") continue;
    const base = defaults[key];
    out[key] = base && typeof base === "object" && !Array.isArray(base) ? merge(base, value) : value;
  }
  if (Array.isArray(saved.indicators)) {
    out.indicators = saved.indicators.filter((item) => item && INDICATORS[item.type]).map((item) => {
      const fresh = newIndicator(item.type);
      return {
        ...fresh, ...item,
        params: { ...fresh.params, ...item.params },
        style: Object.fromEntries(Object.entries(fresh.style).map(([k, v]) => {
          const style = { ...v, ...(item.style || {})[k] };
          const plot = INDICATORS[item.type].plots.find((p) => p.key === k);
          if (plot && plot.was && plot.was.includes(style.color)) style.color = v.color;
          return [k, style];
        })),
      };
    });
    if ((saved.version || 1) < 2 && !out.indicators.some((item) => item.type === "earnings")) {
      out.indicators.push(newIndicator("earnings"));
    }
  }
  out.version = 2;
  return out;
}

class Profile {
  constructor(key, seed = null) {
    this.key = key;
    this.S = merge(defaultSettings(), store.get(key, null) || seed);
    this.listeners = [];
    this.saveTimer = 0;
    if (!store.get(key, null) && seed) this.persist(); // a new copy is saved straight away
  }

  on(fn) { this.listeners.push(fn); }

  persist() {
    this.S.savedAt = new Date().toISOString();
    store.set(this.key, this.S);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      api(`/api/settings/${this.key}`, { method: "PUT", body: JSON.stringify(this.S) })
        .catch((error) => toast(`Couldn't save chart settings: ${error.message}`));
    }, 500);
  }

  // `what` tells the chart how much to redo: "style" restyles, "series" rebuilds indicators.
  // Pass `render: false` while a colour picker or slider is live: re-rendering would close it.
  change(mutate, what = "style", { render = true } = {}) {
    mutate(this.S);
    this.persist();
    for (const fn of this.listeners) fn(what);
    if (render && this === current && !$("cs").hidden) renderDialog();
  }

  replace(next) {
    for (const key of Object.keys(this.S)) delete this.S[key];
    Object.assign(this.S, next);
  }

  // The server copy wins unless this browser saved something newer.
  async sync() {
    try {
      const { value } = await api(`/api/settings/${this.key}`);
      if (!value) {
        if (store.get(this.key, null)) this.persist();
        return;
      }
      if ((value.savedAt || "") <= (this.S.savedAt || "")) return;
      this.replace(merge(defaultSettings(), value));
      store.set(this.key, this.S);
      for (const fn of this.listeners) fn("series");
    } catch {}
  }
}

const profiles = new Map();
// A chart's settings by key ("chart" left, "chart_right" right). A new right profile starts as
// a copy of the left one.
export function chartProfile(key) {
  if (!profiles.has(key)) {
    const seed = key === "chart" ? null : structuredClone(chartProfile("chart").S);
    profiles.set(key, new Profile(key, seed));
  }
  return profiles.get(key);
}

let current = chartProfile("chart");
// The active chart's settings: what the dialog and the indicator commands edit.
export let chartSettings = current.S;

export function useChartProfile(profile) {
  if (profile === current) return;
  current = profile;
  chartSettings = profile.S;
  if (!$("cs").hidden) renderDialog();
}

export function changeSettings(mutate, what = "style", options = {}) {
  current.change(mutate, what, options);
}

export async function syncChartSettings() {
  await Promise.all([...profiles.values()].map((profile) => profile.sync()));
}

// ---------- the dialog ----------

const icon = (...paths) => `<svg viewBox="0 0 24 24">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
// [key, nav label, section title, icon]
const TABS = [
  ["symbol", "Symbol", "Candles and volume", icon("M7 4v16M17 6v13", "M4.5 8h5v8h-5zM14.5 9h5v6h-5z")],
  ["status", "Status line", "Status line", icon("M4 7h16M4 12h10M4 17h13")],
  ["canvas", "Canvas", "Canvas", icon("M4 5h16v14H4z", "M4 10h16M10 5v14")],
  ["scales", "Scales", "Scales", icon("M6 4v16M6 4l-2 3M6 4l2 3M6 20l-2-3M6 20l2-3", "M12 8h8M12 12h6M12 16h8")],
  ["indicators", "Indicators", "Indicators", icon("M3 17l5-6 4 3 4-7 5 5")],
];
// Settings that aren't about the chart; a section shows only when it has something to set up.
const GENERAL_TABS = [
  ["review", "Daily review", "Daily review", icon("M5 4h14v16H5z", "M8.5 12l2.5 2.5 4.5-5"), () => Boolean(state.me.private)],
  ["live", "Market data", "Market data", icon("M3 12h4l3-8 4 16 3-8h4"), () => Boolean(liveSetup() || marketSetup()?.fill === "schwab")],
  ["alerts", "Alerts", "Price alerts", icon("M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z", "M10 20.5a2.2 2.2 0 0 0 4 0"), () => Boolean(state.me.live)],
];
let tab = "symbol";
let query = "";
let focusId = null;

const get = (path) => path.split(".").reduce((obj, key) => obj[key], chartSettings);
function set(path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((obj, key) => obj[key], chartSettings)[last] = value;
}

const color = (path, title = "") =>
  swatch(escapeHtml(get(path)), `data-path="${path}" title="${escapeHtml(title)}"`);
const check = (path) => `<input type="checkbox" data-path="${path}" ${get(path) ? "checked" : ""}>`;
const number = (path, { min = 0, max = 100, step = 1 } = {}) =>
  `<input type="number" data-path="${path}" value="${get(path)}" min="${min}" max="${max}" step="${step}">`;
const select = (path, options) => `<select data-path="${path}">${options.map(([value, label]) =>
  `<option value="${value}" ${String(get(path)) === String(value) ? "selected" : ""}>${label}</option>`).join("")}</select>`;
// A pill of radio buttons, for a short choice. Wider lists stay a select.
const seg = (path, options) => `<span class="seg">${options.map(([value, label]) =>
  `<label><input type="radio" name="${path}" data-path="${path}" value="${value}" ${String(get(path)) === String(value) ? "checked" : ""}><span>${label}</span></label>`).join("")}</span>`;
// `label` may carry a <small> description under it.
const row = (label, ...controls) => `<div class="cs-row"><span class="cs-lab">${label}</span><span class="cs-ctl">${controls.join("")}</span></div>`;
const heading = (text) => `<div class="cs-h">${text}</div>`;

const LINE_STYLES = [[0, "Solid"], [1, "Dotted"], [2, "Dashed"], [3, "Long dashes"]];

function symbolTab() {
  const hollow = chartSettings.candles.style === "hollow";
  const bars = chartSettings.candles.style === "bars";
  return heading("Candles") +
    row("Style", seg("candles.style", [["candles", "Solid"], ["hollow", "Hollow"], ["bars", "Bars"]])) +
    row(bars ? "Bars" : hollow ? "Body (down)" : "Body", ...(hollow ? [] : [color("candles.up", "Up")]), color("candles.down", "Down")) +
    (bars ? "" : row("Borders", check("candles.borders"), color("candles.borderUp", "Up"), color("candles.borderDown", "Down")) +
      row("Wicks", color("candles.wickUp", "Up"), color("candles.wickDown", "Down"))) +
    heading("Volume") +
    row("Show volume<small>The volume pane under the price.</small>", check("volume.visible")) +
    row("Values<small>What the volume bars measure.</small>", seg("volume.dollar", [[true, "Dollars"], [false, "Shares"]])) +
    row("Bars", color("volume.up", "Up"), color("volume.down", "Down")) +
    row("Average<small>A moving average line over the volume bars.</small>", check("volume.average"), seg("volume.ema", [[false, "SMA"], [true, "EMA"]]),
      number("volume.period", { min: 1, max: 200 }), color("volume.averageColor")) +
    heading("Pre- &amp; post-market") +
    row("Colors<small>Before the open, and after the close.</small>", color("extended.pre", "Pre-market"), color("extended.post", "Post-market")) +
    row("Price scale tag<small>The price on the right-hand scale.</small>", check("extended.tag")) +
    row("Line<small>A horizontal line at the price, across the chart.</small>", check("extended.line"),
      select("extended.lineStyle", LINE_STYLES), select("extended.lineWidth", [1, 2, 3, 4].map((n) => [n, `${n}px`]))) +
    row("Legend chip<small>The price and its move after the OHLC values, top left.</small>", check("extended.chip")) +
    row("Ghost candle<small>Daily charts: the session so far as a hollow candle after the last bar, from the close to the latest price.</small>",
      check("extended.ghost"), color("extended.ghostColor"));
}

function liveTab() {
  const info = marketSetup();
  const setup = liveSetup();
  let html = info && info.fill === "schwab" && !info.keys ? keysForm()
    : setup ? `<div class="cs-live-line">${escapeHtml(setup.line)}</div>` +
      (setup.button ? `<button id="cs-live-sign-in">${setup.button}</button>` : "")
    : `<div class="cs-live-line">No live feed is set up.</div>`;
  if (info && info.bars) html += barsProgress(info.bars);
  return html;
}

// First run, where momo fills its own bars: the keys of the owner's Schwab developer app.
const keysDraft = { client_id: "", client_secret: "", callback_url: "https://127.0.0.1:8182" };
function keysForm() {
  const field = (key, label, type = "text") =>
    row(label, `<input type="${type}" class="cs-key" data-key="${key}" value="${escapeHtml(keysDraft[key])}" autocomplete="off" spellcheck="false">`);
  return `<div class="cs-live-line">momo gets its prices from your Schwab account. At
    <a href="https://developer.schwab.com" target="_blank" rel="noopener">developer.schwab.com</a>, create an app
    with Market Data Production (add Accounts and Trading Production for streaming quotes) and the callback URL
    below. Schwab approves new apps in a few days; then paste its keys here and sign in.</div>` +
    field("client_id", "App key") + field("client_secret", "Secret", "password") + field("callback_url", "Callback URL") +
    `<button id="cs-schwab-save">Save and connect</button>`;
}

async function saveKeys() {
  try {
    await saveSchwabKeys(keysDraft);
    keysDraft.client_secret = "";
    toast("Keys saved. Sign in to Schwab next.", 2400);
  } catch (error) {
    toast(`Couldn't save the keys: ${error.message}`, 4000);
  }
}

function barsProgress(bars) {
  const n = (value) => value.toLocaleString();
  const text = !bars.stocks ? "Fetching the list of stocks…"
    : bars.filled < bars.stocks ? `${n(bars.filled)} of ${n(bars.stocks)} stocks filled (${Math.floor((bars.filled / bars.stocks) * 100)}%), biggest first. A chart you open fills at once.`
    : `All ${n(bars.stocks)} stocks, through ${bars.through}. Each weekday's bar is added after the close.`;
  return heading("Daily bars") + `<div class="cs-live-line">${text}` +
    (bars.error ? `<br><span class="cs-live-err">${escapeHtml(bars.error)}</span>` : "") + "</div>";
}

// Price alerts are the account's, not a chart's: they live in alertprefs.js, not the profile.
function alertsTab() {
  const pick = (key, options) => `<select data-alert="${key}">${options.map(([value, label]) =>
    `<option value="${value}" ${String(alertPrefs[key]) === String(value) ? "selected" : ""}>${label}</option>`).join("")}</select>`;
  return heading("Line") +
    row("Alert lines<small>Where an alert sits on the chart. Drag one to move it, double-click to edit.</small>",
      swatch(escapeHtml(alertPrefs.color), 'data-alert="color" title="Colour"'), pick("style", LINE_STYLES),
      pick("width", [1, 2, 3, 4].map((n) => [n, `${n}px`]))) +
    heading("Sound") +
    row("When an alert fires<small>Plays in every open momo tab. Practice's mute doesn't silence it.</small>",
      pick("sound", alertSounds()), `<button type="button" class="cs-play" data-alert-play title="Play it">Play</button>`) +
    row("Volume",
      `<input type="range" data-alert="volume" min="0" max="100" step="5" value="${alertPrefs.volume}" title="Volume" aria-label="Alert volume">`,
      `<output class="cs-vol">${alertPrefs.volume}%</output>`);
}

function statusTab() {
  return heading("Legend") +
    row("Titles<small>Each indicator's name and settings.</small>", check("status.titles")) +
    row("Values<small>The indicator readings at the crosshair.</small>", check("status.values")) +
    row("Collapsed<small>Fold the legend to a single line.</small>", check("status.collapsed"));
}


function canvasTab() {
  const gradient = chartSettings.canvas.background === "gradient";
  return heading("Chart") +
    row("Background", seg("canvas.background", [["solid", "Solid"], ["gradient", "Gradient"]]),
      color("canvas.color", gradient ? "Top" : ""), ...(gradient ? [color("canvas.color2", "Bottom")] : [])) +
    row("Text", color("canvas.text"), select("canvas.fontSize", [10, 11, 12, 13, 14, 16].map((n) => [n, `${n}px`]))) +
    row("Grid lines", `<label>${check("canvas.gridV")} Vert</label>`, `<label>${check("canvas.gridH")} Horz</label>`, color("canvas.gridColor")) +
    row("Crosshair", color("canvas.crosshair"), select("canvas.crosshairStyle", LINE_STYLES),
      `<label>${check("canvas.magnet")} Magnet</label>`) +
    row("Symbol watermark<small>The ticker faintly behind the candles.</small>", check("canvas.watermark"), color("canvas.watermarkColor"),
      `<input type="range" data-path="canvas.watermarkOpacity" min="1" max="60" value="${chartSettings.canvas.watermarkOpacity}" title="Opacity">`) +
    row("Pane separators", color("canvas.separator"));
}

function reviewTab() {
  return heading("Scanner lines") +
    row("Trigger", color("levels.trigger")) +
    row("Early-entry reference", color("levels.early")) +
    row("Overhead resistance", color("levels.overhead"));
}

const pct = (path) => `<input type="number" data-pct="${path}" value="${Math.round(get(path) * 100)}" min="0" max="90" step="1"><em>%</em>`;

function scalesTab() {
  const panes = [["price", "Price"], ...(chartSettings.volume.visible ? [["volume", "Volume"]] : [])];
  return heading("Price scale") +
    row("Logarithmic<em>⌥L</em>", check("scale.log")) +
    row("Invert<em>⌥I</em>", check("scale.invert")) +
    row("Space right of the last bar", number("scale.rightOffset", { min: 0, max: 200 }), "<em>bars</em>") +
    heading("Margins") +
    row("Margin handles<small>Triangles on the price axis to drag the margins.</small>", check("scale.handles")) +
    panes.map(([key, label]) => row(label, "Top", pct(`margins.${key}.top`), "Bottom", pct(`margins.${key}.bottom`))).join("") +
    `<p class="cs-note">Double-click the price axis if it stops following the margins (that happens after you drag the axis itself).</p>`;
}

// Which timeframes the indicator shows on: click a chip to turn it off (or on) there.
function timeframeChips(item) {
  const off = new Set(item.hiddenOn || []);
  const chip = (tf) => `<button data-tf="${tf}" data-ind="${item.id}" class="${off.has(tf) ? "" : "on"}" ` +
    `title="${off.has(tf) ? "Off" : "On"} on ${tf} charts · click to turn ${off.has(tf) ? "on" : "off"}">${tf}</button>`;
  const intraday = TIMEFRAMES.filter((tf) => !/^[DWM]$/.test(tf));
  return `<div class="cs-tf"><span>Show on</span>${intraday.map(chip).join("")}<i></i>${["D", "W", "M"].map(chip).join("")}</div>`;
}

function indicatorsTab() {
  const active = chartSettings.indicators.filter((item) =>
    !INDICATORS[item.type].chartOnly || state.mode === "chart").map((item) => {
    const def = INDICATORS[item.type];
    const inputs = def.inputs.map((input) =>
      `<label class="cs-in">${input.label}<input type="number" data-ind="${item.id}" data-param="${input.key}" ` +
      `value="${item.params[input.key]}" min="${input.min}" max="${input.max}" step="${input.step || 1}"></label>`).join("");
    const plots = def.plots.map((plot) =>
      swatch(escapeHtml(item.style[plot.key].color), `data-ind="${item.id}" data-plot="${plot.key}" title="${plot.label}"`) +
      (plot.color2 ? swatch(escapeHtml(item.style[plot.key].color2), `data-ind="${item.id}" data-plot="${plot.key}" data-second="1" title="${plot.label} (falling)"`) : "")).join("");
    const width = def.plots.some((plot) => plot.type !== "histogram")
      ? `<select data-ind="${item.id}" data-width="1" title="Line width">${[1, 2, 3, 4].map((n) =>
        `<option value="${n}" ${item.style[def.plots.find((p) => p.type !== "histogram").key].width === n ? "selected" : ""}>${n}px</option>`).join("")}</select>`
      : "";
    return `<div class="cs-ind ${item.visible ? "" : "off"} ${item.id === focusId ? "focus" : ""}" data-id="${item.id}">` +
      `<button class="cs-eye" data-toggle="${item.id}" title="${item.visible ? "Hide" : "Show"}">${item.visible ? "◉" : "○"}</button>` +
      `<span class="cs-name" title="${escapeHtml(def.name)}">${escapeHtml(def.label(item.params))}</span>` +
      `<span class="cs-ctl">${inputs}${plots}${width}</span>` +
      `<button class="cs-x" data-remove="${item.id}" title="Remove">×</button>` +
      timeframeChips(item) + `</div>`;
  }).join("") || `<div class="cs-note">No indicators. Add one below.</div>`;
  const add = Object.entries(INDICATORS).filter(([, def]) =>
    !def.chartOnly || state.mode === "chart").map(([type, def]) =>
    `<button data-add="${type}"><b>${escapeHtml(def.name)}</b><em>${def.pane === "price" ? "on price" : "own pane"}</em></button>`).join("");
  return heading("On the chart") + `<div class="cs-list">${active}</div>` + heading("Add an indicator") + `<div class="cs-add">${add}</div>`;
}

// Search every settings section at once (not the indicator list), keeping the rows that match.
function renderSearch(sections) {
  const body = $("cs-body");
  body.innerHTML = `<h2 class="cs-title">Search</h2>` +
    ["symbol", "status", "canvas", "scales", "review"].map((key) => sections[key]()).join("") + `<div class="cs-empty" hidden>Nothing matches “${escapeHtml(query)}”.</div>`;
  let shown = 0;
  let head = null;
  for (const el of [...body.children].slice(1)) {
    if (el.classList.contains("cs-h")) { head = el; el.hidden = true; continue; }
    if (!el.classList.contains("cs-row")) { if (!el.classList.contains("cs-empty")) el.hidden = true; continue; }
    const hit = el.textContent.toLowerCase().includes(query) || (head && head.textContent.toLowerCase().includes(query));
    el.hidden = !hit;
    if (hit) { shown++; if (head) head.hidden = false; }
  }
  body.querySelector(".cs-empty").hidden = shown > 0;
}

function renderDialog() {
  const focused = document.activeElement;
  const keep = focused && $("cs-body").contains(focused) && focused.matches("input[type=number]")
    ? { ind: focused.dataset.ind, param: focused.dataset.param, path: focused.dataset.path, pct: focused.dataset.pct }
    : null;
  $("cs-tabs").innerHTML = TABS.map(([key, label, , glyph]) =>
    `<button data-tab="${key}" class="${key === tab && !query ? "active" : ""}">${glyph}${label}</button>`).join("");
  const general = GENERAL_TABS.filter(([, , , , shown]) => shown());
  $("cs-navh-general").hidden = !general.length;
  $("cs-tabs-general").innerHTML = general.map(([key, label, , glyph]) =>
    `<button data-tab="${key}" class="${key === tab && !query ? "active" : ""}">${glyph}${label}</button>`).join("");
  const sections = {
    symbol: symbolTab, status: statusTab, canvas: canvasTab, scales: scalesTab, review: reviewTab, indicators: indicatorsTab, live: liveTab, alerts: alertsTab,
  };
  const isChart = TABS.some(([key]) => key === tab);
  $("cs-reset").parentElement.hidden = !isChart && !query;
  if (query) renderSearch(sections);
  else $("cs-body").innerHTML = `<h2 class="cs-title">${[...TABS, ...GENERAL_TABS].find(([key]) => key === tab)[2]}</h2>` + sections[tab]();
  if (keep) {
    const selector = keep.ind ? `[data-ind="${keep.ind}"][data-param="${keep.param}"]`
      : keep.pct ? `[data-pct="${keep.pct}"]` : `[data-path="${keep.path}"]`;
    const again = $("cs-body").querySelector(selector);
    if (again) { again.focus(); }
  }
  const focusRow = focusId && $("cs-body").querySelector(".cs-ind.focus");
  if (focusRow) { focusRow.scrollIntoView({ block: "nearest" }); focusId = null; }
}

onLiveStatus(() => { if (!$("cs").hidden) renderDialog(); });

export const chartSettingsOpen = () => !$("cs").hidden;

export function openChartSettings(which = tab, indicatorId = null) {
  tab = which;
  focusId = indicatorId;
  query = "";
  $("cs-search").value = "";
  $("cs").hidden = false;
  placeWindow();
  renderDialog();
}

// The window floats where it was last left (or top right to begin with), kept on screen.
function placeWindow() {
  const card = $("cs").querySelector(".cs-card");
  const saved = store.get("csPos", null);
  const { width, height } = card.getBoundingClientRect();
  const x = saved ? saved.x : window.innerWidth - width - 24;
  const y = saved ? saved.y : 56;
  card.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width))}px`;
  card.style.top = `${Math.max(0, Math.min(y, window.innerHeight - 60))}px`;
}

function bindDrag() {
  const card = $("cs").querySelector(".cs-card");
  card.addEventListener("pointerdown", (event) => {
    const t = event.target;
    if (event.button !== 0 || !(t.matches(".cs-grab, .cs-side, .cs-navh, .cs-title, .cs-main") && card.getClientRects().length)) return;
    if (window.matchMedia("(max-width: 820px)").matches) return;
    event.preventDefault();
    const dx = event.clientX - card.offsetLeft, dy = event.clientY - card.offsetTop;
    card.classList.add("dragging");
    card.setPointerCapture(event.pointerId);
    const move = (e) => {
      card.style.left = `${Math.max(0, Math.min(e.clientX - dx, window.innerWidth - card.offsetWidth))}px`;
      card.style.top = `${Math.max(0, Math.min(e.clientY - dy, window.innerHeight - 60))}px`;
    };
    const up = () => {
      card.classList.remove("dragging");
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
      store.set("csPos", { x: card.offsetLeft, y: card.offsetTop });
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
  });
}

export function closeChartSettings() {
  $("cs").hidden = true;
  resetPrompt(false);
}

function resetPrompt(show) {
  $("cs-confirm").hidden = !show;
  $("cs-reset").hidden = show;
}

const findIndicator = (id) => chartSettings.indicators.find((item) => item.id === id);

function onInput(event) {
  const el = event.target;
  const live = event.type === "input";
  if (el.dataset.alert) {
    const key = el.dataset.alert;
    const numeric = key === "style" || key === "width" || key === "volume";
    setAlertPref(key, numeric ? Number(el.value) : el.value);
    if (key === "volume") el.parentElement.querySelector(".cs-vol").textContent = `${el.value}%`;
    // Hear a new sound, or the volume once you let go of the slider.
    if (!live && (key === "sound" || key === "volume")) playAlertSound(alertPrefs.sound, alertPrefs.volume);
    return;
  }
  const isSwatch = el.classList.contains("swatch");
  const quiet = { render: !isSwatch && el.type !== "range" && !(live && el.type === "number") };
  // Colour pickers and sliders update live; numbers wait for a valid value.
  if (el.dataset.ind) {
    const item = findIndicator(el.dataset.ind);
    if (!item) return;
    if (el.dataset.param) {
      const value = Number(el.value);
      if (!Number.isFinite(value) || value <= 0 || (live && el.value === "")) return;
      changeSettings(() => { item.params[el.dataset.param] = value; }, "series");
    } else if (el.dataset.plot) {
      changeSettings(() => { item.style[el.dataset.plot][el.dataset.second ? "color2" : "color"] = el.value; }, "series", quiet);
    } else if (el.dataset.width) {
      changeSettings(() => { for (const plot of Object.values(item.style)) plot.width = Number(el.value); }, "series");
    }
    return;
  }
  if (el.dataset.pct) {
    const value = Number(el.value);
    if (!Number.isFinite(value) || el.value === "") return;
    changeSettings(() => set(el.dataset.pct, Math.max(0, Math.min(90, value)) / 100), "style", { render: false });
    return;
  }
  const path = el.dataset.path;
  if (!path) return;
  let value = el.type === "checkbox" ? el.checked : el.value;
  if (el.type === "radio" && !el.checked) return;
  if (el.type === "number" || el.type === "range" || path === "canvas.fontSize" || path === "canvas.crosshairStyle") {
    value = Number(value);
    if (!Number.isFinite(value) || el.value === "") return;
  }
  if (path === "volume.dollar" || path === "volume.ema") value = value === "true";
  const rebuild = path.startsWith("volume.") || path === "candles.style";
  const redraw = el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio";
  changeSettings(() => set(path, value), rebuild ? "series" : "style", { render: quiet.render && redraw });
}

export function bindChartSettings() {
  const box = $("cs");
  bindDrag();
  box.addEventListener("input", (event) => {
    const el = event.target;
    if (el.dataset.key) { keysDraft[el.dataset.key] = el.value; return; }
    // Numbers apply as you type, so a value isn't lost if the page reloads before the field blurs.
    if (el.classList.contains("swatch") || el.type === "range" || (el.type === "number" && (el.dataset.path || el.dataset.pct))) onInput(event);
  });
  box.addEventListener("change", onInput);
  $("cs-search").addEventListener("input", (event) => { query = event.target.value.trim().toLowerCase(); renderDialog(); });
  box.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.tab) {
      tab = button.dataset.tab;
      query = "";
      $("cs-search").value = "";
      renderDialog();
    }
    else if (button.dataset.alertPlay !== undefined) playAlertSound(alertPrefs.sound, alertPrefs.volume);
    else if (button.id === "cs-schwab-save") saveKeys();
    else if (button.id === "cs-live-sign-in") {
      closeChartSettings();
      openSignIn();
    }
    else if (button.dataset.tf) {
      const item = findIndicator(button.dataset.ind);
      const tf = button.dataset.tf;
      changeSettings(() => {
        const off = new Set(item.hiddenOn || []);
        if (off.has(tf)) off.delete(tf);
        else off.add(tf);
        item.hiddenOn = TIMEFRAMES.filter((each) => off.has(each));
      }, "series");
    }
    else if (button.dataset.add) {
      const item = newIndicator(button.dataset.add);
      focusId = item.id;
      changeSettings((s) => s.indicators.push(item), "series");
    } else if (button.dataset.remove) {
      changeSettings((s) => { s.indicators = s.indicators.filter((item) => item.id !== button.dataset.remove); }, "series");
    } else if (button.dataset.toggle) {
      const item = findIndicator(button.dataset.toggle);
      changeSettings(() => { item.visible = !item.visible; }, "series");
    } else if (button.id === "cs-reset") {
      $("cs-confirm").hidden = false;
      button.hidden = true;
    } else if (button.id === "cs-reset-no") {
      resetPrompt(false);
    } else if (button.id === "cs-reset-yes") {
      resetPrompt(false);
      current.replace({ ...defaultSettings() });
      changeSettings(() => {}, "series");
      toast("Chart reset to default");
    } else if (button.id === "cs-done") closeChartSettings();
  });
}

// Legend buttons: hide, edit and remove an indicator without opening the dialog first.
export function toggleIndicator(id) {
  const item = findIndicator(id);
  if (item) changeSettings(() => { item.visible = !item.visible; }, "series");
}

export function addIndicator(type) {
  const item = newIndicator(type);
  changeSettings((s) => s.indicators.push(item), "series");
  toast(`Added ${INDICATORS[type].name}`);
}

export function removeIndicator(id) {
  changeSettings((s) => { s.indicators = s.indicators.filter((item) => item.id !== id); }, "series");
}
