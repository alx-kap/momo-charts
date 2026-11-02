import { $, store, toast } from "./util.js";
import {
  deleteSelected, drawingsHidden, drawingTool, duplicateSelected, onDrawingTool, pickImage, redo, removeAllDrawings, setTool,
  toggleDrawingsHidden, undo,
} from "./drawings.js";
import { armMeasure } from "./measure.js";
import { bindFloatDrag, confirmDialog, FLOAT_GRIP } from "./dialog.js";
import { onChartLoad, onFundamentalsLoad } from "./chart.js";

// The drawing toolbar floats over the charts, like ChartStack's and TradingView's: drag it by
// the grip anywhere over the charts, fold it to the grip with «. Where it sits and whether it's
// folded are kept per browser, along with its visibility.

const icon = (body) => `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="1.9" fill="currentColor" stroke="none"/>`;

const EYE = icon('<path d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="9" cy="9" r="2.2"/>');
const EYE_OFF = icon('<path d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="9" cy="9" r="2.2"/><path d="M2.5 15.5 15.5 2.5"/>');

const TOOLS = [
  ["cursor", "Cursor (Esc)", icon('<path d="M4.5 2.5v11.2l3-2.9 2.1 4.6 2-.9-2.1-4.5h4.2z"/>')],
  "-",
  ["trend", "Trend line (⌥T) · hold Shift to keep it level", icon(`<path d="M3 15 15 3"/>${dot(3, 15)}${dot(15, 3)}`)],
  ["ray", "Ray: a trend line carried on to the edge", icon(`<path d="M3 15 16.5 1.5"/>${dot(3, 15)}${dot(9, 9)}`)],
  ["arrow", "Arrow", icon('<path d="M3 15 14.5 3.5M8.5 3.5h6v6"/>')],
  ["hline", "Horizontal line (⌥H)", icon(`<path d="M1 9h16"/>${dot(9, 9)}`)],
  ["hray", "Horizontal ray (⌥J)", icon(`<path d="M4 9h13"/>${dot(4, 9)}`)],
  ["vline", "Vertical line", icon(`<path d="M9 1v16"/>${dot(9, 9)}`)],
  ["rect", "Rectangle", icon('<rect x="2.5" y="4" width="13" height="10" rx="1"/>')],
  "-",
  ["text", "Text: click where it goes, then type", icon('<path d="M3.5 4.5V2.8h11v1.7M9 2.8v12.4M6.8 15.2h4.4"/>')],
  ["label", "Label: click a point, then click where the text goes", icon(`${dot(3.5, 14.5)}<path d="M4.8 13.2 8.5 9.5"/><rect x="8.2" y="2.8" width="8.3" height="6.7" rx="1.6"/>`)],
  ["image", "Image or GIF: pick a file, or paste or drop one on the chart", icon('<rect x="2.5" y="3.5" width="13" height="11" rx="1.5"/><circle cx="6.5" cy="7.3" r="1.3"/><path d="m2.8 13.2 4-3.7 2.7 2.4 2.2-1.9 3.5 3"/>')],
  ["measure", "Measure: drag over a move for its % change and bars (or Shift+drag)", icon('<path d="M3 15 15 3M5 13l1.6 1.6M7.4 10.6 8.6 11.8M9.8 8.2l1.6 1.6M12.2 5.8l1.2 1.2"/>')],
  "-",
  ["hide", "Hide drawings", EYE],
  ["clone", "Clone the selected drawing", icon('<rect x="6" y="6" width="9.5" height="9.5" rx="1.5"/><path d="M3.5 12V4a1.5 1.5 0 0 1 1.5-1.5h7"/>')],
  ["delete", "Remove the selected drawing (Delete)", icon('<path d="M3 5h12M7 5V3h4v2M4.5 5l.8 10h7.4l.8-10M7.5 8v4.5M10.5 8v4.5"/>')],
  ["clear", "Remove all drawings on this chart", icon('<path d="M3 5h12M7 5V3h4v2M4.5 5l.8 10h7.4l.8-10"/><path d="M7 8.5l4 4M11 8.5l-4 4"/>')],
  "-",
  ["undo", "Undo (Ctrl+Z)", icon('<path d="M6 4 2.5 7.5 6 11"/><path d="M2.5 7.5H11a4.5 4.5 0 0 1 0 9H8"/>')],
  ["redo", "Redo (Ctrl+Shift+Z)", icon('<path d="M12 4l3.5 3.5L12 11"/><path d="M15.5 7.5H7a4.5 4.5 0 0 0 0 9h3"/>')],
];
const DRAWING_TOOLS = new Set(["trend", "ray", "arrow", "hline", "hray", "vline", "rect", "text", "label"]);


let place = store.get("drawBar", null); // { x, y, folded }; null until first moved or folded
let visible = store.get("drawBarVisible", true);
const bar = () => $("draw-bar");

function button([name, title, svg]) {
  const kind = DRAWING_TOOLS.has(name) ? `data-tool="${name}"` : name === "measure" ? "data-measure" : `data-act="${name}"`;
  return `<button class="icon db-btn" ${kind} title="${title}">${svg}</button>`;
}

function build() {
  const el = document.createElement("div");
  el.id = "draw-bar";
  el.innerHTML =
    `<span class="db-grip" title="Drag to move">${FLOAT_GRIP}</span>` +
    `<div class="db-tools">${TOOLS.map((each) => (each === "-" ? '<span class="db-sep"></span>' : button(each))).join("")}</div>` +
    '<button class="icon db-fold" title="Fold the toolbar"></button>';
  $("charts").append(el);
  return el;
}

// Keep the bar inside the charts; before it's been moved it sits bottom centre, clear of the
// legend.
function position() {
  const el = bar();
  el.hidden = !visible;
  if (!visible) return;
  const area = $("charts");
  el.classList.toggle("folded", Boolean(place?.folded));
  el.querySelector(".db-fold").textContent = place?.folded ? "»" : "«";
  el.querySelector(".db-fold").title = place?.folded ? "Show the drawing tools" : "Fold the toolbar";
  const maxX = Math.max(0, area.clientWidth - el.offsetWidth - 4);
  const maxY = Math.max(0, area.clientHeight - el.offsetHeight - 4);
  const x = place?.x ?? (area.clientWidth - el.offsetWidth) / 2;
  const earnings = document.body.classList.contains("mode-chart") && document.querySelector(".earnings-axis:not([hidden])");
  const y = place?.y ?? area.clientHeight - el.offsetHeight - (earnings ? 60 : 40);
  el.style.left = `${Math.round(Math.min(Math.max(4, x), maxX))}px`;
  el.style.top = `${Math.round(Math.min(Math.max(4, y), maxY))}px`;
}

function save(changes) {
  const el = bar();
  place = { x: el.offsetLeft, y: el.offsetTop, ...place, ...changes };
  store.set("drawBar", place);
  position();
}

async function act(name) {
  if (name === "cursor") { setTool(null); armMeasure(false); }
  else if (name === "hide") toggleDrawingsHidden();
  else if (name === "image") { setTool(null); armMeasure(false); pickImage(); }
  else if (name === "clone") duplicateSelected();
  else if (name === "delete") { if (!deleteSelected()) toast("Select a drawing to remove it"); }
  else if (name === "clear") {
    const sure = await confirmDialog({ title: "Remove all drawings on this chart?", message: "Ctrl+Z brings them back.", ok: "Remove all", danger: true });
    if (sure) removeAllDrawings();
  } else if (name === "undo") undo();
  else if (name === "redo") redo();
}

// The cursor is lit when no tool is; the eye is lit while drawings show and crossed out while
// they're hidden.
function reflect() {
  const el = bar();
  el.querySelector('[data-act="cursor"]').classList.toggle("active", !drawingTool());
  const hide = el.querySelector('[data-act="hide"]');
  const off = drawingsHidden();
  hide.classList.toggle("active", !off);
  if (hide.dataset.off !== String(off)) { hide.dataset.off = String(off); hide.innerHTML = off ? EYE_OFF : EYE; }
  hide.title = off ? "Show drawings" : "Hide drawings";
}

// Call before bindDrawings, which wires every [data-tool] button.
export function bindDrawbar() {
  onChartLoad(position);
  onFundamentalsLoad(position);
  const el = build();
  const toggle = $("drawbar-button");
  const reflectVisibility = () => {
    toggle.classList.toggle("active", visible);
    toggle.setAttribute("aria-pressed", String(visible));
    toggle.title = visible ? "Hide drawing toolbar" : "Show drawing toolbar";
    position();
  };
  toggle.addEventListener("click", () => {
    visible = !visible;
    store.set("drawBarVisible", visible);
    toggle.blur();
    reflectVisibility();
  });
  reflectVisibility();
  bindFloatDrag(el, {
    grip: ".db-grip",
    position: (at) => { place = { ...place, ...at }; position(); },
    save,
  });
  el.querySelector(".db-fold").addEventListener("click", () => save({ folded: !place?.folded }));
  el.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.tool) armMeasure(false);
    else if (target.hasAttribute("data-measure")) { setTool(null); armMeasure(); }
    else if (target.dataset.act) act(target.dataset.act);
  });
  el.addEventListener("pointerdown", (event) => event.stopPropagation()); // not a chart click
  onDrawingTool(reflect);
  reflect();
  new ResizeObserver(() => position()).observe($("charts"));
  position();
}
