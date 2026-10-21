import { existsSync } from "node:fs";
import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  type OpenDialogOptions,
  shell,
} from "electron";
import { IpcChannel } from "../../shared/api";
import {
  type ActionResult,
  type CacheUsage,
  type ChooseCacheDirResult,
  type SettingsSnapshot,
  UI_SCALES,
} from "../../shared/settings";
import { handleTrusted } from "../ipc";
import {
  CacheDirError,
  cacheUsage,
  clearCache,
  ensureDefaultCacheDir,
  prepareCacheDir,
} from "./cache-dir";
import { settingsUpdateSchema } from "./schema";
import type { SettingsStore } from "./store";

interface SettingsOptions {
  store: SettingsStore;
  defaultCacheDir: string;
  /** Folders never used directly as the video folder (home, Downloads…). */
  protectedDirs: string[];
  /** The app's data folder (where settings.json lives). */
  dataDir: string;
}

export interface SettingsController {
  /** Interface size one step bigger (1) or smaller (-1). */
  stepUiScale: (direction: 1 | -1) => void;
  resetUiScale: () => void;
}

const FOLDER_UNAVAILABLE =
  "The video folder isn't available. If it's on an external drive, connect it and try again.";

/**
 * Applies the settings, and lets the UI read and change them over IPC.
 * Every change is sent to all windows.
 */
export function setupSettings({
  store,
  defaultCacheDir,
  protectedDirs,
  dataDir,
}: SettingsOptions): SettingsController {
  const snapshot = (): SettingsSnapshot => ({
    settings: store.get(),
    defaultCacheDir,
    hardwareAccelerationActive: app.isHardwareAccelerationEnabled(),
  });
  const cacheDir = () => store.get().cacheDir ?? defaultCacheDir;
  /** A chosen folder that's gone (e.g. on an unplugged drive). */
  const chosenFolderMissing = () =>
    store.get().cacheDir !== null && !existsSync(cacheDir());

  // Theme and size apply to every window. (New windows start with them, see
  // createMainWindow.) The theme also sets prefers-color-scheme in the UI.
  nativeTheme.themeSource = store.get().theme;
  store.onChange((settings) => {
    nativeTheme.themeSource = settings.theme;
    const next = snapshot();
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setZoomFactor(settings.uiScale);
      window.webContents.send(IpcChannel.SettingsChanged, next);
    }
  });

  const stepUiScale = (direction: 1 | -1) => {
    const index = UI_SCALES.indexOf(store.get().uiScale);
    const next = UI_SCALES[index + direction];
    if (next !== undefined) store.update({ uiScale: next });
  };
  // Ctrl + mouse wheel, or pinching a trackpad.
  app.on("browser-window-created", (_event, window) => {
    window.webContents.on("zoom-changed", (_zoomEvent, direction) => {
      stepUiScale(direction === "in" ? 1 : -1);
    });
  });

  handleTrusted(IpcChannel.GetSettings, () => snapshot());

  handleTrusted(IpcChannel.UpdateSettings, (_event, patch) => {
    store.update(settingsUpdateSchema.parse(patch));
    return snapshot();
  });

  handleTrusted(IpcChannel.ResetSettings, () => {
    store.reset();
    return snapshot();
  });

  handleTrusted(
    IpcChannel.ChooseCacheDir,
    async (event): Promise<ChooseCacheDirResult> => {
      const options: OpenDialogOptions = {
        title: "Choose where Streamy keeps videos",
        buttonLabel: "Use This Folder",
        defaultPath: cacheDir(),
        properties: ["openDirectory", "createDirectory", "promptToCreate"],
      };
      const window = BrowserWindow.fromWebContents(event.sender);
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      const chosen = result.filePaths[0];
      if (result.canceled || !chosen) return { status: "canceled" };

      try {
        const dir = prepareCacheDir(chosen, { protectedDirs });
        // Picking the default folder is the same as "Use default".
        store.update({ cacheDir: dir === defaultCacheDir ? null : dir });
        return { status: "changed" };
      } catch (error) {
        if (error instanceof CacheDirError) {
          return { status: "error", message: error.message };
        }
        throw error;
      }
    },
  );

  handleTrusted(IpcChannel.ResetCacheDir, () => {
    store.update({ cacheDir: null });
    return snapshot();
  });

  handleTrusted(IpcChannel.ShowCacheDir, (): ActionResult => {
    if (chosenFolderMissing()) {
      return { status: "error", message: FOLDER_UNAVAILABLE };
    }
    // Never create a chosen folder that's gone: it could end up on the wrong
    // disk. The default one is always ours to create.
    if (store.get().cacheDir === null) ensureDefaultCacheDir(defaultCacheDir);
    // Reveal (not open) it: opening a folder that happens to be an app
    // bundle would launch the app.
    shell.showItemInFolder(cacheDir());
    return { status: "ok" };
  });

  handleTrusted(IpcChannel.GetCacheUsage, async (): Promise<CacheUsage> => {
    const usage = await cacheUsage(cacheDir());
    // The default folder just hasn't been created yet: nothing used.
    return usage.status === "missing" && store.get().cacheDir === null
      ? { status: "ok", bytes: 0 }
      : usage;
  });

  handleTrusted(IpcChannel.ClearCache, async (): Promise<ActionResult> => {
    if (chosenFolderMissing()) {
      return { status: "error", message: FOLDER_UNAVAILABLE };
    }
    try {
      await clearCache(cacheDir());
      return { status: "ok" };
    } catch (error) {
      if (error instanceof CacheDirError) {
        return { status: "error", message: error.message };
      }
      throw error;
    }
  });

  handleTrusted(IpcChannel.OpenDataDir, async (): Promise<ActionResult> => {
    const error = await shell.openPath(dataDir);
    return error ? { status: "error", message: error } : { status: "ok" };
  });

  return {
    stepUiScale,
    resetUiScale: () => {
      store.update({ uiScale: 1 });
    },
  };
}
