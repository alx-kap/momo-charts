import { FUNDAMENTAL_KEYS, FUNDAMENTAL_LABELS, fundamentalText } from "./fundamental-columns.js";
import { $, api, escapeHtml, fmtBig, fmtPct, store, ticker, toast } from "./util.js";
import { actions } from "./state.js";
import { FLAG_SVG, flagCell, toggleFlag } from "./watchlists.js";
import { bindColumns, gripHtml, moved } from "./columns.js";
import { columnItems, openMenu, wantsMenu } from "./contextmenu.js";
import { pickOption } from "./picker.js";
import { confirmDialog, promptDialog } from "./dialog.js";
import {
  buzzLabel, buzzSession, buzzText, buzzTitle, extendedQuote, extendedVolume, flashCell,
  onLiveBuzz, onLiveQuotes, onSessionChange, sessionDone, watchBuzz, watchLive,
} from "./live.js";
import { warmSymbol } from "./feed.js";

// Screener: a floating window that filters every stock on today's readings, TC2000-style, and
// lists the matches like a watchlist: sort, resize, reorder and choose columns. Nothing is
// reviewed or kept except the filter sets you save, and the window's place and columns.
const STARTERS = [
  { name: "Tight above rising averages", rules: [
    { field: "stack", value: true }, { field: "range5", op: "<=", value: 1.5 },
    { field: "adr", op: ">=", value: 4 }, { field: "dvol", op: ">=", value: 20 }] },
  { name: "Breaking out on volume", rules: [
    { field: "new_high", value: true }, { field: "rvol", op: ">=", value: 1.5 },
    { field: "dvol", op: ">=", value: 20 }] },
  { name: "Pullback to the 20-day", rules: [
    { field: "m3", op: ">=", value: 30 }, { field: "d20", op: "<=", value: 2 },
    { field: "d20", op: ">=", value: -3 }, { field: "d50", op: ">=", value: 0 },
    { field: "dvol", op: ">=", value: 20 }] },
  { name: "Liquid movers ($50M, 5% ADR)", rules: [
    { field: "dvol", op: ">=", value: 50 }, { field: "adr", op: ">=", value: 5 }] },
  { name: "1/3/6-month gainers (top 10%)", rules: [
    { field: "m1_rank", op: ">=", value: 90, any: true }, { field: "m3_rank", op: ">=", value: 90, any: true },
    { field: "m6_rank", op: ">=", value: 90, any: true }, { field: "dvol", op: ">=", value: 60 },
    { field: "adr", op: ">=", value: 2.5 }] },
  { name: "Relentless (riding the 10/20/50)", rules: [
    { field: "stack", value: true }, { field: "run50", op: ">=", value: 40 },
    { field: "held20", op: ">=", value: 75 }, { field: "m6", op: ">=", value: 30 },
    { field: "adr", op: ">=", value: 3 }, { field: "dvol", op: ">=", value: 8 },
    { field: "price", op: ">=", value: 5 }] },
  { name: "Growth leaders", rules: [
    { field: "eps_yoy_pct", op: ">=", value: 25 },
    { field: "revenue_yoy_pct", op: ">=", value: 20 },
    { field: "eps_acceleration", value: true },
    { field: "dvol", op: ">=", value: 10 }, { field: "d50", op: ">=", value: 0 }] },
];

const FILTER_SVG = `<svg class="sc-ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z"/></svg>`;

const sign = (v) => (v == null ? "flat" : v > 0.04 ? "up" : v < -0.04 ? "down" : "flat");
const text = (key) => (row) => escapeHtml(row[key] ?? "—");
const move = (digits = 1) => (row, key) => (row[key] == null ? "—" : `<span class="${sign(row[key])}">${fmtPct(row[key], digits)}</span>`);
const millions = (v) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}B` : `$${v.toFixed(v < 10 ? 1 : 0)}M`);
const level = (row, key) => (row[key] == null ? "—" : `${row[key] > 0 ? "+" : ""}${row[key].toFixed(1)}%`);

// Columns after Symbol; all of them are in each row the server sends. `live`: updated as
// prices come in (`price`: flashes green or red with the move, the rest flash bold).
const COLUMNS = {
  price: { label: "Price", width: 62, live: true, price: true, html: (row) => row.price.toFixed(2) },
  chg: { label: "1D", width: 56, live: true, html: move() },
  gap: { label: "Gap", width: 56, live: true, html: move() },
  w1: { label: "1W", width: 58, html: move() },
  m1: { label: "1M", width: 60, html: move() },
  m3: { label: "3M", width: 62, html: move() },
  m6: { label: "6M", width: 62, html: move() },
  adr: { label: "ADR", width: 48, html: (row) => (row.adr == null ? "—" : `${row.adr.toFixed(1)}%`) },
  dvol: { label: "$ Vol", width: 58, html: (row) => millions(row.dvol) },
  dvol1: { label: "$ Vol 1D", width: 64, live: true, html: (row) => (row.dvol1 == null ? "—" : millions(row.dvol1)) },
  vol: { label: "Vol 1D", width: 60, live: true, html: (row) => (row.vol == null ? "—" : fmtBig(row.vol)) },
  rvol: { label: "RVol", width: 50, live: true, title: "Volume vs the 50-day average; during the session, vs the share of an average day traded by now", html: (row) => (row.rvol == null ? "—" : `${row.rvol.toFixed(1)}×`) },
  // Live only, for the rows in view: the whole market can't be sorted on them (`unsorted`).
  ext: { label: "Ext", width: 60, live: true, price: true, unsorted: true, title: "Pre- or post-market price", html: (row) => (row.ext == null ? "—" : row.ext.toFixed(2)) },
  ext_pct: { label: "Ext%", width: 56, live: true, unsorted: true, title: "Pre- or post-market move from the regular session's last price", html: move() },
  ext_vol: { label: "Ext Vol", width: 60, live: true, unsorted: true, title: "Pre- or post-market volume so far", html: (row) => (row.ext_vol == null ? "—" : fmtBig(row.ext_vol)) },
  buzz: { label: "Buzz", width: 62, live: true, unsorted: true, title: buzzTitle, html: (row) => (row.buzz == null ? "—" : `<span class="${row.buzz.pct >= 0 ? "up" : "down"}">${buzzText(row.buzz)}</span>`) },
  from_high: { label: "Off high", width: 66, html: (row) => (row.from_high < 0.05 ? "0%" : `−${row.from_high.toFixed(1)}%`) },
  from_low: { label: "Off low", width: 62, html: level },
  d10: { label: "vs 10d", width: 58, html: level },
  d20: { label: "vs 20d", width: 58, html: level },
  d50: { label: "vs 50d", width: 58, html: level },
  d200: { label: "vs 200d", width: 64, html: level },
  run50: { label: "50d run", width: 62, title: "Sessions in a row closing above the 50-day average", html: (row) => (row.run50 == null ? "—" : `${row.run50}d`) },
  held20: { label: "Held 20d", width: 66, title: "Share of the last 63 closes above the 20-day average", html: (row) => (row.held20 == null ? "—" : `${row.held20}%`) },
  range5: { label: "5d range", width: 66, html: (row) => (row.range5 == null ? "—" : `${row.range5.toFixed(1)} ADR`) },
  name: { label: "Name", width: 170, text: true, html: text("name") },
  sector: { label: "Sector", width: 130, text: true, html: text("sector") },
  industry: { label: "Industry", width: 170, text: true, html: text("industry") },
};
FUNDAMENTAL_KEYS.forEach((key, i) => {
  COLUMNS[key] = { label: FUNDAMENTAL_LABELS[i], width: 70, html: fundamentalText };
});
const FLAG_WIDTH = 24;
const SYMBOL_WIDTH = 66;
const DEFAULT_SHOWN = ["price", "chg", "w1", "m1", "m3", "adr", "dvol", "dvol1", "rvol", "from_high", "industry"];

let fields = [];
let sectors = [];
let rows = [];
let rules = store.get("screenRules", STARTERS[0].rules);
let saved = store.get("screens", []);
let loadedName = null; // the saved scan on screen; Save updates it in place
let loadedStarter = null; // or the starter
let sort = store.get("screenSort", { key: "m1", dir: "desc" });
let etfs = store.get("screenEtfs", false);
let liveScan = Boolean(store.get("screenLive", false)); // owner: filters see today's prices
let sweepTimer = 0;
let pin = store.get("screenPin", null); // { key, dir }: sorts first, `sort` orders within it
let layout = store.get("screenColumns", {}); // { order, hidden, widths }
if (!layout.fundamentals) {
  if (layout.hidden) layout.hidden.push(...FUNDAMENTAL_KEYS);
  layout.fundamentals = true;
}
let place = store.get("screenWindow", null); // { x, y, w, h }
let docked = Boolean(store.get("screenDocked", false)); // in the right panel instead of a window
let closeDocked = () => {};
let activeSymbol = null; // the row last opened from the results: it keeps the highlight
let chartSymbol = null; // outlined when it's another row of the results
let timer = 0;
let token = 0;

const order = () => {
  const saved = (layout.order || []).filter((key) => COLUMNS[key]);
  return [...saved, ...Object.keys(COLUMNS).filter((key) => !saved.includes(key))];
};
const hidden = () => layout.hidden || Object.keys(COLUMNS).filter((key) => !DEFAULT_SHOWN.includes(key));
const shown = () => order().filter((key) => !hidden().includes(key));
const widthOf = (key) => (layout.widths && layout.widths[key]) || COLUMNS[key].width;
const gridOf = () => `${FLAG_WIDTH}px ${SYMBOL_WIDTH}px ${shown().map((key) => `${widthOf(key)}px`).join(" ")}`;
const saveLayout = () => { layout.fundamentals = true; store.set("screenColumns", layout); };

export const screenerOpen = () => !$("screener").hidden;
export const closeScreener = () => {
  $("screener").hidden = true;
  clearTimeout(sweepTimer);
  watchLive("screener", []);
  watchBuzz("screener", []);
};

function clamp() {
  const [w, h] = [Math.min(place.w, innerWidth - 16), Math.min(place.h, innerHeight - 56)];
  place = { w, h, x: Math.max(0, Math.min(place.x, innerWidth - 120)), y: Math.max(44, Math.min(place.y, innerHeight - 60)) };
}

function applyPlace() {
  const box = $("screener");
  if (docked) { ["left", "top", "width", "height"].forEach((prop) => box.style.removeProperty(prop)); return; }
  if (!place) place = { w: 780, h: Math.round(innerHeight * 0.7), x: Math.max(8, innerWidth - 1160 - 20), y: 60 };
  clamp();
  Object.assign(box.style, { left: `${place.x}px`, top: `${place.y}px`, width: `${place.w}px`, height: `${place.h}px` });
}

export async function openScreener() {
  const box = $("screener");
  box.hidden = false;
  applyPlace();
  box.classList.remove("in");
  void box.offsetWidth;
  box.classList.add("in");
  box.classList.toggle("no-filters", Boolean(store.get("screenFiltersHidden", false)));
  syncFiltersButton();
  api("/api/settings/screens").then(({ value }) => {
    if (value && Array.isArray(value.screens) && JSON.stringify(value.screens) !== JSON.stringify(saved)) {
      saved = value.screens;
      store.set("screens", saved);
      renderPresets();
    }
  }).catch(() => {});
  renderPresets();
  renderHeader();
  run();
}

const fieldOf = (key) => fields.find((f) => f.key === key);

// How the filter picker groups the fields, in order; a field the server adds that isn't here
// lands under Other.
const FIELD_GROUPS = [
  ["Price and volume", ["price", "chg", "gap", "adr", "dvol", "dvol1", "vol", "rvol"]],
  ["Performance", ["w1", "m1", "m3", "m6", "m1_rank", "m3_rank", "m6_rank"]],
  ["Trend and averages", ["stack", "d10", "d20", "d50", "d200", "run50", "held20", "range5", "new_high", "from_high", "from_low"]],
  ["Fundamentals", ["earnings_days", "eps_yoy_pct", "revenue_yoy_pct", "eps_annual_yoy_pct", "net_margin_pct", "eps_acceleration"]],
  ["Sector and theme", ["sector", "industry", "theme"]],
];
const fieldGroups = () => {
  const groups = FIELD_GROUPS.map(([label, keys]) => ({ label, items: keys.map(fieldOf).filter(Boolean).map((f) => ({ value: f.key, label: f.label })) }));
  const known = new Set(FIELD_GROUPS.flatMap(([, keys]) => keys));
  const other = fields.filter((f) => !known.has(f.key)).map((f) => ({ value: f.key, label: f.label }));
  return other.length ? [...groups, { label: "Other", items: other }] : groups;
};
const OPS = [{ value: ">=", label: "at least" }, { value: "<=", label: "at most" }];
const YES_NO = [{ value: "true", label: "yes" }, { value: "false", label: "no" }];
const pickButton = (part, value, label, extra = "") =>
  `<button type="button" class="pick ${extra}" data-part="${part}" data-value="${escapeHtml(String(value))}"><span>${escapeHtml(label)}</span><i aria-hidden="true">▾</i></button>`;

function ruleHtml(rule, index) {
  const kind = fieldOf(rule.field)?.kind || "number";
  let value;
  if (kind === "number") {
    value = pickButton("op", rule.op === "<=" ? "<=" : ">=", rule.op === "<=" ? "at most" : "at least") +
      `<input data-part="value" type="number" step="any" value="${rule.value ?? ""}">`;
  } else if (kind === "flag") {
    value = pickButton("value", rule.value ? "true" : "false", rule.value ? "yes" : "no");
  } else {
    const list = rule.field === "sector" ? `list="sc-sectors"` : "";
    value = `<span class="sc-has">contains</span><input data-part="value" type="text" ${list} value="${escapeHtml(rule.value ?? "")}" placeholder="${rule.field === "theme" ? "e.g. AI" : "type a name"}">`;
  }
  const join = `<button class="sc-join${rule.any ? " any" : ""}" data-part="any" title="and: every stock must pass this filter. or: a stock must pass at least one of the &quot;or&quot; filters.">${rule.any ? "or" : "and"}</button>`;
  return `<div class="sc-rule" data-index="${index}">${join}${pickButton("field", rule.field, fieldOf(rule.field)?.label || rule.field)}${value}<button class="icon" data-part="remove" title="Remove filter">×</button></div>`;
}

function renderRules() {
  // The "or" filters sit together in one box at the top, since a stock needs only one of them.
  const some = rules.map((rule, i) => (rule.any ? ruleHtml(rule, i) : "")).join("");
  const group = some && `<div class="sc-any"><div class="sc-any-label">Any one of</div>${some}</div>`;
  $("sc-rules").innerHTML = group + rules.map((rule, i) => (rule.any ? "" : ruleHtml(rule, i))).join("") +
    `<datalist id="sc-sectors">${sectors.map((s) => `<option value="${escapeHtml(s)}">`).join("")}</datalist>`;
  syncFiltersButton();
}

function syncFiltersButton() {
  const off = $("screener").classList.contains("no-filters");
  $("sc-filters-toggle").innerHTML = `${FILTER_SVG}<span class="sc-lbl">Filters ·</span> ${rules.length}`;
  $("sc-filters-toggle").classList.toggle("active", !off);
}

function renderPresets() {
  const current = saved.find((p) => p.name === loadedName)?.name || loadedStarter;
  $("sc-presets-button").querySelector(".sc-lbl").textContent = current || "Presets";
  $("sc-presets-button").title = current ? `Scan: ${current} · load a starter or saved scan` : "Load a starter or saved scan";
  const item = (preset, key, extra = "") =>
    `<div class="sc-preset${(key[0] === "s" ? preset.name === loadedStarter : preset.name === loadedName) ? " on" : ""}"><button data-preset="${key}" title="${preset.rules.length} filters">${escapeHtml(preset.name)}</button>${extra}</div>`;
  $("sc-presets").innerHTML = `<div class="sc-head-label">Starters</div>` + STARTERS.map((p, i) => item(p, `s${i}`)).join("") +
    (saved.length ? `<div class="sc-head-label">Saved</div>` : "") +
    saved.map((p, i) => item(p, `u${i}`, `<button class="sc-del" data-delete="${i}" title="Delete this saved scan">×</button>`)).join("");
}

const PIN_SVG = `<svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path fill="currentColor" d="M10.5 1.5 14.5 5.5 13 6l-2.6 2.6.4 3.4-1.3 1.3L6.6 10.4 2.7 14.3 1.7 13.3 5.6 9.4 2.7 6.5 4 5.2l3.4.4L10 3z"/></svg>`;
const isText = (key) => key === "symbol" || Boolean(COLUMNS[key]?.text);

function renderHeader() {
  const arrow = (key) => {
    if (pin?.key === key) return `<i class="sort-arrow pin">${PIN_SVG}${pin.dir === "asc" ? "▲" : "▼"}</i>`;
    return sort.key === key ? `<i class="sort-arrow">${sort.dir === "asc" ? "▲" : "▼"}</i>` : "";
  };
  const state = (key) => `${sort.key === key ? " sorted" : ""}${pin?.key === key ? " pinned" : ""}`;
  $("sc-cols").innerHTML =
    `<span class="fl" title="Flag: click a row's flag to mark it">${FLAG_SVG}</span>` +
    `<span data-sort="symbol" class="${state("symbol")}" title="Right-click to pin">Symbol${arrow("symbol")}</span>` +
    shown().map((key) => {
      const col = COLUMNS[key];
      const label = key === "buzz" ? buzzLabel({ session: buzzSession() }) : col.label;
      const hint = col.unsorted ? "Live, for the rows in view; can't sort the whole market on it" : "Right-click to pin";
      return `<span data-sort="${key}" data-col="${key}" draggable="true" class="${col.text ? "l" : ""}${state(key)}" title="${col.title ? `${escapeHtml(col.title)} · ` : ""}${hint}">${label}${arrow(key)}${gripHtml(false)}</span>`;
    }).join("");
  $("screener").style.setProperty("--sc-grid", gridOf());
}

function lineHtml(row) {
  const mark = row.symbol === activeSymbol ? " active" : ticker(row.symbol) === chartSymbol ? " found" : "";
  return `<div class="sc-row sc-line${mark}" data-symbol="${escapeHtml(row.symbol)}" title="${escapeHtml(row.name)}">` +
    flagCell(row.symbol) + `<span class="sym">${escapeHtml(ticker(row.symbol))}</span>` +
    shown().map((key) => `<span class="${COLUMNS[key].text ? "l" : ""}"${COLUMNS[key].live ? ` data-live="${key}"` : ""}>${COLUMNS[key].html(row, key)}</span>`).join("") + `</div>`;
}

function renderBody() {
  $("sc-body").innerHTML = rows.length ? rows.map(lineHtml).join("") : `<div class="sc-empty">Nothing matches. Loosen a filter.</div>`;
  watchShown();
}

// ---------- live prices ----------
// Only the rows in view (and a screenful either side) are watched, so a long result list
// doesn't crowd out the chart and watchlists. Filters still run on the last close.
const SPARE_ROWS = 30;
let watchFrame = 0;

function watchShown() {
  if (!screenerOpen()) {
    watchBuzz("screener", []);
    return watchLive("screener", []);
  }
  const body = $("sc-body");
  const lines = [...body.querySelectorAll(".sc-line")];
  const height = lines[0] ? lines[0].offsetHeight || 22 : 22;
  const first = Math.max(0, Math.floor(body.scrollTop / height) - SPARE_ROWS);
  const last = Math.ceil((body.scrollTop + body.clientHeight) / height) + SPARE_ROWS;
  const symbols = lines.slice(first, last).map((line) => line.dataset.symbol);
  watchLive("screener", symbols);
  watchBuzz("screener", shown().some((key) => key === "buzz" || key === "ext_vol") ? symbols : []);
}

// A row from the last close, brought up to today's trading by a live quote.
const buzzes = new Map(); // ticker -> Volume Buzz
function liveRow(row, quote) {
  const base = quote.prev_close;
  const volume = quote.volume ?? row.vol;
  const ext = extendedQuote(quote);
  const buzz = buzzes.get(ticker(row.symbol));
  return {
    ...row, price: quote.last, quote,
    ext: ext ? ext.price : null, ext_pct: ext ? ext.pct : null, ext_vol: extendedVolume(quote, buzz),
    chg: base ? (quote.last / base - 1) * 100 : row.chg,
    gap: base && quote.open ? (quote.open / base - 1) * 100 : row.gap,
    vol: volume, dvol1: volume * quote.last / 1e6,
    rvol: row.avg_vol ? volume / (row.avg_vol * sessionDone(quote.day)) : row.rvol,
  };
}

onLiveBuzz((updates) => {
  for (const [symbol, buzz] of updates) buzzes.set(symbol, buzz);
  if (!screenerOpen() || !rows.length) return;
  const lines = new Map([...$("sc-body").querySelectorAll(".sc-line")].map((line) => [ticker(line.dataset.symbol), line]));
  rows.forEach((row, i) => {
    const buzz = updates.get(ticker(row.symbol));
    if (!buzz) return;
    rows[i] = { ...row, buzz, ext_vol: row.quote ? extendedVolume(row.quote, buzz) : row.ext_vol };
    const line = lines.get(ticker(row.symbol));
    for (const cell of line ? line.querySelectorAll('[data-live="buzz"], [data-live="ext_vol"]') : []) {
      flashCell(cell, COLUMNS[cell.dataset.live].html(rows[i], cell.dataset.live));
    }
  });
});

// The session changed: the Buzz header follows it, and Ext columns fill or empty.
onSessionChange(() => {
  if (!screenerOpen()) return;
  rows = rows.map((row) => (row.quote ? liveRow(row, row.quote) : row));
  renderHeader();
  renderBody();
});

onLiveQuotes((quotes) => {
  if (!screenerOpen() || !rows.length) return;
  const lines = new Map([...$("sc-body").querySelectorAll(".sc-line")].map((line) => [ticker(line.dataset.symbol), line]));
  rows.forEach((row, i) => {
    const quote = quotes.get(ticker(row.symbol));
    if (!quote || quote.day < row.date) return;
    const next = liveRow(row, quote);
    const direction = Math.sign(next.price - row.price);
    rows[i] = next;
    const line = lines.get(ticker(row.symbol));
    if (!line) return;
    for (const cell of line.querySelectorAll("[data-live]")) {
      const key = cell.dataset.live;
      flashCell(cell, COLUMNS[key].html(next, key), COLUMNS[key].price ? direction : 0);
    }
  });
});

async function run() {
  const mine = ++token;
  // The first screen after a restart or a new session waits on the server building its table.
  if (!rows.length) $("sc-body").innerHTML = `<div class="sc-empty">Screening…</div>`;
  clearTimeout(sweepTimer);
  const query = new URLSearchParams({ filters: JSON.stringify(rules), sort: sort.key, dir: sort.dir, etfs });
  if (liveScan) query.set("live", true);
  if (pin) {
    query.set("pin", pin.key);
    query.set("pin_dir", pin.dir);
  }
  try {
    const result = await api(`/api/screen?${query}`);
    if (mine !== token) return;
    const first = !fields.length;
    fields = result.fields;
    sectors = result.sectors;
    if (first) renderRules();
    rows = result.rows;
    $("sc-count").textContent = result.total === rows.length ? `${result.total} match` : `${result.total} match · top ${rows.length}`;
    const funds = result.etfs ? ` + ${result.etfs.toLocaleString()} ETFs` : "";
    $("sc-foot").textContent = `${result.universe.toLocaleString()} stocks${funds} · through ${result.as_of}`;
    const scroll = $("sc-body").scrollTop;
    renderBody();
    $("sc-body").scrollTop = scroll;
    $("sc-live-label").hidden = !result.can_sweep;
    if (!result.can_sweep && liveScan) liveScan = false;
    $("sc-live").checked = liveScan;
    const sweep = result.sweep;
    if (sweep) {
      const when = sweep.stamp ? new Date(sweep.stamp * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "waiting";
      const note = sweep.error ? ` · ${sweep.error}` : "";
      $("sc-foot").textContent += ` · live ${sweep.quotes.toLocaleString()} of ${sweep.symbols.toLocaleString()} quotes at ${when} · ${sweep.requests} requests every ${sweep.seconds} s${note}`;
      sweepTimer = setTimeout(() => screenerOpen() && liveScan && run(), sweep.seconds * 1000);
    }
  } catch (error) {
    if (mine === token) $("sc-body").innerHTML = `<div class="sc-empty">Couldn't screen: ${escapeHtml(error.message)}</div>`;
  }
}

function changed(redraw = false) {
  store.set("screenRules", rules);
  if (redraw) renderRules();
  syncFiltersButton();
  clearTimeout(timer);
  timer = setTimeout(run, 250);
}

function saveScans() {
  store.set("screens", saved);
  api("/api/settings/screens", { method: "PUT", body: JSON.stringify({ screens: saved }) })
    .catch((error) => toast(`Couldn't save scans: ${error.message}`));
}

const blank = (key) => {
  const kind = fieldOf(key)?.kind || "number";
  return kind === "flag" ? { field: key, value: true } : kind === "text" ? { field: key, value: "" } : { field: key, op: ">=", value: 0 };
};

function pick(symbol) {
  activeSymbol = symbol;
  $("sc-body").querySelectorAll(".sc-line.active, .sc-line.found").forEach((line) => line.classList.remove("active", "found"));
  const line = [...$("sc-body").children].find((item) => item.dataset.symbol === symbol);
  if (line) {
    line.classList.add("active");
    line.scrollIntoView({ block: "nearest" });
  }
  actions.openSymbol(symbol);
}

// The chart moved to a symbol (typed, or opened from a watchlist): outline it in the results
// and scroll it into view, leaving the highlighted row where it was.
export function markScreenerSymbol(symbol) {
  chartSymbol = symbol ? ticker(symbol) : null;
  let found = null;
  for (const line of $("sc-body").querySelectorAll(".sc-line")) {
    const hit = !line.classList.contains("active") && ticker(line.dataset.symbol) === chartSymbol;
    line.classList.toggle("found", hit);
    if (hit) found = line;
  }
  if (found && screenerOpen()) found.scrollIntoView({ block: "nearest" });
}

// Walk the matches from the symbol on the chart (Space, ↑↓). False when the chart isn't on one
// of them, so the watchlist keeps its own stepping.
export function stepScreener(delta, current) {
  if (!screenerOpen() || !rows.length) return false;
  const at = rows.findIndex((row) => ticker(row.symbol) === ticker(current || ""));
  if (at < 0) return false;
  const next = at + delta;
  if (next < 0 || next >= rows.length) {
    toast(next < 0 ? "Top of the results" : "End of the results");
    return true;
  }
  pick(rows[next].symbol);
  return true;
}

// Symbols a few steps ahead of (and one behind) the chart, for prefetching.
export function screenerNeighbors(current, offsets) {
  if (!screenerOpen() || !rows.length) return [];
  const at = rows.findIndex((row) => ticker(row.symbol) === ticker(current || ""));
  if (at < 0) return [];
  return offsets.map((offset) => rows[at + offset]).filter(Boolean).map((row) => row.symbol);
}

// Flags changed: redraw the rows so the flag marks follow.
export function refreshScreener() {
  if (screenerOpen()) renderBody();
}

// Right-click a header: pin it so it sorts first; header clicks then sort within each group.
function pinMenu(event, key) {
  const [up, down] = isText(key) ? ["A–Z", "Z–A"] : ["Low–high", "High–low"];
  const pins = ["asc", "desc"].map((dir) => ({
    label: `Pin ${dir === "asc" ? up : down}`, checked: pin?.key === key && pin.dir === dir, run: () => setPin({ key, dir }),
  }));
  if (COLUMNS[key]?.unsorted) pins.length = 0; // live columns can't sort the whole market
  else if (pin) pins.push({ label: `Unpin ${pin.key === "symbol" ? "Symbol" : COLUMNS[pin.key]?.label || ""}`, run: () => setPin(null) });
  const toggle = (each) => {
    const off = new Set(hidden());
    if (off.has(each)) off.delete(each);
    else off.add(each);
    layout.hidden = [...off];
    saveLayout();
    renderHeader();
    renderBody();
  };
  openMenu(event, columnItems({
    label: key === "symbol" ? "Symbol" : COLUMNS[key].label, sorts: pins,
    hide: key !== "symbol" && (() => toggle(key)),
    resetWidth: layout.widths?.[key] && (() => { delete layout.widths[key]; saveLayout(); $("screener").style.setProperty("--sc-grid", gridOf()); }),
    columns: order().map((each) => ({ label: COLUMNS[each].label, checked: !hidden().includes(each), run: () => toggle(each) })),
    reset: () => { layout = {}; saveLayout(); renderHeader(); renderBody(); },
  }));
}

function setPin(next) {
  pin = next;
  store.set("screenPin", pin);
  renderHeader();
  run();
}

function columnMenu() {
  const menu = $("sc-colmenu");
  menu.innerHTML = order().map((key) =>
    `<label><input type="checkbox" data-col="${key}"${hidden().includes(key) ? "" : " checked"}> ${COLUMNS[key].label}</label>`).join("");
  $("sc-presets").hidden = true;
  menu.hidden = !menu.hidden;
}

function bindWindow() {
  const box = $("screener");
  const remember = () => {
    const rect = box.getBoundingClientRect();
    place = { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
    store.set("screenWindow", place);
  };
  // Drag the title bar to move the window.
  $("sc-drag").addEventListener("pointerdown", (event) => {
    if (event.button || docked || event.target.closest("button")) return;
    const head = $("sc-drag");
    const start = { x: event.clientX - box.offsetLeft, y: event.clientY - box.offsetTop };
    head.setPointerCapture(event.pointerId);
    head.classList.add("moving");
    const drag = (e) => {
      box.style.left = `${Math.max(0, Math.min(e.clientX - start.x, innerWidth - 120))}px`;
      box.style.top = `${Math.max(44, Math.min(e.clientY - start.y, innerHeight - 60))}px`;
    };
    const stop = () => {
      head.removeEventListener("pointermove", drag);
      head.removeEventListener("pointerup", stop);
      head.removeEventListener("pointercancel", stop);
      head.classList.remove("moving");
      remember();
    };
    head.addEventListener("pointermove", drag);
    head.addEventListener("pointerup", stop);
    head.addEventListener("pointercancel", stop);
  });
  // The corner handle resizes it; keep the size for next time.
  let settle = 0;
  new ResizeObserver(() => {
    if (box.hidden || docked) return;
    clearTimeout(settle);
    settle = setTimeout(remember, 250);
  }).observe(box);
  addEventListener("resize", () => { if (!box.hidden && place) applyPlace(); });
}

// Docked, the screener takes the watchlist's place in the right panel; floating, it's a window
// you move and resize. Its × then goes back to the watchlist (`onDockedClose`).
export const screenerDocked = () => docked;
export const onDockedClose = (fn) => { closeDocked = fn; };

export function dockScreener(on) {
  docked = on;
  store.set("screenDocked", on);
  const box = $("screener");
  box.classList.toggle("docked", on);
  if (on) $("side-home").before(box);
  else $("charts").after(box);
  applyPlace();
  $("sc-dock").innerHTML = on ? "Float" : "Dock";
}

export function bindScreener() {
  bindWindow();
  dockScreener(docked);
  $("sc-close").addEventListener("click", () => (docked ? closeDocked() : closeScreener()));
  $("sc-filters-toggle").addEventListener("click", () => {
    const off = $("screener").classList.toggle("no-filters");
    store.set("screenFiltersHidden", off);
    syncFiltersButton();
  });
  $("sc-cols-button").addEventListener("click", columnMenu);
  $("sc-presets-button").addEventListener("click", () => {
    $("sc-colmenu").hidden = true;
    $("sc-presets").hidden = !$("sc-presets").hidden;
  });
  $("sc-colmenu").addEventListener("change", (event) => {
    const key = event.target.dataset.col;
    const off = new Set(hidden());
    if (event.target.checked) off.delete(key);
    else off.add(key);
    layout.hidden = [...off];
    saveLayout();
    renderHeader();
    renderBody();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#sc-colmenu, #sc-cols-button")) $("sc-colmenu").hidden = true;
    if (!event.target.closest("#sc-presets, #sc-presets-button")) $("sc-presets").hidden = true;
  });
  $("sc-add").addEventListener("click", async () => {
    const used = new Set(rules.map((r) => r.field));
    const groups = fieldGroups().map((g) => ({ ...g, items: g.items.filter((item) => !used.has(item.value)) })).filter((g) => g.items.length);
    const chosen = await pickOption($("sc-add"), { groups: groups.length ? groups : fieldGroups(), search: true });
    if (chosen === null) return;
    rules.push(blank(chosen));
    changed(true);
  });
  $("sc-etfs").checked = etfs;
  $("sc-etfs").addEventListener("change", (event) => {
    etfs = event.target.checked;
    store.set("screenEtfs", etfs);
    run();
  });
  $("sc-live").checked = liveScan;
  $("sc-live").addEventListener("change", (event) => {
    liveScan = event.target.checked;
    store.set("screenLive", liveScan);
    run();
  });
  $("sc-clear").addEventListener("click", () => { rules = []; loadedName = loadedStarter = null; renderPresets(); changed(true); });
  $("sc-save").addEventListener("click", async (event) => {
    const existing = !event.shiftKey && saved.find((p) => p.name === loadedName);
    if (existing && !(await confirmDialog({ title: `Update "${existing.name}"?`, message: "Replaces its saved filters with the ones on screen. Shift-click Save to keep it and save a new one.", ok: "Update" }))) return;
    const name = existing ? existing.name
      : ((await promptDialog({ title: "Save this scan", placeholder: "Name", ok: "Save" })) || "").trim();
    if (!name) return;
    saved = [...saved.filter((p) => p.name !== name), { name, rules: structuredClone(rules) }];
    loadedName = name;
    loadedStarter = null;
    saveScans();
    renderPresets();
  });
  $("sc-presets").addEventListener("click", (event) => {
    const del = event.target.closest("[data-delete]");
    if (del) {
      saved.splice(Number(del.dataset.delete), 1);
      saveScans();
      return renderPresets();
    }
    const chosen = event.target.closest("[data-preset]");
    if (!chosen) return;
    const [kind, index] = [chosen.dataset.preset[0], Number(chosen.dataset.preset.slice(1))];
    const preset = (kind === "s" ? STARTERS : saved)[index];
    rules = structuredClone(preset.rules);
    loadedName = kind === "u" ? preset.name : null;
    loadedStarter = kind === "s" ? preset.name : null;
    renderPresets();
    $("sc-presets").hidden = true;
    changed(true);
  });
  const setPart = (row, part, value) => {
    const rule = rules[Number(row.dataset.index)];
    if (part === "field") {
      rules[Number(row.dataset.index)] = { ...blank(value), ...(rule.any ? { any: true } : {}) };
      return changed(true);
    }
    const kind = fieldOf(rule.field)?.kind;
    if (part === "op") rule.op = value;
    else if (kind === "number") {
      if (value === "") return;
      rule.value = Number(value);
    } else if (kind === "flag") rule.value = value === "true";
    else rule.value = value;
    changed(part === "op" || kind === "flag");
  };
  $("sc-rules").addEventListener("input", (event) => {
    const row = event.target.closest(".sc-rule");
    const part = event.target.dataset.part;
    if (!row || !part || part === "remove" || event.target.closest(".pick")) return;
    setPart(row, part, event.target.value);
  });
  $("sc-rules").addEventListener("click", async (event) => {
    const trigger = event.target.closest(".pick");
    if (trigger) {
      const part = trigger.dataset.part;
      const kind = fieldOf(rules[Number(trigger.closest(".sc-rule").dataset.index)]?.field)?.kind;
      const chosen = await pickOption(trigger, part === "field"
        ? { groups: fieldGroups(), current: trigger.dataset.value, search: true }
        : { groups: [{ items: part === "op" ? OPS : YES_NO }], current: trigger.dataset.value });
      if (chosen !== null && kind !== undefined && chosen !== trigger.dataset.value) setPart(trigger.closest(".sc-rule"), part, chosen);
      return;
    }
    const join = event.target.closest("[data-part=any]");
    if (join) {
      const rule = rules[Number(join.closest(".sc-rule").dataset.index)];
      if (rule.any) delete rule.any;
      else rule.any = true;
      return changed(true);
    }
    const remove = event.target.closest("[data-part=remove]");
    if (!remove) return;
    rules.splice(Number(remove.closest(".sc-rule").dataset.index), 1);
    changed(true);
  });

  // Click a header: descending first for numbers (A–Z for text), then flipped.
  $("sc-cols").addEventListener("click", (event) => {
    const head = event.target.closest("[data-sort]");
    if (!head) return;
    const key = head.dataset.sort;
    if (COLUMNS[key]?.unsorted) return;
    if (pin?.key === key) return setPin({ key, dir: pin.dir === "asc" ? "desc" : "asc" });
    const first = isText(key) ? "asc" : "desc";
    sort = { key, dir: sort.key === key ? (sort.dir === "desc" ? "asc" : "desc") : first };
    store.set("screenSort", sort);
    renderHeader();
    run();
  });
  $("sc-cols").addEventListener("contextmenu", (event) => {
    const head = event.target.closest("[data-sort]");
    if (head && wantsMenu(event)) pinMenu(event, head.dataset.sort);
  });
  bindColumns($("sc-cols"), {
    width: widthOf,
    setWidth(key, px, final) {
      layout.widths = { ...layout.widths, [key]: px };
      if (px == null) delete layout.widths[key];
      $("screener").style.setProperty("--sc-grid", gridOf());
      if (final) saveLayout();
    },
    move(key, target) {
      layout.order = moved(order(), key, target);
      saveLayout();
      renderHeader();
      renderBody();
    },
  });
  $("sc-body").addEventListener("click", (event) => {
    const flag = event.target.closest("[data-flag]");
    if (flag) return toggleFlag(flag.dataset.flag);
    const line = event.target.closest(".sc-line");
    if (line) pick(line.dataset.symbol);
  });
  // Arrow keys step through the matches while the window has focus; Esc closes it.
  $("screener").addEventListener("keydown", (event) => {
    if (event.key === "Escape") return closeScreener();
    if (event.target.closest("input, select, textarea")) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!stepScreener(event.key === "ArrowDown" ? 1 : -1, activeSymbol) && rows.length) pick(rows[0].symbol);
    }
  });
  $("sc-body").addEventListener("pointerdown", () => $("screener").focus({ preventScroll: true }));
  $("sc-body").addEventListener("pointerover", (event) => {
    const line = event.target.closest(".sc-line[data-symbol]");
    if (line) warmSymbol(line.dataset.symbol);
  });
  $("sc-body").addEventListener("scroll", () => {
    if (!watchFrame) watchFrame = requestAnimationFrame(() => { watchFrame = 0; watchShown(); });
  }, { passive: true });
}
