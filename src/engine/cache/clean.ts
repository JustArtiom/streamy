import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CACHE_CONTENT_DIRS,
  CacheDirError,
  cacheDirState,
  isGone,
  PLAYBACK_DIR,
  SUBTITLES_DIR,
  TORRENTS_DIR,
  torrentDataDir,
  torrentRecordFile,
} from "./layout";
import { isRecordTempFile } from "./record";

// Deleting things in the video folder. Every function here first checks the
// folder is Streamy's (the marker), and only ever deletes inside
// torrents/, playback/ and subtitles/. A missing folder (e.g. an unplugged
// drive) means there's nothing to delete, which isn't an error.

/**
 * `rm` retries for a while when Windows says a file is busy (EBUSY, EPERM:
 * antivirus, indexing, a video still closing), instead of failing at once.
 * `rm` never follows links: it deletes the link, not what it points to.
 */
const RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
} as const;

/** Why nothing was deleted from a folder without Streamy's marker. */
export const NOT_OURS =
  "This doesn't look like Streamy's video folder, so nothing was deleted.";

/** false when the folder is missing; throws when it isn't Streamy's. */
async function isOurs(cacheDir: string): Promise<boolean> {
  const state = await cacheDirState(cacheDir);
  if (state === "unmarked") throw new CacheDirError(NOT_OURS);
  return state === "ok";
}

/** Deletes a folder's contents (a link in its place is just removed). */
async function emptyFolder(dir: string): Promise<void> {
  await rm(dir, RM_OPTIONS);
  await mkdir(dir, { recursive: true });
}

/**
 * At engine start: empties playback/ and subtitles/ (leftovers of the last
 * run, which only made sense to its sessions) and removes half-written
 * record files. torrents/ is kept: that's the point of a cache.
 */
export async function cleanStartup(cacheDir: string): Promise<void> {
  if (!(await isOurs(cacheDir))) return;
  await emptyFolder(join(cacheDir, PLAYBACK_DIR));
  await emptyFolder(join(cacheDir, SUBTITLES_DIR));
  await removeRecordTempFiles(join(cacheDir, TORRENTS_DIR));
}

async function removeRecordTempFiles(torrentsDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(torrentsDir);
  } catch (error) {
    if (isGone(error)) return;
    throw error;
  }
  for (const name of names.filter(isRecordTempFile)) {
    await rm(join(torrentsDir, name), RM_OPTIONS);
  }
}

/**
 * "Clear now": deletes everything Streamy downloaded (its three folders'
 * contents). Stop every torrent and playback first. The marker and anything
 * else in the folder stay; so does the library (it lives elsewhere).
 */
export async function clearCache(cacheDir: string): Promise<void> {
  if (!(await isOurs(cacheDir))) return;
  for (const name of CACHE_CONTENT_DIRS) {
    await emptyFolder(join(cacheDir, name));
  }
}

/**
 * Deletes one torrent's data and record. The record goes first: data
 * without a record is just re-checked on its next start, while a record
 * without its data would claim pieces that aren't there (WebTorrent's spot
 * check would catch that, but more slowly).
 */
export async function deleteTorrentData(
  cacheDir: string,
  infoHash: string,
): Promise<void> {
  // Before anything else: builds (and validates) the paths.
  const record = torrentRecordFile(cacheDir, infoHash);
  const data = torrentDataDir(cacheDir, infoHash);
  if (!(await isOurs(cacheDir))) return;
  await rm(record, RM_OPTIONS);
  await rm(data, RM_OPTIONS);
}
