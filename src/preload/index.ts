import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  type AppInfo,
  type EngineStatus,
  IpcChannel,
  type Platform,
  type StreamyApi,
  type TorrentFileOpened,
  type UpdateStatus,
} from "../shared/api";
import type {
  ActionResult,
  CacheUsage,
  ChooseCacheDirResult,
  SettingsSnapshot,
  SystemIntegration,
} from "../shared/settings";

// The preload script is the only bridge between the UI and Electron. The UI
// gets this small API and nothing else (no Node.js, no raw ipcRenderer).

const platform: Platform =
  process.platform === "darwin" || process.platform === "win32"
    ? process.platform
    : "linux";

/** Calls the main process. The result type is what its handler returns. */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

/** Listens to a main → UI message. The Electron event object stays here. */
function subscribe(
  channel: string,
  listener: (...args: unknown[]) => void,
): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => {
    listener(...args);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: StreamyApi = {
  platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  getAppInfo: () => invoke<AppInfo>(IpcChannel.GetAppInfo),
  relaunch: () => invoke<undefined>(IpcChannel.Relaunch),
  settings: {
    get: () => invoke<SettingsSnapshot>(IpcChannel.GetSettings),
    update: (patch) =>
      invoke<SettingsSnapshot>(IpcChannel.UpdateSettings, patch),
    reset: () => invoke<SettingsSnapshot>(IpcChannel.ResetSettings),
    chooseCacheDir: () =>
      invoke<ChooseCacheDirResult>(IpcChannel.ChooseCacheDir),
    resetCacheDir: () => invoke<SettingsSnapshot>(IpcChannel.ResetCacheDir),
    showCacheDir: () => invoke<ActionResult>(IpcChannel.ShowCacheDir),
    showPreviousCacheDir: () =>
      invoke<ActionResult>(IpcChannel.ShowPreviousCacheDir),
    getCacheUsage: () => invoke<CacheUsage>(IpcChannel.GetCacheUsage),
    clearCache: () => invoke<ActionResult>(IpcChannel.ClearCache),
    openDataDir: () => invoke<ActionResult>(IpcChannel.OpenDataDir),
    onChange: (listener) =>
      subscribe(IpcChannel.SettingsChanged, (snapshot) => {
        listener(snapshot as SettingsSnapshot);
      }),
  },
  system: {
    get: () => invoke<SystemIntegration>(IpcChannel.GetSystemIntegration),
    setOpenAtLogin: (enabled) =>
      invoke<SystemIntegration>(IpcChannel.SetOpenAtLogin, enabled),
    setHandlesMagnetLinks: (enabled) =>
      invoke<SystemIntegration>(IpcChannel.SetHandlesMagnetLinks, enabled),
  },
  engine: {
    getStatus: () => invoke<EngineStatus>(IpcChannel.GetEngineStatus),
    onStatusChange: (listener) =>
      subscribe(IpcChannel.EngineStatusChanged, (status) => {
        listener(status as EngineStatus);
      }),
  },
  updates: {
    getStatus: () => invoke<UpdateStatus>(IpcChannel.GetUpdateStatus),
    onStatusChange: (listener) =>
      subscribe(IpcChannel.UpdateStatusChanged, (status) => {
        listener(status as UpdateStatus);
      }),
    check: () => invoke<UpdateStatus>(IpcChannel.CheckForUpdates),
    install: () => invoke<undefined>(IpcChannel.InstallUpdate),
    openReleasePage: () => invoke<ActionResult>(IpcChannel.OpenReleasePage),
  },
  window: {
    isFullScreen: () => invoke<boolean>(IpcChannel.GetFullScreen),
    setFullScreen: (fullScreen) =>
      invoke<undefined>(IpcChannel.SetFullScreen, fullScreen),
  },
  player: {
    setPlaying: (playing) => invoke<undefined>(IpcChannel.SetPlaying, playing),
  },
  openLogs: () => invoke<ActionResult>(IpcChannel.OpenLogs),
  onOpenSettings: (listener) =>
    subscribe(IpcChannel.OpenSettings, () => {
      listener();
    }),
  onMagnetLink: (listener) =>
    subscribe(IpcChannel.MagnetLinkOpened, (link) => {
      if (typeof link === "string") listener(link);
    }),
  onTorrentFileOpened: (listener) =>
    subscribe(IpcChannel.TorrentFileOpened, (result) => {
      listener(result as TorrentFileOpened);
    }),
  onFullScreenChange: (listener) =>
    subscribe(IpcChannel.FullScreenChanged, (fullScreen) => {
      listener(fullScreen === true);
    }),
};

contextBridge.exposeInMainWorld("streamy", api);
