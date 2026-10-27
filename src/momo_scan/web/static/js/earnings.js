import { api, escapeHtml, fmtBig, fmtPct, store, ticker } from "./util.js";
import { LC } from "./chartlib.js";

const DAY = 86400000;
const at = (day) => new Date(`${day}T12:00:00Z`);
const iso = (date) => date.toISOString().slice(0, 10);
export const dayOf = (time) => typeof time === "number" ? new Date(time * 1000).toISOString().slice(0, 10) : time;
const plus = (day, n) => iso(new Date(+at(day) + n * DAY));
const calendars = new Map();

// NYSE sessions, including observed holidays. The bar archive supplies past sessions; this
// calendar counts the warning and supplies whitespace beyond its last daily bar.
function holidays(year) {
  if (calendars.has(year)) return calendars.get(year);
  const days = new Set();
  const nth = (month, weekday, n) => {
    const first = new Date(Date.UTC(year, month - 1, 1, 12));
    return iso(new Date(+first + ((weekday - first.getUTCDay() + 7) % 7 + 7 * (n - 1)) * DAY));
  };
  const fixed = (month, day, previousFriday = true) => {
    const d = new Date(Date.UTC(year, month - 1, day, 12));
    const shift = d.getUTCDay() === 0 ? 1 : d.getUTCDay() === 6 && previousFriday ? -1 : 0;
    days.add(iso(new Date(+d + shift * DAY)));
  };
  fixed(1, 1, false); // NYSE stays open on Dec 31 when Jan 1 falls on Saturday.
  days.add(nth(1, 1, 3));
  days.add(nth(2, 1, 3));
  const may = new Date(Date.UTC(year, 4, 31, 12));
  days.add(iso(new Date(+may - ((may.getUTCDay() + 6) % 7) * DAY)));
  if (year >= 2022) fixed(6, 19);
  fixed(7, 4);
  days.add(nth(9, 1, 1));
  days.add(nth(11, 4, 4));
  fixed(12, 25);
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451), n = h + l - 7 * m + 114;
  const easter = new Date(Date.UTC(year, Math.floor(n / 31) - 1, n % 31 + 1, 12));
  days.add(iso(new Date(+easter - 2 * DAY)));
  for (const day of ["2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14", "2004-06-11", "2007-01-02", "2012-10-29", "2012-10-30", "2018-12-05", "2025-01-09"]) days.add(day);
  calendars.set(year, days);
  return days;
}

export function isSession(day) {
  const date = at(day);
  return date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !holidays(date.getUTCFullYear()).has(day);
}

export function sessionsBetween(from, to) {
  let count = 0;
  for (let day = plus(from, 1); day <= to; day = plus(day, 1)) if (isSession(day)) count++;
  return count;
}

const nextSession = (day) => { do day = plus(day, 1); while (!isSession(day)); return day; };
export const previousSession = (day) => { do day = plus(day, -1); while (!isSession(day)); return day; };
const timing = (event) => ({ before_open: "Before open", after_close: "After close", unknown: "Time unknown" })[event.timing] || "Time unknown";
const stamp = (day) => at(day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const epsText = (value) => value == null ? "—" : value.toFixed(value !== 0 && Math.abs(value) < .01 ? 4 : 2);
const caches = new Map();

export const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export function loadFundamentals(symbol, asof, nextAsOf = asof) {
  const key = `${ticker(symbol)}:${asof}:${nextAsOf}`;
  const cached = caches.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.promise;
  const promise = api(`/api/fundamentals/${encodeURIComponent(symbol)}?asof=${asof}&next_asof=${nextAsOf}`)
    .catch((error) => { caches.delete(key); throw error; });
  caches.set(key, { at: Date.now(), promise });
  if (caches.size > 100) caches.delete(caches.keys().next().value);
  return promise;
}

export function accelerated(periods, index, metric) {
  const recent = periods.slice(Math.max(0, index - 2), index + 1);
  return recent.length === 3 && recent.every((p) => p[`${metric}_yoy_pct`] != null) &&
    recent[0][`${metric}_yoy_pct`] < recent[1][`${metric}_yoy_pct`] &&
    recent[1][`${metric}_yoy_pct`] < recent[2][`${metric}_yoy_pct`] &&
    recent.slice(1).every((p, i) => {
      const days = (+at(p.end) - at(recent[i].end)) / DAY;
      return days >= 65 && days < 120;
    });
}

export function fundamentalsTable(data, error = false) {
  if (error) return '<div class="dt-fund-empty">Fundamentals unavailable</div>';
  if (!data) return "";
  if (!data.quarters.length) return '<div class="dt-fund-empty">No fundamentals</div>';
  const shortPct = (v) => (v != null && Math.abs(v) >= 1000 ? `${v < 0 ? "−" : "+"}${(Math.abs(v) / 1000).toFixed(1)}k%` : fmtPct(v, 0));
  const growth = (p, metric, accel) => `<td class="${p[`${metric}_yoy_pct`] == null ? "" : p[`${metric}_yoy_pct`] >= 0 ? "up" : "down"}${accel ? " accelerating" : ""}"${accel ? ' title="Growth up two quarters running"' : ""}>${shortPct(p[`${metric}_yoy_pct`])}</td>`;
  const rows = (periods, count, annual) => periods.slice(-count).map((p, n) => {
    const index = periods.length - Math.min(periods.length, count) + n;
    const label = annual ? p.end.slice(0, 4) : at(p.end).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
    return `<tr title="${annual ? "Year" : "Quarter"} ended ${p.end}"><th>${label}</th>` +
      `<td${p.eps < 0 ? ' class="down"' : ""}>${epsText(p.eps)}</td>` + growth(p, "eps", !annual && accelerated(periods, index, "eps")) +
      `<td>${fmtBig(p.revenue)}</td>` + growth(p, "revenue", !annual && accelerated(periods, index, "revenue")) +
      `<td>${p.net_margin_pct == null ? "—" : `${p.net_margin_pct.toFixed(1)}%`}</td></tr>`;
  }).reverse().join("");
  const header = (label) => `<thead><tr><th>${label}</th><th>EPS</th><th>YoY</th><th>Sales</th><th>YoY</th><th>Margin</th></tr></thead>`;
  return `<details class="dt-fund"${store.get("fundamentalsFold", false) ? "" : " open"}>` +
    `<summary title="GAAP diluted EPS, adjusted for splits. Sales in USD. Only filings public by ${data.asof}.">Fundamentals</summary>` +
    `<table>${header("Quarter")}<tbody>${rows(data.quarters, 8, false)}</tbody></table>` +
    (data.years.length ? `<table class="fund-years">${header("Year")}<tbody>${rows(data.years, 3, true)}</tbody></table>` : "") + `</details>`;
}

function periodStart(day, interval) {
  const unit = interval.slice(-1);
  if (unit === "M") return `${day.slice(0, 7)}-01`;
  if (unit === "W") return plus(day, -((at(day).getUTCDay() + 6) % 7));
  return day;
}

export function futureTimes(bars, interval, asof, until) {
  if (!bars.length || !until || until <= asof) return [];
  while (!isSession(until)) until = plus(until, 1);
  const last = bars[bars.length - 1].time;
  const intraday = typeof last === "number";
  const result = new Set();
  const multiple = Number.parseInt(interval) || 1;
  let session = 0;
  for (let day = intraday ? asof : plus(asof, 1); day <= until; day = plus(day, 1)) {
    if (!isSession(day)) continue;
    if (intraday) {
      const minutes = multiple * (interval.endsWith("h") ? 60 : 1);
      const start = Date.parse(`${day}T09:30:00Z`) / 1000;
      for (let t = start; t < start + 390 * 60; t += minutes * 60) if (t > last) result.add(t);
    } else {
      const time = periodStart(day, interval);
      const weeks = Math.round((+at(time) - at(last)) / (7 * DAY));
      const months = (Number(time.slice(0, 4)) - Number(last.slice(0, 4))) * 12 + Number(time.slice(5, 7)) - Number(last.slice(5, 7));
      const aligned = interval.endsWith("W") ? weeks % multiple === 0
        : interval.endsWith("M") ? months % multiple === 0 : session % multiple === 0;
      if (time > last && aligned) result.add(time);
    }
    session++;
  }
  return [...result];
}

export function eventBar(event, bars, interval) {
  const day = event.reaction?.reaction_date || (event.timing === "after_close" ? nextSession(event.date) : event.date);
  if (typeof bars[0]?.time === "number") {
    return bars.find((b) => dayOf(b.time) === day && b.time % 86400 >= 9.5 * 3600)?.time ?? null;
  }
  if (interval === "1D") return bars.find((b) => b.time >= day)?.time ?? null;
  return bars.findLast((b) => b.time <= day)?.time ?? null;
}

// Growth against the same quarter a year earlier, green up and red down.
const yoy = (pct) => `<em class="${pct == null ? "" : pct >= 0 ? "up" : "down"}" title="Change from the same quarter last year">${fmtPct(pct, 1)} YoY</em>`;

function tooltip(event, data) {
  const past = event.date <= data.asof;
  const quarter = past && data.quarters.findLast((q) => q.end < event.date && (+at(event.date) - at(q.end)) / DAY <= 120);
  let html = `<b>${stamp(event.date)}${event.estimated ? " · Estimated" : ""}</b>${past ? "" : `<div class="earnings-time">${timing(event)}</div>`}`;
  if (event.estimated) html += `<div class="earnings-note">Last year's report + 52 weeks · ${stamp(event.reference_date)}</div>`;
  if (!past && event.eps_estimate != null) html += `<div class="earnings-pair"><span>EPS est.</span><b>${epsText(event.eps_estimate)}</b></div>`;
  if (quarter) {
    html += `<div class="earnings-quarter">Quarter ended ${stamp(quarter.end)}</div>` +
      `<div class="earnings-pair"><span>EPS</span><b class="${quarter.eps < 0 ? "down" : ""}">${epsText(quarter.eps)} ${yoy(quarter.eps_yoy_pct)}</b></div>` +
      `<div class="earnings-pair"><span>Sales</span><b>${fmtBig(quarter.revenue, "$")} ${yoy(quarter.revenue_yoy_pct)}</b></div>`;
  }
  return html;
}

export function createEarnings(root, chart, context) {
  const calendar = chart.addSeries(LC.LineSeries, {
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null,
  });
  const layer = Object.assign(root.appendChild(document.createElement("div")), { className: "earnings-axis" });
  const tip = Object.assign(root.appendChild(document.createElement("div")), { className: "earnings-tip", hidden: true, id: `${root.id}-earnings-tip` });
  tip.setAttribute("role", "tooltip");
  let data = null, token = 0, record = null, calendarKey = "", events = [];
  const allowed = () => context().allowed;

  function clear() {
    token++;
    data = record = null;
    layer.innerHTML = "";
    close();
    calendarKey = "";
    calendar.setData([]);
  }

  // `keep` leaves the markers up until the new ones arrive (Bar Replay moving its day).
  async function load(symbol, asof, enabled, nextAsOf = asof, keep = false) {
    if (keep) token++;
    else clear();
    if (!enabled || !asof) return;
    const request = token;
    try {
      const next = await loadFundamentals(symbol, asof, nextAsOf);
      if (request === token && allowed()) { data = next; record = { symbol, asof, data }; }
    } catch {
      if (request === token && allowed()) record = { symbol, asof, data: null, error: true };
    }
  }

  function render() {
    const ctx = context();
    const on = ctx.allowed && ctx.enabled && data?.quarters.length && ctx.bars.length;
    const next = on && data.next_earnings;
    const future = next ? futureTimes(ctx.bars, ctx.interval, data.asof, next.date) : [];
    const key = `${ctx.interval}:${future[0]}:${future.at(-1)}:${future.length}`;
    if (key !== calendarKey) {
      calendarKey = key;
      const range = chart.timeScale().getVisibleLogicalRange();
      calendar.setData(future.map((time) => ({ time })));
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    }
    layer.hidden = !on;
    if (!on) { layer.innerHTML = ""; close(); return 0; }
    events = data.events.filter((e) => e.date <= data.asof);
    if (next) events.push(next);
    layer.style.top = `${ctx.box.top + ctx.box.height - 22}px`;
    layer.style.width = `${ctx.plotWidth}px`;
    layer.innerHTML = events.map((event, i) => {
      const time = event.date > data.asof
        ? eventBar({ ...event, reaction: null, timing: "unknown" }, [...ctx.bars, ...future.map((time) => ({ time }))], ctx.interval)
        : eventBar(event, ctx.bars, ctx.interval);
      const x = time == null ? null : chart.timeScale().timeToCoordinate(time);
      if (x == null || x < 9 || x > ctx.plotWidth - 9) return "";
      const change = event.reaction?.day_pct;
      const tone = change > 0 ? "positive" : change < 0 ? "negative" : "";
      return `<button class="earnings-marker ${tone}${event.date > data.asof ? " future" : ""}${event.estimated ? " estimated" : ""}" ` +
        `style="left:${x}px" data-event="${i}" data-date="${event.date}" aria-label="Earnings ${event.date}${event.estimated ? ', estimated' : ''}" aria-describedby="${tip.id}">E</button>`;
    }).join("");
    if (shown) {
      layer.querySelector(`.earnings-marker[data-date="${shown}"]`)?.classList.add("open");
      place();
    }
    return future.length;
  }

  function pill() {
    const ctx = context();
    const next = ctx.allowed && ctx.enabled && data?.next_earnings;
    if (!next) return "";
    const days = sessionsBetween(data.next_asof || data.asof, next.date);
    const title = `${days} trading sessions · ${stamp(next.date)} · ${timing(next)}${next.estimated ? ` · Estimated from ${stamp(next.reference_date)} + 52 weeks` : ""}`;
    return `<span class="earnings-pill ${days <= 3 ? "imminent" : days <= 10 ? "soon" : ""}" title="${escapeHtml(title)}">E ${next.estimated ? "~" : ""}${days}d</span>`;
  }

  // Click a marker for its card (it fades in); click it again, anywhere else, or Esc to close.
  // The card follows its marker as the chart pans and closes when the marker scrolls away.
  let shown = null; // the open card's event date
  function place() {
    const button = shown && layer.querySelector(`.earnings-marker[data-date="${shown}"]`);
    if (!button) { close(); return; }
    const rect = button.getBoundingClientRect(), box = root.getBoundingClientRect();
    tip.style.left = `${Math.max(6, Math.min(root.clientWidth - tip.offsetWidth - 6, rect.left - box.left - tip.offsetWidth / 2 + 9))}px`;
    tip.style.top = `${Math.max(6, rect.top - box.top - tip.offsetHeight - 8)}px`;
  }
  function open(button) {
    shown = button.dataset.date;
    tip.innerHTML = tooltip(events[Number(button.dataset.event)], data);
    tip.classList.remove("show");
    tip.hidden = false;
    layer.querySelectorAll(".earnings-marker.open").forEach((b) => b.classList.remove("open"));
    button.classList.add("open");
    place();
    requestAnimationFrame(() => tip.classList.add("show"));
  }
  function close() {
    shown = null;
    tip.hidden = true;
    tip.classList.remove("show");
    layer.querySelectorAll(".earnings-marker.open").forEach((b) => b.classList.remove("open"));
  }
  layer.addEventListener("click", (event) => {
    const button = event.target.closest(".earnings-marker");
    if (!button || !data) return;
    if (shown === button.dataset.date) close();
    else open(button);
  });
  layer.addEventListener("pointerdown", (event) => event.stopPropagation()); // not a chart click
  document.addEventListener("pointerdown", (event) => {
    if (shown && !layer.contains(event.target) && !tip.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (shown && event.key === "Escape") { close(); event.stopPropagation(); }
  }, true);
  return { load, clear, render, pill, record: () => record };
}
