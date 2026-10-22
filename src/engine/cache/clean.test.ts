import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanStartup, clearCache, deleteTorrentData } from "./clean";
import { CACHE_MARKER, CacheDirError, cacheDirState } from "./layout";

const A = "a".repeat(40);
const B = "b".repeat(40);
const isWindows = process.platform === "win32";

let root: string;
let cacheDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "streamy-clean-"));
  cacheDir = join(root, "Cache");
  mkdirSync(cacheDir);
  writeFileSync(join(cacheDir, CACHE_MARKER), "Streamy's");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(relative: string, text = "data"): string {
  const path = join(cacheDir, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const list = (relative = "") => readdirSync(join(cacheDir, relative)).sort();

/** A folder outside the cache that must survive everything. */
function outsideFolder(): string {
  const outside = join(root, "Documents");
  mkdirSync(outside);
  writeFileSync(join(outside, "taxes.pdf"), "precious");
  return outside;
}

describe("cacheDirState", () => {
  it("tells Streamy's folder, a missing one and someone else's apart", async () => {
    expect(await cacheDirState(cacheDir)).toBe("ok");
    expect(await cacheDirState(join(root, "unplugged"))).toBe("missing");
    expect(await cacheDirState(root)).toBe("unmarked");
    expect(await cacheDirState(join(cacheDir, CACHE_MARKER))).toBe("unmarked");
  });
});

describe("cleanStartup", () => {
  it("empties playback/ and subtitles/, and keeps the torrents", async () => {
    put("playback/session-1/seg_00000.m4s");
    put("subtitles/a.vtt");
    put(`torrents/${A}/Sintel.mp4`);
    put(`torrents/${A}.streamy.json`);
    put("not-ours.txt");

    await cleanStartup(cacheDir);

    expect(list()).toEqual([
      CACHE_MARKER,
      "not-ours.txt",
      "playback",
      "subtitles",
      "torrents",
    ]);
    expect(list("playback")).toEqual([]);
    expect(list("subtitles")).toEqual([]);
    expect(list("torrents")).toEqual([A, `${A}.streamy.json`]);
  });

  it("removes records left half-written by a crash, nothing else", async () => {
    put(`torrents/.${A}.streamy.json.4242-0a1b2c3d.tmp`, "{ half");
    put(`torrents/${A}.streamy.json`);
    put("torrents/.hidden-but-not-ours.tmp");

    await cleanStartup(cacheDir);

    expect(list("torrents")).toEqual([
      ".hidden-but-not-ours.tmp",
      `${A}.streamy.json`,
    ]);
  });

  it("refuses a folder that isn't marked as Streamy's", async () => {
    rmSync(join(cacheDir, CACHE_MARKER));
    put("playback/keep.txt");

    await expect(cleanStartup(cacheDir)).rejects.toThrow(CacheDirError);
    expect(list("playback")).toEqual(["keep.txt"]);
  });

  it("does nothing (and creates nothing) when the folder is missing", async () => {
    const unplugged = join(root, "unplugged");

    await cleanStartup(unplugged);

    expect(existsSync(unplugged)).toBe(false);
  });

  it.skipIf(isWindows)(
    "removes a link in place of playback/, not what it points to",
    async () => {
      const outside = outsideFolder();
      symlinkSync(outside, join(cacheDir, "playback"));

      await cleanStartup(cacheDir);

      expect(readFileSync(join(outside, "taxes.pdf"), "utf8")).toBe("precious");
      expect(list("playback")).toEqual([]);
    },
  );
});

describe("clearCache", () => {
  it("deletes what Streamy downloaded, keeping the marker and other files", async () => {
    put(`torrents/${A}/Sintel.mp4`);
    put(`torrents/${A}.streamy.json`);
    put("playback/session-1/seg_00000.m4s");
    put("subtitles/a.vtt");
    put("not-ours.txt", "keep me");
    put("Movies/holiday.mp4", "keep me too");

    await clearCache(cacheDir);

    expect(list()).toEqual([
      CACHE_MARKER,
      "Movies",
      "not-ours.txt",
      "playback",
      "subtitles",
      "torrents",
    ]);
    for (const folder of ["torrents", "playback", "subtitles"]) {
      expect(list(folder)).toEqual([]);
    }
    expect(readFileSync(join(cacheDir, CACHE_MARKER), "utf8")).toBe(
      "Streamy's",
    );
    expect(list("Movies")).toEqual(["holiday.mp4"]);
  });

  it("refuses a folder that isn't marked as Streamy's", async () => {
    rmSync(join(cacheDir, CACHE_MARKER));
    put(`torrents/${A}/Sintel.mp4`);

    await expect(clearCache(cacheDir)).rejects.toThrow(
      "doesn't look like Streamy's video folder",
    );
    expect(list("torrents")).toEqual([A]);
  });

  it("does nothing when the folder is missing", async () => {
    await expect(clearCache(join(root, "unplugged"))).resolves.toBeUndefined();
    expect(existsSync(join(root, "unplugged"))).toBe(false);
  });

  it.skipIf(isWindows)(
    "deletes links inside, never what they point to",
    async () => {
      const outside = outsideFolder();
      mkdirSync(join(cacheDir, "torrents"));
      symlinkSync(outside, join(cacheDir, "torrents", A));

      await clearCache(cacheDir);

      expect(readFileSync(join(outside, "taxes.pdf"), "utf8")).toBe("precious");
      expect(list("torrents")).toEqual([]);
    },
  );
});

describe("deleteTorrentData", () => {
  it("deletes one torrent's folder and record, and nothing else", async () => {
    put(`torrents/${A}/Sintel/Sintel.mp4`);
    put(`torrents/${A}.streamy.json`);
    put(`torrents/${B}/bbb.mp4`);
    put(`torrents/${B}.streamy.json`);

    await deleteTorrentData(cacheDir, A);

    expect(list("torrents")).toEqual([B, `${B}.streamy.json`]);
  });

  it("is fine when there's nothing to delete", async () => {
    await expect(deleteTorrentData(cacheDir, A)).resolves.toBeUndefined();
    await expect(
      deleteTorrentData(join(root, "unplugged"), A),
    ).resolves.toBeUndefined();
  });

  it.each(["..", `../${"a".repeat(37)}`, A.toUpperCase(), "", `${A}/x`])(
    "refuses %j as an info hash",
    async (infoHash) => {
      put(`torrents/${A}/Sintel.mp4`);

      await expect(deleteTorrentData(cacheDir, infoHash)).rejects.toThrow(
        TypeError,
      );
      expect(list("torrents")).toEqual([A]);
      expect(list()).toContain(CACHE_MARKER);
    },
  );

  it("refuses a folder that isn't marked as Streamy's", async () => {
    rmSync(join(cacheDir, CACHE_MARKER));
    put(`torrents/${A}/Sintel.mp4`);

    await expect(deleteTorrentData(cacheDir, A)).rejects.toThrow(CacheDirError);
    expect(list("torrents")).toEqual([A]);
  });
});
