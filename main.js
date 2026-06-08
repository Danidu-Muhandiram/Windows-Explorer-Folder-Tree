//import Electron modules
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
// import path module (used for file paths)
const path = require("path");
// import spawn to run powershell script
const { spawn } = require("child_process");
// store the Electron window
let win;
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
  // Start watching File Explorer paths
  startExplorerWatcher();
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

        // Convert incoming data into text
        // trim() removes extra spaces/new lines
        // JSON.parse() converts JSON text into JavaScript object
        const explorerData =
            JSON.parse(data.toString().trim());

        // Print converted object in terminal
        console.log(explorerData);

    } catch (error) {

        // If JSON conversion fails,
        // show error in console
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

// When Electron app is ready
app.whenReady().then(createWindow);

// When all windows are closed
app.on("window-all-closed", () => {

  // Stop PowerShell watcher before quitting
  if (explorerWatcher) {
    explorerWatcher.kill();
  }

  // Close Electron app
  app.quit();
});