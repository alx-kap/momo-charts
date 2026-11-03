// One momo window: a tab strip drawn in the title bar (the window's own page, ui/strip.html)
// and one view per tab below it. Every tab keeps its page loaded, so switching is instant.
// Right-clicking a tab opens its menu (duplicate, pin, detach…) and clicking its link slot the
// sync panel (colour and switches); both are drawn in a transparent view laid over the whole
// window (ui/menu.html).

const path = require("node:path");
const { BrowserWindow, Menu, WebContentsView, app, shell } = require("electron");

const STRIP = 40; // tab strip height, matching momo's top bar
const BACKGROUND = "#000000"; // momo's --bg: no white flash while a page loads
const MAC = process.platform === "darwin";
const UI = path.join(__dirname, "ui");
const LINK_KINDS = ["symbol", "interval", "time", "range"];

let nextId = 1;

const editMenu = () => Menu.buildFromTemplate([
  { role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" }, { role: "selectAll" },
]);

// A saved tab: a bare address (before 0.1.3) or { path, title, pinned }.
const savedTab = (entry) => (typeof entry === "string" ? { path: entry } : entry);

class MomoWindow {
  // `ctl` is the app (main.js): the server, other windows, saving. `saved` is a snapshot().
  constructor(ctl, saved = {}) {
    this.ctl = ctl;
    this.tabs = [];
    this.active = null;
    this.menu = null; // the tab menu's view, made on first use
    this.menuTab = null; // the tab whose menu is open
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
    this.win.on("focus", () => { ctl.focused = this; if (!this.menuTab) this.current()?.view.webContents.focus(); });
    this.win.on("blur", () => this.closeMenu());
    for (const event of ["enter-full-screen", "leave-full-screen"]) this.win.on(event, () => this.render());
    this.win.webContents.on("did-stop-loading", () => this.render());
    this.win.on("close", () => ctl.closing(this));
    this.win.on("closed", () => {
      for (const tab of this.tabs) tab.view.webContents.close();
      this.menu?.webContents.close();
      ctl.closed(this);
    });

    const tabs = saved.tabs?.length ? saved.tabs.map(savedTab) : [{ path: "/" }];
    for (const entry of tabs) this.addTab(entry.path, { activate: false, title: entry.title, pinned: entry.pinned });
    this.activate(this.tabs[Math.min(saved.active || 0, this.tabs.length - 1)].id);
  }

  current() {
    return this.tabs.find((tab) => tab.id === this.active) || null;
  }

  find(id) {
    return this.tabs.find((tab) => tab.id === id) || null;
  }

  addTab(address = "/", { activate = true, after = null, title = "", pinned = false } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "preload-page.js"), sandbox: true, spellcheck: false,
      },
    });
    view.setBackgroundColor(BACKGROUND);
    view.setVisible(false);
    const tab = {
      id: nextId++, view, owner: this, path: address, title: "", custom: title || "", pinned: Boolean(pinned),
      loading: true, offline: false, link: null, linkState: null,
    };
    this.place(tab, after);
    this.watch(tab);
    this.load(tab);
    if (activate) this.activate(tab.id);
    else this.render();
    return tab;
  }

  // Put a tab in this window after `after` (or at the end), pinned tabs first.
  place(tab, after) {
    tab.owner = this;
    this.win.contentView.addChildView(tab.view);
    if (this.menu) this.win.contentView.addChildView(this.menu); // the menu stays on top
    const index = after ? this.tabs.indexOf(after) + 1 : this.tabs.length;
    this.tabs.splice(index, 0, tab);
    this.order();
  }

  // Pinned tabs sit at the left, in their own order.
  order() {
    this.tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }

  // The tab's momo page, or the connect page when there's no server yet or it doesn't answer.
  load(tab, { setup = false } = {}) {
    const server = this.ctl.server();
    const contents = tab.view.webContents;
    const mode = this.ctl.mode();
    if (!mode || setup) {
      tab.offline = true;
      contents.loadFile(path.join(UI, "connect.html"), { query: { mode: "setup" } });
    } else if (!server) {
      // Local mode: momo is starting, or couldn't.
      tab.offline = true;
      contents.loadFile(path.join(UI, "connect.html"), { query: { mode: this.ctl.starting() ? "starting" : "offline", server: "" } });
    } else {
      tab.offline = false;
      contents.loadURL(server + tab.path);
    }
  }

  // The tab's page events. A detached tab changes window, so these go through tab.owner.
  watch(tab) {
    const contents = tab.view.webContents;
    const own = (url) => this.ctl.server() && url.startsWith(`${this.ctl.server()}/`);
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title.replace(/\s*·\s*momo$/i, "");
      tab.owner.render();
    });
    contents.on("did-start-loading", () => { tab.loading = true; tab.owner.render(); });
    contents.on("did-stop-loading", () => { tab.loading = false; tab.owner.render(); });
    contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return; // -3: replaced by another load
      tab.offline = true;
      contents.loadFile(path.join(UI, "connect.html"), {
        query: { mode: "offline", server: this.ctl.server() || "" },
      });
    });
    contents.on("render-process-gone", () => tab.owner.load(tab));
    // Links to other sites open in the default browser; momo's own open as a new tab.
    contents.setWindowOpenHandler(({ url }) => {
      if (own(url)) tab.owner.addTab(new URL(url).pathname + new URL(url).search, { after: tab });
      else if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (own(url) || url.startsWith("file:")) return;
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    });
    contents.on("context-menu", (_event, params) => {
      if (params.isEditable) editMenu().popup({ window: tab.owner.win });
    });
    contents.on("focus", () => { this.ctl.focused = tab.owner; });
  }

  // Where the tab is now (path and query), so it reopens there.
  address(tab) {
    const url = tab.view.webContents.getURL();
    if (tab.offline || !this.ctl.server() || !url.startsWith(this.ctl.server())) return tab.path;
    const { pathname, search } = new URL(url);
    return pathname + search;
  }

  activate(id) {
    const tab = this.find(id);
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

  // Close several tabs at once: the others, or those right of one. Pinned tabs stay.
  closeMany(keep, which) {
    const index = this.tabs.findIndex((tab) => tab.id === keep);
    const doomed = this.tabs.filter((tab, i) => !tab.pinned && tab.id !== keep && (which === "others" || i > index));
    if (doomed.some((tab) => tab.id === this.active)) this.activate(keep);
    for (const tab of doomed) this.close(tab.id);
  }

  duplicate(id) {
    const tab = this.find(id);
    if (tab) this.addTab(this.address(tab), { after: tab, title: tab.custom });
  }

  setPinned(id, pinned) {
    const tab = this.find(id);
    if (!tab) return;
    tab.pinned = pinned;
    // A pinned tab goes after the last pinned one; an unpinned one right after them.
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    const edge = this.tabs.filter((each) => each.pinned).length;
    this.tabs.splice(edge, 0, tab);
    this.render();
    this.ctl.save();
  }

  setTitle(id, title) {
    const tab = this.find(id);
    if (!tab) return;
    tab.custom = String(title || "").trim().slice(0, 60);
    this.render();
    this.ctl.save();
  }

  // Move a tab into a new window of its own. The page is made afresh there at the same address
  // (its colour, chart and title come along): a live view moved between windows flickers on a Mac.
  detach(id) {
    const tab = this.find(id);
    if (!tab || this.tabs.length < 2) return;
    const entry = { path: this.address(tab), title: tab.custom || undefined, pinned: tab.pinned || undefined };
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (this.active === id) this.activate(this.tabs[0].id);
    else this.render();
    const from = this.win.getBounds();
    this.ctl.open({ bounds: { ...from, x: from.x + 28, y: from.y + 28 }, tabs: [entry] });
    this.ctl.save();
  }

  move(id, index) {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from < 0) return;
    const [tab] = this.tabs.splice(from, 1);
    // Pinned and unpinned tabs each keep to their side.
    const pinned = this.tabs.filter((each) => each.pinned).length;
    const [low, high] = tab.pinned ? [0, pinned] : [pinned, this.tabs.length];
    this.tabs.splice(Math.max(low, Math.min(index, high)), 0, tab);
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
    if (this.menu) this.menu.setBounds({ x: 0, y: 0, width, height });
  }

  // Offline and setup tabs load momo again once the server answers.
  reconnect() {
    for (const tab of this.tabs) if (tab.offline) this.load(tab);
  }

  tabOf(contents) {
    return this.tabs.find((each) => each.view.webContents === contents) || null;
  }

  // A page's link colour (link.js), drawn as a dot on its tab.
  setLink(contents, color) {
    const tab = this.tabOf(contents);
    if (!tab) return;
    tab.link = /^#[0-9a-f]{6}$/i.test(color || "") ? color : null;
    this.render();
  }

  // A page's whole link state: { color, colors, switches }, for the tab menu.
  setLinkState(contents, state) {
    const tab = this.tabOf(contents);
    if (!tab || !state || typeof state !== "object") return;
    tab.linkState = state;
    if (this.menuTab === tab) this.sendMenu();
  }

  // Menu commands for the page (Settings, Keyboard shortcuts), handled by momo's desktop.js.
  command(name) {
    const tab = this.current();
    if (tab && !tab.offline) tab.view.webContents.send("momo:command", name);
  }

  // ---------- the tab menu ----------

  // `mode`: "tab" (the right-click menu) or "link" (the sync panel).
  openMenu(id, x, y, mode = "tab") {
    const tab = this.find(id);
    if (!tab) return;
    if (!this.menu) {
      this.menu = new WebContentsView({
        webPreferences: { preload: path.join(__dirname, "preload-local.js"), sandbox: true },
      });
      this.menu.setBackgroundColor("#00000000");
      this.menu.webContents.loadFile(path.join(UI, "menu.html"));
      this.menu.webContents.on("did-finish-load", () => { if (this.menuTab) this.sendMenu(); });
    }
    this.menuTab = tab;
    this.menuSerial = (this.menuSerial || 0) + 1; // each opening starts fresh (not mid-edit)
    this.win.contentView.addChildView(this.menu); // to the top
    this.layout();
    this.menu.setVisible(true);
    this.menuAt = { x, y, mode };
    if (!this.menu.webContents.isLoading()) this.sendMenu();
    this.menu.webContents.focus();
  }

  sendMenu() {
    const tab = this.menuTab;
    if (!tab || !this.menu) return;
    const index = this.tabs.indexOf(tab);
    this.menu.webContents.send("menu", {
      ...this.menuAt, serial: this.menuSerial, mac: MAC,
      title: tab.custom || tab.title, custom: tab.custom, pinned: tab.pinned, offline: tab.offline,
      canDetach: this.tabs.length > 1,
      canCloseOthers: this.tabs.some((each) => each !== tab && !each.pinned),
      canCloseRight: this.tabs.slice(index + 1).some((each) => !each.pinned),
      link: tab.offline ? null : tab.linkState,
    });
  }

  closeMenu() {
    if (!this.menuTab) return;
    this.menuTab = null;
    this.menu?.setVisible(false);
    if (!this.win.isDestroyed()) this.current()?.view.webContents.focus();
  }

  // Actions sent by the tab menu, for the tab it was opened on.
  menuAction(action, data = {}) {
    const tab = this.menuTab;
    if (!tab) return;
    const keep = ["link-color", "link-switch", "title-edit"].includes(action);
    if (!keep) this.closeMenu();
    if (action === "duplicate") this.duplicate(tab.id);
    else if (action === "reload") tab.offline ? this.load(tab) : tab.view.webContents.reload();
    else if (action === "pin") this.setPinned(tab.id, !tab.pinned);
    else if (action === "detach") this.detach(tab.id);
    else if (action === "title") this.setTitle(tab.id, data.title);
    else if (action === "close") this.close(tab.id);
    else if (action === "close-others") this.closeMany(tab.id, "others");
    else if (action === "close-right") this.closeMany(tab.id, "right");
    else if (action === "link-color") tab.view.webContents.send("momo:link", { color: data.color || null });
    else if (action === "link-switch" && LINK_KINDS.includes(data.kind)) {
      tab.view.webContents.send("momo:link", { kind: data.kind, on: Boolean(data.on) });
    }
  }

  // What the strip draws.
  render() {
    if (this.win.isDestroyed() || this.win.webContents.isLoading()) return;
    this.win.webContents.send("tabs", {
      tabs: this.tabs.map(({ id, title, custom, pinned, loading, offline, link }) => ({
        id, title: offline ? (this.ctl.starting() ? "Starting momo" : this.ctl.mode() ? "Offline" : "Set up") : custom || title, loading, offline,
        pinned, link: offline ? null : link,
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
      tabs: this.tabs.map((tab) => ({ path: this.address(tab), title: tab.custom || undefined, pinned: tab.pinned || undefined })),
      active: Math.max(0, this.tabs.findIndex((tab) => tab.id === this.active)),
    };
  }

  // Actions sent by the strip.
  strip(action, data = {}) {
    if (action === "activate") this.activate(data.id);
    else if (action === "close") this.close(data.id);
    else if (action === "new") this.addTab("/", { after: this.current() });
    else if (action === "move") this.move(data.id, data.index);
    else if (action === "menu") this.openMenu(data.id, Number(data.x) || 0, Number(data.y) || STRIP);
    else if (action === "link") this.openMenu(data.id, Number(data.x) || 0, Number(data.y) || STRIP, "link");
    else if (action === "update") this.ctl.openUpdate();
  }
}

module.exports = { MomoWindow, STRIP };
