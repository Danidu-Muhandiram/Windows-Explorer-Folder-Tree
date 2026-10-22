const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { execFileSync } = require("node:child_process");

// Exercise the real main process handlers without opening or resizing desktop windows.
function createApp({ openPath = async () => "" } = {}) {
  const windows = [];
  const watchers = [];
  const handlers = {};
  const timers = new Map();
  const errors = [];
  const dialogs = [];
  const screen = new EventEmitter();
  screen.screenToDipRect = (_window, rect) => rect;
  screen.getDisplayMatching = () => ({ workArea: { x: -10000, y: -10000, width: 20000, height: 20000 } });
  const app = new EventEmitter();
  app.whenReady = () => ({ then: (fn) => fn() });
  app.exited = false;
  app.quit = () => {
    let prevented = false;
    app.emit("before-quit", { preventDefault() { prevented = true; } });
    if (!prevented) {
      windows.forEach((window) => { window.destroyed = true; });
      app.exited = true;
    }
  };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = !!options.show;
      this.destroyed = false;
      this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: "" };
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.setWindowOpenHandler = handler => { this.webContents.openHandler = handler; };
      this.webContents.session = { setPermissionRequestHandler() {} };
      this.webContents.loading = false;
      this.webContents.isLoading = () => this.webContents.loading;
      this.webContents.send = (...args) => this.messages.push(args);
      windows.push(this);
    }
    loadFile(file) { this.webContents.mainFrame.url = require("node:url").pathToFileURL(path.resolve(__dirname, "..", file)).href; }
    isDestroyed() { return this.destroyed; }
    isFocused() { return false; }
    setAlwaysOnTop() {}
    hide() { this.visible = false; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    setBounds(bounds) { this.bounds = bounds; }
    close() { this.destroyed = true; this.emit("closed"); }
  }
  const context = {
    require(name) {
      if (name === "electron") return {
        app, BrowserWindow: Window,
        ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on: (name, fn) => { handlers[name] = fn; } },
        shell: { openPath }, screen,
        dialog: { showErrorBox: (...args) => dialogs.push(args) }, Menu: { setApplicationMenu() {} }
      };
      if (name === "child_process") return { spawn() {
        const watcher = new EventEmitter();
        watcher.stdout = new PassThrough();
        watcher.stderr = new PassThrough();
        watcher.stdin = new PassThrough();
        watcher.commands = [];
        watcher.stdin.on("data", (chunk) => watcher.commands.push(chunk.toString()));
        watcher.kill = () => { watcher.killed = true; };
        watchers.push(watcher);
        return watcher;
      } };
      if (name === "./worker-client") return { createWorkerSession() {
        const session = require("../file-service").createFileSession();
        return { ...session, openRoot: (value, size) => session.openRoot(value, size),
          readDirectory: (value, options) => session.readDirectory(value, options), cancel() {}, dispose() {} };
      } };
      return require(name.startsWith("./") ? "../" + name.slice(2) : name);
    },
    __dirname: path.resolve(__dirname, ".."), process,
    console: { log() {}, error: (...args) => errors.push(args) },
    setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8"), context);
  return { app, windows, watchers, timers, errors, dialogs,
    invoke: (channel, window, ...args) => handlers[channel]({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args),
    rawInvoke: (channel, event, ...args) => handlers[channel](event, ...args),
    toggle: (enabled) => handlers["toggle-smart-sidebar"]({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }, enabled) };
}

const state = (overrides = {}) => ({
  hwnd: 1, path: "C:\\Pictures", x: 10, y: 20, width: 900, height: 600,
  minimized: false, isActive: true, ...overrides
});
const send = (watcher, data) => watcher.stdout.write(JSON.stringify(data) + "\r\n");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("closing main window exits even with a hidden sidebar", () => {
  const { app, windows } = createApp();
  windows[0].close();
  assert.equal(app.exited, true);
  assert.equal(windows[1].isDestroyed(), true);
});

test("shutdown waits for watcher restoration, then closes sidebar", async () => {
  const fixture = createApp();
  await fixture.toggle(true);
  fixture.windows[0].close();
  assert.equal(fixture.app.exited, false);
  assert.deepEqual(fixture.watchers[0].commands, ["exit\n"]);
  fixture.watchers[0].emit("close");
  await flush();
  assert.equal(fixture.app.exited, true);
  assert.equal(fixture.windows[1].isDestroyed(), true);
  assert.equal(fixture.timers.size, 0);
});

test("shutdown has a bounded fallback for an unresponsive watcher", async () => {
  const fixture = createApp();
  await fixture.toggle(true);
  fixture.app.quit();
  [...fixture.timers.values()][0]();
  await flush();
  assert.equal(fixture.watchers[0].killed, true);
  assert.equal(fixture.app.exited, true);
});

test("partial JSON, split Unicode and multiple lines are decoded without loss", async () => {
  const fixture = createApp();
  await fixture.toggle(true);
  const watcher = fixture.watchers[0];
  const first = state({ path: "C:\\日本語" });
  const bytes = Buffer.from(JSON.stringify(first) + "\r\n");
  // Feed byte by byte to split both JSON tokens and multibyte UTF-8 characters.
  for (const byte of bytes) watcher.stdout.write(Buffer.from([byte]));
  watcher.stdout.write("\nnot-json\n" + JSON.stringify(state({ path: "C:\\Other" })) + "\n");
  assert.deepEqual(fixture.windows[1].messages, [
    ["explorer-path-update", first.path], ["explorer-path-update", "C:\\Other"]
  ]);
  assert.equal(fixture.errors.length, 1);
});

test("geometry, focus and minimize updates preserve the tree; navigation reloads it", async () => {
  const fixture = createApp();
  await fixture.toggle(true);
  const watcher = fixture.watchers[0];
  send(watcher, state());
  send(watcher, state({ x: 100, width: 800, isActive: false }));
  send(watcher, state({ minimized: true }));
  assert.equal(fixture.windows[1].isVisible(), false);
  send(watcher, state());
  assert.equal(fixture.windows[1].isVisible(), true);
  assert.equal(fixture.windows[1].messages.length, 1);
  send(watcher, state({ path: "C:\\New" }));
  assert.equal(fixture.windows[1].messages.length, 2);
});

test("sidebar loading queues only the latest folder", async () => {
  const fixture = createApp();
  const sidebar = fixture.windows[1];
  sidebar.webContents.loading = true;
  await fixture.toggle(true);
  send(fixture.watchers[0], state());
  send(fixture.watchers[0], state({ path: "C:\\New" }));
  assert.equal(sidebar.messages.length, 0);
  sidebar.webContents.loading = false;
  sidebar.webContents.emit("did-finish-load");
  assert.deepEqual(sidebar.messages, [["explorer-path-update", "C:\\New"]]);
});

test("stopping watcher ignores queued updates and rapid toggles honor final state", async () => {
  const fixture = createApp();
  await fixture.toggle(true);
  const oldWatcher = fixture.watchers[0];
  await fixture.toggle(false);
  const enabling = fixture.toggle(true);
  await fixture.toggle(false);
  send(oldWatcher, state());
  assert.equal(fixture.windows[1].messages.length, 0);
  oldWatcher.emit("close");
  await enabling;
  assert.equal(fixture.watchers.length, 1);
  await fixture.toggle(true);
  assert.equal(fixture.watchers.length, 2);
  send(fixture.watchers[1], state());
  assert.equal(fixture.windows[1].messages.length, 1);
});

test("PowerShell docking tracks each Explorer window independently", { skip: process.platform !== "win32" }, () => {
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(__dirname, "watcher-docking.test.ps1")], { stdio: "pipe" });
});

test("unexpected watcher exit permits restart and resends the current folder", async () => {
  const fixture = createApp();
  await fixture.toggle(true);
  send(fixture.watchers[0], state());
  fixture.watchers[0].emit("close", 1);
  assert.equal(fixture.windows[1].isVisible(), false);
  await fixture.toggle(false);
  await fixture.toggle(true);
  assert.equal(fixture.watchers.length, 2);
  send(fixture.watchers[1], state());
  assert.equal(fixture.windows[1].isVisible(), true);
  assert.equal(fixture.windows[1].messages.length, 2);
});

test("file-open failures appear in native dialogs for validated app windows", async () => {
  const fixture = createApp({ openPath: async () => "No default application" });
  for (const window of fixture.windows) {
    await fixture.invoke("browse-root", window, __dirname);
    assert.equal(await fixture.invoke("open-file", window, __filename), false);
  }
  assert.equal(fixture.dialogs.length, 2);
  assert.deepEqual(fixture.dialogs[0], ["Could not open file", "No default application"]);
});

test("both windows are sandboxed, isolated and block navigation and popups", () => {
  const fixture = createApp();
  for (const window of fixture.windows) {
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.ok(window.options.webPreferences.preload.endsWith("preload.js"));
    assert.equal(window.webContents.openHandler().action, "deny");
    let blocked = false;
    window.webContents.emit("will-navigate", { preventDefault() { blocked = true; } }, "https://example.com");
    assert.equal(blocked, true);
    blocked = false;
    window.webContents.emit("will-frame-navigate", { preventDefault() { blocked = true; } }, { isMainFrame: false, url: window.webContents.mainFrame.url });
    assert.equal(blocked, true);
  }
});

test("filesystem IPC rejects unknown senders, subframes and navigated documents", async () => {
  const fixture = createApp();
  const window = fixture.windows[0];
  for (const event of [
    { sender: {}, senderFrame: window.webContents.mainFrame },
    { sender: window.webContents, senderFrame: { url: window.webContents.mainFrame.url } }
  ]) {
    assert.throws(() => fixture.rawInvoke("browse-root", event, __dirname), /Unauthorized/);
    assert.throws(() => fixture.rawInvoke("cancel-scan", event, 1), /Unauthorized/);
  }
  window.webContents.mainFrame.url = "https://example.com";
  assert.throws(() => fixture.invoke("browse-root", window, __dirname), /Unauthorized/);
});
