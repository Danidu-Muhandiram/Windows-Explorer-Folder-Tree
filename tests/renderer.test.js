const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element(tagName = "div", ownerDocument) {
  const classes = new Set();
  const attributes = new Map();
  const result = {
    tagName, children: [], handlers: {}, style: {}, dataset: {}, ownerDocument,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle(value, force) { if (force) classes.add(value); else classes.delete(value); } },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    contains(child) { return child === this || this.children.some(item => item.contains(child)); },
    focus() { if (ownerDocument) ownerDocument.activeElement = this; this.handlers.focus?.({ target: this }); },
    closest(selector) {
      if (selector === '[role="treeitem"]' && this.getAttribute("role") === "treeitem") return this;
      return this.parentElement?.closest(selector) || null;
    },
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return descendants;
      if (selector === '[role="treeitem"]') return descendants.filter(child => child.getAttribute("role") === "treeitem");
      return descendants.filter(child => child.classList.contains("active-file"));
    },
    querySelector() { return this.children.find(child => child.getAttribute("role") === "group")?.children.find(child => child.getAttribute("role") === "treeitem") || null; },
    getClientRects() {
      let parent = this.parentElement;
      while (parent) {
        if (parent.getAttribute("role") === "group" && parent.parentElement?.getAttribute("aria-expanded") !== "true") return [];
        parent = parent.parentElement;
      }
      return [{}];
    }
  };
  Object.defineProperty(result, "className", { get: () => [...classes].join(" "), set(value) { classes.clear(); for (const name of value.split(" ").filter(Boolean)) classes.add(name); } });
  Object.defineProperty(result, "innerHTML", { set() { throw new Error("Unsafe HTML insertion"); } });
  return result;
}

function renderer({ savedPins = null, api = {} } = {}) {
  const document = { handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } };
  const elements = Object.fromEntries(["tree-container", "path", "preview-body", "preview-meta", "preview-title", "open-file-btn", "pinned-list", "pin-btn", "refresh-btn", "scan-status", "scan-progress", "scan-message", "cancel-scan-btn"].map(id => [id, element("div", document)]));
  Object.assign(document, { getElementById: id => elements[id] || null,
    createElement: tag => element(tag, document), body: element("body", document),
    querySelectorAll: selector => elements["tree-container"].querySelectorAll(selector) });
  const context = {
    document,
    localStorage: { getItem: key => key === "pinnedFolders" ? savedPins : null, setItem() {} },
    window: { folderTree: api }, console, setTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer.js"), "utf8"), context);
  return { context, elements, run: source => vm.runInContext(source, context) };
}

test("renderer initializes without Node globals and validates saved favorites", () => {
  const valid = "C:\\favorites";
  for (const [savedPins, expected] of [
    ["{}", []], ["null", []], ['"hello"', []], ["1", []], ["{invalid", []],
    [JSON.stringify([null, {}, 42, "", " ", "relative", "bad\0path", valid, valid]), [valid]]
  ]) {
    const fixture = renderer({ savedPins });
    assert.equal(fixture.run("typeof require"), "undefined");
    assert.deepEqual(Array.from(fixture.run("pinnedFolders")), expected);
  }
});

test("filenames, favorite labels and text previews render as text without HTML sinks", async () => {
  const name = '<img src=x onerror="alert(1)">.txt';
  const info = { path: `C:\\root\\${name}`, name, isDirectory: false, extension: ".txt", size: 30, mtimeMs: 0, kind: "text", text: "<script>alert(1)</script>\n&hello" };
  const fixture = renderer({ api: { preview: async () => info } });
  fixture.context.info = info;
  const row = await fixture.run("buildTreeNode(info, treeVersion)");
  assert.equal(row.children[0].children[1].textContent, name);
  await fixture.run("showFilePreview(info.path)");
  assert.equal(fixture.elements["preview-body"].children[0].children[1].textContent, info.text);
  fixture.run('pinnedFolders = ["C:\\\\root\\\\<img src=x>"]; renderPinnedList()');
  assert.equal(fixture.elements["pinned-list"].children.length, 1);
});

test("media previews use validated backend URLs and preserve controls", async () => {
  for (const [kind, tag] of [["image", "img"], ["audio", "audio"], ["video", "video"]]) {
    const info = { path: "C:\\root\\sample", name: "日本語 #100%", size: 10, mtimeMs: 0, kind, url: "file:///C:/root/%E6%97%A5%23100%25" };
    const fixture = renderer({ api: { preview: async () => info } });
    await fixture.run("showFilePreview('C:/root/sample')");
    const media = fixture.elements["preview-body"].children[0].children.find(child => child.tagName === tag);
    assert.equal(media.src, info.url);
    if (tag === "img") assert.equal(media.alt, info.name); else assert.equal(media.controls, true);
  }
});

test("late preview responses cannot overwrite the latest selection", async () => {
  let finishFirst;
  const fixture = renderer({ api: { preview: value => value === "first" ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve({ path: "second", name: "second", size: 1, mtimeMs: 0, kind: "text", text: "new" }) } });
  const first = fixture.run("showFilePreview('first')");
  await fixture.run("showFilePreview('second')");
  finishFirst({ path: "first", name: "first", kind: "text", text: "old" });
  await first;
  assert.equal(fixture.elements["preview-title"].textContent, "second");
});

test("renderer delegates opening files to the fixed API", async () => {
  const opened = [];
  const fixture = renderer({ api: { openFile: async value => opened.push(value) } });
  await fixture.run("openFile('C:/root/sample.txt')");
  assert.deepEqual(opened, ["C:/root/sample.txt"]);
});

function key(item, value) {
  return item.handlers.keydown({ key: value, target: item, preventDefault() {}, stopPropagation() {} });
}
const rootInfo = { path: "C:/root", name: "root", isDirectory: true, size: 0, mtimeMs: 0 };
const fileInfo = name => ({ path: `C:/root/${name}.txt`, name: `${name}.txt`, isDirectory: false, size: 1, mtimeMs: 0 });

test("keyboard navigation expands, moves, collapses and exposes one tree tab stop", async () => {
  const fixture = renderer({ api: { openRoot: async () => rootInfo, readDirectory: async () => [fileInfo("a"), fileInfo("b")] } });
  await fixture.run("openRootFolder('C:/root')");
  const root = fixture.elements["tree-container"].children[0];
  assert.equal(root.getAttribute("role"), "treeitem");
  assert.equal(root.tabIndex, 0);
  root.focus();
  await key(root, "ArrowRight");
  assert.equal(root.getAttribute("aria-expanded"), "true");
  await key(root, "ArrowDown");
  const first = fixture.context.document.activeElement;
  assert.equal(first.dataset.path, "C:/root/a.txt");
  assert.equal(root.tabIndex, -1);
  await key(first, "End");
  const last = fixture.context.document.activeElement;
  assert.equal(last.dataset.path, "C:/root/b.txt");
  await key(last, "ArrowLeft");
  assert.equal(fixture.context.document.activeElement, root);
  await key(root, "ArrowLeft");
  assert.equal(root.getAttribute("aria-expanded"), "false");
  assert.equal(fixture.run("visibleTreeItems().length"), 1);
});

test("refresh rereads the folder, preserves expansion and restores keyboard focus", async () => {
  let reads = 0;
  const fixture = renderer({ api: {
    openRoot: async () => rootInfo,
    readDirectory: async () => { reads++; return reads === 1 ? [fileInfo("old")] : [fileInfo("new")]; }
  } });
  await fixture.run("openRootFolder('C:/root')");
  const oldRoot = fixture.elements["tree-container"].children[0];
  await key(oldRoot, "ArrowRight");
  oldRoot.focus();
  await fixture.elements["refresh-btn"].handlers.click();
  const newRoot = fixture.elements["tree-container"].children[0];
  assert.notEqual(newRoot, oldRoot);
  assert.equal(newRoot.getAttribute("aria-expanded"), "true");
  assert.equal(fixture.context.document.activeElement, newRoot);
  assert.equal(reads, 2);
  assert.equal(fixture.run("visibleTreeItems()[1].dataset.path"), "C:/root/new.txt");
});

test("Cancel button stops a pending scan and permits a retry without stale rows", async () => {
  let rejectRead;
  let progress;
  let requestId;
  let attempts = 0;
  const fixture = renderer({ api: {
    openRoot: async () => rootInfo,
    onScanProgress: handler => { progress = handler; },
    readDirectory: (_path, _options, id) => {
      requestId = id;
      attempts++;
      return attempts === 1 ? new Promise((_resolve, reject) => { rejectRead = reject; }) : Promise.resolve([fileInfo("retry")]);
    },
    cancelScan: async id => { assert.equal(id, requestId); rejectRead(new Error("Scan cancelled")); }
  } });
  await fixture.run("openRootFolder('C:/root')");
  const root = fixture.elements["tree-container"].children[0];
  const loading = key(root, "ArrowRight");
  await new Promise(resolve => setImmediate(resolve));
  progress({ requestId, scanned: 42, skipped: 0 });
  assert.match(fixture.elements["scan-message"].textContent, /42/);
  fixture.elements["cancel-scan-btn"].handlers.click({ type: "click" });
  await loading;
  assert.equal(fixture.run("activeScans.size"), 0);
  assert.match(fixture.elements["scan-message"].textContent, /cancelled/);
  await key(root, "ArrowLeft");
  await key(root, "ArrowRight");
  assert.equal(fixture.run("visibleTreeItems()[1].dataset.path"), "C:/root/retry.txt");
});

test("missing folder errors offer a retry and favorite opens use native buttons", async () => {
  let attempts = 0;
  const fixture = renderer({ savedPins: JSON.stringify(["C:/root"]), api: {
    openRoot: async () => { if (++attempts === 1) throw new Error("ENOENT"); return rootInfo; }
  } });
  const favorite = fixture.elements["pinned-list"].children[0].children[0];
  assert.equal(favorite.tagName, "button");
  await favorite.handlers.click();
  const error = fixture.elements["tree-container"].children[0];
  assert.match(error.children[0].textContent, /no longer exists/);
  await error.children[1].handlers.click();
  assert.equal(fixture.elements["tree-container"].children[0].getAttribute("role"), "treeitem");
});
