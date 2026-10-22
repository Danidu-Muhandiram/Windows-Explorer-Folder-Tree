const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createWorkerSession } = require("../worker-client");

async function fixture(t, onProgress) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "folder-tree-worker-test-"));
  const session = createWorkerSession(onProgress);
  t.after(async () => {
    await session.dispose();
    const target = path.resolve(root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("folder-tree-worker-test-")) throw new Error("Unsafe cleanup path");
    await fs.rm(target, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "nested"));
  await Promise.all(Array.from({ length: 150 }, (_, index) => fs.writeFile(path.join(root, "nested", `${index}.txt`), "hello")));
  await session.openRoot(root, false, 1);
  return { root, session };
}

test("real worker reports scan progress while the caller's event loop remains responsive", async t => {
  const progress = [];
  const { session, root } = await fixture(t, value => progress.push(value));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const rows = await session.readDirectory(root, { filter: "all", sort: "size-asc", showSize: false }, 2);
    assert.equal(rows[0].size, 750);
    assert.ok(ticks > 0);
    assert.ok(progress.some(value => value.requestId === 2 && value.scanned >= 150 && value.done));
  } finally { clearInterval(timer); }
});

test("cancelling a running recursive scan rejects promptly and allows a fresh scan", async t => {
  let sessionToCancel;
  let cancelled = false;
  const { session, root } = await fixture(t, value => {
    if (value.requestId === 2 && value.scanned > 0 && !cancelled) {
      cancelled = true;
      sessionToCancel.cancel(2);
    }
  });
  sessionToCancel = session;
  await assert.rejects(session.readDirectory(root, { filter: "all", sort: "size-asc", showSize: true }, 2), /Scan cancelled/);
  assert.equal(cancelled, true);
  const reopened = await session.openRoot(root, false, 3);
  assert.equal(reopened.isDirectory, true);
  const rows = await session.readDirectory(root, { filter: "all", sort: "size-asc", showSize: true }, 4);
  assert.equal(rows[0].size, 750);
});

test("switching roots cancels old scans and keeps each worker session isolated", async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const obsolete = first.session.readDirectory(first.root, { filter: "all", sort: "size-asc", showSize: true }, 2);
  const rejected = assert.rejects(obsolete, /Scan cancelled/);
  await first.session.openRoot(path.join(first.root, "nested"), false, 3);
  await rejected;
  await assert.rejects(first.session.preview(path.join(second.root, "nested", "0.txt")), /outside/);
  assert.equal((await second.session.preview(path.join(second.root, "nested", "0.txt"))).text, "hello");
});
