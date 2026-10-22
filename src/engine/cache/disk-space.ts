import { statfs } from "node:fs/promises";

/** Under this much free space, downloading pauses ("Your disk is almost full"). */
export const LOW_DISK_BYTES = 1024 ** 3;

/**
 * Free space for Streamy on the disk holding `dir`: the space a normal user
 * may use (`bavail`), not counting what's reserved for the system. null when
 * it can't be told (folder missing, unsupported file system).
 */
export async function freeSpace(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    const free = stats.bavail * stats.bsize;
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    // Unknown is a fine answer here: callers treat it as "not low".
    return null;
  }
}

/** Unknown free space doesn't count as low: never pause on a guess. */
export function isLowDisk(freeBytes: number | null): boolean {
  return freeBytes !== null && freeBytes < LOW_DISK_BYTES;
}
