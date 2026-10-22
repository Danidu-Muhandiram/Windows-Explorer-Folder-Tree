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
const activeScans = new Map();
let nextScanId = 0;
let lastRequestedRoot = null;

function scanCancelled(error) { return /Scan cancelled|Folder changed/.test(error.message || ""); }
function updateScanStatus(message = "") {
  const bar = $("scan-status");
  if (!bar) return;
  const jobs = [...activeScans.values()].filter(job => !job.cancelled);
  bar.hidden = !jobs.length && !message;
  $("scan-progress").hidden = !jobs.length;
  $("cancel-scan-btn").hidden = !jobs.length;
  const checked = jobs.reduce((sum, job) => sum + (job.scanned || 0), 0);
  $("scan-message").textContent = jobs.length ? `Checking ${checked.toLocaleString()} entries…` : message;
  $("scan-message").title = jobs.at(-1)?.currentPath || "";
  treeContainer.setAttribute("aria-busy", String(jobs.length > 0));
}
async function withScan(method, args, consume = value => value) {
  const id = ++nextScanId;
  const job = { cancelled: false, skipped: 0, path: args[0], version: treeVersion };
  activeScans.set(id, job);
  updateScanStatus();
  let message = "";
  try {
    const result = await api[method](...args, id);
    if (job.cancelled) throw new Error("Scan cancelled");
    return await consume(result, job);
  } catch (error) {
    if (scanCancelled(error)) message = "Scan cancelled. Refresh or expand the folder to try again.";
    throw error;
  } finally {
    activeScans.delete(id);
    if (!message && job.skipped) message = `Skipped ${job.skipped} inaccessible entries. Some results or sizes may be incomplete.`;
    updateScanStatus(job.version === treeVersion ? message : "");
  }
}
function cancelScans(folderPath = null) {
  if (!activeScans.size) return;
  for (const [id, job] of activeScans) {
    if (folderPath && job.path !== folderPath && !job.path.startsWith(folderPath + "\\") && !job.path.startsWith(folderPath + "/")) continue;
    job.cancelled = true;
    api.cancelScan?.(id).catch(error => showError(treeContainer, error));
  }
  updateScanStatus("Scan cancelled. Refresh or expand the folder to try again.");
}
api.onScanProgress?.(progress => {
  const job = activeScans.get(progress.requestId);
  if (!job || job.cancelled) return;
  Object.assign(job, progress);
  updateScanStatus();
});

function visibleTreeItems() {
  return [...treeContainer.querySelectorAll('[role="treeitem"]')].filter(item => item.getClientRects().length > 0);
}
function focusTreeItem(item) {
  if (!item) return;
  for (const row of treeContainer.querySelectorAll('[role="treeitem"]')) row.tabIndex = row === item ? 0 : -1;
  item.focus();
}
function restoreTreeFocus(path, hadFocus) {
  const rows = visibleTreeItems();
  const row = rows.find(item => item.dataset.path === path) || rows[0];
  if (row) {
    row.tabIndex = 0;
    if (hadFocus) focusTreeItem(row);
  }
}

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
function showError(container, error, retry) {
  if (!container) return;
  const wrapper = node("div", "error-state");
  const message = scanCancelled(error) ? "Scan cancelled." :
    /ENOENT/.test(error.message) ? "This file or folder no longer exists. Refresh to update the tree." :
    /EACCES|EPERM/.test(error.message) ? "Access denied. Choose another folder or check its permissions." : error.message || String(error);
  const paragraph = node("p", "error-message", message);
  paragraph.setAttribute("role", scanCancelled(error) ? "status" : "alert");
  wrapper.append(paragraph);
  if (retry) {
    const button = node("button", "secondary-btn", "Try again");
    button.addEventListener("click", retry);
    wrapper.append(button);
  }
  container.replaceChildren(wrapper);
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
  cancelScans();
  lastRequestedRoot = folderPath;
  const version = ++treeVersion;
  currentRootPath = null;
  selectedFilePath = null;
  expandedPaths.clear();
  resetPreviewPanel();
  updatePinButtonState();
  treeContainer.replaceChildren(node("p", "status-message", "Loading folder..."));
  try {
    const entry = await withScan("openRoot", [folderPath, options().showSize]);
    if (version !== treeVersion) return;
    currentRootPath = entry.path;
    $("path").textContent = entry.path;
    updatePinButtonState();
    const root = await buildTreeNode(entry, version);
    if (version === treeVersion) {
      treeContainer.replaceChildren(root);
      restoreTreeFocus(null, false);
    }
  } catch (error) {
    if (version === treeVersion) showError(treeContainer, error, () => openRootFolder(folderPath));
  }
}
async function renderTree() {
  if (!currentRootPath) {
    if (lastRequestedRoot) return openRootFolder(lastRequestedRoot);
    return;
  }
  const hadFocus = treeContainer.contains(document.activeElement);
  const focusedPath = document.activeElement?.dataset?.path;
  cancelScans();
  const version = ++treeVersion;
  const rootPath = currentRootPath;
  selectedFilePath = null;
  resetPreviewPanel();
  treeContainer.replaceChildren(node("p", "status-message", "Loading folder..."));
  try {
    const entry = await withScan("openRoot", [rootPath, options().showSize]);
    if (version !== treeVersion) return;
    const root = await buildTreeNode(entry, version);
    if (version === treeVersion) {
      treeContainer.replaceChildren(root);
      restoreTreeFocus(focusedPath, hadFocus);
    }
  } catch (error) {
    if (version === treeVersion) showError(treeContainer, error, renderTree);
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
  item.setAttribute("role", "treeitem");
  item.setAttribute("aria-label", entry.name);
  item.dataset.path = entry.path;
  item.tabIndex = -1;
  item.addEventListener("focus", event => {
    if (event.target !== item) return;
    for (const row of treeContainer.querySelectorAll('[role="treeitem"]')) row.tabIndex = row === item ? 0 : -1;
  });
  const header = node("div", "tree-item-header");
  const arrow = node("span", "arrow", "▶");
  const icon = node("span", "node-icon", iconFor(entry));
  if (entry.isDirectory) header.append(arrow); else icon.classList.add("file-icon");
  header.append(icon, node("span", "node-name", entry.name));
  const metadata = [];
  if (options().showSize) metadata.push(`${entry.partial ? "At least " : ""}${formatBytes(entry.size)}`);
  if ($("toggle-date")?.checked) metadata.push(formatDate(entry.mtimeMs));
  if (metadata.length) header.append(node("span", "item-meta", `(${metadata.join(" | ")})`));
  item.append(header);
  if (entry.path === selectedFilePath) item.classList.add("active-file");
  if (entry.isDirectory) {
    const children = node("div", "children");
    children.setAttribute("role", "group");
    item.setAttribute("aria-expanded", "false");
    item.append(children);
    let loaded = false;
    let loading = false;
    const load = async () => {
      if (loaded || loading) return;
      loading = true;
      children.replaceChildren(node("p", "status-message", "Loading..."));
      try {
        await withScan("readDirectory", [entry.path, options()], async (entries, job) => {
          children.replaceChildren();
          for (let index = 0; index < entries.length; index++) {
            if (job.cancelled || version !== treeVersion) throw new Error("Scan cancelled");
            children.append(await buildTreeNode(entries[index], version));
            // Let input and painting run while building large directory listings.
            if (index % 100 === 99) await new Promise(resolve => setTimeout(resolve, 0));
          }
          if (!entries.length) children.append(node("p", "status-message", options().filter === "all" ? "This folder is empty." : "No files match the selected filter."));
          loaded = true;
        });
      } catch (error) { if (version === treeVersion) showError(children, error, load); }
      finally { loading = false; }
    };
    const expand = expanded => {
      item.classList.toggle("expanded", expanded);
      item.setAttribute("aria-expanded", String(expanded));
      icon.textContent = expanded ? "📂" : "📁";
    };
    header.addEventListener("click", async event => {
      event.stopPropagation();
      focusTreeItem(item);
      if (version !== treeVersion) return;
      const expanded = !expandedPaths.has(entry.path);
      if (expanded) expandedPaths.add(entry.path); else expandedPaths.delete(entry.path);
      expand(expanded);
      if (!expanded) cancelScans(entry.path);
      if (expanded) await load();
    });
    if (expandedPaths.has(entry.path)) { expand(true); await load(); }
    item.treeAction = async expanded => {
      if (expanded) expandedPaths.add(entry.path); else expandedPaths.delete(entry.path);
      expand(expanded);
      if (!expanded) cancelScans(entry.path);
      if (expanded) await load();
    };
  } else {
    const selectFile = () => {
      document.querySelectorAll(".tree-item.active-file").forEach(row => row.classList.remove("active-file"));
      document.querySelectorAll('[role="treeitem"]').forEach(row => row.setAttribute("aria-selected", "false"));
      item.classList.add("active-file");
      item.setAttribute("aria-selected", "true");
      selectedFilePath = entry.path;
      if (previewBody) showFilePreview(entry.path);
      if (document.body.classList.contains("sidebar-mode")) openFile(entry.path);
    };
    header.addEventListener("click", () => { focusTreeItem(item); selectFile(); });
    item.treeAction = selectFile;
  }
  item.addEventListener("keydown", async event => {
    if (event.target !== item) return;
    const keys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "];
    if (!keys.includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const rows = visibleTreeItems();
    const index = rows.indexOf(item);
    if (event.key === "ArrowDown") focusTreeItem(rows[Math.min(rows.length - 1, index + 1)]);
    else if (event.key === "ArrowUp") focusTreeItem(rows[Math.max(0, index - 1)]);
    else if (event.key === "Home") focusTreeItem(rows[0]);
    else if (event.key === "End") focusTreeItem(rows.at(-1));
    else if (event.key === "ArrowRight" && entry.isDirectory) {
      if (!expandedPaths.has(entry.path)) await item.treeAction(true);
      else focusTreeItem(item.querySelector('[role="group"] > [role="treeitem"]'));
    } else if (event.key === "ArrowLeft") {
      if (entry.isDirectory && expandedPaths.has(entry.path)) await item.treeAction(false);
      else focusTreeItem(item.parentElement?.closest('[role="treeitem"]'));
    } else if (event.key === "Enter" || event.key === " ") {
      await item.treeAction(entry.isDirectory ? !expandedPaths.has(entry.path) : undefined);
    }
  });
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
    const info = node("button", "pinned-item-info favorite-open");
    info.title = folderPath;
    info.append(node("span", "", "📁"), node("span", "pinned-item-name", basename(folderPath)));
    const unpin = node("button", "unpin-btn", "×");
    unpin.title = "Unpin folder";
    unpin.addEventListener("click", event => {
      event.stopPropagation();
      pinnedFolders = pinnedFolders.filter(value => value !== folderPath);
      localStorage.setItem("pinnedFolders", JSON.stringify(pinnedFolders));
      renderPinnedList(); updatePinButtonState();
    });
    info.addEventListener("click", () => openRootFolder(folderPath));
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
$("refresh-btn")?.addEventListener("click", renderTree);
$("cancel-scan-btn")?.addEventListener("click", () => cancelScans());
document.addEventListener("keydown", event => {
  if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")) {
    event.preventDefault(); renderTree();
  } else if (event.key === "Escape" && activeScans.size) {
    event.preventDefault(); cancelScans();
  }
});
initSettings();
window.openRootFolder = openRootFolder;
