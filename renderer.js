const { ipcRenderer, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

// State Management
let currentRootPath = null;
let selectedFilePath = null;
const expandedPaths = new Set();
let pinnedFolders = [];

// Caches for performance optimization
let folderSizeCache = new Map();
let filterMatchCache = new Map();

// Get DOM Elements
const btnSelectFolder = document.getElementById("btn");
const pathDisplay = document.getElementById("path");
const treeContainer = document.getElementById("tree-container");
const themeSelect = document.getElementById("theme-select");
const filterSelect = document.getElementById("filter-select");
const sortSelect = document.getElementById("sort-select");
const toggleDate = document.getElementById("toggle-date");
const toggleSize = document.getElementById("toggle-size");
const pinBtn = document.getElementById("pin-btn");
const pinnedList = document.getElementById("pinned-list");
const previewTitle = document.getElementById("preview-title");
const openFileBtn = document.getElementById("open-file-btn");
const previewMeta = document.getElementById("preview-meta");
const previewBody = document.getElementById("preview-body");

// Initialize Application Settings
function initSettings() {
  // 1. Theme Configuration
  const savedTheme = localStorage.getItem("theme") || "dark";
  document.body.setAttribute("data-theme", savedTheme);
  if (themeSelect) {
    themeSelect.value = savedTheme;
    themeSelect.addEventListener("change", () => {
      const newTheme = themeSelect.value;
      document.body.setAttribute("data-theme", newTheme);
      localStorage.setItem("theme", newTheme);
      ipcRenderer.send("theme-changed", newTheme);
    });
  }

  // 2. Load Pinned Folders
  const savedPins = localStorage.getItem("pinnedFolders");
  pinnedFolders = [];
  if (savedPins) {
    try {
      const parsedPins = JSON.parse(savedPins);
      if (Array.isArray(parsedPins)) {
        pinnedFolders = [...new Set(parsedPins.filter(folderPath =>
          typeof folderPath === "string" && folderPath.trim().length > 0 &&
          !folderPath.includes("\0") && path.isAbsolute(folderPath)
        ))];
      }
    } catch (e) {
      pinnedFolders = [];
    }
  }
  renderPinnedList();

  // Disable pin button initially since no folder is selected
  updatePinButtonState();
}

// Format Utilities
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDate(date) {
  if (!date) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Filter Options helper
function matchesFilter(fileName, filterValue) {
  if (filterValue === "all") return true;
  const ext = path.extname(fileName).toLowerCase();
  switch (filterValue) {
    case "images":
      return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext);
    case "png":
      return ext === ".png";
    case "jpg":
      return [".jpg", ".jpeg"].includes(ext);
    case "pdf":
      return ext === ".pdf";
    case "word":
      return [".doc", ".docx"].includes(ext);
    case "excel":
      return [".xls", ".xlsx", ".csv"].includes(ext);
    case "ppt":
      return [".ppt", ".pptx"].includes(ext);
    default:
      return true;
  }
}

// Check if directory has matching files recursively (with cache)
function dirHasMatch(dirPath, filterValue) {
  if (filterValue === "all") return true;
  const cacheKey = `${dirPath}:${filterValue}`;
  if (filterMatchCache.has(cacheKey)) return filterMatchCache.get(cacheKey);

  let hasMatch = false;
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (error) {
        continue; // One inaccessible entry must not hide later matches.
      }
      if (stat.isDirectory()) {
        if (dirHasMatch(fullPath, filterValue)) {
          hasMatch = true;
          break;
        }
      } else {
        if (matchesFilter(item, filterValue)) {
          hasMatch = true;
          break;
        }
      }
    }
  } catch (e) {
    // Fail silently on protected folders
  }

  filterMatchCache.set(cacheKey, hasMatch);
  return hasMatch;
}

// Calculate directory size recursively (with cache)
function getFolderSize(dirPath) {
  if (folderSizeCache.has(dirPath)) return folderSizeCache.get(dirPath);
  let totalSize = 0;
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (error) {
        continue; // Keep counting accessible entries.
      }
      if (stat.isDirectory()) {
        totalSize += getFolderSize(fullPath);
      } else {
        totalSize += stat.size;
      }
    }
  } catch (e) {
    // Fail silently
  }
  folderSizeCache.set(dirPath, totalSize);
  return totalSize;
}

// Sort items according to criteria (directories always grouped first)
function sortItems(itemsList, criteria) {
  itemsList.sort((a, b) => {
    // Group directories first
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;

    // Sort folders or files based on criteria
    switch (criteria) {
      case "name-asc":
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      case "name-desc":
        return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
      case "size-asc":
        return a.size - b.size;
      case "size-desc":
        return b.size - a.size;
      case "date-asc":
        return a.mtimeMs - b.mtimeMs;
      case "date-desc":
        return b.mtimeMs - a.mtimeMs;
      default:
        return 0;
    }
  });
}

// Open folder functionality
function openRootFolder(folderPath) {
  if (!folderPath) return;

  currentRootPath = folderPath;
  if (pathDisplay) {
    pathDisplay.textContent = folderPath;
  }
  
  // Clear states, selection, and caches
  selectedFilePath = null;
  expandedPaths.clear();
  folderSizeCache.clear();
  filterMatchCache.clear();
  
  // Reset preview panel
  resetPreviewPanel();
  
  // Update pin button visual state
  updatePinButtonState();

  // Render tree
  renderTree();
}

// Reset preview panel UI to empty state
function resetPreviewPanel() {
  if (previewTitle) previewTitle.textContent = "No file selected";
  if (openFileBtn) openFileBtn.disabled = true;
  if (previewMeta) previewMeta.innerHTML = "";
  if (previewBody) {
    previewBody.innerHTML = `
      <div class="empty-preview-state">
        <span class="empty-preview-icon">👁️</span>
        <p>Select a file from the tree to view its preview and details.</p>
      </div>
    `;
  }
}

// Render Folder Tree
function renderTree() {
  if (!currentRootPath) return;
  if (!treeContainer) return;
  treeContainer.innerHTML = "";
  
  try {
    const rootTree = buildTreeNode(currentRootPath);
    if (rootTree) {
      treeContainer.appendChild(rootTree);
    } else {
      treeContainer.innerHTML = `
        <div class="empty-tree-state">
          <span class="empty-icon">📂</span>
          <p>No matching files found in this folder.</p>
        </div>
      `;
    }
  } catch (err) {
    treeContainer.innerHTML = `<p style="color:var(--danger-color); padding: 10px;">Error loading folder structure: ${err.message}</p>`;
  }
}

// Build Tree Node (Lazy-loaded)
function buildTreeNode(itemPath) {
  const name = path.basename(itemPath);
  let stat;
  try {
    stat = fs.statSync(itemPath);
  } catch (e) {
    return null; // Skip if file/folder doesn't exist or permissions fail
  }

  const isDirectory = stat.isDirectory();
  const filterVal = filterSelect ? filterSelect.value : "all";
  const showDate = toggleDate ? toggleDate.checked : false;
  const showSize = toggleSize ? toggleSize.checked : false;

  // Filter checking
  if (isDirectory) {
    if (!dirHasMatch(itemPath, filterVal)) return null;
  } else {
    if (!matchesFilter(name, filterVal)) return null;
  }

  // Create node element
  const itemDiv = document.createElement("div");
  itemDiv.classList.add("tree-item");
  if (isDirectory) itemDiv.classList.add("folder");

  // Create header
  const headerDiv = document.createElement("div");
  headerDiv.classList.add("tree-item-header");

  // Get matching icon
  let icon = "📝 ";
  if (isDirectory) {
    icon = expandedPaths.has(itemPath) ? "📂 " : "📁 ";
  } else {
    const ext = path.extname(name).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) icon = "🖼️ ";
    else if (ext === ".pdf") icon = "📕 ";
    else if ([".doc", ".docx"].includes(ext)) icon = "📘 ";
    else if ([".xls", ".xlsx", ".csv"].includes(ext)) icon = "📗 ";
    else if ([".ppt", ".pptx"].includes(ext)) icon = "📙 ";
    else if ([".mp3", ".wav", ".ogg"].includes(ext)) icon = "🎵 ";
    else if ([".mp4", ".webm", ".mkv"].includes(ext)) icon = "🎥 ";
    else if ([".js", ".ts", ".json", ".html", ".css", ".md", ".py", ".cpp", ".txt"].includes(ext)) icon = "📄 ";
  }

  // Create items meta details
  let metaText = "";
  if (showSize) {
    const sizeBytes = isDirectory ? getFolderSize(itemPath) : stat.size;
    metaText += ` ${formatBytes(sizeBytes)}`;
  }
  if (showDate) {
    const dateStr = formatDate(stat.mtime);
    metaText += metaText ? ` | ${dateStr}` : ` ${dateStr}`;
  }

  const metaSpan = metaText ? `<span class="item-meta">(${metaText.trim()})</span>` : "";

  // Set inner layout
  if (isDirectory) {
    headerDiv.innerHTML = `<span class="arrow">▶</span> <span class="node-icon">${icon}</span> <span class="node-name">${name}</span>${metaSpan}`;
  } else {
    headerDiv.innerHTML = `<span class="node-icon" style="margin-left:14px;">${icon}</span> <span class="node-name">${name}</span>${metaSpan}`;
  }

  itemDiv.appendChild(headerDiv);

  // Active file highlight setup
  if (selectedFilePath === itemPath) {
    itemDiv.classList.add("active-file");
  }

  // If directory, handle children rendering (Lazy-loading)
  if (isDirectory) {
    const childrenDiv = document.createElement("div");
    childrenDiv.classList.add("children");
    itemDiv.appendChild(childrenDiv);

    // If already expanded state, immediately load children
    if (expandedPaths.has(itemPath)) {
      itemDiv.classList.add("expanded");
      const arrow = headerDiv.querySelector(".arrow");
      if (arrow) arrow.textContent = "▼";
      loadChildren(itemPath, childrenDiv);
    }

    // Toggle expansion on header click
    headerDiv.addEventListener("click", (e) => {
      e.stopPropagation();
      const isExpanded = itemDiv.classList.toggle("expanded");
      const arrow = headerDiv.querySelector(".arrow");
      const iconSpan = headerDiv.querySelector(".node-icon");

      if (isExpanded) {
        expandedPaths.add(itemPath);
        if (arrow) arrow.textContent = "▼";
        if (iconSpan) iconSpan.textContent = "📂 ";
        // Load children if not loaded
        if (childrenDiv.children.length === 0) {
          loadChildren(itemPath, childrenDiv);
        }
      } else {
        expandedPaths.delete(itemPath);
        if (arrow) arrow.textContent = "▶";
        if (iconSpan) iconSpan.textContent = "📁 ";
      }
    });
  } else {
    // Handle File Preview loading on click
    headerDiv.addEventListener("click", (e) => {
      e.stopPropagation();
      
      // Remove selection styles from other files
      document.querySelectorAll(".tree-item.active-file").forEach(el => {
        el.classList.remove("active-file");
      });
      itemDiv.classList.add("active-file");
      
      selectedFilePath = itemPath;
      showFilePreview(itemPath);

      // Open the file in the default program immediately on single-click (sidebar mode only)
      if (document.body.classList.contains("sidebar-mode")) {
        openFile(itemPath);
      }
    });
  }

  return itemDiv;
}

// Read directory files, sort them, build nodes, append to container
function loadChildren(dirPath, container) {
  try {
    const rawNames = fs.readdirSync(dirPath);
    const filterVal = filterSelect ? filterSelect.value : "all";
    const sortVal = sortSelect ? sortSelect.value : "name-asc";
    const showSize = toggleSize ? toggleSize.checked : false;
    const needsFolderSize = showSize || sortVal === "size-asc" || sortVal === "size-desc";

    const items = [];
    for (const name of rawNames) {
      const fullPath = path.join(dirPath, name);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (e) {
        continue; // skip permissions error files
      }

      const isDir = stat.isDirectory();
      
      if (isDir) {
        if (!dirHasMatch(fullPath, filterVal)) continue;
      } else {
        if (!matchesFilter(name, filterVal)) continue;
      }

      items.push({
        name,
        fullPath,
        isDirectory: isDir,
        size: isDir ? (needsFolderSize ? getFolderSize(fullPath) : 0) : stat.size,
        mtimeMs: stat.mtimeMs
      });
    }

    sortItems(items, sortVal);

    items.forEach(item => {
      const node = buildTreeNode(item.fullPath);
      if (node) {
        container.appendChild(node);
      }
    });
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger-color); font-size:12px; padding-left:15px;">Error loading contents.</p>`;
  }
}

// Report both shell error strings and rejected requests through a native dialog.
async function openFile(filePath) {
  let errorMessage;
  try {
    errorMessage = await shell.openPath(filePath);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  if (errorMessage) {
    ipcRenderer.send("file-open-failed", filePath, errorMessage);
  }
}

function showMediaPreview(filePath, tagName, wrapperClass) {
  const wrapper = document.createElement("div");
  wrapper.className = wrapperClass;
  const media = document.createElement(tagName);
  media.src = pathToFileURL(filePath).href;
  if (tagName === "img") {
    media.alt = path.basename(filePath);
  } else {
    media.controls = true;
    if (tagName === "audio") {
      const icon = document.createElement("span");
      icon.className = "media-icon";
      icon.textContent = "🎵";
      wrapper.appendChild(icon);
    }
  }
  wrapper.appendChild(media);
  previewBody.replaceChildren(wrapper);
}

// Generate File Preview Details
function showFilePreview(filePath) {
  if (!filePath) return;

  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  
  // Enable header button
  if (openFileBtn) openFileBtn.disabled = false;
  if (previewTitle) previewTitle.textContent = fileName;

  // Read stats
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    if (previewMeta) previewMeta.innerHTML = `<span style="color:var(--danger-color);">Error reading file stats.</span>`;
    return;
  }

  // Render metadata panel
  const sizeStr = formatBytes(stat.size);
  const mtimeStr = formatDate(stat.mtime);
  
  if (previewMeta) {
    previewMeta.innerHTML = `
      <div class="meta-row copy-path-row">
        <span class="meta-key">Full Path:</span>
        <span class="meta-val" style="font-family:monospace; font-size:11px;">${filePath}</span>
        <button class="copy-btn" id="copy-path-btn">
          📋 Copy
          <span class="copy-tooltip" id="copy-tip">Copied!</span>
        </button>
      </div>
      <div class="meta-row">
        <span class="meta-key">File Size:</span>
        <span class="meta-val">${sizeStr}</span>
      </div>
      <div class="meta-row">
        <span class="meta-key">Modified Date:</span>
        <span class="meta-val">${mtimeStr}</span>
      </div>
    `;

    // Attach copy path action
    const copyBtn = document.getElementById("copy-path-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(filePath).then(() => {
          const tooltip = document.getElementById("copy-tip");
          if (tooltip) {
            copyBtn.classList.add("show-tooltip");
            setTimeout(() => {
              copyBtn.classList.remove("show-tooltip");
            }, 1500);
          }
        });
      });
    }
  }

  // Clear and load Preview Content body
  if (previewBody) {
    previewBody.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted);">Loading preview...</div>`;

    // Images
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) {
      showMediaPreview(filePath, "img", "image-preview-wrapper");
    }
    // Audio players
    else if ([".mp3", ".wav", ".ogg"].includes(ext)) {
      showMediaPreview(filePath, "audio", "audio-preview-wrapper");
    }
    // Video players
    else if ([".mp4", ".webm", ".mkv"].includes(ext)) {
      showMediaPreview(filePath, "video", "video-preview-wrapper");
    }
    // Text & Code files
    else if ([".js", ".ts", ".json", ".html", ".css", ".md", ".py", ".cpp", ".h", ".txt", ".ini", ".cfg", ".xml", ".yaml", ".yml", ".bat", ".sh"].includes(ext)) {
      try {
        // Handle huge text files gracefully: read max 50KB
        const fd = fs.openSync(filePath, "r");
        const buffer = Buffer.alloc(50000);
        const bytesRead = fs.readSync(fd, buffer, 0, 50000, 0);
        let content = buffer.toString("utf8", 0, bytesRead);
        fs.closeSync(fd);

        if (stat.size > 50000) {
          content += "\n\n... [Truncated! File size exceeds 50KB limit] ...";
        }

        const escaped = escapeHTML(content);
        const lines = escaped.split("\n");
        const lineNumbers = lines.map((_, index) => index + 1).join("<br>");
        
        previewBody.innerHTML = `
          <div class="code-preview-wrapper">
            <div class="code-line-numbers">${lineNumbers}</div>
            <div class="code-content">${escaped}</div>
          </div>
        `;
      } catch (e) {
        previewBody.innerHTML = `<p style="color:var(--danger-color);">Could not read text preview: ${e.message}</p>`;
      }
    }
    // PDFs, Microsoft Documents, Spreadsheet, Slides
    else {
      let docEmoji = "📝";
      let docType = "Generic File";
      let docColor = "var(--text-muted)";
      
      if (ext === ".pdf") {
        docEmoji = "📕";
        docType = "PDF Document";
        docColor = "var(--danger-color)";
      } else if ([".doc", ".docx"].includes(ext)) {
        docEmoji = "📘";
        docType = "Word Document";
        docColor = "#3b82f6";
      } else if ([".xls", ".xlsx", ".csv"].includes(ext)) {
        docEmoji = "📗";
        docType = "Excel Spreadsheet";
        docColor = "var(--success-color)";
      } else if ([".ppt", ".pptx"].includes(ext)) {
        docEmoji = "📙";
        docType = "PowerPoint Presentation";
        docColor = "#f97316";
      }

      previewBody.innerHTML = `
        <div class="document-placeholder-card">
          <span class="document-icon" style="color:${docColor};">${docEmoji}</span>
          <div class="document-info-title">${docType}</div>
          <div class="document-info-desc">A direct interactive preview is not available in-app. Click the button below to launch it using your system's default program.</div>
          <button class="open-external-btn" id="card-open-btn">Open File</button>
        </div>
      `;

      const cardOpenBtn = document.getElementById("card-open-btn");
      if (cardOpenBtn) {
        cardOpenBtn.addEventListener("click", () => {
          openFile(filePath);
        });
      }
    }
  }
}

// Pinned Folders Operations
function renderPinnedList() {
  if (!pinnedList) return;
  pinnedList.innerHTML = "";

  if (pinnedFolders.length === 0) {
    pinnedList.innerHTML = `<p style="font-size:12px; color:var(--text-muted); padding: 5px 0;">No favorite folders pinned yet.</p>`;
    return;
  }

  pinnedFolders.forEach((folderPath) => {
    const name = path.basename(folderPath) || folderPath;
    
    const item = document.createElement("div");
    item.classList.add("pinned-item");
    item.title = folderPath; // Show full path on hover

    item.innerHTML = `
      <div class="pinned-item-info">
        <span>📁</span>
        <span class="pinned-item-name">${name}</span>
      </div>
      <button class="unpin-btn" title="Unpin folder">×</button>
    `;

    // Click to open folder
    item.addEventListener("click", (e) => {
      // Don't trigger if they clicked the unpin close button
      if (e.target.classList.contains("unpin-btn")) return;
      openRootFolder(folderPath);
    });

    // Unpin action
    const unpin = item.querySelector(".unpin-btn");
    unpin.addEventListener("click", (e) => {
      e.stopPropagation();
      pinnedFolders = pinnedFolders.filter(p => p !== folderPath);
      localStorage.setItem("pinnedFolders", JSON.stringify(pinnedFolders));
      renderPinnedList();
      updatePinButtonState();
    });

    pinnedList.appendChild(item);
  });
}

function updatePinButtonState() {
  if (!pinBtn) return;
  
  if (!currentRootPath) {
    pinBtn.disabled = true;
    pinBtn.textContent = "📌 Pin Current Folder";
    return;
  }

  pinBtn.disabled = false;
  const isPinned = pinnedFolders.includes(currentRootPath);
  if (isPinned) {
    pinBtn.textContent = "📍 Pinned";
    pinBtn.style.opacity = "0.7";
  } else {
    pinBtn.textContent = "📌 Pin Current Folder";
    pinBtn.style.opacity = "1";
  }
}

// Event Listeners Setup
if (btnSelectFolder) {
  btnSelectFolder.addEventListener("click", async () => {
    const folderPath = await ipcRenderer.invoke("select-folder");
    if (folderPath) {
      openRootFolder(folderPath);
    }
  });
}

if (pinBtn) {
  pinBtn.addEventListener("click", () => {
    if (currentRootPath && !pinnedFolders.includes(currentRootPath)) {
      pinnedFolders.push(currentRootPath);
      localStorage.setItem("pinnedFolders", JSON.stringify(pinnedFolders));
      renderPinnedList();
      updatePinButtonState();
    }
  });
}

// Re-render when controls change
[filterSelect, sortSelect, toggleDate, toggleSize].forEach(control => {
  if (control) {
    control.addEventListener("change", () => {
      // Clear caches on control toggle (sizes and match caches might need fresh calculations)
      folderSizeCache.clear();
      filterMatchCache.clear();
      renderTree();
    });
  }
});

// Open File Button in Header
if (openFileBtn) {
  openFileBtn.addEventListener("click", () => {
    if (selectedFilePath) {
      openFile(selectedFilePath);
    }
  });
}

// Run Initialization
document.addEventListener("DOMContentLoaded", initSettings);
// Fallback if DOMContentLoaded already fired
if (document.readyState === "interactive" || document.readyState === "complete") {
  initSettings();
}

const smartSidebarToggle = document.getElementById("smartSidebarToggle");

if (smartSidebarToggle) {
  smartSidebarToggle.addEventListener("change", () => {
    ipcRenderer.send("toggle-smart-sidebar", smartSidebarToggle.checked);
  });
}

// Make openRootFolder globally accessible
// Sidebar window can reuse same tree rendering logic
window.openRootFolder =
  openRootFolder;
