// Shared by the main process, the preload script and the UI.
// No runtime dependencies here: the sandboxed preload can't load packages.

import type {
  ActionResult,
  CacheUsage,
  ChooseCacheDirResult,
  SettingsSnapshot,
  SettingsUpdate,
  SystemIntegration,
} from "./settings";

/** Height of our title bar. The OS window buttons are centered in it. */
export const TITLE_BAR_HEIGHT = 44;

/** IPC channel names (main ⇄ preload). */
export const IpcChannel = {
  GetAppInfo: "app:get-info",
  Relaunch: "app:relaunch",
  OpenSettings: "app:open-settings",
  MagnetLinkOpened: "app:magnet-link-opened",
  FullScreenChanged: "window:full-screen-changed",
  GetSettings: "settings:get",
  UpdateSettings: "settings:update",
  ResetSettings: "settings:reset",
  SettingsChanged: "settings:changed",
  ChooseCacheDir: "settings:choose-cache-dir",
  ResetCacheDir: "settings:reset-cache-dir",
  ShowCacheDir: "settings:show-cache-dir",
  GetCacheUsage: "settings:get-cache-usage",
  ClearCache: "settings:clear-cache",
  OpenDataDir: "settings:open-data-dir",
  GetSystemIntegration: "system:get",
  SetOpenAtLogin: "system:set-open-at-login",
  SetHandlesMagnetLinks: "system:set-handles-magnet-links",
} as const;

export type Platform = "darwin" | "win32" | "linux";

export interface AppInfo {
  name: string;
  version: string;
}

/** Functions that subscribe return an unsubscribe function. */
type Unsubscribe = () => void;

export interface SettingsApi {
  get: () => Promise<SettingsSnapshot>;
  update: (patch: SettingsUpdate) => Promise<SettingsSnapshot>;
  /** Puts every setting back to its default. */
  reset: () => Promise<SettingsSnapshot>;
  /** Opens the OS folder picker for the video folder. */
  chooseCacheDir: () => Promise<ChooseCacheDirResult>;
  /** Goes back to the default video folder. */
  resetCacheDir: () => Promise<SettingsSnapshot>;
  /** Shows the video folder in Finder / File Explorer. */
  showCacheDir: () => Promise<ActionResult>;
  getCacheUsage: () => Promise<CacheUsage>;
  /** Deletes the videos Streamy downloaded. */
  clearCache: () => Promise<ActionResult>;
  /** Opens the folder with settings.json and other app data. */
  openDataDir: () => Promise<ActionResult>;
  /** Called after every change (from any window, or the main process). */
  onChange: (listener: (snapshot: SettingsSnapshot) => void) => Unsubscribe;
}

export interface SystemApi {
  get: () => Promise<SystemIntegration>;
  setOpenAtLogin: (enabled: boolean) => Promise<SystemIntegration>;
  setHandlesMagnetLinks: (enabled: boolean) => Promise<SystemIntegration>;
}

/** What the preload script exposes to the UI as `window.streamy`. */
export interface StreamyApi {
  platform: Platform;
  versions: { electron: string; chrome: string; node: string };
  getAppInfo: () => Promise<AppInfo>;
  /** Restarts Streamy (e.g. after changing hardware acceleration). */
  relaunch: () => Promise<void>;
  settings: SettingsApi;
  system: SystemApi;
  /** The app menu's "Settings…" item (⌘, / Ctrl+,). */
  onOpenSettings: (listener: () => void) => Unsubscribe;
  /** A magnet: link was opened with Streamy (e.g. clicked in a browser). */
  onMagnetLink: (listener: (link: string) => void) => Unsubscribe;
  /** Called when the window enters or leaves full screen. */
  onFullScreenChange: (listener: (fullScreen: boolean) => void) => Unsubscribe;
}
