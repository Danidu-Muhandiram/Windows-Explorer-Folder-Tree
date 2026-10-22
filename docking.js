// Win32 reports physical pixels; Electron windows use device-independent pixels.
function sidebarBounds(screen, explorer, width = 320) {
  if (![explorer.x, explorer.y, explorer.width, explorer.height].every(Number.isFinite) ||
      explorer.width <= 0 || explorer.height <= 0) throw new Error("Invalid Explorer bounds");
  const rect = screen.screenToDipRect(null, {
    x: explorer.x, y: explorer.y, width: explorer.width, height: explorer.height
  });
  const area = screen.getDisplayMatching(rect).workArea;
  const sidebarWidth = Math.min(width, area.width);
  const height = Math.min(rect.height, area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(rect.x + rect.width, area.x + area.width - sidebarWidth))),
    y: Math.round(Math.max(area.y, Math.min(rect.y, area.y + area.height - height))),
    width: Math.round(sidebarWidth), height: Math.max(1, Math.round(height))
  };
}
module.exports = { sidebarBounds };
