import { escapeHtml } from "./util.js";

// One right-click menu for the whole app, styled like the settings popover. A caller hands
// `openMenu` the pointer event and a list of items; hold Shift for the browser's own menu.
//   { label, run, icon?, hint?, checked?, keep?, disabled?, danger? }   a command (`keep`: a toggle,
//                                                    the menu stays open and its tick flips)
//   { label, items: [...] }                                       a submenu (opens on hover or →)
//   { heading: "text" }  /  "-"                                   a title / a divider

export const svgIcon = (...paths) => `<svg viewBox="0 0 24 24">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;

let root = null; // the open menus, outermost first: [{ el, items, active }]
let stack = [];
let opener = null;

export const menuOpen = () => stack.length > 0;

// True when this right-click should get the app's menu: not on a text field, not with Shift.
export const wantsMenu = (event) => !event.shiftKey && !event.target.closest("input, textarea, select, [contenteditable]");

export function openMenu(event, items) {
  closeMenu();
  const entries = items.filter(Boolean);
  if (!entries.some((item) => item.run || item.items)) return;
  event.preventDefault();
  opener = document.activeElement;
  root = document.createElement("div");
  root.className = "ctx-root";
  document.body.append(root);
  push(entries, { x: event.clientX, y: event.clientY });
}

export function closeMenu() {
  if (!root) return;
  root.remove();
  root = null;
  stack = [];
  if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
  opener = null;
}

// A menu of plain choices (no icons, some tickable) shows its ticks in front, in a narrow column.
const ticked = (items) => items.some((item) => item.checked !== undefined) && !items.some((item) => item.icon);

function itemHtml(item, index, lead) {
  if (item === "-") return `<div class="ctx-sep"></div>`;
  if (item.heading) return `<div class="ctx-head">${escapeHtml(item.heading)}</div>`;
  const classes = ["ctx-item", item.danger ? "danger" : "", item.checked && !lead ? "checked" : ""].filter(Boolean).join(" ");
  return `<button class="${classes}" data-i="${index}"${item.disabled ? " disabled" : ""}>` +
    `<span class="ctx-icon">${lead ? (item.checked ? "✓" : "") : item.icon || ""}</span><span class="ctx-label">${escapeHtml(item.label)}</span>` +
    (item.items ? `<span class="ctx-arrow">›</span>` : item.hint ? `<kbd>${escapeHtml(item.hint)}</kbd>` : "") + `</button>`;
}

// Show a menu at a point (or beside a parent item), kept on screen.
function push(items, at, parentItem = null) {
  const el = document.createElement("div");
  el.className = "ctx-menu";
  const lead = ticked(items);
  el.className = `ctx-menu${parentItem ? " sub" : ""}`;
  el.innerHTML = items.map((item, index) => itemHtml(item, index, lead)).join("");
  root.append(el);
  const { offsetWidth: width, offsetHeight: height } = el; // not the box: it is mid-animation
  let x = at ? at.x : 0;
  let y = at ? at.y : 0;
  if (parentItem) {
    const box = parentItem.getBoundingClientRect();
    x = box.right + 2 + width > innerWidth ? box.left - width - 2 : box.right + 2;
    y = box.top - 7;
  }
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
  stack.push({ el, items, lead, active: -1 });
  return stack[stack.length - 1];
}

function popTo(depth) {
  while (stack.length > depth) stack.pop().el.remove();
}

const buttons = (level) => [...level.el.querySelectorAll(".ctx-item:not(:disabled)")];

function focusItem(level, button) {
  for (const other of level.el.querySelectorAll(".ctx-item.active")) other.classList.remove("active");
  if (button) button.classList.add("active");
  level.active = button ? Number(button.dataset.i) : -1;
}

// Hovering or entering a submenu item opens it; any other item closes what's deeper.
function enter(depth, button) {
  popTo(depth + 1);
  focusItem(stack[depth], button);
  const item = stack[depth].items[Number(button.dataset.i)];
  if (item.items) push(item.items.filter(Boolean), null, button);
}

function activate(depth, button) {
  const item = stack[depth].items[Number(button.dataset.i)];
  if (item.items) return enter(depth, button);
  if (item.keep) return toggle(stack[depth], item);
  closeMenu();
  item.run();
}

// A toggle runs and flips its tick in place, so several can be changed in one visit.
function toggle(level, item) {
  item.run();
  item.checked = !item.checked;
  level.el.innerHTML = level.items.map((each, index) => itemHtml(each, index, level.lead)).join("");
  focusItem(level, level.el.querySelector(`.ctx-item[data-i="${level.items.indexOf(item)}"]`));
}

document.addEventListener("pointerover", (event) => {
  if (!root) return;
  const button = event.target.closest(".ctx-item");
  if (!button) return;
  const depth = stack.findIndex((level) => level.el.contains(button));
  if (depth >= 0 && !button.disabled && !button.classList.contains("active")) enter(depth, button);
});

document.addEventListener("click", (event) => {
  if (!root) return;
  const button = event.target.closest(".ctx-item");
  if (button && root.contains(button)) {
    event.stopPropagation();
    if (!button.disabled) activate(stack.findIndex((level) => level.el.contains(button)), button);
  } else closeMenu();
}, true);

// A click, a second right-click, a scroll or a resize elsewhere dismisses it.
document.addEventListener("contextmenu", (event) => { if (root && !root.contains(event.target)) closeMenu(); }, true);
document.addEventListener("pointerdown", (event) => { if (root && !root.contains(event.target)) closeMenu(); }, true);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
document.addEventListener("wheel", (event) => { if (root && !root.contains(event.target)) closeMenu(); }, { passive: true, capture: true });

document.addEventListener("keydown", (event) => {
  if (!root) return;
  const depth = stack.length - 1;
  const level = stack[depth];
  const list = buttons(level);
  const at = list.findIndex((button) => Number(button.dataset.i) === level.active);
  const stop = () => { event.preventDefault(); event.stopPropagation(); };
  if (event.key === "Escape") { stop(); if (depth) popTo(depth); else closeMenu(); }
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    stop();
    const step = event.key === "ArrowDown" ? 1 : -1;
    focusItem(level, list[(at + step + list.length) % list.length]);
  } else if (event.key === "ArrowRight") {
    stop();
    const button = list[at];
    if (button && level.items[Number(button.dataset.i)].items) {
      enter(depth, button);
      const inner = stack[depth + 1];
      if (inner) focusItem(inner, buttons(inner)[0]);
    }
  } else if (event.key === "ArrowLeft") { stop(); if (depth) popTo(depth); }
  else if (event.key === "Enter" || event.key === " ") {
    stop();
    if (list[at]) activate(depth, list[at]);
  } else if (event.key === "Tab") stop();
  else if (!event.metaKey && !event.ctrlKey) stop(); // typing doesn't reach the page behind
}, true);

// The menu for a list's column header, the same in every list. `spec`:
//   label, sorts: [{ label, checked, run }], hide(), resetWidth() (when dragged), reset(),
//   columns: [{ label, checked, run }]  (the ones to tick on and off)
export function columnItems(spec) {
  return [
    { heading: spec.label },
    ...(spec.sorts || []),
    spec.sorts?.length && "-",
    spec.hide && { label: "Hide column", icon: svgIcon("M4 4l16 16M10 6.2A9 9 0 0 1 12 6c5 0 8 6 8 6a14 14 0 0 1-2.4 3.1M6.4 7.6A14 14 0 0 0 4 12s3 6 8 6a9 9 0 0 0 3.2-.6"), run: spec.hide },
    spec.resetWidth && { label: "Reset width", icon: svgIcon("M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"), run: spec.resetWidth },
    { label: "Columns", icon: svgIcon("M5 4h14v16H5z", "M10 4v16M15 4v16"), items: spec.columns.map((column) => ({ ...column, keep: true })) },
    { label: "Reset columns", icon: svgIcon("M4 12a8 8 0 1 0 3-6.2M4 4v5h5"), run: spec.reset },
  ];
}
