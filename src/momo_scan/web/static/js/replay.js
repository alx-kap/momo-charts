import { $, store, toast } from "./util.js";
import { state } from "./state.js";
import { activePane, chartPane, replayThrough } from "./chart.js";
import { isSession, previousSession, todayET } from "./earnings.js";

// Bar Replay (TradingView's): pick a bar, hide everything after it, step forward one bar at a
// time. Chart mode only. Every chart follows one replay day, so a symbol or timeframe change
// opens at that day too and a watchlist can be walked as of it.

const SPEEDS = [1, 2, 3, 5, 10]; // bars a second
const PLAY_ICON = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor"/></svg>';
let day = null; // the last session shown; null when not replaying
let timer = null;
let busy = false; // a step is still loading: the next tick waits
let speed = SPEEDS.includes(store.get("replaySpeed")) ? store.get("replaySpeed") : 1;
let hooks = { redraw: async () => {}, onDay: () => {} };

export const replayDay = () => day;
// What a chart loads while replaying: its bars cut at the day, history through a while past it.
export const replayOptions = (interval) => (day ? { replay: true, replayFrom: day, through: replayThrough(day, interval) } : {});

const bar = Object.assign(document.createElement("div"), { className: "example-replay replay-bar", hidden: true });
bar.innerHTML =
  '<span class="rb-title">Replay</span>' +
  '<input type="date" data-day title="Jump to a day">' +
  '<button class="mini" data-pick title="Click a bar to replay from">Select bar</button>' +
  `<button class="mini rb-play" data-play title="Play or pause (⇧↓)">${PLAY_ICON}</button>` +
  '<button class="mini" data-next title="Forward one bar (⇧→)">Forward</button>' +
  `<select data-speed title="Bars a second">${SPEEDS.map((n) => `<option value="${n}">${n}×</option>`).join("")}</select>` +
  '<button class="mini" data-exit title="Exit replay (Esc)">Exit</button>';

// Charts showing a symbol: the left one, and the right one in split view.
const shownPanes = () => [chartPane("left"), chartPane("right")]
  .filter((pane) => pane && !pane.root.hidden && pane.shown().symbol);

function render() {
  bar.hidden = !day;
  document.body.classList.toggle("replaying", Boolean(day));
  $("replay-button").classList.toggle("active", Boolean(day));
  if (!day) return;
  bar.querySelector("[data-day]").value = day;
  bar.querySelector("[data-play]").innerHTML = timer ? PAUSE_ICON : PLAY_ICON;
  bar.querySelector("[data-speed]").value = speed;
}

// Pick the start bar on the active chart; while replaying, a new one.
export async function startReplay() {
  if (state.mode !== "chart" || document.body.classList.contains("practice")) return toast("Bar Replay is in Chart mode");
  const pane = activePane();
  if (!pane.shown().symbol) return;
  pause();
  bar.hidden = true; // the pick prompt takes its place
  const time = await pane.pickBar("Click the bar to replay from");
  render();
  const picked = time == null ? null : pane.replayDayOf(time);
  if (!picked) return;
  if (day) return moveTo(picked);
  day = picked;
  render();
  await hooks.redraw();
}

async function moveTo(next) {
  day = next;
  render();
  busy = true;
  try {
    await Promise.all(shownPanes().map((pane) => pane.replayTo(next)));
  } finally {
    busy = false;
  }
  hooks.onDay(next);
}

async function forward() {
  if (!day || busy) return;
  const next = activePane().replayNext();
  if (!next) {
    pause();
    return toast("Replay reached the newest bar");
  }
  await moveTo(next);
}

function play() {
  if (!day) return;
  if (timer) return pause();
  timer = setInterval(forward, 1000 / speed);
  render();
  forward();
}

function pause() {
  clearInterval(timer);
  timer = null;
  render();
}

export function exitReplay({ redraw = true } = {}) {
  if (!day) return;
  pause();
  day = null;
  render();
  if (redraw) hooks.redraw();
}

// ⇧↓ starts a replay, then plays and pauses it; ⇧→ steps. Esc exits (main.js).
export function replayKey(event) {
  if (state.mode !== "chart" || !event.shiftKey) return false;
  if (event.key === "ArrowDown") day ? play() : startReplay();
  else if (event.key === "ArrowRight" && day) { pause(); forward(); }
  else return false;
  return true;
}

export function bindReplay(options) {
  hooks = { ...hooks, ...options };
  $("charts").appendChild(bar);
  $("replay-button").addEventListener("click", (event) => {
    event.currentTarget.blur();
    day ? exitReplay() : startReplay();
  });
  bar.querySelector("[data-pick]").addEventListener("click", startReplay);
  bar.querySelector("[data-play]").addEventListener("click", play);
  bar.querySelector("[data-next]").addEventListener("click", () => { pause(); forward(); });
  bar.querySelector("[data-exit]").addEventListener("click", () => exitReplay());
  bar.querySelector("[data-speed]").addEventListener("change", (event) => {
    speed = Number(event.target.value);
    store.set("replaySpeed", speed);
    if (timer) { pause(); play(); }
    event.target.blur();
  });
  // A typed or picked day snaps back to its session; the future stays out of reach.
  bar.querySelector("[data-day]").addEventListener("change", (event) => {
    let next = event.target.value;
    if (!day) return;
    if (!next || next >= todayET()) return render();
    if (!isSession(next)) next = previousSession(next);
    pause();
    moveTo(next);
  });
}
