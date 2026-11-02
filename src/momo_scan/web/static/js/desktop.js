// The desktop app (desktop/, docs/desktop.md) shows these same pages in its tabs and gives them
// `window.momoDesktop`. Its menu commands land here; in a browser none of this runs.

export function bindDesktop(commands) {
  const desktop = window.momoDesktop;
  if (!desktop) return;
  document.documentElement.classList.add("desktop", `desktop-${desktop.platform}`);
  desktop.onCommand((name) => commands[name]?.());
}
