const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element(tagName = "div") {
  const classes = new Set();
  const result = {
    tagName, children: [], handlers: {}, style: {},
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle(value, force) { if (force) classes.add(value); else classes.delete(value); } },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute() {}, append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  };
  Object.defineProperty(result, "innerHTML", { set() { throw new Error("Unsafe HTML insertion"); } });
  return result;
}

function renderer({ savedPins = null, api = {} } = {}) {
  const elements = Object.fromEntries(["tree-container", "path", "preview-body", "preview-meta", "preview-title", "open-file-btn", "pinned-list", "pin-btn"].map(id => [id, element()]));
  const context = {
    document: { getElementById: id => elements[id] || null, createElement: element, body: element("body"), querySelectorAll: () => [] },
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
