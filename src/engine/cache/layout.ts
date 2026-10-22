import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CACHE_CONTENT_DIRS,
  CACHE_MARKER,
  type CacheContentDir,
} from "../../shared/video-folder";
import { isInfoHash } from "../lib/info-hash";

// The video folder ("cache"), as the main process sets it up
// (src/main/settings/cache-dir.ts; the shared names are in
// src/shared/video-folder.ts):
//
//   <cacheDir>/
//     .streamy-cache                 marker: "this folder is Streamy's"
//     torrents/<infoHash>/…          downloaded data (WebTorrent's `path`)
//     torrents/<infoHash>.streamy.json   fast-resume record (./record.ts)
//     playback/<sessionId>/…         HLS output, deleted when a session ends
//     subtitles/…                    converted subtitle files
//
// Safety rules, so Streamy never deletes the user's own files:
// - Nothing is deleted unless the marker is there.
// - Only the three folders below are ever deleted from; nothing else in
//   <cacheDir> is touched.
// - Paths are built from validated info hashes only (no "../" tricks).
// - Links are never followed, when measuring or deleting.

export { CACHE_CONTENT_DIRS, CACHE_MARKER };

export const TORRENTS_DIR: CacheContentDir = "torrents";
export const PLAYBACK_DIR: CacheContentDir = "playback";
export const SUBTITLES_DIR: CacheContentDir = "subtitles";

/** Ends a torrent's fast-resume record file name. */
export const RECORD_SUFFIX = ".streamy.json";

export function assertInfoHash(value: unknown): asserts value is string {
  if (!isInfoHash(value)) {
    throw new TypeError(
      `Not an info hash (40 lowercase hex characters): ${JSON.stringify(value)}`,
    );
  }
}

/** Where WebTorrent keeps a torrent's files (its `path` option). */
export function torrentDataDir(cacheDir: string, infoHash: string): string {
  assertInfoHash(infoHash);
  return join(cacheDir, TORRENTS_DIR, infoHash);
}

export function torrentRecordFile(cacheDir: string, infoHash: string): string {
  assertInfoHash(infoHash);
  return join(cacheDir, TORRENTS_DIR, `${infoHash}${RECORD_SUFFIX}`);
}

/** A folder Streamy won't delete from. The message is meant for the user. */
export class CacheDirError extends Error {
  override name = "CacheDirError";
}

/**
 * - "ok": exists and has the marker.
 * - "missing": not there (e.g. an external drive was unplugged).
 * - "unmarked": exists but isn't marked as Streamy's: delete nothing.
 */
export type CacheDirState = "ok" | "missing" | "unmarked";

export async function cacheDirState(cacheDir: string): Promise<CacheDirState> {
  try {
    // stat, not lstat: the folder itself may be a link the user made on
    // purpose (e.g. to another drive). Nothing inside it is followed.
    if (!(await stat(cacheDir)).isDirectory()) return "unmarked";
  } catch (error) {
    if (isGone(error)) return "missing";
    throw error;
  }
  try {
    await lstat(join(cacheDir, CACHE_MARKER));
    return "ok";
  } catch (error) {
    if (isGone(error)) return "unmarked";
    throw error;
  }
}

/** The file or folder isn't there (or vanished while we looked). */
export function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
