import { stat } from "node:fs/promises";
import type { CacheInfo } from "../../shared/engine-api";
import { freeSpace, isLowDisk } from "./disk-space";
import { isGone } from "./layout";
import { measureCache } from "./usage";

/** GET /v1/cache: what Settings → Storage shows. */
export async function getCacheInfo(
  cacheDir: string,
  limitBytes: number | null,
): Promise<CacheInfo> {
  const exists = await isFolder(cacheDir);
  const freeBytes = exists ? await freeSpace(cacheDir) : null;
  return {
    dir: cacheDir,
    exists,
    usedBytes: exists ? await measureCache(cacheDir) : 0,
    limitBytes,
    freeBytes,
    lowDiskSpace: isLowDisk(freeBytes),
  };
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isGone(error)) return false;
    throw error;
  }
}
