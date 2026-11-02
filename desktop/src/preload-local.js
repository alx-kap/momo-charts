// The app's own pages (the tab strip, the connect page) talk to the main process through this.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shell", {
  platform: process.platform,
  strip: (action, data) => ipcRenderer.send("strip", action, data),
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, listener) => ipcRenderer.on(channel, (_event, value) => listener(value)),
});
