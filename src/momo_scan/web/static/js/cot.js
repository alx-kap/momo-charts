import { $, api, escapeHtml, store } from "./util.js";

// The Positioning tab of the Market window: CFTC Commitments of Traders. The overview shows
// where each trader group stands against its own last three years; a row opens the history.
const WHO = {
  spec: "Large speculators: hedge funds and CTAs. They chase trends.",
  comm: "Commercials: producers and users who hedge. Usually fade the trend.",
  small: "Small speculators: traders too small to report. Mostly retail.",
};
const COLOR = { spec: "#6f93e6", comm: "#d9706f", small: "#e8c547" };
const RANGES = [["1Y", 52], ["3Y", 156], ["5Y", 260], ["All", 1e9]];

let overview = null;
let code = null; // the market open in detail, else the overview
let range = store.get("cotRange", "5Y");
let primary = store.get("cotLegacyGroup", "spec");
const histories = {};

const signed = (v, digits = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
const side = (v) => (v >= 0 ? "long" : "short");
const extreme = (pct) => (pct >= 90 ? "long" : pct <= 10 ? "short" : "");
const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
const label = (key) => overview.groups.find(([k]) => k === key)[1];

// Called when the tab opens: the numbers come from the server's local store, so reloading is free.
export function forgetPositioning() {
  overview = null;
  code = null;
  for (const key of Object.keys(histories)) delete histories[key];
}

export async function renderPositioning(body, sub) {
  if (!overview) {
    body.innerHTML = `<div class="rc-loading muted">Reading the CFTC report…</div>`;
    try {
      overview = await api("/api/cot");
    } catch (error) {
      body.innerHTML = `<div class="rc-loading muted">Couldn't load positioning: ${escapeHtml(error.message)}</div>`;
      return;
    }
  }
  if (code) return renderDetail(body, sub);
  sub.textContent = `Commitments of Traders · futures, as of ${overview.as_of} (published Fridays)`;
  const families = [...new Set(overview.markets.map((m) => m.family))];
  body.innerHTML =
    `<p class="cot-hint">Dot: net position against its own last 3 years. A glow marks the extreme 10%. Click a market for its history.</p>` +
    `<div class="cot-head"><span></span>` +
    overview.groups.map(([key, name]) => `<span title="${WHO[key]}"><i style="background:${COLOR[key]}"></i>${name}</span>`).join("") +
    `</div>` +
    families.map((family) =>
      `<div class="cot-family">${family}</div>` +
      overview.markets.filter((m) => m.family === family).map(row).join("")).join("");
}

function row(market) {
  return `<div class="cot-row" data-cot-open="${market.code}"><div class="cot-name"><b>${market.symbol}</b><span>${market.name}</span></div>` +
    overview.groups.map(([key]) => cell(market.groups[key])).join("") + `<b class="cot-go">›</b></div>`;
}

function cell(g) {
  const hot = extreme(g.pct);
  return `<div class="cot-cell${hot ? ` hot ${hot}` : ""}">` +
    `<div class="cot-val"><b class="${side(g.net)}">${signed(g.net)}</b>` +
    `<span class="${g.change > 0 ? "up" : g.change < 0 ? "down" : ""}" title="Change on last week">${g.change > 0 ? "▲" : g.change < 0 ? "▼" : "·"} ${Math.abs(g.change).toFixed(1)}</span></div>` +
    `<div class="cot-track" title="${ordinal(g.pct)} percentile of three years (${signed(g.lo)} to ${signed(g.hi)})">` +
    `<i class="lo"></i><i class="hi"></i><u style="left:${g.pct}%"></u></div></div>`;
}

const contracts = (v) => (v < 0 ? `(${Math.abs(v).toLocaleString()})` : v.toLocaleString());
const compact = (v) => {
  const k = Math.abs(v) >= 1e6 ? `${+(Math.abs(v) / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${+(Math.abs(v) / 1e3).toFixed(0)}K` : `${Math.abs(v)}`;
  return v < 0 ? `(${k})` : v === 0 ? "0" : k;
};
const BANDS = [["y3", "3yr range", 156], ["y1", "1yr range", 52]];
let bands = store.get("cotBands", { y3: true, y1: false });

async function renderDetail(body, sub) {
  const market = overview.markets.find((m) => m.code === code);
  sub.textContent = `Commitments of Traders · ${market.name} · as of ${market.date}`;
  if (!histories[code]) {
    body.innerHTML = `<div class="rc-loading muted">Reading ${escapeHtml(market.name)}…</div>`;
    try {
      histories[code] = await api(`/api/cot/${code}`);
    } catch (error) {
      body.innerHTML = `<div class="rc-loading muted">Couldn't load ${escapeHtml(market.name)}: ${escapeHtml(error.message)}</div>`;
      return;
    }
  }
  const data = histories[code];
  const total = data.dates.length;
  const weeks = Math.min(RANGES.find(([name]) => name === range)[1], total);
  const from = total - weeks;
  const keys = overview.groups.map(([k]) => k);
  // Trailing high and low of the group in focus, measured on the full history so the first bars have a band too.
  const full = data.longs[primary].map((l, i) => l - data.shorts[primary][i]);
  const envelope = (span) => Array.from({ length: weeks }, (_, i) => {
    const slice = full.slice(Math.max(0, from + i - span + 1), from + i + 1);
    return [Math.min(...slice), Math.max(...slice)];
  });
  const view = {
    dates: data.dates.slice(from),
    oi: data.oi.slice(from),
    net: Object.fromEntries(keys.map((k) => [k, data.longs[k].slice(from).map((l, i) => l - data.shorts[k][from + i])])),
    pct: Object.fromEntries(keys.map((k) => [k, data.series[k].slice(from)])),
    env: Object.fromEntries(BANDS.map(([id, , span]) => [id, envelope(span)])),
  };
  const mine = view.pct[primary];
  const now = mine.at(-1);
  const rank = Math.round(100 * (mine.filter((v) => v < now).length + 0.5 * mine.filter((v) => v === now).length) / mine.length);
  const span = weeks === total && range === "All" ? "all of history" : `the last ${range === "1Y" ? "year" : `${range.slice(0, -1)} years`}`;
  const verdict = rank >= 99 ? `its highest reading in ${span}` : rank <= 1 ? `its lowest reading in ${span}`
    : now >= 0
      ? (rank >= 50 ? `more long than ${rank}% of weeks over ${span}` : `less long than ${100 - rank}% of weeks over ${span}`)
      : (rank <= 50 ? `more short than ${100 - rank}% of weeks over ${span}` : `less short than ${rank}% of weeks over ${span}`);
  const lastNet = (k) => view.net[k].at(-1);

  body.innerHTML =
    `<div class="cot-bar"><button class="mini" data-cot-back>← All markets</button><b>${market.name} <em>${market.symbol}</em></b>` +
    `<span class="spacer"></span><span class="muted cot-weeks">${weeks} weeks</span>` +
    BANDS.map(([id, name]) => `<label class="toggle"><input type="checkbox" data-cot-band="${id}"${bands[id] ? " checked" : ""}><span>${name}</span></label>`).join("") +
    `<div class="seg">` + RANGES.map(([name]) => `<button data-cot-range="${name}" class="${name === range ? "active" : ""}">${name}</button>`).join("") +
    `</div></div>` +
    `<div class="cot-legend">` + overview.groups.map(([key, name]) =>
      `<button data-cot-group="${key}" class="${key === primary ? "active" : ""}" title="${WHO[key]}">` +
      `<i style="background:${COLOR[key]}"></i>${name}<b class="${side(lastNet(key))}">${contracts(lastNet(key))}</b></button>`).join("") +
    `</div>` +
    `<p class="cot-read"><b>${label(primary)}</b> are net <b class="${side(now)}">${side(now)} ${Math.abs(lastNet(primary)).toLocaleString()} contracts</b> ` +
    `(${Math.abs(now).toFixed(1)}% of open interest), ${verdict}.</p>` +
    `<div class="cot-chart" id="cot-chart">${chart(view)}<div class="cot-tip" hidden></div></div>`;
  bindHover(view);
}

const W = 600; // about the pane width, so the chart text stays its size
const PAD = { l: 52, r: 12, t: 10 };
const H1 = 260; // net positions
const H2 = 80;  // open interest
const GAP = 34;

// The chart's scales: x gives each week a slot, y fits every group's net plus the band behind it.
function scales(view) {
  const n = view.dates.length;
  const envs = BANDS.filter(([id]) => bands[id]).flatMap(([id]) => view.env[id].flat());
  const all = [...Object.values(view.net).flat(), ...envs, 0];
  const bound = Math.max(...all.map(Math.abs)) * 1.06 || 1;
  const slot = (W - PAD.l - PAD.r) / n;
  const x = (i) => PAD.l + (i + 0.5) * slot;
  const y = (v) => PAD.t + ((bound - v) * (H1 - PAD.t - 6)) / (2 * bound);
  return { n, bound, slot, x, y };
}

function chart(view) {
  const { n, bound, slot, x, y } = scales(view);
  const step = [1e3, 2e3, 5e3, 1e4, 2e4, 2.5e4, 5e4, 1e5, 2e5, 5e5, 1e6].find((s) => (2 * bound) / s <= 6) || 1e6;
  let grid = "";
  for (let v = -Math.floor(bound / step) * step; v <= bound; v += step) {
    grid += `<line class="${v === 0 ? "zero" : "grid"}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/>` +
      `<text class="axis" x="${PAD.l - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  // Stepped band between the trailing high and low of the group in focus.
  const band = (env) => {
    const edge = (pick) => env.map((e, i) => `${(PAD.l + i * slot).toFixed(1)},${y(e[pick]).toFixed(1)} ${(PAD.l + (i + 1) * slot).toFixed(1)},${y(e[pick]).toFixed(1)}`);
    return `${edge(1).join(" ")} ${edge(0).reverse().map((pt) => pt.split(" ").reverse().join(" ")).join(" ")}`;
  };
  const bands_ = BANDS.filter(([id]) => bands[id]).map(([id]) => `<polygon class="band ${id}" points="${band(view.env[id])}"/>`).join("");

  const keys = overview.groups.map(([k]) => k);
  const bw = Math.max(0.8, (slot * 0.9) / keys.length);
  const zero = y(0);
  const bars = keys.map((k, j) => view.net[k].map((v, i) => {
    const top = Math.min(y(v), zero);
    return `<rect class="bar${k === primary ? " on" : ""}" fill="${COLOR[k]}" x="${(PAD.l + i * slot + slot * 0.05 + j * bw).toFixed(1)}" ` +
      `y="${top.toFixed(1)}" width="${(bw * 0.82).toFixed(2)}" height="${Math.max(0.5, Math.abs(y(v) - zero)).toFixed(1)}"/>`;
  }).join("")).join("");

  // Open interest below.
  const top2 = H1 + GAP;
  const oiMax = Math.max(...view.oi) * 1.05;
  const oy = (v) => top2 + H2 - (v / oiMax) * H2;
  let oiGrid = "";
  const oiStep = [1e3, 5e3, 1e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 2e6, 5e6].find((s) => oiMax / s <= 4) || 1e7;
  for (let v = 0; v <= oiMax; v += oiStep) {
    oiGrid += `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${oy(v)}" y2="${oy(v)}"/><text class="axis" x="${PAD.l - 8}" y="${oy(v) + 4}" text-anchor="end">${v ? compact(v) : "0"}</text>`;
  }
  const oiBars = view.oi.map((v, i) =>
    `<rect class="oi" x="${(PAD.l + i * slot + slot * 0.1).toFixed(1)}" y="${oy(v).toFixed(1)}" width="${Math.max(0.8, slot * 0.8).toFixed(2)}" height="${(top2 + H2 - oy(v)).toFixed(1)}"/>`).join("");

  // Date ticks: years on long ranges, months on short ones.
  let ticks = "";
  let last = "";
  const long = n >= 100;
  view.dates.forEach((d, i) => {
    const key = long ? d.slice(0, 4) : d.slice(0, 7);
    if (key !== last && i > 2 && i < n - 6 && (long || Number(d.slice(5, 7)) % 3 === 1)) {
      ticks += `<text class="axis" x="${x(i)}" y="${top2 + H2 + 18}" text-anchor="middle">${key}</text>`;
    }
    last = key;
  });
  return `<svg viewBox="0 0 ${W} ${top2 + H2 + 26}" width="100%" id="cot-svg">` + grid + bands_ + bars +
    `<text class="axis sub" x="${PAD.l}" y="${top2 - 10}">OPEN INTEREST</text>` + oiGrid + oiBars + ticks +
    `<g id="cot-hover" hidden><line class="cross" y1="${PAD.t}" y2="${top2 + H2}"/></g>` +
    `<rect id="cot-hit" x="${PAD.l}" y="0" width="${W - PAD.l - PAD.r}" height="${top2 + H2}" fill="transparent"/></svg>`;
}

function bindHover(view) {
  const box = $("cot-chart");
  const svg = $("cot-svg");
  const hover = $("cot-hover");
  const tip = box.querySelector(".cot-tip");
  const { n, x, slot } = scales(view);
  svg.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = W / rect.width;
    const px = (event.clientX - rect.left) * scale;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - PAD.l) / slot)));
    const cx = x(i);
    hover.removeAttribute("hidden");
    hover.querySelector(".cross").setAttribute("x1", cx);
    hover.querySelector(".cross").setAttribute("x2", cx);
    tip.hidden = false;
    tip.innerHTML = `<div class="cot-tip-date">${view.dates[i]}</div>` +
      overview.groups.map(([k, name]) => {
        const v = view.net[k][i];
        return `<div class="${k === primary ? "on" : ""}"><i style="background:${COLOR[k]}"></i>${name}<b class="${side(v)}">${contracts(v)}</b></div>`;
      }).join("") + `<div><i style="background:#4d7a52"></i>Open interest<b>${view.oi[i].toLocaleString()}</b></div>`;
    const left = cx / scale;
    tip.style.left = `${left > rect.width * 0.62 ? left - tip.offsetWidth - 14 : left + 14}px`;
  });
  svg.addEventListener("mouseleave", () => {
    hover.setAttribute("hidden", "");
    tip.hidden = true;
  });
}

// Clicks inside the tab. Returns true when it handled the click.
export function positioningClick(event, body, sub) {
  const open = event.target.closest("[data-cot-open]");
  const back = event.target.closest("[data-cot-back]");
  const pick = event.target.closest("[data-cot-range]");
  const group = event.target.closest("[data-cot-group]");
  const band = event.target.closest("[data-cot-band]");
  if (open) code = open.dataset.cotOpen;
  else if (back) code = null;
  else if (pick) { range = pick.dataset.cotRange; store.set("cotRange", range); }
  else if (group) { primary = group.dataset.cotGroup; store.set("cotLegacyGroup", primary); }
  else if (band) { bands[band.dataset.cotBand] = band.checked; store.set("cotBands", bands); }
  else return false;
  renderPositioning(body, sub);
  return true;
}
