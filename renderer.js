const api = window.folderTree;
const $ = id => document.getElementById(id);
const treeContainer = $("tree-container");
const previewBody = $("preview-body");
let currentRootPath = null;
let selectedFilePath = null;
let pinnedFolders = [];
let treeVersion = 0;
let previewVersion = 0;
const expandedPaths = new Set();

function node(tag, className = "", text) {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function basename(value) { return value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || value; }
function isAbsolute(value) { return /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(value); }
function formatBytes(value) {
  if (!value) return "0 B";
  const index = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${parseFloat((value / 1024 ** index).toFixed(1))} ${["B", "KB", "MB", "GB", "TB"][index]}`;
}
function formatDate(value) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function options() {
  return { filter: $("filter-select")?.value || "all", sort: $("sort-select")?.value || "name-asc", showSize: !!$("toggle-size")?.checked };
}
function showError(container, error) {
  if (container) container.replaceChildren(node("p", "error-message", error.message || String(error)));
}
function resetPreviewPanel() {
  previewVersion++;
  if ($("preview-title")) $("preview-title").textContent = "No file selected";
  if ($("open-file-btn")) $("open-file-btn").disabled = true;
  $("preview-meta")?.replaceChildren();
  if (previewBody) {
    const empty = node("div", "empty-preview-state");
    empty.append(node("span", "empty-preview-icon", "👁️"), node("p", "", "Select a file from the tree to view its preview and details."));
    previewBody.replaceChildren(empty);
  }
}
async function openRootFolder(folderPath) {
  const version = ++treeVersion;
  currentRootPath = null;
  selectedFilePath = null;
  expandedPaths.clear();
  resetPreviewPanel();
  updatePinButtonState();
  treeContainer.replaceChildren(node("p", "status-message", "Loading folder..."));
  try {
    const entry = await api.openRoot(folderPath, options().showSize);
    if (version !== treeVersion) return;
    currentRootPath = entry.path;
    $("path").textContent = entry.path;
    updatePinButtonState();
    const root = await buildTreeNode(entry, version);
    if (version === treeVersion) treeContainer.replaceChildren(root);
  } catch (error) {
    if (version === treeVersion) showError(treeContainer, error);
  }
}
async function renderTree() {
  if (!currentRootPath) return;
  const version = ++treeVersion;
  const rootPath = currentRootPath;
  treeContainer.replaceChildren(node("p", "status-message", "Loading folder..."));
  try {
    const entry = await api.openRoot(rootPath, options().showSize);
    const root = await buildTreeNode(entry, version);
    if (version === treeVersion) treeContainer.replaceChildren(root);
  } catch (error) {
    if (version === treeVersion) showError(treeContainer, error);
  }
}
function iconFor(entry) {
  if (entry.isDirectory) return "📁";
  const ext = entry.extension;
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "🖼️";
  if (ext === ".pdf") return "📕";
  if ([".doc", ".docx"].includes(ext)) return "📘";
  if ([".xls", ".xlsx", ".csv"].includes(ext)) return "📗";
  if ([".ppt", ".pptx"].includes(ext)) return "📙";
  if ([".mp3", ".wav", ".ogg"].includes(ext)) return "🎵";
  if ([".mp4", ".webm", ".mkv"].includes(ext)) return "🎥";
  return "📄";
}
async function buildTreeNode(entry, version) {
  const item = node("div", entry.isDirectory ? "tree-item folder" : "tree-item");
  const header = node("div", "tree-item-header");
  const arrow = node("span", "arrow", "▶");
  const icon = node("span", "node-icon", iconFor(entry));
  if (entry.isDirectory) header.append(arrow); else icon.classList.add("file-icon");
  header.append(icon, node("span", "node-name", entry.name));
  const metadata = [];
  if (options().showSize) metadata.push(formatBytes(entry.size));
  if ($("toggle-date")?.checked) metadata.push(formatDate(entry.mtimeMs));
  if (metadata.length) header.append(node("span", "item-meta", `(${metadata.join(" | ")})`));
  item.append(header);
  if (entry.path === selectedFilePath) item.classList.add("active-file");
  if (entry.isDirectory) {
    const children = node("div", "children");
    item.append(children);
    let loaded = false;
    let loading = false;
    const load = async () => {
      if (loaded || loading) return;
      loading = true;
      children.replaceChildren(node("p", "status-message", "Loading..."));
      try {
        const entries = await api.readDirectory(entry.path, options());
        const nodes = [];
        for (const child of entries) nodes.push(await buildTreeNode(child, version));
        if (version !== treeVersion) return;
        children.replaceChildren(...nodes);
        if (!nodes.length) children.append(node("p", "status-message", "No matching files."));
        loaded = true;
      } catch (error) { if (version === treeVersion) showError(children, error); }
      finally { loading = false; }
    };
    const expand = expanded => {
      item.classList.toggle("expanded", expanded);
      icon.textContent = expanded ? "📂" : "📁";
    };
    header.addEventListener("click", async event => {
      event.stopPropagation();
      if (version !== treeVersion) return;
      const expanded = !expandedPaths.has(entry.path);
      if (expanded) expandedPaths.add(entry.path); else expandedPaths.delete(entry.path);
      expand(expanded);
      if (expanded) await load();
    });
    if (expandedPaths.has(entry.path)) { expand(true); await load(); }
  } else {
    header.addEventListener("click", () => {
      document.querySelectorAll(".tree-item.active-file").forEach(row => row.classList.remove("active-file"));
      item.classList.add("active-file");
      selectedFilePath = entry.path;
      if (previewBody) showFilePreview(entry.path);
      if (document.body.classList.contains("sidebar-mode")) openFile(entry.path);
    });
  }
  return item;
}
async function openFile(filePath) {
  try { await api.openFile(filePath); }
  catch (error) { showError(previewBody || treeContainer, error); }
}
function showMediaPreview(info) {
  const tag = { image: "img", audio: "audio", video: "video" }[info.kind];
  const wrapper = node("div", `${info.kind}-preview-wrapper`);
  const media = node(tag);
  media.src = info.url;
  if (tag === "img") media.alt = info.name;
  else {
    media.controls = true;
    if (tag === "audio") wrapper.append(node("span", "media-icon", "🎵"));
  }
  media.addEventListener("error", () => wrapper.replaceChildren(node("p", "error-message", "This file could not be previewed. Use Open to view it in another application.")));
  wrapper.append(media);
  previewBody.replaceChildren(wrapper);
}
async function showFilePreview(filePath) {
  const version = ++previewVersion;
  $("preview-meta")?.replaceChildren();
  previewBody.replaceChildren(node("p", "status-message", "Loading preview..."));
  $("preview-title").textContent = basename(filePath);
  $("open-file-btn").disabled = true;
  try {
    const info = await api.preview(filePath);
    if (version !== previewVersion) return;
    $("open-file-btn").disabled = false;
    $("preview-title").textContent = info.name;
    const meta = $("preview-meta");
    for (const [label, value] of [["Full Path:", info.path], ["File Size:", formatBytes(info.size)], ["Modified Date:", formatDate(info.mtimeMs)]]) {
      const row = node("div", "meta-row");
      row.append(node("span", "meta-key", label), node("span", "meta-val", value));
      if (label === "Full Path:") {
        row.classList.add("copy-path-row");
        const copy = node("button", "copy-btn", "📋 Copy");
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(info.path);
            copy.textContent = "Copied!";
            setTimeout(() => { copy.textContent = "📋 Copy"; }, 1500);
          } catch { copy.textContent = "Copy failed"; }
        });
        row.append(copy);
      }
      meta?.append(row);
    }
    if (["image", "audio", "video"].includes(info.kind)) showMediaPreview(info);
    else if (info.kind === "text") {
      const content = info.text + (info.truncated ? "\n\n... [Truncated! File size exceeds 50KB limit] ..." : "");
      const wrapper = node("div", "code-preview-wrapper");
      wrapper.append(node("div", "code-line-numbers", content.split("\n").map((_, index) => index + 1).join("\n")), node("div", "code-content", content));
      previewBody.replaceChildren(wrapper);
    } else {
      const types = { ".pdf": "PDF Document", ".doc": "Word Document", ".docx": "Word Document", ".xls": "Excel Spreadsheet", ".xlsx": "Excel Spreadsheet", ".csv": "Excel Spreadsheet", ".ppt": "PowerPoint Presentation", ".pptx": "PowerPoint Presentation" };
      const card = node("div", "document-placeholder-card");
      const open = node("button", "open-external-btn", "Open File");
      open.addEventListener("click", () => openFile(info.path));
      card.append(node("span", "document-icon", "📄"), node("div", "document-info-title", types[info.extension] || "Generic File"), node("div", "document-info-desc", "A preview is not available. Open this file using your system's default program."), open);
      previewBody.replaceChildren(card);
    }
  } catch (error) { if (version === previewVersion) showError(previewBody, error); }
}
function renderPinnedList() {
  const list = $("pinned-list");
  if (!list) return;
  list.replaceChildren();
  if (!pinnedFolders.length) list.append(node("p", "status-message", "No favorite folders pinned yet."));
  for (const folderPath of pinnedFolders) {
    const item = node("div", "pinned-item");
    item.title = folderPath;
    const info = node("div", "pinned-item-info");
    info.append(node("span", "", "📁"), node("span", "pinned-item-name", basename(folderPath)));
    const unpin = node("button", "unpin-btn", "×");
    unpin.title = "Unpin folder";
    unpin.addEventListener("click", event => {
      event.stopPropagation();
      pinnedFolders = pinnedFolders.filter(value => value !== folderPath);
      localStorage.setItem("pinnedFolders", JSON.stringify(pinnedFolders));
      renderPinnedList(); updatePinButtonState();
    });
    item.addEventListener("click", () => openRootFolder(folderPath));
    item.append(info, unpin);
    list.append(item);
  }
}
function updatePinButtonState() {
  const button = $("pin-btn");
  if (!button) return;
  const pinned = pinnedFolders.includes(currentRootPath);
  button.disabled = !currentRootPath || pinned;
  button.textContent = pinned ? "📍 Pinned" : "📌 Pin Current Folder";
}
function initSettings() {
  const savedTheme = localStorage.getItem("theme");
  const theme = savedTheme === "light" ? "light" : "dark";
  document.body.setAttribute("data-theme", theme);
  if ($("theme-select")) $("theme-select").value = theme;
  pinnedFolders = [];
  try {
    const saved = JSON.parse(localStorage.getItem("pinnedFolders"));
    if (Array.isArray(saved)) pinnedFolders = [...new Set(saved.filter(value => typeof value === "string" && value.trim() && !value.includes("\0") && isAbsolute(value)))];
  } catch { /* Ignore corrupt saved favorites. */ }
  renderPinnedList(); updatePinButtonState();
}
$("btn")?.addEventListener("click", async () => {
  try { const value = await api.selectFolder(); if (value) await openRootFolder(value); }
  catch (error) { showError(treeContainer, error); }
});
$("theme-select")?.addEventListener("change", event => {
  const theme = event.target.value;
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  api.setTheme(theme);
});
$("pin-btn")?.addEventListener("click", () => {
  if (currentRootPath && !pinnedFolders.includes(currentRootPath)) {
    pinnedFolders.push(currentRootPath);
    localStorage.setItem("pinnedFolders", JSON.stringify(pinnedFolders));
    renderPinnedList(); updatePinButtonState();
  }
});
for (const id of ["filter-select", "sort-select", "toggle-date", "toggle-size"]) $(id)?.addEventListener("change", renderTree);
$("open-file-btn")?.addEventListener("click", () => { if (selectedFilePath) openFile(selectedFilePath); });
$("smartSidebarToggle")?.addEventListener("change", event => api.setSidebar(event.target.checked));
initSettings();
window.openRootFolder = openRootFolder;
