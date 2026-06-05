// Import Electron renderer communication module
// Used to talk with main.js (backend side)
const { ipcRenderer } = require("electron");
// Import File System module
// Used to read folders/files from computer
const fs = require("fs");
// Import Path module
const path = require("path");

const btn = document.getElementById("btn");
const pathDiv = document.getElementById("path");
const treeContainer = document.getElementById("tree-container");
const themeSelect = document.getElementById("theme-select");

if (themeSelect) {
  themeSelect.addEventListener("change", () => {
    document.body.setAttribute("data-theme", themeSelect.value);
  });
}

btn.addEventListener("click", async () => {
  // Main process to open folder picker
  // Wait until user selects a folder
  const folderPath = await ipcRenderer.invoke("select-folder");
  // If user presses cancel, stop execution
  if (!folderPath) return;

  // Show selected folder path on screen
  pathDiv.textContent = folderPath;

  // Clear previous tree
  treeContainer.innerHTML = "";

  // Generate folder tree structure and display it
  const tree = createTree(folderPath);
  treeContainer.appendChild(tree);
});

// OLD VERSION (kept for reference - not used anymore)
function buildTree(dir, prefix = "") {
  let result = "";

  const items = fs.readdirSync(dir);

  items.forEach((item, index) => {
    const fullPath = path.join(dir, item);
    const isLast = index === items.length - 1;

    const marker = isLast ? "└── " : "├── ";
    result += prefix + marker + item + "\n";

    if (fs.lstatSync(fullPath).isDirectory()) {
      const newPrefix = prefix + (isLast ? "    " : "│   ");
      result += buildTree(fullPath, newPrefix);
    }
  });

  return result;
}

// NEW VERSION (interactive UI tree)
function createTree(dirPath, prefix = "") {
  const container = document.createElement("div");

  const items = fs.readdirSync(dirPath);

  items.forEach((item, index) => {
    const fullPath = path.join(dirPath, item);
    const isDirectory = fs.lstatSync(fullPath).isDirectory();
    const isLast = index === items.length - 1;

    const marker = isLast ? "└── " : "├── ";

    const itemDiv = document.createElement("div");
    itemDiv.classList.add("tree-item");

    if (isDirectory) {
      itemDiv.classList.add("folder");

      itemDiv.innerHTML =`${prefix}${marker}<span class="arrow">▶</span> 📁 ${item}`;

      const children = document.createElement("div");
      children.classList.add("children");

      try {
        const newPrefix = prefix + (isLast ? "    " : "│   ");
        children.appendChild(createTree(fullPath, newPrefix));
      } catch (err) {}

      itemDiv.addEventListener("click", (e) => {
      e.stopPropagation();

      itemDiv.classList.toggle("expanded");

      const arrow = itemDiv.querySelector(".arrow");

      if (arrow) {
        arrow.textContent =
          itemDiv.classList.contains("expanded")
            ? "▼"
            : "▶";
      }
    });

      itemDiv.appendChild(children);
    } else {
      itemDiv.innerHTML = `${prefix}${marker}📄 ${item}`;
    }

    container.appendChild(itemDiv);
  });

  return container;
}