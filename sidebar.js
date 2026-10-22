(() => {
  const { ipcRenderer } = require("electron");

  ipcRenderer.on("theme-updated", (_, theme) => {
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  });

  ipcRenderer.on("explorer-path-update", (_, folderPath) => {
    if (typeof window.openRootFolder === "function") {
      window.openRootFolder(folderPath);
    } else {
      console.error("openRootFolder not found");
    }
  });
})();

