import { $, escapeHtml, store } from "./util.js";
import { addIndicator, chartSettings } from "./chartsettings.js";
import { GROUPS, INDICATORS } from "./indicators.js";
import { openIndicatorSettings } from "./indicatorsettings.js";
import { state } from "./state.js";

// The indicator browser behind ƒx: search or pick a group, click to add to the chart. It floats
// like the Market window, so the chart shows what was added. Favourites follow the account.

const ICONS = {
  chart: `<path d="M4 4v16h16M8 15l3-4 3 2 5-6"/>`,
  favorites: `<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>`,
  all: `<path d="M4 6h16M4 12h16M4 18h16"/>`,
  trend: `<path d="M3 17c4-1 5-8 9-8s5 3 9-3"/>`,
  momentum: `<path d="M3 12h4l3-7 4 14 3-7h4"/>`,
  volatility: `<path d="M3 8c3-4 6-4 9 0s6 4 9 0M3 16c3 4 6 4 9 0s6-4 9 0"/>`,
  levels: `<path d="M3 6h18M3 12h18M3 18h18" stroke-dasharray="3 3"/>`,
};

let group = store.get("indicatorGroup", "all");
let query = "";
let picked = 0;
let rows = [];   // the types shown, in order
let place = store.get("indicatorWindow", null);

store.follow(["indicatorFavs"]);
const favourites = () => store.get("indicatorFavs", []);
const offered = () => Object.entries(INDICATORS).filter(([, def]) => !def.chartOnly || state.mode === "chart");
const onChart = (type) => chartSettings.indicators.filter((item) => item.type === type).length;

function matches([type, def]) {
  if (query) return `${def.name} ${def.about} ${def.group}`.toLowerCase().includes(query);
  if (group === "favorites") return favourites().includes(type);
  return group === "all" || def.group === group;
}

function renderSide() {
  const item = (key, label) => `<button data-group="${key}" class="${!query && key === group ? "active" : ""}"><svg viewBox="0 0 24 24">${ICONS[key]}</svg>${label}</button>`;
  $("ib-side").innerHTML = `<div class="mk-navh">Personal</div>${item("chart", "On the chart")}${item("favorites", "Favorites")}` +
    `<div class="mk-navh">Built-in</div>${item("all", "All indicators")}` +
    GROUPS.filter(({ key }) => offered().some(([, def]) => def.group === key)).map(({ key, label }) => item(key, label)).join("");
}

// What's on the chart: a click opens that indicator's settings, as its legend row does.
function renderChartList() {
  const on = chartSettings.indicators.filter((ind) => !INDICATORS[ind.type].chartOnly || state.mode === "chart");
  rows = [];
  $("ib-list").innerHTML = on.map((ind) => {
    const def = INDICATORS[ind.type];
    return `<div class="ib-row ${ind.visible ? "" : "off"}" data-ind="${escapeHtml(ind.id)}" role="option">` +
      `<div class="ib-text"><b>${escapeHtml(def.label(ind.params))}</b><span>${escapeHtml(def.name)}${ind.visible ? "" : " · hidden"}</span></div></div>`;
  }).join("") || `<div class="ib-empty">No indicators on the chart.</div>`;
}

function renderList() {
  if (group === "chart" && !query) { renderChartList(); return; }
  const shown = offered().filter(matches).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  rows = shown.map(([type]) => type);
  picked = Math.min(picked, Math.max(0, rows.length - 1));
  const list = $("ib-list");
  if (!rows.length) {
    list.innerHTML = `<div class="ib-empty">${query ? `Nothing matches “${escapeHtml(query)}”.` : "Star an indicator to keep it here."}</div>`;
    return;
  }
  list.innerHTML = shown.map(([type, def], i) => {
    const count = onChart(type);
    const fav = favourites().includes(type);
    return `<div class="ib-row ${i === picked ? "on" : ""}" data-type="${type}" role="option">` +
      `<div class="ib-text"><b>${escapeHtml(def.name)}</b><span>${escapeHtml(def.about)}</span></div>` +
      (count ? `<em class="ib-count" title="On the chart">✓${count > 1 ? ` ${count}` : ""}</em>` : "") +
      `<button class="ib-star ${fav ? "on" : ""}" data-fav="${type}" title="${fav ? "Remove from favorites" : "Add to favorites"}">${fav ? "★" : "☆"}</button></div>`;
  }).join("");
}

const render = () => { renderSide(); renderList(); };

function pick(index) {
  if (!rows.length) return;
  picked = (index + rows.length) % rows.length;
  const items = $("ib-list").querySelectorAll(".ib-row");
  items.forEach((row, i) => row.classList.toggle("on", i === picked));
  items[picked].scrollIntoView({ block: "nearest" });
}

function add(type) {
  addIndicator(type);
  renderList();
}

function toggleFavourite(type) {
  const favs = favourites();
  store.set("indicatorFavs", favs.includes(type) ? favs.filter((each) => each !== type) : [...favs, type]);
  renderList();
}

export const indicatorBrowserOpen = () => !$("ib").hidden;
export const refreshIndicatorBrowser = () => { if (indicatorBrowserOpen()) renderList(); };

export function closeIndicatorBrowser() {
  $("ib").hidden = true;
}

function applyPlace() {
  const box = $("ib");
  const width = Math.min(box.offsetWidth, innerWidth);
  const x = place ? place.x : Math.round((innerWidth - width) / 2);
  const y = place ? place.y : 64;
  box.style.left = `${Math.max(0, Math.min(x, innerWidth - width))}px`;
  box.style.top = `${Math.max(44, Math.min(y, innerHeight - 120))}px`;
}

export function openIndicatorBrowser() {
  const box = $("ib");
  box.hidden = false;
  applyPlace();
  query = "";
  picked = 0;
  $("ib-q").value = "";
  if (group === "favorites" && !favourites().length) group = "all";
  render();
  box.classList.remove("in");
  void box.offsetWidth;
  box.classList.add("in");
  $("ib-q").focus();
}

export const toggleIndicatorBrowser = () => (indicatorBrowserOpen() ? closeIndicatorBrowser() : openIndicatorBrowser());

function bindDrag() {
  const box = $("ib");
  const head = $("ib-head");
  head.addEventListener("pointerdown", (event) => {
    if (event.button || event.target.closest("button, input")) return;
    const start = { x: event.clientX - box.offsetLeft, y: event.clientY - box.offsetTop };
    head.setPointerCapture(event.pointerId);
    const drag = (e) => {
      box.style.left = `${Math.max(0, Math.min(e.clientX - start.x, innerWidth - 120))}px`;
      box.style.top = `${Math.max(44, Math.min(e.clientY - start.y, innerHeight - 60))}px`;
    };
    const stop = () => {
      head.removeEventListener("pointermove", drag);
      head.removeEventListener("pointerup", stop);
      place = { x: box.offsetLeft, y: box.offsetTop };
      store.set("indicatorWindow", place);
    };
    head.addEventListener("pointermove", drag);
    head.addEventListener("pointerup", stop);
  });
}

export function bindIndicatorBrowser() {
  bindDrag();
  $("ib-close").addEventListener("click", closeIndicatorBrowser);
  $("ib-side").addEventListener("click", (event) => {
    const button = event.target.closest("[data-group]");
    if (!button) return;
    group = button.dataset.group;
    store.set("indicatorGroup", group);
    query = "";
    picked = 0;
    $("ib-q").value = "";
    render();
    $("ib-q").focus();
  });
  $("ib-list").addEventListener("click", (event) => {
    const star = event.target.closest("[data-fav]");
    if (star) { toggleFavourite(star.dataset.fav); return; }
    const row = event.target.closest(".ib-row");
    if (row?.dataset.ind) {
      const { right, top } = row.getBoundingClientRect();
      openIndicatorSettings(row.dataset.ind, right + 8, top, renderList);
    } else if (row) add(row.dataset.type);
  });
  $("ib-q").addEventListener("input", (event) => {
    query = event.target.value.trim().toLowerCase();
    picked = 0;
    render();
  });
  $("ib-q").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      pick(picked + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      if (rows.length) add(rows[picked]);
    } else if (event.key === "Escape") {
      event.stopPropagation(); // the page's Esc would only leave the box
      closeIndicatorBrowser();
    }
  });
}
