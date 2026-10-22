const { parentPort } = require("node:worker_threads");
const { createFileSession } = require("./file-service");
const session = createFileSession();
const requests = new Map();
const methods = new Set(["openRoot", "readDirectory", "preview", "fileToOpen"]);

parentPort.on("message", async message => {
  if (message.cancel) { requests.get(message.id)?.abort(); return; }
  const { id, method, args } = message;
  if (!methods.has(method)) return;
  const controller = new AbortController();
  requests.set(id, controller);
  try {
    const scan = method === "openRoot" || method === "readDirectory";
    const control = { signal: controller.signal, onProgress: progress => parentPort.postMessage({ id, progress }) };
    const result = await session[method](...args, ...(scan ? [control] : []));
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  } finally { requests.delete(id); }
});
