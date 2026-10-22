import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig } from "../../shared/engine-protocol";
import { silentLogger } from "../logs";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { CACHE_MARKER } from "../settings/cache-dir";
import { SettingsStore } from "../settings/store";
import { engineConfigSource, toEngineConfig } from "./config";

describe("toEngineConfig", () => {
  it("turns settings into what the engine follows", () => {
    expect(toEngineConfig(DEFAULT_SETTINGS, "/cache")).toEqual({
      cacheDir: "/cache",
      cacheLimitBytes: 20_000_000_000,
      hardwareEncoding: "auto",
      downloadLimit: null,
      uploadLimit: null,
      keepSharingMinutes: 10,
      maxConnections: 100,
    } satisfies EngineConfig);
  });

  it("converts GB to bytes and KB/s to bytes per second (1 KB = 1000 bytes)", () => {
    const config = toEngineConfig(
      {
        ...DEFAULT_SETTINGS,
        cacheLimitGb: null,
        downloadLimitKBps: 500,
        uploadLimitKBps: 1,
        hardwareEncoding: "off",
        keepSharingMinutes: null,
        maxConnections: 25,
      },
      "/cache",
    );
    expect(config).toMatchObject({
      cacheLimitBytes: null,
      downloadLimit: 500_000,
      uploadLimit: 1_000,
      hardwareEncoding: "off",
      keepSharingMinutes: null,
      maxConnections: 25,
    });
  });
});

describe("engineConfigSource", () => {
  let root: string;
  let store: SettingsStore;
  let defaultCacheDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "streamy-config-"));
    store = new SettingsStore(join(root, "settings.json"));
    defaultCacheDir = join(root, "Caches", "Streamy");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const source = () =>
    engineConfigSource({ store, defaultCacheDir, log: silentLogger() });

  it("creates the default video folder, with its marker", () => {
    expect(source().current().cacheDir).toBe(defaultCacheDir);
    expect(existsSync(join(defaultCacheDir, CACHE_MARKER))).toBe(true);
  });

  it("never re-creates a chosen folder that's gone", () => {
    const gone = join(root, "Unplugged", "Streamy");
    store.update({ cacheDir: gone });

    expect(source().current().cacheDir).toBe(gone);
    expect(existsSync(gone)).toBe(false);
  });

  it("reports changes the engine cares about, and only those", () => {
    const listener = vi.fn<(config: EngineConfig) => void>();
    source().onChange(listener);

    store.update({ theme: "dark", uiScale: 1.25 });
    expect(listener).not.toHaveBeenCalled();

    store.update({ cacheLimitGb: 5 });
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ cacheLimitBytes: 5_000_000_000 }),
    );

    const chosen = join(root, "Videos");
    store.update({ cacheDir: chosen });
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ cacheDir: chosen }),
    );
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops reporting after unsubscribing", () => {
    const listener = vi.fn();
    const unsubscribe = source().onChange(listener);
    unsubscribe();

    store.update({ maxConnections: 50 });
    expect(listener).not.toHaveBeenCalled();
  });
});
