//import Electron modules
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu
} = require("electron");
// import path module (used for file paths)
const path = require("path");
// import spawn to run powershell script
const { spawn } = require("child_process");
const readline = require("readline");
// import fs module
const fs = require("fs");
// store the Electron window
let win;
let sidebarWindow;
const SIDEBAR_WIDTH = 320;
//store the PowerShell watcher process
let explorerWatcher;
let lastExplorerActive = false;
let lastExplorerHandle = null;
let lastExplorerPath = null;
let watcherStopPromise = null;
let readyToQuit = false;
let quitRequested = false;
let smartSidebarEnabled = false;

// Helper to dynamically update sidebar's alwaysOnTop behavior
function updateSidebarAlwaysOnTop(isExplorerActive) {
  if (!sidebarWindow || sidebarWindow.isDestroyed()) return;
  const isSidebarFocused = sidebarWindow.isFocused();
  
  if (isExplorerActive || isSidebarFocused) {
    sidebarWindow.setAlwaysOnTop(true, "status");
  } else {
    sidebarWindow.setAlwaysOnTop(false);
  }
}

// Helper to stop the explorer watcher cleanly
function stopExplorerWatcher() {
  if (watcherStopPromise) return watcherStopPromise;
  if (!explorerWatcher) return Promise.resolve();

  const watcher = explorerWatcher;
  watcherStopPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { watcher.kill(); } catch (error) { console.error(error); }
      resolve();
    }, 2000);
    watcher.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      watcher.stdin.write("exit\n", (error) => {
        if (error) console.error("Could not stop Explorer watcher:", error);
      });
    } catch (error) {
      console.error("Could not stop Explorer watcher:", error);
    }
  }).finally(() => {
    if (explorerWatcher === watcher) {
      explorerWatcher = null;
      lastExplorerPath = null;
      lastExplorerHandle = null;
      lastExplorerActive = false;
    }
    watcherStopPromise = null;
  });
  return watcherStopPromise;
}

// function to create the Electron app window
function createWindow() {
  // Create a new browser window
  win = new BrowserWindow({
    width: 1000,
    height: 650,
    minWidth: 800,
    minHeight: 500,
    // browser settings
    webPreferences: {
      nodeIntegration: true,// allow Node.js in renderer
      contextIsolation: false// disable context isolation
    }
  });

  // load index.html into the window
  win.loadFile("index.html");

  // Remove default Electron menu
  Menu.setApplicationMenu(null);

  sidebarWindow = new BrowserWindow({
    width: 320,
    height: 600,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  sidebarWindow.loadFile("sidebar.html");

  // The hidden sidebar must not keep the application alive after its main window closes.
  win.on("closed", () => {
    win = null;
    app.quit();
  });

  // Send only the latest path if Explorer changes while the sidebar is loading.
  sidebarWindow.webContents.on("did-finish-load", () => {
    if (smartSidebarEnabled && lastExplorerPath !== null && !watcherStopPromise && !quitRequested) {
      sidebarWindow.webContents.send("explorer-path-update", lastExplorerPath);
    }
  });

  // Dynamic always-on-top z-order handling
  sidebarWindow.on("focus", () => {
    sidebarWindow.setAlwaysOnTop(true, "status");
  });

  sidebarWindow.on("blur", () => {
    updateSidebarAlwaysOnTop(lastExplorerActive);
  });
}

// Function to start monitoring Windows File Explorer
function startExplorerWatcher() {

  // Create full path to PowerShell script
  let scriptPath = path.join(
    __dirname,// current project folder
    "explorer",// explorer folder
    "watch_explorer.ps1"// PowerShell file
  );

  // If the application is built and packaged into an ASAR file,
  // unpacked copy since PowerShell cannot run files directly inside ASAR
  if (app.isPackaged) {
    scriptPath = scriptPath.replace("app.asar", "app.asar.unpacked");
  }

  // Run PowerShell script to watch File Explorer paths
  explorerWatcher = spawn("powershell.exe", [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    process.pid.toString()
  ]);
  const watcher = explorerWatcher;
  lastExplorerHandle = null;
  lastExplorerPath = null;

  watcher.on("error", (error) => console.error("Explorer watcher error:", error));
  watcher.stdin.on("error", (error) => console.error("Explorer watcher input error:", error));

  // readline buffers partial lines and decodes UTF-8 across stdout chunks.
  const lines = readline.createInterface({ input: watcher.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (explorerWatcher !== watcher || watcherStopPromise || !line.trim()) return;

    try {
      const explorerData = JSON.parse(line);

      if (explorerData.closed) {
        if (sidebarWindow && !sidebarWindow.isDestroyed()) {
          sidebarWindow.hide();
        }
        lastExplorerHandle = null;
        lastExplorerPath = null;
        lastExplorerActive = false;
        return;
      }

      const {
        hwnd,
        x,
        y,
        width,
        height,
        path,
        minimized,
        isActive
      } = explorerData;

      // Save active state globally for blur/focus handling
      lastExplorerActive = !!isActive;

      // Send folder path to sidebar
      if (sidebarWindow && !sidebarWindow.isDestroyed()) {
        const folderChanged = path !== lastExplorerPath || hwnd !== lastExplorerHandle;
        lastExplorerHandle = hwnd;
        lastExplorerPath = path;
        if (folderChanged && !sidebarWindow.webContents.isLoading()) {
          sidebarWindow.webContents.send("explorer-path-update", path);
        }

        // Position sidebar
        sidebarWindow.setBounds({
          x: x + width,
          y: y,
          width: SIDEBAR_WIDTH,
          height: height
        });

        // Hide sidebar if Explorer minimized
        if (minimized) {
          sidebarWindow.hide();
          return;
        }

        // Show sidebar when Explorer restored
        if (!sidebarWindow.isVisible()) {
          sidebarWindow.showInactive();
        }

        // Dynamic always-on-top updates
        updateSidebarAlwaysOnTop(isActive);
      }
    } catch (error) {
      console.error("Explorer JSON parse line error:", error, "on line:", line);
    }
  });

  // If PowerShell gives an error, log it
  explorerWatcher.stderr.on("data", (err) => {
    console.error("PowerShell Error:", err.toString());
  });

  // When watcher process closes
  watcher.on("close", () => {
    lines.close();
    if (explorerWatcher === watcher) {
      explorerWatcher = null;
      lastExplorerPath = null;
      lastExplorerHandle = null;
      lastExplorerActive = false;
      if (sidebarWindow && !sidebarWindow.isDestroyed()) sidebarWindow.hide();
    }
    console.log("Explorer watcher stopped");
  });
}

// IPC function for folder picker
// Renderer (frontend) can call this
ipcMain.handle("select-folder", async () => {

  // open folder selection dialog
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"]// only folders allowed
  });

   // If user cancels selection
  if (result.canceled) return null;

  // Return selected folder path
  return result.filePaths[0];
});

ipcMain.on(
  "toggle-smart-sidebar",
  async (_, enabled) => {
    smartSidebarEnabled = !!enabled;

    // Turn ON sidebar feature
    if (enabled) {

      if (watcherStopPromise) await watcherStopPromise;
      if (!smartSidebarEnabled || quitRequested || !win || win.isDestroyed()) return;

      if (!explorerWatcher) {

        startExplorerWatcher();
      }

      return;
    }

    // Turn OFF sidebar feature
    if (explorerWatcher) {
      stopExplorerWatcher();
    }

    // Hide sidebar immediately
    if (sidebarWindow) {

      sidebarWindow.hide();
    }
  }
);

ipcMain.on("theme-changed", (event, theme) => {
  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.webContents.send("theme-updated", theme);
  }
});



// When Electron app is ready
app.whenReady().then(createWindow);

// Before Electron quits
app.on("before-quit", (event) => {
  quitRequested = true;
  if (readyToQuit || (!explorerWatcher && !watcherStopPromise)) return;
  event.preventDefault();
  if (sidebarWindow && !sidebarWindow.isDestroyed()) sidebarWindow.hide();
  stopExplorerWatcher().then(() => {
    readyToQuit = true;
    app.quit();
  });
});

// When all windows are closed
app.on("window-all-closed", () => {

  // Close Electron app
  app.quit();
});
