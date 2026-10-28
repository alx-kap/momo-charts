import { FUNDAMENTAL_KEYS, FUNDAMENTAL_LABELS, ensureSummaries, fundamentalText, summaryOf } from "./fundamental-columns.js";
import { $, api, escapeHtml, fmtBig, fmtPct, fmtPrice, store, ticker, toast } from "./util.js";
import { actions, state } from "./state.js";
import { columnItems, openMenu, wantsMenu } from "./contextmenu.js";
import { confirmDialog, promptDialog } from "./dialog.js";
import { CHART_BARS, series, showLive, warmSymbol } from "./feed.js";
import { bindColumns, gripHtml, moved } from "./columns.js";
import { askSymbolsPanel, pickAddTo, pickWatchlist } from "./listpicker.js";
import { fundamentalsTable } from "./earnings.js";
import {
  buzzLabel, buzzSession, buzzText, buzzTitle, extendedQuote, extendedVolume, flashCell,
  onLiveBuzz, onLiveQuotes, onSessionChange, sessionDone, watchBuzz, watchLive,
} from "./live.js";

// Chart mode's right column: the user's own watchlists (several, like TradingView) and a
// details panel for the symbol on the chart. Lists are saved to the server.

// Flagged is built in, like TC2000 and TradingView: Shift+F flags whatever is on the chart.
const FLAGGED = "flagged";
const DEFAULT = {
  version: 1, active: "main",
  lists: [{ id: "main", name: "Watchlist", symbols: ["SPY", "QQQ"] }],
};
export const FLAG_SVG = `<svg class="flag" viewBox="0 0 10 12" width="9" height="11" aria-hidden="true"><path d="M1 0.5v11" stroke="currentColor" stroke-width="1.3"/><path d="M1.6 1h7.4l-2 2.6 2 2.6H1.6z" fill="currentColor"/></svg>`;
let data = normalise(store.get("watchlists", null));
const quotes = new Map();
const buzzes = new Map(); // ticker -> Volume Buzz
const buzzOf = (q) => buzzes.get(ticker(q.symbol));
let latestDeck = null; // every candidate in the newest scan, to flag scanned symbols

function normalise(value) {
  if (!value || !Array.isArray(value.lists) || !value.lists.length) value = structuredClone(DEFAULT);
  if (!value.lists.some((list) => list.id === FLAGGED)) value.lists.push({ id: FLAGGED, name: "Flagged", symbols: [] });
  if (!value.lists.some((list) => list.id === value.active)) value.active = value.lists[0].id;
  if ((value.version || 1) < 2) {
    if (value.columns && !value.columns.includes("earnings_days")) value.columns.push("earnings_days");
    value.version = 2;
  }
  return value;
}

const activeList = () => data.lists.find((list) => list.id === data.active);
// The row last opened from the list keeps its highlight when the chart moves elsewhere (a typed
// symbol, the screener); the chart's own symbol, if it's in the list, is outlined instead.
let picked = null;

// Sections are "###Name" entries, TradingView's own watchlist format.
const SECTION = "###";
const isSection = (entry) => entry.startsWith(SECTION);
const symbolsOf = (list) => list.symbols.filter((entry) => !isSection(entry));

// Columns you can show, TradingView-style. Click a header to sort by it. `price`: a live change
// flashes green or red with the move; the others (changes, volume) just flash bold.
const COLUMNS = {
  last: { label: "Last", width: "64px", price: true, value: (q) => q.last, text: (q) => fmtPrice(q.last) },
  chg: { label: "Chg", width: "56px", value: (q) => q.change, text: (q) => `${q.change >= 0 ? "+" : ""}${fmtPrice(q.change)}`, signed: true },
  chgPct: { label: "Chg%", width: "58px", value: (q) => q.change_pct, text: (q) => fmtPct(q.change_pct), signed: true },
  adr: { label: "ADR%", width: "50px", value: (q) => q.adr20, text: (q) => (q.adr20 == null ? "—" : `${q.adr20.toFixed(1)}%`) },
  dvol: { label: "$ Vol", width: "60px", value: (q) => q.volume * q.last, text: (q) => fmtBig(q.volume * q.last, "$") },
  vol: { label: "Vol", width: "56px", value: (q) => q.volume, text: (q) => fmtBig(q.volume) },
  // Pre- and post-market (live prices only): blank in the regular session.
  ext: { label: "Ext", live: true, width: "60px", title: "Pre- or post-market price", value: (q) => extendedQuote(q)?.price, text: (q) => (extendedQuote(q) ? fmtPrice(extendedQuote(q).price) : "—") },
  extPct: { label: "Ext%", live: true, width: "56px", title: "Pre- or post-market move from the regular session's last price", value: (q) => extendedQuote(q)?.pct, text: (q) => {
    const ext = extendedQuote(q);
    return ext ? `<span class="${ext.pct >= 0 ? "up" : "down"}">${fmtPct(ext.pct)}</span>` : "—";
  } },
  extVol: { label: "Ext Vol", live: true, width: "60px", title: "Pre- or post-market volume so far", value: (q) => extendedVolume(q, buzzOf(q)), text: (q) => {
    const volume = extendedVolume(q, buzzOf(q));
    return volume == null ? "—" : fmtBig(volume);
  } },
  buzz: { label: "Buzz", live: true, width: "62px", title: buzzTitle, value: (q) => buzzOf(q)?.pct, text: (q) => {
    const buzz = buzzOf(q);
    return buzz ? `<span class="${buzz.pct >= 0 ? "up" : "down"}">${buzzText(buzz)}</span>` : "—";
  } },
  industry: { label: "Industry", width: "130px", left: true, value: (q) => q.industry || "", text: (q) => escapeHtml(q.industry || "—") },
};
FUNDAMENTAL_KEYS.forEach((key, i) => {
  COLUMNS[key] = { label: FUNDAMENTAL_LABELS[i], width: "66px",
    value: (q) => summaryOf(q.symbol)?.[key], text: (q) => fundamentalText(summaryOf(q.symbol), key) };
});
const DEFAULT_COLUMNS = ["last", "chg", "chgPct", "earnings_days"];
// Live columns (extended hours, Buzz) only for accounts with live prices.
const offered = (key) => COLUMNS[key] && (!COLUMNS[key].live || Boolean(state.me && state.me.live));
const columns = () => (data.columns || DEFAULT_COLUMNS).filter(offered);
// Widths you've dragged win over the defaults; double-click a grip to forget one.
const widthOf = (key) => Math.max(44, (data.widths && data.widths[key]) || (key === "symbol" ? 84 : parseInt(COLUMNS[key].width, 10)));
// Columns keep their widths from the left (squeezing together only when the sidebar is too
// narrow); the last one stretches to the remove button, so it has no grip of its own.
const track = (key) => `minmax(44px, ${widthOf(key)}px)`;
const stretch = (key) => `minmax(${widthOf(key)}px, 1fr)`;
const gridOf = () => {
  const keys = ["symbol", ...columns()];
  return `16px ${keys.map((key, i) => (i === keys.length - 1 ? stretch(key) : track(key))).join(" ")} 16px`;
};

// The list as shown: sections in order, each sorted by the list's sort column.
function groups(list) {
  const out = [{ name: null, symbols: [] }];
  for (const entry of list.symbols) {
    if (isSection(entry)) out.push({ name: entry.slice(SECTION.length), symbols: [] });
    else out[out.length - 1].symbols.push(entry);
  }
  const sort = list.sort;
  if (sort) {
    const key = (symbol) => {
      if (sort.key === "symbol") return ticker(symbol);
      const quote = quotes.get(symbol);
      return quote ? COLUMNS[sort.key].value(quote) : null;
    };
    for (const group of out) {
      group.symbols = [...group.symbols].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // blanks last
        const order = typeof x === "string" ? x.localeCompare(y) : x - y;
        return sort.dir === "asc" ? order : -order;
      });
    }
  }
  return out.filter((group) => group.name !== null || group.symbols.length);
}

// What ↑/↓ walk through: visible rows in on-screen order.
function shownSymbols(list) {
  const collapsed = new Set(list.collapsed || []);
  return groups(list).flatMap((group) => (collapsed.has(group.name) ? [] : group.symbols));
}
const flaggedList = () => data.lists.find((list) => list.id === FLAGGED);

export const isFlagged = (symbol) => Boolean(symbol) && flaggedList().symbols.some((item) => ticker(item) === ticker(symbol));

export function toggleFlag(symbol) {
  if (!symbol) return;
  const list = flaggedList();
  const flagged = isFlagged(symbol);
  list.symbols = flagged
    ? list.symbols.filter((item) => ticker(item) !== ticker(symbol))
    : [...list.symbols, symbol];
  save();
  renderWatchlists();
  actions.flagsChanged();
  toast(flagged ? `Unflagged ${ticker(symbol)}` : `Flagged ${ticker(symbol)}`);
}

let saveTimer = 0;
function save() {
  data.savedAt = new Date().toISOString();
  store.set("watchlists", data);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api("/api/settings/watchlists", { method: "PUT", body: JSON.stringify(data) })
      .catch((error) => toast(`Couldn't save watchlists: ${error.message}`));
  }, 400);
}

export async function syncWatchlists() {
  try {
    const { value } = await api("/api/settings/watchlists");
    if (value && (value.savedAt || "") > (data.savedAt || "")) {
      data = normalise(value);
      store.set("watchlists", data);
    } else if (!value) {
      save();
    }
  } catch {}
  renderWatchlists();
  if (actions.flagsChanged) actions.flagsChanged();
}

async function loadQuotes(symbols) {
  const missing = symbols.filter((symbol) => !quotes.has(symbol));
  if (!missing.length) return;
  try {
    const { quotes: found } = await api(`/api/quotes?symbols=${encodeURIComponent(missing.join(","))}`);
    for (const symbol of missing) quotes.set(symbol, found[symbol] || null);
  } catch {
    return;
  }
  renderRows();
}

// ---------- rendering ----------

// Open the switcher (Shift+W, or the list button): pick a list, or start rename / delete / new / import.
export async function openWatchlistPicker() {
  const chosen = await pickWatchlist({
    state: () => ({
      lists: data.lists.map((list) => ({ id: list.id, name: list.name, count: symbolsOf(list).length, flagged: list.id === FLAGGED })),
      active: data.active,
    }),
    recent: data.recent || [],
    rename: (id, name) => {
      data.lists.find((list) => list.id === id).name = name;
      save();
      renderWatchlists();
    },
    duplicate: (id) => {
      const at = data.lists.findIndex((list) => list.id === id);
      const copy = { id: `l${Date.now().toString(36)}`, name: `${data.lists[at].name} copy`, symbols: [...data.lists[at].symbols] };
      if (data.lists[at].collapsed) copy.collapsed = [...data.lists[at].collapsed];
      data.lists.splice(at + 1, 0, copy);
      save();
      renderWatchlists();
    },
    remove: async (id) => {
      const list = data.lists.find((item) => item.id === id);
      if (data.lists.length === 1) return toast("Keep at least one list");
      const sure = await confirmDialog({
        title: `Delete “${list.name}”?`, message: `The list and its ${symbolsOf(list).length} symbols are removed.`, ok: "Delete list", danger: true,
      });
      if (!sure) return;
      data.lists = data.lists.filter((item) => item.id !== id);
      if (data.active === id) data.active = data.lists[0].id;
      save();
      renderWatchlists();
    },
  });
  if (!chosen) return;
  if (chosen.id) switchList(chosen.id);
  if (chosen.action) menu(chosen.action);
}

function switchList(id) {
  if (id === data.active) return;
  data.recent = [id, data.active, ...(data.recent || [])].filter((each, i, all) => all.indexOf(each) === i).slice(0, 8);
  data.active = id;
  picked = null;
  save();
  renderWatchlists();
}

// The list button's dropdown: a few recent lists to jump between, and "Open list…" for all of them.
function openWatchlistDropdown(event) {
  const box = event.currentTarget.getBoundingClientRect();
  const byId = new Map(data.lists.map((list) => [list.id, list]));
  const ids = [...new Set([data.active, ...(data.recent || []), ...data.lists.map((list) => list.id)])].filter((id) => byId.has(id)).slice(0, 5);
  const flags = data.active === FLAGGED;
  openMenu({ clientX: box.left, clientY: box.bottom + 4, preventDefault() {} }, [
    { heading: "Recently used" },
    ...ids.map((id) => ({ label: `${byId.get(id).name} · ${symbolsOf(byId.get(id)).length}`, checked: id === data.active, run: () => switchList(id) })),
    { label: "Open list…", hint: "⇧W", run: openWatchlistPicker },
    "-",
    { label: "New list…", run: () => menu("new") },
    !flags && { label: "Rename list…", run: () => menu("rename") },
    { label: "Import from TradingView…", run: () => menu("import") },
    "-",
    { label: flags ? "Clear all flags…" : "Delete list…", danger: true, run: () => menu("delete") },
  ]);
}

export function renderWatchlists() {
  const current = activeList();
  $("wl-select").innerHTML = `<span>${escapeHtml(current.name)} · ${symbolsOf(current).length}</span><i aria-hidden="true">▾</i>`;
  renderRows();
  loadQuotes(symbolsOf(activeList()));
}

function renderHeader(list) {
  const keys = ["symbol", ...columns()];
  const sort = list.sort || {};
  const arrow = (key) => (sort.key === key ? `<i class="sort-arrow">${sort.dir === "asc" ? "▲" : "▼"}</i>` : "");
  $("wl-cols").innerHTML =
    `<span class="fl" title="Flag: click a row's flag to mark it">${FLAG_SVG}</span>` +
    `<span data-sort="symbol" data-col="symbol">Symbol${arrow("symbol")}${keys.length > 1 ? gripHtml(false) : ""}</span>` +
    columns().map((key) => `<span data-sort="${key}" data-col="${key}" draggable="true"${COLUMNS[key].title ? ` title="${escapeHtml(COLUMNS[key].title)}"` : ""}>${key === "buzz" ? buzzLabel({ session: buzzSession() }) : COLUMNS[key].label}${arrow(key)}${key === keys[keys.length - 1] ? "" : gripHtml(false)}</span>`).join("") +
    `<span></span>`;
  $("side-home").style.setProperty("--wl-grid", gridOf());
}

// Click a header: descending first for numbers (A–Z for symbols), then flipped, then off.
function cycleSort(key) {
  const list = activeList();
  const first = key === "symbol" || COLUMNS[key]?.left ? "asc" : "desc";
  const sort = list.sort;
  if (!sort || sort.key !== key) list.sort = { key, dir: first };
  else if (sort.dir === first) list.sort = { key, dir: first === "asc" ? "desc" : "asc" };
  else delete list.sort;
  save();
  renderRows();
}

// The first column of a list: click to flag or unflag. Shared by the screener.
export const flagCell = (symbol) =>
  `<button class="flag-cell${isFlagged(symbol) ? " on" : ""}" data-flag="${escapeHtml(symbol)}" title="${isFlagged(symbol) ? "Unflag" : "Flag"} ${escapeHtml(ticker(symbol))}">${FLAG_SVG}</button>`;

function rowHtml(symbol, current, mine) {
  const quote = quotes.get(symbol);
  const cls = quote ? (quote.change >= 0 ? "up" : "down") : "";
  const scanned = latestDeck && latestDeck.has(ticker(symbol));
  const mark = ticker(symbol) === mine ? " active" : ticker(symbol) === current ? " found" : "";
  return `<div class="hw-row${mark}" data-symbol="${escapeHtml(symbol)}" draggable="true">` +
    flagCell(symbol) +
    `<span class="sym">${escapeHtml(ticker(symbol))}${scanned ? `<i class="in-scan" title="In the latest scan"></i>` : ""}</span>` +
    columns().map((key) => {
      const col = COLUMNS[key];
      return `<span class="num ${col.signed ? cls : ""}${col.left ? " l" : ""}"${col.left && quote?.industry ? ` title="${escapeHtml(quote.industry)}"` : ""}>${quote ? col.text(quote) : key === "last" ? "—" : ""}</span>`;
    }).join("") +
    `<button class="hw-x" data-remove="${escapeHtml(symbol)}" title="Remove from list">×</button></div>`;
}

function renderRows() {
  if (columns().some((key) => FUNDAMENTAL_KEYS.includes(key))) {
    ensureSummaries(symbolsOf(activeList()), null, renderRows);
  }
  const list = activeList();
  watchLive("watchlist", symbolsOf(list));
  // Buzz needs the symbols' minute bars (Ext Vol too, after the close): only when shown.
  const buzz = columns().includes("buzz") || columns().includes("extVol");
  watchBuzz("watchlist", buzz ? symbolsOf(list) : []);
  const current = ticker(state.home.symbol);
  const listed = new Set(symbolsOf(list).map(ticker));
  if (!picked || !listed.has(picked)) picked = listed.has(current) ? current : null;
  const collapsed = new Set(list.collapsed || []);
  renderHeader(list);
  $("wl-rows").innerHTML = list.symbols.length ? groups(list).map((group) =>
    (group.name === null ? "" :
      `<div class="hw-sec${collapsed.has(group.name) ? " collapsed" : ""}" data-section="${escapeHtml(group.name)}" draggable="true" title="${collapsed.has(group.name) ? "Click to expand" : "Click to collapse"}">` +
      `<i class="caret"><svg viewBox="0 0 12 12"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg></i><span>${escapeHtml(group.name)}</span><em>${group.symbols.length}${collapsed.has(group.name) && group.symbols.length ? " hidden" : ""}</em>` +
      `<button class="hw-x" data-remove-section="${escapeHtml(group.name)}" title="Remove section (keeps its symbols)">×</button></div>`) +
    (collapsed.has(group.name) ? "" : group.symbols.map((symbol) => rowHtml(symbol, current, picked)).join(""))).join("")
    : "";
  const shown = $("wl-rows").querySelector(".found") || $("wl-rows").querySelector(".active");
  if (shown) shown.scrollIntoView({ block: "nearest" });
}

// Live prices update the rows' numbers in place: no re-sort, no lost scroll or hover.
onLiveQuotes((live) => {
  for (const symbol of symbolsOf(activeList())) {
    const update = live.get(ticker(symbol));
    const quote = quotes.get(symbol);
    if (!update || !quote) continue;
    const base = update.prev_close ?? (update.day === quote.date ? quote.last - quote.change : quote.last);
    const direction = Math.sign(update.last - quote.last);
    const extDirection = update.trade && quote.trade ? Math.sign(update.trade - quote.trade) : 0;
    Object.assign(quote, {
      last: update.last, change: update.last - base, change_pct: (update.last / base - 1) * 100,
      volume: update.volume ?? quote.volume, date: update.day,
      trade: update.trade, pre_volume: update.pre_volume,
    });
    refreshRow(symbol, (key) => (key === "ext" ? extDirection : COLUMNS[key].price ? direction : 0));
  }
});

onLiveBuzz((live) => {
  for (const [symbol, buzz] of live) buzzes.set(symbol, buzz);
  if (!columns().some((key) => key === "buzz" || key === "extVol")) return;
  for (const symbol of symbolsOf(activeList())) {
    if (live.has(ticker(symbol))) refreshRow(symbol, () => 0, ["buzz", "extVol"]);
  }
});

// The session changed: the Buzz header follows it, and Ext columns fill or empty.
onSessionChange(() => renderRows());

function refreshRow(symbol, directionOf, only = null) {
  const quote = quotes.get(symbol);
  const row = quote && $("wl-rows").querySelector(`.hw-row[data-symbol="${CSS.escape(symbol)}"]`);
  if (!row) return;
  const cells = row.querySelectorAll(".num");
  columns().forEach((key, i) => {
    const col = COLUMNS[key];
    if (col.left || !cells[i] || (only && !only.includes(key))) return;
    flashCell(cells[i], col.text(quote), directionOf(key));
    if (col.signed) {
      cells[i].classList.toggle("up", quote.change >= 0);
      cells[i].classList.toggle("down", quote.change < 0);
    }
  });
}

export function markActiveSymbol() {
  renderRows();
}

// ---------- editing ----------

async function qualify(text) {
  const raw = text.trim().toUpperCase();
  if (!raw) return null;
  const { quotes: found } = await api(`/api/quotes?symbols=${encodeURIComponent(raw)}`);
  const quote = found[raw];
  if (!quote) return null;
  quotes.set(quote.symbol, quote);
  return quote.symbol;
}

export async function addToWatchlist(symbol, listId = null) {
  const list = (listId && data.lists.find((item) => item.id === listId)) || activeList();
  const qualified = symbol.includes(":") ? symbol : await qualify(symbol);
  if (!qualified) return toast(`No data for ${symbol.toUpperCase()}`);
  if (symbolsOf(list).some((item) => ticker(item) === ticker(qualified))) return toast(`${ticker(qualified)} is already in ${list.name}`);
  list.symbols.push(qualified);
  save();
  renderWatchlists();
  toast(`Added ${ticker(qualified)} to ${list.name}`);
}

// Several at once, "AAPL, NVDA TSLA" or a TradingView export: sections are kept, symbols are
// looked up, and one toast sums it up.
export async function addSymbols(text, listId = null) {
  const list = (listId && data.lists.find((item) => item.id === listId)) || activeList();
  const added = [];
  const skipped = [];
  for (const token of parseTradingView(text)) {
    if (isSection(token)) { list.symbols.push(token); continue; }
    const qualified = token.includes(":") ? token : await qualify(token).catch(() => null);
    if (!qualified) skipped.push(token);
    else if (symbolsOf(list).some((item) => ticker(item) === ticker(qualified))) skipped.push(ticker(qualified));
    else { list.symbols.push(qualified); added.push(ticker(qualified)); }
  }
  save();
  renderWatchlists();
  if (!added.length && !skipped.length) return toast("No symbols found");
  const said = added.length ? `Added ${added.length === 1 ? added[0] : `${added.length} symbols`} to ${list.name}` : "";
  toast(said + (skipped.length ? `${said ? " · " : ""}skipped ${skipped.join(", ")}` : ""), skipped.length ? 4000 : undefined);
}

async function askSymbols() {
  const text = await askSymbolsPanel({ listName: activeList().name });
  if (text) addSymbols(text);
}

// Removing a section keeps its symbols: they join the section above.
function removeSection(name) {
  const list = activeList();
  list.symbols = list.symbols.filter((entry) => entry !== SECTION + name);
  list.collapsed = (list.collapsed || []).filter((item) => item !== name);
  save();
  renderWatchlists();
}

function toggleSection(name) {
  const list = activeList();
  const collapsed = new Set(list.collapsed || []);
  collapsed.has(name) ? collapsed.delete(name) : collapsed.add(name);
  list.collapsed = [...collapsed];
  save();
  renderRows();
}

// Your own lists, for "Add to watchlist": [{ id, name, has }] (Flagged has its own command).
export const watchlistChoices = (symbol) => data.lists.filter((list) => list.id !== FLAGGED).map((list) => ({
  id: list.id, name: list.name, has: symbolsOf(list).some((item) => ticker(item) === ticker(symbol)),
}));
export const inActiveList = (symbol) => data.active !== FLAGGED && symbolsOf(activeList()).some((item) => ticker(item) === ticker(symbol));
export const activeListName = () => activeList().name;
export const activeListId = () => data.active;

// Cmd+Alt+W: tick the lists the symbol belongs in.
export async function openAddToWatchlist(symbol) {
  const qualified = symbol.includes(":") ? symbol : await qualify(symbol).catch(() => null);
  if (!qualified) return toast(`No data for ${symbol.toUpperCase()}`);
  const lists = watchlistChoices(qualified).map((choice) => ({ ...choice, count: symbolsOf(data.lists.find((list) => list.id === choice.id)).length }));
  await pickAddTo({
    symbol: ticker(qualified),
    lists,
    toggle: (id) => {
      const list = data.lists.find((item) => item.id === id);
      const has = symbolsOf(list).some((item) => ticker(item) === ticker(qualified));
      if (has) list.symbols = list.symbols.filter((item) => isSection(item) || ticker(item) !== ticker(qualified));
      else list.symbols.push(qualified);
      save();
      renderWatchlists();
      return !has;
    },
  });
}

// A section header placed just before `entry`.
export async function addSectionBefore(entry) {
  const name = await promptDialog({ title: "Add a section here", placeholder: "Section name", ok: "Add" });
  if (!name || !name.trim()) return;
  const list = activeList();
  const at = list.symbols.indexOf(entry);
  if (at < 0) return;
  list.symbols.splice(at, 0, SECTION + name.trim().replace(/,/g, " "));
  save();
  renderWatchlists();
}

// Move a symbol from the active list to another.
export function moveSymbol(entry, listId) {
  const from = activeList();
  const to = data.lists.find((item) => item.id === listId);
  if (!to) return;
  const has = symbolsOf(to).some((item) => ticker(item) === ticker(entry));
  if (!has) to.symbols.push(entry);
  const copy = from.id === FLAGGED; // a flag stays; moving it to a list just adds it there
  if (!copy) from.symbols = from.symbols.filter((item) => item !== entry);
  save();
  renderWatchlists();
  if (copy) return toast(has ? `${ticker(entry)} is already in ${to.name}` : `Added ${ticker(entry)} to ${to.name}`);
  toast(has ? `${ticker(entry)} was already in ${to.name}; removed from ${from.name}` : `Moved ${ticker(entry)} to ${to.name}`);
}

export function removeSymbol(symbol) {
  const list = activeList();
  list.symbols = list.symbols.filter((item) => item !== symbol);
  save();
  renderWatchlists();
}

// Arrow keys and Space walk the active list, like TradingView's watchlist.
export function stepWatchlist(delta) {
  const symbols = shownSymbols(activeList());
  if (!symbols.length) return;
  // From the chart's symbol, or the highlighted row when the chart is on one not in the list.
  let at = symbols.findIndex((symbol) => ticker(symbol) === ticker(state.home.symbol));
  if (at < 0) at = symbols.findIndex((symbol) => ticker(symbol) === picked);
  const next = at < 0 ? 0 : at + delta;
  if (next < 0 || next >= symbols.length) return toast(next < 0 ? "Top of the list" : "End of the list");
  picked = ticker(symbols[next]);
  actions.openSymbol(symbols[next]);
}

export function watchlistNeighbors(offsets) {
  const symbols = shownSymbols(activeList());
  const at = symbols.findIndex((symbol) => ticker(symbol) === ticker(state.home.symbol));
  if (at < 0) return [];
  return offsets.map((offset) => symbols[at + offset]).filter(Boolean);
}

// TradingView exports a watchlist as text: "###SECTION NAME,NASDAQ:AAPL,NYSE:BRK.B,…".
// Section names can hold spaces, so split on commas and lines first.
function parseTradingView(text) {
  return text.split(/[,\n]+/).flatMap((part) => {
    const token = part.trim();
    if (token.startsWith(SECTION)) return token.length > SECTION.length ? [token] : [];
    return token.split(/\s+/).map((word) => word.toUpperCase())
      .filter((word) => /^[A-Z0-9_]+:[A-Z0-9._\-!]+$|^[A-Z0-9.\-]+$/.test(word));
  });
}

async function menu(action) {
  const list = activeList();
  if (action.startsWith("col:")) {
    const key = action.slice(4);
    const shown = columns();
    data.columns = shown.includes(key) ? shown.filter((item) => item !== key) : [...shown, key];
    if (list.sort && !data.columns.includes(list.sort.key) && list.sort.key !== "symbol") delete list.sort;
  } else if (action === "section") {
    const name = await promptDialog({ title: "Add a section", placeholder: "Section name", ok: "Add" });
    if (!name || !name.trim()) return;
    list.symbols.push(SECTION + name.trim().replace(/,/g, " "));
  } else if (action === "new") {
    const name = await promptDialog({ title: "New watchlist", value: "New list", ok: "Create" });
    if (!name || !name.trim()) return;
    const id = `l${Date.now().toString(36)}`;
    data.lists.push({ id, name: name.trim(), symbols: [] });
    data.active = id;
  } else if (list.id === FLAGGED && action === "rename") {
    return toast("Flagged is built in");
  } else if (list.id === FLAGGED && action === "delete") {
    if (!list.symbols.length || !(await confirmDialog({ title: `Clear all ${list.symbols.length} flags?`, ok: "Clear flags", danger: true }))) return;
    list.symbols = [];
    actions.flagsChanged();
  } else if (action === "rename") {
    const name = await promptDialog({ title: "Rename watchlist", value: list.name, ok: "Rename" });
    if (!name || !name.trim()) return;
    list.name = name.trim();
  } else if (action === "delete") {
    if (data.lists.length === 1) return toast("Keep at least one list");
    const sure = await confirmDialog({
      title: `Delete “${list.name}”?`, message: `The list and its ${symbolsOf(list).length} symbols are removed.`, ok: "Delete list", danger: true,
    });
    if (!sure) return;
    data.lists = data.lists.filter((item) => item.id !== list.id);
    data.active = data.lists[0].id;
  } else if (action === "import") {
    const text = await promptDialog({
      title: "Import from TradingView", message: "Paste a watchlist export (the .txt contents), or tickers separated by commas.",
      multiline: true, ok: "Import", hint: "Ctrl+Enter imports",
    });
    if (!text) return;
    const symbols = parseTradingView(text).map((token) => (token.startsWith("NYSEARCA:") ? token.replace("NYSEARCA:", "AMEX:") : token));
    const added = symbols.filter((entry) => !list.symbols.includes(entry));
    list.symbols.push(...added);
    const count = added.filter((entry) => !isSection(entry)).length;
    toast(`Imported ${count} symbol${count === 1 ? "" : "s"} into ${list.name}`);
  }
  save();
  renderWatchlists();
}

// ---------- details ----------

const perf = (bars, back) => {
  if (bars.length <= back) return null;
  return (bars[bars.length - 1].close / bars[bars.length - 1 - back].close - 1) * 100;
};

function ytd(bars) {
  const year = bars[bars.length - 1].time.slice(0, 4);
  const before = [...bars].reverse().find((bar) => bar.time.slice(0, 4) < year);
  return before ? (bars[bars.length - 1].close / before.close - 1) * 100 : null;
}

// Jeff Sun's "ATR % multiple from the 50d", as on TradingView: the percent the close is above the
// 50-day average, divided by the 14-day ATR (Wilder) as a percent of the close. That is
// (close - SMA50) / ATR scaled by close / SMA50, so a very extended stock reads higher than in
// plain ATRs. Needs 64 bars: 50 for the average and 14 for the ATR.
function atrExtension(bars) {
  if (bars.length < 64) return null;
  const sma50 = bars.slice(-50).reduce((sum, bar) => sum + bar.close, 0) / 50;
  let atr = null;
  for (let i = 1; i < bars.length; i++) {
    const { high, low } = bars[i];
    const range = Math.max(high - low, Math.abs(high - bars[i - 1].close), Math.abs(low - bars[i - 1].close));
    if (i < 14) atr = (atr || 0) + range;
    else atr = i === 14 ? (atr + range) / 14 : (atr * 13 + range) / 14;
  }
  const close = bars[bars.length - 1].close;
  return atr ? ((close - sma50) / sma50) / (atr / close) : null;
}

const pctCell = (value) => `<span class="${value == null ? "" : value >= 0 ? "up" : "down"}">${fmtPct(value, 1)}</span>`;

let detailsData = null; // the daily bars the panel shows (shared with the chart; kept live by the feed)
let paintedClose = null;
let unsubscribeDetails = null;
let detailsBox = null; // where it is painted: the watchlist's panel, or Daily review's
let detailsToken = 0;
let detailsFundamentals = null;
let detailsThrough = null; // the day the panel's bars run through (null: today)

export function setDetailsFundamentals(record) {
  detailsFundamentals = record;
  if (detailsData && detailsBox) paintDetails();
}

// Daily review shows the same panel as of the scan date: `through` cuts the bars there.
export async function renderDetails(symbol, { box = $("details"), through = null, count = CHART_BARS.D } = {}) {
  const token = ++detailsToken;
  // Bar Replay moving forward keeps the table until the new day's arrives, so the panel doesn't
  // jump each bar; an earlier day's table is still honest. Anything else starts clean.
  const stepping = detailsData && ticker(detailsData.symbol) === ticker(symbol) &&
    through && detailsThrough && detailsThrough <= through;
  detailsThrough = through;
  if (!stepping) {
    detailsFundamentals = null;
    box.querySelector(".dt-fund, .dt-fund-empty")?.remove();
  }
  const daily = series(symbol, { through, interval: "1D", count });
  let data;
  try {
    data = await daily.load();
  } catch {
    if (token !== detailsToken) return;
    box.innerHTML = "";
    detailsData = null;
    return;
  }
  if (token !== detailsToken) return;
  if (unsubscribeDetails) unsubscribeDetails();
  detailsBox = box;
  detailsData = data;
  paintedClose = null;
  // Live: the price flashes green or red with the move, the change bold.
  unsubscribeDetails = showLive("details", daily, () => paintDetails());
  paintDetails();
}

function paintDetails() {
  const box = detailsBox;
  const data = detailsData;
  const symbol = data.symbol;
  const bars = data.bars;
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2].close : last.open;
  const year = bars.slice(-252);
  const high = Math.max(...year.map((bar) => bar.high));
  const low = Math.min(...year.map((bar) => bar.low));
  const extension = atrExtension(bars);
  const avgVol = bars.length >= 20 ? bars.slice(-21, -1).reduce((sum, bar) => sum + bar.volume, 0) / 20 : null;
  // While today trades, its volume so far is set against the same share of an average day.
  const pace = last.live ? sessionDone(last.time) : 1;
  const change = last.close - prev;
  const scan = box.id === "details" && latestDeck && latestDeck.get(ticker(symbol));
  const place = [data.sector, data.industry].filter((name) => name && name !== "Unknown");
  const fundamentals = state.mode === "chart" && box.id === "details" &&
    detailsFundamentals && ticker(detailsFundamentals.symbol) === ticker(symbol)
    ? fundamentalsTable(detailsFundamentals.data, detailsFundamentals.error) : "";
  box.innerHTML =
    `<div class="dt-name">${escapeHtml(data.company || ticker(symbol))}</div>` +
    `<div class="dt-sub">${escapeHtml(symbol)}</div>` +
    (place.length ? `<div class="dt-ind" title="${escapeHtml(place.join(" · "))}">${escapeHtml(place.join(" · "))}</div>` : "") +
    `<div class="dt-price"><b>${fmtPrice(last.close)}</b><span class="dt-chg ${change >= 0 ? "up" : "down"}">${change >= 0 ? "+" : ""}${fmtPrice(change)} (${fmtPct((change / prev) * 100)})</span></div>` +
    `<div class="dt-asof">${last.live ? '<i class="dt-live"></i>Live' : "Close"} · ${last.time}</div>` +
    (scan ? `<button class="dt-scan" data-run="${escapeHtml(scan.run)}" data-symbol="${escapeHtml(scan.symbol)}">` +
      `<i class="dot ${scan.verdict || ""}"></i><span class="dt-scan-text"><b>In the ${escapeHtml(scan.date)} scan</b>` +
      `${scan.verdict ? `<em>You said ${escapeHtml(scan.verdict)}</em>` : ""}</span><span class="dt-go">Review →</span></button>` : "") +
    fundamentals + `<div class="dt-grid">` +
    `<span>Market cap</span><b>${fmtBig(data.market_cap)}</b>` +
    `<span>ADR % (20)</span><b>${data.adr20 == null ? "—" : `${data.adr20.toFixed(2)}%`}</b>` +
    `<span>Avg $ vol (20)</span><b>${fmtBig(data.adv20, "$")}</b>` +
    `<span>Rel. volume</span><b>${avgVol ? `${(last.volume / (avgVol * pace)).toFixed(2)}x` : "—"}</b>` +
    `<span>52-wk high</span><b>${fmtPrice(high)} ${pctCell((last.close / high - 1) * 100)}</b>` +
    `<span>52-wk low</span><b>${fmtPrice(low)} ${pctCell((last.close / low - 1) * 100)}</b>` +
    `<span title="Percent above the 50-day average divided by the 14-day ATR as a percent of price (Jeff Sun's ATR % multiple)">ATR % mult. from 50d</span>` +
    `<b>${extension == null ? "—" : `<span class="${extension > 10 ? "stretched" : extension >= 0 ? "up" : "down"}"${extension > 10 ? ' title="Over 10x: extended"' : ""}>${extension >= 0 ? "+" : "−"}${Math.abs(extension).toFixed(1)}x</span>`}</b>` +
    `</div>` +
    `<div class="dt-perf">${[["1W", 5], ["1M", 21], ["3M", 63], ["6M", 126], ["YTD", null], ["1Y", 252]].map(([label, back]) =>
      `<div><span>${label}</span>${pctCell(back == null ? ytd(bars) : perf(bars, back))}</div>`).join("")}</div>`;
  const direction = paintedClose == null ? 0 : Math.sign(last.close - paintedClose);
  if (paintedClose != null && last.close !== paintedClose) {
    box.querySelector(".dt-price b").classList.add(direction > 0 ? "tick-up" : "tick-down");
    box.querySelector(".dt-chg").classList.add("tick");
  }
  paintedClose = last.close;
}

// The newest scan's candidates (and your calls on them), to mark scanned symbols.
export async function loadLatestScan() {
  const run = state.runs[0];
  if (!run) return;
  try {
    const deck = await api(`/api/runs/${run.run_id}/deck?section=all`);
    latestDeck = new Map(deck.cards.map((card) => [ticker(card.symbol), {
      run: run.run_id, date: run.as_of, symbol: card.symbol, verdict: card.review ? card.review.verdict : null,
    }]));
    renderRows();
  } catch {}
}

function listItems() {
  const list = activeList();
  return [
    { heading: list.name },
    list.id !== FLAGGED && { label: "Add symbols…", run: askSymbols },
    { label: "Add section…", run: () => menu("section") },
  ];
}

// Right-click a column header: sort, hide, reset its width, tick columns, reset them all.
function headerMenu(event, key) {
  const list = activeList();
  const asc = key === "symbol" || COLUMNS[key]?.left;
  const sorts = !key ? [] : [[asc ? "A–Z" : "Low–high", "asc"], [asc ? "Z–A" : "High–low", "desc"]].map(([label, dir]) => ({
    label: `Sort ${label}`, checked: list.sort?.key === key && list.sort.dir === dir,
    run: () => { list.sort = { key, dir }; save(); renderRows(); },
  }));
  if (key && list.sort?.key === key) sorts.push({ label: "Clear sort", run: () => { delete list.sort; save(); renderRows(); } });
  openMenu(event, columnItems({
    label: !key ? "Columns" : key === "symbol" ? "Symbol" : COLUMNS[key].label, sorts,
    hide: key && key !== "symbol" && (() => menu(`col:${key}`)),
    resetWidth: key && data.widths?.[key] && (() => { delete data.widths[key]; save(); renderWatchlists(); }),
    columns: Object.entries(COLUMNS).filter(([each]) => offered(each)).map(([each, col]) => ({
      label: col.label, checked: columns().includes(each), run: () => menu(`col:${each}`),
    })),
    reset: () => { delete data.columns; delete data.widths; save(); renderWatchlists(); },
  }));
}

// ---------- drag and drop ----------
// Drag a row to reorder it or move it into another section: drop on a row (above or below its
// middle), on a section header (its top third: just above the section, so out of it; the rest:
// the top of that section) or on the empty space (the end). Drop
// it on one of the list chips that appear over the header and it moves to that list. Drag a
// section header to move the whole section (its symbols with it).

let dragged = null; // the list entry being dragged
let draggedSection = null; // or the section's name

const sectionOf = (list, entry) => {
  for (let i = list.symbols.indexOf(entry); i >= 0; i--) if (isSection(list.symbols[i])) return list.symbols[i];
  return null;
};

// A section's header and the symbols under it: [start, end) in list.symbols.
function blockOf(symbols, name) {
  const start = symbols.indexOf(SECTION + name);
  let end = start + 1;
  while (end < symbols.length && !isSection(symbols[end])) end++;
  return [start, end];
}

const DROP_MARKS = ["drop-before", "drop-after", "drop-into", "drop-over"];
// Take the drop indicators off (and, at the end of a drag, the dimming of what was dragged).
function clearDrop(root = $("side-home"), marks = DROP_MARKS) {
  for (const el of root.querySelectorAll(marks.map((name) => `.${name}`).join(", "))) el.classList.remove(...marks);
}

// Where a drop at this pointer goes: { index, mark(): shows it } or null.
function dropTarget(event) {
  const list = activeList();
  if (draggedSection != null) return sectionTarget(event, list);
  const without = list.symbols.filter((entry) => entry !== dragged);
  const row = event.target.closest(".hw-row[data-symbol]");
  if (row) {
    if (row.dataset.symbol === dragged) return null;
    const box = row.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    const at = without.indexOf(row.dataset.symbol) + (after ? 1 : 0);
    return { index: at, mark: () => row.classList.add(after ? "drop-after" : "drop-before") };
  }
  const head = event.target.closest(".hw-sec");
  if (head) {
    // The header's top half is just above the section (out of it), the rest the top of it.
    const box = head.getBoundingClientRect();
    const above = event.clientY < box.top + box.height / 3;
    const at = without.indexOf(SECTION + head.dataset.section);
    return { index: above ? at : at + 1, mark: () => head.classList.add(above ? "drop-before" : "drop-into") };
  }
  if (event.target.closest("#wl-rows")) {
    const rows = $("wl-rows").querySelectorAll(".hw-row[data-symbol]");
    const last = rows[rows.length - 1];
    return { index: without.length, mark: () => last && last.classList.add("drop-after") };
  }
  return null;
}

// A section goes before or after another (a header's top or bottom half), or to the end.
function sectionTarget(event, list) {
  const [start, end] = blockOf(list.symbols, draggedSection);
  const without = [...list.symbols.slice(0, start), ...list.symbols.slice(end)];
  const head = event.target.closest(".hw-sec");
  if (head) {
    if (head.dataset.section === draggedSection) return null;
    const box = head.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    const [from, to] = blockOf(without, head.dataset.section);
    return {
      index: after ? to : from,
      mark: () => {
        let last = head; // the line goes under the section's last row
        while (after && last.nextElementSibling && !last.nextElementSibling.classList.contains("hw-sec")) last = last.nextElementSibling;
        last.classList.add(after ? "drop-after" : "drop-before");
      },
    };
  }
  if (event.target.closest("#wl-rows")) {
    const rows = [...$("wl-rows").children];
    const last = rows[rows.length - 1];
    return { index: without.length, mark: () => last && last.classList.add("drop-after") };
  }
  return null;
}

function bindDrag() {
  const rows = $("wl-rows");
  const tray = $("wl-tray");
  const endDrag = () => {
    dragged = null;
    draggedSection = null;
    tray.hidden = true;
    clearDrop($("side-home"), [...DROP_MARKS, "dragging"]);
  };
  rows.addEventListener("dragstart", (event) => {
    const row = event.target.closest(".hw-row[data-symbol]");
    const head = !row && event.target.closest(".hw-sec");
    if (!row && !head) return;
    if (row) dragged = row.dataset.symbol;
    else draggedSection = head.dataset.section;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row ? ticker(dragged) : head.dataset.section);
    (row || head).classList.add("dragging");
    // A symbol can also be dropped on another watchlist.
    const others = data.lists.filter((list) => list.id !== data.active && list.id !== FLAGGED);
    tray.hidden = !row || !others.length;
    tray.innerHTML = `<span>Move to</span>` + others.map((list) =>
      `<button data-list="${escapeHtml(list.id)}">${escapeHtml(list.name)}</button>`).join("");
  });
  rows.addEventListener("dragover", (event) => {
    if (dragged == null && draggedSection == null) return;
    const target = dropTarget(event);
    clearDrop(rows);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    target.mark();
  });
  rows.addEventListener("drop", (event) => {
    if (dragged == null && draggedSection == null) return;
    const target = dropTarget(event);
    const entry = dragged;
    const section = draggedSection;
    endDrag();
    if (!target) return;
    event.preventDefault();
    const list = activeList();
    if (section != null) {
      const [start, end] = blockOf(list.symbols, section);
      const block = list.symbols.slice(start, end);
      const without = [...list.symbols.slice(0, start), ...list.symbols.slice(end)];
      without.splice(target.index, 0, ...block);
      list.symbols = without;
      save();
      return renderRows();
    }
    const without = list.symbols.filter((item) => item !== entry);
    const before = sectionOf(list, entry);
    without.splice(target.index, 0, entry);
    // Sorted lists order each section themselves: only a change of section sticks.
    if (list.sort && sectionOf({ symbols: without }, entry) === before) return toast("Clear the sort (right-click the column) to reorder by hand");
    list.symbols = without;
    save();
    renderRows();
  });
  rows.addEventListener("dragend", endDrag);
  // The chips: drop a symbol on one to move it there.
  tray.addEventListener("dragover", (event) => {
    const chip = event.target.closest("[data-list]");
    clearDrop(tray);
    if (!chip || dragged == null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    chip.classList.add("drop-over");
  });
  tray.addEventListener("drop", (event) => {
    const chip = event.target.closest("[data-list]");
    const entry = dragged;
    endDrag();
    if (!chip || entry == null) return;
    event.preventDefault();
    moveSymbol(entry, chip.dataset.list);
  });
}

export function bindWatchlists() {
  $("details").addEventListener("toggle", (event) => {
    if (event.target.matches(".dt-fund")) store.set("fundamentalsFold", !event.target.open);
  }, true);
  bindDrag();
  $("wl-select").addEventListener("click", openWatchlistDropdown);
  $("wl-rows").addEventListener("pointerover", (event) => {
    const row = event.target.closest(".hw-row[data-symbol]");
    if (row) warmSymbol(row.dataset.symbol);
  });
  // The list's own actions: right-click the list name or the empty part of the list.
  const listMenuAt = (event) => {
    if (event.shiftKey || event.target.closest(".hw-row[data-symbol]")) return;
    openMenu(event, listItems());
  };
  document.querySelector(".hw-head").addEventListener("contextmenu", listMenuAt);
  $("wl-plus").addEventListener("click", () => (activeList().id === FLAGGED ? toast("Flag symbols with Shift+F") : askSymbols()));
  $("wl-rows").addEventListener("contextmenu", listMenuAt);

  bindColumns($("wl-cols"), {
    width: widthOf,
    room: () => $("wl-cols").querySelector("[data-col]:nth-last-child(2)").getBoundingClientRect().width - 44,
    setWidth(key, px, final) {
      data.widths = { ...data.widths, [key]: px };
      if (px == null) delete data.widths[key];
      $("side-home").style.setProperty("--wl-grid", gridOf());
      if (final) save();
    },
    move(key, target) {
      if (target === "symbol") return; // Symbol stays first
      data.columns = moved(columns(), key, target);
      save();
      renderWatchlists();
    },
  });
  $("wl-cols").addEventListener("contextmenu", (event) => {
    const head = event.target.closest("[data-col]");
    if (wantsMenu(event)) headerMenu(event, head ? head.dataset.col : null);
  });
  $("wl-cols").addEventListener("click", (event) => {
    const header = event.target.closest("[data-sort]");
    if (header) cycleSort(header.dataset.sort);
  });
  $("wl-rows").addEventListener("click", (event) => {
    const removeSec = event.target.closest("[data-remove-section]");
    if (removeSec) return removeSection(removeSec.dataset.removeSection);
    const section = event.target.closest(".hw-sec");
    if (section) return toggleSection(section.dataset.section);
    const flag = event.target.closest("[data-flag]");
    if (flag) return toggleFlag(flag.dataset.flag);
    const remove = event.target.closest("[data-remove]");
    if (remove) return removeSymbol(remove.dataset.remove);
    const row = event.target.closest(".hw-row");
    if (!row) return;
    picked = ticker(row.dataset.symbol);
    actions.openSymbol(row.dataset.symbol);
  });
  $("details").addEventListener("click", (event) => {
    const button = event.target.closest(".dt-scan");
    if (button) actions.reviewSymbol(button.dataset.run, button.dataset.symbol);
  });
  renderWatchlists();
}
