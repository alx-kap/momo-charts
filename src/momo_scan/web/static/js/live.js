import { $, api, ticker, toast } from "./util.js";

// Live prices. One socket per tab to the momo server, which holds the one upstream feed
// (Schwab, or SIM while building). Parts of the app say which symbols they show with
// watchLive(key, symbols); the server streams quotes for the union. Quotes are handed to
// listeners once per animation frame, however many arrived.

const wanted = new Map(); // consumer ("chart", "watchlist") -> tickers
// The server keeps the first few hundred symbols a tab asks for, so the most visible go first.
const PRIORITY = ["chart", "hover", "details", "screener", "scanlist", "watchlist"];
const wantedBars = new Map(); // consumer -> tickers whose finished minute bars it wants
const wantedBuzz = new Map(); // consumer -> tickers it shows Volume Buzz for
const listeners = [];
const barListeners = [];
const buzzListeners = [];
let socket = null;
let sent = "";
let sentBars = "";
let sentBuzz = "";
let status = null;
let retry = 0;
let pending = new Map(); // ticker -> newest quote since the last frame
let frame = 0;
let owner = false;
const statusListeners = [];
const SOON_HOURS = 24; // warn this long before the Schwab sign-in runs out

// The Live data section of the settings dialog: null when there's nothing to set up (no feed,
// or not the owner), else { line, button } for it to draw. fn() runs when the feed's state changes.
export const onLiveStatus = (fn) => statusListeners.push(fn);
export function liveSetup() {
  if (!owner || !status || !status.provider) return null;
  const live = status.state === "live";
  const hours = status.sign_in_by ? (status.sign_in_by * 1000 - Date.now()) / 3_600_000 : null;
  const signIn = Boolean(status.sign_in);
  const expiring = live && hours != null && hours < SOON_HOURS;
  const line = signIn ? "Schwab sign-in needed for live prices."
    : expiring ? `Schwab sign-in runs out in ${Math.max(0, hours).toFixed(0)}h.`
    : live ? (status.simulated ? "Simulated prices for testing, not real."
      : `Live prices from ${status.provider}${status.mode === "poll" ? ", refreshed every second" : status.mode === "stream" ? ", streaming" : ""}.`)
    : `Feed ${status.state}${status.error ? `: ${status.error}` : ""}. Showing the last close.`;
  const button = status.provider !== "schwab" ? null : signIn ? "Sign in to Schwab…" : "Renew Schwab sign-in…";
  return { line, button };
}

// Market data setup (owner): Schwab's keys, the sign-in and momo's own daily bars, from
// /api/live/setup: { fill, keys, signed_in, needed, bars: { stocks, filled, through, error } }.
let setup = null;
let setupTimer = 0;
export const marketSetup = () => setup;
export async function refreshSetup() {
  clearTimeout(setupTimer);
  if (!owner) return;
  try { setup = await api("/api/live/setup"); } catch { return; }
  statusListeners.forEach((fn) => fn());
  // While the store fills, its progress line keeps up.
  if (setup.bars && setup.bars.filled < setup.bars.stocks) setupTimer = setTimeout(refreshSetup, 10_000);
}
export async function saveSchwabKeys(keys) {
  setup = await api("/api/live/schwab/keys", { method: "POST", body: JSON.stringify(keys) });
  statusListeners.forEach((fn) => fn());
  refreshSetup();
}

export const onLiveQuotes = (fn) => listeners.push(fn); // fn(Map ticker -> quote)
export const onLiveBars = (fn) => barListeners.push(fn); // fn(ticker, [[t, o, h, l, c, v], ...])
// fn(Map ticker -> {session: "pre"|"regular"|"post", day, pct, volume}); see momo_scan/buzz.py
export const onLiveBuzz = (fn) => buzzListeners.push(fn);
export const liveNow = () => Boolean(status && status.state === "live");
const alertListeners = [];
export const onLiveAlerts = (fn) => alertListeners.push(fn); // fn([alert, ...]): price alerts that fired

export function startLive(me) {
  owner = Boolean(me && me.owner);
  if (me && me.live) connect();
  refreshSetup();
}

export function watchLive(key, symbols) {
  wanted.set(key, symbols.map(ticker));
  sendWatch();
}

// Intraday charts: the stream's finished 1-minute bars for these symbols.
export function watchBars(key, symbols) {
  wantedBars.set(key, symbols.map(ticker));
  sendWatch();
}

// Volume Buzz for these symbols: the server streams their minute bars and works it out.
export function watchBuzz(key, symbols) {
  wantedBuzz.set(key, symbols.map(ticker));
  sendWatch();
}

// A live value changed: show it, then mark the change for a moment. Price moves tint green or
// red (TradingView); anything else, such as volume, just goes bold (TC2000).
export function flashCell(el, html, direction = 0) {
  if (!el || el.innerHTML === html) return;
  el.innerHTML = html;
  el.classList.remove("tick", "tick-up", "tick-down");
  void el.offsetWidth; // restart the animation
  el.classList.add(direction > 0 ? "tick-up" : direction < 0 ? "tick-down" : "tick");
}

function connect() {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
  socket.onopen = () => { retry = 0; sent = ""; sentBars = ""; sentBuzz = ""; sendWatch(); };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.status) setStatus(message.status);
    if (message.alerts) for (const fn of alertListeners) fn(message.alerts);
    if (message.bars) {
      for (const [symbol, rows] of Object.entries(message.bars)) for (const fn of barListeners) fn(symbol, rows);
    }
    if (message.buzz) {
      const buzz = new Map(Object.entries(message.buzz));
      for (const fn of buzzListeners) fn(buzz);
    }
    if (message.quotes) {
      for (const [symbol, quote] of Object.entries(message.quotes)) pending.set(symbol, quote);
      if (!frame) frame = requestAnimationFrame(flush);
    }
  };
  socket.onclose = (event) => {
    socket = null;
    if (event.code === 4403) return setStatus(null); // not allowed live prices: stay on closes
    setStatus(status && status.provider ? { ...status, state: "reconnecting", error: null } : null);
    setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
  };
}

function flush() {
  frame = 0;
  const batch = pending;
  pending = new Map();
  for (const fn of listeners) fn(batch);
}

// A hidden tab watches nothing, so it costs the feed nothing.
function sendWatch() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const rank = (key) => PRIORITY.indexOf(key.split(":")[0]); // "chart:right" ranks as "chart"
  const keys = [...wanted.keys()].sort((a, b) => rank(a) - rank(b));
  const symbols = document.hidden ? [] : [...new Set(keys.flatMap((key) => wanted.get(key)))];
  const key = symbols.join(",");
  if (key !== sent) {
    sent = key;
    socket.send(JSON.stringify({ op: "watch", symbols }));
  }
  const bars = document.hidden ? [] : [...new Set([...wantedBars.values()].flat())];
  if (bars.join(",") !== sentBars) {
    sentBars = bars.join(",");
    socket.send(JSON.stringify({ op: "watch_bars", symbols: bars }));
  }
  const buzz = document.hidden ? [] : [...new Set([...wantedBuzz.values()].flat())];
  if (buzz.join(",") !== sentBuzz) {
    sentBuzz = buzz.join(",");
    socket.send(JSON.stringify({ op: "watch_buzz", symbols: buzz }));
  }
}
document.addEventListener("visibilitychange", sendWatch);

function setStatus(next) {
  status = next;
  const badge = $("live-status");
  const off = !next || !next.provider;
  $("live-row").hidden = off;
  $("live-dot").hidden = off;
  for (const fn of statusListeners) fn();
  if (off) return;
  const live = next.state === "live";
  const hours = next.sign_in_by ? (next.sign_in_by * 1000 - Date.now()) / 3_600_000 : null;
  const signIn = next.sign_in && owner;
  const expiring = live && owner && hours != null && hours < SOON_HOURS;
  const kind = signIn ? "sign-in" : expiring ? "expiring" : live ? (next.simulated ? "sim" : "on") : "down";
  badge.className = `live-badge ${kind}`;
  $("live-dot").className = `live-dot ${kind}`;
  badge.textContent = signIn ? "SIGN IN" : live ? (next.simulated ? "SIM" : "LIVE") : "DELAYED";
  badge.title = signIn ? "Schwab sign-in needed for live prices: click to sign in"
    : expiring ? `Schwab sign-in runs out in ${Math.max(0, hours).toFixed(0)}h: click to renew for 7 days`
    : live ? (next.simulated ? "Simulated prices for testing, not real" : `Live prices from ${next.provider}${next.mode === "poll" ? ", refreshed every second" : next.mode === "stream" ? ", streaming" : ""}`)
    : `Live feed ${next.state}${next.error ? `: ${next.error}` : ""}. Showing the last close.`;
}

// ---------- extended hours ----------

function easternNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return { ...parts, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// The trading session now, by the exchange's clock: "pre" (4:00-9:30 ET), "regular", "post"
// (16:00-20:00) or null (overnight, weekends).
export function marketSession() {
  const now = easternNow();
  if (now.weekday === "Sat" || now.weekday === "Sun") return null;
  const m = now.minutes;
  return m >= 240 && m < 570 ? "pre" : m >= 570 && m < 960 ? "regular" : m >= 960 && m < 1200 ? "post" : null;
}

// Pre- or post-market: the last trade outside the regular session, and its move from the
// regular session's last price (the previous close before the open, today's close after it).
export function extendedQuote(quote) {
  if (!quote || marketSession() === "regular" || !quote.trade || !quote.last) return null;
  return { price: quote.trade, pct: (quote.trade / quote.last - 1) * 100 };
}

// Pre- or post-market volume so far: Schwab's total before the open (it ticks with every
// trade); after the close, the post-market minute bars behind Post Buzz.
export function extendedVolume(quote, buzz) {
  const session = marketSession();
  if (session === "pre") return quote && quote.pre_volume != null ? quote.pre_volume : null;
  if (session === "post") return buzz && buzz.session === "post" ? buzz.volume : null;
  return null;
}

// The Buzz column's name follows the session, as in TC2000.
export const buzzLabel = (buzz) => ({ pre: "Pre Buzz", post: "Post Buzz" })[buzz && buzz.session] || "Buzz";
export const buzzText = (buzz) => (buzz && buzz.pct != null ? `${buzz.pct >= 0 ? "+" : ""}${Math.round(buzz.pct)}%` : "—");
export const buzzTitle = "Volume Buzz: volume so far vs the usual by this time of day (last 20 sessions). " +
  "Pre Buzz 7:00-9:30 ET, Buzz 9:30-16:00, Post Buzz 16:00-20:00; between sessions, the last day's final Buzz.";

// The session the Buzz column shows now (see momo_scan/buzz.py), so headers can follow it.
export function buzzSession() {
  const now = easternNow();
  if (now.weekday === "Sat" || now.weekday === "Sun") return "regular";
  const m = now.minutes;
  return m >= 420 && m < 570 ? "pre" : m >= 965 && m < 1200 ? "post" : "regular";
}

// Session changes re-label headers and swap what the extended-hours columns show.
const sessionListeners = [];
let sessionKey = "";
export const onSessionChange = (fn) => sessionListeners.push(fn);
setInterval(() => {
  const key = `${marketSession()}/${buzzSession()}`;
  if (sessionKey && key !== sessionKey) for (const fn of sessionListeners) fn();
  sessionKey = key;
}, 20_000);

// How much of the regular session (9:30-16:00 ET) has gone by, so relative volume compares
// today's volume so far with the same share of an average day. A straight line: volume runs
// heavy at the open, so early readings run high.
const SESSION_MINUTES = 390;
export function sessionDone(day) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  if (`${parts.year}-${parts.month}-${parts.day}` !== day) return 1; // a finished session
  const minutes = Number(parts.hour) * 60 + Number(parts.minute) - (9 * 60 + 30);
  return Math.min(1, Math.max(15, minutes) / SESSION_MINUTES);
}

// ---------- Schwab sign-in (owner, every 7 days) ----------

export const signInOpen = () => !$("sign-in-box").hidden;

export async function openSignIn() {
  if (!owner || !status || status.provider !== "schwab") return;
  try {
    $("si-link").href = (await api("/api/live/schwab/sign-in")).url;
  } catch (error) {
    return toast(`Couldn't start the sign-in: ${error.message}`);
  }
  $("sign-in-box").hidden = false;
  $("si-input").value = "";
  $("si-input").focus();
}

function closeSignIn() {
  $("sign-in-box").hidden = true;
  $("si-input").blur();
}

async function finishSignIn() {
  const redirect = $("si-input").value.trim();
  if (!redirect) return;
  closeSignIn();
  try {
    await api("/api/live/schwab/sign-in", { method: "POST", body: JSON.stringify({ redirect }) });
    toast("Signed in to Schwab for 7 days");
    refreshSetup();
  } catch (error) {
    toast(`Schwab sign-in failed: ${error.message}`, 4000);
  }
}

// The badge is the at-a-glance state; its setup lives in the settings dialog.
$("live-status").addEventListener("click", (event) => {
  $("settings").hidden = true;
  if (owner) document.dispatchEvent(new CustomEvent("momo:open-settings", { detail: "live" }));
});
$("si-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); finishSignIn(); }
  else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSignIn(); }
});
