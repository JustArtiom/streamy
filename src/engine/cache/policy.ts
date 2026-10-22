import { logger } from "../lib/logger";
import { clearCache, NOT_OURS } from "./clean";
import { freeSpace as measureFreeSpace } from "./disk-space";
import { planEviction } from "./eviction";
import { CacheDirError, cacheDirState } from "./layout";
import { readTorrentRecord } from "./record";
import { measureTorrents } from "./usage";

/*
 * Keeping the video folder under its size limit (PLAN §4.7), and making
 * room when the disk is almost full. A run:
 *   1. measures what each stored torrent really takes on disk. playback/
 *      and subtitles/ don't count toward the limit: they're temporary (a
 *      session's working files, deleted when it ends), and a long remux
 *      mustn't push the user's videos out to make room for them. (Settings
 *      still counts them in the space used: that's what's on disk.)
 *   2. plans: stored torrents (not in the client) go, least recently used
 *      first, until it fits. While the disk is almost full (downloads are
 *      paused), also until enough is free for downloads to go on
 *      (LOW_DISK_TARGET_BYTES): they're Streamy's own cache, and the
 *      library keeps their history. Active ones are never deleted, so
 *      neither is the one playing;
 *   3. deletes those torrents' data and records (opening one again just
 *      downloads it again). One opened again meanwhile is skipped;
 *   4. still over the limit with only active torrents left: stops their
 *      background downloads (playing goes on) and says so in the log, once.
 *
 * Runs every minute, after a torrent stops, when the limit or the folder
 * changes, and when the disk becomes almost full. "Clear now" goes through
 * here too, so the two never run at the same time. Only the folder in the
 * settings is looked at: torrents left in an old folder aren't Streamy's to
 * manage anymore.
 */

const log = logger.child({ module: "cache-policy" });

/** How often the size limit is checked. */
export const POLICY_INTERVAL_MS = 60_000;

/**
 * While the disk is almost full, stored videos are deleted until this much
 * is free: past the 1.5 GiB where downloads go on again (disk-guard.ts),
 * with room to spare so it isn't needed again a minute later.
 */
export const LOW_DISK_TARGET_BYTES = 2 * 1024 ** 3;

export type CachePolicyDeps = {
  config(): { cacheDir: string; cacheLimitBytes: number | null };
  /** Torrents in the client, with their last use (ms since 1970). */
  activeTorrents(): { infoHash: string; lastActivityAt: number }[];
  /**
   * Deletes a stored torrent's data and record (torrents/service.ts,
   * deleteStoredTorrent). false = it's in use now: nothing was deleted.
   */
  deleteStored(cacheDir: string, infoHash: string): Promise<boolean>;
  stopBackgroundDownload(infoHash: string): void;
  /** Downloads are paused because the disk is almost full (disk-guard.ts). */
  isDiskLow?(): boolean;
  /** Tests: a fake disk. */
  freeSpace?: (dir: string) => Promise<number | null>;
  /** After every run and clear: the free space is measured then. */
  afterRun?(): Promise<unknown>;
};

export type PolicyRun =
  /** Another run (or a clear) was going on. */
  | { status: "skipped" }
  /**
   * Nothing to keep under (no limit, and the disk isn't almost full), or
   * the folder isn't there / isn't Streamy's.
   */
  | { status: "idle" }
  | {
      status: "done";
      evicted: string[];
      usedBytes: number;
      usedBytesAfter: number;
      stillOverLimit: boolean;
    }
  | { status: "failed" };

export type CachePolicy = {
  /** Starts the minute timer. */
  start(): void;
  stop(): void;
  /** One run now, unless one (or a clear) is already going on. */
  run(): Promise<PolicyRun>;
  /**
   * "Clear now": waits for a run to finish, calls `stopEverything` (no run
   * starts meanwhile), then empties the folder. Throws CacheDirError when
   * the folder isn't Streamy's, before stopping anything.
   */
  clear(stopEverything: () => Promise<void>): Promise<void>;
  /** A clear is going on: nothing new should start downloading. */
  isClearing(): boolean;
};

export function createCachePolicy(deps: CachePolicyDeps): CachePolicy {
  const freeSpace = deps.freeSpace ?? measureFreeSpace;
  let timer: NodeJS.Timeout | null = null;
  /** Held by a run or a clear. Never rejects. */
  let busy: Promise<undefined> | null = null;
  let clearing = false;
  /** "Still over the limit" was logged: not again every minute. */
  let overLimitLogged = false;

  /** Takes the lock. Returns its release. */
  function hold(): () => void {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    busy = promise;
    return () => {
      if (busy === promise) busy = null;
      resolve(undefined);
    };
  }

  async function afterRun(): Promise<void> {
    try {
      await deps.afterRun?.();
    } catch (err) {
      log.warn({ err }, "The check after the cache policy failed");
    }
  }

  async function lastUsedAt(
    cacheDir: string,
    infoHash: string,
    newestMtimeMs: number,
  ): Promise<number> {
    // No (usable) record: the last time anything in it changed will do.
    const record = await readTorrentRecord(cacheDir, infoHash);
    return record?.lastUsedAt ?? newestMtimeMs;
  }

  /** How much space to free because the disk is almost full (0 if it isn't). */
  async function bytesToFree(cacheDir: string): Promise<number> {
    if (!deps.isDiskLow?.()) return 0;
    const free = await freeSpace(cacheDir);
    return free === null ? 0 : Math.max(0, LOW_DISK_TARGET_BYTES - free);
  }

  async function evict(): Promise<PolicyRun> {
    const { cacheDir, cacheLimitBytes } = deps.config();
    const mustFreeBytes =
      (await cacheDirState(cacheDir)) === "ok"
        ? await bytesToFree(cacheDir)
        : null;
    if (
      mustFreeBytes === null ||
      (cacheLimitBytes === null && mustFreeBytes === 0)
    ) {
      overLimitLogged = false;
      return { status: "idle" };
    }

    const stored = await measureTorrents(cacheDir);
    const active = new Map(
      deps.activeTorrents().map((t) => [t.infoHash, t.lastActivityAt]),
    );
    const torrents = await Promise.all(
      stored.map(async ({ infoHash, bytes, newestMtimeMs }) => {
        const activeAt = active.get(infoHash);
        return {
          infoHash,
          bytes,
          active: activeAt !== undefined,
          lastUsedAt:
            activeAt ?? (await lastUsedAt(cacheDir, infoHash, newestMtimeMs)),
        };
      }),
    );
    const plan = planEviction({
      torrents,
      limitBytes: cacheLimitBytes,
      mustFreeBytes,
    });

    const evicted: string[] = [];
    for (const infoHash of plan.evict) {
      try {
        // false: opened again while this run measured, it's in use now.
        if (!(await deps.deleteStored(cacheDir, infoHash))) continue;
        evicted.push(infoHash);
        log.info(
          {
            infoHash,
            limitBytes: cacheLimitBytes,
            diskAlmostFull: mustFreeBytes > 0,
          },
          "Deleted the least recently used video to make room",
        );
      } catch (err) {
        log.warn({ err, infoHash }, "Couldn't delete a stored torrent");
      }
    }

    if (plan.stillOverLimit) {
      for (const { infoHash } of deps.activeTorrents()) {
        deps.stopBackgroundDownload(infoHash);
      }
      if (!overLimitLogged) {
        log.warn(
          { usedBytes: plan.usedBytesAfter, limitBytes: cacheLimitBytes },
          "Over the size limit with only active torrents left: background downloads stopped",
        );
      }
    }
    overLimitLogged = plan.stillOverLimit;

    return {
      status: "done",
      evicted,
      usedBytes: plan.usedBytes,
      usedBytesAfter: plan.usedBytesAfter,
      stillOverLimit: plan.stillOverLimit,
    };
  }

  async function run(): Promise<PolicyRun> {
    if (busy) return { status: "skipped" };
    const release = hold();
    let result: PolicyRun;
    try {
      result = await evict();
    } catch (err) {
      log.warn({ err }, "The cache policy run failed");
      result = { status: "failed" };
    } finally {
      release();
    }
    await afterRun();
    return result;
  }

  async function clear(stopEverything: () => Promise<void>): Promise<void> {
    // Wait for a run (or another clear) to finish first.
    while (busy) await busy;
    const release = hold();
    clearing = true;
    try {
      const { cacheDir } = deps.config();
      // Before stopping anything: nothing changes for a folder that isn't
      // Streamy's (stopping everything to then delete nothing helps no one).
      if ((await cacheDirState(cacheDir)) === "unmarked") {
        throw new CacheDirError(NOT_OURS);
      }
      await stopEverything();
      await clearCache(cacheDir);
      overLimitLogged = false;
      log.info("Cleared the video folder");
    } finally {
      clearing = false;
      release();
    }
    await afterRun();
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void run();
      }, POLICY_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    run,
    clear,
    isClearing: () => clearing,
  };
}
