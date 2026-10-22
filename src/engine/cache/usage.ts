import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isInfoHash } from "../lib/info-hash";
import {
  CACHE_CONTENT_DIRS,
  isGone,
  RECORD_SUFFIX,
  TORRENTS_DIR,
} from "./layout";

// How much disk space the video folder really takes. A torrent's files are
// created at full length but only filled as pieces arrive ("sparse" files),
// so a half-downloaded "4 GB" film may take 1 GB: what counts is the blocks
// actually used on disk, not the length.

export interface DiskUsage {
  /** Space really used on disk. */
  bytes: number;
  /** Newest modification time of anything inside (ms since 1970). */
  newestMtimeMs: number;
}

export interface TorrentUsage extends DiskUsage {
  infoHash: string;
}

const NOTHING: DiskUsage = { bytes: 0, newestMtimeMs: 0 };

/** Space a file takes on disk. Windows reports no blocks: use the length. */
function allocatedBytes(stats: Stats): number {
  return stats.blocks > 0 ? stats.blocks * 512 : stats.size;
}

function combine(a: DiskUsage, b: DiskUsage): DiskUsage {
  return {
    bytes: a.bytes + b.bytes,
    newestMtimeMs: Math.max(a.newestMtimeMs, b.newestMtimeMs),
  };
}

/**
 * Usage of a file or folder (and everything in it). Links are never
 * followed: they could point anywhere, and aren't Streamy's. Things that
 * vanish while counting (a session ending, a torrent being deleted) are
 * skipped; other errors (e.g. no permission) are thrown.
 */
export async function diskUsage(path: string): Promise<DiskUsage> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isGone(error)) return NOTHING;
    throw error;
  }
  if (stats.isFile()) {
    return { bytes: allocatedBytes(stats), newestMtimeMs: stats.mtimeMs };
  }
  // Links, sockets…: not counted.
  if (!stats.isDirectory()) return NOTHING;

  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if (isGone(error)) return NOTHING;
    throw error;
  }
  const inside = await Promise.all(
    names.map((name) => diskUsage(join(path, name))),
  );
  // Folders themselves aren't counted (as in main's cacheUsage), but their
  // time is: it changes when files are added or removed.
  return inside.reduce(combine, { bytes: 0, newestMtimeMs: stats.mtimeMs });
}

/**
 * Usage per torrent in `<cacheDir>/torrents`: its data folder plus its
 * record file. Anything else in there is ignored. [] when the folder doesn't
 * exist. Sorted by info hash.
 */
export async function measureTorrents(
  cacheDir: string,
): Promise<TorrentUsage[]> {
  const torrentsDir = join(cacheDir, TORRENTS_DIR);
  let names: string[];
  try {
    names = await readdir(torrentsDir);
  } catch (error) {
    if (isGone(error)) return [];
    throw error;
  }

  const infoHashes = new Set<string>();
  for (const name of names) {
    const infoHash = name.endsWith(RECORD_SUFFIX)
      ? name.slice(0, -RECORD_SUFFIX.length)
      : name;
    if (isInfoHash(infoHash)) infoHashes.add(infoHash);
  }

  const usages = await Promise.all(
    [...infoHashes].sort().map(async (infoHash) => {
      const [data, record] = await Promise.all([
        diskUsage(join(torrentsDir, infoHash)),
        diskUsage(join(torrentsDir, `${infoHash}${RECORD_SUFFIX}`)),
      ]);
      return { infoHash, ...combine(data, record) };
    }),
  );
  // Both vanished while counting: it's gone.
  return usages.filter((usage) => usage.newestMtimeMs > 0);
}

/**
 * Space used by Streamy's three folders (torrents, playback, subtitles).
 * Nothing else in the folder counts. 0 when the folder doesn't exist.
 */
export async function measureCache(cacheDir: string): Promise<number> {
  const usages = await Promise.all(
    CACHE_CONTENT_DIRS.map((name) => diskUsage(join(cacheDir, name))),
  );
  return usages.reduce((total, usage) => total + usage.bytes, 0);
}
