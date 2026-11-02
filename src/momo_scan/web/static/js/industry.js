import { $, api, escapeHtml, store, ticker, toast } from "./util.js";
import { actions, state } from "./state.js";
import { FLAG_SVG, flagCell, toggleFlag } from "./watchlists.js";
import { bindColumns, gripHtml, moved } from "./columns.js";
import { columnItems, openMenu, wantsMenu } from "./contextmenu.js";
import { COLUMNS, liveRow } from "./screener.js";
import {
  buzzLabel, buzzSession, flashCell, onLiveBuzz, onLiveQuotes, onSessionChange, watchBuzz, watchLive,
} from "./live.js";

// Industry group list: a floating window with every stock in the chart's industry. Columns work
// like the screener's (sort, resize, reorder, choose); the layout, the sort (the default sort
// for every industry) and the window's place are remembered.
const DEFAULT_SHOWN = ["price", "chg", "adr", "dvol", "m1"];
const FLAG_WIDTH = 24;
const SYMBOL_WIDTH = 66;
// The industry name itself (the same on every row) isn't offered; neither are the live columns
// (Ext, Buzz...) to accounts without live prices.
const OFFERED = Object.keys(COLUMNS).filter((key) => key !== "industry");
const live = () => Boolean(state.me && state.me.live);
const offered = (key) => OFFERED.includes(key) && (live() || !COLUMNS[key].unsorted);

let industry = null;
let rows = [];
let token = 0;
let activeSymbol = null;
let sort = store.get("industrySort", { key: "dvol", dir: "desc" });
let layout = store.get("industryColumns", {}); // { order, hidden, widths }
let place = store.get("industryWindow", null);

const order = () => {
  const saved = (layout.order || []).filter(offered);
  return [...saved, ...OFFERED.filter((key) => offered(key) && !saved.includes(key))];
};
// A saved layout hides what it hasn't met: the live columns came after the first layouts.
const known = () => layout.known || OFFERED.filter((key) => !COLUMNS[key].unsorted);
const hidden = () => (layout.hidden
  ? [...layout.hidden, ...OFFERED.filter((key) => !known().includes(key))]
  : OFFERED.filter((key) => !DEFAULT_SHOWN.includes(key)));
const shown = () => order().filter((key) => !hidden().includes(key));
const widthOf = (key) => (layout.widths && layout.widths[key]) || COLUMNS[key].width;
const gridOf = () => `${FLAG_WIDTH}px ${SYMBOL_WIDTH}px ${shown().map((key) => `${widthOf(key)}px`).join(" ")}`;
const saveLayout = () => { layout.known = OFFERED; store.set("industryColumns", layout); };
const isText = (key) => key === "symbol" || Boolean(COLUMNS[key]?.text);

export const industryOpen = () => !$("industry").hidden;
export const closeIndustry = () => {
  $("industry").hidden = true;
  watchLive("industry", []);
  watchBuzz("industry", []);
};

function applyPlace() {
  const box = $("industry");
  if (!place) place = { w: 560, h: Math.round(innerHeight * 0.6), x: Math.max(8, innerWidth - 1140), y: 90 };
  const [w, h] = [Math.min(place.w, innerWidth - 16), Math.min(place.h, innerHeight - 56)];
  place = { w, h, x: Math.max(0, Math.min(place.x, innerWidth - 120)), y: Math.max(44, Math.min(place.y, innerHeight - 60)) };
  Object.assign(box.style, { left: `${place.x}px`, top: `${place.y}px`, width: `${w}px`, height: `${h}px` });
}

function sorted() {
  const { key, dir } = sort;
  const value = (row) => (key === "symbol" ? ticker(row.symbol) : row[key]);
  return [...rows].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // blanks last
    const by = typeof x === "string" ? x.localeCompare(y) : x - y;
    return dir === "asc" ? by : -by;
  });
}

function renderHeader() {
  const arrow = (key) => (sort.key === key ? `<i class="sort-arrow">${sort.dir === "asc" ? "▲" : "▼"}</i>` : "");
  $("in-cols").innerHTML =
    `<span class="fl" title="Flag: click a row's flag to mark it">${FLAG_SVG}</span>` +
    `<span data-sort="symbol" class="${sort.key === "symbol" ? "sorted" : ""}">Symbol${arrow("symbol")}</span>` +
    shown().map((key) => {
      const col = COLUMNS[key];
      const label = key === "buzz" ? buzzLabel({ session: buzzSession() }) : col.label;
      return `<span data-sort="${key}" data-col="${key}" draggable="true" class="${col.text ? "l" : ""}${sort.key === key ? " sorted" : ""}"${col.title ? ` title="${escapeHtml(col.title)}"` : ""}>${label}${arrow(key)}${gripHtml(false)}</span>`;
    }).join("");
  $("industry").style.setProperty("--sc-grid", gridOf());
}

function lineHtml(row) {
  const mark = row.symbol === activeSymbol ? " active" : "";
  return `<div class="sc-row sc-line${mark}" data-symbol="${escapeHtml(row.symbol)}" title="${escapeHtml(row.name)}">` +
    flagCell(row.symbol) + `<span class="sym">${escapeHtml(ticker(row.symbol))}</span>` +
    shown().map((key) => `<span class="${COLUMNS[key].text ? "l" : ""}"${COLUMNS[key].live ? ` data-live="${key}"` : ""}>${COLUMNS[key].html(row, key)}</span>`).join("") + `</div>`;
}

function renderBody() {
  $("in-body").innerHTML = rows.length ? sorted().map(lineHtml).join("") : `<div class="sc-empty">No stocks found.</div>`;
  watchShown();
}

// ---------- live prices ----------
// Rows in view (and a screenful either side) are watched, so a long group doesn't crowd out
// the chart and watchlists. Sorting stays on the last close until the list is next drawn.
const SPARE_ROWS = 30;
let watchFrame = 0;

function watchShown() {
  if (!industryOpen()) return;
  const scroller = $("in-scroll");
  const lines = [...$("in-body").querySelectorAll(".sc-line")];
  const height = lines[0] ? lines[0].offsetHeight || 22 : 22;
  const first = Math.max(0, Math.floor(scroller.scrollTop / height) - SPARE_ROWS);
  const last = Math.ceil((scroller.scrollTop + scroller.clientHeight) / height) + SPARE_ROWS;
  const symbols = lines.slice(first, last).map((line) => line.dataset.symbol);
  watchLive("industry", symbols);
  watchBuzz("industry", shown().some((key) => key === "buzz" || key === "ext_vol") ? symbols : []);
}

const lineMap = () => new Map([...$("in-body").querySelectorAll(".sc-line")].map((line) => [ticker(line.dataset.symbol), line]));

onLiveQuotes((quotes) => {
  if (!industryOpen() || !rows.length) return;
  const lines = lineMap();
  rows.forEach((row, i) => {
    const quote = quotes.get(ticker(row.symbol));
    if (!quote || quote.day < row.date) return;
    const next = liveRow(row, quote);
    const direction = Math.sign(next.price - row.price);
    rows[i] = next;
    const line = lines.get(ticker(row.symbol));
    for (const cell of line ? line.querySelectorAll("[data-live]") : []) {
      const key = cell.dataset.live;
      flashCell(cell, COLUMNS[key].html(next, key), COLUMNS[key].price ? direction : 0);
    }
  });
});

onLiveBuzz((updates) => {
  if (!industryOpen() || !rows.length) return;
  const lines = lineMap();
  rows.forEach((row, i) => {
    const buzz = updates.get(ticker(row.symbol));
    if (!buzz) return;
    rows[i] = { ...row, buzz, ext_vol: row.quote ? liveRow(row, row.quote).ext_vol : row.ext_vol };
    const line = lines.get(ticker(row.symbol));
    for (const cell of line ? line.querySelectorAll('[data-live="buzz"], [data-live="ext_vol"]') : []) {
      flashCell(cell, COLUMNS[cell.dataset.live].html(rows[i], cell.dataset.live));
    }
  });
});

// The session changed: the Buzz header follows it, and Ext columns fill or empty.
onSessionChange(() => {
  if (!industryOpen()) return;
  rows = rows.map((row) => (row.quote ? liveRow(row, row.quote) : row));
  renderHeader();
  renderBody();
});

// Mark the chart's own stock so you can see where it stands in its group.
export function markIndustrySymbol(symbol) {
  activeSymbol = symbol || null;
  if (!industryOpen()) return;
  for (const line of $("in-body").querySelectorAll(".sc-line")) {
    const hit = ticker(line.dataset.symbol) === ticker(activeSymbol || "");
    line.classList.toggle("active", hit);
    if (hit) line.scrollIntoView({ block: "nearest" });
  }
}

// Walk the list in its sorted order from the symbol on the chart (Space, ↑↓). False when the
// chart isn't on one of its stocks, so the screener or watchlist keeps its own stepping.
export function stepIndustry(delta, current) {
  if (!industryOpen() || !rows.length) return false;
  const list = sorted();
  const at = list.findIndex((row) => ticker(row.symbol) === ticker(current || ""));
  if (at < 0) return false;
  const next = at + delta;
  if (next < 0 || next >= list.length) {
    toast(next < 0 ? "Top of the list" : "End of the list");
    return true;
  }
  actions.openSymbol(list[next].symbol);
  return true;
}

// Symbols a few steps ahead of (and one behind) the chart, for prefetching.
export function industryNeighbors(current, offsets) {
  if (!industryOpen() || !rows.length) return [];
  const list = sorted();
  const at = list.findIndex((row) => ticker(row.symbol) === ticker(current || ""));
  return at < 0 ? [] : offsets.map((offset) => list[at + offset]).filter(Boolean).map((row) => row.symbol);
}

export async function openIndustry(name, symbol) {
  const box = $("industry");
  industry = name;
  activeSymbol = symbol || null;
  const mine = ++token;
  const fresh = box.hidden;
  box.hidden = false;
  applyPlace();
  if (fresh) {
    box.classList.remove("in");
    void box.offsetWidth;
    box.classList.add("in");
  }
  $("in-title").textContent = name;
  $("in-count").textContent = "";
  $("in-foot").textContent = "";
  rows = [];
  renderHeader();
  $("in-body").innerHTML = `<div class="sc-empty">Loading…</div>`;
  try {
    const result = await api(`/api/industry?name=${encodeURIComponent(name)}`);
    if (mine !== token) return;
    rows = result.rows;
    $("in-count").textContent = `${rows.length} stock${rows.length === 1 ? "" : "s"}`;
    $("in-foot").textContent = `Through ${result.as_of}`;
    renderBody();
    markIndustrySymbol(symbol);
    $("in-body").querySelector(".sc-line.active")?.scrollIntoView({ block: "nearest" });
  } catch (error) {
    if (mine === token) $("in-body").innerHTML = `<div class="sc-empty">Couldn't load: ${escapeHtml(error.message)}</div>`;
  }
}

function toggleColumn(key) {
  const off = new Set(hidden());
  if (off.has(key)) off.delete(key);
  else off.add(key);
  layout.hidden = [...off];
  saveLayout();
  renderHeader();
  renderBody();
}

function setSort(next) {
  sort = next;
  store.set("industrySort", sort);
  renderHeader();
  renderBody();
}

function bindWindow() {
  const box = $("industry");
  const remember = () => {
    const rect = box.getBoundingClientRect();
    place = { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
    store.set("industryWindow", place);
  };
  const head = $("in-drag");
  head.addEventListener("pointerdown", (event) => {
    if (event.button || event.target.closest("button")) return;
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
  let settle = 0;
  new ResizeObserver(() => {
    if (box.hidden) return;
    clearTimeout(settle);
    settle = setTimeout(remember, 250);
  }).observe(box);
  addEventListener("resize", () => { if (!box.hidden && place) applyPlace(); });
}

export function bindIndustry() {
  bindWindow();
  $("in-close").addEventListener("click", closeIndustry);
  $("in-cols-button").addEventListener("click", () => {
    const menu = $("in-colmenu");
    menu.innerHTML = order().map((key) =>
      `<label><input type="checkbox" data-col="${key}"${hidden().includes(key) ? "" : " checked"}> ${COLUMNS[key].label}</label>`).join("") +
      `<label><button type="button" class="mini" data-reset>Reset columns and sort</button></label>`;
    menu.hidden = !menu.hidden;
  });
  $("in-colmenu").addEventListener("change", (event) => {
    if (event.target.dataset.col) toggleColumn(event.target.dataset.col);
  });
  $("in-colmenu").addEventListener("click", (event) => {
    if (!event.target.closest("[data-reset]")) return;
    layout = {};
    saveLayout();
    $("in-colmenu").hidden = true;
    setSort({ key: "dvol", dir: "desc" });
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#in-colmenu, #in-cols-button")) $("in-colmenu").hidden = true;
  });
  // Click a header: descending first for numbers (A–Z for text), then flipped.
  $("in-cols").addEventListener("click", (event) => {
    const head = event.target.closest("[data-sort]");
    if (!head) return;
    const key = head.dataset.sort;
    setSort({ key, dir: sort.key === key ? (sort.dir === "desc" ? "asc" : "desc") : isText(key) ? "asc" : "desc" });
  });
  $("in-cols").addEventListener("contextmenu", (event) => {
    const head = event.target.closest("[data-col]");
    if (!head || !wantsMenu(event)) return;
    const key = head.dataset.col;
    const [up, down] = isText(key) ? ["A–Z", "Z–A"] : ["Low–high", "High–low"];
    openMenu(event, columnItems({
      label: COLUMNS[key].label,
      sorts: [["asc", up], ["desc", down]].map(([dir, label]) => ({
        label: `Sort ${label}`, checked: sort.key === key && sort.dir === dir, run: () => setSort({ key, dir }),
      })),
      hide: () => toggleColumn(key),
      resetWidth: layout.widths?.[key] && (() => { delete layout.widths[key]; saveLayout(); $("industry").style.setProperty("--sc-grid", gridOf()); }),
      columns: order().map((each) => ({ label: COLUMNS[each].label, checked: !hidden().includes(each), run: () => toggleColumn(each) })),
      reset: () => { layout = {}; saveLayout(); renderHeader(); renderBody(); },
    }));
  });
  bindColumns($("in-cols"), {
    width: widthOf,
    setWidth(key, px, final) {
      layout.widths = { ...layout.widths, [key]: px };
      if (px == null) delete layout.widths[key];
      $("industry").style.setProperty("--sc-grid", gridOf());
      if (final) saveLayout();
    },
    move(key, target) {
      layout.order = moved(order(), key, target);
      saveLayout();
      renderHeader();
      renderBody();
    },
  });
  $("in-body").addEventListener("click", (event) => {
    const flag = event.target.closest("[data-flag]");
    if (flag) return toggleFlag(flag.dataset.flag);
    const line = event.target.closest(".sc-line");
    if (line) actions.openSymbol(line.dataset.symbol);
  });
  $("in-scroll").addEventListener("scroll", () => {
    if (!watchFrame) watchFrame = requestAnimationFrame(() => { watchFrame = 0; watchShown(); });
  }, { passive: true });
  $("industry").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeIndustry();
  });
}
