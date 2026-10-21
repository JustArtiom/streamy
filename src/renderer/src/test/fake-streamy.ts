import { vi } from "vitest";
import type { StreamyApi } from "../../../shared/api";
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
  },
  defaultCacheDir: DEFAULT_CACHE_DIR,
  hardwareAccelerationActive: true,
};

export const INITIAL_SYSTEM: SystemIntegration = {
  available: true,
  openAtLogin: false,
  openAtLoginNeedsApproval: false,
  handlesMagnetLinks: false,
};

const OK: ActionResult = { status: "ok" };

function createFakeStreamy() {
  let snapshot = INITIAL_SNAPSHOT;
  let system = INITIAL_SYSTEM;
  const changeListeners = new Set<(next: SettingsSnapshot) => void>();
  const openListeners = new Set<() => void>();
  const magnetListeners = new Set<(link: string) => void>();

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
    onOpenSettings: (listener) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    onMagnetLink: (listener) => {
      magnetListeners.add(listener);
      return () => magnetListeners.delete(listener);
    },
    onFullScreenChange: () => () => undefined,
  } satisfies StreamyApi;

  return {
    api,
    /** Back to the starting state (call before each test). */
    reset(nextSystem: SystemIntegration = INITIAL_SYSTEM) {
      system = nextSystem;
      emit(INITIAL_SNAPSHOT);
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
  };
}

export const fakeStreamy = createFakeStreamy();
