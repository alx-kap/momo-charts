import { $, api, escapeHtml, fmtPct, store } from "./util.js";
import { actions } from "./state.js";
import { forgetPositioning, positioningClick, renderPositioning } from "./cot.js";

// The Market window (the markup keeps its old #themes ids). Tabs: Themes, where money is going and
// leaving, Pullbacks, themes that dipped to an average and got bought, and Positioning, how
// the big futures traders are leaning (cot.js).
// Theme strength: Click a column to sort, a row for its stocks.
const COLUMNS = [
  ["name", "Theme"], ["from_open", "Open"], ["d1", "1D"], ["w1", "1W"], ["m1", "1M"], ["m3", "3M"], ["trend", "3M path"], ["above50", "Above 50d"],
];
const PERIODS = ["from_open", "d1", "w1", "m1", "m3"]; // from_open: the last session's close against its open
const sign = (v) => (v == null ? "flat" : v > 0.04 ? "up" : v < -0.04 ? "down" : "flat");
const pct = (v) => (v == null ? "—" : fmtPct(v, 1));

// The theme's path over three months, rebased to 100; green when it ends above where it began.
function spark(points) {
  if (points.length < 2) return "";
  const [lo, hi] = [Math.min(...points), Math.max(...points)];
  const span = hi - lo || 1;
  const path = points.map((v, i) => `${(i * 58 / (points.length - 1)).toFixed(1)},${(14 - 12 * (v - lo) / span).toFixed(1)}`).join(" ");
  const up = points[points.length - 1] >= points[0];
  return `<svg class="th-spark ${up ? "up" : "down"}" viewBox="0 0 58 16" width="58" height="16"><polyline points="${path}"/></svg>`;
}

let report = null;
let industries = null; // the Industries tab: same table, from /api/industries
let sort = { key: "m1", dir: -1 };
let open = null;
let tab = store.get("marketTab", "themes");
if (tab === "pullbacks") tab = "themes"; // parked, see pullbacks()
let period = store.get("marketPeriod", "d1");
let full = false; // the whole table instead of the leaders

// The window keeps its place and size, like the screener.
let place = store.get("marketWindow", null);

function applyPlace() {
  const box = $("themes");
  if (!place) place = { x: Math.max(8, Math.round((innerWidth - 890) / 2)), y: 60, h: Math.min(720, Math.round(innerHeight * 0.8)) };
  place.w = Math.max(Math.min(890, innerWidth * 0.98), Math.min(place.w ?? 890, innerWidth * 0.98));
  place.h = Math.min(place.h, innerHeight - 56);
  const x = Math.max(0, Math.min(place.x, innerWidth - place.w));
  place = { ...place, x, y: Math.max(44, Math.min(place.y, innerHeight - 120)) };
  Object.assign(box.style, { left: `${place.x}px`, top: `${place.y}px`, width: `${place.w}px`, height: `${place.h}px` });
}

function bindWindow() {
  const box = $("themes");
  const head = box.querySelector(".rc-head");
  const remember = () => {
    if (box.hidden) return;
    const rect = box.getBoundingClientRect();
    place = { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
    store.set("marketWindow", place);
  };
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

export const themesOpen = () => !$("themes").hidden;

export function closeThemes() {
  $("themes").hidden = true;
}

// Whether the data the current tab needs is in.
const loaded = () => tab === "positioning" || (tab === "industries" ? industries : report);

export async function openThemes(chosen) {
  if (chosen) { tab = chosen; store.set("marketTab", tab); }
  forgetPositioning();
  const box = $("themes");
  box.hidden = false;
  applyPlace();
  box.classList.remove("in");
  void box.offsetWidth;
  box.classList.add("in");
  if (loaded()) return render();
  $("th-body").innerHTML = `<div class="rc-loading muted">Reading the ${tab === "industries" ? "industries" : "themes"}…</div>`;
  try {
    if (tab === "industries") industries = await api("/api/industries");
    else report = await api("/api/themes");
    render();
  } catch (error) {
    $("th-body").innerHTML = `<div class="rc-loading muted">Couldn't load themes: ${escapeHtml(error.message)}</div>`;
  }
}

const PERIOD_LABELS = { from_open: "Open", d1: "1D", w1: "1W", m1: "1M", m3: "3M" };
const OPEN_TIP = "Change from the open: the last session's close against its open";

// The pills show and sort by the period the view is on: the picker, or in the full table the
// sorted column (1M for the other columns).
const pillKey = () => (full ? (PERIODS.includes(sort.key) ? sort.key : "m1") : period);

// What a theme or industry shows when opened: its four periods, breadth, tightening, its stocks.
function detail(theme) {
  const key = pillKey();
  const ranked = [...theme.stocks].sort((a, b) => (b[key] ?? -1e9) - (a[key] ?? -1e9));
  const cell = (k) => `<div class="mk-c${k === key ? " cur" : ""}"${k === "from_open" ? ` title="${OPEN_TIP}"` : ""}><small>${PERIOD_LABELS[k]}</small><span class="${sign(theme[k])}">${pct(theme[k])}</span></div>`;
  return `<div class="mk-strip">${PERIODS.map(cell).join("")}<i class="mk-sep"></i>` +
    `<div class="mk-c"><small>Above 50d</small><span>${theme.above50}%<span class="th-bar"><i style="width:${theme.above50}%"></i></span></span></div>` +
    `<div class="mk-c" title="Above the 20 and 50-day with a 5-day range under 1.5 ADR (outlined in blue)"><small>Tightening</small><span>${theme.tightening} of ${theme.stocks.length}</span></div></div>` +
    `<div class="rc-chips">` +
    ranked.map((s) =>
      `<button class="rc-chip${s.tightening ? " tight" : ""}" data-symbol="${escapeHtml(s.symbol)}" ` +
      `title="${s.tightening ? "Tightening above its 20 and 50-day. " : ""}Open ${pct(s.from_open)} · 1D ${pct(s.d1)} · 1W ${pct(s.w1)} · 1M ${pct(s.m1)} · 3M ${pct(s.m3)}">` +
      `<b>${escapeHtml(s.symbol)}</b><span class="${sign(s[key])}">${pct(s[key])}</span></button>`).join("") +
    `</div>`;
}

// Parked while Alex tries the new Market window: the nav has no Pullbacks button. To bring it
// back, add a data-tab="pullbacks" button to #mk-tabs in index.html.
// Themes that dipped to their 20 or 50-day average inside an uptrend, most recovered first.
// "Bought" is the theme's path back above its 20-day and 1% or more off the low; the bar is
// how much of the dip it has won back.
function pullbacks() {
  const found = report.themes.filter((t) => t.pullback)
    .sort((a, b) => (b.pullback.state === "bought") - (a.pullback.state === "bought") || b.pullback.bounce - a.pullback.bounce);
  if (!found.length) return `<div class="rc-loading muted">No theme is pulling back to its averages right now.</div>`;
  const row = (t) => {
    const p = t.pullback;
    const won = Math.max(0, Math.min(100, Math.round(100 * p.bounce / Math.abs(p.dip))));
    const state = p.state === "bought"
      ? `<span class="th-pill bought" title="Back above its 20-day and ${pct(p.bounce)} off the low">bought · ${p.up_days} up days</span>`
      : `<span class="th-pill" title="At its ${p.average}-day, not bought yet">at the ${p.average}-day</span>`;
    return `<tr class="th-row" data-id="${escapeHtml(t.id)}"><td class="name">${escapeHtml(t.name)} <span class="muted">${t.members}</span></td>` +
      `<td class="${sign(p.vs20)}">${pct(p.vs20)}</td><td class="down">${pct(p.dip)}</td><td>${state}</td>` +
      `<td><span class="th-bar wide" title="${won}% of the dip won back"><i style="width:${won}%"></i></span></td></tr>`;
  };
  return `<div class="th-pb">` +
    `<table class="th-table th-pbt"><thead><tr><th>Theme</th><th>vs 20d</th><th>Dip</th><th>State</th><th>Dip won back</th></tr></thead><tbody>` +
    found.map(row).join("") + `</tbody></table>` +
    `<p class="rc-note">Rising themes that dipped to their 20 or 50-day average in the last 2 weeks. Bought means they've bounced back. Click a row for its stocks.</p></div>`;
}

const rows = () => (tab === "industries" ? industries.industries : report.themes);

const TITLES = { themes: "Themes", industries: "Industries", positioning: "Positioning", pullbacks: "Pullbacks" };

function render() {
  $("mk-title").textContent = TITLES[tab];
  document.querySelectorAll("#mk-tabs [data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  for (const [key, data, list] of [["themes", report, report?.themes], ["industries", industries, industries?.industries]]) {
    if (data) document.querySelector(`#mk-tabs [data-count="${key}"]`).textContent = list.length;
  }
  if (tab === "positioning") renderPositioning($("th-body"), $("th-sub"));
  else if (tab === "pullbacks") {
    const found = report.themes.filter((t) => t.pullback).length;
    $("th-sub").textContent = `${found} theme${found === 1 ? "" : "s"} pulled back · through ${report.as_of}`;
    $("th-body").innerHTML = pullbacks();
  } else renderThemes();
}

function renderThemes() {
  const isIndustries = tab === "industries";
  $("th-sub").textContent = `${rows().length} ${isIndustries ? "industries" : "themes"}, median return of the stocks in each · through ${(isIndustries ? industries : report).as_of}`;
  $("th-body").innerHTML = full ? table(isIndustries) : leaders();
}

// The default view: the strongest five and weakest three on the picked period, as bars.
function leaders() {
  const ranked = [...rows()].sort((a, b) => (b[period] ?? -1e9) - (a[period] ?? -1e9));
  const scale = Math.max(0.1, ...ranked.map((t) => Math.abs(t[period] ?? 0)));
  const row = (t) => {
    const v = t[period];
    return `<div class="mk-row${open === t.id ? " open" : ""}" data-id="${escapeHtml(t.id)}">` +
      `<span class="mk-name">${escapeHtml(t.name)} <span class="muted">${t.members}</span></span>` +
      `<span class="mk-bar"><i class="${v >= 0 ? "up" : "down"}" style="width:${Math.min(Math.abs(v ?? 0) / scale, 1) * 50}%"></i></span>` +
      `<span class="mk-val ${sign(v)}">${pct(v)}</span><span class="mk-chev">›</span></div>` +
      (open === t.id ? `<div class="mk-detail">${detail(t)}</div>` : "");
  };
  const lagging = ranked.slice(Math.max(5, ranked.length - 3));
  return `<div class="seg mk-per">` +
    Object.entries(PERIOD_LABELS).map(([key, label]) => `<button data-period="${key}" class="${key === period ? "on" : ""}"${key === "from_open" ? ` title="${OPEN_TIP}"` : ""}>${label}</button>`).join("") +
    `</div><div class="mk-lbl">Leading</div>${ranked.slice(0, 5).map(row).join("")}` +
    (lagging.length ? `<div class="mk-lbl">Lagging</div>${lagging.map(row).join("")}` : "") +
    `<button class="mk-all" data-full>Show all ${ranked.length} ›</button>`;
}

// Every group, sortable by any column.
function table(isIndustries) {
  const columns = isIndustries ? COLUMNS.filter(([key]) => key !== "trend") : COLUMNS;
  const by = isIndustries && sort.key === "trend" ? "m1" : sort.key; // industries have no path
  const sorted = [...rows()].sort((a, b) => {
    const [x, y] = [a[by], b[by]];
    if (by === "trend") return sort.dir * (((a.trend.at(-1) ?? 100) - (a.trend[0] ?? 100)) - ((b.trend.at(-1) ?? 100) - (b.trend[0] ?? 100)));
    if (by === "name") return sort.dir * x.localeCompare(y);
    return sort.dir * ((x ?? -1e9) - (y ?? -1e9));
  });
  // Return cells are tinted by size; the scale is each column's 90th-percentile move, so one outlier doesn't wash the rest out.
  const scale = Object.fromEntries(PERIODS.map((key) => {
    const moves = rows().map((t) => Math.abs(t[key] ?? 0)).sort((a, b) => a - b);
    return [key, Math.max(0.1, moves[Math.floor(moves.length * 0.9)] ?? 0.1)];
  }));
  const cell = (t, key) => {
    const v = t[key];
    const tint = v == null ? "" : ` style="background:rgba(${v < 0 ? "232,38,45" : "38,196,69"},${(0.04 + 0.2 * Math.min(Math.abs(v) / scale[key], 1)).toFixed(2)})"`;
    return `<td class="${sign(v)}"><span class="th-hm"${tint}>${pct(v)}</span></td>`;
  };
  return `<button class="mk-all" data-full>‹ Back to leaders</button><table class="th-table"><thead><tr>` +
    columns.map(([key, label]) =>
      `<th data-sort="${key}" class="${by === key ? "sorted" : ""}"${key === "from_open" ? ` title="${OPEN_TIP}"` : ""}>${key === "name" && isIndustries ? "Industry" : label}${by === key ? (sort.dir < 0 ? " ▼" : " ▲") : ""}</th>`).join("") +
    `</tr></thead><tbody>` +
    sorted.map((t) =>
      `<tr class="th-row" data-id="${escapeHtml(t.id)}"><td class="name">${escapeHtml(t.name)} <span class="muted">${t.members}</span>` +
      (t.tightening ? `<span class="th-tight" title="${t.tightening} tightening: above the 20 and 50-day with a 5-day range under 1.5 ADR">${t.tightening}</span>` : "") + `</td>` +
      PERIODS.map((key) => cell(t, key)).join("") +
      (isIndustries ? "" : `<td>${spark(t.trend)}</td>`) +
      `<td>${t.above50}%<span class="th-bar"><i style="width:${t.above50}%"></i></span></td></tr>` +
      (open === t.id ? `<tr class="th-stocks"><td colspan="${columns.length}"><div class="mk-detail">${detail(t)}</div></td></tr>` : "")).join("") +
    `</tbody></table>`;
}

export function bindThemes() {
  bindWindow();
  $("th-close").addEventListener("click", closeThemes);
  $("mk-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    tab = button.dataset.tab;
    store.set("marketTab", tab);
    open = null;
    full = false;
    if (tab === "positioning") forgetPositioning();
    if (loaded()) render();
    else openThemes();
  });
  $("themes").addEventListener("click", (event) => {
    if (tab === "positioning") return void positioningClick(event, $("th-body"), $("th-sub"));
    const head = event.target.closest("th[data-sort]");
    if (head) {
      const key = head.dataset.sort;
      sort = { key, dir: sort.key === key ? -sort.dir : key === "name" ? 1 : -1 };
      return render();
    }
    const chip = event.target.closest(".rc-chip");
    if (chip) {
      return actions.openSymbol(chip.dataset.symbol);
    }
    const picked = event.target.closest("[data-period]");
    if (picked) {
      period = picked.dataset.period;
      store.set("marketPeriod", period);
      return render();
    }
    if (event.target.closest("[data-full]")) {
      full = !full;
      return render();
    }
    const row = event.target.closest(".th-row, .mk-row");
    if (row) {
      open = open === row.dataset.id ? null : row.dataset.id;
      render();
    }
  });
}

