import { api, escapeHtml, fmtPct, ticker } from "./util.js";

export const FUNDAMENTAL_KEYS = ["earnings_days", "eps_yoy_pct", "revenue_yoy_pct", "eps_acceleration"];
export const FUNDAMENTAL_LABELS = ["Earnings", "EPS Q %", "Sales Q %", "EPS accel"];
const cache = new Map();
const pending = new Set();
const keyOf = (symbol, asof) => `${asof || "today"}:${ticker(symbol)}`;
export const summaryOf = (symbol, asof = null) => cache.get(keyOf(symbol, asof))?.data;

// One batch per list, independent of price loading. Historical scans keep their filing cut.
export function ensureSummaries(symbols, asof, changed) {
  const missing = [...new Set(symbols)].filter((symbol) => {
    const key = keyOf(symbol, asof);
    return !pending.has(key) && (!cache.has(key) || Date.now() - cache.get(key).at > 60000);
  });
  for (let i = 0; i < missing.length; i += 500) {
    const batch = missing.slice(i, i + 500);
    batch.forEach((symbol) => pending.add(keyOf(symbol, asof)));
    api(`/api/earnings?symbols=${encodeURIComponent(batch.join(","))}${asof ? `&asof=${asof}` : ""}`)
      .then(({ symbols: found }) => {
        batch.forEach((symbol) => cache.set(keyOf(symbol, asof), { at: Date.now(), data: found[symbol.toUpperCase()] }));
        changed();
      }).catch(() => {
        batch.forEach((symbol) => cache.set(keyOf(symbol, asof), { at: Date.now(), data: null }));
      }).finally(() => batch.forEach((symbol) => pending.delete(keyOf(symbol, asof))));
  }
}

export function fundamentalText(row, key) {
  const value = row?.[key];
  if (value == null) return "—";
  if (key === "eps_acceleration") return value ? "Yes" : "—";
  if (key !== "earnings_days") return fmtPct(value, 0);
  const event = row.next_earnings;
  return `<span title="${escapeHtml(`${event?.estimated ? "Estimated · " : ""}${event?.date || ""}`)}">${event?.estimated ? "~" : ""}${value}d</span>`;
}
