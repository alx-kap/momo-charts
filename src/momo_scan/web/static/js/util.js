export const $ = (id) => document.getElementById(id);

export const store = {
  get: (key, fallback) => {
    try { const v = localStorage.getItem("momo." + key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set: (key, value) => localStorage.setItem("momo." + key, JSON.stringify(value)),
};

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
