// Each tab's page. momo's pages see `window.momoDesktop` when they run in the app, and turn
// desktop features on only then (static/js/desktop.js); the browser never has it. The app's
// own connect page (a local file) also gets `window.shell`, as the tab strip does.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("momoDesktop", {
  platform: process.platform,
  // Menu commands: "settings", "help".
  onCommand: (listener) => ipcRenderer.on("momo:command", (_event, name) => listener(name)),
  // The tab's link colour (a hex colour, or null), shown as a dot on its tab.
  setLink: (color) => ipcRenderer.send("momo:link", typeof color === "string" ? color : null),
});

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("shell", {
    platform: process.platform,
    invoke: (channel, data) => ipcRenderer.invoke(channel, data),
    send: (channel, data) => ipcRenderer.send(channel, data),
  });
}
