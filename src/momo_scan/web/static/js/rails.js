import { $, store } from "./util.js";
import { state } from "./state.js";
import { scheduleCallouts } from "./chart.js";
import { closeScreener, dockScreener, onDockedClose, openScreener, screenerDocked, screenerOpen } from "./screener.js";
import { closeThemes, openThemes, themesOpen } from "./themes.js";
import { alertsShown } from "./alerts.js";

// Chart mode's icon rails, like ChartStack's and TradingView's. Left: Playbook. Right: Watchlist,
// Alerts, Screener and Market. An icon opens its panel; clicking the lit one closes it. The right panel
// shows the watchlist (with details), the docked screener, or nothing. Kept per browser.

let right = store.get("rightPanel", "watchlist"); // "watchlist" | "screener" | "alerts" | null
let left = store.get("leftPanel", null); // "playbook" | null

const inChart = () => state.mode === "chart" && !document.body.classList.contains("practice");

function setRight(view) {
  right = view;
  store.set("rightPanel", right);
  applyRails();
}

// Show the screener wherever it lives: docked, as the right panel; floating, as its window.
export function showScreener() {
  if (!inChart()) return;
  if (screenerDocked()) setRight("screener");
  else if (!screenerOpen()) openScreener();
}

function toggleScreener() {
  if (screenerDocked()) setRight(right === "screener" ? null : "screener");
  else if (screenerOpen()) closeScreener();
  else openScreener();
}

function toggleDock() {
  const docking = !screenerDocked();
  if (!docking) right = right === "screener" ? "watchlist" : right;
  dockScreener(docking);
  if (docking) setRight("screener");
  else { applyRails(); openScreener(); }
}

// Body classes place the panels; a docked screener is opened and closed with the right panel.
export function applyRails() {
  const body = document.body;
  const docked = screenerDocked();
  const view = docked || right !== "screener" ? right : "watchlist";
  body.classList.toggle("side-none", !view);
  body.classList.toggle("side-screener", view === "screener");
  body.classList.toggle("side-alerts", view === "alerts");
  if (view === "alerts" && inChart()) alertsShown();
  const playbook = $("playbook-panel"); // not in the public edition
  if (!playbook) left = null;
  else playbook.hidden = left !== "playbook";
  body.classList.toggle("left-open", Boolean(left));
  if (docked && inChart()) {
    if (view === "screener" && !screenerOpen()) openScreener();
    else if (view !== "screener" && screenerOpen()) closeScreener();
  }
  reflect();
  scheduleCallouts();
}

function reflect() {
  const lit = {
    playbook: left === "playbook",
    watchlist: right === "watchlist",
    alerts: right === "alerts",
    screener: screenerDocked() ? right === "screener" : screenerOpen(),
    market: themesOpen(),
  };
  document.querySelectorAll("[data-rail]").forEach((button) => button.classList.toggle("active", lit[button.dataset.rail]));
}

export function bindRails() {
  document.querySelectorAll("[data-rail]").forEach((button) => button.addEventListener("click", () => {
    const name = button.dataset.rail;
    if (name === "playbook") { left = left === name ? null : name; store.set("leftPanel", left); applyRails(); }
    else if (name === "watchlist" || name === "alerts") setRight(right === name ? null : name);
    else if (name === "screener") toggleScreener();
    else if (name === "market") (themesOpen() ? closeThemes() : openThemes());
  }));
  $("sc-dock").addEventListener("click", toggleDock);
  onDockedClose(() => setRight("watchlist"));
  // The screener window and Market close in many ways (×, Esc, a mode change): follow them.
  const watch = new MutationObserver(reflect);
  for (const id of ["screener", "themes"]) watch.observe($(id), { attributes: true, attributeFilter: ["hidden"] });
  applyRails();
}
