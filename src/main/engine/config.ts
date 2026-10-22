import type { EngineConfig } from "../../shared/engine-protocol";
import type { Settings } from "../../shared/settings";
import type { Logger } from "../logs";
import { ensureDefaultCacheDir } from "../settings/cache-dir";
import type { SettingsStore } from "../settings/store";

// The settings the engine follows (EngineConfig), sent in `init` and again
// as a `config` message whenever one of them changes.

/** Like the sizes the UI shows (formatBytes): 1 GB = 1000³ bytes. */
const BYTES_PER_GB = 1_000_000_000;
/** Rate limits are in KB/s, 1 KB = 1000 bytes (see RATE_LIMIT_CHOICES_KBPS). */
const BYTES_PER_KB = 1000;

export function toEngineConfig(
  settings: Readonly<Settings>,
  cacheDir: string,
): EngineConfig {
  const perSecond = (kilobytes: number | null) =>
    kilobytes === null ? null : kilobytes * BYTES_PER_KB;
  return {
    cacheDir,
    cacheLimitBytes:
      settings.cacheLimitGb === null
        ? null
        : settings.cacheLimitGb * BYTES_PER_GB,
    hardwareEncoding: settings.hardwareEncoding,
    downloadLimit: perSecond(settings.downloadLimitKBps),
    uploadLimit: perSecond(settings.uploadLimitKBps),
    keepSharingMinutes: settings.keepSharingMinutes,
    maxConnections: settings.maxConnections,
  };
}

interface EngineConfigOptions {
  store: SettingsStore;
  defaultCacheDir: string;
  log: Logger;
}

export interface EngineConfigSource {
  /** The config for the current settings. */
  current: () => EngineConfig;
  /** Calls `listener` when a setting the engine follows changes. */
  onChange: (listener: (config: EngineConfig) => void) => () => void;
}

export function engineConfigSource({
  store,
  defaultCacheDir,
  log,
}: EngineConfigOptions): EngineConfigSource {
  const current = (): EngineConfig => {
    const settings = store.get();
    if (settings.cacheDir === null) {
      // The default folder is always ours to create (with its marker). A
      // chosen one was checked when it was picked, and is never re-created:
      // if it's gone, it may be on an unplugged drive.
      try {
        ensureDefaultCacheDir(defaultCacheDir);
      } catch (error) {
        log.error({ err: error }, "Could not create the default video folder");
      }
    }
    return toEngineConfig(settings, settings.cacheDir ?? defaultCacheDir);
  };

  return {
    current,
    onChange: (listener) => {
      // Compared without preparing folders: most changes (theme, size…)
      // don't concern the engine at all.
      const fingerprint = (settings: Readonly<Settings>) =>
        JSON.stringify(
          toEngineConfig(settings, settings.cacheDir ?? defaultCacheDir),
        );
      let last = fingerprint(store.get());
      return store.onChange((settings) => {
        const next = fingerprint(settings);
        if (next === last) return;
        last = next;
        listener(current());
      });
    },
  };
}
