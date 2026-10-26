import { $, store } from "./util.js";
import { scheduleCallouts } from "./chart.js";

// The right sidebar's width: drag the separator between it and the chart, as in TradingView.
// Remembered per device; a double-click puts it back.

const DEFAULT = 340;
const MIN = 260;
const MAX = 640;
const CHART_MIN = 420;

// The panel's right edge: the icon rail's left, where the rail shows.
function edge() {
  const rail = $("rail-right");
  return rail.offsetWidth ? rail.getBoundingClientRect().left : document.querySelector("main").getBoundingClientRect().right;
}

function apply(width) {
  const main = document.querySelector("main");
  const room = main.clientWidth - CHART_MIN;
  const clamped = Math.round(Math.max(MIN, Math.min(width, MAX, Math.max(room, MIN))));
  main.style.setProperty("--side-w", `${clamped}px`);
  main.classList.toggle("compact-sidebar", clamped < 310);
  scheduleCallouts();
  return clamped;
}

export function bindSidebar() {
  const handle = $("side-resizer");
  apply(store.get("sideWidth", DEFAULT));
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("drag");
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!handle.classList.contains("drag")) return;
    apply(edge() - event.clientX);
  });
  const stop = (event) => {
    if (!handle.classList.contains("drag")) return;
    handle.classList.remove("drag");
    document.body.classList.remove("resizing");
    store.set("sideWidth", apply(edge() - event.clientX));
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("dblclick", () => store.set("sideWidth", apply(DEFAULT)));
}
