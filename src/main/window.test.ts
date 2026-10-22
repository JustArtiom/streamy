import { describe, expect, it, vi } from "vitest";
import { UI_SCALES } from "../shared/settings";
import { titleBarOverlay, trafficLightPosition } from "./window";

vi.mock(
  "electron",
  async () => (await import("./test/fake-electron")).electron,
);

// The UI's title bar is 44 CSS px, so 44 × zoom window pixels: the native
// window buttons must follow it at every interface size.
describe("window buttons at each interface size", () => {
  it("Windows/Linux: as tall as the title bar, minus its 1px border", () => {
    expect(UI_SCALES.map((zoom) => titleBarOverlay(zoom).height)).toEqual(
      UI_SCALES.map((zoom) => Math.round(44 * zoom) - 1),
    );
    expect(titleBarOverlay(1).height).toBe(43);
    expect(titleBarOverlay(1.25).height).toBe(54);
  });

  it("macOS: the traffic lights (16 px) stay centered in the bar", () => {
    expect(trafficLightPosition(1)).toEqual({ x: 16, y: 14 });
    expect(trafficLightPosition(1.25)).toEqual({ x: 16, y: 20 });
    expect(trafficLightPosition(0.9)).toEqual({ x: 16, y: 12 });
  });
});
