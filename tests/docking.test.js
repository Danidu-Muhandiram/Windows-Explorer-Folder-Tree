const test = require("node:test");
const assert = require("node:assert/strict");
const { sidebarBounds } = require("../docking");

// Simulate Electron's native conversion at distinct physical/DIP monitor origins.
function displayScreen({ physicalX = 0, dipX = 0, scale = 1, width = 1920, height = 1080, y = 0 } = {}) {
  return {
    screenToDipRect(window, rect) {
      assert.equal(window, null);
      return { x: dipX + (rect.x - physicalX) / scale, y: y + (rect.y - y * scale) / scale, width: rect.width / scale, height: rect.height / scale };
    },
    getDisplayMatching() { return { workArea: { x: dipX, y, width, height } }; }
  };
}

test("sidebar stays 320 DIP wide at 100%, 125%, 150% and 200% scaling", () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const screen = displayScreen({ scale });
    assert.deepEqual(sidebarBounds(screen, { x: 100 * scale, y: 50 * scale, width: 1000 * scale, height: 700 * scale }), { x: 1100, y: 50, width: 320, height: 700 });
  }
});

test("secondary monitors use their own origins, including monitors left of the primary", () => {
  const left = displayScreen({ physicalX: -2560, dipX: -1707, scale: 1.5, width: 1707 });
  assert.deepEqual(sidebarBounds(left, { x: -2410, y: 150, width: 1500, height: 900 }), { x: -607, y: 100, width: 320, height: 600 });
  const right = displayScreen({ physicalX: 1920, dipX: 1920, scale: 2, width: 1920 });
  assert.equal(sidebarBounds(right, { x: 2120, y: 200, width: 1800, height: 1200 }).x, 2920);
});

test("off-screen or oversized bounds are kept within the selected display work area", () => {
  const screen = displayScreen({ width: 1280, height: 720 });
  assert.deepEqual(sidebarBounds(screen, { x: 1100, y: -100, width: 900, height: 2000 }), { x: 960, y: 0, width: 320, height: 720 });
  assert.throws(() => sidebarBounds(screen, { x: NaN, y: 0, width: 1, height: 1 }), /Invalid/);
});
