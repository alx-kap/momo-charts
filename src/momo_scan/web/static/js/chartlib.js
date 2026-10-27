// Which engine draws the charts: TradingView's Lightweight Charts (the default for now) or momo's
// own (js/engine/), which is replacing it. Open momo with ?engine=momo to switch this browser to
// momo's engine and ?engine=lwc to switch back; the choice is remembered.
import * as momo from "./engine/index.js";
import { store } from "./util.js";

const asked = new URLSearchParams(location.search).get("engine");
if (asked === "momo" || asked === "lwc") store.set("engine", asked);

export const engine = store.get("engine", "lwc") === "momo" ? "momo" : "lwc";
export const LC = engine === "momo" ? momo : window.LightweightCharts;
