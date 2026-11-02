// The app menu. On a Mac it's the menu bar; on Windows and Linux it stays hidden (Alt is
// momo's) and only lends its keys. A key momo handles itself (⌘Z on a chart, ⌘K) reaches the
// page first; the menu only gets the ones momo leaves alone.

const { Menu, shell } = require("electron");

const MAC = process.platform === "darwin";

function buildMenu(ctl) {
  const window = () => ctl.focused;
  const tabKeys = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? "Last Tab" : `Tab ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`,
    visible: false, acceleratorWorksWhenHidden: true, click: () => window()?.select(i + 1),
  }));
  const settings = {
    label: MAC ? "Settings…" : "Settings", accelerator: "CmdOrCtrl+,",
    click: () => window()?.command("settings"),
  };
  const serverItem = { label: "Server…", click: () => { const w = window(); if (w) w.load(w.current(), { setup: true }); } };
  const updatesItem = { label: "Check for Updates…", click: () => ctl.checkForUpdates() };

  const template = [
    ...(MAC ? [{
      label: "momo",
      submenu: [
        { role: "about", label: "About momo" }, updatesItem, { type: "separator" },
        settings, serverItem, { type: "separator" },
        { role: "services" }, { type: "separator" },
        { role: "hide", label: "Hide momo" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" }, { role: "quit", label: "Quit momo" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => (window() ? window().addTab("/", { after: window().current() }) : ctl.newWindow()) },
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => ctl.newWindow() },
        { label: "Duplicate Tab", accelerator: "CmdOrCtrl+U", click: () => { const w = window(); if (w) w.duplicate(w.active); } },
        { label: "Reopen Closed Tab", accelerator: "CmdOrCtrl+Shift+T", click: () => ctl.reopen() },
        { type: "separator" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => { const w = window(); if (w) w.close(w.active); } },
        { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", click: () => window()?.win.close() },
        ...(MAC ? [] : [{ type: "separator" }, settings, serverItem, updatesItem, { type: "separator" }, { role: "quit" }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => window()?.current()?.view.webContents.reload() },
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => zoom(window(), 0) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => zoom(window(), 0.5) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => zoom(window(), -0.5) },
        { type: "separator" },
        { role: "togglefullscreen" },
        { label: "Developer Tools", accelerator: MAC ? "Alt+Cmd+I" : "Ctrl+Shift+I", click: () => window()?.current()?.view.webContents.toggleDevTools() },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" }, { role: "zoom" }, { type: "separator" },
        { label: "Show Next Tab", accelerator: "Ctrl+Tab", click: () => window()?.step(1) },
        { label: "Show Previous Tab", accelerator: "Ctrl+Shift+Tab", click: () => window()?.step(-1) },
        ...(MAC ? [
          { label: "Next Tab", accelerator: "Cmd+Shift+]", visible: false, acceleratorWorksWhenHidden: true, click: () => window()?.step(1) },
          { label: "Previous Tab", accelerator: "Cmd+Shift+[", visible: false, acceleratorWorksWhenHidden: true, click: () => window()?.step(-1) },
        ] : []),
        ...tabKeys,
        ...(MAC ? [{ type: "separator" }, { role: "front" }] : []),
      ],
    },
    {
      role: "help",
      submenu: [
        { label: "Keyboard Shortcuts", click: () => window()?.command("help") },
        { label: "momo on GitHub", click: () => shell.openExternal("https://github.com/alx-kap/momo-charts") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Every tab of the window zooms together, like a browser zooming one site.
function zoom(window, by) {
  if (!window) return;
  for (const tab of window.tabs) {
    const contents = tab.view.webContents;
    contents.setZoomLevel(by === 0 ? 0 : Math.max(-3, Math.min(3, contents.getZoomLevel() + by)));
  }
}

module.exports = { buildMenu };
