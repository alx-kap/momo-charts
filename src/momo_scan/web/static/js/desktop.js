// The desktop app (desktop/, docs/desktop.md) shows these same pages in its tabs and gives them
// `window.momoDesktop`. Its menu commands land here; in a browser none of this runs.

import { ALT, commandKeys } from "./util.js";

export function bindDesktop(commands) {
  const desktop = window.momoDesktop;
  if (!desktop) return;
  document.documentElement.classList.add("desktop", `desktop-${desktop.platform}`);
  desktop.onCommand((name) => commands[name]?.());
  if (commandKeys) relabel();
}

// On a Mac, ⌘ runs momo's chart keys (main.js), so the page's own shortcut labels (the
// shortcuts dialog, button tooltips) show ⌘ where they say ⌥. ⌥⌘ pairs are left alone.
function relabel() {
  const swap = (text) => text.replace(/⌥(?!⌘)/g, ALT);
  for (const kbd of document.querySelectorAll("kbd")) {
    if (kbd.textContent.includes("⌥")) kbd.textContent = swap(kbd.textContent);
  }
  for (const name of ["title", "data-tip"]) {
    for (const el of document.querySelectorAll(`[${name}*="⌥"]`)) el.setAttribute(name, swap(el.getAttribute(name)));
  }
}
