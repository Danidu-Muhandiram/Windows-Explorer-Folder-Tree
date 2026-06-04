// Import Electron renderer communication module
// Used to talk with main.js (backend side)
const { ipcRenderer } = require("electron");
// Import File System module
// Used to read folders/files from computer
const fs = require("fs");
// Import Path module
const path = require("path");

const btn = document.getElementById("btn");
const output = document.getElementById("output");

btn.addEventListener("click", async () => {
  // Main process to open folder picker
  // Wait until user selects a folder
  const folderPath = await ipcRenderer.invoke("select-folder");
  // If user presses cancel, stop execution
  if (!folderPath) return;

  // Show selected folder path on screen
  output.innerHTML = "<b>Selected:</b> " + folderPath;

  // Generate folder tree structure and display it
  const tree = buildTree(folderPath);
  output.innerHTML += "<pre>" + tree + "</pre>";
});

// Recursive folder tree generator
function buildTree(dir, prefix = "") {
  //final results
  let result = "";
  // Read all files and folders inside current directory
  const items = fs.readdirSync(dir);

  // Loop through every item and check if it's a file or folder
  items.forEach((item, index) => {
    const fullPath = path.join(dir, item);
    // Check if current item is last item
    const isLast = index === items.length - 1;

    // Choose tree symbol
    // Last item -> └──
    // Middle item -> ├──
    const marker = isLast ? "└── " : "├── ";
    result += prefix + marker + item + "\n";

    if (fs.lstatSync(fullPath).isDirectory()) {
      // Create spacing for child items
      // If last folder → spaces
      // Otherwise → keep vertical line
      const newPrefix = prefix + (isLast ? "    " : "│   ");
      // Go inside folder and repeat same logic
      result += buildTree(fullPath, newPrefix);
    }
  });

  return result;
}