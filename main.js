//import Electron modules
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
// import path module (used for file paths)
const path = require("path");
// import spawn to run powershell script
const { spawn } = require("child_process");
// store the Electron window
let win;
let sidebarWindow;
const SIDEBAR_WIDTH = 320;
//store the PowerShell watcher process
let explorerWatcher;


// function to create the Electron app window
function createWindow() {
  // Create a new browser window
  win = new BrowserWindow({
    width: 1000,
    height: 650,
    // browser settings
    webPreferences: {
      nodeIntegration: true,// allow Node.js in renderer
      contextIsolation: false// disable context isolation
    }
  });

  // load index.html into the window
  win.loadFile("index.html");

  sidebarWindow = new BrowserWindow({
  width: 320,
  height: 600,
  frame: false,
  resizable: false,
  show: false,
  alwaysOnTop: true,
  webPreferences: {
    nodeIntegration: true,
    contextIsolation: false
  }
});

sidebarWindow.loadFile("sidebar.html");
  
}

// Function to start monitoring Windows File Explorer
function startExplorerWatcher() {

  // Create full path to PowerShell script
  const scriptPath = path.join(
    __dirname,// current project folder
    "explorer",// explorer folder
    "watch_explorer.ps1"// PowerShell file
  );

  // Run PowerShell script to watch File Explorer paths
  explorerWatcher = spawn("powershell.exe", [
    "-ExecutionPolicy",
    "Bypass",// bypass execution restrictions
    "-File",
    scriptPath // run this script
  ]);

  // Listen for output from PowerShell
  explorerWatcher.stdout.on("data", (data) => {

  try {

    const explorerData =
      JSON.parse(data.toString().trim());

    const {
      x,
      y,
      width,
      height,
      path,
      minimized
    } = explorerData;

      // Send folder path to sidebar
if (
  sidebarWindow &&
  !sidebarWindow.isDestroyed()
) {

  // Wait until sidebar page fully loads
  if (
    sidebarWindow.webContents.isLoading()
  ) {

    sidebarWindow.webContents.once(
      "did-finish-load",
      () => {

        sidebarWindow.webContents.send(
          "explorer-path-update",
          path
        );

        console.log(
          "Sending to sidebar:",
          path
        );
      }
    );

  } else {

    sidebarWindow.webContents.send(
      "explorer-path-update",
      path
    );

    console.log(
      "Sending to sidebar:",
      path
    );
  }
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

    console.log(explorerData);

  } catch (error) {

    console.error(
      "Explorer JSON Error:",
      error
    );
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

      explorerWatcher.kill();
      explorerWatcher = null;
    }

    // Hide sidebar immediately
    if (sidebarWindow) {

      sidebarWindow.hide();
    }
  }
);

// When Electron app is ready
app.whenReady().then(createWindow);

// Before Electron quits
app.on("before-quit", () => {

  // Stop PowerShell watcher
  // This allows Explorer restore logic to run
  if (explorerWatcher) {

    explorerWatcher.kill();
  }
});

// When all windows are closed
app.on("window-all-closed", () => {

  // Close Electron app
  app.quit();
});