// Which engine draws the charts: momo's own (js/engine/, the default) or TradingView's
// Lightweight Charts, kept until it's removed. Open momo with ?engine=lwc to switch this browser
// back to Lightweight Charts and ?engine=momo to return; the choice is remembered.
import * as momo from "./engine/index.js";
import { store } from "./util.js";

const asked = new URLSearchParams(location.search).get("engine");
if (asked === "momo" || asked === "lwc") store.set("engine", asked);

export const engine = store.get("engine", "momo") === "lwc" && window.LightweightCharts ? "lwc" : "momo";
export const LC = engine === "momo" ? momo : window.LightweightCharts;
