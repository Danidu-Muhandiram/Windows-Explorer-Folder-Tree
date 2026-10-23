// Optional integration check: launches real Electron windows with show:false.
const electron = require("electron");
const { app, BrowserWindow, screen } = electron;
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const assert = require("node:assert/strict");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "folder-tree-smoke-"));
app.setPath("userData", path.join(fixture, "user-data"));
const folder = path.join(fixture, "files");
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, "sample #100%.txt"), "<script>literal text</script>");
const mainPath = path.resolve(__dirname, "../main.js");
const originalLoad = Module._load;
Module._load = function(name, parent, ...rest) {
  if (name === "electron" && parent?.filename === mainPath) {
    return { ...electron, BrowserWindow: class extends BrowserWindow {
      constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }); }
    } };
  }
  return originalLoad.call(this, name, parent, ...rest);
};
require(mainPath);
Module._load = originalLoad;

const timeout = setTimeout(() => { console.error("Electron smoke test timed out"); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  try {
    const windows = BrowserWindow.getAllWindows();
    assert.equal(windows.length, 2);
    for (const window of windows) {
      const contents = window.webContents;
      if (contents.isLoading()) await new Promise(resolve => contents.once("did-finish-load", resolve));
      const boundary = await contents.executeJavaScript('({node:typeof require,api:typeof window.folderTree.readDirectory})');
      assert.deepEqual(boundary, { node: "undefined", api: "function" });
    }
    const main = windows.find(window => window.webContents.getURL().endsWith("index.html"));
    const contents = main.webContents;
    await contents.executeJavaScript(`openRootFolder(${JSON.stringify(folder)})`);
    await contents.executeJavaScript('document.querySelector(\'[role="treeitem"]\').treeAction(true)');
    assert.equal(await contents.executeJavaScript('visibleTreeItems().length'), 2);
    await contents.executeJavaScript('document.querySelector(\'[role="treeitem"]\').dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowDown",bubbles:true}))');
    assert.match(await contents.executeJavaScript('document.activeElement.dataset.path'), /sample #100%\.txt$/);
    await contents.executeJavaScript(`showFilePreview(${JSON.stringify(path.join(folder, "sample #100%.txt"))})`);
    assert.equal(await contents.executeJavaScript('document.querySelector(".code-content").textContent'), "<script>literal text</script>");
    fs.writeFileSync(path.join(folder, "new.txt"), "new");
    await contents.executeJavaScript("renderTree()");
    // Exercise the complete control flow, not only helper functions.
    await contents.executeJavaScript('(async () => { document.getElementById("filter-select").value = "png"; await renderTree(); })()');
    assert.match(await contents.executeJavaScript('document.getElementById("tree-container").textContent'), /No files match/);
    await contents.executeJavaScript('(async () => { document.getElementById("filter-select").value = "all"; document.getElementById("sort-select").value = "size-desc"; await renderTree(); })()');
    assert.equal(await contents.executeJavaScript("visibleTreeItems().length"), 3);
    assert.equal(await contents.executeJavaScript("visibleTreeItems().length"), 3);
    const cancelled = await contents.executeJavaScript(`(async () => {
      const pending = withScan("readDirectory", [${JSON.stringify(folder)}, {filter:"all",sort:"size-asc",showSize:true}]).catch(error => error.message);
      document.getElementById("cancel-scan-btn").click();
      return await pending;
    })()`);
    assert.match(cancelled, /Scan cancelled/);
    await contents.executeJavaScript("renderTree()");
    // A representative workspace for checking long paths, dense rows and previews.
    const demo = path.join(fixture, "project-workspace");
    fs.mkdirSync(path.join(demo, "src", "components"), { recursive: true });
    fs.mkdirSync(path.join(demo, "docs"));
    fs.mkdirSync(path.join(demo, "assets"));
    const readme = "# Project workspace\n\nA place for your next idea.\n\n## Getting started\n\n1. Open a folder\n2. Explore the file tree\n3. Preview a file\n\nEverything stays on your computer.\n";
    fs.writeFileSync(path.join(demo, "README.md"), readme);
    fs.writeFileSync(path.join(demo, "package.json"), '{"name":"project-workspace","version":"1.0.0"}');
    fs.writeFileSync(path.join(demo, "docs", "notes.txt"), "Project notes");
    fs.writeFileSync(path.join(demo, "src", "main.js"), 'console.log("Hello, world!");');
    for (const name of ["Button.js", "FilePreview.js", "Navigation.js", "FolderTree.js"]) fs.writeFileSync(path.join(demo, "src", "components", name), "// Component\n");
    fs.writeFileSync(path.join(demo, "assets", "sample.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" rx="16" fill="#6366f1"/><text x="160" y="96" text-anchor="middle" fill="white" font-size="24">Local image preview</text></svg>');
    await contents.executeJavaScript(`openRootFolder(${JSON.stringify(demo)})`);
    await contents.executeJavaScript('document.querySelector(\'[role="treeitem"]\').treeAction(true)');
    await contents.executeJavaScript(`(async () => {
      const row = [...document.querySelectorAll('[role="treeitem"]')].find(row => row.dataset.path.endsWith("src"));
      await row.treeAction(true);
      const components = [...document.querySelectorAll('[role="treeitem"]')].find(row => row.dataset.path.endsWith("components"));
      await components.treeAction(true);
      pinnedFolders = [${JSON.stringify(demo)}, ${JSON.stringify(path.join(demo, "docs"))}];
      renderPinnedList();
      updatePinButtonState();
      selectedFilePath = ${JSON.stringify(path.join(demo, "README.md"))};
      const selected = [...document.querySelectorAll('[role="treeitem"]')].find(row => row.dataset.path === selectedFilePath);
      selected.classList.add("active-file");
      selected.setAttribute("aria-selected", "true");
      await showFilePreview(selectedFilePath);
    })()`);
    const cache = path.resolve(__dirname, "../.cache");
    fs.mkdirSync(cache, { recursive: true });
    async function capture(window, filename) {
      // Keep machine-specific usernames/temp paths out of documentation images.
      await window.webContents.executeJavaScript(`(() => {
        for (const element of document.querySelectorAll('#path, .copy-path-row .meta-val')) {
          element.textContent = element.textContent.replace(${JSON.stringify(fixture)}, "C:\\\\Examples");
        }
      })()`);
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(cache, filename), (await window.webContents.capturePage({ stayHidden: true })).toPNG());
    }
    await capture(main, "electron-main-dark.png");
    await contents.executeJavaScript('document.getElementById("theme-select").value="light"; document.getElementById("theme-select").dispatchEvent(new Event("change"))');
    await capture(main, "electron-main-light.png");
    await contents.executeJavaScript('document.getElementById("theme-select").value="dark"; document.getElementById("theme-select").dispatchEvent(new Event("change"))');
    const sidebar = windows.find(window => window !== main);
    await sidebar.webContents.executeJavaScript(`openRootFolder(${JSON.stringify(demo)})`);
    await sidebar.webContents.executeJavaScript('document.querySelector(\'[role="treeitem"]\').treeAction(true)');
    await capture(sidebar, "electron-sidebar.png");
    assert.equal(await sidebar.webContents.executeJavaScript('document.body.getAttribute("data-theme")'), "dark");
    await contents.executeJavaScript('document.getElementById("toggle-preview-btn").click()');
    assert.equal(await contents.executeJavaScript('document.getElementById("preview-panel").hidden'), true);
    await capture(main, "electron-main-tree-only.png");
    await contents.executeJavaScript('document.getElementById("toggle-preview-btn").click(); document.getElementById("preview-divider").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))');
    assert.equal(await contents.executeJavaScript('document.getElementById("preview-divider").getAttribute("aria-valuenow")'), "376");
    // The minimum supported size must still leave every main panel usable.
    main.setSize(800, 560);
    await capture(main, "electron-main-small.png");
    for (const window of windows) {
      const geometry = await window.webContents.executeJavaScript(`(() => {
        const tree = document.getElementById("tree-container").getBoundingClientRect();
        return { pageOverflow: document.documentElement.scrollWidth > innerWidth, treeWidth:tree.width, treeHeight:tree.height };
      })()`);
      assert.equal(geometry.pageOverflow, false);
      assert.ok(geometry.treeWidth >= 150 && geometry.treeHeight >= 150);
    }
    // Large-folder rendering must yield to renderer timers instead of locking input.
    const large = path.join(fixture, "large-folder");
    fs.mkdirSync(large);
    for (let index = 0; index < 1200; index++) fs.writeFileSync(path.join(large, `document-${String(index).padStart(4, "0")}.txt`), "content");
    const stress = await contents.executeJavaScript(`(async () => {
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const start = performance.now();
      try {
        await openRootFolder(${JSON.stringify(large)});
        await document.querySelector('[role="treeitem"]').treeAction(true);
        return { rows: visibleTreeItems().length, elapsedMs:Math.round(performance.now()-start), ticks };
      } finally { clearInterval(timer); }
    })()`);
    assert.equal(stress.rows, 1201);
    assert.ok(stress.ticks > 0);
    console.log(JSON.stringify({ result: "passed", windows: windows.length,
      displays: screen.getAllDisplays().map(display => ({ bounds: display.bounds, scaleFactor: display.scaleFactor })), screenshots: cache, stress }));
    clearTimeout(timeout);
    // Destroy both windows so worker cleanup and normal app shutdown run too.
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    app.quit();
  } catch (error) {
    clearTimeout(timeout);
    console.error(error);
    app.exit(1);
  }
});
app.on("quit", () => {
  const target = path.resolve(fixture);
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith("folder-tree-smoke-")) {
    // Windows may still hold Chromium cache files briefly; leave only this temp
    // fixture if cleanup cannot complete immediately.
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
});
