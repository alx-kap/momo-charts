// Linked tabs, as in TradingView: tabs given the same colour follow each other. Each colour has
// its own switches (symbol, interval, time, date range), shared by every tab; a tab's colour
// lives in its address (?link=red), so it survives a reload and the desktop app's restored
// tabs. Changes travel between this browser's tabs (or the desktop app's) on a
// BroadcastChannel, never through the server. Only Chart mode sends or follows: Daily review
// and Practice charts stop at their scan date.
//
// In the desktop app the tab's right-click menu holds the colours and switches, as in
// TradingView Desktop, so the chain button stays hidden (in the browser as well); the page reports its state to the app
// (momoDesktop.setLinkState) and takes the menu's changes (momoDesktop.onLink).

import { $, store, ticker } from "./util.js";

export const COLORS = {
  red: "#f04a4a", green: "#5cb85c", blue: "#4a7dff", yellow: "#f5d547", orange: "#f59a2f",
  teal: "#46b8d6", purple: "#a142c9", pink: "#f08cb0", violet: "#6a35ff",
};
const DEFAULTS = { symbol: true, interval: false, time: false, range: false };

const me = Math.random().toString(36).slice(2);
const channel = "BroadcastChannel" in window ? new BroadcastChannel("momo-link") : null;
const asked = new URLSearchParams(location.search).get("link");
let color = COLORS[asked] ? asked : null;
const last = {}; // kind -> the value last sent or followed, so a change crosses once
let app = null;

export const linkColor = () => color;
const switches = (name = color) => ({ ...DEFAULTS, ...store.get("linkGroups", {})[name] });
// "view" (the dates in view) follows when Time or Date range is on.
const follows = (kind) => { const on = switches(); return kind === "view" ? on.time || on.range : on[kind]; };

const same = (kind, a, b) => (kind === "symbol" ? a != null && b != null && ticker(a) === ticker(b)
  : JSON.stringify(a) === JSON.stringify(b));

// `handlers`: { symbol(value), interval(value), view(times, fit), colored() }: the view is
// fitted when Date range is on, else only scrolled (Time); colored() runs when this tab's
// colour changes (main.js rewrites the address).
export function bindLink(handlers) {
  app = handlers;
  channel?.addEventListener("message", ({ data }) => {
    if (!color || data.from === me || data.color !== color || !follows(data.kind)) return;
    if (same(data.kind, last[data.kind], data.value)) return;
    last[data.kind] = data.value;
    app[data.kind]?.(data.value, switches().range);
  });
  $("link-button").addEventListener("click", (event) => {
    event.stopPropagation();
    $("link-menu").hidden ? openMenu() : closeLinkMenu();
  });
  $("link-menu").addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", closeLinkMenu);
  const swatches = $("link-colors");
  for (const [name, hex] of Object.entries(COLORS)) {
    const swatch = Object.assign(document.createElement("button"), { className: "link-swatch", title: name[0].toUpperCase() + name.slice(1) });
    swatch.dataset.color = name;
    swatch.style.setProperty("--swatch", hex);
    swatch.addEventListener("click", () => setColor(color === name ? null : name));
    swatches.append(swatch);
  }
  for (const box of $("link-menu").querySelectorAll("[data-link]")) {
    box.addEventListener("change", () => setSwitch(box.dataset.link, box.checked));
  }
  // Another tab changed a colour's switches.
  window.addEventListener("storage", (event) => { if (event.key === "momo.linkGroups") render(); });
  // The chain button stays hidden in the browser too: linking is a desktop-app feature.
  $("link-button").closest(".link-wrap").hidden = true;
  const desktop = window.momoDesktop;
  if (desktop?.onLink) {
    desktop.onLink((change) => {
      if ("color" in change) setColor(COLORS[change.color] ? change.color : null);
      if (change.kind in DEFAULTS && color) setSwitch(change.kind, Boolean(change.on));
    });
  }
  render();
}

function setSwitch(kind, on) {
  const groups = store.get("linkGroups", {});
  groups[color] = { ...switches(), [kind]: on };
  store.set("linkGroups", groups);
  render();
}

// A change made in this tab: "symbol", "interval" or "view" (a chart's visibleTimes, sent only
// when you pan or zoom). A tab's first symbol and interval are where it starts, not a change,
// so opening or reloading a tab never moves the others.
export function publish(kind, value) {
  if (value == null) return;
  const first = kind !== "view" && !(kind in last);
  if (!first && same(kind, last[kind], value)) return;
  last[kind] = value;
  if (!first && color && follows(kind)) channel?.postMessage({ from: me, color, kind, value });
}

function setColor(name) {
  color = name;
  render();
  app.colored();
}

function render() {
  const hex = color ? COLORS[color] : null;
  const button = $("link-button");
  button.classList.toggle("linked", Boolean(color));
  button.style.setProperty("--link", hex || "");
  button.title = color ? `Linked: ${color} tabs follow each other` : "Link tabs";
  for (const swatch of $("link-colors").children) swatch.classList.toggle("active", swatch.dataset.color === color);
  const on = switches();
  for (const box of $("link-menu").querySelectorAll("[data-link]")) {
    box.checked = Boolean(color) && on[box.dataset.link];
    box.disabled = !color;
  }
  $("link-menu").classList.toggle("unlinked", !color);
  window.momoDesktop?.setLink?.(hex);
  window.momoDesktop?.setLinkState?.({ color, colors: COLORS, switches: on });
}

function openMenu() {
  render();
  $("link-menu").hidden = false;
}

export function closeLinkMenu() {
  $("link-menu").hidden = true;
}

export const linkMenuOpen = () => !$("link-menu").hidden;
