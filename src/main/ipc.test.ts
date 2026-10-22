import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcChannel } from "../shared/api";
import { registerAppIpc } from "./ipc";
import {
  createFakeWebContents,
  electron,
  invoke,
  invokeAs,
  invokeFrom,
  resetFakeElectron,
} from "./test/fake-electron";

vi.mock(
  "electron",
  async () => (await import("./test/fake-electron")).electron,
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "streamy-ipc-"));
  electron.app.getPath.mockImplementation((name: string) => join(root, name));
  registerAppIpc();
});

afterEach(() => {
  resetFakeElectron();
  rmSync(root, { recursive: true, force: true });
});

describe("opening the logs folder", () => {
  it("creates it if needed and opens it", async () => {
    const logs = join(root, "logs");

    expect(await invoke(IpcChannel.OpenLogs)).toEqual({ status: "ok" });
    expect(existsSync(logs)).toBe(true);
    expect(electron.shell.openPath).toHaveBeenCalledWith(logs);
  });

  it("passes on the OS's reason when it can't", async () => {
    electron.shell.openPath.mockResolvedValueOnce("No application found");

    expect(await invoke(IpcChannel.OpenLogs)).toEqual({
      status: "error",
      message: "No application found",
    });
  });

  it("only answers our own UI", () => {
    expect(() =>
      invokeFrom("https://evil.example/", IpcChannel.OpenLogs),
    ).toThrow("untrusted");
    expect(electron.shell.openPath).not.toHaveBeenCalled();
  });
});

describe("full screen (the calling window)", () => {
  function fakeWindow(fullScreen: boolean) {
    const contents = createFakeWebContents();
    const window = {
      webContents: contents,
      isFullScreen: vi.fn(() => fullScreen),
      setFullScreen: vi.fn((_value: boolean) => undefined),
    };
    electron.BrowserWindow.fromWebContents.mockImplementation((sender) =>
      sender === contents ? window : null,
    );
    return { contents, window };
  }

  it("says whether the window is in full screen", () => {
    const { contents } = fakeWindow(true);

    expect(invokeAs({ sender: contents }, IpcChannel.GetFullScreen)).toBe(true);
    // A page without a window (e.g. closing) isn't.
    expect(invokeAs({ sender: {} }, IpcChannel.GetFullScreen)).toBe(false);
  });

  it("enters and leaves full screen", () => {
    const { contents, window } = fakeWindow(false);

    invokeAs({ sender: contents }, IpcChannel.SetFullScreen, true);
    invokeAs({ sender: contents }, IpcChannel.SetFullScreen, false);

    expect(window.setFullScreen.mock.calls).toEqual([[true], [false]]);
  });

  it("refuses anything but true or false, and other pages", () => {
    const { contents, window } = fakeWindow(false);

    expect(() =>
      invokeAs({ sender: contents }, IpcChannel.SetFullScreen, "yes"),
    ).toThrow();
    expect(() =>
      invokeAs(
        { url: "https://evil.example/", sender: contents },
        IpcChannel.SetFullScreen,
        true,
      ),
    ).toThrow("untrusted");
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });
});

describe("restarting (Settings → Restart)", () => {
  it("starts again without the link or file Streamy was opened with", () => {
    const argv = process.argv;
    process.argv = [
      "/opt/Streamy/streamy",
      "--user-data-dir=/tmp/profile",
      "magnet:?xt=urn:btih:abc",
      "/home/me/Movie.torrent",
    ];
    try {
      invoke(IpcChannel.Relaunch);
    } finally {
      process.argv = argv;
    }

    expect(electron.app.relaunch).toHaveBeenCalledWith({
      args: ["--user-data-dir=/tmp/profile"],
    });
    expect(electron.app.quit).toHaveBeenCalled();
  });
});
