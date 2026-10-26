import { api, store, toast } from "./util.js";

// How price alerts look and sound (Settings → Alerts). Per account: cached in the browser so the
// lines never flash the wrong colour, saved on the server so they follow you between devices.

const DEFAULTS = { color: "#f0a030", width: 1, style: 2, sound: "chime", volume: 70 };
export const alertPrefs = { ...DEFAULTS, ...store.get("alertPrefs", {}) };
const listeners = [];
let saveTimer = 0;

export const onAlertPrefs = (fn) => listeners.push(fn);

export function setAlertPref(key, value) {
  alertPrefs[key] = value;
  alertPrefs.savedAt = new Date().toISOString();
  store.set("alertPrefs", alertPrefs);
  for (const fn of listeners) fn(key);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api("/api/settings/alert_prefs", { method: "PUT", body: JSON.stringify(alertPrefs) })
      .catch((error) => toast(`Couldn't save alert settings: ${error.message}`));
  }, 500);
}

// The server copy wins unless this browser saved something newer.
export async function syncAlertPrefs() {
  try {
    const { value } = await api("/api/settings/alert_prefs");
    if (!value || (value.savedAt || "") <= (alertPrefs.savedAt || "")) return;
    Object.assign(alertPrefs, DEFAULTS, value);
    store.set("alertPrefs", alertPrefs);
    for (const fn of listeners) fn(null);
  } catch {}
}
