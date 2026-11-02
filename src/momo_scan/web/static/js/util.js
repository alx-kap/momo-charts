export const $ = (id) => document.getElementById(id);

// The modifier momo's chart keys are shown with (⌥T, ⌥W…). In the desktop app on a Mac, ⌘ does
// the same (desktop.js), and ⌘ is what the labels show; ⌥ still works.
export const commandKeys = window.momoDesktop?.platform === "darwin";
export const ALT = commandKeys ? "⌘" : "⌥";

export const store = {
  get: (key, fallback) => {
    try { const v = localStorage.getItem("momo." + key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set: (key, value) => {
    const text = JSON.stringify(value);
    const before = localStorage.getItem("momo." + key);
    localStorage.setItem("momo." + key, text);
    if (followed.has(key) && text !== before) prefsChanged();
  },
  // These keys follow the account between computers (saved as the "prefs" setting).
  follow: (keys) => {
    for (const key of keys) followed.add(key);
    // Nothing on the server yet, or this browser changed them since: send this browser's. (Not
    // when the server couldn't be asked: its copy may be newer.)
    if (prefsKnown && (!serverPrefs || store.get("prefsSavedAt", "") > (serverPrefs.savedAt || ""))) prefsChanged(false);
  },
};

// Preferences kept in the browser that follow the account: the server's copy is written into
// this browser before any module reads it, unless this browser saved something newer.
const followed = new Set();
let serverPrefs = null;
let prefsKnown = false; // the server answered at load
let prefsTimer = 0;

function prefsChanged(stamp = true) {
  if (stamp) localStorage.setItem("momo.prefsSavedAt", JSON.stringify(new Date().toISOString()));
  // The server didn't answer at load, so its copy may be newer: keep the change here, and the
  // next load sends it if it's still the newest.
  if (!prefsKnown) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const savedAt = store.get("prefsSavedAt", "") || new Date().toISOString();
    const values = Object.fromEntries([...followed].map((key) => [key, store.get(key, null)]).filter(([, v]) => v !== null));
    serverPrefs = { savedAt, values };
    api("/api/settings/prefs", { method: "PUT", body: JSON.stringify(serverPrefs) })
      .catch((error) => toast(`Couldn't save settings: ${error.message}`));
  }, 600);
}

async function loadPrefs() {
  try {
    const timeout = new Promise((resolve) => setTimeout(resolve, 1500, null));
    const response = await Promise.race([fetch("/api/settings/prefs"), timeout]);
    if (!response?.ok) return;
    serverPrefs = (await response.json()).value;
    prefsKnown = true;
  } catch {
    return;
  }
  if (!serverPrefs || (serverPrefs.savedAt || "") <= store.get("prefsSavedAt", "")) return;
  for (const [key, value] of Object.entries(serverPrefs.values || {})) localStorage.setItem("momo." + key, JSON.stringify(value));
  localStorage.setItem("momo.prefsSavedAt", JSON.stringify(serverPrefs.savedAt));
}

export const narrow = () => window.matchMedia("(max-width: 820px)").matches;

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const fmtPrice = (v) => v == null ? "—" : v.toFixed(Math.abs(v) < 1 && v !== 0 ? 4 : 2);
export function fmtBig(v, prefix = "") {
  if (v == null) return "—";
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, unit] of units) if (Math.abs(v) >= size) return prefix + (v / size).toFixed(2) + unit;
  return prefix + v.toFixed(0);
}
export const fmtPct = (v, digits = 2) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
export const ticker = (symbol) => symbol.split(":").pop();

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Momo": "1", ...(options.headers || {}) },
  });
  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return response.json();
}

let toastTimer = null;
export function toast(text, ms = 1600) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  $("toast").classList.remove("show");
  void $("toast").offsetWidth;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, ms);
}

export function typing(target) {
  return target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
}

// Tags are stored lowercase; show the acronyms properly.
export const tagLabel = (tag) => tag.replace(/\bmas\b/g, "MAs").replace(/\b(rs|ma|adr|ep)\b/g, (m) => m.toUpperCase());

await loadPrefs();
