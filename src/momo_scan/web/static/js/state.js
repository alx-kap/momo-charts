import { store } from "./util.js";

// Horizontal lines; only the trigger is shown until enabled in settings.
export const LINE_OPTIONS = [
  { key: "trigger", label: "Trigger" },
  { key: "early", label: "Early-entry reference" },
  { key: "overhead", label: "Overhead resistance" },
  { key: "lastPrice", label: "Last price line" },
];
const DEFAULT_LINES = { trigger: true, early: false, overhead: false, lastPrice: false };

export const state = {
  mode: "chart", // "chart" (home), "review" (scan review) or "practice"
  me: { owner: true, name: "" }, // who is signed in via Tailscale; only the owner runs scans
  interval: store.get("interval", "1D"), // chart timeframe: 1D, 1W, 1M, …
  extended: store.get("extended", false), // intraday charts: pre- and post-market shown
  home: { symbol: store.get("homeSymbol", "AMEX:SPY") }, // the chart-mode symbol
  runs: [],
  sections: [],
  runId: null,
  section: store.get("section", "report"),
  deck: null,
  index: 0,
  blind: store.get("blind", true),
  deckFilters: store.get("deckFilters", {}), // { min_adr, max_adr, min_dvol, max_dvol } on the review deck
  noBiotech: store.get("noBiotech", false), // leave biotechs out of the review deck
  advance: store.get("advance", false),
  showLevels: store.get("levels", true),
  lines: { ...DEFAULT_LINES, ...store.get("lines", {}) },
  followThrough: false,
  revealed: false,
  tags: [],
  adhoc: null, // a searched symbol that is not in the deck
  barCache: new Map(),
  dayChange: new Map(), // symbol -> scan-day % change, filled as bars arrive
  loadToken: 0,
  prefetchToken: 0,
};

// Cross-module entry points, filled in by main.js to avoid import cycles.
export const actions = {};

export function currentCard() {
  if (state.adhoc || !state.deck) return null;
  return state.deck.cards[state.index] || null;
}

export function throughDate() {
  return state.followThrough || !state.deck ? null : state.deck.as_of;
}

export function runLabel(run) {
  const day = new Date(`${run.as_of}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return run.open ? `${day} scan` : `${day} scan · closed`;
}

// Calls are locked once the market has traded past the scan: the outcome would be in view.
export const scanClosed = () => Boolean(state.deck && !state.deck.open);
export const closedMessage = () =>
  `This scan is closed: the market has traded since.${state.me.owner ? " Run today's scan to make calls." : ""}`;
