const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("Expected a callback");
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Fixed methods and channels only. Never expose ipcRenderer or IPC event objects.
contextBridge.exposeInMainWorld("folderTree", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  openRoot: (value, showSize = false) => ipcRenderer.invoke("browse-root", value, showSize),
  readDirectory: (value, options) => ipcRenderer.invoke("read-directory", value, options),
  preview: value => ipcRenderer.invoke("preview-file", value),
  openFile: value => ipcRenderer.invoke("open-file", value),
  setSidebar: enabled => ipcRenderer.send("toggle-smart-sidebar", enabled),
  setTheme: theme => ipcRenderer.send("theme-changed", theme),
  onTheme: callback => subscribe("theme-updated", callback),
  onExplorerPath: callback => subscribe("explorer-path-update", callback)
});
