import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcChannel } from "../../shared/api";
import type { Settings } from "../../shared/settings";
import { silentLogger } from "../logs";
import { DEFAULT_SETTINGS } from "../settings/schema";
import {
  createFakeWindow,
  electron,
  invoke,
  invokeFrom,
  resetFakeElectron,
  windows,
} from "../test/fake-electron";
import { setupUpdates } from "./index";
import { type ModeDecision, updateMode } from "./mode";
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  type UpdateCheckResult,
} from "./updater";

vi.mock(
  "electron",
  async () => (await import("../test/fake-electron")).electron,
);

/** electron-updater's autoUpdater, faked: nothing goes online. */
const autoUpdater = Object.assign(new EventEmitter(), {
  logger: null,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  disableWebInstaller: false,
  checkForUpdates: vi.fn((): Promise<UpdateCheckResult | null> =>
    Promise.resolve({
      isUpdateAvailable: false,
      updateInfo: { version: "0.0.0" },
    }),
  ),
  quitAndInstall: vi.fn(),
});
// A getter: vi.mock runs before the line above, and it's only read later.
vi.mock("electron-updater", () => ({
  default: {
    get autoUpdater() {
      return autoUpdater;
    },
  },
}));

// The real decision depends on the OS running the tests; mode.test.ts covers it.
vi.mock("./mode", () => ({ updateMode: vi.fn() }));
const mockedMode = vi.mocked(updateMode);

function useMode(mode: ModeDecision["mode"]) {
  mockedMode.mockReturnValue({ mode, reason: "test" });
}

const log = silentLogger();

/** Just enough of the settings store: the test flips checkForUpdates. */
function fakeSettings(checkForUpdates = true) {
  let current: Settings = { ...DEFAULT_SETTINGS, checkForUpdates };
  const listeners = new Set<(settings: Readonly<Settings>) => void>();
  return {
    get: () => current,
    onChange: (listener: (settings: Readonly<Settings>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setCheckForUpdates: (value: boolean) => {
      current = { ...current, checkForUpdates: value };
      for (const listener of listeners) listener(current);
    },
  };
}

beforeEach(() => {
  windows.push(createFakeWindow());
});

afterEach(() => {
  electron.app.emit("will-quit"); // stops the updater's timers
  resetFakeElectron();
  autoUpdater.removeAllListeners();
});

describe("setupUpdates", () => {
  it("answers the UI: a dev build doesn't update", async () => {
    useMode("unsupported");
    setupUpdates({
      log,
      smoke: false,
      settings: fakeSettings(),
      beforeInstall: vi.fn(),
    });

    expect(await invoke(IpcChannel.GetUpdateStatus)).toEqual({
      state: "unsupported",
    });
    expect(await invoke(IpcChannel.CheckForUpdates)).toEqual({
      state: "unsupported",
    });
    expect(electron.net.fetch).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("macOS: tells every window about a new version, and opens its page", async () => {
    useMode("notify");
    electron.net.fetch.mockResolvedValueOnce(
      Response.json({ tag_name: "v9.0.0" }),
    );
    setupUpdates({
      log,
      smoke: false,
      settings: fakeSettings(),
      beforeInstall: vi.fn(),
    });

    const available = {
      state: "available",
      version: "9.0.0",
      canInstall: false,
    };
    expect(await invoke(IpcChannel.CheckForUpdates)).toEqual(available);
    const send = windows[0]?.webContents.send;
    expect(send).toHaveBeenCalledWith(IpcChannel.UpdateStatusChanged, {
      state: "checking",
    });
    expect(send).toHaveBeenLastCalledWith(
      IpcChannel.UpdateStatusChanged,
      available,
    );

    expect(await invoke(IpcChannel.OpenReleasePage)).toEqual({ status: "ok" });
    expect(electron.shell.openExternal).toHaveBeenCalledWith(
      "https://github.com/JustArtiom/streamy/releases/tag/v9.0.0",
    );
  });

  it("Windows/AppImage: downloads with electron-updater, then restarts to install", async () => {
    useMode("auto");
    const download = Promise.withResolvers<string[]>();
    autoUpdater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: "9.0.0" },
      downloadPromise: download.promise,
    });
    const beforeInstall = vi.fn(() => Promise.resolve());
    setupUpdates({
      log,
      smoke: false,
      settings: fakeSettings(),
      beforeInstall,
    });

    expect(await invoke(IpcChannel.CheckForUpdates)).toMatchObject({
      state: "downloading",
    });
    // Set up the way Streamy needs it.
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.listenerCount("error")).toBe(1);

    download.resolve([]);
    await vi.waitFor(async () => {
      expect(await invoke(IpcChannel.GetUpdateStatus)).toEqual({
        state: "ready",
        version: "9.0.0",
      });
    });

    await invoke(IpcChannel.InstallUpdate);
    expect(beforeInstall).toHaveBeenCalledOnce();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    // The new version must be able to start while this one quits.
    expect(electron.app.releaseSingleInstanceLock).toHaveBeenCalled();
    expect(
      electron.app.releaseSingleInstanceLock.mock.invocationCallOrder[0],
    ).toBeLessThan(autoUpdater.quitAndInstall.mock.invocationCallOrder[0] ?? 0);
  });

  it("follows the checkForUpdates setting", async () => {
    vi.useFakeTimers();
    try {
      useMode("auto");
      const settings = fakeSettings(false);
      setupUpdates({ log, smoke: false, settings, beforeInstall: vi.fn() });

      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();

      settings.setCheckForUpdates(true);
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
      expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();

      settings.setCheckForUpdates(false);
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
      expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Open at login working when an update renames the AppImage", async () => {
    useMode("auto");
    setupUpdates({
      log,
      smoke: false,
      settings: fakeSettings(),
      beforeInstall: vi.fn(),
    });
    await invoke(IpcChannel.CheckForUpdates); // sets electron-updater up

    expect(autoUpdater.listenerCount("appimage-filename-updated")).toBe(1);
  });

  it("only answers our own UI", () => {
    useMode("notify");
    setupUpdates({
      log,
      smoke: false,
      settings: fakeSettings(),
      beforeInstall: vi.fn(),
    });

    for (const channel of [
      IpcChannel.GetUpdateStatus,
      IpcChannel.CheckForUpdates,
      IpcChannel.InstallUpdate,
      IpcChannel.OpenReleasePage,
    ]) {
      expect(() => invokeFrom("https://evil.example/", channel)).toThrow(
        "untrusted",
      );
    }
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });

  it("passes the smoke flag on (the smoke test never goes online)", () => {
    useMode("unsupported");
    setupUpdates({
      log,
      smoke: true,
      settings: fakeSettings(),
      beforeInstall: vi.fn(),
    });

    expect(mockedMode).toHaveBeenLastCalledWith(
      expect.objectContaining({ smoke: true, isPackaged: true }),
    );
  });
});
