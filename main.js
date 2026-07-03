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
  if (explorerWatcher) {
    const watcher = explorerWatcher;
    explorerWatcher = null;
    try {
      watcher.stdin.write("exit\n");
    } catch (e) {
      console.error("Error writing exit to watcher stdin:", e);
    }
    
    // Fallback force kill after 1 second if it doesn't exit cleanly
    setTimeout(() => {
      try {
        if (!watcher.killed) {
          watcher.kill();
        }
      } catch (e) {}
    }, 1000);
  }
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

  // Listen for output from PowerShell
  explorerWatcher.stdout.on("data", (data) => {
    const lines = data.toString().split("\n");
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      try {
        const explorerData = JSON.parse(line);

        if (explorerData.closed) {
          if (sidebarWindow && !sidebarWindow.isDestroyed()) {
            sidebarWindow.hide();
          }
          lastExplorerHandle = null;
          continue;
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
        lastExplorerHandle = hwnd;
        lastExplorerActive = !!isActive;

        // Send folder path to sidebar
        if (sidebarWindow && !sidebarWindow.isDestroyed()) {
          // Wait until sidebar page fully loads
          if (sidebarWindow.webContents.isLoading()) {
            sidebarWindow.webContents.once("did-finish-load", () => {
              sidebarWindow.webContents.send("explorer-path-update", path);
            });
          } else {
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
            continue;
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
    }
  });

  // If PowerShell gives an error, log it
  explorerWatcher.stderr.on("data", (err) => {
    console.error("PowerShell Error:", err.toString());
  });

  // When watcher process closes
  explorerWatcher.on("close", () => {
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
  (_, enabled) => {

    // Turn ON sidebar feature
    if (enabled) {

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
app.on("before-quit", () => {
  // Stop PowerShell watcher cleanly (so Explorer size is restored)
  stopExplorerWatcher();
});

// When all windows are closed
app.on("window-all-closed", () => {

  // Close Electron app
  app.quit();
});