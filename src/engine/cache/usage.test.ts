import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_MARKER } from "./layout";
import { diskUsage, measureCache, measureTorrents } from "./usage";

const A = "a".repeat(40);
const B = "b".repeat(40);
const MB = 1024 * 1024;

// Windows reports no block counts (sizes are used there), and making links
// needs extra rights.
const isWindows = process.platform === "win32";

let root: string;
let cacheDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "streamy-usage-"));
  cacheDir = join(root, "Cache");
  mkdirSync(join(cacheDir, "torrents"), { recursive: true });
  writeFileSync(join(cacheDir, CACHE_MARKER), "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFile(path: string, bytes: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
}

/** Sets a file's or folder's modification time (ms since 1970). */
function touch(path: string, ms: number): void {
  utimesSync(path, ms / 1000, ms / 1000);
}

describe("diskUsage", () => {
  it.skipIf(isWindows)(
    "counts the blocks really used, not the length of a half-downloaded file",
    async () => {
      // How WebTorrent fills a file: pieces written at their offsets.
      const film = join(root, "film.mkv");
      const fd = openSync(film, "w");
      writeSync(fd, Buffer.alloc(64 * 1024, 1), 0, 64 * 1024, 500 * MB);
      closeSync(fd);

      const { bytes } = await diskUsage(film);

      expect(bytes).toBeGreaterThanOrEqual(64 * 1024);
      expect(bytes).toBeLessThan(MB);
    },
  );

  it("adds up files in nested folders", async () => {
    writeFile(join(root, "t", "a.bin"), 10_000);
    writeFile(join(root, "t", "sub", "b.bin"), 20_000);

    const { bytes } = await diskUsage(join(root, "t"));

    expect(bytes).toBeGreaterThanOrEqual(30_000);
    expect(bytes).toBeLessThan(30_000 + 64 * 1024);
  });

  it("is zero for something that isn't there", async () => {
    expect(await diskUsage(join(root, "nothing"))).toEqual({
      bytes: 0,
      newestMtimeMs: 0,
    });
  });

  it.skipIf(isWindows)("never follows links", async () => {
    writeFile(join(root, "outside", "big.bin"), 5 * MB);
    mkdirSync(join(root, "t"));
    symlinkSync(join(root, "outside"), join(root, "t", "folder-link"));
    symlinkSync(join(root, "outside", "big.bin"), join(root, "t", "file-link"));

    expect((await diskUsage(join(root, "t"))).bytes).toBe(0);
    expect((await diskUsage(join(root, "t", "folder-link"))).bytes).toBe(0);
  });
});

describe("measureTorrents", () => {
  const torrents = () => join(cacheDir, "torrents");

  it("measures each torrent: its folder and its record", async () => {
    writeFile(join(torrents(), A, "Sintel", "Sintel.mp4"), 100_000);
    writeFile(join(torrents(), `${A}.streamy.json`), 100);
    writeFile(join(torrents(), B, "bbb.mp4"), 10_000);

    const usage = await measureTorrents(cacheDir);

    expect(usage.map((torrent) => torrent.infoHash)).toEqual([A, B]);
    expect(usage[0]?.bytes).toBeGreaterThanOrEqual(100_100);
    expect(usage[1]?.bytes).toBeGreaterThanOrEqual(10_000);
    expect(usage[1]?.bytes).toBeLessThan(100_000);
  });

  it("gives the newest modification time of anything in it", async () => {
    const film = join(torrents(), A, "Sintel", "Sintel.mp4");
    writeFile(film, 1000);
    const record = join(torrents(), `${A}.streamy.json`);
    writeFile(record, 10);
    touch(film, Date.UTC(2026, 2, 1));
    touch(record, Date.UTC(2026, 1, 1));
    touch(join(torrents(), A, "Sintel"), Date.UTC(2026, 0, 1));
    touch(join(torrents(), A), Date.UTC(2026, 0, 1));

    const [usage] = await measureTorrents(cacheDir);

    expect(usage?.newestMtimeMs).toBe(Date.UTC(2026, 2, 1));
  });

  it("lists a record whose folder is gone, so it can be cleaned up", async () => {
    writeFile(join(torrents(), `${A}.streamy.json`), 100);

    const usage = await measureTorrents(cacheDir);

    expect(usage.map((torrent) => torrent.infoHash)).toEqual([A]);
  });

  it("ignores everything else in torrents/", async () => {
    writeFile(join(torrents(), "not-a-hash", "x.bin"), 1000);
    writeFile(join(torrents(), A.toUpperCase(), "x.bin"), 1000);
    writeFile(join(torrents(), `.${A}.streamy.json.1-ab.tmp`), 10);
    writeFile(join(torrents(), "notes.txt"), 10);

    expect(await measureTorrents(cacheDir)).toEqual([]);
  });

  it.skipIf(isWindows)(
    "doesn't follow a link in place of a torrent",
    async () => {
      writeFile(join(root, "outside", "big.bin"), 5 * MB);
      symlinkSync(join(root, "outside"), join(torrents(), A));

      expect(await measureTorrents(cacheDir)).toEqual([]);
    },
  );

  it("is empty when there's no torrents folder (or no video folder)", async () => {
    rmSync(torrents(), { recursive: true });

    expect(await measureTorrents(cacheDir)).toEqual([]);
    expect(await measureTorrents(join(root, "unplugged"))).toEqual([]);
  });
});

describe("measureCache", () => {
  it("counts only Streamy's three folders", async () => {
    writeFile(join(cacheDir, "torrents", A, "film.mkv"), 10_000);
    writeFile(join(cacheDir, "playback", "s1", "seg_00000.m4s"), 10_000);
    writeFile(join(cacheDir, "subtitles", "x.vtt"), 10_000);
    writeFile(join(cacheDir, "not-ours.mkv"), 5 * MB);

    const bytes = await measureCache(cacheDir);

    expect(bytes).toBeGreaterThanOrEqual(30_000);
    expect(bytes).toBeLessThan(MB);
  });

  it("is 0 when the folder isn't there", async () => {
    expect(await measureCache(join(root, "unplugged"))).toBe(0);
  });
});
