import { $, api, escapeHtml, store, toast } from "./util.js";
import { loadProfile, profileSnapshot } from "./chartsettings.js";
import { panels, setPanels } from "./rails.js";
import { setSideWidth, sideWidth } from "./sidebar.js";
import { confirmDialog, promptDialog } from "./dialog.js";
import { openMenu, svgIcon } from "./contextmenu.js";

// Saved layouts, as TradingView has them: a name for the way the chart is set up. A layout keeps
// the arrangement (one chart or two, their timeframes and sync), each chart's look and
// indicators, and the open panels with the sidebar's width. Not symbols or drawings: those
// follow what you're looking at. The open layout saves as you change things (Autosave, on by
// default); with it off, changes wait for Save. Layouts follow the account; which one is open
// is per computer. The Layouts button, beside the split-view one, lists them.

const MAX = 40;
let data = normalise(store.get("layouts", null)); // { items: [{ id, name, savedAt, data }], savedAt }
let active = store.get("layoutActive", null);
let autosave = store.get("layoutAutosave", true);
let dirty = false; // the open layout differs from what's saved (autosave off)
let busy = false; // a layout is being applied: its changes aren't edits
let app = null; // main.js: { arrangement(), arrange(snapshot) }
let timer = 0;

function normalise(value) {
  const items = Array.isArray(value?.items) ? value.items.filter((item) => item && item.id && item.data) : [];
  return { items, savedAt: value?.savedAt || "" };
}

const find = (id) => data.items.find((item) => item.id === id);
const activeItem = () => (active ? find(active) : null);

let saveTimer = 0;
function persist() {
  data.savedAt = new Date().toISOString();
  store.set("layouts", data);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api("/api/settings/layouts", { method: "PUT", body: JSON.stringify(data) })
      .catch((error) => toast(`Couldn't save layouts: ${error.message}`));
  }, 500);
}

export async function syncLayouts() {
  try {
    const { value } = await api("/api/settings/layouts");
    if (value && (value.savedAt || "") > (data.savedAt || "")) {
      data = normalise(value);
      store.set("layouts", data);
    } else if (!value && data.items.length) {
      persist();
    }
  } catch {}
  if (active && !find(active)) setActive(null);
  render();
}

// ---------- capturing and applying ----------

const capture = () => ({
  arrangement: app.arrangement(),
  charts: { left: profileSnapshot("chart"), right: profileSnapshot("chart_right") },
  panels: { ...panels(), width: sideWidth() },
});

async function apply(snapshot) {
  busy = true;
  try {
    loadProfile("chart", snapshot.charts.left);
    loadProfile("chart_right", snapshot.charts.right);
    setPanels(snapshot.panels);
    if (snapshot.panels.width) setSideWidth(snapshot.panels.width);
    await app.arrange(snapshot.arrangement);
  } finally {
    busy = false;
  }
}

// ---------- the open layout ----------

function setActive(id) {
  active = id;
  dirty = false;
  store.set("layoutActive", id);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Something about the chart changed: save it into the open layout, or mark the layout unsaved.
function touch() {
  if (busy || !app) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const item = activeItem();
    if (!item || busy) return;
    const now = capture();
    if (same(now, item.data)) dirty = false;
    else if (autosave) writeInto(item, now);
    else dirty = true;
    render();
  }, 600);
}

function writeInto(item, snapshot) {
  item.data = snapshot;
  item.savedAt = new Date().toISOString();
  dirty = false;
  persist();
  flashSaved();
}

let savedTimer = 0;
function flashSaved() {
  const mark = $("lm-saved-mark");
  if (!mark) return;
  mark.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => mark.classList.remove("show"), 1400);
}

function uniqueName(base) {
  const taken = new Set(data.items.map((item) => item.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

async function askName(title, value, ok) {
  const answer = await promptDialog({ title, value, placeholder: "Name this layout", ok });
  const name = (answer || "").trim().slice(0, 40);
  return name || null;
}

function add(name, snapshot) {
  const item = { id: Math.random().toString(36).slice(2, 10), name, savedAt: new Date().toISOString(), data: snapshot };
  data.items.push(item);
  persist();
  return item;
}

// ---------- actions ----------

export async function saveAs() {
  if (data.items.length >= MAX) return toast(`Up to ${MAX} layouts`);
  const name = await askName("Save layout as", uniqueName(`Layout ${data.items.length + 1}`), "Save");
  if (!name) return;
  const item = add(uniqueName(name), capture());
  setActive(item.id);
  render();
  toast(`Saved layout “${item.name}”`);
}

export async function openLayout(id) {
  const item = find(id);
  if (!item || id === active) return;
  if (dirty && !autosave && !(await confirmDialog({
    title: `Leave “${activeItem().name}”?`, message: "It has changes you haven't saved.", ok: "Leave", danger: true,
  }))) return;
  const leaving = activeItem();
  if (leaving && autosave) { // a change made in the last moment still goes in
    const now = capture();
    if (!same(now, leaving.data)) writeInto(leaving, now);
  }
  setActive(id);
  render();
  await apply(item.data);
  render();
  toast(`Opened “${item.name}”`);
}

async function rename(item) {
  const name = await askName("Rename layout", item.name, "Rename");
  if (!name || name === item.name) return;
  item.name = uniqueName(name);
  persist();
  render();
}

function duplicate(item) {
  if (data.items.length >= MAX) return toast(`Up to ${MAX} layouts`);
  const copy = add(uniqueName(`${item.name} copy`), structuredClone(item.data));
  setActive(copy.id);
  render();
  apply(copy.data).then(() => toast(`Made “${copy.name}”`));
}

async function remove(item) {
  if (!(await confirmDialog({ title: `Delete “${item.name}”?`, message: "The chart stays as it is.", ok: "Delete", danger: true }))) return;
  data.items = data.items.filter((other) => other !== item);
  if (active === item.id) setActive(null);
  persist();
  render();
}

function saveNow() {
  const item = activeItem();
  if (!item) return;
  writeInto(item, capture());
  render();
  toast(`Saved “${item.name}”`);
}

// Ctrl/⌘+S and the save button: save the open layout, or name a new one.
export function saveLayout() {
  if (!app) return;
  return activeItem() ? saveNow() : saveAs();
}

async function revert() {
  const item = activeItem();
  if (!item) return;
  dirty = false;
  await apply(item.data);
  render();
}

// The ⋯ button's menu, or the right-click menu: `at` is a pointer event or a point.
function more(at, item, from) {
  openMenu(at, [
    { label: "Rename…", icon: svgIcon("M4 20h4L19 9l-4-4L4 16z"), run: () => rename(item) },
    { label: "Make a copy", icon: svgIcon("M9 9h10v10H9z", "M5 15V5h10"), run: () => duplicate(item) },
    item.id === active && dirty && !autosave ? { label: "Revert changes", icon: svgIcon("M5 9l-2 3 3 2M3 12a8 8 0 1 0 2-6"), run: revert } : null,
    item.id === active ? null : { label: "Replace with the current chart", icon: svgIcon("M5 12l4 4 10-10"), run: () => { writeInto(item, capture()); render(); toast(`Updated “${item.name}”`); } },
    "-",
    { label: "Delete", danger: true, icon: svgIcon("M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"), run: () => remove(item) },
  ], from);
}

// ---------- the menu ----------

// One quiet line per layout: its name, and the timeframes it shows.
const summary = ({ arrangement: { split, left, right } }) =>
  (split && right.interval !== left.interval ? [left.interval, right.interval] : [left.interval]).join(" · ");

const CHECK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5l2.8 2.8L11 4.5"/></svg>';

function render() {
  const list = $("lm-saved");
  if (!list) return;
  const item = activeItem();
  const pending = Boolean(item && dirty && !autosave);
  const button = $("layouts-button");
  button.classList.toggle("named", Boolean(item));
  button.classList.toggle("unsaved", pending);
  $("layouts-name").textContent = item ? item.name : "";
  button.title = item ? `Layout “${item.name}”${pending ? " · unsaved changes" : ""}` : "Layouts: saved chart set-ups";
  $("layouts-save").hidden = !pending;
  $("lm-auto").checked = autosave;
  $("lm-auto-row").classList.toggle("off", !item);
  $("lm-save-new").hidden = !data.items.length;
  $("lm-footer").hidden = !data.items.length;
  list.innerHTML = data.items.length ? data.items.map((it) => {
    const on = it.id === active;
    return `<div class="lm-item${on ? " active" : ""}" data-id="${it.id}" tabindex="0" role="button">` +
      `<span class="lm-name"><b>${escapeHtml(it.name)}</b>${on && pending ? '<i class="lm-dot" title="Unsaved changes"></i>' : ""}</span>` +
      `<span class="lm-meta">${escapeHtml(summary(it.data))}</span>` +
      (on && pending ? `<button class="lm-savebtn" data-save>Save</button>` : on ? `<span class="lm-check">${CHECK}</span>` : "") +
      `<button class="lm-more icon" aria-label="More" data-more>⋯</button></div>`;
  }).join("") : `<div class="lm-empty"><span>Keep this set-up (timeframes, indicators, colours, panels) and come back to it in one click.</span>` +
    `<button data-new class="lm-new">Save this layout…</button></div>`;
}

function bindMenu() {
  const menu = $("layouts-menu");
  menu.addEventListener("click", (event) => {
    const target = event.target;
    if (target.closest("[data-new], #lm-save-new")) return saveAs();
    if (target.closest("[data-save]")) return saveNow();
    const row = target.closest(".lm-item");
    if (!row) return;
    if (target.closest("[data-more]")) {
      const rect = target.closest("[data-more]").getBoundingClientRect();
      return more({ clientX: rect.left, clientY: rect.bottom + 4, preventDefault() {} }, find(row.dataset.id), target.closest("[data-more]"));
    }
    openLayout(row.dataset.id);
  });
  menu.addEventListener("keydown", (event) => {
    const row = event.target.closest?.(".lm-item");
    if (row && (event.key === "Enter" || event.key === " ") && event.target === row) {
      event.preventDefault();
      openLayout(row.dataset.id);
    }
  });
  menu.addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".lm-item");
    if (row) more(event, find(row.dataset.id), null);
  });
  $("layouts-save").addEventListener("click", saveNow);
  $("layouts-button").addEventListener("click", (event) => {
    event.currentTarget.blur();
    render();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !event.target.closest(".layouts-wrap, .ctx-root, .dlg-back")) menu.hidden = true;
  });
  $("lm-auto").addEventListener("change", (event) => {
    autosave = event.target.checked;
    store.set("layoutAutosave", autosave);
    if (autosave && dirty) saveNow();
    else render();
  });
}

// Palette commands: save, and open any layout by name.
export const layoutCommands = () => [
  { group: "Commands", label: "Save layout", hint: "⌃S", run: saveLayout },
  { group: "Commands", label: "Save layout as…", hint: "layout", run: saveAs },
  ...data.items.map((item) => ({ group: "Commands", label: `Open layout: ${item.name}`, hint: "layout", run: () => openLayout(item.id) })),
];

export function bindLayouts(hooks) {
  app = hooks;
  bindMenu();
  store.watch(["layout", "interval", "chart", "chart_right", "rightPanel", "leftPanel", "sideWidth"], touch);
  render();
}

export const layoutsMenuOpen = () => !$("layouts-menu").hidden;
export const closeLayoutsMenu = () => { $("layouts-menu").hidden = true; };
