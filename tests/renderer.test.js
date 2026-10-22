const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

function element(tagName = "div") {
  return {
    tagName, children: [], classList: { contains: () => false },
    addEventListener() {}, setAttribute() {},
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; }
  };
}

function renderer({ elements = {}, filesystem = {}, savedPins = null, openPath = async () => "" } = {}) {
  const messages = [];
  const context = {
    require(name) {
      if (name === "electron") return {
        ipcRenderer: { send: (...args) => messages.push(args) }, shell: { openPath }
      };
      if (name === "fs") return filesystem;
      return require(name);
    },
    document: {
      getElementById: id => elements[id] || null, createElement: element,
      body: element("body"), readyState: "loading", addEventListener() {}
    },
    localStorage: { getItem: key => key === "pinnedFolders" ? savedPins : null },
    window: {}, console, Buffer
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer.js"), "utf8"), context);
  return { context, messages, run: source => vm.runInContext(source, context) };
}

test("size sorting calculates directory sizes with size display disabled or absent", () => {
  const root = path.resolve("example");
  const entries = new Map([
    [root, ["large", "small"]],
    [path.join(root, "large"), ["data.bin"]],
    [path.join(root, "small"), ["data.bin"]]
  ]);
  for (const sizeToggle of [undefined, { ...element(), checked: false }]) {
    for (const order of ["size-asc", "size-desc"]) {
      const fixture = renderer({
        elements: { "sort-select": { ...element(), value: order }, "toggle-size": sizeToggle },
        filesystem: {
          readdirSync: location => entries.get(location),
          statSync: location => ({
            isDirectory: () => entries.has(location),
            size: location.includes(`${path.sep}large${path.sep}`) ? 100 : 5,
            mtimeMs: 0
          })
        }
      });
      // Isolate row construction while exercising real loading, sizing and sorting.
      fixture.run("buildTreeNode = location => ({ location })");
      const container = element();
      fixture.context.container = container;
      fixture.context.root = root;
      fixture.run("loadChildren(root, container)");
      assert.deepEqual(container.children.map(child => path.basename(child.location)),
        order === "size-asc" ? ["small", "large"] : ["large", "small"]);
    }
  }
});

test("recursive filters skip unreadable entries and continue to later nested matches", () => {
  const root = path.resolve("example");
  const nested = path.join(root, "nested");
  const fixture = renderer({ filesystem: {
    readdirSync: location => location === root ? ["blocked", "nested"] : ["blocked", "match.png"],
    statSync: location => {
      if (path.basename(location) === "blocked") throw new Error("Access denied");
      return { isDirectory: () => location === nested, size: 20 };
    }
  } });
  fixture.context.root = root;
  assert.equal(fixture.run("dirHasMatch(root, 'png')"), true);
  assert.equal(fixture.run("getFolderSize(root)"), 20);
});

test("unreadable directories return no matches without throwing", () => {
  const fixture = renderer({ filesystem: { readdirSync() { throw new Error("Access denied"); } } });
  assert.equal(fixture.run("dirHasMatch('blocked', 'png')"), false);
});

test("favorites accept only arrays of valid absolute paths and remove duplicates", () => {
  const valid = path.resolve("favorites");
  const cases = [
    ["{}", []], ["null", []], ['"hello"', []], ["1", []], ["{invalid", []],
    [JSON.stringify([null, {}, 42, "", " ", "relative", "bad\0path", valid, valid]), [valid]]
  ];
  for (const [savedPins, expected] of cases) {
    const fixture = renderer({ savedPins });
    fixture.run("initSettings()");
    assert.deepEqual(Array.from(fixture.run("pinnedFolders")), expected);
  }
});

test("image, audio and video previews preserve special characters and Unicode in URLs", () => {
  for (const [extension, tag] of [["png", "img"], ["mp3", "audio"], ["mp4", "video"]]) {
    const body = element();
    const filePath = path.resolve(`日本語 #1 100% & 'sample'.${extension}`);
    const fixture = renderer({
      elements: { "preview-body": body },
      filesystem: { statSync: () => ({ size: 100, mtime: new Date() }) }
    });
    fixture.context.filePath = filePath;
    fixture.run("showFilePreview(filePath)");
    const media = body.children[0].children.find(child => child.tagName === tag);
    assert.equal(media.src, pathToFileURL(filePath).href);
    assert.equal(new URL(media.src).hash, "");
    if (tag === "img") assert.equal(media.alt, path.basename(filePath));
    else assert.equal(media.controls, true);
  }
});

test("file opening reports resolved errors and rejected requests, but stays quiet on success", async () => {
  for (const [openPath, expectedMessages] of [
    [async () => "", 0],
    [async () => "File not found", 1],
    [async () => { throw new Error("Access denied"); }, 1]
  ]) {
    const fixture = renderer({ openPath });
    await fixture.run("openFile('C:/missing.txt')");
    assert.equal(fixture.messages.length, expectedMessages);
    if (expectedMessages) {
      assert.equal(fixture.messages[0][0], "file-open-failed");
      assert.equal(fixture.messages[0][1], "C:/missing.txt");
      assert.ok(fixture.messages[0][2].length > 0);
    }
  }
});
