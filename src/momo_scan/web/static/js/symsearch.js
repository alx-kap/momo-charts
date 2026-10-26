import { $, api, escapeHtml, store, ticker, toast } from "./util.js";
import { actions } from "./state.js";

// TradingView-style keyboard navigation: start typing a ticker anywhere to open symbol search,
// or a number to change the timeframe ("1D", "1W", "1M", then Enter).

let results = [];
let selected = 0;
let timer = 0;
let seq = 0;
let navigated = false; // picked a row with the arrows since the last keystroke
const RECENT = 12;

const recent = () => store.get("recentSymbols", []);

export function rememberSymbol(symbol) {
  store.set("recentSymbols", [symbol, ...recent().filter((s) => s !== symbol)].slice(0, RECENT));
}

export const symbolSearchOpen = () => !$("symsearch").hidden;

export function openSymbolSearch(initial = "") {
  $("symsearch").hidden = false;
  const input = $("ss-input");
  input.value = initial;
  navigated = false;
  input.focus();
  lookup();
}

export function closeSymbolSearch() {
  $("symsearch").hidden = true;
  $("ss-input").blur();
}

async function lookup() {
  const query = $("ss-input").value.trim();
  const mine = ++seq;
  if (!query) {
    results = recent().map((symbol) => ({ symbol, ticker: ticker(symbol), name: "Recent", exchange: symbol.split(":")[0] }));
    selected = 0;
    return render();
  }
  try {
    const data = await api(`/api/symbols?q=${encodeURIComponent(query)}`);
    if (mine !== seq) return;
    results = data.symbols;
  } catch {
    results = [];
  }
  selected = 0;
  render();
}

function render() {
  const query = $("ss-input").value.trim().toUpperCase();
  $("ss-list").innerHTML = results.length ? results.map((item, n) =>
    `<div class="ss-item${n === selected ? " selected" : ""}" data-n="${n}">` +
    `<b>${escapeHtml(item.ticker)}</b><span class="ss-name">${escapeHtml(item.name)}</span>` +
    `<span class="ss-ex">${escapeHtml(item.exchange || "")}</span></div>`).join("")
    : `<div class="ss-empty">${query ? `No matches. Enter opens ${escapeHtml(query)} anyway.` : "Type a ticker or company name"}</div>`;
  const active = $("ss-list").querySelector(".selected");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function choose(n = selected) {
  const query = $("ss-input").value.trim().toUpperCase();
  const exact = results.find((item) => item.ticker === query);
  const item = exact && n === selected ? exact : results[n];
  const symbol = item ? item.symbol : query;
  closeSymbolSearch();
  if (!symbol) return;
  rememberSymbol(symbol);
  actions.openSymbol(symbol);
}

// ---------- timeframe box ----------

export const intervalBoxOpen = () => !$("interval-box").hidden;

export function openIntervalBox(initial = "") {
  $("interval-box").hidden = false;
  $("ib-input").value = initial;
  $("ib-input").focus();
}

function closeIntervalBox() {
  $("interval-box").hidden = true;
  $("ib-input").blur();
}

// TradingView's way: a bare number is minutes (60 is an hour), or D, W, M with a multiple.
const MINUTES = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h" };
function applyInterval() {
  const text = $("ib-input").value.trim().toUpperCase();
  closeIntervalBox();
  if (/^\d{1,3}$/.test(text) || /^1?H$/.test(text)) {
    const minutes = text.endsWith("H") ? 60 : Number(text);
    if (MINUTES[minutes]) return actions.setInterval(MINUTES[minutes]);
    return toast("Intraday: 1, 5, 15, 30 or 60 minutes", 2600);
  }
  const match = /^(\d{1,2})?\s*([DWM])$/.exec(text);
  if (!match || Number(match[1] || 1) < 1 || Number(match[1] || 1) > 12) {
    return toast("Minutes (1, 5, 15, 30, 60), or 1D, 1W, 1M (2W, 3M…)", 2600);
  }
  actions.setInterval(`${Number(match[1] || 1)}${match[2]}`);
}

export function bindSymbolSearch() {
  const input = $("ss-input");
  input.addEventListener("input", () => {
    navigated = false;
    clearTimeout(timer);
    timer = setTimeout(lookup, 70);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      navigated = true;
      if (results.length) selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Don't jump before the search for what was just typed comes back.
      clearTimeout(timer);
      if (navigated) choose();
      else lookup().then(() => choose());
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSymbolSearch();
    }
  });
  $("ss-list").addEventListener("mousedown", (event) => {
    const row = event.target.closest(".ss-item");
    if (!row) return;
    event.preventDefault();
    choose(Number(row.dataset.n));
  });
  $("symsearch").addEventListener("mousedown", (event) => {
    if (event.target === $("symsearch")) closeSymbolSearch();
  });
  $("ib-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); applyInterval(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeIntervalBox(); }
  });
  $("ib-input").addEventListener("blur", () => setTimeout(closeIntervalBox, 0));
}
