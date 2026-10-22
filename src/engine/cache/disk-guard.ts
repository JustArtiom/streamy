import { logger } from "../lib/logger";
import { freeSpace as measureFreeSpace, LOW_DISK_BYTES } from "./disk-space";

/*
 * The free-space guard (PLAN §4.7): under 1 GiB free on the video folder's
 * disk, downloading pauses ("Your disk is almost full") so a torrent never
 * fills the disk to the last byte (WebTorrent fails the torrent when a write
 * fails). It starts again above 1.5 GiB: the gap stops it flapping on and off
 * around one number as pieces land and other programs write.
 *
 * Measured with every cache policy run, and every 15 s while something is
 * downloading (or downloads are paused, to notice the space coming back).
 */

const log = logger.child({ module: "disk-guard" });

/** Downloading starts again once this much is free. */
export const RESUME_FREE_BYTES = 1.5 * 1024 ** 3;
/** How often the space is measured while something downloads. */
export const DISK_CHECK_MS = 15_000;

export type DiskGuardDeps = {
  cacheDir(): string;
  /** Something is downloading: worth measuring every 15 s. */
  isDownloading(): boolean;
  /** Pauses (true) or resumes (false) every download. */
  setPaused(paused: boolean): void;
  /** Tests: a fake disk. */
  freeSpace?: (dir: string) => Promise<number | null>;
};

export type DiskGuard = {
  /** Starts the 15 s timer. */
  start(): void;
  stop(): void;
  /** Measures now and pauses/resumes as needed. Returns isLow(). */
  check(): Promise<boolean>;
  /** Downloading is paused because the disk is almost full. */
  isLow(): boolean;
};

/** Whether downloads should be paused, given the state now and the free space. */
export function shouldPause(
  pausedNow: boolean,
  freeBytes: number | null,
): boolean {
  // Unknown (folder unplugged, odd file system): never pause on a guess.
  if (freeBytes === null) return false;
  return freeBytes < (pausedNow ? RESUME_FREE_BYTES : LOW_DISK_BYTES);
}

export function createDiskGuard(deps: DiskGuardDeps): DiskGuard {
  const freeSpace = deps.freeSpace ?? measureFreeSpace;
  let low = false;
  let timer: NodeJS.Timeout | null = null;
  let checking: Promise<boolean> | null = null;

  async function measure(): Promise<boolean> {
    const dir = deps.cacheDir();
    const free = await freeSpace(dir);
    const next = shouldPause(low, free);
    if (next !== low) {
      low = next;
      deps.setPaused(next);
      if (next) {
        log.warn(
          { dir, freeBytes: free },
          "Disk almost full: downloads paused",
        );
      } else {
        log.info({ dir, freeBytes: free }, "Disk space is back: downloading");
      }
    }
    return low;
  }

  function check(): Promise<boolean> {
    checking ??= measure()
      .catch((err: unknown) => {
        log.warn({ err }, "Couldn't check the free disk space");
        return low;
      })
      .finally(() => {
        checking = null;
      });
    return checking;
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        // While paused too: that's how it notices the space coming back.
        if (low || deps.isDownloading()) void check();
      }, DISK_CHECK_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    check,
    isLow: () => low,
  };
}
