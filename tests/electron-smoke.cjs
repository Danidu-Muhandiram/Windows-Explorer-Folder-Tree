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
      constructor(options) { super({ ...options, show: false }); }
    } };
  }
  return originalLoad.call(this, name, parent, ...rest);
};
require(mainPath);
Module._load = originalLoad;

const timeout = setTimeout(() => { console.error("Electron smoke test timed out"); app.exit(1); }, 20000);
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
    assert.equal(await contents.executeJavaScript("visibleTreeItems().length"), 3);
    const cancelled = await contents.executeJavaScript(`(async () => {
      const pending = withScan("readDirectory", [${JSON.stringify(folder)}, {filter:"all",sort:"size-asc",showSize:true}]).catch(error => error.message);
      document.getElementById("cancel-scan-btn").click();
      return await pending;
    })()`);
    assert.match(cancelled, /Scan cancelled/);
    await contents.executeJavaScript("renderTree()");
    const screenshot = path.resolve(__dirname, "../.cache/electron-smoke.png");
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    fs.writeFileSync(screenshot, (await contents.capturePage()).toPNG());
    console.log(JSON.stringify({ result: "passed", windows: windows.length,
      displays: screen.getAllDisplays().map(display => ({ bounds: display.bounds, scaleFactor: display.scaleFactor })), screenshot }));
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
