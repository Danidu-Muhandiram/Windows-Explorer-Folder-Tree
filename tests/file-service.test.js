const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { createFileSession, validatePath } = require("../file-service");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "folder-tree-test-"));
  t.after(async () => {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("folder-tree-test-")) throw new Error("Unsafe cleanup path");
    await fs.rm(target, { recursive: true, force: true });
  });
  const root = path.join(directory, "root");
  await fs.mkdir(root);
  const session = createFileSession();
  await session.openRoot(root);
  return { directory, root, session };
}
const options = overrides => ({ filter: "all", sort: "name-asc", showSize: false, ...overrides });

test("filesystem API rejects malformed paths, options and paths outside the active root", async t => {
  const { directory, root, session } = await fixture(t);
  for (const value of [null, {}, "relative", "C:\\bad\0path", "\\\\.\\pipe\\bad", "\\\\?\\C:\\file"]) assert.throws(() => validatePath(value));
  await assert.rejects(session.readDirectory(root, options({ filter: "invalid" })), /options/);
  await assert.rejects(session.readDirectory(directory, options()), /outside/);
  await assert.rejects(session.preview(path.join(directory, "..", "outside.txt")));
  await assert.rejects(createFileSession().preview(__filename), /Select a folder/);
});

test("directory size sorting works when sizes are hidden", async t => {
  const { root, session } = await fixture(t);
  for (const [name, bytes] of [["large", 100], ["small", 3]]) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, "data.bin"), Buffer.alloc(bytes));
  }
  assert.deepEqual((await session.readDirectory(root, options({ sort: "size-asc" }))).map(item => item.name), ["small", "large"]);
  assert.deepEqual((await session.readDirectory(root, options({ sort: "size-desc" }))).map(item => item.name), ["large", "small"]);
});

test("recursive filtering continues after an unreadable entry", async t => {
  const { root, session } = await fixture(t);
  const nested = path.join(root, "nested");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "a-blocked"), "blocked");
  await fs.writeFile(path.join(nested, "z-match.png"), "image");
  const original = fs.stat;
  t.mock.method(fs, "stat", async value => {
    if (path.basename(value) === "a-blocked") throw new Error("Access denied");
    return original(value);
  });
  assert.deepEqual((await session.readDirectory(root, options({ filter: "png" }))).map(item => item.name), ["nested"]);
  assert.equal((await session.readDirectory(root, options({ sort: "size-asc" })))[0].size, 5);
});

test("previews encode media URLs and limit text reads to 50KB", async t => {
  const { root, session } = await fixture(t);
  for (const extension of ["png", "mp3", "mp4"]) {
    const value = path.join(root, `日本語 #100% & '.${extension}`);
    await fs.writeFile(value, "sample");
    const info = await session.preview(value);
    assert.equal(info.url, pathToFileURL(await fs.realpath(value)).href);
    assert.equal(new URL(info.url).hash, "");
  }
  const text = path.join(root, "test.html");
  await fs.writeFile(text, "<script>bad()</script>" + "x".repeat(60000));
  const preview = await session.preview(text);
  assert.equal(preview.kind, "text");
  assert.equal(Buffer.byteLength(preview.text), 50000);
  assert.equal(preview.truncated, true);
  assert.equal(preview.url, undefined);
  await assert.rejects(session.fileToOpen(root), /regular file/);
});

test("junctions cannot escape the active root and recursive cycles terminate", async t => {
  const { directory, root, session } = await fixture(t);
  await fs.mkdir(path.join(directory, "outside"));
  await fs.writeFile(path.join(directory, "outside", "secret.txt"), "private");
  await fs.symlink(path.join(directory, "outside"), path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(root, path.join(root, "cycle"), process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(path.join(root, "safe.png"), "123");
  await assert.rejects(session.preview(path.join(root, "escape", "secret.txt")), /outside/);
  const result = await session.readDirectory(root, options({ filter: "png", showSize: true }));
  assert.ok(!result.some(item => item.name === "escape"));
  assert.ok(!result.some(item => item.name === "cycle"));
});
