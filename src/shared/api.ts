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
  ShowPreviousCacheDir: "settings:show-previous-cache-dir",
  GetCacheUsage: "settings:get-cache-usage",
  ClearCache: "settings:clear-cache",
  OpenDataDir: "settings:open-data-dir",
  GetSystemIntegration: "system:get",
  SetOpenAtLogin: "system:set-open-at-login",
  SetHandlesMagnetLinks: "system:set-handles-magnet-links",
  OpenLogs: "app:open-logs",
  TorrentFileOpened: "app:torrent-file-opened",
  GetEngineStatus: "engine:get-status",
  EngineStatusChanged: "engine:status-changed",
  SetPlaying: "player:set-playing",
  GetFullScreen: "window:get-full-screen",
  SetFullScreen: "window:set-full-screen",
  GetUpdateStatus: "update:get-status",
  UpdateStatusChanged: "update:status-changed",
  CheckForUpdates: "update:check",
  InstallUpdate: "update:install",
  OpenReleasePage: "update:open-release-page",
} as const;

export type Platform = "darwin" | "win32" | "linux";

export interface AppInfo {
  name: string;
  version: string;
}

/** Functions that subscribe return an unsubscribe function. */
type Unsubscribe = () => void;

/**
 * The playback engine (a background process run by the main process).
 *   starting   launched, not answering yet
 *   running    answering at app://streamy/api
 *   restarting it stopped unexpectedly; it's being started again
 *   failed     it kept stopping; Streamy gave up for now (retries in a minute)
 */
export type EngineState = "starting" | "running" | "restarting" | "failed";

export interface EngineStatus {
  state: EngineState;
  /**
   * What went wrong last, as a plain sentence for people (never the engine's
   * raw error text: that goes to the log). null when nothing did.
   */
  error: string | null;
}

export interface EngineApi {
  getStatus: () => Promise<EngineStatus>;
  onStatusChange: (listener: (status: EngineStatus) => void) => Unsubscribe;
}

export interface PlayerApi {
  /**
   * true while a video plays: the screen doesn't sleep. Released by false,
   * and when the window closes.
   */
  setPlaying: (playing: boolean) => Promise<void>;
}

/**
 * Updates. Windows and the Linux AppImage update themselves (download in the
 * background, then "Restart to update"). macOS builds aren't signed yet, so
 * they can't: they only say a new version exists and link to its page.
 *
 *   unsupported  this build can't check (a dev build, the .deb, …)
 *   idle         nothing to report (not checked yet, or up to date)
 *   checking     asking GitHub Releases
 *   available    a newer version exists. canInstall false = macOS: the
 *                user downloads it from the release page
 *   downloading  fetching it in the background (Windows, AppImage)
 *   ready        downloaded; installs on restart (or when Streamy quits)
 *   error        the last check or download failed
 */
export type UpdateStatus =
  | { state: "unsupported" }
  | { state: "idle"; checkedAt: string | null }
  | { state: "checking" }
  | { state: "available"; version: string; canInstall: boolean }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export interface UpdatesApi {
  getStatus: () => Promise<UpdateStatus>;
  onStatusChange: (listener: (status: UpdateStatus) => void) => Unsubscribe;
  /** Checks now (Settings → "Check for updates"). */
  check: () => Promise<UpdateStatus>;
  /** "Restart to update": quits and installs the downloaded version. */
  install: () => Promise<void>;
  /** Opens the newest release's page in the browser (macOS download). */
  openReleasePage: () => Promise<ActionResult>;
}

/** The window this page is in (sent by the main process for the caller). */
export interface WindowApi {
  /** OS full screen (View menu, F11, ⌃⌘F, the green button). */
  isFullScreen: () => Promise<boolean>;
  setFullScreen: (fullScreen: boolean) => Promise<void>;
}

/** A .torrent file opened with Streamy (double-click, Dock, "Open with"). */
export type TorrentFileOpened =
  { status: "ok"; infoHash: string } | { status: "error"; message: string };

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
  /** Shows SettingsSnapshot.previousCacheDir in Finder / File Explorer. */
  showPreviousCacheDir: () => Promise<ActionResult>;
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
  engine: EngineApi;
  player: PlayerApi;
  updates: UpdatesApi;
  window: WindowApi;
  /** Opens the folder with Streamy's log files. */
  openLogs: () => Promise<ActionResult>;
  /** The app menu's "Settings…" item (⌘, / Ctrl+,). */
  onOpenSettings: (listener: () => void) => Unsubscribe;
  /** A magnet: link was opened with Streamy (e.g. clicked in a browser). */
  onMagnetLink: (listener: (link: string) => void) => Unsubscribe;
  /**
   * A .torrent file was opened with Streamy. The main process already
   * added it to the engine: the UI only needs to show it.
   */
  onTorrentFileOpened: (
    listener: (result: TorrentFileOpened) => void,
  ) => Unsubscribe;
  /** Called when the window enters or leaves full screen. */
  onFullScreenChange: (listener: (fullScreen: boolean) => void) => Unsubscribe;
}
