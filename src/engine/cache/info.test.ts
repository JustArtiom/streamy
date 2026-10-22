import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCacheInfo } from "./info";
import { CACHE_MARKER, torrentDataDir } from "./layout";

const A = "a".repeat(40);
const GB = 1024 ** 3;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "streamy-info-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("getCacheInfo", () => {
  it("describes the folder for Settings → Storage", async () => {
    const cacheDir = join(root, "Cache");
    mkdirSync(torrentDataDir(cacheDir, A), { recursive: true });
    writeFileSync(join(cacheDir, CACHE_MARKER), "");
    writeFileSync(
      join(torrentDataDir(cacheDir, A), "film.mkv"),
      "x".repeat(5000),
    );

    const info = await getCacheInfo(cacheDir, 20 * GB);

    expect(info).toMatchObject({
      dir: cacheDir,
      exists: true,
      limitBytes: 20 * GB,
    });
    expect(info.usedBytes).toBeGreaterThanOrEqual(5000);
    expect(info.freeBytes).toBeGreaterThan(0);
    expect(info.lowDiskSpace).toBe(
      info.freeBytes !== null && info.freeBytes < GB,
    );
  });

  it("says when the folder is gone", async () => {
    const unplugged = join(root, "unplugged");

    expect(await getCacheInfo(unplugged, null)).toEqual({
      dir: unplugged,
      exists: false,
      usedBytes: 0,
      limitBytes: null,
      freeBytes: null,
      lowDiskSpace: false,
    });
  });
});
