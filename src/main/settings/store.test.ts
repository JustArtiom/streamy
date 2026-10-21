import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "../../shared/settings";
import { writeJsonFile } from "../storage/json-file";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  settingsUpdateSchema,
} from "./schema";
import { parseSettingsFile, SettingsStore } from "./store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "streamy-settings-"));
  file = join(dir, "settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readSaved = () => JSON.parse(readFileSync(file, "utf8")) as unknown;

describe("parseSettingsFile", () => {
  // Wrapped in arrays: it.each would otherwise spread ["dark"] into "dark".
  it.each([[undefined], [null], ["dark"], [42], [["dark"]]])(
    "uses the defaults for %j",
    (raw: unknown) => {
      expect(parseSettingsFile(raw).settings).toEqual(DEFAULT_SETTINGS);
    },
  );

  it("keeps valid values", () => {
    const settings = {
      theme: "dark",
      uiScale: 1.25,
      cacheDir: "/Volumes/Movies",
      cacheLimitGb: null,
      hardwareAcceleration: false,
    };

    expect(parseSettingsFile({ version: 1, ...settings }).settings).toEqual(
      settings,
    );
  });

  it("replaces only the bad values, keeping the rest", () => {
    const { settings } = parseSettingsFile({
      version: 1,
      theme: "neon",
      uiScale: 3,
      cacheDir: "videos", // not absolute
      cacheLimitGb: 50,
    });

    expect(settings).toEqual({ ...DEFAULT_SETTINGS, cacheLimitGb: 50 });
  });

  it("keeps what this version can't use: unknown keys and unknown values", () => {
    const loaded = parseSettingsFile({
      version: SETTINGS_VERSION + 3,
      theme: "sepia",
      cacheDir: null,
      subtitleSize: "large",
    });

    expect(loaded.settings.theme).toBe("system");
    expect(loaded.keep).toEqual({ theme: "sepia", subtitleSize: "large" });
    expect(loaded.version).toBe(SETTINGS_VERSION + 3);
  });

  it("runs each migration from the file's version up to the current one", () => {
    const loaded = parseSettingsFile(
      { version: 1, colorScheme: "dark" },
      {
        currentVersion: 3,
        migrations: {
          1: ({ colorScheme, ...rest }) => ({ ...rest, mode: colorScheme }),
          2: ({ mode, ...rest }) => ({ ...rest, theme: mode }),
        },
      },
    );

    expect(loaded.settings.theme).toBe("dark");
    expect(loaded.keep).toEqual({});
    expect(loaded.version).toBe(3);
  });
});

describe("SettingsStore", () => {
  it("starts from the defaults and writes nothing until something changes", () => {
    const store = new SettingsStore(file);

    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(file)).toBe(false);
  });

  it("saves changes, with a version number, and loads them back", () => {
    new SettingsStore(file).update({ theme: "dark", uiScale: 1.1 });

    expect(readSaved()).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "dark",
      uiScale: 1.1,
      version: SETTINGS_VERSION,
    });
    expect(new SettingsStore(file).get()).toMatchObject({
      theme: "dark",
      uiScale: 1.1,
    });
  });

  it("tells listeners about changes, but not about no-op updates", () => {
    const store = new SettingsStore(file);
    const listener = vi.fn();
    const unsubscribe = store.onChange(listener);

    store.update({ theme: "dark" });
    store.update({ theme: "dark" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      ...DEFAULT_SETTINGS,
      theme: "dark",
    });

    unsubscribe();
    store.update({ theme: "light" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("treats an undefined value as no change", () => {
    const store = new SettingsStore(file);
    store.update({ theme: "dark" });

    expect(store.update({ theme: undefined }).theme).toBe("dark");
  });

  it("rejects an invalid value and changes nothing", () => {
    const store = new SettingsStore(file);
    const listener = vi.fn();
    store.onChange(listener);

    expect(() => store.update({ theme: "neon" as Theme })).toThrow();
    expect(() => store.update({ cacheDir: "relative/path" })).toThrow();
    expect(() => store.update({ cacheLimitGb: -5 })).toThrow();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(listener).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it("keeps the old value when the file can't be saved", () => {
    writeFileSync(join(dir, "blocker"), "");
    const store = new SettingsStore(join(dir, "blocker", "settings.json"));
    const listener = vi.fn();
    store.onChange(listener);

    expect(() => store.update({ theme: "dark" })).toThrow();
    expect(store.get().theme).toBe("system");
    expect(listener).not.toHaveBeenCalled();
  });

  it("doesn't erase what a newer Streamy saved, unless the user changes it", () => {
    writeJsonFile(file, {
      version: SETTINGS_VERSION + 1,
      theme: "sepia",
      cacheDir: null,
      subtitleSize: "large",
    });

    const store = new SettingsStore(file);
    store.update({ uiScale: 1.1 });
    expect(readSaved()).toMatchObject({
      version: SETTINGS_VERSION + 1,
      theme: "sepia",
      uiScale: 1.1,
      subtitleSize: "large",
    });

    store.update({ theme: "dark" });
    expect(readSaved()).toMatchObject({ theme: "dark", subtitleSize: "large" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "never overwrites a settings file it couldn't read",
    () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      writeJsonFile(file, { theme: "dark", cacheDir: "/Volumes/Movies" });
      chmodSync(file, 0o000);

      const store = new SettingsStore(file);
      expect(() => store.update({ uiScale: 1.1 })).toThrow("can't be read");

      // Once it can be read again, the change goes on top of what's there.
      chmodSync(file, 0o600);
      store.update({ uiScale: 1.1 });
      expect(readSaved()).toMatchObject({
        theme: "dark",
        cacheDir: "/Volumes/Movies",
        uiScale: 1.1,
      });
    },
  );

  it("resets everything to the defaults", () => {
    const store = new SettingsStore(file);
    store.update({
      theme: "dark",
      cacheDir: "/Volumes/Movies",
      cacheLimitGb: 5,
    });

    expect(store.reset()).toEqual(DEFAULT_SETTINGS);
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS);
  });

  it("returns a frozen object, so nobody changes settings by accident", () => {
    expect(Object.isFrozen(new SettingsStore(file).get())).toBe(true);
  });
});

describe("settingsUpdateSchema (what the UI may send)", () => {
  it("accepts the settings the UI may change", () => {
    const patch = {
      theme: "light",
      uiScale: 0.9,
      cacheLimitGb: 50,
      hardwareAcceleration: false,
    };
    expect(settingsUpdateSchema.parse(patch)).toEqual(patch);
  });

  it.each([
    [{ cacheDir: "/anywhere" }],
    [{ theme: "neon" }],
    [{ uiScale: 2 }],
    [{ cacheLimitGb: 0 }],
    [{ somethingElse: true }],
  ])("rejects %j", (patch: unknown) => {
    expect(settingsUpdateSchema.safeParse(patch).success).toBe(false);
  });
});
