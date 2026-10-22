import { vi } from "vitest";
import type {
  EngineStatus,
  StreamyApi,
  TorrentFileOpened,
  UpdateStatus,
} from "../../../shared/api";
import type {
  ActionResult,
  CacheUsage,
  ChooseCacheDirResult,
  Settings,
  SettingsSnapshot,
  SystemIntegration,
} from "../../../shared/settings";

// Stands in for the preload script's window.streamy in UI tests. It behaves
// like the real thing (changes come back through onChange) without Electron.

export const DEFAULT_CACHE_DIR = "/Users/test/Library/Caches/Streamy";

export const INITIAL_SNAPSHOT: SettingsSnapshot = {
  settings: {
    theme: "system",
    uiScale: 1,
    cacheDir: null,
    cacheLimitGb: 20,
    hardwareAcceleration: true,
    checkForUpdates: true,
    audioLanguage: null,
    subtitleLanguage: null,
    subtitleSize: "m",
    subtitleBackground: "shadow",
    subtitleColor: "white",
    hardwareEncoding: "auto",
    downloadLimitKBps: null,
    uploadLimitKBps: null,
    keepSharingMinutes: 10,
    maxConnections: 100,
  },
  defaultCacheDir: DEFAULT_CACHE_DIR,
  hardwareAccelerationActive: true,
  previousCacheDir: null,
};

export const INITIAL_SYSTEM: SystemIntegration = {
  available: true,
  openAtLogin: false,
  openAtLoginNeedsApproval: false,
  handlesMagnetLinks: false,
  canHandleMagnetLinks: true,
};

const OK: ActionResult = { status: "ok" };

export const RUNNING_ENGINE: EngineStatus = { state: "running", error: null };

export const INITIAL_UPDATE_STATUS: UpdateStatus = {
  state: "idle",
  checkedAt: null,
};

function createFakeStreamy() {
  let snapshot = INITIAL_SNAPSHOT;
  let system = INITIAL_SYSTEM;
  const changeListeners = new Set<(next: SettingsSnapshot) => void>();
  const openListeners = new Set<() => void>();
  const magnetListeners = new Set<(link: string) => void>();
  const torrentFileListeners = new Set<(result: TorrentFileOpened) => void>();
  let engineStatus = RUNNING_ENGINE;
  const engineListeners = new Set<(status: EngineStatus) => void>();
  let updateStatus: UpdateStatus = INITIAL_UPDATE_STATUS;
  const updateListeners = new Set<(status: UpdateStatus) => void>();
  let fullScreen = false;
  const fullScreenListeners = new Set<(fullScreen: boolean) => void>();

  /** What the main process does after a change: tell every window. */
  const emit = (next: SettingsSnapshot) => {
    snapshot = next;
    for (const listener of changeListeners) listener(next);
  };
  const withSettings = (patch: Partial<Settings>) => {
    emit({ ...snapshot, settings: { ...snapshot.settings, ...patch } });
    return snapshot;
  };

  const api = {
    platform: "darwin",
    versions: { electron: "45.0.0", chrome: "156.0.0.0", node: "24.0.0" },
    getAppInfo: vi.fn(() =>
      Promise.resolve({ name: "Streamy", version: "0.0.0" }),
    ),
    relaunch: vi.fn(() => Promise.resolve(undefined)),
    settings: {
      get: vi.fn(() => Promise.resolve(snapshot)),
      update: vi.fn((patch: Partial<Settings>) =>
        Promise.resolve(withSettings(patch)),
      ),
      reset: vi.fn(() =>
        Promise.resolve(withSettings(INITIAL_SNAPSHOT.settings)),
      ),
      chooseCacheDir: vi.fn((): Promise<ChooseCacheDirResult> =>
        Promise.resolve({ status: "canceled" }),
      ),
      resetCacheDir: vi.fn(() =>
        Promise.resolve(withSettings({ cacheDir: null })),
      ),
      showCacheDir: vi.fn(() => Promise.resolve(OK)),
      showPreviousCacheDir: vi.fn(() => Promise.resolve(OK)),
      getCacheUsage: vi.fn((): Promise<CacheUsage> =>
        Promise.resolve({ status: "ok", bytes: 0 }),
      ),
      clearCache: vi.fn(() => Promise.resolve(OK)),
      openDataDir: vi.fn(() => Promise.resolve(OK)),
      onChange: (listener) => {
        changeListeners.add(listener);
        return () => changeListeners.delete(listener);
      },
    },
    system: {
      get: vi.fn(() => Promise.resolve(system)),
      setOpenAtLogin: vi.fn((enabled: boolean) => {
        system = { ...system, openAtLogin: enabled };
        return Promise.resolve(system);
      }),
      setHandlesMagnetLinks: vi.fn((enabled: boolean) => {
        system = { ...system, handlesMagnetLinks: enabled };
        return Promise.resolve(system);
      }),
    },
    engine: {
      getStatus: vi.fn(() => Promise.resolve(engineStatus)),
      onStatusChange: (listener) => {
        engineListeners.add(listener);
        return () => engineListeners.delete(listener);
      },
    },
    updates: {
      getStatus: vi.fn(() => Promise.resolve(updateStatus)),
      onStatusChange: (listener) => {
        updateListeners.add(listener);
        return () => updateListeners.delete(listener);
      },
      check: vi.fn(() => Promise.resolve(updateStatus)),
      install: vi.fn(() => Promise.resolve(undefined)),
      openReleasePage: vi.fn(() => Promise.resolve(OK)),
    },
    player: {
      setPlaying: vi.fn((_playing: boolean) => Promise.resolve(undefined)),
    },
    openLogs: vi.fn(() => Promise.resolve(OK)),
    onTorrentFileOpened: (listener) => {
      torrentFileListeners.add(listener);
      return () => torrentFileListeners.delete(listener);
    },
    onOpenSettings: (listener) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    onMagnetLink: (listener) => {
      magnetListeners.add(listener);
      return () => magnetListeners.delete(listener);
    },
    onFullScreenChange: (listener) => {
      fullScreenListeners.add(listener);
      return () => fullScreenListeners.delete(listener);
    },
    // Like the main process: changing it also fires onFullScreenChange.
    window: {
      isFullScreen: vi.fn(() => Promise.resolve(fullScreen)),
      setFullScreen: vi.fn((next: boolean) => {
        setFullScreen(next);
        return Promise.resolve(undefined);
      }),
    },
  } satisfies StreamyApi;

  function setFullScreen(next: boolean) {
    if (next === fullScreen) return;
    fullScreen = next;
    for (const listener of fullScreenListeners) listener(fullScreen);
  }

  return {
    api,
    /** Back to the starting state (call before each test). */
    reset(nextSystem: SystemIntegration = INITIAL_SYSTEM) {
      system = nextSystem;
      emit(INITIAL_SNAPSHOT);
      // Told to listeners too, so stores that follow the engine start over.
      engineStatus = RUNNING_ENGINE;
      for (const listener of engineListeners) listener(engineStatus);
      updateStatus = INITIAL_UPDATE_STATUS;
      for (const listener of updateListeners) listener(updateStatus);
      if (fullScreen) setFullScreen(false);
    },
    /** Pretend the updater's state changed in the main process. */
    setUpdateStatus(status: UpdateStatus) {
      updateStatus = status;
      for (const listener of updateListeners) listener(status);
    },
    /** Pretend the settings changed in the main process. */
    emit,
    /** Pretend the user picked "Settings…" in the app menu. */
    openFromMenu() {
      for (const listener of openListeners) listener();
    },
    /** Pretend a magnet link was clicked in a browser. */
    openMagnetLink(link: string) {
      for (const listener of magnetListeners) listener(link);
    },
    /** Pretend a .torrent file was opened from the OS. */
    openTorrentFile(result: TorrentFileOpened) {
      for (const listener of torrentFileListeners) listener(result);
    },
    /** Pretend the window entered or left full screen (View menu, F11…). */
    setFullScreen,
    /** Pretend the engine's state changed in the main process. */
    setEngineStatus(status: EngineStatus) {
      engineStatus = status;
      for (const listener of engineListeners) listener(status);
    },
  };
}

export const fakeStreamy = createFakeStreamy();
