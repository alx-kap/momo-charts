import { $, escapeHtml, ticker } from "./util.js";
import { actions, state } from "./state.js";
import { addIndicator, openChartSettings } from "./chartsettings.js";
import { INDICATORS } from "./indicators.js";
import { openHelp } from "./help.js";

// Ctrl+K command palette: symbols, decks and actions in one fuzzy list.
let items = [];
let shown = [];
let selected = 0;
let scope = null;
const LIMIT = 60;

const SCOPES = {
  decks: { group: "Decks", placeholder: "Switch deck…" },
};

// Daily review and Practice add theirs (private.js): their modes after Chart mode, the rest last.
const added = { modes: () => [], more: () => [] };
export function addCommands(more) {
  Object.assign(added, more);
}

function commands() {
  return [
    { group: "Commands", label: "Chart mode: your charts and watchlists", hint: "mode", run: () => actions.setMode("chart") },
    ...added.modes(),
    { group: "Commands", label: "Screener: filter every stock", hint: "screen", run: () => actions.openScreener() },
    { group: "Commands", label: "Market: themes, where money is moving", hint: "market", run: () => actions.openThemes("themes") },
    { group: "Commands", label: "Market: industries, strength by industry", hint: "market", run: () => actions.openThemes("industries") },
    { group: "Commands", label: "Chart settings: colours, background, scales", hint: "chart", run: () => openChartSettings("symbol") },
    { group: "Commands", label: "Indicators: add or edit", hint: "/", run: () => openChartSettings("indicators") },
    ...Object.entries(INDICATORS).map(([type, def]) => ({
      group: "Commands", label: `Add indicator: ${def.name}`, hint: "ƒx",
      run: () => addIndicator(type),
    })),
    { group: "Commands", label: "Trend line", hint: "⌥T", run: () => actions.setTool("trend") },
    { group: "Commands", label: "Horizontal line", hint: "⌥H", run: () => actions.setTool("hline") },
    { group: "Commands", label: "Horizontal ray", hint: "⌥J", run: () => actions.setTool("hray") },
    { group: "Commands", label: "Ray", run: () => actions.setTool("ray") },
    { group: "Commands", label: "Arrow", run: () => actions.setTool("arrow") },
    { group: "Commands", label: "Vertical line", run: () => actions.setTool("vline") },
    { group: "Commands", label: "Rectangle", run: () => actions.setTool("rect") },
    { group: "Commands", label: "Bar Replay: replay the chart from a past bar", hint: "⇧↓", run: () => actions.startReplay() },
    ...(state.me.live ? [{ group: "Commands", label: "Price alert on this chart", hint: "⌥A", run: () => actions.newAlert() }] : []),
    { group: "Commands", label: "Remove all drawings on this chart", hint: "drawings", run: () => actions.removeAllDrawings() },
    { group: "Commands", label: "Add this symbol to the watchlist", hint: "⌥W", run: () => actions.addCurrentToWatchlist() },
    { group: "Commands", label: "Flag or unflag this symbol", hint: "⇧F", run: () => actions.flagCurrent() },
    ...[["1m", "1-minute"], ["5m", "5-minute"], ["15m", "15-minute"], ["30m", "30-minute"], ["1h", "Hourly"]].map(([interval, label]) =>
      ({ group: "Commands", label: `${label} chart`, hint: interval, run: () => actions.setInterval(interval) })),
    { group: "Commands", label: "Daily chart", hint: "1D", run: () => actions.setInterval("1D") },
    { group: "Commands", label: "Weekly chart", hint: "1W", run: () => actions.setInterval("1W") },
    { group: "Commands", label: "Monthly chart", hint: "1M", run: () => actions.setInterval("1M") },
    { group: "Commands", label: "Keyboard shortcuts", hint: "?", run: openHelp },
    ...added.more(),
  ];
}

function buildItems() {
  const deckCards = state.deck ? state.deck.cards : [];
  const symbols = deckCards.map((card, index) => ({
    group: "Symbols",
    label: ticker(card.symbol),
    hint: card.review ? card.review.verdict : (card.company || ""),
    run: () => (state.mode === "review" ? actions.go(index) : actions.openSymbol(card.symbol)),
  }));
  const decks = state.sections.map((section) => ({
    group: "Decks",
    label: section.label,
    hint: state.deck && state.deck.counts ? `${state.deck.counts[section.key] ?? 0}` : "",
    current: section.key === state.section,
    run: () => actions.switchSection(section.key),
  }));
  return [...commands(), ...symbols, ...decks];
}

function score(label, query) {
  const text = label.toLowerCase();
  if (text === query) return 5;
  if (text.startsWith(query)) return 4;
  if (text.split(/[\s·/]+/).some((word) => word.startsWith(query))) return 3;
  if (text.includes(query)) return 2;
  if (query.length < 3) return 0;
  let at = 0;
  for (const ch of query) {
    at = text.indexOf(ch, at);
    if (at < 0) return 0;
    at++;
  }
  return 1;
}

function filter(query) {
  const q = query.trim().toLowerCase();
  let pool = scope ? items.filter((item) => item.group === SCOPES[scope].group) : items;
  if (!q) {
    // Empty query: a short sampler of each group rather than hundreds of symbols.
    if (scope) return pool;
    const caps = { Commands: 8, Symbols: 8, Decks: 9, Scans: 5 };
    const counts = {};
    return pool.filter((item) => (counts[item.group] = (counts[item.group] || 0) + 1) <= caps[item.group]);
  }
  const ranked = pool
    .map((item) => ({ item, s: score(item.label, q) }))
    .filter((entry) => entry.s > 0)
    .map((entry) => ({ ...entry, s: entry.s + (entry.item.group === "Symbols" ? 0.5 : 0) }))
    .sort((a, b) => b.s - a.s)
    .map((entry) => entry.item);
  const symbolish = /^[a-z0-9.\-]{1,8}$/i.test(q) && !scope;
  const exact = ranked.some((item) => item.group === "Symbols" && item.label.toLowerCase() === q);
  if (symbolish && !exact) {
    ranked.push({
      group: "Open", label: `Open chart for ${q.toUpperCase()}`, hint: "any symbol",
      run: () => actions.openSymbol(q.toUpperCase()),
    });
  }
  return ranked.slice(0, LIMIT);
}

function render() {
  const list = $("palette-list");
  let group = null;
  const html = [];
  shown.forEach((item, n) => {
    if (item.group !== group) {
      group = item.group;
      html.push(`<div class="pl-group">${group}</div>`);
    }
    html.push(`<div class="pl-item${n === selected ? " selected" : ""}${item.current ? " current" : ""}" data-n="${n}">` +
      `<span>${escapeHtml(item.label)}</span><span class="pl-hint">${escapeHtml(item.hint || "")}</span></div>`);
  });
  list.innerHTML = html.length ? html.join("") : `<div class="pl-empty">No matches</div>`;
  const active = list.querySelector(".pl-item.selected");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function update() {
  shown = filter($("palette-input").value);
  selected = 0;
  render();
}

export function openPalette(mode = null, initial = "") {
  scope = mode;
  items = buildItems();
  $("palette").hidden = false;
  $("palette-input").placeholder = scope ? SCOPES[scope].placeholder : "Search symbols, decks and commands";
  $("palette-input").value = initial;
  $("palette-input").focus();
  update();
}

export function closePalette() {
  $("palette").hidden = true;
  $("palette-input").blur();
}

export const paletteOpen = () => !$("palette").hidden;

function choose(n) {
  const item = shown[n];
  closePalette();
  if (item) item.run();
}

export function bindPalette() {
  $("palette-input").addEventListener("input", update);
  $("palette-input").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!shown.length) return;
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(selected);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePalette();
    }
  });
  $("palette-list").addEventListener("mousedown", (event) => {
    const row = event.target.closest(".pl-item");
    if (!row) return;
    event.preventDefault();
    choose(Number(row.dataset.n));
  });
  $("palette").addEventListener("mousedown", (event) => {
    if (event.target === $("palette")) closePalette();
  });
}
