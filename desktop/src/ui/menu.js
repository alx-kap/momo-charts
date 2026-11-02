// The tab menu. The main process sends what to show ("menu": the tab's title, pinned state,
// what can close and its link state); the menu sends back what was picked. Link changes go to
// the tab's page, which reports its new state, so the menu redraws while it stays open.

const panel = document.getElementById("panel");
let state = null;
let editing = false;

const send = (action, data = {}) => window.shell.send("menu", { action, ...data });
const close = () => send("close");

const ICONS = {
  duplicate: '<rect x="6" y="6" width="9" height="9" rx="1.6"/><path d="M12 3.5H4.6A1.1 1.1 0 0 0 3.5 4.6V12"/>',
  reload: '<path d="M14.5 9a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.6 2.6v2.9h-2.9"/>',
  pin: '<path d="M6 2.8h6M7 2.8v4.4L4.8 10h8.4L11 7.2V2.8M9 10v5.2"/>',
  detach: '<path d="M8 3.5H4.6a1.1 1.1 0 0 0-1.1 1.1v8.8a1.1 1.1 0 0 0 1.1 1.1h8.8a1.1 1.1 0 0 0 1.1-1.1V10"/><path d="M10.5 3.5h4v4M14.5 3.5 8.5 9.5"/>',
  title: '<path d="M3.5 5V3.5h11V5M9 3.5v11M7 14.5h4"/>',
};
const icon = (name) => `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

const SWITCHES = [
  ["symbol", "Symbol", "Change the symbol in one tab and linked tabs follow."],
  ["interval", "Interval", "Change the timeframe in one tab and linked tabs follow."],
  ["time", "Time", "Scroll one chart and linked charts scroll to the same date."],
  ["range", "Date range", "Linked charts show the same dates."],
];
const LIGHT = new Set(["yellow"]); // swatches that take a dark check

function item({ action, label, key = "", iconName = null, disabled = false }) {
  const button = document.createElement("button");
  button.className = `item${iconName ? "" : " plain"}`;
  button.setAttribute("role", "menuitem");
  button.disabled = disabled;
  button.innerHTML = `${iconName ? icon(iconName) : ""}<span class="label"></span><span class="key">${key}</span>`;
  button.querySelector(".label").textContent = label;
  button.addEventListener("click", () => (action === "title-edit" ? edit() : send(action)));
  return button;
}

const sep = () => Object.assign(document.createElement("div"), { className: "sep" });

function render() {
  if (!state) return;
  if (editing) return renderEdit();
  const k = (key) => (state.mac ? `⌘${key}` : `Ctrl+${key}`);
  panel.replaceChildren(
    item({ action: "duplicate", label: "Duplicate tab", key: k("U"), iconName: "duplicate" }),
    item({ action: "reload", label: "Reload tab", key: k("R"), iconName: "reload" }),
    item({ action: "pin", label: state.pinned ? "Unpin tab" : "Pin tab", iconName: "pin" }),
    item({ action: "detach", label: "Detach tab", iconName: "detach", disabled: !state.canDetach }),
    sep(),
    item({ action: "title-edit", label: "Customize tab title…", iconName: "title" }),
    sep(),
    item({ action: "close", label: "Close", key: k("W") }),
    item({ action: "close-others", label: "Close other tabs", disabled: !state.canCloseOthers }),
    item({ action: "close-right", label: "Close tabs to the right", disabled: !state.canCloseRight }),
  );
  if (state.link) renderLink(state.link);
  place();
}

// Tab syncing: the colours (the picked one again unlinks) and that colour's switches.
function renderLink({ color, colors, switches }) {
  panel.append(sep(), Object.assign(document.createElement("div"), { className: "head", textContent: "Tab syncing" }));
  const swatches = Object.assign(document.createElement("div"), { className: "swatches" });
  for (const [name, hex] of Object.entries(colors || {})) {
    const swatch = document.createElement("button");
    swatch.className = `swatch${name === color ? " active" : ""}${LIGHT.has(name) ? " light" : ""}`;
    swatch.title = name[0].toUpperCase() + name.slice(1);
    swatch.style.setProperty("--swatch", hex);
    swatch.addEventListener("click", () => send("link-color", { color: name === color ? null : name }));
    swatches.append(swatch);
  }
  panel.append(swatches);
  for (const [kind, label, help] of SWITCHES) {
    const row = document.createElement("label");
    row.className = `row${color ? "" : " off"}`;
    row.innerHTML = '<span class="label"></span><i class="info">i</i><span class="grow"></span><input type="checkbox" class="switch">';
    row.querySelector(".label").textContent = label;
    row.querySelector(".info").title = help;
    const box = row.querySelector("input");
    box.checked = Boolean(color && switches?.[kind]);
    box.disabled = !color;
    box.addEventListener("change", () => send("link-switch", { kind, on: box.checked }));
    panel.append(row);
  }
  if (!color) panel.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "Pick a colour: tabs of one colour follow each other." }));
}

function edit() {
  editing = true;
  render();
}

function renderEdit() {
  panel.innerHTML = '<div class="edit"><div class="head">Tab title</div><input maxlength="60" spellcheck="false">'
    + '<div class="buttons"><button data-do="reset">Reset</button><button class="primary" data-do="save">Save</button></div></div>';
  const input = panel.querySelector("input");
  input.value = state.custom || "";
  input.placeholder = state.title || "Tab title";
  const save = () => send("title", { title: input.value });
  panel.querySelector('[data-do="save"]').addEventListener("click", save);
  panel.querySelector('[data-do="reset"]').addEventListener("click", () => send("title", { title: "" }));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save();
  });
  place();
  input.focus();
  input.select();
}

// At the pointer, kept inside the window.
function place() {
  panel.hidden = false;
  const { width, height } = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(state.x, innerWidth - width - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(state.y, innerHeight - height - 8))}px`;
}

window.shell.on("menu", (next) => {
  const reopened = !state || next.serial !== state.serial;
  state = next;
  if (reopened) editing = false;
  render();
});
document.addEventListener("pointerdown", (event) => { if (!panel.contains(event.target)) close(); });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (editing) { editing = false; render(); } else close();
});
document.addEventListener("contextmenu", (event) => event.preventDefault());
