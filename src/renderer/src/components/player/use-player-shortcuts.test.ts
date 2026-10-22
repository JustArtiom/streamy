import { describe, expect, it, vi } from "vitest";
import {
  handleShortcut,
  type ShortcutActions,
} from "@/components/player/use-player-shortcuts";
import { stepSpeed } from "@/components/player/speed";

function actions(): ShortcutActions {
  return {
    togglePlay: vi.fn(),
    seekBy: vi.fn(),
    volumeBy: vi.fn(),
    toggleMute: vi.fn(),
    toggleFullscreen: vi.fn(),
    toggleSubtitles: vi.fn(),
    seekToFraction: vi.fn(),
    speedBy: vi.fn(),
    escape: vi.fn(),
  };
}

function press(key: string, extra: Partial<KeyboardEvent> = {}) {
  const handlers = actions();
  const handled = handleShortcut(
    {
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: document.body,
      defaultPrevented: false,
      repeat: false,
      ...extra,
    },
    handlers,
  );
  return { handled, handlers };
}

describe("player shortcuts", () => {
  it("maps keys to actions", () => {
    expect(press(" ").handlers.togglePlay).toHaveBeenCalled();
    expect(press("K").handlers.togglePlay).toHaveBeenCalled();
    expect(press("ArrowLeft").handlers.seekBy).toHaveBeenCalledWith(-5);
    expect(press("ArrowRight").handlers.seekBy).toHaveBeenCalledWith(5);
    expect(press("j").handlers.seekBy).toHaveBeenCalledWith(-10);
    expect(press("l").handlers.seekBy).toHaveBeenCalledWith(10);
    expect(press("ArrowUp").handlers.volumeBy).toHaveBeenCalledWith(0.05);
    expect(press("ArrowDown").handlers.volumeBy).toHaveBeenCalledWith(-0.05);
    expect(press("m").handlers.toggleMute).toHaveBeenCalled();
    expect(press("f").handlers.toggleFullscreen).toHaveBeenCalled();
    expect(press("c").handlers.toggleSubtitles).toHaveBeenCalled();
    expect(press("<").handlers.speedBy).toHaveBeenCalledWith(-1);
    expect(press(">").handlers.speedBy).toHaveBeenCalledWith(1);
    expect(press("Escape").handlers.escape).toHaveBeenCalled();
  });

  it("jumps to 0–90 % with the number keys", () => {
    expect(press("0").handlers.seekToFraction).toHaveBeenCalledWith(0);
    expect(press("7").handlers.seekToFraction).toHaveBeenCalledWith(0.7);
  });

  it("ignores keys while typing", () => {
    const input = document.createElement("input");
    expect(press(" ", { target: input }).handled).toBeNull();
    const textarea = document.createElement("textarea");
    expect(press("k", { target: textarea }).handled).toBeNull();
    const select = document.createElement("select");
    expect(press("ArrowDown", { target: select }).handled).toBeNull();
  });

  it("leaves ⌘, Ctrl and Alt to the menu and to Back", () => {
    expect(press("f", { metaKey: true }).handled).toBeNull();
    expect(press("l", { ctrlKey: true }).handled).toBeNull();
    // ⌘[ and Alt+← go back; ⌘, opens Settings; ⌘+ zooms.
    expect(press("[", { metaKey: true }).handled).toBeNull();
    expect(press("ArrowLeft", { altKey: true }).handled).toBeNull();
    expect(press(",", { metaKey: true }).handled).toBeNull();
    expect(press("=", { metaKey: true }).handled).toBeNull();
    expect(press("ArrowRight", { ctrlKey: true }).handled).toBeNull();
  });

  it("still takes keys that need Shift", () => {
    expect(press(">", { shiftKey: true }).handlers.speedBy).toHaveBeenCalled();
    expect(
      press("K", { shiftKey: true }).handlers.togglePlay,
    ).toHaveBeenCalled();
  });

  it("does nothing while a dialog is open (e.g. Settings)", () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    try {
      expect(press(" ").handled).toBeNull();
      expect(press("ArrowRight").handled).toBeNull();
    } finally {
      dialog.remove();
    }
    expect(press(" ").handled).toBe("togglePlay");
  });

  it("doesn't flip toggles back and forth while a key is held", () => {
    expect(press("f", { repeat: true }).handled).toBeNull();
    expect(press(" ", { repeat: true }).handled).toBeNull();
    expect(press("m", { repeat: true }).handled).toBeNull();
    // Seeking and volume keep going.
    expect(press("ArrowRight", { repeat: true }).handled).toBe("seekBy");
    expect(press("ArrowUp", { repeat: true }).handled).toBe("volumeBy");
  });

  it("ignores keys something else already handled", () => {
    expect(press(" ", { defaultPrevented: true }).handled).toBeNull();
  });

  it("ignores keys it doesn't know", () => {
    expect(press("x").handled).toBeNull();
    expect(press("Tab").handled).toBeNull();
  });
});

describe("stepSpeed", () => {
  it("moves between the presets", () => {
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(0.5, -1)).toBe(0.5);
    // From an odd rate, to the nearest preset in that direction.
    expect(stepSpeed(1.1, 1)).toBe(1.25);
  });
});
