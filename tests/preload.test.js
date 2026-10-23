const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

test("preload exposes fixed capabilities and strips privileged event objects", async () => {
  const ipc = new EventEmitter();
  const calls = [];
  ipc.invoke = (...args) => { calls.push(args); return Promise.resolve("result"); };
  ipc.send = (...args) => calls.push(args);
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "folderTree"); api = value; } } };
    }
  });
  assert.equal(api.invoke, undefined);
  assert.equal(api.send, undefined);
  assert.equal(api.require, undefined);
  assert.equal(await api.preview("C:/root/sample.txt"), "result");
  assert.deepEqual(calls[0], ["preview-file", "C:/root/sample.txt"]);
  let received;
  const unsubscribe = api.onExplorerPath((...args) => { received = args; });
  ipc.emit("explorer-path-update", { sender: "privileged" }, "C:/root");
  assert.deepEqual(received, ["C:/root"]);
  unsubscribe();
  assert.equal(ipc.listenerCount("explorer-path-update"), 0);
  let progress;
  const stopProgress = api.onScanProgress(value => { progress = value; });
  ipc.emit("scan-progress", { sender: "privileged" }, { requestId: 7, scanned: 42 });
  assert.deepEqual(progress, { requestId: 7, scanned: 42 });
  stopProgress();
  await api.cancelScan(7);
  assert.deepEqual(calls.at(-1), ["cancel-scan", 7]);
  ipc.invoke = async () => ({ cancelled: true });
  await assert.rejects(api.readDirectory("C:/root", { filter: "all" }, 8), /Scan cancelled/);
});

test("both HTML pages enforce CSP and have no inline scripts or styles", () => {
  for (const file of ["index.html", "sidebar.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src 'self'/);
    assert.match(html, /object-src 'none'/);
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|\sstyle=|\son\w+=/i);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  }
});
