(() => {
  const { ipcRenderer } = require("electron");

  console.log("sidebar.js loaded");

  ipcRenderer.on("explorer-path-update", (_, folderPath) => {
    console.log("Sidebar received:", folderPath);
    console.log(typeof window.openRootFolder);

    if (typeof window.openRootFolder === "function") {
      window.openRootFolder(folderPath);
    } else {
      console.error("openRootFolder not found");
    }
  });
})();

