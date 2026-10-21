import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_MARKER,
  CACHE_SUBFOLDER,
  CacheDirError,
  cacheUsage,
  clearCache,
  defaultCacheDir,
  ensureDefaultCacheDir,
  isProtectedFolder,
  prepareCacheDir,
} from "./cache-dir";

let root: string;
/** Stands in for the user's Downloads folder. */
let downloads: string;
const prepare = (chosen: string) =>
  prepareCacheDir(chosen, { protectedDirs: [downloads] });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "streamy-cache-"));
  downloads = join(root, "Downloads");
  mkdirSync(downloads);
});

afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

const isMarked = (dir: string) => existsSync(join(dir, CACHE_MARKER));

describe("defaultCacheDir", () => {
  it("uses ~/Library/Caches on macOS", () => {
    expect(
      defaultCacheDir({
        platform: "darwin",
        home: "/Users/sam",
        env: {},
        name: "Streamy",
      }),
    ).toBe("/Users/sam/Library/Caches/Streamy");
  });

  it("uses Local (never Roaming) AppData on Windows, with Windows paths", () => {
    expect(
      defaultCacheDir({
        platform: "win32",
        home: "C:\\Users\\sam",
        env: {
          LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
          APPDATA: "C:\\Users\\sam\\AppData\\Roaming",
        },
        name: "Streamy",
      }),
    ).toBe("C:\\Users\\sam\\AppData\\Local\\Streamy\\Cache");
  });

  it("follows XDG_CACHE_HOME on Linux, with a lowercase folder name", () => {
    expect(
      defaultCacheDir({
        platform: "linux",
        home: "/home/sam",
        env: { XDG_CACHE_HOME: "/data/cache" },
        name: "Streamy Dev",
      }),
    ).toBe("/data/cache/streamy-dev");
  });

  it("ignores a relative XDG_CACHE_HOME, as the XDG spec says", () => {
    expect(
      defaultCacheDir({
        platform: "linux",
        home: "/home/sam",
        env: { XDG_CACHE_HOME: "cache" },
        name: "Streamy",
      }),
    ).toBe("/home/sam/.cache/streamy");
  });
});

describe("prepareCacheDir", () => {
  it("uses a brand new folder as is, and marks it as Streamy's", () => {
    const chosen = join(root, "new", "place");

    expect(prepare(chosen)).toBe(chosen);
    expect(isMarked(chosen)).toBe(true);
  });

  it("uses an empty folder as is (files the OS adds don't count)", () => {
    const chosen = join(root, "Videos");
    mkdirSync(chosen);
    writeFileSync(join(chosen, ".DS_Store"), "");

    expect(prepare(chosen)).toBe(chosen);
  });

  it("never takes over the user's own folders, even when empty", () => {
    // macOS keeps a hidden .localized file in Downloads, Desktop…
    writeFileSync(join(downloads, ".localized"), "");

    const dir = prepare(downloads);

    expect(dir).toBe(join(downloads, CACHE_SUBFOLDER));
    expect(isMarked(downloads)).toBe(false);
  });

  it("makes a Streamy folder inside a folder that has other files", () => {
    const chosen = join(root, "Movies");
    mkdirSync(chosen);
    writeFileSync(join(chosen, "holiday.mp4"), "");

    const dir = prepare(chosen);

    expect(dir).toBe(join(chosen, CACHE_SUBFOLDER));
    expect(isMarked(dir)).toBe(true);
    expect(isMarked(chosen)).toBe(false);
    expect(readdirSync(chosen).sort()).toEqual([
      CACHE_SUBFOLDER,
      "holiday.mp4",
    ]);
  });

  it("reuses a folder that's already Streamy's, even with videos in it", () => {
    const chosen = join(root, "Videos");
    prepare(chosen);
    writeFileSync(join(chosen, "movie.mkv"), "");

    expect(prepare(chosen)).toBe(chosen);
  });

  it("refuses when that Streamy folder has someone else's files", () => {
    const chosen = join(root, "Movies");
    mkdirSync(join(chosen, CACHE_SUBFOLDER), { recursive: true });
    writeFileSync(join(chosen, "holiday.mp4"), "");
    writeFileSync(join(chosen, CACHE_SUBFOLDER, "notes.txt"), "");

    expect(() => prepare(chosen)).toThrow("already a");
    expect(isMarked(join(chosen, CACHE_SUBFOLDER))).toBe(false);
  });

  it("explains when there's a file called Streamy in the way", () => {
    const chosen = join(root, "Movies");
    mkdirSync(chosen);
    writeFileSync(join(chosen, CACHE_SUBFOLDER), "");

    expect(() => prepare(chosen)).toThrow(`can't use the "${CACHE_SUBFOLDER}"`);
  });

  it("refuses a relative path", () => {
    expect(() => prepare("videos")).toThrow(CacheDirError);
  });

  it("refuses a file", () => {
    const file = join(root, "movie.mkv");
    writeFileSync(file, "");

    expect(() => prepare(file)).toThrow("can't open");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "explains when it can't write there",
    () => {
      const chosen = join(root, "ReadOnly");
      mkdirSync(chosen);
      chmodSync(chosen, 0o500);

      expect(() => prepare(chosen)).toThrow("can't save files");
      chmodSync(chosen, 0o700);
    },
  );
});

describe("isProtectedFolder", () => {
  it("protects a drive root", () => {
    expect(isProtectedFolder(parse(root).root, [])).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")(
    "protects an external drive on macOS",
    () => {
      expect(isProtectedFolder("/Volumes/Backup", [])).toBe(true);
    },
  );

  it("protects the user's own folders", () => {
    expect(
      isProtectedFolder("/Users/sam/Downloads", ["/Users/sam/Downloads"]),
    ).toBe(true);
  });

  it("allows other folders", () => {
    expect(
      isProtectedFolder("/Users/sam/Streamy Videos", ["/Users/sam/Downloads"]),
    ).toBe(false);
  });
});

describe("cacheUsage", () => {
  it("counts only what Streamy downloaded", async () => {
    const dir = join(root, "Cache");
    ensureDefaultCacheDir(dir);
    mkdirSync(join(dir, "torrents", "abc"), { recursive: true });
    writeFileSync(
      join(dir, "torrents", "abc", "movie.mkv"),
      "x".repeat(10_000),
    );
    writeFileSync(join(dir, "not-ours.txt"), "x".repeat(50_000));

    const usage = await cacheUsage(dir);

    expect(usage.status).toBe("ok");
    if (usage.status !== "ok") return;
    expect(usage.bytes).toBeGreaterThanOrEqual(10_000);
    expect(usage.bytes).toBeLessThan(50_000);
  });

  it("says when the folder isn't there", async () => {
    expect(await cacheUsage(join(root, "unplugged"))).toEqual({
      status: "missing",
    });
  });
});

describe("clearCache", () => {
  it("deletes only Streamy's own folders", async () => {
    const dir = join(root, "Cache");
    ensureDefaultCacheDir(dir);
    for (const name of ["torrents", "playback", "subtitles"]) {
      mkdirSync(join(dir, name, "x"), { recursive: true });
      writeFileSync(join(dir, name, "x", "file"), "data");
    }
    writeFileSync(join(dir, "not-ours.txt"), "keep me");

    await clearCache(dir);

    expect(readdirSync(dir).sort()).toEqual([CACHE_MARKER, "not-ours.txt"]);
  });

  it("refuses a folder that isn't marked as Streamy's", async () => {
    const dir = join(root, "Somewhere");
    mkdirSync(join(dir, "torrents"), { recursive: true });

    await expect(clearCache(dir)).rejects.toThrow(CacheDirError);
    expect(existsSync(join(dir, "torrents"))).toBe(true);
  });

  it("does nothing when the folder doesn't exist yet", async () => {
    await expect(clearCache(join(root, "nothing"))).resolves.toBeUndefined();
  });
});
