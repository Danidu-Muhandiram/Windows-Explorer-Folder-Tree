const { Worker } = require("node:worker_threads");
const path = require("node:path");

function createWorkerSession(onProgress = () => {}) {
  const workerPath = path.join(__dirname, "file-worker.js").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  const worker = new Worker(workerPath);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  function cancel(requestId) {
    for (const [id, request] of pending) {
      if (!request.scan || (requestId !== null && request.requestId !== requestId)) continue;
      worker.postMessage({ id, cancel: true });
      const error = new Error("Scan cancelled");
      error.code = "ABORT_ERR";
      request.reject(error);
      pending.delete(id);
      if (!pending.size) worker.unref();
    }
  }
  function fail(error) {
    closed = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  worker.on("message", ({ id, result, error, progress }) => {
    const request = pending.get(id);
    if (!request) return;
    if (progress) { onProgress({ ...progress, requestId: request.requestId }); return; }
    pending.delete(id);
    if (!pending.size) worker.unref();
    if (error) request.reject(Object.assign(new Error(error.message), { code: error.code }));
    else request.resolve(result);
  });
  worker.on("error", fail);
  worker.on("exit", code => fail(new Error(`File worker stopped (${code}). Reopen the application to retry.`)));
  worker.unref();
  function call(method, args, requestId = null) {
    if (closed) return Promise.reject(new Error("File worker is unavailable. Reopen the application to retry."));
    if (requestId !== null && (!Number.isSafeInteger(requestId) || requestId < 1)) return Promise.reject(new Error("Invalid scan identifier"));
    if (method === "openRoot") cancel(null);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      worker.ref();
      pending.set(id, { resolve, reject, requestId, scan: method === "openRoot" || method === "readDirectory" });
      worker.postMessage({ id, method, args });
    });
  }
  return {
    openRoot: (value, showSize = false, requestId = null) => call("openRoot", [value, showSize], requestId),
    readDirectory: (value, options, requestId = null) => call("readDirectory", [value, options], requestId),
    preview: value => call("preview", [value]),
    fileToOpen: value => call("fileToOpen", [value]),
    cancel(requestId = null) {
      if (requestId !== null && (!Number.isSafeInteger(requestId) || requestId < 1)) throw new Error("Invalid scan identifier");
      cancel(requestId);
    },
    dispose() {
      fail(new Error("Window closed"));
      return worker.terminate();
    }
  };
}
module.exports = { createWorkerSession };
