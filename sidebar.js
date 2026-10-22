(() => {
  const api = window.folderTree;

  api.onTheme(theme => {
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  });

  api.onExplorerPath(folderPath => {
    if (typeof window.openRootFolder === "function") {
      window.openRootFolder(folderPath);
    } else {
      console.error("openRootFolder not found");
    }
  });
})();

