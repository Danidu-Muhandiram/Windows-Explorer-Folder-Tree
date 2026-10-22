const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TYPES = {
  images: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
  png: [".png"], jpg: [".jpg", ".jpeg"], pdf: [".pdf"],
  word: [".doc", ".docx"], excel: [".xls", ".xlsx", ".csv"], ppt: [".ppt", ".pptx"]
};
const TEXT = new Set([".js", ".ts", ".json", ".html", ".css", ".md", ".py", ".cpp", ".h", ".txt", ".ini", ".cfg", ".xml", ".yaml", ".yml", ".bat", ".sh"]);
const AUDIO = new Set([".mp3", ".wav", ".ogg"]);
const VIDEO = new Set([".mp4", ".webm", ".mkv"]);
const SORTS = new Set(["name-asc", "name-desc", "size-asc", "size-desc", "date-asc", "date-desc"]);

function validatePath(value) {
  if (typeof value !== "string" || !value || value.length > 32767 || value.includes("\0") ||
      !path.isAbsolute(value) || /^\\\\[?.]\\/.test(value) ||
      (process.platform === "win32" && value.slice(2).includes(":"))) {
    throw new Error("Invalid filesystem path");
  }
  return path.resolve(value);
}

function matches(name, filter) {
  return filter === "all" || TYPES[filter].includes(path.extname(name).toLowerCase());
}

// One session per window. Canonical paths prevent junctions escaping the active root.
function createFileSession() {
  let root = null;
  let version = 0;
  const sizeCache = new Map();
  const matchCache = new Map();
  async function checked(value) {
    const currentRoot = root;
    if (!currentRoot) throw new Error("Select a folder first");
    const resolved = await fs.realpath(validatePath(value));
    const relative = path.relative(currentRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Path is outside the active folder");
    }
    if (currentRoot !== root) throw new Error("Folder changed; try again");
    return resolved;
  }
  function entry(value, stat) {
    return { path: value, name: path.basename(value) || value,
      extension: path.extname(value).toLowerCase(), isDirectory: stat.isDirectory(),
      size: stat.size, mtimeMs: stat.mtimeMs };
  }
  async function walk(value, filter, visited, sizes) {
    try {
      const resolved = await checked(value);
      if (visited.has(resolved)) return sizes ? 0 : false;
      visited.add(resolved);
      let total = 0;
      for (const name of await fs.readdir(resolved)) {
        try {
          const child = await checked(path.join(resolved, name));
          const stat = await fs.stat(child);
          if (!stat.isDirectory() && !stat.isFile()) continue;
          if (sizes) total += stat.isDirectory() ? await walk(child, filter, visited, true) : stat.size;
          else if (stat.isDirectory() ? await walk(child, filter, visited, false) : matches(name, filter)) return true;
        } catch { /* Skip inaccessible or out-of-root entries. */ }
      }
      return sizes ? total : false;
    } catch { return sizes ? 0 : false; }
  }
  return {
    async openRoot(value, showSize = false) {
      if (typeof showSize !== "boolean") throw new Error("Invalid size option");
      const request = ++version;
      const resolved = await fs.realpath(validatePath(value));
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) throw new Error("Please select a folder");
      if (request !== version) throw new Error("Folder changed; try again");
      root = resolved;
      sizeCache.clear();
      matchCache.clear();
      const result = entry(resolved, stat);
      if (showSize) result.size = await walk(resolved, "all", new Set(), true);
      return result;
    },
    async readDirectory(value, options) {
      if (!options || !["all", ...Object.keys(TYPES)].includes(options.filter) ||
          !SORTS.has(options.sort) || typeof options.showSize !== "boolean") throw new Error("Invalid directory options");
      const resolved = await checked(value);
      const items = [];
      const needSize = options.showSize || options.sort.startsWith("size-");
      for (const name of await fs.readdir(resolved)) {
        try {
          const child = await checked(path.join(resolved, name));
          const stat = await fs.stat(child);
          if (!stat.isDirectory() && !stat.isFile()) continue;
          if (stat.isDirectory()) {
            // Directory aliases can create recursive UI expansion even when scans
            // have a visited set. Skip junctions/symlink directories in the tree.
            if ((await fs.lstat(path.join(resolved, name))).isSymbolicLink()) continue;
            if (options.filter !== "all") {
              const key = JSON.stringify([child, options.filter]);
              if (!matchCache.has(key)) matchCache.set(key, await walk(child, options.filter, new Set(), false));
              if (!matchCache.get(key)) continue;
            }
          } else if (!matches(name, options.filter)) continue;
          const item = entry(path.join(resolved, name), stat);
          if (item.isDirectory && needSize) {
            if (!sizeCache.has(child)) sizeCache.set(child, await walk(child, "all", new Set(), true));
            item.size = sizeCache.get(child);
          }
          items.push(item);
        } catch { /* A bad entry must not hide its siblings. */ }
      }
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        const direction = options.sort.endsWith("asc") ? 1 : -1;
        const result = options.sort.startsWith("size-") ? a.size - b.size :
          options.sort.startsWith("date-") ? a.mtimeMs - b.mtimeMs :
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        return direction * result;
      });
      return items;
    },
    async preview(value) {
      const resolved = await checked(value);
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) throw new Error("Not a regular file");
      const info = entry(resolved, stat);
      const ext = info.extension;
      const kind = TYPES.images.includes(ext) ? "image" : AUDIO.has(ext) ? "audio" : VIDEO.has(ext) ? "video" : TEXT.has(ext) ? "text" : "document";
      if (kind === "text") {
        const handle = await fs.open(resolved, "r");
        try {
          const buffer = Buffer.alloc(50000);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return { ...info, kind, text: buffer.toString("utf8", 0, bytesRead), truncated: stat.size > buffer.length };
        } finally { await handle.close(); }
      }
      return { ...info, kind, url: kind === "document" ? null : pathToFileURL(resolved).href };
    },
    async fileToOpen(value) {
      const resolved = await checked(value);
      if (!(await fs.stat(resolved)).isFile()) throw new Error("Not a regular file");
      return resolved;
    }
  };
}

module.exports = { createFileSession, validatePath };
