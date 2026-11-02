// One momo window: a tab strip drawn in the title bar (the window's own page, ui/strip.html)
// and one view per tab below it. Every tab keeps its page loaded, so switching is instant.

const path = require("node:path");
const { BrowserWindow, Menu, WebContentsView, app, shell } = require("electron");

const STRIP = 40; // tab strip height, matching momo's top bar
const BACKGROUND = "#000000"; // momo's --bg: no white flash while a page loads
const MAC = process.platform === "darwin";
const UI = path.join(__dirname, "ui");

let nextId = 1;

const editMenu = () => Menu.buildFromTemplate([
  { role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" }, { role: "selectAll" },
]);

class MomoWindow {
  // `ctl` is the app (main.js): the server, other windows, saving. `saved` is a snapshot().
  constructor(ctl, saved = {}) {
    this.ctl = ctl;
    this.tabs = [];
    this.active = null;
    const bounds = saved.bounds || {};
    this.win = new BrowserWindow({
      width: bounds.width || 1440, height: bounds.height || 900, x: bounds.x, y: bounds.y,
      minWidth: 900, minHeight: 560, show: false, title: "momo", backgroundColor: BACKGROUND,
      icon: MAC ? undefined : path.join(__dirname, "../build/icon.png"),
      titleBarStyle: MAC ? "hiddenInset" : "hidden",
      trafficLightPosition: { x: 14, y: 16 }, // centred on the tabs
      // Windows and Linux draw their own minimise / maximise / close over the strip's right end.
      titleBarOverlay: MAC ? undefined : { color: BACKGROUND, symbolColor: "#7d8290", height: STRIP },
      webPreferences: { preload: path.join(__dirname, "preload-local.js"), sandbox: true },
    });
    if (!MAC) this.win.setMenuBarVisibility(false); // its keys still work; Alt stays momo's
    this.win.loadFile(path.join(UI, "strip.html"));
    this.win.once("ready-to-show", () => {
      if (saved.maximized) this.win.maximize();
      this.win.show();
    });
    this.win.on("resize", () => { this.layout(); ctl.save(); });
    this.win.on("move", () => ctl.save());
    this.win.on("focus", () => { ctl.focused = this; this.current()?.view.webContents.focus(); });
    for (const event of ["enter-full-screen", "leave-full-screen"]) this.win.on(event, () => this.render());
    this.win.webContents.on("did-finish-load", () => this.render());
    this.win.on("close", () => ctl.closing(this));
    this.win.on("closed", () => {
      for (const tab of this.tabs) tab.view.webContents.close();
      ctl.closed(this);
    });

    const paths = saved.tabs?.length ? saved.tabs : ["/"];
    for (const address of paths) this.addTab(address, { activate: false });
    this.activate(this.tabs[Math.min(saved.active || 0, this.tabs.length - 1)].id);
  }

  current() {
    return this.tabs.find((tab) => tab.id === this.active) || null;
  }

  addTab(address = "/", { activate = true, after = null } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "preload-page.js"), sandbox: true, spellcheck: false,
      },
    });
    view.setBackgroundColor(BACKGROUND);
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    const tab = { id: nextId++, view, path: address, title: "", loading: true, offline: false };
    const index = after ? this.tabs.indexOf(after) + 1 : this.tabs.length;
    this.tabs.splice(index, 0, tab);
    this.watch(tab);
    this.load(tab);
    if (activate) this.activate(tab.id);
    else this.render();
    return tab;
  }

  // The tab's momo page, or the connect page when there's no server yet or it doesn't answer.
  load(tab, { setup = false } = {}) {
    const server = this.ctl.server();
    const contents = tab.view.webContents;
    if (!server || setup) {
      tab.offline = true;
      contents.loadFile(path.join(UI, "connect.html"), { query: { mode: "setup" } });
    } else {
      tab.offline = false;
      contents.loadURL(server + tab.path);
    }
  }

  watch(tab) {
    const contents = tab.view.webContents;
    const own = (url) => this.ctl.server() && url.startsWith(`${this.ctl.server()}/`);
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title.replace(/\s*·\s*momo$/i, "");
      this.render();
    });
    contents.on("did-start-loading", () => { tab.loading = true; this.render(); });
    contents.on("did-stop-loading", () => { tab.loading = false; this.render(); });
    contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return; // -3: replaced by another load
      tab.offline = true;
      contents.loadFile(path.join(UI, "connect.html"), {
        query: { mode: "offline", server: this.ctl.server() || "" },
      });
    });
    contents.on("render-process-gone", () => this.load(tab));
    // Links to other sites open in the default browser; momo's own open as a new tab.
    contents.setWindowOpenHandler(({ url }) => {
      if (own(url)) this.addTab(new URL(url).pathname + new URL(url).search, { after: tab });
      else if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (own(url) || url.startsWith("file:")) return;
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    });
    contents.on("context-menu", (_event, params) => {
      if (params.isEditable) editMenu().popup({ window: this.win });
    });
    contents.on("focus", () => { this.ctl.focused = this; });
  }

  // Where the tab is now (path and query), so it reopens there.
  address(tab) {
    const url = tab.view.webContents.getURL();
    if (tab.offline || !this.ctl.server() || !url.startsWith(this.ctl.server())) return tab.path;
    const { pathname, search } = new URL(url);
    return pathname + search;
  }

  activate(id) {
    const tab = this.tabs.find((each) => each.id === id);
    if (!tab) return;
    this.active = id;
    for (const each of this.tabs) each.view.setVisible(each === tab);
    this.layout();
    tab.view.webContents.focus();
    this.render();
    this.ctl.save();
  }

  close(id) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const [tab] = this.tabs.splice(index, 1);
    if (!tab.offline) this.ctl.remember(this.address(tab));
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (!this.tabs.length) return this.win.close();
    if (this.active === id) this.activate(this.tabs[Math.min(index, this.tabs.length - 1)].id);
    else this.render();
    this.ctl.save();
  }

  move(id, index) {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from < 0) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab);
    this.render();
    this.ctl.save();
  }

  step(by) {
    const index = this.tabs.findIndex((tab) => tab.id === this.active);
    this.activate(this.tabs[(index + by + this.tabs.length) % this.tabs.length].id);
  }

  // ⌘1–8 pick that tab, ⌘9 the last one, as in browsers.
  select(number) {
    const tab = number === 9 ? this.tabs.at(-1) : this.tabs[number - 1];
    if (tab) this.activate(tab.id);
  }

  layout() {
    const [width, height] = this.win.getContentSize();
    const tab = this.current();
    if (tab) tab.view.setBounds({ x: 0, y: STRIP, width, height: Math.max(0, height - STRIP) });
  }

  // Offline and setup tabs load momo again once the server answers.
  reconnect() {
    for (const tab of this.tabs) if (tab.offline) this.load(tab);
  }

  // Menu commands for the page (Settings, Keyboard shortcuts), handled by momo's desktop.js.
  command(name) {
    const tab = this.current();
    if (tab && !tab.offline) tab.view.webContents.send("momo:command", name);
  }

  // What the strip draws.
  render() {
    if (this.win.isDestroyed() || this.win.webContents.isLoading()) return;
    this.win.webContents.send("tabs", {
      tabs: this.tabs.map(({ id, title, loading, offline }) => ({
        id, title: offline ? (this.ctl.server() ? "Offline" : "Connect") : title, loading, offline,
      })),
      active: this.active,
      update: this.ctl.update(),
      fullscreen: this.win.isFullScreen(),
      dev: !app.isPackaged,
    });
  }

  snapshot() {
    return {
      bounds: this.win.getNormalBounds(),
      maximized: this.win.isMaximized(),
      tabs: this.tabs.map((tab) => this.address(tab)),
      active: Math.max(0, this.tabs.findIndex((tab) => tab.id === this.active)),
    };
  }

  // Actions sent by the strip.
  strip(action, data = {}) {
    if (action === "activate") this.activate(data.id);
    else if (action === "close") this.close(data.id);
    else if (action === "new") this.addTab("/", { after: this.current() });
    else if (action === "move") this.move(data.id, data.index);
    else if (action === "update") this.ctl.openUpdate();
  }
}

module.exports = { MomoWindow, STRIP };
