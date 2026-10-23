const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("Expected a callback");
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Fixed methods and channels only. Never expose ipcRenderer or IPC event objects.
async function scan(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result?.cancelled) throw new Error("Scan cancelled");
  return result;
}
contextBridge.exposeInMainWorld("folderTree", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  openRoot: (value, showSize = false, requestId = null) => scan("browse-root", value, showSize, requestId),
  readDirectory: (value, options, requestId = null) => scan("read-directory", value, options, requestId),
  cancelScan: (requestId = null) => ipcRenderer.invoke("cancel-scan", requestId),
  onScanProgress: callback => subscribe("scan-progress", callback),
  preview: value => ipcRenderer.invoke("preview-file", value),
  openFile: value => ipcRenderer.invoke("open-file", value),
  setSidebar: enabled => ipcRenderer.send("toggle-smart-sidebar", enabled),
  setTheme: theme => ipcRenderer.send("theme-changed", theme),
  onTheme: callback => subscribe("theme-updated", callback),
  onExplorerPath: callback => subscribe("explorer-path-update", callback)
});
