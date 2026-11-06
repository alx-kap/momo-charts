import { $, escapeHtml } from "./util.js";
import { changeIndicators, chartSettings, removeIndicator, toggleIndicator } from "./chartsettings.js";
import { swatch } from "./colorpicker.js";
import { INDICATORS, TIMEFRAMES } from "./indicators.js";

// The settings of one indicator on the chart, in a small popover opened from its legend row, a
// double-click on its line, or the browser's On the chart list. Changes apply as they're made.

let id = null;
let changed = () => {};

const item = () => chartSettings.indicators.find((each) => each.id === id);

export const indicatorSettingsOpen = () => !$("ip").hidden;

export function closeIndicatorSettings() {
  $("ip").hidden = true;
  id = null;
}

function timeframes(ind) {
  const off = new Set(ind.hiddenOn || []);
  const chip = (tf) => `<button data-tf="${tf}" class="${off.has(tf) ? "" : "on"}" title="${off.has(tf) ? "Off" : "On"} on ${tf} charts">${tf}</button>`;
  const intraday = TIMEFRAMES.filter((tf) => !/^[DWM]$/.test(tf));
  return `<div class="cs-tf">${intraday.map(chip).join("")}<i></i>${["D", "W", "M"].map(chip).join("")}</div>`;
}

function render() {
  const ind = item();
  if (!ind) { closeIndicatorSettings(); return; }
  const def = INDICATORS[ind.type];
  const row = (label, control) => `<div class="ip-row"><span>${escapeHtml(label)}</span><div>${control}</div></div>`;
  const inputs = def.inputs.map((input) => row(input.label,
    `<input type="number" data-param="${input.key}" value="${ind.params[input.key]}" min="${input.min}" max="${input.max}" step="${input.step || 1}">`)).join("");
  const colors = def.plots.map((plot) => row(plot.label,
    swatch(escapeHtml(ind.style[plot.key].color), `data-plot="${plot.key}" title="${escapeHtml(plot.label)}"`) +
    (plot.color2 ? swatch(escapeHtml(ind.style[plot.key].color2), `data-plot="${plot.key}" data-second="1" title="${escapeHtml(plot.label)} (falling)"`) : ""))).join("");
  const line = def.plots.find((plot) => plot.type !== "histogram");
  const width = line ? row("Line width", `<select data-width="1">${[1, 2, 3, 4].map((n) =>
    `<option value="${n}" ${ind.style[line.key].width === n ? "selected" : ""}>${n}px</option>`).join("")}</select>`) : "";
  $("ip").innerHTML = `<div class="ip-head"><b title="${escapeHtml(def.name)}">${escapeHtml(def.label(ind.params))}</b>` +
    `<button class="icon" data-eye="1" title="${ind.visible ? "Hide" : "Show"}">${ind.visible ? "◉" : "○"}</button>` +
    `<button class="icon" data-close="1" title="Close (Esc)" aria-label="Close">×</button></div>` +
    inputs + colors + width + row("Value in legend", `<input type="checkbox" data-value="1" ${ind.hideValue ? "" : "checked"}>`) +
    `<div class="ip-h">Show on</div>${timeframes(ind)}` +
    `<button class="ip-remove" data-remove="1">Remove</button>`;
}

function place(x, y) {
  const box = $("ip");
  box.style.left = `${Math.max(8, Math.min(x, innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${Math.max(48, Math.min(y, innerHeight - box.offsetHeight - 8))}px`;
}

// Opens the settings of indicator `indicatorId` at (x, y). `onChange` hears of any change.
export function openIndicatorSettings(indicatorId, x, y, onChange = () => {}) {
  id = indicatorId;
  changed = onChange;
  $("ip").hidden = false;
  render();
  place(x, y);
}

function onField(event) {
  const el = event.target;
  const ind = item();
  if (!ind) return;
  if (el.dataset.param) {
    const value = Number(el.value);
    const input = INDICATORS[ind.type].inputs.find((each) => each.key === el.dataset.param);
    if (el.value === "" || !Number.isFinite(value) || value <= 0 || value < input.min || value > input.max) {
      if (event.type === "change") el.value = ind.params[el.dataset.param]; // nothing valid: back to what's drawn
      return;
    }
    if (value === ind.params[el.dataset.param]) return;
    changeIndicators(() => { ind.params[el.dataset.param] = value; }, `${ind.id} ${el.dataset.param}`);
    $("ip").querySelector("b").textContent = INDICATORS[ind.type].label(ind.params);
  } else if (el.dataset.plot) {
    if (ind.style[el.dataset.plot][el.dataset.second ? "color2" : "color"] === el.value) return; // "input", then "change"
    changeIndicators(() => { ind.style[el.dataset.plot][el.dataset.second ? "color2" : "color"] = el.value; }, `${ind.id} ${el.dataset.plot}`);
  } else if (el.dataset.value) {
    if (event.type !== "change") return;
    changeIndicators(() => { ind.hideValue = !el.checked; });
  } else if (el.dataset.width) {
    changeIndicators(() => { for (const plot of Object.values(ind.style)) plot.width = Number(el.value); });
  }
  changed();
}

function onClick(event) {
  const button = event.target.closest("button");
  const ind = item();
  if (!button || !ind) return;
  if (button.dataset.close) closeIndicatorSettings();
  else if (button.dataset.remove) {
    removeIndicator(ind.id);
    closeIndicatorSettings();
    changed();
  } else if (button.dataset.eye) {
    toggleIndicator(ind.id);
    render();
    changed();
  } else if (button.dataset.tf) {
    const tf = button.dataset.tf;
    changeIndicators(() => {
      const off = new Set(ind.hiddenOn || []);
      if (off.has(tf)) off.delete(tf);
      else off.add(tf);
      ind.hiddenOn = TIMEFRAMES.filter((each) => off.has(each));
    });
    render();
  }
}

export function bindIndicatorSettings() {
  const box = $("ip");
  box.addEventListener("input", onField);
  box.addEventListener("change", onField);
  box.addEventListener("click", onClick);
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation(); // the page's Esc would only leave the field
    closeIndicatorSettings();
  });
  document.addEventListener("pointerdown", (event) => {
    if (box.hidden || event.target.closest("#ip, #color-picker")) return;
    closeIndicatorSettings();
  }, true);
}
