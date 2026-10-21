import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WINDOW_SIZE,
  fitToScreens,
  loadWindowState,
  MIN_WINDOW_SIZE,
  saveWindowState,
} from "./window-state";

// A laptop screen (below the macOS menu bar) and a monitor to its right.
const LAPTOP = { x: 0, y: 25, width: 1440, height: 875 };
const MONITOR = { x: 1440, y: 0, width: 1920, height: 1080 };
const SCREENS = [LAPTOP, MONITOR];

describe("fitToScreens", () => {
  it("keeps a window that's on a screen", () => {
    const state = { x: 100, y: 80, width: 1200, height: 780, maximized: false };

    expect(fitToScreens(state, SCREENS)).toEqual(state);
  });

  it("keeps a window on the second screen", () => {
    const state = {
      x: 2000,
      y: 100,
      width: 1200,
      height: 780,
      maximized: true,
    };

    expect(fitToScreens(state, SCREENS)).toEqual(state);
  });

  it("lets the OS place a window whose screen was unplugged", () => {
    const state = {
      x: 4000,
      y: 100,
      width: 1200,
      height: 780,
      maximized: false,
    };

    expect(fitToScreens(state, SCREENS)).toEqual({
      width: 1200,
      height: 780,
      maximized: false,
    });
  });

  it("lets the OS place a window whose title bar is off screen", () => {
    const state = {
      x: 100,
      y: -40,
      width: 1200,
      height: 780,
      maximized: false,
    };

    expect(fitToScreens(state, SCREENS)).not.toHaveProperty("x");
  });

  it("shrinks a window that's bigger than its screen", () => {
    const state = { x: 0, y: 25, width: 3000, height: 2000, maximized: false };

    expect(fitToScreens(state, SCREENS)).toMatchObject({
      width: LAPTOP.width,
      height: LAPTOP.height,
    });
  });

  it("never goes below the minimum size", () => {
    const state = { x: 100, y: 80, width: 10, height: 10, maximized: false };

    expect(fitToScreens(state, SCREENS)).toMatchObject(MIN_WINDOW_SIZE);
  });
});

describe("loadWindowState / saveWindowState", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "streamy-window-"));
    file = join(dir, "window-state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the default size the first time", () => {
    expect(loadWindowState(file, SCREENS)).toEqual({
      ...DEFAULT_WINDOW_SIZE,
      maximized: false,
    });
  });

  it("restores what was saved", () => {
    const state = { x: 200, y: 120, width: 1000, height: 700, maximized: true };
    saveWindowState(file, state);

    expect(loadWindowState(file, SCREENS)).toEqual(state);
  });

  it("ignores a file it can't make sense of", () => {
    writeFileSync(file, '{ "width": "wide" }');

    expect(loadWindowState(file, SCREENS)).toEqual({
      ...DEFAULT_WINDOW_SIZE,
      maximized: false,
    });
  });

  it("doesn't throw when it can't save (closing the window must still work)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(join(dir, "blocker"), "");

    expect(() => {
      saveWindowState(join(dir, "blocker", "state.json"), {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        maximized: false,
      });
    }).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
