import { store } from "./util.js";

// TradingView's colour picker: its palette, your custom colours, and an opacity slider.
// Any `<button class="swatch" value="…">` opens it; picking sets the button's value and fires
// "input" (live) and "change" (done) on it, so it behaves like a colour input that knows alpha.

const GREYS = ["#ffffff", "#d1d4dc", "#b2b5be", "#9598a1", "#787b86", "#5d606b", "#434651", "#2a2e39", "#131722", "#000000"];
const MAIN = ["#f23645", "#ff9800", "#ffeb3b", "#4caf50", "#089981", "#00bcd4", "#2962ff", "#673ab7", "#9c27b0", "#e91e63"];
// Lightest to darkest under each main colour.
const SHADES = [
  ["#fccbcd", "#faa1a4", "#f77c80", "#f7525f", "#b22833", "#801922"],
  ["#ffe0b2", "#ffcc80", "#ffb74d", "#ffa726", "#f57c00", "#e65100"],
  ["#fff9c4", "#fff59d", "#fff176", "#ffee58", "#fbc02d", "#f57f17"],
  ["#c8e6c9", "#a5d6a7", "#81c784", "#66bb6a", "#388e3c", "#1b5e20"],
  ["#ace5dc", "#70ccbd", "#42bda8", "#22ab94", "#056656", "#00332a"],
  ["#b2ebf2", "#80deea", "#4dd0e1", "#26c6da", "#0097a7", "#006064"],
  ["#bbd9fb", "#90bff9", "#5b9cf6", "#3179f5", "#1848cc", "#0c3299"],
  ["#d1c4e9", "#b39ddb", "#9575cd", "#7e57c2", "#512da8", "#311b92"],
  ["#e1bee7", "#ce93d8", "#ba68c8", "#ab47bc", "#7b1fa2", "#4a148c"],
  ["#f8bbd0", "#f48fb1", "#f06292", "#ec407a", "#c2185b", "#880e4f"],
];
const CUSTOM_MAX = 20;

let target = null; // the swatch being edited
let current = { hex: "#ffffff", alpha: 1 };
let custom = null; // { h, s, v } while the "+" custom colour view is open

const hex2 = (n) => Math.round(n).toString(16).padStart(2, "0");

// "#rgb", "#rrggbb", "#rrggbbaa" or "rgb(a)(…)" -> { hex: "#rrggbb", alpha }.
export function parseColor(text) {
  const value = String(text || "").trim().toLowerCase();
  let match = /^#([0-9a-f]{3})$/.exec(value);
  if (match) return { hex: `#${[...match[1]].map((c) => c + c).join("")}`, alpha: 1 };
  match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(value);
  if (match) return { hex: `#${match[1]}`, alpha: match[2] ? parseInt(match[2], 16) / 255 : 1 };
  match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value);
  if (match) {
    const alpha = match[4] == null ? 1 : match[4].endsWith("%") ? parseFloat(match[4]) / 100 : Number(match[4]);
    return { hex: `#${hex2(match[1])}${hex2(match[2])}${hex2(match[3])}`, alpha };
  }
  return { hex: "#ffffff", alpha: 1 };
}

export function formatColor(hex, alpha) {
  if (alpha >= 0.995) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${Number(alpha.toFixed(2))})`;
}

export function swatch(value, attrs = "") {
  return `<button type="button" class="swatch" value="${value}" style="--swatch:${value}" ${attrs}></button>`;
}

const customs = () => store.get("customColors", []);

// ---------- HSV, for the custom colour view ----------

function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((x) => x / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }) {
  const f = (k) => {
    const x = (k + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1));
  };
  return `#${[f(5), f(3), f(1)].map((x) => hex2(x * 255)).join("")}`;
}

function cell(hex, title = hex) {
  const on = hex === current.hex ? " on" : "";
  return `<button type="button" class="cp-cell${on}" data-hex="${hex}" style="--c:${hex}" title="${title}"></button>`;
}

function renderCustom() {
  const box = document.getElementById("color-picker");
  const dropper = "EyeDropper" in window
    ? `<button type="button" class="cp-dropper" title="Pick a colour from the screen"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10.5 2.5a1.8 1.8 0 0 1 2.6 2.6l-1.6 1.6.8.8-1 1-4.3-4.3 1-1 .8.8z"/><path d="M8.2 5.5 3 10.7V13h2.3l5.2-5.2"/></svg></button>`
    : "";
  box.innerHTML =
    `<div class="cp-sv"><div class="cp-sv-knob"></div></div>` +
    `<div class="cp-hue"><div class="cp-hue-knob"></div></div>` +
    `<div class="cp-custom-row">${dropper}<span class="cp-preview"><i></i></span>` +
    `<label class="cp-hex">#<input class="cp-hex-input" maxlength="6" spellcheck="false"></label></div>` +
    `<div class="cp-actions"><button type="button" class="cp-cancel">Cancel</button><button type="button" class="cp-ok">Add</button></div>`;
  paintCustom(true);
}

// Move the knobs and preview without rebuilding, so a drag keeps its pointer capture.
function paintCustom(updateHex = true) {
  const box = document.getElementById("color-picker");
  const hex = hsvToHex(custom);
  box.querySelector(".cp-sv").style.setProperty("--hue", `hsl(${custom.h}, 100%, 50%)`);
  const knob = box.querySelector(".cp-sv-knob");
  knob.style.left = `${custom.s * 100}%`;
  knob.style.top = `${(1 - custom.v) * 100}%`;
  knob.style.background = hex;
  const hue = box.querySelector(".cp-hue-knob");
  hue.style.left = `${(custom.h / 360) * 100}%`;
  hue.style.background = `hsl(${custom.h}, 100%, 50%)`;
  box.querySelector(".cp-preview i").style.background = hex;
  if (updateHex) box.querySelector(".cp-hex-input").value = hex.slice(1);
}

function openCustom() {
  custom = hexToHsv(current.hex);
  renderCustom();
  place();
  document.querySelector("#color-picker .cp-hex-input").focus();
}

function closeCustom() {
  custom = null;
  render();
  place();
}

function addCustom() {
  const hex = hsvToHex(custom);
  store.set("customColors", [hex, ...customs().filter((item) => item !== hex)].slice(0, CUSTOM_MAX));
  custom = null;
  pick(hex);
}

// Dragging in the saturation/brightness square or along the hue bar.
function dragIn(area, event, update) {
  const move = (e) => {
    const rect = area.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    update(x, y);
    paintCustom();
  };
  area.setPointerCapture(event.pointerId);
  move(event);
  area.onpointermove = (e) => { if (e.buttons) move(e); };
  area.onpointerup = () => { area.onpointermove = null; area.onpointerup = null; };
}

function render() {
  const box = document.getElementById("color-picker");
  const percent = Math.round(current.alpha * 100);
  box.innerHTML =
    `<div class="cp-grid">${GREYS.map((hex) => cell(hex)).join("")}</div>` +
    `<div class="cp-grid cp-main">${MAIN.map((hex) => cell(hex)).join("")}</div>` +
    `<div class="cp-grid">${[0, 1, 2, 3, 4, 5].map((row) => SHADES.map((col) => cell(col[row])).join("")).join("")}</div>` +
    `<div class="cp-rule"></div>` +
    `<div class="cp-grid cp-custom">${customs().map((hex) => cell(hex)).join("")}` +
    `<button type="button" class="cp-add" title="Add a custom colour">+</button></div>` +
    `<div class="cp-label">Opacity</div>` +
    `<div class="cp-opacity">` +
    `<div class="cp-track" style="--c:${current.hex}"><input type="range" class="cp-range" min="0" max="100" value="${percent}"></div>` +
    `<label class="cp-pct"><input type="number" class="cp-num" min="0" max="100" value="${percent}">%</label>` +
    `</div>`;
}

function apply(type) {
  if (!target) return;
  const value = formatColor(current.hex, current.alpha);
  target.value = value;
  target.style.setProperty("--swatch", value);
  target.dispatchEvent(new Event(type, { bubbles: true }));
}

function setAlpha(percent, type) {
  const box = document.getElementById("color-picker");
  current.alpha = Math.max(0, Math.min(100, Math.round(percent))) / 100;
  box.querySelector(".cp-range").value = Math.round(current.alpha * 100);
  box.querySelector(".cp-num").value = Math.round(current.alpha * 100);
  apply("input");
  if (type === "change") apply("change");
}

function pick(hex) {
  current.hex = hex;
  render();
  apply("input");
  apply("change");
}

export function openColorPicker(button) {
  const box = document.getElementById("color-picker");
  if (target === button && !box.hidden) return closeColorPicker();
  target = button;
  custom = null;
  current = parseColor(button.value);
  render();
  box.hidden = false;
  place();
}

// Under the swatch, or above it when there's no room; again whenever the view changes size.
function place() {
  const box = document.getElementById("color-picker");
  if (!target || box.hidden) return;
  const at = target.getBoundingClientRect();
  const { width, height } = box.getBoundingClientRect();
  const below = at.bottom + 6 + height <= window.innerHeight;
  box.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - width - 8))}px`;
  box.style.top = `${below ? at.bottom + 6 : Math.max(8, at.top - height - 6)}px`;
}

export function closeColorPicker() {
  const box = document.getElementById("color-picker");
  box.hidden = true;
  target = null;
  custom = null;
}

export const colorPickerOpen = () => !document.getElementById("color-picker").hidden;

export function bindColorPicker() {
  const box = document.createElement("div");
  box.id = "color-picker";
  box.hidden = true;
  document.body.appendChild(box);

  document.addEventListener("click", (event) => {
    const button = event.target.closest(".swatch");
    if (button) { event.preventDefault(); openColorPicker(button); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (box.hidden || box.contains(event.target) || event.target.closest(".swatch")) return;
    closeColorPicker();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (box.hidden || event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    if (custom) closeCustom(); // Escape steps back to the palette first
    else closeColorPicker();
  }, true);
  window.addEventListener("resize", () => { if (!box.hidden) closeColorPicker(); });

  box.addEventListener("click", async (event) => {
    const cellButton = event.target.closest(".cp-cell");
    if (cellButton) return pick(cellButton.dataset.hex);
    if (event.target.closest(".cp-add")) return openCustom();
    if (event.target.closest(".cp-cancel")) return closeCustom();
    if (event.target.closest(".cp-ok")) return addCustom();
    if (event.target.closest(".cp-dropper")) {
      try {
        const { sRGBHex } = await new window.EyeDropper().open();
        if (custom) { custom = hexToHsv(parseColor(sRGBHex).hex); paintCustom(); }
      } catch {} // cancelled
    }
  });
  box.addEventListener("pointerdown", (event) => {
    if (!custom || event.button !== 0) return;
    const sv = event.target.closest(".cp-sv");
    const hue = event.target.closest(".cp-hue");
    if (sv) dragIn(sv, event, (x, y) => { custom.s = x; custom.v = 1 - y; });
    else if (hue) dragIn(hue, event, (x) => { custom.h = Math.min(359.9, x * 360); });
  });
  box.addEventListener("input", (event) => {
    if (event.target.classList.contains("cp-hex-input")) {
      const text = event.target.value.replace(/[^0-9a-f]/gi, "");
      if (/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) { custom = hexToHsv(parseColor(`#${text}`).hex); paintCustom(false); }
      return;
    }
    if (event.target.classList.contains("cp-range")) setAlpha(Number(event.target.value), "input");
    else if (event.target.classList.contains("cp-num") && event.target.value !== "") setAlpha(Number(event.target.value), "input");
  });
  box.addEventListener("change", (event) => {
    const el = event.target;
    if (el.classList.contains("cp-range") || el.classList.contains("cp-num")) return setAlpha(Number(el.value || 0), "change");
  });
  // Typing a percentage shouldn't trigger the app's hotkeys.
  box.addEventListener("keydown", (event) => {
    if (event.target.classList.contains("cp-num") && event.key === "Enter") event.target.blur();
    if (event.target.classList.contains("cp-hex-input") && event.key === "Enter") addCustom();
  });
}
