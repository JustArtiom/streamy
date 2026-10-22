import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcChannel } from "../shared/api";
import { setupPlayerPower } from "./player-power";
import {
  createFakeWebContents,
  electron,
  invokeAs,
  invokeFrom,
  resetFakeElectron,
} from "./test/fake-electron";

vi.mock(
  "electron",
  async () => (await import("./test/fake-electron")).electron,
);

const { powerSaveBlocker } = electron;

beforeEach(() => {
  setupPlayerPower();
});

afterEach(() => {
  resetFakeElectron();
});

function setPlaying(
  sender: ReturnType<typeof createFakeWebContents>,
  playing: unknown,
) {
  return invokeAs({ sender }, IpcChannel.SetPlaying, playing);
}

const isBlocking = () =>
  powerSaveBlocker.start.mock.calls.length >
  powerSaveBlocker.stop.mock.calls.length;

describe("keeping the screen awake while a video plays", () => {
  it("blocks display sleep while playing, and releases it on pause", () => {
    const window = createFakeWebContents();

    setPlaying(window, true);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith(
      "prevent-display-sleep",
    );
    expect(isBlocking()).toBe(true);

    setPlaying(window, true); // still one blocker
    expect(powerSaveBlocker.start).toHaveBeenCalledOnce();

    setPlaying(window, false);
    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(
      powerSaveBlocker.start.mock.results[0]?.value,
    );
    expect(isBlocking()).toBe(false);
  });

  it("stays awake while any window plays", () => {
    const first = createFakeWebContents();
    const second = createFakeWebContents();

    setPlaying(first, true);
    setPlaying(second, true);
    setPlaying(first, false);
    expect(isBlocking()).toBe(true);

    setPlaying(second, false);
    expect(isBlocking()).toBe(false);
  });

  it.each([
    ["is closed", "destroyed", []],
    ["crashes", "render-process-gone", [{}, { reason: "crashed" }]],
    [
      "reloads",
      "did-start-navigation",
      [{ isMainFrame: true, isSameDocument: false }],
    ],
  ])("releases it when the window %s", (_what, event, args) => {
    const window = createFakeWebContents();
    setPlaying(window, true);

    window.emit(event, ...args);

    expect(isBlocking()).toBe(false);
  });

  it("keeps it across the UI's own route changes", () => {
    const window = createFakeWebContents();
    setPlaying(window, true);

    window.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true,
    });

    expect(isBlocking()).toBe(true);
  });

  it("accepts only true or false, and only from our UI", () => {
    const window = createFakeWebContents();

    expect(() => setPlaying(window, "yes")).toThrow();
    expect(() =>
      invokeFrom("https://evil.example/", IpcChannel.SetPlaying, true),
    ).toThrow("untrusted");
    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
  });
});
