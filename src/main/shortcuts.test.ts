import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActions } from "./menu";
import { handleShortcuts } from "./shortcuts";
import {
  createFakeWebContents,
  electron,
  resetFakeElectron,
} from "./test/fake-electron";

vi.mock(
  "electron",
  async () => (await import("./test/fake-electron")).electron,
);

const realPlatform = process.platform;

function pretendPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  resetFakeElectron();
});

function setup() {
  const contents = createFakeWebContents();
  let fullScreen = false;
  const window = {
    isFullScreen: () => fullScreen,
    setFullScreen: vi.fn((value: boolean) => {
      fullScreen = value;
    }),
  };
  electron.BrowserWindow.fromWebContents.mockImplementation((sender) =>
    sender === contents ? window : null,
  );
  const actions: AppActions = {
    openSettings: vi.fn(),
    openTorrentFile: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
  };
  handleShortcuts(contents as never, actions);
  /** Presses a key; returns whether the page was kept from seeing it. */
  const press = (input: Record<string, unknown>) => {
    const event = { preventDefault: vi.fn() };
    contents.emit("before-input-event", event, {
      type: "keyDown",
      control: false,
      alt: false,
      meta: false,
      shift: false,
      isAutoRepeat: false,
      ...input,
    });
    return event.preventDefault.mock.calls.length > 0;
  };
  return { window, actions, press };
}

describe("Windows/Linux shortcuts", () => {
  beforeEach(() => {
    pretendPlatform("win32");
  });

  it("F11 enters and leaves full screen", () => {
    const { window, press } = setup();

    expect(press({ key: "F11" })).toBe(true);
    expect(press({ key: "F11", isAutoRepeat: true })).toBe(true);
    expect(press({ key: "F11" })).toBe(true);

    expect(window.setFullScreen.mock.calls).toEqual([[true], [false]]);
  });

  it("leaves F11 with a modifier, and other keys, to the page", () => {
    const { window, press } = setup();

    expect(press({ key: "F11", shift: true })).toBe(false);
    expect(press({ key: "f" })).toBe(false);
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });

  it("Ctrl+, opens Settings and Ctrl+= zooms in", () => {
    const { actions, press } = setup();

    expect(press({ key: ",", control: true })).toBe(true);
    expect(press({ key: "=", control: true })).toBe(true);

    expect(actions.openSettings).toHaveBeenCalledOnce();
    expect(actions.zoomIn).toHaveBeenCalledOnce();
  });
});

describe("macOS", () => {
  it("leaves every key to the menu bar (full screen is ⌃⌘F there)", () => {
    pretendPlatform("darwin");
    const { window, press } = setup();

    expect(press({ key: "F11" })).toBe(false);
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });
});
