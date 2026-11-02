// momo's desktop app: the same momo server and web app as the browser, in native windows with
// tabs. It shows a momo server you run elsewhere ("server" mode) or runs one itself on this
// computer ("local" mode, local.js). Plan: docs/desktop.md.
//
// Environment, for checks and development:
//   MOMO_DESKTOP_PROFILE   a data folder instead of the user's (settings, open tabs)
//
// Run from source (`npm run dev`), the app keeps its own data folder ("momo-dev"), so it opens
// beside an installed momo instead of handing over to it, marks its tab strip "dev" and skips
// the update check.
//   MOMO_DESKTOP_READONLY  1: refuse every request that would change momo (PUT/POST/DELETE)
//   MOMO_DESKTOP_RELEASES  where to look for new versions (updates.js)

const path = require("node:path");
const { app, dialog, ipcMain, session, shell } = require("electron");
const local = require("./local");
const { buildMenu } = require("./menu");
const server = require("./server");
const store = require("./store");
const updates = require("./updates");
const { MomoWindow } = require("./window");

app.setName("momo");
if (process.env.MOMO_DESKTOP_PROFILE) app.setPath("userData", process.env.MOMO_DESKTOP_PROFILE);
else if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "momo-dev"));
if (!app.requestSingleInstanceLock()) app.exit(0);

const ctl = {
  settings: store.read("settings.json", { mode: null, server: null, localPort: 0 }),
  windows: new Set(),
  focused: null,
  recent: [], // closed tabs' addresses, for Reopen Closed Tab
  quitting: false,
  saveTimer: null,

  // "server", "local", or null before setup (an address saved before local mode was "server").
  mode() {
    return this.settings.mode || (this.settings.server ? "server" : null);
  },
  // The address tabs open; null while the local server starts, or when it couldn't.
  server() {
    return this.mode() === "local" ? local.origin() : this.settings.server;
  },
  starting() {
    return this.mode() === "local" && local.starting();
  },
  saveSettings() {
    store.write("settings.json", this.settings);
  },

  // Start momo on this computer; tabs show "Starting momo…" until it answers.
  async startLocal() {
    const started = this.local();
    this.reconnect();
    try {
      await started;
    } catch {
      // The tabs' offline page says why (local.failure()) and tries again.
    }
    this.reconnect();
  },
  local() {
    return local.start({ port: this.settings.localPort, onPort: (port) => {
      this.settings.localPort = port;
      this.saveSettings();
    } });
  },

  open(saved) {
    const window = new MomoWindow(this, saved);
    this.windows.add(window);
    this.focused = window;
    return window;
  },

  // A new window opens a little below and right of the current one.
  newWindow() {
    const from = this.focused?.win.getBounds();
    const bounds = from && { ...from, x: from.x + 28, y: from.y + 28 };
    this.open({ bounds, tabs: ["/"] });
  },

  restore() {
    const { windows } = store.read("state.json", { windows: [] });
    if (!windows.length) return this.open();
    for (const saved of windows) this.open(saved);
  },

  // Open windows and tabs, written half a second after the last change.
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  },
  saveNow() {
    clearTimeout(this.saveTimer);
    if (this.windows.size) store.write("state.json", { windows: [...this.windows].map((w) => w.snapshot()) });
  },

  // Closing the last window keeps its tabs for next time; closing one of several forgets it.
  closing() {
    if (this.windows.size === 1 && !this.quitting) this.saveNow();
  },
  closed(window) {
    this.windows.delete(window);
    if (this.focused === window) this.focused = [...this.windows].at(-1) || null;
    if (this.windows.size && !this.quitting) this.save();
  },

  remember(address) {
    this.recent.push(address);
    if (this.recent.length > 20) this.recent.shift();
  },
  reopen() {
    const address = this.recent.pop();
    if (!address) return;
    if (this.focused) this.focused.addTab(address);
    else this.open({ tabs: [address] });
  },

  reconnect() {
    for (const window of this.windows) window.reconnect();
  },

  update() {
    const release = updates.available();
    return release && release.version;
  },
  openUpdate() {
    const release = updates.available();
    if (release) shell.openExternal(release.url);
  },
  async checkForUpdates() {
    try {
      const release = await updates.check();
      if (!release) {
        await dialog.showMessageBox({ message: "momo is up to date.", detail: `Version ${app.getVersion()}` });
        return;
      }
      const { response } = await dialog.showMessageBox({
        message: `momo ${release.version} is available.`,
        detail: `You have ${app.getVersion()}.`,
        buttons: ["Download", "Later"], defaultId: 0, cancelId: 1,
      });
      if (response === 0) shell.openExternal(release.url);
    } catch {
      await dialog.showMessageBox({ type: "warning", message: "Couldn't check for updates.", detail: "Try again later." });
    }
  },
};

// The connect page (ui/connect.html): set the server, or wait for it to answer again.
ipcMain.handle("connect:info", () => ({
  mode: ctl.mode(), server: ctl.settings.server, local: local.available(), failure: local.failure(),
  version: app.getVersion(),
}));
ipcMain.handle("connect:set", async (_event, text) => {
  const origin = server.normalize(text);
  if (!origin) return { error: "That isn't a web address." };
  if (!(await server.reachable(origin))) return { error: `No momo server answers at ${origin}.` };
  local.stop();
  Object.assign(ctl.settings, { mode: "server", server: origin });
  ctl.saveSettings();
  ctl.reconnect();
  return { ok: true };
});
ipcMain.handle("connect:local", () => {
  if (!local.available()) return { error: "This build of momo can't run on this computer." };
  ctl.settings.mode = "local";
  ctl.saveSettings();
  ctl.startLocal();
  return { ok: true };
});
// The offline page's retry: a local server that stopped starts again.
ipcMain.handle("connect:retry", async () => {
  if (ctl.mode() === "local" && !local.origin()) {
    try {
      await ctl.local();
    } catch {
      return false;
    }
    ctl.reconnect();
    return true;
  }
  const ok = Boolean(ctl.server()) && (await server.reachable(ctl.server()));
  if (ok) ctl.reconnect();
  return ok;
});
ipcMain.on("connect:cancel", () => ctl.reconnect());
ipcMain.on("momo:link", (event, color) => {
  for (const window of ctl.windows) window.setLink(event.sender, color);
});
ipcMain.on("momo:link-state", (event, state) => {
  for (const window of ctl.windows) window.setLinkState(event.sender, state);
});
// The tab menu (ui/menu.html), one per window.
ipcMain.on("menu", (event, message = {}) => {
  for (const window of ctl.windows) {
    if (window.menu?.webContents !== event.sender) continue;
    if (message.action === "close") window.closeMenu();
    else window.menuAction(message.action, message);
  }
});
ipcMain.on("strip", (event, action, data) => {
  for (const window of ctl.windows) if (window.win.webContents === event.sender) window.strip(action, data);
});

app.whenReady().then(() => {
  const own = (url) => Boolean(ctl.server()) && url.startsWith(ctl.server());
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const allowed = ["notifications", "clipboard-sanitized-write", "clipboard-read", "fullscreen"];
    callback(allowed.includes(permission) && own(details.requestingUrl || ""));
  });
  if (process.env.MOMO_DESKTOP_READONLY) {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["*://*/api/*"] }, (details, callback) => {
      callback({ cancel: details.method !== "GET" });
    });
  }
  app.setAboutPanelOptions({ applicationName: "momo", applicationVersion: app.getVersion() });
  buildMenu(ctl);
  updates.onChange(() => { for (const window of ctl.windows) window.render(); });
  if (app.isPackaged || process.env.MOMO_DESKTOP_RELEASES) updates.start();
  ctl.restore();
  if (ctl.mode() === "local") ctl.startLocal();
});

app.on("second-instance", () => {
  const window = ctl.focused;
  if (!window) return ctl.restore();
  if (window.win.isMinimized()) window.win.restore();
  window.win.focus();
});
app.on("activate", () => { if (!ctl.windows.size) ctl.restore(); });
app.on("before-quit", () => { ctl.saveNow(); ctl.quitting = true; });
app.on("quit", () => local.stop());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
