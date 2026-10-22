import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteTorrentData } from "./clean";
import { CACHE_MARKER, torrentDataDir } from "./layout";
import {
  type CachePolicyDeps,
  createCachePolicy,
  LOW_DISK_TARGET_BYTES,
} from "./policy";
import { writeTorrentRecord } from "./record";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const DAY = 86_400_000;
const KB = 1024;

let root: string;
let cacheDir: string;
let limit: number | null;
let active: { infoHash: string; lastActivityAt: number }[];
let stopBackgroundDownload: ReturnType<typeof vi.fn<(h: string) => void>>;
let afterRun: ReturnType<typeof vi.fn<() => Promise<unknown>>>;

/** A torrent in the folder: `kb` KB of data, last used on `day`. */
async function store(infoHash: string, kb: number, day: number | null) {
  const dir = torrentDataDir(cacheDir, infoHash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "movie.mkv"), Buffer.alloc(kb * KB, 1));
  if (day !== null) {
    await writeTorrentRecord(cacheDir, infoHash, {
      name: infoHash.slice(0, 4),
      addedAt: day * DAY,
      lastUsedAt: day * DAY,
      bitfield: null,
    });
  }
}

function policy(overrides: Partial<CachePolicyDeps> = {}) {
  return createCachePolicy({
    config: () => ({ cacheDir, cacheLimitBytes: limit }),
    activeTorrents: () => active,
    // Like the torrent service: never one that's active.
    deleteStored: async (dir, infoHash) => {
      if (active.some((t) => t.infoHash === infoHash)) return false;
      await deleteTorrentData(dir, infoHash);
      return true;
    },
    stopBackgroundDownload,
    afterRun,
    ...overrides,
  });
}

const stored = () =>
  readdirSync(join(cacheDir, "torrents")).filter((n) => !n.includes("."));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "streamy-policy-"));
  cacheDir = join(root, "Streamy");
  mkdirSync(cacheDir);
  writeFileSync(join(cacheDir, CACHE_MARKER), "");
  limit = null;
  active = [];
  stopBackgroundDownload = vi.fn<(h: string) => void>();
  afterRun = vi.fn<() => Promise<unknown>>(() => Promise.resolve());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a policy run", () => {
  it("does nothing without a limit, but still checks the disk", async () => {
    await store(A, 64, 1);

    expect(await policy().run()).toEqual({ status: "idle" });
    expect(stored()).toEqual([A]);
    expect(afterRun).toHaveBeenCalledTimes(1);
  });

  it("deletes stored torrents, least recently used first, until it fits", async () => {
    await store(A, 64, 3);
    await store(B, 64, 1); // oldest
    await store(C, 64, 2);
    limit = 100 * KB; // room for one (64 KB + its record's block)

    const result = await policy().run();

    expect(result).toMatchObject({
      status: "done",
      evicted: [B, C],
      stillOverLimit: false,
    });
    expect(stored()).toEqual([A]);
    // The records went too.
    expect(existsSync(join(cacheDir, "torrents", `${B}.streamy.json`))).toBe(
      false,
    );
  });

  it("never deletes an active torrent (the one playing is always active)", async () => {
    await store(A, 64, 1);
    await store(B, 64, 2);
    active = [{ infoHash: A, lastActivityAt: 0 }];
    limit = 1;

    const result = await policy().run();

    expect(result).toMatchObject({ evicted: [B], stillOverLimit: true });
    expect(stored()).toEqual([A]);
  });

  it("with only active torrents left over the limit, stops their background downloads, logging once", async () => {
    await store(A, 64, 1);
    active = [{ infoHash: A, lastActivityAt: 0 }];
    limit = 1;
    const cache = policy();

    await cache.run();
    await cache.run();

    expect(stopBackgroundDownload).toHaveBeenCalledWith(A);
    expect(stored()).toEqual([A]);
  });

  it("uses the files' age for a torrent without a record", async () => {
    await store(A, 64, null); // modified just now
    await store(B, 64, 1);
    limit = 100 * KB;

    expect(await policy().run()).toMatchObject({ evicted: [B] });
  });

  it("doesn't count playback/ and subtitles/ (temporary) toward the limit", async () => {
    await store(A, 64, 1);
    mkdirSync(join(cacheDir, "playback", "session"), { recursive: true });
    writeFileSync(
      join(cacheDir, "playback", "session", "seg"),
      Buffer.alloc(64 * KB),
    );
    limit = 100 * KB;

    expect(await policy().run()).toMatchObject({ evicted: [] });
    expect(stored()).toEqual([A]);
  });

  it("skips a torrent opened again while it measured", async () => {
    await store(A, 64, 1);
    await store(B, 64, 2);
    limit = 1;
    // The torrent service says no: A is being opened right now.
    const result = await policy({
      deleteStored: async (dir, infoHash) => {
        if (infoHash === A) return false;
        await deleteTorrentData(dir, infoHash);
        return true;
      },
    }).run();

    expect(result).toMatchObject({ evicted: [B] });
    expect(stored()).toEqual([A]);
  });

  it("leaves a missing folder or one that isn't Streamy's alone", async () => {
    await store(A, 64, 1);
    limit = 1;
    rmSync(join(cacheDir, CACHE_MARKER));

    expect(await policy().run()).toEqual({ status: "idle" });
    expect(stored()).toEqual([A]);

    cacheDir = join(root, "unplugged");
    expect(await policy().run()).toEqual({ status: "idle" });
    expect(existsSync(cacheDir)).toBe(false);
  });

  it("only looks at the folder in the settings (an old one is left alone)", async () => {
    await store(A, 64, 1);
    limit = 1;
    const old = cacheDir;
    cacheDir = join(root, "New");
    mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, CACHE_MARKER), "");

    expect(await policy().run()).toMatchObject({ status: "done", evicted: [] });
    expect(readdirSync(join(old, "torrents"))).toContain(A);
  });

  it("runs one at a time: a second one meanwhile is skipped", async () => {
    await store(A, 64, 1);
    limit = 1;
    const cache = policy();

    const [first, second] = await Promise.all([cache.run(), cache.run()]);

    expect(first.status).toBe("done");
    expect(second).toEqual({ status: "skipped" });
  });

  it("deletes the oldest stored videos while the disk is almost full, even without a limit", async () => {
    await store(A, 64, 3);
    await store(B, 64, 1); // oldest
    await store(C, 64, 2);
    active = [{ infoHash: A, lastActivityAt: 0 }];
    const free = LOW_DISK_TARGET_BYTES - 50 * KB;

    const result = await policy({
      isDiskLow: () => true,
      freeSpace: () => Promise.resolve(free),
    }).run();

    // 50 KB short of the target: one 64 KB video does it.
    expect(result).toMatchObject({ status: "done", evicted: [B] });
    expect(stored()).toEqual([A, C]);
  });

  it("deletes nothing for the disk once enough is free again, or when it's unknown", async () => {
    await store(A, 64, 1);

    for (const free of [LOW_DISK_TARGET_BYTES, null]) {
      const result = await policy({
        isDiskLow: () => true,
        freeSpace: () => Promise.resolve(free),
      }).run();
      expect(result).toEqual({ status: "idle" });
    }
    // Not low (downloads not paused): the free space isn't even looked at.
    const freeSpace = vi.fn(() => Promise.resolve(0));
    expect(await policy({ isDiskLow: () => false, freeSpace }).run()).toEqual({
      status: "idle",
    });
    expect(freeSpace).not.toHaveBeenCalled();
    expect(stored()).toEqual([A]);
  });

  it("survives a failing check afterwards", async () => {
    afterRun.mockRejectedValue(new Error("statfs failed"));
    expect(await policy().run()).toEqual({ status: "idle" });
  });
});

describe("clear", () => {
  it("stops everything first, then empties the folder (keeping the marker)", async () => {
    await store(A, 64, 1);
    mkdirSync(join(cacheDir, "subtitles", A), { recursive: true });
    const order: string[] = [];
    const cache = policy();

    await cache.clear(() => {
      order.push(`stop (clearing: ${String(cache.isClearing())})`);
      return Promise.resolve();
    });

    expect(order).toEqual(["stop (clearing: true)"]);
    expect(cache.isClearing()).toBe(false);
    expect(stored()).toEqual([]);
    expect(readdirSync(join(cacheDir, "subtitles"))).toEqual([]);
    expect(existsSync(join(cacheDir, CACHE_MARKER))).toBe(true);
    expect(afterRun).toHaveBeenCalled();
  });

  it("waits for a run to finish, and no run starts while it clears", async () => {
    await store(A, 64, 1);
    limit = 1;
    const cache = policy();

    const running = cache.run();
    let duringClear: unknown;
    const clearing = cache.clear(async () => {
      duringClear = await cache.run();
    });
    const [run] = await Promise.all([running, clearing]);

    expect(run.status).toBe("done");
    expect(duringClear).toEqual({ status: "skipped" });
  });

  it("refuses a folder that isn't Streamy's, before stopping anything", async () => {
    rmSync(join(cacheDir, CACHE_MARKER));
    const stopEverything = vi.fn(() => Promise.resolve());
    const cache = policy();

    await expect(cache.clear(stopEverything)).rejects.toThrow(
      "doesn't look like Streamy's video folder",
    );
    expect(stopEverything).not.toHaveBeenCalled();
    expect(cache.isClearing()).toBe(false);
  });
});

describe("the timer", () => {
  it("runs every minute until stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cache = policy();
    cache.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(afterRun).toHaveBeenCalledTimes(1);
    });
    cache.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(afterRun).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
