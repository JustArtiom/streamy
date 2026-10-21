import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcChannel } from "../../shared/api";
import type { SettingsSnapshot } from "../../shared/settings";
import {
  createFakeWindow,
  electron,
  invoke,
  invokeFrom,
  resetFakeElectron,
  windows,
} from "../test/fake-electron";
import { CACHE_MARKER, CACHE_SUBFOLDER } from "./cache-dir";
import { type SettingsController, setupSettings } from "./index";
import { SettingsStore } from "./store";

vi.mock(
  "electron",
  async () => (await import("../test/fake-electron")).electron,
);

let root: string;
let defaultCacheDir: string;
let downloads: string;
let store: SettingsStore;
let controller: SettingsController;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "streamy-ipc-"));
  defaultCacheDir = join(root, "Caches", "Streamy");
  downloads = join(root, "Downloads");
  mkdirSync(downloads);
  store = new SettingsStore(join(root, "settings.json"));
  controller = setupSettings({
    store,
    defaultCacheDir,
    protectedDirs: [downloads],
    dataDir: root,
  });
});

afterEach(() => {
  resetFakeElectron();
  rmSync(root, { recursive: true, force: true });
});

const pickFolder = (folder: string | null) => {
  electron.dialog.showOpenDialog.mockResolvedValueOnce(
    folder
      ? { canceled: false, filePaths: [folder] }
      : { canceled: true, filePaths: [] },
  );
};

describe("reading and changing settings", () => {
  it("gives the UI the settings and the facts it needs", async () => {
    const snapshot = (await invoke(IpcChannel.GetSettings)) as SettingsSnapshot;

    expect(snapshot.defaultCacheDir).toBe(defaultCacheDir);
    expect(snapshot.hardwareAccelerationActive).toBe(true);
    expect(snapshot.settings.theme).toBe("system");
  });

  it("applies a change to every window and tells them about it", async () => {
    const window = createFakeWindow();
    windows.push(window);

    await invoke(IpcChannel.UpdateSettings, { theme: "dark", uiScale: 1.25 });

    expect(electron.nativeTheme.themeSource).toBe("dark");
    expect(window.webContents.setZoomFactor).toHaveBeenCalledWith(1.25);
    const [channel, sent] = window.webContents.send.mock.calls[0] ?? [];
    expect(channel).toBe(IpcChannel.SettingsChanged);
    expect((sent as SettingsSnapshot).settings).toMatchObject({
      theme: "dark",
      uiScale: 1.25,
    });
  });

  it("refuses a video folder sent by the UI (only the folder picker sets it)", () => {
    expect(() =>
      invoke(IpcChannel.UpdateSettings, { cacheDir: "/etc" }),
    ).toThrow();
    expect(store.get().cacheDir).toBeNull();
  });

  it("refuses calls from any page that isn't our UI", () => {
    expect(() =>
      invokeFrom("https://evil.example/", IpcChannel.UpdateSettings, {
        theme: "dark",
      }),
    ).toThrow("untrusted");
    expect(store.get().theme).toBe("system");
  });

  it("resets everything", async () => {
    store.update({ theme: "dark", cacheLimitGb: 5 });

    await invoke(IpcChannel.ResetSettings);

    expect(store.get()).toMatchObject({ theme: "system", cacheLimitGb: 20 });
  });
});

describe("interface size", () => {
  it("steps through the sizes, and stops at the ends", () => {
    controller.stepUiScale(1);
    expect(store.get().uiScale).toBe(1.1);
    controller.stepUiScale(1);
    controller.stepUiScale(1);
    expect(store.get().uiScale).toBe(1.25);

    controller.resetUiScale();
    controller.stepUiScale(-1);
    controller.stepUiScale(-1);
    expect(store.get().uiScale).toBe(0.9);
  });

  it("follows Ctrl + mouse wheel", () => {
    const window = createFakeWindow();
    electron.app.emit("browser-window-created", {}, window);

    window.webContents.emit("zoom-changed", {}, "in");

    expect(store.get().uiScale).toBe(1.1);
  });
});

describe("choosing the video folder", () => {
  it("does nothing when the picker is canceled", async () => {
    pickFolder(null);

    expect(await invoke(IpcChannel.ChooseCacheDir)).toEqual({
      status: "canceled",
    });
    expect(store.get().cacheDir).toBeNull();
  });

  it("uses an empty folder the user picked", async () => {
    const chosen = join(root, "Videos");
    pickFolder(chosen);

    expect(await invoke(IpcChannel.ChooseCacheDir)).toEqual({
      status: "changed",
    });
    expect(store.get().cacheDir).toBe(chosen);
  });

  it("makes its own folder inside Downloads instead of taking it over", async () => {
    pickFolder(downloads);

    await invoke(IpcChannel.ChooseCacheDir);

    expect(store.get().cacheDir).toBe(join(downloads, CACHE_SUBFOLDER));
  });

  it("treats picking the default folder as using the default", async () => {
    store.update({ cacheDir: join(root, "Elsewhere") });
    pickFolder(defaultCacheDir);

    await invoke(IpcChannel.ChooseCacheDir);

    expect(store.get().cacheDir).toBeNull();
  });

  it("explains a folder it can't use", async () => {
    const file = join(root, "movie.mkv");
    writeFileSync(file, "");
    pickFolder(file);

    expect(await invoke(IpcChannel.ChooseCacheDir)).toMatchObject({
      status: "error",
    });
  });
});

describe("the video folder's contents", () => {
  it("shows the default folder, creating it the first time", async () => {
    expect(await invoke(IpcChannel.ShowCacheDir)).toEqual({ status: "ok" });

    expect(existsSync(join(defaultCacheDir, CACHE_MARKER))).toBe(true);
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith(
      defaultCacheDir,
    );
  });

  it("never re-creates a chosen folder that's gone (unplugged drive)", async () => {
    const gone = join(root, "Unplugged", "Streamy");
    store.update({ cacheDir: gone });

    expect(await invoke(IpcChannel.ShowCacheDir)).toMatchObject({
      status: "error",
    });
    expect(await invoke(IpcChannel.ClearCache)).toMatchObject({
      status: "error",
    });
    expect(await invoke(IpcChannel.GetCacheUsage)).toEqual({
      status: "missing",
    });
    expect(existsSync(gone)).toBe(false);
  });

  it("reports 0 bytes before the default folder exists", async () => {
    expect(await invoke(IpcChannel.GetCacheUsage)).toEqual({
      status: "ok",
      bytes: 0,
    });
  });

  it("clears Streamy's videos", async () => {
    await invoke(IpcChannel.ShowCacheDir); // creates the default folder
    mkdirSync(join(defaultCacheDir, "torrents", "abc"), { recursive: true });

    expect(await invoke(IpcChannel.ClearCache)).toEqual({ status: "ok" });
    expect(readdirSync(defaultCacheDir)).toEqual([CACHE_MARKER]);
  });
});
